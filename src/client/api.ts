import type {
  AdminLearnerSummary,
  AutoCalibrateConfig,
  BankImportManifest,
  BankMasterySummary,
  BenchmarkReportRecord,
  DailyFocusPlan,
  ImportBatchRecord,
  LearnerPreferences,
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
  adminOverrideLocked?: boolean;
  onboardingCompleted?: boolean;
  shouldShowOnboarding?: boolean;
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
    /** Title of the prompt this essay answered, when the bank still has it. */
    promptTitle?: string;
  }[];
  totalAttempts: number;
  masterySummary: BankMasterySummary;
  benchmarkReports?: BenchmarkReportRecord[];
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

export interface AccountDeleteResponse extends ProgressResetResponse {
  deletedUser: boolean;
  clearedFlags: number;
  studentId?: string;
  authMethod?: 'google' | 'local_pin' | 'local_admin';
  isLocalPinAccount?: boolean;
}

export interface LearnerDailySettingsView {
  autoCalibrate: AutoCalibrateConfig;
  dailyQuestionLimitBySection: Record<SectionCode, number>;
  dailyGoalMinutes: number;
  sectionDrillQuestionCount: number;
  sectionDrillTimeMinutes: number;
}

export interface StudentSettingsResponse {
  studentId: string;
  role: 'student' | 'admin';
  email?: string;
  authMethod?: 'google' | 'local_pin' | 'local_admin';
  isLocalPinAccount?: boolean;
  effectiveConfig: LearnerDailySettingsView;
  globalDefaults: LearnerDailySettingsView;
  preferences: LearnerPreferences | null;
  adminOverrideLocked: boolean;
  dailyFocusPlan: DailyFocusPlan | null;
  progressCounts: ProgressCountsResponse | null;
  flags: QuestionFlagRecord[];
  onboardingCompleted: boolean;
}

export interface AdminLearnerPreferencesResponse {
  studentId: string;
  preferences: LearnerPreferences | null;
  effectiveConfig: LearnerDailySettingsView;
  globalDefaults: LearnerDailySettingsView;
  adminOverrideLocked: boolean;
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
  /** Machine-readable reason some endpoints add (e.g. `repair_pool_empty`). */
  code?: string;
  retryAfterSeconds?: number;
  activeSessionId?: string;
  currentRevision?: number;
  serverCheckpoint?: SessionRecord['checkpoint'];
  expiredAutoSubmitted?: boolean;
  alreadySubmitted?: boolean;
  sectionExpired?: boolean;
  sectionPhase?: string;
  session?: SessionRecord;
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
      setApiCacheScope(null);
      window.dispatchEvent(new CustomEvent('nsw-auth-expired'));
    }
    const payload = data as {
      error?: string;
      code?: string;
      retryAfterSeconds?: number;
      activeSessionId?: string;
      currentRevision?: number;
      serverCheckpoint?: SessionRecord['checkpoint'];
      expiredAutoSubmitted?: boolean;
      alreadySubmitted?: boolean;
      sectionExpired?: boolean;
      sectionPhase?: string;
      session?: SessionRecord;
    };
    const err = new Error(payload?.error || `Request failed (${res.status})`) as ApiError;
    err.status = res.status;
    if (typeof payload?.code === 'string') err.code = payload.code;
    if (typeof payload?.retryAfterSeconds === 'number') err.retryAfterSeconds = payload.retryAfterSeconds;
    if (payload?.activeSessionId) err.activeSessionId = payload.activeSessionId;
    if (typeof payload?.currentRevision === 'number') err.currentRevision = payload.currentRevision;
    if (payload?.serverCheckpoint) err.serverCheckpoint = payload.serverCheckpoint;
    if (typeof payload?.expiredAutoSubmitted === 'boolean') {
      err.expiredAutoSubmitted = payload.expiredAutoSubmitted;
    }
    if (typeof payload?.alreadySubmitted === 'boolean') {
      err.alreadySubmitted = payload.alreadySubmitted;
    }
    if (typeof payload?.sectionExpired === 'boolean') {
      err.sectionExpired = payload.sectionExpired;
    }
    if (typeof payload?.sectionPhase === 'string') {
      err.sectionPhase = payload.sectionPhase;
    }
    if (payload?.session) {
      err.session = payload.session;
    }
    throw err;
  }
  return data as T;
}

