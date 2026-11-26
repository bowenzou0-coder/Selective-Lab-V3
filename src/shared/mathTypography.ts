/**
 * Math-typography lint shared by the server import validator. Mirrored in
 * docs/selective-lab-question-skill/scripts/validate_manifest.mjs — keep both in step.
 *
 * Prompt/option/explanation text is typeset by the client (`cm2` → cm², `x^2` → x with a
 * superscript), but SVG <text> is drawn verbatim, so plain powers there show up raw.
 */

/** `36 cm2`, `(km2)`: a metric unit followed by a bare 2/3 right after a number or "(". */
export const PLAIN_UNIT_POWER_RE = /(?<=(?:\d|\()\s?)(?:mm|cm|m|km)[23](?![0-9A-Za-z])/g;
/** `x^2`, `10^{3}` caret exponents. */
export const CARET_EXPONENT_RE = /[A-Za-z0-9)\]]\^(?:\{[^{}\n]{1,12}\}|[-−]?\d{1,3}|[a-z])/g;
export const NOT_TO_SCALE_RE = /diagram\s+(?:is\s+)?not\s+(?:drawn\s+)?to\s+scale/gi;

export function findPlainUnitPowers(text: unknown): string[] {
  return typeof text === 'string' ? text.match(PLAIN_UNIT_POWER_RE) ?? [] : [];
}

export function findCaretExponents(text: unknown): string[] {
  return typeof text === 'string' ? text.match(CARET_EXPONENT_RE) ?? [] : [];
}

export function countNotToScale(text: unknown): number {
  return typeof text === 'string' ? (text.match(NOT_TO_SCALE_RE) ?? []).length : 0;
}

/** Visible text inside an SVG's <text> elements (tags stripped, basic entities decoded). */
export function svgVisibleText(svg: unknown): string {
  if (typeof svg !== 'string') return '';
  return [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)]
    .map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'))
    .join('\n');
}

interface TypographyVisual {
  visualType?: string;
  svgMarkup?: string;
  caption?: string;
  altText?: string;
}

/**
 * Returns human-readable warnings for one question: unit powers typed as `cm2`, caret
 * exponents inside SVG labels, and "[diagram not to scale]" shown more than once.
 */
export function lintQuestionTypography(input: {
  label: string;
  promptTexts: string[];
  otherTexts: string[];
  visual?: TypographyVisual;
  optionVisuals?: TypographyVisual[];
}): string[] {
  const warnings: string[] = [];
  const { label, visual } = input;
  const plain = [...input.promptTexts, ...input.otherTexts, visual?.caption ?? ''].flatMap(findPlainUnitPowers);
  if (plain.length) {
    warnings.push(`${label}: write unit powers with Unicode superscripts (${[...new Set(plain)].join(', ')} → cm², m³ …).`);
  }
  const svgs = [visual, ...(input.optionVisuals ?? [])].filter((v) => v?.visualType === 'inline_svg');
  const svgText = svgs.map((v) => svgVisibleText(v?.svgMarkup)).join('\n');
  const svgPowers = [...findPlainUnitPowers(svgText), ...findCaretExponents(svgText)];
  if (svgPowers.length) {
    warnings.push(`${label}: SVG labels draw powers verbatim (${[...new Set(svgPowers)].join(', ')}); use ² / ³ or a <tspan baseline-shift="super">.`);
  }
  // image_asset shows `caption || altText` under the figure; inline_svg shows the caption.
  const shownCaption = visual?.caption || (visual?.visualType === 'image_asset' ? visual.altText : '');
  const notToScale =
    [...new Set(input.promptTexts)].reduce((n, t) => n + countNotToScale(t), 0) +
    countNotToScale(shownCaption) +
    countNotToScale(visual?.visualType === 'inline_svg' ? svgVisibleText(visual.svgMarkup) : '');
  if (notToScale > 1) {
    warnings.push(`${label}: "[diagram not to scale]" appears ${notToScale} times on screen; keep it once (visual caption preferred).`);
  }
  return warnings;
}
