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
  getOrCreateDailyFocusPlan,
  type DecisionAnswerMap,
} from './geminiPlanner.ts';
import { MemoryRepository } from './storage/memoryRepository.ts';
import {
  computeWritingBandSummary,
  evaluateWritingWithGemini,
  normalizeWritingEvaluationCriteria,
  scoreToCriterionBand,
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

function scoreAnswer(score: number): DecisionAnswerMap[string] {
  return { type: 'score', score, confidence: 0.9, legend: {}, probabilities: {} };
}

test('Gemini client separates System 1 Decisions from writing generation and normalizes HTTP errors', () => {
  assert.equal(GEMINI_DECISION_MODEL, 'gemini-decision-1');
  assert.equal(GEMINI_WRITING_MODEL, 'gemini-3.5-flash-lite');

  const e403 = normalizeGeminiError(new Error('403 PERMISSION_DENIED: invalid key'));
  assert.equal(e403.statusCode, 403);
  assert.match(e403.message, /Settings > Secrets/);

  const e429 = normalizeGeminiError(new Error('429 RESOURCE_EXHAUSTED'));
  assert.equal(e429.statusCode, 429);

  const e404 = normalizeGeminiError(new Error('404 NOT_FOUND'));
  assert.equal(e404.statusCode, 502);
  assert.match(e404.message, /gemini-decision-1/);
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
    decideFn: async ({ inputText, questions }) => {
      assert.equal(inputText.includes('"repairs":1'), true);
      const payload = JSON.parse(inputText) as { candidateSkills: { skillId: string }[] };
      const answers: DecisionAnswerMap = {
        review_emphasis: scoreAnswer(99),
        weakness_emphasis: scoreAnswer(3),
        novelty_emphasis: scoreAnswer(-99),
        zpd_challenge_step: scoreAnswer(99),
        recommended_section: { type: 'choice', choice: 'MATH', probabilities: {}, confidence: 0.9 },
        'INVALID.SKILL.ID': scoreAnswer(99),
      };
      payload.candidateSkills.forEach((row, idx) => {
        assert.equal(questions[`skill_${idx}`].type, 'score');
        answers[`skill_${idx}`] = scoreAnswer(
          row.skillId === 'MATH.GEO2D.COMPOSITE_AREA' ? 99 :
            row.skillId === 'READ.FIC.CHARACTER_INFERENCE' ? -99 : 1
        );
      });
      return answers;
    },
  });

  assert.ok(overridden);
  assert.equal(overridden.source, 'gemini');
  assert.equal(overridden.modelId, 'gemini-decision-1');
  assert.equal(overridden.focusSkillIds[0], 'MATH.GEO2D.COMPOSITE_AREA');
  assert.equal(overridden.focusSkillIds.includes('INVALID.SKILL.ID'), false);
  assert.equal(overridden.skillWeights['MATH.GEO2D.COMPOSITE_AREA'], 1.35);
  assert.equal(overridden.skillWeights['READ.FIC.CHARACTER_INFERENCE'], 0.85);
  assert.equal(overridden.algorithmAdjustments?.spacedReviewWeightMultiplier, 1.35);
  assert.equal(overridden.algorithmAdjustments?.weakestSkillWeightMultiplier, 1.2);
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
    decideFn: async ({ inputText, questions }) => {
      capturedPayload = inputText;
      const payload = JSON.parse(inputText) as { candidates: { questionId: string }[] };
      const answers: DecisionAnswerMap = {
        pt3_h_v1: scoreAnswer(99),
        invented_fake_q_99: scoreAnswer(99),
      };
      payload.candidates.forEach((row, idx) => {
        assert.equal(questions[`q_${idx}`].type, 'score');
        answers[`q_${idx}`] = scoreAnswer(
          row.questionId === 'r2_v1' ? 4 : row.questionId === 'm2_v1' ? 3 : 0
        );
      });
      return answers;
    },
  });

  // Never send question prompts, options, or answer keys to Gemini planner
  assert.equal(capturedPayload.includes('TOP_SECRET_PROMPT'), false);
  assert.equal(capturedPayload.includes('TOP_SECRET_EXPLANATION'), false);
  assert.equal(capturedPayload.includes('correctAnswerKey'), false);
  assert.equal(capturedPayload.includes('pt3_h_v1'), false);

  assert.equal(result.decision.source, 'gemini');
  assert.equal(result.decision.modelId, 'gemini-decision-1');
  // Scores rank canonical candidates only; section caps still require 2 READ + 1 MATH.
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
    decideFn: async () => {
      throw new Error('simulated timeout');
    },
  });
  assert.equal(fallback.decision.source, 'deterministic');
  assert.equal(fallback.questions.length, 3);
  assert.equal(fallback.questions.some((q) => q.poolType === 'benchmark_holdout'), false);
});

