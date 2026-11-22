import type { Pool } from 'pg';
import {
  computePoolHealth,
  deriveQuestionProgressMeta,
  type BatchDirectorySummary,
  type PoolHealthSummary,
  type QuestionCompletionStatus,
  type QuestionProgressMeta,
} from '../../shared/bankStatus.ts';
import {
  DEFAULT_MASTERY_POLICY,
  type BankMasterySummary,
  type QuestionItem,
  type QuestionMasteryEvidence,
  type QuestionMemoryState,
  type SectionCode,
  type SectionMasteryBreakdown,
  type StimulusGroup,
} from '../../shared/contracts.ts';
import { formatMasteryPercent } from '../../shared/mastery.ts';
import { SELECTION_COLUMNS_SQL, deepFreeze, selectionFromRow, type SelectionRow } from './questionBankCache.ts';
import type {
  AdminBankStatusSummary,
  ImportBatchSummary,
  QuestionMeta,
  QuestionQueryParams,
  QuestionQueryResult,
  QuestionSelectionItem,
  StudentDashboardBankSummary,
  StudentProgressBankStats,
  TodayAttemptCounts,
} from './repository.ts';
import { summarizeBatches } from './repositoryUtils.ts';

function batchTagSql(alias = 'q'): string {
  return `CASE
    WHEN strpos(${alias}.question_id, '_pt1_') > 0 OR strpos(coalesce(${alias}.data#>>'{provenance,sourceReference}', ''), 'PT1') > 0 THEN 'PT1'
    WHEN strpos(${alias}.question_id, '_pt2_') > 0 OR strpos(coalesce(${alias}.data#>>'{provenance,sourceReference}', ''), 'PT2') > 0 THEN 'PT2'
    WHEN strpos(${alias}.question_id, '_pt3_') > 0 OR strpos(coalesce(${alias}.data#>>'{provenance,sourceReference}', ''), 'PT3') > 0 THEN 'PT3'
    WHEN left(${alias}.question_id, 7) = 'q_read_' OR left(${alias}.question_id, 7) = 'q_math_'
      OR left(${alias}.question_id, 8) = 'q_think_' OR left(${alias}.question_id, 7) = 'q_writ_' THEN 'SMOKE'
    ELSE 'CUSTOM'
  END`;
}

// Mirrors JS `lastIndexOf('__')` in src/shared/bankStatus.ts so family fallback works even if a familyId contains '__'.
const EVIDENCE_FAMILY_EXPR = `coalesce(
  nullif(data->>'questionFamilyId', ''),
  CASE WHEN strpos(evidence_key, '__') > 0
       THEN left(evidence_key, length(evidence_key) - strpos(reverse(evidence_key), '__') - 1)
       ELSE '' END
)`;

const COMPLETION_STATUS_EXPR = `CASE
  WHEN ev.data IS NOT NULL THEN
    CASE ev.data->>'status'
      WHEN 'retained' THEN 'done'
      WHEN 'needs_repair' THEN 'needs_repair'
      WHEN 'correct_once' THEN 'in_review'
      WHEN 'awaiting_review' THEN 'in_review'
      ELSE 'unseen'
    END
  WHEN mem.data IS NOT NULL AND coalesce((mem.data->>'timesSeen')::int, 0) > 0 THEN
    CASE WHEN coalesce((mem.data->>'lastAllCorrect')::boolean, false) THEN 'in_review' ELSE 'needs_repair' END
  ELSE 'unseen'
END`;

const NATURAL_ID_ORDER_EXPR = `regexp_replace(regexp_replace(lower(q.question_id), '([0-9]+)', '0000000000\\1', 'g'), '0+([0-9]{10})', '\\1', 'g') ASC, q.question_id ASC`;

function buildLatestOrAllCte(includeHistorical: boolean, alias = 'q'): string {
  if (includeHistorical) {
    return `SELECT question_id, question_family_id, version, section, format_type, pool_type, qc_status, stimulus_id, data
            FROM questions ${alias}`;
  }
  return `SELECT DISTINCT ON (${alias}.question_family_id)
            ${alias}.question_id, ${alias}.question_family_id, ${alias}.version, ${alias}.section,
            ${alias}.format_type, ${alias}.pool_type, ${alias}.qc_status, ${alias}.stimulus_id, ${alias}.data
          FROM questions ${alias}
          ORDER BY ${alias}.question_family_id, ${alias}.version DESC`;
}

function makePoolHealthShell(
  counts: {
    totalLatest: number;
    liveCount: number;
    pausedCount: number;
    archivedCount: number;
    holdoutCount: number;
    unseenLiveCount: number;
    inReviewLiveCount: number;
    needsRepairLiveCount: number;
    doneLiveCount: number;
    bySectionLive: Record<SectionCode, { live: number; unseen: number; done: number }>;
  },
  dailyQuestionTarget: number
): PoolHealthSummary {
  const dailyTarget = Math.max(1, dailyQuestionTarget);
  const unseenLivePercent = counts.liveCount > 0 ? Math.round((counts.unseenLiveCount / counts.liveCount) * 100) : 0;
  const dailyNewBurn = Math.max(1, Math.round(dailyTarget * 0.6));
  const estimatedRunwayDays = Math.floor(counts.unseenLiveCount / dailyNewBurn);

  let refreshUrgency: PoolHealthSummary['refreshUrgency'] = 'healthy';
  let refreshAdvice = `Plenty of fresh material (${estimatedRunwayDays} days of unseen runway). Import a fresh batch once unseen stock drops below 30%.`;
  if (counts.liveCount === 0 || estimatedRunwayDays < 4 || unseenLivePercent < 15) {
    refreshUrgency = 'refresh_needed';
    refreshAdvice = `Unseen stock is low (${counts.unseenLiveCount} fresh items, ~${estimatedRunwayDays} days left). Generate and import 30–50 new questions to keep practice fresh.`;
  } else if (estimatedRunwayDays < 10 || unseenLivePercent < 30) {
    refreshUrgency = 'top_up_soon';
    refreshAdvice = `About ${estimatedRunwayDays} days of unseen questions remain (${unseenLivePercent}% fresh). Queue a fresh batch this week.`;
  }

  return {
    ...counts,
    unseenLivePercent,
    estimatedRunwayDays,
    refreshUrgency,
    refreshAdvice,
  };
}

