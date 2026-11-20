import crypto from 'node:crypto';
import { FieldPath, FieldValue, type Firestore } from 'firebase-admin/firestore';
import type {
  BankImportManifest,
  DailyFocusPlan,
  ImportBatchRecord,
  LearningConfig,
  MediaAssetRecord,
  PartAttemptRecord,
  QuestionFlagRecord,
  QuestionItem,
  QuestionMasteryEvidence,
  QuestionMemoryState,
  SessionCheckpoint,
  SessionQuestionSnapshot,
  SessionRecord,
  SkillState,
  StimulusGroup,
  VisualSpec,
  WritingEvaluationRecord,
} from '../../shared/contracts.ts';
import { DEFAULT_LEARNING_CONFIG } from '../../shared/contracts.ts';
import { decodeFromFirestore, encodeForFirestore } from '../../shared/firestoreCodec.ts';
import { computeEvidenceRevision } from '../../shared/mastery.ts';
import { getBootstrappedAdminEmail } from '../firebaseVerify.ts';
import { computeCanonicalHash } from '../manifestValidator.ts';
import { buildMediaMigrationManifest } from '../mediaService.ts';
import {
  ForbiddenError,
  NotFoundError,
  RevisionConflictError,
  type AppRepository,
  type BackupRestoreReport,
  type CanonicalBackupBundle,
  type CheckpointSaveResult,
  type FinalizeSessionInput,
  type FinalizeSessionResult,
  type MigrationPreflightReport,
  type QuestionQueryParams,
  type QuestionQueryResult,
  type QuestionVersionSummary,
  type ReserveSessionResult,
  type SyncHydratePayload,
  type WritingSubmissionRecord,
} from './repository.ts';
import {
  emptyRestoreReport,
  filterAndPaginateQuestions,
  finalizeBackupBundle,
  selectLatestByFamily,
  validateIncomingBackupBundle,
} from './repositoryUtils.ts';

const DEFAULT_STUDENT_ID = 'default-student';
const CURSOR_PAGE_SIZE = 300;
const BATCH_WRITE_LIMIT = 400;

export function toSafeDocId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '__').slice(0, 128);
}

export function stripUndefinedDeep<T>(value: T): T {
  return encodeForFirestore(value);
}

export interface FirestoreAdapterDeps {
  db: Firestore;
  serverTimestamp: () => unknown;
  documentIdField: () => unknown;
}

export function createDefaultFirestoreDeps(db: Firestore): FirestoreAdapterDeps {
  return {
    db,
    serverTimestamp: () => FieldValue.serverTimestamp(),
    documentIdField: () => FieldPath.documentId(),
  };
}

export class FirestoreRepository implements AppRepository {
  readonly backendName = 'firestore_server' as const;
  private deps: FirestoreAdapterDeps;

  constructor(dbOrDeps: Firestore | FirestoreAdapterDeps) {
    if ('db' in dbOrDeps && 'serverTimestamp' in dbOrDeps && 'documentIdField' in dbOrDeps) {
      this.deps = dbOrDeps;
    } else {
      this.deps = createDefaultFirestoreDeps(dbOrDeps);
    }
  }

  private get db(): Firestore {
    return this.deps.db;
  }

  private nowTs(): unknown {
    return this.deps.serverTimestamp();
  }

  private async scanCollection<T>(
    colRef: FirebaseFirestore.CollectionReference,
    mapper: (doc: FirebaseFirestore.QueryDocumentSnapshot) => T
  ): Promise<T[]> {
    const results: T[] = [];
    let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
    while (true) {
      let q = colRef.orderBy(this.deps.documentIdField() as string | FirebaseFirestore.FieldPath).limit(CURSOR_PAGE_SIZE);
      if (lastDoc) {
        q = q.startAfter(lastDoc);
      }
      const snap = await q.get();
      if (snap.empty) break;
      for (const d of snap.docs) {
        results.push(mapper(d));
      }
      if (snap.docs.length < CURSOR_PAGE_SIZE) break;
      lastDoc = snap.docs[snap.docs.length - 1];
    }
    return results;
  }

  private async ensureDefaultConfigExists(): Promise<void> {
    const cfgSnap = await this.db.collection('admin_configs').limit(1).get();
    if (!cfgSnap.empty) return;
    const nowIso = new Date().toISOString();
    await this.db
      .collection('admin_configs')
      .doc('cfg_v1')
      .set(
        stripUndefinedDeep({
          configVersionId: 'cfg_v1',
          versionNumber: 1,
          notes: 'Default Selective Lab Learning Config',
          config: structuredClone(DEFAULT_LEARNING_CONFIG),
          createdAtIso: nowIso,
          createdAt: this.nowTs(),
        })
      );
  }

  private async ensureUserDocExists(studentId: string): Promise<void> {
    const uid = toSafeDocId(studentId || DEFAULT_STUDENT_ID);
    const ref = this.db.collection('users').doc(uid);
    const snap = await ref.get();
    if (!snap.exists) {
      await ref.set({
        uid,
        displayName: uid === DEFAULT_STUDENT_ID ? 'Local Learner' : uid,
        role: 'student',
        createdAt: this.nowTs(),
        updatedAt: this.nowTs(),
      });
    }
  }

  async initAndSeedIfEmpty(seedManifest: BankImportManifest): Promise<void> {
    await this.ensureDefaultConfigExists();
    const qSnap = await this.db.collection('bank_questions').limit(1).get();
    if (!qSnap.empty) return;
    await this.importManifest(seedManifest, 'system_seed');
  }

  async upsertUserFromAuth(input: {
    uid: string;
    email: string;
    displayName?: string;
    isBootstrappedAdmin: boolean;
  }): Promise<{ role: 'student' | 'admin' }> {
    const uid = toSafeDocId(input.uid);
    const userRef = this.db.collection('users').doc(uid);
    const privRef = userRef.collection('private').doc('info');
    const adminRef = this.db.collection('admins').doc(uid);

    const isEmailBootstrapped =
      input.email.trim().toLowerCase() === getBootstrappedAdminEmail().toLowerCase();

    const [userSnap, adminSnap] = await Promise.all([userRef.get(), adminRef.get()]);
    const isAdmin = isEmailBootstrapped;
    const role: 'student' | 'admin' = isAdmin ? 'admin' : 'student';

    if (isAdmin && !adminSnap.exists) {
      await adminRef.set({ uid, createdAt: this.nowTs() });
    }

    const displayName = (input.displayName || input.email.split('@')[0] || 'Learner').slice(0, 120);
    if (!userSnap.exists) {
      await userRef.set({
        uid,
        displayName,
        role,
        createdAt: this.nowTs(),
        updatedAt: this.nowTs(),
      });
    } else {
      await userRef.set(
        {
          uid,
          displayName,
          role,
          updatedAt: this.nowTs(),
        },
        { merge: true }
      );
    }

    if (input.email) {
      const privSnap = await privRef.get();
      if (!privSnap.exists) {
        await privRef.set({
          uid,
          email: input.email.slice(0, 200),
          createdAt: this.nowTs(),
          updatedAt: this.nowTs(),
        });
      } else {
        await privRef.set(
          {
            uid,
            email: input.email.slice(0, 200),
            updatedAt: this.nowTs(),
          },
          { merge: true }
        );
      }
    }

    return { role };
  }

  async isUserAdmin(uid: string): Promise<boolean> {
    const safeUid = toSafeDocId(uid);
    const adminSnap = await this.db.collection('admins').doc(safeUid).get();
    if (adminSnap.exists) return true;
    const userSnap = await this.db.collection('users').doc(safeUid).get();
    return userSnap.data()?.role === 'admin';
  }

  private async getAllQuestionsAndStimuli(): Promise<{
    questions: QuestionItem[];
    stimuliById: Record<string, StimulusGroup>;
  }> {
    const [stimRows, qRows] = await Promise.all([
      this.scanCollection(this.db.collection('bank_stimuli'), (d) =>
        decodeFromFirestore((d.data().payload as StimulusGroup) || (d.data() as StimulusGroup))
      ),
      this.scanCollection(this.db.collection('bank_questions'), (d) =>
        decodeFromFirestore((d.data().payload as QuestionItem) || (d.data() as QuestionItem))
      ),
    ]);

    const stimuliById: Record<string, StimulusGroup> = {};
    for (const s of stimRows) {
      if (s?.stimulusId) stimuliById[s.stimulusId] = s;
    }
    return { questions: qRows.filter((q) => Boolean(q?.questionId)), stimuliById };
  }

