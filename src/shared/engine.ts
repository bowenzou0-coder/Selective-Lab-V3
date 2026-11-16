import type {
  AlgorithmAdjustments,
  LearningConfig,
  MarkingResult,
  MasteryCertificationStatus,
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
} from './contracts';

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
  const matchedMandatoryStarter = spec.mandatoryOpeningLine
    ? norm(clean).startsWith(norm(spec.mandatoryOpeningLine))
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

function findFamilyEvidence(
  q: QuestionItem,
  evidenceMap?: Record<string, QuestionMasteryEvidence>
): QuestionMasteryEvidence | undefined {
  if (!evidenceMap) return undefined;
  if (q.evidenceRevision) {
    const exact = evidenceMap[`${q.questionFamilyId}__${q.evidenceRevision}`];
    if (exact) return exact;
  }
  const prefix = `${q.questionFamilyId}__`;
  for (const [k, ev] of Object.entries(evidenceMap)) {
    if (k.startsWith(prefix)) return ev;
  }
  return undefined;
}

function pickWithDiversity<T extends { q: QuestionItem; priority: number }>(
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

export interface PracticeSelectionInput {
  mode: SessionMode;
  sectionFilter?: SectionCode;
  questions: QuestionItem[];
  skillStates: Record<string, SkillState>;
  questionMemory: Record<string, QuestionMemoryState>;
  evidenceMap?: Record<string, QuestionMasteryEvidence>;
  skillFocusWeights?: Record<string, number>;
  algorithmAdjustments?: AlgorithmAdjustments;
  config: LearningConfig;
  nowIso: string;
  seed: number;
}

export interface PracticeCandidateInfo {
  q: QuestionItem;
  priority: number;
  isDue: boolean;
  isConfirmationDue: boolean;
  isNeedsRepair: boolean;
  isOnCooldown: boolean;
  meanSkillMastery: number;
  avgDifficulty: number;
}

function scorePracticeCandidates(input: PracticeSelectionInput): {
  scored: PracticeCandidateInfo[];
  sectionLimit?: number;
  effectiveCaps?: Record<SectionCode, number>;
} {
  const {
    mode,
    sectionFilter,
    questions,
    skillStates,
    questionMemory,
    evidenceMap,
    skillFocusWeights,
    algorithmAdjustments,
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

  // HARD INVARIANT: benchmark_holdout NEVER leaks into non-benchmark modes
  const eligible = questions.filter((q) => {
    if (q.qcStatus !== 'active') return false;
    if (mode === 'benchmark_exam') return q.poolType === 'benchmark_holdout';
    if (q.poolType === 'benchmark_holdout') return false;
    if (sectionFilter && q.section !== sectionFilter) return false;
    return true;
  });

  const scored: PracticeCandidateInfo[] = eligible
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
      const avgDifficulty =
        q.parts.reduce((acc, p) => acc + p.difficultyInitial, 0) / Math.max(1, q.parts.length);
      const targetDiff = 1.5 + meanSkillMastery * 3.0 + adj.zpdDifficultyOffset;
      const zpdPenalty = Math.abs(avgDifficulty - targetDiff) * 0.25;

      let priority = 0;
      if (isDue) priority += effectiveSpacedWeight;
      if (isConfirmationDue) priority += effectiveSpacedWeight * 1.15;
      if (isNeedsRepair) priority += effectiveWeakestWeight * 1.1;
      if (!mem && (!ev || ev.status === 'unseen')) {
        priority += effectiveNoveltyWeight;
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
        avgDifficulty: Number(avgDifficulty.toFixed(2)),
      };
    })
    .sort((a, b) => b.priority - a.priority);

  if (sectionFilter) {
    const drillCap = config.sessionDefaults.sectionDrillQuestionCount ?? 10;
    const sectionLimit = mode === 'benchmark_exam' ? 40 : Math.max(1, drillCap);
    return { scored, sectionLimit };
  }

  const caps = config.sessionDefaults.dailyQuestionLimitBySection;
  const totalConfigured = (['READ', 'MATH', 'THINK', 'WRIT'] as SectionCode[]).reduce(
    (sum, sec) => sum + Math.max(0, Number(caps[sec] ?? 0)),
    0
  );
  const effectiveCaps: Record<SectionCode, number> =
    totalConfigured > 0 ? caps : { READ: 2, MATH: 3, THINK: 3, WRIT: 0 };
  return { scored, effectiveCaps };
}

