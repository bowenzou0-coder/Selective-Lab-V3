import crypto from 'node:crypto';
import { ThinkingLevel, Type } from '@google/genai';
import {
  getWritingCriterionMaxMarks,
  WRITING_BAND_DESCRIPTORS,
  WRITING_MAX_TOTAL_MARKS,
  type QuestionItem,
  type StimulusGroup,
  type WritingBandLetter,
  type WritingCriterionScore,
  type WritingDeterministicMetrics,
  type WritingEvaluationRecord,
  type WritingExemplarAnnotation,
  type WritingExemplarResponse,
  type WritingTextAnnotation,
} from '../shared/contracts.ts';
import {
  createGeminiClient,
  GeminiServiceError,
  getGeminiWritingFallbackModel,
  getGeminiWritingModel,
  normalizeGeminiError,
  withGeminiRetry,
} from './geminiClient.ts';

export const WRITING_CRITERIA = [
  'WRIT.CRIT.TOPIC_PROMPT_ADHERENCE',
  'WRIT.CRIT.IDEAS_CREATIVITY',
  'WRIT.CRIT.PURPOSE_AUDIENCE_VOICE',
  'WRIT.CRIT.STRUCTURE_LAYOUT',
  'WRIT.CRIT.STYLE_VOCABULARY',
  'WRIT.CRIT.GRAMMAR_SPELLING_PUNCT',
] as const;

export interface DeterministicWritingFaults {
  hasBracketPlaceholder: boolean;
  hasMissingSignature: boolean;
  hasSingleParagraphWall: boolean;
  hasBulletListInProse: boolean;
  isVeryShort: boolean;
  isUnderDeveloped: boolean;
  isMissingMandatoryStarter: boolean;
}

export interface WritingAuditContext {
  promptEngagement?: 'off_topic' | 'surface_formulaic' | 'solid' | 'strong';
  hasUnfilledPlaceholders?: boolean;
  hasAiSlopOrCorporateCliches?: boolean;
  formAndParagraphControl?: 'weak' | 'partial' | 'controlled';
  substanceAndDepth?: 'thin' | 'developing' | 'sound' | 'deep';
  topBandChecks?: {
    holdsSpecificPromptDetails?: boolean;
    authenticVoiceNotSlop?: boolean;
    controlledStructureAndPacing?: boolean;
    preciseCraftAndMechanics?: boolean;
  };
  pullingFaultsCount?: number;
  deterministicFaults?: DeterministicWritingFaults;
}

export function detectDeterministicWritingFaults(
  responseText: string,
  metrics: WritingDeterministicMetrics,
  writingSpec?: QuestionItem['writingSpec']
): DeterministicWritingFaults {
  const trimmed = responseText.trim();
  return {
    hasBracketPlaceholder: /\[[A-Za-z][A-Za-z0-9\s/_-]{1,30}\]/.test(responseText),
    hasMissingSignature:
      /(?:yours\s+(?:sincerely|faithfully)|kind\s+regards|best\s+regards|warm\s+regards|sincerely),?\s*$/i.test(
        trimmed
      ),
    hasSingleParagraphWall: metrics.wordCount >= 120 && metrics.paragraphCount <= 1,
    hasBulletListInProse:
      writingSpec?.genre !== 'advice_sheet' &&
      (responseText.match(/^\s*(?:[•*-]|\d+\.)\s+/gm) || []).length >= 2,
    isVeryShort: metrics.wordCount < 80,
    isUnderDeveloped: metrics.wordCount < 150,
    isMissingMandatoryStarter:
      Boolean(writingSpec?.mandatoryOpeningLine?.trim()) && !metrics.matchedMandatoryStarter,
  };
}

export function scoreToCriterionBand(score: number, maxMarks = 3): WritingBandLetter {
  const s = Math.round(score);
  if (maxMarks <= 0 || s <= 0) return 'E';
  const ratio = s / maxMarks;
  if (ratio >= 0.9) return 'A';
  if (ratio >= 0.65) return 'B';
  if (ratio >= 0.45) return 'C';
  if (ratio >= 0.25) return 'D';
  return 'E';
}

