import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Play, RotateCcw } from 'lucide-react';
import { api, peekCachedResource, type DashboardResponse } from '../api';
import { getLocalizedSectionMixParts, useI18n } from '../i18n';
import type { SectionCode } from '../../shared/contracts';
import {
  IsometricBookStarIllustration,
  IsometricCompassTimerIllustration,
  IsometricPenManuscriptIllustration,
  SectionThumbnail,
} from './StudioIllustrations';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { Skeleton, SkeletonRegion } from './ui/Skeleton';
import { StatusBanner } from './ui/StatusBanner';
import type { PendingLaunchSpec } from './home/launchSpec';
import { MockSimulatorCard } from './home/MockSimulatorCard';
import {
  buildDrillLaunchSpec,
  drillCountsFrom,
  PracticeDrillsList,
  SECTION_DRILLS,
  type DrillCounts,
  type SectionDrill,
} from './home/PracticeDrillsList';

interface HomeViewProps {
  onOpenSession: (sessionId: string, isLocked?: boolean) => void;
  onNavigate: (path: string) => void;
  onOnboardingEligible?: (shouldShow: boolean) => void;
}

/** Cached dashboard safe to paint at once (an active session always redirects instead). */
function readCachedDashboard(): DashboardResponse | null {
  const cached = peekCachedResource('dashboard');
  return cached && !cached.activeSession ? cached : null;
}

