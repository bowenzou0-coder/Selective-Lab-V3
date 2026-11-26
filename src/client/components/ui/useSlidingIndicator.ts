import { useEffect, useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';

export interface IndicatorBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface OffsetBox {
  offsetLeft: number;
  offsetTop: number;
  offsetWidth: number;
  offsetHeight: number;
}

/** Pill box for the active item, in its (position: relative) container's padding-box coordinates. */
export function measureIndicator(el: OffsetBox | null | undefined): IndicatorBox | null {
  if (!el || el.offsetWidth <= 0 || el.offsetHeight <= 0) return null;
  return { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight };
}

export function sameIndicatorBox(a: IndicatorBox | null, b: IndicatorBox | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

/**
 * Inline style for the pill. Position is a GPU-composited translate; transitions stay off until
 * the first measurement has painted so the pill never slides in from the corner on mount.
 */
export function indicatorStyle(box: IndicatorBox | null, animate: boolean): CSSProperties {
  if (!box) return { opacity: 0, width: 0, height: 0 };
  return {
    width: box.width,
    height: box.height,
    transform: `translate3d(${box.left}px, ${box.top}px, 0)`,
    ...(animate ? {} : { transition: 'none' }),
  };
}

export const ACTIVE_INDICATOR_SELECTOR = '[data-indicator-active="true"]';

/**
 * Measures the container's `[data-indicator-active="true"]` child on every change of `activeKey`
 * and whenever the container or any item resizes (EN/ZH label swaps, font swap, wrapping).
 * `visible` is false while nothing measurable is active (e.g. the control is display:none), so
 * callers can fall back to painting the active item directly.
 */
export function useSlidingIndicator(containerRef: RefObject<HTMLElement | null>, activeKey: string) {
  const [box, setBox] = useState<IndicatorBox | null>(null);
  const [animate, setAnimate] = useState(false);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const update = () => {
      const next = measureIndicator(container.querySelector<HTMLElement>(ACTIVE_INDICATOR_SELECTOR));
      setBox((prev) => (sameIndicatorBox(prev, next) ? prev : next));
    };
    update();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(container);
    for (const child of Array.from(container.children)) observer.observe(child);
    let cancelled = false;
    document.fonts?.ready.then(() => {
      if (!cancelled) update();
    });
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [containerRef, activeKey]);

  useEffect(() => {
    // Hidden again (e.g. display:none): re-arm the no-transition first paint for when it returns.
    if (!box) {
      if (animate) setAnimate(false);
      return;
    }
    if (animate) return;
    const frame = window.requestAnimationFrame(() => setAnimate(true));
    return () => window.cancelAnimationFrame(frame);
  }, [box, animate]);

  return { style: indicatorStyle(box, animate), visible: box !== null };
}
