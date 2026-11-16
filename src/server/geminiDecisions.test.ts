import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_LEARNING_CONFIG, type QuestionItem } from '../shared/contracts.ts';
import {
  GEMINI_DECISION_MODEL,
  GEMINI_WRITING_MODEL,
  normalizeGeminiError,
} from './geminiClient.ts';
import {
  buildDeterministicDailyFocusPlan,
  computeRankedSkillCandidates,
  decidePracticeQuestionOrderWithGemini,
  generateGeminiFocusOverride,
} from './geminiPlanner.ts';
import {
  evaluateWritingWithGemini,
  normalizeWritingEvaluationCriteria,
  WRITING_CRITERIA,
} from './geminiWriting.ts';

function makeQuestion(
  id: string,
  section: 'READ' | 'MATH' | 'THINK' | 'WRIT',
  skillId: string,
  poolType: QuestionItem['poolType'] = 'practice',
  difficulty = 3.0
): QuestionItem {
  return {
    questionId: `${id}_v1`,
    questionFamilyId: id,
    version: 1,
    evidenceRevision: `ev_${id}`,
    section,
    formatType:
      section === 'READ'
        ? 'READ_FICTION_MCQ'
        : section === 'MATH'
          ? 'MATH_MCQ_5'
          : section === 'THINK'
            ? 'THINK_MCQ_4'
            : 'WRIT_TYPED_TASK',
    poolType,
    qcStatus: 'active',
    parts: [
      {
        partId: `${id}_p1`,
        partIndex: 0,
        promptText: `TOP_SECRET_PROMPT_${id}`,
        skillId,
        difficultyInitial: difficulty,
        targetTimeSec: 60,
        cognitiveDemand: 'apply_procedural',
        options: [
          { key: 'A', text: 'Option A' },
          { key: 'B', text: 'Option B' },
        ],
        correctAnswerKey: 'A',
        workedExplanation: `TOP_SECRET_EXPLANATION_${id}`,
      },
    ],
    provenance: {
      sourceType: 'human_authored',
      verifierAgreed: true,
      auditorReviewed: true,
    },
  };
}

test('Gemini client exports gemini-4-hydrogen and normalizes HTTP errors cleanly', () => {
  assert.equal(GEMINI_DECISION_MODEL, 'gemini-4-hydrogen');
  assert.equal(GEMINI_WRITING_MODEL, 'gemini-4-hydrogen');

  const e403 = normalizeGeminiError(new Error('403 PERMISSION_DENIED: invalid key'));
  assert.equal(e403.statusCode, 403);
  assert.match(e403.message, /Settings > Secrets/);

  const e429 = normalizeGeminiError(new Error('429 RESOURCE_EXHAUSTED'));
  assert.equal(e429.statusCode, 429);

  const e404 = normalizeGeminiError(new Error('404 NOT_FOUND'));
  assert.equal(e404.statusCode, 502);
  assert.match(e404.message, /gemini-4-hydrogen/);
});

