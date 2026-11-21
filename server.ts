import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import express, { type Express } from 'express';
import {
  assertAuthRuntimeConfig,
  attachAuth,
  clearAuthCookie,
  clearGoogleNonce,
  getAdminPassword,
  getGoogleNonce,
  getStudentPin,
  isLocalDevPinAuthEnabled,
  requireAdmin,
  requireSameOriginMutation,
  requireStudentOrAdmin,
  setAuthCookie,
  setGoogleNonce,
  signSessionToken,
  type AuthenticatedRequest,
  type UserIdentity,
} from './src/server/auth.ts';
import {
  getGoogleClientId,
  getGoogleStudentId,
  isGoogleAdminEmail,
  verifyGoogleCredential,
} from './src/server/authGoogle.ts';
import { getRuntimeDiagnostics } from './src/server/diagnostics.ts';
import { GeminiServiceError } from './src/server/geminiClient.ts';
import {
  decidePracticeQuestionOrderWithGemini,
  generateDailyFocusPlanStateless,
  getOrCreateDailyFocusPlan,
} from './src/server/geminiPlanner.ts';
import { evaluateWritingWithGemini } from './src/server/geminiWriting.ts';
import { validateAndDryRunManifest } from './src/server/manifestValidator.ts';
import {
  buildMediaMigrationManifest,
  readMediaBytesFromStorage,
  prepareMediaUpload,
} from './src/server/mediaService.ts';
import { createRepository } from './src/server/storage/index.ts';
import {
  ForbiddenError,
  NotFoundError,
  RevisionConflictError,
  type AppRepository,
  type QuestionQueryParams,
  type SyncHydratePayload,
} from './src/server/storage/repository.ts';
import { deriveQuestionProgressMeta } from './src/shared/bankStatus.ts';
import {
  DEFAULT_LEARNING_CONFIG,
  type BankImportManifest,
  type LearningConfig,
  type MarkingResult,
  type MockTestBatch,
  type PartAttemptRecord,
  type QuestionFlagRecord,
  type QuestionItem,
  type QuestionMasteryEvidence,
  type QuestionMemoryState,
  type SectionCode,
  type SessionCheckpoint,
  type SessionMode,
  type SessionQuestionSnapshot,
  type SessionRecord,
  type SessionSelectionDecision,
  type SessionSubmissionPayload,
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
  selectBatchMockQuestions,
  selectMockTestQuestions,
  selectPoolMockQuestions,
  selectPracticeSession,
  toStudentQuestionView,
  updateFamilyMemoryOnce,
  updateSkillState,
} from './src/shared/engine.ts';
import {
  advanceQuestionEvidence,
  buildEvidenceKey,
  computeBankMasterySummary,
  computeEvidenceRevision,
} from './src/shared/mastery.ts';
import { SKILLS_TAXONOMY } from './src/shared/skills.ts';
import { V3_MANIFEST_JSON_SCHEMA, V3_STARTER_MANIFEST_EXAMPLE } from './src/shared/v3Schema.ts';

// Keep the test runner isolated from live database and Gemini credentials.
if (!process.env.NODE_TEST_CONTEXT) dotenv.config({ quiet: true });

const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = process.cwd();
const SEED_DIR = path.join(ROOT_DIR, 'seed');
const UPLOADS_DIR = path.join(ROOT_DIR, 'public', 'assets', 'uploads');

