import { memo } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useI18n } from '../../i18n';
import { formatTimer, useClockValue, type SessionClock } from '../../sessionClock';

/** The only component that re-renders on every clock tick during an exam. */
export const ExamTimer = memo(function ExamTimer({
  clock,
  hidden,
  onToggleHidden,
}: {
  clock: SessionClock;
  hidden: boolean;
  onToggleHidden: () => void;
}) {
  const { t } = useI18n();
  const remainingSec = useClockValue(clock, (c) => c.getRemainingSec());
  const elapsedSec = useClockValue(clock, (c) => c.getElapsedSec());
  const urgent = !hidden && remainingSec !== null && remainingSec <= 30;
  const warning = !hidden && remainingSec !== null && remainingSec <= 120;

  return (
    <button
      type="button"
      onClick={onToggleHidden}
      aria-label={hidden ? t('session.showTimer') : t('session.hideTimer')}
      title={hidden ? t('session.showTimer') : t('session.hideTimer')}
      className={`inline-flex cursor-pointer items-center gap-2 rounded-[10px] border px-4 py-1 transition-colors ${
        urgent
          ? 'border-[#B42318]/50 bg-[#FDECEB] text-[#B42318]'
          : warning
            ? 'border-[#A35116]/40 bg-[#FDF0E2] text-[#A35116]'
            : 'border-[#E5DFD5] bg-white text-[#113C36] hover:border-[#CFC6B9]'
      }`}
    >
      {hidden ? <Eye className="h-3.5 w-3.5 opacity-60" /> : <EyeOff className="h-3.5 w-3.5 opacity-55" />}
      <span
        data-testid="exam-timer-display"
        role="timer"
        aria-live="off"
        className="font-exam-clock text-xl leading-none tracking-tight sm:text-[22px]"
      >
        {hidden ? '--:--' : formatTimer(remainingSec ?? elapsedSec)}
      </span>
    </button>
  );
});
