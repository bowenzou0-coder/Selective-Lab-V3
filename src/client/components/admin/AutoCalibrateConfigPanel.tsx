import { useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Lock,
  RefreshCw,
  RotateCcw,
  Save,
  Sparkles,
  UserCog,
} from 'lucide-react';
import {
  api,
  type AdminLearnerSummary,
  type LearnerDailySettingsView,
} from '../../api';
import { useI18n } from '../../i18n';
import {
  DEFAULT_AUTO_CALIBRATE,
  DEFAULT_LEARNING_CONFIG,
  DEFAULT_POOL_POLICY,
  type DailyFocusPlan,
  type LearnerPreferences,
  type LearningConfig,
  type SectionCode,
} from '../../../shared/contracts';

interface AutoCalibrateConfigPanelProps {
  onNotice: (msg: string) => void;
  onError: (msg: string) => void;
  monitoredStudentId?: string | null;
  monitoredLearner?: AdminLearnerSummary | null;
}

function NumericInput({
  id,
  value,
  min,
  max,
  step = 1,
  disabled = false,
  onCommit,
}: {
  id?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  onCommit: (next: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setDraft(String(value));
  }, [value, focused]);

  const commitClamped = (raw: string) => {
    const parsed = Number(raw);
    if (raw.trim() === '' || Number.isNaN(parsed)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, parsed));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };

  return (
    <input
      id={id}
      type="number"
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      value={draft}
      onFocus={(e) => {
        setFocused(true);
        e.target.select();
      }}
      onChange={(e) => {
        const nextRaw = e.target.value;
        if (nextRaw.trim() === '') {
          setDraft('');
          return;
        }
        const parsed = Number(nextRaw);
        if (Number.isNaN(parsed)) return;
        if (parsed > max) {
          setDraft(String(max));
          if (max !== value) onCommit(max);
          return;
        }
        setDraft(nextRaw);
        if (parsed >= min && parsed !== value) {
          onCommit(parsed);
        }
      }}
      onBlur={() => {
        setFocused(false);
        commitClamped(draft);
      }}
      className="w-full px-3 py-2 rounded-[10px] border border-[#CFC6B9] bg-white text-sm text-[#113C36] tabular-nums disabled:bg-[#F3EFE8] disabled:text-[#78756E] disabled:cursor-not-allowed focus:outline-none focus:border-[#113C36]"
    />
  );
}

const DEFAULT_LEARNER_VIEW: LearnerDailySettingsView = {
  autoCalibrate: { ...DEFAULT_AUTO_CALIBRATE },
  dailyQuestionLimitBySection: { ...DEFAULT_LEARNING_CONFIG.sessionDefaults.dailyQuestionLimitBySection },
  dailyGoalMinutes: DEFAULT_LEARNING_CONFIG.sessionDefaults.dailyGoalMinutes,
  sectionDrillQuestionCount: DEFAULT_LEARNING_CONFIG.sessionDefaults.sectionDrillQuestionCount,
  sectionDrillTimeMinutes: DEFAULT_LEARNING_CONFIG.sessionDefaults.sectionDrillTimeMinutes,
};

