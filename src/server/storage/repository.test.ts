import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BankImportManifest } from '../../shared/contracts';
import { validateAndDryRunManifest } from '../manifestValidator';
import { MemoryRepository } from './memoryRepository';
import { sha256Json } from './repositoryUtils';

test('MemoryRepository seeds golden-smoke-pack and preserves attempts across version-bumped imports', async () => {
  const raw = await fs.readFile(path.join(process.cwd(), 'seed', 'golden-smoke-pack.json'), 'utf8');
  const smoke = JSON.parse(raw) as BankImportManifest;

  const repo = new MemoryRepository();
  await repo.initAndSeedIfEmpty(smoke);

  const questions = await repo.listQuestions();
  assert.equal(questions.length, smoke.questions.length);

  await repo.appendPartAttempts([
    {
      attemptId: 'att_1',
      sessionId: 'sess_1',
      questionId: 'q_math_0001_v1',
      questionFamilyId: 'q_math_0001',
      partId: 'q_math_0001_v1_p1',
      skillId: 'MATH.GEO2D.COMPOSITE_AREA',
      difficultyAtAttempt: 3.2,
      selectedAnswer: 'D',
      isCorrect: true,
      timeSpentSec: 45,
      isSpacedReview: false,
      createdAt: '2026-11-14T12:00:00Z',
    },
  ]);

  const modifiedManifest: BankImportManifest = structuredClone(smoke);
  const mathQ = modifiedManifest.questions.find((q) => q.questionId === 'q_math_0001_v1')!;
  mathQ.parts[0].workedExplanation = 'Updated explanation v2';

  const existing = await repo.listQuestions();
  const { report } = validateAndDryRunManifest(modifiedManifest, existing);
  assert.equal(report.valid, true);
  assert.equal(report.versionBumpedQuestions, 1);

  const res = await repo.importManifest(modifiedManifest);
  assert.equal(res.versionBumped, 1);

  const attempts = await repo.listPartAttempts();
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].attemptId, 'att_1');
});

test('MemoryRepository.hydrateSyncData restores cross-device sessions, attempts, configs, and custom questions idempotently', async () => {
  const raw = await fs.readFile(path.join(process.cwd(), 'seed', 'golden-smoke-pack.json'), 'utf8');
  const smoke = JSON.parse(raw) as BankImportManifest;

  const repo = new MemoryRepository();
  await repo.initAndSeedIfEmpty(smoke);

  const customQ = structuredClone(smoke.questions[0]);
  customQ.questionId = 'q_custom_sync_v1';
  customQ.questionFamilyId = 'q_custom_sync';

  const activeCfg = await repo.getActiveConfig();
  const nextCfg = structuredClone(activeCfg.config);
  nextCfg.sessionDefaults.sectionDrillQuestionCount = 12;

  await repo.hydrateSyncData('uid_alice', {
    questions: [customQ],
    questionOverrides: [{ questionId: smoke.questions[0].questionId, qcStatus: 'quarantined' }],
    configVersions: [
      {
        configVersionId: 'cfg_v9_sync',
        versionNumber: 9,
        notes: 'Synced config',
        createdAt: '2026-11-14T12:00:00Z',
        config: nextCfg,
      },
    ],
    sessions: [
      {
        sessionId: 'sess_sync_1',
        studentId: 'uid_alice',
        configVersionId: 'cfg_v9_sync',
        mode: 'section_drill',
        sectionFilter: 'MATH',
        status: 'in_progress',
        plannedQuestionIds: [customQ.questionId],
        checkpoint: {
          currentIndex: 0,
          elapsedSec: 42,
          answersByPartId: { [customQ.parts[0].partId]: 'B' },
          flaggedQuestionIds: [],
        },
        totalSlots: 1,
        correctSlots: 0,
        startedAt: '2026-11-14T12:00:00Z',
      },
    ],
    attempts: [
      {
        attemptId: 'att_sync_1',
        studentId: 'uid_alice',
        sessionId: 'sess_prev',
        questionId: smoke.questions[0].questionId,
        questionFamilyId: smoke.questions[0].questionFamilyId,
        partId: smoke.questions[0].parts[0].partId,
        skillId: smoke.questions[0].parts[0].skillId,
        difficultyAtAttempt: 3,
        selectedAnswer: 'A',
        isCorrect: true,
        timeSpentSec: 30,
        isSpacedReview: false,
        createdAt: '2026-11-14T11:00:00Z',
      },
    ],
    skillStates: [
      {
        skillId: 'MATH.GEO2D.COMPOSITE_AREA',
        masteryScore: 0.78,
        uncertainty: 0.25,
        attemptsCount: 4,
        correctCount: 3,
        ewmaAccuracy: 0.75,
        avgTimeRatio: 0.9,
        reviewIntervalDays: 3,
        easeFactor: 2.6,
        plateauStatus: 'none',
      },
    ],
  });

  // Calling hydrateSyncData again must remain idempotent
  await repo.hydrateSyncData('uid_alice', {
    attempts: [
      {
        attemptId: 'att_sync_1',
        studentId: 'uid_alice',
        sessionId: 'sess_prev',
        questionId: smoke.questions[0].questionId,
        questionFamilyId: smoke.questions[0].questionFamilyId,
        partId: smoke.questions[0].parts[0].partId,
        skillId: smoke.questions[0].parts[0].skillId,
        difficultyAtAttempt: 3,
        selectedAnswer: 'A',
        isCorrect: true,
        timeSpentSec: 30,
        isSpacedReview: false,
        createdAt: '2026-11-14T11:00:00Z',
      },
    ],
  });

  const cfgNow = await repo.getActiveConfig();
  assert.equal(cfgNow.versionNumber, 9);
  assert.equal(cfgNow.config.sessionDefaults.sectionDrillQuestionCount, 12);

  const aliceSessions = await repo.listSessions(20, 'uid_alice');
  assert.equal(aliceSessions.length, 1);
  assert.equal(aliceSessions[0].checkpoint?.elapsedSec, 42);

  const bobSessions = await repo.listSessions(20, 'uid_bob');
  assert.equal(bobSessions.length, 0);

  const aliceAttempts = await repo.listPartAttempts(20, 'uid_alice');
  assert.equal(aliceAttempts.length, 1);

  const aliceSkills = await repo.getSkillStates('uid_alice');
  assert.equal(aliceSkills['MATH.GEO2D.COMPOSITE_AREA']?.correctCount, 3);

  const allQs = await repo.listQuestions();
  assert.ok(allQs.some((q) => q.questionId === 'q_custom_sync_v1'));
  assert.equal(allQs.find((q) => q.questionId === smoke.questions[0].questionId)?.qcStatus, 'quarantined');
});

