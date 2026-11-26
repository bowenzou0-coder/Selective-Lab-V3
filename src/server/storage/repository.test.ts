import test from 'node:test';
import assert from 'node:assert/strict';
import type { BankImportManifest, BenchmarkReportRecord, LearnerPreferences } from '../../shared/contracts';
import { V3_STARTER_MANIFEST_EXAMPLE } from '../../shared/v3Schema';
import { validateAndDryRunManifest } from '../manifestValidator';
import { MemoryRepository } from './memoryRepository';
import { sha256Json } from './repositoryUtils';

test('MemoryRepository seeds starter manifest and preserves attempts across version-bumped imports', async () => {
  const starter = structuredClone(V3_STARTER_MANIFEST_EXAMPLE) as unknown as BankImportManifest;

  const repo = new MemoryRepository();
  await repo.initAndSeedIfEmpty(starter);

  const questions = await repo.listQuestions();
  assert.equal(questions.length, starter.questions.length);

  const mathSample = starter.questions.find((q) => q.section === 'MATH')!;
  await repo.appendPartAttempts([
    {
      attemptId: 'att_1',
      sessionId: 'sess_1',
      questionId: mathSample.questionId,
      questionFamilyId: mathSample.questionFamilyId,
      partId: mathSample.parts[0].partId,
      skillId: mathSample.parts[0].skillId,
      difficultyAtAttempt: 3.2,
      selectedAnswer: 'B',
      isCorrect: true,
      timeSpentSec: 45,
      isSpacedReview: false,
      createdAt: '2026-11-14T12:00:00Z',
    },
  ]);

  const modifiedManifest: BankImportManifest = structuredClone(starter);
  const mathQ = modifiedManifest.questions.find((q) => q.questionId === mathSample.questionId)!;
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
  const starter = structuredClone(V3_STARTER_MANIFEST_EXAMPLE) as unknown as BankImportManifest;

  const repo = new MemoryRepository();
  await repo.initAndSeedIfEmpty(starter);

  const customQ = structuredClone(starter.questions[0]);
  customQ.questionId = 'q_custom_sync_v1';
  customQ.questionFamilyId = 'q_custom_sync';

  const activeCfg = await repo.getActiveConfig();
  const nextCfg = structuredClone(activeCfg.config);
  nextCfg.sessionDefaults.sectionDrillQuestionCount = 12;

  await repo.hydrateSyncData('uid_alice', {
    questions: [customQ],
    questionOverrides: [{ questionId: starter.questions[0].questionId, qcStatus: 'quarantined' }],
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
        questionId: starter.questions[0].questionId,
        questionFamilyId: starter.questions[0].questionFamilyId,
        partId: starter.questions[0].parts[0].partId,
        skillId: starter.questions[0].parts[0].skillId,
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
        questionId: starter.questions[0].questionId,
        questionFamilyId: starter.questions[0].questionFamilyId,
        partId: starter.questions[0].parts[0].partId,
        skillId: starter.questions[0].parts[0].skillId,
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
  assert.equal(allQs.find((q) => q.questionId === starter.questions[0].questionId)?.qcStatus, 'quarantined');
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

function benchmarkReportFixture(studentId: string, sessionId: string): BenchmarkReportRecord {
  const section = (code: 'READ' | 'MATH' | 'THINK' | 'WRIT') => ({
    section: code,
    correct: 20,
    total: 30,
    unanswered: 1,
    accuracyPct: 66.7,
    band: 'next_15' as const,
    estimatedPercentile: 78,
  });
  return {
    reportId: `bench_${sessionId}`,
    sessionId,
    studentId,
    batchLabel: '2026-11-20_b01',
    title: 'Official sample A',
    completedAtIso: '2026-11-22T09:30:00.000Z',
    elapsedSec: 7200,
    timeLimitSec: 9000,
    difficulty: 'official_sample',
    scaledScore120: 88,
    uncertaintyHalfWidth120: 6,
    estimatedPercentile: 81,
    estimatedStateRank: 2400,
    estimatedApplicantPool: 15000,
    writingStatus: 'pending',
    sections: { READ: section('READ'), MATH: section('MATH'), THINK: section('THINK'), WRIT: section('WRIT') },
    weakSkillStats: [{ skillId: 'MATH.NUM.FRACTIONS_RATIOS', section: 'MATH', missed: 3, total: 6, unanswered: 0 }],
  };
}

test('MemoryRepository backup/restore round-trips benchmark reports and learner preferences, and accepts bundles without them', async () => {
  const repo = new MemoryRepository();
  const report = benchmarkReportFixture('report_only_student', 'sess_bench_1');
  await repo.saveBenchmarkReport(report);
  const savedPrefs = await repo.saveLearnerPreferences('prefs_only_student', {
    dailyGoalMinutes: 35,
    dailyQuestionLimitBySection: { READ: 5, MATH: 6, THINK: 5, WRIT: 1 },
    adminOverrideLocked: true,
    updatedBy: 'admin',
  } satisfies LearnerPreferences);

  const backup = await repo.exportFullBackup();
  assert.equal(backup.counts.benchmarkReports, 1);
  assert.equal(backup.counts.learnerPreferences, 1);
  const reportUser = backup.users.find((u) => u.uid === 'report_only_student');
  const prefsUser = backup.users.find((u) => u.uid === 'prefs_only_student');
  assert.deepEqual(reportUser?.benchmarkReports, [report]);
  assert.equal(reportUser?.learnerPreferences, null);
  assert.deepEqual(prefsUser?.learnerPreferences, savedPrefs);
  assert.deepEqual(prefsUser?.benchmarkReports, []);

  const target = new MemoryRepository();
  const dry = await target.restoreFullBackup(backup, { dryRun: true });
  assert.equal(dry.valid, true);
  assert.equal(dry.wouldCreate.benchmarkReports, 1);
  assert.equal(dry.wouldCreate.learnerPreferences, 1);
  assert.equal(await target.getBenchmarkReport('sess_bench_1'), null);
  assert.equal(await target.getLearnerPreferences('prefs_only_student'), null);

  const applied = await target.restoreFullBackup(backup, { dryRun: false });
  assert.equal(applied.applied.benchmarkReports, 1);
  assert.equal(applied.applied.learnerPreferences, 1);
  assert.deepEqual(await target.getBenchmarkReport('sess_bench_1', 'report_only_student'), report);
  // Preferences restore verbatim, including the original updatedAtIso stamp.
  assert.deepEqual(await target.getLearnerPreferences('prefs_only_student'), savedPrefs);

  const replay = await target.restoreFullBackup(backup, { dryRun: false });
  assert.equal(replay.applied.benchmarkReports, 0);
  assert.equal(replay.applied.learnerPreferences, 0);
  assert.equal(replay.wouldSkipExisting.benchmarkReports, 1);
  assert.equal(replay.wouldSkipExisting.learnerPreferences, 1);

  // Bundles exported before these sections existed still verify and restore.
  const legacyUsers = backup.users.map(({ benchmarkReports: _r, learnerPreferences: _p, ...rest }) => rest);
  const { benchmarkReports: _rc, learnerPreferences: _pc, ...legacyCounts } = backup.counts;
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
  assert.equal(legacyApplied.applied.benchmarkReports, 0);
  assert.equal(legacyApplied.applied.learnerPreferences, 0);

  // Malformed sections are rejected before any write.
  const badUsers = backup.users.map((u) => ({ ...u, benchmarkReports: 'oops' as unknown as BenchmarkReportRecord[] }));
  const bad = await new MemoryRepository().restoreFullBackup({ ...backup, users: badUsers }, { dryRun: false });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some((e) => e.includes('benchmarkReports')));
});

test('MemoryRepository.listSessionSummaries returns slim newest-first metadata without heavy payloads', async () => {
  const repo = new MemoryRepository();
  const base = {
    configVersionId: 'cfg_v1',
    plannedQuestionIds: ['q_1', 'q_2'],
    totalSlots: 2,
    correctSlots: 0,
  };
  await repo.createSession({
    ...base,
    sessionId: 'sess_old',
    studentId: 'stu_a',
    mode: 'section_drill',
    sectionFilter: 'MATH',
    status: 'submitted',
    startedAt: '2026-11-20T09:00:00.000Z',
    completedAt: '2026-11-20T09:10:00.000Z',
    correctSlots: 1,
    checkpoint: { currentIndex: 1, elapsedSec: 600, answersByPartId: { p1: 'A' }, flaggedQuestionIds: [] },
  });
  await repo.createSession({
    ...base,
    sessionId: 'sess_new',
    studentId: 'stu_a',
    mode: 'daily_adaptive',
    status: 'in_progress',
    startedAt: '2026-11-21T09:00:00.000Z',
  });
  await repo.createSession({
    ...base,
    sessionId: 'sess_sandbox',
    studentId: 'stu_a',
    mode: 'admin_calibration',
    isSandbox: true,
    status: 'in_progress',
    startedAt: '2026-11-22T09:00:00.000Z',
  });
  await repo.createSession({
    ...base,
    sessionId: 'sess_other',
    studentId: 'stu_b',
    mode: 'daily_adaptive',
    status: 'submitted',
    startedAt: '2026-11-23T09:00:00.000Z',
  });

  const rows = await repo.listSessionSummaries(10, 'stu_a', false);
  assert.deepEqual(rows.map((r) => r.sessionId), ['sess_new', 'sess_old']);
  assert.deepEqual(rows[1], {
    sessionId: 'sess_old',
    mode: 'section_drill',
    status: 'submitted',
    isSandbox: false,
    sectionFilter: 'MATH',
    startedAt: '2026-11-20T09:00:00.000Z',
    completedAt: '2026-11-20T09:10:00.000Z',
    correctSlots: 1,
    totalSlots: 2,
    elapsedSec: 600,
  });
  assert.equal(rows[0].elapsedSec, 0);
  for (const row of rows) {
    assert.equal('checkpoint' in row, false);
    assert.equal('plannedQuestionIds' in row, false);
    assert.equal('submissionSummary' in row, false);
  }

  const withSandbox = await repo.listSessionSummaries(10, 'stu_a', true);
  assert.deepEqual(withSandbox.map((r) => r.sessionId), ['sess_sandbox', 'sess_new', 'sess_old']);
  assert.equal((await repo.listSessionSummaries(1, 'stu_a', true)).length, 1);
});
