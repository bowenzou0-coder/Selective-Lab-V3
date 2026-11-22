import type {
  BankImportManifest,
  LearnerAccountRecord,
  LearningConfig,
  WritingEvaluationRecord,
} from '../shared/contracts.ts';
import { V3_STARTER_MANIFEST_EXAMPLE } from '../shared/v3Schema.ts';
import type { AppRepository } from './storage/repository.ts';

/** Shared per-app state handed to every route module. */
export interface AppContext {
  repo: AppRepository;
  backendName: AppRepository['backendName'];
  /** Seeds the minimal in-memory starter pack when running the disposable demo backend. */
  ensureSeeded(): Promise<void>;
  inFlightWritingEvaluations: Map<string, Promise<WritingEvaluationRecord>>;
  resolveDefaultMonitoredStudentId(config: LearningConfig, users?: LearnerAccountRecord[]): Promise<string | null>;
}

export function createAppContext(repo: AppRepository, options: { skipSeed?: boolean } = {}): AppContext {
  let seedPromise: Promise<void> | null = null;

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

  async function resolveDefaultMonitoredStudentId(
    config: LearningConfig,
    users?: LearnerAccountRecord[]
  ): Promise<string | null> {
    const allUsers = users ?? (await repo.listUsers());
    if (config.primaryMonitoredStudentId && allUsers.some((u) => u.uid === config.primaryMonitoredStudentId)) {
      return config.primaryMonitoredStudentId;
    }
    const studentUsers = allUsers.filter((u) => u.role === 'student');
    if (studentUsers.length === 0) return null;
    if (studentUsers.length === 1) return studentUsers[0].uid;

    const activityById = await repo.getLearnerActivity(studentUsers.map((u) => u.uid));
    const ranked = studentUsers.map((u) => {
      const activity = activityById[u.uid];
      const latestMs = Math.max(Date.parse(u.updatedAtIso || '') || 0, Date.parse(activity?.lastActiveAtIso || '') || 0);
      return { uid: u.uid, attemptsCount: activity?.attemptsCount ?? 0, latestMs };
    });
    ranked.sort((a, b) => b.attemptsCount - a.attemptsCount || b.latestMs - a.latestMs);
    return ranked[0].uid;
  }

  return {
    repo,
    backendName: repo.backendName,
    ensureSeeded,
    inFlightWritingEvaluations: new Map(),
    resolveDefaultMonitoredStudentId,
  };
}
