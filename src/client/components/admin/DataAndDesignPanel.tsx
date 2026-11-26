import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  FileCode2,
  Flag,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import {
  api,
  type ProgressCountsResponse,
  type RuntimeDiagnosticsResponse,
} from '../../api';
import { buildBankQuestionHref } from './adminDeepLink';
import type { QuestionFlagRecord } from '../../../shared/contracts';
import { useI18n } from '../../i18n';

interface DataAndDesignPanelProps {
  /** Opens a flagged question in the Question Bank inspector. */
  onOpenQuestion?: (questionId: string) => void;
  onNotice: (msg: string) => void;
  onError: (msg: string) => void;
  onDataMutated?: () => void;
  monitoredStudentId?: string | null;
  monitoredLearner?: import('../../api').AdminLearnerSummary | null;
}

export function DataAndDesignPanel({
  onOpenQuestion,
  onNotice,
  onError,
  onDataMutated,
  monitoredStudentId,
  monitoredLearner = null,
}: DataAndDesignPanelProps) {
  const { t } = useI18n();
  const [counts, setCounts] = useState<ProgressCountsResponse | null>(null);
  const [loadingCounts, setLoadingCounts] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [resetting, setResetting] = useState(false);

  // Frontend Design Spec (frontend.md)
  const [specText, setSpecText] = useState('');
  // null = not requested yet; the ~10 KB spec is fetched only when an admin opens it.
  const [loadingSpec, setLoadingSpec] = useState<boolean | null>(null);
  const [specExpanded, setSpecExpanded] = useState(false);

  // Flags & Diagnostics
  const [flags, setFlags] = useState<QuestionFlagRecord[]>([]);
  const [diagnostics, setDiagnostics] = useState<RuntimeDiagnosticsResponse | null>(null);
  const [loadingDiag, setLoadingDiag] = useState(false);

  const loadData = async (targetStudentId = monitoredStudentId) => {
    setLoadingCounts(true);
    try {
      const [c, f] = await Promise.all([
        targetStudentId === null
          ? Promise.resolve(null)
          : api.getProgressCounts(targetStudentId || undefined),
        api.getAdminFlags().catch(() => ({ flags: [] })),
      ]);
      setCounts(c);
      setFlags(f.flags || []);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Unable to load study data counts.');
    } finally {
      setLoadingCounts(false);
    }
  };

  const ensureSpec = async (): Promise<string> => {
    if (loadingSpec === false) return specText;
    setLoadingSpec(true);
    try {
      const res = await fetch('/docs/frontend-design.md');
      const txt = res.ok ? await res.text() : '';
      setSpecText(txt);
      return txt;
    } catch {
      setSpecText('');
      return '';
    } finally {
      setLoadingSpec(false);
    }
  };

  useEffect(() => {
    void loadData(monitoredStudentId);
  }, [monitoredStudentId]);

  const handleConfirmReset = async () => {
    if (monitoredStudentId === null) return;
    if (confirmText.trim().toUpperCase() !== 'RESET') return;
    setResetting(true);
    try {
      const res = await api.resetStudentProgress(monitoredStudentId || undefined);
      setConfirmOpen(false);
      setConfirmText('');
      onNotice(
        `Reset complete: cleared ${res.clearedSessions} sessions, ${res.clearedAttempts} attempts, ${res.clearedEvidence} mastery records, and ${res.clearedWriting} writing submissions. Preserved all ${res.preservedQuestionsCount} Question Bank items.`
      );
      await loadData();
      onDataMutated?.();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Progress reset failed.');
    } finally {
      setResetting(false);
    }
  };

  const handleCopySpec = async () => {
    const text = specText || (await ensureSpec());
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      onNotice('Copied frontend.md design constitution to clipboard.');
    } catch {
      onError('Unable to copy frontend.md to clipboard.');
    }
  };

  const handleResolveFlag = async (flagId: string) => {
    try {
      await api.resolveFlag(flagId);
      setFlags((prev) =>
        prev.map((f) => (f.flagId === flagId ? { ...f, status: 'resolved' } : f))
      );
      onNotice('Marked flag as resolved.');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Unable to resolve flag.');
    }
  };

  const handleCheckDiagnostics = async () => {
    setLoadingDiag(true);
    try {
      const res = await api.getAdminDiagnostics();
      setDiagnostics(res);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Diagnostics check failed.');
    } finally {
      setLoadingDiag(false);
    }
  };

  const openFlags = flags.filter((f) => f.status === 'open');
  const learnerName = monitoredLearner
    ? monitoredLearner.displayName || monitoredLearner.email || monitoredLearner.uid
    : null;

  return (
    <div className="space-y-6">
      <p className="rounded-[12px] bg-[#FAF8F5] border border-[#E5DFD5] px-4 py-2.5 text-xs text-[#4A5955]">
        {t('admin.dataScopeHint')}
      </p>

      {/* 1. Data Controls — Reset Study Progress to Zero */}
      <section className="rounded-[16px] bg-white border border-[#E5DFD5] p-6 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1 min-w-0">
            <h2 className="font-sans-display font-semibold text-[18px] text-[#113C36]">
              {learnerName ? t('data.titleForLearner', { name: learnerName }) : t('data.title')}
            </h2>
            <p className="text-xs text-[#4A5955] max-w-2xl leading-relaxed">
              {t('data.desc')}
            </p>
          </div>
          {counts && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#E5F0EA] text-[#113C36] text-xs font-medium tabular-nums whitespace-nowrap">
              <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
              <span>{t('data.bankPreserved', { count: counts.bankQuestionsCount })}</span>
            </span>
          )}
        </div>

        {monitoredStudentId === null ? (
          <div className="rounded-[12px] bg-[#FAF8F5] border border-[#E5DFD5] px-4 py-3 text-xs text-[#4A5955] leading-relaxed">
            {t('data.catalogEmptyCallout')}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="rounded-[12px] bg-[#FAF8F5] border border-[#E5DFD5] px-4 py-3 min-w-0">
              <div className="text-xs text-[#78756E]">{t('data.testSessions')}</div>
              <div className="mt-0.5 font-serif-display font-extrabold text-[26px] text-[#113C36] tabular-nums">
                {loadingCounts ? '—' : counts?.sessionsCount ?? 0}
              </div>
            </div>
            <div className="rounded-[12px] bg-[#FAF8F5] border border-[#E5DFD5] px-4 py-3 min-w-0">
              <div className="text-xs text-[#78756E]">{t('data.questionAttempts')}</div>
              <div className="mt-0.5 font-serif-display font-extrabold text-[26px] text-[#113C36] tabular-nums">
                {loadingCounts ? '—' : counts?.attemptsCount ?? 0}
              </div>
            </div>
            <div className="rounded-[12px] bg-[#FAF8F5] border border-[#E5DFD5] px-4 py-3 min-w-0">
              <div className="text-xs text-[#78756E]">{t('data.masteryRecords')}</div>
              <div className="mt-0.5 font-serif-display font-extrabold text-[26px] text-[#113C36] tabular-nums">
                {loadingCounts ? '—' : counts?.evidenceCount ?? 0}
              </div>
            </div>
            <div className="rounded-[12px] bg-[#FAF8F5] border border-[#E5DFD5] px-4 py-3 min-w-0">
              <div className="text-xs text-[#78756E]">{t('data.writingSubmissions')}</div>
              <div className="mt-0.5 font-serif-display font-extrabold text-[26px] text-[#113C36] tabular-nums">
                {loadingCounts ? '—' : counts?.writingCount ?? 0}
              </div>
            </div>
          </div>
        )}

        {!confirmOpen ? (
          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <button
              type="button"
              onClick={() => api.downloadFile('/api/admin/export/full', 'selective-lab-backup.json')}
              className="px-4 py-2 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-xs font-sans-display font-semibold text-[#113C36] inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{t('data.exportBackup')}</span>
            </button>

            <div className="space-y-1.5">
              {learnerName ? (
                <p className="text-xs text-[#4A5955]">
                  {t('data.scopedToLearner', { name: learnerName })}
                </p>
              ) : monitoredStudentId === null ? (
                <p className="text-xs text-[#78756E]">
                  {t('data.selectLearnerToReset')}
                </p>
              ) : null}
              <button
                type="button"
                disabled={monitoredStudentId === null}
                onClick={() => setConfirmOpen(true)}
                className="px-4 py-2 rounded-[10px] border border-[#B83A28]/35 bg-[#FDECEB] hover:bg-[#B83A28] hover:text-white text-[#B83A28] text-xs font-sans-display font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-45 disabled:pointer-events-none"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>{learnerName ? t('data.resetForLearner', { name: learnerName }) : t('data.resetProgressBtn')}</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="rounded-[14px] bg-[#FDECEB] border border-[#B83A28]/30 p-4 space-y-3">
            <div className="flex items-start gap-2.5 text-xs text-[#B83A28]">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <div className="font-sans-display font-semibold">
                  {t('data.resetConfirmTitle')}
                  {monitoredLearner
                    ? ` — ${
                        monitoredLearner.displayName ||
                        monitoredLearner.email ||
                        monitoredLearner.uid
                      }`
                    : ''}
                </div>
                <p className="leading-relaxed">
                  {t('data.resetConfirmPrefix')}{' '}
                  <strong className="font-mono-code">RESET</strong> {t('data.resetConfirmSuffix')}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <input
                type="text"
                aria-label={t('data.resetPlaceholder')}
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={t('data.resetPlaceholder')}
                className="px-3 py-2 rounded-[10px] border border-[#B83A28]/40 bg-white text-xs font-mono-code text-[#113C36] w-44 focus:outline-none"
              />
              <button
                type="button"
                disabled={resetting || confirmText.trim().toUpperCase() !== 'RESET'}
                onClick={handleConfirmReset}
                className="px-4 py-2 rounded-[10px] bg-[#B83A28] hover:bg-[#962D1E] text-white text-xs font-sans-display font-semibold cursor-pointer disabled:opacity-40"
              >
                {resetting ? t('data.clearing') : t('data.confirmReset')}
              </button>
              <button
                type="button"
                disabled={resetting}
                onClick={() => {
                  setConfirmOpen(false);
                  setConfirmText('');
                }}
                className="px-3.5 py-2 rounded-[10px] border border-[#CFC6B9] bg-white text-xs font-sans-display font-semibold text-[#4A5955] cursor-pointer"
              >
                {t('home.modalCancel')}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* 2. Frontend Design Spec (frontend.md) */}
      <section className="rounded-[16px] bg-white border border-[#E5DFD5] p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2">
              <FileCode2 className="w-4 h-4 text-[#113C36] shrink-0" />
              <h3 className="font-sans-display font-semibold text-[16px] text-[#113C36]">
                {t('data.designSpecTitle')}
              </h3>
            </div>
            <p className="text-xs text-[#4A5955]">
              {t('data.designSpecDesc')}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={loadingSpec === true}
              onClick={handleCopySpec}
              className="px-3 py-1.5 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-xs font-sans-display font-semibold text-[#113C36] inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-40"
            >
              <Copy className="w-3.5 h-3.5" />
              <span>{t('data.copySpec')}</span>
            </button>
            <a
              href="/docs/frontend-design.md"
              download="frontend.md"
              className="px-3 py-1.5 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-xs font-sans-display font-semibold inline-flex items-center gap-1.5"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{t('data.downloadSpec')}</span>
            </a>
          </div>
        </div>

        <div className="rounded-[12px] bg-[#FAF8F5] border border-[#E5DFD5] p-4 space-y-2">
          {loadingSpec === null ? (
            <button
              type="button"
              onClick={() => {
                setSpecExpanded(true);
                void ensureSpec();
              }}
              className="text-xs font-sans-display font-semibold text-[#113C36] underline underline-offset-4 cursor-pointer"
            >
              {t('data.expandSpec')}
            </button>
          ) : loadingSpec ? (
            <div className="text-xs text-[#78756E]">{t('data.loadingSpec')}</div>
          ) : !specText ? (
            <div className="text-xs text-[#78756E]">{t('data.specUnavailable')}</div>
          ) : (
            <>
              <pre
                className={`font-mono-code text-[11px] text-[#4A5955] whitespace-pre-wrap leading-relaxed overflow-y-auto ${
                  specExpanded ? 'max-h-[540px]' : 'max-h-[180px]'
                }`}
              >
                {specText}
              </pre>
              <button
                type="button"
                onClick={() => setSpecExpanded((v) => !v)}
                className="text-xs font-sans-display font-semibold text-[#113C36] underline underline-offset-4 cursor-pointer"
              >
                {specExpanded ? t('data.showLess') : t('data.expandSpec')}
              </button>
            </>
          )}
        </div>
      </section>

      {/* 3. Open Student Issue Flags */}
      <section className="rounded-[16px] bg-white border border-[#E5DFD5] p-6 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Flag className="w-4 h-4 text-[#113C36]" />
            <h3 className="font-sans-display font-semibold text-[16px] text-[#113C36]">
              {t('data.flagsTitle', { count: openFlags.length })}
            </h3>
          </div>
        </div>

        {openFlags.length === 0 ? (
          <p className="text-xs text-[#78756E]">{t('data.noFlags')}</p>
        ) : (
          <div className="divide-y divide-[#E5DFD5] border-t border-b border-[#E5DFD5]">
            {openFlags.map((flag) => (
              <div key={flag.flagId} className="py-3 flex flex-wrap items-center justify-between gap-3 text-xs">
                <div className="space-y-0.5 min-w-0 flex-1">
                  <a
                    href={buildBankQuestionHref(flag.questionId)}
                    aria-label={t('data.openInBankAria', { id: flag.questionId })}
                    onClick={(e) => {
                      if (!onOpenQuestion || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                      e.preventDefault();
                      onOpenQuestion(flag.questionId);
                    }}
                    className="font-mono-code font-semibold text-[#113C36] break-all underline decoration-[#CFC6B9] underline-offset-2 hover:decoration-[#113C36] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#113C36] rounded-[2px]"
                  >
                    {flag.questionId}
                  </a>
                  <div className="text-[#4A5955] break-words">
                    {flag.reason}
                    {flag.notes ? ` — ${flag.notes}` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleResolveFlag(flag.flagId)}
                  className="px-3 py-1.5 rounded-[10px] border border-[#C5DDD1] bg-[#E5F0EA] text-[#113C36] font-sans-display font-semibold inline-flex items-center gap-1 cursor-pointer shrink-0"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>{t('data.resolve')}</span>
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 4. Runtime Diagnostics */}
      <section className="rounded-[16px] bg-[#FAF8F5] border border-[#E5DFD5] p-5 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-sans-display font-semibold text-sm text-[#113C36]">
              {t('data.diagTitle')}
            </h3>
            <p className="text-xs text-[#78756E]">
              {t('data.diagDesc')}
            </p>
          </div>
          <button
            type="button"
            disabled={loadingDiag}
            onClick={handleCheckDiagnostics}
            className="px-3.5 py-1.5 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#F3EFE8] text-xs font-sans-display font-semibold text-[#113C36] inline-flex items-center gap-1.5 cursor-pointer shrink-0"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loadingDiag ? 'animate-spin' : ''}`} />
            <span>{t('data.runProbe')}</span>
          </button>
        </div>

        {diagnostics && (
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 text-xs">
            <div className="min-w-0">
              <dt className="text-[#78756E]">{t('data.diagBackend')}</dt>
              <dd className="font-mono-code text-[#113C36] mt-0.5 truncate">{diagnostics.runtimeBackend}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-[#78756E]">{t('data.diagGoogle')}</dt>
              <dd className="font-mono-code text-[#113C36] mt-0.5">{diagnostics.googleConfigured ? t('data.configured') : t('data.notConfigured')}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-[#78756E]">{t('data.diagDbProbe')}</dt>
              <dd className="font-mono-code text-[#113C36] mt-0.5">
                {diagnostics.databaseProbe.ok
                  ? `OK (${diagnostics.databaseProbe.latencyMs}ms)`
                  : diagnostics.databaseProbe.errorMessage || 'Error'}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-[#78756E]">{t('data.diagGemini')}</dt>
              <dd className="font-mono-code text-[#113C36] mt-0.5">
                {diagnostics.geminiConfigured ? t('data.configured') : t('data.notConfigured')}
              </dd>
            </div>
          </dl>
        )}
      </section>
    </div>
  );
}
