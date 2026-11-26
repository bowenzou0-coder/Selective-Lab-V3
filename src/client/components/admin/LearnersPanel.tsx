import { useMemo, useState } from 'react';
import { AlertTriangle, Library, Search, Star, Trash2, UserRound, X } from 'lucide-react';
import type { AdminLearnerSummary, AdminLearnersResponse } from '../../api';
import { useI18n } from '../../i18n';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import {
  LEARNERS_PAGE_SIZE,
  filterAndSortLearners,
  getLearnerDisplayName,
  type LearnerRoleFilter,
  type LearnerSortKey,
} from './learnerScopeUtils';

interface LearnersPanelProps {
  learnersData: AdminLearnersResponse;
  selectedLearnerId: string;
  currentUserId?: string | null;
  pinningPrimary: boolean;
  onSelectLearner: (uid: string) => void;
  onSetPrimary: (uid: string | null) => void;
  onDeleteLearner?: (learner: AdminLearnerSummary) => Promise<void>;
}

export function LearnersPanel({
  learnersData,
  selectedLearnerId,
  currentUserId,
  pinningPrimary,
  onSelectLearner,
  onSetPrimary,
  onDeleteLearner,
}: LearnersPanelProps) {
  const { t, formatDate } = useI18n();
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<LearnerRoleFilter>('all');
  const [sortBy, setSortBy] = useState<LearnerSortKey>('default');
  const [page, setPage] = useState(1);
  const [pendingDelete, setPendingDelete] = useState<AdminLearnerSummary | null>(null);
  const [deleteConfirmInput, setDeleteConfirmInput] = useState('');
  const [deleting, setDeleting] = useState(false);

  const learners = learnersData.learners;
  const studentCount = useMemo(
    () => learners.filter((l) => l.role !== 'admin').length,
    [learners]
  );
  const adminCount = learners.length - studentCount;

  const filteredLearners = useMemo(
    () => filterAndSortLearners(learners, { query, role: roleFilter, sort: sortBy }),
    [learners, query, roleFilter, sortBy]
  );

  const totalPages = Math.max(1, Math.ceil(filteredLearners.length / LEARNERS_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * LEARNERS_PAGE_SIZE;
  const visibleLearners = filteredLearners.slice(pageStart, pageStart + LEARNERS_PAGE_SIZE);
  const hasActiveFilters = query.trim().length > 0 || roleFilter !== 'all' || sortBy !== 'default';

  const viewingLearner =
    selectedLearnerId && selectedLearnerId !== 'none'
      ? learners.find((l) => l.uid === selectedLearnerId) ?? null
      : null;
  const primaryLearner = learnersData.primaryMonitoredStudentId
    ? learners.find((l) => l.uid === learnersData.primaryMonitoredStudentId) ?? null
    : null;
  const isCatalogMode = selectedLearnerId === 'none';

  const handleQueryChange = (next: string) => {
    setQuery(next);
    setPage(1);
  };
  const handleRoleChange = (next: LearnerRoleFilter) => {
    setRoleFilter(next);
    setPage(1);
  };
  const handleSortChange = (next: LearnerSortKey) => {
    setSortBy(next);
    setPage(1);
  };
  const handleClearFilters = () => {
    setQuery('');
    setRoleFilter('all');
    setSortBy('default');
    setPage(1);
  };

  return (
    <div className="space-y-6">
      <section className="rounded-[16px] bg-white border border-[#E5DFD5] p-6 space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
          <div className="space-y-1 max-w-2xl">
            <h2 className="font-sans-display font-semibold text-[18px] text-[#113C36]">
              {t('learners.panelTitle')}
            </h2>
            <p className="text-xs text-[#4A5955] leading-relaxed">
              {t('learners.panelDesc')}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs shrink-0">
            <span className="px-3 py-1.5 rounded-[10px] bg-[#FAF8F5] border border-[#E5DFD5] text-[#4A5955]">
              {t('learners.currentlyViewingLabel')}:{' '}
              <strong className="text-[#113C36]">
                {viewingLearner ? getLearnerDisplayName(viewingLearner) : t('admin.noLearnerCatalogPill')}
              </strong>
            </span>
            <span className="px-3 py-1.5 rounded-[10px] bg-[#E5F0EA]/70 border border-[#C5DDD1] text-[#113C36]">
              {t('learners.primaryLearnerLabel')}:{' '}
              <strong>
                {primaryLearner ? getLearnerDisplayName(primaryLearner) : t('learners.nonePinnedLabel')}
              </strong>
            </span>
          </div>
        </div>

        {studentCount === 0 && (
          <div className="px-4 py-3 rounded-[12px] bg-[#FAF8F5] border border-[#E5DFD5] text-xs text-[#4A5955] leading-relaxed">
            {t('learners.noStudentsYetHint')}
          </div>
        )}

        {learners.length >= 2 && (
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div className="relative flex-1 max-w-md">
              <Search
                className="w-3.5 h-3.5 text-[#78756E] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                aria-hidden="true"
              />
              <input
                type="search"
                value={query}
                onChange={(e) => handleQueryChange(e.target.value)}
                placeholder={t('learners.searchPlaceholder')}
                aria-label={t('learners.searchPlaceholder')}
                className="w-full rounded-[10px] border border-[#D8D1C6] bg-[#FAF8F5] py-2 pl-9 pr-8 text-xs text-[#113C36] placeholder:text-[#78756E] focus:border-[#113C36] focus:bg-white focus:outline-none [&::-webkit-search-cancel-button]:hidden"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => handleQueryChange('')}
                  aria-label={t('learners.clearFiltersBtn')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#78756E] hover:text-[#113C36] cursor-pointer p-0.5"
                >
                  <X className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div
                role="group"
                aria-label={t('learners.colRole')}
                className="inline-flex rounded-[10px] border border-[#D8D1C6] bg-[#FAF8F5] p-0.5"
              >
                {(
                  [
                    { id: 'all', label: t('learners.filterAll', { count: learners.length }) },
                    { id: 'student', label: t('learners.filterStudents', { count: studentCount }) },
                    { id: 'admin', label: t('learners.filterAdmins', { count: adminCount }) },
                  ] as const
                ).map((item) => {
                  const active = roleFilter === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => handleRoleChange(item.id)}
                      className={`px-2.5 py-1 rounded-[8px] text-xs font-sans-display font-semibold cursor-pointer transition-colors whitespace-nowrap ${
                        active
                          ? 'bg-[#113C36] text-white'
                          : 'text-[#4A5955] hover:text-[#113C36]'
                      }`}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>

              <select
                value={sortBy}
                onChange={(e) => handleSortChange(e.target.value as LearnerSortKey)}
                aria-label={t('learners.sortAria')}
                className="rounded-[10px] border border-[#D8D1C6] bg-white px-3 py-1.5 text-xs font-sans-display font-medium text-[#113C36] focus:border-[#113C36] focus:outline-none cursor-pointer"
              >
                <option value="default">{t('learners.sortDefault')}</option>
                <option value="unseen_asc">{t('learners.sortUnseenAsc')}</option>
                <option value="sessions_desc">{t('learners.sortSessionsDesc')}</option>
                <option value="recent_desc">{t('learners.sortRecentDesc')}</option>
                <option value="name_asc">{t('learners.sortNameAsc')}</option>
              </select>
            </div>
          </div>
        )}

        <div className="overflow-x-auto rounded-[14px] border border-[#E5DFD5] bg-white">
          <table className="w-full border-collapse text-left text-xs tabular-nums">
            <thead>
              <tr className="border-b border-[#EFEAE0] bg-[#FAF8F5] text-[#78756E]">
                <th className="px-3.5 py-2.5 font-sans-display font-semibold">{t('learners.colAccount')}</th>
                <th className="px-2.5 py-2.5 text-right font-sans-display font-semibold">{t('learners.colUnseen')}</th>
                <th className="px-2.5 py-2.5 text-right font-sans-display font-semibold">{t('learners.colDone')}</th>
                <th className="px-2.5 py-2.5 text-right font-sans-display font-semibold whitespace-nowrap">{t('learners.colInReview')}</th>
                <th className="px-2.5 py-2.5 text-right font-sans-display font-semibold whitespace-nowrap">{t('learners.colRepair')}</th>
                <th className="px-2.5 py-2.5 text-right font-sans-display font-semibold">{t('learners.colRunway')}</th>
                <th className="px-2.5 py-2.5 text-right font-sans-display font-semibold">{t('learners.colSessions')}</th>
                <th className="px-2.5 py-2.5 text-right font-sans-display font-semibold">{t('learners.colAttempts')}</th>
                <th className="px-2.5 py-2.5 font-sans-display font-semibold whitespace-nowrap">{t('learners.colLastActive')}</th>
                <th className="px-3.5 py-2.5 text-right font-sans-display font-semibold">{t('learners.colAction')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F2EDE4]">
              {visibleLearners.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-10 text-center">
                    <div className="space-y-3">
                      <p className="text-xs text-[#78756E]">{t('learners.noFilterMatches')}</p>
                      {hasActiveFilters && (
                        <button
                          type="button"
                          onClick={handleClearFilters}
                          className="inline-flex items-center px-3 py-1.5 rounded-[8px] border border-[#CFC6B9] bg-white text-xs font-sans-display font-semibold text-[#113C36] hover:bg-[#F3EFE8] cursor-pointer transition-colors"
                        >
                          {t('learners.clearFiltersBtn')}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ) : (
                visibleLearners.map((l) => {
                  const isViewing = l.uid === selectedLearnerId;
                  const isPrimary = l.uid === learnersData.primaryMonitoredStudentId;
                  const isYou = Boolean(currentUserId && l.uid === currentUserId);
                  return (
                    <tr
                      key={l.uid}
                      className={isViewing ? 'bg-[#E5F0EA]/45' : 'hover:bg-[#FAF8F5]/75'}
                    >
                      <td className="px-3.5 py-3">
                        <div className="flex flex-wrap items-center gap-1.5 font-sans-display font-semibold text-[#113C36]">
                          <UserRound className="w-3.5 h-3.5 text-[#4A5955] shrink-0" />
                          <span>{getLearnerDisplayName(l)}</span>
                          <span
                            className={`inline-flex px-1.5 py-0.5 rounded-full text-[10px] font-medium ${
                              l.role === 'admin'
                                ? 'bg-[#EFEAE0] text-[#4A5955]'
                                : 'bg-[#E5F0EA] text-[#1D6346]'
                            }`}
                          >
                            {l.role === 'admin'
                              ? t('learners.adminRoleTag')
                              : t('learners.studentRoleTag')}
                          </span>
                          {isYou && (
                            <span className="rounded-full bg-[#ECE8E1] px-1.5 py-0.5 text-[10px] font-medium text-[#4A5955]">
                              {t('admin.youTag')}
                            </span>
                          )}
                          {isPrimary && (
                            <span className="inline-flex items-center gap-0.5 rounded-full bg-[#113C36] px-1.5 py-0.5 text-[10px] text-white">
                              <Star className="w-2.5 h-2.5 fill-current" aria-hidden="true" />
                              <span>{t('learners.primaryTag')}</span>
                            </span>
                          )}
                        </div>
                        {l.email && (
                          <div className="text-[11px] text-[#78756E] mt-0.5 pl-5 truncate max-w-[210px]">{l.email}</div>
                        )}
                      </td>
                      <td className="px-2.5 py-3 text-right whitespace-nowrap font-medium text-[#113C36]">
                        {l.unseenLiveCount} ({l.unseenLivePercent}%)
                      </td>
                      <td className="px-2.5 py-3 text-right whitespace-nowrap text-[#1D6346] font-semibold">
                        {l.doneLiveCount}
                      </td>
                      <td className="px-2.5 py-3 text-right whitespace-nowrap text-[#4A5955]">
                        {l.inReviewLiveCount}
                      </td>
                      <td className="px-2.5 py-3 text-right whitespace-nowrap text-[#A35116] font-medium">
                        {l.needsRepairLiveCount}
                      </td>
                      <td className="px-2.5 py-3 text-right whitespace-nowrap text-[#4A5955]">
                        {l.estimatedRunwayDays}d
                      </td>
                      <td className="px-2.5 py-3 text-right whitespace-nowrap text-[#113C36] font-medium">
                        {l.sessionsCount}
                      </td>
                      <td className="px-2.5 py-3 text-right whitespace-nowrap text-[#4A5955]">
                        {l.attemptsCount}
                      </td>
                      <td className="px-2.5 py-3 whitespace-nowrap text-[#78756E]">
                        {l.lastActiveAtIso ? formatDate(l.lastActiveAtIso) : t('learners.neverActive')}
                      </td>
                      <td className="px-3.5 py-3 text-right whitespace-nowrap">
                        <div className="inline-flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            disabled={isViewing}
                            onClick={() => onSelectLearner(l.uid)}
                            className={`px-2.5 py-1.5 rounded-[8px] border text-[11px] font-sans-display font-semibold cursor-pointer transition-colors disabled:cursor-default ${
                              isViewing
                                ? 'border-[#113C36] bg-[#113C36] text-white'
                                : 'border-[#CFC6B9] bg-white text-[#113C36] hover:bg-[#F3EFE8]'
                            }`}
                          >
                            {isViewing ? t('learners.focusedTag') : t('learners.focusBtn')}
                          </button>
                          <button
                            type="button"
                            disabled={pinningPrimary}
                            onClick={() => onSetPrimary(isPrimary ? null : l.uid)}
                            title={isPrimary ? t('learners.unpinnedPrimaryBtn') : t('learners.setPrimaryBtn')}
                            aria-label={isPrimary ? t('learners.unpinnedPrimaryBtn') : t('learners.setPrimaryBtn')}
                            aria-pressed={isPrimary}
                            className={`w-7 h-7 inline-flex items-center justify-center rounded-[8px] border cursor-pointer transition-colors disabled:opacity-50 ${
                              isPrimary
                                ? 'border-[#113C36]/35 bg-[#E5F0EA] text-[#113C36] hover:bg-[#D5E7DD]'
                                : 'border-[#D8D1C6] bg-white text-[#78756E] hover:text-[#113C36] hover:bg-[#F3EFE8]'
                            }`}
                          >
                            <Star
                              className={`w-3.5 h-3.5 shrink-0 ${isPrimary ? 'fill-current' : ''}`}
                              aria-hidden="true"
                            />
                          </button>
                          {onDeleteLearner && !isYou && (
                            <button
                              type="button"
                              onClick={() => {
                                setPendingDelete(l);
                                setDeleteConfirmInput('');
                              }}
                              title={`${t('learners.deleteBtn')} ${getLearnerDisplayName(l)}`}
                              aria-label={`${t('learners.deleteBtn')} ${getLearnerDisplayName(l)}`}
                              className="w-7 h-7 inline-flex items-center justify-center rounded-[8px] border border-[#B83A28]/25 bg-white hover:bg-[#FDECEB] text-[#B83A28] cursor-pointer transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {filteredLearners.length > LEARNERS_PAGE_SIZE && (
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-[#4A5955] tabular-nums">
            <span>
              {t('learners.paginationShowing', {
                start: pageStart + 1,
                end: Math.min(pageStart + visibleLearners.length, filteredLearners.length),
                total: filteredLearners.length,
              })}
            </span>
            <div className="inline-flex items-center gap-2">
              <button
                type="button"
                disabled={safePage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="px-3 py-1.5 rounded-[8px] border border-[#CFC6B9] bg-white font-sans-display font-semibold text-[#113C36] hover:bg-[#F3EFE8] cursor-pointer transition-colors disabled:opacity-45 disabled:cursor-default"
              >
                {t('learners.paginationPrev')}
              </button>
              <span className="px-1 font-medium">
                {t('learners.paginationPage', { page: safePage, totalPages })}
              </span>
              <button
                type="button"
                disabled={safePage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="px-3 py-1.5 rounded-[8px] border border-[#CFC6B9] bg-white font-sans-display font-semibold text-[#113C36] hover:bg-[#F3EFE8] cursor-pointer transition-colors disabled:opacity-45 disabled:cursor-default"
              >
                {t('learners.paginationNext')}
              </button>
            </div>
          </div>
        )}

        {/* Explicit Catalog-Only Toggle Row */}
        <div
          className={`p-4 rounded-[14px] border flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
            isCatalogMode
              ? 'bg-[#E5F0EA]/60 border-[#113C36]/40'
              : 'bg-[#FAF8F5] border-[#E5DFD5]'
          }`}
        >
          <div className="flex items-start gap-3 min-w-0">
            <Library className="w-4 h-4 text-[#113C36] shrink-0 mt-0.5" />
            <div className="space-y-0.5 min-w-0">
              <div className="font-sans-display font-semibold text-xs text-[#113C36]">
                {t('learners.catalogCardTitle')}
              </div>
              <p className="text-xs text-[#4A5955] leading-relaxed">
                {t('learners.catalogCardDesc')}
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={isCatalogMode}
            onClick={() => onSelectLearner('none')}
            className={`px-3.5 py-2 rounded-[10px] border text-xs font-sans-display font-semibold whitespace-nowrap shrink-0 cursor-pointer transition-colors disabled:cursor-default ${
              isCatalogMode
                ? 'border-[#113C36] bg-[#113C36] text-white'
                : 'border-[#CFC6B9] bg-white text-[#113C36] hover:bg-[#F3EFE8]'
            }`}
          >
            {isCatalogMode ? t('learners.catalogActiveBtn') : t('learners.switchCatalogBtn')}
          </button>
        </div>
      </section>

      {/* Admin Delete Learner Confirmation Modal */}
      <ConfirmDialog
        open={pendingDelete !== null}
        tone="danger"
        icon={<AlertTriangle className="w-4 h-4" />}
        title={pendingDelete ? t('learners.deleteModalTitle', { name: getLearnerDisplayName(pendingDelete) }) : ''}
        description={pendingDelete?.email}
        busy={deleting}
        confirmDisabled={deleteConfirmInput.trim().toUpperCase() !== 'DELETE'}
        confirmLabel={deleting ? t('settings.deletingAccount') : t('learners.deleteConfirmBtn')}
        cancelLabel={t('home.modalCancel')}
        onClose={() => {
          setPendingDelete(null);
          setDeleteConfirmInput('');
        }}
        onConfirm={async () => {
          if (!onDeleteLearner || !pendingDelete) return;
          setDeleting(true);
          try {
            await onDeleteLearner(pendingDelete);
            setPendingDelete(null);
            setDeleteConfirmInput('');
          } catch {
            // AdminView surfaces the error banner; keep the dialog open for a retry.
          } finally {
            setDeleting(false);
          }
        }}
      >
        {pendingDelete && (
          <p className="text-xs text-[#4A5955] leading-relaxed">
            {t('learners.deleteModalBody', {
              sessions: pendingDelete.sessionsCount,
              attempts: pendingDelete.attemptsCount,
            })}
          </p>
        )}

        <div className="space-y-2 rounded-[12px] bg-[#FDECEB] border border-[#B83A28]/25 p-3.5">
          <p className="text-xs text-[#B83A28]">
            {t('settings.deleteConfirmPrefix')}{' '}
            <strong className="font-mono-code">DELETE</strong>{' '}
            {t('data.resetConfirmSuffix')}
          </p>
          <input
            type="text"
            data-autofocus
            aria-label={t('settings.deletePlaceholder')}
            value={deleteConfirmInput}
            onChange={(e) => setDeleteConfirmInput(e.target.value)}
            placeholder={t('settings.deletePlaceholder')}
            className="w-full px-3 py-2 rounded-[10px] border border-[#B83A28]/40 bg-white text-xs font-mono-code text-[#113C36] focus:outline-none"
          />
        </div>
      </ConfirmDialog>
    </div>
  );
}
