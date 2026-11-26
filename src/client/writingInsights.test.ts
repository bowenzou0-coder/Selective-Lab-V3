import assert from 'node:assert/strict';
import test from 'node:test';
import type { WritingEvaluationRecord } from '../shared/contracts.ts';
import {
  compareEssays,
  countParagraphs,
  DEFAULT_WORD_RANGE,
  essayScore,
  formatSignedDelta,
  pickComparisonPair,
  resolveWordRange,
  wordRangeProgress,
  writingPacing,
  type ComparableEssay,
} from './components/writing/writingInsights.ts';

test('word range accepts tuples, objects, strings and falls back safely', () => {
  assert.deepEqual(resolveWordRange([250, 350]), { min: 250, max: 350, isFallback: false });
  assert.deepEqual(resolveWordRange({ min: 200, max: 300 }), { min: 200, max: 300, isFallback: false });
  assert.deepEqual(resolveWordRange('250–350 words'), { min: 250, max: 350, isFallback: false });
  assert.deepEqual(resolveWordRange('300-400'), { min: 300, max: 400, isFallback: false });
  assert.deepEqual(resolveWordRange([400, 300]), { min: 300, max: 400, isFallback: false });
  assert.deepEqual(resolveWordRange(250), { min: 250, max: 350, isFallback: false });
  for (const bad of [undefined, null, '', 'lots', [], [0, -5], { foo: 1 }]) {
    assert.deepEqual(
      resolveWordRange(bad),
      { min: DEFAULT_WORD_RANGE[0], max: DEFAULT_WORD_RANGE[1], isFallback: true },
      JSON.stringify(bad)
    );
  }
});

test('word range progress moves from building to in-target to over', () => {
  const range = { min: 250, max: 350 };
  assert.equal(wordRangeProgress(0, range).state, 'empty');
  const building = wordRangeProgress(120, range);
  assert.equal(building.state, 'building');
  assert.equal(building.wordsToMin, 130);
  assert.equal(wordRangeProgress(250, range).state, 'in_target');
  assert.equal(wordRangeProgress(350, range).state, 'in_target');
  const over = wordRangeProgress(380, range);
  assert.equal(over.state, 'over');
  assert.equal(over.wordsOver, 30);
  // Scale runs to 120% of the max (420 words): edges and clamping.
  assert.equal(Math.round(wordRangeProgress(0, range).maxPct), 83);
  assert.equal(Math.round(wordRangeProgress(0, range).minPct), 60);
  assert.equal(wordRangeProgress(2000, range).fillPct, 100);
  assert.equal(wordRangeProgress(-5, range).fillPct, 0);
});

test('pacing is calm: planning, steady, building, ahead, then reread', () => {
  const range = { min: 250, max: 350 };
  const total = 1800;
  assert.equal(writingPacing({ elapsedSec: 60, totalSec: total, wordCount: 0, range }).phase, 'planning');
  // Halfway: a steady writer has ~(0.5-0.15)/0.75 * 250 ≈ 117 words.
  assert.equal(writingPacing({ elapsedSec: 900, totalSec: total, wordCount: 115, range }).tone, 'steady');
  assert.equal(writingPacing({ elapsedSec: 900, totalSec: total, wordCount: 40, range }).tone, 'building');
  assert.equal(writingPacing({ elapsedSec: 900, totalSec: total, wordCount: 260, range }).tone, 'ahead');
  const late = writingPacing({ elapsedSec: 1700, totalSec: total, wordCount: 300, range });
  assert.equal(late.phase, 'reviewing');
  assert.equal(late.tone, 'steady');
  assert.equal(writingPacing({ elapsedSec: 1700, totalSec: total, wordCount: 100, range }).tone, 'building');
  assert.equal(writingPacing({ elapsedSec: 100, totalSec: null, wordCount: 10, range }).phase, 'untimed');
  // Never past 100% of the time.
  assert.equal(writingPacing({ elapsedSec: 5000, totalSec: total, wordCount: 10, range }).timeUsed, 1);
});

