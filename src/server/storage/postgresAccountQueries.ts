// User, learner-preference, progress-reset/account-delete and question-flag SQL for Postgres
// (kept out of the main repository file; PostgresRepository owns schema readiness and locking).
import type { Pool, PoolClient } from 'pg';
import type { LearnerAccountRecord, LearnerPreferences, QuestionFlagRecord } from '../../shared/contracts.ts';
import type { AccountDeleteResponse, ProgressCountsResponse, ProgressResetResponse } from './repository.ts';

type Queryable = Pool | PoolClient;

export async function upsertUserRow(
  db: Queryable,
  input: { uid: string; email: string; displayName?: string; isBootstrappedAdmin: boolean }
): Promise<{ role: 'student' | 'admin' }> {
  const role: 'student' | 'admin' = input.isBootstrappedAdmin ? 'admin' : 'student';
  const displayName = (input.displayName || input.email.split('@')[0] || 'Learner').slice(0, 120);
  await db.query(
    `INSERT INTO users (uid, role, display_name, email, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (uid) DO UPDATE SET role = EXCLUDED.role, display_name = EXCLUDED.display_name, email = EXCLUDED.email, updated_at = NOW()`,
    [input.uid, role, displayName, input.email]
  );
  return { role };
}

export async function queryIsUserAdmin(db: Queryable, uid: string): Promise<boolean> {
  const { rows } = await db.query('SELECT role FROM users WHERE uid = $1', [uid]);
  return rows[0]?.role === 'admin';
}

/** Registered users plus "orphan" learner ids that only exist in study tables. */
export async function queryListUsers(db: Queryable): Promise<LearnerAccountRecord[]> {
  const [usersRes, orphanRes] = await Promise.all([
    db.query<{
      uid: string;
      role: 'student' | 'admin';
      display_name: string;
      email: string | null;
      updated_at: Date | string | null;
    }>('SELECT uid, role, display_name, email, updated_at FROM users ORDER BY updated_at DESC NULLS LAST'),
    db.query<{ student_id: string }>(`
      SELECT DISTINCT student_id FROM (
        SELECT student_id FROM sessions
        UNION
        SELECT student_id FROM question_evidence
        UNION
        SELECT student_id FROM question_memory
      ) AS active_ids
    `),
  ]);
  const byUid = new Map<string, LearnerAccountRecord>();
  for (const r of usersRes.rows) {
    byUid.set(r.uid, {
      uid: r.uid,
      role: r.role === 'admin' ? 'admin' : 'student',
      displayName: r.display_name || r.email || r.uid,
      email: r.email || undefined,
      updatedAtIso: r.updated_at ? new Date(r.updated_at).toISOString() : undefined,
    });
  }
  for (const r of orphanRes.rows) {
    if (r.student_id && !byUid.has(r.student_id)) {
      byUid.set(r.student_id, {
        uid: r.student_id,
        role: 'student',
        displayName: r.student_id,
      });
    }
  }
  return Array.from(byUid.values());
}

export async function queryProgressCounts(db: Queryable, studentId: string): Promise<ProgressCountsResponse> {
  const { rows } = await db.query<ProgressCountsResponse>(`
    SELECT (SELECT count(*)::int FROM sessions WHERE student_id = $1) AS "sessionsCount",
           (SELECT count(*)::int FROM part_attempts WHERE student_id = $1) AS "attemptsCount",
           (SELECT count(*)::int FROM question_evidence WHERE student_id = $1) AS "evidenceCount",
           (SELECT count(*)::int FROM writing_submissions WHERE student_id = $1) AS "writingCount",
           (SELECT count(DISTINCT question_family_id)::int FROM questions) AS "bankQuestionsCount"`,
    [studentId]
  );
  return rows[0];
}

type StudyRowCounts = Omit<ProgressResetResponse, 'ok' | 'preservedQuestionsCount'>;