test('daily focus replaces a legacy Hydrogen cache once and shares concurrent/current-model requests', async () => {
  const repo = new MemoryRepository();
  const input = {
    repo,
    studentId: 'cache_student',
    questions: [makeQuestion('cache_math', 'MATH', 'MATH.GEO2D.COMPOSITE_AREA')],
    skillStates: {},
    evidenceMap: {},
    questionMemory: {},
    nowIso: '2026-11-17T10:00:00Z',
  };
  const legacy = {
    ...buildDeterministicDailyFocusPlan(input),
    source: 'gemini' as const,
    modelId: 'gemini-4-hydrogen',
  };
  await repo.saveDailyFocusPlan(input.studentId, legacy);
  let requests = 0;
  const options = {
    ...input,
    decideFn: async () => {
      requests++;
      return { skill_0: scoreAnswer(4) };
    },
  };
  const [first, concurrent] = await Promise.all([
    getOrCreateDailyFocusPlan(options), getOrCreateDailyFocusPlan(options),
  ]);
  assert.equal(requests, 1);
  assert.equal(first.plan.modelId, 'gemini-decision-1');
  assert.deepEqual(concurrent.plan, first.plan);
  const cached = await getOrCreateDailyFocusPlan(options);
  assert.deepEqual(cached.plan, first.plan);
  assert.equal(requests, 1);
});

test('a failed legacy-cache migration persists a deterministic daily fallback instead of retrying every load', async () => {
  const repo = new MemoryRepository();
  const input = {
    repo,
    studentId: 'fallback_student',
    questions: [makeQuestion('fallback_math', 'MATH', 'MATH.GEO2D.COMPOSITE_AREA')],
    skillStates: {},
    evidenceMap: {},
    questionMemory: {},
    nowIso: '2026-11-17T10:00:00Z',
  };
  await repo.saveDailyFocusPlan(input.studentId, {
    ...buildDeterministicDailyFocusPlan(input), source: 'gemini', modelId: 'gemini-4-hydrogen',
  });
  let requests = 0;
  const options = {
    ...input,
    decideFn: async (): Promise<DecisionAnswerMap> => {
      requests++;
      throw new Error('test model unavailable');
    },
  };
  const first = await getOrCreateDailyFocusPlan(options);
  assert.equal(first.plan.source, 'deterministic');
  assert.equal(first.plan.modelId, undefined);
  assert.match(first.error || '', /unavailable/);
  const cached = await getOrCreateDailyFocusPlan(options);
  assert.deepEqual(cached.plan, first.plan);
  assert.equal(requests, 1);
});

