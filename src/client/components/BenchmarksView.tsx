import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Award,
  CheckCircle2,
  Clock,
  FileText,
  Info,
  Loader2,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { api, type CustomBatchOption } from '../api';
import { useCachedResource } from '../useCachedResource';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { Skeleton, SkeletonRegion } from './ui/Skeleton';
import { StatusBanner } from './ui/StatusBanner';
import { useI18n } from '../i18n';
import { SegmentedControl } from './ui/SegmentedControl';
import type { BenchmarkReportRecord, SectionCode } from '../../shared/contracts';
import {
  buildParentVerdict,
  evaluateNswBenchmark,
  type ApplicantGenderFilter,
  type NswPerformanceBand,
} from '../../shared/nswBenchmark';

interface BenchmarksViewProps {
  onOpenSession: (sessionId: string, isLocked?: boolean) => void;
}

const BAND_ORDER: NswPerformanceBand[] = ['lowest_50', 'next_25', 'next_15', 'top_10'];

function bandIndex(band: NswPerformanceBand): number {
  return BAND_ORDER.indexOf(band);
}

function bandChipClass(band: NswPerformanceBand): string {
  if (band === 'top_10') return 'bg-[#E5F3EC] text-[#1D6346] border-[#1D6346]/30';
  if (band === 'next_15') return 'bg-[#E5F0EA] text-[#113C36] border-[#113C36]/25';
  if (band === 'next_25') return 'bg-[#F3EFE8] text-[#4A5955] border-[#CFC6B9]';
  return 'bg-[#FDF0E2] text-[#A35116] border-[#A35116]/30';
}

function verdictHeroClass(tier: ReturnType<typeof buildParentVerdict>['tier']): string {
  if (tier === 'ruse_tier' || tier === 'top_selective') {
    return 'bg-[#E5F0EA] border-[#C5DDD1]';
  }
  if (tier === 'selective_offer') {
    return 'bg-[#EEF5F1] border-[#D4E4DC]';
  }
  if (tier === 'reserve_range') {
    return 'bg-[#FDF6EC] border-[#EED7B7]';
  }
  return 'bg-[#FAF8F5] border-[#E5DFD5]';
}

