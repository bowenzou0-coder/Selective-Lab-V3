import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from 'react';
import { useI18n } from '../../i18n';
import {
  Archive,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  HelpCircle,
  History,
  PauseCircle,
  Play,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  api,
  type BatchDirectorySummary,
  type PaginatedQuestionsResponse,
} from '../../api';
import {
  poolStatusToQcStatus,
  qcStatusToPoolStatus,
  type BankPoolStatus,
  type PoolHealthSummary,
  type QuestionCompletionStatus,
  type QuestionProgressMeta,
} from '../../../shared/bankStatus';
import type {
  EvidenceCitationRef,
  QuestionItem,
  SectionCode,
  StimulusGroup,
} from '../../../shared/contracts';
import { SKILLS_TAXONOMY } from '../../../shared/skills';
import { FormattedText } from '../FormattedText';
import { FORMAT_LABELS, QuestionWorkspace } from '../QuestionWorkspace';

interface QuestionBankStudioProps {
  initialBatchId?: string;
  onClearInitialBatch?: () => void;
  onOpenSession: (sessionId: string) => void;
  onNotice: (msg: string) => void;
  onError: (msg: string) => void;
  onDataMutated?: () => void;
  monitoredStudentId?: string | null;
  monitoredLearner?: import('../../api').AdminLearnerSummary | null;
  studentCount?: number;
}

const SECTION_VALUES: ('' | SectionCode)[] = ['', 'READ', 'MATH', 'THINK', 'WRIT'];
const POOL_STATUS_VALUES: ('' | BankPoolStatus)[] = ['', 'live', 'paused', 'archived'];
const COMPLETION_VALUES: ('' | QuestionCompletionStatus)[] = ['', 'unseen', 'in_review', 'done', 'needs_repair'];

interface CompactSelectProps {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  ariaLabel?: string;
  className?: string;
  children: ReactNode;
}

function CompactSelect({ label, value, onChange, ariaLabel, className = '', children }: CompactSelectProps) {
  return (
    <label className={`flex flex-col gap-1 min-w-0 ${className}`}>
      {label && <span className="text-[11px] font-medium text-[#78756E] truncate">{label}</span>}
      <div className="relative min-w-0">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={ariaLabel || label}
          className="w-full appearance-none pl-3 pr-8 py-1.5 rounded-[10px] border border-[#E5DFD5] bg-white hover:border-[#CBC2B3] focus:outline-none focus:border-[#113C36] text-[12px] font-medium text-[#113C36] truncate cursor-pointer transition-colors"
        >
          {children}
        </select>
        <ChevronDown className="w-3.5 h-3.5 text-[#78756E] pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2" />
      </div>
    </label>
  );
}

function getPoolBadgeClasses(status: BankPoolStatus): string {
  if (status === 'live') return 'bg-[#E5F0EA] text-[#113C36] border-[#C5DDD1]';
  if (status === 'paused') return 'bg-[#FDF0E2] text-[#A35116] border-[#EED3B6]';
  return 'bg-[#F3EFE8] text-[#78756E] border-[#E5DFD5]';
}

function getCompletionBadgeClasses(status: QuestionCompletionStatus): string {
  if (status === 'done') return 'bg-[#E5F0EA] text-[#113C36]';
  if (status === 'needs_repair') return 'bg-[#FDECEB] text-[#B83A28]';
  if (status === 'in_review') return 'bg-[#FDF0E2] text-[#A35116]';
  return 'bg-[#F3EFE8] text-[#4A5955]';
}

