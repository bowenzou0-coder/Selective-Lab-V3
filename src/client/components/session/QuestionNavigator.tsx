import { memo } from 'react';
import type { StudentQuestionView } from '../../../shared/contracts';
import { useI18n } from '../../i18n';

interface QuestionNavigatorProps {
  questions: StudentQuestionView[];
  currentIndex: number;
  answersByPartId: Record<string, string | null>;
  flaggedQuestionIds: string[];
  writingResponse: string;
  answeredSlots: number;
  totalSlots: number;
  onGoIndex: (index: number) => void;
}

/** Collapsible grid of question numbers with answered/flagged state. */
export const QuestionNavigator = memo(function QuestionNavigator({
  questions,
  currentIndex,
  answersByPartId,
  flaggedQuestionIds,
  writingResponse,
  answeredSlots,
  totalSlots,
  onGoIndex,
}: QuestionNavigatorProps) {
  const { t } = useI18n();
  const flagged = new Set(flaggedQuestionIds);
  return (
    <div className="border-t border-[#E5DFD5] bg-[#FAF8F5] px-6 py-4">
      <div className="mx-auto max-w-[1440px] space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#4A5955]">
          <span className="font-medium tabular-nums">
            {t('session.slotsAnsweredSummary', { answered: answeredSlots, total: totalSlots, questions: questions.length })}
          </span>
          <div className="flex items-center gap-3 text-[11px] text-[#78756E]">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-xs bg-[#113C36]" /> {t('session.legendCurrent')}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-xs border border-[#1D6346]/50 bg-[#E5F0EA]" /> {t('session.legendAnswered')}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-[#A35116]" /> {t('session.legendFlagged')}
            </span>
          </div>
        </div>
        <div className="flex max-w-[840px] flex-wrap gap-1.5">
          {questions.map((q, idx) => {
            const isCurrent = idx === currentIndex;
            const answered =
              q.formatType === 'WRIT_TYPED_TASK'
                ? writingResponse.trim().length > 0
                : q.parts.every((p) => Boolean(answersByPartId[p.partId]));
            return (
              <button
                key={q.questionId}
                type="button"
                aria-current={isCurrent ? 'step' : undefined}
                aria-label={`${t('session.qOfTotal', { current: idx + 1, total: questions.length })}${
                  flagged.has(q.questionId) ? `, ${t('session.flagged')}` : ''
                }`}
                onClick={() => onGoIndex(idx)}
                className={`relative inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-[8px] border font-sans-display text-xs font-semibold tabular-nums transition-colors ${
                  isCurrent
                    ? 'border-[#113C36] bg-[#113C36] text-white'
                    : answered
                      ? 'border-[#1D6346]/45 bg-[#E5F0EA] text-[#113C36]'
                      : 'border-[#CFC6B9] bg-white text-[#113C36] hover:bg-[#F3EFE8]'
                }`}
              >
                {idx + 1}
                {flagged.has(q.questionId) && (
                  <span aria-hidden="true" className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border border-white bg-[#A35116]" />
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
});
