import { useSyncExternalStore } from 'react';

/**
 * Exam clock kept outside React state. The session player root only subscribes to derived
 * values that rarely change (e.g. "time is up"), while <ExamTimer> re-renders on each tick,
 * so the question workspace no longer re-renders 2–3×/sec during an exam.
 */
export interface SessionClock {
  getElapsedSec(): number;
  /** Seconds left against the server deadline (or time limit), null when untimed. */
  getRemainingSec(): number | null;
  setElapsed(sec: number): void;
  setDeadline(deadlineAtIso: string | undefined, timeLimitSec: number | undefined): void;
  /** Re-anchor "now" to the server clock (handles device clock skew and sleep). */
  setServerNow(serverNowIso: string | undefined): void;
  setRunning(running: boolean): void;
  subscribe(listener: () => void): () => void;
}

const TICK_MS = 500;

export function createSessionClock(now: () => number = () => performance.now()): SessionClock {
  let elapsedBase = 0;
  let elapsedAnchor = now();
  let running = false;
  let deadlineMs: number | null = null;
  let timeLimitSec: number | null = null;
  let serverAnchor: { serverMs: number; perfMs: number } | null = null;
  let timer: number | null = null;
  const listeners = new Set<() => void>();

  const emit = () => listeners.forEach((l) => l());
  const syncTimer = () => {
    const shouldTick = running && listeners.size > 0;
    if (shouldTick && timer === null) timer = window.setInterval(emit, TICK_MS);
    if (!shouldTick && timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };

  const getElapsedSec = () =>
    running ? elapsedBase + Math.floor((now() - elapsedAnchor) / 1000) : elapsedBase;

  return {
    getElapsedSec,
    getRemainingSec() {
      if (deadlineMs !== null) {
        const nowMs = serverAnchor ? serverAnchor.serverMs + (now() - serverAnchor.perfMs) : Date.now();
        return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
      }
      if (timeLimitSec) return Math.max(0, timeLimitSec - getElapsedSec());
      return null;
    },
    setElapsed(sec) {
      elapsedBase = Math.max(0, Math.floor(sec || 0));
      elapsedAnchor = now();
      emit();
    },
    setDeadline(deadlineAtIso, limitSec) {
      const parsed = deadlineAtIso ? Date.parse(deadlineAtIso) : NaN;
      deadlineMs = Number.isNaN(parsed) ? null : parsed;
      timeLimitSec = limitSec && limitSec > 0 ? limitSec : null;
      emit();
    },
    setServerNow(serverNowIso) {
      const parsed = serverNowIso ? Date.parse(serverNowIso) : NaN;
      serverAnchor = { serverMs: Number.isNaN(parsed) ? Date.now() : parsed, perfMs: now() };
    },
    setRunning(next) {
      if (next === running) return;
      if (!next) elapsedBase = getElapsedSec();
      else elapsedAnchor = now();
      running = next;
      syncTimer();
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      syncTimer();
      return () => {
        listeners.delete(listener);
        syncTimer();
      };
    },
  };
}

/** Subscribe to a derived clock value; re-renders only when the selected value changes. */
export function useClockValue<T extends string | number | boolean | null>(
  clock: SessionClock,
  select: (clock: SessionClock) => T
): T {
  return useSyncExternalStore(clock.subscribe, () => select(clock), () => select(clock));
}

export function formatTimer(totalSec: number): string {
  const safe = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
