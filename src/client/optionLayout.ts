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
  return allShortLabels;
}

export function getVisualOptionTileHeightClass(optionCount: number): string {
  // 4-option 2x2 grid fits comfortably at 136px stage height (~520px total right pane);
  // 5-option grids use a slightly tighter 112px stage height so all 5 stay compact.
  return optionCount <= 4 ? 'h-[124px] sm:h-[136px]' : 'h-[104px] sm:h-[112px]';
}
