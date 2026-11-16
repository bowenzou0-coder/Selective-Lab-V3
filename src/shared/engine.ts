import type {
  LearningConfig,
  MarkingResult,
  QuestionItem,
  QuestionMemoryState,
  SectionCode,
  SessionMode,
  SkillState,
  StimulusGroup,
  StudentQuestionView,
  WritingDeterministicMetrics,
  WritingTaskSpec,
} from './contracts';

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
 * Updates family-level spaced repetition state strictly once per question encounter
 * (never inflated per-part on multi-part reading stimuli).
 */
export function updateFamilyMemoryOnce(input: {
  prevMemory?: QuestionMemoryState;
  questionFamilyId: string;
  allPartsCorrect: boolean;
  config: LearningConfig;
  nowIso: string;
}): QuestionMemoryState {
  const { prevMemory, questionFamilyId, allPartsCorrect, config, nowIso } = input;
  const nowMs = Date.parse(nowIso);
  const memPrevInterval = prevMemory?.intervalDays ?? config.scheduling.sm2InitialIntervalDays;
  const memInterval = allPartsCorrect
    ? Math.min(45, Math.max(1, Math.round(memPrevInterval * 2.1)))
    : 1;
  return {
    questionFamilyId,
    timesSeen: (prevMemory?.timesSeen ?? 0) + 1,
    lastSeenAt: nowIso,
    lastAllCorrect: allPartsCorrect,
    intervalDays: memInterval,
    lapseCount: (prevMemory?.lapseCount ?? 0) + (allPartsCorrect ? 0 : 1),
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

export function selectPracticeSession(input: {
  mode: SessionMode;
  sectionFilter?: SectionCode;
  questions: QuestionItem[];
  skillStates: Record<string, SkillState>;
  questionMemory: Record<string, QuestionMemoryState>;
  config: LearningConfig;
  nowIso: string;
  seed: number;
}): QuestionItem[] {
  const {
    mode,
    sectionFilter,
    questions,
    skillStates,
    questionMemory,
    config,
    nowIso,
    seed,
  } = input;
  const nowMs = Date.parse(nowIso);
  const cooldownMs = config.scheduling.minRepeatCooldownHours * 3_600_000;

  // HARD INVARIANT: benchmark_holdout NEVER leaks into non-benchmark modes
  const eligible = questions.filter((q) => {
    if (q.qcStatus !== 'active') return false;
    if (mode === 'benchmark_exam') return q.poolType === 'benchmark_holdout';
    if (q.poolType === 'benchmark_holdout') return false;
    if (sectionFilter && q.section !== sectionFilter) return false;
    return true;
  });

  const scored = eligible
    .map((q) => {
      const mem = questionMemory[q.questionFamilyId];
      const onCooldown = mem ? nowMs - Date.parse(mem.lastSeenAt) < cooldownMs : false;
      const isDue = mem ? Date.parse(mem.nextDueAt) <= nowMs : false;
      const meanSkillMastery =
        q.parts.reduce((acc, p) => acc + (skillStates[p.skillId]?.masteryScore ?? 0.5), 0) /
        q.parts.length;
      const avgDiff = q.parts.reduce((acc, p) => acc + p.difficultyInitial, 0) / q.parts.length;
      const zpdPenalty = Math.abs(avgDiff - (1.5 + meanSkillMastery * 3.0)) * 0.25;

      let priority = 0;
      if (isDue) priority += config.scheduling.spacedReviewWeight;
      if (!mem) priority += config.scheduling.noveltyCoverageWeight;
      priority += (1 - meanSkillMastery) * config.scheduling.weakestSkillWeight;
      priority -= zpdPenalty;
      if (onCooldown) priority -= 5.0;
      priority += seededNoise(seed, q.questionId);
      return { q, priority };
    })
    .sort((a, b) => b.priority - a.priority);

  if (sectionFilter) {
    const drillCap = config.sessionDefaults.sectionDrillQuestionCount ?? 10;
    const limit = mode === 'benchmark_exam' ? 40 : Math.max(1, drillCap);
    return scored.slice(0, limit).map((x) => x.q);
  }

  const caps = config.sessionDefaults.dailyQuestionLimitBySection;
  const totalConfigured = (['READ', 'MATH', 'THINK', 'WRIT'] as SectionCode[]).reduce(
    (sum, sec) => sum + Math.max(0, Number(caps[sec] ?? 0)),
    0
  );
  const effectiveCaps: Record<SectionCode, number> =
    totalConfigured > 0 ? caps : { READ: 2, MATH: 3, THINK: 3, WRIT: 0 };

  const picked: QuestionItem[] = [];
  for (const sec of ['READ', 'MATH', 'THINK', 'WRIT'] as SectionCode[]) {
    const cap = Math.max(0, Number(effectiveCaps[sec] ?? 0));
    if (cap <= 0) continue;
    picked.push(...scored.filter((x) => x.q.section === sec).slice(0, cap).map((x) => x.q));
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