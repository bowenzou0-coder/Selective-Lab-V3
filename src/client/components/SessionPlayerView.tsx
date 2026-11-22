import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  CloudCheck,
  CloudOff,
  Flag,
  Grid,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import { api, type SessionDetailResponse } from '../api';
import { CheckpointSaveQueue } from '../checkpointQueue';
import type {
  MarkingResult,
  QuestionItem,
  SessionCheckpoint,
  SessionRecord,
  StudentQuestionView,
} from '../../shared/contracts';
import { LanguageToggle, useI18n } from '../i18n';
import { PostSubmissionReview } from './PostSubmissionReview';
import { QuestionWorkspace } from './QuestionWorkspace';
import { createSessionClock, useClockValue } from '../sessionClock';
import { AdminInspectorDrawer } from './session/AdminInspectorDrawer';
import { ExamTimer } from './session/ExamTimer';
import { QuestionNavigator } from './session/QuestionNavigator';
import { SubmitConfirmDialog } from './session/SubmitConfirmDialog';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'unsent' | 'failed' | 'conflict';

interface LocalDraftRecord {
  checkpoint: SessionCheckpoint;
  savedAtMs: number;
}

function getDraftStorageKey(studentId: string, sessionId: string): string {
  return `selective_lab_draft:${studentId}:${sessionId}`;
}

function readLocalDraft(key: string): LocalDraftRecord | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LocalDraftRecord;
    if (parsed && parsed.checkpoint && typeof parsed.savedAtMs === 'number') {
      return parsed;
    }
  } catch {
    // ignore storage errors
  }
  return null;
}

function writeLocalDraft(key: string, cp: SessionCheckpoint): void {
  try {
    const record: LocalDraftRecord = { checkpoint: cp, savedAtMs: Date.now() };
    window.localStorage.setItem(key, JSON.stringify(record));
  } catch {
    // ignore storage errors
  }
}

function clearLocalDraft(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore storage errors
  }
}

interface SessionPlayerViewProps {
  sessionId: string;
  studentId?: string;
  isAdmin: boolean;
  onNavigate: (path: string) => void;
  onActiveSessionCleared?: () => void;
}

