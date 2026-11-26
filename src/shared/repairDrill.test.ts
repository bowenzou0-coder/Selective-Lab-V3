import test from 'node:test';
import assert from 'node:assert/strict';
import type { QuestionMasteryEvidence, SectionCode } from './contracts';
import {
  isRepairEligible,
  REPAIR_DRILL_MAX_QUESTIONS,
  repairDrillTimeLimitSec,
  selectRepairDrillQuestions,
  type SelectionQuestion,
} from './engine';

function q(
  questionId: string,
  section: SectionCode,
  extra: Partial<SelectionQuestion> = {}
): SelectionQuestion {
  return {
    questionId,
    questionFamilyId: questionId.replace(/_v\d+$/, ''),
    version: 1,
    section,
    formatType: section === 'READ' ? 'READ_FICTION_MCQ' : section === 'MATH' ? 'MATH_MCQ_5' : section === 'THINK' ? 'THINK_MCQ_4' : 'WRIT_TYPED_TASK',
    poolType: 'practice',
    qcStatus: 'active',
    evidenceRevision: 'r1',
    provenance: { sourceType: 'human_authored' },
    parts: [{ partId: `${questionId}_p1`, skillId: 'SKILL', difficultyInitial: 3, targetTimeSec: 60 }],
    ...extra,
  };
}

function ev(
  question: SelectionQuestion,
  status: QuestionMasteryEvidence['status'],
  lastAttemptAtIso = '2026-11-01T00:00:00.000Z'
): [string, QuestionMasteryEvidence] {
  const key = `${question.questionFamilyId}__${question.evidenceRevision}`;
  return [
    key,
    {
      evidenceKey: key,
      questionFamilyId: question.questionFamilyId,
      questionId: question.questionId,
      evidenceRevision: question.evidenceRevision!,
      section: question.section,
      status,
      cleanPassesCount: 0,
      passTimestampsIso: [],
      everCleanPassed: false,
      firstSubmissionCleanPass: false,
      attemptsCount: 1,
      resetCount: 0,
      lastAttemptAtIso,
      lastAllCorrect: status !== 'needs_repair',
      policyVersion: 'test',
      updatedAtIso: lastAttemptAtIso,
    },
  ];
}

const ids = (list: SelectionQuestion[]) => list.map((x) => x.questionId);

test('repair drill pulls only needs_repair questions from the pool', () => {
  const m1 = q('m_01_v1', 'MATH');
  const m2 = q('m_02_v1', 'MATH');
  const t1 = q('t_01_v1', 'THINK');
  const t2 = q('t_02_v1', 'THINK');
  const evidenceMap = Object.fromEntries([
    ev(m1, 'needs_repair'),
    ev(m2, 'retained'),
    ev(t1, 'correct_once'),
    ev(t2, 'needs_repair'),
  ]);
  const picked = selectRepairDrillQuestions({ questions: [m1, m2, t1, t2], evidenceMap });
  assert.deepEqual(ids(picked), ['m_01_v1', 't_02_v1']);
});

test('repair drill skips archived, quarantined, draft, holdout, writing and missing items', () => {
  const live = q('m_live_v1', 'MATH');
  const retired = q('m_retired_v1', 'MATH', { qcStatus: 'retired' });
  const quarantined = q('m_quar_v1', 'MATH', { qcStatus: 'quarantined' });
  const draft = q('m_draft_v1', 'MATH', { qcStatus: 'draft' });
  const holdout = q('m_hold_v1', 'MATH', { poolType: 'benchmark_holdout' });
  const writing = q('w_01_v1', 'WRIT');
  const evidenceMap = Object.fromEntries(
    [live, retired, quarantined, draft, holdout, writing].map((x) => ev(x, 'needs_repair'))
  );
  const pool = selectRepairDrillQuestions({
    questions: [live, retired, quarantined, draft, holdout, writing],
    evidenceMap,
  });
  assert.deepEqual(ids(pool), ['m_live_v1']);

  // Explicit targets get the same filtering; an id that no longer exists is ignored.
  const targeted = selectRepairDrillQuestions({
    questions: [live, retired, quarantined, holdout, writing],
    evidenceMap,
    targetQuestionIds: ['m_live_v1', 'm_retired_v1', 'm_quar_v1', 'm_hold_v1', 'w_01_v1', 'gone_v1'],
  });
  assert.deepEqual(ids(targeted), ['m_live_v1']);
  assert.equal(isRepairEligible(holdout), false);
  assert.equal(isRepairEligible(live), true);
});

