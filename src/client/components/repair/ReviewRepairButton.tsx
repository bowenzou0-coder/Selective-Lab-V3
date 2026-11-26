import { useId, useMemo } from 'react';
import { RotateCcw } from 'lucide-react';
import type { MarkingResult } from '../../../shared/contracts';
import { useI18n } from '../../i18n';
import { collectMissedObjectiveQuestionIds, planReviewRepairDrill, repairDrillPayload } from './repairDrill';
import { useRepairDrillLaunch } from './useRepairDrillLaunch';

interface ReviewRepairButtonProps {
  sessionMode?: string;
  questions: readonly { questionId: string; formatType: string }[];
  reviewResults: Record<string, readonly MarkingResult[]>;
  onLaunched: (sessionId: string) => void;
}

/**
 * One-click retry of the questions missed in this review. Benchmark reviews fall back to the
 * learner's wider repair pool and say so under the button.
 */
export function ReviewRepairButton({ sessionMode, questions, reviewResults, onLaunched }: ReviewRepairButtonProps) {
  const { t } = useI18n();
  const noteId = useId();
  const plan = useMemo(
    () =>
      planReviewRepairDrill({
        sessionMode,
        missedQuestionIds: collectMissedObjectiveQuestionIds(questions, reviewResults),
      }),
    [sessionMode, questions, reviewResults]
  );
  const { launch, launching, error } = useRepairDrillLaunch(onLaunched);
  if (!plan) return null;

  const label = launching
    ? t('repair.starting')
    : plan.kind === 'session'
      ? t('repair.reviewBtn', { count: plan.count })
      : t('repair.startBtn');
  const note = plan.kind === 'session' ? t('repair.reviewSessionNote') : t('repair.reviewPoolNote');

  return (
    <div className="flex flex-col items-start gap-1 lg:items-end">
      <button
        type="button"
        disabled={launching}
        aria-describedby={noteId}
        title={note}
        onClick={() => void launch(repairDrillPayload(plan))}
        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-[10px] border border-[#A35116]/30 bg-[#FDF0E2] hover:bg-[#FBE5CF] text-xs font-sans-display font-semibold text-[#7A3D10] cursor-pointer whitespace-nowrap transition-[background-color,transform,translate,scale] duration-150 ease-out active:scale-[0.98] disabled:opacity-60 disabled:cursor-default"
      >
        <RotateCcw className="w-3.5 h-3.5 shrink-0" aria-hidden />
        <span>{label}</span>
      </button>
      <span id={noteId} className={plan.kind === 'pool' ? 'text-[11px] text-[#615E57]' : 'sr-only'}>
        {note}
      </span>
      {error && (
        <span role="alert" className="text-[11px] text-[#B42318]">
          {error}
        </span>
      )}
    </div>
  );
}
