import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXAM_SHORTCUT_LEGEND,
  hasOpenModal,
  isTextInputTarget,
  isTypingTarget,
  resolveExamShortcut,
  singleChoiceOptionKeysFor,
  type ExamShortcutContext,
} from './components/session/examShortcuts.ts';
import { MESSAGES_EN } from './i18n/en.ts';

const mcq5: ExamShortcutContext = {
  blocked: false,
  isWritingQuestion: false,
  singleChoiceOptionKeys: ['A', 'B', 'C', 'D', 'E'],
};
const mcq4: ExamShortcutContext = { ...mcq5, singleChoiceOptionKeys: ['A', 'B', 'C', 'D'] };

test('letters (any case) and digits select options, bounded to the option count', () => {
  assert.deepEqual(resolveExamShortcut({ key: 'c' }, mcq5), { type: 'select', optionKey: 'C' });
  assert.deepEqual(resolveExamShortcut({ key: 'E' }, mcq5), { type: 'select', optionKey: 'E' });
  assert.deepEqual(resolveExamShortcut({ key: '1' }, mcq5), { type: 'select', optionKey: 'A' });
  assert.deepEqual(resolveExamShortcut({ key: '5' }, mcq5), { type: 'select', optionKey: 'E' });
  // A four-option item ignores E and 5.
  assert.equal(resolveExamShortcut({ key: 'e' }, mcq4), null);
  assert.equal(resolveExamShortcut({ key: '5' }, mcq4), null);
  // Digits beyond 5 never select, even with more options.
  const wide = { ...mcq5, singleChoiceOptionKeys: ['A', 'B', 'C', 'D', 'E', 'F', 'G'] };
  assert.equal(resolveExamShortcut({ key: '6' }, wide), null);
  assert.equal(resolveExamShortcut({ key: '0' }, wide), null);
});

test('digits follow option order even when keys are not A–E', () => {
  const custom = { ...mcq5, singleChoiceOptionKeys: ['W', 'X', 'Y'] };
  assert.deepEqual(resolveExamShortcut({ key: '2' }, custom), { type: 'select', optionKey: 'X' });
  assert.equal(resolveExamShortcut({ key: 'a' }, custom), null);
});

test('navigation, flag, navigator and help keys', () => {
  assert.deepEqual(resolveExamShortcut({ key: 'ArrowLeft' }, mcq5), { type: 'prev' });
  assert.deepEqual(resolveExamShortcut({ key: 'ArrowRight' }, mcq5), { type: 'next' });
  assert.deepEqual(resolveExamShortcut({ key: 'f' }, mcq5), { type: 'flag' });
  assert.deepEqual(resolveExamShortcut({ key: 'N' }, mcq5), { type: 'toggleNav' });
  assert.deepEqual(resolveExamShortcut({ key: '?' }, mcq5), { type: 'toggleHelp' });
  // These work on multi-part items too, where answer keys are off.
  const cloze = { ...mcq5, singleChoiceOptionKeys: null };
  assert.deepEqual(resolveExamShortcut({ key: 'ArrowRight' }, cloze), { type: 'next' });
  assert.equal(resolveExamShortcut({ key: 'a' }, cloze), null);
  assert.equal(resolveExamShortcut({ key: '1' }, cloze), null);
  assert.equal(resolveExamShortcut({ key: 'Enter' }, mcq5), null);
  // P no longer moves back; arrows replaced it.
  assert.equal(resolveExamShortcut({ key: 'p' }, cloze), null);
});

