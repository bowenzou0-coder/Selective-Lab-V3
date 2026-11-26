import { useCallback, useEffect, useMemo, useState } from 'react';
import { LanguageToggle, useI18n } from '../i18n';
import { CheckCircle2 } from 'lucide-react';
import type { SessionDetailResponse } from '../api';
import type { EvidenceCitationRef, MarkingResult, StudentQuestionView } from '../../shared/contracts';
import {
  evaluateNswBenchmark,
  extractBenchmarkScoresFromSession,
  type NswPerformanceBand,
} from '../../shared/nswBenchmark';
import { QuestionWorkspace } from './QuestionWorkspace';
import { WritingReviewSection } from './review/WritingReviewSection';
import {
  matchesReviewFilter,
  ObjectiveStatusChip,
  ReviewFilterTabs,
  ReviewItemPills,
  ReviewPrevNext,
  type ItemStatus,
  type ReviewFilter,
} from './review/ObjectiveReviewList';
import { FlagQuestionButton, FlagQuestionModal, useQuestionFlagging } from './review/FlagQuestionModal';
import { useWritingEvaluation } from './review/useWritingEvaluation';
import type { AnnotationFilter, WritingViewMode } from './review/reviewUtils';

interface PostSubmissionReviewProps {
  sessionId: string;
  sessionTitle?: string;
  sessionMode?: string;
  correctSlots: number;
  totalSlots: number;
  elapsedSec: number;
  questions: StudentQuestionView[];
  reviewResults: Record<string, MarkingResult[]>;
  writingReview?: SessionDetailResponse['writingReview'];
  onDoneHome: () => void;
  onViewProgress: () => void;
  onViewBenchmarks?: () => void;
}

