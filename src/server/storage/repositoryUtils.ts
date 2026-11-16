import crypto from 'node:crypto';
import type {
  ImportBatchRecord,
  MediaAssetRecord,
  QuestionFlagRecord,
  QuestionItem,
  StimulusGroup,
} from '../../shared/contracts.ts';
import { getQuestionBatchTag } from '../../shared/engine.ts';
import type {
  AppRepository,
  BackupRestoreReport,
  CanonicalBackupBundle,
  QuestionQueryParams,
  QuestionQueryResult,
} from './repository.ts';

export function sha256Json(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function selectLatestByFamily(allQuestions: QuestionItem[]): QuestionItem[] {
  const latestByFamily = new Map<string, QuestionItem>();
  for (const q of allQuestions) {
    const prev = latestByFamily.get(q.questionFamilyId);
    if (!prev || q.version > prev.version) {
      latestByFamily.set(q.questionFamilyId, q);
    }
  }
  return Array.from(latestByFamily.values());
}

export function filterAndPaginateQuestions(input: {
  allQuestions: QuestionItem[];
  stimuliById: Record<string, StimulusGroup>;
  flags: QuestionFlagRecord[];
  batches: ImportBatchRecord[];
  params?: QuestionQueryParams;
}): QuestionQueryResult {
  const { allQuestions, stimuliById, flags, batches, params = {} } = input;
  const openFlagsByQuestionId: Record<string, number> = {};
  for (const f of flags) {
    if (f.status === 'open') {
      openFlagsByQuestionId[f.questionId] = (openFlagsByQuestionId[f.questionId] || 0) + 1;
    }
  }

  const base = params.includeHistorical ? allQuestions : selectLatestByFamily(allQuestions);
  const needle = (params.search || '').trim().toLowerCase();

  const filtered = base.filter((q) => {
    if (params.section && q.section !== params.section) return false;
    if (params.poolType && q.poolType !== params.poolType) return false;
    if (params.qcStatus && q.qcStatus !== params.qcStatus) return false;
    if (params.formatType && q.formatType !== params.formatType) return false;
    if (params.batchId && q.batchId !== params.batchId) return false;
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
  if (!Array.isArray(obj.users)) errors.push('Missing "users" array in backup.');

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
