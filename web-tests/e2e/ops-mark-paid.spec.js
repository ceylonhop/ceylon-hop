import { test, expect } from '@playwright/test';
import { futureIsoDate } from '../dates.js';

// Out-of-band settlement (spec 2026-07-30): a booking converted from an ops quote lands in
// payment_pending and is paid in cash or by bank transfer — no PayHere webhook is ever coming.
// Before POST /admin/bookings/:id/mark-paid existed it was stranded at "Awaiting payment"
// forever, because NEXT has no advance out of that stage. This covers the whole unblock:
// drawer control -> real server round-trip -> pipeline moves to Paid and grows an advance button.
test.skip(process.env.CH_E2E_API !== '1', 'ops mark-paid e2e needs the API — run with CH_E2E_API=1');

const OPS = (process.env.OPS_BASE || 'http://localhost:8787') + '/ops';
const FOUNDER_EMAIL = 'founder@e2e.test'; // the only seeded role with BOTH bookings:operate (to
// build the fixture through /admin/quote/:id/book) and payments:act (to see the Mark paid control).

// Copied from ops-ui.spec.js — see that file for why requestSubmit() beats a click here.
async function login(page, email) {
  await page.goto(OPS);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#login')).toHaveClass(/show/);
  await page.fill('#devloginemail', email);
  await page.evaluate(() => document.getElementById('devloginform').requestSubmit());
  await expect(page.locator('#login')).not.toHaveClass(/show/);
  await expect(page.locator('#approot')).toBeVisible({ timeout: 10000 });
}

// GET /admin/ops/bookings does a per-row assemble() plus a sequential per-row payments lookup;
// against a shared test DB with a growing row count this has been measured at 10-12s. Same
// headroom ops-ui.spec.js uses.
const BOOKINGS_TIMEOUT = 30000;

// Build the fixture the way the product actually makes one: an ops quote converted to a booking.
// There is no "create a booking in payment_pending" endpoint — the public POST /bookings/single
// only mints a draft, and moving that to payment_pending needs a signed checkout token and a
// PayHere adapter round trip. POST /admin/quote/:id/book lands the booking in payment_pending
// directly (internalQuote.ts: "so it surfaces in the ops Bookings queue"), which is precisely the
// cash/bank-transfer booking this feature exists for.
//
// Driven with page.evaluate(fetch) rather than page.request or a Node fetch so the calls ride the
// exact session the harness just established: same-origin, the browser's own ch_ops cookie (it is
// Secure, so only a browser on localhost sends it over http), and a real Sec-Fetch-Site:same-origin
// header, which is what /admin/quote's CSRF guard checks.
async function bookedQuoteAwaitingPayment(page) {
  return page.evaluate(async () => {
    const json = async (path, method, body) => {
      const res = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
      return JSON.parse(text);
    };

    // 1. Price and save a real ops quote. distanceKm is supplied so the row prices off the rate
    //    card without depending on a Maps key being present on the booted API.
    const quote = await json('/admin/quote/save', 'POST', {
      name: 'E2E MarkPaid',
      vehicle: 'car',
      passengerCount: 2,
      luggageCount: 1,
      requestedService: 'private',
      legs: [{ category: 'transfer', from: 'Colombo City', to: 'Kandy', distanceKm: 120 }],
    });

    // 2. Walk the maker-checker lifecycle. /book only accepts a quote that reached the customer
    //    (status 'sent' or 'won'), and each hop is a separate PATCH the server validates.
    for (const status of ['pending_review', 'ready', 'sent']) {
      await json(`/admin/quote/${quote.id}`, 'PATCH', { status });
    }

    // 3. Convert. This is the "Mark booked" modal's payload; the booking is created at the quote's
    //    frozen total and set to payment_pending.
    const booking = await json(`/admin/quote/${quote.id}/book`, 'POST', {
      customer: {
        firstName: 'E2E',
        lastName: 'MarkPaid',
        email: 'e2e@markpaid.test',
        whatsapp: '+94771234567',
        country: 'LK',
      },
      vehicleType: 'car',
      pax: 2,
      bags: 1,
      date: futureIsoDate(45), // anchored to now: the booking API rejects a past travel date
      time: '09:00',
    });
    return { id: booking.id, reference: booking.reference, status: booking.status };
  });
}

test('marking an awaiting-payment booking paid in cash unblocks the pipeline', async ({ page }) => {
  // Playwright's 30s default is the whole test's budget, and this one spends it on a login, a
  // five-call fixture build, a reload and two /admin/ops/bookings loads — each of which can take
  // 10s+ under the parallel CH_E2E_API run. Give the individual BOOKINGS_TIMEOUT waits room to
  // actually elapse instead of being cut short by the test budget.
  test.setTimeout(120000);
  await login(page, FOUNDER_EMAIL);

  const booking = await bookedQuoteAwaitingPayment(page);
  expect(booking.status).toBe('payment_pending'); // the stranded state this feature exists to end

  // #bookings is the Bookings queue's own hash (login lands on Quotes since 2026-07-23). The
  // reload is load-bearing: login() already put us on OPS, so goto() to the same URL with only a
  // new hash is a SAME-DOCUMENT navigation — the SPA never re-boots and the queue keeps the rows
  // it fetched before this fixture existed. Reload forces the real GET /admin/ops/bookings.
  await page.goto(OPS + '#bookings');
  await page.reload();
  const row = page.locator(`.tk[data-act="open"][data-id="${booking.id}"]`);
  await expect(row).toBeVisible({ timeout: BOOKINGS_TIMEOUT });
  await row.click();

  // Drawer opens on "Awaiting payment", with no advance button — that is the stranding.
  const sheet = page.locator('#sheet');
  await expect(sheet.locator('.pstep.cur')).toHaveText('Awaiting');
  await expect(sheet.locator('[data-act="advance"]')).toHaveCount(0);

  await sheet.locator('#paidmethod').selectOption('cash');

  // The control asks for confirmation through a native confirm(). Playwright auto-DISMISSES any
  // dialog nobody listens for, so without this handler the click would silently no-op and the
  // test would hang on the POST below. Registered before the click so it cannot be raced.
  page.on('dialog', (dialog) => dialog.accept());

  // Assert the server round-trip, not the DOM: a <select> and a button both change client-side
  // whether or not anything was recorded, so a DOM-only assertion would still pass with the POST
  // deleted. Set the waiter up BEFORE the click so a fast response can't slip past.
  const markPaid = page.waitForResponse(
    (res) =>
      res.request().method() === 'POST' &&
      new URL(res.url()).pathname === `/admin/bookings/${booking.id}/mark-paid`,
    { timeout: BOOKINGS_TIMEOUT },
  );
  await sheet.locator('[data-act="markpaid"]').click();
  const res = await markPaid;
  expect(res.status()).toBe(200);
  expect((await res.json()).status).toBe('paid'); // the money was recorded, not just asserted

  // ...and the pipeline is unblocked: PAID is now the current step, and the stage that had no
  // way forward has grown the advance button NEXT defines for 'paid'.
  await expect(sheet.locator('.pstep.cur')).toHaveText('Paid', { timeout: BOOKINGS_TIMEOUT });
  const advance = sheet.locator('[data-act="advance"]');
  await expect(advance).toBeVisible();
  await expect(advance).toContainText('Confirm vehicle');
});
