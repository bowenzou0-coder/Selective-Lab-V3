import { ThinkingLevel, Type } from '@google/genai';
import type {
  AlgorithmAdjustments,
  DailyFocusPlan,
  LearningConfig,
  QuestionItem,
  QuestionMasteryEvidence,
  QuestionMemoryState,
  SectionCode,
  SessionMode,
  SessionSelectionDecision,
  SkillState,
} from '../shared/contracts.ts';
import {
  clampAlgorithmAdjustments,
  selectPracticeCandidates,
  selectPracticeSession,
} from '../shared/engine.ts';
import { SKILLS_TAXONOMY, VALID_SKILL_IDS } from '../shared/skills.ts';
import {
  createGeminiClient,
  GEMINI_DECISION_MODEL,
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

export function buildDeterministicDailyFocusPlan(input: {
  studentId: string;
  skillStates: Record<string, SkillState>;
  evidenceMap: Record<string, QuestionMasteryEvidence>;
  questionMemory: Record<string, QuestionMemoryState>;
  questions: QuestionItem[];
  nowIso?: string;
}): DailyFocusPlan {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const planDate = nowIso.slice(0, 10);
  const ranked = computeRankedSkillCandidates(input);

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
      ? `${rationaleParts.join(' · ')}.`
      : 'Balanced Reading, Maths, and Thinking Skills coverage across unseen and developing areas.';

  const recommendedSection =
    chosen[0] && (chosen[0].section === 'READ' || chosen[0].section === 'MATH' || chosen[0].section === 'THINK')
      ? chosen[0].section
      : undefined;

  return {
    planDate,
    studentId: input.studentId,
    generatedAtIso: nowIso,
    source: 'deterministic',
    focusSkillIds,
    skillWeights,
    algorithmAdjustments: clampAlgorithmAdjustments(),
    recommendedSection,
    rationale,
  };
}

export async function generateGeminiFocusOverride(input: {
  basePlan: DailyFocusPlan;
  candidates: FocusPlanSummaryRow[];
  generateTextFn?: (payloadJson: string) => Promise<string>;
}): Promise<DailyFocusPlan | null> {
  if (!input.generateTextFn && !isGeminiConfigured()) {
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

  const payloadJson = JSON.stringify({
    date: input.basePlan.planDate,
    candidateSkills: topCandidates,
  });

  const rawText = input.generateTextFn
    ? await input.generateTextFn(payloadJson)
    : await withGeminiRetry(async () => {
        const ai = createGeminiClient();
        const response = await ai.models.generateContent({
          model: GEMINI_DECISION_MODEL,
          contents: payloadJson,
          config: {
            systemInstruction: [
              'You are the Gemini Decisions 1 scheduling engine for Selective Lab (NSW Selective exam training).',
              'You NEVER generate questions, prompts, or answers — you only decide skill priorities and bounded algorithm multipliers from telemetry.',
              'Given the candidate skill metrics, select 3 to 5 focusSkillIds, assign per-skill multiplier weights strictly between 0.85 and 1.35,',
              'tune algorithmAdjustments (multipliers in 0.75..1.35 and zpdDifficultyOffset in -0.75..0.75), pick recommendedSection (READ, MATH, or THINK), and write one concise 1-sentence study rationale.',
            ].join(' '),
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            abortSignal: AbortSignal.timeout(4000),
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                focusSkillIds: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                },
                weights: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      skillId: { type: Type.STRING },
                      weight: { type: Type.NUMBER },
                    },
                    required: ['skillId', 'weight'],
                  },
                },
                algorithmAdjustments: {
                  type: Type.OBJECT,
                  properties: {
                    spacedReviewWeightMultiplier: { type: Type.NUMBER },
                    weakestSkillWeightMultiplier: { type: Type.NUMBER },
                    noveltyCoverageWeightMultiplier: { type: Type.NUMBER },
                    zpdDifficultyOffset: { type: Type.NUMBER },
                  },
                },
                recommendedSection: { type: Type.STRING },
                rationale: { type: Type.STRING },
              },
              required: ['focusSkillIds', 'weights', 'rationale'],
            },
          },
        });
        return (response.text ?? '').trim();
      });

  if (!rawText) return null;
  const parsed = JSON.parse(rawText) as {
    focusSkillIds?: string[];
    weights?: { skillId: string; weight: number }[];
    algorithmAdjustments?: AlgorithmAdjustments;
    recommendedSection?: string;
    rationale?: string;
  };

  const validFocusIds = Array.from(
    new Set((parsed.focusSkillIds || []).filter((id) => typeof id === 'string' && VALID_SKILL_IDS.has(id)))
  ).slice(0, 5);
  if (validFocusIds.length === 0) return null;

  const skillWeights: Record<string, number> = {};
  for (const w of parsed.weights || []) {
    if (w && typeof w.skillId === 'string' && VALID_SKILL_IDS.has(w.skillId)) {
      skillWeights[w.skillId] = clampSkillWeight(Number(w.weight));
    }
  }
  for (const id of validFocusIds) {
    if (skillWeights[id] === undefined) {
      skillWeights[id] = 1.2;
    }
  }

  const validSections = new Set(['READ', 'MATH', 'THINK']);
  const recommendedSection =
    typeof parsed.recommendedSection === 'string' && validSections.has(parsed.recommendedSection)
      ? (parsed.recommendedSection as DailyFocusPlan['recommendedSection'])
      : input.basePlan.recommendedSection;

  const rationale =
    typeof parsed.rationale === 'string' && parsed.rationale.trim()
      ? parsed.rationale.trim().slice(0, 280)
      : input.basePlan.rationale;

  return {
    ...input.basePlan,
    source: 'gemini',
    modelId: GEMINI_DECISION_MODEL,
    focusSkillIds: validFocusIds,
    skillWeights,
    algorithmAdjustments: clampAlgorithmAdjustments(parsed.algorithmAdjustments),
    recommendedSection,
    rationale,
  };
}

