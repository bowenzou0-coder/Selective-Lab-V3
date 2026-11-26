import type { VisualSpec } from '../shared/contracts';

export interface OptionLike {
  key?: string;
  text?: string;
  visual?: VisualSpec;
}

/**
 * Determines whether a question's answer options should render in a compact
 * 2-column visual tile grid so all 4 options are visible simultaneously without
 * each answer stretching across the full pane width.
 */
export function shouldUseVisualOptionGrid(options: readonly OptionLike[]): boolean {
  if (options.length < 2) return false;
  const hasVisual = options.some(
    (opt) => Boolean(opt.visual && opt.visual.visualType !== 'none')
  );
  if (!hasVisual) return false;
  // Keep long multi-sentence options stacked vertically so text remains readable
  const allShortLabels = options.every(
    (opt) => !opt.text || opt.text.trim().length <= 48
  );
  // Wide strip figures (e.g. a row of shapes from a past paper) shrink to a sliver in a 2×2 tile
  const hasWideStrip = options.some((opt) => (svgAspectRatio(opt.visual) ?? 0) > WIDE_OPTION_ASPECT);
  return allShortLabels && !hasWideStrip;
}

/** Width ÷ height of an inline SVG's viewBox, or null when unknown. */
export function svgAspectRatio(visual?: VisualSpec): number | null {
  if (!visual || visual.visualType !== 'inline_svg' || !visual.svgMarkup) return null;
  const m = visual.svgMarkup.match(/viewBox\s*=\s*["']\s*-?[\d.]+[\s,]+-?[\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? w / h : null;
}

/** Option figures wider than this (w:h) render stacked at full width instead of in the tile grid. */
export const WIDE_OPTION_ASPECT = 2.6;

export function getVisualOptionTileHeightClass(optionCount: number): string {
  // 4-option 2x2 grid fits comfortably at 136px stage height (~520px total right pane);
  // 5-option grids use a slightly tighter 112px stage height so all 5 stay compact.
  return optionCount <= 4 ? 'h-[124px] sm:h-[136px]' : 'h-[104px] sm:h-[112px]';
}
