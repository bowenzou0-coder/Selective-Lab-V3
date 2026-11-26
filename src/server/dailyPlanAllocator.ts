/**
 * Pure, deterministic daily-plan maths: skill ranking, auto-calibrated section allocation and the
 * fallback focus plan. No Gemini calls or repository access live here (see geminiPlanner.ts).
 */
import {
  DEFAULT_AUTO_CALIBRATE,
  type AutoCalibrateConfig,
  type DailyFocusPlan,
  type LearningConfig,
  type QuestionMasteryEvidence,
  type QuestionMemoryState,
  type SectionCode,
  type SkillState,
} from '../shared/contracts.ts';
import { clampAlgorithmAdjustments, type SelectionQuestion } from '../shared/engine.ts';
import { SKILLS_TAXONOMY, VALID_SKILL_IDS } from '../shared/skills.ts';


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
  questions: SelectionQuestion[];
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
  const minQ = Math.max(3, Math.min(30, Math.round(cfg.minDailyQuestions || 20)));
  const maxQ = Math.max(minQ, Math.min(40, Math.round(cfg.maxDailyQuestions || 40)));
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
    // Balanced weight curve (2.0..5.0 -> max ~2.5x skew) so urgent sections get more
    // questions without starving Reading/Maths/Thinking into extreme lopsided splits.
    const weights: Record<'READ' | 'MATH' | 'THINK', number> = { READ: 2, MATH: 2, THINK: 2 };
    let weightSum = 0;
    for (const sec of activeObjSections) {
      const s = Math.min(4, Math.max(0, Number.isFinite(input.sectionScores[sec]) ? input.sectionScores[sec] : 2));
      const w = 2.0 + s * 0.75;
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

  // Target ~1 minute per objective question (+30 minutes when a Writing sprint is scheduled)
  const objCount = allocation.READ + allocation.MATH + allocation.THINK;
  const rawMinutes = objCount * 1.0 + writingCount * 30;
  const dailyGoalMinutes = Math.max(5, Math.min(90, Math.round(rawMinutes)));

  return { dailyQuestionLimitBySection: allocation, dailyGoalMinutes };
}

export function countAvailableBySection(questions: SelectionQuestion[]): Record<SectionCode, number> {
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
  questions: SelectionQuestion[];
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
    const volScore =
      totalRepairs === 0 && totalDue === 0
        ? 2
        : Math.min(4, Math.max(1, 1.8 + (totalRepairs + totalDue) * 0.2));
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