test('modifiers, blocking states and Writing questions disable every shortcut except Ctrl/Cmd+Z undo/redo', () => {
  for (const mod of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
    assert.equal(resolveExamShortcut({ key: 'a', ...mod }, mcq5), null);
    assert.equal(resolveExamShortcut({ key: 'ArrowRight', ...mod }, mcq5), null);
  }
  assert.deepEqual(resolveExamShortcut({ key: 'z', ctrlKey: true }, mcq5), { type: 'undo' });
  assert.deepEqual(resolveExamShortcut({ key: 'Z', metaKey: true }, mcq5), { type: 'undo' });
  assert.deepEqual(resolveExamShortcut({ key: 'z', ctrlKey: true, shiftKey: true }, mcq5), { type: 'redo' });
  assert.deepEqual(resolveExamShortcut({ key: 'z', metaKey: true, shiftKey: true }, mcq5), { type: 'redo' });
  assert.deepEqual(resolveExamShortcut({ key: 'y', ctrlKey: true }, mcq5), { type: 'redo' });
  assert.equal(resolveExamShortcut({ key: 'z', ctrlKey: true, altKey: true }, mcq5), null);
  assert.equal(resolveExamShortcut({ key: 'z', ctrlKey: true }, { ...mcq5, blocked: true }), null);
  assert.equal(resolveExamShortcut({ key: 'z', ctrlKey: true }, { ...mcq5, isWritingQuestion: true }), null);
  assert.equal(resolveExamShortcut({ key: 'z', ctrlKey: true }, { ...mcq5, inspectorOpen: true }), null);
  // Undo also works on multi-part cloze/gapped-text questions where singleChoiceOptionKeys is null.
  assert.deepEqual(resolveExamShortcut({ key: 'z', ctrlKey: true }, { ...mcq5, singleChoiceOptionKeys: null }), {
    type: 'undo',
  });
  for (const key of ['a', '1', 'ArrowLeft', 'f', 'n', '?']) {
    assert.equal(resolveExamShortcut({ key }, { ...mcq5, blocked: true }), null, `blocked ${key}`);
    assert.equal(resolveExamShortcut({ key }, { ...mcq5, isWritingQuestion: true }), null, `writing ${key}`);
  }
});

test('admin inspector: I toggles it, and while open only I stays live', () => {
  const admin = { ...mcq5, canToggleInspector: true };
  assert.deepEqual(resolveExamShortcut({ key: 'i' }, admin), { type: 'toggleInspector' });
  assert.equal(resolveExamShortcut({ key: 'i' }, mcq5), null);
  const open = { ...admin, inspectorOpen: true };
  assert.deepEqual(resolveExamShortcut({ key: 'I' }, open), { type: 'toggleInspector' });
  assert.equal(resolveExamShortcut({ key: 'a' }, open), null);
  assert.equal(resolveExamShortcut({ key: 'ArrowRight' }, open), null);
});

test('single-choice detection excludes Writing, multi-part and option-less items', () => {
  const opts = (n: number) => Array.from({ length: n }, (_, i) => ({ key: String.fromCharCode(65 + i) }));
  assert.deepEqual(singleChoiceOptionKeysFor({ formatType: 'MATH_MCQ_5', parts: [{ options: opts(5) }] }), [
    'A',
    'B',
    'C',
    'D',
    'E',
  ]);
  assert.equal(singleChoiceOptionKeysFor({ formatType: 'WRIT_TYPED_TASK', parts: [{ options: [] }] }), null);
  assert.equal(
    singleChoiceOptionKeysFor({ formatType: 'READ_VOCAB_CLOZE', parts: [{ options: opts(4) }, { options: opts(4) }] }),
    null
  );
  assert.equal(singleChoiceOptionKeysFor({ formatType: 'READ_GAPPED_TEXT', parts: [{ options: [] }] }), null);
});

test('typing targets and open modals are detected', () => {
  assert.equal(isTypingTarget({ tagName: 'INPUT' }), true);
  assert.equal(isTypingTarget({ tagName: 'textarea' }), true);
  assert.equal(isTypingTarget({ tagName: 'SELECT' }), true);
  assert.equal(isTextInputTarget({ tagName: 'INPUT' }), true);
  assert.equal(isTextInputTarget({ tagName: 'textarea' }), true);
  assert.equal(isTextInputTarget({ tagName: 'SELECT' }), false);
  assert.equal(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isTypingTarget({ tagName: 'SPAN', closest: (sel: string) => (sel.includes('contenteditable') ? {} : null) }), true);
  assert.equal(isTypingTarget({ tagName: 'BUTTON', closest: () => null }), false);
  assert.equal(isTypingTarget(null), false);

  assert.equal(hasOpenModal({ querySelector: (sel) => (sel === '[aria-modal="true"]' ? {} : null) }), true);
  assert.equal(hasOpenModal({ querySelector: (sel) => (sel === 'dialog:modal' ? {} : null) }), true);
  assert.equal(
    hasOpenModal({
      querySelector: (sel) => {
        if (sel === 'dialog:modal') throw new Error('unsupported');
        return null;
      },
    }),
    false
  );
  assert.equal(hasOpenModal(null), false);
});

test('every shortcut legend row has an English label', () => {
  for (const row of EXAM_SHORTCUT_LEGEND) {
    assert.ok(MESSAGES_EN[row.labelKey], row.labelKey);
  }
});
