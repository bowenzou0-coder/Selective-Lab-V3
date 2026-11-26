import assert from 'node:assert/strict';
import test from 'node:test';
import { lintQuestionTypography } from './mathTypography.ts';

const svg = (label: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 320"><text x="10" y="20">${label}</text></svg>`;

test('lintQuestionTypography passes clean Unicode units, rendered carets and a single not-to-scale note', () => {
  assert.deepEqual(
    lintQuestionTypography({
      label: 'Q1',
      promptTexts: ['The area is 36 cm². Work out 3^2 + 4^2.'],
      otherTexts: ['1) 9 + 16 = 25 cm²'],
      visual: { visualType: 'inline_svg', svgMarkup: svg('5 cm'), caption: '[diagram not to scale]' },
    }),
    []
  );
});

test('lintQuestionTypography flags plain unit powers, SVG powers and a repeated not-to-scale note', () => {
  const warnings = lintQuestionTypography({
    label: 'Q2',
    promptTexts: ['The island is 164 km2.\n\n[diagram not to scale]'],
    otherTexts: [],
    visual: { visualType: 'image_asset', altText: 'Map', caption: '[diagram not to scale]' },
    optionVisuals: [{ visualType: 'inline_svg', svgMarkup: svg('Area = 12 m2') }],
  });
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /km2/);
  assert.match(warnings[1], /m2/);
  assert.match(warnings[2], /2 times/);
});
