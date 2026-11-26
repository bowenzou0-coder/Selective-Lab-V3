import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Award,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  LayoutGrid,
  Loader2,
  Play,
  Settings,
  Sparkles,
  X,
} from 'lucide-react';
import { useI18n, type MessageKey } from '../i18n';
import { computeTourPlacement, padTargetRect, type TourRect } from './onboarding/tourPlacement';
import { useFocusTrap } from './ui/focusTrap';
import {
  IsometricBookStarIllustration,
  IsometricCompassTimerIllustration,
} from './StudioIllustrations';

export interface OnboardingTourProps {
  open: boolean;
  currentPath: string;
  onNavigate: (path: string) => void;
  onDismiss: () => void;
  onStartCalibration: () => Promise<void>;
}

interface TourStepSpec {
  id: string;
  targetSelector?: string;
  route?: string;
  titleKey: MessageKey;
  bodyKey: MessageKey;
  accentBg: string;
  icon: typeof Sparkles;
}

const TOUR_STEPS: TourStepSpec[] = [
  {
    id: 'welcome',
    route: '/',
    titleKey: 'tour.welcomeTitle',
    bodyKey: 'tour.welcomeBody',
    accentBg: 'bg-[#F9CAA7]/55',
    icon: Sparkles,
  },
  {
    id: 'dashboard',
    targetSelector: '[data-tour="nav-dashboard"]',
    route: '/',
    titleKey: 'tour.dashboardTitle',
    bodyKey: 'tour.dashboardBody',
    accentBg: 'bg-[#F9CAA7]/50',
    icon: LayoutGrid,
  },
  {
    id: 'benchmarks',
    targetSelector: '[data-tour="nav-benchmarks"]',
    route: '/benchmarks',
    titleKey: 'tour.benchmarksTitle',
    bodyKey: 'tour.benchmarksBody',
    accentBg: 'bg-[#E5F0EA]',
    icon: Award,
  },
  {
    id: 'progress',
    targetSelector: '[data-tour="nav-progress"]',
    route: '/progress',
    titleKey: 'tour.progressTitle',
    bodyKey: 'tour.progressBody',
    accentBg: 'bg-[#ECE8E1]',
    icon: BarChart3,
  },
  {
    id: 'settings',
    targetSelector: '[data-tour="nav-settings"]',
    route: '/settings',
    titleKey: 'tour.settingsTitle',
    bodyKey: 'tour.settingsBody',
    accentBg: 'bg-[#E5F0EA]',
    icon: Settings,
  },
  {
    id: 'finish',
    route: '/',
    titleKey: 'tour.finishTitle',
    bodyKey: 'tour.finishBody',
    accentBg: 'bg-[#E5F0EA]',
    icon: Play,
  },
];

type TargetRect = TourRect;

function findVisibleTargetRect(selector: string | undefined, viewport: { w: number; h: number }): TargetRect | null {
  if (!selector || typeof document === 'undefined') return null;
  const nodes = Array.from(document.querySelectorAll(selector));
  for (const el of nodes) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      return padTargetRect({ top: r.top, left: r.left, width: r.width, height: r.height }, viewport);
    }
  }
  return null;
}

