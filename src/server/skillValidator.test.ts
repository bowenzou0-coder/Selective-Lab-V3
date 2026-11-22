import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  normalizeSvgFonts as normalizeSkillSvgFonts,
  validateManifestObject,
} from '../../docs/selective-lab-question-skill/scripts/validate_manifest.mjs';
import { normalizeSvgFonts } from '../shared/svgFonts.ts';

type Result = { valid: boolean; errors: string[]; warnings: string[] };
const pilot = JSON.parse(readFileSync('docs/selective-lab-question-skill/examples/pilot-sample-manifest.json', 'utf8'));
const validate = (m: unknown) => validateManifestObject(m) as Result;
const mathQuestion = () => structuredClone(pilot.questions.find((q: { formatType: string }) => q.formatType === 'MATH_MCQ_5'));

test('skill validator: pilot manifest stays strict-clean', () => {
  const r = validate(pilot);
  assert.deepEqual([r.errors, r.warnings], [[], []]);
});

test('skill validator: enforces standardized batchLabel and section-based IDs', () => {
  const badBatch = structuredClone(pilot);
  badBatch.batchLabel = 'batch_2026_11_22_odd_angles';
  assert.ok(validate(badBatch).errors.some((e) => e.includes('must match YYYY-MM-DD_bNN')));

  const badChunkId = structuredClone(pilot);
  const q = mathQuestion();
  q.questionFamilyId = '2026-01-01_b01_m1_01';
  q.questionId = '2026-01-01_b01_m1_01_v1';
  q.parts[0].partId = '2026-01-01_b01_m1_01_p1';
  badChunkId.stimuli = [];
  badChunkId.questions = [q];
  assert.ok(validate(badChunkId).errors.some((e) => e.includes('must match 2026-01-01_b01_math_NN')));

  const badPart = structuredClone(pilot);
  const q2 = mathQuestion();
  q2.parts[0].partId = '2026-01-01_b01_math_01_part1';
  badPart.stimuli = [];
  badPart.questions = [q2];
  assert.ok(validate(badPart).errors.some((e) => e.includes('partId')));
});

test('skill validator: identical option texts are an error (two correct answers)', () => {
  const m = structuredClone(pilot);
  const q = mathQuestion();
  const [a, b] = q.parts[0].options;
  b.text = a.text;
  m.stimuli = [];
  m.questions = [q];
  assert.ok(validate(m).errors.some((e) => e.includes('identical text')));
});

test('skill validator: flags giveaway-length correct answers and thin rationales', () => {
  const m = structuredClone(pilot);
  const q = mathQuestion();
  const part = q.parts[0];
  const correct = part.options.find((o: { key: string }) => o.key === part.correctAnswerKey);
  correct.text = 'This is by far the longest and most carefully qualified answer option here';
  const wrongKey = part.options.find((o: { key: string }) => o.key !== part.correctAnswerKey).key;
  part.distractorRationales[wrongKey] = 'Wrong.';
  m.stimuli = [];
  m.questions = [q];
  const { warnings } = validate(m);
  assert.ok(warnings.some((w) => w.includes('giveaway')));
  assert.ok(warnings.some((w) => w.includes('too thin')));
});

test('skill validator: SVG labels outside the viewBox and unbalanced tags are caught', () => {
  const m = structuredClone(pilot);
  const q = mathQuestion();
  q.visual = {
    visualType: 'inline_svg',
    altText: 'Diagram',
    svgMarkup:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><text x="250" y="50">Far</text><g><text x="10" y="10">A</text></svg>',
  };
  m.stimuli = [];
  m.questions = [q];
  const r = validate(m);
  assert.ok(r.warnings.some((w) => w.includes('outside the viewBox')));
  assert.ok(r.errors.some((e) => e.includes('unbalanced <g>')));
});

test('skill validator: omitted SVG font-family and Anthropic fallback stacks pass cleanly; non-Anthropic named fonts warn only', () => {
  const m = structuredClone(pilot);
  const q = mathQuestion();
  m.stimuli = [];
  m.questions = [q];

  // Omitted font-family passes with 0 errors and 0 warnings (app applies AnthropicSansText automatically)
  q.visual = {
    visualType: 'inline_svg',
    altText: 'Clean diagram without font-family',
    svgMarkup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><text x="20" y="50">A</text></svg>',
  };
  assert.deepEqual([validate(m).errors, validate(m).warnings], [[], []]);

  // Fallback stack alongside an Anthropic font passes cleanly
  q.visual.svgMarkup =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><text x="20" y="50" font-family="\'AnthropicSansText\', system-ui, sans-serif">A</text></svg>';
  assert.deepEqual([validate(m).errors, validate(m).warnings], [[], []]);

  // Explicit non-Anthropic named font warns (never hard-fails)
  q.visual.svgMarkup =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><text x="20" y="50" font-family="Arial">A</text></svg>';
  const rWarn = validate(m);
  assert.equal(rWarn.errors.length, 0);
  assert.ok(rWarn.warnings.some((w) => w.includes('non-Anthropic font')));
});

test('svg font normalization: guarantees Anthropic fonts and strips redundant child attrs', () => {
  for (const fn of [normalizeSvgFonts, normalizeSkillSvgFonts]) {
    const bare = fn('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><text x="10" y="25">Hi</text></svg>');
    assert.ok(bare.includes('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" font-family="AnthropicSansText">'));

    const messy = fn(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><text x="10" y="20" font-family="&apos;Anthropic Sans&apos;, -apple-system, sans-serif">1</text><text x="10" y="40" font-family="Courier, monospace">2</text></svg>'
    );
    assert.ok(messy.includes('font-family="AnthropicSansText"'));
    assert.ok(!messy.includes('Anthropic Sans'));
    assert.ok(!messy.includes('sans-serif'));
    assert.ok(messy.includes('<text x="10" y="20">1</text>'));
    assert.ok(messy.includes('<text x="10" y="40" font-family="AnthropicMono">2</text>'));
  }
});

test('skill validator: batch answer-key skew and long runs are flagged', () => {
  const m = structuredClone(pilot);
  const base = mathQuestion();
  m.stimuli = [];
  m.questions = Array.from({ length: 10 }, (_, i) => {
    const q = structuredClone(base);
    const nn = String(i + 1).padStart(2, '0');
    q.questionFamilyId = `2026-01-01_b01_math_${nn}`;
    q.questionId = `2026-01-01_b01_math_${nn}_v1`;
    q.parts[0].partId = `2026-01-01_b01_math_${nn}_p1`;
    return q; // every copy keeps the same correct letter
  });
  const { errors, warnings } = validate(m);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes('answer keys are skewed')));
  assert.ok(warnings.some((w) => w.includes('4+ consecutive')));
});
