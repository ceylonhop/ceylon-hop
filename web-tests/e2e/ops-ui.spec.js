import { test, expect } from '@playwright/test';

// Browser coverage for the merged ops⇄quote dashboard (api/src/routes/ops-ui.html).
// These promote the manual verification checklist from the ops-quote merge into
// permanent automated assertions: Quote nav visible to all 3 roles (spec D-A —
// quote:manage is granted to founder/finance/ops, not founder-only), lazy-mounted
// quote module, CSS scoping (the quote view's :root tokens must not leak into the
// ops shell), deep-linking, and logout teardown.
//
// Needs a real DATABASE_URL + OPS_USERS (email:role allowlist) + OPS_SESSION_SECRET
// on the booted API — only runs with CH_E2E_API=1 (see playwright.config.js's
// webServer.env and package.json's "test:e2e:tool"/"test:e2e:ops" scripts). Login
// goes through the dev-login bypass (#devloginemail/#devloginform) since Google
// Sign-In needs a real OAuth client and can't be driven in e2e.
test.skip(process.env.CH_E2E_API !== '1', 'ops-ui e2e needs the API — run with CH_E2E_API=1');

// Base defaults to the config's webServer (8787); override with OPS_BASE to run against an
// API booted on another port — needed when a second worktree already holds 8787.
const OPS = (process.env.OPS_BASE || 'http://localhost:8787') + '/ops';

// Matches playwright.config.js's OPS_USERS default for the CH_E2E_API webServer.
const FOUNDER_EMAIL = 'founder@e2e.test';
const FINANCE_EMAIL = 'finance@e2e.test';
const OPS_EMAIL = 'ops@e2e.test';

// GET /admin/ops/bookings does a per-row assemble() (customer + mode-specific lookups)
// PLUS a sequential per-row payments.findByBookingId() in ops.ts — against a remote dev
// Supabase instance with ~15+ seed bookings this has been measured taking 10-12s end to
// end. Bookings-queue assertions need real headroom, not the default 5s/10s.
const BOOKINGS_TIMEOUT = 30000;

// Dev-login helper: fills the allowlisted email into #devloginemail and submits
// #devloginform directly via requestSubmit() (avoids click-target/visibility flakiness
// on the overlay's transition), then waits for the login overlay to hide and the app
// shell (#approot) to boot.
async function login(page, email) {
  await page.goto(OPS);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#login')).toHaveClass(/show/);
  await page.fill('#devloginemail', email);
  await page.evaluate(() => document.getElementById('devloginform').requestSubmit());
  await expect(page.locator('#login')).not.toHaveClass(/show/);
  await expect(page.locator('#approot')).toBeVisible({ timeout: 10000 });
}

test('founder login renders the Bookings queue', async ({ page }) => {
  await login(page, FOUNDER_EMAIL);
  await expect(page.locator('#view h1')).toHaveText('Bookings', { timeout: BOOKINGS_TIMEOUT });
});

test('Quotes queue nav is visible to founder, finance, and ops (D-A: quote:manage is not founder-only)', async ({ page }) => {
  await login(page, FOUNDER_EMAIL);
  await expect(page.locator('#nav button[data-route="quotes"]')).toBeVisible();
  // Merged surface: the separate "Generate Quote" (data-route="quote") nav tab is gone.
  await expect(page.locator('#nav button[data-route="quote"]')).toHaveCount(0);

  await page.evaluate(() => document.getElementById('logoutbtn').click());
  await expect(page.locator('#login')).toHaveClass(/show/);

  await login(page, FINANCE_EMAIL);
  await expect(page.locator('#nav button[data-route="quotes"]')).toBeVisible();

  await page.evaluate(() => document.getElementById('logoutbtn').click());
  await expect(page.locator('#login')).toHaveClass(/show/);

  await login(page, OPS_EMAIL);
  await expect(page.locator('#nav button[data-route="quotes"]')).toBeVisible();
});

test('quote builder lazy-mounts: /admin/quote/rate-card is not requested until the builder opens', async ({ page }) => {
  const rateCardRequests = [];
  page.on('request', (req) => {
    if (req.url().includes('/admin/quote/rate-card')) rateCardRequests.push(req.url());
  });

  await login(page, FOUNDER_EMAIL);
  await expect(page.locator('#view h1')).toHaveText('Bookings', { timeout: BOOKINGS_TIMEOUT });
  // Give any errant eager fetch a moment to fire before we assert its absence.
  await page.waitForTimeout(500);
  expect(rateCardRequests).toHaveLength(0);

  // Opening the queue must NOT mount the builder (no rate-card fetch yet).
  await page.locator('#nav button[data-route="quotes"]').click();
  await expect(page.locator('#view .qhead')).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(300);
  expect(rateCardRequests).toHaveLength(0);

  // Starting a new quote mounts the builder → rate-card is fetched.
  await page.locator('#view [data-qnew]').click();
  await expect(page.locator('#quoteRoot .ch-app')).toBeVisible({ timeout: 10000 });
  await expect.poll(() => rateCardRequests.length, { timeout: 5000 }).toBeGreaterThan(0);
});

