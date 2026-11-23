import { useEffect, useMemo, useState } from 'react';
import { Award, ChevronDown, ChevronUp, Info, RotateCcw, Sparkles } from 'lucide-react';
import { useI18n } from '../i18n';
import type { SectionCode } from '../../shared/contracts';
import {
  OFFICIAL_SECTION_MAX_MARKS,
  buildParentVerdict,
  evaluateNswBenchmark,
  type ApplicantGenderFilter,
  type BenchmarkDifficultyPreset,
  type BenchmarkSectionInput,
  type BenchmarkWeightingMode,
  type NswPerformanceBand,
  type SchoolOfferStatus,
} from '../../shared/nswBenchmark';

export interface NswBenchmarkEstimatorProps {
  initialScores?: {
    read: BenchmarkSectionInput;
    math: BenchmarkSectionInput;
    think: BenchmarkSectionInput;
    writ: BenchmarkSectionInput;
  };
  sectionSources?: Record<SectionCode, 'actual' | 'assumed'>;
  initialDifficulty?: BenchmarkDifficultyPreset;
  sourceNote?: string;
  titleOverride?: string;
  hideEyebrow?: boolean;
  compact?: boolean;
  defaultOpen?: boolean;
}

const DEFAULT_SCORES = {
  read: { score: 31, maxScore: OFFICIAL_SECTION_MAX_MARKS.READ },
  math: { score: 28, maxScore: OFFICIAL_SECTION_MAX_MARKS.MATH },
  think: { score: 31, maxScore: OFFICIAL_SECTION_MAX_MARKS.THINK },
  writ: { score: 15, maxScore: OFFICIAL_SECTION_MAX_MARKS.WRIT },
};

function bandPillClass(band: NswPerformanceBand): string {
  if (band === 'top_10') return 'bg-[#E5F3EC] text-[#1D6346] border-[#1D6346]/30';
  if (band === 'next_15') return 'bg-[#E5F0EA] text-[#113C36] border-[#113C36]/25';
  if (band === 'next_25') return 'bg-[#F3EFE8] text-[#4A5955] border-[#CFC6B9]';
  return 'bg-[#FDF0E2] text-[#A35116] border-[#A35116]/30';
}

function statusPillClass(status: SchoolOfferStatus): string {
  if (status === 'likely_offer') return 'bg-[#E5F3EC] text-[#1D6346] border-[#1D6346]/30';
  if (status === 'borderline_offer') return 'bg-[#E5F0EA] text-[#113C36] border-[#113C36]/30';
  if (status === 'reserve_range') return 'bg-[#FDF0E2] text-[#A35116] border-[#A35116]/30';
  if (status === 'reach') return 'bg-[#F3EFE8] text-[#4A5955] border-[#CFC6B9]';
  return 'bg-white text-[#78756E] border-[#E5DFD5]';
}

