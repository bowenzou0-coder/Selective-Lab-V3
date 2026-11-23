import type { Express } from 'express';
import { requireStudentOrAdmin, type AuthenticatedRequest } from '../auth.ts';
import { getOrCreateDailyFocusPlan } from '../geminiPlanner.ts';
import type { SessionRecord } from '../../shared/contracts.ts';
import type { AppContext } from '../context.ts';
import { computeSessionStreak, isSessionPastGrace, resolveOrExpireSession } from '../sessionLifecycle.ts';

/** Student dashboard (/api/student/dashboard). */
export function registerStudentRoutes(app: Express, ctx: AppContext): void {
  const { repo } = ctx;
  app.get('/api/student/dashboard', requireStudentOrAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ctx.ensureSeeded();
      const studentId = req.auth!.studentId;
      const todayPrefix = new Date().toISOString().slice(0, 10);
      const [configData, rawSessions, initialTodayCounts] = await Promise.all([
        repo.getActiveConfig(),
        repo.listSessions(100, studentId, false, { omitSubmissionSummary: true }),
        repo.getTodayAttemptCounts(studentId, todayPrefix),
      ]);

      let anyExpired = false;
      const sessions: SessionRecord[] = [];
      for (const s of rawSessions) {
        if (isSessionPastGrace(s)) {
          anyExpired = true;
          sessions.push(await resolveOrExpireSession(repo, s));
        } else {
          sessions.push(s);
        }
      }

      const autoRetire = Boolean(configData.config.poolPolicy?.autoRetireMastered);
      const [todayCounts, bankSummary, { plan: dailyFocusPlan }] = await Promise.all([
        anyExpired ? repo.getTodayAttemptCounts(studentId, todayPrefix) : Promise.resolve(initialTodayCounts),
        repo.getStudentDashboardBankSummary(studentId, autoRetire),
        getOrCreateDailyFocusPlan({
          repo,
          studentId,
          skillStates: () => repo.getSkillStates(studentId),
          evidenceMap: () => repo.getQuestionEvidence(studentId),
          questionMemory: () => repo.getQuestionMemory(studentId),
          // Slim selection rows + learner maps load only when today's plan is not cached yet.
          questions: () => repo.listSelectionQuestions({ qcStatus: 'active' }),
          config: configData.config,
        }),
      ]);

      const todaySessions = sessions.filter((s) => !s.isSandbox && s.startedAt.startsWith(todayPrefix));
      const todayMinutes = Math.round(
        todaySessions.reduce((acc, s) => acc + (s.checkpoint?.elapsedSec ?? 0), 0) / 60
      );

      const activeInProgress = sessions.find((s) => s.status === 'in_progress' && !s.isSandbox) || null;
      const autoCalEnabled = Boolean(configData.config.autoCalibrate?.enabled);
      const effectiveDailyLimits =
        autoCalEnabled && dailyFocusPlan?.dailyQuestionLimitBySection
          ? dailyFocusPlan.dailyQuestionLimitBySection
          : configData.config.sessionDefaults.dailyQuestionLimitBySection;
      const effectiveDailyGoalMinutes =
        autoCalEnabled && dailyFocusPlan?.dailyGoalMinutes
          ? dailyFocusPlan.dailyGoalMinutes
          : configData.config.sessionDefaults.dailyGoalMinutes;

      res.json({
        studentId,
        streakDays: computeSessionStreak(sessions),
        dailyGoalMinutes: effectiveDailyGoalMinutes,
        sectionDrillQuestionCount: configData.config.sessionDefaults.sectionDrillQuestionCount ?? 10,
        sectionDrillTimeMinutes: configData.config.sessionDefaults.sectionDrillTimeMinutes ?? 8,
        todayMinutes,
        todaySlotsAttempted: todayCounts.attempted,
        todaySlotsCorrect: todayCounts.correct,
        dailyLimits: effectiveDailyLimits,
        autoCalibrateEnabled: autoCalEnabled,
        poolCounts: bankSummary.poolCounts,
        batchCounts: bankSummary.batchCounts,
        customBatches: bankSummary.customBatches,
        benchmarkBatches: bankSummary.benchmarkBatches,
        activeSession: activeInProgress,
        recentSessions: sessions
          .filter((s) => !s.isSandbox)
          .slice(0, 8)
          .map(({ submissionSummary: _summary, ...rest }) => rest),
        dailyFocusPlan,
        serverNowIso: new Date().toISOString(),
      });
    } catch (err) {
      console.error('GET /api/student/dashboard error:', err);
      res.status(500).json({ error: 'Failed to load student dashboard.' });
    }
  });
}
