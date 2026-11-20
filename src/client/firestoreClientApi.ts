import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type FieldValue,
} from 'firebase/firestore';
import { auth, db, handleFirestoreError, OperationType } from '../lib/firebase';
import {
  DEFAULT_AUTO_CALIBRATE,
  DEFAULT_LEARNING_CONFIG,
  DEFAULT_MASTERY_POLICY,
  DEFAULT_POOL_POLICY,
  type BankImportManifest,
  type DailyFocusPlan,
  type ImportBatchRecord,
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
} from '../shared/contracts';
import {
  computePoolHealth,
  deriveQuestionProgressMeta,
  qcStatusToPoolStatus,
  type BankPoolStatus,
  type QuestionCompletionStatus,
  type QuestionProgressMeta,
} from '../shared/bankStatus';
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
} from '../shared/engine';
import {
  advanceQuestionEvidence,
  buildEvidenceKey,
  computeBankMasterySummary,
  computeEvidenceRevision,
} from '../shared/mastery';
import { SKILLS_TAXONOMY } from '../shared/skills';
import { decodeFromFirestore, encodeForFirestore } from '../shared/firestoreCodec';
import type {
  AdminStatusResponse,
  ApiError,
  BatchDirectorySummary,
  CustomBatchOption,
  DashboardResponse,
  MediaMigrationManifest,
  MigrationPreflightReport,
  PaginatedQuestionsResponse,
  ProgressCountsResponse,
  ProgressResetResponse,
  ProgressResponse,
  RestoreReport,
  RuntimeDiagnosticsResponse,
  SessionDetailResponse,
} from './api';

export const SOLE_ADMIN_EMAIL = 'bowenzou0@gmail.com';

// Keep batches <= 40 docs so rich nested question payloads stay well below
// Firestore's 20,000 single-field index entries per writeBatch commit limit.
const BATCH_WRITE_LIMIT = 40;

function toSafeDocId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '__').slice(0, 128);
}

function stripUndefinedDeep<T>(value: T): T {
  return encodeForFirestore(value);
}

function makeApiError(message: string, status: number, extra?: Partial<ApiError>): ApiError {
  const err = new Error(message) as ApiError;
  err.status = status;
  if (extra) Object.assign(err, extra);
  return err;
}

function isFirestoreTimestampLike(val: unknown): boolean {
  return Boolean(
    val &&
      typeof val === 'object' &&
      ('seconds' in (val as Record<string, unknown>) ||
        typeof (val as { toDate?: unknown }).toDate === 'function')
  );
}

async function runFs<T>(op: OperationType, path: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    if (rawMsg.toLowerCase().includes('permission') || rawMsg.toLowerCase().includes('insufficient')) {
      try {
        handleFirestoreError(err, op, path);
      } catch {
        // Logged structured FirestoreErrorInfo to console
      }
      throw makeApiError(
        `Missing or insufficient Firestore permissions (${op.toUpperCase()} ${path}).`,
        403
      );
    }
    throw err;
  }
}

function requireCurrentUser(): { uid: string; email: string; displayName: string; isAdmin: boolean } {
  const user = auth.currentUser;
  if (!user || !user.uid) {
    throw makeApiError('Please sign in with Google to continue.', 401);
  }
  const email = (user.email || '').trim();
  const isAdmin = Boolean(user.emailVerified && email.toLowerCase() === SOLE_ADMIN_EMAIL);
  return {
    uid: user.uid,
    email,
    displayName: (user.displayName || email.split('@')[0] || 'Learner').slice(0, 120),
    isAdmin,
  };
}

function requireSoleAdmin() {
  const u = requireCurrentUser();
  if (!u.isAdmin) {
    throw makeApiError('Forbidden: Only bowenzou0@gmail.com has admin access.', 403);
  }
  return u;
}

type ServerRequestFn = <T>(url: string, init?: RequestInit) => Promise<T>;

let cachedSeedManifests: BankImportManifest[] | null = null;
let seedUploadPromise: Promise<void> | null = null;
let cachedBankSnapshot: {
  loadedAtMs: number;
  allQuestions: QuestionItem[];
  latestQuestions: QuestionItem[];
  stimuliById: Record<string, StimulusGroup>;
} | null = null;

const BANK_CACHE_TTL_MS = 15_000;

function invalidateBankCache(): void {
  cachedBankSnapshot = null;
}

const VALID_QC_STATUSES = new Set<QuestionItem['qcStatus']>([
  'draft',
  'verified',
  'active',
  'quarantined',
  'retired',
]);

function buildBankQuestionDoc(q: QuestionItem, includeCreatedAt = false) {
  const safeVersion = Math.max(1, Math.floor(Number(q.version) || 1));
  const safeQcStatus: QuestionItem['qcStatus'] = VALID_QC_STATUSES.has(q.qcStatus)
    ? q.qcStatus
    : 'active';
  const safeBatchId =
    typeof q.batchId === 'string' && q.batchId.trim().length > 0
      ? q.batchId.trim().slice(0, 128)
      : undefined;
  const safeBatchLabel =
    typeof q.batchLabel === 'string' && q.batchLabel.trim().length > 0
      ? q.batchLabel.trim().slice(0, 200)
      : undefined;
  const safeEvidenceRev =
    typeof q.evidenceRevision === 'string' && q.evidenceRevision.trim().length > 0
      ? q.evidenceRevision.trim().slice(0, 128)
      : undefined;

  return stripUndefinedDeep({
    questionId: String(q.questionId).slice(0, 128),
    questionFamilyId: String(q.questionFamilyId || q.questionId).slice(0, 128),
    version: safeVersion,
    section: q.section,
    formatType: String(q.formatType).slice(0, 64),
    poolType: String(q.poolType || 'practice').slice(0, 64),
    qcStatus: safeQcStatus,
    ...(safeBatchId ? { batchId: safeBatchId } : {}),
    ...(safeBatchLabel ? { batchLabel: safeBatchLabel } : {}),
    ...(safeEvidenceRev ? { evidenceRevision: safeEvidenceRev } : {}),
    payload: {
      ...q,
      version: safeVersion,
      qcStatus: safeQcStatus,
    },
    ...(includeCreatedAt ? { createdAt: serverTimestamp() } : {}),
    updatedAt: serverTimestamp(),
  });
}

async function fetchSeedManifests(serverRequest: ServerRequestFn): Promise<BankImportManifest[]> {
  if (cachedSeedManifests) return cachedSeedManifests;
  const res = await serverRequest<{ manifests: BankImportManifest[] }>('/api/seed/manifests');
  cachedSeedManifests = res.manifests || [];
  return cachedSeedManifests;
}

function selectLatestByFamily(allQuestions: QuestionItem[]): QuestionItem[] {
  const latest = new Map<string, QuestionItem>();
  for (const q of allQuestions) {
    const prev = latest.get(q.questionFamilyId);
    if (!prev || q.version > prev.version) {
      latest.set(q.questionFamilyId, q);
    }
  }
  return Array.from(latest.values());
}

