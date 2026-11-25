import { useMemo, useState } from 'react';
import { Award, CheckCircle2, FileText, Info, TrendingDown, TrendingUp } from 'lucide-react';
import type { BenchmarkReportRecord, SectionCode } from '../../shared/contracts';
import {
  buildParentVerdict,
  evaluateNswBenchmark,
  type ApplicantGenderFilter,
  type NswPerformanceBand,
} from '../../shared/nswBenchmark';
import { useI18n } from '../i18n';

interface BenchmarkReportSummaryCardProps {
  reports: BenchmarkReportRecord[];
  onOpenBenchmarks: () => void;
  onOpenSession: (sessionId: string) => void;
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

const OFFICIAL_SECTIONS: { code: SectionCode; minutes: number }[] = [
  { code: 'READ', minutes: 45 },
  { code: 'MATH', minutes: 40 },
  { code: 'THINK', minutes: 40 },
  { code: 'WRIT', minutes: 30 },
];

/**
 * Strictly read-only Official NSW Selective Benchmark Report card for ProgressView.
 * Never renders adjustable sliders or fabricated placeholder estimates.
 */
export function BenchmarkReportSummaryCard({
  reports,
  onOpenBenchmarks,
  onOpenSession,
}: BenchmarkReportSummaryCardProps) {
  const { t, isZh, sectionLabel, formatDate } = useI18n();
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [genderFilter, setGenderFilter] = useState<ApplicantGenderFilter>('all');

  const activeReport = useMemo(() => {
    if (reports.length === 0) return null;
    return reports.find((r) => r.sessionId === selectedSessionId) || reports[0];
  }, [reports, selectedSessionId]);

  const previousReport = useMemo(() => {
    if (!activeReport) return null;
    const idx = reports.findIndex((r) => r.sessionId === activeReport.sessionId);
    if (idx < 0 || idx + 1 >= reports.length) return null;
    return reports[idx + 1];
  }, [reports, activeReport]);

  const evaluated = useMemo(() => {
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

  const verdict = useMemo(() => (evaluated ? buildParentVerdict(evaluated) : null), [evaluated]);

  const bandLabel = (band: NswPerformanceBand): string => {
    if (band === 'top_10') return t('bench.bandTop10');
    if (band === 'next_15') return t('bench.bandNext15');
    if (band === 'next_25') return t('bench.bandNext25');
    return t('bench.bandLowest50');
  };

  if (reports.length === 0 || !activeReport || !evaluated || !verdict) {
    return (
      <section
        aria-label={t('bm.progressReportTitle')}
        className="rounded-[16px] bg-[#FAF8F5] border border-[#E5DFD5] p-6 sm:p-7 space-y-5 text-[#113C36]"
      >
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
          <div className="space-y-1.5">
            <div className="inline-flex items-center gap-2 flex-wrap">
              <span className="inline-flex items-center gap-1.5 text-xs font-sans-display font-semibold text-[#1D6346]">
                <Award className="w-4 h-4 shrink-0" />
                <span>{t('bm.progressReportBadge')}</span>
              </span>
              <span className="px-2.5 py-0.5 rounded-full bg-white border border-[#E5DFD5] text-[11px] font-medium text-[#78756E]">
                {t('bm.progressEmptyBadge')}
              </span>
            </div>
            <h2 className="font-sans-display font-semibold text-[20px] tracking-[-0.015em] text-[#113C36]">
              {t('bm.progressReportTitle')}
            </h2>
            <p className="text-[13px] text-[#4A5955] max-w-2xl leading-relaxed">
              {t('bm.progressEmptyDesc')}
            </p>
          </div>

          <button
            type="button"
            onClick={onOpenBenchmarks}
            className="px-4 py-2.5 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-xs font-sans-display font-semibold transition-[background-color,transform] duration-150 ease-out active:scale-[0.98] cursor-pointer whitespace-nowrap shrink-0"
          >
            {t('bm.progressEmptyCta')}
          </button>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {OFFICIAL_SECTIONS.map(({ code, minutes }) => (
            <div
              key={code}
              className="p-4 rounded-[12px] bg-white border border-[#E5DFD5] space-y-1.5"
            >
              <div className="text-xs font-sans-display font-semibold text-[#113C36]">
                {sectionLabel(code)}
              </div>
              <div className="text-[11px] text-[#78756E] tabular-nums">
                {t('bm.sectionMinutesOnly', { min: minutes })}
              </div>
              <div className="pt-1 font-serif-display font-bold text-lg text-[#78756E]">
                {t('bm.notSatYet')}
              </div>
            </div>
          ))}
        </div>
      </section>
    );
  }

  const aboveCutoffSchools = evaluated.schools.filter((s) => s.deltaFromFirstRound >= 0);
  const reserveOrBorderline = evaluated.schools.filter(
    (s) =>
      s.deltaFromFirstRound < 0 &&
      (s.status === 'borderline_offer' || s.status === 'reserve_range')
  );
  const scoreDelta = previousReport
    ? Number((activeReport.scaledScore120 - previousReport.scaledScore120).toFixed(1))
    : null;

  return (
    <section
      aria-label={t('bm.progressReportTitle')}
      className="rounded-[16px] bg-[#FAF8F5] border border-[#E5DFD5] p-6 sm:p-7 space-y-6 text-[#113C36]"
    >
      <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
        <div className="space-y-1.5 max-w-2xl">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-sans-display font-semibold text-[#1D6346]">
              <Award className="w-4 h-4 shrink-0" />
              <span>{t('bm.progressReportBadge')}</span>
            </span>
            <span className="px-2.5 py-0.5 rounded-full bg-white border border-[#E5DFD5] text-[11px] font-medium text-[#113C36]">
              {activeReport.batchLabel}
            </span>
            <span className="text-xs text-[#78756E] tabular-nums">
              {formatDate(activeReport.completedAtIso, true)}
            </span>
            {activeReport.writingStatus === 'pending' && (
              <span className="px-2.5 py-0.5 rounded-full bg-[#FDF0E2] border border-[#A35116]/25 text-[11px] font-semibold text-[#A35116]">
                {t('bm.writingPendingPill')}
              </span>
            )}
          </div>
          <h2 className="font-serif-display font-bold text-[22px] sm:text-[26px] leading-[1.2] tracking-[-0.02em] text-[#113C36]">
            {isZh ? verdict.headlineZh : verdict.headlineEn}
          </h2>
          <p className="text-xs text-[#4A5955] leading-relaxed">
            {isZh ? verdict.sublineZh : verdict.sublineEn}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <div
            className="inline-flex items-center p-1 rounded-[10px] bg-white border border-[#E5DFD5]"
            role="group"
            aria-label={t('bench.genderFilterLabel')}
          >
            {(
              [
                ['all', t('bench.genderAll')],
                ['girls', t('bench.genderGirls')],
                ['boys', t('bench.genderBoys')],
              ] as [ApplicantGenderFilter, string][]
            ).map(([val, label]) => (
              <button
                key={val}
                type="button"
                aria-pressed={genderFilter === val}
                onClick={() => setGenderFilter(val)}
                className={`px-2.5 py-1 rounded-[7px] text-xs font-sans-display font-semibold cursor-pointer transition-colors whitespace-nowrap ${
                  genderFilter === val
                    ? 'bg-[#113C36] text-white'
                    : 'text-[#4A5955] hover:text-[#113C36]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Saved Sitting Selector (when 2+ benchmark exams completed) */}
      {reports.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {reports.slice(0, 6).map((rep) => {
            const selected = rep.sessionId === activeReport.sessionId;
            return (
              <button
                key={rep.sessionId}
                type="button"
                onClick={() => setSelectedSessionId(rep.sessionId)}
                className={`px-3 py-1.5 rounded-[10px] border text-xs font-sans-display font-semibold tabular-nums cursor-pointer transition-colors ${
                  selected
                    ? 'bg-[#113C36] border-[#113C36] text-white'
                    : 'bg-white border-[#E5DFD5] text-[#113C36] hover:border-[#CFC6B9]'
                }`}
              >
                {rep.batchLabel} ({rep.scaledScore120.toFixed(1)}/120)
              </button>
            );
          })}
        </div>
      )}

      {/* Headline Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
        <div className="p-4 rounded-[14px] border border-[#D4E4DC] bg-[#E5F0EA] space-y-1">
          <div className="text-xs font-sans-display font-semibold text-[#1D6346]">
            {t('bench.scaledScoreLabel')}
          </div>
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="font-serif-display font-extrabold text-[32px] leading-none tracking-[-0.03em] text-[#113C36] tabular-nums">
              {evaluated.scaledScore120.toFixed(1)}
            </span>
            <span className="text-xs font-sans-display font-semibold text-[#4A5955] tabular-nums">
              / 120 (±{evaluated.uncertaintyHalfWidth120})
            </span>
            {scoreDelta !== null && (
              <span
                className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[11px] font-sans-display font-semibold tabular-nums ${
                  scoreDelta >= 0 ? 'bg-white text-[#1D6346]' : 'bg-[#FDECEB] text-[#B42318]'
                }`}
              >
                {scoreDelta >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                {scoreDelta >= 0 ? `+${scoreDelta.toFixed(1)}` : scoreDelta.toFixed(1)}
              </span>
            )}
          </div>
          <div className="text-[11px] text-[#4A5955]">{t('bench.singleScaleHint')}</div>
        </div>

        <div className="p-4 rounded-[14px] border border-[#E5DFD5] bg-white space-y-1">
          <div className="text-xs font-sans-display font-semibold text-[#4A5955]">
            {t('bench.stateRankLabel')}
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-serif-display font-extrabold text-[32px] leading-none tracking-[-0.03em] text-[#113C36] tabular-nums">
              #{evaluated.estimatedStateRank.toLocaleString()}
            </span>
            <span className="text-xs text-[#78756E] tabular-nums">
              / {evaluated.estimatedApplicantPool.toLocaleString()}
            </span>
          </div>
          <div className="text-[11px] text-[#4A5955] tabular-nums">
            {t('bench.percentileLine', { pct: evaluated.estimatedPercentile.toFixed(1) })}
          </div>
        </div>

        <div className="p-4 rounded-[14px] border border-[#E5DFD5] bg-white space-y-1">
          <div className="text-xs font-sans-display font-semibold text-[#4A5955]">
            {t('bench.schoolsInRangeLabel')}
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-serif-display font-extrabold text-[32px] leading-none tracking-[-0.03em] text-[#113C36] tabular-nums">
              {aboveCutoffSchools.length + reserveOrBorderline.length}
            </span>
            <span className="text-xs text-[#78756E] tabular-nums">
              / {evaluated.schools.length}
            </span>
          </div>
          <div className="text-[11px] text-[#4A5955] tabular-nums">
            {t('bench.offerBreakdown', {
              offer: aboveCutoffSchools.length,
              reserve: reserveOrBorderline.length,
            })}
          </div>
        </div>
      </div>

      {/* 4-Section Official Report Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
        {(['READ', 'MATH', 'THINK', 'WRIT'] as SectionCode[]).map((sec) => {
          const snap = activeReport.sections[sec];
          const activeBandIdx = bandIndex(snap.band);
          return (
            <div
              key={sec}
              className="p-4 rounded-[14px] bg-white border border-[#E5DFD5] space-y-3 tabular-nums"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
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

              <div className="space-y-1">
                <div className="grid grid-cols-4 gap-1.5">
                  {BAND_ORDER.map((b, i) => (
                    <div
                      key={b}
                      className={`h-2 rounded-full ${
                        i === activeBandIdx
                          ? 'bg-[#113C36]'
                          : i < activeBandIdx
                            ? 'bg-[#113C36]/25'
                            : 'bg-[#E5DFD5]'
                      }`}
                    />
                  ))}
                </div>
                <div className="grid grid-cols-4 gap-1.5 text-[10px] text-[#78756E] text-center">
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

      {/* Compact Top School Standings */}
      {(aboveCutoffSchools.length > 0 || reserveOrBorderline.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="p-4 rounded-[12px] bg-[#E5F3EC]/55 border border-[#C5DDD1] space-y-2">
            <div className="inline-flex items-center gap-1.5 text-xs font-sans-display font-semibold text-[#1D6346]">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
              <span>
                {t('bm.tierAboveTitle')} ({aboveCutoffSchools.length})
              </span>
            </div>
            {aboveCutoffSchools.length === 0 ? (
              <p className="text-xs text-[#4A5955]">{t('bm.tierOfferEmpty')}</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {aboveCutoffSchools.slice(0, 8).map((s) => (
                  <span
                    key={s.school.id}
                    className="px-2.5 py-1 rounded-[8px] bg-white border border-[#D4E4DC] text-xs font-medium text-[#113C36] tabular-nums"
                  >
                    {s.school.shortName} (+{s.deltaFromFirstRound.toFixed(1)})
                  </span>
                ))}
              </div>
            )}
          </div>

          {reserveOrBorderline.length > 0 && (
            <div className="p-4 rounded-[12px] bg-[#FDF6EC] border border-[#EED7B7] space-y-2">
              <div className="text-xs font-sans-display font-semibold text-[#A35116]">
                {t('bm.tierLineReserveTitle')} ({reserveOrBorderline.length})
              </div>
              <div className="flex flex-wrap gap-1.5">
                {reserveOrBorderline.slice(0, 6).map((s) => (
                  <span
                    key={s.school.id}
                    className="px-2.5 py-1 rounded-[8px] bg-white border border-[#EED7B7] text-xs font-medium text-[#113C36] tabular-nums"
                  >
                    {s.school.shortName} ({s.deltaFromFirstRound.toFixed(1)})
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Actions & Read-Only Footnote */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-[#E5DFD5]">
        <div className="flex items-start gap-2 text-[11px] text-[#78756E] max-w-xl leading-relaxed">
          <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>
            {t('bm.readOnlyFootnote')} {t('bench.disclaimer')}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => onOpenSession(activeReport.sessionId)}
            className="px-3.5 py-2 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#F3EFE8] text-xs font-sans-display font-semibold text-[#113C36] inline-flex items-center gap-1.5 cursor-pointer"
          >
            <FileText className="w-3.5 h-3.5" />
            <span>{t('bm.reviewExamPaper')}</span>
          </button>
          <button
            type="button"
            onClick={onOpenBenchmarks}
            className="px-4 py-2 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-xs font-sans-display font-semibold cursor-pointer"
          >
            {t('bm.openFullReport')}
          </button>
        </div>
      </div>
    </section>
  );
}
