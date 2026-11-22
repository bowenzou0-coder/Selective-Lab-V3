import type { Express } from 'express';
import { requireAdmin, type AuthenticatedRequest } from '../auth.ts';
import { getRuntimeDiagnostics } from '../diagnostics.ts';
import { generateDailyFocusPlanStateless, getOrCreateDailyFocusPlan } from '../geminiPlanner.ts';
import { computePoolHealth } from '../../shared/bankStatus.ts';
import type { AdminLearnerSummary, LearnerAccountRecord, LearningConfig } from '../../shared/contracts.ts';
import type { AppContext } from '../context.ts';


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
      const [users, latestQuestions, configData] = await Promise.all([
        repo.listUsers(),
        repo.listQuestionMeta(),
        repo.getActiveConfig(),
      ]);
      // Counts and last-activity come from one SQL aggregate instead of loading every row.
      const activityById = await repo.getLearnerActivity(users.map((u) => u.uid));
      const dailyLimits = configData.config.sessionDefaults.dailyQuestionLimitBySection;
      const dailyQuestionTarget = Math.max(
        1,
        (dailyLimits.READ || 0) + (dailyLimits.MATH || 0) + (dailyLimits.THINK || 0)
      );
      const baseHealth = computePoolHealth({
        questions: latestQuestions,
        evidenceMap: {},
        questionMemory: {},
        dailyQuestionTarget,
      });

      const summaries: AdminLearnerSummary[] = await Promise.all(
        users.map(async (u) => {
          const [evidenceMap, questionMemory] = await Promise.all([
            repo.getQuestionEvidence(u.uid),
            repo.getQuestionMemory(u.uid),
          ]);
          const activity = activityById[u.uid];
          const health = computePoolHealth({
            questions: latestQuestions,
            evidenceMap,
            questionMemory,
            dailyQuestionTarget,
          });
          const latestMs = Math.max(
            Date.parse(u.updatedAtIso || '') || 0,
            Date.parse(activity?.lastActiveAtIso || '') || 0
          );
          return {
            ...u,
            sessionsCount: activity?.sessionsCount ?? 0,
            attemptsCount: activity?.attemptsCount ?? 0,
            lastActiveAtIso: latestMs > 0 ? new Date(latestMs).toISOString() : undefined,
            unseenLiveCount: health.unseenLiveCount,
            doneLiveCount: health.doneLiveCount,
            needsRepairLiveCount: health.needsRepairLiveCount,
            inReviewLiveCount: health.inReviewLiveCount,
            unseenLivePercent: health.unseenLivePercent,
            estimatedRunwayDays: health.estimatedRunwayDays,
          };
        })
      );

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
        totalLiveQuestions: baseHealth.liveCount,
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
      const [skillStates, evidenceMap, questionMemory] = await Promise.all([
        repo.getSkillStates(targetStudentId),
        repo.getQuestionEvidence(targetStudentId),
        repo.getQuestionMemory(targetStudentId),
      ]);
      const { plan } = await getOrCreateDailyFocusPlan({
        repo,
        studentId: targetStudentId,
        skillStates,
        evidenceMap,
        questionMemory,
        questions: () => repo.listQuestions({ qcStatus: 'active' }),
        config: configData.config,
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
      const [configData, questions, skillStates, evidenceMap, questionMemory] = await Promise.all([
        repo.getActiveConfig(),
        repo.listQuestions({ qcStatus: 'active' }),
        repo.getSkillStates(studentId),
        repo.getQuestionEvidence(studentId),
        repo.getQuestionMemory(studentId),
      ]);
      const config = req.body?.config;
      const result = await generateDailyFocusPlanStateless({
        studentId,
        skillStates,
        evidenceMap,
        questionMemory,
        questions,
        config: {
          ...configData.config,
          autoCalibrate: config?.autoCalibrate ?? configData.config.autoCalibrate,
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
