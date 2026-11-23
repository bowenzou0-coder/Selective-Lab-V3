import type {
  AdminLearnerSummary,
  BankImportManifest,
  BankMasterySummary,
  BenchmarkReportRecord,
  DailyFocusPlan,
  ImportBatchRecord,
  LearningConfig,
  MarkingResult,
  MediaAssetRecord,
  MockTestBatch,
  QuestionFlagRecord,
  QuestionItem,
  SectionCode,
  SessionMode,
  SessionRecord,
  SessionSubmissionPayload,
  SkillState,
  StimulusGroup,
  StudentQuestionView,
  VisualSpec,
  WritingDeterministicMetrics,
  WritingEvaluationRecord,
} from '../shared/contracts';
export type { AdminLearnerSummary };
import type {
  BankPoolStatus,
  BatchDirectorySummary,
  PoolHealthSummary,
  QuestionCompletionStatus,
  QuestionProgressMeta,
} from '../shared/bankStatus';

export type AuthState = {
  backendName?: string;
  isDisposableDemo?: boolean;
  localDevPinEnabled?: boolean;
} & (
  | {
      authenticated: true;
      role: 'student' | 'admin';
      studentId: string;
      email?: string;
      activeSessionId?: string | null;
    }
  | {
      authenticated: false;
      role: null;
      studentId: null;
      email?: undefined;
      activeSessionId?: null;
    }
);

export interface HealthResponse {
  ok: boolean;
  backendName: string;
  isDisposableDemo: boolean;
  localDevPinEnabled: boolean;
}

export interface CustomBatchOption {
  batchId: string;
  batchLabel: string;
  counts: Record<SectionCode, number>;
  total: number;
}

export interface DashboardResponse {
  studentId: string;
  streakDays: number;
  dailyGoalMinutes: number;
  sectionDrillQuestionCount: number;
  sectionDrillTimeMinutes: number;
  todayMinutes: number;
  todaySlotsAttempted: number;
  todaySlotsCorrect: number;
  dailyLimits: Record<SectionCode, number>;
  autoCalibrateEnabled?: boolean;
  poolCounts?: Record<SectionCode, { live: number; unseen: number }>;
  batchCounts: Record<MockTestBatch, Record<SectionCode, number>>;
  customBatches?: CustomBatchOption[];
  benchmarkBatches?: CustomBatchOption[];
  activeSession: SessionRecord | null;
  recentSessions: SessionRecord[];
  dailyFocusPlan?: DailyFocusPlan;
  serverNowIso?: string;
}

export interface SessionDetailResponse {
  session: SessionRecord;
  questions: StudentQuestionView[];
  serverNowIso?: string;
  reviewResults?: Record<string, MarkingResult[]>;
  writingReview?: {
    submissionId: string;
    questionId: string;
    metrics: WritingDeterministicMetrics;
    evaluations: WritingEvaluationRecord[];
    responseText?: string;
    planNotes?: string;
    evaluatingInProgress?: boolean;
  }[];
}

export interface BenchmarkHubResponse {
  benchmarkBatches: CustomBatchOption[];
  reports: BenchmarkReportRecord[];
}

export interface ProgressResponse {
  sectionStats: Record<
    SectionCode,
    { attempts: number; correct: number; avgTimeSec: number; targetTimeSec: number }
  >;
  skills: {
    skillId: string;
    section: SectionCode;
    familyCode: string;
    displayName: string;
    examWeightHint: number;
    state: SkillState | null;
  }[];
  sessions: SessionRecord[];
  writingSubmissions: {
    submissionId: string;
    sessionId: string;
    questionId: string;
    planNotes: string;
    responseText: string;
    wordCount: number;
    timeSpentSec: number;
    deterministicMetricsJson: string;
    submittedAt: string;
    evaluations: WritingEvaluationRecord[];
  }[];
  totalAttempts: number;
  masterySummary: BankMasterySummary;
}

export interface AdminStatusResponse {
  backendName: string;
  isEphemeralPreview: boolean;
  totalQuestions: number;
  byPool: Record<string, number>;
  bySection: Record<string, number>;
  byQcStatus: Record<string, number>;
  holdoutIsolationOk: boolean;
  holdoutQuestionCount: number;
  leakedCount: number;
  openFlagsCount: number;
  activeConfigVersion: number;
  batchesCount?: number;
}

