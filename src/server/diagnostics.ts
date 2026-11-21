import { GEMINI_DECISION_MODEL, isGeminiConfigured } from './geminiClient.ts';
import type { AppRepository } from './storage/repository.ts';

export async function getRuntimeDiagnostics(repo: AppRepository) {
  const start = Date.now();
  let ok = true;
  try {
    await repo.getActiveConfig();
  } catch {
    ok = false;
  }
  return {
    checkedAtIso: new Date().toISOString(),
    configSource: 'environment',
    runtimeBackend: repo.backendName,
    sessionSecretConfigured: Boolean(process.env.SESSION_SECRET?.trim()),
    googleConfigured: Boolean(process.env.GOOGLE_CLIENT_ID?.trim()),
    geminiConfigured: isGeminiConfigured(),
    geminiModel: GEMINI_DECISION_MODEL,
    databaseProbe: {
      ok,
      latencyMs: Date.now() - start,
      errorMessage: ok ? undefined : 'Unable to read the active configuration.',
    },
  };
}

export type RuntimeDiagnostics = Awaited<ReturnType<typeof getRuntimeDiagnostics>>;