  async listQuestions(filter?: {
    section?: string;
    poolType?: string;
    qcStatus?: string;
    includeHistorical?: boolean;
  }): Promise<QuestionItem[]> {
    const { questions } = await this.getAllQuestionsAndStimuli();
    const base = filter?.includeHistorical ? questions : selectLatestByFamily(questions);
    return base.filter((q) => {
      if (filter?.section && q.section !== filter.section) return false;
      if (filter?.poolType && q.poolType !== filter.poolType) return false;
      if (filter?.qcStatus && q.qcStatus !== filter.qcStatus) return false;
      return true;
    });
  }

  async listQuestionsPaginated(params?: QuestionQueryParams): Promise<QuestionQueryResult> {
    const [{ questions, stimuliById }, flags, batches] = await Promise.all([
      this.getAllQuestionsAndStimuli(),
      this.listQuestionFlags(),
      this.listImportBatches(),
    ]);
    return filterAndPaginateQuestions({
      allQuestions: questions,
      stimuliById,
      flags,
      batches,
      params,
    });
  }

  async listQuestionVersions(questionFamilyId: string): Promise<QuestionVersionSummary[]> {
    const snap = await this.db
      .collection('bank_questions')
      .where('questionFamilyId', '==', questionFamilyId)
      .get();
    const qs = snap.docs
      .map((d) =>
        decodeFromFirestore((d.data().payload as QuestionItem) || (d.data() as QuestionItem))
      )
      .sort((a, b) => b.version - a.version);
    const stimIds = Array.from(new Set(qs.map((q) => q.stimulusId).filter((x): x is string => Boolean(x))));
    const stimuliById = await this.listStimuliByIds(stimIds);
    return qs.map((question) => ({
      question,
      stimulus: question.stimulusId ? stimuliById[question.stimulusId] : undefined,
    }));
  }

  async listStimuliByIds(stimulusIds: string[]): Promise<Record<string, StimulusGroup>> {
    const unique = Array.from(new Set(stimulusIds.filter(Boolean)));
    if (unique.length === 0) return {};
    const snaps = await Promise.all(
      unique.map((id) => this.db.collection('bank_stimuli').doc(toSafeDocId(id)).get())
    );
    const out: Record<string, StimulusGroup> = {};
    for (const s of snaps) {
      if (!s.exists) continue;
      const stim = decodeFromFirestore(
        (s.data()?.payload as StimulusGroup) || (s.data() as StimulusGroup)
      );
      if (stim?.stimulusId) out[stim.stimulusId] = stim;
    }
    return out;
  }

  async getQuestionWithStimulus(
    questionId: string
  ): Promise<{ question: QuestionItem; stimulus?: StimulusGroup } | null> {
    const qSnap = await this.db.collection('bank_questions').doc(toSafeDocId(questionId)).get();
    if (!qSnap.exists) return null;
    const question = decodeFromFirestore(
      (qSnap.data()?.payload as QuestionItem) || (qSnap.data() as QuestionItem)
    );
    let stimulus: StimulusGroup | undefined;
    if (question.stimulusId) {
      const sSnap = await this.db
        .collection('bank_stimuli')
        .doc(toSafeDocId(question.stimulusId))
        .get();
      if (sSnap.exists) {
        stimulus = decodeFromFirestore(
          (sSnap.data()?.payload as StimulusGroup) || (sSnap.data() as StimulusGroup)
        );
      }
    }
    return { question, stimulus };
  }

  private async commitChunkedWrites(
    ops: Array<(batch: FirebaseFirestore.WriteBatch) => void>
  ): Promise<void> {
    for (let i = 0; i < ops.length; i += BATCH_WRITE_LIMIT) {
      const slice = ops.slice(i, i + BATCH_WRITE_LIMIT);
      const batch = this.db.batch();
      for (const fn of slice) fn(batch);
      await batch.commit();
    }
  }

  async importManifest(
    manifest: BankImportManifest,
    importedBy = 'admin'
  ): Promise<{ imported: number; skipped: number; versionBumped: number; batch: ImportBatchRecord }> {
    const nowIso = new Date().toISOString();
    const batchId = `batch_${nowIso.slice(0, 10).replace(/-/g, '')}_${crypto.randomUUID().slice(0, 6)}`;
    let imported = 0;
    let skipped = 0;
    let versionBumped = 0;
    const newQuestionIds: string[] = [];
    const versionBumpedQuestionIds: string[] = [];
    const skippedQuestionIds: string[] = [];

    const { questions: existingQuestions, stimuliById } = await this.getAllQuestionsAndStimuli();
    const existingIds = new Set(existingQuestions.map((q) => q.questionId));
    const latestByFamily = new Map<string, QuestionItem>();
    for (const q of existingQuestions) {
      const prev = latestByFamily.get(q.questionFamilyId);
      if (!prev || q.version > prev.version) latestByFamily.set(q.questionFamilyId, q);
    }

    const writeOps: Array<(b: FirebaseFirestore.WriteBatch) => void> = [];
    const mergedStimuliById: Record<string, StimulusGroup> = { ...stimuliById };

    for (const rawS of manifest.stimuli || []) {
      const hash =
        rawS.contentHash ||
        computeCanonicalHash({
          title: rawS.title,
          preamble: rawS.preamble,
          mainTextMarkdown: rawS.mainTextMarkdown,
          extracts: rawS.extracts,
          visual: rawS.visual,
        });
      const stim: StimulusGroup = {
        ...structuredClone(rawS),
        contentHash: hash,
        batchId: rawS.batchId || batchId,
        createdAtIso: rawS.createdAtIso || nowIso,
        updatedAtIso: nowIso,
      };
      mergedStimuliById[stim.stimulusId] = stim;
      const sid = toSafeDocId(stim.stimulusId);
      writeOps.push((batch) =>
        batch.set(
          this.db.collection('bank_stimuli').doc(sid),
          stripUndefinedDeep({
            stimulusId: sid,
            stimulusFamilyId: stim.stimulusFamilyId,
            version: stim.version,
            section: stim.section,
            genreOrTextType: stim.genreOrTextType,
            batchId: stim.batchId,
            payload: stim,
            updatedAtIso: nowIso,
            updatedAt: this.nowTs(),
          })
        )
      );
    }

    for (const rawQ of manifest.questions || []) {
      const q = structuredClone(rawQ);
      if (!q.poolType) q.poolType = manifest.defaultPoolType;
      if (!q.qcStatus) q.qcStatus = manifest.defaultQcStatus;
      const hash =
        q.contentHash ||
        computeCanonicalHash({
          parts: q.parts,
          stemPrefix: q.stemPrefix,
          visual: q.visual,
          writingSpec: q.writingSpec,
        });
      q.contentHash = hash;
      const stim = q.stimulusId ? mergedStimuliById[q.stimulusId] : undefined;
      q.evidenceRevision = q.evidenceRevision || computeEvidenceRevision(q, stim);

      const existing = latestByFamily.get(q.questionFamilyId);
      if (!existing) {
        q.batchId = q.batchId || batchId;
        q.batchLabel = q.batchLabel || manifest.batchLabel;
        q.createdAtIso = q.createdAtIso || nowIso;
        q.updatedAtIso = nowIso;
        latestByFamily.set(q.questionFamilyId, q);
        existingIds.add(q.questionId);
        newQuestionIds.push(q.questionId);
        imported++;

        const qid = toSafeDocId(q.questionId);
        writeOps.push((batch) =>
          batch.set(
            this.db.collection('bank_questions').doc(qid),
            stripUndefinedDeep({
              questionId: qid,
              questionFamilyId: q.questionFamilyId,
              version: q.version,
              section: q.section,
              formatType: q.formatType,
              poolType: q.poolType,
              qcStatus: q.qcStatus,
              batchId: q.batchId,
              payload: q,
              updatedAtIso: nowIso,
              updatedAt: this.nowTs(),
            })
          )
        );
      } else if (
        existing.contentHash === hash &&
        existing.version === q.version &&
        existing.questionId === q.questionId
      ) {
        skipped++;
        skippedQuestionIds.push(q.questionId);
      } else {
        const nextVersion = Math.max(existing.version + 1, q.version);
        const bumpedId =
          nextVersion !== q.version || existingIds.has(q.questionId)
            ? `${q.questionFamilyId}_v${nextVersion}`
            : q.questionId;
        const bumpedQ: QuestionItem = {
          ...q,
          questionId: bumpedId,
          version: nextVersion,
          batchId: q.batchId || batchId,
          batchLabel: q.batchLabel || manifest.batchLabel,
          createdAtIso: nowIso,
          updatedAtIso: nowIso,
        };
        bumpedQ.evidenceRevision = computeEvidenceRevision(bumpedQ, stim);
        latestByFamily.set(q.questionFamilyId, bumpedQ);
        existingIds.add(bumpedQ.questionId);
        versionBumpedQuestionIds.push(bumpedQ.questionId);
        versionBumped++;

        const qid = toSafeDocId(bumpedQ.questionId);
        writeOps.push((batch) =>
          batch.set(
            this.db.collection('bank_questions').doc(qid),
            stripUndefinedDeep({
              questionId: qid,
              questionFamilyId: bumpedQ.questionFamilyId,
              version: bumpedQ.version,
              section: bumpedQ.section,
              formatType: bumpedQ.formatType,
              poolType: bumpedQ.poolType,
              qcStatus: bumpedQ.qcStatus,
              batchId: bumpedQ.batchId,
              payload: bumpedQ,
              updatedAtIso: nowIso,
              updatedAt: this.nowTs(),
            })
          )
        );
      }
    }

    const batchRecord: ImportBatchRecord = {
      batchId,
      batchLabel: manifest.batchLabel,
      createdAtIso: nowIso,
      importedBy,
      stimuliCount: (manifest.stimuli || []).length,
      questionsCount: (manifest.questions || []).length,
      newQuestionIds,
      versionBumpedQuestionIds,
      skippedQuestionIds,
    };

    writeOps.push((batch) =>
      batch.set(
        this.db.collection('import_batches').doc(toSafeDocId(batchId)),
        stripUndefinedDeep({
          ...batchRecord,
          createdAt: this.nowTs(),
        })
      )
    );

    await this.commitChunkedWrites(writeOps);
    return { imported, skipped, versionBumped, batch: batchRecord };
  }

