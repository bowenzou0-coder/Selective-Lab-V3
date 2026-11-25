import type { Express } from 'express';
import {
  clearAuthCookie,
  clearGoogleNonce,
  requireStudentOrAdmin,
  type AuthenticatedRequest,
} from '../auth.ts';
import {
  DEFAULT_AUTO_CALIBRATE,
  DEFAULT_LEARNING_CONFIG,
  resolveEffectiveLearningConfig,
  type AutoCalibrateConfig,
  type LearnerPreferences,
  type LearningConfig,
  type SectionCode,
} from '../../shared/contracts.ts';
import { generateDailyFocusPlanStateless, getOrCreateDailyFocusPlan } from '../geminiPlanner.ts';
import type { AppContext } from '../context.ts';

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export function extractLearnerDailyView(cfg: LearningConfig) {
  return {
    autoCalibrate: {
      ...DEFAULT_AUTO_CALIBRATE,
      ...(cfg.autoCalibrate || {}),
    },
    dailyQuestionLimitBySection: {
      ...DEFAULT_LEARNING_CONFIG.sessionDefaults.dailyQuestionLimitBySection,
      ...cfg.sessionDefaults.dailyQuestionLimitBySection,
    },
    dailyGoalMinutes: cfg.sessionDefaults.dailyGoalMinutes,
    sectionDrillQuestionCount: cfg.sessionDefaults.sectionDrillQuestionCount ?? 10,
    sectionDrillTimeMinutes: cfg.sessionDefaults.sectionDrillTimeMinutes ?? 8,
  };
}

export function sanitizeDailyPlanPatch(
  body: Record<string, unknown>,
  baseEffective: LearningConfig
): Partial<LearnerPreferences> {
  const baseAuto: AutoCalibrateConfig = {
    ...DEFAULT_AUTO_CALIBRATE,
    ...(baseEffective.autoCalibrate || {}),
  };
  const baseLimits = {
    ...DEFAULT_LEARNING_CONFIG.sessionDefaults.dailyQuestionLimitBySection,
    ...baseEffective.sessionDefaults.dailyQuestionLimitBySection,
  };

  const patch: Partial<LearnerPreferences> = {};

  if (body.autoCalibrate && typeof body.autoCalibrate === 'object') {
    const rawAuto = body.autoCalibrate as Record<string, unknown>;
    const minQ = clampInt(rawAuto.minDailyQuestions, 3, 30, baseAuto.minDailyQuestions);
    const maxQ = Math.max(minQ, clampInt(rawAuto.maxDailyQuestions, minQ, 40, baseAuto.maxDailyQuestions));
    patch.autoCalibrate = {
      enabled: typeof rawAuto.enabled === 'boolean' ? rawAuto.enabled : baseAuto.enabled,
      minDailyQuestions: minQ,
      maxDailyQuestions: maxQ,
      includeWriting:
        typeof rawAuto.includeWriting === 'boolean' ? rawAuto.includeWriting : baseAuto.includeWriting,
    };
  }

  if (body.dailyQuestionLimitBySection && typeof body.dailyQuestionLimitBySection === 'object') {
    const rawLimits = body.dailyQuestionLimitBySection as Record<string, unknown>;
    const nextLimits: Record<SectionCode, number> = {
      READ: clampInt(rawLimits.READ, 0, 30, baseLimits.READ),
      MATH: clampInt(rawLimits.MATH, 0, 30, baseLimits.MATH),
      THINK: clampInt(rawLimits.THINK, 0, 30, baseLimits.THINK),
      WRIT: clampInt(rawLimits.WRIT, 0, 2, baseLimits.WRIT),
    };
    patch.dailyQuestionLimitBySection = nextLimits;
  }

  if (body.dailyGoalMinutes !== undefined) {
    patch.dailyGoalMinutes = clampInt(
      body.dailyGoalMinutes,
      5,
      120,
      baseEffective.sessionDefaults.dailyGoalMinutes
    );
  }

  if (body.sectionDrillQuestionCount !== undefined) {
    patch.sectionDrillQuestionCount = clampInt(
      body.sectionDrillQuestionCount,
      3,
      40,
      baseEffective.sessionDefaults.sectionDrillQuestionCount ?? 10
    );
  }

  if (body.sectionDrillTimeMinutes !== undefined) {
    patch.sectionDrillTimeMinutes = clampInt(
      body.sectionDrillTimeMinutes,
      3,
      60,
      baseEffective.sessionDefaults.sectionDrillTimeMinutes ?? 8
    );
  }

  return patch;
}

