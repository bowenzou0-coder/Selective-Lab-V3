import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Coffee, Play } from 'lucide-react';
import type { SessionSectionState, StudentQuestionView } from '../../../shared/contracts';
import { LanguageToggle, useI18n } from '../../i18n';

interface SectionBreakViewProps {
  sessionTitle: string;
  sectionState: SessionSectionState;
  questions: StudentQuestionView[];
  answersByPartId: Record<string, string | null>;
  writingDraftsByQuestionId: Record<string, { planNotes: string; responseText: string }>;
  writingDraft: { planNotes: string; responseText: string };
  starting: boolean;
  error: string;
  onStartNext: () => void;
}

function formatBreakDuration(totalSec: number): string {
  const safe = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function SectionBreakView({
  sessionTitle,
  sectionState,
  questions,
  answersByPartId,
  writingDraftsByQuestionId,
  writingDraft,
  starting,
  error,
  onStartNext,
}: SectionBreakViewProps) {
  const { t, sectionLabel } = useI18n();
  const [breakElapsedSec, setBreakElapsedSec] = useState<number>(() => {
    if (!sectionState.breakStartedAt) return 0;
    const ms = Date.parse(sectionState.breakStartedAt);
    return Number.isFinite(ms) ? Math.max(0, Math.floor((Date.now() - ms) / 1000)) : 0;
  });

  useEffect(() => {
    const startMs = sectionState.breakStartedAt ? Date.parse(sectionState.breakStartedAt) : Date.now();
    const anchorMs = Number.isFinite(startMs) ? startMs : Date.now();
    const update = () => {
      setBreakElapsedSec(Math.max(0, Math.floor((Date.now() - anchorMs) / 1000)));
    };
    update();
    const id = window.setInterval(update, 1000);
    return () => window.clearInterval(id);
  }, [sectionState.breakStartedAt, sectionState.currentSectionIndex]);

  const currentIdx = sectionState.currentSectionIndex;
  const nextSection = sectionState.sections[currentIdx];
  const prevSection = currentIdx > 0 ? sectionState.sections[currentIdx - 1] : null;

  const prevQuestions = prevSection
    ? questions.slice(prevSection.startIndex, prevSection.endIndex)
    : [];
  const prevAnsweredCount = prevQuestions.filter((q) => {
    if (q.formatType === 'WRIT_TYPED_TASK') {
      const draft = writingDraftsByQuestionId[q.questionId] ?? writingDraft;
      return draft.responseText.trim().length > 0;
    }
    return q.parts.every((p) => Boolean(answersByPartId[p.partId]));
  }).length;

  const nextSectionName = nextSection ? sectionLabel(nextSection.section) : '';
  const nextMinutes = nextSection ? Math.round(nextSection.timeLimitSec / 60) : 40;

  return (
    <div className="min-h-screen flex flex-col bg-[#FAF8F5] text-[#113C36]">
      <header className="sticky top-0 z-30 border-b border-[#E5DFD5] bg-[#F3EFE8]">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 min-h-[48px] py-2 flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex items-center gap-2.5 min-w-0 flex-wrap">
            <span className="font-sans-display font-semibold text-sm text-[#113C36] truncate">
              {sessionTitle}
            </span>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-[#E5F0EA] border border-[#C5DDD1] text-[#1D6346] text-[11px] font-sans-display font-semibold whitespace-nowrap">
              <Coffee className="w-3 h-3 shrink-0" />
              <span>{t('session.breakBadge')}</span>
            </span>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <span className="text-xs text-[#4A5955] tabular-nums whitespace-nowrap">
              {t('session.breakElapsedLabel')}:{' '}
              <strong className="font-exam-clock text-sm text-[#113C36]">
                {formatBreakDuration(breakElapsedSec)}
              </strong>
            </span>
            <LanguageToggle compact />
          </div>
        </div>
      </header>

      <main className="flex-1 px-4 sm:px-6 py-8 sm:py-12">
        <div className="max-w-[740px] mx-auto space-y-6">
          {/* Completion status for the section just finished */}
          {prevSection && (
            <div
              className={`p-4 sm:p-5 rounded-[16px] border flex items-start gap-3 ${
                prevSection.expiredAutoAdvanced
                  ? 'bg-[#FDF0E2] border-[#A35116]/25 text-[#A35116]'
                  : 'bg-[#E5F3EC] border-[#C5DDD1] text-[#113C36]'
              }`}
            >
              {prevSection.expiredAutoAdvanced ? (
                <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
              ) : (
                <CheckCircle2 className="w-5 h-5 text-[#1D6346] shrink-0 mt-0.5" />
              )}
              <div className="space-y-0.5 text-sm">
                <div className="font-sans-display font-semibold">
                  {prevSection.expiredAutoAdvanced
                    ? t('session.breakAutoExpiredNote', { section: sectionLabel(prevSection.section) })
                    : t('session.breakCompletedHeading', { section: sectionLabel(prevSection.section) })}
                </div>
                <div className="text-xs opacity-85 tabular-nums">
                  {t('session.breakAnsweredSummary', {
                    answered: prevAnsweredCount,
                    total: prevQuestions.length,
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Main Break Prompt Card */}
          <section className="rounded-[18px] bg-white border border-[#E5DFD5] p-6 sm:p-8 space-y-6 shadow-[0_1px_3px_rgba(17,60,54,0.03)]">
            <div className="space-y-2">
              <div className="text-xs font-sans-display font-semibold text-[#1D6346]">
                {t('session.sectionOfTotal', {
                  current: currentIdx + 1,
                  total: sectionState.sections.length,
                })}
              </div>
              <h1 className="font-serif-display font-bold text-[26px] sm:text-[30px] leading-[1.2] tracking-[-0.02em] text-[#113C36]">
                {t('session.breakPromptTitle', { section: nextSectionName })}
              </h1>
              <p className="text-[14px] text-[#4A5955] leading-relaxed max-w-[62ch]">
                {t('session.breakPromptBody', {
                  section: nextSectionName,
                  minutes: nextMinutes,
                })}
              </p>
            </div>

            {/* Section Sequence Timeline */}
            <ol className="space-y-2.5">
              {sectionState.sections.map((sec, idx) => {
                const isDone = sec.status === 'completed';
                const isNext = idx === currentIdx;
                const qCount = Math.max(0, sec.endIndex - sec.startIndex);
                const mins = Math.round(sec.timeLimitSec / 60);
                const usedMin = Math.floor((sec.elapsedSec || 0) / 60);
                const usedSec = Math.max(0, (sec.elapsedSec || 0) % 60);

                return (
                  <li
                    key={`${sec.section}_${idx}`}
                    className={`flex flex-wrap items-center justify-between gap-3 px-4 py-3 rounded-[12px] border tabular-nums ${
                      isNext
                        ? 'bg-[#E5F0EA] border-[#C5DDD1]'
                        : isDone
                          ? 'bg-[#FAF8F5] border-[#E5DFD5]'
                          : 'bg-white border-[#EFEAE0]'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span
                        className={`w-7 h-7 rounded-full inline-flex items-center justify-center text-xs font-sans-display font-semibold shrink-0 ${
                          isDone
                            ? 'bg-[#1D6346] text-white'
                            : isNext
                              ? 'bg-[#113C36] text-white'
                              : 'bg-[#F3EFE8] text-[#615E57]'
                        }`}
                      >
                        {isDone ? '✓' : idx + 1}
                      </span>
                      <div className="min-w-0">
                        <div className="font-sans-display font-semibold text-sm text-[#113C36]">
                          {sectionLabel(sec.section)}
                        </div>
                        <div className="text-xs text-[#4A5955]">
                          {t('session.breakTimelineSectionMeta', {
                            count: qCount,
                            minutes: mins,
                          })}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 text-xs shrink-0">
                      {isDone ? (
                        <>
                          <span className="text-[#615E57]">
                            {t('session.breakTimelineElapsed', {
                              minutes: usedMin,
                              seconds: usedSec,
                            })}
                          </span>
                          <span className="px-2.5 py-0.5 rounded-full bg-white border border-[#D4E4DC] text-[#1D6346] font-sans-display font-semibold text-[11px]">
                            {t('session.breakTimelineCompleted')}
                          </span>
                        </>
                      ) : isNext ? (
                        <span className="px-2.5 py-0.5 rounded-full bg-[#113C36] text-white font-sans-display font-semibold text-[11px]">
                          {t('session.breakTimelineUpNext')}
                        </span>
                      ) : (
                        <span className="text-[#615E57] text-[11px] font-medium">
                          {t('session.breakTimelinePending')}
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>

            {error && (
              <p role="alert" className="p-3 rounded-[10px] bg-[#FDECEB] text-[#B42318] text-xs font-medium">
                {error}
              </p>
            )}

            <div className="pt-2 flex flex-wrap items-center justify-between gap-4 border-t border-[#E5DFD5]">
              <div className="text-xs text-[#615E57] tabular-nums">
                {t('session.breakElapsedLabel')}:{' '}
                <span className="font-semibold text-[#113C36]">
                  {formatBreakDuration(breakElapsedSec)}
                </span>
              </div>
              <button
                type="button"
                disabled={starting}
                onClick={onStartNext}
                className="w-full sm:w-auto px-6 py-3 rounded-[12px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-sm font-sans-display font-semibold inline-flex items-center justify-center gap-2 transition-[background-color,transform,translate,scale] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.98] disabled:opacity-60 cursor-pointer"
              >
                <Play className="w-4 h-4 fill-current" />
                <span>
                  {starting
                    ? t('session.breakStarting')
                    : t('session.breakStartNextBtn', {
                        section: nextSectionName,
                        minutes: nextMinutes,
                      })}
                </span>
              </button>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
