import { useEffect, useMemo, useRef, useState } from 'react';
import { LanguageToggle, useI18n } from '../i18n';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  Flag,
  Loader2,
  Sparkles,
  Star,
  X,
  XCircle,
} from 'lucide-react';
import { api, type SessionDetailResponse } from '../api';
import {
  getWritingCriterionMaxMarks,
  WRITING_BAND_DESCRIPTORS,
  WRITING_MAX_TOTAL_MARKS,
  type EvidenceCitationRef,
  type MarkingResult,
  type StudentQuestionView,
  type WritingBandLetter,
  type WritingEvaluationRecord,
  type WritingExemplarAnnotation,
  type WritingTextAnnotation,
} from '../../shared/contracts';
import { buildAnnotatedParagraphs } from '../writingHighlight';
import { QuestionWorkspace } from './QuestionWorkspace';
import { WritingStimulusPane } from './WritingEditor';

function legacyEstimateToBand(est: WritingEvaluationRecord['overallBandEstimate']): WritingBandLetter {
  if (est === 'top_band') return 'A';
  if (est === 'strong') return 'B';
  if (est === 'solid') return 'C';
  return 'D';
}

function scoreToBand(score: number, maxMarks = 3): WritingBandLetter {
  const s = Math.round(score);
  if (maxMarks <= 0 || s <= 0) return 'E';
  const ratio = s / maxMarks;
  if (ratio >= 0.9) return 'A';
  if (ratio >= 0.65) return 'B';
  if (ratio >= 0.45) return 'C';
  if (ratio >= 0.25) return 'D';
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
type WritingViewMode = 'critique' | 'exemplar' | 'prompt';
type AnnotationFilter = 'all' | 'strength' | 'fix';

type WritingReviewEntry = NonNullable<SessionDetailResponse['writingReview']>[number];

const PENDING_EVAL_TTL_MS = 90_000;

interface PendingEvalMarker {
  prevEvalCount: number;
  startedAt: number;
}

function pendingEvalStorageKey(submissionId: string): string {
  return `sl_writing_eval_pending:${submissionId}`;
}

function readPendingEval(submissionId: string): PendingEvalMarker | null {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return null;
    const raw = window.sessionStorage.getItem(pendingEvalStorageKey(submissionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingEvalMarker>;
    if (
      typeof parsed.prevEvalCount !== 'number' ||
      typeof parsed.startedAt !== 'number' ||
      Date.now() - parsed.startedAt > PENDING_EVAL_TTL_MS
    ) {
      window.sessionStorage.removeItem(pendingEvalStorageKey(submissionId));
      return null;
    }
    return { prevEvalCount: parsed.prevEvalCount, startedAt: parsed.startedAt };
  } catch {
    return null;
  }
}

function writePendingEval(submissionId: string, prevEvalCount: number): void {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return;
    window.sessionStorage.setItem(
      pendingEvalStorageKey(submissionId),
      JSON.stringify({ prevEvalCount, startedAt: Date.now() })
    );
  } catch {
    // ignore storage quota errors
  }
}

function clearPendingEval(submissionId: string): void {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return;
    window.sessionStorage.removeItem(pendingEvalStorageKey(submissionId));
  } catch {
    // ignore
  }
}

