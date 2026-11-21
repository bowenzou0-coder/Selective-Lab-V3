import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { checksum, learnerCollections, MigrationError, record, rootCollections } from './migrate-firestore-source.ts';
import type { RecordData, SourceDocument, SourceDump } from './migrate-firestore-source.ts';

export const tables = {
  users: ['uid', 'role', 'display_name', 'email', 'updated_at'],
  stimuli: ['stimulus_id', 'stimulus_family_id', 'version', 'content_hash', 'section', 'data', 'created_at'],
  questions: ['question_id', 'question_family_id', 'version', 'content_hash', 'section', 'format_type', 'pool_type', 'qc_status', 'stimulus_id', 'data', 'created_at'],
  import_batches: ['batch_id', 'batch_label', 'data', 'created_at'],
  admin_config_versions: ['config_version_id', 'version_number', 'notes', 'config', 'created_at'],
  media_assets: ['asset_id', 'data', 'created_at'],
  question_flags: ['flag_id', 'question_id', 'status', 'data', 'created_at'],
  sessions: ['session_id', 'student_id', 'mode', 'status', 'is_sandbox', 'data', 'started_at', 'completed_at'],
  session_snapshots: ['session_id', 'student_id', 'snapshots', 'created_at'],
  part_attempts: ['attempt_id', 'student_id', 'session_id', 'question_id', 'part_id', 'skill_id', 'is_correct', 'is_sandbox', 'data', 'created_at'],
  skill_states: ['student_id', 'skill_id', 'data'],
  question_memory: ['student_id', 'question_family_id', 'data'],
  question_evidence: ['student_id', 'evidence_key', 'data'],
  writing_submissions: ['submission_id', 'student_id', 'session_id', 'question_id', 'data', 'submitted_at'],
  writing_evaluations: ['evaluation_id', 'submission_id', 'data', 'created_at'],
  daily_focus_plans: ['student_id', 'plan_date', 'data'],
} as const;
export type Table = keyof typeof tables;
export const tableNames = Object.keys(tables) as Table[];
export type SqlRows = Record<Table, (string | number | boolean | null)[][]>;

const compositeTables = new Set<Table>(['skill_states', 'question_memory', 'question_evidence', 'daily_focus_plans']);
const qcStatuses = ['draft', 'verified', 'active', 'quarantined', 'retired'];
const reservedUids = (uid: string) => uid === 'default-student' || uid.startsWith('google_');

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function requiredText(value: unknown, field: string): string {
  const text = optionalText(value);
  if (!text || text.includes('\0')) throw new MigrationError(`Missing or invalid ${field}.`);
  return text;
}

function checkedEnum(value: unknown, allowed: string[], field: string): string {
  const text = requiredText(value, field);
  if (!allowed.includes(text)) throw new MigrationError(`Unsupported ${field}.`);
  return text;
}

function integer(value: unknown, field: string, minimum = 1): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    throw new MigrationError(`Missing or invalid ${field}.`);
  }
  return value;
}

function date(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new MigrationError(`Missing or invalid ${field} timestamp.`);
  }
  return value;
}

function docId(doc: SourceDocument, field: string, value = doc.data[field]): string {
  const id = requiredText(value ?? doc.id, field);
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '__').slice(0, 128);
  if (id !== doc.id && safe !== doc.id) throw new MigrationError(`Source document path disagrees with ${field}.`);
  return id;
}

function assertOwner(data: RecordData, uid: string) {
  for (const field of ['uid', 'userId', 'studentId']) {
    if (data[field] != null && data[field] !== uid) {
      throw new MigrationError(`A learner record has a conflicting ${field}.`);
    }
  }
}

function list(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new MigrationError(`Missing or invalid ${field} list.`);
  return value;
}

