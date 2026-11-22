import type { Express } from 'express';
import { requireAdmin, type AuthenticatedRequest } from '../auth.ts';
import type { SyncHydratePayload } from '../storage/repository.ts';
import { DEFAULT_LEARNING_CONFIG, type LearningConfig } from '../../shared/contracts.ts';
import { V3_MANIFEST_JSON_SCHEMA, V3_STARTER_MANIFEST_EXAMPLE } from '../../shared/v3Schema.ts';
import type { AppContext } from '../context.ts';
import { UPLOADS_DIR } from '../paths.ts';


/** Admin config, flags, backup/restore and migration (/api/admin/*). */
export function registerAdminSystemRoutes(app: Express, ctx: AppContext): void {
  const { repo } = ctx;
  app.get('/api/admin/import/schema', requireAdmin, (_req, res) => {
    res.json({
      schema: V3_MANIFEST_JSON_SCHEMA,
      starterExample: V3_STARTER_MANIFEST_EXAMPLE,
    });
  });

  app.get('/api/admin/config', requireAdmin, async (_req, res) => {
    try {
      await ctx.ensureSeeded();
      const [active, history] = await Promise.all([
        repo.getActiveConfig(),
        repo.listConfigVersions(),
      ]);
      res.json({ active, history });
    } catch (err) {
      console.error('GET /api/admin/config error:', err);
      res.status(500).json({ error: 'Failed to load config versions.' });
    }
  });

  app.post('/api/admin/config', requireAdmin, async (req, res) => {
    try {
      await ctx.ensureSeeded();
      const rawConfig = req.body?.config as LearningConfig;
      const notes = req.body?.notes ? String(req.body.notes) : undefined;
      if (!rawConfig || !rawConfig.sessionDefaults || !rawConfig.scheduling || !rawConfig.plateauDetection) {
        res.status(400).json({ error: 'Invalid LearningConfig structure.' });
        return;
      }
      const config: LearningConfig = {
        ...rawConfig,
        sessionDefaults: {
          ...DEFAULT_LEARNING_CONFIG.sessionDefaults,
          ...rawConfig.sessionDefaults,
          sectionDrillQuestionCount: Math.max(
            1,
            Number(rawConfig.sessionDefaults.sectionDrillQuestionCount ?? 10)
          ),
          sectionDrillTimeMinutes: Math.max(
            1,
            Number(rawConfig.sessionDefaults.sectionDrillTimeMinutes ?? 8)
          ),
        },
      };
      const saved = await repo.saveConfigVersion(config, notes);
      res.status(201).json({
        ok: true,
        ...saved,
        config,
        notes,
        createdAtIso: new Date().toISOString(),
      });
    } catch (err) {
      console.error('POST /api/admin/config error:', err);
      res.status(500).json({ error: 'Failed to save config version.' });
    }
  });

  app.get('/api/admin/flags', requireAdmin, async (_req, res) => {
    try {
      await ctx.ensureSeeded();
      const flags = await repo.listQuestionFlags();
      res.json({ flags });
    } catch (err) {
      console.error('GET /api/admin/flags error:', err);
      res.status(500).json({ error: 'Failed to load question flags.' });
    }
  });

  app.post('/api/admin/flags/:id/resolve', requireAdmin, async (req, res) => {
    try {
      await ctx.ensureSeeded();
      await repo.resolveQuestionFlag(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      console.error('POST /api/admin/flags/:id/resolve error:', err);
      res.status(500).json({ error: 'Failed to resolve flag.' });
    }
  });

  app.get(['/api/admin/backup', '/api/admin/export/full'], requireAdmin, async (_req, res) => {
    try {
      await ctx.ensureSeeded();
      const backup = await repo.exportFullBackup();
      res.setHeader('Content-Type', 'application/json');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="selective-lab-backup-${new Date().toISOString().slice(0, 10)}.json"`
      );
      res.send(JSON.stringify(backup, null, 2));
    } catch (err) {
      console.error('GET /api/admin/backup error:', err);
      res.status(500).json({ error: 'Failed to generate backup.' });
    }
  });

  app.post('/api/admin/restore', requireAdmin, async (req, res) => {
    try {
      await ctx.ensureSeeded();
      const dryRun = req.body?.dryRun !== undefined ? Boolean(req.body.dryRun) : true;
      const bundle = req.body?.backup !== undefined ? req.body.backup : req.body;
      const report = await repo.restoreFullBackup(bundle, { dryRun });
      if (!report.valid) {
        res.status(400).json({ error: report.errors.join(' '), report });
        return;
      }
      res.json({ ok: true, report });
    } catch (err) {
      console.error('POST /api/admin/restore error:', err);
      res.status(500).json({ error: 'Backup restore failed.' });
    }
  });

  app.get('/api/admin/migrate/preflight', requireAdmin, async (_req, res) => {
    try {
      await ctx.ensureSeeded();
      const report = await repo.runMigrationPreflight(UPLOADS_DIR);
      res.json({ report });
    } catch (err) {
      console.error('GET /api/admin/migrate/preflight error:', err);
      res.status(500).json({ error: 'Migration preflight check failed.' });
    }
  });

  app.post('/api/admin/migrate/apply', requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ctx.ensureSeeded();
      const dryRun = req.body?.dryRun !== undefined ? Boolean(req.body.dryRun) : true;
      const payload = req.body?.payload;
      if (!payload || typeof payload !== 'object') {
        res.status(400).json({ error: 'Migration payload object is required.' });
        return;
      }

      if ((payload as { schemaVersion?: string }).schemaVersion === 'v3_canonical_1.0') {
        const report = await repo.restoreFullBackup(payload, { dryRun });
        if (!report.valid) {
          res.status(400).json({ error: report.errors.join(' '), report });
          return;
        }
        res.json({ ok: true, mode: 'canonical_restore', report });
        return;
      }

      // Legacy SyncHydratePayload privileged import with dry-run summary
      const legacy = payload as SyncHydratePayload;
      const targetStudentId = String(req.body?.studentId || req.auth!.studentId);
      const summary = {
        stimuli: Array.isArray(legacy.stimuli) ? legacy.stimuli.length : 0,
        questions: Array.isArray(legacy.questions) ? legacy.questions.length : 0,
        sessions: Array.isArray(legacy.sessions) ? legacy.sessions.length : 0,
        attempts: Array.isArray(legacy.attempts) ? legacy.attempts.length : 0,
        writingSubmissions: Array.isArray(legacy.writingSubmissions) ? legacy.writingSubmissions.length : 0,
        flags: Array.isArray(legacy.flags) ? legacy.flags.length : 0,
      };
      if (dryRun) {
        res.json({
          ok: true,
          mode: 'legacy_hydrate',
          dryRun: true,
          targetStudentId,
          counts: summary,
        });
        return;
      }
      await repo.hydrateSyncData(targetStudentId, legacy);
      res.json({
        ok: true,
        mode: 'legacy_hydrate',
        dryRun: false,
        targetStudentId,
        counts: summary,
      });
    } catch (err) {
      console.error('POST /api/admin/migrate/apply error:', err);
      res.status(500).json({ error: 'Privileged migration failed.' });
    }
  });
}
