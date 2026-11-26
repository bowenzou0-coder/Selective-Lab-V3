import { memo, useMemo, useState, type ReactNode } from 'react';
import { Play, RefreshCw, Search, SlidersHorizontal, X } from 'lucide-react';
import type { BatchDirectorySummary } from '../../../api';
import type { BankPoolStatus, QuestionCompletionStatus } from '../../../../shared/bankStatus';
import type { SectionCode } from '../../../../shared/contracts';
import { SKILLS_TAXONOMY } from '../../../../shared/skills';
import { useI18n } from '../../../i18n';
import { FORMAT_LABELS } from '../../QuestionWorkspace';
import { Popover } from '../../ui/Popover';
import { countPopoverFilters, type BankFilters } from './useBankQuery';

const SECTION_VALUES: ('' | SectionCode)[] = ['', 'READ', 'MATH', 'THINK', 'WRIT'];
const POOL_STATUS_VALUES: BankPoolStatus[] = ['live', 'paused', 'archived'];
const COMPLETION_VALUES: QuestionCompletionStatus[] = ['unseen', 'in_review', 'done', 'needs_repair'];
const BOOLEAN_FILTERS = ['flaggedOnly', 'missingVisual', 'missingExplanation', 'includeHistorical'] as const;

interface BankFilterBarProps {
  filters: BankFilters;
  onChange: <K extends keyof BankFilters>(key: K, value: BankFilters[K]) => void;
  onReset: () => void;
  onRefresh: () => void;
  onOpenSimulator: () => void;
  loading: boolean;
  batchSummaries: BatchDirectorySummary[];
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="truncate text-[11px] font-medium text-[#615E57]">{label}</span>
      {children}
    </label>
  );
}

function Select({ value, onChange, children, ariaLabel }: { value: string; onChange: (v: string) => void; children: ReactNode; ariaLabel?: string }) {
  return (
    <select
      value={value}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
      className="w-full min-w-0 cursor-pointer truncate rounded-[10px] border border-[#E5DFD5] bg-white py-1.5 pl-3 text-[12px] font-medium text-[#113C36] transition-tactile hover:border-[#CBC2B3] focus:border-[#113C36] focus:outline-none"
    >
      {children}
    </select>
  );
}

