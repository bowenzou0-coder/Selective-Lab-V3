import { useMemo, type ReactNode } from 'react';
import { ArrowUpRight, Check, Loader2, Sparkles, Star, X } from 'lucide-react';
import { useI18n } from '../../i18n';
import {
  getWritingCriterionMaxMarks,
  WRITING_BAND_DESCRIPTORS,
  WRITING_MAX_TOTAL_MARKS,
  type StudentQuestionView,
  type WritingEvaluationRecord,
  type WritingExemplarAnnotation,
  type WritingTextAnnotation,
} from '../../../shared/contracts';
import { buildAnnotatedParagraphs } from '../../writingHighlight';
import { WritingStimulusPane } from '../WritingEditor';
import {
  bandBadgeClass,
  legacyEstimateToBand,
  scoreToBand,
  scrollAttrIntoView,
  type AnnotationFilter,
  type WritingReviewEntry,
  type WritingViewMode,
} from './reviewUtils';

interface WritingReviewSectionProps {
  question: StudentQuestionView;
  /** Submission + evaluations for the active writing task (null if none was saved). */
  writingReview: WritingReviewEntry | null;
  viewMode: WritingViewMode;
  annotationFilter: AnnotationFilter;
  onAnnotationFilterChange: (next: AnnotationFilter) => void;
  showInlineMarkers: boolean;
  onShowInlineMarkersChange: (next: boolean) => void;
  selectedAnnotationId: string | null;
  onSelectAnnotation: (id: string | null) => void;
  selectedExemplarAnnId: string | null;
  onSelectExemplarAnn: (id: string | null) => void;
  evaluatingId: string | null;
  evalError: string;
  onEvaluate: (submissionId: string) => void | Promise<void>;
  /** Previous / next item buttons (null for single-task sessions). */
  footerNav: ReactNode;
}

/**
 * Writing task review: annotated essay + rubric critique, the AI exemplar view, and the
 * original prompt. All highlight derivations are memoized per evaluation/filter change.
 */
export function WritingReviewSection({
  question: activeQuestion,
  writingReview: activeWritingReview,
  viewMode: writingViewMode,
  annotationFilter,
  onAnnotationFilterChange: setAnnotationFilter,
  showInlineMarkers,
  onShowInlineMarkersChange: setShowInlineMarkers,
  selectedAnnotationId,
  onSelectAnnotation: setSelectedAnnotationId,
  selectedExemplarAnnId,
  onSelectExemplarAnn: setSelectedExemplarAnnId,
  evaluatingId,
  evalError,
  onEvaluate: handleEvaluateWriting,
  footerNav: writingFooterNav,
}: WritingReviewSectionProps) {
  const { t, skillName } = useI18n();

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

  // Writing review derivations: computed once per evaluation/filter change, not on every render.
  const latestEval = activeWritingReview?.evaluations[0];
  const effectiveAnnotations = useMemo(
    () => getEffectiveAnnotations(latestEval),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [latestEval, skillName]
  );
  const visibleEssayAnnotations = useMemo(
    () =>
      effectiveAnnotations.items.filter((a) => {
        if (annotationFilter === 'strength') return a.kind === 'strength';
        if (annotationFilter === 'fix') return a.kind !== 'strength';
        return true;
      }),
    [effectiveAnnotations, annotationFilter]
  );
  const essayParagraphs = useMemo(
    () => buildAnnotatedParagraphs(activeWritingReview?.responseText ?? '', visibleEssayAnnotations).paragraphs,
    [activeWritingReview?.responseText, visibleEssayAnnotations]
  );
  const exemplarParagraphs = useMemo(
    () =>
      latestEval?.exemplar
        ? buildAnnotatedParagraphs(latestEval.exemplar.text, latestEval.exemplar.annotations).paragraphs
        : [],
    [latestEval]
  );

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
    const visibleAnnotations = visibleEssayAnnotations;
    const annById = new Map(visibleAnnotations.map((a) => [a.id, a]));
    const paragraphs = essayParagraphs;

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
                      className={`rounded-[4px] px-0.5 cursor-pointer transition-colors ${markStyle} ${
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
                      className={`p-3 rounded-[12px] bg-white border space-y-1.5 cursor-pointer transition-[background-color,border-color,box-shadow] duration-150 ${
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
    const paragraphs = exemplarParagraphs;

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
                        className={`rounded-[4px] px-0.5 bg-[#E5F0EA] border-b-2 border-[#113C36] cursor-pointer transition-colors ${
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
                    className={`p-3 rounded-[12px] bg-white border space-y-1.5 cursor-pointer transition-[background-color,border-color,box-shadow] duration-150 ${
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

  const { items: annotations, isLegacy } = effectiveAnnotations;
  if (writingViewMode === 'critique') {
    return (
      <main className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12">
        <section className="lg:col-span-6 bg-white border-b lg:border-b-0 lg:border-r border-[#E5DFD5] p-5 lg:p-6 lg:h-full lg:overflow-y-auto">
          {renderAnnotatedEssayPane(activeWritingReview, annotations)}
        </section>
        <section className="lg:col-span-6 bg-[#FAF8F5] p-5 lg:p-6 lg:h-full lg:overflow-y-auto">
          {renderCritiquePanel(activeWritingReview, activeQuestion, latestEval, annotations, isLegacy)}
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
}
