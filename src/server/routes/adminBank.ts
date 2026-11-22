import crypto from 'node:crypto';
import type { Express } from 'express';
import { requireAdmin, type AuthenticatedRequest } from '../auth.ts';
import { validateAndDryRunManifest } from '../manifestValidator.ts';
import { buildMediaMigrationManifest, prepareMediaUpload } from '../mediaService.ts';
import {
  NotFoundError,
  type QuestionQueryParams,
  type QuestionSelectionItem,
} from '../storage/repository.ts';
import type { BankImportManifest, QuestionItem, SessionRecord, VisualSpec } from '../../shared/contracts.ts';
import { selectAdminCalibrationQuestions } from '../../shared/engine.ts';
import { selectLatestByFamily } from '../storage/repositoryUtils.ts';
import type { AppContext } from '../context.ts';
import { UPLOADS_DIR } from '../paths.ts';
import { buildQuestionSnapshots, resolveSessionQuestionPairs } from '../sessionLifecycle.ts';

function extractManifestLookupRefs(raw: unknown): {
  familyIds: string[];
  questionIds: string[];
  stimulusIds: string[];
} {
  const familyIds = new Set<string>();
  const questionIds = new Set<string>();
  const stimulusIds = new Set<string>();
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const m = raw as { stimuli?: unknown[]; questions?: unknown[] };
    if (Array.isArray(m.stimuli)) {
      for (const s of m.stimuli) {
        const sid = (s as { stimulusId?: unknown })?.stimulusId;
        if (typeof sid === 'string' && sid.trim()) stimulusIds.add(sid);
      }
    }
    if (Array.isArray(m.questions)) {
      for (const q of m.questions) {
        const obj = q as { questionId?: unknown; questionFamilyId?: unknown; stimulusId?: unknown };
        if (typeof obj?.questionId === 'string' && obj.questionId.trim()) {
          questionIds.add(obj.questionId);
          const fam =
            typeof obj.questionFamilyId === 'string' && obj.questionFamilyId.trim()
              ? obj.questionFamilyId
              : obj.questionId.replace(/_v\d+$/, '');
          familyIds.add(fam);
        } else if (typeof obj?.questionFamilyId === 'string' && obj.questionFamilyId.trim()) {
          familyIds.add(obj.questionFamilyId);
        }
        if (typeof obj?.stimulusId === 'string' && obj.stimulusId.trim()) {
          stimulusIds.add(obj.stimulusId);
        }
      }
    }
  }
  return {
    familyIds: Array.from(familyIds),
    questionIds: Array.from(questionIds),
    stimulusIds: Array.from(stimulusIds),
  };
}

