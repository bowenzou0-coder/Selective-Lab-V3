import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Database,
  FolderKanban,
  Library,
  Search,
  ShieldCheck,
  Sliders,
  Star,
  UserRound,
  Users,
  X,
} from 'lucide-react';
import {
  api,
  type AdminLearnerSummary,
  type AdminLearnersResponse,
  type AdminStatusResponse,
} from '../api';
import { useI18n } from '../i18n';
import {
  LEARNER_PICKER_RESULT_LIMIT,
  filterAndSortLearners,
  getLearnerDisplayName,
} from './admin/learnerScopeUtils';
import { buildBankQuestionHref, readAdminDeepLink, type StudioTab } from './admin/adminDeepLink';
import { QuestionBankStudio } from './admin/QuestionBankStudio';
import { StatusBanner } from './ui/StatusBanner';
import { Toast } from './ui/Toast';
import { useSlidingIndicator } from './ui/useSlidingIndicator';

// Secondary tabs load on first open; the bank (default tab) ships with the admin chunk.
const LearnersPanel = lazy(() =>
  import('./admin/LearnersPanel').then((m) => ({ default: m.LearnersPanel }))
);
const AutoCalibrateConfigPanel = lazy(() =>
  import('./admin/AutoCalibrateConfigPanel').then((m) => ({ default: m.AutoCalibrateConfigPanel }))
);
const BatchImporterPanel = lazy(() =>
  import('./admin/BatchImporterPanel').then((m) => ({ default: m.BatchImporterPanel }))
);
const DataAndDesignPanel = lazy(() =>
  import('./admin/DataAndDesignPanel').then((m) => ({ default: m.DataAndDesignPanel }))
);

function TabFallback() {
  return (
    <div aria-hidden="true" className="space-y-3">
      <div className="h-24 animate-pulse rounded-[16px] bg-[#F3EFE8]" />
      <div className="h-64 animate-pulse rounded-[16px] bg-[#F3EFE8]" />
    </div>
  );
}

interface AdminViewProps {
  onOpenSession: (sessionId: string) => void;
  currentUserId?: string | null;
}

function parseInitialTab(): StudioTab {
  return readAdminDeepLink(window.location.search).tab;
}

const STUDIO_TABS: {
  id: StudioTab;
  labelKey: 'admin.tabBank' | 'admin.tabLearners' | 'admin.tabAdaptive' | 'admin.tabBatches' | 'admin.tabData';
  icon: typeof Library;
}[] = [
  { id: 'bank', labelKey: 'admin.tabBank', icon: Library },
  { id: 'learners', labelKey: 'admin.tabLearners', icon: Users },
  { id: 'adaptive', labelKey: 'admin.tabAdaptive', icon: Sliders },
  { id: 'batches', labelKey: 'admin.tabBatches', icon: FolderKanban },
  { id: 'data', labelKey: 'admin.tabData', icon: Database },
];

/**
 * Clean learner scope switcher: shows ONLY Primary + Myself quick buttons
 * (plus the currently selected learner if picked from search) alongside an inline
 * search bar for jumping to any other learner or Catalog-only mode.
 */
