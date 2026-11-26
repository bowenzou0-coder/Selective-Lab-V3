import { memo, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, Check, CheckCircle2, Maximize2, X, XCircle } from 'lucide-react';
import { useI18n } from '../i18n';
import type {
  EvidenceCitationRef,
  MarkingResult,
  QuestionItem,
  StimulusGroup,
  StudentQuestionView,
  VisualSpec,
} from '../../shared/contracts';
import { getVisualOptionTileHeightClass, shouldUseVisualOptionGrid } from '../optionLayout';
import { FormattedText } from './FormattedText';
import { ReadingRightAnswerPane, ReadingStimulusPane } from './ReadingRenderers';
import { VisualRenderer } from './VisualRenderer';
import { Collapsible, DisclosureChevron } from './ui/Collapsible';
import { useFocusTrap } from './ui/focusTrap';
import { useSlidingIndicator } from './ui/useSlidingIndicator';
import { WritingAnswerPane, WritingStimulusPane } from './WritingEditor';
import type { SessionClock } from '../sessionClock';

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
  /** Admin inspector shows explanations in its own tab; set false to avoid duplicating them here. */
  showReviewBlock?: boolean;
  /** Reading passage cohesion cue, e.g. "Passage 1, question 2 of 4". */
  passageLabel?: string;
  /** Exam clock, used by the Writing editor's pacing note. */
  writingClock?: SessionClock;
}

