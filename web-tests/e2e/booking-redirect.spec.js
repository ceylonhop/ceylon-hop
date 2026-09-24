import { test, expect } from '@playwright/test';
import { gotoBooking, fillContact } from './_stubs.js';

// The website checkout — the page most customers pay on. On 2026-09-24 PayHere's decline list
// showed two website payments (CH-Y5RXW, CH-V43ZU) as "3ds Authentication Failed" with no notify
// ever reaching us: the 3-D Secure challenge dying inside the SDK's cross-origin iframe
// (docs/checkout-redirect-spec.md §1.4, §10). booking.html now hands off with the same top-level
// form POST pay.html and manage.html use, and PayHere sends the customer back to their booking's
// manage page, which asks OUR server what happened. Offline: every API call and the gateway are
// stubbed (see gotoBooking's `checkout: 'payhere'` mode).

// Every analytics event, with the page that pushed it — across the navigation to the gateway and
// back, which a plain read of window.dataLayer cannot see.
async function recordEvents(page) {
  const events = [];
  await page.exposeBinding('__e2eRecordEvent', ({ frame }, name) => {
    events.push({ page: new URL(frame.url()).pathname, name });
  });
  await page.addInitScript(() => {
    const dl = (window.dataLayer = window.dataLayer || []);
    const push = dl.push.bind(dl);
    dl.push = function (...items) {
      items.forEach((e) => { if (e && e.event) window.__e2eRecordEvent(e.event); });
      return push(...items);
    };
  });
  return events;
}

// Complete the wizard and press Pay; resolves once the browser is on the PayHere stub.
async function payAtGateway(page, opts = {}) {
  const events = await recordEvents(page);
  const h = await gotoBooking(page, { checkout: 'payhere', ...opts });
  expect(await page.evaluate(() => typeof window.payhere)).toBe('undefined');
  await fillContact(page);
  await page.click('#pay-btn');
  await page.waitForURL(/sandbox\.payhere\.lk/);
  await expect(page.locator('h1')).toHaveText('PayHere stub');
  return { ...h, events };
}

test('paying hands off with a top-level form POST carrying the server’s fields verbatim', async ({ page }) => {
  const { gateway, sdk, checkoutBodies, fields, events } = await payAtGateway(page);

  // The customer LEFT our origin — not a modal over it, not an iframe inside it.
  expect(gateway).toHaveLength(1);
  expect(gateway[0].method).toBe('POST');
  expect(gateway[0].url).toBe('https://sandbox.payhere.lk/pay/checkout');
  // Every field, verbatim and in the server's order.
  expect(gateway[0].postData).toBe(new URLSearchParams(fields).toString());
  expect(Object.keys(fields)).toContain('hash');
  // Intent, never a URL — the server builds the return address.
  expect(checkoutBodies).toEqual([{ returnTo: 'manage' }]);
  expect(sdk).toEqual([]);

  // The attempt started; no outcome is claimed by the page that cannot know one.
  const fromBooking = events.filter((e) => e.page === '/booking.html').map((e) => e.name);
  expect(fromBooking).toContain('payment_initiated');
  for (const name of ['purchase', 'payment_failed', 'payment_dismissed']) expect(fromBooking).not.toContain(name);
});

test('coming back paid lands on the booking, confirmed by our server', async ({ page }) => {
  const { fields, events, viewTokens } = await payAtGateway(page, { settlementStatuses: ['paid'] });
  // PayHere's "Back to Site": the return_url the server built — which carries no manage token.
  expect(new URL(fields.return_url).searchParams.has('t')).toBe(false);
  await page.goto(fields.return_url);
  await expect(page.locator('.t-ref')).toHaveText('Booking CH-E2E01');
  await expect(page.locator('.t-stat')).toHaveText('Confirmed');
  await expect(page.locator('#paybtn')).toHaveCount(0);
  // The full booking came back from the token booking.js stashed before it left.
  expect(viewTokens.length).toBeGreaterThan(0);
  expect(viewTokens.every((t) => t === 'e2e-manage-token')).toBe(true);
  // The status token leaves the address bar once read.
  expect(page.url()).not.toContain('rt=');
  expect(page.url()).not.toContain('e2e-manage-token');
  // No on-page boarding pass on the website any more; nothing on booking.html counted a sale.
  expect(events.filter((e) => e.page === '/booking.html' && e.name === 'purchase')).toEqual([]);
});

