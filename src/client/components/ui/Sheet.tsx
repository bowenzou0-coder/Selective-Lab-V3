import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { restoreFocusTo } from './focusTrap';

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** `right`: slide-over sheet. `center`: modal dialog. */
  variant?: 'right' | 'center';
  /**
   * Modal sheets trap focus and dim the page. Non-modal sheets leave the page usable
   * (e.g. the simulator inspector beside a live question).
   */
  modal?: boolean;
  closeLabel: string;
  widthClassName?: string;
}

const EXIT_MS = 180;

/**
 * Accessible sheet/dialog built on the native <dialog> element (top layer, Escape, focus
 * handling). Portaled to <body> so it never becomes the `:last-child` of a `space-y-*` stack.
 */
export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  variant = 'right',
  modal = true,
  closeLabel,
  widthClassName,
}: SheetProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      if (!openerRef.current && typeof document !== 'undefined') {
        openerRef.current = document.activeElement as HTMLElement | null;
      }
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) return;
    setClosing(true);
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const timer = window.setTimeout(() => {
      const dialog = ref.current;
      const focusInside = !document.activeElement || document.activeElement === document.body || dialog?.contains(document.activeElement);
      dialog?.close();
      setMounted(false);
      setClosing(false);
      // Native close() restores focus for modal dialogs; do it explicitly so non-modal sheets
      // and openers that re-rendered still get focus back.
      const opener = openerRef.current;
      openerRef.current = null;
      if (focusInside) restoreFocusTo(opener);
    }, reduce ? 0 : EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [open, mounted]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !mounted || !open || dialog.open) return;
    if (modal) dialog.showModal();
    else dialog.show();
  }, [mounted, open, modal]);

  // Non-modal dialogs don't get the native `cancel` event, so handle Escape ourselves.
  useEffect(() => {
    if (!open || modal) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, modal]);

  if (!mounted || typeof document === 'undefined') return null;

  const isRight = variant === 'right';
  const width = widthClassName ?? (isRight ? 'w-[min(26rem,100vw)]' : 'w-[min(32rem,calc(100vw-2rem))]');
  const motion = isRight
    ? `translate-x-0 starting:translate-x-full ${closing ? 'translate-x-full' : ''}`
    : `opacity-100 scale-100 starting:opacity-0 starting:scale-[0.97] ${closing ? 'opacity-0 scale-[0.97]' : ''}`;

  return createPortal(
    <dialog
      ref={ref}
      aria-modal={modal ? 'true' : undefined}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        onCloseRef.current();
      }}
      onClick={(e) => {
        // Clicks on the ::backdrop land on the <dialog> element itself.
        if (modal && e.target === e.currentTarget) onCloseRef.current();
      }}
      className={`${width} max-w-none bg-transparent p-0 text-[#113C36] backdrop:bg-[#113C36]/25 backdrop:backdrop-blur-[1px] ${
        isRight ? 'fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-none' : 'm-auto max-h-[calc(100dvh-2rem)]'
      } ${modal ? '' : 'z-50'}`}
    >
      <div
        className={`flex h-full flex-col bg-[#FAF8F5] shadow-[0_24px_48px_-16px_rgba(17,60,54,0.35)] transition-[opacity,transform,translate,scale] duration-[220ms] ease-[cubic-bezier(0.32,0.72,0,1)] ${
          isRight ? 'border-l border-[#E5DFD5]' : 'max-h-[calc(100dvh-2rem)] rounded-[18px] border border-[#E5DFD5]'
        } ${motion}`}
      >
        <header className="flex items-start justify-between gap-3 border-b border-[#E5DFD5] px-5 py-4">
          <div className="min-w-0 space-y-0.5">
            <h2 id={titleId} className="font-sans-display text-[15px] font-semibold text-[#113C36]">
              {title}
            </h2>
            {description && (
              <p id={descId} className="text-xs leading-relaxed text-[#4A5955]">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => onCloseRef.current()}
            aria-label={closeLabel}
            className="-mr-1 shrink-0 cursor-pointer rounded-[8px] p-1.5 text-[#4A5955] transition-[background-color,transform,translate,scale] duration-150 hover:bg-[#ECE8E1] hover:text-[#113C36] active:scale-[0.96]"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">{children}</div>
        {footer && <footer className="border-t border-[#E5DFD5] px-5 py-3.5">{footer}</footer>}
      </div>
    </dialog>,
    document.body
  );
}
