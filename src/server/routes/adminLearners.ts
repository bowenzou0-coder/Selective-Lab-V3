import type { Express } from 'express';
import { requireAdmin, type AuthenticatedRequest } from '../auth.ts';
import { getRuntimeDiagnostics } from '../diagnostics.ts';
import { generateDailyFocusPlanStateless, getOrCreateDailyFocusPlan } from '../geminiPlanner.ts';
import {
  resolveEffectiveLearningConfig,
  type AdminLearnerSummary,
  type LearnerPreferences,
  type LearningConfig,
} from '../../shared/contracts.ts';
import type { AppContext } from '../context.ts';
import { extractLearnerDailyView, sanitizeDailyPlanPatch } from './studentSettings.ts';


/** Admin diagnostics, learner monitoring and daily plans (/api/admin/*). */
export function registerAdminLearnerRoutes(app: Express, ctx: AppContext): void {
  const { repo } = ctx;
  app.get('/api/admin/diagnostics', requireAdmin, async (_req, res) => {
    try {
      const report = await getRuntimeDiagnostics(repo);
      res.json(report);
    } catch (err) {
      console.error('GET /api/admin/diagnostics error:', err);
      res.status(500).json({ error: 'Failed to collect runtime diagnostics.' });
    }
  });

  app.get('/api/admin/study-progress', requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ctx.ensureSeeded();
      if (!repo.getProgressCounts) {
        res.status(501).json({ error: 'Study progress counts are unavailable for this repository.' });
        return;
      }
      const requestedId = req.query.studentId ? String(req.query.studentId).trim() : '';
      const targetStudentId = requestedId && requestedId !== 'none' ? requestedId : req.auth!.studentId;
      const counts = await repo.getProgressCounts(targetStudentId);
      res.json({ ...counts, studentId: targetStudentId });
    } catch (err) {
      console.error('GET /api/admin/study-progress error:', err);
      res.status(500).json({ error: 'Unable to load study progress counts.' });
    }
  });

  app.post('/api/admin/study-progress/reset', requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ctx.ensureSeeded();
      if (!repo.resetStudentProgress) {
        res.status(501).json({ error: 'Study progress reset is unavailable for this repository.' });
        return;
      }
      const requestedId = typeof req.body?.studentId === 'string' ? req.body.studentId.trim() : '';
      const targetStudentId = requestedId && requestedId !== 'none' ? requestedId : req.auth!.studentId;
      const result = await repo.resetStudentProgress(targetStudentId);
      res.json({ ...result, studentId: targetStudentId });
    } catch (err) {
      console.error('POST /api/admin/study-progress/reset error:', err);
      res.status(500).json({ error: 'Unable to reset study progress.' });
    }
  });


  app.get('/api/admin/learners', requireAdmin, async (_req, res) => {
    try {
      await ctx.ensureSeeded();
      const [users, configData] = await Promise.all([
        repo.listUsers(),
        repo.getActiveConfig(),
      ]);
      const dailyLimits = configData.config.sessionDefaults.dailyQuestionLimitBySection;
      const dailyQuestionTarget = Math.max(
        1,
        (dailyLimits.READ || 0) + (dailyLimits.MATH || 0) + (dailyLimits.THINK || 0)
      );
      const userIds = users.map((u) => u.uid);
      // Counts, last-activity, and pool health all come from SQL aggregates instead of loading rows.
      const [activityById, poolHealthRes] = await Promise.all([
        repo.getLearnerActivity(userIds),
        repo.getPoolHealthByLearner(userIds, dailyQuestionTarget),
      ]);

      const summaries: AdminLearnerSummary[] = users.map((u) => {
        const activity = activityById[u.uid];
        const health = poolHealthRes.byStudentId[u.uid];
        const latestMs = Math.max(
          Date.parse(u.updatedAtIso || '') || 0,
          Date.parse(activity?.lastActiveAtIso || '') || 0
        );
        return {
          ...u,
          sessionsCount: activity?.sessionsCount ?? 0,
          attemptsCount: activity?.attemptsCount ?? 0,
          lastActiveAtIso: latestMs > 0 ? new Date(latestMs).toISOString() : undefined,
          unseenLiveCount: health?.unseenLiveCount ?? 0,
          doneLiveCount: health?.doneLiveCount ?? 0,
          needsRepairLiveCount: health?.needsRepairLiveCount ?? 0,
          inReviewLiveCount: health?.inReviewLiveCount ?? 0,
          unseenLivePercent: health?.unseenLivePercent ?? 0,
          estimatedRunwayDays: health?.estimatedRunwayDays ?? 0,
        };
      });

      const primaryId = configData.config.primaryMonitoredStudentId || null;
      summaries.sort((a, b) => {
        if (primaryId) {
          if (a.uid === primaryId && b.uid !== primaryId) return -1;
          if (b.uid === primaryId && a.uid !== primaryId) return 1;
        }
        if (a.role !== b.role) return a.role === 'student' ? -1 : 1;
        if (b.attemptsCount !== a.attemptsCount) return b.attemptsCount - a.attemptsCount;
        const ta = Date.parse(a.lastActiveAtIso || a.updatedAtIso || '') || 0;
        const tb = Date.parse(b.lastActiveAtIso || b.updatedAtIso || '') || 0;
        if (tb !== ta) return tb - ta;
        return a.displayName.localeCompare(b.displayName);
      });

      const defaultMonitoredStudentId = await ctx.resolveDefaultMonitoredStudentId(configData.config, users);
      res.json({
        learners: summaries,
        primaryMonitoredStudentId:
          primaryId && users.some((u) => u.uid === primaryId) ? primaryId : null,
        defaultMonitoredStudentId,
        totalLiveQuestions: poolHealthRes.totalLiveQuestions,
      });
    } catch (err) {
      console.error('GET /api/admin/learners error:', err);
      res.status(500).json({ error: 'Unable to load learner accounts.' });
    }
  });

  app.post('/api/admin/learners/primary', requireAdmin, async (req, res) => {
    try {
      await ctx.ensureSeeded();
      const rawId = req.body?.studentId;
      if (rawId !== null && (typeof rawId !== 'string' || !rawId.trim() || rawId.trim().length > 255)) {
        res.status(400).json({ error: 'Provide a valid studentId string or null.' });
        return;
      }
      const targetId = rawId === null ? null : rawId.trim();
      if (targetId !== null) {
        const users = await repo.listUsers();
        if (!users.some((u) => u.uid === targetId)) {
          res.status(404).json({ error: 'Learner account not found.' });
          return;
        }
      }
      const configData = await repo.getActiveConfig();
      const nextConfig: LearningConfig = {
        ...configData.config,
        primaryMonitoredStudentId: targetId || undefined,
      };
      await repo.saveConfigVersion(
        nextConfig,
        targetId ? `Pinned primary monitored learner: ${targetId}` : 'Cleared primary monitored learner'
      );
      res.json({ ok: true, primaryMonitoredStudentId: targetId });
    } catch (err) {
      console.error('POST /api/admin/learners/primary error:', err);
      res.status(500).json({ error: 'Unable to update primary monitored learner.' });
    }
  });

  app.delete('/api/admin/learners/:studentId', requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ctx.ensureSeeded();
      const targetId = String(req.params.studentId || '').trim();
      if (!targetId || targetId === 'none') {
        res.status(400).json({ error: 'A valid learner ID is required.' });
        return;
      }
      if (targetId === req.auth!.studentId) {
        res.status(400).json({ error: 'Use Settings to delete your own active account.' });
        return;
      }
      const confirmation = String(req.body?.confirmation || '').trim().toUpperCase();
      if (confirmation !== 'DELETE') {
        res.status(400).json({ error: 'Type DELETE to confirm deleting this account.' });
        return;
      }
      const result = await ctx.deleteLearnerAccountAndCleanup(targetId);
      res.json({ ...result, studentId: targetId });
    } catch (err) {
      console.error('DELETE /api/admin/learners/:studentId error:', err);
      res.status(500).json({ error: 'Unable to delete learner account.' });
    }
  });

  app.get('/api/admin/learners/:studentId/preferences', requireAdmin, async (req, res) => {
    try {
      await ctx.ensureSeeded();
      const targetStudentId = String(req.params.studentId || '').trim();
      if (!targetStudentId || targetStudentId === 'none') {
        res.status(400).json({ error: 'Valid studentId is required.' });
        return;
      }
      const [configData, prefs] = await Promise.all([
        repo.getActiveConfig(),
        repo.getLearnerPreferences(targetStudentId),
      ]);
      const effectiveConfig = resolveEffectiveLearningConfig(configData.config, prefs);
      res.json({
        studentId: targetStudentId,
        preferences: prefs,
        effectiveConfig: extractLearnerDailyView(effectiveConfig),
        globalDefaults: extractLearnerDailyView(configData.config),
        adminOverrideLocked: Boolean(prefs?.adminOverrideLocked),
      });
    } catch (err) {
      console.error('GET /api/admin/learners/:studentId/preferences error:', err);
      res.status(500).json({ error: 'Unable to load learner preferences.' });
    }
  });

  app.put('/api/admin/learners/:studentId/preferences', requireAdmin, async (req, res) => {
    try {
      await ctx.ensureSeeded();
      const targetStudentId = String(req.params.studentId || '').trim();
      if (!targetStudentId || targetStudentId === 'none') {
        res.status(400).json({ error: 'Valid studentId is required.' });
        return;
      }
      const [configData, existing] = await Promise.all([
        repo.getActiveConfig(),
        repo.getLearnerPreferences(targetStudentId),
      ]);
      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

      if (body.resetToDefaults === true) {
        const nextPrefs: LearnerPreferences = {
          onboardingCompletedAtIso: existing?.onboardingCompletedAtIso ?? null,
          adminOverrideLocked: false,
          updatedBy: 'admin',
        };
        const saved = await repo.saveLearnerPreferences(targetStudentId, nextPrefs);
        const effectiveConfig = resolveEffectiveLearningConfig(configData.config, saved);
        res.json({
          ok: true,
          studentId: targetStudentId,
          preferences: saved,
          effectiveConfig: extractLearnerDailyView(effectiveConfig),
          adminOverrideLocked: false,
        });
        return;
      }

      const baseEffective = resolveEffectiveLearningConfig(configData.config, existing);
      const patch = sanitizeDailyPlanPatch(body, baseEffective);
      const nextPrefs: LearnerPreferences = {
        ...(existing || {}),
        ...patch,
        adminOverrideLocked:
          typeof body.adminOverrideLocked === 'boolean'
            ? body.adminOverrideLocked
            : Boolean(existing?.adminOverrideLocked),
        updatedBy: 'admin',
      };
      const saved = await repo.saveLearnerPreferences(targetStudentId, nextPrefs);
      const effectiveConfig = resolveEffectiveLearningConfig(configData.config, saved);
      res.json({
        ok: true,
        studentId: targetStudentId,
        preferences: saved,
        effectiveConfig: extractLearnerDailyView(effectiveConfig),
        adminOverrideLocked: Boolean(saved.adminOverrideLocked),
      });
    } catch (err) {
      console.error('PUT /api/admin/learners/:studentId/preferences error:', err);
      res.status(500).json({ error: 'Unable to update learner preferences.' });
    }
  });

  app.get('/api/admin/daily-plan', requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ctx.ensureSeeded();
      const requestedId = req.query.studentId ? String(req.query.studentId).trim() : '';
      if (requestedId === 'none') {
        res.json({ studentId: null, plan: null });
        return;
      }
      const configData = await repo.getActiveConfig();
      const targetStudentId =
        requestedId ||
        (await ctx.resolveDefaultMonitoredStudentId(configData.config)) ||
        req.auth!.studentId;
      const learnerPrefs = await repo.getLearnerPreferences(targetStudentId);
      const effectiveConfig = resolveEffectiveLearningConfig(configData.config, learnerPrefs);
      const { plan } = await getOrCreateDailyFocusPlan({
        repo,
        studentId: targetStudentId,
        skillStates: () => repo.getSkillStates(targetStudentId),
        evidenceMap: () => repo.getQuestionEvidence(targetStudentId),
        questionMemory: () => repo.getQuestionMemory(targetStudentId),
        questions: () => repo.listSelectionQuestions({ qcStatus: 'active' }),
        config: effectiveConfig,
      });
      res.json({ studentId: targetStudentId, plan });
    } catch (err) {
      console.error('GET /api/admin/daily-plan error:', err);
      res.status(500).json({ error: 'Unable to load daily focus plan.' });
    }
  });

  app.post('/api/admin/recalibrate-daily-plan', requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ctx.ensureSeeded();
      const requestedId = typeof req.body?.studentId === 'string' ? req.body.studentId.trim() : '';
      const studentId = requestedId && requestedId !== 'none' ? requestedId : req.auth!.studentId;
      const [configData, learnerPrefs, questions, skillStates, evidenceMap, questionMemory] = await Promise.all([
        repo.getActiveConfig(),
        repo.getLearnerPreferences(studentId),
        repo.listSelectionQuestions({ qcStatus: 'active' }),
        repo.getSkillStates(studentId),
        repo.getQuestionEvidence(studentId),
        repo.getQuestionMemory(studentId),
      ]);
      const baseEffective = resolveEffectiveLearningConfig(configData.config, learnerPrefs);
      const config = req.body?.config;
      const result = await generateDailyFocusPlanStateless({
        studentId,
        skillStates,
        evidenceMap,
        questionMemory,
        questions,
        config: {
          ...baseEffective,
          autoCalibrate: config?.autoCalibrate ?? baseEffective.autoCalibrate,
        },
      });
      await repo.saveDailyFocusPlan(studentId, result.plan);
      res.json({ ...result, studentId });
    } catch (err) {
      console.error('POST /api/admin/recalibrate-daily-plan error:', err);
      res.status(500).json({ error: 'Unable to recalibrate the daily focus plan.' });
    }
  });
}
