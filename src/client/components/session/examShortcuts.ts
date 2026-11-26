// Exam Room keyboard shortcuts: pure key -> action resolution plus the DOM gating checks.
// Kept free of React so the rules can be unit-tested in Node.

export type ExamShortcutAction =
  | { type: 'select'; optionKey: string }
  | { type: 'prev' }
  | { type: 'next' }
  | { type: 'flag' }
  | { type: 'toggleNav' }
  | { type: 'toggleHelp' }
  | { type: 'toggleInspector' }
  | { type: 'undo' }
  | { type: 'redo' };

export interface ExamShortcutKeyEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

export interface ExamShortcutContext {
  /** Anything that freezes the exam: time up, submitting, section break, a modal dialog. */
  blocked: boolean;
  /** Writing tasks keep every key for the essay. */
  isWritingQuestion: boolean;
  /**
   * Option keys of the active question when it is a single-choice MCQ, in display order.
   * `null` for multi-part cloze, gapped text, matching or anything else ambiguous.
   */
  singleChoiceOptionKeys: readonly string[] | null;
  /** Admin calibration runs keep the `I` inspector toggle. */
  canToggleInspector?: boolean;
  /** While the inspector is open only `I` (to close it) stays live. */
  inspectorOpen?: boolean;
}

/** Letters and digits map onto the first five options only. */
export const MAX_SHORTCUT_OPTIONS = 5;
const LETTERS = ['A', 'B', 'C', 'D', 'E'] as const;

/** Shortcut legend, in the order the help popover lists it. */
export const EXAM_SHORTCUT_LEGEND = [
  { keys: ['A–E', '1–5'], labelKey: 'shortcuts.selectOption' },
  { keys: ['←', '→'], labelKey: 'shortcuts.prevNext' },
  { keys: ['F'], labelKey: 'shortcuts.flag' },
  { keys: ['Ctrl/⌘+Z'], labelKey: 'shortcuts.undo' },
  { keys: ['N'], labelKey: 'shortcuts.navigator' },
  { keys: ['?'], labelKey: 'shortcuts.help' },
  { keys: ['Esc'], labelKey: 'shortcuts.close' },
] as const;

/** Options a single-choice MCQ exposes to the keyboard; `null` when selection would be ambiguous. */
export function singleChoiceOptionKeysFor(question: {
  formatType: string;
  parts: ReadonlyArray<{ options: ReadonlyArray<{ key: string }> }>;
}): string[] | null {
  if (question.formatType === 'WRIT_TYPED_TASK') return null;
  if (question.parts.length !== 1) return null;
  const options = question.parts[0].options;
  if (options.length < 2) return null;
  return options.map((o) => o.key);
}

/** Maps a key press to an exam action, or `null` when the key should do nothing. */
export function resolveExamShortcut(
  event: ExamShortcutKeyEvent,
  ctx: ExamShortcutContext
): ExamShortcutAction | null {
  if (ctx.blocked || ctx.isWritingQuestion) return null;

  const key = event.key;
  const upper = key.length === 1 ? key.toUpperCase() : key;

  if (event.ctrlKey || event.metaKey || event.altKey) {
    if (ctx.inspectorOpen || event.altKey) return null;
    if ((event.ctrlKey || event.metaKey) && upper === 'Z') {
      return event.shiftKey ? { type: 'redo' } : { type: 'undo' };
    }
    if (event.ctrlKey && !event.metaKey && !event.shiftKey && upper === 'Y') {
      return { type: 'redo' };
    }
    return null;
  }

  if (ctx.inspectorOpen) {
    return upper === 'I' && ctx.canToggleInspector ? { type: 'toggleInspector' } : null;
  }

  if (key === '?') return { type: 'toggleHelp' };
  if (key === 'ArrowLeft') return { type: 'prev' };
  if (key === 'ArrowRight') return { type: 'next' };
  if (upper === 'F') return { type: 'flag' };
  if (upper === 'N') return { type: 'toggleNav' };
  if (upper === 'I' && ctx.canToggleInspector) return { type: 'toggleInspector' };

  const options = ctx.singleChoiceOptionKeys;
  if (!options || options.length === 0) return null;
  const bounded = options.slice(0, MAX_SHORTCUT_OPTIONS);

  if (/^[1-5]$/.test(key)) {
    const optionKey = bounded[Number(key) - 1];
    return optionKey ? { type: 'select', optionKey } : null;
  }
  const letterIndex = LETTERS.indexOf(upper as (typeof LETTERS)[number]);
  if (letterIndex >= 0) {
    const match = bounded.find((k) => k.toUpperCase() === upper);
    return match ? { type: 'select', optionKey: match } : null;
  }
  return null;
}

interface TargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

/** True when focus sits in a text input that owns native text undo (`Ctrl+Z`). */
export function isTextInputTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as TargetLike;
  const tag = (el.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
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

/** True when focus sits in a field that owns its keystrokes. */
export function isTypingTarget(target: unknown): boolean {
  if (isTextInputTarget(target)) return true;
  if (!target || typeof target !== 'object') return false;
  const tag = ((target as TargetLike).tagName || '').toUpperCase();
  return tag === 'SELECT';
}

interface QueryRootLike {
  querySelector: (selector: string) => unknown;
}

/** True while a modal dialog (ConfirmDialog, modal Sheet) is open anywhere on the page. */
export function hasOpenModal(root: QueryRootLike | null | undefined): boolean {
  if (!root) return false;
  if (root.querySelector('[aria-modal="true"]')) return true;
  try {
    return Boolean(root.querySelector('dialog:modal'));
  } catch {
    // Older engines without :modal; aria-modal above already covers ConfirmDialog.
    return false;
  }
}
