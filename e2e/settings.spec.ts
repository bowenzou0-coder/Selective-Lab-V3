import { expect, test, type Page } from '@playwright/test';
import { clearPinStudent, openLearnerSettings, seedLearners, studentLogin } from './demo';

async function confirmDelete(page: Page) {
  await page.getByRole('button', { name: 'Delete my account' }).click();
  const dialog = page.getByRole('dialog');
  const confirm = dialog.getByRole('button', { name: 'Permanently delete account' });
  await expect(confirm).toBeDisabled();
  await dialog.getByRole('textbox', { name: 'Type DELETE' }).fill('DELETE');
  const response = page.waitForResponse(r => r.request().method() === 'DELETE' && r.url().endsWith('/api/student/account'));
  await confirm.click();
  const deletion = await response;
  expect(deletion.ok()).toBe(true);
  await expect(page.getByRole('button', { name: 'Continue with student PIN' })).toBeVisible();
  return deletion.json();
}

test('PIN student saves clamped settings, recalibrates, resets study data and signs in fresh', async ({ page, request }) => {
  await clearPinStudent(request);
  await seedLearners(request, { 'default-student': 'PIN learner' }, true);
  await studentLogin(page);
  await expect(page.getByRole('button', { name: 'Continue with student PIN' })).toBeHidden();
  await page.goto('/settings');
  const count = page.getByLabel('Min questions / day', { exact: true });
  await count.fill('999');
  await expect(count).toHaveValue('30');
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  await count.fill('1');
  await count.blur();
  await expect(count).toHaveValue('3');
  await page.getByRole('button', { name: 'Save daily plan' }).click();
  await expect(page.getByText('Unsaved changes')).toBeHidden();
  await page.reload();
  await expect(count).toHaveValue('3');
  const recalibrate = page.waitForResponse(r => r.url().endsWith('/settings/recalibrate'));
  await page.getByRole('button', { name: 'Recalibrate now' }).click();
  expect((await (await recalibrate).json()).plan.source).toBe('deterministic');
  await expect(page.getByText('Updated today’s daily mix.')).toBeVisible();
  await page.getByRole('button', { name: 'Reset my study progress' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByPlaceholder('Type RESET').fill('RESET');
  const reset = page.waitForResponse(r => r.url().endsWith('/study-progress/reset'));
  await dialog.getByRole('button', { name: 'Confirm reset to zero' }).click();
  expect((await (await reset).json()).clearedSessions).toBe(1);
  await expect(page.getByText('Cleared your sessions, attempts, mastery records, and writing submissions.')).toBeVisible();
  await expect(page.getByText(/You are signed in with the local preview PIN/)).toBeVisible();
  expect(await confirmDelete(page)).toMatchObject({ ok: true, isLocalPinAccount: true });
  await studentLogin(page);
  await expect(page.getByRole('dialog', { name: 'Welcome to Selective Lab' })).toBeVisible();
  const settings = await (await page.request.get('/api/student/settings')).json();
  expect(settings.preferences).toBeNull();
  expect(settings.progressCounts.sessionsCount).toBe(0);
});

test('A registered learner can permanently delete their account in Settings', async ({ page, request, baseURL }) => {
  const studentId = 'google_qa-self-delete';
  await seedLearners(request, { [studentId]: 'Self Delete' }, true);
  await openLearnerSettings(page, studentId, baseURL!);
  await expect(page.getByRole('button', { name: 'Delete my account' })).toBeVisible();
  await expect(page.getByText(/signed in with the local preview PIN/)).toHaveCount(0);
  expect(await confirmDelete(page)).toMatchObject({ deletedUser: true, clearedSessions: 1, isLocalPinAccount: false });
  const roster = await (await request.get('/api/admin/learners')).json();
  expect(roster.learners.map((user: { uid: string }) => user.uid)).not.toContain(studentId);
});
