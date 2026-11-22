import path from 'node:path';

export const ROOT_DIR = process.cwd();
export const SEED_DIR = path.join(ROOT_DIR, 'seed');
export const UPLOADS_DIR = path.join(ROOT_DIR, 'public', 'assets', 'uploads');
