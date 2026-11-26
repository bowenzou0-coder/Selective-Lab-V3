import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import { Lock, RefreshCw, RotateCcw, Save, Unlock, UserCog } from 'lucide-react';
import { api, type AdminLearnerSummary, type LearnerDailySettingsView } from '../../api';
import { useI18n } from '../../i18n';
import { SegmentedControl } from '../ui/SegmentedControl';
import type { UndoableActionEntry } from './AutoCalibrateConfigPanel';
import {
  DEFAULT_AUTO_CALIBRATE,
  DEFAULT_LEARNING_CONFIG,
  type BenchmarkLockStatus,
  type DailyFocusPlan,
  type LearnerPreferences,
  type LearningConfig,
  type SectionCode,
} from '../../../shared/contracts';
import { NumericInput } from '../ui/NumericInput';

const DEFAULT_LEARNER_VIEW: LearnerDailySettingsView = {
  autoCalibrate: { ...DEFAULT_AUTO_CALIBRATE },
  dailyQuestionLimitBySection: { ...DEFAULT_LEARNING_CONFIG.sessionDefaults.dailyQuestionLimitBySection },
  dailyGoalMinutes: DEFAULT_LEARNING_CONFIG.sessionDefaults.dailyGoalMinutes,
  sectionDrillQuestionCount: DEFAULT_LEARNING_CONFIG.sessionDefaults.sectionDrillQuestionCount,
  sectionDrillTimeMinutes: DEFAULT_LEARNING_CONFIG.sessionDefaults.sectionDrillTimeMinutes,
};

interface LearnerOverrideCardProps {
  learner: AdminLearnerSummary;
  /** Current (possibly unsaved) platform defaults, used as the base for recalibration. */
  config: LearningConfig;
  onNotice: (msg: string) => void;
  onError: (msg: string) => void;
  onRecordUndo?: (entry: UndoableActionEntry) => void;
  onClearUndo?: () => void;
}