test('explicit targets ignore needs_repair status and follow a family to its live version', () => {
  const m1 = q('m_01_v1', 'MATH');
  const m3v2 = q('m_03_v2', 'MATH', { questionFamilyId: 'm_03', version: 2, evidenceRevision: 'r2' });
  const other = q('m_04_v1', 'MATH');
  // Evidence for the old version (v1) of family m_03 links the requested id to its family.
  const oldEvidence: [string, QuestionMasteryEvidence] = [
    'm_03__r1',
    { ...ev(m3v2, 'needs_repair')[1], evidenceKey: 'm_03__r1', questionId: 'm_03_v1', evidenceRevision: 'r1' },
  ];
  const evidenceMap = Object.fromEntries([ev(m1, 'retained'), ev(other, 'needs_repair'), oldEvidence]);
  const picked = selectRepairDrillQuestions({
    questions: [m1, m3v2, other],
    evidenceMap,
    targetQuestionIds: ['m_01_v1', 'm_03_v1'],
  });
  assert.deepEqual(ids(picked), ['m_01_v1', 'm_03_v2']);
});

test('Reading questions sharing a stimulus stay grouped in passage order, sections run READ, MATH, THINK', () => {
  const r1 = q('r_07_v1', 'READ', { stimulusId: 'stim_B' });
  const r2 = q('r_02_v1', 'READ', { stimulusId: 'stim_A' });
  const r3 = q('r_09_v1', 'READ', { stimulusId: 'stim_B' });
  const r4 = q('r_01_v1', 'READ', { stimulusId: 'stim_A' });
  const r5 = q('r_05_v1', 'READ');
  const m1 = q('m_01_v1', 'MATH');
  const t1 = q('t_01_v1', 'THINK');
  const all = [t1, r1, m1, r2, r3, r4, r5];
  const evidenceMap = Object.fromEntries(all.map((x) => ev(x, 'needs_repair')));
  const picked = selectRepairDrillQuestions({ questions: all, evidenceMap });
  assert.deepEqual(ids(picked), ['r_01_v1', 'r_02_v1', 'r_05_v1', 'r_07_v1', 'r_09_v1', 'm_01_v1', 't_01_v1']);

  // Every passage appears as one contiguous run.
  const stimOrder = picked.filter((x) => x.stimulusId).map((x) => x.stimulusId);
  assert.deepEqual(stimOrder, ['stim_A', 'stim_A', 'stim_B', 'stim_B']);
});

test('cap keeps the newest mistakes and never splits a passage', () => {
  const passage = [1, 2, 3].map((n) => q(`r_0${n}_v1`, 'READ', { stimulusId: 'stim_old' }));
  const fresh = [1, 2, 3].map((n) => q(`m_0${n}_v1`, 'MATH'));
  const evidenceMap = Object.fromEntries([
    ...passage.map((x) => ev(x, 'needs_repair', '2026-10-01T00:00:00.000Z')),
    ...fresh.map((x, i) => ev(x, 'needs_repair', `2026-11-0${i + 1}T00:00:00.000Z`)),
  ]);
  // Limit 4: three recent Maths fit, the 3-question passage would overflow and is skipped whole.
  const picked = selectRepairDrillQuestions({ questions: [...passage, ...fresh], evidenceMap, limit: 4 });
  assert.deepEqual(ids(picked), ['m_01_v1', 'm_02_v1', 'm_03_v1']);

  // A single passage larger than the cap is trimmed rather than dropped.
  const big = Array.from({ length: 5 }, (_, i) => q(`r_1${i}_v1`, 'READ', { stimulusId: 'stim_big' }));
  const bigEvidence = Object.fromEntries(big.map((x) => ev(x, 'needs_repair')));
  assert.equal(selectRepairDrillQuestions({ questions: big, evidenceMap: bigEvidence, limit: 3 }).length, 3);

  const many = Array.from({ length: 30 }, (_, i) => q(`m_${String(i).padStart(2, '0')}_v1`, 'MATH'));
  const manyEvidence = Object.fromEntries(many.map((x) => ev(x, 'needs_repair')));
  assert.equal(selectRepairDrillQuestions({ questions: many, evidenceMap: manyEvidence }).length, REPAIR_DRILL_MAX_QUESTIONS);
});

test('empty pools return no questions and section filters narrow the pool', () => {
  const m1 = q('m_01_v1', 'MATH');
  const t1 = q('t_01_v1', 'THINK');
  assert.deepEqual(selectRepairDrillQuestions({ questions: [m1, t1], evidenceMap: {} }), []);
  assert.deepEqual(selectRepairDrillQuestions({ questions: [m1, t1], targetQuestionIds: [] }), []);
  const evidenceMap = Object.fromEntries([ev(m1, 'needs_repair'), ev(t1, 'needs_repair')]);
  assert.deepEqual(ids(selectRepairDrillQuestions({ questions: [m1, t1], evidenceMap, sectionFilter: 'THINK' })), ['t_01_v1']);
});

test('repair drill time limit is 1.5x target pace with a 5-minute floor', () => {
  assert.equal(repairDrillTimeLimitSec([q('m_01_v1', 'MATH')]), 300);
  const ten = Array.from({ length: 10 }, (_, i) => q(`m_${i}_v1`, 'MATH'));
  assert.equal(repairDrillTimeLimitSec(ten), 900);
});