  async listImportBatches(): Promise<ImportBatchRecord[]> {
    const rows = await this.scanCollection(
      this.db.collection('import_batches'),
      (d) => d.data() as ImportBatchRecord
    );
    return rows.sort((a, b) => Date.parse(b.createdAtIso || '') - Date.parse(a.createdAtIso || ''));
  }

  async getImportBatch(batchId: string): Promise<ImportBatchRecord | null> {
    const snap = await this.db.collection('import_batches').doc(toSafeDocId(batchId)).get();
    return snap.exists ? (snap.data() as ImportBatchRecord) : null;
  }

  async updateQuestionStatus(questionId: string, qcStatus: QuestionItem['qcStatus']): Promise<void> {
    const qid = toSafeDocId(questionId);
    const ref = this.db.collection('bank_questions').doc(qid);
    const snap = await ref.get();
    if (!snap.exists) throw new NotFoundError(`Question ${questionId} not found.`);
    const q = (snap.data()?.payload as QuestionItem) || (snap.data() as QuestionItem);
    const nowIso = new Date().toISOString();
    q.qcStatus = qcStatus;
    q.updatedAtIso = nowIso;
    await ref.set(
      stripUndefinedDeep({
        ...snap.data(),
        qcStatus,
        payload: q,
        updatedAtIso: nowIso,
        updatedAt: this.nowTs(),
      })
    );
  }

  async updateQuestionVisual(questionId: string, visual: VisualSpec): Promise<void> {
    const qid = toSafeDocId(questionId);
    const ref = this.db.collection('bank_questions').doc(qid);
    const snap = await ref.get();
    if (!snap.exists) throw new NotFoundError(`Question ${questionId} not found.`);
    const q = (snap.data()?.payload as QuestionItem) || (snap.data() as QuestionItem);
    const nowIso = new Date().toISOString();
    q.visual = structuredClone(visual);
    q.updatedAtIso = nowIso;
    const stim = q.stimulusId ? (await this.listStimuliByIds([q.stimulusId]))[q.stimulusId] : undefined;
    q.evidenceRevision = computeEvidenceRevision(q, stim);
    await ref.set(
      stripUndefinedDeep({
        ...snap.data(),
        payload: q,
        updatedAtIso: nowIso,
        updatedAt: this.nowTs(),
      })
    );
  }

  async getActiveConfig(): Promise<{ configVersionId: string; versionNumber: number; config: LearningConfig }> {
    await this.ensureDefaultConfigExists();
    const snap = await this.db
      .collection('admin_configs')
      .orderBy('versionNumber', 'desc')
      .limit(1)
      .get();
    if (snap.empty) {
      return {
        configVersionId: 'cfg_v1',
        versionNumber: 1,
        config: structuredClone(DEFAULT_LEARNING_CONFIG),
      };
    }
    const row = snap.docs[0].data() as {
      configVersionId: string;
      versionNumber: number;
      config: LearningConfig;
    };
    const rawCfg = row.config;
    return {
      configVersionId: row.configVersionId,
      versionNumber: row.versionNumber,
      config: {
        ...structuredClone(DEFAULT_LEARNING_CONFIG),
        ...rawCfg,
        sessionDefaults: {
          ...DEFAULT_LEARNING_CONFIG.sessionDefaults,
          ...rawCfg?.sessionDefaults,
          dailyQuestionLimitBySection: {
            ...DEFAULT_LEARNING_CONFIG.sessionDefaults.dailyQuestionLimitBySection,
            ...(rawCfg?.sessionDefaults?.dailyQuestionLimitBySection || {}),
          },
        },
      },
    };
  }

  async listConfigVersions(): Promise<
    { configVersionId: string; versionNumber: number; notes?: string; createdAt: string; config: LearningConfig }[]
  > {
    const snap = await this.db
      .collection('admin_configs')
      .orderBy('versionNumber', 'desc')
      .get();
    return snap.docs.map((d) => {
      const data = d.data() as Record<string, unknown>;
      return {
        configVersionId: String(data.configVersionId),
        versionNumber: Number(data.versionNumber),
        notes: data.notes ? String(data.notes) : undefined,
        createdAt: String(data.createdAtIso || new Date().toISOString()),
        config: data.config as LearningConfig,
      };
    });
  }

  async saveConfigVersion(
    config: LearningConfig,
    notes?: string
  ): Promise<{ configVersionId: string; versionNumber: number }> {
    const active = await this.getActiveConfig();
    const nextNum = active.versionNumber + 1;
    const configVersionId = `cfg_v${nextNum}_${crypto.randomUUID().slice(0, 6)}`;
    const nowIso = new Date().toISOString();
    await this.db
      .collection('admin_configs')
      .doc(toSafeDocId(configVersionId))
      .set(
        stripUndefinedDeep({
          configVersionId,
          versionNumber: nextNum,
          notes: notes || undefined,
          config: structuredClone(config),
          createdAtIso: nowIso,
          createdAt: this.nowTs(),
        })
      );
    return { configVersionId, versionNumber: nextNum };
  }

  async createSession(session: SessionRecord, snapshots: SessionQuestionSnapshot[] = []): Promise<void> {
    const uid = toSafeDocId(session.studentId || DEFAULT_STUDENT_ID);
    const sid = toSafeDocId(session.sessionId);
    await this.ensureUserDocExists(uid);

    const stamped: SessionRecord = {
      ...structuredClone(session),
      studentId: uid,
      checkpointRevision: session.checkpointRevision ?? 1,
    };

    const writeOps: Array<(b: FirebaseFirestore.WriteBatch) => void> = [];
    const sessRef = this.db.collection('users').doc(uid).collection('sessions').doc(sid);
    writeOps.push((batch) =>
      batch.set(
        sessRef,
        stripUndefinedDeep({
          ...stamped,
          userId: uid,
          createdAt: this.nowTs(),
          updatedAt: this.nowTs(),
        })
      )
    );

    for (const snap of snapshots) {
      const snapRef = sessRef.collection('snapshots').doc(toSafeDocId(snap.questionId));
      writeOps.push((batch) => batch.set(snapRef, stripUndefinedDeep(snap)));
    }

    await this.commitChunkedWrites(writeOps);
  }

