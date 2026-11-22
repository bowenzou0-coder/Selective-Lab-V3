import { useCallback, useEffect, useState } from 'react';
import {
  Database,
  FolderKanban,
  Library,
  ShieldCheck,
  Sliders,
  X,
} from 'lucide-react';
import {
  api,
  type AdminLearnerSummary,
  type AdminLearnersResponse,
  type AdminStatusResponse,
} from '../api';
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

function LearnerMonitoringBar({
  learnersData,
  selectedLearnerId,
  onSelectLearner,
  onTogglePrimary,
  pinningPrimary,
  showAllLearners,
  onToggleAllLearners,
}: {
  learnersData: AdminLearnersResponse;
  selectedLearnerId: string;
  onSelectLearner: (id: string) => void;
  onTogglePrimary: () => void;
  pinningPrimary: boolean;
  showAllLearners: boolean;
  onToggleAllLearners: () => void;
}) {
  const { t } = useI18n();
  const learners = learnersData.learners;
  const studentLearners = learners.filter((l) => l.role !== 'admin');
  const adminLearners = learners.filter((l) => l.role === 'admin');
  const selectedLearner =
    selectedLearnerId && selectedLearnerId !== 'none'
      ? learners.find((l) => l.uid === selectedLearnerId) ?? null
      : null;
  const isPrimarySelected = Boolean(
    selectedLearner &&
      learnersData.primaryMonitoredStudentId === selectedLearner.uid,
  );
  const formatLearnerLabel = (l: AdminLearnerSummary) =>
    l.displayName || l.email || l.uid;

  return (
    <section className="rounded-[16px] bg-[#FAF8F5] border border-[#E5DFD5] px-4 py-3.5 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5 min-w-0">
          <label
            htmlFor="admin-learner-select"
            className="text-xs font-sans-display font-semibold uppercase tracking-[0.06em] text-[#4A5955] whitespace-nowrap"
          >
            {t('learners.monitoringLabel')}
          </label>
          <select
            id="admin-learner-select"
            value={selectedLearnerId || 'none'}
            onChange={(e) => onSelectLearner(e.target.value)}
            className="rounded-[10px] border border-[#D8D1C6] bg-white px-3 py-1.5 text-xs font-medium text-[#113C36] max-w-full"
          >
            <option value="none">{t('learners.bankOnlyOption')}</option>
            {studentLearners.length > 0 && (
              <optgroup label={t('learners.studentsGroup')}>
                {studentLearners.map((l) => (
                  <option key={l.uid} value={l.uid}>
                    {`${formatLearnerLabel(l)} · ${t('learners.unseenPctShort', {
                      pct: l.unseenLivePercent,
                    })}${
                      l.uid === learnersData.primaryMonitoredStudentId ? ' ★' : ''
                    }`}
                  </option>
                ))}
              </optgroup>
            )}
            {adminLearners.length > 0 && (
              <optgroup label={t('learners.adminsGroup')}>
                {adminLearners.map((l) => (
                  <option key={l.uid} value={l.uid}>
                    {`${formatLearnerLabel(l)} (${t('learners.adminRoleTag')})`}
                  </option>
                ))}
              </optgroup>
            )}
          </select>

          {selectedLearner && (
            <button
              type="button"
              disabled={pinningPrimary}
              onClick={onTogglePrimary}
              className={`px-3 py-1.5 rounded-[10px] border text-xs font-sans-display font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                isPrimarySelected
                  ? 'border-[#113C36]/30 bg-[#113C36] text-white hover:bg-[#184E46]'
                  : 'border-[#D8D1C6] bg-white text-[#113C36] hover:bg-[#F3EFE8]'
              } disabled:opacity-50`}
            >
              {isPrimarySelected
                ? t('learners.primaryPinnedBtn')
                : t('learners.pinPrimaryBtn')}
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={onToggleAllLearners}
          className="px-3 py-1.5 rounded-[10px] border border-[#D8D1C6] bg-white hover:bg-[#F3EFE8] text-xs font-sans-display font-semibold text-[#113C36] transition-colors cursor-pointer whitespace-nowrap"
        >
          {t('learners.allLearnersToggle', { count: learners.length })}
        </button>
      </div>

      {studentLearners.length === 0 && (
        <p className="text-xs text-[#6B675E] leading-relaxed">
          {t('learners.noStudentsYetHint')}
        </p>
      )}

      {showAllLearners && (
        <div className="overflow-x-auto rounded-[12px] border border-[#E5DFD5] bg-white">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-[#EFEAE0] text-[#78756E] bg-[#FAF8F5]">
                <th className="py-2 px-3 font-medium">{t('learners.colAccount')}</th>
                <th className="py-2 px-3 font-medium text-right">{t('learners.colUnseen')}</th>
                <th className="py-2 px-3 font-medium text-right">{t('learners.colDone')}</th>
                <th className="py-2 px-3 font-medium text-right">{t('learners.colRunway')}</th>
                <th className="py-2 px-3 font-medium text-right">{t('learners.colSessions')}</th>
                <th className="py-2 px-3 font-medium text-right">{t('learners.colAction')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F2EDE4]">
              {learners.map((l) => {
                const isSelected = l.uid === selectedLearnerId;
                const isPrimary =
                  l.uid === learnersData.primaryMonitoredStudentId;
                return (
                  <tr
                    key={l.uid}
                    className={isSelected ? 'bg-[#F4FAF7]' : undefined}
                  >
                    <td className="py-2 px-3">
                      <div className="font-medium text-[#113C36] flex flex-wrap items-center gap-1.5">
                        <span>{formatLearnerLabel(l)}</span>
                        {isPrimary && (
                          <span className="px-1.5 py-0.5 rounded bg-[#113C36] text-white text-[10px]">
                            {t('learners.primaryTag')}
                          </span>
                        )}
                        {l.role === 'admin' && (
                          <span className="px-1.5 py-0.5 rounded bg-[#EFEAE0] text-[#5B5852] text-[10px]">
                            {t('learners.adminRoleTag')}
                          </span>
                        )}
                      </div>
                      {l.email && (
                        <div className="text-[11px] text-[#78756E]">{l.email}</div>
                      )}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums text-[#113C36]">
                      {l.unseenLiveCount} ({l.unseenLivePercent}%)
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums text-[#4A5955]">
                      {l.doneLiveCount}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums text-[#4A5955]">
                      {l.estimatedRunwayDays}d
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums text-[#4A5955]">
                      {l.sessionsCount}
                    </td>
                    <td className="py-2 px-3 text-right">
                      <button
                        type="button"
                        disabled={isSelected}
                        onClick={() => onSelectLearner(l.uid)}
                        className="px-2.5 py-1 rounded-[8px] border border-[#D8D1C6] bg-white hover:bg-[#F3EFE8] text-[11px] font-medium text-[#113C36] disabled:opacity-45 cursor-pointer"
                      >
                        {isSelected ? t('learners.focusedTag') : t('learners.focusBtn')}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function AdminView({ onOpenSession }: AdminViewProps) {
  const { t } = useI18n();
  const [tab, setTab] = useState<StudioTab>(parseInitialTab);
  const [status, setStatus] = useState<AdminStatusResponse | null>(null);
  const [learnersData, setLearnersData] = useState<AdminLearnersResponse | null>(null);
  const [selectedLearnerId, setSelectedLearnerId] = useState<string>('');
  const [showAllLearners, setShowAllLearners] = useState(false);
  const [pinningPrimary, setPinningPrimary] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [jumpBatchId, setJumpBatchId] = useState('');

  const loadStatus = useCallback(async () => {
    try {
      const [statusRes, learnersRes] = await Promise.all([
        api.getAdminStatus(),
        api.getAdminLearners().catch(() => null),
      ]);
      setStatus(statusRes);
      if (learnersRes) {
        setLearnersData(learnersRes);
        setSelectedLearnerId((prev) => {
          if (
            prev &&
            (prev === 'none' || learnersRes.learners.some((l) => l.uid === prev))
          ) {
            return prev;
          }
          return learnersRes.defaultMonitoredStudentId ?? 'none';
        });
      }
    } catch {
      // ignore initial status fetch errors; individual panels surface errors
    }
  }, []);

  const monitoredStudentId =
    selectedLearnerId === ''
      ? undefined
      : selectedLearnerId === 'none'
        ? null
        : selectedLearnerId;
  const learners = learnersData?.learners ?? [];
  const studentLearners = learners.filter((l) => l.role !== 'admin');
  const selectedLearner: AdminLearnerSummary | null = monitoredStudentId
    ? learners.find((l) => l.uid === monitoredStudentId) ?? null
    : null;

  const handleTogglePrimary = async () => {
    if (!selectedLearner) return;
    const isPrimarySelected =
      learnersData?.primaryMonitoredStudentId === selectedLearner.uid;
    setPinningPrimary(true);
    setError('');
    try {
      const nextId = isPrimarySelected ? null : selectedLearner.uid;
      const res = await api.setPrimaryMonitoredLearner(nextId);
      setLearnersData((prev) =>
        prev
          ? {
              ...prev,
              primaryMonitoredStudentId: res.primaryMonitoredStudentId,
              defaultMonitoredStudentId:
                res.primaryMonitoredStudentId ?? prev.defaultMonitoredStudentId,
            }
          : prev,
      );
      setNotice(
        nextId
          ? t('learners.pinnedNotice', {
              name:
                selectedLearner.displayName ||
                selectedLearner.email ||
                selectedLearner.uid,
            })
          : t('learners.unpinnedNotice'),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : t('learners.pinError'));
    } finally {
      setPinningPrimary(false);
    }
  };

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
            {(status.holdoutQuestionCount > 0 || !status.holdoutIsolationOk) && (
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
            )}
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
          monitoredStudentId={monitoredStudentId}
          monitoredLearner={selectedLearner}
          studentCount={studentLearners.length}
        />
      )}

      {tab === 'adaptive' && (
        <AutoCalibrateConfigPanel
          onNotice={handleNotice}
          onError={handleError}
          monitoredStudentId={monitoredStudentId}
          monitoredLearner={selectedLearner}
        />
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
        <div className="space-y-6">
          {learnersData && (
            <LearnerMonitoringBar
              learnersData={learnersData}
              selectedLearnerId={selectedLearnerId}
              onSelectLearner={setSelectedLearnerId}
              onTogglePrimary={() => void handleTogglePrimary()}
              pinningPrimary={pinningPrimary}
              showAllLearners={showAllLearners}
              onToggleAllLearners={() => setShowAllLearners((v) => !v)}
            />
          )}
          <DataAndDesignPanel
            onNotice={handleNotice}
            onError={handleError}
            onDataMutated={() => void loadStatus()}
            monitoredStudentId={monitoredStudentId}
            monitoredLearner={selectedLearner}
          />
        </div>
      )}
    </main>
  );
}
