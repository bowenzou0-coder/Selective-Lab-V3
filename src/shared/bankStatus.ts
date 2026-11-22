import type {
  QuestionItem,
  QuestionMasteryEvidence,
  QuestionMemoryState,
  QcStatus,
  SectionCode,
} from './contracts';

/**
 * Simplified 3-state operational pool status for the unified Question Bank.
 * Keeps full compatibility with the underlying 5-state QcStatus stored in Firestore.
 */
export type BankPoolStatus = 'live' | 'paused' | 'archived';

export type QuestionCompletionStatus = 'unseen' | 'needs_repair' | 'in_review' | 'done';

export interface QuestionProgressMeta {
  completionStatus: QuestionCompletionStatus;
  attemptsCount: number;
  cleanPassesCount: number;
  lastAttemptAtIso?: string;
  nextEligibleAtIso?: string;
}

export interface BatchDirectorySummary {
  batchId: string;
  batchLabel: string;
  createdAtIso: string;
  importedBy: string;
  total: number;
  live: number;
  unseen: number;
  done: number;
  paused: number;
  archived: number;
  questionIds: string[];
}

export interface PoolHealthSummary {
  totalLatest: number;
  liveCount: number;
  pausedCount: number;
  archivedCount: number;
  holdoutCount: number;
  unseenLiveCount: number;
  inReviewLiveCount: number;
  needsRepairLiveCount: number;
  doneLiveCount: number;
  unseenLivePercent: number;
  estimatedRunwayDays: number;
  refreshUrgency: 'healthy' | 'top_up_soon' | 'refresh_needed';
  refreshAdvice: string;
  bySectionLive: Record<SectionCode, { live: number; unseen: number; done: number }>;
}

export function qcStatusToPoolStatus(qcStatus: QcStatus): BankPoolStatus {
  if (qcStatus === 'active') return 'live';
  if (qcStatus === 'retired') return 'archived';
  return 'paused';
}

export function poolStatusToQcStatus(status: BankPoolStatus): QcStatus {
  if (status === 'live') return 'active';
  if (status === 'archived') return 'retired';
  return 'quarantined';
}

export function getPoolStatusLabel(status: BankPoolStatus): string {
  if (status === 'live') return 'In pool';
  if (status === 'paused') return 'Paused';
  return 'Archived';
}

export function getCompletionStatusLabel(status: QuestionCompletionStatus): string {
  if (status === 'unseen') return 'Unseen';
  if (status === 'needs_repair') return 'Needs repair';
  if (status === 'in_review') return 'In review';
  return 'Done';
}

/** The question fields progress/pool helpers read; full QuestionItems and metadata rows both fit. */
export type ProgressQuestionRef = Pick<QuestionItem, 'questionFamilyId' | 'evidenceRevision'>;
export type PoolQuestionRef = ProgressQuestionRef & Pick<QuestionItem, 'qcStatus' | 'poolType' | 'section'>;

// Evidence keys are `${questionFamilyId}__${evidenceRevision}` and revisions (`er_<digest>`) never
// contain "__", so the family is everything before the last separator. Indexing once per map turns
// the per-question prefix scan (O(questions × evidence)) into a lookup.
const evidenceByFamilyCache = new WeakMap<object, Map<string, QuestionMasteryEvidence>>();

function evidenceByFamily(evidenceMap: Record<string, QuestionMasteryEvidence>): Map<string, QuestionMasteryEvidence> {
  let index = evidenceByFamilyCache.get(evidenceMap);
  if (!index) {
    index = new Map();
    for (const [key, ev] of Object.entries(evidenceMap)) {
      const sep = key.lastIndexOf('__');
      if (sep <= 0) continue;
      const family = key.slice(0, sep);
      if (!index.has(family)) index.set(family, ev);
    }
    evidenceByFamilyCache.set(evidenceMap, index);
  }
  return index;
}

export function findEvidenceForQuestion(
  q: ProgressQuestionRef,
  evidenceMap: Record<string, QuestionMasteryEvidence>
): QuestionMasteryEvidence | undefined {
  if (q.evidenceRevision) {
    const exact = evidenceMap[`${q.questionFamilyId}__${q.evidenceRevision}`];
    if (exact) return exact;
  }
  return evidenceByFamily(evidenceMap).get(q.questionFamilyId);
}

