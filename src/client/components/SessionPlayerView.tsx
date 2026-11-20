import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  CloudCheck,
  CloudOff,
  Eye,
  EyeOff,
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
import { SKILLS_TAXONOMY } from '../../shared/skills';
import { PostSubmissionReview } from './PostSubmissionReview';
import { QuestionWorkspace } from './QuestionWorkspace';

const SKILL_NAME_MAP = new Map(SKILLS_TAXONOMY.map((s) => [s.skillId, s.displayName]));

function formatTimer(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [questions, setQuestions] = useState<StudentQuestionView[]>([]);

  // Draft checkpoint state
  const [currentIndex, setCurrentIndex] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(0);
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
  const serverAnchorRef = useRef<{ serverMs: number; perfMs: number } | null>(null);
  const [, setClockTick] = useState(0);

  // Submission Review
  const [reviewResults, setReviewResults] = useState<Record<string, MarkingResult[]> | undefined>();
  const [writingReview, setWritingReview] = useState<SessionDetailResponse['writingReview']>();

  // Admin Calibration Inspector (strictly admin-only)
  const [inspectorMap, setInspectorMap] = useState<Record<string, QuestionItem>>({});
  const [inspectorOpen, setInspectorOpen] = useState(false);

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
      setElapsedSec(cp.elapsedSec || 0);
      setAnswersByPartId(cp.answersByPartId || {});
      setFlaggedQuestionIds(cp.flaggedQuestionIds || []);
      setEliminatedByPartId(cp.eliminatedOptionsByPartId || {});
      setHighlightsByStimulusId(cp.passageHighlightsByStimulusId || {});
      setWritingDraft(cp.writingDraft || { planNotes: '', responseText: '' });
      checkpointRef.current = cp;
    },
    []
  );

  useEffect(() => {
    checkpointRef.current = {
      currentIndex,
      elapsedSec,
      answersByPartId,
      flaggedQuestionIds,
      eliminatedOptionsByPartId: eliminatedByPartId,
      passageHighlightsByStimulusId: highlightsByStimulusId,
      writingDraft,
    };
  }, [
    currentIndex,
    elapsedSec,
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
        serverAnchorRef.current = {
          serverMs: Number.isNaN(parsedServerMs) ? Date.now() : parsedServerMs,
          perfMs: performance.now(),
        };
        sessionRef.current = res.session;
        setSession(res.session);
        setQuestions(res.questions);
        const initialRev = res.session.checkpointRevision ?? 1;
        checkpointRevisionRef.current = initialRev;

        const queue = new CheckpointSaveQueue<SessionCheckpoint>({
          initialRevision: initialRev,
          getPayload: () => checkpointRef.current,
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
            if (saveRes.serverNowIso) {
              const ms = Date.parse(saveRes.serverNowIso);
              if (!Number.isNaN(ms)) {
                serverAnchorRef.current = { serverMs: ms, perfMs: performance.now() };
              }
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
            if (active) {
              setInspectorMap(insp.inspectorByQuestionId);
              setInspectorOpen(true);
            }
          } catch {
            // ignore
          }
        }
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : 'Unable to load session.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      saveQueueRef.current?.dispose();
      saveQueueRef.current = null;
    };
  }, [sessionId, isAdmin, draftStorageKey, applyCheckpointToState]);

  const flushCheckpoint = useCallback(async (overrideExpectedRevision?: number) => {
    const queue = saveQueueRef.current;
    if (!queue) return;
    await queue.flush(overrideExpectedRevision);
  }, []);

  // Elapsed timer, 500ms monotonic deadline clock tick, and 30s periodic autosave
  useEffect(() => {
    if (!session || session.status !== 'in_progress') return;
    const secTimer = window.setInterval(() => {
      setElapsedSec((prev) => prev + 1);
    }, 1000);
    const clockTimer = window.setInterval(() => {
      setClockTick((t) => (t + 1) % 100_000);
    }, 500);
    const saveTimer = window.setInterval(() => {
      if (!saveQueueRef.current?.hasActiveConflict()) {
        void flushCheckpoint();
      }
    }, 30_000);
    return () => {
      window.clearInterval(secTimer);
      window.clearInterval(clockTimer);
      window.clearInterval(saveTimer);
    };
  }, [session, flushCheckpoint]);

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
    writeLocalDraft(draftStorageKey, checkpointRef.current);
  }, [draftStorageKey]);

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
      setNavOpen(false);
    },
    [questions.length, markLocalDirty]
  );

  const isLockedStudentSession = Boolean(
    session &&
      session.status === 'in_progress' &&
      session.mode !== 'admin_calibration' &&
      !session.isSandbox
  );

  const deadlineMs = session?.deadlineAt ? Date.parse(session.deadlineAt) : null;
  let remainingSec: number | null = null;
  if (deadlineMs !== null && !Number.isNaN(deadlineMs)) {
    const anchor = serverAnchorRef.current;
    const nowApproxMs = anchor
      ? anchor.serverMs + (performance.now() - anchor.perfMs)
      : Date.now();
    remainingSec = Math.max(0, Math.ceil((deadlineMs - nowApproxMs) / 1000));
  } else if (session?.timeLimitSec) {
    remainingSec = Math.max(0, session.timeLimitSec - elapsedSec);
  }
  const isTimeUp = Boolean(isLockedStudentSession && remainingSec !== null && remainingSec <= 0);

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
  ]);

  // Re-sync clock anchor and check remote submit/expiry after tab wake / OS sleep
  useEffect(() => {
    if (!session || session.status !== 'in_progress') return;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      api
        .getSession(session.sessionId)
        .then((refreshed) => {
          if (refreshed.serverNowIso) {
            const parsedServerMs = Date.parse(refreshed.serverNowIso);
            if (!Number.isNaN(parsedServerMs)) {
              serverAnchorRef.current = { serverMs: parsedServerMs, perfMs: performance.now() };
            }
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
  }, [session, draftStorageKey]);

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
      const res = await api.submitSession(session.sessionId, checkpointRef.current);
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
      setError(err instanceof Error ? err.message : 'Unable to submit session.');
      if (isTimeUp) {
        window.setTimeout(() => {
          autoSubmittedRef.current = false;
          setClockTick((t) => (t + 1) % 100_000);
        }, 2500);
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [session, draftStorageKey, isTimeUp]);

  // Auto-submit when timed locked student session hits 00:00 on server clock
  useEffect(() => {
    if (!isTimeUp || autoSubmittedRef.current || submitting) return;
    autoSubmittedRef.current = true;
    handleSubmit();
  }, [isTimeUp, submitting, handleSubmit]);

  const handleInspectorQcChange = async (questionId: string, nextStatus: QuestionItem['qcStatus']) => {
    try {
      await api.updateQuestionStatus(questionId, nextStatus);
      setInspectorMap((prev) => ({
        ...prev,
        [questionId]: { ...prev[questionId], qcStatus: nextStatus },
      }));
    } catch {
      // ignore
    }
  };

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
        Loading exam workspace...
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
          Back to Home
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
        elapsedSec={elapsedSec}
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
  const safeInspectorPartIdx = activeInspectorQ
    ? Math.min(Math.max(0, activeGapIndex), Math.max(0, activeInspectorQ.parts.length - 1))
    : 0;
  const activeInspectorPart = activeInspectorQ?.parts[safeInspectorPartIdx];

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
                aria-label="Exit session and return"
                className="p-1.5 rounded-[8px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-[#4A5955] hover:text-[#113C36] cursor-pointer shrink-0 transition-colors"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
              </button>
            )}

            <div className="flex items-center gap-2.5 min-w-0 flex-wrap">
              <span className="font-sans-display font-semibold text-sm text-[#113C36] truncate">
                {session.title || session.mode.replace(/_/g, ' ')}
              </span>

              {saveStatus === 'saving' && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-white/80 border border-[#E5DFD5] text-[11px] font-medium text-[#4A5955]">
                  Saving...
                </span>
              )}
              {saveStatus === 'saved' && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#E5F3EC] text-[#1D6346] text-[11px] font-medium">
                  <CloudCheck className="w-3 h-3" />
                  <span>Saved</span>
                </span>
              )}
              {saveStatus === 'unsent' && (
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[#FDF0E2] text-[#A35116] text-[11px] font-medium">
                  <span>Unsent draft</span>
                  <button
                    type="button"
                    onClick={() => flushCheckpoint()}
                    className="underline hover:text-[#113C36] cursor-pointer"
                  >
                    Save now
                  </button>
                </span>
              )}
              {saveStatus === 'failed' && (
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[#FDECEB] text-[#B42318] text-[11px] font-medium">
                  <CloudOff className="w-3 h-3" />
                  <span>Save failed</span>
                  <button
                    type="button"
                    onClick={() => flushCheckpoint()}
                    className="inline-flex items-center gap-1 underline hover:text-[#113C36] cursor-pointer"
                  >
                    <RefreshCw className="w-2.5 h-2.5" />
                    Retry
                  </button>
                </span>
              )}
              {saveStatus === 'conflict' && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#FDF0E2] text-[#A35116] text-[11px] font-semibold">
                  <AlertTriangle className="w-3 h-3" />
                  <span>Updated on another device</span>
                </span>
              )}
            </div>
          </div>

          {/* Center: Prominent AnthropicMono Countdown Clock (click to hide) */}
          <div className="flex items-center justify-center">
            <button
              type="button"
              onClick={() => setTimerHidden((v) => !v)}
              aria-label={timerHidden ? 'Show countdown timer' : 'Hide countdown timer'}
              title={timerHidden ? 'Click to show timer' : 'Click to hide timer'}
              className={`inline-flex items-center gap-2 px-4 py-1 rounded-[10px] border cursor-pointer transition-colors ${
                remainingSec !== null && remainingSec <= 30 && !timerHidden
                  ? 'border-[#B42318]/50 bg-[#FDECEB] text-[#B42318]'
                  : remainingSec !== null && remainingSec <= 120 && !timerHidden
                    ? 'border-[#A35116]/40 bg-[#FDF0E2] text-[#A35116]'
                    : 'border-[#E5DFD5] bg-white text-[#113C36] hover:border-[#CFC6B9]'
              }`}
            >
              {timerHidden ? (
                <Eye className="w-3.5 h-3.5 opacity-60" />
              ) : (
                <EyeOff className="w-3.5 h-3.5 opacity-55" />
              )}
              <span
                data-testid="exam-timer-display"
                className="font-exam-clock text-xl sm:text-[22px] tracking-tight leading-none"
              >
                {timerHidden
                  ? '--:--'
                  : remainingSec !== null
                    ? formatTimer(remainingSec)
                    : formatTimer(elapsedSec)}
              </span>
            </button>
          </div>

          {/* Right: Question X of Y, Flag, Navigator, Finish test */}
          <div className="flex items-center justify-start md:justify-end gap-2 flex-wrap">
            <div className="text-xs font-medium text-[#4A5955] tabular-nums whitespace-nowrap mr-1">
              Question {currentIndex + 1} of {questions.length}
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
              <span>{isFlagged ? 'Flagged' : 'Flag'}</span>
            </button>

            <button
              type="button"
              onClick={() => setNavOpen((v) => !v)}
              aria-expanded={navOpen}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-xs font-sans-display font-medium text-[#113C36] cursor-pointer whitespace-nowrap transition-colors"
            >
              <Grid className="w-3.5 h-3.5" />
              <span>Navigator</span>
              <ChevronDown className="w-3.5 h-3.5 opacity-70" />
            </button>

            {session.mode === 'admin_calibration' && isAdmin && activeInspectorQ && (
              <button
                type="button"
                onClick={() => setInspectorOpen((v) => !v)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] border text-xs font-sans-display font-medium cursor-pointer whitespace-nowrap ${
                  inspectorOpen
                    ? 'border-[#113C36] bg-[#E5F0EA] text-[#113C36]'
                    : 'border-[#CFC6B9] bg-white text-[#113C36]'
                }`}
              >
                <ShieldAlert className="w-3.5 h-3.5" />
                <span>Inspector</span>
              </button>
            )}

            <button
              type="button"
              disabled={submitting}
              onClick={() => setSubmitConfirmOpen(true)}
              className="px-3.5 py-1.5 rounded-[8px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-xs font-sans-display font-semibold cursor-pointer whitespace-nowrap disabled:opacity-60 transition-colors"
            >
              {submitting ? 'Submitting...' : 'Finish test'}
            </button>
          </div>
        </div>

        {/* Collapsible Question Navigator Grid */}
        {navOpen && (
          <div className="border-t border-[#E5DFD5] bg-[#FAF8F5] px-6 py-4">
            <div className="max-w-[1440px] mx-auto space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#4A5955]">
                <span className="font-medium tabular-nums">
                  {answeredSlotsCount} of {totalSlotsCount} slots answered across {questions.length} questions
                </span>
                <div className="flex items-center gap-3 text-[11px] text-[#78756E]">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-xs bg-[#113C36]" /> Current
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-xs bg-[#E5F0EA] border border-[#1D6346]/50" /> Answered
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-[#A35116]" /> Flagged
                  </span>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {questions.map((q, idx) => {
                  const isCurr = idx === currentIndex;
                  const isQFlagged = flaggedQuestionIds.includes(q.questionId);
                  const isQAnswered =
                    q.formatType === 'WRIT_TYPED_TASK'
                      ? writingDraft.responseText.trim().length > 0
                      : q.parts.every((p) => Boolean(answersByPartId[p.partId]));
                  return (
                    <button
                      key={q.questionId}
                      type="button"
                      onClick={() => handleGoIndex(idx)}
                      className={`w-10 h-10 rounded-[8px] border text-xs font-sans-display font-semibold tabular-nums relative cursor-pointer transition-colors ${
                        isCurr
                          ? 'border-[#113C36] bg-[#113C36] text-white'
                          : isQAnswered
                            ? 'border-[#1D6346]/45 bg-[#E5F0EA] text-[#113C36]'
                            : 'border-[#CFC6B9] bg-white text-[#113C36] hover:bg-[#F3EFE8]'
                      }`}
                    >
                      {idx + 1}
                      {isQFlagged && (
                        <span
                          aria-label="Flagged"
                          className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-[#A35116] border border-white"
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </header>

      {/* Recoverable Unsent Local Draft Banner */}
      {recoverableDraft && !conflictState && (
        <div className="border-b border-[#A35116]/25 bg-[#FDF0E2] px-6 py-2.5">
          <div className="max-w-[1440px] mx-auto flex flex-wrap items-center justify-between gap-3 text-xs text-[#A35116]">
            <span>
              An unsent local draft from {new Date(recoverableDraft.savedAtMs).toLocaleTimeString()} was found in this browser.
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
                className="px-3 py-1 rounded-[8px] bg-[#113C36] text-white font-sans-display font-semibold cursor-pointer"
              >
                Restore and save draft
              </button>
              <button
                type="button"
                onClick={() => {
                  clearLocalDraft(draftStorageKey);
                  setRecoverableDraft(null);
                  setSaveStatus('saved');
                }}
                className="px-3 py-1 rounded-[8px] border border-[#A35116] font-sans-display font-semibold cursor-pointer"
              >
                Discard unsent draft
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
              Another device saved a newer version of this session (revision {conflictState.currentRevision}).
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
                className="px-3 py-1 rounded-[8px] bg-[#113C36] text-white font-sans-display font-semibold cursor-pointer"
              >
                Load latest saved answers
              </button>
              <button
                type="button"
                onClick={() => {
                  checkpointRevisionRef.current = conflictState.currentRevision;
                  saveQueueRef.current?.setRevision(conflictState.currentRevision);
                  void flushCheckpoint(conflictState.currentRevision);
                }}
                className="px-3 py-1 rounded-[8px] border border-[#B42318] font-sans-display font-semibold cursor-pointer"
              >
                Keep this device&apos;s answers
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
          Time has ended — locking answers and submitting your paper now...
        </div>
      )}

      {error && (
        <div role="alert" className="max-w-[1440px] mx-auto w-full px-6 pt-4">
          <div className="p-3 rounded-[10px] bg-[#FDECEB] text-[#B42318] text-xs font-medium">
            {error}
          </div>
        </div>
      )}

      {/* Admin Inspector Panel (strictly in admin_calibration mode) */}
      {session.mode === 'admin_calibration' && isAdmin && inspectorOpen && activeInspectorQ && (
        <div className="border-b border-[#E5DFD5] bg-[#F3EFE8] px-6 py-4">
          <div className="max-w-[1440px] mx-auto flex flex-col lg:flex-row lg:items-start justify-between gap-4 text-xs">
            <div className="space-y-1.5 flex-1 min-w-0">
              <div className="font-mono-code font-semibold text-[#113C36]">
                Admin Inspector | {activeInspectorQ.questionId} | Pool: {activeInspectorQ.poolType} | QC:{' '}
                {activeInspectorQ.qcStatus}
                {activeInspectorQ.provenance.sourceReference
                  ? ` | ${activeInspectorQ.provenance.sourceReference}`
                  : ''}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[#4A5955]">
                {activeInspectorQ.parts.map((p, idx) => (
                  <button
                    key={p.partId}
                    type="button"
                    onClick={() => setActiveGapIndex(idx)}
                    className={`px-2 py-0.5 rounded-[6px] border text-left cursor-pointer ${
                      idx === safeInspectorPartIdx
                        ? 'border-[#113C36] bg-[#E5F0EA] text-[#113C36]'
                        : 'border-[#E5DFD5] bg-white hover:bg-[#FAF8F5]'
                    }`}
                  >
                    {activeInspectorQ.parts.length > 1 ? `P${idx + 1}: ` : ''}
                    <strong>Key: {p.correctAnswerKey || 'Writing'}</strong> (Diff {p.difficultyInitial},{' '}
                    {SKILL_NAME_MAP.get(p.skillId) || p.skillId})
                  </button>
                ))}
              </div>
              {activeInspectorPart?.workedExplanation && (
                <div className="text-[#4A5955] whitespace-pre-line pt-1">
                  <strong className="text-[#113C36]">
                    Explanation{activeInspectorQ.parts.length > 1 ? ` (Part ${safeInspectorPartIdx + 1})` : ''}:
                  </strong>{' '}
                  {activeInspectorPart.workedExplanation}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => handleInspectorQcChange(activeInspectorQ.questionId, 'active')}
                className={`px-3 py-1.5 rounded-[8px] border text-xs font-sans-display font-semibold cursor-pointer ${
                  activeInspectorQ.qcStatus === 'active'
                    ? 'border-[#1D6346] bg-[#E5F3EC] text-[#1D6346]'
                    : 'border-[#CFC6B9] bg-white'
                }`}
              >
                Mark active
              </button>
              <button
                type="button"
                onClick={() => handleInspectorQcChange(activeInspectorQ.questionId, 'quarantined')}
                className={`px-3 py-1.5 rounded-[8px] border text-xs font-sans-display font-semibold cursor-pointer ${
                  activeInspectorQ.qcStatus === 'quarantined'
                    ? 'border-[#B42318] bg-[#FDECEB] text-[#B42318]'
                    : 'border-[#CFC6B9] bg-white'
                }`}
              >
                Quarantine
              </button>
            </div>
          </div>
        </div>
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
              <span>Previous</span>
            </button>

            <div className="flex items-center gap-2">
              {currentIndex < questions.length - 1 ? (
                <button
                  type="button"
                  onClick={() => handleGoIndex(currentIndex + 1)}
                  className="px-5 py-2 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-sm font-sans-display font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                >
                  <span>Next</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              ) : (
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => setSubmitConfirmOpen(true)}
                  className="px-5 py-2 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-sm font-sans-display font-semibold cursor-pointer disabled:opacity-60 transition-colors"
                >
                  {submitting ? 'Submitting...' : 'Finish test'}
                </button>
              )}
            </div>
          </div>
        }
      />

      {/* 2-Step Finish Test Confirmation Modal */}
      {submitConfirmOpen && (
        <div
          role="presentation"
          onClick={() => !submitting && setSubmitConfirmOpen(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#113C36]/35 backdrop-blur-[2px] p-4"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="submit-confirm-title"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-[18px] bg-white border border-[#E5DFD5] p-6 space-y-5 shadow-[0_18px_40px_rgba(17,60,54,0.16)]"
          >
            <div className="space-y-1">
              <p className="text-xs font-sans-display font-medium text-[#78756E]">Finish test</p>
              <h2
                id="submit-confirm-title"
                className="font-sans-display font-semibold text-xl tracking-[-0.015em] text-[#113C36]"
              >
                Ready to submit your answers?
              </h2>
            </div>

            <dl className="grid grid-cols-3 gap-2.5 p-3.5 rounded-[12px] bg-[#FAF8F5] border border-[#E5DFD5] text-xs text-center tabular-nums">
              <div>
                <dt className="text-[#78756E]">Answered</dt>
                <dd className="mt-1 font-serif-display font-extrabold text-xl text-[#1D6346]">
                  {answeredSlotsCount}/{totalSlotsCount}
                </dd>
              </div>
              <div>
                <dt className="text-[#78756E]">Unanswered</dt>
                <dd className="mt-1 font-serif-display font-extrabold text-xl text-[#113C36]">
                  {Math.max(0, totalSlotsCount - answeredSlotsCount)}
                </dd>
              </div>
              <div>
                <dt className="text-[#78756E]">Flagged</dt>
                <dd className="mt-1 font-serif-display font-extrabold text-xl text-[#A35116]">
                  {flaggedQuestionIds.length}
                </dd>
              </div>
            </dl>

            <p className="text-xs text-[#4A5955] leading-relaxed">
              Submitting records your final answers and opens the full review screen with worked explanations.
            </p>

            <div className="flex items-center justify-end gap-2.5 pt-1">
              <button
                type="button"
                disabled={submitting}
                onClick={() => setSubmitConfirmOpen(false)}
                className="px-4 py-2 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-xs font-sans-display font-semibold text-[#4A5955] cursor-pointer disabled:opacity-50"
              >
                Keep working
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={handleSubmit}
                className="px-5 py-2 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-xs font-sans-display font-semibold cursor-pointer disabled:opacity-60"
              >
                {submitting ? 'Submitting...' : 'Confirm and submit'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
