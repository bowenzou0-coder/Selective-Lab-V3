import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { api } from '../../api';
import { useI18n } from '../../i18n';
import type { WritingReviewEntry } from './reviewUtils';

const PENDING_EVAL_TTL_MS = 90_000;

interface PendingEvalMarker {
  prevEvalCount: number;
  startedAt: number;
}

function pendingEvalStorageKey(submissionId: string): string {
  return `sl_writing_eval_pending:${submissionId}`;
}

function readPendingEval(submissionId: string): PendingEvalMarker | null {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return null;
    const raw = window.sessionStorage.getItem(pendingEvalStorageKey(submissionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingEvalMarker>;
    if (
      typeof parsed.prevEvalCount !== 'number' ||
      typeof parsed.startedAt !== 'number' ||
      Date.now() - parsed.startedAt > PENDING_EVAL_TTL_MS
    ) {
      window.sessionStorage.removeItem(pendingEvalStorageKey(submissionId));
      return null;
    }
    return { prevEvalCount: parsed.prevEvalCount, startedAt: parsed.startedAt };
  } catch {
    return null;
  }
}

function writePendingEval(submissionId: string, prevEvalCount: number): void {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return;
    window.sessionStorage.setItem(
      pendingEvalStorageKey(submissionId),
      JSON.stringify({ prevEvalCount, startedAt: Date.now() })
    );
  } catch {
    // ignore storage quota errors
  }
}

function clearPendingEval(submissionId: string): void {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return;
    window.sessionStorage.removeItem(pendingEvalStorageKey(submissionId));
  } catch {
    // ignore
  }
}

interface UseWritingEvaluationArgs {
  sessionId: string;
  writingReview: WritingReviewEntry[];
  setWritingReview: Dispatch<SetStateAction<WritingReviewEntry[]>>;
  /** Called after a fresh evaluation lands (e.g. to clear selected annotations). */
  onEvaluated?: () => void;
}

/**
 * Writing rubric marking: on-demand evaluation plus reload-resilient recovery (polls an
 * in-flight server run, or resumes once if the previous request was aborted by a reload).
 */
export function useWritingEvaluation({
  sessionId,
  writingReview,
  setWritingReview,
  onEvaluated,
}: UseWritingEvaluationArgs) {
  const { isZh } = useI18n();
  const [evaluatingId, setEvaluatingId] = useState<string | null>(null);
  const [evalError, setEvalError] = useState('');

  const resumedIdsRef = useRef<Set<string>>(new Set());
  const writingReviewRef = useRef(writingReview);
  writingReviewRef.current = writingReview;
  const onEvaluatedRef = useRef(onEvaluated);
  onEvaluatedRef.current = onEvaluated;

  const handleEvaluateWriting = async (submissionId: string) => {
    const currentWr = writingReviewRef.current.find((w) => w.submissionId === submissionId);
    const prevEvalCount = currentWr?.evaluations.length ?? 0;
    writePendingEval(submissionId, prevEvalCount);
    setEvaluatingId(submissionId);
    setEvalError('');
    try {
      const res = await api.evaluateWriting(submissionId);
      clearPendingEval(submissionId);
      setWritingReview((prev) =>
        prev.map((w) =>
          w.submissionId === submissionId
            ? {
                ...w,
                evaluatingInProgress: false,
                evaluations: res.evaluations?.length
                  ? res.evaluations
                  : [res.evaluation, ...w.evaluations],
              }
            : w
        )
      );
      onEvaluatedRef.current?.();
    } catch (err) {
      clearPendingEval(submissionId);
      setEvalError(
        err instanceof Error ? err.message : isZh ? '无法完成写作批改。' : 'Unable to evaluate writing.'
      );
    } finally {
      setEvaluatingId((curr) => (curr === submissionId ? null : curr));
    }
  };

  // Reload-resilient evaluation recovery: poll in-flight server run or resume if aborted
  useEffect(() => {
    const activeTarget = writingReview.find((wr) => {
      const pending = readPendingEval(wr.submissionId);
      if (pending && wr.evaluations.length > pending.prevEvalCount) {
        clearPendingEval(wr.submissionId);
        return false;
      }
      return Boolean(wr.evaluatingInProgress || pending);
    });
    if (!activeTarget) return;
    if (evaluatingId === activeTarget.submissionId) return;

    const targetId = activeTarget.submissionId;
    const pending = readPendingEval(targetId);
    const prevEvalCount = pending?.prevEvalCount ?? activeTarget.evaluations.length;
    let cancelled = false;
    let pollCount = 0;
    let timerId: number | undefined;

    setEvaluatingId(targetId);

    const pollSession = async () => {
      if (cancelled) return;
      pollCount++;
      try {
        const refreshed = await api.getSession(sessionId);
        if (cancelled) return;
        const wr2 = refreshed.writingReview?.find((w) => w.submissionId === targetId);
        if (wr2 && wr2.evaluations.length > prevEvalCount) {
          clearPendingEval(targetId);
          setWritingReview(refreshed.writingReview || []);
          setEvaluatingId(null);
          return;
        }
        if (!wr2?.evaluatingInProgress && pollCount >= 2) {
          if (resumedIdsRef.current.has(targetId)) {
            clearPendingEval(targetId);
            setEvaluatingId(null);
            return;
          }
          resumedIdsRef.current.add(targetId);
          void handleEvaluateWriting(targetId);
          return;
        }
      } catch {
        // retry on transient poll error
      }
      if (!cancelled && pollCount < 20) {
        timerId = window.setTimeout(() => {
          void pollSession();
        }, 2500);
      } else if (!cancelled) {
        clearPendingEval(targetId);
        setEvaluatingId(null);
      }
    };

    timerId = window.setTimeout(() => {
      void pollSession();
    }, 1500);

    return () => {
      cancelled = true;
      if (timerId !== undefined) window.clearTimeout(timerId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, writingReview]);

  return { evaluatingId, evalError, evaluateWriting: handleEvaluateWriting };
}