export function computeWritingBandSummary(
  criteriaScores: WritingCriterionScore[],
  topicAdherencePass: boolean,
  auditContext?: WritingAuditContext
): {
  totalMarks: number;
  maxTotalMarks: number;
  overallBand: WritingBandLetter;
  overallBandDescriptor: string;
  bandCappedByTopicAdherence: boolean;
  overallBandEstimate: WritingEvaluationRecord['overallBandEstimate'];
  adjustedCriteriaScores: WritingCriterionScore[];
} {
  const maxTotalMarks = WRITING_MAX_TOTAL_MARKS;
  const adjustedCriteriaScores: WritingCriterionScore[] = criteriaScores.map((c) => {
    const maxMarks = getWritingCriterionMaxMarks(c.criterionSkillId);
    const clamped = Math.max(0, Math.min(maxMarks, Math.round(c.score)));
    return {
      ...c,
      score: clamped,
      maxMarks,
      band: scoreToCriterionBand(clamped, maxMarks),
    };
  });

  const preCapSum = adjustedCriteriaScores.reduce((sum, c) => sum + c.score, 0);
  const det = auditContext?.deterministicFaults;

  const capCriterion = (skillId: string, cap: number) => {
    const item = adjustedCriteriaScores.find((c) => c.criterionSkillId === skillId);
    if (item && item.score > cap) {
      item.score = cap;
      item.band = scoreToCriterionBand(cap, item.maxMarks ?? getWritingCriterionMaxMarks(skillId));
    }
  };

  if (det?.hasSingleParagraphWall) {
    capCriterion('WRIT.CRIT.STRUCTURE_LAYOUT', 1);
  }
  if (det?.hasBracketPlaceholder || det?.hasMissingSignature) {
    capCriterion('WRIT.CRIT.STRUCTURE_LAYOUT', 1);
    capCriterion('WRIT.CRIT.PURPOSE_AUDIENCE_VOICE', 1);
  }
  if (!topicAdherencePass || det?.isMissingMandatoryStarter) {
    capCriterion('WRIT.CRIT.TOPIC_PROMPT_ADHERENCE', 1);
  }

  const rawSum = adjustedCriteriaScores.reduce((sum, c) => sum + c.score, 0);

  let ceiling = maxTotalMarks;
  const applyCeiling = (cap: number) => {
    ceiling = Math.min(ceiling, cap);
  };

  if (!topicAdherencePass) {
    applyCeiling(12);
  }

  const hasPlaceholder = Boolean(
    auditContext?.hasUnfilledPlaceholders || det?.hasBracketPlaceholder || det?.hasMissingSignature
  );
  const hasSlop = Boolean(auditContext?.hasAiSlopOrCorporateCliches || det?.hasBulletListInProse);

  if (hasPlaceholder && hasSlop) {
    applyCeiling(11);
  } else if (hasPlaceholder || hasSlop) {
    applyCeiling(13);
  }

  if (det?.hasSingleParagraphWall) {
    applyCeiling(15);
  }
  if (det?.isVeryShort) {
    applyCeiling(7);
  } else if (det?.isUnderDeveloped) {
    applyCeiling(12);
  }

  if (auditContext?.promptEngagement === 'off_topic') {
    applyCeiling(10);
  } else if (auditContext?.promptEngagement === 'surface_formulaic') {
    applyCeiling(14);
  }

  if (auditContext?.substanceAndDepth === 'thin') {
    applyCeiling(11);
  } else if (auditContext?.substanceAndDepth === 'developing') {
    applyCeiling(14);
  }

  if (auditContext?.topBandChecks) {
    const checks = auditContext.topBandChecks;
    const ticks = [
      Boolean(checks.holdsSpecificPromptDetails),
      Boolean(checks.authenticVoiceNotSlop),
      Boolean(checks.controlledStructureAndPacing),
      Boolean(checks.preciseCraftAndMechanics),
    ].filter(Boolean).length;

    const hasPull =
      hasPlaceholder ||
      hasSlop ||
      Boolean(det?.hasSingleParagraphWall) ||
      Boolean(det?.isMissingMandatoryStarter) ||
      (auditContext.pullingFaultsCount ?? 0) > 0 ||
      (auditContext.promptEngagement !== undefined && auditContext.promptEngagement !== 'strong') ||
      (auditContext.substanceAndDepth !== undefined && auditContext.substanceAndDepth !== 'deep');

    if (ticks === 4 && !hasPull) {
      applyCeiling(20);
    } else if ((ticks === 4 && hasPull) || ticks === 3) {
      applyCeiling(18);
    } else if (ticks === 2) {
      applyCeiling(16);
    } else {
      applyCeiling(13);
    }
  }

  const totalMarks = Math.max(0, Math.min(maxTotalMarks, rawSum, ceiling));

  let currentSum = adjustedCriteriaScores.reduce((sum, c) => sum + c.score, 0);
  while (currentSum > totalMarks) {
    let pickIdx = -1;
    let bestRatio = -1;
    let bestScore = -1;
    for (let i = 0; i < adjustedCriteriaScores.length; i++) {
      const item = adjustedCriteriaScores[i];
      if (item.score <= 0) continue;
      const maxMarks = item.maxMarks ?? getWritingCriterionMaxMarks(item.criterionSkillId);
      const ratio = item.score / maxMarks;
      if (
        ratio > bestRatio ||
        (ratio === bestRatio && (item.score > bestScore || (item.score === bestScore && i > pickIdx)))
      ) {
        pickIdx = i;
        bestRatio = ratio;
        bestScore = item.score;
      }
    }
    if (pickIdx === -1) break;
    const chosen = adjustedCriteriaScores[pickIdx];
    const maxMarks = chosen.maxMarks ?? getWritingCriterionMaxMarks(chosen.criterionSkillId);
    chosen.score -= 1;
    chosen.band = scoreToCriterionBand(chosen.score, maxMarks);
    currentSum -= 1;
  }

  let rawBand: WritingBandLetter = 'E';
  if (totalMarks >= WRITING_BAND_DESCRIPTORS.A.minMarks) rawBand = 'A';
  else if (totalMarks >= WRITING_BAND_DESCRIPTORS.B.minMarks) rawBand = 'B';
  else if (totalMarks >= WRITING_BAND_DESCRIPTORS.C.minMarks) rawBand = 'C';
  else if (totalMarks >= WRITING_BAND_DESCRIPTORS.D.minMarks) rawBand = 'D';

  const bandOrder: Record<WritingBandLetter, number> = { A: 5, B: 4, C: 3, D: 2, E: 1 };
  const bandCappedByTopicAdherence =
    !topicAdherencePass && preCapSum >= WRITING_BAND_DESCRIPTORS.B.minMarks;
  const overallBand: WritingBandLetter =
    !topicAdherencePass && bandOrder[rawBand] > bandOrder.C ? 'C' : rawBand;

  const overallBandEstimate: WritingEvaluationRecord['overallBandEstimate'] =
    overallBand === 'A'
      ? 'top_band'
      : overallBand === 'B'
        ? 'strong'
        : overallBand === 'C'
          ? 'solid'
          : 'developing';

  return {
    totalMarks,
    maxTotalMarks,
    overallBand,
    overallBandDescriptor: WRITING_BAND_DESCRIPTORS[overallBand].label,
    bandCappedByTopicAdherence,
    overallBandEstimate,
    adjustedCriteriaScores,
  };
}

