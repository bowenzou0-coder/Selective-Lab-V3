import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LEARNING_CONFIG, type QuestionItem, type StimulusGroup } from './contracts';
import {
  clampAlgorithmAdjustments,
  computeWritingMetrics,
  detectPlateauStatus,
  gradeSubmission,
  selectAdminCalibrationQuestions,
  selectMockTestQuestions,
  selectPracticeCandidates,
  selectPracticeSession,
  toStudentQuestionView,
  updateFamilyMemoryOnce,
  updateSkillAndMemory,
} from './engine';

const SAMPLE_STIM: StimulusGroup = {
  stimulusId: 'stim_1',
  stimulusFamilyId: 'stim_fam_1',
  version: 1,
  section: 'READ',
  genreOrTextType: 'gapped_text',
  title: 'Test Passage',
  mainTextMarkdown: 'Intro {{gap:1}} Middle {{gap:2}} End.',
  extracts: [
    { label: 'A', bodyMarkdown: 'Extract A', isDecoy: false },
    { label: 'B', bodyMarkdown: 'Extract B', isDecoy: true },
    { label: 'C', bodyMarkdown: 'Extract C', isDecoy: false },
  ],
  sourceType: 'human_authored',
};

const SAMPLE_Q: QuestionItem = {
  questionId: 'q_read_gap_v1',
  questionFamilyId: 'q_read_gap',
  version: 1,
  section: 'READ',
  formatType: 'READ_GAPPED_TEXT',
  poolType: 'practice',
  qcStatus: 'active',
  stimulusId: 'stim_1',
  sharedPoolConfig: { reuseAllowed: false, poolKeys: ['A', 'B', 'C'] },
  parts: [
    {
      partId: 'p1',
      partIndex: 1,
      promptText: 'Gap 1',
      skillId: 'READ.GAP.COHESIVE_BRIDGE',
      difficultyInitial: 3.0,
      targetTimeSec: 60,
      cognitiveDemand: 'analyze_infer',
      options: [],
      correctAnswerKey: 'A',
      workedExplanation: 'A fits gap 1.',
      distractorRationales: { B: 'B is a decoy.' },
    },
    {
      partId: 'p2',
      partIndex: 2,
      promptText: 'Gap 2',
      skillId: 'READ.GAP.REFERENTIAL_PRONOUN_LINK',
      difficultyInitial: 3.0,
      targetTimeSec: 60,
      cognitiveDemand: 'analyze_infer',
      options: [],
      correctAnswerKey: 'C',
      workedExplanation: 'C fits gap 2.',
    },
  ],
  provenance: { sourceType: 'human_authored', verifierAgreed: true, auditorReviewed: true },
};

test('toStudentQuestionView strips answer keys, explanations, rationales, and isDecoy', () => {
  const view = toStudentQuestionView(SAMPLE_Q, SAMPLE_STIM);
  const raw = JSON.stringify(view);
  assert.equal(raw.includes('correctAnswerKey'), false);
  assert.equal(raw.includes('workedExplanation'), false);
  assert.equal(raw.includes('distractorRationales'), false);
  assert.equal(raw.includes('isDecoy'), false);
  assert.equal(view.parts.length, 2);
});

test('gradeSubmission enforces reuseAllowed: false and computes distractor rationale', () => {
  const dup = gradeSubmission(SAMPLE_Q, { p1: 'A', p2: 'A' });
  assert.equal(dup.validationErrors.length, 1);

  const graded = gradeSubmission(SAMPLE_Q, { p1: 'B', p2: 'C' });
  assert.equal(graded.validationErrors.length, 0);
  assert.equal(graded.results[0].isCorrect, false);
  assert.equal(graded.results[0].distractorRationale, 'B is a decoy.');
  assert.equal(graded.results[1].isCorrect, true);
});

test('selectPracticeSession never leaks benchmark_holdout into non-benchmark modes', () => {
  const holdoutQ: QuestionItem = {
    ...SAMPLE_Q,
    questionId: 'q_off_pt3_read_q01_v1',
    questionFamilyId: 'q_off_pt3_read_q01',
    poolType: 'benchmark_holdout',
    provenance: { sourceType: 'official_doe', sourceReference: 'NSW DoE Reading PT3 Q1', verifierAgreed: true, auditorReviewed: true },
  };
  const practiceQ: QuestionItem = {
    ...SAMPLE_Q,
    questionId: 'q_off_pt1_read_q01_v1',
    questionFamilyId: 'q_off_pt1_read_q01',
    poolType: 'official_calibration',
    provenance: { sourceType: 'official_doe', sourceReference: 'NSW DoE Reading PT1 Q1', verifierAgreed: true, auditorReviewed: true },
  };

  const daily = selectPracticeSession({
    mode: 'daily_adaptive',
    questions: [holdoutQ, practiceQ],
    skillStates: {},
    questionMemory: {},
    config: DEFAULT_LEARNING_CONFIG,
    nowIso: '2026-11-14T12:00:00Z',
    seed: 42,
  });
  assert.deepEqual(daily.map((q) => q.questionId), ['q_off_pt1_read_q01_v1']);

  const bench = selectPracticeSession({
    mode: 'benchmark_exam',
    questions: [holdoutQ, practiceQ],
    skillStates: {},
    questionMemory: {},
    config: DEFAULT_LEARNING_CONFIG,
    nowIso: '2026-11-14T12:00:00Z',
    seed: 42,
  });
  assert.deepEqual(bench.map((q) => q.questionId), ['q_off_pt3_read_q01_v1']);
});