export function deriveQuestionProgressMeta(
  q: ProgressQuestionRef,
  evidenceMap: Record<string, QuestionMasteryEvidence>,
  questionMemory: Record<string, QuestionMemoryState>
): QuestionProgressMeta {
  const ev = findEvidenceForQuestion(q, evidenceMap);
  const mem = questionMemory[q.questionFamilyId];

  if (ev) {
    let completionStatus: QuestionCompletionStatus = 'unseen';
    if (ev.status === 'retained') completionStatus = 'done';
    else if (ev.status === 'needs_repair') completionStatus = 'needs_repair';
    else if (ev.status === 'correct_once' || ev.status === 'awaiting_review') {
      completionStatus = 'in_review';
    }
    return {
      completionStatus,
      attemptsCount: ev.attemptsCount,
      cleanPassesCount: ev.cleanPassesCount,
      lastAttemptAtIso: ev.lastAttemptAtIso || mem?.lastSeenAt,
      nextEligibleAtIso: ev.nextEligibleAtIso || mem?.nextDueAt,
    };
  }

  if (mem && mem.timesSeen > 0) {
    return {
      completionStatus: mem.lastAllCorrect ? 'in_review' : 'needs_repair',
      attemptsCount: mem.timesSeen,
      cleanPassesCount: mem.lastAllCorrect ? 1 : 0,
      lastAttemptAtIso: mem.lastSeenAt,
      nextEligibleAtIso: mem.nextDueAt,
    };
  }

  return {
    completionStatus: 'unseen',
    attemptsCount: 0,
    cleanPassesCount: 0,
  };
}

export function computePoolHealth(input: {
  questions: readonly PoolQuestionRef[];
  evidenceMap: Record<string, QuestionMasteryEvidence>;
  questionMemory: Record<string, QuestionMemoryState>;
  dailyQuestionTarget?: number;
}): PoolHealthSummary {
  const dailyTarget = Math.max(1, input.dailyQuestionTarget ?? 10);
  let liveCount = 0;
  let pausedCount = 0;
  let archivedCount = 0;
  let holdoutCount = 0;
  let unseenLiveCount = 0;
  let inReviewLiveCount = 0;
  let needsRepairLiveCount = 0;
  let doneLiveCount = 0;

  const bySectionLive: Record<SectionCode, { live: number; unseen: number; done: number }> = {
    READ: { live: 0, unseen: 0, done: 0 },
    MATH: { live: 0, unseen: 0, done: 0 },
    THINK: { live: 0, unseen: 0, done: 0 },
    WRIT: { live: 0, unseen: 0, done: 0 },
  };

  for (const q of input.questions) {
    const poolStatus = qcStatusToPoolStatus(q.qcStatus);
    if (poolStatus === 'paused') {
      pausedCount++;
      continue;
    }
    if (poolStatus === 'archived') {
      archivedCount++;
      continue;
    }
    if (q.poolType === 'benchmark_holdout') {
      holdoutCount++;
      continue;
    }
    liveCount++;
    bySectionLive[q.section].live++;
    const meta = deriveQuestionProgressMeta(q, input.evidenceMap, input.questionMemory);
    if (meta.completionStatus === 'unseen') {
      unseenLiveCount++;
      bySectionLive[q.section].unseen++;
    } else if (meta.completionStatus === 'done') {
      doneLiveCount++;
      bySectionLive[q.section].done++;
    } else if (meta.completionStatus === 'needs_repair') {
      needsRepairLiveCount++;
    } else {
      inReviewLiveCount++;
    }
  }

  const unseenLivePercent = liveCount > 0 ? Math.round((unseenLiveCount / liveCount) * 100) : 0;
  // Assume ~60% of each daily session draws unseen items (rest are spaced reviews/repairs)
  const dailyNewBurn = Math.max(1, Math.round(dailyTarget * 0.6));
  const estimatedRunwayDays = Math.floor(unseenLiveCount / dailyNewBurn);

  let refreshUrgency: PoolHealthSummary['refreshUrgency'] = 'healthy';
  let refreshAdvice = `Plenty of fresh material (${estimatedRunwayDays} days of unseen runway). Import a fresh batch once unseen stock drops below 30%.`;

  if (liveCount === 0 || estimatedRunwayDays < 4 || unseenLivePercent < 15) {
    refreshUrgency = 'refresh_needed';
    refreshAdvice = `Unseen stock is low (${unseenLiveCount} fresh items, ~${estimatedRunwayDays} days left). Generate and import 30–50 new questions to keep practice fresh.`;
  } else if (estimatedRunwayDays < 10 || unseenLivePercent < 30) {
    refreshUrgency = 'top_up_soon';
    refreshAdvice = `About ${estimatedRunwayDays} days of unseen questions remain (${unseenLivePercent}% fresh). Queue a fresh batch this week.`;
  }

  return {
    totalLatest: input.questions.length,
    liveCount,
    pausedCount,
    archivedCount,
    holdoutCount,
    unseenLiveCount,
    inReviewLiveCount,
    needsRepairLiveCount,
    doneLiveCount,
    unseenLivePercent,
    estimatedRunwayDays,
    refreshUrgency,
    refreshAdvice,
    bySectionLive,
  };
}
