import crypto from 'node:crypto';
import type {
  BankImportManifest,
  LearningConfig,
  PartAttemptRecord,
  QuestionFlagRecord,
  QuestionItem,
  QuestionMemoryState,
  SessionRecord,
  SkillState,
  StimulusGroup,
  VisualSpec,
  WritingEvaluationRecord,
} from '../../shared/contracts.ts';
import { DEFAULT_LEARNING_CONFIG } from '../../shared/contracts.ts';
import { computeCanonicalHash } from '../manifestValidator.ts';
import type { AppRepository, SyncHydratePayload, WritingSubmissionRecord } from './repository.ts';

const DEFAULT_STUDENT_ID = 'default-student';

export class MemoryRepository implements AppRepository {
  readonly backendName = 'memory_preview' as const;

  private stimuli = new Map<string, StimulusGroup>();
  private questions = new Map<string, QuestionItem>();
  private configs: { configVersionId: string; versionNumber: number; notes?: string; createdAt: string; config: LearningConfig }[] = [
    {
      configVersionId: 'cfg_v1',
      versionNumber: 1,
      notes: 'Default Selective Lab Learning Config',
      createdAt: new Date().toISOString(),
      config: structuredClone(DEFAULT_LEARNING_CONFIG),
    },
  ];
  private sessions = new Map<string, SessionRecord>();
  private attempts: PartAttemptRecord[] = [];
  private writingSubmissions = new Map<string, WritingSubmissionRecord>();
  private writingEvaluations: WritingEvaluationRecord[] = [];
  private skillStatesByStudent = new Map<string, Record<string, SkillState>>();
  private questionMemoryByStudent = new Map<string, Record<string, QuestionMemoryState>>();
  private flags = new Map<string, QuestionFlagRecord>();

  async initAndSeedIfEmpty(seedManifest: BankImportManifest): Promise<void> {
    if (this.questions.size > 0) return;
    await this.importManifest(seedManifest);
  }

