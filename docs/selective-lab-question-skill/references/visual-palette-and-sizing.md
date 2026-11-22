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

## 2. Typography (Anthropic Fonts Exclusively)

Selective Lab renders with its Anthropic Serif, Sans and Mono WOFF2 faces (`public/fonts/` in the repo, and `fonts/` inside the exported skill `.zip`). Inside the repo, `scripts/preview_manifest.mjs` picks them up automatically (checking `../fonts` first, then `../../../public/fonts`).

Only these exact `@font-face` family names are registered in Selective Lab:
- **Reading prose & display headings:** `AnthropicSerifText`, `AnthropicSerifDisplay`
- **UI, Maths, Thinking Skills & SVG diagram labels:** `AnthropicSansText`, `AnthropicSansDisplay`
- **Timers, IDs, codes & JSON:** `AnthropicMono`

### SVG Font Stack (Strict — No Fallback Fonts)
Every `svgMarkup` that contains `<text>` or `<tspan>` MUST declare **exclusively** Anthropic font family names — never include `system-ui`, `-apple-system`, `sans-serif`, `serif`, `monospace`, `Arial`, `Helvetica`, or `'Anthropic Sans'` (with a space):
```xml
font-family="'AnthropicSansText'"
```
(Use `'AnthropicMono'` for monospaced codes/IDs or `'AnthropicSerifText'` / `'AnthropicSansDisplay'` / `'AnthropicSerifDisplay'` when appropriate.)
Use `font-variant-numeric="tabular-nums"` on numeric labels, axis ticks, and tables, and leave **12–15% breathing margin** around text so labels never clip.

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
- **Raster `image_asset` (if used):**
  - **Writing image prompts (~50% of Writing tasks when image generation is available; ignore if unsupported by the model):** Landscape 16:9 or 3:2 (`960×540` to `1024×576` px) WebP compressed to `< 95 KB` (`data:image/webp;base64,...`, strictly under 100 KB so manifests validate cleanly). Zero embedded text, signs, letters, or numbers in the artwork; always include both descriptive `altText` and a 1-sentence `caption`.
  - **Maths / Thinking raster (avoid if inline_svg works):** `800×480` to `1200×720` px (landscape) or `720×720` px (square). Never embed huge >100 KB base64 PNGs inside JSON manifests.

---

## 4. SVG Hygiene Checklist
1. Valid XML with `xmlns="http://www.w3.org/2000/svg"` and explicit `viewBox="0 0 W H"`.
2. Zero `<script>`, `on*=` event handlers, `javascript:`, `<foreignObject>`, external `<image href="http...">`, `@import`, or animations.
3. Compute all coordinates, angles, bar heights, and geometric intersections programmatically — never eyeball raw coordinates.
4. Cross-check every number/tick/shade in the SVG against the question stem, answer options, and `workedExplanation`.
5. Include `[diagram not to scale]` cleanly when a diagram is schematic rather than proportionally drawn.
6. **Zero answer leakage:** Never reveal the correct answer in `altText`, `caption`, SVG `<title>`, element IDs, or hidden labels.
