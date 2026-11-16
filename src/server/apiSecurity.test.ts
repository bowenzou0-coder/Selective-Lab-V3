import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createApp } from '../../server.ts';
import type { BankImportManifest } from '../shared/contracts.ts';
import { signSessionToken } from './auth.ts';
import { createRepository } from './storage/index.ts';
import { MemoryRepository } from './storage/memoryRepository.ts';

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
    const studentAToken = signSessionToken({ role: 'student', studentId: 'uid_student_A', authMethod: 'firebase' });
    const studentBToken = signSessionToken({ role: 'student', studentId: 'uid_student_B', authMethod: 'firebase' });
    const adminToken = signSessionToken({ role: 'admin', studentId: 'uid_admin', authMethod: 'firebase' });

    // 1. Unauthenticated requests rejected cleanly with 401
    const unauthStudent = await fetch(`${srv.baseUrl}/api/student/dashboard`);
    assert.equal(unauthStudent.status, 401);

    const unauthAdmin = await fetch(`${srv.baseUrl}/api/admin/status`);
    assert.equal(unauthAdmin.status, 401);

    // 2. Student cannot access Admin endpoints (403)
    const studentAdmin = await fetch(`${srv.baseUrl}/api/admin/status`, {
      headers: { Authorization: `Bearer ${studentAToken}` },
    });
    assert.equal(studentAdmin.status, 403);

    // 3. /api/sync/hydrate returns 410 Gone
    const hydrateRes = await fetch(`${srv.baseUrl}/api/sync/hydrate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${studentAToken}`,
      },
      body: JSON.stringify({}),
    });
    assert.equal(hydrateRes.status, 410);

    // 4. Student A creates session -> pre-submission GET strips all answer keys/rationales/evidenceRefs/isDecoy
    const createRes = await fetch(`${srv.baseUrl}/api/student/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${studentAToken}`,
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
        Authorization: `Bearer ${studentAToken}`,
      },
      body: JSON.stringify({ mode: 'section_drill', sectionFilter: 'MATH' }),
    });
    assert.equal(secondCreate.status, 409);

    const getA = await fetch(`${srv.baseUrl}/api/student/sessions/${sessionId}`, {
      headers: { Authorization: `Bearer ${studentAToken}` },
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
      headers: { Authorization: `Bearer ${studentBToken}` },
    });
    assert.equal(crossGet.status, 403);

    const crossPatch = await fetch(`${srv.baseUrl}/api/student/sessions/${sessionId}/checkpoint`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${studentBToken}`,
      },
      body: JSON.stringify({ checkpoint: { currentIndex: 0, elapsedSec: 1, answersByPartId: {}, flaggedQuestionIds: [] } }),
    });
    assert.equal(crossPatch.status, 403);

    const crossSubmit = await fetch(`${srv.baseUrl}/api/student/sessions/${sessionId}/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${studentBToken}`,
      },
      body: JSON.stringify({}),
    });
    assert.equal(crossSubmit.status, 403);

    // Admin token also works cleanly
    const adminOk = await fetch(`${srv.baseUrl}/api/admin/status`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(adminOk.status, 200);
  } finally {
    await srv.close();
  }
});

test('Checkpoint concurrency (409), idempotent submit, snapshot immutability on bank edits, and calibration sandbox isolation', async () => {
  const srv = await startTestServer();
  try {
    const studentToken = signSessionToken({ role: 'student', studentId: 'uid_snapshot_user', authMethod: 'firebase' });
    const adminToken = signSessionToken({ role: 'admin', studentId: 'uid_admin_user', authMethod: 'firebase' });

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
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ manifest: customManifest }),
    });
    assert.equal(imp1.status, 200);

    // 1. Unknown questionIds rejected cleanly (400)
    const badCal = await fetch(`${srv.baseUrl}/api/admin/calibration/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ questionIds: ['does_not_exist_999'], isSandbox: true }),
    });
    assert.equal(badCal.status, 400);

    // 2. Calibration sandbox session preserves exact question order & does not alter mastery
    const calRes = await fetch(`${srv.baseUrl}/api/admin/calibration/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
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
        Authorization: `Bearer ${adminToken}`,
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
    const adminEvidenceAfterSandbox = await srv.repo.getQuestionEvidence('uid_admin_user');
    assert.equal(Object.keys(adminEvidenceAfterSandbox).length, 0);

    // 3. Create normal student session (snapshot captures v1 answer 'A')
    const sRes = await fetch(`${srv.baseUrl}/api/student/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${studentToken}`,
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
        studentId: 'uid_snapshot_user',
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
        Authorization: `Bearer ${studentToken}`,
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
        Authorization: `Bearer ${studentToken}`,
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
          Authorization: `Bearer ${studentToken}`,
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
          Authorization: `Bearer ${studentToken}`,
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
    const studentAttempts = await srv.repo.listPartAttempts(100, 'uid_snapshot_user');
    assert.equal(studentAttempts.length, 1);
    assert.equal(studentAttempts[0].isCorrect, true);

    const evidenceMap = await srv.repo.getQuestionEvidence('uid_snapshot_user');
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
    const studentToken = signSessionToken({
      role: 'student',
      studentId: 'uid_lock_tester',
      authMethod: 'firebase',
    });
    const adminToken = signSessionToken({
      role: 'admin',
      studentId: 'uid_admin_diag',
      authMethod: 'firebase',
    });

    // 1. Concurrent session creation for same user: strictly 1 succeeds (201), 1 conflicts (409)
    const [r1, r2] = await Promise.all([
      fetch(`${srv.baseUrl}/api/student/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${studentToken}`,
        },
        body: JSON.stringify({ mode: 'section_drill', sectionFilter: 'MATH' }),
      }),
      fetch(`${srv.baseUrl}/api/student/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${studentToken}`,
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
        Authorization: `Bearer ${studentToken}`,
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
        studentId: 'uid_lock_tester',
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
        Authorization: `Bearer ${studentToken}`,
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
      headers: { Authorization: `Bearer ${studentToken}` },
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

    // 4. Dashboard returns cached dailyFocusPlan (calling twice hits saved plan without changing timestamp)
    const dash1 = await fetch(`${srv.baseUrl}/api/student/dashboard`, {
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    assert.equal(dash1.status, 200);
    const d1 = (await dash1.json()) as { dailyFocusPlan?: { planDate: string; generatedAtIso: string; focusSkillIds: string[] } };
    assert.ok(d1.dailyFocusPlan && d1.dailyFocusPlan.focusSkillIds.length > 0);

    const dash2 = await fetch(`${srv.baseUrl}/api/student/dashboard`, {
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    const d2 = (await dash2.json()) as { dailyFocusPlan?: { planDate: string; generatedAtIso: string } };
    assert.equal(d2.dailyFocusPlan?.generatedAtIso, d1.dailyFocusPlan?.generatedAtIso);

    // 5. Admin diagnostics strictly redacts actual secrets
    process.env.GEMINI_API_KEY = 'gemini-secret-value-must-never-leak';
    const diagRes = await fetch(`${srv.baseUrl}/api/admin/diagnostics`, {
      headers: { Authorization: `Bearer ${adminToken}` },
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
    assert.equal(diagJson.geminiModel, 'gemini-4-hydrogen');
    assert.equal(diagJson.configSource, 'firebase-applet-config.json');
  } finally {
    process.env = prevEnv;
    await srv.close();
  }
});
