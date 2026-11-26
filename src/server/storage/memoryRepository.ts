import crypto from 'node:crypto';
import type {
  BankImportManifest,
  BenchmarkReportRecord,
  DailyFocusPlan,
  ImportBatchRecord,
  LearnerAccountRecord,
  LearnerPreferences,
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
  SessionSectionState,
  SkillState,
  StimulusGroup,
  VisualSpec,
  WritingEvaluationRecord,
} from '../../shared/contracts.ts';
import { DEFAULT_LEARNING_CONFIG, type SectionCode } from '../../shared/contracts.ts';
import { computeBankMasterySummary, computeEvidenceRevision } from '../../shared/mastery.ts';
import { computePoolHealth, deriveQuestionProgressMeta, type PoolHealthSummary } from '../../shared/bankStatus.ts';
import { getQuestionBatchTag } from '../../shared/engine.ts';
import { computeCanonicalHash } from '../manifestValidator.ts';
import { buildMediaMigrationManifest } from '../mediaService.ts';
import { deepFreeze, toQuestionMeta, toQuestionSelection } from './questionBankCache.ts';
import {
  ForbiddenError,
  NotFoundError,
  RevisionConflictError,
  type AccountDeleteResponse,
  type AdminBankStatusSummary,
  type AppRepository,
  type BackupRestoreReport,
  type CanonicalBackupBundle,
  type CheckpointSaveResult,
  type FinalizeSessionInput,
  type FinalizeSessionResult,
  type MigrationPreflightReport,
  type ProgressCountsResponse,
  type ProgressResetResponse,
  type ImportBatchSummary,
  type LearnerActivityStats,
  type ListSessionsOptions,
  type SessionSummaryRow,
  type QuestionMeta,
  type QuestionQueryParams,
  type QuestionQueryResult,
  type QuestionSelectionItem,
  type QuestionVersionSummary,
  type ReserveSessionResult,
  type StudentDashboardBankSummary,
  type StudentProgressBankStats,
  type SyncHydratePayload,
  type TodayAttemptCounts,
  type WritingSubmissionRecord,
  type WithdrawQuestionFlagResult,
} from './repository.ts';
import {
  emptyRestoreReport,
  filterAndPaginateQuestions,
  finalizeBackupBundle,
  selectLatestByFamily,
  summarizeBatches,
  validateIncomingBackupBundle,
} from './repositoryUtils.ts';

const DEFAULT_STUDENT_ID = 'default-student';

export class MemoryRepository implements AppRepository {
  readonly backendName = 'memory_preview' as const;

