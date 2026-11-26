import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { AUTH_COOKIE_NAME, signSessionToken } from '../src/server/auth.ts';
import { MemoryRepository } from '../src/server/storage/memoryRepository.ts';

export async function studentLogin(page: Page) {
  await page.goto('/');
  await page.getByPlaceholder('Enter PIN (default: 1234)').fill('1234');
  await page.getByRole('button', { name: 'Continue with student PIN' }).click();
}

export async function clearPinStudent(request: APIRequestContext) {
  await expect(await request.post('/api/auth/student-login', { data: { pin: '1234' } })).toBeOK();
  await expect(await request.delete('/api/student/account', { data: { confirmation: 'DELETE' } })).toBeOK();
}

// Seed real rows through the admin restore route. Each test owns its learner IDs.
export async function seedLearners(request: APIRequestContext, learners: Record<string, string>, withSession = false) {
  await expect(await request.post('/api/auth/admin-login', { data: { password: 'admin-dev' } })).toBeOK();
  const repo = new MemoryRepository();
  for (const [uid, displayName] of Object.entries(learners)) {
    await repo.upsertUserFromAuth({ uid, email: uid + '@example.test', displayName, isBootstrappedAdmin: false });
    await repo.saveLearnerPreferences(uid, { onboardingCompletedAtIso: '2026-01-01T00:00:00Z' });
    if (withSession) {
      await repo.createSession({
        studentId: uid, sessionId: 'completed-' + uid, mode: 'section_drill', status: 'submitted',
        startedAt: '2026-01-01T01:00:00Z', completedAt: '2026-01-01T01:15:00Z',
        plannedQuestionIds: [], correctSlots: 0, totalSlots: 0, configVersionId: 'cfg_v1',
      });
    }
  }
  const response = await request.post('/api/admin/restore', {
    data: { backup: await repo.exportFullBackup(), dryRun: false },
  });
  await expect(response).toBeOK();
  expect((await response.json()).report.valid).toBe(true);
}

// Start after external identity verification, using only the current demo server's ephemeral key.
export async function openLearnerSettings(page: Page, studentId: string, baseURL: string) {
  const key = process.env.E2E_SESSION_SECRET;
  if (!key) throw new Error('Missing E2E session key');
  const value = signSessionToken({
    role: 'student', authMethod: 'google', studentId,
    googleSub: studentId.slice('google_'.length), email: studentId + '@example.test',
  }, 300_000, key);
  await page.context().addCookies([{ name: AUTH_COOKIE_NAME, value, url: baseURL, httpOnly: true }]);
  await page.goto('/settings');
}
