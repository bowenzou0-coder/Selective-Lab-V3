import {
  DEFAULT_AUTO_CALIBRATE,
  type AlgorithmAdjustments,
  type AutoCalibrateConfig,
  type DailyFocusPlan,
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
  selectPracticeCandidates,
  selectPracticeSession,
} from '../shared/engine.ts';
import { SKILLS_TAXONOMY, VALID_SKILL_IDS } from '../shared/skills.ts';
import {
  createDecisionsClient,
  GEMINI_DECISION_MODEL,
  GeminiServiceError,
  isGeminiConfigured,
  withGeminiRetry,
} from './geminiClient.ts';
import type { AppRepository } from './storage/repository.ts';

const WEIGHT_MIN = 0.85;
const WEIGHT_MAX = 1.35;

export function clampSkillWeight(weight: number): number {
  if (!Number.isFinite(weight)) return 1.0;
  return Number(Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, weight)).toFixed(2));
}

export interface FocusPlanSummaryRow {
  skillId: string;
  section: string;
  displayName: string;
  masteryScore: number;
  ewmaAccuracy: number;
  avgTimeRatio: number;
  attemptsCount: number;
  plateauStatus: string;
  repairCount: number;
  dueReviewCount: number;
  unseenCount: number;
  urgency: number;
}

export function computeRankedSkillCandidates(input: {
  skillStates: Record<string, SkillState>;
  evidenceMap: Record<string, QuestionMasteryEvidence>;
  questionMemory: Record<string, QuestionMemoryState>;
  questions: QuestionItem[];
  nowIso?: string;
}): FocusPlanSummaryRow[] {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const skillMeta = new Map(SKILLS_TAXONOMY.map((s) => [s.skillId, s]));
  const eligible = input.questions.filter(
    (q) => q.qcStatus === 'active' && q.poolType !== 'benchmark_holdout' && q.section !== 'WRIT'
  );

  const perSkillCounts = new Map<
    string,
    { repairCount: number; dueReviewCount: number; unseenCount: number }
  >();

  for (const q of eligible) {
    const primarySkill = q.parts[0]?.skillId;
    if (!primarySkill || !VALID_SKILL_IDS.has(primarySkill)) continue;
    const entry = perSkillCounts.get(primarySkill) || {
      repairCount: 0,
      dueReviewCount: 0,
      unseenCount: 0,
    };

    const evKey = q.evidenceRevision ? `${q.questionFamilyId}__${q.evidenceRevision}` : '';
    let ev = evKey ? input.evidenceMap[evKey] : undefined;
    if (!ev) {
      const prefix = `${q.questionFamilyId}__`;
      for (const [k, v] of Object.entries(input.evidenceMap)) {
        if (k.startsWith(prefix)) {
          ev = v;
          break;
        }
      }
    }

    const mem = input.questionMemory[q.questionFamilyId];
    const isRepair = ev?.status === 'needs_repair';
    const isConfirmDue = Boolean(
      ev &&
        (ev.status === 'correct_once' || ev.status === 'awaiting_review') &&
        ev.nextEligibleAtIso &&
        Date.parse(ev.nextEligibleAtIso) <= nowMs
    );
    const isSm2Due = Boolean(mem && Date.parse(mem.nextDueAt) <= nowMs);

    if (isRepair) entry.repairCount++;
    if (isConfirmDue || isSm2Due) entry.dueReviewCount++;
    if (!mem && (!ev || ev.status === 'unseen')) entry.unseenCount++;
    perSkillCounts.set(primarySkill, entry);
  }

  const ranked: FocusPlanSummaryRow[] = [];
  for (const [skillId, counts] of perSkillCounts.entries()) {
    const def = skillMeta.get(skillId);
    const st = input.skillStates[skillId];
    const masteryScore = st?.masteryScore ?? 0.5;
    const ewmaAccuracy = st?.ewmaAccuracy ?? 0.5;
    const avgTimeRatio = st?.avgTimeRatio ?? 1.0;
    const plateauBonus = st?.plateauStatus === 'detected' ? 0.45 : st?.plateauStatus === 'watch' ? 0.2 : 0;
    const urgency =
      (1 - masteryScore) * 1.4 +
      counts.repairCount * 0.45 +
      counts.dueReviewCount * 0.35 +
      Math.min(3, counts.unseenCount) * 0.1 +
      plateauBonus;
    ranked.push({
      skillId,
      section: def?.section || 'MATH',
      displayName: def?.displayName || skillId,
      masteryScore,
      ewmaAccuracy,
      avgTimeRatio,
      attemptsCount: st?.attemptsCount ?? 0,
      plateauStatus: st?.plateauStatus || 'none',
      repairCount: counts.repairCount,
      dueReviewCount: counts.dueReviewCount,
      unseenCount: counts.unseenCount,
      urgency: Number(urgency.toFixed(3)),
    });
  }

  ranked.sort((a, b) => b.urgency - a.urgency);
  return ranked;
}