export function PostSubmissionReview({
  sessionId,
  sessionTitle,
  sessionMode,
  correctSlots,
  totalSlots,
  elapsedSec,
  questions,
  reviewResults,
  writingReview: initialWritingReview,
  onDoneHome,
  onViewProgress,
  onViewBenchmarks,
}: PostSubmissionReviewProps) {
  const { t, sectionShortLabel } = useI18n();
  const [writingReview, setWritingReview] = useState(initialWritingReview || []);

  const [filter, setFilter] = useState<ReviewFilter>('all');
  const [writingViewMode, setWritingViewMode] = useState<WritingViewMode>('critique');
  const [annotationFilter, setAnnotationFilter] = useState<AnnotationFilter>('all');
  const [showInlineMarkers, setShowInlineMarkers] = useState(true);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [selectedExemplarAnnId, setSelectedExemplarAnnId] = useState<string | null>(null);
  const [selectedQuestionId, setSelectedQuestionId] = useState<string>(
    questions[0]?.questionId || ''
  );
  const [activeEvidenceRef, setActiveEvidenceRef] = useState<EvidenceCitationRef | null>(null);

  const flagging = useQuestionFlagging(sessionId);

  useEffect(() => {
    if (initialWritingReview) {
      setWritingReview(initialWritingReview);
    }
  }, [initialWritingReview]);

  const { evaluatingId, evalError, evaluateWriting } = useWritingEvaluation({
    sessionId,
    writingReview,
    setWritingReview,
    onEvaluated: () => {
      setSelectedAnnotationId(null);
      setSelectedExemplarAnnId(null);
    },
  });

  const accuracy = totalSlots > 0 ? Math.round((correctSlots / totalSlots) * 100) : 0;
  const mins = Math.floor(elapsedSec / 60);
  const secs = elapsedSec % 60;

  const itemStatusMap = useMemo(() => {
    const map = new Map<string, ItemStatus>();
    for (const q of questions) {
      if (q.formatType === 'WRIT_TYPED_TASK') {
        map.set(q.questionId, { isCorrect: true, hasIncorrect: false, hasUnanswered: false });
        continue;
      }
      const res = reviewResults[q.questionId] || [];
      const hasUnanswered = res.some((r) => r.selectedAnswer === null);
      const hasIncorrect = res.some((r) => !r.isCorrect);
      map.set(q.questionId, {
        isCorrect: res.length > 0 && !hasIncorrect,
        hasIncorrect,
        hasUnanswered,
      });
    }
    return map;
  }, [questions, reviewResults]);

  const counts = useMemo(() => {
    let incorrect = 0;
    let unanswered = 0;
    for (const st of itemStatusMap.values()) {
      if (st.hasIncorrect) incorrect++;
      if (st.hasUnanswered) unanswered++;
    }
    return { all: questions.length, incorrect, unanswered };
  }, [questions.length, itemStatusMap]);

  const filteredQuestions = useMemo(
    () => questions.filter((q) => matchesReviewFilter(itemStatusMap.get(q.questionId), filter)),
    [questions, filter, itemStatusMap]
  );

  const questionNumberById = useMemo(() => {
    const map = new Map<string, number>();
    questions.forEach((q, idx) => map.set(q.questionId, idx + 1));
    return map;
  }, [questions]);

  const sessionBenchmark = useMemo(
    () =>
      extractBenchmarkScoresFromSession({
        questions,
        reviewResults,
        writingReview,
        sessionTitle,
      }),
    [questions, reviewResults, writingReview, sessionTitle]
  );

  const showSessionBenchmark =
    sessionMode === 'benchmark_exam' ||
    (sessionBenchmark.hasObjectiveMultiSection && questions.length >= 20);

  const readOnlyBenchmarkEval = useMemo(() => {
    if (!showSessionBenchmark) return null;
    return evaluateNswBenchmark({
      read: sessionBenchmark.read,
      math: sessionBenchmark.math,
      think: sessionBenchmark.think,
      writ: sessionBenchmark.writ,
      difficulty: sessionBenchmark.suggestedDifficulty,
      weighting: 'official_2025_equal',
      genderFilter: 'all',
    });
  }, [showSessionBenchmark, sessionBenchmark]);

  const bandShortLabel = (band: NswPerformanceBand): string => {
    if (band === 'top_10') return t('bench.bandTop10');
    if (band === 'next_15') return t('bench.bandNext15');
    if (band === 'next_25') return t('bench.bandNext25');
    return t('bench.bandLowest50');
  };

  const activeIndex = useMemo(
    () => Math.max(0, filteredQuestions.findIndex((q) => q.questionId === selectedQuestionId)),
    [filteredQuestions, selectedQuestionId]
  );
  const activeQuestion = filteredQuestions[activeIndex] || filteredQuestions[0] || null;

  const activeAnswersByPartId = useMemo(() => {
    const out: Record<string, string | null> = {};
    if (!activeQuestion) return out;
    const res = reviewResults[activeQuestion.questionId] || [];
    for (const r of res) {
      out[r.partId] = r.selectedAnswer;
    }
    return out;
  }, [activeQuestion, reviewResults]);

  const handleSelectQuestion = useCallback((qid: string) => {
    setSelectedQuestionId(qid);
    setActiveEvidenceRef(null);
  }, []);

  const handleFilterChange = (next: ReviewFilter) => {
    setFilter(next);
    setActiveEvidenceRef(null);
    const nextList = questions.filter((q) => matchesReviewFilter(itemStatusMap.get(q.questionId), next));
    if (nextList.length > 0 && !nextList.some((q) => q.questionId === selectedQuestionId)) {
      setSelectedQuestionId(nextList[0].questionId);
    }
  };

  const isWritingOnly =
    questions.length > 0 && questions.every((q) => q.formatType === 'WRIT_TYPED_TASK');

  const isActiveWriting = activeQuestion?.formatType === 'WRIT_TYPED_TASK';
  const activeWritingReview = useMemo(
    () =>
      isActiveWriting && activeQuestion
        ? writingReview.find((w) => w.questionId === activeQuestion.questionId) || writingReview[0] || null
        : null,
    [isActiveWriting, activeQuestion, writingReview]
  );

  const activeStatus = activeQuestion ? itemStatusMap.get(activeQuestion.questionId) : undefined;
  const writingFooterNav =
    filteredQuestions.length > 1 ? (
      <ReviewPrevNext
        items={filteredQuestions}
        activeIndex={activeIndex}
        onSelect={handleSelectQuestion}
        className="pt-4 mt-6 border-t border-[#E5DFD5] flex items-center justify-between gap-3"
      />
    ) : null;

  return (
    <div className="min-h-screen lg:h-screen lg:overflow-hidden flex flex-col bg-[#FAF8F5] text-[#113C36]">
      {/* Quiet Review Top Rail */}
      <header className="sticky top-0 z-30 border-b border-[#E5DFD5] bg-[#F3EFE8] px-4 sm:px-6 py-3">
        <div className="max-w-[1440px] mx-auto flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-baseline gap-3">
              <div className="font-serif-display font-extrabold text-[22px] tracking-[-0.02em] text-[#113C36] tabular-nums leading-none">
                {totalSlots > 0 ? `${correctSlots} / ${totalSlots}` : t('rev.writingSubmitted')}
              </div>
              {totalSlots > 0 && (
                <span className="px-2.5 py-0.5 rounded-full bg-white border border-[#E5DFD5] text-xs font-sans-display font-semibold text-[#113C36] tabular-nums">
                  {accuracy}%
                </span>
              )}
              <span className="text-xs text-[#4A5955] tabular-nums">
                {mins}m {String(secs).padStart(2, '0')}s
              </span>
            </div>

            {/* Filter Tabs (hidden for writing-only sessions) */}
            {!isWritingOnly && (
              <ReviewFilterTabs filter={filter} counts={counts} onChange={handleFilterChange} />
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <LanguageToggle compact />
            {sessionMode === 'benchmark_exam' && onViewBenchmarks && (
              <button
                type="button"
                onClick={onViewBenchmarks}
                className="px-3.5 py-1.5 rounded-[10px] border border-[#1D6346]/40 bg-[#E5F0EA] hover:bg-[#d8e9df] text-xs font-sans-display font-semibold text-[#113C36] cursor-pointer transition-colors whitespace-nowrap"
              >
                {t('rev.openBenchmarkReport')}
              </button>
            )}
            <button
              type="button"
              onClick={onViewProgress}
              className="px-3.5 py-1.5 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-xs font-sans-display font-semibold text-[#113C36] cursor-pointer transition-colors whitespace-nowrap"
            >
              {t('rev.viewProgress')}
            </button>
            <button
              type="button"
              onClick={onDoneHome}
              className="px-4 py-1.5 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-xs font-sans-display font-semibold cursor-pointer transition-colors whitespace-nowrap"
            >
              {t('rev.backToStudio')}
            </button>
          </div>
        </div>

        {/* Item Selector Pills (hidden for single-task writing sprints) */}
        {filteredQuestions.length > 0 && !(isWritingOnly && filteredQuestions.length <= 1) && (
          <div className="max-w-[1440px] mx-auto mt-2.5">
            <ReviewItemPills
              items={filteredQuestions}
              questionNumberById={questionNumberById}
              itemStatusMap={itemStatusMap}
              activeQuestionId={activeQuestion?.questionId}
              onSelect={handleSelectQuestion}
            />
          </div>
        )}
      </header>

      {/* Read-only Benchmark Standing Summary (for full mocks & benchmark exams) */}
      {showSessionBenchmark && readOnlyBenchmarkEval && (
        <div className="shrink-0 border-b border-[#E5DFD5] bg-[#FAF8F5] px-4 sm:px-6 py-3">
          <div className="max-w-[1440px] mx-auto flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            <div className="space-y-0.5">
              <div className="font-sans-display font-semibold text-xs text-[#113C36]">
                {t('bm.reviewStripTitle')}
              </div>
              <div className="text-[11px] text-[#4A5955]">
                {sessionBenchmark.writingEvaluated
                  ? t('bench.seededFromSession')
                  : t('bench.seededFromSessionNoWrit')}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs tabular-nums">
              <span className="px-3 py-1 rounded-full bg-[#E5F0EA] border border-[#C5DDD1] font-sans-display font-semibold text-[#113C36]">
                {readOnlyBenchmarkEval.scaledScore120.toFixed(1)} / 120
              </span>
              <span className="px-2.5 py-1 rounded-full bg-white border border-[#E5DFD5] text-[#4A5955]">
                {t('bench.stateRankShort', {
                  rank: readOnlyBenchmarkEval.estimatedStateRank.toLocaleString(),
                  pct: readOnlyBenchmarkEval.estimatedPercentile,
                })}
              </span>
              {(['READ', 'MATH', 'THINK', 'WRIT'] as const).map((sec) => {
                const ev = readOnlyBenchmarkEval.sections[sec];
                return (
                  <span
                    key={sec}
                    className="px-2.5 py-1 rounded-full bg-white border border-[#E5DFD5] text-[#113C36]"
                  >
                    {sectionShortLabel(sec)} {ev.score}/{ev.maxScore} ({bandShortLabel(ev.band)})
                  </span>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Main Review Workspace */}
      {filteredQuestions.length === 0 ? (
        <main className="flex-1 flex items-center justify-center p-8">
          <div className="max-w-md text-center space-y-3 p-6 rounded-[18px] bg-white border border-[#E5DFD5]">
            <CheckCircle2 className="w-8 h-8 text-[#1D6346] mx-auto" />
            <h2 className="font-sans-display font-semibold text-base text-[#113C36]">
              {t('rev.noFilteredItems', { filter })}
            </h2>
            <button
              type="button"
              onClick={() => handleFilterChange('all')}
              className="px-4 py-2 rounded-[10px] bg-[#113C36] text-white text-xs font-sans-display font-semibold cursor-pointer"
            >
              {t('rev.showAllItems')}
            </button>
          </div>
        </main>
      ) : activeQuestion ? (
        <div className="flex-1 min-h-0 flex flex-col">
          {/* Item Flag & Status Strip */}
          <div className="border-b border-[#E5DFD5] bg-[#FAF8F5] px-4 sm:px-6 py-2">
            <div className="max-w-[1440px] mx-auto flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex flex-wrap items-center gap-2.5">
                {(!isActiveWriting || questions.length > 1) && (
                  <span className="font-sans-display font-semibold text-[#113C36] tabular-nums">
                    {t('session.qOfTotal', {
                      current: questionNumberById.get(activeQuestion.questionId) ?? 1,
                      total: questions.length,
                    })}
                  </span>
                )}
                {isActiveWriting ? (
                  <div
                    role="group"
                    aria-label={t('rev.writingMetricsTitle')}
                    className="inline-flex flex-wrap items-center gap-1 p-0.5 bg-white rounded-[10px] border border-[#E5DFD5]"
                  >
                    {(
                      [
                        ['critique', t('rev.tabCritique')],
                        ['exemplar', t('rev.tabExemplar')],
                        ['prompt', t('rev.tabPrompt')],
                      ] as [WritingViewMode, string][]
                    ).map(([modeId, modeLabel]) => (
                      <button
                        key={modeId}
                        type="button"
                        aria-pressed={writingViewMode === modeId}
                        onClick={() => setWritingViewMode(modeId)}
                        className={`px-3 py-1 rounded-[8px] text-xs font-sans-display font-semibold cursor-pointer whitespace-nowrap transition-colors ${
                          writingViewMode === modeId
                            ? 'bg-[#113C36] text-white'
                            : 'text-[#4A5955] hover:text-[#113C36]'
                        }`}
                      >
                        {modeLabel}
                      </button>
                    ))}
                  </div>
                ) : (
                  activeStatus && <ObjectiveStatusChip status={activeStatus} />
                )}
              </div>

              <FlagQuestionButton flagging={flagging} questionId={activeQuestion.questionId} />
            </div>

            <FlagQuestionModal flagging={flagging} questionId={activeQuestion.questionId} />
          </div>

          {isActiveWriting ? (
            <WritingReviewSection
              question={activeQuestion}
              writingReview={activeWritingReview}
              viewMode={writingViewMode}
              annotationFilter={annotationFilter}
              onAnnotationFilterChange={setAnnotationFilter}
              showInlineMarkers={showInlineMarkers}
              onShowInlineMarkersChange={setShowInlineMarkers}
              selectedAnnotationId={selectedAnnotationId}
              onSelectAnnotation={setSelectedAnnotationId}
              selectedExemplarAnnId={selectedExemplarAnnId}
              onSelectExemplarAnn={setSelectedExemplarAnnId}
              evaluatingId={evaluatingId}
              evalError={evalError}
              onEvaluate={evaluateWriting}
              footerNav={writingFooterNav}
            />
          ) : (
            <QuestionWorkspace
              mode="review"
              question={activeQuestion}
              answersByPartId={activeAnswersByPartId}
              reviewResults={reviewResults[activeQuestion.questionId] || []}
              activeEvidenceRef={activeEvidenceRef}
              onSelectEvidenceRef={setActiveEvidenceRef}
              footerNav={
                <ReviewPrevNext
                  items={filteredQuestions}
                  activeIndex={activeIndex}
                  onSelect={handleSelectQuestion}
                  className="pt-4 border-t border-[#E5DFD5] flex items-center justify-between gap-3"
                />
              }
            />
          )}
        </div>
      ) : null}
    </div>
  );
}
