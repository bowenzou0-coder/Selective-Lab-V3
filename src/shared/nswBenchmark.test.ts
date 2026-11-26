import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BENCHMARK_WEIGHTINGS,
  NSW_FULLY_SELECTIVE_SCHOOLS,
  buildBenchmarkReportRecord,
  buildParentVerdict,
  evaluateNswBenchmark,
  extractBenchmarkScoresFromSession,
} from './nswBenchmark.ts';

test('official 2025+ weighting uses 4 equal 25% components', () => {
  const w = BENCHMARK_WEIGHTINGS.official_2025_equal;
  assert.equal(w.READ, 0.25);
  assert.equal(w.MATH, 0.25);
  assert.equal(w.THINK, 0.25);
  assert.equal(w.WRIT, 0.25);
  assert.equal(w.READ + w.MATH + w.THINK + w.WRIT, 1);
});

test('gender toggle filters ineligible single-sex schools while keeping scores and cutoffs identical', () => {
  const baseInput = {
    read: { score: 32, maxScore: 38 },
    math: { score: 29, maxScore: 35 },
    think: { score: 33, maxScore: 40 },
    writ: { score: 15, maxScore: 20 },
    difficulty: 'real_exam' as const,
  };

  const allReport = evaluateNswBenchmark({ ...baseInput, genderFilter: 'all' });
  const girlsReport = evaluateNswBenchmark({ ...baseInput, genderFilter: 'girls' });
  const boysReport = evaluateNswBenchmark({ ...baseInput, genderFilter: 'boys' });

  // Student scores & state rank remain identical regardless of gender filter
  assert.equal(girlsReport.scaledScore120, allReport.scaledScore120);
  assert.equal(boysReport.scaledScore120, allReport.scaledScore120);
  assert.equal(girlsReport.estimatedPercentile, allReport.estimatedPercentile);
  assert.equal(boysReport.estimatedStateRank, allReport.estimatedStateRank);

  // Girls filter removes boys-only schools (e.g. NSB, SBHS, Normanhurst, Sydney Tech)
  assert.equal(girlsReport.schools.some((s) => s.school.id === 'north_sydney_boys'), false);
  assert.equal(girlsReport.schools.some((s) => s.school.id === 'sydney_boys'), false);
  assert.equal(girlsReport.schools.some((s) => s.school.id === 'hornsby_girls'), true);
  assert.equal(girlsReport.schools.some((s) => s.school.id === 'baulkham_hills'), true);

  // Boys filter removes girls-only schools (e.g. HGHS, NSG, SGHS, St George Girls)
  assert.equal(boysReport.schools.some((s) => s.school.id === 'hornsby_girls'), false);
  assert.equal(boysReport.schools.some((s) => s.school.id === 'north_sydney_girls'), false);
  assert.equal(boysReport.schools.some((s) => s.school.id === 'north_sydney_boys'), true);
  assert.equal(boysReport.schools.some((s) => s.school.id === 'baulkham_hills'), true);

  // Shared co-ed school cutoffs stay identical across toggles, while eligible spots reflect 50/50 split
  const baulkoAll = allReport.schools.find((s) => s.school.id === 'baulkham_hills')!;
  const baulkoGirls = girlsReport.schools.find((s) => s.school.id === 'baulkham_hills')!;
  assert.equal(baulkoGirls.firstRoundCutoff120, baulkoAll.firstRoundCutoff120);
  assert.equal(baulkoGirls.reserveCutoff120, baulkoAll.reserveCutoff120);
  assert.equal(baulkoAll.eligibleSpots, 180);
  assert.equal(baulkoGirls.eligibleSpots, 90);
  assert.equal(baulkoGirls.estimatedGeneralSpots, 72); // 80% after 20% equity reserve
});