test('evaluateWritingWithGemini uses gemini-3.5-flash-lite and normalizes all 6 writing rubric criteria on /20 scale', async () => {
  const normalized = normalizeWritingEvaluationCriteria([
    { criterionSkillId: 'WRIT.CRIT.IDEAS_CREATIVITY', score: 9, comment: 'Imaginative plot.' },
    { criterionSkillId: 'WRIT.CRIT.STYLE_VOCABULARY', score: 3, evidenceQuote: 'velvet twilight', comment: 'Vivid imagery.' },
  ]);
  assert.equal(normalized.length, WRITING_CRITERIA.length);
  assert.equal(normalized[1].maxMarks, 4);
  assert.equal(normalized[1].score, 4); // clamped from 9 -> 4
  assert.equal(normalized[1].band, 'A');
  assert.equal(normalized[4].maxMarks, 3);
  assert.equal(normalized[4].score, 3);
  assert.equal(normalized[4].evidenceQuote, 'velvet twilight');
  assert.equal(normalized[0].maxMarks, 4);
  assert.equal(normalized[0].score, 2); // missing 4-mark criterion filled cleanly
  assert.equal(normalized[2].maxMarks, 3);
  assert.equal(normalized[2].score, 2); // missing 3-mark criterion filled cleanly

  const writQ = makeQuestion('w1', 'WRIT', 'WRIT.CRIT.IDEAS_CREATIVITY');
  const evalRec = await evaluateWritingWithGemini({
    submissionId: 'wsub_test_1',
    question: writQ,
    planNotes: 'Intro, climax, resolution',
    responseText:
      'The lighthouse beam swept over the silver harbour as the ferry engines thrummed beneath our heels.\n\nWe watched the timber pilings sink into black water while gulls wheeled around the beacon.\n\nMy sister gripped the cold brass rail until her knuckles paled.\n\nWhen the fog lifted, the headland stood closer than any chart had promised.',
    metrics: {
      wordCount: 280,
      paragraphCount: 4,
      sentenceCount: 16,
      avgWordsPerSentence: 17.5,
      typeTokenRatio: 0.75,
      matchedMandatoryStarter: true,
    },
    generateTextFn: async () =>
      JSON.stringify({
        topicAdherencePass: true,
        audit: {
          promptEngagement: 'solid',
          hasUnfilledPlaceholders: false,
          hasAiSlopOrCorporateCliches: false,
          formAndParagraphControl: 'controlled',
          substanceAndDepth: 'sound',
          topBandChecks: {
            holdsSpecificPromptDetails: true,
            authenticVoiceNotSlop: true,
            controlledStructureAndPacing: false,
            preciseCraftAndMechanics: true,
          },
          pullingFaults: [],
        },
        overallVerdict: 'Atmospheric imagery holds interest, though missing criteria need fuller development.',
        overallBandEstimate: 'strong',
        criteriaScores: [
          { criterionSkillId: 'WRIT.CRIT.TOPIC_PROMPT_ADHERENCE', score: 4, comment: 'Clear opening.' },
        ],
        topStrengths: ['Strong atmospheric opening'],
        priorityFixes: ['Expand the middle paragraph with dialogue'],
      }),
  });

  assert.equal(evalRec.modelId, 'gemini-3.5-flash-lite');
  assert.equal(evalRec.overallBandEstimate, 'strong');
  assert.equal(evalRec.overallBand, 'B');
  assert.equal(evalRec.totalMarks, 14);
  assert.equal(evalRec.maxTotalMarks, 20);
  assert.equal(evalRec.overallVerdict, 'Atmospheric imagery holds interest, though missing criteria need fuller development.');
  assert.equal(evalRec.criteriaScores.length, 6);
  assert.equal(evalRec.criteriaScores[0].score, 4);
  assert.equal(evalRec.criteriaScores[0].band, 'A');
  assert.equal(evalRec.criteriaScores[0].maxMarks, 4);
});

