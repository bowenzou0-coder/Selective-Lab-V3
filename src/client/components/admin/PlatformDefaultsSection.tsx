import { useState, type Dispatch, type SetStateAction } from 'react';
import { ChevronDown, ChevronUp, Save, Sparkles } from 'lucide-react';
import { useI18n } from '../../i18n';
import {
  DEFAULT_AUTO_CALIBRATE,
  DEFAULT_POOL_POLICY,
  type LearningConfig,
  type SectionCode,
} from '../../../shared/contracts';
import { NumericInput } from '../ui/NumericInput';

export interface ConfigVersionSummary {
  configVersionId: string;
  versionNumber: number;
  notes?: string;
  createdAt: string;
}

interface PlatformDefaultsSectionProps {
  config: LearningConfig;
  setConfig: Dispatch<SetStateAction<LearningConfig>>;
  globalDirty: boolean;
  versionNumber: number;
  history: ConfigVersionSummary[];
  notes: string;
  onChangeNotes: (notes: string) => void;
  savingGlobal: boolean;
  onSave: () => void;
  onDiscard: () => void;
}

/** Platform-wide daily plan defaults, pool policy, advanced scheduling weights and the save bar. */
export function PlatformDefaultsSection({
  config,
  setConfig,
  globalDirty,
  versionNumber,
  history,
  notes,
  onChangeNotes,
  savingGlobal,
  onSave,
  onDiscard,
}: PlatformDefaultsSectionProps) {
  const { t, sectionShortLabel, formatDate } = useI18n();
  const [showAdvanced, setShowAdvanced] = useState(false);

  const autoCal = config.autoCalibrate ?? DEFAULT_AUTO_CALIBRATE;
  const poolPolicy = config.poolPolicy ?? DEFAULT_POOL_POLICY;

  const updateGlobalAuto = (patch: Partial<typeof autoCal>) => {
    setConfig((prev) => {
      const merged = { ...(prev.autoCalibrate ?? DEFAULT_AUTO_CALIBRATE), ...patch };
      if (merged.minDailyQuestions > merged.maxDailyQuestions) {
        merged.maxDailyQuestions = merged.minDailyQuestions;
      }
      return { ...prev, autoCalibrate: merged };
    });
  };

  const updateGlobalDailyLimit = (section: SectionCode, value: number) => {
    setConfig((prev) => ({
      ...prev,
      sessionDefaults: {
        ...prev.sessionDefaults,
        dailyQuestionLimitBySection: {
          ...prev.sessionDefaults.dailyQuestionLimitBySection,
          [section]: value,
        },
      },
    }));
  };

  const globalManualTotal =
    (config.sessionDefaults.dailyQuestionLimitBySection.READ || 0) +
    (config.sessionDefaults.dailyQuestionLimitBySection.MATH || 0) +
    (config.sessionDefaults.dailyQuestionLimitBySection.THINK || 0) +
    (config.sessionDefaults.dailyQuestionLimitBySection.WRIT || 0);

  return (
    <div className="space-y-5 pt-2 border-t border-[#E5DFD5]">
      <div className="space-y-1">
        <h2 className="font-sans-display font-semibold text-[18px] text-[#113C36]">
          {t('admin.platformDefaultsTitle')}
        </h2>
        <p className="text-xs text-[#4A5955]">{t('admin.platformDefaultsSub')}</p>
      </div>

      {/* Platform Default Daily Plan & Drills */}
      <section className="rounded-[16px] bg-white border border-[#E5DFD5] p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-[#113C36]" />
            <h3 className="font-sans-display font-semibold text-[15px] text-[#113C36]">
              {t('cfg.title')}
            </h3>
            <span className="px-2.5 py-0.5 rounded-full bg-[#F3EFE8] text-[11px] font-medium text-[#4A5955]">
              {t('cfg.sharedRulesBadge')}
            </span>
          </div>
          <div className="inline-flex items-center p-1 rounded-[12px] bg-[#FAF8F5] border border-[#CFC6B9] gap-1">
            <button
              type="button"
              aria-pressed={autoCal.enabled}
              onClick={() => updateGlobalAuto({ enabled: true })}
              className={`px-3 py-1 rounded-[8px] text-xs font-sans-display font-semibold cursor-pointer ${
                autoCal.enabled ? 'bg-[#113C36] text-white' : 'text-[#4A5955]'
              }`}
            >
              {t('cfg.modeAuto')}
            </button>
            <button
              type="button"
              aria-pressed={!autoCal.enabled}
              onClick={() => updateGlobalAuto({ enabled: false })}
              className={`px-3 py-1 rounded-[8px] text-xs font-sans-display font-semibold cursor-pointer ${
                !autoCal.enabled ? 'bg-[#113C36] text-white' : 'text-[#4A5955]'
              }`}
            >
              {t('cfg.modeManual')}
            </button>
          </div>
        </div>

        {autoCal.enabled ? (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
            <div className="space-y-1">
              <label htmlFor="ac-min-q" className="block text-xs font-medium text-[#4A5955]">
                {t('cfg.minDailyQ')}
              </label>
              <NumericInput
                id="ac-min-q"
                showRange
                stepper
                label={t('cfg.minDailyQ')}
                value={autoCal.minDailyQuestions}
                min={3}
                max={30}
                onCommit={(v) => updateGlobalAuto({ minDailyQuestions: v })}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="ac-max-q" className="block text-xs font-medium text-[#4A5955]">
                {t('cfg.maxDailyQ')}
              </label>
              <NumericInput
                id="ac-max-q"
                showRange
                stepper
                label={t('cfg.maxDailyQ')}
                value={autoCal.maxDailyQuestions}
                min={autoCal.minDailyQuestions}
                max={40}
                onCommit={(v) => updateGlobalAuto({ maxDailyQuestions: v })}
              />
            </div>
            <div className="flex flex-col justify-end pb-1">
              <label className="inline-flex items-center gap-2 text-xs text-[#4A5955] cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoCal.includeWriting}
                  onChange={(e) => updateGlobalAuto({ includeWriting: e.target.checked })}
                  className="accent-[#113C36]"
                />
                <span>{t('cfg.includeWriting')}</span>
              </label>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-[#4A5955]">{t('cfg.manualDesc')}</p>
              <span className="px-2.5 py-0.5 rounded-full bg-[#F3EFE8] text-xs font-medium text-[#113C36] tabular-nums">
                {t('cfg.questionsPerDay', { count: globalManualTotal })}
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              {(['READ', 'MATH', 'THINK', 'WRIT'] as SectionCode[]).map((sec) => (
                <div key={sec} className="space-y-1">
                  <label htmlFor={`manual-${sec}`} className="block text-xs font-medium text-[#4A5955]">
                    {t('cfg.sectionPerDay', { section: sectionShortLabel(sec) })}
                  </label>
                  <NumericInput
                    id={`manual-${sec}`}
                    showRange
                    stepper
                    label={t('cfg.sectionPerDay', { section: sectionShortLabel(sec) })}
                    value={config.sessionDefaults.dailyQuestionLimitBySection[sec]}
                    min={0}
                    max={sec === 'WRIT' ? 2 : 30}
                    onCommit={(v) => updateGlobalDailyLimit(sec, v)}
                  />
                </div>
              ))}
              <div className="space-y-1">
                <label htmlFor="manual-goal-min" className="block text-xs font-medium text-[#4A5955]">
                  {t('cfg.dailyGoalMin')}
                </label>
                <NumericInput
                  id="manual-goal-min"
                  showRange
                  stepper
                  label={t('cfg.dailyGoalMin')}
                  value={config.sessionDefaults.dailyGoalMinutes}
                  min={5}
                  max={120}
                  onCommit={(v) =>
                    setConfig((prev) => ({
                      ...prev,
                      sessionDefaults: { ...prev.sessionDefaults, dailyGoalMinutes: v },
                    }))
                  }
                />
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 pt-3 border-t border-[#E5DFD5]">
          <div className="space-y-1">
            <label htmlFor="drill-count" className="block text-xs font-medium text-[#4A5955]">
              {t('cfg.drillCountLabel')}
            </label>
            <NumericInput
              id="drill-count"
              showRange
              stepper
              label={t('cfg.drillCountLabel')}
              value={config.sessionDefaults.sectionDrillQuestionCount}
              min={3}
              max={40}
              onCommit={(v) =>
                setConfig((prev) => ({
                  ...prev,
                  sessionDefaults: { ...prev.sessionDefaults, sectionDrillQuestionCount: v },
                }))
              }
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="drill-minutes" className="block text-xs font-medium text-[#4A5955]">
              {t('cfg.drillMinutesLabel')}
            </label>
            <NumericInput
              id="drill-minutes"
              showRange
              stepper
              label={t('cfg.drillMinutesLabel')}
              value={config.sessionDefaults.sectionDrillTimeMinutes}
              min={3}
              max={60}
              onCommit={(v) =>
                setConfig((prev) => ({
                  ...prev,
                  sessionDefaults: { ...prev.sessionDefaults, sectionDrillTimeMinutes: v },
                }))
              }
            />
          </div>
        </div>
      </section>

      {/* Completed Questions & Spaced Repetition Policy (Admin-Only) */}
      <section className="rounded-[16px] bg-white border border-[#E5DFD5] p-6 space-y-4">
        <div className="space-y-0.5">
          <h3 className="font-sans-display font-semibold text-[15px] text-[#113C36]">
            {t('cfg.poolPolicyTitle')}
          </h3>
          <p className="text-xs text-[#4A5955]">{t('cfg.poolPolicyDesc')}</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() =>
              setConfig((prev) => ({ ...prev, poolPolicy: { autoRetireMastered: false } }))
            }
            className={`p-4 rounded-[12px] border text-left space-y-1 cursor-pointer transition-colors ${
              !poolPolicy.autoRetireMastered
                ? 'bg-[#E5F0EA] border-[#113C36] text-[#113C36]'
                : 'bg-[#FAF8F5] border-[#E5DFD5] text-[#4A5955]'
            }`}
          >
            <div className="font-sans-display font-semibold text-sm text-[#113C36]">
              {t('cfg.keepMasteredTitle')}
            </div>
            <p className="text-xs text-[#4A5955]">{t('cfg.keepMasteredDesc')}</p>
          </button>

          <button
            type="button"
            onClick={() =>
              setConfig((prev) => ({ ...prev, poolPolicy: { autoRetireMastered: true } }))
            }
            className={`p-4 rounded-[12px] border text-left space-y-1 cursor-pointer transition-colors ${
              poolPolicy.autoRetireMastered
                ? 'bg-[#E5F0EA] border-[#113C36] text-[#113C36]'
                : 'bg-[#FAF8F5] border-[#E5DFD5] text-[#4A5955]'
            }`}
          >
            <div className="font-sans-display font-semibold text-sm text-[#113C36]">
              {t('cfg.retireMasteredTitle')}
            </div>
            <p className="text-xs text-[#4A5955]">{t('cfg.retireMasteredDesc')}</p>
          </button>
        </div>
      </section>

      {/* Collapsible Advanced Scheduling Weights & Version History (Admin-Only) */}
      <section className="rounded-[16px] bg-white border border-[#E5DFD5] overflow-hidden">
        <button
          type="button"
          aria-expanded={showAdvanced}
          onClick={() => setShowAdvanced((v) => !v)}
          className="w-full px-6 py-4 flex items-center justify-between text-left hover:bg-[#FAF8F5] cursor-pointer"
        >
          <div>
            <div className="font-sans-display font-semibold text-sm text-[#113C36]">
              {t('cfg.advancedTitle')}
            </div>
            <div className="text-xs text-[#78756E]">
              {t('cfg.advancedSub', { version: versionNumber, count: history.length })}
            </div>
          </div>
          {showAdvanced ? (
            <ChevronUp className="w-4 h-4 text-[#78756E]" />
          ) : (
            <ChevronDown className="w-4 h-4 text-[#78756E]" />
          )}
        </button>

        {showAdvanced && (
          <div className="px-6 pb-6 pt-3 border-t border-[#E5DFD5] space-y-5">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="space-y-1">
                <label htmlFor="cfg-spaced-weight" className="block text-xs text-[#4A5955]">{t('cfg.spacedWeight')}</label>
                <NumericInput
                  id="cfg-spaced-weight"
                  showRange
                  stepper
                  label={t('cfg.spacedWeight')}
                  value={config.scheduling.spacedReviewWeight}
                  min={0.1}
                  max={5}
                  step={0.1}
                  onCommit={(v) =>
                    setConfig((p) => ({
                      ...p,
                      scheduling: { ...p.scheduling, spacedReviewWeight: v },
                    }))
                  }
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="cfg-weakest-weight" className="block text-xs text-[#4A5955]">{t('cfg.weakestWeight')}</label>
                <NumericInput
                  id="cfg-weakest-weight"
                  showRange
                  stepper
                  label={t('cfg.weakestWeight')}
                  value={config.scheduling.weakestSkillWeight}
                  min={0.1}
                  max={5}
                  step={0.1}
                  onCommit={(v) =>
                    setConfig((p) => ({
                      ...p,
                      scheduling: { ...p.scheduling, weakestSkillWeight: v },
                    }))
                  }
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="cfg-novelty-weight" className="block text-xs text-[#4A5955]">{t('cfg.noveltyWeight')}</label>
                <NumericInput
                  id="cfg-novelty-weight"
                  showRange
                  stepper
                  label={t('cfg.noveltyWeight')}
                  value={config.scheduling.noveltyCoverageWeight}
                  min={0.1}
                  max={5}
                  step={0.1}
                  onCommit={(v) =>
                    setConfig((p) => ({
                      ...p,
                      scheduling: { ...p.scheduling, noveltyCoverageWeight: v },
                    }))
                  }
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="cfg-cooldown-hours" className="block text-xs text-[#4A5955]">{t('cfg.cooldownHours')}</label>
                <NumericInput
                  id="cfg-cooldown-hours"
                  showRange
                  stepper
                  label={t('cfg.cooldownHours')}
                  value={config.scheduling.minRepeatCooldownHours}
                  min={1}
                  max={168}
                  onCommit={(v) =>
                    setConfig((p) => ({
                      ...p,
                      scheduling: { ...p.scheduling, minRepeatCooldownHours: v },
                    }))
                  }
                />
              </div>
            </div>

            {history.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-sans-display font-semibold text-[#113C36]">
                  {t('cfg.recentVersions')}
                </div>
                <div className="divide-y divide-[#E5DFD5] border border-[#E5DFD5] rounded-[12px] bg-[#FAF8F5]">
                  {history.slice(0, 6).map((h) => (
                    <div
                      key={h.configVersionId}
                      className="px-3.5 py-2 flex flex-wrap items-center justify-between gap-2 text-xs text-[#4A5955]"
                    >
                      <span className="min-w-0 break-words">
                        <strong className="text-[#113C36]">v{h.versionNumber}</strong>{' '}
                        {h.notes ? `— ${h.notes}` : ''}
                      </span>
                      <span className="text-[#78756E] tabular-nums shrink-0">
                        {formatDate(h.createdAt, true)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Save Platform Defaults Bar (only appears when platform defaults have unsaved changes) */}
      {globalDirty && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] bg-white border border-[#113C36]/25 px-5 py-3.5 shadow-[0_2px_10px_rgba(17,60,54,0.06)]">
          <div className="inline-flex items-center gap-2 text-xs font-sans-display font-semibold text-[#113C36] shrink-0">
            <span className="w-2 h-2 rounded-full bg-[#F29A63] shrink-0" aria-hidden="true" />
            <span>{t('settings.unsavedChanges')}</span>
          </div>
          <input
            type="text"
            value={notes}
            onChange={(e) => onChangeNotes(e.target.value)}
            placeholder={t('cfg.changeNotePlaceholder')}
            className="flex-1 min-w-[200px] px-3 py-2 rounded-[10px] border border-[#CFC6B9] bg-[#FAF8F5] text-xs text-[#113C36]"
          />
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={savingGlobal}
              onClick={onDiscard}
              className="px-3.5 py-2 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-xs font-sans-display font-semibold text-[#4A5955] cursor-pointer transition-[background-color,transform] duration-150 ease-out active:scale-[0.98] disabled:opacity-50"
            >
              {t('settings.discardChanges')}
            </button>
            <button
              type="button"
              disabled={savingGlobal}
              onClick={onSave}
              className="px-5 py-2 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-xs font-sans-display font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-[background-color,transform] duration-150 ease-out active:scale-[0.98] disabled:opacity-50"
            >
              <Save className="w-3.5 h-3.5" />
              <span>{savingGlobal ? t('cfg.saving') : t('cfg.saveSettings')}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
