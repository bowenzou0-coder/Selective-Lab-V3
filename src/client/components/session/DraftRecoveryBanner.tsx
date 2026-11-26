import { useI18n } from '../../i18n';

interface DraftRecoveryBannerProps {
  savedAtMs: number;
  onRestore: () => void;
  onDiscard: () => void;
}

/** Offers to restore answers saved on this device that never reached the server. */
export function DraftRecoveryBanner({ savedAtMs, onRestore, onDiscard }: DraftRecoveryBannerProps) {
  const { t, isZh } = useI18n();
  return (
    <div className="border-b border-[#A35116]/25 bg-[#FDF0E2] px-6 py-2.5">
      <div className="max-w-[1440px] mx-auto flex flex-wrap items-center justify-between gap-3 text-xs text-[#A35116]">
        <span>
          {t('session.localDraftFound', {
            time: new Date(savedAtMs).toLocaleTimeString(isZh ? 'zh-CN' : 'en-AU'),
          })}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onRestore}
            className="px-3 py-1 rounded-[8px] bg-[#113C36] text-white font-sans-display font-semibold cursor-pointer whitespace-nowrap"
          >
            {t('session.restoreDraft')}
          </button>
          <button
            type="button"
            onClick={onDiscard}
            className="px-3 py-1 rounded-[8px] border border-[#A35116] font-sans-display font-semibold cursor-pointer whitespace-nowrap"
          >
            {t('session.discardDraft')}
          </button>
        </div>
      </div>
    </div>
  );
}

interface CheckpointConflictBannerProps {
  currentRevision: number;
  onLoadServer: () => void;
  onKeepDevice: () => void;
}

/** Optimistic-concurrency (409) resolution: take the server copy or overwrite it with this device. */
export function CheckpointConflictBanner({ currentRevision, onLoadServer, onKeepDevice }: CheckpointConflictBannerProps) {
  const { t } = useI18n();
  return (
    <div role="alert" className="border-b border-[#B42318]/25 bg-[#FDECEB] px-6 py-2.5">
      <div className="max-w-[1440px] mx-auto flex flex-wrap items-center justify-between gap-3 text-xs text-[#B42318]">
        <span>{t('session.conflictBanner', { rev: currentRevision })}</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onLoadServer}
            className="px-3 py-1 rounded-[8px] bg-[#113C36] text-white font-sans-display font-semibold cursor-pointer whitespace-nowrap"
          >
            {t('session.loadLatestServer')}
          </button>
          <button
            type="button"
            onClick={onKeepDevice}
            className="px-3 py-1 rounded-[8px] border border-[#B42318] font-sans-display font-semibold cursor-pointer whitespace-nowrap"
          >
            {t('session.keepDeviceAnswers')}
          </button>
        </div>
      </div>
    </div>
  );
}