// ---------------------------------------------------------------------------
// Stale-while-revalidate cache for the student tab views
// (Dashboard, Benchmarks, Progress, Settings). Entries are scoped to the signed-in
// account so switching accounts never renders another learner's data.
// ---------------------------------------------------------------------------

export type CachedResourceKey = 'dashboard' | 'benchmarks' | 'progress' | 'settings';

export interface CachedResourceMap {
  dashboard: DashboardResponse;
  benchmarks: BenchmarkHubResponse;
  progress: ProgressResponse;
  settings: StudentSettingsResponse;
}

const CACHED_RESOURCE_URLS: Record<CachedResourceKey, string> = {
  dashboard: '/api/student/dashboard',
  benchmarks: '/api/student/benchmarks',
  progress: '/api/student/progress',
  settings: '/api/student/settings',
};

const ALL_CACHED_KEYS = Object.keys(CACHED_RESOURCE_URLS) as CachedResourceKey[];

/** Fresh window: reads inside it reuse the cached copy without a background refetch. */
export const API_CACHE_FRESH_MS = 15_000;
/** Max age a cached copy may still be painted while it revalidates. */
export const API_CACHE_MAX_STALE_MS = 10 * 60_000;

interface CacheEntry {
  data?: unknown;
  fetchedAtMs: number;
  inFlight?: Promise<unknown>;
  /** Bumped on invalidation so a response that started earlier is never written back. */
  generation: number;
}

const apiCache = new Map<CachedResourceKey, CacheEntry>();
let apiCacheScope: string | null = null;
let apiCacheEpoch = 0;
const cacheListeners = new Set<(key: CachedResourceKey) => void>();

function cacheEntry(key: CachedResourceKey): CacheEntry {
  let entry = apiCache.get(key);
  if (!entry) {
    entry = { fetchedAtMs: 0, generation: 0 };
    apiCache.set(key, entry);
  }
  return entry;
}

function notifyCache(key: CachedResourceKey): void {
  for (const listener of cacheListeners) listener(key);
}

/** Drop every cached response and in-flight dedupe (tests, sign-in/out, account delete). */
export function clearApiCache(): void {
  apiCacheEpoch++;
  apiCache.clear();
  for (const key of ALL_CACHED_KEYS) notifyCache(key);
}

/**
 * Bind the cache to one account. A different (or null) scope wipes everything first,
 * so a new learner can never see the previous learner's cached dashboard.
 */
export function setApiCacheScope(scope: string | null): void {
  if (scope === apiCacheScope) return;
  clearApiCache();
  apiCacheScope = scope;
}

export function getApiCacheScope(): string | null {
  return apiCacheScope;
}

/** Forget cached responses after a mutation; the next read fetches fresh data. */
export function invalidateApiCache(keys: readonly CachedResourceKey[] = ALL_CACHED_KEYS): void {
  for (const key of keys) {
    const entry = apiCache.get(key);
    if (!entry) continue;
    entry.generation++;
    entry.data = undefined;
    entry.fetchedAtMs = 0;
    entry.inFlight = undefined;
    notifyCache(key);
  }
}

/**
 * Apply a mutation's known result to a cached copy in place (keeps its age) so the
 * next visit paints the updated data instantly. Older in-flight responses are discarded.
 */
export function patchCachedResource<K extends CachedResourceKey>(
  key: K,
  update: (current: CachedResourceMap[K]) => CachedResourceMap[K]
): void {
  const entry = apiCache.get(key);
  if (!entry || entry.data === undefined) return;
  entry.generation++;
  entry.inFlight = undefined;
  entry.data = update(entry.data as CachedResourceMap[K]);
  notifyCache(key);
}

/** Synchronous read for first paint: returns a cached copy younger than the stale limit. */
export function peekCachedResource<K extends CachedResourceKey>(
  key: K,
  nowMs = Date.now()
): CachedResourceMap[K] | undefined {
  const entry = apiCache.get(key);
  if (!entry || entry.data === undefined) return undefined;
  if (nowMs - entry.fetchedAtMs > API_CACHE_MAX_STALE_MS) return undefined;
  return entry.data as CachedResourceMap[K];
}

