import type { Pool, PoolClient } from 'pg';
import type { QuestionItem, StimulusGroup } from '../../shared/contracts.ts';
import type { QuestionMeta } from './repository.ts';
import { selectLatestByFamily } from './repositoryUtils.ts';

/**
 * Process-local copy of the question bank, revalidated against a tiny fingerprint query.
 *
 * The bank is ~7 MB of JSONB and is read by most student/admin routes. Reloading it per
 * request dominated latency and Neon egress. The fingerprint (row count + hash of each
 * row's xmin) changes on any INSERT/UPDATE/DELETE from any writer, including the CLI
 * push script and other serverless instances, and transfers ~40 bytes.
 *
 * Cached objects are deep-frozen: callers must clone before mutating.
 */
export interface BankSnapshot {
  fingerprint: string;
  all: readonly QuestionItem[];
  latest: readonly QuestionItem[];
  byId: ReadonlyMap<string, QuestionItem>;
  stimuliById: Readonly<Record<string, StimulusGroup>>;
  latestMeta: readonly QuestionMeta[];
}

// Latest version per family, metadata columns only. Postgres still detoasts each JSONB row
// to read these keys, so the result is cached by fingerprint like the full bank.
const LATEST_META_SQL = `SELECT DISTINCT ON (question_family_id)
    question_id AS "questionId", question_family_id AS "questionFamilyId", version, section,
    format_type AS "formatType", pool_type AS "poolType", qc_status AS "qcStatus", stimulus_id AS "stimulusId",
    data->>'batchId' AS "batchId", data->>'batchLabel' AS "batchLabel",
    data->>'createdAtIso' AS "createdAtIso", data->>'updatedAtIso' AS "updatedAtIso",
    data->>'evidenceRevision' AS "evidenceRevision",
    data#>>'{provenance,sourceType}' AS "sourceType", data#>>'{provenance,sourceReference}' AS "sourceReference"
  FROM questions ORDER BY question_family_id, version DESC`;

type MetaRow = Omit<QuestionMeta, 'provenance' | 'stimulusId' | 'batchId' | 'batchLabel' | 'createdAtIso' | 'updatedAtIso' | 'evidenceRevision'> & {
  stimulusId: string | null; batchId: string | null; batchLabel: string | null; createdAtIso: string | null;
  updatedAtIso: string | null; evidenceRevision: string | null;
  sourceType: QuestionItem['provenance']['sourceType'] | null; sourceReference: string | null;
};

function metaFromRow(r: MetaRow): QuestionMeta {
  return {
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
    updatedAtIso: r.updatedAtIso ?? undefined,
    evidenceRevision: r.evidenceRevision ?? undefined,
    provenance: { sourceType: r.sourceType ?? undefined, sourceReference: r.sourceReference ?? undefined },
  };
}

const FINGERPRINT_SQL = `SELECT
  (SELECT count(*)::text || ':' || coalesce(sum(hashtext(question_id || ':' || xmin::text)::bigint), 0)::text FROM questions)
  || '|' ||
  (SELECT count(*)::text || ':' || coalesce(sum(hashtext(stimulus_id || ':' || xmin::text)::bigint), 0)::text FROM stimuli)
  AS fp`;

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function toQuestionMeta(q: QuestionItem): QuestionMeta {
  return {
    questionId: q.questionId,
    questionFamilyId: q.questionFamilyId,
    version: q.version,
    section: q.section,
    formatType: q.formatType,
    poolType: q.poolType,
    qcStatus: q.qcStatus,
    stimulusId: q.stimulusId,
    batchId: q.batchId,
    batchLabel: q.batchLabel,
    createdAtIso: q.createdAtIso,
    updatedAtIso: q.updatedAtIso,
    evidenceRevision: q.evidenceRevision,
    // Older/starter rows may omit provenance even though the type requires it.
    provenance: { sourceType: q.provenance?.sourceType, sourceReference: q.provenance?.sourceReference },
  };
}

export class QuestionBankCache {
  private snapshot?: BankSnapshot;
  private metaSnapshot?: { fingerprint: string; latest: readonly QuestionMeta[] };
  private validatedAtMs = 0;
  private pending?: Promise<BankSnapshot>;
  private generation = 0;

