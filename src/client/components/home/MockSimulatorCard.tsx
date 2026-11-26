import { useState } from 'react';
import { Award, Clock } from 'lucide-react';
import type { api, DashboardResponse } from '../../api';
import { useI18n } from '../../i18n';
import type { DifficultyPreset, SectionCode } from '../../../shared/contracts';
import {
  allocateFullPoolMockCaps,
  CANONICAL_POOL_MOCK_COUNTS,
  computeOfficialPaceMinutesFromCounts,
  computePoolMockBaseMinutes,
  MAX_POOL_MOCK_COUNTS,
} from '../../../shared/engine';
import { NumericInput } from '../ui/NumericInput';
import { SegmentedControl } from '../ui/SegmentedControl';
import type { PendingLaunchSpec } from './launchSpec';

function defaultCountForScope(scope: 'ALL' | SectionCode): number {
  if (scope === 'WRIT') return 1;
  if (scope === 'READ') return CANONICAL_POOL_MOCK_COUNTS.READ;
  if (scope === 'ALL') return 30;
  return 20;
}

function quickPresetsForScope(scope: 'ALL' | SectionCode): { value: number; isFull?: boolean }[] {
  if (scope === 'READ') {
    return [
      { value: 8 },
      { value: CANONICAL_POOL_MOCK_COUNTS.READ, isFull: true },
    ];
  }
  if (scope === 'MATH') {
    return [
      { value: 15 },
      { value: 20 },
      { value: CANONICAL_POOL_MOCK_COUNTS.MATH, isFull: true },
    ];
  }
  if (scope === 'THINK') {
    return [
      { value: 15 },
      { value: 20 },
      { value: CANONICAL_POOL_MOCK_COUNTS.THINK, isFull: true },
    ];
  }
  if (scope === 'ALL') {
    return [
      { value: 30 },
      { value: 60 },
      { value: MAX_POOL_MOCK_COUNTS.ALL, isFull: true },
    ];
  }
  return [];
}

interface MockSimulatorCardProps {
  data: DashboardResponse | null;
  launching: string | null;
  onRequestLaunch: (spec: PendingLaunchSpec) => void;
  onNavigate: (path: string) => void;
}

