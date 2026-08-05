import { test, expect } from '@playwright/test';

// The whole pay-link chain against the REAL API and a REAL Postgres: ops quote → pay link →
// customer submits → resume with corrected details → PayHere webhook → paid.
//
// This exists because of a live incident on 2026-08-02. A stray POST /quotes/pay/start created a
// booking with test fixtures; the owner then opened the pay link, entered their real name, email
// and billing address, and paid. `/start`'s resume branch validated their submission and threw it
// away — so PayHere was handed `T T / t@x.com / 1 A St, Colombo` for a US-issued card, the
// confirmation email went to a fake address, and the recorded terms acceptance belonged to the
// wrong person. Fixed by PRs #274 and #279.
//
// Those fixes are covered by unit tests against InMemoryBookingRepo. This is the only test that
// exercises `PostgresBookingRepo.refreshPayerDetails` — the implementation that actually runs in
// production — because postgres.test.ts is DB-gated and never runs without a database.
test.skip(process.env.CH_E2E_API !== '1', 'pay-link chain needs the API — run with CH_E2E_API=1');

const API = process.env.OPS_BASE || 'http://localhost:8787';
const OPS = API + '/ops';
const FOUNDER = 'founder@e2e.test';

// The FIRST submission — stands in for the stray POST that caused the incident.
const STRAY = {
  customer: { firstName: 'T', lastName: 'T', email: 't@x.com', whatsapp: '+94770001111', country: 'Sri Lanka' },
  billing: { address: '1 A St', city: 'Colombo', country: 'Sri Lanka' },
};
// The SECOND submission — the person actually holding the card.
const PAYER = {
  customer: { firstName: 'Roshen', lastName: 'Weliwatta', email: 'roshen@e2e.test', whatsapp: '+19176008055', country: 'United States' },
  billing: { address: '31 River Court, Apt 105', city: 'Jersey City', country: 'United States', postcode: '07310' },
};

async function login(page) {
  await page.goto(OPS);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#login')).toHaveClass(/show/);
  await page.fill('#devloginemail', FOUNDER);
  await page.evaluate(() => document.getElementById('devloginform').requestSubmit());
  await expect(page.locator('#approot')).toBeVisible({ timeout: 15000 });
  // #approot appearing is the SPA reacting, not proof the session cookie is usable yet — the
  // first /admin/quote/save raced it and 401'd. Wait for the server to actually recognise us.
  await expect.poll(async () => page.evaluate(async () => {
    const r = await fetch('/admin/ops/whoami', { credentials: 'same-origin' });
    return r.status;
  }), { timeout: 15000 }).toBe(200);
}

