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
import { useI18n } from '../i18n';
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

const STUDIO_TABS: { id: StudioTab; labelKey: 'admin.tabBank' | 'admin.tabAdaptive' | 'admin.tabBatches' | 'admin.tabData'; icon: typeof Library }[] = [
  { id: 'bank', labelKey: 'admin.tabBank', icon: Library },
  { id: 'adaptive', labelKey: 'admin.tabAdaptive', icon: Sliders },
  { id: 'batches', labelKey: 'admin.tabBatches', icon: FolderKanban },
  { id: 'data', labelKey: 'admin.tabData', icon: Database },
];

export function AdminView({ onOpenSession }: AdminViewProps) {
  const { t } = useI18n();
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
        <div className="space-y-1 min-w-0">
          <h1 className="font-sans-display font-semibold text-[26px] sm:text-[30px] tracking-[-0.025em] text-[#113C36] leading-tight">
            {t('admin.title')}
          </h1>
          <p className="text-[14px] text-[#4A5955]">
            {t('admin.subtitle')}
          </p>
        </div>

        {status && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="px-3 py-1 rounded-full bg-[#F3EFE8] text-[#113C36] font-medium tabular-nums whitespace-nowrap">
              {t('admin.inBank', { count: status.totalQuestions })}
            </span>
            <span
              className={`px-3 py-1 rounded-full font-medium inline-flex items-center gap-1 whitespace-nowrap ${
                status.holdoutIsolationOk
                  ? 'bg-[#E5F0EA] text-[#113C36]'
                  : 'bg-[#FDECEB] text-[#B83A28]'
              }`}
            >
              <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
              <span>
                {status.holdoutIsolationOk
                  ? t('admin.holdoutIsolated', { count: status.holdoutQuestionCount })
                  : t('admin.holdoutLeaked', { count: status.leakedCount })}
              </span>
            </span>
            {status.openFlagsCount > 0 && (
              <button
                type="button"
                onClick={() => setTab('data')}
                className="px-3 py-1 rounded-full bg-[#FDF0E2] text-[#A35116] font-medium cursor-pointer whitespace-nowrap"
              >
                {status.openFlagsCount === 1
                  ? t('admin.openFlagOne')
                  : t('admin.openFlagMany', { count: status.openFlagsCount })}
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
            aria-label={t('admin.dismissNotice')}
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
            aria-label={t('admin.dismissError')}
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
        className="flex flex-wrap items-center gap-1.5 p-1.5 rounded-[14px] bg-[#F3EFE8] border border-[#E5DFD5] w-fit max-w-full"
      >
        {STUDIO_TABS.map((tabItem) => {
          const Icon = tabItem.icon;
          const active = tab === tabItem.id;
          return (
            <button
              key={tabItem.id}
              type="button"
              onClick={() => setTab(tabItem.id)}
              className={`px-3.5 py-2 rounded-[10px] text-xs font-sans-display font-semibold inline-flex items-center gap-1.5 transition-all cursor-pointer whitespace-nowrap ${
                active
                  ? 'bg-white text-[#113C36] shadow-[0_1px_2px_rgba(17,60,54,0.08)]'
                  : 'text-[#4A5955] hover:text-[#113C36]'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{t(tabItem.labelKey)}</span>
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
