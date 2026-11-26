import type { SessionRecord } from './contracts.ts';

/**
 * Slim per-session metadata for dashboard aggregates (streaks, today's minutes, counts).
 * Never carries checkpoint answers, planned ids, section state or submission summaries.
 */
export interface SessionSummaryRow {
  sessionId: string;
  title?: string;
  expiredAutoSubmitted?: boolean;
  /** Displayed in the localized repair-drill title. */
  plannedQuestionCount?: number;
  mode: SessionRecord['mode'];
  status: SessionRecord['status'];
  isSandbox: boolean;
  sectionFilter?: SessionRecord['sectionFilter'];
  startedAt: string;
  completedAt?: string;
  correctSlots: number;
  totalSlots: number;
  /** checkpoint.elapsedSec, or 0 when the session has no checkpoint yet. */
  elapsedSec: number;
}

export function toSessionSummary(s: SessionRecord): SessionSummaryRow {
  return {
    sessionId: s.sessionId,
    ...(s.title !== undefined && { title: s.title }),
    mode: s.mode,
    status: s.status,
    isSandbox: Boolean(s.isSandbox),
    ...(s.sectionFilter !== undefined && { sectionFilter: s.sectionFilter }),
    startedAt: s.startedAt,
    ...(s.completedAt !== undefined && { completedAt: s.completedAt }),
    correctSlots: s.correctSlots ?? 0,
    totalSlots: s.totalSlots ?? 0,
    elapsedSec: s.checkpoint?.elapsedSec ?? 0,
    ...(s.expiredAutoSubmitted !== undefined && { expiredAutoSubmitted: s.expiredAutoSubmitted }),
    ...(s.mode === 'repair_drill' && { plannedQuestionCount: s.plannedQuestionIds?.length ?? 0 }),
  };
}
