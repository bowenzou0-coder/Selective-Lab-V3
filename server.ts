import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import {
  attachAuth,
  clearAuthCookie,
  getAdminPassword,
  getStudentPin,
  requireAdmin,
  requireStudentOrAdmin,
  setAuthCookie,
  signSessionToken,
  type AuthenticatedRequest,
} from './src/server/auth.ts';
import {
  BOOTSTRAPPED_ADMIN_EMAIL,
  verifyFirebaseIdToken,
} from './src/server/firebaseVerify.ts';
import { evaluateWritingWithGemini } from './src/server/geminiWriting.ts';
import { validateAndDryRunManifest } from './src/server/manifestValidator.ts';
import { createRepository } from './src/server/storage/index.ts';
import type { SyncHydratePayload } from './src/server/storage/repository.ts';
import {
  DEFAULT_LEARNING_CONFIG,
  type BankImportManifest,
  type LearningConfig,
  type MarkingResult,
  type MockTestBatch,
  type PartAttemptRecord,
  type QuestionFlagRecord,
  type QuestionItem,
  type QuestionMemoryState,
  type SectionCode,
  type SessionMode,
  type SessionRecord,
  type SkillState,
  type StimulusGroup,
  type VisualSpec,
  type WritingDeterministicMetrics,
  type WritingEvaluationRecord,
} from './src/shared/contracts.ts';
import {
  computeWritingMetrics,
  detectPlateauStatus,
  getQuestionBatchTag,
  gradeSubmission,
  selectAdminCalibrationQuestions,
  selectMockTestQuestions,
  selectPracticeSession,
  toStudentQuestionView,
  updateSkillAndMemory,
} from './src/shared/engine.ts';
import { SKILLS_TAXONOMY } from './src/shared/skills.ts';
import { V3_MANIFEST_JSON_SCHEMA, V3_STARTER_MANIFEST_EXAMPLE } from './src/shared/v3Schema.ts';

dotenv.config();

const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = process.cwd();
const SEED_DIR = path.join(ROOT_DIR, 'seed');
const UPLOADS_DIR = path.join(ROOT_DIR, 'public', 'assets', 'uploads');

const repo = createRepository();
let seedPromise: Promise<void> | null = null;

async function readSeedManifest(filename: string): Promise<BankImportManifest | null> {
  try {
    const raw = await fs.readFile(path.join(SEED_DIR, filename), 'utf8');
    return JSON.parse(raw) as BankImportManifest;
  } catch (err) {
    console.warn(`Optional seed file ${filename} not loaded:`, err instanceof Error ? err.message : err);
    return null;
  }
}

async function ensureSeeded(): Promise<void> {
  if (!seedPromise) {
    seedPromise = (async () => {
      const smoke = await readSeedManifest('golden-smoke-pack.json');
      if (smoke) {
        await repo.initAndSeedIfEmpty(smoke);
      }
      const existing = await repo.listQuestions();
      const existingIds = new Set(existing.map((q) => q.questionId));
      // Seed official DoE calibration & holdout packs if not already imported
      if (!existingIds.has('q_off_pt1_read_q01_v1')) {
        const pt12 = await readSeedManifest('official-doe-pt1-2.json');
        if (pt12) await repo.importManifest(pt12);
      }
      if (!existingIds.has('q_off_pt3_read_q01_v1')) {
        const pt3 = await readSeedManifest('official-doe-pt3-holdout.json');
        if (pt3) await repo.importManifest(pt3);
      }
    })().catch((err) => {
      seedPromise = null;
      throw err;
    });
  }
  await seedPromise;
}

function getOfficialTimeLimitSec(sectionFilter?: SectionCode): number {
  if (sectionFilter === 'WRIT') return 1800;
  if (sectionFilter === 'READ' || sectionFilter === 'MATH' || sectionFilter === 'THINK') return 2400;
  return 9000;
}

