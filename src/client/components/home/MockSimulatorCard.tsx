import { useState } from 'react';
import { Award, Clock } from 'lucide-react';
import type { api, DashboardResponse } from '../../api';
import { useI18n } from '../../i18n';
import type { MockTestBatch, SectionCode } from '../../../shared/contracts';
import type { PendingLaunchSpec } from './launchSpec';

function getOfficialSectionMinutes(scope: 'ALL' | SectionCode): number {
  if (scope === 'WRIT') return 30;
  if (scope === 'READ') return 45;
  if (scope === 'ALL') return 155;
  return 40;
}

interface MockSimulatorCardProps {
  data: DashboardResponse | null;
  launching: string | null;
  onRequestLaunch: (spec: PendingLaunchSpec) => void;
  onNavigate: (path: string) => void;
}

/** Mock test simulator: fresh pool mock (default) or a fixed paper/batch, with scope and timer presets. */
export function MockSimulatorCard({ data, launching, onRequestLaunch, onNavigate }: MockSimulatorCardProps) {
  const { t, isZh, sectionLabel } = useI18n();
  // Mock Test Simulator controls (Fresh Pool Mock is default; Official Benchmarks live on /benchmarks)
  const [mockMode, setMockMode] = useState<'pool' | 'batch'>('pool');
  const [mockScope, setMockScope] = useState<'ALL' | SectionCode>('MATH');
  const [poolMockCount, setPoolMockCount] = useState<string>('20');
  const [selectedPaperKey, setSelectedPaperKey] = useState<string>('PT1');
  const [paperSearch, setPaperSearch] = useState('');
  const [timerPreset, setTimerPreset] = useState<'1.0' | '0.75' | '1.25' | '1.5' | 'custom'>('1.0');
  const [customMinutes, setCustomMinutes] = useState('40');

  // Compute pool mock availability from live Question Bank counts
  const poolLiveForScope = data?.poolCounts
    ? mockScope === 'ALL'
      ? data.poolCounts.READ.live +
        data.poolCounts.MATH.live +
        data.poolCounts.THINK.live +
        data.poolCounts.WRIT.live
      : data.poolCounts[mockScope].live
    : 0;

  const poolUnseenForScope = data?.poolCounts
    ? mockScope === 'ALL'
      ? data.poolCounts.READ.unseen +
        data.poolCounts.MATH.unseen +
        data.poolCounts.THINK.unseen +
        data.poolCounts.WRIT.unseen
      : data.poolCounts[mockScope].unseen
    : 0;

  // Build unified list of official papers + custom imported batches (scales to 100+)
  const customBatches = data?.customBatches ?? [];
  const benchmarkBatches = data?.benchmarkBatches ?? [];
  const allPaperOptions: {
    key: string;
    label: string;
    isOfficial: boolean;
    officialBatch?: MockTestBatch;
    batchId?: string;
    counts: Record<SectionCode, number>;
  }[] = [
    {
      key: 'PT1',
      label: t('home.paperPT1'),
      isOfficial: true,
      officialBatch: 'PT1',
      counts: data?.batchCounts.PT1 ?? { READ: 0, MATH: 0, THINK: 0, WRIT: 0 },
    },
    {
      key: 'PT2',
      label: t('home.paperPT2'),
      isOfficial: true,
      officialBatch: 'PT2',
      counts: data?.batchCounts.PT2 ?? { READ: 0, MATH: 0, THINK: 0, WRIT: 0 },
    },
    {
      key: 'PT3',
      label: t('home.paperPT3'),
      isOfficial: true,
      officialBatch: 'PT3',
      counts: data?.batchCounts.PT3 ?? { READ: 0, MATH: 0, THINK: 0, WRIT: 0 },
    },
    ...customBatches.map((cb) => ({
      key: `batch:${cb.batchId}`,
      label: cb.batchLabel,
      isOfficial: false,
      batchId: cb.batchId,
      counts: cb.counts,
    })),
  ];

  const filteredPaperOptions = paperSearch.trim()
    ? allPaperOptions.filter((opt) =>
        opt.label.toLowerCase().includes(paperSearch.trim().toLowerCase())
      )
    : allPaperOptions;

  const selectedPaper =
    allPaperOptions.find((o) => o.key === selectedPaperKey) || allPaperOptions[0];

  const batchQuestionCount = selectedPaper
    ? mockScope === 'ALL'
      ? Object.values(selectedPaper.counts).reduce((a, b) => a + b, 0)
      : selectedPaper.counts[mockScope]
    : 0;

  const canonicalFullPoolCount = data?.poolCounts
    ? Math.min(17, data.poolCounts.READ.live) +
      Math.min(35, data.poolCounts.MATH.live) +
      Math.min(40, data.poolCounts.THINK.live) +
      Math.min(1, data.poolCounts.WRIT.live)
    : 0;

  const resolvedPoolCount =
    mockScope === 'WRIT'
      ? Math.min(1, poolLiveForScope)
      : mockScope === 'ALL' && poolMockCount === 'OFFICIAL'
        ? canonicalFullPoolCount
        : poolMockCount === 'ALL'
          ? poolLiveForScope
          : Math.min(poolLiveForScope, Math.max(1, Number(poolMockCount) || 20));

  const mockQuestionCount = mockMode === 'pool' ? resolvedPoolCount : batchQuestionCount;

  const handleLaunchMock = () => {
    const sectionFilter = mockScope === 'ALL' ? undefined : mockScope;
    const scopeLabel =
      mockScope === 'ALL' ? t('home.modalFullExam') : sectionLabel(mockScope);

    const title =
      mockMode === 'pool'
        ? t('home.modalMockTitle', {
            label: mockScope === 'ALL' ? t('home.modalFullExam') : t('home.modalSectionPractice', { section: scopeLabel }),
          })
        : `${selectedPaper.label} — ${scopeLabel}`;

    const basePayload: Parameters<typeof api.createSession>[0] =
      mockMode === 'pool'
        ? {
            mode: 'section_drill',
            mockSource: 'pool',
            sectionFilter,
            // Omit questionCount for Official Full so server uses canonical 17/35/40/1 section mix
            ...(mockScope === 'ALL' && poolMockCount === 'OFFICIAL'
              ? {}
              : { questionCount: mockScope === 'WRIT' ? 1 : resolvedPoolCount }),
          }
        : selectedPaper.isOfficial && selectedPaper.officialBatch
          ? {
              mode: 'section_drill',
              mockSource: 'batch',
              mockBatch: selectedPaper.officialBatch,
              sectionFilter,
            }
          : {
              mode: 'section_drill',
              mockSource: 'batch',
              batchId: selectedPaper.batchId,
              sectionFilter,
            };

    if (timerPreset === 'custom') {
      const mins = Math.max(1, Number(customMinutes) || 40);
      onRequestLaunch({
        key: 'mock',
        title,
        questionCountLabel:
          mockQuestionCount === 1 && !isZh
            ? '1 question'
            : t('home.modalDrillCount', { count: mockQuestionCount }),
        durationLabel: t('home.modalMinutesLabel', { min: mins }),
        payload: {
          ...basePayload,
          customTimeLimitSec: mins * 60,
        },
      });
      return;
    }

    const mult = Number(timerPreset);
    const baseMin = getOfficialSectionMinutes(mockScope);
    const scaledMin = mult <= 0 ? 0 : Math.round(baseMin * mult);
    onRequestLaunch({
      key: 'mock',
      title,
      questionCountLabel:
        mockQuestionCount === 1 && !isZh
          ? '1 question'
          : t('home.modalDrillCount', { count: mockQuestionCount }),
      durationLabel:
        mult <= 0 ? t('home.modalUntimedLabel') : t('home.modalMinutesLabel', { min: scaledMin }),
      isUntimed: mult <= 0,
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

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {mockMode === 'pool' ? (
          <div className="min-w-0">
            <label
              htmlFor="pool-mock-count"
              className="block text-xs font-sans-display font-semibold text-[#4A5955] mb-1.5"
            >
              {t('home.questionsToPull')}
            </label>
            <select
              id="pool-mock-count"
              disabled={mockScope === 'WRIT'}
              value={mockScope === 'WRIT' ? '1' : poolMockCount}
              onChange={(e) => setPoolMockCount(e.target.value)}
              className="w-full px-3 py-2.5 rounded-[10px] border border-[#CFC6B9] bg-white text-sm text-[#113C36] focus:outline-none focus:border-[#113C36] disabled:bg-[#F3EFE8]"
            >
              {mockScope === 'WRIT' ? (
                <option value="1">{t('home.writingPromptCount')}</option>
              ) : mockScope === 'ALL' ? (
                <>
                  <option value="30">{t('home.quickFullMock')}</option>
                  <option value="60">{t('home.halfMock')}</option>
                  <option value="OFFICIAL">{t('home.officialFullMock')}</option>
                  <option value="ALL">{t('home.allAvailable', { count: poolLiveForScope })}</option>
                </>
              ) : (
                <>
                  <option value="10">{t('home.nQuestions', { count: 10 })}</option>
                  <option value="20">{t('home.nQuestions', { count: 20 })}</option>
                  <option value="30">{t('home.nQuestions', { count: 30 })}</option>
                  <option value="35">{t('home.nQuestions', { count: 35 })}</option>
                  <option value="40">{t('home.nQuestions', { count: 40 })}</option>
                  <option value="ALL">{t('home.allAvailable', { count: poolLiveForScope })}</option>
                </>
              )}
            </select>
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
              value={selectedPaperKey}
              onChange={(e) => setSelectedPaperKey(e.target.value)}
              className="w-full px-3 py-2.5 rounded-[10px] border border-[#CFC6B9] bg-white text-sm text-[#113C36] focus:outline-none focus:border-[#113C36]"
            >
              {filteredPaperOptions.map((opt) => (
                <option key={opt.key} value={opt.key}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        )}

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
            onChange={(e) => {
              const next = e.target.value as 'ALL' | SectionCode;
              setMockScope(next);
              if (next === 'ALL' && ['10', '20', '35', '40'].includes(poolMockCount)) {
                setPoolMockCount('30');
              } else if (next !== 'ALL' && next !== 'WRIT' && ['60', 'OFFICIAL', '93', '105'].includes(poolMockCount)) {
                setPoolMockCount('20');
              }
            }}
            className="w-full px-3 py-2.5 rounded-[10px] border border-[#CFC6B9] bg-white text-sm text-[#113C36] focus:outline-none focus:border-[#113C36]"
          >
            <option value="READ">{t('home.scopeREAD')}</option>
            <option value="MATH">{t('home.scopeMATH')}</option>
            <option value="THINK">{t('home.scopeTHINK')}</option>
            <option value="WRIT">{t('home.scopeWRIT')}</option>
            <option value="ALL">{t('home.scopeALL')}</option>
          </select>
        </div>

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
              <option value="1.0">{t('home.timer10')}</option>
              <option value="0.75">{t('home.timer075')}</option>
              <option value="1.25">{t('home.timer125')}</option>
              <option value="1.5">{t('home.timer15')}</option>
              <option value="custom">{t('home.timerCustom')}</option>
            </select>
            {timerPreset === 'custom' && (
              <input
                type="number"
                min={1}
                max={240}
                aria-label={t('home.timerCustom')}
                value={customMinutes}
                onChange={(e) => setCustomMinutes(e.target.value)}
                className="w-20 px-2.5 py-2.5 rounded-[10px] border border-[#CFC6B9] bg-white text-sm tabular-nums text-[#113C36]"
              />
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4 pt-1">
        <div className="flex items-center gap-2 text-xs text-[#4A5955] min-w-0 flex-1">
          <Clock className="w-3.5 h-3.5 text-[#615E57] shrink-0" />
          <span>
            {mockMode === 'pool'
              ? t('home.poolHint', { unseen: poolUnseenForScope, live: poolLiveForScope })
              : batchQuestionCount === 1
                ? t('home.batchCountHintOne')
                : t('home.batchCountHintMany', { count: batchQuestionCount })}
          </span>
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
