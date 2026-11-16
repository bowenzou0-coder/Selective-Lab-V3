import { GoogleGenAI } from '@google/genai';

/**
 * Gemini Decisions 1 ('gemini-4-hydrogen'): active Flash/Hydrogen model powering
 * question-selection algorithms, daily study focus prioritization, and writing rubric marking.
 */
export const GEMINI_DECISION_MODEL = 'gemini-4-hydrogen';
export const GEMINI_WRITING_MODEL = 'gemini-4-hydrogen';

export function getGeminiApiKey(): string | null {
  const key = (process.env.GEMINI_API_KEY || '').trim();
  if (!key || key === 'MY_GEMINI_API_KEY') return null;
  return key;
}

export function isGeminiConfigured(): boolean {
  return getGeminiApiKey() !== null;
}

export function createGeminiClient(): GoogleGenAI {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new GeminiServiceError(
      503,
      'GEMINI_API_KEY is not configured. Add GEMINI_API_KEY in Settings > Secrets to enable Gemini features.'
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export class GeminiServiceError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'GeminiServiceError';
    this.statusCode = statusCode;
  }
}

export function normalizeGeminiError(err: unknown): GeminiServiceError {
  if (err instanceof GeminiServiceError) return err;
  const rawMessage = err instanceof Error ? err.message : String(err || 'Gemini request failed.');
  const statusMatch = rawMessage.match(/\b(400|401|403|404|429|500|502|503|504)\b/);
  const statusFromErr =
    typeof (err as { status?: unknown })?.status === 'number'
      ? Number((err as { status: number }).status)
      : statusMatch
        ? Number(statusMatch[1])
        : 502;

  if (
    rawMessage.includes('API_KEY_INVALID') ||
    rawMessage.includes('PERMISSION_DENIED') ||
    statusFromErr === 400 ||
    statusFromErr === 403
  ) {
    return new GeminiServiceError(
      statusFromErr === 400 ? 400 : 403,
      'Gemini API credentials were rejected. Check your GEMINI_API_KEY in Settings > Secrets.'
    );
  }
  if (rawMessage.includes('RESOURCE_EXHAUSTED') || statusFromErr === 429) {
    return new GeminiServiceError(
      429,
      'Gemini quota limit reached (429 RESOURCE_EXHAUSTED). Please retry shortly or check quota in Settings > Secrets.'
    );
  }
  if (rawMessage.includes('NOT_FOUND') || statusFromErr === 404) {
    return new GeminiServiceError(
      502,
      `Configured Gemini model (${GEMINI_DECISION_MODEL}) returned NOT_FOUND (404).`
    );
  }
  if ((err as { name?: string })?.name === 'AbortError' || rawMessage.toLowerCase().includes('abort')) {
    return new GeminiServiceError(504, 'Gemini decision request timed out.');
  }
  return new GeminiServiceError(statusFromErr >= 400 ? statusFromErr : 502, rawMessage);
}

function isRetryableGeminiError(err: unknown): boolean {
  const normalized = normalizeGeminiError(err);
  if (normalized.statusCode === 400 || normalized.statusCode === 403 || normalized.statusCode === 404) {
    return false;
  }
  if (normalized.statusCode === 504) return false;
  return (
    normalized.statusCode === 429 ||
    normalized.statusCode >= 500 ||
    /network|fetch|timeout|ECONNRESET|ETIMEDOUT/i.test(normalized.message)
  );
}

export async function withGeminiRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 2,
  baseDelayMs = 300
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts || !isRetryableGeminiError(err)) {
        throw normalizeGeminiError(err);
      }
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt));
    }
  }
  throw normalizeGeminiError(lastError);
}
