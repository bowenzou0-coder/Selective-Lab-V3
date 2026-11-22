export interface HighlightSpan {
  id: string;
  start: number;
  end: number;
}

export interface HighlightSegment {
  text: string;
  annotationId?: string;
}

export interface AnnotatedParagraph {
  paragraphIndex: number;
  rawText: string;
  segments: HighlightSegment[];
}

interface NormalizedIndexMap {
  normText: string;
  normToOrigStart: number[];
  normToOrigEnd: number[];
}

function normalizeChar(ch: string): string {
  if (ch === '‘' || ch === '’' || ch === '‚') return "'";
  if (ch === '“' || ch === '”' || ch === '„') return '"';
  if (ch === '—' || ch === '–' || ch === '−') return '-';
  return ch.toLowerCase();
}

function buildNormalizedIndexMap(text: string): NormalizedIndexMap {
  let normText = '';
  const normToOrigStart: number[] = [];
  const normToOrigEnd: number[] = [];

  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      const wsStart = i;
      while (i < text.length && /\s/.test(text[i])) i++;
      if (normText.length > 0 && !normText.endsWith(' ')) {
        normText += ' ';
        normToOrigStart.push(wsStart);
        normToOrigEnd.push(i);
      }
      continue;
    }
    normText += normalizeChar(text[i]);
    normToOrigStart.push(i);
    normToOrigEnd.push(i + 1);
    i++;
  }
  return { normText, normToOrigStart, normToOrigEnd };
}

function normalizeQueryString(raw: string): string {
  let out = '';
  let prevSpace = false;
  for (const ch of raw.trim()) {
    if (/\s/.test(ch)) {
      if (!prevSpace && out.length > 0) {
        out += ' ';
        prevSpace = true;
      }
    } else {
      out += normalizeChar(ch);
      prevSpace = false;
    }
  }
  return out.trim();
}

function overlapsClaimed(start: number, end: number, claimed: { start: number; end: number }[]): boolean {
  return claimed.some((r) => start < r.end && end > r.start);
}

function findBestRangeInText(
  text: string,
  normMap: NormalizedIndexMap,
  candidate: string,
  claimed: { start: number; end: number }[]
): { start: number; end: number } | null {
  const clean = candidate.trim();
  if (clean.length < 3) return null;

  // Tier 1: Exact substring match (prefer unclaimed occurrence)
  let fallbackExact: { start: number; end: number } | null = null;
  let idx = text.indexOf(clean);
  while (idx !== -1) {
    const start = idx;
    const end = idx + clean.length;
    if (!fallbackExact) fallbackExact = { start, end };
    if (!overlapsClaimed(start, end, claimed)) {
      return { start, end };
    }
    idx = text.indexOf(clean, idx + 1);
  }

  // Tier 2: Normalized match (smart quotes, dashes, whitespace, case-insensitive)
  const qNorm = normalizeQueryString(clean);
  if (qNorm.length < 3) return fallbackExact;

  let fallbackNorm: { start: number; end: number } | null = null;
  let nIdx = normMap.normText.indexOf(qNorm);
  while (nIdx !== -1) {
    const start = normMap.normToOrigStart[nIdx];
    const end = normMap.normToOrigEnd[nIdx + qNorm.length - 1];
    if (typeof start === 'number' && typeof end === 'number' && end > start) {
      if (!fallbackNorm) fallbackNorm = { start, end };
      if (!overlapsClaimed(start, end, claimed)) {
        return { start, end };
      }
    }
    nIdx = normMap.normText.indexOf(qNorm, nIdx + 1);
  }

  return fallbackExact || fallbackNorm;
}

function buildQuoteCandidates(quote: string): string[] {
  const candidates: string[] = [];
  const trimmed = quote.trim();
  if (trimmed) candidates.push(trimmed);

  // Strip surrounding quotes / ellipses if model emitted them
  const stripped = trimmed
    .replace(/^[“"'‘…\s]+|[”"'’…\s]+$/g, '')
    .replace(/^\.{2,}|\.{2,}$/g, '')
    .trim();
  if (stripped && stripped !== trimmed) candidates.push(stripped);

  // If the quote still contains an ellipsis inside, try longest contiguous chunks (>= 10 chars)
  if (/\.{3}|…/.test(stripped)) {
    const parts = stripped
      .split(/\.{3}|…/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 10)
      .sort((a, b) => b.length - a.length);
    candidates.push(...parts);
  }
  return candidates;
}

/**
 * Splits text by blank-line paragraphs and attaches non-overlapping verbatim
 * annotation highlights so `paragraph.segments.map(s => s.text).join('') === paragraph.rawText`.
 */
export function buildAnnotatedParagraphs(
  text: string,
  items: { id: string; quote: string }[]
): { paragraphs: AnnotatedParagraph[]; matchedIds: Set<string> } {
  const normMap = buildNormalizedIndexMap(text);
  const rawSpans: HighlightSpan[] = [];
  const matchedIds = new Set<string>();

  for (const item of items) {
    if (!item?.id || !item?.quote) continue;
    const candidates = buildQuoteCandidates(item.quote);
    let range: { start: number; end: number } | null = null;
    for (const c of candidates) {
      range = findBestRangeInText(text, normMap, c, rawSpans);
      if (range) break;
    }
    if (range) {
      rawSpans.push({ id: item.id, start: range.start, end: range.end });
    }
  }

  // Resolve overlaps deterministically (earliest start, then longest span)
  rawSpans.sort((a, b) => a.start - b.start || b.end - a.end);
  const nonOverlapping: HighlightSpan[] = [];
  let cursor = 0;
  for (const sp of rawSpans) {
    const clampedStart = Math.max(sp.start, cursor);
    if (clampedStart < sp.end) {
      nonOverlapping.push({ id: sp.id, start: clampedStart, end: sp.end });
      matchedIds.add(sp.id);
      cursor = sp.end;
    }
  }

  // Locate paragraph boundaries cleanly matching /\n\s*\n/ while preserving offsets
  const paragraphs: AnnotatedParagraph[] = [];
  const separatorRe = /\n\s*\n/g;
  const bounds: { start: number; end: number }[] = [];
  let pStart = 0;
  let match: RegExpExecArray | null;
  while ((match = separatorRe.exec(text)) !== null) {
    if (match.index > pStart) {
      bounds.push({ start: pStart, end: match.index });
    }
    pStart = match.index + match[0].length;
  }
  if (pStart < text.length) {
    bounds.push({ start: pStart, end: text.length });
  }

  bounds.forEach((b, paragraphIndex) => {
    const rawText = text.slice(b.start, b.end);
    if (!rawText.trim()) return;
    const segments: HighlightSegment[] = [];
    let localCursor = b.start;

    for (const sp of nonOverlapping) {
      if (sp.end <= b.start) continue;
      if (sp.start >= b.end) break;
      const segStart = Math.max(sp.start, b.start);
      const segEnd = Math.min(sp.end, b.end);
      if (segStart > localCursor) {
        segments.push({ text: text.slice(localCursor, segStart) });
      }
      if (segEnd > segStart) {
        segments.push({ text: text.slice(segStart, segEnd), annotationId: sp.id });
        localCursor = segEnd;
      }
    }
    if (localCursor < b.end) {
      segments.push({ text: text.slice(localCursor, b.end) });
    }

    paragraphs.push({ paragraphIndex, rawText, segments });
  });

  return { paragraphs, matchedIds };
}
