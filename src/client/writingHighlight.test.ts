import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAnnotatedParagraphs } from './writingHighlight.ts';

test('buildAnnotatedParagraphs matches exact quotes, smart quotes, whitespace, and ellipsis-trimmed quotes losslessly', () => {
  const essay = [
    '“Stop right there,”   Mrs Kerr whispered as the rain hammered the roof.',
    'The old brass key gleamed beneath the bench. The old brass key felt heavier than iron.',
  ].join('\n\n');

  const { paragraphs, matchedIds } = buildAnnotatedParagraphs(essay, [
    { id: 'a1', quote: '"Stop right there," Mrs Kerr whispered' },
    { id: 'a2', quote: 'the old brass key' },
    { id: 'a3', quote: 'The old brass key' },
    { id: 'a4', quote: '...hammered the roof...' },
    { id: 'a5', quote: 'sentence completely absent from text' },
  ]);

  assert.equal(paragraphs.length, 2);
  assert.equal(matchedIds.has('a1'), true);
  assert.equal(matchedIds.has('a2'), true);
  assert.equal(matchedIds.has('a3'), true);
  assert.equal(matchedIds.has('a4'), true);
  assert.equal(matchedIds.has('a5'), false);

  // Every paragraph reconstructs losslessly character-for-character
  for (const p of paragraphs) {
    assert.equal(
      p.segments.map((s) => s.text).join(''),
      p.rawText,
      `Paragraph ${p.paragraphIndex} text drifted during segmentation`
    );
  }

  // Repeated phrase matches distinct occurrences rather than colliding on first one
  const secondParaHighlighted = paragraphs[1].segments.filter((s) => s.annotationId);
  assert.equal(secondParaHighlighted.length, 2);
  assert.notEqual(secondParaHighlighted[0].annotationId, secondParaHighlighted[1].annotationId);
});

test('buildAnnotatedParagraphs handles overlapping spans without duplicating text', () => {
  const essay = 'A pale ribbon of mist drifted slowly across the silent harbour.';
  const { paragraphs, matchedIds } = buildAnnotatedParagraphs(essay, [
    { id: 'outer', quote: 'A pale ribbon of mist drifted' },
    { id: 'inner', quote: 'ribbon of mist' },
  ]);

  assert.equal(paragraphs.length, 1);
  assert.equal(paragraphs[0].segments.map((s) => s.text).join(''), essay);
  assert.equal(matchedIds.has('outer'), true);
  assert.equal(matchedIds.has('inner'), false);
});