export function normalizeWritingEvaluationCriteria(
  rawCriteria: { criterionSkillId?: string; score?: number; evidenceQuote?: string; comment?: string }[] | undefined
): WritingCriterionScore[] {
  const byId = new Map<string, { score: number; evidenceQuote?: string; comment: string }>();
  for (const row of rawCriteria || []) {
    if (!row || typeof row.criterionSkillId !== 'string') continue;
    const id = row.criterionSkillId.trim();
    const maxMarks = getWritingCriterionMaxMarks(id);
    const fallbackDefault = Math.ceil(maxMarks / 2);
    const numeric = Number(row.score);
    const rounded = Number.isFinite(numeric) ? Math.round(numeric) : fallbackDefault;
    byId.set(id, {
      score: Math.min(maxMarks, Math.max(0, rounded)),
      evidenceQuote:
        typeof row.evidenceQuote === 'string' && row.evidenceQuote.trim()
          ? row.evidenceQuote.trim()
          : undefined,
      comment: typeof row.comment === 'string' ? row.comment.trim() : '',
    });
  }

  return WRITING_CRITERIA.map((criterionSkillId) => {
    const maxMarks = getWritingCriterionMaxMarks(criterionSkillId);
    const matched = byId.get(criterionSkillId);
    if (matched) {
      return {
        criterionSkillId,
        score: matched.score,
        maxMarks,
        band: scoreToCriterionBand(matched.score, maxMarks),
        evidenceQuote: matched.evidenceQuote,
        comment: matched.comment || 'Assessed against selective writing rubric criterion.',
      };
    }
    const defaultScore = Math.ceil(maxMarks / 2);
    return {
      criterionSkillId,
      score: defaultScore,
      maxMarks,
      band: scoreToCriterionBand(defaultScore, maxMarks),
      comment: 'Criterion not explicitly scored in response; default mid-band estimate applied.',
    };
  });
}

