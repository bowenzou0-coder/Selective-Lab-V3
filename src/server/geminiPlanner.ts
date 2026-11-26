import {
  type AlgorithmAdjustments,
  type AutoCalibrateConfig,
  type DailyFocusPlan,
  type DifficultyPreset,
  type LearningConfig,
  type QuestionItem,
  type QuestionMasteryEvidence,
  type QuestionMemoryState,
  type SectionCode,
  type SessionMode,
  type SessionSelectionDecision,
  type SkillState,
} from '../shared/contracts.ts';
import {
  clampAlgorithmAdjustments,
  pickReadingCohesive,
  selectPracticeCandidates,
  selectPracticeSession,
  type SelectionQuestion,
} from '../shared/engine.ts';
import { VALID_SKILL_IDS } from '../shared/skills.ts';
import {
  createGeminiClient,
  GEMINI_DECISION_MODEL,
  GeminiServiceError,
  isGeminiConfigured,
  withGeminiRetry,
} from './geminiClient.ts';
import type { AppRepository } from './storage/repository.ts';
import {
  allocateAutoCalibratedDailyPlan,
  buildDeterministicDailyFocusPlan,
  clampSkillWeight,
  computeRankedSkillCandidates,
  countAvailableBySection,
  type FocusPlanSummaryRow,
} from './dailyPlanAllocator.ts';

// Deterministic planning moved to dailyPlanAllocator.ts; re-exported so existing imports keep working.
export {
  allocateAutoCalibratedDailyPlan,
  buildDeterministicDailyFocusPlan,
  clampSkillWeight,
  computeRankedSkillCandidates,
  type FocusPlanSummaryRow,
} from './dailyPlanAllocator.ts';


