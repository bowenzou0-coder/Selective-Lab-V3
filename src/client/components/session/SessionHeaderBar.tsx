import type { ReactNode } from 'react';
import { AlertTriangle, ArrowLeft, ChevronDown, CloudCheck, CloudOff, Flag, Grid, RefreshCw, ShieldAlert } from 'lucide-react';
import { LanguageToggle, useI18n } from '../../i18n';
import type { SessionClock } from '../../sessionClock';
import { ExamTimer } from './ExamTimer';
import { ShortcutHelpPopover } from './ShortcutHelpPopover';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'unsent' | 'failed' | 'conflict';

interface SessionHeaderBarProps {
  title: string;
  /** Learner-locked sessions hide the exit button. */
  isLockedStudentSession: boolean;
  isAdminRun: boolean;
  isSandbox?: boolean;
  sectionBadge: { current: number; total: number; label: string } | null;
  saveStatus: SaveStatus;
  clock: SessionClock;
  timerHidden: boolean;
  questionNumber: number;
  questionCount: number;
  isFlagged: boolean;
  navOpen: boolean;
  inspectorOpen: boolean;
  submitting: boolean;
  finishBtnLabel: string;
  /** Question navigator panel rendered under the rail when open. */
  navigator?: ReactNode;
  /** Keyboard shortcut legend (`?`); omitted when shortcuts do not apply. */
  shortcutsOpen?: boolean;
  onShortcutsOpenChange?: (open: boolean) => void;
  onExit: () => void;
  onSaveNow: () => void;
  onToggleTimerHidden: () => void;
  onToggleFlag: () => void;
  onToggleNav: () => void;
  onToggleInspector: () => void;
  onFinish: () => void;
}