export function NswBenchmarkEstimator({
  initialScores,
  sectionSources,
  initialDifficulty = 'selective_lab_timed',
  sourceNote,
  titleOverride,
  hideEyebrow = false,
  compact = false,
  defaultOpen = true,
}: NswBenchmarkEstimatorProps) {
  const { t, isZh, sectionShortLabel } = useI18n();
  const seed = initialScores ?? DEFAULT_SCORES;

  const [open, setOpen] = useState(defaultOpen);
  const [readScore, setReadScore] = useState(seed.read.score);
  const [mathScore, setMathScore] = useState(seed.math.score);
  const [thinkScore, setThinkScore] = useState(seed.think.score);
  const [writScore, setWritScore] = useState(seed.writ.score);
  const [touched, setTouched] = useState<Record<SectionCode, boolean>>({
    READ: false,
    MATH: false,
    THINK: false,
    WRIT: false,
  });
  const [difficulty, setDifficulty] = useState<BenchmarkDifficultyPreset>(initialDifficulty);
  const [weighting, setWeighting] = useState<BenchmarkWeightingMode>('official_2025_equal');
  const [genderFilter, setGenderFilter] = useState<ApplicantGenderFilter>('all');
  const [showAllSchools, setShowAllSchools] = useState(!compact);

  // Sync untouched sliders when live scores arrive (e.g. after Writing evaluation finishes)
  useEffect(() => {
    if (!touched.READ) setReadScore(seed.read.score);
    if (!touched.MATH) setMathScore(seed.math.score);
    if (!touched.THINK) setThinkScore(seed.think.score);
    if (!touched.WRIT) setWritScore(seed.writ.score);
  }, [seed.read.score, seed.math.score, seed.think.score, seed.writ.score, touched]);

  const readMax = Math.max(1, seed.read.maxScore);
  const mathMax = Math.max(1, seed.math.maxScore);
  const thinkMax = Math.max(1, seed.think.maxScore);
  const writMax = Math.max(1, seed.writ.maxScore);

  const isModified =
    readScore !== seed.read.score ||
    mathScore !== seed.math.score ||
    thinkScore !== seed.think.score ||
    writScore !== seed.writ.score ||
    difficulty !== initialDifficulty;

  const report = useMemo(
    () =>
      evaluateNswBenchmark({
        read: { score: readScore, maxScore: readMax },
        math: { score: mathScore, maxScore: mathMax },
        think: { score: thinkScore, maxScore: thinkMax },
        writ: { score: writScore, maxScore: writMax },
        difficulty,
        weighting,
        genderFilter,
      }),
    [readScore, readMax, mathScore, mathMax, thinkScore, thinkMax, writScore, writMax, difficulty, weighting, genderFilter]
  );

  const bandLabel = (band: NswPerformanceBand): string => {
    if (band === 'top_10') return t('bench.bandTop10');
    if (band === 'next_15') return t('bench.bandNext15');
    if (band === 'next_25') return t('bench.bandNext25');
    return t('bench.bandLowest50');
  };

  const statusLabel = (status: SchoolOfferStatus): string => {
    if (status === 'likely_offer') return t('bench.statusLikely');
    if (status === 'borderline_offer') return t('bench.statusBorderline');
    if (status === 'reserve_range') return t('bench.statusReserve');
    if (status === 'reach') return t('bench.statusReach');
    return t('bench.statusBelow');
  };

  const resetScores = () => {
    setReadScore(seed.read.score);
    setMathScore(seed.math.score);
    setThinkScore(seed.think.score);
    setWritScore(seed.writ.score);
    setTouched({ READ: false, MATH: false, THINK: false, WRIT: false });
    setDifficulty(initialDifficulty);
  };

  const localizedStepLabel = (sec: SectionCode, delta: number): string => {
    if (sec === 'READ') return t('bench.stepREAD', { count: delta });
    if (sec === 'MATH') return t('bench.stepMATH', { count: delta });
    if (sec === 'THINK') return t('bench.stepTHINK', { count: delta });
    return t('bench.stepWRIT', { count: delta });
  };

  const verdict = useMemo(() => buildParentVerdict(report), [report]);
  const visibleSchools = showAllSchools ? report.schools : report.schools.slice(0, 10);
  const inRangeCount =
    report.countsByStatus.likely_offer +
    report.countsByStatus.borderline_offer +
    report.countsByStatus.reserve_range;

  return (
    <section
      aria-label={t('bench.title')}
      className={`rounded-[16px] bg-[#FAF8F5] border border-[#E5DFD5] text-[#113C36] ${
        compact ? 'p-4 sm:p-5 space-y-4' : 'p-6 sm:p-7 space-y-6'
      }`}
    >
      {/* Header Row */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
        <div className="space-y-1">
          {!hideEyebrow && (
            <div className="inline-flex items-center gap-1.5 text-xs font-sans-display font-semibold text-[#1D6346]">
              <Award className="w-4 h-4 shrink-0" />
              <span>{t('bench.eyebrow')}</span>
            </div>
          )}
          <h2 className="font-sans-display font-semibold text-[18px] sm:text-[19px] tracking-[-0.015em] text-[#113C36]">
            {titleOverride || t('bench.title')}
          </h2>
          <p className="text-xs text-[#4A5955] max-w-2xl leading-relaxed">
            {sourceNote || t('bench.subtitle')}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          {compact && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="px-3.5 py-1.5 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#F3EFE8] text-xs font-sans-display font-semibold text-[#113C36] inline-flex items-center gap-1.5 cursor-pointer transition-[background-color,border-color,transform] duration-150 ease-out active:scale-[0.98]"
            >
              <span>{open ? t('bench.hideEstimator') : t('bench.showEstimator')}</span>
              {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
          )}
        </div>
      </div>

      {!open ? (
        <div className="flex flex-wrap items-center gap-3 text-xs text-[#4A5955] tabular-nums">
          <span className="px-2.5 py-1 rounded-full bg-[#E5F0EA] text-[#113C36] font-sans-display font-semibold">
            {t('bench.scaledScoreShort', { score: report.scaledScore120 })}
          </span>
          <span>
            {t('bench.stateRankShort', {
              rank: report.estimatedStateRank.toLocaleString(),
              pct: report.estimatedPercentile,
            })}
          </span>
          <span>{t('bench.schoolsInRange', { count: inRangeCount, total: report.schools.length })}</span>
        </div>
      ) : (
        <div className={compact ? 'max-h-[48vh] overflow-y-auto pr-1 space-y-4' : 'space-y-6'}>
          {/* Plain-English / Chinese Parent Verdict Banner */}
          <div className="px-4 py-3 rounded-[12px] bg-[#E5F0EA]/80 border border-[#C5DDD1] space-y-0.5">
            <div className="font-sans-display font-semibold text-sm text-[#113C36]">
              {isZh ? verdict.headlineZh : verdict.headlineEn}
            </div>
            <div className="text-xs text-[#4A5955]">
              {isZh ? verdict.sublineZh : verdict.sublineEn}
            </div>
          </div>

          {/* Headline Summary Strip (Single /120 scale only) */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
            <div className="p-4 sm:p-5 rounded-[14px] border border-[#D4E4DC] bg-[#E5F0EA] space-y-1">
              <div className="text-xs font-sans-display font-semibold text-[#1D6346]">
                {t('bench.scaledScoreLabel')}
              </div>
              <div className="flex items-baseline gap-2">
                <span className="font-serif-display font-extrabold text-[34px] leading-none tracking-[-0.03em] text-[#113C36] tabular-nums">
                  {report.scaledScore120.toFixed(1)}
                </span>
                <span className="text-xs font-sans-display font-semibold text-[#4A5955] tabular-nums">
                  / 120 (±{report.uncertaintyHalfWidth120})
                </span>
              </div>
              <div className="text-[11px] text-[#4A5955] tabular-nums">
                {t('bench.singleScaleHint')}
              </div>
            </div>

            <div className="p-4 sm:p-5 rounded-[14px] border border-[#E5DFD5] bg-white space-y-1">
              <div className="text-xs font-sans-display font-semibold text-[#4A5955]">
                {t('bench.stateRankLabel')}
              </div>
              <div className="flex items-baseline gap-2">
                <span className="font-serif-display font-extrabold text-[34px] leading-none tracking-[-0.03em] text-[#113C36] tabular-nums">
                  #{report.estimatedStateRank.toLocaleString()}
                </span>
                <span className="text-xs text-[#78756E] tabular-nums">
                  / {report.estimatedApplicantPool.toLocaleString()}
                </span>
              </div>
              <div className="text-[11px] text-[#4A5955] tabular-nums">
                {t('bench.percentileLine', { pct: report.estimatedPercentile.toFixed(1) })}
              </div>
            </div>

            <div className="p-4 sm:p-5 rounded-[14px] border border-[#E5DFD5] bg-white space-y-1">
              <div className="text-xs font-sans-display font-semibold text-[#4A5955]">
                {t('bench.schoolsInRangeLabel')}
              </div>
              <div className="flex items-baseline gap-2">
                <span className="font-serif-display font-extrabold text-[34px] leading-none tracking-[-0.03em] text-[#113C36] tabular-nums">
                  {inRangeCount}
                </span>
                <span className="text-xs text-[#78756E] tabular-nums">
                  / {report.schools.length}
                </span>
              </div>
              <div className="text-[11px] text-[#4A5955] tabular-nums">
                {t('bench.offerBreakdown', {
                  offer: report.countsByStatus.likely_offer + report.countsByStatus.borderline_offer,
                  reserve: report.countsByStatus.reserve_range,
                })}
              </div>
            </div>
          </div>

          {/* Controls: Gender Filter, Difficulty Preset, Weighting Mode */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 p-4 rounded-[14px] bg-white border border-[#E5DFD5]">
            <div className="lg:col-span-4 space-y-1.5">
              <div className="text-[11px] font-sans-display font-semibold text-[#4A5955]">
                {t('bench.genderFilterLabel')}
              </div>
              <div
                className="inline-flex items-center p-1 rounded-[10px] bg-[#F3EFE8] border border-[#E5DFD5]"
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
                    className={`px-3 py-1 rounded-[7px] text-xs font-sans-display font-semibold cursor-pointer transition-colors whitespace-nowrap ${
                      genderFilter === val
                        ? 'bg-white text-[#113C36] shadow-[0_1px_2px_rgba(17,60,54,0.08)]'
                        : 'text-[#4A5955] hover:text-[#113C36]'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="lg:col-span-5 space-y-1.5">
              <label
                htmlFor="bench-difficulty-select"
                className="block text-[11px] font-sans-display font-semibold text-[#4A5955]"
              >
                {t('bench.difficultyLabel')}
              </label>
              <select
                id="bench-difficulty-select"
                value={difficulty}
                onChange={(e) => setDifficulty(e.target.value as BenchmarkDifficultyPreset)}
                className="w-full px-3 py-1.5 rounded-[10px] border border-[#CFC6B9] bg-white text-xs text-[#113C36] focus:outline-none focus:border-[#113C36]"
              >
                <option value="official_sample">{t('bench.diffSample')}</option>
                <option value="real_exam">{t('bench.diffReal')}</option>
                <option value="selective_lab_timed">{t('bench.diffTimed')}</option>
                <option value="selective_lab_hard">{t('bench.diffHard')}</option>
              </select>
            </div>

            <div className="lg:col-span-3 space-y-1.5">
              <label
                htmlFor="bench-weighting-select"
                className="block text-[11px] font-sans-display font-semibold text-[#4A5955]"
              >
                {t('bench.weightingLabel')}
              </label>
              <select
                id="bench-weighting-select"
                value={weighting}
                onChange={(e) => setWeighting(e.target.value as BenchmarkWeightingMode)}
                className="w-full px-3 py-1.5 rounded-[10px] border border-[#CFC6B9] bg-white text-xs text-[#113C36] focus:outline-none focus:border-[#113C36]"
              >
                <option value="official_2025_equal">{t('bench.weight2025')}</option>
                <option value="legacy_2021_2024">{t('bench.weightLegacy')}</option>
              </select>
            </div>
          </div>

          {/* Interactive 4-Section Score Sliders + Predicted NSW 4-Band Report */}
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-sans-display font-semibold text-[#4A5955]">
                {t('bench.sectionSimulatorTitle')}
              </h3>
              {isModified && (
                <button
                  type="button"
                  onClick={resetScores}
                  className="inline-flex items-center gap-1 text-xs font-sans-display font-semibold text-[#1D6346] hover:text-[#113C36] cursor-pointer"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>{t('bench.resetScores')}</span>
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {(
                [
                  { sec: 'READ' as SectionCode, val: readScore, max: readMax, set: setReadScore },
                  { sec: 'MATH' as SectionCode, val: mathScore, max: mathMax, set: setMathScore },
                  { sec: 'THINK' as SectionCode, val: thinkScore, max: thinkMax, set: setThinkScore },
                  { sec: 'WRIT' as SectionCode, val: writScore, max: writMax, set: setWritScore },
                ]
              ).map(({ sec, val, max, set }) => {
                const ev = report.sections[sec];
                return (
                  <div
                    key={sec}
                    className="p-3.5 rounded-[12px] bg-white border border-[#E5DFD5] space-y-2 tabular-nums"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-sans-display font-semibold text-[#113C36] inline-flex items-center gap-1.5 min-w-0">
                        <span className="truncate">
                          {sectionShortLabel(sec)} ({Math.round(ev.weight * 100)}%)
                        </span>
                        {sectionSources?.[sec] === 'assumed' && !touched[sec] && (
                          <span className="px-1.5 py-0.5 rounded bg-[#F3EFE8] text-[#78756E] text-[9px] font-medium shrink-0">
                            {t('bench.assumedBadge')}
                          </span>
                        )}
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded-full border text-[10px] font-sans-display font-semibold whitespace-nowrap shrink-0 ${bandPillClass(ev.band)}`}
                      >
                        {bandLabel(ev.band)}
                      </span>
                    </div>

                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-serif-display font-extrabold text-[22px] leading-none text-[#113C36]">
                        {val}
                        <span className="text-xs font-sans-display font-medium text-[#78756E]">
                          {' '}
                          / {max}
                        </span>
                      </span>
                      <span className="text-xs text-[#4A5955]">
                        {ev.rawPct.toFixed(0)}% (P{Math.round(ev.estimatedPercentile)})
                      </span>
                    </div>

                    <input
                      type="range"
                      min={0}
                      max={max}
                      step={1}
                      value={val}
                      aria-label={t('bench.scoreSliderAria', { section: sectionShortLabel(sec) })}
                      onChange={(e) => {
                        setTouched((prev) => ({ ...prev, [sec]: true }));
                        set(Number(e.target.value));
                      }}
                      className="w-full accent-[#113C36] cursor-pointer"
                    />
                  </div>
                );
              })}
            </div>
          </div>

          {/* Highest-Leverage Gain Callout */}
          {report.highestLeverage && (
            <div className="px-4 py-3 rounded-[12px] bg-[#E5F0EA]/70 border border-[#C5DDD1] flex items-start gap-2.5 text-xs text-[#113C36]">
              <Sparkles className="w-4 h-4 text-[#1D6346] shrink-0 mt-0.5" />
              <div className="leading-relaxed">
                <strong className="font-sans-display font-semibold">{t('bench.leverageTitle')}:</strong>{' '}
                {report.highestLeverage.unlockedSchools.length > 0
                  ? t('bench.leverageUnlock', {
                      step: localizedStepLabel(
                        report.highestLeverage.section,
                        report.highestLeverage.delta
                      ),
                      gain: report.highestLeverage.scaledGain120.toFixed(1),
                      schools: report.highestLeverage.unlockedSchools.join(', '),
                    })
                  : t('bench.leverageGainOnly', {
                      step: localizedStepLabel(
                        report.highestLeverage.section,
                        report.highestLeverage.delta
                      ),
                      gain: report.highestLeverage.scaledGain120.toFixed(1),
                    })}
              </div>
            </div>
          )}

          {/* NSW Fully Selective School Cutoff Table */}
          <div className="space-y-2.5">
            <div className="overflow-x-auto border border-[#E5DFD5] rounded-[12px] bg-white">
              <table className="w-full text-xs text-left tabular-nums">
                <thead className="bg-[#F3EFE8]/75 border-b border-[#E5DFD5] text-[#4A5955]">
                  <tr>
                    <th className="px-4 py-3 font-sans-display font-semibold">{t('bench.colSchool')}</th>
                    <th className="px-3 py-3 font-sans-display font-semibold">{t('bench.colSpots')}</th>
                    <th className="px-3 py-3 font-sans-display font-semibold">{t('bench.colHsc')}</th>
                    <th className="px-3 py-3 font-sans-display font-semibold">{t('bench.colCutoff')}</th>
                    <th className="px-3 py-3 font-sans-display font-semibold">{t('bench.colRawNeeded')}</th>
                    <th className="px-3 py-3 font-sans-display font-semibold">{t('bench.colDelta')}</th>
                    <th className="px-4 py-3 font-sans-display font-semibold text-right">{t('bench.colStatus')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E5DFD5]">
                  {visibleSchools.map((row) => (
                    <tr key={row.school.id} className="hover:bg-[#FAF8F5]/70">
                      <td className="px-4 py-3">
                        <div className="font-sans-display font-semibold text-[#113C36]">
                          {row.school.name}
                        </div>
                        <div className="text-[11px] text-[#78756E] mt-0.5">
                          {row.school.region},{' '}
                          {row.school.gender === 'coed'
                            ? t('bench.typeCoed')
                            : row.school.gender === 'girls'
                              ? t('bench.typeGirls')
                              : t('bench.typeBoys')}
                        </div>
                      </td>
                      <td className="px-3 py-3 whitespace-nowrap">
                        <div className="font-medium text-[#113C36]">{row.eligibleSpots}</div>
                        <div className="text-[11px] text-[#78756E]">
                          ~{row.estimatedGeneralSpots} {t('bench.generalShort')}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-[#4A5955] whitespace-nowrap">
                        #{row.school.hscRankRecent}
                      </td>
                      <td className="px-3 py-3 whitespace-nowrap">
                        <div className="font-semibold text-[#113C36]">
                          {row.firstRoundCutoff120.toFixed(1)}
                        </div>
                        <div className="text-[11px] text-[#78756E]">
                          {t('bench.reserveShort')} {row.reserveCutoff120.toFixed(1)}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-[#4A5955] whitespace-nowrap">
                        ~{row.equivalentRawPctNeeded}%
                      </td>
                      <td
                        className={`px-3 py-3 font-semibold whitespace-nowrap ${
                          row.deltaFromFirstRound >= 0
                            ? 'text-[#1D6346]'
                            : row.deltaFromReserve >= 0
                              ? 'text-[#A35116]'
                              : 'text-[#78756E]'
                        }`}
                      >
                        {row.deltaFromFirstRound >= 0 ? '+' : ''}
                        {row.deltaFromFirstRound.toFixed(1)}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <span
                          className={`inline-flex px-2.5 py-0.5 rounded-full border text-[11px] font-sans-display font-semibold ${statusPillClass(row.status)}`}
                        >
                          {statusLabel(row.status)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {report.schools.length > 10 && (
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setShowAllSchools((v) => !v)}
                  className="text-xs font-sans-display font-semibold text-[#4A5955] hover:text-[#113C36] underline underline-offset-4 cursor-pointer"
                >
                  {showAllSchools
                    ? t('bench.showTopSchools')
                    : t('bench.showAllSchools', { count: report.schools.length })}
                </button>
              </div>
            )}
          </div>

          {/* Transparent Personal-Use Methodology Note */}
          <div className="flex items-start gap-2 text-[11px] text-[#78756E] leading-relaxed">
            <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{t('bench.disclaimer')}</span>
          </div>
        </div>
      )}
    </section>
  );
}
