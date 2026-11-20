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
  SessionSubmissionPayload,
  SkillState,
  StimulusGroup,
  VisualSpec,
  WritingEvaluationRecord,
} from '../../shared/contracts.ts';

export class RevisionConflictError extends Error {
  readonly statusCode = 409;
  readonly currentRevision: number;
  readonly serverCheckpoint?: SessionCheckpoint;

  constructor(message: string, currentRevision: number, serverCheckpoint?: SessionCheckpoint) {
    super(message);
    this.name = 'RevisionConflictError';
    this.currentRevision = currentRevision;
    this.serverCheckpoint = serverCheckpoint;
  }
}

export class ForbiddenError extends Error {
  readonly statusCode = 403;
  constructor(message = 'Forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends Error {
  readonly statusCode = 404;
  constructor(message = 'Not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}

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

export interface QuestionQueryParams {
  search?: string;
  section?: string;
  poolType?: string;
  qcStatus?: string;
  formatType?: string;
  batchId?: string;
  batchTag?: string;
  skillId?: string;
  includeHistorical?: boolean;
  flaggedOnly?: boolean;
  missingVisual?: boolean;
  missingExplanation?: boolean;
  sort?: 'id_asc' | 'updated_desc' | 'version_desc';
  page?: number;
  pageSize?: number;
}

export interface QuestionQueryResult {
  questions: QuestionItem[];
  stimuliById: Record<string, StimulusGroup>;
  totalMatching: number;
  page: number;
  pageSize: number;
  openFlagsByQuestionId: Record<string, number>;
  batches: ImportBatchRecord[];
}

export interface QuestionVersionSummary {
  question: QuestionItem;
  stimulus?: StimulusGroup;
}

export interface CheckpointSaveResult {
  checkpointRevision: number;
  savedAtIso: string;
}

export interface FinalizeSessionInput {
  sessionId: string;
  studentId: string;
  checkpoint: SessionCheckpoint;
  correctSlots: number;
  totalSlots: number;
  completedAtIso: string;
  expiredAutoSubmitted?: boolean;
  submissionSummary: SessionSubmissionPayload;
  attempts: PartAttemptRecord[];
  skillStates: SkillState[];
  questionMemory: QuestionMemoryState[];
  evidenceUpdates: QuestionMasteryEvidence[];
  writingSubmissions: WritingSubmissionRecord[];
}

export interface FinalizeSessionResult {
  alreadySubmitted: boolean;
  session: SessionRecord;
  submissionSummary: SessionSubmissionPayload;
}

export type ReserveSessionResult =
  | { created: true }
  | { created: false; conflictSessionId: string; conflictSession?: SessionRecord };

export interface BackupSectionCounts {
  stimuli: number;
  questions: number;
  importBatches: number;
  configVersions: number;
  mediaAssets: number;
  questionFlags: number;
  users: number;
  sessions: number;
  partAttempts: number;
  questionEvidence: number;
  writingSubmissions: number;
}

export interface CanonicalBackupBundle {
  schemaVersion: 'v3_canonical_1.0';
  exportedAtIso: string;
  backendName: AppRepository['backendName'];
  counts: BackupSectionCounts;
  checksums: Record<string, string>;
  bundleSha256: string;
  stimuli: StimulusGroup[];
  questions: QuestionItem[];
  importBatches: ImportBatchRecord[];
  configVersions: {
    configVersionId: string;
    versionNumber: number;
    notes?: string;
    createdAt: string;
    config: LearningConfig;
  }[];
  mediaAssets: MediaAssetRecord[];
  questionFlags: QuestionFlagRecord[];
  users: {
    uid: string;
    role: 'student' | 'admin';
    displayName: string;
    email?: string;
    sessions: SessionRecord[];
    sessionSnapshotsBySessionId: Record<string, SessionQuestionSnapshot[]>;
    partAttempts: PartAttemptRecord[];
    skillStates: SkillState[];
    questionMemory: QuestionMemoryState[];
    questionEvidence: QuestionMasteryEvidence[];
    writingSubmissions: (WritingSubmissionRecord & { evaluations: WritingEvaluationRecord[] })[];
  }[];
}

export interface BackupRestoreReport {
  valid: boolean;
  dryRun: boolean;
  checksumVerified: boolean;
  errors: string[];
  warnings: string[];
  wouldCreate: Record<string, number>;
  wouldSkipExisting: Record<string, number>;
  applied: Record<string, number>;
}

export interface MigrationPreflightReport {
  checkedAtIso: string;
  backendName: AppRepository['backendName'];
  totalQuestions: number;
  totalSessions: number;
  totalPartAttempts: number;
  sessionsMissingSnapshots: number;
  attemptsMissingEvidenceRevision: number;
  questionsMissingEvidenceRevision: number;
  legacyUntaggedAttempts: number;
  mediaNeedsUploadCount: number;
  mediaMissingFilesCount: number;
}

export interface AppRepository {
  readonly backendName: 'cloudsql_postgres' | 'firestore_server' | 'cloudflare_d1' | 'memory_preview';
  initAndSeedIfEmpty(seedManifest: BankImportManifest): Promise<void>;
  hydrateSyncData(studentId: string, payload: SyncHydratePayload): Promise<void>;

  upsertUserFromAuth(input: {
    uid: string;
    email: string;
    displayName?: string;
    isBootstrappedAdmin: boolean;
  }): Promise<{ role: 'student' | 'admin' }>;
  isUserAdmin(uid: string): Promise<boolean>;

  listQuestions(filter?: {
    section?: string;
    poolType?: string;
    qcStatus?: string;
    includeHistorical?: boolean;
  }): Promise<QuestionItem[]>;
  listQuestionsPaginated(params?: QuestionQueryParams): Promise<QuestionQueryResult>;
  listQuestionVersions(questionFamilyId: string): Promise<QuestionVersionSummary[]>;
  listStimuliByIds(stimulusIds: string[]): Promise<Record<string, StimulusGroup>>;
  getQuestionWithStimulus(questionId: string): Promise<{ question: QuestionItem; stimulus?: StimulusGroup } | null>;
  importManifest(
    manifest: BankImportManifest,
    importedBy?: string
  ): Promise<{ imported: number; skipped: number; versionBumped: number; batch: ImportBatchRecord }>;
  listImportBatches(): Promise<ImportBatchRecord[]>;
  getImportBatch(batchId: string): Promise<ImportBatchRecord | null>;
  updateQuestionStatus(questionId: string, qcStatus: QuestionItem['qcStatus']): Promise<void>;
  deleteQuestions?(questionIds: string[]): Promise<number>;
  updateQuestionVisual(questionId: string, visual: VisualSpec): Promise<void>;

  getActiveConfig(): Promise<{ configVersionId: string; versionNumber: number; config: LearningConfig }>;
  listConfigVersions(): Promise<
    { configVersionId: string; versionNumber: number; notes?: string; createdAt: string; config: LearningConfig }[]
  >;
  saveConfigVersion(config: LearningConfig, notes?: string): Promise<{ configVersionId: string; versionNumber: number }>;

  createSession(session: SessionRecord, snapshots?: SessionQuestionSnapshot[]): Promise<void>;
  reserveAndCreateSession(
    session: SessionRecord,
    snapshots?: SessionQuestionSnapshot[]
  ): Promise<ReserveSessionResult>;
  getSession(sessionId: string, studentId?: string): Promise<SessionRecord | null>;
  getSessionSnapshots(studentId: string, sessionId: string): Promise<SessionQuestionSnapshot[]>;
  saveSessionCheckpoint(
    sessionId: string,
    studentId: string,
    checkpoint: SessionCheckpoint,
    expectedRevision?: number
  ): Promise<CheckpointSaveResult>;
  completeSession(
    sessionId: string,
    summary: { correctSlots: number; totalSlots: number; completedAt: string },
    studentId?: string
  ): Promise<void>;
  finalizeSessionAtomically(input: FinalizeSessionInput): Promise<FinalizeSessionResult>;
  listSessions(limit?: number, studentId?: string, includeSandbox?: boolean): Promise<SessionRecord[]>;

  appendPartAttempts(attempts: PartAttemptRecord[]): Promise<void>;
  listPartAttempts(limit?: number, studentId?: string, includeSandbox?: boolean): Promise<PartAttemptRecord[]>;

  getQuestionEvidence(studentId: string): Promise<Record<string, QuestionMasteryEvidence>>;
  upsertQuestionEvidence(entries: QuestionMasteryEvidence[], studentId: string): Promise<void>;

  saveWritingSubmission(sub: WritingSubmissionRecord): Promise<void>;
  getWritingSubmission(
    submissionId: string,
    studentId?: string
  ): Promise<(WritingSubmissionRecord & { evaluations: WritingEvaluationRecord[] }) | null>;
  listWritingSubmissions(
    studentId?: string
  ): Promise<(WritingSubmissionRecord & { evaluations: WritingEvaluationRecord[] })[]>;
  saveWritingEvaluation(ev: WritingEvaluationRecord, studentId?: string): Promise<void>;

  getSkillStates(studentId?: string): Promise<Record<string, SkillState>>;
  upsertSkillStates(states: SkillState[], studentId?: string): Promise<void>;
  getQuestionMemory(studentId?: string): Promise<Record<string, QuestionMemoryState>>;
  upsertQuestionMemory(entries: QuestionMemoryState[], studentId?: string): Promise<void>;
  getDailyFocusPlan(studentId: string, planDate: string): Promise<DailyFocusPlan | null>;
  saveDailyFocusPlan(studentId: string, plan: DailyFocusPlan): Promise<void>;

  saveQuestionFlag(flag: QuestionFlagRecord): Promise<void>;
  listQuestionFlags(): Promise<QuestionFlagRecord[]>;
  resolveQuestionFlag(flagId: string): Promise<void>;

  saveMediaAsset(asset: MediaAssetRecord): Promise<void>;
  getMediaAsset(assetId: string): Promise<MediaAssetRecord | null>;
  listMediaAssets(): Promise<MediaAssetRecord[]>;

  exportFullBackup(): Promise<CanonicalBackupBundle>;
  restoreFullBackup(bundle: unknown, options: { dryRun: boolean }): Promise<BackupRestoreReport>;
  runMigrationPreflight(uploadsDir?: string): Promise<MigrationPreflightReport>;
}