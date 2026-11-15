import type {
  BankImportManifest,
  LearningConfig,
  MarkingResult,
  MockTestBatch,
  PartAttemptRecord,
  QuestionFlagRecord,
  QuestionItem,
  QuestionMemoryState,
  SectionCode,
  SessionMode,
  SessionRecord,
  SkillState,
  StimulusGroup,
  StudentQuestionView,
  VisualSpec,
  WritingDeterministicMetrics,
  WritingEvaluationRecord,
} from '../shared/contracts';
import {
  pushConfigVersionToFirestore,
  pushFlagToFirestore,
  pushManifestToFirestore,
  pushQuestionOverrideToFirestore,
  pushSessionCheckpointToFirestore,
  pushSessionCreateToFirestore,
  pushSubmissionToFirestore,
  pushWritingEvaluationsToFirestore,
  resolveFlagInFirestore,
  type SyncHydratePayload,
} from './firestoreSync';

export interface AuthState {
  authenticated: boolean;
  role: 'student' | 'admin' | null;
  studentId: string | null;
  activeSessionId?: string | null;
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
  batchCounts: Record<MockTestBatch, Record<SectionCode, number>>;
  activeSession: SessionRecord | null;
  recentSessions: SessionRecord[];
}

export interface SessionDetailResponse {
  session: SessionRecord;
  questions: StudentQuestionView[];
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
}

const TOKEN_STORAGE_KEY = 'selective_lab_auth_token';
let memoryToken: string | null = null;

function getStoredToken(): string | null {
  if (memoryToken) return memoryToken;
  try {
    const val = window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (val) {
      memoryToken = val;
      return val;
    }
  } catch {
    // ignore storage errors in restricted iframes
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
    // ignore storage errors in restricted iframes
  }
}

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
    const payload = data as { error?: string; activeSessionId?: string };
    const err = new Error(payload?.error || `Request failed (${res.status})`) as Error & {
      activeSessionId?: string;
    };
    if (payload?.activeSessionId) {
      err.activeSessionId = payload.activeSessionId;
    }
    throw err;
  }
  return data as T;
}

