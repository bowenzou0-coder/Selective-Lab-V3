// "Practise my mistakes" planning shared by Progress and the post-submission review.

import type { MarkingResult } from '../../../shared/contracts';

export const REPAIR_DRILL_CAP = 20;

interface ReviewedQuestion {
  questionId: string;
  formatType: string;
}

/** Objective questions in a reviewed session with any wrong or unanswered part, in session order. */
export function collectMissedObjectiveQuestionIds(
  questions: readonly ReviewedQuestion[],
  reviewResults: Record<string, readonly MarkingResult[]>
): string[] {
  const out: string[] = [];
  for (const q of questions) {
    if (q.formatType === 'WRIT_TYPED_TASK') continue;
    const res = reviewResults[q.questionId] || [];
    if (res.some((r) => !r.isCorrect || r.selectedAnswer === null)) out.push(q.questionId);
  }
  return out;
}

export type ReviewRepairPlan =
  | { kind: 'session'; questionIds: string[]; count: number }
  | { kind: 'pool' }
  | null;

/**
 * What the review screen's repair button should drill. Benchmark questions stay sealed, so a
 * benchmark review drills the learner's wider repair pool instead (and says so).
 */
export function planReviewRepairDrill(input: { sessionMode?: string; missedQuestionIds: readonly string[] }): ReviewRepairPlan {
  if (input.missedQuestionIds.length === 0) return null;
  if (input.sessionMode === 'benchmark_exam' || input.sessionMode === 'admin_calibration') {
    return input.sessionMode === 'benchmark_exam' ? { kind: 'pool' } : null;
  }
  return {
    kind: 'session',
    questionIds: [...input.missedQuestionIds],
    count: Math.min(REPAIR_DRILL_CAP, input.missedQuestionIds.length),
  };
}

/** Payload for `api.createSession`. */
export function repairDrillPayload(plan: Exclude<ReviewRepairPlan, null> | { kind: 'pool' }) {
  return plan.kind === 'session'
    ? { mode: 'repair_drill' as const, questionIds: plan.questionIds }
    : { mode: 'repair_drill' as const };
}
