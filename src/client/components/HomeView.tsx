import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Clock, Play, RotateCcw } from 'lucide-react';
import { api, type DashboardResponse } from '../api';
import type { MockTestBatch, SectionCode, SessionMode } from '../../shared/contracts';
import { SKILLS_TAXONOMY } from '../../shared/skills';
import {
  IsometricBookStarIllustration,
  IsometricCompassTimerIllustration,
  IsometricPenManuscriptIllustration,
  SectionThumbnail,
} from './StudioIllustrations';

const SKILL_NAME_MAP = new Map(SKILLS_TAXONOMY.map((s) => [s.skillId, s.displayName]));

interface HomeViewProps {
  onOpenSession: (sessionId: string, isLocked?: boolean) => void;
  onNavigate: (path: string) => void;
}

const SECTION_DRILLS: { code: SectionCode; label: string; detail: string; mode: SessionMode }[] = [
  {
    code: 'READ',
    label: 'Reading',
    detail: 'Fiction, vocabulary cloze, poetry, gapped text, and matching',
    mode: 'section_drill',
  },
  {
    code: 'MATH',
    label: 'Mathematical Reasoning',
    detail: 'Five-option problem solving, geometry, and visual diagrams',
    mode: 'section_drill',
  },
  {
    code: 'THINK',
    label: 'Thinking Skills',
    detail: 'Four-option logic, spatial puzzles, and critical reasoning',
    mode: 'section_drill',
  },
  {
    code: 'WRIT',
    label: 'Writing Sprint',
    detail: 'Timed 30-minute typed essay with banded A to E rubric feedback',
    mode: 'writing_sprint',
  },
];

interface PendingLaunchSpec {
  key: string;
  title: string;
  questionCountLabel: string;
  durationLabel: string;
  isUntimed?: boolean;
  payload: Parameters<typeof api.createSession>[0];
}

function getOfficialSectionMinutes(scope: 'ALL' | SectionCode): number {
  if (scope === 'WRIT') return 30;
  if (scope === 'ALL') return 150;
  return 40;
}

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function inferSessionThumbKind(title?: string, mode?: string): SectionCode | 'DAILY' | 'MOCK' {
  const t = `${title || ''} ${mode || ''}`.toLowerCase();
  if (t.includes('writing') || t.includes('writ')) return 'WRIT';
  if (t.includes('pt1') || t.includes('pt2') || t.includes('pt3') || t.includes('mock') || t.includes('benchmark')) {
    return 'MOCK';
  }
  if (t.includes('math')) return 'MATH';
  if (t.includes('think')) return 'THINK';
  if (t.includes('read')) return 'READ';
  return 'DAILY';
}

