import { useEffect, useState, type ReactNode } from 'react';
import { BookOpen, Check, CheckCircle2, ChevronDown, ChevronRight, X, XCircle } from 'lucide-react';
import type {
  EvidenceCitationRef,
  MarkingResult,
  QuestionItem,
  StimulusGroup,
  StudentQuestionView,
} from '../../shared/contracts';
import { SKILLS_TAXONOMY } from '../../shared/skills';
import { ReadingRightAnswerPane, ReadingStimulusPane } from './ReadingRenderers';
import { VisualRenderer } from './VisualRenderer';
import { WritingAnswerPane, WritingStimulusPane } from './WritingEditor';

const SKILL_NAME_MAP = new Map(SKILLS_TAXONOMY.map((s) => [s.skillId, s.displayName]));

export const SECTION_LABELS: Record<string, string> = {
  READ: 'Reading',
  MATH: 'Mathematical Reasoning',
  THINK: 'Thinking Skills',
  WRIT: 'Writing',
};

export const FORMAT_LABELS: Record<string, string> = {
  READ_FICTION_MCQ: 'Literary Comprehension',
  READ_VOCAB_CLOZE: 'Vocabulary Cloze',
  READ_POETRY_MCQ: 'Poetry Analysis',
  READ_GAPPED_TEXT: 'Gapped Text',
  READ_MULTIPLE_MATCH: 'Multiple Matching',
  MATH_MCQ_5: '5-Option MCQ',
  THINK_MCQ_4: '4-Option MCQ',
  WRIT_TYPED_TASK: 'Typed Response',
};

export type QuestionWorkspaceMode = 'exam' | 'review' | 'adminPreview';

type WorkspaceQuestion = StudentQuestionView | (QuestionItem & { stimulus?: StimulusGroup });

interface QuestionWorkspaceProps {
  mode: QuestionWorkspaceMode;
  question: WorkspaceQuestion;
  stimulus?: StimulusGroup;
  answersByPartId?: Record<string, string | null>;
  eliminatedByPartId?: Record<string, string[]>;
  highlights?: string[];
  activeGapIndex?: number;
  onSelectGapIndex?: (idx: number) => void;
  onSelectAnswer?: (partId: string, key: string | null) => void;
  onToggleEliminate?: (partId: string, key: string) => void;
  onAddHighlight?: (text: string) => void;
  onClearHighlights?: () => void;
  writingDraft?: { planNotes: string; responseText: string };
  onChangeWritingPlan?: (val: string) => void;
  onChangeWritingResponse?: (val: string) => void;
  reviewResults?: MarkingResult[];
  activeEvidenceRef?: EvidenceCitationRef | null;
  onSelectEvidenceRef?: (ref: EvidenceCitationRef | null) => void;
  footerNav?: ReactNode;
  embedded?: boolean;
  frozen?: boolean;
}