export function allocateAutoCalibratedDailyPlan(input: {
  volumeScore: number; // [0..4]
  sectionScores: Record<'READ' | 'MATH' | 'THINK', number>; // each [0..4]
  includeWriting: boolean;
  availableBySection: Record<SectionCode, number>;
  autoConfig?: AutoCalibrateConfig;
}): {
  dailyQuestionLimitBySection: Record<SectionCode, number>;
  dailyGoalMinutes: number;
} {
  const cfg = {
    ...DEFAULT_AUTO_CALIBRATE,
    ...(input.autoConfig || {}),
  };
  const minQ = Math.max(3, Math.min(30, Math.round(cfg.minDailyQuestions || 6)));
  const maxQ = Math.max(minQ, Math.min(40, Math.round(cfg.maxDailyQuestions || 14)));
  const clampedVol = Math.min(4, Math.max(0, Number.isFinite(input.volumeScore) ? input.volumeScore : 2));
  const rawTotal = Math.round(minQ + (clampedVol / 4) * (maxQ - minQ));

  const objSections: Array<'READ' | 'MATH' | 'THINK'> = ['READ', 'MATH', 'THINK'];
  const activeObjSections = objSections.filter((s) => (input.availableBySection[s] || 0) > 0);
  const totalAvailableObj = activeObjSections.reduce(
    (sum, s) => sum + Math.max(0, input.availableBySection[s] || 0),
    0
  );
  const targetObjTotal = Math.min(rawTotal, totalAvailableObj);

  const allocation: Record<SectionCode, number> = { READ: 0, MATH: 0, THINK: 0, WRIT: 0 };

  if (targetObjTotal > 0 && activeObjSections.length > 0) {
    // Exponentially amplify rubric score differences so a high-urgency section gets clearly more questions
    const weights: Record<'READ' | 'MATH' | 'THINK', number> = { READ: 0, MATH: 0, THINK: 0 };
    let weightSum = 0;
    for (const sec of activeObjSections) {
      const s = Math.min(4, Math.max(0, Number.isFinite(input.sectionScores[sec]) ? input.sectionScores[sec] : 2));
      const w = 0.5 + Math.pow(s + 0.4, 1.5);
      weights[sec] = w;
      weightSum += w;
    }

    // Proportional allocation with largest-remainder rounding, clamped to available stock
    const exactShares = activeObjSections.map((sec) => {
      const exact = (weights[sec] / Math.max(0.001, weightSum)) * targetObjTotal;
      const base = Math.min(input.availableBySection[sec], Math.floor(exact));
      return { sec, base, frac: exact - Math.floor(exact) };
    });

    let assigned = 0;
    for (const row of exactShares) {
      allocation[row.sec] = row.base;
      assigned += row.base;
    }

    // Distribute remaining slots by highest fractional remainder
    const byFrac = [...exactShares].sort((a, b) => b.frac - a.frac);
    let safety = 0;
    while (assigned < targetObjTotal && safety < 50) {
      safety++;
      let progressed = false;
      for (const row of byFrac) {
        if (assigned >= targetObjTotal) break;
        if (allocation[row.sec] < input.availableBySection[row.sec]) {
          allocation[row.sec] += 1;
          assigned += 1;
          progressed = true;
        }
      }
      if (!progressed) break;
    }
  }

  const writingCount =
    cfg.includeWriting && input.includeWriting && (input.availableBySection.WRIT || 0) > 0 ? 1 : 0;
  allocation.WRIT = writingCount;

  const objCount = allocation.READ + allocation.MATH + allocation.THINK;
  const rawMinutes = objCount * 2.2 + writingCount * 25;
  const dailyGoalMinutes = Math.max(10, Math.min(90, Math.round(rawMinutes / 5) * 5));

  return { dailyQuestionLimitBySection: allocation, dailyGoalMinutes };
}

