import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';

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

  const setOpen = useCallback(
    (next: boolean) => {
      if (controlledOpen === undefined) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [controlledOpen, onOpenChange]
  );
  const close = useCallback(() => setOpen(false), [setOpen]);

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
          id={panelId}
          role="dialog"
          aria-label={label}
          className={`absolute top-full z-40 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-[14px] border border-[#E5DFD5] bg-white p-4 shadow-[0_12px_32px_-12px_rgba(17,60,54,0.28)] transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] starting:opacity-0 starting:scale-[0.97] ${
            align === 'end' ? 'right-0 origin-top-right' : 'left-0 origin-top-left'
          } ${panelClassName}`}
        >
          {typeof children === 'function' ? children(close) : children}
        </div>
      )}
    </div>
  );
}