export function selectPracticeCandidates(
  input: PracticeSelectionInput & { poolLimit?: number }
): {
  candidates: PracticeCandidateInfo[];
  targetCount: number;
  effectiveCaps?: Record<SectionCode, number>;
} {
  const poolLimit = Math.max(4, input.poolLimit ?? 24);
  const { scored, sectionLimit, effectiveCaps } = scorePracticeCandidates(input);

  if (sectionLimit !== undefined) {
    const targetCount = Math.min(sectionLimit, scored.length);
    const candidates = pickWithDiversity(scored, Math.min(scored.length, Math.max(targetCount * 2, poolLimit)));
    return { candidates, targetCount };
  }

  const caps = effectiveCaps || { READ: 2, MATH: 3, THINK: 3, WRIT: 0 };
  const candidates: PracticeCandidateInfo[] = [];
  let targetCount = 0;

  for (const sec of ['READ', 'MATH', 'THINK', 'WRIT'] as SectionCode[]) {
    const cap = Math.max(0, Number(caps[sec] ?? 0));
    if (cap <= 0) continue;
    const secScored = scored.filter((x) => x.q.section === sec);
    targetCount += Math.min(cap, secScored.length);
    const secPoolCap = Math.min(secScored.length, Math.max(cap * 2, Math.min(8, cap + 4)));
    candidates.push(...pickWithDiversity(secScored, secPoolCap));
  }

  return {
    candidates: candidates.slice(0, poolLimit),
    targetCount,
    effectiveCaps: caps,
  };
}

export function selectPracticeSession(input: PracticeSelectionInput): QuestionItem[] {
  const { scored, sectionLimit, effectiveCaps } = scorePracticeCandidates(input);

  if (sectionLimit !== undefined) {
    return pickWithDiversity(scored, sectionLimit).map((item) => item.q);
  }

  const caps = effectiveCaps || { READ: 2, MATH: 3, THINK: 3, WRIT: 0 };
  const picked: QuestionItem[] = [];
  for (const sec of ['READ', 'MATH', 'THINK', 'WRIT'] as SectionCode[]) {
    const cap = Math.max(0, Number(caps[sec] ?? 0));
    if (cap <= 0) continue;
    picked.push(
      ...pickWithDiversity(
        scored.filter((x) => x.q.section === sec),
        cap
      ).map((item) => item.q)
    );
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
  q: QuestionItem
): 'PT1' | 'PT2' | 'PT3' | 'SMOKE' | 'CUSTOM' {
  const ref = q.provenance.sourceReference ?? '';
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

export function selectMockTestQuestions(input: {
  batch: 'PT1' | 'PT2' | 'PT3';
  sectionFilter?: SectionCode;
  questions: QuestionItem[];
}): QuestionItem[] {
  const { batch, sectionFilter, questions } = input;
  const sectionOrder: Record<SectionCode, number> = { READ: 0, MATH: 1, THINK: 2, WRIT: 3 };
  return questions
    .filter((q) => {
      if (q.qcStatus !== 'active') return false;
      if (getQuestionBatchTag(q) !== batch) return false;
      if (batch === 'PT3' && q.poolType !== 'benchmark_holdout') return false;
      if (sectionFilter && q.section !== sectionFilter) return false;
      return true;
    })
    .sort((a, b) => {
      const secDiff = sectionOrder[a.section] - sectionOrder[b.section];
      if (secDiff !== 0) return secDiff;
      return a.questionId.localeCompare(b.questionId, undefined, { numeric: true });
    });
}

export function selectAdminCalibrationQuestions(input: {
  questions: QuestionItem[];
  section?: SectionCode;
  poolType?: string;
  qcStatus?: string;
  formatType?: string;
  skillFamily?: string;
  skillId?: string;
  batch?: string;
  batchId?: string;
  limit?: number;
}): QuestionItem[] {
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