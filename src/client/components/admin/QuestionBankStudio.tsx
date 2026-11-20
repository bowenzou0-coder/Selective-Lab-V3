import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react';
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
  getCompletionStatusLabel,
  getPoolStatusLabel,
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
import { FORMAT_LABELS, QuestionWorkspace, SECTION_LABELS } from '../QuestionWorkspace';

interface QuestionBankStudioProps {
  initialBatchId?: string;
  onClearInitialBatch?: () => void;
  onOpenSession: (sessionId: string) => void;
  onNotice: (msg: string) => void;
  onError: (msg: string) => void;
  onDataMutated?: () => void;
}

const SECTION_PILLS: { value: '' | SectionCode; label: string }[] = [
  { value: '', label: 'All sections' },
  { value: 'READ', label: 'Reading' },
  { value: 'MATH', label: 'Maths' },
  { value: 'THINK', label: 'Thinking' },
  { value: 'WRIT', label: 'Writing' },
];

const POOL_STATUS_PILLS: { value: '' | BankPoolStatus; label: string }[] = [
  { value: '', label: 'All statuses' },
  { value: 'live', label: 'In pool' },
  { value: 'paused', label: 'Paused' },
  { value: 'archived', label: 'Archived' },
];

const COMPLETION_PILLS: { value: '' | QuestionCompletionStatus; label: string }[] = [
  { value: '', label: 'All progress' },
  { value: 'unseen', label: 'Unseen' },
  { value: 'in_review', label: 'In review' },
  { value: 'done', label: 'Done' },
  { value: 'needs_repair', label: 'Needs repair' },
];