test('computeRankedSkillCandidates preserves real repair/due/unseen counts and generateGeminiFocusOverride clamps multipliers', async () => {
  const qRepair = makeQuestion('q_rep', 'MATH', 'MATH.GEO2D.COMPOSITE_AREA');
  const qUnseen = makeQuestion('q_uns', 'READ', 'READ.FIC.CHARACTER_INFERENCE');
  const qThink = makeQuestion('q_thk', 'THINK', 'THINK.DEDUCT.SET_SYLLOGISMS');

  const ranked = computeRankedSkillCandidates({
    questions: [qRepair, qUnseen, qThink],
    skillStates: {
      'MATH.GEO2D.COMPOSITE_AREA': {
        skillId: 'MATH.GEO2D.COMPOSITE_AREA',
        masteryScore: 0.3,
        uncertainty: 0.2,
        attemptsCount: 5,
        correctCount: 2,
        ewmaAccuracy: 0.35,
        avgTimeRatio: 1.3,
        reviewIntervalDays: 1,
        easeFactor: 2.2,
        plateauStatus: 'watch',
      },
    },
    evidenceMap: {
      q_rep__ev_q_rep: {
        evidenceKey: 'q_rep__ev_q_rep',
        questionFamilyId: 'q_rep',
        questionId: 'q_rep_v1',
        evidenceRevision: 'ev_q_rep',
        section: 'MATH',
        status: 'needs_repair',
        cleanPassesCount: 0,
        passTimestampsIso: [],
        everCleanPassed: false,
        firstSubmissionCleanPass: false,
        attemptsCount: 1,
        resetCount: 1,
        lastAllCorrect: false,
        policyVersion: 'v3_3stage_24h_7d',
        updatedAtIso: '2026-11-14T00:00:00Z',
      },
    },
    questionMemory: {},
    nowIso: '2026-11-15T12:00:00Z',
  });

  const mathRow = ranked.find((r) => r.skillId === 'MATH.GEO2D.COMPOSITE_AREA');
  assert.ok(mathRow);
  assert.equal(mathRow.repairCount, 1);
  assert.equal(mathRow.plateauStatus, 'watch');
  assert.equal(mathRow.avgTimeRatio, 1.3);

  const basePlan = buildDeterministicDailyFocusPlan({
    studentId: 'stu_1',
    questions: [qRepair, qUnseen, qThink],
    skillStates: {},
    evidenceMap: {},
    questionMemory: {},
    nowIso: '2026-11-15T12:00:00Z',
  });

  const overridden = await generateGeminiFocusOverride({
    basePlan,
    candidates: ranked,
    generateTextFn: async (payloadJson) => {
      assert.equal(payloadJson.includes('"repairs":1'), true);
      return JSON.stringify({
        focusSkillIds: ['MATH.GEO2D.COMPOSITE_AREA', 'INVALID.SKILL.ID', 'READ.FIC.CHARACTER_INFERENCE'],
        weights: [
          { skillId: 'MATH.GEO2D.COMPOSITE_AREA', weight: 9.9 },
          { skillId: 'READ.FIC.CHARACTER_INFERENCE', weight: 0.1 },
        ],
        algorithmAdjustments: {
          spacedReviewWeightMultiplier: 3.0,
          weakestSkillWeightMultiplier: 1.25,
          noveltyCoverageWeightMultiplier: 0.2,
          zpdDifficultyOffset: 2.5,
        },
        recommendedSection: 'MATH',
        rationale: 'Focus on Composite Area repair items and Fiction Inference.',
      });
    },
  });

  assert.ok(overridden);
  assert.equal(overridden.source, 'gemini');
  assert.equal(overridden.modelId, 'gemini-4-hydrogen');
  assert.deepEqual(overridden.focusSkillIds, ['MATH.GEO2D.COMPOSITE_AREA', 'READ.FIC.CHARACTER_INFERENCE']);
  assert.equal(overridden.skillWeights['MATH.GEO2D.COMPOSITE_AREA'], 1.35);
  assert.equal(overridden.skillWeights['READ.FIC.CHARACTER_INFERENCE'], 0.85);
  assert.equal(overridden.algorithmAdjustments?.spacedReviewWeightMultiplier, 1.35);
  assert.equal(overridden.algorithmAdjustments?.weakestSkillWeightMultiplier, 1.25);
  assert.equal(overridden.algorithmAdjustments?.noveltyCoverageWeightMultiplier, 0.75);
  assert.equal(overridden.algorithmAdjustments?.zpdDifficultyOffset, 0.75);
  assert.equal(overridden.recommendedSection, 'MATH');
});

