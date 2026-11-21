#!/usr/bin/env node
/**
 * Exact JavaScript UTF-16 code-unit offset calculator for Reading evidenceRefs.
 * Guarantees `targetText.slice(startOffset, endOffset) === quote`.
 *
 * Usage:
 *   node scripts/compute_evidence_refs.mjs <manifest.json> <stimulusId> <quote> [--extract A] [--occurrence 1] [--refId ev_q1_p1_1]
 */

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const positional = [];
const flags = {};

for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const key = args[i].slice(2);
    flags[key] = args[i + 1];
    i++;
  } else {
    positional.push(args[i]);
  }
}

const [manifestPath, stimulusId, quote] = positional;
if (!manifestPath || !stimulusId || !quote) {
  console.error(
    'Usage: node scripts/compute_evidence_refs.mjs <manifest.json> <stimulusId> <quote> [--extract A] [--occurrence 1] [--refId ev_1]'
  );
  process.exit(2);
}

const manifest = JSON.parse(fs.readFileSync(path.resolve(manifestPath), 'utf8'));
const stim = (manifest.stimuli || []).find((s) => s.stimulusId === stimulusId);
if (!stim) {
  console.error(`Stimulus "${stimulusId}" not found in ${manifestPath}.`);
  process.exit(1);
}

let targetKind = 'mainText';
let extractLabel;
let targetText = stim.mainTextMarkdown || '';

if (flags.extract) {
  targetKind = 'extract';
  extractLabel = flags.extract;
  const ex = (stim.extracts || []).find((e) => e.label === extractLabel);
  if (!ex) {
    console.error(`Extract "${extractLabel}" not found on stimulus "${stimulusId}".`);
    process.exit(1);
  }
  targetText = ex.bodyMarkdown;
}

const matches = [];
let idx = targetText.indexOf(quote);
while (idx !== -1) {
  matches.push({ startOffset: idx, endOffset: idx + quote.length });
  idx = targetText.indexOf(quote, idx + 1);
}

if (matches.length === 0) {
  console.error(`Quote not found in ${stimulusId} (${targetKind}${extractLabel ? `:${extractLabel}` : ''}).`);
  process.exit(1);
}

const occ = Number(flags.occurrence || 1);
if (!Number.isInteger(occ) || occ < 1 || occ > matches.length) {
  console.error(`Found ${matches.length} occurrence(s), but requested --occurrence ${occ}.`);
  process.exit(1);
}

const chosen = matches[occ - 1];
const verified = targetText.slice(chosen.startOffset, chosen.endOffset) === quote;
if (!verified) {
  console.error('Internal slice verification failed.');
  process.exit(1);
}

const ref = {
  refId: flags.refId || `ev_${stimulusId}_${occ}`,
  stimulusRevision: stim.version ?? 1,
  targetKind,
  ...(extractLabel ? { extractLabel } : {}),
  startOffset: chosen.startOffset,
  endOffset: chosen.endOffset,
  quote,
};

console.log(JSON.stringify(ref, null, 2));
if (matches.length > 1) {
  console.error(`Note: ${matches.length} occurrences found; emitted occurrence #${occ}.`);
}