test('paragraphs are counted by blank lines', () => {
  assert.equal(countParagraphs(''), 0);
  assert.equal(countParagraphs('One.\n\nTwo.\n\n\nThree.'), 3);
  assert.equal(countParagraphs('One line\nstill one paragraph'), 1);
});

function evaluation(total: number, criteria: Record<string, number>, band: WritingEvaluationRecord['overallBand'] = 'B'): WritingEvaluationRecord {
  return {
    evaluationId: `ev_${total}`,
    submissionId: 's',
    evaluatorType: 'ai',
    topicAdherencePass: true,
    overallBandEstimate: 'strong',
    overallBand: band,
    totalMarks: total,
    maxTotalMarks: 20,
    criteriaScores: Object.entries(criteria).map(([criterionSkillId, score]) => ({ criterionSkillId, score, comment: '' })),
    topStrengths: [],
    priorityFixes: [],
    createdAt: '2026-11-01T00:00:00.000Z',
  };
}

const essay = (id: string, date: string, words: number, evaluations: WritingEvaluationRecord[] = []): ComparableEssay => ({
  submissionId: id,
  submittedAt: date,
  wordCount: words,
  responseText: `${id} text`,
  evaluations,
});

test('comparison pairs an essay with the one before it and reports word, mark and rubric deltas', () => {
  const oldest = essay('a', '2026-10-01T00:00:00.000Z', 220, [evaluation(11, { 'WRIT.CRIT.IDEAS_CREATIVITY': 2, 'WRIT.CRIT.STRUCTURE_LAYOUT': 2 }, 'C')]);
  const middle = essay('b', '2026-10-15T00:00:00.000Z', 300, [evaluation(14, { 'WRIT.CRIT.IDEAS_CREATIVITY': 3, 'WRIT.CRIT.STRUCTURE_LAYOUT': 2 })]);
  const newest = essay('c', '2026-11-01T00:00:00.000Z', 280);

  assert.equal(pickComparisonPair([oldest]), null);
  const defaultPair = pickComparisonPair([oldest, newest, middle])!;
  assert.equal(defaultPair.current.submissionId, 'c');
  assert.equal(defaultPair.previous.submissionId, 'b');
  const chosen = pickComparisonPair([oldest, newest, middle], 'b')!;
  assert.equal(chosen.previous.submissionId, 'a');
  // The oldest essay has nothing before it, so the newest pair is used.
  assert.equal(pickComparisonPair([oldest, newest, middle], 'a')!.current.submissionId, 'c');

  const marked = compareEssays(middle, oldest);
  assert.equal(marked.wordDelta, 80);
  assert.equal(marked.marksDelta, 3);
  assert.equal(marked.currentScore?.band, 'B');
  const ideas = marked.criteria.find((c) => c.skillId === 'WRIT.CRIT.IDEAS_CREATIVITY')!;
  assert.deepEqual([ideas.previous, ideas.current, ideas.delta, ideas.max], [2, 3, 1, 4]);

  const unmarked = compareEssays(newest, middle);
  assert.equal(unmarked.wordDelta, -20);
  assert.equal(unmarked.marksDelta, null);
  assert.equal(unmarked.currentScore, null);
  assert.ok(unmarked.criteria.every((c) => c.current === null && c.delta === null));
});

test('essay score falls back to summed criteria and legacy bands', () => {
  const legacy = evaluation(0, { 'WRIT.CRIT.IDEAS_CREATIVITY': 3, 'WRIT.CRIT.STYLE_VOCABULARY': 2 });
  delete legacy.totalMarks;
  delete legacy.overallBand;
  legacy.overallBandEstimate = 'top_band';
  const score = essayScore({ evaluations: [legacy] })!;
  assert.equal(score.marks, 5);
  assert.equal(score.band, 'A');
  assert.equal(essayScore({ evaluations: [] }), null);
});

test('signed deltas use a true minus sign', () => {
  assert.equal(formatSignedDelta(4), '+4');
  assert.equal(formatSignedDelta(-3), '−3');
  assert.equal(formatSignedDelta(0), '0');
});
