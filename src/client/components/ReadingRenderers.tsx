import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BookOpen, Check, Highlighter, RotateCcw, X } from 'lucide-react';
import type {
  EvidenceCitationRef,
  MarkingResult,
  QuestionItem,
  StimulusGroup,
  StudentQuestionView,
} from '../../shared/contracts';
import { VisualRenderer } from './VisualRenderer';

type WorkspaceQuestion = StudentQuestionView | (QuestionItem & { stimulus?: StimulusGroup });

interface TextSlicePart {
  text: string;
  isEvidence: boolean;
}

function sliceByEvidenceOffset(
  fullText: string,
  ev: EvidenceCitationRef | null | undefined,
  matchesTarget: boolean
): { parts: TextSlicePart[]; matched: boolean } {
  if (!matchesTarget || !ev) {
    return { parts: [{ text: fullText, isEvidence: false }], matched: false };
  }

  const { startOffset, endOffset, quote } = ev;
  if (
    Number.isInteger(startOffset) &&
    Number.isInteger(endOffset) &&
    startOffset >= 0 &&
    endOffset > startOffset &&
    endOffset <= fullText.length
  ) {
    const sliced = fullText.slice(startOffset, endOffset);
    const normSlice = sliced.replace(/\s+/g, ' ').trim();
    const normQuote = (quote || '').replace(/\s+/g, ' ').trim();
    if (!normQuote || normSlice === normQuote || normSlice.includes(normQuote) || normQuote.includes(normSlice)) {
      const parts: TextSlicePart[] = [];
      if (startOffset > 0) parts.push({ text: fullText.slice(0, startOffset), isEvidence: false });
      parts.push({ text: sliced, isEvidence: true });
      if (endOffset < fullText.length) parts.push({ text: fullText.slice(endOffset), isEvidence: false });
      return { parts, matched: true };
    }
  }

  // Fallback substring lookup if offsets shifted slightly
  if (quote && quote.trim().length >= 4) {
    const idx = fullText.indexOf(quote.trim());
    if (idx >= 0) {
      const end = idx + quote.trim().length;
      const parts: TextSlicePart[] = [];
      if (idx > 0) parts.push({ text: fullText.slice(0, idx), isEvidence: false });
      parts.push({ text: fullText.slice(idx, end), isEvidence: true });
      if (end < fullText.length) parts.push({ text: fullText.slice(end), isEvidence: false });
      return { parts, matched: true };
    }
  }

  return { parts: [{ text: fullText, isEvidence: false }], matched: false };
}

function renderStudentHighlights(text: string, highlights: string[]): ReactNode {
  if (!highlights.length) return text;
  const active = highlights.filter((h) => h.trim().length >= 3);
  if (!active.length) return text;
  const escaped = active.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`(${escaped.join('|')})`, 'gi');
  const segments = text.split(regex);
  return segments.map((seg, i) =>
    active.some((h) => h.toLowerCase() === seg.toLowerCase()) ? (
      <mark key={i} className="bg-[var(--status-warn-bg)] text-[var(--text-primary)] px-0.5 rounded-sm">
        {seg}
      </mark>
    ) : (
      <span key={i}>{seg}</span>
    )
  );
}

function renderTextWithHighlightsAndEvidence(
  text: string,
  highlights: string[],
  ev: EvidenceCitationRef | null | undefined,
  globalOffsetStart: number,
  rangeMatched: boolean
): ReactNode {
  if (!ev || !rangeMatched) {
    return renderStudentHighlights(text, highlights);
  }
  const segEnd = globalOffsetStart + text.length;
  const overlapStart = Math.max(globalOffsetStart, ev.startOffset);
  const overlapEnd = Math.min(segEnd, ev.endOffset);
  if (overlapStart >= overlapEnd) {
    return renderStudentHighlights(text, highlights);
  }
  const relStart = overlapStart - globalOffsetStart;
  const relEnd = overlapEnd - globalOffsetStart;
  const before = text.slice(0, relStart);
  const cited = text.slice(relStart, relEnd);
  const after = text.slice(relEnd);

  return (
    <>
      {before && renderStudentHighlights(before, highlights)}
      <mark
        data-evidence-ref={ev.refId}
        className="bg-sky-100 text-[var(--text-primary)] px-1 py-0.5 rounded-sm border-b-2 border-sky-600 font-medium"
      >
        <span className="inline-block mr-1 px-1 py-0 text-[10px] font-mono font-bold bg-sky-600 text-white rounded">
          [{ev.refId}]
        </span>
        {cited}
      </mark>
      {after && renderStudentHighlights(after, highlights)}
    </>
  );
}