function cleanVerbatimQuote(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .trim()
    .replace(/^[“"'‘]+|[”"'’]+$/g, '')
    .trim();
}

export function normalizeWritingAnnotations(
  rawAnnotations:
    | {
        kind?: string;
        quote?: string;
        tag?: string;
        comment?: string;
        rewrite?: string;
        criterionSkillId?: string;
      }[]
    | undefined
): WritingTextAnnotation[] | undefined {
  if (!Array.isArray(rawAnnotations) || rawAnnotations.length === 0) return undefined;
  const out: WritingTextAnnotation[] = [];
  for (const row of rawAnnotations) {
    if (!row || typeof row !== 'object') continue;
    const quote = cleanVerbatimQuote(row.quote);
    const comment = typeof row.comment === 'string' ? row.comment.trim() : '';
    const tag = typeof row.tag === 'string' ? row.tag.trim() : '';
    if (!quote || !comment) continue;
    const rawKind = typeof row.kind === 'string' ? row.kind.trim().toLowerCase() : '';
    const kind: WritingTextAnnotation['kind'] =
      rawKind === 'strength' || rawKind === 'issue' || rawKind === 'suggestion'
        ? rawKind
        : 'suggestion';
    const rewrite =
      typeof row.rewrite === 'string' && row.rewrite.trim() ? row.rewrite.trim() : undefined;
    const criterionSkillId =
      typeof row.criterionSkillId === 'string' && row.criterionSkillId.trim()
        ? row.criterionSkillId.trim()
        : undefined;
    out.push({
      id: `ann_${out.length + 1}`,
      kind,
      quote,
      tag: tag || (kind === 'strength' ? 'Strong choice' : kind === 'issue' ? 'Needs fix' : 'Upgrade idea'),
      comment,
      rewrite,
      criterionSkillId,
    });
    if (out.length >= 12) break;
  }
  return out.length > 0 ? out : undefined;
}

export function normalizeWritingExemplar(
  rawExemplar:
    | {
        title?: string;
        text?: string;
        keyTakeaway?: string;
        annotations?: { quote?: string; tag?: string; explanation?: string }[];
      }
    | undefined
): WritingExemplarResponse | undefined {
  if (!rawExemplar || typeof rawExemplar !== 'object') return undefined;
  const text = typeof rawExemplar.text === 'string' ? rawExemplar.text.trim() : '';
  if (!text) return undefined;
  const title =
    typeof rawExemplar.title === 'string' && rawExemplar.title.trim()
      ? rawExemplar.title.trim()
      : undefined;
  const keyTakeaway =
    typeof rawExemplar.keyTakeaway === 'string' && rawExemplar.keyTakeaway.trim()
      ? rawExemplar.keyTakeaway.trim()
      : undefined;
  const annotations: WritingExemplarAnnotation[] = [];
  if (Array.isArray(rawExemplar.annotations)) {
    for (const row of rawExemplar.annotations) {
      if (!row || typeof row !== 'object') continue;
      const quote = cleanVerbatimQuote(row.quote);
      const tag = typeof row.tag === 'string' ? row.tag.trim() : '';
      const explanation = typeof row.explanation === 'string' ? row.explanation.trim() : '';
      if (!quote || !explanation) continue;
      annotations.push({
        id: `ex_${annotations.length + 1}`,
        quote,
        tag: tag || 'Band A craft move',
        explanation,
      });
      if (annotations.length >= 10) break;
    }
  }
  return {
    title,
    text,
    keyTakeaway,
    annotations,
  };
}

async function generateWritingJsonWithModel(
  modelId: string,
  systemInstruction: string,
  prompt: string
): Promise<string> {
  return withGeminiRetry(
    async () => {
      const ai = createGeminiClient();
      const response = await ai.models.generateContent({
        model: modelId,
        contents: prompt,
        config: {
          systemInstruction,
          thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
          abortSignal: AbortSignal.timeout(45_000),
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              topicAdherencePass: {
                type: Type.BOOLEAN,
                description:
                  'True if the response addresses the prompt genre, audience, and mandatory opening line if specified.',
              },
              audit: {
                type: Type.OBJECT,
                description:
                  'Complete this honest fault and craft audit BEFORE assigning any criterion scores.',
                properties: {
                  promptEngagement: {
                    type: Type.STRING,
                    description: 'One of: off_topic, surface_formulaic, solid, strong',
                  },
                  hasUnfilledPlaceholders: {
                    type: Type.BOOLEAN,
                    description:
                      'True if unfilled template brackets like [Surname], [Name], [Date] or an unsigned closing like "Yours sincerely," appear.',
                  },
                  hasAiSlopOrCorporateCliches: {
                    type: Type.BOOLEAN,
                    description:
                      'True if the draft reads like corporate/AI boilerplate, relies on hollow buzzwords, or puts bullet points inside prose/letters.',
                  },
                  formAndParagraphControl: {
                    type: Type.STRING,
                    description: 'One of: weak, partial, controlled',
                  },
                  substanceAndDepth: {
                    type: Type.STRING,
                    description: 'One of: thin, developing, sound, deep',
                  },
                  topBandChecks: {
                    type: Type.OBJECT,
                    properties: {
                      holdsSpecificPromptDetails: { type: Type.BOOLEAN },
                      authenticVoiceNotSlop: { type: Type.BOOLEAN },
                      controlledStructureAndPacing: { type: Type.BOOLEAN },
                      preciseCraftAndMechanics: { type: Type.BOOLEAN },
                    },
                    required: [
                      'holdsSpecificPromptDetails',
                      'authenticVoiceNotSlop',
                      'controlledStructureAndPacing',
                      'preciseCraftAndMechanics',
                    ],
                  },
                  pullingFaults: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description: 'Concrete faults holding the draft back from a higher band.',
                  },
                },
                required: [
                  'promptEngagement',
                  'hasUnfilledPlaceholders',
                  'hasAiSlopOrCorporateCliches',
                  'formAndParagraphControl',
                  'substanceAndDepth',
                  'topBandChecks',
                  'pullingFaults',
                ],
              },
              overallVerdict: {
                type: Type.STRING,
                description:
                  'One blunt, specific teacher sentence (max 28 words) explaining clearly what set the /20 mark.',
              },
              overallBandEstimate: {
                type: Type.STRING,
                description: 'One of: developing, solid, strong, top_band',
              },
              criteriaScores: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    criterionSkillId: { type: Type.STRING },
                    score: { type: Type.INTEGER },
                    evidenceQuote: { type: Type.STRING },
                    comment: { type: Type.STRING },
                  },
                  required: ['criterionSkillId', 'score', 'comment'],
                },
              },
              topStrengths: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              priorityFixes: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              annotations: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    kind: { type: Type.STRING },
                    quote: { type: Type.STRING },
                    tag: { type: Type.STRING },
                    comment: { type: Type.STRING },
                    rewrite: { type: Type.STRING },
                    criterionSkillId: { type: Type.STRING },
                  },
                  required: ['kind', 'quote', 'tag', 'comment'],
                },
              },
              exemplar: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  text: { type: Type.STRING },
                  keyTakeaway: { type: Type.STRING },
                  annotations: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        quote: { type: Type.STRING },
                        tag: { type: Type.STRING },
                        explanation: { type: Type.STRING },
                      },
                      required: ['quote', 'tag', 'explanation'],
                    },
                  },
                },
                required: ['text', 'annotations'],
              },
            },
            required: [
              'topicAdherencePass',
              'audit',
              'overallVerdict',
              'criteriaScores',
              'topStrengths',
              'priorityFixes',
            ],
          },
        },
      });
      return (response.text ?? '').trim();
    },
    2,
    300,
    modelId
  );
}

