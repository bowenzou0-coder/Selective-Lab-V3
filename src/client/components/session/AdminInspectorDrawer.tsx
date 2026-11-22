import { memo } from 'react';
import { Archive, CheckCircle2, PauseCircle } from 'lucide-react';
import { poolStatusToQcStatus, qcStatusToPoolStatus, type BankPoolStatus } from '../../../shared/bankStatus';
import type { QuestionItem } from '../../../shared/contracts';
import { useI18n } from '../../i18n';
import { FormattedText } from '../FormattedText';
import { Sheet } from '../ui/Sheet';

interface AdminInspectorDrawerProps {
  open: boolean;
  onClose: () => void;
  question?: QuestionItem;
  activePartIndex: number;
  onSelectPart: (index: number) => void;
  onSetQcStatus: (questionId: string, qcStatus: QuestionItem['qcStatus']) => void;
  statusBusy: boolean;
}

const STATUSES: { status: BankPoolStatus; icon: typeof CheckCircle2 }[] = [
  { status: 'live', icon: CheckCircle2 },
  { status: 'paused', icon: PauseCircle },
  { status: 'archived', icon: Archive },
];

/**
 * Non-modal slide-over for admin calibration runs: answer key, collapsible explanation and
 * one-click pool status, while the question stays fully usable beside it.
 */
export const AdminInspectorDrawer = memo(function AdminInspectorDrawer({
  open,
  onClose,
  question,
  activePartIndex,
  onSelectPart,
  onSetQcStatus,
  statusBusy,
}: AdminInspectorDrawerProps) {
  const { t, skillName, poolStatusLabel } = useI18n();
  const partIdx = question ? Math.min(Math.max(0, activePartIndex), Math.max(0, question.parts.length - 1)) : 0;
  const part = question?.parts[partIdx];
  const pool = question ? qcStatusToPoolStatus(question.qcStatus) : null;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      modal={false}
      title={t('session.inspectorTitle')}
      description={t('session.inspectorDesc')}
      closeLabel={t('common.close')}
      widthClassName="w-[min(24rem,100vw)]"
    >
      {!question || !part ? (
        <p className="text-xs text-[#78756E]">{t('session.inspectorNoData')}</p>
      ) : (
        <div className="space-y-5 text-xs">
          <div className="space-y-1">
            <div className="break-all font-mono-code font-semibold text-[#113C36]">{question.questionId}</div>
            <div className="text-[#78756E]">
              {question.poolType} · {question.qcStatus}
              {question.provenance?.sourceReference ? ` · ${question.provenance.sourceReference}` : ''}
            </div>
          </div>

          <section className="space-y-2">
            <h3 className="font-sans-display font-semibold text-[#113C36]">{t('session.inspectorStatus')}</h3>
            <div role="group" aria-label={t('session.inspectorStatus')} className="flex flex-wrap gap-1.5">
              {STATUSES.map(({ status, icon: Icon }) => {
                const active = pool === status;
                return (
                  <button
                    key={status}
                    type="button"
                    aria-pressed={active}
                    disabled={statusBusy || active}
                    onClick={() => onSetQcStatus(question.questionId, poolStatusToQcStatus(status))}
                    className={`inline-flex cursor-pointer items-center gap-1.5 rounded-[9px] border px-2.5 py-1.5 font-sans-display font-semibold transition-[background-color,color,transform] duration-150 active:scale-[0.97] disabled:cursor-default ${
                      active ? 'border-[#113C36] bg-[#113C36] text-white' : 'border-[#CFC6B9] bg-white text-[#113C36] hover:bg-[#F3EFE8] disabled:opacity-50'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    <span>{poolStatusLabel(status)}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="font-sans-display font-semibold text-[#113C36]">{t('ws.answerKeyLabel')}</h3>
            <div className="flex flex-wrap gap-1.5">
              {question.parts.map((p, idx) => (
                <button
                  key={p.partId}
                  type="button"
                  aria-pressed={idx === partIdx}
                  onClick={() => onSelectPart(idx)}
                  className={`cursor-pointer rounded-[8px] border px-2 py-1 text-left transition-colors ${
                    idx === partIdx ? 'border-[#113C36] bg-[#E5F0EA] text-[#113C36]' : 'border-[#E5DFD5] bg-white text-[#4A5955] hover:bg-[#FAF8F5]'
                  }`}
                >
                  {question.parts.length > 1 && <span className="mr-1 text-[#78756E]">{t('ws.partLabel', { num: idx + 1 })}</span>}
                  <span className="font-mono-code font-semibold">{p.correctAnswerKey || t('bank.writingRubricBadge')}</span>
                </button>
              ))}
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[#4A5955]">
              <dt className="text-[#78756E]">{t('bank.partSkillLabel')}</dt>
              <dd>{skillName(part.skillId)}</dd>
              <dt className="text-[#78756E]">{t('bank.partDifficultyLabel')}</dt>
              <dd className="tabular-nums">
                {part.difficultyCalibrated ?? part.difficultyInitial} · {t('bank.partTargetTime', { sec: part.targetTimeSec })}
              </dd>
            </dl>
          </section>

          {part.workedExplanation && (
            <details className="group rounded-[12px] border border-[#E5DFD5] bg-white">
              <summary className="cursor-pointer list-none px-3.5 py-2.5 font-sans-display font-semibold text-[#113C36] [&::-webkit-details-marker]:hidden">
                <span className="group-open:hidden">{t('session.showExplanation')}</span>
                <span className="hidden group-open:inline">{t('session.hideExplanation')}</span>
              </summary>
              <div className="border-t border-[#E5DFD5] px-3.5 py-3">
                <FormattedText text={part.workedExplanation} variant="explanation" />
              </div>
            </details>
          )}
        </div>
      )}
    </Sheet>
  );
});
