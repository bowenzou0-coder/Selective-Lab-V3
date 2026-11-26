// Writing Sprint helpers: word-range progress, calm pacing and essay-to-essay comparison.
// Pure functions so the editor and Progress view stay thin and the maths stays tested.

import {
  getWritingCriterionMaxMarks,
  WRITING_MAX_TOTAL_MARKS,
  type WritingBandLetter,
  type WritingEvaluationRecord,
} from '../../../shared/contracts';

export interface WordRange {
  min: number;
  max: number;
  /** True when the prompt gave no usable range and the default was used. */
  isFallback: boolean;
}

export const DEFAULT_WORD_RANGE: Readonly<[number, number]> = [250, 350];

function toPositiveInt(raw: unknown): number | null {
  const n = typeof raw === 'string' ? Number(raw.replace(/[^\d.]/g, '')) : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/**
 * Reads `recommendedWordRange` in any shape seen in the bank: `[250, 350]`, `{ min, max }`,
 * `"250-350"`, `"250–350 words"` or a single number (treated as the minimum).
 */
export function resolveWordRange(raw: unknown): WordRange {
  let min: number | null = null;
  let max: number | null = null;
  if (Array.isArray(raw)) {
    min = toPositiveInt(raw[0]);
    max = toPositiveInt(raw[1]);
  } else if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    min = toPositiveInt(obj.min ?? obj.minWords ?? obj.from);
    max = toPositiveInt(obj.max ?? obj.maxWords ?? obj.to);
  } else if (typeof raw === 'string') {
    const nums = raw.match(/\d+/g)?.map(Number) ?? [];
    min = nums[0] && nums[0] > 0 ? nums[0] : null;
    max = nums[1] && nums[1] > 0 ? nums[1] : null;
  } else if (typeof raw === 'number') {
    min = toPositiveInt(raw);
  }

  if (min !== null && max === null) max = Math.round(min * 1.4);
  if (min === null && max !== null) min = Math.round(max * 0.7);
  if (min === null || max === null) {
    return { min: DEFAULT_WORD_RANGE[0], max: DEFAULT_WORD_RANGE[1], isFallback: true };
  }
  if (min > max) [min, max] = [max, min];
  return { min, max, isFallback: false };
}

export type WordRangeState = 'empty' | 'building' | 'in_target' | 'over';

export interface WordRangeProgress {
  state: WordRangeState;
  /** Bar fill, 0–100, on a scale that runs a little past the maximum. */
  fillPct: number;
  /** Positions (0–100) of the target band's edges on the same scale. */
  minPct: number;
  maxPct: number;
  /** Words still needed to reach the minimum (0 once reached). */
  wordsToMin: number;
  /** Words beyond the maximum (0 while inside). */
  wordsOver: number;
}

/** How far the draft sits against the target band, on a scale reaching 20% past the maximum. */
export function wordRangeProgress(wordCount: number, range: Pick<WordRange, 'min' | 'max'>): WordRangeProgress {
  const count = Math.max(0, Math.floor(wordCount || 0));
  const scaleMax = Math.max(1, Math.round(range.max * 1.2));
  const pct = (n: number) => Math.min(100, Math.max(0, (n / scaleMax) * 100));
  const state: WordRangeState =
    count === 0 ? 'empty' : count < range.min ? 'building' : count <= range.max ? 'in_target' : 'over';
  return {
    state,
    fillPct: pct(count),
    minPct: pct(range.min),
    maxPct: pct(range.max),
    wordsToMin: Math.max(0, range.min - count),
    wordsOver: Math.max(0, count - range.max),
  };
}

export type PacingPhase = 'planning' | 'drafting' | 'reviewing' | 'untimed';
export type PacingTone = 'steady' | 'building' | 'ahead';

export interface WritingPacing {
  phase: PacingPhase;
  tone: PacingTone;
  /** Share of the time used, 0–1 (0 when untimed). */
  timeUsed: number;
}

/** First 15% of the time is for planning, the last 10% for rereading. */
export const PLANNING_SHARE = 0.15;
export const REVIEW_SHARE = 0.1;

/**
 * A calm read of pace: compares words written with the words a steady writer would have by now
 * (reaching the minimum just as review time starts). It never reports "behind"; slower drafts
 * read as "building".
 */
export function writingPacing(input: {
  elapsedSec: number;
  totalSec: number | null | undefined;
  wordCount: number;
  range: Pick<WordRange, 'min' | 'max'>;
}): WritingPacing {
  const total = input.totalSec && input.totalSec > 0 ? input.totalSec : 0;
  if (!total) return { phase: 'untimed', tone: 'steady', timeUsed: 0 };
  const timeUsed = Math.min(1, Math.max(0, input.elapsedSec / total));
  const draftWindow = 1 - PLANNING_SHARE - REVIEW_SHARE;
  const draftProgress = Math.min(1, Math.max(0, (timeUsed - PLANNING_SHARE) / draftWindow));
  const expected = input.range.min * draftProgress;
  const words = Math.max(0, input.wordCount);

  const phase: PacingPhase =
    timeUsed < PLANNING_SHARE ? 'planning' : timeUsed >= 1 - REVIEW_SHARE ? 'reviewing' : 'drafting';
  let tone: PacingTone = 'steady';
  if (phase === 'drafting') {
    if (words >= input.range.min || words > expected * 1.25 + 20) tone = 'ahead';
    else if (words < expected * 0.75) tone = 'building';
  } else if (phase === 'reviewing') {
    tone = words >= input.range.min ? 'steady' : 'building';
  }
  return { phase, tone, timeUsed };
}

