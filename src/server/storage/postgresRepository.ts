import crypto from 'node:crypto';
import { Pool } from 'pg';
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
import { getBootstrappedAdminEmail } from '../firebaseVerify.ts';
import { computeCanonicalHash } from '../manifestValidator.ts';
import { buildMediaMigrationManifest } from '../mediaService.ts';
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

function getOrCreatePgPool(): Pool {
  if (!global._nswSelectivePgPool) {
    global._nswSelectivePgPool = new Pool({
      host: process.env.SQL_HOST,
      user: process.env.SQL_USER,
      password: process.env.SQL_PASSWORD,
      database: process.env.SQL_DB_NAME,
      max: 10,
      connectionTimeoutMillis: 15000,
    });
    global._nswSelectivePgPool.on('error', (err) => {
      console.error('Unexpected error on idle SQL pool client:', err);
    });
  }
  return global._nswSelectivePgPool;
}

export class PostgresRepository implements AppRepository {
  readonly backendName = 'cloudsql_postgres' as const;
  private pool: Pool;
  private schemaReadyPromise: Promise<void> | null = null;

  constructor() {
    this.pool = getOrCreatePgPool();
  }

  private async ensureSchema(): Promise<void> {
    if (!this.schemaReadyPromise) {
      this.schemaReadyPromise = this.runSchemaInit().catch((err) => {
        this.schemaReadyPromise = null;
        throw err;
      });
    }
    await this.schemaReadyPromise;
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
    `;
    try {
      await this.pool.query(ddl);
      const { rows } = await this.pool.query('SELECT COUNT(*)::int AS cnt FROM admin_config_versions');
      if (rows[0]?.cnt === 0) {
        await this.pool.query(
          'INSERT INTO admin_config_versions (config_version_id, version_number, notes, config) VALUES ($1, $2, $3, $4)',
          ['cfg_v1', 1, 'Default Selective Lab Learning Config', JSON.stringify(DEFAULT_LEARNING_CONFIG)]
        );
      }
    } catch (error) {
      console.error('Database schema initialization failed:', error);
      throw new Error('Database initialization failed. Please try again later.', { cause: error });
    }
  }

  async initAndSeedIfEmpty(seedManifest: BankImportManifest): Promise<void> {
    await this.ensureSchema();
    const { rows } = await this.pool.query('SELECT COUNT(*)::int AS cnt FROM questions');
    if (rows[0]?.cnt === 0) {
      await this.importManifest(seedManifest, 'system_seed');
    }
  }

  async upsertUserFromAuth(input: {
    uid: string;
    email: string;
    displayName?: string;
    isBootstrappedAdmin: boolean;
  }): Promise<{ role: 'student' | 'admin' }> {
    await this.ensureSchema();
    const { rows } = await this.pool.query('SELECT role FROM users WHERE uid = $1', [input.uid]);
    const isAdmin =
      input.isBootstrappedAdmin ||
      input.email.toLowerCase() === getBootstrappedAdminEmail().toLowerCase() ||
      rows[0]?.role === 'admin';
    const role: 'student' | 'admin' = isAdmin ? 'admin' : 'student';
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
    const { rows } = await this.pool.query(
      'SELECT data FROM questions WHERE question_family_id = $1 ORDER BY version DESC',
      [questionFamilyId]
    );
    const qs = rows.map((r) => r.data as QuestionItem);
    const stimMap = await this.listStimuliByIds(
      qs.map((q) => q.stimulusId).filter((id): id is string => Boolean(id))
    );
    return qs.map((q) => ({
      question: q,
      stimulus: q.stimulusId ? stimMap[q.stimulusId] : undefined,
    }));
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
    const qRes = await this.pool.query('SELECT data FROM questions WHERE question_id = $1', [questionId]);
    if (qRes.rows.length === 0) return null;
    const question = qRes.rows[0].data as QuestionItem;
    let stimulus: StimulusGroup | undefined;
    if (question.stimulusId) {
      const sRes = await this.pool.query('SELECT data FROM stimuli WHERE stimulus_id = $1', [question.stimulusId]);
      if (sRes.rows.length > 0) stimulus = sRes.rows[0].data as StimulusGroup;
    }
    return { question, stimulus };
  }

  async importManifest(
    manifest: BankImportManifest,
    importedBy = 'admin'
  ): Promise<{ imported: number; skipped: number; versionBumped: number; batch: ImportBatchRecord }> {
    await this.ensureSchema();
    const nowIso = new Date().toISOString();
    const batchId = `batch_${nowIso.slice(0, 10).replace(/-/g, '')}_${crypto.randomUUID().slice(0, 6)}`;
    let imported = 0;
    let skipped = 0;
    let versionBumped = 0;
    const newQuestionIds: string[] = [];
    const versionBumpedQuestionIds: string[] = [];
    const skippedQuestionIds: string[] = [];

    const stimMap = new Map<string, StimulusGroup>();
    const existingStimRows = await this.pool.query('SELECT stimulus_id, data FROM stimuli');
    for (const r of existingStimRows.rows) stimMap.set(r.stimulus_id, r.data as StimulusGroup);

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
        createdAtIso: s.createdAtIso || nowIso,
        updatedAtIso: nowIso,
      };
      stimMap.set(s.stimulusId, payload);
      await this.pool.query(
        `INSERT INTO stimuli (stimulus_id, stimulus_family_id, version, content_hash, section, data)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (stimulus_id) DO UPDATE SET data = EXCLUDED.data, content_hash = EXCLUDED.content_hash`,
        [s.stimulusId, s.stimulusFamilyId, s.version, hash, s.section, JSON.stringify(payload)]
      );
    }

    const existingRows = await this.pool.query('SELECT data FROM questions');
    const latestByFamily = new Map<string, QuestionItem>();
    const existingIds = new Set<string>();
    for (const r of existingRows.rows) {
      const eq = r.data as QuestionItem;
      existingIds.add(eq.questionId);
      const prev = latestByFamily.get(eq.questionFamilyId);
      if (!prev || eq.version > prev.version) latestByFamily.set(eq.questionFamilyId, eq);
    }

    for (const rawQ of manifest.questions || []) {
      const q = structuredClone(rawQ);
      if (!q.poolType) q.poolType = manifest.defaultPoolType;
      if (!q.qcStatus) q.qcStatus = manifest.defaultQcStatus;
      const hash =
        q.contentHash ||
        computeCanonicalHash({ parts: q.parts, stemPrefix: q.stemPrefix, visual: q.visual, writingSpec: q.writingSpec });
      q.contentHash = hash;
      const stim = q.stimulusId ? stimMap.get(q.stimulusId) : undefined;
      q.evidenceRevision = q.evidenceRevision || computeEvidenceRevision(q, stim);

      const existing = latestByFamily.get(q.questionFamilyId);
      if (!existing) {
        q.batchId = q.batchId || batchId;
        q.batchLabel = q.batchLabel || manifest.batchLabel;
        q.createdAtIso = q.createdAtIso || nowIso;
        q.updatedAtIso = nowIso;
        await this.pool.query(
          `INSERT INTO questions (question_id, question_family_id, version, content_hash, section, format_type, pool_type, qc_status, stimulus_id, data)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [q.questionId, q.questionFamilyId, q.version, hash, q.section, q.formatType, q.poolType, q.qcStatus, q.stimulusId || null, JSON.stringify(q)]
        );
        latestByFamily.set(q.questionFamilyId, q);
        existingIds.add(q.questionId);
        newQuestionIds.push(q.questionId);
        imported++;
      } else if (existing.contentHash === hash && existing.version === q.version && existing.questionId === q.questionId) {
        skippedQuestionIds.push(q.questionId);
        skipped++;
      } else {
        const nextVersion = Math.max(existing.version + 1, q.version);
        const bumpedId =
          nextVersion !== q.version || existingIds.has(q.questionId)
            ? `${q.questionFamilyId}_v${nextVersion}`
            : q.questionId;
        const bumpedQ: QuestionItem = {
          ...q,
          questionId: bumpedId,
          version: nextVersion,
          batchId: q.batchId || batchId,
          batchLabel: q.batchLabel || manifest.batchLabel,
          createdAtIso: nowIso,
          updatedAtIso: nowIso,
        };
        bumpedQ.evidenceRevision = computeEvidenceRevision(bumpedQ, stim);
        await this.pool.query(
          `INSERT INTO questions (question_id, question_family_id, version, content_hash, section, format_type, pool_type, qc_status, stimulus_id, data)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [bumpedQ.questionId, bumpedQ.questionFamilyId, bumpedQ.version, hash, bumpedQ.section, bumpedQ.formatType, bumpedQ.poolType, bumpedQ.qcStatus, bumpedQ.stimulusId || null, JSON.stringify(bumpedQ)]
        );
        latestByFamily.set(q.questionFamilyId, bumpedQ);
        existingIds.add(bumpedQ.questionId);
        versionBumpedQuestionIds.push(bumpedQ.questionId);
        versionBumped++;
      }
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
    await this.pool.query(
      'INSERT INTO import_batches (batch_id, batch_label, data, created_at) VALUES ($1, $2, $3, $4)',
      [batch.batchId, batch.batchLabel || null, JSON.stringify(batch), nowIso]
    );

    return { imported, skipped, versionBumped, batch };
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
    const { rows } = await this.pool.query('SELECT data FROM questions WHERE question_id = $1', [questionId]);
    if (rows.length === 0) throw new NotFoundError(`Question ${questionId} not found.`);
    const q = rows[0].data as QuestionItem;
    q.qcStatus = qcStatus;
    q.updatedAtIso = new Date().toISOString();
    await this.pool.query('UPDATE questions SET qc_status = $2, data = $3 WHERE question_id = $1', [
      questionId,
      qcStatus,
      JSON.stringify(q),
    ]);
  }

  async updateQuestionVisual(questionId: string, visual: VisualSpec): Promise<void> {
    await this.ensureSchema();
    const { rows } = await this.pool.query('SELECT data FROM questions WHERE question_id = $1', [questionId]);
    if (rows.length === 0) throw new NotFoundError(`Question ${questionId} not found.`);
    const q = rows[0].data as QuestionItem;
    q.visual = visual;
    q.updatedAtIso = new Date().toISOString();
    if (q.stimulusId) {
      const sRes = await this.pool.query('SELECT data FROM stimuli WHERE stimulus_id = $1', [q.stimulusId]);
      q.evidenceRevision = computeEvidenceRevision(q, sRes.rows[0]?.data as StimulusGroup | undefined);
    } else {
      q.evidenceRevision = computeEvidenceRevision(q, undefined);
    }
    await this.pool.query('UPDATE questions SET data = $2 WHERE question_id = $1', [questionId, JSON.stringify(q)]);
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
    const active = await this.getActiveConfig();
    const nextNum = active.versionNumber + 1;
    const configVersionId = `cfg_v${nextNum}_${crypto.randomUUID().slice(0, 6)}`;
    await this.pool.query(
      'INSERT INTO admin_config_versions (config_version_id, version_number, notes, config) VALUES ($1, $2, $3, $4)',
      [configVersionId, nextNum, notes || null, JSON.stringify(config)]
    );
    return { configVersionId, versionNumber: nextNum };
  }

  async createSession(session: SessionRecord, snapshots: SessionQuestionSnapshot[] = []): Promise<void> {
    await this.ensureSchema();
    const studentId = session.studentId || DEFAULT_STUDENT_ID;
    const stored: SessionRecord = {
      ...session,
      studentId,
      checkpointRevision: session.checkpointRevision ?? 1,
    };
    await this.pool.query(
      `INSERT INTO sessions (session_id, student_id, mode, status, is_sandbox, data, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [stored.sessionId, studentId, stored.mode, stored.status, Boolean(stored.isSandbox), JSON.stringify(stored), stored.startedAt]
    );
    if (snapshots.length > 0) {
      await this.pool.query(
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
    if (session.isSandbox) {
      await this.createSession(session, snapshots);
      return { created: true };
    }
    const studentId = session.studentId || DEFAULT_STUDENT_ID;
    const stored: SessionRecord = {
      ...session,
      studentId,
      checkpointRevision: session.checkpointRevision ?? 1,
    };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT data FROM sessions WHERE student_id = $1 AND status = 'in_progress' AND is_sandbox = FALSE LIMIT 1 FOR UPDATE`,
        [studentId]
      );
      if (rows.length > 0) {
        const conflict = rows[0].data as SessionRecord;
        await client.query('COMMIT');
        return {
          created: false,
          conflictSessionId: conflict.sessionId,
          conflictSession: conflict,
        };
      }
      await client.query(
        `INSERT INTO sessions (session_id, student_id, mode, status, is_sandbox, data, started_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [stored.sessionId, studentId, stored.mode, stored.status, false, JSON.stringify(stored), stored.startedAt]
      );
      if (snapshots.length > 0) {
        await client.query(
          'INSERT INTO session_snapshots (session_id, student_id, snapshots) VALUES ($1, $2, $3) ON CONFLICT (session_id) DO NOTHING',
          [stored.sessionId, studentId, JSON.stringify(snapshots)]
        );
      }
      await client.query('COMMIT');
      return { created: true };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async getSession(sessionId: string, studentId?: string): Promise<SessionRecord | null> {
    await this.ensureSchema();
    const { rows } = await this.pool.query('SELECT data FROM sessions WHERE session_id = $1', [sessionId]);
    if (rows.length === 0) return null;
    const session = rows[0].data as SessionRecord;
    if (studentId && (session.studentId || DEFAULT_STUDENT_ID) !== studentId) return null;
    return session;
  }

  async getSessionSnapshots(_studentId: string, sessionId: string): Promise<SessionQuestionSnapshot[]> {
    await this.ensureSchema();
    const { rows } = await this.pool.query('SELECT snapshots FROM session_snapshots WHERE session_id = $1', [sessionId]);
    return rows.length ? (rows[0].snapshots as SessionQuestionSnapshot[]) : [];
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
    summary: { correctSlots: number; totalSlots: number; completedAt: string }
  ): Promise<void> {
    await this.ensureSchema();
    const session = await this.getSession(sessionId);
    if (!session) return;
    session.status = 'submitted';
    session.correctSlots = summary.correctSlots;
    session.totalSlots = summary.totalSlots;
    session.completedAt = summary.completedAt;
    await this.pool.query('UPDATE sessions SET status = $2, data = $3, completed_at = $4 WHERE session_id = $1', [
      sessionId,
      'submitted',
      JSON.stringify(session),
      summary.completedAt,
    ]);
  }

  async finalizeSessionAtomically(input: FinalizeSessionInput): Promise<FinalizeSessionResult> {
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
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
      'SELECT data FROM sessions WHERE student_id = $1 ORDER BY started_at DESC LIMIT $2',
      [studentId, limit]
    );
    return rows
      .map((r) => r.data as SessionRecord)
      .filter((s) => (includeSandbox ? true : !s.isSandbox));
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
    await this.pool.query(
      `INSERT INTO writing_submissions (submission_id, student_id, session_id, question_id, data, submitted_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (submission_id) DO NOTHING`,
      [sub.submissionId, studentId, sub.sessionId, sub.questionId, JSON.stringify({ ...sub, studentId }), sub.submittedAt]
    );
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
    const evalRes = await this.pool.query('SELECT submission_id, data FROM writing_evaluations ORDER BY created_at DESC');
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

  async saveWritingEvaluation(ev: WritingEvaluationRecord): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      'INSERT INTO writing_evaluations (evaluation_id, submission_id, data, created_at) VALUES ($1, $2, $3, $4)',
      [ev.evaluationId, ev.submissionId, JSON.stringify(ev), ev.createdAt]
    );
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
    const [
      stimuliRes,
      questionsRes,
      batches,
      configs,
      mediaAssets,
      flags,
      usersRes,
      sessionsRes,
      snapsRes,
      attemptsRes,
      subsRes,
      evalsRes,
      skillsRes,
      memRes,
      evRes,
    ] = await Promise.all([
      this.pool.query('SELECT data FROM stimuli'),
      this.pool.query('SELECT data FROM questions'),
      this.listImportBatches(),
      this.listConfigVersions(),
      this.listMediaAssets(),
      this.listQuestionFlags(),
      this.pool.query('SELECT uid, role, display_name, email FROM users'),
      this.pool.query('SELECT student_id, data FROM sessions'),
      this.pool.query('SELECT session_id, snapshots FROM session_snapshots'),
      this.pool.query('SELECT student_id, data FROM part_attempts'),
      this.pool.query('SELECT student_id, data FROM writing_submissions'),
      this.pool.query('SELECT submission_id, data FROM writing_evaluations'),
      this.pool.query('SELECT student_id, data FROM skill_states'),
      this.pool.query('SELECT student_id, data FROM question_memory'),
      this.pool.query('SELECT student_id, data FROM question_evidence'),
    ]);

    const uids = new Set<string>(usersRes.rows.map((r) => r.uid as string));
    for (const r of sessionsRes.rows) uids.add(r.student_id as string);
    for (const r of attemptsRes.rows) uids.add(r.student_id as string);

    const snapsBySessionId = new Map<string, SessionQuestionSnapshot[]>();
    for (const r of snapsRes.rows) {
      snapsBySessionId.set(r.session_id as string, r.snapshots as SessionQuestionSnapshot[]);
    }
    const evalsBySub = new Map<string, WritingEvaluationRecord[]>();
    for (const r of evalsRes.rows) {
      const list = evalsBySub.get(r.submission_id as string) || [];
      list.push(r.data as WritingEvaluationRecord);
      evalsBySub.set(r.submission_id as string, list);
    }

    const usersMeta = new Map(usersRes.rows.map((r) => [r.uid as string, r]));
    const users = Array.from(uids)
      .sort()
      .map((uid) => {
        const meta = usersMeta.get(uid);
        const sessions = sessionsRes.rows
          .filter((r) => r.student_id === uid)
          .map((r) => r.data as SessionRecord);
        const snapsObj: Record<string, SessionQuestionSnapshot[]> = {};
        for (const s of sessions) {
          snapsObj[s.sessionId] = snapsBySessionId.get(s.sessionId) || [];
        }
        return {
          uid,
          role: ((meta?.role as string) === 'admin' ? 'admin' : 'student') as 'student' | 'admin',
          displayName: String(meta?.display_name || uid),
          email: meta?.email ? String(meta.email) : undefined,
          sessions,
          sessionSnapshotsBySessionId: snapsObj,
          partAttempts: attemptsRes.rows.filter((r) => r.student_id === uid).map((r) => r.data as PartAttemptRecord),
          skillStates: skillsRes.rows.filter((r) => r.student_id === uid).map((r) => r.data as SkillState),
          questionMemory: memRes.rows.filter((r) => r.student_id === uid).map((r) => r.data as QuestionMemoryState),
          questionEvidence: evRes.rows.filter((r) => r.student_id === uid).map((r) => r.data as QuestionMasteryEvidence),
          writingSubmissions: subsRes.rows
            .filter((r) => r.student_id === uid)
            .map((r) => {
              const sub = r.data as WritingSubmissionRecord;
              return { ...sub, evaluations: evalsBySub.get(sub.submissionId) || [] };
            }),
        };
      });

    return finalizeBackupBundle({
      exportedAtIso: new Date().toISOString(),
      backendName: this.backendName,
      stimuli: (stimuliRes.rows.map((r) => r.data as StimulusGroup)).sort((a, b) =>
        a.stimulusId.localeCompare(b.stimulusId)
      ),
      questions: (questionsRes.rows.map((r) => r.data as QuestionItem)).sort((a, b) =>
        a.questionId.localeCompare(b.questionId)
      ),
      importBatches: batches,
      configVersions: configs,
      mediaAssets,
      questionFlags: flags,
      users,
    });
  }

  async restoreFullBackup(rawBundle: unknown, options: { dryRun: boolean }): Promise<BackupRestoreReport> {
    await this.ensureSchema();
    const validated = validateIncomingBackupBundle(rawBundle);
    if (!validated.valid || !validated.bundle) {
      return emptyRestoreReport(false, options.dryRun, validated.checksumVerified, validated.errors, validated.warnings);
    }
    const bundle = validated.bundle;
    const [existingStims, existingQs, existingCfgs, existingSessions] = await Promise.all([
      this.pool.query('SELECT stimulus_id FROM stimuli'),
      this.pool.query('SELECT question_id FROM questions'),
      this.pool.query('SELECT config_version_id FROM admin_config_versions'),
      this.pool.query('SELECT session_id FROM sessions'),
    ]);
    const stimSet = new Set(existingStims.rows.map((r) => r.stimulus_id as string));
    const qSet = new Set(existingQs.rows.map((r) => r.question_id as string));
    const cfgSet = new Set(existingCfgs.rows.map((r) => r.config_version_id as string));
    const sessSet = new Set(existingSessions.rows.map((r) => r.session_id as string));

    const wouldCreate = {
      stimuli: bundle.stimuli.filter((s) => !stimSet.has(s.stimulusId)).length,
      questions: bundle.questions.filter((q) => !qSet.has(q.questionId)).length,
      configVersions: bundle.configVersions.filter((c) => !cfgSet.has(c.configVersionId)).length,
      sessions: bundle.users.reduce((n, u) => n + u.sessions.filter((s) => !sessSet.has(s.sessionId)).length, 0),
    };
    const wouldSkipExisting = {
      stimuli: bundle.stimuli.length - wouldCreate.stimuli,
      questions: bundle.questions.length - wouldCreate.questions,
      configVersions: bundle.configVersions.length - wouldCreate.configVersions,
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

    const applied = { stimuli: 0, questions: 0, configVersions: 0, sessions: 0, attempts: 0, evidence: 0 };
    for (const s of bundle.stimuli) {
      if (!stimSet.has(s.stimulusId)) {
        await this.pool.query(
          `INSERT INTO stimuli (stimulus_id, stimulus_family_id, version, content_hash, section, data)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
          [s.stimulusId, s.stimulusFamilyId, s.version, s.contentHash || null, s.section, JSON.stringify(s)]
        );
        applied.stimuli++;
      }
    }
    for (const q of bundle.questions) {
      if (!qSet.has(q.questionId)) {
        await this.pool.query(
          `INSERT INTO questions (question_id, question_family_id, version, content_hash, section, format_type, pool_type, qc_status, stimulus_id, data)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING`,
          [q.questionId, q.questionFamilyId, q.version, q.contentHash || null, q.section, q.formatType, q.poolType, q.qcStatus, q.stimulusId || null, JSON.stringify(q)]
        );
        applied.questions++;
      }
    }
    for (const c of bundle.configVersions) {
      if (!cfgSet.has(c.configVersionId)) {
        await this.pool.query(
          `INSERT INTO admin_config_versions (config_version_id, version_number, notes, config, created_at)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
          [c.configVersionId, c.versionNumber, c.notes || null, JSON.stringify(c.config), c.createdAt]
        );
        applied.configVersions++;
      }
    }
    for (const b of bundle.importBatches || []) {
      await this.pool.query(
        'INSERT INTO import_batches (batch_id, batch_label, data, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
        [b.batchId, b.batchLabel || null, JSON.stringify(b), b.createdAtIso]
      );
    }
    for (const m of bundle.mediaAssets || []) {
      await this.saveMediaAsset(m);
    }
    for (const f of bundle.questionFlags || []) {
      await this.pool.query(
        'INSERT INTO question_flags (flag_id, question_id, status, data, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
        [f.flagId, f.questionId, f.status, JSON.stringify(f), f.createdAt]
      );
    }
    for (const u of bundle.users) {
      await this.upsertUserFromAuth({
        uid: u.uid,
        email: u.email || `${u.uid}@local.invalid`,
        displayName: u.displayName,
        isBootstrappedAdmin: u.role === 'admin',
      });
      for (const s of u.sessions) {
        if (!sessSet.has(s.sessionId)) {
          await this.createSession(s, u.sessionSnapshotsBySessionId?.[s.sessionId] || []);
          applied.sessions++;
        }
      }
      await this.appendPartAttempts(u.partAttempts);
      applied.attempts += u.partAttempts.length;
      await this.upsertSkillStates(u.skillStates, u.uid);
      await this.upsertQuestionMemory(u.questionMemory, u.uid);
      await this.upsertQuestionEvidence(u.questionEvidence, u.uid);
      applied.evidence += u.questionEvidence.length;
      for (const ws of u.writingSubmissions) {
        const { evaluations: evs, ...rest } = ws;
        await this.saveWritingSubmission(rest);
        for (const ev of evs || []) {
          await this.pool.query(
            'INSERT INTO writing_evaluations (evaluation_id, submission_id, data, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
            [ev.evaluationId, ev.submissionId, JSON.stringify(ev), ev.createdAt]
          );
        }
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
