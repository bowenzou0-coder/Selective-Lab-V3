import { useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Save,
  Sparkles,
} from 'lucide-react';
import { api } from '../../api';
import { useI18n } from '../../i18n';
import {
  DEFAULT_AUTO_CALIBRATE,
  DEFAULT_LEARNING_CONFIG,
  DEFAULT_POOL_POLICY,
  type DailyFocusPlan,
  type LearningConfig,
  type SectionCode,
} from '../../../shared/contracts';
import { SKILLS_TAXONOMY } from '../../../shared/skills';

const SKILL_NAME_MAP = new Map(SKILLS_TAXONOMY.map((s) => [s.skillId, s.displayName]));

interface AutoCalibrateConfigPanelProps {
  onNotice: (msg: string) => void;
  onError: (msg: string) => void;
  monitoredStudentId?: string | null;
  monitoredLearner?: import('../../api').AdminLearnerSummary | null;
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

  const commit = (raw: string) => {
    const parsed = Number(raw);
    if (raw.trim() === '' || Number.isNaN(parsed)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, parsed));
    onCommit(clamped);
    setDraft(String(clamped));
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
        setDraft(nextRaw);
        const parsed = Number(nextRaw);
        if (nextRaw.trim() !== '' && !Number.isNaN(parsed)) {
          onCommit(Math.min(max, Math.max(min, parsed)));
        }
      }}
      onBlur={() => {
        setFocused(false);
        commit(draft);
      }}
      className="w-full px-3 py-2 rounded-[10px] border border-[#CFC6B9] bg-white text-sm text-[#113C36] tabular-nums disabled:bg-[#F3EFE8] disabled:text-[#78756E] disabled:cursor-not-allowed focus:outline-none focus:border-[#113C36]"
    />
  );
}

