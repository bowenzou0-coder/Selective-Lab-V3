import type { SessionCheckpoint } from '../../../shared/contracts';

/** Unsent checkpoint kept in localStorage so a reload or network drop never loses answers. */
export interface LocalDraftRecord {
  checkpoint: SessionCheckpoint;
  savedAtMs: number;
}

export function getDraftStorageKey(studentId: string, sessionId: string): string {
  return `selective_lab_draft:${studentId}:${sessionId}`;
}

export function readLocalDraft(key: string): LocalDraftRecord | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LocalDraftRecord;
    if (parsed && parsed.checkpoint && typeof parsed.savedAtMs === 'number') {
      return parsed;
    }
  } catch {
    // ignore storage errors
  }
  return null;
}

export function writeLocalDraft(key: string, cp: SessionCheckpoint): void {
  try {
    const record: LocalDraftRecord = { checkpoint: cp, savedAtMs: Date.now() };
    window.localStorage.setItem(key, JSON.stringify(record));
  } catch {
    // ignore storage errors
  }
}

export function clearLocalDraft(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore storage errors
  }
}
