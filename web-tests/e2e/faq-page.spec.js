// The travel FAQ in a real browser, offline (spec 2026-10-14-sri-lanka-travel-faq-design.md §9, §12).
import { test, expect } from '@playwright/test';
import { blockLiveApi } from './_stubs.js';

const URL = '/sri-lanka-travel-faq/';

test.beforeEach(async ({ page }) => { await blockLiveApi(page); });

test('renders with the site chrome, the first answer open and nothing else', async ({ page }) => {
  await page.goto(URL);
  await expect(page).toHaveTitle(/Sri Lanka travel FAQ/);
  await expect(page.locator('h1')).toHaveText('Sri Lanka travel FAQ');
  await expect(page.locator('header.nav a', { hasText: 'Routes & prices' })).toHaveAttribute('href', '../trip/');
  await expect(page.locator('details[open]')).toHaveCount(1);
  await expect(page.locator('details#visa-how-to-get')).toHaveAttribute('open', '');
  await expect(page.locator('footer .pill-saffron')).toBeVisible();
  // Offline the batch endpoint 404s, so the catalogue fare stays — and the pending hold is released by its timer.
  await page.locator('details#money-daily-budget summary').click();
  const fare = page.locator('#money-daily-budget [data-list-fare]').first();
  await expect(fare).toHaveText(/^\$\d/);
  await expect(fare).toBeVisible();
  await expect.poll(() => fare.evaluate(el => getComputedStyle(el).color), { timeout: 6000 }).not.toBe('rgba(0, 0, 0, 0)');
});

test('an index entry scrolls to its topic; a closed question opens on click', async ({ page }) => {
  await page.goto(URL);
  await page.locator('#topics a[href="#money"]').click();
  await expect.poll(() => page.locator('#money').evaluate(el => el.getBoundingClientRect().top)).toBeLessThan(200);
  const q = page.locator('details#money-tipping');
  await q.locator('summary').click();
  await expect(q).toHaveAttribute('open', '');
  await expect(q.locator('.ans')).toContainText('Not mandatory');
});

test('a deep link opens that question', async ({ page }) => {
  await page.goto(`${URL}#visa-extend`);
  await expect(page.locator('details#visa-extend')).toHaveAttribute('open', '');
  await expect.poll(() => page.locator('#visa-extend').evaluate(el => el.getBoundingClientRect().top)).toBeLessThan(300);
});

test('Copy link puts the absolute URL on the clipboard and sets the hash', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'clipboard permissions are Chromium-only in Playwright');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(URL);
  const btn = page.locator('details#visa-how-to-get button.cl');
  await btn.click();
  await expect(btn).toHaveText(/Copied/);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('https://ceylonhop.com/sri-lanka-travel-faq/#visa-how-to-get');
  expect(new globalThis.URL(page.url()).hash).toBe('#visa-how-to-get');
});

test('on a phone the Topics pill appears after the index scrolls off, and returns to it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(URL);
  const pill = page.locator('#pill');
  await expect(pill).not.toHaveClass(/on/);
  expect(await pill.evaluate(el => getComputedStyle(el).visibility)).toBe('hidden');
  await page.locator('#health').scrollIntoViewIfNeeded();
  await expect(pill).toHaveClass(/on/);
  await pill.click();
  await expect.poll(() => page.locator('#topics').evaluate(el => el.getBoundingClientRect().top)).toBeLessThan(120);
  await expect(pill).not.toHaveClass(/on/);
});

test('on desktop the index is a sticky column that marks the topic in view', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.goto(URL);
  expect(await page.locator('#topics').evaluate(el => getComputedStyle(el).position)).toBe('sticky');
  await expect(page.locator('#pill')).toBeHidden();
  await page.locator('#safaris').scrollIntoViewIfNeeded();
  await expect(page.locator('#topics li.on a')).toHaveAttribute('href', '#safaris');
});
