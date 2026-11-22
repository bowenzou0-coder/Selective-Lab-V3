import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validateManifestObject } from '../../docs/selective-lab-question-skill/scripts/validate_manifest.mjs';

type Result = { valid: boolean; errors: string[]; warnings: string[] };
const pilot = JSON.parse(readFileSync('docs/selective-lab-question-skill/examples/pilot-sample-manifest.json', 'utf8'));
const validate = (m: unknown) => validateManifestObject(m) as Result;
const mathQuestion = () => structuredClone(pilot.questions.find((q: { formatType: string }) => q.formatType === 'MATH_MCQ_5'));

test('skill validator: pilot manifest stays strict-clean', () => {
  const r = validate(pilot);
  assert.deepEqual([r.errors, r.warnings], [[], []]);
});

test('skill validator: identical option texts are an error (two correct answers)', () => {
  const m = structuredClone(pilot);
  const q = mathQuestion();
  const [a, b] = q.parts[0].options;
  b.text = a.text;
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
  m.questions = [q];
  const r = validate(m);
  assert.ok(r.warnings.some((w) => w.includes('outside the viewBox')));
  assert.ok(r.errors.some((e) => e.includes('unbalanced <g>')));
});

test('skill validator: batch answer-key skew and long runs are flagged', () => {
  const m = structuredClone(pilot);
  const base = mathQuestion();
  m.stimuli = [];
  m.questions = Array.from({ length: 10 }, (_, i) => {
    const q = structuredClone(base);
    q.questionId = `q_skew_${i}_v1`;
    q.questionFamilyId = `q_skew_${i}`;
    q.parts[0].partId = `q_skew_${i}_p1`;
    return q; // every copy keeps the same correct letter
  });
  const { warnings } = validate(m);
  assert.ok(warnings.some((w) => w.includes('answer keys are skewed')));
  assert.ok(warnings.some((w) => w.includes('4+ consecutive')));
});
