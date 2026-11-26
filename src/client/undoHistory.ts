import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import { hasOpenModal } from './components/session/examShortcuts';

export interface UndoKeyEventLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  defaultPrevented?: boolean;
  repeat?: boolean;
  target?: unknown;
}

const NON_TEXT_INPUT_TYPES = new Set([
  'checkbox',
  'radio',
  'button',
  'submit',
  'reset',
  'range',
  'color',
  'file',
]);

/**
 * True when focus sits inside a free-text field whose native browser `Ctrl+Z`
 * should take priority over app-level undo. Checkboxes, radios, buttons and
 * `<select>` controls return `false` so app-level undo still works immediately.
 */
export function isNativeTextUndoTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as {
    tagName?: string;
    type?: string;
    isContentEditable?: boolean;
    closest?: (selector: string) => unknown;
  };
  const tag = (el.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const inputType = String(el.type || 'text').toLowerCase();
    return !NON_TEXT_INPUT_TYPES.has(inputType);
  }
  if (el.isContentEditable) return true;
  if (typeof el.closest === 'function') {
    try {
      return Boolean(el.closest('[contenteditable]:not([contenteditable="false"])'));
    } catch {
      return false;
    }
  }
  return false;
}

/** Matches `Ctrl/Cmd+Z` (undo) and `Ctrl/Cmd+Shift+Z` / `Ctrl+Y` (redo). */
export function matchUndoRedoShortcut(event: UndoKeyEventLike): 'undo' | 'redo' | null {
  if (event.defaultPrevented || event.repeat || event.altKey) return null;
  if (!event.ctrlKey && !event.metaKey) return null;
  if (isNativeTextUndoTarget(event.target)) return null;

  const upper = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  if (upper === 'Z') {
    return event.shiftKey ? 'redo' : 'undo';
  }
  if (upper === 'Y' && event.ctrlKey && !event.metaKey && !event.shiftKey) {
    return 'redo';
  }
  return null;
}

export interface UndoStack<T> {
  push: (entry: T) => void;
  undo: () => T | null;
  redo: () => T | null;
  clear: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
}

/** Bounded undo/redo stack (pure, framework-free for Node testing). */
export function createUndoStack<T>(maxSize = 50): UndoStack<T> {
  const past: T[] = [];
  const future: T[] = [];
  return {
    push(entry: T) {
      past.push(entry);
      if (past.length > maxSize) past.shift();
      future.length = 0;
    },
    undo() {
      const entry = past.pop();
      if (entry === undefined) return null;
      future.push(entry);
      return entry;
    },
    redo() {
      const entry = future.pop();
      if (entry === undefined) return null;
      past.push(entry);
      return entry;
    },
    clear() {
      past.length = 0;
      future.length = 0;
    },
    canUndo() {
      return past.length > 0;
    },
    canRedo() {
      return future.length > 0;
    },
  };
}

/**
 * Listens for `Ctrl/Cmd+Z` and `Ctrl/Cmd+Shift+Z` / `Ctrl+Y` on `window`.
 * Prevents default only when the handler actually performs an undo/redo step.
 */
export function useUndoRedoShortcuts(options: {
  enabled?: boolean;
  onUndo: () => boolean | Promise<boolean>;
  onRedo?: () => boolean | Promise<boolean>;
}): void {
  const { enabled = true, onUndo, onRedo } = options;
  const handlersRef = useRef({ onUndo, onRedo });
  handlersRef.current = { onUndo, onRedo };

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (hasOpenModal(document)) return;
      const action = matchUndoRedoShortcut(e);
      if (!action) return;
      const fn = action === 'undo' ? handlersRef.current.onUndo : handlersRef.current.onRedo;
      if (!fn) return;
      const handled = fn();
      if (handled === true) {
        e.preventDefault();
      } else if (handled && typeof (handled as Promise<boolean>).then === 'function') {
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}

/**
 * React state backed by an undo/redo history stack.
 * Call `reset(val)` on initial load or entity switch; call `setValue` for user edits.
 */
export function useUndoableState<T>(initialValue: T, maxSize = 50): {
  value: T;
  setValue: (next: SetStateAction<T>) => void;
  reset: (next: T) => void;
  undo: () => boolean;
  redo: () => boolean;
} {
  const [value, setValueRaw] = useState<T>(initialValue);
  const valueRef = useRef<T>(initialValue);
  valueRef.current = value;
  const stackRef = useRef<UndoStack<{ prev: T; next: T }> | null>(null);
  if (!stackRef.current) {
    stackRef.current = createUndoStack<{ prev: T; next: T }>(maxSize);
  }

  const setValue = useCallback((action: SetStateAction<T>) => {
    const prev = valueRef.current;
    const next = typeof action === 'function' ? (action as (cur: T) => T)(prev) : action;
    if (Object.is(prev, next) || JSON.stringify(prev) === JSON.stringify(next)) {
      return;
    }
    stackRef.current!.push({ prev, next });
    valueRef.current = next;
    setValueRaw(next);
  }, []);

  const reset = useCallback((next: T) => {
    stackRef.current!.clear();
    valueRef.current = next;
    setValueRaw(next);
  }, []);

  const undo = useCallback(() => {
    const entry = stackRef.current!.undo();
    if (!entry) return false;
    valueRef.current = entry.prev;
    setValueRaw(entry.prev);
    return true;
  }, []);

  const redo = useCallback(() => {
    const entry = stackRef.current!.redo();
    if (!entry) return false;
    valueRef.current = entry.next;
    setValueRaw(entry.next);
    return true;
  }, []);

  return { value, setValue, reset, undo, redo };
}