test('selectMockTestQuestions returns fixed canonical order and respects PT3 holdout boundary', () => {
  const pt1a: QuestionItem = {
    ...SAMPLE_Q,
    questionId: 'q_off_pt1_math_q02_v1',
    questionFamilyId: 'f1',
    section: 'MATH',
    poolType: 'official_calibration',
  };
  const pt1b: QuestionItem = {
    ...SAMPLE_Q,
    questionId: 'q_off_pt1_math_q01_v1',
    questionFamilyId: 'f2',
    section: 'MATH',
    poolType: 'official_calibration',
  };
  const pt3: QuestionItem = {
    ...SAMPLE_Q,
    questionId: 'q_off_pt3_math_q01_v1',
    questionFamilyId: 'f3',
    section: 'MATH',
    poolType: 'benchmark_holdout',
  };

  const pickedPt1 = selectMockTestQuestions({ batch: 'PT1', questions: [pt1a, pt1b, pt3] });
  assert.deepEqual(pickedPt1.map((q) => q.questionId), ['q_off_pt1_math_q01_v1', 'q_off_pt1_math_q02_v1']);

  const pickedPt3 = selectMockTestQuestions({ batch: 'PT3', questions: [pt1a, pt1b, pt3] });
  assert.deepEqual(pickedPt3.map((q) => q.questionId), ['q_off_pt3_math_q01_v1']);
});

test('selectAdminCalibrationQuestions filters by skill, format, pool, and limit', () => {
  const q1 = SAMPLE_Q;
  const q2: QuestionItem = {
    ...SAMPLE_Q,
    questionId: 'q_math_1',
    questionFamilyId: 'q_math_1_fam',
    section: 'MATH',
    formatType: 'MATH_MCQ_5',
    poolType: 'benchmark_holdout',
    parts: [{ ...SAMPLE_Q.parts[0], partId: 'mp1', skillId: 'MATH.GEO2D.COMPOSITE_AREA' }],
  };
  const matched = selectAdminCalibrationQuestions({
    questions: [q1, q2],
    skillFamily: 'MATH.GEO2D',
  });
  assert.deepEqual(matched.map((q) => q.questionId), ['q_math_1']);
});

test('computeWritingMetrics checks word count and mandatory opening line', () => {
  const spec = {
    genre: 'diary_entry',
    audience: 'Personal',
    purpose: 'Reflect',
    mandatoryOpeningLine: 'Dear Diary, The rain began at noon.',
    recommendedWordRange: [200, 450] as [number, number],
    timeLimitSec: 1800,
  };
  const pass = computeWritingMetrics(spec, 'Dear Diary,   the rain began at noon. We lit candles!\n\nLater it stopped.');
  assert.equal(pass.matchedMandatoryStarter, true);
  assert.equal(pass.paragraphCount, 2);
  assert.equal(pass.sentenceCount, 3);
  assert.equal(pass.wordCount, 13);

  const fail = computeWritingMetrics(spec, 'Today it rained hard.');
  assert.equal(fail.matchedMandatoryStarter, false);
});

test('updateSkillAndMemory and detectPlateauStatus track SM-2 intervals and stagnation', () => {
  const { nextSkillState, nextMemory } = updateSkillAndMemory({
    skillId: 'MATH.GEO2D.COMPOSITE_AREA',
    questionFamilyId: 'fam1',
    isCorrect: true,
    allPartsCorrect: true,
    timeSpentSec: 40,
    targetTimeSec: 60,
    config: DEFAULT_LEARNING_CONFIG,
    nowIso: '2026-11-14T12:00:00Z',
  });
  assert.ok(nextSkillState.masteryScore > 0.5);
  assert.ok(nextSkillState.reviewIntervalDays >= 2);
  assert.equal(nextMemory.lapseCount, 0);

  const plateau = detectPlateauStatus({
    recentIsCorrectDesc: [false, true, false, false, true, false, true, false, false, true, false, false],
    ewmaAccuracy: 0.42,
    config: DEFAULT_LEARNING_CONFIG,
  });
  assert.equal(plateau, 'detected');
});

