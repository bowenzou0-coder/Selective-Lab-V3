import { useId, useMemo, useState } from 'react';
import { useI18n } from '../../i18n';
import {
  compareEssays,
  formatSignedDelta,
  pickComparisonPair,
  sortEssaysNewestFirst,
  type ComparableEssay,
  type EssayScore,
} from './writingInsights';

interface EssayComparisonProps<T extends ComparableEssay & { sessionId: string }> {
  essays: readonly T[];
  onOpenSession: (sessionId: string) => void;
}

function deltaTone(delta: number | null): string {
  if (delta === null || delta === 0) return 'text-[#4A5955]';
  return delta > 0 ? 'text-[#1D6346]' : 'text-[#A35116]';
}

/** Two essays side by side (stacked on mobile): prompt, words, rubric marks and the text itself. */
export function EssayComparison<T extends ComparableEssay & { sessionId: string }>({
  essays,
  onOpenSession,
}: EssayComparisonProps<T>) {
  const { t, formatDate, skillName } = useI18n();
  const selectId = useId();
  const ordered = useMemo(() => sortEssaysNewestFirst(essays), [essays]);
  const [currentId, setCurrentId] = useState<string>(() => ordered[0]?.submissionId ?? '');
  const pair = useMemo(() => pickComparisonPair(ordered, currentId), [ordered, currentId]);
  const comparison = useMemo(() => (pair ? compareEssays(pair.current, pair.previous) : null), [pair]);
  if (!pair || !comparison) return null;

  const titleOf = (essay: T) => essay.promptTitle || t('prog.untitledPrompt');
  const scoreChip = (score: EssayScore | null) =>
    score ? (
      <span className="px-2.5 py-0.5 rounded-full bg-[#E5F0EA] text-[#113C36] font-sans-display font-semibold">
        {t('rev.bandWithLetter', { band: score.band })} ({score.marks}/{score.maxMarks})
      </span>
    ) : (
      <span className="px-2.5 py-0.5 rounded-full bg-[#F3EFE8] text-[#615E57] font-medium">{t('prog.compareNotMarked')}</span>
    );

  const column = (essay: T, heading: string, score: EssayScore | null, emphasis: boolean) => (
    <article
      className={`min-w-0 p-5 rounded-[14px] border space-y-3 ${
        emphasis ? 'border-[#C5DDD1] bg-white' : 'border-[#E5DFD5] bg-[#FAF8F5]'
      }`}
    >
      <header className="space-y-1">
        <div className="text-xs font-sans-display font-semibold text-[#4A5955]">{heading}</div>
        <h3 className="font-sans-display font-semibold text-[15px] text-[#113C36] break-words">{titleOf(essay)}</h3>
        <div className="flex flex-wrap items-center gap-2 text-xs text-[#4A5955] tabular-nums">
          <span>{formatDate(essay.submittedAt, true)}</span>
          <span className="px-2 py-0.5 rounded-full bg-white border border-[#E5DFD5]">
            {t('rev.wordsCount', { count: essay.wordCount })}
          </span>
          {scoreChip(score)}
        </div>
      </header>
      <p
        tabIndex={0}
        aria-label={heading}
        className="font-serif-text text-[15px] leading-[1.7] text-[#113C36] whitespace-pre-line break-words max-h-[16rem] sm:max-h-[22rem] overflow-y-auto overscroll-contain rounded-[6px] pr-1"
      >
        {essay.responseText}
      </p>
      <button
        type="button"
        onClick={() => onOpenSession(essay.sessionId)}
        className="px-3 py-1 rounded-[8px] border border-[#CFC6B9] bg-white hover:bg-[#F3EFE8] text-xs text-[#113C36] font-sans-display font-semibold cursor-pointer transition-tactile"
      >
        {t('prog.openReview')}
      </button>
    </article>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label htmlFor={selectId} className="font-sans-display font-semibold text-[#4A5955]">
          {t('prog.compareSelect')}
        </label>
        <select
          id={selectId}
          value={pair.current.submissionId}
          onChange={(e) => setCurrentId(e.target.value)}
          className="min-w-0 max-w-full px-2.5 py-1.5 rounded-[8px] border border-[#CFC6B9] bg-white text-[#113C36] cursor-pointer"
        >
          {ordered.slice(0, -1).map((essay) => (
            <option key={essay.submissionId} value={essay.submissionId}>
              {t('prog.compareOption', { date: formatDate(essay.submittedAt), title: titleOf(essay) })}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs tabular-nums">
        <span className="text-[#4A5955]">
          {t('prog.compareWordDelta', { delta: formatSignedDelta(comparison.wordDelta) })}
        </span>
        {comparison.marksDelta !== null && (
          <span className={`font-medium ${deltaTone(comparison.marksDelta)}`}>
            {t('prog.compareMarksDelta', { delta: formatSignedDelta(comparison.marksDelta) })}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        {column(pair.previous, t('prog.comparePrevious'), comparison.previousScore, false)}
        {column(pair.current, t('prog.compareThisEssay'), comparison.currentScore, true)}
      </div>

      <div className="space-y-2">
        <h3 className="text-xs font-sans-display font-semibold text-[#4A5955]">{t('prog.compareRubricTitle')}</h3>
        {comparison.criteria.length === 0 ? (
          <p className="text-xs text-[#615E57]">{t('prog.compareNoRubric')}</p>
        ) : (
          <div className="scroll-x border border-[#E5DFD5] rounded-[12px] bg-white">
            <table className="w-full text-xs text-left tabular-nums">
              <thead className="bg-[#F3EFE8]/70 border-b border-[#E5DFD5] text-[#4A5955]">
                <tr>
                  <th className="px-4 py-2.5 font-sans-display font-semibold">{t('prog.compareColCriterion')}</th>
                  <th className="px-3 py-2.5 font-sans-display font-semibold">{t('prog.comparePrevious')}</th>
                  <th className="px-3 py-2.5 font-sans-display font-semibold">{t('prog.compareThisEssay')}</th>
                  <th className="px-3 py-2.5 font-sans-display font-semibold">{t('prog.compareColChange')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E5DFD5]">
                {comparison.criteria.map((row) => (
                  <tr key={row.skillId}>
                    <td className="px-4 py-2.5 text-[#113C36] font-medium">{skillName(row.skillId)}</td>
                    <td className="px-3 py-2.5 text-[#4A5955]">{row.previous !== null ? `${row.previous}/${row.max}` : '—'}</td>
                    <td className="px-3 py-2.5 text-[#113C36]">{row.current !== null ? `${row.current}/${row.max}` : '—'}</td>
                    <td className={`px-3 py-2.5 font-medium ${deltaTone(row.delta)}`}>
                      {row.delta !== null ? formatSignedDelta(row.delta) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
