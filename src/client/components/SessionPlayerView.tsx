import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { api, type ApiError, type SessionDetailResponse } from '../api';
import { CheckpointSaveQueue } from '../checkpointQueue';
import type {
  MarkingResult,
  QuestionItem,
  SessionCheckpoint,
  SessionRecord,
  StudentQuestionView,
} from '../../shared/contracts';
import { useI18n } from '../i18n';
import { QuestionWorkspace } from './QuestionWorkspace';
import { createSessionClock, useClockValue } from '../sessionClock';
import { AdminInspectorDrawer } from './session/AdminInspectorDrawer';
import { SectionBreakView } from './session/SectionBreakView';
import { CheckpointConflictBanner, DraftRecoveryBanner } from './session/DraftRecoveryBanner';
import { clearLocalDraft, getDraftStorageKey, readLocalDraft, writeLocalDraft, type LocalDraftRecord } from './session/localDraft';
import { SessionHeaderBar, type SaveStatus } from './session/SessionHeaderBar';
import { SessionNavigatorDrawer } from './session/SessionNavigatorDrawer';
import { SubmitConfirmDialog } from './session/SubmitConfirmDialog';
import { hasOpenModal, isTypingTarget, resolveExamShortcut, singleChoiceOptionKeysFor } from './session/examShortcuts';
import { buildPassageCues } from './session/passageCohesion';

// The review screen only renders after submission, so it ships as its own chunk
// (warmed while the exam is idle) instead of weighing down the exam player.
const loadPostSubmissionReview = () => import('./PostSubmissionReview');
const PostSubmissionReview = lazy(() =>
  loadPostSubmissionReview().then((m) => ({ default: m.PostSubmissionReview }))
);

interface SessionPlayerViewProps {
  sessionId: string;
  studentId?: string;
  isAdmin: boolean;
  onNavigate: (path: string) => void;
  onActiveSessionCleared?: () => void;
  /** Opens (and locks onto) a newly created session, e.g. a repair drill launched from review. */
  onLaunchSession?: (sessionId: string) => void;
}

