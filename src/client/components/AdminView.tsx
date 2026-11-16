import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react';
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  History,
  Play,
  RefreshCw,
  ShieldCheck,
  Upload,
} from 'lucide-react';
import {
  api,
  type AdminStatusResponse,
  type MediaMigrationManifest,
  type MigrationPreflightReport,
  type RestoreReport,
  type RuntimeDiagnosticsResponse,
} from '../api';
import type {
  BankImportManifest,
  EvidenceCitationRef,
  ImportBatchRecord,
  LearningConfig,
  QuestionFlagRecord,
  QuestionItem,
  StimulusGroup,
} from '../../shared/contracts';
import { SKILLS_TAXONOMY } from '../../shared/skills';
import { QuestionWorkspace } from './QuestionWorkspace';

function NumericConfigInput({
  value,
  min,
  max,
  step = 1,
  onCommit,
  className,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onCommit: (next: number) => void;
  className?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) {
      setDraft(String(value));
    }
  }, [value, focused]);

  const commitValue = (raw: string) => {
    if (raw.trim() === '') {
      onCommit(min);
      setDraft(String(min));
      return;
    }
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
      setDraft(String(value));
      return;
    }
    const bounded = Math.min(max, Math.max(min, parsed));
    onCommit(bounded);
    setDraft(String(bounded));
  };

  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft}
      onFocus={(e) => {
        setFocused(true);
        e.target.select();
      }}
      onChange={(e) => {
        const nextRaw = e.target.value;
        setDraft(nextRaw);
        const parsed = Number(nextRaw);
        if (nextRaw.trim() !== '' && !Number.isNaN(parsed)) {
          onCommit(Math.min(max, Math.max(min, parsed)));
        }
      }}
      onBlur={() => {
        setFocused(false);
        commitValue(draft);
      }}
      className={className}
    />
  );
}

interface AdminViewProps {
  onOpenSession: (sessionId: string) => void;
}

type AdminTab = 'browser' | 'calibration' | 'importer' | 'config' | 'backup';

function formatTimestampSafe(iso?: string): string {
  if (!iso) return 'Unknown (legacy)';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'Unknown (legacy)' : d.toLocaleString();
}