export function AutoCalibrateConfigPanel({
  onNotice,
  onError,
  monitoredStudentId,
  monitoredLearner = null,
}: AutoCalibrateConfigPanelProps) {
  const { t, sectionShortLabel, skillName, formatDate } = useI18n();
  const [loading, setLoading] = useState(true);
  const [savingGlobal, setSavingGlobal] = useState(false);
  const [config, setConfig] = useState<LearningConfig>(DEFAULT_LEARNING_CONFIG);
  const [savedConfig, setSavedConfig] = useState<LearningConfig>(DEFAULT_LEARNING_CONFIG);
  const [versionNumber, setVersionNumber] = useState(1);
  const [notes, setNotes] = useState('');
  const [history, setHistory] = useState<
    { configVersionId: string; versionNumber: number; notes?: string; createdAt: string }[]
  >([]);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Per-learner override state
  const [learnerForm, setLearnerForm] = useState<LearnerDailySettingsView>(DEFAULT_LEARNER_VIEW);
  const [savedLearnerForm, setSavedLearnerForm] = useState<LearnerDailySettingsView>(DEFAULT_LEARNER_VIEW);
  const [learnerPrefs, setLearnerPrefs] = useState<LearnerPreferences | null>(null);
  const [learnerLocked, setLearnerLocked] = useState(false);
  const [savedLearnerLocked, setSavedLearnerLocked] = useState(false);
  const [todayPlan, setTodayPlan] = useState<DailyFocusPlan | null>(null);
  const [loadingLearner, setLoadingLearner] = useState(false);
  const [savingLearner, setSavingLearner] = useState(false);
  const [recalibrating, setRecalibrating] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api
      .getAdminConfig()
      .then((cfgRes) => {
        if (!active) return;
        const loaded = cfgRes.active.config;
        const normalized: LearningConfig = {
          ...DEFAULT_LEARNING_CONFIG,
          ...loaded,
          autoCalibrate: {
            ...DEFAULT_AUTO_CALIBRATE,
            ...(loaded.autoCalibrate || {}),
          },
          poolPolicy: {
            ...DEFAULT_POOL_POLICY,
            ...(loaded.poolPolicy || {}),
          },
        };
        setConfig(normalized);
        setSavedConfig(normalized);
        setVersionNumber(cfgRes.active.versionNumber);
        setHistory(cfgRes.history || []);
      })
      .catch((err) => {
        if (active) onError(err instanceof Error ? err.message : 'Unable to load adaptive settings.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!monitoredStudentId || monitoredStudentId === 'none') {
      setTodayPlan(null);
      setLearnerPrefs(null);
      setLearnerLocked(false);
      return;
    }
    setLoadingLearner(true);
    Promise.all([
      api.getAdminLearnerPreferences(monitoredStudentId),
      api.getAdminDailyPlan(monitoredStudentId).catch(() => ({ studentId: monitoredStudentId, plan: null })),
    ])
      .then(([prefRes, planRes]) => {
        if (cancelled) return;
        setLearnerForm(prefRes.effectiveConfig);
        setSavedLearnerForm(prefRes.effectiveConfig);
        setLearnerPrefs(prefRes.preferences);
        setLearnerLocked(prefRes.adminOverrideLocked);
        setSavedLearnerLocked(prefRes.adminOverrideLocked);
        setTodayPlan(planRes.plan);
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

  const learnerName = monitoredLearner
    ? monitoredLearner.displayName || monitoredLearner.email || monitoredLearner.uid
    : null;

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
    if (!monitoredLearner) return;
    setSavingLearner(true);
    try {
      const res = await api.saveAdminLearnerPreferences(monitoredLearner.uid, {
        ...learnerForm,
        adminOverrideLocked: learnerLocked,
      });
      setLearnerForm(res.effectiveConfig);
      setSavedLearnerForm(res.effectiveConfig);
      setLearnerPrefs(res.preferences);
      setLearnerLocked(res.adminOverrideLocked);
      setSavedLearnerLocked(res.adminOverrideLocked);
      onNotice(t('admin.overrideSavedNotice', { name: learnerName || monitoredLearner.uid }));
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Unable to save learner override.');
    } finally {
      setSavingLearner(false);
    }
  };

  const handleClearLearnerOverride = async () => {
    if (!monitoredLearner) return;
    setSavingLearner(true);
    try {
      const res = await api.saveAdminLearnerPreferences(monitoredLearner.uid, {
        resetToDefaults: true,
      });
      setLearnerForm(res.effectiveConfig);
      setSavedLearnerForm(res.effectiveConfig);
      setLearnerPrefs(res.preferences);
      setLearnerLocked(false);
      setSavedLearnerLocked(false);
      onNotice(t('admin.overrideClearedNotice', { name: learnerName || monitoredLearner.uid }));
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Unable to reset learner preferences.');
    } finally {
      setSavingLearner(false);
    }
  };

  const handleRecalibrateLearner = async () => {
    if (!monitoredLearner) {
      onError(t('cfg.selectLearnerBeforeRecalibrate'));
      return;
    }
    setRecalibrating(true);
    try {
      const savedPref = await api.saveAdminLearnerPreferences(monitoredLearner.uid, {
        ...learnerForm,
        adminOverrideLocked: learnerLocked,
      });
      setSavedLearnerForm(savedPref.effectiveConfig);
      setSavedLearnerLocked(savedPref.adminOverrideLocked);
      const res = await api.recalibrateDailyPlan(
        { ...config, autoCalibrate: learnerForm.autoCalibrate },
        monitoredLearner.uid
      );
      if (res.plan) setTodayPlan(res.plan);
      onNotice(t('settings.recalibratedNotice'));
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Unable to recalibrate daily plan.');
    } finally {
      setRecalibrating(false);
    }
  };

  const handleSaveGlobal = async () => {
    setSavingGlobal(true);
    try {
      const res = await api.saveAdminConfig(config, notes.trim() || undefined);
      setVersionNumber(res.versionNumber);
      setSavedConfig(config);
      setNotes('');
      onNotice(`Saved platform defaults (v${res.versionNumber}).`);
      const cfgRes = await api.getAdminConfig();
      setHistory(cfgRes.history || []);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Unable to save platform defaults.');
    } finally {
      setSavingGlobal(false);
    }
  };

  if (loading) {
    return <div className="p-10 text-center text-sm text-[#78756E]">{t('cfg.loading')}</div>;
  }

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

  const globalManualTotal =
    (config.sessionDefaults.dailyQuestionLimitBySection.READ || 0) +
    (config.sessionDefaults.dailyQuestionLimitBySection.MATH || 0) +
    (config.sessionDefaults.dailyQuestionLimitBySection.THINK || 0) +
    (config.sessionDefaults.dailyQuestionLimitBySection.WRIT || 0);

  const learnerDirty =
    JSON.stringify(learnerForm) !== JSON.stringify(savedLearnerForm) ||
    learnerLocked !== savedLearnerLocked;
  const globalDirty = JSON.stringify(config) !== JSON.stringify(savedConfig);

  return (
    <div className="space-y-8">
      {/* 1. Per-Learner Daily Plan Override */}
      {monitoredLearner ? (
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

            <div
              role="group"
              aria-label={t('cfg.title')}
              className="inline-flex items-center p-1 rounded-[12px] bg-white border border-[#CFC6B9] gap-1"
            >
              <button
                type="button"
                aria-pressed={learnerForm.autoCalibrate.enabled}
                onClick={() => updateLearnerAuto({ enabled: true })}
                className={`px-3 py-1.5 rounded-[9px] text-xs font-sans-display font-semibold cursor-pointer transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.98] whitespace-nowrap ${
                  learnerForm.autoCalibrate.enabled
                    ? 'bg-[#113C36] text-white'
                    : 'text-[#4A5955] hover:text-[#113C36]'
                }`}
              >
                {t('cfg.modeAuto')}
              </button>
              <button
                type="button"
                aria-pressed={!learnerForm.autoCalibrate.enabled}
                onClick={() => updateLearnerAuto({ enabled: false })}
                className={`px-3 py-1.5 rounded-[9px] text-xs font-sans-display font-semibold cursor-pointer transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.98] whitespace-nowrap ${
                  !learnerForm.autoCalibrate.enabled
                    ? 'bg-[#113C36] text-white'
                    : 'text-[#4A5955] hover:text-[#113C36]'
                }`}
              >
                {t('cfg.modeManual')}
              </button>
            </div>
          </div>

          {loadingLearner ? (
            <div className="py-6 text-xs text-[#78756E]">{t('cfg.loading')}</div>
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
                        <p className="text-[11px] text-[#78756E]">{t('cfg.personalPlanHint')}</p>
                      </div>
                      <button
                        type="button"
                        disabled={recalibrating}
                        onClick={handleRecalibrateLearner}
                        className="px-3 py-1.5 rounded-[10px] border border-[#CFC6B9] bg-[#FAF8F5] hover:bg-[#F3EFE8] text-[#113C36] text-xs font-sans-display font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-[background-color,transform] duration-150 ease-out active:scale-[0.98] disabled:opacity-50"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${recalibrating ? 'animate-spin' : ''}`} />
                        <span>{recalibrating ? t('cfg.recalibratingBtn') : t('cfg.recalibrateBtn')}</span>
                      </button>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                      {(['READ', 'MATH', 'THINK', 'WRIT'] as SectionCode[]).map((sec) => (
                        <div key={sec} className="rounded-[10px] bg-[#FAF8F5] border border-[#E5DFD5] px-3 py-2">
                          <div className="text-[11px] text-[#78756E]">{sectionShortLabel(sec)}</div>
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
                        className="px-3.5 py-2 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-xs font-sans-display font-semibold text-[#4A5955] cursor-pointer transition-[background-color,transform] duration-150 ease-out active:scale-[0.98] disabled:opacity-50"
                      >
                        {t('settings.discardChanges')}
                      </button>
                      <button
                        type="button"
                        disabled={savingLearner}
                        onClick={handleSaveLearnerOverride}
                        className="px-4 py-2 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-xs font-sans-display font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-[background-color,transform] duration-150 ease-out active:scale-[0.98] disabled:opacity-50"
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
      ) : (
        <div className="rounded-[14px] bg-[#FAF8F5] border border-[#E5DFD5] px-5 py-4 space-y-1">
          <div className="text-xs font-sans-display font-semibold text-[#113C36]">
            {t('cfg.perStudentPreviewTitle')}
          </div>
          <p className="text-xs text-[#4A5955]">{t('cfg.perStudentPreviewEmpty')}</p>
        </div>
      )}

      {/* 2. Platform Defaults & Admin-Only Policies */}
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
                  <label className="block text-xs text-[#4A5955]">{t('cfg.spacedWeight')}</label>
                  <NumericInput
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
                  <label className="block text-xs text-[#4A5955]">{t('cfg.weakestWeight')}</label>
                  <NumericInput
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
                  <label className="block text-xs text-[#4A5955]">{t('cfg.noveltyWeight')}</label>
                  <NumericInput
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
                  <label className="block text-xs text-[#4A5955]">{t('cfg.cooldownHours')}</label>
                  <NumericInput
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
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t('cfg.changeNotePlaceholder')}
              className="flex-1 min-w-[200px] px-3 py-2 rounded-[10px] border border-[#CFC6B9] bg-[#FAF8F5] text-xs text-[#113C36]"
            />
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                disabled={savingGlobal}
                onClick={() => {
                  setConfig(savedConfig);
                  setNotes('');
                }}
                className="px-3.5 py-2 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-xs font-sans-display font-semibold text-[#4A5955] cursor-pointer transition-[background-color,transform] duration-150 ease-out active:scale-[0.98] disabled:opacity-50"
              >
                {t('settings.discardChanges')}
              </button>
              <button
                type="button"
                disabled={savingGlobal}
                onClick={handleSaveGlobal}
                className="px-5 py-2 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-xs font-sans-display font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-[background-color,transform] duration-150 ease-out active:scale-[0.98] disabled:opacity-50"
              >
                <Save className="w-3.5 h-3.5" />
                <span>{savingGlobal ? t('cfg.saving') : t('cfg.saveSettings')}</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
