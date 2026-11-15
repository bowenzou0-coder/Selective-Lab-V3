import {
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type Timestamp,
} from 'firebase/firestore';
import type { User } from 'firebase/auth';
import { auth, db, testFirestoreConnection } from '../lib/firebase';
import type {
  BankImportManifest,
  LearningConfig,
  PartAttemptRecord,
  QuestionFlagRecord,
  QuestionItem,
  QuestionMemoryState,
  SessionRecord,
  SkillState,
  StimulusGroup,
  VisualSpec,
  WritingDeterministicMetrics,
  WritingEvaluationRecord,
} from '../shared/contracts';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

function toSafeDocId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '__').slice(0, 128);
}

function stripUndefined<T>(val: T): T {
  if (Array.isArray(val)) {
    return val.map((item) => stripUndefined(item)) as unknown as T;
  }
  if (val && typeof val === 'object' && !(val as { toDate?: unknown }).toDate) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (v !== undefined) {
        out[k] = stripUndefined(v);
      }
    }
    return out as T;
  }
  return val;
}

export interface SyncHydratePayload {
  stimuli?: StimulusGroup[];
  questions?: QuestionItem[];
  questionOverrides?: { questionId: string; qcStatus: QuestionItem['qcStatus']; visual?: VisualSpec }[];
  configVersions?: {
    configVersionId: string;
    versionNumber: number;
    notes?: string;
    createdAt: string;
    config: LearningConfig;
  }[];
  sessions?: SessionRecord[];
  attempts?: PartAttemptRecord[];
  skillStates?: SkillState[];
  questionMemory?: QuestionMemoryState[];
  writingSubmissions?: {
    submissionId: string;
    studentId?: string;
    sessionId: string;
    questionId: string;
    planNotes: string;
    responseText: string;
    wordCount: number;
    timeSpentSec: number;
    deterministicMetricsJson: string;
    submittedAt: string;
    evaluations: WritingEvaluationRecord[];
  }[];
  flags?: QuestionFlagRecord[];
}