export function QuestionBankStudio({
  initialBatchId = '',
  onClearInitialBatch,
  onOpenSession,
  onNotice,
  onError,
  onDataMutated,
  monitoredStudentId,
  monitoredLearner = null,
  studentCount = 0,
}: QuestionBankStudioProps) {
  const {
    t,
    isZh,
    sectionLabel,
    sectionShortLabel,
    formatLabel,
    poolStatusLabel,
    completionStatusLabel,
    skillName,
    formatDate,
  } = useI18n();
  // Primary filters (low-friction, single row)
  const [search, setSearch] = useState('');
  const [section, setSection] = useState<'' | SectionCode>('');
  const [poolStatus, setPoolStatus] = useState<'' | BankPoolStatus>('');
  const [completionStatus, setCompletionStatus] = useState<'' | QuestionCompletionStatus>('');

  // Collapsible "More filters"
  const [showMoreFilters, setShowMoreFilters] = useState(Boolean(initialBatchId));
  const [batchId, setBatchId] = useState(initialBatchId);
  const [batchSearch, setBatchSearch] = useState('');
  const [formatType, setFormatType] = useState('');
  const [skillId, setSkillId] = useState('');
  const [poolType, setPoolType] = useState('');
  const [sort, setSort] = useState<'id_asc' | 'updated_desc' | 'version_desc'>('id_asc');
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [missingVisual, setMissingVisual] = useState(false);
  const [missingExplanation, setMissingExplanation] = useState(false);
  const [includeHistorical, setIncludeHistorical] = useState(false);

  // Pagination & loaded bank data
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [loading, setLoading] = useState(true);
  const [questions, setQuestions] = useState<QuestionItem[]>([]);
  const [stimuliById, setStimuliById] = useState<Record<string, StimulusGroup>>({});
  const [totalMatching, setTotalMatching] = useState(0);
  const [openFlagsByQid, setOpenFlagsByQid] = useState<Record<string, number>>({});
  const [progressByQid, setProgressByQid] = useState<Record<string, QuestionProgressMeta>>({});
  const [poolHealth, setPoolHealth] = useState<PoolHealthSummary | null>(null);
  const [masteredLiveIds, setMasteredLiveIds] = useState<string[]>([]);
  const [batchSummaries, setBatchSummaries] = useState<BatchDirectorySummary[]>([]);

  // Selection, preview, and version history
  const [selectedQid, setSelectedQid] = useState<string>(
    () => new URLSearchParams(window.location.search).get('qid') || ''
  );
  const [checkedQids, setCheckedQids] = useState<string[]>([]);
  const [versionsForSelected, setVersionsForSelected] = useState<QuestionItem[]>([]);
  const [previewEvidenceRef, setPreviewEvidenceRef] = useState<EvidenceCitationRef | null>(null);
  const [uploadingQid, setUploadingQid] = useState<string | null>(null);

  // Inline Quick Practice / Simulate controls
  const [simLimit, setSimLimit] = useState('10');
  const [simTimerMin, setSimTimerMin] = useState('0');
  const [simSandbox, setSimSandbox] = useState(true);
  const [launchingSim, setLaunchingSim] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [updatingStatusQid, setUpdatingStatusQid] = useState<string | null>(null);
  const [confirmDeleteQid, setConfirmDeleteQid] = useState<string | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [showGlossary, setShowGlossary] = useState(false);

  useEffect(() => {
    if (initialBatchId) {
      setBatchId(initialBatchId);
      setShowMoreFilters(true);
      setPage(1);
      onClearInitialBatch?.();
    }
  }, [initialBatchId, onClearInitialBatch]);

  const loadQuestions = useCallback(async () => {
    setLoading(true);
    try {
      const res: PaginatedQuestionsResponse = await api.getAdminQuestions({
        search: search.trim() || undefined,
        section: section || undefined,
        poolStatus: poolStatus || undefined,
        completionStatus: completionStatus || undefined,
        batchId: batchId || undefined,
        formatType: formatType || undefined,
        skillId: skillId || undefined,
        poolType: poolType || undefined,
        sort,
        flaggedOnly,
        missingVisual,
        missingExplanation,
        includeHistorical,
        studentId:
          monitoredStudentId === undefined
            ? undefined
            : monitoredStudentId ?? 'none',
        page,
        pageSize,
      });
      setQuestions(res.questions);
      setStimuliById(res.stimuliById || {});
      setTotalMatching(Number(res.totalMatching ?? 0));
      setOpenFlagsByQid(res.openFlagsByQuestionId || {});
      setProgressByQid(res.progressByQuestionId || {});
      setPoolHealth(res.poolHealth ?? null);
      setMasteredLiveIds(res.masteredLiveQuestionIds || []);
      setBatchSummaries(res.batchSummaries || []);
      setSelectedQid((prev) => {
        if (res.questions.length === 0) return '';
        return res.questions.some((q) => q.questionId === prev)
          ? prev
          : res.questions[0].questionId;
      });
    } catch (err) {
      onError(err instanceof Error ? err.message : isZh ? '无法加载题库。' : 'Unable to load the Question Bank.');
    } finally {
      setLoading(false);
    }
  }, [
    search,
    section,
    poolStatus,
    completionStatus,
    batchId,
    formatType,
    skillId,
    poolType,
    sort,
    flaggedOnly,
    missingVisual,
    missingExplanation,
    includeHistorical,
    monitoredStudentId,
    page,
    pageSize,
    onError,
  ]);

  useEffect(() => {
    void loadQuestions();
  }, [loadQuestions]);

  // Keep selected question ID in URL for deep linking
  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    if (selectedQid) {
      qs.set('qid', selectedQid);
    } else {
      qs.delete('qid');
    }
    const nextSearch = `?${qs.toString()}`;
    if (window.location.search !== nextSearch) {
      window.history.replaceState({}, '', `${window.location.pathname}${nextSearch}`);
    }
  }, [selectedQid]);

  // Load version history for selected question
  useEffect(() => {
    if (!selectedQid) {
      setVersionsForSelected([]);
      return;
    }
    let active = true;
    api
      .getQuestionVersions(selectedQid)
      .then((res) => {
        if (active) setVersionsForSelected(res.versions.map((v) => v.question));
      })
      .catch(() => {
        if (active) setVersionsForSelected([]);
      });
    return () => {
      active = false;
    };
  }, [selectedQid]);

  const selectedQuestion = useMemo(
    () => questions.find((q) => q.questionId === selectedQid) || questions[0] || null,
    [questions, selectedQid]
  );

  const selectedStimulus = selectedQuestion?.stimulusId
    ? stimuliById[selectedQuestion.stimulusId]
    : undefined;

  const filteredBatchOptions = useMemo(() => {
    const q = batchSearch.trim().toLowerCase();
    if (!q) return batchSummaries.slice(0, 60);
    return batchSummaries
      .filter(
        (b) =>
          b.batchLabel.toLowerCase().includes(q) || b.batchId.toLowerCase().includes(q)
      )
      .slice(0, 60);
  }, [batchSummaries, batchSearch]);

  const filteredSkills = useMemo(
    () => (section ? SKILLS_TAXONOMY.filter((s) => s.section === section) : SKILLS_TAXONOMY),
    [section]
  );

  const activeAdvancedFilterCount = [
    batchId,
    formatType,
    skillId,
    poolType,
    flaggedOnly ? '1' : '',
    missingVisual ? '1' : '',
    missingExplanation ? '1' : '',
    includeHistorical ? '1' : '',
  ].filter(Boolean).length;

  const totalPages = Math.max(1, Math.ceil(totalMatching / pageSize));

  const resetAllFilters = () => {
    setSearch('');
    setSection('');
    setPoolStatus('');
    setCompletionStatus('');
    setBatchId('');
    setBatchSearch('');
    setFormatType('');
    setSkillId('');
    setPoolType('');
    setSort('id_asc');
    setFlaggedOnly(false);
    setMissingVisual(false);
    setMissingExplanation(false);
    setIncludeHistorical(false);
    setPage(1);
  };

  const handleSetPoolStatus = async (qid: string, nextStatus: BankPoolStatus) => {
    const current = questions.find((q) => q.questionId === qid);
    if (!current) return;
    const prevStatus = qcStatusToPoolStatus(current.qcStatus);
    if (prevStatus === nextStatus || updatingStatusQid === qid) return;

    const nextQcStatus = poolStatusToQcStatus(nextStatus);
    setUpdatingStatusQid(qid);
    // Optimistically reflect the updated status immediately so switching feels crisp
    setQuestions((prev) =>
      prev.map((q) => (q.questionId === qid ? { ...q, qcStatus: nextQcStatus } : q))
    );
    try {
      await api.updateQuestionStatus(qid, nextQcStatus);
      onNotice(
        isZh
          ? `已将 ${qid} 状态设为“${poolStatusLabel(nextStatus)}”。`
          : `Set ${qid} to ${poolStatusLabel(nextStatus)}.`
      );
      await loadQuestions();
      onDataMutated?.();
    } catch (err) {
      // Revert optimistic update on failure
      setQuestions((prev) =>
        prev.map((q) => (q.questionId === qid ? { ...q, qcStatus: current.qcStatus } : q))
      );
      onError(err instanceof Error ? err.message : isZh ? '无法更新题目状态。' : 'Unable to update question status.');
    } finally {
      setUpdatingStatusQid(null);
    }
  };

  const handleBulkStatus = async (ids: string[], nextStatus: BankPoolStatus, label?: string) => {
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      const res = await api.bulkUpdateQuestionStatus(ids, poolStatusToQcStatus(nextStatus));
      setCheckedQids([]);
      setConfirmBulkDelete(false);
      onNotice(
        label ||
          (isZh
            ? `已将 ${res.updatedCount} 道题目设为“${poolStatusLabel(nextStatus)}”。`
            : `Updated ${res.updatedCount} question${res.updatedCount === 1 ? '' : 's'} to ${poolStatusLabel(nextStatus)}.`)
      );
      await loadQuestions();
      onDataMutated?.();
    } catch (err) {
      onError(err instanceof Error ? err.message : isZh ? '批量更新状态失败。' : 'Bulk status update failed.');
    } finally {
      setBulkBusy(false);
    }
  };

  const handleDeleteQuestions = async (ids: string[]) => {
    if (ids.length === 0 || deletingBusy) return;
    setDeletingBusy(true);
    try {
      const res = await api.deleteQuestions(ids);
      const deletedSet = new Set(ids);
      setCheckedQids((prev) => prev.filter((id) => !deletedSet.has(id)));
      setConfirmDeleteQid(null);
      setConfirmBulkDelete(false);
      onNotice(
        isZh
          ? `已从题库永久删除 ${res.deletedCount} 道题目。`
          : `Permanently deleted ${res.deletedCount} question${res.deletedCount === 1 ? '' : 's'} from the Question Bank.`
      );
      await loadQuestions();
      onDataMutated?.();
    } catch (err) {
      onError(err instanceof Error ? err.message : isZh ? '删除题目失败。' : 'Failed to delete question(s).');
    } finally {
      setDeletingBusy(false);
    }
  };

  const handleLaunchQuickPractice = async (useCheckedOnly: boolean) => {
    setLaunchingSim(true);
    try {
      const timerMin = Number(simTimerMin) || 0;
      const customTimeLimitSec = timerMin > 0 ? timerMin * 60 : undefined;
      const limitNum = simLimit === 'ALL' ? 120 : Math.max(1, Number(simLimit) || 10);

      let res: { sessionId: string; count: number };
      if (useCheckedOnly && checkedQids.length > 0) {
        res = await api.createCalibrationSession({
          questionIds: checkedQids,
          limit: checkedQids.length,
          customTimeLimitSec,
          isSandbox: simSandbox,
        });
      } else {
        // Use currently visible/matching filtered items when completion/poolStatus filters are active
        const poolQcFilter =
          poolStatus === 'live'
            ? 'active'
            : poolStatus === 'archived'
              ? 'retired'
              : poolStatus === 'paused'
                ? 'quarantined'
                : undefined;

        const useDirectIds = Boolean(completionStatus || search.trim() || flaggedOnly || missingVisual || missingExplanation);
        if (useDirectIds) {
          const idPool = questions.slice(0, limitNum).map((q) => q.questionId);
          if (idPool.length === 0) {
            onError(isZh ? '没有符合当前筛选条件的题目。' : 'No questions match your current filters.');
            return;
          }
          res = await api.createCalibrationSession({
            questionIds: idPool,
            limit: idPool.length,
            customTimeLimitSec,
            isSandbox: simSandbox,
          });
        } else {
          res = await api.createCalibrationSession({
            section: section || undefined,
            poolType: poolType || undefined,
            qcStatus: poolQcFilter || 'active',
            formatType: formatType || undefined,
            skillId: skillId || undefined,
            batchId: batchId || undefined,
            includeHistorical,
            limit: limitNum,
            customTimeLimitSec,
            isSandbox: simSandbox,
          });
        }
      }
      onOpenSession(res.sessionId);
    } catch (err) {
      onError(err instanceof Error ? err.message : isZh ? '无法启动练习。' : 'Could not launch practice session.');
    } finally {
      setLaunchingSim(false);
    }
  };

  const handleVisualUpload = async (e: ChangeEvent<HTMLInputElement>, qid: string) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingQid(qid);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('Failed to read image file.'));
        reader.readAsDataURL(file);
      });
      await api.attachQuestionVisual(qid, {
        altText: `Diagram for ${qid}`,
        imageBase64: dataUrl,
        filename: file.name,
      });
      onNotice(isZh ? `已上传 ${qid} 的配图资源。` : `Uploaded visual asset for ${qid}.`);
      await loadQuestions();
    } catch (err) {
      onError(err instanceof Error ? err.message : isZh ? '上传配图失败。' : 'Failed to attach visual.');
    } finally {
      setUploadingQid(null);
      e.target.value = '';
    }
  };

  const toggleCheck = (qid: string) => {
    setCheckedQids((prev) =>
      prev.includes(qid) ? prev.filter((id) => id !== qid) : [...prev, qid]
    );
  };

  const allOnPageChecked =
    questions.length > 0 && questions.every((q) => checkedQids.includes(q.questionId));

  const toggleAllOnPage = () => {
    if (allOnPageChecked) {
      const pageIds = new Set(questions.map((q) => q.questionId));
      setCheckedQids((prev) => prev.filter((id) => !pageIds.has(id)));
    } else {
      setCheckedQids((prev) => Array.from(new Set([...prev, ...questions.map((q) => q.questionId)])));
    }
  };

  const urgencyStyles =
    poolHealth?.refreshUrgency === 'refresh_needed'
      ? 'bg-[#FDECEB] border-[#B83A28]/25 text-[#B83A28]'
      : poolHealth?.refreshUrgency === 'top_up_soon'
        ? 'bg-[#FDF0E2] border-[#A35116]/25 text-[#A35116]'
        : 'bg-[#E5F0EA] border-[#C5DDD1] text-[#113C36]';

  return (
    <div className="space-y-5">
      {/* Pool Health & Freshness Strip */}
      {poolHealth && (
        <section className="rounded-[16px] bg-[#FAF8F5] border border-[#E5DFD5] p-5 space-y-4 overflow-hidden">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1 min-w-0 flex-1">
              <h2 className="font-sans-display font-semibold text-[16px] text-[#113C36]">
                {t('bank.poolHealthTitle')}
              </h2>
              <p className="text-xs text-[#4A5955] max-w-2xl leading-relaxed break-words">
                {monitoredLearner === null && monitoredStudentId === null
                  ? t('bank.catalogModeAdvice', {
                      total: poolHealth.liveCount,
                    })
                  : poolHealth.refreshAdvice}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                aria-expanded={showGlossary}
                onClick={() => setShowGlossary((v) => !v)}
                className="px-3 py-1 rounded-full border border-[#CFC6B9] bg-white hover:bg-[#F3EFE8] text-xs font-medium text-[#4A5955] inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
              >
                <HelpCircle className="w-3.5 h-3.5 text-[#113C36] shrink-0" />
                <span>{t('bank.glossaryBtn')}</span>
              </button>
              <span className={`px-3 py-1 rounded-full border text-xs font-medium tabular-nums whitespace-nowrap ${urgencyStyles}`}>
                {monitoredLearner
                  ? t('bank.learnerRunwayBadge', {
                      name:
                        monitoredLearner.displayName ||
                        monitoredLearner.email ||
                        monitoredLearner.uid,
                      pct: poolHealth.unseenLivePercent,
                      days: poolHealth.estimatedRunwayDays,
                    })
                  : monitoredStudentId === null
                    ? t('bank.catalogInventoryBadge', {
                        count: poolHealth.liveCount,
                      })
                    : t('bank.unseenRunwayBadge', {
                        pct: poolHealth.unseenLivePercent,
                        days: poolHealth.estimatedRunwayDays,
                      })}
              </span>
              {monitoredLearner && studentCount <= 1 && masteredLiveIds.length > 0 && (
                <button
                  type="button"
                  disabled={bulkBusy}
                  onClick={() =>
                    handleBulkStatus(
                      masteredLiveIds,
                      'archived',
                      isZh
                        ? `已将 ${masteredLiveIds.length} 道已掌握题目移至“已归档”。`
                        : `Archived ${masteredLiveIds.length} mastered question${masteredLiveIds.length === 1 ? '' : 's'} out of the active pool.`
                    )
                  }
                  className="px-3.5 py-1.5 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#113C36] hover:text-white hover:border-[#113C36] text-xs font-sans-display font-semibold text-[#113C36] inline-flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap"
                >
                  <Archive className="w-3.5 h-3.5 shrink-0" />
                  <span>{t('bank.archiveMasteredBtn', { count: masteredLiveIds.length })}</span>
                </button>
              )}
            </div>
          </div>

          {showGlossary && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 rounded-[12px] bg-white border border-[#E5DFD5] p-4 text-xs text-[#4A5955] leading-relaxed">
              <div className="space-y-1 min-w-0">
                <div className="font-sans-display font-semibold text-[#113C36]">
                  {t('bank.holdoutGlossaryTitle')}
                </div>
                <p className="break-words">{t('bank.holdoutGlossaryBody')}</p>
              </div>
              <div className="space-y-1 min-w-0">
                <div className="font-sans-display font-semibold text-[#113C36]">
                  {t('bank.repairGlossaryTitle')}
                </div>
                <p className="break-words">{t('bank.repairGlossaryBody')}</p>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <div className="min-w-0 rounded-[12px] bg-white border border-[#E5DFD5] px-3.5 py-2.5">
              <div className="text-xs text-[#78756E] truncate">{t('bank.cardInPool')}</div>
              <div className="mt-0.5 font-serif-display font-extrabold text-[24px] leading-tight text-[#113C36] tabular-nums">
                {poolHealth.liveCount}
              </div>
              <div className="text-[11px] text-[#78756E] tabular-nums break-words leading-snug">
                {poolHealth.holdoutCount > 0
                  ? t('bank.cardHoldoutSub', { count: poolHealth.holdoutCount })
                  : t('bank.cardAllActiveSub')}
              </div>
            </div>
            <div className="min-w-0 rounded-[12px] bg-white border border-[#E5DFD5] px-3.5 py-2.5">
              <div className="text-xs text-[#78756E] truncate">
                {monitoredStudentId === null
                  ? t('bank.cardCatalogActive')
                  : monitoredLearner
                    ? `${t('bank.cardUnseen')} · ${
                        monitoredLearner.displayName ||
                        monitoredLearner.email ||
                        monitoredLearner.uid
                      }`
                    : t('bank.cardUnseen')}
              </div>
              <div className="mt-0.5 font-serif-display font-extrabold text-[24px] leading-tight text-[#113C36] tabular-nums">
                {monitoredStudentId === null
                  ? '—'
                  : poolHealth.unseenLiveCount}
              </div>
              <div className="text-[11px] text-[#78756E] tabular-nums break-words leading-snug">
                R {poolHealth.bySectionLive.READ.unseen} · M {poolHealth.bySectionLive.MATH.unseen} · T {poolHealth.bySectionLive.THINK.unseen}
              </div>
            </div>
            <div className="min-w-0 rounded-[12px] bg-white border border-[#E5DFD5] px-3.5 py-2.5">
              <div className="text-xs text-[#78756E] truncate">
                {monitoredLearner
                  ? `${t('bank.cardDone')} · ${
                      monitoredLearner.displayName ||
                      monitoredLearner.email ||
                      monitoredLearner.uid
                    }`
                  : t('bank.cardDone')}
              </div>
              <div className="mt-0.5 font-serif-display font-extrabold text-[24px] leading-tight text-[#1F7A4C] tabular-nums">
                {poolHealth.doneLiveCount}
              </div>
              <div className="text-[11px] text-[#78756E] tabular-nums break-words leading-snug">
                {t('bank.cardReviewRepairSub', {
                  review: poolHealth.inReviewLiveCount,
                  repair: poolHealth.needsRepairLiveCount,
                })}
              </div>
            </div>
            <div className="min-w-0 rounded-[12px] bg-white border border-[#E5DFD5] px-3.5 py-2.5">
              <div className="text-xs text-[#78756E] truncate">{t('bank.cardPaused')}</div>
              <div className="mt-0.5 font-serif-display font-extrabold text-[24px] leading-tight text-[#A35116] tabular-nums">
                {poolHealth.pausedCount}
              </div>
              <div className="text-[11px] text-[#78756E] break-words leading-snug">{t('bank.cardPausedSub')}</div>
            </div>
            <div className="min-w-0 col-span-2 sm:col-span-1 rounded-[12px] bg-white border border-[#E5DFD5] px-3.5 py-2.5">
              <div className="text-xs text-[#78756E] truncate">{t('bank.cardArchived')}</div>
              <div className="mt-0.5 font-serif-display font-extrabold text-[24px] leading-tight text-[#78756E] tabular-nums">
                {poolHealth.archivedCount}
              </div>
              <div className="text-[11px] text-[#78756E] break-words leading-snug">{t('bank.cardArchivedSub')}</div>
            </div>
          </div>
        </section>
      )}

      {/* Clean Two-Zone Filter & Quick Practice Card */}
      <section className="rounded-[16px] bg-white border border-[#E5DFD5] overflow-hidden">
        <div className="p-4 space-y-3">
          {/* Row 1: Search + Filters toggle + Clear + Refresh */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="w-4 h-4 text-[#78756E] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="search"
                aria-label={t('bank.searchPlaceholder')}
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                placeholder={t('bank.searchPlaceholder')}
                className="w-full pl-9 pr-8 py-2 rounded-[10px] border border-[#E5DFD5] bg-[#FAF8F5] focus:bg-white text-sm text-[#113C36] placeholder:text-[#78756E] focus:outline-none focus:border-[#113C36] transition-colors"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => {
                    setSearch('');
                    setPage(1);
                  }}
                  aria-label={t('bank.clearFilters')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 text-[#78756E] hover:text-[#113C36] cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => setShowMoreFilters((v) => !v)}
                aria-expanded={showMoreFilters}
                className={`px-3 py-2 rounded-[10px] border text-xs font-sans-display font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-colors whitespace-nowrap ${
                  showMoreFilters || activeAdvancedFilterCount > 0
                    ? 'bg-[#E5F0EA] border-[#C5DDD1] text-[#113C36]'
                    : 'bg-white border-[#E5DFD5] text-[#4A5955] hover:bg-[#FAF8F5]'
                }`}
              >
                <SlidersHorizontal className="w-3.5 h-3.5 shrink-0" />
                <span>
                  {t('bank.filtersBtn')}
                  {activeAdvancedFilterCount > 0 ? ` (${activeAdvancedFilterCount})` : ''}
                </span>
                {showMoreFilters ? (
                  <ChevronUp className="w-3.5 h-3.5 shrink-0" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5 shrink-0" />
                )}
              </button>

              {(search || section || poolStatus || completionStatus || activeAdvancedFilterCount > 0) && (
                <button
                  type="button"
                  onClick={resetAllFilters}
                  className="px-2.5 py-2 rounded-[10px] border border-[#E5DFD5] bg-[#FAF8F5] hover:bg-[#ECE8E1] text-xs font-sans-display font-semibold text-[#4A5955] hover:text-[#113C36] inline-flex items-center gap-1 cursor-pointer whitespace-nowrap transition-colors"
                >
                  <X className="w-3.5 h-3.5 shrink-0" />
                  <span>{t('bank.clearFilters')}</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => void loadQuestions()}
                className="px-3 py-2 rounded-[10px] border border-[#E5DFD5] bg-white hover:bg-[#FAF8F5] text-xs font-sans-display font-semibold text-[#4A5955] inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap transition-colors"
              >
                <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${loading ? 'animate-spin' : ''}`} />
                <span>{t('bank.refresh')}</span>
              </button>
            </div>
          </div>

          {/* Row 2: 5-tab Section Segmented Bar + Pool & Progress Compact Selects */}
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <div
              role="group"
              aria-label={t('bank.allSections')}
              className="inline-flex flex-wrap items-center p-1 rounded-[12px] bg-[#FAF8F5] border border-[#E5DFD5] gap-0.5 max-w-full"
            >
              {SECTION_VALUES.map((secVal) => {
                const active = section === secVal;
                const label = secVal ? sectionShortLabel(secVal) : t('bank.allSections');
                return (
                  <button
                    key={secVal || 'all-sec'}
                    type="button"
                    onClick={() => {
                      setSection(secVal);
                      setSkillId('');
                      setPage(1);
                    }}
                    className={`px-3 py-1 rounded-[9px] text-[12px] font-medium whitespace-nowrap cursor-pointer transition-colors ${
                      active
                        ? 'bg-[#113C36] text-white shadow-xs'
                        : 'text-[#4A5955] hover:text-[#113C36] hover:bg-white/80'
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center gap-2 min-w-0">
              <CompactSelect
                value={poolStatus}
                onChange={(v) => {
                  setPoolStatus(v as '' | BankPoolStatus);
                  setPage(1);
                }}
                ariaLabel={t('bank.poolLabel')}
                className="min-w-[144px]"
              >
                {POOL_STATUS_VALUES.map((val) => (
                  <option key={val || 'all-pool'} value={val}>
                    {val ? poolStatusLabel(val) : t('bank.allStatuses')}
                  </option>
                ))}
              </CompactSelect>

              <CompactSelect
                value={completionStatus}
                onChange={(v) => {
                  setCompletionStatus(v as '' | QuestionCompletionStatus);
                  setPage(1);
                }}
                ariaLabel={t('bank.progressLabel')}
                className="min-w-[152px]"
              >
                {COMPLETION_VALUES.map((val) => (
                  <option key={val || 'all-comp'} value={val}>
                    {val ? completionStatusLabel(val) : t('bank.allProgress')}
                  </option>
                ))}
              </CompactSelect>
            </div>
          </div>

          {/* Expandable Secondary Filters Drawer (1 field per grid track) */}
          {showMoreFilters && (
            <div className="rounded-[12px] bg-[#FAF8F5] border border-[#E5DFD5] p-3.5 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5">
                <div className="min-w-0 space-y-1">
                  <span className="block text-[11px] font-medium text-[#78756E] truncate">
                    {t('bank.batchLabel', { count: batchSummaries.length })}
                  </span>
                  {batchSummaries.length > 12 && (
                    <input
                      type="text"
                      value={batchSearch}
                      onChange={(e) => setBatchSearch(e.target.value)}
                      placeholder={t('batch.searchPlaceholder')}
                      className="w-full px-2.5 py-1 rounded-[8px] border border-[#E5DFD5] bg-white text-[12px] text-[#113C36] focus:outline-none focus:border-[#113C36]"
                    />
                  )}
                  <CompactSelect
                    value={batchId}
                    onChange={(v) => {
                      setBatchId(v);
                      setPage(1);
                    }}
                    ariaLabel={t('bank.batchLabel', { count: batchSummaries.length })}
                  >
                    <option value="">{t('bank.allBatches')}</option>
                    {filteredBatchOptions.map((b) => (
                      <option key={b.batchId} value={b.batchId}>
                        {t('bank.batchOption', {
                          label: b.batchLabel,
                          unseen: b.unseen,
                          total: b.total,
                        })}
                      </option>
                    ))}
                  </CompactSelect>
                </div>

                <CompactSelect
                  label={t('bank.skillLabel')}
                  value={skillId}
                  onChange={(v) => {
                    setSkillId(v);
                    setPage(1);
                  }}
                >
                  <option value="">{t('bank.allSkills')}</option>
                  {filteredSkills.map((s) => (
                    <option key={s.skillId} value={s.skillId}>
                      {skillName(s.skillId)}
                    </option>
                  ))}
                </CompactSelect>

                <CompactSelect
                  label={t('bank.formatLabel')}
                  value={formatType}
                  onChange={(v) => {
                    setFormatType(v);
                    setPage(1);
                  }}
                >
                  <option value="">{t('bank.allFormats')}</option>
                  {Object.keys(FORMAT_LABELS).map((k) => (
                    <option key={k} value={k}>
                      {formatLabel(k)}
                    </option>
                  ))}
                </CompactSelect>

                <CompactSelect
                  label={t('bank.isolationLabel')}
                  value={poolType}
                  onChange={(v) => {
                    setPoolType(v);
                    setPage(1);
                  }}
                >
                  <option value="">{t('bank.allPools')}</option>
                  <option value="practice">{t('bank.practicePool')}</option>
                  <option value="benchmark_holdout">{t('bank.holdoutPool')}</option>
                </CompactSelect>

                <CompactSelect
                  label={t('bank.sortLabel')}
                  value={sort}
                  onChange={(v) => setSort(v as typeof sort)}
                >
                  <option value="id_asc">{t('bank.sortIdAsc')}</option>
                  <option value="updated_desc">{t('bank.sortUpdatedDesc')}</option>
                  <option value="version_desc">{t('bank.sortVersionDesc')}</option>
                </CompactSelect>
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-[#4A5955] pt-0.5">
                <label className="inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={flaggedOnly}
                    onChange={(e) => {
                      setFlaggedOnly(e.target.checked);
                      setPage(1);
                    }}
                    className="accent-[#113C36]"
                  />
                  <span>{t('bank.flaggedOnly')}</span>
                </label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={missingVisual}
                    onChange={(e) => {
                      setMissingVisual(e.target.checked);
                      setPage(1);
                    }}
                    className="accent-[#113C36]"
                  />
                  <span>{t('bank.missingVisual')}</span>
                </label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={missingExplanation}
                    onChange={(e) => {
                      setMissingExplanation(e.target.checked);
                      setPage(1);
                    }}
                    className="accent-[#113C36]"
                  />
                  <span>{t('bank.missingExplanation')}</span>
                </label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={includeHistorical}
                    onChange={(e) => {
                      setIncludeHistorical(e.target.checked);
                      setPage(1);
                    }}
                    className="accent-[#113C36]"
                  />
                  <span>{t('bank.includeHistorical')}</span>
                </label>
              </div>
            </div>
          )}
        </div>

        {/* Dedicated Footer Strip: Quick Practice OR Selection Bulk Bar (never collide) */}
        {checkedQids.length === 0 ? (
          <div className="px-4 py-3 bg-[#FAF8F5] border-t border-[#E5DFD5] flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2.5 text-xs min-w-0">
              <span className="inline-flex items-center gap-1.5 font-sans-display font-semibold text-[#113C36] whitespace-nowrap">
                <Sparkles className="w-3.5 h-3.5 text-[#113C36] shrink-0" />
                <span>{t('bank.quickPractice')}</span>
              </span>

              <CompactSelect
                value={simLimit}
                onChange={setSimLimit}
                ariaLabel={t('bank.quickPractice')}
                className="min-w-[126px]"
              >
                <option value="5">{t('home.nQuestions', { count: 5 })}</option>
                <option value="10">{t('home.nQuestions', { count: 10 })}</option>
                <option value="15">{t('home.nQuestions', { count: 15 })}</option>
                <option value="25">{t('home.nQuestions', { count: 25 })}</option>
                <option value="ALL">{t('bank.allMatching')}</option>
              </CompactSelect>

              <CompactSelect
                value={simTimerMin}
                onChange={setSimTimerMin}
                ariaLabel={t('home.timerSetting')}
                className="min-w-[112px]"
              >
                <option value="0">{t('bank.untimed')}</option>
                <option value="10">{t('home.minShort', { min: 10 })}</option>
                <option value="20">{t('home.minShort', { min: 20 })}</option>
                <option value="40">{t('home.minShort', { min: 40 })}</option>
              </CompactSelect>

              <label className="inline-flex items-center gap-1.5 text-[#4A5955] cursor-pointer whitespace-nowrap">
                <input
                  type="checkbox"
                  checked={simSandbox}
                  onChange={(e) => setSimSandbox(e.target.checked)}
                  className="accent-[#113C36]"
                />
                <span>{t('bank.sandboxClean')}</span>
              </label>
            </div>

            <button
              type="button"
              disabled={launchingSim || totalMatching === 0}
              onClick={() => handleLaunchQuickPractice(false)}
              className="px-4 py-2 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-xs font-sans-display font-semibold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0 transition-colors"
            >
              <Play className="w-3 h-3 fill-current shrink-0" />
              <span>{launchingSim ? t('bank.launching') : t('bank.practiceFiltered')}</span>
            </button>
          </div>
        ) : (
          <div className="px-4 py-3 bg-[#E5F0EA]/65 border-t border-[#C5DDD1] flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2.5 text-xs">
              <span className="font-sans-display font-semibold text-[#113C36] tabular-nums whitespace-nowrap">
                {t('bank.selectedCount', { count: checkedQids.length })}
              </span>
              <button
                type="button"
                onClick={() => {
                  setCheckedQids([]);
                  setConfirmBulkDelete(false);
                }}
                className="text-xs font-medium text-[#4A5955] hover:text-[#113C36] underline underline-offset-4 cursor-pointer whitespace-nowrap"
              >
                {t('bank.clearSelection')}
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={bulkBusy}
                onClick={() => handleBulkStatus(checkedQids, 'live')}
                className="px-2.5 py-1.5 rounded-[8px] border border-[#C5DDD1] bg-white hover:bg-[#E5F0EA] text-[#113C36] text-xs font-sans-display font-semibold cursor-pointer disabled:opacity-50 whitespace-nowrap"
              >
                {t('bank.moveToPool')}
              </button>
              <button
                type="button"
                disabled={bulkBusy}
                onClick={() => handleBulkStatus(checkedQids, 'paused')}
                className="px-2.5 py-1.5 rounded-[8px] border border-[#EED3B6] bg-[#FDF0E2] text-[#A35116] text-xs font-sans-display font-semibold cursor-pointer disabled:opacity-50 whitespace-nowrap"
              >
                {t('bank.pause')}
              </button>
              <button
                type="button"
                disabled={bulkBusy || deletingBusy}
                onClick={() => handleBulkStatus(checkedQids, 'archived')}
                className="px-2.5 py-1.5 rounded-[8px] border border-[#CFC6B9] bg-white text-[#4A5955] text-xs font-sans-display font-semibold cursor-pointer disabled:opacity-50 whitespace-nowrap"
              >
                {t('bank.archive')}
              </button>
              {confirmBulkDelete ? (
                <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded-[8px] bg-[#FDECEB] border border-[#B83A28]/30 whitespace-nowrap">
                  <button
                    type="button"
                    disabled={deletingBusy}
                    onClick={() => void handleDeleteQuestions(checkedQids)}
                    className="px-2 py-0.5 rounded-[6px] bg-[#B83A28] hover:bg-[#992D1E] text-white text-xs font-sans-display font-semibold cursor-pointer disabled:opacity-50"
                  >
                    {deletingBusy
                      ? t('bank.deleting')
                      : t('bank.confirmDelete', { count: checkedQids.length })}
                  </button>
                  <button
                    type="button"
                    disabled={deletingBusy}
                    onClick={() => setConfirmBulkDelete(false)}
                    className="px-2 py-0.5 text-xs font-medium text-[#4A5955] hover:text-[#113C36] cursor-pointer"
                  >
                    {t('home.modalCancel')}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={bulkBusy || deletingBusy}
                  onClick={() => setConfirmBulkDelete(true)}
                  className="px-2.5 py-1.5 rounded-[8px] border border-[#B83A28]/30 bg-[#FDECEB] hover:bg-[#B83A28] hover:text-white text-[#B83A28] text-xs font-sans-display font-semibold inline-flex items-center gap-1 transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap"
                >
                  <Trash2 className="w-3.5 h-3.5 shrink-0" />
                  <span>{t('bank.delete')}</span>
                </button>
              )}
              <button
                type="button"
                disabled={launchingSim}
                onClick={() => handleLaunchQuickPractice(true)}
                className="px-3.5 py-1.5 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-xs font-sans-display font-semibold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50 whitespace-nowrap"
              >
                <Play className="w-3 h-3 fill-current shrink-0" />
                <span>{t('bank.practiceSelected', { count: checkedQids.length })}</span>
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Master-Detail Question Bank Split */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Left List */}
        <section className="lg:col-span-5 min-w-0 rounded-[16px] bg-white border border-[#E5DFD5] overflow-hidden">
          <div className="px-4 py-3 bg-[#FAF8F5] border-b border-[#E5DFD5] flex flex-wrap items-center justify-between gap-2 text-xs">
            <label className="inline-flex items-center gap-2 font-medium text-[#4A5955] cursor-pointer whitespace-nowrap">
              <input
                type="checkbox"
                checked={allOnPageChecked}
                onChange={toggleAllOnPage}
                className="accent-[#113C36]"
              />
              <span className="tabular-nums">
                {totalMatching === 1
                  ? t('bank.questionOne')
                  : t('bank.questionMany', { count: totalMatching })}
              </span>
            </label>

            <div className="flex items-center gap-1.5 shrink-0">
              <select
                aria-label="Items per page"
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(1);
                }}
                className="px-2 py-1 rounded-[8px] border border-[#CFC6B9] bg-white text-xs text-[#4A5955]"
              >
                <option value={25}>{t('bank.perPage', { count: 25 })}</option>
                <option value={50}>{t('bank.perPage', { count: 50 })}</option>
                <option value={100}>{t('bank.perPage', { count: 100 })}</option>
              </select>
              <button
                type="button"
                aria-label={t('session.previous')}
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="p-1 rounded-[8px] border border-[#CFC6B9] bg-white text-[#4A5955] disabled:opacity-40 cursor-pointer"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <span className="tabular-nums text-[#4A5955] px-1">
                {page}/{totalPages}
              </span>
              <button
                type="button"
                aria-label={t('session.next')}
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="p-1 rounded-[8px] border border-[#CFC6B9] bg-white text-[#4A5955] disabled:opacity-40 cursor-pointer"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div className="divide-y divide-[#E5DFD5] max-h-[680px] overflow-y-auto">
            {loading && questions.length === 0 ? (
              <div className="p-8 text-center text-sm text-[#78756E]">{t('bank.loading')}</div>
            ) : questions.length === 0 ? (
              <div className="p-8 text-center space-y-2">
                <p className="text-sm font-medium text-[#113C36]">{t('bank.empty')}</p>
                <button
                  type="button"
                  onClick={resetAllFilters}
                  className="text-xs font-sans-display font-semibold text-[#113C36] underline underline-offset-4 cursor-pointer"
                >
                  {t('bank.resetFilters')}
                </button>
              </div>
            ) : (
              questions.map((q) => {
                const isSelected = selectedQuestion?.questionId === q.questionId;
                const isChecked = checkedQids.includes(q.questionId);
                const pStatus = qcStatusToPoolStatus(q.qcStatus);
                const meta = progressByQid[q.questionId];
                const compStatus: QuestionCompletionStatus = meta?.completionStatus ?? 'unseen';
                const flagsCount = openFlagsByQid[q.questionId] || 0;

                return (
                  <div
                    key={q.questionId}
                    className={`px-3.5 py-3 flex items-start gap-2.5 transition-colors ${
                      isSelected ? 'bg-[#E5F0EA]/60' : 'hover:bg-[#FAF8F5]'
                    }`}
                  >
                    <input
                      type="checkbox"
                      aria-label={`Select ${q.questionId}`}
                      checked={isChecked}
                      onChange={() => toggleCheck(q.questionId)}
                      className="mt-1 accent-[#113C36] shrink-0 cursor-pointer"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedQid(q.questionId);
                        setConfirmDeleteQid(null);
                        setPreviewEvidenceRef(null);
                      }}
                      className="flex-1 min-w-0 text-left space-y-1.5 cursor-pointer"
                    >
                      <div className="flex items-center justify-between gap-2 min-w-0">
                        <span className="font-mono-code text-[11px] font-semibold text-[#113C36] truncate min-w-0 flex-1">
                          {q.questionId}
                        </span>
                        <div className="flex items-center gap-1 shrink-0 whitespace-nowrap">
                          <span
                            className={`px-2 py-0.5 rounded-full border text-[11px] font-medium ${getPoolBadgeClasses(pStatus)}`}
                          >
                            {poolStatusLabel(pStatus)}
                          </span>
                          <span
                            className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${getCompletionBadgeClasses(compStatus)}`}
                          >
                            {completionStatusLabel(compStatus)}
                          </span>
                        </div>
                      </div>
                      <p className="text-xs text-[#4A5955] line-clamp-2 leading-relaxed break-words">
                        {q.stemPrefix ||
                          q.parts[0]?.promptText ||
                          (q.stimulusId ? stimuliById[q.stimulusId]?.title : '') ||
                          t('bank.untitled')}
                      </p>
                      <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#78756E]">
                        <span>{sectionLabel(q.section)}</span>
                        <span>{formatLabel(q.formatType)}</span>
                        {q.poolType === 'benchmark_holdout' && (
                          <span className="text-[#A35116] font-medium">{t('bank.holdoutTag')}</span>
                        )}
                        {flagsCount > 0 && (
                          <span className="text-[#B83A28] font-medium">
                            {flagsCount === 1
                              ? t('bank.flagOne')
                              : t('bank.flagMany', { count: flagsCount })}
                          </span>
                        )}
                      </div>
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* Right Preview & Controls */}
        <section className="lg:col-span-7 min-w-0 rounded-[16px] bg-white border border-[#E5DFD5] p-5 space-y-4 overflow-hidden">
          {!selectedQuestion ? (
            <div className="py-16 text-center text-sm text-[#78756E]">
              {t('bank.selectOnePrompt')}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3 pb-3.5 border-b border-[#E5DFD5]">
                <div className="space-y-1 min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <h3 className="font-mono-code text-sm font-semibold text-[#113C36] break-all">
                      {selectedQuestion.questionId}
                    </h3>
                    <span className="px-2 py-0.5 rounded-full bg-[#F3EFE8] text-[11px] font-medium text-[#4A5955] whitespace-nowrap">
                      v{selectedQuestion.version}
                    </span>
                    {selectedQuestion.batchLabel && (
                      <span
                        title={selectedQuestion.batchLabel}
                        className="px-2 py-0.5 rounded-full bg-[#FAF8F5] border border-[#E5DFD5] text-[11px] text-[#4A5955] max-w-full truncate inline-block"
                      >
                        {selectedQuestion.batchLabel}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-[#78756E] flex flex-wrap gap-3">
                    <span>
                      {t('bank.progressMeta')}{' '}
                      <strong className="text-[#113C36]">
                        {completionStatusLabel(
                          progressByQid[selectedQuestion.questionId]?.completionStatus ?? 'unseen'
                        )}
                      </strong>
                    </span>
                    <span>
                      {t('bank.attemptsMeta')} {progressByQid[selectedQuestion.questionId]?.attemptsCount ?? 0}
                    </span>
                    <span>
                      {t('bank.lastSeenMeta')}{' '}
                      {progressByQid[selectedQuestion.questionId]?.lastAttemptAtIso
                        ? formatDate(progressByQid[selectedQuestion.questionId]?.lastAttemptAtIso)
                        : t('bank.never')}
                    </span>
                  </div>
                </div>

                {/* Interactive 3-State Pool Switcher + Permanent Delete */}
                <div className="flex flex-col items-start sm:items-end gap-2 max-w-full">
                  <div className="flex flex-wrap items-center gap-2 max-w-full">
                    <span className="text-[11px] font-medium text-[#78756E] whitespace-nowrap">
                      {updatingStatusQid === selectedQuestion.questionId
                        ? t('bank.savingPoolStatus')
                        : t('bank.poolStatusHint')}
                    </span>
                    <div
                      role="group"
                      aria-label={t('bank.poolStatusHint')}
                      className="inline-flex flex-wrap items-center p-0.5 rounded-[11px] bg-[#F3EFE8] border border-[#E5DFD5] gap-0.5"
                    >
                      {(['live', 'paused', 'archived'] as BankPoolStatus[]).map((st) => {
                        const active = qcStatusToPoolStatus(selectedQuestion.qcStatus) === st;
                        const busy = updatingStatusQid === selectedQuestion.questionId;
                        return (
                          <button
                            key={st}
                            type="button"
                            aria-pressed={active}
                            disabled={busy}
                            onClick={() => void handleSetPoolStatus(selectedQuestion.questionId, st)}
                            className={`px-2.5 py-1.5 rounded-[9px] text-xs font-sans-display font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-60 whitespace-nowrap ${
                              active
                                ? 'bg-[#113C36] text-white shadow-[0_1px_2px_rgba(17,60,54,0.12)]'
                                : 'text-[#4A5955] hover:bg-white hover:text-[#113C36]'
                            }`}
                          >
                            {st === 'live' && <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />}
                            {st === 'paused' && <PauseCircle className="w-3.5 h-3.5 shrink-0" />}
                            {st === 'archived' && <Archive className="w-3.5 h-3.5 shrink-0" />}
                            <span>{poolStatusLabel(st)}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Permanent Delete Action */}
                  {confirmDeleteQid === selectedQuestion.questionId ? (
                    <div className="inline-flex flex-wrap items-center gap-2 px-2.5 py-1 rounded-[10px] bg-[#FDECEB] border border-[#B83A28]/30 text-xs">
                      <span className="text-[#B83A28] font-medium whitespace-nowrap">
                        {t('bank.permanentlyDeletePrompt')}
                      </span>
                      <button
                        type="button"
                        disabled={deletingBusy}
                        onClick={() => void handleDeleteQuestions([selectedQuestion.questionId])}
                        className="px-2.5 py-1 rounded-[8px] bg-[#B83A28] hover:bg-[#992D1E] text-white font-sans-display font-semibold cursor-pointer disabled:opacity-50 whitespace-nowrap"
                      >
                        {deletingBusy ? t('bank.deleting') : t('bank.confirmDeleteSingle')}
                      </button>
                      <button
                        type="button"
                        disabled={deletingBusy}
                        onClick={() => setConfirmDeleteQid(null)}
                        className="px-2 py-1 text-[#4A5955] hover:text-[#113C36] font-medium cursor-pointer whitespace-nowrap"
                      >
                        {t('home.modalCancel')}
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={deletingBusy || updatingStatusQid === selectedQuestion.questionId}
                      onClick={() => setConfirmDeleteQid(selectedQuestion.questionId)}
                      className="px-2.5 py-1 rounded-[9px] border border-[#B83A28]/25 bg-white hover:bg-[#FDECEB] text-[#B83A28] text-xs font-sans-display font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap"
                    >
                      <Trash2 className="w-3.5 h-3.5 shrink-0" />
                      <span>{t('bank.deletePermanently')}</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Student-accurate preview */}
              <div className="rounded-[12px] border border-[#E5DFD5] overflow-hidden bg-[#FAF8F5]">
                <QuestionWorkspace
                  mode="adminPreview"
                  question={selectedQuestion}
                  stimulus={selectedStimulus}
                  activeEvidenceRef={previewEvidenceRef}
                  onSelectEvidenceRef={setPreviewEvidenceRef}
                  embedded
                />
              </div>

              {/* Worked Explanations & Answer Keys */}
              {selectedQuestion.parts.length > 0 && (
                <div className="rounded-[12px] bg-[#FAF8F5] border border-[#E5DFD5] p-4 space-y-3">
                  <div className="text-xs font-sans-display font-semibold text-[#113C36]">
                    {t('bank.answerKeyTitle')}
                  </div>
                  <div className="space-y-2.5">
                    {selectedQuestion.parts.map((part, idx) => (
                      <div key={part.partId} className="text-xs text-[#4A5955] space-y-1">
                        <div className="font-medium text-[#113C36]">
                          {t('bank.partAnswerKey', { num: idx + 1 })}{' '}
                          <span className="px-1.5 py-0.5 rounded bg-[#E5F0EA] text-[#113C36] font-mono-code">
                            {part.correctAnswerKey || t('bank.writingRubricBadge')}
                          </span>
                        </div>
                        {part.workedExplanation && (
                          <FormattedText text={part.workedExplanation} variant="explanation" className="break-words" />
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Visual Asset Upload + Version History Footer */}
              <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-[#E5DFD5] text-xs">
                <label className="px-3 py-1.5 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-[#113C36] font-sans-display font-semibold inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap">
                  <Upload className="w-3.5 h-3.5 shrink-0" />
                  <span>
                    {uploadingQid === selectedQuestion.questionId
                      ? t('bank.uploading')
                      : t('bank.attachDiagram')}
                  </span>
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    disabled={uploadingQid === selectedQuestion.questionId}
                    onChange={(e) => handleVisualUpload(e, selectedQuestion.questionId)}
                  />
                </label>

                {versionsForSelected.length > 1 && (
                  <div className="flex items-center gap-1.5 text-[#78756E] whitespace-nowrap">
                    <History className="w-3.5 h-3.5 shrink-0" />
                    <span>{t('bank.versionsStored', { count: versionsForSelected.length })}</span>
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
