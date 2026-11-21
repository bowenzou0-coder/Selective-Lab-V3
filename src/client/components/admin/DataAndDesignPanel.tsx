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
import type { QuestionFlagRecord } from '../../../shared/contracts';

interface DataAndDesignPanelProps {
  onNotice: (msg: string) => void;
  onError: (msg: string) => void;
  onDataMutated?: () => void;
}

export function DataAndDesignPanel({
  onNotice,
  onError,
  onDataMutated,
}: DataAndDesignPanelProps) {
  const [counts, setCounts] = useState<ProgressCountsResponse | null>(null);
  const [loadingCounts, setLoadingCounts] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [resetting, setResetting] = useState(false);

  // Frontend Design Spec (frontend.md)
  const [specText, setSpecText] = useState('');
  const [loadingSpec, setLoadingSpec] = useState(true);
  const [specExpanded, setSpecExpanded] = useState(false);

  // Flags & Diagnostics
  const [flags, setFlags] = useState<QuestionFlagRecord[]>([]);
  const [diagnostics, setDiagnostics] = useState<RuntimeDiagnosticsResponse | null>(null);
  const [loadingDiag, setLoadingDiag] = useState(false);

  const loadData = async () => {
    setLoadingCounts(true);
    try {
      const [c, f] = await Promise.all([
        api.getProgressCounts(),
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

  useEffect(() => {
    void loadData();
    fetch('/docs/frontend-design.md')
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error('Spec not found'))))
      .then((txt) => setSpecText(txt))
      .catch(() => setSpecText(''))
      .finally(() => setLoadingSpec(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleConfirmReset = async () => {
    if (confirmText.trim().toUpperCase() !== 'RESET') return;
    setResetting(true);
    try {
      const res = await api.resetStudentProgress();
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
    if (!specText) return;
    try {
      await navigator.clipboard.writeText(specText);
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

  return (
    <div className="space-y-6">
      {/* 1. Data Controls — Reset Study Progress to Zero */}
      <section className="rounded-[16px] bg-white border border-[#E5DFD5] p-6 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <h2 className="font-sans-display font-semibold text-[18px] text-[#113C36]">
              Study data controls
            </h2>
            <p className="text-xs text-[#4A5955] max-w-2xl leading-relaxed">
              Clear this account’s test sessions, question attempts, spaced-repetition memory, daily plans, and writing submissions.
            </p>
          </div>
          {counts && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#E5F0EA] text-[#113C36] text-xs font-medium tabular-nums">
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>{counts.bankQuestionsCount} Question Bank items preserved</span>
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="rounded-[12px] bg-[#FAF8F5] border border-[#E5DFD5] px-4 py-3">
            <div className="text-xs text-[#78756E]">Test sessions</div>
            <div className="mt-0.5 font-serif-display font-extrabold text-[26px] text-[#113C36] tabular-nums">
              {loadingCounts ? '—' : counts?.sessionsCount ?? 0}
            </div>
          </div>
          <div className="rounded-[12px] bg-[#FAF8F5] border border-[#E5DFD5] px-4 py-3">
            <div className="text-xs text-[#78756E]">Question attempts</div>
            <div className="mt-0.5 font-serif-display font-extrabold text-[26px] text-[#113C36] tabular-nums">
              {loadingCounts ? '—' : counts?.attemptsCount ?? 0}
            </div>
          </div>
          <div className="rounded-[12px] bg-[#FAF8F5] border border-[#E5DFD5] px-4 py-3">
            <div className="text-xs text-[#78756E]">Mastery records</div>
            <div className="mt-0.5 font-serif-display font-extrabold text-[26px] text-[#113C36] tabular-nums">
              {loadingCounts ? '—' : counts?.evidenceCount ?? 0}
            </div>
          </div>
          <div className="rounded-[12px] bg-[#FAF8F5] border border-[#E5DFD5] px-4 py-3">
            <div className="text-xs text-[#78756E]">Writing submissions</div>
            <div className="mt-0.5 font-serif-display font-extrabold text-[26px] text-[#113C36] tabular-nums">
              {loadingCounts ? '—' : counts?.writingCount ?? 0}
            </div>
          </div>
        </div>

        {!confirmOpen ? (
          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <button
              type="button"
              onClick={() => api.downloadFile('/api/admin/export/full', 'selective-lab-backup.json')}
              className="px-4 py-2 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-xs font-sans-display font-semibold text-[#113C36] inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export backup JSON first</span>
            </button>

            <button
              type="button"
              onClick={() => setConfirmOpen(true)}
              className="px-4 py-2 rounded-[10px] border border-[#B83A28]/35 bg-[#FDECEB] hover:bg-[#B83A28] hover:text-white text-[#B83A28] text-xs font-sans-display font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Reset my study progress</span>
            </button>
          </div>
        ) : (
          <div className="rounded-[14px] bg-[#FDECEB] border border-[#B83A28]/30 p-4 space-y-3">
            <div className="flex items-start gap-2.5 text-xs text-[#B83A28]">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <div className="font-sans-display font-semibold">
                  Confirm permanent reset of your attempts and progress
                </div>
                <p className="leading-relaxed">
                  Type{' '}
                  <strong className="font-mono-code">RESET</strong> below to proceed.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <input
                type="text"
                aria-label="Type RESET to confirm"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="Type RESET"
                className="px-3 py-2 rounded-[10px] border border-[#B83A28]/40 bg-white text-xs font-mono-code text-[#113C36] w-44 focus:outline-none"
              />
              <button
                type="button"
                disabled={resetting || confirmText.trim().toUpperCase() !== 'RESET'}
                onClick={handleConfirmReset}
                className="px-4 py-2 rounded-[10px] bg-[#B83A28] hover:bg-[#962D1E] text-white text-xs font-sans-display font-semibold cursor-pointer disabled:opacity-40"
              >
                {resetting ? 'Clearing progress...' : 'Confirm reset to zero'}
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
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>

      {/* 2. Frontend Design Spec (frontend.md) */}
      <section className="rounded-[16px] bg-white border border-[#E5DFD5] p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <FileCode2 className="w-4 h-4 text-[#113C36]" />
              <h3 className="font-sans-display font-semibold text-[16px] text-[#113C36]">
                Frontend design spec (frontend.md)
              </h3>
            </div>
            <p className="text-xs text-[#4A5955]">
              Persisted in the repository at <span className="font-mono-code">/FRONTEND_DESIGN.md</span> and served live at{' '}
              <span className="font-mono-code">/docs/frontend-design.md</span> so future frontend edits follow your exact visual constitution.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!specText}
              onClick={handleCopySpec}
              className="px-3 py-1.5 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-xs font-sans-display font-semibold text-[#113C36] inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-40"
            >
              <Copy className="w-3.5 h-3.5" />
              <span>Copy spec</span>
            </button>
            <a
              href="/docs/frontend-design.md"
              download="frontend.md"
              className="px-3 py-1.5 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-xs font-sans-display font-semibold inline-flex items-center gap-1.5"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download frontend.md</span>
            </a>
          </div>
        </div>

        <div className="rounded-[12px] bg-[#FAF8F5] border border-[#E5DFD5] p-4 space-y-2">
          {loadingSpec ? (
            <div className="text-xs text-[#78756E]">Loading frontend.md...</div>
          ) : !specText ? (
            <div className="text-xs text-[#78756E]">Spec preview unavailable.</div>
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
                {specExpanded ? 'Show less' : 'Expand full frontend.md'}
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
              Student question flags ({openFlags.length} open)
            </h3>
          </div>
        </div>

        {openFlags.length === 0 ? (
          <p className="text-xs text-[#78756E]">No open question flags right now.</p>
        ) : (
          <div className="divide-y divide-[#E5DFD5] border-t border-b border-[#E5DFD5]">
            {openFlags.map((flag) => (
              <div key={flag.flagId} className="py-3 flex flex-wrap items-center justify-between gap-3 text-xs">
                <div className="space-y-0.5">
                  <div className="font-mono-code font-semibold text-[#113C36]">{flag.questionId}</div>
                  <div className="text-[#4A5955]">
                    {flag.reason}
                    {flag.notes ? ` — ${flag.notes}` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleResolveFlag(flag.flagId)}
                  className="px-3 py-1.5 rounded-[10px] border border-[#C5DDD1] bg-[#E5F0EA] text-[#113C36] font-sans-display font-semibold inline-flex items-center gap-1 cursor-pointer"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Resolve</span>
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 4. Runtime Diagnostics */}
      <section className="rounded-[16px] bg-[#FAF8F5] border border-[#E5DFD5] p-5 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="font-sans-display font-semibold text-sm text-[#113C36]">
              Runtime diagnostics
            </h3>
            <p className="text-xs text-[#78756E]">
              Check the database connection and sign-in configuration.
            </p>
          </div>
          <button
            type="button"
            disabled={loadingDiag}
            onClick={handleCheckDiagnostics}
            className="px-3.5 py-1.5 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#F3EFE8] text-xs font-sans-display font-semibold text-[#113C36] inline-flex items-center gap-1.5 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loadingDiag ? 'animate-spin' : ''}`} />
            <span>Run probe</span>
          </button>
        </div>

        {diagnostics && (
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 text-xs">
            <div>
              <dt className="text-[#78756E]">Backend</dt>
              <dd className="font-mono-code text-[#113C36] mt-0.5">{diagnostics.runtimeBackend}</dd>
            </div>
            <div>
              <dt className="text-[#78756E]">Google Sign-In</dt>
              <dd className="font-mono-code text-[#113C36] mt-0.5">{diagnostics.googleConfigured ? 'Configured' : 'Not configured'}</dd>
            </div>
            <div>
              <dt className="text-[#78756E]">Database probe</dt>
              <dd className="font-mono-code text-[#113C36] mt-0.5">
                {diagnostics.databaseProbe.ok
                  ? `OK (${diagnostics.databaseProbe.latencyMs}ms)`
                  : diagnostics.databaseProbe.errorMessage || 'Error'}
              </dd>
            </div>
            <div>
              <dt className="text-[#78756E]">Gemini API</dt>
              <dd className="font-mono-code text-[#113C36] mt-0.5">
                {diagnostics.geminiConfigured ? 'Configured' : 'Not configured'}
              </dd>
            </div>
          </dl>
        )}
      </section>
    </div>
  );
}
