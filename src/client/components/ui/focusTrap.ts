import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

export const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** Tabbable descendants that are actually rendered (skips display:none and closed/inert regions). */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.closest('[inert]') && (el.getClientRects().length > 0 || el === document.activeElement)
  );
}

/**
 * Where Tab/Shift+Tab should land inside a trap of `count` tabbables when focus sits at
 * `currentIndex` (-1 = outside the trap). Returns `-1` to focus the container itself (nothing
 * tabbable), or `null` when the browser's default move already stays inside.
 */
export function trapTabTarget(count: number, currentIndex: number, shift: boolean): number | null {
  if (count <= 0) return -1;
  if (currentIndex < 0 || currentIndex >= count) return shift ? count - 1 : 0;
  if (shift && currentIndex === 0) return count - 1;
  if (!shift && currentIndex === count - 1) return 0;
  return null;
}

/** Applies `trapTabTarget` to a keydown event. Returns true when it moved focus. */
export function handleTrapTab(e: KeyboardEvent, container: HTMLElement): boolean {
  if (e.key !== 'Tab') return false;
  const items = focusableWithin(container);
  const active = document.activeElement as HTMLElement | null;
  const target = trapTabTarget(items.length, active ? items.indexOf(active) : -1, e.shiftKey);
  if (target === null) {
    // Focus may sit on the container itself or an untabbable child; keep it inside regardless.
    if (active && container.contains(active)) return false;
    e.preventDefault();
    (items[0] ?? container).focus();
    return true;
  }
  e.preventDefault();
  (target === -1 ? container : items[target]).focus();
  return true;
}

/** Focus `target` if still in the document; otherwise the current page's nav link, if any. */
export function restoreFocusTo(target: HTMLElement | null) {
  if (typeof document === 'undefined') return;
  if (target && target.isConnected && target !== document.body) {
    target.focus({ preventScroll: true });
    return;
  }
  const fallback = Array.from(document.querySelectorAll<HTMLElement>('nav [aria-current="page"]')).find(
    (el) => el.getClientRects().length > 0
  );
  fallback?.focus({ preventScroll: true });
}

interface FocusTrapOptions {
  /** Escape handler (capture phase, so it wins over page shortcuts). */
  onEscape?: () => void;
  /** First element to focus when the trap activates; defaults to the first tabbable, then the container. */
  initialFocus?: () => HTMLElement | null | undefined;
  /** Return focus to the opener when the trap deactivates or unmounts. Default true. */
  restoreFocus?: boolean;
}

/**
 * Modal focus management for hand-rolled dialogs: remembers the opener, moves focus inside,
 * keeps Tab/Shift+Tab contained, handles Escape and restores focus on close.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean, options: FocusTrapOptions = {}) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useLayoutEffect(() => {
    if (!active || typeof document === 'undefined') return;
    const opener = document.activeElement as HTMLElement | null;
    const containerAtOpen = ref.current;
    const frame = window.requestAnimationFrame(() => {
      const container = ref.current;
      if (!container || container.contains(document.activeElement)) return;
      const preferred = optionsRef.current.initialFocus?.() ?? focusableWithin(container)[0] ?? container;
      preferred.focus({ preventScroll: true });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (optionsRef.current.restoreFocus === false) return;
      // Only pull focus back if it is still inside the closing dialog or was dropped to <body>.
      const current = document.activeElement;
      const container = containerAtOpen ?? ref.current;
      if (!current || current === document.body || (container && container.contains(current))) {
        restoreFocusTo(opener);
      }
    };
  }, [active, ref]);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const container = ref.current;
      if (!container) return;
      if (e.key === 'Escape' && optionsRef.current.onEscape) {
        e.preventDefault();
        e.stopPropagation();
        optionsRef.current.onEscape();
        return;
      }
      handleTrapTab(e, container);
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [active, ref]);
}