export function AdminView({ onOpenSession }: AdminViewProps) {
  const [tab, setTab] = useState<AdminTab>(() => {
    const qs = new URLSearchParams(window.location.search);
    const t = qs.get('tab') as AdminTab | null;
    if (t && ['browser', 'calibration', 'importer', 'config', 'backup'].includes(t)) return t;
    return 'browser';
  });
  const [status, setStatus] = useState<AdminStatusResponse | null>(null);
  const [diagnostics, setDiagnostics] = useState<RuntimeDiagnosticsResponse | null>(null);
  const [loadingDiagnostics, setLoadingDiagnostics] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // Paginated Question Browser State
  const [browserQuestions, setBrowserQuestions] = useState<QuestionItem[]>([]);
  const [browserStimuliById, setBrowserStimuliById] = useState<Record<string, StimulusGroup>>({});
  const [browserTotal, setBrowserTotal] = useState(0);
  const [browserHasMore, setBrowserHasMore] = useState(false);
  const [browserPage, setBrowserPage] = useState(1);
  const [browserPageSize, setBrowserPageSize] = useState(25);
  const [browserLoading, setBrowserLoading] = useState(false);

  const [bSearch, setBSearch] = useState('');
  const [bSection, setBSection] = useState('');
  const [bPool, setBPool] = useState('');
  const [bStatus, setBStatus] = useState('');
  const [bFormat, setBFormat] = useState('');
  const [bBatchTag, setBBatchTag] = useState('');
  const [bBatchId, setBBatchId] = useState('');
  const [bSort, setBSort] = useState<'id_asc' | 'updated_desc' | 'version_desc'>('id_asc');
  const [bIncludeHistorical, setBIncludeHistorical] = useState(false);
  const [bFlaggedOnly, setBFlaggedOnly] = useState(false);
  const [bMissingVisual, setBMissingVisual] = useState(false);
  const [bMissingExplanation, setBMissingExplanation] = useState(false);

  const [selectedQid, setSelectedQid] = useState<string>(
    () => new URLSearchParams(window.location.search).get('qid') || ''
  );
  const [checkedQids, setCheckedQids] = useState<string[]>([]);
  const [versionsForSelected, setVersionsForSelected] = useState<QuestionItem[]>([]);
  const [previewEvidenceRef, setPreviewEvidenceRef] = useState<EvidenceCitationRef | null>(null);
  const [uploadingQid, setUploadingQid] = useState<string | null>(null);

  // Calibration Simulator State
  const [calSection, setCalSection] = useState('');
  const [calPool, setCalPool] = useState('');
  const [calBatch, setCalBatch] = useState('');
  const [calFormat, setCalFormat] = useState('');
  const [calSkillFamily, setCalSkillFamily] = useState('');
  const [calSkillId, setCalSkillId] = useState('');
  const [calQcStatus, setCalQcStatus] = useState('active');
  const [calLimit, setCalLimit] = useState('15');
  const [calTimerMin, setCalTimerMin] = useState('0');
  const [calSandbox, setCalSandbox] = useState(true);
  const [launchingCal, setLaunchingCal] = useState(false);

  // Flags & Batches
  const [flags, setFlags] = useState<QuestionFlagRecord[]>([]);
  const [batches, setBatches] = useState<ImportBatchRecord[]>([]);

  // Bank Importer State
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

  // Config Editor State
  const [configDraft, setConfigDraft] = useState<LearningConfig | null>(null);
  const [configVersionNum, setConfigVersionNum] = useState(1);
  const [configNotes, setConfigNotes] = useState('');
  const [configHistory, setConfigHistory] = useState<
    { configVersionId: string; versionNumber: number; notes?: string; createdAt: string }[]
  >([]);

  // Backup / Restore / Migration State
  const [restoreJson, setRestoreJson] = useState('');
  const [restoreReport, setRestoreReport] = useState<RestoreReport | null>(null);
  const [preflightReport, setPreflightReport] = useState<MigrationPreflightReport | null>(null);
  const [mediaManifest, setMediaManifest] = useState<MediaMigrationManifest | null>(null);
  const [loadingPreflight, setLoadingPreflight] = useState(false);

  // Sync URL query parameters (`?tab=...&qid=...`)
  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    qs.set('tab', tab);
    if (tab === 'browser' && selectedQid) {
      qs.set('qid', selectedQid);
    } else {
      qs.delete('qid');
    }
    const nextSearch = `?${qs.toString()}`;
    if (window.location.search !== nextSearch) {
      window.history.replaceState({}, '', `${window.location.pathname}${nextSearch}`);
    }
  }, [tab, selectedQid]);

  const loadBrowserQuestions = useCallback(async () => {
    setBrowserLoading(true);
    try {
      const res = await api.getAdminQuestions({
        search: bSearch || undefined,
        section: bSection || undefined,
        poolType: bPool || undefined,
        qcStatus: bStatus || undefined,
        formatType: bFormat || undefined,
        batchTag: bBatchTag || undefined,
        batchId: bBatchId || undefined,
        sort: bSort,
        includeHistorical: bIncludeHistorical,
        flaggedOnly: bFlaggedOnly,
        missingVisual: bMissingVisual,
        missingExplanation: bMissingExplanation,
        page: browserPage,
        pageSize: browserPageSize,
      });
      const totalMatching = Number(res.totalMatching ?? 0);
      setBrowserQuestions(res.questions);
      setBrowserStimuliById(res.stimuliById);
      setBrowserTotal(totalMatching);
      setBrowserHasMore(res.page * res.pageSize < totalMatching);
      if (Array.isArray(res.batches)) {
        setBatches(res.batches);
      }
      if (res.questions.length > 0 && !res.questions.some((q) => q.questionId === selectedQid)) {
        if (!selectedQid) {
          setSelectedQid(res.questions[0].questionId);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load paginated questions.');
    } finally {
      setBrowserLoading(false);
    }
  }, [
    bSearch,
    bSection,
    bPool,
    bStatus,
    bFormat,
    bBatchTag,
    bBatchId,
    bSort,
    bIncludeHistorical,
    bFlaggedOnly,
    bMissingVisual,
    bMissingExplanation,
    browserPage,
    browserPageSize,
    selectedQid,
  ]);

  const loadDiagnostics = useCallback(async () => {
    setLoadingDiagnostics(true);
    try {
      const diag = await api.getAdminDiagnostics();
      setDiagnostics(diag);
    } catch {
      // ignore secondary probe error if offline
    } finally {
      setLoadingDiagnostics(false);
    }
  }, []);

  const loadAdminOverview = useCallback(async () => {
    try {
      const [st, flRes, cfgRes, batchRes] = await Promise.all([
        api.getAdminStatus(),
        api.getAdminFlags(),
        api.getAdminConfig(),
        api.getImportBatches(),
      ]);
      setStatus(st);
      setFlags(flRes.flags);
      setConfigDraft(cfgRes.active.config);
      setConfigVersionNum(cfgRes.active.versionNumber);
      setConfigHistory(cfgRes.history);
      setBatches(batchRes.batches);
      loadDiagnostics();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load admin console.');
    }
  }, [loadDiagnostics]);

  useEffect(() => {
    loadAdminOverview();
  }, [loadAdminOverview]);

  useEffect(() => {
    loadBrowserQuestions();
  }, [loadBrowserQuestions]);

  // Load version history when selectedQid changes
  useEffect(() => {
    setPreviewEvidenceRef(null);
    if (!selectedQid) {
      setVersionsForSelected([]);
      return;
    }
    let active = true;
    api
      .getQuestionVersions(selectedQid)
      .then((res) => {
        if (!active) return;
        const unwrapped = res.versions.map((entry) => entry.question).filter(Boolean);
        setVersionsForSelected(unwrapped);
        const stimUpdates: Record<string, StimulusGroup> = {};
        for (const entry of res.versions) {
          if (entry.stimulus?.stimulusId) {
            stimUpdates[entry.stimulus.stimulusId] = entry.stimulus;
          }
        }
        if (Object.keys(stimUpdates).length > 0) {
          setBrowserStimuliById((prev) => ({ ...stimUpdates, ...prev }));
        }
      })
      .catch(() => {
        if (active) setVersionsForSelected([]);
      });
    return () => {
      active = false;
    };
  }, [selectedQid]);

  const selectedQuestion = useMemo(() => {
    return (
      browserQuestions.find((q) => q.questionId === selectedQid) ||
      versionsForSelected.find((q) => q.questionId === selectedQid) ||
      browserQuestions[0] ||
      null
    );
  }, [browserQuestions, versionsForSelected, selectedQid]);

  const skillFamilies = useMemo(
    () => Array.from(new Set(SKILLS_TAXONOMY.map((s) => s.familyCode))),
    []
  );

  const handleSimulateQuestionIds = async (ids: string[]) => {
    if (ids.length === 0) return;
    setError('');
    try {
      const res = await api.createCalibrationSession({
        questionIds: ids,
        isSandbox: true,
        customTimeLimitSec: 0,
      });
      onOpenSession(res.sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to start simulation.');
    }
  };

  const handleSimulateFiltered = async () => {
    setError('');
    try {
      const res = await api.createCalibrationSession({
        section: bSection || undefined,
        poolType: bPool || undefined,
        qcStatus: bStatus || undefined,
        formatType: bFormat || undefined,
        batch: bBatchTag || undefined,
        batchId: bBatchId || undefined,
        includeHistorical: bIncludeHistorical,
        limit: 25,
        isSandbox: true,
      });
      onOpenSession(res.sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to simulate filtered set.');
    }
  };

  const handleLaunchCalibration = async () => {
    setLaunchingCal(true);
    setError('');
    try {
      const res = await api.createCalibrationSession({
        section: calSection || undefined,
        poolType: calPool || undefined,
        batch: calBatch || undefined,
        formatType: calFormat || undefined,
        skillFamily: calSkillFamily || undefined,
        skillId: calSkillId || undefined,
        qcStatus: calQcStatus || undefined,
        limit: Math.max(1, Number(calLimit) || 15),
        customTimeLimitSec: Math.max(0, Number(calTimerMin) || 0) * 60,
        isSandbox: calSandbox,
      });
      onOpenSession(res.sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to launch calibration session.');
      setLaunchingCal(false);
    }
  };

  const handleToggleQcStatus = async (q: QuestionItem, nextStatus: QuestionItem['qcStatus']) => {
    setError('');
    try {
      await api.updateQuestionStatus(q.questionId, nextStatus);
      setBrowserQuestions((prev) =>
        prev.map((item) => (item.questionId === q.questionId ? { ...item, qcStatus: nextStatus } : item))
      );
      setNotice(`Updated ${q.questionId} to ${nextStatus}.`);
      loadAdminOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update QC status.');
    }
  };

  const handleUploadVisual = async (questionId: string, e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingQid(questionId);
    setError('');
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('File read failed'));
        reader.readAsDataURL(file);
      });
      const res = await api.attachQuestionVisual(questionId, {
        altText: file.name,
        caption: `Uploaded asset (${file.name})`,
        imageBase64: dataUrl,
        filename: file.name,
      });
      setBrowserQuestions((prev) =>
        prev.map((item) => (item.questionId === questionId ? { ...item, visual: res.visual } : item))
      );
      setNotice(`Attached visual asset to ${questionId}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload visual.');
    } finally {
      setUploadingQid(null);
    }
  };

  const handleDryRun = async () => {
    setError('');
    setNotice('');
    try {
      const parsed = JSON.parse(manifestText);
      const res = await api.dryRunManifest(parsed);
      setDryRunReport(res.report);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid JSON manifest.');
    }
  };

  const handleCommitManifest = async () => {
    setError('');
    setNotice('');
    try {
      const parsed = JSON.parse(manifestText) as BankImportManifest;
      const res = await api.commitManifest(parsed);
      setNotice(
        `Committed batch ${res.batch?.batchId || ''}: ${res.result.imported} imported, ${res.result.versionBumped} version-bumped, ${res.result.skipped} unchanged.`
      );
      setDryRunReport(null);
      await Promise.all([loadAdminOverview(), loadBrowserQuestions()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Manifest commit failed.');
    }
  };

  const handleSaveConfig = async () => {
    if (!configDraft) return;
    setError('');
    setNotice('');
    try {
      const res = await api.saveAdminConfig(configDraft, configNotes || undefined);
      setConfigVersionNum(res.versionNumber);
      setConfigNotes('');
      setNotice(`Saved immutable LearningConfig version v${res.versionNumber}.`);
      await loadAdminOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save config.');
    }
  };

  const handleRunRestore = async (dryRun: boolean) => {
    setError('');
    setNotice('');
    try {
      const parsed = JSON.parse(restoreJson);
      const res = await api.restoreBackup(parsed, dryRun);
      setRestoreReport(res.report);
      if (!dryRun && res.ok) {
        setNotice('Applied canonical backup restore successfully.');
        await Promise.all([loadAdminOverview(), loadBrowserQuestions()]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Backup restore failed.');
    }
  };

  const handleLoadPreflight = async () => {
    setLoadingPreflight(true);
    setError('');
    try {
      const [preflightRes, mediaRes] = await Promise.all([
        api.getMigrationPreflight(),
        api.getMediaMigrationManifest(),
      ]);
      setPreflightReport(preflightRes.report);
      setMediaManifest(mediaRes.manifest);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run migration preflight.');
    } finally {
      setLoadingPreflight(false);
    }
  };

  const startRow = browserTotal === 0 ? 0 : (browserPage - 1) * browserPageSize + 1;
  const endRow = Math.min(browserTotal, browserPage * browserPageSize);

  return (
    <main className="max-w-[1440px] mx-auto px-4 sm:px-6 py-8 space-y-6">
      {/* Status Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">Admin &amp; Calibration Console</h1>
          {status && (
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)] tabular-nums">
              <span>Bank: {status.totalQuestions} questions</span>
              <span aria-hidden="true">·</span>
              <span>Holdout pool: {status.holdoutQuestionCount}</span>
              <span aria-hidden="true">·</span>
              <span
                className={
                  status.holdoutIsolationOk
                    ? 'text-[var(--status-success)] font-semibold'
                    : 'text-[var(--status-error)] font-semibold'
                }
              >
                <ShieldCheck className="w-3.5 h-3.5 inline mr-1" />
                Holdout isolation: {status.holdoutIsolationOk ? 'Verified (0 leaks)' : `${status.leakedCount} leaked`}
              </span>
              <span aria-hidden="true">·</span>
              <span>Open flags: {status.openFlagsCount}</span>
              <span aria-hidden="true">·</span>
              <span>Config v{status.activeConfigVersion}</span>
              <span aria-hidden="true">·</span>
              <span>Storage: {status.backendName}</span>
            </div>
          )}
        </div>
      </div>

      {/* Tab Bar */}
      <div className="flex flex-wrap gap-1.5 p-1 bg-[var(--bg-surface)] rounded-[var(--radius-md)] w-fit border border-[var(--border-hairline)]">
        {(
          [
            ['browser', 'Question Browser'],
            ['calibration', 'Calibration Simulator'],
            ['importer', 'Bank Importer'],
            ['config', 'Config Editor'],
            ['backup', 'Backup & Migration'],
          ] as [AdminTab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`px-4 py-2 rounded-[var(--radius-sm)] text-xs font-semibold cursor-pointer whitespace-nowrap transition-colors ${
              tab === id
                ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-xs'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {diagnostics?.remediationHint && (
        <div
          role="alert"
          className="p-4 rounded-[var(--radius-md)] bg-[var(--status-warn-bg)] border border-[var(--status-warn)]/40 text-xs text-[var(--status-warn)] space-y-1.5"
        >
          <div className="font-bold">Managed Cloud Permission Notice</div>
          <p>{diagnostics.remediationHint}</p>
        </div>
      )}

      {error && (
        <div role="alert" className="p-3.5 rounded-[var(--radius-sm)] bg-[var(--status-error-bg)] text-[var(--status-error)] text-xs font-medium">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="p-3.5 rounded-[var(--radius-sm)] bg-[var(--status-success-bg)] text-[var(--status-success)] text-xs font-medium flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      {/* TAB 1: Full Anki-Style Paginated Question Browser */}
      {tab === 'browser' && (
        <section className="space-y-4">
          {flags.filter((f) => f.status === 'open').length > 0 && (
            <div className="p-4 rounded-[var(--radius-md)] bg-[var(--status-warn-bg)] border border-[var(--status-warn)]/30 space-y-2.5">
              <h2 className="text-xs font-bold text-[var(--status-warn)]">
                Open Student Issue Flags ({flags.filter((f) => f.status === 'open').length})
              </h2>
              {flags
                .filter((f) => f.status === 'open')
                .map((fl) => (
                  <div
                    key={fl.flagId}
                    className="flex flex-wrap items-center justify-between gap-3 text-xs bg-[var(--bg-elevated)] p-2.5 rounded-[var(--radius-sm)]"
                  >
                    <div>
                      <button
                        type="button"
                        onClick={() => setSelectedQid(fl.questionId)}
                        className="font-bold underline hover:text-[var(--accent-primary)] cursor-pointer mr-2"
                      >
                        {fl.questionId}
                      </button>
                      <span>{fl.reason}</span>
                      {fl.notes ? ` — "${fl.notes}"` : ''}
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        await api.resolveFlag(fl.flagId);
                        await Promise.all([loadAdminOverview(), loadBrowserQuestions()]);
                      }}
                      className="px-2.5 py-1 rounded-[var(--radius-sm)] border border-[var(--border-strong)] font-semibold cursor-pointer"
                    >
                      Mark Resolved
                    </button>
                  </div>
                ))}
            </div>
          )}

          {/* Browser Filter Controls */}
          <div className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-elevated)] border border-[var(--border-hairline)] space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-2.5">
              <input
                type="text"
                aria-label="Search questions"
                placeholder="Search ID, prompt, explanation, skill..."
                value={bSearch}
                onChange={(e) => {
                  setBSearch(e.target.value);
                  setBrowserPage(1);
                }}
                className="sm:col-span-2 px-3 py-2 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] text-xs"
              />
              <select
                aria-label="Filter by section"
                value={bSection}
                onChange={(e) => {
                  setBSection(e.target.value);
                  setBrowserPage(1);
                }}
                className="px-2.5 py-2 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] text-xs"
              >
                <option value="">All Sections</option>
                <option value="READ">READ</option>
                <option value="MATH">MATH</option>
                <option value="THINK">THINK</option>
                <option value="WRIT">WRIT</option>
              </select>
              <select
                aria-label="Filter by pool"
                value={bPool}
                onChange={(e) => {
                  setBPool(e.target.value);
                  setBrowserPage(1);
                }}
                className="px-2.5 py-2 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] text-xs"
              >
                <option value="">All Pools</option>
                <option value="practice">practice</option>
                <option value="official_calibration">official_calibration</option>
                <option value="benchmark_holdout">benchmark_holdout</option>
                <option value="diagnostic">diagnostic</option>
              </select>
              <select
                aria-label="Filter by QC status"
                value={bStatus}
                onChange={(e) => {
                  setBStatus(e.target.value);
                  setBrowserPage(1);
                }}
                className="px-2.5 py-2 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] text-xs"
              >
                <option value="">All QC Statuses</option>
                <option value="active">active</option>
                <option value="quarantined">quarantined</option>
                <option value="verified">verified</option>
                <option value="draft">draft</option>
                <option value="retired">retired</option>
              </select>
              <select
                aria-label="Filter by test batch tag"
                value={bBatchTag}
                onChange={(e) => {
                  setBBatchTag(e.target.value);
                  setBrowserPage(1);
                }}
                className="px-2.5 py-2 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] text-xs"
              >
                <option value="">All Test Tags</option>
                <option value="SMOKE">SMOKE</option>
                <option value="PT1">PT1</option>
                <option value="PT2">PT2</option>
                <option value="PT3">PT3</option>
              </select>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <select
                  aria-label="Filter by question format"
                  value={bFormat}
                  onChange={(e) => {
                    setBFormat(e.target.value);
                    setBrowserPage(1);
                  }}
                  className="px-2.5 py-1.5 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] text-xs"
                >
                  <option value="">All Formats</option>
                  <option value="READ_FICTION_MCQ">READ_FICTION_MCQ</option>
                  <option value="READ_VOCAB_CLOZE">READ_VOCAB_CLOZE</option>
                  <option value="READ_POETRY_MCQ">READ_POETRY_MCQ</option>
                  <option value="READ_GAPPED_TEXT">READ_GAPPED_TEXT</option>
                  <option value="READ_MULTIPLE_MATCH">READ_MULTIPLE_MATCH</option>
                  <option value="MATH_MCQ_5">MATH_MCQ_5</option>
                  <option value="THINK_MCQ_4">THINK_MCQ_4</option>
                  <option value="WRIT_TYPED_TASK">WRIT_TYPED_TASK</option>
                </select>

                <select
                  aria-label="Filter by import batch"
                  value={bBatchId}
                  onChange={(e) => {
                    setBBatchId(e.target.value);
                    setBrowserPage(1);
                  }}
                  className="px-2.5 py-1.5 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] text-xs"
                >
                  <option value="">All Import Batches</option>
                  {batches.map((b) => (
                    <option key={b.batchId} value={b.batchId}>
                      {b.batchLabel} ({b.questionsCount})
                    </option>
                  ))}
                </select>

                <select
                  aria-label="Sort questions"
                  value={bSort}
                  onChange={(e) => setBSort(e.target.value as typeof bSort)}
                  className="px-2.5 py-1.5 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] text-xs"
                >
                  <option value="id_asc">Sort: ID (A–Z)</option>
                  <option value="updated_desc">Sort: Recently Updated</option>
                  <option value="version_desc">Sort: Highest Version</option>
                </select>

                <label className="inline-flex items-center gap-1.5 cursor-pointer text-[var(--text-secondary)]">
                  <input
                    type="checkbox"
                    checked={bIncludeHistorical}
                    onChange={(e) => {
                      setBIncludeHistorical(e.target.checked);
                      setBrowserPage(1);
                    }}
                    className="accent-[var(--accent-primary)]"
                  />
                  <span>Historical versions</span>
                </label>

                <label className="inline-flex items-center gap-1.5 cursor-pointer text-[var(--text-secondary)]">
                  <input
                    type="checkbox"
                    checked={bFlaggedOnly}
                    onChange={(e) => {
                      setBFlaggedOnly(e.target.checked);
                      setBrowserPage(1);
                    }}
                    className="accent-[var(--accent-primary)]"
                  />
                  <span>Flagged only</span>
                </label>

                <label className="inline-flex items-center gap-1.5 cursor-pointer text-[var(--text-secondary)]">
                  <input
                    type="checkbox"
                    checked={bMissingVisual}
                    onChange={(e) => {
                      setBMissingVisual(e.target.checked);
                      setBrowserPage(1);
                    }}
                    className="accent-[var(--accent-primary)]"
                  />
                  <span>Missing visual</span>
                </label>

                <label className="inline-flex items-center gap-1.5 cursor-pointer text-[var(--text-secondary)]">
                  <input
                    type="checkbox"
                    checked={bMissingExplanation}
                    onChange={(e) => {
                      setBMissingExplanation(e.target.checked);
                      setBrowserPage(1);
                    }}
                    className="accent-[var(--accent-primary)]"
                  />
                  <span>Missing explanation</span>
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {checkedQids.length > 0 && (
                  <button
                    type="button"
                    onClick={() => handleSimulateQuestionIds(checkedQids)}
                    className="px-3 py-1.5 rounded-[var(--radius-sm)] bg-[var(--accent-primary)] hover:bg-[var(--accent-primary-hover)] text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5 fill-current" />
                    <span>Simulate selected ({checkedQids.length})</span>
                  </button>
                )}
                <button
                  type="button"
                  disabled={browserTotal === 0}
                  onClick={handleSimulateFiltered}
                  className="px-3 py-1.5 rounded-[var(--radius-sm)] bg-[var(--text-primary)] hover:opacity-90 text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  <Play className="w-3.5 h-3.5" />
                  <span>{bBatchId ? 'Simulate this batch' : 'Simulate filtered (up to 25)'}</span>
                </button>
              </div>
            </div>
          </div>

          {/* Anki-Style Split List (Left) + Sticky Workspace Preview (Right) */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
            {/* Master Question Table / List */}
            <div className="lg:col-span-5 border border-[var(--border-hairline)] rounded-[var(--radius-md)] bg-[var(--bg-elevated)] overflow-hidden">
              <div className="px-4 py-2.5 border-b border-[var(--border-hairline)] bg-[var(--bg-surface)] flex items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    aria-label="Select all on page"
                    checked={
                      browserQuestions.length > 0 &&
                      browserQuestions.every((q) => checkedQids.includes(q.questionId))
                    }
                    onChange={(e) => {
                      const pageIds = browserQuestions.map((q) => q.questionId);
                      if (e.target.checked) {
                        setCheckedQids((prev) => Array.from(new Set([...prev, ...pageIds])));
                      } else {
                        setCheckedQids((prev) => prev.filter((id) => !pageIds.includes(id)));
                      }
                    }}
                    className="accent-[var(--accent-primary)]"
                  />
                  <span className="font-semibold text-[var(--text-secondary)] tabular-nums">
                    {browserLoading ? 'Loading...' : `Showing ${startRow}–${endRow} of ${browserTotal}`}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    aria-label="Page size"
                    value={browserPageSize}
                    onChange={(e) => {
                      setBrowserPageSize(Number(e.target.value));
                      setBrowserPage(1);
                    }}
                    className="px-2 py-1 rounded border border-[var(--border-strong)] bg-[var(--bg-elevated)] text-xs tabular-nums"
                  >
                    <option value={25}>25 / page</option>
                    <option value={50}>50 / page</option>
                    <option value={100}>100 / page</option>
                  </select>
                </div>
              </div>

              <div className="divide-y divide-[var(--border-hairline)] max-h-[680px] overflow-y-auto">
                {browserQuestions.length === 0 && !browserLoading && (
                  <div className="p-8 text-center text-xs text-[var(--text-secondary)]">
                    No questions matched your browser filters.
                  </div>
                )}
                {browserQuestions.map((q) => {
                  const isSelected = selectedQuestion?.questionId === q.questionId;
                  const isChecked = checkedQids.includes(q.questionId);
                  const stim = q.stimulusId ? browserStimuliById[q.stimulusId] : undefined;
                  return (
                    <div
                      key={q.questionId}
                      className={`px-3.5 py-2.5 flex items-start gap-2.5 text-xs transition-colors ${
                        isSelected ? 'bg-[var(--accent-soft)]/60' : 'hover:bg-[var(--bg-surface)]'
                      }`}
                    >
                      <input
                        type="checkbox"
                        aria-label={`Select ${q.questionId}`}
                        checked={isChecked}
                        onChange={(e) => {
                          setCheckedQids((prev) =>
                            e.target.checked
                              ? [...prev, q.questionId]
                              : prev.filter((id) => id !== q.questionId)
                          );
                        }}
                        className="mt-1 accent-[var(--accent-primary)] shrink-0"
                      />
                      <button
                        type="button"
                        onClick={() => setSelectedQid(q.questionId)}
                        className="flex-1 text-left min-w-0 cursor-pointer space-y-1"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-1.5 tabular-nums">
                          <span className="font-mono font-bold text-[var(--text-primary)] truncate">
                            {q.questionId}
                          </span>
                          <span className="text-[11px] text-[var(--text-muted)]">
                            v{q.version} · {q.section} · {q.qcStatus}
                          </span>
                        </div>
                        <div className="text-[var(--text-secondary)] line-clamp-2">
                          {q.parts[0]?.promptText || q.stemPrefix || stim?.title || q.formatType}
                        </div>
                        <div className="text-[11px] text-[var(--text-muted)] flex flex-wrap gap-2">
                          <span>{q.poolType}</span>
                          <span>·</span>
                          <span>Updated: {formatTimestampSafe(q.updatedAtIso || q.createdAtIso)}</span>
                        </div>
                      </button>
                    </div>
                  );
                })}
              </div>

              {/* Pagination Footer */}
              <div className="px-4 py-2.5 border-t border-[var(--border-hairline)] bg-[var(--bg-surface)] flex items-center justify-between text-xs tabular-nums">
                <button
                  type="button"
                  disabled={browserPage <= 1}
                  onClick={() => setBrowserPage((p) => Math.max(1, p - 1))}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-[var(--border-strong)] bg-[var(--bg-elevated)] disabled:opacity-40 cursor-pointer"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                  <span>Prev</span>
                </button>
                <span className="text-[var(--text-secondary)]">Page {browserPage}</span>
                <button
                  type="button"
                  disabled={!browserHasMore}
                  onClick={() => setBrowserPage((p) => p + 1)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-[var(--border-strong)] bg-[var(--bg-elevated)] disabled:opacity-40 cursor-pointer"
                >
                  <span>Next</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Sticky Preview Inspector Pane */}
            <div className="lg:col-span-7 lg:sticky lg:top-4 space-y-4">
              {selectedQuestion ? (
                <div className="p-5 rounded-[var(--radius-md)] border border-[var(--border-hairline)] bg-[var(--bg-elevated)] space-y-4">
                  <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border-hairline)] pb-3">
                    <div className="space-y-1 min-w-0">
                      <div className="text-sm font-bold font-mono text-[var(--text-primary)] break-all">
                        {selectedQuestion.questionId}{' '}
                        <span className="font-sans text-xs font-normal text-[var(--text-muted)]">
                          (v{selectedQuestion.version} · Family {selectedQuestion.questionFamilyId})
                        </span>
                      </div>
                      <div className="text-xs text-[var(--text-secondary)] tabular-nums">
                        Pool: {selectedQuestion.poolType} · QC: <strong>{selectedQuestion.qcStatus}</strong> ·
                        Created: {formatTimestampSafe(selectedQuestion.createdAtIso)} ·
                        Updated: {formatTimestampSafe(selectedQuestion.updatedAtIso)}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleSimulateQuestionIds([selectedQuestion.questionId])}
                        className="px-3 py-1.5 rounded-[var(--radius-sm)] bg-[var(--accent-primary)] hover:bg-[var(--accent-primary-hover)] text-white text-xs font-semibold inline-flex items-center gap-1 cursor-pointer"
                      >
                        <Play className="w-3 h-3 fill-current" />
                        <span>Simulate this</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleToggleQcStatus(selectedQuestion, 'active')}
                        className={`px-2.5 py-1.5 rounded-[var(--radius-sm)] border text-xs font-semibold cursor-pointer ${
                          selectedQuestion.qcStatus === 'active'
                            ? 'border-[var(--status-success)] bg-[var(--status-success-bg)] text-[var(--status-success)]'
                            : 'border-[var(--border-strong)]'
                        }`}
                      >
                        Active
                      </button>
                      <button
                        type="button"
                        onClick={() => handleToggleQcStatus(selectedQuestion, 'quarantined')}
                        className={`px-2.5 py-1.5 rounded-[var(--radius-sm)] border text-xs font-semibold cursor-pointer ${
                          selectedQuestion.qcStatus === 'quarantined'
                            ? 'border-[var(--status-error)] bg-[var(--status-error-bg)] text-[var(--status-error)]'
                            : 'border-[var(--border-strong)]'
                        }`}
                      >
                        Quarantine
                      </button>
                      <label className="px-2.5 py-1.5 rounded-[var(--radius-sm)] border border-[var(--border-strong)] text-xs font-semibold cursor-pointer hover:bg-[var(--bg-surface)] inline-flex items-center gap-1">
                        <Upload className="w-3 h-3" />
                        <span>{uploadingQid === selectedQuestion.questionId ? 'Uploading...' : 'Attach Image'}</span>
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp,image/svg+xml"
                          className="sr-only"
                          onChange={(e) => handleUploadVisual(selectedQuestion.questionId, e)}
                        />
                      </label>
                    </div>
                  </div>

                  {/* Full Shared Workspace Admin Preview */}
                  <QuestionWorkspace
                    mode="adminPreview"
                    embedded
                    question={selectedQuestion}
                    stimulus={
                      selectedQuestion.stimulusId
                        ? browserStimuliById[selectedQuestion.stimulusId]
                        : undefined
                    }
                    activeEvidenceRef={previewEvidenceRef}
                    onSelectEvidenceRef={setPreviewEvidenceRef}
                  />

                  {/* Version History Drawer */}
                  {versionsForSelected.length > 0 && (
                    <div className="p-3.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface)] border border-[var(--border-hairline)] space-y-2 text-xs">
                      <div className="flex items-center gap-1.5 font-semibold text-[var(--text-primary)]">
                        <History className="w-3.5 h-3.5" />
                        <span>Question Version History ({versionsForSelected.length})</span>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {versionsForSelected.map((ver) => (
                          <button
                            key={ver.questionId}
                            type="button"
                            onClick={() => setSelectedQid(ver.questionId)}
                            className={`px-2.5 py-1 rounded border tabular-nums cursor-pointer ${
                              ver.questionId === selectedQuestion.questionId
                                ? 'border-[var(--accent-primary)] bg-[var(--accent-soft)] font-semibold'
                                : 'border-[var(--border-strong)] bg-[var(--bg-elevated)]'
                            }`}
                          >
                            v{ver.version} · {ver.qcStatus} · {formatTimestampSafe(ver.createdAtIso)}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="p-8 rounded-[var(--radius-md)] border border-[var(--border-hairline)] bg-[var(--bg-elevated)] text-center text-xs text-[var(--text-secondary)]">
                  Select a question from the list to inspect its rendered workspace, answer key, evidence citations, and version history.
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {/* TAB 2: Calibration & QA Practice Simulator */}
      {tab === 'calibration' && (
        <section className="p-6 rounded-[var(--radius-lg)] bg-[var(--bg-elevated)] border border-[var(--border-hairline)] space-y-6">
          <div>
            <h2 className="text-lg font-bold text-[var(--text-primary)]">
              Practice &amp; Calibration Simulator
            </h2>
            <p className="text-sm text-[var(--text-secondary)] mt-1">
              Test any topic, skill, format, pool, or official test batch inside the live Janison player with an Admin Answer-Key Inspector and optional Sandbox isolation.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label className="block text-xs font-semibold text-[var(--text-secondary)] mb-1">Section</label>
              <select
                value={calSection}
                onChange={(e) => setCalSection(e.target.value)}
                className="w-full px-3 py-2 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] text-sm"
              >
                <option value="">All Sections</option>
                <option value="READ">Reading</option>
                <option value="MATH">Mathematical Reasoning</option>
                <option value="THINK">Thinking Skills</option>
                <option value="WRIT">Writing</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-[var(--text-secondary)] mb-1">Pool</label>
              <select
                value={calPool}
                onChange={(e) => setCalPool(e.target.value)}
                className="w-full px-3 py-2 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] text-sm"
              >
                <option value="">All Pools</option>
                <option value="practice">practice</option>
                <option value="official_calibration">official_calibration</option>
                <option value="benchmark_holdout">benchmark_holdout</option>
                <option value="diagnostic">diagnostic</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-[var(--text-secondary)] mb-1">Test Batch</label>
              <select
                value={calBatch}
                onChange={(e) => setCalBatch(e.target.value)}
                className="w-full px-3 py-2 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] text-sm"
              >
                <option value="">All Batches</option>
                <option value="SMOKE">Golden Smoke Pack</option>
                <option value="PT1">Official Practice Test 1</option>
                <option value="PT2">Official Practice Test 2</option>
                <option value="PT3">Official Practice Test 3 (Holdout)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-[var(--text-secondary)] mb-1">Question Format</label>
              <select
                value={calFormat}
                onChange={(e) => setCalFormat(e.target.value)}
                className="w-full px-3 py-2 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] text-sm"
              >
                <option value="">All Formats</option>
                <option value="READ_FICTION_MCQ">READ_FICTION_MCQ</option>
                <option value="READ_VOCAB_CLOZE">READ_VOCAB_CLOZE</option>
                <option value="READ_POETRY_MCQ">READ_POETRY_MCQ</option>
                <option value="READ_GAPPED_TEXT">READ_GAPPED_TEXT</option>
                <option value="READ_MULTIPLE_MATCH">READ_MULTIPLE_MATCH</option>
                <option value="MATH_MCQ_5">MATH_MCQ_5</option>
                <option value="THINK_MCQ_4">THINK_MCQ_4</option>
                <option value="WRIT_TYPED_TASK">WRIT_TYPED_TASK</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-[var(--text-secondary)] mb-1">Skill Family</label>
              <select
                value={calSkillFamily}
                onChange={(e) => {
                  setCalSkillFamily(e.target.value);
                  setCalSkillId('');
                }}
                className="w-full px-3 py-2 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] text-sm"
              >
                <option value="">All Families</option>
                {skillFamilies.map((fam) => (
                  <option key={fam} value={fam}>
                    {fam}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-[var(--text-secondary)] mb-1">Specific Skill</label>
              <select
                value={calSkillId}
                onChange={(e) => setCalSkillId(e.target.value)}
                className="w-full px-3 py-2 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] text-sm"
              >
                <option value="">All Skills (74)</option>
                {SKILLS_TAXONOMY.filter((s) => !calSkillFamily || s.familyCode === calSkillFamily).map((s) => (
                  <option key={s.skillId} value={s.skillId}>
                    {s.displayName}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-[var(--text-secondary)] mb-1">QC Status</label>
              <select
                value={calQcStatus}
                onChange={(e) => setCalQcStatus(e.target.value)}
                className="w-full px-3 py-2 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] text-sm"
              >
                <option value="">Any Status</option>
                <option value="active">active</option>
                <option value="quarantined">quarantined</option>
                <option value="verified">verified</option>
                <option value="draft">draft</option>
              </select>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs font-semibold text-[var(--text-secondary)] mb-1">Questions</label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={calLimit}
                  onChange={(e) => setCalLimit(e.target.value)}
                  className="w-full px-3 py-2 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] text-sm tabular-nums"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-[var(--text-secondary)] mb-1">Timer (min, 0=off)</label>
                <input
                  type="number"
                  min={0}
                  max={240}
                  value={calTimerMin}
                  onChange={(e) => setCalTimerMin(e.target.value)}
                  className="w-full px-3 py-2 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] text-sm tabular-nums"
                />
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4 pt-3 border-t border-[var(--border-hairline)]">
            <label className="inline-flex items-center gap-2 text-xs font-medium text-[var(--text-primary)] cursor-pointer">
              <input
                type="checkbox"
                checked={calSandbox}
                onChange={(e) => setCalSandbox(e.target.checked)}
                className="accent-[var(--accent-primary)]"
              />
              <span>Sandbox Mode (do not alter student SM-2 intervals or certified mastery stats)</span>
            </label>

            <button
              type="button"
              disabled={launchingCal}
              onClick={handleLaunchCalibration}
              className="px-5 py-2.5 rounded-[var(--radius-sm)] bg-[var(--accent-primary)] hover:bg-[var(--accent-primary-hover)] text-white text-sm font-semibold inline-flex items-center gap-2 cursor-pointer disabled:opacity-60"
            >
              <Play className="w-4 h-4 fill-current" />
              <span>{launchingCal ? 'Launching...' : 'Launch Calibration Simulator'}</span>
            </button>
          </div>
        </section>
      )}

      {/* TAB 3: Bank Importer + Batch History */}
      {tab === 'importer' && (
        <div className="space-y-6">
          <section className="p-6 rounded-[var(--radius-lg)] bg-[var(--bg-elevated)] border border-[var(--border-hairline)] space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-[var(--text-primary)]">Bank Manifest Importer</h2>
                <p className="text-xs text-[var(--text-secondary)]">
                  Validate JSON manifests via dry-run before committing version-bumped updates (historical attempts are preserved).
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const data = await api.getImportSchema();
                      await navigator.clipboard.writeText(JSON.stringify(data.schema, null, 2));
                      setNotice('Copied V3 AI JSON Schema to clipboard.');
                    } catch {
                      setError('Unable to copy JSON Schema.');
                    }
                  }}
                  className="px-3 py-2 rounded-[var(--radius-sm)] border border-[var(--border-strong)] text-xs font-semibold cursor-pointer hover:bg-[var(--bg-surface)] inline-flex items-center gap-1.5"
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span>Copy AI JSON Schema</span>
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const data = await api.getImportSchema();
                      const pretty = JSON.stringify(data.starterExample, null, 2);
                      setManifestText(pretty);
                      setDryRunReport(null);
                      setNotice('Loaded V3 starter manifest template into editor.');
                    } catch {
                      setError('Unable to load starter template.');
                    }
                  }}
                  className="px-3 py-2 rounded-[var(--radius-sm)] border border-[var(--border-strong)] text-xs font-semibold cursor-pointer hover:bg-[var(--bg-surface)]"
                >
                  Load Starter Template
                </button>
                <label className="px-3.5 py-2 rounded-[var(--radius-sm)] border border-[var(--border-strong)] text-xs font-semibold cursor-pointer hover:bg-[var(--bg-surface)] inline-flex items-center gap-1.5">
                  <Upload className="w-3.5 h-3.5" />
                  <span>Load .json File</span>
                  <input
                    type="file"
                    accept=".json,application/json"
                    className="sr-only"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        setManifestText(await file.text());
                        setDryRunReport(null);
                      }
                    }}
                  />
                </label>
              </div>
            </div>

            <textarea
              rows={10}
              value={manifestText}
              onChange={(e) => {
                setManifestText(e.target.value);
                setDryRunReport(null);
              }}
              placeholder='Paste BankImportManifest JSON here ({"manifestVersion": "1.0", ...})'
              className="w-full p-3.5 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] font-mono text-xs text-[var(--text-primary)]"
            />

            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={!manifestText.trim()}
                onClick={handleDryRun}
                className="px-4 py-2 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-surface)] text-xs font-semibold cursor-pointer disabled:opacity-50"
              >
                Dry-Run Validate
              </button>
              <button
                type="button"
                disabled={!dryRunReport?.valid}
                onClick={handleCommitManifest}
                className="px-4 py-2 rounded-[var(--radius-sm)] bg-[var(--accent-primary)] text-white text-xs font-semibold cursor-pointer disabled:opacity-50"
              >
                Commit Import
              </button>
            </div>

            {dryRunReport && (
              <div className="p-4 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] bg-[var(--bg-canvas)] text-xs space-y-2">
                <div className="font-bold text-[var(--text-primary)]">
                  Dry-Run {dryRunReport.valid ? 'Passed' : 'Failed'} · Batch: {dryRunReport.batchLabel}
                </div>
                <div className="tabular-nums text-[var(--text-secondary)]">
                  Stimuli: {dryRunReport.stimuliCount} · Questions: {dryRunReport.questionsCount} · New:{' '}
                  {dryRunReport.newQuestions} · Version-Bumped: {dryRunReport.versionBumpedQuestions} · Unchanged:{' '}
                  {dryRunReport.unchangedQuestions}
                </div>
                {dryRunReport.errors.map((err, i) => (
                  <div key={i} className="text-[var(--status-error)]">
                    Error: {err}
                  </div>
                ))}
                {dryRunReport.warnings.map((w, i) => (
                  <div key={i} className="text-[var(--status-warn)]">
                    Warning: {w}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Recent Import Batches */}
          <section className="p-6 rounded-[var(--radius-lg)] bg-[var(--bg-elevated)] border border-[var(--border-hairline)] space-y-4">
            <h3 className="text-sm font-bold text-[var(--text-primary)]">
              Import Batch Ledger ({batches.length})
            </h3>
            {batches.length === 0 ? (
              <p className="text-xs text-[var(--text-secondary)]">No import batches recorded yet.</p>
            ) : (
              <div className="overflow-x-auto border border-[var(--border-hairline)] rounded-[var(--radius-sm)]">
                <table className="w-full text-xs text-left tabular-nums">
                  <thead className="bg-[var(--bg-surface)] border-b border-[var(--border-hairline)] text-[var(--text-secondary)]">
                    <tr>
                      <th className="px-3 py-2 font-semibold">Batch Label</th>
                      <th className="px-3 py-2 font-semibold">Batch ID</th>
                      <th className="px-3 py-2 font-semibold">Imported</th>
                      <th className="px-3 py-2 font-semibold">Counts</th>
                      <th className="px-3 py-2 font-semibold text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border-hairline)]">
                    {batches.map((b) => (
                      <tr key={b.batchId}>
                        <td className="px-3 py-2 font-medium text-[var(--text-primary)]">{b.batchLabel}</td>
                        <td className="px-3 py-2 font-mono text-[11px] text-[var(--text-secondary)]">{b.batchId}</td>
                        <td className="px-3 py-2 text-[var(--text-muted)]">{formatTimestampSafe(b.createdAtIso)}</td>
                        <td className="px-3 py-2">
                          {b.questionsCount} Qs · {b.stimuliCount} stim
                        </td>
                        <td className="px-3 py-2 text-right space-x-2">
                          <button
                            type="button"
                            onClick={() => {
                              setBBatchId(b.batchId);
                              setBrowserPage(1);
                              setTab('browser');
                            }}
                            className="text-[var(--accent-primary)] font-semibold hover:underline cursor-pointer"
                          >
                            Browse
                          </button>
                          <button
                            type="button"
                            onClick={async () => {
                              const res = await api.createCalibrationSession({
                                batchId: b.batchId,
                                isSandbox: true,
                                limit: 50,
                              });
                              onOpenSession(res.sessionId);
                            }}
                            className="text-[var(--text-primary)] font-semibold hover:underline cursor-pointer"
                          >
                            Simulate Batch
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}

      {/* TAB 4: Config Editor */}
      {tab === 'config' && configDraft && (
        <section className="p-6 rounded-[var(--radius-lg)] bg-[var(--bg-elevated)] border border-[var(--border-hairline)] space-y-6">
          <div>
            <h2 className="text-lg font-bold text-[var(--text-primary)]">
              Learning Config Editor (Active: v{configVersionNum})
            </h2>
            <p className="text-xs text-[var(--text-secondary)]">
              Saving creates an immutable `admin_config_versions` record.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            <div className="space-y-3">
              <h3 className="text-xs font-semibold text-[var(--text-secondary)]">
                Daily Practice &amp; Drill Limits
              </h3>
              {(['READ', 'MATH', 'THINK', 'WRIT'] as const).map((sec) => (
                <div key={sec} className="flex items-center justify-between gap-2 text-xs">
                  <label className="font-medium text-[var(--text-primary)]">Daily {sec} Questions</label>
                  <NumericConfigInput
                    min={0}
                    max={40}
                    value={configDraft.sessionDefaults.dailyQuestionLimitBySection[sec] ?? 0}
                    onCommit={(val) =>
                      setConfigDraft({
                        ...configDraft,
                        sessionDefaults: {
                          ...configDraft.sessionDefaults,
                          dailyQuestionLimitBySection: {
                            ...configDraft.sessionDefaults.dailyQuestionLimitBySection,
                            [sec]: val,
                          },
                        },
                      })
                    }
                    className="w-20 px-2.5 py-1.5 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] tabular-nums"
                  />
                </div>
              ))}
              <div className="flex items-center justify-between gap-2 text-xs">
                <label className="font-medium text-[var(--text-primary)]">Daily Goal (min)</label>
                <NumericConfigInput
                  min={5}
                  max={180}
                  value={configDraft.sessionDefaults.dailyGoalMinutes}
                  onCommit={(val) =>
                    setConfigDraft({
                      ...configDraft,
                      sessionDefaults: {
                        ...configDraft.sessionDefaults,
                        dailyGoalMinutes: val,
                      },
                    })
                  }
                  className="w-20 px-2.5 py-1.5 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] tabular-nums"
                />
              </div>
              <div className="pt-2 border-t border-[var(--border-hairline)] flex items-center justify-between gap-2 text-xs">
                <label className="font-medium text-[var(--text-primary)]">Practice Drill Questions</label>
                <NumericConfigInput
                  min={1}
                  max={40}
                  value={configDraft.sessionDefaults.sectionDrillQuestionCount ?? 10}
                  onCommit={(val) =>
                    setConfigDraft({
                      ...configDraft,
                      sessionDefaults: {
                        ...configDraft.sessionDefaults,
                        sectionDrillQuestionCount: val,
                      },
                    })
                  }
                  className="w-20 px-2.5 py-1.5 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] tabular-nums"
                />
              </div>
              <div className="flex items-center justify-between gap-2 text-xs">
                <label className="font-medium text-[var(--text-primary)]">Practice Drill Time (min)</label>
                <NumericConfigInput
                  min={1}
                  max={120}
                  value={configDraft.sessionDefaults.sectionDrillTimeMinutes ?? 8}
                  onCommit={(val) =>
                    setConfigDraft({
                      ...configDraft,
                      sessionDefaults: {
                        ...configDraft.sessionDefaults,
                        sectionDrillTimeMinutes: val,
                      },
                    })
                  }
                  className="w-20 px-2.5 py-1.5 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] tabular-nums"
                />
              </div>
            </div>

            <div className="space-y-3">
              <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)]">
                SM-2 &amp; Scheduling Weights
              </h3>
              {(
                [
                  ['spacedReviewWeight', 'Spaced Review Weight', 0, 10, 0.1],
                  ['weakestSkillWeight', 'Weakest Skill Weight', 0, 10, 0.1],
                  ['noveltyCoverageWeight', 'Novelty Weight', 0, 10, 0.1],
                  ['minRepeatCooldownHours', 'Cooldown (hours)', 0, 168, 1],
                  ['sm2EaseFloor', 'SM-2 Ease Floor', 1.1, 3.0, 0.1],
                ] as const
              ).map(([field, label, min, max, step]) => (
                <div key={field} className="flex items-center justify-between gap-2 text-xs">
                  <label className="font-medium text-[var(--text-primary)]">{label}</label>
                  <NumericConfigInput
                    min={min}
                    max={max}
                    step={step}
                    value={configDraft.scheduling[field]}
                    onCommit={(val) =>
                      setConfigDraft({
                        ...configDraft,
                        scheduling: { ...configDraft.scheduling, [field]: val },
                      })
                    }
                    className="w-24 px-2.5 py-1.5 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] tabular-nums"
                  />
                </div>
              ))}
            </div>

            <div className="space-y-3">
              <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)]">
                Calibration &amp; Plateau
              </h3>
              <div className="flex items-center justify-between gap-2 text-xs">
                <label className="font-medium text-[var(--text-primary)]">Target Success Min</label>
                <NumericConfigInput
                  min={0.1}
                  max={0.95}
                  step={0.05}
                  value={configDraft.calibration.targetSuccessRateRange[0]}
                  onCommit={(val) =>
                    setConfigDraft({
                      ...configDraft,
                      calibration: {
                        ...configDraft.calibration,
                        targetSuccessRateRange: [val, configDraft.calibration.targetSuccessRateRange[1]],
                      },
                    })
                  }
                  className="w-24 px-2.5 py-1.5 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] tabular-nums"
                />
              </div>
              <div className="flex items-center justify-between gap-2 text-xs">
                <label className="font-medium text-[var(--text-primary)]">Target Success Max</label>
                <NumericConfigInput
                  min={0.1}
                  max={1.0}
                  step={0.05}
                  value={configDraft.calibration.targetSuccessRateRange[1]}
                  onCommit={(val) =>
                    setConfigDraft({
                      ...configDraft,
                      calibration: {
                        ...configDraft.calibration,
                        targetSuccessRateRange: [configDraft.calibration.targetSuccessRateRange[0], val],
                      },
                    })
                  }
                  className="w-24 px-2.5 py-1.5 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] tabular-nums"
                />
              </div>
              <div className="flex items-center justify-between gap-2 text-xs">
                <label className="font-medium text-[var(--text-primary)]">Plateau Min Attempts</label>
                <NumericConfigInput
                  min={1}
                  max={50}
                  step={1}
                  value={configDraft.plateauDetection.minAttemptsForEvaluation}
                  onCommit={(val) =>
                    setConfigDraft({
                      ...configDraft,
                      plateauDetection: {
                        ...configDraft.plateauDetection,
                        minAttemptsForEvaluation: Math.round(val),
                      },
                    })
                  }
                  className="w-24 px-2.5 py-1.5 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] tabular-nums"
                />
              </div>
              <div className="flex items-center justify-between gap-2 text-xs">
                <label className="font-medium text-[var(--text-primary)]">Stagnant Ceiling</label>
                <NumericConfigInput
                  min={0.1}
                  max={1.0}
                  step={0.05}
                  value={configDraft.plateauDetection.stagnantAccuracyCeiling}
                  onCommit={(val) =>
                    setConfigDraft({
                      ...configDraft,
                      plateauDetection: {
                        ...configDraft.plateauDetection,
                        stagnantAccuracyCeiling: val,
                      },
                    })
                  }
                  className="w-24 px-2.5 py-1.5 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] tabular-nums"
                />
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-4 border-t border-[var(--border-hairline)]">
            <input
              type="text"
              value={configNotes}
              onChange={(e) => setConfigNotes(e.target.value)}
              placeholder="Version change note (optional)"
              className="flex-1 min-w-56 px-3 py-2 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] text-sm"
            />
            <button
              type="button"
              onClick={handleSaveConfig}
              className="px-5 py-2 rounded-[var(--radius-sm)] bg-[var(--accent-primary)] hover:bg-[var(--accent-primary-hover)] text-white text-sm font-semibold cursor-pointer"
            >
              Save New Config Version
            </button>
          </div>

          {configHistory.length > 0 && (
            <div className="text-xs text-[var(--text-secondary)] space-y-1">
              <div className="font-semibold text-[var(--text-primary)]">Version History</div>
              {configHistory.slice(0, 6).map((h) => (
                <div key={h.configVersionId} className="tabular-nums">
                  v{h.versionNumber} · {new Date(h.createdAt).toLocaleString()}
                  {h.notes ? ` · ${h.notes}` : ''}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* TAB 5: Backup, Restore & Migration Preflight */}
      {tab === 'backup' && (
        <div className="space-y-6">
          <section className="p-6 rounded-[var(--radius-lg)] bg-[var(--bg-elevated)] border border-[var(--border-hairline)] space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-[var(--text-primary)]">Managed Google Runtime Diagnostics</h2>
                <p className="text-xs text-[var(--text-secondary)]">
                  Live redacted probe of Firebase Admin, Firestore named DB, Cloud Storage bucket, and managed secret readiness.
                </p>
              </div>
              <button
                type="button"
                disabled={loadingDiagnostics}
                onClick={loadDiagnostics}
                className="px-4 py-2 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-surface)] text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loadingDiagnostics ? 'animate-spin' : ''}`} />
                <span>Refresh Diagnostics</span>
              </button>
            </div>
            {diagnostics && (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 text-xs tabular-nums">
                <div className="p-3 rounded-[var(--radius-sm)] bg-[var(--bg-canvas)] border border-[var(--border-hairline)] space-y-1">
                  <div className="font-semibold text-[var(--text-primary)]">Firebase Project &amp; Config</div>
                  <div>Config: {diagnostics.configSource}</div>
                  <div className="font-mono break-all">Project: {diagnostics.projectId}</div>
                  <div className="font-mono break-all">DB ID: {diagnostics.firestoreDatabaseId}</div>
                  <div className="font-mono break-all">Bucket: {diagnostics.storageBucket}</div>
                </div>
                <div className="p-3 rounded-[var(--radius-sm)] bg-[var(--bg-canvas)] border border-[var(--border-hairline)] space-y-1">
                  <div className="font-semibold text-[var(--text-primary)]">Runtime Identity &amp; Secrets</div>
                  <div>Backend: {diagnostics.runtimeBackend} ({diagnostics.credentialMode})</div>
                  <div className="font-mono break-all">
                    SA: {diagnostics.runtimeServiceAccount || 'none / local'}
                  </div>
                  <div>Session Secret: {diagnostics.sessionSecretConfigured ? 'Configured' : 'Ephemeral/Unset'}</div>
                  <div>
                    Gemini Decisions: {diagnostics.geminiModel || 'gemini-4-hydrogen'} (
                    {diagnostics.geminiConfigured ? 'Configured' : 'Unset'})
                  </div>
                  <div>Local PIN Auth: {diagnostics.localDevPinEnabled ? 'Enabled' : 'Disabled'}</div>
                </div>
                <div className="p-3 rounded-[var(--radius-sm)] bg-[var(--bg-canvas)] border border-[var(--border-hairline)] space-y-1">
                  <div className="font-semibold text-[var(--text-primary)]">Storage Probes</div>
                  <div
                    className={
                      diagnostics.firestoreProbe.ok ? 'text-[var(--status-success)] font-semibold' : 'text-[var(--status-error)] font-semibold'
                    }
                  >
                    Firestore: {diagnostics.firestoreProbe.ok ? `OK (${diagnostics.firestoreProbe.latencyMs}ms)` : `Error (${diagnostics.firestoreProbe.errorCode || 'ERR'})`}
                  </div>
                  {diagnostics.firestoreProbe.errorMessage && (
                    <div className="text-[var(--text-secondary)] break-words">
                      {diagnostics.firestoreProbe.errorMessage}
                    </div>
                  )}
                  <div
                    className={
                      diagnostics.storageProbe.ok ? 'text-[var(--status-success)] font-semibold' : 'text-[var(--status-error)] font-semibold'
                    }
                  >
                    Cloud Storage: {diagnostics.storageProbe.ok ? 'Bucket Accessible' : `Unavailable`}
                  </div>
                  {diagnostics.storageProbe.error && (
                    <div className="text-[var(--text-secondary)] break-words">{diagnostics.storageProbe.error}</div>
                  )}
                </div>
              </div>
            )}
          </section>

          <section className="p-6 rounded-[var(--radius-lg)] bg-[var(--bg-elevated)] border border-[var(--border-hairline)] space-y-4">
            <h2 className="text-lg font-bold text-[var(--text-primary)]">Full Canonical Database Backup</h2>
            <p className="text-sm text-[var(--text-secondary)]">
              Download a complete canonical JSON bundle (`v3_canonical_1.0`) containing stimuli, questions, import batches, config versions, per-user profiles, sessions, snapshots, part attempts, skill states, mastery evidence, writing submissions, flags, and media asset metadata.
            </p>
            <a
              href="/api/admin/backup"
              onClick={(e) => {
                e.preventDefault();
                api.downloadFile('/api/admin/backup', 'selective-lab-backup.json');
              }}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-[var(--radius-sm)] bg-[var(--text-primary)] text-white text-sm font-semibold hover:opacity-90"
            >
              <Download className="w-4 h-4" />
              <span>Download Full JSON Backup</span>
            </a>
          </section>

          <section className="p-6 rounded-[var(--radius-lg)] bg-[var(--bg-elevated)] border border-[var(--border-hairline)] space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-bold text-[var(--text-primary)]">Restore Canonical Backup (Dry-Run &amp; Apply)</h2>
                <p className="text-xs text-[var(--text-secondary)]">
                  Validate a canonical backup JSON before applying idempotent upserts.
                </p>
              </div>
              <label className="px-3 py-1.5 rounded-[var(--radius-sm)] border border-[var(--border-strong)] text-xs font-semibold cursor-pointer hover:bg-[var(--bg-surface)] inline-flex items-center gap-1.5">
                <Upload className="w-3.5 h-3.5" />
                <span>Load Backup .json</span>
                <input
                  type="file"
                  accept=".json,application/json"
                  className="sr-only"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      setRestoreJson(await file.text());
                      setRestoreReport(null);
                    }
                  }}
                />
              </label>
            </div>
            <textarea
              rows={6}
              value={restoreJson}
              onChange={(e) => {
                setRestoreJson(e.target.value);
                setRestoreReport(null);
              }}
              placeholder='Paste v3_canonical_1.0 backup JSON here...'
              className="w-full p-3 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] font-mono text-xs"
            />
            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={!restoreJson.trim()}
                onClick={() => handleRunRestore(true)}
                className="px-4 py-2 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-surface)] text-xs font-semibold cursor-pointer disabled:opacity-50"
              >
                Dry-Run Restore
              </button>
              <button
                type="button"
                disabled={!restoreReport?.valid}
                onClick={() => handleRunRestore(false)}
                className="px-4 py-2 rounded-[var(--radius-sm)] bg-[var(--accent-primary)] text-white text-xs font-semibold cursor-pointer disabled:opacity-50"
              >
                Apply Restore
              </button>
            </div>
            {restoreReport && (
              <div className="p-4 rounded-[var(--radius-sm)] bg-[var(--bg-canvas)] border border-[var(--border-hairline)] text-xs space-y-1.5 tabular-nums">
                <div className="font-bold">
                  {restoreReport.dryRun ? 'Dry-Run' : 'Applied'} · Valid: {String(restoreReport.valid)} · Checksum verified: {String(restoreReport.checksumVerified)}
                </div>
                {Object.keys(restoreReport.wouldCreate || {}).length > 0 && (
                  <div>
                    <strong>Would Create:</strong>{' '}
                    {Object.entries(restoreReport.wouldCreate).map(([k, v]) => `${k}: ${v}`).join(' · ')}
                  </div>
                )}
                {Object.keys(restoreReport.wouldSkipExisting || {}).length > 0 && (
                  <div>
                    <strong>Already Existing (Skip):</strong>{' '}
                    {Object.entries(restoreReport.wouldSkipExisting).map(([k, v]) => `${k}: ${v}`).join(' · ')}
                  </div>
                )}
                {!restoreReport.dryRun && Object.keys(restoreReport.applied || {}).length > 0 && (
                  <div className="text-[var(--status-success)] font-semibold">
                    <strong>Applied:</strong>{' '}
                    {Object.entries(restoreReport.applied).map(([k, v]) => `${k}: ${v}`).join(' · ')}
                  </div>
                )}
                {restoreReport.errors.map((er, i) => (
                  <div key={i} className="text-[var(--status-error)]">Error: {er}</div>
                ))}
                {restoreReport.warnings.map((w, i) => (
                  <div key={i} className="text-[var(--status-warn)]">Warning: {w}</div>
                ))}
              </div>
            )}
          </section>

          <section className="p-6 rounded-[var(--radius-lg)] bg-[var(--bg-elevated)] border border-[var(--border-hairline)] space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-bold text-[var(--text-primary)]">Migration Preflight &amp; Media Manifest</h2>
                <p className="text-xs text-[var(--text-secondary)]">
                  Inspect legacy missing revisions/snapshots and detect any `/assets/uploads/*` binaries needing Cloud Storage migration.
                </p>
              </div>
              <button
                type="button"
                disabled={loadingPreflight}
                onClick={handleLoadPreflight}
                className="px-4 py-2 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-surface)] text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loadingPreflight ? 'animate-spin' : ''}`} />
                <span>Run Preflight Scan</span>
              </button>
            </div>

            {preflightReport && (
              <div className="space-y-3 text-xs tabular-nums">
                <div className="p-3.5 rounded-[var(--radius-sm)] bg-[var(--bg-canvas)] border border-[var(--border-hairline)] space-y-1">
                  <div>
                    <strong>Backend:</strong> {preflightReport.backendName} ·{' '}
                    <strong>Questions:</strong> {preflightReport.totalQuestions} ·{' '}
                    <strong>Sessions:</strong> {preflightReport.totalSessions} ·{' '}
                    <strong>Attempts:</strong> {preflightReport.totalPartAttempts}
                  </div>
                  <div>
                    <strong>Sessions Missing Snapshots:</strong> {preflightReport.sessionsMissingSnapshots} ·{' '}
                    <strong>Questions Missing EvidenceRev:</strong> {preflightReport.questionsMissingEvidenceRevision} ·{' '}
                    <strong>Attempts Missing EvidenceRev:</strong> {preflightReport.attemptsMissingEvidenceRevision} ·{' '}
                    <strong>Legacy Untagged:</strong> {preflightReport.legacyUntaggedAttempts}
                  </div>
                  <div>
                    <strong>Media Manifest:</strong> {preflightReport.mediaNeedsUploadCount} needs upload ·{' '}
                    {preflightReport.mediaMissingFilesCount} missing local binary
                    {mediaManifest ? ` · ${mediaManifest.alreadyGcsCount} already GCS` : ''}
                  </div>
                </div>

                {mediaManifest && mediaManifest.items.length > 0 && (
                  <div className="overflow-x-auto border border-[var(--border-hairline)] rounded-[var(--radius-sm)]">
                    <table className="w-full text-xs text-left">
                      <thead className="bg-[var(--bg-surface)] border-b border-[var(--border-hairline)]">
                        <tr>
                          <th className="px-3 py-2 font-semibold">Source Path</th>
                          <th className="px-3 py-2 font-semibold">Status</th>
                          <th className="px-3 py-2 font-semibold">Suggested GCS Key</th>
                          <th className="px-3 py-2 font-semibold">Referenced By</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--border-hairline)]">
                        {mediaManifest.items.map((item) => (
                          <tr key={item.sourcePath}>
                            <td className="px-3 py-2 font-mono">{item.sourcePath}</td>
                            <td className="px-3 py-2 font-semibold">{item.status}</td>
                            <td className="px-3 py-2 font-mono">{item.suggestedObjectKey}</td>
                            <td className="px-3 py-2">{item.referencedByIds.join(', ') || 'unreferenced'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