function computeSessionStreak(sessions: SessionRecord[]): number {
  const completedDays = new Set<string>();
  for (const s of sessions) {
    if (s.status === 'submitted' && !s.isSandbox && s.completedAt) {
      completedDays.add(s.completedAt.slice(0, 10));
    }
  }
  if (completedDays.size === 0) return 0;
  let streak = 0;
  const cursor = new Date();
  const todayKey = cursor.toISOString().slice(0, 10);
  if (!completedDays.has(todayKey)) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  while (completedDays.has(cursor.toISOString().slice(0, 10))) {
    streak++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}

async function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '15mb' }));
  app.use(attachAuth);

  // Serve public assets cleanly
  app.use('/assets', express.static(path.join(ROOT_DIR, 'public', 'assets')));
  app.use('/fonts', express.static(path.join(ROOT_DIR, 'public', 'fonts')));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, backendName: repo.backendName });
  });

  // ---------------------------------------------------------------------------
  // Auth Routes
  // ---------------------------------------------------------------------------
  app.get('/api/auth/me', async (req: AuthenticatedRequest, res) => {
    if (!req.auth) {
      res.json({ authenticated: false, role: null, studentId: null, activeSessionId: null });
      return;
    }
    try {
      await ensureSeeded();
      const sessions = await repo.listSessions(50, req.auth.studentId);
      const active = sessions.find((s) => s.status === 'in_progress' && !s.isSandbox) || null;
      res.json({
        authenticated: true,
        role: req.auth.role,
        studentId: req.auth.studentId,
        activeSessionId: active?.sessionId ?? null,
      });
    } catch {
      res.json({
        authenticated: true,
        role: req.auth.role,
        studentId: req.auth.studentId,
        activeSessionId: null,
      });
    }
  });

  app.post('/api/auth/student-login', async (req, res) => {
    const pin = String(req.body?.pin ?? '').trim();
    if (!pin || pin !== getStudentPin()) {
      res.status(401).json({ error: 'Incorrect PIN. Please try again.' });
      return;
    }
    const studentId = 'default-student';
    const token = signSessionToken({ role: 'student', studentId });
    setAuthCookie(res, token, req);
    let activeSessionId: string | null = null;
    try {
      await ensureSeeded();
      const sessions = await repo.listSessions(50, studentId);
      activeSessionId = sessions.find((s) => s.status === 'in_progress' && !s.isSandbox)?.sessionId ?? null;
    } catch {
      // ignore
    }
    res.json({ authenticated: true, role: 'student', studentId, activeSessionId, token });
  });

  app.post('/api/auth/admin-login', (req, res) => {
    const password = String(req.body?.password ?? '');
    if (!password || password !== getAdminPassword()) {
      res.status(401).json({ error: 'Incorrect admin password.' });
      return;
    }
    const token = signSessionToken({ role: 'admin', studentId: 'default-student' });
    setAuthCookie(res, token, req);
    res.json({ authenticated: true, role: 'admin', studentId: 'default-student', activeSessionId: null, token });
  });

  app.post('/api/auth/firebase-login', async (req, res) => {
    const idToken = String(req.body?.idToken ?? '').trim();
    if (!idToken) {
      res.status(400).json({ error: 'Firebase ID token is required.' });
      return;
    }
    try {
      const decoded = await verifyFirebaseIdToken(idToken);
      const role: 'admin' | 'student' =
        decoded.email.toLowerCase() === BOOTSTRAPPED_ADMIN_EMAIL.toLowerCase()
          ? 'admin'
          : 'student';
      const studentId = decoded.uid;
      const token = signSessionToken({ role, studentId });
      setAuthCookie(res, token, req);
      let activeSessionId: string | null = null;
      try {
        await ensureSeeded();
        const sessions = await repo.listSessions(50, studentId);
        activeSessionId =
          sessions.find((s) => s.status === 'in_progress' && !s.isSandbox)?.sessionId ?? null;
      } catch {
        // ignore
      }
      res.json({ authenticated: true, role, studentId, activeSessionId, token });
    } catch (err) {
      res.status(401).json({
        error: err instanceof Error ? err.message : 'Invalid Firebase credentials.',
      });
    }
  });

  app.post('/api/sync/hydrate', requireStudentOrAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ensureSeeded();
      const raw = (req.body || {}) as SyncHydratePayload;
      const isAdmin = req.auth!.role === 'admin';
      const safePayload: SyncHydratePayload = {
        configVersions: raw.configVersions,
        questionOverrides: raw.questionOverrides,
        sessions: raw.sessions,
        attempts: raw.attempts,
        skillStates: raw.skillStates,
        questionMemory: raw.questionMemory,
        writingSubmissions: raw.writingSubmissions,
        stimuli: isAdmin ? raw.stimuli : undefined,
        questions: isAdmin ? raw.questions : undefined,
        flags: isAdmin ? raw.flags : undefined,
      };
      await repo.hydrateSyncData(req.auth!.studentId, safePayload);
      const sessions = await repo.listSessions(50, req.auth!.studentId);
      const activeSessionId =
        sessions.find((s) => s.status === 'in_progress' && !s.isSandbox)?.sessionId ?? null;
      res.json({ ok: true, activeSessionId });
    } catch (err) {
      console.error('POST /api/sync/hydrate error:', err);
      res.status(500).json({ error: 'Failed to hydrate synced state.' });
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    clearAuthCookie(res, req);
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // Student APIs (/api/student/*)
  // ---------------------------------------------------------------------------
  app.get('/api/student/dashboard', requireStudentOrAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ensureSeeded();
      const studentId = req.auth!.studentId;
      const [configData, sessions, attempts, questions] = await Promise.all([
        repo.getActiveConfig(),
        repo.listSessions(100, studentId),
        repo.listPartAttempts(500, studentId),
        repo.listQuestions({ qcStatus: 'active' }),
      ]);

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
      for (const q of questions) {
        const tag = getQuestionBatchTag(q);
        if (tag === 'PT1' || tag === 'PT2' || tag === 'PT3') {
          batchCounts[tag][q.section] += 1;
        }
      }

      const activeInProgress = sessions.find((s) => s.status === 'in_progress' && !s.isSandbox) || null;

      res.json({
        studentId,
        streakDays: computeSessionStreak(sessions),
        dailyGoalMinutes: configData.config.sessionDefaults.dailyGoalMinutes,
        sectionDrillQuestionCount: configData.config.sessionDefaults.sectionDrillQuestionCount ?? 10,
        sectionDrillTimeMinutes: configData.config.sessionDefaults.sectionDrillTimeMinutes ?? 8,
        todayMinutes,
        todaySlotsAttempted: todayAttempts.length,
        todaySlotsCorrect: todayCorrect,
        dailyLimits: configData.config.sessionDefaults.dailyQuestionLimitBySection,
        batchCounts,
        activeSession: activeInProgress,
        recentSessions: sessions.filter((s) => !s.isSandbox).slice(0, 8),
      });
    } catch (err) {
      console.error('GET /api/student/dashboard error:', err);
      res.status(500).json({ error: 'Failed to load student dashboard.' });
    }
  });

  app.post('/api/student/sessions', requireStudentOrAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ensureSeeded();
      const studentId = req.auth!.studentId;
      const mode = String(req.body?.mode || 'daily_adaptive') as SessionMode;
      const sectionFilter = req.body?.sectionFilter as SectionCode | undefined;
      const mockBatch = req.body?.mockBatch as MockTestBatch | undefined;
      const timeMultiplier =
        req.body?.timeMultiplier !== undefined ? Number(req.body.timeMultiplier) : 1;
      const customTimeLimitSec =
        req.body?.customTimeLimitSec !== undefined ? Number(req.body.customTimeLimitSec) : undefined;

      if (mode === 'admin_calibration') {
        res.status(403).json({ error: 'Admin calibration sessions must be created via /api/admin/calibration/session.' });
        return;
      }

      const [existingSessions, configData, allQuestions, skillStates, questionMemory] = await Promise.all([
        repo.listSessions(50, studentId),
        repo.getActiveConfig(),
        repo.listQuestions(),
        repo.getSkillStates(studentId),
        repo.getQuestionMemory(studentId),
      ]);

      const existingActive = existingSessions.find((s) => s.status === 'in_progress' && !s.isSandbox);
      if (existingActive) {
        res.status(409).json({
          error: 'Only one active test is allowed per account at a time. Complete and submit your current test first.',
          activeSessionId: existingActive.sessionId,
        });
        return;
      }

      let selected: QuestionItem[] = [];
      let title = '';
      let effectiveMode: SessionMode = mode;
      let timeLimitSec = 1500;

      if (mockBatch) {
        if (mockBatch === 'PT3') {
          effectiveMode = 'benchmark_exam';
        }
        selected = selectMockTestQuestions({
          batch: mockBatch,
          sectionFilter,
          questions: allQuestions,
        });
        const baseSec = getOfficialTimeLimitSec(sectionFilter);
        if (customTimeLimitSec !== undefined && !Number.isNaN(customTimeLimitSec)) {
          timeLimitSec = Math.max(0, Math.round(customTimeLimitSec));
        } else {
          timeLimitSec = timeMultiplier <= 0 ? 0 : Math.round(baseSec * timeMultiplier);
        }
        title = `${mockBatch} Mock${sectionFilter ? ` · ${sectionFilter}` : ' · Full Test'}`;
      } else if (mode === 'benchmark_exam') {
        selected = selectMockTestQuestions({
          batch: 'PT3',
          sectionFilter,
          questions: allQuestions,
        });
        const baseSec = getOfficialTimeLimitSec(sectionFilter);
        timeLimitSec =
          customTimeLimitSec !== undefined
            ? Math.max(0, Math.round(customTimeLimitSec))
            : Math.round(baseSec * (timeMultiplier > 0 ? timeMultiplier : 1));
        title = `PT3 Benchmark Holdout${sectionFilter ? ` · ${sectionFilter}` : ''}`;
      } else {
        const effectiveSection: SectionCode | undefined =
          mode === 'writing_sprint' ? 'WRIT' : sectionFilter;
        selected = selectPracticeSession({
          mode,
          sectionFilter: effectiveSection,
          questions: allQuestions,
          skillStates,
          questionMemory,
          config: configData.config,
          nowIso: new Date().toISOString(),
          seed: Date.now() & 0xfffffff,
        });
        if (mode === 'writing_sprint') {
          selected = selected.slice(0, 1);
          timeLimitSec = 1800;
          title = 'Writing Sprint (30 min)';
        } else if (effectiveSection) {
          const drillMin = Math.max(1, configData.config.sessionDefaults.sectionDrillTimeMinutes ?? 8);
          timeLimitSec = effectiveSection === 'WRIT' ? 1800 : drillMin * 60;
          title = `${effectiveSection} Practice Drill (${selected.length} Qs · ${
            effectiveSection === 'WRIT' ? 30 : drillMin
          } min)`;
        } else {
          timeLimitSec = configData.config.sessionDefaults.dailyGoalMinutes * 60;
          title = "Today's Adaptive Practice";
        }
        if (customTimeLimitSec !== undefined && !Number.isNaN(customTimeLimitSec)) {
          timeLimitSec = Math.max(0, Math.round(customTimeLimitSec));
        }
      }

      if (selected.length === 0) {
        res.status(400).json({ error: 'No active questions matched the requested session criteria.' });
        return;
      }

      const totalSlots = selected.reduce((sum, q) => sum + q.parts.length, 0);
      const session: SessionRecord = {
        sessionId: `sess_${crypto.randomUUID().slice(0, 12)}`,
        studentId,
        configVersionId: configData.configVersionId,
        mode: effectiveMode,
        sectionFilter,
        title,
        isSandbox: false,
        mockBatch,
        timeMultiplier,
        status: 'in_progress',
        plannedQuestionIds: selected.map((q) => q.questionId),
        checkpoint: {
          currentIndex: 0,
          elapsedSec: 0,
          answersByPartId: {},
          flaggedQuestionIds: [],
          eliminatedOptionsByPartId: {},
          passageHighlightsByStimulusId: {},
          writingDraft: { planNotes: '', responseText: '' },
        },
        timeLimitSec: timeLimitSec > 0 ? timeLimitSec : undefined,
        totalSlots,
        correctSlots: 0,
        startedAt: new Date().toISOString(),
      };

      await repo.createSession(session);
      res.status(201).json({ sessionId: session.sessionId, session });
    } catch (err) {
      console.error('POST /api/student/sessions error:', err);
      res.status(500).json({ error: 'Failed to create practice session.' });
    }
  });

  app.get('/api/student/sessions/:id', requireStudentOrAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ensureSeeded();
      const session = await repo.getSession(req.params.id);
      if (!session) {
        res.status(404).json({ error: 'Session not found.' });
        return;
      }
      if (session.studentId && session.studentId !== req.auth!.studentId && req.auth!.role !== 'admin') {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      const questionPairs = await Promise.all(
        session.plannedQuestionIds.map((qid) => repo.getQuestionWithStimulus(qid))
      );
      const validPairs = questionPairs.filter(
        (pair): pair is { question: QuestionItem; stimulus?: StimulusGroup } => pair !== null
      );

      // ZERO ANSWER KEY LEAKAGE: always convert to StudentQuestionView
      const questions = validPairs.map((pair) => toStudentQuestionView(pair.question, pair.stimulus));

      let reviewResults: Record<string, MarkingResult[]> | undefined;
      let writingReview:
        | {
            submissionId: string;
            questionId: string;
            metrics: WritingDeterministicMetrics;
            evaluations: WritingEvaluationRecord[];
          }[]
        | undefined;

      if (session.status === 'submitted') {
        const answers = session.checkpoint?.answersByPartId ?? {};
        reviewResults = {};
        for (const pair of validPairs) {
          const { results } = gradeSubmission(pair.question, answers);
          reviewResults[pair.question.questionId] = results;
        }
        const allSubs = await repo.listWritingSubmissions(session.studentId || req.auth!.studentId);
        const sessionSubs = allSubs.filter((s) => s.sessionId === session.sessionId);
        if (sessionSubs.length > 0) {
          writingReview = sessionSubs.map((s) => ({
            submissionId: s.submissionId,
            questionId: s.questionId,
            metrics: JSON.parse(s.deterministicMetricsJson) as WritingDeterministicMetrics,
            evaluations: s.evaluations,
          }));
        }
      }

      res.json({
        session,
        questions,
        reviewResults,
        writingReview,
      });
    } catch (err) {
      console.error('GET /api/student/sessions/:id error:', err);
      res.status(500).json({ error: 'Failed to load session.' });
    }
  });

  app.patch('/api/student/sessions/:id/checkpoint', requireStudentOrAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ensureSeeded();
      const session = await repo.getSession(req.params.id);
      if (!session) {
        res.status(404).json({ error: 'Session not found.' });
        return;
      }
      if (session.status !== 'in_progress') {
        res.status(409).json({ error: 'Session already submitted.' });
        return;
      }
      const cp = req.body?.checkpoint as NonNullable<SessionRecord['checkpoint']>;
      if (!cp || typeof cp !== 'object') {
        res.status(400).json({ error: 'Invalid checkpoint payload.' });
        return;
      }
      await repo.saveSessionCheckpoint(session.sessionId, cp);
      res.json({ ok: true });
    } catch (err) {
      console.error('PATCH /api/student/sessions/:id/checkpoint error:', err);
      res.status(500).json({ error: 'Failed to save checkpoint.' });
    }
  });

  app.post('/api/student/sessions/:id/submit', requireStudentOrAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ensureSeeded();
      const session = await repo.getSession(req.params.id);
      if (!session) {
        res.status(404).json({ error: 'Session not found.' });
        return;
      }
      if (session.status === 'submitted') {
        res.status(409).json({ error: 'Session has already been submitted.' });
        return;
      }

      const incomingCheckpoint = req.body?.checkpoint as SessionRecord['checkpoint'] | undefined;
      if (incomingCheckpoint) {
        await repo.saveSessionCheckpoint(session.sessionId, incomingCheckpoint);
      }
      const cp = incomingCheckpoint || session.checkpoint || {
        currentIndex: 0,
        elapsedSec: 0,
        answersByPartId: {},
        flaggedQuestionIds: [],
      };
      const answersByPartId = cp.answersByPartId || {};

      const questionPairs = await Promise.all(
        session.plannedQuestionIds.map((qid) => repo.getQuestionWithStimulus(qid))
      );
      const validPairs = questionPairs.filter(
        (pair): pair is { question: QuestionItem; stimulus?: StimulusGroup } => pair !== null
      );

      const allValidationErrors: string[] = [];
      const reviewResults: Record<string, MarkingResult[]> = {};

      for (const { question } of validPairs) {
        if (question.formatType === 'WRIT_TYPED_TASK') {
          reviewResults[question.questionId] = [];
          continue;
        }
        const { results, validationErrors } = gradeSubmission(question, answersByPartId);
        if (validationErrors.length > 0) {
          allValidationErrors.push(...validationErrors);
        }
        reviewResults[question.questionId] = results;
      }

      if (allValidationErrors.length > 0) {
        res.status(400).json({ error: allValidationErrors.join(' ') });
        return;
      }

      const studentId = session.studentId || req.auth!.studentId;
      const nowIso = new Date().toISOString();
      const [configData, skillStates, questionMemory, pastAttempts] = await Promise.all([
        repo.getActiveConfig(),
        repo.getSkillStates(studentId),
        repo.getQuestionMemory(studentId),
        repo.listPartAttempts(500, studentId),
      ]);

      const totalPartsCount = validPairs.reduce((acc, p) => acc + p.question.parts.length, 0);
      const perPartTimeSec = Math.max(
        5,
        Math.round((cp.elapsedSec || 60) / Math.max(1, totalPartsCount))
      );

      const newAttempts: PartAttemptRecord[] = [];
      const updatedSkillsMap = new Map<string, SkillState>();
      const updatedMemoryMap = new Map<string, QuestionMemoryState>();
      const writingReview: {
        submissionId: string;
        questionId: string;
        metrics: WritingDeterministicMetrics;
        evaluations: WritingEvaluationRecord[];
      }[] = [];

      let totalObjectiveSlots = 0;
      let correctObjectiveSlots = 0;

      let savedWritingSubmission:
        | {
            submissionId: string;
            sessionId: string;
            questionId: string;
            planNotes: string;
            responseText: string;
            wordCount: number;
            timeSpentSec: number;
            deterministicMetricsJson: string;
            submittedAt: string;
            evaluations: WritingEvaluationRecord[];
          }
        | undefined;

      for (const { question } of validPairs) {
        if (question.formatType === 'WRIT_TYPED_TASK') {
          const responseText = cp.writingDraft?.responseText || '';
          const planNotes = cp.writingDraft?.planNotes || '';
          const spec = question.writingSpec || {
            genre: 'essay',
            audience: 'General',
            purpose: 'Inform',
            recommendedWordRange: [200, 450],
            timeLimitSec: 1800,
          };
          const metrics = computeWritingMetrics(spec, responseText);
          const submissionId = `wsub_${crypto.randomUUID().slice(0, 12)}`;
          const subRecord = {
            submissionId,
            studentId: session.isSandbox ? `sandbox:${studentId}` : studentId,
            sessionId: session.sessionId,
            questionId: question.questionId,
            planNotes,
            responseText,
            wordCount: metrics.wordCount,
            timeSpentSec: cp.elapsedSec || 0,
            deterministicMetricsJson: JSON.stringify(metrics),
            submittedAt: nowIso,
          };
          await repo.saveWritingSubmission(subRecord);
          if (!session.isSandbox) {
            savedWritingSubmission = {
              submissionId: subRecord.submissionId,
              sessionId: subRecord.sessionId,
              questionId: subRecord.questionId,
              planNotes: subRecord.planNotes,
              responseText: subRecord.responseText,
              wordCount: subRecord.wordCount,
              timeSpentSec: subRecord.timeSpentSec,
              deterministicMetricsJson: subRecord.deterministicMetricsJson,
              submittedAt: subRecord.submittedAt,
              evaluations: [],
            };
          }
          writingReview.push({
            submissionId,
            questionId: question.questionId,
            metrics,
            evaluations: [],
          });
          continue;
        }

        const qResults = reviewResults[question.questionId] || [];
        const allPartsCorrect = qResults.length > 0 && qResults.every((r) => r.isCorrect);
        const prevMem = updatedMemoryMap.get(question.questionFamilyId) || questionMemory[question.questionFamilyId];
        const isSpacedReview = Boolean(prevMem && Date.parse(prevMem.nextDueAt) <= Date.now());

        for (let i = 0; i < question.parts.length; i++) {
          const part = question.parts[i];
          const resItem = qResults.find((r) => r.partId === part.partId);
          const isCorrect = Boolean(resItem?.isCorrect);
          totalObjectiveSlots++;
          if (isCorrect) correctObjectiveSlots++;

          newAttempts.push({
            attemptId: `att_${crypto.randomUUID().slice(0, 12)}`,
            studentId,
            sessionId: session.sessionId,
            questionId: question.questionId,
            questionFamilyId: question.questionFamilyId,
            partId: part.partId,
            skillId: part.skillId,
            difficultyAtAttempt: part.difficultyCalibrated ?? part.difficultyInitial,
            selectedAnswer: resItem?.selectedAnswer ?? null,
            isCorrect,
            timeSpentSec: perPartTimeSec,
            isSpacedReview,
            isSandbox: Boolean(session.isSandbox),
            createdAt: nowIso,
          });

          if (!session.isSandbox) {
            const prevSkill = updatedSkillsMap.get(part.skillId) || skillStates[part.skillId];
            const { nextSkillState, nextMemory } = updateSkillAndMemory({
              prevSkillState: prevSkill,
              prevMemory: updatedMemoryMap.get(question.questionFamilyId) || prevMem,
              skillId: part.skillId,
              questionFamilyId: question.questionFamilyId,
              isCorrect,
              allPartsCorrect,
              timeSpentSec: perPartTimeSec,
              targetTimeSec: part.targetTimeSec,
              config: configData.config,
              nowIso,
            });

            const recentForSkill = [
              isCorrect,
              ...pastAttempts.filter((a) => a.skillId === part.skillId).map((a) => a.isCorrect),
            ];
            nextSkillState.plateauStatus = detectPlateauStatus({
              recentIsCorrectDesc: recentForSkill,
              ewmaAccuracy: nextSkillState.ewmaAccuracy,
              config: configData.config,
            });

            updatedSkillsMap.set(part.skillId, nextSkillState);
            updatedMemoryMap.set(question.questionFamilyId, nextMemory);
          }
        }
      }

      const savedSkillStates = !session.isSandbox ? Array.from(updatedSkillsMap.values()) : [];
      const savedQuestionMemory = !session.isSandbox ? Array.from(updatedMemoryMap.values()) : [];
      const savedAttempts = !session.isSandbox ? newAttempts : [];

      if (!session.isSandbox) {
        if (savedAttempts.length > 0) await repo.appendPartAttempts(savedAttempts);
        if (savedSkillStates.length > 0) await repo.upsertSkillStates(savedSkillStates, studentId);
        if (savedQuestionMemory.length > 0) await repo.upsertQuestionMemory(savedQuestionMemory, studentId);
      }

      await repo.completeSession(session.sessionId, {
        correctSlots: correctObjectiveSlots,
        totalSlots: totalObjectiveSlots,
        completedAt: nowIso,
      });

      res.json({
        ok: true,
        correctSlots: correctObjectiveSlots,
        totalSlots: totalObjectiveSlots,
        completedAt: nowIso,
        checkpoint: cp,
        attempts: savedAttempts,
        skillStates: savedSkillStates,
        questionMemory: savedQuestionMemory,
        writingSubmission: savedWritingSubmission,
        reviewResults,
        writingReview,
      });
    } catch (err) {
      console.error('POST /api/student/sessions/:id/submit error:', err);
      res.status(500).json({ error: 'Failed to submit session.' });
    }
  });

  app.post('/api/student/writing/:submissionId/evaluate', requireStudentOrAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ensureSeeded();
      const sub = await repo.getWritingSubmission(req.params.submissionId);
      if (!sub) {
        res.status(404).json({ error: 'Writing submission not found.' });
        return;
      }
      const pair = await repo.getQuestionWithStimulus(sub.questionId);
      if (!pair) {
        res.status(404).json({ error: 'Question not found.' });
        return;
      }
      const metrics = JSON.parse(sub.deterministicMetricsJson) as WritingDeterministicMetrics;
      const evaluation = await evaluateWritingWithGemini({
        submissionId: sub.submissionId,
        question: pair.question,
        stimulus: pair.stimulus,
        planNotes: sub.planNotes,
        responseText: sub.responseText,
        metrics,
      });
      await repo.saveWritingEvaluation(evaluation);
      const updated = await repo.getWritingSubmission(sub.submissionId);
      res.json({ evaluation, evaluations: updated?.evaluations || [evaluation] });
    } catch (err) {
      console.error('POST /api/student/writing/:submissionId/evaluate error:', err);
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Failed to evaluate writing with Gemini.',
      });
    }
  });

  app.post('/api/student/flags', requireStudentOrAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ensureSeeded();
      const questionId = String(req.body?.questionId || '').trim();
      const sessionId = String(req.body?.sessionId || '').trim();
      const reason = String(req.body?.reason || '').trim();
      const notes = req.body?.notes ? String(req.body.notes).trim() : undefined;
      if (!questionId || !reason) {
        res.status(400).json({ error: 'questionId and reason are required.' });
        return;
      }
      const flag: QuestionFlagRecord = {
        flagId: `flg_${crypto.randomUUID().slice(0, 10)}`,
        questionId,
        sessionId,
        studentId: req.auth!.studentId,
        reason,
        notes,
        status: 'open',
        createdAt: new Date().toISOString(),
      };
      await repo.saveQuestionFlag(flag);
      res.status(201).json({ flag });
    } catch (err) {
      console.error('POST /api/student/flags error:', err);
      res.status(500).json({ error: 'Failed to submit question flag.' });
    }
  });

  app.get('/api/student/progress', requireStudentOrAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ensureSeeded();
      const studentId = req.auth!.studentId;
      const [attempts, skillStates, sessions, writingSubmissions, questions] = await Promise.all([
        repo.listPartAttempts(2000, studentId),
        repo.getSkillStates(studentId),
        repo.listSessions(100, studentId),
        repo.listWritingSubmissions(studentId),
        repo.listQuestions(),
      ]);

      const questionMap = new Map(questions.map((q) => [q.questionId, q]));
      const partTargetMap = new Map<string, { section: SectionCode; targetTimeSec: number }>();
      for (const q of questions) {
        for (const p of q.parts) {
          partTargetMap.set(p.partId, { section: q.section, targetTimeSec: p.targetTimeSec });
        }
      }

      const sectionStats: Record<
        SectionCode,
        { attempts: number; correct: number; avgTimeSec: number; targetTimeSec: number }
      > = {
        READ: { attempts: 0, correct: 0, avgTimeSec: 0, targetTimeSec: 0 },
        MATH: { attempts: 0, correct: 0, avgTimeSec: 0, targetTimeSec: 0 },
        THINK: { attempts: 0, correct: 0, avgTimeSec: 0, targetTimeSec: 0 },
        WRIT: { attempts: 0, correct: 0, avgTimeSec: 0, targetTimeSec: 1800 },
      };

      const secTimeSums: Record<SectionCode, { spent: number; target: number }> = {
        READ: { spent: 0, target: 0 },
        MATH: { spent: 0, target: 0 },
        THINK: { spent: 0, target: 0 },
        WRIT: { spent: 0, target: 0 },
      };

      for (const a of attempts) {
        const meta = partTargetMap.get(a.partId);
        const sec = meta?.section || questionMap.get(a.questionId)?.section || 'MATH';
        sectionStats[sec].attempts++;
        if (a.isCorrect) sectionStats[sec].correct++;
        secTimeSums[sec].spent += a.timeSpentSec;
        secTimeSums[sec].target += meta?.targetTimeSec ?? 60;
      }

      for (const sec of ['READ', 'MATH', 'THINK', 'WRIT'] as SectionCode[]) {
        const cnt = sectionStats[sec].attempts;
        if (cnt > 0) {
          sectionStats[sec].avgTimeSec = Math.round(secTimeSums[sec].spent / cnt);
          sectionStats[sec].targetTimeSec = Math.round(secTimeSums[sec].target / cnt);
        } else {
          sectionStats[sec].targetTimeSec = sec === 'WRIT' ? 1800 : 60;
        }
      }

      const skills = SKILLS_TAXONOMY.map((def) => ({
        ...def,
        state: skillStates[def.skillId] || null,
      }));

      res.json({
        sectionStats,
        skills,
        sessions: sessions.filter((s) => !s.isSandbox),
        writingSubmissions,
        totalAttempts: attempts.length,
      });
    } catch (err) {
      console.error('GET /api/student/progress error:', err);
      res.status(500).json({ error: 'Failed to load progress data.' });
    }
  });

  app.get('/api/student/export', requireStudentOrAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ensureSeeded();
      const studentId = req.auth!.studentId;
      const format = String(req.query.format || 'json');
      const [attempts, skillStates, sessions, writingSubmissions] = await Promise.all([
        repo.listPartAttempts(5000, studentId),
        repo.getSkillStates(studentId),
        repo.listSessions(500, studentId),
        repo.listWritingSubmissions(studentId),
      ]);

      if (format === 'csv') {
        const headers = ['attemptId', 'sessionId', 'questionId', 'partId', 'skillId', 'selectedAnswer', 'isCorrect', 'timeSpentSec', 'createdAt'];
        const rows = attempts.map((a) =>
          [a.attemptId, a.sessionId, a.questionId, a.partId, a.skillId, a.selectedAnswer ?? '', a.isCorrect, a.timeSpentSec, a.createdAt]
            .map((v) => `"${String(v).replace(/"/g, '""')}"`)
            .join(',')
        );
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="selective-lab-progress.csv"');
        res.send([headers.join(','), ...rows].join('\n'));
        return;
      }

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename="selective-lab-progress.json"');
      res.send(JSON.stringify({ exportedAt: new Date().toISOString(), studentId, sessions, skillStates, attempts, writingSubmissions }, null, 2));
    } catch (err) {
      console.error('GET /api/student/export error:', err);
      res.status(500).json({ error: 'Failed to export progress.' });
    }
  });

  // ---------------------------------------------------------------------------
  // Admin APIs (/api/admin/*) — Strictly 403 for student cookies!
  // ---------------------------------------------------------------------------
  app.get('/api/admin/status', requireAdmin, async (_req, res) => {
    try {
      await ensureSeeded();
      const [questions, configData, flags, sessions] = await Promise.all([
        repo.listQuestions(),
        repo.getActiveConfig(),
        repo.listQuestionFlags(),
        repo.listSessions(500),
      ]);

      const holdoutIds = new Set(questions.filter((q) => q.poolType === 'benchmark_holdout').map((q) => q.questionId));
      let leakedCount = 0;
      for (const s of sessions) {
        if (s.mode !== 'benchmark_exam' && s.mode !== 'admin_calibration') {
          for (const qid of s.plannedQuestionIds) {
            if (holdoutIds.has(qid)) leakedCount++;
          }
        }
      }

      const byPool: Record<string, number> = {};
      const bySection: Record<string, number> = {};
      const byQcStatus: Record<string, number> = {};
      for (const q of questions) {
        byPool[q.poolType] = (byPool[q.poolType] || 0) + 1;
        bySection[q.section] = (bySection[q.section] || 0) + 1;
        byQcStatus[q.qcStatus] = (byQcStatus[q.qcStatus] || 0) + 1;
      }

      res.json({
        backendName: repo.backendName,
        isEphemeralPreview: repo.backendName === 'memory_preview',
        totalQuestions: questions.length,
        byPool,
        bySection,
        byQcStatus,
        holdoutIsolationOk: leakedCount === 0,
        holdoutQuestionCount: holdoutIds.size,
        leakedCount,
        openFlagsCount: flags.filter((f) => f.status === 'open').length,
        activeConfigVersion: configData.versionNumber,
      });
    } catch (err) {
      console.error('GET /api/admin/status error:', err);
      res.status(500).json({ error: 'Failed to load admin status.' });
    }
  });

  app.get('/api/admin/questions', requireAdmin, async (req, res) => {
    try {
      await ensureSeeded();
      const questions = await repo.listQuestions({
        section: req.query.section ? String(req.query.section) : undefined,
        poolType: req.query.poolType ? String(req.query.poolType) : undefined,
        qcStatus: req.query.qcStatus ? String(req.query.qcStatus) : undefined,
      });
      const stimulusIds = new Set(questions.map((q) => q.stimulusId).filter((x): x is string => Boolean(x)));
      const stimuliMap: Record<string, StimulusGroup> = {};
      for (const q of questions) {
        if (q.stimulusId && !stimuliMap[q.stimulusId] && stimulusIds.has(q.stimulusId)) {
          const pair = await repo.getQuestionWithStimulus(q.questionId);
          if (pair?.stimulus) stimuliMap[q.stimulusId] = pair.stimulus;
        }
      }
      res.json({ questions, stimuliById: stimuliMap });
    } catch (err) {
      console.error('GET /api/admin/questions error:', err);
      res.status(500).json({ error: 'Failed to load admin questions.' });
    }
  });

  app.patch('/api/admin/questions/:id/status', requireAdmin, async (req, res) => {
    try {
      await ensureSeeded();
      const qcStatus = req.body?.qcStatus as QuestionItem['qcStatus'];
      const allowed = new Set(['draft', 'verified', 'active', 'quarantined', 'retired']);
      if (!allowed.has(qcStatus)) {
        res.status(400).json({ error: 'Invalid qcStatus.' });
        return;
      }
      await repo.updateQuestionStatus(req.params.id, qcStatus);
      res.json({ ok: true });
    } catch (err) {
      console.error('PATCH /api/admin/questions/:id/status error:', err);
      res.status(500).json({ error: 'Failed to update question QC status.' });
    }
  });

  app.post('/api/admin/questions/:id/visual', requireAdmin, async (req, res) => {
    try {
      await ensureSeeded();
      const questionId = req.params.id;
      const altText = String(req.body?.altText || 'Question visual').trim();
      const caption = req.body?.caption ? String(req.body.caption).trim() : undefined;

      let visual: VisualSpec | null = null;
      if (req.body?.imageBase64 && req.body?.filename) {
        await fs.mkdir(UPLOADS_DIR, { recursive: true });
        const safeExt = path.extname(String(req.body.filename)).toLowerCase() || '.png';
        if (!['.png', '.jpg', '.jpeg', '.webp', '.svg'].includes(safeExt)) {
          res.status(400).json({ error: 'Unsupported image file extension.' });
          return;
        }
        const outName = `${questionId.replace(/[^a-zA-Z0-9_-]/g, '_')}_${Date.now()}${safeExt}`;
        const rawB64 = String(req.body.imageBase64).replace(/^data:[^;]+;base64,/, '');
        await fs.writeFile(path.join(UPLOADS_DIR, outName), Buffer.from(rawB64, 'base64'));
        visual = {
          visualType: 'image_asset',
          altText,
          caption,
          imageUrl: `/assets/uploads/${outName}`,
        };
      } else if (req.body?.visual) {
        visual = req.body.visual as VisualSpec;
      }

      if (!visual) {
        res.status(400).json({ error: 'Provide either an uploaded image or a VisualSpec payload.' });
        return;
      }

      await repo.updateQuestionVisual(questionId, visual);
      const updatedPair = await repo.getQuestionWithStimulus(questionId);
      res.json({ ok: true, visual, qcStatus: updatedPair?.question.qcStatus || 'active' });
    } catch (err) {
      console.error('POST /api/admin/questions/:id/visual error:', err);
      res.status(500).json({ error: 'Failed to attach visual asset.' });
    }
  });

  app.post('/api/admin/calibration/session', requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ensureSeeded();
      const [configData, allQuestions] = await Promise.all([
        repo.getActiveConfig(),
        repo.listQuestions(),
      ]);

      const selected = selectAdminCalibrationQuestions({
        questions: allQuestions,
        section: req.body?.section || undefined,
        poolType: req.body?.poolType || undefined,
        qcStatus: req.body?.qcStatus || undefined,
        formatType: req.body?.formatType || undefined,
        skillFamily: req.body?.skillFamily || undefined,
        skillId: req.body?.skillId || undefined,
        batch: req.body?.batch || undefined,
        limit: req.body?.limit ? Number(req.body.limit) : 15,
      });

      if (selected.length === 0) {
        res.status(400).json({ error: 'No questions matched your calibration filters.' });
        return;
      }

      const customTimeLimitSec =
        req.body?.customTimeLimitSec !== undefined ? Number(req.body.customTimeLimitSec) : 0;
      const isSandbox = req.body?.isSandbox !== undefined ? Boolean(req.body.isSandbox) : true;
      const totalSlots = selected.reduce((sum, q) => sum + q.parts.length, 0);

      const session: SessionRecord = {
        sessionId: `cal_${crypto.randomUUID().slice(0, 12)}`,
        studentId: req.auth!.studentId,
        configVersionId: configData.configVersionId,
        mode: 'admin_calibration',
        sectionFilter: req.body?.section || undefined,
        title: `Admin Calibration (${selected.length} Qs${isSandbox ? ' · Sandbox' : ''})`,
        isSandbox,
        status: 'in_progress',
        plannedQuestionIds: selected.map((q) => q.questionId),
        checkpoint: {
          currentIndex: 0,
          elapsedSec: 0,
          answersByPartId: {},
          flaggedQuestionIds: [],
          eliminatedOptionsByPartId: {},
          passageHighlightsByStimulusId: {},
          writingDraft: { planNotes: '', responseText: '' },
        },
        timeLimitSec: customTimeLimitSec > 0 ? Math.round(customTimeLimitSec) : undefined,
        totalSlots,
        correctSlots: 0,
        startedAt: new Date().toISOString(),
      };

      await repo.createSession(session);
      res.status(201).json({ sessionId: session.sessionId, count: selected.length, session });
    } catch (err) {
      console.error('POST /api/admin/calibration/session error:', err);
      res.status(500).json({ error: 'Failed to create calibration session.' });
    }
  });

  app.get('/api/admin/calibration/session/:id', requireAdmin, async (req, res) => {
    try {
      await ensureSeeded();
      const session = await repo.getSession(req.params.id);
      if (!session) {
        res.status(404).json({ error: 'Calibration session not found.' });
        return;
      }
      const pairs = await Promise.all(
        session.plannedQuestionIds.map((qid) => repo.getQuestionWithStimulus(qid))
      );
      const inspectorByQuestionId: Record<string, QuestionItem> = {};
      for (const pair of pairs) {
        if (pair) inspectorByQuestionId[pair.question.questionId] = pair.question;
      }
      res.json({ inspectorByQuestionId });
    } catch (err) {
      console.error('GET /api/admin/calibration/session/:id error:', err);
      res.status(500).json({ error: 'Failed to fetch calibration inspector metadata.' });
    }
  });

  app.post('/api/admin/import/dry-run', requireAdmin, async (req, res) => {
    try {
      await ensureSeeded();
      const existing = await repo.listQuestions();
      const { report } = validateAndDryRunManifest(req.body?.manifest, existing);
      res.json({ report });
    } catch (err) {
      console.error('POST /api/admin/import/dry-run error:', err);
      res.status(500).json({ error: 'Dry-run validation failed.' });
    }
  });

  app.post('/api/admin/import/commit', requireAdmin, async (req, res) => {
    try {
      await ensureSeeded();
      const existing = await repo.listQuestions();
      const { manifest, report } = validateAndDryRunManifest(req.body?.manifest, existing);
      if (!manifest || !report.valid) {
        res.status(400).json({ error: 'Manifest failed validation.', report });
        return;
      }
      const result = await repo.importManifest(manifest);
      const allLatest = await repo.listQuestions();
      const committedFamilies = new Set(manifest.questions.map((q) => q.questionFamilyId));
      const committedQuestions = allLatest.filter((q) => committedFamilies.has(q.questionFamilyId));
      const committedManifest: BankImportManifest = {
        ...manifest,
        questions: committedQuestions.length > 0 ? committedQuestions : manifest.questions,
      };
      res.json({ ok: true, result, report, manifest: committedManifest });
    } catch (err) {
      console.error('POST /api/admin/import/commit error:', err);
      res.status(500).json({ error: 'Manifest import failed.' });
    }
  });

  app.get('/api/admin/import/schema', requireAdmin, (_req, res) => {
    res.json({
      schema: V3_MANIFEST_JSON_SCHEMA,
      starterExample: V3_STARTER_MANIFEST_EXAMPLE,
    });
  });

  app.get('/api/admin/config', requireAdmin, async (_req, res) => {
    try {
      await ensureSeeded();
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
      await ensureSeeded();
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
      await ensureSeeded();
      const flags = await repo.listQuestionFlags();
      res.json({ flags });
    } catch (err) {
      console.error('GET /api/admin/flags error:', err);
      res.status(500).json({ error: 'Failed to load question flags.' });
    }
  });

  app.post('/api/admin/flags/:id/resolve', requireAdmin, async (req, res) => {
    try {
      await ensureSeeded();
      await repo.resolveQuestionFlag(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      console.error('POST /api/admin/flags/:id/resolve error:', err);
      res.status(500).json({ error: 'Failed to resolve flag.' });
    }
  });

  app.get('/api/admin/backup', requireAdmin, async (_req, res) => {
    try {
      await ensureSeeded();
      const backup = await repo.exportFullBackup();
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="selective-lab-backup-${new Date().toISOString().slice(0, 10)}.json"`);
      res.send(JSON.stringify(backup, null, 2));
    } catch (err) {
      console.error('GET /api/admin/backup error:', err);
      res.status(500).json({ error: 'Failed to generate backup.' });
    }
  });

  // ---------------------------------------------------------------------------
  // Frontend Serving (Vite dev middleware in dev, dist/ in production)
  // ---------------------------------------------------------------------------
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(ROOT_DIR, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Selective Lab server listening on http://0.0.0.0:${PORT} (${repo.backendName})`);
  });
}

buildApp().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
