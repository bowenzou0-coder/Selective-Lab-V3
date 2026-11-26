import type { Express } from 'express';
import { requireStudentOrAdmin, type AuthenticatedRequest } from '../auth.ts';
import { getOrCreateDailyFocusPlan } from '../geminiPlanner.ts';
import { resolveEffectiveLearningConfig, type SessionRecord } from '../../shared/contracts.ts';
import type { AppContext } from '../context.ts';
import type { SessionSummaryRow } from '../storage/repository.ts';
import { computeSessionStreak, isSessionPastGrace, resolveOrExpireSession } from '../sessionLifecycle.ts';

const RECENT_SESSIONS_LIMIT = 8;

/** Student dashboard (/api/student/dashboard). */
export function registerStudentRoutes(app: Express, ctx: AppContext): void {
  const { repo } = ctx;
  app.get('/api/student/dashboard', requireStudentOrAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ctx.ensureSeeded();
      const studentId = req.auth!.studentId;
      const todayPrefix = new Date().toISOString().slice(0, 10);
      // Slim metadata covers streaks/minutes/counts; only the few rows the UI renders load in full.
      const [configData, learnerPrefs, summaries, recentRaw, activeRaw, initialTodayCounts] = await Promise.all([
        repo.getActiveConfig(),
        repo.getLearnerPreferences(studentId),
        repo.listSessionSummaries(100, studentId, false),
        repo.listSessions(RECENT_SESSIONS_LIMIT, studentId, false, { omitSubmissionSummary: true }),
        repo.listActiveSessions(studentId),
        repo.getTodayAttemptCounts(studentId, todayPrefix),
      ]);
      const effectiveConfig = resolveEffectiveLearningConfig(configData.config, learnerPrefs);

      let anyExpired = false;
      const resolvedById = new Map<string, SessionRecord>();
      const activeSessions: SessionRecord[] = [];
      for (const s of activeRaw) {
        if (isSessionPastGrace(s)) {
          anyExpired = true;
          const resolved = await resolveOrExpireSession(repo, s);
          resolvedById.set(resolved.sessionId, resolved);
          if (resolved.status === 'in_progress') activeSessions.push(resolved);
        } else {
          activeSessions.push(s);
        }
      }
      const sessionSummaries: SessionSummaryRow[] = summaries.map((row) => {
        const resolved = resolvedById.get(row.sessionId);
        return resolved
          ? { ...row, status: resolved.status, completedAt: resolved.completedAt, elapsedSec: resolved.checkpoint?.elapsedSec ?? row.elapsedSec }
          : row;
      });
      const recentSessions = recentRaw.map((s) => {
        const resolved = resolvedById.get(s.sessionId);
        if (!resolved) return s;
        const { submissionSummary: _summary, ...rest } = resolved;
        return rest;
      });

      const autoRetire = Boolean(effectiveConfig.poolPolicy?.autoRetireMastered);
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
          questions: () => repo.listSelectionQuestions({ qcStatus: 'active', poolType: 'practice' }),
          config: effectiveConfig,
        }),
      ]);

      const todayMinutes = Math.round(
        sessionSummaries
          .filter((s) => s.startedAt.startsWith(todayPrefix))
          .reduce((acc, s) => acc + s.elapsedSec, 0) / 60
      );

      const activeInProgress = activeSessions[0] || null;
      const autoCalEnabled = Boolean(effectiveConfig.autoCalibrate?.enabled);
      const effectiveDailyLimits =
        autoCalEnabled && dailyFocusPlan?.dailyQuestionLimitBySection
          ? dailyFocusPlan.dailyQuestionLimitBySection
          : effectiveConfig.sessionDefaults.dailyQuestionLimitBySection;
      const effectiveDailyGoalMinutes =
        autoCalEnabled && dailyFocusPlan?.dailyGoalMinutes
          ? dailyFocusPlan.dailyGoalMinutes
          : effectiveConfig.sessionDefaults.dailyGoalMinutes;
      const onboardingCompleted = Boolean(learnerPrefs?.onboardingCompletedAtIso);

      res.json({
        studentId,
        streakDays: computeSessionStreak(sessionSummaries),
        dailyGoalMinutes: effectiveDailyGoalMinutes,
        sectionDrillQuestionCount: effectiveConfig.sessionDefaults.sectionDrillQuestionCount ?? 10,
        sectionDrillTimeMinutes: effectiveConfig.sessionDefaults.sectionDrillTimeMinutes ?? 8,
        todayMinutes,
        todaySlotsAttempted: todayCounts.attempted,
        todaySlotsCorrect: todayCounts.correct,
        dailyLimits: effectiveDailyLimits,
        autoCalibrateEnabled: autoCalEnabled,
        adminOverrideLocked: Boolean(learnerPrefs?.adminOverrideLocked),
        onboardingCompleted,
        shouldShowOnboarding: !onboardingCompleted && sessionSummaries.length === 0 && !activeInProgress,
        poolCounts: bankSummary.poolCounts,
        batchCounts: bankSummary.batchCounts,
        customBatches: bankSummary.customBatches,
        benchmarkBatches: bankSummary.benchmarkBatches,
        activeSession: activeInProgress,
        recentSessions,
        dailyFocusPlan,
        serverNowIso: new Date().toISOString(),
      });
    } catch (err) {
      console.error('GET /api/student/dashboard error:', err);
      res.status(500).json({ error: 'Failed to load student dashboard.' });
    }
  });
}