export async function queryFilteredSelection(
  pool: Pool,
  filter: {
    section?: string;
    poolType?: string;
    qcStatus?: string;
    batchId?: string;
    batchTag?: string;
    includeHistorical?: boolean;
  }
): Promise<QuestionSelectionItem[]> {
  const params: unknown[] = [];
  const push = (val: unknown) => {
    params.push(val);
    return `$${params.length}`;
  };
  const where: string[] = [];
  if (filter.section) where.push(`q.section = ${push(filter.section)}`);
  if (filter.poolType) where.push(`q.pool_type = ${push(filter.poolType)}`);
  if (filter.qcStatus) where.push(`q.qc_status = ${push(filter.qcStatus)}`);
  if (filter.batchId) where.push(`q.data->>'batchId' = ${push(filter.batchId)}`);
  if (filter.batchTag) where.push(`${batchTagSql('q')} = ${push(filter.batchTag)}`);

  const base = buildLatestOrAllCte(Boolean(filter.includeHistorical));
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query<SelectionRow>(
    `WITH base AS (${base})
     SELECT ${SELECTION_COLUMNS_SQL}
     FROM base q
     ${whereSql}`,
    params
  );
  return deepFreeze(rows.map(selectionFromRow));
}

export async function queryAdminBankStatusSummary(pool: Pool): Promise<AdminBankStatusSummary> {
  const { rows } = await pool.query<{
    totalQuestions: number;
    byPool: Record<string, number>;
    bySection: Record<string, number>;
    byQcStatus: Record<string, number>;
    holdoutQuestionCount: number;
    leakedCount: number;
    openFlagsCount: number;
    batchesCount: number;
  }>(`
    WITH latest AS (
      SELECT DISTINCT ON (question_family_id) question_id, section, pool_type, qc_status
      FROM questions ORDER BY question_family_id, version DESC
    ),
    holdouts AS (
      SELECT question_id FROM latest WHERE pool_type = 'benchmark_holdout'
    )
    SELECT
      (SELECT count(*)::int FROM latest) AS "totalQuestions",
      coalesce((SELECT jsonb_object_agg(pool_type, n) FROM (SELECT pool_type, count(*)::int AS n FROM latest GROUP BY pool_type) p), '{}'::jsonb) AS "byPool",
      coalesce((SELECT jsonb_object_agg(section, n) FROM (SELECT section, count(*)::int AS n FROM latest GROUP BY section) s), '{}'::jsonb) AS "bySection",
      coalesce((SELECT jsonb_object_agg(qc_status, n) FROM (SELECT qc_status, count(*)::int AS n FROM latest GROUP BY qc_status) q), '{}'::jsonb) AS "byQcStatus",
      (SELECT count(*)::int FROM holdouts) AS "holdoutQuestionCount",
      (SELECT count(*)::int
       FROM sessions s CROSS JOIN LATERAL jsonb_array_elements_text(s.data->'plannedQuestionIds') AS planned(qid)
       WHERE s.mode NOT IN ('benchmark_exam', 'admin_calibration') AND planned.qid IN (SELECT question_id FROM holdouts)) AS "leakedCount",
      (SELECT count(*)::int FROM question_flags WHERE status = 'open') AS "openFlagsCount",
      (SELECT count(*)::int FROM import_batches) AS "batchesCount"
  `);
  return rows[0];
}

export async function queryStudentDashboardBankSummary(
  pool: Pool,
  studentId: string,
  autoRetireMastered: boolean
): Promise<StudentDashboardBankSummary> {
  const { rows } = await pool.query<{
    tag: string;
    section: SectionCode;
    poolType: string;
    batchId: string | null;
    batchLabel: string | null;
    importedBy: string | null;
    completionStatus: QuestionCompletionStatus;
    n: number;
  }>(
    `WITH latest AS (
       SELECT DISTINCT ON (question_family_id)
         question_id, question_family_id, section, pool_type, qc_status, data
       FROM questions ORDER BY question_family_id, version DESC
     ),
     active_latest AS (
       SELECT * FROM latest WHERE qc_status = 'active'
     ),
     ev_for_student AS (
       SELECT
         evidence_key,
         ${EVIDENCE_FAMILY_EXPR} AS fam_id,
         data
       FROM question_evidence
       WHERE student_id = $1
     )
     SELECT
       ${batchTagSql('q')} AS tag,
       q.section,
       q.pool_type AS "poolType",
       nullif(q.data->>'batchId', '') AS "batchId",
       nullif(q.data->>'batchLabel', '') AS "batchLabel",
       ib.data->>'importedBy' AS "importedBy",
       ${COMPLETION_STATUS_EXPR} AS "completionStatus",
       count(*)::int AS n
     FROM active_latest q
     LEFT JOIN import_batches ib ON ib.batch_id = q.data->>'batchId'
     LEFT JOIN LATERAL (
       SELECT e.data
       FROM ev_for_student e
       WHERE e.evidence_key = q.question_family_id || '__' || coalesce(q.data->>'evidenceRevision', '')
          OR e.fam_id = q.question_family_id
       ORDER BY (e.evidence_key = q.question_family_id || '__' || coalesce(q.data->>'evidenceRevision', '')) DESC,
                e.evidence_key ASC
       LIMIT 1
     ) ev ON q.pool_type <> 'benchmark_holdout'
     LEFT JOIN question_memory mem
       ON q.pool_type <> 'benchmark_holdout'
      AND mem.student_id = $1
      AND mem.question_family_id = q.question_family_id
     GROUP BY 1, 2, 3, 4, 5, 6, 7`,
    [studentId]
  );

  const batchCounts: Record<'PT1' | 'PT2' | 'PT3', Record<SectionCode, number>> = {
    PT1: { READ: 0, MATH: 0, THINK: 0, WRIT: 0 },
    PT2: { READ: 0, MATH: 0, THINK: 0, WRIT: 0 },
    PT3: { READ: 0, MATH: 0, THINK: 0, WRIT: 0 },
  };
  const poolCounts: Record<SectionCode, { live: number; unseen: number }> = {
    READ: { live: 0, unseen: 0 },
    MATH: { live: 0, unseen: 0 },
    THINK: { live: 0, unseen: 0 },
    WRIT: { live: 0, unseen: 0 },
  };
  const customBatchMap = new Map<
    string,
    { batchId: string; batchLabel: string; counts: Record<SectionCode, number>; total: number }
  >();

  for (const r of rows) {
    if (r.tag === 'PT1' || r.tag === 'PT2' || r.tag === 'PT3') {
      batchCounts[r.tag][r.section] += r.n;
    }
    if (r.poolType !== 'benchmark_holdout') {
      if (!(autoRetireMastered && r.completionStatus === 'done')) {
        poolCounts[r.section].live += r.n;
        if (r.completionStatus === 'unseen') {
          poolCounts[r.section].unseen += r.n;
        }
      }
      if (r.batchId && r.tag !== 'PT1' && r.tag !== 'PT2' && r.tag !== 'PT3' && r.importedBy !== 'system_seed') {
        const entry = customBatchMap.get(r.batchId) || {
          batchId: r.batchId,
          batchLabel: r.batchLabel || r.batchId,
          counts: { READ: 0, MATH: 0, THINK: 0, WRIT: 0 },
          total: 0,
        };
        entry.counts[r.section] += r.n;
        entry.total += r.n;
        customBatchMap.set(r.batchId, entry);
      }
    }
  }

  return {
    batchCounts,
    poolCounts,
    customBatches: Array.from(customBatchMap.values()).sort((a, b) => b.batchLabel.localeCompare(a.batchLabel)),
  };
}