export function SessionPlayerView({
  sessionId,
  studentId = 'default-student',
  isAdmin,
  onNavigate,
  onActiveSessionCleared,
}: SessionPlayerViewProps) {
  const { t, isZh, skillName } = useI18n();
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
  const [activeGapIndex, setActiveGapIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
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
    };
  }, [
    currentIndex,
    clock,
    answersByPartId,
    flaggedQuestionIds,
    eliminatedByPartId,
    highlightsByStimulusId,
    writingDraft,
  ]);

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
        const parsedServerMs = res.serverNowIso ? Date.parse(res.serverNowIso) : Date.now();
        clock.setServerNow(Number.isNaN(parsedServerMs) ? undefined : res.serverNowIso);
        clock.setDeadline(res.session.deadlineAt, res.session.timeLimitSec);
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
              if (refreshed.reviewResults) setReviewResults(refreshed.reviewResults);
              if (refreshed.writingReview) setWritingReview(refreshed.writingReview);
              onActiveSessionClearedRef.current?.();
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
        }

        if (res.session.status === 'in_progress') {
          const localDraft = readLocalDraft(draftStorageKey);
          if (localDraft) {
            const serverAnswers = JSON.stringify(cp?.answersByPartId || {});
            const localAnswers = JSON.stringify(localDraft.checkpoint.answersByPartId || {});
            const serverWriting = cp?.writingDraft?.responseText || '';
            const localWriting = localDraft.checkpoint.writingDraft?.responseText || '';
            if (serverAnswers !== localAnswers || serverWriting !== localWriting) {
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
          if (!res.session.isSandbox) {
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
  }, [sessionId, isAdmin, draftStorageKey, applyCheckpointToState, clock]);

  const flushCheckpoint = useCallback(async (overrideExpectedRevision?: number) => {
    const queue = saveQueueRef.current;
    if (!queue) return;
    await queue.flush(overrideExpectedRevision);
  }, []);

  // Run the exam clock while in progress, plus a 30s periodic autosave.
  const inProgress = session?.status === 'in_progress';
  useEffect(() => {
    clock.setRunning(Boolean(inProgress));
    if (!inProgress) return;
    const saveTimer = window.setInterval(() => {
      if (!saveQueueRef.current?.hasActiveConflict()) {
        void flushCheckpoint();
      }
    }, 30_000);
    return () => {
      window.clearInterval(saveTimer);
      clock.setRunning(false);
    };
  }, [inProgress, clock, flushCheckpoint]);

  // Debounced checkpoint save on state change
  useEffect(() => {
    if (!session || session.status !== 'in_progress' || !dirtyRef.current) return;
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
    flushCheckpoint,
  ]);

  const currentQuestion = questions[currentIndex];

  const markLocalDirty = useCallback(() => {
    dirtyRef.current = true;
    saveQueueRef.current?.markDirty();
    setSaveStatus('unsent');
    writeLocalDraft(draftStorageKey, { ...checkpointRef.current, elapsedSec: clock.getElapsedSec() });
  }, [draftStorageKey, clock]);

  const handleSelectAnswer = useCallback(
    (partId: string, key: string | null) => {
      dirtyRef.current = true;
      saveQueueRef.current?.markDirty();
      setSaveStatus('unsent');
      setAnswersByPartId((prev) => {
        const next = { ...prev, [partId]: key };
        writeLocalDraft(draftStorageKey, { ...checkpointRef.current, answersByPartId: next });
        return next;
      });
    },
    [draftStorageKey]
  );

  const handleToggleEliminate = useCallback(
    (partId: string, key: string) => {
      markLocalDirty();
      setEliminatedByPartId((prev) => {
        const list = prev[partId] || [];
        const next = list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
        return { ...prev, [partId]: next };
      });
    },
    [markLocalDirty]
  );

  const handleToggleFlag = useCallback(
    (questionId: string) => {
      markLocalDirty();
      setFlaggedQuestionIds((prev) =>
        prev.includes(questionId) ? prev.filter((id) => id !== questionId) : [...prev, questionId]
      );
    },
    [markLocalDirty]
  );

  const handleGoIndex = useCallback(
    (nextIdx: number) => {
      const bounded = Math.max(0, Math.min(questions.length - 1, nextIdx));
      markLocalDirty();
      setCurrentIndex(bounded);
      setActiveGapIndex(0);
    },
    [questions.length, markLocalDirty]
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
  const isTimeUp = isLockedStudentSession && clockSaysTimeUp;
  const isAdminRun = Boolean(session && session.mode === 'admin_calibration' && isAdmin);

  // Keyboard shortcuts (1-8 / A-H, N / P, F) — blocked once time is up, submitting, or confirm dialog open
  useEffect(() => {
    if (
      !session ||
      session.status !== 'in_progress' ||
      !currentQuestion ||
      isTimeUp ||
      submitting ||
      submitConfirmOpen
    ) {
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const k = e.key.toUpperCase();
      if (k === 'N') {
        e.preventDefault();
        handleGoIndex(currentIndex + 1);
        return;
      }
      if (k === 'P') {
        e.preventDefault();
        handleGoIndex(currentIndex - 1);
        return;
      }
      if (k === 'F') {
        e.preventDefault();
        handleToggleFlag(currentQuestion.questionId);
        return;
      }
      if (k === 'I' && isAdminRun) {
        e.preventDefault();
        setInspectorOpen((open) => !open);
        return;
      }

      if (currentQuestion.parts.length === 1 && currentQuestion.formatType !== 'WRIT_TYPED_TASK') {
        const part = currentQuestion.parts[0];
        const numMap: Record<string, string> = {
          '1': 'A',
          '2': 'B',
          '3': 'C',
          '4': 'D',
          '5': 'E',
          '6': 'F',
          '7': 'G',
          '8': 'H',
        };
        const letter = numMap[k] || (['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].includes(k) ? k : '');
        if (letter && part.options.some((o) => o.key === letter)) {
          e.preventDefault();
          const currentPick = answersByPartId[part.partId];
          handleSelectAnswer(part.partId, currentPick === letter ? null : letter);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    session,
    currentQuestion,
    currentIndex,
    answersByPartId,
    isTimeUp,
    submitting,
    submitConfirmOpen,
    handleGoIndex,
    handleToggleFlag,
    handleSelectAnswer,
    isAdminRun,
  ]);

  // Re-sync clock anchor and check remote submit/expiry after tab wake / OS sleep
  useEffect(() => {
    if (!session || session.status !== 'in_progress') return;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      api
        .getSession(session.sessionId)
        .then((refreshed) => {
          if (refreshed.serverNowIso && !Number.isNaN(Date.parse(refreshed.serverNowIso))) {
            clock.setServerNow(refreshed.serverNowIso);
          }
          if (refreshed.session.status === 'submitted') {
            clearLocalDraft(draftStorageKey);
            setSession(refreshed.session);
            setQuestions(refreshed.questions);
            if (refreshed.reviewResults) setReviewResults(refreshed.reviewResults);
            if (refreshed.writingReview) setWritingReview(refreshed.writingReview);
            onActiveSessionClearedRef.current?.();
          }
        })
        .catch(() => undefined);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [session, draftStorageKey, clock]);

  // Warn on tab close/refresh when unsent draft exists or while locked in timed test
  useEffect(() => {
    if (!isLockedStudentSession && saveStatus !== 'unsent' && saveStatus !== 'failed') return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isLockedStudentSession, saveStatus]);

  const handleSubmit = useCallback(async () => {
    if (!session || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitConfirmOpen(false);
    setSubmitting(true);
    setError('');
    try {
      const res = await api.submitSession(session.sessionId, {
        ...checkpointRef.current,
        elapsedSec: clock.getElapsedSec(),
      });
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
      setError(err instanceof Error ? err.message : t('session.unableSubmit'));
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
  }, [session, draftStorageKey, isTimeUp, clock]);

  // Auto-submit when timed locked student session hits 00:00 on server clock
  useEffect(() => {
    if (!isTimeUp || autoSubmittedRef.current || submitting) return;
    autoSubmittedRef.current = true;
    handleSubmit();
  }, [isTimeUp, submitting, handleSubmit, autoSubmitRetry]);

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
    for (const q of questions) {
      if (q.formatType === 'WRIT_TYPED_TASK') {
        if (writingDraft.responseText.trim().length > 0) cnt++;
      } else {
        for (const p of q.parts) {
          if (answersByPartId[p.partId]) cnt++;
        }
      }
    }
    return cnt;
  }, [questions, answersByPartId, writingDraft.responseText]);

  const totalSlotsCount = useMemo(
    () => questions.reduce((sum, q) => sum + Math.max(1, q.parts.length), 0),
    [questions]
  );

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
      <PostSubmissionReview
        sessionId={session.sessionId}
        correctSlots={session.correctSlots}
        totalSlots={session.totalSlots}
        elapsedSec={clock.getElapsedSec()}
        questions={questions}
        reviewResults={reviewResults}
        writingReview={writingReview}
        onDoneHome={() => onNavigate('/')}
        onViewProgress={() => onNavigate('/progress')}
      />
    );
  }

  const isFlagged = flaggedQuestionIds.includes(currentQuestion.questionId);
  const currentStimId = currentQuestion.stimulus?.stimulusId || currentQuestion.questionId;
  const activeInspectorQ = inspectorMap[currentQuestion.questionId];

  return (
    <div className="min-h-screen lg:h-screen lg:overflow-hidden flex flex-col bg-[#FAF8F5] text-[#113C36]">
      {/* Quiet Exam Room 48px #F3EFE8 Top Rail */}
      <header className="sticky top-0 z-30 border-b border-[#E5DFD5] bg-[#F3EFE8]">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 min-h-[48px] py-1.5 grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] items-center gap-2.5">
          {/* Left: Plain title + soft emerald Saved pill */}
          <div className="flex items-center gap-2.5 min-w-0">
            {!isLockedStudentSession && (
              <button
                type="button"
                onClick={async () => {
                  await flushCheckpoint();
                  onNavigate(session.mode === 'admin_calibration' ? '/admin' : '/');
                }}
                aria-label={isAdminRun ? t('session.backToBank') : t('session.exitAria')}
                className="inline-flex items-center gap-1.5 p-1.5 rounded-[8px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-[#4A5955] hover:text-[#113C36] cursor-pointer shrink-0 transition-colors"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                {isAdminRun && <span className="hidden sm:inline pr-1 text-xs font-sans-display font-semibold">{t('session.backToBank')}</span>}
              </button>
            )}

            <div className="flex items-center gap-2.5 min-w-0 flex-wrap">
              <span className="font-sans-display font-semibold text-sm text-[#113C36] truncate">
                {session.title || session.mode.replace(/_/g, ' ')}
              </span>

              {isAdminRun && (
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium whitespace-nowrap ${
                    session.isSandbox ? 'bg-[#E9E4F5] text-[#4B3B7A]' : 'bg-[#FDF0E2] text-[#A35116]'
                  }`}
                >
                  {session.isSandbox ? t('session.sandboxBadge') : t('session.liveRunBadge')}
                </span>
              )}

              {saveStatus === 'saving' && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-white/80 border border-[#E5DFD5] text-[11px] font-medium text-[#4A5955] whitespace-nowrap">
                  {t('session.saving')}
                </span>
              )}
              {saveStatus === 'saved' && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#E5F3EC] text-[#1D6346] text-[11px] font-medium whitespace-nowrap">
                  <CloudCheck className="w-3 h-3 shrink-0" />
                  <span>{t('session.saved')}</span>
                </span>
              )}
              {saveStatus === 'unsent' && (
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[#FDF0E2] text-[#A35116] text-[11px] font-medium whitespace-nowrap">
                  <span>{t('session.unsentDraft')}</span>
                  <button
                    type="button"
                    onClick={() => flushCheckpoint()}
                    className="underline hover:text-[#113C36] cursor-pointer"
                  >
                    {t('session.saveNow')}
                  </button>
                </span>
              )}
              {saveStatus === 'failed' && (
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[#FDECEB] text-[#B42318] text-[11px] font-medium whitespace-nowrap">
                  <CloudOff className="w-3 h-3 shrink-0" />
                  <span>{t('session.saveFailed')}</span>
                  <button
                    type="button"
                    onClick={() => flushCheckpoint()}
                    className="inline-flex items-center gap-1 underline hover:text-[#113C36] cursor-pointer"
                  >
                    <RefreshCw className="w-2.5 h-2.5 shrink-0" />
                    {t('session.retry')}
                  </button>
                </span>
              )}
              {saveStatus === 'conflict' && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#FDF0E2] text-[#A35116] text-[11px] font-semibold whitespace-nowrap">
                  <AlertTriangle className="w-3 h-3 shrink-0" />
                  <span>{t('session.conflictChip')}</span>
                </span>
              )}
            </div>
          </div>

          {/* Center: Prominent AnthropicMono Countdown Clock (click to hide) */}
          <div className="flex items-center justify-center">
            <ExamTimer clock={clock} hidden={timerHidden} onToggleHidden={toggleTimerHidden} />
          </div>

          {/* Right: Question X of Y, Flag, Navigator, Language, Finish test */}
          <div className="flex items-center justify-start md:justify-end gap-2 flex-wrap">
            <div className="text-xs font-medium text-[#4A5955] tabular-nums whitespace-nowrap mr-1">
              {t('session.qOfTotal', { current: currentIndex + 1, total: questions.length })}
            </div>

            <button
              type="button"
              onClick={() => handleToggleFlag(currentQuestion.questionId)}
              aria-pressed={isFlagged}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] border text-xs font-sans-display font-medium cursor-pointer whitespace-nowrap transition-colors ${
                isFlagged
                  ? 'border-[#A35116]/50 bg-[#FDF0E2] text-[#A35116]'
                  : 'border-[#E5DFD5] bg-white text-[#4A5955] hover:text-[#113C36] hover:border-[#CFC6B9]'
              }`}
            >
              <Flag className="w-3.5 h-3.5" />
              <span>{isFlagged ? t('session.flagged') : t('session.flag')}</span>
            </button>

            <button
              type="button"
              onClick={() => setNavOpen((v) => !v)}
              aria-expanded={navOpen}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] border text-xs font-sans-display font-medium cursor-pointer whitespace-nowrap transition-colors ${
                navOpen
                  ? 'border-[#113C36] bg-[#E5F0EA] text-[#113C36]'
                  : 'border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-[#113C36]'
              }`}
            >
              <Grid className="w-3.5 h-3.5" />
              <span>{t('session.navigator')}</span>
              <ChevronDown
                className={`w-3.5 h-3.5 opacity-70 transition-transform ${
                  navOpen ? 'rotate-180' : ''
                }`}
              />
            </button>

            {isAdminRun && (
              <button
                type="button"
                onClick={() => setInspectorOpen((v) => !v)}
                aria-pressed={inspectorOpen}
                aria-keyshortcuts="I"
                title={t('session.inspectorToggleAria')}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] border text-xs font-sans-display font-medium cursor-pointer whitespace-nowrap transition-colors ${
                  inspectorOpen
                    ? 'border-[#113C36] bg-[#E5F0EA] text-[#113C36]'
                    : 'border-[#CFC6B9] bg-white text-[#113C36]'
                }`}
              >
                <ShieldAlert className="w-3.5 h-3.5" />
                <span>{t('session.inspector')}</span>
                <kbd className="hidden sm:inline rounded border border-current/30 px-1 font-mono-code text-[10px] leading-4 opacity-70">I</kbd>
              </button>
            )}

            <LanguageToggle compact />

            <button
              type="button"
              disabled={submitting}
              onClick={() => setSubmitConfirmOpen(true)}
              className="px-3.5 py-1.5 rounded-[8px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-xs font-sans-display font-semibold cursor-pointer whitespace-nowrap disabled:opacity-60 transition-colors"
            >
              {submitting ? t('session.submitting') : t('session.finishTest')}
            </button>
          </div>
        </div>

        {navOpen && (
          <QuestionNavigator
            questions={questions}
            currentIndex={currentIndex}
            answersByPartId={answersByPartId}
            flaggedQuestionIds={flaggedQuestionIds}
            writingResponse={writingDraft.responseText}
            answeredSlots={answeredSlotsCount}
            totalSlots={totalSlotsCount}
            onGoIndex={handleGoIndex}
          />
        )}
      </header>

      {/* Recoverable Unsent Local Draft Banner */}
      {recoverableDraft && !conflictState && (
        <div className="border-b border-[#A35116]/25 bg-[#FDF0E2] px-6 py-2.5">
          <div className="max-w-[1440px] mx-auto flex flex-wrap items-center justify-between gap-3 text-xs text-[#A35116]">
            <span>
              {t('session.localDraftFound', {
                time: new Date(recoverableDraft.savedAtMs).toLocaleTimeString(isZh ? 'zh-CN' : 'en-AU'),
              })}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  applyCheckpointToState(recoverableDraft.checkpoint, questions.length);
                  setRecoverableDraft(null);
                  dirtyRef.current = true;
                  saveQueueRef.current?.markDirty();
                  void flushCheckpoint();
                }}
                className="px-3 py-1 rounded-[8px] bg-[#113C36] text-white font-sans-display font-semibold cursor-pointer whitespace-nowrap"
              >
                {t('session.restoreDraft')}
              </button>
              <button
                type="button"
                onClick={() => {
                  clearLocalDraft(draftStorageKey);
                  setRecoverableDraft(null);
                  setSaveStatus('saved');
                }}
                className="px-3 py-1 rounded-[8px] border border-[#A35116] font-sans-display font-semibold cursor-pointer whitespace-nowrap"
              >
                {t('session.discardDraft')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Optimistic Concurrency Conflict Resolution Banner (409) */}
      {conflictState && (
        <div role="alert" className="border-b border-[#B42318]/25 bg-[#FDECEB] px-6 py-2.5">
          <div className="max-w-[1440px] mx-auto flex flex-wrap items-center justify-between gap-3 text-xs text-[#B42318]">
            <span>
              {t('session.conflictBanner', { rev: conflictState.currentRevision })}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  checkpointRevisionRef.current = conflictState.currentRevision;
                  saveQueueRef.current?.clearConflict(conflictState.currentRevision, true);
                  applyCheckpointToState(conflictState.serverCheckpoint, questions.length);
                  clearLocalDraft(draftStorageKey);
                  dirtyRef.current = false;
                  setConflictState(null);
                  setSaveStatus('saved');
                }}
                className="px-3 py-1 rounded-[8px] bg-[#113C36] text-white font-sans-display font-semibold cursor-pointer whitespace-nowrap"
              >
                {t('session.loadLatestServer')}
              </button>
              <button
                type="button"
                onClick={() => {
                  checkpointRevisionRef.current = conflictState.currentRevision;
                  saveQueueRef.current?.setRevision(conflictState.currentRevision);
                  void flushCheckpoint(conflictState.currentRevision);
                }}
                className="px-3 py-1 rounded-[8px] border border-[#B42318] font-sans-display font-semibold cursor-pointer whitespace-nowrap"
              >
                {t('session.keepDeviceAnswers')}
              </button>
            </div>
          </div>
        </div>
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
        answersByPartId={answersByPartId}
        eliminatedByPartId={eliminatedByPartId}
        highlights={highlightsByStimulusId[currentStimId] || []}
        activeGapIndex={activeGapIndex}
        onSelectGapIndex={setActiveGapIndex}
        onSelectAnswer={handleSelectAnswer}
        onToggleEliminate={handleToggleEliminate}
        onAddHighlight={(text) => {
          markLocalDirty();
          setHighlightsByStimulusId((prev) => ({
            ...prev,
            [currentStimId]: Array.from(new Set([...(prev[currentStimId] || []), text])),
          }));
        }}
        onClearHighlights={() => {
          markLocalDirty();
          setHighlightsByStimulusId((prev) => ({ ...prev, [currentStimId]: [] }));
        }}
        writingDraft={writingDraft}
        onChangeWritingPlan={(val) => {
          markLocalDirty();
          setWritingDraft((prev) => ({ ...prev, planNotes: val }));
        }}
        onChangeWritingResponse={(val) => {
          markLocalDirty();
          setWritingDraft((prev) => ({ ...prev, responseText: val }));
        }}
        footerNav={
          <div className="pt-4 border-t border-[#E5DFD5] flex items-center justify-between gap-3">
            <button
              type="button"
              disabled={currentIndex === 0}
              onClick={() => handleGoIndex(currentIndex - 1)}
              className="px-4 py-2 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#F3EFE8] text-sm font-sans-display font-medium text-[#113C36] inline-flex items-center gap-1.5 disabled:opacity-40 cursor-pointer transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>{t('session.previous')}</span>
            </button>

            <div className="flex items-center gap-2">
              {currentIndex < questions.length - 1 ? (
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
                  {submitting ? t('session.submitting') : t('session.finishTest')}
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
        flaggedCount={flaggedQuestionIds.length}
        onCancel={closeSubmitConfirm}
        onConfirm={handleSubmit}
      />
    </div>
  );
}
