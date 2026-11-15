import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  Flag,
  Grid,
  ShieldAlert,
  X,
} from 'lucide-react';
import { api, type SessionDetailResponse } from '../api';
import type {
  MarkingResult,
  QuestionItem,
  SessionRecord,
  StudentQuestionView,
} from '../../shared/contracts';
import { SKILLS_TAXONOMY } from '../../shared/skills';
import { PostSubmissionReview } from './PostSubmissionReview';
import { ReadingRightAnswerPane, ReadingStimulusPane } from './ReadingRenderers';
import { VisualRenderer } from './VisualRenderer';
import { WritingAnswerPane, WritingStimulusPane } from './WritingEditor';

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

const SECTION_LABELS: Record<string, string> = {
  READ: 'Reading',
  MATH: 'Mathematical Reasoning',
  THINK: 'Thinking Skills',
  WRIT: 'Writing',
};

const FORMAT_LABELS: Record<string, string> = {
  READ_FICTION_MCQ: 'Literary Comprehension',
  READ_VOCAB_CLOZE: 'Vocabulary Cloze',
  READ_POETRY_MCQ: 'Poetry Analysis',
  READ_GAPPED_TEXT: 'Gapped Text',
  READ_MULTIPLE_MATCH: 'Multiple Matching',
  MATH_MCQ_5: '5-Option MCQ',
  THINK_MCQ_4: '4-Option MCQ',
  WRIT_TYPED_TASK: 'Typed Response',
};

interface SessionPlayerViewProps {
  sessionId: string;
  isAdmin: boolean;
  onNavigate: (path: string) => void;
  onActiveSessionCleared?: () => void;
}

