#!/usr/bin/env node
/**
 * Merges one or more BankImportManifest JSON files into a single standardized,
 * strictly validated BankImportManifest ready for Selective Lab import.
 *
 * Automatically enforces the locked naming standard:
 *   batchLabel:       YYYY-MM-DD_bNN  (e.g. 2026-11-22_b01)
 *   stimulusFamilyId: <batch>_<sec>_s<nn>       (e.g. 2026-11-22_b01_read_s01)
 *   stimulusId:       <stimulusFamilyId>_v<ver> (e.g. 2026-11-22_b01_read_s01_v1)
 *   questionFamilyId: <batch>_<sec>_<nn>        (e.g. 2026-11-22_b01_math_01)
 *   questionId:       <questionFamilyId>_v<ver> (e.g. 2026-11-22_b01_math_01_v1)
 *   partId:           <questionFamilyId>_p<n>   (e.g. 2026-11-22_b01_math_01_p1)
 * Also normalizes inline SVG font declarations to Selective Lab's Anthropic faces.
 *
 * Usage:
 *   node scripts/merge_manifests.mjs <in1.json> [in2.json ...] \
 *     --out merged.json \
 *     --batch-label "2026-11-22_b01" \
 *     [--qc active|verified|draft] \
 *     [--keep-ids] \
 *     [--append-scenarios scenarios-log.txt]
 */

import fs from 'node:fs';
import path from 'node:path';
import { BATCH_LABEL_RE, normalizeSvgFonts, validateManifestObject } from './validate_manifest.mjs';

const args = process.argv.slice(2);
const inputs = [];
const flags = {};

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--keep-ids' || a === '--allow-custom-label') {
    flags[a.slice(2)] = true;
  } else if (a.startsWith('--')) {
    flags[a.slice(2)] = args[i + 1];
    i++;
  } else {
    inputs.push(a);
  }
}

if (inputs.length === 0 || !flags.out) {
  console.error(
    'Usage: node scripts/merge_manifests.mjs <in1.json> [in2.json ...] --out <merged.json> [--batch-label YYYY-MM-DD_b01] [--qc active|verified|draft] [--keep-ids] [--append-scenarios log.txt]'
  );
  process.exit(2);
}

const today = new Date().toISOString().slice(0, 10);
const batchLabel = flags['batch-label'] || `${today}_b01`;
if (!flags['allow-custom-label'] && !BATCH_LABEL_RE.test(batchLabel)) {
  console.error(`Invalid --batch-label "${batchLabel}": must match YYYY-MM-DD_bNN (e.g. "${today}_b01").`);
  process.exit(2);
}

const defaultQcStatus =
  flags.qc === 'verified' || flags.qc === 'draft' || flags.qc === 'active' ? flags.qc : 'active';