async function sourceMedia(asset: RecordData, mediaDir?: string): Promise<Buffer | undefined> {
  if (asset.storageProvider === 'inline_data' && typeof asset.url === 'string') {
    const match = asset.url.match(/^data:image\/(?:png|jpeg|webp|svg\+xml);base64,([A-Za-z0-9+/]+={0,2})$/);
    if (match) return Buffer.from(match[1], 'base64');
  }
  const url = optionalText(asset.url);
  const key = asset.storageProvider === 'local_temp' && url?.startsWith('/assets/uploads/')
    ? url.slice('/assets/uploads/'.length)
    : optionalText(asset.objectKey);
  if (!key || !key.split('/').every((segment) => /^[\w.-]+$/.test(segment) && segment !== '.' && segment !== '..')) {
    return undefined;
  }
  const directory = mediaDir ?? (asset.storageProvider === 'local_temp' ? 'public/assets/uploads' : undefined);
  return directory ? readFile(path.join(directory, key)).catch((err) => {
    if (err?.code === 'ENOENT') return undefined;
    throw new MigrationError('Could not read a staged media file.');
  }) : undefined;
}

export async function planMigration(dump: SourceDump, mediaDir?: string) {
  const rows = Object.fromEntries(tableNames.map<[Table, SqlRows[Table]]>((table) => [table, []])) as SqlRows;
  const keys = new Map(tableNames.map((table) => [table, new Set<string>()]));
  const collectionCounts: Record<string, number> = {};
  const seenCollections = new Set<string>();
  const report = {
    documents: collectionCounts,
    unlinkedProfiles: 0,
    authLinksWithoutProfile: 0,
    historicalQuestionsWithoutBankRow: 0,
    questionsWithoutEvidenceRevision: 0,
    attemptsWithoutEvidenceRevision: 0,
    sessionsWithIncompleteSnapshots: 0,
    snapshots: 0,
    inProgressSessions: 0,
    missingSessionConfigVersions: 0,
    flagsWithoutProfile: 0,
    overridesApplied: 0,
    mediaBytesVerified: 0,
    unavailableMedia: 0,
    missingBundledVisualPaths: 0,
    externalVisualUrls: 0,
  };

  function scan(collection: string, label = collection): SourceDocument[] {
    const docs = dump.collections[collection];
    if (!Array.isArray(docs)) throw new MigrationError(`Source export lacks the ${label} collection scan.`);
    seenCollections.add(collection);
    collectionCounts[label] = (collectionCounts[label] ?? 0) + docs.length;
    const ids = new Set();
    for (const doc of docs) {
      if (!doc?.id || typeof doc.id !== 'string' || doc.id.includes('/') || ids.has(doc.id)) {
        throw new MigrationError(`Invalid or duplicate document ID in ${label}.`);
      }
      ids.add(doc.id);
      record(doc.data, label);
      date(doc.createdAt, 'document creation');
      date(doc.updatedAt, 'document update');
    }
    return docs;
  }

  function add(table: Table, ...values: SqlRows[Table][number]) {
    const key = JSON.stringify(values.slice(0, compositeTables.has(table) ? 2 : 1));
    const unique = keys.get(table)!;
    if (unique.has(key)) throw new MigrationError(`Source rows have a duplicate Postgres key in ${table}.`);
    if (values.length !== tables[table].length) throw new MigrationError(`Unexpected column count in ${table}.`);
    unique.add(key);
    rows[table].push(values);
  }

  const source = Object.fromEntries(rootCollections.map((name) => [name, scan(name)]));
  if (source.bank_questions.length === 0) throw new MigrationError('Source question bank is empty. Confirm the legacy project and named database.');
  const profiles = new Set(source.users.map((user) => user.id));
  const links = new Map<string, SourceDump['links'][number]>();
  const identityMap: Record<string, string> = Object.create(null);
  for (const link of dump.links) {
    if (!link || !/^[A-Za-z0-9_-]{1,128}$/.test(link.uid) || reservedUids(link.uid) ||
      !/^[A-Za-z0-9_-]{1,255}$/.test(link.googleSub)) {
      throw new MigrationError('Invalid Google identity mapping.');
    }
    if (!profiles.has(link.uid)) {
      report.authLinksWithoutProfile++;
      continue;
    }
    if ((links.has(link.uid) && links.get(link.uid)!.googleSub !== link.googleSub) ||
      (identityMap[link.googleSub] && identityMap[link.googleSub] !== link.uid)) {
      throw new MigrationError('Conflicting Firebase UID and Google subject mappings.');
    }
    identityMap[link.googleSub] = link.uid;
    links.set(link.uid, link);
  }

  const mediaUrlMap = new Map<string, string>();
  const unavailableMedia = new Set<string>();
  for (const doc of source.media_assets) {
    const assetId = docId(doc, 'assetId');
    const url = requiredText(doc.data.url, 'media URL');
    requiredText(doc.data.objectKey, 'media object key');
    requiredText(doc.data.mimeType, 'media MIME type');
    const sha256 = requiredText(doc.data.sha256, 'media SHA-256');
    const size = integer(doc.data.sizeBytes, 'media size', 0);
    const createdAtIso = date(doc.data.createdAtIso ?? doc.data.createdAt ?? doc.createdAt, 'media creation');
    const asset: RecordData = { ...doc.data, assetId, createdAtIso };
    const bytes = await sourceMedia(asset, mediaDir);
    if (bytes) {
      if (bytes.length !== size || checksum(bytes) !== sha256.toLowerCase()) {
        throw new MigrationError('Staged media bytes do not match the source size and SHA-256.');
      }
      const newUrl = `/api/media/${encodeURIComponent(assetId)}`;
      if (mediaUrlMap.has(url) && mediaUrlMap.get(url) !== newUrl) {
        throw new MigrationError('Multiple media records share a source URL.');
      }
      mediaUrlMap.set(url, newUrl);
      Object.assign(asset, {
        url: newUrl,
        storageProvider: 'postgres',
        bytesBase64: bytes.toString('base64'),
        legacyStorageProvider: doc.data.storageProvider,
        legacyUrl: url,
      });
      report.mediaBytesVerified++;
    } else {
      unavailableMedia.add(url);
    }
    add('media_assets', assetId, JSON.stringify(asset), createdAtIso);
  }

  const bundledUrls = new Set<string>();
  const externalUrls = new Set<string>();
  function rewriteVisualUrls(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(rewriteVisualUrls);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => {
      if (key === 'imageUrl' && typeof child === 'string') {
        const mapped = mediaUrlMap.get(child);
        if (mapped) return [key, mapped];
        if (child.startsWith('/api/media/') || child.startsWith('/assets/uploads/')) unavailableMedia.add(child);
        else if (child.startsWith('/assets/')) bundledUrls.add(child);
        else if (/^https?:\/\//i.test(child)) externalUrls.add(child);
      }
      return [key, rewriteVisualUrls(child)];
    }));
  }
  const json = (value: unknown) => JSON.stringify(rewriteVisualUrls(value));

  const stimulusIds = new Set<string>();
  for (const doc of source.bank_stimuli) {
    const data = record(doc.data.payload ?? doc.data, 'stimulus payload');
    const id = docId(doc, 'stimulusId', data.stimulusId ?? doc.data.stimulusId);
    const family = requiredText(data.stimulusFamilyId ?? doc.data.stimulusFamilyId, 'stimulus family ID');
    const version = integer(data.version ?? doc.data.version, 'stimulus version');
    const section = checkedEnum(data.section ?? doc.data.section, ['READ', 'MATH', 'THINK', 'WRIT'], 'stimulus section');
    stimulusIds.add(id);
    add('stimuli', id, family, version, optionalText(data.contentHash) ?? null, section,
      json({ ...data, stimulusId: id, stimulusFamilyId: family, version, section }),
      date(data.createdAtIso ?? doc.data.createdAt ?? doc.createdAt, 'stimulus creation'));
  }

  const overrides = new Map(source.bank_question_overrides.map((doc) => [docId(doc, 'questionId'), doc.data]));
  const questionIds = new Set<string>();
  for (const doc of source.bank_questions) {
    const data = record(doc.data.payload ?? doc.data, 'question payload');
    const id = docId(doc, 'questionId', data.questionId ?? doc.data.questionId);
    const family = requiredText(data.questionFamilyId ?? doc.data.questionFamilyId, 'question family ID');
    const version = integer(data.version ?? doc.data.version, 'question version');
    const section = checkedEnum(data.section ?? doc.data.section, ['READ', 'MATH', 'THINK', 'WRIT'], 'question section');
    const format = requiredText(data.formatType ?? doc.data.formatType, 'question format');
    const pool = requiredText(data.poolType ?? doc.data.poolType, 'question pool');
    const override = overrides.get(id);
    if (override) {
      report.overridesApplied++;
      overrides.delete(id);
    }
    const status = checkedEnum(override?.qcStatus ?? doc.data.qcStatus ?? data.qcStatus, qcStatuses, 'question QC status');
    const stimulus = optionalText(data.stimulusId ?? doc.data.stimulusId);
    if (stimulus && !stimulusIds.has(stimulus)) throw new MigrationError('A bank question refers to a missing stimulus.');
    list(data.parts, 'question parts');
    const revision = optionalText(doc.data.evidenceRevision) ?? optionalText(data.evidenceRevision);
    if (!revision) report.questionsWithoutEvidenceRevision++;
    questionIds.add(id);
    add('questions', id, family, version, optionalText(data.contentHash) ?? null, section, format, pool, status,
      stimulus ?? null, json({
        ...data, questionId: id, questionFamilyId: family, version, section, formatType: format, poolType: pool,
        qcStatus: status, stimulusId: stimulus, evidenceRevision: revision,
        ...(override?.visual ? { visual: override.visual } : {}),
        batchId: data.batchId ?? doc.data.batchId,
        batchLabel: data.batchLabel ?? doc.data.batchLabel,
      }),
      date(data.createdAtIso ?? doc.data.createdAt ?? doc.createdAt, 'question creation'));
  }
  if (overrides.size) throw new MigrationError('Legacy question overrides refer to missing bank questions.');

  for (const doc of source.import_batches) {
    const batchId = docId(doc, 'batchId');
    const createdAtIso = date(doc.data.createdAtIso ?? doc.data.createdAt ?? doc.createdAt, 'batch creation');
    const batch = {
      ...doc.data, batchId, createdAtIso,
      newQuestionIds: doc.data.newQuestionIds ?? [],
      versionBumpedQuestionIds: doc.data.versionBumpedQuestionIds ?? [],
      skippedQuestionIds: doc.data.skippedQuestionIds ?? [],
    };
    add('import_batches', batchId, optionalText(doc.data.batchLabel) ?? null, json(batch), createdAtIso);
  }
  const configIds = new Set<string>(source.admin_configs.length === 0 ? ['cfg_v1'] : []);
  const versions = new Set<number>();
  for (const doc of source.admin_configs) {
    const id = docId(doc, 'configVersionId');
    const version = integer(doc.data.versionNumber, 'config version');
    if (versions.has(version)) throw new MigrationError('Duplicate learning config version number.');
    versions.add(version);
    configIds.add(id);
    add('admin_config_versions', id, version, optionalText(doc.data.notes) ?? null,
      json(record(doc.data.config, 'learning config')),
      date(doc.data.createdAtIso ?? doc.data.createdAt ?? doc.createdAt, 'config creation'));
  }

  const historicalMissing = new Set<string>();
  function markHistoricalQuestion(value: unknown) {
    const id = requiredText(value, 'historical question ID');
    if (!questionIds.has(id)) historicalMissing.add(id);
    return id;
  }
  for (const doc of source.question_flags) {
    const flagId = docId(doc, 'flagId');
    const id = markHistoricalQuestion(doc.data.questionId);
    const studentId = optionalText(doc.data.studentId ?? doc.data.userId);
    if (studentId && !profiles.has(studentId)) report.flagsWithoutProfile++;
    const status = checkedEnum(doc.data.status, ['open', 'resolved'], 'question flag status');
    const createdAt = date(doc.data.createdAtIso ?? doc.data.createdAt ?? doc.createdAt, 'flag creation');
    add('question_flags', flagId, id, status, json({ ...doc.data, flagId, studentId, createdAt, status }), createdAt);
  }

  for (const user of source.users) {
    const uid = docId(user, 'uid');
    if (uid !== user.id || !/^[A-Za-z0-9_-]{1,128}$/.test(uid)) {
      throw new MigrationError('Invalid Firebase user ID.');
    }
    const root = `users/${uid}`;
    const account = links.get(uid);
    if (!account) report.unlinkedProfiles++;
    const [privateDoc] = scan(`${root}/private`, 'private');
    if (privateDoc) {
      if (privateDoc.id !== 'info' || dump.collections[`${root}/private`].length !== 1) {
        throw new MigrationError('Unexpected private profile document.');
      }
      assertOwner(privateDoc.data, uid);
    }
    // Auth derives admin role from a verified Google identity on sign-in.
    add('users', uid, 'student', optionalText(user.data.displayName) ?? uid,
      optionalText(account?.verifiedEmail) ?? optionalText(privateDoc?.data.email) ?? optionalText(user.data.email) ?? null,
      user.updatedAt);

    const learner = Object.fromEntries(learnerCollections.map((name) => [name, scan(`${root}/${name}`, name)]));
    for (const docs of Object.values(learner)) for (const doc of docs) assertOwner(doc.data, uid);
    const learnerSessionIds = new Set<string>();
    for (const doc of learner.sessions) {
      const sessionId = docId(doc, 'sessionId');
      learnerSessionIds.add(sessionId);
      const status = checkedEnum(doc.data.status, ['in_progress', 'submitted', 'abandoned'], 'session status');
      if (status === 'in_progress') report.inProgressSessions++;
      const configVersionId = optionalText(doc.data.configVersionId) ?? 'cfg_v1';
      if (!configIds.has(configVersionId)) report.missingSessionConfigVersions++;
      const plannedIds = list(doc.data.plannedQuestionIds, 'planned question IDs').map(markHistoricalQuestion);
      const startedAt = date(doc.data.startedAt ?? doc.data.startedAtIso ?? doc.data.createdAt ?? doc.createdAt, 'session start');
      const completedAt = doc.data.completedAt != null ? date(doc.data.completedAt, 'session completion') : undefined;
      const mode = requiredText(doc.data.mode, 'session mode');
      const sandbox = doc.data.isSandbox === true;
      add('sessions', sessionId, uid, mode, status, sandbox, json({
        ...doc.data, studentId: uid, sessionId, configVersionId, startedAt, completedAt,
      }), startedAt, completedAt ?? null);

      const snapshotDocs = scan(`${root}/sessions/${doc.id}/snapshots`, 'snapshots');
      const snapshotIndices = new Set<number>();
      const snapshots = snapshotDocs.map((snap) => {
        assertOwner(snap.data, uid);
        const snapshotIndex = integer(snap.data.snapshotIndex, 'snapshot index', 0);
        const questionId = markHistoricalQuestion(snap.data.questionId);
        const question = record(snap.data.question, 'snapshot question');
        if (snapshotIndices.has(snapshotIndex) || plannedIds[snapshotIndex] !== questionId ||
          question.questionId !== questionId) {
          throw new MigrationError('A session snapshot disagrees with its planned question ID or position.');
        }
        snapshotIndices.add(snapshotIndex);
        return { ...snap.data, snapshotIndex };
      }).sort((a, b) => a.snapshotIndex - b.snapshotIndex);
      report.snapshots += snapshots.length;
      if (snapshots.length !== plannedIds.length) report.sessionsWithIncompleteSnapshots++;
      if (snapshots.length) add('session_snapshots', sessionId, uid, json(snapshots), snapshotDocs[0].createdAt);
    }

    function sessionReference(value: unknown) {
      const id = requiredText(value, 'learner session reference');
      if (!learnerSessionIds.has(id)) throw new MigrationError('A learner record refers to a missing session.');
      return id;
    }
    for (const doc of learner.attempts) {
      const attemptId = docId(doc, 'attemptId');
      const sessionId = sessionReference(doc.data.sessionId);
      const questionId = markHistoricalQuestion(doc.data.questionId);
      const part = requiredText(doc.data.partId, 'attempt part ID');
      const skill = requiredText(doc.data.skillId, 'attempt skill ID');
      const createdAt = date(doc.data.createdAtIso ?? doc.data.createdAt ?? doc.createdAt, 'attempt creation');
      if (typeof doc.data.isCorrect !== 'boolean') throw new MigrationError('Missing or invalid attempt correctness.');
      if (!optionalText(doc.data.evidenceRevision)) report.attemptsWithoutEvidenceRevision++;
      add('part_attempts', attemptId, uid, sessionId, questionId, part, skill, doc.data.isCorrect,
        doc.data.isSandbox === true, json({ ...doc.data, studentId: uid, attemptId, createdAt }), createdAt);
    }
    for (const doc of learner.skill_states) {
      const skillId = docId(doc, 'skillId');
      add('skill_states', uid, skillId, json({
        ...doc.data, skillId,
        nextReviewAt: doc.data.nextReviewAt ?? doc.data.nextDueAt ?? doc.data.nextReviewDueAt,
      }));
    }
    for (const doc of learner.question_memory) {
      const questionFamilyId = docId(doc, 'questionFamilyId');
      add('question_memory', uid, questionFamilyId, json({ ...doc.data, questionFamilyId }));
    }
    for (const doc of learner.question_evidence) {
      const evidenceKey = docId(doc, 'evidenceKey');
      markHistoricalQuestion(doc.data.questionId);
      add('question_evidence', uid, evidenceKey, json({ ...doc.data, evidenceKey }));
    }
    for (const doc of learner.writing_submissions) {
      const submissionId = docId(doc, 'submissionId');
      const sessionId = sessionReference(doc.data.sessionId);
      const questionId = markHistoricalQuestion(doc.data.questionId);
      const submittedAt = date(doc.data.submittedAt ?? doc.data.createdAt ?? doc.createdAt, 'writing submission');
      const { evaluations, ...data } = doc.data;
      add('writing_submissions', submissionId, uid, sessionId, questionId, json({
        ...data, studentId: uid, submissionId, submittedAt,
        deterministicMetricsJson: doc.data.deterministicMetricsJson ?? JSON.stringify(doc.data.deterministicMetrics ?? {}),
      }), submittedAt);
      for (const value of list(evaluations ?? [], 'writing evaluations')) {
        const evaluation = record(value, 'writing evaluation');
        const evaluationId = requiredText(evaluation.evaluationId, 'writing evaluation ID');
        if (evaluation.submissionId !== submissionId) throw new MigrationError('A writing evaluation refers to a different submission.');
        const createdAt = date(evaluation.createdAt ?? evaluation.createdAtIso, 'writing evaluation');
        add('writing_evaluations', evaluationId, submissionId, json({ ...evaluation, createdAt }), createdAt);
      }
    }
    for (const doc of learner.daily_plans) {
      const planDate = docId(doc, 'planDate');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(planDate)) throw new MigrationError('Invalid daily focus plan date.');
      add('daily_focus_plans', uid, planDate, json({ ...doc.data, planDate, studentId: uid }));
    }
  }

  if (seenCollections.size !== Object.keys(dump.collections).length) {
    throw new MigrationError('Source export includes an unrecognized collection.');
  }
  for (const url of bundledUrls) {
    const segments = url.slice(1).split('/');
    // Execute from the repo root. Treat unusual URLs as unresolved assets.
    if (!segments.every((segment) => /^[A-Za-z0-9_.-]+$/.test(segment) && segment !== '..' && segment !== '.') ||
      !(await readFile(path.join('public', ...segments)).catch(() => undefined))) {
      report.missingBundledVisualPaths++;
    }
  }
  report.unavailableMedia = unavailableMedia.size + report.missingBundledVisualPaths;
  report.externalVisualUrls = externalUrls.size;
  report.historicalQuestionsWithoutBankRow = historicalMissing.size;
  return { rows, identityMap, report: {
    ...report, rows: Object.fromEntries(tableNames.map((table) => [table, rows[table].length])),
  } };
}
