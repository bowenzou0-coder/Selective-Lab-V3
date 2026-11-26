import type {
  BankImportManifest,
  LearnerAccountRecord,
  LearningConfig,
  WritingEvaluationRecord,
} from '../shared/contracts.ts';
import { V3_STARTER_MANIFEST_EXAMPLE } from '../shared/v3Schema.ts';
import { getTokenIssuedAtMs, type UserIdentity } from './auth.ts';
import { clearDailyFocusInFlight } from './geminiPlanner.ts';
import { createAiRateLimiter, type SlidingWindowRateLimiter } from './rateLimit.ts';
import type { AccountDeleteResponse, AppRepository } from './storage/repository.ts';

const AUTH_REVOCATION_TTL_MS = 31 * 24 * 60 * 60 * 1000;

/** Shared per-app state handed to every route module. */
export interface AppContext {
  repo: AppRepository;
  backendName: AppRepository['backendName'];
  /** Seeds the minimal in-memory starter pack when running the disposable demo backend. */
  ensureSeeded(): Promise<void>;
  inFlightWritingEvaluations: Map<string, Promise<WritingEvaluationRecord>>;
  inFlightWritingOwners: Map<string, string>;
  aiRateLimiter: SlidingWindowRateLimiter;
  /** Immediately revoke any previously signed auth cookies for a deleted learner. */
  revokeStudentAuth(studentId: string): void;
  /** Returns true when a verified token was issued at or before the learner's deletion. */
  isAuthRevoked(identity: Pick<UserIdentity, 'studentId' | 'iat' | 'exp'>): boolean;
  /** Returns an issued-at timestamp strictly newer than any prior revocation for this learner. */
  getFreshTokenIat(studentId: string): number;
  /** Deletes a learner account and clears active locks, primary monitor pin, in-flight tasks, and auth tokens. */
  deleteLearnerAccountAndCleanup(studentId: string): Promise<AccountDeleteResponse>;
  resolveDefaultMonitoredStudentId(config: LearningConfig, users?: LearnerAccountRecord[]): Promise<string | null>;
}

export function createAppContext(repo: AppRepository, options: { skipSeed?: boolean } = {}): AppContext {
  let seedPromise: Promise<void> | null = null;
  const inFlightWritingEvaluations = new Map<string, Promise<WritingEvaluationRecord>>();
  const inFlightWritingOwners = new Map<string, string>();
  const aiRateLimiter = createAiRateLimiter();
  const revokedBeforeByStudent = new Map<string, number>();

  async function ensureSeeded(): Promise<void> {
    if (options.skipSeed || repo.backendName !== 'memory_preview') return;
    seedPromise ??= repo
      .initAndSeedIfEmpty(V3_STARTER_MANIFEST_EXAMPLE as unknown as BankImportManifest)
      .catch((err) => {
        seedPromise = null;
        throw err;
      });
    await seedPromise;
  }

  function pruneOldRevocations(nowMs: number): void {
    const cutoff = nowMs - AUTH_REVOCATION_TTL_MS;
    for (const [sid, ts] of revokedBeforeByStudent) {
      if (ts < cutoff) revokedBeforeByStudent.delete(sid);
    }
  }

  function revokeStudentAuth(studentId: string): void {
    const nowMs = Date.now();
    pruneOldRevocations(nowMs);
    const prev = revokedBeforeByStudent.get(studentId) ?? 0;
    revokedBeforeByStudent.set(studentId, Math.max(nowMs, prev));
  }

  function isAuthRevoked(identity: Pick<UserIdentity, 'studentId' | 'iat' | 'exp'>): boolean {
    const revokedAt = revokedBeforeByStudent.get(identity.studentId);
    if (revokedAt === undefined) return false;
    return getTokenIssuedAtMs(identity) <= revokedAt;
  }

  function getFreshTokenIat(studentId: string): number {
    const nowMs = Date.now();
    const revokedAt = revokedBeforeByStudent.get(studentId);
    if (revokedAt === undefined) return nowMs;
    return Math.max(nowMs, revokedAt + 1);
  }

  async function deleteLearnerAccountAndCleanup(studentId: string): Promise<AccountDeleteResponse> {
    const result = await repo.deleteUserAccount(studentId);

    for (const [submissionId, ownerId] of inFlightWritingOwners) {
      if (ownerId === studentId) {
        inFlightWritingOwners.delete(submissionId);
        inFlightWritingEvaluations.delete(submissionId);
      }
    }
    clearDailyFocusInFlight(repo, studentId);

    const configData = await repo.getActiveConfig();
    if (configData.config.primaryMonitoredStudentId === studentId) {
      const nextConfig: LearningConfig = {
        ...configData.config,
        primaryMonitoredStudentId: undefined,
      };
      await repo.saveConfigVersion(nextConfig, `Cleared deleted primary learner: ${studentId}`);
    }

    revokeStudentAuth(studentId);
    return result;
  }

  async function resolveDefaultMonitoredStudentId(
    config: LearningConfig,
    users?: LearnerAccountRecord[]
  ): Promise<string | null> {
    const allUsers = users ?? (await repo.listUsers());
    if (config.primaryMonitoredStudentId && allUsers.some((u) => u.uid === config.primaryMonitoredStudentId)) {
      return config.primaryMonitoredStudentId;
    }
    const studentUsers = allUsers.filter((u) => u.role === 'student');
    const candidates = studentUsers.length > 0 ? studentUsers : allUsers;
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0].uid;

    const activityById = await repo.getLearnerActivity(candidates.map((u) => u.uid));
    const ranked = candidates.map((u) => {
      const activity = activityById[u.uid];
      const latestMs = Math.max(Date.parse(u.updatedAtIso || '') || 0, Date.parse(activity?.lastActiveAtIso || '') || 0);
      return {
        uid: u.uid,
        sessionsCount: activity?.sessionsCount ?? 0,
        attemptsCount: activity?.attemptsCount ?? 0,
        latestMs,
      };
    });
    ranked.sort((a, b) => b.attemptsCount - a.attemptsCount || b.sessionsCount - a.sessionsCount || b.latestMs - a.latestMs);
    return ranked[0].uid;
  }

  return {
    repo,
    backendName: repo.backendName,
    ensureSeeded,
    inFlightWritingEvaluations,
    inFlightWritingOwners,
    aiRateLimiter,
    revokeStudentAuth,
    isAuthRevoked,
    getFreshTokenIat,
    deleteLearnerAccountAndCleanup,
    resolveDefaultMonitoredStudentId,
  };
}
