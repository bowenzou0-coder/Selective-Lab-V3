import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { api, type AdminLearnerSummary, type PaginatedQuestionsResponse } from '../../api';
import { poolStatusToQcStatus, qcStatusToPoolStatus, type BankPoolStatus } from '../../../shared/bankStatus';
import type { QuestionItem } from '../../../shared/contracts';
import { useI18n } from '../../i18n';
import { BankFilterBar } from './bank/BankFilterBar';
import { BankMetricsBar } from './bank/BankMetricsBar';
import { BankQuestionList } from './bank/BankQuestionList';
import { QuestionInspectorPane } from './bank/QuestionInspectorPane';
import { SimulatorDialog, type SimulatorLaunchOptions } from './bank/SimulatorDialog';
import { useBankQuery } from './bank/useBankQuery';

interface QuestionBankStudioProps {
  initialBatchId?: string;
  onClearInitialBatch?: () => void;
  onOpenSession: (sessionId: string) => void;
  onNotice: (msg: string) => void;
  onError: (msg: string) => void;
  onDataMutated?: () => void;
  monitoredStudentId?: string | null;
  monitoredLearner?: AdminLearnerSummary | null;
  studentCount?: number;
}

/** Admin Question Bank: metrics strip, filter bar, master list and tabbed inspector. */
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
  const { t, isZh, poolStatusLabel } = useI18n();
  const [selectedQid, setSelectedQid] = useState<string>(() => new URLSearchParams(window.location.search).get('qid') || '');
  const [checkedQids, setCheckedQids] = useState<string[]>([]);
  const [versionsForSelected, setVersionsForSelected] = useState<QuestionItem[]>([]);
  const [simOpen, setSimOpen] = useState(false);
  const [launchingSim, setLaunchingSim] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [updatingStatusQid, setUpdatingStatusQid] = useState<string | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [uploadingQid, setUploadingQid] = useState<string | null>(null);
  const inspectorRef = useRef<HTMLElement>(null);

  const onLoaded = useCallback((res: PaginatedQuestionsResponse) => {
    setSelectedQid((prev) => {
      if (res.questions.length === 0) return '';
      return res.questions.some((q) => q.questionId === prev) ? prev : res.questions[0].questionId;
    });
  }, []);

  const bank = useBankQuery({
    initialBatchId,
    monitoredStudentId,
    onError,
    loadErrorMessage: isZh ? '无法加载题库。' : 'Unable to load the Question Bank.',
    onLoaded,
  });
  const { filters, updateFilter, questions, setQuestions, refresh } = bank;

  // Jump from the Batches tab straight into a filtered bank view.
  useEffect(() => {
    if (!initialBatchId) return;
    updateFilter('batchId', initialBatchId);
    onClearInitialBatch?.();
  }, [initialBatchId, onClearInitialBatch, updateFilter]);

  // Keep the selected question in the URL for deep links.
  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    if (selectedQid) qs.set('qid', selectedQid);
    else qs.delete('qid');
    const nextSearch = `?${qs.toString()}`;
    if (window.location.search !== nextSearch) {
      window.history.replaceState({}, '', `${window.location.pathname}${nextSearch}`);
    }
  }, [selectedQid]);

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
  const selectedStimulus = selectedQuestion?.stimulusId ? bank.stimuliById[selectedQuestion.stimulusId] : undefined;

  const afterMutation = useCallback(() => {
    refresh();
    onDataMutated?.();
  }, [refresh, onDataMutated]);

  const handleSelect = useCallback((qid: string) => {
    setSelectedQid(qid);
    // On stacked (mobile) layouts the inspector sits below the list; bring it into view.
    if (!window.matchMedia('(min-width: 1024px)').matches) {
      requestAnimationFrame(() => inspectorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
  }, []);

  const handleToggleCheck = useCallback((qid: string) => {
    setCheckedQids((prev) => (prev.includes(qid) ? prev.filter((id) => id !== qid) : [...prev, qid]));
  }, []);

  const handleToggleAllOnPage = useCallback(() => {
    const pageIds = questions.map((q) => q.questionId);
    setCheckedQids((prev) => {
      const allChecked = pageIds.length > 0 && pageIds.every((id) => prev.includes(id));
      if (allChecked) {
        const pageSet = new Set(pageIds);
        return prev.filter((id) => !pageSet.has(id));
      }
      return Array.from(new Set([...prev, ...pageIds]));
    });
  }, [questions]);

  const handleSetPoolStatus = async (qid: string, nextStatus: BankPoolStatus) => {
    const current = questions.find((q) => q.questionId === qid);
    if (!current || updatingStatusQid === qid || qcStatusToPoolStatus(current.qcStatus) === nextStatus) return;
    const nextQcStatus = poolStatusToQcStatus(nextStatus);
    setUpdatingStatusQid(qid);
    // Optimistic: reflect the new status immediately, revert on failure.
    setQuestions((prev) => prev.map((q) => (q.questionId === qid ? { ...q, qcStatus: nextQcStatus } : q)));
    try {
      await api.updateQuestionStatus(qid, nextQcStatus);
      onNotice(isZh ? `已将 ${qid} 状态设为“${poolStatusLabel(nextStatus)}”。` : `Set ${qid} to ${poolStatusLabel(nextStatus)}.`);
      afterMutation();
    } catch (err) {
      setQuestions((prev) => prev.map((q) => (q.questionId === qid ? { ...q, qcStatus: current.qcStatus } : q)));
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
      onNotice(
        label ||
          (isZh
            ? `已将 ${res.updatedCount} 道题目设为“${poolStatusLabel(nextStatus)}”。`
            : `Updated ${res.updatedCount} question${res.updatedCount === 1 ? '' : 's'} to ${poolStatusLabel(nextStatus)}.`)
      );
      afterMutation();
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
      const deleted = new Set(ids);
      setCheckedQids((prev) => prev.filter((id) => !deleted.has(id)));
      onNotice(
        isZh
          ? `已从题库永久删除 ${res.deletedCount} 道题目。`
          : `Permanently deleted ${res.deletedCount} question${res.deletedCount === 1 ? '' : 's'} from the Question Bank.`
      );
      afterMutation();
    } catch (err) {
      onError(err instanceof Error ? err.message : isZh ? '删除题目失败。' : 'Failed to delete question(s).');
    } finally {
      setDeletingBusy(false);
    }
  };

  const handleLaunch = async ({ useSelected, limit, timerMin, sandbox }: SimulatorLaunchOptions) => {
    setLaunchingSim(true);
    try {
      const customTimeLimitSec = timerMin > 0 ? timerMin * 60 : undefined;
      const limitNum = limit === 'ALL' ? 120 : limit;
      let res: { sessionId: string; count: number };
      if (useSelected && checkedQids.length > 0) {
        res = await api.createCalibrationSession({
          questionIds: checkedQids,
          limit: checkedQids.length,
          customTimeLimitSec,
          isSandbox: sandbox,
        });
      } else if (
        // Progress, search and quality filters are not expressible server-side: send the visible IDs.
        filters.completionStatus ||
        filters.search.trim() ||
        filters.flaggedOnly ||
        filters.missingVisual ||
        filters.missingExplanation
      ) {
        const ids = questions.slice(0, limitNum).map((q) => q.questionId);
        if (ids.length === 0) {
          onError(isZh ? '没有符合当前筛选条件的题目。' : 'No questions match your current filters.');
          return;
        }
        res = await api.createCalibrationSession({ questionIds: ids, limit: ids.length, customTimeLimitSec, isSandbox: sandbox });
      } else {
        res = await api.createCalibrationSession({
          section: filters.section || undefined,
          poolType: filters.poolType || undefined,
          qcStatus: filters.poolStatus ? poolStatusToQcStatus(filters.poolStatus) : 'active',
          formatType: filters.formatType || undefined,
          skillId: filters.skillId || undefined,
          batchId: filters.batchId || undefined,
          includeHistorical: filters.includeHistorical,
          limit: limitNum,
          customTimeLimitSec,
          isSandbox: sandbox,
        });
      }
      setSimOpen(false);
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
      await api.attachQuestionVisual(qid, { altText: `Diagram for ${qid}`, imageBase64: dataUrl, filename: file.name });
      onNotice(isZh ? `已上传 ${qid} 的配图资源。` : `Uploaded visual asset for ${qid}.`);
      refresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : isZh ? '上传配图失败。' : 'Failed to attach visual.');
    } finally {
      setUploadingQid(null);
      e.target.value = '';
    }
  };

  return (
    <div className="space-y-4">
      {bank.poolHealth && (
        <BankMetricsBar
          poolHealth={bank.poolHealth}
          monitoredStudentId={monitoredStudentId}
          monitoredLearner={monitoredLearner}
          masteredCount={bank.masteredLiveIds.length}
          canArchiveMastered={Boolean(monitoredLearner) && studentCount <= 1}
          archiving={bulkBusy}
          onArchiveMastered={() =>
            void handleBulkStatus(
              bank.masteredLiveIds,
              'archived',
              isZh
                ? `已将 ${bank.masteredLiveIds.length} 道已掌握题目移至“已归档”。`
                : `Archived ${bank.masteredLiveIds.length} mastered question${bank.masteredLiveIds.length === 1 ? '' : 's'} out of the active pool.`
            )
          }
        />
      )}

      <BankFilterBar
        filters={filters}
        onChange={updateFilter}
        onReset={bank.resetFilters}
        onRefresh={refresh}
        onOpenSimulator={() => setSimOpen(true)}
        loading={bank.loading}
        batchSummaries={bank.batchSummaries}
      />

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-5">
          <BankQuestionList
            questions={questions}
            stimuliById={bank.stimuliById}
            progressByQid={bank.progressByQid}
            openFlagsByQid={bank.openFlagsByQid}
            selectedQid={selectedQuestion?.questionId ?? ''}
            onSelect={handleSelect}
            checkedQids={checkedQids}
            onToggleCheck={handleToggleCheck}
            onToggleAllOnPage={handleToggleAllOnPage}
            loading={bank.loading}
            totalMatching={bank.totalMatching}
            page={bank.page}
            totalPages={bank.totalPages}
            pageSize={bank.pageSize}
            onPageChange={bank.setPage}
            onPageSizeChange={bank.setPageSize}
            onResetFilters={bank.resetFilters}
            bulkBusy={bulkBusy || deletingBusy}
            onBulkStatus={(status) => void handleBulkStatus(checkedQids, status)}
            onBulkDelete={() => void handleDeleteQuestions(checkedQids)}
            onClearSelection={() => setCheckedQids([])}
            onSimulateSelected={() => setSimOpen(true)}
          />
        </div>
        <div className="min-w-0 lg:col-span-7">
          {selectedQuestion ? (
            <QuestionInspectorPane
              ref={inspectorRef}
              question={selectedQuestion}
              stimulus={selectedStimulus}
              progress={bank.progressByQid[selectedQuestion.questionId]}
              versions={versionsForSelected}
              statusBusy={updatingStatusQid === selectedQuestion.questionId}
              onSetPoolStatus={(st) => void handleSetPoolStatus(selectedQuestion.questionId, st)}
              deleting={deletingBusy}
              onDelete={() => void handleDeleteQuestions([selectedQuestion.questionId])}
              uploading={uploadingQid === selectedQuestion.questionId}
              onUploadVisual={(e) => void handleVisualUpload(e, selectedQuestion.questionId)}
            />
          ) : (
            <div className="rounded-[16px] border border-[#E5DFD5] bg-white py-16 text-center text-sm text-[#78756E]">
              {bank.loading ? t('bank.loading') : t('bank.selectOnePrompt')}
            </div>
          )}
        </div>
      </div>

      <SimulatorDialog
        open={simOpen}
        onClose={() => setSimOpen(false)}
        selectedCount={checkedQids.length}
        matchingCount={bank.totalMatching}
        launching={launchingSim}
        onLaunch={(opts) => void handleLaunch(opts)}
      />
    </div>
  );
}