test('MemoryRepository backup/restore includes plan-only learners and stays compatible with legacy bundles without dailyFocusPlans', async () => {
  const repo = new MemoryRepository();
  const plan = {
    planDate: '2026-11-21',
    studentId: 'plan_only_mem_student',
    generatedAtIso: '2026-11-21T07:00:00.000Z',
    source: 'deterministic' as const,
    focusSkillIds: ['MATH.NUM.FRACTIONS_RATIOS'],
    skillWeights: { 'MATH.NUM.FRACTIONS_RATIOS': 1.2 },
    dailyQuestionLimitBySection: { READ: 2, MATH: 4, THINK: 3, WRIT: 0 },
    dailyGoalMinutes: 20,
    autoCalibrated: true,
    rationale: 'Memory repo plan-only learner.',
  };
  await repo.saveDailyFocusPlan('plan_only_mem_student', plan);

  const backup = await repo.exportFullBackup();
  assert.equal(backup.counts.dailyFocusPlans, 1);
  assert.equal(backup.users.length, 1);
  assert.equal(backup.users[0].uid, 'plan_only_mem_student');
  assert.deepEqual(backup.users[0].dailyFocusPlans, [plan]);

  const target = new MemoryRepository();
  const dry = await target.restoreFullBackup(backup, { dryRun: true });
  assert.equal(dry.valid, true);
  assert.equal(dry.wouldCreate.dailyFocusPlans, 1);
  assert.equal(await target.getDailyFocusPlan('plan_only_mem_student', '2026-11-21'), null);

  const applied = await target.restoreFullBackup(backup, { dryRun: false });
  assert.equal(applied.valid, true);
  assert.equal(applied.applied.dailyFocusPlans, 1);
  assert.deepEqual(await target.getDailyFocusPlan('plan_only_mem_student', '2026-11-21'), plan);

  const replay = await target.restoreFullBackup(backup, { dryRun: false });
  assert.equal(replay.applied.dailyFocusPlans, 0);

  // Older bundle without dailyFocusPlans
  const legacyUsers = backup.users.map(({ dailyFocusPlans: _omitted, ...rest }) => rest);
  const { dailyFocusPlans: _omittedCount, ...legacyCounts } = backup.counts;
  const legacyChecksums = { ...backup.checksums, users: sha256Json(legacyUsers) };
  const legacyBundle = {
    ...backup,
    counts: legacyCounts,
    checksums: legacyChecksums,
    bundleSha256: sha256Json({ schemaVersion: backup.schemaVersion, counts: legacyCounts, checksums: legacyChecksums }),
    users: legacyUsers,
  };
  const legacyTarget = new MemoryRepository();
  const legacyApplied = await legacyTarget.restoreFullBackup(legacyBundle, { dryRun: false });
  assert.equal(legacyApplied.valid, true);
  assert.equal(legacyApplied.checksumVerified, true);
  assert.equal(legacyApplied.applied.dailyFocusPlans, 0);
});
