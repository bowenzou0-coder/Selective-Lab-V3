import { findEvidenceByFamily } from './bankStatus.ts';
import type {
  AlgorithmAdjustments,
  DifficultyPreset,
  LearningConfig,
  MarkingResult,
  MasteryCertificationStatus,
  PoolType,
  QuestionFormatType,
  QuestionItem,
  QuestionMasteryEvidence,
  QuestionMemoryState,
  SectionCode,
  SessionMode,
  SkillState,
  StimulusGroup,
  StudentQuestionView,
  WritingDeterministicMetrics,
  WritingTaskSpec,
} from './contracts.ts';

/** Benchmark-isolated pools (never mixed into everyday practice, daily plans, or fresh-pool mocks). */
export function isBenchmarkPoolType(poolType: PoolType): boolean {
  return poolType === 'benchmark_holdout' || poolType === 'official_calibration';
}

/** Everyday practice pool (strictly isolated from official calibration and holdout benchmarks). */
export function isEverydayPracticePoolType(poolType: PoolType): boolean {
  return poolType === 'practice';
}

/**
 * Blended difficulty split across the practice pool:
 * - Lower band: d <= 4.35 (d4.0–4.3, ~1.2x)
 * - Upper band: d > 4.35 (d4.4–5.0, ~1.5x)
 */
export const DIFFICULTY_BLEND_LOW_CEILING = 4.35;

export const DIFFICULTY_LOW_SHARE: Record<DifficultyPreset, number> = {
  easy: 0.8,
  medium: 0.5,
  hard: 0.2,
};

const READ_FORMAT_ORDER: Partial<Record<QuestionFormatType, number>> = {
  READ_FICTION_MCQ: 0,
  READ_VOCAB_CLOZE: 1,
  READ_POETRY_MCQ: 2,
  READ_GAPPED_TEXT: 3,
  READ_MULTIPLE_MATCH: 4,
};

function compareExamQuestions(a: SelectionQuestion, b: SelectionQuestion): number {
  const sectionOrder: Record<SectionCode, number> = { READ: 0, MATH: 1, THINK: 2, WRIT: 3 };
  const secDiff = sectionOrder[a.section] - sectionOrder[b.section];
  if (secDiff !== 0) return secDiff;
  if (a.section === 'READ' && b.section === 'READ') {
    const fmtDiff = (READ_FORMAT_ORDER[a.formatType] ?? 99) - (READ_FORMAT_ORDER[b.formatType] ?? 99);
    if (fmtDiff !== 0) return fmtDiff;
  }
  return a.questionId.localeCompare(b.questionId, undefined, { numeric: true });
}

export function questionAvgDifficulty(q: Pick<SelectionQuestion, 'parts'>): number {
  if (!q.parts || q.parts.length === 0) return 4.2;
  const sum = q.parts.reduce((acc, p) => acc + (p.difficultyCalibrated ?? p.difficultyInitial), 0);
  return Number((sum / q.parts.length).toFixed(2));
}