export type { RuntimeDiagnostics as RuntimeDiagnosticsResponse } from '../server/diagnostics';
import type { RuntimeDiagnostics as RuntimeDiagnosticsResponse } from '../server/diagnostics';

export type { BatchDirectorySummary } from '../shared/bankStatus';

export interface AdminLearnersResponse {
  learners: AdminLearnerSummary[];
  primaryMonitoredStudentId: string | null;
  defaultMonitoredStudentId: string | null;
  totalLiveQuestions: number;
}

export interface PaginatedQuestionsResponse {
  questions: QuestionItem[];
  stimuliById: Record<string, StimulusGroup>;
  totalMatching: number;
  page: number;
  pageSize: number;
  openFlagsByQuestionId: Record<string, number>;
  progressByQuestionId?: Record<string, QuestionProgressMeta>;
  poolHealth?: PoolHealthSummary;
  masteredLiveQuestionIds?: string[];
  batchSummaries?: BatchDirectorySummary[];
  monitoredStudentId?: string | null;
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

export interface RestoreReport {
  valid: boolean;
  dryRun: boolean;
  checksumVerified: boolean;
  errors: string[];
  warnings: string[];
  wouldCreate: Record<string, number>;
  wouldSkipExisting: Record<string, number>;
  applied: Record<string, number>;
}

export interface MediaMigrationManifest {
  generatedAtIso: string;
  uploadsDir: string;
  totalLocalFiles: number;
  totalReferencedUploadUrls: number;
  missingFilesCount: number;
  needsUploadCount: number;
  alreadyStoredCount: number;
  items: {
    sourcePath: string;
    referencedByIds: string[];
    existsLocally: boolean;
    sizeBytes?: number;
    sha256?: string;
    suggestedObjectKey: string;
    status: 'needs_upload' | 'missing_file' | 'already_stored';
  }[];
}

export interface MigrationPreflightReport {
  checkedAtIso: string;
  backendName: string;
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

export type ApiError = Error & {
  status?: number;
  activeSessionId?: string;
  currentRevision?: number;
  serverCheckpoint?: SessionRecord['checkpoint'];
  expiredAutoSubmitted?: boolean;
  alreadySubmitted?: boolean;
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/auth/')) {
      window.dispatchEvent(new CustomEvent('nsw-auth-expired'));
    }
    const payload = data as {
      error?: string;
      activeSessionId?: string;
      currentRevision?: number;
      serverCheckpoint?: SessionRecord['checkpoint'];
      expiredAutoSubmitted?: boolean;
      alreadySubmitted?: boolean;
    };
    const err = new Error(payload?.error || `Request failed (${res.status})`) as ApiError;
    err.status = res.status;
    if (payload?.activeSessionId) err.activeSessionId = payload.activeSessionId;
    if (typeof payload?.currentRevision === 'number') err.currentRevision = payload.currentRevision;
    if (payload?.serverCheckpoint) err.serverCheckpoint = payload.serverCheckpoint;
    if (typeof payload?.expiredAutoSubmitted === 'boolean') {
      err.expiredAutoSubmitted = payload.expiredAutoSubmitted;
    }
    if (typeof payload?.alreadySubmitted === 'boolean') {
      err.alreadySubmitted = payload.alreadySubmitted;
    }
    throw err;
  }
  return data as T;
}

async function downloadFile(url: string, fallbackFilename: string): Promise<void> {
  const res = await fetch(url, {
    credentials: 'same-origin',
  });
  if (!res.ok) {
    throw new Error(`Export failed (${res.status})`);
  }
  const blob = await res.blob();
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objUrl;
  a.download = fallbackFilename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objUrl);
}