async function downloadFile(url: string, fallbackFilename: string): Promise<void> {
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
  getMe: () => request<AuthState>('/api/auth/me'),
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
    return res;
  },
  hydrateSync: (payload: SyncHydratePayload) =>
    request<{ ok: boolean; activeSessionId: string | null }>('/api/sync/hydrate', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  logout: async () => {
    setStoredToken(null);
    return request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
  },
  downloadFile,

  getDashboard: () => request<DashboardResponse>('/api/student/dashboard'),
  createSession: async (payload: {
    mode: SessionMode;
    sectionFilter?: SectionCode;
    mockBatch?: MockTestBatch;
    timeMultiplier?: number;
    customTimeLimitSec?: number;
  }) => {
    const res = await request<{ sessionId: string; session: SessionRecord }>('/api/student/sessions', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    await pushSessionCreateToFirestore(res.session).catch(() => undefined);
    return res;
  },
  getSession: (id: string) => request<SessionDetailResponse>(`/api/student/sessions/${encodeURIComponent(id)}`),
  saveCheckpoint: async (id: string, checkpoint: NonNullable<SessionRecord['checkpoint']>) => {
    const res = await request<{ ok: boolean }>(`/api/student/sessions/${encodeURIComponent(id)}/checkpoint`, {
      method: 'PATCH',
      body: JSON.stringify({ checkpoint }),
    });
    await pushSessionCheckpointToFirestore(id, checkpoint).catch(() => undefined);
    return res;
  },
  submitSession: async (id: string, checkpoint?: SessionRecord['checkpoint']) => {
    const res = await request<{
      ok: boolean;
      correctSlots: number;
      totalSlots: number;
      completedAt: string;
      checkpoint: NonNullable<SessionRecord['checkpoint']>;
      attempts?: PartAttemptRecord[];
      skillStates?: SkillState[];
      questionMemory?: QuestionMemoryState[];
      writingSubmission?: {
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
      };
      reviewResults: Record<string, MarkingResult[]>;
      writingReview: SessionDetailResponse['writingReview'];
    }>(`/api/student/sessions/${encodeURIComponent(id)}/submit`, {
      method: 'POST',
      body: JSON.stringify({ checkpoint }),
    });
    await pushSubmissionToFirestore({
      sessionId: id,
      checkpoint: res.checkpoint,
      correctSlots: res.correctSlots,
      totalSlots: res.totalSlots,
      completedAt: res.completedAt,
      attempts: res.attempts,
      skillStates: res.skillStates,
      questionMemory: res.questionMemory,
      writingSubmission: res.writingSubmission,
    }).catch(() => undefined);
    return res;
  },
  evaluateWriting: async (submissionId: string) => {
    const res = await request<{ evaluation: WritingEvaluationRecord; evaluations?: WritingEvaluationRecord[] }>(
      `/api/student/writing/${encodeURIComponent(submissionId)}/evaluate`,
      { method: 'POST' }
    );
    await pushWritingEvaluationsToFirestore(
      submissionId,
      res.evaluations || [res.evaluation]
    ).catch(() => undefined);
    return res;
  },
  flagQuestion: async (payload: { questionId: string; sessionId: string; reason: string; notes?: string }) => {
    const res = await request<{ flag: QuestionFlagRecord }>('/api/student/flags', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    await pushFlagToFirestore(res.flag).catch(() => undefined);
    return res;
  },
  getProgress: () => request<ProgressResponse>('/api/student/progress'),

  // Admin APIs
  getAdminStatus: () => request<AdminStatusResponse>('/api/admin/status'),
  getAdminQuestions: (params?: { section?: string; poolType?: string; qcStatus?: string }) => {
    const qs = new URLSearchParams();
    if (params?.section) qs.set('section', params.section);
    if (params?.poolType) qs.set('poolType', params.poolType);
    if (params?.qcStatus) qs.set('qcStatus', params.qcStatus);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<{ questions: QuestionItem[]; stimuliById: Record<string, StimulusGroup> }>(
      `/api/admin/questions${suffix}`
    );
  },
  updateQuestionStatus: async (questionId: string, qcStatus: QuestionItem['qcStatus']) => {
    const res = await request<{ ok: boolean }>(`/api/admin/questions/${encodeURIComponent(questionId)}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ qcStatus }),
    });
    await pushQuestionOverrideToFirestore(questionId, qcStatus).catch(() => undefined);
    return res;
  },
  attachQuestionVisual: async (
    questionId: string,
    payload: { altText: string; caption?: string; imageBase64?: string; filename?: string; visual?: VisualSpec }
  ) => {
    const res = await request<{ ok: boolean; visual: VisualSpec; qcStatus?: QuestionItem['qcStatus'] }>(
      `/api/admin/questions/${encodeURIComponent(questionId)}/visual`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );
    await pushQuestionOverrideToFirestore(
      questionId,
      res.qcStatus || 'active',
      res.visual
    ).catch(() => undefined);
    return res;
  },
  createCalibrationSession: async (payload: {
    section?: string;
    poolType?: string;
    qcStatus?: string;
    formatType?: string;
    skillFamily?: string;
    skillId?: string;
    batch?: string;
    limit?: number;
    customTimeLimitSec?: number;
    isSandbox?: boolean;
  }) => {
    const res = await request<{ sessionId: string; count: number; session: SessionRecord }>(
      '/api/admin/calibration/session',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );
    await pushSessionCreateToFirestore(res.session).catch(() => undefined);
    return res;
  },
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
  commitManifest: async (manifest: BankImportManifest) => {
    const res = await request<{
      ok: boolean;
      result: { imported: number; skipped: number; versionBumped: number };
      manifest?: BankImportManifest;
    }>('/api/admin/import/commit', {
      method: 'POST',
      body: JSON.stringify({ manifest }),
    });
    await pushManifestToFirestore(res.manifest || manifest).catch(() => undefined);
    return res;
  },
  getImportSchema: () =>
    request<{ schema: unknown; starterExample: unknown }>('/api/admin/import/schema'),
  getAdminConfig: () =>
    request<{
      active: { configVersionId: string; versionNumber: number; config: LearningConfig };
      history: { configVersionId: string; versionNumber: number; notes?: string; createdAt: string; config: LearningConfig }[];
    }>('/api/admin/config'),
  saveAdminConfig: async (config: LearningConfig, notes?: string) => {
    const res = await request<{
      ok: boolean;
      configVersionId: string;
      versionNumber: number;
      config?: LearningConfig;
      notes?: string;
      createdAtIso?: string;
    }>('/api/admin/config', {
      method: 'POST',
      body: JSON.stringify({ config, notes }),
    });
    await pushConfigVersionToFirestore({
      configVersionId: res.configVersionId,
      versionNumber: res.versionNumber,
      notes: res.notes ?? notes,
      config: res.config || config,
      createdAtIso: res.createdAtIso || new Date().toISOString(),
    }).catch(() => undefined);
    return res;
  },
  getAdminFlags: () => request<{ flags: QuestionFlagRecord[] }>('/api/admin/flags'),
  resolveFlag: async (flagId: string) => {
    const res = await request<{ ok: boolean }>(`/api/admin/flags/${encodeURIComponent(flagId)}/resolve`, {
      method: 'POST',
    });
    await resolveFlagInFirestore(flagId).catch(() => undefined);
    return res;
  },
};
