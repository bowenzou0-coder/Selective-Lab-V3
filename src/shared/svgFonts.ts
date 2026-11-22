/**
 * Normalizes inline SVG font-family declarations so every diagram renders with
 * Selective Lab's bundled Anthropic fonts (AnthropicSansText by default)
 * without forcing authors to repeat font-family attributes on every <text>.
 */

export const ANTHROPIC_SVG_FONTS = new Set([
  'AnthropicSansText',
  'AnthropicSansDisplay',
  'AnthropicSerifText',
  'AnthropicSerifDisplay',
  'AnthropicMono',
]);

export const DEFAULT_SVG_FONT = 'AnthropicSansText';

function decodeBasicQuotes(raw: string): string {
  return raw
    .replace(/&apos;|&#39;|&#x27;/gi, "'")
    .replace(/&quot;|&#34;|&#x22;/gi, '"');
}

export function resolveAnthropicFontFamily(rawList: string): string {
  const decoded = decodeBasicQuotes(rawList);
  const tokens = decoded
    .split(',')
    .map((part) => part.trim().replace(/^['"]+|['"]+$/g, '').trim())
    .filter(Boolean);

  for (const token of tokens) {
    if (ANTHROPIC_SVG_FONTS.has(token)) return token;
  }

  for (const token of tokens) {
    const low = token.toLowerCase().replace(/[\s_-]+/g, ' ').trim();
    if (low === 'anthropic sans display') return 'AnthropicSansDisplay';
    if (low === 'anthropic sans text' || low === 'anthropic sans') return 'AnthropicSansText';
    if (low === 'anthropic serif display') return 'AnthropicSerifDisplay';
    if (low === 'anthropic serif text' || low === 'anthropic serif') return 'AnthropicSerifText';
    if (low === 'anthropic mono') return 'AnthropicMono';
  }

  for (const token of tokens) {
    const low = token.toLowerCase();
    if (/\b(mono|monospace|courier|consolas|menlo|monaco)\b/.test(low)) return 'AnthropicMono';
    if (!low.includes('sans') && /\b(serif|georgia|times|cambria|garamond|palatino)\b/.test(low)) {
      return 'AnthropicSerifText';
    }
  }

  return DEFAULT_SVG_FONT;
}

/**
 * Ensures inline SVGs containing text default to AnthropicSansText on <svg>,
 * normalizes any explicit font-family attributes/styles to canonical Anthropic
 * font names, and strips redundant default font-family attrs on child nodes
 * when safe (reducing JSON bloat).
 */
export function normalizeSvgFonts(markup: string): string {
  if (!markup || typeof markup !== 'string' || !/<svg\b/i.test(markup)) return markup;

  // 1) Normalize font-family attributes and inline CSS font-family declarations.
  let out = markup
    .replace(/\bfont-family\s*=\s*(?:"([^"]*)"|'([^']*)')/gi, (_m, d, s) => {
      const resolved = resolveAnthropicFontFamily(d ?? s ?? '');
      return `font-family="${resolved}"`;
    })
    .replace(/\bfont-family\s*:\s*([^;"'}]+)/gi, (_m, val) => {
      const resolved = resolveAnthropicFontFamily(val ?? '');
      return `font-family: ${resolved}`;
    });

  // 2) Ensure root <svg ...> sets font-family="AnthropicSansText" if text exists and root has none.
  const hasText = /<(?:text|tspan)\b/i.test(out);
  let rootFont: string | null = null;
  out = out.replace(/<svg\b([^>]*)>/i, (full, attrs: string) => {
    const existing = attrs.match(/\bfont-family="([^"]*)"/i);
    if (existing) {
      rootFont = existing[1];
      return full;
    }
    if (hasText) {
      rootFont = DEFAULT_SVG_FONT;
      return `<svg${attrs} font-family="${DEFAULT_SVG_FONT}">`;
    }
    return full;
  });

  // 3) Strip redundant font-family="<rootFont>" on <text>/<tspan> when no nested <g>/<style> overrides fonts.
  if (rootFont && !/<g\b[^>]*\bfont-family=/i.test(out) && !/<style\b/i.test(out)) {
    const redundant = new RegExp(`(<(?:text|tspan)\\b[^>]*?)\\s+font-family="${rootFont}"`, 'gi');
    out = out.replace(redundant, '$1');
  }

  return out;
}
