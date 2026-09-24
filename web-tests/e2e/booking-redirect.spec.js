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
  const { fields, events } = await payAtGateway(page, { settlementStatuses: ['paid'] });
  // PayHere's "Back to Site": the return_url the server built.
  await page.goto(fields.return_url);
  await expect(page.locator('.t-ref')).toHaveText('Booking CH-E2E01');
  await expect(page.locator('.t-stat')).toHaveText('Confirmed');
  await expect(page.locator('#paybtn')).toHaveCount(0);
  // Both tokens leave the address bar once read.
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
  await expect(page.locator('#payerr')).toContainText('without finishing the payment', { timeout: 30000 });
  // Not asserted as a decline: the steps are available, collapsed.
  await expect(page.locator('#payhelp h3')).toHaveCount(0);
  await expect(page.locator('#payhelp .pp-quiet summary')).toBeVisible();
  await expect(page.locator('#paybtn')).toBeVisible();
});
