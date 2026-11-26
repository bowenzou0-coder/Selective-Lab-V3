import type { DashboardResponse } from '../../api';
import { useI18n, type MessageKey } from '../../i18n';
import type { SectionCode, SessionMode } from '../../../shared/contracts';
import { SectionThumbnail } from '../StudioIllustrations';
import type { PendingLaunchSpec } from './launchSpec';

export type DrillCountSection = 'READ' | 'MATH' | 'THINK';
export type DrillCounts = Record<DrillCountSection, number>;

export interface SectionDrill {
  code: SectionCode;
  labelKey: MessageKey;
  detailKey: MessageKey;
  mode: SessionMode;
}

export const SECTION_DRILLS: SectionDrill[] = [
  { code: 'READ', labelKey: 'section.READ', detailKey: 'home.drillREADDetail', mode: 'section_drill' },
  { code: 'MATH', labelKey: 'section.MATH', detailKey: 'home.drillMATHDetail', mode: 'section_drill' },
  { code: 'THINK', labelKey: 'section.THINK', detailKey: 'home.drillTHINKDetail', mode: 'section_drill' },
  { code: 'WRIT', labelKey: 'home.modalWritingTitle', detailKey: 'home.drillWRITDetail', mode: 'writing_sprint' },
];

export function drillCountsFrom(data: DashboardResponse | null): DrillCounts {
  const count = data?.sectionDrillQuestionCount || 10;
  return { READ: count, MATH: count, THINK: count };
}

/** Question count and minutes for a drill; minutes scale with the learner's configured default pace. */
export function resolveDrillSize(
  drill: SectionDrill,
  drillCounts: DrillCounts,
  data: DashboardResponse | null
): { qCount: number; mins: number } {
  const defaultCount = data?.sectionDrillQuestionCount ?? 10;
  const defaultMins = data?.sectionDrillTimeMinutes ?? 8;
  const qCount = drill.code === 'WRIT' ? 1 : drillCounts[drill.code as DrillCountSection] ?? defaultCount;
  const mins =
    drill.code === 'WRIT' ? 30 : Math.max(4, Math.round((defaultMins * qCount) / Math.max(1, defaultCount)));
  return { qCount, mins };
}

type Translate = ReturnType<typeof useI18n>['t'];

export function buildDrillLaunchSpec(
  drill: SectionDrill,
  drillCounts: DrillCounts,
  data: DashboardResponse | null,
  t: Translate,
  isZh: boolean
): PendingLaunchSpec {
  const { qCount, mins: min } = resolveDrillSize(drill, drillCounts, data);
  return {
    key: `drill_${drill.code}`,
    title:
      drill.code === 'WRIT'
        ? t('home.modalWritingTitle')
        : t('home.modalDrillTitle', { section: t(drill.labelKey) }),
    questionCountLabel:
      drill.code === 'WRIT'
        ? t('home.modalWritingCount')
        : qCount === 1 && !isZh
          ? '1 question'
          : t('home.modalDrillCount', { count: qCount }),
    durationLabel: t('home.modalMinutesLabel', { min }),
    payload: {
      mode: drill.mode,
      sectionFilter: drill.code,
      questionCount: drill.code === 'WRIT' ? 1 : qCount,
      customTimeLimitSec: drill.code === 'WRIT' ? undefined : min * 60,
    },
  };
}

interface PracticeDrillsListProps {
  data: DashboardResponse | null;
  drillCounts: DrillCounts;
  launching: string | null;
  onChangeCount: (section: DrillCountSection, count: number) => void;
  onRequestDrill: (drill: SectionDrill) => void;
}

/** Hairline-divided section drills with a 5/10/15 question picker per objective section. */
export function PracticeDrillsList({ data, drillCounts, launching, onChangeCount, onRequestDrill }: PracticeDrillsListProps) {
  const { t } = useI18n();
  return (
    <section id="practice-drills" data-tour="section-drills" className="space-y-4 scroll-mt-6">
      <div className="space-y-1">
        <h2 className="font-sans-display font-semibold text-[24px] sm:text-[26px] tracking-[-0.02em] text-[#113C36] leading-tight">
          {t('home.drillsTitle')}
        </h2>
        <p className="text-[14px] text-[#4A5955]">
          {t('home.sectionDrillsLead')}
        </p>
      </div>

      <div className="border-t border-b border-[#E5DFD5] divide-y divide-[#E5DFD5]">
        {SECTION_DRILLS.map((drill) => {
          const { qCount, mins } = resolveDrillSize(drill, drillCounts, data);
          const drillLabel = t(drill.labelKey);
          return (
            <div
              key={drill.code}
              className="py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 group"
            >
              <div className="flex items-center gap-3.5 min-w-0">
                <SectionThumbnail kind={drill.code} />
                <div className="min-w-0">
                  <div className="font-sans-display font-semibold text-[16px] text-[#113C36]">
                    {drillLabel}
                  </div>
                  <p className="text-[13.5px] text-[#4A5955] truncate sm:whitespace-normal">
                    {t(drill.detailKey)}
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-between sm:justify-end gap-2.5 shrink-0 pl-[50px] sm:pl-0">
                {drill.code !== 'WRIT' ? (
                  <div
                    className="inline-flex items-center rounded-full bg-[#F3EFE8] p-0.5 text-xs"
                    role="group"
                    aria-label={drillLabel}
                  >
                    {[5, 10, 15].map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => onChangeCount(drill.code as DrillCountSection, n)}
                        className={`px-2 py-0.5 rounded-full font-medium tabular-nums cursor-pointer transition-colors ${
                          qCount === n
                            ? 'bg-white text-[#113C36] shadow-[0_1px_2px_rgba(17,60,54,0.08)]'
                            : 'text-[#4A5955] hover:text-[#113C36]'
                        }`}
                      >
                        {n}q
                      </button>
                    ))}
                  </div>
                ) : (
                  <span className="px-2.5 py-1 rounded-full bg-[#F3EFE8] text-xs font-medium text-[#4A5955] whitespace-nowrap">
                    {t('home.oneTask')}
                  </span>
                )}
                <span className="px-2.5 py-1 rounded-full bg-[#F3EFE8] text-xs font-medium text-[#4A5955] tabular-nums whitespace-nowrap">
                  {t('home.minShort', { min: mins })}
                </span>
                <button
                  type="button"
                  disabled={launching !== null}
                  onClick={() => onRequestDrill(drill)}
                  className="px-3.5 py-2 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#113C36] hover:text-white hover:border-[#113C36] text-xs font-sans-display font-semibold text-[#113C36] transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
                >
                  {t('home.startDrill')}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
