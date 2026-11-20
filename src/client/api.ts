import type {
  BankImportManifest,
  BankMasterySummary,
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
import type {
  BankPoolStatus,
  PoolHealthSummary,
  QuestionCompletionStatus,
  QuestionProgressMeta,
} from '../shared/bankStatus';
import { createFirestoreClientApi } from './firestoreClientApi';

export interface AuthState {
  authenticated: boolean;
  role: 'student' | 'admin' | null;
  studentId: string | null;
  email?: string;
  activeSessionId?: string | null;
  backendName?: string;
  isDisposableDemo?: boolean;
  localDevPinEnabled?: boolean;
}

export interface HealthResponse {
  ok: boolean;
  backendName: string;
  isDisposableDemo: boolean;
  emulatorActive: boolean;
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
  }[];
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

export interface RuntimeDiagnosticsResponse {
  checkedAtIso: string;
  configSource: 'firebase-applet-config.json';
  projectId: string;
  firestoreDatabaseId: string;
  storageBucket: string;
  runtimeBackend: string;
  nodeEnv: string;
  isCloudRuntime: boolean;
  kService: string | null;
  runtimeServiceAccount: string | null;
  credentialMode: 'client_sdk' | 'explicit_credentials' | 'emulator' | 'attached_adc' | 'none';
  emulatorActive: boolean;
  localDevPinEnabled: boolean;
  sessionSecretConfigured: boolean;
  geminiConfigured: boolean;
  geminiModel?: string;
  firestoreProbe: {
    ok: boolean;
    latencyMs: number;
    errorCode?: string;
    errorMessage?: string;
  };
  storageProbe: {
    ok: boolean;
    exists?: boolean;
    error?: string;
  };
  remediationHint: string | null;
}

export interface BatchDirectorySummary {
  batchId: string;
  batchLabel: string;
  createdAtIso: string;
  importedBy: string;
  total: number;
  live: number;
  unseen: number;
  done: number;
  paused: number;
  archived: number;
  questionIds: string[];
}

export interface PaginatedQuestionsResponse {
  questions: QuestionItem[];
  stimuliById: Record<string, StimulusGroup>;
  totalMatching: number;
  page: number;
  pageSize: number;
  openFlagsByQuestionId: Record<string, number>;
  batches: ImportBatchRecord[];
  progressByQuestionId?: Record<string, QuestionProgressMeta>;
  poolHealth?: PoolHealthSummary;
  masteredLiveQuestionIds?: string[];
  batchSummaries?: BatchDirectorySummary[];
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
  alreadyGcsCount: number;
  items: {
    sourcePath: string;
    referencedByIds: string[];
    existsLocally: boolean;
    sizeBytes?: number;
    sha256?: string;
    suggestedObjectKey: string;
    status: 'needs_upload' | 'missing_file' | 'already_gcs';
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

const TOKEN_STORAGE_KEY = 'selective_lab_auth_token';
let memoryToken: string | null = null;
let clientFirestoreMode = false;

function getStoredToken(): string | null {
  if (memoryToken) return memoryToken;
  try {
    const val = window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (val) {
      memoryToken = val;
      return val;
    }
  } catch {
    // ignore storage errors
  }
  return null;
}

function setStoredToken(token: string | null): void {
  memoryToken = token;
  try {
    if (token) {
      window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    } else {
      window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    // ignore storage errors
  }
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
  const token = getStoredToken();
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
      setStoredToken(null);
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

const fsClient = createFirestoreClientApi(request);

async function downloadFile(url: string, fallbackFilename: string): Promise<void> {
  if (clientFirestoreMode) {
    return fsClient.downloadClientExport(url, fallbackFilename);
  }
  const token = getStoredToken();
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
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
  getHealth: async () => {
    const res = await request<HealthResponse>('/api/health');
    if (res.backendName === 'firestore_client') {
      clientFirestoreMode = true;
    }
    return res;
  },
  getMe: async () => {
    const res = await request<AuthState>('/api/auth/me');
    if (res.backendName === 'firestore_client') {
      clientFirestoreMode = true;
    }
    return res;
  },
  studentLogin: async (pin: string) => {
    const res = await request<AuthState & { token?: string }>('/api/auth/student-login', {
      method: 'POST',
      body: JSON.stringify({ pin }),
    });
    if (res.token) setStoredToken(res.token);
    return res;
  },
  adminLogin: async (password: string) => {
    const res = await request<AuthState & { token?: string }>('/api/auth/admin-login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
    if (res.token) setStoredToken(res.token);
    return res;
  },
  firebaseLogin: async (idToken: string) => {
    const res = await request<AuthState & { token?: string }>('/api/auth/firebase-login', {
      method: 'POST',
      body: JSON.stringify({ idToken }),
    });
    if (res.token) setStoredToken(res.token);
    if (res.backendName === 'firestore_client') {
      clientFirestoreMode = true;
      const synced = await fsClient.syncUserAfterLogin();
      return { ...res, activeSessionId: synced.activeSessionId };
    }
    return res;
  },
  logout: async () => {
    setStoredToken(null);
    return request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
  },
  downloadFile,

  getDashboard: () =>
    clientFirestoreMode
      ? fsClient.getDashboard()
      : request<DashboardResponse>('/api/student/dashboard'),
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
    clientFirestoreMode
      ? fsClient.createSession(payload)
      : request<{ sessionId: string; session: SessionRecord; serverNowIso?: string }>(
          '/api/student/sessions',
          {
            method: 'POST',
            body: JSON.stringify(payload),
          }
        ),
  getSession: (id: string) =>
    clientFirestoreMode
      ? fsClient.getSession(id)
      : request<SessionDetailResponse>(`/api/student/sessions/${encodeURIComponent(id)}`),
  saveCheckpoint: (
    id: string,
    checkpoint: NonNullable<SessionRecord['checkpoint']>,
    expectedRevision?: number
  ) =>
    clientFirestoreMode
      ? fsClient.saveCheckpoint(id, checkpoint, expectedRevision)
      : request<{
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
    assisted?: boolean
  ) =>
    clientFirestoreMode
      ? fsClient.submitSession(id, checkpoint, assisted)
      : request<SessionSubmissionPayload & { alreadySubmitted?: boolean }>(
          `/api/student/sessions/${encodeURIComponent(id)}/submit`,
          {
            method: 'POST',
            body: JSON.stringify({ checkpoint, assisted }),
          }
        ),
  evaluateWriting: (submissionId: string) =>
    clientFirestoreMode
      ? fsClient.evaluateWriting(submissionId)
      : request<{ evaluation: WritingEvaluationRecord; evaluations?: WritingEvaluationRecord[] }>(
          `/api/student/writing/${encodeURIComponent(submissionId)}/evaluate`,
          { method: 'POST' }
        ),
  flagQuestion: (payload: { questionId: string; sessionId: string; reason: string; notes?: string }) =>
    clientFirestoreMode
      ? fsClient.flagQuestion(payload)
      : request<{ flag: QuestionFlagRecord }>('/api/student/flags', {
          method: 'POST',
          body: JSON.stringify(payload),
        }),
  getProgress: () =>
    clientFirestoreMode
      ? fsClient.getProgress()
      : request<ProgressResponse>('/api/student/progress'),

  // Admin APIs
  getAdminStatus: () =>
    clientFirestoreMode
      ? fsClient.getAdminStatus()
      : request<AdminStatusResponse>('/api/admin/status'),
  getAdminDiagnostics: () =>
    clientFirestoreMode
      ? fsClient.getAdminDiagnostics()
      : request<RuntimeDiagnosticsResponse>('/api/admin/diagnostics'),
  getAdminQuestions: (params?: {
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
  }) => {
    if (clientFirestoreMode) {
      return fsClient.getAdminQuestions(params);
    }
    const qs = new URLSearchParams();
    if (params?.search) qs.set('search', params.search);
    if (params?.section) qs.set('section', params.section);
    if (params?.poolType) qs.set('poolType', params.poolType);
    if (params?.qcStatus) qs.set('qcStatus', params.qcStatus);
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
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<PaginatedQuestionsResponse>(`/api/admin/questions${suffix}`);
  },
  getQuestionVersions: (questionId: string) =>
    clientFirestoreMode
      ? fsClient.getQuestionVersions(questionId)
      : request<{
          questionFamilyId: string;
          versions: { question: QuestionItem; stimulus?: StimulusGroup }[];
        }>(`/api/admin/questions/${encodeURIComponent(questionId)}/versions`),
  getImportBatches: () =>
    clientFirestoreMode
      ? fsClient.getImportBatches()
      : request<{ batches: ImportBatchRecord[] }>('/api/admin/batches'),
  updateQuestionStatus: (questionId: string, qcStatus: QuestionItem['qcStatus']) =>
    clientFirestoreMode
      ? fsClient.updateQuestionStatus(questionId, qcStatus)
      : request<{ ok: boolean }>(`/api/admin/questions/${encodeURIComponent(questionId)}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ qcStatus }),
        }),
  bulkUpdateQuestionStatus: (questionIds: string[], qcStatus: QuestionItem['qcStatus']) =>
    clientFirestoreMode
      ? fsClient.bulkUpdateQuestionStatus(questionIds, qcStatus)
      : Promise.all(
          questionIds.map((qid) =>
            request<{ ok: boolean }>(`/api/admin/questions/${encodeURIComponent(qid)}/status`, {
              method: 'PATCH',
              body: JSON.stringify({ qcStatus }),
            })
          )
        ).then(() => ({ ok: true, updatedCount: questionIds.length })),
  deleteQuestions: (questionIds: string[]) =>
    clientFirestoreMode
      ? fsClient.deleteQuestions(questionIds)
      : request<{ ok: boolean; deletedCount: number }>('/api/admin/questions/delete', {
          method: 'POST',
          body: JSON.stringify({ questionIds }),
        }),
  recalibrateDailyPlan: (configOverride?: LearningConfig) =>
    clientFirestoreMode
      ? fsClient.recalibrateDailyPlan(configOverride)
      : request<{ plan: DailyFocusPlan; error?: string }>('/api/ai/daily-focus', {
          method: 'POST',
          body: JSON.stringify({ config: configOverride }),
        }),
  getProgressCounts: () =>
    clientFirestoreMode
      ? fsClient.getProgressCounts()
      : Promise.resolve({
          sessionsCount: 0,
          attemptsCount: 0,
          evidenceCount: 0,
          writingCount: 0,
          bankQuestionsCount: 0,
        }),
  resetStudentProgress: () =>
    clientFirestoreMode
      ? fsClient.resetStudentProgress()
      : Promise.reject(new Error('Progress reset is only enabled in Firestore client mode.')),
  attachQuestionVisual: (
    questionId: string,
    payload: { altText: string; caption?: string; imageBase64?: string; filename?: string; visual?: VisualSpec }
  ) =>
    clientFirestoreMode
      ? fsClient.attachQuestionVisual(questionId, payload)
      : request<{ ok: boolean; visual: VisualSpec; qcStatus?: QuestionItem['qcStatus'] }>(
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
    clientFirestoreMode
      ? fsClient.getMediaMigrationManifest()
      : request<{ manifest: MediaMigrationManifest }>('/api/admin/media/migration-manifest'),
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
    clientFirestoreMode
      ? fsClient.createCalibrationSession(payload)
      : request<{ sessionId: string; count: number; session: SessionRecord }>(
          '/api/admin/calibration/session',
          {
            method: 'POST',
            body: JSON.stringify(payload),
          }
        ),
  getCalibrationInspector: (sessionId: string) =>
    clientFirestoreMode
      ? fsClient.getCalibrationInspector(sessionId)
      : request<{ inspectorByQuestionId: Record<string, QuestionItem> }>(
          `/api/admin/calibration/session/${encodeURIComponent(sessionId)}`
        ),
  dryRunManifest: (manifest: unknown) =>
    clientFirestoreMode
      ? fsClient.dryRunManifest(manifest)
      : request<{
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
    clientFirestoreMode
      ? fsClient.commitManifest(manifest)
      : request<{
          ok: boolean;
          result: { imported: number; skipped: number; versionBumped: number };
          batch?: ImportBatchRecord;
        }>('/api/admin/import/commit', {
          method: 'POST',
          body: JSON.stringify({ manifest }),
        }),
  getImportSchema: () =>
    clientFirestoreMode
      ? fsClient.getImportSchema()
      : request<{ schema: unknown; starterExample: unknown }>('/api/admin/import/schema'),
  getAdminConfig: () =>
    clientFirestoreMode
      ? fsClient.getAdminConfig()
      : request<{
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
    clientFirestoreMode
      ? fsClient.saveAdminConfig(config, notes)
      : request<{
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
    clientFirestoreMode
      ? fsClient.getAdminFlags()
      : request<{ flags: QuestionFlagRecord[] }>('/api/admin/flags'),
  resolveFlag: (flagId: string) =>
    clientFirestoreMode
      ? fsClient.resolveFlag(flagId)
      : request<{ ok: boolean }>(`/api/admin/flags/${encodeURIComponent(flagId)}/resolve`, {
          method: 'POST',
        }),
  restoreBackup: (backup: unknown, dryRun = true) =>
    clientFirestoreMode
      ? fsClient.restoreBackup(backup, dryRun)
      : request<{ ok: boolean; report: RestoreReport }>('/api/admin/restore', {
          method: 'POST',
          body: JSON.stringify({ backup, dryRun }),
        }),
  getMigrationPreflight: () =>
    clientFirestoreMode
      ? fsClient.getMigrationPreflight()
      : request<{ report: MigrationPreflightReport }>('/api/admin/migrate/preflight'),
  applyMigration: (payload: unknown, dryRun = true, studentId?: string) =>
    request<{ ok: boolean; mode: string; report?: RestoreReport; counts?: Record<string, number> }>(
      '/api/admin/migrate/apply',
      {
        method: 'POST',
        body: JSON.stringify({ payload, dryRun, studentId }),
      }
    ),
};
