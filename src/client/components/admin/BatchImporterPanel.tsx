import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react';
import {
  Archive,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FolderOpen,
  Play,
  Search,
  Upload,
} from 'lucide-react';
import { api, type BatchDirectorySummary } from '../../api';
import { useI18n } from '../../i18n';
import type { BankImportManifest } from '../../../shared/contracts';

interface BatchImporterPanelProps {
  onOpenBatchInBank: (batchId: string) => void;
  onOpenSession: (sessionId: string) => void;
  onNotice: (msg: string) => void;
  onError: (msg: string) => void;
  onDataMutated?: () => void;
  monitoredStudentId?: string | null;
}

const PAGE_SIZE = 10;

export function BatchImporterPanel({
  onOpenBatchInBank,
  onOpenSession,
  onNotice,
  onError,
  onDataMutated,
  monitoredStudentId,
}: BatchImporterPanelProps) {
  const { t, formatDate } = useI18n();
  const [batches, setBatches] = useState<BatchDirectorySummary[]>([]);
  const [loadingBatches, setLoadingBatches] = useState(true);
  const [batchSearch, setBatchSearch] = useState('');
  const [batchFilter, setBatchFilter] = useState<'all' | 'has_unseen' | 'all_done' | 'has_paused'>('all');
  const [page, setPage] = useState(1);
  const [busyBatchId, setBusyBatchId] = useState<string | null>(null);

  // JSON Manifest Importer
  const [manifestText, setManifestText] = useState('');
  const [dryRunReport, setDryRunReport] = useState<{
    valid: boolean;
    batchLabel: string;
    stimuliCount: number;
    questionsCount: number;
    newQuestions: number;
    unchangedQuestions: number;
    versionBumpedQuestions: number;
    errors: string[];
    warnings: string[];
  } | null>(null);
  const [validating, setValidating] = useState(false);
  const [committing, setCommitting] = useState(false);

  const loadBatches = useCallback(async () => {
    setLoadingBatches(true);
    try {
      const res = await api.getAdminBatchSummaries(monitoredStudentId);
      setBatches(res.batchSummaries || []);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Unable to load batches.');
    } finally {
      setLoadingBatches(false);
    }
  }, [onError, monitoredStudentId]);

  useEffect(() => {
    void loadBatches();
  }, [loadBatches]);

  const filteredBatches = useMemo(() => {
    const q = batchSearch.trim().toLowerCase();
    return batches.filter((b) => {
      if (q && !b.batchLabel.toLowerCase().includes(q) && !b.batchId.toLowerCase().includes(q)) {
        return false;
      }
      if (batchFilter === 'has_unseen' && b.unseen === 0) return false;
      if (batchFilter === 'all_done' && !(b.total > 0 && b.unseen === 0 && b.done >= b.live)) {
        return false;
      }
      if (batchFilter === 'has_paused' && b.paused === 0) return false;
      return true;
    });
  }, [batches, batchSearch, batchFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredBatches.length / PAGE_SIZE));
  const pagedBatches = filteredBatches.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const handleBulkBatchStatus = async (batch: BatchDirectorySummary, status: 'active' | 'retired') => {
    if (batch.questionIds.length === 0) return;
    setBusyBatchId(batch.batchId);
    try {
      await api.bulkUpdateQuestionStatus(batch.questionIds, status);
      onNotice(
        status === 'active'
          ? `Moved all ${batch.questionIds.length} questions in "${batch.batchLabel}" into the active pool.`
          : `Archived all ${batch.questionIds.length} questions in "${batch.batchLabel}".`
      );
      await loadBatches();
      onDataMutated?.();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Batch update failed.');
    } finally {
      setBusyBatchId(null);
    }
  };

  const handlePracticeBatch = async (batch: BatchDirectorySummary) => {
    setBusyBatchId(batch.batchId);
    try {
      const res = await api.createCalibrationSession({
        batchId: batch.batchId,
        qcStatus: 'active',
        limit: Math.min(40, Math.max(1, batch.total)),
        isSandbox: true,
      });
      onOpenSession(res.sessionId);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Unable to start practice on this batch.');
    } finally {
      setBusyBatchId(null);
    }
  };

  const handleFileUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setManifestText(String(reader.result || ''));
      setDryRunReport(null);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleLoadStarter = async () => {
    try {
      const res = await api.getImportSchema();
      setManifestText(JSON.stringify(res.starterExample, null, 2));
      setDryRunReport(null);
      onNotice('Loaded starter Question Bank manifest template.');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Unable to load starter example.');
    }
  };

  const handleCopySchema = async () => {
    try {
      const res = await api.getImportSchema();
      await navigator.clipboard.writeText(JSON.stringify(res.schema, null, 2));
      onNotice('Copied Question Bank JSON schema to clipboard.');
    } catch {
      onError('Unable to copy schema to clipboard.');
    }
  };

  const handleDryRun = async () => {
    setValidating(true);
    try {
      const parsed = JSON.parse(manifestText);
      const res = await api.dryRunManifest(parsed);
      setDryRunReport(res.report);
      if (res.report.valid) {
        onNotice(`Dry run passed for "${res.report.batchLabel}" (${res.report.questionsCount} questions).`);
      } else {
        onError(`Validation found ${res.report.errors.length} error(s).`);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Invalid JSON manifest.');
    } finally {
      setValidating(false);
    }
  };

  const handleCommit = async () => {
    setCommitting(true);
    try {
      const parsed = JSON.parse(manifestText) as BankImportManifest;
      const res = await api.commitManifest(parsed);
      onNotice(
        `Imported ${res.result.imported} new, ${res.result.versionBumped} updated, ${res.result.skipped} unchanged.`
      );
      setDryRunReport(null);
      setManifestText('');
      await loadBatches();
      onDataMutated?.();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Import failed.');
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Scalable Batch Directory (handles 100+ batches cleanly) */}
      <section className="rounded-[16px] bg-white border border-[#E5DFD5] p-5 space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-sans-display font-semibold text-[17px] text-[#113C36]">
              {t('batch.dirTitle', { count: batches.length })}
            </h2>
            <p className="text-xs text-[#4A5955] mt-0.5">
              {t('batch.dirDesc')}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 max-w-full">
            <div className="relative min-w-0">
              <Search className="w-3.5 h-3.5 text-[#78756E] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="search"
                aria-label={t('batch.searchPlaceholder')}
                value={batchSearch}
                onChange={(e) => {
                  setBatchSearch(e.target.value);
                  setPage(1);
                }}
                placeholder={t('batch.searchPlaceholder')}
                className="pl-8 pr-3 py-1.5 rounded-[10px] border border-[#CFC6B9] bg-[#FAF8F5] text-xs text-[#113C36] w-56 max-w-full focus:bg-white focus:outline-none focus:border-[#113C36]"
              />
            </div>

            <div className="flex flex-wrap items-center gap-1 text-xs">
              {(
                [
                  ['all', t('batch.filterAll')],
                  ['has_unseen', t('batch.filterHasUnseen')],
                  ['all_done', t('batch.filterAllDone')],
                  ['has_paused', t('batch.filterHasPaused')],
                ] as const
              ).map(([val, label]) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => {
                    setBatchFilter(val);
                    setPage(1);
                  }}
                  className={`px-2.5 py-1 rounded-full font-medium cursor-pointer whitespace-nowrap transition-colors ${
                    batchFilter === val
                      ? 'bg-[#113C36] text-white'
                      : 'bg-[#F3EFE8] text-[#4A5955] hover:bg-[#E8E2D7]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="border-t border-b border-[#E5DFD5] divide-y divide-[#E5DFD5]">
          {loadingBatches ? (
            <div className="py-8 text-center text-xs text-[#78756E]">{t('batch.loading')}</div>
          ) : pagedBatches.length === 0 ? (
            <div className="py-8 text-center text-xs text-[#78756E]">
              {t('batch.empty')}
            </div>
          ) : (
            pagedBatches.map((batch) => {
              const donePct = batch.total > 0 ? Math.round((batch.done / batch.total) * 100) : 0;
              const unseenPct = batch.total > 0 ? Math.round((batch.unseen / batch.total) * 100) : 0;
              const isBusy = busyBatchId === batch.batchId;

              return (
                <div
                  key={batch.batchId}
                  className="py-3.5 flex flex-col lg:flex-row lg:items-center justify-between gap-3"
                >
                  <div className="space-y-1.5 min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                      <span className="font-sans-display font-semibold text-sm text-[#113C36] break-words">
                        {batch.batchLabel}
                      </span>
                      <span className="font-mono-code text-[11px] text-[#78756E] break-all">
                        {batch.batchId}
                      </span>
                      <span className="text-[11px] text-[#78756E] tabular-nums whitespace-nowrap">
                        {formatDate(batch.createdAtIso)}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#4A5955] tabular-nums">
                      <span>{t('batch.totalCount', { count: batch.total })}</span>
                      <span className="text-[#113C36] font-medium">{t('batch.inPoolCount', { count: batch.live })}</span>
                      <span>{t('batch.unseenCount', { count: batch.unseen })}</span>
                      <span className="text-[#1F7A4C]">{t('batch.doneCount', { count: batch.done })}</span>
                      {batch.paused > 0 && <span className="text-[#A35116]">{t('batch.pausedCount', { count: batch.paused })}</span>}
                      {batch.archived > 0 && <span className="text-[#78756E]">{t('batch.archivedCount', { count: batch.archived })}</span>}
                    </div>

                    <div className="h-1.5 w-full max-w-md rounded-full bg-[#F3EFE8] overflow-hidden flex">
                      <div
                        className="bg-[#1F7A4C] h-full"
                        style={{ width: `${donePct}%` }}
                        title={`${donePct}% mastered`}
                      />
                      <div
                        className="bg-[#113C36]/30 h-full"
                        style={{ width: `${unseenPct}%` }}
                        title={`${unseenPct}% unseen`}
                      />
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => onOpenBatchInBank(batch.batchId)}
                      className="px-3 py-1.5 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-xs font-sans-display font-semibold text-[#113C36] inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
                    >
                      <FolderOpen className="w-3.5 h-3.5" />
                      <span>{t('batch.openInBank')}</span>
                    </button>
                    <button
                      type="button"
                      disabled={isBusy || batch.live === 0}
                      onClick={() => handlePracticeBatch(batch)}
                      className="px-3 py-1.5 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-xs font-sans-display font-semibold inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap disabled:opacity-40"
                    >
                      <Play className="w-3 h-3 fill-current" />
                      <span>{t('batch.practice')}</span>
                    </button>
                    {batch.paused > 0 || batch.archived > 0 ? (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => handleBulkBatchStatus(batch, 'active')}
                        className="px-2.5 py-1.5 rounded-[10px] border border-[#C5DDD1] bg-[#E5F0EA] text-[#113C36] text-xs font-sans-display font-semibold inline-flex items-center gap-1 cursor-pointer whitespace-nowrap disabled:opacity-40"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>{t('batch.activateAll')}</span>
                      </button>
                    ) : null}
                    {batch.live > 0 ? (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => handleBulkBatchStatus(batch, 'retired')}
                        className="px-2.5 py-1.5 rounded-[10px] border border-[#E5DFD5] bg-[#FAF8F5] text-[#78756E] hover:text-[#113C36] text-xs font-sans-display font-semibold inline-flex items-center gap-1 cursor-pointer whitespace-nowrap disabled:opacity-40"
                      >
                        <Archive className="w-3.5 h-3.5" />
                        <span>{t('batch.archiveAll')}</span>
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {totalPages > 1 && (
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#78756E]">
            <span className="tabular-nums">
              {t('batch.showingRange', {
                start: (page - 1) * PAGE_SIZE + 1,
                end: Math.min(page * PAGE_SIZE, filteredBatches.length),
                total: filteredBatches.length,
              })}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="px-2.5 py-1 rounded-[8px] border border-[#CFC6B9] bg-white text-[#4A5955] disabled:opacity-40 inline-flex items-center gap-1 cursor-pointer"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                <span>{t('session.previous')}</span>
              </button>
              <span className="tabular-nums px-1.5">
                {t('batch.pageOf', { page, total: totalPages })}
              </span>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="px-2.5 py-1 rounded-[8px] border border-[#CFC6B9] bg-white text-[#4A5955] disabled:opacity-40 inline-flex items-center gap-1 cursor-pointer"
              >
                <span>{t('session.next')}</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </section>

      {/* JSON Manifest Importer */}
      <section className="rounded-[16px] bg-white border border-[#E5DFD5] p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-sans-display font-semibold text-[16px] text-[#113C36]">
              {t('batch.importTitle')}
            </h3>
            <p className="text-xs text-[#4A5955] mt-0.5">
              {t('batch.importDesc')}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="px-3 py-1.5 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-xs font-sans-display font-semibold text-[#113C36] inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap">
              <Upload className="w-3.5 h-3.5" />
              <span>{t('batch.uploadJson')}</span>
              <input type="file" accept=".json,application/json" className="hidden" onChange={handleFileUpload} />
            </label>
            <button
              type="button"
              onClick={handleLoadStarter}
              className="px-3 py-1.5 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-xs font-sans-display font-semibold text-[#4A5955] cursor-pointer whitespace-nowrap"
            >
              {t('batch.loadExample')}
            </button>
            <button
              type="button"
              onClick={handleCopySchema}
              className="px-3 py-1.5 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-xs font-sans-display font-semibold text-[#4A5955] inline-flex items-center gap-1 cursor-pointer whitespace-nowrap"
            >
              <Copy className="w-3.5 h-3.5" />
              <span>{t('batch.copySchema')}</span>
            </button>
            <a
              href="/docs/selective-lab-question-skill.md"
              download="SKILL.md"
              className="px-3 py-1.5 rounded-[10px] border border-[#C5DDD1] bg-[#E5F0EA] hover:bg-[#113C36] hover:text-white text-xs font-sans-display font-semibold text-[#113C36] inline-flex items-center gap-1.5 transition-colors whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{t('batch.downloadSkill')}</span>
            </a>
          </div>
        </div>

        <textarea
          aria-label={t('batch.importTitle')}
          rows={10}
          value={manifestText}
          onChange={(e) => {
            setManifestText(e.target.value);
            setDryRunReport(null);
          }}
          placeholder='{"batchLabel": "April Fresh Drop", "stimuli": [], "questions": [...]}'
          className="w-full p-3.5 rounded-[12px] border border-[#CFC6B9] bg-[#FAF8F5] font-mono-code text-xs text-[#113C36] focus:bg-white focus:outline-none focus:border-[#113C36]"
        />

        <div className="flex flex-wrap items-center justify-end gap-2.5">
          <button
            type="button"
            disabled={!manifestText.trim() || validating}
            onClick={handleDryRun}
            className="px-4 py-2 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-xs font-sans-display font-semibold text-[#113C36] cursor-pointer disabled:opacity-40"
          >
            {validating ? t('batch.validating') : t('batch.dryRun')}
          </button>
          <button
            type="button"
            disabled={!manifestText.trim() || committing || (dryRunReport !== null && !dryRunReport.valid)}
            onClick={handleCommit}
            className="px-5 py-2 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-xs font-sans-display font-semibold cursor-pointer disabled:opacity-40"
          >
            {committing ? t('batch.importing') : t('batch.commitImport')}
          </button>
        </div>

        {dryRunReport && (
          <div
            className={`p-4 rounded-[12px] border text-xs space-y-2 ${
              dryRunReport.valid
                ? 'bg-[#E5F0EA] border-[#C5DDD1] text-[#113C36]'
                : 'bg-[#FDECEB] border-[#B83A28]/25 text-[#B83A28]'
            }`}
          >
            <div className="font-sans-display font-semibold break-words">
              {dryRunReport.valid ? t('batch.manifestValid') : t('batch.manifestInvalid')} — {dryRunReport.batchLabel}
            </div>
            <div className="tabular-nums">
              {t('batch.dryRunSummary', {
                newQ: dryRunReport.newQuestions,
                bumped: dryRunReport.versionBumpedQuestions,
                unchanged: dryRunReport.unchangedQuestions,
                stimuli: dryRunReport.stimuliCount,
              })}
            </div>
            {dryRunReport.errors.length > 0 && (
              <ul className="list-disc pl-4 space-y-1">
                {dryRunReport.errors.slice(0, 10).map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            )}
            {dryRunReport.warnings.length > 0 && (
              <ul className="list-disc pl-4 space-y-1 text-[#A35116]">
                {dryRunReport.warnings.slice(0, 6).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