function getGreetingKey(): 'home.greetMorning' | 'home.greetAfternoon' | 'home.greetEvening' {
  const hour = new Date().getHours();
  if (hour < 12) return 'home.greetMorning';
  if (hour < 17) return 'home.greetAfternoon';
  return 'home.greetEvening';
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

export function HomeView({ onOpenSession, onNavigate, onOnboardingEligible }: HomeViewProps) {
  const { t, isZh, sectionShortLabel, skillName, formatDate } = useI18n();
  const [initialDashboard] = useState(readCachedDashboard);
  const [data, setData] = useState<DashboardResponse | null>(initialDashboard);
  const [loading, setLoading] = useState(initialDashboard === null);
  const [launching, setLaunching] = useState<string | null>(null);
  const [pendingLaunch, setPendingLaunch] = useState<PendingLaunchSpec | null>(null);
  const [error, setError] = useState('');

  // Flexible Practice Drill counts per section (default 10)
  const [drillCounts, setDrillCounts] = useState<DrillCounts>(() => drillCountsFrom(initialDashboard));

  const drillDefaultRef = useRef(initialDashboard?.sectionDrillQuestionCount);

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
        // Keep the learner's drill-count edits unless the configured default actually changed.
        if (res.sectionDrillQuestionCount && drillDefaultRef.current !== res.sectionDrillQuestionCount) {
          drillDefaultRef.current = res.sectionDrillQuestionCount;
          setDrillCounts(drillCountsFrom(res));
        }
        setError('');
        if (res.shouldShowOnboarding) {
          onOnboardingEligible?.(true);
        }
      })
      .catch((err) => {
        // A background revalidation failure keeps the cached dashboard on screen.
        if (active && !initialDashboard) setError(err instanceof Error ? err.message : 'Unable to load dashboard.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [onOpenSession, onOnboardingEligible, initialDashboard]);


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
      setError(err instanceof Error ? err.message : t('home.unableStartSession'));
      setLaunching(null);
      setPendingLaunch(null);
    }
  };


  // Today's planned mix summary (from Gemini Decisions 1 Auto-Calibrate or manual config)
  const dailyLimits = data?.dailyLimits ?? { READ: 2, MATH: 3, THINK: 3, WRIT: 0 };
  const dailyTotalQuestions =
    (dailyLimits.READ || 0) +
    (dailyLimits.MATH || 0) +
    (dailyLimits.THINK || 0) +
    (dailyLimits.WRIT || 0);

  const dailyMixSummaryParts = getLocalizedSectionMixParts(dailyLimits, sectionShortLabel);

  const requestDailyLaunch = () => {
    const goalMin = data?.dailyGoalMinutes ?? 25;
    setPendingLaunch({
      key: 'daily',
      title: t('home.modalTodaysSetTitle'),
      questionCountLabel:
        dailyTotalQuestions > 0
          ? `${t('home.modalDrillCount', { count: dailyTotalQuestions })} (${dailyMixSummaryParts.join(isZh ? '、' : ', ')})`
          : t('home.todayPlanFallback'),
      durationLabel: t('home.modalDailyDuration', { min: goalMin }),
      payload: { mode: 'daily_adaptive' },
    });
  };


  const requestDrillLaunch = (drill: SectionDrill) => {
    setPendingLaunch(buildDrillLaunchSpec(drill, drillCounts, data, t, isZh));
  };


  const focusPlan = data?.dailyFocusPlan;
  const writingDrill = SECTION_DRILLS[3];
  const todayMinutes = data?.todayMinutes ?? 0;
  const dailyGoalMinutes = data?.dailyGoalMinutes ?? 25;
  const streakDays = data?.streakDays ?? 0;

  return (
    <main className="px-4 sm:px-7 lg:px-9 py-8 sm:py-10 space-y-12 max-w-[1160px] mx-auto">
      {error && <StatusBanner size="md">{error}</StatusBanner>}

      {/* Ready Confirmation Modal before starting a timed session */}
      <ConfirmDialog
        open={pendingLaunch !== null}
        eyebrow={t('home.modalEyebrow')}
        title={pendingLaunch?.title}
        busy={launching !== null}
        confirmIcon={<Play className="w-3.5 h-3.5 fill-current" />}
        confirmLabel={launching ? t('home.modalStarting') : t('home.modalConfirmStart')}
        cancelLabel={t('home.modalCancel')}
        onClose={() => setPendingLaunch(null)}
        onConfirm={() => {
          if (pendingLaunch) void launch(pendingLaunch.key, pendingLaunch.payload);
        }}
      >
        {pendingLaunch && (
          <>
            <dl className="grid grid-cols-2 gap-3 p-4 rounded-[12px] bg-[#FAF8F5] border border-[#E5DFD5] text-xs">
              <div>
                <dt className="text-[#615E57]">{t('home.modalQuestions')}</dt>
                <dd className="mt-1 font-sans-display font-semibold text-sm text-[#113C36]">
                  {pendingLaunch.questionCountLabel}
                </dd>
              </div>
              <div>
                <dt className="text-[#615E57]">{t('home.modalTimeAllowed')}</dt>
                <dd className="mt-1 font-sans-display font-semibold text-sm text-[#113C36]">
                  {pendingLaunch.durationLabel}
                </dd>
              </div>
            </dl>

            <div className="p-3.5 rounded-[12px] bg-[#FDF0E2] border border-[#A35116]/20 text-xs text-[#A35116] flex items-start gap-2.5 leading-relaxed">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{pendingLaunch.isUntimed ? t('home.modalWarnUntimed') : t('home.modalWarnTimed')}</span>
            </div>
          </>
        )}
      </ConfirmDialog>


      {/* Editorial Studio Greeting Header */}
      <header className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="font-sans-display font-semibold text-[28px] sm:text-[32px] tracking-[-0.025em] text-[#113C36] leading-tight">
            {t(getGreetingKey())}
          </h1>
          <p className="text-[15px] text-[#4A5955]">
            {t('home.subtitle')}
          </p>
        </div>

        {data?.activeSession && (
          <button
            type="button"
            onClick={() => onOpenSession(data.activeSession!.sessionId, true)}
            className="px-4 py-2.5 rounded-[10px] border border-[#113C36] bg-[#E5F0EA] hover:bg-[#d8e9df] text-xs font-sans-display font-semibold text-[#113C36] inline-flex items-center gap-2 cursor-pointer whitespace-nowrap shrink-0"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>{t('home.resumeActive')}</span>
          </button>
        )}
      </header>

      {/* Editorial Studio 3-Card Hero Band */}
      <section data-tour="hero-band" aria-label={t('home.todaysPractice')} className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Card 1: Today's Practice — Warm Apricot (#F9CAA7) */}
        <div className="lg:col-span-5 rounded-[16px] bg-[#F9CAA7] p-6 flex flex-col justify-between gap-5 border border-[#EAB690]/70">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2">
              <h2 className="font-sans-display font-semibold text-[18px] tracking-[-0.015em] text-[#113C36]">
                {t('home.todaysPractice')}
              </h2>
              {loading ? (
                <span className="block space-y-1.5 pt-0.5" aria-hidden="true">
                  <Skeleton className="skeleton-on-tint h-[13px] w-[26ch] max-w-full" />
                  <Skeleton className="skeleton-on-tint h-[13px] w-[18ch] max-w-full" />
                </span>
              ) : (
              <p className="text-[13px] text-[#113C36]/80 leading-relaxed max-w-[28ch]">
                {dailyTotalQuestions > 0
                  ? t('home.todayPlanLine', {
                      total: dailyTotalQuestions,
                      mix: dailyMixSummaryParts.join(isZh ? '、' : ', '),
                    })
                  : t('home.todayPlanFallback')}
              </p>
              )}
            </div>
            <IsometricBookStarIllustration className="w-[104px] h-[86px] shrink-0 -mt-1 -mr-1" />
          </div>

          <div className="space-y-5">
            <div className="flex items-end gap-7">
              <div>
                <div className="font-serif-display font-extrabold text-[44px] leading-none tracking-[-0.03em] text-[#113C36] tabular-nums">
                  {loading ? <Skeleton className="skeleton-on-tint h-[44px] w-[2.6ch]" /> : `${todayMinutes}m`}
                </div>
                <div className="mt-1.5 text-xs font-medium text-[#113C36]/75 tabular-nums">
                  {t('home.ofDailyGoal', { min: dailyGoalMinutes })}
                </div>
              </div>
              <div className="h-10 w-px bg-[#113C36]/15" aria-hidden="true" />
              <div>
                <div className="font-serif-display font-extrabold text-[44px] leading-none tracking-[-0.03em] text-[#113C36] tabular-nums">
                  {loading ? <Skeleton className="skeleton-on-tint h-[44px] w-[2.2ch]" /> : `${streakDays}d`}
                </div>
                <div className="mt-1.5 text-xs font-medium text-[#113C36]/75">
                  {t('home.studyStreak')}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <button
                type="button"
                disabled={launching !== null}
                onClick={requestDailyLaunch}
                className="px-5 py-2.5 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-sm font-sans-display font-semibold inline-flex items-center gap-2 transition-tactile disabled:opacity-60 cursor-pointer whitespace-nowrap"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>{launching === 'daily' ? t('home.preparing') : t('home.startTodaysPractice')}</span>
              </button>

              {data && data.todaySlotsAttempted > 0 && (
                <span className="text-xs font-medium text-[#113C36]/80 tabular-nums">
                  {t('home.todayAccuracy', {
                    correct: data.todaySlotsCorrect,
                    attempted: data.todaySlotsAttempted,
                  })}
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
                {t('home.minutesBadge', { min: 30 })}
              </span>
              <h2 className="font-serif-display font-bold text-[24px] leading-[1.18] tracking-[-0.02em] text-[#113C36] pt-1">
                {t('home.writeHeadline')}
              </h2>
            </div>
            <IsometricPenManuscriptIllustration className="w-[88px] h-[72px] shrink-0 -mr-1" />
          </div>

          <div className="space-y-4">
            <p className="text-[13px] text-[#4A5955] leading-relaxed">
              {t('home.writeDesc')}
            </p>
            <button
              type="button"
              disabled={launching !== null}
              onClick={() => requestDrillLaunch(writingDrill)}
              className="w-full sm:w-auto px-5 py-2.5 rounded-[10px] bg-[#F29A63] hover:bg-[#E6874C] text-[#113C36] text-sm font-sans-display font-semibold transition-tactile disabled:opacity-60 cursor-pointer whitespace-nowrap"
            >
              {t('home.startWritingSprint')}
            </button>
          </div>
        </div>

        {/* Card 3: Mock Exam Simulator — Soft Eucalyptus (#E5F0EA) */}
        <div className="lg:col-span-3 rounded-[16px] bg-[#E5F0EA] p-6 flex flex-col justify-between gap-5 border border-[#D4E4DC]">
          <div className="space-y-2.5">
            <IsometricCompassTimerIllustration className="w-[86px] h-[70px] -ml-1" />
            <h2 className="font-sans-display font-semibold text-[18px] tracking-[-0.015em] text-[#113C36] leading-snug">
              {t('home.mockHeroTitle')}
            </h2>
            <p className="text-[13px] text-[#4A5955] leading-relaxed">
              {t('home.mockHeroDesc')}
            </p>
          </div>

          <button
            type="button"
            onClick={() => {
              document.getElementById('mock-simulator')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }}
            className="w-full sm:w-auto px-4 py-2.5 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-sm font-sans-display font-semibold transition-tactile cursor-pointer whitespace-nowrap"
          >
            {t('home.configureMock')}
          </button>
        </div>
      </section>

      {/* Suggested Focus Strip (clean student copy — zero internal engine jargon) */}
      {focusPlan && focusPlan.focusSkillIds.length > 0 && (
        <section className="rounded-[14px] bg-[#FAF8F5] border border-[#E5DFD5] px-5 py-4 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-sans-display font-semibold text-sm text-[#113C36]">
              {t('home.focusTitle')}
            </h2>
            <div className="flex flex-wrap gap-1.5">
              {focusPlan.focusSkillIds.map((skillId) => (
                <span
                  key={skillId}
                  className="px-2.5 py-1 rounded-full bg-white border border-[#E5DFD5] text-xs font-medium text-[#113C36]"
                >
                  {skillName(skillId)}
                </span>
              ))}
            </div>
          </div>
          <p className="text-[13px] text-[#4A5955] leading-relaxed">{focusPlan.rationale}</p>
        </section>
      )}

      {/* Quick In-Page Section Strip (replaces redundant sidebar links) */}
      <nav
        aria-label={t('home.drillsTitle')}
        className="flex flex-wrap items-center gap-2 pt-1 border-b border-[#E5DFD5] pb-4"
      >
        <button
          type="button"
          onClick={() =>
            document.getElementById('practice-drills')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }
          className="px-3.5 py-1.5 rounded-full border border-[#E5DFD5] bg-[#FAF8F5] hover:bg-[#F3EFE8] hover:border-[#CFC6B9] text-[13px] font-sans-display font-semibold text-[#113C36] transition-[background-color,border-color,transform,translate,scale] duration-150 ease-out active:scale-[0.98] cursor-pointer"
        >
          {t('home.jumpDrills')}
        </button>
        <button
          type="button"
          onClick={() =>
            document.getElementById('mock-simulator')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }
          className="px-3.5 py-1.5 rounded-full border border-[#E5DFD5] bg-[#FAF8F5] hover:bg-[#F3EFE8] hover:border-[#CFC6B9] text-[13px] font-sans-display font-semibold text-[#113C36] transition-[background-color,border-color,transform,translate,scale] duration-150 ease-out active:scale-[0.98] cursor-pointer"
        >
          {t('home.jumpMocks')}
        </button>
        {data && data.recentSessions.length > 0 && (
          <button
            type="button"
            onClick={() =>
              document.getElementById('recent-sessions')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }
            className="px-3.5 py-1.5 rounded-full border border-[#E5DFD5] bg-[#FAF8F5] hover:bg-[#F3EFE8] hover:border-[#CFC6B9] text-[13px] font-sans-display font-semibold text-[#113C36] transition-[background-color,border-color,transform,translate,scale] duration-150 ease-out active:scale-[0.98] cursor-pointer"
          >
            {t('home.jumpRecent')}
          </button>
        )}
      </nav>

      {/* Hairline-Divided Section Practice Drills */}
      <PracticeDrillsList
        data={data}
        drillCounts={drillCounts}
        launching={launching}
        onChangeCount={(section, count) => setDrillCounts((prev) => ({ ...prev, [section]: count }))}
        onRequestDrill={requestDrillLaunch}
      />

      {/* Mock Test Simulator (Fresh Pool Mock Default + Fixed Paper / Batch Option) */}
      <MockSimulatorCard data={data} launching={launching} onRequestLaunch={setPendingLaunch} onNavigate={onNavigate} />


      {/* Hairline-Divided Recent Sessions */}
      {loading && !data && (
        <SkeletonRegion label={t('app.loading')} className="space-y-4">
          <Skeleton className="h-[28px] w-48" />
          <div className="border-t border-b border-[#E5DFD5] divide-y divide-[#E5DFD5]">
            {[0, 1, 2].map((row) => (
              <div key={row} className="py-3.5 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3.5 min-w-0 flex-1">
                  <Skeleton className="w-9 h-9 rounded-[10px] shrink-0" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <Skeleton className="h-[14px] w-1/2 max-w-[260px]" />
                    <Skeleton className="h-[12px] w-1/3 max-w-[180px]" />
                  </div>
                </div>
                <Skeleton className="h-[30px] w-20 rounded-[10px] shrink-0" />
              </div>
            ))}
          </div>
        </SkeletonRegion>
      )}
      {data && data.recentSessions.length > 0 && (
        <section id="recent-sessions" className="space-y-4 scroll-mt-6">
          <div className="flex items-end justify-between gap-3">
            <h2 className="font-sans-display font-semibold text-[22px] sm:text-[24px] tracking-[-0.02em] text-[#113C36] leading-tight">
              {t('home.recentSessions')}
            </h2>
            <button
              type="button"
              onClick={() => onNavigate('/progress')}
              className="text-[13px] font-sans-display font-semibold text-[#4A5955] hover:text-[#113C36] underline underline-offset-4 cursor-pointer whitespace-nowrap"
            >
              {t('home.viewFullProgress')}
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
                      {s.mode === 'repair_drill' && s.plannedQuestionIds?.length
                        ? t('repair.sessionTitle', { count: s.plannedQuestionIds.length })
                        : s.title || (s.mode === 'spaced_review' ? t('home.dailyPracticeSet') : s.mode.replace(/_/g, ' '))}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-[#615E57] tabular-nums">
                      <span>{formatDate(s.startedAt)}</span>
                      <span className="px-2 py-0.5 rounded-full bg-[#F3EFE8] text-[#4A5955] font-medium">
                        {s.status === 'submitted'
                          ? t('home.slotsCorrect', {
                              correct: s.correctSlots,
                              total: s.totalSlots,
                            })
                          : t('home.inProgress')}
                      </span>
                      {s.expiredAutoSubmitted && (
                        <span className="px-2 py-0.5 rounded-full bg-[#FDF0E2] text-[#A35116] font-medium">
                          {t('home.submittedAtDeadline')}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => onOpenSession(s.sessionId, s.status === 'in_progress')}
                  className="px-3.5 py-1.5 text-xs font-sans-display font-semibold rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-[#113C36] cursor-pointer whitespace-nowrap shrink-0 transition-tactile"
                >
                  {s.status === 'submitted' ? t('home.review') : t('home.resume')}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