export function countParagraphs(text: string): number {
  const clean = text.trim();
  return clean ? clean.split(/\n\s*\n+/).filter((p) => p.trim().length > 0).length : 0;
}

// ---------------------------------------------------------------------------
// Essay comparison
// ---------------------------------------------------------------------------

export interface ComparableEssay {
  submissionId: string;
  submittedAt: string;
  wordCount: number;
  responseText: string;
  evaluations: WritingEvaluationRecord[];
  promptTitle?: string;
  questionId?: string;
}

export interface EssayScore {
  band: WritingBandLetter;
  marks: number;
  maxMarks: number;
  criteria: Record<string, { score: number; max: number }>;
}

function legacyEstimateToBand(est: WritingEvaluationRecord['overallBandEstimate']): WritingBandLetter {
  if (est === 'top_band') return 'A';
  if (est === 'strong') return 'B';
  if (est === 'solid') return 'C';
  return 'D';
}

/** Latest evaluation as band, total and per-criterion marks; `null` when not marked yet. */
export function essayScore(essay: Pick<ComparableEssay, 'evaluations'>): EssayScore | null {
  const latest = essay.evaluations[0];
  if (!latest) return null;
  const criteria: EssayScore['criteria'] = {};
  for (const c of latest.criteriaScores) {
    criteria[c.criterionSkillId] = {
      score: c.score,
      max: c.maxMarks ?? getWritingCriterionMaxMarks(c.criterionSkillId),
    };
  }
  return {
    band: latest.overallBand ?? legacyEstimateToBand(latest.overallBandEstimate),
    marks: latest.totalMarks ?? latest.criteriaScores.reduce((sum, c) => sum + Math.round(c.score), 0),
    maxMarks: latest.maxTotalMarks ?? WRITING_MAX_TOTAL_MARKS,
    criteria,
  };
}

export interface EssayComparison<T extends ComparableEssay = ComparableEssay> {
  current: T;
  previous: T;
  wordDelta: number;
  currentScore: EssayScore | null;
  previousScore: EssayScore | null;
  /** Total-mark change; `null` unless both essays are marked. */
  marksDelta: number | null;
  /** Per-criterion rows for every criterion either essay was marked on. */
  criteria: { skillId: string; current: number | null; previous: number | null; max: number; delta: number | null }[];
}

/** Newest first, ties broken by id so the order is stable. */
export function sortEssaysNewestFirst<T extends ComparableEssay>(essays: readonly T[]): T[] {
  return [...essays].sort(
    (a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt) || b.submissionId.localeCompare(a.submissionId)
  );
}

/** Pairs an essay with the one written just before it; defaults to the newest essay. */
export function pickComparisonPair<T extends ComparableEssay>(
  essays: readonly T[],
  currentId?: string
): { current: T; previous: T } | null {
  const ordered = sortEssaysNewestFirst(essays);
  if (ordered.length < 2) return null;
  let idx = currentId ? ordered.findIndex((e) => e.submissionId === currentId) : 0;
  if (idx < 0 || idx >= ordered.length - 1) idx = 0;
  return { current: ordered[idx], previous: ordered[idx + 1] };
}

export function compareEssays<T extends ComparableEssay>(current: T, previous: T): EssayComparison<T> {
  const currentScore = essayScore(current);
  const previousScore = essayScore(previous);
  const skillIds = Array.from(
    new Set([...Object.keys(currentScore?.criteria ?? {}), ...Object.keys(previousScore?.criteria ?? {})])
  );
  const criteria = skillIds.map((skillId) => {
    const cur = currentScore?.criteria[skillId];
    const prev = previousScore?.criteria[skillId];
    return {
      skillId,
      current: cur ? cur.score : null,
      previous: prev ? prev.score : null,
      max: cur?.max ?? prev?.max ?? getWritingCriterionMaxMarks(skillId),
      delta: cur && prev ? cur.score - prev.score : null,
    };
  });
  return {
    current,
    previous,
    wordDelta: current.wordCount - previous.wordCount,
    currentScore,
    previousScore,
    marksDelta: currentScore && previousScore ? currentScore.marks - previousScore.marks : null,
    criteria,
  };
}

/** `+12`, `−3` (true minus) or `0`. */
export function formatSignedDelta(delta: number): string {
  if (delta > 0) return `+${delta}`;
  if (delta < 0) return `−${Math.abs(delta)}`;
  return '0';
}