  async reserveAndCreateSession(
    session: SessionRecord,
    snapshots: SessionQuestionSnapshot[] = []
  ): Promise<ReserveSessionResult> {
    if (session.isSandbox) {
      await this.createSession(session, snapshots);
      return { created: true };
    }

    const uid = toSafeDocId(session.studentId || DEFAULT_STUDENT_ID);
    const sid = toSafeDocId(session.sessionId);
    await this.ensureUserDocExists(uid);

    const userRef = this.db.collection('users').doc(uid);
    const lockRef = userRef.collection('locks').doc('active_session');
    const sessRef = userRef.collection('sessions').doc(sid);

    const stamped: SessionRecord = {
      ...structuredClone(session),
      studentId: uid,
      checkpointRevision: session.checkpointRevision ?? 1,
    };

    const fitsInSingleTx = snapshots.length + 2 < 400;
    const lockResult = await this.db.runTransaction(async (tx) => {
      const lockSnap = await tx.get(lockRef);
      if (lockSnap.exists) {
        const lockedId = String(lockSnap.data()?.activeSessionId || '').trim();
        if (lockedId) {
          const lockedSessRef = userRef.collection('sessions').doc(toSafeDocId(lockedId));
          const lockedSessSnap = await tx.get(lockedSessRef);
          if (lockedSessSnap.exists) {
            const lockedSess = lockedSessSnap.data() as SessionRecord;
            if (lockedSess.status === 'in_progress' && !lockedSess.isSandbox) {
              return {
                created: false as const,
                conflictSessionId: lockedSess.sessionId,
                conflictSession: lockedSess,
              };
            }
          }
        }
      }

      tx.set(
        lockRef,
        stripUndefinedDeep({
          activeSessionId: sid,
          mode: stamped.mode,
          deadlineAt: stamped.deadlineAt ?? null,
          updatedAtIso: stamped.startedAt,
          updatedAt: this.nowTs(),
        })
      );

      tx.set(
        sessRef,
        stripUndefinedDeep({
          ...stamped,
          userId: uid,
          createdAt: this.nowTs(),
          updatedAt: this.nowTs(),
        })
      );

      if (fitsInSingleTx) {
        for (const snap of snapshots) {
          const snapRef = sessRef.collection('snapshots').doc(toSafeDocId(snap.questionId));
          tx.set(snapRef, stripUndefinedDeep(snap));
        }
      }

      return { created: true as const };
    });

    if (lockResult.created && !fitsInSingleTx && snapshots.length > 0) {
      await this.commitChunkedWrites(
        snapshots.map((snap) => (batch) =>
          batch.set(sessRef.collection('snapshots').doc(toSafeDocId(snap.questionId)), stripUndefinedDeep(snap))
        )
      );
    }

    return lockResult;
  }

  async getSession(sessionId: string, studentId?: string): Promise<SessionRecord | null> {
    const sid = toSafeDocId(sessionId);
    if (studentId) {
      const uid = toSafeDocId(studentId);
      const docSnap = await this.db.collection('users').doc(uid).collection('sessions').doc(sid).get();
      if (docSnap.exists) return docSnap.data() as SessionRecord;
      return null;
    }

    // Fallback lookup across known users if owner UID not explicitly known (bounded by sessionId equality)
    const users = await this.scanCollection(this.db.collection('users'), (d) => d.id);
    for (const uid of users) {
      const docSnap = await this.db.collection('users').doc(uid).collection('sessions').doc(sid).get();
      if (docSnap.exists) return docSnap.data() as SessionRecord;
    }
    return null;
  }

  async getSessionSnapshots(studentId: string, sessionId: string): Promise<SessionQuestionSnapshot[]> {
    const uid = toSafeDocId(studentId || DEFAULT_STUDENT_ID);
    const sid = toSafeDocId(sessionId);
    const snapCol = this.db
      .collection('users')
      .doc(uid)
      .collection('sessions')
      .doc(sid)
      .collection('snapshots');
    const docs = await this.scanCollection(snapCol, (d) =>
      decodeFromFirestore(d.data() as SessionQuestionSnapshot)
    );
    return docs.sort((a, b) => a.snapshotIndex - b.snapshotIndex);
  }

  async saveSessionCheckpoint(
    sessionId: string,
    studentId: string,
    checkpoint: SessionCheckpoint,
    expectedRevision?: number
  ): Promise<CheckpointSaveResult> {
    const uid = toSafeDocId(studentId || DEFAULT_STUDENT_ID);
    const sid = toSafeDocId(sessionId);
    const sessRef = this.db.collection('users').doc(uid).collection('sessions').doc(sid);
    const savedAtIso = new Date().toISOString();

    const nextRevision = await this.db.runTransaction(async (tx) => {
      const docSnap = await tx.get(sessRef);
      if (!docSnap.exists) {
        throw new NotFoundError('Session not found.');
      }
      const existing = docSnap.data() as SessionRecord;
      if ((existing.studentId || uid) !== uid) {
        throw new ForbiddenError('Forbidden: session belongs to another user.');
      }
      if (existing.status !== 'in_progress') {
        throw new RevisionConflictError(
          'Session has already been submitted.',
          existing.checkpointRevision ?? 1,
          existing.checkpoint
        );
      }

      const currentRev = existing.checkpointRevision ?? 1;
      if (expectedRevision !== undefined && expectedRevision !== currentRev) {
        throw new RevisionConflictError(
          `Checkpoint revision conflict: client sent v${expectedRevision}, server is at v${currentRev}.`,
          currentRev,
          existing.checkpoint
        );
      }

      const bumpedRev = currentRev + 1;
      tx.update(
        sessRef,
        stripUndefinedDeep({
          checkpoint: structuredClone(checkpoint),
          checkpointRevision: bumpedRev,
          updatedAt: this.nowTs(),
        })
      );
      return bumpedRev;
    });

    return { checkpointRevision: nextRevision, savedAtIso };
  }

  async completeSession(
    sessionId: string,
    summary: { correctSlots: number; totalSlots: number; completedAt: string },
    studentId?: string
  ): Promise<void> {
    const session = await this.getSession(sessionId, studentId);
    if (!session) return;
    const uid = toSafeDocId(session.studentId || studentId || DEFAULT_STUDENT_ID);
    const sid = toSafeDocId(sessionId);
    await this.db
      .collection('users')
      .doc(uid)
      .collection('sessions')
      .doc(sid)
      .update(
        stripUndefinedDeep({
          status: 'submitted',
          correctSlots: summary.correctSlots,
          totalSlots: summary.totalSlots,
          completedAt: summary.completedAt,
          updatedAt: this.nowTs(),
        })
      );
  }

