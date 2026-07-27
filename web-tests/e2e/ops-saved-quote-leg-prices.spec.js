import { test, expect } from '@playwright/test';

// Owner report 2026-07-26: "point-to-point transfer on some legs not showing on a saved quote".
// Cause: opening a ready/sent quote sets lastEstimate = q.estimate straight from the server but
// NEVER sets _pricedLegMap — the module-level array getLegBreakdownPrice() uses to find each
// leg's slot in breakdown.legs. So the map kept whatever the PREVIOUSLY opened quote left in it:
// on a cold open it is [] and every leg renders '—'; after a shorter quote it is too short and
// the extra legs render '—' while the ones that do render are reading another itinerary's map.
// Fully stubbed — no DB, no Google key.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

// A saved, rate-locked quote with `legCount` driving legs and a matching per-leg breakdown.
function quoteDetail(id, name, legCount) {
  const places = ['Negombo', 'Sigiriya', 'Kandy', 'Ella', 'Mirissa', 'Colombo Airport (CMB)'];
  const legs = [];
  const blegs = [];
  for (let i = 0; i < legCount; i++) {
    legs.push({ category: 'transfer', from: places[i], to: places[i + 1], distanceKm: 100 + i * 10 });
    blegs.push({ priceCents: 5000 + i * 1000, distanceKm: 100 + i * 10, billableKm: 100 + i * 10 });
  }
  const total = blegs.reduce((s, l) => s + l.priceCents, 0);
  return {
    id, reference: 'Q-' + id.toUpperCase(), channel: 'ops', status: 'sent',
    product: 'private', vehicle: 'car', customerName: name, customerContact: '+94 77 123 4567',
    totalCents: total, currency: 'USD', notes: null,
    createdAt: '2026-07-08T09:00:00.000Z', updatedAt: '2026-07-08T10:00:00.000Z',
    createdBy: 'founder@e2e.test', updatedBy: 'founder@e2e.test',
    request: { tool: {
      name, firstName: name, lastName: '', contact: '+94 77 123 4567',
      vehicle: 'car', service: 'private', requestedService: 'private',
      passengerCount: 2, luggageCount: 2, legs,
    } },
    result: { totalCents: total },
    estimate: {
      product: 'private', total: { cents: total, lkr: 'LKR 1' },
      lineItems: [{ label: 'Private transfer', amountCents: total }], warnings: [],
      breakdown: { km: { distanceKm: 400, bufferKm: 0, billableKm: 400 }, legs: blegs },
    },
  };
}

async function stubOps(page) {
  await page.addInitScript(() => {
    window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } },
      maps: { importLibrary: async () => ({}) } };
  });
  // Catch-all FIRST; specific routes after (Playwright: last-registered wins).
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/users', (r) => r.fulfill(json({ users: [] })));
  await page.route('**/admin/ops/whoami', (r) =>
    r.fulfill(json({ email: 'founder@e2e.test', role: 'founder', caps: ['quote:manage', 'quote:approve'] })));
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: [
    { id: 'short1', reference: 'Q-SHORT1', customerName: 'Shorty', product: 'private', vehicle: 'car', totalCents: 11000, currency: 'USD', status: 'sent' },
    { id: 'long1', reference: 'Q-LONG1', customerName: 'Longtrip', product: 'private', vehicle: 'car', totalCents: 26000, currency: 'USD', status: 'sent' },
  ] })));
  await page.route(/\/admin\/quote\/short1$/, (r) => r.fulfill(json(quoteDetail('short1', 'Shorty', 2))));
  await page.route(/\/admin\/quote\/long1$/, (r) => r.fulfill(json(quoteDetail('long1', 'Longtrip', 4))));
}

// Every leg of a rate-locked quote carries a price; none render the '—' empty state.
async function expectAllLegsPriced(page, legCount) {
  await expect(page.locator('.ch-leg')).toHaveCount(legCount, { timeout: 10000 });
  await expect(page.locator('.ch-leg-price')).toHaveCount(legCount);
  await expect(page.locator('.ch-leg-price.empty')).toHaveCount(0);
  for (let i = 0; i < legCount; i++) {
    await expect(page.locator('.ch-leg-price').nth(i)).toHaveText(/^\$\d/);
  }
}

test('a saved quote opened cold prices every leg', async ({ page }) => {
  await stubOps(page);
  await page.goto(OPS_FILE + '#quotes');
  await page.locator('.qrow[data-qopen="long1"]').click();
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
  await expect(page.locator('#f-firstName')).toHaveValue('Longtrip', { timeout: 10000 });
  await expectAllLegsPriced(page, 4);
});

test('opening a longer saved quote after a shorter one prices every leg', async ({ page }) => {
  await stubOps(page);
  await page.goto(OPS_FILE + '#quotes');

  // A 2-leg quote first — this is what used to leave a 2-entry map behind.
  await page.locator('.qrow[data-qopen="short1"]').click();
  await expect(page.locator('#f-firstName')).toHaveValue('Shorty', { timeout: 10000 });
  await expectAllLegsPriced(page, 2);

  // Now a 4-leg quote. Legs 3 and 4 were the ones rendering '—'.
  await page.goBack();
  await expect(page.locator('.qrow[data-qopen="long1"]')).toBeVisible({ timeout: 10000 });
  await page.locator('.qrow[data-qopen="long1"]').click();
  await expect(page.locator('#f-firstName')).toHaveValue('Longtrip', { timeout: 10000 });
  await expectAllLegsPriced(page, 4);

  // And the prices belong to THIS quote, not the previous one's map.
  await expect(page.locator('.ch-leg-price').nth(3)).toHaveText('$80.00');
});
