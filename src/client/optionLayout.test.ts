import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { QuestionItem } from '../shared/contracts';
import { getVisualOptionTileHeightClass, shouldUseVisualOptionGrid } from './optionLayout';

test('shouldUseVisualOptionGrid returns true for visual-only and short-label visual options', () => {
  assert.equal(
    shouldUseVisualOptionGrid([
      { key: 'A', text: '', visual: { visualType: 'image_asset', imageUrl: '/a.png', altText: 'A' } },
      { key: 'B', text: '', visual: { visualType: 'image_asset', imageUrl: '/b.png', altText: 'B' } },
      { key: 'C', text: '', visual: { visualType: 'image_asset', imageUrl: '/c.png', altText: 'C' } },
      { key: 'D', text: '', visual: { visualType: 'image_asset', imageUrl: '/d.png', altText: 'D' } },
    ]),
    true
  );

  assert.equal(
    shouldUseVisualOptionGrid([
      { key: 'A', text: 'View A', visual: { visualType: 'inline_svg', svgMarkup: '<svg/>', altText: 'A' } },
      { key: 'B', text: 'View B', visual: { visualType: 'inline_svg', svgMarkup: '<svg/>', altText: 'B' } },
      { key: 'C', text: 'View C', visual: { visualType: 'inline_svg', svgMarkup: '<svg/>', altText: 'C' } },
      { key: 'D', text: 'View D', visual: { visualType: 'inline_svg', svgMarkup: '<svg/>', altText: 'D' } },
    ]),
    true
  );
});

test('shouldUseVisualOptionGrid returns false for text-only options or long-text visual options', () => {
  assert.equal(
    shouldUseVisualOptionGrid([
      { key: 'A', text: '12 cm' },
      { key: 'B', text: '18 cm' },
      { key: 'C', text: '24 cm' },
      { key: 'D', text: '30 cm' },
    ]),
    false
  );

  assert.equal(
    shouldUseVisualOptionGrid([
      {
        key: 'A',
        text: 'This is a very long multi-clause textual explanation option that should stay in a single stacked column',
        visual: { visualType: 'image_asset', imageUrl: '/a.png', altText: 'A' },
      },
      { key: 'B', text: 'Short' },
    ]),
    false
  );
});

test('all bundled seed questions with visual options qualify for the compact 2-column grid', () => {
  const readJson = (rel: string) => JSON.parse(fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8'));
  const smoke = readJson('seed/golden-smoke-pack.json') as { questions?: QuestionItem[] };
  // Option parts of every official PT1–PT3 question with visual options (full papers live in Postgres).
  const official = readJson('src/server/__fixtures__/official-sample.json') as {
    visualOptionParts: Pick<QuestionItem, 'questionId' | 'parts'>[];
  };
  let visualQuestionParts = 0;
  for (const q of [...(smoke.questions || []), ...official.visualOptionParts]) {
    for (const p of q.parts || []) {
      const hasAnyVisual = (p.options || []).some(
        (o) => o.visual && o.visual.visualType !== 'none'
      );
      if (hasAnyVisual) {
        visualQuestionParts += 1;
        assert.equal(
          shouldUseVisualOptionGrid(p.options),
          true,
          `Expected ${q.questionId} to use compact 2-column visual option grid`
        );
      }
    }
  }
  assert.ok(visualQuestionParts >= 15, `Expected at least 15 visual-option parts, got ${visualQuestionParts}`);
  assert.notEqual(getVisualOptionTileHeightClass(4), getVisualOptionTileHeightClass(5));
});