function scrollAttrIntoView(attrName: string, id: string): void {
  if (typeof window === 'undefined') return;
  window.requestAnimationFrame(() => {
    const el = document.querySelector(`[${attrName}="${CSS.escape(id)}"]`);
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });
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
  const { t, isZh, skillName } = useI18n();
  const [writingReview, setWritingReview] = useState(initialWritingReview || []);
  const [evaluatingId, setEvaluatingId] = useState<string | null>(null);
  const [evalError, setEvalError] = useState('');

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

  const [flaggingQid, setFlaggingQid] = useState<string | null>(null);
  const [flagReason, setFlagReason] = useState('Unclear wording or diagram');
  const [flagNotes, setFlagNotes] = useState('');
  const [flaggedIds, setFlaggedIds] = useState<Set<string>>(new Set());

  const resumedIdsRef = useRef<Set<string>>(new Set());
  const writingReviewRef = useRef(writingReview);
  writingReviewRef.current = writingReview;

  useEffect(() => {
    if (initialWritingReview) {
      setWritingReview(initialWritingReview);
    }
  }, [initialWritingReview]);

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
    const currentWr = writingReviewRef.current.find((w) => w.submissionId === submissionId);
    const prevEvalCount = currentWr?.evaluations.length ?? 0;
    writePendingEval(submissionId, prevEvalCount);
    setEvaluatingId(submissionId);
    setEvalError('');
    try {
      const res = await api.evaluateWriting(submissionId);
      clearPendingEval(submissionId);
      setWritingReview((prev) =>
        prev.map((w) =>
          w.submissionId === submissionId
            ? {
                ...w,
                evaluatingInProgress: false,
                evaluations: res.evaluations?.length
                  ? res.evaluations
                  : [res.evaluation, ...w.evaluations],
              }
            : w
        )
      );
      setSelectedAnnotationId(null);
      setSelectedExemplarAnnId(null);
    } catch (err) {
      clearPendingEval(submissionId);
      setEvalError(
        err instanceof Error ? err.message : isZh ? '无法完成写作批改。' : 'Unable to evaluate writing.'
      );
    } finally {
      setEvaluatingId((curr) => (curr === submissionId ? null : curr));
    }
  };

  // Reload-resilient evaluation recovery: poll in-flight server run or resume if aborted
  useEffect(() => {
    const activeTarget = writingReview.find((wr) => {
      const pending = readPendingEval(wr.submissionId);
      if (pending && wr.evaluations.length > pending.prevEvalCount) {
        clearPendingEval(wr.submissionId);
        return false;
      }
      return Boolean(wr.evaluatingInProgress || pending);
    });
    if (!activeTarget) return;
    if (evaluatingId === activeTarget.submissionId) return;

    const targetId = activeTarget.submissionId;
    const pending = readPendingEval(targetId);
    const prevEvalCount = pending?.prevEvalCount ?? activeTarget.evaluations.length;
    let cancelled = false;
    let pollCount = 0;
    let timerId: number | undefined;

    setEvaluatingId(targetId);

    const pollSession = async () => {
      if (cancelled) return;
      pollCount++;
      try {
        const refreshed = await api.getSession(sessionId);
        if (cancelled) return;
        const wr2 = refreshed.writingReview?.find((w) => w.submissionId === targetId);
        if (wr2 && wr2.evaluations.length > prevEvalCount) {
          clearPendingEval(targetId);
          setWritingReview(refreshed.writingReview || []);
          setEvaluatingId(null);
          return;
        }
        if (!wr2?.evaluatingInProgress && pollCount >= 2) {
          if (resumedIdsRef.current.has(targetId)) {
            clearPendingEval(targetId);
            setEvaluatingId(null);
            return;
          }
          resumedIdsRef.current.add(targetId);
          void handleEvaluateWriting(targetId);
          return;
        }
      } catch {
        // retry on transient poll error
      }
      if (!cancelled && pollCount < 20) {
        timerId = window.setTimeout(() => {
          void pollSession();
        }, 2500);
      } else if (!cancelled) {
        clearPendingEval(targetId);
        setEvaluatingId(null);
      }
    };

    timerId = window.setTimeout(() => {
      void pollSession();
    }, 1500);

    return () => {
      cancelled = true;
      if (timerId !== undefined) window.clearTimeout(timerId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, writingReview]);

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

  const isWritingOnly =
    questions.length > 0 && questions.every((q) => q.formatType === 'WRIT_TYPED_TASK');

  const getEffectiveAnnotations = (ev: WritingEvaluationRecord | undefined): {
    items: WritingTextAnnotation[];
    isLegacy: boolean;
  } => {
    if (!ev) return { items: [], isLegacy: false };
    if (ev.annotations && ev.annotations.length > 0) {
      return { items: ev.annotations, isLegacy: false };
    }
    const legacy: WritingTextAnnotation[] = [];
    for (const c of ev.criteriaScores) {
      if (!c.evidenceQuote || !c.evidenceQuote.trim()) continue;
      const maxM = c.maxMarks ?? getWritingCriterionMaxMarks(c.criterionSkillId);
      legacy.push({
        id: `legacy_${c.criterionSkillId}`,
        kind: maxM > 0 && c.score / maxM >= 0.75 ? 'strength' : 'issue',
        quote: c.evidenceQuote.trim(),
        tag: skillName(c.criterionSkillId),
        comment: c.comment,
        criterionSkillId: c.criterionSkillId,
      });
    }
    return { items: legacy, isLegacy: true };
  };

  const shortCriterionLabel = (skillId: string): string => {
    if (skillId === 'WRIT.CRIT.TOPIC_PROMPT_ADHERENCE') return t('rev.critShortPrompt');
    if (skillId === 'WRIT.CRIT.IDEAS_CREATIVITY') return t('rev.critShortIdeas');
    if (skillId === 'WRIT.CRIT.PURPOSE_AUDIENCE_VOICE') return t('rev.critShortVoice');
    if (skillId === 'WRIT.CRIT.STRUCTURE_LAYOUT') return t('rev.critShortStructure');
    if (skillId === 'WRIT.CRIT.STYLE_VOCABULARY') return t('rev.critShortStyle');
    if (skillId === 'WRIT.CRIT.GRAMMAR_SPELLING_PUNCT') return t('rev.critShortMechanics');
    return skillName(skillId);
  };

  const renderAnnotationBadgeIcon = (kind: WritingTextAnnotation['kind']) => {
    if (kind === 'strength') return <Check className="w-3 h-3 shrink-0" />;
    if (kind === 'issue') return <X className="w-3 h-3 shrink-0" />;
    return <ArrowUpRight className="w-3 h-3 shrink-0" />;
  };

  const renderAnnotatedEssayPane = (
    wr: WritingReviewEntry | null,
    annotations: WritingTextAnnotation[]
  ) => {
    const responseText = wr?.responseText ?? '';
    const planNotes = wr?.planNotes ?? '';
    const m = wr?.metrics;

    const strengthCount = annotations.filter((a) => a.kind === 'strength').length;
    const fixCount = annotations.filter((a) => a.kind !== 'strength').length;
    const visibleAnnotations = annotations.filter((a) => {
      if (annotationFilter === 'strength') return a.kind === 'strength';
      if (annotationFilter === 'fix') return a.kind !== 'strength';
      return true;
    });
    const annById = new Map(visibleAnnotations.map((a) => [a.id, a]));
    const { paragraphs } = buildAnnotatedParagraphs(responseText, visibleAnnotations);

    const handleSelectFromEssay = (id: string) => {
      setSelectedAnnotationId(id);
      scrollAttrIntoView('data-card-id', id);
    };

    return (
      <div className="space-y-4 max-w-[68ch]">
        <div className="pb-3 border-b border-[#E5DFD5] flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-sans-display font-semibold text-base text-[#113C36]">
              {t('rev.yourEssayTitle')}
            </h2>
            {m && (
              <span className="px-2.5 py-0.5 rounded-full bg-[#F3EFE8] text-xs text-[#4A5955] tabular-nums">
                {t('rev.wordsCount', { count: m.wordCount })} · {t('rev.paragraphsCount', { count: m.paragraphCount })}
              </span>
            )}
          </div>

          {annotations.length > 0 && (
            <label className="inline-flex items-center gap-1.5 text-xs text-[#4A5955] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showInlineMarkers}
                onChange={(e) => setShowInlineMarkers(e.target.checked)}
                className="accent-[#113C36]"
              />
              <span>{t('rev.inlineMarkersToggle')}</span>
            </label>
          )}
        </div>

        {annotations.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                ['all', t('rev.filterAllMarkers', { count: annotations.length })],
                ['strength', t('rev.filterStrengths', { count: strengthCount })],
                ['fix', t('rev.filterFixes', { count: fixCount })],
              ] as [AnnotationFilter, string][]
            ).map(([fid, label]) => (
              <button
                key={fid}
                type="button"
                onClick={() => setAnnotationFilter(fid)}
                className={`px-2.5 py-1 rounded-full border text-[11px] font-sans-display font-semibold cursor-pointer transition-colors ${
                  annotationFilter === fid
                    ? 'bg-[#113C36] border-[#113C36] text-white'
                    : 'bg-[#FAF8F5] border-[#E5DFD5] text-[#4A5955] hover:border-[#CFC6B9]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {planNotes.trim().length > 0 && (
          <details className="rounded-[12px] border border-[#E5DFD5] bg-[#FAF8F5] px-4 py-2.5">
            <summary className="text-xs font-sans-display font-semibold text-[#4A5955] cursor-pointer select-none">
              {t('rev.planNotesTitle')}
            </summary>
            <p className="mt-2 text-xs text-[#4A5955] whitespace-pre-wrap leading-relaxed">
              {planNotes}
            </p>
          </details>
        )}

        {paragraphs.length > 0 ? (
          <div className="space-y-4 font-serif-text text-[17px] leading-[1.85] text-[#113C36]">
            {paragraphs.map((para) => (
              <p key={para.paragraphIndex} className="whitespace-pre-line">
                {para.segments.map((seg, sIdx) => {
                  if (!seg.annotationId) {
                    return <span key={sIdx}>{seg.text}</span>;
                  }
                  const ann = annById.get(seg.annotationId);
                  if (!ann) {
                    return <span key={sIdx}>{seg.text}</span>;
                  }
                  const isSelected = selectedAnnotationId === ann.id;
                  const markStyle =
                    ann.kind === 'strength'
                      ? 'bg-[#E5F3EC] border-b-2 border-[#1D6346]'
                      : ann.kind === 'issue'
                        ? 'bg-[#FDECEB] border-b-2 border-[#B42318]'
                        : 'bg-[#FDF0E2] border-b-2 border-[#A35116]';
                  const chipStyle =
                    ann.kind === 'strength'
                      ? 'bg-[#1D6346] text-white'
                      : ann.kind === 'issue'
                        ? 'bg-[#B42318] text-white'
                        : 'bg-[#A35116] text-white';
                  return (
                    <span
                      key={sIdx}
                      data-annotation-id={ann.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => handleSelectFromEssay(ann.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleSelectFromEssay(ann.id);
                        }
                      }}
                      className={`rounded-[4px] px-0.5 cursor-pointer transition-all ${markStyle} ${
                        isSelected ? 'ring-2 ring-[#113C36] ring-offset-1' : 'hover:brightness-95'
                      }`}
                    >
                      <span>{seg.text}</span>
                      {showInlineMarkers && (
                        <span
                          className={`inline-flex items-center gap-0.5 ml-1 mr-0.5 px-1.5 py-[1px] rounded-full font-sans-display font-semibold text-[10px] leading-[1.4] align-middle select-none ${chipStyle}`}
                        >
                          {renderAnnotationBadgeIcon(ann.kind)}
                          <span>{ann.tag}</span>
                        </span>
                      )}
                    </span>
                  );
                })}
              </p>
            ))}
          </div>
        ) : (
          <p className="text-sm text-[#78756E] italic">{t('rev.emptyEssay')}</p>
        )}
      </div>
    );
  };

  const renderMarkingInProgressCard = () => (
    <div className="p-6 rounded-[14px] bg-white border border-[#C5DDD1] flex items-start gap-3.5">
      <Loader2 className="w-5 h-5 text-[#113C36] animate-spin shrink-0 mt-0.5" />
      <div className="space-y-1">
        <h3 className="font-sans-display font-semibold text-sm text-[#113C36]">
          {t('rev.markingInProgressTitle')}
        </h3>
        <p className="text-xs text-[#4A5955] leading-relaxed">
          {t('rev.markingInProgressDesc')}
        </p>
      </div>
    </div>
  );

  const renderCritiquePanel = (
    wr: WritingReviewEntry | null,
    q: StudentQuestionView,
    latestEval: WritingEvaluationRecord | undefined,
    annotations: WritingTextAnnotation[],
    isLegacyAnnotations: boolean
  ) => {
    const m = wr?.metrics;
    const hasMandatoryStarter = Boolean(q.writingSpec?.mandatoryOpeningLine);
    const isBusy = Boolean(wr && evaluatingId === wr.submissionId);
    const overallBand = latestEval
      ? latestEval.overallBand ?? legacyEstimateToBand(latestEval.overallBandEstimate)
      : null;
    const totalMarks = latestEval
      ? latestEval.totalMarks ??
        latestEval.criteriaScores.reduce((sum, c) => sum + Math.round(c.score), 0)
      : null;
    const maxTotalMarks = latestEval
      ? latestEval.maxTotalMarks ?? WRITING_MAX_TOTAL_MARKS
      : null;
    const verdictText = latestEval
      ? latestEval.overallVerdict?.trim() || latestEval.priorityFixes[0]?.trim() || ''
      : '';

    const visibleAnnotations = annotations.filter((a) => {
      if (annotationFilter === 'strength') return a.kind === 'strength';
      if (annotationFilter === 'fix') return a.kind !== 'strength';
      return true;
    });

    const handleSelectFromCard = (id: string) => {
      setSelectedAnnotationId(id);
      scrollAttrIntoView('data-annotation-id', id);
    };

    return (
      <div className="space-y-3">
        {/* Compact One-Page Score, Verdict, Criterion Chips & Metadata Card */}
        <section className="p-3.5 sm:p-4 rounded-[14px] bg-white border border-[#E5DFD5] space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            {latestEval && overallBand ? (
              <div className="flex items-center gap-3 min-w-0">
                <div
                  className={`w-11 h-11 rounded-[10px] border flex flex-col items-center justify-center shrink-0 ${bandBadgeClass(overallBand)}`}
                >
                  <span className="text-[9px] font-sans-display font-semibold leading-none opacity-80">
                    {t('rev.bandLabel')}
                  </span>
                  <span className="font-serif-display font-extrabold text-[22px] leading-none mt-0.5">
                    {overallBand}
                  </span>
                </div>
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-serif-display font-extrabold text-[19px] text-[#113C36] tabular-nums leading-none">
                      {t('rev.marksOfMax', {
                        marks: totalMarks ?? 0,
                        max: maxTotalMarks ?? WRITING_MAX_TOTAL_MARKS,
                      })}
                    </span>
                    <span className="text-xs font-sans-display font-semibold text-[#113C36]">
                      {latestEval.overallBandDescriptor ??
                        WRITING_BAND_DESCRIPTORS[overallBand].label}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-[#4A5955]">
                    <span>
                      {latestEval.topicAdherencePass
                        ? t('rev.topicOnTopic')
                        : t('rev.topicOffTopic')}
                    </span>
                    {latestEval.bandCappedByTopicAdherence && (
                      <span className="px-2 py-0.5 rounded-full bg-[#FDF0E2] border border-[#A35116]/30 font-semibold text-[#A35116]">
                        {t('rev.cappedAtC')}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div>
                <h2 className="font-sans-display font-semibold text-base text-[#113C36]">
                  {t('rev.writingMetricsTitle')}
                </h2>
              </div>
            )}

            {wr && (
              <button
                type="button"
                disabled={isBusy}
                onClick={() => handleEvaluateWriting(wr.submissionId)}
                className={`px-3 py-1.5 rounded-[10px] text-xs font-sans-display font-semibold inline-flex items-center gap-1.5 disabled:opacity-60 cursor-pointer transition-colors whitespace-nowrap ${
                  latestEval
                    ? 'border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-[#113C36]'
                    : 'bg-[#113C36] hover:bg-[#0B2B26] text-white'
                }`}
              >
                <Sparkles className="w-3.5 h-3.5 shrink-0" />
                <span>
                  {isBusy
                    ? t('rev.markingEssay')
                    : latestEval
                      ? t('rev.remarkEssay')
                      : t('rev.getRubricFeedback')}
                </span>
              </button>
            )}
          </div>

          {latestEval && verdictText && (
            <p className="text-xs text-[#113C36] leading-snug font-medium">{verdictText}</p>
          )}

          {latestEval && latestEval.criteriaScores.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {latestEval.criteriaScores.map((c) => {
                const cMax = c.maxMarks ?? getWritingCriterionMaxMarks(c.criterionSkillId);
                const cBand = c.band ?? scoreToBand(c.score, cMax);
                return (
                  <span
                    key={c.criterionSkillId}
                    title={`${skillName(c.criterionSkillId)}: ${c.comment}`}
                    className={`px-2 py-0.5 rounded-full border text-[11px] font-sans-display font-semibold tabular-nums ${bandBadgeClass(cBand)}`}
                  >
                    {shortCriterionLabel(c.criterionSkillId)} {c.score}/{cMax}
                  </span>
                );
              })}
            </div>
          )}

          {(m || latestEval?.modelId) && (
            <div className="text-[11px] text-[#78756E] tabular-nums flex flex-wrap items-center gap-x-2 gap-y-0.5">
              {m && (
                <>
                  <span>{t('rev.wordsCount', { count: m.wordCount })}</span>
                  <span>·</span>
                  <span>{t('rev.sentencesCount', { count: m.sentenceCount })}</span>
                  <span>·</span>
                  <span>{t('rev.paragraphsCount', { count: m.paragraphCount })}</span>
                  <span>·</span>
                  <span>{t('rev.avgWordsPerSentence', { count: m.avgWordsPerSentence })}</span>
                  {hasMandatoryStarter && (
                    <>
                      <span>·</span>
                      <span>
                        {m.matchedMandatoryStarter
                          ? t('rev.openingMatchedLabel')
                          : t('rev.openingNotMatchedLabel')}
                      </span>
                    </>
                  )}
                </>
              )}
              {latestEval?.modelId && (
                <>
                  {m && <span>·</span>}
                  <span>{t('rev.markedBy', { model: latestEval.modelId })}</span>
                </>
              )}
            </div>
          )}
        </section>

        {evalError && (
          <p
            role="alert"
            className="text-xs text-[#B42318] bg-[#FDECEB] px-3.5 py-2.5 rounded-[10px] border border-[#B42318]/25"
          >
            {evalError}
          </p>
        )}

        {isBusy && renderMarkingInProgressCard()}

        {!latestEval && !isBusy && (
          <div className="p-7 rounded-[14px] bg-white border border-[#E5DFD5] text-center space-y-3">
            <h3 className="font-sans-display font-semibold text-base text-[#113C36]">
              {t('rev.readyToMarkTitle')}
            </h3>
            <p className="text-xs text-[#4A5955] max-w-md mx-auto leading-relaxed">
              {t('rev.readyToMarkDesc')}
            </p>
            {wr && (
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => handleEvaluateWriting(wr.submissionId)}
                  className="px-5 py-2.5 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-xs font-sans-display font-semibold inline-flex items-center gap-2 cursor-pointer transition-colors"
                >
                  <Sparkles className="w-3.5 h-3.5 shrink-0" />
                  <span>{t('rev.getRubricFeedback')}</span>
                </button>
              </div>
            )}
          </div>
        )}

        {latestEval && (
          <div className="space-y-2.5">
            {isLegacyAnnotations && (
              <div className="px-3.5 py-2 rounded-[10px] bg-[#FDF0E2]/70 border border-[#A35116]/25 text-xs text-[#A35116]">
                {t('rev.legacyUpgradeHint')}
              </div>
            )}

            {annotations.length > 0 && (
              <p className="text-[11px] text-[#78756E] px-0.5">
                {t('rev.clickHighlightHint')}
              </p>
            )}

            {visibleAnnotations.length === 0 ? (
              <div className="p-3.5 rounded-[12px] bg-white border border-[#E5DFD5] text-xs text-[#78756E]">
                {t('rev.noAnnotationsInFilter')}
              </div>
            ) : (
              <div className="space-y-2">
                {visibleAnnotations.map((ann) => {
                  const isSelected = selectedAnnotationId === ann.id;
                  const badgeStyle =
                    ann.kind === 'strength'
                      ? 'bg-[#E5F3EC] text-[#1D6346] border-[#1D6346]/25'
                      : ann.kind === 'issue'
                        ? 'bg-[#FDECEB] text-[#B42318] border-[#B42318]/25'
                        : 'bg-[#FDF0E2] text-[#A35116] border-[#A35116]/25';
                  const quoteBorder =
                    ann.kind === 'strength'
                      ? 'border-[#1D6346]'
                      : ann.kind === 'issue'
                        ? 'border-[#B42318]'
                        : 'border-[#A35116]';
                  return (
                    <div
                      key={ann.id}
                      data-card-id={ann.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => handleSelectFromCard(ann.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleSelectFromCard(ann.id);
                        }
                      }}
                      className={`p-3 rounded-[12px] bg-white border space-y-1.5 cursor-pointer transition-all ${
                        isSelected
                          ? 'border-[#113C36] ring-2 ring-[#113C36]/20'
                          : 'border-[#E5DFD5] hover:border-[#CFC6B9]'
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-sans-display font-semibold ${badgeStyle}`}
                        >
                          {renderAnnotationBadgeIcon(ann.kind)}
                          <span>{ann.tag}</span>
                        </span>
                        {ann.criterionSkillId && (
                          <span className="text-[11px] text-[#78756E]">
                            {shortCriterionLabel(ann.criterionSkillId)}
                          </span>
                        )}
                      </div>

                      <blockquote
                        className={`text-[11.5px] font-serif-text italic text-[#4A5955] border-l-2 pl-2.5 ${quoteBorder}`}
                      >
                        &ldquo;{ann.quote}&rdquo;
                      </blockquote>

                      <p className="text-xs text-[#113C36] leading-snug">{ann.comment}</p>

                      {ann.rewrite && (
                        <div className="px-2.5 py-1.5 rounded-[8px] bg-[#FAF8F5] border border-[#E5DFD5] text-xs">
                          <span className="font-sans-display font-semibold text-[#1D6346] text-[10.5px] mr-1.5">
                            {t('rev.tryInstead')}:
                          </span>
                          <span className="font-serif-text text-[12.5px] text-[#113C36] leading-snug">
                            {ann.rewrite}
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderExemplarView = (
    wr: WritingReviewEntry | null,
    latestEval: WritingEvaluationRecord | undefined
  ) => {
    const isBusy = Boolean(wr && evaluatingId === wr.submissionId);
    const exemplar = latestEval?.exemplar;

    if (isBusy && !exemplar) {
      return (
        <main className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 py-8 bg-[#FAF8F5]">
          <div className="max-w-2xl mx-auto">{renderMarkingInProgressCard()}</div>
        </main>
      );
    }

    if (!exemplar) {
      return (
        <main className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 py-8 bg-[#FAF8F5]">
          <div className="max-w-xl mx-auto p-8 rounded-[16px] bg-white border border-[#E5DFD5] text-center space-y-3">
            <h2 className="font-sans-display font-semibold text-base text-[#113C36]">
              {t('rev.exemplarEmptyTitle')}
            </h2>
            <p className="text-xs text-[#4A5955] leading-relaxed">
              {t('rev.exemplarEmptyDesc')}
            </p>
            {wr && (
              <div className="pt-1">
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => handleEvaluateWriting(wr.submissionId)}
                  className="px-5 py-2.5 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-xs font-sans-display font-semibold inline-flex items-center gap-2 disabled:opacity-60 cursor-pointer transition-colors"
                >
                  <Sparkles className="w-3.5 h-3.5 shrink-0" />
                  <span>
                    {latestEval ? t('rev.exemplarRemarkBtn') : t('rev.getRubricFeedback')}
                  </span>
                </button>
              </div>
            )}
          </div>
        </main>
      );
    }

    const exWords = exemplar.text.trim().split(/\s+/).filter(Boolean).length;
    const annById = new Map<string, WritingExemplarAnnotation>(
      exemplar.annotations.map((a) => [a.id, a])
    );
    const { paragraphs } = buildAnnotatedParagraphs(exemplar.text, exemplar.annotations);

    const handleSelectExemplar = (id: string, targetSide: 'essay' | 'card') => {
      setSelectedExemplarAnnId(id);
      scrollAttrIntoView(
        targetSide === 'essay' ? 'data-exemplar-span' : 'data-exemplar-card',
        id
      );
    };

    return (
      <main className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12">
        <section className="lg:col-span-6 bg-white border-b lg:border-b-0 lg:border-r border-[#E5DFD5] p-5 lg:p-6 lg:h-full lg:overflow-y-auto">
          <div className="space-y-4 max-w-[68ch]">
            <div className="pb-3 border-b border-[#E5DFD5] flex flex-wrap items-center justify-between gap-2">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="px-2.5 py-0.5 rounded-full bg-[#E5F3EC] border border-[#1D6346]/30 text-[11px] font-sans-display font-semibold text-[#1D6346]">
                    {t('rev.exemplarBadge')}
                  </span>
                  <span className="text-xs text-[#4A5955] tabular-nums">
                    {t('rev.wordsCount', { count: exWords })}
                  </span>
                </div>
                {exemplar.title && (
                  <h2 className="font-serif-display font-bold text-[20px] text-[#113C36]">
                    {exemplar.title}
                  </h2>
                )}
              </div>

              {exemplar.annotations.length > 0 && (
                <label className="inline-flex items-center gap-1.5 text-xs text-[#4A5955] cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={showInlineMarkers}
                    onChange={(e) => setShowInlineMarkers(e.target.checked)}
                    className="accent-[#113C36]"
                  />
                  <span>{t('rev.inlineMarkersToggle')}</span>
                </label>
              )}
            </div>

            <div className="space-y-4 font-serif-text text-[17px] leading-[1.85] text-[#113C36]">
              {paragraphs.map((para) => (
                <p key={para.paragraphIndex} className="whitespace-pre-line">
                  {para.segments.map((seg, sIdx) => {
                    if (!seg.annotationId) return <span key={sIdx}>{seg.text}</span>;
                    const ann = annById.get(seg.annotationId);
                    if (!ann) return <span key={sIdx}>{seg.text}</span>;
                    const isSelected = selectedExemplarAnnId === ann.id;
                    return (
                      <span
                        key={sIdx}
                        data-exemplar-span={ann.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => handleSelectExemplar(ann.id, 'card')}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            handleSelectExemplar(ann.id, 'card');
                          }
                        }}
                        className={`rounded-[4px] px-0.5 bg-[#E5F0EA] border-b-2 border-[#113C36] cursor-pointer transition-all ${
                          isSelected ? 'ring-2 ring-[#113C36] ring-offset-1' : 'hover:brightness-95'
                        }`}
                      >
                        <span>{seg.text}</span>
                        {showInlineMarkers && (
                          <span className="inline-flex items-center gap-0.5 ml-1 mr-0.5 px-1.5 py-[1px] rounded-full bg-[#113C36] text-white font-sans-display font-semibold text-[10px] leading-[1.4] align-middle select-none">
                            <Star className="w-2.5 h-2.5 shrink-0" />
                            <span>{ann.tag}</span>
                          </span>
                        )}
                      </span>
                    );
                  })}
                </p>
              ))}
            </div>
          </div>
        </section>

        <section className="lg:col-span-6 bg-[#FAF8F5] p-5 lg:p-6 lg:h-full lg:overflow-y-auto">
          <div className="space-y-3">
            <h3 className="font-sans-display font-semibold text-base text-[#113C36]">
              {t('rev.exemplarWhyTitle')}
            </h3>

            {exemplar.keyTakeaway && (
              <div className="p-3.5 rounded-[12px] bg-[#E5F0EA] border border-[#C5DDD1] space-y-1">
                <div className="text-xs font-sans-display font-semibold text-[#113C36]">
                  {t('rev.exemplarTakeawayTitle')}
                </div>
                <p className="text-xs text-[#113C36] leading-snug">{exemplar.keyTakeaway}</p>
              </div>
            )}

            <div className="space-y-2.5">
              {exemplar.annotations.map((ann) => {
                const isSelected = selectedExemplarAnnId === ann.id;
                return (
                  <div
                    key={ann.id}
                    data-exemplar-card={ann.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => handleSelectExemplar(ann.id, 'essay')}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleSelectExemplar(ann.id, 'essay');
                      }
                    }}
                    className={`p-3 rounded-[12px] bg-white border space-y-1.5 cursor-pointer transition-all ${
                      isSelected
                        ? 'border-[#113C36] ring-2 ring-[#113C36]/20'
                        : 'border-[#E5DFD5] hover:border-[#CFC6B9]'
                    }`}
                  >
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-[#113C36] text-white text-[11px] font-sans-display font-semibold">
                      <Star className="w-3 h-3 shrink-0" />
                      <span>{ann.tag}</span>
                    </span>
                    <blockquote className="text-[11.5px] font-serif-text italic text-[#4A5955] border-l-2 border-[#113C36]/40 pl-2.5">
                      &ldquo;{ann.quote}&rdquo;
                    </blockquote>
                    <p className="text-xs text-[#113C36] leading-snug">{ann.explanation}</p>
                  </div>
                );
              })}
            </div>
            {writingFooterNav}
          </div>
        </section>
      </main>
    );
  };

  const activeStatus = activeQuestion ? itemStatusMap.get(activeQuestion.questionId) : undefined;
  const isActiveWriting = activeQuestion?.formatType === 'WRIT_TYPED_TASK';
  const activeWritingReview = isActiveWriting && activeQuestion
    ? writingReview.find((w) => w.questionId === activeQuestion.questionId) || writingReview[0] || null
    : null;
  const writingFooterNav =
    filteredQuestions.length > 1 ? (
      <div className="pt-4 mt-6 border-t border-[#E5DFD5] flex items-center justify-between gap-3">
        <button
          type="button"
          disabled={activeIndex <= 0}
          onClick={() => handleSelectQuestion(filteredQuestions[activeIndex - 1].questionId)}
          className="px-4 py-2 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#F3EFE8] text-sm font-sans-display font-medium text-[#113C36] inline-flex items-center gap-1.5 disabled:opacity-40 cursor-pointer whitespace-nowrap"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>{t('rev.previousItem')}</span>
        </button>
        <button
          type="button"
          disabled={activeIndex >= filteredQuestions.length - 1}
          onClick={() => handleSelectQuestion(filteredQuestions[activeIndex + 1].questionId)}
          className="px-4 py-2 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-sm font-sans-display font-semibold inline-flex items-center gap-1.5 disabled:opacity-40 cursor-pointer whitespace-nowrap"
        >
          <span>{t('rev.nextItem')}</span>
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
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
              <div className="flex flex-wrap items-center gap-1 p-1 bg-white/75 rounded-[10px] border border-[#E5DFD5]">
                {(
                  [
                    ['all', t('rev.filterAll', { count: counts.all })],
                    ['incorrect', t('rev.filterIncorrect', { count: counts.incorrect })],
                    ['unanswered', t('rev.filterUnanswered', { count: counts.unanswered })],
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
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <LanguageToggle compact />
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
            <div className="flex flex-wrap gap-1.5 max-w-[840px] max-h-[92px] overflow-y-auto pr-1">
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
                    className={`w-9 h-9 inline-flex items-center justify-center rounded-[8px] border text-xs font-sans-display font-semibold tabular-nums cursor-pointer transition-colors ${
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
          </div>
        )}
      </header>

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
                      current: questions.findIndex((q) => q.questionId === activeQuestion.questionId) + 1,
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
                  activeStatus && (
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
                          <span>{t('ws.correct')}</span>
                        </>
                      ) : activeStatus.hasUnanswered ? (
                        <>
                          <XCircle className="w-3.5 h-3.5" />
                          <span>{t('ws.unanswered')}</span>
                        </>
                      ) : (
                        <>
                          <XCircle className="w-3.5 h-3.5" />
                          <span>{isZh ? '错题' : 'Incorrect'}</span>
                        </>
                      )}
                    </span>
                  )
                )}
              </div>

              {flaggedIds.has(activeQuestion.questionId) ? (
                <span className="text-xs font-medium text-[#A35116]">
                  {t('rev.flaggedForReview')}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() =>
                    setFlaggingQid(
                      flaggingQid === activeQuestion.questionId ? null : activeQuestion.questionId
                    )
                  }
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-[#4A5955] hover:text-[#113C36] cursor-pointer whitespace-nowrap"
                >
                  <Flag className="w-3.5 h-3.5" />
                  <span>{t('rev.reportIssue')}</span>
                </button>
              )}
            </div>

            {flaggingQid === activeQuestion.questionId && (
              <div className="max-w-[1440px] mx-auto mt-2 p-3 rounded-[10px] bg-white border border-[#E5DFD5] flex flex-wrap gap-2">
                <select
                  aria-label={t('rev.reportIssue')}
                  value={flagReason}
                  onChange={(e) => setFlagReason(e.target.value)}
                  className="px-2.5 py-1.5 rounded-[8px] border border-[#CFC6B9] bg-[#FAF8F5] text-xs"
                >
                  <option value="Unclear wording or diagram">{t('rev.flagReason1')}</option>
                  <option value="Answer key seems incorrect">{t('rev.flagReason2')}</option>
                  <option value="Formatting / display issue">{t('rev.flagReason3')}</option>
                </select>
                <input
                  type="text"
                  value={flagNotes}
                  onChange={(e) => setFlagNotes(e.target.value)}
                  placeholder={t('rev.flagNotePlaceholder')}
                  className="flex-1 min-w-48 px-2.5 py-1.5 rounded-[8px] border border-[#CFC6B9] bg-[#FAF8F5] text-xs"
                />
                <button
                  type="button"
                  onClick={() => handleSubmitFlag(activeQuestion.questionId)}
                  className="px-3.5 py-1.5 rounded-[8px] bg-[#113C36] text-white text-xs font-sans-display font-semibold cursor-pointer whitespace-nowrap"
                >
                  {t('rev.submitReport')}
                </button>
              </div>
            )}
          </div>

          {isActiveWriting ? (
            (() => {
              const latestEval = activeWritingReview?.evaluations[0];
              const { items: annotations, isLegacy } = getEffectiveAnnotations(latestEval);
              if (writingViewMode === 'critique') {
                return (
                  <main className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12">
                    <section className="lg:col-span-6 bg-white border-b lg:border-b-0 lg:border-r border-[#E5DFD5] p-5 lg:p-6 lg:h-full lg:overflow-y-auto">
                      {renderAnnotatedEssayPane(activeWritingReview, annotations)}
                    </section>
                    <section className="lg:col-span-6 bg-[#FAF8F5] p-5 lg:p-6 lg:h-full lg:overflow-y-auto">
                      {renderCritiquePanel(
                        activeWritingReview,
                        activeQuestion,
                        latestEval,
                        annotations,
                        isLegacy
                      )}
                      {writingFooterNav}
                    </section>
                  </main>
                );
              }
              if (writingViewMode === 'exemplar') {
                return renderExemplarView(activeWritingReview, latestEval);
              }
              return (
                <main className="flex-1 min-h-0 overflow-y-auto bg-[#FAF8F5] p-6 lg:p-8">
                  <div className="max-w-3xl mx-auto rounded-[16px] bg-white border border-[#E5DFD5] p-6 sm:p-8 space-y-6">
                    <WritingStimulusPane question={activeQuestion} />
                    {writingFooterNav}
                  </div>
                </main>
              );
            })()
          ) : (
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
                    className="px-4 py-2 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#F3EFE8] text-sm font-sans-display font-medium text-[#113C36] inline-flex items-center gap-1.5 disabled:opacity-40 cursor-pointer whitespace-nowrap"
                  >
                    <ArrowLeft className="w-4 h-4" />
                    <span>{t('rev.previousItem')}</span>
                  </button>
                  <button
                    type="button"
                    disabled={activeIndex >= filteredQuestions.length - 1}
                    onClick={() => handleSelectQuestion(filteredQuestions[activeIndex + 1].questionId)}
                    className="px-4 py-2 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-sm font-sans-display font-semibold inline-flex items-center gap-1.5 disabled:opacity-40 cursor-pointer whitespace-nowrap"
                  >
                    <span>{t('rev.nextItem')}</span>
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>
              }
            />
          )}
        </div>
      ) : null}
    </div>
  );
}
