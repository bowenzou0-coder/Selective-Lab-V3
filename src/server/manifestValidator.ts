import crypto from 'node:crypto';
import type {
  BankImportManifest,
  CognitiveDemand,
  PoolType,
  QcStatus,
  QuestionItem,
  QuestionPart,
  SectionCode,
  StimulusGroup,
  VisualSpec,
} from '../shared/contracts.ts';
import { VALID_SKILL_IDS } from '../shared/skills.ts';

export interface ManifestDryRunReport {
  valid: boolean;
  batchLabel: string;
  stimuliCount: number;
  questionsCount: number;
  newQuestions: number;
  unchangedQuestions: number;
  versionBumpedQuestions: number;
  errors: string[];
  warnings: string[];
}

export function computeCanonicalHash(value: unknown): string {
  const normalized = JSON.stringify(value);
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

const VALID_SECTIONS = new Set<SectionCode>(['READ', 'MATH', 'THINK', 'WRIT']);
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

function normalizeVisual(v: unknown): VisualSpec | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const obj = v as Partial<VisualSpec>;
  let visualType = obj.visualType;
  if (!visualType) {
    if (obj.svgMarkup) visualType = 'inline_svg';
    else if (obj.imageUrl) visualType = 'image_asset';
    else if (obj.tableData) visualType = 'structured_table';
    else visualType = 'none';
  }
  return {
    visualType,
    altText: String(obj.altText || 'Question figure'),
    svgMarkup: obj.svgMarkup,
    imageUrl: obj.imageUrl,
    caption: obj.caption,
    tableData: obj.tableData,
  };
}

function defaultTargetSec(section: SectionCode): number {
  if (section === 'WRIT') return 1800;
  if (section === 'MATH') return 65;
  return 60;
}