test('Banded A-E writing rubric scores /20 (4+4+3+3+3+3), enforces anti-slop ceilings, and reconciles criterion totals', async () => {
  // Explicit 0 must not be coerced to default
  const withZero = normalizeWritingEvaluationCriteria([
    { criterionSkillId: 'WRIT.CRIT.TOPIC_PROMPT_ADHERENCE', score: 0, comment: 'Off-topic.' },
    { criterionSkillId: 'WRIT.CRIT.IDEAS_CREATIVITY', score: 4, comment: 'Excellent.' },
    { criterionSkillId: 'WRIT.CRIT.STYLE_VOCABULARY', score: 3, comment: 'Crisp diction.' },
  ]);
  assert.equal(withZero[0].score, 0);
  assert.equal(withZero[0].band, 'E');
  assert.equal(withZero[1].score, 4);
  assert.equal(withZero[1].band, 'A');
  assert.equal(withZero[4].score, 3);
  assert.equal(withZero[4].band, 'A');

  // Ratio band mapping for 4-mark and 3-mark criteria
  assert.equal(scoreToCriterionBand(4, 4), 'A');
  assert.equal(scoreToCriterionBand(3, 4), 'B');
  assert.equal(scoreToCriterionBand(2, 4), 'C');
  assert.equal(scoreToCriterionBand(1, 4), 'D');
  assert.equal(scoreToCriterionBand(0, 4), 'E');
  assert.equal(scoreToCriterionBand(3, 3), 'A');
  assert.equal(scoreToCriterionBand(2, 3), 'B');
  assert.equal(scoreToCriterionBand(1, 3), 'D');
  assert.equal(scoreToCriterionBand(0, 3), 'E');

  const makeScores = (vals: number[]) =>
    WRITING_CRITERIA.map((id, i) => {
      const maxMarks = i < 2 ? 4 : 3;
      return {
        criterionSkillId: id,
        score: vals[i],
        maxMarks,
        band: scoreToCriterionBand(vals[i], maxMarks),
        comment: 'ok',
      };
    });

  // Threshold checks on /20: A(17..20), B(13..16), C(9..12), D(5..8), E(0..4)
  assert.equal(computeWritingBandSummary(makeScores([4, 4, 3, 3, 3, 3]), true).overallBand, 'A'); // 20
  assert.equal(computeWritingBandSummary(makeScores([3, 4, 3, 3, 2, 2]), true).overallBand, 'A'); // 17
  assert.equal(computeWritingBandSummary(makeScores([3, 3, 3, 3, 2, 2]), true).overallBand, 'B'); // 16
  assert.equal(computeWritingBandSummary(makeScores([3, 3, 2, 2, 2, 1]), true).overallBand, 'B'); // 13
  assert.equal(computeWritingBandSummary(makeScores([2, 2, 2, 2, 2, 2]), true).overallBand, 'C'); // 12
  assert.equal(computeWritingBandSummary(makeScores([2, 2, 2, 1, 1, 1]), true).overallBand, 'C'); // 9
  assert.equal(computeWritingBandSummary(makeScores([2, 2, 1, 1, 1, 1]), true).overallBand, 'D'); // 8
  assert.equal(computeWritingBandSummary(makeScores([1, 1, 1, 1, 1, 0]), true).overallBand, 'D'); // 5
  assert.equal(computeWritingBandSummary(makeScores([1, 1, 1, 1, 0, 0]), true).overallBand, 'E'); // 4
  assert.equal(computeWritingBandSummary(makeScores([0, 0, 0, 0, 0, 0]), true).overallBand, 'E'); // 0

  // Off-topic cap: 18/20 with topicAdherencePass=false caps total <= 12 and Band A -> Band C
  const capped = computeWritingBandSummary(makeScores([4, 4, 3, 3, 2, 2]), false);
  assert.equal(capped.totalMarks, 12);
  assert.equal(capped.overallBand, 'C');
  assert.equal(capped.bandCappedByTopicAdherence, true);
  assert.equal(capped.overallBandEstimate, 'solid');
  assert.equal(
    capped.adjustedCriteriaScores.reduce((sum, c) => sum + c.score, 0),
    capped.totalMarks
  );

  // 4-check top-band gate verification
  const twoTicks = computeWritingBandSummary(makeScores([4, 4, 3, 3, 3, 3]), true, {
    promptEngagement: 'strong',
    substanceAndDepth: 'deep',
    topBandChecks: {
      holdsSpecificPromptDetails: true,
      authenticVoiceNotSlop: true,
      controlledStructureAndPacing: false,
      preciseCraftAndMechanics: false,
    },
  });
  assert.ok(twoTicks.totalMarks <= 16);
  assert.equal(twoTicks.overallBand, 'B');

  const threeTicks = computeWritingBandSummary(makeScores([4, 4, 3, 3, 3, 3]), true, {
    promptEngagement: 'strong',
    substanceAndDepth: 'deep',
    topBandChecks: {
      holdsSpecificPromptDetails: true,
      authenticVoiceNotSlop: true,
      controlledStructureAndPacing: true,
      preciseCraftAndMechanics: false,
    },
  });
  assert.equal(threeTicks.totalMarks, 18);

  const fourTicksClean = computeWritingBandSummary(makeScores([4, 4, 3, 3, 3, 3]), true, {
    promptEngagement: 'strong',
    substanceAndDepth: 'deep',
    pullingFaultsCount: 0,
    topBandChecks: {
      holdsSpecificPromptDetails: true,
      authenticVoiceNotSlop: true,
      controlledStructureAndPacing: true,
      preciseCraftAndMechanics: true,
    },
  });
  assert.equal(fourTicksClean.totalMarks, 20);
  assert.equal(fourTicksClean.overallBand, 'A');

  // Short response ceilings
  const veryShortEval = await evaluateWritingWithGemini({
    submissionId: 'wsub_short_very',
    question: makeQuestion('w_sv', 'WRIT', 'WRIT.CRIT.TOPIC_PROMPT_ADHERENCE'),
    planNotes: '',
    responseText: 'A short unfinished reflection that ends abruptly.',
    metrics: {
      wordCount: 45,
      paragraphCount: 2,
      sentenceCount: 4,
      avgWordsPerSentence: 11.2,
      typeTokenRatio: 0.9,
      matchedMandatoryStarter: true,
    },
    generateTextFn: async () =>
      JSON.stringify({
        topicAdherencePass: true,
        criteriaScores: WRITING_CRITERIA.map((id, idx) => ({
          criterionSkillId: id,
          score: idx < 2 ? 4 : 3,
          comment: 'Brief.',
        })),
        topStrengths: ['Readable'],
        priorityFixes: ['Develop beyond 45 words'],
      }),
  });
  assert.ok((veryShortEval.totalMarks ?? 99) <= 7);
  assert.equal(veryShortEval.overallBand, 'D');

  const underDevEval = await evaluateWritingWithGemini({
    submissionId: 'wsub_short_mid',
    question: makeQuestion('w_sm', 'WRIT', 'WRIT.CRIT.TOPIC_PROMPT_ADHERENCE'),
    planNotes: '',
    responseText: 'Paragraph one opens the argument.\n\nParagraph two stops early.',
    metrics: {
      wordCount: 110,
      paragraphCount: 2,
      sentenceCount: 7,
      avgWordsPerSentence: 15.7,
      typeTokenRatio: 0.8,
      matchedMandatoryStarter: true,
    },
    generateTextFn: async () =>
      JSON.stringify({
        topicAdherencePass: true,
        criteriaScores: WRITING_CRITERIA.map((id, idx) => ({
          criterionSkillId: id,
          score: idx < 2 ? 4 : 3,
          comment: 'Short.',
        })),
        topStrengths: ['Clear structure'],
        priorityFixes: ['Expand body evidence'],
      }),
  });
  assert.ok((underDevEval.totalMarks ?? 99) <= 12);
  assert.equal(underDevEval.overallBand, 'C');

  // Strict ceiling: unfilled [Surname] + corporate bullet slop + unsigned closing caps even inflated 20/20 scores <= 11/20
  const slopEval = await evaluateWritingWithGemini({
    submissionId: 'wsub_slop',
    question: makeQuestion('w_slop', 'WRIT', 'WRIT.CRIT.PURPOSE_AUDIENCE_VOICE'),
    planNotes: '',
    responseText: [
      'Dear Mayor [Surname],',
      'I am writing to present a green-infrastructure strategy regarding substantial procurement costs.',
      '- Immediate strategic alignment for community hubs',
      '- Holistic sustainability outcomes across all precincts',
      'We must leverage synergistic partnerships without delay.',
      'Yours sincerely,',
    ].join('\n\n'),
    metrics: {
      wordCount: 280,
      paragraphCount: 4,
      sentenceCount: 14,
      avgWordsPerSentence: 20,
      typeTokenRatio: 0.72,
      matchedMandatoryStarter: true,
    },
    generateTextFn: async () =>
      JSON.stringify({
        topicAdherencePass: true,
        audit: {
          promptEngagement: 'surface_formulaic',
          hasUnfilledPlaceholders: true,
          hasAiSlopOrCorporateCliches: true,
          formAndParagraphControl: 'weak',
          substanceAndDepth: 'developing',
          topBandChecks: {
            holdsSpecificPromptDetails: false,
            authenticVoiceNotSlop: false,
            controlledStructureAndPacing: false,
            preciseCraftAndMechanics: true,
          },
          pullingFaults: ['Unfilled [Surname] placeholder', 'Corporate bullet list inside formal letter'],
        },
        overallVerdict: 'Template placeholders and corporate jargon prevent authentic Year 6 persuasive voice.',
        criteriaScores: WRITING_CRITERIA.map((id, idx) => ({
          criterionSkillId: id,
          score: idx < 2 ? 4 : 3,
          comment: 'Inflated draft score from model.',
        })),
        topStrengths: ['Clear stance'],
        priorityFixes: ['Replace template placeholders and corporate bullet points'],
      }),
  });
  assert.ok((slopEval.totalMarks ?? 99) <= 11);
  assert.equal(slopEval.overallBand, 'C');
  assert.equal(
    slopEval.overallVerdict,
    'Template placeholders and corporate jargon prevent authentic Year 6 persuasive voice.'
  );
  assert.equal(
    slopEval.criteriaScores.reduce((sum, c) => sum + c.score, 0),
    slopEval.totalMarks
  );

  // Strict ceiling: single-paragraph wall (>= 120 words, 1 paragraph) caps STRUCTURE_LAYOUT <= 1 and total <= 15
  const wallEval = await evaluateWritingWithGemini({
    submissionId: 'wsub_wall',
    question: makeQuestion('w_wall', 'WRIT', 'WRIT.CRIT.STRUCTURE_LAYOUT'),
    planNotes: '',
    responseText: 'One unbroken wall of prose carrying on without a single paragraph break.',
    metrics: {
      wordCount: 260,
      paragraphCount: 1,
      sentenceCount: 13,
      avgWordsPerSentence: 20,
      typeTokenRatio: 0.74,
      matchedMandatoryStarter: true,
    },
    generateTextFn: async () =>
      JSON.stringify({
        topicAdherencePass: true,
        audit: {
          promptEngagement: 'strong',
          hasUnfilledPlaceholders: false,
          hasAiSlopOrCorporateCliches: false,
          formAndParagraphControl: 'weak',
          substanceAndDepth: 'deep',
          topBandChecks: {
            holdsSpecificPromptDetails: true,
            authenticVoiceNotSlop: true,
            controlledStructureAndPacing: false,
            preciseCraftAndMechanics: true,
          },
          pullingFaults: ['Missing paragraph breaks across 260 words'],
        },
        overallVerdict: 'Strong ideas lose control because all 260 words sit in one unbroken block.',
        criteriaScores: WRITING_CRITERIA.map((id, idx) => ({
          criterionSkillId: id,
          score: idx < 2 ? 4 : 3,
          comment: 'Strong voice.',
        })),
        topStrengths: ['Vivid sensory verbs'],
        priorityFixes: ['Break narrative beats into distinct paragraphs'],
      }),
  });
  const structureCrit = wallEval.criteriaScores.find((c) => c.criterionSkillId === 'WRIT.CRIT.STRUCTURE_LAYOUT');
  assert.ok((structureCrit?.score ?? 99) <= 1);
  assert.ok((wallEval.totalMarks ?? 99) <= 15);
  assert.notEqual(wallEval.overallBand, 'A');
  assert.equal(
    wallEval.criteriaScores.reduce((sum, c) => sum + c.score, 0),
    wallEval.totalMarks
  );

  // Configurable GEMINI_WRITING_MODEL override
  const prevModel = process.env.GEMINI_WRITING_MODEL;
  process.env.GEMINI_WRITING_MODEL = 'gemini-3.5-flash-lite-custom';
  try {
    const writQ = makeQuestion('w2', 'WRIT', 'WRIT.CRIT.IDEAS_CREATIVITY');
    const evalRec = await evaluateWritingWithGemini({
      submissionId: 'wsub_test_2',
      question: writQ,
      planNotes: '',
      responseText: 'Unrelated text written at length for testing off-topic capping across multiple paragraphs.',
      metrics: {
        wordCount: 280,
        paragraphCount: 4,
        sentenceCount: 15,
        avgWordsPerSentence: 18.6,
        typeTokenRatio: 0.7,
        matchedMandatoryStarter: false,
      },
      generateTextFn: async () =>
        JSON.stringify({
          topicAdherencePass: false,
          criteriaScores: WRITING_CRITERIA.map((id, idx) => ({
            criterionSkillId: id,
            score: idx < 2 ? 4 : 3,
            comment: 'Good style but off topic.',
          })),
          topStrengths: ['Clear sentences'],
          priorityFixes: ['Address the prompt'],
        }),
    });
    assert.equal(evalRec.modelId, 'gemini-3.5-flash-lite-custom');
    assert.equal(evalRec.totalMarks, 12);
    assert.equal(evalRec.overallBand, 'C');
    assert.equal(evalRec.bandCappedByTopicAdherence, true);
  } finally {
    if (prevModel === undefined) delete process.env.GEMINI_WRITING_MODEL;
    else process.env.GEMINI_WRITING_MODEL = prevModel;
  }

  // Inline annotations & Band A exemplar normalization
  const writQRich = makeQuestion('w3', 'WRIT', 'WRIT.CRIT.TOPIC_PROMPT_ADHERENCE');
  const richEval = await evaluateWritingWithGemini({
    submissionId: 'wsub_test_3',
    question: writQRich,
    planNotes: '',
    responseText:
      'I pushed open the creaking gate. I ran fast to the bench and it was cool.\n\nEverything felt secret.\n\nSunlight slanted across the rusted latch while sparrows fluttered out of the hedge.',
    metrics: {
      wordCount: 280,
      paragraphCount: 4,
      sentenceCount: 15,
      avgWordsPerSentence: 18.6,
      typeTokenRatio: 0.85,
      matchedMandatoryStarter: false,
    },
    generateTextFn: async () =>
      JSON.stringify({
        topicAdherencePass: true,
        audit: {
          promptEngagement: 'solid',
          hasUnfilledPlaceholders: false,
          hasAiSlopOrCorporateCliches: false,
          formAndParagraphControl: 'controlled',
          substanceAndDepth: 'sound',
          topBandChecks: {
            holdsSpecificPromptDetails: true,
            authenticVoiceNotSlop: true,
            controlledStructureAndPacing: true,
            preciseCraftAndMechanics: true,
          },
          pullingFaults: [],
        },
        overallVerdict: 'Strong scene grounding with room to sharpen generic verbs.',
        criteriaScores: WRITING_CRITERIA.map((id) => ({
          criterionSkillId: id,
          score: id === 'WRIT.CRIT.TOPIC_PROMPT_ADHERENCE' || id === 'WRIT.CRIT.IDEAS_CREATIVITY' ? 3 : 2,
          comment: 'Solid control with room for sharper verbs.',
        })),
        topStrengths: ['Clear opening action'],
        priorityFixes: ['Replace generic words like fast and cool'],
        annotations: [
          {
            kind: 'strength',
            quote: '"I pushed open the creaking gate."',
            tag: 'Sensory opener',
            comment: 'Sound detail pulls the reader right onto the platform.',
            criterionSkillId: 'WRIT.CRIT.STYLE_VOCABULARY',
          },
          {
            kind: 'issue',
            quote: 'I ran fast to the bench and it was cool.',
            tag: 'Vague verb',
            comment: '"ran fast" and "cool" tell instead of showing tension.',
            rewrite: 'I sprinted across the damp sleepers until my fingers brushed the salt-rough bench.',
            criterionSkillId: 'WRIT.CRIT.STYLE_VOCABULARY',
          },
        ],
        exemplar: {
          title: 'Key under the Ferns',
          text: 'Rust flaked onto my knuckles as I parted the blackberry vines.\n\nInside the glasshouse, condensation beaded like silver seeds.',
          keyTakeaway: 'Notice how concrete verbs replace vague adjectives like cool and fast.',
          annotations: [
            {
              quote: 'Rust flaked onto my knuckles',
              tag: 'Tactile detail',
              explanation: 'Physical sensation establishes place in six words.',
            },
            {
              quote: 'condensation beaded like silver seeds.',
              tag: 'Grounded simile',
              explanation: 'Links the greenhouse imagery directly to the plant motif.',
            },
          ],
        },
      }),
  });

  assert.equal(richEval.annotations?.length, 2);
  assert.equal(richEval.annotations?.[0].id, 'ann_1');
  assert.equal(richEval.annotations?.[0].quote, 'I pushed open the creaking gate.');
  assert.equal(richEval.annotations?.[1].kind, 'issue');
  assert.match(richEval.annotations?.[1].rewrite || '', /sprinted/);
  assert.equal(richEval.exemplar?.title, 'Key under the Ferns');
  assert.equal(richEval.exemplar?.annotations.length, 2);
  assert.equal(richEval.exemplar?.annotations[0].id, 'ex_1');
});

