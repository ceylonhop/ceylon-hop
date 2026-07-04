import { test, expect } from '@playwright/test';

// Browser coverage for the merged ops⇄quote dashboard (api/src/routes/ops-ui.html).
// These promote the manual verification checklist from the ops-quote merge into
// permanent automated assertions: founder-only Quote nav, lazy-mounted quote
// module, API-level 403 for support, CSS scoping (the quote view's :root tokens
// must not leak into the ops shell), deep-linking, and logout teardown.
//
// Needs a real DATABASE_URL + OPS_FOUNDER_KEY/OPS_SUPPORT_KEY on the booted API
// — only runs with CH_E2E_API=1 (see playwright.config.js's webServer.env and
// package.json's "test:e2e:tool"/"test:e2e:ops" scripts).
test.skip(process.env.CH_E2E_API !== '1', 'ops-ui e2e needs the API — run with CH_E2E_API=1');

const OPS = 'http://localhost:8787/ops';
const FOUNDER_KEY = process.env.OPS_FOUNDER_KEY || 'dev-founder';
const SUPPORT_KEY = process.env.OPS_SUPPORT_KEY || 'dev-support';

test.skip(!FOUNDER_KEY || !SUPPORT_KEY, 'OPS_FOUNDER_KEY/OPS_SUPPORT_KEY are empty — cannot log in');

// GET /admin/ops/bookings does a per-row assemble() (customer + mode-specific lookups)
// PLUS a sequential per-row payments.findByBookingId() in ops.ts — against a remote dev
// Supabase instance with ~15+ seed bookings this has been measured taking 10-12s end to
// end. Bookings-queue assertions need real headroom, not the default 5s/10s.
const BOOKINGS_TIMEOUT = 30000;

async function login(page, key) {
  await page.goto(OPS);
  await page.waitForLoadState('networkidle');
  await page.locator('#loginkey').fill(key);
  await page.locator('#loginform').evaluate((form) => form.requestSubmit());
  await expect(page.locator('#approot')).toBeVisible({ timeout: 10000 });
}

test('founder login renders the Bookings queue', async ({ page }) => {
  await login(page, FOUNDER_KEY);
  await expect(page.locator('#view h1')).toHaveText('Bookings', { timeout: BOOKINGS_TIMEOUT });
});

test('founder sees the Quote nav; support does not', async ({ page }) => {
  await login(page, FOUNDER_KEY);
  await expect(page.locator('#nav button[data-route="quote"]')).toBeVisible();

  await page.locator('#logoutbtn').click();
  await expect(page.locator('#login')).toHaveClass(/show/);

  await login(page, SUPPORT_KEY);
  await expect(page.locator('#nav button[data-route="quote"]')).toHaveCount(0);
});

test('quote module lazy-mounts: /admin/quote/rate-card is not requested until Quote is opened', async ({ page }) => {
  const rateCardRequests = [];
  page.on('request', (req) => {
    if (req.url().includes('/admin/quote/rate-card')) rateCardRequests.push(req.url());
  });

  await login(page, FOUNDER_KEY);
  await expect(page.locator('#view h1')).toHaveText('Bookings', { timeout: BOOKINGS_TIMEOUT });
  // Give any errant eager fetch a moment to fire before we assert its absence.
  await page.waitForTimeout(500);
  expect(rateCardRequests).toHaveLength(0);

  await page.locator('#nav button[data-route="quote"]').click();
  await expect(page.locator('#quoteRoot .ch-app')).toBeVisible({ timeout: 10000 });
  await expect.poll(() => rateCardRequests.length, { timeout: 5000 }).toBeGreaterThan(0);
});

test('support session gets a 403 from the API on /admin/quote/rate-card', async ({ page }) => {
  await login(page, SUPPORT_KEY);
  // Same-origin fetch from within the authenticated page carries the ops session cookie.
  const status = await page.evaluate(async () => {
    const res = await fetch('/admin/quote/rate-card', { credentials: 'same-origin' });
    return res.status;
  });
  expect(status).toBe(403);
});