export const api = {
  getHealth: () => request<HealthResponse>('/api/health'),
  getMe: () => request<AuthState>('/api/auth/me'),
  getGoogleConfig: () => request<{ clientId: string; nonce: string | null }>('/api/auth/google-config'),
  studentLogin: (pin: string) =>
    request<AuthState>('/api/auth/student-login', {
      method: 'POST',
      body: JSON.stringify({ pin }),
    }),
  adminLogin: (password: string) =>
    request<AuthState>('/api/auth/admin-login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  googleLogin: (credential: string, admin: boolean) =>
    request<AuthState>('/api/auth/google-login', {
      method: 'POST',
      body: JSON.stringify({ credential, admin }),
    }),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  downloadFile,

  getDashboard: () =>
    request<DashboardResponse>('/api/student/dashboard'),
  getBenchmarks: () =>
    request<BenchmarkHubResponse>('/api/student/benchmarks'),
  getBenchmarkReport: (sessionId: string) =>
    request<{ report: BenchmarkReportRecord }>(`/api/student/benchmarks/${encodeURIComponent(sessionId)}`),
  analyzeBenchmarkReport: (sessionId: string, force = false) =>
    request<{ report: BenchmarkReportRecord }>(
      `/api/student/benchmarks/${encodeURIComponent(sessionId)}/analyze`,
      {
        method: 'POST',
        body: JSON.stringify({ force }),
      }
    ),
  createSession: (payload: {
    mode: SessionMode;
    sectionFilter?: SectionCode;
    mockBatch?: MockTestBatch;
    mockSource?: 'pool' | 'batch';
    batchId?: string;
    questionCount?: number;
    timeMultiplier?: number;
    customTimeLimitSec?: number;
  }) =>
    request<{ sessionId: string; session: SessionRecord; serverNowIso?: string }>(
      '/api/student/sessions',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),
  getSession: (id: string) =>
    request<SessionDetailResponse>(`/api/student/sessions/${encodeURIComponent(id)}`),
  saveCheckpoint: (
    id: string,
    checkpoint: NonNullable<SessionRecord['checkpoint']>,
    expectedRevision?: number
  ) =>
    request<{
      ok: boolean;
      checkpointRevision: number;
      revision?: number;
      savedAtIso?: string;
      serverNowIso?: string;
    }>(`/api/student/sessions/${encodeURIComponent(id)}/checkpoint`, {
      method: 'PATCH',
      body: JSON.stringify({ checkpoint, expectedRevision }),
    }),
  submitSession: (
    id: string,
    checkpoint?: SessionRecord['checkpoint'],
    assisted?: boolean,
    expectedRevision?: number
  ) =>
    request<SessionSubmissionPayload & { alreadySubmitted?: boolean }>(
      `/api/student/sessions/${encodeURIComponent(id)}/submit`,
      {
        method: 'POST',
        body: JSON.stringify({ checkpoint, assisted, expectedRevision }),
      }
    ),
  evaluateWriting: (submissionId: string) =>
    request<{ evaluation: WritingEvaluationRecord; evaluations?: WritingEvaluationRecord[] }>(
      `/api/student/writing/${encodeURIComponent(submissionId)}/evaluate`,
      { method: 'POST' }
    ),
  flagQuestion: (payload: { questionId: string; sessionId: string; reason: string; notes?: string }) =>
    request<{ flag: QuestionFlagRecord }>('/api/student/flags', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getProgress: () =>
    request<ProgressResponse>('/api/student/progress'),

  // Admin APIs
  getAdminStatus: () =>
    request<AdminStatusResponse>('/api/admin/status'),
  getAdminDiagnostics: () =>
    request<RuntimeDiagnosticsResponse>('/api/admin/diagnostics'),
  getAdminQuestions: (params?: {
    studentId?: string;
    search?: string;
    section?: string;
    poolType?: string;
    qcStatus?: string;
    poolStatus?: BankPoolStatus | '';
    completionStatus?: QuestionCompletionStatus | '';
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
    /** false skips pool health / batch summaries (they only change with the learner or the bank). */
    includeSummary?: boolean;
  }, signal?: AbortSignal) => {
    const qs = new URLSearchParams();
    if (params?.studentId) qs.set('studentId', params.studentId);
    if (params?.search) qs.set('search', params.search);
    if (params?.section) qs.set('section', params.section);
    if (params?.poolType) qs.set('poolType', params.poolType);
    if (params?.qcStatus) qs.set('qcStatus', params.qcStatus);
    if (params?.poolStatus) qs.set('poolStatus', params.poolStatus);
    if (params?.completionStatus) qs.set('completionStatus', params.completionStatus);
    if (params?.formatType) qs.set('formatType', params.formatType);
    if (params?.batchId) qs.set('batchId', params.batchId);
    if (params?.batchTag) qs.set('batchTag', params.batchTag);
    if (params?.skillId) qs.set('skillId', params.skillId);
    if (params?.includeHistorical) qs.set('includeHistorical', 'true');
    if (params?.flaggedOnly) qs.set('flaggedOnly', 'true');
    if (params?.missingVisual) qs.set('missingVisual', 'true');
    if (params?.missingExplanation) qs.set('missingExplanation', 'true');
    if (params?.sort) qs.set('sort', params.sort);
    if (params?.page) qs.set('page', String(params.page));
    if (params?.pageSize) qs.set('pageSize', String(params.pageSize));
    if (params?.includeSummary === false) qs.set('summary', '0');
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<PaginatedQuestionsResponse>(`/api/admin/questions${suffix}`, { signal });
  },
  getAdminLearners: () =>
    request<AdminLearnersResponse>('/api/admin/learners'),
  setPrimaryMonitoredLearner: (studentId: string | null) =>
    request<{ ok: boolean; primaryMonitoredStudentId: string | null }>('/api/admin/learners/primary', {
      method: 'POST',
      body: JSON.stringify({ studentId }),
    }),
  getAdminDailyPlan: (studentId?: string) => {
    const suffix = studentId ? `?studentId=${encodeURIComponent(studentId)}` : '';
    return request<{ studentId: string | null; plan: DailyFocusPlan | null }>(`/api/admin/daily-plan${suffix}`);
  },
  getQuestionVersions: (questionId: string) =>
    request<{
      questionFamilyId: string;
      versions: { question: QuestionItem; stimulus?: StimulusGroup }[];
    }>(`/api/admin/questions/${encodeURIComponent(questionId)}/versions`),
  getImportBatches: () =>
    request<{ batches: ImportBatchRecord[] }>('/api/admin/batches'),
  /** Lightweight batch directory (metadata only) for the monitored learner. */
  getAdminBatchSummaries: (studentId?: string | null) => {
    const suffix = studentId === undefined ? '' : `?studentId=${encodeURIComponent(studentId ?? 'none')}`;
    return request<{ batchSummaries: BatchDirectorySummary[]; monitoredStudentId: string | null }>(
      `/api/admin/batches/summary${suffix}`
    );
  },
  updateQuestionStatus: (questionId: string, qcStatus: QuestionItem['qcStatus']) =>
    request<{ ok: boolean }>(`/api/admin/questions/${encodeURIComponent(questionId)}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ qcStatus }),
    }),
  bulkUpdateQuestionStatus: (questionIds: string[], qcStatus: QuestionItem['qcStatus']) =>
    request<{ ok: boolean; updatedCount: number }>('/api/admin/questions/bulk-status', {
      method: 'POST',
      body: JSON.stringify({ questionIds, qcStatus }),
    }),
  deleteQuestions: (questionIds: string[]) =>
    request<{ ok: boolean; deletedCount: number }>('/api/admin/questions/delete', {
      method: 'POST',
      body: JSON.stringify({ questionIds }),
    }),
  recalibrateDailyPlan: (configOverride?: LearningConfig, studentId?: string) =>
    request<{ plan: DailyFocusPlan; studentId?: string; error?: string }>('/api/admin/recalibrate-daily-plan', {
      method: 'POST',
      body: JSON.stringify({ config: configOverride, studentId }),
    }),
  getProgressCounts: (studentId?: string) => {
    const suffix = studentId ? `?studentId=${encodeURIComponent(studentId)}` : '';
    return request<ProgressCountsResponse & { studentId?: string }>(`/api/admin/study-progress${suffix}`);
  },
  resetStudentProgress: (studentId?: string) =>
    request<ProgressResetResponse & { studentId?: string }>('/api/admin/study-progress/reset', {
      method: 'POST',
      body: JSON.stringify({ studentId }),
    }),
  attachQuestionVisual: (
    questionId: string,
    payload: { altText: string; caption?: string; imageBase64?: string; filename?: string; visual?: VisualSpec }
  ) =>
    request<{ ok: boolean; visual: VisualSpec; qcStatus?: QuestionItem['qcStatus'] }>(
      `/api/admin/questions/${encodeURIComponent(questionId)}/visual`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),
  uploadMedia: (payload: { filename: string; imageBase64: string; questionId?: string }) =>
    request<{ ok: boolean; asset: MediaAssetRecord }>('/api/admin/media/upload', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getMediaMigrationManifest: () =>
    request<{ manifest: MediaMigrationManifest }>('/api/admin/media/migration-manifest'),
  createCalibrationSession: (payload: {
    questionIds?: string[];
    items?: { questionId: string }[];
    section?: string;
    poolType?: string;
    qcStatus?: string;
    formatType?: string;
    skillFamily?: string;
    skillId?: string;
    batch?: string;
    batchId?: string;
    includeHistorical?: boolean;
    limit?: number;
    customTimeLimitSec?: number;
    isSandbox?: boolean;
  }) =>
    request<{ sessionId: string; count: number; session: SessionRecord }>(
      '/api/admin/calibration/session',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),
  getCalibrationInspector: (sessionId: string) =>
    request<{ inspectorByQuestionId: Record<string, QuestionItem> }>(
      `/api/admin/calibration/session/${encodeURIComponent(sessionId)}`
    ),
  dryRunManifest: (manifest: unknown) =>
    request<{
      report: {
        valid: boolean;
        batchLabel: string;
        stimuliCount: number;
        questionsCount: number;
        newQuestions: number;
        unchangedQuestions: number;
        versionBumpedQuestions: number;
        errors: string[];
        warnings: string[];
      };
    }>('/api/admin/import/dry-run', {
      method: 'POST',
      body: JSON.stringify({ manifest }),
    }),
  commitManifest: (manifest: BankImportManifest) =>
    request<{
      ok: boolean;
      result: { imported: number; skipped: number; versionBumped: number };
      batch?: ImportBatchRecord;
    }>('/api/admin/import/commit', {
      method: 'POST',
      body: JSON.stringify({ manifest }),
    }),
  getImportSchema: () =>
    request<{ schema: unknown; starterExample: unknown }>('/api/admin/import/schema'),
  getAdminConfig: () =>
    request<{
      active: { configVersionId: string; versionNumber: number; config: LearningConfig };
      history: {
        configVersionId: string;
        versionNumber: number;
        notes?: string;
        createdAt: string;
        config: LearningConfig;
      }[];
    }>('/api/admin/config'),
  saveAdminConfig: (config: LearningConfig, notes?: string) =>
    request<{
      ok: boolean;
      configVersionId: string;
      versionNumber: number;
      config?: LearningConfig;
      notes?: string;
      createdAtIso?: string;
    }>('/api/admin/config', {
      method: 'POST',
      body: JSON.stringify({ config, notes }),
    }),
  getAdminFlags: () =>
    request<{ flags: QuestionFlagRecord[] }>('/api/admin/flags'),
  resolveFlag: (flagId: string) =>
    request<{ ok: boolean }>(`/api/admin/flags/${encodeURIComponent(flagId)}/resolve`, {
      method: 'POST',
    }),
  restoreBackup: (backup: unknown, dryRun = true) =>
    request<{ ok: boolean; report: RestoreReport }>('/api/admin/restore', {
      method: 'POST',
      body: JSON.stringify({ backup, dryRun }),
    }),
  getMigrationPreflight: () =>
    request<{ report: MigrationPreflightReport }>('/api/admin/migrate/preflight'),
  applyMigration: (payload: unknown, dryRun = true, studentId?: string) =>
    request<{ ok: boolean; mode: string; report?: RestoreReport; counts?: Record<string, number> }>(
      '/api/admin/migrate/apply',
      {
        method: 'POST',
        body: JSON.stringify({ payload, dryRun, studentId }),
      }
    ),
};