export async function getOrCreateDailyFocusPlan(input: {
  repo: AppRepository;
  studentId: string;
  skillStates: Record<string, SkillState>;
  evidenceMap: Record<string, QuestionMasteryEvidence>;
  questionMemory: Record<string, QuestionMemoryState>;
  questions: QuestionItem[];
  nowIso?: string;
}): Promise<DailyFocusPlan> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const planDate = nowIso.slice(0, 10);

  const cached = await input.repo.getDailyFocusPlan(input.studentId, planDate).catch(() => null);
  if (cached && cached.focusSkillIds.length > 0) {
    return cached;
  }

  const deterministic = buildDeterministicDailyFocusPlan({
    studentId: input.studentId,
    skillStates: input.skillStates,
    evidenceMap: input.evidenceMap,
    questionMemory: input.questionMemory,
    questions: input.questions,
    nowIso,
  });

  // Pass real computed skill telemetry to Gemini Decisions 1 (at most once/day per student)
  let plan = deterministic;
  try {
    const candidateRows = computeRankedSkillCandidates({
      skillStates: input.skillStates,
      evidenceMap: input.evidenceMap,
      questionMemory: input.questionMemory,
      questions: input.questions,
      nowIso,
    });
    const geminiPlan = await generateGeminiFocusOverride({
      basePlan: deterministic,
      candidates: candidateRows,
    });
    if (geminiPlan) {
      plan = geminiPlan;
    }
  } catch (err) {
    console.warn(
      'Daily Gemini focus plan fell back to deterministic planner:',
      err instanceof Error ? err.message : err
    );
  }

  await input.repo.saveDailyFocusPlan(input.studentId, plan).catch(() => undefined);
  return plan;
}