  constructor(
    private readonly pool: Pool,
    /** Skip re-checking the fingerprint for reads this close together (e.g. Promise.all fan-out). */
    private readonly revalidateMs = 1000
  ) {}

  invalidate(): void {
    this.snapshot = undefined;
    this.metaSnapshot = undefined;
    this.validatedAtMs = 0;
    this.generation++;
  }

  /** Validated snapshot, loading the full bank only when it changed or was never loaded. */
  get(): Promise<BankSnapshot> {
    if (this.snapshot && Date.now() - this.validatedAtMs < this.revalidateMs) {
      return Promise.resolve(this.snapshot);
    }
    this.pending ??= this.refresh().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  /** Validated snapshot if one is already in memory; never triggers a full load. */
  async peek(): Promise<BankSnapshot | null> {
    const current = this.snapshot;
    if (!current) return null;
    if (Date.now() - this.validatedAtMs < this.revalidateMs) return current;
    if (this.pending) return this.pending;
    const fp = await this.fingerprint();
    if (this.snapshot !== current || fp !== current.fingerprint) return null;
    this.validatedAtMs = Date.now();
    return current;
  }

  /** Latest-version metadata, from the full snapshot when warm, else a cached SQL projection. */
  async getLatestMeta(): Promise<readonly QuestionMeta[]> {
    const warm = this.snapshot ? await this.peek() : null;
    if (warm) return warm.latestMeta;
    const generation = this.generation;
    if (this.metaSnapshot && this.metaSnapshot.fingerprint === (await this.fingerprint())) {
      return this.metaSnapshot.latest;
    }
    const loaded = await this.readConsistently(async (client) => {
      const { rows } = await client.query<MetaRow>(LATEST_META_SQL);
      return deepFreeze(rows.map(metaFromRow));
    });
    if (generation === this.generation) {
      this.metaSnapshot = { fingerprint: loaded.fingerprint, latest: loaded.value };
    }
    return loaded.value;
  }

  private async fingerprint(): Promise<string> {
    const { rows } = await this.pool.query<{ fp: string }>(FINGERPRINT_SQL);
    return rows[0].fp;
  }

  private async refresh(): Promise<BankSnapshot> {
    const generation = this.generation;
    if (this.snapshot) {
      const fp = await this.fingerprint();
      if (fp === this.snapshot.fingerprint && generation === this.generation) {
        this.validatedAtMs = Date.now();
        return this.snapshot;
      }
    }
    const snapshot = await this.load();
    // A local write during the load may not be reflected; serve it once but do not keep it.
    if (generation === this.generation) {
      this.snapshot = snapshot;
      this.validatedAtMs = Date.now();
    }
    return snapshot;
  }

  private async load(): Promise<BankSnapshot> {
    const { fingerprint, value } = await this.readConsistently(async (client) => {
      const questions = await client.query<{ data: QuestionItem }>('SELECT data FROM questions');
      const stimuli = await client.query<{ stimulus_id: string; data: StimulusGroup }>(
        'SELECT stimulus_id, data FROM stimuli'
      );
      return { questions: questions.rows, stimuli: stimuli.rows };
    });
    const all = value.questions.map((r) => deepFreeze(r.data));
    const stimuliById: Record<string, StimulusGroup> = {};
    for (const r of value.stimuli) stimuliById[r.stimulus_id] = deepFreeze(r.data);
    const latest = selectLatestByFamily(all);
    return {
      fingerprint,
      all: Object.freeze(all),
      latest: Object.freeze(latest),
      byId: new Map(all.map((q) => [q.questionId, q])),
      stimuliById: Object.freeze(stimuliById),
      latestMeta: deepFreeze(latest.map(toQuestionMeta)),
    };
  }

  /** Runs reads in one REPEATABLE READ snapshot so the fingerprint describes exactly those rows. */
  private async readConsistently<T>(read: (client: PoolClient) => Promise<T>): Promise<{ fingerprint: string; value: T }> {
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const fp = await client.query<{ fp: string }>(FINGERPRINT_SQL);
      const value = await read(client);
      await client.query('COMMIT');
      return { fingerprint: fp.rows[0].fp, value };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {
        discard = true;
      });
      throw error;
    } finally {
      client.release(discard);
    }
  }
}