  private users = new Map<
    string,
    { uid: string; role: 'student' | 'admin'; displayName: string; email?: string; updatedAtIso?: string }
  >();
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
  private activeLocksByStudent = new Map<string, string>();
  private snapshotsBySessionId = new Map<string, SessionQuestionSnapshot[]>();
  private dailyPlansByStudent = new Map<string, DailyFocusPlan>();
  private benchmarkReportsBySession = new Map<string, BenchmarkReportRecord>();
  private attempts: PartAttemptRecord[] = [];
  private writingSubmissions = new Map<string, WritingSubmissionRecord>();
  private writingEvaluations: WritingEvaluationRecord[] = [];
  private skillStatesByStudent = new Map<string, Record<string, SkillState>>();
  private questionMemoryByStudent = new Map<string, Record<string, QuestionMemoryState>>();
  private questionEvidenceByStudent = new Map<string, Record<string, QuestionMasteryEvidence>>();
  private learnerPreferencesByStudent = new Map<string, LearnerPreferences>();
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
    const isAdmin = input.isBootstrappedAdmin;
    const role: 'student' | 'admin' = isAdmin ? 'admin' : 'student';
    if (isAdmin) {
      this.admins.add(input.uid);
    } else {
      this.admins.delete(input.uid);
    }
    this.users.set(input.uid, {
      uid: input.uid,
      role,
      displayName: input.displayName || input.email.split('@')[0] || 'Learner',
      email: input.email,
      updatedAtIso: new Date().toISOString(),
    });
    return { role };
  }

  async isUserAdmin(uid: string): Promise<boolean> {
    return this.admins.has(uid) || this.users.get(uid)?.role === 'admin';
  }

  async listUsers(): Promise<LearnerAccountRecord[]> {
    const byUid = new Map<string, LearnerAccountRecord>();
    for (const u of this.users.values()) {
      byUid.set(u.uid, {
        uid: u.uid,
        role: this.admins.has(u.uid) || u.role === 'admin' ? 'admin' : 'student',
        displayName: u.displayName || u.email || u.uid,
        email: u.email,
        updatedAtIso: u.updatedAtIso,
      });
    }
    const extraIds = new Set<string>();
    for (const s of this.sessions.values()) extraIds.add(s.studentId || DEFAULT_STUDENT_ID);
    for (const id of this.questionEvidenceByStudent.keys()) extraIds.add(id);
    for (const id of this.questionMemoryByStudent.keys()) extraIds.add(id);
    for (const id of extraIds) {
      if (id && !byUid.has(id)) {
        byUid.set(id, {
          uid: id,
          role: this.admins.has(id) ? 'admin' : 'student',
          displayName: id,
        });
      }
    }
    return Array.from(byUid.values());
  }

  async getProgressCounts(studentId: string): Promise<ProgressCountsResponse> {
    return {
      sessionsCount: [...this.sessions.values()].filter((row) => (row.studentId || DEFAULT_STUDENT_ID) === studentId).length,
      attemptsCount: this.attempts.filter((row) => (row.studentId || DEFAULT_STUDENT_ID) === studentId).length,
      evidenceCount: Object.keys(this.questionEvidenceByStudent.get(studentId) ?? {}).length,
      writingCount: [...this.writingSubmissions.values()].filter((row) => (row.studentId || DEFAULT_STUDENT_ID) === studentId).length,
      bankQuestionsCount: new Set([...this.questions.values()].map((q) => q.questionFamilyId)).size,
    };
  }

  async resetStudentProgress(studentId: string): Promise<ProgressResetResponse> {
    let clearedSessions = 0;
    for (const [id, session] of this.sessions) {
      if ((session.studentId || DEFAULT_STUDENT_ID) === studentId) {
        this.sessions.delete(id);
        this.snapshotsBySessionId.delete(id);
        this.benchmarkReportsBySession.delete(id);
        clearedSessions++;
      }
    }
    for (const [sessionId, report] of this.benchmarkReportsBySession) {
      if ((report.studentId || DEFAULT_STUDENT_ID) === studentId) {
        this.benchmarkReportsBySession.delete(sessionId);
      }
    }
    this.activeLocksByStudent.delete(studentId);

    const attemptsBefore = this.attempts.length;
    this.attempts = this.attempts.filter((row) => (row.studentId || DEFAULT_STUDENT_ID) !== studentId);
    const clearedAttempts = attemptsBefore - this.attempts.length;

    const submissionIds = new Set<string>();
    for (const [id, submission] of this.writingSubmissions) {
      if ((submission.studentId || DEFAULT_STUDENT_ID) === studentId) {
        this.writingSubmissions.delete(id);
        submissionIds.add(id);
      }
    }
    this.writingEvaluations = this.writingEvaluations.filter((row) => !submissionIds.has(row.submissionId));

    const clearedSkillStates = Object.keys(this.skillStatesByStudent.get(studentId) ?? {}).length;
    const clearedMemory = Object.keys(this.questionMemoryByStudent.get(studentId) ?? {}).length;
    const clearedEvidence = Object.keys(this.questionEvidenceByStudent.get(studentId) ?? {}).length;
    this.skillStatesByStudent.delete(studentId);
    this.questionMemoryByStudent.delete(studentId);
    this.questionEvidenceByStudent.delete(studentId);

    let clearedDailyPlans = 0;
    const planPrefix = `${studentId}::`;
    for (const [key, plan] of this.dailyPlansByStudent) {
      if (key.startsWith(planPrefix) || (plan.studentId || DEFAULT_STUDENT_ID) === studentId) {
        this.dailyPlansByStudent.delete(key);
        clearedDailyPlans++;
      }
    }
    return {
      ok: true,
      clearedSessions,
      clearedAttempts,
      clearedSkillStates,
      clearedMemory,
      clearedEvidence,
      clearedWriting: submissionIds.size,
      clearedDailyPlans,
      preservedQuestionsCount: new Set([...this.questions.values()].map((q) => q.questionFamilyId)).size,
    };
  }

  async getLearnerPreferences(studentId: string): Promise<LearnerPreferences | null> {
    const sid = studentId || DEFAULT_STUDENT_ID;
    const found = this.learnerPreferencesByStudent.get(sid);
    return found ? structuredClone(found) : null;
  }

  async saveLearnerPreferences(studentId: string, prefs: LearnerPreferences): Promise<LearnerPreferences> {
    const sid = studentId || DEFAULT_STUDENT_ID;
    const stamped: LearnerPreferences = {
      ...structuredClone(prefs),
      updatedAtIso: new Date().toISOString(),
    };
    this.learnerPreferencesByStudent.set(sid, stamped);
    return structuredClone(stamped);
  }

  async deleteLearnerPreferences(studentId: string): Promise<void> {
    const sid = studentId || DEFAULT_STUDENT_ID;
    this.learnerPreferencesByStudent.delete(sid);
  }

  async deleteUserAccount(studentId: string): Promise<AccountDeleteResponse> {
    const sid = studentId || DEFAULT_STUDENT_ID;
    const resetRes = await this.resetStudentProgress(sid);
    this.learnerPreferencesByStudent.delete(sid);
    let clearedFlags = 0;
    for (const [id, flag] of this.flags) {
      if (flag.studentId === sid) {
        this.flags.delete(id);
        clearedFlags++;
      }
    }
    const deletedUser = this.users.delete(sid);
    this.admins.delete(sid);
    return {
      ...resetRes,
      deletedUser,
      clearedFlags,
    };
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
      // Frozen like the Postgres bank cache, so tests catch callers that mutate shared bank objects.
      .map((q) => deepFreeze(structuredClone(q)));
  }

  async listQuestionsByIds(questionIds: string[]): Promise<QuestionItem[]> {
    const out: QuestionItem[] = [];
    for (const id of new Set(questionIds)) {
      const q = this.questions.get(id);
      if (q) out.push(deepFreeze(structuredClone(q)));
    }
    return out;
  }

  async listQuestionsByFamilies(familyIds: string[], questionIds: string[] = []): Promise<QuestionItem[]> {
    const famSet = new Set(familyIds);
    const idSet = new Set(questionIds);
    return Array.from(this.questions.values())
      .filter((q) => famSet.has(q.questionFamilyId) || idSet.has(q.questionId))
      .map((q) => deepFreeze(structuredClone(q)));
  }

  async listSelectionQuestions(filter?: {
    section?: string;
    poolType?: string;
    qcStatus?: string;
    batchId?: string;
    batchTag?: string;
    includeHistorical?: boolean;
  }): Promise<QuestionSelectionItem[]> {
    const all = Array.from(this.questions.values());
    const base = filter?.includeHistorical ? all : selectLatestByFamily(all);
    return base
      .filter((q) => {
        if (filter?.section && q.section !== filter.section) return false;
        if (filter?.poolType && q.poolType !== filter.poolType) return false;
        if (filter?.qcStatus && q.qcStatus !== filter.qcStatus) return false;
        if (filter?.batchId && q.batchId !== filter.batchId) return false;
        if (filter?.batchTag && getQuestionBatchTag(q) !== filter.batchTag) return false;
        return true;
      })
      .map((q) => deepFreeze(toQuestionSelection(structuredClone(q))));
  }

  async listQuestionMeta(filter?: { qcStatus?: string }): Promise<QuestionMeta[]> {
    return selectLatestByFamily(Array.from(this.questions.values()))
      .filter((q) => !filter?.qcStatus || q.qcStatus === filter.qcStatus)
      .map((q) => toQuestionMeta(structuredClone(q)));
  }

  async listQuestionsPaginated(params?: QuestionQueryParams): Promise<QuestionQueryResult> {
    const allQuestions = Array.from(this.questions.values()).map((q) => deepFreeze(structuredClone(q)));
    const stimuliById: Record<string, StimulusGroup> = {};
    for (const [id, s] of this.stimuli.entries()) {
      stimuliById[id] = deepFreeze(structuredClone(s));
    }
    let resolvedParams = params;
    if (params && params.monitoredStudentId !== undefined && !params.progress) {
      const sid = params.monitoredStudentId;
      resolvedParams = {
        ...params,
        progress: {
          evidence: sid ? await this.getQuestionEvidence(sid) : {},
          memory: sid ? await this.getQuestionMemory(sid) : {},
          dailyQuestionTarget: Math.max(1, params.dailyQuestionTarget ?? 10),
        },
      };
    }
    return filterAndPaginateQuestions({
      allQuestions,
      stimuliById,
      flags: await this.listQuestionFlags(),
      batches: await this.listImportBatchSummaries(),
      params: resolvedParams,
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
      if (s) out[id] = deepFreeze(structuredClone(s));
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
      question: deepFreeze(structuredClone(q)),
      stimulus: stimulus ? deepFreeze(structuredClone(stimulus)) : undefined,
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

  async listImportBatchSummaries(): Promise<ImportBatchSummary[]> {
    return (await this.listImportBatches()).map(
      ({ newQuestionIds: _n, versionBumpedQuestionIds: _v, skippedQuestionIds: _s, ...summary }) => summary
    );
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

  async bulkUpdateQuestionStatus(questionIds: string[], qcStatus: QuestionItem['qcStatus']): Promise<number> {
    const nowIso = new Date().toISOString();
    let updated = 0;
    for (const id of new Set(questionIds)) {
      const q = this.questions.get(id);
      if (q) {
        q.qcStatus = qcStatus;
        q.updatedAtIso = nowIso;
        updated++;
      }
    }
    return updated;
  }

  async getAdminBankStatusSummary(): Promise<AdminBankStatusSummary> {
    const questions = await this.listQuestionMeta();
    const holdoutIds = questions.filter((q) => q.poolType === 'benchmark_holdout').map((q) => q.questionId);
    const leakedCount = await this.countHoldoutLeaks(holdoutIds);
    const flags = await this.listQuestionFlags();
    const batches = await this.listImportBatchSummaries();
    const byPool: Record<string, number> = {};
    const bySection: Record<string, number> = {};
    const byQcStatus: Record<string, number> = {};
    for (const q of questions) {
      byPool[q.poolType] = (byPool[q.poolType] || 0) + 1;
      bySection[q.section] = (bySection[q.section] || 0) + 1;
      byQcStatus[q.qcStatus] = (byQcStatus[q.qcStatus] || 0) + 1;
    }
    return {
      totalQuestions: questions.length,
      byPool,
      bySection,
      byQcStatus,
      holdoutQuestionCount: holdoutIds.length,
      leakedCount,
      openFlagsCount: flags.filter((f) => f.status === 'open').length,
      batchesCount: batches.length,
    };
  }

  async getStudentDashboardBankSummary(
    studentId: string,
    autoRetireMastered: boolean
  ): Promise<StudentDashboardBankSummary> {
    const [questions, importBatches, evidenceMap, questionMemory] = await Promise.all([
      this.listQuestionMeta({ qcStatus: 'active' }),
      this.listImportBatchSummaries(),
      this.getQuestionEvidence(studentId),
      this.getQuestionMemory(studentId),
    ]);
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
    const batchById = new Map(importBatches.map((b) => [b.batchId, b]));
    const customBatchMap = new Map<
      string,
      { batchId: string; batchLabel: string; counts: Record<SectionCode, number>; total: number }
    >();
    const benchmarkBatchMap = new Map<
      string,
      {
        batchId: string;
        batchLabel: string;
        poolType: 'benchmark_holdout' | 'official_calibration';
        counts: Record<SectionCode, number>;
        total: number;
      }
    >();
    for (const q of questions) {
      const tag = getQuestionBatchTag(q);
      if (tag === 'PT1' || tag === 'PT2' || tag === 'PT3') {
        batchCounts[tag][q.section] += 1;
      }
      if (q.poolType === 'benchmark_holdout' || q.poolType === 'official_calibration') {
        if (q.batchId) {
          const batchMeta = batchById.get(q.batchId);
          const entry = benchmarkBatchMap.get(q.batchId) || {
            batchId: q.batchId,
            batchLabel: batchMeta?.batchLabel || q.batchLabel || q.batchId,
            poolType: q.poolType,
            counts: { READ: 0, MATH: 0, THINK: 0, WRIT: 0 },
            total: 0,
          };
          entry.counts[q.section] += 1;
          entry.total += 1;
          benchmarkBatchMap.set(q.batchId, entry);
        }
        continue;
      }
      if (q.poolType !== 'practice') {
        continue;
      }
      const prog = deriveQuestionProgressMeta(q, evidenceMap, questionMemory);
      if (!(autoRetireMastered && prog.completionStatus === 'done')) {
        poolCounts[q.section].live += 1;
        if (prog.completionStatus === 'unseen') {
          poolCounts[q.section].unseen += 1;
        }
      }
      if (q.batchId && tag !== 'PT1' && tag !== 'PT2' && tag !== 'PT3') {
        const batchMeta = batchById.get(q.batchId);
        if (batchMeta?.importedBy !== 'system_seed') {
          const entry = customBatchMap.get(q.batchId) || {
            batchId: q.batchId,
            batchLabel: batchMeta?.batchLabel || q.batchLabel || q.batchId,
            counts: { READ: 0, MATH: 0, THINK: 0, WRIT: 0 },
            total: 0,
          };
          entry.counts[q.section] += 1;
          entry.total += 1;
          customBatchMap.set(q.batchId, entry);
        }
      }
    }
    return {
      batchCounts,
      poolCounts,
      customBatches: Array.from(customBatchMap.values()).sort((a, b) => b.batchLabel.localeCompare(a.batchLabel)),
      benchmarkBatches: Array.from(benchmarkBatchMap.values()).sort((a, b) => {
        if (a.poolType !== b.poolType) return a.poolType === 'official_calibration' ? -1 : 1;
        if (a.poolType === 'official_calibration') return a.batchLabel.localeCompare(b.batchLabel);
        return b.batchLabel.localeCompare(a.batchLabel);
      }),
    };
  }

  async getTodayAttemptCounts(studentId: string, datePrefix: string): Promise<TodayAttemptCounts> {
    const rows = this.attempts.filter(
      (a) => (a.studentId || DEFAULT_STUDENT_ID) === studentId && !a.isSandbox && a.createdAt.startsWith(datePrefix)
    );
    return {
      attempted: rows.length,
      correct: rows.filter((a) => a.isCorrect).length,
    };
  }

  async getBenchmarkUnlockProgress(
    studentId: string,
    sinceIso: string
  ): Promise<{ correctPracticeAnswers: number }> {
    const sinceMs = Date.parse(sinceIso);
    const count = this.attempts.filter((a) => {
      if ((a.studentId || DEFAULT_STUDENT_ID) !== studentId) return false;
      if (a.isSandbox || !a.isCorrect) return false;
      const attMs = Date.parse(a.createdAt);
      if (!Number.isFinite(attMs) || (Number.isFinite(sinceMs) && attMs <= sinceMs)) return false;
      const sess = this.sessions.get(a.sessionId);
      if (sess && (sess.isSandbox || sess.mode === 'benchmark_exam' || sess.mode === 'admin_calibration')) {
        return false;
      }
      return true;
    }).length;
    return { correctPracticeAnswers: count };
  }

  async getStudentProgressStats(input: {
    studentId: string;
    writingSubmissionsCount: number;
    writingEvaluatedCount: number;
    policyVersion?: string;
  }): Promise<StudentProgressBankStats> {
    const [attempts, questions, evidenceMap] = await Promise.all([
      this.listPartAttempts(5000, input.studentId, false),
      this.listQuestions(),
      this.getQuestionEvidence(input.studentId),
    ]);
    const stimIds = Array.from(new Set(questions.map((q) => q.stimulusId).filter((id): id is string => Boolean(id))));
    const stimuliById = await this.listStimuliByIds(stimIds);
    const questionMap = new Map(questions.map((q) => [q.questionId, q]));
    const partTargetMap = new Map<string, { section: SectionCode; targetTimeSec: number }>();
    for (const q of questions) {
      for (const p of q.parts) {
        partTargetMap.set(p.partId, { section: q.section, targetTimeSec: p.targetTimeSec });
      }
    }
    const sectionStats: Record<
      SectionCode,
      { attempts: number; correct: number; avgTimeSec: number; targetTimeSec: number }
    > = {
      READ: { attempts: 0, correct: 0, avgTimeSec: 0, targetTimeSec: 0 },
      MATH: { attempts: 0, correct: 0, avgTimeSec: 0, targetTimeSec: 0 },
      THINK: { attempts: 0, correct: 0, avgTimeSec: 0, targetTimeSec: 0 },
      WRIT: { attempts: 0, correct: 0, avgTimeSec: 0, targetTimeSec: 1800 },
    };
    const secTimeSums: Record<SectionCode, { spent: number; target: number }> = {
      READ: { spent: 0, target: 0 },
      MATH: { spent: 0, target: 0 },
      THINK: { spent: 0, target: 0 },
      WRIT: { spent: 0, target: 0 },
    };
    const holdoutAttempts: PartAttemptRecord[] = [];
    let legacyAttemptsCount = 0;
    for (const a of attempts) {
      if (a.isLegacy) legacyAttemptsCount++;
      const q = questionMap.get(a.questionId);
      if (q?.poolType === 'benchmark_holdout') holdoutAttempts.push(a);
      const meta = partTargetMap.get(a.partId);
      const sec = meta?.section || q?.section || 'MATH';
      sectionStats[sec].attempts++;
      if (a.isCorrect) sectionStats[sec].correct++;
      secTimeSums[sec].spent += a.timeSpentSec;
      secTimeSums[sec].target += meta?.targetTimeSec ?? 60;
    }
    for (const sec of ['READ', 'MATH', 'THINK', 'WRIT'] as SectionCode[]) {
      const cnt = sectionStats[sec].attempts;
      if (cnt > 0) {
        sectionStats[sec].avgTimeSec = Math.round(secTimeSums[sec].spent / cnt);
        sectionStats[sec].targetTimeSec = Math.round(secTimeSums[sec].target / cnt);
      } else {
        sectionStats[sec].targetTimeSec = sec === 'WRIT' ? 1800 : 60;
      }
    }
    const masterySummary = computeBankMasterySummary({
      questions,
      stimuliById,
      evidenceMap,
      legacyAttemptsCount,
      holdoutAttempts,
      writingSubmissionsCount: input.writingSubmissionsCount,
      writingEvaluatedCount: input.writingEvaluatedCount,
      policyVersion: input.policyVersion,
    });
    return { sectionStats, totalAttempts: attempts.length, masterySummary };
  }

  async getPoolHealthByLearner(
    studentIds: string[],
    dailyQuestionTarget: number
  ): Promise<{ totalLiveQuestions: number; byStudentId: Record<string, PoolHealthSummary> }> {
    const latestQuestions = await this.listQuestionMeta();
    const baseHealth = computePoolHealth({
      questions: latestQuestions,
      evidenceMap: {},
      questionMemory: {},
      dailyQuestionTarget,
    });
    const byStudentId: Record<string, PoolHealthSummary> = {};
    for (const uid of studentIds) {
      const [evidenceMap, questionMemory] = await Promise.all([
        this.getQuestionEvidence(uid),
        this.getQuestionMemory(uid),
      ]);
      byStudentId[uid] = computePoolHealth({
        questions: latestQuestions,
        evidenceMap,
        questionMemory,
        dailyQuestionTarget,
      });
    }
    return { totalLiveQuestions: baseHealth.liveCount, byStudentId };
  }

  async getBatchSummaries(studentId: string | null) {
    const [questions, batches, evidence, memory] = await Promise.all([
      this.listQuestionMeta(),
      this.listImportBatchSummaries(),
      studentId ? this.getQuestionEvidence(studentId) : Promise.resolve({}),
      studentId ? this.getQuestionMemory(studentId) : Promise.resolve({}),
    ]);
    const progress = new Map(questions.map((q) => [q.questionId, deriveQuestionProgressMeta(q, evidence, memory)]));
    return summarizeBatches(questions, batches, progress);
  }

  async deleteQuestions(questionIds: string[]): Promise<number> {
    let deleted = 0;
    for (const qid of questionIds) {
      if (this.questions.delete(qid)) deleted++;
    }
    return deleted;
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
    if (!session.isSandbox && session.status === 'in_progress') {
      this.activeLocksByStudent.set(studentId, session.sessionId);
    }
  }

  async reserveAndCreateSession(
    session: SessionRecord,
    snapshots: SessionQuestionSnapshot[] = []
  ): Promise<ReserveSessionResult> {
    const studentId = session.studentId || DEFAULT_STUDENT_ID;
    if (!session.isSandbox) {
      const lockedSid = this.activeLocksByStudent.get(studentId);
      if (lockedSid) {
        const existing = this.sessions.get(lockedSid);
        if (existing && existing.status === 'in_progress' && !existing.isSandbox) {
          return {
            created: false,
            conflictSessionId: existing.sessionId,
            conflictSession: structuredClone(existing),
          };
        }
        this.activeLocksByStudent.delete(studentId);
      }
      for (const s of this.sessions.values()) {
        if ((s.studentId || DEFAULT_STUDENT_ID) === studentId && s.status === 'in_progress' && !s.isSandbox) {
          this.activeLocksByStudent.set(studentId, s.sessionId);
          return {
            created: false,
            conflictSessionId: s.sessionId,
            conflictSession: structuredClone(s),
          };
        }
      }
    }
    await this.createSession(session, snapshots);
    return { created: true };
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

  async updateSessionProgressState(
    sessionId: string,
    studentId: string,
    mutate: (session: SessionRecord) => void,
    expectedRevision?: number
  ): Promise<{ session: SessionRecord; checkpointRevision: number }> {
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
    const next = structuredClone(s);
    mutate(next);
    const nextRev = currentRev + 1;
    next.checkpointRevision = nextRev;
    this.sessions.set(sessionId, next);
    return { session: structuredClone(next), checkpointRevision: nextRev };
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
    const currentRev = s.checkpointRevision ?? 1;
    if (input.expectedRevision !== undefined && input.expectedRevision !== currentRev) {
      throw new RevisionConflictError(
        `Session checkpoint revision mismatch (expected ${input.expectedRevision}, current ${currentRev}).`,
        currentRev,
        structuredClone(
          s.checkpoint || {
            currentIndex: 0,
            elapsedSec: 0,
            answersByPartId: {},
            flaggedQuestionIds: [],
          }
        )
      );
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
    if (input.sectionState) {
      s.sectionState = structuredClone(input.sectionState);
      delete s.deadlineAt;
    }
    s.checkpointRevision = (s.checkpointRevision ?? 1) + 1;
    s.correctSlots = input.correctSlots;
    s.totalSlots = input.totalSlots;
    s.completedAt = input.completedAtIso;
    if (input.expiredAutoSubmitted) s.expiredAutoSubmitted = true;
    s.submissionSummary = structuredClone(input.submissionSummary);

    if (this.activeLocksByStudent.get(input.studentId) === input.sessionId) {
      this.activeLocksByStudent.delete(input.studentId);
    }

    return {
      alreadySubmitted: false,
      session: structuredClone(s),
      submissionSummary: structuredClone(input.submissionSummary),
    };
  }

  async listSessions(
    limit = 50,
    studentId = DEFAULT_STUDENT_ID,
    includeSandbox = true,
    options: ListSessionsOptions = {}
  ): Promise<SessionRecord[]> {
    return Array.from(this.sessions.values())
      .filter((s) => (s.studentId || DEFAULT_STUDENT_ID) === studentId && (includeSandbox || !s.isSandbox))
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .slice(0, limit)
      .map((s) => {
        const copy = structuredClone(s);
        if (options.omitSubmissionSummary) delete copy.submissionSummary;
        return copy;
      });
  }

  async listSessionSummaries(
    limit = 50,
    studentId = DEFAULT_STUDENT_ID,
    includeSandbox = true
  ): Promise<SessionSummaryRow[]> {
    return Array.from(this.sessions.values())
      .filter((s) => (s.studentId || DEFAULT_STUDENT_ID) === studentId && (includeSandbox || !s.isSandbox))
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .slice(0, limit)
      .map((s) => ({
        sessionId: s.sessionId,
        mode: s.mode,
        status: s.status,
        isSandbox: Boolean(s.isSandbox),
        ...(s.sectionFilter ? { sectionFilter: s.sectionFilter } : {}),
        startedAt: s.startedAt,
        ...(s.completedAt ? { completedAt: s.completedAt } : {}),
        correctSlots: s.correctSlots ?? 0,
        totalSlots: s.totalSlots ?? 0,
        elapsedSec: s.checkpoint?.elapsedSec ?? 0,
      }));
  }

  async listActiveSessions(studentId: string): Promise<SessionRecord[]> {
    return Array.from(this.sessions.values())
      .filter((s) => (s.studentId || DEFAULT_STUDENT_ID) === studentId && s.status === 'in_progress' && !s.isSandbox)
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .map((s) => structuredClone(s));
  }

  async getLearnerActivity(studentIds: string[]): Promise<Record<string, LearnerActivityStats>> {
    const out: Record<string, LearnerActivityStats> = {};
    for (const uid of studentIds) {
      let latestMs = 0;
      let sessionsCount = 0;
      let attemptsCount = 0;
      for (const s of this.sessions.values()) {
        if ((s.studentId || DEFAULT_STUDENT_ID) !== uid || s.isSandbox) continue;
        sessionsCount++;
        latestMs = Math.max(latestMs, Date.parse(s.completedAt || s.startedAt) || 0);
      }
      for (const a of this.attempts) {
        if ((a.studentId || DEFAULT_STUDENT_ID) !== uid || a.isSandbox) continue;
        attemptsCount++;
        latestMs = Math.max(latestMs, Date.parse(a.createdAt) || 0);
      }
      out[uid] = {
        sessionsCount,
        attemptsCount,
        lastActiveAtIso: latestMs > 0 ? new Date(latestMs).toISOString() : undefined,
      };
    }
    return out;
  }

  async countHoldoutLeaks(holdoutQuestionIds: string[]): Promise<number> {
    const holdout = new Set(holdoutQuestionIds);
    let leaked = 0;
    for (const s of this.sessions.values()) {
      if (s.mode === 'benchmark_exam' || s.mode === 'admin_calibration') continue;
      for (const qid of s.plannedQuestionIds) if (holdout.has(qid)) leaked++;
    }
    return leaked;
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

  async saveWritingEvaluation(ev: WritingEvaluationRecord, studentId?: string): Promise<void> {
    const sub = this.writingSubmissions.get(ev.submissionId);
    if (!sub || (studentId && (sub.studentId || DEFAULT_STUDENT_ID) !== studentId)) {
      throw new NotFoundError('Writing submission not found.');
    }
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

  async getDailyFocusPlan(studentId: string, planDate: string): Promise<DailyFocusPlan | null> {
    const found = this.dailyPlansByStudent.get(`${studentId}::${planDate}`);
    return found ? structuredClone(found) : null;
  }

  async saveDailyFocusPlan(studentId: string, plan: DailyFocusPlan): Promise<void> {
    this.dailyPlansByStudent.set(`${studentId}::${plan.planDate}`, structuredClone(plan));
  }

  async saveQuestionFlag(flag: QuestionFlagRecord): Promise<void> {
    this.flags.set(flag.flagId, structuredClone(flag));
  }

  async listQuestionFlags(studentId?: string): Promise<QuestionFlagRecord[]> {
    return Array.from(this.flags.values())
      .filter((f) => !studentId || f.studentId === studentId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map((f) => structuredClone(f));
  }

  async resolveQuestionFlag(flagId: string): Promise<void> {
    const flag = this.flags.get(flagId);
    if (flag) flag.status = 'resolved';
  }

  async withdrawQuestionFlag(flagId: string, studentId: string): Promise<WithdrawQuestionFlagResult> {
    const flag = this.flags.get(flagId);
    if (!flag || flag.studentId !== studentId) return 'not_found';
    if (flag.status !== 'open') return 'not_open';
    this.flags.delete(flagId);
    return 'withdrawn';
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
    for (const k of this.skillStatesByStudent.keys()) uids.add(k);
    for (const k of this.questionMemoryByStudent.keys()) uids.add(k);
    for (const k of this.questionEvidenceByStudent.keys()) uids.add(k);
    for (const ws of this.writingSubmissions.values()) uids.add(ws.studentId || DEFAULT_STUDENT_ID);
    for (const [key, plan] of this.dailyPlansByStudent.entries()) {
      const sep = key.lastIndexOf('::');
      uids.add(sep >= 0 ? key.slice(0, sep) : plan.studentId || DEFAULT_STUDENT_ID);
    }
    for (const r of this.benchmarkReportsBySession.values()) uids.add(r.studentId || DEFAULT_STUDENT_ID);
    for (const k of this.learnerPreferencesByStudent.keys()) uids.add(k);

    const users = Array.from(uids)
      .sort()
      .map((uid) => {
        const u = this.users.get(uid);
        const sessions = Array.from(this.sessions.values()).filter((s) => (s.studentId || DEFAULT_STUDENT_ID) === uid);
        const snapsBySid: Record<string, SessionQuestionSnapshot[]> = {};
        for (const s of sessions) {
          snapsBySid[s.sessionId] = structuredClone(this.snapshotsBySessionId.get(s.sessionId) || []);
        }
        const dailyFocusPlans: DailyFocusPlan[] = [];
        for (const [key, plan] of this.dailyPlansByStudent.entries()) {
          if (key === `${uid}::${plan.planDate}`) {
            dailyFocusPlans.push(structuredClone(plan));
          }
        }
        dailyFocusPlans.sort((a, b) => a.planDate.localeCompare(b.planDate));
        const benchmarkReports = Array.from(this.benchmarkReportsBySession.values())
          .filter((r) => (r.studentId || DEFAULT_STUDENT_ID) === uid)
          .sort((a, b) => Date.parse(b.completedAtIso) - Date.parse(a.completedAtIso) || a.sessionId.localeCompare(b.sessionId))
          .map((r) => structuredClone(r));
        const prefs = this.learnerPreferencesByStudent.get(uid);
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
          dailyFocusPlans,
          benchmarkReports,
          learnerPreferences: prefs ? structuredClone(prefs) : null,
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
    const totalSessions = bundle.users.reduce((n, u) => n + u.sessions.length, 0);
    const totalPlans = bundle.users.reduce((n, u) => n + (u.dailyFocusPlans?.length ?? 0), 0);
    const totalReports = bundle.users.reduce((n, u) => n + (u.benchmarkReports?.length ?? 0), 0);
    const totalPrefs = bundle.users.reduce((n, u) => n + (u.learnerPreferences ? 1 : 0), 0);
    const wouldCreate = {
      stimuli: bundle.stimuli.filter((s) => !this.stimuli.has(s.stimulusId)).length,
      questions: bundle.questions.filter((q) => !this.questions.has(q.questionId)).length,
      configVersions: bundle.configVersions.filter((c) => !this.configs.some((e) => e.configVersionId === c.configVersionId)).length,
      sessions: bundle.users.reduce((n, u) => n + u.sessions.filter((s) => !this.sessions.has(s.sessionId)).length, 0),
      dailyFocusPlans: bundle.users.reduce(
        (n, u) => n + (u.dailyFocusPlans || []).filter((p) => !this.dailyPlansByStudent.has(`${u.uid}::${p.planDate}`)).length,
        0
      ),
      benchmarkReports: bundle.users.reduce(
        (n, u) => n + (u.benchmarkReports || []).filter((r) => !this.benchmarkReportsBySession.has(r.sessionId)).length,
        0
      ),
      learnerPreferences: bundle.users.filter((u) => u.learnerPreferences && !this.learnerPreferencesByStudent.has(u.uid)).length,
    };
    const wouldSkipExisting = {
      stimuli: bundle.stimuli.length - wouldCreate.stimuli,
      questions: bundle.questions.length - wouldCreate.questions,
      configVersions: bundle.configVersions.length - wouldCreate.configVersions,
      sessions: totalSessions - wouldCreate.sessions,
      dailyFocusPlans: totalPlans - wouldCreate.dailyFocusPlans,
      benchmarkReports: totalReports - wouldCreate.benchmarkReports,
      learnerPreferences: totalPrefs - wouldCreate.learnerPreferences,
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

    const applied = {
      stimuli: 0,
      questions: 0,
      configVersions: 0,
      sessions: 0,
      attempts: 0,
      evidence: 0,
      dailyFocusPlans: 0,
      benchmarkReports: 0,
      learnerPreferences: 0,
    };
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
    const existingEvalIds = new Set(this.writingEvaluations.map((e) => e.evaluationId));
    for (const u of bundle.users) {
      if (!this.users.has(u.uid)) {
        this.users.set(u.uid, { uid: u.uid, role: 'student', displayName: u.displayName, email: u.email });
      }
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
      const existingSkills = this.skillStatesByStudent.get(u.uid) || {};
      const newSkills = u.skillStates.filter((sk) => !(sk.skillId in existingSkills));
      if (newSkills.length) await this.upsertSkillStates(newSkills, u.uid);
      const existingMem = this.questionMemoryByStudent.get(u.uid) || {};
      const newMem = u.questionMemory.filter((m) => !(m.questionFamilyId in existingMem));
      if (newMem.length) await this.upsertQuestionMemory(newMem, u.uid);
      const existingEv = this.questionEvidenceByStudent.get(u.uid) || {};
      const newEv = u.questionEvidence.filter((ev) => !(ev.evidenceKey in existingEv));
      if (newEv.length) {
        await this.upsertQuestionEvidence(newEv, u.uid);
        applied.evidence += newEv.length;
      }
      for (const ws of u.writingSubmissions) {
        const { evaluations: evs, ...rest } = ws;
        if (!this.writingSubmissions.has(ws.submissionId)) {
          this.writingSubmissions.set(ws.submissionId, structuredClone(rest));
        }
        for (const ev of evs || []) {
          if (!existingEvalIds.has(ev.evaluationId)) {
            this.writingEvaluations.push(structuredClone(ev));
            existingEvalIds.add(ev.evaluationId);
          }
        }
      }
      for (const plan of u.dailyFocusPlans || []) {
        const key = `${u.uid}::${plan.planDate}`;
        if (!this.dailyPlansByStudent.has(key)) {
          this.dailyPlansByStudent.set(key, structuredClone({ ...plan, studentId: u.uid }));
          applied.dailyFocusPlans++;
        }
      }
      for (const report of u.benchmarkReports || []) {
        if (!this.benchmarkReportsBySession.has(report.sessionId)) {
          this.benchmarkReportsBySession.set(report.sessionId, structuredClone({ ...report, studentId: u.uid }));
          applied.benchmarkReports++;
        }
      }
      if (u.learnerPreferences && !this.learnerPreferencesByStudent.has(u.uid)) {
        // Restore verbatim (keep the original updatedAtIso) instead of re-stamping via saveLearnerPreferences.
        this.learnerPreferencesByStudent.set(u.uid, structuredClone(u.learnerPreferences));
        applied.learnerPreferences++;
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

  async saveBenchmarkReport(report: BenchmarkReportRecord): Promise<void> {
    const sid = report.studentId || DEFAULT_STUDENT_ID;
    this.benchmarkReportsBySession.set(report.sessionId, structuredClone({ ...report, studentId: sid }));
  }

  async getBenchmarkReport(sessionId: string, studentId?: string): Promise<BenchmarkReportRecord | null> {
    const found = this.benchmarkReportsBySession.get(sessionId);
    if (!found) return null;
    if (studentId && (found.studentId || DEFAULT_STUDENT_ID) !== studentId) return null;
    return structuredClone(found);
  }

  async listBenchmarkReports(studentId: string, limit = 50): Promise<BenchmarkReportRecord[]> {
    const sid = studentId || DEFAULT_STUDENT_ID;
    return Array.from(this.benchmarkReportsBySession.values())
      .filter((r) => (r.studentId || DEFAULT_STUDENT_ID) === sid)
      .sort((a, b) => Date.parse(b.completedAtIso) - Date.parse(a.completedAtIso))
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }
}