test('selectPracticeSession uses sectionDrillQuestionCount (10) and safely falls back when daily limits are all 0', () => {
  const mathQuestions: QuestionItem[] = Array.from({ length: 14 }, (_, idx) => ({
    ...SAMPLE_Q,
    questionId: `q_math_drill_${idx}_v1`,
    questionFamilyId: `q_math_drill_${idx}`,
    section: 'MATH',
    formatType: 'MATH_MCQ_5',
    poolType: 'practice',
    parts: [
      {
        ...SAMPLE_Q.parts[0],
        partId: `q_math_drill_${idx}_p1`,
        skillId: 'MATH.GEO2D.COMPOSITE_AREA',
      },
    ],
  }));

  const drill = selectPracticeSession({
    mode: 'section_drill',
    sectionFilter: 'MATH',
    questions: mathQuestions,
    skillStates: {},
    questionMemory: {},
    config: DEFAULT_LEARNING_CONFIG,
    nowIso: '2026-11-14T12:00:00Z',
    seed: 7,
  });
  assert.equal(drill.length, 10);

  const zeroCapsConfig = {
    ...DEFAULT_LEARNING_CONFIG,
    sessionDefaults: {
      ...DEFAULT_LEARNING_CONFIG.sessionDefaults,
      dailyQuestionLimitBySection: { READ: 0, MATH: 0, THINK: 0, WRIT: 0 },
    },
  };
  const dailyWithZeros = selectPracticeSession({
    mode: 'daily_adaptive',
    questions: mathQuestions,
    skillStates: {},
    questionMemory: {},
    config: zeroCapsConfig,
    nowIso: '2026-11-14T12:00:00Z',
    seed: 7,
  });
  assert.equal(dailyWithZeros.length, 3);
});

test('updateFamilyMemoryOnce tracks SM-2 easeFactor growth and lapse reset', () => {
  const m1 = updateFamilyMemoryOnce({
    questionFamilyId: 'fam_sm2',
    allPartsCorrect: true,
    config: DEFAULT_LEARNING_CONFIG,
    nowIso: '2026-11-14T10:00:00Z',
    lastEvidenceStatus: 'correct_once',
  });
  assert.equal(m1.easeFactor, 2.6);
  assert.equal(m1.intervalDays, 1);
  assert.equal(m1.lastEvidenceStatus, 'correct_once');

  const m2 = updateFamilyMemoryOnce({
    prevMemory: m1,
    questionFamilyId: 'fam_sm2',
    allPartsCorrect: true,
    config: DEFAULT_LEARNING_CONFIG,
    nowIso: '2026-11-15T10:00:00Z',
    lastEvidenceStatus: 'awaiting_review',
  });
  assert.equal(m2.easeFactor, 2.7);
  assert.equal(m2.intervalDays, 3); // round(1 * 2.6)

  const mLapse = updateFamilyMemoryOnce({
    prevMemory: m2,
    questionFamilyId: 'fam_sm2',
    allPartsCorrect: false,
    config: DEFAULT_LEARNING_CONFIG,
    nowIso: '2026-11-18T10:00:00Z',
    lastEvidenceStatus: 'needs_repair',
  });
  assert.equal(mLapse.easeFactor, 2.45);
  assert.equal(mLapse.intervalDays, 1);
  assert.equal(mLapse.lapseCount, 1);
  assert.equal(mLapse.lastEvidenceStatus, 'needs_repair');
});

