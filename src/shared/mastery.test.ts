import assert from 'node:assert/strict';
import test from 'node:test';
import type { QuestionItem, StimulusGroup } from './contracts.ts';
import {
  advanceQuestionEvidence,
  buildEvidenceKey,
  computeBankMasterySummary,
  computeEvidenceRevision,
  formatMasteryPercent,
  isQuestionEligibleForMastery,
} from './mastery.ts';

function makeQuestion(overrides: Partial<QuestionItem> = {}): QuestionItem {
  return {
    questionId: 'q_test_1_v1',
    questionFamilyId: 'q_test_1',
    version: 1,
    section: 'MATH',
    formatType: 'MATH_MCQ_5',
    poolType: 'practice',
    qcStatus: 'active',
    parts: [
      {
        partId: 'q_test_1_p1',
        partIndex: 0,
        promptText: 'What is 6 × 7?',
        skillId: 'MATH.NUM.FACTORS_MULTIPLES_PRIMES',
        difficultyInitial: 2.0,
        targetTimeSec: 60,
        cognitiveDemand: 'apply_procedural',
        options: [
          { key: 'A', text: '36' },
          { key: 'B', text: '42' },
          { key: 'C', text: '48' },
          { key: 'D', text: '49' },
          { key: 'E', text: '54' },
        ],
        correctAnswerKey: 'B',
        workedExplanation: '6 × 7 = 42.',
      },
    ],
    provenance: {
      sourceType: 'human_authored',
      verifierAgreed: true,
      auditorReviewed: true,
    },
    ...overrides,
  };
}

function makeStimulus(overrides: Partial<StimulusGroup> = {}): StimulusGroup {
  return {
    stimulusId: 'stim_test_1_v1',
    stimulusFamilyId: 'stim_test_1',
    version: 1,
    section: 'READ',
    genreOrTextType: 'fiction',
    title: 'The Lantern',
    mainTextMarkdown: 'Maya carried the brass lantern up the steep stone steps.',
    sourceType: 'human_authored',
    ...overrides,
  };
}

test('formatMasteryPercent enforces zero-denominator guard and conservative floor', () => {
  assert.equal(formatMasteryPercent(0, 0), 'No evidence');
  assert.equal(formatMasteryPercent(0, 10), '0%');
  assert.equal(formatMasteryPercent(10, 10), '100%');
  assert.equal(formatMasteryPercent(9996, 10000), '99.9%');
  assert.equal(formatMasteryPercent(1, 3), '33.3%');
  assert.equal(formatMasteryPercent(2, 4), '50%');
});

test('computeEvidenceRevision ignores explanation/qc edits but changes on answer/option edits', () => {
  const stim = makeStimulus();
  const baseQ = makeQuestion({
    section: 'READ',
    formatType: 'READ_FICTION_MCQ',
    stimulusId: stim.stimulusId,
    parts: [
      {
        partId: 'p1',
        partIndex: 0,
        promptText: 'What did Maya carry?',
        skillId: 'READ.FIC.LITERAL_DETAIL',
        difficultyInitial: 2.0,
        targetTimeSec: 60,
        cognitiveDemand: 'recall_locate',
        options: [
          { key: 'A', text: 'A brass lantern' },
          { key: 'B', text: 'A silver compass' },
        ],
        correctAnswerKey: 'A',
        workedExplanation: 'Line 1 states she carried the brass lantern.',
      },
    ],
  });

  const revBase = computeEvidenceRevision(baseQ, stim);

  const cosmeticEdit: QuestionItem = {
    ...baseQ,
    qcStatus: 'verified',
    parts: [
      {
        ...baseQ.parts[0],
        workedExplanation: 'Updated detailed explanation with citation.',
        distractorRationales: { B: 'No compass appears in the passage.' },
      },
    ],
  };
  assert.equal(computeEvidenceRevision(cosmeticEdit, stim), revBase);

  const substantiveEdit: QuestionItem = {
    ...baseQ,
    parts: [
      {
        ...baseQ.parts[0],
        options: [
          { key: 'A', text: 'A copper lantern' },
          { key: 'B', text: 'A silver compass' },
        ],
      },
    ],
  };
  assert.notEqual(computeEvidenceRevision(substantiveEdit, stim), revBase);
});

