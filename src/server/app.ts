import path from 'node:path';
import compression from 'compression';
import express, { type Express } from 'express';
import { assertAuthRuntimeConfig, attachAuth, requireSameOriginMutation } from './auth.ts';
import { createAppContext } from './context.ts';
import { ROOT_DIR } from './paths.ts';
import { registerAdminBankRoutes } from './routes/adminBank.ts';
import { registerAdminLearnerRoutes } from './routes/adminLearners.ts';
import { registerAdminSystemRoutes } from './routes/adminSystem.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerBenchmarkRoutes } from './routes/benchmarks.ts';
import { registerSessionRoutes } from './routes/sessions.ts';
import { registerStudentRoutes } from './routes/student.ts';
import { registerStudentProgressRoutes } from './routes/studentProgress.ts';
import { createRepository } from './storage/index.ts';
import type { AppRepository } from './storage/repository.ts';

export interface CreateAppOptions {
  repo?: AppRepository;
  skipSeed?: boolean;
  skipVite?: boolean;
}

const ONE_YEAR_SEC = 31_536_000;

export async function createApp(options: CreateAppOptions = {}): Promise<{ app: Express; repo: AppRepository }> {
  assertAuthRuntimeConfig();
  const repo = options.repo ?? createRepository();
  const ctx = createAppContext(repo, { skipSeed: options.skipSeed });

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  // Admin bank pages are ~200 KB of JSON; gzip/brotli them (no-op if a proxy already compressed).
  app.use(compression({ threshold: 1024 }));
  app.use('/api', requireSameOriginMutation);
  app.use(['/api/auth', '/api/student', '/api/admin'], (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '15mb' }));
  app.use(attachAuth);

  // Local/`npm start` static serving; on Vercel these paths are served by the CDN (see vercel.json).
  const publicDir = path.join(ROOT_DIR, 'public');
  app.use('/assets', express.static(path.join(publicDir, 'assets'), { maxAge: '7d' }));
  app.use('/fonts', express.static(path.join(publicDir, 'fonts'), { maxAge: ONE_YEAR_SEC * 1000, immutable: true }));
  app.use('/docs', express.static(path.join(publicDir, 'docs'), { maxAge: '1h' }));

  registerAuthRoutes(app, ctx);
  registerStudentRoutes(app, ctx);
  registerBenchmarkRoutes(app, ctx);
  registerSessionRoutes(app, ctx);
  registerStudentProgressRoutes(app, ctx);
  registerAdminLearnerRoutes(app, ctx);
  registerAdminBankRoutes(app, ctx);
  registerAdminSystemRoutes(app, ctx);

  app.use('/api', (_req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
  if (!options.skipVite) {
    if (process.env.NODE_ENV !== 'production') {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
      app.use(vite.middlewares);
    } else {
      const distDir = path.join(ROOT_DIR, 'dist');
      // Hashed build output never changes; index.html must always revalidate.
      app.use('/assets', express.static(path.join(distDir, 'assets'), { maxAge: ONE_YEAR_SEC * 1000, immutable: true }));
      app.use(express.static(distDir, { index: false }));
      app.get('*', (_req, res) => {
        res.setHeader('Cache-Control', 'no-cache');
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  return { app, repo };
}
