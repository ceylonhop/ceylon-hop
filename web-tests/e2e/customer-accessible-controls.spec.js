import { test, expect } from '@playwright/test';
import { blockLiveApi, gotoBooking } from './_stubs.js';

test.use({ viewport: { width: 390, height: 844 } });
test.beforeEach(async ({ page }) => { await blockLiveApi(page); });

test('booking extra is a keyboard-operable toggle with an exposed selected state', async ({ page }) => {
  await gotoBooking(page);
  await page.evaluate(() => window.goStep(3));

  const extra = page.locator('button.addon[data-addon="sightseeing"]');
  await expect(extra).toBeVisible();
  await expect(extra).toHaveAttribute('aria-pressed', 'false');

  const box = await extra.boundingBox();
  expect(box).toBeTruthy();
  expect(box.height).toBeGreaterThanOrEqual(44);

  await extra.focus();
  await page.keyboard.press('Enter');
  await expect(extra).toHaveAttribute('aria-pressed', 'true');
  await expect(extra).toHaveClass(/\bon\b/);

  await page.keyboard.press('Space');
  await expect(extra).toHaveAttribute('aria-pressed', 'false');
  await expect(extra).not.toHaveClass(/\bon\b/);
});

test('About FAQ uses disclosure buttons with keyboard and screen-reader state', async ({ page }) => {
  await page.goto('/about.html');

  const question = page.locator('#faq button.faq-q').first();
  await expect(question).toBeVisible();
  await expect(question).toHaveAttribute('aria-expanded', 'false');

  const answerId = await question.getAttribute('aria-controls');
  expect(answerId).toBeTruthy();
  const answer = page.locator(`#${answerId}`);
  await expect(answer).toBeHidden();

  const box = await question.boundingBox();
  expect(box).toBeTruthy();
  expect(box.height).toBeGreaterThanOrEqual(44);

  await question.focus();
  await page.keyboard.press('Enter');
  await expect(question).toHaveAttribute('aria-expanded', 'true');
  await expect(answer).toBeVisible();

  await page.keyboard.press('Space');
  await expect(question).toHaveAttribute('aria-expanded', 'false');
  await expect(answer).toBeHidden();
});
