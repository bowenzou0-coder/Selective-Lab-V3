#!/usr/bin/env node
/**
 * Merges multiple BankImportManifest JSON files (e.g. from daily Claude + ChatGPT runs)
 * into one clean, deduplicated, strictly validated BankImportManifest ready for Selective Lab import.
 *
 * Usage:
 *   node scripts/merge_manifests.mjs batch1.json batch2.json ... \
 *     --out merged.json \
 *     --batch-label "daily_2026_11_21" \
 *     [--qc verified|active] \
 *     [--append-scenarios scenarios-log.txt]
 */

import fs from 'node:fs';
import path from 'node:path';
import { validateManifestObject } from './validate_manifest.mjs';

const args = process.argv.slice(2);
const inputs = [];
const flags = {};

for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    flags[args[i].slice(2)] = args[i + 1];
    i++;
  } else {
    inputs.push(args[i]);
  }
}

if (inputs.length === 0 || !flags.out) {
  console.error(
    'Usage: node scripts/merge_manifests.mjs <in1.json> [in2.json ...] --out <merged.json> [--batch-label label] [--qc verified|active] [--append-scenarios log.txt]'
  );
  process.exit(2);
}

const today = new Date().toISOString().slice(0, 10).replace(/-/g, '_');
const batchLabel = flags['batch-label'] || `merged_${today}`;
const defaultQcStatus = flags.qc === 'active' ? 'active' : 'verified';

const mergedStimuli = [];
const mergedQuestions = [];
const seenStimIds = new Set();
const seenQIds = new Set();
const seenPartIds = new Set();
const scenarioSummaries = [];

for (const file of inputs) {
  const abs = path.resolve(file);
  let rawText = fs.readFileSync(abs, 'utf8').trim();
  // Strip accidental markdown fences if pasted straight from a chat UI
  rawText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const data = JSON.parse(rawText);

  for (const s of data.stimuli || []) {
    if (seenStimIds.has(s.stimulusId)) {
      console.error(`Duplicate stimulusId "${s.stimulusId}" in ${file}`);
      process.exit(1);
    }
    seenStimIds.add(s.stimulusId);
    mergedStimuli.push(s);
    if (s.title) scenarioSummaries.push(`[${s.section}] ${s.title} (${s.genreOrTextType})`);
  }

  for (const q of data.questions || []) {
    if (seenQIds.has(q.questionId)) {
      console.error(`Duplicate questionId "${q.questionId}" in ${file}`);
      process.exit(1);
    }
    seenQIds.add(q.questionId);
    for (const p of q.parts || []) {
      if (seenPartIds.has(p.partId)) {
        console.error(`Duplicate partId "${p.partId}" in ${file}`);
        process.exit(1);
      }
      seenPartIds.add(p.partId);
    }
    const cleanQ = {
      ...q,
      provenance: {
        sourceType: q.provenance?.sourceType || 'ai_generated',
        sourceReference: batchLabel,
        verifierAgreed: q.provenance?.verifierAgreed ?? true,
        auditorReviewed: q.provenance?.auditorReviewed ?? false,
      },
    };
    mergedQuestions.push(cleanQ);
    if (!q.stimulusId && q.parts?.[0]?.promptText) {
      const snippet = q.parts[0].promptText.replace(/\s+/g, ' ').slice(0, 90);
      scenarioSummaries.push(`[${q.section}/${q.parts[0].skillId}] ${snippet}`);
    }
  }
}

const merged = {
  manifestVersion: '1.0',
  batchLabel,
  defaultPoolType: 'practice',
  defaultQcStatus,
  stimuli: mergedStimuli,
  questions: mergedQuestions,
};

const result = validateManifestObject(merged);
const absOut = path.resolve(flags.out);
fs.mkdirSync(path.dirname(absOut), { recursive: true });
fs.writeFileSync(absOut, JSON.stringify(merged, null, 2) + '\n', 'utf8');

console.log(`Merged ${inputs.length} file(s) -> ${absOut}`);
console.log(`Validation: ${result.valid ? 'PASS' : 'FAIL'} (${result.errors.length} errors, ${result.warnings.length} warnings)`);
console.log(`Totals:     ${result.stats.stimuliCount} stimuli, ${result.stats.questionsCount} questions, ${result.stats.partsCount} parts`);
console.log(`Sections:   ${JSON.stringify(result.stats.bySection)}`);

if (result.errors.length > 0) {
  console.log('\nErrors:');
  for (const e of result.errors) console.log(`  - ${e}`);
}
if (result.warnings.length > 0) {
  console.log('\nWarnings:');
  for (const w of result.warnings) console.log(`  - ${w}`);
}

if (flags['append-scenarios'] && scenarioSummaries.length > 0) {
  const logPath = path.resolve(flags['append-scenarios']);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, scenarioSummaries.join('\n') + '\n', 'utf8');
  console.log(`Appended ${scenarioSummaries.length} scenario summaries to ${logPath}`);
}

process.exit(result.valid ? 0 : 1);