export function QuestionWorkspace({
  mode,
  question,
  stimulus: stimulusProp,
  answersByPartId = {},
  eliminatedByPartId = {},
  highlights = [],
  activeGapIndex: controlledGapIdx,
  onSelectGapIndex,
  onSelectAnswer = () => undefined,
  onToggleEliminate = () => undefined,
  onAddHighlight = () => undefined,
  onClearHighlights = () => undefined,
  writingDraft = { planNotes: '', responseText: '' },
  onChangeWritingPlan = () => undefined,
  onChangeWritingResponse = () => undefined,
  reviewResults = [],
  activeEvidenceRef = null,
  onSelectEvidenceRef,
  footerNav,
  embedded = false,
  frozen = false,
}: QuestionWorkspaceProps) {
  const [internalGapIdx, setInternalGapIdx] = useState(0);
  const [mobileTab, setMobileTab] = useState<'stimulus' | 'answer'>('stimulus');
  const [expandedBreakdown, setExpandedBreakdown] = useState(false);

  useEffect(() => {
    setInternalGapIdx(0);
  }, [question.questionId]);

  const activeGapIndex = controlledGapIdx ?? internalGapIdx;
  const setActiveGapIndex = onSelectGapIndex ?? setInternalGapIdx;
  const stim = stimulusProp || question.stimulus;
  const readOnly = mode !== 'exam' || frozen;
  const showAnswerKey = mode === 'review' || mode === 'adminPreview';

  const isReading = question.section === 'READ';
  const isWriting = question.formatType === 'WRIT_TYPED_TASK';
  const activePart = question.parts[0];

  const reviewByPartId: Record<string, MarkingResult> = {};
  for (const r of reviewResults) {
    reviewByPartId[r.partId] = r;
  }

  const handleCitationClick = (ref: EvidenceCitationRef) => {
    if (onSelectEvidenceRef) {
      const next = activeEvidenceRef?.refId === ref.refId ? null : ref;
      onSelectEvidenceRef(next);
      setMobileTab('stimulus');
    }
  };

  // Review & Admin Preview worked explanation + distractor breakdown block
  const renderReviewAndMetadataBlock = () => {
    if (mode === 'exam' || isWriting) return null;

    const fullParts = question.parts as (QuestionItem['parts'][number])[];
    const safePartIdx = Math.min(Math.max(0, activeGapIndex), Math.max(0, fullParts.length - 1));
    const primaryPart = fullParts[safePartIdx];
    const primaryRes = primaryPart ? reviewByPartId[primaryPart.partId] : undefined;
    const primaryExplanation =
      primaryRes?.workedExplanation || (mode === 'adminPreview' ? primaryPart?.workedExplanation : undefined);

    return (
      <div className="pt-4 border-t border-[var(--border-hairline)] space-y-3">
        {(primaryExplanation || fullParts.length > 1) && (
          <div className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-elevated)] border border-[var(--border-hairline)] space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs font-bold text-[var(--text-primary)]">
                Worked Explanation
                {fullParts.length > 1 ? ` (Part ${safePartIdx + 1} of ${fullParts.length})` : ''}
              </div>
              {mode === 'review' && primaryRes && (
                <span
                  className={`inline-flex items-center gap-1 text-xs font-semibold ${
                    primaryRes.isCorrect
                      ? 'text-[var(--status-success)]'
                      : primaryRes.selectedAnswer === null
                        ? 'text-[var(--status-warn)]'
                        : 'text-[var(--status-error)]'
                  }`}
                >
                  {primaryRes.isCorrect ? (
                    <>
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>Correct ({primaryRes.correctAnswerKey})</span>
                    </>
                  ) : primaryRes.selectedAnswer === null ? (
                    <>
                      <XCircle className="w-3.5 h-3.5" />
                      <span>Unanswered · Answer: {primaryRes.correctAnswerKey}</span>
                    </>
                  ) : (
                    <>
                      <XCircle className="w-3.5 h-3.5" />
                      <span>
                        Picked {primaryRes.selectedAnswer} · Answer: {primaryRes.correctAnswerKey}
                      </span>
                    </>
                  )}
                </span>
              )}
            </div>

            {fullParts.length > 1 && (
              <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Select question part explanation">
                {fullParts.map((part, pIdx) => (
                  <button
                    key={part.partId}
                    type="button"
                    role="tab"
                    aria-selected={pIdx === safePartIdx}
                    onClick={() => setActiveGapIndex(pIdx)}
                    className={`px-2.5 py-1 rounded-[var(--radius-sm)] border text-[11px] font-semibold cursor-pointer transition-colors ${
                      pIdx === safePartIdx
                        ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)] text-white'
                        : 'border-[var(--border-strong)] bg-[var(--bg-canvas)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    Part {pIdx + 1}
                  </button>
                ))}
              </div>
            )}

            {primaryExplanation && (
              <p className="text-xs text-[var(--text-secondary)] leading-relaxed whitespace-pre-line">
                {primaryExplanation}
              </p>
            )}

            {mode === 'review' && primaryRes?.distractorRationale && (
              <p className="text-xs text-[var(--status-warn)] bg-[var(--status-warn-bg)]/60 px-2.5 py-1.5 rounded-[var(--radius-sm)] whitespace-pre-line">
                <strong>Why {primaryRes.selectedAnswer} is a distractor:</strong>{' '}
                {primaryRes.distractorRationale}
              </p>
            )}

            {/* Evidence citation buttons for active part */}
            {((mode === 'review' && primaryRes?.evidenceRefs) ||
              (mode === 'adminPreview' && primaryPart?.evidenceRefs)) &&
              ((primaryRes?.evidenceRefs || primaryPart?.evidenceRefs || []).length > 0) && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {(primaryRes?.evidenceRefs || primaryPart?.evidenceRefs || []).map((ev) => {
                    const isActive = activeEvidenceRef?.refId === ev.refId;
                    return (
                      <button
                        key={ev.refId}
                        type="button"
                        onClick={() => handleCitationClick(ev)}
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[var(--radius-sm)] border text-xs font-medium cursor-pointer transition-colors ${
                          isActive
                            ? 'border-sky-600 bg-sky-100 text-sky-900'
                            : 'border-[var(--border-strong)] bg-[var(--bg-canvas)] hover:bg-[var(--bg-surface)] text-[var(--text-primary)]'
                        }`}
                      >
                        <BookOpen className="w-3 h-3 text-sky-700" />
                        <span>Evidence [{ev.refId}]</span>
                      </button>
                    );
                  })}
                </div>
              )}
          </div>
        )}

        {/* Expandable full breakdown (all parts + all distractor rationales + skills) */}
        <div className="border border-[var(--border-hairline)] rounded-[var(--radius-md)] bg-[var(--bg-elevated)]">
          <button
            type="button"
            onClick={() => setExpandedBreakdown((v) => !v)}
            aria-expanded={expandedBreakdown}
            className="w-full px-4 py-2.5 flex items-center justify-between text-xs font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
          >
            <span>
              {fullParts.length > 1
                ? `All ${fullParts.length} Parts Breakdown, Distractors & Skills`
                : 'Distractor Rationale, Evidence & Skill Metadata'}
            </span>
            {expandedBreakdown ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>

          {expandedBreakdown && (
            <div className="px-4 pb-4 space-y-3 border-t border-[var(--border-hairline)] pt-3">
              {fullParts.map((part, pIdx) => {
                const res = reviewByPartId[part.partId];
                const explanation = res?.workedExplanation || (mode === 'adminPreview' ? part.workedExplanation : '');
                const evList = res?.evidenceRefs || (mode === 'adminPreview' ? part.evidenceRefs : undefined) || [];
                const rationales = mode === 'adminPreview' ? part.distractorRationales : undefined;
                const answerKey = res?.correctAnswerKey || (mode === 'adminPreview' ? part.correctAnswerKey : '');

                return (
                  <div
                    key={part.partId}
                    className="p-3 rounded-[var(--radius-sm)] bg-[var(--bg-canvas)] border border-[var(--border-hairline)] space-y-1.5 text-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-bold text-[var(--text-primary)]">
                        {fullParts.length > 1 ? `Part ${pIdx + 1}: ` : ''}
                        Answer Key: {answerKey || '—'}
                      </span>
                      <span className="text-[var(--text-muted)]">
                        {SKILL_NAME_MAP.get(part.skillId) || part.skillId}
                      </span>
                    </div>
                    {mode === 'review' && res && (
                      <div
                        className={`font-semibold ${
                          res.isCorrect
                            ? 'text-[var(--status-success)]'
                            : res.selectedAnswer === null
                              ? 'text-[var(--status-warn)]'
                              : 'text-[var(--status-error)]'
                        }`}
                      >
                        {res.isCorrect
                          ? 'Correct'
                          : res.selectedAnswer === null
                            ? 'Unanswered'
                            : `Picked ${res.selectedAnswer}`}
                      </div>
                    )}
                    {explanation && (
                      <p className="text-[var(--text-secondary)] whitespace-pre-line">{explanation}</p>
                    )}
                    {res?.distractorRationale && (
                      <p className="text-[var(--status-warn)] whitespace-pre-line">
                        <strong>Distractor note:</strong> {res.distractorRationale}
                      </p>
                    )}
                    {rationales && Object.keys(rationales).length > 0 && (
                      <div className="space-y-1 pt-1">
                        {Object.entries(rationales).map(([optKey, note]) => (
                          <div key={optKey} className="text-[var(--text-secondary)] whitespace-pre-line">
                            <span className="font-mono font-bold mr-1.5">{optKey}:</span>
                            {note}
                          </div>
                        ))}
                      </div>
                    )}
                    {evList.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {evList.map((ev) => (
                          <button
                            key={ev.refId}
                            type="button"
                            onClick={() => handleCitationClick(ev)}
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] font-medium cursor-pointer ${
                              activeEvidenceRef?.refId === ev.refId
                                ? 'border-sky-600 bg-sky-100 text-sky-900'
                                : 'border-[var(--border-strong)] bg-[var(--bg-elevated)] text-[var(--text-primary)]'
                            }`}
                          >
                            <BookOpen className="w-3 h-3 text-sky-700" />
                            <span>Evidence [{ev.refId}]</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  };

  const singlePartReview = !isReading && !isWriting && activePart ? reviewByPartId[activePart.partId] : undefined;
  const singlePartCorrectKey =
    singlePartReview?.correctAnswerKey ||
    (showAnswerKey ? (activePart as { correctAnswerKey?: string } | undefined)?.correctAnswerKey : undefined);

  return (
    <div className={embedded ? 'flex flex-col border border-[var(--border-hairline)] rounded-[var(--radius-md)] overflow-hidden bg-[var(--bg-canvas)]' : 'flex-1 min-h-0 flex flex-col'}>
      {/* Mobile sticky pane switcher (< lg) */}
      <div className="lg:hidden sticky top-0 z-20 flex border-b border-[var(--border-hairline)] bg-[var(--bg-surface)] px-3 py-2 gap-2">
        <button
          type="button"
          onClick={() => setMobileTab('stimulus')}
          className={`flex-1 py-1.5 px-3 rounded-[var(--radius-sm)] text-xs font-semibold cursor-pointer transition-colors ${
            mobileTab === 'stimulus'
              ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-xs border border-[var(--border-strong)]'
              : 'text-[var(--text-secondary)]'
          }`}
        >
          Passage &amp; Visual
        </button>
        <button
          type="button"
          onClick={() => setMobileTab('answer')}
          className={`flex-1 py-1.5 px-3 rounded-[var(--radius-sm)] text-xs font-semibold cursor-pointer transition-colors ${
            mobileTab === 'answer'
              ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-xs border border-[var(--border-strong)]'
              : 'text-[var(--text-secondary)]'
          }`}
        >
          Question &amp; Answer
        </button>
      </div>

      <div
        className={`${
          embedded ? 'grid grid-cols-1 xl:grid-cols-12' : 'flex-1 min-h-0 max-w-[1440px] w-full mx-auto grid grid-cols-1 lg:grid-cols-12'
        } items-stretch`}
      >
        {/* LEFT PANE: Stimulus / Passage / Problem Stem / Diagram */}
        <section
          aria-label="Question stimulus and problem context"
          className={`${mobileTab === 'stimulus' ? 'block' : 'hidden lg:block'} ${
            embedded ? 'xl:col-span-6 p-5 border-b xl:border-b-0 xl:border-r max-h-[540px] xl:overflow-y-auto' : `${isReading ? 'lg:col-span-7' : 'lg:col-span-6'} p-6 lg:p-8 border-b lg:border-b-0 lg:border-r lg:h-full lg:overflow-y-auto`
          } border-[var(--border-hairline)] bg-[var(--bg-elevated)]`}
        >
          <div className="text-xs font-medium text-[var(--text-muted)] mb-3 tabular-nums">
            {SECTION_LABELS[question.section] || question.section} ·{' '}
            {FORMAT_LABELS[question.formatType] || question.formatType.replace(/_/g, ' ')}
          </div>

          {isReading && (
            <ReadingStimulusPane
              question={question}
              stimulus={stim}
              answersByPartId={answersByPartId}
              onSelectAnswer={onSelectAnswer}
              activeGapIndex={activeGapIndex}
              onSelectGapIndex={setActiveGapIndex}
              highlights={highlights}
              onAddHighlight={onAddHighlight}
              onClearHighlights={onClearHighlights}
              readOnly={readOnly}
              activeEvidenceRef={activeEvidenceRef}
            />
          )}

          {isWriting && (
            <WritingStimulusPane question={{ ...question, stimulus: stim } as StudentQuestionView} />
          )}

          {!isReading && !isWriting && (
            <div className="space-y-5">
              {question.stemPrefix && (
                <p className="text-base text-[var(--text-primary)] leading-relaxed bg-[var(--bg-surface)] p-4 rounded-[var(--radius-md)] border border-[var(--border-hairline)]">
                  {question.stemPrefix}
                </p>
              )}
              {activePart && (
                <div className="text-base font-medium text-[var(--text-primary)] leading-relaxed">
                  {activePart.promptText}
                </div>
              )}
              <VisualRenderer visual={question.visual} />
            </div>
          )}
        </section>

        {/* RIGHT PANE: Interactive Answers / Review Key & Breakdown */}
        <section
          aria-label="Answer selection panel"
          className={`${mobileTab === 'answer' ? 'flex' : 'hidden lg:flex'} ${
            embedded ? 'xl:col-span-6 p-5 max-h-[540px] xl:overflow-y-auto' : `${isReading ? 'lg:col-span-5' : 'lg:col-span-6'} p-6 lg:p-8 lg:h-full lg:overflow-y-auto`
          } bg-[var(--bg-canvas)] flex-col justify-between gap-6`}
        >
          <div className="space-y-5">
            {isReading && (
              <ReadingRightAnswerPane
                question={question}
                stimulus={stim}
                answersByPartId={answersByPartId}
                eliminatedByPartId={eliminatedByPartId}
                onSelectAnswer={onSelectAnswer}
                onToggleEliminate={onToggleEliminate}
                activeGapIndex={activeGapIndex}
                onSelectGapIndex={setActiveGapIndex}
                readOnly={readOnly}
                showAnswerKey={showAnswerKey}
                reviewByPartId={reviewByPartId}
              />
            )}

            {isWriting && !readOnly && (
              <WritingAnswerPane
                question={{ ...question, stimulus: stim } as StudentQuestionView}
                planNotes={writingDraft.planNotes}
                responseText={writingDraft.responseText}
                onChangePlan={onChangeWritingPlan}
                onChangeResponse={onChangeWritingResponse}
              />
            )}

            {isWriting && readOnly && (
              <div className="p-4 rounded-[var(--radius-md)] border border-[var(--border-hairline)] bg-[var(--bg-elevated)] space-y-2 text-xs text-[var(--text-secondary)]">
                <div className="font-bold text-[var(--text-primary)]">Writing Task Specifications</div>
                <div>Genre: {question.writingSpec?.genre || 'Essay'}</div>
                <div>Audience: {question.writingSpec?.audience || 'General'}</div>
                <div>
                  Target words: {question.writingSpec?.recommendedWordRange?.[0] ?? 250}–
                  {question.writingSpec?.recommendedWordRange?.[1] ?? 480}
                </div>
              </div>
            )}

            {!isReading && !isWriting && activePart && (
              <div className="space-y-4">
                <div className="flex items-center justify-between text-xs text-[var(--text-secondary)]">
                  <span>
                    {readOnly
                      ? `Answer options (${activePart.options[0]?.key}–${activePart.options[activePart.options.length - 1]?.key})`
                      : `Select one answer (${activePart.options[0]?.key}–${activePart.options[activePart.options.length - 1]?.key})`}
                  </span>
                  {!readOnly && <span>Shortcuts: 1–{activePart.options.length} · N/P · F</span>}
                </div>

                <div className="space-y-2.5">
                  {activePart.options.map((opt) => {
                    const picked = answersByPartId[activePart.partId] === opt.key;
                    const elim = !readOnly && (eliminatedByPartId[activePart.partId] || []).includes(opt.key);
                    const isCorrect = singlePartCorrectKey === opt.key;
                    const isWrongSelected = readOnly && picked && singlePartCorrectKey && !isCorrect;

                    return (
                      <div key={opt.key} className="flex items-stretch gap-2">
                        <button
                          type="button"
                          disabled={readOnly}
                          onClick={() =>
                            !readOnly && onSelectAnswer(activePart.partId, picked ? null : opt.key)
                          }
                          className={`flex-1 text-left p-4 rounded-[var(--radius-md)] border transition-colors flex items-center gap-3.5 ${
                            readOnly ? 'cursor-default' : 'cursor-pointer'
                          } ${
                            readOnly && isCorrect
                              ? 'border-[var(--status-success)] bg-[var(--status-success-bg)]'
                              : isWrongSelected
                                ? 'border-[var(--status-error)] bg-[var(--status-error-bg)]'
                                : picked
                                  ? 'border-[var(--accent-primary)] bg-[var(--accent-soft)]'
                                  : elim
                                    ? 'border-[var(--border-hairline)] bg-[var(--bg-surface)] opacity-55'
                                    : 'border-[var(--border-hairline)] bg-[var(--bg-elevated)] hover:border-[var(--border-strong)]'
                          }`}
                        >
                          <span
                            className={`w-7 h-7 rounded-full border text-xs font-bold flex items-center justify-center shrink-0 ${
                              readOnly && isCorrect
                                ? 'border-[var(--status-success)] bg-[var(--status-success)] text-white'
                                : isWrongSelected
                                  ? 'border-[var(--status-error)] bg-[var(--status-error)] text-white'
                                  : picked
                                    ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)] text-white'
                                    : 'border-[var(--border-strong)] text-[var(--text-secondary)]'
                            }`}
                          >
                            {readOnly && isCorrect ? (
                              <Check className="w-3.5 h-3.5" />
                            ) : picked && !readOnly ? (
                              <Check className="w-3.5 h-3.5" />
                            ) : (
                              opt.key
                            )}
                          </span>
                          <div className="flex-1 min-w-0 space-y-2">
                            {opt.text && (
                              <div
                                className={`text-sm font-medium text-[var(--text-primary)] ${
                                  elim ? 'line-through' : ''
                                }`}
                              >
                                {opt.text}
                              </div>
                            )}
                            {opt.visual && <VisualRenderer visual={opt.visual} compact />}
                          </div>
                          {readOnly && isCorrect && (
                            <span className="text-[11px] font-bold text-[var(--status-success)] shrink-0">
                              Correct Key
                            </span>
                          )}
                          {isWrongSelected && (
                            <span className="text-[11px] font-bold text-[var(--status-error)] shrink-0">
                              Picked
                            </span>
                          )}
                        </button>
                        {!readOnly && (
                          <button
                            type="button"
                            aria-label={`Eliminate option ${opt.key}`}
                            title="Cross out distractor"
                            onClick={() => onToggleEliminate(activePart.partId, opt.key)}
                            className={`px-2.5 rounded-[var(--radius-md)] border cursor-pointer transition-colors ${
                              elim
                                ? 'border-[var(--border-strong)] bg-[var(--bg-hover)] text-[var(--text-primary)]'
                                : 'border-[var(--border-hairline)] bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                            }`}
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {renderReviewAndMetadataBlock()}
          </div>

          {footerNav}
        </section>
      </div>
    </div>
  );
}
