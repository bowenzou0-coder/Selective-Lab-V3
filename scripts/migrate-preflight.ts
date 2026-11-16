import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { createRepository } from '../src/server/storage/index.ts';

dotenv.config();

async function main() {
  const repo = createRepository();
  const uploadsDir = path.join(process.cwd(), 'public', 'assets', 'uploads');
  const applyArg = process.argv.find((a) => a.startsWith('--apply='))?.split('=')[1];
  const executeWrite = process.argv.includes('--apply-write');

  if (applyArg) {
    const raw = await fs.readFile(path.resolve(process.cwd(), applyArg), 'utf8');
    const parsed = JSON.parse(raw);
    const report = await repo.restoreFullBackup(parsed, { dryRun: !executeWrite });
    console.log(JSON.stringify({ mode: 'restore', dryRun: !executeWrite, report }, null, 2));
    if (!report.valid) process.exit(1);
    return;
  }

  const preflight = await repo.runMigrationPreflight(uploadsDir);
  console.log(JSON.stringify(preflight, null, 2));
}

main().catch((err) => {
  console.error('Migration preflight/apply failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
