import { RevisionConflictError, type AppRepository } from './storage/repository.ts';
import type { MarkingResult, PartAttemptRecord, QuestionItem, QuestionMasteryEvidence, QuestionMemoryState, SectionCode, SessionCheckpoint, SessionQuestionSnapshot, SessionRecord, SessionSubmissionPayload, SkillState, StimulusGroup, WritingDeterministicMetrics, WritingEvaluationRecord } from '../shared/contracts.ts';
import { computeWritingMetrics, detectPlateauStatus, gradeSubmission, updateFamilyMemoryOnce, updateSkillState } from '../shared/engine.ts';
import { advanceQuestionEvidence, buildEvidenceKey, computeEvidenceRevision } from '../shared/mastery.ts';
import { buildBenchmarkReportRecord } from '../shared/nswBenchmark.ts';

export function getOfficialTimeLimitSec(sectionFilter?: SectionCode): number {
  if (sectionFilter === 'WRIT') return 1800; // 30 min
  if (sectionFilter === 'READ') return 2700; // 45 min (2025+ NSW Selective)
  if (sectionFilter === 'MATH' || sectionFilter === 'THINK') return 2400; // 40 min
  return 9300; // 45 + 40 + 40 + 30 = 155 min
}

export function computeSessionStreak(sessions: SessionRecord[]): number {
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

export async function buildQuestionSnapshots(
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

export async function resolveSessionQuestionPairs(
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

  const liveQuestions = await repo.listQuestionsByIds(session.plannedQuestionIds);
  const qById = new Map(liveQuestions.map((q) => [q.questionId, q]));
  const orderedQuestions = session.plannedQuestionIds
    .map((qid) => qById.get(qid))
    .filter((q): q is QuestionItem => Boolean(q));
  const stimIds = Array.from(
    new Set(orderedQuestions.map((q) => q.stimulusId).filter((id): id is string => Boolean(id)))
  );
  const stimuliById = await repo.listStimuliByIds(stimIds);
  return {
    pairs: orderedQuestions.map((q) => {
      const stim = q.stimulusId ? stimuliById[q.stimulusId] : undefined;
      return {
        question: q,
        stimulus: stim,
        evidenceRevision: q.evidenceRevision || computeEvidenceRevision(q, stim),
      };
    }),
    usedLegacyLiveBank: true,
  };
}

export class SessionValidationError extends Error {
  readonly statusCode = 400;
}

export function getEffectiveDeadlineMs(session: SessionRecord): number | null {
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

export const SUBMIT_GRACE_MS = 5_000;

export function isSessionExpired(session: SessionRecord, nowMs = Date.now()): boolean {
  if (session.status !== 'in_progress' || session.isSandbox) return false;
  const deadlineMs = getEffectiveDeadlineMs(session);
  return deadlineMs !== null && nowMs >= deadlineMs;
}

/**
 * True only after the server submit grace window has elapsed.
 * Background/read auto-expiry MUST use this so in-flight checkpoint/submit requests
 * within the grace window are never overwritten with stale answers.
 */
export function isSessionPastGrace(session: SessionRecord, nowMs = Date.now()): boolean {
  if (session.status !== 'in_progress' || session.isSandbox) return false;
  const deadlineMs = getEffectiveDeadlineMs(session);
  return deadlineMs !== null && nowMs > deadlineMs + SUBMIT_GRACE_MS;
}

export async function findActiveSessionId(repo: AppRepository, studentId: string): Promise<string | null> {
  for (const s of await repo.listActiveSessions(studentId)) {
    const resolved = await resolveOrExpireSession(repo, s);
    if (resolved.status === 'in_progress') return resolved.sessionId;
  }
  return null;
}

export async function resolveSessionForCaller(
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

export async function finalizeSessionRecord(input: {
  repo: AppRepository;
  session: SessionRecord;
  checkpoint: SessionCheckpoint;
  expectedRevision?: number;
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
    expectedRevision,
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
    responseText?: string;
    planNotes?: string;
  }[] = [];

  let totalObjectiveSlots = 0;
  let correctObjectiveSlots = 0;
  let savedWritingSubmission: SessionSubmissionPayload['writingSubmission'];

  for (const { question, evidenceRevision } of pairs) {
    if (question.formatType === 'WRIT_TYPED_TASK') {
      const keyedDraft = checkpoint.writingDraftsByQuestionId?.[question.questionId];
      const responseText = keyedDraft?.responseText ?? checkpoint.writingDraft?.responseText ?? '';
      const planNotes = keyedDraft?.planNotes ?? checkpoint.writingDraft?.planNotes ?? '';
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
        responseText,
        planNotes,
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

      if (!session.isSandbox && question.poolType !== 'benchmark_holdout') {
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

    if (!session.isSandbox && question.poolType !== 'benchmark_holdout') {
      let nextEv: QuestionMasteryEvidence | undefined;
      if (question.qcStatus === 'active') {
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

  const finalized = await repo.finalizeSessionAtomically({
    sessionId: session.sessionId,
    studentId: ownerId,
    checkpoint,
    expectedRevision,
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

  // Automatically persist the official BenchmarkReportRecord for completed benchmark exams
  if (!session.isSandbox && finalized.session.mode === 'benchmark_exam') {
    try {
      const existingReport = await repo.getBenchmarkReport(finalized.session.sessionId, ownerId);
      if (!existingReport) {
        const report = buildBenchmarkReportRecord({
          session: finalized.session,
          questions: pairs.map((p) => p.question),
          reviewResults,
          writingReview: writingReview.map((w) => ({
            submissionId: w.submissionId,
            evaluations: w.evaluations,
          })),
        });
        await repo.saveBenchmarkReport(report);
      }
    } catch (err) {
      console.error('Failed to persist benchmark report on finalize:', err);
    }
  }

  return finalized;
}

export async function resolveOrExpireSession(
  repo: AppRepository,
  session: SessionRecord
): Promise<SessionRecord> {
  if (!isSessionPastGrace(session)) return session;

  let target = session;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (target.status === 'submitted') return target;
    const deadlineMs = getEffectiveDeadlineMs(target);
    const completedAtIso =
      target.deadlineAt ||
      (deadlineMs !== null ? new Date(deadlineMs).toISOString() : new Date().toISOString());
    const baseCheckpoint: SessionCheckpoint = target.checkpoint
      ? {
          ...target.checkpoint,
          elapsedSec: target.timeLimitSec ?? target.checkpoint.elapsedSec ?? 0,
        }
      : {
          currentIndex: 0,
          elapsedSec: target.timeLimitSec ?? 0,
          answersByPartId: {},
          flaggedQuestionIds: [],
        };

    try {
      const finalized = await finalizeSessionRecord({
        repo,
        session: target,
        checkpoint: baseCheckpoint,
        expectedRevision: target.checkpointRevision ?? 1,
        assisted: false,
        completedAtIso,
        expiredAutoSubmitted: true,
        rejectValidationErrors: false,
      });
      return finalized.session;
    } catch (err) {
      if (err instanceof RevisionConflictError && attempt === 0) {
        const fresh = await repo.getSession(target.sessionId, target.studentId);
        if (fresh) {
          target = fresh;
          continue;
        }
      }
      throw err;
    }
  }
  return target;
}
