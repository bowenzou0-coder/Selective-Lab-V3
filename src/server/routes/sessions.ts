import crypto from 'node:crypto';
import type { Express } from 'express';
import { requireStudentOrAdmin, type AuthenticatedRequest } from '../auth.ts';
import { decidePracticeQuestionOrderWithGemini, getOrCreateDailyFocusPlan } from '../geminiPlanner.ts';
import { ForbiddenError, NotFoundError, RevisionConflictError, type QuestionSelectionItem } from '../storage/repository.ts';
import {
  DEFAULT_AUTO_CALIBRATE,
  resolveEffectiveLearningConfig,
  type MarkingResult,
  type MockTestBatch,
  type QuestionItem,
  type SectionCode,
  type SessionCheckpoint,
  type SessionMode,
  type SessionRecord,
  type SessionSelectionDecision,
  type WritingDeterministicMetrics,
  type WritingEvaluationRecord,
} from '../../shared/contracts.ts';
import { gradeSubmission, selectBatchMockQuestions, selectBenchmarkHoldoutQuestions, selectMockTestQuestions, selectPoolMockQuestions, selectPracticeSession, toStudentQuestionView } from '../../shared/engine.ts';
import type { AppContext } from '../context.ts';
import {
  getOfficialTimeLimitSec,
  buildQuestionSnapshots,
  buildBenchmarkSectionState,
  mergeActiveSectionCheckpoint,
  computeActiveSectionElapsedSec,
  computeTotalSectionedElapsedSec,
  resolveSessionQuestionPairs,
  SessionValidationError,
  getEffectiveDeadlineMs,
  SUBMIT_GRACE_MS,
  isSessionExpired,
  isSessionPastGrace,
  resolveSessionForCaller,
  finalizeSessionRecord,
  resolveOrExpireSession,
} from '../sessionLifecycle.ts';

