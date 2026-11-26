import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchCachedResource,
  peekCachedResource,
  type CachedResourceKey,
  type CachedResourceMap,
} from './api';

export interface CachedResourceState<K extends CachedResourceKey> {
  data: CachedResourceMap[K] | null;
  /** True only while there is nothing to paint yet (no cached copy, first request pending). */
  loading: boolean;
  error: string;
  setData: (update: (prev: CachedResourceMap[K] | null) => CachedResourceMap[K] | null) => void;
  /** Force a network refresh (keeps showing the current copy while it loads). */
  reload: () => Promise<void>;
}

/**
 * Stale-while-revalidate view data: paints the cached copy synchronously on mount,
 * then revalidates in the background (deduplicated with hover prefetches).
 */
export function useCachedResource<K extends CachedResourceKey>(
  key: K,
  options: { fallbackError?: string; onData?: (data: CachedResourceMap[K]) => void } = {}
): CachedResourceState<K> {
  const [data, setDataState] = useState<CachedResourceMap[K] | null>(() => peekCachedResource(key) ?? null);
  const [loading, setLoading] = useState(() => peekCachedResource(key) === undefined);
  const [error, setError] = useState('');
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const load = useCallback(
    async (force: boolean, isActive: () => boolean) => {
      try {
        const res = await fetchCachedResource(key, { force });
        if (!isActive()) return;
        setDataState(res);
        setError('');
        optionsRef.current.onData?.(res);
      } catch (err) {
        if (!isActive()) return;
        setError(err instanceof Error ? err.message : optionsRef.current.fallbackError || 'Request failed.');
      } finally {
        if (isActive()) setLoading(false);
      }
    },
    [key]
  );

  useEffect(() => {
    let active = true;
    void load(false, () => active);
    return () => {
      active = false;
    };
  }, [load]);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reload = useCallback(() => load(true, () => mountedRef.current), [load]);
  const setData = useCallback(
    (update: (prev: CachedResourceMap[K] | null) => CachedResourceMap[K] | null) => setDataState(update),
    []
  );

  return { data, loading, error, setData, reload };
}
