import { memo } from 'react';
import { Archive, Info } from 'lucide-react';
import type { AdminLearnerSummary } from '../../../api';
import type { PoolHealthSummary } from '../../../../shared/bankStatus';
import type { SectionCode } from '../../../../shared/contracts';
import { useI18n } from '../../../i18n';
import { Popover } from '../../ui/Popover';

interface BankMetricsBarProps {
  poolHealth: PoolHealthSummary;
  /** undefined = default learner, null = bank-only catalog mode. */
  monitoredStudentId?: string | null;
  monitoredLearner: AdminLearnerSummary | null;
  masteredCount: number;
  canArchiveMastered: boolean;
  archiving: boolean;
  onArchiveMastered: () => void;
}

const SECTIONS: SectionCode[] = ['READ', 'MATH', 'THINK', 'WRIT'];

function Metric({ label, value, sub, tone = 'text-[#113C36]' }: { label: string; value: string | number; sub?: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <div className="flex items-baseline gap-1.5">
        <span className={`font-serif-display text-[20px] font-bold leading-none tabular-nums ${tone}`}>{value}</span>
        <span className="truncate text-xs text-[#4A5955]">{label}</span>
      </div>
      {sub && <div className="mt-0.5 truncate text-[11px] tabular-nums text-[#615E57]">{sub}</div>}
    </div>
  );
}

/** One-row pool health strip; advice, glossary and the per-section table live in a popover. */
export const BankMetricsBar = memo(function BankMetricsBar({
  poolHealth,
  monitoredStudentId,
  monitoredLearner,
  masteredCount,
  canArchiveMastered,
  archiving,
  onArchiveMastered,
}: BankMetricsBarProps) {
  const { t, sectionShortLabel } = useI18n();
  const catalogMode = monitoredStudentId === null;
  const urgency =
    poolHealth.refreshUrgency === 'refresh_needed'
      ? 'bg-[#FDECEB] text-[#B83A28]'
      : poolHealth.refreshUrgency === 'top_up_soon'
        ? 'bg-[#FDF0E2] text-[#A35116]'
        : 'bg-[#E5F0EA] text-[#113C36]';

  return (
    <section
      aria-label={t('bank.poolHealthTitle')}
      className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-[14px] border border-[#E5DFD5] bg-[#FAF8F5] px-4 py-3"
    >
      <Metric
        label={t('bank.cardInPool')}
        value={poolHealth.liveCount}
        sub={poolHealth.holdoutCount > 0 ? t('bank.cardHoldoutSub', { count: poolHealth.holdoutCount }) : undefined}
      />
      {!catalogMode && (
        <>
          <Metric
            label={t('bank.cardUnseen')}
            value={poolHealth.unseenLiveCount}
            sub={`${poolHealth.unseenLivePercent}%`}
          />
          <Metric
            label={t('bank.cardDone')}
            value={poolHealth.doneLiveCount}
            tone="text-[#1F7A4C]"
            sub={t('bank.cardReviewRepairSub', {
              review: poolHealth.inReviewLiveCount,
              repair: poolHealth.needsRepairLiveCount,
            })}
          />
        </>
      )}
      <Metric label={t('bank.cardPaused')} value={poolHealth.pausedCount} tone="text-[#A35116]" />
      <Metric label={t('bank.cardArchived')} value={poolHealth.archivedCount} tone="text-[#615E57]" />

      <div className="ml-auto flex flex-wrap items-center gap-2">
        <span className={`whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium tabular-nums ${urgency}`}>
          {catalogMode
            ? t('bank.catalogInventoryBadge', { count: poolHealth.liveCount })
            : t('bank.unseenRunwayBadge', {
                pct: poolHealth.unseenLivePercent,
                days: poolHealth.estimatedRunwayDays,
              })}
        </span>
        {canArchiveMastered && masteredCount > 0 && (
          <button
            type="button"
            disabled={archiving}
            onClick={onArchiveMastered}
            className="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[10px] border border-[#CFC6B9] bg-white px-3 py-1.5 font-sans-display text-xs font-semibold text-[#113C36] transition-[background-color,color,transform,translate,scale] duration-150 hover:bg-[#113C36] hover:text-white active:scale-[0.97] disabled:opacity-50"
          >
            <Archive className="h-3.5 w-3.5 shrink-0" />
            <span>{t('bank.archiveMasteredBtn', { count: masteredCount })}</span>
          </button>
        )}
        <Popover
          align="end"
          label={t('bank.metricsDetailsTitle')}
          panelClassName="w-[min(26rem,calc(100vw-2rem))] space-y-4"
          trigger={(props) => (
            <button
              type="button"
              {...props}
              className="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[10px] border border-[#E5DFD5] bg-white px-3 py-1.5 font-sans-display text-xs font-semibold text-[#4A5955] transition-[background-color,color] duration-150 hover:bg-[#F3EFE8] hover:text-[#113C36]"
            >
              <Info className="h-3.5 w-3.5 shrink-0" />
              <span>{t('bank.metricsDetails')}</span>
            </button>
          )}
        >
          <p className="text-xs leading-relaxed text-[#4A5955]">
            {catalogMode ? t('bank.catalogModeAdvice', { total: poolHealth.liveCount }) : poolHealth.refreshAdvice}
          </p>
          {monitoredLearner && !catalogMode && (
            <p className="text-xs font-medium text-[#113C36]">
              {t('bank.learnerRunwayBadge', {
                name: monitoredLearner.displayName || monitoredLearner.email || monitoredLearner.uid,
                pct: poolHealth.unseenLivePercent,
                days: poolHealth.estimatedRunwayDays,
              })}
            </p>
          )}
          <table className="w-full text-left text-xs">
            <caption className="pb-1.5 text-left font-sans-display font-semibold text-[#113C36]">
              {t('bank.bySectionTitle')}
            </caption>
            <tbody className="divide-y divide-[#F2EDE4]">
              {SECTIONS.map((sec) => {
                const row = poolHealth.bySectionLive[sec];
                return (
                  <tr key={sec}>
                    <th scope="row" className="py-1.5 font-medium text-[#4A5955]">
                      {sectionShortLabel(sec)}
                    </th>
                    <td className="py-1.5 text-right tabular-nums text-[#113C36]">
                      {catalogMode ? row.live : `${row.live} / ${row.unseen} / ${row.done}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="space-y-3 border-t border-[#E5DFD5] pt-3 text-xs leading-relaxed text-[#4A5955]">
            <div>
              <div className="font-sans-display font-semibold text-[#113C36]">{t('bank.holdoutGlossaryTitle')}</div>
              <p>{t('bank.holdoutGlossaryBody')}</p>
            </div>
            <div>
              <div className="font-sans-display font-semibold text-[#113C36]">{t('bank.repairGlossaryTitle')}</div>
              <p>{t('bank.repairGlossaryBody')}</p>
            </div>
          </div>
        </Popover>
      </div>
    </section>
  );
});
