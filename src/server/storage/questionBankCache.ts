import type { Pool } from 'pg';
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
    const client = await this.pool.connect();
    let discard = false;
    try {
      // One consistent snapshot so the fingerprint always describes the rows we keep.
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const fp = await client.query<{ fp: string }>(FINGERPRINT_SQL);
      const questions = await client.query<{ data: QuestionItem }>('SELECT data FROM questions');
      const stimuli = await client.query<{ stimulus_id: string; data: StimulusGroup }>(
        'SELECT stimulus_id, data FROM stimuli'
      );
      await client.query('COMMIT');
      const all = questions.rows.map((r) => deepFreeze(r.data));
      const stimuliById: Record<string, StimulusGroup> = {};
      for (const r of stimuli.rows) stimuliById[r.stimulus_id] = deepFreeze(r.data);
      return {
        fingerprint: fp.rows[0].fp,
        all: Object.freeze(all),
        latest: Object.freeze(selectLatestByFamily(all)),
        byId: new Map(all.map((q) => [q.questionId, q])),
        stimuliById: Object.freeze(stimuliById),
      };
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
