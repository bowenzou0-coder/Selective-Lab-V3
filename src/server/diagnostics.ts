import { getPublicFirebaseConfig } from '../shared/firebaseConfig.ts';
import { isLocalDevPinAuthEnabled } from './auth.ts';
import {
  getAdminFirestore,
  getAdminStorage,
  hasExplicitServiceCredentials,
  isClientFirestoreMode,
  isCloudRunOrGcpRuntime,
  isFirebaseEmulatorActive,
} from './firebaseAdmin.ts';
import { GEMINI_DECISION_MODEL, isGeminiConfigured } from './geminiClient.ts';
import type { AppRepository } from './storage/repository.ts';

export interface RuntimeDiagnostics {
  checkedAtIso: string;
  configSource: 'firebase-applet-config.json';
  projectId: string;
  firestoreDatabaseId: string;
  storageBucket: string;
  runtimeBackend: AppRepository['backendName'] | 'firestore_client';
  nodeEnv: string;
  isCloudRuntime: boolean;
  kService: string | null;
  runtimeServiceAccount: string | null;
  credentialMode: 'client_sdk' | 'explicit_credentials' | 'emulator' | 'attached_adc' | 'none';
  emulatorActive: boolean;
  localDevPinEnabled: boolean;
  sessionSecretConfigured: boolean;
  geminiConfigured: boolean;
  geminiModel: string;
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

export async function getRuntimeDiagnostics(
  repo: AppRepository | null,
  backendOverride?: RuntimeDiagnostics['runtimeBackend']
): Promise<RuntimeDiagnostics> {
  const cfg = getPublicFirebaseConfig();
  const geminiConfigured = isGeminiConfigured();
  const sessionSecretConfigured = Boolean((process.env.SESSION_SECRET || '').trim());
  const runtimeBackend = backendOverride ?? (repo ? repo.backendName : 'firestore_client');

  let firestoreProbe: RuntimeDiagnostics['firestoreProbe'] = {
    ok: true,
    latencyMs: 0,
    errorCode: 'CLIENT_SDK',
    errorMessage: 'Persistent Cloud Firestore via authenticated client Firebase SDK (Starter Tier).',
  };
  let storageProbe: RuntimeDiagnostics['storageProbe'] = {
    ok: true,
    exists: true,
    error: undefined,
  };

  if (runtimeBackend === 'firestore_client' || isClientFirestoreMode()) {
    firestoreProbe = {
      ok: true,
      latencyMs: 0,
      errorCode: 'CLIENT_SDK',
      errorMessage: 'Persistent Cloud Firestore via authenticated client Firebase SDK + firestore.rules.',
    };
    storageProbe = {
      ok: true,
      exists: Boolean(cfg.storageBucket),
    };
  } else if (runtimeBackend === 'firestore_server') {
    const start = Date.now();
    try {
      const db = getAdminFirestore();
      await db.collection('admin_configs').limit(1).get();
      firestoreProbe = { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      const e = err as { code?: unknown; message?: string };
      firestoreProbe = {
        ok: false,
        latencyMs: Date.now() - start,
        errorCode: e?.code !== undefined ? String(e.code) : 'ERROR',
        errorMessage: e?.message || 'Firestore probe failed.',
      };
    }

    try {
      const bucket = getAdminStorage().bucket(cfg.storageBucket);
      const [exists] = await bucket.exists();
      storageProbe = { ok: exists, exists };
    } catch (err) {
      storageProbe = {
        ok: false,
        error: err instanceof Error ? err.message : 'Storage probe failed.',
      };
    }
  } else if (runtimeBackend === 'memory_preview') {
    firestoreProbe = {
      ok: true,
      latencyMs: 0,
      errorCode: 'MEMORY_PREVIEW',
      errorMessage: 'Using disposable in-memory preview repository.',
    };
    storageProbe = {
      ok: false,
      error: 'Storage check skipped in disposable memory mode.',
    };
  }

  let remediationHint: string | null = null;
  if (!firestoreProbe.ok && runtimeBackend === 'firestore_server') {
    remediationHint = `Server Firestore access failed (${firestoreProbe.errorCode || 'ERROR'}).`;
  }

  const credentialMode: RuntimeDiagnostics['credentialMode'] =
    runtimeBackend === 'firestore_client'
      ? 'client_sdk'
      : hasExplicitServiceCredentials()
        ? 'explicit_credentials'
        : isFirebaseEmulatorActive()
          ? 'emulator'
          : isCloudRunOrGcpRuntime()
            ? 'attached_adc'
            : 'none';

  return {
    checkedAtIso: new Date().toISOString(),
    configSource: 'firebase-applet-config.json',
    projectId: cfg.projectId,
    firestoreDatabaseId: cfg.firestoreDatabaseId,
    storageBucket: cfg.storageBucket,
    runtimeBackend,
    nodeEnv: process.env.NODE_ENV || 'development',
    isCloudRuntime: isCloudRunOrGcpRuntime(),
    kService: process.env.K_SERVICE || null,
    runtimeServiceAccount: null,
    credentialMode,
    emulatorActive: isFirebaseEmulatorActive(),
    localDevPinEnabled: isLocalDevPinAuthEnabled(),
    sessionSecretConfigured,
    geminiConfigured,
    geminiModel: GEMINI_DECISION_MODEL,
    firestoreProbe,
    storageProbe,
    remediationHint,
  };
}