// NOTE: the old "support session gets a 403 on /admin/quote/rate-card" test is gone —
// it assumed a founder-only quote:manage gate. Per D-A all 3 human roles (founder/
// finance/ops) hold quote:manage, so there is no human role left that should 403 here.
// Margin/pricing visibility (margin:view, founder-only) is a separate, still-true gate
// covered by the API-level tests in api/ (not loosened by this change).
test('finance session reaches /admin/quote/rate-card (quote:manage, not founder-only)', async ({ page }) => {
  await login(page, FINANCE_EMAIL);
  // Same-origin fetch from within the authenticated page carries the ops session cookie.
  const status = await page.evaluate(async () => {
    const res = await fetch('/admin/quote/rate-card', { credentials: 'same-origin' });
    return res.status;
  });
  expect(status).toBe(200);
});

test('ops ink colour does not leak from the quote view CSS on the Bookings screen', async ({ page }) => {
  await login(page, FOUNDER_EMAIL);
  await expect(page.locator('#view h1')).toHaveText('Bookings', { timeout: BOOKINGS_TIMEOUT });
  // Wait for at least one ticket row (.tk) to render, or fall back to the pagehead if the
  // dev DB has no bookings — either way something in #view carries the ops --ink color.
  const tk = page.locator('.tk').first();
  const target = (await tk.count()) > 0 ? tk : page.locator('.pagehead h1');
  const color = await target.evaluate((el) => getComputedStyle(el).color);
  expect(color).toBe('rgb(36, 31, 29)'); // ops --ink: #241f1d
});