export async function queryTodayAttemptCounts(
  pool: Pool,
  studentId: string,
  datePrefix: string
): Promise<TodayAttemptCounts> {
  const escaped = datePrefix.replace(/[\\%_]/g, '\\$&');
  const { rows } = await pool.query<{ attempted: number; correct: number }>(
    `SELECT
       count(*)::int AS attempted,
       count(*) FILTER (WHERE is_correct)::int AS correct
     FROM part_attempts
     WHERE student_id = $1 AND NOT is_sandbox AND data->>'createdAt' LIKE $2 ESCAPE '\\'`,
    [studentId, `${escaped}%`]
  );
  return rows[0] || { attempted: 0, correct: 0 };
}

export async function queryStudentProgressStats(
  pool: Pool,
  input: {
    studentId: string;
    writingSubmissionsCount: number;
    writingEvaluatedCount: number;
    policyVersion?: string;
  }
): Promise<StudentProgressBankStats> {
  const policyVersion = input.policyVersion || DEFAULT_MASTERY_POLICY.policyVersion;

  const [masteryRes, attemptsRes] = await Promise.all([
    pool.query<{
      section: SectionCode;
      qcStatus: string;
      poolType: string;
      formatType: string;
      evStatus: string | null;
      firstClean: boolean;
      n: number;
    }>(
      `WITH latest AS (
         SELECT DISTINCT ON (question_family_id)
           question_family_id, section, pool_type, format_type, qc_status, data->>'evidenceRevision' AS ev_rev
         FROM questions ORDER BY question_family_id, version DESC
       )
       SELECT
         q.section,
         q.qc_status AS "qcStatus",
         q.pool_type AS "poolType",
         q.format_type AS "formatType",
         e.data->>'status' AS "evStatus",
         coalesce((e.data->>'firstSubmissionCleanPass')::boolean, false) AS "firstClean",
         count(*)::int AS n
       FROM latest q
       LEFT JOIN question_evidence e
         ON e.student_id = $1
        AND q.qc_status = 'active'
        AND q.pool_type <> 'benchmark_holdout'
        AND q.format_type <> 'WRIT_TYPED_TASK'
        AND e.evidence_key = q.question_family_id || '__' || coalesce(q.ev_rev, '')
       GROUP BY 1, 2, 3, 4, 5, 6`,
      [input.studentId]
    ),
    pool.query<{
      sec: SectionCode;
      totalAttempts: number;
      correct: number;
      spentSum: number;
      targetSum: number;
      legacyCount: number;
      holdoutCount: number;
      holdoutCorrect: number;
      holdoutQuestions: number;
    }>(
      `WITH latest AS (
         SELECT DISTINCT ON (question_family_id)
           question_id, section, pool_type, data->'parts' AS parts
         FROM questions ORDER BY question_family_id, version DESC
       ),
       part_targets AS (
         SELECT DISTINCT ON (p->>'partId')
           p->>'partId' AS part_id, q.section, coalesce((p->>'targetTimeSec')::int, 60) AS target_sec
         FROM latest q, jsonb_array_elements(q.parts) p
         ORDER BY p->>'partId'
       ),
       recent_attempts AS (
         SELECT question_id, part_id, is_correct, data
         FROM part_attempts
         WHERE student_id = $1 AND NOT is_sandbox
         ORDER BY created_at DESC
         LIMIT 5000
       )
       SELECT
         coalesce(pt.section, q.section, 'MATH') AS sec,
         count(*)::int AS "totalAttempts",
         count(*) FILTER (WHERE a.is_correct)::int AS correct,
         coalesce(sum(coalesce((a.data->>'timeSpentSec')::numeric, 0)), 0)::float8 AS "spentSum",
         coalesce(sum(coalesce(pt.target_sec, 60)), 0)::float8 AS "targetSum",
         count(*) FILTER (WHERE coalesce((a.data->>'isLegacy')::boolean, false))::int AS "legacyCount",
         count(*) FILTER (WHERE q.pool_type = 'benchmark_holdout')::int AS "holdoutCount",
         count(*) FILTER (WHERE q.pool_type = 'benchmark_holdout' AND a.is_correct)::int AS "holdoutCorrect",
         count(DISTINCT CASE WHEN q.pool_type = 'benchmark_holdout' THEN a.question_id END)::int AS "holdoutQuestions"
       FROM recent_attempts a
       LEFT JOIN part_targets pt ON pt.part_id = a.part_id
       LEFT JOIN latest q ON q.question_id = a.question_id
       GROUP BY 1`,
      [input.studentId]
    ),
  ]);

  const makeEmptySec = (): SectionMasteryBreakdown => ({
    eligible: 0,
    unseen: 0,
    correctOnce: 0,
    awaitingReview: 0,
    retained: 0,
    needsRepair: 0,
    correctOnceOrMoreCount: 0,
    retainedPercentDisplay: 'No evidence',
    correctOncePercentDisplay: 'No evidence',
  });
  const bySection: Record<SectionCode, SectionMasteryBreakdown> = {
    READ: makeEmptySec(),
    MATH: makeEmptySec(),
    THINK: makeEmptySec(),
    WRIT: makeEmptySec(),
  };

  let excludedHoldoutCount = 0;
  let excludedWritingCount = 0;
  let excludedInactiveCount = 0;
  let eligibleCount = 0;
  let unseenCount = 0;
  let correctOnceCount = 0;
  let awaitingReviewCount = 0;
  let retainedCount = 0;
  let needsRepairCount = 0;
  let correctOnceOrMoreCount = 0;
  let firstPassCleanCount = 0;

  for (const r of masteryRes.rows) {
    if (r.qcStatus !== 'active') {
      excludedInactiveCount += r.n;
      continue;
    }
    if (r.poolType === 'benchmark_holdout') {
      excludedHoldoutCount += r.n;
      continue;
    }
    if (r.formatType === 'WRIT_TYPED_TASK') {
      excludedWritingCount += r.n;
      continue;
    }
    eligibleCount += r.n;
    const sec = bySection[r.section];
    sec.eligible += r.n;
    if (r.firstClean) firstPassCleanCount += r.n;

    if (!r.evStatus || r.evStatus === 'unseen') {
      unseenCount += r.n;
      sec.unseen += r.n;
    } else if (r.evStatus === 'correct_once') {
      correctOnceCount += r.n;
      correctOnceOrMoreCount += r.n;
      sec.correctOnce += r.n;
      sec.correctOnceOrMoreCount += r.n;
    } else if (r.evStatus === 'awaiting_review') {
      awaitingReviewCount += r.n;
      correctOnceOrMoreCount += r.n;
      sec.awaitingReview += r.n;
      sec.correctOnceOrMoreCount += r.n;
    } else if (r.evStatus === 'retained') {
      retainedCount += r.n;
      correctOnceOrMoreCount += r.n;
      sec.retained += r.n;
      sec.correctOnceOrMoreCount += r.n;
    } else if (r.evStatus === 'needs_repair') {
      needsRepairCount += r.n;
      sec.needsRepair += r.n;
    }
  }

  for (const secCode of ['READ', 'MATH', 'THINK', 'WRIT'] as SectionCode[]) {
    const s = bySection[secCode];
    s.retainedPercentDisplay = formatMasteryPercent(s.retained, s.eligible);
    s.correctOncePercentDisplay = formatMasteryPercent(s.correctOnceOrMoreCount, s.eligible);
  }

  const sectionStats: Record<
    SectionCode,
    { attempts: number; correct: number; avgTimeSec: number; targetTimeSec: number }
  > = {
    READ: { attempts: 0, correct: 0, avgTimeSec: 0, targetTimeSec: 60 },
    MATH: { attempts: 0, correct: 0, avgTimeSec: 0, targetTimeSec: 60 },
    THINK: { attempts: 0, correct: 0, avgTimeSec: 0, targetTimeSec: 60 },
    WRIT: { attempts: 0, correct: 0, avgTimeSec: 0, targetTimeSec: 1800 },
  };
  let totalAttempts = 0;
  let legacyAttemptsCount = 0;
  let holdoutCorrect = 0;
  let holdoutTotal = 0;
  let holdoutQuestions = 0;

  for (const r of attemptsRes.rows) {
    totalAttempts += r.totalAttempts;
    legacyAttemptsCount += r.legacyCount;
    holdoutTotal += r.holdoutCount;
    holdoutCorrect += r.holdoutCorrect;
    holdoutQuestions += r.holdoutQuestions;
    const st = sectionStats[r.sec];
    if (st && r.totalAttempts > 0) {
      st.attempts = r.totalAttempts;
      st.correct = r.correct;
      st.avgTimeSec = Math.round(r.spentSum / r.totalAttempts);
      st.targetTimeSec = Math.round(r.targetSum / r.totalAttempts);
    }
  }

  const masterySummary: BankMasterySummary = {
    policyVersion,
    eligibleCount,
    excludedHoldoutCount,
    excludedWritingCount,
    excludedInactiveCount,
    unseenCount,
    correctOnceCount,
    awaitingReviewCount,
    retainedCount,
    needsRepairCount,
    correctOnceOrMoreCount,
    firstPassCleanCount,
    retainedPercentDisplay: formatMasteryPercent(retainedCount, eligibleCount),
    correctOncePercentDisplay: formatMasteryPercent(correctOnceOrMoreCount, eligibleCount),
    firstPassPercentDisplay: formatMasteryPercent(firstPassCleanCount, eligibleCount),
    legacyAttemptsCount,
    bySection,
    holdoutSummary: {
      totalQuestions: excludedHoldoutCount,
      attemptedQuestions: holdoutQuestions,
      latestCorrectSlots: holdoutCorrect,
      latestTotalSlots: holdoutTotal,
      accuracyDisplay: formatMasteryPercent(holdoutCorrect, holdoutTotal),
    },
    writingSummary: {
      totalPrompts: excludedWritingCount,
      submissionsCount: input.writingSubmissionsCount,
      evaluatedCount: input.writingEvaluatedCount,
    },
  };

  return { sectionStats, totalAttempts, masterySummary };
}