interface ReadingStimulusPaneProps {
  question: WorkspaceQuestion;
  stimulus?: StimulusGroup;
  answersByPartId: Record<string, string | null>;
  onSelectAnswer: (partId: string, key: string | null) => void;
  activeGapIndex: number;
  onSelectGapIndex: (idx: number) => void;
  highlights: string[];
  onAddHighlight: (text: string) => void;
  onClearHighlights: () => void;
  readOnly?: boolean;
  activeEvidenceRef?: EvidenceCitationRef | null;
}

export function ReadingStimulusPane({
  question,
  stimulus: stimulusProp,
  answersByPartId,
  onSelectAnswer,
  activeGapIndex,
  onSelectGapIndex,
  highlights,
  onAddHighlight,
  onClearHighlights,
  readOnly = false,
  activeEvidenceRef = null,
}: ReadingStimulusPaneProps) {
  const stim = stimulusProp || question.stimulus;
  const [extractTab, setExtractTab] = useState<string>('ALL');
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!activeEvidenceRef) return;
    if (activeEvidenceRef.targetKind === 'extract' && activeEvidenceRef.extractLabel && stim?.extracts && stim.extracts.length > 2) {
      setExtractTab(activeEvidenceRef.extractLabel);
    }
    const timer = window.setTimeout(() => {
      const target = containerRef.current?.querySelector(
        `[data-evidence-ref="${CSS.escape(activeEvidenceRef.refId)}"]`
      );
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 60);
    return () => window.clearTimeout(timer);
  }, [activeEvidenceRef, stim?.extracts]);

  if (!stim) {
    return (
      <div className="p-2 text-sm text-[var(--text-secondary)]">
        {question.stemPrefix && <p className="reading-prose text-[var(--text-primary)]">{question.stemPrefix}</p>}
        <VisualRenderer visual={question.visual} />
      </div>
    );
  }

  const handleHighlightSelection = () => {
    const sel = window.getSelection()?.toString().trim();
    if (sel && sel.length >= 3) {
      onAddHighlight(sel.slice(0, 180));
      window.getSelection()?.removeAllRanges();
    }
  };

  const mainText = stim.mainTextMarkdown || '';
  const mainSliceInfo = sliceByEvidenceOffset(
    mainText,
    activeEvidenceRef,
    Boolean(activeEvidenceRef && activeEvidenceRef.targetKind === 'mainText')
  );

  // Check if evidence failed to anchor cleanly anywhere in text so we can render fallback quote banner
  const extractMatchesAny = Boolean(
    activeEvidenceRef &&
      activeEvidenceRef.targetKind === 'extract' &&
      stim.extracts?.some(
        (ex) =>
          ex.label === activeEvidenceRef.extractLabel &&
          sliceByEvidenceOffset(ex.bodyMarkdown, activeEvidenceRef, true).matched
      )
  );
  const showFallbackQuoteBanner = Boolean(
    activeEvidenceRef &&
      ((activeEvidenceRef.targetKind === 'mainText' && !mainSliceInfo.matched) ||
        (activeEvidenceRef.targetKind === 'extract' && !extractMatchesAny))
  );

  const renderRichPassage = () => {
    if (!mainText) return null;

    if (question.formatType === 'READ_POETRY_MCQ') {
      const lines = mainText.split('\n');
      let lineNum = 0;
      let runningOffset = 0;
      return (
        <div className="reading-prose space-y-1.5 text-[var(--text-primary)]">
          {lines.map((line, idx) => {
            const lineStart = runningOffset;
            runningOffset += line.length + 1;
            if (!line.trim()) {
              return <div key={idx} className="h-3" aria-hidden="true" />;
            }
            lineNum++;
            return (
              <div key={idx} className="flex items-baseline gap-4">
                <span className="w-6 text-right text-xs text-[var(--text-muted)] tabular-nums select-none shrink-0">
                  {lineNum % 5 === 0 || lineNum === 1 ? lineNum : ''}
                </span>
                <span>
                  {renderTextWithHighlightsAndEvidence(
                    line,
                    highlights,
                    activeEvidenceRef?.targetKind === 'mainText' ? activeEvidenceRef : null,
                    lineStart,
                    mainSliceInfo.matched
                  )}
                </span>
              </div>
            );
          })}
        </div>
      );
    }

    // Parse paragraphs with {{gap:N}} support for Cloze and Gapped Text while tracking global char offsets
    const paraRegex = /\n\s*\n/g;
    const paragraphs: { text: string; startOffset: number }[] = [];
    let lastEnd = 0;
    let m: RegExpExecArray | null;
    while ((m = paraRegex.exec(mainText)) !== null) {
      paragraphs.push({ text: mainText.slice(lastEnd, m.index), startOffset: lastEnd });
      lastEnd = m.index + m[0].length;
    }
    paragraphs.push({ text: mainText.slice(lastEnd), startOffset: lastEnd });

    return (
      <div className="reading-prose space-y-4 text-[var(--text-primary)]">
        {paragraphs.map((paraObj, pIdx) => {
          const para = paraObj.text;
          const tokenRegex = /(\{\{gap:\d+\}\})/g;
          const tokens: { raw: string; offset: number }[] = [];
          let tLast = 0;
          let tm: RegExpExecArray | null;
          while ((tm = tokenRegex.exec(para)) !== null) {
            if (tm.index > tLast) {
              tokens.push({ raw: para.slice(tLast, tm.index), offset: paraObj.startOffset + tLast });
            }
            tokens.push({ raw: tm[0], offset: paraObj.startOffset + tm.index });
            tLast = tm.index + tm[0].length;
          }
          if (tLast < para.length) {
            tokens.push({ raw: para.slice(tLast), offset: paraObj.startOffset + tLast });
          }

          return (
            <p key={pIdx}>
              {tokens.map((tokObj, tIdx) => {
                const tok = tokObj.raw;
                const match = tok.match(/^\{\{gap:(\d+)\}\}$/);
                if (!match) {
                  return (
                    <span key={tIdx}>
                      {renderTextWithHighlightsAndEvidence(
                        tok,
                        highlights,
                        activeEvidenceRef?.targetKind === 'mainText' ? activeEvidenceRef : null,
                        tokObj.offset,
                        mainSliceInfo.matched
                      )}
                    </span>
                  );
                }
                const gapNum = Number(match[1]);
                const part = question.parts[gapNum - 1] || question.parts.find((p) => p.slotRef === `gap:${gapNum}`);
                if (!part) return <span key={tIdx}>{tok}</span>;

                if (question.formatType === 'READ_VOCAB_CLOZE') {
                  const picked = answersByPartId[part.partId] || '';
                  return (
                    <span key={tIdx} className="inline-block mx-1 align-baseline font-sans">
                      <select
                        aria-label={`Gap ${gapNum}`}
                        disabled={readOnly}
                        value={picked}
                        onChange={(e) => !readOnly && onSelectAnswer(part.partId, e.target.value || null)}
                        className={`px-2 py-0.5 text-sm rounded-[var(--radius-sm)] border font-medium transition-colors ${
                          readOnly ? 'cursor-default' : 'cursor-pointer'
                        } ${
                          picked
                            ? 'border-[var(--accent-primary)] bg-[var(--accent-soft)] text-[var(--text-primary)]'
                            : 'border-[var(--border-strong)] bg-[var(--bg-elevated)] text-[var(--text-secondary)]'
                        }`}
                      >
                        <option value="">[{gapNum}] Choose...</option>
                        {part.options.map((opt) => (
                          <option key={opt.key} value={opt.key}>
                            {opt.key}. {opt.text}
                          </option>
                        ))}
                      </select>
                    </span>
                  );
                }

                if (question.formatType === 'READ_GAPPED_TEXT') {
                  const pickedKey = answersByPartId[part.partId];
                  const placedExtract = pickedKey
                    ? stim.extracts?.find((ex) => ex.label === pickedKey)
                    : undefined;
                  const isActive = activeGapIndex === gapNum - 1;
                  return (
                    <button
                      key={tIdx}
                      type="button"
                      onClick={() => onSelectGapIndex(gapNum - 1)}
                      className={`inline-flex items-center gap-1.5 mx-1 px-2.5 py-1 rounded-[var(--radius-sm)] border text-xs font-sans font-semibold transition-colors cursor-pointer align-baseline ${
                        isActive
                          ? 'border-[var(--accent-primary)] bg-[var(--accent-soft)] text-[var(--text-primary)] ring-2 ring-[var(--accent-primary)]/20'
                          : placedExtract
                            ? 'border-[var(--status-success)] bg-[var(--status-success-bg)] text-[var(--status-success)]'
                            : 'border-[var(--border-strong)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:border-[var(--accent-primary)]'
                      }`}
                    >
                      <span>Gap {gapNum}</span>
                      {placedExtract && (
                        <span className="font-normal text-[var(--text-primary)]">
                          · [{placedExtract.label}] {placedExtract.bodyMarkdown.slice(0, 44)}
                          {placedExtract.bodyMarkdown.length > 44 ? '…' : ''}
                        </span>
                      )}
                    </button>
                  );
                }

                return <span key={tIdx}>{tok}</span>;
              })}
            </p>
          );
        })}
      </div>
    );
  };

  const showExtractsInLeftPane =
    stim.extracts &&
    stim.extracts.length > 0 &&
    question.formatType !== 'READ_GAPPED_TEXT';

  return (
    <div ref={containerRef} className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-[var(--border-hairline)]">
        <div>
          {stim.title && <h2 className="text-lg font-bold text-[var(--text-primary)]">{stim.title}</h2>}
          <div className="text-xs text-[var(--text-muted)]">
            {stim.genreOrTextType.replace(/_/g, ' ')}
          </div>
        </div>
        {!readOnly && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleHighlightSelection}
              title="Select text in the passage, then click to highlight"
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] text-xs font-medium text-[var(--text-secondary)] cursor-pointer whitespace-nowrap"
            >
              <Highlighter className="w-3.5 h-3.5" />
              <span>Highlight</span>
            </button>
            {highlights.length > 0 && (
              <button
                type="button"
                onClick={onClearHighlights}
                className="inline-flex items-center gap-1 px-2 py-1.5 rounded-[var(--radius-sm)] text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
              >
                <RotateCcw className="w-3 h-3" />
                <span>Clear ({highlights.length})</span>
              </button>
            )}
          </div>
        )}
      </div>

      {activeEvidenceRef && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 rounded-[var(--radius-sm)] bg-sky-50 border border-sky-200 text-xs text-sky-900">
          <div className="flex items-center gap-2">
            <BookOpen className="w-3.5 h-3.5 text-sky-700 shrink-0" />
            <span>
              Viewing Citation <strong>[{activeEvidenceRef.refId}]</strong>
              {activeEvidenceRef.extractLabel ? ` (Extract ${activeEvidenceRef.extractLabel})` : ' (Main Text)'}
            </span>
          </div>
          {highlights.length > 0 && (
            <div className="flex items-center gap-3 text-[11px]">
              <span className="inline-flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-xs bg-[var(--status-warn-bg)] border border-[var(--status-warn)]/40 inline-block" />
                Your highlight
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-xs bg-sky-100 border border-sky-600 inline-block" />
                Evidence citation
              </span>
            </div>
          )}
        </div>
      )}

      {showFallbackQuoteBanner && activeEvidenceRef?.quote && (
        <div className="p-3 rounded-[var(--radius-sm)] bg-sky-50 border border-sky-300 text-xs text-sky-950 space-y-1">
          <div className="font-semibold">
            Evidence Quote [{activeEvidenceRef.refId}] (offset re-anchored quote):
          </div>
          <blockquote className="italic border-l-2 border-sky-500 pl-2.5">
            &ldquo;{activeEvidenceRef.quote}&rdquo;
          </blockquote>
        </div>
      )}

      {stim.preamble && (
        <p className="text-sm italic text-[var(--text-secondary)] bg-[var(--bg-surface)] px-4 py-3 rounded-[var(--radius-sm)] border border-[var(--border-hairline)]">
          {stim.preamble}
        </p>
      )}

      {stim.visual && <VisualRenderer visual={stim.visual} />}
      {renderRichPassage()}

      {showExtractsInLeftPane && stim.extracts && (
        <div className="space-y-4">
          {stim.extracts.length > 2 && (
            <div className="flex flex-wrap items-center gap-1.5 p-1 bg-[var(--bg-surface)] rounded-[var(--radius-sm)] w-fit">
              <button
                type="button"
                onClick={() => setExtractTab('ALL')}
                className={`px-3 py-1 text-xs font-semibold rounded-[var(--radius-sm)] cursor-pointer ${
                  extractTab === 'ALL'
                    ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-xs'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                All Extracts
              </button>
              {stim.extracts.map((ex) => (
                <button
                  key={ex.label}
                  type="button"
                  onClick={() => setExtractTab(ex.label)}
                  className={`px-3 py-1 text-xs font-semibold rounded-[var(--radius-sm)] cursor-pointer ${
                    extractTab === ex.label
                      ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-xs'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  Extract {ex.label}
                </button>
              ))}
            </div>
          )}

          {stim.extracts
            .filter((ex) => extractTab === 'ALL' || ex.label === extractTab)
            .map((ex) => {
              const targetMatchesExtract = Boolean(
                activeEvidenceRef &&
                  activeEvidenceRef.targetKind === 'extract' &&
                  activeEvidenceRef.extractLabel === ex.label
              );
              const exSlice = sliceByEvidenceOffset(ex.bodyMarkdown, activeEvidenceRef, targetMatchesExtract);
              return (
                <article
                  key={ex.label}
                  className="p-4 rounded-[var(--radius-md)] border border-[var(--border-hairline)] bg-[var(--bg-canvas)] space-y-2"
                >
                  <div className="text-xs font-bold tracking-wide text-[var(--accent-primary)]">
                    Extract {ex.label}
                    {ex.title && ex.title.trim().toLowerCase() !== `extract ${ex.label.toLowerCase()}`
                      ? ` — ${ex.title}`
                      : ''}
                  </div>
                  <div className="reading-prose text-[var(--text-primary)] whitespace-pre-line">
                    {targetMatchesExtract && exSlice.matched ? (
                      exSlice.parts.map((seg, i) =>
                        seg.isEvidence ? (
                          <mark
                            key={i}
                            data-evidence-ref={activeEvidenceRef!.refId}
                            className="bg-sky-100 text-[var(--text-primary)] px-1 py-0.5 rounded-sm border-b-2 border-sky-600 font-medium"
                          >
                            <span className="inline-block mr-1 px-1 py-0 text-[10px] font-mono font-bold bg-sky-600 text-white rounded">
                              [{activeEvidenceRef!.refId}]
                            </span>
                            {seg.text}
                          </mark>
                        ) : (
                          <span key={i}>{renderStudentHighlights(seg.text, highlights)}</span>
                        )
                      )
                    ) : (
                      renderStudentHighlights(ex.bodyMarkdown, highlights)
                    )}
                  </div>
                </article>
              );
            })}
        </div>
      )}
    </div>
  );
}

