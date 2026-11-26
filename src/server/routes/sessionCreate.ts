import crypto from 'node:crypto';
import type { Express } from 'express';
import { requireStudentOrAdmin, type AuthenticatedRequest } from '../auth.ts';
import { decidePracticeQuestionOrderWithGemini, getOrCreateDailyFocusPlan } from '../geminiPlanner.ts';
import type { QuestionSelectionItem } from '../storage/repository.ts';
import {
  DEFAULT_AUTO_CALIBRATE,
  resolveEffectiveLearningConfig,
  type MockTestBatch,
  type QuestionItem,
  type SectionCode,
  type SessionMode,
  type SessionRecord,
  type SessionSelectionDecision,
} from '../../shared/contracts.ts';
import { selectBatchMockQuestions, selectBenchmarkHoldoutQuestions, selectMockTestQuestions, selectPoolMockQuestions, selectPracticeSession } from '../../shared/engine.ts';
import type { AppContext } from '../context.ts';
import {
  getOfficialTimeLimitSec,
  buildQuestionSnapshots,
  buildBenchmarkSectionState,
  isSessionPastGrace,
  resolveOrExpireSession,
} from '../sessionLifecycle.ts';

/** POST /api/student/sessions: selects questions for the requested mode and creates the session record. */
export function registerSessionCreateRoute(app: Express, ctx: AppContext): void {
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
}
