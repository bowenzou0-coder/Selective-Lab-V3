import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  API_CACHE_FRESH_MS,
  api,
  clearApiCache,
  fetchCachedResource,
  getApiCacheScope,
  invalidateApiCache,
  isCachedResourceFresh,
  peekCachedResource,
  prefetchCachedResource,
  setApiCacheScope,
  type DashboardResponse,
  type StudentSettingsResponse,
} from './api';

type Pending = { url: string; method: string; resolve: (body: unknown, status?: number) => void };

const realFetch = globalThis.fetch;
const realNow = Date.now;
let calls: Pending[] = [];
/** When true, requests stay pending until the test resolves them; otherwise they answer at once. */
let manual = false;
let autoBody: (url: string, method: string) => unknown = () => ({});

function installFetch() {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || 'GET';
    return new Promise<Response>((resolveResponse) => {
      const pending: Pending = {
        url,
        method,
        resolve: (body, status = 200) =>
          resolveResponse(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })),
      };
      calls.push(pending);
      if (!manual) pending.resolve(autoBody(url, method));
    });
  }) as typeof fetch;
}

const dashboard = (studentId: string, streakDays = 1) => ({ studentId, streakDays }) as unknown as DashboardResponse;

beforeEach(() => {
  calls = [];
  manual = false;
  autoBody = (url) => (url === '/api/student/dashboard' ? dashboard('stu_a') : { ok: true });
  installFetch();
  setApiCacheScope(null);
  clearApiCache();
  setApiCacheScope('stu_a');
});

afterEach(() => {
  globalThis.fetch = realFetch;
  Date.now = realNow;
  setApiCacheScope(null);
});

test('SWR cache dedupes concurrent reads and serves fresh copies synchronously', async () => {
  manual = true;
  assert.equal(peekCachedResource('dashboard'), undefined);
  const first = api.getDashboard();
  const second = fetchCachedResource('dashboard');
  prefetchCachedResource('dashboard');
  assert.equal(calls.length, 1, 'in-flight request is shared');
  calls[0].resolve(dashboard('stu_a', 4));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(peekCachedResource('dashboard')?.streakDays, 4);
  assert.equal(isCachedResourceFresh('dashboard'), true);

  await api.getDashboard();
  assert.equal(calls.length, 1, 'fresh copy skips the network');
  manual = false;
  await api.getDashboard({ force: true });
  assert.equal(calls.length, 2, 'force bypasses the fresh window');
});

test('stale copies still paint while a background revalidation runs', async () => {
  await api.getDashboard();
  const t0 = realNow();
  Date.now = () => t0 + API_CACHE_FRESH_MS + 1;
  assert.equal(isCachedResourceFresh('dashboard'), false);
  assert.ok(peekCachedResource('dashboard'), 'stale-but-recent copy is still readable');
  manual = true;
  const refresh = api.getDashboard();
  assert.equal(calls.length, 2);
  calls[1].resolve(dashboard('stu_a', 9));
  assert.equal((await refresh).streakDays, 9);
  Date.now = () => t0 + 60 * 60_000;
  assert.equal(peekCachedResource('dashboard'), undefined, 'very old copies are not painted');
});

test('mutations invalidate the views they change', async () => {
  autoBody = (url) => {
    if (url === '/api/student/dashboard') return dashboard('stu_a');
    if (url === '/api/student/progress') return { sessions: [] };
    if (url === '/api/student/benchmarks') return { benchmarkBatches: [], reports: [] };
    if (url === '/api/student/settings') return { flags: [], onboardingCompleted: false };
    return { ok: true, sessionId: 'sess_1' };
  };
  const warmAll = () =>
    Promise.all([api.getDashboard(), api.getProgress(), api.getBenchmarks(), api.getStudentSettings()]);

  await warmAll();
  await api.createSession({ mode: 'daily_adaptive' });
  for (const key of ['dashboard', 'progress', 'benchmarks', 'settings'] as const) {
    assert.equal(peekCachedResource(key), undefined, `${key} dropped after createSession`);
  }

  await warmAll();
  await api.saveCheckpoint('sess_1', { currentIndex: 0, elapsedSec: 5, answersByPartId: {}, flaggedQuestionIds: [] });
  assert.equal(peekCachedResource('dashboard'), undefined);
  assert.equal(peekCachedResource('progress'), undefined);
  assert.ok(peekCachedResource('settings'), 'checkpoint keeps settings');

  await warmAll();
  await api.submitSession('sess_1');
  assert.equal(peekCachedResource('benchmarks'), undefined);

  await warmAll();
  await api.flagQuestion({ questionId: 'q1', sessionId: 'sess_1', reason: 'typo' });
  assert.equal(peekCachedResource('settings'), undefined);
  assert.ok(peekCachedResource('dashboard'));

  await warmAll();
  await api.resetOwnStudyProgress();
  assert.equal(peekCachedResource('dashboard'), undefined);
  assert.equal(peekCachedResource('progress'), undefined);

  await warmAll();
  await api.saveAdminConfig({} as never);
  assert.equal(peekCachedResource('settings'), undefined);

  await warmAll();
  await api.deleteAdminLearner('stu_b');
  assert.equal(peekCachedResource('dashboard'), undefined);
});