export function validateAndDryRunManifest(
  raw: unknown,
  existingQuestions: QuestionItem[]
): { manifest: BankImportManifest | null; report: ManifestDryRunReport } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!raw || typeof raw !== 'object') {
    return {
      manifest: null,
      report: {
        valid: false,
        batchLabel: '',
        stimuliCount: 0,
        questionsCount: 0,
        newQuestions: 0,
        unchangedQuestions: 0,
        versionBumpedQuestions: 0,
        errors: ['Manifest payload must be a JSON object.'],
        warnings: [],
      },
    };
  }

  const m = raw as Partial<BankImportManifest>;
  const manifestVersion = m.manifestVersion === '1.0' || !m.manifestVersion ? '1.0' : m.manifestVersion;
  if (manifestVersion !== '1.0') {
    errors.push(`Unsupported manifestVersion "${String(m.manifestVersion)}". Expected "1.0".`);
  }
  const batchLabel =
    typeof m.batchLabel === 'string' && m.batchLabel.trim()
      ? m.batchLabel.trim()
      : '';
  if (!batchLabel) {
    errors.push('Missing batchLabel string.');
  }

  const defaultPoolType: PoolType = m.defaultPoolType || 'practice';
  const defaultQcStatus: Extract<QcStatus, 'draft' | 'verified' | 'active'> =
    m.defaultQcStatus || 'active';

  const rawStimuli = Array.isArray(m.stimuli) ? m.stimuli : [];
  const rawQuestions = Array.isArray(m.questions) ? m.questions : [];

  if (!Array.isArray(m.questions)) {
    errors.push('Manifest must contain a "questions" array.');
  }

  const stimuli: StimulusGroup[] = rawStimuli.map((s) => ({
    ...s,
    stimulusFamilyId: s.stimulusFamilyId || s.stimulusId.replace(/_v\d+$/, ''),
    version: typeof s.version === 'number' && s.version >= 1 ? s.version : 1,
    genreOrTextType: s.genreOrTextType || 'passage',
    visual: normalizeVisual(s.visual),
    sourceType: s.sourceType || 'ai_generated',
  }));

  const stimuliById = new Map(stimuli.map((s) => [s.stimulusId, s]));
  const existingByFamily = new Map<string, QuestionItem>();
  for (const eq of existingQuestions) {
    const prev = existingByFamily.get(eq.questionFamilyId);
    if (!prev || eq.version > prev.version) {
      existingByFamily.set(eq.questionFamilyId, eq);
    }
  }

  let newQuestions = 0;
  let unchangedQuestions = 0;
  let versionBumpedQuestions = 0;
  const seenQuestionIds = new Set<string>();
  const seenPartIds = new Set<string>();
  const normalizedQuestions: QuestionItem[] = [];

  for (let i = 0; i < rawQuestions.length; i++) {
    const rq = rawQuestions[i] as Partial<QuestionItem>;
    const qLabel = rq.questionId || `#${i + 1}`;
    if (!rq.questionId) {
      errors.push(`Question #${i + 1} missing questionId.`);
      continue;
    }
    if (seenQuestionIds.has(rq.questionId)) {
      errors.push(`Duplicate questionId "${rq.questionId}" in manifest.`);
      continue;
    }
    seenQuestionIds.add(rq.questionId);

    if (!rq.section || !VALID_SECTIONS.has(rq.section)) {
      errors.push(`Question ${qLabel} has invalid section "${String(rq.section)}".`);
      continue;
    }
    if (!rq.formatType || !VALID_FORMATS.has(rq.formatType)) {
      errors.push(`Question ${qLabel} has invalid formatType "${String(rq.formatType)}".`);
      continue;
    }

    const stim = rq.stimulusId ? stimuliById.get(rq.stimulusId) : undefined;
    if (rq.stimulusId && !stim) {
      warnings.push(
        `Question ${rq.questionId} references stimulus "${rq.stimulusId}" not included in manifest stimuli (will use existing bank stimulus if present).`
      );
    }

    let rawParts = Array.isArray(rq.parts) ? rq.parts : [];
    if (rq.formatType === 'WRIT_TYPED_TASK' && rawParts.length === 0) {
      rawParts = [
        {
          partId: `${rq.questionId}_p1`,
          partIndex: 0,
          promptText: rq.stemPrefix || 'Write a response addressing the task instructions.',
          skillId: 'WRIT.CRIT.TOPIC_PROMPT_ADHERENCE',
          difficultyInitial: 3.0,
          targetTimeSec: rq.writingSpec?.timeLimitSec ?? 1800,
          cognitiveDemand: 'evaluate_transfer',
          options: [],
          correctAnswerKey: '',
          workedExplanation: 'Assessed against the 6 Selective Writing rubric criteria.',
        },
      ];
    }

    if (rawParts.length === 0) {
      errors.push(`Question ${rq.questionId} has no parts.`);
      continue;
    }

    const normalizedParts: QuestionPart[] = [];
    for (let pIdx = 0; pIdx < rawParts.length; pIdx++) {
      const rp = rawParts[pIdx] as Partial<QuestionPart>;
      const partId = rp.partId || `${rq.questionId}_p${pIdx + 1}`;
      if (seenPartIds.has(partId)) {
        errors.push(`Duplicate partId "${partId}" in manifest.`);
      }
      seenPartIds.add(partId);

      if (!rp.skillId || !VALID_SKILL_IDS.has(rp.skillId)) {
        errors.push(`Question ${rq.questionId} part ${partId} uses unknown skillId "${String(rp.skillId)}".`);
      }
      for (const secSkill of rp.secondarySkillIds ?? []) {
        if (!VALID_SKILL_IDS.has(secSkill)) {
          warnings.push(`Question ${rq.questionId} part ${partId} has unknown secondarySkillId "${secSkill}".`);
        }
      }

      const normOptions = (Array.isArray(rp.options) ? rp.options : []).map((opt) => ({
        key: String(opt.key).trim(),
        text: String(opt.text ?? ''),
        visual: normalizeVisual(opt.visual),
      }));
      if (normOptions.length > 8) {
        errors.push(`Question ${rq.questionId} part ${partId} exceeds maximum 8 options.`);
      }
      const optionKeySet = new Set(normOptions.map((o) => o.key));
      if (optionKeySet.size !== normOptions.length) {
        errors.push(`Question ${rq.questionId} part ${partId} has duplicate option keys.`);
      }

      const correctKey = String(rp.correctAnswerKey ?? '').trim();
      if (rq.formatType !== 'WRIT_TYPED_TASK') {
        if (!correctKey) {
          errors.push(`Question ${rq.questionId} part ${partId} missing correctAnswerKey.`);
        } else if (normOptions.length > 0 && !optionKeySet.has(correctKey)) {
          errors.push(
            `Question ${rq.questionId} part ${partId} correctAnswerKey "${correctKey}" does not match any option key.`
          );
        } else if (
          (rq.formatType === 'READ_GAPPED_TEXT' || rq.formatType === 'READ_MULTIPLE_MATCH') &&
          stim?.extracts &&
          !stim.extracts.some((ex) => ex.label === correctKey)
        ) {
          errors.push(
            `Question ${rq.questionId} part ${partId} correctAnswerKey "${correctKey}" does not match any extract label on stimulus "${stim.stimulusId}".`
          );
        }
      }

      normalizedParts.push({
        partId,
        partIndex: typeof rp.partIndex === 'number' ? rp.partIndex : pIdx,
        slotRef: rp.slotRef,
        promptText: String(rp.promptText || ''),
        skillId: String(rp.skillId || ''),
        secondarySkillIds: rp.secondarySkillIds,
        difficultyInitial:
          typeof rp.difficultyInitial === 'number'
            ? Math.min(5, Math.max(1, rp.difficultyInitial))
            : 3.0,
        difficultyCalibrated: rp.difficultyCalibrated,
        targetTimeSec:
          typeof rp.targetTimeSec === 'number' && rp.targetTimeSec > 0
            ? rp.targetTimeSec
            : defaultTargetSec(rq.section),
        cognitiveDemand: (rp.cognitiveDemand as CognitiveDemand) || 'apply_procedural',
        trapTags: rp.trapTags,
        options: normOptions,
        correctAnswerKey: correctKey,
        workedExplanation: String(rp.workedExplanation || ''),
        distractorRationales: rp.distractorRationales,
      });
    }

    const derivedSharedPool =
      rq.sharedPoolConfig ||
      ((rq.formatType === 'READ_GAPPED_TEXT' || rq.formatType === 'READ_MULTIPLE_MATCH') && stim?.extracts
        ? {
            reuseAllowed: rq.formatType === 'READ_MULTIPLE_MATCH',
            poolKeys: stim.extracts.map((ex) => ex.label),
          }
        : undefined);

    const normalizedQ: QuestionItem = {
      questionId: rq.questionId,
      questionFamilyId: rq.questionFamilyId || rq.questionId.replace(/_v\d+$/, ''),
      version: typeof rq.version === 'number' && rq.version >= 1 ? rq.version : 1,
      contentHash: rq.contentHash,
      section: rq.section,
      formatType: rq.formatType,
      poolType: rq.poolType || defaultPoolType,
      qcStatus: rq.qcStatus || defaultQcStatus,
      stimulusId: rq.stimulusId,
      transferGroupId: rq.transferGroupId,
      stemPrefix: rq.stemPrefix,
      visual: normalizeVisual(rq.visual),
      sharedPoolConfig: derivedSharedPool,
      parts: normalizedParts,
      writingSpec: rq.writingSpec,
      provenance: rq.provenance || {
        sourceType: 'ai_generated',
        sourceReference: batchLabel,
        verifierAgreed: true,
        auditorReviewed: false,
      },
    };

    const incomingHash =
      normalizedQ.contentHash ||
      computeCanonicalHash({
        parts: normalizedQ.parts,
        stemPrefix: normalizedQ.stemPrefix,
        visual: normalizedQ.visual,
        writingSpec: normalizedQ.writingSpec,
      });
    normalizedQ.contentHash = incomingHash;

    const existing = existingByFamily.get(normalizedQ.questionFamilyId);
    if (!existing) {
      newQuestions++;
    } else {
      const existingHash =
        existing.contentHash ||
        computeCanonicalHash({
          parts: existing.parts,
          stemPrefix: existing.stemPrefix,
          visual: existing.visual,
          writingSpec: existing.writingSpec,
        });
      if (existingHash === incomingHash && existing.version === normalizedQ.version) {
        unchangedQuestions++;
      } else {
        versionBumpedQuestions++;
      }
    }

    normalizedQuestions.push(normalizedQ);
  }

  const normalizedManifest: BankImportManifest = {
    manifestVersion: '1.0',
    batchLabel,
    defaultPoolType,
    defaultQcStatus,
    stimuli,
    questions: normalizedQuestions,
  };

  return {
    manifest: errors.length === 0 ? normalizedManifest : null,
    report: {
      valid: errors.length === 0,
      batchLabel,
      stimuliCount: stimuli.length,
      questionsCount: normalizedQuestions.length,
      newQuestions,
      unchangedQuestions,
      versionBumpedQuestions,
      errors,
      warnings,
    },
  };
}