export function SessionPlayerView({
  sessionId,
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

  // UI toggles
  const [timerHidden, setTimerHidden] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [activeGapIndex, setActiveGapIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [saveStateLabel, setSaveStateLabel] = useState('');
  const autoSubmittedRef = useRef(false);

  // Submission Review
  const [reviewResults, setReviewResults] = useState<Record<string, MarkingResult[]> | undefined>();
  const [writingReview, setWritingReview] = useState<SessionDetailResponse['writingReview']>();

  // Admin Calibration Inspector (strictly admin-only)
  const [inspectorMap, setInspectorMap] = useState<Record<string, QuestionItem>>({});
  const [inspectorOpen, setInspectorOpen] = useState(false);

  const dirtyRef = useRef(false);
  const checkpointRef = useRef<NonNullable<SessionRecord['checkpoint']>>({
    currentIndex: 0,
    elapsedSec: 0,
    answersByPartId: {},
    flaggedQuestionIds: [],
    eliminatedOptionsByPartId: {},
    passageHighlightsByStimulusId: {},
    writingDraft: { planNotes: '', responseText: '' },
  });

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

  // Load session
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    api
      .getSession(sessionId)
      .then(async (res) => {
        if (!active) return;
        setSession(res.session);
        setQuestions(res.questions);
        const cp = res.session.checkpoint;
        if (cp) {
          setCurrentIndex(Math.min(cp.currentIndex || 0, Math.max(0, res.questions.length - 1)));
          setElapsedSec(cp.elapsedSec || 0);
          setAnswersByPartId(cp.answersByPartId || {});
          setFlaggedQuestionIds(cp.flaggedQuestionIds || []);
          setEliminatedByPartId(cp.eliminatedOptionsByPartId || {});
          setHighlightsByStimulusId(cp.passageHighlightsByStimulusId || {});
          setWritingDraft(cp.writingDraft || { planNotes: '', responseText: '' });
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
            // ignore if not admin
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
  }, [sessionId, isAdmin]);

  const flushCheckpoint = useCallback(async () => {
    if (!session || session.status !== 'in_progress') return;
    try {
      await api.saveCheckpoint(session.sessionId, checkpointRef.current);
      dirtyRef.current = false;
      setSaveStateLabel('Saved');
    } catch {
      // silent retry on next tick
    }
  }, [session]);

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

  const handleSelectAnswer = useCallback((partId: string, key: string | null) => {
    dirtyRef.current = true;
    setSaveStateLabel('Saving...');
    setAnswersByPartId((prev) => ({ ...prev, [partId]: key }));
  }, []);

  const handleToggleEliminate = useCallback((partId: string, key: string) => {
    dirtyRef.current = true;
    setEliminatedByPartId((prev) => {
      const list = prev[partId] || [];
      const next = list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
      return { ...prev, [partId]: next };
    });
  }, []);

  const handleToggleFlag = useCallback((questionId: string) => {
    dirtyRef.current = true;
    setFlaggedQuestionIds((prev) =>
      prev.includes(questionId) ? prev.filter((id) => id !== questionId) : [...prev, questionId]
    );
  }, []);

  const handleGoIndex = useCallback(
    (nextIdx: number) => {
      const bounded = Math.max(0, Math.min(questions.length - 1, nextIdx));
      dirtyRef.current = true;
      setCurrentIndex(bounded);
      setActiveGapIndex(0);
      setNavOpen(false);
    },
    [questions.length]
  );

  // Keyboard shortcuts (1-5 / A-E, N / P, F)
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

  // Warn on tab close/refresh while locked into a student test
  useEffect(() => {
    if (!isLockedStudentSession) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isLockedStudentSession]);

  const handleSubmit = useCallback(async () => {
    if (!session || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await api.submitSession(session.sessionId, checkpointRef.current);
      setSession((prev) =>
        prev
          ? {
              ...prev,
              status: 'submitted',
              correctSlots: res.correctSlots,
              totalSlots: res.totalSlots,
              completedAt: new Date().toISOString(),
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
  }, [session, submitting, onActiveSessionCleared]);

  // Auto-submit when a timed locked student session hits 00:00
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

  const isReading = currentQuestion.section === 'READ';
  const isWriting = currentQuestion.formatType === 'WRIT_TYPED_TASK';
  const activePart = currentQuestion.parts[0];

  return (
    <div className="min-h-screen lg:h-screen lg:overflow-hidden flex flex-col bg-[var(--bg-canvas)]">
      {/* Janison-Style Minimalist Exam Top Bar with Large Centered Timer */}
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
              <div className="text-xs text-[var(--text-muted)] truncate">
                {isLockedStudentSession ? 'Locked exam session' : 'Calibration workspace'} · {saveStateLabel || 'Autosave active'}
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
            {/* Slot Progress Counter */}
            <div className="text-xs font-medium text-[var(--text-secondary)] tabular-nums whitespace-nowrap">
              Q {currentIndex + 1}/{questions.length} · {answeredSlotsCount}/{totalSlotsCount} answered
            </div>

            {/* Flag Button */}
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

            {/* Question Navigator Toggle */}
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

            {/* Admin Inspector Toggle (strictly in admin calibration mode) */}
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
                Admin Inspector · {activeInspectorQ.questionId} · Pool: {activeInspectorQ.poolType} · QC: {activeInspectorQ.qcStatus}
                {activeInspectorQ.provenance.sourceReference ? ` · ${activeInspectorQ.provenance.sourceReference}` : ''}
              </div>
              <div className="text-[var(--text-secondary)]">
                {activeInspectorQ.parts.map((p, idx) => (
                  <span key={p.partId} className="mr-4">
                    {activeInspectorQ.parts.length > 1 ? `P${idx + 1}: ` : ''}
                    <strong>Key: {p.correctAnswerKey || 'Writing'}</strong> · Diff: {p.difficultyInitial} ·{' '}
                    {SKILL_NAME_MAP.get(p.skillId) || p.skillId}
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

      {/* Janison-Style Left/Right Split Exam Workspace */}
      <main className="flex-1 min-h-0 max-w-[1440px] w-full mx-auto grid grid-cols-1 lg:grid-cols-12 items-stretch">
        {/* LEFT PANE: Stimulus / Passage / Problem Stem / Diagram */}
        <section
          aria-label="Question stimulus and problem context"
          className={`${
            isReading ? 'lg:col-span-7' : 'lg:col-span-6'
          } p-6 lg:p-8 border-b lg:border-b-0 lg:border-r border-[var(--border-hairline)] bg-[var(--bg-elevated)] lg:h-full lg:overflow-y-auto`}
        >
          <div className="text-xs font-medium text-[var(--text-muted)] mb-3 tabular-nums">
            {SECTION_LABELS[currentQuestion.section] || currentQuestion.section} ·{' '}
            {FORMAT_LABELS[currentQuestion.formatType] || currentQuestion.formatType.replace(/_/g, ' ')}
          </div>

          {isReading && (
            <ReadingStimulusPane
              question={currentQuestion}
              answersByPartId={answersByPartId}
              onSelectAnswer={handleSelectAnswer}
              activeGapIndex={activeGapIndex}
              onSelectGapIndex={setActiveGapIndex}
              highlights={highlightsByStimulusId[currentStimId] || []}
              onAddHighlight={(text) => {
                dirtyRef.current = true;
                setHighlightsByStimulusId((prev) => ({
                  ...prev,
                  [currentStimId]: Array.from(new Set([...(prev[currentStimId] || []), text])),
                }));
              }}
              onClearHighlights={() => {
                dirtyRef.current = true;
                setHighlightsByStimulusId((prev) => ({ ...prev, [currentStimId]: [] }));
              }}
            />
          )}

          {isWriting && <WritingStimulusPane question={currentQuestion} />}

          {!isReading && !isWriting && (
            <div className="space-y-5">
              {currentQuestion.stemPrefix && (
                <p className="text-base text-[var(--text-primary)] leading-relaxed bg-[var(--bg-surface)] p-4 rounded-[var(--radius-md)] border border-[var(--border-hairline)]">
                  {currentQuestion.stemPrefix}
                </p>
              )}
              {activePart && (
                <div className="text-base font-medium text-[var(--text-primary)] leading-relaxed">
                  {activePart.promptText}
                </div>
              )}
              <VisualRenderer visual={currentQuestion.visual} />
            </div>
          )}
        </section>

        {/* RIGHT PANE: Interactive Answers */}
        <section
          aria-label="Answer selection panel"
          className={`${
            isReading ? 'lg:col-span-5' : 'lg:col-span-6'
          } p-6 lg:p-8 bg-[var(--bg-canvas)] flex flex-col justify-between gap-6 lg:h-full lg:overflow-y-auto`}
        >
          <div className="space-y-5">
            {isReading && (
              <ReadingRightAnswerPane
                question={currentQuestion}
                answersByPartId={answersByPartId}
                eliminatedByPartId={eliminatedByPartId}
                onSelectAnswer={handleSelectAnswer}
                onToggleEliminate={handleToggleEliminate}
                activeGapIndex={activeGapIndex}
                onSelectGapIndex={setActiveGapIndex}
              />
            )}

            {isWriting && (
              <WritingAnswerPane
                question={currentQuestion}
                planNotes={writingDraft.planNotes}
                responseText={writingDraft.responseText}
                onChangePlan={(val) => {
                  dirtyRef.current = true;
                  setSaveStateLabel('Saving...');
                  setWritingDraft((prev) => ({ ...prev, planNotes: val }));
                }}
                onChangeResponse={(val) => {
                  dirtyRef.current = true;
                  setSaveStateLabel('Saving...');
                  setWritingDraft((prev) => ({ ...prev, responseText: val }));
                }}
              />
            )}

            {!isReading && !isWriting && activePart && (
              <div className="space-y-4">
                <div className="flex items-center justify-between text-xs text-[var(--text-secondary)]">
                  <span>
                    Select one answer ({activePart.options[0]?.key}–
                    {activePart.options[activePart.options.length - 1]?.key})
                  </span>
                  <span>Shortcuts: 1–{activePart.options.length} · N/P · F</span>
                </div>

                <div className="space-y-2.5">
                  {activePart.options.map((opt) => {
                    const picked = answersByPartId[activePart.partId] === opt.key;
                    const elim = (eliminatedByPartId[activePart.partId] || []).includes(opt.key);

                    return (
                      <div key={opt.key} className="flex items-stretch gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            handleSelectAnswer(activePart.partId, picked ? null : opt.key)
                          }
                          className={`flex-1 text-left p-4 rounded-[var(--radius-md)] border transition-colors flex items-center gap-3.5 cursor-pointer ${
                            picked
                              ? 'border-[var(--accent-primary)] bg-[var(--accent-soft)]'
                              : elim
                                ? 'border-[var(--border-hairline)] bg-[var(--bg-surface)] opacity-55'
                                : 'border-[var(--border-hairline)] bg-[var(--bg-elevated)] hover:border-[var(--border-strong)]'
                          }`}
                        >
                          <span
                            className={`w-7 h-7 rounded-full border text-xs font-bold flex items-center justify-center shrink-0 ${
                              picked
                                ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)] text-white'
                                : 'border-[var(--border-strong)] text-[var(--text-secondary)]'
                            }`}
                          >
                            {picked ? <Check className="w-3.5 h-3.5" /> : opt.key}
                          </span>
                          <div className="flex-1 min-w-0 space-y-2">
                            {opt.text && (
                              <div
                                className={`text-sm font-medium text-[var(--text-primary)] ${
                                  elim ? 'line-through' : ''
                                }`}
                              >
                                {opt.text}
                              </div>
                            )}
                            {opt.visual && <VisualRenderer visual={opt.visual} compact />}
                          </div>
                        </button>
                        <button
                          type="button"
                          aria-label={`Eliminate option ${opt.key}`}
                          title="Cross out distractor"
                          onClick={() => handleToggleEliminate(activePart.partId, opt.key)}
                          className={`px-2.5 rounded-[var(--radius-md)] border cursor-pointer transition-colors ${
                            elim
                              ? 'border-[var(--border-strong)] bg-[var(--bg-hover)] text-[var(--text-primary)]'
                              : 'border-[var(--border-hairline)] bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                          }`}
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Bottom Navigation Bar */}
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
        </section>
      </main>
    </div>
  );
}