test('settings save and onboarding patch cached copies; analyze patches the report', async () => {
  const settings = { flags: [], onboardingCompleted: false, preferences: null } as unknown as StudentSettingsResponse;
  autoBody = (url) => {
    if (url === '/api/student/dashboard') return { ...dashboard('stu_a'), shouldShowOnboarding: true };
    if (url === '/api/student/settings') return settings;
    if (url === '/api/student/benchmarks') {
      return { benchmarkBatches: [], reports: [{ sessionId: 's1' }, { sessionId: 's2' }] };
    }
    if (url === '/api/student/progress') return { sessions: [] };
    if (url === '/api/student/settings/daily-plan') {
      return { ok: true, preferences: { dailyGoalMinutes: 40 }, effectiveConfig: { dailyGoalMinutes: 40 }, adminOverrideLocked: false };
    }
    if (url === '/api/student/settings/onboarding') return { ok: true, onboardingCompleted: true, onboardingCompletedAtIso: 'x' };
    if (url.endsWith('/analyze')) return { report: { sessionId: 's2', aiCoaching: { summary: 'ok' } } };
    return {};
  };

  await Promise.all([api.getDashboard(), api.getStudentSettings(), api.getBenchmarks(), api.getProgress()]);
  await api.saveStudentDailyPlan({ dailyGoalMinutes: 40 });
  assert.equal(peekCachedResource('settings')?.effectiveConfig.dailyGoalMinutes, 40);
  assert.equal(peekCachedResource('dashboard'), undefined, 'dashboard limits must refetch');

  await api.getDashboard();
  await api.setOnboardingStatus(true);
  assert.equal(peekCachedResource('settings')?.onboardingCompleted, true);
  assert.equal(peekCachedResource('dashboard')?.shouldShowOnboarding, false);

  const before = calls.length;
  await api.analyzeBenchmarkReport('s2');
  const hub = peekCachedResource('benchmarks');
  assert.deepEqual(hub?.reports.map((r) => Boolean(r.aiCoaching)), [false, true]);
  assert.equal(peekCachedResource('progress'), undefined);
  await api.getBenchmarks();
  assert.equal(calls.length, before + 1, 'patched benchmarks stay fresh (only the analyze POST ran)');
});

test('responses that started before an invalidation are never written back', async () => {
  manual = true;
  const pending = api.getProgress();
  invalidateApiCache(['progress']);
  calls[0].resolve({ sessions: ['old'] });
  await pending;
  assert.equal(peekCachedResource('progress'), undefined);

  const second = api.getProgress();
  assert.equal(calls.length, 2, 'invalidation also dropped the in-flight dedupe');
  calls[1].resolve({ sessions: ['new'] });
  await second;
  assert.ok(peekCachedResource('progress'));
});

test('switching accounts or signing out never leaks the previous learner cache', async () => {
  await api.getDashboard();
  assert.equal(peekCachedResource('dashboard')?.studentId, 'stu_a');

  setApiCacheScope('stu_a');
  assert.ok(peekCachedResource('dashboard'), 'same scope keeps the cache');

  manual = true;
  const lateA = api.getProgress();
  setApiCacheScope('stu_b');
  assert.equal(peekCachedResource('dashboard'), undefined);
  calls[calls.length - 1].resolve({ sessions: ['from A'] });
  await lateA;
  assert.equal(peekCachedResource('progress'), undefined, "an in-flight response from learner A is dropped for B");

  manual = false;
  autoBody = () => ({ authenticated: true, role: 'student', studentId: 'stu_c' });
  await api.studentLogin('1234');
  assert.equal(getApiCacheScope(), 'stu_c');

  autoBody = (url) => (url === '/api/student/dashboard' ? dashboard('stu_c') : { ok: true });
  await api.getDashboard();
  await api.logout();
  assert.equal(getApiCacheScope(), null);
  assert.equal(peekCachedResource('dashboard'), undefined);

  const before = calls.length;
  prefetchCachedResource('dashboard');
  assert.equal(calls.length, before, 'no prefetch without a signed-in scope');
});

test('a 401 clears the cache scope', async () => {
  await api.getDashboard();
  const dispatched: string[] = [];
  const g = globalThis as { window?: unknown };
  const hadWindow = 'window' in g;
  g.window = { dispatchEvent: (e: Event) => dispatched.push(e.type) };
  try {
    manual = true;
    const failing = api.getProgress({ force: true });
    calls[calls.length - 1].resolve({ error: 'expired' }, 401);
    await assert.rejects(failing);
    assert.equal(getApiCacheScope(), null);
    assert.equal(peekCachedResource('dashboard'), undefined);
    assert.deepEqual(dispatched, ['nsw-auth-expired']);
  } finally {
    if (!hadWindow) delete g.window;
  }
});
