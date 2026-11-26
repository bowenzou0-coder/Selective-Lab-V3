import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  caretOffsetFor,
  computeTourPlacement,
  padTargetRect,
  TOUR_CARET_INSET,
  TOUR_CARET_SIZE,
  TOUR_EDGE,
  type TourPlacement,
  type TourRect,
} from './components/onboarding/tourPlacement.ts';
import { trapTabTarget } from './components/ui/focusTrap.ts';
import { indicatorStyle, measureIndicator, sameIndicatorBox } from './components/ui/useSlidingIndicator.ts';
import { contrastRatio, meetsAA, parseHex } from './styles/contrast.ts';

// ---------------------------------------------------------------------------
// Onboarding tour placement
// ---------------------------------------------------------------------------

/** Mobile bottom nav: `px-2` strip, `flex-1` items with `gap-1`, ~52px tall at the bottom. */
function mobileNavRects(viewportW: number, viewportH: number, count: number): TourRect[] {
  const inner = viewportW - 16;
  const gap = 4;
  const itemW = (inner - gap * (count - 1)) / count;
  return Array.from({ length: count }, (_, i) => ({
    left: 8 + i * (itemW + gap),
    top: viewportH - 8 - 44,
    width: itemW,
    height: 44,
  }));
}

function caretCenterX(p: TourPlacement): number {
  return (p.style.left as number) + p.caretOffset + TOUR_CARET_SIZE / 2;
}

function assertCardInsideViewport(p: TourPlacement, w: number) {
  const left = p.style.left as number;
  assert.ok(left >= TOUR_EDGE - 0.001, `card left ${left} clips the left edge`);
  assert.ok(left + p.style.width <= w - TOUR_EDGE + 0.001, `card right ${left + p.style.width} overflows ${w}`);
}

for (const [w, h, count] of [
  [390, 844, 4],
  [390, 844, 5],
  [360, 640, 4],
  [740, 1024, 4],
] as const) {
  test(`tour caret points at every mobile bottom-nav tab (${w}x${h}, ${count} tabs)`, () => {
    for (const raw of mobileNavRects(w, h, count)) {
      const target = padTargetRect(raw, { w, h });
      const placement = computeTourPlacement(target, { w, h }, false);
      assert.equal(placement.caretSide, 'bottom');
      assertCardInsideViewport(placement, w);
      const targetCenter = target.left + target.width / 2;
      const caretInsetMin = TOUR_CARET_INSET;
      const caretInsetMax = placement.style.width - TOUR_CARET_INSET - TOUR_CARET_SIZE;
      assert.ok(placement.caretOffset >= caretInsetMin && placement.caretOffset <= caretInsetMax);
      // Every tab centre is reachable without hitting the corner clamp, so the caret lands dead on it.
      assert.ok(Math.abs(caretCenterX(placement) - targetCenter) < 0.5, `caret ${caretCenterX(placement)} vs tab ${targetCenter}`);
      // Card sits above the nav with its body capped to the space left.
      assert.ok((placement.style.bottom as number) > h - target.top);
      assert.ok(placement.maxBodyHeight <= target.top);
    }
  });
}

test('tour card beside the desktop sidebar stays on-screen with a left caret', () => {
  const viewport = { w: 1280, h: 800 };
  const target = padTargetRect({ left: 16, top: 120, width: 176, height: 38 }, viewport);
  const placement = computeTourPlacement(target, viewport, false);
  assert.equal(placement.caretSide, 'left');
  assert.ok((placement.style.left as number) > target.left + target.width);
  const caretCenterY = (placement.style.top as number) + placement.caretOffset + TOUR_CARET_SIZE / 2;
  assert.ok(Math.abs(caretCenterY - (target.top + target.height / 2)) < 0.5);
});

test('tour card below a mid-page target uses a top caret and never overflows', () => {
  const viewport = { w: 390, h: 844 };
  const target = padTargetRect({ left: 330, top: 60, width: 48, height: 32 }, viewport);
  const placement = computeTourPlacement(target, viewport, false);
  assert.equal(placement.caretSide, 'top');
  assertCardInsideViewport(placement, viewport.w);
  // Target hugs the right edge: caret clamps clear of the rounded corner instead of leaving the card.
  assert.equal(placement.caretOffset, placement.style.width - TOUR_CARET_INSET - TOUR_CARET_SIZE);
});

test('centred tour steps fit narrow screens', () => {
  const placement = computeTourPlacement(null, { w: 320, h: 568 }, true);
  assert.equal(placement.caretSide, null);
  assert.equal(placement.style.width, 320 - TOUR_EDGE * 2);
  assert.equal(placement.style.transform, 'translate(-50%, -50%)');
});

test('padTargetRect keeps the spotlight inside the viewport on both sides', () => {
  const rect = padTargetRect({ left: 0, top: 790, width: 120, height: 40 }, { w: 390, h: 820 });
  assert.equal(rect.left, 4);
  assert.equal(rect.top + rect.height, 816);
  const right = padTargetRect({ left: 300, top: 10, width: 90, height: 30 }, { w: 390, h: 820 });
  assert.equal(right.left + right.width, 386);
});

