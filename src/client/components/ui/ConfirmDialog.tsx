import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { focusableWithin, handleTrapTab, restoreFocusTo } from './focusTrap';

export interface ConfirmDialogProps {
  open: boolean;
  /** Cancel button, Escape and backdrop click. Ignored while `busy`. */
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  /** Small line above the title (e.g. "Ready to start?"). */
  eyebrow?: ReactNode;
  /** Muted line under the title; wired to aria-describedby. */
  description?: ReactNode;
  /** Leading badge beside the title (e.g. a warning icon for destructive actions). */
  icon?: ReactNode;
  children?: ReactNode;
  confirmLabel: ReactNode;
  cancelLabel: ReactNode;
  confirmIcon?: ReactNode;
  /** `danger` paints the confirm button red and focuses Cancel first. */
  tone?: 'primary' | 'danger';
  confirmDisabled?: boolean;
  /** Locks both buttons, Escape and the backdrop while an action is in flight. */
  busy?: boolean;
  widthClassName?: string;
}

const EXIT_MS = 160;
/**
 * Shared modal confirmation: portaled to <body>, `aria-modal`, Tab/Shift+Tab trapped inside,
 * Escape and backdrop close it, focus returns to the opener. Enters with a short scale/fade and
 * keeps the last content on screen while it fades out (both instant under reduced motion).
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  const { open } = props;
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descId = useId();

  // Freeze the last open props so the exit fade doesn't show an empty dialog.
  const snapshotRef = useRef(props);
  if (open) snapshotRef.current = props;
  const view = open ? props : snapshotRef.current;

  const latestRef = useRef(props);
  latestRef.current = props;

  useEffect(() => {
    if (open) {
      if (!restoreFocusRef.current && typeof document !== 'undefined') {
        restoreFocusRef.current = document.activeElement as HTMLElement | null;
      }
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) return;
    setClosing(true);
    const reduce =
      typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const timer = window.setTimeout(() => {
      setMounted(false);
      setClosing(false);
      const target = restoreFocusRef.current;
      restoreFocusRef.current = null;
      const current = document.activeElement;
      if (!current || current === document.body || panelRef.current?.contains(current)) restoreFocusTo(target);
    }, reduce ? 0 : EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [open, mounted]);

  // Initial focus: [data-autofocus] inside the body, else Cancel for danger, else Confirm.
  useEffect(() => {
    if (!mounted || !open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const frame = window.requestAnimationFrame(() => {
      if (panel.contains(document.activeElement)) return;
      const preferred =
        panel.querySelector<HTMLElement>('[data-autofocus]') ||
        (latestRef.current.tone === 'danger' ? cancelRef.current : null) ||
        (confirmRef.current && !confirmRef.current.disabled ? confirmRef.current : null) ||
        cancelRef.current ||
        focusableWithin(panel)[0];
      preferred?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [mounted, open]);

  useEffect(() => {
    if (!mounted || !open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        if (!latestRef.current.busy) latestRef.current.onClose();
        return;
      }
      handleTrapTab(e, panel);
    };
    // Capture so the dialog wins over page-level shortcuts and other Escape handlers.
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [mounted, open]);

  if (!mounted || typeof document === 'undefined') return null;

  const {
    title,
    eyebrow,
    description,
    icon,
    children,
    confirmLabel,
    cancelLabel,
    confirmIcon,
    tone = 'primary',
    confirmDisabled = false,
    busy = false,
    widthClassName = 'max-w-md',
  } = view;
  const isDanger = tone === 'danger';
  const motion = closing ? 'opacity-0 scale-[0.97]' : 'opacity-100 scale-100 starting:opacity-0 starting:scale-[0.97]';

  return createPortal(
    <div
      role="presentation"
      onMouseDown={(e) => {
        // Only a press that starts on the backdrop closes (not a text-selection drag out of the panel).
        if (e.target === e.currentTarget && !busy && open) latestRef.current.onClose();
      }}
      className={`fixed inset-0 z-50 m-0 flex items-center justify-center bg-[#113C36]/35 p-4 backdrop-blur-[2px] transition-opacity duration-150 ease-out motion-reduce:transition-none ${
        closing ? 'pointer-events-none opacity-0' : 'opacity-100 starting:opacity-0'
      }`}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={`w-full ${widthClassName} space-y-5 rounded-[18px] border border-[#E5DFD5] bg-white p-6 text-[#113C36] shadow-[0_18px_40px_rgba(17,60,54,0.16)] outline-none transition-[opacity,transform,translate,scale] duration-[180ms] ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none ${motion}`}
      >
        <div className={icon ? 'flex items-start gap-3' : undefined}>
          {icon && (
            <div
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                isDanger ? 'bg-[#FDECEB] text-[#B83A28]' : 'bg-[#E5F0EA] text-[#113C36]'
              }`}
              aria-hidden="true"
            >
              {icon}
            </div>
          )}
          <div className="min-w-0 space-y-1">
            {eyebrow && <p className="font-sans-display text-xs font-medium text-[#615E57]">{eyebrow}</p>}
            <h2
              id={titleId}
              className="font-sans-display text-xl font-semibold tracking-[-0.015em] text-[#113C36]"
            >
              {title}
            </h2>
            {description && (
              <p id={descId} className="text-xs leading-relaxed text-[#4A5955]">
                {description}
              </p>
            )}
          </div>
        </div>

        {children}

        <div className="flex items-center justify-end gap-2.5 pt-1">
          <button
            ref={cancelRef}
            type="button"
            disabled={busy}
            onClick={() => latestRef.current.onClose()}
            className="cursor-pointer rounded-[10px] border border-[#CFC6B9] bg-white px-4 py-2 font-sans-display text-xs font-semibold text-[#4A5955] transition-[background-color,transform,translate,scale] duration-150 ease-out hover:bg-[#FAF8F5] active:scale-[0.97] disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            disabled={busy || confirmDisabled}
            onClick={() => latestRef.current.onConfirm()}
            className={`inline-flex cursor-pointer items-center gap-1.5 rounded-[10px] px-5 py-2 font-sans-display text-xs font-semibold text-white transition-[background-color,transform,translate,scale] duration-150 ease-out active:scale-[0.97] ${
              isDanger
                ? 'bg-[#B83A28] hover:bg-[#962D1E] disabled:opacity-40'
                : 'bg-[#113C36] hover:bg-[#0B2B26] disabled:opacity-60'
            }`}
          >
            {confirmIcon}
            <span>{confirmLabel}</span>
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
