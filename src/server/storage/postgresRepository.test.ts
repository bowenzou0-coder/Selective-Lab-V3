import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { Client, Pool } from 'pg';
import {
  DEFAULT_LEARNING_CONFIG,
  type BankImportManifest,
  type BenchmarkReportRecord,
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

/** Minimal in-process pg stand-in: records SQL and answers the handful of statements under test. */
function createStubPool(initialConfig: { id: string; version: number; config: unknown }) {
  const state = { config: initialConfig, statements: [] as string[] };
  const answer = (sql: string, params: unknown[] = []) => {
    state.statements.push(sql);
    if (sql.includes('to_regclass')) return { rows: [{ ready: true }], rowCount: 1 };
    if (sql.includes('FROM admin_config_versions ORDER BY version_number DESC LIMIT 1')) {
      return {
        rows: [{ config_version_id: state.config.id, version_number: state.config.version, config: structuredClone(state.config.config) }],
        rowCount: 1,
      };
    }
    if (sql.includes('COALESCE(MAX(version_number), 1) + 1')) return { rows: [{ next: state.config.version + 1 }], rowCount: 1 };
    if (sql.startsWith('INSERT INTO admin_config_versions')) {
      state.config = { id: String(params[0]), version: Number(params[1]), config: JSON.parse(String(params[3])) };
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("data#>>'{checkpoint,elapsedSec}'")) {
      return {
        rows: [
          {
            session_id: 'sess_1', mode: 'section_drill', status: 'submitted', is_sandbox: false, section_filter: 'READ',
            started_at: '2026-11-20T09:00:00.000Z', completed_at: '2026-11-20T09:12:00.000Z',
            correct_slots: '7', total_slots: '10', elapsed_sec: '720',
          },
          {
            session_id: 'sess_2', mode: 'daily_adaptive', status: 'in_progress', is_sandbox: false, section_filter: null,
            started_at: '2026-11-21T09:00:00.000Z', completed_at: null, correct_slots: null, total_slots: '4', elapsed_sec: null,
          },
        ],
        rowCount: 2,
      };
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = {
    query: async (sql: string, params?: unknown[]) => answer(sql, params),
    connect: async () => ({ query: async (sql: string, params?: unknown[]) => answer(sql, params), release: () => {} }),
  } as unknown as Pool;
  return { pool, state };
}

test('PostgresRepository caches the active config, clones results, and invalidates on save/restore', async () => {
  const { pool, state } = createStubPool({ id: 'cfg_v1', version: 1, config: structuredClone(DEFAULT_LEARNING_CONFIG) });
  const repo = new PostgresRepository(pool);
  const configReads = () => state.statements.filter((sql) => sql.includes('LIMIT 1') && sql.includes('admin_config_versions')).length;

  const first = await repo.getActiveConfig();
  const second = await repo.getActiveConfig();
  assert.equal(configReads(), 1, 'second read is served from the in-memory cache');
  assert.equal(second.configVersionId, 'cfg_v1');

  first.config.sessionDefaults.dailyGoalMinutes = 999;
  assert.notEqual((await repo.getActiveConfig()).config.sessionDefaults.dailyGoalMinutes, 999, 'callers cannot mutate cached state');

  // Another repository over the same pool shares the cache.
  await new PostgresRepository(pool).getActiveConfig();
  assert.equal(configReads(), 1);

  const nextConfig = structuredClone(DEFAULT_LEARNING_CONFIG);
  nextConfig.sessionDefaults.dailyGoalMinutes = 45;
  const saved = await repo.saveConfigVersion(nextConfig, 'tune');
  const afterSave = await repo.getActiveConfig();
  assert.equal(configReads(), 2, 'saveConfigVersion clears the cache immediately');
  assert.equal(afterSave.configVersionId, saved.configVersionId);
  assert.equal(afterSave.config.sessionDefaults.dailyGoalMinutes, 45);

  await repo.getActiveConfig();
  assert.equal(configReads(), 2);
  await repo.restoreFullBackup({ not: 'a bundle' }, { dryRun: false }).catch(() => undefined);
  await repo.getActiveConfig();
  assert.equal(configReads(), 3, 'a non-dry-run restore clears the cache even when it fails');

  await repo.restoreFullBackup({ not: 'a bundle' }, { dryRun: true }).catch(() => undefined);
  await repo.getActiveConfig();
  assert.equal(configReads(), 3, 'dry-run restore keeps the cache');
});

test('PostgresRepository.listSessionSummaries projects slim columns instead of full session JSON', async () => {
  const { pool, state } = createStubPool({ id: 'cfg_v1', version: 1, config: DEFAULT_LEARNING_CONFIG });
  const rows = await new PostgresRepository(pool).listSessionSummaries(100, 'stu_a', false);
  const sql = state.statements.find((s) => s.includes("data#>>'{checkpoint,elapsedSec}'"))!;
  assert.ok(sql);
  assert.doesNotMatch(sql, /SELECT\s+data\b|data - 'submissionSummary'/, 'never selects the whole data column');
  assert.deepEqual(rows, [
    {
      sessionId: 'sess_1', mode: 'section_drill', status: 'submitted', isSandbox: false, sectionFilter: 'READ',
      startedAt: '2026-11-20T09:00:00.000Z', completedAt: '2026-11-20T09:12:00.000Z', correctSlots: 7, totalSlots: 10, elapsedSec: 720,
    },
    {
      sessionId: 'sess_2', mode: 'daily_adaptive', status: 'in_progress', isSandbox: false,
      startedAt: '2026-11-21T09:00:00.000Z', correctSlots: 0, totalSlots: 4, elapsedSec: 0,
    },
  ]);
});

const testUrl = process.env.TEST_POSTGRES_URL;
const postgresOnly = { skip: !testUrl && 'Set TEST_POSTGRES_URL to a disposable Postgres database' };

/** Local Postgres, or a dedicated test database created inside a disposable Neon branch. */
async function isolatedSchema(t: TestContext) {
  const url = new URL(testUrl!);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const neonTestDb = url.hostname.endsWith('.neon.tech') && /^\/pack6_qa_[a-f0-9]{32}$/.test(url.pathname);
  assert.ok(local || neonTestDb, 'Remote tests require a dedicated pack6_qa_<uuid hex> Neon database');
  assert.ok([...url.searchParams.keys()].every(key => ['sslmode', 'channel_binding'].includes(key)),
    'Test URL cannot override connection parameters or search_path');
  const baseConfig = getPostgresPoolConfig({ DATABASE_URL: url.href });
  // Allow a newly provisioned Neon compute to finish starting up.
  if (neonTestDb) baseConfig.connectionTimeoutMillis = 90_000;
  const admin = new Pool(baseConfig);
  const schema = `selective_test_${randomUUID().replaceAll('-', '')}`;
  const pools: Pool[] = [];
  t.after(async () => {
    try {
      await Promise.all(pools.map(pool => pool.end()));
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await admin.end();
    }
  });
  await admin.query(`CREATE SCHEMA ${schema}`);
  return () => {
    const pool = new Pool({ ...baseConfig, options: `-c search_path=${schema}` });
    pools.push(pool);
    return pool;
  };
}

test('Postgres concurrent initialization, manifest retries, rollback, and account isolation', postgresOnly, async (t) => {
  const newPool = await isolatedSchema(t);
  const pool = newPool();
  const peerPool = newPool();
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

function sampleReport(): BenchmarkReportRecord {
  const benchSection = (code: 'READ' | 'MATH' | 'THINK' | 'WRIT') => ({
    section: code, correct: 18, total: 30, unanswered: 2, accuracyPct: 60, band: 'next_25' as const, estimatedPercentile: 64,
  });
  return {
    reportId: 'bench_sess_report_only',
    sessionId: 'sess_report_only',
    studentId: 'learner_report_only',
    batchLabel: '2026-11-20_b01',
    title: 'Official sample A',
    completedAtIso: '2026-11-22T09:30:00.000Z',
    elapsedSec: 7000,
    timeLimitSec: 9000,
    difficulty: 'official_sample',
    scaledScore120: 84,
    uncertaintyHalfWidth120: 7,
    estimatedPercentile: 70,
    estimatedStateRank: 4500,
    estimatedApplicantPool: 15000,
    writingStatus: 'missing',
    sections: { READ: benchSection('READ'), MATH: benchSection('MATH'), THINK: benchSection('THINK'), WRIT: benchSection('WRIT') },
    weakSkillStats: [],
  };
}

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
  'benchmark_reports',
  'learner_preferences',
] as const;

async function snapshotTableCounts(pool: Pool): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of BACKUP_TABLES) {
    const { rows } = await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`);
    counts[table] = rows[0].count;
  }
  return counts;
}

test('Postgres canonical backup exports consistent snapshot including daily plans, restores atomically, and accepts legacy bundles', postgresOnly, async (t) => {
  const newSourcePool = await isolatedSchema(t);
  const srcPool = newSourcePool();
  const srcPeerPool = newSourcePool();
  const dstPool = (await isolatedSchema(t))();
  const legacyPool = (await isolatedSchema(t))();

  const srcRepo = new PostgresRepository(srcPool);
  const srcPeer = new PostgresRepository(srcPeerPool);
  const dstRepo = new PostgresRepository(dstPool);
  const legacyRepo = new PostgresRepository(legacyPool);
  await Promise.all([srcRepo.ensureSchema(), dstRepo.ensureSchema(), legacyRepo.ensureSchema()]);

  const tables = await srcPool.query<{ tablename: string }>(
    'SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename'
  );
  assert.deepEqual(tables.rows.map(row => row.tablename), [...BACKUP_TABLES].sort());
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

  // Learner who ONLY has a benchmark_reports row, and one who ONLY has learner_preferences
  const benchReport = sampleReport();
  await srcRepo.saveBenchmarkReport(benchReport);
  const savedPrefs = await srcRepo.saveLearnerPreferences('learner_prefs_only', {
    dailyGoalMinutes: 40,
    adminOverrideLocked: true,
    updatedBy: 'admin',
  });

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
  assert.equal(backup.schemaVersion, 'v3_canonical_1.0');
  assert.equal(backup.counts.dailyFocusPlans, 3);
  assert.ok(backup.users.some((u) => u.uid === 'learner_plan_only' && u.dailyFocusPlans?.length === 1));
  assert.ok(backup.users.some((u) => u.uid === 'learner_ev_only' && u.questionEvidence.length === 1));
  assert.equal(backup.counts.benchmarkReports, 1);
  assert.equal(backup.counts.learnerPreferences, 1);
  assert.deepEqual(backup.users.find((u) => u.uid === 'learner_report_only')?.benchmarkReports, [benchReport]);
  assert.deepEqual(backup.users.find((u) => u.uid === 'learner_prefs_only')?.learnerPreferences, savedPrefs);

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
  assert.equal(dry.wouldCreate.benchmarkReports, 1);
  assert.equal(dry.wouldCreate.learnerPreferences, 1);
  assert.deepEqual(await snapshotTableCounts(dstPool), beforeCounts);

  const restored = await dstRepo.restoreFullBackup(backup, { dryRun: false });
  assert.equal(restored.valid, true);
  assert.equal(restored.applied.questions, backup.questions.length);
  assert.equal(restored.applied.importBatches, backup.importBatches.length);
  assert.equal(restored.applied.mediaAssets, 1);
  assert.equal(restored.applied.dailyFocusPlans, 3);
  assert.equal(restored.applied.benchmarkReports, 1);
  assert.equal(restored.applied.learnerPreferences, 1);

  // Compare ALL 18 tables and fields between source and destination
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
  assert.deepEqual(await dstRepo.getBenchmarkReport('sess_report_only', 'learner_report_only'), benchReport);
  assert.deepEqual(await dstRepo.getLearnerPreferences('learner_prefs_only'), savedPrefs);

  // Replay must be a clean no-op
  const countsAfterRestore = await snapshotTableCounts(dstPool);
  const replay = await dstRepo.restoreFullBackup(backup, { dryRun: false });
  assert.equal(replay.valid, true);
  for (const val of Object.values(replay.wouldCreate)) assert.equal(val, 0);
  for (const val of Object.values(replay.applied)) assert.equal(val, 0);
  assert.deepEqual(await snapshotTableCounts(dstPool), countsAfterRestore);

  // Backwards compatibility: older canonical bundle without dailyFocusPlans, benchmarkReports or learnerPreferences
  const legacyUsers = backup.users.map(
    ({ dailyFocusPlans: _omitted, benchmarkReports: _r, learnerPreferences: _p, ...rest }) => rest
  );
  const { dailyFocusPlans: _omittedCount, benchmarkReports: _rc, learnerPreferences: _pc, ...legacyCounts } = backup.counts;
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
  assert.equal(legacyApplied.applied.benchmarkReports, 0);
  assert.equal(legacyApplied.applied.learnerPreferences, 0);
  assert.equal(await legacyRepo.getBenchmarkReport('sess_report_only'), null);
  assert.equal(await legacyRepo.getDailyFocusPlan('learner_full', '2026-11-20'), null);

  await t.test('deleteUserAccount removes every owned row and preserves the other learners and bank', async () => {
    const owner = session.studentId!;
    await dstRepo.saveBenchmarkReport({ ...benchReport, studentId: owner, sessionId: session.sessionId });
    await dstRepo.saveLearnerPreferences(owner, savedPrefs);
    const before = await snapshotTableCounts(dstPool);
    const result = await dstRepo.deleteUserAccount(owner);
    assert.deepEqual(result, {
      ok: true, deletedUser: true, clearedSessions: 1, clearedAttempts: 1, clearedSkillStates: 1,
      clearedMemory: 1, clearedEvidence: 1, clearedWriting: 1, clearedDailyPlans: 1, clearedFlags: 1,
      preservedQuestionsCount: backup.questions.length,
    });
    const after = await snapshotTableCounts(dstPool);
    const shared = new Set(['stimuli', 'questions', 'import_batches', 'admin_config_versions', 'media_assets']);
    for (const table of BACKUP_TABLES) {
      assert.equal(after[table], before[table] - (shared.has(table) ? 0 : 1), table);
    }
    const survivors = await dstRepo.exportFullBackup();
    assert.deepEqual(survivors.users, dstExport.users.filter(user => user.uid !== owner));
    assert.deepEqual(survivors.questionFlags, []);
    const missing = await dstRepo.deleteUserAccount('never-registered');
    assert.deepEqual(missing, {
      ok: true, deletedUser: false, clearedSessions: 0, clearedAttempts: 0, clearedSkillStates: 0,
      clearedMemory: 0, clearedEvidence: 0, clearedWriting: 0, clearedDailyPlans: 0, clearedFlags: 0,
      preservedQuestionsCount: result.preservedQuestionsCount,
    });
    assert.deepEqual(await snapshotTableCounts(dstPool), after);
  });
});

test('Postgres bank cache revalidates on out-of-band writes and slim queries match full reads', postgresOnly, async (t) => {
  const newPool = await isolatedSchema(t);
  const pool = newPool();
  const writerPool = newPool();

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
  const coldPool = newPool();
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

test('Postgres SQL-first pagination, search, status aggregates, progress stats, and bulk status match MemoryRepository', postgresOnly, async (t) => {
  const pool = (await isolatedSchema(t))();

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
  const mathSvg = (await pgRepo.getQuestionWithStimulus(mathTemplate.questionId))!.question;
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
    benchmarkBatches: d.benchmarkBatches.map(({ batchId: _id, ...rest }) => rest),
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

test('withdrawQuestionFlagRow deletes only the caller\'s open flag and explains misses', async () => {
  const { withdrawQuestionFlagRow } = await import('./postgresAccountQueries.ts');
  const flags = new Map<string, { studentId: string; status: string }>([
    ['f_open', { studentId: 'stu_a', status: 'open' }],
    ['f_done', { studentId: 'stu_a', status: 'resolved' }],
  ]);
  const statements: string[] = [];
  const db = {
    query: async (sql: string, params: unknown[]) => {
      statements.push(sql);
      const [flagId, studentId] = params as [string, string];
      const row = flags.get(flagId);
      const owned = row && row.studentId === studentId;
      if (sql.startsWith('DELETE')) {
        assert.match(sql, /status = 'open'/);
        assert.match(sql, /data->>'studentId' = \$2/);
        if (owned && row.status === 'open') {
          flags.delete(flagId);
          return { rows: [{ flag_id: flagId }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      return owned ? { rows: [{ status: row.status }], rowCount: 1 } : { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;

  assert.equal(await withdrawQuestionFlagRow(db, 'f_open', 'stu_b'), 'not_found');
  assert.equal(await withdrawQuestionFlagRow(db, 'f_done', 'stu_a'), 'not_open');
  assert.equal(await withdrawQuestionFlagRow(db, 'f_open', 'stu_a'), 'withdrawn');
  assert.equal(await withdrawQuestionFlagRow(db, 'f_open', 'stu_a'), 'not_found');
  assert.equal(flags.has('f_done'), true, 'resolved flags are never deleted');
  // A successful withdrawal is a single statement (no read-then-delete race).
  assert.equal(statements.filter((s) => s.startsWith('DELETE')).length, 4);
});

test('Postgres learner preferences persist student settings and administrator overrides', postgresOnly, async t => {
  const newPool = await isolatedSchema(t);
  const repo = new PostgresRepository(newPool());
  const reader = new PostgresRepository(newPool());
  assert.equal(await repo.getLearnerPreferences('alice'), null);
  const initial = await repo.saveLearnerPreferences('alice', { dailyGoalMinutes: 25, updatedBy: 'student' });
  assert.equal(initial.dailyGoalMinutes, 25);
  assert.ok(Number.isFinite(Date.parse(initial.updatedAtIso!)));
  assert.deepEqual(await reader.getLearnerPreferences('alice'), initial);
  const override = { dailyGoalMinutes: 45, updatedBy: 'admin', adminOverrideLocked: true } as const;
  const saved = await repo.saveLearnerPreferences('alice', override);
  assert.deepEqual(await reader.getLearnerPreferences('alice'), { ...override, updatedAtIso: saved.updatedAtIso });
  assert.equal(await reader.getLearnerPreferences('bob'), null);
});

test('Postgres student flag lists and withdrawals enforce ownership and open status', postgresOnly, async t => {
  const repo = new PostgresRepository((await isolatedSchema(t))());
  const flag: QuestionFlagRecord = { flagId: 'open', questionId: 'q', sessionId: 's', studentId: 'alice',
    reason: 'unclear', status: 'open', createdAt: '2026-11-20T00:00:00Z' };
  const reviewed = { ...flag, flagId: 'reviewed', createdAt: '2026-11-21T00:00:00Z' };
  const other = { ...flag, flagId: 'other', studentId: 'bob' };
  for (const item of [flag, reviewed, other]) await repo.saveQuestionFlag(item);
  await repo.resolveQuestionFlag(reviewed.flagId);
  assert.deepEqual(await repo.listQuestionFlags('alice'), [{ ...reviewed, status: 'resolved' }, flag]);
  assert.equal(await repo.withdrawQuestionFlag('open', 'bob'), 'not_found');
  assert.equal(await repo.withdrawQuestionFlag('reviewed', 'alice'), 'not_open');
  assert.equal(await repo.withdrawQuestionFlag('open', 'alice'), 'withdrawn');
  assert.equal(await repo.withdrawQuestionFlag('open', 'alice'), 'not_found');
  assert.deepEqual(await repo.listQuestionFlags('alice'), [{ ...reviewed, status: 'resolved' }]);
  assert.deepEqual(await repo.listQuestionFlags('bob'), [other]);
});

test('Postgres benchmark reports are scoped, ordered and upsert AI coaching by session', postgresOnly, async t => {
  const repo = new PostgresRepository((await isolatedSchema(t))());
  const report = sampleReport();
  const older = { ...report, sessionId: 'older', completedAtIso: '2026-11-01T00:00:00Z' };
  const other = { ...report, sessionId: 'other', studentId: 'other' };
  for (const item of [report, older, other]) await repo.saveBenchmarkReport(item);
  assert.deepEqual(await repo.getBenchmarkReport(report.sessionId, report.studentId), report);
  assert.equal(await repo.getBenchmarkReport(report.sessionId, other.studentId), null);
  const coached: BenchmarkReportRecord = { ...report, aiCoaching: {
    generatedAtIso: report.completedAtIso, source: 'hybrid_gemini', rankedPriorities: [],
    parentSummaryEn: 'Focus on reading.', parentSummaryZh: '重点练习阅读。', actionPlanEn: [], actionPlanZh: [],
  } };
  await repo.saveBenchmarkReport(coached);
  assert.deepEqual(await repo.getBenchmarkReport(report.sessionId), coached);
  assert.deepEqual(await repo.listBenchmarkReports(report.studentId), [coached, older]);
  assert.deepEqual(await repo.listBenchmarkReports(report.studentId, 1), [coached]);
});