test('caretOffsetFor clamps to the safe band', () => {
  assert.equal(caretOffsetFor(0, 16, 358), TOUR_CARET_INSET);
  assert.equal(caretOffsetFor(1000, 16, 358), 358 - TOUR_CARET_INSET - TOUR_CARET_SIZE);
  assert.equal(caretOffsetFor(200, 16, 358), 200 - 16 - TOUR_CARET_SIZE / 2);
});

// ---------------------------------------------------------------------------
// Focus trap
// ---------------------------------------------------------------------------

test('trapTabTarget wraps at both ends and pulls stray focus back in', () => {
  assert.equal(trapTabTarget(3, 2, false), 0);
  assert.equal(trapTabTarget(3, 0, true), 2);
  assert.equal(trapTabTarget(3, 1, false), null);
  assert.equal(trapTabTarget(3, 1, true), null);
  assert.equal(trapTabTarget(3, -1, false), 0);
  assert.equal(trapTabTarget(3, -1, true), 2);
  assert.equal(trapTabTarget(1, 0, false), 0);
  assert.equal(trapTabTarget(1, 0, true), 0);
  assert.equal(trapTabTarget(0, -1, false), -1);
});

// ---------------------------------------------------------------------------
// Sliding indicator
// ---------------------------------------------------------------------------

test('sliding indicator measures offsets and only animates after the first paint', () => {
  const box = measureIndicator({ offsetLeft: 92, offsetTop: 4, offsetWidth: 88, offsetHeight: 28 });
  assert.deepEqual(box, { left: 92, top: 4, width: 88, height: 28 });
  assert.equal(measureIndicator({ offsetLeft: 0, offsetTop: 0, offsetWidth: 0, offsetHeight: 0 }), null);
  assert.equal(measureIndicator(null), null);

  const first = indicatorStyle(box, false);
  assert.equal(first.transform, 'translate3d(92px, 4px, 0)');
  assert.equal(first.transition, 'none');
  const later = indicatorStyle(box, true);
  assert.equal(later.transition, undefined);
  assert.equal(indicatorStyle(null, true).opacity, 0);

  assert.ok(sameIndicatorBox(box, { left: 92, top: 4, width: 88, height: 28 }));
  assert.ok(!sameIndicatorBox(box, { left: 92, top: 4, width: 96, height: 28 }));
});

// ---------------------------------------------------------------------------
// WCAG AA contrast for the design tokens
// ---------------------------------------------------------------------------

const tokensCss = readFileSync(new URL('./styles/tokens.css', import.meta.url), 'utf8');
function token(name: string): string {
  const match = tokensCss.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`));
  assert.ok(match, `token --${name} missing`);
  return match[1];
}

test('contrast math matches WCAG reference values', () => {
  assert.deepEqual(parseHex('#fff'), [255, 255, 255]);
  assert.equal(Number(contrastRatio('#000000', '#FFFFFF').toFixed(2)), 21);
  assert.equal(Number(contrastRatio('#777777', '#FFFFFF').toFixed(2)), 4.48);
});

test('text tokens clear WCAG AA (4.5:1) on every light surface', () => {
  const surfaces = ['bg-shell', 'bg-canvas', 'bg-surface', 'bg-elevated', 'bg-hover', 'accent-soft', 'studio-stone', 'border-hairline'];
  for (const fg of ['text-primary', 'text-secondary', 'text-muted']) {
    for (const bg of surfaces) {
      const ratio = contrastRatio(token(fg), token(bg));
      assert.ok(ratio >= 4.5, `--${fg} on --${bg} is ${ratio.toFixed(2)}:1`);
    }
  }
});

test('status text clears AA on its own tint and on the canvas', () => {
  for (const name of ['success', 'warn', 'error']) {
    for (const bg of [`status-${name}-bg`, 'bg-canvas', 'bg-elevated', 'bg-shell']) {
      assert.ok(meetsAA(token(`status-${name}`), token(bg)), `--status-${name} on --${bg}`);
    }
  }
});

test('focus ring clears the 3:1 UI-component bar on light surfaces', () => {
  for (const bg of ['bg-shell', 'bg-canvas', 'bg-elevated']) {
    assert.ok(meetsAA(token('focus-ring'), token(bg), 'ui'));
  }
  assert.ok(meetsAA(token('focus-ring-on-dark'), token('accent-primary'), 'ui'));
});

test('the retired #78756E muted grey is gone from the client', () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(tsx?|css)$/.test(entry) && !entry.endsWith('.test.ts') && /#78756E/i.test(readFileSync(full, 'utf8'))) {
        offenders.push(full);
      }
    }
  };
  walk(new URL('.', import.meta.url).pathname);
  assert.deepEqual(offenders, []);
});

// ---------------------------------------------------------------------------
// Popover viewport clamp
// ---------------------------------------------------------------------------

test('clampShiftX keeps anchored panels inside a 390px viewport', async () => {
  const { clampShiftX } = await import('./components/ui/viewportClamp.ts');
  // Left-aligned 358px panel opened from a trigger at x=200 slides back in.
  assert.equal(clampShiftX(200, 558, 390), 374 - 558);
  // Right-aligned panel spilling past the left edge moves right.
  assert.equal(clampShiftX(-20, 280, 390), 36);
  // Panel that already fits stays put.
  assert.equal(clampShiftX(40, 300, 390), 0);
  // Wider than the usable space: pinned to the left margin.
  assert.equal(clampShiftX(100, 500, 390), -84);
});