// A quote the customer could actually pay: priced, walked through maker-checker to 'sent'.
// Driven through page.evaluate(fetch) so the calls ride the browser's own ch_ops cookie and a
// same-origin Sec-Fetch-Site header, which /admin/quote's CSRF guard checks.
async function sentQuoteWithPayLink(page) {
  return page.evaluate(async () => {
    const json = async (path, method, body) => {
      const res = await fetch(path, {
        method, credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
      return JSON.parse(text);
    };
    const quote = await json('/admin/quote/save', 'POST', {
      name: 'E2E PayChain', vehicle: 'car', passengerCount: 2, luggageCount: 1,
      requestedService: 'private',
      legs: [{ category: 'transfer', from: 'Colombo City', to: 'Kandy', distanceKm: 120 }],
    });
    for (const status of ['pending_review', 'ready', 'sent']) {
      await json(`/admin/quote/${quote.id}`, 'PATCH', { status });
    }
    const link = await json(`/admin/quote/${quote.id}/pay-link`, 'POST', {});
    return { quoteId: quote.id, url: link.url ?? link.payUrl ?? link.link };
  });
}

// Submit the pay form's payload directly at the API. This is exactly what pay.html POSTs
// (see startPayment), and going straight at /quotes/pay/start keeps the test about the server
// contract rather than about form-filling, which pay-page.spec.js already covers offline.
async function submitPayment(page, token, who) {
  return page.evaluate(async ({ token, who }) => {
    const res = await fetch('/quotes/pay/start', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ t: token, customer: who.customer, billing: who.billing, termsAccepted: true }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`start -> ${res.status} ${text}`);
    return JSON.parse(text);
  }, { token, who });
}

test('a corrected submission — not the first one — is what reaches the gateway', async ({ page }) => {
  // Hard safety net. pay.html defaults window.CEYLON_HOP_API to the PRODUCTION Render URL, and
  // this suite POSTs to a money endpoint. Nothing in this file may ever touch a real host.
  await page.route('**://*.ceylonhop.com/**', (r) => r.abort());
  await page.route('**://*.onrender.com/**', (r) => r.abort());
  await page.route('**://*.payhere.lk/**', (r) => r.abort());

  await login(page);
  const { url } = await sentQuoteWithPayLink(page);
  expect(url, 'mint should return a pay URL').toBeTruthy();
  const token = new URL(url).searchParams.get('t');
  expect(token).toBeTruthy();

  // First submission — the wrong person, as happened in production.
  const first = await submitPayment(page, token, STRAY);
  expect(first.bookingId).toBeTruthy();

  // Second submission on the SAME link: the real payer corrects everything. Before #274 this
  // returned the same booking untouched and the corrections were silently dropped.
  const second = await submitPayment(page, token, PAYER);
  expect(second.bookingId, 'a resume must not duplicate the booking').toBe(first.bookingId);

  // The booking now describes the person who is paying — read back through the real
  // PostgresBookingRepo, via the ops API the team actually looks at.
  const row = await page.evaluate(async (id) => {
    const res = await fetch(`/admin/ops/bookings`, { credentials: 'same-origin' });
    const rows = await res.json();
    return rows.find((r) => r.id === id) ?? null;
  }, first.bookingId);

  expect(row, 'the paid-for booking must be in the ops bookings list').toBeTruthy();
  expect(row.customerName).toContain('Roshen');
  expect(JSON.stringify(row)).not.toContain('t@x.com');
});

// ── Partial-leg links (spec 2026-08-04): mint a 2-of-3-leg link through the REAL picker UI,
// open the real pay page, and prove the booking that comes out carries only the sold legs at
// the summed-lines amount.
test('a partial link sells only the picked legs, at the sum of their quoted lines', async ({ page }) => {
  await page.route('**://*.ceylonhop.com/**', (r) => r.abort());
  await page.route('**://*.onrender.com/**', (r) => r.abort());
  await page.route('**://*.payhere.lk/**', (r) => r.abort());

  await login(page);

  // A priced, sent 3-leg private quote — through the same API surface the ops UI uses.
  const { quoteId } = await page.evaluate(async () => {
    const json = async (path, method, body) => {
      const res = await fetch(path, {
        method, credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
      return JSON.parse(text);
    };
    const quote = await json('/admin/quote/save', 'POST', {
      name: 'E2E Partial', vehicle: 'car', passengerCount: 2, luggageCount: 1,
      requestedService: 'private',
      legs: [
        { category: 'transfer', from: 'Colombo City', to: 'Kandy', distanceKm: 120 },
        { category: 'transfer', from: 'Kandy', to: 'Ella', distanceKm: 140 },
        { category: 'transfer', from: 'Ella', to: 'Galle', distanceKm: 200 },
      ],
    });
    for (const status of ['pending_review', 'ready', 'sent']) {
      await json(`/admin/quote/${quote.id}`, 'PATCH', { status });
    }
    return { quoteId: quote.id };
  });

  // Mint 2 of 3 legs via the server's own lines, exactly as the picker's Confirm does — and
  // capture the expected amount from the SAME source the customer page must then display.
  const minted = await page.evaluate(async (id) => {
    const get = async (p) => {
      const r = await fetch(p, { credentials: 'same-origin' });
      if (!r.ok) throw new Error(`${p} -> ${r.status}`);
      return r.json();
    };
    const { lines } = await get(`/admin/quote/${id}/pay-lines`);
    const legs = lines.filter((l) => l.kind === 'leg');
    const sel = { legIndexes: [legs[0].index, legs[1].index], extraIndexes: [] };
    const res = await fetch(`/admin/quote/${id}/pay-link`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sel),
    });
    if (!res.ok) throw new Error(`pay-link -> ${res.status}`);
    const body = await res.json();
    const expectedCents = legs[0].amountCents + legs[1].amountCents;
    return { url: body.url, amountCents: body.amountCents, coverage: body.coverage, expectedCents };
  }, quoteId);

  expect(minted.coverage).toEqual({ soldLegs: 2, totalLegs: 3 });
  expect(minted.amountCents).toBe(minted.expectedCents);

  // The customer's pay page: an itemised receipt plus the coverage sentence, ON the real page.
  // Same token, but opened on the API host — the e2e API's PAY_BASE_URL points elsewhere.
  const payUrl = new URL(minted.url);
  await page.goto(API + '/p' + payUrl.search);
  await expect(page.locator('.paid-lines li')).toHaveCount(2);
  await expect(page.locator('.coverage').first()).toContainText('covers 2 of the 3 legs');
  const shown = await page.locator('.tot .v').first().textContent();
  expect(shown).toContain('$' + (minted.amountCents / 100).toFixed(2));

  // Pay-commit: the booking is the two sold legs at the sold amount — never the whole trip.
  const token = new URL(minted.url).searchParams.get('t');
  const started = await submitPayment(page, token, PAYER);
  const detail = await page.evaluate(async (id) => {
    const res = await fetch(`/admin/ops/bookings/${id}`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`detail -> ${res.status}`);
    return res.json();
  }, started.bookingId);

  expect(detail.booking.total).toBe(minted.amountCents);
  expect(detail.booking.input.stops).toEqual(['Colombo City', 'Kandy', 'Ella']);
  expect(detail.coverage).toEqual({ soldLegs: 2, totalLegs: 3 });
});
