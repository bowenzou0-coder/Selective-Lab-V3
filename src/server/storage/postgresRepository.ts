import crypto from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type {
  BankImportManifest,
  DailyFocusPlan,
  ImportBatchRecord,
  LearningConfig,
  MediaAssetRecord,
  PartAttemptRecord,
  QuestionFlagRecord,
  QuestionItem,
  QuestionMasteryEvidence,
  QuestionMemoryState,
  SessionCheckpoint,
  SessionQuestionSnapshot,
  SessionRecord,
  SkillState,
  StimulusGroup,
  VisualSpec,
  WritingEvaluationRecord,
} from '../../shared/contracts.ts';
import { DEFAULT_LEARNING_CONFIG } from '../../shared/contracts.ts';
import { computeEvidenceRevision } from '../../shared/mastery.ts';
import { computeCanonicalHash, validateAndDryRunManifest } from '../manifestValidator.ts';
import { buildMediaMigrationManifest } from '../mediaService.ts';
import { getPostgresPoolConfig } from './postgresConfig.ts';
import {
  ForbiddenError,
  NotFoundError,
  RevisionConflictError,
  type AppRepository,
  type BackupRestoreReport,
  type CanonicalBackupBundle,
  type CheckpointSaveResult,
  type FinalizeSessionInput,
  type FinalizeSessionResult,
  type MigrationPreflightReport,
  type ProgressCountsResponse,
  type ProgressResetResponse,
  type QuestionQueryParams,
  type QuestionQueryResult,
  type QuestionVersionSummary,
  type ReserveSessionResult,
  type SyncHydratePayload,
  type WritingSubmissionRecord,
} from './repository.ts';
import {
  emptyRestoreReport,
  filterAndPaginateQuestions,
  finalizeBackupBundle,
  selectLatestByFamily,
  validateIncomingBackupBundle,
} from './repositoryUtils.ts';

const DEFAULT_STUDENT_ID = 'default-student';

declare global {
  var _nswSelectivePgPool: Pool | undefined;
}

export function createPostgresPool(): Pool {
  const pool = new Pool(getPostgresPoolConfig());
  pool.on('error', (err) => {
    console.error('Unexpected error on idle Postgres pool client:', err.message);
  });
  return pool;
}

export function getOrCreatePgPool(): Pool {
  if (!global._nswSelectivePgPool) {
    global._nswSelectivePgPool = createPostgresPool();
  }
  return global._nswSelectivePgPool;
}

type ManifestImportResult = Awaited<ReturnType<AppRepository['importManifest']>> & { replayed: boolean };
const schemaReadyByPool = new WeakMap<Pool, Promise<void>>();