/** True when a cached copy exists and is still inside the fresh window. */
export function isCachedResourceFresh(key: CachedResourceKey, nowMs = Date.now()): boolean {
  const entry = apiCache.get(key);
  return Boolean(entry && entry.data !== undefined && nowMs - entry.fetchedAtMs <= API_CACHE_FRESH_MS);
}

/** Subscribe to cache writes/invalidations (used by the SWR hook). */
export function subscribeApiCache(listener: (key: CachedResourceKey) => void): () => void {
  cacheListeners.add(listener);
  return () => {
    cacheListeners.delete(listener);
  };
}

/**
 * Fetch a cached resource, deduplicating concurrent callers.
 * `force` skips the fresh window but still joins an in-flight request.
 */
export function fetchCachedResource<K extends CachedResourceKey>(
  key: K,
  options: { force?: boolean } = {}
): Promise<CachedResourceMap[K]> {
  const entry = cacheEntry(key);
  if (entry.inFlight) return entry.inFlight as Promise<CachedResourceMap[K]>;
  if (!options.force && isCachedResourceFresh(key)) {
    return Promise.resolve(entry.data as CachedResourceMap[K]);
  }
  const generation = entry.generation;
  const epoch = apiCacheEpoch;
  const promise = request<CachedResourceMap[K]>(CACHED_RESOURCE_URLS[key]).then(
    (data) => {
      const current = apiCache.get(key);
      if (epoch === apiCacheEpoch && current && current.generation === generation) {
        current.data = data;
        current.fetchedAtMs = Date.now();
        current.inFlight = undefined;
        notifyCache(key);
      }
      return data;
    },
    (err: unknown) => {
      const current = apiCache.get(key);
      if (current && current.inFlight === promise) current.inFlight = undefined;
      throw err;
    }
  );
  entry.inFlight = promise;
  return promise;
}

/** Warm a tab's data on hover/focus; skips work when a fresh copy or request already exists. */
export function prefetchCachedResource(key: CachedResourceKey): void {
  if (!apiCacheScope) return;
  void fetchCachedResource(key).catch(() => undefined);
}

/** Run a mutation and, once it settles, drop the cached views it can change. */
function invalidating<T>(promise: Promise<T>, keys?: readonly CachedResourceKey[]): Promise<T> {
  return promise.finally(() => invalidateApiCache(keys));
}

function rescoping(promise: Promise<AuthState>): Promise<AuthState> {
  return promise.then((identity) => {
    setApiCacheScope(identity.authenticated ? identity.studentId : null);
    return identity;
  });
}