const FORBIDDEN_ITEM_FIELDS = ['contentHash', 'evidenceRevision', 'batchId', 'batchLabel', 'createdAtIso', 'updatedAtIso'];
const SECTION_RANK = { READ: 1, MATH: 2, THINK: 3, WRIT: 4 };
const READ_FORMAT_RANK = {
  READ_FICTION_MCQ: 1,
  READ_VOCAB_CLOZE: 2,
  READ_POETRY_MCQ: 3,
  READ_GAPPED_TEXT: 4,
  READ_MULTIPLE_MATCH: 5,
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

function stripForbidden(obj) {
  const copy = { ...obj };
  for (const k of FORBIDDEN_ITEM_FIELDS) delete copy[k];
  return copy;
}

function normalizeVisualSvg(visual) {
  if (!visual || typeof visual !== 'object') return visual;
  if (visual.visualType === 'inline_svg' && typeof visual.svgMarkup === 'string') {
    return { ...visual, svgMarkup: normalizeSvgFonts(visual.svgMarkup) };
  }
  return visual;
}

const rawStimuli = [];
const rawQuestions = [];
const seenRawStimIds = new Set();
const seenRawQIds = new Set();
const scenarioSummaries = [];

for (const file of inputs) {
  const abs = path.resolve(file);
  let rawText = fs.readFileSync(abs, 'utf8').trim();
  rawText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const data = JSON.parse(rawText);

  for (const s of data.stimuli || []) {
    if (seenRawStimIds.has(s.stimulusId)) {
      console.error(`Duplicate stimulusId "${s.stimulusId}" in ${file}`);
      process.exit(1);
    }
    seenRawStimIds.add(s.stimulusId);
    rawStimuli.push(s);
    if (s.title) scenarioSummaries.push(`[${s.section}] ${s.title} (${s.genreOrTextType})`);
  }

  for (const q of data.questions || []) {
    if (seenRawQIds.has(q.questionId)) {
      console.error(`Duplicate questionId "${q.questionId}" in ${file}`);
      process.exit(1);
    }
    seenRawQIds.add(q.questionId);
    rawQuestions.push(q);
    if (!q.stimulusId && q.parts?.[0]?.promptText) {
      const snippet = q.parts[0].promptText.replace(/\s+/g, ' ').slice(0, 90);
      scenarioSummaries.push(`[${q.section}/${q.parts[0].skillId}] ${snippet}`);
    }
  }
}

// Sort questions by section (READ -> MATH -> THINK -> WRIT), and Reading into exact NSW Part 1..5 order.
const indexedQuestions = rawQuestions.map((q, idx) => ({ q, idx }));
indexedQuestions.sort((a, b) => {
  const sDiff = (SECTION_RANK[a.q.section] ?? 99) - (SECTION_RANK[b.q.section] ?? 99);
  if (sDiff !== 0) return sDiff;
  if (a.q.section === 'READ') {
    const fDiff = (READ_FORMAT_RANK[a.q.formatType] ?? 99) - (READ_FORMAT_RANK[b.q.formatType] ?? 99);
    if (fDiff !== 0) return fDiff;
  }
  return a.idx - b.idx;
});
const orderedQuestions = indexedQuestions.map((x) => x.q);

// Order stimuli by section + first referencing question order so READ stimuli become s01..s05 matching Parts 1..5.
const firstStimUse = new Map();
orderedQuestions.forEach((q, idx) => {
  if (q.stimulusId && !firstStimUse.has(q.stimulusId)) firstStimUse.set(q.stimulusId, idx);
});
const indexedStimuli = rawStimuli.map((s, idx) => ({ s, idx }));
indexedStimuli.sort((a, b) => {
  const sDiff = (SECTION_RANK[a.s.section] ?? 99) - (SECTION_RANK[b.s.section] ?? 99);
  if (sDiff !== 0) return sDiff;
  const uA = firstStimUse.has(a.s.stimulusId) ? firstStimUse.get(a.s.stimulusId) : 1e9;
  const uB = firstStimUse.has(b.s.stimulusId) ? firstStimUse.get(b.s.stimulusId) : 1e9;
  if (uA !== uB) return uA - uB;
  return a.idx - b.idx;
});
const orderedStimuli = indexedStimuli.map((x) => x.s);

const stimIdMap = new Map();
const stimCounterBySec = {};
const mergedStimuli = orderedStimuli.map((s) => {
  const clean = stripForbidden(s);
  const version = Number.isInteger(clean.version) && clean.version >= 1 ? clean.version : 1;
  const sec = String(clean.section || 'READ').toLowerCase();
  let stimulusFamilyId = clean.stimulusFamilyId || String(clean.stimulusId || '').replace(/_v\d+$/, '');
  let stimulusId = clean.stimulusId;
  if (!flags['keep-ids']) {
    stimCounterBySec[sec] = (stimCounterBySec[sec] || 0) + 1;
    stimulusFamilyId = `${batchLabel}_${sec}_s${pad2(stimCounterBySec[sec])}`;
    stimulusId = `${stimulusFamilyId}_v${version}`;
  }
  stimIdMap.set(s.stimulusId, stimulusId);
  const out = {
    ...clean,
    stimulusId,
    stimulusFamilyId,
    version,
  };
  if (out.visual) out.visual = normalizeVisualSvg(out.visual);
  return out;
});

const qCounterBySec = {};
const mergedQuestions = orderedQuestions.map((q) => {
  const clean = stripForbidden(q);
  const version = Number.isInteger(clean.version) && clean.version >= 1 ? clean.version : 1;
  const sec = String(clean.section || 'MATH').toLowerCase();
  let questionFamilyId = clean.questionFamilyId || String(clean.questionId || '').replace(/_v\d+$/, '');
  let questionId = clean.questionId;
  if (!flags['keep-ids']) {
    qCounterBySec[sec] = (qCounterBySec[sec] || 0) + 1;
    questionFamilyId = `${batchLabel}_${sec}_${pad2(qCounterBySec[sec])}`;
    questionId = `${questionFamilyId}_v${version}`;
  }
  const remappedStimId =
    clean.stimulusId && stimIdMap.has(clean.stimulusId) ? stimIdMap.get(clean.stimulusId) : clean.stimulusId;

  const parts = (clean.parts || []).map((p, pIdx) => ({
    ...p,
    partId: flags['keep-ids'] ? p.partId : `${questionFamilyId}_p${pIdx + 1}`,
    partIndex: pIdx,
    options: (p.options || []).map((opt) => (opt.visual ? { ...opt, visual: normalizeVisualSvg(opt.visual) } : opt)),
  }));

  const out = {
    ...clean,
    questionId,
    questionFamilyId,
    version,
    ...(remappedStimId ? { stimulusId: remappedStimId } : {}),
    parts,
    provenance: {
      sourceType: clean.provenance?.sourceType || 'ai_generated',
      sourceReference: batchLabel,
      verifierAgreed: clean.provenance?.verifierAgreed ?? true,
      auditorReviewed: clean.provenance?.auditorReviewed ?? false,
    },
  };
  if (out.visual) out.visual = normalizeVisualSvg(out.visual);
  return out;
});

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
console.log(`Batch:      ${batchLabel}`);
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
