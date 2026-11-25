import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';
import { LoginTicket, OAuth2Client, type TokenPayload } from 'google-auth-library';
import { createApp } from '../../server.ts';
import type { BankImportManifest, LearningConfig, QuestionItem, SectionCode } from '../shared/contracts.ts';
import { V3_STARTER_MANIFEST_EXAMPLE } from '../shared/v3Schema.ts';
import { AUTH_COOKIE_NAME, GOOGLE_NONCE_COOKIE_NAME, signSessionToken } from './auth.ts';
import { getQuestionBatchTag } from '../shared/engine.ts';
import { createRepository } from './storage/index.ts';
import { MemoryRepository } from './storage/memoryRepository.ts';

function signedCookie(sub: string, role: 'student' | 'admin'): string {
  const token = signSessionToken({
    role,
    studentId: `google_${sub}`,
    email: role === 'admin' ? 'bowenzou0@gmail.com' : `${sub}@gmail.com`,
    authMethod: 'google',
    googleSub: sub,
  });
  return `${AUTH_COOKIE_NAME}=${token}`;
}

async function startTestServer() {
  const repo = new MemoryRepository();
  const officialSample = JSON.parse(
    await readFile('src/server/__fixtures__/official-sample.json', 'utf8')
  ) as Record<'pt12' | 'pt3', BankImportManifest>;
  // Seed starter pack + one synthetic holdout math item + official PT1–PT3 sample.
  const starter = structuredClone(V3_STARTER_MANIFEST_EXAMPLE) as unknown as BankImportManifest;
  const mathTemplate = structuredClone(officialSample.pt12.questions.find((q) => q.section === 'MATH')!);
  starter.questions.push({
    ...mathTemplate,
    questionId: 'q_fixture_holdout_math_v1',
    questionFamilyId: 'q_fixture_holdout_math',
    poolType: 'benchmark_holdout',
    qcStatus: 'active',
    parts: mathTemplate.parts.map((p, idx) => ({
      ...p,
      partId: `q_fixture_holdout_math_p${idx + 1}`,
      workedExplanation: 'Holdout math fixture explanation.',
    })),
  });
  await repo.initAndSeedIfEmpty(starter);
  await repo.importManifest(officialSample.pt12, 'system_seed');
  await repo.importManifest(officialSample.pt3, 'system_seed');
  const { app } = await createApp({ repo, skipSeed: false, skipVite: true });
  const server = await new Promise<http.Server>((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to bind ephemeral port.');
  }
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    baseUrl,
    repo,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

test('createRepository fails cleanly in production when no durable DB is configured', () => {
  const prevEnv = { ...process.env };
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.DATABASE_URL;
    delete process.env.SQL_HOST;
    delete process.env.SQL_USER;
    delete process.env.SQL_PASSWORD;
    delete process.env.SQL_DB_NAME;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.K_SERVICE;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GCLOUD_PROJECT;
    process.env.ALLOW_DEMO_MEMORY_DB = 'true'; // Must NOT silently allow memory DB in production!
    assert.throws(
      () => createRepository(),
      /Production configuration error: ALLOW_DEMO_MEMORY_DB=true is forbidden in production/
    );

    delete process.env.ALLOW_DEMO_MEMORY_DB;
    assert.throws(() => createRepository(), /Production configuration error: No durable database is configured/);
  } finally {
    process.env = prevEnv;
  }
});

test('API security: auth boundaries, cross-user isolation, zero answer key leakage, and retired /api/sync/hydrate', async () => {
  const srv = await startTestServer();
  try {
    const studentAToken = signedCookie('student_A', 'student');
    const studentBToken = signedCookie('student_B', 'student');
    const adminToken = signedCookie('admin', 'admin');

    // 1. Unauthenticated requests rejected cleanly with 401
    const unauthStudent = await fetch(`${srv.baseUrl}/api/student/dashboard`);
    assert.equal(unauthStudent.status, 401);

    const unauthAdmin = await fetch(`${srv.baseUrl}/api/admin/status`);
    assert.equal(unauthAdmin.status, 401);

    // 2. Student cannot access Admin endpoints (403)
    const studentAdmin = await fetch(`${srv.baseUrl}/api/admin/status`, {
      headers: { Cookie: studentAToken },
    });
    assert.equal(studentAdmin.status, 403);

    // 3. /api/sync/hydrate returns 410 Gone
    const hydrateRes = await fetch(`${srv.baseUrl}/api/sync/hydrate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: studentAToken,
      },
      body: JSON.stringify({}),
    });
    assert.equal(hydrateRes.status, 410);

    // 4. Student A creates session -> pre-submission GET strips all answer keys/rationales/evidenceRefs/isDecoy
    const createRes = await fetch(`${srv.baseUrl}/api/student/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: studentAToken,
      },
      body: JSON.stringify({ mode: 'section_drill', sectionFilter: 'READ' }),
    });
    assert.equal(createRes.status, 201);
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    // Single active test lock returns 409 for Student A while session is in_progress
    const secondCreate = await fetch(`${srv.baseUrl}/api/student/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: studentAToken,
      },
      body: JSON.stringify({ mode: 'section_drill', sectionFilter: 'MATH' }),
    });
    assert.equal(secondCreate.status, 409);

    const getA = await fetch(`${srv.baseUrl}/api/student/sessions/${sessionId}`, {
      headers: { Cookie: studentAToken },
    });
    assert.equal(getA.status, 200);
    const sessionData = (await getA.json()) as {
      questions: {
        stimulus?: { extracts?: Record<string, unknown>[] };
        parts: Record<string, unknown>[];
      }[];
    };
    assert.ok(sessionData.questions.length > 0);
    for (const q of sessionData.questions) {
      for (const p of q.parts) {
        assert.equal('correctAnswerKey' in p, false);
        assert.equal('workedExplanation' in p, false);
        assert.equal('distractorRationales' in p, false);
        assert.equal('evidenceRefs' in p, false);
      }
      for (const ex of q.stimulus?.extracts || []) {
        assert.equal('isDecoy' in ex, false);
      }
    }

    // 5. Cross-user isolation: Student B cannot GET, PATCH, or POST submit Student A's session
    const crossGet = await fetch(`${srv.baseUrl}/api/student/sessions/${sessionId}`, {
      headers: { Cookie: studentBToken },
    });
    assert.equal(crossGet.status, 403);

    const crossPatch = await fetch(`${srv.baseUrl}/api/student/sessions/${sessionId}/checkpoint`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: studentBToken,
      },
      body: JSON.stringify({ checkpoint: { currentIndex: 0, elapsedSec: 1, answersByPartId: {}, flaggedQuestionIds: [] } }),
    });
    assert.equal(crossPatch.status, 403);

    const crossSubmit = await fetch(`${srv.baseUrl}/api/student/sessions/${sessionId}/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: studentBToken,
      },
      body: JSON.stringify({}),
    });
    assert.equal(crossSubmit.status, 403);

    // Admin token also works cleanly
    const adminOk = await fetch(`${srv.baseUrl}/api/admin/status`, {
      headers: { Cookie: adminToken },
    });
    assert.equal(adminOk.status, 200);
  } finally {
    await srv.close();
  }
});