export function AutoCalibrateConfigPanel({
  onNotice,
  onError,
  monitoredStudentId,
  monitoredLearner = null,
}: AutoCalibrateConfigPanelProps) {
  const { t, sectionShortLabel, skillName, formatDate } = useI18n();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [recalibrating, setRecalibrating] = useState(false);
  const [config, setConfig] = useState<LearningConfig>(DEFAULT_LEARNING_CONFIG);
  const [versionNumber, setVersionNumber] = useState(1);
  const [notes, setNotes] = useState('');
  const [history, setHistory] = useState<
    { configVersionId: string; versionNumber: number; notes?: string; createdAt: string }[]
  >([]);
  const [todayPlan, setTodayPlan] = useState<DailyFocusPlan | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [cfgRes, dashRes] = await Promise.all([
        api.getAdminConfig(),
        monitoredStudentId === null
          ? Promise.resolve({ dailyFocusPlan: undefined })
          : api
              .getAdminDailyPlan(monitoredStudentId || undefined)
              .then((r) => ({ dailyFocusPlan: r.plan ?? undefined }))
              .catch(() => ({ dailyFocusPlan: undefined })),
      ]);
      const loaded = cfgRes.active.config;
      setConfig({
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
      });
      setVersionNumber(cfgRes.active.versionNumber);
      setHistory(cfgRes.history || []);
      if (dashRes?.dailyFocusPlan) {
        setTodayPlan(dashRes.dailyFocusPlan);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Unable to load adaptive settings.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const autoCal = config.autoCalibrate ?? DEFAULT_AUTO_CALIBRATE;
  const poolPolicy = config.poolPolicy ?? DEFAULT_POOL_POLICY;

  const updateAutoCal = (patch: Partial<typeof autoCal>) => {
    setConfig((prev) => {
      const merged = { ...(prev.autoCalibrate ?? DEFAULT_AUTO_CALIBRATE), ...patch };
      if (merged.minDailyQuestions > merged.maxDailyQuestions) {
        merged.maxDailyQuestions = merged.minDailyQuestions;
      }
      return { ...prev, autoCalibrate: merged };
    });
  };

  const updateDailyLimit = (section: SectionCode, value: number) => {
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

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await api.saveAdminConfig(config, notes.trim() || undefined);
      setVersionNumber(res.versionNumber);
      setNotes('');
      onNotice(`Saved adaptive settings (version ${res.versionNumber}).`);
      const cfgRes = await api.getAdminConfig();
      setHistory(cfgRes.history || []);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Unable to save adaptive settings.');
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    if (monitoredStudentId === null) {
      setTodayPlan(null);
      return;
    }
    api
      .getAdminDailyPlan(monitoredStudentId || undefined)
      .then((res) => {
        if (!cancelled) {
          setTodayPlan(res.plan);
        }
      })
      .catch(() => {
        // ignore plan refresh errors on learner switch
      });
    return () => {
      cancelled = true;
    };
  }, [monitoredStudentId]);

  const handleRecalibrateNow = async () => {
    if (monitoredStudentId === null) {
      onError(t('cfg.selectLearnerBeforeRecalibrate'));
      return;
    }
    setRecalibrating(true);
    try {
      await api.saveAdminConfig(config, 'Auto-Calibrate refresh');
      const res = await api.recalibrateDailyPlan(
        config,
        monitoredStudentId || undefined,
      );
      if (res.plan) {
        setTodayPlan(res.plan);
      }
      onNotice(
        res.plan?.source === 'gemini'
          ? 'Gemini Decisions 1 recalculated today’s daily mix.'
          : 'Recalculated today’s daily mix using deterministic fallback.'
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Unable to recalibrate today’s plan.');
    } finally {
      setRecalibrating(false);
    }
  };

  if (loading) {
    return (
      <div className="p-10 text-center text-sm text-[#78756E]">
        {t('cfg.loading')}
      </div>
    );
  }

  const decidedLimits =
    todayPlan?.dailyQuestionLimitBySection ?? config.sessionDefaults.dailyQuestionLimitBySection;
  const decidedTotal =
    (decidedLimits.READ || 0) +
    (decidedLimits.MATH || 0) +
    (decidedLimits.THINK || 0) +
    (decidedLimits.WRIT || 0);

  const manualDailyTotal =
    (config.sessionDefaults.dailyQuestionLimitBySection.READ || 0) +
    (config.sessionDefaults.dailyQuestionLimitBySection.MATH || 0) +
    (config.sessionDefaults.dailyQuestionLimitBySection.THINK || 0) +
    (config.sessionDefaults.dailyQuestionLimitBySection.WRIT || 0);

  return (
    <div className="space-y-6">
      {/* Unified Card 1: Daily Practice Plan (Auto-Calibrate OR Manual — never both locked/unlocked at once) */}
      <section
        className={`rounded-[16px] border p-6 space-y-5 transition-colors ${
          autoCal.enabled
            ? 'bg-[#E5F0EA] border-[#C5DDD1]'
            : 'bg-white border-[#E5DFD5]'
        }`}
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1.5 max-w-2xl min-w-0">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-[#113C36] shrink-0" />
              <h2 className="font-sans-display font-semibold text-[18px] text-[#113C36]">
                {t('cfg.title')}
              </h2>
            </div>
            <p className="text-[13px] text-[#4A5955] leading-relaxed">
              {t('cfg.desc')}
            </p>
          </div>

          {/* Explicit 2-way segmented mode selector */}
          <div
            role="group"
            aria-label={t('cfg.title')}
            className="inline-flex flex-wrap items-center p-1 rounded-[12px] bg-white border border-[#CFC6B9] gap-1 max-w-full"
          >
            <button
              type="button"
              aria-pressed={autoCal.enabled}
              onClick={() => updateAutoCal({ enabled: true })}
              className={`px-3.5 py-1.5 rounded-[9px] text-xs font-sans-display font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                autoCal.enabled
                  ? 'bg-[#113C36] text-white'
                  : 'text-[#4A5955] hover:text-[#113C36]'
              }`}
            >
              {t('cfg.modeAuto')}
            </button>
            <button
              type="button"
              aria-pressed={!autoCal.enabled}
              onClick={() => updateAutoCal({ enabled: false })}
              className={`px-3.5 py-1.5 rounded-[9px] text-xs font-sans-display font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                !autoCal.enabled
                  ? 'bg-[#113C36] text-white'
                  : 'text-[#4A5955] hover:text-[#113C36]'
              }`}
            >
              {t('cfg.modeManual')}
            </button>
          </div>
        </div>

        {autoCal.enabled ? (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-[#4A5955] leading-relaxed max-w-2xl">
                {t('cfg.autoDesc')}
              </p>
              <span className="px-2.5 py-1 rounded-full bg-white border border-[#C5DDD1] text-[11px] font-sans-display font-semibold text-[#113C36] whitespace-nowrap">
                {t('cfg.sharedRulesBadge')}
              </span>
            </div>

            {/* Flexible Question Volume Guardrails */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="rounded-[12px] bg-white/95 border border-[#C5DDD1] p-3.5 space-y-1.5 min-w-0">
                <label htmlFor="ac-min-q" className="block text-xs font-sans-display font-semibold text-[#113C36]">
                  {t('cfg.minDailyQ')}
                </label>
                <NumericInput
                  id="ac-min-q"
                  value={autoCal.minDailyQuestions}
                  min={3}
                  max={30}
                  onCommit={(v) => updateAutoCal({ minDailyQuestions: v })}
                />
              </div>

              <div className="rounded-[12px] bg-white/95 border border-[#C5DDD1] p-3.5 space-y-1.5 min-w-0">
                <label htmlFor="ac-max-q" className="block text-xs font-sans-display font-semibold text-[#113C36]">
                  {t('cfg.maxDailyQ')}
                </label>
                <NumericInput
                  id="ac-max-q"
                  value={autoCal.maxDailyQuestions}
                  min={autoCal.minDailyQuestions}
                  max={40}
                  onCommit={(v) => updateAutoCal({ maxDailyQuestions: v })}
                />
              </div>

              <div className="rounded-[12px] bg-white/95 border border-[#C5DDD1] p-3.5 flex flex-col justify-between gap-2 min-w-0">
                <span className="text-xs font-sans-display font-semibold text-[#113C36]">
                  {t('cfg.writingScheduling')}
                </span>
                <label className="inline-flex items-center gap-2 text-xs text-[#4A5955] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={autoCal.includeWriting}
                    onChange={(e) => updateAutoCal({ includeWriting: e.target.checked })}
                    className="accent-[#113C36]"
                  />
                  <span>{t('cfg.includeWriting')}</span>
                </label>
              </div>
            </div>

            {/* Live Today's Decided Plan Box */}
            {monitoredLearner ? (
              <div className="rounded-[14px] bg-white border border-[#C5DDD1] p-4 space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="space-y-1 min-w-0">
                    <div className="text-xs font-sans-display font-semibold text-[#113C36]">
                      {t('cfg.learnerDecidedMixTitle', {
                        name:
                          monitoredLearner.displayName ||
                          monitoredLearner.email ||
                          monitoredLearner.uid,
                        total: decidedTotal,
                        minutes:
                          todayPlan?.dailyGoalMinutes ?? config.sessionDefaults.dailyGoalMinutes,
                      })}
                    </div>
                    <p className="text-[11px] text-[#4A5955] leading-relaxed">
                      {t('cfg.personalPlanHint')}
                    </p>
                    {todayPlan?.modelId && (
                      <div className="text-[11px] text-[#78756E] font-mono-code">
                        {todayPlan.source === 'gemini' ? todayPlan.modelId : 'deterministic-fallback'}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    disabled={recalibrating}
                    onClick={handleRecalibrateNow}
                    className="px-3.5 py-2 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-xs font-sans-display font-semibold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${recalibrating ? 'animate-spin' : ''}`} />
                    <span>{recalibrating ? t('cfg.recalibratingBtn') : t('cfg.recalibrateBtn')}</span>
                  </button>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                  {(['READ', 'MATH', 'THINK', 'WRIT'] as SectionCode[]).map((sec) => (
                    <div key={sec} className="rounded-[10px] bg-[#FAF8F5] border border-[#E5DFD5] px-3 py-2 min-w-0">
                      <div className="text-[11px] text-[#78756E]">
                        {sectionShortLabel(sec)}
                      </div>
                      <div className="font-serif-display font-extrabold text-[22px] text-[#113C36] tabular-nums">
                        {decidedLimits[sec] ?? 0}
                      </div>
                    </div>
                  ))}
                </div>

                {todayPlan && (
                  <div className="space-y-2 pt-1">
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
            ) : (
              <div className="rounded-[14px] bg-white border border-[#C5DDD1] p-4 space-y-1.5">
                <div className="text-xs font-sans-display font-semibold text-[#113C36]">
                  {t('cfg.perStudentPreviewTitle')}
                </div>
                <p className="text-xs text-[#4A5955] leading-relaxed">
                  {t('cfg.perStudentPreviewEmpty', {
                    min: autoCal.minDailyQuestions,
                    max: autoCal.maxDailyQuestions,
                  })}
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-[#4A5955] leading-relaxed">
                {t('cfg.manualDesc')}
              </p>
              <span className="px-3 py-1 rounded-full bg-[#F3EFE8] text-xs font-medium text-[#113C36] tabular-nums whitespace-nowrap">
                {t('cfg.questionsPerDay', { count: manualDailyTotal })}
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              {(['READ', 'MATH', 'THINK', 'WRIT'] as SectionCode[]).map((sec) => (
                <div key={sec} className="space-y-1 min-w-0">
                  <label htmlFor={`manual-${sec}`} className="block text-xs font-medium text-[#4A5955]">
                    {t('cfg.sectionPerDay', { section: sectionShortLabel(sec) })}
                  </label>
                  <NumericInput
                    id={`manual-${sec}`}
                    value={config.sessionDefaults.dailyQuestionLimitBySection[sec]}
                    min={0}
                    max={sec === 'WRIT' ? 2 : 30}
                    onCommit={(v) => updateDailyLimit(sec, v)}
                  />
                </div>
              ))}
              <div className="space-y-1 min-w-0">
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
      </section>

      {/* Card 2: Separate Section Drill Defaults (independent of Daily Auto-Calibrate) */}
      <section className="rounded-[16px] bg-white border border-[#E5DFD5] p-6 space-y-4">
        <div>
          <h3 className="font-sans-display font-semibold text-[16px] text-[#113C36]">
            {t('cfg.drillDefaultsTitle')}
          </h3>
          <p className="text-xs text-[#4A5955] mt-1 leading-relaxed">
            {t('cfg.drillDefaultsDesc')}
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1 min-w-0">
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
          <div className="space-y-1 min-w-0">
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

      {/* Pool Refresh & Completion Policy */}
      <section className="rounded-[16px] bg-white border border-[#E5DFD5] p-6 space-y-4">
        <div>
          <h3 className="font-sans-display font-semibold text-[16px] text-[#113C36]">
            {t('cfg.poolPolicyTitle')}
          </h3>
          <p className="text-xs text-[#4A5955] mt-1 leading-relaxed">
            {t('cfg.poolPolicyDesc')}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() =>
              setConfig((prev) => ({ ...prev, poolPolicy: { autoRetireMastered: false } }))
            }
            className={`p-4 rounded-[12px] border text-left space-y-1.5 cursor-pointer transition-colors ${
              !poolPolicy.autoRetireMastered
                ? 'bg-[#E5F0EA] border-[#113C36] text-[#113C36]'
                : 'bg-[#FAF8F5] border-[#E5DFD5] text-[#4A5955]'
            }`}
          >
            <div className="font-sans-display font-semibold text-sm text-[#113C36]">
              {t('cfg.keepMasteredTitle')}
            </div>
            <p className="text-xs text-[#4A5955] leading-relaxed">
              {t('cfg.keepMasteredDesc')}
            </p>
          </button>

          <button
            type="button"
            onClick={() =>
              setConfig((prev) => ({ ...prev, poolPolicy: { autoRetireMastered: true } }))
            }
            className={`p-4 rounded-[12px] border text-left space-y-1.5 cursor-pointer transition-colors ${
              poolPolicy.autoRetireMastered
                ? 'bg-[#E5F0EA] border-[#113C36] text-[#113C36]'
                : 'bg-[#FAF8F5] border-[#E5DFD5] text-[#4A5955]'
            }`}
          >
            <div className="font-sans-display font-semibold text-sm text-[#113C36]">
              {t('cfg.retireMasteredTitle')}
            </div>
            <p className="text-xs text-[#4A5955] leading-relaxed">
              {t('cfg.retireMasteredDesc')}
            </p>
          </button>
        </div>
      </section>

      {/* Collapsible Advanced Scheduling & Version History */}
      <section className="rounded-[16px] bg-white border border-[#E5DFD5] overflow-hidden">
        <button
          type="button"
          aria-expanded={showAdvanced}
          onClick={() => setShowAdvanced((v) => !v)}
          className="w-full px-6 py-4 flex items-center justify-between text-left hover:bg-[#FAF8F5] cursor-pointer"
        >
          <div className="min-w-0">
            <div className="font-sans-display font-semibold text-sm text-[#113C36]">
              {t('cfg.advancedTitle')}
            </div>
            <div className="text-xs text-[#78756E]">
              {t('cfg.advancedSub', { version: versionNumber, count: history.length })}
            </div>
          </div>
          {showAdvanced ? (
            <ChevronUp className="w-4 h-4 text-[#78756E] shrink-0" />
          ) : (
            <ChevronDown className="w-4 h-4 text-[#78756E] shrink-0" />
          )}
        </button>

        {showAdvanced && (
          <div className="px-6 pb-6 pt-3 border-t border-[#E5DFD5] space-y-5">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="space-y-1 min-w-0">
                <label className="block text-xs text-[#4A5955]">{t('cfg.spacedWeight')}</label>
                <NumericInput
                  value={config.scheduling.spacedReviewWeight}
                  min={0.1}
                  max={5}
                  step={0.1}
                  onCommit={(v) =>
                    setConfig((p) => ({ ...p, scheduling: { ...p.scheduling, spacedReviewWeight: v } }))
                  }
                />
              </div>
              <div className="space-y-1 min-w-0">
                <label className="block text-xs text-[#4A5955]">{t('cfg.weakestWeight')}</label>
                <NumericInput
                  value={config.scheduling.weakestSkillWeight}
                  min={0.1}
                  max={5}
                  step={0.1}
                  onCommit={(v) =>
                    setConfig((p) => ({ ...p, scheduling: { ...p.scheduling, weakestSkillWeight: v } }))
                  }
                />
              </div>
              <div className="space-y-1 min-w-0">
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
              <div className="space-y-1 min-w-0">
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

      {/* Sticky Save Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] bg-[#FAF8F5] border border-[#E5DFD5] px-5 py-3.5">
        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={t('cfg.changeNotePlaceholder')}
          className="flex-1 min-w-[200px] px-3 py-2 rounded-[10px] border border-[#CFC6B9] bg-white text-xs text-[#113C36]"
        />
        <button
          type="button"
          disabled={saving}
          onClick={handleSave}
          className="px-5 py-2 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white text-xs font-sans-display font-semibold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
        >
          <Save className="w-3.5 h-3.5" />
          <span>{saving ? t('cfg.saving') : t('cfg.saveSettings')}</span>
        </button>
      </div>
    </div>
  );
}