  async finalizeSessionAtomically(input: FinalizeSessionInput): Promise<FinalizeSessionResult> {
    const uid = toSafeDocId(input.studentId || DEFAULT_STUDENT_ID);
    const sid = toSafeDocId(input.sessionId);
    const userRef = this.db.collection('users').doc(uid);
    const sessRef = userRef.collection('sessions').doc(sid);

    // Quick pre-check for idempotency before staging auxiliary docs
    const initialSnap = await sessRef.get();
    if (!initialSnap.exists) {
      throw new NotFoundError('Session not found.');
    }
    const initialSession = initialSnap.data() as SessionRecord;
    if ((initialSession.studentId || uid) !== uid) {
      throw new ForbiddenError('Forbidden: cannot submit another user session.');
    }
    if (initialSession.status === 'submitted' && initialSession.submissionSummary) {
      return {
        alreadySubmitted: true,
        session: initialSession,
        submissionSummary: initialSession.submissionSummary,
      };
    }

    // Build all deterministic auxiliary writes
    const auxWrites: Array<{ ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown> }> = [];
    for (const att of input.attempts) {
      const aid = toSafeDocId(att.attemptId);
      auxWrites.push({
        ref: userRef.collection('attempts').doc(aid),
        data: stripUndefinedDeep({
          ...att,
          attemptId: aid,
          userId: uid,
          studentId: uid,
          createdAtIso: att.createdAt,
          createdAt: this.nowTs(),
        }),
      });
    }
    for (const st of input.skillStates) {
      const skDocId = toSafeDocId(st.skillId);
      auxWrites.push({
        ref: userRef.collection('skill_states').doc(skDocId),
        data: stripUndefinedDeep({
          ...st,
          userId: uid,
          confidence: st.uncertainty,
          ewmaSpeedRatio: st.avgTimeRatio,
          nextReviewDueAt: st.nextReviewAt,
          updatedAt: this.nowTs(),
        }),
      });
    }
    for (const mem of input.questionMemory) {
      const memDocId = toSafeDocId(mem.questionFamilyId);
      auxWrites.push({
        ref: userRef.collection('question_memory').doc(memDocId),
        data: stripUndefinedDeep({
          ...mem,
          userId: uid,
          easeFactor: mem.easeFactor ?? 2.5,
          streak: mem.timesSeen,
          updatedAt: this.nowTs(),
        }),
      });
    }
    for (const ev of input.evidenceUpdates) {
      const evDocId = toSafeDocId(ev.evidenceKey);
      auxWrites.push({
        ref: userRef.collection('question_evidence').doc(evDocId),
        data: stripUndefinedDeep({
          ...ev,
          userId: uid,
          updatedAt: this.nowTs(),
        }),
      });
    }
    for (const wsub of input.writingSubmissions) {
      const subId = toSafeDocId(wsub.submissionId);
      let metricsMap: Record<string, unknown> = {};
      try {
        metricsMap = JSON.parse(wsub.deterministicMetricsJson || '{}');
      } catch {
        metricsMap = {};
      }
      auxWrites.push({
        ref: userRef.collection('writing_submissions').doc(subId),
        data: stripUndefinedDeep({
          ...wsub,
          submissionId: subId,
          userId: uid,
          deterministicMetrics: metricsMap,
          evaluations: [],
          createdAt: this.nowTs(),
          updatedAt: this.nowTs(),
        }),
      });
    }

    // If total ops fit comfortably in a single Firestore transaction (< 400 writes), execute 100% inside runTransaction!
    // Otherwise stage deterministic auxiliary writes in batches BEFORE the atomic transaction flips status: 'submitted'.
    if (auxWrites.length >= 380) {
      await this.commitChunkedWrites(
        auxWrites.map((item) => (b: FirebaseFirestore.WriteBatch) => b.set(item.ref, item.data))
      );
    }

    const lockRef = userRef.collection('locks').doc('active_session');

    return this.db.runTransaction(async (tx) => {
      const [currentSnap, lockSnap] = await Promise.all([tx.get(sessRef), tx.get(lockRef)]);
      if (!currentSnap.exists) {
        throw new NotFoundError('Session not found.');
      }
      const existing = currentSnap.data() as SessionRecord;
      if ((existing.studentId || uid) !== uid) {
        throw new ForbiddenError('Forbidden: cannot submit another user session.');
      }
      if (existing.status === 'submitted' && existing.submissionSummary) {
        return {
          alreadySubmitted: true,
          session: existing,
          submissionSummary: existing.submissionSummary,
        };
      }

      if (auxWrites.length < 380) {
        for (const item of auxWrites) {
          tx.set(item.ref, item.data);
        }
      }

      if (lockSnap.exists && lockSnap.data()?.activeSessionId === sid) {
        tx.delete(lockRef);
      }

      const nextRev = (existing.checkpointRevision ?? 1) + 1;
      const updatedSession: SessionRecord = {
        ...existing,
        status: 'submitted',
        checkpoint: structuredClone(input.checkpoint),
        checkpointRevision: nextRev,
        correctSlots: input.correctSlots,
        totalSlots: input.totalSlots,
        completedAt: input.completedAtIso,
        expiredAutoSubmitted: input.expiredAutoSubmitted || existing.expiredAutoSubmitted,
        submissionSummary: input.submissionSummary,
      };

      tx.update(
        sessRef,
        stripUndefinedDeep({
          status: 'submitted',
          checkpoint: updatedSession.checkpoint,
          checkpointRevision: nextRev,
          correctSlots: input.correctSlots,
          totalSlots: input.totalSlots,
          completedAt: input.completedAtIso,
          expiredAutoSubmitted: updatedSession.expiredAutoSubmitted ?? false,
          submissionSummary: input.submissionSummary,
          updatedAt: this.nowTs(),
        })
      );

      return {
        alreadySubmitted: false,
        session: updatedSession,
        submissionSummary: input.submissionSummary,
      };
    });
  }

  async listSessions(limit = 50, studentId = DEFAULT_STUDENT_ID, includeSandbox = true): Promise<SessionRecord[]> {
    const uid = toSafeDocId(studentId || DEFAULT_STUDENT_ID);
    const snap = await this.db
      .collection('users')
      .doc(uid)
      .collection('sessions')
      .orderBy('startedAt', 'desc')
      .limit(limit)
      .get();
    return snap.docs
      .map((d) => d.data() as SessionRecord)
      .filter((s) => (includeSandbox ? true : !s.isSandbox));
  }

  async appendPartAttempts(attempts: PartAttemptRecord[]): Promise<void> {
    if (attempts.length === 0) return;
    const writeOps: Array<(b: FirebaseFirestore.WriteBatch) => void> = [];
    for (const a of attempts) {
      const uid = toSafeDocId(a.studentId || DEFAULT_STUDENT_ID);
      const aid = toSafeDocId(a.attemptId);
      const ref = this.db.collection('users').doc(uid).collection('attempts').doc(aid);
      writeOps.push((batch) =>
        batch.set(
          ref,
          stripUndefinedDeep({
            ...a,
            attemptId: aid,
            userId: uid,
            studentId: uid,
            createdAtIso: a.createdAt,
            createdAt: this.nowTs(),
          })
        )
      );
    }
    await this.commitChunkedWrites(writeOps);
  }