async function readSeedManifest(filename: string): Promise<BankImportManifest | null> {
  try {
    const raw = await fs.readFile(path.join(SEED_DIR, filename), 'utf8');
    return JSON.parse(raw) as BankImportManifest;
  } catch (err) {
    console.warn(`Optional seed file ${filename} not loaded:`, err instanceof Error ? err.message : err);
    return null;
  }
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

async function buildQuestionSnapshots(
  repo: AppRepository,
  questions: QuestionItem[]
): Promise<SessionQuestionSnapshot[]> {
  const stimIds = Array.from(
    new Set(questions.map((q) => q.stimulusId).filter((id): id is string => Boolean(id)))
  );
  const stimuliById = await repo.listStimuliByIds(stimIds);
  return questions.map((q, index) => {
    const stim = q.stimulusId ? stimuliById[q.stimulusId] : undefined;
    const rev = q.evidenceRevision || computeEvidenceRevision(q, stim);
    return {
      questionId: q.questionId,
      snapshotIndex: index,
      evidenceRevision: rev,
      question: structuredClone({ ...q, evidenceRevision: rev }),
      stimulus: stim ? structuredClone(stim) : undefined,
    };
  });
}

async function resolveSessionQuestionPairs(
  repo: AppRepository,
  session: SessionRecord
): Promise<{ pairs: { question: QuestionItem; stimulus?: StimulusGroup; evidenceRevision: string }[]; usedLegacyLiveBank: boolean }> {
  const ownerId = session.studentId || 'default-student';
  const snapshots = await repo.getSessionSnapshots(ownerId, session.sessionId);
  if (snapshots.length > 0) {
    const sorted = [...snapshots].sort((a, b) => a.snapshotIndex - b.snapshotIndex);
    return {
      pairs: sorted.map((s) => ({
        question: s.question,
        stimulus: s.stimulus,
        evidenceRevision: s.evidenceRevision || computeEvidenceRevision(s.question, s.stimulus),
      })),
      usedLegacyLiveBank: false,
    };
  }

  const livePairs = await Promise.all(
    session.plannedQuestionIds.map((qid) => repo.getQuestionWithStimulus(qid))
  );
  const valid = livePairs.filter(
    (p): p is { question: QuestionItem; stimulus?: StimulusGroup } => p !== null
  );
  return {
    pairs: valid.map((p) => ({
      question: p.question,
      stimulus: p.stimulus,
      evidenceRevision: p.question.evidenceRevision || computeEvidenceRevision(p.question, p.stimulus),
    })),
    usedLegacyLiveBank: true,
  };
}

class SessionValidationError extends Error {
  readonly statusCode = 400;
}

function getEffectiveDeadlineMs(session: SessionRecord): number | null {
  if (session.isSandbox) return null;
  if (session.deadlineAt) {
    const parsed = Date.parse(session.deadlineAt);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (session.timeLimitSec && session.timeLimitSec > 0 && session.startedAt) {
    const startMs = Date.parse(session.startedAt);
    if (Number.isFinite(startMs)) return startMs + session.timeLimitSec * 1000;
  }
  return null;
}

const SUBMIT_GRACE_MS = 5_000;

function isSessionExpired(session: SessionRecord, nowMs = Date.now()): boolean {
  if (session.status !== 'in_progress' || session.isSandbox) return false;
  const deadlineMs = getEffectiveDeadlineMs(session);
  return deadlineMs !== null && nowMs >= deadlineMs;
}

async function findActiveSessionId(repo: AppRepository, studentId: string): Promise<string | null> {
  const sessions = await repo.listSessions(100, studentId, false);
  for (const s of sessions) {
    if (s.status === 'in_progress' && !s.isSandbox) {
      const resolved = await resolveOrExpireSession(repo, s);
      if (resolved.status === 'in_progress') {
        return resolved.sessionId;
      }
    }
  }
  return null;
}

async function resolveSessionForCaller(
  repo: AppRepository,
  sessionId: string,
  callerStudentId: string
): Promise<{ session: SessionRecord | null; forbidden: boolean }> {
  const own = await repo.getSession(sessionId, callerStudentId);
  if (own) return { session: own, forbidden: false };
  const anyOwner = await repo.getSession(sessionId);
  if (!anyOwner) return { session: null, forbidden: false };
  if ((anyOwner.studentId || 'default-student') !== callerStudentId) {
    return { session: anyOwner, forbidden: true };
  }
  return { session: anyOwner, forbidden: false };
}

async function finalizeSessionRecord(input: {
  repo: AppRepository;
  session: SessionRecord;
  checkpoint: SessionCheckpoint;
  assisted: boolean;
  completedAtIso: string;
  expiredAutoSubmitted?: boolean;
  rejectValidationErrors?: boolean;
}): Promise<{
  alreadySubmitted: boolean;
  session: SessionRecord;
  submissionSummary: SessionSubmissionPayload;
}> {
  const {
    repo,
    session,
    checkpoint,
    assisted,
    completedAtIso,
    expiredAutoSubmitted = false,
    rejectValidationErrors = true,
  } = input;

  if (session.status === 'submitted' && session.submissionSummary) {
    return {
      alreadySubmitted: true,
      session,
      submissionSummary: session.submissionSummary,
    };
  }

  const ownerId = session.studentId || 'default-student';
  const answersByPartId = checkpoint.answersByPartId || {};
  const { pairs } = await resolveSessionQuestionPairs(repo, session);

  const allValidationErrors: string[] = [];
  const reviewResults: Record<string, MarkingResult[]> = {};

  for (const { question } of pairs) {
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

  if (rejectValidationErrors && allValidationErrors.length > 0) {
    throw new SessionValidationError(allValidationErrors.join(' '));
  }

  const [configData, skillStates, questionMemory, pastAttempts, evidenceMap] = await Promise.all([
    repo.getActiveConfig(),
    repo.getSkillStates(ownerId),
    repo.getQuestionMemory(ownerId),
    repo.listPartAttempts(500, ownerId, false),
    repo.getQuestionEvidence(ownerId),
  ]);

  const totalPartsCount = pairs.reduce((acc, p) => acc + p.question.parts.length, 0);
  const perPartTimeSec = Math.max(
    5,
    Math.round((checkpoint.elapsedSec || 60) / Math.max(1, totalPartsCount))
  );

  const newAttempts: PartAttemptRecord[] = [];
  const updatedSkillsMap = new Map<string, SkillState>();
  const updatedMemoryMap = new Map<string, QuestionMemoryState>();
  const updatedEvidenceMap = new Map<string, QuestionMasteryEvidence>();
  const writingSubmissionsToSave: {
    submissionId: string;
    studentId: string;
    sessionId: string;
    questionId: string;
    planNotes: string;
    responseText: string;
    wordCount: number;
    timeSpentSec: number;
    deterministicMetricsJson: string;
    submittedAt: string;
  }[] = [];

  const writingReview: {
    submissionId: string;
    questionId: string;
    metrics: WritingDeterministicMetrics;
    evaluations: WritingEvaluationRecord[];
  }[] = [];

  let totalObjectiveSlots = 0;
  let correctObjectiveSlots = 0;
  let savedWritingSubmission: SessionSubmissionPayload['writingSubmission'];

  for (const { question, evidenceRevision } of pairs) {
    if (question.formatType === 'WRIT_TYPED_TASK') {
      const responseText = checkpoint.writingDraft?.responseText || '';
      const planNotes = checkpoint.writingDraft?.planNotes || '';
      const spec = question.writingSpec || {
        genre: 'essay',
        audience: 'General',
        purpose: 'Inform',
        recommendedWordRange: [200, 450],
        timeLimitSec: 1800,
      };
      const metrics = computeWritingMetrics(spec, responseText);
      const submissionId = `wsub_${session.sessionId}_${question.questionId}`.slice(0, 120);
      const subRecord = {
        submissionId,
        studentId: ownerId,
        sessionId: session.sessionId,
        questionId: question.questionId,
        planNotes,
        responseText,
        wordCount: metrics.wordCount,
        timeSpentSec: checkpoint.elapsedSec || 0,
        deterministicMetricsJson: JSON.stringify(metrics),
        submittedAt: completedAtIso,
      };
      if (!session.isSandbox) {
        writingSubmissionsToSave.push(subRecord);
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
    const prevMem =
      updatedMemoryMap.get(question.questionFamilyId) || questionMemory[question.questionFamilyId];
    const isSpacedReview = Boolean(prevMem && Date.parse(prevMem.nextDueAt) <= Date.now());

    for (let i = 0; i < question.parts.length; i++) {
      const part = question.parts[i];
      const resItem = qResults.find((r) => r.partId === part.partId);
      const isCorrect = Boolean(resItem?.isCorrect);
      totalObjectiveSlots++;
      if (isCorrect) correctObjectiveSlots++;

      newAttempts.push({
        attemptId: `att_${session.sessionId}_${part.partId}`.slice(0, 120),
        studentId: ownerId,
        sessionId: session.sessionId,
        questionId: question.questionId,
        questionFamilyId: question.questionFamilyId,
        questionVersion: question.version,
        evidenceRevision,
        partId: part.partId,
        skillId: part.skillId,
        difficultyAtAttempt: part.difficultyCalibrated ?? part.difficultyInitial,
        selectedAnswer: resItem?.selectedAnswer ?? null,
        isCorrect,
        timeSpentSec: perPartTimeSec,
        isSpacedReview,
        isSandbox: Boolean(session.isSandbox),
        isLegacy: false,
        assisted,
        createdAt: completedAtIso,
      });

      if (!session.isSandbox) {
        const prevSkill = updatedSkillsMap.get(part.skillId) || skillStates[part.skillId];
        const nextSkillState = updateSkillState({
          prevSkillState: prevSkill,
          skillId: part.skillId,
          isCorrect,
          timeSpentSec: perPartTimeSec,
          targetTimeSec: part.targetTimeSec,
          config: configData.config,
          nowIso: completedAtIso,
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
      }
    }

    if (!session.isSandbox) {
      let nextEv: QuestionMasteryEvidence | undefined;
      if (question.poolType !== 'benchmark_holdout' && question.qcStatus === 'active') {
        const evKey = buildEvidenceKey(question.questionFamilyId, evidenceRevision);
        const prevEv = updatedEvidenceMap.get(evKey) || evidenceMap[evKey];
        nextEv = advanceQuestionEvidence({
          prev: prevEv,
          question,
          evidenceRevision,
          allPartsClean: allPartsCorrect,
          assisted,
          isSandbox: false,
          submittedAtIso: completedAtIso,
          policy: configData.config.masteryPolicy,
        });
        updatedEvidenceMap.set(evKey, nextEv);
      }

      const nextMemory = updateFamilyMemoryOnce({
        prevMemory: prevMem,
        questionFamilyId: question.questionFamilyId,
        allPartsCorrect,
        config: configData.config,
        nowIso: completedAtIso,
        lastEvidenceStatus: nextEv?.status,
      });
      updatedMemoryMap.set(question.questionFamilyId, nextMemory);
    }
  }

  const savedSkillStates = !session.isSandbox ? Array.from(updatedSkillsMap.values()) : [];
  const savedQuestionMemory = !session.isSandbox ? Array.from(updatedMemoryMap.values()) : [];
  const savedEvidence = !session.isSandbox ? Array.from(updatedEvidenceMap.values()) : [];
  const savedAttempts = !session.isSandbox ? newAttempts : [];

  const submissionSummary: SessionSubmissionPayload = {
    ok: true,
    correctSlots: correctObjectiveSlots,
    totalSlots: totalObjectiveSlots,
    completedAt: completedAtIso,
    checkpoint,
    attempts: savedAttempts,
    skillStates: savedSkillStates,
    questionMemory: savedQuestionMemory,
    evidenceUpdates: savedEvidence,
    writingSubmission: savedWritingSubmission,
    reviewResults,
    writingReview,
  };

  return repo.finalizeSessionAtomically({
    sessionId: session.sessionId,
    studentId: ownerId,
    checkpoint,
    correctSlots: correctObjectiveSlots,
    totalSlots: totalObjectiveSlots,
    completedAtIso,
    expiredAutoSubmitted,
    submissionSummary,
    attempts: savedAttempts,
    skillStates: savedSkillStates,
    questionMemory: savedQuestionMemory,
    evidenceUpdates: savedEvidence,
    writingSubmissions: writingSubmissionsToSave,
  });
}

async function resolveOrExpireSession(
  repo: AppRepository,
  session: SessionRecord
): Promise<SessionRecord> {
  if (!isSessionExpired(session)) return session;
  const deadlineMs = getEffectiveDeadlineMs(session);
  const completedAtIso =
    session.deadlineAt ||
    (deadlineMs !== null ? new Date(deadlineMs).toISOString() : new Date().toISOString());
  const baseCheckpoint: SessionCheckpoint = session.checkpoint
    ? {
        ...session.checkpoint,
        elapsedSec: session.timeLimitSec ?? session.checkpoint.elapsedSec ?? 0,
      }
    : {
        currentIndex: 0,
        elapsedSec: session.timeLimitSec ?? 0,
        answersByPartId: {},
        flaggedQuestionIds: [],
      };

  const finalized = await finalizeSessionRecord({
    repo,
    session,
    checkpoint: baseCheckpoint,
    assisted: false,
    completedAtIso,
    expiredAutoSubmitted: true,
    rejectValidationErrors: false,
  });
  return finalized.session;
}

export interface CreateAppOptions {
  repo?: AppRepository;
  skipSeed?: boolean;
  skipVite?: boolean;
}

export async function createApp(options: CreateAppOptions = {}): Promise<{ app: Express; repo: AppRepository }> {
  assertAuthRuntimeConfig();
  const repo = options.repo ?? createRepository();
  const { backendName } = repo;
  let seedPromise: Promise<void> | null = null;

  async function ensureSeeded(): Promise<void> {
    if (options.skipSeed) return;
    if (!seedPromise) {
      seedPromise = (async () => {
        const smoke = await readSeedManifest('golden-smoke-pack.json');
        if (smoke) {
          await repo.initAndSeedIfEmpty(smoke);
        }
        const existing = await repo.listQuestions();
        const existingIds = new Set(existing.map((q) => q.questionId));
        if (!existingIds.has('q_off_pt1_read_q01_v1')) {
          const pt12 = await readSeedManifest('official-doe-pt1-2.json');
          if (pt12) await repo.importManifest(pt12, 'system_seed');
        }
        if (!existingIds.has('q_off_pt3_read_q01_v1')) {
          const pt3 = await readSeedManifest('official-doe-pt3-holdout.json');
          if (pt3) await repo.importManifest(pt3, 'system_seed');
        }
      })().catch((err) => {
        seedPromise = null;
        throw err;
      });
    }
    await seedPromise;
  }

  const app = express();
  app.set('trust proxy', 1);
  app.use('/api', requireSameOriginMutation);
  app.use(['/api/auth', '/api/student', '/api/admin'], (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '15mb' }));
  app.use(attachAuth);

  // Serve bundled seed, fonts & docs static assets cleanly
  app.use('/assets', express.static(path.join(ROOT_DIR, 'public', 'assets')));
  app.use('/fonts', express.static(path.join(ROOT_DIR, 'public', 'fonts')));
  app.use('/docs', express.static(path.join(ROOT_DIR, 'public', 'docs')));

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      backendName,
      isDisposableDemo: backendName === 'memory_preview',
      localDevPinEnabled: isLocalDevPinAuthEnabled(),
    });
  });

  // Media stored with the question bank survives serverless cold starts.
  app.get('/api/media/:assetId', async (req, res) => {
    try {
      const asset = await repo.getMediaAsset(req.params.assetId);
      if (!asset) {
        res.status(404).json({ error: 'Media asset not found.' });
        return;
      }
      const buf = await readMediaBytesFromStorage(asset, UPLOADS_DIR);
      if (!buf) {
        res.status(404).json({ error: 'Media binary missing from storage.' });
        return;
      }
      res.setHeader('Content-Type', asset.mimeType || 'application/octet-stream');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.send(buf);
    } catch (err) {
      console.error('GET /api/media/:assetId error:', err);
      res.status(500).json({ error: 'Failed to load media asset.' });
    }
  });

  // ---------------------------------------------------------------------------
  // Auth Routes
  // ---------------------------------------------------------------------------
  const getAuthState = async (identity?: Omit<UserIdentity, 'exp'>) => ({
    authenticated: Boolean(identity),
    role: identity?.role ?? null,
    studentId: identity?.studentId ?? null,
    email: identity?.email,
    activeSessionId: identity ? await findActiveSessionId(repo, identity.studentId) : null,
    backendName,
    isDisposableDemo: backendName === 'memory_preview',
    localDevPinEnabled: isLocalDevPinAuthEnabled(),
  });

  async function completeLogin(
    req: express.Request, res: express.Response, identity: Omit<UserIdentity, 'exp'>
  ) {
    await ensureSeeded();
    const state = await getAuthState(identity);
    setAuthCookie(res, signSessionToken(identity), req);
    clearGoogleNonce(res, req);
    res.json(state);
  }

  app.get('/api/auth/me', async (req: AuthenticatedRequest, res) => {
    try {
      res.json(await getAuthState(req.auth));
    } catch (err) {
      console.error('GET /api/auth/me active-session check failed:', err);
      res.status(503).json({ error: 'Unable to verify active session lock right now.' });
    }
  });

  app.get('/api/auth/google-config', (req, res) => {
    const clientId = getGoogleClientId();
    res.json({ clientId, nonce: clientId ? setGoogleNonce(res, req) : null });
  });

  app.post('/api/auth/student-login', async (req, res) => {
    if (!isLocalDevPinAuthEnabled()) {
      res.status(403).json({ error: 'Local PIN sign-in is disabled. Sign in with Google.' });
      return;
    }
    const pin = String(req.body?.pin ?? '').trim();
    if (!pin || pin !== getStudentPin()) {
      res.status(401).json({ error: 'Incorrect PIN. Please try again.' });
      return;
    }
    try {
      await completeLogin(req, res, { role: 'student', studentId: 'default-student', authMethod: 'local_pin' });
    } catch (err) {
      console.error('POST /api/auth/student-login persistence error:', err);
      res.status(503).json({ error: 'Unable to complete sign-in right now.' });
    }
  });

  app.post('/api/auth/admin-login', async (req, res) => {
    if (!isLocalDevPinAuthEnabled()) {
      res.status(403).json({ error: 'Local admin password sign-in is disabled. Sign in with Google.' });
      return;
    }
    const password = String(req.body?.password ?? '');
    if (!password || password !== getAdminPassword()) {
      res.status(401).json({ error: 'Incorrect admin password.' });
      return;
    }
    try {
      await completeLogin(req, res, { role: 'admin', studentId: 'default-student', authMethod: 'local_admin' });
    } catch (err) {
      console.error('POST /api/auth/admin-login persistence error:', err);
      res.status(503).json({ error: 'Unable to complete sign-in right now.' });
    }
  });

  app.post('/api/auth/google-login', async (req, res) => {
    if (!req.is('application/json')) {
      res.status(415).json({ error: 'Google sign-in requires a JSON request.' });
      return;
    }
    const clientId = getGoogleClientId();
    if (!clientId) {
      res.status(503).json({ error: 'Google sign-in is currently unavailable.' });
      return;
    }
    const { credential, admin } = req.body ?? {};
    if (typeof credential !== 'string' || !credential || credential.length > 8192) {
      res.status(400).json({ error: 'A Google credential is required.' });
      return;
    }
    const nonce = getGoogleNonce(req);
    if (!nonce) {
      res.status(401).json({ error: 'The sign-in request expired. Please try again.' });
      return;
    }

    let googleUser;
    try {
      googleUser = await verifyGoogleCredential(credential, clientId, nonce);
    } catch {
      res.status(401).json({ error: 'Unable to verify Google sign-in. Please try again.' });
      return;
    }

    const { sub, email, name, hostedDomain } = googleUser;
    const isAdmin = isGoogleAdminEmail(email, hostedDomain);
    if (admin === true && !isAdmin) {
      res.status(403).json({ error: 'This Google account does not have admin access.' });
      return;
    }
    const studentId = getGoogleStudentId(sub);
    try {
      await repo.upsertUserFromAuth({ uid: studentId, email, displayName: name, isBootstrappedAdmin: isAdmin });
      await completeLogin(req, res, {
        role: isAdmin ? 'admin' : 'student',
        studentId,
        email,
        authMethod: 'google',
        googleSub: sub,
        hostedDomain,
      });
    } catch (err) {
      console.error('POST /api/auth/google-login persistence error:', err);
      res.status(503).json({ error: 'Unable to complete sign-in right now.' });
    }
  });

  // Disabled on normal user path per V3 architecture decision: move migration to /api/admin/migrate/*
  app.post('/api/sync/hydrate', requireStudentOrAdmin, (_req, res) => {
    res.status(410).json({
      error:
        'Browser client hydration on /api/sync/hydrate is retired. Authoritative data loads directly from the server.',
    });
  });

  app.post('/api/auth/logout', (req, res) => {
    clearAuthCookie(res, req);
    clearGoogleNonce(res, req);
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // Student APIs (/api/student/*) — strictly scoped to req.auth.studentId!
  // ---------------------------------------------------------------------------
  app.get('/api/student/dashboard', requireStudentOrAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ensureSeeded();
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
        repo.listSessions(100, studentId, false),
        repo.listPartAttempts(500, studentId, false),
        repo.listQuestions({ qcStatus: 'active' }),
        repo.listImportBatches(),
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
        questions,
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
        recentSessions: sessions.filter((s) => !s.isSandbox).slice(0, 8),
        dailyFocusPlan,
        serverNowIso: new Date().toISOString(),
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
      const batchId = typeof req.body?.batchId === 'string' ? req.body.batchId : undefined;
      const mockSource = req.body?.mockSource as 'pool' | 'batch' | undefined;
      const questionCount =
        req.body?.questionCount !== undefined && Number(req.body.questionCount) > 0
          ? Math.round(Number(req.body.questionCount))
          : undefined;
      const timeMultiplier =
        req.body?.timeMultiplier !== undefined ? Number(req.body.timeMultiplier) : 1;
      const customTimeLimitSec =
        req.body?.customTimeLimitSec !== undefined ? Number(req.body.customTimeLimitSec) : undefined;

      if (mode === 'admin_calibration') {
        res.status(403).json({ error: 'Admin calibration sessions must be created via /api/admin/calibration/session.' });
        return;
      }

      const [existingSessions, configData, allQuestions, skillStates, questionMemory, evidenceMap] =
        await Promise.all([
          repo.listSessions(50, studentId, false),
          repo.getActiveConfig(),
          repo.listQuestions(),
          repo.getSkillStates(studentId),
          repo.getQuestionMemory(studentId),
          repo.getQuestionEvidence(studentId),
        ]);

      for (const s of existingSessions) {
        if (s.status === 'in_progress' && !s.isSandbox) {
          const resolved = await resolveOrExpireSession(repo, s);
          if (resolved.status === 'in_progress') {
            res.status(409).json({
              error: 'Only one active test is allowed per account at a time. Complete and submit your current test first.',
              activeSessionId: resolved.sessionId,
            });
            return;
          }
        }
      }

      const nowIso = new Date().toISOString();
      let selected: QuestionItem[] = [];
      let selectionDecision: SessionSelectionDecision | undefined;
      let title = '';
      let effectiveMode: SessionMode = mode;
      let timeLimitSec = 1500;

      if (mockSource === 'pool') {
        effectiveMode = 'section_drill';
        selected = selectPoolMockQuestions({
          questions: allQuestions,
          sectionFilter,
          questionCount,
          questionMemory,
          evidenceMap,
          autoRetireMastered: Boolean(configData.config.poolPolicy?.autoRetireMastered),
          seed: Date.now() & 0xfffffff,
        });
        const baseSec = getOfficialTimeLimitSec(sectionFilter);
        if (customTimeLimitSec !== undefined && !Number.isNaN(customTimeLimitSec)) {
          timeLimitSec = Math.max(0, Math.round(customTimeLimitSec));
        } else {
          timeLimitSec = timeMultiplier <= 0 ? 0 : Math.round(baseSec * timeMultiplier);
        }
        title = `Fresh Pool Mock${sectionFilter ? ` (${sectionFilter})` : ' (Full Exam)'}`;
      } else if (batchId) {
        effectiveMode = 'section_drill';
        selected = selectBatchMockQuestions({
          batchId,
          sectionFilter,
          questions: allQuestions,
        });
        const baseSec = getOfficialTimeLimitSec(sectionFilter);
        timeLimitSec =
          customTimeLimitSec !== undefined && !Number.isNaN(customTimeLimitSec)
            ? Math.max(0, Math.round(customTimeLimitSec))
            : timeMultiplier <= 0
              ? 0
              : Math.round(baseSec * timeMultiplier);
        const batchLabel = selected[0]?.batchLabel || batchId;
        title = `${batchLabel}${sectionFilter ? ` (${sectionFilter})` : ''}`;
      } else if (mockBatch) {
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
        title = `${mockBatch} Mock${sectionFilter ? ` (${sectionFilter})` : ' (Full Test)'}`;
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
        title = `PT3 Benchmark Holdout${sectionFilter ? ` (${sectionFilter})` : ''}`;
      } else {
        const effectiveSection: SectionCode | undefined =
          mode === 'writing_sprint' ? 'WRIT' : sectionFilter;
        const normalizedMode: SessionMode =
          mode === 'spaced_review' ? 'daily_adaptive' : mode;
        const dailyPlan =
          mode === 'writing_sprint'
            ? null
            : (await getOrCreateDailyFocusPlan({
                repo,
                studentId,
                skillStates,
                evidenceMap,
                questionMemory,
                questions: allQuestions,
                config: configData.config,
                nowIso,
              })).plan;
        const seed = Date.now() & 0xfffffff;
        if (mode === 'writing_sprint') {
          selected = selectPracticeSession({
            mode: normalizedMode,
            sectionFilter: effectiveSection,
            questions: allQuestions,
            skillStates,
            questionMemory,
            evidenceMap,
            skillFocusWeights: dailyPlan?.skillWeights,
            algorithmAdjustments: dailyPlan?.algorithmAdjustments,
            config: configData.config,
            nowIso,
            seed,
          }).slice(0, 1);
        } else {
          const ordered = await decidePracticeQuestionOrderWithGemini({
            mode: normalizedMode,
            sectionFilter: effectiveSection,
            questions: allQuestions,
            skillStates,
            questionMemory,
            evidenceMap,
            dailyPlan,
            questionCountOverride: questionCount,
            config: configData.config,
            nowIso,
            seed,
          });
          selected = ordered.questions;
          selectionDecision = ordered.decision;
        }
        effectiveMode = normalizedMode;
        if (mode === 'writing_sprint') {
          timeLimitSec = 1800;
          title = 'Writing Sprint (30 min)';
        } else if (effectiveSection) {
          const drillMin = Math.max(1, configData.config.sessionDefaults.sectionDrillTimeMinutes ?? 8);
          timeLimitSec = effectiveSection === 'WRIT' ? 1800 : drillMin * 60;
          title = `${effectiveSection} Practice Drill (${selected.length} Qs)`;
        } else {
          const goalMin =
            configData.config.autoCalibrate?.enabled && dailyPlan?.dailyGoalMinutes
              ? dailyPlan.dailyGoalMinutes
              : configData.config.sessionDefaults.dailyGoalMinutes;
          timeLimitSec = goalMin * 60;
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

      const snapshots = await buildQuestionSnapshots(repo, selected);
      const totalSlots = snapshots.reduce((sum, s) => sum + s.question.parts.length, 0);
      const startedAtIso = new Date().toISOString();
      const deadlineAt =
        timeLimitSec > 0 ? new Date(Date.parse(startedAtIso) + timeLimitSec * 1000).toISOString() : undefined;

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
        plannedQuestionIds: snapshots.map((s) => s.questionId),
        selectionDecision,
        checkpointRevision: 1,
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
        deadlineAt,
        totalSlots,
        correctSlots: 0,
        startedAt: startedAtIso,
      };

      let reserved = await repo.reserveAndCreateSession(session, snapshots);
      if (!reserved.created && reserved.conflictSession && isSessionExpired(reserved.conflictSession)) {
        await resolveOrExpireSession(repo, reserved.conflictSession);
        reserved = await repo.reserveAndCreateSession(session, snapshots);
      }
      if (!reserved.created) {
        res.status(409).json({
          error: 'Only one active test is allowed per account at a time. Complete and submit your current test first.',
          activeSessionId: reserved.conflictSessionId,
        });
        return;
      }

      res.status(201).json({
        sessionId: session.sessionId,
        session,
        serverNowIso: new Date().toISOString(),
      });
    } catch (err) {
      console.error('POST /api/student/sessions error:', err);
      res.status(500).json({ error: 'Failed to create practice session.' });
    }
  });

  app.get('/api/student/sessions/:id', requireStudentOrAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ensureSeeded();
      const { session: loaded, forbidden } = await resolveSessionForCaller(
        repo,
        req.params.id,
        req.auth!.studentId
      );
      if (!loaded) {
        res.status(404).json({ error: 'Session not found.' });
        return;
      }
      if (forbidden) {
        res.status(403).json({ error: 'Forbidden: session belongs to another user.' });
        return;
      }

      const session = await resolveOrExpireSession(repo, loaded);
      const { pairs } = await resolveSessionQuestionPairs(repo, session);
      const isSubmitted = session.status === 'submitted';

      // ZERO ANSWER KEY LEAKAGE: pre-submission strips answer keys, worked explanations, distractor rationales, evidenceRefs, and decoy markers
      const questions = pairs.map((pair) =>
        toStudentQuestionView(pair.question, pair.stimulus, isSubmitted)
      );

      let reviewResults: Record<string, MarkingResult[]> | undefined;
      let writingReview:
        | {
            submissionId: string;
            questionId: string;
            metrics: WritingDeterministicMetrics;
            evaluations: WritingEvaluationRecord[];
          }[]
        | undefined;

      if (isSubmitted) {
        if (session.submissionSummary?.reviewResults) {
          reviewResults = session.submissionSummary.reviewResults;
        } else {
          const answers = session.checkpoint?.answersByPartId ?? {};
          reviewResults = {};
          for (const pair of pairs) {
            if (pair.question.formatType === 'WRIT_TYPED_TASK') {
              reviewResults[pair.question.questionId] = [];
              continue;
            }
            const { results } = gradeSubmission(pair.question, answers);
            reviewResults[pair.question.questionId] = results;
          }
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
        } else if (session.submissionSummary?.writingReview) {
          writingReview = session.submissionSummary.writingReview;
        }
      }

      res.json({
        session,
        questions,
        reviewResults,
        writingReview,
        serverNowIso: new Date().toISOString(),
      });
    } catch (err) {
      console.error('GET /api/student/sessions/:id error:', err);
      res.status(500).json({ error: 'Failed to load session.' });
    }
  });

  app.patch('/api/student/sessions/:id/checkpoint', requireStudentOrAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ensureSeeded();
      const { session, forbidden } = await resolveSessionForCaller(
        repo,
        req.params.id,
        req.auth!.studentId
      );
      if (!session) {
        res.status(404).json({ error: 'Session not found.' });
        return;
      }
      if (forbidden) {
        res.status(403).json({ error: 'Forbidden: session belongs to another user.' });
        return;
      }
      const nowMs = Date.now();
      const deadlineMs = getEffectiveDeadlineMs(session);
      const expiredPastGrace =
        session.status === 'in_progress' &&
        !session.isSandbox &&
        deadlineMs !== null &&
        nowMs > deadlineMs + SUBMIT_GRACE_MS;
      if (expiredPastGrace) {
        const finalized = await resolveOrExpireSession(repo, session);
        res.status(409).json({
          error: 'Time expired — this test has been auto-submitted.',
          expiredAutoSubmitted: true,
          alreadySubmitted: true,
          currentRevision: finalized.checkpointRevision ?? 1,
          serverCheckpoint: finalized.checkpoint,
        });
        return;
      }
      if (session.status !== 'in_progress') {
        res.status(409).json({
          error: 'Session already submitted.',
          expiredAutoSubmitted: Boolean(session.expiredAutoSubmitted),
          alreadySubmitted: session.status === 'submitted',
          currentRevision: session.checkpointRevision ?? 1,
          serverCheckpoint: session.checkpoint,
        });
        return;
      }
      const cp = req.body?.checkpoint as NonNullable<SessionRecord['checkpoint']>;
      if (!cp || typeof cp !== 'object') {
        res.status(400).json({ error: 'Invalid checkpoint payload.' });
        return;
      }
      const expectedRevision =
        req.body?.expectedRevision !== undefined ? Number(req.body.expectedRevision) : undefined;
      if (!session.isSandbox && (expectedRevision === undefined || Number.isNaN(expectedRevision))) {
        res.status(400).json({ error: 'expectedRevision is required for checkpoint updates.' });
        return;
      }
      if (expectedRevision !== undefined && Number.isNaN(expectedRevision)) {
        res.status(400).json({ error: 'Invalid expectedRevision.' });
        return;
      }

      const saved = await repo.saveSessionCheckpoint(
        session.sessionId,
        req.auth!.studentId,
        cp,
        expectedRevision
      );
      res.json({ ok: true, ...saved, serverNowIso: new Date().toISOString() });
    } catch (err) {
      if (err instanceof RevisionConflictError) {
        res.status(409).json({
          error: err.message,
          currentRevision: err.currentRevision,
          serverCheckpoint: err.serverCheckpoint,
        });
        return;
      }
      if (err instanceof ForbiddenError) {
        res.status(403).json({ error: err.message });
        return;
      }
      if (err instanceof NotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      console.error('PATCH /api/student/sessions/:id/checkpoint error:', err);
      res.status(500).json({ error: 'Failed to save checkpoint.' });
    }
  });

  app.post('/api/student/sessions/:id/submit', requireStudentOrAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ensureSeeded();
      const { session, forbidden } = await resolveSessionForCaller(
        repo,
        req.params.id,
        req.auth!.studentId
      );
      if (!session) {
        res.status(404).json({ error: 'Session not found.' });
        return;
      }
      if (forbidden) {
        res.status(403).json({ error: 'Forbidden: cannot submit another user session.' });
        return;
      }

      if (session.status === 'submitted' && session.submissionSummary) {
        res.json({
          ...session.submissionSummary,
          alreadySubmitted: true,
          expiredAutoSubmitted: Boolean(session.expiredAutoSubmitted),
        });
        return;
      }

      const nowMs = Date.now();
      const expired = isSessionExpired(session, nowMs);
      const deadlineMs = getEffectiveDeadlineMs(session);
      const withinGrace = deadlineMs === null || nowMs <= deadlineMs + SUBMIT_GRACE_MS;
      const completedAtIso =
        expired && deadlineMs !== null
          ? session.deadlineAt || new Date(deadlineMs).toISOString()
          : new Date(nowMs).toISOString();

      const incomingCheckpoint = req.body?.checkpoint as SessionRecord['checkpoint'] | undefined;
      const fallbackCp: SessionCheckpoint = session.checkpoint || {
        currentIndex: 0,
        elapsedSec: 0,
        answersByPartId: {},
        flaggedQuestionIds: [],
      };
      const baseCp: SessionCheckpoint =
        (!expired || withinGrace) && incomingCheckpoint ? incomingCheckpoint : fallbackCp;
      const cp: SessionCheckpoint = expired
        ? {
            ...baseCp,
            elapsedSec: session.timeLimitSec ?? baseCp.elapsedSec ?? 0,
          }
        : baseCp;

      const assisted = Boolean(req.body?.assisted);
      const finalResult = await finalizeSessionRecord({
        repo,
        session,
        checkpoint: cp,
        assisted,
        completedAtIso,
        expiredAutoSubmitted: expired,
        rejectValidationErrors: !expired,
      });

      res.json({
        ...finalResult.submissionSummary,
        alreadySubmitted: finalResult.alreadySubmitted,
        expiredAutoSubmitted: Boolean(finalResult.session.expiredAutoSubmitted),
      });
    } catch (err) {
      if (err instanceof SessionValidationError) {
        res.status(400).json({ error: err.message });
        return;
      }
      if (err instanceof ForbiddenError) {
        res.status(403).json({ error: err.message });
        return;
      }
      if (err instanceof NotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      console.error('POST /api/student/sessions/:id/submit error:', err);
      res.status(500).json({ error: 'Failed to submit session.' });
    }
  });

  app.post(
    '/api/student/writing/:submissionId/evaluate',
    requireStudentOrAdmin,
    async (req: AuthenticatedRequest, res) => {
      try {
        await ensureSeeded();
        const studentId = req.auth!.studentId;
        const sub = await repo.getWritingSubmission(req.params.submissionId);
        if (!sub) {
          res.status(404).json({ error: 'Writing submission not found.' });
          return;
        }
        if ((sub.studentId || 'default-student') !== studentId) {
          res.status(403).json({ error: 'Forbidden: writing submission belongs to another user.' });
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
        await repo.saveWritingEvaluation(evaluation, studentId);
        const updated = await repo.getWritingSubmission(sub.submissionId, studentId);
        res.json({ evaluation, evaluations: updated?.evaluations || [evaluation] });
      } catch (err) {
        console.error('POST /api/student/writing/:submissionId/evaluate error:', err);
        if (err instanceof GeminiServiceError) {
          res.status(err.statusCode).json({ error: err.message });
          return;
        }
        res.status(502).json({
          error: err instanceof Error ? err.message : 'Failed to evaluate writing with Gemini.',
        });
      }
    }
  );

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
      const [attempts, skillStates, sessions, writingSubmissions, questions, evidenceMap, configData] =
        await Promise.all([
          repo.listPartAttempts(5000, studentId, false),
          repo.getSkillStates(studentId),
          repo.listSessions(200, studentId, false),
          repo.listWritingSubmissions(studentId),
          repo.listQuestions(),
          repo.getQuestionEvidence(studentId),
          repo.getActiveConfig(),
        ]);

      const stimIds = Array.from(
        new Set(questions.map((q) => q.stimulusId).filter((id): id is string => Boolean(id)))
      );
      const stimuliById = await repo.listStimuliByIds(stimIds);

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

      const holdoutAttempts: PartAttemptRecord[] = [];
      let legacyAttemptsCount = 0;

      for (const a of attempts) {
        if (a.isLegacy) legacyAttemptsCount++;
        const q = questionMap.get(a.questionId);
        if (q?.poolType === 'benchmark_holdout') {
          holdoutAttempts.push(a);
        }
        const meta = partTargetMap.get(a.partId);
        const sec = meta?.section || q?.section || 'MATH';
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

      const masterySummary = computeBankMasterySummary({
        questions,
        stimuliById,
        evidenceMap,
        legacyAttemptsCount,
        holdoutAttempts,
        writingSubmissionsCount: writingSubmissions.length,
        writingEvaluatedCount: writingSubmissions.filter((w) => w.evaluations.length > 0).length,
        policyVersion: configData.config.masteryPolicy?.policyVersion,
      });

      res.json({
        sectionStats,
        skills,
        sessions: sessions.filter((s) => !s.isSandbox),
        writingSubmissions,
        totalAttempts: attempts.length,
        masterySummary,
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
      const [attempts, skillStates, sessions, writingSubmissions, evidenceMap] = await Promise.all([
        repo.listPartAttempts(5000, studentId, false),
        repo.getSkillStates(studentId),
        repo.listSessions(500, studentId, false),
        repo.listWritingSubmissions(studentId),
        repo.getQuestionEvidence(studentId),
      ]);

      if (format === 'csv') {
        const headers = [
          'attemptId',
          'sessionId',
          'questionId',
          'questionVersion',
          'evidenceRevision',
          'partId',
          'skillId',
          'selectedAnswer',
          'isCorrect',
          'timeSpentSec',
          'isLegacy',
          'createdAt',
        ];
        const rows = attempts.map((a) =>
          [
            a.attemptId,
            a.sessionId,
            a.questionId,
            a.questionVersion ?? '',
            a.evidenceRevision ?? '',
            a.partId,
            a.skillId,
            a.selectedAnswer ?? '',
            a.isCorrect,
            a.timeSpentSec,
            Boolean(a.isLegacy),
            a.createdAt,
          ]
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
      res.send(
        JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            studentId,
            sessions,
            skillStates,
            questionEvidence: Object.values(evidenceMap),
            attempts,
            writingSubmissions,
          },
          null,
          2
        )
      );
    } catch (err) {
      console.error('GET /api/student/export error:', err);
      res.status(500).json({ error: 'Failed to export progress.' });
    }
  });

  // ---------------------------------------------------------------------------
  // Admin APIs (/api/admin/*) — Strictly 403 for student cookies/tokens!
  // ---------------------------------------------------------------------------
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
      await ensureSeeded();
      if (!repo.getProgressCounts) {
        res.status(501).json({ error: 'Study progress counts are unavailable for this repository.' });
        return;
      }
      res.json(await repo.getProgressCounts(req.auth!.studentId));
    } catch (err) {
      console.error('GET /api/admin/study-progress error:', err);
      res.status(500).json({ error: 'Unable to load study progress counts.' });
    }
  });

  app.post('/api/admin/study-progress/reset', requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ensureSeeded();
      if (!repo.resetStudentProgress) {
        res.status(501).json({ error: 'Study progress reset is unavailable for this repository.' });
        return;
      }
      res.json(await repo.resetStudentProgress(req.auth!.studentId));
    } catch (err) {
      console.error('POST /api/admin/study-progress/reset error:', err);
      res.status(500).json({ error: 'Unable to reset study progress.' });
    }
  });

  app.post('/api/admin/recalibrate-daily-plan', requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ensureSeeded();
      const studentId = req.auth!.studentId;
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
      res.json(result);
    } catch (err) {
      console.error('POST /api/admin/recalibrate-daily-plan error:', err);
      res.status(500).json({ error: 'Unable to recalibrate the daily focus plan.' });
    }
  });

  app.get('/api/admin/status', requireAdmin, async (_req, res) => {
    try {
      await ensureSeeded();
      const [questions, configData, flags, sessions, batches] = await Promise.all([
        repo.listQuestions(),
        repo.getActiveConfig(),
        repo.listQuestionFlags(),
        repo.listSessions(500),
        repo.listImportBatches(),
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
        batchesCount: batches.length,
      });
    } catch (err) {
      console.error('GET /api/admin/status error:', err);
      res.status(500).json({ error: 'Failed to load admin status.' });
    }
  });

  app.get('/api/admin/questions', requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ensureSeeded();
      const studentId = req.auth!.studentId;
      const [evidence, memory, { config }] = await Promise.all([
        repo.getQuestionEvidence(studentId),
        repo.getQuestionMemory(studentId),
        repo.getActiveConfig(),
      ]);
      const dailyLimits = config.sessionDefaults.dailyQuestionLimitBySection;
      const dailyQuestionTarget = Math.max(1, (dailyLimits.READ || 0) + (dailyLimits.MATH || 0) + (dailyLimits.THINK || 0));
      const result = await repo.listQuestionsPaginated({
        search: req.query.search ? String(req.query.search) : undefined,
        section: req.query.section ? String(req.query.section) : undefined,
        poolType: req.query.poolType ? String(req.query.poolType) : undefined,
        qcStatus: req.query.qcStatus ? String(req.query.qcStatus) : undefined,
        poolStatus: req.query.poolStatus as QuestionQueryParams['poolStatus'],
        completionStatus: req.query.completionStatus as QuestionQueryParams['completionStatus'],
        progress: { evidence, memory, dailyQuestionTarget },
        formatType: req.query.formatType ? String(req.query.formatType) : undefined,
        batchId: req.query.batchId ? String(req.query.batchId) : undefined,
        batchTag: req.query.batchTag ? String(req.query.batchTag) : undefined,
        skillId: req.query.skillId ? String(req.query.skillId) : undefined,
        includeHistorical: req.query.includeHistorical === 'true',
        flaggedOnly: req.query.flaggedOnly === 'true',
        missingVisual: req.query.missingVisual === 'true',
        missingExplanation: req.query.missingExplanation === 'true',
        sort: (req.query.sort as 'id_asc' | 'updated_desc' | 'version_desc') || 'id_asc',
        page: req.query.page ? Number(req.query.page) : 1,
        pageSize: req.query.pageSize ? Number(req.query.pageSize) : 50,
      });
      res.json(result);
    } catch (err) {
      console.error('GET /api/admin/questions error:', err);
      res.status(500).json({ error: 'Failed to load admin questions.' });
    }
  });

  app.get('/api/admin/questions/:id/versions', requireAdmin, async (req, res) => {
    try {
      await ensureSeeded();
      const target = await repo.getQuestionWithStimulus(req.params.id);
      if (!target) {
        res.status(404).json({ error: 'Question not found.' });
        return;
      }
      const versions = await repo.listQuestionVersions(target.question.questionFamilyId);
      res.json({ questionFamilyId: target.question.questionFamilyId, versions });
    } catch (err) {
      console.error('GET /api/admin/questions/:id/versions error:', err);
      res.status(500).json({ error: 'Failed to load question versions.' });
    }
  });

  app.get('/api/admin/batches', requireAdmin, async (_req, res) => {
    try {
      await ensureSeeded();
      const batches = await repo.listImportBatches();
      res.json({ batches });
    } catch (err) {
      console.error('GET /api/admin/batches error:', err);
      res.status(500).json({ error: 'Failed to load import batches.' });
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
      if (err instanceof NotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      console.error('PATCH /api/admin/questions/:id/status error:', err);
      res.status(500).json({ error: 'Failed to update question QC status.' });
    }
  });

  app.post('/api/admin/questions/delete', requireAdmin, async (req, res) => {
    try {
      await ensureSeeded();
      const rawIds = Array.isArray(req.body?.questionIds) ? req.body.questionIds : [];
      const ids = rawIds.filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0);
      if (ids.length === 0) {
        res.json({ ok: true, deletedCount: 0 });
        return;
      }
      if (!repo.deleteQuestions) {
        res.status(501).json({ error: 'Permanent deletion is not supported on this backend.' });
        return;
      }
      const deletedCount = await repo.deleteQuestions(ids);
      res.json({ ok: true, deletedCount });
    } catch (err) {
      console.error('POST /api/admin/questions/delete error:', err);
      res.status(500).json({ error: 'Failed to delete question(s).' });
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
        const asset = prepareMediaUpload({
          questionId,
          filename: String(req.body.filename),
          imageBase64: String(req.body.imageBase64),
        });
        await repo.saveMediaAsset(asset);
        visual = {
          visualType: 'image_asset',
          altText,
          caption,
          imageUrl: asset.url,
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
      if (err instanceof NotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : 'Failed to attach visual asset.';
      const status =
        message.includes('Unsupported') || message.includes('exceeds') || message.includes('Empty') ? 400 : 500;
      console.error('POST /api/admin/questions/:id/visual error:', err);
      res.status(status).json({ error: message });
    }
  });

  app.post('/api/admin/media/upload', requireAdmin, async (req, res) => {
    try {
      await ensureSeeded();
      const filename = String(req.body?.filename || '').trim();
      const imageBase64 = String(req.body?.imageBase64 || '');
      const questionId = req.body?.questionId ? String(req.body.questionId).trim() : undefined;
      if (!filename || !imageBase64) {
        res.status(400).json({ error: 'filename and imageBase64 are required.' });
        return;
      }
      const asset = prepareMediaUpload({
        questionId,
        filename,
        imageBase64,
      });
      await repo.saveMediaAsset(asset);
      const { bytesBase64: _bytes, ...metadata } = asset;
      res.status(201).json({ ok: true, asset: metadata });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Media upload failed.';
      const status = msg.includes('Unsupported') || msg.includes('exceeds') || msg.includes('Empty') ? 400 : 500;
      res.status(status).json({ error: msg });
    }
  });

  app.get('/api/admin/media/migration-manifest', requireAdmin, async (_req, res) => {
    try {
      await ensureSeeded();
      const [questions, mediaAssets] = await Promise.all([
        repo.listQuestions({ includeHistorical: true }),
        repo.listMediaAssets(),
      ]);
      const stimIds = Array.from(
        new Set(questions.map((q) => q.stimulusId).filter((id): id is string => Boolean(id)))
      );
      const stimuliMap = await repo.listStimuliByIds(stimIds);
      const manifest = await buildMediaMigrationManifest({
        questions,
        stimuli: Object.values(stimuliMap),
        mediaAssets,
        uploadsDir: UPLOADS_DIR,
      });
      res.json({ manifest });
    } catch (err) {
      console.error('GET /api/admin/media/migration-manifest error:', err);
      res.status(500).json({ error: 'Failed to generate media migration manifest.' });
    }
  });

  app.post('/api/admin/calibration/session', requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ensureSeeded();
      const configData = await repo.getActiveConfig();
      const explicitIds: string[] = Array.isArray(req.body?.questionIds)
        ? req.body.questionIds.map((x: unknown) => String(x).trim()).filter(Boolean)
        : Array.isArray(req.body?.items)
          ? req.body.items
              .map((item: { questionId?: string }) => String(item?.questionId || '').trim())
              .filter(Boolean)
          : [];

      let selected: QuestionItem[] = [];
      if (explicitIds.length > 0) {
        const allQuestions = await repo.listQuestions({ includeHistorical: true });
        const byId = new Map(allQuestions.map((q) => [q.questionId, q]));
        const missingIds = explicitIds.filter((id) => !byId.has(id));
        if (missingIds.length > 0) {
          res.status(400).json({
            error: `Unknown questionIds in calibration request: ${missingIds.join(', ')}`,
          });
          return;
        }
        selected = explicitIds.map((id) => byId.get(id)!);
      } else {
        const allQuestions = await repo.listQuestions({
          includeHistorical: Boolean(req.body?.includeHistorical),
        });
        selected = selectAdminCalibrationQuestions({
          questions: allQuestions,
          section: req.body?.section || undefined,
          poolType: req.body?.poolType || undefined,
          qcStatus: req.body?.qcStatus || undefined,
          formatType: req.body?.formatType || undefined,
          skillFamily: req.body?.skillFamily || undefined,
          skillId: req.body?.skillId || undefined,
          batch: req.body?.batch || undefined,
          batchId: req.body?.batchId || undefined,
          limit: req.body?.limit ? Number(req.body.limit) : 15,
        });
      }

      if (selected.length === 0) {
        res.status(400).json({ error: 'No questions matched your calibration filters.' });
        return;
      }

      const snapshots = await buildQuestionSnapshots(repo, selected);
      const customTimeLimitSec =
        req.body?.customTimeLimitSec !== undefined ? Number(req.body.customTimeLimitSec) : 0;
      const isSandbox = req.body?.isSandbox !== undefined ? Boolean(req.body.isSandbox) : true;
      const totalSlots = snapshots.reduce((sum, s) => sum + s.question.parts.length, 0);

      const session: SessionRecord = {
        sessionId: `cal_${crypto.randomUUID().slice(0, 12)}`,
        studentId: req.auth!.studentId,
        configVersionId: configData.configVersionId,
        mode: 'admin_calibration',
        sectionFilter: req.body?.section || undefined,
        title: `Admin Calibration (${snapshots.length} Qs${isSandbox ? ' · Sandbox' : ''})`,
        isSandbox,
        status: 'in_progress',
        plannedQuestionIds: snapshots.map((s) => s.questionId),
        checkpointRevision: 1,
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

      await repo.createSession(session, snapshots);
      res.status(201).json({ sessionId: session.sessionId, count: snapshots.length, session });
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
      const { pairs } = await resolveSessionQuestionPairs(repo, session);
      const inspectorByQuestionId: Record<string, QuestionItem> = {};
      for (const pair of pairs) {
        inspectorByQuestionId[pair.question.questionId] = pair.question;
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
      const existing = await repo.listQuestions({ includeHistorical: true });
      const stimIds = Array.from(
        new Set(existing.map((q) => q.stimulusId).filter((id): id is string => Boolean(id)))
      );
      const existingStimuli = await repo.listStimuliByIds(stimIds);
      const { report } = validateAndDryRunManifest(req.body?.manifest, existing, existingStimuli);
      res.json({ report });
    } catch (err) {
      console.error('POST /api/admin/import/dry-run error:', err);
      res.status(500).json({ error: 'Dry-run validation failed.' });
    }
  });

  app.post('/api/admin/import/commit', requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ensureSeeded();
      const existing = await repo.listQuestions({ includeHistorical: true });
      const stimIds = Array.from(
        new Set(existing.map((q) => q.stimulusId).filter((id): id is string => Boolean(id)))
      );
      const existingStimuli = await repo.listStimuliByIds(stimIds);
      const { manifest, report } = validateAndDryRunManifest(req.body?.manifest, existing, existingStimuli);
      if (!manifest || !report.valid) {
        res.status(400).json({ error: 'Manifest failed validation.', report });
        return;
      }
      const importedBy = req.auth?.email || req.auth?.studentId || 'admin';
      const result = await repo.importManifest(manifest, importedBy);
      const allLatest = await repo.listQuestions();
      const committedFamilies = new Set(manifest.questions.map((q) => q.questionFamilyId));
      const committedQuestions = allLatest.filter((q) => committedFamilies.has(q.questionFamilyId));
      const committedManifest: BankImportManifest = {
        ...manifest,
        questions: committedQuestions.length > 0 ? committedQuestions : manifest.questions,
      };
      res.json({ ok: true, result, batch: result.batch, report, manifest: committedManifest });
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

  app.get(['/api/admin/backup', '/api/admin/export/full'], requireAdmin, async (_req, res) => {
    try {
      await ensureSeeded();
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
      await ensureSeeded();
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
      await ensureSeeded();
      const report = await repo.runMigrationPreflight(UPLOADS_DIR);
      res.json({ report });
    } catch (err) {
      console.error('GET /api/admin/migrate/preflight error:', err);
      res.status(500).json({ error: 'Migration preflight check failed.' });
    }
  });

  app.post('/api/admin/migrate/apply', requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ensureSeeded();
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

  // ---------------------------------------------------------------------------
  // Frontend Serving (Vite dev middleware in dev, dist/ in production)
  // ---------------------------------------------------------------------------
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
  if (!options.skipVite) {
    if (process.env.NODE_ENV !== 'production') {
      const { createServer: createViteServer } = await import('vite');
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
  }

  return { app, repo };
}

const isEntrypoint =
  !process.env.VERCEL &&
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  Boolean(process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js'));

if (isEntrypoint) {
  createApp()
    .then(({ app, repo }) => {
      app.listen(PORT, '0.0.0.0', () => {
        console.log(
          `Selective Lab server listening on http://0.0.0.0:${PORT} (${repo.backendName})`
        );
      });
    })
    .catch((err) => {
      console.error('Fatal server startup error:', err);
      process.exit(1);
    });
}