export type DecisionAnswer =
  | { type: 'noul'; noul: number; confidence: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | {
      type: 'score';
      score: number;
      legend: Record<string, string>;
      probabilities: Record<string, number>;
      confidence: number;
    };

export type DecisionAnswerMap = Record<string, DecisionAnswer>;

export type DecisionQuestionSpec =
  | {
      type: 'noul';
      instructions: string;
      criteria?: { true_description: string; false_description: string };
    }
  | {
      type: 'choice';
      instructions: string;
      criteria: Record<string, string>;
    }
  | {
      type: 'score';
      instructions: string;
      criteria: string[];
    };

export type DecisionsExecutor = (req: {
  inputText: string;
  questions: Record<string, DecisionQuestionSpec>;
}) => Promise<DecisionAnswerMap>;

const ALGORITHM_SCORE_LEVELS = [
  'Strongly decrease emphasis (0.75x): deprioritize this factor for the current learner state.',
  'Slightly decrease emphasis (0.90x): keep mild downward pressure on this factor.',
  'Neutral baseline (1.05x): keep balanced default emphasis.',
  'Increase emphasis (1.20x): boost this factor meaningfully in candidate scoring.',
  'Maximum emphasis (1.35x): prioritize this factor strongly in candidate scoring.',
];

const ZPD_OFFSET_LEVELS = [
  'Step down noticeably (-0.75): learner has fragile foundations or repeated errors; consolidate fundamentals.',
  'Step down gently (-0.38): build confidence with slightly more accessible items.',
  'Balanced zone of proximal development (0.00): match current estimated mastery difficulty.',
  'Moderate stretch (+0.38): push slightly above comfort zone to accelerate growth.',
  'Strong stretch (+0.75): mastery is high and fast; challenge with harder selective items.',
];

const SKILL_PRIORITY_LEVELS = [
  'Defer: strong mastery with zero overdue reviews or repairs.',
  'Low priority: stable skill needing only light spaced rotation.',
  'Moderate priority: steady building or moderate uncertainty.',
  'High priority: developing mastery, due spaced review, or time slowdown.',
  'Critical priority: active needs-repair items, overdue confirmation reviews, or stagnant plateau.',
];

const DAILY_VOLUME_LEVELS = [
  'Light recovery load: learner has high mastery and minimal repairs/reviews; keep session crisp near minimum count.',
  'Moderate-light load: steady maintenance day slightly below midpoint.',
  'Balanced standard load: normal daily training cadence near midpoint.',
  'Focused build load: meaningful backlog of repairs, due reviews, or weak skills; push above midpoint.',
  'Intensive load: large backlog of overdue reviews/repairs or big coverage gap; schedule near maximum count.',
];

const SECTION_SHARE_LEVELS = [
  'Minimal share: section is strong and caught up; assign minimal or zero questions today.',
  'Light share: section is stable; light maintenance only.',
  'Standard balanced share: normal proportional mix.',
  'Heavy share: clear weakness, plateau, or repair backlog; skew today’s mix toward this section.',
  'Dominant priority share: urgent repairs/overdue reviews or major mastery gap; allocate the largest share today.',
];

const ITEM_SELECTION_LEVELS = [
  'Defer now: currently on cooldown or redundant with stronger candidates.',
  'Low priority: already well-mastered or low diagnostic urgency.',
  'Moderate priority: useful mixed practice or healthy difficulty progression.',
  'High priority: weak/developing skill or aligned with daily focus skills.',
  'Immediate top pick: needs-repair item, overdue 24h/7d confirmation check, or urgent review.',
];

export async function runDecisionsApi(
  inputText: string,
  questions: Record<string, DecisionQuestionSpec>,
  decideFn?: DecisionsExecutor
): Promise<DecisionAnswerMap> {
  if (decideFn) {
    return decideFn({ inputText, questions });
  }
  return withGeminiRetry(async () => {
    const decisionsAi = await createGeminiClient('v1beta');
    const response = await decisionsAi.decisions.create({
      model: GEMINI_DECISION_MODEL,
      input: [{ type: 'text', text: inputText }],
      questions,
    });
    if (!response.answers || Object.keys(response.answers).length === 0) {
      const feedback = (response as { prompt_feedback?: unknown }).prompt_feedback;
      throw new GeminiServiceError(
        400,
        feedback
          ? `Gemini Decisions 1 did not return answers (${JSON.stringify(feedback)}).`
          : 'Gemini Decisions 1 returned no answers for this decision request.'
      );
    }
    return response.answers as DecisionAnswerMap;
  });
}

function mapScoreToMultiplier(score: number | undefined): number {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 1.0;
  // score spans [0..4] across 5 ordered rubric levels -> maps to [0.75..1.35]
  return Number((0.75 + Math.min(4, Math.max(0, score)) / 4 * 0.6).toFixed(2));
}

function mapScoreToZpdOffset(score: number | undefined): number {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 0;
  // score spans [0..4] -> maps to [-0.75..+0.75]
  return Number((-0.75 + Math.min(4, Math.max(0, score)) / 4 * 1.5).toFixed(2));
}

function extractAlgorithmAdjustmentsFromAnswers(answers: DecisionAnswerMap): AlgorithmAdjustments {
  const rev = answers.review_emphasis?.type === 'score' ? answers.review_emphasis.score : undefined;
  const weak = answers.weakness_emphasis?.type === 'score' ? answers.weakness_emphasis.score : undefined;
  const nov = answers.novelty_emphasis?.type === 'score' ? answers.novelty_emphasis.score : undefined;
  const zpd = answers.zpd_challenge_step?.type === 'score' ? answers.zpd_challenge_step.score : undefined;

  return clampAlgorithmAdjustments({
    spacedReviewWeightMultiplier: mapScoreToMultiplier(rev),
    weakestSkillWeightMultiplier: mapScoreToMultiplier(weak),
    noveltyCoverageWeightMultiplier: mapScoreToMultiplier(nov),
    zpdDifficultyOffset: mapScoreToZpdOffset(zpd),
  });
}

export async function generateGeminiFocusOverride(input: {
  basePlan: DailyFocusPlan;
  candidates: FocusPlanSummaryRow[];
  availableBySection?: Record<SectionCode, number>;
  autoCalibrate?: AutoCalibrateConfig;
  decideFn?: DecisionsExecutor;
}): Promise<DailyFocusPlan | null> {
  if (!input.decideFn && !isGeminiConfigured()) {
    return null;
  }

  const topCandidates = input.candidates.slice(0, 15).map((c) => ({
    skillId: c.skillId,
    section: c.section,
    displayName: c.displayName,
    mastery: Number(c.masteryScore.toFixed(2)),
    ewmaAccuracy: Number(c.ewmaAccuracy.toFixed(2)),
    avgTimeRatio: Number(c.avgTimeRatio.toFixed(2)),
    attempts: c.attemptsCount,
    repairs: c.repairCount,
    dueReviews: c.dueReviewCount,
    unseen: c.unseenCount,
    plateau: c.plateauStatus,
    urgency: c.urgency,
  }));

  if (topCandidates.length === 0) return null;

  const autoCfg = input.autoCalibrate;
  const shouldAutoCalibrate = Boolean(autoCfg?.enabled);
  const avail = input.availableBySection || {
    READ: topCandidates.filter((c) => c.section === 'READ').length * 3,
    MATH: topCandidates.filter((c) => c.section === 'MATH').length * 3,
    THINK: topCandidates.filter((c) => c.section === 'THINK').length * 3,
    WRIT: 0,
  };

  // Aggregate section-level telemetry so gemini-decision-1 can skew daily section mix cleanly
  const sectionTelemetry = (['READ', 'MATH', 'THINK'] as const).map((sec) => {
    const rows = topCandidates.filter((c) => c.section === sec);
    const meanMastery =
      rows.length > 0 ? Number((rows.reduce((s, r) => s + r.mastery, 0) / rows.length).toFixed(2)) : 0.5;
    return {
      section: sec,
      availableQuestions: avail[sec] || 0,
      repairs: rows.reduce((s, r) => s + r.repairs, 0),
      dueReviews: rows.reduce((s, r) => s + r.dueReviews, 0),
      unseen: rows.reduce((s, r) => s + r.unseen, 0),
      meanMastery,
      plateaus: rows.filter((r) => r.plateau !== 'none').length,
    };
  });

  const payloadJson = JSON.stringify({
    date: input.basePlan.planDate,
    autoCalibrateEnabled: shouldAutoCalibrate,
    dailyQuestionRange: shouldAutoCalibrate
      ? [autoCfg?.minDailyQuestions ?? 6, autoCfg?.maxDailyQuestions ?? 14]
      : null,
    sectionTelemetry,
    candidateSkills: topCandidates,
  });

  const questions: Record<string, DecisionQuestionSpec> = {
    review_emphasis: {
      type: 'score',
      instructions:
        'Based on candidateSkills repairs and dueReviews counts, how strongly should today’s scheduler boost spaced-repetition & confirmation reviews?',
      criteria: ALGORITHM_SCORE_LEVELS,
    },
    weakness_emphasis: {
      type: 'score',
      instructions:
        'Based on candidateSkills mastery, ewmaAccuracy, and plateau flags, how strongly should today’s scheduler weight weak/stagnant skills?',
      criteria: ALGORITHM_SCORE_LEVELS,
    },
    novelty_emphasis: {
      type: 'score',
      instructions:
        'Based on unseen question counts and overall coverage gaps, how strongly should today’s scheduler prioritize unseen material?',
      criteria: ALGORITHM_SCORE_LEVELS,
    },
    zpd_challenge_step: {
      type: 'score',
      instructions:
        'Considering overall mastery, ewmaAccuracy, and avgTimeRatio (speed vs target time), what ZPD difficulty offset should guide today’s question selection?',
      criteria: ZPD_OFFSET_LEVELS,
    },
  };

  if (shouldAutoCalibrate) {
    questions.daily_volume = {
      type: 'score',
      instructions: `Decide today's flexible daily question load within [${autoCfg?.minDailyQuestions ?? 6}..${autoCfg?.maxDailyQuestions ?? 14}] questions based on sectionTelemetry repairs, dueReviews, unseen stock, and meanMastery.`,
      criteria: DAILY_VOLUME_LEVELS,
    };
    for (const sec of ['READ', 'MATH', 'THINK'] as const) {
      const tel = sectionTelemetry.find((t) => t.section === sec)!;
      questions[`section_share_${sec}`] = {
        type: 'score',
        instructions: `What share of today's daily practice questions should go to ${sec} (meanMastery=${tel.meanMastery}, repairs=${tel.repairs}, dueReviews=${tel.dueReviews}, unseen=${tel.unseen}, plateaus=${tel.plateaus}, available=${tel.availableQuestions})?`,
        criteria: SECTION_SHARE_LEVELS,
      };
    }
    if (autoCfg?.includeWriting && (avail.WRIT || 0) > 0) {
      questions.include_writing_today = {
        type: 'noul',
        instructions:
          'Should today’s adaptive set include 1 timed Writing task alongside objective sections?',
        criteria: {
          true_description: 'Objective repair load is manageable and adding a writing task balances exam readiness.',
          false_description: 'Objective repairs/due reviews are heavy today; focus solely on Reading, Maths, and Thinking.',
        },
      };
    }
  }

  const availableSections = Array.from(
    new Set(topCandidates.map((c) => c.section).filter((s) => s === 'READ' || s === 'MATH' || s === 'THINK'))
  );
  if (availableSections.length >= 2) {
    const sectionCriteria: Record<string, string> = {};
    for (const sec of availableSections) {
      sectionCriteria[sec] =
        sec === 'READ'
          ? 'Reading comprehension, cloze, poetry, and inference skills show highest urgency.'
          : sec === 'MATH'
            ? 'Mathematical reasoning, multi-step problem solving, or geometry/measurement shows highest urgency.'
            : 'Thinking skills, deductive logic, or critical reasoning shows highest urgency.';
    }
    questions.recommended_section = {
      type: 'choice',
      instructions: 'Which exam section most urgently needs focused practice today?',
      criteria: sectionCriteria,
    };
  }

  topCandidates.forEach((cand, idx) => {
    questions[`skill_${idx}`] = {
      type: 'score',
      instructions: `How high is today’s study priority for skill "${cand.displayName}" (${cand.skillId}, section ${cand.section}, mastery=${cand.mastery}, repairs=${cand.repairs}, dueReviews=${cand.dueReviews}, unseen=${cand.unseen}, plateau=${cand.plateau})?`,
      criteria: SKILL_PRIORITY_LEVELS,
    };
  });

  const answers = await runDecisionsApi(payloadJson, questions, input.decideFn);

  const scoredSkills = topCandidates
    .map((cand, idx) => {
      const ans = answers[`skill_${idx}`];
      const rawScore = ans?.type === 'score' && Number.isFinite(ans.score) ? ans.score : 2;
      const conf = ans?.type === 'score' && Number.isFinite(ans.confidence) ? ans.confidence : 0.5;
      return {
        cand,
        score: rawScore,
        confidence: conf,
      };
    })
    .filter((row) => VALID_SKILL_IDS.has(row.cand.skillId))
    .sort((a, b) => b.score - a.score || b.cand.urgency - a.cand.urgency);

  const chosenRows = scoredSkills.slice(0, 5);
  if (chosenRows.length === 0) return null;

  const focusSkillIds = chosenRows.map((r) => r.cand.skillId);
  const skillWeights: Record<string, number> = {};
  for (const row of scoredSkills) {
    // Map expected rubric score [0..4] cleanly into [0.85..1.35]
    const rawWeight = 0.85 + (Math.min(4, Math.max(0, row.score)) / 4) * 0.5;
    skillWeights[row.cand.skillId] = clampSkillWeight(rawWeight);
  }

  const validSections = new Set(['READ', 'MATH', 'THINK']);
  const secAns = answers.recommended_section;
  const recommendedSection =
    secAns?.type === 'choice' && validSections.has(secAns.choice)
      ? (secAns.choice as DailyFocusPlan['recommendedSection'])
      : input.basePlan.recommendedSection;

  let dailyQuestionLimitBySection = input.basePlan.dailyQuestionLimitBySection;
  let dailyGoalMinutes = input.basePlan.dailyGoalMinutes;
  let autoCalibrated = Boolean(input.basePlan.autoCalibrated);

  if (shouldAutoCalibrate) {
    const volAns = answers.daily_volume;
    const volumeScore = volAns?.type === 'score' && Number.isFinite(volAns.score) ? volAns.score : 2;
    const readScore =
      answers.section_share_READ?.type === 'score' && Number.isFinite(answers.section_share_READ.score)
        ? answers.section_share_READ.score
        : 2;
    const mathScore =
      answers.section_share_MATH?.type === 'score' && Number.isFinite(answers.section_share_MATH.score)
        ? answers.section_share_MATH.score
        : 2;
    const thinkScore =
      answers.section_share_THINK?.type === 'score' && Number.isFinite(answers.section_share_THINK.score)
        ? answers.section_share_THINK.score
        : 2;
    const writAns = answers.include_writing_today;
    const includeWriting = writAns?.type === 'noul' ? writAns.noul >= 0.65 : false;

    const allocated = allocateAutoCalibratedDailyPlan({
      volumeScore,
      sectionScores: { READ: readScore, MATH: mathScore, THINK: thinkScore },
      includeWriting,
      availableBySection: avail,
      autoConfig: autoCfg,
    });
    dailyQuestionLimitBySection = allocated.dailyQuestionLimitBySection;
    dailyGoalMinutes = allocated.dailyGoalMinutes;
    autoCalibrated = true;
  }

  const algorithmAdjustments = extractAlgorithmAdjustmentsFromAnswers(answers);
  const topNames = chosenRows.slice(0, 3).map((r) => r.cand.displayName);
  const totalRepairs = topCandidates.reduce((s, r) => s + r.repairs, 0);
  const totalDue = topCandidates.reduce((s, r) => s + r.dueReviews, 0);
  const rationaleParts = [`Prioritising ${topNames.join(', ')}`];
  if (totalRepairs > 0) rationaleParts.push(`${totalRepairs} repair item${totalRepairs === 1 ? '' : 's'} queued`);
  if (totalDue > 0) rationaleParts.push(`${totalDue} spaced review${totalDue === 1 ? '' : 's'} due`);
  if (autoCalibrated && dailyQuestionLimitBySection) {
    const mixLabel = (['READ', 'MATH', 'THINK'] as const)
      .filter((s) => dailyQuestionLimitBySection![s] > 0)
      .map((s) => `${s === 'READ' ? 'Reading' : s === 'MATH' ? 'Maths' : 'Thinking'} ${dailyQuestionLimitBySection![s]}`)
      .join(', ');
    if (mixLabel) rationaleParts.push(`today's mix: ${mixLabel}`);
  } else if (recommendedSection) {
    rationaleParts.push(`recommended focus: ${recommendedSection}`);
  }

  return {
    ...input.basePlan,
    source: 'gemini',
    modelId: GEMINI_DECISION_MODEL,
    focusSkillIds,
    skillWeights,
    algorithmAdjustments,
    recommendedSection,
    dailyQuestionLimitBySection,
    dailyGoalMinutes,
    autoCalibrated,
    rationale: `${rationaleParts.join(', ')}.`.slice(0, 280),
  };
}

type MaybeLazy<T> = T | (() => Promise<T>);

async function resolveLazy<T>(value: MaybeLazy<T>): Promise<T> {
  return typeof value === 'function' ? (value as () => Promise<T>)() : value;
}

type DailyFocusPlanInput = {
  repo: AppRepository;
  studentId: string;
  skillStates: MaybeLazy<Record<string, SkillState>>;
  evidenceMap: MaybeLazy<Record<string, QuestionMasteryEvidence>>;
  questionMemory: MaybeLazy<Record<string, QuestionMemoryState>>;
  /** Pass a loader to fetch the bank only when today's plan is not already cached. */
  questions: MaybeLazy<SelectionQuestion[]>;
  config?: LearningConfig;
  forceRefresh?: boolean;
  nowIso?: string;
  decideFn?: DecisionsExecutor;
};

type DailyFocusPlanResult = { plan: DailyFocusPlan; error?: string };
const dailyFocusInFlight = new WeakMap<AppRepository, Map<string, Promise<DailyFocusPlanResult>>>();

/** Drop any in-flight daily plan generation promises for a deleted or reset learner. */
export function clearDailyFocusInFlight(repo: AppRepository, studentId: string): void {
  const requests = dailyFocusInFlight.get(repo);
  if (!requests) return;
  const prefix = `${studentId}:`;
  for (const key of requests.keys()) {
    if (key.startsWith(prefix)) {
      requests.delete(key);
    }
  }
}

export async function getOrCreateDailyFocusPlan(input: DailyFocusPlanInput): Promise<DailyFocusPlanResult> {
  if (input.forceRefresh) {
    return loadOrCreateDailyFocusPlan(input);
  }
  let requests = dailyFocusInFlight.get(input.repo);
  if (!requests) {
    requests = new Map();
    dailyFocusInFlight.set(input.repo, requests);
  }
  const key = `${input.studentId}:${(input.nowIso ?? new Date().toISOString()).slice(0, 10)}`;
  const existing = requests.get(key);
  if (existing) return existing;
  const pending = loadOrCreateDailyFocusPlan(input);
  requests.set(key, pending);
  try {
    return await pending;
  } finally {
    requests.delete(key);
  }
}

async function loadOrCreateDailyFocusPlan(input: DailyFocusPlanInput): Promise<DailyFocusPlanResult> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const planDate = nowIso.slice(0, 10);

  const wantsAutoCalibrate = Boolean(input.config?.autoCalibrate?.enabled);

  if (!input.forceRefresh) {
    const cached = await input.repo.getDailyFocusPlan(input.studentId, planDate).catch(() => null);
    if (
      cached &&
      cached.focusSkillIds.length > 0 &&
      (cached.source === 'deterministic' || cached.modelId === GEMINI_DECISION_MODEL) &&
      (!wantsAutoCalibrate || Boolean(cached.dailyQuestionLimitBySection && cached.dailyGoalMinutes))
    ) {
      return { plan: cached };
    }
  }

  const [questions, skillStates, evidenceMap, questionMemory] = await Promise.all([
    resolveLazy(input.questions),
    resolveLazy(input.skillStates),
    resolveLazy(input.evidenceMap),
    resolveLazy(input.questionMemory),
  ]);
  const deterministic = buildDeterministicDailyFocusPlan({
    studentId: input.studentId,
    skillStates,
    evidenceMap,
    questionMemory,
    questions,
    config: input.config,
    nowIso,
  });

  if (!input.decideFn && !isGeminiConfigured()) {
    await input.repo.saveDailyFocusPlan(input.studentId, deterministic).catch(() => undefined);
    return { plan: deterministic };
  }

  const candidateRows = computeRankedSkillCandidates({
    skillStates,
    evidenceMap,
    questionMemory,
    questions,
    nowIso,
  });
  const availableBySection = countAvailableBySection(questions);

  try {
    const geminiPlan = await generateGeminiFocusOverride({
      basePlan: deterministic,
      candidates: candidateRows,
      availableBySection,
      autoCalibrate: input.config?.autoCalibrate,
      decideFn: input.decideFn,
    });
    if (geminiPlan) {
      await input.repo.saveDailyFocusPlan(input.studentId, geminiPlan).catch(() => undefined);
      return { plan: geminiPlan };
    }
    await input.repo.saveDailyFocusPlan(input.studentId, deterministic).catch(() => undefined);
    return { plan: deterministic };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Gemini Decisions 1 focus planning failed.';
    console.error('Daily Gemini Decisions 1 focus plan failed:', message);
    await input.repo.saveDailyFocusPlan(input.studentId, deterministic).catch(() => undefined);
    return { plan: deterministic, error: message };
  }
}

