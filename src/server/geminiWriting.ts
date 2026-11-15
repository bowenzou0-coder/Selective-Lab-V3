import crypto from 'node:crypto';
import { GoogleGenAI, Type } from '@google/genai';
import type {
  QuestionItem,
  StimulusGroup,
  WritingDeterministicMetrics,
  WritingEvaluationRecord,
} from '../shared/contracts.ts';

const WRITING_CRITERIA = [
  'WRIT.CRIT.TOPIC_PROMPT_ADHERENCE',
  'WRIT.CRIT.IDEAS_CREATIVITY',
  'WRIT.CRIT.PURPOSE_AUDIENCE_VOICE',
  'WRIT.CRIT.STRUCTURE_LAYOUT',
  'WRIT.CRIT.STYLE_VOCABULARY',
  'WRIT.CRIT.GRAMMAR_SPELLING_PUNCT',
] as const;

export async function evaluateWritingWithGemini(input: {
  submissionId: string;
  question: QuestionItem;
  stimulus?: StimulusGroup;
  planNotes: string;
  responseText: string;
  metrics: WritingDeterministicMetrics;
}): Promise<WritingEvaluationRecord> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error(
      'GEMINI_API_KEY is not configured. Configure GEMINI_API_KEY in Settings > Secrets to enable AI writing feedback.'
    );
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const spec = input.question.writingSpec;
  const modelId = 'gemini-4-hydrogen';

  const systemInstruction = [
    'You are an experienced Selective Lab Writing assessor evaluating a Year 5/6 student response.',
    'Grade fairly, encouragingly, and strictly against the 6 Selective Lab Writing rubric criteria.',
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

  const response = await ai.models.generateContent({
    model: modelId,
    contents: prompt,
    config: {
      systemInstruction,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          topicAdherencePass: {
            type: Type.BOOLEAN,
            description: 'True if the response addresses the prompt genre, audience, and mandatory opening line if specified.',
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

  const rawText = (response.text ?? '').trim();
  if (!rawText) {
    throw new Error('Gemini returned an empty response for writing evaluation.');
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
    modelId,
    topicAdherencePass: Boolean(parsed.topicAdherencePass),
    overallBandEstimate: band,
    criteriaScores: (parsed.criteriaScores || []).map((c) => ({
      criterionSkillId: c.criterionSkillId,
      score: Math.min(5, Math.max(1, Math.round(Number(c.score) || 3))),
      evidenceQuote: c.evidenceQuote || undefined,
      comment: c.comment || '',
    })),
    topStrengths: (parsed.topStrengths || []).slice(0, 4),
    priorityFixes: (parsed.priorityFixes || []).slice(0, 4),
    createdAt: new Date().toISOString(),
  };
}
