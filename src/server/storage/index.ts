import { MemoryRepository } from './memoryRepository.ts';
import { isPostgresConfigured } from './postgresConfig.ts';
import { PostgresRepository } from './postgresRepository.ts';
import type { AppRepository } from './repository.ts';

export { isPostgresConfigured } from './postgresConfig.ts';

export function isDisposableDemoMode(): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    (process.env.ALLOW_DEMO_MEMORY_DB === 'true' || process.env.NODE_ENV === 'test')
  );
}

export function createRepository(): AppRepository {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_MEMORY_DB === 'true') {
    throw new Error(
      'Production configuration error: ALLOW_DEMO_MEMORY_DB=true is forbidden in production.'
    );
  }

  if (process.env.ALLOW_DEMO_MEMORY_DB === 'true') {
    return new MemoryRepository();
  }

  if (isPostgresConfigured()) {
    return new PostgresRepository();
  }

  if (isDisposableDemoMode()) {
    return new MemoryRepository();
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Production configuration error: No durable database is configured. Set DATABASE_URL before starting in production.'
    );
  }

  throw new Error(
    'No database configured for local server. Set DATABASE_URL or set ALLOW_DEMO_MEMORY_DB=true for disposable in-memory demo mode.'
  );
}
