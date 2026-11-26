import { memo, useState } from 'react';
import { ChevronLeft, ChevronRight, Play, Trash2 } from 'lucide-react';
import {
  qcStatusToPoolStatus,
  type BankPoolStatus,
  type QuestionCompletionStatus,
  type QuestionProgressMeta,
} from '../../../../shared/bankStatus';
import type { QuestionItem, StimulusGroup } from '../../../../shared/contracts';
import { useI18n } from '../../../i18n';

export function poolBadgeClasses(status: BankPoolStatus): string {
  if (status === 'live') return 'bg-[#E5F0EA] text-[#113C36] border-[#C5DDD1]';
  if (status === 'paused') return 'bg-[#FDF0E2] text-[#A35116] border-[#EED3B6]';
  return 'bg-[#F3EFE8] text-[#615E57] border-[#E5DFD5]';
}

export function completionBadgeClasses(status: QuestionCompletionStatus): string {
  if (status === 'done') return 'bg-[#E5F0EA] text-[#113C36]';
  if (status === 'needs_repair') return 'bg-[#FDECEB] text-[#B83A28]';
  if (status === 'in_review') return 'bg-[#FDF0E2] text-[#A35116]';
  return 'bg-[#F3EFE8] text-[#4A5955]';
}

interface BankQuestionListProps {
  questions: QuestionItem[];
  stimuliById: Record<string, StimulusGroup>;
  progressByQid: Record<string, QuestionProgressMeta>;
  openFlagsByQid: Record<string, number>;
  selectedQid: string;
  onSelect: (qid: string) => void;
  checkedQids: string[];
  onToggleCheck: (qid: string) => void;
  onToggleAllOnPage: () => void;
  loading: boolean;
  totalMatching: number;
  page: number;
  totalPages: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  onResetFilters: () => void;
  bulkBusy: boolean;
  onBulkStatus: (status: BankPoolStatus) => void;
  onBulkDelete: () => void;
  onClearSelection: () => void;
  onSimulateSelected: () => void;
}

const Row = memo(function Row({
  q,
  title,
  selected,
  checked,
  progress,
  flags,
  onSelect,
  onToggleCheck,
}: {
  q: QuestionItem;
  title: string;
  selected: boolean;
  checked: boolean;
  progress?: QuestionProgressMeta;
  flags: number;
  onSelect: (qid: string) => void;
  onToggleCheck: (qid: string) => void;
}) {
  const { t, sectionLabel, formatLabel, poolStatusLabel, completionStatusLabel } = useI18n();
  const pool = qcStatusToPoolStatus(q.qcStatus);
  const completion = progress?.completionStatus ?? 'unseen';
  return (
    <li
      className={`flex items-start gap-2.5 px-3.5 py-3 transition-colors [contain-intrinsic-size:auto_84px] [content-visibility:auto] ${
        selected ? 'bg-[#E5F0EA]/60' : 'hover:bg-[#FAF8F5]'
      }`}
    >
      <input
        type="checkbox"
        aria-label={t('bank.selectQuestionAria', { id: q.questionId })}
        checked={checked}
        onChange={() => onToggleCheck(q.questionId)}
        className="mt-1 shrink-0 cursor-pointer accent-[#113C36]"
      />
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelect(q.questionId)}
        data-press="off"
        className="min-w-0 flex-1 cursor-pointer space-y-1.5 rounded-[6px] text-left"
      >
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="min-w-0 flex-1 truncate font-mono-code text-[11px] font-semibold text-[#113C36]">{q.questionId}</span>
          <span className="flex shrink-0 items-center gap-1 whitespace-nowrap">
            <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${poolBadgeClasses(pool)}`}>
              {poolStatusLabel(pool)}
            </span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${completionBadgeClasses(completion)}`}>
              {completionStatusLabel(completion)}
            </span>
          </span>
        </div>
        <p className="line-clamp-2 break-words text-xs leading-relaxed text-[#4A5955]">{title}</p>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#615E57]">
          <span>{sectionLabel(q.section)}</span>
          <span>{formatLabel(q.formatType)}</span>
          {q.poolType === 'benchmark_holdout' && <span className="font-medium text-[#A35116]">{t('bank.holdoutTag')}</span>}
          {flags > 0 && (
            <span className="font-medium text-[#B83A28]">
              {flags === 1 ? t('bank.flagOne') : t('bank.flagMany', { count: flags })}
            </span>
          )}
        </div>
      </button>
    </li>
  );
});