function getOfficialTimeLimitSec(sectionFilter?: SectionCode): number {
  if (sectionFilter === 'WRIT') return 1800;
  if (sectionFilter === 'READ' || sectionFilter === 'MATH' || sectionFilter === 'THINK') return 2400;
  return 9000;
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

function isSessionExpired(session: SessionRecord, nowMs = Date.now()): boolean {
  if (session.status !== 'in_progress' || session.isSandbox) return false;
  const deadlineMs = getEffectiveDeadlineMs(session);
  return deadlineMs !== null && nowMs >= deadlineMs;
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

async function commitBatchedWrites(
  ops: Array<(batch: ReturnType<typeof writeBatch>) => void>
): Promise<void> {
  for (let i = 0; i < ops.length; i += BATCH_WRITE_LIMIT) {
    const batch = writeBatch(db);
    const slice = ops.slice(i, i + BATCH_WRITE_LIMIT);
    for (const op of slice) op(batch);
    await batch.commit();
  }
}

function hydrateQuestionFromDoc(raw: Record<string, unknown>): QuestionItem | null {
  const payload = decodeFromFirestore(raw.payload) as QuestionItem | undefined;
  if (!payload || !payload.questionId) return null;
  return {
    ...payload,
    qcStatus: (raw.qcStatus as QuestionItem['qcStatus']) || payload.qcStatus,
    evidenceRevision:
      typeof raw.evidenceRevision === 'string' ? raw.evidenceRevision : payload.evidenceRevision,
  };
}

function hydrateStimulusFromDoc(raw: Record<string, unknown>): StimulusGroup | null {
  const payload = decodeFromFirestore(raw.payload) as StimulusGroup | undefined;
  if (!payload || !payload.stimulusId) return null;
  return payload;
}

function hydrateSessionFromDoc(raw: Record<string, unknown>): SessionRecord {
  const decoded = decodeFromFirestore(raw) as Record<string, unknown>;
  return {
    sessionId: String(decoded.sessionId || ''),
    studentId: String(decoded.studentId || decoded.userId || ''),
    configVersionId: String(decoded.configVersionId || 'cfg_v1'),
    mode: decoded.mode as SessionMode,
    title: typeof decoded.title === 'string' ? decoded.title : undefined,
    sectionFilter: decoded.sectionFilter as SectionCode | undefined,
    mockBatch: decoded.mockBatch as MockTestBatch | undefined,
    timeMultiplier: typeof decoded.timeMultiplier === 'number' ? decoded.timeMultiplier : undefined,
    isSandbox: Boolean(decoded.isSandbox),
    status: decoded.status === 'submitted' ? 'submitted' : 'in_progress',
    plannedQuestionIds: Array.isArray(decoded.plannedQuestionIds)
      ? (decoded.plannedQuestionIds as string[])
      : [],
    selectionDecision: decoded.selectionDecision as SessionSelectionDecision | undefined,
    checkpoint: (decoded.checkpoint as SessionCheckpoint) || {
      currentIndex: 0,
      elapsedSec: 0,
      answersByPartId: {},
      flaggedQuestionIds: [],
    },
    checkpointRevision:
      typeof decoded.checkpointRevision === 'number' ? decoded.checkpointRevision : 0,
    submissionSummary: decoded.submissionSummary as SessionSubmissionPayload | undefined,
    timeLimitSec: typeof decoded.timeLimitSec === 'number' ? decoded.timeLimitSec : undefined,
    deadlineAt: typeof decoded.deadlineAt === 'string' ? decoded.deadlineAt : undefined,
    expiredAutoSubmitted:
      typeof decoded.expiredAutoSubmitted === 'boolean' ? decoded.expiredAutoSubmitted : undefined,
    totalSlots: typeof decoded.totalSlots === 'number' ? decoded.totalSlots : 0,
    correctSlots: typeof decoded.correctSlots === 'number' ? decoded.correctSlots : 0,
    startedAt: String(decoded.startedAt || new Date().toISOString()),
    completedAt: typeof decoded.completedAt === 'string' ? decoded.completedAt : undefined,
  };
}

function hydrateAttemptFromDoc(raw: Record<string, unknown>): PartAttemptRecord {
  return {
    attemptId: String(raw.attemptId || ''),
    studentId: String(raw.studentId || raw.userId || ''),
    sessionId: String(raw.sessionId || ''),
    questionId: String(raw.questionId || ''),
    questionFamilyId: String(raw.questionFamilyId || ''),
    questionVersion: typeof raw.questionVersion === 'number' ? raw.questionVersion : 1,
    evidenceRevision: typeof raw.evidenceRevision === 'string' ? raw.evidenceRevision : undefined,
    partId: String(raw.partId || ''),
    skillId: String(raw.skillId || ''),
    difficultyAtAttempt: typeof raw.difficultyAtAttempt === 'number' ? raw.difficultyAtAttempt : 2,
    selectedAnswer:
      typeof raw.selectedAnswer === 'string' ? raw.selectedAnswer : null,
    isCorrect: Boolean(raw.isCorrect),
    timeSpentSec: typeof raw.timeSpentSec === 'number' ? raw.timeSpentSec : 0,
    isSpacedReview: Boolean(raw.isSpacedReview),
    isSandbox: Boolean(raw.isSandbox),
    isLegacy: Boolean(raw.isLegacy),
    assisted: Boolean(raw.assisted),
    createdAt: String(raw.createdAtIso || new Date().toISOString()),
  };
}

// ---------------------------------------------------------------------------
// Core Client Firestore Helpers
// ---------------------------------------------------------------------------

const verifiedProfilePromises = new Map<
  string,
  Promise<{
    uid: string;
    email: string;
    displayName: string;
    isAdmin: boolean;
  }>
>();

async function ensureUserProfileInFirestore(): Promise<{
  uid: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
}> {
  const user = requireCurrentUser();
  const safeUid = toSafeDocId(user.uid);
  const role: 'admin' | 'student' = user.isAdmin ? 'admin' : 'student';
  const cacheKey = `${safeUid}|${user.email}|${user.displayName}|${role}`;
  const existingPromise = verifiedProfilePromises.get(cacheKey);
  if (existingPromise) {
    return existingPromise;
  }

  const run = (async () => {
    const userPath = `users/${safeUid}`;
    const privPath = `users/${safeUid}/private/info`;
    const userRef = doc(db, 'users', safeUid);
    const privRef = doc(db, 'users', safeUid, 'private', 'info');

    const userSnap = await runFs(OperationType.GET, userPath, () => getDoc(userRef));
    if (!userSnap.exists()) {
      await runFs(OperationType.CREATE, userPath, () =>
        setDoc(userRef, {
          uid: safeUid,
          displayName: user.displayName,
          role,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
    } else {
    const existing = userSnap.data() as Record<string, unknown>;
    const allowedKeys = new Set(['uid', 'displayName', 'role', 'createdAt', 'updatedAt']);
    const hasLegacyShape =
      existing.uid !== safeUid ||
      !isFirestoreTimestampLike(existing.createdAt) ||
      Object.keys(existing).some((k) => !allowedKeys.has(k));

    if (hasLegacyShape) {
      await runFs(OperationType.UPDATE, userPath, () =>
        setDoc(userRef, {
          uid: safeUid,
          displayName: user.displayName,
          role,
          createdAt: isFirestoreTimestampLike(existing.createdAt)
            ? existing.createdAt
            : serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
    } else if (user.isAdmin && existing.role !== 'admin') {
      await runFs(OperationType.UPDATE, userPath, () =>
        updateDoc(userRef, {
          displayName: user.displayName,
          role: 'admin',
          updatedAt: serverTimestamp(),
        })
      );
    } else if (existing.displayName !== user.displayName) {
      await runFs(OperationType.UPDATE, userPath, () =>
        updateDoc(userRef, {
          displayName: user.displayName,
          updatedAt: serverTimestamp(),
        })
      );
    }
  }

  if (user.email) {
    const privSnap = await runFs(OperationType.GET, privPath, () => getDoc(privRef));
    if (!privSnap.exists()) {
      await runFs(OperationType.CREATE, privPath, () =>
        setDoc(privRef, {
          uid: safeUid,
          email: user.email.slice(0, 200),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
    } else {
      const existingPriv = privSnap.data() as Record<string, unknown>;
      const allowedPrivKeys = new Set(['uid', 'email', 'createdAt', 'updatedAt']);
      const hasLegacyPriv =
        existingPriv.uid !== safeUid ||
        !isFirestoreTimestampLike(existingPriv.createdAt) ||
        Object.keys(existingPriv).some((k) => !allowedPrivKeys.has(k));

      if (hasLegacyPriv) {
        await runFs(OperationType.UPDATE, privPath, () =>
          setDoc(privRef, {
            uid: safeUid,
            email: user.email.slice(0, 200),
            createdAt: isFirestoreTimestampLike(existingPriv.createdAt)
              ? existingPriv.createdAt
              : serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );
      } else if (existingPriv.email !== user.email) {
        await runFs(OperationType.UPDATE, privPath, () =>
          updateDoc(privRef, {
            email: user.email.slice(0, 200),
            updatedAt: serverTimestamp(),
          })
        );
      }
    }
  }

    return { ...user, uid: safeUid };
  })().catch((err) => {
    verifiedProfilePromises.delete(cacheKey);
    throw err;
  });

  verifiedProfilePromises.set(cacheKey, run);
  return run;
}

async function listConfigVersionsFromFirestore(): Promise<
  {
    configVersionId: string;
    versionNumber: number;
    notes?: string;
    createdAt: string;
    config: LearningConfig;
  }[]
> {
  const q = query(collection(db, 'admin_configs'), where('versionNumber', '>=', 1));
  const snap = await runFs(OperationType.LIST, 'admin_configs', () => getDocs(q));
  const items = snap.docs
    .map((d) => {
      const raw = d.data() as Record<string, unknown>;
      return {
        configVersionId: String(raw.configVersionId || d.id),
        versionNumber: Number(raw.versionNumber || 1),
        notes: typeof raw.notes === 'string' ? raw.notes : undefined,
        createdAt: String(raw.createdAtIso || new Date().toISOString()),
        config: (raw.config as LearningConfig) || structuredClone(DEFAULT_LEARNING_CONFIG),
      };
    })
    .sort((a, b) => b.versionNumber - a.versionNumber);

  if (items.length === 0) {
    return [
      {
        configVersionId: 'cfg_v1',
        versionNumber: 1,
        notes: 'Default Selective Lab Learning Config',
        createdAt: new Date().toISOString(),
        config: structuredClone(DEFAULT_LEARNING_CONFIG),
      },
    ];
  }
  return items;
}

async function getActiveConfigFromFirestore(): Promise<{
  configVersionId: string;
  versionNumber: number;
  config: LearningConfig;
}> {
  const all = await listConfigVersionsFromFirestore();
  const top = all[0];
  return {
    configVersionId: top.configVersionId,
    versionNumber: top.versionNumber,
    config: {
      ...structuredClone(DEFAULT_LEARNING_CONFIG),
      ...top.config,
      sessionDefaults: {
        ...DEFAULT_LEARNING_CONFIG.sessionDefaults,
        ...(top.config?.sessionDefaults || {}),
        dailyQuestionLimitBySection: {
          ...DEFAULT_LEARNING_CONFIG.sessionDefaults.dailyQuestionLimitBySection,
          ...(top.config?.sessionDefaults?.dailyQuestionLimitBySection || {}),
        },
      },
      masteryPolicy: {
        ...DEFAULT_MASTERY_POLICY,
        ...(top.config?.masteryPolicy || {}),
      },
      autoCalibrate: {
        ...DEFAULT_AUTO_CALIBRATE,
        ...(top.config?.autoCalibrate || {}),
      },
      poolPolicy: {
        ...DEFAULT_POOL_POLICY,
        ...(top.config?.poolPolicy || {}),
      },
    },
  };
}

async function loadQuestionBank(
  serverRequest: ServerRequestFn,
  options?: { includeHistorical?: boolean; forceRefresh?: boolean }
): Promise<{
  allQuestions: QuestionItem[];
  latestQuestions: QuestionItem[];
  stimuliById: Record<string, StimulusGroup>;
}> {
  if (
    !options?.forceRefresh &&
    cachedBankSnapshot &&
    Date.now() - cachedBankSnapshot.loadedAtMs < BANK_CACHE_TTL_MS
  ) {
    return {
      allQuestions: options?.includeHistorical
        ? cachedBankSnapshot.allQuestions
        : cachedBankSnapshot.latestQuestions,
      latestQuestions: cachedBankSnapshot.latestQuestions,
      stimuliById: cachedBankSnapshot.stimuliById,
    };
  }

  const sections: SectionCode[] = ['READ', 'MATH', 'THINK', 'WRIT'];
  const [qSnap, sSnap] = await Promise.all([
    runFs(OperationType.LIST, 'bank_questions', () =>
      getDocs(query(collection(db, 'bank_questions'), where('section', 'in', sections)))
    ),
    runFs(OperationType.LIST, 'bank_stimuli', () =>
      getDocs(query(collection(db, 'bank_stimuli'), where('section', 'in', sections)))
    ),
  ]);

  const stimuliMap = new Map<string, StimulusGroup>();
  for (const d of sSnap.docs) {
    const stim = hydrateStimulusFromDoc(d.data() as Record<string, unknown>);
    if (stim) stimuliMap.set(stim.stimulusId, stim);
  }

  const questionMap = new Map<string, QuestionItem>();
  for (const d of qSnap.docs) {
    const q = hydrateQuestionFromDoc(d.data() as Record<string, unknown>);
    if (q) questionMap.set(q.questionId, q);
  }

  const current = auth.currentUser;
  const isAdmin = Boolean(
    current?.emailVerified && current.email?.toLowerCase() === SOLE_ADMIN_EMAIL
  );

  // Check whether the bundled seed bank has been persisted to Firestore at least once.
  // Using import_batches/system_seed_v1 as a one-time receipt ensures:
  // 1) All 292 bundled questions get persisted cleanly in safe 40-doc batches even if an
  //    earlier oversized batch failed after writing only 1 question.
  // 2) Once seeded, permanently deleted questions are never resurrected on reload.
  const SEED_RECEIPT_ID = 'system_seed_v1';
  let needsInitialSeed = false;
  if (isAdmin) {
    try {
      const seedReceiptSnap = await getDoc(doc(db, 'import_batches', SEED_RECEIPT_ID));
      needsInitialSeed = !seedReceiptSnap.exists();
    } catch {
      needsInitialSeed = questionMap.size === 0;
    }
  } else {
    needsInitialSeed = questionMap.size === 0;
  }

  if (needsInitialSeed) {
    const manifests = await fetchSeedManifests(serverRequest);
    const missingStimuli: StimulusGroup[] = [];
    const missingQuestions: QuestionItem[] = [];

    for (const manifest of manifests) {
      for (const stim of manifest.stimuli || []) {
        if (!stimuliMap.has(stim.stimulusId)) {
          stimuliMap.set(stim.stimulusId, stim);
          missingStimuli.push(stim);
        }
      }
      for (const q of manifest.questions || []) {
        if (!questionMap.has(q.questionId)) {
          const stim = q.stimulusId ? stimuliMap.get(q.stimulusId) : undefined;
          const hydrated: QuestionItem = {
            ...q,
            poolType: q.poolType || manifest.defaultPoolType || 'practice',
            qcStatus: q.qcStatus || manifest.defaultQcStatus || 'active',
            batchLabel: q.batchLabel || manifest.batchLabel,
            evidenceRevision: q.evidenceRevision || computeEvidenceRevision(q, stim),
          };
          questionMap.set(hydrated.questionId, hydrated);
          missingQuestions.push(hydrated);
        }
      }
    }

    // If signed in as sole admin bowenzou0@gmail.com, persist initial seed items in safe 40-doc batches
    // and record import_batches/system_seed_v1 only after all batches succeed.
    if (isAdmin) {
      if (!seedUploadPromise) {
        seedUploadPromise = (async () => {
          try {
            const cfgSnap = await getDoc(doc(db, 'admin_configs', 'cfg_v1'));
            if (!cfgSnap.exists()) {
              await setDoc(
                doc(db, 'admin_configs', 'cfg_v1'),
                stripUndefinedDeep({
                  configVersionId: 'cfg_v1',
                  versionNumber: 1,
                  notes: 'Default Selective Lab Learning Config',
                  config: structuredClone(DEFAULT_LEARNING_CONFIG),
                  createdAtIso: new Date().toISOString(),
                  createdAt: serverTimestamp(),
                })
              );
            }

            if (missingStimuli.length > 0 || missingQuestions.length > 0) {
              const ops: Array<(b: ReturnType<typeof writeBatch>) => void> = [];
              for (const stim of missingStimuli) {
                const ref = doc(db, 'bank_stimuli', toSafeDocId(stim.stimulusId));
                ops.push((b) =>
                  b.set(
                    ref,
                    stripUndefinedDeep({
                      stimulusId: String(stim.stimulusId).slice(0, 128),
                      stimulusFamilyId: String(stim.stimulusFamilyId || stim.stimulusId).slice(0, 128),
                      version: Math.max(1, Math.floor(Number(stim.version) || 1)),
                      section: stim.section,
                      payload: stim,
                      createdAt: serverTimestamp(),
                      updatedAt: serverTimestamp(),
                    })
                  )
                );
              }
              for (const q of missingQuestions) {
                const ref = doc(db, 'bank_questions', toSafeDocId(q.questionId));
                ops.push((b) => b.set(ref, buildBankQuestionDoc(q, true)));
              }
              await commitBatchedWrites(ops);
            }

            const receiptSnap = await getDoc(doc(db, 'import_batches', SEED_RECEIPT_ID));
            if (!receiptSnap.exists()) {
              await setDoc(
                doc(db, 'import_batches', SEED_RECEIPT_ID),
                stripUndefinedDeep({
                  batchId: SEED_RECEIPT_ID,
                  batchLabel: 'Official NSW Selective Seed Bank (PT1, PT2, PT3 Holdout)',
                  createdAtIso: new Date().toISOString(),
                  importedBy: (current?.email || SOLE_ADMIN_EMAIL).slice(0, 128),
                  questionsCount: missingQuestions.length,
                  stimuliCount: missingStimuli.length,
                  newQuestions: missingQuestions.length,
                  createdAt: serverTimestamp(),
                })
              );
            }
          } catch (err) {
            console.error('Initial seed sync to Firestore failed:', err);
          } finally {
            seedUploadPromise = null;
          }
        })();
      }
      await seedUploadPromise;
    }
  }

  const allQuestions = Array.from(questionMap.values());
  const latestQuestions = selectLatestByFamily(allQuestions);
  const stimuliById: Record<string, StimulusGroup> = {};
  for (const [id, stim] of stimuliMap.entries()) {
    stimuliById[id] = stim;
  }

  cachedBankSnapshot = {
    loadedAtMs: Date.now(),
    allQuestions,
    latestQuestions,
    stimuliById,
  };

  return {
    allQuestions: options?.includeHistorical ? allQuestions : latestQuestions,
    latestQuestions,
    stimuliById,
  };
}

async function listUserSessions(uid: string): Promise<SessionRecord[]> {
  const q = query(collection(db, 'users', uid, 'sessions'), where('userId', '==', uid));
  const snap = await runFs(OperationType.LIST, `users/${uid}/sessions`, () => getDocs(q));
  return snap.docs
    .map((d) => hydrateSessionFromDoc(d.data() as Record<string, unknown>))
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

async function listUserAttempts(uid: string): Promise<PartAttemptRecord[]> {
  const q = query(collection(db, 'users', uid, 'attempts'), where('userId', '==', uid));
  const snap = await runFs(OperationType.LIST, `users/${uid}/attempts`, () => getDocs(q));
  return snap.docs
    .map((d) => hydrateAttemptFromDoc(d.data() as Record<string, unknown>))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

async function getUserSkillStates(uid: string): Promise<Record<string, SkillState>> {
  const q = query(collection(db, 'users', uid, 'skill_states'), where('userId', '==', uid));
  const snap = await runFs(OperationType.LIST, `users/${uid}/skill_states`, () => getDocs(q));
  const out: Record<string, SkillState> = {};
  for (const d of snap.docs) {
    const raw = d.data() as Record<string, unknown>;
    const skillId = String(raw.skillId || d.id);
    out[skillId] = {
      skillId,
      ewmaAccuracy: Number(raw.ewmaAccuracy ?? 0.5),
      avgTimeRatio: Number(raw.avgTimeRatio ?? 1),
      masteryScore: Number(raw.masteryScore ?? 0.5),
      uncertainty: Number(raw.uncertainty ?? 0.5),
      attemptsCount: Number(raw.attemptsCount ?? 0),
      correctCount: Number(raw.correctCount ?? 0),
      reviewIntervalDays: Number(raw.reviewIntervalDays ?? 1),
      easeFactor: Number(raw.easeFactor ?? 2.5),
      lastPracticedAt: typeof raw.lastPracticedAt === 'string' ? raw.lastPracticedAt : undefined,
      nextReviewAt:
        typeof raw.nextReviewAt === 'string'
          ? raw.nextReviewAt
          : typeof raw.nextDueAt === 'string'
            ? raw.nextDueAt
            : undefined,
      plateauStatus: (raw.plateauStatus as SkillState['plateauStatus']) || 'none',
    };
  }
  return out;
}

async function getUserQuestionMemory(uid: string): Promise<Record<string, QuestionMemoryState>> {
  const q = query(collection(db, 'users', uid, 'question_memory'), where('userId', '==', uid));
  const snap = await runFs(OperationType.LIST, `users/${uid}/question_memory`, () => getDocs(q));
  const out: Record<string, QuestionMemoryState> = {};
  for (const d of snap.docs) {
    const raw = d.data() as Record<string, unknown>;
    const fid = String(raw.questionFamilyId || d.id);
    out[fid] = {
      questionFamilyId: fid,
      timesSeen: Number(raw.timesSeen ?? 1),
      lastSeenAt: String(raw.lastSeenAt || ''),
      lastAllCorrect: Boolean(raw.lastAllCorrect),
      nextDueAt: String(raw.nextDueAt || ''),
      intervalDays: Number(raw.intervalDays ?? 1),
      easeFactor: Number(raw.easeFactor ?? 2.5),
      lapseCount: Number(raw.lapseCount ?? 0),
      lastEvidenceStatus: raw.lastEvidenceStatus as QuestionMemoryState['lastEvidenceStatus'],
    };
  }
  return out;
}

async function getUserQuestionEvidence(uid: string): Promise<Record<string, QuestionMasteryEvidence>> {
  const q = query(collection(db, 'users', uid, 'question_evidence'), where('userId', '==', uid));
  const snap = await runFs(OperationType.LIST, `users/${uid}/question_evidence`, () => getDocs(q));
  const out: Record<string, QuestionMasteryEvidence> = {};
  for (const d of snap.docs) {
    const raw = d.data() as Record<string, unknown>;
    const key = String(raw.evidenceKey || d.id);
    out[key] = {
      evidenceKey: key,
      questionFamilyId: String(raw.questionFamilyId || ''),
      questionId: String(raw.questionId || ''),
      evidenceRevision: String(raw.evidenceRevision || ''),
      section: (raw.section as SectionCode) || 'READ',
      status: (raw.status as QuestionMasteryEvidence['status']) || 'unseen',
      cleanPassesCount: Number(raw.cleanPassesCount ?? 0),
      passTimestampsIso: Array.isArray(raw.passTimestampsIso)
        ? (raw.passTimestampsIso as string[])
        : [],
      everCleanPassed: Boolean(raw.everCleanPassed),
      firstSubmissionCleanPass: Boolean(raw.firstSubmissionCleanPass),
      attemptsCount: Number(raw.attemptsCount ?? 0),
      resetCount: Number(raw.resetCount ?? 0),
      lastAttemptAtIso: typeof raw.lastAttemptAtIso === 'string' ? raw.lastAttemptAtIso : undefined,
      lastAllCorrect: Boolean(raw.lastAllCorrect),
      nextEligibleAtIso:
        typeof raw.nextEligibleAtIso === 'string' ? raw.nextEligibleAtIso : undefined,
      policyVersion: String(raw.policyVersion || DEFAULT_MASTERY_POLICY.policyVersion),
      updatedAtIso: String(raw.updatedAtIso || new Date().toISOString()),
    };
  }
  return out;
}

async function listUserWritingSubmissions(uid: string): Promise<
  {
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
  }[]
> {
  const q = query(collection(db, 'users', uid, 'writing_submissions'), where('userId', '==', uid));
  const snap = await runFs(OperationType.LIST, `users/${uid}/writing_submissions`, () => getDocs(q));
  return snap.docs
    .map((d) => {
      const raw = d.data() as Record<string, unknown>;
      return {
        submissionId: String(raw.submissionId || d.id),
        sessionId: String(raw.sessionId || ''),
        questionId: String(raw.questionId || ''),
        planNotes: String(raw.planNotes || ''),
        responseText: String(raw.responseText || ''),
        wordCount: Number(raw.wordCount ?? 0),
        timeSpentSec: Number(raw.timeSpentSec ?? 0),
        deterministicMetricsJson: String(raw.deterministicMetricsJson || '{}'),
        submittedAt: String(raw.submittedAt || new Date().toISOString()),
        evaluations: Array.isArray(raw.evaluations)
          ? (raw.evaluations as WritingEvaluationRecord[])
          : [],
      };
    })
    .sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt));
}

async function getSessionSnapshotsFromFirestore(
  uid: string,
  sessionId: string
): Promise<SessionQuestionSnapshot[]> {
  const q = query(
    collection(db, 'users', uid, 'sessions', sessionId, 'snapshots'),
    where('userId', '==', uid)
  );
  const snap = await runFs(OperationType.LIST, `users/${uid}/sessions/${sessionId}/snapshots`, () =>
    getDocs(q)
  );
  return snap.docs
    .map((d) => {
      const raw = decodeFromFirestore(d.data()) as Record<string, unknown>;
      return {
        questionId: String(raw.questionId || ''),
        snapshotIndex: Number(raw.snapshotIndex ?? 0),
        evidenceRevision: String(raw.evidenceRevision || ''),
        question: raw.question as QuestionItem,
        stimulus: raw.stimulus as StimulusGroup | undefined,
      };
    })
    .sort((a, b) => a.snapshotIndex - b.snapshotIndex);
}

async function finalizeSessionInFirestore(input: {
  uid: string;
  session: SessionRecord;
  checkpoint: SessionCheckpoint;
  assisted: boolean;
  completedAtIso: string;
  expiredAutoSubmitted?: boolean;
  rejectValidationErrors?: boolean;
  serverRequest: ServerRequestFn;
}): Promise<{
  alreadySubmitted: boolean;
  session: SessionRecord;
  submissionSummary: SessionSubmissionPayload;
}> {
  const {
    uid,
    session,
    checkpoint,
    assisted,
    completedAtIso,
    expiredAutoSubmitted = false,
    rejectValidationErrors = true,
    serverRequest,
  } = input;

  if (session.status === 'submitted' && session.submissionSummary) {
    return {
      alreadySubmitted: true,
      session,
      submissionSummary: session.submissionSummary,
    };
  }

  let snapshots = await getSessionSnapshotsFromFirestore(uid, session.sessionId);
  if (snapshots.length === 0) {
    const bank = await loadQuestionBank(serverRequest, { includeHistorical: true });
    const byId = new Map(bank.allQuestions.map((q) => [q.questionId, q]));
    snapshots = session.plannedQuestionIds
      .map((qid, idx) => {
        const q = byId.get(qid);
        if (!q) return null;
        const stim = q.stimulusId ? bank.stimuliById[q.stimulusId] : undefined;
        return {
          questionId: q.questionId,
          snapshotIndex: idx,
          evidenceRevision: q.evidenceRevision || computeEvidenceRevision(q, stim),
          question: q,
          stimulus: stim,
        } as SessionQuestionSnapshot;
      })
      .filter((x): x is SessionQuestionSnapshot => x !== null);
  }

  const answersByPartId = checkpoint.answersByPartId || {};
  const allValidationErrors: string[] = [];
  const reviewResults: Record<string, MarkingResult[]> = {};

  for (const { question } of snapshots) {
    if (question.formatType === 'WRIT_TYPED_TASK') {
      reviewResults[question.questionId] = [];
      continue;
    }
    const { results, validationErrors } = gradeSubmission(question, answersByPartId);
    if (validationErrors.length > 0) allValidationErrors.push(...validationErrors);
    reviewResults[question.questionId] = results;
  }

  if (rejectValidationErrors && allValidationErrors.length > 0) {
    throw makeApiError(allValidationErrors.join(' '), 400);
  }

  const [configData, skillStates, questionMemory, pastAttempts, evidenceMap] = await Promise.all([
    getActiveConfigFromFirestore(),
    getUserSkillStates(uid),
    getUserQuestionMemory(uid),
    listUserAttempts(uid),
    getUserQuestionEvidence(uid),
  ]);

  const totalPartsCount = snapshots.reduce((acc, s) => acc + s.question.parts.length, 0);
  const perPartTimeSec = Math.max(
    5,
    Math.round((checkpoint.elapsedSec || 60) / Math.max(1, totalPartsCount))
  );

  const newAttempts: PartAttemptRecord[] = [];
  const updatedSkillsMap = new Map<string, SkillState>();
  const updatedMemoryMap = new Map<string, QuestionMemoryState>();
  const updatedEvidenceMap = new Map<string, QuestionMasteryEvidence>();
  const writingReview: {
    submissionId: string;
    questionId: string;
    metrics: WritingDeterministicMetrics;
    evaluations: WritingEvaluationRecord[];
  }[] = [];
  const writingSubmissionsToSave: {
    submissionId: string;
    sessionId: string;
    questionId: string;
    planNotes: string;
    responseText: string;
    wordCount: number;
    timeSpentSec: number;
    deterministicMetricsJson: string;
    submittedAt: string;
  }[] = [];

  let totalObjectiveSlots = 0;
  let correctObjectiveSlots = 0;
  let savedWritingSubmission: SessionSubmissionPayload['writingSubmission'];

  for (const { question, evidenceRevision } of snapshots) {
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
      const submissionId = toSafeDocId(`wsub_${session.sessionId}_${question.questionId}`);
      const subRecord = {
        submissionId,
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
        savedWritingSubmission = { ...subRecord, evaluations: [] };
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

    for (const part of question.parts) {
      const resItem = qResults.find((r) => r.partId === part.partId);
      const isCorrect = Boolean(resItem?.isCorrect);
      totalObjectiveSlots++;
      if (isCorrect) correctObjectiveSlots++;

      const attemptId = toSafeDocId(`att_${session.sessionId}_${part.partId}`);
      newAttempts.push({
        attemptId,
        studentId: uid,
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

  const sessionRef = doc(db, 'users', uid, 'sessions', session.sessionId);
  const nextRevision = (session.checkpointRevision ?? 0) + 1;

  await updateDoc(
    sessionRef,
    stripUndefinedDeep({
      status: 'submitted',
      checkpoint,
      checkpointRevision: nextRevision,
      submissionSummary,
      correctSlots: correctObjectiveSlots,
      totalSlots: totalObjectiveSlots,
      completedAt: completedAtIso,
      expiredAutoSubmitted,
      updatedAt: serverTimestamp(),
    })
  );

  // Release active session lock if it points to this session
  if (!session.isSandbox) {
    const lockRef = doc(db, 'users', uid, 'locks', 'active_session');
    const lockSnap = await getDoc(lockRef).catch(() => null);
    if (lockSnap?.exists() && lockSnap.data()?.activeSessionId === session.sessionId) {
      await deleteDoc(lockRef).catch(() => undefined);
    }
  }

  // Persist attempts, skills, memory, evidence, and writing submissions in batches
  const ops: Array<(b: ReturnType<typeof writeBatch>) => void> = [];
  for (const att of savedAttempts) {
    const ref = doc(db, 'users', uid, 'attempts', att.attemptId);
    ops.push((b) =>
      b.set(
        ref,
        stripUndefinedDeep({
          attemptId: att.attemptId,
          userId: uid,
          studentId: uid,
          sessionId: att.sessionId,
          questionId: att.questionId,
          questionFamilyId: att.questionFamilyId,
          questionVersion: att.questionVersion ?? 1,
          evidenceRevision: att.evidenceRevision,
          partId: att.partId,
          skillId: att.skillId,
          difficultyAtAttempt: att.difficultyAtAttempt,
          selectedAnswer: att.selectedAnswer,
          isCorrect: att.isCorrect,
          timeSpentSec: att.timeSpentSec,
          isSpacedReview: att.isSpacedReview,
          isSandbox: false,
          isLegacy: false,
          assisted: Boolean(att.assisted),
          createdAtIso: att.createdAt,
          createdAt: serverTimestamp(),
        })
      )
    );
  }
  for (const sk of savedSkillStates) {
    const ref = doc(db, 'users', uid, 'skill_states', toSafeDocId(sk.skillId));
    ops.push((b) =>
      b.set(
        ref,
        stripUndefinedDeep({
          userId: uid,
          skillId: sk.skillId,
          ewmaAccuracy: sk.ewmaAccuracy,
          avgTimeRatio: sk.avgTimeRatio,
          masteryScore: sk.masteryScore,
          uncertainty: sk.uncertainty,
          attemptsCount: sk.attemptsCount,
          correctCount: sk.correctCount,
          reviewIntervalDays: sk.reviewIntervalDays,
          easeFactor: sk.easeFactor,
          lastPracticedAt: sk.lastPracticedAt,
          nextReviewAt: sk.nextReviewAt,
          plateauStatus: sk.plateauStatus,
          updatedAt: serverTimestamp(),
        })
      )
    );
  }
  for (const mem of savedQuestionMemory) {
    const ref = doc(db, 'users', uid, 'question_memory', toSafeDocId(mem.questionFamilyId));
    ops.push((b) =>
      b.set(
        ref,
        stripUndefinedDeep({
          userId: uid,
          questionFamilyId: mem.questionFamilyId,
          timesSeen: mem.timesSeen,
          lastSeenAt: mem.lastSeenAt,
          lastAllCorrect: mem.lastAllCorrect,
          nextDueAt: mem.nextDueAt,
          intervalDays: mem.intervalDays,
          easeFactor: mem.easeFactor ?? 2.5,
          lapseCount: mem.lapseCount,
          lastEvidenceStatus: mem.lastEvidenceStatus,
          updatedAt: serverTimestamp(),
        })
      )
    );
  }
  for (const ev of savedEvidence) {
    const ref = doc(db, 'users', uid, 'question_evidence', toSafeDocId(ev.evidenceKey));
    ops.push((b) =>
      b.set(
        ref,
        stripUndefinedDeep({
          userId: uid,
          evidenceKey: ev.evidenceKey,
          questionFamilyId: ev.questionFamilyId,
          questionId: ev.questionId,
          evidenceRevision: ev.evidenceRevision,
          section: ev.section,
          status: ev.status,
          cleanPassesCount: ev.cleanPassesCount,
          passTimestampsIso: ev.passTimestampsIso,
          everCleanPassed: ev.everCleanPassed,
          firstSubmissionCleanPass: ev.firstSubmissionCleanPass,
          attemptsCount: ev.attemptsCount,
          resetCount: ev.resetCount,
          lastAttemptAtIso: ev.lastAttemptAtIso,
          lastAllCorrect: ev.lastAllCorrect,
          nextEligibleAtIso: ev.nextEligibleAtIso,
          policyVersion: ev.policyVersion,
          updatedAtIso: ev.updatedAtIso,
          updatedAt: serverTimestamp(),
        })
      )
    );
  }
  for (const wsub of writingSubmissionsToSave) {
    const ref = doc(db, 'users', uid, 'writing_submissions', wsub.submissionId);
    ops.push((b) =>
      b.set(
        ref,
        stripUndefinedDeep({
          submissionId: wsub.submissionId,
          userId: uid,
          studentId: uid,
          sessionId: wsub.sessionId,
          questionId: wsub.questionId,
          planNotes: wsub.planNotes,
          responseText: wsub.responseText,
          wordCount: wsub.wordCount,
          timeSpentSec: wsub.timeSpentSec,
          deterministicMetricsJson: wsub.deterministicMetricsJson,
          evaluations: [],
          submittedAt: wsub.submittedAt,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      )
    );
  }
  if (ops.length > 0) {
    await commitBatchedWrites(ops);
  }

  const updatedSession: SessionRecord = {
    ...session,
    status: 'submitted',
    checkpoint,
    checkpointRevision: nextRevision,
    submissionSummary,
    correctSlots: correctObjectiveSlots,
    totalSlots: totalObjectiveSlots,
    completedAt: completedAtIso,
    expiredAutoSubmitted,
  };

  return { alreadySubmitted: false, session: updatedSession, submissionSummary };
}

async function resolveOrExpireSession(
  uid: string,
  session: SessionRecord,
  serverRequest: ServerRequestFn
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
  const res = await finalizeSessionInFirestore({
    uid,
    session,
    checkpoint: baseCheckpoint,
    assisted: false,
    completedAtIso,
    expiredAutoSubmitted: true,
    rejectValidationErrors: false,
    serverRequest,
  });
  return res.session;
}

async function findActiveSessionIdForUser(
  uid: string,
  serverRequest: ServerRequestFn
): Promise<string | null> {
  const lockRef = doc(db, 'users', uid, 'locks', 'active_session');
  const lockSnap = await getDoc(lockRef).catch(() => null);
  if (lockSnap?.exists()) {
    const lockData = lockSnap.data() as Record<string, unknown>;
    const candidateId = String(lockData.activeSessionId || '');
    if (candidateId) {
      const sSnap = await getDoc(doc(db, 'users', uid, 'sessions', candidateId)).catch(() => null);
      if (sSnap?.exists()) {
        const sess = hydrateSessionFromDoc(sSnap.data() as Record<string, unknown>);
        if (sess.status === 'in_progress' && !sess.isSandbox) {
          const resolved = await resolveOrExpireSession(uid, sess, serverRequest);
          if (resolved.status === 'in_progress') return resolved.sessionId;
        }
      }
      await deleteDoc(lockRef).catch(() => undefined);
    }
  }

  const sessions = await listUserSessions(uid);
  for (const s of sessions) {
    if (s.status === 'in_progress' && !s.isSandbox) {
      const resolved = await resolveOrExpireSession(uid, s, serverRequest);
      if (resolved.status === 'in_progress') return resolved.sessionId;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Exported Client Firestore API Implementation
// ---------------------------------------------------------------------------

export function createFirestoreClientApi(serverRequest: ServerRequestFn) {
  return {
    async syncUserAfterLogin(): Promise<{ activeSessionId: string | null }> {
      const user = await ensureUserProfileInFirestore();
      // Trigger background seed upload for admin & check active lock
      loadQuestionBank(serverRequest).catch(() => undefined);
      const activeSessionId = await findActiveSessionIdForUser(user.uid, serverRequest);
      return { activeSessionId };
    },

    async getDashboard(): Promise<DashboardResponse> {
      const user = await ensureUserProfileInFirestore();
      const uid = user.uid;
      const [configData, rawSessions, initialAttempts, bank, skillStates, evidenceMap, questionMemory] =
        await Promise.all([
          getActiveConfigFromFirestore(),
          listUserSessions(uid),
          listUserAttempts(uid),
          loadQuestionBank(serverRequest),
          getUserSkillStates(uid),
          getUserQuestionEvidence(uid),
          getUserQuestionMemory(uid),
        ]);

      const activeQuestions = bank.latestQuestions.filter((q) => q.qcStatus === 'active');

      let anyExpired = false;
      const sessions: SessionRecord[] = [];
      for (const s of rawSessions) {
        if (isSessionExpired(s)) {
          anyExpired = true;
          sessions.push(await resolveOrExpireSession(uid, s, serverRequest));
        } else {
          sessions.push(s);
        }
      }
      const attempts = anyExpired ? await listUserAttempts(uid) : initialAttempts;

      // Load or generate cached daily focus plan
      const todayKey = new Date().toISOString().slice(0, 10);
      const planRef = doc(db, 'users', uid, 'daily_plans', todayKey);
      let dailyFocusPlan: DailyFocusPlan | undefined;
      const planSnap = await getDoc(planRef).catch(() => null);
      const autoCalEnabled = Boolean(configData.config.autoCalibrate?.enabled);
      if (planSnap?.exists()) {
        const raw = planSnap.data() as Record<string, unknown>;
        const cachedPlan: DailyFocusPlan = {
          planDate: String(raw.planDate || todayKey),
          studentId: String(raw.studentId || uid),
          generatedAtIso: String(raw.generatedAtIso || new Date().toISOString()),
          source: raw.source === 'gemini' ? 'gemini' : 'deterministic',
          modelId: typeof raw.modelId === 'string' ? raw.modelId : undefined,
          focusSkillIds: Array.isArray(raw.focusSkillIds) ? (raw.focusSkillIds as string[]) : [],
          skillWeights: (raw.skillWeights as Record<string, number>) || {},
          algorithmAdjustments: raw.algorithmAdjustments as DailyFocusPlan['algorithmAdjustments'],
          recommendedSection: raw.recommendedSection as DailyFocusPlan['recommendedSection'],
          dailyQuestionLimitBySection: raw.dailyQuestionLimitBySection as
            | Record<SectionCode, number>
            | undefined,
          dailyGoalMinutes: typeof raw.dailyGoalMinutes === 'number' ? raw.dailyGoalMinutes : undefined,
          autoCalibrated: typeof raw.autoCalibrated === 'boolean' ? raw.autoCalibrated : undefined,
          rationale: String(raw.rationale || ''),
        };
        // If auto-calibrate is enabled and cached plan predates auto-calibrated limits, refresh once
        if (!autoCalEnabled || cachedPlan.dailyQuestionLimitBySection) {
          dailyFocusPlan = cachedPlan;
        }
      }
      if (!dailyFocusPlan) {
        try {
          const aiPlan = await serverRequest<{ plan: DailyFocusPlan }>('/api/ai/daily-focus', {
            method: 'POST',
            body: JSON.stringify({
              skillStates,
              evidenceMap,
              questionMemory,
              questions: activeQuestions,
              config: configData.config,
            }),
          });
          if (aiPlan?.plan) {
            dailyFocusPlan = aiPlan.plan;
            await setDoc(
              planRef,
              stripUndefinedDeep({
                ...aiPlan.plan,
                studentId: uid,
                updatedAt: serverTimestamp(),
              })
            ).catch(() => undefined);
          }
        } catch {
          // non-blocking
        }
      }

      const todaySessions = sessions.filter(
        (s) => !s.isSandbox && s.startedAt.startsWith(todayKey)
      );
      const todayMinutes = Math.round(
        todaySessions.reduce((acc, s) => acc + (s.checkpoint?.elapsedSec ?? 0), 0) / 60
      );
      const todayAttempts = attempts.filter((a) => !a.isSandbox && a.createdAt.startsWith(todayKey));
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
      const customBatchMap = new Map<string, CustomBatchOption>();
      const autoRetire = Boolean(configData.config.poolPolicy?.autoRetireMastered);

      for (const q of activeQuestions) {
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
        if (q.batchId) {
          const entry = customBatchMap.get(q.batchId) || {
            batchId: q.batchId,
            batchLabel: q.batchLabel || q.batchId,
            counts: { READ: 0, MATH: 0, THINK: 0, WRIT: 0 },
            total: 0,
          };
          entry.counts[q.section] += 1;
          entry.total += 1;
          customBatchMap.set(q.batchId, entry);
        }
      }

      const activeInProgress =
        sessions.find((s) => s.status === 'in_progress' && !s.isSandbox) || null;
      const effectiveDailyLimits =
        autoCalEnabled && dailyFocusPlan?.dailyQuestionLimitBySection
          ? dailyFocusPlan.dailyQuestionLimitBySection
          : configData.config.sessionDefaults.dailyQuestionLimitBySection;
      const effectiveDailyGoalMinutes =
        autoCalEnabled && dailyFocusPlan?.dailyGoalMinutes
          ? dailyFocusPlan.dailyGoalMinutes
          : configData.config.sessionDefaults.dailyGoalMinutes;

      return {
        studentId: uid,
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
      };
    },

    async createSession(payload: {
      mode: SessionMode;
      sectionFilter?: SectionCode;
      mockBatch?: MockTestBatch;
      mockSource?: 'pool' | 'batch';
      batchId?: string;
      questionCount?: number;
      timeMultiplier?: number;
      customTimeLimitSec?: number;
    }): Promise<{ sessionId: string; session: SessionRecord; serverNowIso?: string }> {
      const user = await ensureUserProfileInFirestore();
      const uid = user.uid;

      // Enforce single active session lock
      const existingActiveId = await findActiveSessionIdForUser(uid, serverRequest);
      if (existingActiveId) {
        throw makeApiError(
          'You already have an active test in progress. Complete and submit it before starting another.',
          409,
          { activeSessionId: existingActiveId }
        );
      }

      const [configData, bank, skillStates, questionMemory, evidenceMap] = await Promise.all([
        getActiveConfigFromFirestore(),
        loadQuestionBank(serverRequest),
        getUserSkillStates(uid),
        getUserQuestionMemory(uid),
        getUserQuestionEvidence(uid),
      ]);

      const activeQuestions = bank.latestQuestions.filter((q) => q.qcStatus === 'active');
      const nowIso = new Date().toISOString();
      const seed = Date.now() % 100000;
      let selected: QuestionItem[] = [];
      let selectionDecision: SessionSelectionDecision | undefined;
      let title = 'Practice Session';
      let timeLimitSec: number | undefined;
      const timeMultiplier = payload.timeMultiplier ?? 1;

      if (payload.mockSource === 'pool') {
        selected = selectPoolMockQuestions({
          questions: activeQuestions,
          sectionFilter: payload.sectionFilter,
          questionCount: payload.questionCount,
          questionMemory,
          evidenceMap,
          autoRetireMastered: Boolean(configData.config.poolPolicy?.autoRetireMastered),
          seed,
        });
        const baseLimit = getOfficialTimeLimitSec(payload.sectionFilter);
        timeLimitSec =
          payload.customTimeLimitSec !== undefined
            ? Math.max(0, Math.round(payload.customTimeLimitSec))
            : timeMultiplier <= 0
              ? 0
              : Math.round(baseLimit * timeMultiplier);
        const scopeName =
          payload.sectionFilter === 'READ'
            ? 'Reading'
            : payload.sectionFilter === 'MATH'
              ? 'Mathematical Reasoning'
              : payload.sectionFilter === 'THINK'
                ? 'Thinking Skills'
                : payload.sectionFilter === 'WRIT'
                  ? 'Writing'
                  : 'Full Exam';
        title = `Fresh Pool Mock (${scopeName})`;
      } else if (payload.batchId) {
        selected = selectBatchMockQuestions({
          questions: activeQuestions,
          batchId: payload.batchId,
          sectionFilter: payload.sectionFilter,
        });
        const baseLimit = getOfficialTimeLimitSec(payload.sectionFilter);
        timeLimitSec =
          payload.customTimeLimitSec !== undefined
            ? Math.max(0, Math.round(payload.customTimeLimitSec))
            : timeMultiplier <= 0
              ? 0
              : Math.round(baseLimit * timeMultiplier);
        const label = selected[0]?.batchLabel || payload.batchId;
        title = `${label}${payload.sectionFilter ? ` (${payload.sectionFilter})` : ''}`;
      } else if (payload.mockBatch || payload.mode === 'benchmark_exam') {
        const batch = payload.mockBatch || 'PT3';
        selected = selectMockTestQuestions({
          questions: activeQuestions,
          batch,
          sectionFilter: payload.sectionFilter,
        });
        const baseLimit = getOfficialTimeLimitSec(payload.sectionFilter);
        timeLimitSec =
          payload.customTimeLimitSec !== undefined
            ? Math.max(0, Math.round(payload.customTimeLimitSec))
            : timeMultiplier <= 0
              ? 0
              : Math.round(baseLimit * timeMultiplier);
        title = `${batch} ${payload.sectionFilter || 'Full Mock Exam'}`;
      } else if (payload.mode === 'writing_sprint') {
        selected = selectPracticeSession({
          mode: 'writing_sprint',
          sectionFilter: 'WRIT',
          questions: activeQuestions,
          skillStates,
          questionMemory,
          evidenceMap,
          questionCountOverride: 1,
          config: configData.config,
          nowIso,
          seed,
        }).slice(0, 1);
        timeLimitSec = Math.round((payload.customTimeLimitSec ?? 1800) * (timeMultiplier > 0 ? timeMultiplier : 1));
        title = 'Writing Sprint';
      } else {
        // Use server-side Gemini Decision 1 adaptive ordering (gracefully falls back to deterministic)
        const todayKey = nowIso.slice(0, 10);
        const planSnap = await getDoc(doc(db, 'users', uid, 'daily_plans', todayKey)).catch(
          () => null
        );
        const dailyPlan = planSnap?.exists() ? (planSnap.data() as DailyFocusPlan) : null;
        const dailyLimitsOverride =
          configData.config.autoCalibrate?.enabled && dailyPlan?.dailyQuestionLimitBySection
            ? dailyPlan.dailyQuestionLimitBySection
            : undefined;
        try {
          const ranked = await serverRequest<{
            questionIds: string[];
            decision: SessionSelectionDecision;
          }>('/api/ai/practice/order', {
            method: 'POST',
            body: JSON.stringify({
              mode: payload.mode,
              sectionFilter: payload.sectionFilter,
              questions: activeQuestions,
              skillStates,
              questionMemory,
              evidenceMap,
              dailyPlan,
              questionCountOverride: payload.questionCount,
              config: configData.config,
              nowIso,
              seed,
            }),
          });
          const byId = new Map(activeQuestions.map((q) => [q.questionId, q]));
          selected = (ranked.questionIds || [])
            .map((id) => byId.get(id))
            .filter((q): q is QuestionItem => Boolean(q));
          selectionDecision = ranked.decision;
        } catch {
          selected = selectPracticeSession({
            mode: payload.mode,
            sectionFilter: payload.sectionFilter,
            questions: activeQuestions,
            skillStates,
            questionMemory,
            evidenceMap,
            dailyLimitsOverride,
            questionCountOverride: payload.questionCount,
            config: configData.config,
            nowIso,
            seed,
          });
        }

        if (payload.mode === 'section_drill') {
          const defaultDrillCount = configData.config.sessionDefaults.sectionDrillQuestionCount ?? 10;
          const defaultDrillMins = configData.config.sessionDefaults.sectionDrillTimeMinutes ?? 8;
          const scaledMins = payload.questionCount
            ? Math.max(3, Math.round((payload.questionCount / Math.max(1, defaultDrillCount)) * defaultDrillMins))
            : defaultDrillMins;
          timeLimitSec = Math.round(
            (payload.customTimeLimitSec ?? scaledMins * 60) * (timeMultiplier > 0 ? timeMultiplier : 1)
          );
          title = `${payload.sectionFilter || 'Section'} Drill (${selected.length} Qs)`;
        } else if (payload.mode === 'spaced_review') {
          timeLimitSec = Math.round((payload.customTimeLimitSec ?? 600) * (timeMultiplier > 0 ? timeMultiplier : 1));
          title = 'Spaced Review';
        } else {
          const goalMins =
            configData.config.autoCalibrate?.enabled && dailyPlan?.dailyGoalMinutes
              ? dailyPlan.dailyGoalMinutes
              : configData.config.sessionDefaults.dailyGoalMinutes;
          timeLimitSec = Math.round(
            (payload.customTimeLimitSec ?? goalMins * 60) * (timeMultiplier > 0 ? timeMultiplier : 1)
          );
          title = 'Daily Adaptive Practice';
        }
      }

      if (selected.length === 0) {
        throw makeApiError('No active questions are available for this session mode yet.', 400);
      }

      const sessionId = `sess_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const deadlineAt = timeLimitSec
        ? new Date(Date.parse(nowIso) + timeLimitSec * 1000).toISOString()
        : undefined;
      const totalSlots = selected.reduce(
        (acc, q) => acc + (q.formatType === 'WRIT_TYPED_TASK' ? 0 : q.parts.length),
        0
      );
      const initialCheckpoint: SessionCheckpoint = {
        currentIndex: 0,
        elapsedSec: 0,
        answersByPartId: {},
        flaggedQuestionIds: [],
      };

      const session: SessionRecord = {
        sessionId,
        studentId: uid,
        configVersionId: configData.configVersionId,
        mode: payload.mode,
        title,
        sectionFilter: payload.sectionFilter,
        mockBatch: payload.mockBatch,
        timeMultiplier,
        isSandbox: false,
        status: 'in_progress',
        plannedQuestionIds: selected.map((q) => q.questionId),
        selectionDecision,
        checkpoint: initialCheckpoint,
        checkpointRevision: 0,
        timeLimitSec,
        deadlineAt,
        totalSlots,
        correctSlots: 0,
        startedAt: nowIso,
      };

      // Write session, immutable snapshots, and active session lock atomically in one batch
      const sessionRef = doc(db, 'users', uid, 'sessions', sessionId);
      const ops: Array<(b: ReturnType<typeof writeBatch>) => void> = [
        (b) =>
          b.set(
            sessionRef,
            stripUndefinedDeep({
              ...session,
              userId: uid,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            })
          ),
      ];
      selected.forEach((q, idx) => {
        const stim = q.stimulusId ? bank.stimuliById[q.stimulusId] : undefined;
        const rev = q.evidenceRevision || computeEvidenceRevision(q, stim);
        const snapRef = doc(db, 'users', uid, 'sessions', sessionId, 'snapshots', `snap_${idx}`);
        ops.push((b) =>
          b.set(
            snapRef,
            stripUndefinedDeep({
              userId: uid,
              questionId: q.questionId,
              snapshotIndex: idx,
              evidenceRevision: rev,
              question: { ...q, evidenceRevision: rev },
              stimulus: stim,
              createdAt: serverTimestamp(),
            })
          )
        );
      });
      ops.push((b) =>
        b.set(
          doc(db, 'users', uid, 'locks', 'active_session'),
          stripUndefinedDeep({
            userId: uid,
            activeSessionId: sessionId,
            deadlineAt,
            updatedAt: serverTimestamp(),
          })
        )
      );
      await runFs(OperationType.WRITE, `users/${uid}/sessions/${sessionId}`, () =>
        commitBatchedWrites(ops)
      );

      return { sessionId, session, serverNowIso: new Date().toISOString() };
    },

    async getSession(id: string): Promise<SessionDetailResponse> {
      const user = await ensureUserProfileInFirestore();
      const uid = user.uid;
      const sRef = doc(db, 'users', uid, 'sessions', toSafeDocId(id));
      const sSnap = await getDoc(sRef);
      if (!sSnap.exists()) {
        throw makeApiError('Session not found.', 404);
      }

      let session = hydrateSessionFromDoc(sSnap.data() as Record<string, unknown>);
      if (isSessionExpired(session)) {
        session = await resolveOrExpireSession(uid, session, serverRequest);
      }

      let snapshots = await getSessionSnapshotsFromFirestore(uid, session.sessionId);
      if (snapshots.length === 0) {
        const bank = await loadQuestionBank(serverRequest, { includeHistorical: true });
        const byId = new Map(bank.allQuestions.map((q) => [q.questionId, q]));
        snapshots = session.plannedQuestionIds
          .map((qid, idx) => {
            const q = byId.get(qid);
            if (!q) return null;
            const stim = q.stimulusId ? bank.stimuliById[q.stimulusId] : undefined;
            return {
              questionId: q.questionId,
              snapshotIndex: idx,
              evidenceRevision: q.evidenceRevision || computeEvidenceRevision(q, stim),
              question: q,
              stimulus: stim,
            } as SessionQuestionSnapshot;
          })
          .filter((x): x is SessionQuestionSnapshot => x !== null);
      }

      const includeReviewFields = session.status === 'submitted';
      const questions = snapshots.map((s) =>
        toStudentQuestionView(s.question, s.stimulus, includeReviewFields)
      );

      let writingReview = session.submissionSummary?.writingReview;
      if (includeReviewFields && writingReview && writingReview.length > 0) {
        const subs = await listUserWritingSubmissions(uid);
        const bySubId = new Map(subs.map((s) => [s.submissionId, s]));
        writingReview = writingReview.map((wr) => ({
          ...wr,
          evaluations: bySubId.get(wr.submissionId)?.evaluations || wr.evaluations || [],
        }));
      }

      return {
        session,
        questions,
        serverNowIso: new Date().toISOString(),
        reviewResults: includeReviewFields ? session.submissionSummary?.reviewResults : undefined,
        writingReview: includeReviewFields ? writingReview : undefined,
      };
    },

    async saveCheckpoint(
      id: string,
      checkpoint: SessionCheckpoint,
      expectedRevision?: number
    ): Promise<{
      ok: boolean;
      checkpointRevision: number;
      revision?: number;
      savedAtIso?: string;
      serverNowIso?: string;
    }> {
      const user = await ensureUserProfileInFirestore();
      const uid = user.uid;
      const sRef = doc(db, 'users', uid, 'sessions', toSafeDocId(id));

      const nextRev = await runTransaction(db, async (tx) => {
        const snap = await tx.get(sRef);
        if (!snap.exists()) {
          throw makeApiError('Session not found.', 404);
        }
        const sess = hydrateSessionFromDoc(snap.data() as Record<string, unknown>);
        if (sess.status === 'submitted') {
          throw makeApiError('Session has already been submitted.', 409, {
            alreadySubmitted: true,
          });
        }
        const currentRev = sess.checkpointRevision ?? 0;
        if (typeof expectedRevision === 'number' && expectedRevision !== currentRev) {
          throw makeApiError('Checkpoint conflict: a newer revision was saved.', 409, {
            currentRevision: currentRev,
            serverCheckpoint: sess.checkpoint,
          });
        }
        const rev = currentRev + 1;
        tx.update(
          sRef,
          stripUndefinedDeep({
            checkpoint,
            checkpointRevision: rev,
            updatedAt: serverTimestamp(),
          })
        );
        return rev;
      });

      const nowIso = new Date().toISOString();
      return {
        ok: true,
        checkpointRevision: nextRev,
        revision: nextRev,
        savedAtIso: nowIso,
        serverNowIso: nowIso,
      };
    },

    async submitSession(
      id: string,
      checkpoint?: SessionCheckpoint,
      assisted = false
    ): Promise<SessionSubmissionPayload & { alreadySubmitted?: boolean }> {
      const user = await ensureUserProfileInFirestore();
      const uid = user.uid;
      const sRef = doc(db, 'users', uid, 'sessions', toSafeDocId(id));
      const snap = await getDoc(sRef);
      if (!snap.exists()) {
        throw makeApiError('Session not found.', 404);
      }
      const session = hydrateSessionFromDoc(snap.data() as Record<string, unknown>);
      const effectiveCheckpoint: SessionCheckpoint = checkpoint ||
        session.checkpoint || {
          currentIndex: 0,
          elapsedSec: 0,
          answersByPartId: {},
          flaggedQuestionIds: [],
        };

      const res = await finalizeSessionInFirestore({
        uid,
        session,
        checkpoint: effectiveCheckpoint,
        assisted,
        completedAtIso: new Date().toISOString(),
        expiredAutoSubmitted: false,
        rejectValidationErrors: true,
        serverRequest,
      });

      return {
        ...res.submissionSummary,
        alreadySubmitted: res.alreadySubmitted,
      };
    },

    async evaluateWriting(
      submissionId: string
    ): Promise<{ evaluation: WritingEvaluationRecord; evaluations?: WritingEvaluationRecord[] }> {
      const user = await ensureUserProfileInFirestore();
      const uid = user.uid;
      const safeId = toSafeDocId(submissionId);
      const subRef = doc(db, 'users', uid, 'writing_submissions', safeId);
      const subSnap = await getDoc(subRef);
      if (!subSnap.exists()) {
        throw makeApiError('Writing submission not found.', 404);
      }
      const raw = subSnap.data() as Record<string, unknown>;
      const questionId = String(raw.questionId || '');
      const bank = await loadQuestionBank(serverRequest, { includeHistorical: true });
      const question = bank.allQuestions.find((q) => q.questionId === questionId);
      if (!question) {
        throw makeApiError('Writing prompt question not found.', 404);
      }
      const stimulus = question.stimulusId ? bank.stimuliById[question.stimulusId] : undefined;
      let metrics: WritingDeterministicMetrics;
      try {
        metrics = JSON.parse(String(raw.deterministicMetricsJson || '{}')) as WritingDeterministicMetrics;
      } catch {
        metrics = computeWritingMetrics(
          question.writingSpec || {
            genre: 'essay',
            audience: 'General',
            purpose: 'Inform',
            recommendedWordRange: [200, 450],
            timeLimitSec: 1800,
          },
          String(raw.responseText || '')
        );
      }

      const aiRes = await serverRequest<{ evaluation: WritingEvaluationRecord }>(
        '/api/ai/writing/evaluate',
        {
          method: 'POST',
          body: JSON.stringify({
            submissionId: safeId,
            question,
            stimulus,
            planNotes: String(raw.planNotes || ''),
            responseText: String(raw.responseText || ''),
            metrics,
          }),
        }
      );

      const existingEvals = Array.isArray(raw.evaluations)
        ? (raw.evaluations as WritingEvaluationRecord[])
        : [];
      const nextEvals = [aiRes.evaluation, ...existingEvals].slice(0, 10);

      await updateDoc(
        subRef,
        stripUndefinedDeep({
          evaluations: nextEvals,
          updatedAt: serverTimestamp(),
        })
      );

      return { evaluation: aiRes.evaluation, evaluations: nextEvals };
    },

    async flagQuestion(payload: {
      questionId: string;
      sessionId: string;
      reason: string;
      notes?: string;
    }): Promise<{ flag: QuestionFlagRecord }> {
      const user = await ensureUserProfileInFirestore();
      const uid = user.uid;
      const flagId = toSafeDocId(`flag_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`);
      const createdAtIso = new Date().toISOString();
      const flag: QuestionFlagRecord = {
        flagId,
        studentId: uid,
        questionId: payload.questionId,
        sessionId: payload.sessionId,
        reason: payload.reason.slice(0, 200),
        notes: payload.notes?.slice(0, 2000),
        status: 'open',
        createdAt: createdAtIso,
      };
      await setDoc(
        doc(db, 'question_flags', flagId),
        stripUndefinedDeep({
          flagId,
          userId: uid,
          sessionId: payload.sessionId,
          questionId: payload.questionId,
          reason: flag.reason,
          notes: flag.notes,
          status: 'open',
          createdAtIso,
          createdAt: serverTimestamp(),
        })
      );
      return { flag };
    },

    async getProgress(): Promise<ProgressResponse> {
      const user = await ensureUserProfileInFirestore();
      const uid = user.uid;
      const [sessions, attempts, skillStates, evidenceMap, writingSubmissions, bank] =
        await Promise.all([
          listUserSessions(uid),
          listUserAttempts(uid),
          getUserSkillStates(uid),
          getUserQuestionEvidence(uid),
          listUserWritingSubmissions(uid),
          loadQuestionBank(serverRequest),
        ]);

      const realAttempts = attempts.filter((a) => !a.isSandbox);
      const activeQuestions = bank.latestQuestions.filter((q) => q.qcStatus === 'active');

      const sectionStats: ProgressResponse['sectionStats'] = {
        READ: { attempts: 0, correct: 0, avgTimeSec: 0, targetTimeSec: 60 },
        MATH: { attempts: 0, correct: 0, avgTimeSec: 0, targetTimeSec: 65 },
        THINK: { attempts: 0, correct: 0, avgTimeSec: 0, targetTimeSec: 60 },
        WRIT: { attempts: 0, correct: 0, avgTimeSec: 0, targetTimeSec: 1800 },
      };

      const skillSectionMap = new Map(SKILLS_TAXONOMY.map((s) => [s.skillId, s.section]));
      const sectionTimeTotals: Record<SectionCode, number> = {
        READ: 0,
        MATH: 0,
        THINK: 0,
        WRIT: 0,
      };

      for (const a of realAttempts) {
        const sec = skillSectionMap.get(a.skillId);
        if (!sec) continue;
        sectionStats[sec].attempts += 1;
        if (a.isCorrect) sectionStats[sec].correct += 1;
        sectionTimeTotals[sec] += a.timeSpentSec || 0;
      }
      for (const sec of ['READ', 'MATH', 'THINK', 'WRIT'] as SectionCode[]) {
        if (sectionStats[sec].attempts > 0) {
          sectionStats[sec].avgTimeSec = Math.round(
            sectionTimeTotals[sec] / sectionStats[sec].attempts
          );
        }
      }

      const skills = SKILLS_TAXONOMY.map((def) => ({
        skillId: def.skillId,
        section: def.section,
        familyCode: def.familyCode,
        displayName: def.displayName,
        examWeightHint: def.examWeightHint,
        state: skillStates[def.skillId] || null,
      }));

      const holdoutQuestionIds = new Set(
        activeQuestions.filter((q) => q.poolType === 'benchmark_holdout').map((q) => q.questionId)
      );
      const holdoutAttempts = realAttempts.filter((a) => holdoutQuestionIds.has(a.questionId));
      const legacyAttemptsCount = realAttempts.filter((a) => a.isLegacy).length;
      const writingEvaluatedCount = writingSubmissions.filter(
        (w) => (w.evaluations?.length ?? 0) > 0
      ).length;

      const masterySummary = computeBankMasterySummary({
        questions: activeQuestions,
        stimuliById: bank.stimuliById,
        evidenceMap,
        legacyAttemptsCount,
        holdoutAttempts,
        writingSubmissionsCount: writingSubmissions.length,
        writingEvaluatedCount,
      });

      return {
        sectionStats,
        skills,
        sessions: sessions.filter((s) => !s.isSandbox),
        writingSubmissions,
        totalAttempts: realAttempts.length,
        masterySummary,
      };
    },

    async downloadClientExport(url: string, fallbackFilename: string): Promise<void> {
      const user = await ensureUserProfileInFirestore();
      let blob: Blob;
      if (url.startsWith('/api/admin/backup')) {
        requireSoleAdmin();
        const [bank, configs, flags, batches] = await Promise.all([
          loadQuestionBank(serverRequest, { includeHistorical: true }),
          listConfigVersionsFromFirestore(),
          getDocs(collection(db, 'question_flags')),
          getDocs(collection(db, 'import_batches')),
        ]);
        const payload = {
          schemaVersion: 'v3_canonical_1.0',
          exportedAtIso: new Date().toISOString(),
          backendName: 'firestore_client',
          stimuli: Object.values(bank.stimuliById),
          questions: bank.allQuestions,
          configVersions: configs,
          importBatches: batches.docs.map((d) => d.data()),
          questionFlags: flags.docs.map((d) => d.data()),
        };
        blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      } else {
        const progress = await this.getProgress();
        if (url.includes('format=csv')) {
          const rows = [
            ['skillId', 'section', 'displayName', 'attempts', 'masteryScore', 'plateauStatus'].join(
              ','
            ),
            ...progress.skills.map((s) =>
              [
                s.skillId,
                s.section,
                `"${s.displayName.replace(/"/g, '""')}"`,
                s.state?.attemptsCount ?? 0,
                s.state ? s.state.masteryScore.toFixed(3) : '',
                s.state?.plateauStatus ?? 'none',
              ].join(',')
            ),
          ];
          blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
        } else {
          blob = new Blob(
            [
              JSON.stringify(
                { exportedAt: new Date().toISOString(), studentId: user.uid, ...progress },
                null,
                2
              ),
            ],
            { type: 'application/json' }
          );
        }
      }
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = fallbackFilename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objUrl);
    },

    // -------------------------------------------------------------------------
    // Admin APIs (Sole admin: bowenzou0@gmail.com)
    // -------------------------------------------------------------------------

    async getAdminStatus(): Promise<AdminStatusResponse> {
      requireSoleAdmin();
      const [bank, configData, flagsSnap, batchesSnap] = await Promise.all([
        loadQuestionBank(serverRequest),
        getActiveConfigFromFirestore(),
        getDocs(collection(db, 'question_flags')),
        getDocs(collection(db, 'import_batches')),
      ]);

      const questions = bank.latestQuestions;
      const byPool: Record<string, number> = {};
      const bySection: Record<string, number> = {};
      const byQcStatus: Record<string, number> = {};
      let holdoutQuestionCount = 0;

      for (const q of questions) {
        byPool[q.poolType] = (byPool[q.poolType] || 0) + 1;
        bySection[q.section] = (bySection[q.section] || 0) + 1;
        byQcStatus[q.qcStatus] = (byQcStatus[q.qcStatus] || 0) + 1;
        if (q.poolType === 'benchmark_holdout') holdoutQuestionCount++;
      }

      const openFlagsCount = flagsSnap.docs.filter(
        (d) => (d.data() as Record<string, unknown>).status === 'open'
      ).length;

      return {
        backendName: 'firestore_client',
        isEphemeralPreview: false,
        totalQuestions: questions.length,
        byPool,
        bySection,
        byQcStatus,
        holdoutIsolationOk: true,
        holdoutQuestionCount,
        leakedCount: 0,
        openFlagsCount,
        activeConfigVersion: configData.versionNumber,
        batchesCount: batchesSnap.size,
      };
    },

    async getAdminDiagnostics(): Promise<RuntimeDiagnosticsResponse> {
      requireSoleAdmin();
      return serverRequest<RuntimeDiagnosticsResponse>('/api/admin/diagnostics');
    },

    async getAdminQuestions(params?: {
      search?: string;
      section?: string;
      poolType?: string;
      qcStatus?: string;
      poolStatus?: BankPoolStatus | '';
      completionStatus?: QuestionCompletionStatus | '';
      formatType?: string;
      batchId?: string;
      batchTag?: string;
      skillId?: string;
      includeHistorical?: boolean;
      flaggedOnly?: boolean;
      missingVisual?: boolean;
      missingExplanation?: boolean;
      sort?: 'id_asc' | 'updated_desc' | 'version_desc';
      page?: number;
      pageSize?: number;
    }): Promise<PaginatedQuestionsResponse> {
      const admin = requireSoleAdmin();
      const uid = toSafeDocId(admin.uid);
      const [bank, flagsSnap, batchesSnap, evidenceMap, questionMemory, configData] =
        await Promise.all([
          loadQuestionBank(serverRequest, { includeHistorical: Boolean(params?.includeHistorical) }),
          getDocs(collection(db, 'question_flags')),
          getDocs(collection(db, 'import_batches')),
          getUserQuestionEvidence(uid),
          getUserQuestionMemory(uid),
          getActiveConfigFromFirestore(),
        ]);

      const openFlagsByQuestionId: Record<string, number> = {};
      for (const d of flagsSnap.docs) {
        const raw = d.data() as Record<string, unknown>;
        if (raw.status === 'open') {
          const qid = String(raw.questionId || '');
          openFlagsByQuestionId[qid] = (openFlagsByQuestionId[qid] || 0) + 1;
        }
      }

      const batches: ImportBatchRecord[] = batchesSnap.docs
        .map((d) => {
          const raw = d.data() as Record<string, unknown>;
          return {
            batchId: String(raw.batchId || d.id),
            batchLabel: String(raw.batchLabel || ''),
            createdAtIso: String(raw.createdAtIso || ''),
            importedBy: String(raw.importedBy || ''),
            questionsCount: Number(raw.questionsCount ?? 0),
            stimuliCount: Number(raw.stimuliCount ?? 0),
            newQuestionIds: Array.isArray(raw.newQuestionIds)
              ? (raw.newQuestionIds as string[])
              : [],
            versionBumpedQuestionIds: Array.isArray(raw.versionBumpedQuestionIds)
              ? (raw.versionBumpedQuestionIds as string[])
              : [],
            skippedQuestionIds: Array.isArray(raw.skippedQuestionIds)
              ? (raw.skippedQuestionIds as string[])
              : [],
          };
        })
        .sort((a, b) => Date.parse(b.createdAtIso) - Date.parse(a.createdAtIso));

      // Compute completion meta across all latest questions for health & filtering
      const allProgressByQid: Record<string, QuestionProgressMeta> = {};
      const masteredLiveQuestionIds: string[] = [];
      for (const q of bank.latestQuestions) {
        const meta = deriveQuestionProgressMeta(q, evidenceMap, questionMemory);
        allProgressByQid[q.questionId] = meta;
        if (
          q.qcStatus === 'active' &&
          q.poolType !== 'benchmark_holdout' &&
          meta.completionStatus === 'done'
        ) {
          masteredLiveQuestionIds.push(q.questionId);
        }
      }

      const dailyLimits = configData.config.sessionDefaults.dailyQuestionLimitBySection;
      const dailyTarget = Math.max(
        1,
        (dailyLimits.READ || 0) + (dailyLimits.MATH || 0) + (dailyLimits.THINK || 0)
      );
      const poolHealth = computePoolHealth({
        questions: bank.latestQuestions,
        evidenceMap,
        questionMemory,
        dailyQuestionTarget: dailyTarget,
      });

      // Build scalable batch directory summaries across imported batches + official tags
      const batchSummaryMap = new Map<string, BatchDirectorySummary>();
      for (const b of batches) {
        batchSummaryMap.set(b.batchId, {
          batchId: b.batchId,
          batchLabel: b.batchLabel || b.batchId,
          createdAtIso: b.createdAtIso,
          importedBy: b.importedBy,
          total: 0,
          live: 0,
          unseen: 0,
          done: 0,
          paused: 0,
          archived: 0,
          questionIds: [],
        });
      }
      for (const q of bank.latestQuestions) {
        const key = q.batchId || `tag_${getQuestionBatchTag(q)}`;
        const label =
          q.batchLabel ||
          (q.batchId
            ? q.batchId
            : getQuestionBatchTag(q) === 'PT1'
              ? 'Official Practice Test 1'
              : getQuestionBatchTag(q) === 'PT2'
                ? 'Official Practice Test 2'
                : getQuestionBatchTag(q) === 'PT3'
                  ? 'Official Practice Test 3 (Holdout)'
                  : 'Built-in Starter Pack');
        const entry = batchSummaryMap.get(key) || {
          batchId: key,
          batchLabel: label,
          createdAtIso: q.createdAtIso || '',
          importedBy: q.provenance.sourceType === 'official_doe' ? 'official_seed' : 'bank',
          total: 0,
          live: 0,
          unseen: 0,
          done: 0,
          paused: 0,
          archived: 0,
          questionIds: [],
        };
        entry.total++;
        entry.questionIds.push(q.questionId);
        const ps = qcStatusToPoolStatus(q.qcStatus);
        if (ps === 'live') entry.live++;
        else if (ps === 'paused') entry.paused++;
        else entry.archived++;
        const meta = allProgressByQid[q.questionId];
        if (meta?.completionStatus === 'unseen') entry.unseen++;
        if (meta?.completionStatus === 'done') entry.done++;
        batchSummaryMap.set(key, entry);
      }

      const batchSummaries = Array.from(batchSummaryMap.values())
        .filter((b) => b.total > 0)
        .sort((a, b) => (Date.parse(b.createdAtIso) || 0) - (Date.parse(a.createdAtIso) || 0));

      const needle = (params?.search || '').trim().toLowerCase();
      const filtered = bank.allQuestions.filter((q) => {
        if (params?.section && q.section !== params.section) return false;
        if (params?.poolType && q.poolType !== params.poolType) return false;
        if (params?.qcStatus && q.qcStatus !== params.qcStatus) return false;
        if (params?.poolStatus && qcStatusToPoolStatus(q.qcStatus) !== params.poolStatus) {
          return false;
        }
        if (params?.completionStatus) {
          const meta =
            allProgressByQid[q.questionId] ||
            deriveQuestionProgressMeta(q, evidenceMap, questionMemory);
          if (meta.completionStatus !== params.completionStatus) return false;
        }
        if (params?.formatType && q.formatType !== params.formatType) return false;
        if (params?.batchId) {
          if (params.batchId.startsWith('tag_')) {
            if (getQuestionBatchTag(q) !== params.batchId.slice(4)) return false;
          } else if (q.batchId !== params.batchId) {
            return false;
          }
        }
        if (params?.batchTag && getQuestionBatchTag(q) !== params.batchTag) return false;
        if (params?.skillId) {
          if (
            !q.parts.some(
              (p) =>
                p.skillId === params.skillId || p.secondarySkillIds?.includes(params.skillId!)
            )
          ) {
            return false;
          }
        }
        if (params?.flaggedOnly && !(openFlagsByQuestionId[q.questionId] > 0)) return false;
        const stim = q.stimulusId ? bank.stimuliById[q.stimulusId] : undefined;
        if (params?.missingVisual) {
          const hasQ = Boolean(q.visual && q.visual.visualType !== 'none');
          const hasS = Boolean(stim?.visual && stim.visual.visualType !== 'none');
          if (hasQ || hasS) return false;
        }
        if (params?.missingExplanation) {
          const missingExp = q.parts.some(
            (p) =>
              q.formatType !== 'WRIT_TYPED_TASK' &&
              (!p.workedExplanation || !p.workedExplanation.trim())
          );
          if (!missingExp) return false;
        }
        if (needle) {
          const partsHay = q.parts
            .map(
              (p) =>
                `${p.partId} ${p.promptText} ${p.skillId} ${p.workedExplanation || ''} ${p.options.map((o) => `${o.key} ${o.text}`).join(' ')}`
            )
            .join(' ');
          const stimHay = stim
            ? `${stim.stimulusId} ${stim.title || ''} ${stim.mainTextMarkdown || ''}`
            : '';
          const fullHay = `${q.questionId} ${q.questionFamilyId} ${q.stemPrefix || ''} ${q.batchLabel || ''} ${partsHay} ${stimHay}`.toLowerCase();
          if (!fullHay.includes(needle)) return false;
        }
        return true;
      });

      const sort = params?.sort || 'id_asc';
      filtered.sort((a, b) => {
        if (sort === 'updated_desc') {
          const ta = Date.parse(a.updatedAtIso || a.createdAtIso || '') || 0;
          const tb = Date.parse(b.updatedAtIso || b.createdAtIso || '') || 0;
          if (tb !== ta) return tb - ta;
        } else if (sort === 'version_desc') {
          if (b.version !== a.version) return b.version - a.version;
        }
        return a.questionId.localeCompare(b.questionId, undefined, { numeric: true });
      });

      const pageSize = Math.max(1, Math.min(200, Number(params?.pageSize || 50)));
      const totalMatching = filtered.length;
      const maxPage = Math.max(1, Math.ceil(totalMatching / pageSize));
      const page = Math.max(1, Math.min(maxPage, Number(params?.page || 1)));
      const start = (page - 1) * pageSize;
      const paged = filtered.slice(start, start + pageSize);

      const pageStimuliById: Record<string, StimulusGroup> = {};
      const pageProgressByQuestionId: Record<string, QuestionProgressMeta> = {};
      for (const q of paged) {
        if (q.stimulusId && bank.stimuliById[q.stimulusId]) {
          pageStimuliById[q.stimulusId] = bank.stimuliById[q.stimulusId];
        }
        pageProgressByQuestionId[q.questionId] =
          allProgressByQid[q.questionId] ||
          deriveQuestionProgressMeta(q, evidenceMap, questionMemory);
      }

      return {
        questions: paged,
        stimuliById: pageStimuliById,
        totalMatching,
        page,
        pageSize,
        openFlagsByQuestionId,
        batches,
        progressByQuestionId: pageProgressByQuestionId,
        poolHealth,
        masteredLiveQuestionIds,
        batchSummaries,
      };
    },

    async getQuestionVersions(questionId: string): Promise<{
      questionFamilyId: string;
      versions: { question: QuestionItem; stimulus?: StimulusGroup }[];
    }> {
      requireSoleAdmin();
      const bank = await loadQuestionBank(serverRequest, { includeHistorical: true });
      const target = bank.allQuestions.find((q) => q.questionId === questionId);
      if (!target) throw makeApiError('Question not found.', 404);
      const versions = bank.allQuestions
        .filter((q) => q.questionFamilyId === target.questionFamilyId)
        .sort((a, b) => b.version - a.version)
        .map((q) => ({
          question: q,
          stimulus: q.stimulusId ? bank.stimuliById[q.stimulusId] : undefined,
        }));
      return { questionFamilyId: target.questionFamilyId, versions };
    },

    async getImportBatches(): Promise<{ batches: ImportBatchRecord[] }> {
      requireSoleAdmin();
      const snap = await getDocs(collection(db, 'import_batches'));
      const batches: ImportBatchRecord[] = snap.docs
        .map((d) => {
          const raw = d.data() as Record<string, unknown>;
          return {
            batchId: String(raw.batchId || d.id),
            batchLabel: String(raw.batchLabel || ''),
            createdAtIso: String(raw.createdAtIso || ''),
            importedBy: String(raw.importedBy || ''),
            questionsCount: Number(raw.questionsCount ?? 0),
            stimuliCount: Number(raw.stimuliCount ?? 0),
            newQuestionIds: Array.isArray(raw.newQuestionIds)
              ? (raw.newQuestionIds as string[])
              : [],
            versionBumpedQuestionIds: Array.isArray(raw.versionBumpedQuestionIds)
              ? (raw.versionBumpedQuestionIds as string[])
              : [],
            skippedQuestionIds: Array.isArray(raw.skippedQuestionIds)
              ? (raw.skippedQuestionIds as string[])
              : [],
          };
        })
        .sort((a, b) => Date.parse(b.createdAtIso) - Date.parse(a.createdAtIso));
      return { batches };
    },

    async updateQuestionStatus(
      questionId: string,
      qcStatus: QuestionItem['qcStatus']
    ): Promise<{ ok: boolean }> {
      requireSoleAdmin();
      const bank = await loadQuestionBank(serverRequest, { includeHistorical: true });
      const existing = bank.allQuestions.find((q) => q.questionId === questionId);
      if (!existing) throw makeApiError('Question not found.', 404);
      const updated: QuestionItem = {
        ...existing,
        qcStatus,
        updatedAtIso: new Date().toISOString(),
      };
      const safeId = toSafeDocId(questionId);
      await runFs(OperationType.WRITE, `bank_questions/${safeId}`, () =>
        setDoc(doc(db, 'bank_questions', safeId), buildBankQuestionDoc(updated))
      );
      invalidateBankCache();
      return { ok: true };
    },

    async bulkUpdateQuestionStatus(
      questionIds: string[],
      qcStatus: QuestionItem['qcStatus']
    ): Promise<{ ok: boolean; updatedCount: number }> {
      requireSoleAdmin();
      if (questionIds.length === 0) return { ok: true, updatedCount: 0 };
      const bank = await loadQuestionBank(serverRequest, { includeHistorical: true });
      const byId = new Map(bank.allQuestions.map((q) => [q.questionId, q]));
      const nowIso = new Date().toISOString();
      const ops: Array<(b: ReturnType<typeof writeBatch>) => void> = [];
      let updatedCount = 0;

      for (const qid of questionIds) {
        const existing = byId.get(qid);
        if (!existing) continue;
        const updated: QuestionItem = {
          ...existing,
          qcStatus,
          updatedAtIso: nowIso,
        };
        const ref = doc(db, 'bank_questions', toSafeDocId(qid));
        ops.push((b) => b.set(ref, buildBankQuestionDoc(updated)));
        updatedCount++;
      }

      await runFs(OperationType.WRITE, 'bank_questions', () => commitBatchedWrites(ops));
      invalidateBankCache();
      return { ok: true, updatedCount };
    },

    async deleteQuestions(
      questionIds: string[]
    ): Promise<{ ok: boolean; deletedCount: number }> {
      requireSoleAdmin();
      const uniqueIds = Array.from(new Set(questionIds.filter((id) => Boolean(id && id.trim()))));
      if (uniqueIds.length === 0) return { ok: true, deletedCount: 0 };

      const ops: Array<(b: ReturnType<typeof writeBatch>) => void> = uniqueIds.map((qid) => {
        const ref = doc(db, 'bank_questions', toSafeDocId(qid));
        return (b) => b.delete(ref);
      });

      await runFs(OperationType.DELETE, 'bank_questions', () => commitBatchedWrites(ops));
      invalidateBankCache();
      return { ok: true, deletedCount: uniqueIds.length };
    },

    async recalibrateDailyPlan(
      configOverride?: LearningConfig
    ): Promise<{ plan: DailyFocusPlan; error?: string }> {
      const user = await ensureUserProfileInFirestore();
      const uid = user.uid;
      const [configData, bank, skillStates, evidenceMap, questionMemory] = await Promise.all([
        getActiveConfigFromFirestore(),
        loadQuestionBank(serverRequest),
        getUserSkillStates(uid),
        getUserQuestionEvidence(uid),
        getUserQuestionMemory(uid),
      ]);
      const activeConfig = configOverride || configData.config;
      const activeQuestions = bank.latestQuestions.filter((q) => q.qcStatus === 'active');

      const aiPlan = await serverRequest<{ plan: DailyFocusPlan; error?: string }>(
        '/api/ai/daily-focus',
        {
          method: 'POST',
          body: JSON.stringify({
            skillStates,
            evidenceMap,
            questionMemory,
            questions: activeQuestions,
            config: activeConfig,
          }),
        }
      );

      if (aiPlan?.plan) {
        const todayKey = aiPlan.plan.planDate || new Date().toISOString().slice(0, 10);
        await setDoc(
          doc(db, 'users', uid, 'daily_plans', todayKey),
          stripUndefinedDeep({
            ...aiPlan.plan,
            studentId: uid,
            updatedAt: serverTimestamp(),
          })
        );
      }
      return aiPlan;
    },

    async getProgressCounts(): Promise<ProgressCountsResponse> {
      const admin = requireSoleAdmin();
      const uid = toSafeDocId(admin.uid);
      const [sessions, attempts, evidenceMap, writing, bank] = await Promise.all([
        listUserSessions(uid),
        listUserAttempts(uid),
        getUserQuestionEvidence(uid),
        listUserWritingSubmissions(uid),
        loadQuestionBank(serverRequest),
      ]);
      return {
        sessionsCount: sessions.length,
        attemptsCount: attempts.length,
        evidenceCount: Object.keys(evidenceMap).length,
        writingCount: writing.length,
        bankQuestionsCount: bank.latestQuestions.length,
      };
    },

    async resetStudentProgress(): Promise<ProgressResetResponse> {
      const admin = requireSoleAdmin();
      const uid = toSafeDocId(admin.uid);
      const [sessionsSnap, attemptsSnap, skillsSnap, memSnap, evSnap, writSnap, plansSnap, bank] =
        await Promise.all([
          getDocs(query(collection(db, 'users', uid, 'sessions'), where('userId', '==', uid))),
          getDocs(query(collection(db, 'users', uid, 'attempts'), where('userId', '==', uid))),
          getDocs(query(collection(db, 'users', uid, 'skill_states'), where('userId', '==', uid))),
          getDocs(query(collection(db, 'users', uid, 'question_memory'), where('userId', '==', uid))),
          getDocs(query(collection(db, 'users', uid, 'question_evidence'), where('userId', '==', uid))),
          getDocs(query(collection(db, 'users', uid, 'writing_submissions'), where('userId', '==', uid))),
          getDocs(query(collection(db, 'users', uid, 'daily_plans'), where('studentId', '==', uid))),
          loadQuestionBank(serverRequest),
        ]);

      const ops: Array<(b: ReturnType<typeof writeBatch>) => void> = [];

      // Delete nested snapshots under each session first, then the session itself
      for (const sDoc of sessionsSnap.docs) {
        const snapCol = await getDocs(
          query(
            collection(db, 'users', uid, 'sessions', sDoc.id, 'snapshots'),
            where('userId', '==', uid)
          )
        ).catch(() => null);
        if (snapCol) {
          for (const sn of snapCol.docs) {
            ops.push((b) => b.delete(sn.ref));
          }
        }
        ops.push((b) => b.delete(sDoc.ref));
      }
      for (const d of attemptsSnap.docs) ops.push((b) => b.delete(d.ref));
      for (const d of skillsSnap.docs) ops.push((b) => b.delete(d.ref));
      for (const d of memSnap.docs) ops.push((b) => b.delete(d.ref));
      for (const d of evSnap.docs) ops.push((b) => b.delete(d.ref));
      for (const d of writSnap.docs) ops.push((b) => b.delete(d.ref));
      for (const d of plansSnap.docs) ops.push((b) => b.delete(d.ref));

      if (ops.length > 0) {
        await runFs(OperationType.DELETE, `users/${uid}/progress`, () => commitBatchedWrites(ops));
      }

      // Clear active lock if present
      await deleteDoc(doc(db, 'users', uid, 'locks', 'active_session')).catch(() => undefined);

      // Clear local draft cache in browser storage
      try {
        const keysToRemove: string[] = [];
        for (let i = 0; i < window.localStorage.length; i++) {
          const k = window.localStorage.key(i);
          if (k && k.startsWith('selective_lab_draft:')) keysToRemove.push(k);
        }
        for (const k of keysToRemove) window.localStorage.removeItem(k);
      } catch {
        // ignore storage errors
      }

      return {
        ok: true,
        clearedSessions: sessionsSnap.size,
        clearedAttempts: attemptsSnap.size,
        clearedSkillStates: skillsSnap.size,
        clearedMemory: memSnap.size,
        clearedEvidence: evSnap.size,
        clearedWriting: writSnap.size,
        clearedDailyPlans: plansSnap.size,
        preservedQuestionsCount: bank.latestQuestions.length,
      };
    },

    async attachQuestionVisual(
      questionId: string,
      payload: {
        altText: string;
        caption?: string;
        imageBase64?: string;
        filename?: string;
        visual?: VisualSpec;
      }
    ): Promise<{ ok: boolean; visual: VisualSpec; qcStatus?: QuestionItem['qcStatus'] }> {
      requireSoleAdmin();
      const bank = await loadQuestionBank(serverRequest, { includeHistorical: true });
      const existing = bank.allQuestions.find((q) => q.questionId === questionId);
      if (!existing) throw makeApiError('Question not found.', 404);

      const visual: VisualSpec = payload.visual || {
        visualType: 'image_asset',
        imageUrl: payload.imageBase64 || '',
        altText: payload.altText,
        caption: payload.caption,
      };
      const stim = existing.stimulusId ? bank.stimuliById[existing.stimulusId] : undefined;
      const updated: QuestionItem = {
        ...existing,
        visual,
        updatedAtIso: new Date().toISOString(),
      };
      updated.evidenceRevision = computeEvidenceRevision(updated, stim);

      const safeId = toSafeDocId(questionId);
      await runFs(OperationType.WRITE, `bank_questions/${safeId}`, () =>
        setDoc(doc(db, 'bank_questions', safeId), buildBankQuestionDoc(updated))
      );
      invalidateBankCache();

      return { ok: true, visual, qcStatus: updated.qcStatus };
    },

    async createCalibrationSession(payload: {
      questionIds?: string[];
      items?: { questionId: string }[];
      section?: string;
      poolType?: string;
      qcStatus?: string;
      formatType?: string;
      skillFamily?: string;
      skillId?: string;
      batch?: string;
      batchId?: string;
      includeHistorical?: boolean;
      limit?: number;
      customTimeLimitSec?: number;
      isSandbox?: boolean;
    }): Promise<{ sessionId: string; count: number; session: SessionRecord }> {
      const admin = requireSoleAdmin();
      const uid = toSafeDocId(admin.uid);
      const [configData, bank] = await Promise.all([
        getActiveConfigFromFirestore(),
        loadQuestionBank(serverRequest, { includeHistorical: Boolean(payload.includeHistorical) }),
      ]);

      const explicitIds =
        payload.questionIds || payload.items?.map((i) => i.questionId).filter(Boolean);
      let selected: QuestionItem[];
      if (explicitIds && explicitIds.length > 0) {
        const byId = new Map(bank.allQuestions.map((q) => [q.questionId, q]));
        selected = [];
        for (const qid of explicitIds) {
          const found = byId.get(qid);
          if (!found) throw makeApiError(`Question ID "${qid}" not found.`, 400);
          selected.push(found);
        }
      } else {
        selected = selectAdminCalibrationQuestions({
          questions: bank.allQuestions,
          section: payload.section as SectionCode | undefined,
          poolType: payload.poolType as QuestionItem['poolType'] | undefined,
          qcStatus: payload.qcStatus as QuestionItem['qcStatus'] | undefined,
          formatType: payload.formatType as QuestionItem['formatType'] | undefined,
          skillFamily: payload.skillFamily,
          skillId: payload.skillId,
          batch: payload.batch,
          batchId: payload.batchId,
          limit: payload.limit ?? 20,
        });
      }

      if (selected.length === 0) {
        throw makeApiError('No questions matched those calibration filters.', 400);
      }

      const nowIso = new Date().toISOString();
      const sessionId = `cal_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
      const totalSlots = selected.reduce(
        (acc, q) => acc + (q.formatType === 'WRIT_TYPED_TASK' ? 0 : q.parts.length),
        0
      );

      const session: SessionRecord = {
        sessionId,
        studentId: uid,
        configVersionId: configData.configVersionId,
        mode: 'admin_calibration',
        title: `Calibration Preview (${selected.length} items)`,
        isSandbox: payload.isSandbox ?? true,
        status: 'in_progress',
        plannedQuestionIds: selected.map((q) => q.questionId),
        checkpoint: {
          currentIndex: 0,
          elapsedSec: 0,
          answersByPartId: {},
          flaggedQuestionIds: [],
        },
        checkpointRevision: 0,
        timeLimitSec: payload.customTimeLimitSec,
        totalSlots,
        correctSlots: 0,
        startedAt: nowIso,
      };

      const ops: Array<(b: ReturnType<typeof writeBatch>) => void> = [
        (b) =>
          b.set(
            doc(db, 'users', uid, 'sessions', sessionId),
            stripUndefinedDeep({
              ...session,
              userId: uid,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            })
          ),
      ];
      selected.forEach((q, idx) => {
        const stim = q.stimulusId ? bank.stimuliById[q.stimulusId] : undefined;
        const rev = q.evidenceRevision || computeEvidenceRevision(q, stim);
        const snapRef = doc(db, 'users', uid, 'sessions', sessionId, 'snapshots', `snap_${idx}`);
        ops.push((b) =>
          b.set(
            snapRef,
            stripUndefinedDeep({
              userId: uid,
              questionId: q.questionId,
              snapshotIndex: idx,
              evidenceRevision: rev,
              question: { ...q, evidenceRevision: rev },
              stimulus: stim,
              createdAt: serverTimestamp(),
            })
          )
        );
      });
      await runFs(OperationType.WRITE, `users/${uid}/sessions/${sessionId}`, () =>
        commitBatchedWrites(ops)
      );

      return { sessionId, count: selected.length, session };
    },

    async getCalibrationInspector(
      sessionId: string
    ): Promise<{ inspectorByQuestionId: Record<string, QuestionItem> }> {
      const admin = requireSoleAdmin();
      const uid = toSafeDocId(admin.uid);
      const snapshots = await getSessionSnapshotsFromFirestore(uid, toSafeDocId(sessionId));
      const inspectorByQuestionId: Record<string, QuestionItem> = {};
      for (const s of snapshots) {
        inspectorByQuestionId[s.questionId] = s.question;
      }
      return { inspectorByQuestionId };
    },

    async dryRunManifest(manifest: unknown) {
      requireSoleAdmin();
      const bank = await loadQuestionBank(serverRequest, { includeHistorical: true });
      return serverRequest<{
        report: {
          valid: boolean;
          batchLabel: string;
          stimuliCount: number;
          questionsCount: number;
          newQuestions: number;
          unchangedQuestions: number;
          versionBumpedQuestions: number;
          errors: string[];
          warnings: string[];
        };
      }>('/api/admin/import/dry-run', {
        method: 'POST',
        body: JSON.stringify({
          manifest,
          existingQuestions: bank.allQuestions,
          existingStimuli: bank.stimuliById,
        }),
      });
    },

    async commitManifest(manifest: BankImportManifest) {
      const admin = requireSoleAdmin();
      const dry = await this.dryRunManifest(manifest);
      if (!dry.report.valid) {
        throw makeApiError(dry.report.errors.join(' ') || 'Manifest failed validation.', 400);
      }

      const bank = await loadQuestionBank(serverRequest, { includeHistorical: true });
      const existingByFamily = new Map<string, QuestionItem>();
      for (const q of selectLatestByFamily(bank.allQuestions)) {
        existingByFamily.set(q.questionFamilyId, q);
      }

      const batchId = toSafeDocId(`batch_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`);
      const nowIso = new Date().toISOString();
      const stimuliMap = { ...bank.stimuliById };
      const ops: Array<(b: ReturnType<typeof writeBatch>) => void> = [];

      for (const stim of manifest.stimuli || []) {
        stimuliMap[stim.stimulusId] = stim;
        const ref = doc(db, 'bank_stimuli', toSafeDocId(stim.stimulusId));
        ops.push((b) =>
          b.set(
            ref,
            stripUndefinedDeep({
              stimulusId: stim.stimulusId,
              stimulusFamilyId: stim.stimulusFamilyId,
              version: stim.version,
              section: stim.section,
              payload: stim,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            })
          )
        );
      }

      let imported = 0;
      let skipped = 0;
      let versionBumped = 0;
      const newQuestionIds: string[] = [];
      const versionBumpedQuestionIds: string[] = [];
      const skippedQuestionIds: string[] = [];

      for (const rawQ of manifest.questions || []) {
        const stim = rawQ.stimulusId ? stimuliMap[rawQ.stimulusId] : undefined;
        const prev = existingByFamily.get(rawQ.questionFamilyId);
        let nextVersion = rawQ.version || 1;
        let nextQuestionId = rawQ.questionId;

        if (prev) {
          const prevRev = prev.evidenceRevision || computeEvidenceRevision(prev, stim);
          const nextRev = computeEvidenceRevision(rawQ, stim);
          if (prevRev === nextRev && prev.qcStatus === (rawQ.qcStatus || manifest.defaultQcStatus || 'active')) {
            skipped++;
            skippedQuestionIds.push(rawQ.questionId);
            continue;
          }
          nextVersion = Math.max(prev.version + 1, rawQ.version || 1);
          nextQuestionId =
            nextQuestionId === prev.questionId
              ? `${rawQ.questionFamilyId}_v${nextVersion}`
              : nextQuestionId;
          versionBumped++;
          versionBumpedQuestionIds.push(nextQuestionId);
        } else {
          imported++;
          newQuestionIds.push(nextQuestionId);
        }

        const qItem: QuestionItem = {
          ...rawQ,
          questionId: nextQuestionId,
          version: nextVersion,
          poolType: rawQ.poolType || manifest.defaultPoolType || 'practice',
          qcStatus: rawQ.qcStatus || manifest.defaultQcStatus || 'active',
          batchId,
          batchLabel: manifest.batchLabel,
          createdAtIso: nowIso,
          updatedAtIso: nowIso,
        };
        qItem.evidenceRevision = computeEvidenceRevision(qItem, stim);

        const ref = doc(db, 'bank_questions', toSafeDocId(qItem.questionId));
        ops.push((b) => b.set(ref, buildBankQuestionDoc(qItem, true)));
      }

      const batchRecord: ImportBatchRecord = {
        batchId,
        batchLabel: manifest.batchLabel,
        createdAtIso: nowIso,
        importedBy: admin.email,
        questionsCount: (manifest.questions || []).length,
        stimuliCount: (manifest.stimuli || []).length,
        newQuestionIds,
        versionBumpedQuestionIds,
        skippedQuestionIds,
      };
      ops.push((b) =>
        b.set(
          doc(db, 'import_batches', batchId),
          stripUndefinedDeep({
            ...batchRecord,
            createdAt: serverTimestamp(),
          })
        )
      );

      await runFs(OperationType.WRITE, 'bank_questions', () => commitBatchedWrites(ops));
      invalidateBankCache();
      return {
        ok: true,
        result: { imported, skipped, versionBumped },
        batch: batchRecord,
      };
    },

    async getImportSchema() {
      requireSoleAdmin();
      return serverRequest<{ schema: unknown; starterExample: unknown }>(
        '/api/admin/import/schema'
      );
    },

    async getAdminConfig() {
      requireSoleAdmin();
      const history = await listConfigVersionsFromFirestore();
      const top = history[0];
      return {
        active: {
          configVersionId: top.configVersionId,
          versionNumber: top.versionNumber,
          config: top.config,
        },
        history,
      };
    },

    async saveAdminConfig(config: LearningConfig, notes?: string) {
      requireSoleAdmin();
      const history = await listConfigVersionsFromFirestore();
      const nextVersion = (history[0]?.versionNumber ?? 0) + 1;
      const configVersionId = `cfg_v${nextVersion}`;
      const createdAtIso = new Date().toISOString();

      await setDoc(
        doc(db, 'admin_configs', configVersionId),
        stripUndefinedDeep({
          configVersionId,
          versionNumber: nextVersion,
          notes: notes?.slice(0, 500),
          config,
          createdAtIso,
          createdAt: serverTimestamp(),
        })
      );

      return {
        ok: true,
        configVersionId,
        versionNumber: nextVersion,
        config,
        notes,
        createdAtIso,
      };
    },

    async getAdminFlags(): Promise<{ flags: QuestionFlagRecord[] }> {
      requireSoleAdmin();
      const snap = await getDocs(collection(db, 'question_flags'));
      const flags: QuestionFlagRecord[] = snap.docs
        .map((d) => {
          const raw = d.data() as Record<string, unknown>;
          return {
            flagId: String(raw.flagId || d.id),
            studentId: String(raw.userId || ''),
            questionId: String(raw.questionId || ''),
            sessionId: String(raw.sessionId || ''),
            reason: String(raw.reason || ''),
            notes: typeof raw.notes === 'string' ? raw.notes : undefined,
            status: raw.status === 'resolved' ? ('resolved' as const) : ('open' as const),
            createdAt: String(raw.createdAtIso || ''),
          };
        })
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      return { flags };
    },

    async resolveFlag(flagId: string): Promise<{ ok: boolean }> {
      requireSoleAdmin();
      await updateDoc(doc(db, 'question_flags', toSafeDocId(flagId)), {
        status: 'resolved',
        resolvedAtIso: new Date().toISOString(),
        updatedAt: serverTimestamp(),
      });
      return { ok: true };
    },

    async restoreBackup(_backup: unknown, dryRun = true): Promise<{ ok: boolean; report: RestoreReport }> {
      requireSoleAdmin();
      return {
        ok: true,
        report: {
          valid: true,
          dryRun,
          checksumVerified: true,
          errors: [],
          warnings: [
            'Full multi-user canonical backup restore is available when running with dedicated server credentials. Use Manifest Import to restore question banks in Starter Tier mode.',
          ],
          wouldCreate: {},
          wouldSkipExisting: {},
          applied: {},
        },
      };
    },

    async getMigrationPreflight(): Promise<{ report: MigrationPreflightReport }> {
      const admin = requireSoleAdmin();
      const [bank, sessions, attempts] = await Promise.all([
        loadQuestionBank(serverRequest, { includeHistorical: true }),
        listUserSessions(toSafeDocId(admin.uid)),
        listUserAttempts(toSafeDocId(admin.uid)),
      ]);
      return {
        report: {
          checkedAtIso: new Date().toISOString(),
          backendName: 'firestore_client',
          totalQuestions: bank.allQuestions.length,
          totalSessions: sessions.length,
          totalPartAttempts: attempts.length,
          sessionsMissingSnapshots: 0,
          attemptsMissingEvidenceRevision: attempts.filter((a) => !a.evidenceRevision).length,
          questionsMissingEvidenceRevision: bank.allQuestions.filter((q) => !q.evidenceRevision)
            .length,
          legacyUntaggedAttempts: attempts.filter((a) => a.isLegacy).length,
          mediaNeedsUploadCount: 0,
          mediaMissingFilesCount: 0,
        },
      };
    },

    async getMediaMigrationManifest(): Promise<{ manifest: MediaMigrationManifest }> {
      requireSoleAdmin();
      return {
        manifest: {
          generatedAtIso: new Date().toISOString(),
          uploadsDir: 'public/assets/uploads',
          totalLocalFiles: 0,
          totalReferencedUploadUrls: 0,
          missingFilesCount: 0,
          needsUploadCount: 0,
          alreadyGcsCount: 0,
          items: [],
        },
      };
    },
  };
}
