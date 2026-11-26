import type { Express } from 'express';
import { requireAdmin, requireStudentOrAdmin, type AuthenticatedRequest } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { generateBenchmarkAiCoaching } from '../geminiBenchmarkCoach.ts';
import { enforceAiRateLimit } from '../rateLimit.ts';
import { computeBenchmarkLockStatus, ensureBenchmarkReportForSession } from '../sessionLifecycle.ts';

/** Dedicated NSW Benchmark Exams & Saved Reports API (/api/student/benchmarks/*). */
export function registerBenchmarkRoutes(app: Express, ctx: AppContext): void {
  const { repo } = ctx;

  app.get('/api/student/benchmarks', requireStudentOrAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ctx.ensureSeeded();
      const studentId = req.auth!.studentId;
      const [bankSummary, savedReports, recentSessions, configData, learnerPrefs] = await Promise.all([
        repo.getStudentDashboardBankSummary(studentId, false),
        repo.listBenchmarkReports(studentId, 50),
        repo.listSessions(50, studentId, false, { omitSubmissionSummary: true }),
        repo.getActiveConfig(),
        repo.getLearnerPreferences(studentId),
      ]);

      // Backfill any submitted benchmark_exam sessions that pre-date the benchmark_reports table
      const savedIds = new Set(savedReports.map((r) => r.sessionId));
      const missingBenchmarks = recentSessions.filter(
        (s) => s.mode === 'benchmark_exam' && s.status === 'submitted' && !s.isSandbox && !savedIds.has(s.sessionId)
      );
      const allReports = [...savedReports];
      for (const s of missingBenchmarks) {
        const created = await ensureBenchmarkReportForSession(repo, s.sessionId, studentId);
        if (created) allReports.push(created);
      }
      allReports.sort((a, b) => Date.parse(b.completedAtIso) - Date.parse(a.completedAtIso));

      const benchmarkLock = await computeBenchmarkLockStatus({
        repo,
        studentId,
        config: configData.config,
        learnerPrefs,
        reports: allReports,
      });

      res.json({
        benchmarkBatches: bankSummary.benchmarkBatches,
        reports: allReports,
        benchmarkLock,
      });
    } catch (err) {
      console.error('GET /api/student/benchmarks error:', err);
      res.status(500).json({ error: 'Failed to load benchmark hub.' });
    }
  });

  app.post('/api/admin/benchmarks/unlock', requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ctx.ensureSeeded();
      const requestedId = typeof req.body?.studentId === 'string' ? req.body.studentId.trim() : '';
      const targetStudentId = requestedId && requestedId !== 'none' ? requestedId : req.auth!.studentId;
      const unlock = req.body?.unlock !== false;
      const [configData, existing] = await Promise.all([
        repo.getActiveConfig(),
        repo.getLearnerPreferences(targetStudentId),
      ]);
      const saved = await repo.saveLearnerPreferences(targetStudentId, {
        ...(existing || {}),
        benchmarkUnlockOverrideAtIso: unlock ? new Date().toISOString() : null,
        updatedBy: 'admin',
      });
      const benchmarkLock = await computeBenchmarkLockStatus({
        repo,
        studentId: targetStudentId,
        config: configData.config,
        learnerPrefs: saved,
      });
      res.json({ ok: true, studentId: targetStudentId, benchmarkLock });
    } catch (err) {
      console.error('POST /api/admin/benchmarks/unlock error:', err);
      res.status(500).json({ error: 'Unable to update benchmark unlock override.' });
    }
  });

  app.get('/api/student/benchmarks/:sessionId', requireStudentOrAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ctx.ensureSeeded();
      const studentId = req.auth!.studentId;
      const report = await ensureBenchmarkReportForSession(repo, req.params.sessionId, studentId);
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
      const report = await ensureBenchmarkReportForSession(repo, req.params.sessionId, studentId);
      if (!report) {
        res.status(404).json({ error: 'Benchmark report not found.' });
        return;
      }
      const force = Boolean(req.body?.force);
      if (report.aiCoaching && !force) {
        res.json({ report });
        return;
      }
      if (!enforceAiRateLimit(ctx.aiRateLimiter, 'benchmark_analyze', studentId, res, 'benchmark coaching analysis')) {
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
