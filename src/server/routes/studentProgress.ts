import crypto from 'node:crypto';
import type { Express } from 'express';
import { requireStudentOrAdmin, type AuthenticatedRequest } from '../auth.ts';
import { GeminiServiceError } from '../geminiClient.ts';
import { evaluateWritingWithGemini } from '../geminiWriting.ts';
import type { QuestionFlagRecord, WritingDeterministicMetrics } from '../../shared/contracts.ts';
import { SKILLS_TAXONOMY } from '../../shared/skills.ts';
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

        const pair = await repo.getQuestionWithStimulus(sub.questionId);
        if (!pair) {
          res.status(404).json({ error: 'Question not found.' });
          return;
        }
        let evalPromise = ctx.inFlightWritingEvaluations.get(sub.submissionId);
        if (!evalPromise) {
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
          });
          ctx.inFlightWritingEvaluations.set(sub.submissionId, evalPromise);
        }
        const evaluation = await evalPromise;
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
      const [configData, skillStates, sessions, writingSubmissions] = await Promise.all([
        repo.getActiveConfig(),
        repo.getSkillStates(studentId),
        repo.listSessions(200, studentId, false, { omitSubmissionSummary: true }),
        repo.listWritingSubmissions(studentId),
      ]);

      const stats = await repo.getStudentProgressStats({
        studentId,
        writingSubmissionsCount: writingSubmissions.length,
        writingEvaluatedCount: writingSubmissions.filter((w) => w.evaluations.length > 0).length,
        policyVersion: configData.config.masteryPolicy?.policyVersion,
      });

      const skills = SKILLS_TAXONOMY.map((def) => ({
        ...def,
        state: skillStates[def.skillId] || null,
      }));

      res.json({
        sectionStats: stats.sectionStats,
        skills,
        sessions: sessions.filter((s) => !s.isSandbox),
        writingSubmissions,
        totalAttempts: stats.totalAttempts,
        masterySummary: stats.masterySummary,
      });
    } catch (err) {
      console.error('GET /api/student/progress error:', err);
      res.status(500).json({ error: 'Failed to load progress data.' });
    }
  });

  app.get('/api/student/export', requireStudentOrAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ctx.ensureSeeded();
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
}
