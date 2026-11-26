import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';
import { createApp } from '../../server.ts';
import type { BankImportManifest, SessionRecord } from '../shared/contracts.ts';
import { V3_STARTER_MANIFEST_EXAMPLE } from '../shared/v3Schema.ts';
import { AUTH_COOKIE_NAME, signSessionToken } from './auth.ts';
import { MemoryRepository } from './storage/memoryRepository.ts';

function cookieFor(sub: string, role: 'student' | 'admin' = 'student'): string {
  const token = signSessionToken({
    role,
    studentId: `google_${sub}`,
    email: role === 'admin' ? 'bowenzou0@gmail.com' : `${sub}@gmail.com`,
    authMethod: 'google',
    googleSub: sub,
  });
  return `${AUTH_COOKIE_NAME}=${token}`;
}

async function startServer() {
  const repo = new MemoryRepository();
  const officialSample = JSON.parse(
    await readFile('src/server/__fixtures__/official-sample.json', 'utf8')
  ) as Record<'pt12' | 'pt3', BankImportManifest>;
  const starter = structuredClone(V3_STARTER_MANIFEST_EXAMPLE) as unknown as BankImportManifest;
  const mathTemplate = structuredClone(officialSample.pt12.questions.find((q) => q.section === 'MATH')!);
  starter.questions.push({
    ...mathTemplate,
    questionId: 'q_fixture_holdout_math_v1',
    questionFamilyId: 'q_fixture_holdout_math',
    poolType: 'benchmark_holdout',
    qcStatus: 'active',
    parts: mathTemplate.parts.map((p, idx) => ({ ...p, partId: `q_fixture_holdout_math_p${idx + 1}` })),
  });
  // Add practice-pool Reading items (since official_calibration is strictly isolated from drills)
  const practiceReadStim = officialSample.pt12.stimuli.find((s) => s.section === 'READ');
  if (practiceReadStim) {
    starter.stimuli.push({
      ...structuredClone(practiceReadStim),
      stimulusId: 'stim_prac_read_v1',
      stimulusFamilyId: 'stim_prac_read',
    });
  }
  const readTemplates = officialSample.pt12.questions.filter((q) => q.section === 'READ').slice(0, 4);
  readTemplates.forEach((rt, idx) => {
    starter.questions.push({
      ...structuredClone(rt),
      questionId: `q_prac_read_${idx + 1}_v1`,
      questionFamilyId: `q_prac_read_${idx + 1}`,
      poolType: 'practice',
      qcStatus: 'active',
      stimulusId: practiceReadStim ? 'stim_prac_read_v1' : rt.stimulusId,
      parts: rt.parts.map((p, pIdx) => ({ ...p, partId: `q_prac_read_${idx + 1}_p${pIdx + 1}` })),
    });
  });
  await repo.initAndSeedIfEmpty(starter);
  await repo.importManifest(officialSample.pt12, 'system_seed');
  await repo.importManifest(officialSample.pt3, 'system_seed');
  const { app } = await createApp({ repo, skipSeed: false, skipVite: true });
  const server = await new Promise<http.Server>((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to bind ephemeral port.');
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const call = (path: string, init: { method?: string; cookie?: string; body?: unknown } = {}) =>
    fetch(`${baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(init.cookie ? { Cookie: init.cookie } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  return {
    repo,
    call,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

type CreateResponse = { sessionId: string; session: SessionRecord; error?: string; code?: string };

test('Repair drill API: empty pool, needs_repair only, quarantine filtering, explicit targets and passage cohesion', async () => {
  const srv = await startServer();
  try {
    const alice = cookieFor('repair_alice');

    // A fresh learner has nothing to repair: calm 400 with a machine-readable code.
    const empty = await srv.call('/api/student/sessions', { method: 'POST', cookie: alice, body: { mode: 'repair_drill' } });
    assert.equal(empty.status, 400);
    assert.equal(((await empty.json()) as CreateResponse).code, 'repair_pool_empty');

    // Malformed targets are rejected before any selection.
    const malformed = await srv.call('/api/student/sessions', {
      method: 'POST',
      cookie: alice,
      body: { mode: 'repair_drill', questionIds: 'q_1' },
    });
    assert.equal(malformed.status, 400);

    // Sit a Reading drill and submit it blank, so every item becomes needs_repair.
    const drillRes = await srv.call('/api/student/sessions', {
      method: 'POST',
      cookie: alice,
      body: { mode: 'section_drill', sectionFilter: 'READ', questionCount: 10 },
    });
    assert.equal(drillRes.status, 201);
    const drill = (await drillRes.json()) as CreateResponse;
    const missedIds = drill.session.plannedQuestionIds;
    assert.ok(missedIds.length >= 2, 'drill should serve several Reading questions');
    const submit = await srv.call(`/api/student/sessions/${drill.sessionId}/submit`, { method: 'POST', cookie: alice, body: {} });
    assert.equal(submit.status, 200);

    // Quarantine one missed item: the repair drill must skip it.
    const quarantined = missedIds[missedIds.length - 1];
    await srv.repo.updateQuestionStatus(quarantined, 'quarantined');

    const repairRes = await srv.call('/api/student/sessions', { method: 'POST', cookie: alice, body: { mode: 'repair_drill' } });
    assert.equal(repairRes.status, 201);
    const repair = (await repairRes.json()) as CreateResponse;
    assert.equal(repair.session.mode, 'repair_drill');
    assert.match(repair.session.title || '', /^Repair drill \(\d+ Qs\)$/);
    assert.ok((repair.session.timeLimitSec ?? 0) >= 300);
    const repairIds = repair.session.plannedQuestionIds;
    assert.ok(repairIds.length > 0);
    assert.ok(!repairIds.includes(quarantined), 'quarantined question must not be served');
    const missedSet = new Set(missedIds);
    for (const id of repairIds) assert.ok(missedSet.has(id), `${id} was never missed`);
    assert.equal(new Set(repairIds).size, repairIds.length);

    // Passages stay contiguous: once a stimulus run ends it never reappears.
    const served = await srv.repo.listQuestionsByIds(repairIds);
    const stimById = new Map(served.map((q) => [q.questionId, q.stimulusId]));
    const seen = new Set<string>();
    let prev: string | undefined;
    for (const id of repairIds) {
      const stim = stimById.get(id);
      if (stim && stim !== prev) {
        assert.ok(!seen.has(stim), `passage ${stim} was split`);
        seen.add(stim);
      }
      prev = stim;
    }

    // One active test at a time still applies to repair drills.
    const locked = await srv.call('/api/student/sessions', { method: 'POST', cookie: alice, body: { mode: 'repair_drill' } });
    assert.equal(locked.status, 409);
    assert.equal(((await locked.json()) as { activeSessionId: string }).activeSessionId, repair.sessionId);
    await srv.call(`/api/student/sessions/${repair.sessionId}/submit`, { method: 'POST', cookie: alice, body: {} });

    // Explicit targets (the review screen): holdout, quarantined and unknown ids are dropped.
    const target = repairIds[0];
    const explicitRes = await srv.call('/api/student/sessions', {
      method: 'POST',
      cookie: alice,
      body: {
        mode: 'repair_drill',
        questionIds: [target, 'q_fixture_holdout_math_v1', quarantined, 'missing_question_v1'],
      },
    });
    assert.equal(explicitRes.status, 201);
    const explicit = (await explicitRes.json()) as CreateResponse;
    assert.deepEqual(explicit.session.plannedQuestionIds, [target]);

    // Answer keys stay hidden while the repair drill is in progress.
    const detail = (await (await srv.call(`/api/student/sessions/${explicit.sessionId}`, { cookie: alice })).json()) as {
      questions: { parts: Record<string, unknown>[] }[];
    };
    for (const q of detail.questions) {
      for (const p of q.parts) assert.equal('correctAnswerKey' in p, false);
    }
    await srv.call(`/api/student/sessions/${explicit.sessionId}/submit`, { method: 'POST', cookie: alice, body: {} });

    // Only unavailable targets: empty-pool response, no session created.
    const onlyBad = await srv.call('/api/student/sessions', {
      method: 'POST',
      cookie: alice,
      body: { mode: 'repair_drill', questionIds: ['q_fixture_holdout_math_v1', quarantined] },
    });
    assert.equal(onlyBad.status, 400);
    assert.equal(((await onlyBad.json()) as CreateResponse).code, 'repair_pool_empty');

    // Another learner's mistakes never leak into this pool.
    const bob = cookieFor('repair_bob');
    const bobRes = await srv.call('/api/student/sessions', { method: 'POST', cookie: bob, body: { mode: 'repair_drill' } });
    assert.equal(bobRes.status, 400);

    for (const [tab, field] of [['dashboard', 'recentSessions'], ['progress', 'sessions']] as const) {
      const response = await srv.call(`/api/student/${tab}?view=summary`, { cookie: alice });
      assert.equal(response.status, 200);
      const history = (await response.json())[field] as Record<string, unknown>[];
      const row = history.find((s) => s.sessionId === explicit.sessionId);
      assert.ok(row);
      assert.equal(row.plannedQuestionCount, 1);
      assert.equal(row.status, 'submitted');
      assert.equal('checkpoint' in row, false);
      assert.equal('plannedQuestionIds' in row, false);
    }

    // Progress reports the repair count the drill draws from.
    const progress = (await (await srv.call('/api/student/progress', { cookie: alice })).json()) as {
      masterySummary: { needsRepairCount: number };
    };
    assert.ok(progress.masterySummary.needsRepairCount >= repairIds.length);
  } finally {
    await srv.close();
  }
});

test('Student flag withdrawal: auth, ownership, open-only guard, happy path, 404 and 409', async () => {
  const srv = await startServer();
  try {
    const alice = cookieFor('flag_alice');
    const bob = cookieFor('flag_bob');
    const admin = cookieFor('flag_admin', 'admin');
    const [question] = await srv.repo.listQuestions({ qcStatus: 'active' });

    const createFlag = async (reason: string) => {
      const res = await srv.call('/api/student/flags', {
        method: 'POST',
        cookie: alice,
        body: { questionId: question.questionId, sessionId: 'sess_x', reason },
      });
      assert.equal(res.status, 201);
      return ((await res.json()) as { flag: { flagId: string } }).flag.flagId;
    };
    const openFlag = await createFlag('Typo in option C');
    const reviewedFlag = await createFlag('Diagram unclear');

    // Signed-out callers are rejected.
    assert.equal((await srv.call(`/api/student/flags/${openFlag}`, { method: 'DELETE' })).status, 401);

    // Someone else's flag looks exactly like a missing one.
    const bobTry = await srv.call(`/api/student/flags/${openFlag}`, { method: 'DELETE', cookie: bob });
    assert.equal(bobTry.status, 404);
    assert.equal((await srv.call('/api/student/flags/flg_missing', { method: 'DELETE', cookie: alice })).status, 404);

    // Once an admin resolves a flag it can no longer be withdrawn.
    assert.equal((await srv.call(`/api/admin/flags/${reviewedFlag}/resolve`, { method: 'POST', cookie: admin })).status, 200);
    const late = await srv.call(`/api/student/flags/${reviewedFlag}`, { method: 'DELETE', cookie: alice });
    assert.equal(late.status, 409);

    // Happy path removes the flag from both the learner's list and the admin queue.
    const ok = await srv.call(`/api/student/flags/${openFlag}`, { method: 'DELETE', cookie: alice });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, flagId: openFlag });
    const mine = (await (await srv.call('/api/student/flags', { cookie: alice })).json()) as { flags: { flagId: string; status: string }[] };
    assert.deepEqual(
      mine.flags.map((f) => [f.flagId, f.status]),
      [[reviewedFlag, 'resolved']]
    );
    const adminFlags = (await (await srv.call('/api/admin/flags', { cookie: admin })).json()) as { flags: { flagId: string }[] };
    assert.ok(!adminFlags.flags.some((f) => f.flagId === openFlag));

    // Withdrawing twice is a 404, not a crash.
    assert.equal((await srv.call(`/api/student/flags/${openFlag}`, { method: 'DELETE', cookie: alice })).status, 404);

    // Settings reflects the change.
    const settings = (await (await srv.call('/api/student/settings', { cookie: alice })).json()) as { flags: { flagId: string }[] };
    assert.deepEqual(settings.flags.map((f) => f.flagId), [reviewedFlag]);
  } finally {
    await srv.close();
  }
});

test('Memory repository withdrawQuestionFlag reports withdrawn, not_found and not_open', async () => {
  const repo = new MemoryRepository();
  const base = { questionId: 'q1', sessionId: 's1', reason: 'r', createdAt: new Date().toISOString() };
  await repo.saveQuestionFlag({ ...base, flagId: 'f_open', studentId: 'stu_a', status: 'open' });
  await repo.saveQuestionFlag({ ...base, flagId: 'f_done', studentId: 'stu_a', status: 'resolved' });
  assert.equal(await repo.withdrawQuestionFlag('f_open', 'stu_b'), 'not_found');
  assert.equal(await repo.withdrawQuestionFlag('f_done', 'stu_a'), 'not_open');
  assert.equal(await repo.withdrawQuestionFlag('f_open', 'stu_a'), 'withdrawn');
  assert.equal(await repo.withdrawQuestionFlag('f_open', 'stu_a'), 'not_found');
  assert.deepEqual((await repo.listQuestionFlags('stu_a')).map((f) => f.flagId), ['f_done']);
});