/** Mock test simulator: fresh pool mock (default) or a fixed practice batch, with adjustable count and proportional timer. */
export function MockSimulatorCard({ data, launching, onRequestLaunch, onNavigate }: MockSimulatorCardProps) {
  const { t, isZh, sectionLabel, sectionShortLabel } = useI18n();
  // Mock Test Simulator controls (Fresh Pool Mock is default; Official & Holdout Benchmarks live on /benchmarks)
  const [mockMode, setMockMode] = useState<'pool' | 'batch'>('pool');
  const [mockScope, setMockScope] = useState<'ALL' | SectionCode>('MATH');
  const [poolMockCount, setPoolMockCount] = useState<number>(20);
  const [poolDifficulty, setPoolDifficulty] = useState<DifficultyPreset>('medium');
  const [selectedPaperKey, setSelectedPaperKey] = useState<string>('');
  const [paperSearch, setPaperSearch] = useState('');
  const [timerPreset, setTimerPreset] = useState<'1.0' | '0.75' | '1.25' | '1.5' | 'custom'>('1.0');
  const [customMinutes, setCustomMinutes] = useState<number>(40);

  const liveBySection: Record<SectionCode, number> = {
    READ: data?.poolCounts?.READ.live ?? 0,
    MATH: data?.poolCounts?.MATH.live ?? 0,
    THINK: data?.poolCounts?.THINK.live ?? 0,
    WRIT: data?.poolCounts?.WRIT.live ?? 0,
  };

  // Compute pool mock availability from live practice Question Bank counts
  const poolLiveForScope =
    mockScope === 'ALL'
      ? liveBySection.READ + liveBySection.MATH + liveBySection.THINK + liveBySection.WRIT
      : liveBySection[mockScope];

  const poolUnseenForScope = data?.poolCounts
    ? mockScope === 'ALL'
      ? data.poolCounts.READ.unseen +
        data.poolCounts.MATH.unseen +
        data.poolCounts.THINK.unseen +
        data.poolCounts.WRIT.unseen
      : data.poolCounts[mockScope].unseen
    : 0;

  // Practice batches only — official_calibration and benchmark_holdout papers are isolated on /benchmarks
  const customBatches = data?.customBatches ?? [];
  const benchmarkBatches = data?.benchmarkBatches ?? [];
  const allPaperOptions: {
    key: string;
    label: string;
    batchId: string;
    counts: Record<SectionCode, number>;
  }[] = customBatches.map((cb) => ({
    key: `batch:${cb.batchId}`,
    label: cb.batchLabel,
    batchId: cb.batchId,
    counts: cb.counts,
  }));

  const filteredPaperOptions = paperSearch.trim()
    ? allPaperOptions.filter((opt) =>
        opt.label.toLowerCase().includes(paperSearch.trim().toLowerCase())
      )
    : allPaperOptions;

  const selectedPaper =
    allPaperOptions.find((o) => o.key === selectedPaperKey) || allPaperOptions[0] || null;

  const batchQuestionCount = selectedPaper
    ? mockScope === 'ALL'
      ? Object.values(selectedPaper.counts).reduce((a, b) => a + b, 0)
      : selectedPaper.counts[mockScope]
    : 0;

  const canonicalFullPoolCount =
    Math.min(CANONICAL_POOL_MOCK_COUNTS.READ, liveBySection.READ) +
    Math.min(CANONICAL_POOL_MOCK_COUNTS.MATH, liveBySection.MATH) +
    Math.min(CANONICAL_POOL_MOCK_COUNTS.THINK, liveBySection.THINK) +
    Math.min(CANONICAL_POOL_MOCK_COUNTS.WRIT, liveBySection.WRIT);

  const maxPoolForScope =
    mockScope === 'WRIT'
      ? Math.min(1, liveBySection.WRIT)
      : mockScope === 'ALL'
        ? Math.min(MAX_POOL_MOCK_COUNTS.ALL, canonicalFullPoolCount)
        : Math.min(MAX_POOL_MOCK_COUNTS[mockScope], poolLiveForScope);

  const minPoolForScope = mockScope === 'ALL' ? Math.min(4, Math.max(1, maxPoolForScope)) : 1;

  const resolvedPoolCount =
    maxPoolForScope <= 0
      ? 0
      : mockScope === 'WRIT'
        ? 1
        : Math.min(maxPoolForScope, Math.max(minPoolForScope, Math.round(poolMockCount || defaultCountForScope(mockScope))));

  const mockQuestionCount = mockMode === 'pool' ? resolvedPoolCount : batchQuestionCount;

  const fullMockMix =
    mockMode === 'pool' && mockScope === 'ALL' && resolvedPoolCount > 0
      ? allocateFullPoolMockCaps(resolvedPoolCount, liveBySection)
      : null;

  const fullMockMixSummary = fullMockMix
    ? (['READ', 'MATH', 'THINK', 'WRIT'] as SectionCode[])
        .filter((sec) => fullMockMix[sec] > 0)
        .map((sec) => `${fullMockMix[sec]} ${sectionShortLabel(sec)}`)
        .join(isZh ? ' · ' : ' · ')
    : '';

  const baseOfficialMinutes =
    mockMode === 'pool'
      ? computePoolMockBaseMinutes(mockScope, resolvedPoolCount, liveBySection)
      : selectedPaper
        ? mockScope === 'ALL'
          ? computeOfficialPaceMinutesFromCounts(selectedPaper.counts)
          : computeOfficialPaceMinutesFromCounts({ [mockScope]: selectedPaper.counts[mockScope] })
        : 0;

  const scaledMinutesFor = (mult: number): number =>
    baseOfficialMinutes > 0 ? Math.max(1, Math.round(baseOfficialMinutes * mult)) : 0;

  const visiblePresets = quickPresetsForScope(mockScope).filter(
    (p) => p.value >= minPoolForScope && p.value <= maxPoolForScope
  );

  const handleScopeChange = (next: 'ALL' | SectionCode) => {
    setMockScope(next);
    const nextMax =
      next === 'WRIT'
        ? Math.min(1, liveBySection.WRIT)
        : next === 'ALL'
          ? Math.min(MAX_POOL_MOCK_COUNTS.ALL, canonicalFullPoolCount)
          : Math.min(MAX_POOL_MOCK_COUNTS[next], liveBySection[next]);
    const nextDefault = defaultCountForScope(next);
    setPoolMockCount(nextMax > 0 ? Math.min(nextMax, nextDefault) : nextDefault);
  };

  const handleLaunchMock = () => {
    if (mockMode === 'batch' && !selectedPaper) return;
    if (mockQuestionCount <= 0) return;
    const sectionFilter = mockScope === 'ALL' ? undefined : mockScope;
    const scopeLabel =
      mockScope === 'ALL' ? t('home.modalFullExam') : sectionLabel(mockScope);
    const diffLabel =
      poolDifficulty === 'easy'
        ? t('home.diffEasy')
        : poolDifficulty === 'hard'
          ? t('home.diffHard')
          : t('home.diffMedium');

    const title =
      mockMode === 'pool'
        ? `${t('home.modalMockTitle', {
            label: mockScope === 'ALL' ? t('home.modalFullExam') : t('home.modalSectionPractice', { section: scopeLabel }),
          })}${mockScope === 'WRIT' ? '' : ` (${diffLabel})`}`
        : `${selectedPaper!.label} — ${scopeLabel}`;

    const isOfficialFullAll =
      mockScope === 'ALL' &&
      canonicalFullPoolCount > 0 &&
      resolvedPoolCount >= canonicalFullPoolCount &&
      canonicalFullPoolCount === MAX_POOL_MOCK_COUNTS.ALL;

    const basePayload: Parameters<typeof api.createSession>[0] =
      mockMode === 'pool'
        ? {
            mode: 'section_drill',
            mockSource: 'pool',
            sectionFilter,
            ...(mockScope === 'WRIT' ? {} : { difficulty: poolDifficulty }),
            ...(isOfficialFullAll
              ? {}
              : { questionCount: mockScope === 'WRIT' ? 1 : resolvedPoolCount }),
          }
        : {
            mode: 'section_drill',
            mockSource: 'batch',
            batchId: selectedPaper!.batchId,
            sectionFilter,
          };

    const questionCountLabel =
      mockMode === 'pool' && mockScope === 'ALL' && fullMockMixSummary
        ? `${t('home.modalDrillCount', { count: mockQuestionCount })} (${fullMockMixSummary})`
        : mockQuestionCount === 1 && !isZh
          ? '1 question'
          : t('home.modalDrillCount', { count: mockQuestionCount });

    if (timerPreset === 'custom') {
      const mins = Math.max(1, Math.min(240, Math.round(customMinutes || 40)));
      onRequestLaunch({
        key: 'mock',
        title,
        questionCountLabel,
        durationLabel: t('home.modalMinutesLabel', { min: mins }),
        payload: {
          ...basePayload,
          customTimeLimitSec: mins * 60,
        },
      });
      return;
    }

    const mult = Number(timerPreset);
    const scaledMin = scaledMinutesFor(mult);
    onRequestLaunch({
      key: 'mock',
      title,
      questionCountLabel,
      durationLabel: t('home.modalMinutesLabel', { min: scaledMin }),
      payload: {
        ...basePayload,
        timeMultiplier: mult,
      },
    });
  };

  return (
    <section
      id="mock-simulator"
      data-tour="section-mocks"
      className="rounded-[18px] bg-[#FAF8F5] border border-[#E5DFD5] p-6 sm:p-8 space-y-6 scroll-mt-6"
    >
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div className="space-y-1.5">
          <h2 className="font-sans-display font-semibold text-[24px] sm:text-[26px] tracking-[-0.02em] text-[#113C36] leading-tight">
            {t('home.mockSectionTitle')}
          </h2>
          <p className="text-[14px] text-[#4A5955]">
            {t('home.sectionMocksLead')}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <div
            className="inline-flex items-center p-1 rounded-[12px] bg-[#F3EFE8] border border-[#E5DFD5] w-fit shrink-0"
            role="group"
            aria-label={t('home.mockSectionTitle')}
          >
            <button
              type="button"
              onClick={() => setMockMode('pool')}
              className={`px-3 py-1.5 rounded-[9px] text-xs font-sans-display font-semibold cursor-pointer transition-[background-color,color,transform,translate,scale] duration-150 ease-out active:scale-[0.98] whitespace-nowrap ${
                mockMode === 'pool'
                  ? 'bg-white text-[#113C36] shadow-[0_1px_2px_rgba(17,60,54,0.08)]'
                  : 'text-[#4A5955] hover:text-[#113C36]'
              }`}
            >
              {t('home.freshPoolMock')}
            </button>
            <button
              type="button"
              onClick={() => setMockMode('batch')}
              className={`px-3 py-1.5 rounded-[9px] text-xs font-sans-display font-semibold cursor-pointer transition-[background-color,color,transform,translate,scale] duration-150 ease-out active:scale-[0.98] whitespace-nowrap ${
                mockMode === 'batch'
                  ? 'bg-white text-[#113C36] shadow-[0_1px_2px_rgba(17,60,54,0.08)]'
                  : 'text-[#4A5955] hover:text-[#113C36]'
              }`}
            >
              {t('home.specificPaperBatch')}
            </button>
          </div>
          {benchmarkBatches.length > 0 && (
            <button
              type="button"
              onClick={() => onNavigate('/benchmarks')}
              className="px-3.5 py-2 rounded-[10px] border border-[#C5DDD1] bg-[#E5F0EA]/65 hover:bg-[#E5F0EA] text-xs font-sans-display font-semibold cursor-pointer transition-[background-color,border-color,transform,translate,scale] duration-150 ease-out active:scale-[0.98] whitespace-nowrap text-[#1D6346] inline-flex items-center gap-1.5"
            >
              <Award className="w-3.5 h-3.5 shrink-0" />
              <span>{t('home.goBenchmarks')}</span>
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
        <div className="min-w-0">
          <label
            htmlFor="mock-scope-select"
            className="block text-xs font-sans-display font-semibold text-[#4A5955] mb-1.5"
          >
            {t('home.testScope')}
          </label>
          <select
            id="mock-scope-select"
            value={mockScope}
            onChange={(e) => handleScopeChange(e.target.value as 'ALL' | SectionCode)}
            className="w-full px-3 py-2.5 rounded-[10px] border border-[#CFC6B9] bg-white text-sm text-[#113C36] focus:outline-none focus:border-[#113C36]"
          >
            <option value="READ">{t('home.scopeREAD')}</option>
            <option value="MATH">{t('home.scopeMATH')}</option>
            <option value="THINK">{t('home.scopeTHINK')}</option>
            <option value="WRIT">{t('home.scopeWRIT')}</option>
            <option value="ALL">{t('home.scopeALL')}</option>
          </select>
        </div>

        {mockMode === 'pool' ? (
          <div className="min-w-0 space-y-2">
            <label
              htmlFor="pool-mock-count"
              className="block text-xs font-sans-display font-semibold text-[#4A5955]"
            >
              {t('home.questionsToPull')}
            </label>
            {mockScope === 'WRIT' ? (
              <div className="w-full px-3 py-2.5 rounded-[10px] border border-[#CFC6B9] bg-[#F3EFE8] text-sm text-[#615E57]">
                {t('home.writingPromptCount')}
              </div>
            ) : (
              <>
                <NumericInput
                  id="pool-mock-count"
                  value={resolvedPoolCount}
                  min={minPoolForScope}
                  max={Math.max(minPoolForScope, maxPoolForScope)}
                  disabled={maxPoolForScope <= 0}
                  integer
                  stepper
                  showRange
                  label={t('home.questionsToPull')}
                  className="h-[42px]"
                  onCommit={setPoolMockCount}
                />
                {visiblePresets.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {visiblePresets.map((preset) => {
                      const active = resolvedPoolCount === preset.value;
                      return (
                        <button
                          key={preset.value}
                          type="button"
                          onClick={() => setPoolMockCount(preset.value)}
                          className={`px-2.5 py-0.5 rounded-full text-[11px] font-sans-display font-semibold tabular-nums cursor-pointer transition-tactile border ${
                            active
                              ? 'bg-[#113C36] border-[#113C36] text-white'
                              : 'bg-white border-[#CFC6B9] text-[#4A5955] hover:border-[#113C36] hover:text-[#113C36]'
                          }`}
                        >
                          {preset.isFull
                            ? t('home.presetFull', { count: preset.value })
                            : `${preset.value}${t('home.questionsUnitShort')}`}
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="min-w-0">
            <label
              htmlFor="mock-batch-select"
              className="block text-xs font-sans-display font-semibold text-[#4A5955] mb-1.5"
            >
              {t('home.paperOrBatch', { count: allPaperOptions.length })}
            </label>
            {allPaperOptions.length > 8 && (
              <input
                type="search"
                value={paperSearch}
                onChange={(e) => setPaperSearch(e.target.value)}
                placeholder={t('home.searchPapers')}
                className="w-full mb-1.5 px-3 py-1.5 rounded-[8px] border border-[#CFC6B9] bg-white text-xs text-[#113C36]"
              />
            )}
            <select
              id="mock-batch-select"
              disabled={filteredPaperOptions.length === 0}
              value={selectedPaper?.key || ''}
              onChange={(e) => setSelectedPaperKey(e.target.value)}
              className="w-full px-3 py-2.5 rounded-[10px] border border-[#CFC6B9] bg-white text-sm text-[#113C36] focus:outline-none focus:border-[#113C36] disabled:bg-[#F3EFE8]"
            >
              {filteredPaperOptions.length === 0 ? (
                <option value="">{t('home.noPracticeBatches')}</option>
              ) : (
                filteredPaperOptions.map((opt) => (
                  <option key={opt.key} value={opt.key}>
                    {opt.label}
                  </option>
                ))
              )}
            </select>
          </div>
        )}

        <div className="min-w-0">
          <label
            htmlFor="mock-timer-select"
            className="block text-xs font-sans-display font-semibold text-[#4A5955] mb-1.5"
          >
            {t('home.timerSetting')}
          </label>
          <div className="flex gap-2">
            <select
              id="mock-timer-select"
              value={timerPreset}
              onChange={(e) => setTimerPreset(e.target.value as typeof timerPreset)}
              className="flex-1 min-w-0 px-3 py-2.5 rounded-[10px] border border-[#CFC6B9] bg-white text-sm text-[#113C36] focus:outline-none focus:border-[#113C36]"
            >
              <option value="1.0">
                {baseOfficialMinutes > 0
                  ? t('home.timerWithMins', { label: t('home.timer10'), min: scaledMinutesFor(1.0) })
                  : t('home.timer10')}
              </option>
              <option value="0.75">
                {baseOfficialMinutes > 0
                  ? t('home.timerWithMins', { label: t('home.timer075'), min: scaledMinutesFor(0.75) })
                  : t('home.timer075')}
              </option>
              <option value="1.25">
                {baseOfficialMinutes > 0
                  ? t('home.timerWithMins', { label: t('home.timer125'), min: scaledMinutesFor(1.25) })
                  : t('home.timer125')}
              </option>
              <option value="1.5">
                {baseOfficialMinutes > 0
                  ? t('home.timerWithMins', { label: t('home.timer15'), min: scaledMinutesFor(1.5) })
                  : t('home.timer15')}
              </option>
              <option value="custom">{t('home.timerCustom')}</option>
            </select>
            {timerPreset === 'custom' && (
              <NumericInput
                value={customMinutes}
                min={1}
                max={240}
                integer
                suffix={t('home.minutesUnitShort')}
                label={t('home.timerCustom')}
                className="!w-[96px] h-[42px]"
                onCommit={setCustomMinutes}
              />
            )}
          </div>
        </div>
      </div>

      {mockMode === 'pool' && mockScope !== 'WRIT' && (
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1 border-t border-[#E5DFD5]/80">
          <div className="space-y-0.5">
            <div className="text-xs font-sans-display font-semibold text-[#4A5955]">
              {t('home.difficultyLabel')}
            </div>
            <p className="text-xs text-[#615E57]">
              {poolDifficulty === 'easy'
                ? t('home.diffEasyHint')
                : poolDifficulty === 'hard'
                  ? t('home.diffHardHint')
                  : t('home.diffMediumHint')}
            </p>
          </div>
          <SegmentedControl<DifficultyPreset>
            ariaLabel={t('home.difficultyLabel')}
            className="bg-[#F3EFE8] border-[#E5DFD5]"
            segmentClassName="px-3.5 py-1.5"
            value={poolDifficulty}
            onChange={setPoolDifficulty}
            options={[
              { value: 'easy', label: t('home.diffEasy') },
              { value: 'medium', label: t('home.diffMedium') },
              { value: 'hard', label: t('home.diffHard') },
            ]}
          />
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-4 pt-1">
        <div className="flex items-start gap-2 text-xs text-[#4A5955] min-w-0 flex-1">
          <Clock className="w-3.5 h-3.5 text-[#615E57] shrink-0 mt-0.5" />
          <div className="space-y-0.5 min-w-0">
            <div>
              {mockMode === 'pool'
                ? t('home.poolHint', { unseen: poolUnseenForScope, live: poolLiveForScope })
                : batchQuestionCount === 1
                  ? t('home.batchCountHintOne')
                  : t('home.batchCountHintMany', { count: batchQuestionCount })}
            </div>
            {mockMode === 'pool' && mockScope === 'ALL' && fullMockMixSummary && (
              <div className="text-[11px] text-[#615E57] tabular-nums">
                {t('home.mockMixPreview', { mix: fullMockMixSummary })}
              </div>
            )}
          </div>
        </div>
        <button
          type="button"
          disabled={launching !== null || mockQuestionCount === 0}
          onClick={handleLaunchMock}
          className="px-5 py-2.5 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-sm font-sans-display font-semibold transition-tactile disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
        >
          {launching === 'mock'
            ? t('home.startingMock')
            : mockMode === 'pool'
              ? t('home.startNMock', { count: mockQuestionCount })
              : t('home.startMockTest')}
        </button>
      </div>
    </section>
  );
}