function LearnerScopeBar({
  learnersData,
  selectedLearnerId,
  currentUserId,
  pinningPrimary,
  activeTab,
  onSelectLearner,
  onSetPrimary,
  onOpenLearnersTab,
}: {
  learnersData: AdminLearnersResponse;
  selectedLearnerId: string;
  currentUserId?: string | null;
  pinningPrimary: boolean;
  activeTab: StudioTab;
  onSelectLearner: (id: string) => void;
  onSetPrimary: (id: string | null) => void;
  onOpenLearnersTab: () => void;
}) {
  const { t } = useI18n();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchWrapRef = useRef<HTMLDivElement | null>(null);

  const learners = learnersData.learners;
  const selectedLearner =
    selectedLearnerId && selectedLearnerId !== 'none'
      ? learners.find((l) => l.uid === selectedLearnerId) ?? null
      : null;
  const isCatalogMode = selectedLearnerId === 'none' || !selectedLearner;
  const isPrimarySelected = Boolean(
    selectedLearner && learnersData.primaryMonitoredStudentId === selectedLearner.uid
  );

  // Build clean 1–2 quick buttons: Primary learner + Myself (plus active searched learner if different)
  const quickButtons = useMemo(() => {
    const out: AdminLearnerSummary[] = [];
    const seen = new Set<string>();
    const add = (l?: AdminLearnerSummary | null) => {
      if (!l || seen.has(l.uid)) return;
      seen.add(l.uid);
      out.push(l);
    };
    if (learnersData.primaryMonitoredStudentId) {
      add(learners.find((l) => l.uid === learnersData.primaryMonitoredStudentId));
    }
    if (currentUserId) {
      add(learners.find((l) => l.uid === currentUserId));
    }
    if (selectedLearner && !seen.has(selectedLearner.uid)) {
      add(selectedLearner);
    }
    return out;
  }, [learners, learnersData.primaryMonitoredStudentId, currentUserId, selectedLearner]);

  const filteredSearchLearners = useMemo(
    () => filterAndSortLearners(learners, { query: searchQuery }),
    [learners, searchQuery]
  );
  const visibleSearchLearners = filteredSearchLearners.slice(0, LEARNER_PICKER_RESULT_LIMIT);

  useEffect(() => {
    if (!searchOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (searchWrapRef.current && !searchWrapRef.current.contains(e.target as Node)) {
        setSearchOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSearchOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [searchOpen]);

  return (
    <section
      aria-label={t('admin.learnerScopeTitle')}
      className="rounded-[14px] border border-[#E5DFD5] bg-[#FAF8F5] px-4 py-3 space-y-2.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex flex-wrap items-center gap-2 min-w-0 flex-1">
          <span className="text-xs font-sans-display font-semibold text-[#4A5955] whitespace-nowrap">
            {t('admin.viewingProgressFor')}:
          </span>

          {quickButtons.map((l) => {
            const isSelected = l.uid === selectedLearnerId;
            const isPrimary = l.uid === learnersData.primaryMonitoredStudentId;
            const isYou = Boolean(currentUserId && l.uid === currentUserId);
            return (
              <button
                key={l.uid}
                type="button"
                aria-pressed={isSelected}
                onClick={() => onSelectLearner(l.uid)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-sans-display font-semibold cursor-pointer transition-tactile whitespace-nowrap ${
                  isSelected
                    ? 'bg-[#113C36] border-[#113C36] text-white'
                    : 'bg-white border-[#D8D1C6] text-[#113C36] hover:border-[#113C36]/50'
                }`}
              >
                {isPrimary ? (
                  <Star className="w-3 h-3 shrink-0 fill-current" aria-hidden="true" />
                ) : (
                  <UserRound className="w-3 h-3 shrink-0 opacity-75" aria-hidden="true" />
                )}
                <span>{getLearnerDisplayName(l)}</span>
                {isYou && (
                  <span
                    className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium ${
                      isSelected ? 'bg-white/20 text-white' : 'bg-[#EFEAE0] text-[#4A5955]'
                    }`}
                  >
                    {t('admin.youTag')}
                  </span>
                )}
              </button>
            );
          })}

          {/* Inline Search Bar for All Other Learners & Catalog Mode */}
          <div ref={searchWrapRef} className="relative flex-1 min-w-[190px] max-w-[280px]">
            <Search
              className="w-3.5 h-3.5 text-[#615E57] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <input
              type="search"
              value={searchQuery}
              onFocus={() => setSearchOpen(true)}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setSearchOpen(true);
              }}
              placeholder={t('admin.searchLearnersPlaceholder', { count: learners.length })}
              aria-label={t('admin.searchLearnersPlaceholder', { count: learners.length })}
              className="w-full rounded-full border border-[#D8D1C6] bg-white py-1.5 pl-8 pr-7 text-xs text-[#113C36] placeholder:text-[#615E57] focus:border-[#113C36] focus:outline-none [&::-webkit-search-cancel-button]:hidden"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label={t('learners.clearFiltersBtn')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#615E57] hover:text-[#113C36] cursor-pointer p-0.5"
              >
                <X className="w-3 h-3" aria-hidden="true" />
              </button>
            )}

            {searchOpen && (
              <div className="absolute left-0 top-[calc(100%+6px)] z-30 w-[min(22rem,calc(100vw-2rem))] rounded-[14px] border border-[#E5DFD5] bg-white shadow-[0_14px_34px_rgba(17,60,54,0.14)] p-2 space-y-1.5">
                <button
                  type="button"
                  onClick={() => {
                    onSelectLearner('none');
                    setSearchOpen(false);
                    setSearchQuery('');
                  }}
                  className={`w-full px-3 py-2 rounded-[10px] text-left flex items-center justify-between gap-2 text-xs cursor-pointer transition-tactile ${
                    isCatalogMode ? 'bg-[#E5F0EA]/70 text-[#113C36] font-semibold' : 'hover:bg-[#FAF8F5] text-[#4A5955]'
                  }`}
                >
                  <span className="inline-flex items-center gap-2">
                    <Library className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    <span>{t('admin.noLearnerCatalogPill')}</span>
                  </span>
                  {isCatalogMode && <Check className="w-3.5 h-3.5 text-[#113C36] shrink-0" />}
                </button>

                <div className="max-h-60 overflow-y-auto divide-y divide-[#F2EDE4] rounded-[10px] border border-[#EFEAE0]">
                  {visibleSearchLearners.length === 0 ? (
                    <div className="px-3 py-4 text-center text-xs text-[#615E57]">
                      {t('admin.pickerNoMatches')}
                    </div>
                  ) : (
                    visibleSearchLearners.map((l) => {
                      const isSelected = l.uid === selectedLearnerId;
                      const isPrimary = l.uid === learnersData.primaryMonitoredStudentId;
                      const isYou = Boolean(currentUserId && l.uid === currentUserId);
                      return (
                        <button
                          key={l.uid}
                          type="button"
                          onClick={() => {
                            onSelectLearner(l.uid);
                            setSearchOpen(false);
                            setSearchQuery('');
                          }}
                          className={`w-full px-3 py-2 text-left flex items-center justify-between gap-2.5 cursor-pointer transition-tactile ${
                            isSelected ? 'bg-[#E5F0EA]/65' : 'hover:bg-[#FAF8F5]'
                          }`}
                        >
                          <div className="flex items-start gap-2 min-w-0">
                            {isPrimary ? (
                              <Star className="w-3.5 h-3.5 text-[#113C36] fill-current shrink-0 mt-0.5" aria-hidden="true" />
                            ) : (
                              <UserRound className="w-3.5 h-3.5 text-[#4A5955] shrink-0 mt-0.5" aria-hidden="true" />
                            )}
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-1.5 text-xs font-sans-display font-semibold text-[#113C36]">
                                <span className="truncate">{getLearnerDisplayName(l)}</span>
                                {isYou && (
                                  <span className="px-1.5 py-0.5 rounded-full bg-[#EFEAE0] text-[10px] font-medium text-[#4A5955]">
                                    {t('admin.youTag')}
                                  </span>
                                )}
                              </div>
                              {l.email && (
                                <div className="text-[11px] text-[#615E57] truncate">{l.email}</div>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            {l.sessionsCount > 0 && (
                              <span className="px-1.5 py-0.5 rounded-full bg-[#F3EFE8] text-[10px] font-medium text-[#4A5955] tabular-nums">
                                {l.sessionsCount}
                              </span>
                            )}
                            {isSelected && <Check className="w-3.5 h-3.5 text-[#113C36]" />}
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>

                {filteredSearchLearners.length > LEARNER_PICKER_RESULT_LIMIT && (
                  <p className="text-[11px] text-[#615E57] px-1">
                    {t('admin.pickerTruncatedHint', {
                      shown: LEARNER_PICKER_RESULT_LIMIT,
                      total: filteredSearchLearners.length,
                    })}
                  </p>
                )}
              </div>
            )}
          </div>

          {isCatalogMode && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#113C36] text-white text-[11px] font-sans-display font-semibold whitespace-nowrap">
              <Library className="w-3 h-3 shrink-0" aria-hidden="true" />
              <span>{t('admin.noLearnerCatalogPill')}</span>
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={onOpenLearnersTab}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] border text-xs font-sans-display font-semibold cursor-pointer transition-tactile whitespace-nowrap shrink-0 ${
            activeTab === 'learners'
              ? 'border-[#113C36] bg-[#E5F0EA] text-[#113C36]'
              : 'border-[#CFC6B9] bg-white text-[#113C36] hover:bg-[#F3EFE8]'
          }`}
        >
          <Users className="w-3.5 h-3.5" />
          <span>{t('admin.compareAllBtn', { count: learners.length })}</span>
        </button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#4A5955]">
        <span>
          {isCatalogMode
            ? t('admin.scopeCatalogHint')
            : selectedLearner.role === 'admin'
              ? t('admin.scopeAdminHint', {
                  name: getLearnerDisplayName(selectedLearner),
                  sessions: selectedLearner.sessionsCount,
                  attempts: selectedLearner.attemptsCount,
                })
              : t('admin.scopeStudentHint', {
                  name: getLearnerDisplayName(selectedLearner),
                  pct: selectedLearner.unseenLivePercent,
                  done: selectedLearner.doneLiveCount,
                  sessions: selectedLearner.sessionsCount,
                  days: selectedLearner.estimatedRunwayDays,
                })}
        </span>

        {selectedLearner && (
          <button
            type="button"
            disabled={pinningPrimary}
            onClick={() => onSetPrimary(isPrimarySelected ? null : selectedLearner.uid)}
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-[8px] border text-[11px] font-sans-display font-semibold cursor-pointer transition-tactile disabled:opacity-50 whitespace-nowrap ${
              isPrimarySelected
                ? 'border-[#113C36]/30 bg-[#E5F0EA] text-[#113C36]'
                : 'border-[#D8D1C6] bg-white text-[#4A5955] hover:text-[#113C36]'
            }`}
          >
            <Star className={`w-3 h-3 shrink-0 ${isPrimarySelected ? 'fill-current' : ''}`} aria-hidden="true" />
            <span>{isPrimarySelected ? t('learners.primaryPinnedBtn') : t('learners.pinPrimaryBtn')}</span>
          </button>
        )}
      </div>
    </section>
  );
}

export function AdminView({ onOpenSession, currentUserId }: AdminViewProps) {
  const { t } = useI18n();
  const [tab, setTab] = useState<StudioTab>(parseInitialTab);
  const tabsRef = useRef<HTMLElement>(null);
  const tabIndicator = useSlidingIndicator(tabsRef, tab);
  const [status, setStatus] = useState<AdminStatusResponse | null>(null);
  const [learnersData, setLearnersData] = useState<AdminLearnersResponse | null>(null);
  const [learnersLoaded, setLearnersLoaded] = useState(false);
  const [selectedLearnerId, setSelectedLearnerId] = useState<string>('');
  const [pinningPrimary, setPinningPrimary] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [jumpBatchId, setJumpBatchId] = useState('');
  // Question to open in the bank inspector (deep link or a 1-click jump from a flag).
  const [focusQid, setFocusQid] = useState(() => readAdminDeepLink(window.location.search).qid);

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
    } finally {
      setLearnersLoaded(true);
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

  const handleSetPrimary = async (nextId: string | null) => {
    const target = nextId ? learners.find((l) => l.uid === nextId) : null;
    setPinningPrimary(true);
    setError('');
    try {
      const res = await api.setPrimaryMonitoredLearner(nextId);
      setLearnersData((prev) =>
        prev
          ? {
              ...prev,
              primaryMonitoredStudentId: res.primaryMonitoredStudentId,
              defaultMonitoredStudentId:
                res.primaryMonitoredStudentId ?? prev.defaultMonitoredStudentId,
            }
          : prev
      );
      setNotice(
        nextId
          ? t('learners.pinnedNotice', {
              name: target ? getLearnerDisplayName(target) : nextId,
            })
          : t('learners.unpinnedNotice')
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : t('learners.pinError'));
    } finally {
      setPinningPrimary(false);
    }
  };

  const handleDeleteLearner = async (learner: AdminLearnerSummary) => {
    setError('');
    try {
      await api.deleteAdminLearner(learner.uid, 'DELETE');
      setNotice(t('learners.deletedNotice', { name: getLearnerDisplayName(learner) }));
      if (selectedLearnerId === learner.uid) {
        setSelectedLearnerId('');
      }
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('learners.deleteError'));
      throw err;
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
      setFocusQid('');
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

  // Back/forward between deep links re-reads the tab and question from the URL.
  useEffect(() => {
    const onPopState = () => {
      if (!window.location.pathname.startsWith('/admin')) return;
      const link = readAdminDeepLink(window.location.search);
      setTab(link.tab);
      setFocusQid(link.qid);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const handleOpenQuestionInBank = useCallback((questionId: string) => {
    const href = buildBankQuestionHref(questionId);
    if (`${window.location.pathname}${window.location.search}` !== href) {
      window.history.pushState({}, '', href);
    }
    setFocusQid(questionId);
    setTab('bank');
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, []);

  const handleOpenBatchInBank = useCallback((batchId: string) => {
    setJumpBatchId(batchId);
    setTab('bank');
  }, []);

  return (
    <main className="px-4 sm:px-7 lg:px-9 py-8 space-y-6 max-w-[1220px] mx-auto">
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
          <div className="flex flex-wrap items-center gap-2 text-xs sm:justify-end">
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

      {/* Always-visible 1-click Learner Scope Bar */}
      {learnersData && (
        <LearnerScopeBar
          learnersData={learnersData}
          selectedLearnerId={selectedLearnerId}
          currentUserId={currentUserId}
          pinningPrimary={pinningPrimary}
          activeTab={tab}
          onSelectLearner={setSelectedLearnerId}
          onSetPrimary={(id) => void handleSetPrimary(id)}
          onOpenLearnersTab={() => setTab('learners')}
        />
      )}

      {/* Shared notice toast (auto-dismisses) and persistent error banner */}
      <Toast message={notice} onDismiss={() => setNotice('')} dismissLabel={t('admin.dismissNotice')} />
      {error && (
        <StatusBanner onDismiss={() => setError('')} dismissLabel={t('admin.dismissError')}>
          {error}
        </StatusBanner>
      )}

      {/* Studio sections: one scrollable row with a sliding white pill */}
      <nav
        ref={tabsRef}
        aria-label={t('admin.sectionsAria')}
        className="relative isolate flex w-fit max-w-full items-center gap-1.5 overflow-x-auto overscroll-x-contain rounded-[14px] border border-[#E5DFD5] bg-[#F3EFE8] p-1.5 [scrollbar-width:thin]"
      >
        <span
          aria-hidden="true"
          className="sliding-indicator pointer-events-none absolute left-0 top-0 -z-10 rounded-[10px] bg-white shadow-[0_1px_2px_rgba(17,60,54,0.08)]"
          style={tabIndicator.style}
        />
        {STUDIO_TABS.map((tabItem) => {
          const Icon = tabItem.icon;
          const active = tab === tabItem.id;
          return (
            <button
              key={tabItem.id}
              type="button"
              onClick={(e) => {
                setTab(tabItem.id);
                e.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' });
              }}
              aria-current={active ? 'page' : undefined}
              data-indicator-active={active ? 'true' : undefined}
              className={`inline-flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[10px] px-3.5 py-2 font-sans-display text-xs font-semibold transition-[color,background-color,scale] duration-150 ${
                active
                  ? `text-[#113C36] ${tabIndicator.visible ? '' : 'bg-white shadow-[0_1px_2px_rgba(17,60,54,0.08)]'}`
                  : 'text-[#4A5955] hover:text-[#113C36]'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              <span>{t(tabItem.labelKey)}</span>
            </button>
          );
        })}
      </nav>

      {/* Active Tab Panel */}
      {tab === 'bank' && (
        <QuestionBankStudio
          focusQid={focusQid}
          initialBatchId={jumpBatchId}
          onClearInitialBatch={() => setJumpBatchId('')}
          onOpenSession={onOpenSession}
          onNotice={handleNotice}
          onError={handleError}
          onDataMutated={() => void loadStatus()}
          monitoredStudentId={monitoredStudentId}
          learnerReady={learnersLoaded}
          monitoredLearner={selectedLearner}
          studentCount={studentLearners.length}
        />
      )}

      <Suspense fallback={<TabFallback />}>
      {tab === 'learners' && learnersData && (
        <LearnersPanel
          learnersData={learnersData}
          selectedLearnerId={selectedLearnerId}
          currentUserId={currentUserId}
          pinningPrimary={pinningPrimary}
          onSelectLearner={setSelectedLearnerId}
          onSetPrimary={(id) => void handleSetPrimary(id)}
          onDeleteLearner={handleDeleteLearner}
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
          monitoredStudentId={monitoredStudentId}
        />
      )}

      {tab === 'data' && (
        <DataAndDesignPanel
          onOpenQuestion={handleOpenQuestionInBank}
          onNotice={handleNotice}
          onError={handleError}
          onDataMutated={() => void loadStatus()}
          monitoredStudentId={monitoredStudentId}
          monitoredLearner={selectedLearner}
        />
      )}
      </Suspense>
    </main>
  );
}