export async function queryPoolHealthByLearner(
  pool: Pool,
  studentIds: string[],
  dailyQuestionTarget: number
): Promise<{ totalLiveQuestions: number; byStudentId: Record<string, PoolHealthSummary> }> {
  const { rows: baseRows } = await pool.query<{
    totalLatest: number;
    liveCount: number;
    pausedCount: number;
    archivedCount: number;
    holdoutCount: number;
    bySectionLive: Record<SectionCode, number>;
  }>(`
    WITH latest AS (
      SELECT DISTINCT ON (question_family_id)
        section, pool_type, qc_status
      FROM questions ORDER BY question_family_id, version DESC
    ),
    live_rows AS (
      SELECT section FROM latest WHERE qc_status = 'active' AND pool_type <> 'benchmark_holdout'
    )
    SELECT
      (SELECT count(*)::int FROM latest) AS "totalLatest",
      (SELECT count(*)::int FROM live_rows) AS "liveCount",
      (SELECT count(*)::int FROM latest WHERE qc_status NOT IN ('active', 'retired')) AS "pausedCount",
      (SELECT count(*)::int FROM latest WHERE qc_status = 'retired') AS "archivedCount",
      (SELECT count(*)::int FROM latest WHERE qc_status = 'active' AND pool_type = 'benchmark_holdout') AS "holdoutCount",
      coalesce((SELECT jsonb_object_agg(section, n) FROM (SELECT section, count(*)::int AS n FROM live_rows GROUP BY section) s), '{}'::jsonb) AS "bySectionLive"
  `);
  const base = baseRows[0];

  const byStudentId: Record<string, PoolHealthSummary> = {};
  if (studentIds.length === 0) {
    return { totalLiveQuestions: base.liveCount, byStudentId };
  }

  const { rows: statusRows } = await pool.query<{
    studentId: string;
    section: SectionCode;
    completionStatus: QuestionCompletionStatus;
    n: number;
  }>(
    `WITH latest_live AS (
       SELECT DISTINCT ON (question_family_id)
         question_family_id, section, data->>'evidenceRevision' AS ev_rev, pool_type, qc_status
       FROM questions ORDER BY question_family_id, version DESC
     ),
     live_only AS (
       SELECT question_family_id, section, ev_rev
       FROM latest_live
       WHERE qc_status = 'active' AND pool_type <> 'benchmark_holdout'
     ),
     ev_tagged AS (
       SELECT student_id, evidence_key, ${EVIDENCE_FAMILY_EXPR} AS fam_id, data
       FROM question_evidence
       WHERE student_id = ANY($1::text[])
     )
     SELECT
       sid.student_id AS "studentId",
       q.section,
       ${COMPLETION_STATUS_EXPR} AS "completionStatus",
       count(*)::int AS n
     FROM unnest($1::text[]) AS sid(student_id)
     CROSS JOIN live_only q
     LEFT JOIN LATERAL (
       SELECT e.data
       FROM ev_tagged e
       WHERE e.student_id = sid.student_id
         AND (
           (coalesce(q.ev_rev, '') <> '' AND e.evidence_key = q.question_family_id || '__' || q.ev_rev)
           OR e.fam_id = q.question_family_id
         )
       ORDER BY (coalesce(q.ev_rev, '') <> '' AND e.evidence_key = q.question_family_id || '__' || q.ev_rev) DESC,
                e.evidence_key ASC
       LIMIT 1
     ) ev ON TRUE
     LEFT JOIN question_memory mem
       ON mem.student_id = sid.student_id AND mem.question_family_id = q.question_family_id
     GROUP BY 1, 2, 3`,
    [studentIds]
  );

  const bySecBase: Record<SectionCode, { live: number; unseen: number; done: number }> = {
    READ: { live: base.bySectionLive.READ || 0, unseen: 0, done: 0 },
    MATH: { live: base.bySectionLive.MATH || 0, unseen: 0, done: 0 },
    THINK: { live: base.bySectionLive.THINK || 0, unseen: 0, done: 0 },
    WRIT: { live: base.bySectionLive.WRIT || 0, unseen: 0, done: 0 },
  };
  const agg = new Map<
    string,
    {
      unseenLiveCount: number;
      inReviewLiveCount: number;
      needsRepairLiveCount: number;
      doneLiveCount: number;
      bySectionLive: Record<SectionCode, { live: number; unseen: number; done: number }>;
    }
  >();
  for (const uid of studentIds) {
    agg.set(uid, {
      unseenLiveCount: 0,
      inReviewLiveCount: 0,
      needsRepairLiveCount: 0,
      doneLiveCount: 0,
      bySectionLive: {
        READ: { ...bySecBase.READ },
        MATH: { ...bySecBase.MATH },
        THINK: { ...bySecBase.THINK },
        WRIT: { ...bySecBase.WRIT },
      },
    });
  }

  for (const r of statusRows) {
    const entry = agg.get(r.studentId);
    if (!entry) continue;
    if (r.completionStatus === 'unseen') {
      entry.unseenLiveCount += r.n;
      entry.bySectionLive[r.section].unseen += r.n;
    } else if (r.completionStatus === 'done') {
      entry.doneLiveCount += r.n;
      entry.bySectionLive[r.section].done += r.n;
    } else if (r.completionStatus === 'needs_repair') {
      entry.needsRepairLiveCount += r.n;
    } else {
      entry.inReviewLiveCount += r.n;
    }
  }

  for (const uid of studentIds) {
    const entry = agg.get(uid)!;
    byStudentId[uid] = makePoolHealthShell(
      {
        totalLatest: base.totalLatest,
        liveCount: base.liveCount,
        pausedCount: base.pausedCount,
        archivedCount: base.archivedCount,
        holdoutCount: base.holdoutCount,
        ...entry,
      },
      dailyQuestionTarget
    );
  }

  return { totalLiveQuestions: base.liveCount, byStudentId };
}

