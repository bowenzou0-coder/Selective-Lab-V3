import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
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

interface TargetRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function findVisibleTargetRect(selector?: string): TargetRect | null {
  if (!selector || typeof document === 'undefined') return null;
  const nodes = Array.from(document.querySelectorAll(selector));
  for (const el of nodes) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      const pad = 6;
      return {
        top: Math.max(4, r.top - pad),
        left: Math.max(4, r.left - pad),
        width: r.width + pad * 2,
        height: r.height + pad * 2,
      };
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
    setViewport({ w: window.innerWidth, h: window.innerHeight });
    setTargetRect(findVisibleTargetRect(step.targetSelector));
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

  // Keyboard shortcuts: Escape skips anytime, Left/Right navigate steps
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (launchingCalibration) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onDismiss();
      } else if (e.key === 'ArrowRight' && stepIndex < TOUR_STEPS.length - 1) {
        e.preventDefault();
        handleNext();
      } else if (e.key === 'ArrowLeft' && stepIndex > 0) {
        e.preventDefault();
        handleBack();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, stepIndex, launchingCalibration, onDismiss, handleNext, handleBack]);

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
  const isDesktopSidebarTarget = Boolean(targetRect && viewport.w >= 768 && targetRect.left < 280);
  const isMobileBottomTarget = Boolean(targetRect && !isDesktopSidebarTarget && targetRect.top > viewport.h * 0.58);

  const cardWidth = Math.min(410, viewport.w - 32);
  let cardStyle: React.CSSProperties;
  let caretSide: 'left' | 'bottom' | null = null;
  let caretOffsetPx = 28;

  if (isCentered) {
    cardStyle = {
      top: '50%',
      left: '50%',
      width: Math.min(460, viewport.w - 32),
      transform: 'translate(-50%, -50%)',
    };
  } else if (isDesktopSidebarTarget && targetRect) {
    const desiredTop = targetRect.top - 22;
    const clampedTop = Math.max(20, Math.min(viewport.h - 280, desiredTop));
    caretSide = 'left';
    caretOffsetPx = Math.max(22, Math.min(200, targetRect.top + targetRect.height / 2 - clampedTop - 7));
    cardStyle = {
      top: clampedTop,
      left: targetRect.left + targetRect.width + 20,
      width: cardWidth,
      transform: 'translate(0, 0)',
    };
  } else if (isMobileBottomTarget && targetRect) {
    const cardLeft = Math.max(16, (viewport.w - cardWidth) / 2);
    const bottomSpace = viewport.h - targetRect.top + 18;
    caretSide = 'bottom';
    caretOffsetPx = Math.max(
      24,
      Math.min(cardWidth - 36, targetRect.left + targetRect.width / 2 - cardLeft - 7)
    );
    cardStyle = {
      bottom: bottomSpace,
      left: cardLeft,
      width: cardWidth,
      transform: 'translate(0, 0)',
    };
  } else if (targetRect) {
    const cardLeft = Math.max(16, Math.min(viewport.w - cardWidth - 16, targetRect.left));
    const cardTop = Math.min(viewport.h - 260, targetRect.top + targetRect.height + 16);
    cardStyle = {
      top: Math.max(20, cardTop),
      left: cardLeft,
      width: cardWidth,
      transform: 'translate(0, 0)',
    };
  } else {
    cardStyle = {
      top: '50%',
      left: '50%',
      width: cardWidth,
      transform: 'translate(-50%, -50%)',
    };
  }

  const StepIcon = step.icon;

  return createPortal(
    <div
      className="fixed inset-0 z-50 tour-backdrop-enter"
      role="presentation"
      aria-live="polite"
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
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-tour-title"
        style={cardStyle}
        className="fixed z-10 rounded-[20px] bg-white border border-[#E5DFD5] shadow-[0_24px_60px_rgba(17,60,54,0.22)] tour-card-glide"
      >
        {/* Directional Caret Pointer */}
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

        <div className="p-6 space-y-5 tour-card-enter">
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
                    className={`h-1.5 rounded-full transition-[width,background-color] duration-300 ease-out cursor-pointer ${
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
                className="px-2.5 py-1 rounded-[8px] text-xs font-sans-display font-medium text-[#78756E] hover:text-[#113C36] hover:bg-[#FAF8F5] transition-colors cursor-pointer disabled:opacity-40"
              >
                {t('tour.skip')}
              </button>
              <button
                type="button"
                disabled={launchingCalibration}
                onClick={onDismiss}
                aria-label={t('tour.skip')}
                className="p-1 rounded-[8px] text-[#78756E] hover:text-[#113C36] hover:bg-[#FAF8F5] transition-colors cursor-pointer disabled:opacity-40"
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
                <span className="text-xs font-sans-display font-medium text-[#78756E] tabular-nums">
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
              <p className="text-[14px] text-[#4A5955] leading-relaxed">
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
                  className="px-4 py-2 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-xs font-sans-display font-semibold text-[#4A5955] transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] cursor-pointer"
                >
                  {t('tour.skip')}
                </button>
                <button
                  type="button"
                  onClick={handleNext}
                  className="px-5 py-2.5 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-xs font-sans-display font-semibold inline-flex items-center gap-1.5 transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] cursor-pointer"
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
                  className="px-4 py-2 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-xs font-sans-display font-semibold text-[#4A5955] transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] cursor-pointer disabled:opacity-50"
                >
                  {t('tour.finishSkipBtn')}
                </button>
                <button
                  type="button"
                  disabled={launchingCalibration}
                  onClick={handleTriggerCalibration}
                  className="px-5 py-2.5 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-xs font-sans-display font-semibold inline-flex items-center gap-1.5 transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] cursor-pointer disabled:opacity-60"
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
                  className="px-3.5 py-2 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-xs font-sans-display font-semibold text-[#4A5955] inline-flex items-center gap-1 transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] cursor-pointer"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                  <span>{t('tour.back')}</span>
                </button>
                <button
                  type="button"
                  onClick={handleNext}
                  className="px-5 py-2 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-xs font-sans-display font-semibold inline-flex items-center gap-1.5 transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] cursor-pointer"
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
