import { useEffect, useState } from 'react';
import { api, type AdminLearnerSummary } from '../../api';
import { useI18n } from '../../i18n';
import {
  DEFAULT_AUTO_CALIBRATE,
  DEFAULT_LEARNING_CONFIG,
  DEFAULT_POOL_POLICY,
  type LearningConfig,
} from '../../../shared/contracts';
import { LearnerOverrideCard } from './LearnerOverrideCard';
import { PlatformDefaultsSection, type ConfigVersionSummary } from './PlatformDefaultsSection';

interface AutoCalibrateConfigPanelProps {
  onNotice: (msg: string) => void;
  onError: (msg: string) => void;
  monitoredStudentId?: string | null;
  monitoredLearner?: AdminLearnerSummary | null;
}

/** Adaptive tab: per-learner override on top, platform defaults and policies below. */
export function AutoCalibrateConfigPanel({
  onNotice,
  onError,
  monitoredLearner = null,
}: AutoCalibrateConfigPanelProps) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [savingGlobal, setSavingGlobal] = useState(false);
  const [config, setConfig] = useState<LearningConfig>(DEFAULT_LEARNING_CONFIG);
  const [savedConfig, setSavedConfig] = useState<LearningConfig>(DEFAULT_LEARNING_CONFIG);
  const [versionNumber, setVersionNumber] = useState(1);
  const [notes, setNotes] = useState('');
  const [history, setHistory] = useState<ConfigVersionSummary[]>([]);

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
    return <div className="p-10 text-center text-sm text-[#615E57]">{t('cfg.loading')}</div>;
  }

  return (
    <div className="space-y-8">
      {/* 1. Per-Learner Daily Plan Override */}
      {monitoredLearner ? (
        <LearnerOverrideCard learner={monitoredLearner} config={config} onNotice={onNotice} onError={onError} />
      ) : (
        <div className="rounded-[14px] bg-[#FAF8F5] border border-[#E5DFD5] px-5 py-4 space-y-1">
          <div className="text-xs font-sans-display font-semibold text-[#113C36]">
            {t('cfg.perStudentPreviewTitle')}
          </div>
          <p className="text-xs text-[#4A5955]">{t('cfg.perStudentPreviewEmpty')}</p>
        </div>
      )}

      {/* 2. Platform Defaults & Admin-Only Policies */}
      <PlatformDefaultsSection
        config={config}
        setConfig={setConfig}
        globalDirty={JSON.stringify(config) !== JSON.stringify(savedConfig)}
        versionNumber={versionNumber}
        history={history}
        notes={notes}
        onChangeNotes={setNotes}
        savingGlobal={savingGlobal}
        onSave={() => void handleSaveGlobal()}
        onDiscard={() => {
          setConfig(savedConfig);
          setNotes('');
        }}
      />
    </div>
  );
}