const SESSION_KEYS: readonly CachedResourceKey[] = ALL_CACHED_KEYS;
const SETTINGS_KEYS: readonly CachedResourceKey[] = ['settings', 'dashboard'];

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
  getMe: () => rescoping(request<AuthState>('/api/auth/me')),
  getGoogleConfig: () => request<{ clientId: string; nonce: string | null }>('/api/auth/google-config'),
  studentLogin: (pin: string) =>
    rescoping(
      request<AuthState>('/api/auth/student-login', {
        method: 'POST',
        body: JSON.stringify({ pin }),
      })
    ),
  adminLogin: (password: string) =>
    rescoping(
      request<AuthState>('/api/auth/admin-login', {
        method: 'POST',
        body: JSON.stringify({ password }),
      })
    ),
  googleLogin: (credential: string, admin: boolean) =>
    rescoping(
      request<AuthState>('/api/auth/google-login', {
        method: 'POST',
        body: JSON.stringify({ credential, admin }),
      })
    ),
  logout: () =>
    request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }).finally(() => setApiCacheScope(null)),
  downloadFile,

  /** Cached (SWR) — pass `{ force: true }` to skip the fresh window. */
  getDashboard: (options?: { force?: boolean }) => fetchCachedResource('dashboard', options),
  getBenchmarks: (options?: { force?: boolean }) => fetchCachedResource('benchmarks', options),
  getBenchmarkReport: (sessionId: string) =>
    request<{ report: BenchmarkReportRecord }>(`/api/student/benchmarks/${encodeURIComponent(sessionId)}`),
  analyzeBenchmarkReport: (sessionId: string, force = false) =>
    request<{ report: BenchmarkReportRecord }>(
      `/api/student/benchmarks/${encodeURIComponent(sessionId)}/analyze`,
      {
        method: 'POST',
        body: JSON.stringify({ force }),
      }
    ).then((res) => {
      patchCachedResource('benchmarks', (hub) => ({
        ...hub,
        reports: hub.reports.map((r) => (r.sessionId === sessionId ? res.report : r)),
      }));
      invalidateApiCache(['progress']);
      return res;
    }),
  createSession: (payload: {
    mode: SessionMode;
    sectionFilter?: SectionCode;
    mockBatch?: MockTestBatch;
    mockSource?: 'pool' | 'batch';
    batchId?: string;
    questionCount?: number;
    timeMultiplier?: number;
    customTimeLimitSec?: number;
    /** `repair_drill` only: limit the drill to these missed questions. */
    questionIds?: string[];
  }) =>
    invalidating(request<{ sessionId: string; session: SessionRecord; serverNowIso?: string }>(
      '/api/student/sessions',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ), SESSION_KEYS),
  getSession: (id: string) =>
    request<SessionDetailResponse>(`/api/student/sessions/${encodeURIComponent(id)}`),
  saveCheckpoint: (
    id: string,
    checkpoint: NonNullable<SessionRecord['checkpoint']>,
    expectedRevision?: number
  ) =>
    invalidating(request<{
      ok: boolean;
      checkpointRevision: number;
      revision?: number;
      savedAtIso?: string;
      serverNowIso?: string;
    }>(`/api/student/sessions/${encodeURIComponent(id)}/checkpoint`, {
      method: 'PATCH',
      body: JSON.stringify({ checkpoint, expectedRevision }),
    }), ['dashboard', 'progress']),
  submitSession: (
    id: string,
    checkpoint?: SessionRecord['checkpoint'],
    assisted?: boolean,
    expectedRevision?: number
  ) =>
    invalidating(request<SessionSubmissionPayload & { alreadySubmitted?: boolean }>(
      `/api/student/sessions/${encodeURIComponent(id)}/submit`,
      {
        method: 'POST',
        body: JSON.stringify({ checkpoint, assisted, expectedRevision }),
      }
    ), SESSION_KEYS),
  completeSessionSection: (
    id: string,
    checkpoint?: SessionRecord['checkpoint'],
    expectedRevision?: number
  ) =>
    invalidating(request<
      | ({ finishedExam: true; alreadySubmitted?: boolean; expiredAutoSubmitted?: boolean; session: SessionRecord } & SessionSubmissionPayload)
      | { finishedExam: false; session: SessionRecord; serverNowIso?: string }
    >(`/api/student/sessions/${encodeURIComponent(id)}/section/complete`, {
      method: 'POST',
      body: JSON.stringify({ checkpoint, expectedRevision }),
    }), SESSION_KEYS),
  startSessionSection: (id: string, expectedRevision?: number) =>
    invalidating(request<{ session: SessionRecord; serverNowIso?: string }>(
      `/api/student/sessions/${encodeURIComponent(id)}/section/start`,
      {
        method: 'POST',
        body: JSON.stringify({ expectedRevision }),
      }
    ), ['dashboard', 'progress']),
  evaluateWriting: (submissionId: string) =>
    invalidating(request<{ evaluation: WritingEvaluationRecord; evaluations?: WritingEvaluationRecord[] }>(
      `/api/student/writing/${encodeURIComponent(submissionId)}/evaluate`,
      { method: 'POST' }
    ), ['progress']),
  flagQuestion: (payload: { questionId: string; sessionId: string; reason: string; notes?: string }) =>
    invalidating(request<{ flag: QuestionFlagRecord }>('/api/student/flags', {
      method: 'POST',
      body: JSON.stringify(payload),
    }), ['settings']),
  /** Withdraws the caller's own open flag (404 missing/not theirs, 409 already reviewed). */
  withdrawStudentFlag: (flagId: string) =>
    invalidating(
      request<{ ok: boolean; flagId: string }>(`/api/student/flags/${encodeURIComponent(flagId)}`, {
        method: 'DELETE',
      }),
      ['settings']
    ),
  getProgress: (options?: { force?: boolean }) => fetchCachedResource('progress', options),
  getStudentSettings: (options?: { force?: boolean }) => fetchCachedResource('settings', options),
  saveStudentDailyPlan: (payload: {
    autoCalibrate?: AutoCalibrateConfig;
    dailyQuestionLimitBySection?: Record<SectionCode, number>;
    dailyGoalMinutes?: number;
    sectionDrillQuestionCount?: number;
    sectionDrillTimeMinutes?: number;
    resetToDefaults?: boolean;
  }) =>
    invalidating(
      request<{
        ok: boolean;
        preferences: LearnerPreferences;
        effectiveConfig: LearnerDailySettingsView;
        adminOverrideLocked: boolean;
      }>('/api/student/settings/daily-plan', {
        method: 'PUT',
        body: JSON.stringify(payload),
      }).then((res) => {
        patchCachedResource('settings', (current) => ({
          ...current,
          preferences: res.preferences,
          effectiveConfig: res.effectiveConfig,
          adminOverrideLocked: res.adminOverrideLocked,
        }));
        return res;
      }),
      ['dashboard']
    ),
  recalibrateStudentDailyPlan: (payload?: { autoCalibrate?: AutoCalibrateConfig }) =>
    invalidating(
      request<{
        plan: DailyFocusPlan;
        studentId?: string;
        effectiveConfig: LearnerDailySettingsView;
      }>('/api/student/settings/recalibrate', {
        method: 'POST',
        body: JSON.stringify(payload || {}),
      }).then((res) => {
        patchCachedResource('settings', (current) => ({
          ...current,
          dailyFocusPlan: res.plan ?? current.dailyFocusPlan,
          effectiveConfig: res.effectiveConfig ?? current.effectiveConfig,
        }));
        return res;
      }),
      ['dashboard']
    ),
  setOnboardingStatus: (completed: boolean) =>
    request<{
      ok: boolean;
      onboardingCompleted: boolean;
      onboardingCompletedAtIso: string | null;
    }>('/api/student/settings/onboarding', {
      method: 'POST',
      body: JSON.stringify({ completed }),
    }).then((res) => {
      patchCachedResource('settings', (current) => ({ ...current, onboardingCompleted: res.onboardingCompleted }));
      patchCachedResource('dashboard', (current) => ({
        ...current,
        onboardingCompleted: res.onboardingCompleted,
        shouldShowOnboarding: res.onboardingCompleted ? false : current.shouldShowOnboarding,
      }));
      return res;
    }),
  getOwnProgressCounts: () =>
    request<ProgressCountsResponse & { studentId?: string }>('/api/student/study-progress'),
  resetOwnStudyProgress: (confirmation = 'RESET') =>
    invalidating(request<ProgressResetResponse & { studentId?: string }>('/api/student/study-progress/reset', {
      method: 'POST',
      body: JSON.stringify({ confirmation }),
    })),
  getOwnFlags: () =>
    request<{ flags: QuestionFlagRecord[] }>('/api/student/flags'),
  deleteOwnAccount: (confirmation = 'DELETE') =>
    request<AccountDeleteResponse>('/api/student/account', {
      method: 'DELETE',
      body: JSON.stringify({ confirmation }),
    }).then((res) => {
      setApiCacheScope(null);
      return res;
    }),

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
    invalidating(request<{ ok: boolean; primaryMonitoredStudentId: string | null }>('/api/admin/learners/primary', {
      method: 'POST',
      body: JSON.stringify({ studentId }),
    })),
  deleteAdminLearner: (studentId: string, confirmation = 'DELETE') =>
    invalidating(request<AccountDeleteResponse>(`/api/admin/learners/${encodeURIComponent(studentId)}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirmation }),
    })),
  getAdminDailyPlan: (studentId?: string) => {
    const suffix = studentId ? `?studentId=${encodeURIComponent(studentId)}` : '';
    return request<{ studentId: string | null; plan: DailyFocusPlan | null }>(`/api/admin/daily-plan${suffix}`);
  },
  getAdminLearnerPreferences: (studentId: string) =>
    request<AdminLearnerPreferencesResponse>(
      `/api/admin/learners/${encodeURIComponent(studentId)}/preferences`
    ),
  saveAdminLearnerPreferences: (
    studentId: string,
    payload: {
      autoCalibrate?: AutoCalibrateConfig;
      dailyQuestionLimitBySection?: Record<SectionCode, number>;
      dailyGoalMinutes?: number;
      sectionDrillQuestionCount?: number;
      sectionDrillTimeMinutes?: number;
      adminOverrideLocked?: boolean;
      resetToDefaults?: boolean;
    }
  ) =>
    invalidating(request<{
      ok: boolean;
      studentId: string;
      preferences: LearnerPreferences;
      effectiveConfig: LearnerDailySettingsView;
      adminOverrideLocked: boolean;
    }>(`/api/admin/learners/${encodeURIComponent(studentId)}/preferences`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }), SETTINGS_KEYS),
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
    invalidating(request<{ ok: boolean }>(`/api/admin/questions/${encodeURIComponent(questionId)}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ qcStatus }),
    }), ['dashboard', 'benchmarks']),
  bulkUpdateQuestionStatus: (questionIds: string[], qcStatus: QuestionItem['qcStatus']) =>
    invalidating(request<{ ok: boolean; updatedCount: number }>('/api/admin/questions/bulk-status', {
      method: 'POST',
      body: JSON.stringify({ questionIds, qcStatus }),
    }), ['dashboard', 'benchmarks']),
  deleteQuestions: (questionIds: string[]) =>
    invalidating(request<{ ok: boolean; deletedCount: number }>('/api/admin/questions/delete', {
      method: 'POST',
      body: JSON.stringify({ questionIds }),
    })),
  recalibrateDailyPlan: (configOverride?: LearningConfig, studentId?: string) =>
    invalidating(request<{ plan: DailyFocusPlan; studentId?: string; error?: string }>('/api/admin/recalibrate-daily-plan', {
      method: 'POST',
      body: JSON.stringify({ config: configOverride, studentId }),
    }), SETTINGS_KEYS),
  getProgressCounts: (studentId?: string) => {
    const suffix = studentId ? `?studentId=${encodeURIComponent(studentId)}` : '';
    return request<ProgressCountsResponse & { studentId?: string }>(`/api/admin/study-progress${suffix}`);
  },
  resetStudentProgress: (studentId?: string) =>
    invalidating(request<ProgressResetResponse & { studentId?: string }>('/api/admin/study-progress/reset', {
      method: 'POST',
      body: JSON.stringify({ studentId }),
    })),
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
    invalidating(request<{ sessionId: string; count: number; session: SessionRecord }>(
      '/api/admin/calibration/session',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ), ['dashboard']),
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
    invalidating(request<{
      ok: boolean;
      result: { imported: number; skipped: number; versionBumped: number };
      batch?: ImportBatchRecord;
    }>('/api/admin/import/commit', {
      method: 'POST',
      body: JSON.stringify({ manifest }),
    })),
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
    invalidating(request<{
      ok: boolean;
      configVersionId: string;
      versionNumber: number;
      config?: LearningConfig;
      notes?: string;
      createdAtIso?: string;
    }>('/api/admin/config', {
      method: 'POST',
      body: JSON.stringify({ config, notes }),
    })),
  getAdminFlags: () =>
    request<{ flags: QuestionFlagRecord[] }>('/api/admin/flags'),
  resolveFlag: (flagId: string) =>
    invalidating(request<{ ok: boolean }>(`/api/admin/flags/${encodeURIComponent(flagId)}/resolve`, {
      method: 'POST',
    }), ['settings']),
  restoreBackup: (backup: unknown, dryRun = true) =>
    invalidating(request<{ ok: boolean; report: RestoreReport }>('/api/admin/restore', {
      method: 'POST',
      body: JSON.stringify({ backup, dryRun }),
    })),
  getMigrationPreflight: () =>
    request<{ report: MigrationPreflightReport }>('/api/admin/migrate/preflight'),
  applyMigration: (payload: unknown, dryRun = true, studentId?: string) =>
    invalidating(request<{ ok: boolean; mode: string; report?: RestoreReport; counts?: Record<string, number> }>(
      '/api/admin/migrate/apply',
      {
        method: 'POST',
        body: JSON.stringify({ payload, dryRun, studentId }),
      }
    )),
};