export function OnboardingTour({
  open,
  currentPath,
  onNavigate,
  onDismiss,
  onStartCalibration,
}: OnboardingTourProps) {
  const { t } = useI18n();
  const [stepIndex, setStepIndex] = useState(0);
  const [targetRect, setTargetRect] = useState<TargetRect | null>(null);
  const [viewport, setViewport] = useState(() => ({
    w: typeof window !== 'undefined' ? window.innerWidth : 1280,
    h: typeof window !== 'undefined' ? window.innerHeight : 800,
  }));
  const [launchingCalibration, setLaunchingCalibration] = useState(false);
  const [calibrationError, setCalibrationError] = useState('');

  // Reset step to 0 whenever the tour opens freshly
  useEffect(() => {
    if (open) {
      setStepIndex(0);
      setCalibrationError('');
      setLaunchingCalibration(false);
    }
  }, [open]);

  const step = TOUR_STEPS[stepIndex] ?? TOUR_STEPS[0];

  // Navigate to the matching route so the user sees each tab live behind the spotlight
  useEffect(() => {
    if (!open || !step.route) return;
    if (currentPath !== step.route) {
      onNavigate(step.route);
    }
  }, [open, step.route, currentPath, onNavigate]);

  // Measure active target rectangle smoothly on step change, resize, and scroll
  const measureTarget = useCallback(() => {
    if (!open) return;
    const next = { w: window.innerWidth, h: window.innerHeight };
    setViewport((prev) => (prev.w === next.w && prev.h === next.h ? prev : next));
    setTargetRect(findVisibleTargetRect(step.targetSelector, next));
  }, [open, step.targetSelector]);

  useLayoutEffect(() => {
    if (!open) return;
    measureTarget();
    const rafId = window.requestAnimationFrame(measureTarget);
    const timerId = window.setTimeout(measureTarget, 140);
    window.addEventListener('resize', measureTarget);
    window.addEventListener('scroll', measureTarget, true);
    return () => {
      window.cancelAnimationFrame(rafId);
      window.clearTimeout(timerId);
      window.removeEventListener('resize', measureTarget);
      window.removeEventListener('scroll', measureTarget, true);
    };
  }, [open, measureTarget]);

  const handleNext = useCallback(() => {
    setCalibrationError('');
    setStepIndex((prev) => Math.min(TOUR_STEPS.length - 1, prev + 1));
  }, []);

  const handleBack = useCallback(() => {
    setCalibrationError('');
    setStepIndex((prev) => Math.max(0, prev - 1));
  }, []);

  // Focus stays inside the card while the tour runs; Escape skips; focus returns to the opener.
  const cardRef = useRef<HTMLDivElement>(null);
  useFocusTrap(cardRef, open, {
    onEscape: () => {
      if (!launchingCalibration) onDismiss();
    },
    initialFocus: () => cardRef.current?.querySelector<HTMLElement>('[data-tour-primary]'),
  });

  // Step changes swap the footer buttons; keep focus on the new primary action instead of <body>.
  useEffect(() => {
    if (!open) return;
    const card = cardRef.current;
    if (!card || card.contains(document.activeElement)) return;
    card.querySelector<HTMLElement>('[data-tour-primary]')?.focus({ preventScroll: true });
  }, [open, stepIndex]);

  // Left/Right step through the tour.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (launchingCalibration) return;
      if (e.key === 'ArrowRight' && stepIndex < TOUR_STEPS.length - 1) {
        e.preventDefault();
        handleNext();
      } else if (e.key === 'ArrowLeft' && stepIndex > 0) {
        e.preventDefault();
        handleBack();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, stepIndex, launchingCalibration, handleNext, handleBack]);

  const handleTriggerCalibration = async () => {
    setLaunchingCalibration(true);
    setCalibrationError('');
    try {
      await onStartCalibration();
    } catch {
      setCalibrationError(t('tour.calibrationError'));
      setLaunchingCalibration(false);
    }
  };

  if (!open || typeof document === 'undefined') return null;

  const isWelcome = step.id === 'welcome';
  const isFinish = step.id === 'finish';
  const isCentered = isWelcome || isFinish || !targetRect;
  const placement = computeTourPlacement(targetRect, viewport, isCentered);
  const cardStyle: React.CSSProperties = placement.style;
  const caretSide = placement.caretSide;
  const caretOffsetPx = placement.caretOffset;

  const StepIcon = step.icon;

  return createPortal(
    <div
      className="fixed inset-0 z-50 tour-backdrop-enter"
      role="presentation"
    >
      {/* Full-viewport translucent pine backdrop with crisp SVG spotlight cutout */}
      <svg
        className="fixed inset-0 w-full h-full pointer-events-auto"
        aria-hidden="true"
      >
        <defs>
          <mask id="selective-lab-tour-mask">
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            {targetRect && !isCentered && (
              <rect
                x={targetRect.left}
                y={targetRect.top}
                width={targetRect.width}
                height={targetRect.height}
                rx={12}
                ry={12}
                fill="black"
                style={{
                  transition:
                    'x 380ms cubic-bezier(0.22, 1, 0.36, 1), y 380ms cubic-bezier(0.22, 1, 0.36, 1), width 380ms cubic-bezier(0.22, 1, 0.36, 1), height 380ms cubic-bezier(0.22, 1, 0.36, 1)',
                }}
              />
            )}
          </mask>
        </defs>
        <rect
          x="0"
          y="0"
          width="100%"
          height="100%"
          fill="rgba(17, 60, 54, 0.44)"
          mask="url(#selective-lab-tour-mask)"
        />
      </svg>

      {/* Gliding Spotlight Ring + Pulsing Beacon Halo */}
      {targetRect && !isCentered && (
        <div
          aria-hidden="true"
          className="fixed pointer-events-none rounded-[13px] border-2 border-[#F9CAA7] shadow-[0_0_0_4px_rgba(249,202,167,0.22)] tour-spotlight-ring"
          style={{
            top: targetRect.top,
            left: targetRect.left,
            width: targetRect.width,
            height: targetRect.height,
          }}
        >
          <span className="absolute -inset-1 rounded-[15px] border-2 border-[#F9CAA7]/75 tour-beacon-halo" />
        </div>
      )}

      {/* Floating Editorial Walkthrough Card */}
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-tour-title"
        aria-describedby="onboarding-tour-body"
        tabIndex={-1}
        style={cardStyle}
        className="fixed z-10 rounded-[20px] bg-white border border-[#E5DFD5] shadow-[0_24px_60px_rgba(17,60,54,0.22)] outline-none tour-card-glide"
      >
        {/* Directional Caret Pointer */}
        <p className="sr-only" aria-live="polite" aria-atomic="true">
          {`${t('tour.stepOf', { current: stepIndex + 1, total: TOUR_STEPS.length })}: ${t(step.titleKey)}`}
        </p>
        {caretSide === 'left' && (
          <span
            aria-hidden="true"
            style={{ top: caretOffsetPx }}
            className="absolute -left-[7px] w-3.5 h-3.5 rotate-45 bg-white border-l border-b border-[#E5DFD5]"
          />
        )}
        {caretSide === 'bottom' && (
          <span
            aria-hidden="true"
            style={{ left: caretOffsetPx }}
            className="absolute -bottom-[7px] w-3.5 h-3.5 rotate-45 bg-white border-r border-b border-[#E5DFD5]"
          />
        )}
        {caretSide === 'top' && (
          <span
            aria-hidden="true"
            style={{ left: caretOffsetPx }}
            className="absolute -top-[7px] w-3.5 h-3.5 rotate-45 bg-white border-l border-t border-[#E5DFD5]"
          />
        )}

        <div
          style={{ maxHeight: placement.maxBodyHeight }}
          className="p-5 sm:p-6 space-y-5 overflow-y-auto overscroll-contain rounded-[20px] tour-card-enter"
        >
          {/* Top Bar: Animated Segmented Progress + Skip Button */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5" aria-label={t('tour.stepOf', { current: stepIndex + 1, total: TOUR_STEPS.length })}>
              {TOUR_STEPS.map((s, idx) => {
                const active = idx === stepIndex;
                const done = idx < stepIndex;
                return (
                  <button
                    key={s.id}
                    type="button"
                    disabled={launchingCalibration}
                    onClick={() => setStepIndex(idx)}
                    aria-label={t('tour.stepOf', { current: idx + 1, total: TOUR_STEPS.length })}
                    aria-current={active ? 'step' : undefined}
                    data-press="off"
                    className={`relative h-1.5 rounded-full before:absolute before:-inset-x-1 before:-inset-y-2 before:content-[''] transition-[width,background-color] duration-300 ease-out cursor-pointer ${
                      active
                        ? 'w-7 bg-[#113C36]'
                        : done
                          ? 'w-3 bg-[#113C36]/45 hover:bg-[#113C36]/70'
                          : 'w-2 bg-[#E5DFD5] hover:bg-[#CFC6B9]'
                    }`}
                  />
                );
              })}
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={launchingCalibration}
                onClick={onDismiss}
                className="px-2.5 py-1 rounded-[8px] text-xs font-sans-display font-medium text-[#615E57] hover:text-[#113C36] hover:bg-[#FAF8F5] transition-tactile cursor-pointer disabled:opacity-40"
              >
                {t('tour.skip')}
              </button>
              <button
                type="button"
                disabled={launchingCalibration}
                onClick={onDismiss}
                aria-label={t('tour.skip')}
                className="p-1 rounded-[8px] text-[#615E57] hover:text-[#113C36] hover:bg-[#FAF8F5] transition-tactile cursor-pointer disabled:opacity-40"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Step Content (keyed for crisp animated crossfade) */}
          <div key={step.id} className="space-y-4 tour-step-content">
            {(isWelcome || isFinish) ? (
              <div className={`rounded-[14px] ${step.accentBg} border border-[#E5DFD5]/80 px-5 py-4 flex items-center justify-between gap-4`}>
                <span className="text-xs font-sans-display font-semibold text-[#113C36]/80">
                  {t('tour.stepOf', { current: stepIndex + 1, total: TOUR_STEPS.length })}
                </span>
                <div className="tour-illustration-float">
                  {isWelcome ? (
                    <IsometricBookStarIllustration className="w-[88px] h-[72px]" />
                  ) : (
                    <IsometricCompassTimerIllustration className="w-[84px] h-[68px]" />
                  )}
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2.5">
                <div className={`w-9 h-9 rounded-[11px] ${step.accentBg} border border-[#E5DFD5] flex items-center justify-center text-[#113C36]`}>
                  <StepIcon className="w-4 h-4" />
                </div>
                <span className="text-xs font-sans-display font-medium text-[#615E57] tabular-nums">
                  {t('tour.stepOf', { current: stepIndex + 1, total: TOUR_STEPS.length })}
                </span>
              </div>
            )}

            <div className="space-y-2">
              <h2
                id="onboarding-tour-title"
                className="font-sans-display font-semibold text-[20px] tracking-[-0.02em] text-[#113C36] leading-snug"
              >
                {t(step.titleKey)}
              </h2>
              <p id="onboarding-tour-body" className="text-[14px] text-[#4A5955] leading-relaxed">
                {t(step.bodyKey)}
              </p>
            </div>

            {calibrationError && (
              <div
                role="alert"
                className="px-3.5 py-2.5 rounded-[10px] bg-[#FDECEB] text-[#B83A28] text-xs font-medium"
              >
                {calibrationError}
              </div>
            )}
          </div>

          {/* Action Footer */}
          <div className="flex flex-wrap items-center justify-between gap-2.5 pt-1">
            {isWelcome ? (
              <>
                <button
                  type="button"
                  onClick={onDismiss}
                  className="px-4 py-2 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-xs font-sans-display font-semibold text-[#4A5955] transition-[background-color,transform,translate,scale] duration-150 ease-out active:scale-[0.97] cursor-pointer"
                >
                  {t('tour.skip')}
                </button>
                <button
                  type="button"
                  data-tour-primary
                  onClick={handleNext}
                  className="px-5 py-2.5 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-xs font-sans-display font-semibold inline-flex items-center gap-1.5 transition-[background-color,transform,translate,scale] duration-150 ease-out active:scale-[0.97] cursor-pointer"
                >
                  <span>{t('tour.startTour')}</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </>
            ) : isFinish ? (
              <>
                <button
                  type="button"
                  disabled={launchingCalibration}
                  onClick={onDismiss}
                  className="px-4 py-2 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-xs font-sans-display font-semibold text-[#4A5955] transition-[background-color,transform,translate,scale] duration-150 ease-out active:scale-[0.97] cursor-pointer disabled:opacity-50"
                >
                  {t('tour.finishSkipBtn')}
                </button>
                <button
                  type="button"
                  data-tour-primary
                  disabled={launchingCalibration}
                  onClick={handleTriggerCalibration}
                  className="px-5 py-2.5 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-xs font-sans-display font-semibold inline-flex items-center gap-1.5 transition-[background-color,transform,translate,scale] duration-150 ease-out active:scale-[0.97] cursor-pointer disabled:opacity-60"
                >
                  {launchingCalibration ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Play className="w-3.5 h-3.5 fill-current" />
                  )}
                  <span>
                    {launchingCalibration
                      ? t('tour.startingCalibration')
                      : t('tour.startCalibrationBtn')}
                  </span>
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={handleBack}
                  className="px-3.5 py-2 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-xs font-sans-display font-semibold text-[#4A5955] inline-flex items-center gap-1 transition-[background-color,transform,translate,scale] duration-150 ease-out active:scale-[0.97] cursor-pointer"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                  <span>{t('tour.back')}</span>
                </button>
                <button
                  type="button"
                  data-tour-primary
                  onClick={handleNext}
                  className="px-5 py-2 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-xs font-sans-display font-semibold inline-flex items-center gap-1.5 transition-[background-color,transform,translate,scale] duration-150 ease-out active:scale-[0.97] cursor-pointer"
                >
                  <span>{t('tour.next')}</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