export function shuffleSeeded<T>(items: readonly T[], seed: number): T[] {
  const arr = [...items];
  let s = (seed >>> 0) || 1;
  for (let i = arr.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

export function clampAlgorithmAdjustments(
  raw?: AlgorithmAdjustments
): Required<AlgorithmAdjustments> {
  const clampMult = (v: unknown, def = 1): number => {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return def;
    return Number(Math.min(1.35, Math.max(0.75, n)).toFixed(2));
  };
  const clampOffset = (v: unknown): number => {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return 0;
    return Number(Math.min(0.75, Math.max(-0.75, n)).toFixed(2));
  };
  return {
    spacedReviewWeightMultiplier: clampMult(raw?.spacedReviewWeightMultiplier, 1),
    weakestSkillWeightMultiplier: clampMult(raw?.weakestSkillWeightMultiplier, 1),
    noveltyCoverageWeightMultiplier: clampMult(raw?.noveltyCoverageWeightMultiplier, 1),
    zpdDifficultyOffset: clampOffset(raw?.zpdDifficultyOffset),
  };
}

export function toStudentQuestionView(
  q: QuestionItem,
  stimulus?: StimulusGroup,
  includeReviewFields = false
): StudentQuestionView {
  return {
    questionId: q.questionId,
    section: q.section,
    formatType: q.formatType,
    stemPrefix: q.stemPrefix,
    visual: q.visual,
    sharedPoolConfig: q.sharedPoolConfig,
    writingSpec: q.writingSpec,
    stimulus: stimulus
      ? {
          ...stimulus,
          extracts: includeReviewFields
            ? stimulus.extracts
            : stimulus.extracts?.map(({ isDecoy: _hidden, ...pub }) => pub),
        }
      : undefined,
    parts: q.parts.map(
      ({
        correctAnswerKey: _k,
        workedExplanation: _e,
        distractorRationales: _d,
        evidenceRefs: _ev,
        ...pub
      }) => pub
    ),
  };
}

export function gradeSubmission(
  question: QuestionItem,
  answersByPartId: Record<string, string | null>
): { results: MarkingResult[]; validationErrors: string[] } {
  const validationErrors: string[] = [];

  if (question.sharedPoolConfig && !question.sharedPoolConfig.reuseAllowed) {
    const seen = new Set<string>();
    for (const part of question.parts) {
      const pick = answersByPartId[part.partId];
      if (pick) {
        if (seen.has(pick)) {
          validationErrors.push(`Extract ${pick} cannot be assigned to more than one gap.`);
        }
        seen.add(pick);
      }
    }
  }

  const results: MarkingResult[] = question.parts.map((part) => {
    const selected = answersByPartId[part.partId] ?? null;
    const isCorrect = selected !== null && selected === part.correctAnswerKey;
    return {
      partId: part.partId,
      isCorrect,
      selectedAnswer: selected,
      correctAnswerKey: part.correctAnswerKey,
      workedExplanation: part.workedExplanation,
      distractorRationale:
        !isCorrect && selected && part.distractorRationales
          ? part.distractorRationales[selected]
          : undefined,
      evidenceRefs: part.evidenceRefs,
    };
  });

  return { results, validationErrors };
}

export function computeWritingMetrics(
  spec: WritingTaskSpec,
  responseText: string
): WritingDeterministicMetrics {
  const clean = responseText.trim();
  const words = clean ? clean.split(/\s+/) : [];
  const paragraphs = clean ? clean.split(/\n\s*\n+/).filter(Boolean) : [];
  const sentences = clean ? clean.split(/[.!?]+/).filter((s) => s.trim().length > 0) : [];
  const uniqueWords = new Set(
    words.map((w) => w.toLowerCase().replace(/[^a-z0-9']/g, '')).filter(Boolean)
  );
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const starterPrefix = spec.mandatoryOpeningLine
    ? norm(spec.mandatoryOpeningLine).replace(/(?:\.{3}|…)+$/g, '').trim()
    : '';
  const matchedMandatoryStarter = starterPrefix
    ? norm(clean).startsWith(starterPrefix)
    : true;

  return {
    wordCount: words.length,
    paragraphCount: paragraphs.length,
    sentenceCount: sentences.length,
    avgWordsPerSentence: sentences.length ? Number((words.length / sentences.length).toFixed(1)) : 0,
    typeTokenRatio: words.length ? Number((uniqueWords.size / words.length).toFixed(2)) : 0,
    matchedMandatoryStarter,
  };
}

export function updateSkillState(input: {
  prevSkillState?: SkillState;
  skillId: string;
  isCorrect: boolean;
  timeSpentSec: number;
  targetTimeSec: number;
  config: LearningConfig;
  nowIso: string;
}): SkillState {
  const { prevSkillState, skillId, isCorrect, timeSpentSec, targetTimeSec, config, nowIso } = input;
  const nowMs = Date.parse(nowIso);
  const alpha = 0.25;
  const prevScore = prevSkillState?.masteryScore ?? 0.5;
  const timeRatio = Math.min(2.5, Math.max(0.25, timeSpentSec / Math.max(1, targetTimeSec)));
  const speedBonus = isCorrect && timeRatio <= 1.0 ? 0.03 : 0;
  const nextScore = Math.min(
    0.99,
    Math.max(0.05, prevScore * (1 - alpha) + (isCorrect ? 1 : 0) * alpha + speedBonus)
  );

  const prevEase = prevSkillState?.easeFactor ?? 2.5;
  const prevInterval =
    prevSkillState?.reviewIntervalDays ?? config.scheduling.sm2InitialIntervalDays;
  const nextInterval = isCorrect
    ? Math.max(1, Math.round(prevInterval * prevEase))
    : config.scheduling.lapseIntervalResetDays;
  const nextEase = Math.max(
    config.scheduling.sm2EaseFloor,
    prevEase + (isCorrect ? 0.1 : -0.25)
  );

  return {
    skillId,
    masteryScore: Number(nextScore.toFixed(3)),
    uncertainty: Number(Math.max(0.1, (prevSkillState?.uncertainty ?? 0.45) * 0.92).toFixed(3)),
    attemptsCount: (prevSkillState?.attemptsCount ?? 0) + 1,
    correctCount: (prevSkillState?.correctCount ?? 0) + (isCorrect ? 1 : 0),
    ewmaAccuracy: Number(
      ((prevSkillState?.ewmaAccuracy ?? 0.5) * (1 - alpha) + (isCorrect ? 1 : 0) * alpha).toFixed(3)
    ),
    avgTimeRatio: Number(((prevSkillState?.avgTimeRatio ?? 1.0) * 0.8 + timeRatio * 0.2).toFixed(2)),
    lastPracticedAt: nowIso,
    nextReviewAt: new Date(nowMs + nextInterval * 86_400_000).toISOString(),
    reviewIntervalDays: nextInterval,
    easeFactor: Number(nextEase.toFixed(2)),
    plateauStatus: prevSkillState?.plateauStatus ?? 'none',
  };
}

/**
 * Updates family-level SM-2 spaced repetition state strictly once per question encounter
 * (never inflated per-part on multi-part reading stimuli).
 */
export function updateFamilyMemoryOnce(input: {
  prevMemory?: QuestionMemoryState;
  questionFamilyId: string;
  allPartsCorrect: boolean;
  config: LearningConfig;
  nowIso: string;
  lastEvidenceStatus?: MasteryCertificationStatus;
}): QuestionMemoryState {
  const { prevMemory, questionFamilyId, allPartsCorrect, config, nowIso, lastEvidenceStatus } = input;
  const nowMs = Date.parse(nowIso);
  const initialDays = Math.max(1, config.scheduling.sm2InitialIntervalDays ?? 1);
  const easeFloor = config.scheduling.sm2EaseFloor ?? 1.3;
  const lapseResetDays = Math.max(1, config.scheduling.lapseIntervalResetDays ?? 1);
  const prevEase = prevMemory?.easeFactor ?? 2.5;
  const prevInterval = prevMemory?.intervalDays ?? initialDays;

  const nextEase = Number(
    Math.max(easeFloor, Math.min(3.0, prevEase + (allPartsCorrect ? 0.1 : -0.25))).toFixed(2)
  );
  const memInterval = allPartsCorrect
    ? prevMemory
      ? Math.min(60, Math.max(1, Math.round(prevInterval * prevEase)))
      : initialDays
    : lapseResetDays;

  return {
    questionFamilyId,
    timesSeen: (prevMemory?.timesSeen ?? 0) + 1,
    lastSeenAt: nowIso,
    lastAllCorrect: allPartsCorrect,
    intervalDays: memInterval,
    easeFactor: nextEase,
    lapseCount: (prevMemory?.lapseCount ?? 0) + (allPartsCorrect ? 0 : 1),
    lastEvidenceStatus: lastEvidenceStatus ?? prevMemory?.lastEvidenceStatus,
    nextDueAt: new Date(nowMs + memInterval * 86_400_000).toISOString(),
  };
}

// Backwards-compatible wrapper for existing callers/tests; callers updating multiple parts
// for the same question should call updateSkillState per part + updateFamilyMemoryOnce once per question.
export function updateSkillAndMemory(input: {
  prevSkillState?: SkillState;
  prevMemory?: QuestionMemoryState;
  skillId: string;
  questionFamilyId: string;
  isCorrect: boolean;
  allPartsCorrect: boolean;
  timeSpentSec: number;
  targetTimeSec: number;
  config: LearningConfig;
  nowIso: string;
}): { nextSkillState: SkillState; nextMemory: QuestionMemoryState } {
  return {
    nextSkillState: updateSkillState(input),
    nextMemory: updateFamilyMemoryOnce(input),
  };
}

function seededNoise(seed: number, key: string): number {
  let h = seed >>> 0;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619) >>> 0;
  return (h % 1000) / 10000;
}

/** Structural minimum needed by selection, scheduling, and batch tagging. */
export type SelectionQuestion = Pick<
  QuestionItem,
  | 'questionId'
  | 'questionFamilyId'
  | 'version'
  | 'section'
  | 'formatType'
  | 'poolType'
  | 'qcStatus'
  | 'stimulusId'
  | 'batchId'
  | 'batchLabel'
  | 'evidenceRevision'
> & {
  provenance: Partial<Pick<QuestionItem['provenance'], 'sourceType' | 'sourceReference'>>;
  parts: ReadonlyArray<{
    partId?: string;
    skillId: string;
    secondarySkillIds?: string[];
    difficultyInitial: number;
    difficultyCalibrated?: number;
    targetTimeSec?: number;
  }>;
};

function findFamilyEvidence(
  q: Pick<SelectionQuestion, 'questionFamilyId' | 'evidenceRevision'>,
  evidenceMap?: Record<string, QuestionMasteryEvidence>
): QuestionMasteryEvidence | undefined {
  if (!evidenceMap) return undefined;
  if (q.evidenceRevision) {
    // Exact revision match: never let an older revision's retained status retire a revised question
    return evidenceMap[`${q.questionFamilyId}__${q.evidenceRevision}`];
  }
  return findEvidenceByFamily(q.questionFamilyId, evidenceMap);
}

function pickWithDiversity<Q extends SelectionQuestion, T extends { q: Q; priority: number }>(
  candidates: T[],
  limit: number
): T[] {
  if (limit <= 0 || candidates.length === 0) return [];
  const remaining = [...candidates];
  const selected: T[] = [];
  const skillCounts = new Map<string, number>();
  const familyCounts = new Map<string, number>();

  while (selected.length < limit && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const item = remaining[i];
      const primarySkill = item.q.parts[0]?.skillId || '';
      const skCount = skillCounts.get(primarySkill) ?? 0;
      const famCount = familyCounts.get(item.q.questionFamilyId) ?? 0;
      const effective = item.priority - skCount * 0.65 - famCount * 2.0;
      if (effective > bestScore) {
        bestScore = effective;
        bestIdx = i;
      }
    }
    const [chosen] = remaining.splice(bestIdx, 1);
    selected.push(chosen);
    const primarySkill = chosen.q.parts[0]?.skillId || '';
    if (primarySkill) {
      skillCounts.set(primarySkill, (skillCounts.get(primarySkill) ?? 0) + 1);
    }
    familyCounts.set(
      chosen.q.questionFamilyId,
      (familyCounts.get(chosen.q.questionFamilyId) ?? 0) + 1
    );
  }
  return selected;
}

export interface PracticeSelectionInput<T extends SelectionQuestion = QuestionItem> {
  mode: SessionMode;
  sectionFilter?: SectionCode;
  difficulty?: DifficultyPreset;
  questions: T[];
  skillStates: Record<string, SkillState>;
  questionMemory: Record<string, QuestionMemoryState>;
  evidenceMap?: Record<string, QuestionMasteryEvidence>;
  skillFocusWeights?: Record<string, number>;
  algorithmAdjustments?: AlgorithmAdjustments;
  dailyLimitsOverride?: Record<SectionCode, number>;
  questionCountOverride?: number;
  config: LearningConfig;
  nowIso: string;
  seed: number;
}

export interface PracticeCandidateInfo<T extends SelectionQuestion = QuestionItem> {
  q: T;
  priority: number;
  isDue: boolean;
  isConfirmationDue: boolean;
  isNeedsRepair: boolean;
  isOnCooldown: boolean;
  meanSkillMastery: number;
  avgDifficulty: number;
}

function pickBlendedWithDiversity<
  Q extends SelectionQuestion,
  T extends { q: Q; priority: number; avgDifficulty: number },
>(candidates: T[], limit: number, difficulty: DifficultyPreset, seed: number): T[] {
  if (limit <= 0 || candidates.length === 0) return [];
  const lowBand = candidates.filter((c) => c.avgDifficulty <= DIFFICULTY_BLEND_LOW_CEILING);
  const highBand = candidates.filter((c) => c.avgDifficulty > DIFFICULTY_BLEND_LOW_CEILING);
  const lowTarget = Math.round(limit * DIFFICULTY_LOW_SHARE[difficulty]);
  const highTarget = Math.max(0, limit - lowTarget);

  const lowPicked = pickWithDiversity(lowBand, lowTarget);
  const highPicked = pickWithDiversity(highBand, highTarget);
  const chosen: T[] = [...lowPicked, ...highPicked];

  if (chosen.length < limit) {
    const chosenIds = new Set(chosen.map((c) => c.q.questionId));
    const chosenFamilies = new Set(chosen.map((c) => c.q.questionFamilyId));
    const remaining = candidates.filter(
      (c) => !chosenIds.has(c.q.questionId) && !chosenFamilies.has(c.q.questionFamilyId)
    );
    chosen.push(...pickWithDiversity(remaining, limit - chosen.length));
  }

  return shuffleSeeded(chosen, seed ^ 0x9e3779b9);
}

function shuffleReadingPassageBlocks<Q extends SelectionQuestion, T extends { q: Q }>(
  items: T[],
  seed: number
): T[] {
  const blocks: T[][] = [];
  for (const item of items) {
    const prev = blocks[blocks.length - 1];
    if (prev && item.q.stimulusId && prev[0]?.q.stimulusId === item.q.stimulusId) {
      prev.push(item);
    } else {
      blocks.push([item]);
    }
  }
  return shuffleSeeded(blocks, seed ^ 0x85ebca6b).flat();
}

function pickReadingBlendedCohesive<
  Q extends SelectionQuestion,
  T extends { q: Q; priority: number; avgDifficulty: number },
>(candidates: T[], limit: number, difficulty: DifficultyPreset, seed: number): T[] {
  if (limit <= 0 || candidates.length === 0) return [];

  // Classify each passage group (stimulusId) by its mean difficulty so passages stay whole.
  const stimDiffSums = new Map<string, { sum: number; count: number }>();
  for (const c of candidates) {
    const key = c.q.stimulusId ? `stim::${c.q.stimulusId}` : `solo::${c.q.questionId}`;
    const cur = stimDiffSums.get(key) || { sum: 0, count: 0 };
    cur.sum += c.avgDifficulty;
    cur.count += 1;
    stimDiffSums.set(key, cur);
  }

  const isLowGroup = (c: T): boolean => {
    const key = c.q.stimulusId ? `stim::${c.q.stimulusId}` : `solo::${c.q.questionId}`;
    const agg = stimDiffSums.get(key);
    const mean = agg && agg.count > 0 ? agg.sum / agg.count : c.avgDifficulty;
    return mean <= DIFFICULTY_BLEND_LOW_CEILING;
  };

  const lowBand = candidates.filter(isLowGroup);
  const highBand = candidates.filter((c) => !isLowGroup(c));
  const lowTarget = Math.round(limit * DIFFICULTY_LOW_SHARE[difficulty]);
  const highTarget = Math.max(0, limit - lowTarget);

  const lowPicked = lowTarget > 0 ? pickReadingCohesive(lowBand, lowTarget) : [];
  const highPicked = highTarget > 0 ? pickReadingCohesive(highBand, highTarget) : [];
  const chosen: T[] = [...lowPicked, ...highPicked];

  if (chosen.length < limit) {
    const chosenIds = new Set(chosen.map((c) => c.q.questionId));
    const chosenFamilies = new Set(chosen.map((c) => c.q.questionFamilyId));
    const remaining = candidates.filter(
      (c) => !chosenIds.has(c.q.questionId) && !chosenFamilies.has(c.q.questionFamilyId)
    );
    chosen.push(...pickReadingCohesive(remaining, limit - chosen.length));
  }

  return shuffleReadingPassageBlocks(chosen, seed);
}

function scorePracticeCandidates<T extends SelectionQuestion = QuestionItem>(input: PracticeSelectionInput<T>): {
  scored: PracticeCandidateInfo<T>[];
  sectionLimit?: number;
  effectiveCaps?: Record<SectionCode, number>;
} {
  const {
    mode,
    sectionFilter,
    difficulty,
    questions,
    skillStates,
    questionMemory,
    evidenceMap,
    skillFocusWeights,
    algorithmAdjustments,
    dailyLimitsOverride,
    questionCountOverride,
    config,
    nowIso,
    seed,
  } = input;
  const nowMs = Date.parse(nowIso);
  const cooldownMs = config.scheduling.minRepeatCooldownHours * 3_600_000;
  const adj = clampAlgorithmAdjustments(algorithmAdjustments);
  const effectiveSpacedWeight = config.scheduling.spacedReviewWeight * adj.spacedReviewWeightMultiplier;
  const effectiveWeakestWeight = config.scheduling.weakestSkillWeight * adj.weakestSkillWeightMultiplier;
  const effectiveNoveltyWeight = config.scheduling.noveltyCoverageWeight * adj.noveltyCoverageWeightMultiplier;
  const autoRetireMastered = Boolean(config.poolPolicy?.autoRetireMastered);

  const hasOfficialCalibration =
    mode === 'diagnostic' &&
    questions.some(
      (q) =>
        q.qcStatus === 'active' &&
        q.poolType === 'official_calibration' &&
        (!sectionFilter || q.section === sectionFilter)
    );

  // HARD INVARIANT:
  // - benchmark_holdout & official_calibration NEVER leak into everyday practice/drills/daily plans
  // - diagnostic (Starter Calibration) draws from official_calibration (falling back to practice if absent)
  // - benchmark_exam draws from benchmark_holdout or official_calibration
  const eligible = questions.filter((q) => {
    if (q.qcStatus !== 'active') return false;
    if (mode === 'benchmark_exam') return isBenchmarkPoolType(q.poolType);
    if (mode === 'diagnostic') {
      if (hasOfficialCalibration) {
        if (q.poolType !== 'official_calibration') return false;
      } else if (q.poolType !== 'practice') {
        return false;
      }
    } else if (!isEverydayPracticePoolType(q.poolType)) {
      return false;
    }
    if (sectionFilter && q.section !== sectionFilter) return false;
    if (autoRetireMastered && mode !== 'spaced_review') {
      const ev = findFamilyEvidence(q, evidenceMap);
      if (ev?.status === 'retained') return false;
    }
    return true;
  });

  const scored: PracticeCandidateInfo<T>[] = eligible
    .map((q) => {
      const mem = questionMemory[q.questionFamilyId];
      const ev = findFamilyEvidence(q, evidenceMap);
      const isOnCooldown = mem ? nowMs - Date.parse(mem.lastSeenAt) < cooldownMs : false;
      const isDue = mem ? Date.parse(mem.nextDueAt) <= nowMs : false;
      const isConfirmationDue = Boolean(
        ev &&
          (ev.status === 'correct_once' || ev.status === 'awaiting_review') &&
          ev.nextEligibleAtIso &&
          Date.parse(ev.nextEligibleAtIso) <= nowMs
      );
      const isNeedsRepair = ev?.status === 'needs_repair';
      const isRetained = ev?.status === 'retained';
      const isUnseen = !mem && (!ev || ev.status === 'unseen');

      const meanSkillMastery =
        q.parts.reduce((acc, p) => acc + (skillStates[p.skillId]?.masteryScore ?? 0.5), 0) /
        Math.max(1, q.parts.length);
      const meanFocusWeight = skillFocusWeights
        ? q.parts.reduce((acc, p) => {
            const raw = skillFocusWeights[p.skillId];
            const clamped =
              typeof raw === 'number' && Number.isFinite(raw)
                ? Math.min(1.35, Math.max(0.85, raw))
                : 1.0;
            return acc + clamped;
          }, 0) / Math.max(1, q.parts.length)
        : 1.0;
      const avgDifficulty = questionAvgDifficulty(q);
      const targetDiff = 1.5 + meanSkillMastery * 3.0 + adj.zpdDifficultyOffset;
      const zpdPenalty = difficulty ? 0 : Math.abs(avgDifficulty - targetDiff) * 0.25;

      let priority = 0;
      if (isDue) priority += effectiveSpacedWeight;
      if (isConfirmationDue) priority += effectiveSpacedWeight * 1.15;
      if (isNeedsRepair) priority += effectiveWeakestWeight * 1.1;
      if (isUnseen) {
        priority += difficulty ? effectiveNoveltyWeight + 10.0 : effectiveNoveltyWeight;
      }
      if (isRetained && !isDue) priority -= 0.8;
      priority += (1 - meanSkillMastery) * effectiveWeakestWeight;
      priority += (meanFocusWeight - 1.0) * 2.0;
      priority -= zpdPenalty;
      if (isOnCooldown) priority -= 5.0;
      priority += seededNoise(seed, q.questionId);
      return {
        q,
        priority: Number(priority.toFixed(4)),
        isDue,
        isConfirmationDue,
        isNeedsRepair,
        isOnCooldown,
        meanSkillMastery: Number(meanSkillMastery.toFixed(3)),
        avgDifficulty,
      };
    })
    .sort((a, b) => b.priority - a.priority);

  if (sectionFilter) {
    const drillCap =
      typeof questionCountOverride === 'number' && questionCountOverride > 0
        ? Math.round(questionCountOverride)
        : (config.sessionDefaults.sectionDrillQuestionCount ?? 10);
    const sectionLimit = mode === 'benchmark_exam' ? 40 : Math.max(1, drillCap);
    return { scored, sectionLimit };
  }

  const caps = dailyLimitsOverride || config.sessionDefaults.dailyQuestionLimitBySection;
  const totalConfigured = (['READ', 'MATH', 'THINK', 'WRIT'] as SectionCode[]).reduce(
    (sum, sec) => sum + Math.max(0, Number(caps[sec] ?? 0)),
    0
  );
  const effectiveCaps: Record<SectionCode, number> =
    totalConfigured > 0 ? caps : { READ: 2, MATH: 3, THINK: 3, WRIT: 0 };
  return { scored, effectiveCaps };
}

/**
 * Selects Reading questions cohesively by passage (`stimulusId`) so students read
 * 1 passage for a small set (e.g. 4 Qs) or ~2 passages for a larger set (e.g. 10 Qs),
 * rather than reading 4 unrelated texts for 1 question each.
 * Items within each selected passage are ordered naturally by questionId.
 */
export function pickReadingCohesive<
  Q extends SelectionQuestion,
  T extends { q: Q; priority: number },
>(candidates: T[], limit: number): T[] {
  if (limit <= 0 || candidates.length === 0) return [];

  // Deduplicate by questionFamilyId keeping highest-priority item
  const bestByFamily = new Map<string, T>();
  for (const item of candidates) {
    const prev = bestByFamily.get(item.q.questionFamilyId);
    if (!prev || item.priority > prev.priority) {
      bestByFamily.set(item.q.questionFamilyId, item);
    }
  }

  // Group by stimulusId (standalone items without stimulusId stay in 1-item groups)
  const groupsMap = new Map<string, { stimulusId?: string; items: T[] }>();
  for (const item of bestByFamily.values()) {
    const key = item.q.stimulusId ? `stim::${item.q.stimulusId}` : `solo::${item.q.questionId}`;
    const existing = groupsMap.get(key);
    if (existing) {
      existing.items.push(item);
    } else {
      groupsMap.set(key, { stimulusId: item.q.stimulusId, items: [item] });
    }
  }

  const remainingGroups = Array.from(groupsMap.values());
  const selected: T[] = [];

  while (selected.length < limit && remainingGroups.length > 0) {
    const needed = limit - selected.length;
    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < remainingGroups.length; i++) {
      const grp = remainingGroups[i];
      const byPriority = [...grp.items].sort((a, b) => b.priority - a.priority);
      const takeSlice = byPriority.slice(0, needed);
      const avgPrio = takeSlice.reduce((s, it) => s + it.priority, 0) / takeSlice.length;
      const topPrio = takeSlice[0].priority;
      // Prefer cohesive multi-question passages over scattered singletons when we need >= 2 questions
      const multiBonus = grp.stimulusId && grp.items.length >= 2 && needed >= 2 ? 0.85 : 0;
      // Extra nudge when a single passage covers the entire remaining reading quota
      const fullFitBonus = grp.stimulusId && grp.items.length >= needed && needed >= 2 ? 0.45 : 0;
      const score = avgPrio * 0.75 + topPrio * 0.25 + multiBonus + fullFitBonus;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    const [chosenGroup] = remainingGroups.splice(bestIdx, 1);
    const chosenItems =
      chosenGroup.items.length <= needed
        ? [...chosenGroup.items]
        : [...chosenGroup.items].sort((a, b) => b.priority - a.priority).slice(0, needed);

    // Order consecutive questions from the same passage in natural reading order
    chosenItems.sort((a, b) =>
      a.q.questionId.localeCompare(b.q.questionId, undefined, { numeric: true })
    );
    selected.push(...chosenItems);
  }

  return selected;
}

export function selectPracticeCandidates<T extends SelectionQuestion = QuestionItem>(
  input: PracticeSelectionInput<T> & { poolLimit?: number }
): {
  candidates: PracticeCandidateInfo<T>[];
  targetCount: number;
  effectiveCaps?: Record<SectionCode, number>;
} {
  const { scored, sectionLimit, effectiveCaps } = scorePracticeCandidates(input);

  if (sectionLimit !== undefined) {
    const targetCount = Math.min(sectionLimit, scored.length);
    const poolLimit = Math.max(4, input.poolLimit ?? Math.max(24, targetCount * 2));
    const desiredPool = Math.min(scored.length, Math.max(targetCount * 2, poolLimit));
    const candidates =
      input.sectionFilter === 'READ'
        ? pickReadingCohesive<T, PracticeCandidateInfo<T>>(scored, desiredPool)
        : pickWithDiversity<T, PracticeCandidateInfo<T>>(scored, desiredPool);
    return { candidates, targetCount };
  }

  const caps = effectiveCaps || { READ: 10, MATH: 10, THINK: 10, WRIT: 0 };
  const candidates: PracticeCandidateInfo<T>[] = [];
  let targetCount = 0;

  for (const sec of ['READ', 'MATH', 'THINK', 'WRIT'] as SectionCode[]) {
    const cap = Math.max(0, Number(caps[sec] ?? 0));
    if (cap <= 0) continue;
    const secScored = scored.filter((x) => x.q.section === sec);
    targetCount += Math.min(cap, secScored.length);
    const secPoolCap = Math.min(secScored.length, Math.max(cap * 2, Math.min(8, cap + 4)));
    if (sec === 'READ') {
      candidates.push(...pickReadingCohesive<T, PracticeCandidateInfo<T>>(secScored, secPoolCap));
    } else {
      candidates.push(...pickWithDiversity<T, PracticeCandidateInfo<T>>(secScored, secPoolCap));
    }
  }

  const poolLimit = Math.max(targetCount, input.poolLimit ?? Math.max(24, targetCount * 2));
  return {
    candidates: candidates.slice(0, poolLimit),
    targetCount,
    effectiveCaps: caps,
  };
}

export function selectPracticeSession<T extends SelectionQuestion = QuestionItem>(
  input: PracticeSelectionInput<T>
): T[] {
  const { scored, sectionLimit, effectiveCaps } = scorePracticeCandidates(input);

  if (sectionLimit !== undefined) {
    if (input.difficulty && input.sectionFilter !== 'WRIT') {
      if (input.sectionFilter === 'READ') {
        return pickReadingBlendedCohesive<T, PracticeCandidateInfo<T>>(
          scored,
          sectionLimit,
          input.difficulty,
          input.seed
        ).map((item) => item.q);
      }
      return pickBlendedWithDiversity<T, PracticeCandidateInfo<T>>(
        scored,
        sectionLimit,
        input.difficulty,
        input.seed
      ).map((item) => item.q);
    }
    if (input.sectionFilter === 'READ') {
      return pickReadingCohesive<T, PracticeCandidateInfo<T>>(scored, sectionLimit).map((item) => item.q);
    }
    return pickWithDiversity<T, PracticeCandidateInfo<T>>(scored, sectionLimit).map((item) => item.q);
  }

  const caps = effectiveCaps || { READ: 10, MATH: 10, THINK: 10, WRIT: 0 };
  const picked: T[] = [];
  for (const sec of ['READ', 'MATH', 'THINK', 'WRIT'] as SectionCode[]) {
    const cap = Math.max(0, Number(caps[sec] ?? 0));
    if (cap <= 0) continue;
    const secScored = scored.filter((x) => x.q.section === sec);
    if (input.difficulty && sec !== 'WRIT') {
      if (sec === 'READ') {
        picked.push(
          ...pickReadingBlendedCohesive<T, PracticeCandidateInfo<T>>(
            secScored,
            cap,
            input.difficulty,
            input.seed
          ).map((item) => item.q)
        );
      } else {
        picked.push(
          ...pickBlendedWithDiversity<T, PracticeCandidateInfo<T>>(
            secScored,
            cap,
            input.difficulty,
            input.seed
          ).map((item) => item.q)
        );
      }
    } else if (sec === 'READ') {
      picked.push(...pickReadingCohesive<T, PracticeCandidateInfo<T>>(secScored, cap).map((item) => item.q));
    } else {
      picked.push(...pickWithDiversity<T, PracticeCandidateInfo<T>>(secScored, cap).map((item) => item.q));
    }
  }
  return picked;
}

export function detectPlateauStatus(input: {
  recentIsCorrectDesc: boolean[];
  ewmaAccuracy: number;
  config: LearningConfig;
}): 'none' | 'watch' | 'detected' {
  const { recentIsCorrectDesc, ewmaAccuracy, config } = input;
  const { minAttemptsForEvaluation, windowSize, minGainThreshold, stagnantAccuracyCeiling } =
    config.plateauDetection;
  if (recentIsCorrectDesc.length < minAttemptsForEvaluation) return 'none';
  if (ewmaAccuracy > stagnantAccuracyCeiling) return 'none';

  const recentWindow = recentIsCorrectDesc.slice(0, windowSize);
  const olderWindow = recentIsCorrectDesc.slice(windowSize, windowSize * 2);
  if (olderWindow.length < Math.min(3, windowSize)) {
    return ewmaAccuracy <= stagnantAccuracyCeiling ? 'watch' : 'none';
  }
  const recentAcc = recentWindow.filter(Boolean).length / recentWindow.length;
  const olderAcc = olderWindow.filter(Boolean).length / olderWindow.length;
  const gain = recentAcc - olderAcc;
  if (gain < minGainThreshold && recentAcc <= stagnantAccuracyCeiling) return 'detected';
  if (gain < minGainThreshold * 2) return 'watch';
  return 'none';
}

export function getQuestionBatchTag(
  q: Pick<QuestionItem, 'questionId'> & { provenance?: Partial<Pick<QuestionItem['provenance'], 'sourceReference'>> }
): 'PT1' | 'PT2' | 'PT3' | 'SMOKE' | 'CUSTOM' {
  const ref = q.provenance?.sourceReference ?? '';
  if (q.questionId.includes('_pt1_') || ref.includes('PT1')) return 'PT1';
  if (q.questionId.includes('_pt2_') || ref.includes('PT2')) return 'PT2';
  if (q.questionId.includes('_pt3_') || ref.includes('PT3')) return 'PT3';
  if (
    q.questionId.startsWith('q_read_') ||
    q.questionId.startsWith('q_math_') ||
    q.questionId.startsWith('q_think_') ||
    q.questionId.startsWith('q_writ_')
  ) {
    return 'SMOKE';
  }
  return 'CUSTOM';
}

export function selectMockTestQuestions<T extends SelectionQuestion = QuestionItem>(input: {
  batch: 'PT1' | 'PT2' | 'PT3';
  sectionFilter?: SectionCode;
  questions: T[];
  allowHoldout?: boolean;
}): T[] {
  const { batch, sectionFilter, questions, allowHoldout = batch === 'PT3' } = input;
  return questions
    .filter((q) => {
      if (q.qcStatus !== 'active') return false;
      if (!allowHoldout && q.poolType === 'benchmark_holdout') return false;
      if (getQuestionBatchTag(q) !== batch) return false;
      if (sectionFilter && q.section !== sectionFilter) return false;
      return true;
    })
    .sort(compareExamQuestions);
}

export function selectBatchMockQuestions<T extends SelectionQuestion = QuestionItem>(input: {
  batchId: string;
  sectionFilter?: SectionCode;
  questions: T[];
}): T[] {
  const { batchId, sectionFilter, questions } = input;
  return questions
    .filter((q) => {
      if (q.qcStatus !== 'active') return false;
      if (!isEverydayPracticePoolType(q.poolType)) return false;
      if (q.batchId !== batchId) return false;
      if (sectionFilter && q.section !== sectionFilter) return false;
      return true;
    })
    .sort(compareExamQuestions);
}

export function selectBenchmarkHoldoutQuestions<T extends SelectionQuestion = QuestionItem>(input: {
  batchId?: string;
  sectionFilter?: SectionCode;
  questions: T[];
}): T[] {
  const { batchId, sectionFilter, questions } = input;
  const benchmarkItems = questions.filter((q) => {
    if (q.qcStatus !== 'active') return false;
    if (!isBenchmarkPoolType(q.poolType)) return false;
    if (sectionFilter && q.section !== sectionFilter) return false;
    return true;
  });
  if (benchmarkItems.length === 0) return [];

  let scoped = benchmarkItems;
  if (batchId) {
    scoped = benchmarkItems.filter((q) => q.batchId === batchId);
  } else {
    // Prefer benchmark_holdout batches first, then fall back to official_calibration batches.
    const holdoutsOnly = benchmarkItems.filter((q) => q.poolType === 'benchmark_holdout');
    const poolToPick = holdoutsOnly.length > 0 ? holdoutsOnly : benchmarkItems;
    const batchLabels = new Map<string, string>();
    for (const q of poolToPick) {
      if (q.batchId && !batchLabels.has(q.batchId)) {
        batchLabels.set(q.batchId, q.batchLabel || q.batchId);
      }
    }
    if (batchLabels.size > 1) {
      const [chosenBatchId] = Array.from(batchLabels.entries()).sort((a, b) =>
        b[1].localeCompare(a[1])
      )[0];
      scoped = poolToPick.filter((q) => q.batchId === chosenBatchId);
    } else {
      scoped = poolToPick;
    }
  }

  return scoped.sort(compareExamQuestions);
}

export const CANONICAL_POOL_MOCK_COUNTS: Record<SectionCode, number> = {
  READ: 17,
  MATH: 35,
  THINK: 40,
  WRIT: 1,
};

export const MAX_POOL_MOCK_COUNTS: Record<'ALL' | SectionCode, number> = {
  READ: 34,
  MATH: 50,
  THINK: 50,
  WRIT: 1,
  ALL: 93,
};

export const OFFICIAL_SECTION_MINUTES: Record<'ALL' | SectionCode, number> = {
  READ: 45,
  MATH: 40,
  THINK: 40,
  WRIT: 30,
  ALL: 155,
};

/**
 * Allocates a requested total question count across READ / MATH / THINK / WRIT
 * following the canonical NSW Selective 17 : 35 : 40 (+1 Writing) proportions.
 */
export function allocateFullPoolMockCaps(
  totalLimit: number,
  availableBySection?: Partial<Record<SectionCode, number>>
): Record<SectionCode, number> {
  const safeAvail = (sec: SectionCode) =>
    availableBySection?.[sec] !== undefined ? Math.max(0, availableBySection[sec]!) : Number.POSITIVE_INFINITY;

  const clampedTotal = Math.max(1, Math.min(MAX_POOL_MOCK_COUNTS.ALL, Math.round(totalLimit)));
  const canonicalTotal =
    CANONICAL_POOL_MOCK_COUNTS.READ +
    CANONICAL_POOL_MOCK_COUNTS.MATH +
    CANONICAL_POOL_MOCK_COUNTS.THINK +
    CANONICAL_POOL_MOCK_COUNTS.WRIT;

  if (clampedTotal >= canonicalTotal) {
    return {
      READ: Math.min(CANONICAL_POOL_MOCK_COUNTS.READ, safeAvail('READ')),
      MATH: Math.min(CANONICAL_POOL_MOCK_COUNTS.MATH, safeAvail('MATH')),
      THINK: Math.min(CANONICAL_POOL_MOCK_COUNTS.THINK, safeAvail('THINK')),
      WRIT: Math.min(CANONICAL_POOL_MOCK_COUNTS.WRIT, safeAvail('WRIT')),
    };
  }

  const includeWrit = clampedTotal >= 12 && safeAvail('WRIT') > 0;
  const objectiveBudget = Math.max(1, clampedTotal - (includeWrit ? 1 : 0));
  const objTotalCanonical =
    CANONICAL_POOL_MOCK_COUNTS.READ + CANONICAL_POOL_MOCK_COUNTS.MATH + CANONICAL_POOL_MOCK_COUNTS.THINK;
  const objSecs: SectionCode[] = ['READ', 'MATH', 'THINK'];

  const raw = objSecs.map((sec) => {
    const exact = (objectiveBudget * CANONICAL_POOL_MOCK_COUNTS[sec]) / objTotalCanonical;
    const base = Math.min(safeAvail(sec), Math.floor(exact));
    return { sec, base, frac: exact - Math.floor(exact) };
  });

  const caps: Record<SectionCode, number> = {
    READ: raw[0].base,
    MATH: raw[1].base,
    THINK: raw[2].base,
    WRIT: includeWrit ? 1 : 0,
  };

  // Guarantee at least 1 item per available objective section when budget >= 3
  if (objectiveBudget >= 3) {
    for (const sec of objSecs) {
      if (caps[sec] === 0 && safeAvail(sec) > 0) {
        caps[sec] = 1;
      }
    }
  }

  let assigned = caps.READ + caps.MATH + caps.THINK;
  // Distribute remaining slots by largest fractional remainder, respecting availability
  const byRemainder = [...raw].sort((a, b) => b.frac - a.frac);
  while (assigned < objectiveBudget) {
    let added = false;
    for (const entry of byRemainder) {
      if (assigned >= objectiveBudget) break;
      if (caps[entry.sec] < safeAvail(entry.sec)) {
        caps[entry.sec] += 1;
        assigned += 1;
        added = true;
      }
    }
    if (!added) break;
  }
  // Trim if minimum-1 guarantee overshot objectiveBudget
  while (assigned > objectiveBudget) {
    const largest = objSecs.reduce((best, sec) => (caps[sec] > caps[best] ? sec : best), objSecs[0]);
    if (caps[largest] <= 0) break;
    caps[largest] -= 1;
    assigned -= 1;
  }

  return caps;
}

/** Computes official 1.0x pace minutes for a set of per-section item counts. */
export function computeOfficialPaceMinutesFromCounts(counts: Partial<Record<SectionCode, number>>): number {
  const read = Math.max(0, counts.READ ?? 0);
  const math = Math.max(0, counts.MATH ?? 0);
  const think = Math.max(0, counts.THINK ?? 0);
  const writ = Math.max(0, counts.WRIT ?? 0);
  if (read + math + think + writ === 0) return 0;

  if (
    read === CANONICAL_POOL_MOCK_COUNTS.READ &&
    math === CANONICAL_POOL_MOCK_COUNTS.MATH &&
    think === CANONICAL_POOL_MOCK_COUNTS.THINK &&
    writ === CANONICAL_POOL_MOCK_COUNTS.WRIT
  ) {
    return OFFICIAL_SECTION_MINUTES.ALL;
  }

  const exactMinutes =
    (read / CANONICAL_POOL_MOCK_COUNTS.READ) * OFFICIAL_SECTION_MINUTES.READ +
    (math / CANONICAL_POOL_MOCK_COUNTS.MATH) * OFFICIAL_SECTION_MINUTES.MATH +
    (think / CANONICAL_POOL_MOCK_COUNTS.THINK) * OFFICIAL_SECTION_MINUTES.THINK +
    writ * OFFICIAL_SECTION_MINUTES.WRIT;

  const isMultiSection = [read, math, think, writ].filter((n) => n > 0).length > 1;
  const minFloor = writ > 0 && read + math + think === 0 ? OFFICIAL_SECTION_MINUTES.WRIT : isMultiSection ? 10 : 5;
  return Math.max(minFloor, Math.round(exactMinutes));
}

/** Computes official 1.0x pace minutes for a planned pool mock scope & question count. */
export function computePoolMockBaseMinutes(
  scope: 'ALL' | SectionCode,
  questionCount: number,
  availableBySection?: Partial<Record<SectionCode, number>>
): number {
  if (scope === 'WRIT') return OFFICIAL_SECTION_MINUTES.WRIT;
  const count = Math.max(0, Math.round(questionCount));
  if (count === 0) return 0;
  if (scope === 'ALL') {
    const caps = allocateFullPoolMockCaps(count, availableBySection);
    return computeOfficialPaceMinutesFromCounts(caps);
  }
  if (count === CANONICAL_POOL_MOCK_COUNTS[scope]) return OFFICIAL_SECTION_MINUTES[scope];
  return computeOfficialPaceMinutesFromCounts({ [scope]: count });
}

/** Computes official 1.0x pace minutes from actual selected questions. */
export function computeOfficialPaceMinutesForItems(items: Pick<SelectionQuestion, 'section'>[]): number {
  const counts: Record<SectionCode, number> = { READ: 0, MATH: 0, THINK: 0, WRIT: 0 };
  for (const item of items) {
    counts[item.section] = (counts[item.section] ?? 0) + 1;
  }
  return computeOfficialPaceMinutesFromCounts(counts);
}

/**
 * Dynamically assembles a fresh mock exam directly from the live active practice pool
 * (`poolType === 'practice'`). Strictly excludes benchmark_holdout and official_calibration items,
 * prioritizes unseen questions first, applies soft blended difficulty quotas when requested,
 * and shuffles items within each section so timing bottlenecks don't skew accuracy.
 */
export function selectPoolMockQuestions<T extends SelectionQuestion = QuestionItem>(input: {
  questions: T[];
  sectionFilter?: SectionCode;
  questionCount?: number;
  difficulty?: DifficultyPreset;
  questionMemory?: Record<string, QuestionMemoryState>;
  evidenceMap?: Record<string, QuestionMasteryEvidence>;
  autoRetireMastered?: boolean;
  seed?: number;
}): T[] {
  const {
    questions,
    sectionFilter,
    questionCount,
    difficulty,
    questionMemory = {},
    evidenceMap,
    autoRetireMastered = false,
    seed = 42,
  } = input;

  const eligible = questions.filter((q) => {
    if (q.qcStatus !== 'active') return false;
    if (!isEverydayPracticePoolType(q.poolType)) return false;
    if (sectionFilter && q.section !== sectionFilter) return false;
    if (autoRetireMastered) {
      const ev = findFamilyEvidence(q, evidenceMap);
      if (ev?.status === 'retained') return false;
    }
    return true;
  });

  const scoreForFreshMock = (q: T): number => {
    const mem = questionMemory[q.questionFamilyId];
    const ev = findFamilyEvidence(q, evidenceMap);
    const isUnseen = !mem && (!ev || ev.status === 'unseen');
    const isRetained = ev?.status === 'retained';
    let score = isUnseen ? 100 : 40;
    if (isRetained) score -= 35;
    if (mem?.lastSeenAt) {
      // Older attempts rank higher than recently seen ones
      const ageDays = Math.min(60, Math.max(0, (Date.now() - Date.parse(mem.lastSeenAt)) / 86_400_000));
      score += ageDays * 0.5;
    }
    score += seededNoise(seed, q.questionId) * 10;
    return score;
  };

  type MockScored = { q: T; priority: number; avgDifficulty: number };
  const pickSection = (sec: SectionCode, secItems: T[], cap: number, secSeed: number): T[] => {
    if (cap <= 0 || secItems.length === 0) return [];
    const scored: MockScored[] = secItems
      .map((q) => ({ q, priority: scoreForFreshMock(q), avgDifficulty: questionAvgDifficulty(q) }))
      .sort((a, b) => b.priority - a.priority);
    if (sec === 'READ') {
      if (difficulty) {
        return pickReadingBlendedCohesive<T, MockScored>(scored, cap, difficulty, secSeed).map((x) => x.q);
      }
      return shuffleReadingPassageBlocks(
        pickReadingCohesive<T, MockScored>(scored, cap),
        secSeed
      ).map((x) => x.q);
    }
    if (sec === 'WRIT') {
      return pickWithDiversity<T, MockScored>(scored, cap).map((x) => x.q);
    }
    if (difficulty) {
      return pickBlendedWithDiversity<T, MockScored>(scored, cap, difficulty, secSeed).map((x) => x.q);
    }
    return shuffleSeeded(pickWithDiversity<T, MockScored>(scored, cap), secSeed ^ 0x9e3779b9).map((x) => x.q);
  };

  if (sectionFilter) {
    const maxCap = MAX_POOL_MOCK_COUNTS[sectionFilter];
    const cap =
      typeof questionCount === 'number' && questionCount > 0
        ? Math.min(maxCap, Math.round(questionCount))
        : CANONICAL_POOL_MOCK_COUNTS[sectionFilter];
    return pickSection(sectionFilter, eligible, cap, seed);
  }

  const picked: T[] = [];
  const totalLimit =
    typeof questionCount === 'number' && questionCount > 0
      ? Math.min(MAX_POOL_MOCK_COUNTS.ALL, Math.round(questionCount))
      : null;
  const sections: SectionCode[] = ['READ', 'MATH', 'THINK', 'WRIT'];

  if (totalLimit !== null) {
    const availBySec: Record<SectionCode, number> = {
      READ: eligible.filter((q) => q.section === 'READ').length,
      MATH: eligible.filter((q) => q.section === 'MATH').length,
      THINK: eligible.filter((q) => q.section === 'THINK').length,
      WRIT: eligible.filter((q) => q.section === 'WRIT').length,
    };
    const caps = allocateFullPoolMockCaps(totalLimit, availBySec);
    sections.forEach((sec, idx) => {
      picked.push(...pickSection(sec, eligible.filter((q) => q.section === sec), caps[sec], seed + idx * 131));
    });
    return picked;
  }

  sections.forEach((sec, idx) => {
    picked.push(
      ...pickSection(sec, eligible.filter((q) => q.section === sec), CANONICAL_POOL_MOCK_COUNTS[sec], seed + idx * 131)
    );
  });
  return picked;
}

export function selectAdminCalibrationQuestions<T extends SelectionQuestion = QuestionItem>(input: {
  questions: T[];
  section?: SectionCode;
  poolType?: string;
  qcStatus?: string;
  formatType?: string;
  skillFamily?: string;
  skillId?: string;
  batch?: string;
  batchId?: string;
  limit?: number;
}): T[] {
  const {
    questions,
    section,
    poolType,
    qcStatus,
    formatType,
    skillFamily,
    skillId,
    batch,
    batchId,
    limit,
  } = input;
  const filtered = questions.filter((q) => {
    if (section && q.section !== section) return false;
    if (poolType && q.poolType !== poolType) return false;
    if (qcStatus && q.qcStatus !== qcStatus) return false;
    if (formatType && q.formatType !== formatType) return false;
    if (batch && getQuestionBatchTag(q) !== batch) return false;
    if (batchId && q.batchId !== batchId) return false;
    if (
      skillId &&
      !q.parts.some((p) => p.skillId === skillId || p.secondarySkillIds?.includes(skillId))
    )
      return false;
    if (skillFamily && !q.parts.some((p) => p.skillId.startsWith(skillFamily))) return false;
    return true;
  });
  return limit && limit > 0 ? filtered.slice(0, limit) : filtered;
}
/** Most questions a single repair drill serves; larger pools are drilled over several sittings. */
export const REPAIR_DRILL_MAX_QUESTIONS = 20;

const REPAIR_SECTION_ORDER: Record<SectionCode, number> = { READ: 0, MATH: 1, THINK: 2, WRIT: 3 };

/** True when a bank item can be served in a repair drill (live, practice-pool, objective). */
export function isRepairEligible(q: Pick<SelectionQuestion, 'qcStatus' | 'poolType' | 'formatType' | 'section'>): boolean {
  return (
    q.qcStatus === 'active' &&
    isEverydayPracticePoolType(q.poolType) &&
    q.formatType !== 'WRIT_TYPED_TASK' &&
    q.section !== 'WRIT'
  );
}

/**
 * Builds a targeted "Practise my mistakes" drill.
 *
 * - With `targetQuestionIds`, only those items (or the live version of the same family) are used.
 * - Otherwise the learner's `needs_repair` evidence decides the pool.
 * - Archived, quarantined, draft, holdout, Writing and missing items are always skipped.
 * - Output runs READ, MATH, THINK; Reading items that share a `stimulusId` stay together in
 *   natural question order, and the cap never splits a passage (unless one passage alone exceeds it).
 * - When capped, the most recently missed items win.
 */
export function selectRepairDrillQuestions<T extends SelectionQuestion = QuestionItem>(input: {
  questions: T[];
  evidenceMap?: Record<string, QuestionMasteryEvidence>;
  targetQuestionIds?: string[];
  sectionFilter?: SectionCode;
  limit?: number;
}): T[] {
  const { questions, evidenceMap = {}, targetQuestionIds, sectionFilter } = input;
  const limit = Math.max(1, Math.round(input.limit ?? REPAIR_DRILL_MAX_QUESTIONS));

  const explicit = Array.isArray(targetQuestionIds);
  const targetIds = new Set((targetQuestionIds ?? []).filter((id) => typeof id === 'string' && id));
  const targetFamilies = new Set<string>();
  if (explicit) {
    for (const ev of Object.values(evidenceMap)) {
      if (targetIds.has(ev.questionId)) targetFamilies.add(ev.questionFamilyId);
    }
  }

  // One live item per family; prefer the exact requested id, then the highest version.
  const byFamily = new Map<string, T>();
  for (const q of questions) {
    if (!isRepairEligible(q)) continue;
    if (sectionFilter && q.section !== sectionFilter) continue;
    if (explicit) {
      if (!targetIds.has(q.questionId) && !targetFamilies.has(q.questionFamilyId)) continue;
    } else if (findFamilyEvidence(q, evidenceMap)?.status !== 'needs_repair') {
      continue;
    }
    const prev = byFamily.get(q.questionFamilyId);
    if (
      !prev ||
      (targetIds.has(q.questionId) && !targetIds.has(prev.questionId)) ||
      (targetIds.has(q.questionId) === targetIds.has(prev.questionId) && q.version > prev.version)
    ) {
      byFamily.set(q.questionFamilyId, q);
    }
  }

  const missedAtMs = (q: T): number => {
    const ev = findFamilyEvidence(q, evidenceMap);
    const ms = ev?.lastAttemptAtIso ? Date.parse(ev.lastAttemptAtIso) : NaN;
    return Number.isFinite(ms) ? ms : 0;
  };
  const naturalOrder = (a: T, b: T) => a.questionId.localeCompare(b.questionId, undefined, { numeric: true });

  // Units keep a Reading passage whole; every other item is its own unit.
  type Unit = { section: SectionCode; items: T[]; recency: number; anchorId: string };
  const unitsByKey = new Map<string, Unit>();
  for (const q of byFamily.values()) {
    const key = q.section === 'READ' && q.stimulusId ? `stim::${q.stimulusId}` : `solo::${q.questionId}`;
    const unit = unitsByKey.get(key);
    if (unit) {
      unit.items.push(q);
      unit.recency = Math.max(unit.recency, missedAtMs(q));
    } else {
      unitsByKey.set(key, { section: q.section, items: [q], recency: missedAtMs(q), anchorId: q.questionId });
    }
  }
  const units = Array.from(unitsByKey.values());
  for (const unit of units) {
    unit.items.sort(naturalOrder);
    unit.anchorId = unit.items[0].questionId;
  }

  // Choose units by recency until the cap; skip (not truncate) passages that would overflow.
  const byRecency = [...units].sort(
    (a, b) => b.recency - a.recency || a.anchorId.localeCompare(b.anchorId, undefined, { numeric: true })
  );
  const chosen: Unit[] = [];
  let count = 0;
  for (const unit of byRecency) {
    if (count >= limit) break;
    if (count + unit.items.length <= limit) {
      chosen.push(unit);
      count += unit.items.length;
    } else if (count === 0) {
      chosen.push({ ...unit, items: unit.items.slice(0, limit) });
      count = limit;
    }
  }

  chosen.sort(
    (a, b) =>
      REPAIR_SECTION_ORDER[a.section] - REPAIR_SECTION_ORDER[b.section] ||
      a.anchorId.localeCompare(b.anchorId, undefined, { numeric: true })
  );
  return chosen.flatMap((u) => u.items);
}

/** Suggested time for a repair drill: 1.5x the items' target pace, at least 5 minutes, whole minutes. */
export function repairDrillTimeLimitSec(questions: ReadonlyArray<Pick<SelectionQuestion, 'parts'>>): number {
  const targetSec = questions.reduce(
    (sum, q) => sum + q.parts.reduce((s, p) => s + (p.targetTimeSec && p.targetTimeSec > 0 ? p.targetTimeSec : 60), 0),
    0
  );
  return Math.max(300, Math.ceil((targetSec * 1.5) / 60) * 60);
}
