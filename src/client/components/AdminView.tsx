import { useCallback, useEffect, useState } from 'react';
import {
  Database,
  FolderKanban,
  Library,
  ShieldCheck,
  Sliders,
  X,
} from 'lucide-react';
import { api, type AdminStatusResponse } from '../api';
import { QuestionBankStudio } from './admin/QuestionBankStudio';
import { AutoCalibrateConfigPanel } from './admin/AutoCalibrateConfigPanel';
import { BatchImporterPanel } from './admin/BatchImporterPanel';
import { DataAndDesignPanel } from './admin/DataAndDesignPanel';

interface AdminViewProps {
  onOpenSession: (sessionId: string) => void;
}

type StudioTab = 'bank' | 'adaptive' | 'batches' | 'data';

function parseInitialTab(): StudioTab {
  const raw = new URLSearchParams(window.location.search).get('tab');
  if (raw === 'bank' || raw === 'browser' || raw === 'calibration') return 'bank';
  if (raw === 'adaptive' || raw === 'config') return 'adaptive';
  if (raw === 'batches' || raw === 'importer') return 'batches';
  if (raw === 'data' || raw === 'backup') return 'data';
  return 'bank';
}

const STUDIO_TABS: { id: StudioTab; label: string; icon: typeof Library }[] = [
  { id: 'bank', label: 'Question Bank', icon: Library },
  { id: 'adaptive', label: 'Daily & Adaptive', icon: Sliders },
  { id: 'batches', label: 'Import & Batches', icon: FolderKanban },
  { id: 'data', label: 'Data & Design', icon: Database },
];

export function AdminView({ onOpenSession }: AdminViewProps) {
  const [tab, setTab] = useState<StudioTab>(parseInitialTab);
  const [status, setStatus] = useState<AdminStatusResponse | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [jumpBatchId, setJumpBatchId] = useState('');

  const loadStatus = useCallback(async () => {
    try {
      const res = await api.getAdminStatus();
      setStatus(res);
    } catch {
      // ignore initial status fetch errors; individual panels surface errors
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    qs.set('tab', tab);
    if (tab !== 'bank') {
      qs.delete('qid');
    }
    const nextSearch = `?${qs.toString()}`;
    if (window.location.search !== nextSearch) {
      window.history.replaceState({}, '', `${window.location.pathname}${nextSearch}`);
    }
  }, [tab]);

  const handleNotice = useCallback((msg: string) => {
    setError('');
    setNotice(msg);
  }, []);

  const handleError = useCallback((msg: string) => {
    setNotice('');
    setError(msg);
  }, []);

  const handleOpenBatchInBank = useCallback((batchId: string) => {
    setJumpBatchId(batchId);
    setTab('bank');
  }, []);

  return (
    <main className="px-6 sm:px-9 py-8 space-y-6 max-w-[1220px] mx-auto">
      {/* Header */}
      <header className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="font-sans-display font-semibold text-[26px] sm:text-[30px] tracking-[-0.025em] text-[#113C36] leading-tight">
            Admin studio
          </h1>
          <p className="text-[14px] text-[#4A5955]">
            Manage the unified Question Bank, Gemini Decisions 1 daily calibration, batches, and study data.
          </p>
        </div>

        {status && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="px-3 py-1 rounded-full bg-[#F3EFE8] text-[#113C36] font-medium tabular-nums">
              {status.totalQuestions} in Question Bank
            </span>
            <span
              className={`px-3 py-1 rounded-full font-medium inline-flex items-center gap-1 ${
                status.holdoutIsolationOk
                  ? 'bg-[#E5F0EA] text-[#113C36]'
                  : 'bg-[#FDECEB] text-[#B83A28]'
              }`}
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>
                {status.holdoutIsolationOk
                  ? `${status.holdoutQuestionCount} holdout isolated`
                  : `${status.leakedCount} holdout leaked`}
              </span>
            </span>
            {status.openFlagsCount > 0 && (
              <button
                type="button"
                onClick={() => setTab('data')}
                className="px-3 py-1 rounded-full bg-[#FDF0E2] text-[#A35116] font-medium cursor-pointer"
              >
                {status.openFlagsCount} open flag{status.openFlagsCount === 1 ? '' : 's'}
              </button>
            )}
          </div>
        )}
      </header>

      {/* Shared Notice / Error Banners */}
      {notice && (
        <div
          role="status"
          className="px-4 py-3 rounded-[12px] bg-[#E5F0EA] border border-[#C5DDD1] text-[#113C36] text-xs font-medium flex items-center justify-between gap-3"
        >
          <span>{notice}</span>
          <button
            type="button"
            aria-label="Dismiss notice"
            onClick={() => setNotice('')}
            className="text-[#4A5955] hover:text-[#113C36] cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="px-4 py-3 rounded-[12px] bg-[#FDECEB] border border-[#B83A28]/25 text-[#B83A28] text-xs font-medium flex items-center justify-between gap-3"
        >
          <span>{error}</span>
          <button
            type="button"
            aria-label="Dismiss error"
            onClick={() => setError('')}
            className="text-[#B83A28] cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* 4 Clean Editorial Tabs */}
      <nav
        aria-label="Admin studio sections"
        className="flex flex-wrap items-center gap-1.5 p-1.5 rounded-[14px] bg-[#F3EFE8] border border-[#E5DFD5] w-fit"
      >
        {STUDIO_TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`px-3.5 py-2 rounded-[10px] text-xs font-sans-display font-semibold inline-flex items-center gap-1.5 transition-all cursor-pointer ${
                active
                  ? 'bg-white text-[#113C36] shadow-[0_1px_2px_rgba(17,60,54,0.08)]'
                  : 'text-[#4A5955] hover:text-[#113C36]'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{t.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Active Tab Panel */}
      {tab === 'bank' && (
        <QuestionBankStudio
          initialBatchId={jumpBatchId}
          onClearInitialBatch={() => setJumpBatchId('')}
          onOpenSession={onOpenSession}
          onNotice={handleNotice}
          onError={handleError}
          onDataMutated={() => void loadStatus()}
        />
      )}

      {tab === 'adaptive' && (
        <AutoCalibrateConfigPanel onNotice={handleNotice} onError={handleError} />
      )}

      {tab === 'batches' && (
        <BatchImporterPanel
          onOpenBatchInBank={handleOpenBatchInBank}
          onOpenSession={onOpenSession}
          onNotice={handleNotice}
          onError={handleError}
          onDataMutated={() => void loadStatus()}
        />
      )}

      {tab === 'data' && (
        <DataAndDesignPanel
          onNotice={handleNotice}
          onError={handleError}
          onDataMutated={() => void loadStatus()}
        />
      )}
    </main>
  );
}
