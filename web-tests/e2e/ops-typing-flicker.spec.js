import { test, expect } from '@playwright/test';

// Regression for the typing-flicker loop (docs/bug-ops-quote-typing-flicker.md, Defect B).
// A background render() (a landing /estimate or auto-distance result) swaps the panel's
// innerHTML while the operator is typing a place. The orphaned old input then fires its
// delayed blur and — without a document.contains guard — commits the HALF-TYPED text as a
// finished place, scheduling auto-distance + a re-price on garbage → another render →
// another orphan blur: a self-sustaining flicker loop.
//
// Observable signature (no access to module-private state): a /admin/quote/distance or
// /admin/quote/estimate call carrying the partial text as a location. We type a prefix of
// a real place and never pick/blur, so NO legit path may commit it.
//
// Same offline stubbed harness as ops-quote-route-choice.spec.js (no DB, no Google key).

const OPS_FILE = '/api/src/routes/ops-ui.html';
const PARTIAL = 'Nuwara El'; // typed but never picked — must never reach the API

async function stubOps(page, calls) {
  await page.addInitScript(() => {
    window.google = {
      accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } },
      maps: { importLibrary: async () => ({}) },
    };
  });

  const json = (obj) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });

  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/quote/estimate', (r) => {
    const b = r.request().postDataJSON() || {};
    calls.estimate.push(b);
    const km = (b.legs || []).reduce((s, l) => s + (l.distanceKm || 0), 0);
    const priceCents = km * 50;
    return r.fulfill(json({
      total: { cents: priceCents, lkr: 'Rs ' + (priceCents * 3) },
      amountDueNow: { cents: Math.round(priceCents / 10), lkr: 'Rs 0' },
      lineItems: [{ label: 'leg', amountCents: priceCents, lkr: 'Rs 0' }],
      breakdown: { km: { distanceKm: km, bufferKm: 0, billableKm: km }, legs: (b.legs || []).map((l) => ({ priceCents: (l.distanceKm || 0) * 50 })) },
      fxUsdToLkr: 320,
      warnings: [],
      services: {
        pointToPoint: { total: { cents: priceCents, lkr: 'Rs 0' } },
        chauffeur: { error: 'single-day trip — point-to-point only' },
      },
    }));
  });
  await page.route('**/admin/ops/whoami', (r) =>
    r.fulfill(json({ email: 'founder@e2e.test', role: 'founder', caps: ['quote:manage'] })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/quote/places**', (r) => {
    const q = new URL(r.request().url()).searchParams.get('q') || '';
    r.fulfill(json({ places: [q], suggestions: [{ label: q, source: 'known' }] }));
  });
  // Slow-ish distance responses widen the window in which a background render lands
  // while the operator is still typing (the loop's trigger condition).
  await page.route('**/admin/quote/distance', async (r) => {
    const b = r.request().postDataJSON() || {};
    calls.distance.push(b);
    await new Promise((res) => setTimeout(res, 150));
    return r.fulfill(json({ km: 120, durationMin: 180 }));
  });
}

async function pickPlace(page, legIndex, field, name) {
  const stopSel = field === 'pickupLocation' ? '[data-field="stop"][data-stop="0"]'
    : field === 'dropoffLocation' ? '[data-field="stop"][data-stop="1"]'
    : '[data-field="' + field + '"]';
  const input = page.locator('.ch-tl-title' + stopSel).nth(legIndex);
  await expect(input).toBeVisible({ timeout: 10000 });
  await input.click();
  await input.fill('');
  await page.keyboard.type(name, { delay: 10 });
  await expect(page.locator('.ch-ac-menu').first()).toBeVisible({ timeout: 5000 });
  await page.locator('.ch-ac-menu .ch-ac-item', { hasText: name }).first().click();
}

test('typing a place while a background render lands never commits the half-typed text', async ({ page }) => {
  const calls = { estimate: [], distance: [] };
  await stubOps(page, calls);

  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
  await page.locator('[data-action="setVehicle"][data-veh="car"]').click();
  await page.fill('#f-firstName', 'Test');
  await page.fill('#f-lastName', 'Customer');
  await page.fill('#f-contact', '+94771234567');
  await page.dispatchEvent('#f-contact', 'change');

  // Leg 1 fully priced.
  await pickPlace(page, 0, 'pickupLocation', 'Colombo City');
  await pickPlace(page, 0, 'dropoffLocation', 'Kandy');
  await expect(page.locator('.ch-dist-pill.auto').first()).toContainText('120 km', { timeout: 10000 });

  // Leg 2: commit the pickup (schedules auto-distance + estimate renders in the background)…
  await page.getByText('Add leg').click();
  await pickPlace(page, 1, 'pickupLocation', 'Kandy');

  // …then immediately type a partial drop-off, char by char, while those renders land.
  const dropoff = page.locator('.ch-tl-title[data-field="stop"][data-stop="1"]').nth(1);
  await dropoff.click();
  await page.keyboard.type(PARTIAL, { delay: 60 });

  // Let every debounce/blur timer fire (estimate 350ms, blur 200ms, distance stub 150ms).
  await page.waitForTimeout(1500);

  // The half-typed text must survive in the input (focus restore) …
  await expect(dropoff).toHaveValue(PARTIAL);

  // …and must NEVER have been committed to state: no distance lookup and no estimate leg
  // may carry the partial text. (On the unguarded code the orphaned input's delayed blur
  // commits it, which fires exactly these calls.)
  const partialDistance = calls.distance.filter((b) => (b.to || '').startsWith('Nuwara'));
  const partialEstimate = calls.estimate.filter((b) => (b.legs || []).some((l) => (l.to || '').startsWith('Nuwara')));
  expect(partialDistance).toEqual([]);
  expect(partialEstimate).toEqual([]);
});
