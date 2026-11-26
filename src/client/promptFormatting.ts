export type InlineSpan = {
  type: 'text' | 'bold' | 'italic' | 'sup';
  text: string;
};

export type FormattedBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'bullet_list'; items: string[] }
  | { kind: 'ordered_list'; items: { marker: string; text: string }[] };

const BOXED_HEADING_RE = /^Boxed rules(?:\s*[—–-]\s*[^:]+)?:\s*$/i;
const BULLET_LINE_RE = /^\s*(?:•\s*|[-*]\s+)(.+)$/;
const NUMBERED_DOT_PAREN_RE = /^\s*(\d+[.)])\s+(.+)$/;
const LEGACY_DOE_NUMBERED_RE = /^\s*(\d{1,2})  +([A-Za-z"'‘“(].+)$/;
const LABELLED_STEP_RE = /^\s*((?:Statement|Rule|Clue|Condition|Step)\s+\d+:)\s+(.+)$/;
const LETTER_STATEMENT_RE = /^\s*([XYZ][.:])\s+(.+)$/;
const SPEAKER_PREFIX_RE = /^([A-Z][A-Za-z'’ -]{1,24}:)\s+(["“‘'].+)$/;

function matchOrderedLine(
  lines: string[],
  idx: number
): { marker: string; text: string } | null {
  const line = lines[idx];
  let m = line.match(NUMBERED_DOT_PAREN_RE);
  if (m) return { marker: m[1], text: m[2].trim() };

  m = line.match(LEGACY_DOE_NUMBERED_RE);
  if (m) return { marker: `${m[1]}.`, text: m[2].trim() };

  m = line.match(LABELLED_STEP_RE);
  if (m) return { marker: m[1], text: m[2].trim() };

  m = line.match(LETTER_STATEMENT_RE);
  if (m) {
    const prevMatches = idx > 0 && LETTER_STATEMENT_RE.test(lines[idx - 1]);
    const nextMatches = idx + 1 < lines.length && LETTER_STATEMENT_RE.test(lines[idx + 1]);
    if (prevMatches || nextMatches) {
      return { marker: m[1], text: m[2].trim() };
    }
  }

  return null;
}

export function parseFormattedBlocks(
  rawText: string,
  options?: { isBoxedRules?: boolean }
): FormattedBlock[] {
  const normalized = String(rawText ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const chunks = normalized.split(/\n\s*\n/);
  const blocks: FormattedBlock[] = [];

  for (const chunk of chunks) {
    const lines = chunk
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/g, ''))
      .filter((line) => line.trim().length > 0);
    if (lines.length === 0) continue;

    let i = 0;
    if (options?.isBoxedRules && blocks.length === 0 && BOXED_HEADING_RE.test(lines[0].trim())) {
      blocks.push({ kind: 'heading', text: lines[0].trim() });
      i = 1;
    }

    while (i < lines.length) {
      const bulletMatch = lines[i].match(BULLET_LINE_RE);
      if (bulletMatch) {
        const items: string[] = [];
        while (i < lines.length) {
          const bm = lines[i].match(BULLET_LINE_RE);
          if (!bm) break;
          items.push(bm[1].trim());
          i++;
        }
        blocks.push({ kind: 'bullet_list', items });
        continue;
      }

      const orderedMatch = matchOrderedLine(lines, i);
      if (orderedMatch) {
        const items: { marker: string; text: string }[] = [];
        while (i < lines.length) {
          const om = matchOrderedLine(lines, i);
          if (!om) break;
          items.push(om);
          i++;
        }
        blocks.push({ kind: 'ordered_list', items });
        continue;
      }

      const paraLines: string[] = [];
      while (i < lines.length) {
        if (BULLET_LINE_RE.test(lines[i]) || matchOrderedLine(lines, i)) {
          break;
        }
        paraLines.push(lines[i].trimStart());
        i++;
      }
      if (paraLines.length > 0) {
        blocks.push({ kind: 'paragraph', lines: paraLines });
      }
    }
  }

  return blocks;
}

export function splitSpeakerPrefix(line: string): { speaker: string; rest: string } | null {
  const m = line.match(SPEAKER_PREFIX_RE);
  if (!m) return null;
  return { speaker: m[1], rest: m[2] };
}

const INLINE_TOKEN_RE =
  /\*\*(\S(?:[^\n]*?\S)?)\*\*|(?:^|(?<=[\s([{"'“‘—–-]))\*(\S[^\n*]*?\S|\S)\*(?=$|[\s.,;:!?)\]}"'”’—–-])/g;

// `36 cm2` / `Area (m2)` → `36 cm²` / `Area (m²)`: unit powers only right after a number or "(".
const UNIT_POWER_RE = /(?<=(?:\d|\()\s?)(mm|cm|m|km)([23])(?![0-9A-Za-z])/g;
// `x^2`, `2^10`, `10^-3`, `a^{n+1}` → superscript (base must touch the caret).
const CARET_EXPONENT_RE = /(?<=[A-Za-z0-9)\]])\^(?:\{([^{}\n]{1,12})\}|([-−]?\d{1,3}|[a-z])(?![A-Za-z0-9]))/g;

/** Rewrites plain-text unit powers (`cm2`, `km3`) to Unicode `cm²` / `km³`. */
export function normalizeUnitPowers(text: string): string {
  return text.replace(UNIT_POWER_RE, (_, unit: string, power: string) => `${unit}${power === '2' ? '²' : '³'}`);
}

/** Splits plain text into text/superscript spans (caret exponents), after unit-power normalisation. */
export function parseMathSpans(text: string): InlineSpan[] {
  const normalized = normalizeUnitPowers(text);
  const spans: InlineSpan[] = [];
  let lastIndex = 0;
  CARET_EXPONENT_RE.lastIndex = 0;
  for (const match of normalized.matchAll(CARET_EXPONENT_RE)) {
    const at = match.index ?? 0;
    if (at > lastIndex) spans.push({ type: 'text', text: normalized.slice(lastIndex, at) });
    spans.push({ type: 'sup', text: (match[1] ?? match[2]).replace(/^-/, '−') });
    lastIndex = at + match[0].length;
  }
  if (lastIndex < normalized.length) spans.push({ type: 'text', text: normalized.slice(lastIndex) });
  return spans;
}

export function parseInlineSpans(text: string): InlineSpan[] {
  if (!text) return [];
  return parseEmphasisSpans(text).flatMap((span) =>
    span.type === 'text' ? parseMathSpans(span.text) : [{ ...span, text: normalizeUnitPowers(span.text) }]
  );
}

function parseEmphasisSpans(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let lastIndex = 0;

  INLINE_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_TOKEN_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      spans.push({ type: 'text', text: text.slice(lastIndex, match.index) });
    }
    if (match[1] !== undefined) {
      spans.push({ type: 'bold', text: match[1] });
    } else if (match[2] !== undefined) {
      spans.push({ type: 'italic', text: match[2] });
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    spans.push({ type: 'text', text: text.slice(lastIndex) });
  }

  return spans;
}
