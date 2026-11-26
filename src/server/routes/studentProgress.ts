import crypto from 'node:crypto';
import type { Express } from 'express';
import { requireAdmin, requireStudentOrAdmin, type AuthenticatedRequest } from '../auth.ts';
import { GeminiServiceError } from '../geminiClient.ts';
import { evaluateWritingWithGemini } from '../geminiWriting.ts';
import type { QuestionFlagRecord, WritingDeterministicMetrics } from '../../shared/contracts.ts';
import { SKILLS_TAXONOMY } from '../../shared/skills.ts';
import { buildBenchmarkReportRecord } from '../../shared/nswBenchmark.ts';
import { gradeSubmission } from '../../shared/engine.ts';
import { ensureBenchmarkReportForSession, resolveSessionQuestionPairs } from '../sessionLifecycle.ts';
import { enforceAiRateLimit } from '../rateLimit.ts';
import { NotFoundError } from '../storage/repository.ts';
import type { AppContext } from '../context.ts';


/** Writing evaluation, flags, progress and export (/api/student/*). */
export function registerStudentProgressRoutes(app: Express, ctx: AppContext): void {
  const { repo } = ctx;
  app.post(
    '/api/student/writing/:submissionId/evaluate',
    requireStudentOrAdmin,
    async (req: AuthenticatedRequest, res) => {
      try {
        await ctx.ensureSeeded();
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

        let pair: { question: import('../../shared/contracts.ts').QuestionItem; stimulus?: import('../../shared/contracts.ts').StimulusGroup } | null = null;
        if (sub.sessionId) {
          const snapshots = await repo.getSessionSnapshots(studentId, sub.sessionId);
          const snap = snapshots.find((s) => s.questionId === sub.questionId);
          if (snap) {
            pair = { question: snap.question, stimulus: snap.stimulus };
          }
        }
        if (!pair) {
          pair = await repo.getQuestionWithStimulus(sub.questionId);
        }
        if (!pair) {
          res.status(404).json({ error: 'Question not found.' });
          return;
        }
        let evalPromise = ctx.inFlightWritingEvaluations.get(sub.submissionId);
        if (!evalPromise) {
          if (!enforceAiRateLimit(ctx.aiRateLimiter, 'writing_evaluate', studentId, res, 'writing evaluation')) {
            return;
          }
          const metrics = JSON.parse(sub.deterministicMetricsJson) as WritingDeterministicMetrics;
          evalPromise = (async () => {
            const evaluation = await evaluateWritingWithGemini({
              submissionId: sub.submissionId,
              question: pair.question,
              stimulus: pair.stimulus,
              planNotes: sub.planNotes,
              responseText: sub.responseText,
              metrics,
            });
            await repo.saveWritingEvaluation(evaluation, studentId);
            return evaluation;
          })().finally(() => {
            ctx.inFlightWritingEvaluations.delete(sub.submissionId);
            ctx.inFlightWritingOwners.delete(sub.submissionId);
          });
          ctx.inFlightWritingEvaluations.set(sub.submissionId, evalPromise);
          ctx.inFlightWritingOwners.set(sub.submissionId, studentId);
        }
        const evaluation = await evalPromise;
        const updated = await repo.getWritingSubmission(sub.submissionId, studentId);

        // If this writing submission belongs to a benchmark exam, refresh its saved official report
        if (sub.sessionId) {
          try {
            const session = await repo.getSession(sub.sessionId, studentId);
            if (session && session.status === 'submitted' && !session.isSandbox && session.mode === 'benchmark_exam') {
              const { pairs } = await resolveSessionQuestionPairs(repo, session);
              const reviewResults = session.submissionSummary?.reviewResults || (() => {
                const out: Record<string, import('../../shared/contracts.ts').MarkingResult[]> = {};
                const answers = session.checkpoint?.answersByPartId ?? {};
                for (const p of pairs) {
                  out[p.question.questionId] =
                    p.question.formatType === 'WRIT_TYPED_TASK'
                      ? []
                      : gradeSubmission(p.question, answers).results;
                }
                return out;
              })();
              const refreshedReport = buildBenchmarkReportRecord({
                session,
                questions: pairs.map((p) => p.question),
                reviewResults,
                writingReview: [
                  {
                    submissionId: sub.submissionId,
                    evaluations: updated?.evaluations || [evaluation],
                  },
                ],
                // Clear stale pre-grading AI narrative so it regenerates with the graded essay
                existingAiCoaching: undefined,
              });
              await repo.saveBenchmarkReport(refreshedReport);
            }
          } catch (reportErr) {
            console.error('Failed to update benchmark report after writing grade:', reportErr);
          }
        }

        res.json({ evaluation, evaluations: updated?.evaluations || [evaluation] });
      } catch (err) {
        console.error('POST /api/student/writing/:submissionId/evaluate error:', err);
        if (err instanceof NotFoundError) {
          res.status(404).json({ error: err.message });
          return;
        }
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
      await ctx.ensureSeeded();
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
      await ctx.ensureSeeded();
      const studentId = req.auth!.studentId;
      const [configData, skillStates, sessions, writingSubmissions, savedReports] = await Promise.all([
        repo.getActiveConfig(),
        repo.getSkillStates(studentId),
        repo.listSessions(200, studentId, false, { omitSubmissionSummary: true }),
        repo.listWritingSubmissions(studentId),
        repo.listBenchmarkReports(studentId, 20),
      ]);

      const savedIds = new Set(savedReports.map((r) => r.sessionId));
      const missingBenchmarks = sessions.filter(
        (s) => s.mode === 'benchmark_exam' && s.status === 'submitted' && !s.isSandbox && !savedIds.has(s.sessionId)
      );
      const benchmarkReports = [...savedReports];
      for (const s of missingBenchmarks) {
        const created = await ensureBenchmarkReportForSession(repo, s.sessionId, studentId);
        if (created) benchmarkReports.push(created);
      }
      benchmarkReports.sort((a, b) => Date.parse(b.completedAtIso) - Date.parse(a.completedAtIso));

      const stats = await repo.getStudentProgressStats({
        studentId,
        writingSubmissionsCount: writingSubmissions.length,
        writingEvaluatedCount: writingSubmissions.filter((w) => w.evaluations.length > 0).length,
        policyVersion: configData.config.masteryPolicy?.policyVersion,
      });

      // Prompt titles let the essay comparison name what each piece answered.
      const writingQuestionIds = Array.from(new Set(writingSubmissions.map((w) => w.questionId)));
      const writingQuestions = writingQuestionIds.length > 0 ? await repo.listQuestionsByIds(writingQuestionIds) : [];
      const writingStimulusIds = Array.from(
        new Set(writingQuestions.map((q) => q.stimulusId).filter((id): id is string => Boolean(id)))
      );
      const writingStimuli = writingStimulusIds.length > 0 ? await repo.listStimuliByIds(writingStimulusIds) : {};
      const promptTitleByQuestionId = new Map<string, string>();
      for (const q of writingQuestions) {
        const title = (q.stimulusId ? writingStimuli[q.stimulusId]?.title : undefined)?.trim();
        if (title) promptTitleByQuestionId.set(q.questionId, title);
      }

      const skills = SKILLS_TAXONOMY.map((def) => ({
        ...def,
        state: skillStates[def.skillId] || null,
      }));

      res.json({
        sectionStats: stats.sectionStats,
        skills,
        sessions: sessions.filter((s) => !s.isSandbox),
        writingSubmissions: writingSubmissions.map((w) => ({
          ...w,
          promptTitle: promptTitleByQuestionId.get(w.questionId),
        })),
        totalAttempts: stats.totalAttempts,
        masterySummary: stats.masterySummary,
        benchmarkReports,
      });
    } catch (err) {
      console.error('GET /api/student/progress error:', err);
      res.status(500).json({ error: 'Failed to load progress data.' });
    }
  });

  // Admin-only learner progress export (CSV/JSON) — restricted to prevent question scraping via student accounts
  app.get(['/api/admin/export/progress', '/api/student/export'], requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ctx.ensureSeeded();
      const requestedId = typeof req.query.studentId === 'string' ? req.query.studentId.trim() : '';
      const studentId = requestedId && requestedId !== 'none' ? requestedId : req.auth!.studentId;
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
      console.error('GET /api/admin/export/progress error:', err);
      res.status(500).json({ error: 'Failed to export progress.' });
    }
  });
}
