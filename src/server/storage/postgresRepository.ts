import crypto from 'node:crypto';
import { Pool } from 'pg';
import type {
  BankImportManifest,
  LearningConfig,
  PartAttemptRecord,
  QuestionFlagRecord,
  QuestionItem,
  QuestionMemoryState,
  SessionRecord,
  SkillState,
  StimulusGroup,
  VisualSpec,
  WritingEvaluationRecord,
} from '../../shared/contracts.ts';
import { DEFAULT_LEARNING_CONFIG } from '../../shared/contracts.ts';
import { computeCanonicalHash } from '../manifestValidator.ts';
import type { AppRepository, SyncHydratePayload, WritingSubmissionRecord } from './repository.ts';

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
      CREATE TABLE IF NOT EXISTS question_flags (
        flag_id TEXT PRIMARY KEY,
        question_id TEXT NOT NULL,
        status TEXT NOT NULL,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
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
    try {
      const { rows } = await this.pool.query('SELECT COUNT(*)::int AS cnt FROM questions');
      if (rows[0]?.cnt === 0) {
        await this.importManifest(seedManifest);
      }
    } catch (error) {
      console.error('Database seed check failed:', error);
      throw new Error('Database query failed. Please try again later.', { cause: error });
    }
  }

  async hydrateSyncData(studentId: string, payload: SyncHydratePayload): Promise<void> {
    await this.ensureSchema();
    const uid = studentId || DEFAULT_STUDENT_ID;
    try {
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
        if (ov.qcStatus) await this.updateQuestionStatus(ov.questionId, ov.qcStatus);
        if (ov.visual) await this.updateQuestionVisual(ov.questionId, ov.visual);
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
        await this.pool.query(
          `INSERT INTO part_attempts (attempt_id, student_id, session_id, question_id, part_id, skill_id, is_correct, is_sandbox, data, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (attempt_id) DO NOTHING`,
          [
            a.attemptId,
            uid,
            a.sessionId,
            a.questionId,
            a.partId,
            a.skillId,
            a.isCorrect,
            Boolean(a.isSandbox),
            JSON.stringify({ ...a, studentId: uid }),
            a.createdAt,
          ]
        );
      }

      if (payload.skillStates?.length) {
        await this.upsertSkillStates(payload.skillStates, uid);
      }
      if (payload.questionMemory?.length) {
        await this.upsertQuestionMemory(payload.questionMemory, uid);
      }

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
    } catch (error) {
      console.error('hydrateSyncData failed:', error);
      throw new Error('Database sync hydration failed. Please try again later.', { cause: error });
    }
  }

  async listQuestions(filter?: { section?: string; poolType?: string; qcStatus?: string }): Promise<QuestionItem[]> {
    await this.ensureSchema();
    try {
      const { rows } = await this.pool.query('SELECT data FROM questions');
      const latestByFamily = new Map<string, QuestionItem>();
      for (const row of rows) {
        const q = row.data as QuestionItem;
        const prev = latestByFamily.get(q.questionFamilyId);
        if (!prev || q.version > prev.version) {
          latestByFamily.set(q.questionFamilyId, q);
        }
      }
      return Array.from(latestByFamily.values()).filter((q) => {
        if (filter?.section && q.section !== filter.section) return false;
        if (filter?.poolType && q.poolType !== filter.poolType) return false;
        if (filter?.qcStatus && q.qcStatus !== filter.qcStatus) return false;
        return true;
      });
    } catch (error) {
      console.error('listQuestions failed:', error);
      throw new Error('Database query failed. Please try again later.', { cause: error });
    }
  }

  async getQuestionWithStimulus(questionId: string): Promise<{ question: QuestionItem; stimulus?: StimulusGroup } | null> {
    await this.ensureSchema();
    try {
      const qRes = await this.pool.query('SELECT data FROM questions WHERE question_id = $1', [questionId]);
      if (qRes.rows.length === 0) return null;
      const question = qRes.rows[0].data as QuestionItem;
      let stimulus: StimulusGroup | undefined;
      if (question.stimulusId) {
        const sRes = await this.pool.query('SELECT data FROM stimuli WHERE stimulus_id = $1', [question.stimulusId]);
        if (sRes.rows.length > 0) {
          stimulus = sRes.rows[0].data as StimulusGroup;
        }
      }
      return { question, stimulus };
    } catch (error) {
      console.error('getQuestionWithStimulus failed:', error);
      throw new Error('Database query failed. Please try again later.', { cause: error });
    }
  }

  async importManifest(manifest: BankImportManifest): Promise<{ imported: number; skipped: number; versionBumped: number }> {
    await this.ensureSchema();
    try {
      let imported = 0;
      let skipped = 0;
      let versionBumped = 0;

      for (const s of manifest.stimuli || []) {
        const hash = s.contentHash || computeCanonicalHash({ title: s.title, preamble: s.preamble, mainTextMarkdown: s.mainTextMarkdown, extracts: s.extracts, visual: s.visual });
        const payload = { ...s, contentHash: hash };
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
        if (!prev || eq.version > prev.version) {
          latestByFamily.set(eq.questionFamilyId, eq);
        }
      }

      for (const rawQ of manifest.questions || []) {
        const q = structuredClone(rawQ);
        if (!q.poolType) q.poolType = manifest.defaultPoolType;
        if (!q.qcStatus) q.qcStatus = manifest.defaultQcStatus;
        const hash = q.contentHash || computeCanonicalHash({ parts: q.parts, stemPrefix: q.stemPrefix, visual: q.visual, writingSpec: q.writingSpec });
        q.contentHash = hash;

        const existing = latestByFamily.get(q.questionFamilyId);
        if (!existing) {
          await this.pool.query(
            `INSERT INTO questions (question_id, question_family_id, version, content_hash, section, format_type, pool_type, qc_status, stimulus_id, data)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [q.questionId, q.questionFamilyId, q.version, hash, q.section, q.formatType, q.poolType, q.qcStatus, q.stimulusId || null, JSON.stringify(q)]
          );
          latestByFamily.set(q.questionFamilyId, q);
          existingIds.add(q.questionId);
          imported++;
        } else if (existing.contentHash === hash && existing.version === q.version && existing.questionId === q.questionId) {
          skipped++;
        } else {
          const nextVersion = Math.max(existing.version + 1, q.version);
          const bumpedId = nextVersion !== q.version || existingIds.has(q.questionId)
            ? `${q.questionFamilyId}_v${nextVersion}`
            : q.questionId;
          const bumpedQ: QuestionItem = { ...q, questionId: bumpedId, version: nextVersion };
          await this.pool.query(
            `INSERT INTO questions (question_id, question_family_id, version, content_hash, section, format_type, pool_type, qc_status, stimulus_id, data)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [bumpedQ.questionId, bumpedQ.questionFamilyId, bumpedQ.version, hash, bumpedQ.section, bumpedQ.formatType, bumpedQ.poolType, bumpedQ.qcStatus, bumpedQ.stimulusId || null, JSON.stringify(bumpedQ)]
          );
          latestByFamily.set(q.questionFamilyId, bumpedQ);
          existingIds.add(bumpedQ.questionId);
          versionBumped++;
        }
      }

      return { imported, skipped, versionBumped };
    } catch (error) {
      console.error('importManifest failed:', error);
      throw new Error('Database import failed. Please try again later.', { cause: error });
    }
  }

  async updateQuestionStatus(questionId: string, qcStatus: QuestionItem['qcStatus']): Promise<void> {
    await this.ensureSchema();
    try {
      const { rows } = await this.pool.query('SELECT data FROM questions WHERE question_id = $1', [questionId]);
      if (rows.length === 0) return;
      const q = rows[0].data as QuestionItem;
      q.qcStatus = qcStatus;
      await this.pool.query('UPDATE questions SET qc_status = $2, data = $3 WHERE question_id = $1', [
        questionId,
        qcStatus,
        JSON.stringify(q),
      ]);
    } catch (error) {
      console.error('updateQuestionStatus failed:', error);
      throw new Error('Database update failed. Please try again later.', { cause: error });
    }
  }

  async updateQuestionVisual(questionId: string, visual: VisualSpec): Promise<void> {
    await this.ensureSchema();
    try {
      const { rows } = await this.pool.query('SELECT data FROM questions WHERE question_id = $1', [questionId]);
      if (rows.length === 0) return;
      const q = rows[0].data as QuestionItem;
      q.visual = visual;
      await this.pool.query('UPDATE questions SET data = $2 WHERE question_id = $1', [questionId, JSON.stringify(q)]);
    } catch (error) {
      console.error('updateQuestionVisual failed:', error);
      throw new Error('Database update failed. Please try again later.', { cause: error });
    }
  }

  async getActiveConfig(): Promise<{ configVersionId: string; versionNumber: number; config: LearningConfig }> {
    await this.ensureSchema();
    try {
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
    } catch (error) {
      console.error('getActiveConfig failed:', error);
      throw new Error('Database query failed. Please try again later.', { cause: error });
    }
  }

  async listConfigVersions(): Promise<{ configVersionId: string; versionNumber: number; notes?: string; createdAt: string; config: LearningConfig }[]> {
    await this.ensureSchema();
    try {
      const { rows } = await this.pool.query(
        'SELECT config_version_id, version_number, notes, created_at, config FROM admin_config_versions ORDER BY version_number DESC'
      );
      return rows.map((r) => ({
        configVersionId: r.config_version_id,
        versionNumber: r.version_number,
        notes: r.notes || undefined,
        createdAt: new Date(r.created_at).toISOString(),
        config: r.config as LearningConfig,
      }));
    } catch (error) {
      console.error('listConfigVersions failed:', error);
      throw new Error('Database query failed. Please try again later.', { cause: error });
    }
  }

  async saveConfigVersion(config: LearningConfig, notes?: string): Promise<{ configVersionId: string; versionNumber: number }> {
    await this.ensureSchema();
    try {
      const active = await this.getActiveConfig();
      const nextNum = active.versionNumber + 1;
      const configVersionId = `cfg_v${nextNum}_${crypto.randomUUID().slice(0, 6)}`;
      await this.pool.query(
        'INSERT INTO admin_config_versions (config_version_id, version_number, notes, config) VALUES ($1, $2, $3, $4)',
        [configVersionId, nextNum, notes || null, JSON.stringify(config)]
      );
      return { configVersionId, versionNumber: nextNum };
    } catch (error) {
      console.error('saveConfigVersion failed:', error);
      throw new Error('Database save failed. Please try again later.', { cause: error });
    }
  }

  async createSession(session: SessionRecord): Promise<void> {
    await this.ensureSchema();
    try {
      const studentId = session.studentId || DEFAULT_STUDENT_ID;
      await this.pool.query(
        `INSERT INTO sessions (session_id, student_id, mode, status, is_sandbox, data, started_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          session.sessionId,
          studentId,
          session.mode,
          session.status,
          Boolean(session.isSandbox),
          JSON.stringify({ ...session, studentId }),
          session.startedAt,
        ]
      );
    } catch (error) {
      console.error('createSession failed:', error);
      throw new Error('Database save failed. Please try again later.', { cause: error });
    }
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    await this.ensureSchema();
    try {
      const { rows } = await this.pool.query('SELECT data FROM sessions WHERE session_id = $1', [sessionId]);
      return rows.length ? (rows[0].data as SessionRecord) : null;
    } catch (error) {
      console.error('getSession failed:', error);
      throw new Error('Database query failed. Please try again later.', { cause: error });
    }
  }

  async saveSessionCheckpoint(sessionId: string, checkpoint: NonNullable<SessionRecord['checkpoint']>): Promise<void> {
    await this.ensureSchema();
    try {
      const session = await this.getSession(sessionId);
      if (!session || session.status !== 'in_progress') return;
      session.checkpoint = checkpoint;
      await this.pool.query('UPDATE sessions SET data = $2 WHERE session_id = $1', [sessionId, JSON.stringify(session)]);
    } catch (error) {
      console.error('saveSessionCheckpoint failed:', error);
      throw new Error('Database update failed. Please try again later.', { cause: error });
    }
  }

  async completeSession(sessionId: string, summary: { correctSlots: number; totalSlots: number; completedAt: string }): Promise<void> {
    await this.ensureSchema();
    try {
      const session = await this.getSession(sessionId);
      if (!session) return;
      session.status = 'submitted';
      session.correctSlots = summary.correctSlots;
      session.totalSlots = summary.totalSlots;
      session.completedAt = summary.completedAt;
      await this.pool.query(
        'UPDATE sessions SET status = $2, data = $3, completed_at = $4 WHERE session_id = $1',
        [sessionId, 'submitted', JSON.stringify(session), summary.completedAt]
      );
    } catch (error) {
      console.error('completeSession failed:', error);
      throw new Error('Database update failed. Please try again later.', { cause: error });
    }
  }

  async listSessions(limit = 50, studentId = DEFAULT_STUDENT_ID): Promise<SessionRecord[]> {
    await this.ensureSchema();
    try {
      const { rows } = await this.pool.query(
        'SELECT data FROM sessions WHERE student_id = $1 ORDER BY started_at DESC LIMIT $2',
        [studentId, limit]
      );
      return rows.map((r) => r.data as SessionRecord);
    } catch (error) {
      console.error('listSessions failed:', error);
      throw new Error('Database query failed. Please try again later.', { cause: error });
    }
  }

  async appendPartAttempts(attempts: PartAttemptRecord[]): Promise<void> {
    await this.ensureSchema();
    try {
      for (const a of attempts) {
        const studentId = a.studentId || DEFAULT_STUDENT_ID;
        await this.pool.query(
          `INSERT INTO part_attempts (attempt_id, student_id, session_id, question_id, part_id, skill_id, is_correct, is_sandbox, data, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            a.attemptId,
            studentId,
            a.sessionId,
            a.questionId,
            a.partId,
            a.skillId,
            a.isCorrect,
            Boolean(a.isSandbox),
            JSON.stringify({ ...a, studentId }),
            a.createdAt,
          ]
        );
      }
    } catch (error) {
      console.error('appendPartAttempts failed:', error);
      throw new Error('Database save failed. Please try again later.', { cause: error });
    }
  }

  async listPartAttempts(limit = 1000, studentId = DEFAULT_STUDENT_ID): Promise<PartAttemptRecord[]> {
    await this.ensureSchema();
    try {
      const { rows } = await this.pool.query(
        'SELECT data FROM part_attempts WHERE student_id = $1 AND is_sandbox = FALSE ORDER BY created_at DESC LIMIT $2',
        [studentId, limit]
      );
      return rows.map((r) => r.data as PartAttemptRecord);
    } catch (error) {
      console.error('listPartAttempts failed:', error);
      throw new Error('Database query failed. Please try again later.', { cause: error });
    }
  }

  async saveWritingSubmission(sub: WritingSubmissionRecord): Promise<void> {
    await this.ensureSchema();
    try {
      const studentId = sub.studentId || DEFAULT_STUDENT_ID;
      await this.pool.query(
        `INSERT INTO writing_submissions (submission_id, student_id, session_id, question_id, data, submitted_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [sub.submissionId, studentId, sub.sessionId, sub.questionId, JSON.stringify({ ...sub, studentId }), sub.submittedAt]
      );
    } catch (error) {
      console.error('saveWritingSubmission failed:', error);
      throw new Error('Database save failed. Please try again later.', { cause: error });
    }
  }

  async getWritingSubmission(submissionId: string): Promise<(WritingSubmissionRecord & { evaluations: WritingEvaluationRecord[] }) | null> {
    await this.ensureSchema();
    try {
      const subRes = await this.pool.query('SELECT data FROM writing_submissions WHERE submission_id = $1', [submissionId]);
      if (subRes.rows.length === 0) return null;
      const evalRes = await this.pool.query('SELECT data FROM writing_evaluations WHERE submission_id = $1 ORDER BY created_at DESC', [submissionId]);
      return {
        ...(subRes.rows[0].data as WritingSubmissionRecord),
        evaluations: evalRes.rows.map((r) => r.data as WritingEvaluationRecord),
      };
    } catch (error) {
      console.error('getWritingSubmission failed:', error);
      throw new Error('Database query failed. Please try again later.', { cause: error });
    }
  }

  async listWritingSubmissions(studentId = DEFAULT_STUDENT_ID): Promise<(WritingSubmissionRecord & { evaluations: WritingEvaluationRecord[] })[]> {
    await this.ensureSchema();
    try {
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
    } catch (error) {
      console.error('listWritingSubmissions failed:', error);
      throw new Error('Database query failed. Please try again later.', { cause: error });
    }
  }

  async saveWritingEvaluation(ev: WritingEvaluationRecord): Promise<void> {
    await this.ensureSchema();
    try {
      await this.pool.query(
        'INSERT INTO writing_evaluations (evaluation_id, submission_id, data, created_at) VALUES ($1, $2, $3, $4)',
        [ev.evaluationId, ev.submissionId, JSON.stringify(ev), ev.createdAt]
      );
    } catch (error) {
      console.error('saveWritingEvaluation failed:', error);
      throw new Error('Database save failed. Please try again later.', { cause: error });
    }
  }

  async getSkillStates(studentId = DEFAULT_STUDENT_ID): Promise<Record<string, SkillState>> {
    await this.ensureSchema();
    try {
      const { rows } = await this.pool.query('SELECT skill_id, data FROM skill_states WHERE student_id = $1', [studentId]);
      const out: Record<string, SkillState> = {};
      for (const r of rows) {
        out[r.skill_id] = r.data as SkillState;
      }
      return out;
    } catch (error) {
      console.error('getSkillStates failed:', error);
      throw new Error('Database query failed. Please try again later.', { cause: error });
    }
  }

  async upsertSkillStates(states: SkillState[], studentId = DEFAULT_STUDENT_ID): Promise<void> {
    await this.ensureSchema();
    try {
      for (const s of states) {
        await this.pool.query(
          `INSERT INTO skill_states (student_id, skill_id, data)
           VALUES ($1, $2, $3)
           ON CONFLICT (student_id, skill_id) DO UPDATE SET data = EXCLUDED.data`,
          [studentId, s.skillId, JSON.stringify(s)]
        );
      }
    } catch (error) {
      console.error('upsertSkillStates failed:', error);
      throw new Error('Database save failed. Please try again later.', { cause: error });
    }
  }

  async getQuestionMemory(studentId = DEFAULT_STUDENT_ID): Promise<Record<string, QuestionMemoryState>> {
    await this.ensureSchema();
    try {
      const { rows } = await this.pool.query('SELECT question_family_id, data FROM question_memory WHERE student_id = $1', [studentId]);
      const out: Record<string, QuestionMemoryState> = {};
      for (const r of rows) {
        out[r.question_family_id] = r.data as QuestionMemoryState;
      }
      return out;
    } catch (error) {
      console.error('getQuestionMemory failed:', error);
      throw new Error('Database query failed. Please try again later.', { cause: error });
    }
  }

  async upsertQuestionMemory(entries: QuestionMemoryState[], studentId = DEFAULT_STUDENT_ID): Promise<void> {
    await this.ensureSchema();
    try {
      for (const m of entries) {
        await this.pool.query(
          `INSERT INTO question_memory (student_id, question_family_id, data)
           VALUES ($1, $2, $3)
           ON CONFLICT (student_id, question_family_id) DO UPDATE SET data = EXCLUDED.data`,
          [studentId, m.questionFamilyId, JSON.stringify(m)]
        );
      }
    } catch (error) {
      console.error('upsertQuestionMemory failed:', error);
      throw new Error('Database save failed. Please try again later.', { cause: error });
    }
  }

  async saveQuestionFlag(flag: QuestionFlagRecord): Promise<void> {
    await this.ensureSchema();
    try {
      await this.pool.query(
        'INSERT INTO question_flags (flag_id, question_id, status, data, created_at) VALUES ($1, $2, $3, $4, $5)',
        [flag.flagId, flag.questionId, flag.status, JSON.stringify(flag), flag.createdAt]
      );
    } catch (error) {
      console.error('saveQuestionFlag failed:', error);
      throw new Error('Database save failed. Please try again later.', { cause: error });
    }
  }

  async listQuestionFlags(): Promise<QuestionFlagRecord[]> {
    await this.ensureSchema();
    try {
      const { rows } = await this.pool.query('SELECT data FROM question_flags ORDER BY created_at DESC');
      return rows.map((r) => r.data as QuestionFlagRecord);
    } catch (error) {
      console.error('listQuestionFlags failed:', error);
      throw new Error('Database query failed. Please try again later.', { cause: error });
    }
  }

  async resolveQuestionFlag(flagId: string): Promise<void> {
    await this.ensureSchema();
    try {
      const { rows } = await this.pool.query('SELECT data FROM question_flags WHERE flag_id = $1', [flagId]);
      if (rows.length === 0) return;
      const flag = rows[0].data as QuestionFlagRecord;
      flag.status = 'resolved';
      await this.pool.query('UPDATE question_flags SET status = $2, data = $3 WHERE flag_id = $1', [
        flagId,
        'resolved',
        JSON.stringify(flag),
      ]);
    } catch (error) {
      console.error('resolveQuestionFlag failed:', error);
      throw new Error('Database update failed. Please try again later.', { cause: error });
    }
  }

  async exportFullBackup(): Promise<Record<string, unknown>> {
    await this.ensureSchema();
    try {
      const [stimuli, questions, configs, sessions, attempts, subs, evals, skills, memory, flags] = await Promise.all([
        this.pool.query('SELECT data FROM stimuli'),
        this.pool.query('SELECT data FROM questions'),
        this.pool.query('SELECT config_version_id, version_number, notes, created_at, config FROM admin_config_versions ORDER BY version_number ASC'),
        this.pool.query('SELECT data FROM sessions'),
        this.pool.query('SELECT data FROM part_attempts'),
        this.pool.query('SELECT data FROM writing_submissions'),
        this.pool.query('SELECT data FROM writing_evaluations'),
        this.pool.query('SELECT student_id, data FROM skill_states'),
        this.pool.query('SELECT student_id, data FROM question_memory'),
        this.pool.query('SELECT data FROM question_flags'),
      ]);
      return {
        exportedAt: new Date().toISOString(),
        backendName: this.backendName,
        stimuli: stimuli.rows.map((r) => r.data),
        questions: questions.rows.map((r) => r.data),
        configVersions: configs.rows,
        sessions: sessions.rows.map((r) => r.data),
        partAttempts: attempts.rows.map((r) => r.data),
        writingSubmissions: subs.rows.map((r) => r.data),
        writingEvaluations: evals.rows.map((r) => r.data),
        skillStates: skills.rows,
        questionMemory: memory.rows,
        questionFlags: flags.rows.map((r) => r.data),
      };
    } catch (error) {
      console.error('exportFullBackup failed:', error);
      throw new Error('Database export failed. Please try again later.', { cause: error });
    }
  }
}
