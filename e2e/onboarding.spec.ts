import { expect, test } from '@playwright/test';
import { clearPinStudent, studentLogin } from './demo';

test('PIN student tours all four tabs, completes calibration and reads worked explanations', async ({ page, request }) => {
  await clearPinStudent(request);
  await studentLogin(page);
  const tour = page.getByRole('dialog');
  const steps = [
    ['/', 'Welcome to Selective Lab', 'Start walkthrough'],
    ['/', 'Dashboard — your daily home', 'Next'],
    ['/benchmarks', 'Official benchmarks', 'Next'],
    ['/progress', 'Progress & mastery', 'Next'],
    ['/settings', 'Settings — make it yours', 'Next'],
    ['/', 'Ready to calibrate your study plan?', 'Start calibration test'],
  ];
  for (const [path, title, next] of steps) {
    await expect(page).toHaveURL(url => url.pathname === path);
    await expect(tour).toHaveAccessibleName(title);
    await expect(tour).toBeVisible();
    await expect(tour).toBeInViewport({ ratio: 1 });
    await tour.getByRole('button', { name: next, exact: true }).click();
  }
  await expect(page).toHaveURL(/\/session\//);
  // Diagnostic selection orders the starter questions. Follow the rendered order.
  for (let i = 1; i <= 2; i++) {
    await expect(page.getByText(`Question ${i} of 2`, { exact: true }).first()).toBeVisible();
    const math = page.getByRole('button', { name: /24 cm²/ });
    const gap = page.getByRole('button', { name: 'Place in Gap 1' });
    await expect(math.or(gap).first()).toBeVisible();
    if (await math.isVisible()) {
      await math.click();
    } else {
      await gap.first().click(); // Extract A
      await page.getByRole('button', { name: 'Gap 2', exact: true }).last().click();
      await page.getByRole('button', { name: 'Place in Gap 2' }).first().click(); // Extract B
    }
    if (i === 1) await page.getByRole('button', { name: 'Next', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Finish test', exact: true }).first().click();
  await page.getByRole('button', { name: 'Confirm and submit' }).click();
  await expect(page.getByText('3 / 3', { exact: true })).toBeVisible();
  for (const n of [1, 2]) {
    await page.getByRole('button', { name: `Review item ${n} Correct` }).click();
    await expect(page.getByText(/^Worked Explanation/).first()).toBeVisible();
    await expect(page.getByText(/directly elaborates on the speed|Therefore the answer is B/).first()).toBeVisible();
  }
});
