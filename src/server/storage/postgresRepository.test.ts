import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Client, Pool } from 'pg';
import {
  DEFAULT_LEARNING_CONFIG,
  type BankImportManifest,
  type DailyFocusPlan,
  type PartAttemptRecord,
  type QuestionFlagRecord,
  type QuestionMasteryEvidence,
  type QuestionMemoryState,
  type SessionRecord,
  type SkillState,
  type WritingEvaluationRecord,
} from '../../shared/contracts.ts';
import { V3_STARTER_MANIFEST_EXAMPLE } from '../../shared/v3Schema.ts';
import { prepareMediaUpload, readMediaBytesFromStorage } from '../mediaService.ts';
import { createRepository } from './index.ts';
import { MemoryRepository } from './memoryRepository.ts';
import { getPostgresPoolConfig, isPostgresConfigured } from './postgresConfig.ts';
import { PostgresRepository } from './postgresRepository.ts';
import { sha256Json, validateIncomingBackupBundle } from './repositoryUtils.ts';

test('Postgres selection supports DATABASE_URL and explicit isolated demo mode', async () => {
  const env = process.env;
  process.env = { NODE_ENV: 'production', USE_FIRESTORE_DB: 'true' };
  try {
    assert.throws(() => createRepository(), /No durable database is configured/);
    process.env.DATABASE_URL = 'postgres://127.0.0.1/fixture';
    assert.ok(createRepository() instanceof PostgresRepository);
    process.env.ALLOW_DEMO_MEMORY_DB = 'true';
    assert.throws(() => createRepository(), /forbidden in production/);
    process.env.NODE_ENV = 'development';
    assert.ok(createRepository() instanceof MemoryRepository);
  } finally {
    process.env = env;
    await global._nswSelectivePgPool?.end();
    global._nswSelectivePgPool = undefined;
  }
});

test('Postgres URLs enforce verified TLS remotely and allow local opt-out', () => {
  const legacy = { SQL_HOST: '/cloudsql/legacy', SQL_DB_NAME: 'lab', SQL_USER: 'sample', SQL_PASSWORD: 'sample' };
  assert.equal(isPostgresConfigured({ DATABASE_URL: '  ' }), false);
  assert.equal(isPostgresConfigured(legacy), true);
  assert.equal(getPostgresPoolConfig(legacy).host, legacy.SQL_HOST);
  assert.throws(() => getPostgresPoolConfig({ DATABASE_URL: 'https://example.test' }), /Invalid DATABASE_URL/);

  const remote = getPostgresPoolConfig({
    ...legacy,
    DATABASE_URL: 'postgresql://example.test:5432/lab',
    VERCEL: '1',
  });
  assert.equal(remote.ssl, true);
  assert.equal(remote.host, undefined);
  assert.equal(remote.max, 3);
  assert.equal(getPostgresPoolConfig({ DATABASE_URL: 'postgres://127.0.0.1/lab' }).ssl, false);
  assert.equal(getPostgresPoolConfig({ DATABASE_URL: 'postgres://[::1]/lab' }).ssl, false);
  assert.equal(getPostgresPoolConfig({ DATABASE_URL: 'postgres://example.test/lab?sslnegotiation=postgres' }).ssl, true);

  const disabled = new Client(getPostgresPoolConfig({ DATABASE_URL: 'postgres://localhost/lab?sslmode=disable' }));
  assert.equal(disabled.ssl, false);
  assert.throws(() => getPostgresPoolConfig({ DATABASE_URL: 'postgres://example.test/lab?sslmode=disable' }), /requires verified TLS/);
  assert.throws(() => getPostgresPoolConfig({ DATABASE_URL: 'postgres://127.example.test/lab?ssl=no-verify' }), /requires verified TLS/);
  const required = getPostgresPoolConfig({ DATABASE_URL: 'postgres://example.test/lab?sslmode=require&channel_binding=require' });
  assert.equal(new URL(required.connectionString!).searchParams.get('channel_binding'), 'require');
  assert.equal(new URL(required.connectionString!).searchParams.get('sslmode'), 'verify-full');
  const verified = new Client(required);
  assert.deepEqual(verified.ssl, {});
});

const localTestUrl = process.env.TEST_POSTGRES_URL;

