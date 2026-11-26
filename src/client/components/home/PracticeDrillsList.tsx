import type { DashboardResponse } from '../../api';
import { useI18n, type MessageKey } from '../../i18n';
import type { DifficultyPreset, SectionCode, SessionMode } from '../../../shared/contracts';
import { SectionThumbnail } from '../StudioIllustrations';
import { NumericInput } from '../ui/NumericInput';
import { SegmentedControl } from '../ui/SegmentedControl';
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

/** Question count, live cap, and minutes for a drill; minutes scale with the learner's configured default pace. */
export function resolveDrillSize(
  drill: SectionDrill,
  drillCounts: DrillCounts,
  data: DashboardResponse | null
): { qCount: number; maxCount: number; mins: number } {
  const defaultCount = data?.sectionDrillQuestionCount ?? 10;
  const defaultMins = data?.sectionDrillTimeMinutes ?? 8;
  const liveCount = data?.poolCounts ? data.poolCounts[drill.code].live : null;
  if (drill.code === 'WRIT') {
    const qCount = liveCount === 0 ? 0 : 1;
    return { qCount, maxCount: qCount, mins: qCount === 0 ? 0 : 30 };
  }
  const maxCount = liveCount !== null ? Math.min(40, Math.max(0, liveCount)) : 40;
  const requested = drillCounts[drill.code as DrillCountSection] ?? defaultCount;
  const qCount = maxCount === 0 ? 0 : Math.min(maxCount, Math.max(1, requested));
  const mins =
    qCount === 0
      ? 0
      : Math.max(4, Math.round((defaultMins * qCount) / Math.max(1, defaultCount)));
  return { qCount, maxCount, mins };
}

type Translate = ReturnType<typeof useI18n>['t'];

export function buildDrillLaunchSpec(
  drill: SectionDrill,
  drillCounts: DrillCounts,
  data: DashboardResponse | null,
  t: Translate,
  isZh: boolean,
  difficulty: DifficultyPreset = 'medium'
): PendingLaunchSpec {
  const { qCount, mins: min } = resolveDrillSize(drill, drillCounts, data);
  const diffLabel =
    difficulty === 'easy'
      ? t('home.diffEasy')
      : difficulty === 'hard'
        ? t('home.diffHard')
        : t('home.diffMedium');
  return {
    key: `drill_${drill.code}`,
    title:
      drill.code === 'WRIT'
        ? t('home.modalWritingTitle')
        : `${t('home.modalDrillTitle', { section: t(drill.labelKey) })} (${diffLabel})`,
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
      ...(drill.code === 'WRIT' ? {} : { difficulty }),
      questionCount: drill.code === 'WRIT' ? 1 : qCount,
      customTimeLimitSec: drill.code === 'WRIT' ? undefined : min * 60,
    },
  };
}

interface PracticeDrillsListProps {
  data: DashboardResponse | null;
  drillCounts: DrillCounts;
  difficulty: DifficultyPreset;
  launching: string | null;
  onChangeCount: (section: DrillCountSection, count: number) => void;
  onChangeDifficulty: (difficulty: DifficultyPreset) => void;
  onRequestDrill: (drill: SectionDrill) => void;
}

/** Hairline-divided section drills with a 5/10/15 question picker and blended difficulty selector. */
export function PracticeDrillsList({
  data,
  drillCounts,
  difficulty,
  launching,
  onChangeCount,
  onChangeDifficulty,
  onRequestDrill,
}: PracticeDrillsListProps) {
  const { t } = useI18n();
  return (
    <section id="practice-drills" data-tour="section-drills" className="space-y-4 scroll-mt-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div className="space-y-1">
          <h2 className="font-sans-display font-semibold text-[24px] sm:text-[26px] tracking-[-0.02em] text-[#113C36] leading-tight">
            {t('home.drillsTitle')}
          </h2>
          <p className="text-[14px] text-[#4A5955]">
            {t('home.sectionDrillsLead')}
          </p>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <span className="text-xs font-sans-display font-semibold text-[#4A5955]">
            {t('home.difficultyLabel')}
          </span>
          <SegmentedControl<DifficultyPreset>
            ariaLabel={t('home.difficultyLabel')}
            className="bg-[#F3EFE8] border-[#E5DFD5]"
            segmentClassName="px-3 py-1"
            value={difficulty}
            onChange={onChangeDifficulty}
            options={[
              { value: 'easy', label: t('home.diffEasy') },
              { value: 'medium', label: t('home.diffMedium') },
              { value: 'hard', label: t('home.diffHard') },
            ]}
          />
        </div>
      </div>

      <div className="border-t border-b border-[#E5DFD5] divide-y divide-[#E5DFD5]">
        {SECTION_DRILLS.map((drill) => {
          const { qCount, maxCount, mins } = resolveDrillSize(drill, drillCounts, data);
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
                  <NumericInput
                    id={`drill-count-${drill.code}`}
                    value={qCount}
                    min={maxCount === 0 ? 0 : 1}
                    max={maxCount}
                    disabled={maxCount === 0}
                    integer
                    stepper
                    compact
                    suffix={t('home.questionsUnitShort')}
                    label={`${drillLabel} ${t('home.modalQuestions')}`}
                    className="!w-[116px]"
                    onCommit={(next) => onChangeCount(drill.code as DrillCountSection, next)}
                  />
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
                  disabled={launching !== null || qCount === 0}
                  onClick={() => onRequestDrill(drill)}
                  className="px-3.5 py-2 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#113C36] hover:text-white hover:border-[#113C36] text-xs font-sans-display font-semibold text-[#113C36] transition-tactile cursor-pointer whitespace-nowrap disabled:opacity-50"
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
