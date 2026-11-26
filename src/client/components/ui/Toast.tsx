import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, Info, X } from 'lucide-react';
import { useI18n } from '../../i18n';

export interface ToastProps {
  /** Empty string hides the toast. A new message restarts the timer. */
  message: string;
  onDismiss: () => void;
  tone?: 'success' | 'info';
  /** Auto-dismiss delay; paused while hovered or focused. `0` keeps it until dismissed. */
  durationMs?: number;
  dismissLabel?: string;
}

const EXIT_MS = 160;

/**
 * Lightweight studio toast, fixed to the viewport corner so it never shifts page layout.
 * The `role="status"` live region stays mounted so screen readers announce each new message.
 */
export function Toast({ message, onDismiss, tone = 'success', durationMs = 5000, dismissLabel }: ToastProps) {
  const { t } = useI18n();
  const [shown, setShown] = useState(message);
  const [closing, setClosing] = useState(false);
  const [paused, setPaused] = useState(false);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  // Keep the last text on screen while it fades out.
  useEffect(() => {
    if (message) {
      setShown(message);
      setClosing(false);
      return;
    }
    if (!shown) return;
    setClosing(true);
    const timer = window.setTimeout(() => {
      setShown('');
      setClosing(false);
    }, EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [message, shown]);

  useEffect(() => {
    if (!message || paused || durationMs <= 0) return;
    const timer = window.setTimeout(() => onDismissRef.current(), durationMs);
    return () => window.clearTimeout(timer);
  }, [message, paused, durationMs]);

  if (typeof document === 'undefined') return null;

  const Icon = tone === 'success' ? CheckCircle2 : Info;

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="pointer-events-none fixed inset-x-4 bottom-4 z-[60] flex justify-center sm:inset-x-auto sm:right-6 sm:bottom-6 sm:justify-end"
    >
      {shown && (
        <div
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
          onFocus={() => setPaused(true)}
          onBlur={() => setPaused(false)}
          className={`pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-[14px] border border-[#C5DDD1] bg-[#E5F0EA] py-3 pr-3 pl-4 text-xs font-medium text-[#113C36] shadow-[0_12px_32px_-12px_rgba(17,60,54,0.35)] transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none ${
            closing ? 'translate-y-1 opacity-0' : 'translate-y-0 opacity-100 starting:translate-y-2 starting:opacity-0'
          }`}
        >
          <Icon className="mt-px h-4 w-4 shrink-0 text-[#1D6346]" aria-hidden="true" />
          <span className="min-w-0 flex-1 leading-relaxed">{shown}</span>
          <button
            type="button"
            aria-label={dismissLabel || t('common.dismiss')}
            onClick={() => onDismissRef.current()}
            className="-m-1 shrink-0 cursor-pointer rounded-[8px] p-1 text-[#4A5955] transition-colors hover:bg-white/70 hover:text-[#113C36]"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>,
    document.body
  );
}