test('Postgres concurrent initialization, manifest retries, rollback, and account isolation', {
  skip: !localTestUrl && 'Set TEST_POSTGRES_URL to a disposable local Postgres database',
}, async (t) => {
  const url = new URL(localTestUrl!);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !url.searchParams.has('host'),
    'TEST_POSTGRES_URL must point to a local database');
  const schema = `selective_test_${randomUUID().replaceAll('-', '')}`;
  const baseConfig = getPostgresPoolConfig({ DATABASE_URL: url.href });
  const adminPool = new Pool(baseConfig);
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ ...baseConfig, options: `-c search_path=${schema}` });
  const peerPool = new Pool({ ...baseConfig, options: `-c search_path=${schema}` });
  t.after(async () => {
    await Promise.all([pool.end(), peerPool.end()]);
    try {
      await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
    } finally {
      await adminPool.end();
    }
  });

  const repo = new PostgresRepository(pool);
  const peer = new PostgresRepository(peerPool);
  const manifest = structuredClone(V3_STARTER_MANIFEST_EXAMPLE);
  const dryRun = await repo.validateAndImportManifest(manifest, 'test', { dryRun: true });
  assert.equal(dryRun.report.newQuestions, manifest.questions.length);
  assert.equal(dryRun.result, null);
  assert.equal((await pool.query("SELECT to_regclass('questions') AS table_name")).rows[0].table_name, null);

  await Promise.all([repo.ensureSchema(), peer.ensureSchema()]);
  assert.equal((await repo.listConfigVersions()).length, 1);
  const configs = await Promise.all([repo.saveConfigVersion(DEFAULT_LEARNING_CONFIG), peer.saveConfigVersion(DEFAULT_LEARNING_CONFIG)]);
  assert.deepEqual(configs.map((saved) => saved.versionNumber).sort(), [2, 3]);

  const initial = await Promise.all([repo, peer].map(
    (db) => db.validateAndImportManifest(manifest, 'test', { dryRun: false })
  ));
  assert.deepEqual(initial.map((run) => run.result?.replayed).sort(), [false, true]);
  assert.equal(initial[0].result?.batch.batchId, initial[1].result?.batch.batchId);
  assert.equal((await repo.listImportBatches()).length, 1);

  const questionId = manifest.questions[0].questionId;
  const familyId = (await repo.getQuestionWithStimulus(questionId))!.question.questionFamilyId;
  const corrected = structuredClone(manifest);
  corrected.questions[0].parts[0].workedExplanation += ' Corrected explanation.';
  corrected.batchLabel = 'forced failure';
  await pool.query("ALTER TABLE import_batches ADD CHECK (batch_label <> 'forced failure')");
  const failed = await repo.validateAndImportManifest(corrected, 'test', { dryRun: true });
  assert.equal(failed.report.versionBumpedQuestions, 1);
  const original = await repo.getQuestionWithStimulus(questionId);
  corrected.stimuli[0].title = 'A changed title';
  await assert.rejects(repo.validateAndImportManifest(corrected, 'test', { dryRun: false }), { code: '23514' });
  assert.deepEqual(await repo.getQuestionWithStimulus(questionId), original);
  assert.equal((await repo.listQuestionVersions(familyId)).length, 1);
  assert.equal((await repo.listImportBatches()).length, 1);
  corrected.batchLabel = 'corrected batch';
  const updated = await repo.validateAndImportManifest(corrected, 'test', { dryRun: false });
  assert.equal(updated.result?.versionBumped, 1);
  const retry = await peer.validateAndImportManifest(
    Object.fromEntries(Object.entries(corrected).reverse()), 'retry', { dryRun: false }
  );
  assert.equal(retry.result?.replayed, true);
  assert.deepEqual(retry.result?.batch, updated.result?.batch);
  assert.equal((await repo.listQuestionVersions(familyId)).length, 2);

  const account = { uid: 'student-a', email: 'admin@example.test', isBootstrappedAdmin: true };
  assert.deepEqual(await repo.upsertUserFromAuth(account), { role: 'admin' });
  assert.deepEqual(await repo.upsertUserFromAuth({ ...account, isBootstrappedAdmin: false }), { role: 'student' });
  assert.equal(await peer.isUserAdmin(account.uid), false);

  const question = original!.question;
  const snapshots = [{ questionId, question, evidenceRevision: question.evidenceRevision!, snapshotIndex: 0 }];
  const session: SessionRecord = {
    sessionId: 'session-a',
    studentId: account.uid,
    configVersionId: 'cfg_v1',
    mode: 'section_drill',
    status: 'in_progress',
    plannedQuestionIds: [questionId],
    totalSlots: 1,
    correctSlots: 0,
    startedAt: '2026-01-01T00:00:00Z',
  };
  const reservations = await Promise.all([
    repo.reserveAndCreateSession(session, snapshots),
    peer.reserveAndCreateSession({ ...session, sessionId: 'session-b' }, snapshots),
  ]);
  assert.equal(reservations.filter((reservation) => reservation.created).length, 1);
  const [active] = await repo.listSessions(10, account.uid);
  assert.equal((await repo.getSessionSnapshots(account.uid, active.sessionId)).length, 1);
  assert.deepEqual(await repo.getSessionSnapshots('student-b', active.sessionId), []);

  await peer.createSession({ ...session, sessionId: 'session-other', studentId: 'student-b' }, snapshots);
  await repo.saveWritingSubmission({
    submissionId: 'writing-a', studentId: account.uid, sessionId: active.sessionId, questionId,
    planNotes: 'plan', responseText: 'response', wordCount: 1, timeSpentSec: 1,
    deterministicMetricsJson: '{}', submittedAt: session.startedAt,
  });
  const evaluation = {
    evaluationId: 'evaluation-a', submissionId: 'writing-a', evaluatorType: 'admin' as const,
    topicAdherencePass: true, overallBandEstimate: 'solid' as const,
    criteriaScores: [], topStrengths: [], priorityFixes: [], createdAt: session.startedAt,
  };
  await assert.rejects(repo.saveWritingEvaluation(evaluation, 'student-b'), /Writing submission not found/);
  await repo.saveWritingEvaluation(evaluation, account.uid);
  assert.equal((await repo.getProgressCounts(account.uid)).writingCount, 1);
  const reset = await repo.resetStudentProgress(account.uid);
  assert.equal(reset.clearedSessions, 1);
  assert.equal(reset.clearedWriting, 1);
  assert.equal(reset.preservedQuestionsCount, manifest.questions.length);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM writing_evaluations')).rows[0].count, 0);
  assert.deepEqual(await repo.getSessionSnapshots(account.uid, active.sessionId), []);
  assert.equal((await repo.getProgressCounts('student-b')).sessionsCount, 1);
  assert.ok(await repo.getQuestionWithStimulus(questionId));

  const reading = manifest.questions[0];
  const stimulus = manifest.stimuli[0];
  const quote = stimulus.mainTextMarkdown.slice(0, 10);
  const externalManifest = {
    ...manifest,
    batchLabel: 'external stimulus',
    stimuli: [],
    questions: [{
      ...reading,
      questionId: 'q_external_v1',
      questionFamilyId: 'q_external',
      parts: reading.parts.map((part, index) => ({
        ...part,
        partId: `q_external_p${index + 1}`,
        evidenceRefs: [{ targetKind: 'mainText', startOffset: 0, endOffset: quote.length, quote }],
      })),
    }],
  };
  const externalCommit = await repo.validateAndImportManifest(externalManifest, 'test', { dryRun: false });
  assert.equal(externalCommit.result?.imported, 1);
  const stimulusEdit = await repo.validateAndImportManifest({
    ...manifest,
    batchLabel: 'changed external stimulus',
    stimuli: [{ ...stimulus, version: 2, mainTextMarkdown: `New text. ${stimulus.mainTextMarkdown}` }],
    questions: [],
  }, 'test', { dryRun: false });
  assert.equal(stimulusEdit.report.valid, true);
  const invalidAgainstCurrentBank = await repo.validateAndImportManifest(
    { ...externalManifest, batchLabel: 'different request' }, 'test', { dryRun: true }
  );
  assert.equal(invalidAgainstCurrentBank.report.valid, false);
  const recoveredReceipt = await peer.validateAndImportManifest(externalManifest, 'retry', { dryRun: false });
  assert.equal(recoveredReceipt.replayed, true);
  assert.deepEqual(recoveredReceipt.result?.batch, externalCommit.result?.batch);
});

const BACKUP_TABLES = [
  'users',
  'stimuli',
  'questions',
  'import_batches',
  'admin_config_versions',
  'media_assets',
  'question_flags',
  'sessions',
  'session_snapshots',
  'part_attempts',
  'skill_states',
  'question_memory',
  'question_evidence',
  'writing_submissions',
  'writing_evaluations',
  'daily_focus_plans',
] as const;