export async function generateDailyFocusPlanStateless(input: {
  studentId: string;
  skillStates: Record<string, SkillState>;
  evidenceMap: Record<string, QuestionMasteryEvidence>;
  questionMemory: Record<string, QuestionMemoryState>;
  questions: SelectionQuestion[];
  config?: LearningConfig;
  nowIso?: string;
  decideFn?: DecisionsExecutor;
}): Promise<DailyFocusPlanResult> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const deterministic = buildDeterministicDailyFocusPlan({
    studentId: input.studentId,
    skillStates: input.skillStates,
    evidenceMap: input.evidenceMap,
    questionMemory: input.questionMemory,
    questions: input.questions,
    config: input.config,
    nowIso,
  });

  if (!input.decideFn && !isGeminiConfigured()) {
    return { plan: deterministic };
  }

  const candidateRows = computeRankedSkillCandidates({
    skillStates: input.skillStates,
    evidenceMap: input.evidenceMap,
    questionMemory: input.questionMemory,
    questions: input.questions,
    nowIso,
  });
  const availableBySection = countAvailableBySection(input.questions);

  try {
    const geminiPlan = await generateGeminiFocusOverride({
      basePlan: deterministic,
      candidates: candidateRows,
      availableBySection,
      autoCalibrate: input.config?.autoCalibrate,
      decideFn: input.decideFn,
    });
    return { plan: geminiPlan || deterministic };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Gemini Decisions 1 focus planning failed.';
    console.error('Stateless Gemini Decisions 1 focus plan failed:', message);
    return { plan: deterministic, error: message };
  }
}

