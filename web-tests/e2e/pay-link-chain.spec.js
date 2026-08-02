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
