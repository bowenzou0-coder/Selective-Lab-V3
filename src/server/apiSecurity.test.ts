import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { LoginTicket, OAuth2Client, type TokenPayload } from 'google-auth-library';
import { createApp } from '../../server.ts';
import type { BankImportManifest, LearningConfig, SectionCode } from '../shared/contracts.ts';
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
    delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.FIRESTORE_EMULATOR_HOST;
    delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
    delete process.env.FIREBASE_STORAGE_EMULATOR_HOST;
    delete process.env.K_SERVICE;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GCLOUD_PROJECT;
    delete process.env.USE_FIRESTORE;
    delete process.env.USE_FIRESTORE_DB;
    delete process.env.FIREBASE_USE_ADC;
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
    const qInMem = (await srv.repo.getQuestionWithStimulus('q_snap_test_v1'))!;
    qInMem.question.parts[0].correctAnswerKey = 'B';

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
    assert.ok(holdoutMath.length > 0 && pt3Math.length > 0, 'Expected holdout and PT3 maths items in seeded bank');
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
  } finally {
    await srv.close();
  }
});
