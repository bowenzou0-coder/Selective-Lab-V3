# Sunlit Editorial Studio — Visual Palette, Fonts & Sizing

Concise visual reference matching Selective Lab (`tokens.css`, `optionLayout.ts`, `VisualRenderer.tsx`).

## 1. Color Palette
- **Surfaces & borders:** Card white `#FFFFFF`, warm paper `#FAF8F5`, studio stone `#F3EFE8`, soft stone `#ECE8E1`, hairline `#E5DFD5`, strong border `#CFC6B9`.
- **Ink:** Primary forest pine `#113C36` (or neutral `#1F1E1D`), secondary `#4A5955`, muted `#78756E`.
- **Accents (fill / soft tint):** Terracotta `#F29A63` / `#FDE8D7`, Emerald `#1F7A4C` / `#E5F3EC`, Slate blue `#3B5B6D` / `#E6EEF2`, Amber `#A35116` / `#FDF0E2`, Crimson `#B83A28` / `#FDECEB`.

## 2. Anthropic Fonts (Bundled & Automatic)
All Anthropic WOFF2 faces (`AnthropicSansText`, `AnthropicSansDisplay`, `AnthropicSerifText`, `AnthropicSerifDisplay`, `AnthropicMono`) are bundled in `public/fonts/` and in the skill zip (`fonts/`). Both Selective Lab and `preview_manifest.mjs` apply **`AnthropicSansText`** automatically to inline SVGs, and `merge_manifests.mjs` + the app normalize SVG font declarations automatically.

- **Save tokens:** Omit `font-family` on `<text>`/`<tspan>` (or set `font-family="AnthropicSansText"` once on `<svg>`).
- Use `font-family="AnthropicMono"` (codes/IDs) or `"AnthropicSerifText"` only where a different Anthropic face is intentionally needed.
- Never hardcode `Arial`, `Times`, or misspelled `Anthropic Sans`. Use `font-variant-numeric="tabular-nums"` on numeric axes/tables and leave 12–15% label breathing room.

## 3. Sizing & Layout Parity
- **Option tiles (`options[].visual` — 2×2 grid trigger):** Keep every `option.text <= 48` chars (ideally `""` or 1–3 words). Use compact `viewBox="0 0 220 140"`, `180 140`, or `160 160` (max aspect 2.2:1); omit huge pixel `width`/`height`; `padding` 6–10 units, `stroke-width >= 1.5`, `font-size` 12–15.
- **Question / stimulus diagrams (`question.visual`, `stimulus.visual`):** `viewBox="0 0 560 320"` to `640 360` (or `480 320` for compact figures), height `<= 420`.
- **Writing image prompts (~50% when image generation is supported; skip cleanly if unsupported):** Landscape 16:9 or 3:2 WebP `< 95 KB` (`data:image/webp;base64,...`), zero embedded text/numbers/signs, descriptive `altText` + 1-sentence `caption`.

## 4. SVG Hygiene Checklist
1. Valid XML with `xmlns="http://www.w3.org/2000/svg"` and explicit `viewBox="0 0 W H"`.
2. Zero `<script>`, `on*=` handlers, `javascript:`, `<foreignObject>`, external URLs, `@import`, or animations.
3. Compute geometry/bar heights/intersections programmatically — never eyeball coordinates.
4. Cross-check every number/tick/shade against the stem, options, and `workedExplanation`.
5. Include `[diagram not to scale]` on schematic figures; zero answer leakage in `altText`, `caption`, `<title>`, or IDs.
