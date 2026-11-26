import { useRef, type ReactNode } from 'react';
import { useSlidingIndicator } from './useSlidingIndicator';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
}

interface SegmentedControlProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
  /** Container surface (border + background). */
  className?: string;
  /** Per-segment padding/size. */
  segmentClassName?: string;
  /** `pine`: dark pill, white label. `paper`: white pill on a stone track (filters). */
  tone?: 'pine' | 'paper';
}

/**
 * Connected toggle (e.g. Auto-calibrate / Manual counts) with a pine pill that slides to the
 * pressed segment. Segments are `aria-pressed` buttons inside a labelled group.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  disabled = false,
  className = 'bg-white border-[#CFC6B9]',
  segmentClassName = 'px-3.5 py-1.5',
  tone = 'pine',
}: SegmentedControlProps<T>) {
  const pill = tone === 'pine' ? 'bg-[#113C36]' : 'bg-white shadow-[0_1px_2px_rgba(17,60,54,0.08)]';
  const activeText = tone === 'pine' ? 'text-white' : 'text-[#113C36]';
  const ref = useRef<HTMLDivElement>(null);
  const indicator = useSlidingIndicator(ref, value);

  return (
    <div
      ref={ref}
      role="group"
      aria-label={ariaLabel}
      className={`relative isolate inline-flex max-w-full items-center gap-1 overflow-x-auto overscroll-x-contain rounded-[12px] border p-1 [scrollbar-width:none] ${className}`}
    >
      <span
        aria-hidden="true"
        className={`sliding-indicator pointer-events-none absolute left-0 top-0 -z-10 rounded-[9px] ${pill} ${
          disabled ? 'opacity-55' : ''
        }`}
        style={indicator.style}
      />
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            data-indicator-active={active ? 'true' : undefined}
            onClick={() => {
              if (!active) onChange(option.value);
            }}
            className={`${segmentClassName} cursor-pointer whitespace-nowrap rounded-[9px] font-sans-display text-xs font-semibold transition-[color,background-color,scale] duration-150 ease-out disabled:cursor-not-allowed ${
              active
                ? `${activeText} ${indicator.visible ? '' : pill}`
                : 'text-[#4A5955] hover:text-[#113C36] disabled:opacity-55'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