/** Quiet exam-room top rail: title and save state, centred countdown, then flag/navigator/finish. */
export function SessionHeaderBar({
  title,
  isLockedStudentSession,
  isAdminRun,
  isSandbox = false,
  sectionBadge,
  saveStatus,
  clock,
  timerHidden,
  questionNumber,
  questionCount,
  isFlagged,
  navOpen,
  inspectorOpen,
  submitting,
  finishBtnLabel,
  navigator,
  shortcutsOpen = false,
  onShortcutsOpenChange,
  onExit,
  onSaveNow,
  onToggleTimerHidden,
  onToggleFlag,
  onToggleNav,
  onToggleInspector,
  onFinish,
}: SessionHeaderBarProps) {
  const { t } = useI18n();
  return (
    <header className="sticky top-0 z-30 border-b border-[#E5DFD5] bg-[#F3EFE8]">
      <div className="max-w-[1440px] mx-auto px-4 sm:px-6 min-h-[48px] py-1.5 grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] items-center gap-2.5">
        {/* Left: Plain title + soft emerald Saved pill */}
        <div className="flex items-center gap-2.5 min-w-0">
          {!isLockedStudentSession && (
            <button
              type="button"
              onClick={onExit}
              aria-label={isAdminRun ? t('session.backToBank') : t('session.exitAria')}
              className="inline-flex items-center gap-1.5 p-1.5 rounded-[8px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-[#4A5955] hover:text-[#113C36] cursor-pointer shrink-0 transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              {isAdminRun && <span className="hidden sm:inline pr-1 text-xs font-sans-display font-semibold">{t('session.backToBank')}</span>}
            </button>
          )}

          <div className="flex items-center gap-2.5 min-w-0 flex-wrap">
            <span className="font-sans-display font-semibold text-sm text-[#113C36] truncate">
              {title}
            </span>

            {sectionBadge && (
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-[#E5F0EA] border border-[#C5DDD1] text-[#113C36] text-[11px] font-sans-display font-semibold whitespace-nowrap">
                {t('session.sectionOfTotal', {
                  current: sectionBadge.current,
                  total: sectionBadge.total,
                })}{' '}
                ({sectionBadge.label})
              </span>
            )}

            {isAdminRun && (
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium whitespace-nowrap ${
                  isSandbox ? 'bg-[#E9E4F5] text-[#4B3B7A]' : 'bg-[#FDF0E2] text-[#A35116]'
                }`}
              >
                {isSandbox ? t('session.sandboxBadge') : t('session.liveRunBadge')}
              </span>
            )}

            {saveStatus === 'saving' && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-white/80 border border-[#E5DFD5] text-[11px] font-medium text-[#4A5955] whitespace-nowrap">
                {t('session.saving')}
              </span>
            )}
            {saveStatus === 'saved' && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#E5F3EC] text-[#1D6346] text-[11px] font-medium whitespace-nowrap">
                <CloudCheck className="w-3 h-3 shrink-0" />
                <span>{t('session.saved')}</span>
              </span>
            )}
            {saveStatus === 'unsent' && (
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[#FDF0E2] text-[#A35116] text-[11px] font-medium whitespace-nowrap">
                <span>{t('session.unsentDraft')}</span>
                <button
                  type="button"
                  onClick={onSaveNow}
                  className="underline hover:text-[#113C36] cursor-pointer"
                >
                  {t('session.saveNow')}
                </button>
              </span>
            )}
            {saveStatus === 'failed' && (
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[#FDECEB] text-[#B42318] text-[11px] font-medium whitespace-nowrap">
                <CloudOff className="w-3 h-3 shrink-0" />
                <span>{t('session.saveFailed')}</span>
                <button
                  type="button"
                  onClick={onSaveNow}
                  className="inline-flex items-center gap-1 underline hover:text-[#113C36] cursor-pointer"
                >
                  <RefreshCw className="w-2.5 h-2.5 shrink-0" />
                  {t('session.retry')}
                </button>
              </span>
            )}
            {saveStatus === 'conflict' && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#FDF0E2] text-[#A35116] text-[11px] font-semibold whitespace-nowrap">
                <AlertTriangle className="w-3 h-3 shrink-0" />
                <span>{t('session.conflictChip')}</span>
              </span>
            )}
          </div>
        </div>

        {/* Center: Prominent AnthropicMono Countdown Clock (click to hide) */}
        <div className="flex items-center justify-center">
          <ExamTimer clock={clock} hidden={timerHidden} onToggleHidden={onToggleTimerHidden} />
        </div>

        {/* Right: Question X of Y, Flag, Navigator, Language, Finish test */}
        <div className="flex items-center justify-start md:justify-end gap-2 flex-wrap">
          <div className="text-xs font-medium text-[#4A5955] tabular-nums whitespace-nowrap mr-1">
            {t('session.qOfTotal', { current: questionNumber, total: questionCount })}
          </div>

          <button
            type="button"
            onClick={onToggleFlag}
            aria-pressed={isFlagged}
            aria-keyshortcuts="F"
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] border text-xs font-sans-display font-medium cursor-pointer whitespace-nowrap transition-colors ${
              isFlagged
                ? 'border-[#A35116]/50 bg-[#FDF0E2] text-[#A35116]'
                : 'border-[#E5DFD5] bg-white text-[#4A5955] hover:text-[#113C36] hover:border-[#CFC6B9]'
            }`}
          >
            <Flag className="w-3.5 h-3.5" />
            <span>{isFlagged ? t('session.flagged') : t('session.flag')}</span>
          </button>

          <button
            type="button"
            onClick={onToggleNav}
            aria-expanded={navOpen}
            aria-keyshortcuts="N"
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] border text-xs font-sans-display font-medium cursor-pointer whitespace-nowrap transition-colors ${
              navOpen
                ? 'border-[#113C36] bg-[#E5F0EA] text-[#113C36]'
                : 'border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-[#113C36]'
            }`}
          >
            <Grid className="w-3.5 h-3.5" />
            <span>{t('session.navigator')}</span>
            <ChevronDown
              className={`w-3.5 h-3.5 opacity-70 transition-transform ${
                navOpen ? 'rotate-180' : ''
              }`}
            />
          </button>

          {isAdminRun && (
            <button
              type="button"
              onClick={onToggleInspector}
              aria-pressed={inspectorOpen}
              aria-keyshortcuts="I"
              title={t('session.inspectorToggleAria')}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] border text-xs font-sans-display font-medium cursor-pointer whitespace-nowrap transition-colors ${
                inspectorOpen
                  ? 'border-[#113C36] bg-[#E5F0EA] text-[#113C36]'
                  : 'border-[#CFC6B9] bg-white text-[#113C36]'
              }`}
            >
              <ShieldAlert className="w-3.5 h-3.5" />
              <span>{t('session.inspector')}</span>
              <kbd className="hidden sm:inline rounded border border-current/30 px-1 font-mono-code text-[10px] leading-4 opacity-70">I</kbd>
            </button>
          )}

          {onShortcutsOpenChange && (
            <ShortcutHelpPopover open={shortcutsOpen} onOpenChange={onShortcutsOpenChange} />
          )}

          <LanguageToggle compact />

          <button
            type="button"
            disabled={submitting}
            onClick={onFinish}
            className="px-3.5 py-1.5 rounded-[8px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-xs font-sans-display font-semibold cursor-pointer whitespace-nowrap disabled:opacity-60 transition-colors"
          >
            {finishBtnLabel}
          </button>
        </div>
      </div>

      {navigator}
    </header>
  );
}