export async function queryBatchSummaries(
  pool: Pool,
  studentId: string | null,
  importBatches: ImportBatchSummary[]
): Promise<BatchDirectorySummary[]> {
  const { rows } = await pool.query<{
    resolvedBatchId: string;
    tag: 'PT1' | 'PT2' | 'PT3' | 'SMOKE' | 'CUSTOM';
    batchId: string | null;
    batchLabel: string | null;
    createdAtIso: string | null;
    sourceType: string | null;
    poolStatus: 'live' | 'paused' | 'archived';
    completionStatus: QuestionCompletionStatus;
    questionIds: string[];
  }>(
    `WITH latest AS (
       SELECT DISTINCT ON (question_family_id)
         question_id, question_family_id, qc_status, data
       FROM questions ORDER BY question_family_id, version DESC
     ),
     ev_for_student AS (
       SELECT evidence_key, ${EVIDENCE_FAMILY_EXPR} AS fam_id, data
       FROM question_evidence
       WHERE $1::text IS NOT NULL AND student_id = $1
     )
     SELECT
       coalesce(nullif(q.data->>'batchId', ''), 'tag_' || (${batchTagSql('q')})) AS "resolvedBatchId",
       ${batchTagSql('q')} AS tag,
       nullif(q.data->>'batchId', '') AS "batchId",
       max(nullif(q.data->>'batchLabel', '')) AS "batchLabel",
       min(nullif(q.data->>'createdAtIso', '')) AS "createdAtIso",
       max(q.data#>>'{provenance,sourceType}') AS "sourceType",
       CASE WHEN q.qc_status = 'active' THEN 'live' WHEN q.qc_status = 'retired' THEN 'archived' ELSE 'paused' END AS "poolStatus",
       ${COMPLETION_STATUS_EXPR} AS "completionStatus",
       array_agg(q.question_id ORDER BY q.question_id) AS "questionIds"
     FROM latest q
     LEFT JOIN LATERAL (
       SELECT e.data
       FROM ev_for_student e
       WHERE $1::text IS NOT NULL
         AND (
           e.evidence_key = q.question_family_id || '__' || coalesce(q.data->>'evidenceRevision', '')
           OR e.fam_id = q.question_family_id
         )
       ORDER BY (e.evidence_key = q.question_family_id || '__' || coalesce(q.data->>'evidenceRevision', '')) DESC,
                e.evidence_key ASC
       LIMIT 1
     ) ev ON TRUE
     LEFT JOIN question_memory mem
       ON $1::text IS NOT NULL AND mem.student_id = $1 AND mem.question_family_id = q.question_family_id
     GROUP BY 1, 2, 3, 7, 8`,
    [studentId]
  );

  const labels = {
    PT1: 'Official Practice Test 1',
    PT2: 'Official Practice Test 2',
    PT3: 'Official Practice Test 3',
    SMOKE: 'Built-in Starter Pack',
    CUSTOM: 'Built-in Starter Pack',
  };
  const imported = new Map(importBatches.map((b) => [b.batchId, b]));
  const summaries = new Map<string, BatchDirectorySummary>();

  for (const r of rows) {
    const importedBatch = imported.get(r.resolvedBatchId);
    const existing = summaries.get(r.resolvedBatchId) ?? {
      batchId: r.resolvedBatchId,
      batchLabel:
        importedBatch?.batchLabel ||
        r.batchLabel ||
        (r.batchId ? r.batchId : labels[r.tag]),
      createdAtIso: importedBatch?.createdAtIso || r.createdAtIso || '',
      importedBy:
        importedBatch?.importedBy ||
        (r.sourceType === 'official_doe' ? 'official_seed' : 'bank'),
      total: 0,
      live: 0,
      unseen: 0,
      done: 0,
      paused: 0,
      archived: 0,
      questionIds: [],
    };
    const count = r.questionIds.length;
    existing.total += count;
    existing.questionIds.push(...r.questionIds);
    existing[r.poolStatus] += count;
    if (r.completionStatus === 'unseen' || r.completionStatus === 'done') {
      existing[r.completionStatus] += count;
    }
    summaries.set(r.resolvedBatchId, existing);
  }

  return Array.from(summaries.values()).sort(
    (a, b) => (Date.parse(b.createdAtIso) || 0) - (Date.parse(a.createdAtIso) || 0)
  );
}

