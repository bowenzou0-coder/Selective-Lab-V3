import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import { createPostgresPool, PostgresRepository } from '../src/server/storage/postgresRepository.ts';

async function main() {
  const { values, positionals } = parseArgs({
    options: { 'dry-run': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    allowPositionals: true,
  });
  const usage = 'Usage: npm run db:push -- [manifest.json] [--dry-run]';
  if (values.help) {
    console.log(usage);
    return;
  }
  if (positionals.length > 1) throw new Error(usage);

  if (!process.env.DATABASE_URL?.trim()) {
    dotenv.config({ quiet: true });
  }
  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error('Set DATABASE_URL to the app’s Postgres database before pushing a manifest.');
  }

  const filename = positionals[0] || 'batches/ready-to-import.json';
  const dryRun = values['dry-run'] ?? false;
  const raw: unknown = JSON.parse(await readFile(filename, 'utf8'));
  const pool = createPostgresPool();
  try {
    const repo = new PostgresRepository(pool);
    const { report, result, replayed } = await repo.validateAndImportManifest(raw, 'cli_push', { dryRun });
    console.log(JSON.stringify({ ok: report.valid, backendName: repo.backendName, dryRun, replayed, report, result }, null, 2));
    if (!report.valid) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('Manifest push failed:', error instanceof Error ? error.message : 'Unknown error.');
  process.exitCode = 1;
});
