import { memo } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, XCircle } from 'lucide-react';
import { useI18n } from '../../i18n';
import type { StudentQuestionView } from '../../../shared/contracts';

export type ReviewFilter = 'all' | 'incorrect' | 'unanswered';
export type ItemStatus = { isCorrect: boolean; hasIncorrect: boolean; hasUnanswered: boolean };

export function matchesReviewFilter(status: ItemStatus | undefined, filter: ReviewFilter): boolean {
  if (!status) return true;
  if (filter === 'incorrect') return status.hasIncorrect;
  if (filter === 'unanswered') return status.hasUnanswered;
  return true;
}

/**
 * Up to ~90 item pills; memoized so typing in the flag form or toggling essay markers
 * does not re-render the whole strip.
 */
export const ReviewItemPills = memo(function ReviewItemPills({
  items,
  questionNumberById,
  itemStatusMap,
  activeQuestionId,
  onSelect,
}: {
  items: StudentQuestionView[];
  questionNumberById: Map<string, number>;
  itemStatusMap: Map<string, ItemStatus>;
  activeQuestionId: string | undefined;
  onSelect: (questionId: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5 max-w-[840px] max-h-[92px] overflow-y-auto pr-1">
      {items.map((q) => {
        const globalNum = questionNumberById.get(q.questionId) ?? 1;
        const st = itemStatusMap.get(q.questionId);
        const isSelected = activeQuestionId === q.questionId;
        return (
          <button
            key={q.questionId}
            type="button"
            onClick={() => onSelect(q.questionId)}
            aria-label={`Review item ${globalNum}${
              st?.hasUnanswered ? ' Unanswered' : st?.hasIncorrect ? ' Incorrect' : ' Correct'
            }`}
            className={`w-9 h-9 inline-flex items-center justify-center rounded-[8px] border text-xs font-sans-display font-semibold tabular-nums cursor-pointer transition-tactile ${
              isSelected
                ? 'border-[#113C36] bg-[#113C36] text-white'
                : st?.hasUnanswered
                  ? 'border-[#A35116]/40 bg-[#FDF0E2] text-[#A35116]'
                  : st?.hasIncorrect
                    ? 'border-[#B42318]/40 bg-[#FDECEB] text-[#B42318]'
                    : 'border-[#1D6346]/35 bg-[#E5F3EC] text-[#1D6346]'
            }`}
          >
            {globalNum}
          </button>
        );
      })}
    </div>
  );
});

/** All / Incorrect / Unanswered segmented filter in the review top rail. */
export function ReviewFilterTabs({
  filter,
  counts,
  onChange,
}: {
  filter: ReviewFilter;
  counts: { all: number; incorrect: number; unanswered: number };
  onChange: (next: ReviewFilter) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-1 p-1 bg-white/75 rounded-[10px] border border-[#E5DFD5]">
      {(
        [
          ['all', t('rev.filterAll', { count: counts.all })],
          ['incorrect', t('rev.filterIncorrect', { count: counts.incorrect })],
          ['unanswered', t('rev.filterUnanswered', { count: counts.unanswered })],
        ] as [ReviewFilter, string][]
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          className={`px-3 py-1 rounded-[8px] text-xs font-sans-display font-semibold cursor-pointer whitespace-nowrap transition-tactile ${
            filter === id ? 'bg-[#113C36] text-white' : 'text-[#4A5955] hover:text-[#113C36]'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Correct / Unanswered / Incorrect chip for the active objective item. */
export function ObjectiveStatusChip({ status }: { status: ItemStatus }) {
  const { t, isZh } = useI18n();
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-semibold ${
        status.isCorrect
          ? 'bg-[#E5F3EC] text-[#1D6346]'
          : status.hasUnanswered
            ? 'bg-[#FDF0E2] text-[#A35116]'
            : 'bg-[#FDECEB] text-[#B42318]'
      }`}
    >
      {status.isCorrect ? (
        <>
          <CheckCircle2 className="w-3.5 h-3.5" />
          <span>{t('ws.correct')}</span>
        </>
      ) : status.hasUnanswered ? (
        <>
          <XCircle className="w-3.5 h-3.5" />
          <span>{t('ws.unanswered')}</span>
        </>
      ) : (
        <>
          <XCircle className="w-3.5 h-3.5" />
          <span>{isZh ? '错题' : 'Incorrect'}</span>
        </>
      )}
    </span>
  );
}

/** Previous / next item buttons under the review workspace. */
export function ReviewPrevNext({
  items,
  activeIndex,
  onSelect,
  className,
}: {
  items: StudentQuestionView[];
  activeIndex: number;
  onSelect: (questionId: string) => void;
  className: string;
}) {
  const { t } = useI18n();
  return (
    <div className={className}>
      <button
        type="button"
        disabled={activeIndex <= 0}
        onClick={() => onSelect(items[activeIndex - 1].questionId)}
        className="px-4 py-2 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#F3EFE8] text-sm font-sans-display font-medium text-[#113C36] inline-flex items-center gap-1.5 disabled:opacity-40 cursor-pointer whitespace-nowrap"
      >
        <ArrowLeft className="w-4 h-4" />
        <span>{t('rev.previousItem')}</span>
      </button>
      <button
        type="button"
        disabled={activeIndex >= items.length - 1}
        onClick={() => onSelect(items[activeIndex + 1].questionId)}
        className="px-4 py-2 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-sm font-sans-display font-semibold inline-flex items-center gap-1.5 disabled:opacity-40 cursor-pointer whitespace-nowrap"
      >
        <span>{t('rev.nextItem')}</span>
        <ArrowRight className="w-4 h-4" />
      </button>
    </div>
  );
}