export async function queryQuestionsPaginatedSql(
  pool: Pool,
  params: QuestionQueryParams,
  importBatchesPromise: Promise<ImportBatchSummary[]>
): Promise<QuestionQueryResult> {
  const pageSize = Math.max(1, Math.min(200, Number(params.pageSize || 50)));
  const requestedPage = Math.max(1, Number(params.page || 1));
  const includeHistorical = Boolean(params.includeHistorical);
  const includeSummary = params.includeSummary !== false;
  const studentId = params.monitoredStudentId !== undefined ? params.monitoredStudentId : null;
  const progressMode = params.monitoredStudentId !== undefined ? 'sql' : params.progress ? 'memory' : 'none';

  const sqlParams: unknown[] = [];
  const push = (v: unknown) => {
    sqlParams.push(v);
    return `$${sqlParams.length}`;
  };
  const studentParam = push(studentId);
  const pageSizeParam = push(pageSize);
  const reqPageParam = push(requestedPage);

  const where: string[] = [];
  if (params.section) where.push(`q.section = ${push(params.section)}`);
  if (params.poolType) where.push(`q.pool_type = ${push(params.poolType)}`);
  if (params.qcStatus) where.push(`q.qc_status = ${push(params.qcStatus)}`);
  if (params.poolStatus === 'live') where.push(`q.qc_status = 'active'`);
  else if (params.poolStatus === 'archived') where.push(`q.qc_status = 'retired'`);
  else if (params.poolStatus === 'paused') where.push(`q.qc_status NOT IN ('active', 'retired')`);

  if (params.formatType) where.push(`q.format_type = ${push(params.formatType)}`);
  if (params.batchId) {
    if (params.batchId.startsWith('tag_')) {
      where.push(`('tag_' || (${batchTagSql('q')})) = ${push(params.batchId)}`);
    } else {
      where.push(`q.data->>'batchId' = ${push(params.batchId)}`);
    }
  }
  if (params.batchTag) where.push(`${batchTagSql('q')} = ${push(params.batchTag)}`);
  if (params.skillId) {
    const sk = push(params.skillId);
    where.push(`EXISTS (
      SELECT 1 FROM jsonb_array_elements(q.data->'parts') AS p
      WHERE p->>'skillId' = ${sk}
         OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(p->'secondarySkillIds', '[]'::jsonb)) AS ss WHERE ss = ${sk})
    )`);
  }
  if (params.flaggedOnly) {
    where.push(`EXISTS (SELECT 1 FROM question_flags f WHERE f.question_id = q.question_id AND f.status = 'open')`);
  }
  if (params.missingVisual) {
    where.push(
      `coalesce(q.data->'visual'->>'visualType', 'none') = 'none' AND coalesce(s.data->'visual'->>'visualType', 'none') = 'none'`
    );
  }
  if (params.missingExplanation) {
    where.push(
      `q.format_type <> 'WRIT_TYPED_TASK' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(q.data->'parts') AS p
        WHERE btrim(coalesce(p->>'workedExplanation', '')) = ''
      )`
    );
  }

  const needle = (params.search || '').trim().toLowerCase();
  if (needle) {
    const needleParam = push(needle);
    where.push(`strpos(lower(
      coalesce(q.question_id, '') || ' ' ||
      coalesce(q.question_family_id, '') || ' ' ||
      coalesce(q.data->>'stemPrefix', '') || ' ' ||
      coalesce(q.data->>'batchId', '') || ' ' ||
      coalesce(q.data->>'batchLabel', '') || ' ' ||
      coalesce(q.data#>>'{provenance,sourceReference}', '') || ' ' ||
      coalesce((
        SELECT string_agg(
          coalesce(p->>'partId', '') || ' ' ||
          coalesce(p->>'promptText', '') || ' ' ||
          coalesce(p->>'skillId', '') || ' ' ||
          coalesce((SELECT string_agg(x, ' ') FROM jsonb_array_elements_text(coalesce(p->'secondarySkillIds', '[]'::jsonb)) x), '') || ' ' ||
          coalesce((SELECT string_agg(x, ' ') FROM jsonb_array_elements_text(coalesce(p->'trapTags', '[]'::jsonb)) x), '') || ' ' ||
          coalesce(p->>'workedExplanation', '') || ' ' ||
          coalesce((SELECT string_agg(coalesce(o->>'key', '') || ' ' || coalesce(o->>'text', ''), ' ') FROM jsonb_array_elements(coalesce(p->'options', '[]'::jsonb)) o), ''),
          ' '
        )
        FROM jsonb_array_elements(q.data->'parts') p
      ), '') || ' ' ||
      coalesce(
        s.stimulus_id || ' ' ||
        coalesce(s.data->>'title', '') || ' ' ||
        coalesce(s.data->>'preamble', '') || ' ' ||
        coalesce(s.data->>'mainTextMarkdown', '') || ' ' ||
        coalesce((SELECT string_agg(coalesce(e->>'label', '') || ' ' || coalesce(e->>'title', '') || ' ' || coalesce(e->>'bodyMarkdown', ''), ' ') FROM jsonb_array_elements(coalesce(s.data->'extracts', '[]'::jsonb)) e), ''),
        ''
      )
    ), ${needleParam}) > 0`);
  }

  let memFilterClause = '';
  if (params.completionStatus) {
    if (progressMode === 'sql') {
      where.push(`${COMPLETION_STATUS_EXPR} = ${push(params.completionStatus)}`);
    } else if (progressMode === 'memory' && params.progress) {
      // Only reached when a caller supplies in-memory progress maps directly (without monitoredStudentId).
      const matchingFamilies: string[] = [];
      const nonUnseenFamilies = new Set<string>();
      const seenFamilies = new Set<string>();
      for (const [k, ev] of Object.entries(params.progress.evidence)) {
        const sep = k.lastIndexOf('__');
        const fam = ev.questionFamilyId || (sep > 0 ? k.slice(0, sep) : '');
        if (!fam || seenFamilies.has(fam)) continue;
        seenFamilies.add(fam);
        const st = deriveQuestionProgressMeta({ questionFamilyId: fam, evidenceRevision: undefined }, params.progress.evidence, params.progress.memory).completionStatus;
        if (st !== 'unseen') nonUnseenFamilies.add(fam);
        if (st === params.completionStatus) matchingFamilies.push(fam);
      }
      for (const [fam, mem] of Object.entries(params.progress.memory)) {
        if (seenFamilies.has(fam)) continue;
        if (mem.timesSeen > 0) {
          const st: QuestionCompletionStatus = mem.lastAllCorrect ? 'in_review' : 'needs_repair';
          nonUnseenFamilies.add(fam);
          if (st === params.completionStatus) matchingFamilies.push(fam);
        }
      }
      if (params.completionStatus === 'unseen') {
        const nonUnseenParam = push(Array.from(nonUnseenFamilies));
        memFilterClause = `NOT (q.question_family_id = ANY(${nonUnseenParam}::text[]))`;
      } else {
        const matchParam = push(matchingFamilies);
        memFilterClause = `q.question_family_id = ANY(${matchParam}::text[])`;
      }
      where.push(memFilterClause);
    } else if (params.completionStatus !== 'unseen') {
      where.push('FALSE');
    }
  }

  const sort = params.sort || 'id_asc';
  const orderSql =
    sort === 'updated_desc'
      ? `CASE WHEN coalesce(nullif(q.data->>'updatedAtIso', ''), nullif(q.data->>'createdAtIso', '')) ~ '^\\d{4}-\\d{2}-\\d{2}'
              THEN coalesce(nullif(q.data->>'updatedAtIso', ''), nullif(q.data->>'createdAtIso', ''))::timestamptz
              ELSE to_timestamp(0) END DESC, ${NATURAL_ID_ORDER_EXPR}`
      : sort === 'version_desc'
        ? `q.version DESC, ${NATURAL_ID_ORDER_EXPR}`
        : NATURAL_ID_ORDER_EXPR;

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const baseSql = buildLatestOrAllCte(includeHistorical);

  const pageQuery = pool.query<{
    totalMatching: number;
    question: QuestionItem | null;
    evData: QuestionMasteryEvidence | null;
    memData: QuestionMemoryState | null;
  }>(
    `WITH base AS (${baseSql}),
     ev_for_student AS (
       SELECT evidence_key, ${EVIDENCE_FAMILY_EXPR} AS fam_id, data
       FROM question_evidence
       WHERE ${studentParam}::text IS NOT NULL AND student_id = ${studentParam}
     ),
     filtered AS (
       SELECT q.question_id, q.version, q.data, ev.data AS ev_data, mem.data AS mem_data
       FROM base q
       LEFT JOIN stimuli s ON s.stimulus_id = q.stimulus_id
       LEFT JOIN LATERAL (
         SELECT e.data
         FROM ev_for_student e
         WHERE ${studentParam}::text IS NOT NULL
           AND (
             (coalesce(q.data->>'evidenceRevision', '') <> '' AND e.evidence_key = q.question_family_id || '__' || (q.data->>'evidenceRevision'))
             OR e.fam_id = q.question_family_id
           )
         ORDER BY (coalesce(q.data->>'evidenceRevision', '') <> '' AND e.evidence_key = q.question_family_id || '__' || (q.data->>'evidenceRevision')) DESC,
                  e.evidence_key ASC
         LIMIT 1
       ) ev ON TRUE
       LEFT JOIN question_memory mem
         ON ${studentParam}::text IS NOT NULL AND mem.student_id = ${studentParam} AND mem.question_family_id = q.question_family_id
       ${whereSql}
     ),
     numbered AS (
       SELECT q.question_id, q.data, q.ev_data, q.mem_data,
              row_number() OVER (ORDER BY ${orderSql}) AS rn
       FROM filtered q
     ),
     total_cnt AS (SELECT count(*)::int AS total FROM numbered),
     bounds AS (
       SELECT tc.total,
              (GREATEST(1, LEAST(GREATEST(1, ceil(tc.total::numeric / ${pageSizeParam})::int), ${reqPageParam})) - 1) * ${pageSizeParam} AS offset_rows
       FROM total_cnt tc
     ),
     paged AS (
       SELECT n.rn, n.data, n.ev_data, n.mem_data
       FROM numbered n, bounds b
       WHERE n.rn > b.offset_rows AND n.rn <= b.offset_rows + ${pageSizeParam}
       ORDER BY n.rn ASC
     )
     SELECT b.total AS "totalMatching", p.data AS question, p.ev_data AS "evData", p.mem_data AS "memData"
     FROM bounds b
     LEFT JOIN paged p ON TRUE
     ORDER BY p.rn ASC NULLS LAST`,
    sqlParams
  );

  const openFlagsQuery = pool.query<{ question_id: string; cnt: number }>(
    `SELECT question_id, count(*)::int AS cnt FROM question_flags WHERE status = 'open' GROUP BY question_id`
  );

  const dailyTarget = Math.max(
    1,
    params.dailyQuestionTarget ?? params.progress?.dailyQuestionTarget ?? 10
  );

  const summaryPromise =
    includeSummary && progressMode === 'sql'
      ? Promise.all([
          queryPoolHealthAndMastered(pool, studentId, dailyTarget),
          importBatchesPromise.then((batches) => queryBatchSummaries(pool, studentId, batches)),
        ])
      : includeSummary && progressMode === 'memory' && params.progress
        ? importBatchesPromise.then((batches) =>
            queryMetaForMemorySummary(pool, params.progress!, dailyTarget, batches)
          )
        : null;

  const [pageRes, flagsRes, batches] = await Promise.all([
    pageQuery,
    openFlagsQuery,
    includeSummary ? importBatchesPromise : Promise.resolve([] as ImportBatchSummary[]),
  ]);

  const totalMatching = pageRes.rows[0]?.totalMatching ?? 0;
  const maxPage = Math.max(1, Math.ceil(totalMatching / pageSize));
  const page = Math.max(1, Math.min(maxPage, requestedPage));

  const pagedQuestions: QuestionItem[] = [];
  const progressByQuestionId: Record<string, QuestionProgressMeta> = {};
  const stimIds = new Set<string>();

  for (const r of pageRes.rows) {
    if (!r.question) continue;
    const q = deepFreeze(r.question);
    pagedQuestions.push(q);
    if (q.stimulusId) stimIds.add(q.stimulusId);
    if (progressMode === 'sql') {
      const evMap: Record<string, QuestionMasteryEvidence> = r.evData ? { [r.evData.evidenceKey]: r.evData } : {};
      const memMap: Record<string, QuestionMemoryState> = r.memData ? { [r.memData.questionFamilyId]: r.memData } : {};
      progressByQuestionId[q.questionId] = deriveQuestionProgressMeta(q, evMap, memMap);
    } else if (progressMode === 'memory' && params.progress) {
      progressByQuestionId[q.questionId] = deriveQuestionProgressMeta(q, params.progress.evidence, params.progress.memory);
    }
  }

  const stimuliById: Record<string, StimulusGroup> = {};
  if (stimIds.size > 0) {
    const stimRes = await pool.query<{ stimulus_id: string; data: StimulusGroup }>(
      'SELECT stimulus_id, data FROM stimuli WHERE stimulus_id = ANY($1::text[])',
      [Array.from(stimIds)]
    );
    for (const r of stimRes.rows) stimuliById[r.stimulus_id] = deepFreeze(r.data);
  }

  const openFlagsByQuestionId: Record<string, number> = {};
  for (const r of flagsRes.rows) openFlagsByQuestionId[r.question_id] = r.cnt;

  let poolHealth: PoolHealthSummary | undefined;
  let masteredLiveQuestionIds: string[] | undefined;
  let batchSummaries: BatchDirectorySummary[] | undefined;

  if (summaryPromise) {
    const resolved = await summaryPromise;
    if (Array.isArray(resolved)) {
      poolHealth = resolved[0].poolHealth;
      masteredLiveQuestionIds = resolved[0].masteredLiveQuestionIds;
      batchSummaries = resolved[1];
    } else {
      poolHealth = resolved.poolHealth;
      masteredLiveQuestionIds = resolved.masteredLiveQuestionIds;
      batchSummaries = resolved.batchSummaries;
    }
  }

  return {
    questions: pagedQuestions,
    stimuliById,
    totalMatching,
    page,
    pageSize,
    openFlagsByQuestionId,
    batches,
    ...(progressMode !== 'none' && { progressByQuestionId }),
    ...(poolHealth && { poolHealth, masteredLiveQuestionIds, batchSummaries }),
  };
}

