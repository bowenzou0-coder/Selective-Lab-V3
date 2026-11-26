import { useEffect, useId, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { useI18n } from '../../i18n';

export interface NumericInputProps {
  id?: string;
  value: number;
  min: number;
  max: number;
  /** Stepper increment; also the native `step` attribute. */
  step?: number;
  disabled?: boolean;
  /** Round typed values to whole numbers before committing. */
  integer?: boolean;
  /** Show a quiet `min–max` hint inside the field (also announced via aria-describedby). */
  showRange?: boolean;
  /** Show `−` / `+` buttons that move by `step` within `min`/`max`. */
  stepper?: boolean;
  /** Short inline unit suffix shown inside the field (e.g. "q" or "min"). */
  suffix?: string;
  /** Compact height/padding variant for inline rows. */
  compact?: boolean;
  /** Field name used in the stepper buttons' accessible labels ("Increase Daily goal"). */
  label?: string;
  className?: string;
  onCommit: (next: number) => void;
}

const BARE_INPUT_CLASS =
  'w-full px-3 py-2 rounded-[10px] border border-[#CFC6B9] bg-white text-sm text-[#113C36] tabular-nums disabled:bg-[#F3EFE8] disabled:text-[#615E57] disabled:cursor-not-allowed focus:outline-none focus:border-[#113C36]';

function stepDecimals(step: number): number {
  const text = String(step);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

/**
 * Number field that keeps a free-typing draft while focused and commits clamped values: typing
 * past `max` snaps to `max`, values below `min` wait for blur, and blank/invalid input reverts.
 */
export function NumericInput({
  id,
  value,
  min,
  max,
  step = 1,
  disabled = false,
  integer = false,
  showRange = false,
  stepper = false,
  suffix,
  compact = false,
  label,
  className = '',
  onCommit,
}: NumericInputProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(String(value));
  const [focused, setFocused] = useState(false);
  const rangeId = useId();
  const decimals = stepDecimals(step);

  useEffect(() => {
    if (!focused) setDraft(String(value));
  }, [value, focused]);

  const normalize = (n: number) => (integer ? Math.round(n) : n);

  const commitClamped = (raw: string) => {
    const parsed = Number(raw);
    if (raw.trim() === '' || Number.isNaN(parsed)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, normalize(parsed)));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };

  const nudge = (direction: 1 | -1) => {
    const raw = Number((value + direction * step).toFixed(decimals));
    const next = Math.min(max, Math.max(min, normalize(raw)));
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };

  const input = (
    <input
      id={id}
      type="number"
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      value={draft}
      aria-describedby={showRange ? rangeId : undefined}
      onFocus={(e) => {
        setFocused(true);
        e.target.select();
      }}
      onChange={(e) => {
        const nextRaw = e.target.value;
        if (nextRaw.trim() === '') {
          setDraft('');
          return;
        }
        const parsed = Number(nextRaw);
        if (Number.isNaN(parsed)) return;
        const next = normalize(parsed);
        if (next > max) {
          setDraft(String(max));
          if (max !== value) onCommit(max);
          return;
        }
        setDraft(nextRaw);
        if (next >= min && next !== value) onCommit(next);
      }}
      onBlur={() => {
        setFocused(false);
        commitClamped(draft);
      }}
      data-focus-ring={showRange || stepper || suffix ? 'parent' : undefined}
      className={
        showRange || stepper || suffix
          ? `min-w-0 flex-1 bg-transparent ${
              compact ? 'px-2 py-1 text-xs text-center font-semibold' : 'px-3 py-2 text-sm'
            } text-[#113C36] tabular-nums focus:outline-none disabled:cursor-not-allowed [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`
          : `${BARE_INPUT_CLASS} ${className}`
      }
    />
  );

  if (!showRange && !stepper && !suffix) return input;

  const fieldName = label || t('common.valueFallback');
  const stepButtonClass = compact
    ? 'grid w-7 shrink-0 cursor-pointer place-items-center text-[#4A5955] transition-[background-color,color] duration-150 hover:bg-[#F3EFE8] hover:text-[#113C36] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#113C36] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent'
    : 'grid w-8 shrink-0 cursor-pointer place-items-center text-[#4A5955] transition-[background-color,color] duration-150 hover:bg-[#F3EFE8] hover:text-[#113C36] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#113C36] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent';

  return (
    <div
      className={`flex w-full items-stretch overflow-hidden rounded-[10px] border border-[#CFC6B9] focus-within:border-[#113C36] has-[input:focus-visible]:[outline:3px_solid_rgba(17,60,54,0.2)] ${
        disabled ? 'bg-[#F3EFE8] text-[#615E57]' : 'bg-white'
      } ${className}`}
    >
      {stepper && (
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled || value <= min}
          aria-label={t('common.decreaseValue', { label: fieldName })}
          onClick={() => nudge(-1)}
          data-focus-ring="inset"
          className={`${stepButtonClass} border-r border-[#E5DFD5]`}
        >
          <Minus className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} aria-hidden="true" />
        </button>
      )}
      {input}
      {suffix && (
        <span
          className={`self-center whitespace-nowrap ${compact ? 'pr-2 text-[11px]' : 'pr-2.5 text-xs'} text-[#615E57] font-medium select-none`}
          aria-hidden="true"
        >
          {suffix}
        </span>
      )}
      {showRange && (
        <span
          id={rangeId}
          className="self-center whitespace-nowrap pr-2.5 text-[11px] text-[#615E57] tabular-nums select-none"
        >
          <span aria-hidden="true">
            {min}–{max}
          </span>
          <span className="sr-only">{t('common.rangeHint', { min, max })}</span>
        </span>
      )}
      {stepper && (
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled || value >= max}
          aria-label={t('common.increaseValue', { label: fieldName })}
          onClick={() => nudge(1)}
          data-focus-ring="inset"
          className={`${stepButtonClass} border-l border-[#E5DFD5]`}
        >
          <Plus className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