test('advanceQuestionEvidence enforces 3-stage 24h + 7d spacing, failure resets, assistance block, and sandbox throw', () => {
  const q = makeQuestion();
  const rev = computeEvidenceRevision(q);

  assert.throws(
    () =>
      advanceQuestionEvidence({
        question: q,
        evidenceRevision: rev,
        allPartsClean: true,
        isSandbox: true,
        submittedAtIso: '2026-01-01T00:00:00.000Z',
      }),
    /Sandbox submissions/
  );

  // Pass 1 -> correct_once
  const s1 = advanceQuestionEvidence({
    question: q,
    evidenceRevision: rev,
    allPartsClean: true,
    submittedAtIso: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(s1.status, 'correct_once');
  assert.equal(s1.cleanPassesCount, 1);
  assert.equal(s1.firstSubmissionCleanPass, true);

  // Too early (+12h < 24h) -> remains correct_once
  const sEarly = advanceQuestionEvidence({
    prev: s1,
    question: q,
    evidenceRevision: rev,
    allPartsClean: true,
    submittedAtIso: '2026-01-01T12:00:00.000Z',
  });
  assert.equal(sEarly.status, 'correct_once');
  assert.equal(sEarly.cleanPassesCount, 1);

  // Assisted pass even after 24h -> disqualified from advancing
  const sAssisted = advanceQuestionEvidence({
    prev: sEarly,
    question: q,
    evidenceRevision: rev,
    allPartsClean: true,
    assisted: true,
    submittedAtIso: '2026-01-02T01:00:00.000Z',
  });
  assert.equal(sAssisted.status, 'correct_once');
  assert.equal(sAssisted.cleanPassesCount, 1);

  // Valid Pass 2 (+25h >= 24h) -> awaiting_review
  const s2 = advanceQuestionEvidence({
    prev: sAssisted,
    question: q,
    evidenceRevision: rev,
    allPartsClean: true,
    submittedAtIso: '2026-01-02T02:00:00.000Z',
  });
  assert.equal(s2.status, 'awaiting_review');
  assert.equal(s2.cleanPassesCount, 2);

  // Too early for stage 3 (+3 days < 7 days) -> remains awaiting_review
  const sEarly3 = advanceQuestionEvidence({
    prev: s2,
    question: q,
    evidenceRevision: rev,
    allPartsClean: true,
    submittedAtIso: '2026-01-05T02:00:00.000Z',
  });
  assert.equal(sEarly3.status, 'awaiting_review');
  assert.equal(sEarly3.cleanPassesCount, 2);

  // Valid Pass 3 (+7 days >= 168h) -> retained
  const s3 = advanceQuestionEvidence({
    prev: sEarly3,
    question: q,
    evidenceRevision: rev,
    allPartsClean: true,
    submittedAtIso: '2026-01-09T02:01:00.000Z',
  });
  assert.equal(s3.status, 'retained');
  assert.equal(s3.cleanPassesCount, 3);

  // Subsequent wrong attempt resets certification to needs_repair and increments resetCount
  const sReset = advanceQuestionEvidence({
    prev: s3,
    question: q,
    evidenceRevision: rev,
    allPartsClean: false,
    submittedAtIso: '2026-01-10T02:00:00.000Z',
  });
  assert.equal(sReset.status, 'needs_repair');
  assert.equal(sReset.cleanPassesCount, 0);
  assert.equal(sReset.resetCount, 1);
  assert.equal(sReset.everCleanPassed, true);
});

test('computeBankMasterySummary excludes holdouts, writing, inactive items and partitions buckets mutually exclusively', () => {
  const q1 = makeQuestion({ questionId: 'q1_v1', questionFamilyId: 'q1', section: 'MATH' });
  const q2 = makeQuestion({ questionId: 'q2_v1', questionFamilyId: 'q2', section: 'READ' });
  const q3 = makeQuestion({ questionId: 'q3_v1', questionFamilyId: 'q3', section: 'THINK' });
  const q4 = makeQuestion({ questionId: 'q4_v1', questionFamilyId: 'q4', section: 'MATH' });
  const qHoldout = makeQuestion({
    questionId: 'qh_v1',
    questionFamilyId: 'qh',
    poolType: 'benchmark_holdout',
  });
  const qDraft = makeQuestion({
    questionId: 'qd_v1',
    questionFamilyId: 'qd',
    qcStatus: 'draft',
  });
  const qWriting = makeQuestion({
    questionId: 'qw_v1',
    questionFamilyId: 'qw',
    section: 'WRIT',
    formatType: 'WRIT_TYPED_TASK',
  });

  assert.equal(isQuestionEligibleForMastery(q1), true);
  assert.equal(isQuestionEligibleForMastery(qHoldout), false);
  assert.equal(isQuestionEligibleForMastery(qDraft), false);
  assert.equal(isQuestionEligibleForMastery(qWriting), false);

  const rev1 = computeEvidenceRevision(q1);
  const rev2 = computeEvidenceRevision(q2);
  const rev3 = computeEvidenceRevision(q3);

  const ev1Pass1 = advanceQuestionEvidence({
    question: q1,
    evidenceRevision: rev1,
    allPartsClean: true,
    submittedAtIso: '2026-01-01T00:00:00.000Z',
  });
  const ev1Pass2 = advanceQuestionEvidence({
    prev: ev1Pass1,
    question: q1,
    evidenceRevision: rev1,
    allPartsClean: true,
    submittedAtIso: '2026-01-02T01:00:00.000Z',
  });
  const ev1Retained = advanceQuestionEvidence({
    prev: ev1Pass2,
    question: q1,
    evidenceRevision: rev1,
    allPartsClean: true,
    submittedAtIso: '2026-01-10T01:00:00.000Z',
  });
  const ev2CorrectOnce = advanceQuestionEvidence({
    question: q2,
    evidenceRevision: rev2,
    allPartsClean: true,
    submittedAtIso: '2026-01-01T00:00:00.000Z',
  });
  const ev3Repair = advanceQuestionEvidence({
    question: q3,
    evidenceRevision: rev3,
    allPartsClean: false,
    submittedAtIso: '2026-01-01T00:00:00.000Z',
  });

  const summary = computeBankMasterySummary({
    questions: [q1, q2, q3, q4, qHoldout, qDraft, qWriting],
    evidenceMap: {
      [buildEvidenceKey(q1.questionFamilyId, rev1)]: ev1Retained,
      [buildEvidenceKey(q2.questionFamilyId, rev2)]: ev2CorrectOnce,
      [buildEvidenceKey(q3.questionFamilyId, rev3)]: ev3Repair,
    },
    legacyAttemptsCount: 5,
    holdoutAttempts: [
      {
        attemptId: 'att_h1',
        sessionId: 'sess_h',
        questionId: qHoldout.questionId,
        questionFamilyId: qHoldout.questionFamilyId,
        partId: qHoldout.parts[0].partId,
        skillId: qHoldout.parts[0].skillId,
        difficultyAtAttempt: 2,
        selectedAnswer: 'B',
        isCorrect: true,
        timeSpentSec: 40,
        isSpacedReview: false,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    writingSubmissionsCount: 2,
    writingEvaluatedCount: 1,
  });

  assert.equal(summary.eligibleCount, 4);
  assert.equal(summary.excludedHoldoutCount, 1);
  assert.equal(summary.excludedWritingCount, 1);
  assert.equal(summary.excludedInactiveCount, 1);
  assert.equal(summary.retainedCount, 1);
  assert.equal(summary.correctOnceCount, 1);
  assert.equal(summary.awaitingReviewCount, 0);
  assert.equal(summary.needsRepairCount, 1);
  assert.equal(summary.unseenCount, 1);
  assert.equal(
    summary.retainedCount +
      summary.correctOnceCount +
      summary.awaitingReviewCount +
      summary.needsRepairCount +
      summary.unseenCount,
    summary.eligibleCount
  );
  assert.equal(summary.retainedPercentDisplay, '25%');
  assert.equal(summary.correctOncePercentDisplay, '50%');
  assert.equal(summary.legacyAttemptsCount, 5);
  assert.equal(summary.holdoutSummary.accuracyDisplay, '100%');
  assert.equal(summary.writingSummary.evaluatedCount, 1);
});