async function queryPoolHealthAndMastered(
  pool: Pool,
  studentId: string | null,
  dailyQuestionTarget: number
): Promise<{ poolHealth: PoolHealthSummary; masteredLiveQuestionIds: string[] }> {
  if (!studentId) {
    const [{ byStudentId }, masteredIds] = [
      await queryPoolHealthByLearner(pool, ['__bank_only_none__'], dailyQuestionTarget),
      [] as string[],
    ];
    return {
      poolHealth: byStudentId.__bank_only_none__,
      masteredLiveQuestionIds: masteredIds,
    };
  }
  const [{ byStudentId }, masteredRes] = await Promise.all([
    queryPoolHealthByLearner(pool, [studentId], dailyQuestionTarget),
    pool.query<{ question_id: string }>(
      `WITH latest AS (
         SELECT DISTINCT ON (question_family_id)
           question_id, question_family_id, qc_status, pool_type, data->>'evidenceRevision' AS ev_rev
         FROM questions ORDER BY question_family_id, version DESC
       ),
       ev_for_student AS (
         SELECT evidence_key, ${EVIDENCE_FAMILY_EXPR} AS fam_id, data
         FROM question_evidence WHERE student_id = $1
       )
       SELECT q.question_id
       FROM latest q
       LEFT JOIN LATERAL (
         SELECT e.data FROM ev_for_student e
         WHERE (coalesce(q.ev_rev, '') <> '' AND e.evidence_key = q.question_family_id || '__' || q.ev_rev)
            OR e.fam_id = q.question_family_id
         ORDER BY (coalesce(q.ev_rev, '') <> '' AND e.evidence_key = q.question_family_id || '__' || q.ev_rev) DESC,
                  e.evidence_key ASC
         LIMIT 1
       ) ev ON TRUE
       LEFT JOIN question_memory mem ON mem.student_id = $1 AND mem.question_family_id = q.question_family_id
       WHERE q.qc_status = 'active' AND q.pool_type <> 'benchmark_holdout'
         AND (${COMPLETION_STATUS_EXPR}) = 'done'`,
      [studentId]
    ),
  ]);
  return {
    poolHealth: byStudentId[studentId],
    masteredLiveQuestionIds: masteredRes.rows.map((r) => r.question_id),
  };
}

