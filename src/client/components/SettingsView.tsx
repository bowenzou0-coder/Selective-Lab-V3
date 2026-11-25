import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Compass,
  Download,
  Flag,
  Lock,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import {
  api,
  type LearnerDailySettingsView,
  type StudentSettingsResponse,
} from '../api';
import { useI18n } from '../i18n';
import {
  DEFAULT_AUTO_CALIBRATE,
  DEFAULT_LEARNING_CONFIG,
  type DailyFocusPlan,
  type QuestionFlagRecord,
  type SectionCode,
} from '../../shared/contracts';

export interface SettingsViewProps {
  onAccountDeleted: () => void;
  onReplayTour: () => void;
}

function NumericField({
  id,
  value,
  min,
  max,
  disabled = false,
  onCommit,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
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
    const clamped = Math.min(max, Math.max(min, Math.round(parsed)));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };

  return (
    <input
      id={id}
      type="number"
      min={min}
      max={max}
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
        const rounded = Math.round(parsed);
        if (rounded > max) {
          setDraft(String(max));
          if (max !== value) onCommit(max);
          return;
        }
        setDraft(nextRaw);
        if (rounded >= min) {
          if (rounded !== value) onCommit(rounded);
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

const FALLBACK_DAILY: LearnerDailySettingsView = {
  autoCalibrate: { ...DEFAULT_AUTO_CALIBRATE },
  dailyQuestionLimitBySection: { ...DEFAULT_LEARNING_CONFIG.sessionDefaults.dailyQuestionLimitBySection },
  dailyGoalMinutes: DEFAULT_LEARNING_CONFIG.sessionDefaults.dailyGoalMinutes,
  sectionDrillQuestionCount: DEFAULT_LEARNING_CONFIG.sessionDefaults.sectionDrillQuestionCount,
  sectionDrillTimeMinutes: DEFAULT_LEARNING_CONFIG.sessionDefaults.sectionDrillTimeMinutes,
};

export function SettingsView({ onAccountDeleted, onReplayTour }: SettingsViewProps) {
  const { t, sectionShortLabel, skillName, formatDate } = useI18n();
  const [data, setData] = useState<StudentSettingsResponse | null>(null);
  const [form, setForm] = useState<LearnerDailySettingsView>(FALLBACK_DAILY);
  const [savedForm, setSavedForm] = useState<LearnerDailySettingsView>(FALLBACK_DAILY);
  const [todayPlan, setTodayPlan] = useState<DailyFocusPlan | null>(null);
  const [flags, setFlags] = useState<QuestionFlagRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [recalibrating, setRecalibrating] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  // Study data reset confirmation
  const [resetOpen, setResetOpen] = useState(false);
  const [resetInput, setResetInput] = useState('');
  const [resetting, setResetting] = useState(false);

  // Account deletion confirmation
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteInput, setDeleteInput] = useState('');
  const [deleting, setDeleting] = useState(false);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getStudentSettings();
      setData(res);
      setForm(res.effectiveConfig);
      setSavedForm(res.effectiveConfig);
      setTodayPlan(res.dailyFocusPlan);
      setFlags(res.flags || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const isLocked = Boolean(data?.adminOverrideLocked && data.role !== 'admin');
  const hasPersonalPrefs = Boolean(
    data?.preferences?.autoCalibrate ||
      data?.preferences?.dailyQuestionLimitBySection ||
      data?.preferences?.dailyGoalMinutes ||
      data?.preferences?.sectionDrillQuestionCount ||
      data?.preferences?.sectionDrillTimeMinutes
  );

  const updateAuto = (patch: Partial<LearnerDailySettingsView['autoCalibrate']>) => {
    setForm((prev) => {
      const merged = { ...prev.autoCalibrate, ...patch };
      if (merged.minDailyQuestions > merged.maxDailyQuestions) {
        merged.maxDailyQuestions = merged.minDailyQuestions;
      }
      return { ...prev, autoCalibrate: merged };
    });
  };

  const updateLimit = (section: SectionCode, value: number) => {
    setForm((prev) => ({
      ...prev,
      dailyQuestionLimitBySection: {
        ...prev.dailyQuestionLimitBySection,
        [section]: value,
      },
    }));
  };

  const handleSavePlan = async () => {
    if (isLocked) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const res = await api.saveStudentDailyPlan(form);
      setForm(res.effectiveConfig);
      setSavedForm(res.effectiveConfig);
      setData((prev) =>
        prev
          ? {
              ...prev,
              preferences: res.preferences,
              effectiveConfig: res.effectiveConfig,
              adminOverrideLocked: res.adminOverrideLocked,
            }
          : prev
      );
      setNotice(t('settings.savedNotice'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save daily plan.');
    } finally {
      setSaving(false);
    }
  };

  const handleResetPlanDefaults = async () => {
    if (isLocked) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const res = await api.saveStudentDailyPlan({ resetToDefaults: true });
      setForm(res.effectiveConfig);
      setSavedForm(res.effectiveConfig);
      setData((prev) =>
        prev
          ? {
              ...prev,
              preferences: res.preferences,
              effectiveConfig: res.effectiveConfig,
              adminOverrideLocked: res.adminOverrideLocked,
            }
          : prev
      );
      setNotice(t('settings.savedNotice'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to restore default plan.');
    } finally {
      setSaving(false);
    }
  };

  const handleRecalibrate = async () => {
    setRecalibrating(true);
    setError('');
    setNotice('');
    try {
      const res = await api.recalibrateStudentDailyPlan(
        isLocked ? undefined : { autoCalibrate: form.autoCalibrate }
      );
      if (res.plan) setTodayPlan(res.plan);
      if (res.effectiveConfig) {
        setForm(res.effectiveConfig);
        setSavedForm(res.effectiveConfig);
      }
      setNotice(t('settings.recalibratedNotice'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to recalibrate today’s mix.');
    } finally {
      setRecalibrating(false);
    }
  };

  const handleConfirmResetProgress = async () => {
    if (resetInput.trim().toUpperCase() !== 'RESET') return;
    setResetting(true);
    setError('');
    setNotice('');
    try {
      await api.resetOwnStudyProgress('RESET');
      setResetOpen(false);
      setResetInput('');
      setNotice(t('settings.resetSuccess'));
      await loadSettings();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to reset study progress.');
    } finally {
      setResetting(false);
    }
  };

  const handleConfirmDeleteAccount = async () => {
    if (deleteInput.trim().toUpperCase() !== 'DELETE') return;
    setDeleting(true);
    setError('');
    try {
      await api.deleteOwnAccount('DELETE');
      onAccountDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to delete account.');
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <main className="px-6 sm:px-9 py-12 max-w-[980px] mx-auto text-sm text-[#4A5955]">
        {t('settings.loading')}
      </main>
    );
  }

  const decidedLimits = todayPlan?.dailyQuestionLimitBySection ?? form.dailyQuestionLimitBySection;
  const decidedTotal =
    (decidedLimits.READ || 0) +
    (decidedLimits.MATH || 0) +
    (decidedLimits.THINK || 0) +
    (decidedLimits.WRIT || 0);
  const manualTotal =
    (form.dailyQuestionLimitBySection.READ || 0) +
    (form.dailyQuestionLimitBySection.MATH || 0) +
    (form.dailyQuestionLimitBySection.THINK || 0) +
    (form.dailyQuestionLimitBySection.WRIT || 0);
  const counts = data?.progressCounts;

  return (
    <main className="px-6 sm:px-9 py-8 sm:py-10 space-y-8 max-w-[980px] mx-auto text-[#113C36]">
      <header className="space-y-1">
        <h1 className="font-sans-display font-semibold text-[28px] sm:text-[32px] tracking-[-0.025em] text-[#113C36] leading-tight">
          {t('settings.title')}
        </h1>
        <p className="text-[14.5px] text-[#4A5955]">{t('settings.subtitle')}</p>
      </header>

      {notice && (
        <div
          role="status"
          className="px-4 py-3 rounded-[12px] bg-[#E5F0EA] border border-[#C5DDD1] text-[#113C36] text-xs font-medium flex items-center justify-between gap-3"
        >
          <span>{notice}</span>
          <button
            type="button"
            aria-label={t('admin.dismissNotice')}
            onClick={() => setNotice('')}
            className="text-[#4A5955] hover:text-[#113C36] cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="px-4 py-3 rounded-[12px] bg-[#FDECEB] border border-[#B83A28]/25 text-[#B83A28] text-xs font-medium flex items-center justify-between gap-3"
        >
          <span>{error}</span>
          <button
            type="button"
            aria-label={t('admin.dismissError')}
            onClick={() => setError('')}
            className="text-[#B83A28] cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* 1. Personal Daily Practice Plan */}
      <section
        className={`rounded-[16px] border p-6 space-y-5 transition-colors ${
          form.autoCalibrate.enabled
            ? 'bg-[#E5F0EA]/70 border-[#C5DDD1]'
            : 'bg-white border-[#E5DFD5]'
        }`}
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Sparkles className="w-4 h-4 text-[#113C36] shrink-0" />
              <h2 className="font-sans-display font-semibold text-[20px] tracking-[-0.015em] text-[#113C36]">
                {t('settings.dailyTitle')}
              </h2>
              <span
                className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-sans-display font-semibold ${
                  isLocked
                    ? 'bg-[#FDF0E2] text-[#A35116] border border-[#A35116]/20'
                    : hasPersonalPrefs
                      ? 'bg-white text-[#113C36] border border-[#C5DDD1]'
                      : 'bg-[#F3EFE8] text-[#4A5955]'
                }`}
              >
                {isLocked && <Lock className="w-3 h-3" />}
                <span>
                  {isLocked
                    ? t('settings.lockedBadge')
                    : hasPersonalPrefs
                      ? t('settings.personalBadge')
                      : t('settings.defaultBadge')}
                </span>
              </span>
            </div>
            <p className="text-[13px] text-[#4A5955]">{t('settings.dailySubtitle')}</p>
          </div>

          <div
            role="group"
            aria-label={t('settings.dailyTitle')}
            className="inline-flex items-center p-1 rounded-[12px] bg-white border border-[#CFC6B9] gap-1"
          >
            <button
              type="button"
              disabled={isLocked}
              aria-pressed={form.autoCalibrate.enabled}
              onClick={() => updateAuto({ enabled: true })}
              className={`px-3.5 py-1.5 rounded-[9px] text-xs font-sans-display font-semibold transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.98] cursor-pointer disabled:opacity-55 disabled:cursor-not-allowed whitespace-nowrap ${
                form.autoCalibrate.enabled
                  ? 'bg-[#113C36] text-white'
                  : 'text-[#4A5955] hover:text-[#113C36]'
              }`}
            >
              {t('cfg.modeAuto')}
            </button>
            <button
              type="button"
              disabled={isLocked}
              aria-pressed={!form.autoCalibrate.enabled}
              onClick={() => updateAuto({ enabled: false })}
              className={`px-3.5 py-1.5 rounded-[9px] text-xs font-sans-display font-semibold transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.98] cursor-pointer disabled:opacity-55 disabled:cursor-not-allowed whitespace-nowrap ${
                !form.autoCalibrate.enabled
                  ? 'bg-[#113C36] text-white'
                  : 'text-[#4A5955] hover:text-[#113C36]'
              }`}
            >
              {t('cfg.modeManual')}
            </button>
          </div>
        </div>

        {isLocked && (
          <div className="rounded-[12px] bg-[#FAF8F5] border border-[#E5DFD5] px-4 py-3 text-xs text-[#4A5955] flex items-center gap-2">
            <Lock className="w-3.5 h-3.5 text-[#A35116] shrink-0" />
            <span>{t('settings.lockedNote')}</span>
          </div>
        )}

        {form.autoCalibrate.enabled ? (
          <div className="space-y-4">
            <p className="text-[13px] text-[#4A5955]">{t('cfg.autoDesc')}</p>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
              <div className="rounded-[12px] bg-white border border-[#C5DDD1] p-3.5 space-y-1.5">
                <label htmlFor="settings-min-q" className="block text-xs font-sans-display font-semibold text-[#113C36]">
                  {t('cfg.minDailyQ')}
                </label>
                <NumericField
                  id="settings-min-q"
                  value={form.autoCalibrate.minDailyQuestions}
                  min={3}
                  max={30}
                  disabled={isLocked}
                  onCommit={(v) => updateAuto({ minDailyQuestions: v })}
                />
              </div>

              <div className="rounded-[12px] bg-white border border-[#C5DDD1] p-3.5 space-y-1.5">
                <label htmlFor="settings-max-q" className="block text-xs font-sans-display font-semibold text-[#113C36]">
                  {t('cfg.maxDailyQ')}
                </label>
                <NumericField
                  id="settings-max-q"
                  value={form.autoCalibrate.maxDailyQuestions}
                  min={form.autoCalibrate.minDailyQuestions}
                  max={40}
                  disabled={isLocked}
                  onCommit={(v) => updateAuto({ maxDailyQuestions: v })}
                />
              </div>

              <div className="rounded-[12px] bg-white border border-[#C5DDD1] p-3.5 flex flex-col justify-between gap-2">
                <span className="text-xs font-sans-display font-semibold text-[#113C36]">
                  {t('cfg.writingScheduling')}
                </span>
                <label className="inline-flex items-center gap-2 text-xs text-[#4A5955] cursor-pointer">
                  <input
                    type="checkbox"
                    disabled={isLocked}
                    checked={form.autoCalibrate.includeWriting}
                    onChange={(e) => updateAuto({ includeWriting: e.target.checked })}
                    className="accent-[#113C36]"
                  />
                  <span>{t('cfg.includeWriting')}</span>
                </label>
              </div>
            </div>

            {/* Today's Decided Mix */}
            <div className="rounded-[14px] bg-white border border-[#C5DDD1] p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-sans-display font-semibold text-[#113C36]">
                  {t('cfg.decidedMixTitle', {
                    total: decidedTotal,
                    minutes: todayPlan?.dailyGoalMinutes ?? form.dailyGoalMinutes,
                  })}
                </div>
                <button
                  type="button"
                  disabled={recalibrating}
                  onClick={handleRecalibrate}
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
                <div className="space-y-2 pt-0.5">
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
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[13px] text-[#4A5955]">{t('cfg.manualDesc')}</p>
              <span className="px-2.5 py-1 rounded-full bg-[#F3EFE8] text-xs font-medium text-[#113C36] tabular-nums">
                {t('cfg.questionsPerDay', { count: manualTotal })}
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              {(['READ', 'MATH', 'THINK', 'WRIT'] as SectionCode[]).map((sec) => (
                <div key={sec} className="space-y-1">
                  <label htmlFor={`settings-manual-${sec}`} className="block text-xs font-medium text-[#4A5955]">
                    {t('cfg.sectionPerDay', { section: sectionShortLabel(sec) })}
                  </label>
                  <NumericField
                    id={`settings-manual-${sec}`}
                    value={form.dailyQuestionLimitBySection[sec]}
                    min={0}
                    max={sec === 'WRIT' ? 2 : 30}
                    disabled={isLocked}
                    onCommit={(v) => updateLimit(sec, v)}
                  />
                </div>
              ))}
              <div className="space-y-1">
                <label htmlFor="settings-goal-min" className="block text-xs font-medium text-[#4A5955]">
                  {t('cfg.dailyGoalMin')}
                </label>
                <NumericField
                  id="settings-goal-min"
                  value={form.dailyGoalMinutes}
                  min={5}
                  max={120}
                  disabled={isLocked}
                  onCommit={(v) => setForm((prev) => ({ ...prev, dailyGoalMinutes: v }))}
                />
              </div>
            </div>
          </div>
        )}

        {/* Section Drill Defaults */}
        <div className="pt-4 border-t border-[#D4E4DC]/80 space-y-3">
          <div>
            <h3 className="font-sans-display font-semibold text-sm text-[#113C36]">
              {t('settings.drillSectionTitle')}
            </h3>
            <p className="text-xs text-[#4A5955]">{t('settings.drillSectionSub')}</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <div className="space-y-1">
              <label htmlFor="settings-drill-count" className="block text-xs font-medium text-[#4A5955]">
                {t('cfg.drillCountLabel')}
              </label>
              <NumericField
                id="settings-drill-count"
                value={form.sectionDrillQuestionCount}
                min={3}
                max={40}
                disabled={isLocked}
                onCommit={(v) => setForm((prev) => ({ ...prev, sectionDrillQuestionCount: v }))}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="settings-drill-min" className="block text-xs font-medium text-[#4A5955]">
                {t('cfg.drillMinutesLabel')}
              </label>
              <NumericField
                id="settings-drill-min"
                value={form.sectionDrillTimeMinutes}
                min={3}
                max={60}
                disabled={isLocked}
                onCommit={(v) => setForm((prev) => ({ ...prev, sectionDrillTimeMinutes: v }))}
              />
            </div>
          </div>
        </div>

        {!isLocked && (
          <div className="pt-2">
            {JSON.stringify(form) !== JSON.stringify(savedForm) ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] bg-white border border-[#113C36]/25 px-4 py-3 shadow-[0_2px_10px_rgba(17,60,54,0.06)]">
                <div className="inline-flex items-center gap-2 text-xs font-sans-display font-semibold text-[#113C36]">
                  <span className="w-2 h-2 rounded-full bg-[#F29A63] shrink-0" aria-hidden="true" />
                  <span>{t('settings.unsavedChanges')}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => setForm(savedForm)}
                    className="px-3.5 py-2 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-xs font-sans-display font-semibold text-[#4A5955] cursor-pointer transition-[background-color,transform] duration-150 ease-out active:scale-[0.98] disabled:opacity-50"
                  >
                    {t('settings.discardChanges')}
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={handleSavePlan}
                    className="px-5 py-2 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-xs font-sans-display font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-[background-color,transform] duration-150 ease-out active:scale-[0.98] disabled:opacity-50"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>{saving ? t('settings.savingPlan') : t('settings.savePlan')}</span>
                  </button>
                </div>
              </div>
            ) : hasPersonalPrefs ? (
              <div className="flex items-center justify-between gap-3 text-xs text-[#78756E]">
                <span>{t('settings.allSaved')}</span>
                <button
                  type="button"
                  disabled={saving}
                  onClick={handleResetPlanDefaults}
                  className="inline-flex items-center gap-1 font-sans-display font-semibold text-[#4A5955] hover:text-[#113C36] cursor-pointer disabled:opacity-50"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>{t('settings.resetToDefaults')}</span>
                </button>
              </div>
            ) : null}
          </div>
        )}
      </section>

      {/* 2. Your Study Data */}
      <section className="rounded-[16px] bg-white border border-[#E5DFD5] p-6 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 className="font-sans-display font-semibold text-[20px] tracking-[-0.015em] text-[#113C36]">
              {t('settings.studyDataTitle')}
            </h2>
            <p className="text-[13px] text-[#4A5955]">{t('settings.studyDataSub')}</p>
          </div>
          {counts && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#E5F0EA] text-[#113C36] text-xs font-medium tabular-nums whitespace-nowrap">
              <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
              <span>{t('data.bankPreserved', { count: counts.bankQuestionsCount })}</span>
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="rounded-[12px] bg-[#FAF8F5] border border-[#E5DFD5] px-4 py-3">
            <div className="text-xs text-[#78756E]">{t('data.testSessions')}</div>
            <div className="mt-0.5 font-serif-display font-extrabold text-[26px] text-[#113C36] tabular-nums">
              {counts?.sessionsCount ?? 0}
            </div>
          </div>
          <div className="rounded-[12px] bg-[#FAF8F5] border border-[#E5DFD5] px-4 py-3">
            <div className="text-xs text-[#78756E]">{t('data.questionAttempts')}</div>
            <div className="mt-0.5 font-serif-display font-extrabold text-[26px] text-[#113C36] tabular-nums">
              {counts?.attemptsCount ?? 0}
            </div>
          </div>
          <div className="rounded-[12px] bg-[#FAF8F5] border border-[#E5DFD5] px-4 py-3">
            <div className="text-xs text-[#78756E]">{t('data.masteryRecords')}</div>
            <div className="mt-0.5 font-serif-display font-extrabold text-[26px] text-[#113C36] tabular-nums">
              {counts?.evidenceCount ?? 0}
            </div>
          </div>
          <div className="rounded-[12px] bg-[#FAF8F5] border border-[#E5DFD5] px-4 py-3">
            <div className="text-xs text-[#78756E]">{t('data.writingSubmissions')}</div>
            <div className="mt-0.5 font-serif-display font-extrabold text-[26px] text-[#113C36] tabular-nums">
              {counts?.writingCount ?? 0}
            </div>
          </div>
        </div>

        {!resetOpen ? (
          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => api.downloadFile('/api/student/export?format=json', 'selective-lab-progress.json')}
                className="px-3.5 py-2 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-xs font-sans-display font-semibold text-[#113C36] inline-flex items-center gap-1.5 cursor-pointer transition-[background-color,transform] duration-150 ease-out active:scale-[0.98]"
              >
                <Download className="w-3.5 h-3.5" />
                <span>{t('settings.exportJson')}</span>
              </button>
              <button
                type="button"
                onClick={() => api.downloadFile('/api/student/export?format=csv', 'selective-lab-progress.csv')}
                className="px-3.5 py-2 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-xs font-sans-display font-semibold text-[#113C36] inline-flex items-center gap-1.5 cursor-pointer transition-[background-color,transform] duration-150 ease-out active:scale-[0.98]"
              >
                <Download className="w-3.5 h-3.5" />
                <span>{t('settings.exportCsv')}</span>
              </button>
            </div>

            <button
              type="button"
              onClick={() => setResetOpen(true)}
              className="px-4 py-2 rounded-[10px] border border-[#B83A28]/35 bg-[#FDECEB] hover:bg-[#B83A28] hover:text-white text-[#B83A28] text-xs font-sans-display font-semibold inline-flex items-center gap-1.5 transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.98] cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>{t('data.resetProgressBtn')}</span>
            </button>
          </div>
        ) : (
          <div className="rounded-[14px] bg-[#FDECEB] border border-[#B83A28]/30 p-4 space-y-3">
            <div className="flex items-start gap-2.5 text-xs text-[#B83A28]">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <div className="font-sans-display font-semibold">{t('data.resetConfirmTitle')}</div>
                <p className="leading-relaxed">
                  {t('data.resetConfirmPrefix')}{' '}
                  <strong className="font-mono-code">RESET</strong> {t('data.resetConfirmSuffix')}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              <input
                type="text"
                aria-label={t('data.resetPlaceholder')}
                value={resetInput}
                onChange={(e) => setResetInput(e.target.value)}
                placeholder={t('data.resetPlaceholder')}
                className="px-3 py-2 rounded-[10px] border border-[#B83A28]/40 bg-white text-xs font-mono-code text-[#113C36] w-44 focus:outline-none"
              />
              <button
                type="button"
                disabled={resetting || resetInput.trim().toUpperCase() !== 'RESET'}
                onClick={handleConfirmResetProgress}
                className="px-4 py-2 rounded-[10px] bg-[#B83A28] hover:bg-[#962D1E] text-white text-xs font-sans-display font-semibold cursor-pointer disabled:opacity-40"
              >
                {resetting ? t('data.clearing') : t('data.confirmReset')}
              </button>
              <button
                type="button"
                disabled={resetting}
                onClick={() => {
                  setResetOpen(false);
                  setResetInput('');
                }}
                className="px-3.5 py-2 rounded-[10px] border border-[#CFC6B9] bg-white text-xs font-sans-display font-semibold text-[#4A5955] cursor-pointer"
              >
                {t('home.modalCancel')}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* 3. Your Flagged Questions */}
      <section className="rounded-[16px] bg-white border border-[#E5DFD5] p-6 space-y-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Flag className="w-4 h-4 text-[#113C36]" />
            <h2 className="font-sans-display font-semibold text-[18px] text-[#113C36]">
              {t('settings.flagsTitle')}
            </h2>
          </div>
          <p className="text-[13px] text-[#4A5955]">{t('settings.flagsSub')}</p>
        </div>

        {flags.length === 0 ? (
          <p className="text-xs text-[#78756E]">{t('settings.flagsEmpty')}</p>
        ) : (
          <div className="divide-y divide-[#E5DFD5] border-t border-b border-[#E5DFD5]">
            {flags.map((flag) => (
              <div key={flag.flagId} className="py-3 flex flex-wrap items-center justify-between gap-3 text-xs">
                <div className="space-y-0.5 min-w-0 flex-1">
                  <div className="font-mono-code font-semibold text-[#113C36] break-all">
                    {flag.questionId}
                  </div>
                  <div className="text-[#4A5955] break-words">
                    {flag.reason}
                    {flag.notes ? ` — ${flag.notes}` : ''}
                  </div>
                  <div className="text-[11px] text-[#78756E] tabular-nums">
                    {formatDate(flag.createdAt, true)}
                  </div>
                </div>
                <span
                  className={`px-2.5 py-1 rounded-full text-[11px] font-sans-display font-semibold shrink-0 ${
                    flag.status === 'resolved'
                      ? 'bg-[#E5F0EA] text-[#1D6346]'
                      : 'bg-[#FDF0E2] text-[#A35116]'
                  }`}
                >
                  {flag.status === 'resolved' ? t('settings.flagResolved') : t('settings.flagOpen')}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 4. Replay Guided Walkthrough */}
      <section className="rounded-[16px] bg-[#FAF8F5] border border-[#E5DFD5] p-5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-9 h-9 rounded-[10px] bg-[#E5F0EA] text-[#113C36] flex items-center justify-center shrink-0">
            <Compass className="w-4 h-4" />
          </div>
          <div className="space-y-0.5 min-w-0">
            <h2 className="font-sans-display font-semibold text-[15px] text-[#113C36]">
              {t('settings.tourTitle')}
            </h2>
            <p className="text-xs text-[#4A5955]">{t('settings.tourSub')}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onReplayTour}
          className="px-4 py-2 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#F3EFE8] text-xs font-sans-display font-semibold text-[#113C36] cursor-pointer transition-[background-color,transform] duration-150 ease-out active:scale-[0.98] whitespace-nowrap"
        >
          {t('settings.replayTour')}
        </button>
      </section>

      {/* 5. Account & Delete Account */}
      <section className="rounded-[16px] bg-white border border-[#E5DFD5] p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-[#E5DFD5]">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-full bg-[#F3EFE8] text-[#113C36] flex items-center justify-center shrink-0">
              <UserRound className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="text-xs text-[#78756E]">{t('settings.accountSignedInAs')}</div>
              <div className="font-sans-display font-semibold text-sm text-[#113C36] truncate">
                {data?.email || data?.studentId}
              </div>
            </div>
          </div>
          <span className="px-2.5 py-1 rounded-full bg-[#F3EFE8] text-xs font-medium text-[#4A5955]">
            {data?.role === 'admin' ? t('learners.adminRoleTag') : t('learners.studentRoleTag')}
          </span>
        </div>

        <div className="space-y-3">
          <div className="space-y-1">
            <h2 className="font-sans-display font-semibold text-[16px] text-[#B83A28]">
              {t('settings.deleteAccountTitle')}
            </h2>
            <p className="text-xs text-[#4A5955] leading-relaxed max-w-2xl">
              {t('settings.deleteAccountSub')}
            </p>
          </div>

          {!deleteOpen ? (
            <button
              type="button"
              onClick={() => setDeleteOpen(true)}
              className="px-4 py-2 rounded-[10px] border border-[#B83A28]/35 bg-[#FDECEB] hover:bg-[#B83A28] hover:text-white text-[#B83A28] text-xs font-sans-display font-semibold inline-flex items-center gap-1.5 transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.98] cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>{t('settings.deleteAccountBtn')}</span>
            </button>
          ) : (
            <div className="rounded-[14px] bg-[#FDECEB] border border-[#B83A28]/30 p-4 space-y-3">
              <div className="flex items-start gap-2.5 text-xs text-[#B83A28]">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <div className="font-sans-display font-semibold">
                    {t('settings.deleteConfirmTitle')}
                  </div>
                  <p className="leading-relaxed">
                    {t('settings.deleteConfirmPrefix')}{' '}
                    <strong className="font-mono-code">DELETE</strong>{' '}
                    {t('settings.deleteConfirmSuffix')}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2.5">
                <input
                  type="text"
                  aria-label={t('settings.deletePlaceholder')}
                  value={deleteInput}
                  onChange={(e) => setDeleteInput(e.target.value)}
                  placeholder={t('settings.deletePlaceholder')}
                  className="px-3 py-2 rounded-[10px] border border-[#B83A28]/40 bg-white text-xs font-mono-code text-[#113C36] w-44 focus:outline-none"
                />
                <button
                  type="button"
                  disabled={deleting || deleteInput.trim().toUpperCase() !== 'DELETE'}
                  onClick={handleConfirmDeleteAccount}
                  className="px-4 py-2 rounded-[10px] bg-[#B83A28] hover:bg-[#962D1E] text-white text-xs font-sans-display font-semibold cursor-pointer disabled:opacity-40"
                >
                  {deleting ? t('settings.deletingAccount') : t('settings.confirmDeleteBtn')}
                </button>
                <button
                  type="button"
                  disabled={deleting}
                  onClick={() => {
                    setDeleteOpen(false);
                    setDeleteInput('');
                  }}
                  className="px-3.5 py-2 rounded-[10px] border border-[#CFC6B9] bg-white text-xs font-sans-display font-semibold text-[#4A5955] cursor-pointer"
                >
                  {t('home.modalCancel')}
                </button>
              </div>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