interface ReadingRightAnswerPaneProps {
  question: WorkspaceQuestion;
  stimulus?: StimulusGroup;
  answersByPartId: Record<string, string | null>;
  eliminatedByPartId: Record<string, string[]>;
  onSelectAnswer: (partId: string, key: string | null) => void;
  onToggleEliminate: (partId: string, key: string) => void;
  activeGapIndex: number;
  onSelectGapIndex: (idx: number) => void;
  readOnly?: boolean;
  showAnswerKey?: boolean;
  reviewByPartId?: Record<string, MarkingResult>;
}

export function ReadingRightAnswerPane({
  question,
  stimulus: stimulusProp,
  answersByPartId,
  eliminatedByPartId,
  onSelectAnswer,
  onToggleEliminate,
  activeGapIndex,
  onSelectGapIndex,
  readOnly = false,
  showAnswerKey = false,
  reviewByPartId = {},
}: ReadingRightAnswerPaneProps) {
  const stim = stimulusProp || question.stimulus;

  const getKeyForPart = (partId: string): string | undefined => {
    if (reviewByPartId[partId]?.correctAnswerKey) return reviewByPartId[partId].correctAnswerKey;
    const rawPart = question.parts.find((p) => p.partId === partId) as { correctAnswerKey?: string } | undefined;
    return showAnswerKey ? rawPart?.correctAnswerKey : undefined;
  };

  if (question.formatType === 'READ_VOCAB_CLOZE') {
    return (
      <div className="space-y-4">
        <div className="text-xs font-medium text-[var(--text-secondary)]">
          {readOnly
            ? 'Vocabulary Cloze responses by numbered gap:'
            : 'Choose the best word for each numbered gap in the passage (synced with inline dropdowns).'}
        </div>
        {question.parts.map((part, idx) => {
          const picked = answersByPartId[part.partId] || null;
          const correctKey = getKeyForPart(part.partId);
          return (
            <div
              key={part.partId}
              className="p-4 rounded-[var(--radius-md)] border border-[var(--border-hairline)] bg-[var(--bg-canvas)] space-y-2.5"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-[var(--text-primary)] tabular-nums">
                  Gap {idx + 1}
                </span>
                {!readOnly && picked && (
                  <button
                    type="button"
                    onClick={() => onSelectAnswer(part.partId, null)}
                    className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                  >
                    Clear
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                {part.options.map((opt) => {
                  const selected = picked === opt.key;
                  const isCorrect = correctKey === opt.key;
                  const isWrongSelected = readOnly && selected && correctKey && !isCorrect;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      disabled={readOnly}
                      onClick={() => !readOnly && onSelectAnswer(part.partId, selected ? null : opt.key)}
                      className={`px-3 py-2 rounded-[var(--radius-sm)] border text-left text-sm flex items-center justify-between gap-2 transition-colors ${
                        readOnly ? 'cursor-default' : 'cursor-pointer'
                      } ${
                        readOnly && isCorrect
                          ? 'border-[var(--status-success)] bg-[var(--status-success-bg)] font-semibold text-[var(--text-primary)]'
                          : isWrongSelected
                            ? 'border-[var(--status-error)] bg-[var(--status-error-bg)] font-semibold text-[var(--text-primary)]'
                            : selected
                              ? 'border-[var(--accent-primary)] bg-[var(--accent-soft)] font-semibold text-[var(--text-primary)]'
                              : 'border-[var(--border-hairline)] bg-[var(--bg-elevated)] hover:bg-[var(--bg-surface)] text-[var(--text-primary)]'
                      }`}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <span className="font-mono text-xs text-[var(--text-muted)]">{opt.key}</span>
                        <span className="truncate">{opt.text}</span>
                      </span>
                      {readOnly && isCorrect && (
                        <span className="text-[10px] font-bold text-[var(--status-success)] shrink-0">Key</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  if (question.formatType === 'READ_GAPPED_TEXT') {
    const activePart = question.parts[activeGapIndex] || question.parts[0];
    const extracts = stim?.extracts || [];
    const reuseAllowed = question.sharedPoolConfig?.reuseAllowed ?? false;

    const assignedGapForExtract = (label: string) => {
      const idx = question.parts.findIndex((p) => answersByPartId[p.partId] === label);
      return idx >= 0 ? idx + 1 : null;
    };

    const correctGapForExtract = (label: string) => {
      const idx = question.parts.findIndex((p) => getKeyForPart(p.partId) === label);
      return idx >= 0 ? idx + 1 : null;
    };

    const assignExtractToActiveGap = (label: string) => {
      if (!activePart || readOnly) return;
      const currentlySelected = answersByPartId[activePart.partId];
      if (currentlySelected === label) {
        onSelectAnswer(activePart.partId, null);
        return;
      }
      if (!reuseAllowed) {
        for (const p of question.parts) {
          if (p.partId !== activePart.partId && answersByPartId[p.partId] === label) {
            onSelectAnswer(p.partId, null);
          }
        }
      }
      onSelectAnswer(activePart.partId, label);
    };

    return (
      <div className="space-y-4">
        <div className="text-xs text-[var(--text-secondary)]">
          {readOnly
            ? 'Gapped Text placement overview:'
            : 'Select a gap slot, then choose an extract from the bank below. Each extract can be used once.'}
        </div>

        <div className="flex flex-wrap gap-2">
          {question.parts.map((p, idx) => {
            const val = answersByPartId[p.partId];
            const cKey = getKeyForPart(p.partId);
            const isCurrent = idx === activeGapIndex;
            return (
              <button
                key={p.partId}
                type="button"
                onClick={() => onSelectGapIndex(idx)}
                className={`px-3 py-1.5 rounded-[var(--radius-sm)] border text-xs font-semibold tabular-nums cursor-pointer transition-colors ${
                  isCurrent
                    ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)] text-white'
                    : val
                      ? 'border-[var(--status-success)] bg-[var(--status-success-bg)] text-[var(--status-success)]'
                      : 'border-[var(--border-strong)] bg-[var(--bg-elevated)] text-[var(--text-primary)]'
                }`}
              >
                Gap {idx + 1}
                {val ? ` → ${val}` : ''}
                {readOnly && cKey ? ` (Key: ${cKey})` : ''}
              </button>
            );
          })}
        </div>

        <div className="space-y-2.5">
          {extracts.map((ex) => {
            const assignedGapNum = assignedGapForExtract(ex.label);
            const correctGapNum = readOnly ? correctGapForExtract(ex.label) : null;
            const isAssignedToCurrent = activePart && answersByPartId[activePart.partId] === ex.label;
            return (
              <div
                key={ex.label}
                className={`p-3.5 rounded-[var(--radius-md)] border transition-colors ${
                  readOnly && correctGapNum
                    ? 'border-[var(--status-success)] bg-[var(--status-success-bg)]/50'
                    : isAssignedToCurrent
                      ? 'border-[var(--accent-primary)] bg-[var(--accent-soft)]'
                      : assignedGapNum
                        ? 'border-[var(--border-strong)] bg-[var(--bg-surface)] opacity-85'
                        : 'border-[var(--border-hairline)] bg-[var(--bg-elevated)]'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="text-xs font-bold text-[var(--text-primary)]">
                      Extract {ex.label}
                      {assignedGapNum ? ` · Selected Gap ${assignedGapNum}` : ''}
                      {correctGapNum ? ` · Key: Gap ${correctGapNum}` : ''}
                    </div>
                    <p className="text-sm text-[var(--text-primary)] leading-relaxed">{ex.bodyMarkdown}</p>
                  </div>
                  {!readOnly && (
                    <button
                      type="button"
                      onClick={() => assignExtractToActiveGap(ex.label)}
                      className={`px-3 py-1.5 rounded-[var(--radius-sm)] text-xs font-semibold shrink-0 cursor-pointer whitespace-nowrap ${
                        isAssignedToCurrent
                          ? 'bg-[var(--text-primary)] text-white'
                          : 'border border-[var(--border-strong)] bg-[var(--bg-canvas)] hover:bg-[var(--bg-hover)] text-[var(--text-primary)]'
                      }`}
                    >
                      {isAssignedToCurrent
                        ? 'Remove'
                        : assignedGapNum
                          ? `Move to Gap ${activeGapIndex + 1}`
                          : `Place in Gap ${activeGapIndex + 1}`}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (question.formatType === 'READ_MULTIPLE_MATCH') {
    const keys = question.sharedPoolConfig?.poolKeys || ['A', 'B', 'C', 'D'];
    return (
      <div className="space-y-3">
        <div className="text-xs text-[var(--text-secondary)]">
          {readOnly
            ? 'Multiple matching answers (green = key, orange/red = student selection):'
            : 'Match each statement to Extract A, B, C, or D (extracts may be used more than once).'}
        </div>
        {question.parts.map((part, idx) => {
          const picked = answersByPartId[part.partId] || null;
          const correctKey = getKeyForPart(part.partId);
          return (
            <div
              key={part.partId}
              className="p-3.5 rounded-[var(--radius-md)] border border-[var(--border-hairline)] bg-[var(--bg-elevated)] flex flex-col sm:flex-row sm:items-center justify-between gap-3"
            >
              <div className="text-sm text-[var(--text-primary)]">
                <span className="font-mono text-xs text-[var(--text-muted)] mr-2">{idx + 1}.</span>
                {part.promptText}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {keys.map((k) => {
                  const selected = picked === k;
                  const isCorrect = correctKey === k;
                  const isWrongSelected = readOnly && selected && correctKey && !isCorrect;
                  return (
                    <button
                      key={k}
                      type="button"
                      disabled={readOnly}
                      aria-label={`Statement ${idx + 1} option ${k}`}
                      onClick={() => !readOnly && onSelectAnswer(part.partId, selected ? null : k)}
                      className={`w-9 h-9 rounded-[var(--radius-sm)] border text-xs font-bold transition-colors ${
                        readOnly ? 'cursor-default' : 'cursor-pointer'
                      } ${
                        readOnly && isCorrect
                          ? 'border-[var(--status-success)] bg-[var(--status-success)] text-white'
                          : isWrongSelected
                            ? 'border-[var(--status-error)] bg-[var(--status-error)] text-white'
                            : selected
                              ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)] text-white'
                              : 'border-[var(--border-strong)] bg-[var(--bg-canvas)] hover:bg-[var(--bg-surface)] text-[var(--text-primary)]'
                      }`}
                    >
                      {k}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // Standard Reading MCQ (Fiction & Poetry)
  const part = question.parts[0];
  if (!part) return null;
  const picked = answersByPartId[part.partId] || null;
  const eliminated = new Set(eliminatedByPartId[part.partId] || []);
  const correctKey = getKeyForPart(part.partId);

  return (
    <div className="space-y-4">
      <div className="text-base font-semibold text-[var(--text-primary)] leading-snug">
        {part.promptText}
      </div>
      <div className="space-y-2.5">
        {part.options.map((opt) => {
          const isSelected = picked === opt.key;
          const isCorrect = correctKey === opt.key;
          const isWrongSelected = readOnly && isSelected && correctKey && !isCorrect;
          const isElim = !readOnly && eliminated.has(opt.key);
          return (
            <div key={opt.key} className="flex items-stretch gap-2">
              <button
                type="button"
                disabled={readOnly}
                onClick={() => !readOnly && onSelectAnswer(part.partId, isSelected ? null : opt.key)}
                className={`flex-1 text-left p-3.5 rounded-[var(--radius-md)] border transition-colors flex items-start gap-3 ${
                  readOnly ? 'cursor-default' : 'cursor-pointer'
                } ${
                  readOnly && isCorrect
                    ? 'border-[var(--status-success)] bg-[var(--status-success-bg)]'
                    : isWrongSelected
                      ? 'border-[var(--status-error)] bg-[var(--status-error-bg)]'
                      : isSelected
                        ? 'border-[var(--accent-primary)] bg-[var(--accent-soft)]'
                        : isElim
                          ? 'border-[var(--border-hairline)] bg-[var(--bg-surface)] opacity-55'
                          : 'border-[var(--border-hairline)] bg-[var(--bg-elevated)] hover:border-[var(--border-strong)]'
                }`}
              >
                <span
                  className={`w-6 h-6 rounded-full border text-xs font-bold flex items-center justify-center shrink-0 mt-0.5 ${
                    readOnly && isCorrect
                      ? 'border-[var(--status-success)] bg-[var(--status-success)] text-white'
                      : isWrongSelected
                        ? 'border-[var(--status-error)] bg-[var(--status-error)] text-white'
                        : isSelected
                          ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)] text-white'
                          : 'border-[var(--border-strong)] text-[var(--text-secondary)]'
                  }`}
                >
                  {readOnly && isCorrect ? (
                    <Check className="w-3.5 h-3.5" />
                  ) : isSelected && !readOnly ? (
                    <Check className="w-3.5 h-3.5" />
                  ) : (
                    opt.key
                  )}
                </span>
                <div className="flex-1 min-w-0 space-y-2">
                  {opt.text && (
                    <span className={`block text-sm text-[var(--text-primary)] leading-relaxed ${isElim ? 'line-through' : ''}`}>
                      {opt.text}
                    </span>
                  )}
                  {opt.visual && <VisualRenderer visual={opt.visual} compact />}
                </div>
                {readOnly && isCorrect && (
                  <span className="text-[11px] font-bold text-[var(--status-success)] shrink-0 mt-0.5">
                    Correct
                  </span>
                )}
                {isWrongSelected && (
                  <span className="text-[11px] font-bold text-[var(--status-error)] shrink-0 mt-0.5">
                    Picked
                  </span>
                )}
              </button>
              {!readOnly && (
                <button
                  type="button"
                  aria-label={`Eliminate option ${opt.key}`}
                  title="Cross out option"
                  onClick={() => onToggleEliminate(part.partId, opt.key)}
                  className={`px-2.5 rounded-[var(--radius-md)] border text-xs cursor-pointer transition-colors ${
                    isElim
                      ? 'border-[var(--border-strong)] bg-[var(--bg-hover)] text-[var(--text-primary)]'
                      : 'border-[var(--border-hairline)] bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
