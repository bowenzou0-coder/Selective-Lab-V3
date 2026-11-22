import crypto from 'node:crypto';
import type {
  ImportBatchRecord,
  MediaAssetRecord,
  QuestionFlagRecord,
  QuestionItem,
  StimulusGroup,
} from '../../shared/contracts.ts';
import {
  computePoolHealth,
  deriveQuestionProgressMeta,
  qcStatusToPoolStatus,
  type BatchDirectorySummary,
  type QuestionProgressMeta,
} from '../../shared/bankStatus.ts';
import { getQuestionBatchTag } from '../../shared/engine.ts';
import type {
  AppRepository,
  BackupRestoreReport,
  CanonicalBackupBundle,
  ImportBatchSummary,
  QuestionMeta,
  QuestionQueryParams,
  QuestionQueryResult,
} from './repository.ts';

export function sha256Json(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function selectLatestByFamily<T extends Pick<QuestionItem, 'questionFamilyId' | 'version'>>(
  allQuestions: readonly T[]
): T[] {
  const latestByFamily = new Map<string, T>();
  for (const q of allQuestions) {
    const prev = latestByFamily.get(q.questionFamilyId);
    if (!prev || q.version > prev.version) {
      latestByFamily.set(q.questionFamilyId, q);
    }
  }
  return Array.from(latestByFamily.values());
}

export function summarizeBatches(
  questions: readonly QuestionMeta[],
  batches: readonly ImportBatchSummary[],
  progress: ReadonlyMap<string, QuestionProgressMeta>,
): BatchDirectorySummary[] {
  const labels = {
    PT1: 'Official Practice Test 1',
    PT2: 'Official Practice Test 2',
    PT3: 'Official Practice Test 3',
    SMOKE: 'Built-in Starter Pack',
    CUSTOM: 'Built-in Starter Pack',
  };
  const imported = new Map(batches.map((batch) => [batch.batchId, batch]));
  const summaries = new Map<string, BatchDirectorySummary>();
  for (const question of questions) {
    const tag = getQuestionBatchTag(question);
    const batchId = question.batchId || `tag_${tag}`;
    const importedBatch = imported.get(batchId);
    const batch = summaries.get(batchId) ?? {
      batchId,
      batchLabel: importedBatch?.batchLabel || question.batchLabel || (question.batchId ? batchId : labels[tag]),
      createdAtIso: importedBatch?.createdAtIso || question.createdAtIso || '',
      importedBy: importedBatch?.importedBy ||
        (question.provenance.sourceType === 'official_doe' ? 'official_seed' : 'bank'),
      total: 0,
      live: 0,
      unseen: 0,
      done: 0,
      paused: 0,
      archived: 0,
      questionIds: [],
    };
    batch.total++;
    batch.questionIds.push(question.questionId);
    batch[qcStatusToPoolStatus(question.qcStatus)]++;
    const status = progress.get(question.questionId)?.completionStatus;
    if (status === 'unseen' || status === 'done') batch[status]++;
    summaries.set(batchId, batch);
  }
  return Array.from(summaries.values()).sort(
    (a, b) => (Date.parse(b.createdAtIso) || 0) - (Date.parse(a.createdAtIso) || 0),
  );
}

export function filterAndPaginateQuestions(input: {
  allQuestions: readonly QuestionItem[];
  /** Pre-computed latest versions (the Postgres bank cache keeps these). */
  latestQuestions?: readonly QuestionItem[];
  stimuliById: Readonly<Record<string, StimulusGroup>>;
  flags: QuestionFlagRecord[];
  batches: ImportBatchSummary[];
  params?: QuestionQueryParams;
}): QuestionQueryResult {
  const { allQuestions, stimuliById, flags, batches, params = {} } = input;
  const openFlagsByQuestionId: Record<string, number> = {};
  for (const f of flags) {
    if (f.status === 'open') {
      openFlagsByQuestionId[f.questionId] = (openFlagsByQuestionId[f.questionId] || 0) + 1;
    }
  }

  const latest = input.latestQuestions ?? selectLatestByFamily(allQuestions);
  const base = params.includeHistorical ? allQuestions : latest;
  const { progress } = params;
  const progressByQid = new Map<string, QuestionProgressMeta>();
  if (progress) {
    for (const question of base) {
      progressByQid.set(question.questionId, deriveQuestionProgressMeta(question, progress.evidence, progress.memory));
    }
  }
  const needle = (params.search || '').trim().toLowerCase();

  const filtered = base.filter((q) => {
    if (params.section && q.section !== params.section) return false;
    if (params.poolType && q.poolType !== params.poolType) return false;
    if (params.qcStatus && q.qcStatus !== params.qcStatus) return false;
    if (params.poolStatus && qcStatusToPoolStatus(q.qcStatus) !== params.poolStatus) return false;
    if (params.completionStatus && progressByQid.get(q.questionId)?.completionStatus !== params.completionStatus) {
      return false;
    }
    if (params.formatType && q.formatType !== params.formatType) return false;
    if (params.batchId) {
      const batchId = params.batchId.startsWith('tag_') ? `tag_${getQuestionBatchTag(q)}` : q.batchId;
      if (params.batchId !== batchId) return false;
    }
    if (params.batchTag && getQuestionBatchTag(q) !== params.batchTag) return false;
    if (params.skillId) {
      const targetSkillId = params.skillId;
      if (
        !q.parts.some(
          (p) => p.skillId === targetSkillId || p.secondarySkillIds?.includes(targetSkillId)
        )
      ) {
        return false;
      }
    }
    if (params.flaggedOnly && !(openFlagsByQuestionId[q.questionId] > 0)) return false;

    const stim = q.stimulusId ? stimuliById[q.stimulusId] : undefined;
    if (params.missingVisual) {
      const hasQVisual = Boolean(q.visual && q.visual.visualType !== 'none');
      const hasStimVisual = Boolean(stim?.visual && stim.visual.visualType !== 'none');
      if (hasQVisual || hasStimVisual) return false;
    }
    if (params.missingExplanation) {
      const missingExp = q.parts.some(
        (p) => q.formatType !== 'WRIT_TYPED_TASK' && (!p.workedExplanation || !p.workedExplanation.trim())
      );
      if (!missingExp) return false;
    }

    if (needle) {
      const partsHay = q.parts
        .map(
          (p) =>
            `${p.partId} ${p.promptText} ${p.skillId} ${(p.secondarySkillIds || []).join(' ')} ${(p.trapTags || []).join(' ')} ${p.workedExplanation || ''} ${p.options.map((o) => `${o.key} ${o.text}`).join(' ')}`
        )
        .join(' ');
      const stimHay = stim
        ? `${stim.stimulusId} ${stim.title || ''} ${stim.preamble || ''} ${stim.mainTextMarkdown || ''} ${(stim.extracts || []).map((e) => `${e.label} ${e.title || ''} ${e.bodyMarkdown}`).join(' ')}`
        : '';
      const fullHay = `${q.questionId} ${q.questionFamilyId} ${q.stemPrefix || ''} ${q.batchId || ''} ${q.batchLabel || ''} ${q.provenance.sourceReference || ''} ${partsHay} ${stimHay}`.toLowerCase();
      if (!fullHay.includes(needle)) return false;
    }

    return true;
  });

  const sort = params.sort || 'id_asc';
  filtered.sort((a, b) => {
    if (sort === 'updated_desc') {
      const ta = Date.parse(a.updatedAtIso || a.createdAtIso || '') || 0;
      const tb = Date.parse(b.updatedAtIso || b.createdAtIso || '') || 0;
      if (tb !== ta) return tb - ta;
    } else if (sort === 'version_desc') {
      if (b.version !== a.version) return b.version - a.version;
    }
    return a.questionId.localeCompare(b.questionId, undefined, { numeric: true });
  });

  const pageSize = Math.max(1, Math.min(200, Number(params.pageSize || 50)));
  const totalMatching = filtered.length;
  const maxPage = Math.max(1, Math.ceil(totalMatching / pageSize));
  const page = Math.max(1, Math.min(maxPage, Number(params.page || 1)));
  const start = (page - 1) * pageSize;
  const pagedQuestions = filtered.slice(start, start + pageSize);

  const pageStimuliById: Record<string, StimulusGroup> = {};
  for (const q of pagedQuestions) {
    if (q.stimulusId && stimuliById[q.stimulusId]) {
      pageStimuliById[q.stimulusId] = stimuliById[q.stimulusId];
    }
  }

  return {
    questions: pagedQuestions,
    stimuliById: pageStimuliById,
    totalMatching,
    page,
    pageSize,
    openFlagsByQuestionId,
    batches,
    ...(progress && {
      progressByQuestionId: Object.fromEntries(pagedQuestions.map((q) => [q.questionId, progressByQid.get(q.questionId)!])),
      poolHealth: computePoolHealth({
        questions: latest,
        evidenceMap: progress.evidence,
        questionMemory: progress.memory,
        dailyQuestionTarget: progress.dailyQuestionTarget,
      }),
      masteredLiveQuestionIds: latest
        .filter((q) => q.qcStatus === 'active' && q.poolType !== 'benchmark_holdout' &&
          progressByQid.get(q.questionId)?.completionStatus === 'done')
        .map((q) => q.questionId),
      batchSummaries: summarizeBatches(latest, batches, progressByQid),
    }),
  };
}

export function finalizeBackupBundle(
  partial: Omit<CanonicalBackupBundle, 'schemaVersion' | 'counts' | 'checksums' | 'bundleSha256'> & {
    backendName: AppRepository['backendName'];
  }
): CanonicalBackupBundle {
  const counts = {
    stimuli: partial.stimuli.length,
    questions: partial.questions.length,
    importBatches: partial.importBatches.length,
    configVersions: partial.configVersions.length,
    mediaAssets: partial.mediaAssets.length,
    questionFlags: partial.questionFlags.length,
    users: partial.users.length,
    sessions: partial.users.reduce((sum, u) => sum + u.sessions.length, 0),
    partAttempts: partial.users.reduce((sum, u) => sum + u.partAttempts.length, 0),
    questionEvidence: partial.users.reduce((sum, u) => sum + u.questionEvidence.length, 0),
    writingSubmissions: partial.users.reduce((sum, u) => sum + u.writingSubmissions.length, 0),
    dailyFocusPlans: partial.users.reduce((sum, u) => sum + (u.dailyFocusPlans?.length ?? 0), 0),
  };

  const checksums: Record<string, string> = {
    stimuli: sha256Json(partial.stimuli),
    questions: sha256Json(partial.questions),
    importBatches: sha256Json(partial.importBatches),
    configVersions: sha256Json(partial.configVersions),
    mediaAssets: sha256Json(partial.mediaAssets),
    questionFlags: sha256Json(partial.questionFlags),
    users: sha256Json(partial.users),
  };

  const bundleSha256 = sha256Json({
    schemaVersion: 'v3_canonical_1.0',
    counts,
    checksums,
  });

  return {
    schemaVersion: 'v3_canonical_1.0',
    exportedAtIso: partial.exportedAtIso,
    backendName: partial.backendName,
    counts,
    checksums,
    bundleSha256,
    stimuli: partial.stimuli,
    questions: partial.questions,
    importBatches: partial.importBatches,
    configVersions: partial.configVersions,
    mediaAssets: partial.mediaAssets,
    questionFlags: partial.questionFlags,
    users: partial.users,
  };
}

export function validateIncomingBackupBundle(raw: unknown): {
  valid: boolean;
  checksumVerified: boolean;
  bundle: CanonicalBackupBundle | null;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!raw || typeof raw !== 'object') {
    return {
      valid: false,
      checksumVerified: false,
      bundle: null,
      errors: ['Backup payload must be a JSON object.'],
      warnings: [],
    };
  }

  const obj = raw as Partial<CanonicalBackupBundle>;
  if (obj.schemaVersion !== 'v3_canonical_1.0') {
    errors.push(`Unsupported backup schemaVersion "${String(obj.schemaVersion)}". Expected "v3_canonical_1.0".`);
  }
  if (!Array.isArray(obj.stimuli)) errors.push('Missing "stimuli" array in backup.');
  if (!Array.isArray(obj.questions)) errors.push('Missing "questions" array in backup.');
  if (!Array.isArray(obj.configVersions)) errors.push('Missing "configVersions" array in backup.');
  if (!Array.isArray(obj.users)) {
    errors.push('Missing "users" array in backup.');
  } else {
    for (const user of obj.users) {
      if (user?.dailyFocusPlans !== undefined && !Array.isArray(user.dailyFocusPlans)) {
        errors.push(`Invalid "dailyFocusPlans" field for user "${String(user?.uid || '')}".`);
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, checksumVerified: false, bundle: null, errors, warnings };
  }

  const b = obj as CanonicalBackupBundle;
  let checksumVerified = true;
  const computedChecksums: Record<string, string> = {
    stimuli: sha256Json(b.stimuli),
    questions: sha256Json(b.questions),
    importBatches: sha256Json(b.importBatches || []),
    configVersions: sha256Json(b.configVersions),
    mediaAssets: sha256Json(b.mediaAssets || []),
    questionFlags: sha256Json(b.questionFlags || []),
    users: sha256Json(b.users),
  };

  if (!b.checksums || !b.bundleSha256) {
    checksumVerified = false;
    errors.push('Backup missing section checksums or bundleSha256.');
  } else {
    for (const [k, digest] of Object.entries(computedChecksums)) {
      if (b.checksums[k] !== digest) {
        checksumVerified = false;
        errors.push(`Backup checksum mismatch for section "${k}".`);
      }
    }
    const expectedRoot = sha256Json({
      schemaVersion: b.schemaVersion,
      counts: b.counts,
      checksums: b.checksums,
    });
    if (b.bundleSha256 !== expectedRoot) {
      checksumVerified = false;
      errors.push('Root bundleSha256 integrity verification failed.');
    }
  }

  return {
    valid: errors.length === 0 && checksumVerified,
    checksumVerified,
    bundle: errors.length === 0 ? b : null,
    errors,
    warnings,
  };
}

export function emptyRestoreReport(
  valid: boolean,
  dryRun: boolean,
  checksumVerified: boolean,
  errors: string[] = [],
  warnings: string[] = []
): BackupRestoreReport {
  return {
    valid,
    dryRun,
    checksumVerified,
    errors,
    warnings,
    wouldCreate: {},
    wouldSkipExisting: {},
    applied: {},
  };
}

export type MediaAssetLookup = Record<string, MediaAssetRecord>;
