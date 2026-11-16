import crypto from 'node:crypto';
import type {
  BankImportManifest,
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
import { computeEvidenceRevision } from '../../shared/mastery.ts';
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

export class MemoryRepository implements AppRepository {
  readonly backendName = 'memory_preview' as const;

  private users = new Map<string, { uid: string; role: 'student' | 'admin'; displayName: string; email?: string }>();
  private admins = new Set<string>();
  private stimuli = new Map<string, StimulusGroup>();
  private questions = new Map<string, QuestionItem>();
  private batches: ImportBatchRecord[] = [];
  private mediaAssets = new Map<string, MediaAssetRecord>();
  private configs: {
    configVersionId: string;
    versionNumber: number;
    notes?: string;
    createdAt: string;
    config: LearningConfig;
  }[] = [
    {
      configVersionId: 'cfg_v1',
      versionNumber: 1,
      notes: 'Default Selective Lab Learning Config',
      createdAt: new Date().toISOString(),
      config: structuredClone(DEFAULT_LEARNING_CONFIG),
    },
  ];
  private sessions = new Map<string, SessionRecord>();
  private snapshotsBySessionId = new Map<string, SessionQuestionSnapshot[]>();
  private attempts: PartAttemptRecord[] = [];
  private writingSubmissions = new Map<string, WritingSubmissionRecord>();
  private writingEvaluations: WritingEvaluationRecord[] = [];
  private skillStatesByStudent = new Map<string, Record<string, SkillState>>();
  private questionMemoryByStudent = new Map<string, Record<string, QuestionMemoryState>>();
  private questionEvidenceByStudent = new Map<string, Record<string, QuestionMasteryEvidence>>();
  private flags = new Map<string, QuestionFlagRecord>();

  async initAndSeedIfEmpty(seedManifest: BankImportManifest): Promise<void> {
    if (this.questions.size > 0) return;
    await this.importManifest(seedManifest, 'system_seed');
  }

  async upsertUserFromAuth(input: {
    uid: string;
    email: string;
    displayName?: string;
    isBootstrappedAdmin: boolean;
  }): Promise<{ role: 'student' | 'admin' }> {
    const existing = this.users.get(input.uid);
    const isAdmin =
      input.isBootstrappedAdmin || this.admins.has(input.uid) || existing?.role === 'admin';
    const role: 'student' | 'admin' = isAdmin ? 'admin' : 'student';
    if (isAdmin) this.admins.add(input.uid);
    this.users.set(input.uid, {
      uid: input.uid,
      role,
      displayName: input.displayName || input.email.split('@')[0] || 'Learner',
      email: input.email,
    });
    return { role };
  }

  async isUserAdmin(uid: string): Promise<boolean> {
    return this.admins.has(uid) || this.users.get(uid)?.role === 'admin';
  }

  async hydrateSyncData(studentId: string, payload: SyncHydratePayload): Promise<void> {
    const uid = studentId || DEFAULT_STUDENT_ID;
    if (!this.users.has(uid)) {
      this.users.set(uid, { uid, role: 'student', displayName: uid });
    }

    for (const s of payload.stimuli || []) {
      if (s?.stimulusId && !this.stimuli.has(s.stimulusId)) {
        this.stimuli.set(s.stimulusId, structuredClone(s));
      }
    }

    for (const q of payload.questions || []) {
      if (q?.questionId && !this.questions.has(q.questionId)) {
        this.questions.set(q.questionId, structuredClone(q));
      }
    }

    for (const ov of payload.questionOverrides || []) {
      const existingQ = this.questions.get(ov.questionId);
      if (existingQ) {
        if (ov.qcStatus) existingQ.qcStatus = ov.qcStatus;
        if (ov.visual) existingQ.visual = structuredClone(ov.visual);
      }
    }

    if (Array.isArray(payload.configVersions) && payload.configVersions.length > 0) {
      const seenCfgIds = new Set(this.configs.map((c) => c.configVersionId));
      for (const cfg of payload.configVersions) {
        if (!cfg?.configVersionId || seenCfgIds.has(cfg.configVersionId)) continue;
        this.configs.push(structuredClone(cfg));
        seenCfgIds.add(cfg.configVersionId);
      }
      this.configs.sort((a, b) => a.versionNumber - b.versionNumber);
    }

    for (const s of payload.sessions || []) {
      if (!s?.sessionId) continue;
      const stamped = { ...structuredClone(s), studentId: uid };
      const existing = this.sessions.get(s.sessionId);
      if (!existing) {
        this.sessions.set(s.sessionId, stamped);
      } else if (stamped.status === 'submitted' && existing.status !== 'submitted') {
        this.sessions.set(s.sessionId, stamped);
      } else if (
        existing.status === 'in_progress' &&
        stamped.status === 'in_progress' &&
        (stamped.checkpoint?.elapsedSec ?? 0) > (existing.checkpoint?.elapsedSec ?? 0)
      ) {
        this.sessions.set(s.sessionId, stamped);
      }
    }

    if (Array.isArray(payload.attempts) && payload.attempts.length > 0) {
      const seenAttempts = new Set(this.attempts.map((a) => a.attemptId));
      for (const a of payload.attempts) {
        if (!a?.attemptId || seenAttempts.has(a.attemptId)) continue;
        this.attempts.push({
          ...structuredClone(a),
          studentId: uid,
          isLegacy: a.evidenceRevision ? Boolean(a.isLegacy) : true,
        });
        seenAttempts.add(a.attemptId);
      }
    }

    if (Array.isArray(payload.skillStates) && payload.skillStates.length > 0) {
      const map = { ...(this.skillStatesByStudent.get(uid) || {}) };
      for (const st of payload.skillStates) {
        if (!st?.skillId) continue;
        const prev = map[st.skillId];
        if (!prev || st.attemptsCount >= prev.attemptsCount) {
          map[st.skillId] = structuredClone(st);
        }
      }
      this.skillStatesByStudent.set(uid, map);
    }

    if (Array.isArray(payload.questionMemory) && payload.questionMemory.length > 0) {
      const map = { ...(this.questionMemoryByStudent.get(uid) || {}) };
      for (const mem of payload.questionMemory) {
        if (!mem?.questionFamilyId) continue;
        const prev = map[mem.questionFamilyId];
        if (!prev || mem.timesSeen >= prev.timesSeen) {
          map[mem.questionFamilyId] = structuredClone(mem);
        }
      }
      this.questionMemoryByStudent.set(uid, map);
    }

    if (Array.isArray(payload.writingSubmissions) && payload.writingSubmissions.length > 0) {
      const seenEvalIds = new Set(this.writingEvaluations.map((e) => e.evaluationId));
      for (const sub of payload.writingSubmissions) {
        if (!sub?.submissionId) continue;
        if (!this.writingSubmissions.has(sub.submissionId)) {
          const { evaluations: _ev, ...rest } = sub;
          this.writingSubmissions.set(sub.submissionId, { ...structuredClone(rest), studentId: uid });
        }
        for (const ev of sub.evaluations || []) {
          if (ev?.evaluationId && !seenEvalIds.has(ev.evaluationId)) {
            this.writingEvaluations.push(structuredClone(ev));
            seenEvalIds.add(ev.evaluationId);
          }
        }
      }
    }

    for (const fl of payload.flags || []) {
      if (!fl?.flagId) continue;
      const prev = this.flags.get(fl.flagId);
      if (!prev || (fl.status === 'resolved' && prev.status !== 'resolved')) {
        this.flags.set(fl.flagId, structuredClone(fl));
      }
    }
  }

  async listQuestions(filter?: {
    section?: string;
    poolType?: string;
    qcStatus?: string;
    includeHistorical?: boolean;
  }): Promise<QuestionItem[]> {
    const all = Array.from(this.questions.values());
    const base = filter?.includeHistorical ? all : selectLatestByFamily(all);
    return base
      .filter((q) => {
        if (filter?.section && q.section !== filter.section) return false;
        if (filter?.poolType && q.poolType !== filter.poolType) return false;
        if (filter?.qcStatus && q.qcStatus !== filter.qcStatus) return false;
        return true;
      })
      .map((q) => structuredClone(q));
  }

  async listQuestionsPaginated(params?: QuestionQueryParams): Promise<QuestionQueryResult> {
    const allQuestions = Array.from(this.questions.values()).map((q) => structuredClone(q));
    const stimuliById: Record<string, StimulusGroup> = {};
    for (const [id, s] of this.stimuli.entries()) {
      stimuliById[id] = structuredClone(s);
    }
    return filterAndPaginateQuestions({
      allQuestions,
      stimuliById,
      flags: await this.listQuestionFlags(),
      batches: await this.listImportBatches(),
      params,
    });
  }

  async listQuestionVersions(questionFamilyId: string): Promise<QuestionVersionSummary[]> {
    return Array.from(this.questions.values())
      .filter((q) => q.questionFamilyId === questionFamilyId)
      .sort((a, b) => b.version - a.version)
      .map((q) => ({
        question: structuredClone(q),
        stimulus: q.stimulusId && this.stimuli.get(q.stimulusId) ? structuredClone(this.stimuli.get(q.stimulusId)!) : undefined,
      }));
  }

  async listStimuliByIds(stimulusIds: string[]): Promise<Record<string, StimulusGroup>> {
    const out: Record<string, StimulusGroup> = {};
    for (const id of stimulusIds) {
      const s = this.stimuli.get(id);
      if (s) out[id] = structuredClone(s);
    }
    return out;
  }

  async getQuestionWithStimulus(
    questionId: string
  ): Promise<{ question: QuestionItem; stimulus?: StimulusGroup } | null> {
    const q = this.questions.get(questionId);
    if (!q) return null;
    const stimulus = q.stimulusId ? this.stimuli.get(q.stimulusId) : undefined;
    return {
      question: structuredClone(q),
      stimulus: stimulus ? structuredClone(stimulus) : undefined,
    };
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

    for (const s of manifest.stimuli || []) {
      const hash =
        s.contentHash ||
        computeCanonicalHash({
          title: s.title,
          preamble: s.preamble,
          mainTextMarkdown: s.mainTextMarkdown,
          extracts: s.extracts,
          visual: s.visual,
        });
      this.stimuli.set(s.stimulusId, {
        ...structuredClone(s),
        contentHash: hash,
        batchId: s.batchId || batchId,
        createdAtIso: s.createdAtIso || nowIso,
        updatedAtIso: nowIso,
      });
    }

    const latestByFamily = new Map<string, QuestionItem>();
    for (const q of this.questions.values()) {
      const prev = latestByFamily.get(q.questionFamilyId);
      if (!prev || q.version > prev.version) latestByFamily.set(q.questionFamilyId, q);
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
      const stim = q.stimulusId ? this.stimuli.get(q.stimulusId) : undefined;
      q.evidenceRevision = q.evidenceRevision || computeEvidenceRevision(q, stim);

      const existing = latestByFamily.get(q.questionFamilyId);
      if (!existing) {
        q.batchId = q.batchId || batchId;
        q.batchLabel = q.batchLabel || manifest.batchLabel;
        q.createdAtIso = q.createdAtIso || nowIso;
        q.updatedAtIso = nowIso;
        this.questions.set(q.questionId, q);
        latestByFamily.set(q.questionFamilyId, q);
        newQuestionIds.push(q.questionId);
        imported++;
      } else if (
        existing.contentHash === hash &&
        existing.version === q.version &&
        existing.questionId === q.questionId
      ) {
        skippedQuestionIds.push(q.questionId);
        skipped++;
      } else {
        const nextVersion = Math.max(existing.version + 1, q.version);
        const bumpedId =
          nextVersion !== q.version || this.questions.has(q.questionId)
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
        this.questions.set(bumpedQ.questionId, bumpedQ);
        latestByFamily.set(q.questionFamilyId, bumpedQ);
        versionBumpedQuestionIds.push(bumpedQ.questionId);
        versionBumped++;
      }
    }

    const batch: ImportBatchRecord = {
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
    this.batches.unshift(batch);

    return { imported, skipped, versionBumped, batch };
  }

  async listImportBatches(): Promise<ImportBatchRecord[]> {
    return structuredClone(this.batches);
  }

  async getImportBatch(batchId: string): Promise<ImportBatchRecord | null> {
    const b = this.batches.find((item) => item.batchId === batchId);
    return b ? structuredClone(b) : null;
  }

  async updateQuestionStatus(questionId: string, qcStatus: QuestionItem['qcStatus']): Promise<void> {
    const q = this.questions.get(questionId);
    if (!q) throw new NotFoundError(`Question ${questionId} not found.`);
    q.qcStatus = qcStatus;
    q.updatedAtIso = new Date().toISOString();
  }

  async updateQuestionVisual(questionId: string, visual: VisualSpec): Promise<void> {
    const q = this.questions.get(questionId);
    if (!q) throw new NotFoundError(`Question ${questionId} not found.`);
    q.visual = structuredClone(visual);
    q.updatedAtIso = new Date().toISOString();
    const stim = q.stimulusId ? this.stimuli.get(q.stimulusId) : undefined;
    q.evidenceRevision = computeEvidenceRevision(q, stim);
  }

  async getActiveConfig(): Promise<{ configVersionId: string; versionNumber: number; config: LearningConfig }> {
    const latest = this.configs[this.configs.length - 1];
    const cloned = structuredClone(latest.config);
    cloned.sessionDefaults = {
      ...DEFAULT_LEARNING_CONFIG.sessionDefaults,
      ...cloned.sessionDefaults,
      dailyQuestionLimitBySection: {
        ...DEFAULT_LEARNING_CONFIG.sessionDefaults.dailyQuestionLimitBySection,
        ...(cloned.sessionDefaults?.dailyQuestionLimitBySection || {}),
      },
    };
    return {
      configVersionId: latest.configVersionId,
      versionNumber: latest.versionNumber,
      config: cloned,
    };
  }

  async listConfigVersions() {
    return structuredClone([...this.configs].reverse());
  }

  async saveConfigVersion(
    config: LearningConfig,
    notes?: string
  ): Promise<{ configVersionId: string; versionNumber: number }> {
    const nextNum = (this.configs[this.configs.length - 1]?.versionNumber ?? 0) + 1;
    const configVersionId = `cfg_v${nextNum}_${crypto.randomUUID().slice(0, 6)}`;
    this.configs.push({
      configVersionId,
      versionNumber: nextNum,
      notes,
      createdAt: new Date().toISOString(),
      config: structuredClone(config),
    });
    return { configVersionId, versionNumber: nextNum };
  }

  async createSession(session: SessionRecord, snapshots: SessionQuestionSnapshot[] = []): Promise<void> {
    const studentId = session.studentId || DEFAULT_STUDENT_ID;
    if (!this.users.has(studentId)) {
      this.users.set(studentId, { uid: studentId, role: 'student', displayName: studentId });
    }
    this.sessions.set(session.sessionId, {
      ...structuredClone(session),
      studentId,
      checkpointRevision: session.checkpointRevision ?? 1,
    });
    this.snapshotsBySessionId.set(session.sessionId, structuredClone(snapshots));
  }

  async getSession(sessionId: string, studentId?: string): Promise<SessionRecord | null> {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    if (studentId && (s.studentId || DEFAULT_STUDENT_ID) !== studentId) return null;
    return structuredClone(s);
  }

  async getSessionSnapshots(_studentId: string, sessionId: string): Promise<SessionQuestionSnapshot[]> {
    return structuredClone(this.snapshotsBySessionId.get(sessionId) || []);
  }

  async saveSessionCheckpoint(
    sessionId: string,
    studentId: string,
    checkpoint: SessionCheckpoint,
    expectedRevision?: number
  ): Promise<CheckpointSaveResult> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new NotFoundError('Session not found.');
    if ((s.studentId || DEFAULT_STUDENT_ID) !== studentId) {
      throw new ForbiddenError('Forbidden: session belongs to another user.');
    }
    if (s.status !== 'in_progress') {
      throw new RevisionConflictError(
        'Session already submitted.',
        s.checkpointRevision ?? 1,
        s.checkpoint
      );
    }
    const currentRev = s.checkpointRevision ?? 1;
    if (expectedRevision !== undefined && expectedRevision !== currentRev) {
      throw new RevisionConflictError(
        `Checkpoint revision conflict: expected v${expectedRevision}, current v${currentRev}.`,
        currentRev,
        s.checkpoint
      );
    }
    const nextRev = currentRev + 1;
    s.checkpoint = structuredClone(checkpoint);
    s.checkpointRevision = nextRev;
    return { checkpointRevision: nextRev, savedAtIso: new Date().toISOString() };
  }

  async completeSession(
    sessionId: string,
    summary: { correctSlots: number; totalSlots: number; completedAt: string }
  ): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.status = 'submitted';
      s.correctSlots = summary.correctSlots;
      s.totalSlots = summary.totalSlots;
      s.completedAt = summary.completedAt;
    }
  }

  async finalizeSessionAtomically(input: FinalizeSessionInput): Promise<FinalizeSessionResult> {
    const s = this.sessions.get(input.sessionId);
    if (!s) throw new NotFoundError('Session not found.');
    if ((s.studentId || DEFAULT_STUDENT_ID) !== input.studentId) {
      throw new ForbiddenError('Forbidden: cannot submit another user session.');
    }
    if (s.status === 'submitted' && s.submissionSummary) {
      return {
        alreadySubmitted: true,
        session: structuredClone(s),
        submissionSummary: structuredClone(s.submissionSummary),
      };
    }

    const existingAttemptIds = new Set(this.attempts.map((a) => a.attemptId));
    for (const att of input.attempts) {
      if (!existingAttemptIds.has(att.attemptId)) {
        this.attempts.push({ ...structuredClone(att), studentId: input.studentId });
        existingAttemptIds.add(att.attemptId);
      }
    }
    if (input.skillStates.length > 0) {
      await this.upsertSkillStates(input.skillStates, input.studentId);
    }
    if (input.questionMemory.length > 0) {
      await this.upsertQuestionMemory(input.questionMemory, input.studentId);
    }
    if (input.evidenceUpdates.length > 0) {
      await this.upsertQuestionEvidence(input.evidenceUpdates, input.studentId);
    }
    for (const sub of input.writingSubmissions) {
      await this.saveWritingSubmission({ ...sub, studentId: input.studentId });
    }

    s.status = 'submitted';
    s.checkpoint = structuredClone(input.checkpoint);
    s.checkpointRevision = (s.checkpointRevision ?? 1) + 1;
    s.correctSlots = input.correctSlots;
    s.totalSlots = input.totalSlots;
    s.completedAt = input.completedAtIso;
    s.submissionSummary = structuredClone(input.submissionSummary);

    return {
      alreadySubmitted: false,
      session: structuredClone(s),
      submissionSummary: structuredClone(input.submissionSummary),
    };
  }

  async listSessions(
    limit = 50,
    studentId = DEFAULT_STUDENT_ID,
    includeSandbox = true
  ): Promise<SessionRecord[]> {
    return Array.from(this.sessions.values())
      .filter((s) => (s.studentId || DEFAULT_STUDENT_ID) === studentId && (includeSandbox || !s.isSandbox))
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .slice(0, limit)
      .map((s) => structuredClone(s));
  }

  async appendPartAttempts(attempts: PartAttemptRecord[]): Promise<void> {
    const existing = new Set(this.attempts.map((a) => a.attemptId));
    for (const a of attempts) {
      if (!existing.has(a.attemptId)) {
        this.attempts.push({ ...structuredClone(a), studentId: a.studentId || DEFAULT_STUDENT_ID });
        existing.add(a.attemptId);
      }
    }
  }

  async listPartAttempts(
    limit = 1000,
    studentId = DEFAULT_STUDENT_ID,
    includeSandbox = false
  ): Promise<PartAttemptRecord[]> {
    return this.attempts
      .filter((a) => (a.studentId || DEFAULT_STUDENT_ID) === studentId && (includeSandbox || !a.isSandbox))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, limit)
      .map((a) => structuredClone(a));
  }

  async getQuestionEvidence(studentId: string): Promise<Record<string, QuestionMasteryEvidence>> {
    return structuredClone(this.questionEvidenceByStudent.get(studentId) || {});
  }

  async upsertQuestionEvidence(entries: QuestionMasteryEvidence[], studentId: string): Promise<void> {
    const map = { ...(this.questionEvidenceByStudent.get(studentId) || {}) };
    for (const ev of entries) {
      map[ev.evidenceKey] = structuredClone(ev);
    }
    this.questionEvidenceByStudent.set(studentId, map);
  }

  async saveWritingSubmission(sub: WritingSubmissionRecord): Promise<void> {
    this.writingSubmissions.set(sub.submissionId, {
      ...structuredClone(sub),
      studentId: sub.studentId || DEFAULT_STUDENT_ID,
    });
  }

  async getWritingSubmission(
    submissionId: string,
    studentId?: string
  ): Promise<(WritingSubmissionRecord & { evaluations: WritingEvaluationRecord[] }) | null> {
    const sub = this.writingSubmissions.get(submissionId);
    if (!sub) return null;
    if (studentId && (sub.studentId || DEFAULT_STUDENT_ID) !== studentId) return null;
    const evaluations = this.writingEvaluations.filter((e) => e.submissionId === submissionId);
    return { ...structuredClone(sub), evaluations: structuredClone(evaluations) };
  }

  async listWritingSubmissions(
    studentId = DEFAULT_STUDENT_ID
  ): Promise<(WritingSubmissionRecord & { evaluations: WritingEvaluationRecord[] })[]> {
    return Array.from(this.writingSubmissions.values())
      .filter((s) => (s.studentId || DEFAULT_STUDENT_ID) === studentId)
      .sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt))
      .map((s) => ({
        ...structuredClone(s),
        evaluations: structuredClone(this.writingEvaluations.filter((e) => e.submissionId === s.submissionId)),
      }));
  }

  async saveWritingEvaluation(ev: WritingEvaluationRecord): Promise<void> {
    this.writingEvaluations.push(structuredClone(ev));
  }

  async getSkillStates(studentId = DEFAULT_STUDENT_ID): Promise<Record<string, SkillState>> {
    return structuredClone(this.skillStatesByStudent.get(studentId) || {});
  }

  async upsertSkillStates(states: SkillState[], studentId = DEFAULT_STUDENT_ID): Promise<void> {
    const map = { ...(this.skillStatesByStudent.get(studentId) || {}) };
    for (const s of states) map[s.skillId] = structuredClone(s);
    this.skillStatesByStudent.set(studentId, map);
  }

  async getQuestionMemory(studentId = DEFAULT_STUDENT_ID): Promise<Record<string, QuestionMemoryState>> {
    return structuredClone(this.questionMemoryByStudent.get(studentId) || {});
  }

  async upsertQuestionMemory(entries: QuestionMemoryState[], studentId = DEFAULT_STUDENT_ID): Promise<void> {
    const map = { ...(this.questionMemoryByStudent.get(studentId) || {}) };
    for (const m of entries) map[m.questionFamilyId] = structuredClone(m);
    this.questionMemoryByStudent.set(studentId, map);
  }

  async saveQuestionFlag(flag: QuestionFlagRecord): Promise<void> {
    this.flags.set(flag.flagId, structuredClone(flag));
  }

  async listQuestionFlags(): Promise<QuestionFlagRecord[]> {
    return Array.from(this.flags.values())
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map((f) => structuredClone(f));
  }

  async resolveQuestionFlag(flagId: string): Promise<void> {
    const flag = this.flags.get(flagId);
    if (flag) flag.status = 'resolved';
  }

  async saveMediaAsset(asset: MediaAssetRecord): Promise<void> {
    this.mediaAssets.set(asset.assetId, structuredClone(asset));
  }

  async getMediaAsset(assetId: string): Promise<MediaAssetRecord | null> {
    const m = this.mediaAssets.get(assetId);
    return m ? structuredClone(m) : null;
  }

  async listMediaAssets(): Promise<MediaAssetRecord[]> {
    return Array.from(this.mediaAssets.values()).map((m) => structuredClone(m));
  }

  async exportFullBackup(): Promise<CanonicalBackupBundle> {
    const uids = new Set<string>(this.users.keys());
    for (const s of this.sessions.values()) uids.add(s.studentId || DEFAULT_STUDENT_ID);
    for (const a of this.attempts) uids.add(a.studentId || DEFAULT_STUDENT_ID);
    for (const k of this.questionEvidenceByStudent.keys()) uids.add(k);

    const users = Array.from(uids)
      .sort()
      .map((uid) => {
        const u = this.users.get(uid);
        const sessions = Array.from(this.sessions.values()).filter((s) => (s.studentId || DEFAULT_STUDENT_ID) === uid);
        const snapsBySid: Record<string, SessionQuestionSnapshot[]> = {};
        for (const s of sessions) {
          snapsBySid[s.sessionId] = structuredClone(this.snapshotsBySessionId.get(s.sessionId) || []);
        }
        return {
          uid,
          role: u?.role || 'student',
          displayName: u?.displayName || uid,
          email: u?.email,
          sessions: structuredClone(sessions),
          sessionSnapshotsBySessionId: snapsBySid,
          partAttempts: structuredClone(this.attempts.filter((a) => (a.studentId || DEFAULT_STUDENT_ID) === uid)),
          skillStates: Object.values(structuredClone(this.skillStatesByStudent.get(uid) || {})),
          questionMemory: Object.values(structuredClone(this.questionMemoryByStudent.get(uid) || {})),
          questionEvidence: Object.values(structuredClone(this.questionEvidenceByStudent.get(uid) || {})),
          writingSubmissions: Array.from(this.writingSubmissions.values())
            .filter((ws) => (ws.studentId || DEFAULT_STUDENT_ID) === uid)
            .map((ws) => ({
              ...structuredClone(ws),
              evaluations: structuredClone(this.writingEvaluations.filter((e) => e.submissionId === ws.submissionId)),
            })),
        };
      });

    return finalizeBackupBundle({
      exportedAtIso: new Date().toISOString(),
      backendName: this.backendName,
      stimuli: Array.from(this.stimuli.values()).sort((a, b) => a.stimulusId.localeCompare(b.stimulusId)),
      questions: Array.from(this.questions.values()).sort((a, b) => a.questionId.localeCompare(b.questionId)),
      importBatches: structuredClone(this.batches),
      configVersions: structuredClone(this.configs),
      mediaAssets: await this.listMediaAssets(),
      questionFlags: await this.listQuestionFlags(),
      users,
    });
  }

  async restoreFullBackup(rawBundle: unknown, options: { dryRun: boolean }): Promise<BackupRestoreReport> {
    const validated = validateIncomingBackupBundle(rawBundle);
    if (!validated.valid || !validated.bundle) {
      return emptyRestoreReport(false, options.dryRun, validated.checksumVerified, validated.errors, validated.warnings);
    }
    const bundle = validated.bundle;
    const wouldCreate = {
      stimuli: bundle.stimuli.filter((s) => !this.stimuli.has(s.stimulusId)).length,
      questions: bundle.questions.filter((q) => !this.questions.has(q.questionId)).length,
      configVersions: bundle.configVersions.filter((c) => !this.configs.some((e) => e.configVersionId === c.configVersionId)).length,
      sessions: bundle.users.reduce((n, u) => n + u.sessions.filter((s) => !this.sessions.has(s.sessionId)).length, 0),
    };
    const wouldSkipExisting = {
      stimuli: bundle.stimuli.length - wouldCreate.stimuli,
      questions: bundle.questions.length - wouldCreate.questions,
      configVersions: bundle.configVersions.length - wouldCreate.configVersions,
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

    const applied = { stimuli: 0, questions: 0, configVersions: 0, sessions: 0, attempts: 0, evidence: 0 };
    for (const s of bundle.stimuli) {
      if (!this.stimuli.has(s.stimulusId)) {
        this.stimuli.set(s.stimulusId, structuredClone(s));
        applied.stimuli++;
      }
    }
    for (const q of bundle.questions) {
      if (!this.questions.has(q.questionId)) {
        this.questions.set(q.questionId, structuredClone(q));
        applied.questions++;
      }
    }
    for (const c of bundle.configVersions) {
      if (!this.configs.some((x) => x.configVersionId === c.configVersionId)) {
        this.configs.push(structuredClone(c));
        applied.configVersions++;
      }
    }
    for (const b of bundle.importBatches || []) {
      if (!this.batches.some((x) => x.batchId === b.batchId)) this.batches.push(structuredClone(b));
    }
    for (const m of bundle.mediaAssets || []) {
      if (!this.mediaAssets.has(m.assetId)) this.mediaAssets.set(m.assetId, structuredClone(m));
    }
    for (const f of bundle.questionFlags || []) {
      if (!this.flags.has(f.flagId)) this.flags.set(f.flagId, structuredClone(f));
    }
    for (const u of bundle.users) {
      this.users.set(u.uid, { uid: u.uid, role: u.role, displayName: u.displayName, email: u.email });
      for (const s of u.sessions) {
        if (!this.sessions.has(s.sessionId)) {
          this.sessions.set(s.sessionId, structuredClone(s));
          this.snapshotsBySessionId.set(s.sessionId, structuredClone(u.sessionSnapshotsBySessionId?.[s.sessionId] || []));
          applied.sessions++;
        }
      }
      const existingAtts = new Set(this.attempts.map((a) => a.attemptId));
      for (const a of u.partAttempts) {
        if (!existingAtts.has(a.attemptId)) {
          this.attempts.push(structuredClone(a));
          existingAtts.add(a.attemptId);
          applied.attempts++;
        }
      }
      await this.upsertSkillStates(u.skillStates, u.uid);
      await this.upsertQuestionMemory(u.questionMemory, u.uid);
      await this.upsertQuestionEvidence(u.questionEvidence, u.uid);
      applied.evidence += u.questionEvidence.length;
      for (const ws of u.writingSubmissions) {
        if (!this.writingSubmissions.has(ws.submissionId)) {
          const { evaluations: evs, ...rest } = ws;
          this.writingSubmissions.set(ws.submissionId, structuredClone(rest));
          for (const ev of evs || []) {
            this.writingEvaluations.push(structuredClone(ev));
          }
        }
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
  }

  async runMigrationPreflight(uploadsDir = 'public/assets/uploads'): Promise<MigrationPreflightReport> {
    const questions = Array.from(this.questions.values());
    const stimuli = Array.from(this.stimuli.values());
    const mediaManifest = await buildMediaMigrationManifest({
      questions,
      stimuli,
      mediaAssets: Array.from(this.mediaAssets.values()),
      uploadsDir,
    });
    const sessionsMissingSnapshots = Array.from(this.sessions.values()).filter(
      (s) => (this.snapshotsBySessionId.get(s.sessionId) || []).length === 0
    ).length;

    return {
      checkedAtIso: new Date().toISOString(),
      backendName: this.backendName,
      totalQuestions: questions.length,
      totalSessions: this.sessions.size,
      totalPartAttempts: this.attempts.length,
      sessionsMissingSnapshots,
      attemptsMissingEvidenceRevision: this.attempts.filter((a) => !a.evidenceRevision).length,
      questionsMissingEvidenceRevision: questions.filter((q) => !q.evidenceRevision).length,
      legacyUntaggedAttempts: this.attempts.filter((a) => a.isLegacy).length,
      mediaNeedsUploadCount: mediaManifest.needsUploadCount,
      mediaMissingFilesCount: mediaManifest.missingFilesCount,
    };
  }
}