export async function ensureUserDocuments(user: User, isAdmin: boolean): Promise<void> {
  await testFirestoreConnection();
  const uid = user.uid;
  const displayName = (user.displayName || user.email?.split('@')[0] || 'Learner').slice(0, 120);
  const userRef = doc(db, 'users', uid);
  const userPath = `users/${uid}`;
  try {
    const snap = await getDoc(userRef);
    if (!snap.exists()) {
      await setDoc(userRef, {
        uid,
        displayName,
        role: isAdmin ? 'admin' : 'student',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(userRef, {
        displayName,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, userPath);
  }

  if (user.email) {
    const privateRef = doc(db, 'users', uid, 'private', 'info');
    const privatePath = `users/${uid}/private/info`;
    const email = user.email.slice(0, 200);
    try {
      const privSnap = await getDoc(privateRef);
      if (!privSnap.exists()) {
        await setDoc(privateRef, {
          uid,
          email,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } else {
        await updateDoc(privateRef, {
          email,
          updatedAt: serverTimestamp(),
        });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, privatePath);
    }
  }
}

export async function pullFirestoreSyncState(uid: string, isAdmin: boolean): Promise<SyncHydratePayload> {
  await testFirestoreConnection();
  const out: SyncHydratePayload = {};

  // 1. User-owned collections (explicitly constrained by userId == uid per rules)
  const sessionsPath = `users/${uid}/sessions`;
  try {
    const q = query(collection(db, 'users', uid, 'sessions'), where('userId', '==', uid));
    const snap = await getDocs(q);
    out.sessions = snap.docs.map((d) => {
      const data = d.data() as Record<string, unknown>;
      const rec: SessionRecord = {
        sessionId: String(data.sessionId),
        studentId: String(data.studentId || uid),
        configVersionId: String(data.configVersionId || 'cfg_v1'),
        mode: data.mode as SessionRecord['mode'],
        title: data.title ? String(data.title) : undefined,
        sectionFilter: data.sectionFilter ? (String(data.sectionFilter) as SessionRecord['sectionFilter']) : undefined,
        mockBatch: data.mockBatch ? (String(data.mockBatch) as SessionRecord['mockBatch']) : undefined,
        timeMultiplier: typeof data.timeMultiplier === 'number' ? data.timeMultiplier : undefined,
        isSandbox: Boolean(data.isSandbox),
        status: data.status as SessionRecord['status'],
        plannedQuestionIds: Array.isArray(data.plannedQuestionIds) ? (data.plannedQuestionIds as string[]) : [],
        checkpoint: data.checkpoint as SessionRecord['checkpoint'],
        timeLimitSec: typeof data.timeLimitSec === 'number' ? data.timeLimitSec : undefined,
        totalSlots: Number(data.totalSlots || 0),
        correctSlots: Number(data.correctSlots || 0),
        startedAt: String(data.startedAt),
        completedAt: data.completedAt ? String(data.completedAt) : undefined,
      };
      return rec;
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, sessionsPath);
  }

  const attemptsPath = `users/${uid}/attempts`;
  try {
    const q = query(collection(db, 'users', uid, 'attempts'), where('userId', '==', uid));
    const snap = await getDocs(q);
    out.attempts = snap.docs.map((d) => {
      const data = d.data() as Record<string, unknown>;
      return {
        attemptId: String(data.attemptId),
        studentId: uid,
        sessionId: String(data.sessionId),
        questionId: String(data.questionId),
        questionFamilyId: String(data.questionFamilyId),
        partId: String(data.partId),
        skillId: String(data.skillId),
        difficultyAtAttempt: Number(data.difficultyAtAttempt || 3),
        selectedAnswer: data.selectedAnswer ? String(data.selectedAnswer) : null,
        isCorrect: Boolean(data.isCorrect),
        timeSpentSec: Number(data.timeSpentSec || 0),
        isSpacedReview: Boolean(data.isSpacedReview),
        createdAt: String(data.createdAtIso || new Date().toISOString()),
      };
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, attemptsPath);
  }

  const skillPath = `users/${uid}/skill_states`;
  try {
    const q = query(collection(db, 'users', uid, 'skill_states'), where('userId', '==', uid));
    const snap = await getDocs(q);
    out.skillStates = snap.docs.map((d) => {
      const data = d.data() as Record<string, unknown>;
      const attemptsCount = Number(data.attemptsCount ?? 0);
      const ewmaAccuracy = Number(data.ewmaAccuracy ?? 0.5);
      return {
        skillId: String(data.skillId),
        masteryScore: Number(data.masteryScore ?? 0.5),
        uncertainty: Number(data.confidence ?? 0.2),
        attemptsCount,
        correctCount:
          typeof data.correctCount === 'number'
            ? Number(data.correctCount)
            : Math.round(ewmaAccuracy * attemptsCount),
        ewmaAccuracy,
        avgTimeRatio: Number(data.ewmaSpeedRatio ?? 1),
        lastPracticedAt: data.lastPracticedAt ? String(data.lastPracticedAt) : undefined,
        nextReviewAt: data.nextReviewDueAt ? String(data.nextReviewDueAt) : undefined,
        reviewIntervalDays: Number(data.reviewIntervalDays ?? 1),
        easeFactor: Number(data.easeFactor ?? 2.5),
        plateauStatus: (data.plateauStatus as SkillState['plateauStatus']) || 'none',
      };
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, skillPath);
  }

  const memPath = `users/${uid}/question_memory`;
  try {
    const q = query(collection(db, 'users', uid, 'question_memory'), where('userId', '==', uid));
    const snap = await getDocs(q);
    out.questionMemory = snap.docs.map((d) => {
      const data = d.data() as Record<string, unknown>;
      return {
        questionFamilyId: String(data.questionFamilyId),
        timesSeen: Number(data.timesSeen ?? data.streak ?? 1),
        lastSeenAt: String(data.lastSeenAt),
        lastAllCorrect:
          typeof data.lastAllCorrect === 'boolean'
            ? data.lastAllCorrect
            : Number(data.intervalDays ?? 1) > 1,
        nextDueAt: String(data.nextDueAt),
        intervalDays: Number(data.intervalDays ?? 1),
        lapseCount: Number(data.lapseCount ?? 0),
      };
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, memPath);
  }

  const writPath = `users/${uid}/writing_submissions`;
  try {
    const q = query(collection(db, 'users', uid, 'writing_submissions'), where('userId', '==', uid));
    const snap = await getDocs(q);
    out.writingSubmissions = snap.docs.map((d) => {
      const data = d.data() as Record<string, unknown>;
      return {
        submissionId: String(data.submissionId),
        studentId: uid,
        sessionId: String(data.sessionId),
        questionId: String(data.questionId),
        planNotes: String(data.planNotes || ''),
        responseText: String(data.responseText || ''),
        wordCount: Number(data.wordCount || 0),
        timeSpentSec: Number(data.timeSpentSec || 0),
        deterministicMetricsJson: JSON.stringify(
          (data.deterministicMetrics as WritingDeterministicMetrics) || {}
        ),
        submittedAt: String(data.submittedAt),
        evaluations: Array.isArray(data.evaluations)
          ? (data.evaluations as WritingEvaluationRecord[])
          : [],
      };
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, writPath);
  }

  // 2. Shared config versions & QC overrides
  try {
    const cfgSnap = await getDocs(query(collection(db, 'admin_configs'), orderBy('versionNumber', 'asc')));
    out.configVersions = cfgSnap.docs.map((d) => {
      const data = d.data() as Record<string, unknown>;
      return {
        configVersionId: String(data.configVersionId),
        versionNumber: Number(data.versionNumber),
        notes: data.notes ? String(data.notes) : undefined,
        createdAt: String(data.createdAtIso || new Date().toISOString()),
        config: data.config as LearningConfig,
      };
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'admin_configs');
  }

  try {
    const ovSnap = await getDocs(collection(db, 'bank_question_overrides'));
    out.questionOverrides = ovSnap.docs.map((d) => {
      const data = d.data() as Record<string, unknown>;
      return {
        questionId: String(data.questionId),
        qcStatus: data.qcStatus as QuestionItem['qcStatus'],
        visual: data.visual as VisualSpec | undefined,
      };
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'bank_question_overrides');
  }

  // 3. Admin-only full bank collections (answer keys protected by rules)
  if (isAdmin) {
    try {
      const stimSnap = await getDocs(collection(db, 'bank_stimuli'));
      out.stimuli = stimSnap.docs.map((d) => (d.data() as { payload: StimulusGroup }).payload);
    } catch (err) {
      handleFirestoreError(err, OperationType.LIST, 'bank_stimuli');
    }

    try {
      const qSnap = await getDocs(collection(db, 'bank_questions'));
      out.questions = qSnap.docs.map((d) => (d.data() as { payload: QuestionItem }).payload);
    } catch (err) {
      handleFirestoreError(err, OperationType.LIST, 'bank_questions');
    }

    try {
      const flagSnap = await getDocs(collection(db, 'question_flags'));
      out.flags = flagSnap.docs.map((d) => {
        const data = d.data() as Record<string, unknown>;
        return {
          flagId: String(data.flagId),
          questionId: String(data.questionId),
          sessionId: data.sessionId ? String(data.sessionId) : '',
          reason: String(data.reason),
          notes: data.notes ? String(data.notes) : undefined,
          status: (data.status as 'open' | 'resolved') || 'open',
          createdAt: String(data.createdAtIso || new Date().toISOString()),
        };
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.LIST, 'question_flags');
    }
  }

  return out;
}

export async function pushSessionCreateToFirestore(session: SessionRecord): Promise<void> {
  const user = auth.currentUser;
  if (!user) return;
  const uid = user.uid;
  const sid = toSafeDocId(session.sessionId);
  const path = `users/${uid}/sessions/${sid}`;
  try {
    await setDoc(
      doc(db, 'users', uid, 'sessions', sid),
      stripUndefined({
        sessionId: sid,
        userId: uid,
        studentId: uid,
        configVersionId: session.configVersionId || 'cfg_v1',
        mode: session.mode,
        title: session.title,
        sectionFilter: session.sectionFilter,
        mockBatch: session.mockBatch,
        timeMultiplier: session.timeMultiplier,
        isSandbox: Boolean(session.isSandbox),
        status: session.status,
        plannedQuestionIds: session.plannedQuestionIds,
        checkpoint: session.checkpoint || {},
        timeLimitSec: session.timeLimitSec,
        totalSlots: session.totalSlots,
        correctSlots: session.correctSlots,
        startedAt: session.startedAt,
        completedAt: session.completedAt,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function pushSessionCheckpointToFirestore(
  sessionId: string,
  checkpoint: NonNullable<SessionRecord['checkpoint']>
): Promise<void> {
  const user = auth.currentUser;
  if (!user) return;
  const uid = user.uid;
  const sid = toSafeDocId(sessionId);
  const path = `users/${uid}/sessions/${sid}`;
  try {
    await updateDoc(
      doc(db, 'users', uid, 'sessions', sid),
      stripUndefined({
        checkpoint,
        updatedAt: serverTimestamp(),
      })
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function pushSubmissionToFirestore(payload: {
  sessionId: string;
  checkpoint: NonNullable<SessionRecord['checkpoint']>;
  correctSlots: number;
  totalSlots: number;
  completedAt: string;
  attempts?: PartAttemptRecord[];
  skillStates?: SkillState[];
  questionMemory?: QuestionMemoryState[];
  writingSubmission?: {
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
  };
}): Promise<void> {
  const user = auth.currentUser;
  if (!user) return;
  const uid = user.uid;
  const sid = toSafeDocId(payload.sessionId);

  try {
    const batch = writeBatch(db);
    batch.update(
      doc(db, 'users', uid, 'sessions', sid),
      stripUndefined({
        checkpoint: payload.checkpoint,
        status: 'submitted',
        correctSlots: payload.correctSlots,
        totalSlots: payload.totalSlots,
        completedAt: payload.completedAt,
        updatedAt: serverTimestamp(),
      })
    );

    for (const att of payload.attempts || []) {
      const aid = toSafeDocId(att.attemptId);
      batch.set(
        doc(db, 'users', uid, 'attempts', aid),
        stripUndefined({
          attemptId: aid,
          userId: uid,
          sessionId: sid,
          questionId: att.questionId,
          questionFamilyId: att.questionFamilyId,
          partId: att.partId,
          skillId: att.skillId,
          difficultyAtAttempt: att.difficultyAtAttempt,
          selectedAnswer: att.selectedAnswer || '',
          isCorrect: att.isCorrect,
          timeSpentSec: att.timeSpentSec,
          isSpacedReview: att.isSpacedReview,
          createdAtIso: att.createdAt,
          createdAt: serverTimestamp(),
        })
      );
    }

    for (const st of payload.skillStates || []) {
      const skDocId = toSafeDocId(st.skillId);
      batch.set(
        doc(db, 'users', uid, 'skill_states', skDocId),
        stripUndefined({
          userId: uid,
          skillId: st.skillId,
          masteryScore: st.masteryScore,
          confidence: st.uncertainty,
          ewmaAccuracy: st.ewmaAccuracy,
          ewmaSpeedRatio: st.avgTimeRatio,
          attemptsCount: st.attemptsCount,
          correctCount: st.correctCount,
          lastPracticedAt: st.lastPracticedAt,
          nextReviewDueAt: st.nextReviewAt,
          reviewIntervalDays: st.reviewIntervalDays,
          easeFactor: st.easeFactor,
          plateauStatus: st.plateauStatus,
          updatedAt: serverTimestamp(),
        })
      );
    }

    for (const mem of payload.questionMemory || []) {
      const memDocId = toSafeDocId(mem.questionFamilyId);
      batch.set(
        doc(db, 'users', uid, 'question_memory', memDocId),
        stripUndefined({
          userId: uid,
          questionFamilyId: mem.questionFamilyId,
          timesSeen: mem.timesSeen,
          lastAllCorrect: mem.lastAllCorrect,
          lastSeenAt: mem.lastSeenAt,
          nextDueAt: mem.nextDueAt,
          intervalDays: mem.intervalDays,
          easeFactor: 2.5,
          streak: mem.timesSeen,
          lapseCount: mem.lapseCount,
          updatedAt: serverTimestamp(),
        })
      );
    }

    if (payload.writingSubmission) {
      const sub = payload.writingSubmission;
      const subId = toSafeDocId(sub.submissionId);
      let metricsMap: Record<string, unknown> = {};
      try {
        metricsMap = JSON.parse(sub.deterministicMetricsJson || '{}');
      } catch {
        metricsMap = {};
      }
      batch.set(
        doc(db, 'users', uid, 'writing_submissions', subId),
        stripUndefined({
          submissionId: subId,
          userId: uid,
          studentId: uid,
          sessionId: sid,
          questionId: sub.questionId,
          planNotes: sub.planNotes.slice(0, 10000),
          responseText: sub.responseText.slice(0, 30000),
          wordCount: sub.wordCount,
          timeSpentSec: sub.timeSpentSec,
          deterministicMetrics: metricsMap,
          evaluations: sub.evaluations || [],
          submittedAt: sub.submittedAt,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
    }

    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `users/${uid}/sessions/${sid}`);
  }
}

export async function pushWritingEvaluationsToFirestore(
  submissionId: string,
  evaluations: WritingEvaluationRecord[]
): Promise<void> {
  const user = auth.currentUser;
  if (!user) return;
  const uid = user.uid;
  const subId = toSafeDocId(submissionId);
  const path = `users/${uid}/writing_submissions/${subId}`;
  try {
    await updateDoc(
      doc(db, 'users', uid, 'writing_submissions', subId),
      stripUndefined({
        evaluations: evaluations.slice(0, 10),
        updatedAt: serverTimestamp(),
      })
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function pushManifestToFirestore(manifest: BankImportManifest): Promise<void> {
  const user = auth.currentUser;
  if (!user) return;
  try {
    let batch = writeBatch(db);
    let opCount = 0;

    for (const stim of manifest.stimuli || []) {
      const sid = toSafeDocId(stim.stimulusId);
      batch.set(
        doc(db, 'bank_stimuli', sid),
        stripUndefined({
          stimulusId: sid,
          stimulusFamilyId: stim.stimulusFamilyId,
          version: stim.version,
          section: stim.section,
          genreOrTextType: stim.genreOrTextType,
          payload: stim,
          updatedAt: serverTimestamp(),
        })
      );
      opCount++;
      if (opCount >= 400) {
        await batch.commit();
        batch = writeBatch(db);
        opCount = 0;
      }
    }

    for (const q of manifest.questions || []) {
      const qid = toSafeDocId(q.questionId);
      batch.set(
        doc(db, 'bank_questions', qid),
        stripUndefined({
          questionId: qid,
          questionFamilyId: q.questionFamilyId,
          version: q.version,
          section: q.section,
          formatType: q.formatType,
          poolType: q.poolType,
          qcStatus: q.qcStatus,
          payload: q,
          updatedAt: serverTimestamp(),
        })
      );
      opCount++;
      if (opCount >= 400) {
        await batch.commit();
        batch = writeBatch(db);
        opCount = 0;
      }
    }

    if (opCount > 0) {
      await batch.commit();
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'bank_questions');
  }
}

export async function pushQuestionOverrideToFirestore(
  questionId: string,
  qcStatus: QuestionItem['qcStatus'],
  visual?: VisualSpec
): Promise<void> {
  const user = auth.currentUser;
  if (!user) return;
  const qid = toSafeDocId(questionId);
  const path = `bank_question_overrides/${qid}`;
  try {
    await setDoc(
      doc(db, 'bank_question_overrides', qid),
      stripUndefined({
        questionId: qid,
        qcStatus,
        visual,
        updatedAt: serverTimestamp(),
      }),
      { merge: true }
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function pushConfigVersionToFirestore(entry: {
  configVersionId: string;
  versionNumber: number;
  notes?: string;
  config: LearningConfig;
  createdAtIso: string;
}): Promise<void> {
  const user = auth.currentUser;
  if (!user) return;
  const cid = toSafeDocId(entry.configVersionId);
  const path = `admin_configs/${cid}`;
  try {
    await setDoc(
      doc(db, 'admin_configs', cid),
      stripUndefined({
        configVersionId: cid,
        versionNumber: entry.versionNumber,
        notes: entry.notes,
        config: entry.config,
        createdAtIso: entry.createdAtIso,
        createdAt: serverTimestamp(),
      })
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function pushFlagToFirestore(flag: QuestionFlagRecord): Promise<void> {
  const user = auth.currentUser;
  if (!user) return;
  const fid = toSafeDocId(flag.flagId);
  const path = `question_flags/${fid}`;
  try {
    await setDoc(
      doc(db, 'question_flags', fid),
      stripUndefined({
        flagId: fid,
        userId: user.uid,
        questionId: flag.questionId,
        sessionId: flag.sessionId,
        reason: flag.reason,
        notes: flag.notes,
        status: flag.status,
        createdAtIso: flag.createdAt,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function resolveFlagInFirestore(flagId: string): Promise<void> {
  const user = auth.currentUser;
  if (!user) return;
  const fid = toSafeDocId(flagId);
  const path = `question_flags/${fid}`;
  try {
    await updateDoc(doc(db, 'question_flags', fid), {
      status: 'resolved',
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export type TimestampField = Timestamp;