export async function decidePracticeQuestionOrderWithGemini(input: {
  mode: SessionMode;
  sectionFilter?: SectionCode;
  questions: QuestionItem[];
  skillStates: Record<string, SkillState>;
  questionMemory: Record<string, QuestionMemoryState>;
  evidenceMap?: Record<string, QuestionMasteryEvidence>;
  dailyPlan?: DailyFocusPlan | null;
  config: LearningConfig;
  nowIso: string;
  seed: number;
  generateTextFn?: (payloadJson: string) => Promise<string>;
}): Promise<{ questions: QuestionItem[]; decision: SessionSelectionDecision }> {
  const baseAdj = clampAlgorithmAdjustments(input.dailyPlan?.algorithmAdjustments);
  const deterministicQuestions = selectPracticeSession({
    mode: input.mode,
    sectionFilter: input.sectionFilter,
    questions: input.questions,
    skillStates: input.skillStates,
    questionMemory: input.questionMemory,
    evidenceMap: input.evidenceMap,
    skillFocusWeights: input.dailyPlan?.skillWeights,
    algorithmAdjustments: baseAdj,
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

  // Never alter canonical fixed benchmark/writing sessions or run Gemini without a key
  if (
    input.mode === 'benchmark_exam' ||
    input.mode === 'writing_sprint' ||
    deterministicQuestions.length <= 1 ||
    (!input.generateTextFn && !isGeminiConfigured())
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
    config: input.config,
    nowIso: input.nowIso,
    seed: input.seed,
    poolLimit: 24,
  });

  if (candidates.length === 0 || targetCount === 0) {
    return deterministicFallback();
  }

  const candidateById = new Map(candidates.map((c) => [c.q.questionId, c.q]));
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

  try {
    const rawText = input.generateTextFn
      ? await input.generateTextFn(metadataPayload)
      : await withGeminiRetry(async () => {
          const ai = createGeminiClient();
          const response = await ai.models.generateContent({
            model: GEMINI_DECISION_MODEL,
            contents: metadataPayload,
            config: {
              systemInstruction: [
                'You are the Gemini Decisions 1 question-selection and pacing engine for Selective Lab.',
                'You NEVER create questions or answers. Pick and order exactly targetCount existing questionIds from the provided candidates array.',
                'If sectionCaps is provided, obey the exact maximum per section. Avoid repeating the same skillId consecutively when variety exists.',
                'Prioritize repair items, spaced confirmation due items, and focus skills while pacing difficulty cleanly.',
                'Return valid candidate questionIds plus a concise 1-sentence selectionRationale.',
              ].join(' '),
              thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
              abortSignal: AbortSignal.timeout(3500),
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  selectedQuestionIds: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                  algorithmAdjustments: {
                    type: Type.OBJECT,
                    properties: {
                      spacedReviewWeightMultiplier: { type: Type.NUMBER },
                      weakestSkillWeightMultiplier: { type: Type.NUMBER },
                      noveltyCoverageWeightMultiplier: { type: Type.NUMBER },
                      zpdDifficultyOffset: { type: Type.NUMBER },
                    },
                  },
                  selectionRationale: { type: Type.STRING },
                },
                required: ['selectedQuestionIds', 'selectionRationale'],
              },
            },
          });
          return (response.text ?? '').trim();
        });

    if (!rawText) return deterministicFallback();
    const parsed = JSON.parse(rawText) as {
      selectedQuestionIds?: string[];
      algorithmAdjustments?: AlgorithmAdjustments;
      selectionRationale?: string;
    };

    const chosen: QuestionItem[] = [];
    const seenIds = new Set<string>();
    const sectionCounts: Record<SectionCode, number> = { READ: 0, MATH: 0, THINK: 0, WRIT: 0 };

    for (const rawId of parsed.selectedQuestionIds || []) {
      if (chosen.length >= targetCount) break;
      if (typeof rawId !== 'string' || seenIds.has(rawId)) continue;
      const cand = candidateById.get(rawId);
      if (!cand) continue;
      if (cand.qcStatus !== 'active' || cand.poolType === 'benchmark_holdout') continue;
      if (input.sectionFilter && cand.section !== input.sectionFilter) continue;
      if (effectiveCaps) {
        const cap = Math.max(0, Number(effectiveCaps[cand.section] ?? 0));
        if (sectionCounts[cand.section] >= cap) continue;
      }
      chosen.push(cand);
      seenIds.add(rawId);
      sectionCounts[cand.section] += 1;
    }

    if (chosen.length === 0) {
      return deterministicFallback();
    }

    // Backfill deterministically if Gemini returned fewer than targetCount valid IDs
    const updatedAdj = parsed.algorithmAdjustments
      ? clampAlgorithmAdjustments(parsed.algorithmAdjustments)
      : baseAdj;
    if (chosen.length < targetCount) {
      const backfillSource = parsed.algorithmAdjustments
        ? selectPracticeSession({
            mode: input.mode,
            sectionFilter: input.sectionFilter,
            questions: input.questions,
            skillStates: input.skillStates,
            questionMemory: input.questionMemory,
            evidenceMap: input.evidenceMap,
            skillFocusWeights: input.dailyPlan?.skillWeights,
            algorithmAdjustments: updatedAdj,
            config: input.config,
            nowIso: input.nowIso,
            seed: input.seed,
          })
        : deterministicQuestions;
      for (const q of backfillSource) {
        if (chosen.length >= targetCount) break;
        if (seenIds.has(q.questionId)) continue;
        if (effectiveCaps) {
          const cap = Math.max(0, Number(effectiveCaps[q.section] ?? 0));
          if (sectionCounts[q.section] >= cap) continue;
        }
        chosen.push(q);
        seenIds.add(q.questionId);
        sectionCounts[q.section] += 1;
      }
    }

    const rationale =
      typeof parsed.selectionRationale === 'string' && parsed.selectionRationale.trim()
        ? parsed.selectionRationale.trim().slice(0, 280)
        : 'Curated and sequenced from canonical bank candidates by Gemini Decisions 1.';

    return {
      questions: chosen,
      decision: {
        source: 'gemini',
        modelId: GEMINI_DECISION_MODEL,
        rationale,
        algorithmAdjustments: updatedAdj,
      },
    };
  } catch (err) {
    console.warn(
      'Session Gemini decision engine fell back to deterministic ordering:',
      err instanceof Error ? err.message : err
    );
    return deterministicFallback();
  }
}
