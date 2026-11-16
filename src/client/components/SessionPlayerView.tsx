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
import { api, type ApiError, type SessionDetailResponse } from '../api';
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
  const autoSubmittedRef = useRef(false);

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
    setLoading(true);
    setError('');
    setConflictState(null);
    setRecoverableDraft(null);
    api
      .getSession(sessionId)
      .then(async (res) => {
        if (!active) return;
        setSession(res.session);
        setQuestions(res.questions);
        checkpointRevisionRef.current = res.session.checkpointRevision ?? 1;

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
    };
  }, [sessionId, isAdmin, draftStorageKey, applyCheckpointToState]);

  const flushCheckpoint = useCallback(
    async (overrideExpectedRevision?: number) => {
      if (!session || session.status !== 'in_progress') return;
      if (conflictState && overrideExpectedRevision === undefined) return;
      const payload = checkpointRef.current;
      writeLocalDraft(draftStorageKey, payload);
      setSaveStatus('saving');
      try {
        const res = await api.saveCheckpoint(
          session.sessionId,
          payload,
          overrideExpectedRevision ?? checkpointRevisionRef.current
        );
        checkpointRevisionRef.current = res.revision;
        dirtyRef.current = false;
        setConflictState(null);
        clearLocalDraft(draftStorageKey);
        setSaveStatus('saved');
      } catch (err) {
        const apiErr = err as ApiError;
        if (apiErr.status === 409 && apiErr.serverCheckpoint && typeof apiErr.currentRevision === 'number') {
          setConflictState({
            currentRevision: apiErr.currentRevision,
            serverCheckpoint: apiErr.serverCheckpoint,
          });
          setSaveStatus('conflict');
        } else {
          setSaveStatus('failed');
        }
      }
    },
    [session, conflictState, draftStorageKey]
  );

  // Elapsed timer + 30s periodic autosave
  useEffect(() => {
    if (!session || session.status !== 'in_progress') return;
    const secTimer = window.setInterval(() => {
      setElapsedSec((prev) => prev + 1);
    }, 1000);
    const saveTimer = window.setInterval(() => {
      flushCheckpoint();
    }, 30_000);
    return () => {
      window.clearInterval(secTimer);
      window.clearInterval(saveTimer);
    };
  }, [session, flushCheckpoint]);

  // Debounced checkpoint save on state change
  useEffect(() => {
    if (!session || session.status !== 'in_progress' || !dirtyRef.current) return;
    const t = window.setTimeout(() => {
      flushCheckpoint();
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
    setSaveStatus('unsent');
    writeLocalDraft(draftStorageKey, checkpointRef.current);
  }, [draftStorageKey]);

  const handleSelectAnswer = useCallback(
    (partId: string, key: string | null) => {
      dirtyRef.current = true;
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

  // Keyboard shortcuts (1-8 / A-H, N / P, F)
  useEffect(() => {
    if (!session || session.status !== 'in_progress' || !currentQuestion) return;
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
  }, [session, currentQuestion, currentIndex, answersByPartId, handleGoIndex, handleToggleFlag, handleSelectAnswer]);

  const isLockedStudentSession = Boolean(
    session &&
      session.status === 'in_progress' &&
      session.mode !== 'admin_calibration' &&
      !session.isSandbox
  );

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
    if (!session || submitting) return;
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
      onActiveSessionCleared?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to submit session.');
    } finally {
      setSubmitting(false);
    }
  }, [session, submitting, onActiveSessionCleared, draftStorageKey]);

  // Auto-submit when timed locked student session hits 00:00
  useEffect(() => {
    if (!isLockedStudentSession || !session?.timeLimitSec || autoSubmittedRef.current) return;
    if (elapsedSec >= session.timeLimitSec) {
      autoSubmittedRef.current = true;
      handleSubmit();
    }
  }, [isLockedStudentSession, session?.timeLimitSec, elapsedSec, handleSubmit]);

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

  const remainingSec = session.timeLimitSec ? Math.max(0, session.timeLimitSec - elapsedSec) : null;
  const isFlagged = flaggedQuestionIds.includes(currentQuestion.questionId);
  const currentStimId = currentQuestion.stimulus?.stimulusId || currentQuestion.questionId;
  const activeInspectorQ = inspectorMap[currentQuestion.questionId];

  return (
    <div className="min-h-screen lg:h-screen lg:overflow-hidden flex flex-col bg-[var(--bg-canvas)]">
      {/* Janison-Style Minimalist Exam Top Bar with Large Centered Timer + Authoritative Save Status */}
      <header className="sticky top-0 z-30 border-b border-[var(--border-hairline)] bg-[var(--bg-elevated)]">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 py-2.5 grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] items-center gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {!isLockedStudentSession && (
              <button
                type="button"
                onClick={async () => {
                  await flushCheckpoint();
                  onNavigate(session.mode === 'admin_calibration' ? '/admin' : '/');
                }}
                aria-label="Exit session and return"
                className="p-1.5 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] hover:bg-[var(--bg-surface)] text-[var(--text-secondary)] cursor-pointer shrink-0"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
            )}
            <div className="min-w-0">
              <div className="text-sm font-bold text-[var(--text-primary)] truncate">
                {session.title || session.mode.replace(/_/g, ' ')}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
                <span>{isLockedStudentSession ? 'Locked exam session' : 'Calibration workspace'}</span>
                <span aria-hidden="true">·</span>
                {saveStatus === 'saving' && (
                  <span className="text-[var(--text-secondary)] font-medium">Saving...</span>
                )}
                {saveStatus === 'saved' && (
                  <span className="inline-flex items-center gap-1 text-[var(--status-success)] font-medium">
                    <CloudCheck className="w-3.5 h-3.5" />
                    <span>Saved</span>
                  </span>
                )}
                {saveStatus === 'unsent' && (
                  <span className="inline-flex items-center gap-1 text-[var(--status-warn)] font-medium">
                    <span>Unsent local draft</span>
                    <button
                      type="button"
                      onClick={() => flushCheckpoint()}
                      className="underline hover:text-[var(--text-primary)] cursor-pointer"
                    >
                      Save now
                    </button>
                  </span>
                )}
                {saveStatus === 'failed' && (
                  <span className="inline-flex items-center gap-1.5 text-[var(--status-error)] font-medium">
                    <CloudOff className="w-3.5 h-3.5" />
                    <span>Save failed</span>
                    <button
                      type="button"
                      onClick={() => flushCheckpoint()}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-[var(--status-error)] text-[11px] hover:bg-[var(--status-error-bg)] cursor-pointer"
                    >
                      <RefreshCw className="w-2.5 h-2.5" />
                      Retry
                    </button>
                  </span>
                )}
                {saveStatus === 'conflict' && (
                  <span className="inline-flex items-center gap-1 text-[var(--status-warn)] font-semibold">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    <span>Newer save on another device</span>
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Center Large Prominent Timer */}
          <div className="flex items-center justify-center">
            <button
              type="button"
              onClick={() => setTimerHidden((v) => !v)}
              aria-label={timerHidden ? 'Show countdown timer' : 'Hide countdown timer'}
              className={`inline-flex items-center gap-2.5 px-5 py-1.5 rounded-[var(--radius-md)] border cursor-pointer transition-colors ${
                remainingSec !== null && remainingSec <= 30 && !timerHidden
                  ? 'border-[var(--status-error)] bg-[var(--status-error-bg)] text-[var(--status-error)]'
                  : remainingSec !== null && remainingSec <= 120 && !timerHidden
                    ? 'border-[var(--status-warn)] bg-[var(--status-warn-bg)] text-[var(--status-warn)]'
                    : 'border-[var(--border-strong)] bg-[var(--bg-surface)] text-[var(--text-primary)]'
              }`}
            >
              {timerHidden ? <Eye className="w-4 h-4 opacity-70" /> : <EyeOff className="w-4 h-4 opacity-70" />}
              <span
                data-testid="exam-timer-display"
                className="text-2xl sm:text-3xl font-bold font-mono tabular-nums tracking-tight leading-none"
              >
                {timerHidden
                  ? '--:--'
                  : remainingSec !== null
                    ? formatTimer(remainingSec)
                    : formatTimer(elapsedSec)}
              </span>
            </button>
          </div>

          <div className="flex items-center justify-start md:justify-end gap-2.5 flex-wrap">
            <div className="text-xs font-medium text-[var(--text-secondary)] tabular-nums whitespace-nowrap">
              Q {currentIndex + 1}/{questions.length} · {answeredSlotsCount}/{totalSlotsCount} answered
            </div>

            <button
              type="button"
              onClick={() => handleToggleFlag(currentQuestion.questionId)}
              aria-pressed={isFlagged}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] border text-xs font-semibold cursor-pointer whitespace-nowrap transition-colors ${
                isFlagged
                  ? 'border-[var(--status-warn)] bg-[var(--status-warn-bg)] text-[var(--status-warn)]'
                  : 'border-[var(--border-hairline)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              <Flag className="w-3.5 h-3.5" />
              <span>{isFlagged ? 'Flagged' : 'Flag'}</span>
            </button>

            <button
              type="button"
              onClick={() => setNavOpen((v) => !v)}
              aria-expanded={navOpen}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-elevated)] hover:bg-[var(--bg-surface)] text-xs font-semibold text-[var(--text-primary)] cursor-pointer whitespace-nowrap"
            >
              <Grid className="w-3.5 h-3.5" />
              <span>Navigator</span>
              <ChevronDown className="w-3.5 h-3.5" />
            </button>

            {session.mode === 'admin_calibration' && isAdmin && activeInspectorQ && (
              <button
                type="button"
                onClick={() => setInspectorOpen((v) => !v)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] border text-xs font-semibold cursor-pointer whitespace-nowrap ${
                  inspectorOpen
                    ? 'border-[var(--accent-primary)] bg-[var(--accent-soft)] text-[var(--accent-primary)]'
                    : 'border-[var(--border-strong)] bg-[var(--bg-elevated)] text-[var(--text-primary)]'
                }`}
              >
                <ShieldAlert className="w-3.5 h-3.5" />
                <span>Inspector</span>
              </button>
            )}

            <button
              type="button"
              disabled={submitting}
              onClick={handleSubmit}
              className="px-4 py-1.5 rounded-[var(--radius-sm)] bg-[var(--accent-primary)] hover:bg-[var(--accent-primary-hover)] text-white text-xs font-semibold cursor-pointer whitespace-nowrap disabled:opacity-60"
            >
              {submitting ? 'Submitting...' : 'Finish & Submit'}
            </button>
          </div>
        </div>

        {/* Collapsible Question Navigator Grid */}
        {navOpen && (
          <div className="border-t border-[var(--border-hairline)] bg-[var(--bg-surface)] px-6 py-4">
            <div className="max-w-[1440px] mx-auto space-y-3">
              <div className="flex items-center justify-between text-xs text-[var(--text-secondary)]">
                <span>Jump to any question ({questions.length} items)</span>
                <span>Current · Answered · Flagged</span>
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
                      className={`w-10 h-10 rounded-[var(--radius-sm)] border text-xs font-bold tabular-nums relative cursor-pointer transition-colors ${
                        isCurr
                          ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)] text-white'
                          : isQAnswered
                            ? 'border-[var(--status-success)] bg-[var(--status-success-bg)] text-[var(--status-success)]'
                            : 'border-[var(--border-strong)] bg-[var(--bg-elevated)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                      }`}
                    >
                      {idx + 1}
                      {isQFlagged && (
                        <span
                          aria-label="Flagged"
                          className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-[var(--status-warn)] border border-white"
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
        <div className="border-b border-[var(--status-warn)]/40 bg-[var(--status-warn-bg)] px-6 py-2.5">
          <div className="max-w-[1440px] mx-auto flex flex-wrap items-center justify-between gap-3 text-xs text-[var(--status-warn)]">
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
                  flushCheckpoint();
                }}
                className="px-3 py-1 rounded-[var(--radius-sm)] bg-[var(--text-primary)] text-white font-semibold cursor-pointer"
              >
                Restore &amp; Save Draft
              </button>
              <button
                type="button"
                onClick={() => {
                  clearLocalDraft(draftStorageKey);
                  setRecoverableDraft(null);
                  setSaveStatus('saved');
                }}
                className="px-3 py-1 rounded-[var(--radius-sm)] border border-[var(--status-warn)] font-semibold cursor-pointer"
              >
                Discard Unsent Draft
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Optimistic Concurrency Conflict Resolution Banner (409) */}
      {conflictState && (
        <div role="alert" className="border-b border-[var(--status-error)]/40 bg-[var(--status-error-bg)] px-6 py-2.5">
          <div className="max-w-[1440px] mx-auto flex flex-wrap items-center justify-between gap-3 text-xs text-[var(--status-error)]">
            <span>
              Checkpoint conflict detected (another device saved revision v{conflictState.currentRevision}).
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  checkpointRevisionRef.current = conflictState.currentRevision;
                  applyCheckpointToState(conflictState.serverCheckpoint, questions.length);
                  clearLocalDraft(draftStorageKey);
                  dirtyRef.current = false;
                  setConflictState(null);
                  setSaveStatus('saved');
                }}
                className="px-3 py-1 rounded-[var(--radius-sm)] bg-[var(--text-primary)] text-white font-semibold cursor-pointer"
              >
                Load Server State
              </button>
              <button
                type="button"
                onClick={() => {
                  checkpointRevisionRef.current = conflictState.currentRevision;
                  flushCheckpoint(conflictState.currentRevision);
                }}
                className="px-3 py-1 rounded-[var(--radius-sm)] border border-[var(--status-error)] font-semibold cursor-pointer"
              >
                Overwrite With Local Draft
              </button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div role="alert" className="max-w-[1440px] mx-auto w-full px-6 pt-4">
          <div className="p-3 rounded-[var(--radius-sm)] bg-[var(--status-error-bg)] text-[var(--status-error)] text-xs font-medium">
            {error}
          </div>
        </div>
      )}

      {/* Admin Inspector Panel (if active in calibration mode) */}
      {session.mode === 'admin_calibration' && isAdmin && inspectorOpen && activeInspectorQ && (
        <div className="border-b border-[var(--border-strong)] bg-[var(--bg-surface)] px-6 py-4">
          <div className="max-w-[1440px] mx-auto flex flex-col lg:flex-row lg:items-center justify-between gap-4 text-xs">
            <div className="space-y-1">
              <div className="font-bold text-[var(--text-primary)] tabular-nums">
                Admin Inspector · {activeInspectorQ.questionId} · Pool: {activeInspectorQ.poolType} · QC:{' '}
                {activeInspectorQ.qcStatus}
                {activeInspectorQ.provenance.sourceReference
                  ? ` · ${activeInspectorQ.provenance.sourceReference}`
                  : ''}
              </div>
              <div className="text-[var(--text-secondary)]">
                {activeInspectorQ.parts.map((p, idx) => (
                  <span key={p.partId} className="mr-4">
                    {activeInspectorQ.parts.length > 1 ? `P${idx + 1}: ` : ''}
                    <strong>Key: {p.correctAnswerKey || 'Writing'}</strong> · Diff:{' '}
                    {p.difficultyInitial} · {SKILL_NAME_MAP.get(p.skillId) || p.skillId}
                  </span>
                ))}
              </div>
              {activeInspectorQ.parts[0]?.workedExplanation && (
                <div className="text-[var(--text-secondary)]">
                  Explanation: {activeInspectorQ.parts[0].workedExplanation}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => handleInspectorQcChange(activeInspectorQ.questionId, 'active')}
                className={`px-3 py-1.5 rounded-[var(--radius-sm)] border text-xs font-semibold cursor-pointer ${
                  activeInspectorQ.qcStatus === 'active'
                    ? 'border-[var(--status-success)] bg-[var(--status-success-bg)] text-[var(--status-success)]'
                    : 'border-[var(--border-strong)] bg-[var(--bg-elevated)]'
                }`}
              >
                Mark Active
              </button>
              <button
                type="button"
                onClick={() => handleInspectorQcChange(activeInspectorQ.questionId, 'quarantined')}
                className={`px-3 py-1.5 rounded-[var(--radius-sm)] border text-xs font-semibold cursor-pointer ${
                  activeInspectorQ.qcStatus === 'quarantined'
                    ? 'border-[var(--status-error)] bg-[var(--status-error-bg)] text-[var(--status-error)]'
                    : 'border-[var(--border-strong)] bg-[var(--bg-elevated)]'
                }`}
              >
                Quarantine
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Shared Janison QuestionWorkspace in 'exam' mode */}
      <QuestionWorkspace
        mode="exam"
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
          <div className="pt-4 border-t border-[var(--border-hairline)] flex items-center justify-between gap-3">
            <button
              type="button"
              disabled={currentIndex === 0}
              onClick={() => handleGoIndex(currentIndex - 1)}
              className="px-4 py-2 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-elevated)] hover:bg-[var(--bg-surface)] text-sm font-medium text-[var(--text-primary)] inline-flex items-center gap-1.5 disabled:opacity-40 cursor-pointer"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Previous</span>
            </button>

            <div className="flex items-center gap-2">
              {currentIndex < questions.length - 1 ? (
                <button
                  type="button"
                  onClick={() => handleGoIndex(currentIndex + 1)}
                  className="px-5 py-2 rounded-[var(--radius-sm)] bg-[var(--text-primary)] hover:opacity-90 text-white text-sm font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <span>Next</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              ) : (
                <button
                  type="button"
                  disabled={submitting}
                  onClick={handleSubmit}
                  className="px-5 py-2 rounded-[var(--radius-sm)] bg-[var(--accent-primary)] hover:bg-[var(--accent-primary-hover)] text-white text-sm font-semibold cursor-pointer disabled:opacity-60"
                >
                  {submitting ? 'Submitting...' : 'Finish & Submit'}
                </button>
              )}
            </div>
          </div>
        }
      />
    </div>
  );
}