export const BankFilterBar = memo(function BankFilterBar({
  filters,
  onChange,
  onReset,
  onRefresh,
  onOpenSimulator,
  loading,
  batchSummaries,
}: BankFilterBarProps) {
  const { t, sectionShortLabel, poolStatusLabel, completionStatusLabel, skillName, formatLabel } = useI18n();
  const [batchSearch, setBatchSearch] = useState('');
  const popoverCount = countPopoverFilters(filters);
  const anyActive = popoverCount > 0 || Boolean(filters.search) || Boolean(filters.section);

  const batchOptions = useMemo(() => {
    const q = batchSearch.trim().toLowerCase();
    const list = q
      ? batchSummaries.filter((b) => b.batchLabel.toLowerCase().includes(q) || b.batchId.toLowerCase().includes(q))
      : batchSummaries;
    return list.slice(0, 60);
  }, [batchSummaries, batchSearch]);

  const skills = useMemo(
    () => (filters.section ? SKILLS_TAXONOMY.filter((s) => s.section === filters.section) : SKILLS_TAXONOMY),
    [filters.section]
  );

  const booleanLabels: Record<(typeof BOOLEAN_FILTERS)[number], string> = {
    flaggedOnly: t('bank.flaggedOnly'),
    missingVisual: t('bank.missingVisual'),
    missingExplanation: t('bank.missingExplanation'),
    includeHistorical: t('bank.includeHistorical'),
  };

  const chips: { key: keyof BankFilters; label: string }[] = [];
  if (filters.poolStatus) chips.push({ key: 'poolStatus', label: poolStatusLabel(filters.poolStatus) });
  if (filters.completionStatus) chips.push({ key: 'completionStatus', label: completionStatusLabel(filters.completionStatus) });
  if (filters.batchId) {
    const batch = batchSummaries.find((b) => b.batchId === filters.batchId);
    chips.push({ key: 'batchId', label: batch?.batchLabel || filters.batchId });
  }
  if (filters.skillId) chips.push({ key: 'skillId', label: skillName(filters.skillId) });
  if (filters.formatType) chips.push({ key: 'formatType', label: formatLabel(filters.formatType) });
  if (filters.poolType) {
    chips.push({ key: 'poolType', label: filters.poolType === 'benchmark_holdout' ? t('bank.holdoutPool') : t('bank.practicePool') });
  }
  for (const key of BOOLEAN_FILTERS) if (filters[key]) chips.push({ key, label: booleanLabels[key] });

  const clearChip = (key: keyof BankFilters) => {
    if (typeof filters[key] === 'boolean') onChange(key, false as never);
    else onChange(key, '' as never);
  };

  return (
    <section className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#615E57]" />
          <input
            type="search"
            aria-label={t('bank.searchPlaceholder')}
            value={filters.search}
            onChange={(e) => onChange('search', e.target.value)}
            placeholder={t('bank.searchPlaceholder')}
            className="w-full rounded-[10px] border border-[#E5DFD5] bg-white py-2 pl-9 pr-3 text-sm text-[#113C36] transition-colors placeholder:text-[#615E57] focus:border-[#113C36] focus:outline-none"
          />
        </div>

        <div
          role="group"
          aria-label={t('bank.sectionFilterAria')}
          className="inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-[12px] border border-[#E5DFD5] bg-[#FAF8F5] p-1"
        >
          {SECTION_VALUES.map((sec) => {
            const active = filters.section === sec;
            return (
              <button
                key={sec || 'all'}
                type="button"
                aria-pressed={active}
                onClick={() => onChange('section', sec)}
                className={`shrink-0 cursor-pointer whitespace-nowrap rounded-[9px] px-3 py-1 text-[12px] font-medium transition-tactile ${
                  active ? 'bg-[#113C36] text-white' : 'text-[#4A5955] hover:bg-white/80 hover:text-[#113C36]'
                }`}
              >
                {sec ? sectionShortLabel(sec) : t('bank.allSections')}
              </button>
            );
          })}
        </div>

        <Popover
          align="end"
          label={t('bank.filtersTitle')}
          panelClassName="w-[min(30rem,calc(100vw-2rem))]"
          trigger={(props, open) => (
            <button
              type="button"
              {...props}
              className={`inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[10px] border px-3 py-2 font-sans-display text-xs font-semibold transition-tactile ${
                open || popoverCount > 0
                  ? 'border-[#C5DDD1] bg-[#E5F0EA] text-[#113C36]'
                  : 'border-[#E5DFD5] bg-white text-[#4A5955] hover:bg-[#FAF8F5]'
              }`}
            >
              <SlidersHorizontal className="h-3.5 w-3.5 shrink-0" />
              <span>{t('bank.filtersBtn')}</span>
              {popoverCount > 0 && (
                <span className="rounded-full bg-[#113C36] px-1.5 text-[10px] leading-[16px] text-white tabular-nums">
                  {popoverCount}
                </span>
              )}
            </button>
          )}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('bank.poolLabel')}>
              <Select value={filters.poolStatus} onChange={(v) => onChange('poolStatus', v as BankFilters['poolStatus'])}>
                <option value="">{t('bank.allStatuses')}</option>
                {POOL_STATUS_VALUES.map((v) => (
                  <option key={v} value={v}>{poolStatusLabel(v)}</option>
                ))}
              </Select>
            </Field>
            <Field label={t('bank.progressLabel')}>
              <Select
                value={filters.completionStatus}
                onChange={(v) => onChange('completionStatus', v as BankFilters['completionStatus'])}
              >
                <option value="">{t('bank.allProgress')}</option>
                {COMPLETION_VALUES.map((v) => (
                  <option key={v} value={v}>{completionStatusLabel(v)}</option>
                ))}
              </Select>
            </Field>
            <div className="space-y-1 sm:col-span-2">
              <span className="block truncate text-[11px] font-medium text-[#615E57]">
                {t('bank.batchLabel', { count: batchSummaries.length })}
              </span>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {batchSummaries.length > 12 && (
                  <input
                    type="search"
                    value={batchSearch}
                    onChange={(e) => setBatchSearch(e.target.value)}
                    placeholder={t('batch.searchPlaceholder')}
                    aria-label={t('batch.searchPlaceholder')}
                    className="w-full rounded-[10px] border border-[#E5DFD5] bg-white px-3 py-1.5 text-[12px] text-[#113C36] focus:border-[#113C36] focus:outline-none"
                  />
                )}
                <Select
                  value={filters.batchId}
                  onChange={(v) => onChange('batchId', v)}
                  ariaLabel={t('bank.batchLabel', { count: batchSummaries.length })}
                >
                  <option value="">{t('bank.allBatches')}</option>
                  {batchOptions.map((b) => (
                    <option key={b.batchId} value={b.batchId}>
                      {t('bank.batchOption', { label: b.batchLabel, unseen: b.unseen, total: b.total })}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <Field label={t('bank.skillLabel')}>
              <Select value={filters.skillId} onChange={(v) => onChange('skillId', v)}>
                <option value="">{t('bank.allSkills')}</option>
                {skills.map((s) => (
                  <option key={s.skillId} value={s.skillId}>{skillName(s.skillId)}</option>
                ))}
              </Select>
            </Field>
            <Field label={t('bank.formatLabel')}>
              <Select value={filters.formatType} onChange={(v) => onChange('formatType', v)}>
                <option value="">{t('bank.allFormats')}</option>
                {Object.keys(FORMAT_LABELS).map((k) => (
                  <option key={k} value={k}>{formatLabel(k)}</option>
                ))}
              </Select>
            </Field>
            <Field label={t('bank.isolationLabel')}>
              <Select value={filters.poolType} onChange={(v) => onChange('poolType', v)}>
                <option value="">{t('bank.allPools')}</option>
                <option value="practice">{t('bank.practicePool')}</option>
                <option value="benchmark_holdout">{t('bank.holdoutPool')}</option>
              </Select>
            </Field>
            <Field label={t('bank.sortLabel')}>
              <Select value={filters.sort} onChange={(v) => onChange('sort', v as BankFilters['sort'])}>
                <option value="id_asc">{t('bank.sortIdAsc')}</option>
                <option value="updated_desc">{t('bank.sortUpdatedDesc')}</option>
                <option value="version_desc">{t('bank.sortVersionDesc')}</option>
              </Select>
            </Field>
            <fieldset className="sm:col-span-2">
              <legend className="mb-1.5 text-[11px] font-medium text-[#615E57]">{t('bank.flagsFilterGroup')}</legend>
              <div className="grid grid-cols-1 gap-1.5 text-xs text-[#4A5955] sm:grid-cols-2">
                {BOOLEAN_FILTERS.map((key) => (
                  <label key={key} className="inline-flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={filters[key]}
                      onChange={(e) => onChange(key, e.target.checked)}
                      className="accent-[#113C36]"
                    />
                    <span>{booleanLabels[key]}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
        </Popover>

        <button
          type="button"
          onClick={onRefresh}
          aria-label={t('bank.refresh')}
          title={t('bank.refresh')}
          className="inline-flex cursor-pointer items-center rounded-[10px] border border-[#E5DFD5] bg-white p-2 text-[#4A5955] transition-tactile hover:bg-[#FAF8F5] hover:text-[#113C36]"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>

        <button
          type="button"
          onClick={onOpenSimulator}
          className="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[10px] bg-[#113C36] px-3.5 py-2 font-sans-display text-xs font-semibold text-white transition-[background-color,transform,translate,scale] duration-150 hover:bg-[#0B2B26] active:scale-[0.97]"
        >
          <Play className="h-3 w-3 shrink-0 fill-current" />
          <span>{t('bank.simulate')}</span>
        </button>
      </div>

      {anyActive && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label={t('bank.activeFiltersLabel')}>
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={() => clearChip(chip.key)}
              aria-label={t('bank.removeFilterAria', { label: chip.label })}
              className="inline-flex max-w-[16rem] cursor-pointer items-center gap-1 rounded-full border border-[#C5DDD1] bg-[#F4FAF7] py-0.5 pl-2.5 pr-1.5 text-[11px] font-medium text-[#113C36] transition-tactile hover:bg-[#E5F0EA]"
            >
              <span className="truncate">{chip.label}</span>
              <X className="h-3 w-3 shrink-0" />
            </button>
          ))}
          <button
            type="button"
            onClick={onReset}
            className="cursor-pointer px-1.5 text-[11px] font-medium text-[#4A5955] underline-offset-4 hover:text-[#113C36] hover:underline"
          >
            {t('bank.clearAll')}
          </button>
        </div>
      )}
    </section>
  );
});