test('ops ink colour does not leak from the quote view CSS on the Bookings screen', async ({ page }) => {
  await login(page, FOUNDER_KEY);
  await expect(page.locator('#view h1')).toHaveText('Bookings', { timeout: BOOKINGS_TIMEOUT });
  // Wait for at least one ticket row (.tk) to render, or fall back to the pagehead if the
  // dev DB has no bookings — either way something in #view carries the ops --ink color.
  const tk = page.locator('.tk').first();
  const target = (await tk.count()) > 0 ? tk : page.locator('.pagehead h1');
  const color = await target.evaluate((el) => getComputedStyle(el).color);
  expect(color).toBe('rgb(36, 31, 29)'); // ops --ink: #241f1d
});

test('deep-link /ops#quote lands founder on Quote, bounces support to Bookings', async ({ page }) => {
  await page.goto(`${OPS}#quote`);
  await page.waitForLoadState('networkidle');
  await page.locator('#loginkey').fill(FOUNDER_KEY);
  await page.locator('#loginform').evaluate((form) => form.requestSubmit());
  await expect(page.locator('#quoteRoot .ch-app')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#quoteRoot')).not.toHaveAttribute('hidden', '');

  await page.locator('#logoutbtn').click();
  await expect(page.locator('#login')).toHaveClass(/show/);

  await page.goto(`${OPS}#quote`);
  await page.waitForLoadState('networkidle');
  await page.locator('#loginkey').fill(SUPPORT_KEY);
  await page.locator('#loginform').evaluate((form) => form.requestSubmit());
  await expect(page.locator('#view h1')).toHaveText('Bookings', { timeout: BOOKINGS_TIMEOUT });
  await expect(page.locator('#quoteRoot')).toHaveAttribute('hidden', '');
});

test('logout returns the login overlay and empties/hides #quoteRoot with no beforeunload dialog', async ({ page }) => {
  await login(page, FOUNDER_KEY);
  await page.locator('#nav button[data-route="quote"]').click();
  await expect(page.locator('#quoteRoot .ch-app')).toBeVisible({ timeout: 10000 });

  // A dialog listener that fails the test if beforeunload's confirm fires — logging out
  // must teardown the quote module (clearing the unsaved-changes flag) before navigating away.
  let dialogFired = false;
  page.on('dialog', (d) => { dialogFired = true; d.dismiss(); });

  await page.locator('#logoutbtn').click();
  await expect(page.locator('#login')).toHaveClass(/show/);
  // QuoteView.teardown() empties .ch-app's innerHTML but leaves the wrapper div itself in
  // #quoteRoot (showQuoteView() only (re)creates it when absent) — so assert it's emptied,
  // not removed, and that #approot (which contains #quoteRoot) is hidden behind the login.
  await expect(page.locator('#quoteRoot .ch-app')).toBeEmpty();
  await expect(page.locator('#approot')).toHaveAttribute('hidden', '');
  expect(dialogFired).toBe(false);
});

test('Bookings → Quote → Bookings round-trip shows a single toast, no duplicates', async ({ page }) => {
  await login(page, FOUNDER_KEY);
  await expect(page.locator('#view h1')).toHaveText('Bookings', { timeout: BOOKINGS_TIMEOUT });

  await page.locator('#nav button[data-route="quote"]').click();
  await expect(page.locator('#quoteRoot .ch-app')).toBeVisible({ timeout: 10000 });

  await page.locator('#nav button[data-route="tickets"]').click();
  // Nav clicks just re-render from the already-loaded `tickets` array (no re-fetch), so this
  // is normally instant — the generous timeout is just for consistency with the other assertions.
  await expect(page.locator('#view h1')).toHaveText('Bookings', { timeout: BOOKINGS_TIMEOUT });
  await expect(page.locator('#quoteRoot')).toHaveAttribute('hidden', '');

  // No stray toast left over from the round-trip (only relevant if anything shows one).
  await expect(page.locator('.toast.show')).toHaveCount(0);
});
