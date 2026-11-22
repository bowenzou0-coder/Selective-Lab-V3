import type { Pool, PoolClient } from 'pg';
import type { QuestionItem, StimulusGroup } from '../../shared/contracts.ts';
import type { QuestionMeta, QuestionSelectionItem } from './repository.ts';
import { selectLatestByFamily } from './repositoryUtils.ts';

/**
 * Process-local copy of the question bank, revalidated against a tiny fingerprint query.
 *
 * The full bank is ~7.4 MB of JSONB and is only loaded when explicitly requested (e.g.
 * backup/preflight). Normal routes use SQL aggregates/pagination or the slim selection
 * index (~110 KB). The fingerprint (row count + hash of each row's xmin) changes on any
 * INSERT/UPDATE/DELETE from any writer and transfers ~40 bytes.
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
  latestSelection: readonly QuestionSelectionItem[];
}

// Latest version per family, metadata columns only.
const LATEST_META_SQL = `SELECT DISTINCT ON (question_family_id)
    question_id AS "questionId", question_family_id AS "questionFamilyId", version, section,
    format_type AS "formatType", pool_type AS "poolType", qc_status AS "qcStatus", stimulus_id AS "stimulusId",
    data->>'batchId' AS "batchId", data->>'batchLabel' AS "batchLabel",
    data->>'createdAtIso' AS "createdAtIso", data->>'updatedAtIso' AS "updatedAtIso",
    data->>'evidenceRevision' AS "evidenceRevision",
    data#>>'{provenance,sourceType}' AS "sourceType", data#>>'{provenance,sourceReference}' AS "sourceReference"
  FROM questions ORDER BY question_family_id, version DESC`;

export const SELECTION_COLUMNS_SQL = `
    question_id AS "questionId", question_family_id AS "questionFamilyId", version, section,
    format_type AS "formatType", pool_type AS "poolType", qc_status AS "qcStatus", stimulus_id AS "stimulusId",
    data->>'batchId' AS "batchId", data->>'batchLabel' AS "batchLabel",
    data->>'evidenceRevision' AS "evidenceRevision",
    data#>>'{provenance,sourceType}' AS "sourceType", data#>>'{provenance,sourceReference}' AS "sourceReference",
    ARRAY(SELECT p->>'partId' FROM jsonb_array_elements(data->'parts') WITH ORDINALITY AS t(p, idx) ORDER BY idx) AS "partIds",
    ARRAY(SELECT p->>'skillId' FROM jsonb_array_elements(data->'parts') WITH ORDINALITY AS t(p, idx) ORDER BY idx) AS "skillIds",
    ARRAY(SELECT coalesce((p->>'difficultyInitial')::real, 3.0) FROM jsonb_array_elements(data->'parts') WITH ORDINALITY AS t(p, idx) ORDER BY idx) AS "difficulties",
    ARRAY(SELECT CASE WHEN jsonb_typeof(p->'difficultyCalibrated') = 'number' THEN (p->>'difficultyCalibrated')::real ELSE NULL END FROM jsonb_array_elements(data->'parts') WITH ORDINALITY AS t(p, idx) ORDER BY idx) AS "calibrated",
    ARRAY(SELECT coalesce((p->>'targetTimeSec')::int, 60) FROM jsonb_array_elements(data->'parts') WITH ORDINALITY AS t(p, idx) ORDER BY idx) AS "targetSecs",
    coalesce((SELECT jsonb_agg(coalesce(p->'secondarySkillIds', 'null'::jsonb) ORDER BY idx) FROM jsonb_array_elements(data->'parts') WITH ORDINALITY AS t(p, idx)), '[]'::jsonb) AS "secondarySkills"`;

const LATEST_SELECTION_SQL = `SELECT DISTINCT ON (question_family_id) ${SELECTION_COLUMNS_SQL}
  FROM questions ORDER BY question_family_id, version DESC`;

type MetaRow = Omit<QuestionMeta, 'provenance' | 'stimulusId' | 'batchId' | 'batchLabel' | 'createdAtIso' | 'updatedAtIso' | 'evidenceRevision'> & {
  stimulusId: string | null; batchId: string | null; batchLabel: string | null; createdAtIso: string | null;
  updatedAtIso: string | null; evidenceRevision: string | null;
  sourceType: QuestionItem['provenance']['sourceType'] | null; sourceReference: string | null;
};

export type SelectionRow = Omit<
  QuestionSelectionItem,
  'provenance' | 'parts' | 'stimulusId' | 'batchId' | 'batchLabel' | 'evidenceRevision'
> & {
  stimulusId: string | null;
  batchId: string | null;
  batchLabel: string | null;
  evidenceRevision: string | null;
  sourceType: QuestionItem['provenance']['sourceType'] | null;
  sourceReference: string | null;
  partIds: string[];
  skillIds: string[];
  difficulties: number[];
  calibrated: (number | null)[];
  targetSecs: number[];
  secondarySkills: (string[] | null)[];
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

export function selectionFromRow(r: SelectionRow): QuestionSelectionItem {
  const partIds = r.partIds || [];
  const skillIds = r.skillIds || [];
  const difficulties = r.difficulties || [];
  const calibrated = r.calibrated || [];
  const targetSecs = r.targetSecs || [];
  const secondarySkills = r.secondarySkills || [];
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
    evidenceRevision: r.evidenceRevision ?? undefined,
    provenance: { sourceType: r.sourceType ?? undefined, sourceReference: r.sourceReference ?? undefined },
    parts: partIds.map((partId, idx) => {
      const sec = secondarySkills[idx];
      const cal = calibrated[idx];
      return {
        partId,
        skillId: skillIds[idx] || '',
        ...(Array.isArray(sec) && sec.length > 0 ? { secondarySkillIds: sec } : {}),
        difficultyInitial: Number(difficulties[idx] ?? 3),
        ...(typeof cal === 'number' ? { difficultyCalibrated: cal } : {}),
        targetTimeSec: Number(targetSecs[idx] ?? 60),
      };
    }),
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

export function toQuestionSelection(q: QuestionItem): QuestionSelectionItem {
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
    evidenceRevision: q.evidenceRevision,
    provenance: { sourceType: q.provenance?.sourceType, sourceReference: q.provenance?.sourceReference },
    parts: q.parts.map((p) => ({
      partId: p.partId,
      skillId: p.skillId,
      ...(p.secondarySkillIds ? { secondarySkillIds: [...p.secondarySkillIds] } : {}),
      difficultyInitial: p.difficultyInitial,
      ...(p.difficultyCalibrated !== undefined ? { difficultyCalibrated: p.difficultyCalibrated } : {}),
      targetTimeSec: p.targetTimeSec,
    })),
  };
}

export class QuestionBankCache {
  private snapshot?: BankSnapshot;
  private metaSnapshot?: { fingerprint: string; latest: readonly QuestionMeta[] };
  private selectionSnapshot?: { fingerprint: string; latest: readonly QuestionSelectionItem[] };
  private validatedAtMs = 0;
  private validatedMetaAtMs = 0;
  private validatedSelectionAtMs = 0;
  private pending?: Promise<BankSnapshot>;
  private metaPending?: Promise<readonly QuestionMeta[]>;
  private selectionPending?: Promise<readonly QuestionSelectionItem[]>;
  private generation = 0;

  constructor(
    private readonly pool: Pool,
    /** Skip re-checking the fingerprint for reads this close together (e.g. Promise.all fan-out). */
    private readonly revalidateMs = 1000
  ) {}

  invalidate(): void {
    this.snapshot = undefined;
    this.metaSnapshot = undefined;
    this.selectionSnapshot = undefined;
    this.validatedAtMs = 0;
    this.validatedMetaAtMs = 0;
    this.validatedSelectionAtMs = 0;
    this.generation++;
  }

  hasWarmSnapshot(): boolean {
    return Boolean(this.snapshot);
  }

  hasWarmSelection(): boolean {
    return Boolean(this.snapshot || this.selectionSnapshot);
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
    if (this.metaSnapshot && Date.now() - this.validatedMetaAtMs < this.revalidateMs) {
      return this.metaSnapshot.latest;
    }
    this.metaPending ??= this.refreshMeta().finally(() => {
      this.metaPending = undefined;
    });
    return this.metaPending;
  }

  /** Latest-version slim selection items, from full snapshot when warm, else cached slim SQL (~110 KB). */
  async getLatestSelection(): Promise<readonly QuestionSelectionItem[]> {
    const warm = this.snapshot ? await this.peek() : null;
    if (warm) return warm.latestSelection;
    if (this.selectionSnapshot && Date.now() - this.validatedSelectionAtMs < this.revalidateMs) {
      return this.selectionSnapshot.latest;
    }
    this.selectionPending ??= this.refreshSelection().finally(() => {
      this.selectionPending = undefined;
    });
    return this.selectionPending;
  }

  private async refreshMeta(): Promise<readonly QuestionMeta[]> {
    const generation = this.generation;
    if (this.metaSnapshot) {
      const fp = await this.fingerprint();
      if (fp === this.metaSnapshot.fingerprint && generation === this.generation) {
        this.validatedMetaAtMs = Date.now();
        return this.metaSnapshot.latest;
      }
    }
    const loaded = await this.readConsistently(async (client) => {
      const { rows } = await client.query<MetaRow>(LATEST_META_SQL);
      return deepFreeze(rows.map(metaFromRow));
    });
    if (generation === this.generation) {
      this.metaSnapshot = { fingerprint: loaded.fingerprint, latest: loaded.value };
      this.validatedMetaAtMs = Date.now();
    }
    return loaded.value;
  }

  private async refreshSelection(): Promise<readonly QuestionSelectionItem[]> {
    const generation = this.generation;
    if (this.selectionSnapshot) {
      const fp = await this.fingerprint();
      if (fp === this.selectionSnapshot.fingerprint && generation === this.generation) {
        this.validatedSelectionAtMs = Date.now();
        return this.selectionSnapshot.latest;
      }
    }
    const loaded = await this.readConsistently(async (client) => {
      const { rows } = await client.query<SelectionRow>(LATEST_SELECTION_SQL);
      return deepFreeze(rows.map(selectionFromRow));
    });
    if (generation === this.generation) {
      this.selectionSnapshot = { fingerprint: loaded.fingerprint, latest: loaded.value };
      this.validatedSelectionAtMs = Date.now();
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
      latestSelection: deepFreeze(latest.map(toQuestionSelection)),
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