export async function decidePracticeQuestionOrderWithGemini<
  T extends SelectionQuestion = QuestionItem,
>(input: {
  mode: SessionMode;
  sectionFilter?: SectionCode;
  difficulty?: DifficultyPreset;
  questions: T[];
  skillStates: Record<string, SkillState>;
  questionMemory: Record<string, QuestionMemoryState>;
  evidenceMap?: Record<string, QuestionMasteryEvidence>;
  dailyPlan?: DailyFocusPlan | null;
  questionCountOverride?: number;
  config: LearningConfig;
  nowIso: string;
  seed: number;
  decideFn?: DecisionsExecutor;
}): Promise<{ questions: T[]; decision: SessionSelectionDecision }> {
  const baseAdj = clampAlgorithmAdjustments(input.dailyPlan?.algorithmAdjustments);
  const dailyLimitsOverride =
    input.config.autoCalibrate?.enabled && input.dailyPlan?.dailyQuestionLimitBySection
      ? input.dailyPlan.dailyQuestionLimitBySection
      : undefined;
  const deterministicQuestions = selectPracticeSession({
    mode: input.mode,
    sectionFilter: input.sectionFilter,
    difficulty: input.difficulty,
    questions: input.questions,
    skillStates: input.skillStates,
    questionMemory: input.questionMemory,
    evidenceMap: input.evidenceMap,
    skillFocusWeights: input.dailyPlan?.skillWeights,
    algorithmAdjustments: baseAdj,
    dailyLimitsOverride,
    questionCountOverride: input.questionCountOverride,
    config: input.config,
    nowIso: input.nowIso,
    seed: input.seed,
  });

  const deterministicFallback = (rationale?: string): {
    questions: T[];
    decision: SessionSelectionDecision;
  } => ({
    questions: deterministicQuestions,
    decision: {
      source: 'deterministic',
      rationale:
        rationale ||
        input.dailyPlan?.rationale ||
        'Selected by deterministic SM-2 spaced review, 24h/7d retention checks, and skill priority scoring.',
      algorithmAdjustments: baseAdj,
    },
  });

  // Never alter canonical fixed benchmark/writing sessions, blended difficulty drills (which enforce
  // soft band quotas + shuffled ordering), or invoke Gemini when unconfigured.
  if (
    input.mode === 'benchmark_exam' ||
    input.mode === 'writing_sprint' ||
    Boolean(input.difficulty) ||
    deterministicQuestions.length <= 1 ||
    (!input.decideFn && !isGeminiConfigured())
  ) {
    return deterministicFallback();
  }

  const { candidates, targetCount, effectiveCaps } = selectPracticeCandidates({
    mode: input.mode,
    sectionFilter: input.sectionFilter,
    questions: input.questions,
    skillStates: input.skillStates,
    questionMemory: input.questionMemory,
    evidenceMap: input.evidenceMap,
    skillFocusWeights: input.dailyPlan?.skillWeights,
    algorithmAdjustments: baseAdj,
    dailyLimitsOverride,
    questionCountOverride: input.questionCountOverride,
    config: input.config,
    nowIso: input.nowIso,
    seed: input.seed,
    poolLimit: Math.max(24, deterministicQuestions.length * 2),
  });

  if (candidates.length === 0 || targetCount === 0) {
    return deterministicFallback();
  }

  // Metadata only — NEVER send prompts, options, answers, or explanations
  const metadataPayload = JSON.stringify({
    mode: input.mode,
    sectionFilter: input.sectionFilter || null,
    targetCount,
    sectionCaps: effectiveCaps || null,
    dailyFocusSkillIds: input.dailyPlan?.focusSkillIds || [],
    currentAdjustments: baseAdj,
    candidates: candidates.map((c) => ({
      questionId: c.q.questionId,
      section: c.q.section,
      formatType: c.q.formatType,
      skillId: c.q.parts[0]?.skillId || '',
      difficulty: c.avgDifficulty,
      basePriority: c.priority,
      isDue: c.isDue,
      isConfirmationDue: c.isConfirmationDue,
      isNeedsRepair: c.isNeedsRepair,
      isOnCooldown: c.isOnCooldown,
      meanSkillMastery: c.meanSkillMastery,
    })),
  });

  const questions: Record<string, DecisionQuestionSpec> = {
    review_emphasis: {
      type: 'score',
      instructions:
        'For this practice session, how strongly should spaced-repetition & confirmation reviews be prioritized?',
      criteria: ALGORITHM_SCORE_LEVELS,
    },
    weakness_emphasis: {
      type: 'score',
      instructions: 'For this practice session, how strongly should weaker skills be weighted?',
      criteria: ALGORITHM_SCORE_LEVELS,
    },
    novelty_emphasis: {
      type: 'score',
      instructions: 'For this practice session, how strongly should unseen/novel questions be favored?',
      criteria: ALGORITHM_SCORE_LEVELS,
    },
    zpd_challenge_step: {
      type: 'score',
      instructions: 'What ZPD difficulty offset fits the candidate skill mastery distribution?',
      criteria: ZPD_OFFSET_LEVELS,
    },
  };

  candidates.forEach((cand, idx) => {
    const skillId = cand.q.parts[0]?.skillId || '';
    questions[`q_${idx}`] = {
      type: 'score',
      instructions: `Rate selection priority for candidate question ${cand.q.questionId} (${cand.q.section}, ${cand.q.formatType}, skill=${skillId}, diff=${cand.avgDifficulty}, repair=${cand.isNeedsRepair}, confirmDue=${cand.isConfirmationDue}, sm2Due=${cand.isDue}, cooldown=${cand.isOnCooldown}, mastery=${cand.meanSkillMastery}).`,
      criteria: ITEM_SELECTION_LEVELS,
    };
  });

  let answers: DecisionAnswerMap;
  try {
    answers = await runDecisionsApi(metadataPayload, questions, input.decideFn);
  } catch {
    return deterministicFallback('Selected by the adaptive scheduler because Gemini Decisions was unavailable.');
  }

  const scoredCandidates = candidates
    .map((cand, idx) => {
      const ans = answers[`q_${idx}`];
      const decisionScore = ans?.type === 'score' && Number.isFinite(ans.score) ? ans.score : 2;
      return {
        cand,
        decisionScore,
        combinedRank: decisionScore * 10 + cand.priority,
      };
    })
    .filter(
      (row) =>
        row.cand.q.qcStatus === 'active' &&
        row.cand.q.poolType === 'practice' &&
        (!input.sectionFilter || row.cand.q.section === input.sectionFilter)
    )
    .sort((a, b) => b.combinedRank - a.combinedRank);

  // Keep Reading questions grouped cohesively by passage (`stimulusId`), while
  // ordering other sections with skill variety and respecting section caps.
  const readCap =
    input.sectionFilter === 'READ'
      ? targetCount
      : effectiveCaps
        ? Math.max(0, Number(effectiveCaps.READ ?? 0))
        : 0;

  const cohesiveReadBlocks: { rank: number; items: T[] }[] = [];
  const chosenReadIds = new Set<string>();
  if (readCap > 0) {
    const readRows = scoredCandidates.filter((row) => row.cand.q.section === 'READ');
    const rankById = new Map(readRows.map((row) => [row.cand.q.questionId, row.combinedRank]));
    const cohesiveRead = pickReadingCohesive(
      readRows.map((row) => ({ q: row.cand.q, priority: row.combinedRank })),
      Math.min(readCap, targetCount)
    );
    for (const item of cohesiveRead) {
      chosenReadIds.add(item.q.questionId);
      const qRank = rankById.get(item.q.questionId) ?? 0;
      const prevBlock = cohesiveReadBlocks[cohesiveReadBlocks.length - 1];
      if (prevBlock && item.q.stimulusId && prevBlock.items[0]?.stimulusId === item.q.stimulusId) {
        prevBlock.items.push(item.q);
        prevBlock.rank = Math.max(prevBlock.rank, qRank);
      } else {
        cohesiveReadBlocks.push({ rank: qRank, items: [item.q] });
      }
    }
  }

  // Pick non-READ items in priority order (avoiding identical consecutive skills when variety exists)
  const nonReadTarget = Math.max(0, targetCount - chosenReadIds.size);
  const nonReadChosen: { rank: number; q: T }[] = [];
  const seenIds = new Set<string>(chosenReadIds);
  const sectionCounts: Record<SectionCode, number> = {
    READ: chosenReadIds.size,
    MATH: 0,
    THINK: 0,
    WRIT: 0,
  };
  const remaining = scoredCandidates.filter((row) => row.cand.q.section !== 'READ');

  while (nonReadChosen.length < nonReadTarget && remaining.length > 0) {
    const lastSkill =
      nonReadChosen.length > 0 ? nonReadChosen[nonReadChosen.length - 1].q.parts[0]?.skillId : undefined;
    let pickIdx = remaining.findIndex((row) => {
      if (seenIds.has(row.cand.q.questionId)) return false;
      if (effectiveCaps) {
        const cap = Math.max(0, Number(effectiveCaps[row.cand.q.section] ?? 0));
        if (sectionCounts[row.cand.q.section] >= cap) return false;
      }
      const rowSkill = row.cand.q.parts[0]?.skillId;
      return !lastSkill || rowSkill !== lastSkill;
    });

    if (pickIdx === -1) {
      pickIdx = remaining.findIndex((row) => {
        if (seenIds.has(row.cand.q.questionId)) return false;
        if (effectiveCaps) {
          const cap = Math.max(0, Number(effectiveCaps[row.cand.q.section] ?? 0));
          if (sectionCounts[row.cand.q.section] >= cap) return false;
        }
        return true;
      });
    }

    if (pickIdx === -1) break;
    const [picked] = remaining.splice(pickIdx, 1);
    nonReadChosen.push({ rank: picked.combinedRank, q: picked.cand.q });
    seenIds.add(picked.cand.q.questionId);
    sectionCounts[picked.cand.q.section] += 1;
  }

  // Interleave cohesive Reading passage blocks with non-Reading items by rank so
  // the highest-priority item goes first while every Reading passage stays consecutive.
  const orderedBlocks: { rank: number; items: T[] }[] = [
    ...cohesiveReadBlocks,
    ...nonReadChosen.map((entry) => ({ rank: entry.rank, items: [entry.q] })),
  ].sort((a, b) => b.rank - a.rank);
  const chosen: T[] = orderedBlocks.flatMap((b) => b.items);

  if (chosen.length === 0) {
    return deterministicFallback();
  }

  const updatedAdj = extractAlgorithmAdjustmentsFromAnswers(answers);
  const repairsSelected = chosen.filter((q) => {
    const c = candidates.find((item) => item.q.questionId === q.questionId);
    return Boolean(c?.isNeedsRepair);
  }).length;
  const dueSelected = chosen.filter((q) => {
    const c = candidates.find((item) => item.q.questionId === q.questionId);
    return Boolean(c?.isConfirmationDue || c?.isDue);
  }).length;

  const rationaleParts = [`Ranked ${chosen.length} canonical items via gemini-decision-1`];
  if (repairsSelected > 0) rationaleParts.push(`${repairsSelected} repair`);
  if (dueSelected > 0) rationaleParts.push(`${dueSelected} spaced review`);

  return {
    questions: chosen,
    decision: {
      source: 'gemini',
      modelId: GEMINI_DECISION_MODEL,
      rationale: `${rationaleParts.join(' · ')}.`.slice(0, 280),
      algorithmAdjustments: updatedAdj,
    },
  };
}