function countAvailableBySection(questions: QuestionItem[]): Record<SectionCode, number> {
  const counts: Record<SectionCode, number> = { READ: 0, MATH: 0, THINK: 0, WRIT: 0 };
  for (const q of questions) {
    if (q.qcStatus === 'active' && q.poolType !== 'benchmark_holdout') {
      counts[q.section] = (counts[q.section] || 0) + 1;
    }
  }
  return counts;
}

export function buildDeterministicDailyFocusPlan(input: {
  studentId: string;
  skillStates: Record<string, SkillState>;
  evidenceMap: Record<string, QuestionMasteryEvidence>;
  questionMemory: Record<string, QuestionMemoryState>;
  questions: QuestionItem[];
  config?: LearningConfig;
  nowIso?: string;
}): DailyFocusPlan {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const planDate = nowIso.slice(0, 10);
  const ranked = computeRankedSkillCandidates(input);
  const availableBySection = countAvailableBySection(input.questions);

  const chosen: FocusPlanSummaryRow[] = [];
  const chosenIds = new Set<string>();
  // Pick at least one top skill per available section if available, then top overall
  for (const sec of ['READ', 'MATH', 'THINK'] as const) {
    const topForSec = ranked.find((r) => r.section === sec && !chosenIds.has(r.skillId));
    if (topForSec) {
      chosen.push(topForSec);
      chosenIds.add(topForSec.skillId);
    }
  }
  for (const r of ranked) {
    if (chosen.length >= 5) break;
    if (!chosenIds.has(r.skillId)) {
      chosen.push(r);
      chosenIds.add(r.skillId);
    }
  }

  const skillWeights: Record<string, number> = {};
  chosen.forEach((row, idx) => {
    const boost = Math.max(1.05, 1.3 - idx * 0.05);
    skillWeights[row.skillId] = clampSkillWeight(boost);
  });

  const focusSkillIds = chosen.map((c) => c.skillId);
  const topNames = chosen.slice(0, 3).map((c) => c.displayName);
  const totalRepairs = ranked.reduce((s, r) => s + r.repairCount, 0);
  const totalDue = ranked.reduce((s, r) => s + r.dueReviewCount, 0);
  const rationaleParts: string[] = [];
  if (topNames.length > 0) {
    rationaleParts.push(`Prioritising ${topNames.join(', ')}`);
  }
  if (totalRepairs > 0) {
    rationaleParts.push(`${totalRepairs} repair item${totalRepairs === 1 ? '' : 's'} queued`);
  }
  if (totalDue > 0) {
    rationaleParts.push(`${totalDue} spaced confirmation review${totalDue === 1 ? '' : 's'} due`);
  }
  const rationale =
    rationaleParts.length > 0
      ? `${rationaleParts.join(', ')}.`
      : 'Balanced Reading, Maths, and Thinking Skills coverage across unseen and developing areas.';

  const recommendedSection =
    chosen[0] && (chosen[0].section === 'READ' || chosen[0].section === 'MATH' || chosen[0].section === 'THINK')
      ? chosen[0].section
      : undefined;

  const autoCfg = input.config?.autoCalibrate;
  let dailyQuestionLimitBySection: Record<SectionCode, number> | undefined;
  let dailyGoalMinutes: number | undefined;
  let autoCalibrated = false;

  if (autoCfg?.enabled) {
    const secUrgency = { READ: 1.5, MATH: 1.5, THINK: 1.5 };
    for (const sec of ['READ', 'MATH', 'THINK'] as const) {
      const secRows = ranked.filter((r) => r.section === sec);
      if (secRows.length > 0) {
        const avgUrg = secRows.reduce((s, r) => s + r.urgency, 0) / secRows.length;
        secUrgency[sec] = Math.min(4, Math.max(0.5, avgUrg * 1.4));
      }
    }
    const volScore = Math.min(4, Math.max(1, 1.5 + (totalRepairs + totalDue) * 0.25));
    const allocated = allocateAutoCalibratedDailyPlan({
      volumeScore: volScore,
      sectionScores: secUrgency,
      includeWriting: false,
      availableBySection,
      autoConfig: autoCfg,
    });
    dailyQuestionLimitBySection = allocated.dailyQuestionLimitBySection;
    dailyGoalMinutes = allocated.dailyGoalMinutes;
    autoCalibrated = true;
  }

  return {
    planDate,
    studentId: input.studentId,
    generatedAtIso: nowIso,
    source: 'deterministic',
    focusSkillIds,
    skillWeights,
    algorithmAdjustments: clampAlgorithmAdjustments(),
    recommendedSection,
    dailyQuestionLimitBySection,
    dailyGoalMinutes,
    autoCalibrated,
    rationale,
  };
}

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