test('Checkpoint concurrency (409), idempotent submit, snapshot immutability on bank edits, and calibration sandbox isolation', async () => {
  const srv = await startTestServer();
  try {
    const studentToken = signedCookie('snapshot_user', 'student');
    const adminToken = signedCookie('admin_user', 'admin');

    // Create a clean single-question manifest with known answer 'A'
    const customManifest: BankImportManifest = {
      manifestVersion: '1.0',
      batchLabel: 'Snapshot Integrity Batch',
      defaultPoolType: 'practice',
      defaultQcStatus: 'active',
      stimuli: [],
      questions: [
        {
          questionId: 'q_snap_test_v1',
          questionFamilyId: 'q_snap_test',
          version: 1,
          section: 'MATH',
          formatType: 'MATH_MCQ_5',
          poolType: 'practice',
          qcStatus: 'active',
          parts: [
            {
              partId: 'q_snap_test_p1',
              partIndex: 0,
              promptText: 'Snapshot question v1: pick A.',
              skillId: 'MATH.NUM.NUMBER_SEQUENCES',
              difficultyInitial: 2.0,
              targetTimeSec: 60,
              cognitiveDemand: 'recall_locate',
              options: [
                { key: 'A', text: 'Original Correct' },
                { key: 'B', text: 'Original Wrong' },
              ],
              correctAnswerKey: 'A',
              workedExplanation: 'Original explanation.',
            },
          ],
          provenance: {
            sourceType: 'human_authored',
            verifierAgreed: true,
            auditorReviewed: true,
          },
        },
      ],
    };

    const imp1 = await fetch(`${srv.baseUrl}/api/admin/import/commit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: adminToken,
      },
      body: JSON.stringify({ manifest: customManifest }),
    });
    assert.equal(imp1.status, 200);

    // 1. Unknown questionIds rejected cleanly (400)
    const badCal = await fetch(`${srv.baseUrl}/api/admin/calibration/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: adminToken,
      },
      body: JSON.stringify({ questionIds: ['does_not_exist_999'], isSandbox: true }),
    });
    assert.equal(badCal.status, 400);

    // 2. Calibration sandbox session preserves exact question order & does not alter mastery
    const calRes = await fetch(`${srv.baseUrl}/api/admin/calibration/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: adminToken,
      },
      body: JSON.stringify({
        questionIds: ['q_snap_test_v1', 'q_off_pt1_read_q01_v1'],
        isSandbox: true,
      }),
    });
    assert.equal(calRes.status, 201);
    const calPayload = (await calRes.json()) as {
      sessionId: string;
      session: { plannedQuestionIds: string[]; isSandbox: boolean };
    };
    assert.deepEqual(calPayload.session.plannedQuestionIds, ['q_snap_test_v1', 'q_off_pt1_read_q01_v1']);
    assert.equal(calPayload.session.isSandbox, true);

    const calSubmit = await fetch(`${srv.baseUrl}/api/student/sessions/${calPayload.sessionId}/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: adminToken,
      },
      body: JSON.stringify({
        checkpoint: {
          currentIndex: 0,
          elapsedSec: 20,
          answersByPartId: { q_snap_test_p1: 'A' },
          flaggedQuestionIds: [],
        },
      }),
    });
    assert.equal(calSubmit.status, 200);
    const adminEvidenceAfterSandbox = await srv.repo.getQuestionEvidence('google_admin_user');
    assert.equal(Object.keys(adminEvidenceAfterSandbox).length, 0);

    // 3. Create normal student session (snapshot captures v1 answer 'A')
    const sRes = await fetch(`${srv.baseUrl}/api/student/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: studentToken,
      },
      body: JSON.stringify({ mode: 'section_drill', sectionFilter: 'MATH' }),
    });
    assert.equal(sRes.status, 201);
    const { sessionId, session } = (await sRes.json()) as {
      sessionId: string;
      session: { plannedQuestionIds: string[]; checkpointRevision: number };
    };

    // Also test a direct snapshot session containing q_snap_test_v1 via repo to guarantee snapshot immutability check
    const targetQ = (await srv.repo.getQuestionWithStimulus('q_snap_test_v1'))!;
    await srv.repo.createSession(
      {
        sessionId: 'sess_immutable_check',
        studentId: 'google_snapshot_user',
        configVersionId: 'cfg_v1',
        mode: 'section_drill',
        status: 'in_progress',
        plannedQuestionIds: [targetQ.question.questionId],
        checkpointRevision: 1,
        checkpoint: { currentIndex: 0, elapsedSec: 0, answersByPartId: {}, flaggedQuestionIds: [] },
        totalSlots: 1,
        correctSlots: 0,
        startedAt: new Date().toISOString(),
      },
      [
        {
          questionId: targetQ.question.questionId,
          snapshotIndex: 0,
          evidenceRevision: targetQ.question.evidenceRevision || 'er_test',
          question: targetQ.question,
        },
      ]
    );

    // Edit bank question in-place + retire v1 + change correct key to 'B'
    await srv.repo.updateQuestionStatus('q_snap_test_v1', 'retired');
    // Edit the stored bank row itself (repository reads hand out frozen copies).
    const bankStore = (srv.repo as unknown as { questions: Map<string, QuestionItem> }).questions;
    bankStore.get('q_snap_test_v1')!.parts[0].correctAnswerKey = 'B';
    assert.equal((await srv.repo.getQuestionWithStimulus('q_snap_test_v1'))!.question.parts[0].correctAnswerKey, 'B');

    // Checkpoint concurrency on active sessionId: rev 1 -> 2, stale rev 1 -> 409
    const cp1 = await fetch(`${srv.baseUrl}/api/student/sessions/${sessionId}/checkpoint`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: studentToken,
      },
      body: JSON.stringify({
        expectedRevision: session.checkpointRevision,
        checkpoint: { currentIndex: 0, elapsedSec: 12, answersByPartId: {}, flaggedQuestionIds: [] },
      }),
    });
    assert.equal(cp1.status, 200);

    const cpStale = await fetch(`${srv.baseUrl}/api/student/sessions/${sessionId}/checkpoint`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: studentToken,
      },
      body: JSON.stringify({
        expectedRevision: 1,
        checkpoint: { currentIndex: 0, elapsedSec: 15, answersByPartId: {}, flaggedQuestionIds: [] },
      }),
    });
    assert.equal(cpStale.status, 409);

    // Submit sess_immutable_check with original answer 'A' — must grade 'A' as CORRECT despite bank edit!
    const [subA, subB] = await Promise.all([
      fetch(`${srv.baseUrl}/api/student/sessions/sess_immutable_check/submit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: studentToken,
        },
        body: JSON.stringify({
          checkpoint: {
            currentIndex: 0,
            elapsedSec: 18,
            answersByPartId: { q_snap_test_p1: 'A' },
            flaggedQuestionIds: [],
          },
        }),
      }),
      fetch(`${srv.baseUrl}/api/student/sessions/sess_immutable_check/submit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: studentToken,
        },
        body: JSON.stringify({
          checkpoint: {
            currentIndex: 0,
            elapsedSec: 18,
            answersByPartId: { q_snap_test_p1: 'A' },
            flaggedQuestionIds: [],
          },
        }),
      }),
    ]);

    assert.equal(subA.status, 200);
    assert.equal(subB.status, 200);
    const bodyA = (await subA.json()) as { correctSlots: number; totalSlots: number; alreadySubmitted?: boolean };
    const bodyB = (await subB.json()) as { correctSlots: number; totalSlots: number; alreadySubmitted?: boolean };
    assert.equal(bodyA.correctSlots, 1);
    assert.equal(bodyB.correctSlots, 1);
    // At most 1 attempt & 1 evidence record created despite concurrent submit!
    const studentAttempts = await srv.repo.listPartAttempts(100, 'google_snapshot_user');
    assert.equal(studentAttempts.length, 1);
    assert.equal(studentAttempts[0].isCorrect, true);

    const evidenceMap = await srv.repo.getQuestionEvidence('google_snapshot_user');
    assert.equal(Object.keys(evidenceMap).length, 1);
    const ev = Object.values(evidenceMap)[0];
    assert.equal(ev.attemptsCount, 1);
    assert.equal(ev.cleanPassesCount, 1);
  } finally {
    await srv.close();
  }
});

test('Atomic 1-active-session lock, deadline expiry auto-finalization, diagnostics redaction, and daily focus plan caching', async () => {
  const prevEnv = { ...process.env };
  process.env.SESSION_SECRET = 'super-secret-value-must-never-leak';
  delete process.env.GEMINI_API_KEY;
  const srv = await startTestServer();
  try {
    const studentToken = signedCookie('lock_tester', 'student');
    const adminToken = signedCookie('admin_diag', 'admin');

    // 1. Concurrent session creation for same user: strictly 1 succeeds (201), 1 conflicts (409)
    const [r1, r2] = await Promise.all([
      fetch(`${srv.baseUrl}/api/student/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: studentToken,
        },
        body: JSON.stringify({ mode: 'section_drill', sectionFilter: 'MATH' }),
      }),
      fetch(`${srv.baseUrl}/api/student/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: studentToken,
        },
        body: JSON.stringify({ mode: 'section_drill', sectionFilter: 'READ' }),
      }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [201, 409]);

    const okRes = r1.status === 201 ? r1 : r2;
    const conflictRes = r1.status === 409 ? r1 : r2;
    const okBody = (await okRes.json()) as {
      sessionId: string;
      serverNowIso?: string;
      session: { deadlineAt?: string; timeLimitSec?: number };
    };
    const conflictBody = (await conflictRes.json()) as { activeSessionId?: string };
    assert.equal(conflictBody.activeSessionId, okBody.sessionId);
    assert.ok(okBody.serverNowIso);
    assert.ok(okBody.session.deadlineAt);
    assert.ok((okBody.session.timeLimitSec ?? 0) > 0);

    // 2. Submit that active session so we can test server deadline auto-expiry cleanly
    const subOk = await fetch(`${srv.baseUrl}/api/student/sessions/${okBody.sessionId}/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: studentToken,
      },
      body: JSON.stringify({
        checkpoint: { currentIndex: 0, elapsedSec: 10, answersByPartId: {}, flaggedQuestionIds: [] },
      }),
    });
    assert.equal(subOk.status, 200);

    // 3. Expired session via past deadlineAt auto-finalizes on checkpoint (409 expiredAutoSubmitted) & GET
    const targetQ = (await srv.repo.getQuestionWithStimulus('q_off_pt1_math_q01_v1'))!;
    await srv.repo.reserveAndCreateSession(
      {
        sessionId: 'sess_expired_test',
        studentId: 'google_lock_tester',
        configVersionId: 'cfg_v1',
        mode: 'section_drill',
        sectionFilter: 'MATH',
        status: 'in_progress',
        isSandbox: false,
        plannedQuestionIds: [targetQ.question.questionId],
        checkpointRevision: 1,
        checkpoint: {
          currentIndex: 0,
          elapsedSec: 5,
          answersByPartId: {
            [targetQ.question.parts[0].partId]: targetQ.question.parts[0].correctAnswerKey,
          },
          flaggedQuestionIds: [],
        },
        timeLimitSec: 60,
        startedAt: new Date(Date.now() - 120_000).toISOString(),
        deadlineAt: new Date(Date.now() - 10_000).toISOString(),
        totalSlots: targetQ.question.parts.length,
        correctSlots: 0,
      },
      [
        {
          questionId: targetQ.question.questionId,
          snapshotIndex: 0,
          evidenceRevision: targetQ.question.evidenceRevision || 'er_exp',
          question: targetQ.question,
          stimulus: targetQ.stimulus,
        },
      ]
    );

    const lateCp = await fetch(`${srv.baseUrl}/api/student/sessions/sess_expired_test/checkpoint`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: studentToken,
      },
      body: JSON.stringify({
        expectedRevision: 1,
        checkpoint: { currentIndex: 0, elapsedSec: 70, answersByPartId: {}, flaggedQuestionIds: [] },
      }),
    });
    assert.equal(lateCp.status, 409);
    const lateCpJson = (await lateCp.json()) as { expiredAutoSubmitted?: boolean };
    assert.equal(lateCpJson.expiredAutoSubmitted, true);

    const getExpired = await fetch(`${srv.baseUrl}/api/student/sessions/sess_expired_test`, {
      headers: { Cookie: studentToken },
    });
    assert.equal(getExpired.status, 200);
    const expPayload = (await getExpired.json()) as {
      session: { status: string; expiredAutoSubmitted?: boolean; correctSlots: number };
      serverNowIso?: string;
    };
    assert.equal(expPayload.session.status, 'submitted');
    assert.equal(expPayload.session.expiredAutoSubmitted, true);
    assert.equal(expPayload.session.correctSlots, 1);
    assert.ok(expPayload.serverNowIso);

    // 3b. Missing expectedRevision on non-sandbox PATCH returns 400; sequential saves track checkpointRevision; late submit past grace uses server checkpoint
    await srv.repo.reserveAndCreateSession(
      {
        sessionId: 'sess_late_submit_check',
        studentId: 'google_lock_tester',
        configVersionId: 'cfg_v1',
        mode: 'section_drill',
        sectionFilter: 'MATH',
        status: 'in_progress',
        isSandbox: false,
        plannedQuestionIds: [targetQ.question.questionId],
        checkpointRevision: 1,
        checkpoint: {
          currentIndex: 0,
          elapsedSec: 20,
          answersByPartId: {
            [targetQ.question.parts[0].partId]: 'Z', // wrong answer saved before expiry
          },
          flaggedQuestionIds: [],
        },
        timeLimitSec: 60,
        startedAt: new Date(Date.now() - 120_000).toISOString(),
        deadlineAt: new Date(Date.now() - 10_000).toISOString(), // 10s past deadline (> 5s grace)
        totalSlots: targetQ.question.parts.length,
        correctSlots: 0,
      },
      [
        {
          questionId: targetQ.question.questionId,
          snapshotIndex: 0,
          evidenceRevision: targetQ.question.evidenceRevision || 'er_late',
          question: targetQ.question,
          stimulus: targetQ.stimulus,
        },
      ]
    );

    const lateSubmitRes = await fetch(`${srv.baseUrl}/api/student/sessions/sess_late_submit_check/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: studentToken,
      },
      body: JSON.stringify({
        checkpoint: {
          currentIndex: 0,
          elapsedSec: 59,
          answersByPartId: {
            [targetQ.question.parts[0].partId]: targetQ.question.parts[0].correctAnswerKey, // tamper attempt
          },
          flaggedQuestionIds: [],
        },
      }),
    });
    assert.equal(lateSubmitRes.status, 200);
    const lateSubmitJson = (await lateSubmitRes.json()) as { correctSlots: number; expiredAutoSubmitted?: boolean };
    assert.equal(lateSubmitJson.correctSlots, 0); // server checkpoint 'Z' used, NOT tampered late payload!
    assert.equal(lateSubmitJson.expiredAutoSubmitted, true);

    // Also verify missing expectedRevision returns 400 on active non-sandbox session
    const activeCreate = await fetch(`${srv.baseUrl}/api/student/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: studentToken,
      },
      body: JSON.stringify({ mode: 'section_drill', sectionFilter: 'MATH' }),
    });
    assert.equal(activeCreate.status, 201);
    const activeData = (await activeCreate.json()) as { sessionId: string };
    const missingRevPatch = await fetch(`${srv.baseUrl}/api/student/sessions/${activeData.sessionId}/checkpoint`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: studentToken,
      },
      body: JSON.stringify({
        checkpoint: { currentIndex: 0, elapsedSec: 5, answersByPartId: {}, flaggedQuestionIds: [] },
      }),
    });
    assert.equal(missingRevPatch.status, 400);

    // Submit it so student stays clean
    await fetch(`${srv.baseUrl}/api/student/sessions/${activeData.sessionId}/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: studentToken,
      },
      body: JSON.stringify({
        checkpoint: { currentIndex: 0, elapsedSec: 5, answersByPartId: {}, flaggedQuestionIds: [] },
      }),
    });

    // 4. Dashboard returns cached dailyFocusPlan (calling twice hits saved plan without changing timestamp)
    const dash1 = await fetch(`${srv.baseUrl}/api/student/dashboard`, {
      headers: { Cookie: studentToken },
    });
    assert.equal(dash1.status, 200);
    const d1 = (await dash1.json()) as { dailyFocusPlan?: { planDate: string; generatedAtIso: string; focusSkillIds: string[] } };
    assert.ok(d1.dailyFocusPlan && d1.dailyFocusPlan.focusSkillIds.length > 0);

    const dash2 = await fetch(`${srv.baseUrl}/api/student/dashboard`, {
      headers: { Cookie: studentToken },
    });
    const d2 = (await dash2.json()) as { dailyFocusPlan?: { planDate: string; generatedAtIso: string } };
    assert.equal(d2.dailyFocusPlan?.generatedAtIso, d1.dailyFocusPlan?.generatedAtIso);

    // 5. Admin diagnostics strictly redacts actual secrets
    process.env.GEMINI_API_KEY = 'gemini-secret-value-must-never-leak';
    const diagRes = await fetch(`${srv.baseUrl}/api/admin/diagnostics`, {
      headers: { Cookie: adminToken },
    });
    assert.equal(diagRes.status, 200);
    const diagText = await diagRes.text();
    assert.equal(diagText.includes('super-secret-value-must-never-leak'), false);
    assert.equal(diagText.includes('gemini-secret-value-must-never-leak'), false);
    const diagJson = JSON.parse(diagText) as {
      sessionSecretConfigured: boolean;
      geminiConfigured: boolean;
      geminiModel: string;
      configSource: string;
    };
    assert.equal(diagJson.sessionSecretConfigured, true);
    assert.equal(diagJson.geminiConfigured, true);
    assert.equal(diagJson.geminiModel, 'gemini-decision-1');
    assert.equal(diagJson.configSource, 'environment');
  } finally {
    process.env = prevEnv;
    await srv.close();
  }
});

test('Google login links a legacy student, accepts both admins, and sets only an HTTP-only session', async (t) => {
  const clientId = 'http-test.apps.googleusercontent.com';
  t.mock.property(process, 'env', {
    ...process.env,
    NODE_ENV: 'development',
    GOOGLE_CLIENT_ID: clientId,
    ADMIN_EMAILS: 'bowenzou0@gmail.com,yolandayue0319@gmail.com',
    GOOGLE_LEGACY_STUDENT_IDS: '{"legacy-google-sub":"uid_linked_student"}',
  });
  let claims: Partial<TokenPayload> = {};
  t.mock.method(OAuth2Client.prototype, 'verifyIdToken', async () => {
    return new LoginTicket('', {
      iss: 'https://accounts.google.com',
      aud: clientId,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      sub: 'legacy-google-sub',
      email: 'learner@gmail.com',
      email_verified: true,
      ...claims,
    });
  });

  const srv = await startTestServer();
  try {
    const getConfig = async () => {
      const response = await fetch(`${srv.baseUrl}/api/auth/google-config`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      const config = (await response.json()) as { clientId: string; nonce: string };
      assert.equal(config.clientId, clientId);
      assert.match(config.nonce, /^[A-Za-z0-9_-]{43}$/);
      const challengeCookie = response.headers.getSetCookie()[0];
      assert.match(challengeCookie, new RegExp(`^${GOOGLE_NONCE_COOKIE_NAME}=`));
      assert.match(challengeCookie, /HttpOnly/);
      return { nonce: config.nonce, cookie: challengeCookie.split(';')[0] };
    };
    const login = (cookie: string, admin = false, headers: Record<string, string> = {}) =>
      fetch(`${srv.baseUrl}/api/auth/google-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers },
        body: JSON.stringify({ credential: 'test-token', admin, studentId: 'someone-else', role: 'admin' }),
      });
    const challenge = await getConfig();
    assert.equal((await login('')).status, 401);
    assert.equal((await login(challenge.cookie)).status, 401);
    claims.nonce = challenge.nonce;
    assert.equal((await login(`${GOOGLE_NONCE_COOKIE_NAME}=${challenge.nonce}`)).status, 401);
    assert.equal((await login(challenge.cookie, false, { Origin: 'https://other.example' })).status, 403);
    assert.equal((await login(challenge.cookie, true)).status, 403);
    assert.equal((await login(challenge.cookie, false, { 'Content-Type': 'text/plain' })).status, 415);

    const studentLogin = await login(challenge.cookie);
    assert.equal(studentLogin.status, 200);
    const student = (await studentLogin.json()) as Record<string, unknown>;
    assert.equal(student.studentId, 'uid_linked_student');
    assert.equal(student.role, 'student');
    assert.equal('token' in student, false);
    const [setSession, clearChallenge] = studentLogin.headers.getSetCookie();
    assert.match(setSession, new RegExp(`^${AUTH_COOKIE_NAME}=`));
    assert.match(setSession, /HttpOnly/);
    assert.match(setSession, /SameSite=Lax/);
    assert.match(clearChallenge, new RegExp(`^${GOOGLE_NONCE_COOKIE_NAME}=;`));
    const studentCookie = setSession.split(';')[0];

    const created = await fetch(`${srv.baseUrl}/api/student/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: studentCookie },
      body: JSON.stringify({ mode: 'section_drill', sectionFilter: 'MATH' }),
    });
    assert.equal(created.status, 201);
    const { sessionId } = await created.json() as { sessionId: string };
    const returning = await getConfig();
    claims = { nonce: returning.nonce, email: 'learner-new@gmail.com' };
    const nextLogin = await login(returning.cookie);
    assert.equal(nextLogin.status, 200);
    const nextStudent = (await nextLogin.json()) as Record<string, unknown>;
    assert.equal(nextStudent.studentId, student.studentId);
    assert.equal(nextStudent.activeSessionId, sessionId);
    const nextCookie = nextLogin.headers.getSetCookie()[0].split(';')[0];
    const nextAuth = await fetch(`${srv.baseUrl}/api/auth/me`, { headers: { Cookie: nextCookie } });
    assert.deepEqual(await nextAuth.json(), nextStudent);

    for (const [sub, email] of [['admin-one', 'bowenzou0@gmail.com'], ['admin-two', 'yolandayue0319@gmail.com']]) {
      const adminChallenge = await getConfig();
      claims = { nonce: adminChallenge.nonce, sub, email };
      const adminLogin = await login(adminChallenge.cookie, true);
      assert.equal(adminLogin.status, 200);
      const admin = (await adminLogin.json()) as Record<string, unknown>;
      assert.equal(admin.studentId, `google_${sub}`);
      assert.equal(admin.role, 'admin');
      const adminCookie = adminLogin.headers.getSetCookie()[0].split(';')[0];
      const status = await fetch(`${srv.baseUrl}/api/admin/status`, { headers: { Cookie: adminCookie } });
      assert.equal(status.status, 200);
      const bank = await fetch(`${srv.baseUrl}/api/admin/questions?poolStatus=live&completionStatus=unseen`, {
        headers: { Cookie: adminCookie },
      });
      assert.equal(bank.status, 200);
      const view = await bank.json() as {
        questions: { questionId: string; qcStatus: string }[];
        progressByQuestionId: Record<string, { completionStatus: string }>;
        batchSummaries: { total: number }[];
        poolHealth: { liveCount: number };
      };
      assert.ok(view.questions.length > 0);
      assert.ok(view.questions.every((question) => question.qcStatus === 'active' &&
        view.progressByQuestionId[question.questionId].completionStatus === 'unseen'));
      assert.ok(view.batchSummaries.some((batch) => batch.total > 0));
      assert.ok(view.poolHealth.liveCount > 0);

      const counts = await fetch(`${srv.baseUrl}/api/admin/study-progress`, { headers: { Cookie: adminCookie } });
      assert.equal(counts.status, 200);
      const reset = await fetch(`${srv.baseUrl}/api/admin/study-progress/reset`, { method: 'POST', headers: { Cookie: adminCookie } });
      assert.equal(reset.status, 200);
      const resetBody = await reset.json() as { clearedSessions: number; preservedQuestionsCount: number };
      assert.equal(resetBody.clearedSessions, 0);
      assert.ok(resetBody.preservedQuestionsCount > 0);
    }

    const isolated = await fetch(`${srv.baseUrl}/api/auth/me`, { headers: { Cookie: nextCookie } });
    assert.deepEqual(await isolated.json(), nextStudent);
    const studentReset = await fetch(`${srv.baseUrl}/api/admin/study-progress/reset`, {
      method: 'POST',
      headers: { Cookie: nextCookie },
    });
    assert.equal(studentReset.status, 403);

    const crossSiteLogout = await fetch(`${srv.baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: nextCookie, 'Sec-Fetch-Site': 'same-site' },
    });
    assert.equal(crossSiteLogout.status, 403);
    const logout = await fetch(`${srv.baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: nextCookie, Origin: srv.baseUrl },
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.getSetCookie()[0], new RegExp(`^${AUTH_COOKIE_NAME}=; Max-Age=0;`));
  } finally {
    await srv.close();
  }
});

test('Dashboard returns pool counts excluding holdouts, custom batches that launch cleanly, and auto-calibrated limits matching session creation', async () => {
  const srv = await startTestServer();
  const studentCookie = signedCookie('dash_student', 'student');
  const adminCookie = signedCookie('dash_admin', 'admin');
  const studentId = 'google_dash_student';

  try {
    // 1. Seeded dashboard exposes live/unseen poolCounts, excludes PT3 holdout, and hides system seeds from customBatches
    const dashRes1 = await fetch(`${srv.baseUrl}/api/student/dashboard`, {
      headers: { Cookie: studentCookie },
    });
    assert.equal(dashRes1.status, 200);
    const d1 = (await dashRes1.json()) as {
      dailyGoalMinutes: number;
      dailyLimits: Record<SectionCode, number>;
      autoCalibrateEnabled: boolean;
      poolCounts: Record<SectionCode, { live: number; unseen: number }>;
      batchCounts: Record<'PT1' | 'PT2' | 'PT3', Record<SectionCode, number>>;
      customBatches: { batchId: string; batchLabel: string; counts: Record<SectionCode, number>; total: number }[];
      dailyFocusPlan: {
        planDate: string;
        autoCalibrated?: boolean;
        dailyQuestionLimitBySection?: Record<SectionCode, number>;
        dailyGoalMinutes?: number;
      };
    };

    const activeQuestions = await srv.repo.listQuestions({ qcStatus: 'active' });
    const nonHoldoutMath = activeQuestions.filter((q) => q.section === 'MATH' && q.poolType !== 'benchmark_holdout');
    const holdoutMath = activeQuestions.filter((q) => q.section === 'MATH' && q.poolType === 'benchmark_holdout');
    const pt3Math = activeQuestions.filter((q) => q.section === 'MATH' && getQuestionBatchTag(q) === 'PT3');
    assert.ok(
      pt3Math.length > 0 && pt3Math.every((q) => q.poolType !== 'benchmark_holdout') && holdoutMath.length > 0,
      'Expected unified PT3 maths items in active pool and smoke holdout item excluded'
    );
    assert.equal(d1.poolCounts.MATH.live, nonHoldoutMath.length);
    assert.equal(d1.poolCounts.MATH.unseen, nonHoldoutMath.length);
    assert.equal(d1.batchCounts.PT3.MATH, pt3Math.length);
    assert.ok(d1.poolCounts.READ.live > 0 && d1.poolCounts.THINK.live > 0 && d1.poolCounts.WRIT.live > 0);
    assert.deepEqual(d1.customBatches, []);

    // Verify autoRetireMastered reduces poolCounts when a question is certified retained
    const sampleMath = nonHoldoutMath[0];
    await srv.repo.upsertQuestionEvidence(
      [
        {
          evidenceKey: `${sampleMath.questionFamilyId}__${sampleMath.evidenceRevision || 'rev'}`,
          questionFamilyId: sampleMath.questionFamilyId,
          questionId: sampleMath.questionId,
          evidenceRevision: sampleMath.evidenceRevision || 'rev',
          section: 'MATH',
          status: 'retained',
          cleanPassesCount: 3,
          passTimestampsIso: ['2026-11-01T00:00:00Z', '2026-11-03T00:00:00Z', '2026-11-12T00:00:00Z'],
          everCleanPassed: true,
          firstSubmissionCleanPass: true,
          attemptsCount: 3,
          resetCount: 0,
          lastAttemptAtIso: '2026-11-12T00:00:00Z',
          lastAllCorrect: true,
          policyVersion: 'v3_3stage_24h_7d',
          updatedAtIso: '2026-11-12T00:00:00Z',
        },
      ],
      studentId
    );
    const dashAfterRetain = await fetch(`${srv.baseUrl}/api/student/dashboard`, {
      headers: { Cookie: studentCookie },
    });
    assert.equal(dashAfterRetain.status, 200);
    const dRetain = (await dashAfterRetain.json()) as typeof d1;
    // Default poolPolicy.autoRetireMastered is false: item stays live, but no longer unseen
    assert.equal(dRetain.poolCounts.MATH.live, nonHoldoutMath.length);
    assert.equal(dRetain.poolCounts.MATH.unseen, nonHoldoutMath.length - 1);

    // Enable autoRetireMastered and confirm mastered item is excluded from live poolCounts
    const cfg0Res = await fetch(`${srv.baseUrl}/api/admin/config`, { headers: { Cookie: adminCookie } });
    const cfg0 = (await cfg0Res.json()) as { active: { config: LearningConfig } };
    const autoRetireCfg = structuredClone(cfg0.active.config);
    autoRetireCfg.poolPolicy = { ...(autoRetireCfg.poolPolicy || { autoRetireMastered: false, allowRepeatWhenExhausted: true }), autoRetireMastered: true };
    await fetch(`${srv.baseUrl}/api/admin/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ config: autoRetireCfg, notes: 'enable auto-retire' }),
    });
    const dashAutoRetire = await fetch(`${srv.baseUrl}/api/student/dashboard`, {
      headers: { Cookie: studentCookie },
    });
    assert.equal(dashAutoRetire.status, 200);
    const dAutoRetire = (await dashAutoRetire.json()) as typeof d1;
    assert.equal(dAutoRetire.poolCounts.MATH.live, nonHoldoutMath.length - 1);
    assert.equal(dAutoRetire.poolCounts.MATH.unseen, nonHoldoutMath.length - 1);

    // 2. Auto-calibrated daily limits & goal minutes come from dailyFocusPlan (not raw sessionDefaults) and match daily_adaptive session creation
    assert.equal(d1.autoCalibrateEnabled, true);
    assert.equal(d1.dailyFocusPlan.autoCalibrated, true);
    assert.ok(d1.dailyFocusPlan.dailyQuestionLimitBySection);
    assert.ok(d1.dailyFocusPlan.dailyGoalMinutes);
    assert.deepEqual(d1.dailyLimits, d1.dailyFocusPlan.dailyQuestionLimitBySection);
    assert.equal(d1.dailyGoalMinutes, d1.dailyFocusPlan.dailyGoalMinutes);

    // Customize sessionDefaults vs autoCalibrate range so they are guaranteed distinct, then verify dashboard + session creation agree
    const cfgRes = await fetch(`${srv.baseUrl}/api/admin/config`, { headers: { Cookie: adminCookie } });
    assert.equal(cfgRes.status, 200);
    const { active } = (await cfgRes.json()) as { active: { config: LearningConfig } };
    const tunedConfig: LearningConfig = structuredClone(active.config);
    tunedConfig.sessionDefaults.dailyGoalMinutes = 55;
    tunedConfig.sessionDefaults.dailyQuestionLimitBySection = { READ: 1, MATH: 1, THINK: 1, WRIT: 0 };
    tunedConfig.autoCalibrate = {
      enabled: true,
      minDailyQuestions: 8,
      maxDailyQuestions: 10,
      includeWriting: false,
    };
    const saveCfgRes = await fetch(`${srv.baseUrl}/api/admin/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ config: tunedConfig, notes: 'distinct auto-cal range' }),
    });
    assert.equal(saveCfgRes.status, 201);

    // Simulate a stale cached plan missing auto-calibrated fields (from before fix); dashboard must upgrade it
    await srv.repo.saveDailyFocusPlan(studentId, {
      planDate: new Date().toISOString().slice(0, 10),
      studentId,
      generatedAtIso: '2026-01-01T00:00:00.000Z',
      source: 'deterministic',
      focusSkillIds: ['MATH.NUM.FRACTIONS_RATIOS'],
      skillWeights: { 'MATH.NUM.FRACTIONS_RATIOS': 1.2 },
      rationale: 'Legacy uncalibrated plan.',
    });

    const dashRes2 = await fetch(`${srv.baseUrl}/api/student/dashboard`, {
      headers: { Cookie: studentCookie },
    });
    assert.equal(dashRes2.status, 200);
    const d2 = (await dashRes2.json()) as typeof d1;
    assert.equal(d2.autoCalibrateEnabled, true);
    assert.deepEqual(d2.dailyLimits, d2.dailyFocusPlan.dailyQuestionLimitBySection);
    assert.equal(d2.dailyGoalMinutes, d2.dailyFocusPlan.dailyGoalMinutes);
    const plannedTotal = d2.dailyLimits.READ + d2.dailyLimits.MATH + d2.dailyLimits.THINK + d2.dailyLimits.WRIT;
    assert.ok(plannedTotal >= 8 && plannedTotal <= 10, `Expected auto-calibrated total in [8..10], got ${plannedTotal}`);
    assert.notEqual(d2.dailyGoalMinutes, 55);

    const dailySessRes = await fetch(`${srv.baseUrl}/api/student/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: studentCookie },
      body: JSON.stringify({ mode: 'daily_adaptive' }),
    });
    assert.equal(dailySessRes.status, 201);
    const dailySess = (await dailySessRes.json()) as {
      sessionId: string;
      session: { timeLimitSec?: number; plannedQuestionIds: string[] };
    };
    assert.equal(dailySess.session.timeLimitSec, d2.dailyGoalMinutes * 60);
    assert.equal(dailySess.session.plannedQuestionIds.length, plannedTotal);
    const dailyDetailRes = await fetch(`${srv.baseUrl}/api/student/sessions/${dailySess.sessionId}`, {
      headers: { Cookie: studentCookie },
    });
    const dailyDetail = (await dailyDetailRes.json()) as { questions: { section: SectionCode }[] };
    const createdBySection: Record<SectionCode, number> = { READ: 0, MATH: 0, THINK: 0, WRIT: 0 };
    for (const q of dailyDetail.questions) createdBySection[q.section] += 1;
    assert.deepEqual(createdBySection, d2.dailyLimits);

    // Submit the daily session so the student can start a custom batch mock
    const submitDaily = await fetch(`${srv.baseUrl}/api/student/sessions/${dailySess.sessionId}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: studentCookie },
      body: JSON.stringify({
        checkpoint: { currentIndex: 0, elapsedSec: 12, answersByPartId: {}, flaggedQuestionIds: [] },
      }),
    });
    assert.equal(submitDaily.status, 200);

    // 3. Import a custom batch, verify it appears in dashboard.customBatches, and launch a batch mock from it
    const customManifest = structuredClone(V3_STARTER_MANIFEST_EXAMPLE) as unknown as BankImportManifest;
    customManifest.batchLabel = 'Custom Weekend Pack 01';
    customManifest.stimuli[0].stimulusId = 'stim_custom_batch_01_v1';
    customManifest.stimuli[0].stimulusFamilyId = 'stim_custom_batch_01';
    customManifest.questions = customManifest.questions.slice(0, 2).map((q, idx) => ({
      ...q,
      questionId: `q_custom_wk01_${idx + 1}_v1`,
      questionFamilyId: `q_custom_wk01_${idx + 1}`,
      stimulusId: idx === 0 ? 'stim_custom_batch_01_v1' : undefined,
      parts: q.parts.map((p, pIdx) => ({ ...p, partId: `q_custom_wk01_${idx + 1}_p${pIdx + 1}` })),
    }));

    const importRes = await fetch(`${srv.baseUrl}/api/admin/import/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ manifest: customManifest }),
    });
    assert.equal(importRes.status, 200);
    const imported = (await importRes.json()) as { batch?: { batchId: string } };
    const customBatchId = imported.batch?.batchId;
    assert.ok(customBatchId);

    const dashRes3 = await fetch(`${srv.baseUrl}/api/student/dashboard`, {
      headers: { Cookie: studentCookie },
    });
    assert.equal(dashRes3.status, 200);
    const d3 = (await dashRes3.json()) as typeof d1;
    const foundBatch = d3.customBatches.find((b) => b.batchId === customBatchId);
    assert.ok(foundBatch, 'Custom imported batch must appear in dashboard.customBatches');
    assert.equal(foundBatch.batchLabel, 'Custom Weekend Pack 01');
    assert.equal(foundBatch.total, 2);
    assert.equal(foundBatch.counts.READ, 1);
    assert.equal(foundBatch.counts.MATH, 1);

    const batchMockRes = await fetch(`${srv.baseUrl}/api/student/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: studentCookie },
      body: JSON.stringify({
        mode: 'section_drill',
        mockSource: 'batch',
        batchId: customBatchId,
        timeMultiplier: 0,
      }),
    });
    assert.equal(batchMockRes.status, 201);
    const batchMock = (await batchMockRes.json()) as { session: { plannedQuestionIds: string[] } };
    assert.deepEqual(
      batchMock.session.plannedQuestionIds.sort(),
      ['q_custom_wk01_1_v1', 'q_custom_wk01_2_v1']
    );

    // Submit batch mock and verify disabling auto-calibrate falls back to sessionDefaults
    await fetch(`${srv.baseUrl}/api/student/sessions/${(batchMock as unknown as { sessionId: string }).sessionId}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: studentCookie },
      body: JSON.stringify({
        checkpoint: { currentIndex: 0, elapsedSec: 5, answersByPartId: {}, flaggedQuestionIds: [] },
      }),
    });

    tunedConfig.autoCalibrate = { ...tunedConfig.autoCalibrate, enabled: false };
    await fetch(`${srv.baseUrl}/api/admin/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ config: tunedConfig, notes: 'disable auto-calibrate' }),
    });

    const dashRes4 = await fetch(`${srv.baseUrl}/api/student/dashboard`, {
      headers: { Cookie: studentCookie },
    });
    assert.equal(dashRes4.status, 200);
    const d4 = (await dashRes4.json()) as typeof d1;
    assert.equal(d4.autoCalibrateEnabled, false);
    assert.equal(d4.dailyGoalMinutes, 55);
    assert.deepEqual(d4.dailyLimits, { READ: 1, MATH: 1, THINK: 1, WRIT: 0 });

    const manualSessRes = await fetch(`${srv.baseUrl}/api/student/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: studentCookie },
      body: JSON.stringify({ mode: 'daily_adaptive' }),
    });
    assert.equal(manualSessRes.status, 201);
    const manualSess = (await manualSessRes.json()) as {
      session: { timeLimitSec?: number; plannedQuestionIds: string[] };
    };
    assert.equal(manualSess.session.timeLimitSec, 55 * 60);
    assert.equal(manualSess.session.plannedQuestionIds.length, 3);

    // Explicit benchmark_holdout items remain isolated from live poolCounts
    const holdoutManifest = structuredClone(V3_STARTER_MANIFEST_EXAMPLE) as unknown as BankImportManifest;
    holdoutManifest.batchLabel = 'Synthetic Holdout Pack';
    holdoutManifest.defaultPoolType = 'benchmark_holdout';
    holdoutManifest.stimuli = [];
    const mathSample = holdoutManifest.questions.find((q) => q.section === 'MATH')!;
    holdoutManifest.questions = [
      {
        ...structuredClone(mathSample),
        questionId: 'q_synth_holdout_math_v1',
        questionFamilyId: 'q_synth_holdout_math',
        poolType: 'benchmark_holdout',
        parts: mathSample.parts.map((p, idx) => ({ ...p, partId: `q_synth_holdout_math_p${idx + 1}` })),
      },
    ];
    const importHoldoutRes = await fetch(`${srv.baseUrl}/api/admin/import/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ manifest: holdoutManifest }),
    });
    assert.equal(importHoldoutRes.status, 200);
    const dashAfterHoldout = await fetch(`${srv.baseUrl}/api/student/dashboard`, {
      headers: { Cookie: studentCookie },
    });
    assert.equal(dashAfterHoldout.status, 200);
    const dHoldout = (await dashAfterHoldout.json()) as typeof d1;
    assert.equal(dHoldout.poolCounts.MATH.live, d4.poolCounts.MATH.live);
  } finally {
    await srv.close();
  }
});

test('Multi-account student isolation, admin learner monitoring switcher, primary pin, and scoped reset', async () => {
  const srv = await startTestServer();
  const sisterId = 'google_sister_acc';
  const friendId = 'google_friend_acc';
  const adminId = 'google_bowen_admin';
  const sisterCookie = signedCookie('sister_acc', 'student');
  const friendCookie = signedCookie('friend_acc', 'student');
  const adminCookie = signedCookie('bowen_admin', 'admin');

  try {
    // 1. Both students and admin generate separate sessions
    const sisterDash1 = await fetch(`${srv.baseUrl}/api/student/dashboard`, {
      headers: { Cookie: sisterCookie },
    });
    assert.equal(sisterDash1.status, 200);

    const activeQuestions = await srv.repo.listQuestions({ qcStatus: 'active' });
    const nonHoldoutMath = activeQuestions.filter(
      (q) => q.section === 'MATH' && q.poolType !== 'benchmark_holdout',
    );
    const sampleQ1 = nonHoldoutMath[0];
    const sampleQ2 = nonHoldoutMath[1];

    // Record completion evidence on sampleQ1 for sister, and sampleQ2 for admin
    await srv.repo.upsertQuestionEvidence(
      [
        {
          evidenceKey: `${sampleQ1.questionFamilyId}__${sampleQ1.evidenceRevision || 'rev'}`,
          questionFamilyId: sampleQ1.questionFamilyId,
          questionId: sampleQ1.questionId,
          evidenceRevision: sampleQ1.evidenceRevision || 'rev',
          section: 'MATH',
          status: 'retained',
          cleanPassesCount: 3,
          passTimestampsIso: ['2026-11-01T00:00:00Z', '2026-11-03T00:00:00Z', '2026-11-12T00:00:00Z'],
          everCleanPassed: true,
          firstSubmissionCleanPass: true,
          attemptsCount: 3,
          resetCount: 0,
          lastAttemptAtIso: '2026-11-12T00:00:00Z',
          lastAllCorrect: true,
          policyVersion: 'v3_3stage_24h_7d',
          updatedAtIso: '2026-11-12T00:00:00Z',
        },
      ],
      sisterId,
    );
    await srv.repo.upsertQuestionEvidence(
      [
        {
          evidenceKey: `${sampleQ2.questionFamilyId}__${sampleQ2.evidenceRevision || 'rev'}`,
          questionFamilyId: sampleQ2.questionFamilyId,
          questionId: sampleQ2.questionId,
          evidenceRevision: sampleQ2.evidenceRevision || 'rev',
          section: 'MATH',
          status: 'retained',
          cleanPassesCount: 3,
          passTimestampsIso: ['2026-11-01T00:00:00Z', '2026-11-03T00:00:00Z', '2026-11-12T00:00:00Z'],
          everCleanPassed: true,
          firstSubmissionCleanPass: true,
          attemptsCount: 3,
          resetCount: 0,
          lastAttemptAtIso: '2026-11-12T00:00:00Z',
          lastAllCorrect: true,
          policyVersion: 'v3_3stage_24h_7d',
          updatedAtIso: '2026-11-12T00:00:00Z',
        },
      ],
      adminId,
    );

    const sisterSess = await fetch(`${srv.baseUrl}/api/student/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sisterCookie },
      body: JSON.stringify({ mode: 'daily_adaptive' }),
    });
    assert.equal(sisterSess.status, 201);

    const friendSess = await fetch(`${srv.baseUrl}/api/student/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: friendCookie },
      body: JSON.stringify({ mode: 'daily_adaptive' }),
    });
    assert.equal(friendSess.status, 201);

    // Per-student unseen isolation on dashboard
    const [sisterDash2, friendDash] = await Promise.all([
      fetch(`${srv.baseUrl}/api/student/dashboard`, { headers: { Cookie: sisterCookie } }),
      fetch(`${srv.baseUrl}/api/student/dashboard`, { headers: { Cookie: friendCookie } }),
    ]);
    const sd = (await sisterDash2.json()) as {
      poolCounts: Record<SectionCode, { live: number; unseen: number }>;
    };
    const fd = (await friendDash.json()) as {
      poolCounts: Record<SectionCode, { live: number; unseen: number }>;
    };
    assert.equal(sd.poolCounts.MATH.unseen, nonHoldoutMath.length - 1);
    assert.equal(fd.poolCounts.MATH.unseen, nonHoldoutMath.length);

    // 2. Students cannot call multi-learner admin endpoints
    const forbiddenLearners = await fetch(`${srv.baseUrl}/api/admin/learners`, {
      headers: { Cookie: sisterCookie },
    });
    assert.equal(forbiddenLearners.status, 403);
    const forbiddenPin = await fetch(`${srv.baseUrl}/api/admin/learners/primary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sisterCookie },
      body: JSON.stringify({ studentId: sisterId }),
    });
    assert.equal(forbiddenPin.status, 403);

    // 3. Admin /api/admin/learners summarizes each learner independently & never defaults to admin
    const learnersRes = await fetch(`${srv.baseUrl}/api/admin/learners`, {
      headers: { Cookie: adminCookie },
    });
    assert.equal(learnersRes.status, 200);
    const learnersBody = (await learnersRes.json()) as {
      learners: Array<{
        uid: string;
        role?: string;
        sessionsCount: number;
        unseenLiveCount: number;
        doneLiveCount: number;
      }>;
      primaryMonitoredStudentId: string | null;
      defaultMonitoredStudentId: string | null;
      totalLiveQuestions: number;
    };
    assert.equal(learnersBody.primaryMonitoredStudentId, null);
    assert.ok(
      learnersBody.defaultMonitoredStudentId === sisterId ||
        learnersBody.defaultMonitoredStudentId === friendId,
    );
    const sisterRow = learnersBody.learners.find((l) => l.uid === sisterId);
    const friendRow = learnersBody.learners.find((l) => l.uid === friendId);
    assert.ok(sisterRow && friendRow);
    assert.equal(sisterRow.doneLiveCount, 1);
    assert.equal(sisterRow.unseenLiveCount, learnersBody.totalLiveQuestions - 1);
    assert.equal(sisterRow.sessionsCount, 1);
    assert.equal(friendRow.doneLiveCount, 0);
    assert.equal(friendRow.unseenLiveCount, learnersBody.totalLiveQuestions);
    assert.equal(friendRow.sessionsCount, 1);

    // 4. Pin sister as primary monitored learner
    const pinRes = await fetch(`${srv.baseUrl}/api/admin/learners/primary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ studentId: sisterId }),
    });
    assert.equal(pinRes.status, 200);
    const pinBody = (await pinRes.json()) as {
      ok: boolean;
      primaryMonitoredStudentId: string | null;
    };
    assert.equal(pinBody.ok, true);
    assert.equal(pinBody.primaryMonitoredStudentId, sisterId);

    // 5. /api/admin/questions defaults to pinned sister, and switches cleanly to friend or none
    const defaultBankRes = await fetch(
      `${srv.baseUrl}/api/admin/questions?section=MATH&pageSize=100`,
      { headers: { Cookie: adminCookie } },
    );
    assert.equal(defaultBankRes.status, 200);
    const defaultBank = (await defaultBankRes.json()) as {
      monitoredStudentId?: string | null;
      poolHealth: { unseenLiveCount: number };
      progressByQuestionId: Record<string, { completionStatus: string }>;
    };
    assert.equal(defaultBank.monitoredStudentId, sisterId);
    assert.equal(
      defaultBank.poolHealth.unseenLiveCount,
      learnersBody.totalLiveQuestions - 1,
    );
    assert.equal(defaultBank.progressByQuestionId[sampleQ1.questionId]?.completionStatus, 'done');

    const friendBankRes = await fetch(
      `${srv.baseUrl}/api/admin/questions?section=MATH&pageSize=100&studentId=${encodeURIComponent(friendId)}`,
      { headers: { Cookie: adminCookie } },
    );
    assert.equal(friendBankRes.status, 200);
    const friendBank = (await friendBankRes.json()) as typeof defaultBank;
    assert.equal(friendBank.monitoredStudentId, friendId);
    assert.equal(friendBank.poolHealth.unseenLiveCount, learnersBody.totalLiveQuestions);
    assert.equal(friendBank.progressByQuestionId[sampleQ1.questionId]?.completionStatus, 'unseen');

    const noneBankRes = await fetch(
      `${srv.baseUrl}/api/admin/questions?section=MATH&pageSize=100&studentId=none`,
      { headers: { Cookie: adminCookie } },
    );
    assert.equal(noneBankRes.status, 200);
    const noneBank = (await noneBankRes.json()) as typeof defaultBank;
    assert.equal(noneBank.monitoredStudentId, null);
    assert.equal(noneBank.progressByQuestionId[sampleQ1.questionId]?.completionStatus, 'unseen');

    // 6. Scoped daily-plan & study-progress reset affects only the target student
    const planRes = await fetch(
      `${srv.baseUrl}/api/admin/daily-plan?studentId=${encodeURIComponent(sisterId)}`,
      { headers: { Cookie: adminCookie } },
    );
    assert.equal(planRes.status, 200);
    const planBody = (await planRes.json()) as { studentId: string | null };
    assert.equal(planBody.studentId, sisterId);

    const resetSisterRes = await fetch(`${srv.baseUrl}/api/admin/study-progress/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ studentId: sisterId }),
    });
    assert.equal(resetSisterRes.status, 200);
    const resetSisterBody = (await resetSisterRes.json()) as { clearedSessions: number };
    assert.equal(resetSisterBody.clearedSessions, 1);

    const friendProgressAfter = await fetch(
      `${srv.baseUrl}/api/admin/study-progress?studentId=${encodeURIComponent(friendId)}`,
      { headers: { Cookie: adminCookie } },
    );
    assert.equal(friendProgressAfter.status, 200);
    const fpBody = (await friendProgressAfter.json()) as { sessionsCount: number };
    assert.equal(fpBody.sessionsCount, 1);
  } finally {
    await srv.close();
  }
});

