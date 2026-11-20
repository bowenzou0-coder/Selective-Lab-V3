import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getStorage, type Storage } from 'firebase-admin/storage';
import { getPublicFirebaseConfig } from '../shared/firebaseConfig.ts';

let cachedApp: App | null = null;
let cachedDb: Firestore | null = null;

export function isFirebaseEmulatorActive(): boolean {
  return Boolean(
    process.env.FIRESTORE_EMULATOR_HOST ||
      process.env.FIREBASE_AUTH_EMULATOR_HOST ||
      process.env.FIREBASE_STORAGE_EMULATOR_HOST
  );
}

export function assertNoEmulatorInProduction(): void {
  if (process.env.NODE_ENV === 'production' && isFirebaseEmulatorActive()) {
    throw new Error(
      'Production configuration error: Firebase emulator env vars (FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST / FIREBASE_STORAGE_EMULATOR_HOST) must not be set in production.'
    );
  }
}

export function hasExplicitServiceCredentials(): boolean {
  return Boolean(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim() ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()
  );
}

export function isCloudRunOrGcpRuntime(): boolean {
  return Boolean(
    process.env.K_SERVICE ||
      process.env.GOOGLE_CLOUD_PROJECT ||
      process.env.GCLOUD_PROJECT ||
      process.env.FIREBASE_USE_ADC === 'true'
  );
}

/**
 * Starter Tier (Google-hosted) Firebase projects do not grant IAM access to
 * server-side Admin SDK Firestore calls. In that environment (e.g., AI Studio
 * preview/hosted runtime without explicit service credentials or Postgres),
 * persistence runs through the authenticated client-side Firebase SDK protected
 * by hardened firestore.rules, while the server only performs IAM-free
 * ID-token verification and stateless Gemini API calls.
 */
export function isClientFirestoreMode(): boolean {
  if (process.env.NODE_ENV === 'test') return false;
  if (process.env.ALLOW_DEMO_MEMORY_DB === 'true') return false;
  if (process.env.USE_CLIENT_FIRESTORE === 'true') return true;
  if (process.env.USE_CLIENT_FIRESTORE === 'false') return false;
  if (process.env.USE_SERVER_FIRESTORE_ADMIN === 'true') return false;
  if (isFirebaseEmulatorActive() || hasExplicitServiceCredentials()) return false;
  if (
    process.env.SQL_HOST &&
    process.env.SQL_USER &&
    process.env.SQL_PASSWORD &&
    process.env.SQL_DB_NAME
  ) {
    return false;
  }
  return Boolean(getPublicFirebaseConfig().projectId);
}

export function isFirestoreRuntimeConfigured(): boolean {
  if (process.env.DISABLE_FIRESTORE === 'true') return false;
  return (
    isFirebaseEmulatorActive() ||
    hasExplicitServiceCredentials() ||
    isCloudRunOrGcpRuntime() ||
    process.env.USE_FIRESTORE_DB === 'true' ||
    process.env.USE_FIRESTORE === 'true'
  );
}

export function isStorageBucketConfigured(): boolean {
  if (isClientFirestoreMode()) return false;
  const cfg = getPublicFirebaseConfig();
  return Boolean(
    cfg.storageBucket &&
      (process.env.FIREBASE_STORAGE_EMULATOR_HOST ||
        hasExplicitServiceCredentials() ||
        process.env.USE_SERVER_FIRESTORE_ADMIN === 'true')
  );
}

export function getFirebaseAdminApp(): App {
  if (cachedApp) return cachedApp;
  const existing = getApps();
  if (existing.length > 0) {
    cachedApp = existing[0];
    return cachedApp;
  }

  const cfg = getPublicFirebaseConfig();
  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();

  if (saJson) {
    const parsed = JSON.parse(saJson);
    cachedApp = initializeApp({
      credential: cert(parsed),
      projectId: cfg.projectId,
      storageBucket: cfg.storageBucket || undefined,
    });
    return cachedApp;
  }

  // Initializing with only projectId requires NO IAM and supports verifyIdToken(token)
  // on any Firebase project (including Starter Tier Google-hosted projects).
  cachedApp = initializeApp({
    projectId: cfg.projectId,
    storageBucket: cfg.storageBucket || undefined,
  });
  return cachedApp;
}

export function getAdminFirestore(): Firestore {
  if (cachedDb) return cachedDb;
  const app = getFirebaseAdminApp();
  const cfg = getPublicFirebaseConfig();
  const dbId = cfg.firestoreDatabaseId || '(default)';
  cachedDb = getFirestore(app, dbId);
  return cachedDb;
}

export function getAdminAuth(): Auth {
  return getAuth(getFirebaseAdminApp());
}

export function getAdminStorage(): Storage {
  return getStorage(getFirebaseAdminApp());
}
