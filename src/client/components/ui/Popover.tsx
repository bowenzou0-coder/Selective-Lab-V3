import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { clampShiftX } from './viewportClamp';

interface PopoverTriggerProps {
  'aria-expanded': boolean;
  'aria-controls': string;
  'aria-haspopup': 'dialog';
  onClick: () => void;
}

interface PopoverProps {
  /** Render the trigger button; spread `props` onto it. */
  trigger: (props: PopoverTriggerProps, open: boolean) => ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  /** Which trigger edge the panel lines up with (and scales from). */
  align?: 'start' | 'end';
  label: string;
  panelClassName?: string;
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * Anchored, non-modal panel: closes on Escape (focus returns to the trigger) and on outside
 * pointer-down. Scales in from the trigger edge; closing is instant because it is frequent.
 */
export function Popover({
  trigger,
  children,
  align = 'start',
  label,
  panelClassName = '',
  className = '',
  open: controlledOpen,
  onOpenChange,
}: PopoverProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [shiftX, setShiftX] = useState(0);

  const setOpen = useCallback(
    (next: boolean) => {
      if (controlledOpen === undefined) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [controlledOpen, onOpenChange]
  );
  const close = useCallback(() => setOpen(false), [setOpen]);

  // Keep the panel on-screen at narrow widths (e.g. a filter trigger near the right edge at 390px).
  useLayoutEffect(() => {
    if (!open) {
      setShiftX(0);
      return;
    }
    const measure = () => {
      const panel = panelRef.current;
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      setShiftX((prev) => {
        const baseLeft = rect.left - prev;
        return clampShiftX(baseLeft, baseLeft + rect.width, window.innerWidth);
      });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
      rootRef.current?.querySelector<HTMLElement>('[aria-haspopup="dialog"]')?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      {trigger(
        {
          'aria-expanded': open,
          'aria-controls': panelId,
          'aria-haspopup': 'dialog',
          onClick: () => setOpen(!open),
        },
        open
      )}
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label={label}
          style={shiftX ? { translate: `${shiftX}px 0` } : undefined}
          className={`absolute top-full z-40 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-[14px] border border-[#E5DFD5] bg-white p-4 shadow-[0_12px_32px_-12px_rgba(17,60,54,0.28)] transition-[opacity,scale] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] starting:opacity-0 starting:scale-[0.97] ${
            align === 'end' ? 'right-0 origin-top-right' : 'left-0 origin-top-left'
          } ${panelClassName}`}
        >
          {typeof children === 'function' ? children(close) : children}
        </div>
      )}
    </div>
  );
}