test('Auto-Calibrate with gemini-decision-1 dynamically adjusts total question volume and skews toward urgent sections', async () => {
  const { allocateAutoCalibratedDailyPlan } = await import('./geminiPlanner.ts');
  const { selectPoolMockQuestions, selectPracticeSession } = await import('../shared/engine.ts');

  const mathHeavy = allocateAutoCalibratedDailyPlan({
    volumeScore: 4, // max load
    sectionScores: { READ: 1, MATH: 4, THINK: 1 },
    includeWriting: false,
    availableBySection: { READ: 10, MATH: 10, THINK: 10, WRIT: 2 },
    autoConfig: { enabled: true, minDailyQuestions: 6, maxDailyQuestions: 14, includeWriting: false },
  });
  const totalMathHeavy =
    mathHeavy.dailyQuestionLimitBySection.READ +
    mathHeavy.dailyQuestionLimitBySection.MATH +
    mathHeavy.dailyQuestionLimitBySection.THINK;
  assert.equal(totalMathHeavy, 14);
  assert.ok(mathHeavy.dailyQuestionLimitBySection.MATH > mathHeavy.dailyQuestionLimitBySection.READ);
  assert.ok(mathHeavy.dailyQuestionLimitBySection.MATH > mathHeavy.dailyQuestionLimitBySection.THINK);

  const lightDay = allocateAutoCalibratedDailyPlan({
    volumeScore: 0, // min load
    sectionScores: { READ: 4, MATH: 1, THINK: 1 },
    includeWriting: true,
    availableBySection: { READ: 10, MATH: 10, THINK: 10, WRIT: 2 },
    autoConfig: { enabled: true, minDailyQuestions: 6, maxDailyQuestions: 14, includeWriting: true },
  });
  assert.equal(
    lightDay.dailyQuestionLimitBySection.READ +
      lightDay.dailyQuestionLimitBySection.MATH +
      lightDay.dailyQuestionLimitBySection.THINK,
    6
  );
  assert.equal(lightDay.dailyQuestionLimitBySection.WRIT, 1);
  assert.ok(lightDay.dailyQuestionLimitBySection.READ > lightDay.dailyQuestionLimitBySection.MATH);

  // Full generateGeminiFocusOverride with autoCalibrate enabled
  const questions = [
    makeQuestion('r1', 'READ', 'READ.FIC.CHARACTER_INFERENCE'),
    makeQuestion('r2', 'READ', 'READ.POEM.FIGURATIVE_IMAGERY'),
    makeQuestion('r3', 'READ', 'READ.CLOZE.CONTEXT_NUANCE'),
    makeQuestion('m1', 'MATH', 'MATH.GEO2D.COMPOSITE_AREA'),
    makeQuestion('m2', 'MATH', 'MATH.NUM.NUMBER_SEQUENCES'),
    makeQuestion('m3', 'MATH', 'MATH.PROB.COMBINATORICS'),
    makeQuestion('m4', 'MATH', 'MATH.ALG.LINEAR_EQUATIONS'),
    makeQuestion('m5', 'MATH', 'MATH.MEAS.VOLUME_CAPACITY'),
    makeQuestion('t1', 'THINK', 'THINK.DEDUCT.SET_SYLLOGISMS'),
    makeQuestion('t2', 'THINK', 'THINK.CRIT.FLAW_DETECTION'),
    makeQuestion('h1', 'MATH', 'MATH.GEO2D.COMPOSITE_AREA', 'benchmark_holdout'),
  ];

  const basePlan = buildDeterministicDailyFocusPlan({
    studentId: 'auto_stu',
    questions,
    skillStates: {},
    evidenceMap: {},
    questionMemory: {},
    config: {
      ...DEFAULT_LEARNING_CONFIG,
      autoCalibrate: { enabled: true, minDailyQuestions: 6, maxDailyQuestions: 10, includeWriting: false },
    },
    nowIso: '2026-11-18T08:00:00Z',
  });
  const ranked = computeRankedSkillCandidates({
    questions,
    skillStates: {},
    evidenceMap: {},
    questionMemory: {},
    nowIso: '2026-11-18T08:00:00Z',
  });

  const calibrated = await generateGeminiFocusOverride({
    basePlan,
    candidates: ranked,
    availableBySection: { READ: 3, MATH: 5, THINK: 2, WRIT: 0 },
    autoCalibrate: { enabled: true, minDailyQuestions: 6, maxDailyQuestions: 10, includeWriting: false },
    decideFn: async ({ questions: decisionQs }) => {
      assert.equal(decisionQs.daily_volume.type, 'score');
      assert.equal(decisionQs.section_share_MATH.type, 'score');
      const answers: DecisionAnswerMap = {
        daily_volume: scoreAnswer(4),
        section_share_READ: scoreAnswer(1),
        section_share_MATH: scoreAnswer(4),
        section_share_THINK: scoreAnswer(1),
        recommended_section: { type: 'choice', choice: 'MATH', probabilities: {}, confidence: 0.92 },
      };
      ranked.forEach((_, idx) => {
        answers[`skill_${idx}`] = scoreAnswer(3);
      });
      return answers;
    },
  });

  assert.ok(calibrated);
  assert.equal(calibrated.autoCalibrated, true);
  assert.ok(calibrated.dailyQuestionLimitBySection);
  assert.equal(calibrated.dailyQuestionLimitBySection.MATH, 5); // capped at available MATH stock

  // Pool-drawn mock excludes holdouts & prioritizes unseen questions first
  const seenMemory = {
    m1: {
      questionFamilyId: 'm1',
      timesSeen: 2,
      lastSeenAt: '2026-11-17T08:00:00Z',
      lastAllCorrect: true,
      nextDueAt: '2026-11-24T08:00:00Z',
      intervalDays: 7,
      lapseCount: 0,
    },
  };
  const poolMock = selectPoolMockQuestions({
    questions,
    sectionFilter: 'MATH',
    questionCount: 4,
    questionMemory: seenMemory,
    seed: 11,
  });
  assert.equal(poolMock.length, 4);
  assert.equal(poolMock.some((q) => q.poolType === 'benchmark_holdout'), false);
  assert.equal(poolMock.some((q) => q.questionId === 'm1_v1'), false); // 4 unseen math items win ahead of seen m1

  // autoRetireMastered excludes retained questions from regular practice selection
  const retainedEvidence = {
    m2__ev_m2: {
      evidenceKey: 'm2__ev_m2',
      questionFamilyId: 'm2',
      questionId: 'm2_v1',
      evidenceRevision: 'ev_m2',
      section: 'MATH' as const,
      status: 'retained' as const,
      cleanPassesCount: 3,
      passTimestampsIso: [],
      everCleanPassed: true,
      firstSubmissionCleanPass: true,
      attemptsCount: 3,
      resetCount: 0,
      lastAllCorrect: true,
      policyVersion: 'v3',
      updatedAtIso: '2026-11-17T08:00:00Z',
    },
  };
  const practiceAfterRetire = selectPracticeSession({
    mode: 'section_drill',
    sectionFilter: 'MATH',
    questions,
    skillStates: {},
    questionMemory: {},
    evidenceMap: retainedEvidence,
    questionCountOverride: 5,
    config: {
      ...DEFAULT_LEARNING_CONFIG,
      poolPolicy: { autoRetireMastered: true },
    },
    nowIso: '2026-11-18T08:00:00Z',
    seed: 7,
  });
  assert.equal(practiceAfterRetire.some((q) => q.questionId === 'm2_v1'), false);
  assert.equal(practiceAfterRetire.length, 4);
});