test('selectPracticeSession integrates evidence signals, skillFocusWeights, and diversity', () => {
  const mkQ = (id: string, skillId: string): QuestionItem => ({
    ...SAMPLE_Q,
    questionId: `${id}_v1`,
    questionFamilyId: id,
    section: 'MATH',
    formatType: 'MATH_MCQ_5',
    poolType: 'practice',
    evidenceRevision: 'er_1',
    parts: [
      {
        ...SAMPLE_Q.parts[0],
        partId: `${id}_p1`,
        skillId,
      },
    ],
  });

  const retainedQ = mkQ('q_ret', 'MATH.NUM.NUMBER_SEQUENCES');
  const repairQ = mkQ('q_rep', 'MATH.GEO2D.COMPOSITE_AREA');
  const confirmQ = mkQ('q_conf', 'MATH.MEAS.TIME_CALENDAR');
  const focusUnseenQ = mkQ('q_foc', 'MATH.ALG.LINEAR_EQUATIONS_RATIO');

  const picked = selectPracticeSession({
    mode: 'section_drill',
    sectionFilter: 'MATH',
    questions: [retainedQ, repairQ, confirmQ, focusUnseenQ],
    skillStates: {},
    questionMemory: {
      q_ret: {
        questionFamilyId: 'q_ret',
        timesSeen: 2,
        lastSeenAt: '2026-11-01T00:00:00Z',
        lastAllCorrect: true,
        intervalDays: 14,
        easeFactor: 2.7,
        lapseCount: 0,
        nextDueAt: '2026-11-28T00:00:00Z',
      },
    },
    evidenceMap: {
      q_ret__er_1: {
        evidenceKey: 'q_ret__er_1',
        questionFamilyId: 'q_ret',
        questionId: 'q_ret_v1',
        evidenceRevision: 'er_1',
        section: 'MATH',
        status: 'retained',
        cleanPassesCount: 2,
        passTimestampsIso: ['2026-11-01T00:00:00Z', '2026-11-10T00:00:00Z'],
        everCleanPassed: true,
        firstSubmissionCleanPass: true,
        attemptsCount: 2,
        resetCount: 0,
        lastAllCorrect: true,
        policyVersion: 'v3_3stage_24h_7d',
        updatedAtIso: '2026-11-10T00:00:00Z',
      },
      q_rep__er_1: {
        evidenceKey: 'q_rep__er_1',
        questionFamilyId: 'q_rep',
        questionId: 'q_rep_v1',
        evidenceRevision: 'er_1',
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
        updatedAtIso: '2026-11-11T00:00:00Z',
      },
      q_conf__er_1: {
        evidenceKey: 'q_conf__er_1',
        questionFamilyId: 'q_conf',
        questionId: 'q_conf_v1',
        evidenceRevision: 'er_1',
        section: 'MATH',
        status: 'correct_once',
        cleanPassesCount: 1,
        passTimestampsIso: ['2026-11-11T00:00:00Z'],
        everCleanPassed: true,
        firstSubmissionCleanPass: true,
        attemptsCount: 1,
        resetCount: 0,
        lastAllCorrect: true,
        nextEligibleAtIso: '2026-11-12T00:00:00Z',
        policyVersion: 'v3_3stage_24h_7d',
        updatedAtIso: '2026-11-11T00:00:00Z',
      },
    },
    skillFocusWeights: {
      'MATH.ALG.LINEAR_EQUATIONS_RATIO': 1.35,
    },
    config: {
      ...DEFAULT_LEARNING_CONFIG,
      sessionDefaults: {
        ...DEFAULT_LEARNING_CONFIG.sessionDefaults,
        sectionDrillQuestionCount: 4,
      },
    },
    nowIso: '2026-11-14T12:00:00Z',
    seed: 12,
  });

  // Retained-and-not-due should rank strictly last behind repair, due confirmation, and focused unseen
  assert.equal(picked[3].questionFamilyId, 'q_ret');
});

test('clampAlgorithmAdjustments bounds multipliers and selectPracticeCandidates isolates holdout items', () => {
  const clamped = clampAlgorithmAdjustments({
    spacedReviewWeightMultiplier: 5.0,
    weakestSkillWeightMultiplier: 0.1,
    noveltyCoverageWeightMultiplier: 1.15,
    zpdDifficultyOffset: -3.0,
  });
  assert.deepEqual(clamped, {
    spacedReviewWeightMultiplier: 1.35,
    weakestSkillWeightMultiplier: 0.75,
    noveltyCoverageWeightMultiplier: 1.15,
    zpdDifficultyOffset: -0.75,
  });

  const holdoutQ: QuestionItem = {
    ...SAMPLE_Q,
    questionId: 'q_holdout_pool_v1',
    questionFamilyId: 'q_holdout_pool',
    poolType: 'benchmark_holdout',
  };
  const practiceMath: QuestionItem = {
    ...SAMPLE_Q,
    questionId: 'q_prac_math_v1',
    questionFamilyId: 'q_prac_math',
    section: 'MATH',
    formatType: 'MATH_MCQ_5',
    poolType: 'practice',
    parts: [{ ...SAMPLE_Q.parts[0], partId: 'pm1', skillId: 'MATH.GEO2D.COMPOSITE_AREA' }],
  };

  const { candidates, targetCount, effectiveCaps } = selectPracticeCandidates({
    mode: 'daily_adaptive',
    questions: [SAMPLE_Q, holdoutQ, practiceMath],
    skillStates: {},
    questionMemory: {},
    algorithmAdjustments: clamped,
    config: DEFAULT_LEARNING_CONFIG,
    nowIso: '2026-11-14T12:00:00Z',
    seed: 5,
    poolLimit: 12,
  });

  assert.equal(candidates.some((c) => c.q.poolType === 'benchmark_holdout'), false);
  assert.equal(targetCount, 2);
  assert.ok(effectiveCaps);
});
