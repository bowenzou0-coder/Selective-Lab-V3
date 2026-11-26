import assert from 'node:assert/strict';
import test from 'node:test';
import { createUndoStack, isNativeTextUndoTarget, matchUndoRedoShortcut } from './undoHistory.ts';

test('createUndoStack supports push, undo, redo, bounding, and clearing redo on new edit', () => {
  const stack = createUndoStack<string>(3);
  assert.equal(stack.canUndo(), false);
  assert.equal(stack.undo(), null);

  stack.push('a');
  stack.push('b');
  stack.push('c');
  stack.push('d'); // trims 'a'

  assert.equal(stack.undo(), 'd');
  assert.equal(stack.undo(), 'c');
  assert.equal(stack.canRedo(), true);
  assert.equal(stack.redo(), 'c');

  // New push clears redo branch
  stack.push('e');
  assert.equal(stack.canRedo(), false);
  assert.equal(stack.undo(), 'e');
  assert.equal(stack.undo(), 'c');
  assert.equal(stack.undo(), 'b');
  assert.equal(stack.undo(), null);
});

test('matchUndoRedoShortcut recognizes Ctrl/Cmd+Z and Shift+Z / Ctrl+Y while preserving native text inputs', () => {
  assert.equal(matchUndoRedoShortcut({ key: 'z', ctrlKey: true }), 'undo');
  assert.equal(matchUndoRedoShortcut({ key: 'Z', metaKey: true }), 'undo');
  assert.equal(matchUndoRedoShortcut({ key: 'z', ctrlKey: true, shiftKey: true }), 'redo');
  assert.equal(matchUndoRedoShortcut({ key: 'Z', metaKey: true, shiftKey: true }), 'redo');
  assert.equal(matchUndoRedoShortcut({ key: 'y', ctrlKey: true }), 'redo');
  assert.equal(matchUndoRedoShortcut({ key: 'y', metaKey: true }), null);
  assert.equal(matchUndoRedoShortcut({ key: 'z', ctrlKey: true, altKey: true }), null);
  assert.equal(matchUndoRedoShortcut({ key: 'z', ctrlKey: true, repeat: true }), null);

  // Native text fields keep browser undo; checkboxes, buttons and selects allow app undo
  assert.equal(isNativeTextUndoTarget({ tagName: 'INPUT', type: 'text' }), true);
  assert.equal(isNativeTextUndoTarget({ tagName: 'INPUT', type: 'number' }), true);
  assert.equal(isNativeTextUndoTarget({ tagName: 'TEXTAREA' }), true);
  assert.equal(isNativeTextUndoTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isNativeTextUndoTarget({ tagName: 'INPUT', type: 'checkbox' }), false);
  assert.equal(isNativeTextUndoTarget({ tagName: 'SELECT' }), false);
  assert.equal(isNativeTextUndoTarget({ tagName: 'BUTTON' }), false);

  assert.equal(matchUndoRedoShortcut({ key: 'z', ctrlKey: true, target: { tagName: 'TEXTAREA' } }), null);
  assert.equal(
    matchUndoRedoShortcut({ key: 'z', ctrlKey: true, target: { tagName: 'INPUT', type: 'checkbox' } }),
    'undo'
  );
  assert.equal(matchUndoRedoShortcut({ key: 'z', ctrlKey: true, target: { tagName: 'SELECT' } }), 'undo');
});
