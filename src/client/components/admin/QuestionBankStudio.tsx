import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { api, type AdminLearnerSummary, type PaginatedQuestionsResponse } from '../../api';
import { poolStatusToQcStatus, qcStatusToPoolStatus, type BankPoolStatus } from '../../../shared/bankStatus';
import type { QcStatus, QuestionItem } from '../../../shared/contracts';
import { useI18n } from '../../i18n';
import { createUndoStack, useUndoRedoShortcuts, type UndoStack } from '../../undoHistory';
import { BankFilterBar } from './bank/BankFilterBar';
import { BankMetricsBar } from './bank/BankMetricsBar';
import { BankQuestionList } from './bank/BankQuestionList';
import { QuestionInspectorPane } from './bank/QuestionInspectorPane';
import { SimulatorDialog, type SimulatorLaunchOptions } from './bank/SimulatorDialog';
import { useBankQuery } from './bank/useBankQuery';

interface BankStatusUndoEntry {
  changes: { qid: string; prevQcStatus: QcStatus; nextQcStatus: QcStatus }[];
}

interface QuestionBankStudioProps {
  /** Question to select from a deep link or flag jump, even when it is off the current page. */
  focusQid?: string;
  initialBatchId?: string;
  onClearInitialBatch?: () => void;
  onOpenSession: (sessionId: string) => void;
  onNotice: (msg: string) => void;
  onError: (msg: string) => void;
  onDataMutated?: () => void;
  monitoredStudentId?: string | null;
  learnerReady?: boolean;
  monitoredLearner?: AdminLearnerSummary | null;
  studentCount?: number;
}

