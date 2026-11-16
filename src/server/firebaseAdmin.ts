import { applicationDefault, cert, getApps, initializeApp, type App } from 'firebase-admin/app';
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

export function isFirestoreRuntimeConfigured(): boolean {
  if (process.env.DISABLE_FIRESTORE === 'true') return false;
  return (
    isFirebaseEmulatorActive() ||
    hasExplicitServiceCredentials() ||
    isCloudRunOrGcpRuntime() ||
    process.env.USE_FIRESTORE === 'true'
  );
}

export function isStorageBucketConfigured(): boolean {
  const cfg = getPublicFirebaseConfig();
  return Boolean(
    cfg.storageBucket &&
      (process.env.FIREBASE_STORAGE_EMULATOR_HOST ||
        hasExplicitServiceCredentials() ||
        isCloudRunOrGcpRuntime())
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

  if (isFirebaseEmulatorActive()) {
    cachedApp = initializeApp({
      projectId: cfg.projectId,
      storageBucket: cfg.storageBucket || undefined,
    });
    return cachedApp;
  }

  cachedApp = initializeApp({
    credential: applicationDefault(),
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
