import type { Express } from 'express';
import { requireStudentOrAdmin, type AuthenticatedRequest } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { buildBenchmarkReportRecord } from '../../shared/nswBenchmark.ts';
import { generateBenchmarkAiCoaching } from '../geminiBenchmarkCoach.ts';
import { resolveSessionQuestionPairs } from '../sessionLifecycle.ts';
import { gradeSubmission } from '../../shared/engine.ts';
import type { MarkingResult } from '../../shared/contracts.ts';

async function ensureReportForSession(
  ctx: AppContext,
  sessionId: string,
  studentId: string
) {
  const { repo } = ctx;
  const existing = await repo.getBenchmarkReport(sessionId, studentId);
  if (existing) return existing;

  const session = await repo.getSession(sessionId, studentId);
  if (!session || session.status !== 'submitted' || session.isSandbox) return null;

  const { pairs } = await resolveSessionQuestionPairs(repo, session);
  let reviewResults: Record<string, MarkingResult[]> = {};
  if (session.submissionSummary?.reviewResults) {
    reviewResults = session.submissionSummary.reviewResults;
  } else {
    const answers = session.checkpoint?.answersByPartId ?? {};
    for (const pair of pairs) {
      if (pair.question.formatType === 'WRIT_TYPED_TASK') {
        reviewResults[pair.question.questionId] = [];
        continue;
      }
      reviewResults[pair.question.questionId] = gradeSubmission(pair.question, answers).results;
    }
  }

  const allSubs = await repo.listWritingSubmissions(studentId);
  const writingReview = allSubs
    .filter((s) => s.sessionId === session.sessionId)
    .map((s) => ({ submissionId: s.submissionId, evaluations: s.evaluations }));

  const built = buildBenchmarkReportRecord({
    session,
    questions: pairs.map((p) => p.question),
    reviewResults,
    writingReview,
  });
  await repo.saveBenchmarkReport(built);
  return built;
}

/** Dedicated NSW Benchmark Exams & Saved Reports API (/api/student/benchmarks/*). */
export function registerBenchmarkRoutes(app: Express, ctx: AppContext): void {
  const { repo } = ctx;

  app.get('/api/student/benchmarks', requireStudentOrAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ctx.ensureSeeded();
      const studentId = req.auth!.studentId;
      const [bankSummary, savedReports, recentSessions] = await Promise.all([
        repo.getStudentDashboardBankSummary(studentId, false),
        repo.listBenchmarkReports(studentId, 50),
        repo.listSessions(50, studentId, false, { omitSubmissionSummary: true }),
      ]);

      // Backfill any submitted benchmark_exam sessions that pre-date the benchmark_reports table
      const savedIds = new Set(savedReports.map((r) => r.sessionId));
      const missingBenchmarks = recentSessions.filter(
        (s) => s.mode === 'benchmark_exam' && s.status === 'submitted' && !s.isSandbox && !savedIds.has(s.sessionId)
      );
      const allReports = [...savedReports];
      for (const s of missingBenchmarks) {
        const created = await ensureReportForSession(ctx, s.sessionId, studentId);
        if (created) allReports.push(created);
      }
      allReports.sort((a, b) => Date.parse(b.completedAtIso) - Date.parse(a.completedAtIso));

      res.json({
        benchmarkBatches: bankSummary.benchmarkBatches,
        reports: allReports,
      });
    } catch (err) {
      console.error('GET /api/student/benchmarks error:', err);
      res.status(500).json({ error: 'Failed to load benchmark hub.' });
    }
  });

  app.get('/api/student/benchmarks/:sessionId', requireStudentOrAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ctx.ensureSeeded();
      const studentId = req.auth!.studentId;
      const report = await ensureReportForSession(ctx, req.params.sessionId, studentId);
      if (!report) {
        res.status(404).json({ error: 'Benchmark report not found.' });
        return;
      }
      res.json({ report });
    } catch (err) {
      console.error('GET /api/student/benchmarks/:sessionId error:', err);
      res.status(500).json({ error: 'Failed to load benchmark report.' });
    }
  });

  app.post('/api/student/benchmarks/:sessionId/analyze', requireStudentOrAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ctx.ensureSeeded();
      const studentId = req.auth!.studentId;
      const report = await ensureReportForSession(ctx, req.params.sessionId, studentId);
      if (!report) {
        res.status(404).json({ error: 'Benchmark report not found.' });
        return;
      }
      const force = Boolean(req.body?.force);
      if (report.aiCoaching && !force) {
        res.json({ report });
        return;
      }
      const coaching = await generateBenchmarkAiCoaching(report);
      const updated = { ...report, aiCoaching: coaching };
      await repo.saveBenchmarkReport(updated);
      res.json({ report: updated });
    } catch (err) {
      console.error('POST /api/student/benchmarks/:sessionId/analyze error:', err);
      res.status(500).json({ error: 'Failed to analyze benchmark report.' });
    }
  });
}
