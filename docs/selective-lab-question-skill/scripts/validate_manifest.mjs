#!/usr/bin/env node
/**
 * Standalone BankImportManifest validator for Selective Lab.
 * Zero external dependencies — runs anywhere with Node.js >= 18.
 *
 * Usage:
 *   node scripts/validate_manifest.mjs <path-to-manifest.json> [--strict] [--json]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const taxonomyPath = path.resolve(__dirname, '../schema/skills-taxonomy.json');
const taxonomy = JSON.parse(fs.readFileSync(taxonomyPath, 'utf8'));
const VALID_SKILLS = new Map(taxonomy.skills.map((s) => [s.skillId, s]));

const ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const OPTION_KEY_RE = /^[A-H]$/;
const VALID_SECTIONS = new Set(['READ', 'MATH', 'THINK', 'WRIT']);
const VALID_FORMATS = new Set([
  'READ_FICTION_MCQ',
  'READ_VOCAB_CLOZE',
  'READ_POETRY_MCQ',
  'READ_GAPPED_TEXT',
  'READ_MULTIPLE_MATCH',
  'MATH_MCQ_5',
  'THINK_MCQ_4',
  'WRIT_TYPED_TASK',
]);
const FORMAT_SECTION = {
  READ_FICTION_MCQ: 'READ',
  READ_VOCAB_CLOZE: 'READ',
  READ_POETRY_MCQ: 'READ',
  READ_GAPPED_TEXT: 'READ',
  READ_MULTIPLE_MATCH: 'READ',
  MATH_MCQ_5: 'MATH',
  THINK_MCQ_4: 'THINK',
  WRIT_TYPED_TASK: 'WRIT',
};
const VALID_POOL_TYPES = new Set(['practice', 'diagnostic', 'official_calibration', 'benchmark_holdout']);
const VALID_QC_STATUS = new Set(['active', 'verified', 'draft', 'quarantined', 'retired']);
const VALID_DEFAULT_QC = new Set(['active', 'verified', 'draft']);
const VALID_COGNITIVE = new Set(['recall_locate', 'apply_procedural', 'analyze_infer', 'evaluate_transfer']);
const VALID_VISUAL_TYPES = new Set(['none', 'inline_svg', 'image_asset', 'structured_table']);
const FORBIDDEN_GENERATED_FIELDS = ['contentHash', 'evidenceRevision', 'batchId', 'createdAtIso', 'updatedAtIso'];

function checkVisual(visual, location, isOptionTile, errors, warnings) {
  if (!visual) return;
  if (typeof visual !== 'object') {
    errors.push(`${location}: visual must be an object.`);
    return;
  }
  if (!VALID_VISUAL_TYPES.has(visual.visualType)) {
    errors.push(`${location}: invalid visualType "${String(visual.visualType)}".`);
    return;
  }
  if (visual.visualType === 'none') return;
  if (!visual.altText || typeof visual.altText !== 'string' || !visual.altText.trim()) {
    errors.push(`${location}: visual missing non-empty altText.`);
  }

  if (visual.visualType === 'inline_svg') {
    const svg = visual.svgMarkup;
    if (!svg || typeof svg !== 'string') {
      errors.push(`${location}: inline_svg missing svgMarkup string.`);
      return;
    }
    const trimmed = svg.trim();
    if (!trimmed.startsWith('<svg') || !trimmed.endsWith('</svg>')) {
      errors.push(`${location}: svgMarkup must be a single <svg>...</svg> element.`);
    }
    if (!/xmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/.test(trimmed)) {
      errors.push(`${location}: svgMarkup missing xmlns="http://www.w3.org/2000/svg".`);
    }
    const vbMatch = trimmed.match(/viewBox\s*=\s*["']\s*([-\d.]+)\s+([-\d.]+)\s+([\d.]+)\s+([\d.]+)\s*["']/);
    if (!vbMatch) {
      errors.push(`${location}: svgMarkup missing numeric viewBox="minX minY width height".`);
    } else {
      const vbW = Number(vbMatch[3]);
      const vbH = Number(vbMatch[4]);
      if (!(vbW > 0 && vbH > 0)) {
        errors.push(`${location}: svgMarkup viewBox width/height must be positive.`);
      } else if (isOptionTile) {
        const aspect = Math.max(vbW / vbH, vbH / vbW);
        if (aspect > 2.2) {
          warnings.push(`${location}: option tile SVG viewBox (${vbW}x${vbH}) has extreme aspect ratio (${aspect.toFixed(2)}:1); target ~220x140, 180x140, or 160x160.`);
        }
      } else if (vbH > 440) {
        warnings.push(`${location}: diagram SVG viewBox height (${vbH}) exceeds recommended 420 units.`);
      }
    }
    if (/<script[\s>]/i.test(trimmed)) {
      errors.push(`${location}: svgMarkup must not contain <script>.`);
    }
    if (/\son[a-z]+\s*=/i.test(trimmed) || /javascript:/i.test(trimmed)) {
      errors.push(`${location}: svgMarkup must not contain inline event handlers or javascript: URIs.`);
    }
    if (/<foreignObject[\s>]/i.test(trimmed)) {
      errors.push(`${location}: svgMarkup must not contain <foreignObject>.`);
    }
    if (/(?:href|xlink:href)\s*=\s*["']\s*https?:/i.test(trimmed) || /@import\s/i.test(trimmed)) {
      errors.push(`${location}: svgMarkup must not reference external URLs or @import.`);
    }
    // Check basic tag balance for <svg>
    const openSvg = (trimmed.match(/<svg[\s>]/g) || []).length;
    const closeSvg = (trimmed.match(/<\/svg>/g) || []).length;
    if (openSvg !== closeSvg) {
      errors.push(`${location}: unbalanced <svg> tags (${openSvg} open vs ${closeSvg} close).`);
    }
    if (/width\s*=\s*["']\s*(\d{4,})/.test(trimmed) || /height\s*=\s*["']\s*(\d{4,})/.test(trimmed)) {
      warnings.push(`${location}: svgMarkup has a huge explicit pixel width/height attribute; rely on viewBox instead.`);
    }
  } else if (visual.visualType === 'structured_table') {
    const td = visual.tableData;
    if (!td || !Array.isArray(td.headers) || !Array.isArray(td.rows)) {
      errors.push(`${location}: structured_table requires tableData { headers[], rows[][] }.`);
    } else {
      for (let r = 0; r < td.rows.length; r++) {
        if (!Array.isArray(td.rows[r])) {
          errors.push(`${location}: tableData.rows[${r}] must be an array.`);
        } else if (td.rows[r].length !== td.headers.length) {
          warnings.push(`${location}: tableData.rows[${r}] has ${td.rows[r].length} cells but headers has ${td.headers.length}.`);
        }
      }
    }
  } else if (visual.visualType === 'image_asset') {
    if (!visual.imageUrl || typeof visual.imageUrl !== 'string') {
      errors.push(`${location}: image_asset missing imageUrl.`);
    } else if (visual.imageUrl.startsWith('data:') && visual.imageUrl.length > 100_000) {
      warnings.push(`${location}: large data URI (${Math.round(visual.imageUrl.length / 1024)} KB) risks Firestore 1 MiB ceiling; prefer inline_svg.`);
    }
  }
}

export function validateManifestObject(raw) {
  const errors = [];
  const warnings = [];
  const stats = {
    stimuliCount: 0,
    questionsCount: 0,
    partsCount: 0,
    bySection: { READ: 0, MATH: 0, THINK: 0, WRIT: 0 },
    byFormat: {},
    visualQuestions: 0,
    visualOptionGridQuestions: 0,
  };

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: ['Manifest root must be a JSON object.'], warnings, stats };
  }

  if (raw.manifestVersion !== '1.0') {
    errors.push(`manifestVersion must be "1.0" (got ${JSON.stringify(raw.manifestVersion)}).`);
  }
  if (typeof raw.batchLabel !== 'string' || !raw.batchLabel.trim()) {
    errors.push('batchLabel must be a non-empty string.');
  } else if (raw.batchLabel.length > 200) {
    errors.push(`batchLabel exceeds 200 chars (${raw.batchLabel.length}).`);
  }
  if (raw.defaultPoolType !== undefined && !VALID_POOL_TYPES.has(raw.defaultPoolType)) {
    errors.push(`Invalid defaultPoolType "${String(raw.defaultPoolType)}".`);
  }
  if (raw.defaultQcStatus !== undefined && !VALID_DEFAULT_QC.has(raw.defaultQcStatus)) {
    errors.push(`Invalid defaultQcStatus "${String(raw.defaultQcStatus)}" (expected active|verified|draft).`);
  }

  const stimuli = Array.isArray(raw.stimuli) ? raw.stimuli : [];
  if (raw.stimuli !== undefined && !Array.isArray(raw.stimuli)) {
    errors.push('stimuli must be an array.');
  }
  const questions = Array.isArray(raw.questions) ? raw.questions : [];
  if (!Array.isArray(raw.questions) || raw.questions.length === 0) {
    errors.push('questions must be a non-empty array.');
  }

  stats.stimuliCount = stimuli.length;
  stats.questionsCount = questions.length;

  // Validate stimuli
  const stimuliById = new Map();
  for (let i = 0; i < stimuli.length; i++) {
    const s = stimuli[i];
    const loc = `stimuli[${i}] (${s?.stimulusId || 'unknown'})`;
    if (!s || typeof s !== 'object') {
      errors.push(`${loc}: must be an object.`);
      continue;
    }
    const byteSize = Buffer.byteLength(JSON.stringify(s), 'utf8');
    if (byteSize > 950_000) errors.push(`${loc}: serialized size (${byteSize} B) approaches Firestore 1 MiB ceiling.`);
    else if (byteSize > 250_000) warnings.push(`${loc}: serialized size (${Math.round(byteSize / 1024)} KB) is large.`);

    if (!s.stimulusId || !ID_RE.test(s.stimulusId)) {
      errors.push(`${loc}: stimulusId must match ^[a-zA-Z0-9_-]{1,128}$.`);
    } else if (stimuliById.has(s.stimulusId)) {
      errors.push(`${loc}: duplicate stimulusId "${s.stimulusId}".`);
    } else {
      stimuliById.set(s.stimulusId, s);
    }
    if (s.stimulusFamilyId !== undefined && !ID_RE.test(s.stimulusFamilyId)) {
      errors.push(`${loc}: stimulusFamilyId must match ^[a-zA-Z0-9_-]{1,128}$.`);
    }
    if (!Number.isInteger(s.version) || s.version < 1) {
      errors.push(`${loc}: version must be a positive integer >= 1.`);
    }
    if (!VALID_SECTIONS.has(s.section)) {
      errors.push(`${loc}: invalid section "${String(s.section)}".`);
    }
    if (!s.genreOrTextType || typeof s.genreOrTextType !== 'string') {
      errors.push(`${loc}: missing genreOrTextType string.`);
    }
    for (const f of FORBIDDEN_GENERATED_FIELDS) {
      if (f in s) warnings.push(`${loc}: omit server-generated field "${f}".`);
    }
    if (Array.isArray(s.extracts)) {
      const seenLabels = new Set();
      for (const ex of s.extracts) {
        if (!ex || !OPTION_KEY_RE.test(String(ex.label || ''))) {
          errors.push(`${loc}: extract label "${String(ex?.label)}" must match ^[A-H]$.`);
        } else if (seenLabels.has(ex.label)) {
          errors.push(`${loc}: duplicate extract label "${ex.label}".`);
        } else {
          seenLabels.add(ex.label);
        }
        if (typeof ex?.bodyMarkdown !== 'string' || !ex.bodyMarkdown.trim()) {
          errors.push(`${loc}: extract "${String(ex?.label)}" missing non-empty bodyMarkdown.`);
        }
      }
    }
    checkVisual(s.visual, `${loc}.visual`, false, errors, warnings);
  }

  // Validate questions
  const seenQuestionIds = new Set();
  const seenPartIds = new Set();

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const qLoc = `questions[${i}] (${q?.questionId || 'unknown'})`;
    if (!q || typeof q !== 'object') {
      errors.push(`${qLoc}: must be an object.`);
      continue;
    }

    const byteSize = Buffer.byteLength(JSON.stringify(q), 'utf8');
    if (byteSize > 950_000) errors.push(`${qLoc}: serialized size (${byteSize} B) approaches Firestore 1 MiB ceiling.`);
    else if (byteSize > 250_000) warnings.push(`${qLoc}: serialized size (${Math.round(byteSize / 1024)} KB) is large.`);

    if (!q.questionId || !ID_RE.test(q.questionId)) {
      errors.push(`${qLoc}: questionId must match ^[a-zA-Z0-9_-]{1,128}$.`);
    } else if (seenQuestionIds.has(q.questionId)) {
      errors.push(`${qLoc}: duplicate questionId "${q.questionId}".`);
    } else {
      seenQuestionIds.add(q.questionId);
    }

    if (!q.questionFamilyId || !ID_RE.test(q.questionFamilyId)) {
      errors.push(`${qLoc}: questionFamilyId must match ^[a-zA-Z0-9_-]{1,128}$.`);
    }
    if (!Number.isInteger(q.version) || q.version < 1) {
      errors.push(`${qLoc}: version must be a positive integer >= 1.`);
    }
    if (!VALID_SECTIONS.has(q.section)) {
      errors.push(`${qLoc}: invalid section "${String(q.section)}".`);
    } else {
      stats.bySection[q.section]++;
    }
    if (!VALID_FORMATS.has(q.formatType)) {
      errors.push(`${qLoc}: invalid formatType "${String(q.formatType)}".`);
    } else {
      stats.byFormat[q.formatType] = (stats.byFormat[q.formatType] || 0) + 1;
      if (q.section && FORMAT_SECTION[q.formatType] !== q.section) {
        errors.push(`${qLoc}: formatType "${q.formatType}" does not match section "${q.section}".`);
      }
      if (q.formatType.length > 64) errors.push(`${qLoc}: formatType exceeds 64 chars.`);
    }
    if (q.poolType !== undefined) {
      if (!VALID_POOL_TYPES.has(q.poolType)) errors.push(`${qLoc}: invalid poolType "${String(q.poolType)}".`);
      if (String(q.poolType).length > 64) errors.push(`${qLoc}: poolType exceeds 64 chars.`);
    }
    if (q.qcStatus !== undefined && !VALID_QC_STATUS.has(q.qcStatus)) {
      errors.push(`${qLoc}: invalid qcStatus "${String(q.qcStatus)}".`);
    }
    for (const f of [...FORBIDDEN_GENERATED_FIELDS, 'batchLabel']) {
      if (f in q) warnings.push(`${qLoc}: omit server-generated/top-level field "${f}".`);
    }
    if (!q.provenance || typeof q.provenance !== 'object') {
      warnings.push(`${qLoc}: missing provenance object.`);
    }

    const stim = q.stimulusId ? stimuliById.get(q.stimulusId) : undefined;
    if (q.stimulusId && !stim) {
      errors.push(`${qLoc}: stimulusId "${q.stimulusId}" does not resolve inside manifest.stimuli.`);
    }
    if (
      ['READ_FICTION_MCQ', 'READ_POETRY_MCQ', 'READ_VOCAB_CLOZE', 'READ_GAPPED_TEXT', 'READ_MULTIPLE_MATCH'].includes(
        q.formatType
      ) &&
      !q.stimulusId
    ) {
      errors.push(`${qLoc}: ${q.formatType} requires a stimulusId.`);
    }

    if (q.visual && q.visual.visualType !== 'none') {
      stats.visualQuestions++;
      checkVisual(q.visual, `${qLoc}.visual`, false, errors, warnings);
    }

    if (!Array.isArray(q.parts) || q.parts.length === 0) {
      errors.push(`${qLoc}: parts must be a non-empty array.`);
      continue;
    }

    // Format-level checks
    if (q.formatType === 'WRIT_TYPED_TASK') {
      if (!q.writingSpec) {
        errors.push(`${qLoc}: WRIT_TYPED_TASK requires writingSpec.`);
      } else {
        for (const reqField of ['genre', 'audience', 'purpose', 'recommendedWordRange', 'timeLimitSec']) {
          if (q.writingSpec[reqField] === undefined) {
            errors.push(`${qLoc}.writingSpec: missing "${reqField}".`);
          }
        }
      }
    }

    if (q.formatType === 'READ_GAPPED_TEXT' || q.formatType === 'READ_MULTIPLE_MATCH') {
      if (!q.sharedPoolConfig || !Array.isArray(q.sharedPoolConfig.poolKeys)) {
        errors.push(`${qLoc}: ${q.formatType} requires sharedPoolConfig { reuseAllowed, poolKeys[] }.`);
      } else {
        const expectedReuse = q.formatType === 'READ_MULTIPLE_MATCH';
        if (q.sharedPoolConfig.reuseAllowed !== expectedReuse) {
          errors.push(`${qLoc}: sharedPoolConfig.reuseAllowed must be ${expectedReuse} for ${q.formatType}.`);
        }
        if (stim?.extracts) {
          const extractLabels = stim.extracts.map((e) => e.label);
          if (JSON.stringify(extractLabels) !== JSON.stringify(q.sharedPoolConfig.poolKeys)) {
            errors.push(`${qLoc}: sharedPoolConfig.poolKeys [${q.sharedPoolConfig.poolKeys}] must match stimulus.extracts labels [${extractLabels}].`);
          }
        }
      }
    }

    const usedCorrectKeys = new Set();
    let hasOptionVisualGrid = false;

    for (let pIdx = 0; pIdx < q.parts.length; pIdx++) {
      const p = q.parts[pIdx];
      const pLoc = `${qLoc}.parts[${pIdx}] (${p?.partId || 'unknown'})`;
      stats.partsCount++;

      if (!p || typeof p !== 'object') {
        errors.push(`${pLoc}: must be an object.`);
        continue;
      }
      if ('visual' in p) {
        errors.push(`${pLoc}: do not place visual on part; use question.visual, stimulus.visual, or options[].visual.`);
      }
      if (!p.partId || typeof p.partId !== 'string') {
        errors.push(`${pLoc}: missing partId.`);
      } else if (seenPartIds.has(p.partId)) {
        errors.push(`${pLoc}: duplicate partId "${p.partId}" across manifest.`);
      } else {
        seenPartIds.add(p.partId);
      }
      if (p.partIndex !== pIdx) {
        errors.push(`${pLoc}: partIndex (${String(p.partIndex)}) must be zero-based and equal array index ${pIdx}.`);
      }
      if (typeof p.promptText !== 'string' || !p.promptText.trim()) {
        errors.push(`${pLoc}: missing non-empty promptText.`);
      }
      if (!p.skillId || !VALID_SKILLS.has(p.skillId)) {
        errors.push(`${pLoc}: unknown canonical skillId "${String(p.skillId)}".`);
      } else if (q.section && VALID_SKILLS.get(p.skillId).section !== q.section) {
        errors.push(`${pLoc}: skillId "${p.skillId}" belongs to section ${VALID_SKILLS.get(p.skillId).section}, not ${q.section}.`);
      }
      if (Array.isArray(p.secondarySkillIds)) {
        for (const sec of p.secondarySkillIds) {
          if (!VALID_SKILLS.has(sec)) {
            errors.push(`${pLoc}: unknown secondarySkillId "${sec}".`);
          }
        }
      }
      if (typeof p.difficultyInitial !== 'number' || p.difficultyInitial < 1 || p.difficultyInitial > 5) {
        errors.push(`${pLoc}: difficultyInitial must be a number in [1, 5].`);
      }
      if (p.difficultyCalibrated !== undefined) {
        warnings.push(`${pLoc}: omit difficultyCalibrated unless backed by calibration evidence.`);
      }
      if (!Number.isInteger(p.targetTimeSec) || p.targetTimeSec < 10) {
        errors.push(`${pLoc}: targetTimeSec must be an integer >= 10.`);
      }
      if (!VALID_COGNITIVE.has(p.cognitiveDemand)) {
        errors.push(`${pLoc}: invalid cognitiveDemand "${String(p.cognitiveDemand)}".`);
      }

      const options = Array.isArray(p.options) ? p.options : [];
      if (!Array.isArray(p.options)) errors.push(`${pLoc}: options must be an array.`);
      if (options.length > 8) errors.push(`${pLoc}: exceeds maximum 8 options.`);

      const optionKeys = new Set();
      let anyOptVisual = false;
      let allOptTextShort = true;

      for (let oIdx = 0; oIdx < options.length; oIdx++) {
        const opt = options[oIdx];
        if (!opt || !OPTION_KEY_RE.test(String(opt.key || ''))) {
          errors.push(`${pLoc}.options[${oIdx}]: key must match ^[A-H]$.`);
        } else if (optionKeys.has(opt.key)) {
          errors.push(`${pLoc}: duplicate option key "${opt.key}".`);
        } else {
          optionKeys.add(opt.key);
        }
        if (typeof opt?.text !== 'string') {
          errors.push(`${pLoc}.options[${oIdx}]: text must be a string.`);
        } else if (opt.text.trim().length > 48) {
          allOptTextShort = false;
        }
        if (opt?.visual && opt.visual.visualType !== 'none') {
          anyOptVisual = true;
          checkVisual(opt.visual, `${pLoc}.options[${oIdx}].visual`, true, errors, warnings);
        }
      }

      if (anyOptVisual) {
        if (allOptTextShort) {
          hasOptionVisualGrid = true;
        } else {
          warnings.push(`${pLoc}: visual options exist but at least one option.text exceeds 48 chars, disabling Selective Lab's compact 2-column tile grid.`);
        }
      }

      // Option count checks by format
      if (q.formatType === 'MATH_MCQ_5' && options.length !== 5) {
        errors.push(`${pLoc}: MATH_MCQ_5 should have 5 options A-E (got ${options.length}).`);
      }
      if (['THINK_MCQ_4', 'READ_FICTION_MCQ', 'READ_POETRY_MCQ', 'READ_VOCAB_CLOZE'].includes(q.formatType) && options.length !== 4) {
        errors.push(`${pLoc}: ${q.formatType} should have 4 options A-D (got ${options.length}).`);
      }
      if (['READ_GAPPED_TEXT', 'READ_MULTIPLE_MATCH', 'WRIT_TYPED_TASK'].includes(q.formatType) && options.length !== 0) {
        errors.push(`${pLoc}: ${q.formatType} must have options: [] (got ${options.length}).`);
      }

      // SlotRef & placeholder alignment
      if (q.formatType === 'READ_VOCAB_CLOZE' || q.formatType === 'READ_GAPPED_TEXT') {
        const expectedSlot = `gap:${pIdx + 1}`;
        if (p.slotRef !== expectedSlot) {
          errors.push(`${pLoc}: expected slotRef "${expectedSlot}" (got "${String(p.slotRef)}").`);
        }
        if (stim?.mainTextMarkdown) {
          const token = `{{${expectedSlot}}}`;
          const occurrences = stim.mainTextMarkdown.split(token).length - 1;
          if (occurrences !== 1) {
            errors.push(`${pLoc}: stimulus "${stim.stimulusId}" must contain placeholder "${token}" exactly once (found ${occurrences}).`);
          }
        }
      }
      if (q.formatType === 'READ_MULTIPLE_MATCH') {
        const expectedSlot = `stmt:${pIdx + 1}`;
        if (p.slotRef !== expectedSlot) {
          errors.push(`${pLoc}: expected slotRef "${expectedSlot}" (got "${String(p.slotRef)}").`);
        }
      }

      // Correct answer & distractorRationales checks
      const ans = String(p.correctAnswerKey ?? '').trim();
      if (q.formatType === 'WRIT_TYPED_TASK') {
        if (ans !== '') errors.push(`${pLoc}: WRIT_TYPED_TASK correctAnswerKey must be "".`);
        if (p.skillId !== 'WRIT.CRIT.TOPIC_PROMPT_ADHERENCE') {
          errors.push(`${pLoc}: WRIT_TYPED_TASK primary skillId must be "WRIT.CRIT.TOPIC_PROMPT_ADHERENCE".`);
        }
      } else {
        if (!ans) {
          errors.push(`${pLoc}: missing correctAnswerKey.`);
        } else if (options.length > 0 && !optionKeys.has(ans)) {
          errors.push(`${pLoc}: correctAnswerKey "${ans}" is not in options.`);
        } else if (q.sharedPoolConfig && !q.sharedPoolConfig.poolKeys.includes(ans)) {
          errors.push(`${pLoc}: correctAnswerKey "${ans}" is not in sharedPoolConfig.poolKeys.`);
        }

        if (q.formatType === 'READ_GAPPED_TEXT') {
          if (usedCorrectKeys.has(ans)) {
            errors.push(`${pLoc}: duplicate correctAnswerKey "${ans}" in READ_GAPPED_TEXT (reuseAllowed is false).`);
          }
          usedCorrectKeys.add(ans);
          const matchedExtract = stim?.extracts?.find((e) => e.label === ans);
          if (matchedExtract?.isDecoy) {
            errors.push(`${pLoc}: correctAnswerKey "${ans}" points to an extract marked isDecoy: true.`);
          }
        }

        // Distractor rationales completeness
        const availableKeys = options.length > 0 ? [...optionKeys] : q.sharedPoolConfig?.poolKeys || [];
        const expectedDistractors = availableKeys.filter((k) => k !== ans);
        const dr = p.distractorRationales;
        if (!dr || typeof dr !== 'object') {
          warnings.push(`${pLoc}: missing distractorRationales object.`);
        } else {
          if (ans && ans in dr) {
            errors.push(`${pLoc}: distractorRationales must NOT include the correctAnswerKey "${ans}".`);
          }
          for (const dk of expectedDistractors) {
            if (!dr[dk] || typeof dr[dk] !== 'string' || !dr[dk].trim()) {
              warnings.push(`${pLoc}: distractorRationales missing explanation for incorrect key "${dk}".`);
            }
          }
          for (const k of Object.keys(dr)) {
            if (!availableKeys.includes(k)) {
              errors.push(`${pLoc}: distractorRationales key "${k}" is not an available option/extract key.`);
            }
          }
        }
      }

      // Worked explanation checks
      if (typeof p.workedExplanation !== 'string' || !p.workedExplanation.trim()) {
        errors.push(`${pLoc}: missing non-empty string workedExplanation.`);
      } else {
        if (p.workedExplanation.includes('\\n')) {
          errors.push(`${pLoc}: workedExplanation contains literal "\\\\n" (double-escaped newline); use real line breaks in the string.`);
        }
        if (q.formatType !== 'WRIT_TYPED_TASK' && p.workedExplanation.trim().length < 60) {
          warnings.push(`${pLoc}: workedExplanation is very short (${p.workedExplanation.trim().length} chars); ensure full Year 6 reasoning.`);
        }
      }

      // EvidenceRefs exact UTF-16 slice check
      if (Array.isArray(p.evidenceRefs)) {
        for (let rIdx = 0; rIdx < p.evidenceRefs.length; rIdx++) {
          const ref = p.evidenceRefs[rIdx];
          const rLoc = `${pLoc}.evidenceRefs[${rIdx}] (${ref?.refId || 'unknown'})`;
          if (
            !Number.isInteger(ref?.startOffset) ||
            !Number.isInteger(ref?.endOffset) ||
            ref.startOffset < 0 ||
            ref.endOffset <= ref.startOffset
          ) {
            errors.push(`${rLoc}: invalid integer UTF-16 range [${ref?.startOffset}, ${ref?.endOffset}].`);
            continue;
          }
          if (!ref.quote || typeof ref.quote !== 'string') {
            errors.push(`${rLoc}: missing quote string.`);
            continue;
          }
          if (!stim) {
            errors.push(`${rLoc}: cannot verify evidenceRef without resolved stimulus.`);
            continue;
          }
          let targetText = '';
          if (ref.targetKind === 'mainText') {
            targetText = stim.mainTextMarkdown || '';
          } else if (ref.targetKind === 'extract') {
            const ex = stim.extracts?.find((e) => e.label === ref.extractLabel);
            if (!ex) {
              errors.push(`${rLoc}: extractLabel "${String(ref.extractLabel)}" not found on stimulus "${stim.stimulusId}".`);
              continue;
            }
            targetText = ex.bodyMarkdown;
          } else {
            errors.push(`${rLoc}: targetKind must be "mainText" or "extract".`);
            continue;
          }
          if (ref.endOffset > targetText.length) {
            errors.push(`${rLoc}: endOffset (${ref.endOffset}) exceeds UTF-16 target length (${targetText.length}).`);
            continue;
          }
          const actual = targetText.slice(ref.startOffset, ref.endOffset);
          if (actual !== ref.quote) {
            errors.push(`${rLoc}: UTF-16 slice mismatch at [${ref.startOffset}, ${ref.endOffset}]: expected ${JSON.stringify(actual.slice(0, 60))}, got ${JSON.stringify(ref.quote.slice(0, 60))}.`);
          }
          if (ref.stimulusRevision !== stim.version) {
            warnings.push(`${rLoc}: stimulusRevision (${ref.stimulusRevision}) != stimulus.version (${stim.version}).`);
          }
        }
      }
    }

    if (hasOptionVisualGrid) stats.visualOptionGridQuestions++;

    // Gapped text decoy verification
    if (q.formatType === 'READ_GAPPED_TEXT' && stim?.extracts) {
      const decoys = stim.extracts.filter((e) => e.isDecoy === true);
      if (decoys.length !== 1) {
        warnings.push(`${qLoc}: READ_GAPPED_TEXT normally has exactly 1 extract with isDecoy: true (found ${decoys.length}).`);
      }
      if (stim.extracts.length !== q.parts.length + 1) {
        warnings.push(`${qLoc}: READ_GAPPED_TEXT normally has parts.length + 1 extracts (${q.parts.length + 1}), found ${stim.extracts.length}.`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings, stats };
}

// CLI execution
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const args = process.argv.slice(2);
  const fileArg = args.find((a) => !a.startsWith('--'));
  const strict = args.includes('--strict');
  const asJson = args.includes('--json');

  if (!fileArg) {
    console.error('Usage: node scripts/validate_manifest.mjs <manifest.json> [--strict] [--json]');
    process.exit(2);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.resolve(fileArg), 'utf8'));
  } catch (err) {
    console.error(`Failed to read/parse JSON: ${err.message}`);
    process.exit(2);
  }

  const result = validateManifestObject(parsed);
  const ok = result.valid && (!strict || result.warnings.length === 0);

  if (asJson) {
    console.log(JSON.stringify({ ok, ...result }, null, 2));
  } else {
    console.log(`Manifest: ${fileArg}`);
    console.log(`Status:   ${ok ? 'PASS' : 'FAIL'} (${result.errors.length} errors, ${result.warnings.length} warnings)`);
    console.log(`Summary:  ${result.stats.stimuliCount} stimuli, ${result.stats.questionsCount} questions, ${result.stats.partsCount} parts`);
    console.log(`Sections: ${JSON.stringify(result.stats.bySection)}`);
    console.log(`Formats:  ${JSON.stringify(result.stats.byFormat)}`);
    console.log(`Visuals:  ${result.stats.visualQuestions} diagram Qs, ${result.stats.visualOptionGridQuestions} visual-option-grid Qs`);
    if (result.errors.length > 0) {
      console.log('\nErrors:');
      for (const e of result.errors) console.log(`  - ${e}`);
    }
    if (result.warnings.length > 0) {
      console.log('\nWarnings:');
      for (const w of result.warnings) console.log(`  - ${w}`);
    }
  }

  process.exit(ok ? 0 : 1);
}
