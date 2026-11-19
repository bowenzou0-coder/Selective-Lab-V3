import crypto from 'node:crypto';
import { ThinkingLevel, Type } from '@google/genai';
import {
  WRITING_BAND_DESCRIPTORS,
  WRITING_CRITERION_MAX_MARKS,
  WRITING_MAX_TOTAL_MARKS,
  type QuestionItem,
  type StimulusGroup,
  type WritingBandLetter,
  type WritingCriterionScore,
  type WritingDeterministicMetrics,
  type WritingEvaluationRecord,
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

export function scoreToCriterionBand(score: number): WritingBandLetter {
  const s = Math.round(score);
  if (s >= 5) return 'A';
  if (s === 4) return 'B';
  if (s === 3) return 'C';
  if (s === 2) return 'D';
  return 'E';
}

export function computeWritingBandSummary(
  criteriaScores: WritingCriterionScore[],
  topicAdherencePass: boolean
): {
  totalMarks: number;
  maxTotalMarks: number;
  overallBand: WritingBandLetter;
  overallBandDescriptor: string;
  bandCappedByTopicAdherence: boolean;
  overallBandEstimate: WritingEvaluationRecord['overallBandEstimate'];
} {
  const maxTotalMarks = WRITING_CRITERIA.length * WRITING_CRITERION_MAX_MARKS;
  const rawSum = criteriaScores.reduce((sum, c) => sum + Math.max(0, Math.min(WRITING_CRITERION_MAX_MARKS, Math.round(c.score))), 0);
  const totalMarks = Math.max(0, Math.min(maxTotalMarks, rawSum));

  let rawBand: WritingBandLetter = 'E';
  if (totalMarks >= WRITING_BAND_DESCRIPTORS.A.minMarks) rawBand = 'A';
  else if (totalMarks >= WRITING_BAND_DESCRIPTORS.B.minMarks) rawBand = 'B';
  else if (totalMarks >= WRITING_BAND_DESCRIPTORS.C.minMarks) rawBand = 'C';
  else if (totalMarks >= WRITING_BAND_DESCRIPTORS.D.minMarks) rawBand = 'D';

  const bandCappedByTopicAdherence = !topicAdherencePass && (rawBand === 'A' || rawBand === 'B');
  const overallBand: WritingBandLetter = bandCappedByTopicAdherence ? 'C' : rawBand;

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
  };
}

export function normalizeWritingEvaluationCriteria(
  rawCriteria: { criterionSkillId?: string; score?: number; evidenceQuote?: string; comment?: string }[] | undefined
): WritingCriterionScore[] {
  const byId = new Map<string, { score: number; evidenceQuote?: string; comment: string }>();
  for (const row of rawCriteria || []) {
    if (!row || typeof row.criterionSkillId !== 'string') continue;
    const numeric = Number(row.score);
    const rounded = Number.isFinite(numeric) ? Math.round(numeric) : 3;
    byId.set(row.criterionSkillId.trim(), {
      score: Math.min(WRITING_CRITERION_MAX_MARKS, Math.max(0, rounded)),
      evidenceQuote:
        typeof row.evidenceQuote === 'string' && row.evidenceQuote.trim()
          ? row.evidenceQuote.trim()
          : undefined,
      comment: typeof row.comment === 'string' ? row.comment.trim() : '',
    });
  }

  return WRITING_CRITERIA.map((criterionSkillId) => {
    const matched = byId.get(criterionSkillId);
    if (matched) {
      return {
        criterionSkillId,
        score: matched.score,
        maxMarks: WRITING_CRITERION_MAX_MARKS,
        band: scoreToCriterionBand(matched.score),
        evidenceQuote: matched.evidenceQuote,
        comment: matched.comment || 'Assessed against selective writing rubric criterion.',
      };
    }
    return {
      criterionSkillId,
      score: 3,
      maxMarks: WRITING_CRITERION_MAX_MARKS,
      band: scoreToCriterionBand(3),
      comment: 'Criterion not explicitly scored in response; default mid-band estimate applied.',
    };
  });
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
          ...(modelId.includes('flash-lite')
            ? {}
            : { thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH } }),
          abortSignal: AbortSignal.timeout(25_000),
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              topicAdherencePass: {
                type: Type.BOOLEAN,
                description:
                  'True if the response addresses the prompt genre, audience, and mandatory opening line if specified.',
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
            },
            required: [
              'topicAdherencePass',
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
  const systemInstruction = [
    'You are an experienced Selective Lab Writing assessor evaluating a Year 5/6 student response.',
    `Grade fairly, encouragingly, and strictly against all 6 Selective Lab Writing rubric criteria (total ${WRITING_MAX_TOTAL_MARKS} marks = 6 criteria x ${WRITING_CRITERION_MAX_MARKS} marks each).`,
    'Score each criterion as an integer from 0 to 5 aligned with Band A–E:',
    '5 = Band A (Extensive / Top Selective Band), 4 = Band B (Thorough / Strong), 3 = Band C (Sound / Solid), 2 = Band D (Basic / Developing), 0–1 = Band E (Elementary / Emerging or blank).',
    'Overall band and total marks are computed deterministically server-side from your 6 criterion scores.',
    'Cite exact short quotes from the student response in evidenceQuote where helpful.',
    'Do not penalise Australian/British spelling (e.g., colour, realise, travelled).',
  ].join(' ');

  const prompt = JSON.stringify({
    taskTitle: input.stimulus?.title || 'Writing Task',
    taskPrompt: input.stimulus?.mainTextMarkdown || input.question.parts[0]?.promptText || '',
    writingSpec: spec,
    deterministicMetrics: input.metrics,
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
    overallBandEstimate?: string;
    criteriaScores: { criterionSkillId: string; score: number; evidenceQuote?: string; comment: string }[];
    topStrengths: string[];
    priorityFixes: string[];
  };

  const topicAdherencePass = Boolean(parsed.topicAdherencePass);
  const criteriaScores = normalizeWritingEvaluationCriteria(parsed.criteriaScores);
  const summary = computeWritingBandSummary(criteriaScores, topicAdherencePass);

  return {
    evaluationId: `eval_${crypto.randomUUID().slice(0, 12)}`,
    submissionId: input.submissionId,
    evaluatorType: 'ai',
    modelId: usedModel,
    topicAdherencePass,
    overallBandEstimate: summary.overallBandEstimate,
    overallBand: summary.overallBand,
    overallBandDescriptor: summary.overallBandDescriptor,
    totalMarks: summary.totalMarks,
    maxTotalMarks: summary.maxTotalMarks,
    bandCappedByTopicAdherence: summary.bandCappedByTopicAdherence,
    criteriaScores,
    topStrengths: (parsed.topStrengths || []).filter((s) => typeof s === 'string' && s.trim()).slice(0, 4),
    priorityFixes: (parsed.priorityFixes || []).filter((s) => typeof s === 'string' && s.trim()).slice(0, 4),
    createdAt: new Date().toISOString(),
  };
}
