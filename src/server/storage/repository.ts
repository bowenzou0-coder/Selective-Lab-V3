import type {
  BankPoolStatus,
  BatchDirectorySummary,
  PoolHealthSummary,
  QuestionCompletionStatus,
  QuestionProgressMeta,
} from '../../shared/bankStatus.ts';
import type {
  BankImportManifest,
  BankMasterySummary,
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
  SectionCode,
  SessionCheckpoint,
  SessionQuestionSnapshot,
  SessionRecord,
  SessionSectionState,
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

/** Metadata-only projection of a question (no parts, SVGs or explanations). */
export type QuestionMeta = Pick<
  QuestionItem,
  | 'questionId'
  | 'questionFamilyId'
  | 'version'
  | 'section'
  | 'formatType'
  | 'poolType'
  | 'qcStatus'
  | 'stimulusId'
  | 'batchId'
  | 'batchLabel'
  | 'createdAtIso'
  | 'updatedAtIso'
  | 'evidenceRevision'
> & { provenance: Partial<Pick<QuestionItem['provenance'], 'sourceType' | 'sourceReference'>> };

/** Slim selection projection of a question (only fields needed for adaptive/mock/calibration selection). */
export type QuestionSelectionPart = Pick<
  QuestionItem['parts'][number],
  'partId' | 'skillId' | 'secondarySkillIds' | 'difficultyInitial' | 'difficultyCalibrated' | 'targetTimeSec'
>;

export type QuestionSelectionItem = Pick<
  QuestionItem,
  | 'questionId'
  | 'questionFamilyId'
  | 'version'
  | 'section'
  | 'formatType'
  | 'poolType'
  | 'qcStatus'
  | 'stimulusId'
  | 'batchId'
  | 'batchLabel'
  | 'evidenceRevision'
> & {
  provenance: Partial<Pick<QuestionItem['provenance'], 'sourceType' | 'sourceReference'>>;
  parts: QuestionSelectionPart[];
};

export type WithdrawQuestionFlagResult = 'withdrawn' | 'not_found' | 'not_open';

export interface AdminBankStatusSummary {
  totalQuestions: number;
  byPool: Record<string, number>;
  bySection: Record<string, number>;
  byQcStatus: Record<string, number>;
  holdoutQuestionCount: number;
  leakedCount: number;
  openFlagsCount: number;
  batchesCount: number;
}

export interface StudentDashboardBankSummary {
  batchCounts: Record<'PT1' | 'PT2' | 'PT3', Record<SectionCode, number>>;
  poolCounts: Record<SectionCode, { live: number; unseen: number }>;
  customBatches: { batchId: string; batchLabel: string; counts: Record<SectionCode, number>; total: number }[];
  benchmarkBatches: { batchId: string; batchLabel: string; counts: Record<SectionCode, number>; total: number }[];
}

export interface TodayAttemptCounts {
  attempted: number;
  correct: number;
}

export interface StudentProgressBankStats {
  sectionStats: Record<
    SectionCode,
    { attempts: number; correct: number; avgTimeSec: number; targetTimeSec: number }
  >;
  totalAttempts: number;
  masterySummary: BankMasterySummary;
}

/** Import batch record without its (potentially long) question id lists. */
export type ImportBatchSummary = Omit<ImportBatchRecord, 'newQuestionIds' | 'versionBumpedQuestionIds' | 'skippedQuestionIds'>;

export interface LearnerActivityStats {
  sessionsCount: number;
  attemptsCount: number;
  lastActiveAtIso?: string;
}

/**
 * Slim per-session metadata for dashboard aggregates (streaks, today's minutes, counts).
 * Never carries checkpoint answers, planned ids, section state or submission summaries.
 */
export interface SessionSummaryRow {
  sessionId: string;
  mode: SessionRecord['mode'];
  status: SessionRecord['status'];
  isSandbox: boolean;
  sectionFilter?: SessionRecord['sectionFilter'];
  startedAt: string;
  completedAt?: string;
  correctSlots: number;
  totalSlots: number;
  /** checkpoint.elapsedSec, or 0 when the session has no checkpoint yet. */
  elapsedSec: number;
}

export interface ListSessionsOptions {
  /** Drop the heavy stored submission summary (review results, attempts) from each row. */
  omitSubmissionSummary?: boolean;
}

export interface QuestionQueryParams {
  search?: string;
  section?: string;
  poolType?: string;
  qcStatus?: string;
  poolStatus?: BankPoolStatus;
  completionStatus?: QuestionCompletionStatus;
  progress?: {
    evidence: Record<string, QuestionMasteryEvidence>;
    memory: Record<string, QuestionMemoryState>;
    dailyQuestionTarget: number;
  };
  /** When provided, SQL joins question_evidence/question_memory for this learner (null = bank-only/all unseen). */
  monitoredStudentId?: string | null;
  dailyQuestionTarget?: number;
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
  /** Default true. false omits poolHealth, masteredLiveQuestionIds and batchSummaries. */
  includeSummary?: boolean;
}

export interface QuestionQueryResult {
  questions: QuestionItem[];
  stimuliById: Record<string, StimulusGroup>;
  totalMatching: number;
  page: number;
  pageSize: number;
  openFlagsByQuestionId: Record<string, number>;
  batches: ImportBatchSummary[];
  progressByQuestionId?: Record<string, QuestionProgressMeta>;
  poolHealth?: PoolHealthSummary;
  masteredLiveQuestionIds?: string[];
  batchSummaries?: BatchDirectorySummary[];
  monitoredStudentId?: string | null;
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
  sectionState?: SessionSectionState;
  expectedRevision?: number;
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
  dailyFocusPlans?: number;
  benchmarkReports?: number;
  learnerPreferences?: number;
}

export interface CanonicalBackupBundle {
  schemaVersion: 'v3_canonical_1.0';
  exportedAtIso: string;
  backendName: AppRepository['backendName'] | 'cloudsql_postgres';
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
    dailyFocusPlans?: DailyFocusPlan[];
    /** Saved official-benchmark reports. Absent in bundles exported before benchmarks shipped. */
    benchmarkReports?: BenchmarkReportRecord[];
    /** Personal daily-plan settings and admin locks. Absent (or null) when the learner has none. */
    learnerPreferences?: LearnerPreferences | null;
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

export interface ProgressCountsResponse {
  sessionsCount: number;
  attemptsCount: number;
  evidenceCount: number;
  writingCount: number;
  bankQuestionsCount: number;
}

export interface ProgressResetResponse {
  ok: boolean;
  clearedSessions: number;
  clearedAttempts: number;
  clearedSkillStates: number;
  clearedMemory: number;
  clearedEvidence: number;
  clearedWriting: number;
  clearedDailyPlans: number;
  preservedQuestionsCount: number;
}

export interface AccountDeleteResponse extends ProgressResetResponse {
  deletedUser: boolean;
  clearedFlags: number;
}

export interface AppRepository {
  readonly backendName: 'postgres' | 'memory_preview';
  initAndSeedIfEmpty(seedManifest: BankImportManifest): Promise<void>;
  hydrateSyncData(studentId: string, payload: SyncHydratePayload): Promise<void>;

  upsertUserFromAuth(input: {
    uid: string;
    email: string;
    displayName?: string;
    isBootstrappedAdmin: boolean;
  }): Promise<{ role: 'student' | 'admin' }>;
  isUserAdmin(uid: string): Promise<boolean>;
  listUsers(): Promise<LearnerAccountRecord[]>;
  getLearnerPreferences(studentId: string): Promise<LearnerPreferences | null>;
  saveLearnerPreferences(studentId: string, prefs: LearnerPreferences): Promise<LearnerPreferences>;
  deleteLearnerPreferences(studentId: string): Promise<void>;
  deleteUserAccount(studentId: string): Promise<AccountDeleteResponse>;
  getProgressCounts?(studentId: string): Promise<ProgressCountsResponse>;
  resetStudentProgress?(studentId: string): Promise<ProgressResetResponse>;

  listQuestions(filter?: {
    section?: string;
    poolType?: string;
    qcStatus?: string;
    includeHistorical?: boolean;
  }): Promise<QuestionItem[]>;
  /** Targeted fetch of full question bodies by ID (no full-bank scan). */
  listQuestionsByIds(questionIds: string[]): Promise<QuestionItem[]>;
  /** Targeted fetch of full question bodies matching families or IDs (used for manifest dry-run/import). */
  listQuestionsByFamilies(familyIds: string[], questionIds?: string[]): Promise<QuestionItem[]>;
  /** Slim selection-only projection of questions (no prompts, options, SVGs or explanations). */
  listSelectionQuestions(filter?: {
    section?: string;
    poolType?: string;
    qcStatus?: string;
    batchId?: string;
    batchTag?: string;
    includeHistorical?: boolean;
  }): Promise<QuestionSelectionItem[]>;
  /** Latest-version metadata rows; far cheaper than listQuestions for counts and summaries. */
  listQuestionMeta(filter?: { qcStatus?: string }): Promise<QuestionMeta[]>;
  listQuestionsPaginated(params?: QuestionQueryParams): Promise<QuestionQueryResult>;
  listQuestionVersions(questionFamilyId: string): Promise<QuestionVersionSummary[]>;
  listStimuliByIds(stimulusIds: string[]): Promise<Record<string, StimulusGroup>>;
  getQuestionWithStimulus(questionId: string): Promise<{ question: QuestionItem; stimulus?: StimulusGroup } | null>;
  importManifest(
    manifest: BankImportManifest,
    importedBy?: string
  ): Promise<{ imported: number; skipped: number; versionBumped: number; batch: ImportBatchRecord }>;
  listImportBatches(): Promise<ImportBatchRecord[]>;
  /** Batch labels/provenance only (no question id arrays) for summaries and counts. */
  listImportBatchSummaries(): Promise<ImportBatchSummary[]>;
  getImportBatch(batchId: string): Promise<ImportBatchRecord | null>;
  updateQuestionStatus(questionId: string, qcStatus: QuestionItem['qcStatus']): Promise<void>;
  bulkUpdateQuestionStatus(questionIds: string[], qcStatus: QuestionItem['qcStatus']): Promise<number>;
  deleteQuestions?(questionIds: string[]): Promise<number>;
  updateQuestionVisual(questionId: string, visual: VisualSpec): Promise<void>;

  /** SQL-aggregated admin status summary (avoids reading full bank metadata). */
  getAdminBankStatusSummary(): Promise<AdminBankStatusSummary>;
  /** SQL-aggregated student dashboard pool/batch summary. */
  getStudentDashboardBankSummary(studentId: string, autoRetireMastered: boolean): Promise<StudentDashboardBankSummary>;
  /** SQL-aggregated attempt counts for a single UTC date prefix (YYYY-MM-DD). */
  getTodayAttemptCounts(studentId: string, datePrefix: string): Promise<TodayAttemptCounts>;
  /** SQL-aggregated section accuracy/timing stats and bank-wide mastery summary. */
  getStudentProgressStats(input: {
    studentId: string;
    writingSubmissionsCount: number;
    writingEvaluatedCount: number;
    policyVersion?: string;
  }): Promise<StudentProgressBankStats>;
  /** SQL-aggregated pool health counts across multiple learners. */
  getPoolHealthByLearner(
    studentIds: string[],
    dailyQuestionTarget: number
  ): Promise<{ totalLiveQuestions: number; byStudentId: Record<string, PoolHealthSummary> }>;
  /** SQL-aggregated batch directory summaries for a monitored learner (or null for bank-only). */
  getBatchSummaries(studentId: string | null): Promise<BatchDirectorySummary[]>;

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
  updateSessionProgressState(
    sessionId: string,
    studentId: string,
    mutate: (session: SessionRecord) => void,
    expectedRevision?: number
  ): Promise<{ session: SessionRecord; checkpointRevision: number }>;
  completeSession(
    sessionId: string,
    summary: { correctSlots: number; totalSlots: number; completedAt: string },
    studentId?: string
  ): Promise<void>;
  finalizeSessionAtomically(input: FinalizeSessionInput): Promise<FinalizeSessionResult>;
  listSessions(
    limit?: number,
    studentId?: string,
    includeSandbox?: boolean,
    options?: ListSessionsOptions
  ): Promise<SessionRecord[]>;
  /** Lightweight session metadata (newest first) without loading full session JSON payloads. */
  listSessionSummaries(limit?: number, studentId?: string, includeSandbox?: boolean): Promise<SessionSummaryRow[]>;
  /** In-progress, non-sandbox sessions for one student (newest first). */
  listActiveSessions(studentId: string): Promise<SessionRecord[]>;
  /** Session/attempt counts and last activity per learner, computed without loading rows. */
  getLearnerActivity(studentIds: string[]): Promise<Record<string, LearnerActivityStats>>;
  /** Planned holdout questions found in non-benchmark sessions across every learner. */
  countHoldoutLeaks(holdoutQuestionIds: string[]): Promise<number>;

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

  saveBenchmarkReport(report: BenchmarkReportRecord): Promise<void>;
  getBenchmarkReport(sessionId: string, studentId?: string): Promise<BenchmarkReportRecord | null>;
  listBenchmarkReports(studentId: string, limit?: number): Promise<BenchmarkReportRecord[]>;

  saveQuestionFlag(flag: QuestionFlagRecord): Promise<void>;
  listQuestionFlags(studentId?: string): Promise<QuestionFlagRecord[]>;
  resolveQuestionFlag(flagId: string): Promise<void>;
  /**
   * Removes a learner's own still-open flag. `not_found` covers missing and other learners' flags;
   * `not_open` means an admin already resolved it.
   */
  withdrawQuestionFlag(flagId: string, studentId: string): Promise<WithdrawQuestionFlagResult>;

  saveMediaAsset(asset: MediaAssetRecord): Promise<void>;
  getMediaAsset(assetId: string): Promise<MediaAssetRecord | null>;
  listMediaAssets(): Promise<MediaAssetRecord[]>;

  exportFullBackup(): Promise<CanonicalBackupBundle>;
  restoreFullBackup(bundle: unknown, options: { dryRun: boolean }): Promise<BackupRestoreReport>;
  runMigrationPreflight(uploadsDir?: string): Promise<MigrationPreflightReport>;
}