/** Session lifecycle: create, load, checkpoint, submit (/api/student/sessions/*). */
export function registerSessionRoutes(app: Express, ctx: AppContext): void {
  const { repo } = ctx;
  app.post('/api/student/sessions', requireStudentOrAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ctx.ensureSeeded();
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

      const selectionFilter =
        mode === 'benchmark_exam'
          ? batchId
            ? { qcStatus: 'active', poolType: 'benchmark_holdout', batchId, section: sectionFilter }
            : { qcStatus: 'active', section: sectionFilter }
          : mockSource === 'pool'
            ? { qcStatus: 'active', section: sectionFilter }
            : batchId
              ? { qcStatus: 'active', batchId, section: sectionFilter }
              : mockBatch
                ? { qcStatus: 'active', batchTag: mockBatch, section: sectionFilter }
                : { qcStatus: 'active', section: mode === 'writing_sprint' ? ('WRIT' as SectionCode) : sectionFilter };

      const [existingSessions, configData, learnerPrefs, candidateQuestions, skillStates, questionMemory, evidenceMap] =
        await Promise.all([
          repo.listActiveSessions(studentId),
          repo.getActiveConfig(),
          repo.getLearnerPreferences(studentId),
          repo.listSelectionQuestions(selectionFilter),
          repo.getSkillStates(studentId),
          repo.getQuestionMemory(studentId),
          repo.getQuestionEvidence(studentId),
        ]);
      const effectiveConfig = resolveEffectiveLearningConfig(configData.config, learnerPrefs);

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
      let selectedMeta: QuestionSelectionItem[] = [];
      let selectionDecision: SessionSelectionDecision | undefined;
      let title = '';
      let effectiveMode: SessionMode = mode;
      let timeLimitSec = 1500;

      if (mode === 'benchmark_exam') {
        effectiveMode = 'benchmark_exam';
        // Official Benchmark Exams are strictly locked to full 4-section 1.0x NSW timing (155 min)
        selectedMeta = selectBenchmarkHoldoutQuestions({
          batchId,
          questions: candidateQuestions,
        });
        if (selectedMeta.length === 0 && !batchId) {
          selectedMeta = selectMockTestQuestions({
            batch: 'PT3',
            questions: candidateQuestions,
          });
        }
        timeLimitSec = getOfficialTimeLimitSec(undefined); // 9300s (155m) locked
        const label = selectedMeta[0]?.batchLabel || 'Official Benchmark';
        title = `Benchmark: ${label} (Full Exam)`;
      } else if (mockSource === 'pool') {
        effectiveMode = 'section_drill';
        selectedMeta = selectPoolMockQuestions({
          questions: candidateQuestions,
          sectionFilter,
          questionCount,
          questionMemory,
          evidenceMap,
          autoRetireMastered: Boolean(configData.config.poolPolicy?.autoRetireMastered),
          seed: Date.now() & 0xfffffff,
        });
        const baseSec = getOfficialTimeLimitSec(sectionFilter);
        if (customTimeLimitSec !== undefined && !Number.isNaN(customTimeLimitSec) && customTimeLimitSec > 0) {
          timeLimitSec = Math.max(60, Math.round(customTimeLimitSec));
        } else {
          // Enforce strictly timed student exams (no untimed loophole)
          timeLimitSec = Math.max(60, Math.round(baseSec * (timeMultiplier > 0 ? timeMultiplier : 1)));
        }
        title = `Fresh Pool Mock${sectionFilter ? ` (${sectionFilter})` : ' (Full Exam)'}`;
      } else if (batchId) {
        effectiveMode = 'section_drill';
        selectedMeta = selectBatchMockQuestions({
          batchId,
          sectionFilter,
          questions: candidateQuestions,
        });
        const baseSec = getOfficialTimeLimitSec(sectionFilter);
        timeLimitSec =
          customTimeLimitSec !== undefined && !Number.isNaN(customTimeLimitSec) && customTimeLimitSec > 0
            ? Math.max(60, Math.round(customTimeLimitSec))
            : Math.max(60, Math.round(baseSec * (timeMultiplier > 0 ? timeMultiplier : 1)));
        const batchLabel = selectedMeta[0]?.batchLabel || batchId;
        title = `${batchLabel}${sectionFilter ? ` (${sectionFilter})` : ''}`;
      } else if (mockBatch) {
        selectedMeta = selectMockTestQuestions({
          batch: mockBatch,
          sectionFilter,
          questions: candidateQuestions,
        });
        if (mockBatch === 'PT3') {
          effectiveMode = selectedMeta.some((q) => q.poolType === 'benchmark_holdout')
            ? 'benchmark_exam'
            : 'section_drill';
        }
        const baseSec = getOfficialTimeLimitSec(sectionFilter);
        if (customTimeLimitSec !== undefined && !Number.isNaN(customTimeLimitSec) && customTimeLimitSec > 0) {
          timeLimitSec = Math.max(60, Math.round(customTimeLimitSec));
        } else {
          timeLimitSec = Math.max(60, Math.round(baseSec * (timeMultiplier > 0 ? timeMultiplier : 1)));
        }
        title = `${mockBatch} Mock${sectionFilter ? ` (${sectionFilter})` : ' (Full Test)'}`;
      } else if (mode === 'diagnostic') {
        const seed = Date.now() & 0xfffffff;
        const calibrationConfig = {
          ...effectiveConfig,
          autoCalibrate: {
            ...(effectiveConfig.autoCalibrate ?? DEFAULT_AUTO_CALIBRATE),
            enabled: false,
          },
          sessionDefaults: {
            ...effectiveConfig.sessionDefaults,
            dailyQuestionLimitBySection: { READ: 2, MATH: 3, THINK: 3, WRIT: 0 },
            dailyGoalMinutes: 15,
          },
        };
        selectedMeta = selectPracticeSession({
          mode: 'diagnostic',
          questions: candidateQuestions,
          skillStates,
          questionMemory,
          evidenceMap,
          dailyLimitsOverride: { READ: 2, MATH: 3, THINK: 3, WRIT: 0 },
          config: calibrationConfig,
          nowIso,
          seed,
        });
        effectiveMode = 'diagnostic';
        timeLimitSec =
          customTimeLimitSec !== undefined && !Number.isNaN(customTimeLimitSec)
            ? Math.max(60, Math.round(customTimeLimitSec))
            : 15 * 60;
        title = 'Starter Calibration Test';
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
                questions: () =>
                  effectiveSection
                    ? repo.listSelectionQuestions({ qcStatus: 'active' })
                    : Promise.resolve(candidateQuestions),
                config: effectiveConfig,
                nowIso,
              })).plan;
        const seed = Date.now() & 0xfffffff;
        if (mode === 'writing_sprint') {
          selectedMeta = selectPracticeSession({
            mode: normalizedMode,
            sectionFilter: effectiveSection,
            questions: candidateQuestions,
            skillStates,
            questionMemory,
            evidenceMap,
            skillFocusWeights: dailyPlan?.skillWeights,
            algorithmAdjustments: dailyPlan?.algorithmAdjustments,
            config: effectiveConfig,
            nowIso,
            seed,
          }).slice(0, 1);
        } else {
          const ordered = await decidePracticeQuestionOrderWithGemini({
            mode: normalizedMode,
            sectionFilter: effectiveSection,
            questions: candidateQuestions,
            skillStates,
            questionMemory,
            evidenceMap,
            dailyPlan,
            questionCountOverride: questionCount,
            config: effectiveConfig,
            nowIso,
            seed,
          });
          selectedMeta = ordered.questions;
          selectionDecision = ordered.decision;
        }
        effectiveMode = normalizedMode;
        if (mode === 'writing_sprint') {
          timeLimitSec = 1800;
          title = 'Writing Sprint (30 min)';
        } else if (effectiveSection) {
          const drillMin = Math.max(1, effectiveConfig.sessionDefaults.sectionDrillTimeMinutes ?? 8);
          timeLimitSec = effectiveSection === 'WRIT' ? 1800 : drillMin * 60;
          title = `${effectiveSection} Practice Drill (${selectedMeta.length} Qs)`;
        } else {
          const goalMin =
            effectiveConfig.autoCalibrate?.enabled && dailyPlan?.dailyGoalMinutes
              ? dailyPlan.dailyGoalMinutes
              : effectiveConfig.sessionDefaults.dailyGoalMinutes;
          timeLimitSec = goalMin * 60;
          title = "Today's Adaptive Practice";
        }
        if (customTimeLimitSec !== undefined && !Number.isNaN(customTimeLimitSec)) {
          timeLimitSec = Math.max(0, Math.round(customTimeLimitSec));
        }
      }

      if (selectedMeta.length === 0) {
        res.status(400).json({ error: 'No active questions matched the requested session criteria.' });
        return;
      }

      const fetchedQuestions = await repo.listQuestionsByIds(selectedMeta.map((q) => q.questionId));
      const fetchedById = new Map(fetchedQuestions.map((q) => [q.questionId, q]));
      const selected = selectedMeta
        .map((q) => fetchedById.get(q.questionId))
        .filter((q): q is QuestionItem => Boolean(q));

      if (selected.length === 0) {
        res.status(400).json({ error: 'No active questions matched the requested session criteria.' });
        return;
      }

      const snapshots = await buildQuestionSnapshots(repo, selected);
      const totalSlots = snapshots.reduce((sum, s) => sum + s.question.parts.length, 0);
      const startedAtIso = new Date().toISOString();
      const sectionState =
        effectiveMode === 'benchmark_exam' && !sectionFilter
          ? buildBenchmarkSectionState(snapshots, startedAtIso)
          : undefined;
      const effectiveTimeLimitSec = sectionState
        ? sectionState.sections.reduce((sum, b) => sum + b.timeLimitSec, 0)
        : timeLimitSec;
      const deadlineAt = sectionState
        ? sectionState.sections[0].deadlineAt
        : effectiveTimeLimitSec > 0
          ? new Date(Date.parse(startedAtIso) + effectiveTimeLimitSec * 1000).toISOString()
          : undefined;

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
        sectionState,
        timeLimitSec: effectiveTimeLimitSec > 0 ? effectiveTimeLimitSec : undefined,
        deadlineAt,
        totalSlots,
        correctSlots: 0,
        startedAt: startedAtIso,
      };

      let reserved = await repo.reserveAndCreateSession(session, snapshots);
      if (!reserved.created && reserved.conflictSession && isSessionPastGrace(reserved.conflictSession)) {
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
      await ctx.ensureSeeded();
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
            responseText?: string;
            planNotes?: string;
            evaluatingInProgress?: boolean;
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
            responseText: s.responseText,
            planNotes: s.planNotes,
            evaluatingInProgress: ctx.inFlightWritingEvaluations.has(s.submissionId),
          }));
        } else if (session.submissionSummary?.writingReview) {
          writingReview = session.submissionSummary.writingReview.map((wr) => ({
            ...wr,
            responseText:
              wr.responseText ?? session.checkpoint?.writingDraft?.responseText ?? '',
            planNotes:
              wr.planNotes ?? session.checkpoint?.writingDraft?.planNotes ?? '',
            evaluatingInProgress: ctx.inFlightWritingEvaluations.has(wr.submissionId),
          }));
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
      await ctx.ensureSeeded();
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
        if (finalized.status === 'in_progress' && finalized.sectionState?.phase === 'on_break') {
          res.status(409).json({
            error: 'Section time ended — your answers were saved and locked.',
            sectionExpired: true,
            currentRevision: finalized.checkpointRevision ?? 1,
            serverCheckpoint: finalized.checkpoint,
            session: finalized,
          });
          return;
        }
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
      if (session.sectionState?.phase === 'on_break') {
        res.status(409).json({
          error: 'Currently on inter-section break. Start the next section to continue.',
          sectionPhase: 'on_break',
          currentRevision: session.checkpointRevision ?? 1,
          serverCheckpoint: session.checkpoint,
          session,
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

      let checkpointToSave = cp;
      if (session.sectionState?.phase === 'active') {
        const activeSec = session.sectionState.sections[session.sectionState.currentSectionIndex];
        if (activeSec) {
          const { pairs } = await resolveSessionQuestionPairs(repo, session);
          checkpointToSave = mergeActiveSectionCheckpoint(session.checkpoint, cp, pairs, activeSec);
        }
      }

      const saved = await repo.saveSessionCheckpoint(
        session.sessionId,
        req.auth!.studentId,
        checkpointToSave,
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

  app.post('/api/student/sessions/:id/section/complete', requireStudentOrAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ctx.ensureSeeded();
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
        res.status(403).json({ error: 'Forbidden: cannot modify another user session.' });
        return;
      }
      if (session.status === 'submitted' && session.submissionSummary) {
        res.json({
          finishedExam: true,
          ...session.submissionSummary,
          alreadySubmitted: true,
          expiredAutoSubmitted: Boolean(session.expiredAutoSubmitted),
          session,
        });
        return;
      }
      if (!session.sectionState) {
        res.status(400).json({ error: 'This session does not use sectioned breaks.' });
        return;
      }
      if (session.status !== 'in_progress') {
        res.status(409).json({
          error: 'Session is not active.',
          currentRevision: session.checkpointRevision ?? 1,
          serverCheckpoint: session.checkpoint,
        });
        return;
      }
      if (session.sectionState.phase === 'on_break') {
        res.json({
          finishedExam: false,
          session,
          serverNowIso: new Date().toISOString(),
        });
        return;
      }

      const nowMs = Date.now();
      const expired = isSessionExpired(session, nowMs);
      const deadlineMs = getEffectiveDeadlineMs(session);
      const withinGrace = deadlineMs === null || nowMs <= deadlineMs + SUBMIT_GRACE_MS;
      const idx = session.sectionState.currentSectionIndex;
      const activeSec = session.sectionState.sections[idx];
      const completedAtIso =
        expired && activeSec?.deadlineAt
          ? activeSec.deadlineAt
          : new Date(nowMs).toISOString();

      const { pairs } = await resolveSessionQuestionPairs(repo, session);
      const fallbackCp: SessionCheckpoint = session.checkpoint || {
        currentIndex: activeSec?.startIndex ?? 0,
        elapsedSec: 0,
        answersByPartId: {},
        flaggedQuestionIds: [],
      };
      const incomingCp = req.body?.checkpoint as SessionCheckpoint | undefined;
      const mergedCp =
        (!expired || withinGrace) && incomingCp && activeSec
          ? mergeActiveSectionCheckpoint(fallbackCp, incomingCp, pairs, activeSec)
          : fallbackCp;

      const rawExpectedRev = req.body?.expectedRevision;
      const expectedRevision =
        rawExpectedRev !== undefined && rawExpectedRev !== null && !Number.isNaN(Number(rawExpectedRev))
          ? Number(rawExpectedRev)
          : undefined;
      const effectiveExpectedRev =
        !expired || withinGrace ? expectedRevision : session.checkpointRevision ?? 1;

      const isLastSection = idx >= session.sectionState.sections.length - 1;
      if (isLastSection) {
        let finalResult;
        try {
          finalResult = await finalizeSessionRecord({
            repo,
            session,
            checkpoint: mergedCp,
            expectedRevision: effectiveExpectedRev,
            assisted: false,
            completedAtIso,
            expiredAutoSubmitted: expired,
            rejectValidationErrors: false,
          });
        } catch (err) {
          if (err instanceof RevisionConflictError && expired && !withinGrace) {
            const fresh = await repo.getSession(session.sessionId, req.auth!.studentId);
            if (fresh && fresh.status === 'submitted' && fresh.submissionSummary) {
              finalResult = {
                alreadySubmitted: true,
                session: fresh,
                submissionSummary: fresh.submissionSummary,
              };
            } else if (fresh) {
              finalResult = await finalizeSessionRecord({
                repo,
                session: fresh,
                checkpoint: fresh.checkpoint || fallbackCp,
                expectedRevision: fresh.checkpointRevision ?? 1,
                assisted: false,
                completedAtIso,
                expiredAutoSubmitted: true,
                rejectValidationErrors: false,
              });
            } else {
              throw err;
            }
          } else {
            throw err;
          }
        }

        res.json({
          finishedExam: true,
          ...finalResult.submissionSummary,
          alreadySubmitted: finalResult.alreadySubmitted,
          expiredAutoSubmitted: Boolean(finalResult.session.expiredAutoSubmitted),
          session: finalResult.session,
        });
        return;
      }

      const sectionElapsedSec = activeSec
        ? computeActiveSectionElapsedSec(activeSec, completedAtIso, expired)
        : 0;

      try {
        const updated = await repo.updateSessionProgressState(
          session.sessionId,
          req.auth!.studentId,
          (s) => {
            if (!s.sectionState || s.sectionState.phase !== 'active' || s.sectionState.currentSectionIndex !== idx) {
              return;
            }
            const sec = s.sectionState.sections[idx];
            sec.status = 'completed';
            sec.completedAt = completedAtIso;
            sec.elapsedSec = sectionElapsedSec;
            if (expired) sec.expiredAutoAdvanced = true;
            const nextSec = s.sectionState.sections[idx + 1];
            s.sectionState.currentSectionIndex = idx + 1;
            s.sectionState.phase = 'on_break';
            s.sectionState.breakStartedAt = completedAtIso;
            s.deadlineAt = undefined;
            const totalElapsed = computeTotalSectionedElapsedSec(s.sectionState, nowMs);
            s.checkpoint = {
              ...mergedCp,
              currentIndex: nextSec.startIndex,
              elapsedSec: totalElapsed,
            };
          },
          effectiveExpectedRev
        );
        res.json({
          finishedExam: false,
          session: updated.session,
          serverNowIso: new Date().toISOString(),
        });
        return;
      } catch (err) {
        if (err instanceof RevisionConflictError && expired && !withinGrace) {
          const fresh = await repo.getSession(session.sessionId, req.auth!.studentId);
          if (fresh?.status === 'in_progress' && fresh.sectionState) {
            if (fresh.sectionState.phase === 'on_break' || fresh.sectionState.currentSectionIndex > idx) {
              res.json({
                finishedExam: false,
                session: fresh,
                serverNowIso: new Date().toISOString(),
              });
              return;
            }
          }
        }
        throw err;
      }
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
      console.error('POST /api/student/sessions/:id/section/complete error:', err);
      res.status(500).json({ error: 'Failed to complete exam section.' });
    }
  });

  app.post('/api/student/sessions/:id/section/start', requireStudentOrAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ctx.ensureSeeded();
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
        res.status(403).json({ error: 'Forbidden: cannot modify another user session.' });
        return;
      }
      if (!session.sectionState) {
        res.status(400).json({ error: 'This session does not use sectioned breaks.' });
        return;
      }
      if (session.status !== 'in_progress') {
        res.status(409).json({
          error: 'Session already submitted.',
          alreadySubmitted: session.status === 'submitted',
          currentRevision: session.checkpointRevision ?? 1,
          serverCheckpoint: session.checkpoint,
        });
        return;
      }
      if (session.sectionState.phase === 'active') {
        res.json({
          session,
          serverNowIso: new Date().toISOString(),
        });
        return;
      }

      const rawExpectedRev = req.body?.expectedRevision;
      const expectedRevision =
        rawExpectedRev !== undefined && rawExpectedRev !== null && !Number.isNaN(Number(rawExpectedRev))
          ? Number(rawExpectedRev)
          : undefined;
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();

      const updated = await repo.updateSessionProgressState(
        session.sessionId,
        req.auth!.studentId,
        (s) => {
          if (!s.sectionState || s.sectionState.phase === 'active') return;
          const sec = s.sectionState.sections[s.sectionState.currentSectionIndex];
          if (!sec) return;
          sec.status = 'active';
          sec.startedAt = nowIso;
          sec.deadlineAt = new Date(nowMs + sec.timeLimitSec * 1000).toISOString();
          s.sectionState.phase = 'active';
          s.sectionState.breakStartedAt = undefined;
          s.deadlineAt = sec.deadlineAt;
          s.checkpoint = {
            ...(s.checkpoint || {
              currentIndex: 0,
              elapsedSec: 0,
              answersByPartId: {},
              flaggedQuestionIds: [],
            }),
            currentIndex: sec.startIndex,
          };
        },
        expectedRevision
      );

      res.json({
        session: updated.session,
        serverNowIso: new Date().toISOString(),
      });
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
      console.error('POST /api/student/sessions/:id/section/start error:', err);
      res.status(500).json({ error: 'Failed to start next exam section.' });
    }
  });

  app.post('/api/student/sessions/:id/submit', requireStudentOrAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ctx.ensureSeeded();
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

      if (session.sectionState) {
        const isLast =
          session.sectionState.currentSectionIndex >= session.sectionState.sections.length - 1;
        if (!isLast) {
          res.status(400).json({
            error: 'Complete each timed section in order before final submission.',
          });
          return;
        }
        if (session.sectionState.phase === 'on_break') {
          res.status(400).json({
            error: 'Start the final section before submitting.',
          });
          return;
        }
      }

      const nowMs = Date.now();
      const expired = isSessionExpired(session, nowMs);
      const deadlineMs = getEffectiveDeadlineMs(session);
      const withinGrace = deadlineMs === null || nowMs <= deadlineMs + SUBMIT_GRACE_MS;
      const completedAtIso =
        expired && deadlineMs !== null
          ? (session.sectionState?.sections[session.sectionState.currentSectionIndex]?.deadlineAt ||
            session.deadlineAt ||
            new Date(deadlineMs).toISOString())
          : new Date(nowMs).toISOString();

      const incomingCheckpoint = req.body?.checkpoint as SessionRecord['checkpoint'] | undefined;
      const fallbackCp: SessionCheckpoint = session.checkpoint || {
        currentIndex: 0,
        elapsedSec: 0,
        answersByPartId: {},
        flaggedQuestionIds: [],
      };
      let baseCp: SessionCheckpoint =
        (!expired || withinGrace) && incomingCheckpoint ? incomingCheckpoint : fallbackCp;
      if (session.sectionState?.phase === 'active' && (!expired || withinGrace) && incomingCheckpoint) {
        const activeSec = session.sectionState.sections[session.sectionState.currentSectionIndex];
        if (activeSec) {
          const { pairs } = await resolveSessionQuestionPairs(repo, session);
          baseCp = mergeActiveSectionCheckpoint(fallbackCp, incomingCheckpoint, pairs, activeSec);
        }
      }
      const cp: SessionCheckpoint = expired
        ? {
            ...baseCp,
            elapsedSec: session.timeLimitSec ?? baseCp.elapsedSec ?? 0,
          }
        : baseCp;

      const rawExpectedRev = req.body?.expectedRevision;
      const expectedRevision =
        rawExpectedRev !== undefined && rawExpectedRev !== null && !Number.isNaN(Number(rawExpectedRev))
          ? Number(rawExpectedRev)
          : undefined;

      const assisted = Boolean(req.body?.assisted);
      let finalResult;
      try {
        finalResult = await finalizeSessionRecord({
          repo,
          session,
          checkpoint: cp,
          expectedRevision: !expired || withinGrace ? expectedRevision : session.checkpointRevision ?? 1,
          assisted,
          completedAtIso,
          expiredAutoSubmitted: expired,
          rejectValidationErrors: !expired,
        });
      } catch (err) {
        if (err instanceof RevisionConflictError && expired && !withinGrace) {
          const fresh = await repo.getSession(session.sessionId, req.auth!.studentId);
          if (fresh && fresh.status === 'submitted' && fresh.submissionSummary) {
            finalResult = {
              alreadySubmitted: true,
              session: fresh,
              submissionSummary: fresh.submissionSummary,
            };
          } else if (fresh) {
            const freshCp: SessionCheckpoint = {
              ...(fresh.checkpoint || fallbackCp),
              elapsedSec: fresh.timeLimitSec ?? fresh.checkpoint?.elapsedSec ?? 0,
            };
            finalResult = await finalizeSessionRecord({
              repo,
              session: fresh,
              checkpoint: freshCp,
              expectedRevision: fresh.checkpointRevision ?? 1,
              assisted,
              completedAtIso,
              expiredAutoSubmitted: true,
              rejectValidationErrors: false,
            });
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }

      res.json({
        ...finalResult.submissionSummary,
        alreadySubmitted: finalResult.alreadySubmitted,
        expiredAutoSubmitted: Boolean(finalResult.session.expiredAutoSubmitted),
      });
    } catch (err) {
      if (err instanceof RevisionConflictError) {
        res.status(409).json({
          error: err.message,
          currentRevision: err.currentRevision,
          serverCheckpoint: err.serverCheckpoint,
        });
        return;
      }
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
}
