import { useI18n } from '../../i18n';
import { ConfirmDialog } from '../ui/ConfirmDialog';

interface SubmitConfirmDialogProps {
  open: boolean;
  submitting: boolean;
  answeredSlots: number;
  totalSlots: number;
  flaggedCount: number;
  titleOverride?: string;
  descriptionOverride?: string;
  confirmLabelOverride?: string;
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
  titleOverride,
  descriptionOverride,
  confirmLabelOverride,
  onCancel,
  onConfirm,
}: SubmitConfirmDialogProps) {
  const { t } = useI18n();
  return (
    <ConfirmDialog
      open={open}
      onClose={onCancel}
      onConfirm={onConfirm}
      busy={submitting}
      title={titleOverride || t('session.submitModalTitle')}
      description={descriptionOverride || t('session.submitModalNote')}
      cancelLabel={t('session.keepWorking')}
      confirmLabel={submitting ? t('session.submitting') : confirmLabelOverride || t('session.confirmAndSubmit')}
      widthClassName="max-w-[28rem]"
    >
      <dl className="grid grid-cols-3 gap-2.5 rounded-[12px] border border-[#E5DFD5] bg-[#FAF8F5] p-3.5 text-center text-xs tabular-nums">
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
    </ConfirmDialog>
  );
}