export const BankQuestionList = memo(function BankQuestionList({
  questions,
  stimuliById,
  progressByQid,
  openFlagsByQid,
  selectedQid,
  onSelect,
  checkedQids,
  onToggleCheck,
  onToggleAllOnPage,
  loading,
  totalMatching,
  page,
  totalPages,
  pageSize,
  onPageChange,
  onPageSizeChange,
  onResetFilters,
  bulkBusy,
  onBulkStatus,
  onBulkDelete,
  onClearSelection,
  onSimulateSelected,
}: BankQuestionListProps) {
  const { t } = useI18n();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const checked = new Set(checkedQids);
  const allOnPageChecked = questions.length > 0 && questions.every((q) => checked.has(q.questionId));

  return (
    <section className="min-w-0 overflow-hidden rounded-[16px] border border-[#E5DFD5] bg-white" aria-busy={loading}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#E5DFD5] bg-[#FAF8F5] px-4 py-2.5 text-xs">
        <label className="inline-flex cursor-pointer items-center gap-2 whitespace-nowrap font-medium text-[#4A5955]">
          <input type="checkbox" checked={allOnPageChecked} onChange={onToggleAllOnPage} className="accent-[#113C36]" />
          <span className="tabular-nums">
            {totalMatching === 1 ? t('bank.questionOne') : t('bank.questionMany', { count: totalMatching })}
          </span>
        </label>
        <div className="flex shrink-0 items-center gap-1.5">
          <select
            aria-label={t('bank.perPageAria')}
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            data-select="compact"
            className="cursor-pointer rounded-[8px] border border-[#CFC6B9] bg-white pl-2.5 py-1 text-xs text-[#4A5955]"
          >
            {[25, 50, 100].map((n) => (
              <option key={n} value={n}>{t('bank.perPage', { count: n })}</option>
            ))}
          </select>
          <button
            type="button"
            aria-label={t('session.previous')}
            disabled={page <= 1}
            onClick={() => onPageChange(Math.max(1, page - 1))}
            className="cursor-pointer rounded-[8px] border border-[#CFC6B9] bg-white p-1 text-[#4A5955] disabled:opacity-40"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span className="px-1 tabular-nums text-[#4A5955]">
            {page}/{totalPages}
          </span>
          <button
            type="button"
            aria-label={t('session.next')}
            disabled={page >= totalPages}
            onClick={() => onPageChange(Math.min(totalPages, page + 1))}
            className="cursor-pointer rounded-[8px] border border-[#CFC6B9] bg-white p-1 text-[#4A5955] disabled:opacity-40"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {checkedQids.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#C5DDD1] bg-[#E5F0EA]/65 px-4 py-2.5 text-xs">
          <div className="flex items-center gap-2.5">
            <span className="whitespace-nowrap font-sans-display font-semibold tabular-nums text-[#113C36]">
              {t('bank.selectedCount', { count: checkedQids.length })}
            </span>
            <button
              type="button"
              onClick={() => {
                setConfirmDelete(false);
                onClearSelection();
              }}
              className="cursor-pointer whitespace-nowrap font-medium text-[#4A5955] underline underline-offset-4 hover:text-[#113C36]"
            >
              {t('bank.clearSelection')}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {(['live', 'paused', 'archived'] as BankPoolStatus[]).map((st) => (
              <button
                key={st}
                type="button"
                disabled={bulkBusy}
                onClick={() => onBulkStatus(st)}
                className="cursor-pointer whitespace-nowrap rounded-[8px] border border-[#CFC6B9] bg-white px-2.5 py-1 font-sans-display font-semibold text-[#113C36] transition-tactile hover:bg-[#FAF8F5] disabled:opacity-50"
              >
                {st === 'live' ? t('bank.moveToPool') : st === 'paused' ? t('bank.pause') : t('bank.archive')}
              </button>
            ))}
            {confirmDelete ? (
              <span className="inline-flex items-center gap-1 rounded-[8px] border border-[#B83A28]/30 bg-[#FDECEB] px-1.5 py-0.5">
                <button
                  type="button"
                  disabled={bulkBusy}
                  onClick={() => {
                    setConfirmDelete(false);
                    onBulkDelete();
                  }}
                  className="cursor-pointer rounded-[6px] bg-[#B83A28] px-2 py-0.5 font-sans-display font-semibold text-white hover:bg-[#992D1E] disabled:opacity-50"
                >
                  {t('bank.confirmDelete', { count: checkedQids.length })}
                </button>
                <button type="button" onClick={() => setConfirmDelete(false)} className="cursor-pointer px-1.5 font-medium text-[#4A5955]">
                  {t('home.modalCancel')}
                </button>
              </span>
            ) : (
              <button
                type="button"
                disabled={bulkBusy}
                onClick={() => setConfirmDelete(true)}
                className="inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-[8px] border border-[#B83A28]/30 bg-[#FDECEB] px-2.5 py-1 font-sans-display font-semibold text-[#B83A28] transition-tactile hover:bg-[#B83A28] hover:text-white disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5 shrink-0" />
                <span>{t('bank.delete')}</span>
              </button>
            )}
            <button
              type="button"
              onClick={onSimulateSelected}
              className="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[8px] bg-[#113C36] px-3 py-1 font-sans-display font-semibold text-white transition-tactile hover:bg-[#0B2B26]"
            >
              <Play className="h-3 w-3 shrink-0 fill-current" />
              <span>{t('bank.practiceSelected', { count: checkedQids.length })}</span>
            </button>
          </div>
        </div>
      )}

      {loading && questions.length === 0 ? (
        <ul aria-hidden="true" className="divide-y divide-[#E5DFD5]">
          {Array.from({ length: 6 }, (_, i) => (
            <li key={i} className="space-y-2 px-3.5 py-3.5">
              <div className="h-3 w-2/5 animate-pulse rounded bg-[#F3EFE8]" />
              <div className="h-3 w-4/5 animate-pulse rounded bg-[#F3EFE8]" />
            </li>
          ))}
        </ul>
      ) : questions.length === 0 ? (
        <div className="space-y-2 p-8 text-center">
          <p className="text-sm font-medium text-[#113C36]">{t('bank.empty')}</p>
          <button
            type="button"
            onClick={onResetFilters}
            className="cursor-pointer font-sans-display text-xs font-semibold text-[#113C36] underline underline-offset-4"
          >
            {t('bank.resetFilters')}
          </button>
        </div>
      ) : (
        <ul className={`divide-y divide-[#E5DFD5] transition-opacity ${loading ? 'opacity-60' : ''}`}>
          {questions.map((q) => (
            <Row
              key={q.questionId}
              q={q}
              title={
                q.stemPrefix || q.parts[0]?.promptText || (q.stimulusId ? stimuliById[q.stimulusId]?.title : '') || t('bank.untitled')
              }
              selected={q.questionId === selectedQid}
              checked={checked.has(q.questionId)}
              progress={progressByQid[q.questionId]}
              flags={openFlagsByQid[q.questionId] || 0}
              onSelect={onSelect}
              onToggleCheck={onToggleCheck}
            />
          ))}
        </ul>
      )}
    </section>
  );
});
