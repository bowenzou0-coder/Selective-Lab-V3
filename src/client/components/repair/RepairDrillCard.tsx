import { RotateCcw } from 'lucide-react';
import type { BankMasterySummary, SectionCode } from '../../../shared/contracts';
import { useI18n } from '../../i18n';
import { REPAIR_DRILL_CAP } from './repairDrill';
import { useRepairDrillLaunch } from './useRepairDrillLaunch';

const OBJECTIVE_SECTIONS: SectionCode[] = ['READ', 'MATH', 'THINK'];

interface RepairDrillCardProps {
  summary: BankMasterySummary;
  onLaunched: (sessionId: string) => void;
}

/** Progress entry point for "Practise my mistakes": the repair count, a section split and one button. */
export function RepairDrillCard({ summary, onLaunched }: RepairDrillCardProps) {
  const { t, sectionShortLabel } = useI18n();
  const { launch, launching, error } = useRepairDrillLaunch(onLaunched);
  const count = summary.needsRepairCount;
  const hasRepairs = count > 0;
  const lead = !hasRepairs
    ? t('repair.leadNone')
    : count === 1
      ? t('repair.leadOne')
      : t('repair.leadMany', { count });

  return (
    <section
      aria-labelledby="repair-drill-title"
      className="p-5 sm:p-6 rounded-[16px] border border-[#E5DFD5] bg-white flex flex-col md:flex-row md:items-center gap-5"
    >
      <div
        aria-hidden
        className={`shrink-0 w-[68px] h-[68px] rounded-[14px] flex items-center justify-center font-serif-display font-extrabold text-[34px] leading-none tabular-nums ${
          hasRepairs ? 'bg-[#FDF0E2] text-[#A35116]' : 'bg-[#F3EFE8] text-[#78756E]'
        }`}
      >
        {count}
      </div>

      <div className="min-w-0 flex-1 space-y-1.5">
        <h2 id="repair-drill-title" className="font-sans-display font-semibold text-[18px] tracking-[-0.01em] text-[#113C36]">
          {t('repair.title')}
        </h2>
        <p className="text-[13.5px] text-[#4A5955] leading-relaxed max-w-[62ch]">{lead}</p>
        {hasRepairs && (
          <div className="flex flex-wrap items-center gap-1.5 pt-1 text-[11px] tabular-nums">
            {OBJECTIVE_SECTIONS.filter((sec) => summary.bySection[sec].needsRepair > 0).map((sec) => (
              <span key={sec} className="px-2 py-0.5 rounded-full bg-[#F3EFE8] text-[#4A5955] font-medium">
                {t('repair.sectionChip', { section: sectionShortLabel(sec), count: summary.bySection[sec].needsRepair })}
              </span>
            ))}
            {count > REPAIR_DRILL_CAP && (
              <span className="text-[#78756E]">{t('repair.capNote', { cap: REPAIR_DRILL_CAP })}</span>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="text-xs text-[#B42318] pt-1">
            {error}
          </p>
        )}
      </div>

      <button
        type="button"
        disabled={!hasRepairs || launching}
        onClick={() => void launch({ mode: 'repair_drill' })}
        className={`shrink-0 self-start md:self-center inline-flex items-center gap-2 px-4 py-2.5 rounded-[10px] text-sm font-sans-display font-semibold whitespace-nowrap transition-[background-color,transform] duration-150 ease-out ${
          hasRepairs
            ? 'bg-[#113C36] hover:bg-[#0B2B26] text-white cursor-pointer active:scale-[0.98] disabled:opacity-70 disabled:cursor-default'
            : 'bg-[#F3EFE8] text-[#78756E] cursor-default'
        }`}
      >
        <RotateCcw className="w-4 h-4 shrink-0" aria-hidden />
        <span>{launching ? t('repair.starting') : t('repair.startBtn')}</span>
      </button>
    </section>
  );
}