test('higher scores and harder difficulty presets produce strictly higher scaled scores', () => {
  const sameRaw = {
    read: { score: 30, maxScore: 38 },
    math: { score: 27, maxScore: 35 },
    think: { score: 30, maxScore: 40 },
    writ: { score: 15, maxScore: 20 },
  };
  const onSample = evaluateNswBenchmark({ ...sameRaw, difficulty: 'official_sample' });
  const onReal = evaluateNswBenchmark({ ...sameRaw, difficulty: 'real_exam' });
  const onStandard = evaluateNswBenchmark({ ...sameRaw, difficulty: 'selective_lab_standard' });
  const onTimed = evaluateNswBenchmark({ ...sameRaw, difficulty: 'selective_lab_timed' });
  const onHard = evaluateNswBenchmark({ ...sameRaw, difficulty: 'selective_lab_hard' });

  assert.ok(onSample.scaledScore120 < onReal.scaledScore120);
  assert.ok(onReal.scaledScore120 < onStandard.scaledScore120);
  assert.ok(onStandard.scaledScore120 < onTimed.scaledScore120);
  assert.ok(onTimed.scaledScore120 < onHard.scaledScore120);

  // Strong score on real exam reaches top tier
  const topStudent = evaluateNswBenchmark({
    read: { score: 35, maxScore: 38 },
    math: { score: 32, maxScore: 35 },
    think: { score: 36, maxScore: 40 },
    writ: { score: 17, maxScore: 20 },
    difficulty: 'real_exam',
  });
  assert.equal(topStudent.sections.READ.band, 'top_10');
  assert.equal(topStudent.sections.MATH.band, 'top_10');
  assert.equal(topStudent.sections.THINK.band, 'top_10');
  assert.equal(topStudent.sections.WRIT.band, 'top_10');
  const jr = topStudent.schools.find((s) => s.school.id === 'james_ruse')!;
  assert.equal(jr.status, 'likely_offer');
});

test('school catalog covers all 18 major fully selective schools with consistent spot math', () => {
  assert.equal(NSW_FULLY_SELECTIVE_SCHOOLS.length, 18);
  for (const s of NSW_FULLY_SELECTIVE_SCHOOLS) {
    assert.equal(s.boysSpots + s.girlsSpots, s.totalSpots, `${s.id} gender spots sum to total`);
    assert.ok(s.firstRoundCutoff120 > s.reserveCutoff120, `${s.id} first round > reserve`);
  }
});

test('extractBenchmarkScoresFromSession parses multi-section review results and detects difficulty', () => {
  const extracted = extractBenchmarkScoresFromSession({
    sessionTitle: 'Benchmark: 2026-11-23_b06 (Full Exam)',
    questions: [
      { questionId: 'q_r', section: 'READ', formatType: 'READ_FICTION_MCQ' },
      { questionId: 'q_m', section: 'MATH', formatType: 'MATH_MCQ_5' },
      { questionId: 'q_t', section: 'THINK', formatType: 'THINK_MCQ_4' },
    ],
    reviewResults: {
      q_r: [
        { partId: 'p1', isCorrect: true, selectedAnswer: 'A', correctAnswerKey: 'A', workedExplanation: 'x' },
        { partId: 'p2', isCorrect: false, selectedAnswer: 'B', correctAnswerKey: 'C', workedExplanation: 'x' },
      ],
      q_m: [
        { partId: 'pm1', isCorrect: true, selectedAnswer: 'D', correctAnswerKey: 'D', workedExplanation: 'x' },
      ],
      q_t: [
        { partId: 'pt1', isCorrect: true, selectedAnswer: 'A', correctAnswerKey: 'A', workedExplanation: 'x' },
      ],
    },
  });
  assert.equal(extracted.hasObjectiveMultiSection, true);
  assert.deepEqual(extracted.read, { score: 1, maxScore: 2 });
  assert.deepEqual(extracted.math, { score: 1, maxScore: 1 });
  assert.deepEqual(extracted.think, { score: 1, maxScore: 1 });
  assert.equal(extracted.suggestedDifficulty, 'selective_lab_hard');

  assert.equal(
    extractBenchmarkScoresFromSession({
      sessionTitle: 'Benchmark: benchmark_1_2x_2026_11_26',
      questions: [],
      reviewResults: {},
    }).suggestedDifficulty,
    'selective_lab_standard'
  );
  assert.equal(
    extractBenchmarkScoresFromSession({
      sessionTitle: 'Benchmark: benchmark_1_35x_2026_11_26',
      questions: [],
      reviewResults: {},
    }).suggestedDifficulty,
    'selective_lab_timed'
  );
  assert.equal(
    extractBenchmarkScoresFromSession({
      sessionTitle: 'Benchmark: benchmark_1_5x_2026_11_26',
      questions: [],
      reviewResults: {},
    }).suggestedDifficulty,
    'selective_lab_hard'
  );
});

