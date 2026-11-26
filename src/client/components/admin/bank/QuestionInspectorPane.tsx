import { memo, useEffect, useState, type ChangeEvent, type ReactNode, type Ref } from 'react';
import { Archive, BookOpen, CheckCircle2, Eye, History, KeyRound, PauseCircle, Trash2, Upload } from 'lucide-react';
import {
  qcStatusToPoolStatus,
  type BankPoolStatus,
  type QuestionProgressMeta,
} from '../../../../shared/bankStatus';
import type { EvidenceCitationRef, QuestionItem, StimulusGroup } from '../../../../shared/contracts';
import { api } from '../../../api';
import { Skeleton } from '../../ui/Skeleton';
import { useI18n } from '../../../i18n';
import { FormattedText } from '../../FormattedText';
import { QuestionWorkspace } from '../../QuestionWorkspace';
import { TabList, TabPanel, useTabsBaseId } from '../../ui/Tabs';
import { completionBadgeClasses } from './BankQuestionList';

type InspectorTab = 'preview' | 'answers' | 'history';

interface QuestionInspectorPaneProps {
  question: QuestionItem;
  stimulus?: StimulusGroup;
  progress?: QuestionProgressMeta;
  includeHistorical: boolean;
  knownVersions?: QuestionItem[];
  statusBusy: boolean;
  onSetPoolStatus: (status: BankPoolStatus) => void;
  deleting: boolean;
  onDelete: () => void;
  uploading: boolean;
  onUploadVisual: (e: ChangeEvent<HTMLInputElement>) => void;
  ref?: Ref<HTMLElement>;
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,6.5rem)_1fr] gap-3 py-1.5 sm:grid-cols-[8.5rem_1fr]">
      <dt className="text-[#615E57]">{label}</dt>
      <dd className="min-w-0 break-words text-[#113C36]">{children}</dd>
    </div>
  );
}

