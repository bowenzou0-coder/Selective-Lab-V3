import type {
  BankImportManifest, LearningConfig, PartAttemptRecord, QuestionFlagRecord, QuestionItem,
  QuestionMemoryState, SessionRecord, SkillState, StimulusGroup, VisualSpec, WritingEvaluationRecord
} from '../../shared/contracts';

export interface WritingSubmissionRecord {
  submissionId: string;
  studentId?: string;
  sessionId: string;
  questionId: string;
  planNotes: string;
  responseText: string;
  wordCount: number;
  timeSpentSec: number;
  deterministicMetricsJson: string;
  submittedAt: string;
}

export interface SyncHydratePayload {
  stimuli?: StimulusGroup[];
  questions?: QuestionItem[];
  questionOverrides?: { questionId: string; qcStatus: QuestionItem['qcStatus']; visual?: VisualSpec }[];
  configVersions?: {
    configVersionId: string;
    versionNumber: number;
    notes?: string;
    createdAt: string;
    config: LearningConfig;
  }[];
  sessions?: SessionRecord[];
  attempts?: PartAttemptRecord[];
  skillStates?: SkillState[];
  questionMemory?: QuestionMemoryState[];
  writingSubmissions?: (WritingSubmissionRecord & { evaluations?: WritingEvaluationRecord[] })[];
  flags?: QuestionFlagRecord[];
}

export interface AppRepository {
  readonly backendName: 'cloudsql_postgres' | 'firestore_server' | 'cloudflare_d1' | 'memory_preview';
  initAndSeedIfEmpty(seedManifest: BankImportManifest): Promise<void>;
  hydrateSyncData(studentId: string, payload: SyncHydratePayload): Promise<void>;

  listQuestions(filter?: { section?: string; poolType?: string; qcStatus?: string }): Promise<QuestionItem[]>;
  getQuestionWithStimulus(questionId: string): Promise<{ question: QuestionItem; stimulus?: StimulusGroup } | null>;
  importManifest(manifest: BankImportManifest): Promise<{ imported: number; skipped: number; versionBumped: number }>;
  updateQuestionStatus(questionId: string, qcStatus: QuestionItem['qcStatus']): Promise<void>;
  updateQuestionVisual(questionId: string, visual: VisualSpec): Promise<void>;

  getActiveConfig(): Promise<{ configVersionId: string; versionNumber: number; config: LearningConfig }>;
  listConfigVersions(): Promise<{ configVersionId: string; versionNumber: number; notes?: string; createdAt: string; config: LearningConfig }[]>;
  saveConfigVersion(config: LearningConfig, notes?: string): Promise<{ configVersionId: string; versionNumber: number }>;

  createSession(session: SessionRecord): Promise<void>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  saveSessionCheckpoint(sessionId: string, checkpoint: NonNullable<SessionRecord['checkpoint']>): Promise<void>;
  completeSession(sessionId: string, summary: { correctSlots: number; totalSlots: number; completedAt: string }): Promise<void>;
  listSessions(limit?: number, studentId?: string): Promise<SessionRecord[]>;

  appendPartAttempts(attempts: PartAttemptRecord[]): Promise<void>;
  listPartAttempts(limit?: number, studentId?: string): Promise<PartAttemptRecord[]>;

  saveWritingSubmission(sub: WritingSubmissionRecord): Promise<void>;
  getWritingSubmission(submissionId: string): Promise<(WritingSubmissionRecord & { evaluations: WritingEvaluationRecord[] }) | null>;
  listWritingSubmissions(studentId?: string): Promise<(WritingSubmissionRecord & { evaluations: WritingEvaluationRecord[] })[]>;
  saveWritingEvaluation(ev: WritingEvaluationRecord): Promise<void>;

  getSkillStates(studentId?: string): Promise<Record<string, SkillState>>;
  upsertSkillStates(states: SkillState[], studentId?: string): Promise<void>;
  getQuestionMemory(studentId?: string): Promise<Record<string, QuestionMemoryState>>;
  upsertQuestionMemory(entries: QuestionMemoryState[], studentId?: string): Promise<void>;

  saveQuestionFlag(flag: QuestionFlagRecord): Promise<void>;
  listQuestionFlags(): Promise<QuestionFlagRecord[]>;
  resolveQuestionFlag(flagId: string): Promise<void>;

  exportFullBackup(): Promise<Record<string, unknown>>;
}