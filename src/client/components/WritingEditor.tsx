import { memo, useMemo, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, AlertCircle } from 'lucide-react';
import { useI18n } from '../i18n';
import type { StudentQuestionView, WritingTaskSpec } from '../../shared/contracts';
import { computeWritingMetrics } from '../../shared/engine';
import { useClockValue, type SessionClock } from '../sessionClock';
import { FormattedText } from './FormattedText';
import { VisualRenderer } from './VisualRenderer';
import {
  DEFAULT_WORD_RANGE,
  resolveWordRange,
  wordRangeProgress,
  writingPacing,
  type PacingPhase,
  type PacingTone,
  type WordRange,
  type WordRangeState,
} from './writing/writingInsights';

interface WritingEditorProps {
  question: StudentQuestionView;
  planNotes: string;
  responseText: string;
  onChangePlan: (val: string) => void;
  onChangeResponse: (val: string) => void;
  /** Exam clock for the pacing note; omitted outside a live exam. */
  clock?: SessionClock;
}

const RANGE_FILL: Record<WordRangeState, string> = {
  empty: 'bg-transparent',
  building: 'bg-[#8FB3A3]',
  in_target: 'bg-[#1D6346]',
  over: 'bg-[#F29A63]',
};

const RANGE_TEXT: Record<WordRangeState, string> = {
  empty: 'text-[#615E57]',
  building: 'text-[#4A5955]',
  in_target: 'text-[#1D6346]',
  over: 'text-[#A35116]',
};

/** Thin bar against the prompt's word range: the shaded band is the target, the fill is the draft. */
function WordRangeMeter({ wordCount, range }: { wordCount: number; range: WordRange }) {
  const { t } = useI18n();
  const p = wordRangeProgress(wordCount, range);
  const label =
    p.state === 'empty'
      ? t('writ.rangeEmpty', { min: range.min, max: range.max })
      : p.state === 'building'
        ? t('writ.rangeBuilding', { count: p.wordsToMin })
        : p.state === 'in_target'
          ? t('writ.rangeInTarget')
          : t('writ.rangeOver', { count: p.wordsOver });
  return (
    <div className="space-y-1.5">
      <div
        role="meter"
        aria-label={t('writ.progressAria')}
        aria-valuemin={0}
        aria-valuemax={range.max}
        aria-valuenow={Math.min(wordCount, range.max)}
        aria-valuetext={`${wordCount} ${t('writ.words')}. ${label}`}
        className="relative h-1.5 w-full overflow-hidden rounded-full bg-[#ECE8E1]"
      >
        <div
          aria-hidden
          className="absolute inset-y-0 bg-[#D4E4DC]"
          style={{ left: `${p.minPct}%`, width: `${Math.max(0, p.maxPct - p.minPct)}%` }}
        />
        <div
          aria-hidden
          className={`absolute inset-y-0 left-0 rounded-full transition-[width,background-color] duration-300 ease-out motion-reduce:transition-none ${RANGE_FILL[p.state]}`}
          style={{ width: `${p.fillPct}%` }}
        />
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs tabular-nums">
        <span className="text-[#4A5955]">
          <strong className="font-semibold text-[#113C36]">{wordCount}</strong> {t('writ.words')}{' '}
          <span className="text-[#615E57]">{t('writ.targetRange', { min: range.min, max: range.max })}</span>
        </span>
        <span className={RANGE_TEXT[p.state]}>{label}</span>
      </div>
    </div>
  );
}

const PACE_DOT: Record<PacingTone, string> = {
  steady: 'bg-[#1D6346]',
  ahead: 'bg-[#1D6346]',
  building: 'bg-[#B9B2A6]',
};

/** Calm pacing read; re-renders every 15 s of exam time, not every tick. */
const PacingNote = memo(function PacingNote({
  clock,
  wordCount,
  range,
  fallbackTotalSec,
}: {
  clock: SessionClock;
  wordCount: number;
  range: WordRange;
  fallbackTotalSec?: number;
}) {
  const { t } = useI18n();
  const bucket = useClockValue(clock, (c) => Math.floor(c.getElapsedSec() / 15));
  const elapsedSec = bucket * 15;
  const remaining = clock.getRemainingSec();
  const totalSec = remaining !== null ? clock.getElapsedSec() + remaining : fallbackTotalSec;
  const pace = writingPacing({ elapsedSec, totalSec, wordCount, range });
  if (pace.phase === 'untimed') return null;
  const labelByPhase: Record<Exclude<PacingPhase, 'untimed'>, string> = {
    planning: t('writ.pacePlanning'),
    drafting:
      pace.tone === 'ahead' ? t('writ.paceAhead') : pace.tone === 'building' ? t('writ.paceBuilding') : t('writ.paceSteady'),
    reviewing: t('writ.paceReviewing'),
  };
  const dot = pace.phase === 'planning' ? 'bg-[#4A5955]' : pace.phase === 'reviewing' ? 'bg-[#E9A56F]' : PACE_DOT[pace.tone];
  return (
    <span className="inline-flex items-center gap-1.5 text-[#4A5955]" aria-label={`${t('writ.paceAria')}: ${labelByPhase[pace.phase]}`}>
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      <span aria-hidden>{labelByPhase[pace.phase]}</span>
    </span>
  );
});

