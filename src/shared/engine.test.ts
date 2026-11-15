import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LEARNING_CONFIG, type QuestionItem, type StimulusGroup } from './contracts';
import {
  computeWritingMetrics,
  detectPlateauStatus,
  gradeSubmission,
  selectAdminCalibrationQuestions,
  selectMockTestQuestions,
  selectPracticeSession,
  toStudentQuestionView,
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

