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

export function createRepository(): AppRepository {
  if (isPostgresConfigured()) {
    return new PostgresRepository();
  }
  return new MemoryRepository();
}
