import { createSession } from '../../sessionLaunch';
import { useCallback, useRef, useState } from 'react';
import type { ApiError } from '../../api';
import { useI18n } from '../../i18n';

/**
 * Starts a repair drill and hands the new session id to `onLaunched`. An already-running test
 * (409) opens that test instead; an empty pool becomes a calm message rather than an error.
 */
export function useRepairDrillLaunch(onLaunched: (sessionId: string) => void) {
  const { t } = useI18n();
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState('');
  const busyRef = useRef(false);

  const launch = useCallback(
    async (payload: { mode: 'repair_drill'; questionIds?: string[] }) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setLaunching(true);
      setError('');
      try {
        const res = await createSession(payload);
        onLaunched(res.sessionId);
      } catch (err) {
        const apiErr = err as ApiError;
        if (apiErr?.activeSessionId) {
          onLaunched(apiErr.activeSessionId);
          return;
        }
        setError(apiErr?.code === 'repair_pool_empty' ? t('repair.poolEmptyError') : t('repair.launchError'));
      } finally {
        busyRef.current = false;
        setLaunching(false);
      }
    },
    [onLaunched, t]
  );

  return { launch, launching, error, clearError: useCallback(() => setError(''), []) };
}