  async listPartAttempts(
    limit = 1000,
    studentId = DEFAULT_STUDENT_ID,
    includeSandbox = false
  ): Promise<PartAttemptRecord[]> {
    const uid = toSafeDocId(studentId || DEFAULT_STUDENT_ID);
    const all = await this.scanCollection(
      this.db.collection('users').doc(uid).collection('attempts'),
      (d) => {
        const data = d.data() as Record<string, unknown>;
        return {
          ...(data as unknown as PartAttemptRecord),
          createdAt: String(data.createdAtIso || data.createdAt || ''),
        };
      }
    );
    return all
      .filter((a) => (includeSandbox ? true : !a.isSandbox))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, limit);
  }

  async getQuestionEvidence(studentId: string): Promise<Record<string, QuestionMasteryEvidence>> {
    const uid = toSafeDocId(studentId || DEFAULT_STUDENT_ID);
    const rows = await this.scanCollection(
      this.db.collection('users').doc(uid).collection('question_evidence'),
      (d) => d.data() as QuestionMasteryEvidence
    );
    const out: Record<string, QuestionMasteryEvidence> = {};
    for (const ev of rows) {
      if (ev?.evidenceKey) out[ev.evidenceKey] = ev;
    }
    return out;
  }

  async upsertQuestionEvidence(entries: QuestionMasteryEvidence[], studentId: string): Promise<void> {
    if (entries.length === 0) return;
    const uid = toSafeDocId(studentId || DEFAULT_STUDENT_ID);
    await this.commitChunkedWrites(
      entries.map((ev) => (batch) =>
        batch.set(
          this.db.collection('users').doc(uid).collection('question_evidence').doc(toSafeDocId(ev.evidenceKey)),
          stripUndefinedDeep({
            ...ev,
            userId: uid,
            updatedAt: this.nowTs(),
          })
        )
      )
    );
  }

  async saveWritingSubmission(sub: WritingSubmissionRecord): Promise<void> {
    const uid = toSafeDocId(sub.studentId || DEFAULT_STUDENT_ID);
    const subId = toSafeDocId(sub.submissionId);
    await this.ensureUserDocExists(uid);
    let metricsMap: Record<string, unknown> = {};
    try {
      metricsMap = JSON.parse(sub.deterministicMetricsJson || '{}');
    } catch {
      metricsMap = {};
    }
    await this.db
      .collection('users')
      .doc(uid)
      .collection('writing_submissions')
      .doc(subId)
      .set(
        stripUndefinedDeep({
          ...sub,
          submissionId: subId,
          userId: uid,
          studentId: uid,
          deterministicMetrics: metricsMap,
          evaluations: [],
          createdAt: this.nowTs(),
          updatedAt: this.nowTs(),
        })
      );
  }

  async getWritingSubmission(
    submissionId: string,
    studentId?: string
  ): Promise<(WritingSubmissionRecord & { evaluations: WritingEvaluationRecord[] }) | null> {
    const subId = toSafeDocId(submissionId);
    if (studentId) {
      const snap = await this.db
        .collection('users')
        .doc(toSafeDocId(studentId))
        .collection('writing_submissions')
        .doc(subId)
        .get();
      if (!snap.exists) return null;
      const data = snap.data() as WritingSubmissionRecord & { evaluations?: WritingEvaluationRecord[] };
      return { ...data, evaluations: Array.isArray(data.evaluations) ? data.evaluations : [] };
    }
    const users = await this.scanCollection(this.db.collection('users'), (d) => d.id);
    for (const uid of users) {
      const snap = await this.db
        .collection('users')
        .doc(uid)
        .collection('writing_submissions')
        .doc(subId)
        .get();
      if (snap.exists) {
        const data = snap.data() as WritingSubmissionRecord & { evaluations?: WritingEvaluationRecord[] };
        return { ...data, evaluations: Array.isArray(data.evaluations) ? data.evaluations : [] };
      }
    }
    return null;
  }

  async listWritingSubmissions(
    studentId = DEFAULT_STUDENT_ID
  ): Promise<(WritingSubmissionRecord & { evaluations: WritingEvaluationRecord[] })[]> {
    const uid = toSafeDocId(studentId || DEFAULT_STUDENT_ID);
    const rows = await this.scanCollection(
      this.db.collection('users').doc(uid).collection('writing_submissions'),
      (d) => {
        const data = d.data() as WritingSubmissionRecord & { evaluations?: WritingEvaluationRecord[] };
        return { ...data, evaluations: Array.isArray(data.evaluations) ? data.evaluations : [] };
      }
    );
    return rows.sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt));
  }

  async saveWritingEvaluation(ev: WritingEvaluationRecord, studentId?: string): Promise<void> {
    const sub = await this.getWritingSubmission(ev.submissionId, studentId);
    if (!sub) throw new NotFoundError('Writing submission not found.');
    const uid = toSafeDocId(sub.studentId || studentId || DEFAULT_STUDENT_ID);
    const subId = toSafeDocId(ev.submissionId);
    const nextEvals = [ev, ...(sub.evaluations || []).filter((e) => e.evaluationId !== ev.evaluationId)].slice(0, 10);
    await this.db
      .collection('users')
      .doc(uid)
      .collection('writing_submissions')
      .doc(subId)
      .update(
        stripUndefinedDeep({
          evaluations: nextEvals,
          updatedAt: this.nowTs(),
        })
      );
  }

  async getSkillStates(studentId = DEFAULT_STUDENT_ID): Promise<Record<string, SkillState>> {
    const uid = toSafeDocId(studentId || DEFAULT_STUDENT_ID);
    const rows = await this.scanCollection(
      this.db.collection('users').doc(uid).collection('skill_states'),
      (d) => d.data() as SkillState
    );
    const out: Record<string, SkillState> = {};
    for (const s of rows) {
      if (s?.skillId) out[s.skillId] = s;
    }
    return out;
  }

  async upsertSkillStates(states: SkillState[], studentId = DEFAULT_STUDENT_ID): Promise<void> {
    if (states.length === 0) return;
    const uid = toSafeDocId(studentId || DEFAULT_STUDENT_ID);
    await this.commitChunkedWrites(
      states.map((s) => (batch) =>
        batch.set(
          this.db.collection('users').doc(uid).collection('skill_states').doc(toSafeDocId(s.skillId)),
          stripUndefinedDeep({
            ...s,
            userId: uid,
            confidence: s.uncertainty,
            ewmaSpeedRatio: s.avgTimeRatio,
            nextReviewDueAt: s.nextReviewAt,
            updatedAt: this.nowTs(),
          })
        )
      )
    );
  }

  async getQuestionMemory(studentId = DEFAULT_STUDENT_ID): Promise<Record<string, QuestionMemoryState>> {
    const uid = toSafeDocId(studentId || DEFAULT_STUDENT_ID);
    const rows = await this.scanCollection(
      this.db.collection('users').doc(uid).collection('question_memory'),
      (d) => d.data() as QuestionMemoryState
    );
    const out: Record<string, QuestionMemoryState> = {};
    for (const m of rows) {
      if (m?.questionFamilyId) out[m.questionFamilyId] = m;
    }
    return out;
  }

  async upsertQuestionMemory(entries: QuestionMemoryState[], studentId = DEFAULT_STUDENT_ID): Promise<void> {
    if (entries.length === 0) return;
    const uid = toSafeDocId(studentId || DEFAULT_STUDENT_ID);
    await this.commitChunkedWrites(
      entries.map((m) => (batch) =>
        batch.set(
          this.db.collection('users').doc(uid).collection('question_memory').doc(toSafeDocId(m.questionFamilyId)),
          stripUndefinedDeep({
            ...m,
            userId: uid,
            easeFactor: m.easeFactor ?? 2.5,
            streak: m.timesSeen,
            updatedAt: this.nowTs(),
          })
        )
      )
    );
  }

  async getDailyFocusPlan(studentId: string, planDate: string): Promise<DailyFocusPlan | null> {
    const uid = toSafeDocId(studentId || DEFAULT_STUDENT_ID);
    const snap = await this.db
      .collection('users')
      .doc(uid)
      .collection('daily_plans')
      .doc(toSafeDocId(planDate))
      .get();
    return snap.exists ? (snap.data() as DailyFocusPlan) : null;
  }

  async saveDailyFocusPlan(studentId: string, plan: DailyFocusPlan): Promise<void> {
    const uid = toSafeDocId(studentId || DEFAULT_STUDENT_ID);
    await this.ensureUserDocExists(uid);
    await this.db
      .collection('users')
      .doc(uid)
      .collection('daily_plans')
      .doc(toSafeDocId(plan.planDate))
      .set(
        stripUndefinedDeep({
          ...plan,
          userId: uid,
          updatedAt: this.nowTs(),
        })
      );
  }

  async saveQuestionFlag(flag: QuestionFlagRecord): Promise<void> {
    const fid = toSafeDocId(flag.flagId);
    await this.db
      .collection('question_flags')
      .doc(fid)
      .set(
        stripUndefinedDeep({
          ...flag,
          flagId: fid,
          userId: toSafeDocId(flag.studentId || DEFAULT_STUDENT_ID),
          createdAtIso: flag.createdAt,
          createdAt: this.nowTs(),
          updatedAt: this.nowTs(),
        })
      );
  }

  async listQuestionFlags(): Promise<QuestionFlagRecord[]> {
    const rows = await this.scanCollection(this.db.collection('question_flags'), (d) => {
      const data = d.data() as Record<string, unknown>;
      return {
        flagId: String(data.flagId),
        questionId: String(data.questionId),
        sessionId: String(data.sessionId || ''),
        studentId: data.studentId ? String(data.studentId) : data.userId ? String(data.userId) : undefined,
        reason: String(data.reason),
        notes: data.notes ? String(data.notes) : undefined,
        status: (data.status as 'open' | 'resolved') || 'open',
        createdAt: String(data.createdAtIso || data.createdAt || ''),
      };
    });
    return rows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  async resolveQuestionFlag(flagId: string): Promise<void> {
    const fid = toSafeDocId(flagId);
    await this.db.collection('question_flags').doc(fid).update({
      status: 'resolved',
      updatedAt: this.nowTs(),
    });
  }

  async saveMediaAsset(asset: MediaAssetRecord): Promise<void> {
    const aid = toSafeDocId(asset.assetId);
    await this.db
      .collection('media_assets')
      .doc(aid)
      .set(stripUndefinedDeep({ ...asset, assetId: aid, createdAt: this.nowTs() }));
  }

  async getMediaAsset(assetId: string): Promise<MediaAssetRecord | null> {
    const snap = await this.db.collection('media_assets').doc(toSafeDocId(assetId)).get();
    return snap.exists ? (snap.data() as MediaAssetRecord) : null;
  }

  async listMediaAssets(): Promise<MediaAssetRecord[]> {
    return this.scanCollection(this.db.collection('media_assets'), (d) => d.data() as MediaAssetRecord);
  }

  async exportFullBackup(): Promise<CanonicalBackupBundle> {
    const [{ questions, stimuliById }, importBatches, configVersions, mediaAssets, questionFlags, userDocs] =
      await Promise.all([
        this.getAllQuestionsAndStimuli(),
        this.listImportBatches(),
        this.listConfigVersions(),
        this.listMediaAssets(),
        this.listQuestionFlags(),
        this.scanCollection(this.db.collection('users'), (d) => ({
          uid: d.id,
          role: (d.data()?.role as 'student' | 'admin') || 'student',
          displayName: String(d.data()?.displayName || d.id),
        })),
      ]);

    const stimuli = Object.values(stimuliById).sort((a, b) =>
      a.stimulusId.localeCompare(b.stimulusId)
    );
    const sortedQuestions = [...questions].sort((a, b) =>
      a.questionId.localeCompare(b.questionId)
    );

    const usersData = await Promise.all(
      userDocs.map(async (u) => {
        const userRef = this.db.collection('users').doc(u.uid);
        const [privSnap, sessions, attempts, skillStatesMap, memoryMap, evidenceMap, writingSubmissions] =
          await Promise.all([
            userRef.collection('private').doc('info').get(),
            this.scanCollection(userRef.collection('sessions'), (d) => d.data() as SessionRecord),
            this.scanCollection(userRef.collection('attempts'), (d) => {
              const data = d.data() as Record<string, unknown>;
              return {
                ...(data as unknown as PartAttemptRecord),
                createdAt: String(data.createdAtIso || data.createdAt || ''),
              };
            }),
            this.getSkillStates(u.uid),
            this.getQuestionMemory(u.uid),
            this.getQuestionEvidence(u.uid),
            this.listWritingSubmissions(u.uid),
          ]);

        const snapshotsEntries = await Promise.all(
          sessions.map(async (s) => [s.sessionId, await this.getSessionSnapshots(u.uid, s.sessionId)] as const)
        );

        return {
          uid: u.uid,
          role: u.role,
          displayName: u.displayName,
          email: privSnap.exists ? String(privSnap.data()?.email || '') : undefined,
          sessions,
          sessionSnapshotsBySessionId: Object.fromEntries(snapshotsEntries),
          partAttempts: attempts,
          skillStates: Object.values(skillStatesMap),
          questionMemory: Object.values(memoryMap),
          questionEvidence: Object.values(evidenceMap),
          writingSubmissions,
        };
      })
    );

    return finalizeBackupBundle({
      exportedAtIso: new Date().toISOString(),
      backendName: this.backendName,
      stimuli,
      questions: sortedQuestions,
      importBatches,
      configVersions: [...configVersions].sort((a, b) => a.versionNumber - b.versionNumber),
      mediaAssets,
      questionFlags,
      users: usersData,
    });
  }

  async restoreFullBackup(rawBundle: unknown, options: { dryRun: boolean }): Promise<BackupRestoreReport> {
    const validated = validateIncomingBackupBundle(rawBundle);
    if (!validated.valid || !validated.bundle) {
      return emptyRestoreReport(
        false,
        options.dryRun,
        validated.checksumVerified,
        validated.errors,
        validated.warnings
      );
    }
    const bundle = validated.bundle;
    const { questions: existingQs, stimuliById: existingStims } = await this.getAllQuestionsAndStimuli();
    const existingQIds = new Set(existingQs.map((q) => q.questionId));
    const existingCfgIds = new Set((await this.listConfigVersions()).map((c) => c.configVersionId));
    const existingBatchIds = new Set((await this.listImportBatches()).map((b) => b.batchId));
    const existingFlagIds = new Set((await this.listQuestionFlags()).map((f) => f.flagId));
    const existingMediaIds = new Set((await this.listMediaAssets()).map((m) => m.assetId));

    const wouldCreate: Record<string, number> = {
      stimuli: bundle.stimuli.filter((s) => !existingStims[s.stimulusId]).length,
      questions: bundle.questions.filter((q) => !existingQIds.has(q.questionId)).length,
      importBatches: (bundle.importBatches || []).filter((b) => !existingBatchIds.has(b.batchId)).length,
      configVersions: bundle.configVersions.filter((c) => !existingCfgIds.has(c.configVersionId)).length,
      mediaAssets: (bundle.mediaAssets || []).filter((m) => !existingMediaIds.has(m.assetId)).length,
      questionFlags: (bundle.questionFlags || []).filter((f) => !existingFlagIds.has(f.flagId)).length,
      users: bundle.users.length,
      sessions: bundle.users.reduce((n, u) => n + u.sessions.length, 0),
      partAttempts: bundle.users.reduce((n, u) => n + u.partAttempts.length, 0),
      questionEvidence: bundle.users.reduce((n, u) => n + u.questionEvidence.length, 0),
    };
    const wouldSkipExisting: Record<string, number> = {
      stimuli: bundle.stimuli.length - wouldCreate.stimuli,
      questions: bundle.questions.length - wouldCreate.questions,
      importBatches: (bundle.importBatches || []).length - wouldCreate.importBatches,
      configVersions: bundle.configVersions.length - wouldCreate.configVersions,
      mediaAssets: (bundle.mediaAssets || []).length - wouldCreate.mediaAssets,
      questionFlags: (bundle.questionFlags || []).length - wouldCreate.questionFlags,
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

    const writeOps: Array<(b: FirebaseFirestore.WriteBatch) => void> = [];
    const applied: Record<string, number> = { stimuli: 0, questions: 0, configVersions: 0, sessions: 0, attempts: 0, evidence: 0 };

    for (const s of bundle.stimuli) {
      if (existingStims[s.stimulusId]) continue;
      applied.stimuli++;
      const sid = toSafeDocId(s.stimulusId);
      writeOps.push((batch) =>
        batch.set(
          this.db.collection('bank_stimuli').doc(sid),
          stripUndefinedDeep({
            stimulusId: sid,
            stimulusFamilyId: s.stimulusFamilyId,
            version: s.version,
            section: s.section,
            genreOrTextType: s.genreOrTextType,
            payload: s,
            updatedAtIso: s.updatedAtIso || bundle.exportedAtIso,
            updatedAt: this.nowTs(),
          })
        )
      );
    }

    for (const q of bundle.questions) {
      if (existingQIds.has(q.questionId)) continue;
      applied.questions++;
      const qid = toSafeDocId(q.questionId);
      writeOps.push((batch) =>
        batch.set(
          this.db.collection('bank_questions').doc(qid),
          stripUndefinedDeep({
            questionId: qid,
            questionFamilyId: q.questionFamilyId,
            version: q.version,
            section: q.section,
            formatType: q.formatType,
            poolType: q.poolType,
            qcStatus: q.qcStatus,
            batchId: q.batchId,
            payload: q,
            updatedAtIso: q.updatedAtIso || bundle.exportedAtIso,
            updatedAt: this.nowTs(),
          })
        )
      );
    }

    for (const b of bundle.importBatches || []) {
      if (existingBatchIds.has(b.batchId)) continue;
      writeOps.push((batch) =>
        batch.set(
          this.db.collection('import_batches').doc(toSafeDocId(b.batchId)),
          stripUndefinedDeep({ ...b, createdAt: this.nowTs() })
        )
      );
    }

    for (const c of bundle.configVersions) {
      if (existingCfgIds.has(c.configVersionId)) continue;
      applied.configVersions++;
      writeOps.push((batch) =>
        batch.set(
          this.db.collection('admin_configs').doc(toSafeDocId(c.configVersionId)),
          stripUndefinedDeep({ ...c, createdAtIso: c.createdAt, createdAt: this.nowTs() })
        )
      );
    }

    for (const m of bundle.mediaAssets || []) {
      if (existingMediaIds.has(m.assetId)) continue;
      writeOps.push((batch) =>
        batch.set(
          this.db.collection('media_assets').doc(toSafeDocId(m.assetId)),
          stripUndefinedDeep({ ...m, createdAt: this.nowTs() })
        )
      );
    }

    for (const f of bundle.questionFlags || []) {
      if (existingFlagIds.has(f.flagId)) continue;
      writeOps.push((batch) =>
        batch.set(
          this.db.collection('question_flags').doc(toSafeDocId(f.flagId)),
          stripUndefinedDeep({ ...f, createdAtIso: f.createdAt, createdAt: this.nowTs(), updatedAt: this.nowTs() })
        )
      );
    }

    for (const u of bundle.users) {
      const uid = toSafeDocId(u.uid);
      const userRef = this.db.collection('users').doc(uid);
      writeOps.push((batch) =>
        batch.set(
          userRef,
          stripUndefinedDeep({
            uid,
            displayName: u.displayName,
            role: u.role,
            createdAt: this.nowTs(),
            updatedAt: this.nowTs(),
          }),
          { merge: true }
        )
      );
      if (u.email) {
        writeOps.push((batch) =>
          batch.set(
            userRef.collection('private').doc('info'),
            { uid, email: u.email, createdAt: this.nowTs(), updatedAt: this.nowTs() },
            { merge: true }
          )
        );
      }
      for (const s of u.sessions) {
        applied.sessions++;
        const sid = toSafeDocId(s.sessionId);
        const sRef = userRef.collection('sessions').doc(sid);
        writeOps.push((batch) =>
          batch.set(sRef, stripUndefinedDeep({ ...s, userId: uid, createdAt: this.nowTs(), updatedAt: this.nowTs() }))
        );
        for (const snap of u.sessionSnapshotsBySessionId?.[s.sessionId] || []) {
          writeOps.push((batch) =>
            batch.set(sRef.collection('snapshots').doc(toSafeDocId(snap.questionId)), stripUndefinedDeep(snap))
          );
        }
      }
      for (const a of u.partAttempts) {
        applied.attempts++;
        const aid = toSafeDocId(a.attemptId);
        writeOps.push((batch) =>
          batch.set(
            userRef.collection('attempts').doc(aid),
            stripUndefinedDeep({ ...a, userId: uid, createdAtIso: a.createdAt, createdAt: this.nowTs() })
          )
        );
      }
      for (const sk of u.skillStates) {
        writeOps.push((batch) =>
          batch.set(
            userRef.collection('skill_states').doc(toSafeDocId(sk.skillId)),
            stripUndefinedDeep({ ...sk, userId: uid, updatedAt: this.nowTs() })
          )
        );
      }
      for (const mem of u.questionMemory) {
        writeOps.push((batch) =>
          batch.set(
            userRef.collection('question_memory').doc(toSafeDocId(mem.questionFamilyId)),
            stripUndefinedDeep({ ...mem, userId: uid, updatedAt: this.nowTs() })
          )
        );
      }
      for (const ev of u.questionEvidence) {
        applied.evidence++;
        writeOps.push((batch) =>
          batch.set(
            userRef.collection('question_evidence').doc(toSafeDocId(ev.evidenceKey)),
            stripUndefinedDeep({ ...ev, userId: uid, updatedAt: this.nowTs() })
          )
        );
      }
      for (const ws of u.writingSubmissions) {
        writeOps.push((batch) =>
          batch.set(
            userRef.collection('writing_submissions').doc(toSafeDocId(ws.submissionId)),
            stripUndefinedDeep({ ...ws, userId: uid, createdAt: this.nowTs(), updatedAt: this.nowTs() })
          )
        );
      }
    }

    await this.commitChunkedWrites(writeOps);

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
  }

  async runMigrationPreflight(uploadsDir = 'public/assets/uploads'): Promise<MigrationPreflightReport> {
    const [{ questions, stimuliById }, mediaAssets, userIds] = await Promise.all([
      this.getAllQuestionsAndStimuli(),
      this.listMediaAssets(),
      this.scanCollection(this.db.collection('users'), (d) => d.id),
    ]);

    let totalSessions = 0;
    let totalPartAttempts = 0;
    let sessionsMissingSnapshots = 0;
    let attemptsMissingEvidenceRevision = 0;
    let legacyUntaggedAttempts = 0;

    for (const uid of userIds) {
      const [sessions, attempts] = await Promise.all([
        this.scanCollection(this.db.collection('users').doc(uid).collection('sessions'), (d) => d.data() as SessionRecord),
        this.scanCollection(this.db.collection('users').doc(uid).collection('attempts'), (d) => d.data() as PartAttemptRecord),
      ]);
      totalSessions += sessions.length;
      totalPartAttempts += attempts.length;
      for (const s of sessions) {
        const snaps = await this.getSessionSnapshots(uid, s.sessionId);
        if (snaps.length === 0) sessionsMissingSnapshots++;
      }
      for (const a of attempts) {
        if (!a.evidenceRevision) attemptsMissingEvidenceRevision++;
        if (a.isLegacy) legacyUntaggedAttempts++;
      }
    }

    const mediaManifest = await buildMediaMigrationManifest({
      questions,
      stimuli: Object.values(stimuliById),
      mediaAssets,
      uploadsDir,
    });

    return {
      checkedAtIso: new Date().toISOString(),
      backendName: this.backendName,
      totalQuestions: questions.length,
      totalSessions,
      totalPartAttempts,
      sessionsMissingSnapshots,
      attemptsMissingEvidenceRevision,
      questionsMissingEvidenceRevision: questions.filter((q) => !q.evidenceRevision).length,
      legacyUntaggedAttempts,
      mediaNeedsUploadCount: mediaManifest.needsUploadCount,
      mediaMissingFilesCount: mediaManifest.missingFilesCount,
    };
  }

  async hydrateSyncData(studentId: string, payload: SyncHydratePayload): Promise<void> {
    const uid = toSafeDocId(studentId || DEFAULT_STUDENT_ID);
    await this.ensureUserDocExists(uid);
    const writeOps: Array<(b: FirebaseFirestore.WriteBatch) => void> = [];
    const nowIso = new Date().toISOString();

    for (const s of payload.stimuli || []) {
      if (!s?.stimulusId) continue;
      const sid = toSafeDocId(s.stimulusId);
      writeOps.push((batch) =>
        batch.set(
          this.db.collection('bank_stimuli').doc(sid),
          stripUndefinedDeep({
            stimulusId: sid,
            stimulusFamilyId: s.stimulusFamilyId,
            version: s.version,
            section: s.section,
            genreOrTextType: s.genreOrTextType,
            payload: s,
            updatedAtIso: nowIso,
            updatedAt: this.nowTs(),
          }),
          { merge: true }
        )
      );
    }

    for (const q of payload.questions || []) {
      if (!q?.questionId) continue;
      const qid = toSafeDocId(q.questionId);
      writeOps.push((batch) =>
        batch.set(
          this.db.collection('bank_questions').doc(qid),
          stripUndefinedDeep({
            questionId: qid,
            questionFamilyId: q.questionFamilyId,
            version: q.version,
            section: q.section,
            formatType: q.formatType,
            poolType: q.poolType,
            qcStatus: q.qcStatus,
            payload: q,
            updatedAtIso: nowIso,
            updatedAt: this.nowTs(),
          }),
          { merge: true }
        )
      );
    }

    for (const cfg of payload.configVersions || []) {
      if (!cfg?.configVersionId) continue;
      writeOps.push((batch) =>
        batch.set(
          this.db.collection('admin_configs').doc(toSafeDocId(cfg.configVersionId)),
          stripUndefinedDeep({
            ...cfg,
            createdAtIso: cfg.createdAt || nowIso,
            createdAt: this.nowTs(),
          }),
          { merge: true }
        )
      );
    }

    const userRef = this.db.collection('users').doc(uid);
    for (const sess of payload.sessions || []) {
      if (!sess?.sessionId) continue;
      const sid = toSafeDocId(sess.sessionId);
      writeOps.push((batch) =>
        batch.set(
          userRef.collection('sessions').doc(sid),
          stripUndefinedDeep({
            ...sess,
            studentId: uid,
            userId: uid,
            createdAt: this.nowTs(),
            updatedAt: this.nowTs(),
          }),
          { merge: true }
        )
      );
    }

    for (const att of payload.attempts || []) {
      if (!att?.attemptId) continue;
      const aid = toSafeDocId(att.attemptId);
      const isLegacy = att.evidenceRevision ? Boolean(att.isLegacy) : true;
      writeOps.push((batch) =>
        batch.set(
          userRef.collection('attempts').doc(aid),
          stripUndefinedDeep({
            ...att,
            attemptId: aid,
            studentId: uid,
            userId: uid,
            isLegacy,
            createdAtIso: att.createdAt,
            createdAt: this.nowTs(),
          }),
          { merge: true }
        )
      );
    }

    await this.commitChunkedWrites(writeOps);
    if (payload.skillStates?.length) await this.upsertSkillStates(payload.skillStates, uid);
    if (payload.questionMemory?.length) await this.upsertQuestionMemory(payload.questionMemory, uid);
    for (const sub of payload.writingSubmissions || []) {
      await this.saveWritingSubmission({ ...sub, studentId: uid });
      for (const ev of sub.evaluations || []) {
        await this.saveWritingEvaluation(ev, uid);
      }
    }
    for (const fl of payload.flags || []) {
      await this.saveQuestionFlag(fl);
    }
    for (const ov of payload.questionOverrides || []) {
      if (ov.qcStatus) await this.updateQuestionStatus(ov.questionId, ov.qcStatus).catch(() => undefined);
      if (ov.visual) await this.updateQuestionVisual(ov.questionId, ov.visual).catch(() => undefined);
    }
  }
}
