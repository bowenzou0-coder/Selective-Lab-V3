// Canonical backup export/restore for Postgres (kept out of the main repository file).
import { type PoolClient } from 'pg';
import type { BenchmarkReportRecord, DailyFocusPlan, ImportBatchRecord, LearnerPreferences, LearningConfig, MediaAssetRecord, PartAttemptRecord, QuestionFlagRecord, QuestionItem, QuestionMasteryEvidence, QuestionMemoryState, SessionQuestionSnapshot, SessionRecord, SkillState, StimulusGroup, WritingEvaluationRecord } from '../../shared/contracts.ts';
import { type BackupRestoreReport, type CanonicalBackupBundle, type WritingSubmissionRecord } from './repository.ts';
import { emptyRestoreReport, finalizeBackupBundle, validateIncomingBackupBundle } from './repositoryUtils.ts';

type Transaction = <T>(work: (client: PoolClient) => Promise<T>, begin?: string) => Promise<T>;

/** Consistent snapshot of the whole database as a canonical backup bundle. */
export async function exportPostgresBackup(transaction: Transaction): Promise<CanonicalBackupBundle> {
  return transaction(async (client) => {
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
    const reportsRes = await client.query<{ student_id: string; data: BenchmarkReportRecord }>(
      'SELECT student_id, data FROM benchmark_reports ORDER BY student_id ASC, completed_at DESC, session_id ASC'
    );
    const prefsRes = await client.query<{ student_id: string; data: LearnerPreferences }>(
      'SELECT student_id, data FROM learner_preferences ORDER BY student_id ASC'
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
    for (const r of reportsRes.rows) uids.add(r.student_id);
    for (const r of prefsRes.rows) uids.add(r.student_id);

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
    const reportsByUid = new Map<string, BenchmarkReportRecord[]>();
    for (const r of reportsRes.rows) {
      const list = reportsByUid.get(r.student_id) || [];
      list.push(r.data);
      reportsByUid.set(r.student_id, list);
    }
    const prefsByUid = new Map(prefsRes.rows.map((r) => [r.student_id, r.data]));

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
          benchmarkReports: reportsByUid.get(uid) || [],
          learnerPreferences: prefsByUid.get(uid) ?? null,
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
      backendName: 'postgres',
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

/** Validates a backup bundle and (unless dryRun) inserts rows that do not already exist. */
export async function restorePostgresBackup(
  transaction: Transaction,
  rawBundle: unknown,
  options: { dryRun: boolean }
): Promise<BackupRestoreReport> {
  const validated = validateIncomingBackupBundle(rawBundle);
  if (!validated.valid || !validated.bundle) {
    return emptyRestoreReport(false, options.dryRun, validated.checksumVerified, validated.errors, validated.warnings);
  }
  const bundle = validated.bundle;

  return transaction(async (client) => {
    if (!options.dryRun) {
      await client.query(
        `LOCK TABLE stimuli, questions, import_batches, admin_config_versions, media_assets, question_flags,
                    users, sessions, session_snapshots, part_attempts, skill_states, question_memory,
                    question_evidence, writing_submissions, writing_evaluations, daily_focus_plans,
                    benchmark_reports, learner_preferences
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
    const reportSet = new Set(
      (await client.query<{ session_id: string }>('SELECT session_id FROM benchmark_reports')).rows.map((r) => r.session_id)
    );
    const prefsSet = new Set(
      (await client.query<{ student_id: string }>('SELECT student_id FROM learner_preferences')).rows.map((r) => r.student_id)
    );

    const totalSessions = bundle.users.reduce((n, u) => n + u.sessions.length, 0);
    const totalAttempts = bundle.users.reduce((n, u) => n + u.partAttempts.length, 0);
    const totalSubs = bundle.users.reduce((n, u) => n + u.writingSubmissions.length, 0);
    const totalPlans = bundle.users.reduce((n, u) => n + (u.dailyFocusPlans?.length ?? 0), 0);
    const totalReports = bundle.users.reduce((n, u) => n + (u.benchmarkReports?.length ?? 0), 0);
    const totalPrefs = bundle.users.reduce((n, u) => n + (u.learnerPreferences ? 1 : 0), 0);

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
      benchmarkReports: bundle.users.reduce(
        (n, u) => n + (u.benchmarkReports || []).filter((r) => !reportSet.has(r.sessionId)).length,
        0
      ),
      learnerPreferences: bundle.users.filter((u) => u.learnerPreferences && !prefsSet.has(u.uid)).length,
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
      benchmarkReports: totalReports - wouldCreate.benchmarkReports,
      learnerPreferences: totalPrefs - wouldCreate.learnerPreferences,
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
      benchmarkReports: 0,
      learnerPreferences: 0,
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
      for (const report of u.benchmarkReports || []) {
        const rRes = await client.query(
          `INSERT INTO benchmark_reports (session_id, student_id, completed_at, data)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (session_id) DO NOTHING`,
          [report.sessionId, u.uid, report.completedAtIso, JSON.stringify({ ...report, studentId: u.uid })]
        );
        applied.benchmarkReports += rRes.rowCount ?? 0;
      }
      if (u.learnerPreferences) {
        const prefs = u.learnerPreferences;
        const prRes = await client.query(
          `INSERT INTO learner_preferences (student_id, data, updated_at)
           VALUES ($1, $2, COALESCE($3::timestamptz, NOW()))
           ON CONFLICT (student_id) DO NOTHING`,
          [u.uid, JSON.stringify(prefs), prefs.updatedAtIso || null]
        );
        applied.learnerPreferences += prRes.rowCount ?? 0;
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