/** Admin question bank, media, calibration and import (/api/admin/*). */
export function registerAdminBankRoutes(app: Express, ctx: AppContext): void {
  const { repo } = ctx;
  app.get('/api/admin/status', requireAdmin, async (_req, res) => {
    try {
      await ctx.ensureSeeded();
      const [summary, configData] = await Promise.all([
        repo.getAdminBankStatusSummary(),
        repo.getActiveConfig(),
      ]);

      res.json({
        backendName: repo.backendName,
        isEphemeralPreview: repo.backendName === 'memory_preview',
        totalQuestions: summary.totalQuestions,
        byPool: summary.byPool,
        bySection: summary.bySection,
        byQcStatus: summary.byQcStatus,
        holdoutIsolationOk: summary.leakedCount === 0,
        holdoutQuestionCount: summary.holdoutQuestionCount,
        leakedCount: summary.leakedCount,
        openFlagsCount: summary.openFlagsCount,
        activeConfigVersion: configData.versionNumber,
        batchesCount: summary.batchesCount,
      });
    } catch (err) {
      console.error('GET /api/admin/status error:', err);
      res.status(500).json({ error: 'Failed to load admin status.' });
    }
  });

  app.get('/api/admin/questions', requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ctx.ensureSeeded();
      const { config } = await repo.getActiveConfig();
      const requestedStudentId = req.query.studentId ? String(req.query.studentId).trim() : undefined;
      const monitoredStudentId =
        requestedStudentId === 'none'
          ? null
          : requestedStudentId || (await ctx.resolveDefaultMonitoredStudentId(config));

      const dailyLimits = config.sessionDefaults.dailyQuestionLimitBySection;
      const dailyQuestionTarget = Math.max(1, (dailyLimits.READ || 0) + (dailyLimits.MATH || 0) + (dailyLimits.THINK || 0));
      const result = await repo.listQuestionsPaginated({
        search: req.query.search ? String(req.query.search) : undefined,
        section: req.query.section ? String(req.query.section) : undefined,
        poolType: req.query.poolType ? String(req.query.poolType) : undefined,
        qcStatus: req.query.qcStatus ? String(req.query.qcStatus) : undefined,
        poolStatus: req.query.poolStatus as QuestionQueryParams['poolStatus'],
        completionStatus: req.query.completionStatus as QuestionQueryParams['completionStatus'],
        monitoredStudentId,
        dailyQuestionTarget,
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
        includeSummary: req.query.summary !== '0',
      });
      // Import batch records are not used by the bank UI and carry every question id; omit them.
      const { batches: _batches, ...payload } = result;
      res.json({ ...payload, monitoredStudentId });
    } catch (err) {
      console.error('GET /api/admin/questions error:', err);
      res.status(500).json({ error: 'Failed to load admin questions.' });
    }
  });

  app.get('/api/admin/questions/:id/versions', requireAdmin, async (req, res) => {
    try {
      await ctx.ensureSeeded();
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
      await ctx.ensureSeeded();
      const batches = await repo.listImportBatches();
      res.json({ batches });
    } catch (err) {
      console.error('GET /api/admin/batches error:', err);
      res.status(500).json({ error: 'Failed to load import batches.' });
    }
  });

  // Lightweight batch directory for the Batches tab (SQL-aggregated, no question bodies).
  app.get('/api/admin/batches/summary', requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ctx.ensureSeeded();
      const { config } = await repo.getActiveConfig();
      const requestedStudentId = req.query.studentId ? String(req.query.studentId).trim() : undefined;
      const monitoredStudentId =
        requestedStudentId === 'none'
          ? null
          : requestedStudentId || (await ctx.resolveDefaultMonitoredStudentId(config));
      const batchSummaries = await repo.getBatchSummaries(monitoredStudentId);
      res.json({ batchSummaries, monitoredStudentId });
    } catch (err) {
      console.error('GET /api/admin/batches/summary error:', err);
      res.status(500).json({ error: 'Failed to load batch summaries.' });
    }
  });

  app.post('/api/admin/questions/bulk-status', requireAdmin, async (req, res) => {
    try {
      await ctx.ensureSeeded();
      const rawIds = Array.isArray(req.body?.questionIds) ? req.body.questionIds : [];
      const ids = rawIds.filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0);
      const qcStatus = req.body?.qcStatus as QuestionItem['qcStatus'];
      const allowed = new Set(['draft', 'verified', 'active', 'quarantined', 'retired']);
      if (!allowed.has(qcStatus)) {
        res.status(400).json({ error: 'Invalid qcStatus.' });
        return;
      }
      if (ids.length === 0) {
        res.json({ ok: true, updatedCount: 0 });
        return;
      }
      const updatedCount = await repo.bulkUpdateQuestionStatus(ids, qcStatus);
      res.json({ ok: true, updatedCount });
    } catch (err) {
      console.error('POST /api/admin/questions/bulk-status error:', err);
      res.status(500).json({ error: 'Failed to update question QC statuses.' });
    }
  });

  app.patch('/api/admin/questions/:id/status', requireAdmin, async (req, res) => {
    try {
      await ctx.ensureSeeded();
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
      await ctx.ensureSeeded();
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
      await ctx.ensureSeeded();
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
      await ctx.ensureSeeded();
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
      await ctx.ensureSeeded();
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
      await ctx.ensureSeeded();
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
        const fetched = await repo.listQuestionsByIds(explicitIds);
        const byId = new Map(fetched.map((q) => [q.questionId, q]));
        const missingIds = explicitIds.filter((id) => !byId.has(id));
        if (missingIds.length > 0) {
          res.status(400).json({
            error: `Unknown questionIds in calibration request: ${missingIds.join(', ')}`,
          });
          return;
        }
        selected = explicitIds.map((id) => byId.get(id)!);
      } else {
        const candidates = await repo.listSelectionQuestions({
          section: req.body?.section || undefined,
          poolType: req.body?.poolType || undefined,
          qcStatus: req.body?.qcStatus || undefined,
          batchId: req.body?.batchId || undefined,
          batchTag: req.body?.batch || undefined,
          includeHistorical: Boolean(req.body?.includeHistorical),
        });
        const pickedMeta: QuestionSelectionItem[] = selectAdminCalibrationQuestions({
          questions: candidates,
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
        if (pickedMeta.length > 0) {
          const fetched = await repo.listQuestionsByIds(pickedMeta.map((q) => q.questionId));
          const byId = new Map(fetched.map((q) => [q.questionId, q]));
          selected = pickedMeta.map((q) => byId.get(q.questionId)).filter((q): q is QuestionItem => Boolean(q));
        }
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
      await ctx.ensureSeeded();
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
      await ctx.ensureSeeded();
      const { familyIds, questionIds, stimulusIds } = extractManifestLookupRefs(req.body?.manifest);
      const [existing, existingStimuli] = await Promise.all([
        repo.listQuestionsByFamilies(familyIds, questionIds),
        repo.listStimuliByIds(stimulusIds),
      ]);
      const { report } = validateAndDryRunManifest(req.body?.manifest, existing, existingStimuli);
      res.json({ report });
    } catch (err) {
      console.error('POST /api/admin/import/dry-run error:', err);
      res.status(500).json({ error: 'Dry-run validation failed.' });
    }
  });

  app.post('/api/admin/import/commit', requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await ctx.ensureSeeded();
      const { familyIds, questionIds, stimulusIds } = extractManifestLookupRefs(req.body?.manifest);
      const [existing, existingStimuli] = await Promise.all([
        repo.listQuestionsByFamilies(familyIds, questionIds),
        repo.listStimuliByIds(stimulusIds),
      ]);
      const { manifest, report } = validateAndDryRunManifest(req.body?.manifest, existing, existingStimuli);
      if (!manifest || !report.valid) {
        res.status(400).json({ error: 'Manifest failed validation.', report });
        return;
      }
      const importedBy = req.auth?.email || req.auth?.studentId || 'admin';
      const result = await repo.importManifest(manifest, importedBy);
      const committedFamilies = manifest.questions.map((q) => q.questionFamilyId);
      const committedQuestions = selectLatestByFamily(await repo.listQuestionsByFamilies(committedFamilies));
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
}
