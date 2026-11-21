# Sunlit Editorial Studio — Visual Palette, Typography & Sizing Spec

Reference for creating inline SVGs, structured tables, raster assets, and standalone previews that match **Selective Lab's** Sunlit Editorial Studio UI (`src/client/styles/tokens.css`, `src/client/optionLayout.ts`, `src/client/components/VisualRenderer.tsx`).

---

## 1. Color Palette

### Surfaces & Borders
| Role | Hex | Usage |
|---|---|---|
| Card white | `#FFFFFF` | Diagram card canvas, elevated answer tiles |
| Warm paper | `#FAF8F5` | Exam sheet background, subtle SVG backdrop |
| Studio stone / warm fill | `#F3EFE8` | Shaded shapes, table headers, bar backgrounds |
| Soft stone | `#ECE8E1` | Secondary panels, muted fills |
| Hairline border | `#E5DFD5` | Light gridlines, cell dividers, card borders |
| Strong border | `#CFC6B9` | Axes, strong grid outlines, framing strokes |

### Ink & Text Hierarchy
| Role | Hex | Usage |
|---|---|---|
| Primary forest pine ink | `#113C36` | Primary diagram strokes, headings, key values |
| Neutral ink (alt) | `#1F1E1D` | High-contrast geometry/label ink |
| Secondary ink | `#4A5955` | Axis labels, secondary annotations |
| Muted label | `#78756E` | Captions, `[diagram not to scale]` notes, tick marks |

### Semantic & Data Accents
| Role | Hex | Soft Tint | Usage |
|---|---|---|---|
| Terracotta / Coral | `#F29A63` | `#FDE8D7` | Primary highlight, shaded area, focus bar |
| Emerald | `#1F7A4C` | `#E5F3EC` | Secondary highlight, positive series, correct state |
| Slate blue | `#3B5B6D` | `#E6EEF2` | Tertiary series, water/cool geometric fill |
| Warm amber | `#A35116` | `#FDF0E2` | Callouts, caution markers |
| Crimson | `#B83A28` | `#FDECEB` | Cut lines, forbidden paths, error callouts |

---

## 2. Bundled Typography (`fonts/`)

This skill folder bundles all 14 Anthropic OTF fonts used by Selective Lab so previews render identically offline or inside an Obsidian vault:

- **Reading prose & display headings:** `AnthropicSerif-Text-Regular-Static.otf`, `AnthropicSerif-Text-Medium-Static.otf`, `AnthropicSerif-Text-RegularItalic-Static.otf`, `AnthropicSerif-Display-*.otf`
- **UI, Maths, Thinking Skills & SVG labels:** `AnthropicSans-Text-Regular-Static.otf`, `AnthropicSans-Text-Medium-Static.otf`, `AnthropicSans-Text-Semibold-Static.otf`, `AnthropicSans-Display-*.otf`
- **Timers, IDs & JSON:** `Anthropic Mono Web.otf`

### SVG Font Stack
Inside `svgMarkup`, always include web-safe fallbacks so SVGs remain crisp even outside the app:
```xml
font-family="'AnthropicSansText', 'Anthropic Sans', system-ui, -apple-system, sans-serif"
```
Use `font-variant-numeric="tabular-nums"` on numeric labels, axis ticks, and tables, and leave **12–15% breathing margin** around text so fallback metrics never clip.

---

## 3. Critical Sizing Rules (App Layout Parity)

### A. Answer Option Visuals (`options[].visual`) — 2×2 Grid Trigger
Selective Lab (`optionLayout.ts` + `VisualRenderer.tsx`) activates a compact **2-column visual tile grid** (`2×2` for 4-option Thinking Skills, compact 2-column for 5-option Maths) **ONLY WHEN every option's `text` is `<= 48` characters** (empty string `""` or short label like `"Tile A"` / `"12 cm²"`). If even one option exceeds 48 characters, all options fall back to full-width stacked rows.

- **Rendered stage height:** `124px–136px` (4 options) or `104px–112px` (5 options). Click-to-zoom is automatic.
- **Inline SVG `viewBox`:** Use compact landscape or square ratios:
  - `viewBox="0 0 220 140"` (~1.57:1)
  - `viewBox="0 0 180 140"` (~1.28:1)
  - `viewBox="0 0 160 160"` (1:1)
- **Do NOT hardcode huge `width`/`height` pixel attributes** — omit `width`/`height` or match the `viewBox`, and let `viewBox` drive scaling.
- **Readability floor:** `padding` 6–10 viewBox units, `stroke-width >= 1.5`, label `font-size` 12–15.
- **Raster `image_asset` (if used):** `360×240` to `480×320` px (3:2) or `320×320` px (1:1), max aspect ratio 2:1, tightly cropped.

### B. Question & Stimulus Diagrams (`question.visual`, `stimulus.visual`)
- Rendered in a `#FFFFFF` card (`border: 1px solid #E5DFD5`, `border-radius: 12px`, `padding: 16px`) with a full-screen zoom modal (`max-h-[70vh]`).
- **Inline SVG `viewBox`:**
  - Landscape charts / grids / geometry: `viewBox="0 0 560 320"` to `640 360`
  - Compact figures / scales / 3D blocks: `viewBox="0 0 480 320"` or `480 340`
  - Keep vertical `viewBox` height `<= 420` so stem + diagram + options fit comfortably on a laptop screen.
- **Raster `image_asset` (if used):** `800×480` to `1200×720` px (landscape) or `720×720` px (square). Never embed huge base64 PNGs inside JSON manifests (Firestore 1 MiB document ceiling).

---

## 4. SVG Hygiene Checklist
1. Valid XML with `xmlns="http://www.w3.org/2000/svg"` and explicit `viewBox="0 0 W H"`.
2. Zero `<script>`, `on*=` event handlers, `javascript:`, `<foreignObject>`, external `<image href="http...">`, `@import`, or animations.
3. Compute all coordinates, angles, bar heights, and geometric intersections programmatically — never eyeball raw coordinates.
4. Cross-check every number/tick/shade in the SVG against the question stem, answer options, and `workedExplanation`.
5. Include `[diagram not to scale]` cleanly when a diagram is schematic rather than proportionally drawn.
6. **Zero answer leakage:** Never reveal the correct answer in `altText`, `caption`, SVG `<title>`, element IDs, or hidden labels.
