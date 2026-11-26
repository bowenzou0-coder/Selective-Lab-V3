import { useMemo, useState } from 'react';
import type { SectionCode } from '../../shared/contracts';
import type { ProgressResponse } from '../api';
import { useI18n } from '../i18n';
import { SegmentedControl } from './ui/SegmentedControl';

export function SkillReadiness({ skills }: { skills: ProgressResponse['skills'] }) {
  const { t, sectionShortLabel, skillName, familyLabel } = useI18n();
  const [sectionFilter, setSectionFilter] = useState<'ALL' | SectionCode>('ALL');
  const [onlyPracticed, setOnlyPracticed] = useState(false);

  const groupedByFamily = useMemo(() => {
    const groups = new Map<string, ProgressResponse['skills']>();
    for (const skill of skills) {
      if (sectionFilter !== 'ALL' && skill.section !== sectionFilter) continue;
      if (onlyPracticed && !skill.state?.attemptsCount) continue;
      const family = groups.get(skill.familyCode);
      if (family) family.push(skill);
      else groups.set(skill.familyCode, [skill]);
    }
    return Array.from(groups.entries());
  }, [skills, sectionFilter, onlyPracticed]);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-sans-display font-semibold text-[19px] tracking-[-0.015em] text-[#113C36]">
            {t('prog.skillReadinessTitle')}
          </h2>
          <p className="text-xs text-[#4A5955] mt-0.5">
            {t('prog.skillReadinessDesc')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <SegmentedControl
            ariaLabel={t('prog.skillReadinessTitle')}
            tone="paper"
            className="bg-[#F3EFE8] border-transparent"
            segmentClassName="px-3 py-1"
            value={sectionFilter}
            onChange={setSectionFilter}
            options={(['ALL', 'READ', 'MATH', 'THINK', 'WRIT'] as const).map((sec) => ({
              value: sec,
              label: sec === 'ALL' ? t('prog.allFilter') : sectionShortLabel(sec),
            }))}
          />
          <label className="inline-flex items-center gap-2 text-xs text-[#4A5955] cursor-pointer whitespace-nowrap">
            <input
              type="checkbox"
              checked={onlyPracticed}
              onChange={(e) => setOnlyPracticed(e.target.checked)}
              className="accent-[#113C36]"
            />
            <span>{t('prog.practicedOnly')}</span>
          </label>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {groupedByFamily.map(([family, skills]) => (
          <div
            key={family}
            className="p-5 rounded-[14px] bg-[#FAF8F5] border border-[#E5DFD5] space-y-3"
          >
            <div className="text-xs font-sans-display font-semibold text-[#4A5955]">
              {familyLabel(family)}
            </div>
            <div className="space-y-3">
              {skills.map((sk) => {
                const pct = sk.state ? Math.round(sk.state.masteryScore * 100) : null;
                return (
                  <div key={sk.skillId} className="space-y-1.5">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs">
                      <span className="text-[#113C36] font-medium min-w-0 break-words">
                        {skillName(sk.skillId)}
                      </span>
                      <span className="tabular-nums text-[#4A5955] ml-auto text-right">
                        {pct !== null
                          ? `${pct}% (${sk.state!.correctCount}/${sk.state!.attemptsCount})`
                          : t('prog.notTried')}
                        {sk.state?.plateauStatus && sk.state.plateauStatus !== 'none'
                          ? ` (${sk.state.plateauStatus})`
                          : ''}
                      </span>
                    </div>
                    <div className="h-2 w-full rounded-full bg-[#E5DFD5]/80 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-[#113C36] transition-[width] duration-500 ease-out"
                        style={{ width: `${pct ?? 0}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
