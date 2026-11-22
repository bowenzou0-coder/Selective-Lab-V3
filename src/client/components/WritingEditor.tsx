import { useMemo, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, AlertCircle } from 'lucide-react';
import { useI18n } from '../i18n';
import type { StudentQuestionView } from '../../shared/contracts';
import { computeWritingMetrics } from '../../shared/engine';
import { FormattedText } from './FormattedText';
import { VisualRenderer } from './VisualRenderer';

interface WritingEditorProps {
  question: StudentQuestionView;
  planNotes: string;
  responseText: string;
  onChangePlan: (val: string) => void;
  onChangeResponse: (val: string) => void;
}

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
}: WritingEditorProps) {
  const { t } = useI18n();
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

      {/* Mandatory Starter Status & Word Counter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2 tabular-nums text-[#4A5955]">
          <span className="px-2.5 py-1 rounded-full bg-white border border-[#E5DFD5]">
            <strong className="text-[#113C36]">{metrics.wordCount}</strong> {t('writ.words')}{' '}
            <span className="text-[#78756E]">{t('writ.targetRange', { min: minW, max: maxW })}</span>
          </span>
          <span className="px-2.5 py-1 rounded-full bg-white border border-[#E5DFD5]">
            {metrics.paragraphCount} {metrics.paragraphCount === 1 ? t('writ.paragraph') : t('writ.paragraphs')}
          </span>
        </div>

        {spec.mandatoryOpeningLine && (
          <div
            className={`inline-flex items-center gap-1.5 font-medium ${
              metrics.matchedMandatoryStarter
                ? 'text-[#1D6346]'
                : 'text-[#A35116]'
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
