import crypto from 'node:crypto';
import { ThinkingLevel, Type } from '@google/genai';
import type {
  QuestionItem,
  StimulusGroup,
  WritingDeterministicMetrics,
  WritingEvaluationRecord,
} from '../shared/contracts.ts';
import {
  createGeminiClient,
  GEMINI_WRITING_MODEL,
  GeminiServiceError,
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

export function normalizeWritingEvaluationCriteria(
  rawCriteria: { criterionSkillId?: string; score?: number; evidenceQuote?: string; comment?: string }[] | undefined
): WritingEvaluationRecord['criteriaScores'] {
  const byId = new Map<string, { score: number; evidenceQuote?: string; comment: string }>();
  for (const row of rawCriteria || []) {
    if (!row || typeof row.criterionSkillId !== 'string') continue;
    byId.set(row.criterionSkillId.trim(), {
      score: Math.min(5, Math.max(1, Math.round(Number(row.score) || 3))),
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
        evidenceQuote: matched.evidenceQuote,
        comment: matched.comment || 'Assessed against selective writing rubric criterion.',
      };
    }
    return {
      criterionSkillId,
      score: 3,
      comment: 'Criterion not explicitly scored in response; default mid-band estimate applied.',
    };
  });
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
    'Grade fairly, encouragingly, and strictly against all 6 Selective Lab Writing rubric criteria.',
    'Each criterion score must be an integer from 1 to 5 (5 = top selective band).',
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

  const rawText = input.generateTextFn
    ? await input.generateTextFn(prompt)
    : await withGeminiRetry(async () => {
        const ai = createGeminiClient();
        const response = await ai.models.generateContent({
          model: GEMINI_WRITING_MODEL,
          contents: prompt,
          config: {
            systemInstruction,
            thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
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
                'overallBandEstimate',
                'criteriaScores',
                'topStrengths',
                'priorityFixes',
              ],
            },
          },
        });
        return (response.text ?? '').trim();
      });

  if (!rawText) {
    throw new GeminiServiceError(502, 'Gemini returned an empty response for writing evaluation.');
  }

  const parsed = JSON.parse(rawText) as {
    topicAdherencePass: boolean;
    overallBandEstimate: string;
    criteriaScores: { criterionSkillId: string; score: number; evidenceQuote?: string; comment: string }[];
    topStrengths: string[];
    priorityFixes: string[];
  };

  const validBands = new Set(['developing', 'solid', 'strong', 'top_band']);
  const band = validBands.has(parsed.overallBandEstimate)
    ? (parsed.overallBandEstimate as WritingEvaluationRecord['overallBandEstimate'])
    : 'solid';

  return {
    evaluationId: `eval_${crypto.randomUUID().slice(0, 12)}`,
    submissionId: input.submissionId,
    evaluatorType: 'ai',
    modelId: GEMINI_WRITING_MODEL,
    topicAdherencePass: Boolean(parsed.topicAdherencePass),
    overallBandEstimate: band,
    criteriaScores: normalizeWritingEvaluationCriteria(parsed.criteriaScores),
    topStrengths: (parsed.topStrengths || []).filter((s) => typeof s === 'string' && s.trim()).slice(0, 4),
    priorityFixes: (parsed.priorityFixes || []).filter((s) => typeof s === 'string' && s.trim()).slice(0, 4),
    createdAt: new Date().toISOString(),
  };
}