/** Deletes every study-progress row for one learner (caller holds the transaction and progress lock). */
async function deleteStudyRows(client: PoolClient, studentId: string): Promise<StudyRowCounts> {
  await client.query(
    `DELETE FROM session_snapshots
     WHERE student_id = $1 OR session_id IN (SELECT session_id FROM sessions WHERE student_id = $1)`,
    [studentId]
  );
  await client.query(
    `DELETE FROM benchmark_reports
     WHERE student_id = $1 OR session_id IN (SELECT session_id FROM sessions WHERE student_id = $1)`,
    [studentId]
  );
  const sessions = await client.query('DELETE FROM sessions WHERE student_id = $1', [studentId]);
  const attempts = await client.query('DELETE FROM part_attempts WHERE student_id = $1', [studentId]);
  const skills = await client.query('DELETE FROM skill_states WHERE student_id = $1', [studentId]);
  const memory = await client.query('DELETE FROM question_memory WHERE student_id = $1', [studentId]);
  const evidence = await client.query('DELETE FROM question_evidence WHERE student_id = $1', [studentId]);
  await client.query(`
    DELETE FROM writing_evaluations e USING writing_submissions s
    WHERE e.submission_id = s.submission_id AND s.student_id = $1`, [studentId]);
  const writing = await client.query('DELETE FROM writing_submissions WHERE student_id = $1', [studentId]);
  const plans = await client.query('DELETE FROM daily_focus_plans WHERE student_id = $1', [studentId]);
  return {
    clearedSessions: sessions.rowCount ?? 0,
    clearedAttempts: attempts.rowCount ?? 0,
    clearedSkillStates: skills.rowCount ?? 0,
    clearedMemory: memory.rowCount ?? 0,
    clearedEvidence: evidence.rowCount ?? 0,
    clearedWriting: writing.rowCount ?? 0,
    clearedDailyPlans: plans.rowCount ?? 0,
  };
}

async function countBankFamilies(client: PoolClient): Promise<number> {
  const bank = await client.query<{ count: number }>('SELECT count(DISTINCT question_family_id)::int AS count FROM questions');
  return bank.rows[0].count;
}

/** Clears a learner's study progress while keeping the account, preferences and question bank. */
export async function resetStudentProgressRows(client: PoolClient, studentId: string): Promise<ProgressResetResponse> {
  const cleared = await deleteStudyRows(client, studentId);
  return { ok: true, ...cleared, preservedQuestionsCount: await countBankFamilies(client) };
}

/** Removes the learner's study data, preferences, own flags and user row. */
export async function deleteUserAccountRows(client: PoolClient, studentId: string): Promise<AccountDeleteResponse> {
  const cleared = await deleteStudyRows(client, studentId);
  await client.query('DELETE FROM learner_preferences WHERE student_id = $1', [studentId]);
  const flags = await client.query(`DELETE FROM question_flags WHERE data->>'studentId' = $1`, [studentId]);
  const userDel = await client.query('DELETE FROM users WHERE uid = $1', [studentId]);
  const preservedQuestionsCount = await countBankFamilies(client);
  return {
    ok: true,
    deletedUser: (userDel.rowCount ?? 0) > 0,
    ...cleared,
    clearedFlags: flags.rowCount ?? 0,
    preservedQuestionsCount,
  };
}

export async function queryLearnerPreferences(db: Queryable, studentId: string): Promise<LearnerPreferences | null> {
  const { rows } = await db.query<{ data: LearnerPreferences }>(
    'SELECT data FROM learner_preferences WHERE student_id = $1',
    [studentId]
  );
  return rows.length ? structuredClone(rows[0].data) : null;
}

export async function upsertLearnerPreferencesRow(
  db: Queryable,
  studentId: string,
  prefs: LearnerPreferences
): Promise<LearnerPreferences> {
  const stamped: LearnerPreferences = {
    ...prefs,
    updatedAtIso: new Date().toISOString(),
  };
  await db.query(
    `INSERT INTO learner_preferences (student_id, data, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (student_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [studentId, JSON.stringify(stamped)]
  );
  return structuredClone(stamped);
}

export async function deleteLearnerPreferencesRow(db: Queryable, studentId: string): Promise<void> {
  await db.query('DELETE FROM learner_preferences WHERE student_id = $1', [studentId]);
}

export async function insertQuestionFlag(db: Queryable, flag: QuestionFlagRecord): Promise<void> {
  await db.query(
    'INSERT INTO question_flags (flag_id, question_id, status, data, created_at) VALUES ($1, $2, $3, $4, $5)',
    [flag.flagId, flag.questionId, flag.status, JSON.stringify(flag), flag.createdAt]
  );
}

export async function queryQuestionFlags(db: Queryable, studentId?: string): Promise<QuestionFlagRecord[]> {
  const { rows } = studentId
    ? await db.query(
        `SELECT data FROM question_flags WHERE data->>'studentId' = $1 ORDER BY created_at DESC`,
        [studentId]
      )
    : await db.query('SELECT data FROM question_flags ORDER BY created_at DESC');
  return rows.map((r) => r.data as QuestionFlagRecord);
}

export async function resolveQuestionFlagRow(db: Queryable, flagId: string): Promise<void> {
  const { rows } = await db.query('SELECT data FROM question_flags WHERE flag_id = $1', [flagId]);
  if (rows.length === 0) return;
  const flag = rows[0].data as QuestionFlagRecord;
  flag.status = 'resolved';
  await db.query('UPDATE question_flags SET status = $2, data = $3 WHERE flag_id = $1', [
    flagId,
    'resolved',
    JSON.stringify(flag),
  ]);
}
