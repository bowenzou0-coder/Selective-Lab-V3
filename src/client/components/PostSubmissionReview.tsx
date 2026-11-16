import { useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Flag,
  Sparkles,
  XCircle,
} from 'lucide-react';
import { api, type SessionDetailResponse } from '../api';
import type {
  EvidenceCitationRef,
  MarkingResult,
  StudentQuestionView,
  WritingDeterministicMetrics,
  WritingEvaluationRecord,
} from '../../shared/contracts';
import { SKILLS_TAXONOMY } from '../../shared/skills';
import { QuestionWorkspace } from './QuestionWorkspace';

const SKILL_NAME_MAP = new Map(SKILLS_TAXONOMY.map((s) => [s.skillId, s.displayName]));

interface PostSubmissionReviewProps {
  sessionId: string;
  correctSlots: number;
  totalSlots: number;
  elapsedSec: number;
  questions: StudentQuestionView[];
  reviewResults: Record<string, MarkingResult[]>;
  writingReview?: SessionDetailResponse['writingReview'];
  onDoneHome: () => void;
  onViewProgress: () => void;
}

type ReviewFilter = 'all' | 'incorrect' | 'unanswered';

export function PostSubmissionReview({
  sessionId,
  correctSlots,
  totalSlots,
  elapsedSec,
  questions,
  reviewResults,
  writingReview: initialWritingReview,
  onDoneHome,
  onViewProgress,
}: PostSubmissionReviewProps) {
  const [writingReview, setWritingReview] = useState(initialWritingReview || []);
  const [evaluatingId, setEvaluatingId] = useState<string | null>(null);
  const [evalError, setEvalError] = useState('');

  const [filter, setFilter] = useState<ReviewFilter>('all');
  const [selectedQuestionId, setSelectedQuestionId] = useState<string>(
    questions[0]?.questionId || ''
  );
  const [activeEvidenceRef, setActiveEvidenceRef] = useState<EvidenceCitationRef | null>(null);

  const [flaggingQid, setFlaggingQid] = useState<string | null>(null);
  const [flagReason, setFlagReason] = useState('Unclear wording or diagram');
  const [flagNotes, setFlagNotes] = useState('');
  const [flaggedIds, setFlaggedIds] = useState<Set<string>>(new Set());

  const accuracy = totalSlots > 0 ? Math.round((correctSlots / totalSlots) * 100) : 0;
  const mins = Math.floor(elapsedSec / 60);
  const secs = elapsedSec % 60;

  const itemStatusMap = useMemo(() => {
    const map = new Map<
      string,
      { isCorrect: boolean; hasIncorrect: boolean; hasUnanswered: boolean }
    >();
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

  const filteredQuestions = useMemo(() => {
    return questions.filter((q) => {
      const st = itemStatusMap.get(q.questionId);
      if (!st) return true;
      if (filter === 'incorrect') return st.hasIncorrect;
      if (filter === 'unanswered') return st.hasUnanswered;
      return true;
    });
  }, [questions, filter, itemStatusMap]);

  const activeIndex = Math.max(
    0,
    filteredQuestions.findIndex((q) => q.questionId === selectedQuestionId)
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

  const handleSelectQuestion = (qid: string) => {
    setSelectedQuestionId(qid);
    setActiveEvidenceRef(null);
  };

  const handleFilterChange = (next: ReviewFilter) => {
    setFilter(next);
    setActiveEvidenceRef(null);
    const nextList = questions.filter((q) => {
      const st = itemStatusMap.get(q.questionId);
      if (!st) return true;
      if (next === 'incorrect') return st.hasIncorrect;
      if (next === 'unanswered') return st.hasUnanswered;
      return true;
    });
    if (nextList.length > 0 && !nextList.some((q) => q.questionId === selectedQuestionId)) {
      setSelectedQuestionId(nextList[0].questionId);
    }
  };

  const handleEvaluateWriting = async (submissionId: string) => {
    setEvaluatingId(submissionId);
    setEvalError('');
    try {
      const res = await api.evaluateWriting(submissionId);
      setWritingReview((prev) =>
        prev.map((w) =>
          w.submissionId === submissionId
            ? { ...w, evaluations: [res.evaluation, ...w.evaluations] }
            : w
        )
      );
    } catch (err) {
      setEvalError(err instanceof Error ? err.message : 'Unable to evaluate writing.');
    } finally {
      setEvaluatingId(null);
    }
  };

  const handleSubmitFlag = async (questionId: string) => {
    try {
      await api.flagQuestion({ questionId, sessionId, reason: flagReason, notes: flagNotes });
      setFlaggedIds((prev) => new Set(prev).add(questionId));
      setFlaggingQid(null);
      setFlagNotes('');
    } catch {
      // ignore
    }
  };

  const renderEvaluationCard = (ev: WritingEvaluationRecord) => (
    <div
      key={ev.evaluationId}
      className="mt-4 p-5 rounded-[var(--radius-md)] border border-[var(--border-hairline)] bg-[var(--bg-canvas)] space-y-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-bold text-[var(--text-primary)]">
          Gemini Writing Assessment{ev.modelId ? ` (${ev.modelId})` : ''} · Band:{' '}
          <span className="text-[var(--accent-primary)]">
            {ev.overallBandEstimate.replace('_', ' ')}
          </span>
        </div>
        <div className="text-xs font-medium text-[var(--text-secondary)]">
          Topic adherence: {ev.topicAdherencePass ? 'Passed' : 'Needs attention'}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {ev.criteriaScores.map((c) => (
          <div
            key={c.criterionSkillId}
            className="p-3 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] bg-[var(--bg-elevated)] space-y-1"
          >
            <div className="flex items-center justify-between text-xs font-semibold">
              <span className="text-[var(--text-primary)]">
                {SKILL_NAME_MAP.get(c.criterionSkillId) || c.criterionSkillId}
              </span>
              <span className="tabular-nums text-[var(--accent-primary)]">{c.score}/5</span>
            </div>
            <p className="text-xs text-[var(--text-secondary)]">{c.comment}</p>
            {c.evidenceQuote && (
              <p className="text-xs italic text-[var(--text-muted)]">&ldquo;{c.evidenceQuote}&rdquo;</p>
            )}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
        <div>
          <div className="font-semibold text-[var(--status-success)] mb-1">Top Strengths</div>
          <ul className="list-disc pl-4 space-y-1 text-[var(--text-primary)]">
            {ev.topStrengths.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
        <div>
          <div className="font-semibold text-[var(--status-warn)] mb-1">Priority Fixes</div>
          <ul className="list-disc pl-4 space-y-1 text-[var(--text-primary)]">
            {ev.priorityFixes.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );

  const activeStatus = activeQuestion ? itemStatusMap.get(activeQuestion.questionId) : undefined;

  return (
    <div className="min-h-screen lg:h-screen lg:overflow-hidden flex flex-col bg-[var(--bg-canvas)]">
      {/* Top Score & Review Navigation Header */}
      <header className="sticky top-0 z-30 border-b border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-4 sm:px-6 py-3">
        <div className="max-w-[1440px] mx-auto flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div>
              <div className="text-sm font-bold text-[var(--text-primary)] tabular-nums">
                Review:{' '}
                {totalSlots > 0
                  ? `${correctSlots} / ${totalSlots} Correct (${accuracy}%)`
                  : 'Writing Task Submitted'}
              </div>
              <div className="text-xs text-[var(--text-muted)] tabular-nums">
                Time: {mins}m {String(secs).padStart(2, '0')}s · {questions.length} items
              </div>
            </div>

            {/* Filter Tabs */}
            <div className="flex items-center gap-1 p-1 bg-[var(--bg-surface)] rounded-[var(--radius-sm)] border border-[var(--border-hairline)]">
              {(
                [
                  ['all', `All (${counts.all})`],
                  ['incorrect', `Incorrect (${counts.incorrect})`],
                  ['unanswered', `Unanswered (${counts.unanswered})`],
                ] as [ReviewFilter, string][]
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => handleFilterChange(id)}
                  className={`px-3 py-1 rounded-[var(--radius-sm)] text-xs font-semibold cursor-pointer whitespace-nowrap transition-colors ${
                    filter === id
                      ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-xs'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onViewProgress}
              className="px-3.5 py-1.5 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] hover:bg-[var(--bg-surface)] text-xs font-semibold text-[var(--text-primary)] cursor-pointer"
            >
              View Progress
            </button>
            <button
              type="button"
              onClick={onDoneHome}
              className="px-4 py-1.5 rounded-[var(--radius-sm)] bg-[var(--accent-primary)] hover:bg-[var(--accent-primary-hover)] text-white text-xs font-semibold cursor-pointer"
            >
              Back to Home
            </button>
          </div>
        </div>

        {/* Item Selector Pills */}
        {filteredQuestions.length > 0 && (
          <div className="max-w-[1440px] mx-auto mt-2.5 flex items-center gap-1.5 overflow-x-auto pb-0.5">
            {filteredQuestions.map((q) => {
              const globalNum = questions.findIndex((item) => item.questionId === q.questionId) + 1;
              const st = itemStatusMap.get(q.questionId);
              const isSelected = activeQuestion?.questionId === q.questionId;
              return (
                <button
                  key={q.questionId}
                  type="button"
                  onClick={() => handleSelectQuestion(q.questionId)}
                  aria-label={`Review item ${globalNum}${
                    st?.hasUnanswered ? ' Unanswered' : st?.hasIncorrect ? ' Incorrect' : ' Correct'
                  }`}
                  className={`h-8 min-w-[2.25rem] px-2.5 rounded-[var(--radius-sm)] border text-xs font-bold tabular-nums shrink-0 cursor-pointer transition-colors ${
                    isSelected
                      ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)] text-white'
                      : st?.hasUnanswered
                        ? 'border-[var(--status-warn)] bg-[var(--status-warn-bg)] text-[var(--status-warn)]'
                        : st?.hasIncorrect
                          ? 'border-[var(--status-error)] bg-[var(--status-error-bg)] text-[var(--status-error)]'
                          : 'border-[var(--status-success)] bg-[var(--status-success-bg)] text-[var(--status-success)]'
                  }`}
                >
                  {globalNum}
                </button>
              );
            })}
          </div>
        )}
      </header>

      {/* Writing Review Section if applicable */}
      {writingReview.length > 0 && (
        <div className="border-b border-[var(--border-hairline)] bg-[var(--bg-surface)] px-4 sm:px-6 py-4">
          <div className="max-w-[1440px] mx-auto space-y-3">
            {writingReview.map((wr) => {
              const m: WritingDeterministicMetrics = wr.metrics;
              return (
                <section
                  key={wr.submissionId}
                  className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-elevated)] border border-[var(--border-hairline)] space-y-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 className="text-sm font-bold text-[var(--text-primary)]">
                        Writing Metrics &amp; Feedback
                      </h2>
                      <div className="text-xs text-[var(--text-secondary)] tabular-nums mt-0.5">
                        Words: {m.wordCount} · Sentences: {m.sentenceCount} · Paragraphs: {m.paragraphCount} ·
                        Avg words/sentence: {m.avgWordsPerSentence} · Lexical variety: {m.typeTokenRatio} ·
                        Opening line: {m.matchedMandatoryStarter ? 'Matched' : 'Not matched'}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={evaluatingId === wr.submissionId}
                      onClick={() => handleEvaluateWriting(wr.submissionId)}
                      className="px-3.5 py-1.5 rounded-[var(--radius-sm)] bg-[var(--text-primary)] hover:opacity-90 text-white text-xs font-semibold inline-flex items-center gap-2 disabled:opacity-60 cursor-pointer"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>
                        {evaluatingId === wr.submissionId
                          ? 'Evaluating with Gemini...'
                          : 'Get Gemini Writing Feedback'}
                      </span>
                    </button>
                  </div>
                  {evalError && (
                    <p role="alert" className="text-xs text-[var(--status-error)] bg-[var(--status-error-bg)] px-3 py-2 rounded-[var(--radius-sm)]">
                      {evalError}
                    </p>
                  )}
                  {wr.evaluations.map(renderEvaluationCard)}
                </section>
              );
            })}
          </div>
        </div>
      )}

      {/* Main Split Review Workspace */}
      {filteredQuestions.length === 0 ? (
        <main className="flex-1 flex items-center justify-center p-8">
          <div className="max-w-md text-center space-y-3 p-6 rounded-[var(--radius-lg)] bg-[var(--bg-elevated)] border border-[var(--border-hairline)]">
            <CheckCircle2 className="w-8 h-8 text-[var(--status-success)] mx-auto" />
            <h2 className="text-base font-bold text-[var(--text-primary)]">
              No {filter} items in this session
            </h2>
            <button
              type="button"
              onClick={() => handleFilterChange('all')}
              className="px-4 py-2 rounded-[var(--radius-sm)] bg-[var(--text-primary)] text-white text-xs font-semibold cursor-pointer"
            >
              Show All Items
            </button>
          </div>
        </main>
      ) : activeQuestion ? (
        <div className="flex-1 min-h-0 flex flex-col">
          {/* Item Flag & Status Strip */}
          <div className="border-b border-[var(--border-hairline)] bg-[var(--bg-surface)] px-4 sm:px-6 py-2">
            <div className="max-w-[1440px] mx-auto flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-bold text-[var(--text-primary)] tabular-nums">
                  Item {questions.findIndex((q) => q.questionId === activeQuestion.questionId) + 1} of{' '}
                  {questions.length}
                </span>
                {activeStatus && activeQuestion.formatType !== 'WRIT_TYPED_TASK' && (
                  <span
                    className={`inline-flex items-center gap-1 font-semibold ${
                      activeStatus.isCorrect
                        ? 'text-[var(--status-success)]'
                        : activeStatus.hasUnanswered
                          ? 'text-[var(--status-warn)]'
                          : 'text-[var(--status-error)]'
                    }`}
                  >
                    {activeStatus.isCorrect ? (
                      <>
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>All Correct</span>
                      </>
                    ) : activeStatus.hasUnanswered ? (
                      <>
                        <XCircle className="w-3.5 h-3.5" />
                        <span>Unanswered</span>
                      </>
                    ) : (
                      <>
                        <XCircle className="w-3.5 h-3.5" />
                        <span>Incorrect</span>
                      </>
                    )}
                  </span>
                )}
              </div>

              {flaggedIds.has(activeQuestion.questionId) ? (
                <span className="text-xs font-medium text-[var(--status-warn)]">
                  Flagged for QC review
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() =>
                    setFlaggingQid(
                      flaggingQid === activeQuestion.questionId ? null : activeQuestion.questionId
                    )
                  }
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
                >
                  <Flag className="w-3.5 h-3.5" />
                  <span>Flag issue</span>
                </button>
              )}
            </div>

            {flaggingQid === activeQuestion.questionId && (
              <div className="max-w-[1440px] mx-auto mt-2 p-3 rounded-[var(--radius-sm)] bg-[var(--bg-elevated)] border border-[var(--border-hairline)] flex flex-wrap gap-2">
                <select
                  aria-label="Flag reason"
                  value={flagReason}
                  onChange={(e) => setFlagReason(e.target.value)}
                  className="px-2.5 py-1.5 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] text-xs"
                >
                  <option>Unclear wording or diagram</option>
                  <option>Answer key seems incorrect</option>
                  <option>Formatting / display issue</option>
                </select>
                <input
                  type="text"
                  value={flagNotes}
                  onChange={(e) => setFlagNotes(e.target.value)}
                  placeholder="Optional note..."
                  className="flex-1 min-w-48 px-2.5 py-1.5 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] text-xs"
                />
                <button
                  type="button"
                  onClick={() => handleSubmitFlag(activeQuestion.questionId)}
                  className="px-3 py-1.5 rounded-[var(--radius-sm)] bg-[var(--accent-primary)] text-white text-xs font-semibold cursor-pointer"
                >
                  Submit Flag
                </button>
              </div>
            )}
          </div>

          <QuestionWorkspace
            mode="review"
            question={activeQuestion}
            answersByPartId={activeAnswersByPartId}
            reviewResults={reviewResults[activeQuestion.questionId] || []}
            activeEvidenceRef={activeEvidenceRef}
            onSelectEvidenceRef={setActiveEvidenceRef}
            footerNav={
              <div className="pt-4 border-t border-[var(--border-hairline)] flex items-center justify-between gap-3">
                <button
                  type="button"
                  disabled={activeIndex <= 0}
                  onClick={() => handleSelectQuestion(filteredQuestions[activeIndex - 1].questionId)}
                  className="px-4 py-2 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-elevated)] hover:bg-[var(--bg-surface)] text-sm font-medium text-[var(--text-primary)] inline-flex items-center gap-1.5 disabled:opacity-40 cursor-pointer"
                >
                  <ArrowLeft className="w-4 h-4" />
                  <span>Previous Item</span>
                </button>
                <button
                  type="button"
                  disabled={activeIndex >= filteredQuestions.length - 1}
                  onClick={() => handleSelectQuestion(filteredQuestions[activeIndex + 1].questionId)}
                  className="px-4 py-2 rounded-[var(--radius-sm)] bg-[var(--text-primary)] hover:opacity-90 text-white text-sm font-semibold inline-flex items-center gap-1.5 disabled:opacity-40 cursor-pointer"
                >
                  <span>Next Item</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            }
          />
        </div>
      ) : null}
    </div>
  );
}