// D-A: all 3 roles have quote:manage, so the deep-link resolution lands EVERY role on
// Quote for a route-only deep link too — there is no longer a human role that gets
// bounced back to Bookings from this route.
test('deep-link /ops#quote lands founder and finance on Quote', async ({ page }) => {
  await page.goto(`${OPS}#quote`);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#login')).toHaveClass(/show/);
  await page.fill('#devloginemail', FOUNDER_EMAIL);
  await page.evaluate(() => document.getElementById('devloginform').requestSubmit());
  await expect(page.locator('#quoteRoot .ch-app')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#quoteRoot')).not.toHaveAttribute('hidden', '');

  await page.locator('#logoutbtn').click();
  await expect(page.locator('#login')).toHaveClass(/show/);

  await page.goto(`${OPS}#quote`);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#login')).toHaveClass(/show/);
  await page.fill('#devloginemail', FINANCE_EMAIL);
  await page.evaluate(() => document.getElementById('devloginform').requestSubmit());
  await expect(page.locator('#quoteRoot .ch-app')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#quoteRoot')).not.toHaveAttribute('hidden', '');
});

test('logout returns the login overlay and empties/hides #quoteRoot with no beforeunload dialog', async ({ page }) => {
  await login(page, FOUNDER_EMAIL);
  await page.locator('#nav button[data-route="quotes"]').click();
  await page.locator('#view [data-qnew]').click();
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

test('Bookings → Quotes → Bookings round-trip shows a single toast, no duplicates', async ({ page }) => {
  await login(page, FOUNDER_EMAIL);
  await expect(page.locator('#view h1')).toHaveText('Bookings', { timeout: BOOKINGS_TIMEOUT });

  await page.locator('#nav button[data-route="quotes"]').click();
  await expect(page.locator('#view .qhead')).toBeVisible({ timeout: 10000 });

  await page.locator('#nav button[data-route="tickets"]').click();
  // Nav clicks just re-render from the already-loaded `tickets` array (no re-fetch), so this
  // is normally instant — the generous timeout is just for consistency with the other assertions.
  await expect(page.locator('#view h1')).toHaveText('Bookings', { timeout: BOOKINGS_TIMEOUT });

  // No stray toast left over from the round-trip (only relevant if anything shows one).
  await expect(page.locator('.toast.show')).toHaveCount(0);
});

// ── Merged Quotes queue (maker-checker workflow) ──────────────────────────────
// The two quoting tabs were merged into one queue-first surface (spec: the quote-approval
// workflow): nav is Bookings · Quotes, the Quotes queue (fed by GET /admin/quote/list)
// lives in the ops shell #view with role-aware sections + read-only status pills, and the
// builder is a detail view reached from a row or "+ New quote". Gated on quote:manage.
// These assertions read the dev DB's saved quotes (at least one exists) and never write.
// (Detailed role/status behaviour is covered offline in quote-approval.spec.js.)
test('the Quotes queue is gated on quote:manage — visible to founder, finance, and ops', async ({ page }) => {
  for (const email of [FOUNDER_EMAIL, FINANCE_EMAIL, OPS_EMAIL]) {
    await login(page, email);
    await expect(page.locator('#nav button[data-route="quotes"]')).toBeVisible();
    await page.locator('#logoutbtn').click();
    await expect(page.locator('#login')).toHaveClass(/show/);
  }
});

test('the Quotes queue renders role-aware sections with read-only status pills, not the builder', async ({ page }) => {
  await login(page, FOUNDER_EMAIL);
  await page.locator('#nav button[data-route="quotes"]').click();
  await expect(page.locator('#view h1')).toHaveText('Quotes');
  await expect(page.locator('#view [data-qnew]')).toBeVisible(); // "+ New quote"
  // The dev DB carries at least one saved quote, so the list paints rows in sections.
  await expect(page.locator('#view .qrow').first()).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#view .qsection-title').first()).toBeVisible();
  await expect(page.locator('#view .qrow .qpill').first()).toBeVisible(); // read-only pill, no <select>
  await expect(page.locator('#view .qstatsel')).toHaveCount(0); // the old inline status <select> is gone
  // The queue must NOT mount the builder cockpit — it's an ops-shell list.
  await expect(page.locator('#quoteRoot')).toHaveAttribute('hidden', '');
});

test('"+ New quote" opens the builder detail view (Quotes stays the active nav)', async ({ page }) => {
  await login(page, FOUNDER_EMAIL);
  await page.locator('#nav button[data-route="quotes"]').click();
  await expect(page.locator('#view [data-qnew]')).toBeVisible();
  await page.locator('#view [data-qnew]').click();
  await expect(page.locator('#quoteRoot .ch-app')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#nav button[data-route="quotes"]')).toHaveClass(/active/);
});

test('clicking a quote row reopens it in the builder detail view', async ({ page }) => {
  await login(page, FOUNDER_EMAIL);
  await page.locator('#nav button[data-route="quotes"]').click();
  await expect(page.locator('#view .qrow').first()).toBeVisible({ timeout: 10000 });
  const firstId = await page.locator('#view .qrow').first().getAttribute('data-qopen');
  await page.locator('#view .qrow').first().click();
  // Reopen switches to the builder route and mounts the cockpit; Quotes stays highlighted.
  await expect(page.locator('#quoteRoot .ch-app')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('.ch-status-pill')).toBeVisible(); // detail header shows the status pill
  await expect(page.locator('#nav button[data-route="quotes"]')).toHaveClass(/active/);
  await expect(page).toHaveURL(new RegExp(`/ops\\?quote=${firstId}#quote$`));

  await page.goBack();
  await expect(page.locator('#view h1')).toHaveText('Quotes');
  await expect(page.locator('#quoteRoot')).toHaveAttribute('hidden', '');
  await expect(page).toHaveURL(/\/ops#quotes$/);
});

test('a shareable quote URL opens that quote for another authenticated quote manager', async ({ page }) => {
  await login(page, FOUNDER_EMAIL);
  await page.locator('#nav button[data-route="quotes"]').click();
  const row = page.locator('#view .qrow').first();
  await expect(row).toBeVisible({ timeout: 10000 });
  await row.click();
  await expect(page.locator('#quoteRoot .ch-app')).toBeVisible({ timeout: 10000 });
  const sharedUrl = page.url();

  await page.evaluate(() => document.getElementById('logoutbtn').click());
  await expect(page.locator('#login')).toHaveClass(/show/);

  await page.goto(sharedUrl);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#login')).toHaveClass(/show/);
  await page.fill('#devloginemail', FINANCE_EMAIL);
  await page.evaluate(() => document.getElementById('devloginform').requestSubmit());
  await expect(page.locator('#quoteRoot .ch-app')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('.ch-status-pill')).toBeVisible();
  await expect(page.locator('#nav button[data-route="quotes"]')).toHaveClass(/active/);
  await expect(page).toHaveURL(sharedUrl);
});
