import { useState } from 'react';
import { Flag } from 'lucide-react';
import { api } from '../../api';
import { useI18n } from '../../i18n';

/** Report-an-issue state for the review screen; lives in the parent so it survives filter changes. */
export function useQuestionFlagging(sessionId: string) {
  const { t } = useI18n();
  const [flaggingQid, setFlaggingQid] = useState<string | null>(null);
  const [reason, setReason] = useState('Unclear wording or diagram');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [flaggedIds, setFlaggedIds] = useState<Set<string>>(new Set());

  const toggle = (questionId: string) =>
    setFlaggingQid(flaggingQid === questionId ? null : questionId);

  const submit = async (questionId: string) => {
    setBusy(true);
    setError('');
    try {
      await api.flagQuestion({ questionId, sessionId, reason, notes });
      setFlaggedIds((prev) => new Set(prev).add(questionId));
      setFlaggingQid(null);
      setNotes('');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('rev.flagError'));
    } finally {
      setBusy(false);
    }
  };

  return { flaggingQid, toggle, reason, setReason, notes, setNotes, busy, error, flaggedIds, submit };
}

export type QuestionFlagging = ReturnType<typeof useQuestionFlagging>;

interface FlagProps {
  flagging: QuestionFlagging;
  questionId: string;
}

/** "Report issue" trigger, or the flagged confirmation once a report was sent. */
export function FlagQuestionButton({ flagging, questionId }: FlagProps) {
  const { t } = useI18n();
  if (flagging.flaggedIds.has(questionId)) {
    return <span className="text-xs font-medium text-[#A35116]">{t('rev.flaggedForReview')}</span>;
  }
  return (
    <button
      type="button"
      onClick={() => flagging.toggle(questionId)}
      className="inline-flex items-center gap-1.5 text-xs font-medium text-[#4A5955] hover:text-[#113C36] cursor-pointer whitespace-nowrap"
    >
      <Flag className="w-3.5 h-3.5" />
      <span>{t('rev.reportIssue')}</span>
    </button>
  );
}

/** Inline report form (reason + note) shown under the item strip while flagging. */
export function FlagQuestionModal({ flagging, questionId }: FlagProps) {
  const { t } = useI18n();
  if (flagging.flaggingQid !== questionId) return null;
  return (
    <div className="max-w-[1440px] mx-auto mt-2 p-3 rounded-[10px] bg-white border border-[#E5DFD5] flex flex-wrap gap-2">
      <select
        aria-label={t('rev.reportIssue')}
        value={flagging.reason}
        onChange={(e) => flagging.setReason(e.target.value)}
        className="px-2.5 py-1.5 rounded-[8px] border border-[#CFC6B9] bg-[#FAF8F5] text-xs"
      >
        <option value="Unclear wording or diagram">{t('rev.flagReason1')}</option>
        <option value="Answer key seems incorrect">{t('rev.flagReason2')}</option>
        <option value="Formatting / display issue">{t('rev.flagReason3')}</option>
      </select>
      <input
        type="text"
        value={flagging.notes}
        onChange={(e) => flagging.setNotes(e.target.value)}
        placeholder={t('rev.flagNotePlaceholder')}
        className="flex-1 min-w-48 px-2.5 py-1.5 rounded-[8px] border border-[#CFC6B9] bg-[#FAF8F5] text-xs"
      />
      <button
        type="button"
        disabled={flagging.busy}
        onClick={() => flagging.submit(questionId)}
        className="px-3.5 py-1.5 rounded-[8px] bg-[#113C36] text-white text-xs font-sans-display font-semibold cursor-pointer whitespace-nowrap disabled:opacity-50"
      >
        {flagging.busy ? '...' : t('rev.submitReport')}
      </button>
      {flagging.error && (
        <p role="alert" className="w-full text-xs text-[#B42318]">
          {flagging.error}
        </p>
      )}
    </div>
  );
}
