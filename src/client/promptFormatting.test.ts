import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseFormattedBlocks,
  parseInlineSpans,
  splitSpeakerPrefix,
} from './promptFormatting.ts';

test('parseFormattedBlocks splits intro, bullet list, and trailing note cleanly even without blank lines', () => {
  const input =
    'A scanning arm repeats this cycle:\n• Move 1: jump 2 trays\n• Move 2: jump 3 trays\n(Then Move 3 repeats Move 1.)\n\nWhich tray does it land on?';
  const blocks = parseFormattedBlocks(input);
  assert.deepEqual(blocks, [
    { kind: 'paragraph', lines: ['A scanning arm repeats this cycle:'] },
    { kind: 'bullet_list', items: ['Move 1: jump 2 trays', 'Move 2: jump 3 trays'] },
    { kind: 'paragraph', lines: ['(Then Move 3 repeats Move 1.)'] },
    { kind: 'paragraph', lines: ['Which tray does it land on?'] },
  ]);
});

test('parseFormattedBlocks handles ordered lists (1., 1), legacy DoE double-space) without misclassifying numeric card rows', () => {
  const numbered = parseFormattedBlocks(
    'Consider these statements:\n1. First rule\n2. Second rule\n\nWhich are true?'
  );
  assert.deepEqual(numbered, [
    { kind: 'paragraph', lines: ['Consider these statements:'] },
    {
      kind: 'ordered_list',
      items: [
        { marker: '1.', text: 'First rule' },
        { marker: '2.', text: 'Second rule' },
      ],
    },
    { kind: 'paragraph', lines: ['Which are true?'] },
  ]);

  const legacyDoe = parseFormattedBlocks(
    'The quadrilateral has:\n\n1  no parallel sides\n2  two sides of 5 cm\n3  exactly one right angle'
  );
  assert.deepEqual(legacyDoe, [
    { kind: 'paragraph', lines: ['The quadrilateral has:'] },
    {
      kind: 'ordered_list',
      items: [
        { marker: '1.', text: 'no parallel sides' },
        { marker: '2.', text: 'two sides of 5 cm' },
        { marker: '3.', text: 'exactly one right angle' },
      ],
    },
  ]);

  const cards = parseFormattedBlocks(
    'Four of the numbers on the cards have the same remainder:\n\n33   43   68   83   119\n\nWhich number is different?'
  );
  assert.equal(cards[1].kind, 'paragraph');
});

test('parseFormattedBlocks handles Statement N: and X./Y. lists cleanly', () => {
  const stmt = parseFormattedBlocks(
    'Consider:\nStatement 1: Alpha holds.\nStatement 2: Beta holds.'
  );
  assert.deepEqual(stmt, [
    { kind: 'paragraph', lines: ['Consider:'] },
    {
      kind: 'ordered_list',
      items: [
        { marker: 'Statement 1:', text: 'Alpha holds.' },
        { marker: 'Statement 2:', text: 'Beta holds.' },
      ],
    },
  ]);

  const xy = parseFormattedBlocks('X. Total is 32.\nY. Ratio is 3 : 2.');
  assert.deepEqual(xy, [
    {
      kind: 'ordered_list',
      items: [
        { marker: 'X.', text: 'Total is 32.' },
        { marker: 'Y.', text: 'Ratio is 3 : 2.' },
      ],
    },
  ]);

  // Single X. line should stay a paragraph
  const singleX = parseFormattedBlocks('X. marks the spot.');
  assert.equal(singleX[0].kind, 'paragraph');
});

test('parseFormattedBlocks extracts Boxed rules heading when isBoxedRules is true', () => {
  const blocks = parseFormattedBlocks(
    'Boxed rules — Red Gorge:\n• Rule one\n• Rule two',
    { isBoxedRules: true }
  );
  assert.deepEqual(blocks, [
    { kind: 'heading', text: 'Boxed rules — Red Gorge:' },
    { kind: 'bullet_list', items: ['Rule one', 'Rule two'] },
  ]);
});

test('splitSpeakerPrefix separates speaker name from quoted claim', () => {
  assert.deepEqual(splitSpeakerPrefix('Maya: "I can hear the foghorn."'), {
    speaker: 'Maya:',
    rest: '"I can hear the foghorn."',
  });
  assert.equal(splitSpeakerPrefix('Tags:   HALO,  LUNA'), null);
});

test('parseInlineSpans renders bold and italic safely without breaking arithmetic', () => {
  assert.deepEqual(
    parseInlineSpans('Write a **newspaper report** called *Welcome* with 3 * 4 = 12 and 2*x.'),
    [
      { type: 'text', text: 'Write a ' },
      { type: 'bold', text: 'newspaper report' },
      { type: 'text', text: ' called ' },
      { type: 'italic', text: 'Welcome' },
      { type: 'text', text: ' with 3 * 4 = 12 and 2*x.' },
    ]
  );
});
