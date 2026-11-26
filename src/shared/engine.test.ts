import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LEARNING_CONFIG, type QuestionItem, type StimulusGroup } from './contracts';
import {
  allocateFullPoolMockCaps,
  clampAlgorithmAdjustments,
  computePoolMockBaseMinutes,
  computeWritingMetrics,
  detectPlateauStatus,
  gradeSubmission,
  selectAdminCalibrationQuestions,
  selectBenchmarkHoldoutQuestions,
  selectMockTestQuestions,
  selectPoolMockQuestions,
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

test('selectPracticeSession isolates benchmark_holdout and official_calibration from everyday practice', () => {
  const holdoutQ: QuestionItem = {
    ...SAMPLE_Q,
    questionId: 'q_off_pt3_read_q01_v1',
    questionFamilyId: 'q_off_pt3_read_q01',
    poolType: 'benchmark_holdout',
    provenance: { sourceType: 'official_doe', sourceReference: 'NSW DoE Reading PT3 Q1', verifierAgreed: true, auditorReviewed: true },
  };
  const officialQ: QuestionItem = {
    ...SAMPLE_Q,
    questionId: 'q_off_pt1_read_q01_v1',
    questionFamilyId: 'q_off_pt1_read_q01',
    poolType: 'official_calibration',
    provenance: { sourceType: 'official_doe', sourceReference: 'NSW DoE Reading PT1 Q1', verifierAgreed: true, auditorReviewed: true },
  };
  const practiceQ: QuestionItem = {
    ...SAMPLE_Q,
    questionId: '2026-11-26_b01_read_01_v1',
    questionFamilyId: '2026-11-26_b01_read_01',
    poolType: 'practice',
  };

  const daily = selectPracticeSession({
    mode: 'daily_adaptive',
    questions: [holdoutQ, officialQ, practiceQ],
    skillStates: {},
    questionMemory: {},
    config: DEFAULT_LEARNING_CONFIG,
    nowIso: '2026-11-14T12:00:00Z',
    seed: 42,
  });
  assert.deepEqual(daily.map((q) => q.questionId), ['2026-11-26_b01_read_01_v1']);

  const diagnostic = selectPracticeSession({
    mode: 'diagnostic',
    questions: [holdoutQ, officialQ, practiceQ],
    skillStates: {},
    questionMemory: {},
    config: DEFAULT_LEARNING_CONFIG,
    nowIso: '2026-11-14T12:00:00Z',
    seed: 42,
  });
  assert.deepEqual(diagnostic.map((q) => q.questionId), ['q_off_pt1_read_q01_v1']);

  const poolMock = selectPoolMockQuestions({
    questions: [holdoutQ, officialQ, practiceQ],
    sectionFilter: 'READ',
    questionCount: 5,
    seed: 42,
  });
  assert.deepEqual(poolMock.map((q) => q.questionId), ['2026-11-26_b01_read_01_v1']);

  const bench = selectPracticeSession({
    mode: 'benchmark_exam',
    questions: [holdoutQ, officialQ, practiceQ],
    skillStates: {},
    questionMemory: {},
    config: DEFAULT_LEARNING_CONFIG,
    nowIso: '2026-11-14T12:00:00Z',
    seed: 42,
  });
  assert.deepEqual(
    bench.map((q) => q.questionId).sort(),
    ['q_off_pt1_read_q01_v1', 'q_off_pt3_read_q01_v1']
  );
});

test('blended difficulty selection hits 80/20, 50/50, 20/80 quotas with fallback, unseen-first, and shuffled order', () => {
  const makeMath = (idx: number, diff: number): QuestionItem => ({
    ...SAMPLE_Q,
    questionId: `2026-11-26_b01_math_${String(idx).padStart(2, '0')}_v1`,
    questionFamilyId: `2026-11-26_b01_math_${String(idx).padStart(2, '0')}`,
    section: 'MATH',
    formatType: 'MATH_MCQ_5',
    poolType: 'practice',
    stimulusId: undefined,
    parts: [
      {
        ...SAMPLE_Q.parts[0],
        partId: `p_m_${idx}`,
        partIndex: 0,
        skillId: `MATH.SKILL.${idx % 6}`,
        difficultyInitial: diff,
      },
    ],
  });

  const lowPool = Array.from({ length: 15 }, (_, i) => makeMath(i + 1, 4.1 + (i % 3) * 0.1));
  const highPool = Array.from({ length: 15 }, (_, i) => makeMath(i + 16, 4.5 + (i % 4) * 0.1));
  const mixed = [...lowPool, ...highPool];

  const countLow = (items: QuestionItem[]) =>
    items.filter((q) => q.parts[0].difficultyInitial <= 4.35).length;

  const easyMock = selectPoolMockQuestions({ questions: mixed, sectionFilter: 'MATH', questionCount: 10, difficulty: 'easy', seed: 101 });
  const medMock = selectPoolMockQuestions({ questions: mixed, sectionFilter: 'MATH', questionCount: 10, difficulty: 'medium', seed: 101 });
  const hardMock = selectPoolMockQuestions({ questions: mixed, sectionFilter: 'MATH', questionCount: 10, difficulty: 'hard', seed: 101 });

  assert.equal(easyMock.length, 10);
  assert.equal(countLow(easyMock), 8);
  assert.equal(medMock.length, 10);
  assert.equal(countLow(medMock), 5);
  assert.equal(hardMock.length, 10);
  assert.equal(countLow(hardMock), 2);

  // Shuffled order: not strictly non-decreasing by difficulty
  const medDiffs = medMock.map((q) => q.parts[0].difficultyInitial);
  const isSortedAsc = medDiffs.every((d, i) => i === 0 || d >= medDiffs[i - 1]);
  assert.equal(isSortedAsc, false, 'Selected mock questions should be shuffled, not strictly sorted easy -> hard');

  // Soft fallback: if low band only has 2 items, Easy (quota 8 low) fills remaining 8 from high band (never hard-filters)
  const scarceLow = [...lowPool.slice(0, 2), ...highPool];
  const fallback = selectPracticeSession({
    mode: 'section_drill',
    sectionFilter: 'MATH',
    difficulty: 'easy',
    questionCountOverride: 10,
    questions: scarceLow,
    skillStates: {},
    questionMemory: {},
    config: DEFAULT_LEARNING_CONFIG,
    nowIso: '2026-11-26T10:00:00Z',
    seed: 77,
  });
  assert.equal(fallback.length, 10);
  assert.equal(countLow(fallback), 2);

  // Official benchmark Reading order places Cloze (Part 2) between Fiction (Part 1) and Poetry (Part 3)
  const officialRead: QuestionItem[] = [
    { ...SAMPLE_Q, questionId: 'official_pt1_read_01_v1', questionFamilyId: 'f_r1', section: 'READ', formatType: 'READ_FICTION_MCQ', poolType: 'official_calibration', batchId: 'b_off1' },
    { ...SAMPLE_Q, questionId: 'official_pt1_read_09_v1', questionFamilyId: 'f_r9', section: 'READ', formatType: 'READ_POETRY_MCQ', poolType: 'official_calibration', batchId: 'b_off1' },
    { ...SAMPLE_Q, questionId: 'official_pt1_read_15_v1', questionFamilyId: 'f_r15', section: 'READ', formatType: 'READ_GAPPED_TEXT', poolType: 'official_calibration', batchId: 'b_off1' },
    { ...SAMPLE_Q, questionId: 'official_pt1_read_17_v1', questionFamilyId: 'f_r17', section: 'READ', formatType: 'READ_VOCAB_CLOZE', poolType: 'official_calibration', batchId: 'b_off1' },
  ];
  const orderedOff = selectBenchmarkHoldoutQuestions({ batchId: 'b_off1', questions: officialRead });
  assert.deepEqual(
    orderedOff.map((q) => q.formatType),
    ['READ_FICTION_MCQ', 'READ_VOCAB_CLOZE', 'READ_POETRY_MCQ', 'READ_GAPPED_TEXT']
  );
});

test('selectMockTestQuestions returns fixed canonical order for PT1 and unified or holdout PT3', () => {
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
  const pt3Calib: QuestionItem = {
    ...SAMPLE_Q,
    questionId: 'q_off_pt3_math_q01_v1',
    questionFamilyId: 'f3',
    section: 'MATH',
    poolType: 'official_calibration',
  };
  const pt3Holdout: QuestionItem = {
    ...SAMPLE_Q,
    questionId: 'q_off_pt3_math_q02_v1',
    questionFamilyId: 'f4',
    section: 'MATH',
    poolType: 'benchmark_holdout',
  };

  const pickedPt1 = selectMockTestQuestions({ batch: 'PT1', questions: [pt1a, pt1b, pt3Calib, pt3Holdout] });
  assert.deepEqual(pickedPt1.map((q) => q.questionId), ['q_off_pt1_math_q01_v1', 'q_off_pt1_math_q02_v1']);

  const pickedPt3 = selectMockTestQuestions({ batch: 'PT3', questions: [pt1a, pt1b, pt3Calib, pt3Holdout] });
  assert.deepEqual(pickedPt3.map((q) => q.questionId), ['q_off_pt3_math_q01_v1', 'q_off_pt3_math_q02_v1']);
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

test('selectPracticeSession groups Reading questions cohesively by passage (1 text for 4 Qs, 2 texts for 10 Qs)', () => {
  const makeReadPassage = (passageIdx: number, count: number): QuestionItem[] =>
    Array.from({ length: count }, (_, i) => ({
      ...SAMPLE_Q,
      questionId: `q_read_p${passageIdx}_${i + 1}_v1`,
      questionFamilyId: `q_read_p${passageIdx}_${i + 1}`,
      section: 'READ',
      formatType: 'READ_FICTION_MCQ',
      poolType: 'practice',
      stimulusId: `stim_passage_${passageIdx}`,
      parts: [
        {
          ...SAMPLE_Q.parts[0],
          partId: `rp_${passageIdx}_${i + 1}`,
          skillId: 'READ.FIC.CHARACTER_INFERENCE',
        },
      ],
    }));

  // 4 passages × 5 questions each = 20 reading questions across 4 texts
  const readPool = [
    ...makeReadPassage(1, 5),
    ...makeReadPassage(2, 5),
    ...makeReadPassage(3, 5),
    ...makeReadPassage(4, 5),
  ];

  // Requesting 4 Reading questions MUST select from 1 single passage (never 4 scattered passages)
  const fourQs = selectPracticeSession({
    mode: 'section_drill',
    sectionFilter: 'READ',
    questionCountOverride: 4,
    questions: readPool,
    skillStates: {},
    questionMemory: {},
    config: DEFAULT_LEARNING_CONFIG,
    nowIso: '2026-11-25T10:00:00Z',
    seed: 99,
  });
  assert.equal(fourQs.length, 4);
  const fourStimuli = new Set(fourQs.map((q) => q.stimulusId));
  assert.equal(fourStimuli.size, 1);

  // Requesting 10 Reading questions MUST select exactly 2 passages consecutively (5 + 5)
  const tenQs = selectPracticeSession({
    mode: 'section_drill',
    sectionFilter: 'READ',
    questionCountOverride: 10,
    questions: readPool,
    skillStates: {},
    questionMemory: {},
    config: DEFAULT_LEARNING_CONFIG,
    nowIso: '2026-11-25T10:00:00Z',
    seed: 99,
  });
  assert.equal(tenQs.length, 10);
  const tenStimuli = new Set(tenQs.map((q) => q.stimulusId));
  assert.equal(tenStimuli.size, 2);
  // First 5 belong to one passage, next 5 belong to the second passage
  assert.equal(new Set(tenQs.slice(0, 5).map((q) => q.stimulusId)).size, 1);
  assert.equal(new Set(tenQs.slice(5, 10).map((q) => q.stimulusId)).size, 1);
});

test('allocateFullPoolMockCaps and computePoolMockBaseMinutes scale proportionally to official NSW counts and minutes', () => {
  const fullCaps = allocateFullPoolMockCaps(93);
  assert.deepEqual(fullCaps, { READ: 17, MATH: 35, THINK: 40, WRIT: 1 });
  assert.equal(computePoolMockBaseMinutes('ALL', 93), 155);

  const quickCaps = allocateFullPoolMockCaps(30);
  assert.equal(quickCaps.READ + quickCaps.MATH + quickCaps.THINK + quickCaps.WRIT, 30);
  assert.equal(quickCaps.WRIT, 1);
  assert.ok(quickCaps.THINK >= quickCaps.MATH && quickCaps.MATH >= quickCaps.READ);
  const quickMins = computePoolMockBaseMinutes('ALL', 30);
  assert.ok(quickMins > 45 && quickMins < 90, `Expected 30q full mock minutes to scale cleanly (got ${quickMins})`);

  assert.equal(computePoolMockBaseMinutes('READ', 17), 45);
  assert.equal(computePoolMockBaseMinutes('MATH', 35), 40);
  assert.equal(computePoolMockBaseMinutes('THINK', 40), 40);
  assert.equal(computePoolMockBaseMinutes('WRIT', 1), 30);
  assert.equal(computePoolMockBaseMinutes('THINK', 20), 20);
  assert.equal(computePoolMockBaseMinutes('MATH', 20), 23);
});
