import test from 'node:test';
import assert from 'node:assert/strict';
import { V3_STARTER_MANIFEST_EXAMPLE } from '../shared/v3Schema';
import { validateAndDryRunManifest } from './manifestValidator';

test('validateAndDryRunManifest accepts V3 starter manifest example with zero errors', () => {
  const { manifest, report } = validateAndDryRunManifest(V3_STARTER_MANIFEST_EXAMPLE, []);
  assert.equal(report.valid, true, `Unexpected errors: ${report.errors.join('; ')}`);
  assert.equal(report.questionsCount, 3);
  assert.equal(report.stimuliCount, 1);
  assert.ok(manifest);
  const gapped = manifest.questions.find((q) => q.formatType === 'READ_GAPPED_TEXT');
  assert.equal(gapped?.sharedPoolConfig?.reuseAllowed, false);
  assert.deepEqual(gapped?.sharedPoolConfig?.poolKeys, ['A', 'B', 'C']);
});

test('validateAndDryRunManifest normalizes AI manifest defaults, up to 8 options, and auto-creates WRIT part', () => {
  const aiPayload = {
    manifestVersion: '1.0',
    batchLabel: 'ai_8opt_batch',
    questions: [
      {
        questionId: 'q_ai_8opt_v1',
        section: 'MATH',
        formatType: 'MATH_MCQ_5',
        visual: {
          svgMarkup: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
        },
        parts: [
          {
            partId: 'q_ai_8opt_p1',
            promptText: 'Pick H.',
            skillId: 'MATH.GEO2D.COMPOSITE_AREA',
            options: [
              { key: 'A', text: '1' },
              { key: 'B', text: '2' },
              { key: 'C', text: '3' },
              { key: 'D', text: '4' },
              { key: 'E', text: '5' },
              { key: 'F', text: '6' },
              { key: 'G', text: '7' },
              { key: 'H', text: '8' },
            ],
            correctAnswerKey: 'H',
            workedExplanation: 'Option H evaluates to 8.',
          },
        ],
      },
      {
        questionId: 'q_ai_writ_noparts_v1',
        section: 'WRIT',
        formatType: 'WRIT_TYPED_TASK',
        writingSpec: {
          genre: 'Persuasive',
          audience: 'Principal',
          purpose: 'Persuade',
          recommendedWordRange: [250, 400],
          timeLimitSec: 1800,
        },
        parts: [],
      },
    ],
  };

  const { manifest, report } = validateAndDryRunManifest(aiPayload, []);
  assert.equal(report.valid, true, `Unexpected errors: ${report.errors.join('; ')}`);
  assert.ok(manifest);
  assert.equal(manifest.questions[0].visual?.visualType, 'inline_svg');
  assert.equal(manifest.questions[0].parts[0].options.length, 8);
  assert.equal(manifest.questions[1].parts.length, 1);
  assert.equal(manifest.questions[1].parts[0].skillId, 'WRIT.CRIT.TOPIC_PROMPT_ADHERENCE');
});

test('validateAndDryRunManifest rejects object or empty workedExplanation on non-writing items and preserves multiline', () => {
  const badObjPayload = {
    manifestVersion: '1.0',
    batchLabel: 'bad_expl_obj',
    questions: [
      {
        questionId: 'q_bad_obj_v1',
        section: 'MATH',
        formatType: 'MATH_MCQ_5',
        parts: [
          {
            partId: 'q_bad_obj_p1',
            promptText: 'Solve x + 1 = 2',
            skillId: 'MATH.NUM.NUMBER_SEQUENCES',
            options: [
              { key: 'A', text: '1' },
              { key: 'B', text: '2' },
            ],
            correctAnswerKey: 'A',
            workedExplanation: { steps: ['Step 1'] },
          },
        ],
      },
    ],
  };

  const objRes = validateAndDryRunManifest(badObjPayload, []);
  assert.equal(objRes.report.valid, false);
  assert.ok(objRes.report.errors.some((e) => e.includes('workedExplanation')));

  const emptyExplPayload = {
    manifestVersion: '1.0',
    batchLabel: 'empty_expl',
    questions: [
      {
        questionId: 'q_empty_expl_v1',
        section: 'THINK',
        formatType: 'THINK_MCQ_4',
        parts: [
          {
            partId: 'q_empty_expl_p1',
            promptText: 'Pick A.',
            skillId: 'THINK.LOG.CONDITIONAL_DEDUCTION',
            options: [
              { key: 'A', text: 'Yes' },
              { key: 'B', text: 'No' },
            ],
            correctAnswerKey: 'A',
            workedExplanation: '   ',
          },
        ],
      },
    ],
  };

  const emptyRes = validateAndDryRunManifest(emptyExplPayload, []);
  assert.equal(emptyRes.report.valid, false);
  assert.ok(emptyRes.report.errors.some((e) => e.includes('workedExplanation')));

  const multilinePayload = {
    manifestVersion: '1.0',
    batchLabel: 'multiline_expl',
    questions: [
      {
        questionId: 'q_multiline_v1',
        section: 'MATH',
        formatType: 'MATH_MCQ_5',
        parts: [
          {
            partId: 'q_multiline_p1',
            promptText: '2 + 2?',
            skillId: 'MATH.NUM.NUMBER_SEQUENCES',
            options: [
              { key: 'A', text: '4' },
              { key: 'B', text: '5' },
            ],
            correctAnswerKey: 'A',
            workedExplanation: 'Line 1: Add the integers.\nLine 2: Result is 4.',
          },
        ],
      },
    ],
  };

  const multiRes = validateAndDryRunManifest(multilinePayload, []);
  assert.equal(multiRes.report.valid, true, multiRes.report.errors.join('; '));
  assert.equal(
    multiRes.manifest?.questions[0].parts[0].workedExplanation,
    'Line 1: Add the integers.\nLine 2: Result is 4.'
  );
});