  async hydrateSyncData(studentId: string, payload: SyncHydratePayload): Promise<void> {
    const uid = studentId || DEFAULT_STUDENT_ID;

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
        this.attempts.push({ ...structuredClone(a), studentId: uid });
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

  async listQuestions(filter?: { section?: string; poolType?: string; qcStatus?: string }): Promise<QuestionItem[]> {
    const all = Array.from(this.questions.values());
    // Keep latest version per questionFamilyId unless querying all
    const latestByFamily = new Map<string, QuestionItem>();
    for (const q of all) {
      const prev = latestByFamily.get(q.questionFamilyId);
      if (!prev || q.version > prev.version) {
        latestByFamily.set(q.questionFamilyId, q);
      }
    }
    return Array.from(latestByFamily.values()).filter((q) => {
      if (filter?.section && q.section !== filter.section) return false;
      if (filter?.poolType && q.poolType !== filter.poolType) return false;
      if (filter?.qcStatus && q.qcStatus !== filter.qcStatus) return false;
      return true;
    });
  }

  async getQuestionWithStimulus(questionId: string): Promise<{ question: QuestionItem; stimulus?: StimulusGroup } | null> {
    const q = this.questions.get(questionId);
    if (!q) return null;
    const stimulus = q.stimulusId ? this.stimuli.get(q.stimulusId) : undefined;
    return {
      question: structuredClone(q),
      stimulus: stimulus ? structuredClone(stimulus) : undefined,
    };
  }

  async importManifest(manifest: BankImportManifest): Promise<{ imported: number; skipped: number; versionBumped: number }> {
    let imported = 0;
    let skipped = 0;
    let versionBumped = 0;

    for (const s of manifest.stimuli || []) {
      const hash = s.contentHash || computeCanonicalHash({ title: s.title, preamble: s.preamble, mainTextMarkdown: s.mainTextMarkdown, extracts: s.extracts, visual: s.visual });
      this.stimuli.set(s.stimulusId, { ...structuredClone(s), contentHash: hash });
    }

    const latestByFamily = new Map<string, QuestionItem>();
    for (const q of this.questions.values()) {
      const prev = latestByFamily.get(q.questionFamilyId);
      if (!prev || q.version > prev.version) {
        latestByFamily.set(q.questionFamilyId, q);
      }
    }

    for (const rawQ of manifest.questions || []) {
      const q = structuredClone(rawQ);
      if (!q.poolType) q.poolType = manifest.defaultPoolType;
      if (!q.qcStatus) q.qcStatus = manifest.defaultQcStatus;
      const hash = q.contentHash || computeCanonicalHash({ parts: q.parts, stemPrefix: q.stemPrefix, visual: q.visual, writingSpec: q.writingSpec });
      q.contentHash = hash;

      const existing = latestByFamily.get(q.questionFamilyId);
      if (!existing) {
        this.questions.set(q.questionId, q);
        latestByFamily.set(q.questionFamilyId, q);
        imported++;
      } else if (existing.contentHash === hash && existing.version === q.version && existing.questionId === q.questionId) {
        skipped++;
      } else {
        const nextVersion = Math.max(existing.version + 1, q.version);
        const bumpedId = nextVersion !== q.version || this.questions.has(q.questionId)
          ? `${q.questionFamilyId}_v${nextVersion}`
          : q.questionId;
        const bumpedQ: QuestionItem = { ...q, questionId: bumpedId, version: nextVersion };
        this.questions.set(bumpedQ.questionId, bumpedQ);
        latestByFamily.set(q.questionFamilyId, bumpedQ);
        versionBumped++;
      }
    }

    return { imported, skipped, versionBumped };
  }

  async updateQuestionStatus(questionId: string, qcStatus: QuestionItem['qcStatus']): Promise<void> {
    const q = this.questions.get(questionId);
    if (q) {
      q.qcStatus = qcStatus;
    }
  }

  async updateQuestionVisual(questionId: string, visual: VisualSpec): Promise<void> {
    const q = this.questions.get(questionId);
    if (q) {
      q.visual = structuredClone(visual);
    }
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

  async listConfigVersions(): Promise<{ configVersionId: string; versionNumber: number; notes?: string; createdAt: string; config: LearningConfig }[]> {
    return structuredClone([...this.configs].reverse());
  }

  async saveConfigVersion(config: LearningConfig, notes?: string): Promise<{ configVersionId: string; versionNumber: number }> {
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

  async createSession(session: SessionRecord): Promise<void> {
    this.sessions.set(session.sessionId, {
      ...structuredClone(session),
      studentId: session.studentId || DEFAULT_STUDENT_ID,
    });
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const s = this.sessions.get(sessionId);
    return s ? structuredClone(s) : null;
  }

  async saveSessionCheckpoint(sessionId: string, checkpoint: NonNullable<SessionRecord['checkpoint']>): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s && s.status === 'in_progress') {
      s.checkpoint = structuredClone(checkpoint);
    }
  }

  async completeSession(sessionId: string, summary: { correctSlots: number; totalSlots: number; completedAt: string }): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.status = 'submitted';
      s.correctSlots = summary.correctSlots;
      s.totalSlots = summary.totalSlots;
      s.completedAt = summary.completedAt;
    }
  }

  async listSessions(limit = 50, studentId = DEFAULT_STUDENT_ID): Promise<SessionRecord[]> {
    return Array.from(this.sessions.values())
      .filter((s) => (s.studentId || DEFAULT_STUDENT_ID) === studentId)
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .slice(0, limit)
      .map((s) => structuredClone(s));
  }

  async appendPartAttempts(attempts: PartAttemptRecord[]): Promise<void> {
    for (const a of attempts) {
      this.attempts.push({ ...structuredClone(a), studentId: a.studentId || DEFAULT_STUDENT_ID });
    }
  }

  async listPartAttempts(limit = 1000, studentId = DEFAULT_STUDENT_ID): Promise<PartAttemptRecord[]> {
    return this.attempts
      .filter((a) => (a.studentId || DEFAULT_STUDENT_ID) === studentId && !a.isSandbox)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, limit)
      .map((a) => structuredClone(a));
  }

  async saveWritingSubmission(sub: WritingSubmissionRecord): Promise<void> {
    this.writingSubmissions.set(sub.submissionId, {
      ...structuredClone(sub),
      studentId: sub.studentId || DEFAULT_STUDENT_ID,
    });
  }

  async getWritingSubmission(submissionId: string): Promise<(WritingSubmissionRecord & { evaluations: WritingEvaluationRecord[] }) | null> {
    const sub = this.writingSubmissions.get(submissionId);
    if (!sub) return null;
    const evaluations = this.writingEvaluations.filter((e) => e.submissionId === submissionId);
    return { ...structuredClone(sub), evaluations: structuredClone(evaluations) };
  }

  async listWritingSubmissions(studentId = DEFAULT_STUDENT_ID): Promise<(WritingSubmissionRecord & { evaluations: WritingEvaluationRecord[] })[]> {
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
    for (const s of states) {
      map[s.skillId] = structuredClone(s);
    }
    this.skillStatesByStudent.set(studentId, map);
  }

  async getQuestionMemory(studentId = DEFAULT_STUDENT_ID): Promise<Record<string, QuestionMemoryState>> {
    return structuredClone(this.questionMemoryByStudent.get(studentId) || {});
  }

  async upsertQuestionMemory(entries: QuestionMemoryState[], studentId = DEFAULT_STUDENT_ID): Promise<void> {
    const map = { ...(this.questionMemoryByStudent.get(studentId) || {}) };
    for (const m of entries) {
      map[m.questionFamilyId] = structuredClone(m);
    }
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
    if (flag) {
      flag.status = 'resolved';
    }
  }

  async exportFullBackup(): Promise<Record<string, unknown>> {
    return {
      exportedAt: new Date().toISOString(),
      backendName: this.backendName,
      stimuli: Array.from(this.stimuli.values()),
      questions: Array.from(this.questions.values()),
      configVersions: this.configs,
      sessions: Array.from(this.sessions.values()),
      partAttempts: this.attempts,
      writingSubmissions: Array.from(this.writingSubmissions.values()),
      writingEvaluations: this.writingEvaluations,
      skillStatesByStudent: Object.fromEntries(this.skillStatesByStudent.entries()),
      questionMemoryByStudent: Object.fromEntries(this.questionMemoryByStudent.entries()),
      questionFlags: Array.from(this.flags.values()),
    };
  }
}