export function SessionPlayerView({
  sessionId,
  studentId = 'default-student',
  isAdmin,
  onNavigate,
  onActiveSessionCleared,
  onLaunchSession,
}: SessionPlayerViewProps) {
  const { t, sectionLabel } = useI18n();

  // Warm the review chunk while the learner works, so submitting shows results without a wait.
  useEffect(() => {
    const warm = () => void loadPostSubmissionReview().catch(() => undefined);
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(warm, { timeout: 8000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(warm, 4000);
    return () => window.clearTimeout(id);
  }, []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [questions, setQuestions] = useState<StudentQuestionView[]>([]);

  // Draft checkpoint state
  const [currentIndex, setCurrentIndex] = useState(0);
  // Ticking time lives outside React state; see sessionClock.ts.
  const [clock] = useState(createSessionClock);
  const [answersByPartId, setAnswersByPartId] = useState<Record<string, string | null>>({});
  const [flaggedQuestionIds, setFlaggedQuestionIds] = useState<string[]>([]);
  const [eliminatedByPartId, setEliminatedByPartId] = useState<Record<string, string[]>>({});
  const [highlightsByStimulusId, setHighlightsByStimulusId] = useState<Record<string, string[]>>({});
  const [writingDraft, setWritingDraft] = useState<{ planNotes: string; responseText: string }>({
    planNotes: '',
    responseText: '',
  });
  const [writingDraftsByQuestionId, setWritingDraftsByQuestionId] = useState<
    Record<string, { planNotes: string; responseText: string }>
  >({});

  // Concurrency + recoverable unsent draft UI state
  const checkpointRevisionRef = useRef<number>(1);
  const saveQueueRef = useRef<CheckpointSaveQueue<SessionCheckpoint> | null>(null);
  const sessionRef = useRef<SessionRecord | null>(null);
  const submittingRef = useRef(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [conflictState, setConflictState] = useState<{
    currentRevision: number;
    serverCheckpoint: SessionCheckpoint;
  } | null>(null);
  const [recoverableDraft, setRecoverableDraft] = useState<LocalDraftRecord | null>(null);

  // UI toggles
  const [timerHidden, setTimerHidden] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [activeGapIndex, setActiveGapIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [startingNextSection, setStartingNextSection] = useState(false);
  const [submitConfirmOpen, setSubmitConfirmOpen] = useState(false);
  const autoSubmittedRef = useRef(false);
  const onActiveSessionClearedRef = useRef(onActiveSessionCleared);
  useEffect(() => {
    onActiveSessionClearedRef.current = onActiveSessionCleared;
  }, [onActiveSessionCleared]);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  useEffect(() => {
    submittingRef.current = submitting;
  }, [submitting]);
  // Bumped to retry a failed auto-submit at 00:00.
  const [autoSubmitRetry, setAutoSubmitRetry] = useState(0);

  // Submission Review
  const [reviewResults, setReviewResults] = useState<Record<string, MarkingResult[]> | undefined>();
  const [writingReview, setWritingReview] = useState<SessionDetailResponse['writingReview']>();

  // Admin Calibration Inspector (strictly admin-only)
  const [inspectorMap, setInspectorMap] = useState<Record<string, QuestionItem>>({});
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorBusy, setInspectorBusy] = useState(false);

  const dirtyRef = useRef(false);
  const draftStorageKey = getDraftStorageKey(studentId, sessionId);

  const checkpointRef = useRef<SessionCheckpoint>({
    currentIndex: 0,
    elapsedSec: 0,
    answersByPartId: {},
    flaggedQuestionIds: [],
    eliminatedOptionsByPartId: {},
    passageHighlightsByStimulusId: {},
    writingDraft: { planNotes: '', responseText: '' },
    writingDraftsByQuestionId: {},
  });

  const applyCheckpointToState = useCallback(
    (cp: SessionCheckpoint, maxLen: number) => {
      setCurrentIndex(Math.min(cp.currentIndex || 0, Math.max(0, maxLen - 1)));
      clock.setElapsed(cp.elapsedSec || 0);
      setAnswersByPartId(cp.answersByPartId || {});
      setFlaggedQuestionIds(cp.flaggedQuestionIds || []);
      setEliminatedByPartId(cp.eliminatedOptionsByPartId || {});
      setHighlightsByStimulusId(cp.passageHighlightsByStimulusId || {});
      setWritingDraft(cp.writingDraft || { planNotes: '', responseText: '' });
      setWritingDraftsByQuestionId(cp.writingDraftsByQuestionId || {});
      checkpointRef.current = cp;
    },
    [clock]
  );

  useEffect(() => {
    checkpointRef.current = {
      currentIndex,
      elapsedSec: clock.getElapsedSec(),
      answersByPartId,
      flaggedQuestionIds,
      eliminatedOptionsByPartId: eliminatedByPartId,
      passageHighlightsByStimulusId: highlightsByStimulusId,
      writingDraft,
      writingDraftsByQuestionId,
    };
  }, [
    currentIndex,
    clock,
    answersByPartId,
    flaggedQuestionIds,
    eliminatedByPartId,
    highlightsByStimulusId,
    writingDraft,
    writingDraftsByQuestionId,
  ]);

  const syncClockFromSession = useCallback(
    (s: SessionRecord, serverNowIso?: string) => {
      const parsedServerMs = serverNowIso ? Date.parse(serverNowIso) : NaN;
      if (!Number.isNaN(parsedServerMs)) {
        clock.setServerNow(serverNowIso);
      }
      if (s.status !== 'in_progress') {
        clock.setRunning(false);
        return;
      }
      if (s.sectionState) {
        if (s.sectionState.phase === 'on_break') {
          clock.setRunning(false);
          clock.setDeadline(undefined, undefined);
          return;
        }
        const activeSec = s.sectionState.sections[s.sectionState.currentSectionIndex];
        clock.setDeadline(activeSec?.deadlineAt, activeSec?.timeLimitSec);
        const nowMs = !Number.isNaN(parsedServerMs) ? parsedServerMs : Date.now();
        const startMs = activeSec?.startedAt ? Date.parse(activeSec.startedAt) : NaN;
        const secElapsed = Number.isFinite(startMs) ? Math.max(0, Math.floor((nowMs - startMs) / 1000)) : 0;
        clock.setElapsed(secElapsed);
        clock.setRunning(true);
        return;
      }
      clock.setDeadline(s.deadlineAt, s.timeLimitSec);
      clock.setElapsed(s.checkpoint?.elapsedSec || 0);
      clock.setRunning(true);
    },
    [clock]
  );

  // Load authoritative session from server
  useEffect(() => {
    let active = true;
    saveQueueRef.current?.dispose();
    saveQueueRef.current = null;
    setLoading(true);
    setError('');
    setConflictState(null);
    setRecoverableDraft(null);
    autoSubmittedRef.current = false;
    api
      .getSession(sessionId)
      .then(async (res) => {
        if (!active) return;
        syncClockFromSession(res.session, res.serverNowIso);
        sessionRef.current = res.session;
        setSession(res.session);
        setQuestions(res.questions);
        const initialRev = res.session.checkpointRevision ?? 1;
        checkpointRevisionRef.current = initialRev;

        const queue = new CheckpointSaveQueue<SessionCheckpoint>({
          initialRevision: initialRev,
          getPayload: () => ({ ...checkpointRef.current, elapsedSec: clock.getElapsedSec() }),
          canSave: () =>
            Boolean(
              sessionRef.current &&
                sessionRef.current.status === 'in_progress' &&
                sessionRef.current.sectionState?.phase !== 'on_break' &&
                !submittingRef.current
            ),
          saveFn: (payload, expectedRevision) =>
            api.saveCheckpoint(res.session.sessionId, payload, expectedRevision),
          onBeforeSave: (payload) => {
            writeLocalDraft(draftStorageKey, payload);
            setSaveStatus('saving');
          },
          onSaved: (saveRes, stillDirty) => {
            checkpointRevisionRef.current = queue.getRevision();
            if (saveRes.serverNowIso && !Number.isNaN(Date.parse(saveRes.serverNowIso))) {
              clock.setServerNow(saveRes.serverNowIso);
            }
            setConflictState(null);
            if (!stillDirty) {
              dirtyRef.current = false;
              clearLocalDraft(draftStorageKey);
              setSaveStatus('saved');
            }
          },
          onAlreadySubmitted: async () => {
            clearLocalDraft(draftStorageKey);
            dirtyRef.current = false;
            try {
              const refreshed = await api.getSession(res.session.sessionId);
              if (!active) return;
              sessionRef.current = refreshed.session;
              setSession(refreshed.session);
              setQuestions(refreshed.questions);
              const rev = refreshed.session.checkpointRevision ?? 1;
              checkpointRevisionRef.current = rev;
              queue.clearConflict(rev, true);
              syncClockFromSession(refreshed.session, refreshed.serverNowIso);
              autoSubmittedRef.current = false;
              if (refreshed.session.status === 'submitted') {
                if (refreshed.reviewResults) setReviewResults(refreshed.reviewResults);
                if (refreshed.writingReview) setWritingReview(refreshed.writingReview);
                onActiveSessionClearedRef.current?.();
              } else {
                if (refreshed.session.checkpoint) {
                  applyCheckpointToState(refreshed.session.checkpoint, refreshed.questions.length);
                }
                setSaveStatus('saved');
              }
            } catch {
              if (active) setSaveStatus('failed');
            }
          },
          onConflict: (conflict) => {
            setConflictState({
              currentRevision: conflict.currentRevision,
              serverCheckpoint: conflict.serverCheckpoint,
            });
            setSaveStatus('conflict');
          },
          onError: () => {
            setSaveStatus('failed');
          },
        });
        saveQueueRef.current = queue;

        const cp = res.session.checkpoint;
        if (cp) {
          applyCheckpointToState(cp, res.questions.length);
          syncClockFromSession(res.session, res.serverNowIso);
        }

        if (res.session.status === 'in_progress' && res.session.sectionState?.phase !== 'on_break') {
          const localDraft = readLocalDraft(draftStorageKey);
          if (localDraft) {
            const normCp = (c?: SessionCheckpoint) =>
              JSON.stringify({
                currentIndex: c?.currentIndex ?? 0,
                answersByPartId: c?.answersByPartId || {},
                flaggedQuestionIds: [...(c?.flaggedQuestionIds || [])].sort(),
                eliminatedOptionsByPartId: c?.eliminatedOptionsByPartId || {},
                passageHighlightsByStimulusId: c?.passageHighlightsByStimulusId || {},
                planNotes: c?.writingDraft?.planNotes || '',
                responseText: c?.writingDraft?.responseText || '',
                writingDraftsByQuestionId: c?.writingDraftsByQuestionId || {},
              });
            if (normCp(cp) !== normCp(localDraft.checkpoint)) {
              setRecoverableDraft(localDraft);
              setSaveStatus('unsent');
            } else {
              clearLocalDraft(draftStorageKey);
              setSaveStatus('saved');
            }
          } else {
            setSaveStatus('saved');
          }
        } else {
          clearLocalDraft(draftStorageKey);
          if (res.session.status !== 'in_progress' && !res.session.isSandbox) {
            onActiveSessionClearedRef.current?.();
          }
        }

        if (res.reviewResults) setReviewResults(res.reviewResults);
        if (res.writingReview) setWritingReview(res.writingReview);

        if (res.session.mode === 'admin_calibration' && isAdmin) {
          try {
            const insp = await api.getCalibrationInspector(sessionId);
            // Closed by default: the admin opens the slide-over with the toggle or the I key.
            if (active) setInspectorMap(insp.inspectorByQuestionId);
          } catch {
            // ignore
          }
        }
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : t('session.unableLoad'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      saveQueueRef.current?.dispose();
      saveQueueRef.current = null;
    };
  }, [sessionId, isAdmin, draftStorageKey, applyCheckpointToState, syncClockFromSession, clock]);

  const flushCheckpoint = useCallback(async (overrideExpectedRevision?: number) => {
    const queue = saveQueueRef.current;
    if (!queue) return;
    await queue.flush(overrideExpectedRevision);
  }, []);

  // Run the exam clock while a timed section/session is active, plus a 30s periodic autosave.
  const inProgressActiveSection = Boolean(
    session?.status === 'in_progress' && session.sectionState?.phase !== 'on_break'
  );
  useEffect(() => {
    clock.setRunning(inProgressActiveSection);
    if (!inProgressActiveSection) return;
    const saveTimer = window.setInterval(() => {
      if (!saveQueueRef.current?.hasActiveConflict()) {
        void flushCheckpoint();
      }
    }, 30_000);
    return () => {
      window.clearInterval(saveTimer);
      clock.setRunning(false);
    };
  }, [inProgressActiveSection, clock, flushCheckpoint]);

  // Debounced checkpoint save on state change
  useEffect(() => {
    if (!session || session.status !== 'in_progress' || session.sectionState?.phase === 'on_break' || !dirtyRef.current) return;
    const t = window.setTimeout(() => {
      void flushCheckpoint();
    }, 450);
    return () => window.clearTimeout(t);
  }, [
    session,
    currentIndex,
    answersByPartId,
    flaggedQuestionIds,
    eliminatedByPartId,
    highlightsByStimulusId,
    writingDraft,
    writingDraftsByQuestionId,
    flushCheckpoint,
  ]);

  const sectionState = session?.sectionState;
  const isOnSectionBreak = Boolean(
    session && session.status === 'in_progress' && sectionState?.phase === 'on_break'
  );
  const activeSection = sectionState
    ? sectionState.sections[sectionState.currentSectionIndex] ?? null
    : null;
  const isLastSection =
    !sectionState || sectionState.currentSectionIndex >= sectionState.sections.length - 1;
  const nextSection =
    sectionState && !isLastSection
      ? sectionState.sections[sectionState.currentSectionIndex + 1] ?? null
      : null;
  const sectionStart = activeSection ? activeSection.startIndex : 0;
  const sectionEnd = activeSection ? activeSection.endIndex : questions.length;
  const sectionQuestions = useMemo(
    () => questions.slice(sectionStart, sectionEnd),
    [questions, sectionStart, sectionEnd]
  );

  const currentQuestion = questions[currentIndex];

  const persistDraftPatch = useCallback(
    (patch: Partial<SessionCheckpoint>) => {
      dirtyRef.current = true;
      saveQueueRef.current?.markDirty();
      setSaveStatus('unsent');
      const nextCp: SessionCheckpoint = {
        ...checkpointRef.current,
        ...patch,
        elapsedSec: clock.getElapsedSec(),
      };
      checkpointRef.current = nextCp;
      writeLocalDraft(draftStorageKey, nextCp);
    },
    [draftStorageKey, clock]
  );

  const handleSelectAnswer = useCallback(
    (partId: string, key: string | null) => {
      setAnswersByPartId((prev) => {
        const next = { ...prev, [partId]: key };
        persistDraftPatch({ answersByPartId: next });
        return next;
      });
    },
    [persistDraftPatch]
  );

  const handleToggleEliminate = useCallback(
    (partId: string, key: string) => {
      setEliminatedByPartId((prev) => {
        const list = prev[partId] || [];
        const nextList = list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
        const next = { ...prev, [partId]: nextList };
        persistDraftPatch({ eliminatedOptionsByPartId: next });
        return next;
      });
    },
    [persistDraftPatch]
  );

  const handleToggleFlag = useCallback(
    (questionId: string) => {
      setFlaggedQuestionIds((prev) => {
        const next = prev.includes(questionId)
          ? prev.filter((id) => id !== questionId)
          : [...prev, questionId];
        persistDraftPatch({ flaggedQuestionIds: next });
        return next;
      });
    },
    [persistDraftPatch]
  );

  const handleGoIndex = useCallback(
    (nextIdx: number) => {
      const minIdx = activeSection ? activeSection.startIndex : 0;
      const maxIdx = activeSection
        ? Math.max(minIdx, activeSection.endIndex - 1)
        : Math.max(0, questions.length - 1);
      const bounded = Math.max(minIdx, Math.min(maxIdx, nextIdx));
      persistDraftPatch({ currentIndex: bounded });
      setCurrentIndex(bounded);
      setActiveGapIndex(0);
    },
    [activeSection, questions.length, persistDraftPatch]
  );

  const isLockedStudentSession = Boolean(
    session &&
      session.status === 'in_progress' &&
      session.mode !== 'admin_calibration' &&
      !session.isSandbox
  );

  // Boolean subscription: the root re-renders once when time runs out, not on every tick.
  const clockSaysTimeUp = useClockValue(clock, (c) => {
    const remaining = c.getRemainingSec();
    return remaining !== null && remaining <= 0;
  });
  const isTimeUp = isLockedStudentSession && !isOnSectionBreak && clockSaysTimeUp;
  const isAdminRun = Boolean(session && session.mode === 'admin_calibration' && isAdmin);

  // Exam Room keyboard shortcuts (A–E / 1–5, ←/→, F, N, ?). Rules live in examShortcuts.ts.
  const singleChoiceOptionKeys = useMemo(
    () => (currentQuestion ? singleChoiceOptionKeysFor(currentQuestion) : null),
    [currentQuestion]
  );
  useEffect(() => {
    if (!session || session.status !== 'in_progress' || !currentQuestion) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      const action = resolveExamShortcut(e, {
        blocked:
          isOnSectionBreak || isTimeUp || submitting || submitConfirmOpen || hasOpenModal(document),
        isWritingQuestion: currentQuestion.formatType === 'WRIT_TYPED_TASK',
        singleChoiceOptionKeys,
        canToggleInspector: isAdminRun,
        inspectorOpen: isAdminRun && inspectorOpen,
      });
      if (!action) return;
      // Holding a key may repeat navigation, never toggles or answers.
      if (e.repeat && action.type !== 'prev' && action.type !== 'next') {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      switch (action.type) {
        case 'select': {
          const part = currentQuestion.parts[0];
          const currentPick = answersByPartId[part.partId];
          handleSelectAnswer(part.partId, currentPick === action.optionKey ? null : action.optionKey);
          break;
        }
        case 'prev':
          handleGoIndex(currentIndex - 1);
          break;
        case 'next':
          handleGoIndex(currentIndex + 1);
          break;
        case 'flag':
          handleToggleFlag(currentQuestion.questionId);
          break;
        case 'toggleNav':
          setNavOpen((open) => !open);
          break;
        case 'toggleHelp':
          setShortcutsOpen((open) => !open);
          break;
        case 'toggleInspector':
          setInspectorOpen((open) => !open);
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    session,
    currentQuestion,
    currentIndex,
    answersByPartId,
    singleChoiceOptionKeys,
    isTimeUp,
    submitting,
    submitConfirmOpen,
    handleGoIndex,
    handleToggleFlag,
    handleSelectAnswer,
    isAdminRun,
    inspectorOpen,
    isOnSectionBreak,
  ]);

  const passageCues = useMemo(() => buildPassageCues(questions), [questions]);

  // Re-sync clock anchor and check remote submit/expiry/section-transition after tab wake / OS sleep
  useEffect(() => {
    if (!session || session.status !== 'in_progress') return;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      api
        .getSession(session.sessionId)
        .then((refreshed) => {
          syncClockFromSession(refreshed.session, refreshed.serverNowIso);
          if (refreshed.session.status === 'submitted') {
            clearLocalDraft(draftStorageKey);
            setSession(refreshed.session);
            setQuestions(refreshed.questions);
            if (refreshed.reviewResults) setReviewResults(refreshed.reviewResults);
            if (refreshed.writingReview) setWritingReview(refreshed.writingReview);
            onActiveSessionClearedRef.current?.();
            return;
          }
          const remotePhase = refreshed.session.sectionState?.phase;
          const remoteIdx = refreshed.session.sectionState?.currentSectionIndex;
          const localPhase = sessionRef.current?.sectionState?.phase;
          const localIdx = sessionRef.current?.sectionState?.currentSectionIndex;
          if (remotePhase !== localPhase || remoteIdx !== localIdx) {
            clearLocalDraft(draftStorageKey);
            dirtyRef.current = false;
            const rev = refreshed.session.checkpointRevision ?? 1;
            checkpointRevisionRef.current = rev;
            saveQueueRef.current?.clearConflict(rev, true);
            sessionRef.current = refreshed.session;
            setSession(refreshed.session);
            setQuestions(refreshed.questions);
            if (refreshed.session.checkpoint) {
              applyCheckpointToState(refreshed.session.checkpoint, refreshed.questions.length);
              syncClockFromSession(refreshed.session, refreshed.serverNowIso);
            }
            autoSubmittedRef.current = false;
            setSaveStatus('saved');
          }
        })
        .catch(() => undefined);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [session, draftStorageKey, syncClockFromSession, applyCheckpointToState]);

  // Warn on tab close/refresh when unsent draft exists or while locked in an active timed test section
  useEffect(() => {
    if ((!isLockedStudentSession || isOnSectionBreak) && saveStatus !== 'unsent' && saveStatus !== 'failed') return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isLockedStudentSession, isOnSectionBreak, saveStatus]);

  useEffect(() => {
    autoSubmittedRef.current = false;
  }, [sectionState?.currentSectionIndex, sectionState?.phase]);

  const handleSubmit = useCallback(async () => {
    if (!session || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitConfirmOpen(false);
    setSubmitting(true);
    setError('');
    try {
      const expectedRev = saveQueueRef.current?.getRevision() ?? checkpointRevisionRef.current;
      const res = await api.submitSession(
        session.sessionId,
        {
          ...checkpointRef.current,
          elapsedSec: clock.getElapsedSec(),
        },
        false,
        session.isSandbox ? undefined : expectedRev
      );
      clearLocalDraft(draftStorageKey);
      setSession((prev) =>
        prev
          ? {
              ...prev,
              status: 'submitted',
              correctSlots: res.correctSlots,
              totalSlots: res.totalSlots,
              completedAt: res.completedAt || new Date().toISOString(),
            }
          : prev
      );
      setReviewResults(res.reviewResults);
      setWritingReview(res.writingReview);
      onActiveSessionClearedRef.current?.();
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.status === 409 && typeof apiErr.currentRevision === 'number' && apiErr.serverCheckpoint) {
        setConflictState({
          currentRevision: apiErr.currentRevision,
          serverCheckpoint: apiErr.serverCheckpoint,
        });
        setSaveStatus('conflict');
        setError('');
      } else {
        setError(err instanceof Error ? err.message : t('session.unableSubmit'));
      }
      if (isTimeUp) {
        window.setTimeout(() => {
          autoSubmittedRef.current = false;
          setAutoSubmitRetry((n) => n + 1);
        }, 2500);
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [session, draftStorageKey, isTimeUp, clock, t]);

  const handleCompleteSection = useCallback(async () => {
    if (!session || !session.sectionState || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitConfirmOpen(false);
    setSubmitting(true);
    setError('');
    try {
      const expectedRev = saveQueueRef.current?.getRevision() ?? checkpointRevisionRef.current;
      const res = await api.completeSessionSection(
        session.sessionId,
        {
          ...checkpointRef.current,
          elapsedSec: clock.getElapsedSec(),
        },
        expectedRev
      );
      clearLocalDraft(draftStorageKey);
      dirtyRef.current = false;
      const nextRev = res.session.checkpointRevision ?? expectedRev + 1;
      checkpointRevisionRef.current = nextRev;
      saveQueueRef.current?.clearConflict(nextRev, true);
      sessionRef.current = res.session;
      setSession(res.session);
      setNavOpen(false);
      if (res.finishedExam) {
        clock.setRunning(false);
        setReviewResults(res.reviewResults);
        setWritingReview(res.writingReview);
        onActiveSessionClearedRef.current?.();
      } else {
        syncClockFromSession(res.session, res.serverNowIso);
        if (res.session.checkpoint) {
          applyCheckpointToState(res.session.checkpoint, questions.length);
          syncClockFromSession(res.session, res.serverNowIso);
        }
        setSaveStatus('saved');
        autoSubmittedRef.current = false;
      }
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.status === 409 && typeof apiErr.currentRevision === 'number' && apiErr.serverCheckpoint) {
        setConflictState({
          currentRevision: apiErr.currentRevision,
          serverCheckpoint: apiErr.serverCheckpoint,
        });
        setSaveStatus('conflict');
        setError('');
      } else {
        setError(err instanceof Error ? err.message : t('session.unableSubmit'));
      }
      if (isTimeUp) {
        window.setTimeout(() => {
          autoSubmittedRef.current = false;
          setAutoSubmitRetry((n) => n + 1);
        }, 2500);
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [session, draftStorageKey, isTimeUp, clock, syncClockFromSession, applyCheckpointToState, questions.length, t]);

  const handleStartNextSection = useCallback(async () => {
    if (!session || !session.sectionState || startingNextSection) return;
    setStartingNextSection(true);
    setError('');
    try {
      const expectedRev = saveQueueRef.current?.getRevision() ?? checkpointRevisionRef.current;
      const res = await api.startSessionSection(session.sessionId, expectedRev);
      const nextRev = res.session.checkpointRevision ?? expectedRev + 1;
      checkpointRevisionRef.current = nextRev;
      saveQueueRef.current?.clearConflict(nextRev, true);
      sessionRef.current = res.session;
      setSession(res.session);
      autoSubmittedRef.current = false;
      const nextActive =
        res.session.sectionState?.sections[res.session.sectionState.currentSectionIndex];
      if (nextActive) {
        setCurrentIndex(nextActive.startIndex);
        setActiveGapIndex(0);
      }
      if (res.session.checkpoint) {
        checkpointRef.current = res.session.checkpoint;
      }
      syncClockFromSession(res.session, res.serverNowIso);
      setSaveStatus('saved');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('session.unableLoad'));
    } finally {
      setStartingNextSection(false);
    }
  }, [session, startingNextSection, syncClockFromSession, t]);

  // Auto-submit / auto-advance when timed locked student session hits 00:00 on server clock
  useEffect(() => {
    if (!isTimeUp || isOnSectionBreak || autoSubmittedRef.current || submitting) return;
    autoSubmittedRef.current = true;
    if (session?.sectionState) {
      void handleCompleteSection();
    } else {
      void handleSubmit();
    }
  }, [
    isTimeUp,
    isOnSectionBreak,
    submitting,
    session?.sectionState,
    handleCompleteSection,
    handleSubmit,
    autoSubmitRetry,
  ]);

  const handleInspectorQcChange = useCallback(async (questionId: string, nextStatus: QuestionItem['qcStatus']) => {
    setInspectorBusy(true);
    setError('');
    try {
      await api.updateQuestionStatus(questionId, nextStatus);
      setInspectorMap((prev) => ({
        ...prev,
        [questionId]: { ...prev[questionId], qcStatus: nextStatus },
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('session.unableQc'));
    } finally {
      setInspectorBusy(false);
    }
  }, [t]);

  const toggleTimerHidden = useCallback(() => setTimerHidden((v) => !v), []);
  const closeInspector = useCallback(() => setInspectorOpen(false), []);
  const closeSubmitConfirm = useCallback(() => {
    if (!submittingRef.current) setSubmitConfirmOpen(false);
  }, []);

  const answeredSlotsCount = useMemo(() => {
    let cnt = 0;
    for (const q of sectionQuestions) {
      if (q.formatType === 'WRIT_TYPED_TASK') {
        const resp =
          writingDraftsByQuestionId[q.questionId]?.responseText ?? writingDraft.responseText;
        if (resp.trim().length > 0) cnt++;
      } else {
        for (const p of q.parts) {
          if (answersByPartId[p.partId]) cnt++;
        }
      }
    }
    return cnt;
  }, [sectionQuestions, answersByPartId, writingDraft.responseText, writingDraftsByQuestionId]);

  const totalSlotsCount = useMemo(
    () => sectionQuestions.reduce((sum, q) => sum + Math.max(1, q.parts.length), 0),
    [sectionQuestions]
  );

  const sectionFlaggedCount = useMemo(() => {
    if (!activeSection) return flaggedQuestionIds.length;
    const ids = new Set(sectionQuestions.map((q) => q.questionId));
    return flaggedQuestionIds.filter((id) => ids.has(id)).length;
  }, [activeSection, sectionQuestions, flaggedQuestionIds]);

  const navigatorWritingResponse = useMemo(() => {
    const writQ = sectionQuestions.find((q) => q.formatType === 'WRIT_TYPED_TASK');
    if (!writQ) return writingDraft.responseText;
    return writingDraftsByQuestionId[writQ.questionId]?.responseText ?? writingDraft.responseText;
  }, [sectionQuestions, writingDraftsByQuestionId, writingDraft.responseText]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-[var(--text-secondary)]">
        {t('session.loading')}
      </div>
    );
  }

  if (error && !session) {
    return (
      <div className="max-w-xl mx-auto px-6 py-16 space-y-4">
        <p role="alert" className="p-4 rounded-[var(--radius-md)] bg-[var(--status-error-bg)] text-[var(--status-error)] text-sm">
          {error}
        </p>
        <button
          type="button"
          onClick={() => onNavigate('/')}
          className="px-4 py-2 rounded-[var(--radius-sm)] border border-[var(--border-strong)] text-sm font-medium cursor-pointer"
        >
          {t('auth.backToStudio')}
        </button>
      </div>
    );
  }

  if (!session || !currentQuestion) return null;

  if (session.status === 'submitted' && reviewResults) {
    return (
      <Suspense
        fallback={
          <div
            role="status"
            aria-live="polite"
            className="min-h-screen flex items-center justify-center text-sm text-[var(--text-secondary)]"
          >
            {t('session.loading')}
          </div>
        }
      >
        <PostSubmissionReview
          sessionId={session.sessionId}
          sessionTitle={session.title}
          sessionMode={session.mode}
          onStartRepairDrill={onLaunchSession}
          correctSlots={session.correctSlots}
          totalSlots={session.totalSlots}
          elapsedSec={session.checkpoint?.elapsedSec ?? clock.getElapsedSec()}
          questions={questions}
          reviewResults={reviewResults}
          writingReview={writingReview}
          onDoneHome={() => onNavigate('/')}
          onViewProgress={() => onNavigate('/progress')}
          onViewBenchmarks={() => onNavigate('/benchmarks')}
        />
      </Suspense>
    );
  }

  const displayTitle =
    session.mode === 'repair_drill'
      ? t('repair.sessionTitle', { count: session.plannedQuestionIds.length })
      : session.title || session.mode.replace(/_/g, ' ');

  if (isOnSectionBreak && sectionState) {
    return (
      <SectionBreakView
        sessionTitle={displayTitle}
        sectionState={sectionState}
        questions={questions}
        answersByPartId={answersByPartId}
        writingDraftsByQuestionId={writingDraftsByQuestionId}
        writingDraft={writingDraft}
        starting={startingNextSection}
        error={error}
        onStartNext={() => void handleStartNextSection()}
      />
    );
  }

  const isFlagged = flaggedQuestionIds.includes(currentQuestion.questionId);
  const currentStimId = currentQuestion.stimulus?.stimulusId || currentQuestion.questionId;
  const activeInspectorQ = inspectorMap[currentQuestion.questionId];
  const localIndex = Math.max(0, currentIndex - sectionStart);
  const passageCue = passageCues.get(currentQuestion.questionId);
  const passageLabel = passageCue
    ? t('session.passageCue', {
        passage: passageCue.passageNumber,
        position: passageCue.position,
        total: passageCue.total,
      })
    : undefined;
  const finishBtnLabel = submitting
    ? t('session.submitting')
    : sectionState && activeSection && !isLastSection
      ? t('session.finishSectionBtn', { section: sectionLabel(activeSection.section) })
      : t('session.finishTest');

  return (
    <div className="min-h-screen lg:h-screen lg:overflow-hidden flex flex-col bg-[#FAF8F5] text-[#113C36]">
      <SessionHeaderBar
        title={displayTitle}
        isLockedStudentSession={isLockedStudentSession}
        isAdminRun={isAdminRun}
        isSandbox={session.isSandbox}
        sectionBadge={
          sectionState && activeSection
            ? {
                current: sectionState.currentSectionIndex + 1,
                total: sectionState.sections.length,
                label: sectionLabel(activeSection.section),
              }
            : null
        }
        saveStatus={saveStatus}
        clock={clock}
        timerHidden={timerHidden}
        questionNumber={localIndex + 1}
        questionCount={sectionQuestions.length}
        isFlagged={isFlagged}
        navOpen={navOpen}
        inspectorOpen={inspectorOpen}
        submitting={submitting}
        finishBtnLabel={finishBtnLabel}
        onExit={async () => {
          await flushCheckpoint();
          onNavigate(session.mode === 'admin_calibration' ? '/admin' : '/');
        }}
        onSaveNow={() => flushCheckpoint()}
        onToggleTimerHidden={toggleTimerHidden}
        onToggleFlag={() => handleToggleFlag(currentQuestion.questionId)}
        onToggleNav={() => setNavOpen((v) => !v)}
        onToggleInspector={() => setInspectorOpen((v) => !v)}
        onFinish={() => setSubmitConfirmOpen(true)}
        shortcutsOpen={shortcutsOpen}
        onShortcutsOpenChange={setShortcutsOpen}
        navigator={
          <SessionNavigatorDrawer
            open={navOpen}
            sectionStart={sectionStart}
            currentIndex={currentIndex}
            questions={sectionQuestions}
            answersByPartId={answersByPartId}
            flaggedQuestionIds={flaggedQuestionIds}
            writingResponse={navigatorWritingResponse}
            answeredSlots={answeredSlotsCount}
            totalSlots={totalSlotsCount}
            onGoIndex={handleGoIndex}
          />
        }
      />

      {/* Recoverable Unsent Local Draft Banner */}
      {recoverableDraft && !conflictState && (
        <DraftRecoveryBanner
          savedAtMs={recoverableDraft.savedAtMs}
          onRestore={() => {
            applyCheckpointToState(recoverableDraft.checkpoint, questions.length);
            setRecoverableDraft(null);
            dirtyRef.current = true;
            saveQueueRef.current?.markDirty();
            void flushCheckpoint();
          }}
          onDiscard={() => {
            clearLocalDraft(draftStorageKey);
            setRecoverableDraft(null);
            setSaveStatus('saved');
          }}
        />
      )}

      {/* Optimistic Concurrency Conflict Resolution Banner (409) */}
      {conflictState && (
        <CheckpointConflictBanner
          currentRevision={conflictState.currentRevision}
          onLoadServer={() => {
            checkpointRevisionRef.current = conflictState.currentRevision;
            saveQueueRef.current?.clearConflict(conflictState.currentRevision, true);
            applyCheckpointToState(conflictState.serverCheckpoint, questions.length);
            clearLocalDraft(draftStorageKey);
            dirtyRef.current = false;
            setConflictState(null);
            setSaveStatus('saved');
          }}
          onKeepDevice={() => {
            checkpointRevisionRef.current = conflictState.currentRevision;
            saveQueueRef.current?.setRevision(conflictState.currentRevision);
            void flushCheckpoint(conflictState.currentRevision);
          }}
        />
      )}


      {isTimeUp && (
        <div
          role="status"
          className="border-b border-[#B42318]/25 bg-[#FDECEB] px-6 py-2.5 text-center text-xs font-medium text-[#B42318]"
        >
          {t('session.timeEnded')}
        </div>
      )}

      {error && (
        <div role="alert" className="max-w-[1440px] mx-auto w-full px-6 pt-4">
          <div className="p-3 rounded-[10px] bg-[#FDECEB] text-[#B42318] text-xs font-medium">
            {error}
          </div>
        </div>
      )}

      {isAdminRun && (
        <AdminInspectorDrawer
          open={inspectorOpen}
          onClose={closeInspector}
          question={activeInspectorQ}
          activePartIndex={activeGapIndex}
          onSelectPart={setActiveGapIndex}
          onSetQcStatus={handleInspectorQcChange}
          statusBusy={inspectorBusy}
        />
      )}

      {/* Open-Book Split Spread QuestionWorkspace */}
      <QuestionWorkspace
        mode="exam"
        frozen={isTimeUp || submitting}
        question={currentQuestion}
        passageLabel={passageLabel}
        writingClock={clock}
        answersByPartId={answersByPartId}
        eliminatedByPartId={eliminatedByPartId}
        highlights={highlightsByStimulusId[currentStimId] || []}
        activeGapIndex={activeGapIndex}
        onSelectGapIndex={setActiveGapIndex}
        onSelectAnswer={handleSelectAnswer}
        onToggleEliminate={handleToggleEliminate}
        onAddHighlight={(text) => {
          setHighlightsByStimulusId((prev) => {
            const next = {
              ...prev,
              [currentStimId]: Array.from(new Set([...(prev[currentStimId] || []), text])),
            };
            persistDraftPatch({ passageHighlightsByStimulusId: next });
            return next;
          });
        }}
        onClearHighlights={() => {
          setHighlightsByStimulusId((prev) => {
            const next = { ...prev, [currentStimId]: [] };
            persistDraftPatch({ passageHighlightsByStimulusId: next });
            return next;
          });
        }}
        writingDraft={
          writingDraftsByQuestionId[currentQuestion.questionId] ?? writingDraft
        }
        onChangeWritingPlan={(val) => {
          const qid = currentQuestion.questionId;
          setWritingDraftsByQuestionId((prev) => {
            const cur = prev[qid] ?? writingDraft;
            const updatedEntry = { ...cur, planNotes: val };
            const nextMap = { ...prev, [qid]: updatedEntry };
            setWritingDraft(updatedEntry);
            persistDraftPatch({ writingDraft: updatedEntry, writingDraftsByQuestionId: nextMap });
            return nextMap;
          });
        }}
        onChangeWritingResponse={(val) => {
          const qid = currentQuestion.questionId;
          setWritingDraftsByQuestionId((prev) => {
            const cur = prev[qid] ?? writingDraft;
            const updatedEntry = { ...cur, responseText: val };
            const nextMap = { ...prev, [qid]: updatedEntry };
            setWritingDraft(updatedEntry);
            persistDraftPatch({ writingDraft: updatedEntry, writingDraftsByQuestionId: nextMap });
            return nextMap;
          });
        }}
        footerNav={
          <div className="pt-4 border-t border-[#E5DFD5] flex items-center justify-between gap-3">
            <button
              type="button"
              disabled={currentIndex <= sectionStart}
              onClick={() => handleGoIndex(currentIndex - 1)}
              className="px-4 py-2 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#F3EFE8] text-sm font-sans-display font-medium text-[#113C36] inline-flex items-center gap-1.5 disabled:opacity-40 cursor-pointer transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>{t('session.previous')}</span>
            </button>

            <div className="flex items-center gap-2">
              {currentIndex < sectionEnd - 1 ? (
                <button
                  type="button"
                  onClick={() => handleGoIndex(currentIndex + 1)}
                  className="px-5 py-2 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-sm font-sans-display font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                >
                  <span>{t('session.next')}</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              ) : (
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => setSubmitConfirmOpen(true)}
                  className="px-5 py-2 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-sm font-sans-display font-semibold cursor-pointer disabled:opacity-60 transition-colors"
                >
                  {finishBtnLabel}
                </button>
              )}
            </div>
          </div>
        }
      />

      <SubmitConfirmDialog
        open={submitConfirmOpen}
        submitting={submitting}
        answeredSlots={answeredSlotsCount}
        totalSlots={totalSlotsCount}
        flaggedCount={sectionFlaggedCount}
        titleOverride={
          sectionState && activeSection && !isLastSection && nextSection
            ? t('session.finishSectionModalTitle', { section: sectionLabel(activeSection.section) })
            : undefined
        }
        descriptionOverride={
          sectionState && activeSection && !isLastSection && nextSection
            ? t('session.finishSectionModalNote', {
                section: sectionLabel(activeSection.section),
                nextSection: sectionLabel(nextSection.section),
              })
            : undefined
        }
        confirmLabelOverride={
          sectionState && activeSection && !isLastSection
            ? t('session.confirmFinishSection', { section: sectionLabel(activeSection.section) })
            : undefined
        }
        onCancel={closeSubmitConfirm}
        onConfirm={sectionState ? handleCompleteSection : handleSubmit}
      />
    </div>
  );
}