export function HomeView({ onOpenSession, onNavigate }: HomeViewProps) {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [launching, setLaunching] = useState<string | null>(null);
  const [pendingLaunch, setPendingLaunch] = useState<PendingLaunchSpec | null>(null);
  const [error, setError] = useState('');

  // Flexible Practice Drill counts per section (default 10)
  const [drillCounts, setDrillCounts] = useState<Record<'READ' | 'MATH' | 'THINK', number>>({
    READ: 10,
    MATH: 10,
    THINK: 10,
  });

  // Mock Test Simulator controls (Fresh Pool Mock is default!)
  const [mockMode, setMockMode] = useState<'pool' | 'batch'>('pool');
  const [mockScope, setMockScope] = useState<'ALL' | SectionCode>('MATH');
  const [poolMockCount, setPoolMockCount] = useState<string>('20');
  const [selectedPaperKey, setSelectedPaperKey] = useState<string>('PT1');
  const [paperSearch, setPaperSearch] = useState('');
  const [timerPreset, setTimerPreset] = useState<'1.0' | '0.75' | '1.25' | '1.5' | 'custom' | '0'>('1.0');
  const [customMinutes, setCustomMinutes] = useState('40');

  useEffect(() => {
    let active = true;
    api
      .getDashboard()
      .then((res) => {
        if (!active) return;
        if (res.activeSession) {
          onOpenSession(res.activeSession.sessionId, true);
          return;
        }
        setData(res);
        if (res.sectionDrillQuestionCount) {
          setDrillCounts({
            READ: res.sectionDrillQuestionCount,
            MATH: res.sectionDrillQuestionCount,
            THINK: res.sectionDrillQuestionCount,
          });
        }
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : 'Failed to load dashboard.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [onOpenSession]);

  const launch = async (
    key: string,
    payload: Parameters<typeof api.createSession>[0]
  ) => {
    setLaunching(key);
    setError('');
    try {
      const res = await api.createSession(payload);
      setPendingLaunch(null);
      onOpenSession(res.sessionId, true);
    } catch (err) {
      const activeId = (err as { activeSessionId?: string })?.activeSessionId;
      if (activeId) {
        setPendingLaunch(null);
        onOpenSession(activeId, true);
        return;
      }
      setError(err instanceof Error ? err.message : 'Unable to start session.');
      setLaunching(null);
      setPendingLaunch(null);
    }
  };

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
      label: 'Practice Test 1 (Official)',
      isOfficial: true,
      officialBatch: 'PT1',
      counts: data?.batchCounts.PT1 ?? { READ: 0, MATH: 0, THINK: 0, WRIT: 0 },
    },
    {
      key: 'PT2',
      label: 'Practice Test 2 (Official)',
      isOfficial: true,
      officialBatch: 'PT2',
      counts: data?.batchCounts.PT2 ?? { READ: 0, MATH: 0, THINK: 0, WRIT: 0 },
    },
    {
      key: 'PT3',
      label: 'Practice Test 3 (Benchmark holdout)',
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

  const resolvedPoolCount =
    mockScope === 'WRIT'
      ? Math.min(1, poolLiveForScope)
      : poolMockCount === 'ALL'
        ? poolLiveForScope
        : Math.min(poolLiveForScope, Math.max(1, Number(poolMockCount) || 20));

  const mockQuestionCount = mockMode === 'pool' ? resolvedPoolCount : batchQuestionCount;

  // Today's planned mix summary (from Gemini Decisions 1 Auto-Calibrate or manual config)
  const dailyLimits = data?.dailyLimits ?? { READ: 2, MATH: 3, THINK: 3, WRIT: 0 };
  const dailyTotalQuestions =
    (dailyLimits.READ || 0) +
    (dailyLimits.MATH || 0) +
    (dailyLimits.THINK || 0) +
    (dailyLimits.WRIT || 0);

  const dailyMixSummaryParts = [
    dailyLimits.READ > 0 ? `Reading ${dailyLimits.READ}` : '',
    dailyLimits.MATH > 0 ? `Maths ${dailyLimits.MATH}` : '',
    dailyLimits.THINK > 0 ? `Thinking ${dailyLimits.THINK}` : '',
    dailyLimits.WRIT > 0 ? `Writing ${dailyLimits.WRIT}` : '',
  ].filter(Boolean);

  const requestDailyLaunch = () => {
    const goalMin = data?.dailyGoalMinutes ?? 25;
    setPendingLaunch({
      key: 'daily',
      title: "Today's practice set",
      questionCountLabel:
        dailyTotalQuestions > 0
          ? `${dailyTotalQuestions} questions (${dailyMixSummaryParts.join(', ')})`
          : 'Mixed review and priority skills',
      durationLabel: `${goalMin} minutes`,
      payload: { mode: 'daily_adaptive' },
    });
  };

  const requestDrillLaunch = (drill: (typeof SECTION_DRILLS)[number]) => {
    const defaultCount = data?.sectionDrillQuestionCount ?? 10;
    const defaultMins = data?.sectionDrillTimeMinutes ?? 8;
    const qCount =
      drill.code === 'WRIT'
        ? 1
        : drillCounts[drill.code as 'READ' | 'MATH' | 'THINK'] ?? defaultCount;
    const min =
      drill.code === 'WRIT'
        ? 30
        : Math.max(4, Math.round((defaultMins * qCount) / Math.max(1, defaultCount)));
    setPendingLaunch({
      key: `drill_${drill.code}`,
      title: drill.code === 'WRIT' ? 'Writing sprint' : `${drill.label} drill`,
      questionCountLabel: `${qCount} question${qCount === 1 ? '' : 's'}`,
      durationLabel: `${min} minutes`,
      payload: {
        mode: drill.mode,
        sectionFilter: drill.code,
        questionCount: drill.code === 'WRIT' ? 1 : qCount,
        customTimeLimitSec: drill.code === 'WRIT' ? undefined : min * 60,
      },
    });
  };

  const handleLaunchMock = () => {
    const sectionFilter = mockScope === 'ALL' ? undefined : mockScope;
    const scopeLabel =
      mockScope === 'ALL'
        ? 'Full 4-section exam'
        : mockScope === 'READ'
          ? 'Reading'
          : mockScope === 'MATH'
            ? 'Mathematical Reasoning'
            : mockScope === 'THINK'
              ? 'Thinking Skills'
              : 'Writing';

    const title =
      mockMode === 'pool'
        ? `Fresh Question Bank mock (${scopeLabel})`
        : `${selectedPaper.label} — ${scopeLabel}`;

    const basePayload: Parameters<typeof api.createSession>[0] =
      mockMode === 'pool'
        ? {
            mode: 'section_drill',
            mockSource: 'pool',
            sectionFilter,
            questionCount: mockScope === 'WRIT' ? 1 : resolvedPoolCount,
          }
        : selectedPaper.isOfficial && selectedPaper.officialBatch
          ? {
              mode: selectedPaper.officialBatch === 'PT3' ? 'benchmark_exam' : 'section_drill',
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
      setPendingLaunch({
        key: 'mock',
        title,
        questionCountLabel: `${mockQuestionCount} question${mockQuestionCount === 1 ? '' : 's'}`,
        durationLabel: `${mins} minutes`,
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
    setPendingLaunch({
      key: 'mock',
      title,
      questionCountLabel: `${mockQuestionCount} question${mockQuestionCount === 1 ? '' : 's'}`,
      durationLabel: mult <= 0 ? 'Untimed practice' : `${scaledMin} minutes`,
      isUntimed: mult <= 0,
      payload: {
        ...basePayload,
        timeMultiplier: mult,
      },
    });
  };

  const focusPlan = data?.dailyFocusPlan;
  const writingDrill = SECTION_DRILLS[3];
  const todayMinutes = data?.todayMinutes ?? 0;
  const dailyGoalMinutes = data?.dailyGoalMinutes ?? 25;
  const streakDays = data?.streakDays ?? 0;

  return (
    <main className="px-6 sm:px-9 py-8 sm:py-9 space-y-10 max-w-[1160px] mx-auto">
      {error && (
        <div
          role="alert"
          className="p-3.5 rounded-[12px] bg-[var(--status-error-bg)] text-[var(--status-error)] text-sm font-medium"
        >
          {error}
        </div>
      )}

      {/* Ready Confirmation Modal before starting a timed session */}
      {pendingLaunch &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-50 m-0 flex items-center justify-center bg-[#113C36]/35 backdrop-blur-[2px] p-4"
            role="presentation"
            onClick={() => {
              if (!launching) setPendingLaunch(null);
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="ready-modal-title"
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-md rounded-[18px] bg-white border border-[#E5DFD5] p-6 space-y-5 shadow-[0_18px_40px_rgba(17,60,54,0.16)]"
            >
              <div className="space-y-1">
                <p className="text-xs font-sans-display font-medium text-[#78756E]">
                  Before you begin
                </p>
                <h2
                  id="ready-modal-title"
                  className="font-sans-display font-semibold text-xl tracking-[-0.015em] text-[#113C36]"
                >
                  {pendingLaunch.title}
                </h2>
              </div>

              <dl className="grid grid-cols-2 gap-3 p-4 rounded-[12px] bg-[#FAF8F5] border border-[#E5DFD5] text-xs">
                <div>
                  <dt className="text-[#78756E]">Questions</dt>
                  <dd className="mt-1 font-sans-display font-semibold text-sm text-[#113C36]">
                    {pendingLaunch.questionCountLabel}
                  </dd>
                </div>
                <div>
                  <dt className="text-[#78756E]">Time allowed</dt>
                  <dd className="mt-1 font-sans-display font-semibold text-sm text-[#113C36]">
                    {pendingLaunch.durationLabel}
                  </dd>
                </div>
              </dl>

              <div className="p-3.5 rounded-[12px] bg-[#FDF0E2] border border-[#A35116]/20 text-xs text-[#A35116] flex items-start gap-2.5 leading-relaxed">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  {pendingLaunch.isUntimed
                    ? 'Once started, your workspace stays inside this paper until you submit. Reloading keeps your answers saved.'
                    : 'Once started, the exam clock runs continuously on the server until you submit. Reloading keeps you inside the test.'}
                </span>
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-1">
                <button
                  type="button"
                  disabled={launching !== null}
                  onClick={() => setPendingLaunch(null)}
                  className="px-4 py-2 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-xs font-sans-display font-semibold text-[#4A5955] cursor-pointer disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={launching !== null}
                  onClick={() => launch(pendingLaunch.key, pendingLaunch.payload)}
                  className="px-5 py-2 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-xs font-sans-display font-semibold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-60"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>{launching ? 'Starting...' : 'Confirm and start'}</span>
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {/* Editorial Studio Greeting Header */}
      <header className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="font-sans-display font-semibold text-[28px] sm:text-[32px] tracking-[-0.025em] text-[#113C36] leading-tight">
            {getGreeting()}, ready to practise
          </h1>
          <p className="text-[15px] text-[#4A5955]">
            Choose your daily set, warm up with a timed section drill, or sit a fresh mock from the Question Bank.
          </p>
        </div>

        {data?.activeSession && (
          <button
            type="button"
            onClick={() => onOpenSession(data.activeSession!.sessionId, true)}
            className="px-4 py-2.5 rounded-[10px] border border-[#113C36] bg-[#E5F0EA] hover:bg-[#d8e9df] text-xs font-sans-display font-semibold text-[#113C36] inline-flex items-center gap-2 cursor-pointer whitespace-nowrap shrink-0"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Resume active paper</span>
          </button>
        )}
      </header>

      {/* Editorial Studio 3-Card Hero Band */}
      <section aria-label="Featured study modes" className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Card 1: Today's Practice — Warm Apricot (#F9CAA7) */}
        <div className="lg:col-span-5 rounded-[16px] bg-[#F9CAA7] p-6 flex flex-col justify-between gap-5 border border-[#EAB690]/70">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2">
              <h2 className="font-sans-display font-semibold text-[18px] tracking-[-0.015em] text-[#113C36]">
                Today&apos;s practice
              </h2>
              <p className="text-[13px] text-[#113C36]/80 leading-relaxed max-w-[28ch]">
                {dailyTotalQuestions > 0
                  ? `${dailyTotalQuestions} questions planned today: ${dailyMixSummaryParts.join(', ')}.`
                  : 'A tailored blend of due reviews and your next target skills.'}
              </p>
            </div>
            <IsometricBookStarIllustration className="w-[104px] h-[86px] shrink-0 -mt-1 -mr-1" />
          </div>

          <div className="space-y-5">
            <div className="flex items-end gap-7">
              <div>
                <div className="font-serif-display font-extrabold text-[44px] leading-none tracking-[-0.03em] text-[#113C36] tabular-nums">
                  {loading ? '—' : `${todayMinutes}m`}
                </div>
                <div className="mt-1.5 text-xs font-medium text-[#113C36]/75 tabular-nums">
                  of {dailyGoalMinutes}m daily goal
                </div>
              </div>
              <div className="h-10 w-px bg-[#113C36]/15" aria-hidden="true" />
              <div>
                <div className="font-serif-display font-extrabold text-[44px] leading-none tracking-[-0.03em] text-[#113C36] tabular-nums">
                  {loading ? '—' : `${streakDays}d`}
                </div>
                <div className="mt-1.5 text-xs font-medium text-[#113C36]/75">
                  study streak
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <button
                type="button"
                disabled={launching !== null}
                onClick={requestDailyLaunch}
                className="px-5 py-2.5 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-sm font-sans-display font-semibold inline-flex items-center gap-2 transition-colors disabled:opacity-60 cursor-pointer whitespace-nowrap"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>{launching === 'daily' ? 'Preparing...' : "Start today's practice"}</span>
              </button>

              {data && data.todaySlotsAttempted > 0 && (
                <span className="text-xs font-medium text-[#113C36]/80 tabular-nums">
                  {data.todaySlotsCorrect} of {data.todaySlotsAttempted} right today
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Card 2: Writing Sprint — Warm Stone (#ECE8E1) + Coral CTA (#F29A63) */}
        <div className="lg:col-span-4 rounded-[16px] bg-[#ECE8E1] p-6 flex flex-col justify-between gap-5 border border-[#DFD8CC]">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1.5">
              <span className="inline-block px-2.5 py-0.5 rounded-full bg-white/80 text-[12px] font-medium text-[#4A5955]">
                30 minutes
              </span>
              <h2 className="font-serif-display font-bold text-[24px] leading-[1.18] tracking-[-0.02em] text-[#113C36] pt-1">
                Write under exam time
              </h2>
            </div>
            <IsometricPenManuscriptIllustration className="w-[88px] h-[72px] shrink-0 -mr-1" />
          </div>

          <div className="space-y-4">
            <p className="text-[13px] text-[#4A5955] leading-relaxed">
              Plan in the scratchpad, type without spellcheck, and receive detailed Band A to E rubric feedback.
            </p>
            <button
              type="button"
              disabled={launching !== null}
              onClick={() => requestDrillLaunch(writingDrill)}
              className="w-full sm:w-auto px-5 py-2.5 rounded-[10px] bg-[#F29A63] hover:bg-[#E6874C] text-[#113C36] text-sm font-sans-display font-semibold transition-colors disabled:opacity-60 cursor-pointer whitespace-nowrap"
            >
              Start writing sprint
            </button>
          </div>
        </div>

        {/* Card 3: Mock Exam Simulator — Soft Eucalyptus (#E5F0EA) */}
        <div className="lg:col-span-3 rounded-[16px] bg-[#E5F0EA] p-6 flex flex-col justify-between gap-5 border border-[#D4E4DC]">
          <div className="space-y-2.5">
            <IsometricCompassTimerIllustration className="w-[86px] h-[70px] -ml-1" />
            <h2 className="font-sans-display font-semibold text-[18px] tracking-[-0.015em] text-[#113C36] leading-snug">
              Mock exam simulator
            </h2>
            <p className="text-[13px] text-[#4A5955] leading-relaxed">
              Build a fresh unseen mock from the Question Bank or sit a fixed official practice paper.
            </p>
          </div>

          <button
            type="button"
            onClick={() => {
              document.getElementById('mock-simulator')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }}
            className="w-full sm:w-auto px-4 py-2.5 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-sm font-sans-display font-semibold transition-colors cursor-pointer whitespace-nowrap"
          >
            Configure a mock
          </button>
        </div>
      </section>

      {/* Suggested Focus Strip (clean student copy — zero internal engine jargon) */}
      {focusPlan && focusPlan.focusSkillIds.length > 0 && (
        <section className="rounded-[14px] bg-[#FAF8F5] border border-[#E5DFD5] px-5 py-4 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-sans-display font-semibold text-sm text-[#113C36]">
              Suggested focus areas today
            </h2>
            <div className="flex flex-wrap gap-1.5">
              {focusPlan.focusSkillIds.map((skillId) => (
                <span
                  key={skillId}
                  className="px-2.5 py-1 rounded-full bg-white border border-[#E5DFD5] text-xs font-medium text-[#113C36]"
                >
                  {SKILL_NAME_MAP.get(skillId) || skillId}
                </span>
              ))}
            </div>
          </div>
          <p className="text-[13px] text-[#4A5955] leading-relaxed">{focusPlan.rationale}</p>
        </section>
      )}

      {/* Hairline-Divided Section Practice Drills */}
      <section id="practice-drills" className="space-y-3 scroll-mt-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-sans-display font-semibold text-[18px] tracking-[-0.015em] text-[#113C36]">
            Practice drills by section
          </h2>
          <span className="text-xs text-[#78756E]">
            Pick your question count for a focused warm-up from the Question Bank
          </span>
        </div>

        <div className="border-t border-b border-[#E5DFD5] divide-y divide-[#E5DFD5]">
          {SECTION_DRILLS.map((drill) => {
            const defaultCount = data?.sectionDrillQuestionCount ?? 10;
            const defaultMins = data?.sectionDrillTimeMinutes ?? 8;
            const qCount =
              drill.code === 'WRIT'
                ? 1
                : drillCounts[drill.code as 'READ' | 'MATH' | 'THINK'] ?? defaultCount;
            const mins =
              drill.code === 'WRIT'
                ? 30
                : Math.max(4, Math.round((defaultMins * qCount) / Math.max(1, defaultCount)));
            return (
              <div
                key={drill.code}
                className="py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 group"
              >
                <div className="flex items-center gap-3.5 min-w-0">
                  <SectionThumbnail kind={drill.code} />
                  <div className="min-w-0">
                    <div className="font-sans-display font-semibold text-[15px] text-[#113C36]">
                      {drill.label}
                    </div>
                    <p className="text-[13px] text-[#4A5955] truncate sm:whitespace-normal">
                      {drill.detail}
                    </p>
                  </div>
                </div>

                <div className="flex items-center justify-between sm:justify-end gap-2.5 shrink-0 pl-[50px] sm:pl-0">
                  {drill.code !== 'WRIT' ? (
                    <div
                      className="inline-flex items-center rounded-full bg-[#F3EFE8] p-0.5 text-xs"
                      role="group"
                      aria-label={`${drill.label} question count`}
                    >
                      {[5, 10, 15].map((n) => (
                        <button
                          key={n}
                          type="button"
                          onClick={() =>
                            setDrillCounts((prev) => ({
                              ...prev,
                              [drill.code as 'READ' | 'MATH' | 'THINK']: n,
                            }))
                          }
                          className={`px-2 py-0.5 rounded-full font-medium tabular-nums cursor-pointer transition-colors ${
                            qCount === n
                              ? 'bg-white text-[#113C36] shadow-[0_1px_2px_rgba(17,60,54,0.08)]'
                              : 'text-[#4A5955] hover:text-[#113C36]'
                          }`}
                        >
                          {n}q
                        </button>
                      ))}
                    </div>
                  ) : (
                    <span className="px-2.5 py-1 rounded-full bg-[#F3EFE8] text-xs font-medium text-[#4A5955]">
                      1 task
                    </span>
                  )}
                  <span className="px-2.5 py-1 rounded-full bg-[#F3EFE8] text-xs font-medium text-[#4A5955] tabular-nums">
                    {mins} min
                  </span>
                  <button
                    type="button"
                    disabled={launching !== null}
                    onClick={() => requestDrillLaunch(drill)}
                    className="px-3.5 py-2 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#113C36] hover:text-white hover:border-[#113C36] text-xs font-sans-display font-semibold text-[#113C36] transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
                  >
                    Start drill
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Mock Test Simulator (Fresh Pool Mock Default + Fixed Paper / Batch Option) */}
      <section
        id="mock-simulator"
        className="rounded-[16px] bg-[#FAF8F5] border border-[#E5DFD5] p-6 sm:p-7 space-y-6 scroll-mt-6"
      >
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div className="space-y-1">
            <h2 className="font-sans-display font-semibold text-[19px] tracking-[-0.015em] text-[#113C36]">
              Mock test simulator
            </h2>
            <p className="text-[13px] text-[#4A5955]">
              Draw a fresh unseen mock straight from the Question Bank, or sit an official practice paper or imported batch.
            </p>
          </div>

          <div
            className="inline-flex items-center p-1 rounded-[12px] bg-[#F3EFE8] border border-[#E5DFD5] w-fit"
            role="group"
            aria-label="Mock test source"
          >
            <button
              type="button"
              onClick={() => setMockMode('pool')}
              className={`px-3 py-1.5 rounded-[9px] text-xs font-sans-display font-semibold cursor-pointer transition-colors ${
                mockMode === 'pool'
                  ? 'bg-white text-[#113C36] shadow-[0_1px_2px_rgba(17,60,54,0.08)]'
                  : 'text-[#4A5955] hover:text-[#113C36]'
              }`}
            >
              Fresh pool mock
            </button>
            <button
              type="button"
              onClick={() => setMockMode('batch')}
              className={`px-3 py-1.5 rounded-[9px] text-xs font-sans-display font-semibold cursor-pointer transition-colors ${
                mockMode === 'batch'
                  ? 'bg-white text-[#113C36] shadow-[0_1px_2px_rgba(17,60,54,0.08)]'
                  : 'text-[#4A5955] hover:text-[#113C36]'
              }`}
            >
              Specific paper or batch
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {mockMode === 'pool' ? (
            <div>
              <label
                htmlFor="pool-mock-count"
                className="block text-xs font-sans-display font-semibold text-[#4A5955] mb-1.5"
              >
                Questions to pull
              </label>
              <select
                id="pool-mock-count"
                disabled={mockScope === 'WRIT'}
                value={mockScope === 'WRIT' ? '1' : poolMockCount}
                onChange={(e) => setPoolMockCount(e.target.value)}
                className="w-full px-3 py-2.5 rounded-[10px] border border-[#CFC6B9] bg-white text-sm text-[#113C36] focus:outline-none focus:border-[#113C36] disabled:bg-[#F3EFE8]"
              >
                {mockScope === 'WRIT' ? (
                  <option value="1">1 writing prompt</option>
                ) : mockScope === 'ALL' ? (
                  <>
                    <option value="30">30 questions (Quick full mock)</option>
                    <option value="60">60 questions (Half mock)</option>
                    <option value="105">105 questions (Official full)</option>
                    <option value="ALL">All available ({poolLiveForScope})</option>
                  </>
                ) : (
                  <>
                    <option value="10">10 questions</option>
                    <option value="20">20 questions</option>
                    <option value="30">30 questions</option>
                    <option value="35">35 questions</option>
                    <option value="40">40 questions</option>
                    <option value="ALL">All available ({poolLiveForScope})</option>
                  </>
                )}
              </select>
            </div>
          ) : (
            <div>
              <label
                htmlFor="mock-batch-select"
                className="block text-xs font-sans-display font-semibold text-[#4A5955] mb-1.5"
              >
                Paper or batch ({allPaperOptions.length} available)
              </label>
              {allPaperOptions.length > 8 && (
                <input
                  type="search"
                  value={paperSearch}
                  onChange={(e) => setPaperSearch(e.target.value)}
                  placeholder="Search papers or batches..."
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

          <div>
            <label
              htmlFor="mock-scope-select"
              className="block text-xs font-sans-display font-semibold text-[#4A5955] mb-1.5"
            >
              Test scope
            </label>
            <select
              id="mock-scope-select"
              value={mockScope}
              onChange={(e) => {
                const next = e.target.value as 'ALL' | SectionCode;
                setMockScope(next);
                if (next === 'ALL' && ['10', '20', '35', '40'].includes(poolMockCount)) {
                  setPoolMockCount('30');
                } else if (next !== 'ALL' && next !== 'WRIT' && ['60', '105'].includes(poolMockCount)) {
                  setPoolMockCount('20');
                }
              }}
              className="w-full px-3 py-2.5 rounded-[10px] border border-[#CFC6B9] bg-white text-sm text-[#113C36] focus:outline-none focus:border-[#113C36]"
            >
              <option value="READ">Reading (40 min)</option>
              <option value="MATH">Mathematical Reasoning (40 min)</option>
              <option value="THINK">Thinking Skills (40 min)</option>
              <option value="WRIT">Writing (30 min)</option>
              <option value="ALL">Full 4-section exam (150 min)</option>
            </select>
          </div>

          <div>
            <label
              htmlFor="mock-timer-select"
              className="block text-xs font-sans-display font-semibold text-[#4A5955] mb-1.5"
            >
              Timer setting
            </label>
            <div className="flex gap-2">
              <select
                id="mock-timer-select"
                value={timerPreset}
                onChange={(e) => setTimerPreset(e.target.value as typeof timerPreset)}
                className="flex-1 px-3 py-2.5 rounded-[10px] border border-[#CFC6B9] bg-white text-sm text-[#113C36] focus:outline-none focus:border-[#113C36]"
              >
                <option value="1.0">1.0× Official time</option>
                <option value="0.75">0.75× Speed pace</option>
                <option value="1.25">1.25× Extended time</option>
                <option value="1.5">1.5× Extended time</option>
                <option value="custom">Custom minutes</option>
                <option value="0">Untimed practice</option>
              </select>
              {timerPreset === 'custom' && (
                <input
                  type="number"
                  min={1}
                  max={240}
                  aria-label="Custom timer minutes"
                  value={customMinutes}
                  onChange={(e) => setCustomMinutes(e.target.value)}
                  className="w-20 px-2.5 py-2.5 rounded-[10px] border border-[#CFC6B9] bg-white text-sm tabular-nums text-[#113C36]"
                />
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 pt-1">
          <div className="flex items-center gap-2 text-xs text-[#4A5955]">
            <Clock className="w-3.5 h-3.5 text-[#78756E] shrink-0" />
            <span>
              {mockMode === 'pool'
                ? `${poolUnseenForScope} unseen ready in the Question Bank (${poolLiveForScope} live). Pulls unseen questions first and keeps benchmark holdout papers untouched.`
                : selectedPaper.officialBatch === 'PT3'
                  ? 'Practice Test 3 is kept separate from daily drills so your benchmark score stays fresh.'
                  : `${batchQuestionCount} question${batchQuestionCount === 1 ? '' : 's'} ready in this paper.`}
            </span>
          </div>
          <button
            type="button"
            disabled={launching !== null || mockQuestionCount === 0}
            onClick={handleLaunchMock}
            className="px-5 py-2.5 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-sm font-sans-display font-semibold transition-colors disabled:opacity-50 cursor-pointer whitespace-nowrap"
          >
            {launching === 'mock'
              ? 'Starting mock...'
              : mockMode === 'pool'
                ? `Start ${mockQuestionCount}-question mock`
                : 'Start mock test'}
          </button>
        </div>
      </section>

      {/* Hairline-Divided Recent Sessions */}
      {data && data.recentSessions.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-sans-display font-semibold text-[18px] tracking-[-0.015em] text-[#113C36]">
              Recent sessions
            </h2>
            <button
              type="button"
              onClick={() => onNavigate('/progress')}
              className="text-xs font-sans-display font-semibold text-[#4A5955] hover:text-[#113C36] underline underline-offset-4 cursor-pointer"
            >
              View full progress
            </button>
          </div>

          <div className="border-t border-b border-[#E5DFD5] divide-y divide-[#E5DFD5]">
            {data.recentSessions.slice(0, 5).map((s) => (
              <div
                key={s.sessionId}
                className="py-3.5 flex items-center justify-between gap-4"
              >
                <div className="flex items-center gap-3.5 min-w-0">
                  <SectionThumbnail kind={inferSessionThumbKind(s.title, s.mode)} />
                  <div className="min-w-0">
                    <div className="font-sans-display font-semibold text-[14px] text-[#113C36] truncate">
                      {s.title || (s.mode === 'spaced_review' ? 'Daily practice set' : s.mode.replace(/_/g, ' '))}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-[#78756E] tabular-nums">
                      <span>{new Date(s.startedAt).toLocaleDateString()}</span>
                      <span className="px-2 py-0.5 rounded-full bg-[#F3EFE8] text-[#4A5955] font-medium">
                        {s.status === 'submitted'
                          ? `${s.correctSlots} / ${s.totalSlots} correct`
                          : 'In progress'}
                      </span>
                      {s.expiredAutoSubmitted && (
                        <span className="px-2 py-0.5 rounded-full bg-[#FDF0E2] text-[#A35116] font-medium">
                          Submitted at deadline
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => onOpenSession(s.sessionId, s.status === 'in_progress')}
                  className="px-3.5 py-1.5 text-xs font-sans-display font-semibold rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-[#113C36] cursor-pointer whitespace-nowrap shrink-0 transition-colors"
                >
                  {s.status === 'submitted' ? 'Review' : 'Resume'}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