/** Admin Question Bank: metrics strip, filter bar, master list and tabbed inspector. */
export function QuestionBankStudio({
  focusQid = '',
  initialBatchId = '',
  onClearInitialBatch,
  onOpenSession,
  onNotice,
  onError,
  onDataMutated,
  monitoredStudentId,
  learnerReady = true,
  monitoredLearner = null,
  studentCount = 0,
}: QuestionBankStudioProps) {
  const { t, isZh, poolStatusLabel } = useI18n();
  const [selectedQid, setSelectedQid] = useState<string>(
    () => focusQid || new URLSearchParams(window.location.search).get('qid') || ''
  );
  // A pinned question stays selected even when the list does not contain it.
  const [pinnedQid, setPinnedQid] = useState<string>(() => focusQid || new URLSearchParams(window.location.search).get('qid') || '');
  const pinnedQidRef = useRef(pinnedQid);
  pinnedQidRef.current = pinnedQid;
  const [shownFocusQid, setShownFocusQid] = useState(focusQid);
  if (focusQid !== shownFocusQid) {
    // A new jump (flag link, back/forward): select and pin it during render, no effect flash.
    setShownFocusQid(focusQid);
    if (focusQid) {
      setSelectedQid(focusQid);
      setPinnedQid(focusQid);
    }
  }
  const [checkedQids, setCheckedQids] = useState<string[]>([]);
  const [versionsForSelected, setVersionsForSelected] = useState<QuestionItem[]>([]);
  const [simOpen, setSimOpen] = useState(false);
  const [launchingSim, setLaunchingSim] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [updatingStatusQid, setUpdatingStatusQid] = useState<string | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [uploadingQid, setUploadingQid] = useState<string | null>(null);
  const [undoBusy, setUndoBusy] = useState(false);
  const inspectorRef = useRef<HTMLElement>(null);
  const statusUndoStackRef = useRef<UndoStack<BankStatusUndoEntry> | null>(null);
  if (!statusUndoStackRef.current) {
    statusUndoStackRef.current = createUndoStack<BankStatusUndoEntry>(40);
  }

  const onLoaded = useCallback((res: PaginatedQuestionsResponse) => {
    setSelectedQid((prev) => {
      if (prev && prev === pinnedQidRef.current) return prev;
      if (res.questions.length === 0) return '';
      return res.questions.some((q) => q.questionId === prev) ? prev : res.questions[0].questionId;
    });
  }, []);

  const bank = useBankQuery({
    initialBatchId,
    monitoredStudentId,
    enabled: learnerReady,
    onError,
    loadErrorMessage: isZh ? '无法加载题库。' : 'Unable to load the Question Bank.',
    onLoaded,
    focusQid: pinnedQid,
  });
  const { filters, updateFilter, questions, setQuestions, refresh, focused, patchFocusedQuestion } = bank;

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

  const pinnedOutsideList = Boolean(
    pinnedQid && selectedQid === pinnedQid && !questions.some((q) => q.questionId === pinnedQid)
  );
  const selectedQuestion = useMemo(() => {
    const inList = questions.find((q) => q.questionId === selectedQid);
    if (inList) return inList;
    if (pinnedQid && selectedQid === pinnedQid) {
      return focused?.qid === pinnedQid && focused.question ? focused.question : null;
    }
    return questions[0] || null;
  }, [questions, selectedQid, pinnedQid, focused]);
  const pinnedStatus = pinnedOutsideList ? (focused?.qid === pinnedQid ? focused.status : 'loading') : null;

  useEffect(() => {
    if (!selectedQuestion) {
      setVersionsForSelected([]);
      return;
    }
    if (selectedQuestion.version <= 1 && !filters.includeHistorical) {
      setVersionsForSelected([selectedQuestion]);
      return;
    }
    let active = true;
    api
      .getQuestionVersions(selectedQuestion.questionId)
      .then((res) => {
        if (active) setVersionsForSelected(res.versions.map((v) => v.question));
      })
      .catch(() => {
        if (active) setVersionsForSelected([]);
      });
    return () => {
      active = false;
    };
  }, [selectedQuestion, filters.includeHistorical]);
  const selectedStimulus = selectedQuestion?.stimulusId
    ? bank.stimuliById[selectedQuestion.stimulusId] ??
      (focused?.question?.questionId === selectedQuestion.questionId ? focused.stimulus : undefined)
    : undefined;

  const afterMutation = useCallback(() => {
    refresh();
    onDataMutated?.();
  }, [refresh, onDataMutated]);

  const handleSelect = useCallback((qid: string) => {
    setSelectedQid(qid);
    setPinnedQid('');
    // On stacked (mobile) layouts the inspector sits below the list; bring it into view.
    if (!window.matchMedia('(min-width: 1280px)').matches) {
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
    const current =
      questions.find((q) => q.questionId === qid) ??
      (focused?.question?.questionId === qid ? focused.question : undefined);
    if (!current || updatingStatusQid === qid || qcStatusToPoolStatus(current.qcStatus) === nextStatus) return;
    const prevQcStatus = current.qcStatus;
    const nextQcStatus = poolStatusToQcStatus(nextStatus);
    setUpdatingStatusQid(qid);
    // Optimistic: reflect the new status immediately, revert on failure.
    setQuestions((prev) => prev.map((q) => (q.questionId === qid ? { ...q, qcStatus: nextQcStatus } : q)));
    patchFocusedQuestion(qid, { qcStatus: nextQcStatus });
    try {
      await api.updateQuestionStatus(qid, nextQcStatus);
      statusUndoStackRef.current!.push({
        changes: [{ qid, prevQcStatus, nextQcStatus }],
      });
      onNotice(isZh ? `已将 ${qid} 状态设为“${poolStatusLabel(nextStatus)}”。` : `Set ${qid} to ${poolStatusLabel(nextStatus)}.`);
      afterMutation();
    } catch (err) {
      setQuestions((prev) => prev.map((q) => (q.questionId === qid ? { ...q, qcStatus: prevQcStatus } : q)));
      patchFocusedQuestion(qid, { qcStatus: prevQcStatus });
      onError(err instanceof Error ? err.message : isZh ? '无法更新题目状态。' : 'Unable to update question status.');
    } finally {
      setUpdatingStatusQid(null);
    }
  };

  const handleBulkStatus = async (ids: string[], nextStatus: BankPoolStatus, label?: string) => {
    if (ids.length === 0) return;
    const nextQcStatus = poolStatusToQcStatus(nextStatus);
    const byId = new Map(questions.map((q) => [q.questionId, q]));
    if (focused?.question) byId.set(focused.question.questionId, focused.question);
    const recordedChanges = ids.map((qid) => ({
      qid,
      prevQcStatus: (byId.get(qid)?.qcStatus ?? 'active') as QcStatus,
      nextQcStatus,
    }));
    setBulkBusy(true);
    try {
      const res = await api.bulkUpdateQuestionStatus(ids, nextQcStatus);
      statusUndoStackRef.current!.push({ changes: recordedChanges });
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

  const applyStatusUndoEntry = useCallback(
    async (entry: BankStatusUndoEntry, direction: 'undo' | 'redo'): Promise<boolean> => {
      if (undoBusy || bulkBusy || updatingStatusQid !== null) return false;
      setUndoBusy(true);
      try {
        const grouped = new Map<QcStatus, string[]>();
        for (const ch of entry.changes) {
          const targetQc = direction === 'undo' ? ch.prevQcStatus : ch.nextQcStatus;
          const arr = grouped.get(targetQc) || [];
          arr.push(ch.qid);
          grouped.set(targetQc, arr);
        }
        for (const [qcStatus, qids] of grouped.entries()) {
          if (qids.length === 1) {
            await api.updateQuestionStatus(qids[0], qcStatus);
          } else {
            await api.bulkUpdateQuestionStatus(qids, qcStatus);
          }
          const qidSet = new Set(qids);
          setQuestions((prev) => prev.map((q) => (qidSet.has(q.questionId) ? { ...q, qcStatus } : q)));
          for (const qid of qids) {
            patchFocusedQuestion(qid, { qcStatus });
          }
        }
        onNotice(
          t(direction === 'undo' ? 'common.undidBankStatus' : 'common.redidBankStatus', {
            count: entry.changes.length,
          })
        );
        afterMutation();
        return true;
      } catch (err) {
        onError(err instanceof Error ? err.message : isZh ? '撤销状态更改失败。' : 'Unable to undo status change.');
        return false;
      } finally {
        setUndoBusy(false);
      }
    },
    [undoBusy, bulkBusy, updatingStatusQid, setQuestions, patchFocusedQuestion, onNotice, onError, afterMutation, t, isZh]
  );

  useUndoRedoShortcuts({
    enabled: !simOpen && !undoBusy && !bulkBusy && !deletingBusy,
    onUndo: () => {
      const entry = statusUndoStackRef.current!.undo();
      if (!entry) return false;
      void applyStatusUndoEntry(entry, 'undo');
      return true;
    },
    onRedo: () => {
      const entry = statusUndoStackRef.current!.redo();
      if (!entry) return false;
      void applyStatusUndoEntry(entry, 'redo');
      return true;
    },
  });

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

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-12">
        <div className="min-w-0 xl:col-span-5">
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
        <div className="min-w-0 xl:col-span-7 space-y-2">
          {pinnedStatus === 'ready' && selectedQuestion && (
            <p className="rounded-[10px] border border-[#E5DFD5] bg-[#FAF8F5] px-3 py-2 text-xs text-[#4A5955]">
              {t('bank.deepLinkNote')}
            </p>
          )}
          {pinnedStatus === 'loading' || pinnedStatus === 'missing' ? (
            <div
              role={pinnedStatus === 'missing' ? 'alert' : 'status'}
              className="rounded-[16px] border border-[#E5DFD5] bg-white py-16 px-6 text-center text-sm text-[#615E57] break-all"
            >
              {pinnedStatus === 'missing'
                ? t('bank.deepLinkMissing', { id: pinnedQid })
                : t('bank.deepLinkLoading', { id: pinnedQid })}
            </div>
          ) : selectedQuestion ? (
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
            <div className="rounded-[16px] border border-[#E5DFD5] bg-white py-16 text-center text-sm text-[#615E57]">
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
