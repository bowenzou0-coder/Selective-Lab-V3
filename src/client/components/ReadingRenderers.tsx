import { useState, type ReactNode } from 'react';
import { Check, Highlighter, RotateCcw, X } from 'lucide-react';
import type { StudentQuestionView } from '../../shared/contracts';
import { VisualRenderer } from './VisualRenderer';

interface ReadingStimulusPaneProps {
  question: StudentQuestionView;
  answersByPartId: Record<string, string | null>;
  onSelectAnswer: (partId: string, key: string | null) => void;
  activeGapIndex: number;
  onSelectGapIndex: (idx: number) => void;
  highlights: string[];
  onAddHighlight: (text: string) => void;
  onClearHighlights: () => void;
}

function renderWithHighlights(text: string, highlights: string[]): ReactNode {
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

export function ReadingStimulusPane({
  question,
  answersByPartId,
  onSelectAnswer,
  activeGapIndex,
  onSelectGapIndex,
  highlights,
  onAddHighlight,
  onClearHighlights,
}: ReadingStimulusPaneProps) {
  const stim = question.stimulus;
  const [extractTab, setExtractTab] = useState<string>('ALL');

  if (!stim) {
    return (
      <div className="p-6 text-sm text-[var(--text-secondary)]">
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

  const renderRichPassage = () => {
    const text = stim.mainTextMarkdown || '';
    if (!text) return null;

    if (question.formatType === 'READ_POETRY_MCQ') {
      const lines = text.split('\n');
      let lineNum = 0;
      return (
        <div className="reading-prose space-y-1.5 text-[var(--text-primary)]">
          {lines.map((line, idx) => {
            if (!line.trim()) {
              return <div key={idx} className="h-3" aria-hidden="true" />;
            }
            lineNum++;
            return (
              <div key={idx} className="flex items-baseline gap-4">
                <span className="w-6 text-right text-xs text-[var(--text-muted)] tabular-nums select-none shrink-0">
                  {lineNum % 5 === 0 || lineNum === 1 ? lineNum : ''}
                </span>
                <span>{renderWithHighlights(line, highlights)}</span>
              </div>
            );
          })}
        </div>
      );
    }

    // Parse paragraphs with {{gap:N}} support for Cloze and Gapped Text
    const paragraphs = text.split(/\n\s*\n/);
    return (
      <div className="reading-prose space-y-4 text-[var(--text-primary)]">
        {paragraphs.map((para, pIdx) => {
          const tokens = para.split(/(\{\{gap:\d+\}\})/g);
          return (
            <p key={pIdx}>
              {tokens.map((tok, tIdx) => {
                const match = tok.match(/^\{\{gap:(\d+)\}\}$/);
                if (!match) {
                  return <span key={tIdx}>{renderWithHighlights(tok, highlights)}</span>;
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
                        value={picked}
                        onChange={(e) => onSelectAnswer(part.partId, e.target.value || null)}
                        className={`px-2 py-0.5 text-sm rounded-[var(--radius-sm)] border font-medium transition-colors cursor-pointer ${
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
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-[var(--border-hairline)]">
        <div>
          {stim.title && <h2 className="text-lg font-bold text-[var(--text-primary)]">{stim.title}</h2>}
          <div className="text-xs text-[var(--text-muted)]">
            {stim.genreOrTextType.replace(/_/g, ' ')}
          </div>
        </div>
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
      </div>

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
            .map((ex) => (
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
                  {renderWithHighlights(ex.bodyMarkdown, highlights)}
                </div>
              </article>
            ))}
        </div>
      )}
    </div>
  );
}

interface ReadingRightAnswerPaneProps {
  question: StudentQuestionView;
  answersByPartId: Record<string, string | null>;
  eliminatedByPartId: Record<string, string[]>;
  onSelectAnswer: (partId: string, key: string | null) => void;
  onToggleEliminate: (partId: string, key: string) => void;
  activeGapIndex: number;
  onSelectGapIndex: (idx: number) => void;
}

export function ReadingRightAnswerPane({
  question,
  answersByPartId,
  eliminatedByPartId,
  onSelectAnswer,
  onToggleEliminate,
  activeGapIndex,
  onSelectGapIndex,
}: ReadingRightAnswerPaneProps) {
  if (question.formatType === 'READ_VOCAB_CLOZE') {
    return (
      <div className="space-y-4">
        <div className="text-xs font-medium text-[var(--text-secondary)]">
          Choose the best word for each numbered gap in the passage (synced with inline dropdowns).
        </div>
        {question.parts.map((part, idx) => {
          const picked = answersByPartId[part.partId] || null;
          return (
            <div
              key={part.partId}
              className="p-4 rounded-[var(--radius-md)] border border-[var(--border-hairline)] bg-[var(--bg-canvas)] space-y-2.5"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-[var(--text-primary)] tabular-nums">
                  Gap {idx + 1}
                </span>
                {picked && (
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
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => onSelectAnswer(part.partId, selected ? null : opt.key)}
                      className={`px-3 py-2 rounded-[var(--radius-sm)] border text-left text-sm flex items-center gap-2 transition-colors cursor-pointer ${
                        selected
                          ? 'border-[var(--accent-primary)] bg-[var(--accent-soft)] font-semibold text-[var(--text-primary)]'
                          : 'border-[var(--border-hairline)] bg-[var(--bg-elevated)] hover:bg-[var(--bg-surface)] text-[var(--text-primary)]'
                      }`}
                    >
                      <span className="font-mono text-xs text-[var(--text-muted)]">{opt.key}</span>
                      <span className="truncate">{opt.text}</span>
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
    const extracts = question.stimulus?.extracts || [];
    const reuseAllowed = question.sharedPoolConfig?.reuseAllowed ?? false;

    const assignedGapForExtract = (label: string) => {
      const idx = question.parts.findIndex((p) => answersByPartId[p.partId] === label);
      return idx >= 0 ? idx + 1 : null;
    };

    const assignExtractToActiveGap = (label: string) => {
      if (!activePart) return;
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
          Select a gap slot, then choose an extract from the bank below. Each extract can be used once.
        </div>

        <div className="flex flex-wrap gap-2">
          {question.parts.map((p, idx) => {
            const val = answersByPartId[p.partId];
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
              </button>
            );
          })}
        </div>

        <div className="space-y-2.5">
          {extracts.map((ex) => {
            const assignedGapNum = assignedGapForExtract(ex.label);
            const isAssignedToCurrent = activePart && answersByPartId[activePart.partId] === ex.label;
            return (
              <div
                key={ex.label}
                className={`p-3.5 rounded-[var(--radius-md)] border transition-colors ${
                  isAssignedToCurrent
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
                      {assignedGapNum ? ` · Placed in Gap ${assignedGapNum}` : ''}
                    </div>
                    <p className="text-sm text-[var(--text-primary)] leading-relaxed">{ex.bodyMarkdown}</p>
                  </div>
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
          Match each statement to Extract A, B, C, or D (extracts may be used more than once).
        </div>
        {question.parts.map((part, idx) => {
          const picked = answersByPartId[part.partId] || null;
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
                  return (
                    <button
                      key={k}
                      type="button"
                      aria-label={`Statement ${idx + 1} option ${k}`}
                      onClick={() => onSelectAnswer(part.partId, selected ? null : k)}
                      className={`w-9 h-9 rounded-[var(--radius-sm)] border text-xs font-bold cursor-pointer transition-colors ${
                        selected
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

  return (
    <div className="space-y-4">
      <div className="text-base font-semibold text-[var(--text-primary)] leading-snug">
        {part.promptText}
      </div>
      <div className="space-y-2.5">
        {part.options.map((opt) => {
          const isSelected = picked === opt.key;
          const isElim = eliminated.has(opt.key);
          return (
            <div key={opt.key} className="flex items-stretch gap-2">
              <button
                type="button"
                onClick={() => onSelectAnswer(part.partId, isSelected ? null : opt.key)}
                className={`flex-1 text-left p-3.5 rounded-[var(--radius-md)] border transition-colors flex items-start gap-3 cursor-pointer ${
                  isSelected
                    ? 'border-[var(--accent-primary)] bg-[var(--accent-soft)]'
                    : isElim
                      ? 'border-[var(--border-hairline)] bg-[var(--bg-surface)] opacity-55'
                      : 'border-[var(--border-hairline)] bg-[var(--bg-elevated)] hover:border-[var(--border-strong)]'
                }`}
              >
                <span
                  className={`w-6 h-6 rounded-full border text-xs font-bold flex items-center justify-center shrink-0 mt-0.5 ${
                    isSelected
                      ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)] text-white'
                      : 'border-[var(--border-strong)] text-[var(--text-secondary)]'
                  }`}
                >
                  {isSelected ? <Check className="w-3.5 h-3.5" /> : opt.key}
                </span>
                <div className="flex-1 min-w-0 space-y-2">
                  {opt.text && (
                    <span className={`block text-sm text-[var(--text-primary)] leading-relaxed ${isElim ? 'line-through' : ''}`}>
                      {opt.text}
                    </span>
                  )}
                  {opt.visual && <VisualRenderer visual={opt.visual} compact />}
                </div>
              </button>
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
            </div>
          );
        })}
      </div>
    </div>
  );
}
