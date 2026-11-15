import { useState } from 'react';
import { CheckCircle2, Flag, Sparkles, XCircle } from 'lucide-react';
import { api, type SessionDetailResponse } from '../api';
import type {
  MarkingResult,
  StudentQuestionView,
  WritingDeterministicMetrics,
  WritingEvaluationRecord,
} from '../../shared/contracts';
import { SKILLS_TAXONOMY } from '../../shared/skills';

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

  const [flaggingQid, setFlaggingQid] = useState<string | null>(null);
  const [flagReason, setFlagReason] = useState('Unclear wording or diagram');
  const [flagNotes, setFlagNotes] = useState('');
  const [flaggedIds, setFlaggedIds] = useState<Set<string>>(new Set());

  const accuracy = totalSlots > 0 ? Math.round((correctSlots / totalSlots) * 100) : 0;
  const mins = Math.floor(elapsedSec / 60);
  const secs = elapsedSec % 60;

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
          Gemini Writing Assessment · Band: <span className="text-[var(--accent-primary)]">{ev.overallBandEstimate.replace('_', ' ')}</span>
        </div>
        <div className="text-xs font-medium text-[var(--text-secondary)]">
          Topic adherence: {ev.topicAdherencePass ? 'Passed' : 'Needs attention'}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {ev.criteriaScores.map((c) => (
          <div key={c.criterionSkillId} className="p-3 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] bg-[var(--bg-elevated)] space-y-1">
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

  return (
    <main className="max-w-5xl mx-auto px-6 py-10 space-y-8">
      {/* Score Header */}
      <section className="p-8 rounded-[var(--radius-lg)] bg-[var(--bg-elevated)] border border-[var(--border-hairline)] flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <div className="text-xs font-semibold text-[var(--text-secondary)] mb-1">Session Complete</div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">
            {totalSlots > 0 ? `${correctSlots} / ${totalSlots} Correct (${accuracy}%)` : 'Writing Task Submitted'}
          </h1>
          <div className="text-xs text-[var(--text-muted)] tabular-nums mt-1">
            Time elapsed: {mins}m {String(secs).padStart(2, '0')}s · {questions.length} question items
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={onViewProgress}
            className="px-4 py-2.5 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] hover:bg-[var(--bg-surface)] text-sm font-semibold text-[var(--text-primary)] cursor-pointer"
          >
            View Progress
          </button>
          <button
            type="button"
            onClick={onDoneHome}
            className="px-5 py-2.5 rounded-[var(--radius-sm)] bg-[var(--accent-primary)] hover:bg-[var(--accent-primary-hover)] text-white text-sm font-semibold cursor-pointer"
          >
            Back to Home
          </button>
        </div>
      </section>

      {/* Writing Review */}
      {writingReview.map((wr) => {
        const m: WritingDeterministicMetrics = wr.metrics;
        return (
          <section
            key={wr.submissionId}
            className="p-6 rounded-[var(--radius-lg)] bg-[var(--bg-elevated)] border border-[var(--border-hairline)] space-y-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-bold text-[var(--text-primary)]">Writing Metrics &amp; Feedback</h2>
                <div className="text-xs text-[var(--text-secondary)] tabular-nums mt-1">
                  Words: {m.wordCount} · Sentences: {m.sentenceCount} · Paragraphs: {m.paragraphCount} · Avg words/sentence: {m.avgWordsPerSentence} · Lexical variety: {m.typeTokenRatio} · Opening line: {m.matchedMandatoryStarter ? 'Matched' : 'Not matched'}
                </div>
              </div>
              <button
                type="button"
                disabled={evaluatingId === wr.submissionId}
                onClick={() => handleEvaluateWriting(wr.submissionId)}
                className="px-4 py-2 rounded-[var(--radius-sm)] bg-[var(--text-primary)] hover:opacity-90 text-white text-xs font-semibold inline-flex items-center gap-2 disabled:opacity-60 cursor-pointer"
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

      {/* Objective Question Explanations */}
      <section className="space-y-4">
        <h2 className="text-base font-bold text-[var(--text-primary)]">Worked Explanations</h2>
        {questions.map((q, qIdx) => {
          if (q.formatType === 'WRIT_TYPED_TASK') return null;
          const results = reviewResults[q.questionId] || [];
          const qCorrectCount = results.filter((r) => r.isCorrect).length;

          return (
            <article
              key={q.questionId}
              className="p-5 rounded-[var(--radius-md)] bg-[var(--bg-elevated)] border border-[var(--border-hairline)] space-y-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm font-bold text-[var(--text-primary)]">
                  Item {qIdx + 1} · {q.section} · {qCorrectCount}/{results.length} correct
                </div>
                {flaggedIds.has(q.questionId) ? (
                  <span className="text-xs font-medium text-[var(--status-warn)]">Flagged for QC review</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setFlaggingQid(flaggingQid === q.questionId ? null : q.questionId)}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
                  >
                    <Flag className="w-3.5 h-3.5" />
                    <span>Flag issue</span>
                  </button>
                )}
              </div>

              {flaggingQid === q.questionId && (
                <div className="p-3.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface)] border border-[var(--border-hairline)] space-y-2.5">
                  <div className="flex flex-wrap gap-2">
                    <select
                      aria-label="Flag reason"
                      value={flagReason}
                      onChange={(e) => setFlagReason(e.target.value)}
                      className="px-2.5 py-1.5 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-elevated)] text-xs"
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
                      className="flex-1 min-w-48 px-2.5 py-1.5 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-elevated)] text-xs"
                    />
                    <button
                      type="button"
                      onClick={() => handleSubmitFlag(q.questionId)}
                      className="px-3 py-1.5 rounded-[var(--radius-sm)] bg-[var(--accent-primary)] text-white text-xs font-semibold cursor-pointer"
                    >
                      Submit Flag
                    </button>
                  </div>
                </div>
              )}

              <div className="space-y-3">
                {q.parts.map((part, pIdx) => {
                  const res = results.find((r) => r.partId === part.partId);
                  if (!res) return null;
                  return (
                    <div
                      key={part.partId}
                      className="p-3.5 rounded-[var(--radius-sm)] bg-[var(--bg-canvas)] border border-[var(--border-hairline)] space-y-1.5"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="text-sm font-medium text-[var(--text-primary)]">
                          {q.parts.length > 1 ? `Part ${pIdx + 1}: ` : ''}
                          {part.promptText}
                        </div>
                        <span
                          className={`inline-flex items-center gap-1 text-xs font-semibold shrink-0 ${
                            res.isCorrect ? 'text-[var(--status-success)]' : 'text-[var(--status-error)]'
                          }`}
                        >
                          {res.isCorrect ? (
                            <>
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              <span>Correct ({res.correctAnswerKey})</span>
                            </>
                          ) : (
                            <>
                              <XCircle className="w-3.5 h-3.5" />
                              <span>
                                Picked {res.selectedAnswer ?? '—'} · Answer: {res.correctAnswerKey}
                              </span>
                            </>
                          )}
                        </span>
                      </div>
                      <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                        <strong className="text-[var(--text-primary)]">Explanation:</strong> {res.workedExplanation}
                      </p>
                      {res.distractorRationale && (
                        <p className="text-xs text-[var(--status-warn)]">
                          <strong>Why {res.selectedAnswer} is a distractor:</strong> {res.distractorRationale}
                        </p>
                      )}
                      <div className="text-[11px] text-[var(--text-muted)]">
                        Skill: {SKILL_NAME_MAP.get(part.skillId) || part.skillId}
                      </div>
                    </div>
                  );
                })}
              </div>
            </article>
          );
        })}
      </section>
    </main>
  );
}