function manifestBatchId(manifest: object): string {
  const canonical = JSON.stringify(manifest, (key, value: unknown) => {
    if (key === 'evidenceRevision') return undefined;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
  return `batch_pg_${crypto.createHash('sha256').update(canonical).digest('hex')}`;
}

function manifestImportResult(batch: ImportBatchRecord, replayed: boolean): ManifestImportResult {
  return {
    imported: batch.newQuestionIds.length,
    versionBumped: batch.versionBumpedQuestionIds.length,
    skipped: batch.skippedQuestionIds.length,
    batch,
    replayed,
  };
}

export class PostgresRepository implements AppRepository {
  readonly backendName = 'postgres' as const;

  constructor(private readonly pool: Pool = getOrCreatePgPool()) {}

  async ensureSchema(): Promise<void> {
    let schemaReady = schemaReadyByPool.get(this.pool);
    if (!schemaReady) {
      schemaReady = this.runSchemaInit().catch((err) => {
        schemaReadyByPool.delete(this.pool);
        throw err;
      });
      schemaReadyByPool.set(this.pool, schemaReady);
    }
    await schemaReady;
  }

  private async transaction<T>(
    work: (client: PoolClient) => Promise<T>,
    begin = 'BEGIN ISOLATION LEVEL READ COMMITTED'
  ): Promise<T> {
    const client = await this.pool.connect();
    let discardClient = false;
    try {
      await client.query(begin);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        discardClient = true;
      }
      throw error;
    } finally {
      client.release(discardClient);
    }
  }

  private async runSchemaInit(): Promise<void> {
    const ddl = `
      CREATE TABLE IF NOT EXISTS users (
        uid TEXT PRIMARY KEY,
        role TEXT NOT NULL DEFAULT 'student',
        display_name TEXT NOT NULL,
        email TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS stimuli (
        stimulus_id TEXT PRIMARY KEY,
        stimulus_family_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        content_hash TEXT,
        section TEXT NOT NULL,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS questions (
        question_id TEXT PRIMARY KEY,
        question_family_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        content_hash TEXT,
        section TEXT NOT NULL,
        format_type TEXT NOT NULL,
        pool_type TEXT NOT NULL,
        qc_status TEXT NOT NULL,
        stimulus_id TEXT,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS import_batches (
        batch_id TEXT PRIMARY KEY,
        batch_label TEXT,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS media_assets (
        asset_id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS admin_config_versions (
        config_version_id TEXT PRIMARY KEY,
        version_number INTEGER NOT NULL,
        notes TEXT,
        config JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        student_id TEXT NOT NULL DEFAULT 'default-student',
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        is_sandbox BOOLEAN NOT NULL DEFAULT FALSE,
        data JSONB NOT NULL,
        started_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS session_snapshots (
        session_id TEXT PRIMARY KEY,
        student_id TEXT NOT NULL,
        snapshots JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS part_attempts (
        attempt_id TEXT PRIMARY KEY,
        student_id TEXT NOT NULL DEFAULT 'default-student',
        session_id TEXT NOT NULL,
        question_id TEXT NOT NULL,
        part_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        is_correct BOOLEAN NOT NULL,
        is_sandbox BOOLEAN NOT NULL DEFAULT FALSE,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS writing_submissions (
        submission_id TEXT PRIMARY KEY,
        student_id TEXT NOT NULL DEFAULT 'default-student',
        session_id TEXT NOT NULL,
        question_id TEXT NOT NULL,
        data JSONB NOT NULL,
        submitted_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS writing_evaluations (
        evaluation_id TEXT PRIMARY KEY,
        submission_id TEXT NOT NULL,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS skill_states (
        student_id TEXT NOT NULL DEFAULT 'default-student',
        skill_id TEXT NOT NULL,
        data JSONB NOT NULL,
        PRIMARY KEY (student_id, skill_id)
      );
      CREATE TABLE IF NOT EXISTS question_memory (
        student_id TEXT NOT NULL DEFAULT 'default-student',
        question_family_id TEXT NOT NULL,
        data JSONB NOT NULL,
        PRIMARY KEY (student_id, question_family_id)
      );
      CREATE TABLE IF NOT EXISTS question_evidence (
        student_id TEXT NOT NULL,
        evidence_key TEXT NOT NULL,
        data JSONB NOT NULL,
        PRIMARY KEY (student_id, evidence_key)
      );
      CREATE TABLE IF NOT EXISTS question_flags (
        flag_id TEXT PRIMARY KEY,
        question_id TEXT NOT NULL,
        status TEXT NOT NULL,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS daily_focus_plans (
        student_id TEXT NOT NULL,
        plan_date TEXT NOT NULL,
        data JSONB NOT NULL,
        PRIMARY KEY (student_id, plan_date)
      );
      CREATE INDEX IF NOT EXISTS questions_family_version_idx ON questions (question_family_id, version DESC);
      CREATE INDEX IF NOT EXISTS sessions_student_started_idx ON sessions (student_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS part_attempts_student_created_idx ON part_attempts (student_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS writing_submissions_student_idx ON writing_submissions (student_id);
      CREATE INDEX IF NOT EXISTS writing_evaluations_submission_idx ON writing_evaluations (submission_id, created_at DESC);
    `;
    try {
      await this.transaction(async (client) => {
        // IF NOT EXISTS alone can race with DDL from another cold function instance.
        await client.query("SELECT pg_advisory_xact_lock(hashtext('selective_lab_schema'), hashtext(current_schema()))");
        await client.query(ddl);
        await client.query(
          `INSERT INTO admin_config_versions (config_version_id, version_number, notes, config)
           SELECT $1, $2, $3, $4 WHERE NOT EXISTS (SELECT 1 FROM admin_config_versions)
           ON CONFLICT (config_version_id) DO NOTHING`,
          ['cfg_v1', 1, 'Default Selective Lab Learning Config', JSON.stringify(DEFAULT_LEARNING_CONFIG)]
        );
      });
    } catch (error) {
      console.error('Database schema initialization failed:', error);
      throw new Error('Database initialization failed. Please try again later.', { cause: error });
    }
  }

  async initAndSeedIfEmpty(seedManifest: BankImportManifest): Promise<void> {
    await this.ensureSchema();
    await this.transaction(async (client) => {
      await this.lockQuestionBank(client);
      const existing = await client.query('SELECT 1 FROM questions LIMIT 1');
      if (existing.rows.length === 0) {
        const batchId = manifestBatchId(seedManifest);
        if (!(await this.findManifestImport(client, batchId))) {
          await this.writeManifest(client, seedManifest, 'system_seed', batchId);
        }
      }
    });
  }

  async upsertUserFromAuth(input: {
    uid: string;
    email: string;
    displayName?: string;
    isBootstrappedAdmin: boolean;
  }): Promise<{ role: 'student' | 'admin' }> {
    await this.ensureSchema();
    const role: 'student' | 'admin' = input.isBootstrappedAdmin ? 'admin' : 'student';
    const displayName = (input.displayName || input.email.split('@')[0] || 'Learner').slice(0, 120);
    await this.pool.query(
      `INSERT INTO users (uid, role, display_name, email, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (uid) DO UPDATE SET role = EXCLUDED.role, display_name = EXCLUDED.display_name, email = EXCLUDED.email, updated_at = NOW()`,
      [input.uid, role, displayName, input.email]
    );
    return { role };
  }

  async isUserAdmin(uid: string): Promise<boolean> {
    await this.ensureSchema();
    const { rows } = await this.pool.query('SELECT role FROM users WHERE uid = $1', [uid]);
    return rows[0]?.role === 'admin';
  }

  async getProgressCounts(studentId: string): Promise<ProgressCountsResponse> {
    await this.ensureSchema();
    const { rows } = await this.pool.query<ProgressCountsResponse>(`
      SELECT (SELECT count(*)::int FROM sessions WHERE student_id = $1) AS "sessionsCount",
             (SELECT count(*)::int FROM part_attempts WHERE student_id = $1) AS "attemptsCount",
             (SELECT count(*)::int FROM question_evidence WHERE student_id = $1) AS "evidenceCount",
             (SELECT count(*)::int FROM writing_submissions WHERE student_id = $1) AS "writingCount",
             (SELECT count(DISTINCT question_family_id)::int FROM questions) AS "bankQuestionsCount"`,
      [studentId]
    );
    return rows[0];
  }

  async resetStudentProgress(studentId: string): Promise<ProgressResetResponse> {
    await this.ensureSchema();
    return this.transaction(async (client) => {
      await this.lockStudentProgress(client, studentId);
      const sessions = await client.query('DELETE FROM sessions WHERE student_id = $1', [studentId]);
      await client.query('DELETE FROM session_snapshots WHERE student_id = $1', [studentId]);
      const attempts = await client.query('DELETE FROM part_attempts WHERE student_id = $1', [studentId]);
      const skills = await client.query('DELETE FROM skill_states WHERE student_id = $1', [studentId]);
      const memory = await client.query('DELETE FROM question_memory WHERE student_id = $1', [studentId]);
      const evidence = await client.query('DELETE FROM question_evidence WHERE student_id = $1', [studentId]);
      await client.query(`
        DELETE FROM writing_evaluations e USING writing_submissions s
        WHERE e.submission_id = s.submission_id AND s.student_id = $1`, [studentId]);
      const writing = await client.query('DELETE FROM writing_submissions WHERE student_id = $1', [studentId]);
      const plans = await client.query('DELETE FROM daily_focus_plans WHERE student_id = $1', [studentId]);
      const bank = await client.query<{ count: number }>('SELECT count(DISTINCT question_family_id)::int AS count FROM questions');
      return {
        ok: true,
        clearedSessions: sessions.rowCount ?? 0,
        clearedAttempts: attempts.rowCount ?? 0,
        clearedSkillStates: skills.rowCount ?? 0,
        clearedMemory: memory.rowCount ?? 0,
        clearedEvidence: evidence.rowCount ?? 0,
        clearedWriting: writing.rowCount ?? 0,
        clearedDailyPlans: plans.rowCount ?? 0,
        preservedQuestionsCount: bank.rows[0].count,
      };
    });
  }

  async hydrateSyncData(studentId: string, payload: SyncHydratePayload): Promise<void> {
    await this.ensureSchema();
    const uid = studentId || DEFAULT_STUDENT_ID;
    for (const s of payload.stimuli || []) {
      if (!s?.stimulusId) continue;
      await this.pool.query(
        `INSERT INTO stimuli (stimulus_id, stimulus_family_id, version, content_hash, section, data)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (stimulus_id) DO NOTHING`,
        [s.stimulusId, s.stimulusFamilyId, s.version, s.contentHash || null, s.section, JSON.stringify(s)]
      );
    }

    for (const q of payload.questions || []) {
      if (!q?.questionId) continue;
      await this.pool.query(
        `INSERT INTO questions (question_id, question_family_id, version, content_hash, section, format_type, pool_type, qc_status, stimulus_id, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (question_id) DO NOTHING`,
        [
          q.questionId,
          q.questionFamilyId,
          q.version,
          q.contentHash || null,
          q.section,
          q.formatType,
          q.poolType,
          q.qcStatus,
          q.stimulusId || null,
          JSON.stringify(q),
        ]
      );
    }

    for (const ov of payload.questionOverrides || []) {
      if (ov.qcStatus) await this.updateQuestionStatus(ov.questionId, ov.qcStatus).catch(() => {});
      if (ov.visual) await this.updateQuestionVisual(ov.questionId, ov.visual).catch(() => {});
    }

    for (const cfg of payload.configVersions || []) {
      if (!cfg?.configVersionId) continue;
      await this.pool.query(
        `INSERT INTO admin_config_versions (config_version_id, version_number, notes, config, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (config_version_id) DO NOTHING`,
        [cfg.configVersionId, cfg.versionNumber, cfg.notes || null, JSON.stringify(cfg.config), cfg.createdAt || new Date().toISOString()]
      );
    }

    for (const s of payload.sessions || []) {
      if (!s?.sessionId) continue;
      const stamped = { ...s, studentId: uid };
      await this.pool.query(
        `INSERT INTO sessions (session_id, student_id, mode, status, is_sandbox, data, started_at, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (session_id) DO NOTHING`,
        [s.sessionId, uid, s.mode, s.status, Boolean(s.isSandbox), JSON.stringify(stamped), s.startedAt, s.completedAt || null]
      );
    }

    for (const a of payload.attempts || []) {
      if (!a?.attemptId) continue;
      const tagged = { ...a, studentId: uid, isLegacy: a.evidenceRevision ? Boolean(a.isLegacy) : true };
      await this.pool.query(
        `INSERT INTO part_attempts (attempt_id, student_id, session_id, question_id, part_id, skill_id, is_correct, is_sandbox, data, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (attempt_id) DO NOTHING`,
        [a.attemptId, uid, a.sessionId, a.questionId, a.partId, a.skillId, a.isCorrect, Boolean(a.isSandbox), JSON.stringify(tagged), a.createdAt]
      );
    }

    if (payload.skillStates?.length) await this.upsertSkillStates(payload.skillStates, uid);
    if (payload.questionMemory?.length) await this.upsertQuestionMemory(payload.questionMemory, uid);

    for (const sub of payload.writingSubmissions || []) {
      if (!sub?.submissionId) continue;
      const { evaluations: _ev, ...rest } = sub;
      await this.pool.query(
        `INSERT INTO writing_submissions (submission_id, student_id, session_id, question_id, data, submitted_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (submission_id) DO NOTHING`,
        [sub.submissionId, uid, sub.sessionId, sub.questionId, JSON.stringify({ ...rest, studentId: uid }), sub.submittedAt]
      );
      for (const ev of sub.evaluations || []) {
        if (!ev?.evaluationId) continue;
        await this.pool.query(
          `INSERT INTO writing_evaluations (evaluation_id, submission_id, data, created_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (evaluation_id) DO NOTHING`,
          [ev.evaluationId, ev.submissionId, JSON.stringify(ev), ev.createdAt]
        );
      }
    }

    for (const fl of payload.flags || []) {
      if (!fl?.flagId) continue;
      await this.pool.query(
        `INSERT INTO question_flags (flag_id, question_id, status, data, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (flag_id) DO NOTHING`,
        [fl.flagId, fl.questionId, fl.status, JSON.stringify(fl), fl.createdAt]
      );
    }
  }

  async listQuestions(filter?: {
    section?: string;
    poolType?: string;
    qcStatus?: string;
    includeHistorical?: boolean;
  }): Promise<QuestionItem[]> {
    await this.ensureSchema();
    const { rows } = await this.pool.query('SELECT data FROM questions');
    const all = rows.map((r) => r.data as QuestionItem);
    const base = filter?.includeHistorical ? all : selectLatestByFamily(all);
    return base.filter((q) => {
      if (filter?.section && q.section !== filter.section) return false;
      if (filter?.poolType && q.poolType !== filter.poolType) return false;
      if (filter?.qcStatus && q.qcStatus !== filter.qcStatus) return false;
      return true;
    });
  }

  async listQuestionsPaginated(params?: QuestionQueryParams): Promise<QuestionQueryResult> {
    await this.ensureSchema();
    const [qRes, sRes, flags, batches] = await Promise.all([
      this.pool.query('SELECT data FROM questions'),
      this.pool.query('SELECT stimulus_id, data FROM stimuli'),
      this.listQuestionFlags(),
      this.listImportBatches(),
    ]);
    const stimuliById: Record<string, StimulusGroup> = {};
    for (const r of sRes.rows) {
      stimuliById[r.stimulus_id] = r.data as StimulusGroup;
    }
    return filterAndPaginateQuestions({
      allQuestions: qRes.rows.map((r) => r.data as QuestionItem),
      stimuliById,
      flags,
      batches,
      params,
    });
  }

  async listQuestionVersions(questionFamilyId: string): Promise<QuestionVersionSummary[]> {
    await this.ensureSchema();
    const { rows } = await this.pool.query<{ question: QuestionItem; stimulus: StimulusGroup | null }>(
      `SELECT q.data AS question, s.data AS stimulus FROM questions q
       LEFT JOIN stimuli s ON s.stimulus_id = q.stimulus_id
       WHERE q.question_family_id = $1 ORDER BY q.version DESC`,
      [questionFamilyId]
    );
    return rows.map(({ question, stimulus }) => ({ question, stimulus: stimulus ?? undefined }));
  }

  async listStimuliByIds(stimulusIds: string[]): Promise<Record<string, StimulusGroup>> {
    await this.ensureSchema();
    const unique = Array.from(new Set(stimulusIds.filter(Boolean)));
    if (unique.length === 0) return {};
    const { rows } = await this.pool.query('SELECT stimulus_id, data FROM stimuli WHERE stimulus_id = ANY($1)', [
      unique,
    ]);
    const out: Record<string, StimulusGroup> = {};
    for (const r of rows) out[r.stimulus_id] = r.data as StimulusGroup;
    return out;
  }

  async getQuestionWithStimulus(
    questionId: string
  ): Promise<{ question: QuestionItem; stimulus?: StimulusGroup } | null> {
    await this.ensureSchema();
    const { rows: [row] } = await this.pool.query<{ question: QuestionItem; stimulus: StimulusGroup | null }>(
      `SELECT q.data AS question, s.data AS stimulus FROM questions q
       LEFT JOIN stimuli s ON s.stimulus_id = q.stimulus_id WHERE q.question_id = $1`,
      [questionId]
    );
    return row ? { question: row.question, stimulus: row.stimulus ?? undefined } : null;
  }

  async importManifest(
    manifest: BankImportManifest,
    importedBy = 'admin'
  ): Promise<ManifestImportResult> {
    await this.ensureSchema();
    const batchId = manifestBatchId(manifest);
    return this.transaction(async (client) => {
      await this.lockQuestionBank(client);
      return (await this.findManifestImport(client, batchId)) ??
        this.writeManifest(client, manifest, importedBy, batchId);
    });
  }

  async validateAndImportManifest(raw: unknown, importedBy: string, options: { dryRun: boolean }) {
    if (!options.dryRun) await this.ensureSchema();
    // Key direct imports to the submitted JSON. Re-validating it against a changed
    // stimulus could otherwise produce a different normalized question for a retry.
    const batchId = raw && typeof raw === 'object' && !Array.isArray(raw) ? manifestBatchId(raw) : null;
    return this.transaction(async (client) => {
      if (!options.dryRun) await this.lockQuestionBank(client);
      const hasBatchesTable = !options.dryRun ||
        (await client.query("SELECT to_regclass('import_batches') AS batches")).rows[0].batches !== null;
      const previous = batchId && hasBatchesTable ? await this.findManifestImport(client, batchId) : null;
      if (previous) {
        const { batch } = previous;
        return {
          report: {
            valid: true,
            batchLabel: batch.batchLabel,
            stimuliCount: batch.stimuliCount,
            questionsCount: batch.questionsCount,
            newQuestions: 0,
            unchangedQuestions: batch.questionsCount,
            versionBumpedQuestions: 0,
            errors: [],
            warnings: [],
          },
          result: options.dryRun ? null : previous,
          replayed: true,
        };
      }
      const { questions, stimuliById } = await this.readQuestionBank(client, options.dryRun);
      const { manifest, report } = validateAndDryRunManifest(raw, questions, Object.fromEntries(stimuliById));
      const result = batchId && manifest && report.valid && !options.dryRun
        ? await this.writeManifest(client, manifest, importedBy, batchId, { questions, stimuliById })
        : null;
      return { report, result, replayed: false };
    }, options.dryRun ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : undefined);
  }

  private async lockQuestionBank(client: PoolClient): Promise<void> {
    // Serialize version assignment with imports and other bank writers, even when the bank is empty.
    await client.query('LOCK TABLE stimuli, questions IN SHARE ROW EXCLUSIVE MODE');
  }

  private async readQuestionBank(client: PoolClient, allowUninitialized = false) {
    if (allowUninitialized) {
      const { rows } = await client.query("SELECT to_regclass('questions') AS questions");
      if (!rows[0].questions) {
        return { questions: [], stimuliById: new Map<string, StimulusGroup>() };
      }
    }
    const stimuli = await client.query<{ stimulus_id: string; data: StimulusGroup }>(
      'SELECT stimulus_id, data FROM stimuli'
    );
    const questions = await client.query<{ data: QuestionItem }>('SELECT data FROM questions');
    return {
      questions: questions.rows.map((row) => row.data),
      stimuliById: new Map(stimuli.rows.map((row) => [row.stimulus_id, row.data])),
    };
  }

  private async findManifestImport(client: PoolClient, batchId: string): Promise<ManifestImportResult | null> {
    const previous = await client.query<{ data: ImportBatchRecord }>(
      'SELECT data FROM import_batches WHERE batch_id = $1',
      [batchId]
    );
    return previous.rows[0] ? manifestImportResult(previous.rows[0].data, true) : null;
  }

  private async writeManifest(
    client: PoolClient,
    manifest: BankImportManifest,
    importedBy: string,
    batchId: string,
    bank?: Awaited<ReturnType<PostgresRepository['readQuestionBank']>>
  ): Promise<ManifestImportResult> {
    const nowIso = new Date().toISOString();
    const newQuestionIds: string[] = [];
    const versionBumpedQuestionIds: string[] = [];
    const skippedQuestionIds: string[] = [];
    const { questions, stimuliById } = bank ?? await this.readQuestionBank(client);
    const stimulusWrites: StimulusGroup[] = [];
    for (const s of manifest.stimuli || []) {
      const hash =
        s.contentHash ||
        computeCanonicalHash({
          title: s.title,
          preamble: s.preamble,
          mainTextMarkdown: s.mainTextMarkdown,
          extracts: s.extracts,
          visual: s.visual,
        });
      const payload: StimulusGroup = {
        ...s,
        contentHash: hash,
        batchId: s.batchId || batchId,
        createdAtIso: stimuliById.get(s.stimulusId)?.createdAtIso || s.createdAtIso || nowIso,
        updatedAtIso: nowIso,
      };
      stimuliById.set(s.stimulusId, payload);
      stimulusWrites.push(payload);
    }

    const latestByFamily = new Map(selectLatestByFamily(questions).map((q) => [q.questionFamilyId, q]));
    const existingIds = new Set(questions.map((q) => q.questionId));
    const questionWrites: QuestionItem[] = [];
    for (const rawQ of manifest.questions || []) {
      const q = structuredClone(rawQ);
      if (!q.poolType) q.poolType = manifest.defaultPoolType;
      if (!q.qcStatus) q.qcStatus = manifest.defaultQcStatus;
      q.contentHash ||=
        computeCanonicalHash({ parts: q.parts, stemPrefix: q.stemPrefix, visual: q.visual, writingSpec: q.writingSpec });
      const stim = q.stimulusId ? stimuliById.get(q.stimulusId) : undefined;

      const existing = latestByFamily.get(q.questionFamilyId);
      if (existing && existing.contentHash === q.contentHash && existing.version === q.version && existing.questionId === q.questionId) {
        skippedQuestionIds.push(q.questionId);
        continue;
      }
      if (existing) {
        const nextVersion = Math.max(existing.version + 1, q.version);
        if (nextVersion !== q.version || existingIds.has(q.questionId)) {
          q.questionId = `${q.questionFamilyId}_v${nextVersion}`;
        }
        q.version = nextVersion;
        q.createdAtIso = nowIso;
        q.evidenceRevision = computeEvidenceRevision(q, stim);
        versionBumpedQuestionIds.push(q.questionId);
      } else {
        q.createdAtIso ||= nowIso;
        q.evidenceRevision ||= computeEvidenceRevision(q, stim);
        newQuestionIds.push(q.questionId);
      }
      q.batchId ||= batchId;
      q.batchLabel ||= manifest.batchLabel;
      q.updatedAtIso = nowIso;
      latestByFamily.set(q.questionFamilyId, q);
      existingIds.add(q.questionId);
      questionWrites.push(q);
    }

    if (stimulusWrites.length) {
      await client.query(
        `INSERT INTO stimuli (stimulus_id, stimulus_family_id, version, content_hash, section, data)
         SELECT data->>'stimulusId', data->>'stimulusFamilyId', (data->>'version')::int,
                data->>'contentHash', data->>'section', data
         FROM jsonb_array_elements($1::jsonb) AS item(data)
         ON CONFLICT (stimulus_id) DO UPDATE SET
           stimulus_family_id = EXCLUDED.stimulus_family_id, version = EXCLUDED.version,
           content_hash = EXCLUDED.content_hash, section = EXCLUDED.section, data = EXCLUDED.data`,
        [JSON.stringify(stimulusWrites)]
      );
    }
    if (questionWrites.length) {
      await client.query(
        `INSERT INTO questions (question_id, question_family_id, version, content_hash, section, format_type, pool_type, qc_status, stimulus_id, data)
         SELECT data->>'questionId', data->>'questionFamilyId', (data->>'version')::int, data->>'contentHash',
                data->>'section', data->>'formatType', data->>'poolType', data->>'qcStatus', NULLIF(data->>'stimulusId', ''), data
         FROM jsonb_array_elements($1::jsonb) AS item(data)`,
        [JSON.stringify(questionWrites)]
      );
    }

    const batch: ImportBatchRecord = {
      batchId,
      batchLabel: manifest.batchLabel,
      createdAtIso: nowIso,
      importedBy,
      stimuliCount: (manifest.stimuli || []).length,
      questionsCount: (manifest.questions || []).length,
      newQuestionIds,
      versionBumpedQuestionIds,
      skippedQuestionIds,
    };
    await client.query(
      'INSERT INTO import_batches (batch_id, batch_label, data, created_at) VALUES ($1, $2, $3, $4)',
      [batch.batchId, batch.batchLabel || null, JSON.stringify(batch), nowIso]
    );

    return manifestImportResult(batch, false);
  }

  async listImportBatches(): Promise<ImportBatchRecord[]> {
    await this.ensureSchema();
    const { rows } = await this.pool.query('SELECT data FROM import_batches ORDER BY created_at DESC');
    return rows.map((r) => r.data as ImportBatchRecord);
  }

  async getImportBatch(batchId: string): Promise<ImportBatchRecord | null> {
    await this.ensureSchema();
    const { rows } = await this.pool.query('SELECT data FROM import_batches WHERE batch_id = $1', [batchId]);
    return rows.length ? (rows[0].data as ImportBatchRecord) : null;
  }

  async updateQuestionStatus(questionId: string, qcStatus: QuestionItem['qcStatus']): Promise<void> {
    await this.ensureSchema();
    const { rowCount } = await this.pool.query(
      `UPDATE questions SET qc_status = $2, data = data || $3::jsonb WHERE question_id = $1`,
      [questionId, qcStatus, JSON.stringify({ qcStatus, updatedAtIso: new Date().toISOString() })]
    );
    if (!rowCount) throw new NotFoundError(`Question ${questionId} not found.`);
  }

  async deleteQuestions(questionIds: string[]): Promise<number> {
    await this.ensureSchema();
    const { rowCount } = await this.pool.query('DELETE FROM questions WHERE question_id = ANY($1::text[])', [questionIds]);
    return rowCount ?? 0;
  }

  async updateQuestionVisual(questionId: string, visual: VisualSpec): Promise<void> {
    const bankItem = await this.getQuestionWithStimulus(questionId);
    if (!bankItem) throw new NotFoundError(`Question ${questionId} not found.`);
    const { question, stimulus } = bankItem;
    const { rowCount } = await this.pool.query(
      'UPDATE questions SET data = data || $2::jsonb WHERE question_id = $1',
      [questionId, JSON.stringify({
        visual,
        updatedAtIso: new Date().toISOString(),
        evidenceRevision: computeEvidenceRevision({ ...question, visual }, stimulus),
      })]
    );
    if (!rowCount) throw new NotFoundError(`Question ${questionId} not found.`);
  }

  async getActiveConfig(): Promise<{ configVersionId: string; versionNumber: number; config: LearningConfig }> {
    await this.ensureSchema();
    const { rows } = await this.pool.query(
      'SELECT config_version_id, version_number, config FROM admin_config_versions ORDER BY version_number DESC LIMIT 1'
    );
    if (rows.length === 0) {
      return { configVersionId: 'cfg_v1', versionNumber: 1, config: structuredClone(DEFAULT_LEARNING_CONFIG) };
    }
    const rawCfg = rows[0].config as LearningConfig;
    return {
      configVersionId: rows[0].config_version_id,
      versionNumber: rows[0].version_number,
      config: {
        ...structuredClone(DEFAULT_LEARNING_CONFIG),
        ...rawCfg,
        sessionDefaults: {
          ...DEFAULT_LEARNING_CONFIG.sessionDefaults,
          ...rawCfg.sessionDefaults,
          dailyQuestionLimitBySection: {
            ...DEFAULT_LEARNING_CONFIG.sessionDefaults.dailyQuestionLimitBySection,
            ...(rawCfg.sessionDefaults?.dailyQuestionLimitBySection || {}),
          },
        },
      },
    };
  }

  async listConfigVersions() {
    await this.ensureSchema();
    const { rows } = await this.pool.query(
      'SELECT config_version_id, version_number, notes, created_at, config FROM admin_config_versions ORDER BY version_number DESC'
    );
    return rows.map((r) => ({
      configVersionId: r.config_version_id as string,
      versionNumber: r.version_number as number,
      notes: (r.notes as string) || undefined,
      createdAt: new Date(r.created_at).toISOString(),
      config: r.config as LearningConfig,
    }));
  }

  async saveConfigVersion(
    config: LearningConfig,
    notes?: string
  ): Promise<{ configVersionId: string; versionNumber: number }> {
    await this.ensureSchema();
    return this.transaction(async (client) => {
      await client.query('LOCK TABLE admin_config_versions IN SHARE ROW EXCLUSIVE MODE');
      const { rows } = await client.query('SELECT COALESCE(MAX(version_number), 1) + 1 AS next FROM admin_config_versions');
      const versionNumber = rows[0].next as number;
      const configVersionId = `cfg_v${versionNumber}_${crypto.randomUUID().slice(0, 6)}`;
      await client.query(
        'INSERT INTO admin_config_versions (config_version_id, version_number, notes, config) VALUES ($1, $2, $3, $4)',
        [configVersionId, versionNumber, notes || null, JSON.stringify(config)]
      );
      return { configVersionId, versionNumber };
    });
  }

  async createSession(session: SessionRecord, snapshots: SessionQuestionSnapshot[] = []): Promise<void> {
    await this.ensureSchema();
    const studentId = session.studentId || DEFAULT_STUDENT_ID;
    await this.transaction(async (client) => {
      await this.lockStudentProgress(client, studentId);
      await this.insertSession(client, session, snapshots, studentId);
    });
  }

  private async lockStudentProgress(client: PoolClient, studentId: string): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('selective_lab_progress'), hashtext($1))", [studentId]);
  }

  private async insertSession(
    client: PoolClient,
    session: SessionRecord,
    snapshots: SessionQuestionSnapshot[],
    studentId: string
  ): Promise<void> {
    const stored: SessionRecord = {
      ...session,
      studentId,
      checkpointRevision: session.checkpointRevision ?? 1,
    };
    await client.query(
      `INSERT INTO sessions (session_id, student_id, mode, status, is_sandbox, data, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [stored.sessionId, studentId, stored.mode, stored.status, Boolean(stored.isSandbox), JSON.stringify(stored),
        stored.startedAt, stored.completedAt ?? null]
    );
    if (snapshots.length > 0) {
      await client.query(
        'INSERT INTO session_snapshots (session_id, student_id, snapshots) VALUES ($1, $2, $3) ON CONFLICT (session_id) DO NOTHING',
        [stored.sessionId, studentId, JSON.stringify(snapshots)]
      );
    }
  }

  async reserveAndCreateSession(
    session: SessionRecord,
    snapshots: SessionQuestionSnapshot[] = []
  ): Promise<ReserveSessionResult> {
    await this.ensureSchema();
    const studentId = session.studentId || DEFAULT_STUDENT_ID;
    return this.transaction(async (client) => {
      // A row lock cannot reserve an account that has no session yet.
      await this.lockStudentProgress(client, studentId);
      if (!session.isSandbox) {
        const { rows } = await client.query(
          `SELECT data FROM sessions WHERE student_id = $1 AND status = 'in_progress' AND is_sandbox = FALSE
           ORDER BY started_at DESC LIMIT 1`,
          [studentId]
        );
        if (rows.length > 0) {
          const conflict = rows[0].data as SessionRecord;
          return { created: false, conflictSessionId: conflict.sessionId, conflictSession: conflict };
        }
      }
      await this.insertSession(client, session, snapshots, studentId);
      return { created: true };
    });
  }

  async getSession(sessionId: string, studentId?: string): Promise<SessionRecord | null> {
    await this.ensureSchema();
    const { rows } = await this.pool.query('SELECT data FROM sessions WHERE session_id = $1', [sessionId]);
    if (rows.length === 0) return null;
    const session = rows[0].data as SessionRecord;
    if (studentId && (session.studentId || DEFAULT_STUDENT_ID) !== studentId) return null;
    return session;
  }

  async getSessionSnapshots(studentId: string, sessionId: string): Promise<SessionQuestionSnapshot[]> {
    await this.ensureSchema();
    const { rows } = await this.pool.query<{ snapshots: SessionQuestionSnapshot[] }>(
      'SELECT snapshots FROM session_snapshots WHERE session_id = $1 AND student_id = $2',
      [sessionId, studentId || DEFAULT_STUDENT_ID]
    );
    return rows[0]?.snapshots.sort((a, b) => a.snapshotIndex - b.snapshotIndex) ?? [];
  }

  async saveSessionCheckpoint(
    sessionId: string,
    studentId: string,
    checkpoint: SessionCheckpoint,
    expectedRevision?: number
  ): Promise<CheckpointSaveResult> {
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT data FROM sessions WHERE session_id = $1 FOR UPDATE', [sessionId]);
      if (rows.length === 0) throw new NotFoundError('Session not found.');
      const session = rows[0].data as SessionRecord;
      if ((session.studentId || DEFAULT_STUDENT_ID) !== studentId) {
        throw new ForbiddenError('Forbidden: session belongs to another user.');
      }
      if (session.status !== 'in_progress') {
        throw new RevisionConflictError('Session already submitted.', session.checkpointRevision ?? 1, session.checkpoint);
      }
      const currentRev = session.checkpointRevision ?? 1;
      if (expectedRevision !== undefined && expectedRevision !== currentRev) {
        throw new RevisionConflictError(
          `Checkpoint revision conflict: expected v${expectedRevision}, current v${currentRev}.`,
          currentRev,
          session.checkpoint
        );
      }
      const nextRev = currentRev + 1;
      session.checkpoint = checkpoint;
      session.checkpointRevision = nextRev;
      await client.query('UPDATE sessions SET data = $2 WHERE session_id = $1', [sessionId, JSON.stringify(session)]);
      await client.query('COMMIT');
      return { checkpointRevision: nextRev, savedAtIso: new Date().toISOString() };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async completeSession(
    sessionId: string,
    summary: { correctSlots: number; totalSlots: number; completedAt: string },
    studentId?: string
  ): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `UPDATE sessions SET status = 'submitted', data = data || $2::jsonb, completed_at = $3
       WHERE session_id = $1 AND ($4::text IS NULL OR student_id = $4)`,
      [sessionId, JSON.stringify({ ...summary, status: 'submitted' }), summary.completedAt, studentId]
    );
  }

  async finalizeSessionAtomically(input: FinalizeSessionInput): Promise<FinalizeSessionResult> {
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lockStudentProgress(client, input.studentId);
      const { rows } = await client.query('SELECT data FROM sessions WHERE session_id = $1 FOR UPDATE', [
        input.sessionId,
      ]);
      if (rows.length === 0) throw new NotFoundError('Session not found.');
      const existing = rows[0].data as SessionRecord;
      if ((existing.studentId || DEFAULT_STUDENT_ID) !== input.studentId) {
        throw new ForbiddenError('Forbidden: cannot submit another user session.');
      }
      if (existing.status === 'submitted' && existing.submissionSummary) {
        await client.query('COMMIT');
        return {
          alreadySubmitted: true,
          session: existing,
          submissionSummary: existing.submissionSummary,
        };
      }

      for (const a of input.attempts) {
        await client.query(
          `INSERT INTO part_attempts (attempt_id, student_id, session_id, question_id, part_id, skill_id, is_correct, is_sandbox, data, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (attempt_id) DO NOTHING`,
          [
            a.attemptId,
            input.studentId,
            a.sessionId,
            a.questionId,
            a.partId,
            a.skillId,
            a.isCorrect,
            Boolean(a.isSandbox),
            JSON.stringify({ ...a, studentId: input.studentId }),
            a.createdAt,
          ]
        );
      }

      for (const s of input.skillStates) {
        await client.query(
          `INSERT INTO skill_states (student_id, skill_id, data) VALUES ($1, $2, $3)
           ON CONFLICT (student_id, skill_id) DO UPDATE SET data = EXCLUDED.data`,
          [input.studentId, s.skillId, JSON.stringify(s)]
        );
      }

      for (const m of input.questionMemory) {
        await client.query(
          `INSERT INTO question_memory (student_id, question_family_id, data) VALUES ($1, $2, $3)
           ON CONFLICT (student_id, question_family_id) DO UPDATE SET data = EXCLUDED.data`,
          [input.studentId, m.questionFamilyId, JSON.stringify(m)]
        );
      }

      for (const ev of input.evidenceUpdates) {
        await client.query(
          `INSERT INTO question_evidence (student_id, evidence_key, data) VALUES ($1, $2, $3)
           ON CONFLICT (student_id, evidence_key) DO UPDATE SET data = EXCLUDED.data`,
          [input.studentId, ev.evidenceKey, JSON.stringify(ev)]
        );
      }

      for (const sub of input.writingSubmissions) {
        await client.query(
          `INSERT INTO writing_submissions (submission_id, student_id, session_id, question_id, data, submitted_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (submission_id) DO NOTHING`,
          [
            sub.submissionId,
            input.studentId,
            sub.sessionId,
            sub.questionId,
            JSON.stringify({ ...sub, studentId: input.studentId }),
            sub.submittedAt,
          ]
        );
      }

      const nextRev = (existing.checkpointRevision ?? 1) + 1;
      const updatedSession: SessionRecord = {
        ...existing,
        status: 'submitted',
        expiredAutoSubmitted: Boolean(input.expiredAutoSubmitted || existing.expiredAutoSubmitted),
        checkpoint: input.checkpoint,
        checkpointRevision: nextRev,
        correctSlots: input.correctSlots,
        totalSlots: input.totalSlots,
        completedAt: input.completedAtIso,
        submissionSummary: input.submissionSummary,
      };
      await client.query(
        'UPDATE sessions SET status = $2, data = $3, completed_at = $4 WHERE session_id = $1',
        [input.sessionId, 'submitted', JSON.stringify(updatedSession), input.completedAtIso]
      );
      await client.query('COMMIT');
      return {
        alreadySubmitted: false,
        session: updatedSession,
        submissionSummary: input.submissionSummary,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async listSessions(limit = 50, studentId = DEFAULT_STUDENT_ID, includeSandbox = true): Promise<SessionRecord[]> {
    await this.ensureSchema();
    const { rows } = await this.pool.query(
      `SELECT data FROM sessions WHERE student_id = $1 AND ($2::boolean OR NOT is_sandbox)
       ORDER BY started_at DESC LIMIT $3`,
      [studentId, includeSandbox, limit]
    );
    return rows.map((r) => r.data as SessionRecord);
  }

  async appendPartAttempts(attempts: PartAttemptRecord[]): Promise<void> {
    await this.ensureSchema();
    for (const a of attempts) {
      const studentId = a.studentId || DEFAULT_STUDENT_ID;
      await this.pool.query(
        `INSERT INTO part_attempts (attempt_id, student_id, session_id, question_id, part_id, skill_id, is_correct, is_sandbox, data, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (attempt_id) DO NOTHING`,
        [a.attemptId, studentId, a.sessionId, a.questionId, a.partId, a.skillId, a.isCorrect, Boolean(a.isSandbox), JSON.stringify({ ...a, studentId }), a.createdAt]
      );
    }
  }

  async listPartAttempts(limit = 1000, studentId = DEFAULT_STUDENT_ID, includeSandbox = false): Promise<PartAttemptRecord[]> {
    await this.ensureSchema();
    const query = includeSandbox
      ? 'SELECT data FROM part_attempts WHERE student_id = $1 ORDER BY created_at DESC LIMIT $2'
      : 'SELECT data FROM part_attempts WHERE student_id = $1 AND is_sandbox = FALSE ORDER BY created_at DESC LIMIT $2';
    const { rows } = await this.pool.query(query, [studentId, limit]);
    return rows.map((r) => r.data as PartAttemptRecord);
  }

  async getQuestionEvidence(studentId: string): Promise<Record<string, QuestionMasteryEvidence>> {
    await this.ensureSchema();
    const { rows } = await this.pool.query(
      'SELECT evidence_key, data FROM question_evidence WHERE student_id = $1',
      [studentId]
    );
    const out: Record<string, QuestionMasteryEvidence> = {};
    for (const r of rows) out[r.evidence_key] = r.data as QuestionMasteryEvidence;
    return out;
  }

  async upsertQuestionEvidence(entries: QuestionMasteryEvidence[], studentId: string): Promise<void> {
    await this.ensureSchema();
    for (const ev of entries) {
      await this.pool.query(
        `INSERT INTO question_evidence (student_id, evidence_key, data) VALUES ($1, $2, $3)
         ON CONFLICT (student_id, evidence_key) DO UPDATE SET data = EXCLUDED.data`,
        [studentId, ev.evidenceKey, JSON.stringify(ev)]
      );
    }
  }

  async saveWritingSubmission(sub: WritingSubmissionRecord): Promise<void> {
    await this.ensureSchema();
    const studentId = sub.studentId || DEFAULT_STUDENT_ID;
    await this.transaction(async (client) => {
      await this.lockStudentProgress(client, studentId);
      await client.query(
        `INSERT INTO writing_submissions (submission_id, student_id, session_id, question_id, data, submitted_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (submission_id) DO NOTHING`,
        [sub.submissionId, studentId, sub.sessionId, sub.questionId, JSON.stringify({ ...sub, studentId }), sub.submittedAt]
      );
    });
  }

  async getWritingSubmission(
    submissionId: string,
    studentId?: string
  ): Promise<(WritingSubmissionRecord & { evaluations: WritingEvaluationRecord[] }) | null> {
    await this.ensureSchema();
    const subRes = await this.pool.query('SELECT data FROM writing_submissions WHERE submission_id = $1', [submissionId]);
    if (subRes.rows.length === 0) return null;
    const sub = subRes.rows[0].data as WritingSubmissionRecord;
    if (studentId && (sub.studentId || DEFAULT_STUDENT_ID) !== studentId) return null;
    const evalRes = await this.pool.query(
      'SELECT data FROM writing_evaluations WHERE submission_id = $1 ORDER BY created_at DESC',
      [submissionId]
    );
    return { ...sub, evaluations: evalRes.rows.map((r) => r.data as WritingEvaluationRecord) };
  }

  async listWritingSubmissions(studentId = DEFAULT_STUDENT_ID) {
    await this.ensureSchema();
    const subRes = await this.pool.query(
      'SELECT data FROM writing_submissions WHERE student_id = $1 ORDER BY submitted_at DESC',
      [studentId]
    );
    const evalRes = await this.pool.query(
      `SELECT e.submission_id, e.data FROM writing_evaluations e
       JOIN writing_submissions s ON s.submission_id = e.submission_id
       WHERE s.student_id = $1 ORDER BY e.created_at DESC`,
      [studentId]
    );
    const evalMap = new Map<string, WritingEvaluationRecord[]>();
    for (const row of evalRes.rows) {
      const list = evalMap.get(row.submission_id) || [];
      list.push(row.data as WritingEvaluationRecord);
      evalMap.set(row.submission_id, list);
    }
    return subRes.rows.map((r) => {
      const sub = r.data as WritingSubmissionRecord;
      return { ...sub, evaluations: evalMap.get(sub.submissionId) || [] };
    });
  }

  async saveWritingEvaluation(ev: WritingEvaluationRecord, studentId?: string): Promise<void> {
    await this.ensureSchema();
    await this.transaction(async (client) => {
      const owner = studentId ?? (await client.query<{ student_id: string }>(
        'SELECT student_id FROM writing_submissions WHERE submission_id = $1',
        [ev.submissionId]
      )).rows[0]?.student_id;
      if (!owner) throw new NotFoundError('Writing submission not found.');
      await this.lockStudentProgress(client, owner);
      const { rowCount } = await client.query(
        `INSERT INTO writing_evaluations (evaluation_id, submission_id, data, created_at)
         SELECT $1, submission_id, $3, $4 FROM writing_submissions WHERE submission_id = $2 AND student_id = $5
         ON CONFLICT (evaluation_id) DO UPDATE SET data = EXCLUDED.data
         WHERE writing_evaluations.submission_id = EXCLUDED.submission_id`,
        [ev.evaluationId, ev.submissionId, JSON.stringify(ev), ev.createdAt, owner]
      );
      if (!rowCount) throw new NotFoundError('Writing submission not found.');
    });
  }

  async getSkillStates(studentId = DEFAULT_STUDENT_ID): Promise<Record<string, SkillState>> {
    await this.ensureSchema();
    const { rows } = await this.pool.query('SELECT skill_id, data FROM skill_states WHERE student_id = $1', [studentId]);
    const out: Record<string, SkillState> = {};
    for (const r of rows) out[r.skill_id] = r.data as SkillState;
    return out;
  }

  async upsertSkillStates(states: SkillState[], studentId = DEFAULT_STUDENT_ID): Promise<void> {
    await this.ensureSchema();
    for (const s of states) {
      await this.pool.query(
        `INSERT INTO skill_states (student_id, skill_id, data) VALUES ($1, $2, $3)
         ON CONFLICT (student_id, skill_id) DO UPDATE SET data = EXCLUDED.data`,
        [studentId, s.skillId, JSON.stringify(s)]
      );
    }
  }

  async getQuestionMemory(studentId = DEFAULT_STUDENT_ID): Promise<Record<string, QuestionMemoryState>> {
    await this.ensureSchema();
    const { rows } = await this.pool.query(
      'SELECT question_family_id, data FROM question_memory WHERE student_id = $1',
      [studentId]
    );
    const out: Record<string, QuestionMemoryState> = {};
    for (const r of rows) out[r.question_family_id] = r.data as QuestionMemoryState;
    return out;
  }

  async upsertQuestionMemory(entries: QuestionMemoryState[], studentId = DEFAULT_STUDENT_ID): Promise<void> {
    await this.ensureSchema();
    for (const m of entries) {
      await this.pool.query(
        `INSERT INTO question_memory (student_id, question_family_id, data) VALUES ($1, $2, $3)
         ON CONFLICT (student_id, question_family_id) DO UPDATE SET data = EXCLUDED.data`,
        [studentId, m.questionFamilyId, JSON.stringify(m)]
      );
    }
  }

  async saveQuestionFlag(flag: QuestionFlagRecord): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      'INSERT INTO question_flags (flag_id, question_id, status, data, created_at) VALUES ($1, $2, $3, $4, $5)',
      [flag.flagId, flag.questionId, flag.status, JSON.stringify(flag), flag.createdAt]
    );
  }

  async listQuestionFlags(): Promise<QuestionFlagRecord[]> {
    await this.ensureSchema();
    const { rows } = await this.pool.query('SELECT data FROM question_flags ORDER BY created_at DESC');
    return rows.map((r) => r.data as QuestionFlagRecord);
  }

  async resolveQuestionFlag(flagId: string): Promise<void> {
    await this.ensureSchema();
    const { rows } = await this.pool.query('SELECT data FROM question_flags WHERE flag_id = $1', [flagId]);
    if (rows.length === 0) return;
    const flag = rows[0].data as QuestionFlagRecord;
    flag.status = 'resolved';
    await this.pool.query('UPDATE question_flags SET status = $2, data = $3 WHERE flag_id = $1', [
      flagId,
      'resolved',
      JSON.stringify(flag),
    ]);
  }

  async saveMediaAsset(asset: MediaAssetRecord): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `INSERT INTO media_assets (asset_id, data, created_at) VALUES ($1, $2, $3)
       ON CONFLICT (asset_id) DO UPDATE SET data = EXCLUDED.data`,
      [asset.assetId, JSON.stringify(asset), asset.createdAtIso]
    );
  }

  async getMediaAsset(assetId: string): Promise<MediaAssetRecord | null> {
    await this.ensureSchema();
    const { rows } = await this.pool.query('SELECT data FROM media_assets WHERE asset_id = $1', [assetId]);
    return rows.length ? (rows[0].data as MediaAssetRecord) : null;
  }

  async listMediaAssets(): Promise<MediaAssetRecord[]> {
    await this.ensureSchema();
    const { rows } = await this.pool.query('SELECT data FROM media_assets ORDER BY created_at DESC');
    return rows.map((r) => r.data as MediaAssetRecord);
  }

  async exportFullBackup(): Promise<CanonicalBackupBundle> {
    await this.ensureSchema();
    return this.transaction(async (client) => {
      const stimuliRes = await client.query<{ data: StimulusGroup }>(
        'SELECT data FROM stimuli ORDER BY stimulus_id ASC'
      );
      const questionsRes = await client.query<{ data: QuestionItem }>(
        'SELECT data FROM questions ORDER BY question_id ASC'
      );
      const batchesRes = await client.query<{ data: ImportBatchRecord }>(
        'SELECT data FROM import_batches ORDER BY created_at DESC, batch_id ASC'
      );
      const configsRes = await client.query<{
        config_version_id: string;
        version_number: number;
        notes: string | null;
        created_at: Date | string;
        config: LearningConfig;
      }>(
        'SELECT config_version_id, version_number, notes, created_at, config FROM admin_config_versions ORDER BY version_number DESC'
      );
      const mediaRes = await client.query<{ data: MediaAssetRecord }>(
        'SELECT data FROM media_assets ORDER BY created_at DESC, asset_id ASC'
      );
      const flagsRes = await client.query<{ data: QuestionFlagRecord }>(
        'SELECT data FROM question_flags ORDER BY created_at DESC, flag_id ASC'
      );
      const usersRes = await client.query<{
        uid: string;
        role: string;
        display_name: string;
        email: string | null;
      }>('SELECT uid, role, display_name, email FROM users ORDER BY uid ASC');
      const sessionsRes = await client.query<{ student_id: string; data: SessionRecord }>(
        'SELECT student_id, data FROM sessions ORDER BY started_at DESC, session_id ASC'
      );
      const snapsRes = await client.query<{
        session_id: string;
        student_id: string;
        snapshots: SessionQuestionSnapshot[];
      }>('SELECT session_id, student_id, snapshots FROM session_snapshots ORDER BY session_id ASC');
      const attemptsRes = await client.query<{ student_id: string; data: PartAttemptRecord }>(
        'SELECT student_id, data FROM part_attempts ORDER BY created_at DESC, attempt_id ASC'
      );
      const subsRes = await client.query<{ student_id: string; data: WritingSubmissionRecord }>(
        'SELECT student_id, data FROM writing_submissions ORDER BY submitted_at DESC, submission_id ASC'
      );
      const evalsRes = await client.query<{ submission_id: string; data: WritingEvaluationRecord }>(
        'SELECT submission_id, data FROM writing_evaluations ORDER BY created_at DESC, evaluation_id ASC'
      );
      const skillsRes = await client.query<{ student_id: string; data: SkillState }>(
        'SELECT student_id, data FROM skill_states ORDER BY student_id ASC, skill_id ASC'
      );
      const memRes = await client.query<{ student_id: string; data: QuestionMemoryState }>(
        'SELECT student_id, data FROM question_memory ORDER BY student_id ASC, question_family_id ASC'
      );
      const evRes = await client.query<{ student_id: string; data: QuestionMasteryEvidence }>(
        'SELECT student_id, data FROM question_evidence ORDER BY student_id ASC, evidence_key ASC'
      );
      const plansRes = await client.query<{ student_id: string; plan_date: string; data: DailyFocusPlan }>(
        'SELECT student_id, plan_date, data FROM daily_focus_plans ORDER BY student_id ASC, plan_date ASC'
      );

      const uids = new Set<string>();
      for (const r of usersRes.rows) uids.add(r.uid);
      for (const r of sessionsRes.rows) uids.add(r.student_id);
      for (const r of snapsRes.rows) uids.add(r.student_id);
      for (const r of attemptsRes.rows) uids.add(r.student_id);
      for (const r of subsRes.rows) uids.add(r.student_id);
      for (const r of skillsRes.rows) uids.add(r.student_id);
      for (const r of memRes.rows) uids.add(r.student_id);
      for (const r of evRes.rows) uids.add(r.student_id);
      for (const r of plansRes.rows) uids.add(r.student_id);

      const sessionsByUid = new Map<string, SessionRecord[]>();
      for (const r of sessionsRes.rows) {
        const list = sessionsByUid.get(r.student_id) || [];
        list.push(r.data);
        sessionsByUid.set(r.student_id, list);
      }
      const snapsBySessionId = new Map<string, SessionQuestionSnapshot[]>();
      const snapIdsByUid = new Map<string, string[]>();
      for (const r of snapsRes.rows) {
        snapsBySessionId.set(r.session_id, r.snapshots);
        const list = snapIdsByUid.get(r.student_id) || [];
        list.push(r.session_id);
        snapIdsByUid.set(r.student_id, list);
      }
      const attemptsByUid = new Map<string, PartAttemptRecord[]>();
      for (const r of attemptsRes.rows) {
        const list = attemptsByUid.get(r.student_id) || [];
        list.push(r.data);
        attemptsByUid.set(r.student_id, list);
      }
      const evalsBySub = new Map<string, WritingEvaluationRecord[]>();
      for (const r of evalsRes.rows) {
        const list = evalsBySub.get(r.submission_id) || [];
        list.push(r.data);
        evalsBySub.set(r.submission_id, list);
      }
      const subsByUid = new Map<string, (WritingSubmissionRecord & { evaluations: WritingEvaluationRecord[] })[]>();
      for (const r of subsRes.rows) {
        const list = subsByUid.get(r.student_id) || [];
        list.push({ ...r.data, evaluations: evalsBySub.get(r.data.submissionId) || [] });
        subsByUid.set(r.student_id, list);
      }
      const skillsByUid = new Map<string, SkillState[]>();
      for (const r of skillsRes.rows) {
        const list = skillsByUid.get(r.student_id) || [];
        list.push(r.data);
        skillsByUid.set(r.student_id, list);
      }
      const memByUid = new Map<string, QuestionMemoryState[]>();
      for (const r of memRes.rows) {
        const list = memByUid.get(r.student_id) || [];
        list.push(r.data);
        memByUid.set(r.student_id, list);
      }
      const evByUid = new Map<string, QuestionMasteryEvidence[]>();
      for (const r of evRes.rows) {
        const list = evByUid.get(r.student_id) || [];
        list.push(r.data);
        evByUid.set(r.student_id, list);
      }
      const plansByUid = new Map<string, DailyFocusPlan[]>();
      for (const r of plansRes.rows) {
        const list = plansByUid.get(r.student_id) || [];
        list.push(r.data);
        plansByUid.set(r.student_id, list);
      }

      const usersMeta = new Map(usersRes.rows.map((r) => [r.uid, r]));
      const users = Array.from(uids)
        .sort()
        .map((uid) => {
          const meta = usersMeta.get(uid);
          const sessions = sessionsByUid.get(uid) || [];
          const snapsObj: Record<string, SessionQuestionSnapshot[]> = {};
          for (const s of sessions) {
            snapsObj[s.sessionId] = snapsBySessionId.get(s.sessionId) || [];
          }
          for (const sid of snapIdsByUid.get(uid) || []) {
            if (!(sid in snapsObj)) {
              snapsObj[sid] = snapsBySessionId.get(sid) || [];
            }
          }
          return {
            uid,
            role: (meta?.role === 'admin' ? 'admin' : 'student') as 'student' | 'admin',
            displayName: String(meta?.display_name || uid),
            email: meta?.email ? String(meta.email) : undefined,
            sessions,
            sessionSnapshotsBySessionId: snapsObj,
            partAttempts: attemptsByUid.get(uid) || [],
            skillStates: skillsByUid.get(uid) || [],
            questionMemory: memByUid.get(uid) || [],
            questionEvidence: evByUid.get(uid) || [],
            writingSubmissions: subsByUid.get(uid) || [],
            dailyFocusPlans: plansByUid.get(uid) || [],
          };
        });

      const configs = configsRes.rows.map((r) => ({
        configVersionId: r.config_version_id,
        versionNumber: r.version_number,
        notes: r.notes || undefined,
        createdAt: new Date(r.created_at).toISOString(),
        config: r.config,
      }));

      return finalizeBackupBundle({
        exportedAtIso: new Date().toISOString(),
        backendName: this.backendName,
        stimuli: stimuliRes.rows.map((r) => r.data),
        questions: questionsRes.rows.map((r) => r.data),
        importBatches: batchesRes.rows.map((r) => r.data),
        configVersions: configs,
        mediaAssets: mediaRes.rows.map((r) => r.data),
        questionFlags: flagsRes.rows.map((r) => r.data),
        users,
      });
    }, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  }

  async restoreFullBackup(rawBundle: unknown, options: { dryRun: boolean }): Promise<BackupRestoreReport> {
    await this.ensureSchema();
    const validated = validateIncomingBackupBundle(rawBundle);
    if (!validated.valid || !validated.bundle) {
      return emptyRestoreReport(false, options.dryRun, validated.checksumVerified, validated.errors, validated.warnings);
    }
    const bundle = validated.bundle;

    return this.transaction(async (client) => {
      if (!options.dryRun) {
        await client.query(
          `LOCK TABLE stimuli, questions, import_batches, admin_config_versions, media_assets, question_flags,
                      users, sessions, session_snapshots, part_attempts, skill_states, question_memory,
                      question_evidence, writing_submissions, writing_evaluations, daily_focus_plans
           IN SHARE ROW EXCLUSIVE MODE`
        );
      }

      const stimSet = new Set(
        (await client.query<{ stimulus_id: string }>('SELECT stimulus_id FROM stimuli')).rows.map((r) => r.stimulus_id)
      );
      const qSet = new Set(
        (await client.query<{ question_id: string }>('SELECT question_id FROM questions')).rows.map((r) => r.question_id)
      );
      const batchSet = new Set(
        (await client.query<{ batch_id: string }>('SELECT batch_id FROM import_batches')).rows.map((r) => r.batch_id)
      );
      const cfgSet = new Set(
        (await client.query<{ config_version_id: string }>('SELECT config_version_id FROM admin_config_versions')).rows.map(
          (r) => r.config_version_id
        )
      );
      const mediaSet = new Set(
        (await client.query<{ asset_id: string }>('SELECT asset_id FROM media_assets')).rows.map((r) => r.asset_id)
      );
      const flagSet = new Set(
        (await client.query<{ flag_id: string }>('SELECT flag_id FROM question_flags')).rows.map((r) => r.flag_id)
      );
      const userSet = new Set(
        (await client.query<{ uid: string }>('SELECT uid FROM users')).rows.map((r) => r.uid)
      );
      const sessSet = new Set(
        (await client.query<{ session_id: string }>('SELECT session_id FROM sessions')).rows.map((r) => r.session_id)
      );
      const attemptSet = new Set(
        (await client.query<{ attempt_id: string }>('SELECT attempt_id FROM part_attempts')).rows.map((r) => r.attempt_id)
      );
      const subSet = new Set(
        (await client.query<{ submission_id: string }>('SELECT submission_id FROM writing_submissions')).rows.map(
          (r) => r.submission_id
        )
      );
      const planSet = new Set(
        (await client.query<{ student_id: string; plan_date: string }>('SELECT student_id, plan_date FROM daily_focus_plans')).rows.map(
          (r) => `${r.student_id}::${r.plan_date}`
        )
      );

      const totalSessions = bundle.users.reduce((n, u) => n + u.sessions.length, 0);
      const totalAttempts = bundle.users.reduce((n, u) => n + u.partAttempts.length, 0);
      const totalSubs = bundle.users.reduce((n, u) => n + u.writingSubmissions.length, 0);
      const totalPlans = bundle.users.reduce((n, u) => n + (u.dailyFocusPlans?.length ?? 0), 0);

      const wouldCreate = {
        stimuli: bundle.stimuli.filter((s) => !stimSet.has(s.stimulusId)).length,
        questions: bundle.questions.filter((q) => !qSet.has(q.questionId)).length,
        importBatches: (bundle.importBatches || []).filter((b) => !batchSet.has(b.batchId)).length,
        configVersions: bundle.configVersions.filter((c) => !cfgSet.has(c.configVersionId)).length,
        mediaAssets: (bundle.mediaAssets || []).filter((m) => !mediaSet.has(m.assetId)).length,
        questionFlags: (bundle.questionFlags || []).filter((f) => !flagSet.has(f.flagId)).length,
        users: bundle.users.filter((u) => !userSet.has(u.uid)).length,
        sessions: bundle.users.reduce((n, u) => n + u.sessions.filter((s) => !sessSet.has(s.sessionId)).length, 0),
        attempts: bundle.users.reduce((n, u) => n + u.partAttempts.filter((a) => !attemptSet.has(a.attemptId)).length, 0),
        writingSubmissions: bundle.users.reduce(
          (n, u) => n + u.writingSubmissions.filter((ws) => !subSet.has(ws.submissionId)).length,
          0
        ),
        dailyFocusPlans: bundle.users.reduce(
          (n, u) => n + (u.dailyFocusPlans || []).filter((p) => !planSet.has(`${u.uid}::${p.planDate}`)).length,
          0
        ),
      };
      const wouldSkipExisting = {
        stimuli: bundle.stimuli.length - wouldCreate.stimuli,
        questions: bundle.questions.length - wouldCreate.questions,
        importBatches: (bundle.importBatches || []).length - wouldCreate.importBatches,
        configVersions: bundle.configVersions.length - wouldCreate.configVersions,
        mediaAssets: (bundle.mediaAssets || []).length - wouldCreate.mediaAssets,
        questionFlags: (bundle.questionFlags || []).length - wouldCreate.questionFlags,
        users: bundle.users.length - wouldCreate.users,
        sessions: totalSessions - wouldCreate.sessions,
        attempts: totalAttempts - wouldCreate.attempts,
        writingSubmissions: totalSubs - wouldCreate.writingSubmissions,
        dailyFocusPlans: totalPlans - wouldCreate.dailyFocusPlans,
      };

      if (options.dryRun) {
        return {
          valid: true,
          dryRun: true,
          checksumVerified: true,
          errors: [],
          warnings: validated.warnings,
          wouldCreate,
          wouldSkipExisting,
          applied: {},
        };
      }

      const applied = {
        stimuli: 0,
        questions: 0,
        importBatches: 0,
        configVersions: 0,
        mediaAssets: 0,
        questionFlags: 0,
        users: 0,
        sessions: 0,
        attempts: 0,
        skillStates: 0,
        questionMemory: 0,
        evidence: 0,
        writingSubmissions: 0,
        writingEvaluations: 0,
        dailyFocusPlans: 0,
      };

      for (const s of bundle.stimuli) {
        const res = await client.query(
          `INSERT INTO stimuli (stimulus_id, stimulus_family_id, version, content_hash, section, data, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, NOW()))
           ON CONFLICT (stimulus_id) DO NOTHING`,
          [s.stimulusId, s.stimulusFamilyId, s.version, s.contentHash || null, s.section, JSON.stringify(s), s.createdAtIso || null]
        );
        applied.stimuli += res.rowCount ?? 0;
      }
      for (const q of bundle.questions) {
        const res = await client.query(
          `INSERT INTO questions (question_id, question_family_id, version, content_hash, section, format_type, pool_type, qc_status, stimulus_id, data, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11::timestamptz, NOW()))
           ON CONFLICT (question_id) DO NOTHING`,
          [
            q.questionId,
            q.questionFamilyId,
            q.version,
            q.contentHash || null,
            q.section,
            q.formatType,
            q.poolType,
            q.qcStatus,
            q.stimulusId || null,
            JSON.stringify(q),
            q.createdAtIso || null,
          ]
        );
        applied.questions += res.rowCount ?? 0;
      }
      for (const c of bundle.configVersions) {
        const res = await client.query(
          `INSERT INTO admin_config_versions (config_version_id, version_number, notes, config, created_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (config_version_id) DO NOTHING`,
          [c.configVersionId, c.versionNumber, c.notes || null, JSON.stringify(c.config), c.createdAt]
        );
        applied.configVersions += res.rowCount ?? 0;
      }
      for (const b of bundle.importBatches || []) {
        const res = await client.query(
          `INSERT INTO import_batches (batch_id, batch_label, data, created_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (batch_id) DO NOTHING`,
          [b.batchId, b.batchLabel || null, JSON.stringify(b), b.createdAtIso]
        );
        applied.importBatches += res.rowCount ?? 0;
      }
      for (const m of bundle.mediaAssets || []) {
        const res = await client.query(
          `INSERT INTO media_assets (asset_id, data, created_at)
           VALUES ($1, $2, $3)
           ON CONFLICT (asset_id) DO NOTHING`,
          [m.assetId, JSON.stringify(m), m.createdAtIso]
        );
        applied.mediaAssets += res.rowCount ?? 0;
      }
      for (const f of bundle.questionFlags || []) {
        const res = await client.query(
          `INSERT INTO question_flags (flag_id, question_id, status, data, created_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (flag_id) DO NOTHING`,
          [f.flagId, f.questionId, f.status, JSON.stringify(f), f.createdAt]
        );
        applied.questionFlags += res.rowCount ?? 0;
      }
      for (const u of bundle.users) {
        // The backup cannot grant privileges. A verified login will set the current role.
        const userRes = await client.query(
          `INSERT INTO users (uid, display_name, email) VALUES ($1, $2, $3) ON CONFLICT (uid) DO NOTHING`,
          [u.uid, u.displayName, u.email ?? null]
        );
        applied.users += userRes.rowCount ?? 0;

        const restoredSnapshotIds = new Set<string>();
        for (const s of u.sessions) {
          const stored: SessionRecord = {
            ...s,
            studentId: u.uid,
            checkpointRevision: s.checkpointRevision ?? 1,
          };
          const sRes = await client.query(
            `INSERT INTO sessions (session_id, student_id, mode, status, is_sandbox, data, started_at, completed_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (session_id) DO NOTHING`,
            [
              stored.sessionId,
              u.uid,
              stored.mode,
              stored.status,
              Boolean(stored.isSandbox),
              JSON.stringify(stored),
              stored.startedAt,
              stored.completedAt ?? null,
            ]
          );
          applied.sessions += sRes.rowCount ?? 0;

          const snapshots = u.sessionSnapshotsBySessionId?.[s.sessionId] || [];
          if (snapshots.length > 0) {
            await client.query(
              `INSERT INTO session_snapshots (session_id, student_id, snapshots)
               VALUES ($1, $2, $3)
               ON CONFLICT (session_id) DO NOTHING`,
              [stored.sessionId, u.uid, JSON.stringify(snapshots)]
            );
            restoredSnapshotIds.add(s.sessionId);
          }
        }
        for (const [sid, snapshots] of Object.entries(u.sessionSnapshotsBySessionId || {})) {
          if (!restoredSnapshotIds.has(sid) && Array.isArray(snapshots) && snapshots.length > 0) {
            await client.query(
              `INSERT INTO session_snapshots (session_id, student_id, snapshots)
               VALUES ($1, $2, $3)
               ON CONFLICT (session_id) DO NOTHING`,
              [sid, u.uid, JSON.stringify(snapshots)]
            );
          }
        }
        for (const a of u.partAttempts) {
          const res = await client.query(
            `INSERT INTO part_attempts (attempt_id, student_id, session_id, question_id, part_id, skill_id, is_correct, is_sandbox, data, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (attempt_id) DO NOTHING`,
            [
              a.attemptId,
              u.uid,
              a.sessionId,
              a.questionId,
              a.partId,
              a.skillId,
              a.isCorrect,
              Boolean(a.isSandbox),
              JSON.stringify({ ...a, studentId: u.uid }),
              a.createdAt,
            ]
          );
          applied.attempts += res.rowCount ?? 0;
        }
        for (const sk of u.skillStates) {
          const res = await client.query(
            `INSERT INTO skill_states (student_id, skill_id, data)
             VALUES ($1, $2, $3)
             ON CONFLICT (student_id, skill_id) DO NOTHING`,
            [u.uid, sk.skillId, JSON.stringify(sk)]
          );
          applied.skillStates += res.rowCount ?? 0;
        }
        for (const mem of u.questionMemory) {
          const res = await client.query(
            `INSERT INTO question_memory (student_id, question_family_id, data)
             VALUES ($1, $2, $3)
             ON CONFLICT (student_id, question_family_id) DO NOTHING`,
            [u.uid, mem.questionFamilyId, JSON.stringify(mem)]
          );
          applied.questionMemory += res.rowCount ?? 0;
        }
        for (const ev of u.questionEvidence) {
          const res = await client.query(
            `INSERT INTO question_evidence (student_id, evidence_key, data)
             VALUES ($1, $2, $3)
             ON CONFLICT (student_id, evidence_key) DO NOTHING`,
            [u.uid, ev.evidenceKey, JSON.stringify(ev)]
          );
          applied.evidence += res.rowCount ?? 0;
        }
        for (const ws of u.writingSubmissions) {
          const { evaluations: evs, ...rest } = ws;
          const wsRes = await client.query(
            `INSERT INTO writing_submissions (submission_id, student_id, session_id, question_id, data, submitted_at)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (submission_id) DO NOTHING`,
            [rest.submissionId, u.uid, rest.sessionId, rest.questionId, JSON.stringify({ ...rest, studentId: u.uid }), rest.submittedAt]
          );
          applied.writingSubmissions += wsRes.rowCount ?? 0;
          for (const ev of evs || []) {
            const evRes = await client.query(
              `INSERT INTO writing_evaluations (evaluation_id, submission_id, data, created_at)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (evaluation_id) DO NOTHING`,
              [ev.evaluationId, ev.submissionId, JSON.stringify(ev), ev.createdAt]
            );
            applied.writingEvaluations += evRes.rowCount ?? 0;
          }
        }
        for (const plan of u.dailyFocusPlans || []) {
          const pRes = await client.query(
            `INSERT INTO daily_focus_plans (student_id, plan_date, data)
             VALUES ($1, $2, $3)
             ON CONFLICT (student_id, plan_date) DO NOTHING`,
            [u.uid, plan.planDate, JSON.stringify({ ...plan, studentId: u.uid })]
          );
          applied.dailyFocusPlans += pRes.rowCount ?? 0;
        }
      }

      return {
        valid: true,
        dryRun: false,
        checksumVerified: true,
        errors: [],
        warnings: validated.warnings,
        wouldCreate,
        wouldSkipExisting,
        applied,
      };
    }, options.dryRun ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : undefined);
  }

  async runMigrationPreflight(uploadsDir = 'public/assets/uploads'): Promise<MigrationPreflightReport> {
    await this.ensureSchema();
    const [qRes, sRes, sessRes, snapRes, attRes, mediaAssets] = await Promise.all([
      this.pool.query('SELECT data FROM questions'),
      this.pool.query('SELECT data FROM stimuli'),
      this.pool.query('SELECT session_id FROM sessions'),
      this.pool.query('SELECT session_id FROM session_snapshots'),
      this.pool.query('SELECT data FROM part_attempts'),
      this.listMediaAssets(),
    ]);
    const questions = qRes.rows.map((r) => r.data as QuestionItem);
    const stimuli = sRes.rows.map((r) => r.data as StimulusGroup);
    const snapIds = new Set(snapRes.rows.map((r) => r.session_id as string));
    const attempts = attRes.rows.map((r) => r.data as PartAttemptRecord);

    const mediaManifest = await buildMediaMigrationManifest({
      questions,
      stimuli,
      mediaAssets,
      uploadsDir,
    });

    return {
      checkedAtIso: new Date().toISOString(),
      backendName: this.backendName,
      totalQuestions: questions.length,
      totalSessions: sessRes.rows.length,
      totalPartAttempts: attempts.length,
      sessionsMissingSnapshots: sessRes.rows.filter((r) => !snapIds.has(r.session_id as string)).length,
      attemptsMissingEvidenceRevision: attempts.filter((a) => !a.evidenceRevision).length,
      questionsMissingEvidenceRevision: questions.filter((q) => !q.evidenceRevision).length,
      legacyUntaggedAttempts: attempts.filter((a) => a.isLegacy).length,
      mediaNeedsUploadCount: mediaManifest.needsUploadCount,
      mediaMissingFilesCount: mediaManifest.missingFilesCount,
    };
  }

  async getDailyFocusPlan(studentId: string, planDate: string): Promise<DailyFocusPlan | null> {
    await this.ensureSchema();
    const { rows } = await this.pool.query(
      'SELECT data FROM daily_focus_plans WHERE student_id = $1 AND plan_date = $2',
      [studentId || DEFAULT_STUDENT_ID, planDate]
    );
    return rows.length ? (rows[0].data as DailyFocusPlan) : null;
  }

  async saveDailyFocusPlan(studentId: string, plan: DailyFocusPlan): Promise<void> {
    await this.ensureSchema();
    const sid = studentId || DEFAULT_STUDENT_ID;
    await this.pool.query(
      `INSERT INTO daily_focus_plans (student_id, plan_date, data)
       VALUES ($1, $2, $3)
       ON CONFLICT (student_id, plan_date) DO UPDATE SET data = EXCLUDED.data`,
      [sid, plan.planDate, JSON.stringify(plan)]
    );
  }
}
