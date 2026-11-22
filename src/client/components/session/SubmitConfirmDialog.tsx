import { useI18n } from '../../i18n';
import { Sheet } from '../ui/Sheet';

interface SubmitConfirmDialogProps {
  open: boolean;
  submitting: boolean;
  answeredSlots: number;
  totalSlots: number;
  flaggedCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Second step of "Finish test": answered/unanswered/flagged summary, then submit. */
export function SubmitConfirmDialog({
  open,
  submitting,
  answeredSlots,
  totalSlots,
  flaggedCount,
  onCancel,
  onConfirm,
}: SubmitConfirmDialogProps) {
  const { t } = useI18n();
  return (
    <Sheet
      open={open}
      onClose={onCancel}
      variant="center"
      title={t('session.submitModalTitle')}
      description={t('session.submitModalNote')}
      closeLabel={t('session.keepWorking')}
      widthClassName="w-[min(28rem,calc(100vw-2rem))]"
      footer={
        <div className="flex items-center justify-end gap-2.5">
          <button
            type="button"
            disabled={submitting}
            onClick={onCancel}
            className="cursor-pointer rounded-[10px] border border-[#CFC6B9] bg-white px-4 py-2 font-sans-display text-xs font-semibold text-[#4A5955] hover:bg-[#FAF8F5] disabled:opacity-50"
          >
            {t('session.keepWorking')}
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={onConfirm}
            className="cursor-pointer rounded-[10px] bg-[#113C36] px-5 py-2 font-sans-display text-xs font-semibold text-white transition-[background-color,transform] duration-150 hover:bg-[#0B2B26] active:scale-[0.97] disabled:opacity-60"
          >
            {submitting ? t('session.submitting') : t('session.confirmAndSubmit')}
          </button>
        </div>
      }
    >
      <dl className="grid grid-cols-3 gap-2.5 rounded-[12px] border border-[#E5DFD5] bg-white p-3.5 text-center text-xs tabular-nums">
        <div>
          <dt className="text-[#78756E]">{t('session.answered')}</dt>
          <dd className="mt-1 font-serif-display text-xl font-extrabold text-[#1D6346]">
            {answeredSlots}/{totalSlots}
          </dd>
        </div>
        <div>
          <dt className="text-[#78756E]">{t('session.unanswered')}</dt>
          <dd className="mt-1 font-serif-display text-xl font-extrabold text-[#113C36]">
            {Math.max(0, totalSlots - answeredSlots)}
          </dd>
        </div>
        <div>
          <dt className="text-[#78756E]">{t('session.flagged')}</dt>
          <dd className="mt-1 font-serif-display text-xl font-extrabold text-[#A35116]">{flaggedCount}</dd>
        </div>
      </dl>
    </Sheet>
  );
}