function formatDateShort(iso?: string): string {
  if (!iso) return 'Never';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'Unknown' : d.toLocaleDateString();
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
}: QuestionBankStudioProps) {
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
      onError(err instanceof Error ? err.message : 'Unable to load the Question Bank.');
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
      onNotice(`Set ${qid} to ${getPoolStatusLabel(nextStatus)}.`);
      await loadQuestions();
      onDataMutated?.();
    } catch (err) {
      // Revert optimistic update on failure
      setQuestions((prev) =>
        prev.map((q) => (q.questionId === qid ? { ...q, qcStatus: current.qcStatus } : q))
      );
      onError(err instanceof Error ? err.message : 'Unable to update question status.');
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
          `Updated ${res.updatedCount} question${res.updatedCount === 1 ? '' : 's'} to ${getPoolStatusLabel(nextStatus)}.`
      );
      await loadQuestions();
      onDataMutated?.();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Bulk status update failed.');
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
        `Permanently deleted ${res.deletedCount} question${res.deletedCount === 1 ? '' : 's'} from the Question Bank.`
      );
      await loadQuestions();
      onDataMutated?.();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to delete question(s).');
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
            onError('No questions match your current filters.');
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
      onError(err instanceof Error ? err.message : 'Could not launch practice session.');
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
      onNotice(`Uploaded visual asset for ${qid}.`);
      await loadQuestions();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to attach visual.');
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
        <section className="rounded-[16px] bg-[#FAF8F5] border border-[#E5DFD5] p-5 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1">
              <h2 className="font-sans-display font-semibold text-[16px] text-[#113C36]">
                Question Bank pool health
              </h2>
              <p className="text-xs text-[#4A5955] max-w-2xl leading-relaxed">
                {poolHealth.refreshAdvice}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                aria-expanded={showGlossary}
                onClick={() => setShowGlossary((v) => !v)}
                className="px-3 py-1 rounded-full border border-[#CFC6B9] bg-white hover:bg-[#F3EFE8] text-xs font-medium text-[#4A5955] inline-flex items-center gap-1.5 cursor-pointer"
              >
                <HelpCircle className="w-3.5 h-3.5 text-[#113C36]" />
                <span>What are Holdout &amp; Needs repair?</span>
              </button>
              <span className={`px-3 py-1 rounded-full border text-xs font-medium tabular-nums ${urgencyStyles}`}>
                {poolHealth.unseenLivePercent}% unseen ({poolHealth.estimatedRunwayDays}d runway)
              </span>
              {masteredLiveIds.length > 0 && (
                <button
                  type="button"
                  disabled={bulkBusy}
                  onClick={() =>
                    handleBulkStatus(
                      masteredLiveIds,
                      'archived',
                      `Archived ${masteredLiveIds.length} mastered question${masteredLiveIds.length === 1 ? '' : 's'} out of the active pool.`
                    )
                  }
                  className="px-3.5 py-1.5 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#113C36] hover:text-white hover:border-[#113C36] text-xs font-sans-display font-semibold text-[#113C36] inline-flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
                >
                  <Archive className="w-3.5 h-3.5" />
                  <span>Archive mastered ({masteredLiveIds.length})</span>
                </button>
              )}
            </div>
          </div>

          {showGlossary && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 rounded-[12px] bg-white border border-[#E5DFD5] p-4 text-xs text-[#4A5955] leading-relaxed">
              <div className="space-y-1">
                <div className="font-sans-display font-semibold text-[#113C36]">
                  Holdout (Benchmark holdout)
                </div>
                <p>
                  Official benchmark questions (like Practice Test 3) kept isolated from Daily Practice so you never spoil them ahead of time. Leave them untouched until you want an honest, unseen mock exam score — you only need to Pause or Delete one if the question itself has a typo or broken diagram.
                </p>
              </div>
              <div className="space-y-1">
                <div className="font-sans-display font-semibold text-[#113C36]">
                  Needs repair (student progress status)
                </div>
                <p>
                  This does <strong>not</strong> mean the question is broken — it means you previously got it wrong (or lapsed on a review). Spaced repetition automatically brings &ldquo;Needs repair&rdquo; questions back sooner until you answer them cleanly. You can also filter by &ldquo;Needs repair&rdquo; and click <strong>Practice filtered</strong> for a targeted mistake drill.
                </p>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <div className="rounded-[12px] bg-white border border-[#E5DFD5] px-3.5 py-2.5">
              <div className="text-xs text-[#78756E]">In pool</div>
              <div className="mt-0.5 font-serif-display font-extrabold text-[24px] leading-tight text-[#113C36] tabular-nums">
                {poolHealth.liveCount}
              </div>
              <div className="text-[11px] text-[#78756E] tabular-nums">
                +{poolHealth.holdoutCount} benchmark holdout
              </div>
            </div>
            <div className="rounded-[12px] bg-white border border-[#E5DFD5] px-3.5 py-2.5">
              <div className="text-xs text-[#78756E]">Unseen</div>
              <div className="mt-0.5 font-serif-display font-extrabold text-[24px] leading-tight text-[#113C36] tabular-nums">
                {poolHealth.unseenLiveCount}
              </div>
              <div className="text-[11px] text-[#78756E] tabular-nums">
                R {poolHealth.bySectionLive.READ.unseen} / M {poolHealth.bySectionLive.MATH.unseen} / T {poolHealth.bySectionLive.THINK.unseen}
              </div>
            </div>
            <div className="rounded-[12px] bg-white border border-[#E5DFD5] px-3.5 py-2.5">
              <div className="text-xs text-[#78756E]">Done (mastered)</div>
              <div className="mt-0.5 font-serif-display font-extrabold text-[24px] leading-tight text-[#1F7A4C] tabular-nums">
                {poolHealth.doneLiveCount}
              </div>
              <div className="text-[11px] text-[#78756E] tabular-nums">
                {poolHealth.inReviewLiveCount} in review, {poolHealth.needsRepairLiveCount} repair
              </div>
            </div>
            <div className="rounded-[12px] bg-white border border-[#E5DFD5] px-3.5 py-2.5">
              <div className="text-xs text-[#78756E]">Paused</div>
              <div className="mt-0.5 font-serif-display font-extrabold text-[24px] leading-tight text-[#A35116] tabular-nums">
                {poolHealth.pausedCount}
              </div>
              <div className="text-[11px] text-[#78756E]">Held out for QA</div>
            </div>
            <div className="rounded-[12px] bg-white border border-[#E5DFD5] px-3.5 py-2.5">
              <div className="text-xs text-[#78756E]">Archived</div>
              <div className="mt-0.5 font-serif-display font-extrabold text-[24px] leading-tight text-[#78756E] tabular-nums">
                {poolHealth.archivedCount}
              </div>
              <div className="text-[11px] text-[#78756E]">Retired from rotation</div>
            </div>
          </div>
        </section>
      )}

      {/* Streamlined Primary Filter Bar + Inline Quick Practice Strip */}
      <section className="rounded-[16px] bg-white border border-[#E5DFD5] p-4 space-y-3.5">
        {/* Row 1: Search + Primary Pills + More Filters Toggle */}
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="w-4 h-4 text-[#78756E] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              aria-label="Search Question Bank"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Search question ID, prompt text, or passage..."
              className="w-full pl-9 pr-3 py-2 rounded-[10px] border border-[#CFC6B9] bg-[#FAF8F5] focus:bg-white text-sm text-[#113C36] focus:outline-none focus:border-[#113C36]"
            />
          </div>

          <button
            type="button"
            onClick={() => setShowMoreFilters((v) => !v)}
            aria-expanded={showMoreFilters}
            className={`px-3.5 py-2 rounded-[10px] border text-xs font-sans-display font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-colors ${
              showMoreFilters || activeAdvancedFilterCount > 0
                ? 'bg-[#E5F0EA] border-[#113C36]/30 text-[#113C36]'
                : 'bg-white border-[#CFC6B9] text-[#4A5955] hover:bg-[#FAF8F5]'
            }`}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            <span>
              More filters{activeAdvancedFilterCount > 0 ? ` (${activeAdvancedFilterCount})` : ''}
            </span>
            {showMoreFilters ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>

          <button
            type="button"
            onClick={() => void loadQuestions()}
            className="px-3 py-2 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-xs font-sans-display font-semibold text-[#4A5955] inline-flex items-center gap-1.5 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>

          {(search || section || poolStatus || completionStatus || activeAdvancedFilterCount > 0) && (
            <button
              type="button"
              onClick={resetAllFilters}
              className="px-2.5 py-2 rounded-[10px] text-xs font-sans-display font-semibold text-[#78756E] hover:text-[#113C36] inline-flex items-center gap-1 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
              <span>Clear</span>
            </button>
          )}
        </div>

        {/* Row 2: Section, 3-State Pool Status, and Completion pills */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by section">
            {SECTION_PILLS.map((pill) => (
              <button
                key={pill.label}
                type="button"
                onClick={() => {
                  setSection(pill.value);
                  setSkillId('');
                  setPage(1);
                }}
                className={`px-2.5 py-1 rounded-full font-medium cursor-pointer transition-colors ${
                  section === pill.value
                    ? 'bg-[#113C36] text-white'
                    : 'bg-[#F3EFE8] text-[#4A5955] hover:bg-[#E8E2D7]'
                }`}
              >
                {pill.label}
              </button>
            ))}
          </div>

          <div className="h-4 w-px bg-[#E5DFD5] hidden sm:block" aria-hidden="true" />

          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by pool status">
            {POOL_STATUS_PILLS.map((pill) => (
              <button
                key={pill.label}
                type="button"
                onClick={() => {
                  setPoolStatus(pill.value);
                  setPage(1);
                }}
                className={`px-2.5 py-1 rounded-full font-medium cursor-pointer transition-colors ${
                  poolStatus === pill.value
                    ? 'bg-[#113C36] text-white'
                    : 'bg-[#F3EFE8] text-[#4A5955] hover:bg-[#E8E2D7]'
                }`}
              >
                {pill.label}
              </button>
            ))}
          </div>

          <div className="h-4 w-px bg-[#E5DFD5] hidden sm:block" aria-hidden="true" />

          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by student progress">
            {COMPLETION_PILLS.map((pill) => (
              <button
                key={pill.label}
                type="button"
                onClick={() => {
                  setCompletionStatus(pill.value);
                  setPage(1);
                }}
                className={`px-2.5 py-1 rounded-full font-medium cursor-pointer transition-colors ${
                  completionStatus === pill.value
                    ? 'bg-[#113C36] text-white'
                    : 'bg-[#F3EFE8] text-[#4A5955] hover:bg-[#E8E2D7]'
                }`}
              >
                {pill.label}
              </button>
            ))}
          </div>
        </div>

        {/* Collapsible More Filters Drawer */}
        {showMoreFilters && (
          <div className="pt-3 border-t border-[#E5DFD5] space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div>
                <label htmlFor="bank-batch-filter" className="block text-xs font-medium text-[#4A5955] mb-1">
                  Batch ({batchSummaries.length} available)
                </label>
                {batchSummaries.length > 12 && (
                  <input
                    type="text"
                    value={batchSearch}
                    onChange={(e) => setBatchSearch(e.target.value)}
                    placeholder="Type to narrow batches..."
                    className="w-full mb-1.5 px-2.5 py-1.5 rounded-[8px] border border-[#CFC6B9] bg-[#FAF8F5] text-xs text-[#113C36]"
                  />
                )}
                <select
                  id="bank-batch-filter"
                  value={batchId}
                  onChange={(e) => {
                    setBatchId(e.target.value);
                    setPage(1);
                  }}
                  className="w-full px-2.5 py-2 rounded-[10px] border border-[#CFC6B9] bg-white text-xs text-[#113C36]"
                >
                  <option value="">All batches</option>
                  {filteredBatchOptions.map((b) => (
                    <option key={b.batchId} value={b.batchId}>
                      {b.batchLabel} ({b.unseen} unseen / {b.total})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="bank-skill-filter" className="block text-xs font-medium text-[#4A5955] mb-1">
                  Skill
                </label>
                <select
                  id="bank-skill-filter"
                  value={skillId}
                  onChange={(e) => {
                    setSkillId(e.target.value);
                    setPage(1);
                  }}
                  className="w-full px-2.5 py-2 rounded-[10px] border border-[#CFC6B9] bg-white text-xs text-[#113C36]"
                >
                  <option value="">All skills</option>
                  {filteredSkills.map((s) => (
                    <option key={s.skillId} value={s.skillId}>
                      {s.displayName}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="bank-format-filter" className="block text-xs font-medium text-[#4A5955] mb-1">
                  Question format
                </label>
                <select
                  id="bank-format-filter"
                  value={formatType}
                  onChange={(e) => {
                    setFormatType(e.target.value);
                    setPage(1);
                  }}
                  className="w-full px-2.5 py-2 rounded-[10px] border border-[#CFC6B9] bg-white text-xs text-[#113C36]"
                >
                  <option value="">All formats</option>
                  {Object.entries(FORMAT_LABELS).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="bank-pooltype-filter" className="block text-xs font-medium text-[#4A5955] mb-1">
                  Exam isolation & sort
                </label>
                <div className="flex gap-2">
                  <select
                    id="bank-pooltype-filter"
                    value={poolType}
                    onChange={(e) => {
                      setPoolType(e.target.value);
                      setPage(1);
                    }}
                    className="flex-1 px-2.5 py-2 rounded-[10px] border border-[#CFC6B9] bg-white text-xs text-[#113C36]"
                  >
                    <option value="">Practice + holdout</option>
                    <option value="practice">Practice pool</option>
                    <option value="benchmark_holdout">Benchmark holdout</option>
                  </select>
                  <select
                    aria-label="Sort order"
                    value={sort}
                    onChange={(e) => setSort(e.target.value as typeof sort)}
                    className="px-2.5 py-2 rounded-[10px] border border-[#CFC6B9] bg-white text-xs text-[#113C36]"
                  >
                    <option value="id_asc">ID</option>
                    <option value="updated_desc">Newest</option>
                    <option value="version_desc">Version</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-4 text-xs text-[#4A5955]">
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={flaggedOnly}
                  onChange={(e) => {
                    setFlaggedOnly(e.target.checked);
                    setPage(1);
                  }}
                  className="accent-[#113C36]"
                />
                <span>Flagged only</span>
              </label>
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={missingVisual}
                  onChange={(e) => {
                    setMissingVisual(e.target.checked);
                    setPage(1);
                  }}
                  className="accent-[#113C36]"
                />
                <span>Missing visual</span>
              </label>
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={missingExplanation}
                  onChange={(e) => {
                    setMissingExplanation(e.target.checked);
                    setPage(1);
                  }}
                  className="accent-[#113C36]"
                />
                <span>Missing explanation</span>
              </label>
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeHistorical}
                  onChange={(e) => {
                    setIncludeHistorical(e.target.checked);
                    setPage(1);
                  }}
                  className="accent-[#113C36]"
                />
                <span>Include older versions</span>
              </label>
            </div>
          </div>
        )}

        {/* Inline Quick Practice & Bulk Actions Bar (replaces the old Calibration Simulator tab) */}
        <div className="pt-3 border-t border-[#E5DFD5] flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5 text-xs">
            <span className="inline-flex items-center gap-1.5 font-sans-display font-semibold text-[#113C36]">
              <Sparkles className="w-3.5 h-3.5 text-[#113C36]" />
              <span>Quick practice</span>
            </span>

            <select
              aria-label="Practice question count"
              value={simLimit}
              onChange={(e) => setSimLimit(e.target.value)}
              className="px-2.5 py-1.5 rounded-[8px] border border-[#CFC6B9] bg-[#FAF8F5] text-xs text-[#113C36]"
            >
              <option value="5">5 questions</option>
              <option value="10">10 questions</option>
              <option value="15">15 questions</option>
              <option value="25">25 questions</option>
              <option value="ALL">All matching</option>
            </select>

            <select
              aria-label="Practice timer"
              value={simTimerMin}
              onChange={(e) => setSimTimerMin(e.target.value)}
              className="px-2.5 py-1.5 rounded-[8px] border border-[#CFC6B9] bg-[#FAF8F5] text-xs text-[#113C36]"
            >
              <option value="0">Untimed</option>
              <option value="10">10 min</option>
              <option value="20">20 min</option>
              <option value="40">40 min</option>
            </select>

            <label className="inline-flex items-center gap-1.5 text-[#4A5955] cursor-pointer">
              <input
                type="checkbox"
                checked={simSandbox}
                onChange={(e) => setSimSandbox(e.target.checked)}
                className="accent-[#113C36]"
              />
              <span>Sandbox (keep stats clean)</span>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {checkedQids.length > 0 && (
              <>
                <button
                  type="button"
                  disabled={bulkBusy}
                  onClick={() => handleBulkStatus(checkedQids, 'live')}
                  className="px-2.5 py-1.5 rounded-[8px] border border-[#C5DDD1] bg-[#E5F0EA] text-[#113C36] text-xs font-sans-display font-semibold cursor-pointer disabled:opacity-50"
                >
                  Move to pool ({checkedQids.length})
                </button>
                <button
                  type="button"
                  disabled={bulkBusy}
                  onClick={() => handleBulkStatus(checkedQids, 'paused')}
                  className="px-2.5 py-1.5 rounded-[8px] border border-[#EED3B6] bg-[#FDF0E2] text-[#A35116] text-xs font-sans-display font-semibold cursor-pointer disabled:opacity-50"
                >
                  Pause
                </button>
                <button
                  type="button"
                  disabled={bulkBusy || deletingBusy}
                  onClick={() => handleBulkStatus(checkedQids, 'archived')}
                  className="px-2.5 py-1.5 rounded-[8px] border border-[#CFC6B9] bg-[#F3EFE8] text-[#4A5955] text-xs font-sans-display font-semibold cursor-pointer disabled:opacity-50"
                >
                  Archive
                </button>
                {confirmBulkDelete ? (
                  <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded-[8px] bg-[#FDECEB] border border-[#B83A28]/30">
                    <button
                      type="button"
                      disabled={deletingBusy}
                      onClick={() => void handleDeleteQuestions(checkedQids)}
                      className="px-2 py-0.5 rounded-[6px] bg-[#B83A28] hover:bg-[#992D1E] text-white text-xs font-sans-display font-semibold cursor-pointer disabled:opacity-50"
                    >
                      {deletingBusy ? 'Deleting...' : `Confirm delete (${checkedQids.length})`}
                    </button>
                    <button
                      type="button"
                      disabled={deletingBusy}
                      onClick={() => setConfirmBulkDelete(false)}
                      className="px-2 py-0.5 text-xs font-medium text-[#4A5955] hover:text-[#113C36] cursor-pointer"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={bulkBusy || deletingBusy}
                    onClick={() => setConfirmBulkDelete(true)}
                    className="px-2.5 py-1.5 rounded-[8px] border border-[#B83A28]/30 bg-[#FDECEB] hover:bg-[#B83A28] hover:text-white text-[#B83A28] text-xs font-sans-display font-semibold inline-flex items-center gap-1 transition-colors cursor-pointer disabled:opacity-50"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Delete ({checkedQids.length})</span>
                  </button>
                )}
                <button
                  type="button"
                  disabled={launchingSim}
                  onClick={() => handleLaunchQuickPractice(true)}
                  className="px-3.5 py-1.5 rounded-[10px] bg-[#F29A63] hover:bg-[#E6874C] text-[#113C36] text-xs font-sans-display font-semibold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  <Play className="w-3 h-3 fill-current" />
                  <span>Practice selected ({checkedQids.length})</span>
                </button>
              </>
            )}

            <button
              type="button"
              disabled={launchingSim || totalMatching === 0}
              onClick={() => handleLaunchQuickPractice(false)}
              className="px-3.5 py-1.5 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-xs font-sans-display font-semibold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <Play className="w-3 h-3 fill-current" />
              <span>{launchingSim ? 'Launching...' : 'Practice filtered'}</span>
            </button>
          </div>
        </div>
      </section>

      {/* Master-Detail Question Bank Split */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Left List */}
        <section className="lg:col-span-5 rounded-[16px] bg-white border border-[#E5DFD5] overflow-hidden">
          <div className="px-4 py-3 bg-[#FAF8F5] border-b border-[#E5DFD5] flex items-center justify-between gap-2 text-xs">
            <label className="inline-flex items-center gap-2 font-medium text-[#4A5955] cursor-pointer">
              <input
                type="checkbox"
                checked={allOnPageChecked}
                onChange={toggleAllOnPage}
                className="accent-[#113C36]"
              />
              <span className="tabular-nums">
                {totalMatching} question{totalMatching === 1 ? '' : 's'}
              </span>
            </label>

            <div className="flex items-center gap-1.5">
              <select
                aria-label="Items per page"
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(1);
                }}
                className="px-2 py-1 rounded-[8px] border border-[#CFC6B9] bg-white text-xs text-[#4A5955]"
              >
                <option value={25}>25 / page</option>
                <option value={50}>50 / page</option>
                <option value={100}>100 / page</option>
              </select>
              <button
                type="button"
                aria-label="Previous page"
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
                aria-label="Next page"
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
              <div className="p-8 text-center text-sm text-[#78756E]">Loading Question Bank...</div>
            ) : questions.length === 0 ? (
              <div className="p-8 text-center space-y-2">
                <p className="text-sm font-medium text-[#113C36]">No questions match these filters.</p>
                <button
                  type="button"
                  onClick={resetAllFilters}
                  className="text-xs font-sans-display font-semibold text-[#113C36] underline underline-offset-4 cursor-pointer"
                >
                  Reset filters
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
                      className="mt-1 accent-[#113C36] cursor-pointer"
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
                      <div className="flex flex-wrap items-center justify-between gap-1.5">
                        <span className="font-mono-code text-[11px] font-semibold text-[#113C36] truncate">
                          {q.questionId}
                        </span>
                        <div className="flex items-center gap-1">
                          <span
                            className={`px-2 py-0.5 rounded-full border text-[11px] font-medium ${getPoolBadgeClasses(pStatus)}`}
                          >
                            {getPoolStatusLabel(pStatus)}
                          </span>
                          <span
                            className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${getCompletionBadgeClasses(compStatus)}`}
                          >
                            {getCompletionStatusLabel(compStatus)}
                          </span>
                        </div>
                      </div>
                      <p className="text-xs text-[#4A5955] line-clamp-2 leading-relaxed">
                        {q.stemPrefix ||
                          q.parts[0]?.promptText ||
                          (q.stimulusId ? stimuliById[q.stimulusId]?.title : '') ||
                          'Untitled question'}
                      </p>
                      <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#78756E]">
                        <span>{SECTION_LABELS[q.section] || q.section}</span>
                        <span>{FORMAT_LABELS[q.formatType] || q.formatType}</span>
                        {q.poolType === 'benchmark_holdout' && (
                          <span className="text-[#A35116] font-medium">Holdout</span>
                        )}
                        {flagsCount > 0 && (
                          <span className="text-[#B83A28] font-medium">
                            {flagsCount} flag{flagsCount === 1 ? '' : 's'}
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
        <section className="lg:col-span-7 rounded-[16px] bg-white border border-[#E5DFD5] p-5 space-y-4">
          {!selectedQuestion ? (
            <div className="py-16 text-center text-sm text-[#78756E]">
              Select any question on the left to inspect its student view, answer key, and pool status.
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3 pb-3.5 border-b border-[#E5DFD5]">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-mono-code text-sm font-semibold text-[#113C36]">
                      {selectedQuestion.questionId}
                    </h3>
                    <span className="px-2 py-0.5 rounded-full bg-[#F3EFE8] text-[11px] font-medium text-[#4A5955]">
                      v{selectedQuestion.version}
                    </span>
                    {selectedQuestion.batchLabel && (
                      <span className="px-2 py-0.5 rounded-full bg-[#FAF8F5] border border-[#E5DFD5] text-[11px] text-[#4A5955]">
                        {selectedQuestion.batchLabel}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-[#78756E] flex flex-wrap gap-3">
                    <span>
                      Progress:{' '}
                      <strong className="text-[#113C36]">
                        {getCompletionStatusLabel(
                          progressByQid[selectedQuestion.questionId]?.completionStatus ?? 'unseen'
                        )}
                      </strong>
                    </span>
                    <span>
                      Attempts: {progressByQid[selectedQuestion.questionId]?.attemptsCount ?? 0}
                    </span>
                    <span>
                      Last seen: {formatDateShort(progressByQid[selectedQuestion.questionId]?.lastAttemptAtIso)}
                    </span>
                  </div>
                </div>

                {/* Interactive 3-State Pool Switcher + Permanent Delete */}
                <div className="flex flex-col items-end gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] font-medium text-[#78756E]">
                      {updatingStatusQid === selectedQuestion.questionId
                        ? 'Saving pool status...'
                        : 'Pool status (click to change):'}
                    </span>
                    <div
                      role="group"
                      aria-label="Change question pool status"
                      className="inline-flex items-center p-0.5 rounded-[11px] bg-[#F3EFE8] border border-[#E5DFD5] gap-0.5"
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
                            className={`px-2.5 py-1.5 rounded-[9px] text-xs font-sans-display font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-60 ${
                              active
                                ? 'bg-[#113C36] text-white shadow-[0_1px_2px_rgba(17,60,54,0.12)]'
                                : 'text-[#4A5955] hover:bg-white hover:text-[#113C36]'
                            }`}
                          >
                            {st === 'live' && <CheckCircle2 className="w-3.5 h-3.5" />}
                            {st === 'paused' && <PauseCircle className="w-3.5 h-3.5" />}
                            {st === 'archived' && <Archive className="w-3.5 h-3.5" />}
                            <span>{getPoolStatusLabel(st)}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Permanent Delete Action */}
                  {confirmDeleteQid === selectedQuestion.questionId ? (
                    <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-[10px] bg-[#FDECEB] border border-[#B83A28]/30 text-xs">
                      <span className="text-[#B83A28] font-medium">Permanently delete?</span>
                      <button
                        type="button"
                        disabled={deletingBusy}
                        onClick={() => void handleDeleteQuestions([selectedQuestion.questionId])}
                        className="px-2.5 py-1 rounded-[8px] bg-[#B83A28] hover:bg-[#992D1E] text-white font-sans-display font-semibold cursor-pointer disabled:opacity-50"
                      >
                        {deletingBusy ? 'Deleting...' : 'Confirm delete'}
                      </button>
                      <button
                        type="button"
                        disabled={deletingBusy}
                        onClick={() => setConfirmDeleteQid(null)}
                        className="px-2 py-1 text-[#4A5955] hover:text-[#113C36] font-medium cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={deletingBusy || updatingStatusQid === selectedQuestion.questionId}
                      onClick={() => setConfirmDeleteQid(selectedQuestion.questionId)}
                      className="px-2.5 py-1 rounded-[9px] border border-[#B83A28]/25 bg-white hover:bg-[#FDECEB] text-[#B83A28] text-xs font-sans-display font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Delete permanently</span>
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
                    Answer key and worked explanation
                  </div>
                  <div className="space-y-2.5">
                    {selectedQuestion.parts.map((part, idx) => (
                      <div key={part.partId} className="text-xs text-[#4A5955] space-y-1">
                        <div className="font-medium text-[#113C36]">
                          Part {idx + 1}: Correct answer{' '}
                          <span className="px-1.5 py-0.5 rounded bg-[#E5F0EA] text-[#113C36] font-mono-code">
                            {part.correctAnswerKey || 'Writing rubric'}
                          </span>
                        </div>
                        {part.workedExplanation && (
                          <p className="leading-relaxed">{part.workedExplanation}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Visual Asset Upload + Version History Footer */}
              <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-[#E5DFD5] text-xs">
                <label className="px-3 py-1.5 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-[#113C36] font-sans-display font-semibold inline-flex items-center gap-1.5 cursor-pointer">
                  <Upload className="w-3.5 h-3.5" />
                  <span>
                    {uploadingQid === selectedQuestion.questionId
                      ? 'Uploading...'
                      : 'Attach or replace diagram'}
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
                  <div className="flex items-center gap-1.5 text-[#78756E]">
                    <History className="w-3.5 h-3.5" />
                    <span>{versionsForSelected.length} versions stored in family</span>
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