test('buildParentVerdict produces clear parent headline and buildBenchmarkReportRecord captures unanswered/weak skills', () => {
  const evaluated = evaluateNswBenchmark({
    read: { score: 31, maxScore: 38 },
    math: { score: 28, maxScore: 35 },
    think: { score: 32, maxScore: 40 },
    writ: { score: 16, maxScore: 20 },
    difficulty: 'selective_lab_timed',
    genderFilter: 'girls',
  });
  const verdict = buildParentVerdict(evaluated);
  assert.ok(verdict.headlineEn.length > 10);
  assert.ok(verdict.headlineZh.length > 5);
  assert.equal(verdict.headlineEn.includes('·'), false);
  assert.equal(verdict.headlineZh.includes('·'), false);

  const report = buildBenchmarkReportRecord({
    session: {
      sessionId: 'sess_bench_1',
      studentId: 'stu_1',
      configVersionId: 'cfg_v1',
      mode: 'benchmark_exam',
      title: 'Benchmark: 2026-11-22_b17 (Full Exam)',
      status: 'submitted',
      plannedQuestionIds: ['q1', 'q2'],
      timeLimitSec: 9300,
      totalSlots: 2,
      correctSlots: 1,
      startedAt: '2026-11-24T00:00:00.000Z',
      completedAt: '2026-11-24T02:30:00.000Z',
    },
    questions: [
      {
        questionId: 'q1',
        section: 'MATH',
        formatType: 'MATH_MCQ_5',
        batchLabel: '2026-11-22_b17',
        parts: [
          {
            partId: 'q1_p1',
            partIndex: 0,
            promptText: 'p',
            skillId: 'MATH.GEO2D.COMPOSITE_AREA',
            difficultyInitial: 4.5,
            targetTimeSec: 65,
            cognitiveDemand: 'apply_procedural',
            options: [],
            correctAnswerKey: 'A',
            workedExplanation: 'x',
          },
        ],
      },
      {
        questionId: 'q2',
        section: 'THINK',
        formatType: 'THINK_MCQ_4',
        batchLabel: '2026-11-22_b17',
        parts: [
          {
            partId: 'q2_p1',
            partIndex: 0,
            promptText: 'p',
            skillId: 'THINK.DEDUCT.WHOSE_REASONING_CORRECT',
            difficultyInitial: 4.5,
            targetTimeSec: 60,
            cognitiveDemand: 'analyze_infer',
            options: [],
            correctAnswerKey: 'B',
            workedExplanation: 'x',
          },
        ],
      },
    ],
    reviewResults: {
      q1: [{ partId: 'q1_p1', isCorrect: true, selectedAnswer: 'A', correctAnswerKey: 'A', workedExplanation: 'x' }],
      q2: [{ partId: 'q2_p1', isCorrect: false, selectedAnswer: null, correctAnswerKey: 'B', workedExplanation: 'x' }],
    },
  });
  assert.equal(report.sections.MATH.correct, 1);
  assert.equal(report.sections.THINK.unanswered, 1);
  assert.equal(report.weakSkillStats[0]?.skillId, 'THINK.DEDUCT.WHOSE_REASONING_CORRECT');
  assert.equal(report.difficulty, 'selective_lab_timed');
});