async function queryMetaForMemorySummary(
  pool: Pool,
  progress: NonNullable<QuestionQueryParams['progress']>,
  dailyQuestionTarget: number,
  batches: ImportBatchSummary[]
): Promise<{
  poolHealth: PoolHealthSummary;
  masteredLiveQuestionIds: string[];
  batchSummaries: BatchDirectorySummary[];
}> {
  const { rows } = await pool.query<{
    questionId: string;
    questionFamilyId: string;
    version: number;
    section: SectionCode;
    formatType: QuestionItem['formatType'];
    poolType: QuestionItem['poolType'];
    qcStatus: QuestionItem['qcStatus'];
    stimulusId: string | null;
    batchId: string | null;
    batchLabel: string | null;
    createdAtIso: string | null;
    evidenceRevision: string | null;
    sourceType: QuestionItem['provenance']['sourceType'] | null;
    sourceReference: string | null;
  }>(`
    SELECT DISTINCT ON (question_family_id)
      question_id AS "questionId", question_family_id AS "questionFamilyId", version,
      section, format_type AS "formatType", pool_type AS "poolType", qc_status AS "qcStatus",
      stimulus_id AS "stimulusId", data->>'batchId' AS "batchId", data->>'batchLabel' AS "batchLabel",
      data->>'createdAtIso' AS "createdAtIso", data->>'evidenceRevision' AS "evidenceRevision",
      data#>>'{provenance,sourceType}' AS "sourceType", data#>>'{provenance,sourceReference}' AS "sourceReference"
    FROM questions ORDER BY question_family_id, version DESC
  `);
  const refs: QuestionMeta[] = rows.map((r) => ({
    questionId: r.questionId,
    questionFamilyId: r.questionFamilyId,
    version: r.version,
    section: r.section,
    formatType: r.formatType,
    poolType: r.poolType,
    qcStatus: r.qcStatus,
    stimulusId: r.stimulusId ?? undefined,
    batchId: r.batchId ?? undefined,
    batchLabel: r.batchLabel ?? undefined,
    createdAtIso: r.createdAtIso ?? undefined,
    evidenceRevision: r.evidenceRevision ?? undefined,
    provenance: { sourceType: r.sourceType ?? undefined, sourceReference: r.sourceReference ?? undefined },
  }));
  const progressByQid = new Map(
    refs.map((q) => [q.questionId, deriveQuestionProgressMeta(q, progress.evidence, progress.memory)])
  );
  const poolHealth = computePoolHealth({
    questions: refs,
    evidenceMap: progress.evidence,
    questionMemory: progress.memory,
    dailyQuestionTarget,
  });
  const masteredLiveQuestionIds = refs
    .filter(
      (q) =>
        q.qcStatus === 'active' &&
        q.poolType !== 'benchmark_holdout' &&
        progressByQid.get(q.questionId)?.completionStatus === 'done'
    )
    .map((q) => q.questionId);
  return {
    poolHealth,
    masteredLiveQuestionIds,
    batchSummaries: summarizeBatches(refs, batches, progressByQid),
  };
}