export const QuestionWorkspace = memo(function QuestionWorkspace({
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
  showReviewBlock = true,
  passageLabel,
  writingClock,
}: QuestionWorkspaceProps) {
  const { t, sectionLabel, formatLabel, skillName } = useI18n();
  const [internalGapIdx, setInternalGapIdx] = useState(0);
  const [mobileTab, setMobileTab] = useState<'stimulus' | 'answer'>('stimulus');
  const [expandedBreakdown, setExpandedBreakdown] = useState(false);
  const workspaceUid = useId().replace(/:/g, '');
  const breakdownId = `ws-breakdown-${workspaceUid}`;
  const paneIdBase = `ws-pane-${workspaceUid}`;
  const paneTrackRef = useRef<HTMLDivElement>(null);
  const paneIndicator = useSlidingIndicator(paneTrackRef, mobileTab);
  const [zoomedOption, setZoomedOption] = useState<{ key: string; visual: VisualSpec } | null>(null);
  const optionZoomRef = useRef<HTMLDivElement>(null);
  useFocusTrap(optionZoomRef, zoomedOption !== null, { onEscape: () => setZoomedOption(null) });

  useEffect(() => {
    setInternalGapIdx(0);
    setZoomedOption(null);
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
                {t('ws.workedExplanation')}
                {fullParts.length > 1
                  ? t('ws.partOfTotal', { current: safePartIdx + 1, total: fullParts.length })
                  : ''}
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
                      <span>{t('ws.correctWithKey', { key: primaryRes.correctAnswerKey })}</span>
                    </>
                  ) : primaryRes.selectedAnswer === null ? (
                    <>
                      <XCircle className="w-3.5 h-3.5" />
                      <span>{t('ws.unansweredWithKey', { key: primaryRes.correctAnswerKey })}</span>
                    </>
                  ) : (
                    <>
                      <XCircle className="w-3.5 h-3.5" />
                      <span>
                        {t('ws.pickedWithKey', {
                          picked: primaryRes.selectedAnswer,
                          key: primaryRes.correctAnswerKey,
                        })}
                      </span>
                    </>
                  )}
                </span>
              )}
            </div>

            {fullParts.length > 1 && (
              <div className="flex flex-wrap gap-1.5" role="tablist" aria-label={t('ws.workedExplanation')}>
                {fullParts.map((part, pIdx) => (
                  <button
                    key={part.partId}
                    type="button"
                    role="tab"
                    aria-selected={pIdx === safePartIdx}
                    onClick={() => setActiveGapIndex(pIdx)}
                    className={`px-2.5 py-1 rounded-[var(--radius-sm)] border text-[11px] font-semibold cursor-pointer transition-tactile ${
                      pIdx === safePartIdx
                        ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)] text-white'
                        : 'border-[var(--border-strong)] bg-[var(--bg-canvas)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    {t('ws.partLabel', { num: pIdx + 1 })}
                  </button>
                ))}
              </div>
            )}

            {primaryExplanation && (
              <FormattedText text={primaryExplanation} variant="explanation" />
            )}

            {mode === 'review' && primaryRes?.distractorRationale && (
              <p className="text-xs text-[var(--status-warn)] bg-[var(--status-warn-bg)]/60 px-2.5 py-1.5 rounded-[var(--radius-sm)] whitespace-pre-line">
                <strong>{t('ws.whyDistractor', { key: primaryRes.selectedAnswer || '' })}</strong>{' '}
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
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[var(--radius-sm)] border text-xs font-medium cursor-pointer transition-tactile ${
                          isActive
                            ? 'border-sky-600 bg-sky-100 text-sky-900'
                            : 'border-[var(--border-strong)] bg-[var(--bg-canvas)] hover:bg-[var(--bg-surface)] text-[var(--text-primary)]'
                        }`}
                      >
                        <BookOpen className="w-3 h-3 text-sky-700" />
                        <span>{t('ws.evidenceBadge', { id: ev.refId })}</span>
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
            id={`${breakdownId}-trigger`}
            onClick={() => setExpandedBreakdown((v) => !v)}
            aria-expanded={expandedBreakdown}
            aria-controls={`${breakdownId}-panel`}
            data-press="off"
            data-focus-ring="inset"
            className="w-full px-4 py-2.5 flex items-center justify-between gap-3 rounded-[var(--radius-md)] text-left text-xs font-semibold text-[var(--text-secondary)] transition-tactile duration-150 hover:text-[var(--text-primary)] active:bg-[var(--bg-canvas)] cursor-pointer"
          >
            <span>
              {fullParts.length > 1
                ? t('ws.allPartsBreakdown', { count: fullParts.length })
                : t('ws.distractorBreakdown')}
            </span>
            <DisclosureChevron open={expandedBreakdown} />
          </button>

          <Collapsible
            open={expandedBreakdown}
            id={`${breakdownId}-panel`}
            labelledBy={`${breakdownId}-trigger`}
            innerClassName="px-4 pb-4 space-y-3 border-t border-[var(--border-hairline)] pt-3"
          >
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
                        {fullParts.length > 1 ? `${t('ws.partLabel', { num: pIdx + 1 })}: ` : ''}
                        {t('ws.answerKeyLabel')} {answerKey || '—'}
                      </span>
                      <span className="text-[var(--text-muted)]">
                        {skillName(part.skillId)}
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
                          ? t('ws.correct')
                          : res.selectedAnswer === null
                            ? t('ws.unanswered')
                            : t('ws.picked', { key: res.selectedAnswer })}
                      </div>
                    )}
                    {explanation && (
                      <FormattedText text={explanation} variant="explanation" />
                    )}
                    {res?.distractorRationale && (
                      <p className="text-[var(--status-warn)] whitespace-pre-line">
                        <strong>{t('ws.distractorNote')}</strong> {res.distractorRationale}
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
                            <span>{t('ws.evidenceBadge', { id: ev.refId })}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
          </Collapsible>
        </div>
      </div>
    );
  };

  const singlePartReview = !isReading && !isWriting && activePart ? reviewByPartId[activePart.partId] : undefined;
  const singlePartCorrectKey =
    singlePartReview?.correctAnswerKey ||
    (showAnswerKey ? (activePart as { correctAnswerKey?: string } | undefined)?.correctAnswerKey : undefined);

  return (
    <div
      className={
        embedded
          ? 'flex flex-col border border-[#E5DFD5] rounded-[12px] overflow-hidden bg-[#FAF8F5]'
          : 'flex-1 min-h-0 flex flex-col'
      }
    >
      {/* Stacked-layout pane switcher (< lg): sticks just below the exam rail, sliding pill */}
      <div
        role="group"
        aria-label={t('ws.paneSwitcherAria')}
        className="lg:hidden sticky top-[var(--exam-rail-h,0px)] z-20 border-b border-[#E5DFD5] bg-[#F3EFE8] px-3 py-2"
      >
        <div ref={paneTrackRef} className="relative isolate flex gap-2">
          <span
            aria-hidden="true"
            className="sliding-indicator pointer-events-none absolute left-0 top-0 -z-10 rounded-[8px] border border-[#E5DFD5] bg-white"
            style={paneIndicator.style}
          />
          {(
            [
              ['stimulus', t('ws.passageAndVisual')],
              ['answer', t('ws.questionAndAnswer')],
            ] as const
          ).map(([pane, label]) => {
            const active = mobileTab === pane;
            return (
              <button
                key={pane}
                type="button"
                aria-pressed={active}
                aria-controls={`${paneIdBase}-${pane}`}
                data-indicator-active={active ? 'true' : undefined}
                onClick={() => setMobileTab(pane)}
                className={`flex-1 min-w-0 py-1.5 px-3 rounded-[8px] border text-xs font-sans-display font-semibold cursor-pointer transition-tactile ${
                  active
                    ? `text-[#113C36] ${paneIndicator.visible ? 'border-transparent' : 'bg-white border-[#E5DFD5]'}`
                    : 'border-transparent text-[#4A5955] hover:text-[#113C36]'
                }`}
              >
                <span className="block truncate">{label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div
        className={`${
          embedded
            ? 'grid grid-cols-1 xl:grid-cols-12'
            : 'flex-1 min-h-0 max-w-[1440px] w-full mx-auto grid grid-cols-1 lg:grid-cols-12'
        } items-stretch`}
      >
        {/* LEFT PANE: #FFFFFF Open-Book Reading / Stimulus Sheet */}
        <section
          id={`${paneIdBase}-stimulus`}
          aria-label={t('ws.passageAndVisual')}
          className={`min-w-0 ${mobileTab === 'stimulus' ? 'block' : 'hidden lg:block'} ${
            embedded
              ? 'xl:col-span-6 p-4 sm:p-5 border-b xl:border-b-0 xl:border-r'
              : `${isReading ? 'lg:col-span-7' : 'lg:col-span-6'} px-4 py-5 sm:p-6 lg:p-9 border-b lg:border-b-0 lg:border-r lg:h-full lg:overflow-y-auto lg:overscroll-contain`
          } border-[#E5DFD5] bg-white`}
        >
          <div className="flex flex-wrap items-center gap-2 text-xs text-[#615E57] mb-4">
            <span className="font-sans-display font-semibold text-[#113C36]">
              {sectionLabel(question.section)}
            </span>
            <span className="px-2 py-0.5 rounded-full bg-[#F3EFE8] text-[#4A5955] font-medium">
              {formatLabel(question.formatType)}
            </span>
            {passageLabel && (
              <span className="px-2 py-0.5 rounded-full border border-[#C5DDD1] bg-[#E5F0EA] text-[#113C36] font-medium tabular-nums">
                {passageLabel}
              </span>
            )}
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
            <div className="space-y-5 max-w-[65ch]">
              {question.stemPrefix && (
                <div className="bg-[#FAF8F5] p-4 rounded-[12px] border border-[#E5DFD5]">
                  <FormattedText text={question.stemPrefix} variant="boxedRules" />
                </div>
              )}
              {activePart && (
                <FormattedText text={activePart.promptText} variant="prompt" />
              )}
              <VisualRenderer visual={question.visual} />
            </div>
          )}
        </section>

        {/* RIGHT PANE: #FAF8F5 Answer Pane */}
        <section
          id={`${paneIdBase}-answer`}
          aria-label={t('ws.questionAndAnswer')}
          className={`min-w-0 ${mobileTab === 'answer' ? 'flex' : 'hidden lg:flex'} ${
            embedded
              ? 'xl:col-span-6 p-4 sm:p-5'
              : `${isReading ? 'lg:col-span-5' : 'lg:col-span-6'} px-4 py-5 sm:p-6 lg:p-8 lg:h-full lg:overflow-y-auto lg:overscroll-contain`
          } bg-[#FAF8F5] flex-col justify-between gap-6`}
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
                clock={writingClock}
              />
            )}

            {isWriting && readOnly && (
              <div className="p-4 rounded-[12px] border border-[#E5DFD5] bg-white space-y-2 text-xs text-[#4A5955]">
                <div className="font-sans-display font-semibold text-[#113C36]">{t('ws.writingSpecsTitle')}</div>
                <div>{t('ws.genreLabel', { genre: question.writingSpec?.genre || 'Essay' })}</div>
                <div>{t('ws.audienceLabel', { audience: question.writingSpec?.audience || 'General' })}</div>
                <div>
                  {t('ws.targetWords', {
                    min: question.writingSpec?.recommendedWordRange?.[0] ?? 250,
                    max: question.writingSpec?.recommendedWordRange?.[1] ?? 480,
                  })}
                </div>
              </div>
            )}

            {!isReading && !isWriting && activePart && (
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-2 text-xs text-[#4A5955]">
                  <span>
                    {readOnly
                      ? t('ws.answerOptionsRange', {
                          first: activePart.options[0]?.key || 'A',
                          last: activePart.options[activePart.options.length - 1]?.key || 'D',
                        })
                      : t('ws.selectAnswerRange', {
                          first: activePart.options[0]?.key || 'A',
                          last: activePart.options[activePart.options.length - 1]?.key || 'D',
                        })}
                  </span>
                  {!readOnly && (
                    <span className="text-[#615E57]">
                      {t('ws.shortcutsHint', { count: activePart.options.length })}
                    </span>
                  )}
                </div>

                {shouldUseVisualOptionGrid(activePart.options) ? (
                  <div
                    data-testid="visual-options-grid"
                    className="grid grid-cols-2 gap-3"
                  >
                    {activePart.options.map((opt) => {
                      const picked = answersByPartId[activePart.partId] === opt.key;
                      const elim = !readOnly && (eliminatedByPartId[activePart.partId] || []).includes(opt.key);
                      const isCorrect = singlePartCorrectKey === opt.key;
                      const isWrongSelected = readOnly && picked && singlePartCorrectKey && !isCorrect;
                      const tileHeightClass = getVisualOptionTileHeightClass(activePart.options.length);

                      return (
                        <div key={opt.key} className="relative flex flex-col">
                          <button
                            type="button"
                            disabled={readOnly}
                            onClick={() =>
                              !readOnly && onSelectAnswer(activePart.partId, picked ? null : opt.key)
                            }
                            aria-label={`Option ${opt.key}${opt.text ? `: ${opt.text}` : ''}`}
                            className={`w-full h-full text-left p-2.5 sm:p-3 rounded-[12px] border transition-colors flex flex-col gap-2 ${
                              readOnly ? 'cursor-default' : 'cursor-pointer'
                            } ${
                              readOnly && isCorrect
                                ? 'border-[#1D6346] bg-[#E5F3EC]'
                                : isWrongSelected
                                  ? 'border-[#B42318] bg-[#FDECEB]'
                                  : picked
                                    ? 'border-[#113C36] bg-[#E5F0EA] ring-1 ring-[#113C36]/20'
                                    : elim
                                      ? 'border-[#E5DFD5] bg-[#F3EFE8] opacity-55'
                                      : 'border-[#E5DFD5] bg-white hover:border-[#CFC6B9]'
                            }`}
                          >
                            <div className={`flex items-center justify-between gap-1.5 min-w-0 ${!readOnly ? 'pr-7' : ''}`}>
                              <div className="flex items-center gap-2 min-w-0">
                                <span
                                  className={`w-6 h-6 rounded-full border text-xs font-sans-display font-semibold flex items-center justify-center shrink-0 ${
                                    readOnly && isCorrect
                                      ? 'border-[#1D6346] bg-[#1D6346] text-white'
                                      : isWrongSelected
                                        ? 'border-[#B42318] bg-[#B42318] text-white'
                                        : picked
                                          ? 'border-[#113C36] bg-[#113C36] text-white'
                                          : 'border-[#CFC6B9] text-[#4A5955]'
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
                                {opt.text && (
                                  <span
                                    className={`text-xs font-medium text-[#113C36] truncate ${
                                      elim ? 'line-through text-[#615E57]' : ''
                                    }`}
                                  >
                                    {opt.text}
                                  </span>
                                )}
                              </div>
                              {readOnly && isCorrect && (
                                <span className="text-[10px] font-sans-display font-semibold text-[#1D6346] shrink-0">
                                  {t('ws.correct')}
                                </span>
                              )}
                              {isWrongSelected && (
                                <span className="text-[10px] font-sans-display font-semibold text-[#B42318] shrink-0">
                                  {t('ws.yourPick')}
                                </span>
                              )}
                            </div>

                            {opt.visual && (
                              <div
                                className={`w-full ${tileHeightClass} rounded-[8px] border border-[#EAE4DA] bg-white p-2 flex items-center justify-center overflow-hidden ${
                                  elim ? 'grayscale opacity-65' : ''
                                }`}
                              >
                                <VisualRenderer visual={opt.visual} compact variant="optionTile" />
                              </div>
                            )}
                          </button>

                          {!readOnly && (
                            <button
                              type="button"
                              aria-label={`${t('ws.crossOutOption')} ${opt.key}`}
                              aria-pressed={elim}
                              title={t('ws.crossOutOption')}
                              onClick={() => onToggleEliminate(activePart.partId, opt.key)}
                              className={`absolute top-2 right-2 z-10 w-6 h-6 rounded-[7px] border flex items-center justify-center cursor-pointer transition-tactile ${
                                elim
                                  ? 'border-[#CFC6B9] bg-[#EAE4DA] text-[#113C36]'
                                  : 'border-[#E5DFD5] bg-white/95 text-[#615E57] hover:text-[#113C36]'
                              }`}
                            >
                              <X className="w-3 h-3" />
                            </button>
                          )}

                          {opt.visual &&
                            (opt.visual.visualType === 'image_asset' ||
                              opt.visual.visualType === 'inline_svg') && (
                              <button
                                type="button"
                                aria-label={t('ws.zoomOption', { key: opt.key })}
                                title={t('ws.zoomOption', { key: opt.key })}
                                onClick={() => setZoomedOption({ key: opt.key, visual: opt.visual! })}
                                className="absolute bottom-3.5 right-3.5 z-10 w-6 h-6 rounded-[7px] border border-[#E5DFD5] bg-white/90 hover:bg-white text-[#615E57] hover:text-[#113C36] flex items-center justify-center cursor-pointer transition-tactile"
                              >
                                <Maximize2 className="w-3 h-3" />
                              </button>
                            )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
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
                            className={`flex-1 text-left p-4 rounded-[12px] border transition-colors flex items-center gap-3.5 ${
                              readOnly ? 'cursor-default' : 'cursor-pointer'
                            } ${
                              readOnly && isCorrect
                                ? 'border-[#1D6346] bg-[#E5F3EC]'
                                : isWrongSelected
                                  ? 'border-[#B42318] bg-[#FDECEB]'
                                  : picked
                                    ? 'border-[#113C36] bg-[#E5F0EA]'
                                    : elim
                                      ? 'border-[#E5DFD5] bg-[#F3EFE8] opacity-55'
                                      : 'border-[#E5DFD5] bg-white hover:border-[#CFC6B9]'
                            }`}
                          >
                            <span
                              className={`w-7 h-7 rounded-full border text-xs font-sans-display font-semibold flex items-center justify-center shrink-0 ${
                                readOnly && isCorrect
                                  ? 'border-[#1D6346] bg-[#1D6346] text-white'
                                  : isWrongSelected
                                    ? 'border-[#B42318] bg-[#B42318] text-white'
                                    : picked
                                      ? 'border-[#113C36] bg-[#113C36] text-white'
                                      : 'border-[#CFC6B9] text-[#4A5955]'
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
                                  className={`text-[14px] font-medium text-[#113C36] whitespace-pre-line ${
                                    elim ? 'line-through text-[#615E57]' : ''
                                  }`}
                                >
                                  {opt.text}
                                </div>
                              )}
                              {opt.visual && <VisualRenderer visual={opt.visual} compact />}
                            </div>
                            {readOnly && isCorrect && (
                              <span className="text-[11px] font-sans-display font-semibold text-[#1D6346] shrink-0">
                                {t('ws.correct')}
                              </span>
                            )}
                            {isWrongSelected && (
                              <span className="text-[11px] font-sans-display font-semibold text-[#B42318] shrink-0">
                                {t('ws.yourPick')}
                              </span>
                            )}
                          </button>
                          {!readOnly && (
                            <button
                              type="button"
                              aria-label={`${t('ws.crossOutOption')} ${opt.key}`}
                              aria-pressed={elim}
                              title={t('ws.crossOutOption')}
                              onClick={() => onToggleEliminate(activePart.partId, opt.key)}
                              className={`px-2.5 rounded-[12px] border cursor-pointer transition-tactile ${
                                elim
                                  ? 'border-[#CFC6B9] bg-[#EAE4DA] text-[#113C36]'
                                  : 'border-[#E5DFD5] bg-white text-[#615E57] hover:text-[#113C36]'
                              }`}
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {showReviewBlock && renderReviewAndMetadataBlock()}
          </div>

          {footerNav}
        </section>
      </div>

      {zoomedOption &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            role="presentation"
            className="fixed inset-0 z-50 m-0 bg-[#113C36]/45 backdrop-blur-[2px] flex items-center justify-center p-3 sm:p-6 transition-opacity duration-150 starting:opacity-0"
            onClick={() => setZoomedOption(null)}
          >
            <div
              ref={optionZoomRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="ws-option-zoom-title"
              tabIndex={-1}
              className="max-w-3xl w-full max-h-[calc(100dvh-1.5rem)] overflow-auto bg-white rounded-[16px] border border-[#E5DFD5] p-4 sm:p-5 shadow-xl space-y-3 outline-none transition-[opacity,scale] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] starting:opacity-0 starting:scale-[0.97]"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between">
                <h3 id="ws-option-zoom-title" className="font-sans-display font-semibold text-sm text-[#113C36]">
                  {t('ws.optionHeading', { key: zoomedOption.key })}
                </h3>
                <button
                  type="button"
                  onClick={() => setZoomedOption(null)}
                  aria-label={t('ws.closeOptionZoom')}
                  className="p-1.5 rounded-[8px] hover:bg-[#F3EFE8] text-[#4A5955] cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex items-center justify-center min-h-[200px] max-h-[70vh] overflow-auto">
                <VisualRenderer visual={zoomedOption.visual} />
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
});
