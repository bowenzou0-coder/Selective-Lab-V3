import type { Express } from 'express';
import { requireStudentOrAdmin, type AuthenticatedRequest } from '../auth.ts';
import { getOrCreateDailyFocusPlan } from '../geminiPlanner.ts';
import { deriveQuestionProgressMeta } from '../../shared/bankStatus.ts';
import type { SectionCode, SessionRecord } from '../../shared/contracts.ts';
import { getQuestionBatchTag } from '../../shared/engine.ts';
import type { AppContext } from '../context.ts';
import { computeSessionStreak, isSessionExpired, resolveOrExpireSession } from '../sessionLifecycle.ts';

/** Student dashboard (/api/student/dashboard). */
export function registerStudentRoutes(app: Express, ctx: AppContext): void {
  const { repo } = ctx;
  app.get('/api/student/dashboard', requireStudentOrAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ctx.ensureSeeded();
      const studentId = req.auth!.studentId;
      const [
        configData,
        rawSessions,
        initialAttempts,
        questions,
        importBatches,
        initialSkillStates,
        initialEvidenceMap,
        initialQuestionMemory,
      ] = await Promise.all([
        repo.getActiveConfig(),
        repo.listSessions(100, studentId, false, { omitSubmissionSummary: true }),
        repo.listPartAttempts(500, studentId, false),
        repo.listQuestionMeta({ qcStatus: 'active' }),
        repo.listImportBatchSummaries(),
        repo.getSkillStates(studentId),
        repo.getQuestionEvidence(studentId),
        repo.getQuestionMemory(studentId),
      ]);

      let anyExpired = false;
      const sessions: SessionRecord[] = [];
      for (const s of rawSessions) {
        if (isSessionExpired(s)) {
          anyExpired = true;
          sessions.push(await resolveOrExpireSession(repo, s));
        } else {
          sessions.push(s);
        }
      }
      const [attempts, skillStates, evidenceMap, questionMemory] = anyExpired
        ? await Promise.all([
            repo.listPartAttempts(500, studentId, false),
            repo.getSkillStates(studentId),
            repo.getQuestionEvidence(studentId),
            repo.getQuestionMemory(studentId),
          ])
        : [initialAttempts, initialSkillStates, initialEvidenceMap, initialQuestionMemory];

      const { plan: dailyFocusPlan } = await getOrCreateDailyFocusPlan({
        repo,
        studentId,
        skillStates,
        evidenceMap,
        questionMemory,
        // Full questions are only needed when today's plan is not cached yet.
        questions: () => repo.listQuestions({ qcStatus: 'active' }),
        config: configData.config,
      });

      const todayPrefix = new Date().toISOString().slice(0, 10);
      const todaySessions = sessions.filter((s) => !s.isSandbox && s.startedAt.startsWith(todayPrefix));
      const todayMinutes = Math.round(
        todaySessions.reduce((acc, s) => acc + (s.checkpoint?.elapsedSec ?? 0), 0) / 60
      );
      const todayAttempts = attempts.filter((a) => a.createdAt.startsWith(todayPrefix));
      const todayCorrect = todayAttempts.filter((a) => a.isCorrect).length;

      const batchCounts: Record<'PT1' | 'PT2' | 'PT3', Record<SectionCode, number>> = {
        PT1: { READ: 0, MATH: 0, THINK: 0, WRIT: 0 },
        PT2: { READ: 0, MATH: 0, THINK: 0, WRIT: 0 },
        PT3: { READ: 0, MATH: 0, THINK: 0, WRIT: 0 },
      };
      const poolCounts: Record<SectionCode, { live: number; unseen: number }> = {
        READ: { live: 0, unseen: 0 },
        MATH: { live: 0, unseen: 0 },
        THINK: { live: 0, unseen: 0 },
        WRIT: { live: 0, unseen: 0 },
      };
      const batchById = new Map(importBatches.map((b) => [b.batchId, b]));
      const customBatchMap = new Map<
        string,
        { batchId: string; batchLabel: string; counts: Record<SectionCode, number>; total: number }
      >();
      const autoRetire = Boolean(configData.config.poolPolicy?.autoRetireMastered);

      for (const q of questions) {
        const tag = getQuestionBatchTag(q);
        if (tag === 'PT1' || tag === 'PT2' || tag === 'PT3') {
          batchCounts[tag][q.section] += 1;
        }
        if (q.poolType !== 'benchmark_holdout') {
          const prog = deriveQuestionProgressMeta(q, evidenceMap, questionMemory);
          if (!(autoRetire && prog.completionStatus === 'done')) {
            poolCounts[q.section].live += 1;
            if (prog.completionStatus === 'unseen') {
              poolCounts[q.section].unseen += 1;
            }
          }
        }
        if (q.batchId && tag !== 'PT1' && tag !== 'PT2' && tag !== 'PT3' && q.poolType !== 'benchmark_holdout') {
          const batchMeta = batchById.get(q.batchId);
          if (batchMeta?.importedBy !== 'system_seed') {
            const entry = customBatchMap.get(q.batchId) || {
              batchId: q.batchId,
              batchLabel: batchMeta?.batchLabel || q.batchLabel || q.batchId,
              counts: { READ: 0, MATH: 0, THINK: 0, WRIT: 0 },
              total: 0,
            };
            entry.counts[q.section] += 1;
            entry.total += 1;
            customBatchMap.set(q.batchId, entry);
          }
        }
      }

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
        todaySlotsAttempted: todayAttempts.length,
        todaySlotsCorrect: todayCorrect,
        dailyLimits: effectiveDailyLimits,
        autoCalibrateEnabled: autoCalEnabled,
        poolCounts,
        batchCounts,
        customBatches: Array.from(customBatchMap.values()).sort((a, b) =>
          b.batchLabel.localeCompare(a.batchLabel)
        ),
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
