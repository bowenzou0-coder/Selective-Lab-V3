/**
 * Horizontal nudge (px) that keeps an anchored panel spanning [left, right] inside a viewport of
 * `viewportWidth`, leaving `margin` on both sides. Panels wider than the space are pinned to the
 * left margin.
 */
export function clampShiftX(left: number, right: number, viewportWidth: number, margin = 16): number {
  const minLeft = margin;
  const maxRight = viewportWidth - margin;
  if (right - left >= maxRight - minLeft) return minLeft - left;
  if (left < minLeft) return minLeft - left;
  if (right > maxRight) return maxRight - right;
  return 0;
}