export async function evaluateWritingWithGemini(input: {
  submissionId: string;
  question: QuestionItem;
  stimulus?: StimulusGroup;
  planNotes: string;
  responseText: string;
  metrics: WritingDeterministicMetrics;
  generateTextFn?: (promptJson: string) => Promise<string>;
}): Promise<WritingEvaluationRecord> {
  const spec = input.question.writingSpec;
  const deterministicFaults = detectDeterministicWritingFaults(input.responseText, input.metrics, spec);

  const systemInstruction = [
    'You are a strict, unfooled NSW Selective High School Year 5/6 & senior HSC-calibrated English marker.',
    `Grade out of ${WRITING_MAX_TOTAL_MARKS} marks across all 6 rubric criteria with exact max marks:`,
    'WRIT.CRIT.TOPIC_PROMPT_ADHERENCE (0..4), WRIT.CRIT.IDEAS_CREATIVITY (0..4),',
    'WRIT.CRIT.PURPOSE_AUDIENCE_VOICE (0..3), WRIT.CRIT.STRUCTURE_LAYOUT (0..3),',
    'WRIT.CRIT.STYLE_VOCABULARY (0..3), WRIT.CRIT.GRAMMAR_SPELLING_PUNCT (0..3).',
    'Bands: A = 17–20, B = 13–16, C = 9–12, D = 5–8, E = 0–4.',
    'Complete the `audit` object honestly BEFORE scoring any criterion.',
    'Anti-slop marking rules:',
    '- NEVER reward corporate buzzwords, AI-sounding template polish, or thesaurus padding over genuine Year 6 human voice.',
    '- Heavily penalise unfilled placeholders (e.g. "Dear Mayor [Surname]", blank sign-offs like "Yours sincerely,"), bulleted corporate memo lists inside letters or narratives, single-paragraph walls, surface prompt-dropping, tell-not-show emotion labels, and rushed endings.',
    '- A fluent but hollow AI/template draft belongs in Band C (9–12/20), NEVER Band A or B.',
    '- Reserve 19–20/20 ONLY for rare scripts that pass all 4 topBandChecks with zero pullingFaults and genuine craft.',
    '`overallVerdict`: write ONE blunt, concrete teacher sentence (max 28 words) naming what set the /20 mark — zero sycophantic filler praise.',
    'Keep each criterion comment to ONE crisp, text-grounded sentence.',
    '`annotations`: include 5–7 surgical items anchored verbatim to studentResponse (10–130 chars, NO ellipses "...", NO paraphrasing), 2–4 word `tag`, 1 crisp sentence `comment`, and concrete `rewrite` for every issue/suggestion (prioritise real fixes).',
    '`exemplar`: write a complete Band A (19–20/20) Year 6 model response (~260–350 words, clean blank-line paragraphs, full prompt/genre/audience/mandatory-starter compliance) written 100% FROM SCRATCH.',
    'NEVER copy, paraphrase, or swap words on the student draft. Ban corporate buzzwords and cliché AI names/phrases ("Elena Vance", "Maya", "Aiden", "Lucas", "verdant corridor", "tapestry", "testament", "bruised sky", "symphony of").',
    'Include `keyTakeaway` (1–2 sentences linking exemplar to the student’s #1 fix) and 4–6 verbatim `exemplar.annotations` (no ellipses).',
    'Do not penalise Australian/British spelling (e.g., colour, realise, travelled).',
  ].join(' ');

  const prompt = JSON.stringify({
    taskTitle: input.stimulus?.title || 'Writing Task',
    taskPrompt: input.stimulus?.mainTextMarkdown || input.question.parts[0]?.promptText || '',
    writingSpec: spec,
    deterministicMetrics: input.metrics,
    deterministicAuditFlags: deterministicFaults,
    studentPlanNotes: input.planNotes,
    studentResponse: input.responseText,
    requiredCriteriaSkillIds: WRITING_CRITERIA,
  });

  const primaryModel = getGeminiWritingModel();
  let usedModel = primaryModel;
  let rawText: string;

  if (input.generateTextFn) {
    rawText = await input.generateTextFn(prompt);
  } else {
    try {
      rawText = await generateWritingJsonWithModel(primaryModel, systemInstruction, prompt);
    } catch (err) {
      const normalized = normalizeGeminiError(err, primaryModel);
      const fallbackModel = getGeminiWritingFallbackModel();
      const shouldFallback =
        Boolean(fallbackModel) &&
        fallbackModel !== primaryModel &&
        [404, 429, 502, 503, 504].includes(normalized.statusCode);
      if (!shouldFallback || !fallbackModel) {
        throw normalized;
      }
      usedModel = fallbackModel;
      rawText = await generateWritingJsonWithModel(fallbackModel, systemInstruction, prompt);
    }
  }

  if (!rawText) {
    throw new GeminiServiceError(502, 'Gemini returned an empty response for writing evaluation.');
  }

  const parsed = JSON.parse(rawText) as {
    topicAdherencePass: boolean;
    audit?: {
      promptEngagement?: string;
      hasUnfilledPlaceholders?: boolean;
      hasAiSlopOrCorporateCliches?: boolean;
      formAndParagraphControl?: string;
      substanceAndDepth?: string;
      topBandChecks?: {
        holdsSpecificPromptDetails?: boolean;
        authenticVoiceNotSlop?: boolean;
        controlledStructureAndPacing?: boolean;
        preciseCraftAndMechanics?: boolean;
      };
      pullingFaults?: string[];
    };
    overallVerdict?: string;
    overallBandEstimate?: string;
    criteriaScores: { criterionSkillId: string; score: number; evidenceQuote?: string; comment: string }[];
    topStrengths: string[];
    priorityFixes: string[];
    annotations?: {
      kind?: string;
      quote?: string;
      tag?: string;
      comment?: string;
      rewrite?: string;
      criterionSkillId?: string;
    }[];
    exemplar?: {
      title?: string;
      text?: string;
      keyTakeaway?: string;
      annotations?: { quote?: string; tag?: string; explanation?: string }[];
    };
  };

  const topicAdherencePass = Boolean(parsed.topicAdherencePass);
  const rawCriteriaScores = normalizeWritingEvaluationCriteria(parsed.criteriaScores);
  const audit = parsed.audit;
  const auditContext: WritingAuditContext = {
    ...(audit
      ? {
          promptEngagement:
            audit.promptEngagement === 'off_topic' ||
            audit.promptEngagement === 'surface_formulaic' ||
            audit.promptEngagement === 'solid' ||
            audit.promptEngagement === 'strong'
              ? audit.promptEngagement
              : undefined,
          hasUnfilledPlaceholders: Boolean(audit.hasUnfilledPlaceholders),
          hasAiSlopOrCorporateCliches: Boolean(audit.hasAiSlopOrCorporateCliches),
          formAndParagraphControl:
            audit.formAndParagraphControl === 'weak' ||
            audit.formAndParagraphControl === 'partial' ||
            audit.formAndParagraphControl === 'controlled'
              ? audit.formAndParagraphControl
              : undefined,
          substanceAndDepth:
            audit.substanceAndDepth === 'thin' ||
            audit.substanceAndDepth === 'developing' ||
            audit.substanceAndDepth === 'sound' ||
            audit.substanceAndDepth === 'deep'
              ? audit.substanceAndDepth
              : undefined,
          topBandChecks: audit.topBandChecks
            ? {
                holdsSpecificPromptDetails: Boolean(audit.topBandChecks.holdsSpecificPromptDetails),
                authenticVoiceNotSlop: Boolean(audit.topBandChecks.authenticVoiceNotSlop),
                controlledStructureAndPacing: Boolean(audit.topBandChecks.controlledStructureAndPacing),
                preciseCraftAndMechanics: Boolean(audit.topBandChecks.preciseCraftAndMechanics),
              }
            : undefined,
          pullingFaultsCount: Array.isArray(audit.pullingFaults)
            ? audit.pullingFaults.filter((f) => typeof f === 'string' && f.trim()).length
            : 0,
        }
      : {}),
    deterministicFaults,
  };

  const summary = computeWritingBandSummary(rawCriteriaScores, topicAdherencePass, auditContext);
  const annotations = normalizeWritingAnnotations(parsed.annotations);
  const exemplar = normalizeWritingExemplar(parsed.exemplar);
  const overallVerdict =
    typeof parsed.overallVerdict === 'string' && parsed.overallVerdict.trim()
      ? parsed.overallVerdict.trim()
      : undefined;

  return {
    evaluationId: `eval_${crypto.randomUUID().slice(0, 12)}`,
    submissionId: input.submissionId,
    evaluatorType: 'ai',
    modelId: usedModel,
    topicAdherencePass,
    overallBandEstimate: summary.overallBandEstimate,
    overallBand: summary.overallBand,
    overallBandDescriptor: summary.overallBandDescriptor,
    ...(overallVerdict ? { overallVerdict } : {}),
    totalMarks: summary.totalMarks,
    maxTotalMarks: summary.maxTotalMarks,
    bandCappedByTopicAdherence: summary.bandCappedByTopicAdherence,
    criteriaScores: summary.adjustedCriteriaScores,
    topStrengths: (parsed.topStrengths || []).filter((s) => typeof s === 'string' && s.trim()).slice(0, 4),
    priorityFixes: (parsed.priorityFixes || []).filter((s) => typeof s === 'string' && s.trim()).slice(0, 4),
    ...(annotations ? { annotations } : {}),
    ...(exemplar ? { exemplar } : {}),
    createdAt: new Date().toISOString(),
  };
}