export function WritingStimulusPane({ question }: { question: StudentQuestionView }) {
  const { t } = useI18n();
  const stim = question.stimulus;
  const spec = question.writingSpec;
  const bodyMarkdown =
    stim?.mainTextMarkdown?.trim() || question.parts[0]?.promptText?.trim() || '';

  return (
    <div className="space-y-5 max-w-[65ch]">
      <div className="pb-3.5 border-b border-[#E5DFD5]">
        <h2 className="font-serif-display font-bold text-[22px] tracking-[-0.015em] text-[#113C36]">
          {stim?.title || t('writ.defaultTitle')}
        </h2>
        {spec && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="px-2.5 py-0.5 rounded-full bg-[#F3EFE8] text-[#4A5955] font-medium capitalize">
              {spec.genre.replace(/_/g, ' ')}
            </span>
            <span className="px-2.5 py-0.5 rounded-full bg-[#F3EFE8] text-[#4A5955]">
              {t('writ.audience', { audience: spec.audience })}
            </span>
            <span className="px-2.5 py-0.5 rounded-full bg-[#F3EFE8] text-[#4A5955]">
              {t('writ.purpose', { purpose: spec.purpose })}
            </span>
          </div>
        )}
      </div>

      {bodyMarkdown && (
        <FormattedText text={bodyMarkdown} variant="prose" />
      )}

      {spec?.bulletSuggestions && spec.bulletSuggestions.length > 0 && (
        <div className="p-4 rounded-[12px] bg-[#FAF8F5] border border-[#E5DFD5] space-y-2">
          <div className="text-xs font-sans-display font-semibold text-[#4A5955]">
            {t('writ.ideasToConsider')}
          </div>
          <ul className="list-disc pl-5 space-y-1.5 text-sm text-[#113C36]">
            {spec.bulletSuggestions.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </div>
      )}

      {spec?.mandatoryOpeningLine && (
        <div className="p-4 rounded-[12px] bg-[#FDF1E7] border border-[#EAB690]/70 space-y-1.5">
          <div className="text-xs font-sans-display font-semibold text-[#113C36]">
            {t('writ.requiredOpeningLine')}
          </div>
          <p className="font-serif-text text-[16px] text-[#113C36] italic leading-relaxed">
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
  clock,
}: WritingEditorProps) {
  const { t } = useI18n();
  const [planOpen, setPlanOpen] = useState(true);
  const spec: WritingTaskSpec = question.writingSpec || {
    genre: 'essay',
    audience: 'General',
    purpose: 'Inform',
    recommendedWordRange: [DEFAULT_WORD_RANGE[0], DEFAULT_WORD_RANGE[1]],
    timeLimitSec: 1800,
  };

  const metrics = useMemo(() => computeWritingMetrics(spec, responseText), [spec, responseText]);
  const range = useMemo(() => resolveWordRange(spec.recommendedWordRange), [spec.recommendedWordRange]);

  return (
    <div className="space-y-4">
      {/* Collapsible Scratchpad Plan */}
      <div className="border border-[#E5DFD5] rounded-[12px] bg-[#F3EFE8]/70">
        <button
          type="button"
          onClick={() => setPlanOpen((v) => !v)}
          aria-expanded={planOpen}
          className="w-full px-4 py-2.5 flex items-center justify-between text-xs font-sans-display font-semibold text-[#113C36] cursor-pointer"
        >
          <span>{t('writ.scratchpadTitle')}</span>
          {planOpen ? <ChevronDown className="w-4 h-4 text-[#4A5955]" /> : <ChevronRight className="w-4 h-4 text-[#4A5955]" />}
        </button>
        {planOpen && (
          <div className="px-4 pb-3.5">
            <textarea
              aria-label={t('writ.scratchpadTitle')}
              rows={3}
              spellCheck={false}
              value={planNotes}
              onChange={(e) => onChangePlan(e.target.value)}
              placeholder={t('writ.scratchpadPlaceholder')}
              className="w-full p-3 rounded-[10px] border border-[#E5DFD5] bg-white text-sm text-[#113C36] focus:outline-none focus:border-[#113C36]"
            />
          </div>
        )}
      </div>

      {/* Quiet status bar: word range, paragraphs, pacing and the required opening line */}
      <div className="space-y-2.5 rounded-[12px] border border-[#E5DFD5] bg-white px-4 py-3">
        <WordRangeMeter wordCount={metrics.wordCount} range={range} />
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 text-xs">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 tabular-nums text-[#4A5955]">
            <span>
              {metrics.paragraphCount} {metrics.paragraphCount === 1 ? t('writ.paragraph') : t('writ.paragraphs')}
            </span>
            {clock && (
              <PacingNote
                clock={clock}
                wordCount={metrics.wordCount}
                range={range}
                fallbackTotalSec={spec.timeLimitSec}
              />
            )}
          </div>

          {spec.mandatoryOpeningLine && (
            <div
              className={`inline-flex items-center gap-1.5 font-medium ${
                metrics.matchedMandatoryStarter ? 'text-[#1D6346]' : 'text-[#A35116]'
              }`}
            >
              {metrics.matchedMandatoryStarter ? (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>{t('writ.openingMatched')}</span>
                </>
              ) : (
                <>
                  <AlertCircle className="w-3.5 h-3.5" />
                  <span>{t('writ.openingRequired')}</span>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Plain Text Writing Editor (spellCheck disabled per NSW CBT rules) */}
      <div>
        <label htmlFor="writing-response-editor" className="sr-only">
          {t('writ.defaultTitle')}
        </label>
        <textarea
          id="writing-response-editor"
          rows={15}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          value={responseText}
          onChange={(e) => onChangeResponse(e.target.value)}
          placeholder={t('writ.responsePlaceholder')}
          className="w-full p-5 rounded-[12px] border border-[#CFC6B9] bg-white font-serif-text text-[16px] leading-[1.7] text-[#113C36] focus:outline-none focus:border-[#113C36]"
        />
      </div>
    </div>
  );
}
