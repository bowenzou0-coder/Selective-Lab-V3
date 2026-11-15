import { useMemo, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, AlertCircle } from 'lucide-react';
import type { StudentQuestionView } from '../../shared/contracts';
import { computeWritingMetrics } from '../../shared/engine';
import { VisualRenderer } from './VisualRenderer';

interface WritingEditorProps {
  question: StudentQuestionView;
  planNotes: string;
  responseText: string;
  onChangePlan: (val: string) => void;
  onChangeResponse: (val: string) => void;
}

export function WritingStimulusPane({ question }: { question: StudentQuestionView }) {
  const stim = question.stimulus;
  const spec = question.writingSpec;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-bold text-[var(--text-primary)]">{stim?.title || 'Writing Task'}</h2>
        {spec && (
          <div className="mt-1.5 text-xs text-[var(--text-secondary)]">
            Genre: {spec.genre.replace(/_/g, ' ')} · Audience: {spec.audience} · Purpose: {spec.purpose}
          </div>
        )}
      </div>

      {stim?.mainTextMarkdown && (
        <div className="reading-prose text-[var(--text-primary)] whitespace-pre-line">
          {stim.mainTextMarkdown}
        </div>
      )}

      {spec?.bulletSuggestions && spec.bulletSuggestions.length > 0 && (
        <div className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-surface)] border border-[var(--border-hairline)] space-y-2">
          <div className="text-xs font-semibold text-[var(--text-secondary)]">Ideas to consider</div>
          <ul className="list-disc pl-5 space-y-1 text-sm text-[var(--text-primary)]">
            {spec.bulletSuggestions.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </div>
      )}

      {spec?.mandatoryOpeningLine && (
        <div className="p-4 rounded-[var(--radius-md)] bg-[var(--accent-soft)] border border-[var(--accent-primary)]/40 space-y-1">
          <div className="text-xs font-bold text-[var(--accent-primary)]">Mandatory Opening Line</div>
          <p className="text-sm font-medium text-[var(--text-primary)] italic">
            &ldquo;{spec.mandatoryOpeningLine}&rdquo;
          </p>
        </div>
      )}

      <VisualRenderer visual={stim?.visual || question.visual} />
    </div>
  );
}

export function WritingAnswerPane({
  question,
  planNotes,
  responseText,
  onChangePlan,
  onChangeResponse,
}: WritingEditorProps) {
  const [planOpen, setPlanOpen] = useState(true);
  const spec = question.writingSpec || {
    genre: 'essay',
    audience: 'General',
    purpose: 'Inform',
    recommendedWordRange: [250, 480] as [number, number],
    timeLimitSec: 1800,
  };

  const metrics = useMemo(() => computeWritingMetrics(spec, responseText), [spec, responseText]);
  const [minW, maxW] = spec.recommendedWordRange;

  return (
    <div className="space-y-4">
      {/* Collapsible Scratchpad Plan */}
      <div className="border border-[var(--border-hairline)] rounded-[var(--radius-md)] bg-[var(--bg-surface)]">
        <button
          type="button"
          onClick={() => setPlanOpen((v) => !v)}
          aria-expanded={planOpen}
          className="w-full px-4 py-2.5 flex items-center justify-between text-xs font-semibold text-[var(--text-primary)] cursor-pointer"
        >
          <span>Planning Scratchpad (Optional, not graded)</span>
          {planOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
        {planOpen && (
          <div className="px-4 pb-3">
            <textarea
              aria-label="Planning scratchpad"
              rows={3}
              spellCheck={false}
              value={planNotes}
              onChange={(e) => onChangePlan(e.target.value)}
              placeholder="Outline your key points, structure, or opening hook here..."
              className="w-full p-2.5 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] bg-[var(--bg-elevated)] text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
            />
          </div>
        )}
      </div>

      {/* Mandatory Starter Status & Word Counter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-3 tabular-nums text-[var(--text-secondary)]">
          <span>
            Words:{' '}
            <strong className="text-[var(--text-primary)]">{metrics.wordCount}</strong>{' '}
            <span className="text-[var(--text-muted)]">(target {minW}–{maxW})</span>
          </span>
          <span aria-hidden="true">·</span>
          <span>Paragraphs: {metrics.paragraphCount}</span>
        </div>

        {spec.mandatoryOpeningLine && (
          <div
            className={`inline-flex items-center gap-1.5 font-medium ${
              metrics.matchedMandatoryStarter
                ? 'text-[var(--status-success)]'
                : 'text-[var(--status-warn)]'
            }`}
          >
            {metrics.matchedMandatoryStarter ? (
              <>
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Opening line matched</span>
              </>
            ) : (
              <>
                <AlertCircle className="w-3.5 h-3.5" />
                <span>Must begin with exact mandatory opening line</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* Plain Text Writing Editor (spellCheck disabled per NSW CBT rules) */}
      <div>
        <label htmlFor="writing-response-editor" className="sr-only">
          Writing response
        </label>
        <textarea
          id="writing-response-editor"
          rows={14}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          value={responseText}
          onChange={(e) => onChangeResponse(e.target.value)}
          placeholder="Write your full response here (spellcheck disabled as in exam mode)..."
          className="w-full p-4 rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-[var(--bg-elevated)] text-[15px] leading-relaxed text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
        />
      </div>
    </div>
  );
}