export function BenchmarksView({ onOpenSession }: BenchmarksViewProps) {
  const { t, isZh, sectionLabel, formatDate } = useI18n();
  const {
    data: hub,
    setData: setHub,
    loading,
    error: loadError,
  } = useCachedResource('benchmarks', {
    fallbackError: 'Unable to load benchmark hub.',
    onData: (res) => {
      if (res.reports.length > 0) {
        setSelectedSessionId((prev) => prev || res.reports[0].sessionId);
      }
    },
  });
  const [launchError, setLaunchError] = useState('');
  const error = launchError || (hub ? '' : loadError);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(() => hub?.reports[0]?.sessionId ?? null);
  const [genderFilter, setGenderFilter] = useState<ApplicantGenderFilter>('all');
  const [showAllAboveCutoff, setShowAllAboveCutoff] = useState(false);
  const [pendingBatch, setPendingBatch] = useState<CustomBatchOption | null>(null);
  const [launching, setLaunching] = useState(false);
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);
  const [analyzeError, setAnalyzeError] = useState('');

  const reports = hub?.reports ?? [];
  const batches = hub?.benchmarkBatches ?? [];

  const activeReport: BenchmarkReportRecord | null = useMemo(() => {
    if (reports.length === 0) return null;
    return reports.find((r) => r.sessionId === selectedSessionId) || reports[0];
  }, [reports, selectedSessionId]);

  const previousReport: BenchmarkReportRecord | null = useMemo(() => {
    if (!activeReport) return null;
    const idx = reports.findIndex((r) => r.sessionId === activeReport.sessionId);
    if (idx < 0 || idx + 1 >= reports.length) return null;
    return reports[idx + 1];
  }, [reports, activeReport]);

  const evaluatedActive = useMemo(() => {
    if (!activeReport) return null;
    return evaluateNswBenchmark({
      read: {
        score: activeReport.sections.READ.correct,
        maxScore: Math.max(1, activeReport.sections.READ.total),
      },
      math: {
        score: activeReport.sections.MATH.correct,
        maxScore: Math.max(1, activeReport.sections.MATH.total),
      },
      think: {
        score: activeReport.sections.THINK.correct,
        maxScore: Math.max(1, activeReport.sections.THINK.total),
      },
      writ: {
        score: activeReport.sections.WRIT.correct,
        maxScore: Math.max(1, activeReport.sections.WRIT.total),
      },
      difficulty: activeReport.difficulty,
      weighting: 'official_2025_equal',
      genderFilter,
    });
  }, [activeReport, genderFilter]);

  const verdict = useMemo(
    () => (evaluatedActive ? buildParentVerdict(evaluatedActive) : null),
    [evaluatedActive]
  );

  const runAnalysis = useCallback(async (sessionId: string, force = false) => {
    setAnalyzingId(sessionId);
    setAnalyzeError('');
    try {
      const res = await api.analyzeBenchmarkReport(sessionId, force);
      setHub((prev) =>
        prev
          ? {
              ...prev,
              reports: prev.reports.map((r) => (r.sessionId === sessionId ? res.report : r)),
            }
          : prev
      );
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : 'Unable to generate AI coaching brief.');
    } finally {
      setAnalyzingId((curr) => (curr === sessionId ? null : curr));
    }
  }, []);

  // Auto-generate coaching once when opening a saved report that has no cached coaching yet
  useEffect(() => {
    if (!activeReport || activeReport.aiCoaching || analyzingId === activeReport.sessionId) return;
    void runAnalysis(activeReport.sessionId, false);
  }, [activeReport, analyzingId, runAnalysis]);

  useEffect(() => {
    setShowAllAboveCutoff(false);
  }, [activeReport?.sessionId, genderFilter]);

  const handleConfirmStart = async () => {
    if (!pendingBatch || launching) return;
    setLaunching(true);
    setLaunchError('');
    try {
      const res = await api.createSession({
        mode: 'benchmark_exam',
        batchId: pendingBatch.batchId,
        timeMultiplier: 1,
      });
      setPendingBatch(null);
      onOpenSession(res.sessionId, true);
    } catch (err) {
      const activeId = (err as { activeSessionId?: string })?.activeSessionId;
      if (activeId) {
        setPendingBatch(null);
        onOpenSession(activeId, true);
        return;
      }
      setLaunchError(err instanceof Error ? err.message : t('home.unableStartSession'));
      setLaunching(false);
      setPendingBatch(null);
    }
  };

  const bandLabel = (band: NswPerformanceBand): string => {
    if (band === 'top_10') return t('bench.bandTop10');
    if (band === 'next_15') return t('bench.bandNext15');
    if (band === 'next_25') return t('bench.bandNext25');
    return t('bench.bandLowest50');
  };

  const header = (
    <header className="space-y-1.5">
      <div className="inline-flex items-center gap-1.5 text-xs font-sans-display font-semibold text-[#1D6346]">
        <ShieldCheck className="w-4 h-4 shrink-0" />
        <span>{t('bm.eyebrow')}</span>
      </div>
      <h1 className="font-sans-display font-semibold text-[28px] sm:text-[32px] tracking-[-0.025em] text-[#113C36] leading-tight">
        {t('bm.title')}
      </h1>
      <p className="text-[14px] text-[#4A5955] max-w-2xl leading-relaxed">
        {t('bm.subtitle')}
      </p>
    </header>
  );

  if (loading && !hub) {
    return (
      <main className="px-4 sm:px-7 lg:px-9 py-8 sm:py-9 space-y-10 max-w-[1160px] mx-auto text-[#113C36]">
        {header}
        <SkeletonRegion label={t('bm.loading')} className="space-y-10">
          <section className="space-y-3">
            <h2 className="font-sans-display font-semibold text-[18px] tracking-[-0.015em] text-[#113C36]">
              {t('bm.sitExamTitle')}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {[0, 1].map((card) => (
                <div
                  key={card}
                  className="p-5 rounded-[16px] bg-[#FAF8F5] border border-[#E5DFD5] flex flex-col justify-between gap-4"
                >
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <Skeleton className="h-[20px] w-16 rounded-full" />
                      <Skeleton className="h-[20px] w-20 rounded-full" />
                    </div>
                    <Skeleton className="h-[20px] w-2/3" />
                    <Skeleton className="h-[12px] w-full" />
                  </div>
                  <div className="flex items-center justify-between gap-3 pt-2 border-t border-[#E5DFD5]">
                    <Skeleton className="h-[14px] w-28" />
                    <Skeleton className="h-[32px] w-32 rounded-[10px]" />
                  </div>
                </div>
              ))}
            </div>
          </section>
          <section className="space-y-5">
            <h2 className="font-sans-display font-semibold text-[18px] tracking-[-0.015em] text-[#113C36]">
              {t('bm.savedReportsTitle')}
            </h2>
            <div className="flex flex-wrap gap-2">
              {[0, 1, 2].map((pill) => (
                <Skeleton key={pill} className="h-[54px] w-40 rounded-[12px]" />
              ))}
            </div>
            <Skeleton className="h-[260px] w-full rounded-[16px]" />
          </section>
        </SkeletonRegion>
      </main>
    );
  }

  const aboveCutoffSchools = evaluatedActive
    ? evaluatedActive.schools.filter((s) => s.deltaFromFirstRound >= 0)
    : [];
  const onLineAndReserveSchools = evaluatedActive
    ? evaluatedActive.schools.filter(
        (s) =>
          s.deltaFromFirstRound < 0 &&
          (s.status === 'borderline_offer' || s.status === 'reserve_range')
      )
    : [];
  const reachSchools = evaluatedActive
    ? evaluatedActive.schools.filter((s) => s.status === 'reach').slice(0, 3)
    : [];
  const visibleAboveSchools = showAllAboveCutoff
    ? aboveCutoffSchools
    : aboveCutoffSchools.slice(0, 6);

  const scoreDelta =
    activeReport && previousReport
      ? Number((activeReport.scaledScore120 - previousReport.scaledScore120).toFixed(1))
      : null;

  return (
    <main className="px-4 sm:px-7 lg:px-9 py-8 sm:py-9 space-y-10 max-w-[1160px] mx-auto text-[#113C36]">
      {/* Locked Official Benchmark Confirmation Modal */}
      <ConfirmDialog
        open={pendingBatch !== null}
        eyebrow={t('bm.modalEyebrow')}
        title={pendingBatch?.batchLabel}
        busy={launching}
        confirmIcon={<Play className="w-3.5 h-3.5 fill-current" />}
        confirmLabel={launching ? t('home.modalStarting') : t('bm.confirmStart')}
        cancelLabel={t('home.modalCancel')}
        onClose={() => setPendingBatch(null)}
        onConfirm={handleConfirmStart}
      >
        {pendingBatch && (
          <>
            <dl className="grid grid-cols-2 gap-3 p-4 rounded-[12px] bg-[#FAF8F5] border border-[#E5DFD5] text-xs">
              <div>
                <dt className="text-[#615E57]">{t('home.modalQuestions')}</dt>
                <dd className="mt-1 font-sans-display font-semibold text-sm text-[#113C36]">
                  {t('bm.fullPaperSummary', { count: pendingBatch.total })}
                </dd>
              </div>
              <div>
                <dt className="text-[#615E57]">{t('home.modalTimeAllowed')}</dt>
                <dd className="mt-1 font-sans-display font-semibold text-sm text-[#113C36]">
                  {t('bm.lockedTimeLabel')}
                </dd>
              </div>
            </dl>

            <div className="p-3.5 rounded-[12px] bg-[#FDF0E2] border border-[#A35116]/20 text-xs text-[#A35116] flex items-start gap-2.5 leading-relaxed">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{t('bm.lockedWarning')}</span>
            </div>
          </>
        )}
      </ConfirmDialog>

      {header}

      {error && <StatusBanner size="md">{error}</StatusBanner>}

      {/* Section 1: Reserved Official Benchmark Holdout Papers */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-sans-display font-semibold text-[18px] tracking-[-0.015em] text-[#113C36]">
            {t('bm.sitExamTitle')}
          </h2>
          <span className="text-xs text-[#615E57]">{t('bm.sitExamSub')}</span>
        </div>

        {batches.length === 0 ? (
          <div className="p-5 rounded-[14px] bg-[#FAF8F5] border border-[#E5DFD5] text-sm text-[#4A5955]">
            {t('bm.noHoldoutBatches')}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {batches.map((b, idx) => {
              const isHard =
                b.batchLabel.includes('2026-11-23') ||
                b.batchLabel.includes('b11') ||
                b.batchLabel.includes('b12');
              const completedCount = reports.filter((r) => r.batchLabel === b.batchLabel).length;
              return (
                <div
                  key={b.batchId}
                  className="p-5 rounded-[16px] bg-[#FAF8F5] border border-[#E5DFD5] flex flex-col justify-between gap-4"
                >
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="px-2.5 py-0.5 rounded-full bg-white border border-[#E5DFD5] text-[11px] font-sans-display font-semibold text-[#113C36]">
                        {t('bm.paperBadge', { num: idx + 1 })}
                      </span>
                      <span className="px-2.5 py-0.5 rounded-full bg-[#E5F0EA] text-[#1D6346] text-[11px] font-sans-display font-semibold">
                        {isHard ? t('bm.tierHard') : t('bm.tierTimed')}
                      </span>
                    </div>
                    <h3 className="font-sans-display font-semibold text-[17px] text-[#113C36]">
                      {b.batchLabel}
                    </h3>
                    <p className="text-xs text-[#4A5955] leading-relaxed">
                      {t('bm.paperBreakdown', {
                        read: b.counts.READ,
                        math: b.counts.MATH,
                        think: b.counts.THINK,
                        writ: b.counts.WRIT,
                      })}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-[#E5DFD5]">
                    <div className="flex items-center gap-2 text-xs text-[#4A5955] tabular-nums">
                      <Clock className="w-3.5 h-3.5 text-[#615E57]" />
                      <span>{t('bm.lockedTimeShort')}</span>
                      {completedCount > 0 && (
                        <span className="px-2 py-0.5 rounded-full bg-[#E5F3EC] text-[#1D6346] font-medium">
                          {t('bm.completedTimes', { count: completedCount })}
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => setPendingBatch(b)}
                      className="px-4 py-2 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-xs font-sans-display font-semibold inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap transition-[background-color,transform,translate,scale] duration-150 ease-out active:scale-[0.98]"
                    >
                      <Play className="w-3.5 h-3.5 fill-current" />
                      <span>{t('bm.startBenchmark')}</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Section 2 & 3: Saved Reports Archive + Official NSW Selective Report Card */}
      <section className="space-y-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-sans-display font-semibold text-[18px] tracking-[-0.015em] text-[#113C36]">
            {t('bm.savedReportsTitle')}
          </h2>
          <span className="text-xs text-[#615E57] tabular-nums">
            {t('bm.savedReportsCount', { count: reports.length })}
          </span>
        </div>

        {reports.length === 0 ? (
          <div className="p-7 rounded-[16px] bg-[#FAF8F5] border border-[#E5DFD5] text-center space-y-2">
            <Award className="w-7 h-7 text-[#1D6346] mx-auto opacity-80" />
            <div className="font-sans-display font-semibold text-base text-[#113C36]">
              {t('bm.emptyReportsTitle')}
            </div>
            <p className="text-xs text-[#4A5955] max-w-md mx-auto leading-relaxed">
              {t('bm.emptyReportsDesc')}
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Saved Report Selector Pills */}
            <div className="flex flex-wrap gap-2">
              {reports.map((rep) => {
                const isSelected = activeReport?.sessionId === rep.sessionId;
                return (
                  <button
                    key={rep.sessionId}
                    type="button"
                    onClick={() => setSelectedSessionId(rep.sessionId)}
                    className={`px-3.5 py-2.5 rounded-[12px] border text-left transition-[background-color,border-color,color,transform,translate,scale] duration-150 ease-out active:scale-[0.98] cursor-pointer ${
                      isSelected
                        ? 'bg-[#113C36] border-[#113C36] text-white shadow-[0_2px_8px_rgba(17,60,54,0.14)]'
                        : 'bg-white border-[#E5DFD5] text-[#113C36] hover:border-[#CFC6B9]'
                    }`}
                  >
                    <div className="flex items-center gap-2 text-xs font-sans-display font-semibold tabular-nums">
                      <span>{rep.batchLabel}</span>
                      <span
                        className={`px-1.5 py-0.5 rounded text-[11px] ${
                          isSelected ? 'bg-white/15 text-white' : 'bg-[#E5F0EA] text-[#1D6346]'
                        }`}
                      >
                        {rep.scaledScore120.toFixed(1)} / 120
                      </span>
                    </div>
                    <div
                      className={`mt-1 text-[11px] tabular-nums flex items-center gap-2 ${
                        isSelected ? 'text-white/80' : 'text-[#615E57]'
                      }`}
                    >
                      <span>{formatDate(rep.completedAtIso)}</span>
                      <span
                        className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium ${
                          isSelected
                            ? 'bg-white/15 text-white'
                            : rep.writingStatus === 'graded'
                              ? 'bg-[#E5F3EC] text-[#1D6346]'
                              : 'bg-[#FDF0E2] text-[#A35116]'
                        }`}
                      >
                        {rep.writingStatus === 'graded'
                          ? t('bm.writGradedShort')
                          : t('bm.writPendingShort')}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Official NSW Selective Report Card */}
            {activeReport && evaluatedActive && verdict && (
              <article className="rounded-[18px] bg-white border border-[#E5DFD5] shadow-[0_2px_10px_rgba(17,60,54,0.04)] overflow-hidden">
                {/* Top Parent Verdict Hero */}
                <div className={`p-6 sm:p-7 border-b ${verdictHeroClass(verdict.tier)} space-y-5`}>
                  <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
                    <div className="space-y-2 max-w-2xl">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-[#4A5955] tabular-nums">
                        <span className="px-2.5 py-0.5 rounded-full bg-white/85 border border-[#C5DDD1] font-sans-display font-semibold text-[#1D6346] text-[11px]">
                          {t('bm.officialReportBadge')}
                        </span>
                        <span className="font-medium text-[#113C36]">{activeReport.batchLabel}</span>
                        <span className="text-[#615E57]">{formatDate(activeReport.completedAtIso, true)}</span>
                        {activeReport.writingStatus === 'pending' && (
                          <span className="px-2.5 py-0.5 rounded-full bg-[#FDF0E2] border border-[#A35116]/25 text-[#A35116] font-sans-display font-semibold text-[11px]">
                            {t('bm.writingPendingPill')}
                          </span>
                        )}
                      </div>
                      <h3 className="font-serif-display font-bold text-[24px] sm:text-[28px] leading-[1.2] tracking-[-0.02em] text-[#113C36]">
                        {isZh ? verdict.headlineZh : verdict.headlineEn}
                      </h3>
                      <p className="text-[13px] text-[#4A5955] leading-relaxed">
                        {isZh ? verdict.sublineZh : verdict.sublineEn}
                      </p>
                    </div>

                    {/* Single /120 Score Block + Trend + Gender Filter */}
                    <div className="flex flex-col sm:items-end gap-3 shrink-0">
                      <div className="flex max-w-full flex-wrap items-baseline gap-x-2.5 gap-y-1.5 bg-white px-4 py-3 rounded-[14px] border border-[#E5DFD5]">
                        <span className="font-serif-display font-extrabold text-[40px] leading-none tracking-[-0.03em] text-[#113C36] tabular-nums">
                          {evaluatedActive.scaledScore120.toFixed(1)}
                        </span>
                        <div className="space-y-0.5 tabular-nums">
                          <div className="text-xs font-sans-display font-semibold text-[#4A5955]">
                            / 120 (±{evaluatedActive.uncertaintyHalfWidth120})
                          </div>
                          <div className="text-[11px] text-[#615E57]">
                            {t('bm.rankCompact', {
                              rank: evaluatedActive.estimatedStateRank.toLocaleString(),
                              topPct: Math.max(0.1, 100 - evaluatedActive.estimatedPercentile).toFixed(1),
                            })}
                          </div>
                        </div>
                        {scoreDelta !== null && (
                          <span
                            className={`ml-1 inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[11px] font-sans-display font-semibold tabular-nums ${
                              scoreDelta >= 0
                                ? 'bg-[#E5F3EC] text-[#1D6346]'
                                : 'bg-[#FDECEB] text-[#B42318]'
                            }`}
                          >
                            {scoreDelta >= 0 ? (
                              <TrendingUp className="w-3 h-3" />
                            ) : (
                              <TrendingDown className="w-3 h-3" />
                            )}
                            {scoreDelta >= 0 ? `+${scoreDelta.toFixed(1)}` : scoreDelta.toFixed(1)}
                          </span>
                        )}
                      </div>

                      <SegmentedControl<ApplicantGenderFilter>
                        ariaLabel={t('bench.genderFilterLabel')}
                        className="bg-white/85 border-[#E5DFD5]"
                        segmentClassName="px-3 py-1"
                        value={genderFilter}
                        onChange={setGenderFilter}
                        options={[
                          { value: 'all', label: t('bench.genderAll') },
                          { value: 'girls', label: t('bench.genderGirls') },
                          { value: 'boys', label: t('bench.genderBoys') },
                        ]}
                      />
                    </div>
                  </div>
                </div>

                <div className="p-5 sm:p-7 space-y-8">
                  {/* Official NSW 4-Section Performance Report (4-Band Bars + Accuracies + Unanswered) */}
                  <section className="space-y-3.5">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h4 className="font-sans-display font-semibold text-base text-[#113C36]">
                        {t('bm.sectionReportTitle')}
                      </h4>
                      <span className="text-xs text-[#615E57]">{t('bm.sectionReportSub')}</span>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
                      {(['READ', 'MATH', 'THINK', 'WRIT'] as SectionCode[]).map((sec) => {
                        const snap = activeReport.sections[sec];
                        const activeBandIdx = bandIndex(snap.band);
                        return (
                          <div
                            key={sec}
                            className="p-4 rounded-[14px] bg-[#FAF8F5] border border-[#E5DFD5] space-y-3 tabular-nums"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="font-sans-display font-semibold text-sm text-[#113C36]">
                                  {sectionLabel(sec)}
                                </div>
                                <div className="text-xs text-[#4A5955] mt-0.5">
                                  {sec === 'WRIT'
                                    ? snap.isAssumed
                                      ? t('bm.writAssumedMeta', { score: snap.correct, total: snap.total })
                                      : t('bm.writGradedMeta', {
                                          score: snap.correct,
                                          total: snap.total,
                                          pct: snap.accuracyPct.toFixed(0),
                                        })
                                    : t('bm.objSectionMeta', {
                                        correct: snap.correct,
                                        total: snap.total,
                                        pct: snap.accuracyPct.toFixed(0),
                                        unanswered: snap.unanswered,
                                      })}
                                </div>
                              </div>
                              <span
                                className={`px-2.5 py-0.5 rounded-full border text-[11px] font-sans-display font-semibold whitespace-nowrap ${bandChipClass(snap.band)}`}
                              >
                                {bandLabel(snap.band)}
                              </span>
                            </div>

                            {/* Real DoE-style 4-Band Placement Bar */}
                            <div className="space-y-1">
                              <div className="grid grid-cols-4 gap-1.5">
                                {BAND_ORDER.map((b, i) => {
                                  const isHit = i === activeBandIdx;
                                  const isBelow = i < activeBandIdx;
                                  return (
                                    <div
                                      key={b}
                                      className={`h-2.5 rounded-full transition-colors ${
                                        isHit
                                          ? 'bg-[#113C36]'
                                          : isBelow
                                            ? 'bg-[#113C36]/25'
                                            : 'bg-[#E5DFD5]'
                                      }`}
                                    />
                                  );
                                })}
                              </div>
                              <div className="grid grid-cols-4 gap-1.5 text-[10px] text-[#615E57] text-center">
                                <span>{t('bench.bandLowest50')}</span>
                                <span>{t('bench.bandNext25')}</span>
                                <span>{t('bench.bandNext15')}</span>
                                <span className="font-semibold text-[#1D6346]">{t('bench.bandTop10')}</span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>

                  {/* Grouped School Placement Tiers (Compact Horizontal Bands — Zero Empty Voids) */}
                  <section className="space-y-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h4 className="font-sans-display font-semibold text-base text-[#113C36]">
                        {t('bm.schoolTiersTitle')}
                      </h4>
                      <span className="text-xs text-[#615E57]">{t('bm.schoolTiersSub')}</span>
                    </div>

                    <div className="space-y-3.5">
                      {/* Tier 1: Above First-Round Cutoff (strictly delta >= 0) */}
                      <div className="p-4 rounded-[14px] bg-[#E5F3EC]/50 border border-[#C5DDD1] space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="inline-flex items-center gap-2">
                            <span className="inline-flex items-center gap-1.5 text-xs font-sans-display font-semibold text-[#1D6346]">
                              <CheckCircle2 className="w-4 h-4 shrink-0" />
                              <span>{t('bm.tierAboveTitle')}</span>
                            </span>
                            <span className="px-2 py-0.5 rounded-full bg-white/90 border border-[#C5DDD1] text-[11px] font-sans-display font-semibold text-[#1D6346] tabular-nums">
                              {aboveCutoffSchools.length}
                            </span>
                          </div>
                          {aboveCutoffSchools.length > 6 && (
                            <button
                              type="button"
                              onClick={() => setShowAllAboveCutoff((v) => !v)}
                              className="px-2.5 py-1 rounded-full bg-white border border-[#C5DDD1] hover:bg-[#FAF8F5] text-[11px] font-sans-display font-semibold text-[#113C36] cursor-pointer transition-[background-color,transform,translate,scale] duration-150 ease-out active:scale-[0.98]"
                            >
                              {showAllAboveCutoff
                                ? t('bm.showTopCount', { count: 6 })
                                : t('bm.showAllCount', { count: aboveCutoffSchools.length })}
                            </button>
                          )}
                        </div>
                        {aboveCutoffSchools.length === 0 ? (
                          <p className="text-xs text-[#4A5955]">{t('bm.tierOfferEmpty')}</p>
                        ) : (
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                            {visibleAboveSchools.map((s) => (
                              <div
                                key={s.school.id}
                                className="px-3.5 py-2.5 rounded-[10px] bg-white border border-[#D4E4DC] flex items-center justify-between gap-2 text-xs tabular-nums"
                              >
                                <div className="min-w-0">
                                  <div className="font-sans-display font-semibold leading-snug text-[#113C36] [overflow-wrap:anywhere]">
                                    {s.school.shortName}
                                  </div>
                                  <div className="text-[11px] text-[#615E57] mt-0.5">
                                    {t('bm.schoolSpotsLine', {
                                      cutoff: s.firstRoundCutoff120.toFixed(1),
                                      gen: s.estimatedGeneralSpots,
                                    })}
                                  </div>
                                </div>
                                <span className="font-sans-display font-semibold text-[#1D6346] shrink-0">
                                  +{s.deltaFromFirstRound.toFixed(1)}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Tier 2: On the Line & Reserve-List Range (strictly negative delta, warm amber) */}
                      {onLineAndReserveSchools.length > 0 && (
                        <div className="p-4 rounded-[14px] bg-[#FDF6EC] border border-[#EED7B7] space-y-3">
                          <div className="flex items-center justify-between gap-2">
                            <div className="inline-flex items-center gap-2">
                              <span className="text-xs font-sans-display font-semibold text-[#A35116]">
                                {t('bm.tierLineReserveTitle')}
                              </span>
                              <span className="px-2 py-0.5 rounded-full bg-white/90 border border-[#EED7B7] text-[11px] font-sans-display font-semibold text-[#A35116] tabular-nums">
                                {onLineAndReserveSchools.length}
                              </span>
                            </div>
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                            {onLineAndReserveSchools.map((s) => (
                              <div
                                key={s.school.id}
                                className="px-3.5 py-2.5 rounded-[10px] bg-white border border-[#EED7B7] flex items-center justify-between gap-2 text-xs tabular-nums"
                              >
                                <div className="min-w-0">
                                  <div className="flex items-center gap-1.5 min-w-0">
                                    <span className="font-sans-display font-semibold leading-snug text-[#113C36] [overflow-wrap:anywhere]">
                                      {s.school.shortName}
                                    </span>
                                    <span className="px-1.5 py-0.5 rounded bg-[#FDF0E2] text-[#A35116] text-[10px] font-medium shrink-0">
                                      {s.status === 'borderline_offer'
                                        ? t('bm.tagOnLine')
                                        : t('bm.tagReserve')}
                                    </span>
                                  </div>
                                  <div className="text-[11px] text-[#615E57] mt-0.5">
                                    {t('bm.schoolReserveLine', {
                                      cutoff: s.firstRoundCutoff120.toFixed(1),
                                      reserve: s.reserveCutoff120.toFixed(1),
                                    })}
                                  </div>
                                </div>
                                <span className="font-sans-display font-semibold text-[#A35116] shrink-0">
                                  {s.deltaFromFirstRound.toFixed(1)}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Tier 3: Next Reach Targets */}
                      {reachSchools.length > 0 && (
                        <div className="p-4 rounded-[14px] bg-[#FAF8F5] border border-[#E5DFD5] space-y-3">
                          <div className="inline-flex items-center gap-2">
                            <span className="text-xs font-sans-display font-semibold text-[#4A5955]">
                              {t('bm.tierReachTitle')}
                            </span>
                            <span className="px-2 py-0.5 rounded-full bg-white border border-[#E5DFD5] text-[11px] font-sans-display font-semibold text-[#4A5955] tabular-nums">
                              {reachSchools.length}
                            </span>
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                            {reachSchools.map((s) => (
                              <div
                                key={s.school.id}
                                className="px-3.5 py-2.5 rounded-[10px] bg-white border border-[#E5DFD5] flex items-center justify-between gap-2 text-xs tabular-nums"
                              >
                                <div className="min-w-0">
                                  <div className="font-sans-display font-semibold leading-snug text-[#113C36] [overflow-wrap:anywhere]">
                                    {s.school.shortName}
                                  </div>
                                  <div className="text-[11px] text-[#615E57] mt-0.5">
                                    {t('bm.schoolSpotsLine', {
                                      cutoff: s.firstRoundCutoff120.toFixed(1),
                                      gen: s.estimatedGeneralSpots,
                                    })}
                                  </div>
                                </div>
                                <span className="font-sans-display font-semibold text-[#4A5955] shrink-0">
                                  {s.deltaFromFirstRound.toFixed(1)}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </section>

                  {/* Hybrid AI Coaching Brief (Decisions 1 + Flash Lite + Deterministic Fallback) */}
                  <section className="p-5 rounded-[14px] bg-[#FAF8F5] border border-[#E5DFD5] space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <Sparkles className="w-4 h-4 text-[#1D6346] shrink-0" />
                        <h4 className="font-sans-display font-semibold text-sm text-[#113C36]">
                          {t('bm.aiBriefTitle')}
                        </h4>
                        {activeReport.aiCoaching && (
                          <span className="px-2 py-0.5 rounded-full bg-white border border-[#E5DFD5] text-[10px] font-medium text-[#615E57]">
                            {activeReport.aiCoaching.source === 'hybrid_gemini'
                              ? t('bm.aiBadgeHybrid')
                              : t('bm.aiBadgeFormula')}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={analyzingId === activeReport.sessionId}
                          onClick={() => runAnalysis(activeReport.sessionId, true)}
                          className="px-3 py-1.5 rounded-[8px] border border-[#CFC6B9] bg-white hover:bg-[#F3EFE8] text-xs font-sans-display font-semibold text-[#113C36] inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50 transition-[background-color,transform,translate,scale] duration-150 ease-out active:scale-[0.98]"
                        >
                          {analyzingId === activeReport.sessionId ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <RefreshCw className="w-3.5 h-3.5" />
                          )}
                          <span>{t('bm.refreshCoaching')}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => onOpenSession(activeReport.sessionId, false)}
                          className="px-3.5 py-1.5 rounded-[8px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-xs font-sans-display font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-[background-color,transform,translate,scale] duration-150 ease-out active:scale-[0.98]"
                        >
                          <FileText className="w-3.5 h-3.5" />
                          <span>{t('bm.openQuestionReview')}</span>
                        </button>
                      </div>
                    </div>

                    {analyzeError && (
                      <p role="alert" className="text-xs text-[#B42318]">
                        {analyzeError}
                      </p>
                    )}

                    {analyzingId === activeReport.sessionId && !activeReport.aiCoaching ? (
                      <div className="flex items-center gap-2 text-xs text-[#4A5955] py-2">
                        <Loader2 className="w-4 h-4 animate-spin text-[#113C36]" />
                        <span>{t('bm.analyzingBrief')}</span>
                      </div>
                    ) : activeReport.aiCoaching ? (
                      <div className="space-y-4">
                        <p className="text-[13.5px] text-[#113C36] leading-relaxed">
                          {isZh
                            ? activeReport.aiCoaching.parentSummaryZh
                            : activeReport.aiCoaching.parentSummaryEn}
                        </p>

                        {activeReport.aiCoaching.rankedPriorities.length > 0 && (
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
                            {activeReport.aiCoaching.rankedPriorities.map((p, idx) => (
                              <div
                                key={`${p.skillId}_${idx}`}
                                className="p-3 rounded-[10px] bg-white border border-[#E5DFD5] space-y-1"
                              >
                                <div className="text-[11px] font-sans-display font-semibold text-[#1D6346]">
                                  {t('bm.priorityNum', { num: idx + 1 })}
                                </div>
                                <div className="text-xs font-sans-display font-semibold text-[#113C36]">
                                  {p.label}
                                </div>
                                <p className="text-[11px] text-[#4A5955] leading-snug">
                                  {isZh ? p.reasonZh : p.reasonEn}
                                </p>
                              </div>
                            ))}
                          </div>
                        )}

                        <div className="space-y-1.5">
                          <div className="text-xs font-sans-display font-semibold text-[#4A5955]">
                            {t('bm.actionPlanTitle')}
                          </div>
                          <ul className="space-y-1.5 text-xs text-[#113C36]">
                            {(isZh
                              ? activeReport.aiCoaching.actionPlanZh
                              : activeReport.aiCoaching.actionPlanEn
                            ).map((step, i) => (
                              <li key={i} className="flex items-start gap-2 leading-relaxed">
                                <span className="w-4 h-4 rounded-full bg-[#113C36] text-white text-[10px] font-sans-display font-semibold inline-flex items-center justify-center shrink-0 mt-0.5">
                                  {i + 1}
                                </span>
                                <span>{step}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    ) : null}
                  </section>

                  <div className="flex items-start gap-2 text-[11px] text-[#615E57] leading-relaxed">
                    <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span>{t('bench.disclaimer')}</span>
                  </div>
                </div>
              </article>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
