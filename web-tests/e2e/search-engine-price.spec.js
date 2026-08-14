import { test, expect } from '@playwright/test';
import { gotoBooking, blockLiveApi } from './_stubs.js';

/*
  A single leg now ALWAYS lands on search.html.

  It used to land there only when BOTH places were in the baked catalogue; anything else — a
  place picked from Google, e.g. "pasikudah, Kalkudah, Sri Lanka" — diverted the whole search
  to the itinerary planner. So the same two points behaved differently depending on which
  places they happened to be, and someone who typed a real destination we simply don't have
  baked got a trip builder instead of the price they asked for.

  The catalogue can't price an arbitrary place, so the engine does: POST /quote/v2/estimate
  resolves the distance server-side and prices it without persisting anything. Two calls, one
  per vehicle, because the card offers both and an intent names exactly one.

  The rule that keeps this honest: there is NO local fallback for a place with no baked
  distance, so a failed estimate must produce a human hand-off, never an invented number.
*/

const UNKNOWN = 'pasikudah, Kalkudah, Sri Lanka';

// price by vehicle so the two cards can be told apart
const byVehicle = (intent) => ({
  totalCents: intent.vehicle === 'van' ? 21000 : 15500,
  legs: [{ from: intent.legs[0].from, to: intent.legs[0].to, distanceKm: 271, durationMin: 320 }],
});

test('an unknown place keeps a single leg on the search page', async ({ page }) => {
  await blockLiveApi(page);
  await page.goto('/index.html');
  await page.locator('#q-from').fill('Colombo Airport (CMB)');
  await page.locator('#q-to').fill(UNKNOWN);
  await page.locator('#go-btn').click();

  await page.waitForURL(/search\.html\?/);
  const q = new URL(page.url()).searchParams;
  expect(q.get('from')).toBe('cmb-airport');       // known end still travels as its id
  expect(q.get('to')).toBe(UNKNOWN);               // unknown end travels as its name
});

test('an engine-priced route shows a price for each vehicle', async ({ page }) => {
  await gotoBooking(page, {
    path: '/search.html',
    query: `from=cmb-airport&to=${encodeURIComponent(UNKNOWN)}`,
    estimate: { respond: byVehicle },
  });

  await expect(page.locator('.opt-private .veh-row').nth(0)).toContainText('$155');
  await expect(page.locator('.opt-private .veh-row').nth(1)).toContainText('$210');
  // the route header states the measured distance the engine came back with
  await expect(page.locator('#route-meta')).toContainText('~271 km');
  await expect(page.locator('#route-title')).toContainText(UNKNOWN);
  // and the skeleton is gone
  await expect(page.locator('.opt-private.is-pending')).toHaveCount(0);
});

test('the estimate asks for the fare of the vehicle on the card, not a guessed party', async ({ page }) => {
  const intents = [];
  await page.route('**/quote/v2/estimate', async (r) => {
    const intent = JSON.parse(r.request().postData() || '{}');
    intents.push(intent);
    await r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(byVehicle(intent)),
    });
  });
  await page.route('**/health', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.goto(`/search.html?from=cmb-airport&to=${encodeURIComponent(UNKNOWN)}`);
  await expect(page.locator('.opt-private .veh-row').nth(1)).toContainText('$210');

  expect(intents.map((i) => i.vehicle).sort()).toEqual(['car', 'van']);
  for (const i of intents) {
    expect(i.product).toBe('private');
    // pax/bags only ever UPGRADE the vehicle in the engine, so the smallest party is the only
    // value that returns the fare for the vehicle actually being shown.
    expect(i.pax).toBe(1);
    expect(i.bags).toBe(0);
    expect(i.legs).toEqual([{ from: 'Colombo Airport (CMB)', to: UNKNOWN }]);
  }
});

test('a route we cannot price offers a human, not a number', async ({ page }) => {
  await gotoBooking(page, {
    path: '/search.html',
    query: `from=cmb-airport&to=${encodeURIComponent(UNKNOWN)}`,
    estimate: { status: 404 },
  });

  const card = page.locator('.opt-unpriced');
  await expect(card).toBeVisible();
  await expect(card).toContainText("couldn't work out a live price");
  await expect(card.locator('a[href*="wa.me"]')).toBeVisible();
  // nothing that looks like a fare anywhere in the results
  await expect(page.locator('#results')).not.toContainText('$');
  await expect(page.locator('#results .sk-amt')).toHaveCount(0);
});

test('an engine-priced route offers no shared seat', async ({ page }) => {
  await gotoBooking(page, {
    path: '/search.html',
    query: `from=cmb-airport&to=${encodeURIComponent(UNKNOWN)}`,
    estimate: { respond: byVehicle },
  });

  // A shared seat is a scheduled corridor in the baked table; it cannot exist for a place we
  // have no corridor for. The "no shared seats" panel takes that slot instead.
  await expect(page.locator('.opt-shared')).toHaveCount(0);
  await expect(page.locator('.noshare')).toBeVisible();
});

test('a baked route still prices instantly, with no network round trip', async ({ page }) => {
  let called = 0;
  await page.route('**/quote/v2/estimate', (r) => {
    called += 1;
    return r.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/health', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));

  await page.goto('/search.html?from=cmb-airport&to=ella&pax=2');
  await expect(page.getByText('$139').first()).toBeVisible();
  await expect(page.locator('.opt-private.is-pending')).toHaveCount(0);

  // ch-pricing debounces 400ms; give it more than that to prove nothing was ever asked for
  await page.waitForTimeout(900);
  expect(called, 'a baked pair must not pay for an API round trip').toBe(0);
});

test('an engine price carries the free-text place through to booking', async ({ page }) => {
  await gotoBooking(page, {
    path: '/search.html',
    query: `from=cmb-airport&to=${encodeURIComponent(UNKNOWN)}`,
    estimate: { respond: byVehicle },
  });

  const select = page.locator('.opt-private .veh-row').nth(0).locator('a');
  const href = await select.getAttribute('href');
  const q = new URLSearchParams(href.split('?')[1]);
  expect(q.get('to')).toBe(UNKNOWN);
  expect(q.get('mode')).toBe('private');
  expect(q.get('vehicle')).toBe('car');
  expect(q.get('price')).toBe('155');
  // No unfinished fare exists for an engine price, and "rawPrice=null" would parseFloat to 0 —
  // a free transfer. It must be absent, not null.
  expect(q.has('rawPrice')).toBe(false);
});