function AnswerKeyTab({
  question,
  onShowEvidence,
}: {
  question: QuestionItem;
  onShowEvidence: (ref: EvidenceCitationRef) => void;
}) {
  const { t, skillName, sectionLabel, formatLabel, formatDate } = useI18n();
  const isWriting = question.formatType === 'WRIT_TYPED_TASK';
  return (
    <div className="space-y-5 text-xs">
      <ol className="space-y-3">
        {question.parts.map((part, idx) => (
          <li key={part.partId} className="space-y-2 rounded-[12px] border border-[#E5DFD5] bg-[#FAF8F5] p-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-sans-display font-semibold text-[#113C36]">
                {question.parts.length > 1 ? t('ws.partLabel', { num: idx + 1 }) : t('ws.answerKeyLabel')}
              </span>
              <span className="rounded bg-[#E5F0EA] px-1.5 py-0.5 font-mono-code text-[#113C36]">
                {part.correctAnswerKey || t('bank.writingRubricBadge')}
              </span>
              <span className="text-[#4A5955]">{skillName(part.skillId)}</span>
              <span className="ml-auto flex gap-2 tabular-nums text-[#615E57]">
                <span>{t('bank.partDifficulty', { value: part.difficultyCalibrated ?? part.difficultyInitial })}</span>
                <span>{t('bank.partTargetTime', { sec: part.targetTimeSec })}</span>
              </span>
            </div>
            {part.workedExplanation ? (
              <FormattedText text={part.workedExplanation} variant="explanation" className="break-words" />
            ) : (
              !isWriting && <p className="text-[#B83A28]">{t('bank.noExplanation')}</p>
            )}
            {part.distractorRationales && Object.keys(part.distractorRationales).length > 0 && (
              <div className="space-y-1 border-t border-[#E5DFD5] pt-2">
                <div className="font-medium text-[#4A5955]">{t('bank.distractorsTitle')}</div>
                <ul className="space-y-1">
                  {Object.entries(part.distractorRationales).map(([key, note]) => (
                    <li key={key} className="whitespace-pre-line text-[#4A5955]">
                      <span className="mr-1.5 font-mono-code font-semibold text-[#113C36]">{key}</span>
                      {note}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {(part.trapTags?.length || part.evidenceRefs?.length) ? (
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                {part.trapTags?.map((tag) => (
                  <span key={tag} className="rounded-full bg-[#F3EFE8] px-2 py-0.5 text-[11px] text-[#4A5955]">
                    {tag}
                  </span>
                ))}
                {part.evidenceRefs?.map((ref) => (
                  <button
                    key={ref.refId}
                    type="button"
                    onClick={() => onShowEvidence(ref)}
                    className="inline-flex cursor-pointer items-center gap-1 rounded-[8px] border border-[#CFC6B9] bg-white px-2 py-0.5 text-[11px] font-medium text-[#113C36] hover:bg-[#F3EFE8]"
                  >
                    <BookOpen className="h-3 w-3" />
                    <span>{t('ws.evidenceBadge', { id: ref.refId })}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </li>
        ))}
      </ol>

      <section>
        <h4 className="mb-1 font-sans-display font-semibold text-[#113C36]">{t('bank.metadataTitle')}</h4>
        <dl className="divide-y divide-[#F2EDE4]">
          <MetaRow label={t('bank.metaFamily')}>
            <span className="font-mono-code">{question.questionFamilyId}</span>
          </MetaRow>
          <MetaRow label={t('bank.metaSection')}>
            {sectionLabel(question.section)} · {formatLabel(question.formatType)}
          </MetaRow>
          <MetaRow label={t('bank.metaPoolType')}>
            {question.poolType} · {question.qcStatus}
          </MetaRow>
          {question.stimulusId && (
            <MetaRow label={t('bank.metaStimulus')}>
              <span className="font-mono-code">{question.stimulusId}</span>
            </MetaRow>
          )}
          {question.batchLabel && <MetaRow label={t('bank.metaBatch')}>{question.batchLabel}</MetaRow>}
          <MetaRow label={t('bank.metaSource')}>
            {question.provenance?.sourceType}
            {question.provenance?.sourceReference ? ` · ${question.provenance.sourceReference}` : ''}
          </MetaRow>
          <MetaRow label={t('bank.metaUpdated')}>
            {formatDate(question.updatedAtIso || question.createdAtIso, true)}
          </MetaRow>
          {question.evidenceRevision && (
            <MetaRow label={t('bank.metaEvidenceRevision')}>
              <span className="font-mono-code">{question.evidenceRevision}</span>
            </MetaRow>
          )}
        </dl>
      </section>
    </div>
  );
}

/** Right-hand inspector: student-accurate preview, full answer key, and history/actions. */
export const QuestionInspectorPane = memo(function QuestionInspectorPane({
  question,
  stimulus,
  progress,
  includeHistorical,
  knownVersions,
  statusBusy,
  onSetPoolStatus,
  deleting,
  onDelete,
  uploading,
  onUploadVisual,
  ref,
}: QuestionInspectorPaneProps) {
  const { t, poolStatusLabel, completionStatusLabel, formatDate } = useI18n();
  const baseId = useTabsBaseId();
  const [tab, setTab] = useState<InspectorTab>('preview');
  const [history, setHistory] = useState<{ question: QuestionItem; versions: QuestionItem[] } | null>(null);
  const versions = knownVersions ?? (history?.question === question ? history.versions : undefined);
  const needsVersions = question.version > 1 || includeHistorical;
  useEffect(() => {
    if (tab !== 'history' || !needsVersions || versions) return;
    let active = true;
    api.getQuestionVersions(question.questionId).then(
      (res) => {
        if (active) setHistory({ question, versions: res.versions.map((v) => v.question) });
      },
      () => {
        if (active) setHistory({ question, versions: [] });
      }
    );
    return () => { active = false; };
  }, [tab, needsVersions, versions, question]);
  const [evidenceRef, setEvidenceRef] = useState<EvidenceCitationRef | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [shownQid, setShownQid] = useState(question.questionId);
  if (shownQid !== question.questionId) {
    // New question: reset transient inspector state during render (no effect flash).
    setShownQid(question.questionId);
    setEvidenceRef(null);
    setConfirmDelete(false);
  }
  const pool = qcStatusToPoolStatus(question.qcStatus);
  const completion = progress?.completionStatus ?? 'unseen';

  return (
    <section
      ref={ref}
      aria-label={question.questionId}
      className="min-w-0 scroll-mt-4 space-y-4 rounded-[16px] border border-[#E5DFD5] bg-white p-4 sm:p-5 xl:sticky xl:top-4 xl:max-h-[calc(100dvh-2rem)] xl:overflow-y-auto xl:overscroll-contain"
    >
      <header className="space-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 className="break-all font-mono-code text-sm font-semibold text-[#113C36]">{question.questionId}</h3>
          <span className="whitespace-nowrap rounded-full bg-[#F3EFE8] px-2 py-0.5 text-[11px] font-medium text-[#4A5955]">
            v{question.version}
          </span>
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${completionBadgeClasses(completion)}`}>
            {completionStatusLabel(completion)}
          </span>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#615E57]">
          <span>
            {t('bank.attemptsMeta')} <span className="tabular-nums text-[#113C36]">{progress?.attemptsCount ?? 0}</span>
          </span>
          <span>
            {t('bank.lastSeenMeta')}{' '}
            <span className="text-[#113C36]">
              {progress?.lastAttemptAtIso ? formatDate(progress.lastAttemptAtIso) : t('bank.never')}
            </span>
          </span>
        </div>
      </header>

      <TabList
        baseId={baseId}
        ariaLabel={t('bank.inspectorTabsAria')}
        value={tab}
        onValueChange={setTab}
        items={[
          { id: 'preview', label: t('bank.tabPreview'), icon: <Eye className="h-3.5 w-3.5" /> },
          { id: 'answers', label: t('bank.tabAnswerKey'), icon: <KeyRound className="h-3.5 w-3.5" /> },
          { id: 'history', label: t('bank.tabHistory'), icon: <History className="h-3.5 w-3.5" /> },
        ]}
      />

      <TabPanel baseId={baseId} id="preview" active={tab === 'preview'}>
        <QuestionWorkspace
          mode="adminPreview"
          question={question}
          stimulus={stimulus}
          activeEvidenceRef={evidenceRef}
          onSelectEvidenceRef={setEvidenceRef}
          showReviewBlock={false}
          embedded
        />
      </TabPanel>

      <TabPanel baseId={baseId} id="answers" active={tab === 'answers'}>
        <AnswerKeyTab
          question={question}
          onShowEvidence={(evidence) => {
            setEvidenceRef(evidence);
            setTab('preview');
          }}
        />
      </TabPanel>

      <TabPanel baseId={baseId} id="history" active={tab === 'history'} className="space-y-5 text-xs">
        <section className="space-y-2">
          <h4 className="font-sans-display font-semibold text-[#113C36]">{t('bank.poolStatusTitle')}</h4>
          <div
            role="group"
            aria-label={t('bank.poolStatusTitle')}
            aria-busy={statusBusy}
            className="inline-flex flex-wrap items-center gap-0.5 rounded-[11px] border border-[#E5DFD5] bg-[#F3EFE8] p-0.5"
          >
            {(['live', 'paused', 'archived'] as BankPoolStatus[]).map((st) => {
              const active = pool === st;
              return (
                <button
                  key={st}
                  type="button"
                  aria-pressed={active}
                  disabled={statusBusy}
                  onClick={() => onSetPoolStatus(st)}
                  className={`inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[9px] px-2.5 py-1.5 font-sans-display font-semibold transition-tactile disabled:opacity-60 ${
                    active ? 'bg-[#113C36] text-white' : 'text-[#4A5955] hover:bg-white hover:text-[#113C36]'
                  }`}
                >
                  {st === 'live' && <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />}
                  {st === 'paused' && <PauseCircle className="h-3.5 w-3.5 shrink-0" />}
                  {st === 'archived' && <Archive className="h-3.5 w-3.5 shrink-0" />}
                  <span>{poolStatusLabel(st)}</span>
                </button>
              );
            })}
          </div>
          {statusBusy && <p className="text-[#615E57]">{t('bank.savingPoolStatus')}</p>}
        </section>

        <section className="space-y-2">
          <h4 className="font-sans-display font-semibold text-[#113C36]">{t('bank.diagramTitle')}</h4>
          <label className="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[10px] border border-[#CFC6B9] bg-white px-3 py-1.5 font-sans-display font-semibold text-[#113C36] transition-tactile hover:bg-[#FAF8F5]">
            <Upload className="h-3.5 w-3.5 shrink-0" />
            <span>{uploading ? t('bank.uploading') : t('bank.attachDiagram')}</span>
            <input type="file" accept="image/*" className="sr-only" disabled={uploading} onChange={onUploadVisual} />
          </label>
        </section>

        <section className="space-y-2">
          <h4 className="font-sans-display font-semibold text-[#113C36]">{t('bank.versionHistoryTitle')}</h4>
          {needsVersions && !versions ? (
            <Skeleton className="h-8 w-full" />
          ) : !versions || versions.length <= 1 ? (
            <p className="text-[#615E57]">{t('bank.singleVersion')}</p>
          ) : (
            <ol className="divide-y divide-[#F2EDE4] rounded-[12px] border border-[#E5DFD5]">
              {versions.map((v) => (
                <li key={v.questionId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <span className="font-mono-code text-[#113C36]">
                    v{v.version} · {v.questionId}
                  </span>
                  <span className="flex items-center gap-2 text-[#615E57]">
                    <span>{formatDate(v.updatedAtIso || v.createdAtIso)}</span>
                    {v.questionId === question.questionId && (
                      <span className="rounded-full bg-[#E5F0EA] px-2 py-0.5 text-[11px] font-medium text-[#113C36]">
                        {t('bank.versionCurrent')}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="space-y-2 rounded-[12px] border border-[#B83A28]/20 bg-[#FDECEB]/40 p-3.5">
          <h4 className="font-sans-display font-semibold text-[#B83A28]">{t('bank.dangerZoneTitle')}</h4>
          <p className="leading-relaxed text-[#4A5955]">{t('bank.dangerZoneBody')}</p>
          {confirmDelete ? (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={deleting}
                onClick={onDelete}
                className="cursor-pointer whitespace-nowrap rounded-[8px] bg-[#B83A28] px-3 py-1.5 font-sans-display font-semibold text-white hover:bg-[#992D1E] disabled:opacity-50"
              >
                {deleting ? t('bank.deleting') : t('bank.confirmDeleteSingle')}
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={() => setConfirmDelete(false)}
                className="cursor-pointer px-2 py-1.5 font-medium text-[#4A5955] hover:text-[#113C36]"
              >
                {t('home.modalCancel')}
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={deleting || statusBusy}
              onClick={() => setConfirmDelete(true)}
              className="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[9px] border border-[#B83A28]/25 bg-white px-2.5 py-1.5 font-sans-display font-semibold text-[#B83A28] transition-tactile hover:bg-[#FDECEB] disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5 shrink-0" />
              <span>{t('bank.deletePermanently')}</span>
            </button>
          )}
        </section>
      </TabPanel>
    </section>
  );
});