async function runDecisionsApi(
  inputText: string,
  questions: Record<string, DecisionQuestionSpec>,
  decideFn?: DecisionsExecutor
): Promise<DecisionAnswerMap> {
  if (decideFn) {
    return decideFn({ inputText, questions });
  }
  return withGeminiRetry(async () => {
    const decisionsAi = createDecisionsClient();
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

type DailyFocusPlanInput = {
  repo: AppRepository;
  studentId: string;
  skillStates: Record<string, SkillState>;
  evidenceMap: Record<string, QuestionMasteryEvidence>;
  questionMemory: Record<string, QuestionMemoryState>;
  questions: QuestionItem[];
  config?: LearningConfig;
  forceRefresh?: boolean;
  nowIso?: string;
  decideFn?: DecisionsExecutor;
};

type DailyFocusPlanResult = { plan: DailyFocusPlan; error?: string };
const dailyFocusInFlight = new WeakMap<AppRepository, Map<string, Promise<DailyFocusPlanResult>>>();

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

  if (!input.forceRefresh) {
    const cached = await input.repo.getDailyFocusPlan(input.studentId, planDate).catch(() => null);
    if (
      cached &&
      cached.focusSkillIds.length > 0 &&
      (cached.source === 'deterministic' || cached.modelId === GEMINI_DECISION_MODEL)
    ) {
      return { plan: cached };
    }
  }

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
    await input.repo.saveDailyFocusPlan(input.studentId, deterministic).catch(() => undefined);
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
  questions: QuestionItem[];
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

export async function decidePracticeQuestionOrderWithGemini(input: {
  mode: SessionMode;
  sectionFilter?: SectionCode;
  questions: QuestionItem[];
  skillStates: Record<string, SkillState>;
  questionMemory: Record<string, QuestionMemoryState>;
  evidenceMap?: Record<string, QuestionMasteryEvidence>;
  dailyPlan?: DailyFocusPlan | null;
  questionCountOverride?: number;
  config: LearningConfig;
  nowIso: string;
  seed: number;
  decideFn?: DecisionsExecutor;
}): Promise<{ questions: QuestionItem[]; decision: SessionSelectionDecision }> {
  const baseAdj = clampAlgorithmAdjustments(input.dailyPlan?.algorithmAdjustments);
  const dailyLimitsOverride =
    input.config.autoCalibrate?.enabled && input.dailyPlan?.dailyQuestionLimitBySection
      ? input.dailyPlan.dailyQuestionLimitBySection
      : undefined;
  const deterministicQuestions = selectPracticeSession({
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
  });

  const deterministicFallback = (rationale?: string): {
    questions: QuestionItem[];
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

  // Never alter canonical fixed benchmark/writing sessions or invoke Gemini when unconfigured
  if (
    input.mode === 'benchmark_exam' ||
    input.mode === 'writing_sprint' ||
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
    poolLimit: 24,
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
        row.cand.q.poolType !== 'benchmark_holdout' &&
        (!input.sectionFilter || row.cand.q.section === input.sectionFilter)
    )
    .sort((a, b) => b.combinedRank - a.combinedRank);

  // Order cleanly while respecting section caps and avoiding identical consecutive skills when variety exists
  const chosen: QuestionItem[] = [];
  const seenIds = new Set<string>();
  const sectionCounts: Record<SectionCode, number> = { READ: 0, MATH: 0, THINK: 0, WRIT: 0 };
  const remaining = [...scoredCandidates];

  while (chosen.length < targetCount && remaining.length > 0) {
    const lastSkill = chosen.length > 0 ? chosen[chosen.length - 1].parts[0]?.skillId : undefined;
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
    chosen.push(picked.cand.q);
    seenIds.add(picked.cand.q.questionId);
    sectionCounts[picked.cand.q.section] += 1;
  }

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

