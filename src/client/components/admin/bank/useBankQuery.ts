import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type BatchDirectorySummary, type PaginatedQuestionsResponse } from '../../../api';
import type {
  BankPoolStatus,
  PoolHealthSummary,
  QuestionCompletionStatus,
  QuestionProgressMeta,
} from '../../../../shared/bankStatus';
import type { QuestionItem, SectionCode, StimulusGroup } from '../../../../shared/contracts';

export interface BankFilters {
  search: string;
  section: '' | SectionCode;
  poolStatus: '' | BankPoolStatus;
  completionStatus: '' | QuestionCompletionStatus;
  batchId: string;
  formatType: string;
  skillId: string;
  poolType: string;
  sort: 'id_asc' | 'updated_desc' | 'version_desc';
  flaggedOnly: boolean;
  missingVisual: boolean;
  missingExplanation: boolean;
  includeHistorical: boolean;
}

export const DEFAULT_BANK_FILTERS: BankFilters = {
  search: '',
  section: '',
  poolStatus: '',
  completionStatus: '',
  batchId: '',
  formatType: '',
  skillId: '',
  poolType: '',
  sort: 'id_asc',
  flaggedOnly: false,
  missingVisual: false,
  missingExplanation: false,
  includeHistorical: false,
};

/** Filters that live in the Filters popover (search and section stay on the bar). */
export const POPOVER_FILTER_KEYS = [
  'poolStatus',
  'completionStatus',
  'batchId',
  'skillId',
  'formatType',
  'poolType',
  'flaggedOnly',
  'missingVisual',
  'missingExplanation',
  'includeHistorical',
] as const satisfies readonly (keyof BankFilters)[];

export function countPopoverFilters(filters: BankFilters): number {
  return POPOVER_FILTER_KEYS.filter((key) => Boolean(filters[key])).length;
}

const SEARCH_DEBOUNCE_MS = 300;

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

interface UseBankQueryOptions {
  initialBatchId?: string;
  monitoredStudentId?: string | null;
  onError: (message: string) => void;
  loadErrorMessage: string;
  onLoaded?: (res: PaginatedQuestionsResponse) => void;
}

/**
 * Question Bank list state: filters, pagination, debounced search and cancellable fetches.
 * Pool health and batch summaries are requested only when the learner changes or on refresh().
 */
export function useBankQuery({
  initialBatchId = '',
  monitoredStudentId,
  onError,
  loadErrorMessage,
  onLoaded,
}: UseBankQueryOptions) {
  const [filters, setFilters] = useState<BankFilters>(() => ({ ...DEFAULT_BANK_FILTERS, batchId: initialBatchId }));
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [refreshToken, setRefreshToken] = useState(0);
  const [loading, setLoading] = useState(true);

  const [questions, setQuestions] = useState<QuestionItem[]>([]);
  const [stimuliById, setStimuliById] = useState<Record<string, StimulusGroup>>({});
  const [totalMatching, setTotalMatching] = useState(0);
  const [openFlagsByQid, setOpenFlagsByQid] = useState<Record<string, number>>({});
  const [progressByQid, setProgressByQid] = useState<Record<string, QuestionProgressMeta>>({});
  const [poolHealth, setPoolHealth] = useState<PoolHealthSummary | null>(null);
  const [masteredLiveIds, setMasteredLiveIds] = useState<string[]>([]);
  const [batchSummaries, setBatchSummaries] = useState<BatchDirectorySummary[]>([]);

  const debouncedSearch = useDebouncedValue(filters.search.trim(), SEARCH_DEBOUNCE_MS);
  const callbacksRef = useRef({ onError, onLoaded, loadErrorMessage });
  callbacksRef.current = { onError, onLoaded, loadErrorMessage };

  // Summary data depends only on the learner and on bank mutations, not on filters/pages.
  const summaryKey = `${monitoredStudentId ?? 'none'}:${refreshToken}`;
  const loadedSummaryKey = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const includeSummary = loadedSummaryKey.current !== summaryKey;
    setLoading(true);
    api
      .getAdminQuestions(
        {
          search: debouncedSearch || undefined,
          section: filters.section || undefined,
          poolStatus: filters.poolStatus || undefined,
          completionStatus: filters.completionStatus || undefined,
          batchId: filters.batchId || undefined,
          formatType: filters.formatType || undefined,
          skillId: filters.skillId || undefined,
          poolType: filters.poolType || undefined,
          sort: filters.sort,
          flaggedOnly: filters.flaggedOnly,
          missingVisual: filters.missingVisual,
          missingExplanation: filters.missingExplanation,
          includeHistorical: filters.includeHistorical,
          studentId: monitoredStudentId === undefined ? undefined : (monitoredStudentId ?? 'none'),
          page,
          pageSize,
          includeSummary,
        },
        controller.signal
      )
      .then((res) => {
        if (controller.signal.aborted) return;
        setQuestions(res.questions);
        setStimuliById(res.stimuliById || {});
        setTotalMatching(Number(res.totalMatching ?? 0));
        setOpenFlagsByQid(res.openFlagsByQuestionId || {});
        setProgressByQid(res.progressByQuestionId || {});
        if (includeSummary) {
          loadedSummaryKey.current = summaryKey;
          setPoolHealth(res.poolHealth ?? null);
          setMasteredLiveIds(res.masteredLiveQuestionIds || []);
          setBatchSummaries(res.batchSummaries || []);
        }
        callbacksRef.current.onLoaded?.(res);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        const { onError: report, loadErrorMessage: fallback } = callbacksRef.current;
        report(err instanceof Error ? err.message : fallback);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [
    debouncedSearch,
    filters.section,
    filters.poolStatus,
    filters.completionStatus,
    filters.batchId,
    filters.formatType,
    filters.skillId,
    filters.poolType,
    filters.sort,
    filters.flaggedOnly,
    filters.missingVisual,
    filters.missingExplanation,
    filters.includeHistorical,
    monitoredStudentId,
    page,
    pageSize,
    summaryKey,
  ]);

  const updateFilter = useCallback(<K extends keyof BankFilters>(key: K, value: BankFilters[K]) => {
    setFilters((prev) => {
      const next = { ...prev, [key]: value };
      // A skill only makes sense inside its section.
      if (key === 'section') next.skillId = '';
      return next;
    });
    if (key !== 'sort') setPage(1);
  }, []);

  const resetFilters = useCallback(() => {
    setFilters(DEFAULT_BANK_FILTERS);
    setPage(1);
  }, []);

  const refresh = useCallback(() => setRefreshToken((n) => n + 1), []);

  const changePageSize = useCallback((size: number) => {
    setPageSize(size);
    setPage(1);
  }, []);

  return {
    filters,
    updateFilter,
    resetFilters,
    page,
    setPage,
    pageSize,
    setPageSize: changePageSize,
    totalPages: Math.max(1, Math.ceil(totalMatching / pageSize)),
    loading,
    refresh,
    questions,
    setQuestions,
    stimuliById,
    totalMatching,
    openFlagsByQid,
    progressByQid,
    poolHealth,
    masteredLiveIds,
    batchSummaries,
  };
}

export type BankQuery = ReturnType<typeof useBankQuery>;