test('Admin lightweight endpoints: batch summaries, summary-free paging, and cross-learner holdout isolation', async () => {
  const srv = await startTestServer();
  const adminCookie = signedCookie('lite_admin', 'admin');
  try {
    const summaryRes = await fetch(`${srv.baseUrl}/api/admin/batches/summary?studentId=none`, {
      headers: { Cookie: adminCookie },
    });
    assert.equal(summaryRes.status, 200);
    const summary = (await summaryRes.json()) as { batchSummaries: { total: number; questionIds: string[] }[] };
    const bankSize = (await srv.repo.listQuestionMeta()).length;
    assert.equal(summary.batchSummaries.reduce((n, b) => n + b.total, 0), bankSize);

    const pageRes = await fetch(`${srv.baseUrl}/api/admin/questions?page=1&pageSize=5&summary=0`, {
      headers: { Cookie: adminCookie },
    });
    const page = (await pageRes.json()) as Record<string, unknown>;
    assert.equal(pageRes.status, 200);
    assert.equal((page.questions as unknown[]).length, 5);
    assert.equal(page.poolHealth, undefined);
    assert.equal(page.batchSummaries, undefined);
    assert.equal(page.batches, undefined, 'import batch records are not sent to the bank UI');

    // A holdout question planned into another learner's practice session must be reported.
    const holdout = (await srv.repo.listQuestionMeta()).find((q) => q.poolType === 'benchmark_holdout')!;
    await srv.repo.createSession({
      sessionId: 'sess_leak_check',
      studentId: 'google_other_learner',
      configVersionId: 'cfg_v1',
      mode: 'daily_adaptive',
      title: 'Leak check',
      isSandbox: false,
      status: 'in_progress',
      plannedQuestionIds: [holdout.questionId],
      checkpointRevision: 1,
      totalSlots: 1,
      correctSlots: 0,
      startedAt: new Date().toISOString(),
    });
    const status = (await (await fetch(`${srv.baseUrl}/api/admin/status`, { headers: { Cookie: adminCookie } })).json()) as {
      holdoutIsolationOk: boolean;
      leakedCount: number;
    };
    assert.equal(status.holdoutIsolationOk, false);
    assert.equal(status.leakedCount, 1);

    const forbidden = await fetch(`${srv.baseUrl}/api/admin/batches/summary`, {
      headers: { Cookie: signedCookie('lite_student', 'student') },
    });
    assert.equal(forbidden.status, 403);

    // Bulk status update endpoint: enforces admin auth, validates status, updates multiple questions in 1 call.
    const studentBulk = await fetch(`${srv.baseUrl}/api/admin/questions/bulk-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: signedCookie('lite_student', 'student') },
      body: JSON.stringify({ questionIds: ['q_off_pt1_math_q01_v1'], qcStatus: 'retired' }),
    });
    assert.equal(studentBulk.status, 403);

    const invalidBulk = await fetch(`${srv.baseUrl}/api/admin/questions/bulk-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ questionIds: ['q_off_pt1_math_q01_v1'], qcStatus: 'bogus' }),
    });
    assert.equal(invalidBulk.status, 400);

    const okBulk = await fetch(`${srv.baseUrl}/api/admin/questions/bulk-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        questionIds: ['q_off_pt1_math_q01_v1', 'q_off_pt1_math_q02_v1'],
        qcStatus: 'quarantined',
      }),
    });
    assert.equal(okBulk.status, 200);
    const bulkBody = (await okBulk.json()) as { ok: boolean; updatedCount: number };
    assert.equal(bulkBody.ok, true);
    assert.equal(bulkBody.updatedCount, 2);
    const updatedQ1 = await srv.repo.getQuestionWithStimulus('q_off_pt1_math_q01_v1');
    const updatedQ2 = await srv.repo.getQuestionWithStimulus('q_off_pt1_math_q02_v1');
    assert.equal(updatedQ1?.question.qcStatus, 'quarantined');
    assert.equal(updatedQ2?.question.qcStatus, 'quarantined');
  } finally {
    await srv.close();
  }
});

test('Official benchmark exam runs section-by-section with untimed breaks, server expiry auto-advance, and saved report on progress', async () => {
  const srv = await startTestServer();
  const studentCookie = signedCookie('bench_student', 'student');
  const studentId = 'google_bench_student';
  try {
    const active = await srv.repo.listQuestions({ qcStatus: 'active' });
    const pick = (sec: SectionCode) =>
      structuredClone(active.find((q) => q.section === sec && q.poolType !== 'benchmark_holdout')!);
    const readQ = pick('READ');
    const mathQ = pick('MATH');
    const thinkQ = pick('THINK');
    const writQ = pick('WRIT');

    const holdoutQuestions = [readQ, mathQ, thinkQ, writQ].map((q) => ({
      ...q,
      questionId: `bh_test_${q.section.toLowerCase()}_v1`,
      questionFamilyId: `bh_test_${q.section.toLowerCase()}`,
      version: 1,
      poolType: 'benchmark_holdout' as const,
      qcStatus: 'active' as const,
      batchId: undefined,
      batchLabel: '2026-11-24_b99',
      parts: q.parts.map((p, idx) => ({
        ...p,
        partId: `bh_test_${q.section.toLowerCase()}_p${idx + 1}`,
      })),
    }));

    const imported = await srv.repo.importManifest(
      {
        manifestVersion: '1.0',
        batchLabel: '2026-11-24_b99',
        defaultPoolType: 'benchmark_holdout',
        defaultQcStatus: 'active',
        stimuli: [],
        questions: holdoutQuestions,
      },
      'test_seed'
    );
    const batchId = imported.batch.batchId;

    // 1. Progress before taking any benchmark must return empty benchmarkReports
    const preProgRes = await fetch(`${srv.baseUrl}/api/student/progress`, {
      headers: { Cookie: studentCookie },
    });
    assert.equal(preProgRes.status, 200);
    const preProg = (await preProgRes.json()) as { benchmarkReports: unknown[] };
    assert.deepEqual(preProg.benchmarkReports, []);

    // 2. Launch Official Benchmark exam -> starts on Section 0 (READ) with 45m deadline (not 155m)
    const createRes = await fetch(`${srv.baseUrl}/api/student/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: studentCookie },
      body: JSON.stringify({ mode: 'benchmark_exam', batchId }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as {
      sessionId: string;
      session: {
        timeLimitSec: number;
        deadlineAt?: string;
        checkpointRevision?: number;
        sectionState?: {
          currentSectionIndex: number;
          phase: 'active' | 'on_break';
          sections: {
            section: SectionCode;
            startIndex: number;
            endIndex: number;
            timeLimitSec: number;
            status: string;
            deadlineAt?: string;
            elapsedSec: number;
            expiredAutoAdvanced?: boolean;
          }[];
        };
      };
    };
    const sid = created.sessionId;
    assert.equal(created.session.timeLimitSec, 9300);
    assert.equal(created.session.sectionState?.currentSectionIndex, 0);
    assert.equal(created.session.sectionState?.phase, 'active');
    assert.deepEqual(
      created.session.sectionState?.sections.map((s) => [s.section, s.timeLimitSec]),
      [
        ['READ', 2700],
        ['MATH', 2400],
        ['THINK', 2400],
        ['WRIT', 1800],
      ]
    );
    assert.equal(created.session.deadlineAt, created.session.sectionState?.sections[0].deadlineAt);

    // 3. Checkpoint during READ saves READ answer and ignores out-of-section MATH answer
    const readPart = holdoutQuestions[0].parts[0];
    const mathPart = holdoutQuestions[1].parts[0];
    const cpRes = await fetch(`${srv.baseUrl}/api/student/sessions/${sid}/checkpoint`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: studentCookie },
      body: JSON.stringify({
        expectedRevision: created.session.checkpointRevision ?? 1,
        checkpoint: {
          currentIndex: 3, // out of READ bounds [0,1) -> clamped to 0
          elapsedSec: 25,
          answersByPartId: {
            [readPart.partId]: readPart.correctAnswerKey,
            [mathPart.partId]: mathPart.correctAnswerKey,
          },
          flaggedQuestionIds: [],
        },
      }),
    });
    assert.equal(cpRes.status, 200);
    const cpBody = (await cpRes.json()) as { checkpointRevision: number };

    // Submitting entire exam early before final section must be rejected
    const earlySubmit = await fetch(`${srv.baseUrl}/api/student/sessions/${sid}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: studentCookie },
      body: JSON.stringify({ expectedRevision: cpBody.checkpointRevision }),
    });
    assert.equal(earlySubmit.status, 400);

    // 4. Complete Section 0 (READ) -> enters untimed break before MATH; READ is locked
    const comp0Res = await fetch(`${srv.baseUrl}/api/student/sessions/${sid}/section/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: studentCookie },
      body: JSON.stringify({
        expectedRevision: cpBody.checkpointRevision,
        checkpoint: {
          currentIndex: 0,
          elapsedSec: 40,
          answersByPartId: {
            [readPart.partId]: readPart.correctAnswerKey,
            [mathPart.partId]: mathPart.correctAnswerKey,
          },
          flaggedQuestionIds: [],
        },
      }),
    });
    assert.equal(comp0Res.status, 200);
    const comp0 = (await comp0Res.json()) as {
      finishedExam: boolean;
      session: {
        status: string;
        deadlineAt?: string;
        checkpointRevision?: number;
        checkpoint?: { currentIndex: number; answersByPartId: Record<string, string | null> };
        sectionState?: {
          currentSectionIndex: number;
          phase: 'active' | 'on_break';
          sections: { status: string; elapsedSec: number; expiredAutoAdvanced?: boolean }[];
        };
      };
    };
    assert.equal(comp0.finishedExam, false);
    assert.equal(comp0.session.status, 'in_progress');
    assert.equal(comp0.session.sectionState?.phase, 'on_break');
    assert.equal(comp0.session.sectionState?.currentSectionIndex, 1);
    assert.equal(comp0.session.sectionState?.sections[0].status, 'completed');
    assert.equal(comp0.session.deadlineAt, undefined);
    assert.equal(comp0.session.checkpoint?.answersByPartId[readPart.partId], readPart.correctAnswerKey);
    assert.equal(comp0.session.checkpoint?.answersByPartId[mathPart.partId], undefined);

    // Checkpoint while on_break returns 409 sectionPhase: 'on_break'
    const breakCpRes = await fetch(`${srv.baseUrl}/api/student/sessions/${sid}/checkpoint`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: studentCookie },
      body: JSON.stringify({
        expectedRevision: comp0.session.checkpointRevision ?? 1,
        checkpoint: comp0.session.checkpoint,
      }),
    });
    assert.equal(breakCpRes.status, 409);
    const breakCpErr = (await breakCpRes.json()) as { sectionPhase?: string };
    assert.equal(breakCpErr.sectionPhase, 'on_break');

    // Reloading during untimed break NEVER expires the session even if startedAt was hours ago
    await srv.repo.updateSessionProgressState(sid, studentId, (s) => {
      s.startedAt = new Date(Date.now() - 5 * 3600_000).toISOString();
    });
    const breakGetRes = await fetch(`${srv.baseUrl}/api/student/sessions/${sid}`, {
      headers: { Cookie: studentCookie },
    });
    assert.equal(breakGetRes.status, 200);
    const breakGet = (await breakGetRes.json()) as {
      session: { status: string; checkpointRevision?: number; sectionState?: { phase: string } };
    };
    assert.equal(breakGet.session.status, 'in_progress');
    assert.equal(breakGet.session.sectionState?.phase, 'on_break');

    // 5. Start Section 1 (MATH)
    const start1Res = await fetch(`${srv.baseUrl}/api/student/sessions/${sid}/section/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: studentCookie },
      body: JSON.stringify({ expectedRevision: breakGet.session.checkpointRevision }),
    });
    assert.equal(start1Res.status, 200);
    const start1 = (await start1Res.json()) as {
      session: {
        deadlineAt?: string;
        checkpoint?: { currentIndex: number };
        sectionState?: { currentSectionIndex: number; phase: string; sections: { deadlineAt?: string }[] };
      };
    };
    assert.equal(start1.session.sectionState?.phase, 'active');
    assert.equal(start1.session.sectionState?.currentSectionIndex, 1);
    assert.equal(start1.session.checkpoint?.currentIndex, 1);
    assert.ok(start1.session.deadlineAt);

    // 6. Simulate MATH section expiring past grace -> GET auto-advances into THINK break (NOT submit)
    const expiredAt = new Date(Date.now() - 20_000).toISOString();
    await srv.repo.updateSessionProgressState(sid, studentId, (s) => {
      s.deadlineAt = expiredAt;
      if (s.sectionState) s.sectionState.sections[1].deadlineAt = expiredAt;
    });
    const afterExpRes = await fetch(`${srv.baseUrl}/api/student/sessions/${sid}`, {
      headers: { Cookie: studentCookie },
    });
    assert.equal(afterExpRes.status, 200);
    const afterExp = (await afterExpRes.json()) as {
      session: {
        status: string;
        checkpointRevision?: number;
        sectionState?: {
          currentSectionIndex: number;
          phase: string;
          sections: { status: string; elapsedSec: number; expiredAutoAdvanced?: boolean }[];
        };
      };
    };
    assert.equal(afterExp.session.status, 'in_progress');
    assert.equal(afterExp.session.sectionState?.phase, 'on_break');
    assert.equal(afterExp.session.sectionState?.currentSectionIndex, 2);
    assert.equal(afterExp.session.sectionState?.sections[1].status, 'completed');
    assert.equal(afterExp.session.sectionState?.sections[1].elapsedSec, 2400);
    assert.equal(afterExp.session.sectionState?.sections[1].expiredAutoAdvanced, true);

    // 7. Start THINK (2), complete THINK -> break for WRIT (3), start WRIT (3), complete WRIT -> submitted
    const start2 = (await (
      await fetch(`${srv.baseUrl}/api/student/sessions/${sid}/section/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: studentCookie },
        body: JSON.stringify({ expectedRevision: afterExp.session.checkpointRevision }),
      })
    ).json()) as { session: { checkpointRevision?: number; checkpoint?: Record<string, unknown> } };

    const thinkPart = holdoutQuestions[2].parts[0];
    const comp2 = (await (
      await fetch(`${srv.baseUrl}/api/student/sessions/${sid}/section/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: studentCookie },
        body: JSON.stringify({
          expectedRevision: start2.session.checkpointRevision,
          checkpoint: {
            currentIndex: 2,
            elapsedSec: 30,
            answersByPartId: { [thinkPart.partId]: thinkPart.correctAnswerKey },
            flaggedQuestionIds: [],
          },
        }),
      })
    ).json()) as { finishedExam: boolean; session: { checkpointRevision?: number } };
    assert.equal(comp2.finishedExam, false);

    const start3 = (await (
      await fetch(`${srv.baseUrl}/api/student/sessions/${sid}/section/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: studentCookie },
        body: JSON.stringify({ expectedRevision: comp2.session.checkpointRevision }),
      })
    ).json()) as { session: { checkpointRevision?: number } };

    const writQid = holdoutQuestions[3].questionId;
    const comp3Res = await fetch(`${srv.baseUrl}/api/student/sessions/${sid}/section/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: studentCookie },
      body: JSON.stringify({
        expectedRevision: start3.session.checkpointRevision,
        checkpoint: {
          currentIndex: 3,
          elapsedSec: 60,
          answersByPartId: {},
          flaggedQuestionIds: [],
          writingDraft: { planNotes: 'Outline', responseText: 'My selective essay draft response.' },
          writingDraftsByQuestionId: {
            [writQid]: { planNotes: 'Outline', responseText: 'My selective essay draft response.' },
          },
        },
      }),
    });
    assert.equal(comp3Res.status, 200);
    const comp3 = (await comp3Res.json()) as {
      finishedExam: boolean;
      correctSlots: number;
      session: { status: string };
    };
    assert.equal(comp3.finishedExam, true);
    assert.equal(comp3.session.status, 'submitted');
    assert.equal(comp3.correctSlots, 2); // READ + THINK answered correctly, MATH expired unanswered

    // 8. Progress API returns the persisted official BenchmarkReportRecord
    const progAfterRes = await fetch(`${srv.baseUrl}/api/student/progress`, {
      headers: { Cookie: studentCookie },
    });
    assert.equal(progAfterRes.status, 200);
    const progAfter = (await progAfterRes.json()) as {
      benchmarkReports: { sessionId: string; sections: Record<SectionCode, { correct: number; total: number }> }[];
    };
    assert.equal(progAfter.benchmarkReports.length, 1);
    assert.equal(progAfter.benchmarkReports[0].sessionId, sid);
    assert.equal(progAfter.benchmarkReports[0].sections.READ.correct, 1);
    assert.equal(progAfter.benchmarkReports[0].sections.MATH.correct, 0);
    assert.equal(progAfter.benchmarkReports[0].sections.THINK.correct, 1);
  } finally {
    await srv.close();
  }
});

test('Solo admin fallback: /api/admin/learners defaults to admin when no students exist, then prioritizes students once signed in', async () => {
  const srv = await startTestServer();
  const soloAdminId = 'google_solo_admin';
  const soloAdminCookie = signedCookie('solo_admin', 'admin');
  const studentCookie = signedCookie('first_student', 'student');
  try {
    await srv.repo.upsertUserFromAuth({
      uid: soloAdminId,
      email: 'bowenzou0@gmail.com',
      displayName: 'Bowen Admin',
      isBootstrappedAdmin: true,
    });

    const learners1 = (await (
      await fetch(`${srv.baseUrl}/api/admin/learners`, { headers: { Cookie: soloAdminCookie } })
    ).json()) as { defaultMonitoredStudentId: string | null };
    assert.equal(learners1.defaultMonitoredStudentId, soloAdminId);

    const bank1 = (await (
      await fetch(`${srv.baseUrl}/api/admin/questions?pageSize=5`, {
        headers: { Cookie: soloAdminCookie },
      })
    ).json()) as { monitoredStudentId: string | null };
    assert.equal(bank1.monitoredStudentId, soloAdminId);

    // Once a student signs in, default monitoring automatically shifts to the student
    await srv.repo.upsertUserFromAuth({
      uid: 'google_first_student',
      email: 'first_student@gmail.com',
      displayName: 'First Student',
      isBootstrappedAdmin: false,
    });
    await fetch(`${srv.baseUrl}/api/student/dashboard`, { headers: { Cookie: studentCookie } });
    const learners2 = (await (
      await fetch(`${srv.baseUrl}/api/admin/learners`, { headers: { Cookie: soloAdminCookie } })
    ).json()) as { defaultMonitoredStudentId: string | null };
    assert.equal(learners2.defaultMonitoredStudentId, 'google_first_student');
  } finally {
    await srv.close();
  }
});

test('Public settings, per-learner daily plan isolation, admin override lock, own flags, onboarding, calibration, and account deletion', async () => {
  const srv = await startTestServer();
  const aliceId = 'google_alice_settings';
  const bobId = 'google_bob_settings';
  const aliceCookie = signedCookie('alice_settings', 'student');
  const bobCookie = signedCookie('bob_settings', 'student');
  const adminCookie = signedCookie('admin_settings', 'admin');
  try {
    await srv.repo.upsertUserFromAuth({
      uid: aliceId,
      email: 'alice@example.com',
      displayName: 'Alice',
      isBootstrappedAdmin: false,
    });
    await srv.repo.upsertUserFromAuth({
      uid: bobId,
      email: 'bob@example.com',
      displayName: 'Bob',
      isBootstrappedAdmin: false,
    });

    // 1. Fresh account dashboard triggers onboarding until dismissed
    const dashNewRes = await fetch(`${srv.baseUrl}/api/student/dashboard`, {
      headers: { Cookie: aliceCookie },
    });
    assert.equal(dashNewRes.status, 200);
    const dashNew = (await dashNewRes.json()) as {
      shouldShowOnboarding: boolean;
      onboardingCompleted: boolean;
      dailyLimits: Record<string, number>;
    };
    assert.equal(dashNew.shouldShowOnboarding, true);
    assert.equal(dashNew.onboardingCompleted, false);

    const onboardRes = await fetch(`${srv.baseUrl}/api/student/settings/onboarding`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: aliceCookie },
      body: JSON.stringify({ completed: true }),
    });
    assert.equal(onboardRes.status, 200);
    const dashAfterOnboard = (await (
      await fetch(`${srv.baseUrl}/api/student/dashboard`, { headers: { Cookie: aliceCookie } })
    ).json()) as { shouldShowOnboarding: boolean; onboardingCompleted: boolean };
    assert.equal(dashAfterOnboard.onboardingCompleted, true);
    assert.equal(dashAfterOnboard.shouldShowOnboarding, false);

    // 2. Alice switches her personal daily plan to manual counts; Bob stays on platform defaults
    const saveAliceRes = await fetch(`${srv.baseUrl}/api/student/settings/daily-plan`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: aliceCookie },
      body: JSON.stringify({
        autoCalibrate: { enabled: false, minDailyQuestions: 6, maxDailyQuestions: 14, includeWriting: false },
        dailyQuestionLimitBySection: { READ: 1, MATH: 4, THINK: 2, WRIT: 0 },
        dailyGoalMinutes: 35,
        sectionDrillQuestionCount: 15,
        sectionDrillTimeMinutes: 12,
      }),
    });
    assert.equal(saveAliceRes.status, 200);

    const aliceDash = (await (
      await fetch(`${srv.baseUrl}/api/student/dashboard`, { headers: { Cookie: aliceCookie } })
    ).json()) as {
      autoCalibrateEnabled: boolean;
      dailyLimits: Record<string, number>;
      dailyGoalMinutes: number;
      sectionDrillQuestionCount: number;
    };
    assert.equal(aliceDash.autoCalibrateEnabled, false);
    assert.equal(aliceDash.dailyLimits.MATH, 4);
    assert.equal(aliceDash.dailyGoalMinutes, 35);
    assert.equal(aliceDash.sectionDrillQuestionCount, 15);

    const bobSettings = (await (
      await fetch(`${srv.baseUrl}/api/student/settings`, { headers: { Cookie: bobCookie } })
    ).json()) as {
      effectiveConfig: { autoCalibrate: { enabled: boolean }; dailyGoalMinutes: number };
    };
    assert.equal(bobSettings.effectiveConfig.autoCalibrate.enabled, true);
    assert.equal(bobSettings.effectiveConfig.dailyGoalMinutes, 30);

    // 3. Admin overrides and locks Alice's daily plan -> Alice receives 403 when attempting to modify
    const adminOverrideRes = await fetch(
      `${srv.baseUrl}/api/admin/learners/${encodeURIComponent(aliceId)}/preferences`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({
          autoCalibrate: { enabled: false, minDailyQuestions: 6, maxDailyQuestions: 14, includeWriting: false },
          dailyQuestionLimitBySection: { READ: 2, MATH: 2, THINK: 2, WRIT: 0 },
          dailyGoalMinutes: 20,
          adminOverrideLocked: true,
        }),
      }
    );
    assert.equal(adminOverrideRes.status, 200);

    const lockedAttemptRes = await fetch(`${srv.baseUrl}/api/student/settings/daily-plan`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: aliceCookie },
      body: JSON.stringify({ dailyGoalMinutes: 60 }),
    });
    assert.equal(lockedAttemptRes.status, 403);

    // Admin unlocks back to platform defaults
    const adminUnlockRes = await fetch(
      `${srv.baseUrl}/api/admin/learners/${encodeURIComponent(aliceId)}/preferences`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ resetToDefaults: true }),
      }
    );
    assert.equal(adminUnlockRes.status, 200);

    // 4. Question flags are strictly isolated per learner in /api/student/flags
    const allQs = await srv.repo.listQuestions({ qcStatus: 'active' });
    const q1 = allQs[0].questionId;
    await fetch(`${srv.baseUrl}/api/student/flags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: aliceCookie },
      body: JSON.stringify({ questionId: q1, sessionId: 'sess_a', reason: 'Typo in prompt' }),
    });
    await fetch(`${srv.baseUrl}/api/student/flags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: bobCookie },
      body: JSON.stringify({ questionId: q1, sessionId: 'sess_b', reason: 'Unclear diagram' }),
    });

    const aliceFlags = (await (
      await fetch(`${srv.baseUrl}/api/student/flags`, { headers: { Cookie: aliceCookie } })
    ).json()) as { flags: { reason: string }[] };
    assert.equal(aliceFlags.flags.length, 1);
    assert.equal(aliceFlags.flags[0].reason, 'Typo in prompt');

    // 5. Starter Calibration Test (mode: diagnostic) launches cleanly
    const calRes = await fetch(`${srv.baseUrl}/api/student/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: aliceCookie },
      body: JSON.stringify({ mode: 'diagnostic' }),
    });
    assert.equal(calRes.status, 201);
    const calData = (await calRes.json()) as { session: { mode: string; title: string; plannedQuestionIds: string[] } };
    assert.equal(calData.session.mode, 'diagnostic');
    assert.equal(calData.session.title, 'Starter Calibration Test');
    assert.ok(calData.session.plannedQuestionIds.length > 0);

    // 6. Own study progress reset requires RESET confirmation and clears only caller's data
    const badResetRes = await fetch(`${srv.baseUrl}/api/student/study-progress/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: aliceCookie },
      body: JSON.stringify({ confirmation: 'NOPE' }),
    });
    assert.equal(badResetRes.status, 400);

    const okResetRes = await fetch(`${srv.baseUrl}/api/student/study-progress/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: aliceCookie },
      body: JSON.stringify({ confirmation: 'RESET' }),
    });
    assert.equal(okResetRes.status, 200);
    const okReset = (await okResetRes.json()) as { clearedSessions: number; preservedQuestionsCount: number };
    assert.equal(okReset.clearedSessions, 1);
    assert.ok(okReset.preservedQuestionsCount > 0);

    // 7. Account deletion requires DELETE, clears user + flags + preferences, clears cookie, preserves bank & Bob
    const badDelRes = await fetch(`${srv.baseUrl}/api/student/account`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: aliceCookie },
      body: JSON.stringify({ confirmation: 'WRONG' }),
    });
    assert.equal(badDelRes.status, 400);

    const delRes = await fetch(`${srv.baseUrl}/api/student/account`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: aliceCookie },
      body: JSON.stringify({ confirmation: 'DELETE' }),
    });
    assert.equal(delRes.status, 200);
    const delData = (await delRes.json()) as {
      ok: boolean;
      deletedUser: boolean;
      clearedFlags: number;
      preservedQuestionsCount: number;
    };
    assert.equal(delData.ok, true);
    assert.equal(delData.deletedUser, true);
    assert.equal(delData.clearedFlags, 1);
    assert.ok(delData.preservedQuestionsCount > 0);

    const setCookieHeader = delRes.headers.get('set-cookie') || '';
    assert.ok(setCookieHeader.includes('Max-Age=0') || setCookieHeader.includes('Expires=Thu, 01 Jan 1970'));

    // Bob's account and flag remain completely intact
    const remainingUsers = await srv.repo.listUsers();
    assert.equal(remainingUsers.some((u) => u.uid === aliceId), false);
    assert.equal(remainingUsers.some((u) => u.uid === bobId), true);
    const bobFlagsAfter = await srv.repo.listQuestionFlags(bobId);
    assert.equal(bobFlagsAfter.length, 1);

    // 8. Admin can delete any other learner account via DELETE /api/admin/learners/:studentId
    await fetch(`${srv.baseUrl}/api/admin/learners/primary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ studentId: bobId }),
    });
    const studentCannotDel = await fetch(`${srv.baseUrl}/api/admin/learners/${encodeURIComponent(bobId)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: bobCookie },
      body: JSON.stringify({ confirmation: 'DELETE' }),
    });
    assert.equal(studentCannotDel.status, 403);

    const adminSelfDelBlocked = await fetch(
      `${srv.baseUrl}/api/admin/learners/${encodeURIComponent('google_admin_settings')}`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ confirmation: 'DELETE' }),
      }
    );
    assert.equal(adminSelfDelBlocked.status, 400);

    const adminDelBob = await fetch(`${srv.baseUrl}/api/admin/learners/${encodeURIComponent(bobId)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ confirmation: 'DELETE' }),
    });
    assert.equal(adminDelBob.status, 200);
    const afterAdminDelUsers = await srv.repo.listUsers();
    assert.equal(afterAdminDelUsers.some((u) => u.uid === bobId), false);
    const cfgAfterDel = await srv.repo.getActiveConfig();
    assert.equal(cfgAfterDel.config.primaryMonitoredStudentId, undefined);
  } finally {
    await srv.close();
  }
});