/** Per-learner daily plan override: auto/manual limits, drills, admin lock and today's decided mix. */
export function LearnerOverrideCard({
  learner,
  config,
  onNotice,
  onError,
  onRecordUndo,
  onClearUndo,
}: LearnerOverrideCardProps) {
  const { t, sectionShortLabel, skillName } = useI18n();
  const monitoredStudentId = learner.uid;
  const [learnerForm, setLearnerFormRaw] = useState<LearnerDailySettingsView>(DEFAULT_LEARNER_VIEW);
  const learnerFormRef = useRef<LearnerDailySettingsView>(DEFAULT_LEARNER_VIEW);
  learnerFormRef.current = learnerForm;
  const [savedLearnerForm, setSavedLearnerForm] = useState<LearnerDailySettingsView>(DEFAULT_LEARNER_VIEW);
  const [learnerPrefs, setLearnerPrefs] = useState<LearnerPreferences | null>(null);
  const [learnerLocked, setLearnerLockedRaw] = useState(false);
  const learnerLockedRef = useRef(false);
  learnerLockedRef.current = learnerLocked;
  const [savedLearnerLocked, setSavedLearnerLocked] = useState(false);

  const setLearnerForm = useCallback(
    (action: SetStateAction<LearnerDailySettingsView>) => {
      const prev = learnerFormRef.current;
      const next =
        typeof action === 'function'
          ? (action as (cur: LearnerDailySettingsView) => LearnerDailySettingsView)(prev)
          : action;
      if (Object.is(prev, next) || JSON.stringify(prev) === JSON.stringify(next)) return;
      onRecordUndo?.({
        undo: () => {
          learnerFormRef.current = prev;
          setLearnerFormRaw(prev);
        },
        redo: () => {
          learnerFormRef.current = next;
          setLearnerFormRaw(next);
        },
      });
      learnerFormRef.current = next;
      setLearnerFormRaw(next);
    },
    [onRecordUndo]
  );

  const setLearnerLocked = useCallback(
    (next: boolean) => {
      const prev = learnerLockedRef.current;
      if (prev === next) return;
      onRecordUndo?.({
        undo: () => {
          learnerLockedRef.current = prev;
          setLearnerLockedRaw(prev);
        },
        redo: () => {
          learnerLockedRef.current = next;
          setLearnerLockedRaw(next);
        },
      });
      learnerLockedRef.current = next;
      setLearnerLockedRaw(next);
    },
    [onRecordUndo]
  );
  const [benchmarkLock, setBenchmarkLock] = useState<BenchmarkLockStatus | null>(null);
  const [togglingBmUnlock, setTogglingBmUnlock] = useState(false);
  const [todayPlan, setTodayPlan] = useState<DailyFocusPlan | null>(null);
  const [loadingLearner, setLoadingLearner] = useState(true);
  const [savingLearner, setSavingLearner] = useState(false);
  const [recalibrating, setRecalibrating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoadingLearner(true);
    Promise.all([
      api.getAdminLearnerPreferences(monitoredStudentId),
      api.getAdminDailyPlan(monitoredStudentId).catch(() => ({ studentId: monitoredStudentId, plan: null })),
    ])
      .then(([prefRes, planRes]) => {
        if (cancelled) return;
        learnerFormRef.current = prefRes.effectiveConfig;
        setLearnerFormRaw(prefRes.effectiveConfig);
        setSavedLearnerForm(prefRes.effectiveConfig);
        setLearnerPrefs(prefRes.preferences);
        learnerLockedRef.current = prefRes.adminOverrideLocked;
        setLearnerLockedRaw(prefRes.adminOverrideLocked);
        setSavedLearnerLocked(prefRes.adminOverrideLocked);
        setBenchmarkLock(prefRes.benchmarkLock ?? null);
        setTodayPlan(planRes.plan);
        onClearUndo?.();
      })
      .catch((err) => {
        if (!cancelled) {
          onError(err instanceof Error ? err.message : 'Unable to load learner preferences.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingLearner(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monitoredStudentId]);

  const learnerName = learner.displayName || learner.email || learner.uid;

  const updateLearnerAuto = (patch: Partial<LearnerDailySettingsView['autoCalibrate']>) => {
    setLearnerForm((prev) => {
      const merged = { ...prev.autoCalibrate, ...patch };
      if (merged.minDailyQuestions > merged.maxDailyQuestions) {
        merged.maxDailyQuestions = merged.minDailyQuestions;
      }
      return { ...prev, autoCalibrate: merged };
    });
  };

  const updateLearnerLimit = (section: SectionCode, value: number) => {
    setLearnerForm((prev) => ({
      ...prev,
      dailyQuestionLimitBySection: {
        ...prev.dailyQuestionLimitBySection,
        [section]: value,
      },
    }));
  };

  const handleSaveLearnerOverride = async () => {
    setSavingLearner(true);
    try {
      const res = await api.saveAdminLearnerPreferences(learner.uid, {
        ...learnerForm,
        adminOverrideLocked: learnerLocked,
      });
      learnerFormRef.current = res.effectiveConfig;
      setLearnerFormRaw(res.effectiveConfig);
      setSavedLearnerForm(res.effectiveConfig);
      setLearnerPrefs(res.preferences);
      learnerLockedRef.current = res.adminOverrideLocked;
      setLearnerLockedRaw(res.adminOverrideLocked);
      setSavedLearnerLocked(res.adminOverrideLocked);
      onNotice(t('admin.overrideSavedNotice', { name: learnerName || learner.uid }));
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Unable to save learner override.');
    } finally {
      setSavingLearner(false);
    }
  };

  const handleClearLearnerOverride = async () => {
    setSavingLearner(true);
    try {
      const res = await api.saveAdminLearnerPreferences(learner.uid, {
        resetToDefaults: true,
      });
      setLearnerForm(res.effectiveConfig);
      setSavedLearnerForm(res.effectiveConfig);
      setLearnerPrefs(res.preferences);
      setLearnerLocked(false);
      setSavedLearnerLocked(false);
      onNotice(t('admin.overrideClearedNotice', { name: learnerName || learner.uid }));
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Unable to reset learner preferences.');
    } finally {
      setSavingLearner(false);
    }
  };

  const handleRecalibrateLearner = async () => {
    setRecalibrating(true);
    try {
      const savedPref = await api.saveAdminLearnerPreferences(learner.uid, {
        ...learnerForm,
        adminOverrideLocked: learnerLocked,
      });
      setSavedLearnerForm(savedPref.effectiveConfig);
      setSavedLearnerLocked(savedPref.adminOverrideLocked);
      const res = await api.recalibrateDailyPlan(
        { ...config, autoCalibrate: learnerForm.autoCalibrate },
        learner.uid
      );
      if (res.plan) setTodayPlan(res.plan);
      onNotice(t('settings.recalibratedNotice'));
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Unable to recalibrate daily plan.');
    } finally {
      setRecalibrating(false);
    }
  };

  const handleToggleBenchmarkUnlock = async (unlock: boolean) => {
    setTogglingBmUnlock(true);
    try {
      const res = await api.setAdminBenchmarkUnlock(learner.uid, unlock);
      setBenchmarkLock(res.benchmarkLock);
      onNotice(
        unlock
          ? t('admin.benchmarkUnlockedNotice', { name: learnerName || learner.uid })
          : t('admin.benchmarkRelockedNotice', { name: learnerName || learner.uid })
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : t('bm.unlockError'));
    } finally {
      setTogglingBmUnlock(false);
    }
  };

  const hasLearnerCustom = Boolean(
    learnerPrefs?.autoCalibrate ||
      learnerPrefs?.dailyQuestionLimitBySection ||
      learnerPrefs?.dailyGoalMinutes ||
      learnerPrefs?.sectionDrillQuestionCount ||
      learnerPrefs?.sectionDrillTimeMinutes
  );

  const decidedLimits = todayPlan?.dailyQuestionLimitBySection ?? learnerForm.dailyQuestionLimitBySection;
  const decidedTotal =
    (decidedLimits.READ || 0) +
    (decidedLimits.MATH || 0) +
    (decidedLimits.THINK || 0) +
    (decidedLimits.WRIT || 0);

  const learnerManualTotal =
    (learnerForm.dailyQuestionLimitBySection.READ || 0) +
    (learnerForm.dailyQuestionLimitBySection.MATH || 0) +
    (learnerForm.dailyQuestionLimitBySection.THINK || 0) +
    (learnerForm.dailyQuestionLimitBySection.WRIT || 0);

  const learnerDirty =
    JSON.stringify(learnerForm) !== JSON.stringify(savedLearnerForm) ||
    learnerLocked !== savedLearnerLocked;
  const monitoredLearner = learner;

  return (
    <section
      className={`rounded-[16px] border p-6 space-y-5 transition-colors ${
        learnerForm.autoCalibrate.enabled
          ? 'bg-[#E5F0EA]/75 border-[#C5DDD1]'
          : 'bg-white border-[#E5DFD5]'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <UserCog className="w-4 h-4 text-[#113C36] shrink-0" />
            <h2 className="font-sans-display font-semibold text-[18px] text-[#113C36]">
              {t('admin.overrideTitle', { name: learnerName || monitoredLearner.uid })}
            </h2>
            <span
              className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-sans-display font-semibold ${
                learnerLocked
                  ? 'bg-[#FDF0E2] text-[#A35116] border border-[#A35116]/20'
                  : hasLearnerCustom
                    ? 'bg-white text-[#113C36] border border-[#C5DDD1]'
                    : 'bg-[#F3EFE8] text-[#4A5955]'
              }`}
            >
              {learnerLocked && <Lock className="w-3 h-3" />}
              <span>
                {learnerLocked
                  ? t('admin.overrideLockedTag')
                  : hasLearnerCustom
                    ? t('admin.overrideCustomTag')
                    : t('admin.overrideDefaultTag')}
              </span>
            </span>
          </div>
          <p className="text-xs text-[#4A5955]">{t('admin.overrideSub')}</p>
        </div>

        <SegmentedControl
          ariaLabel={t('cfg.title')}
          segmentClassName="px-3 py-1.5"
          value={learnerForm.autoCalibrate.enabled ? 'auto' : 'manual'}
          onChange={(mode) => updateLearnerAuto({ enabled: mode === 'auto' })}
          options={[
            { value: 'auto', label: t('cfg.modeAuto') },
            { value: 'manual', label: t('cfg.modeManual') },
          ]}
        />
      </div>

      {loadingLearner ? (
        <div className="py-6 text-xs text-[#615E57]">{t('cfg.loading')}</div>
      ) : (
        <>
          {learnerForm.autoCalibrate.enabled ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
                <div className="rounded-[12px] bg-white border border-[#C5DDD1] p-3.5 space-y-1.5">
                  <label htmlFor="ov-min-q" className="block text-xs font-sans-display font-semibold text-[#113C36]">
                    {t('cfg.minDailyQ')}
                  </label>
                  <NumericInput
                    id="ov-min-q"
                    showRange
                    stepper
                    label={t('cfg.minDailyQ')}
                    value={learnerForm.autoCalibrate.minDailyQuestions}
                    min={3}
                    max={30}
                    onCommit={(v) => updateLearnerAuto({ minDailyQuestions: v })}
                  />
                </div>
                <div className="rounded-[12px] bg-white border border-[#C5DDD1] p-3.5 space-y-1.5">
                  <label htmlFor="ov-max-q" className="block text-xs font-sans-display font-semibold text-[#113C36]">
                    {t('cfg.maxDailyQ')}
                  </label>
                  <NumericInput
                    id="ov-max-q"
                    showRange
                    stepper
                    label={t('cfg.maxDailyQ')}
                    value={learnerForm.autoCalibrate.maxDailyQuestions}
                    min={learnerForm.autoCalibrate.minDailyQuestions}
                    max={40}
                    onCommit={(v) => updateLearnerAuto({ maxDailyQuestions: v })}
                  />
                </div>
                <div className="rounded-[12px] bg-white border border-[#C5DDD1] p-3.5 flex flex-col justify-between gap-2">
                  <span className="text-xs font-sans-display font-semibold text-[#113C36]">
                    {t('cfg.writingScheduling')}
                  </span>
                  <label className="inline-flex items-center gap-2 text-xs text-[#4A5955] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={learnerForm.autoCalibrate.includeWriting}
                      onChange={(e) => updateLearnerAuto({ includeWriting: e.target.checked })}
                      className="accent-[#113C36]"
                    />
                    <span>{t('cfg.includeWriting')}</span>
                  </label>
                </div>
              </div>

              {/* Live Today's Mix for this Learner */}
              <div className="rounded-[14px] bg-white border border-[#C5DDD1] p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-sans-display font-semibold text-[#113C36]">
                      {t('cfg.learnerDecidedMixTitle', {
                        name: learnerName || monitoredLearner.uid,
                        total: decidedTotal,
                        minutes: todayPlan?.dailyGoalMinutes ?? learnerForm.dailyGoalMinutes,
                      })}
                    </div>
                    <p className="text-[11px] text-[#615E57]">{t('cfg.personalPlanHint')}</p>
                  </div>
                  <button
                    type="button"
                    disabled={recalibrating}
                    onClick={handleRecalibrateLearner}
                    className="px-3 py-1.5 rounded-[10px] border border-[#CFC6B9] bg-[#FAF8F5] hover:bg-[#F3EFE8] text-[#113C36] text-xs font-sans-display font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-[background-color,transform,translate,scale] duration-150 ease-out active:scale-[0.98] disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${recalibrating ? 'animate-spin' : ''}`} />
                    <span>{recalibrating ? t('cfg.recalibratingBtn') : t('cfg.recalibrateBtn')}</span>
                  </button>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                  {(['READ', 'MATH', 'THINK', 'WRIT'] as SectionCode[]).map((sec) => (
                    <div key={sec} className="rounded-[10px] bg-[#FAF8F5] border border-[#E5DFD5] px-3 py-2">
                      <div className="text-[11px] text-[#615E57]">{sectionShortLabel(sec)}</div>
                      <div className="font-serif-display font-extrabold text-[22px] text-[#113C36] tabular-nums">
                        {decidedLimits[sec] ?? 0}
                      </div>
                    </div>
                  ))}
                </div>

                {todayPlan && (
                  <div className="space-y-1.5 pt-0.5">
                    {todayPlan.focusSkillIds.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {todayPlan.focusSkillIds.map((sid) => (
                          <span
                            key={sid}
                            className="px-2.5 py-0.5 rounded-full bg-[#F3EFE8] text-xs font-medium text-[#113C36]"
                          >
                            {skillName(sid)}
                          </span>
                        ))}
                      </div>
                    )}
                    <p className="text-xs text-[#4A5955] leading-relaxed">{todayPlan.rationale}</p>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-[#4A5955]">{t('cfg.manualDesc')}</p>
                <span className="px-2.5 py-0.5 rounded-full bg-[#F3EFE8] text-xs font-medium text-[#113C36] tabular-nums">
                  {t('cfg.questionsPerDay', { count: learnerManualTotal })}
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                {(['READ', 'MATH', 'THINK', 'WRIT'] as SectionCode[]).map((sec) => (
                  <div key={sec} className="space-y-1">
                    <label htmlFor={`ov-manual-${sec}`} className="block text-xs font-medium text-[#4A5955]">
                      {t('cfg.sectionPerDay', { section: sectionShortLabel(sec) })}
                    </label>
                    <NumericInput
                      id={`ov-manual-${sec}`}
                      showRange
                      stepper
                      label={t('cfg.sectionPerDay', { section: sectionShortLabel(sec) })}
                      value={learnerForm.dailyQuestionLimitBySection[sec]}
                      min={0}
                      max={sec === 'WRIT' ? 2 : 30}
                      onCommit={(v) => updateLearnerLimit(sec, v)}
                    />
                  </div>
                ))}
                <div className="space-y-1">
                  <label htmlFor="ov-goal-min" className="block text-xs font-medium text-[#4A5955]">
                    {t('cfg.dailyGoalMin')}
                  </label>
                  <NumericInput
                    id="ov-goal-min"
                    showRange
                    stepper
                    label={t('cfg.dailyGoalMin')}
                    value={learnerForm.dailyGoalMinutes}
                    min={5}
                    max={120}
                    onCommit={(v) => setLearnerForm((p) => ({ ...p, dailyGoalMinutes: v }))}
                  />
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-[#D4E4DC]/80">
            <div className="space-y-1">
              <label htmlFor="ov-drill-q" className="block text-xs font-medium text-[#4A5955]">
                {t('cfg.drillCountLabel')}
              </label>
              <NumericInput
                id="ov-drill-q"
                showRange
                stepper
                label={t('cfg.drillCountLabel')}
                value={learnerForm.sectionDrillQuestionCount}
                min={3}
                max={40}
                onCommit={(v) => setLearnerForm((p) => ({ ...p, sectionDrillQuestionCount: v }))}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="ov-drill-m" className="block text-xs font-medium text-[#4A5955]">
                {t('cfg.drillMinutesLabel')}
              </label>
              <NumericInput
                id="ov-drill-m"
                showRange
                stepper
                label={t('cfg.drillMinutesLabel')}
                value={learnerForm.sectionDrillTimeMinutes}
                min={3}
                max={60}
                onCommit={(v) => setLearnerForm((p) => ({ ...p, sectionDrillTimeMinutes: v }))}
              />
            </div>
          </div>

          <div className="space-y-3 pt-2">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="inline-flex items-center gap-2 text-xs font-medium text-[#113C36] cursor-pointer">
                <input
                  type="checkbox"
                  checked={learnerLocked}
                  onChange={(e) => setLearnerLocked(e.target.checked)}
                  className="accent-[#113C36]"
                />
                <Lock className="w-3.5 h-3.5 text-[#4A5955]" />
                <span>{t('admin.overrideLockLabel')}</span>
              </label>

              {!learnerDirty && (hasLearnerCustom || learnerLocked) && (
                <button
                  type="button"
                  disabled={savingLearner}
                  onClick={handleClearLearnerOverride}
                  className="inline-flex items-center gap-1 text-xs font-sans-display font-semibold text-[#4A5955] hover:text-[#113C36] cursor-pointer disabled:opacity-50"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>{t('admin.overrideClearBtn')}</span>
                </button>
              )}
            </div>

            {benchmarkLock && benchmarkLock.lastBenchmarkCompletedAtIso && benchmarkLock.requiredCorrect > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] bg-[#FAF8F5] border border-[#E5DFD5] px-4 py-3">
                <div className="space-y-0.5 min-w-0">
                  <div className="text-xs font-sans-display font-semibold text-[#113C36] tabular-nums">
                    {benchmarkLock.isLocked
                      ? t('bm.lockProgressTitle', {
                          earned: benchmarkLock.earnedCorrect,
                          required: benchmarkLock.requiredCorrect,
                        })
                      : benchmarkLock.adminUnlocked
                        ? t('bm.lockAdminUnlockedTitle')
                        : t('bm.lockUnlockedTitle', {
                            earned: benchmarkLock.earnedCorrect,
                            required: benchmarkLock.requiredCorrect,
                          })}
                  </div>
                  <p className="text-[11px] text-[#615E57]">
                    {t('admin.benchmarkOverrideHint')}
                  </p>
                </div>
                {benchmarkLock.isLocked ? (
                  <button
                    type="button"
                    disabled={togglingBmUnlock}
                    onClick={() => handleToggleBenchmarkUnlock(true)}
                    className="px-3 py-1.5 rounded-[10px] border border-[#113C36] bg-white hover:bg-[#E5F0EA] text-xs font-sans-display font-semibold text-[#113C36] inline-flex items-center gap-1.5 cursor-pointer transition-tactile disabled:opacity-50 shrink-0"
                  >
                    <Unlock className="w-3.5 h-3.5" />
                    <span>{togglingBmUnlock ? t('cfg.saving') : t('bm.adminUnlockBtn')}</span>
                  </button>
                ) : benchmarkLock.adminUnlocked && benchmarkLock.remainingCorrect > 0 ? (
                  <button
                    type="button"
                    disabled={togglingBmUnlock}
                    onClick={() => handleToggleBenchmarkUnlock(false)}
                    className="px-3 py-1.5 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#F3EFE8] text-xs font-sans-display font-semibold text-[#4A5955] inline-flex items-center gap-1.5 cursor-pointer transition-tactile disabled:opacity-50 shrink-0"
                  >
                    <Lock className="w-3.5 h-3.5" />
                    <span>{togglingBmUnlock ? t('cfg.saving') : t('bm.adminRelockBtn')}</span>
                  </button>
                ) : null}
              </div>
            )}

            {learnerDirty && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] bg-white border border-[#113C36]/25 px-4 py-3 shadow-[0_2px_10px_rgba(17,60,54,0.06)]">
                <div className="inline-flex items-center gap-2 text-xs font-sans-display font-semibold text-[#113C36]">
                  <span className="w-2 h-2 rounded-full bg-[#F29A63] shrink-0" aria-hidden="true" />
                  <span>{t('settings.unsavedChanges')}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={savingLearner}
                    onClick={() => {
                      setLearnerForm(savedLearnerForm);
                      setLearnerLocked(savedLearnerLocked);
                    }}
                    className="px-3.5 py-2 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-xs font-sans-display font-semibold text-[#4A5955] cursor-pointer transition-[background-color,transform,translate,scale] duration-150 ease-out active:scale-[0.98] disabled:opacity-50"
                  >
                    {t('settings.discardChanges')}
                  </button>
                  <button
                    type="button"
                    disabled={savingLearner}
                    onClick={handleSaveLearnerOverride}
                    className="px-4 py-2 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-xs font-sans-display font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-[background-color,transform,translate,scale] duration-150 ease-out active:scale-[0.98] disabled:opacity-50"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>{savingLearner ? t('cfg.saving') : t('admin.overrideSaveBtn')}</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
