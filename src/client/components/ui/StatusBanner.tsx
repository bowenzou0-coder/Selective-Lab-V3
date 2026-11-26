import type { ReactNode } from 'react';
import { X } from 'lucide-react';

export interface StatusBannerProps {
  children: ReactNode;
  tone?: 'error' | 'success' | 'warning';
  /** Renders a dismiss button when provided. */
  onDismiss?: () => void;
  dismissLabel?: string;
  /** `md` for page-level load errors, `sm` for compact action feedback. */
  size?: 'sm' | 'md';
  className?: string;
}

const TONE_CLASS: Record<NonNullable<StatusBannerProps['tone']>, string> = {
  error: 'bg-[var(--status-error-bg)] border-[#B42318]/25 text-[var(--status-error)]',
  success: 'bg-[#E5F0EA] border-[#C5DDD1] text-[#113C36]',
  warning: 'bg-[#FDF0E2] border-[#A35116]/25 text-[#A35116]',
};

/**
 * Persistent inline banner for messages that must stay until acted on (load or action errors).
 * Errors use `role="alert"`; other tones are polite status updates. Transient confirmations
 * belong in `Toast` instead.
 */
export function StatusBanner({
  children,
  tone = 'error',
  onDismiss,
  dismissLabel,
  size = 'sm',
  className = '',
}: StatusBannerProps) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`flex items-center justify-between gap-3 rounded-[12px] border font-medium ${
        size === 'md' ? 'p-3.5 text-sm' : 'px-4 py-3 text-xs'
      } ${TONE_CLASS[tone]} ${className}`}
    >
      <span className="min-w-0">{children}</span>
      {onDismiss && (
        <button
          type="button"
          aria-label={dismissLabel}
          onClick={onDismiss}
          className="-m-1 shrink-0 cursor-pointer rounded-[8px] p-1 opacity-80 transition-opacity hover:opacity-100"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
