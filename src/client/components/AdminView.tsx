import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { CheckCircle2, Copy, Download, Play, ShieldCheck, Upload } from 'lucide-react';
import { api, type AdminStatusResponse } from '../api';
import type {
  BankImportManifest,
  LearningConfig,
  QuestionFlagRecord,
  QuestionItem,
  StimulusGroup,
} from '../../shared/contracts';
import { SKILLS_TAXONOMY } from '../../shared/skills';
import { VisualRenderer } from './VisualRenderer';

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

type AdminTab = 'calibration' | 'qc' | 'importer' | 'config' | 'backup';

export function AdminView({ onOpenSession }: AdminViewProps) {
  const [tab, setTab] = useState<AdminTab>('calibration');
  const [status, setStatus] = useState<AdminStatusResponse | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

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

  // QC & Visual Manager State
  const [questions, setQuestions] = useState<QuestionItem[]>([]);
  const [stimuliById, setStimuliById] = useState<Record<string, StimulusGroup>>({});
  const [qcFilterSection, setQcFilterSection] = useState('');
  const [qcFilterPool, setQcFilterPool] = useState('');
  const [qcFilterStatus, setQcFilterStatus] = useState('');
  const [qcSearch, setQcSearch] = useState('');
  const [flags, setFlags] = useState<QuestionFlagRecord[]>([]);
  const [uploadingQid, setUploadingQid] = useState<string | null>(null);

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

  const loadAdminOverview = useCallback(async () => {
    try {
      const [st, qRes, flRes, cfgRes] = await Promise.all([
        api.getAdminStatus(),
        api.getAdminQuestions(),
        api.getAdminFlags(),
        api.getAdminConfig(),
      ]);
      setStatus(st);
      setQuestions(qRes.questions);
      setStimuliById(qRes.stimuliById);
      setFlags(flRes.flags);
      setConfigDraft(cfgRes.active.config);
      setConfigVersionNum(cfgRes.active.versionNumber);
      setConfigHistory(cfgRes.history);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load admin console.');
    }
  }, []);

  useEffect(() => {
    loadAdminOverview();
  }, [loadAdminOverview]);

  const skillFamilies = useMemo(
    () => Array.from(new Set(SKILLS_TAXONOMY.map((s) => s.familyCode))),
    []
  );

  const filteredQuestions = useMemo(() => {
    return questions.filter((q) => {
      if (qcFilterSection && q.section !== qcFilterSection) return false;
      if (qcFilterPool && q.poolType !== qcFilterPool) return false;
      if (qcFilterStatus && q.qcStatus !== qcFilterStatus) return false;
      if (qcSearch.trim()) {
        const needle = qcSearch.toLowerCase();
        const hay = `${q.questionId} ${q.stemPrefix || ''} ${q.parts.map((p) => p.promptText + ' ' + p.skillId).join(' ')}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [questions, qcFilterSection, qcFilterPool, qcFilterStatus, qcSearch]);

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
      setQuestions((prev) =>
        prev.map((item) => (item.questionId === q.questionId ? { ...item, qcStatus: nextStatus } : item))
      );
      setNotice(`Updated ${q.questionId} to ${nextStatus}.`);
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
      setQuestions((prev) =>
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
        `Committed manifest: ${res.result.imported} imported, ${res.result.versionBumped} version-bumped, ${res.result.skipped} unchanged.`
      );
      setDryRunReport(null);
      await loadAdminOverview();
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

  return (
    <main className="max-w-6xl mx-auto px-6 py-8 space-y-6">
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
              <span className={status.holdoutIsolationOk ? 'text-[var(--status-success)] font-semibold' : 'text-[var(--status-error)] font-semibold'}>
                <ShieldCheck className="w-3.5 h-3.5 inline mr-1" />
                Holdout isolation: {status.holdoutIsolationOk ? 'Verified (0 leaks)' : `${status.leakedCount} leaked`}
              </span>
              <span aria-hidden="true">·</span>
              <span>Open flags: {status.openFlagsCount}</span>
              <span aria-hidden="true">·</span>
              <span>Config v{status.activeConfigVersion}</span>
            </div>
          )}
        </div>
      </div>

      {/* Tab Bar */}
      <div className="flex flex-wrap gap-1.5 p-1 bg-[var(--bg-surface)] rounded-[var(--radius-md)] w-fit border border-[var(--border-hairline)]">
        {(
          [
            ['calibration', 'Calibration Simulator'],
            ['qc', 'Question QC & Visuals'],
            ['importer', 'Bank Importer'],
            ['config', 'Config Editor'],
            ['backup', 'Backup & Export'],
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

      {/* TAB 1: Calibration & QA Practice Simulator */}
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
              <span>Sandbox Mode (do not alter student SM-2 intervals or mastery stats)</span>
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

      {/* TAB 2: Question QC & Visual Manager */}
      {tab === 'qc' && (
        <section className="space-y-6">
          {flags.filter((f) => f.status === 'open').length > 0 && (
            <div className="p-5 rounded-[var(--radius-md)] bg-[var(--status-warn-bg)] border border-[var(--status-warn)]/30 space-y-3">
              <h2 className="text-sm font-bold text-[var(--status-warn)]">Open Student Issue Flags</h2>
              {flags
                .filter((f) => f.status === 'open')
                .map((fl) => (
                  <div key={fl.flagId} className="flex items-center justify-between gap-4 text-xs bg-[var(--bg-elevated)] p-3 rounded-[var(--radius-sm)]">
                    <div>
                      <strong>{fl.questionId}</strong> · {fl.reason}
                      {fl.notes ? ` — "${fl.notes}"` : ''}
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        await api.resolveFlag(fl.flagId);
                        await loadAdminOverview();
                      }}
                      className="px-2.5 py-1 rounded-[var(--radius-sm)] border border-[var(--border-strong)] font-semibold cursor-pointer"
                    >
                      Mark Resolved
                    </button>
                  </div>
                ))}
            </div>
          )}

          <div className="p-5 rounded-[var(--radius-md)] bg-[var(--bg-elevated)] border border-[var(--border-hairline)] flex flex-wrap gap-3">
            <input
              type="text"
              placeholder="Search question ID, prompt, or skill..."
              value={qcSearch}
              onChange={(e) => setQcSearch(e.target.value)}
              className="flex-1 min-w-56 px-3 py-2 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] text-sm"
            />
            <select
              value={qcFilterSection}
              onChange={(e) => setQcFilterSection(e.target.value)}
              className="px-3 py-2 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] text-sm"
            >
              <option value="">All Sections</option>
              <option value="READ">READ</option>
              <option value="MATH">MATH</option>
              <option value="THINK">THINK</option>
              <option value="WRIT">WRIT</option>
            </select>
            <select
              value={qcFilterPool}
              onChange={(e) => setQcFilterPool(e.target.value)}
              className="px-3 py-2 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] text-sm"
            >
              <option value="">All Pools</option>
              <option value="practice">practice</option>
              <option value="official_calibration">official_calibration</option>
              <option value="benchmark_holdout">benchmark_holdout</option>
            </select>
            <select
              value={qcFilterStatus}
              onChange={(e) => setQcFilterStatus(e.target.value)}
              className="px-3 py-2 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] text-sm"
            >
              <option value="">All QC Statuses</option>
              <option value="active">active</option>
              <option value="quarantined">quarantined</option>
              <option value="verified">verified</option>
              <option value="draft">draft</option>
            </select>
          </div>

          <div className="space-y-3">
            {filteredQuestions.slice(0, 40).map((q) => {
              const stim = q.stimulusId ? stimuliById[q.stimulusId] : undefined;
              return (
                <article
                  key={q.questionId}
                  className="p-5 rounded-[var(--radius-md)] bg-[var(--bg-elevated)] border border-[var(--border-hairline)] space-y-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="text-xs font-bold text-[var(--text-primary)] tabular-nums">
                      {q.questionId} · v{q.version} · {q.section} · {q.formatType} · Pool: {q.poolType} · QC: {q.qcStatus}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleToggleQcStatus(q, 'active')}
                        className={`px-2.5 py-1 rounded-[var(--radius-sm)] border text-xs font-semibold cursor-pointer ${
                          q.qcStatus === 'active'
                            ? 'border-[var(--status-success)] bg-[var(--status-success-bg)] text-[var(--status-success)]'
                            : 'border-[var(--border-strong)]'
                        }`}
                      >
                        Active
                      </button>
                      <button
                        type="button"
                        onClick={() => handleToggleQcStatus(q, 'quarantined')}
                        className={`px-2.5 py-1 rounded-[var(--radius-sm)] border text-xs font-semibold cursor-pointer ${
                          q.qcStatus === 'quarantined'
                            ? 'border-[var(--status-error)] bg-[var(--status-error-bg)] text-[var(--status-error)]'
                            : 'border-[var(--border-strong)]'
                        }`}
                      >
                        Quarantine
                      </button>
                      <label className="px-2.5 py-1 rounded-[var(--radius-sm)] border border-[var(--border-strong)] text-xs font-semibold cursor-pointer hover:bg-[var(--bg-surface)] inline-flex items-center gap-1">
                        <Upload className="w-3 h-3" />
                        <span>{uploadingQid === q.questionId ? 'Uploading...' : 'Attach Image'}</span>
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp,image/svg+xml"
                          className="sr-only"
                          onChange={(e) => handleUploadVisual(q.questionId, e)}
                        />
                      </label>
                    </div>
                  </div>

                  <p className="text-sm text-[var(--text-primary)]">
                    {q.stemPrefix ? `${q.stemPrefix} ` : ''}
                    {q.parts[0]?.promptText || stim?.title}
                  </p>
                  <div className="text-xs text-[var(--text-secondary)]">
                    Skill: {q.parts[0]?.skillId} · Key: <strong>{q.parts[0]?.correctAnswerKey || 'Writing'}</strong> ·{' '}
                    {q.provenance.sourceReference || q.provenance.sourceType}
                  </div>
                  {(q.visual || stim?.visual) && <VisualRenderer visual={q.visual || stim?.visual} compact />}
                </article>
              );
            })}
            {filteredQuestions.length > 40 && (
              <p className="text-xs text-[var(--text-muted)] text-center">
                Showing first 40 of {filteredQuestions.length} matching questions. Narrow filters above to inspect more.
              </p>
            )}
          </div>
        </section>
      )}

      {/* TAB 3: Bank Importer */}
      {tab === 'importer' && (
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
                Stimuli: {dryRunReport.stimuliCount} · Questions: {dryRunReport.questionsCount} · New: {dryRunReport.newQuestions} · Version-Bumped: {dryRunReport.versionBumpedQuestions} · Unchanged: {dryRunReport.unchangedQuestions}
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
                  ['spacedReviewWeight', 'Spaced Review Weight', 0.1],
                  ['weakestSkillWeight', 'Weakest Skill Weight', 0.1],
                  ['noveltyCoverageWeight', 'Novelty Weight', 0.1],
                  ['minRepeatCooldownHours', 'Cooldown (hours)', 1],
                  ['sm2EaseFloor', 'SM-2 Ease Floor', 0.1],
                ] as const
              ).map(([field, label, step]) => (
                <div key={field} className="flex items-center justify-between gap-2 text-xs">
                  <label className="font-medium text-[var(--text-primary)]">{label}</label>
                  <input
                    type="number"
                    step={step}
                    value={configDraft.scheduling[field]}
                    onChange={(e) =>
                      setConfigDraft({
                        ...configDraft,
                        scheduling: { ...configDraft.scheduling, [field]: Number(e.target.value) },
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
                <input
                  type="number"
                  step={0.05}
                  value={configDraft.calibration.targetSuccessRateRange[0]}
                  onChange={(e) =>
                    setConfigDraft({
                      ...configDraft,
                      calibration: {
                        ...configDraft.calibration,
                        targetSuccessRateRange: [
                          Number(e.target.value),
                          configDraft.calibration.targetSuccessRateRange[1],
                        ],
                      },
                    })
                  }
                  className="w-24 px-2.5 py-1.5 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] tabular-nums"
                />
              </div>
              <div className="flex items-center justify-between gap-2 text-xs">
                <label className="font-medium text-[var(--text-primary)]">Target Success Max</label>
                <input
                  type="number"
                  step={0.05}
                  value={configDraft.calibration.targetSuccessRateRange[1]}
                  onChange={(e) =>
                    setConfigDraft({
                      ...configDraft,
                      calibration: {
                        ...configDraft.calibration,
                        targetSuccessRateRange: [
                          configDraft.calibration.targetSuccessRateRange[0],
                          Number(e.target.value),
                        ],
                      },
                    })
                  }
                  className="w-24 px-2.5 py-1.5 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] tabular-nums"
                />
              </div>
              <div className="flex items-center justify-between gap-2 text-xs">
                <label className="font-medium text-[var(--text-primary)]">Plateau Min Attempts</label>
                <input
                  type="number"
                  value={configDraft.plateauDetection.minAttemptsForEvaluation}
                  onChange={(e) =>
                    setConfigDraft({
                      ...configDraft,
                      plateauDetection: {
                        ...configDraft.plateauDetection,
                        minAttemptsForEvaluation: Number(e.target.value),
                      },
                    })
                  }
                  className="w-24 px-2.5 py-1.5 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] tabular-nums"
                />
              </div>
              <div className="flex items-center justify-between gap-2 text-xs">
                <label className="font-medium text-[var(--text-primary)]">Stagnant Ceiling</label>
                <input
                  type="number"
                  step={0.05}
                  value={configDraft.plateauDetection.stagnantAccuracyCeiling}
                  onChange={(e) =>
                    setConfigDraft({
                      ...configDraft,
                      plateauDetection: {
                        ...configDraft.plateauDetection,
                        stagnantAccuracyCeiling: Number(e.target.value),
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

      {/* TAB 5: Backup & Export */}
      {tab === 'backup' && (
        <section className="p-6 rounded-[var(--radius-lg)] bg-[var(--bg-elevated)] border border-[var(--border-hairline)] space-y-4">
          <h2 className="text-lg font-bold text-[var(--text-primary)]">Full Database Backup</h2>
          <p className="text-sm text-[var(--text-secondary)]">
            Download a complete JSON snapshot of all stimuli, questions, config versions, sessions, part attempts, skill states, writing submissions, and QC flags.
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
      )}
    </main>
  );
}