async function snapshotTableCounts(pool: Pool): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of BACKUP_TABLES) {
    const { rows } = await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`);
    counts[table] = rows[0].count;
  }
  return counts;
}

test('Postgres canonical backup exports consistent snapshot including daily plans, restores atomically, and accepts legacy bundles', {
  skip: !localTestUrl && 'Set TEST_POSTGRES_URL to a disposable local Postgres database',
}, async (t) => {
  const url = new URL(localTestUrl!);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !url.searchParams.has('host'),
    'TEST_POSTGRES_URL must point to a local database');
  const baseConfig = getPostgresPoolConfig({ DATABASE_URL: url.href });
  const adminPool = new Pool(baseConfig);
  const schemas = [
    `selective_src_${randomUUID().replaceAll('-', '')}`,
    `selective_dst_${randomUUID().replaceAll('-', '')}`,
    `selective_legacy_${randomUUID().replaceAll('-', '')}`,
  ];
  for (const s of schemas) {
    await adminPool.query(`CREATE SCHEMA ${s}`);
  }
  const srcPool = new Pool({ ...baseConfig, options: `-c search_path=${schemas[0]}` });
  const srcPeerPool = new Pool({ ...baseConfig, options: `-c search_path=${schemas[0]}` });
  const dstPool = new Pool({ ...baseConfig, options: `-c search_path=${schemas[1]}` });
  const legacyPool = new Pool({ ...baseConfig, options: `-c search_path=${schemas[2]}` });
  t.after(async () => {
    await Promise.all([srcPool.end(), srcPeerPool.end(), dstPool.end(), legacyPool.end()]);
    try {
      for (const s of schemas) {
        await adminPool.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
      }
    } finally {
      await adminPool.end();
    }
  });

  const srcRepo = new PostgresRepository(srcPool);
  const srcPeer = new PostgresRepository(srcPeerPool);
  const dstRepo = new PostgresRepository(dstPool);
  const legacyRepo = new PostgresRepository(legacyPool);
  await Promise.all([srcRepo.ensureSchema(), dstRepo.ensureSchema(), legacyRepo.ensureSchema()]);

  // Populate ALL 16 tables in source schema
  const manifest = structuredClone(V3_STARTER_MANIFEST_EXAMPLE) as unknown as BankImportManifest;
  manifest.batchLabel = 'Backup Source Batch 1';
  const imported = await srcRepo.importManifest(manifest, 'cli_db_push');
  assert.equal(imported.imported, manifest.questions.length);

  const customCfg = structuredClone(DEFAULT_LEARNING_CONFIG);
  customCfg.sessionDefaults.dailyGoalMinutes = 35;
  await srcRepo.saveConfigVersion(customCfg, 'backup custom config v2');

  const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const mediaAsset = prepareMediaUpload({
    questionId: manifest.questions[0].questionId,
    filename: 'diagram.png',
    imageBase64: pngBytes.toString('base64'),
  });
  await srcRepo.saveMediaAsset(mediaAsset);

  const flag: QuestionFlagRecord = {
    flagId: 'flag_bk_1',
    questionId: manifest.questions[0].questionId,
    sessionId: 'sess_bk_1',
    studentId: 'learner_full',
    reason: 'clarity',
    notes: 'Check axis label',
    status: 'open',
    createdAt: '2026-11-20T09:00:00.000Z',
  };
  await srcRepo.saveQuestionFlag(flag);

  await srcRepo.upsertUserFromAuth({
    uid: 'learner_full',
    email: 'admin@example.test',
    displayName: 'Full Learner',
    isBootstrappedAdmin: true,
  });

  const q0 = (await srcRepo.getQuestionWithStimulus(manifest.questions[0].questionId))!;
  const session: SessionRecord = {
    sessionId: 'sess_bk_1',
    studentId: 'learner_full',
    configVersionId: 'cfg_v1',
    mode: 'daily_adaptive',
    status: 'submitted',
    plannedQuestionIds: [q0.question.questionId],
    checkpointRevision: 2,
    totalSlots: q0.question.parts.length,
    correctSlots: q0.question.parts.length,
    startedAt: '2026-11-20T08:00:00.000Z',
    completedAt: '2026-11-20T08:05:00.000Z',
  };
  const snapshots = [
    {
      questionId: q0.question.questionId,
      snapshotIndex: 0,
      evidenceRevision: q0.question.evidenceRevision!,
      question: q0.question,
      stimulus: q0.stimulus,
    },
  ];
  await srcRepo.createSession(session, snapshots);

  const attempt: PartAttemptRecord = {
    attemptId: 'att_bk_1',
    studentId: 'learner_full',
    sessionId: session.sessionId,
    questionId: q0.question.questionId,
    questionFamilyId: q0.question.questionFamilyId,
    partId: q0.question.parts[0].partId,
    skillId: q0.question.parts[0].skillId,
    difficultyAtAttempt: q0.question.parts[0].difficultyInitial,
    selectedAnswer: q0.question.parts[0].correctAnswerKey,
    isCorrect: true,
    timeSpentSec: 32,
    isSpacedReview: false,
    evidenceRevision: q0.question.evidenceRevision,
    createdAt: '2026-11-20T08:04:00.000Z',
  };
  await srcRepo.appendPartAttempts([attempt]);

  const skillState: SkillState = {
    skillId: q0.question.parts[0].skillId,
    masteryScore: 0.72,
    uncertainty: 0.28,
    attemptsCount: 2,
    correctCount: 2,
    ewmaAccuracy: 0.8,
    avgTimeRatio: 0.85,
    reviewIntervalDays: 3,
    easeFactor: 2.5,
    plateauStatus: 'none',
  };
  await srcRepo.upsertSkillStates([skillState], 'learner_full');

  const qMem: QuestionMemoryState = {
    questionFamilyId: q0.question.questionFamilyId,
    timesSeen: 1,
    lastAllCorrect: true,
    intervalDays: 1,
    easeFactor: 2.5,
    lapseCount: 0,
    nextDueAt: '2026-11-21T08:05:00.000Z',
    lastSeenAt: '2026-11-20T08:05:00.000Z',
  };
  await srcRepo.upsertQuestionMemory([qMem], 'learner_full');

  const qEv: QuestionMasteryEvidence = {
    evidenceKey: `${q0.question.questionFamilyId}__${q0.question.evidenceRevision}`,
    questionFamilyId: q0.question.questionFamilyId,
    questionId: q0.question.questionId,
    section: q0.question.section,
    evidenceRevision: q0.question.evidenceRevision!,
    status: 'correct_once',
    attemptsCount: 1,
    cleanPassesCount: 1,
    passTimestampsIso: ['2026-11-20T08:05:00.000Z'],
    everCleanPassed: true,
    firstSubmissionCleanPass: true,
    resetCount: 0,
    lastAttemptAtIso: '2026-11-20T08:05:00.000Z',
    lastAllCorrect: true,
    policyVersion: 'v3_3stage_24h_7d',
    updatedAtIso: '2026-11-20T08:05:00.000Z',
  };
  await srcRepo.upsertQuestionEvidence([qEv], 'learner_full');

  await srcRepo.saveWritingSubmission({
    submissionId: 'wsub_bk_1',
    studentId: 'learner_full',
    sessionId: session.sessionId,
    questionId: q0.question.questionId,
    planNotes: 'Intro, body, conclusion',
    responseText: 'A concise sample essay.',
    wordCount: 4,
    timeSpentSec: 120,
    deterministicMetricsJson: '{"wordCount":4}',
    submittedAt: '2026-11-20T08:05:00.000Z',
  });
  const wEval: WritingEvaluationRecord = {
    evaluationId: 'weval_bk_1',
    submissionId: 'wsub_bk_1',
    evaluatorType: 'ai',
    modelId: 'gemini-test',
    topicAdherencePass: true,
    overallBandEstimate: 'strong',
    criteriaScores: [{ criterionSkillId: 'WRIT.IDEAS', band: 'B', score: 4, maxMarks: 5, comment: 'Clear thesis' }],
    topStrengths: ['Clear structure'],
    priorityFixes: ['Expand examples'],
    createdAt: '2026-11-20T08:06:00.000Z',
  };
  await srcRepo.saveWritingEvaluation(wEval, 'learner_full');

  const fullPlan: DailyFocusPlan = {
    planDate: '2026-11-20',
    studentId: 'learner_full',
    generatedAtIso: '2026-11-20T07:00:00.000Z',
    source: 'deterministic',
    focusSkillIds: [q0.question.parts[0].skillId],
    skillWeights: { [q0.question.parts[0].skillId]: 1.25 },
    dailyQuestionLimitBySection: { READ: 3, MATH: 4, THINK: 3, WRIT: 0 },
    dailyGoalMinutes: 25,
    autoCalibrated: true,
    rationale: 'Balanced daily plan.',
  };
  await srcRepo.saveDailyFocusPlan('learner_full', fullPlan);

  // Learner who ONLY has a daily_focus_plans row (no users/sessions/attempts rows!)
  const planOnlyPlan: DailyFocusPlan = {
    planDate: '2026-11-21',
    studentId: 'learner_plan_only',
    generatedAtIso: '2026-11-21T07:00:00.000Z',
    source: 'deterministic',
    focusSkillIds: ['MATH.NUM.FRACTIONS_RATIOS'],
    skillWeights: { 'MATH.NUM.FRACTIONS_RATIOS': 1.3 },
    dailyQuestionLimitBySection: { READ: 2, MATH: 5, THINK: 3, WRIT: 0 },
    dailyGoalMinutes: 25,
    autoCalibrated: true,
    rationale: 'Plan-only learner.',
  };
  await srcRepo.saveDailyFocusPlan('learner_plan_only', planOnlyPlan);

  // Learner who ONLY has a question_evidence row
  await srcRepo.upsertQuestionEvidence([{ ...qEv, evidenceKey: 'fam_only__rev1', questionFamilyId: 'fam_only' }], 'learner_ev_only');

  // Export while bank is concurrently in use (concurrent import + concurrent session/plan write)
  const concurrentManifest = structuredClone(V3_STARTER_MANIFEST_EXAMPLE) as unknown as BankImportManifest;
  concurrentManifest.batchLabel = 'Concurrent Write Batch';
  concurrentManifest.stimuli = [];
  concurrentManifest.questions = [
    {
      ...concurrentManifest.questions[1],
      questionId: 'q_concurrent_bk_v1',
      questionFamilyId: 'q_concurrent_bk',
      parts: concurrentManifest.questions[1].parts.map((p, idx) => ({ ...p, partId: `q_concurrent_bk_p${idx + 1}` })),
    },
  ];
  const [liveExport] = await Promise.all([
    srcRepo.exportFullBackup(),
    srcPeer.importManifest(concurrentManifest, 'concurrent_writer'),
    srcPeer.saveDailyFocusPlan('learner_concurrent', {
      ...planOnlyPlan,
      studentId: 'learner_concurrent',
      planDate: '2026-11-22',
    }),
  ]);
  const liveValidated = validateIncomingBackupBundle(liveExport);
  assert.equal(liveValidated.valid, true);
  // Consistency check: concurrent import question and receipt appear together or neither appears
  const hasConcurrentQ = liveExport.questions.some((q) => q.questionId === 'q_concurrent_bk_v1');
  const hasConcurrentBatch = liveExport.importBatches.some((b) => b.batchLabel === 'Concurrent Write Batch');
  assert.equal(hasConcurrentQ, hasConcurrentBatch);

  // Clean export after concurrent writes settled
  const backup = await srcRepo.exportFullBackup();
  assert.equal(backup.counts.dailyFocusPlans, 3);
  assert.ok(backup.users.some((u) => u.uid === 'learner_plan_only' && u.dailyFocusPlans?.length === 1));
  assert.ok(backup.users.some((u) => u.uid === 'learner_ev_only' && u.questionEvidence.length === 1));

  // Finding 3: Force a late insert failure on daily_focus_plans (the final table in restore) and prove ZERO partial rows remain
  const beforeCounts = await snapshotTableCounts(dstPool);
  await dstPool.query("ALTER TABLE daily_focus_plans ADD CONSTRAINT fail_late_restore CHECK (plan_date <> '2026-11-21')");
  await assert.rejects(dstRepo.restoreFullBackup(backup, { dryRun: false }), { code: '23514' });
  assert.deepEqual(await snapshotTableCounts(dstPool), beforeCounts);

  // Drop failure constraint, then verify dry-run, full restore, field-by-field parity, and replay
  await dstPool.query('ALTER TABLE daily_focus_plans DROP CONSTRAINT fail_late_restore');

  const dry = await dstRepo.restoreFullBackup(backup, { dryRun: true });
  assert.equal(dry.valid, true);
  assert.equal(dry.checksumVerified, true);
  assert.equal(dry.wouldCreate.questions, backup.questions.length);
  assert.equal(dry.wouldCreate.importBatches, backup.importBatches.length);
  assert.equal(dry.wouldCreate.mediaAssets, 1);
  assert.equal(dry.wouldCreate.dailyFocusPlans, 3);
  assert.deepEqual(await snapshotTableCounts(dstPool), beforeCounts);

  const restored = await dstRepo.restoreFullBackup(backup, { dryRun: false });
  assert.equal(restored.valid, true);
  assert.equal(restored.applied.questions, backup.questions.length);
  assert.equal(restored.applied.importBatches, backup.importBatches.length);
  assert.equal(restored.applied.mediaAssets, 1);
  assert.equal(restored.applied.dailyFocusPlans, 3);

  // Compare ALL 16 tables and fields between source and destination
  const dstExport = await dstRepo.exportFullBackup();
  assert.deepEqual(dstExport.stimuli, backup.stimuli);
  assert.deepEqual(dstExport.questions, backup.questions);
  assert.deepEqual(dstExport.importBatches, backup.importBatches);
  assert.deepEqual(dstExport.mediaAssets, backup.mediaAssets);
  assert.deepEqual(dstExport.questionFlags, backup.questionFlags);
  assert.equal(dstExport.configVersions.length, backup.configVersions.length);
  for (let i = 0; i < backup.configVersions.length; i++) {
    assert.equal(dstExport.configVersions[i].configVersionId, backup.configVersions[i].configVersionId);
    assert.equal(dstExport.configVersions[i].versionNumber, backup.configVersions[i].versionNumber);
    assert.equal(dstExport.configVersions[i].notes, backup.configVersions[i].notes);
    assert.deepEqual(dstExport.configVersions[i].config, backup.configVersions[i].config);
    if (backup.configVersions[i].configVersionId !== 'cfg_v1') {
      assert.equal(dstExport.configVersions[i].createdAt, backup.configVersions[i].createdAt);
    }
  }
  // Security invariant: restore never elevates role to admin, while all other learner fields match exactly
  assert.deepEqual(
    dstExport.users,
    backup.users.map((u) => ({ ...u, role: 'student' as const }))
  );
  // Verify media bytes survive backup/restore byte-for-byte
  const restoredAsset = await dstRepo.getMediaAsset(mediaAsset.assetId);
  assert.ok(restoredAsset);
  const restoredBytes = await readMediaBytesFromStorage(restoredAsset, '');
  assert.deepEqual(restoredBytes, pngBytes);
  // Verify plan-only learner restored cleanly
  assert.deepEqual(await dstRepo.getDailyFocusPlan('learner_plan_only', '2026-11-21'), planOnlyPlan);

  // Replay must be a clean no-op
  const countsAfterRestore = await snapshotTableCounts(dstPool);
  const replay = await dstRepo.restoreFullBackup(backup, { dryRun: false });
  assert.equal(replay.valid, true);
  for (const val of Object.values(replay.wouldCreate)) assert.equal(val, 0);
  for (const val of Object.values(replay.applied)) assert.equal(val, 0);
  assert.deepEqual(await snapshotTableCounts(dstPool), countsAfterRestore);

  // Backwards compatibility: older canonical bundle without dailyFocusPlans in users or counts
  const legacyUsers = backup.users.map(({ dailyFocusPlans: _omitted, ...rest }) => rest);
  const { dailyFocusPlans: _omittedCount, ...legacyCounts } = backup.counts;
  const legacyChecksums = {
    ...backup.checksums,
    users: sha256Json(legacyUsers),
  };
  const legacyBundle = {
    ...backup,
    counts: legacyCounts,
    checksums: legacyChecksums,
    bundleSha256: sha256Json({
      schemaVersion: backup.schemaVersion,
      counts: legacyCounts,
      checksums: legacyChecksums,
    }),
    users: legacyUsers,
  };
  const legacyDry = await legacyRepo.restoreFullBackup(legacyBundle, { dryRun: true });
  assert.equal(legacyDry.valid, true);
  assert.equal(legacyDry.checksumVerified, true);
  assert.equal(legacyDry.wouldCreate.dailyFocusPlans, 0);
  const legacyApplied = await legacyRepo.restoreFullBackup(legacyBundle, { dryRun: false });
  assert.equal(legacyApplied.valid, true);
  assert.equal(legacyApplied.applied.questions, backup.questions.length);
  assert.equal(legacyApplied.applied.sessions, 1);
  assert.equal(legacyApplied.applied.dailyFocusPlans, 0);
  assert.equal(await legacyRepo.getDailyFocusPlan('learner_full', '2026-11-20'), null);
});

test('Postgres bank cache revalidates on out-of-band writes and slim queries match full reads', {
  skip: !localTestUrl && 'Set TEST_POSTGRES_URL to a disposable local Postgres database',
}, async (t) => {
  const url = new URL(localTestUrl!);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !url.searchParams.has('host'),
    'TEST_POSTGRES_URL must point to a local database');
  const schema = `selective_cache_${randomUUID().replaceAll('-', '')}`;
  const baseConfig = getPostgresPoolConfig({ DATABASE_URL: url.href });
  const adminPool = new Pool(baseConfig);
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ ...baseConfig, options: `-c search_path=${schema}` });
  const writerPool = new Pool({ ...baseConfig, options: `-c search_path=${schema}` });
  t.after(async () => {
    await Promise.all([pool.end(), writerPool.end()]);
    try {
      await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
    } finally {
      await adminPool.end();
    }
  });

  const repo = new PostgresRepository(pool);
  const manifest = structuredClone(V3_STARTER_MANIFEST_EXAMPLE) as unknown as BankImportManifest;
  await repo.importManifest(manifest, 'test');
  const indexes = await pool.query<{ indexname: string }>(
    'SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()'
  );
  for (const name of ['questions_status_pool_section_idx', 'question_flags_status_idx', 'sessions_student_status_idx']) {
    assert.ok(indexes.rows.some((r) => r.indexname === name), `missing index ${name}`);
  }

  const full = await repo.listQuestions();
  assert.ok(full.length > 0 && Object.isFrozen(full[0]), 'cached bank rows are frozen');
  const meta = await repo.listQuestionMeta();
  assert.deepEqual(meta.map((q) => q.questionId).sort(), full.map((q) => q.questionId).sort());

  // A cold repository (no bank in memory) answers from the SQL projection with identical rows.
  const coldPool = new Pool({ ...baseConfig, options: `-c search_path=${schema}` });
  t.after(() => coldPool.end());
  const coldMeta = await new PostgresRepository(coldPool).listQuestionMeta();
  const byId = (rows: typeof meta) => Object.fromEntries(rows.map((r) => [r.questionId, r]));
  assert.deepEqual(byId(coldMeta), byId(meta));

  // Another process (e.g. `npm run db:push`) changes a row: the fingerprint must catch it.
  const target = full[0];
  await writerPool.query(
    `UPDATE questions SET qc_status = 'retired', data = data || '{"qcStatus":"retired"}'::jsonb WHERE question_id = $1`,
    [target.questionId]
  );
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const refreshed = (await repo.listQuestions()).find((q) => q.questionId === target.questionId);
  assert.equal(refreshed?.qcStatus, 'retired');
  assert.equal((await repo.getQuestionWithStimulus(target.questionId))?.question.qcStatus, 'retired');

  // Local writes invalidate immediately (no revalidation window).
  await repo.updateQuestionStatus(target.questionId, 'active');
  assert.equal((await repo.listQuestions()).find((q) => q.questionId === target.questionId)?.qcStatus, 'active');

  // Session/activity aggregates.
  const studentId = 'cache_student';
  const nowIso = new Date().toISOString();
  const baseSession = {
    studentId, mode: 'daily_adaptive', title: 'T', isSandbox: false, configVersionId: 'cfg_v1',
    checkpointRevision: 1, totalSlots: 1, correctSlots: 0, startedAt: nowIso,
  } as const;
  await repo.createSession({ ...baseSession, sessionId: 's_live', status: 'in_progress', plannedQuestionIds: [target.questionId] });
  await repo.createSession({
    ...baseSession, sessionId: 's_done', status: 'submitted', completedAt: nowIso, plannedQuestionIds: [target.questionId],
    submissionSummary: { ok: true, correctSlots: 0, totalSlots: 1, completedAt: nowIso } as SessionRecord['submissionSummary'],
  });
  assert.deepEqual((await repo.listActiveSessions(studentId)).map((s) => s.sessionId), ['s_live']);
  const lean = await repo.listSessions(10, studentId, false, { omitSubmissionSummary: true });
  assert.ok(lean.length === 2 && lean.every((s) => s.submissionSummary === undefined));
  assert.ok((await repo.listSessions(10, studentId, false)).some((s) => s.submissionSummary));
  const activity = await repo.getLearnerActivity([studentId, 'nobody']);
  assert.deepEqual(activity[studentId].sessionsCount, 2);
  assert.equal(activity.nobody.sessionsCount, 0);
  assert.equal(await repo.countHoldoutLeaks([target.questionId]), 2);
  assert.equal(await repo.countHoldoutLeaks([]), 0);
});

test('Postgres SQL-first pagination, search, status aggregates, progress stats, and bulk status match MemoryRepository', {
  skip: !localTestUrl && 'Set TEST_POSTGRES_URL to a disposable local Postgres database',
}, async (t) => {
  const url = new URL(localTestUrl!);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !url.searchParams.has('host'),
    'TEST_POSTGRES_URL must point to a local database');
  const schema = `selective_sql_parity_${randomUUID().replaceAll('-', '')}`;
  const baseConfig = getPostgresPoolConfig({ DATABASE_URL: url.href });
  const adminPool = new Pool(baseConfig);
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ ...baseConfig, options: `-c search_path=${schema}` });
  t.after(async () => {
    await pool.end();
    try {
      await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
    } finally {
      await adminPool.end();
    }
  });

  const pgRepo = new PostgresRepository(pool);
  const memRepo = new MemoryRepository();
  const baseManifest = structuredClone(V3_STARTER_MANIFEST_EXAMPLE) as unknown as BankImportManifest;
  const mathTemplate = structuredClone(baseManifest.questions.find((q) => q.section === 'MATH')!);

  const parityManifest: BankImportManifest = {
    ...baseManifest,
    batchLabel: 'Parity Batch Alpha',
    stimuli: [
      ...baseManifest.stimuli,
      {
        stimulusId: 'stim_visual_1',
        stimulusFamilyId: 'stim_visual_1',
        version: 1,
        section: 'READ',
        genreOrTextType: 'passage',
        title: 'Solar Harbour Observatory',
        mainTextMarkdown: 'Tidal gauges track harbour currents.',
        visual: { visualType: 'inline_svg', altText: 'Tide chart', svgMarkup: '<svg viewBox="0 0 10 10"/>' },
        sourceType: 'ai_generated',
      },
    ],
    questions: [
      ...baseManifest.questions,
      {
        ...mathTemplate,
        questionId: 'q_nat_2_v1',
        questionFamilyId: 'q_nat_2',
        qcStatus: 'active',
        poolType: 'practice',
        visual: undefined,
        parts: [
          {
            ...mathTemplate.parts[0],
            partId: 'q_nat_2_p1',
            promptText: 'Calculate the perimeter of a 3 cm square.',
            skillId: 'MATH.NUM.NUMBER_SEQUENCES',
            secondarySkillIds: ['MATH.GEO2D.COMPOSITE_AREA'],
            workedExplanation: 'Multiply side length by 4.',
          },
        ],
      },
      {
        ...mathTemplate,
        questionId: 'q_nat_10_v1',
        questionFamilyId: 'q_nat_10',
        qcStatus: 'quarantined',
        poolType: 'practice',
        visual: undefined,
        parts: [
          {
            ...mathTemplate.parts[0],
            partId: 'q_nat_10_p1',
            promptText: 'Missing explanation item ten.',
            skillId: 'MATH.NUM.NUMBER_SEQUENCES',
            workedExplanation: '',
          },
        ],
      },
      {
        ...mathTemplate,
        questionId: 'q_pt1_holdout_v1',
        questionFamilyId: 'q_pt1_holdout',
        qcStatus: 'active',
        poolType: 'benchmark_holdout',
        parts: [
          {
            ...mathTemplate.parts[0],
            partId: 'q_pt1_holdout_p1',
            promptText: 'Holdout PT1 item.',
            workedExplanation: 'Holdout explanation.',
          },
        ],
        provenance: { sourceType: 'official_doe', sourceReference: 'NSW DoE PT1 Q1', verifierAgreed: true, auditorReviewed: true },
      },
      {
        ...baseManifest.questions[0],
        questionId: 'q_read_vis_v1',
        questionFamilyId: 'q_read_vis',
        section: 'READ',
        formatType: 'READ_FICTION_MCQ',
        stimulusId: 'stim_visual_1',
        sharedPoolConfig: undefined,
        parts: [
          {
            ...baseManifest.questions[0].parts[0],
            partId: 'q_read_vis_p1',
            promptText: 'What do the tidal gauges measure?',
            options: [{ key: 'A', text: 'Harbour currents' }, { key: 'B', text: 'Wind speed' }],
            correctAnswerKey: 'A',
            workedExplanation: 'Explicitly stated in the observatory passage.',
          },
        ],
      },
    ],
  };

  // Validate import directly (without passing full manifest into a pre-seeded table)
  await pgRepo.importManifest(parityManifest, 'test_seed');
  await memRepo.importManifest(parityManifest, 'test_seed');

  // Version bump q_nat_2 so includeHistorical vs latest behaves differently
  const bumpManifest: BankImportManifest = {
    manifestVersion: '1.0',
    batchLabel: 'Parity Batch Bump',
    defaultPoolType: 'practice',
    defaultQcStatus: 'active',
    stimuli: [],
    questions: [
      {
        ...parityManifest.questions.find((q) => q.questionId === 'q_nat_2_v1')!,
        parts: [
          {
            ...parityManifest.questions.find((q) => q.questionId === 'q_nat_2_v1')!.parts[0],
            workedExplanation: 'Side length 3 cm times 4 equals 12 cm.',
          },
        ],
      },
    ],
  };
  await pgRepo.validateAndImportManifest(bumpManifest, 'test_bump', { dryRun: false });
  await memRepo.importManifest(bumpManifest, 'test_bump');

  // Seed learner state: exact retained evidence, family-fallback needs_repair evidence, memory-only in_review, open flag, attempts, writing
  const studentId = 'parity_student';
  const latestNat2 = (await pgRepo.getQuestionWithStimulus('q_nat_2_v2'))!.question;
  const mathSvg = (await pgRepo.getQuestionWithStimulus('q_ai_math_svg_01_v1'))!.question;
  const readVis = (await pgRepo.getQuestionWithStimulus('q_read_vis_v1'))!.question;

  const evEntries: QuestionMasteryEvidence[] = [
    {
      evidenceKey: `${latestNat2.questionFamilyId}__${latestNat2.evidenceRevision}`,
      questionFamilyId: latestNat2.questionFamilyId,
      questionId: latestNat2.questionId,
      evidenceRevision: latestNat2.evidenceRevision!,
      section: 'MATH',
      status: 'retained',
      cleanPassesCount: 3,
      passTimestampsIso: ['2026-11-01T00:00:00Z', '2026-11-03T00:00:00Z', '2026-11-12T00:00:00Z'],
      everCleanPassed: true,
      firstSubmissionCleanPass: true,
      attemptsCount: 3,
      resetCount: 0,
      lastAttemptAtIso: '2026-11-12T00:00:00Z',
      lastAllCorrect: true,
      policyVersion: 'v3_3stage_24h_7d',
      updatedAtIso: '2026-11-12T00:00:00Z',
    },
    {
      // Intentionally mismatched older evidenceRevision to test family-fallback matching in bankStatus/SQL
      evidenceKey: `${mathSvg.questionFamilyId}__er_older_revision`,
      questionFamilyId: mathSvg.questionFamilyId,
      questionId: mathSvg.questionId,
      evidenceRevision: 'er_older_revision',
      section: 'MATH',
      status: 'needs_repair',
      cleanPassesCount: 0,
      passTimestampsIso: [],
      everCleanPassed: false,
      firstSubmissionCleanPass: false,
      attemptsCount: 1,
      resetCount: 1,
      lastAttemptAtIso: '2026-11-10T00:00:00Z',
      lastAllCorrect: false,
      policyVersion: 'v3_3stage_24h_7d',
      updatedAtIso: '2026-11-10T00:00:00Z',
    },
  ];
  await Promise.all([
    pgRepo.upsertQuestionEvidence(evEntries, studentId),
    memRepo.upsertQuestionEvidence(evEntries, studentId),
    pgRepo.upsertQuestionMemory([{
      questionFamilyId: readVis.questionFamilyId,
      timesSeen: 1,
      lastSeenAt: '2026-11-11T00:00:00Z',
      lastAllCorrect: true,
      intervalDays: 1,
      lapseCount: 0,
      nextDueAt: '2026-11-12T00:00:00Z',
    }], studentId),
    memRepo.upsertQuestionMemory([{
      questionFamilyId: readVis.questionFamilyId,
      timesSeen: 1,
      lastSeenAt: '2026-11-11T00:00:00Z',
      lastAllCorrect: true,
      intervalDays: 1,
      lapseCount: 0,
      nextDueAt: '2026-11-12T00:00:00Z',
    }], studentId),
    pgRepo.saveQuestionFlag({
      flagId: 'flg_parity_1',
      questionId: 'q_nat_2_v2',
      sessionId: 'sess_p1',
      studentId,
      reason: 'check',
      status: 'open',
      createdAt: '2026-11-22T01:00:00Z',
    }),
    memRepo.saveQuestionFlag({
      flagId: 'flg_parity_1',
      questionId: 'q_nat_2_v2',
      sessionId: 'sess_p1',
      studentId,
      reason: 'check',
      status: 'open',
      createdAt: '2026-11-22T01:00:00Z',
    }),
  ]);

  const todayIso = '2026-11-22T05:00:00.000Z';
  const attempts: PartAttemptRecord[] = [
    {
      attemptId: 'att_p1',
      studentId,
      sessionId: 'sess_p1',
      questionId: 'q_nat_2_v2',
      questionFamilyId: 'q_nat_2',
      partId: 'q_nat_2_p1',
      skillId: 'MATH.NUM.NUMBER_SEQUENCES',
      difficultyAtAttempt: 2.5,
      selectedAnswer: 'B',
      isCorrect: true,
      timeSpentSec: 30,
      isSpacedReview: false,
      createdAt: todayIso,
    },
    {
      attemptId: 'att_p2',
      studentId,
      sessionId: 'sess_p1',
      questionId: 'q_pt1_holdout_v1',
      questionFamilyId: 'q_pt1_holdout',
      partId: 'q_pt1_holdout_p1',
      skillId: 'MATH.GEO2D.COMPOSITE_AREA',
      difficultyAtAttempt: 2.5,
      selectedAnswer: 'A',
      isCorrect: false,
      timeSpentSec: 40,
      isSpacedReview: false,
      isLegacy: true,
      createdAt: '2026-11-21T05:00:00.000Z',
    },
    {
      attemptId: 'att_p_sandbox',
      studentId,
      sessionId: 'sess_sb',
      questionId: 'q_nat_2_v2',
      questionFamilyId: 'q_nat_2',
      partId: 'q_nat_2_p1',
      skillId: 'MATH.NUM.NUMBER_SEQUENCES',
      difficultyAtAttempt: 2.5,
      selectedAnswer: 'B',
      isCorrect: true,
      timeSpentSec: 10,
      isSpacedReview: false,
      isSandbox: true,
      createdAt: todayIso,
    },
  ];
  await Promise.all([pgRepo.appendPartAttempts(attempts), memRepo.appendPartAttempts(attempts)]);

  // Verify pagination, filters, search, sorting, and out-of-range clamping parity
  const queries = [
    { monitoredStudentId: studentId, dailyQuestionTarget: 8, sort: 'id_asc' as const, pageSize: 2, page: 1 },
    { monitoredStudentId: studentId, page: 99, pageSize: 2, includeSummary: false },
    { monitoredStudentId: studentId, poolStatus: 'live' as const, completionStatus: 'done' as const },
    { monitoredStudentId: studentId, completionStatus: 'needs_repair' as const },
    { monitoredStudentId: studentId, completionStatus: 'in_review' as const },
    { monitoredStudentId: studentId, completionStatus: 'unseen' as const, includeSummary: false },
    { monitoredStudentId: studentId, search: 'Observatory' },
    { monitoredStudentId: studentId, search: 'perimeter', skillId: 'MATH.GEO2D.COMPOSITE_AREA' },
    { monitoredStudentId: studentId, poolStatus: 'paused' as const, missingExplanation: true },
    { monitoredStudentId: studentId, missingVisual: true, flaggedOnly: true },
    { monitoredStudentId: studentId, batchId: 'tag_PT1' },
    { monitoredStudentId: studentId, includeHistorical: true, sort: 'version_desc' as const },
    { monitoredStudentId: null, dailyQuestionTarget: 8 },
  ];

  for (const qParams of queries) {
    const [pgRes, memRes] = await Promise.all([
      pgRepo.listQuestionsPaginated(qParams),
      memRepo.listQuestionsPaginated(qParams),
    ]);
    assert.deepEqual(pgRes.questions.map((q) => q.questionId), memRes.questions.map((q) => q.questionId));
    assert.equal(pgRes.totalMatching, memRes.totalMatching);
    assert.equal(pgRes.page, memRes.page);
    assert.deepEqual(Object.keys(pgRes.stimuliById).sort(), Object.keys(memRes.stimuliById).sort());
    assert.deepEqual(pgRes.openFlagsByQuestionId, memRes.openFlagsByQuestionId);
    assert.deepEqual(pgRes.progressByQuestionId, memRes.progressByQuestionId);
    assert.deepEqual(pgRes.poolHealth, memRes.poolHealth);
    assert.deepEqual(
      pgRes.masteredLiveQuestionIds?.slice().sort(),
      memRes.masteredLiveQuestionIds?.slice().sort()
    );
    if (memRes.batchSummaries) {
      const normBatches = (list: typeof memRes.batchSummaries) =>
        list.map(({ batchId: _id, createdAtIso: _ts, ...rest }) => ({
          ...rest,
          questionIds: [...rest.questionIds].sort(),
        }));
      assert.deepEqual(normBatches(pgRes.batchSummaries!), normBatches(memRes.batchSummaries));
    }
  }

  // Verify SQL-aggregated summaries match MemoryRepository identically
  assert.deepEqual(await pgRepo.getAdminBankStatusSummary(), await memRepo.getAdminBankStatusSummary());
  const normDash = (d: Awaited<ReturnType<typeof pgRepo.getStudentDashboardBankSummary>>) => ({
    ...d,
    customBatches: d.customBatches.map(({ batchId: _id, ...rest }) => rest),
  });
  assert.deepEqual(
    normDash(await pgRepo.getStudentDashboardBankSummary(studentId, false)),
    normDash(await memRepo.getStudentDashboardBankSummary(studentId, false))
  );
  assert.deepEqual(
    normDash(await pgRepo.getStudentDashboardBankSummary(studentId, true)),
    normDash(await memRepo.getStudentDashboardBankSummary(studentId, true))
  );
  assert.deepEqual(
    await pgRepo.getTodayAttemptCounts(studentId, '2026-11-22'),
    await memRepo.getTodayAttemptCounts(studentId, '2026-11-22')
  );
  assert.deepEqual(
    await pgRepo.getStudentProgressStats({ studentId, writingSubmissionsCount: 0, writingEvaluatedCount: 0 }),
    await memRepo.getStudentProgressStats({ studentId, writingSubmissionsCount: 0, writingEvaluatedCount: 0 })
  );
  assert.deepEqual(
    await pgRepo.getPoolHealthByLearner([studentId, 'empty_student'], 8),
    await memRepo.getPoolHealthByLearner([studentId, 'empty_student'], 8)
  );

  // Verify slim selection queries + targeted ID fetch + bulkUpdateQuestionStatus
  const [pgSel, memSel] = await Promise.all([
    pgRepo.listSelectionQuestions({ qcStatus: 'active', section: 'MATH' }),
    memRepo.listSelectionQuestions({ qcStatus: 'active', section: 'MATH' }),
  ]);
  assert.deepEqual(
    pgSel.map((q) => q.questionId).sort(),
    memSel.map((q) => q.questionId).sort()
  );
  assert.equal((await pgRepo.listQuestionsByIds(['q_nat_2_v2', 'q_read_vis_v1'])).length, 2);

  const updated = await pgRepo.bulkUpdateQuestionStatus(['q_nat_2_v2', 'q_read_vis_v1'], 'retired');
  assert.equal(updated, 2);
  assert.equal((await pgRepo.getQuestionWithStimulus('q_nat_2_v2'))?.question.qcStatus, 'retired');
  assert.equal((await pgRepo.getQuestionWithStimulus('q_read_vis_v1'))?.question.qcStatus, 'retired');
});
