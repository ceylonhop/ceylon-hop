// web-tests/e2e/beta-notice.spec.js
// The beta notice against a real page. The unit test proves the logic in jsdom; this proves the
// thing a visitor actually meets — that it covers the page, that one click clears it for good,
// and that it is nowhere near anyone trying to pay.
import { test, expect } from '@playwright/test';
import { blockLiveApi } from './_stubs.js';

// Opt out of the suite-wide "returning visitor" storage (see playwright.config.js) — these are
// the only specs that want a first visit.
test.use({ storageState: { cookies: [], origins: [] } });

// index.html/tours.html/pay.html ping the live API on load (0e0f077) — keep the suite offline.
test.beforeEach(async ({ page }) => { await blockLiveApi(page); });

const notice = (page) => page.locator('.ch-beta');

test('greets a first-time visitor and stays gone once dismissed', async ({ page }) => {
  await page.goto('/index.html');
  await expect(notice(page)).toBeVisible();
  await expect(page.locator('#ch-beta-title')).toContainText('Ceylon Hop');

  // Focus starts on the button, so a keyboard visitor is not left behind the scrim.
  await expect(page.locator('.ch-beta button')).toBeFocused();

  await page.locator('.ch-beta button').click();
  await expect(notice(page)).toHaveCount(0);

  // The page underneath is usable again — the scroll lock was lifted, not just hidden.
  await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');

  await page.reload();
  await expect(notice(page)).toHaveCount(0);

  // And on the next page they visit.
  await page.goto('/tours.html');
  await expect(notice(page)).toHaveCount(0);
});

test('closes on Escape', async ({ page }) => {
  await page.goto('/index.html');
  await expect(notice(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(notice(page)).toHaveCount(0);
});

// The whole point of scoping it to the browse pages: nobody meets a dialog mid-purchase.
test('is not shipped on the transactional pages', async ({ page }) => {
  // Asserted against the SERVED HTML, not a visit. booking.html with no route in the URL
  // redirects to plan.html (booking.js) — a browse page, where the notice is correct to appear —
  // so a live visit would test the redirect, not the scoping.
  for (const path of ['/booking.html', '/pay.html', '/manage.html', '/quote.html']) {
    const res = await page.request.get(path);
    expect(res.ok(), `${path} should be served`).toBe(true);
    expect(await res.text(), `${path} must not load the beta notice`).not.toContain('beta-notice.js');
  }
});

test('does not cover the payment page', async ({ page }) => {
  await page.goto('/pay.html');
  await expect(notice(page)).toHaveCount(0);
});
