import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import type { BankImportManifest } from '../src/shared/contracts.ts';
import { createRepository } from '../src/server/storage/index.ts';

dotenv.config();

const SEED_DIR = path.join(process.cwd(), 'seed');

async function loadManifest(name: string): Promise<BankImportManifest | null> {
  try {
    const raw = await fs.readFile(path.join(SEED_DIR, name), 'utf8');
    return JSON.parse(raw) as BankImportManifest;
  } catch {
    return null;
  }
}

async function main() {
  const repo = createRepository();
  const smoke = await loadManifest('golden-smoke-pack.json');
  const pt12 = await loadManifest('official-doe-pt1-2.json');
  const pt3 = await loadManifest('official-doe-pt3-holdout.json');

  if (smoke) {
    await repo.initAndSeedIfEmpty(smoke);
  }
  const existing = await repo.listQuestions();
  const existingIds = new Set(existing.map((q) => q.questionId));

  let importedPt12 = 0;
  let importedPt3 = 0;

  if (pt12 && !existingIds.has('q_off_pt1_read_q01_v1')) {
    const res = await repo.importManifest(pt12, 'cli_seed');
    importedPt12 = res.imported;
  }
  if (pt3 && !existingIds.has('q_off_pt3_read_q01_v1')) {
    const res = await repo.importManifest(pt3, 'cli_seed');
    importedPt3 = res.imported;
  }

  const finalQuestions = await repo.listQuestions();
  console.log(
    JSON.stringify(
      {
        ok: true,
        backendName: repo.backendName,
        totalQuestions: finalQuestions.length,
        importedPt12,
        importedPt3,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error('Seed script failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