test('the booked screen waits for the webhook, not the redirect', async ({ page }) => {
  const { fields } = await payAtGateway(page, { settlementStatuses: ['pending', 'paid'] });
  await page.goto(fields.return_url);
  await expect(page.locator('.st-title')).toHaveText('Confirming your payment…');
  await expect(page.locator('.t-stat')).toHaveText('Confirmed', { timeout: 8000 });
});

test('coming back declined shows the decline help and a way to pay again', async ({ page }) => {
  const { fields } = await payAtGateway(page, { settlementStatuses: ['failed'] });
  await page.goto(fields.return_url);
  await expect(page.locator('#payerr')).toContainText('didn’t go through');
  await expect(page.locator('#payhelp h3')).toContainText('declined');
  await expect(page.locator('#payhelp li')).toHaveCount(4);
  await expect(page.locator('#payhelp')).toContainText('banking app');
  await expect(page.locator('#paybtn')).toBeVisible();
});

test('backing out at PayHere (cancel leg) resumes the booking, claims nothing, and can pay again', async ({ page }) => {
  const { fields } = await payAtGateway(page, { settlementStatuses: ['pending'] });
  expect(fields.cancel_url).toMatch(/&c=1$/);
  await page.goto(fields.cancel_url);
  // While we are still asking, nothing is asserted: the steps are available, collapsed.
  await expect(page.locator('#payhelp .pp-quiet summary')).toBeVisible({ timeout: 8000 });
  // No verdict ever comes (PayHere sends no notify for a 3-D Secure decline): both honest readings,
  // the steps open, and a way to pay again. Still no `payment_failed` — nothing was confirmed.
  await expect(page.locator('#payerr')).toContainText('If PayHere showed Declined, nothing was charged', { timeout: 30000 });
  await expect(page.locator('#payhelp h3')).toContainText('declined');
  await expect(page.locator('#paybtn')).toBeVisible();
});

// ── storage unavailable (private mode, blocked site data) ──────────────────────────────────────
// With no sessionStorage the manage token cannot survive the round trip, and it is no longer in
// the return URL. The page must still say something true and useful from the status token alone.
async function blockStorageOnManage(page) {
  await page.addInitScript(() => {
    if (location.pathname !== '/manage.html') return;
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() { throw new DOMException('The operation is insecure.', 'SecurityError'); },
    });
  });
}

test('with storage blocked, a paid return still says booked (minimal view)', async ({ page }) => {
  await blockStorageOnManage(page);
  const { fields, viewTokens } = await payAtGateway(page, { settlementStatuses: ['paid'] });
  await page.goto(fields.return_url);
  await expect(page.locator('.st-title')).toHaveText('You’re booked.');
  await expect(page.locator('.st-wrap')).toContainText('CH-E2E01');
  expect(viewTokens).toEqual([]);
});

test('with storage blocked, a declined return says so and offers the tell-us link', async ({ page }) => {
  await blockStorageOnManage(page);
  const { fields } = await payAtGateway(page, { settlementStatuses: ['failed'] });
  await page.goto(fields.return_url);
  await expect(page.locator('.st-title')).toHaveText('That payment didn’t go through');
  const a = page.locator('#paywa');
  await expect(a).toBeVisible();
  expect(decodeURIComponent((await a.getAttribute('href')).split('?text=')[1]))
    .toBe('Hi Ceylon Hop, my payment for booking CH-E2E01 didn\'t go through. What I saw: ');
});
