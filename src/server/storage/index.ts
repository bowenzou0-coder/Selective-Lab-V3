import { getAdminFirestore, isFirestoreRuntimeConfigured } from '../firebaseAdmin.ts';
import { FirestoreRepository } from './firestoreRepository.ts';
import { MemoryRepository } from './memoryRepository.ts';
import { PostgresRepository } from './postgresRepository.ts';
import type { AppRepository } from './repository.ts';

export function isPostgresConfigured(): boolean {
  return Boolean(
    process.env.SQL_HOST &&
      process.env.SQL_USER &&
      process.env.SQL_PASSWORD &&
      process.env.SQL_DB_NAME
  );
}

export function isDisposableDemoMode(): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    (process.env.ALLOW_DEMO_MEMORY_DB === 'true' || process.env.NODE_ENV === 'test')
  );
}

export function createRepository(): AppRepository {
  if (isPostgresConfigured()) {
    return new PostgresRepository();
  }

  if (process.env.NODE_ENV !== 'production' && isDisposableDemoMode()) {
    return new MemoryRepository();
  }

  if (isFirestoreRuntimeConfigured()) {
    return new FirestoreRepository(getAdminFirestore());
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Production configuration error: No durable database is configured. Configure Firestore (ADC / FIREBASE_SERVICE_ACCOUNT_JSON / USE_FIRESTORE=true) or Cloud SQL Postgres before starting in production.'
    );
  }

  throw new Error(
    'No database configured for local server. Set FIRESTORE_EMULATOR_HOST + FIREBASE_AUTH_EMULATOR_HOST for local Firestore Emulators, or explicitly set ALLOW_DEMO_MEMORY_DB=true for disposable in-memory demo mode.'
  );
}