/** Public per-account settings, daily plan, study data reset, flags, onboarding, and account deletion. */
export function registerStudentSettingsRoutes(app: Express, ctx: AppContext): void {
  const { repo } = ctx;

  app.get('/api/student/settings', requireStudentOrAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ctx.ensureSeeded();
      const studentId = req.auth!.studentId;
      const [configData, prefs, progressCounts, flags] = await Promise.all([
        repo.getActiveConfig(),
        repo.getLearnerPreferences(studentId),
        repo.getProgressCounts ? repo.getProgressCounts(studentId) : Promise.resolve(null),
        repo.listQuestionFlags(studentId),
      ]);

      const effectiveConfig = resolveEffectiveLearningConfig(configData.config, prefs);
      const { plan: dailyFocusPlan } = await getOrCreateDailyFocusPlan({
        repo,
        studentId,
        skillStates: () => repo.getSkillStates(studentId),
        evidenceMap: () => repo.getQuestionEvidence(studentId),
        questionMemory: () => repo.getQuestionMemory(studentId),
        questions: () => repo.listSelectionQuestions({ qcStatus: 'active' }),
        config: effectiveConfig,
      });

      res.json({
        studentId,
        role: req.auth!.role,
        email: req.auth!.email,
        effectiveConfig: extractLearnerDailyView(effectiveConfig),
        globalDefaults: extractLearnerDailyView(configData.config),
        preferences: prefs,
        adminOverrideLocked: Boolean(prefs?.adminOverrideLocked),
        dailyFocusPlan,
        progressCounts,
        flags,
        onboardingCompleted: Boolean(prefs?.onboardingCompletedAtIso),
      });
    } catch (err) {
      console.error('GET /api/student/settings error:', err);
      res.status(500).json({ error: 'Unable to load your settings.' });
    }
  });

  app.put('/api/student/settings/daily-plan', requireStudentOrAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ctx.ensureSeeded();
      const studentId = req.auth!.studentId;
      const [configData, existing] = await Promise.all([
        repo.getActiveConfig(),
        repo.getLearnerPreferences(studentId),
      ]);

      if (existing?.adminOverrideLocked && req.auth!.role !== 'admin') {
        res.status(403).json({
          error: 'Your daily practice settings are currently locked by a parent or tutor override.',
        });
        return;
      }

      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
      const baseEffective = resolveEffectiveLearningConfig(configData.config, existing);

      if (body.resetToDefaults === true) {
        const nextPrefs: LearnerPreferences = {
          onboardingCompletedAtIso: existing?.onboardingCompletedAtIso ?? null,
          updatedBy: req.auth!.role === 'admin' ? 'admin' : 'student',
        };
        const saved = await repo.saveLearnerPreferences(studentId, nextPrefs);
        const effectiveConfig = resolveEffectiveLearningConfig(configData.config, saved);
        res.json({
          ok: true,
          preferences: saved,
          effectiveConfig: extractLearnerDailyView(effectiveConfig),
          adminOverrideLocked: false,
        });
        return;
      }

      const patch = sanitizeDailyPlanPatch(body, baseEffective);
      const nextPrefs: LearnerPreferences = {
        ...(existing || {}),
        ...patch,
        updatedBy: req.auth!.role === 'admin' ? 'admin' : 'student',
      };
      const saved = await repo.saveLearnerPreferences(studentId, nextPrefs);
      const effectiveConfig = resolveEffectiveLearningConfig(configData.config, saved);

      res.json({
        ok: true,
        preferences: saved,
        effectiveConfig: extractLearnerDailyView(effectiveConfig),
        adminOverrideLocked: Boolean(saved.adminOverrideLocked),
      });
    } catch (err) {
      console.error('PUT /api/student/settings/daily-plan error:', err);
      res.status(500).json({ error: 'Unable to save daily practice settings.' });
    }
  });

  app.post('/api/student/settings/recalibrate', requireStudentOrAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ctx.ensureSeeded();
      const studentId = req.auth!.studentId;
      const [configData, existing, questions, skillStates, evidenceMap, questionMemory] = await Promise.all([
        repo.getActiveConfig(),
        repo.getLearnerPreferences(studentId),
        repo.listSelectionQuestions({ qcStatus: 'active' }),
        repo.getSkillStates(studentId),
        repo.getQuestionEvidence(studentId),
        repo.getQuestionMemory(studentId),
      ]);

      let activePrefs = existing;
      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
      if (
        body.autoCalibrate &&
        typeof body.autoCalibrate === 'object' &&
        (!existing?.adminOverrideLocked || req.auth!.role === 'admin')
      ) {
        const baseEffective = resolveEffectiveLearningConfig(configData.config, existing);
        const patch = sanitizeDailyPlanPatch(body, baseEffective);
        activePrefs = await repo.saveLearnerPreferences(studentId, {
          ...(existing || {}),
          ...patch,
          updatedBy: req.auth!.role === 'admin' ? 'admin' : 'student',
        });
      }

      const effectiveConfig = resolveEffectiveLearningConfig(configData.config, activePrefs);
      const result = await generateDailyFocusPlanStateless({
        studentId,
        skillStates,
        evidenceMap,
        questionMemory,
        questions,
        config: effectiveConfig,
      });
      await repo.saveDailyFocusPlan(studentId, result.plan);
      res.json({
        ...result,
        studentId,
        effectiveConfig: extractLearnerDailyView(effectiveConfig),
      });
    } catch (err) {
      console.error('POST /api/student/settings/recalibrate error:', err);
      res.status(500).json({ error: 'Unable to recalibrate your daily plan.' });
    }
  });

  app.post('/api/student/settings/onboarding', requireStudentOrAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ctx.ensureSeeded();
      const studentId = req.auth!.studentId;
      const completed = req.body?.completed !== false;
      const existing = await repo.getLearnerPreferences(studentId);
      const saved = await repo.saveLearnerPreferences(studentId, {
        ...(existing || {}),
        onboardingCompletedAtIso: completed ? new Date().toISOString() : null,
      });
      res.json({
        ok: true,
        onboardingCompleted: Boolean(saved.onboardingCompletedAtIso),
        onboardingCompletedAtIso: saved.onboardingCompletedAtIso ?? null,
      });
    } catch (err) {
      console.error('POST /api/student/settings/onboarding error:', err);
      res.status(500).json({ error: 'Unable to update onboarding status.' });
    }
  });

  app.get('/api/student/study-progress', requireStudentOrAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ctx.ensureSeeded();
      if (!repo.getProgressCounts) {
        res.status(501).json({ error: 'Study progress counts are unavailable.' });
        return;
      }
      const counts = await repo.getProgressCounts(req.auth!.studentId);
      res.json({ ...counts, studentId: req.auth!.studentId });
    } catch (err) {
      console.error('GET /api/student/study-progress error:', err);
      res.status(500).json({ error: 'Unable to load study data counts.' });
    }
  });

  app.post('/api/student/study-progress/reset', requireStudentOrAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ctx.ensureSeeded();
      if (!repo.resetStudentProgress) {
        res.status(501).json({ error: 'Study progress reset is unavailable.' });
        return;
      }
      const confirmation = String(req.body?.confirmation || '').trim().toUpperCase();
      if (confirmation !== 'RESET') {
        res.status(400).json({ error: 'Type RESET to confirm clearing your study progress.' });
        return;
      }
      const result = await repo.resetStudentProgress(req.auth!.studentId);
      res.json({ ...result, studentId: req.auth!.studentId });
    } catch (err) {
      console.error('POST /api/student/study-progress/reset error:', err);
      res.status(500).json({ error: 'Unable to reset study progress.' });
    }
  });

  app.get('/api/student/flags', requireStudentOrAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ctx.ensureSeeded();
      const flags = await repo.listQuestionFlags(req.auth!.studentId);
      res.json({ flags });
    } catch (err) {
      console.error('GET /api/student/flags error:', err);
      res.status(500).json({ error: 'Unable to load your question flags.' });
    }
  });

  app.delete('/api/student/account', requireStudentOrAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ctx.ensureSeeded();
      const confirmation = String(req.body?.confirmation || '').trim().toUpperCase();
      if (confirmation !== 'DELETE') {
        res.status(400).json({ error: 'Type DELETE to confirm deleting your account.' });
        return;
      }
      const studentId = req.auth!.studentId;
      const result = await repo.deleteUserAccount(studentId);
      clearAuthCookie(res, req);
      clearGoogleNonce(res, req);
      res.json({ ...result, studentId });
    } catch (err) {
      console.error('DELETE /api/student/account error:', err);
      res.status(500).json({ error: 'Unable to delete account right now.' });
    }
  });
}
