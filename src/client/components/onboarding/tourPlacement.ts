/**
 * Pure placement math for the onboarding tour card: where the card sits relative to the
 * spotlighted nav item and where its caret points. Kept DOM-free so it can be unit-tested at
 * 390px (mobile bottom nav), 768px (tablet) and desktop (left sidebar) widths.
 */

export interface TourRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface TourViewport {
  w: number;
  h: number;
}

export type TourCaretSide = 'left' | 'top' | 'bottom' | null;

export interface TourPlacement {
  /** Fixed-position style for the card (px numbers, or % strings for the centred modal). */
  style: {
    top?: number | string;
    bottom?: number;
    left: number | string;
    width: number;
    transform: string;
  };
  /** Cap for the card's scrollable body so it never runs off-screen. */
  maxBodyHeight: number;
  caretSide: TourCaretSide;
  /** Caret's left (top/bottom side) or top (left side) offset inside the card, in px. */
  caretOffset: number;
}

/** Breathing room between the card and the viewport edge. */
export const TOUR_EDGE = 16;
/** The caret is a 14px square rotated 45°; it overlaps the card edge by half its size. */
export const TOUR_CARET_SIZE = 14;
/** Keep the caret clear of the card's 20px corner radius. */
export const TOUR_CARET_INSET = 22;
/** Gap between the spotlight ring and the caret tip. */
export const TOUR_GAP = 14;
/** Spotlight padding around the target. */
export const TOUR_SPOTLIGHT_PAD = 6;

const SIDEBAR_BREAKPOINT = 768;
const SIDEBAR_MAX_LEFT = 280;
const MIN_BODY_HEIGHT = 160;
/** Rough card height used only to decide above/below and clamp the sidebar card. */
const ESTIMATED_CARD_HEIGHT = 280;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

/** Spotlight box around a measured target, padded and kept inside the viewport on every side. */
export function padTargetRect(raw: TourRect, viewport: TourViewport, pad = TOUR_SPOTLIGHT_PAD): TourRect {
  const left = Math.max(4, raw.left - pad);
  const top = Math.max(4, raw.top - pad);
  const right = Math.min(viewport.w - 4, raw.left + raw.width + pad);
  const bottom = Math.min(viewport.h - 4, raw.top + raw.height + pad);
  return { top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export function tourCardWidth(viewport: TourViewport, centered: boolean): number {
  return Math.max(0, Math.min(centered ? 460 : 410, viewport.w - TOUR_EDGE * 2));
}

/** Caret offset along the card edge so the caret's centre lines up with `targetCenter`. */
export function caretOffsetFor(targetCenter: number, cardStart: number, cardSize: number): number {
  const half = TOUR_CARET_SIZE / 2;
  return clamp(targetCenter - cardStart - half, TOUR_CARET_INSET, cardSize - TOUR_CARET_INSET - TOUR_CARET_SIZE);
}

/** Card start that centres the card on `targetCenter` without leaving the viewport. */
function alignedStart(targetCenter: number, cardSize: number, viewportSize: number): number {
  return clamp(targetCenter - cardSize / 2, TOUR_EDGE, viewportSize - cardSize - TOUR_EDGE);
}

export function computeTourPlacement(target: TourRect | null, viewport: TourViewport, centered: boolean): TourPlacement {
  if (centered || !target) {
    return {
      style: { top: '50%', left: '50%', width: tourCardWidth(viewport, true), transform: 'translate(-50%, -50%)' },
      maxBodyHeight: Math.max(MIN_BODY_HEIGHT, viewport.h - TOUR_EDGE * 2),
      caretSide: null,
      caretOffset: 0,
    };
  }

  const cardWidth = tourCardWidth(viewport, false);
  const centerX = target.left + target.width / 2;
  const centerY = target.top + target.height / 2;
  const isSidebar = viewport.w >= SIDEBAR_BREAKPOINT && target.left < SIDEBAR_MAX_LEFT;

  if (isSidebar) {
    // Desktop/tablet left sidebar: card to the right, caret on its left edge.
    const left = target.left + target.width + TOUR_GAP + TOUR_CARET_SIZE / 2;
    const width = Math.max(0, Math.min(cardWidth, viewport.w - left - TOUR_EDGE));
    const top = clamp(centerY - 40, TOUR_EDGE + 4, viewport.h - ESTIMATED_CARD_HEIGHT - TOUR_EDGE);
    return {
      style: { top, left, width, transform: 'none' },
      maxBodyHeight: Math.max(MIN_BODY_HEIGHT, viewport.h - top - TOUR_EDGE),
      caretSide: 'left',
      caretOffset: caretOffsetFor(centerY, top, ESTIMATED_CARD_HEIGHT),
    };
  }

  const left = alignedStart(centerX, cardWidth, viewport.w);
  const caretOffset = caretOffsetFor(centerX, left, cardWidth);
  const spaceAbove = target.top - TOUR_GAP - TOUR_CARET_SIZE / 2 - TOUR_EDGE;
  const spaceBelow = viewport.h - (target.top + target.height) - TOUR_GAP - TOUR_CARET_SIZE / 2 - TOUR_EDGE;
  const placeAbove = target.top > viewport.h * 0.58 || (spaceBelow < ESTIMATED_CARD_HEIGHT && spaceAbove > spaceBelow);

  if (placeAbove) {
    // Mobile bottom nav (or any low target): card above, caret on its bottom edge.
    return {
      style: { bottom: viewport.h - target.top + TOUR_GAP + TOUR_CARET_SIZE / 2, left, width: cardWidth, transform: 'none' },
      maxBodyHeight: Math.max(MIN_BODY_HEIGHT, spaceAbove),
      caretSide: 'bottom',
      caretOffset,
    };
  }

  const top = target.top + target.height + TOUR_GAP + TOUR_CARET_SIZE / 2;
  return {
    style: { top, left, width: cardWidth, transform: 'none' },
    maxBodyHeight: Math.max(MIN_BODY_HEIGHT, spaceBelow),
    caretSide: 'top',
    caretOffset,
  };
}
