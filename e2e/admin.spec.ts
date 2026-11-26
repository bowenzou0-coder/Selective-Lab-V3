import { expect, test } from '@playwright/test';
import { openLearnerSettings, seedLearners } from './demo';

test('Admin searches learners, pins one, deletes another and locks the student’s plan', async ({ page, request, browser, baseURL }) => {
  await seedLearners(request, { 'google_qa-focus': 'Focus Learner', 'qa-remove': 'Remove Learner' });
  await page.goto('/admin');
  await page.getByPlaceholder('Enter admin password').fill('admin-dev');
  await page.getByRole('button', { name: 'Open admin console' }).click();
  const scope = page.getByRole('region', { name: 'Learner in view' });
  await scope.getByRole('searchbox').fill('google_qa-focus');
  await scope.getByRole('button', { name: /Focus Learner.*qa-focus/ }).click();
  await page.getByRole('button', { name: 'Learners', exact: true }).click();
  const focus = page.getByRole('row').filter({ hasText: 'Focus Learner' });
  await focus.getByRole('button', { name: 'Set primary' }).click();
  await expect(focus.getByRole('button', { name: 'Primary' })).toHaveAttribute('aria-pressed', 'true');
  const remove = page.getByRole('row').filter({ hasText: 'Remove Learner' });
  await remove.getByRole('button', { name: 'Delete Remove Learner' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByPlaceholder('Type DELETE').fill('DELETE');
  await dialog.getByRole('button', { name: 'Delete account' }).click();
  await expect(remove).toHaveCount(0);
  await expect(focus).toBeVisible();
  await page.getByRole('button', { name: 'Daily & Adaptive' }).click();
  const field = page.locator('#ov-min-q');
  await field.fill('17');
  await page.getByRole('checkbox', { name: /Lock settings/ }).check();
  await page.getByRole('button', { name: 'Save learner override' }).click();
  await expect(page.getByRole('button', { name: 'Save learner override' })).toBeHidden();
  const student = await browser.newContext({ baseURL });
  try {
    const settings = await student.newPage();
    await openLearnerSettings(settings, 'google_qa-focus', baseURL!);
    await expect(settings.getByText('Managed by parent or tutor')).toBeVisible();
    const count = settings.getByLabel('Min questions / day', { exact: true });
    await expect(count).toBeDisabled();
    await expect(count).toHaveValue('17');
  } finally {
    await student.close();
    await expect(await request.delete('/api/admin/learners/google_qa-focus', {
      data: { confirmation: 'DELETE' },
    })).toBeOK();
  }
});