test('decidePracticeQuestionOrderWithGemini validates whitelist, blocks holdouts/spoilers, obeys section caps, and falls back safely', async () => {
  const read1 = makeQuestion('r1', 'READ', 'READ.FIC.CHARACTER_INFERENCE');
  const read2 = makeQuestion('r2', 'READ', 'READ.POEM.FIGURATIVE_IMAGERY');
  const read3 = makeQuestion('r3', 'READ', 'READ.CLOZE.CONTEXT_NUANCE');
  const math1 = makeQuestion('m1', 'MATH', 'MATH.NUM.NUMBER_SEQUENCES');
  const math2 = makeQuestion('m2', 'MATH', 'MATH.GEO2D.COMPOSITE_AREA');
  const holdout = makeQuestion('pt3_h', 'MATH', 'MATH.GEO2D.COMPOSITE_AREA', 'benchmark_holdout');

  let capturedPayload = '';
  const result = await decidePracticeQuestionOrderWithGemini({
    mode: 'daily_adaptive',
    questions: [read1, read2, read3, math1, math2, holdout],
    skillStates: {},
    questionMemory: {},
    config: {
      ...DEFAULT_LEARNING_CONFIG,
      sessionDefaults: {
        ...DEFAULT_LEARNING_CONFIG.sessionDefaults,
        dailyQuestionLimitBySection: { READ: 2, MATH: 1, THINK: 0, WRIT: 0 },
      },
    },
    nowIso: '2026-11-15T12:00:00Z',
    seed: 19,
    generateTextFn: async (payloadJson) => {
      capturedPayload = payloadJson;
      return JSON.stringify({
        selectedQuestionIds: [
          'pt3_h_v1', // Holdout -> MUST be rejected!
          'invented_fake_q_99', // Unknown -> MUST be rejected!
          'r2_v1',
          'r2_v1', // Duplicate -> MUST be rejected!
          'm2_v1',
          'm1_v1', // Exceeds MATH cap of 1 -> MUST be rejected!
        ],
        algorithmAdjustments: { weakestSkillWeightMultiplier: 1.2 },
        selectionRationale: 'Balanced Reading poetry and Math composite area review.',
      });
    },
  });

  // Never send question prompts, options, or answer keys to Gemini planner
  assert.equal(capturedPayload.includes('TOP_SECRET_PROMPT'), false);
  assert.equal(capturedPayload.includes('TOP_SECRET_EXPLANATION'), false);
  assert.equal(capturedPayload.includes('correctAnswerKey'), false);
  assert.equal(capturedPayload.includes('pt3_h_v1'), false);

  assert.equal(result.decision.source, 'gemini');
  assert.equal(result.decision.modelId, 'gemini-4-hydrogen');
  // 2 READ + 1 MATH = 3 total; starts with r2_v1 and m2_v1 from Gemini, then backfills remaining READ item
  assert.equal(result.questions.length, 3);
  assert.equal(result.questions[0].questionId, 'r2_v1');
  assert.equal(result.questions[1].questionId, 'm2_v1');
  assert.equal(result.questions.filter((q) => q.section === 'READ').length, 2);
  assert.equal(result.questions.filter((q) => q.section === 'MATH').length, 1);
  assert.equal(result.questions.some((q) => q.poolType === 'benchmark_holdout'), false);

  // Error path falls back cleanly to deterministic selection
  const fallback = await decidePracticeQuestionOrderWithGemini({
    mode: 'section_drill',
    sectionFilter: 'READ',
    questions: [read1, read2, read3, holdout],
    skillStates: {},
    questionMemory: {},
    config: DEFAULT_LEARNING_CONFIG,
    nowIso: '2026-11-15T12:00:00Z',
    seed: 19,
    generateTextFn: async () => {
      throw new Error('simulated timeout');
    },
  });
  assert.equal(fallback.decision.source, 'deterministic');
  assert.equal(fallback.questions.length, 3);
  assert.equal(fallback.questions.some((q) => q.poolType === 'benchmark_holdout'), false);
});

test('evaluateWritingWithGemini uses gemini-4-hydrogen and normalizes all 6 writing rubric criteria', async () => {
  const normalized = normalizeWritingEvaluationCriteria([
    { criterionSkillId: 'WRIT.CRIT.IDEAS_CREATIVITY', score: 9, comment: 'Imaginative plot.' },
    { criterionSkillId: 'WRIT.CRIT.STYLE_VOCABULARY', score: 4, evidenceQuote: 'velvet twilight', comment: 'Vivid imagery.' },
  ]);
  assert.equal(normalized.length, WRITING_CRITERIA.length);
  assert.equal(normalized[1].score, 5); // clamped from 9 -> 5
  assert.equal(normalized[4].evidenceQuote, 'velvet twilight');
  assert.equal(normalized[0].score, 3); // missing criterion filled cleanly

  const writQ = makeQuestion('w1', 'WRIT', 'WRIT.CRIT.IDEAS_CREATIVITY');
  const evalRec = await evaluateWritingWithGemini({
    submissionId: 'wsub_test_1',
    question: writQ,
    planNotes: 'Intro, climax, resolution',
    responseText: 'The lighthouse beam swept over the silver harbour.',
    metrics: {
      wordCount: 8,
      paragraphCount: 1,
      sentenceCount: 1,
      avgWordsPerSentence: 8,
      typeTokenRatio: 1,
      matchedMandatoryStarter: true,
    },
    generateTextFn: async () =>
      JSON.stringify({
        topicAdherencePass: true,
        overallBandEstimate: 'strong',
        criteriaScores: [
          { criterionSkillId: 'WRIT.CRIT.TOPIC_PROMPT_ADHERENCE', score: 5, comment: 'Clear opening.' },
        ],
        topStrengths: ['Strong atmospheric opening'],
        priorityFixes: ['Expand the middle paragraph with dialogue'],
      }),
  });

  assert.equal(evalRec.modelId, 'gemini-4-hydrogen');
  assert.equal(evalRec.overallBandEstimate, 'strong');
  assert.equal(evalRec.criteriaScores.length, 6);
  assert.equal(evalRec.criteriaScores[0].score, 5);
});
