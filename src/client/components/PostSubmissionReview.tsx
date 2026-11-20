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
import {
  WRITING_BAND_DESCRIPTORS,
  WRITING_CRITERION_MAX_MARKS,
  type EvidenceCitationRef,
  type MarkingResult,
  type StudentQuestionView,
  type WritingBandLetter,
  type WritingDeterministicMetrics,
  type WritingEvaluationRecord,
} from '../../shared/contracts';
import { SKILLS_TAXONOMY } from '../../shared/skills';
import { QuestionWorkspace } from './QuestionWorkspace';

const SKILL_NAME_MAP = new Map(SKILLS_TAXONOMY.map((s) => [s.skillId, s.displayName]));

function legacyEstimateToBand(est: WritingEvaluationRecord['overallBandEstimate']): WritingBandLetter {
  if (est === 'top_band') return 'A';
  if (est === 'strong') return 'B';
  if (est === 'solid') return 'C';
  return 'D';
}

function scoreToBand(score: number): WritingBandLetter {
  const s = Math.round(score);
  if (s >= 5) return 'A';
  if (s === 4) return 'B';
  if (s === 3) return 'C';
  if (s === 2) return 'D';
  return 'E';
}

function bandBadgeClass(band: WritingBandLetter): string {
  if (band === 'A') return 'bg-[#E5F3EC] text-[#1D6346] border-[#1D6346]/30';
  if (band === 'B') return 'bg-[#E5F0EA] text-[#113C36] border-[#113C36]/25';
  if (band === 'C') return 'bg-[#F3EFE8] text-[#113C36] border-[#CFC6B9]';
  if (band === 'D') return 'bg-[#FDF0E2] text-[#A35116] border-[#A35116]/30';
  return 'bg-[#FDECEB] text-[#B42318] border-[#B42318]/30';
}

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

  const renderEvaluationCard = (ev: WritingEvaluationRecord) => {
    const totalMarks =
      ev.totalMarks ?? ev.criteriaScores.reduce((sum, c) => sum + Math.round(c.score), 0);
    const maxTotalMarks =
      ev.maxTotalMarks ?? ev.criteriaScores.length * WRITING_CRITERION_MAX_MARKS;
    const overallBand = ev.overallBand ?? legacyEstimateToBand(ev.overallBandEstimate);
    const bandDescriptor =
      ev.overallBandDescriptor ?? WRITING_BAND_DESCRIPTORS[overallBand].label;

    return (
      <div
        key={ev.evaluationId}
        className="mt-4 p-5 rounded-[14px] border border-[#E5DFD5] bg-[#FAF8F5] space-y-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div
              className={`w-14 h-14 rounded-[12px] border flex flex-col items-center justify-center shrink-0 ${bandBadgeClass(overallBand)}`}
            >
              <span className="text-[10px] font-sans-display font-semibold leading-none opacity-80">
                Band
              </span>
              <span className="font-serif-display font-extrabold text-[28px] leading-none mt-0.5">
                {overallBand}
              </span>
            </div>

            <div className="space-y-0.5">
              <div className="flex flex-wrap items-baseline gap-2.5">
                <span className="font-serif-display font-extrabold text-[22px] text-[#113C36] tabular-nums leading-none">
                  {totalMarks} / {maxTotalMarks} marks
                </span>
                <span className="font-sans-display font-semibold text-sm text-[#113C36]">
                  {bandDescriptor}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-[#4A5955]">
                <span>
                  Topic adherence: {ev.topicAdherencePass ? 'On topic' : 'Needs closer alignment'}
                </span>
                {ev.modelId && (
                  <span className="text-[#78756E]">Marked by {ev.modelId}</span>
                )}
              </div>
            </div>
          </div>

          {ev.bandCappedByTopicAdherence && (
            <span className="px-2.5 py-1 rounded-full bg-[#FDF0E2] border border-[#A35116]/30 text-xs font-sans-display font-semibold text-[#A35116]">
              Capped at Band C (off-topic)
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {ev.criteriaScores.map((c) => {
            const cBand = c.band ?? scoreToBand(c.score);
            const cMax = c.maxMarks ?? WRITING_CRITERION_MAX_MARKS;
            return (
              <div
                key={c.criterionSkillId}
                className="p-3.5 rounded-[12px] border border-[#E5DFD5] bg-white space-y-1.5"
              >
                <div className="flex items-center justify-between gap-2 text-xs font-sans-display font-semibold">
                  <span className="text-[#113C36]">
                    {SKILL_NAME_MAP.get(c.criterionSkillId) || c.criterionSkillId}
                  </span>
                  <span className="inline-flex items-center gap-1.5 shrink-0">
                    <span
                      className={`px-2 py-0.5 rounded-full text-[11px] font-semibold border ${bandBadgeClass(cBand)}`}
                    >
                      Band {cBand}
                    </span>
                    <span className="tabular-nums text-[#113C36] font-semibold">
                      {c.score}/{cMax}
                    </span>
                  </span>
                </div>
                <p className="text-xs text-[#4A5955] leading-relaxed">{c.comment}</p>
                {c.evidenceQuote && (
                  <p className="text-xs italic font-serif-text text-[#78756E]">
                    &ldquo;{c.evidenceQuote}&rdquo;
                  </p>
                )}
              </div>
            );
          })}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          <div className="p-3.5 rounded-[12px] bg-[#E5F3EC]/55 border border-[#1D6346]/15">
            <div className="font-sans-display font-semibold text-[#1D6346] mb-1.5">Top strengths</div>
            <ul className="list-disc pl-4 space-y-1 text-[#113C36] leading-relaxed">
              {ev.topStrengths.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
          <div className="p-3.5 rounded-[12px] bg-[#FDF0E2]/70 border border-[#A35116]/15">
            <div className="font-sans-display font-semibold text-[#A35116] mb-1.5">Priority improvements</div>
            <ul className="list-disc pl-4 space-y-1 text-[#113C36] leading-relaxed">
              {ev.priorityFixes.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    );
  };

  const activeStatus = activeQuestion ? itemStatusMap.get(activeQuestion.questionId) : undefined;

  return (
    <div className="min-h-screen lg:h-screen lg:overflow-hidden flex flex-col bg-[#FAF8F5] text-[#113C36]">
      {/* Quiet Review Top Rail */}
      <header className="sticky top-0 z-30 border-b border-[#E5DFD5] bg-[#F3EFE8] px-4 sm:px-6 py-3">
        <div className="max-w-[1440px] mx-auto flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-baseline gap-3">
              <div className="font-serif-display font-extrabold text-[22px] tracking-[-0.02em] text-[#113C36] tabular-nums leading-none">
                {totalSlots > 0 ? `${correctSlots} / ${totalSlots}` : 'Writing submitted'}
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

            {/* Filter Tabs */}
            <div className="flex items-center gap-1 p-1 bg-white/75 rounded-[10px] border border-[#E5DFD5]">
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
                  className={`px-3 py-1 rounded-[8px] text-xs font-sans-display font-semibold cursor-pointer whitespace-nowrap transition-colors ${
                    filter === id
                      ? 'bg-[#113C36] text-white'
                      : 'text-[#4A5955] hover:text-[#113C36]'
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
              className="px-3.5 py-1.5 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-xs font-sans-display font-semibold text-[#113C36] cursor-pointer transition-colors"
            >
              View progress
            </button>
            <button
              type="button"
              onClick={onDoneHome}
              className="px-4 py-1.5 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-xs font-sans-display font-semibold cursor-pointer transition-colors"
            >
              Back to studio
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
                  className={`h-8 min-w-[2.25rem] px-2.5 rounded-[8px] border text-xs font-sans-display font-semibold tabular-nums shrink-0 cursor-pointer transition-colors ${
                    isSelected
                      ? 'border-[#113C36] bg-[#113C36] text-white'
                      : st?.hasUnanswered
                        ? 'border-[#A35116]/40 bg-[#FDF0E2] text-[#A35116]'
                        : st?.hasIncorrect
                          ? 'border-[#B42318]/40 bg-[#FDECEB] text-[#B42318]'
                          : 'border-[#1D6346]/35 bg-[#E5F3EC] text-[#1D6346]'
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
        <div className="border-b border-[#E5DFD5] bg-[#FAF8F5] px-4 sm:px-6 py-4 overflow-y-auto max-h-[52vh]">
          <div className="max-w-[1440px] mx-auto space-y-3">
            {writingReview.map((wr) => {
              const m: WritingDeterministicMetrics = wr.metrics;
              return (
                <section
                  key={wr.submissionId}
                  className="p-5 rounded-[14px] bg-white border border-[#E5DFD5] space-y-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 className="font-sans-display font-semibold text-base text-[#113C36]">
                        Writing metrics and rubric feedback
                      </h2>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-[#4A5955] tabular-nums">
                        <span className="px-2.5 py-0.5 rounded-full bg-[#F3EFE8]">
                          {m.wordCount} words
                        </span>
                        <span className="px-2.5 py-0.5 rounded-full bg-[#F3EFE8]">
                          {m.sentenceCount} sentences
                        </span>
                        <span className="px-2.5 py-0.5 rounded-full bg-[#F3EFE8]">
                          {m.paragraphCount} paragraphs
                        </span>
                        <span className="px-2.5 py-0.5 rounded-full bg-[#F3EFE8]">
                          {m.avgWordsPerSentence} words/sentence
                        </span>
                        <span className="px-2.5 py-0.5 rounded-full bg-[#F3EFE8]">
                          Opening line: {m.matchedMandatoryStarter ? 'Matched' : 'Not matched'}
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={evaluatingId === wr.submissionId}
                      onClick={() => handleEvaluateWriting(wr.submissionId)}
                      className="px-4 py-2 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-xs font-sans-display font-semibold inline-flex items-center gap-2 disabled:opacity-60 cursor-pointer transition-colors"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>
                        {evaluatingId === wr.submissionId
                          ? 'Marking essay...'
                          : 'Get rubric writing feedback'}
                      </span>
                    </button>
                  </div>
                  {evalError && (
                    <p
                      role="alert"
                      className="text-xs text-[#B42318] bg-[#FDECEB] px-3.5 py-2 rounded-[10px]"
                    >
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
          <div className="max-w-md text-center space-y-3 p-6 rounded-[18px] bg-white border border-[#E5DFD5]">
            <CheckCircle2 className="w-8 h-8 text-[#1D6346] mx-auto" />
            <h2 className="font-sans-display font-semibold text-base text-[#113C36]">
              No {filter} items in this session
            </h2>
            <button
              type="button"
              onClick={() => handleFilterChange('all')}
              className="px-4 py-2 rounded-[10px] bg-[#113C36] text-white text-xs font-sans-display font-semibold cursor-pointer"
            >
              Show all items
            </button>
          </div>
        </main>
      ) : activeQuestion ? (
        <div className="flex-1 min-h-0 flex flex-col">
          {/* Item Flag & Status Strip */}
          <div className="border-b border-[#E5DFD5] bg-[#FAF8F5] px-4 sm:px-6 py-2">
            <div className="max-w-[1440px] mx-auto flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2.5">
                <span className="font-sans-display font-semibold text-[#113C36] tabular-nums">
                  Question {questions.findIndex((q) => q.questionId === activeQuestion.questionId) + 1} of{' '}
                  {questions.length}
                </span>
                {activeStatus && activeQuestion.formatType !== 'WRIT_TYPED_TASK' && (
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-semibold ${
                      activeStatus.isCorrect
                        ? 'bg-[#E5F3EC] text-[#1D6346]'
                        : activeStatus.hasUnanswered
                          ? 'bg-[#FDF0E2] text-[#A35116]'
                          : 'bg-[#FDECEB] text-[#B42318]'
                    }`}
                  >
                    {activeStatus.isCorrect ? (
                      <>
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>Correct</span>
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
                <span className="text-xs font-medium text-[#A35116]">
                  Flagged for review
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() =>
                    setFlaggingQid(
                      flaggingQid === activeQuestion.questionId ? null : activeQuestion.questionId
                    )
                  }
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-[#4A5955] hover:text-[#113C36] cursor-pointer"
                >
                  <Flag className="w-3.5 h-3.5" />
                  <span>Report an issue</span>
                </button>
              )}
            </div>

            {flaggingQid === activeQuestion.questionId && (
              <div className="max-w-[1440px] mx-auto mt-2 p-3 rounded-[10px] bg-white border border-[#E5DFD5] flex flex-wrap gap-2">
                <select
                  aria-label="Flag reason"
                  value={flagReason}
                  onChange={(e) => setFlagReason(e.target.value)}
                  className="px-2.5 py-1.5 rounded-[8px] border border-[#CFC6B9] bg-[#FAF8F5] text-xs"
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
                  className="flex-1 min-w-48 px-2.5 py-1.5 rounded-[8px] border border-[#CFC6B9] bg-[#FAF8F5] text-xs"
                />
                <button
                  type="button"
                  onClick={() => handleSubmitFlag(activeQuestion.questionId)}
                  className="px-3.5 py-1.5 rounded-[8px] bg-[#113C36] text-white text-xs font-sans-display font-semibold cursor-pointer"
                >
                  Submit report
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
              <div className="pt-4 border-t border-[#E5DFD5] flex items-center justify-between gap-3">
                <button
                  type="button"
                  disabled={activeIndex <= 0}
                  onClick={() => handleSelectQuestion(filteredQuestions[activeIndex - 1].questionId)}
                  className="px-4 py-2 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#F3EFE8] text-sm font-sans-display font-medium text-[#113C36] inline-flex items-center gap-1.5 disabled:opacity-40 cursor-pointer"
                >
                  <ArrowLeft className="w-4 h-4" />
                  <span>Previous item</span>
                </button>
                <button
                  type="button"
                  disabled={activeIndex >= filteredQuestions.length - 1}
                  onClick={() => handleSelectQuestion(filteredQuestions[activeIndex + 1].questionId)}
                  className="px-4 py-2 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-sm font-sans-display font-semibold inline-flex items-center gap-1.5 disabled:opacity-40 cursor-pointer"
                >
                  <span>Next item</span>
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
