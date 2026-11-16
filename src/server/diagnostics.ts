import { getPublicFirebaseConfig } from '../shared/firebaseConfig.ts';
import { isLocalDevPinAuthEnabled } from './auth.ts';
import {
  getAdminFirestore,
  getAdminStorage,
  hasExplicitServiceCredentials,
  isCloudRunOrGcpRuntime,
  isFirebaseEmulatorActive,
  isFirestoreRuntimeConfigured,
} from './firebaseAdmin.ts';
import { GEMINI_DECISION_MODEL, isGeminiConfigured } from './geminiClient.ts';
import type { AppRepository } from './storage/repository.ts';

export interface RuntimeDiagnostics {
  checkedAtIso: string;
  configSource: 'firebase-applet-config.json';
  projectId: string;
  firestoreDatabaseId: string;
  storageBucket: string;
  runtimeBackend: AppRepository['backendName'];
  nodeEnv: string;
  isCloudRuntime: boolean;
  kService: string | null;
  runtimeServiceAccount: string | null;
  credentialMode: 'explicit_credentials' | 'emulator' | 'attached_adc' | 'none';
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

async function probeMetadataServiceAccountEmail(): Promise<string | null> {
  if (!process.env.K_SERVICE && !process.env.GOOGLE_CLOUD_PROJECT && !process.env.GCLOUD_PROJECT) {
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 600);
  try {
    const res = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email',
      {
        headers: { 'Metadata-Flavor': 'Google' },
        signal: controller.signal,
      }
    );
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    return text || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function getRuntimeDiagnostics(repo: AppRepository): Promise<RuntimeDiagnostics> {
  const cfg = getPublicFirebaseConfig();
  const runtimeServiceAccount = await probeMetadataServiceAccountEmail();
  const geminiConfigured = isGeminiConfigured();
  const sessionSecretConfigured = Boolean((process.env.SESSION_SECRET || '').trim());

  let firestoreProbe: RuntimeDiagnostics['firestoreProbe'] = {
    ok: false,
    latencyMs: 0,
    errorCode: 'SKIPPED',
    errorMessage: 'Firestore is not active in current backend.',
  };
  let storageProbe: RuntimeDiagnostics['storageProbe'] = {
    ok: false,
    error: 'Storage check skipped in disposable memory mode.',
  };

  if (repo.backendName === 'firestore_server' || isFirestoreRuntimeConfigured()) {
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
  } else if (repo.backendName === 'memory_preview') {
    firestoreProbe = {
      ok: true,
      latencyMs: 0,
      errorCode: 'MEMORY_PREVIEW',
      errorMessage: 'Using disposable in-memory preview repository.',
    };
  }

  let remediationHint: string | null = null;
  if (!firestoreProbe.ok && repo.backendName === 'firestore_server') {
    const saLabel = runtimeServiceAccount || 'the runtime service account';
    remediationHint = `Server Firestore access failed (${firestoreProbe.errorCode || 'ERROR'}). Grant ${saLabel} roles/datastore.user and roles/storage.objectAdmin on Firebase project "${cfg.projectId}" (or set Firebase Admin ADC credentials in Cloud Run).`;
  }

  const credentialMode: RuntimeDiagnostics['credentialMode'] = hasExplicitServiceCredentials()
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
    runtimeBackend: repo.backendName,
    nodeEnv: process.env.NODE_ENV || 'development',
    isCloudRuntime: isCloudRunOrGcpRuntime(),
    kService: process.env.K_SERVICE || null,
    runtimeServiceAccount,
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
