import assert from 'node:assert/strict';
import test from 'node:test';
import { createDecisionsClient } from './geminiClient.ts';

test('Decisions client sends the System 1 model to the v1beta Decisions endpoint', async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-key-no-network';
  const requests: { url: URL; method: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push({
      url: new URL(request.url),
      method: request.method,
      body: JSON.parse(await request.text()),
    });
    return new Response(JSON.stringify({
      answers: { urgency: { type: 'score', score: 1, confidence: 1, probabilities: { '0': 0, '1': 1 } } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const response = await createDecisionsClient().decisions.create({
      model: 'gemini-decision-1',
      input: [{ type: 'text', text: 'This learner has a review due today.' }],
      questions: {
        urgency: { type: 'score', instructions: 'Rate review urgency.', criteria: ['Low', 'High'] },
      },
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url.origin, 'https://generativelanguage.googleapis.com');
    assert.equal(requests[0].url.pathname, '/v1beta/decisions');
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].body.model, 'gemini-decision-1');
    assert.equal(response.answers?.urgency.type, 'score');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});
