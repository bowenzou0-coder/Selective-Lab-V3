import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computePoolHealth,
  deriveQuestionProgressMeta,
  poolStatusToQcStatus,
  qcStatusToPoolStatus,
} from './bankStatus.ts';
import type { QuestionItem, QuestionMasteryEvidence, QuestionMemoryState } from './contracts.ts';

function makeQuestion(overrides: Partial<QuestionItem>): QuestionItem {
  return {
    questionId: overrides.questionId || 'q_test_1',
    questionFamilyId: overrides.questionFamilyId || 'fam_test_1',
    version: 1,
    evidenceRevision: 'rev1',
    section: overrides.section || 'MATH',
    formatType: 'MATH_MCQ_5',
    poolType: overrides.poolType || 'practice',
    qcStatus: overrides.qcStatus || 'active',
    parts: [
      {
        partId: 'p1',
        partIndex: 0,
        promptText: '1 + 1 = ?',
        skillId: 'MATH_NUMBER_OPS',
        difficultyInitial: 2,
        targetTimeSec: 60,
        cognitiveDemand: 'apply_procedural',
        options: [
          { key: 'A', text: '1' },
          { key: 'B', text: '2' },
        ],
        correctAnswerKey: 'B',
        workedExplanation: '1 + 1 = 2',
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

test('maps 5 internal QcStatus values cleanly into 3 operational BankPoolStatus states', () => {
  assert.equal(qcStatusToPoolStatus('active'), 'live');
  assert.equal(qcStatusToPoolStatus('quarantined'), 'paused');
  assert.equal(qcStatusToPoolStatus('draft'), 'paused');
  assert.equal(qcStatusToPoolStatus('verified'), 'paused');
  assert.equal(qcStatusToPoolStatus('retired'), 'archived');

  assert.equal(poolStatusToQcStatus('live'), 'active');
  assert.equal(poolStatusToQcStatus('paused'), 'quarantined');
  assert.equal(poolStatusToQcStatus('archived'), 'retired');
});

test('derives question completion status accurately from evidence and memory', () => {
  const q1 = makeQuestion({ questionId: 'q1', questionFamilyId: 'f1' });
  const q2 = makeQuestion({ questionId: 'q2', questionFamilyId: 'f2' });
  const q3 = makeQuestion({ questionId: 'q3', questionFamilyId: 'f3' });
  const q4 = makeQuestion({ questionId: 'q4', questionFamilyId: 'f4' });

  const evidenceMap: Record<string, QuestionMasteryEvidence> = {
    f2__rev1: {
      evidenceKey: 'f2__rev1',
      questionFamilyId: 'f2',
      questionId: 'q2',
      evidenceRevision: 'rev1',
      section: 'MATH',
      status: 'retained',
      cleanPassesCount: 3,
      passTimestampsIso: ['2026-01-01T00:00:00Z'],
      everCleanPassed: true,
      firstSubmissionCleanPass: true,
      attemptsCount: 3,
      resetCount: 0,
      lastAllCorrect: true,
      policyVersion: 'v3',
      updatedAtIso: '2026-01-10T00:00:00Z',
    },
    f3__rev1: {
      evidenceKey: 'f3__rev1',
      questionFamilyId: 'f3',
      questionId: 'q3',
      evidenceRevision: 'rev1',
      section: 'MATH',
      status: 'needs_repair',
      cleanPassesCount: 0,
      passTimestampsIso: [],
      everCleanPassed: false,
      firstSubmissionCleanPass: false,
      attemptsCount: 1,
      resetCount: 1,
      lastAllCorrect: false,
      policyVersion: 'v3',
      updatedAtIso: '2026-01-10T00:00:00Z',
    },
  };
  const memory: Record<string, QuestionMemoryState> = {
    f4: {
      questionFamilyId: 'f4',
      timesSeen: 1,
      lastSeenAt: '2026-01-05T00:00:00Z',
      lastAllCorrect: true,
      nextDueAt: '2026-01-07T00:00:00Z',
      intervalDays: 2,
      lapseCount: 0,
    },
  };

  assert.equal(deriveQuestionProgressMeta(q1, evidenceMap, memory).completionStatus, 'unseen');
  assert.equal(deriveQuestionProgressMeta(q2, evidenceMap, memory).completionStatus, 'done');
  assert.equal(deriveQuestionProgressMeta(q3, evidenceMap, memory).completionStatus, 'needs_repair');
  assert.equal(deriveQuestionProgressMeta(q4, evidenceMap, memory).completionStatus, 'in_review');
});

test('computes pool health, unseen percentage, and refresh urgency accurately', () => {
  const questions = [
    makeQuestion({ questionId: 'q1', questionFamilyId: 'f1', section: 'MATH', qcStatus: 'active' }),
    makeQuestion({ questionId: 'q2', questionFamilyId: 'f2', section: 'READ', qcStatus: 'active' }),
    makeQuestion({ questionId: 'q3', questionFamilyId: 'f3', section: 'THINK', qcStatus: 'quarantined' }),
    makeQuestion({ questionId: 'q4', questionFamilyId: 'f4', section: 'MATH', qcStatus: 'retired' }),
    makeQuestion({
      questionId: 'q5',
      questionFamilyId: 'f5',
      section: 'MATH',
      qcStatus: 'active',
      poolType: 'benchmark_holdout',
    }),
  ];

  const evidenceMap: Record<string, QuestionMasteryEvidence> = {
    f2__rev1: {
      evidenceKey: 'f2__rev1',
      questionFamilyId: 'f2',
      questionId: 'q2',
      evidenceRevision: 'rev1',
      section: 'READ',
      status: 'retained',
      cleanPassesCount: 3,
      passTimestampsIso: [],
      everCleanPassed: true,
      firstSubmissionCleanPass: true,
      attemptsCount: 3,
      resetCount: 0,
      lastAllCorrect: true,
      policyVersion: 'v3',
      updatedAtIso: '2026-01-10T00:00:00Z',
    },
  };

  const health = computePoolHealth({
    questions,
    evidenceMap,
    questionMemory: {},
    dailyQuestionTarget: 10,
  });

  assert.equal(health.liveCount, 2);
  assert.equal(health.pausedCount, 1);
  assert.equal(health.archivedCount, 1);
  assert.equal(health.holdoutCount, 1);
  assert.equal(health.unseenLiveCount, 1);
  assert.equal(health.doneLiveCount, 1);
  assert.equal(health.unseenLivePercent, 50);
  assert.equal(health.refreshUrgency, 'refresh_needed');
});
