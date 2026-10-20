import { test, expect } from '@playwright/test';
import { routeOpsEstimate } from './_ops-estimate.js';

// Mark booked dialog on a narrow window (staging, 2026-10-16): at ~680px the dialog's left edge
// was cut off ("rk booked", labels clipped). The dialog is position:fixed inside #quoteRoot
// (z-index 1), a stacking context that can never rise above the side rail (z-index 2), so the
// rail painted over the dialog's left 64px+. The dialog must sit fully inside the viewport AND
// be the topmost thing at its own left edge. Offline: every /admin/** call is stubbed.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(o) });

// Open the sent quote and press Mark booked.
const SENT_QUOTE = {
  id: 'q1', reference: 'Q-Q1', channel: 'ops', status: 'sent', product: 'private', vehicle: 'car',
  customerName: 'Maya Silva', customerContact: '+44 7700 900000', totalCents: 14900, currency: 'USD',
  notes: null, createdAt: '2026-07-08T09:00:00.000Z', updatedAt: '2026-07-08T10:00:00.000Z',
  request: {
    tool: {
      name: 'Maya Silva', contact: '+44 7700 900000', vehicle: 'car', service: 'private',
      requestedService: 'private', passengerCount: 2, luggageCount: 2,
      legs: [{ category: 'transfer', from: 'Colombo', to: 'Kandy', distanceKm: 120 }],
    },
  },
  result: { totalCents: 14900 },
  customerTotalVia: 'quote_link',
  estimate: {
    product: 'private',
    total: { cents: 14900, lkr: 'LKR 49,170' },
    lineItems: [{ label: 'Colombo → Kandy (car)', amountCents: 14900 }],
    warnings: [],
  },
  payOptions: null,
};

// Open the sent quote, press Mark booked, fill the modal and Confirm — with /book answering `answer`.
async function openMarkBooked(page) {
  await page.addInitScript(() => {
    window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } }, maps: { importLibrary: async () => ({}) } };
  });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await routeOpsEstimate(page);
  await page.route('**/admin/quote/q1', (r) => r.fulfill(json(SENT_QUOTE)));
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: [{
    id: 'q1', reference: 'Q-Q1', customerName: 'Maya Silva', product: 'private', vehicle: 'car', totalCents: 14900, currency: 'USD', status: 'sent',
  }] })));
  await page.route('**/admin/quote/rate-card', (r) => r.fulfill(json({
    rateCardVersion: '2026-07-09', perKmCents: { car: 35, van: 47, van9: 47, van14: 48, custom: 175 },
    floorCents: { car: 2900, van: 5000, van9: 5000, van14: 8500, custom: 11000 },
    chauffeurDayRateCents: 3500, fxUsdToLkr: 330, bufferPct: 10,
  })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({
    email: 'founder@e2e.test', role: 'founder',
    caps: ['quote:manage', 'quote:approve', 'margin:view', 'bookings:read', 'bookings:operate', 'payments:act'],
  })));
  await page.goto(OPS_FILE + '#quotes');
  await page.locator('#view .qrow[data-qopen="q1"]').click();
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
  await expect(page.locator('.ch-status-pill')).toHaveText('Sent', { timeout: 10000 });
  await page.waitForLoadState('networkidle');

  await page.locator('.ch-actionbar [data-action="markWon"]').click();
  await page.locator('.ch-modal-head h2').waitFor();
}

for (const width of [680, 390]) {
  test(`Mark booked dialog is fully visible, not under the rail, at ${width}px wide`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await openMarkBooked(page);
    const card = page.locator('.ch-modal-card');
    const box = await card.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    // Nothing may paint over the dialog's left edge or its title: probe both.
    const probes = await page.evaluate(() => {
      const inModal = (el) => !!el && !!el.closest('.ch-modal-card');
      const c = document.querySelector('.ch-modal-card').getBoundingClientRect();
      const t = document.querySelector('.ch-modal-head h2').getBoundingClientRect();
      return {
        cardEdge: inModal(document.elementFromPoint(c.left + 4, c.top + c.height / 2)),
        title: inModal(document.elementFromPoint(t.left + 4, t.top + t.height / 2)),
      };
    });
    expect(probes.cardEdge).toBe(true);
    expect(probes.title).toBe(true);
  });
}
