import assert from 'node:assert/strict';
import test from 'node:test';
import type { MarkingResult } from '../shared/contracts.ts';
import { buildBankQuestionHref, parseStudioTab, readAdminDeepLink } from './components/admin/adminDeepLink.ts';
import {
  collectMissedObjectiveQuestionIds,
  planReviewRepairDrill,
  REPAIR_DRILL_CAP,
  repairDrillPayload,
} from './components/repair/repairDrill.ts';
import { buildPassageCues } from './components/session/passageCohesion.ts';

test('passage cues number passages in section order with each question position', () => {
  const cues = buildPassageCues([
    { questionId: 'r1', section: 'READ', stimulus: { stimulusId: 'poem' } },
    { questionId: 'r2', section: 'READ', stimulus: { stimulusId: 'poem' } },
    { questionId: 'r3', section: 'READ', stimulus: { stimulusId: 'solo' } },
    { questionId: 'r4', section: 'READ', stimulusId: 'story' },
    { questionId: 'r5', section: 'READ', stimulusId: 'story' },
    { questionId: 'r6', section: 'READ', stimulusId: 'story' },
    { questionId: 'r7', section: 'READ' },
    { questionId: 'm1', section: 'MATH', stimulusId: 'story' },
  ]);
  assert.deepEqual(cues.get('r1'), { passageNumber: 1, position: 1, total: 2 });
  assert.deepEqual(cues.get('r2'), { passageNumber: 1, position: 2, total: 2 });
  // A one-question passage still counts as passage 2 but needs no cue.
  assert.equal(cues.has('r3'), false);
  assert.deepEqual(cues.get('r4'), { passageNumber: 3, position: 1, total: 3 });
  assert.deepEqual(cues.get('r6'), { passageNumber: 3, position: 3, total: 3 });
  assert.equal(cues.has('r7'), false);
  assert.equal(cues.has('m1'), false);
  assert.equal(buildPassageCues([]).size, 0);
});

const mark = (partId: string, isCorrect: boolean, selectedAnswer: string | null = 'A'): MarkingResult => ({
  partId,
  isCorrect,
  selectedAnswer,
  correctAnswerKey: 'A',
  workedExplanation: '',
});

test('missed objective questions include wrong and unanswered parts, never Writing', () => {
  const questions = [
    { questionId: 'q1', formatType: 'MATH_MCQ_5' },
    { questionId: 'q2', formatType: 'MATH_MCQ_5' },
    { questionId: 'q3', formatType: 'READ_VOCAB_CLOZE' },
    { questionId: 'q4', formatType: 'THINK_MCQ_4' },
    { questionId: 'w1', formatType: 'WRIT_TYPED_TASK' },
  ];
  const results: Record<string, MarkingResult[]> = {
    q1: [mark('q1p1', true)],
    q2: [mark('q2p1', false, 'B')],
    q3: [mark('q3p1', true), mark('q3p2', false, null)],
    q4: [mark('q4p1', true)],
    w1: [mark('w1p1', false)],
  };
  assert.deepEqual(collectMissedObjectiveQuestionIds(questions, results), ['q2', 'q3']);
});

test('review repair plan: session items, benchmark falls back to the pool, nothing when clean', () => {
  assert.equal(planReviewRepairDrill({ sessionMode: 'section_drill', missedQuestionIds: [] }), null);
  const plan = planReviewRepairDrill({ sessionMode: 'daily_adaptive', missedQuestionIds: ['q2', 'q3'] });
  assert.deepEqual(plan, { kind: 'session', questionIds: ['q2', 'q3'], count: 2 });
  assert.deepEqual(repairDrillPayload(plan!), { mode: 'repair_drill', questionIds: ['q2', 'q3'] });

  const many = Array.from({ length: 30 }, (_, i) => `q${i}`);
  const capped = planReviewRepairDrill({ sessionMode: 'section_drill', missedQuestionIds: many });
  assert.equal(capped && capped.kind === 'session' ? capped.count : 0, REPAIR_DRILL_CAP);

  const bench = planReviewRepairDrill({ sessionMode: 'benchmark_exam', missedQuestionIds: ['h1'] });
  assert.deepEqual(bench, { kind: 'pool' });
  assert.deepEqual(repairDrillPayload(bench!), { mode: 'repair_drill' });
  assert.equal(planReviewRepairDrill({ sessionMode: 'admin_calibration', missedQuestionIds: ['x'] }), null);
});

test('admin deep links open the bank with the requested question', () => {
  assert.deepEqual(readAdminDeepLink('?tab=bank&qid=q_math_01_v1'), { tab: 'bank', qid: 'q_math_01_v1' });
  // A qid always means the bank, whatever tab the link carries.
  assert.deepEqual(readAdminDeepLink('?tab=data&qid=abc'), { tab: 'bank', qid: 'abc' });
  assert.deepEqual(readAdminDeepLink('?tab=data'), { tab: 'data', qid: '' });
  assert.deepEqual(readAdminDeepLink(''), { tab: 'bank', qid: '' });
  assert.equal(parseStudioTab('students'), 'learners');
  assert.equal(parseStudioTab('backup'), 'data');
  assert.equal(parseStudioTab('nonsense'), 'bank');

  const href = buildBankQuestionHref('2026-11-26_b01_read_03_v1');
  assert.equal(href, '/admin?tab=bank&qid=2026-11-26_b01_read_03_v1');
  assert.deepEqual(readAdminDeepLink(href.slice(href.indexOf('?'))), { tab: 'bank', qid: '2026-11-26_b01_read_03_v1' });
  // Ids with reserved characters round-trip.
  const odd = buildBankQuestionHref('q a&b');
  assert.equal(readAdminDeepLink(odd.slice(odd.indexOf('?'))).qid, 'q a&b');
});
