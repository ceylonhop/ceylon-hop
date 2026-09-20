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
  // the route header uses the shared public rounding contract, not minute-level precision
  await expect(page.locator('#route-meta')).toContainText('Approx. 270 km · 5h 30m');
  // The title states the SHORT display label ("pasikudah · Kalkudah"), not the full Google
  // address — on a phone the full formatted address set in display serif is a wall of text.
  // The full name still travels in the URL and the estimate intent (asserted in the next test).
  await expect(page.locator('#route-title')).toContainText('pasikudah · Kalkudah');
  await expect(page.locator('#route-title')).not.toContainText('Sri Lanka');
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

/*
  A baked pair asks the engine too (owner decision 2026-09-20, "Option A").

  It used to price from the catalogue alone and never touch the network. But hot zones are rows
  in the prod database, so the catalogue cannot know them: Kandy → Ella advertised $59.99 here
  and charged $66 on the booking page (+10% zone). The advertised price must be the price we
  charge, so the engine's answer is what the card shows. The catalogue price is the FALLBACK —
  engine off, unreachable, or slower than the cap — which is exactly what the page showed before.
*/
const stubHealth = (page) =>
  page.route('**/health', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));

test('a baked route advertises the engine price, so a hot-zone boost is never a surprise', async ({ page }) => {
  const intents = [];
  await page.route('**/quote/v2/estimate', async (r) => {
    const intent = JSON.parse(r.request().postData() || '{}');
    intents.push(intent);
    await r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        totalCents: intent.vehicle === 'van' ? 8800 : 6600,
        legs: [{ from: 'Kandy', to: 'Ella', distanceKm: 136, durationMin: 227 }],
      }),
    });
  });
  await stubHealth(page);

  await page.goto('/search.html?from=kandy&to=ella');
  const rows = page.locator('.opt-private .veh-row');
  await expect(rows.nth(0)).toContainText('$66');
  await expect(rows.nth(1)).toContainText('$88');
  await expect(page.locator('.opt-private.is-pending')).toHaveCount(0);
  // the unboosted catalogue fare is nowhere on the card
  await expect(page.locator('.opt-private')).not.toContainText('$59.99');

  // asked by catalogue NAME, smallest party — same contract as a free-text route
  expect(intents.map((i) => i.vehicle)).toEqual(['car', 'van']);
  expect(intents[0].legs).toEqual([{ from: 'Kandy', to: 'Ella' }]);
  expect(intents[0].pax).toBe(1);

  // Select hands booking the engine fare, and no unfinished catalogue figure alongside it —
  // booking reads rawPrice first, so a stale one would win over the price just shown.
  const href = await rows.nth(0).locator('a').getAttribute('href');
  const q = new URLSearchParams(href.split('?')[1]);
  expect(q.get('price')).toBe('66');
  expect(q.get('rawPrice')).toBeNull();
  expect(q.get('from')).toBe('kandy');               // still a catalogue route to booking
});

test('a baked route falls back to its catalogue price when the engine is off', async ({ page }) => {
  await page.route('**/quote/v2/estimate', (r) =>
    r.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
  await stubHealth(page);

  await page.goto('/search.html?from=cmb-airport&to=ella&pax=2');
  await expect(page.getByText('$140').first()).toBeVisible();
  await expect(page.locator('.opt-private.is-pending')).toHaveCount(0);
  const href = await page.locator('.opt-private .veh-row a').first().getAttribute('href');
  expect(new URLSearchParams(href.split('?')[1]).get('rawPrice')).not.toBeNull();
});

test('a slow engine never holds a baked route hostage, and a late answer does not move the price', async ({ page }) => {
  await page.route('**/quote/v2/estimate', async (r) => {
    await new Promise((res) => setTimeout(res, 5500));
    await r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ totalCents: 99900, legs: [{ from: 'Kandy', to: 'Ella', distanceKm: 136, durationMin: 227 }] }),
    }).catch(() => {});
  });
  await stubHealth(page);

  await page.goto('/search.html?from=cmb-airport&to=sigiriya');
  // While the price is out, only the two numbers wait — the shared seat is already there.
  await expect(page.locator('.opt-private.is-pending')).toHaveCount(1);
  await expect(page.locator('#shared-option')).toBeVisible();
  await expect(page.locator('#route-meta')).toContainText('Approx.');

  // the cap, then the catalogue fare
  await expect(page.locator('.opt-private.is-pending')).toHaveCount(0, { timeout: 6000 });
  const shown = await page.locator('.opt-private .veh-row').nth(0).locator('.amt').innerText();
  expect(shown).toMatch(/^\$\d/);

  // a price that has been SHOWN does not change under the traveller's cursor
  await page.waitForTimeout(2500);
  await expect(page.locator('.opt-private .veh-row').nth(0).locator('.amt')).toHaveText(shown);
  await expect(page.locator('.opt-private')).not.toContainText('$999');
});

test('on a phone the fares arriving do not move the shared card underneath them', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.route('**/quote/v2/estimate', async (r) => {
    const intent = JSON.parse(r.request().postData() || '{}');
    await new Promise((res) => setTimeout(res, 600));
    await r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        totalCents: intent.vehicle === 'van' ? 8999 : 6700,
        legs: [{ from: 'a', to: 'b', distanceKm: 152, durationMin: 195 }],
      }),
    });
  });
  await stubHealth(page);
  await page.goto('/search.html?from=cmb-airport&to=sigiriya');

  // One column on a phone: the private card sits ABOVE the shared one, so any height the
  // waiting card lacks is height the shared card gets shoved down by when the fares land.
  const top = () => page.locator('#shared-option').evaluate((el) => Math.round(el.getBoundingClientRect().top + window.scrollY));
  await expect(page.locator('.opt-private.is-pending')).toHaveCount(1);
  const before = await top();
  await expect(page.locator('.opt-private .veh-row').nth(0)).toContainText('$67');
  expect(Math.abs((await top()) - before), 'the shared card moved when the fares arrived').toBeLessThanOrEqual(1);
});

test('the shared saving is measured against the fare actually shown, not the catalogue', async ({ page }) => {
  // Negombo → Sigiriya: $27.49 a seat against a $65.50 catalogue car. A +10% zone makes the car
  // $72.05, so two travellers save ~24% by sharing — not the ~15% the catalogue fare implies.
  await page.route('**/quote/v2/estimate', async (r) => {
    const intent = JSON.parse(r.request().postData() || '{}');
    await new Promise((res) => setTimeout(res, 600));
    await r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        totalCents: intent.vehicle === 'van' ? 9600 : 7205,
        legs: [{ from: 'a', to: 'b', distanceKm: 148, durationMin: 194 }],
      }),
    });
  });
  await stubHealth(page);
  await page.goto('/search.html?from=negombo&to=sigiriya&pax=2');

  // While the fare it is measured against is unknown, the claim is not made — a percentage
  // that has been shown must not change any more than a price may.
  await expect(page.locator('.opt-private.is-pending')).toHaveCount(1);
  await expect(page.locator('.shared-save')).toBeHidden();

  await expect(page.locator('.opt-private .veh-row').nth(0)).toContainText('$72.05');
  await expect(page.locator('.shared-save')).toBeVisible();
  await expect(page.locator('.shared-save')).toHaveText(/Save ~24%/);
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

/*
  An engine route must not report a shared-seat finding it never made.

  `shared` is hardcoded null whenever either end is outside the baked catalogue
  (search.js:155) — a scheduled seat is a directed catalogue entry keyed on two
  catalogue ids, so the lookup is SKIPPED, not failed. The panel nonetheless
  printed "We don't run a scheduled shared service between X and Y right now".

  Owner-reported 2026-08-22: picking "Sigiriya, Sri Lanka" from Google instead of
  the catalogue's "Sigiriya / Dambulla" put that sentence on CMB → Sigiriya — one
  of the two corridors we do sell seats on, at $27.49/seat. The same sentence was
  firing on every Google-picked search, whatever the route.
*/
test('an engine route never claims we run no shared service', async ({ page }) => {
  await gotoBooking(page, {
    path: '/search.html',
    query: `from=cmb-airport&to=${encodeURIComponent('Sigiriya, Sri Lanka')}`,
    estimate: { respond: byVehicle },
  });

  const panel = page.locator('.noshare');
  await expect(panel).toBeVisible();
  await expect(panel).not.toContainText("We don't run a scheduled shared service");
  await expect(panel).not.toContainText('No shared seats on this route');
  // States the rule we can actually vouch for — and tells the traveller what to DO about it:
  // search the town, or go to the board. The old copy ("we can only match those
  // automatically") explained our limitation and left them nowhere to go.
  await expect(panel).toContainText('matched by town, not by hotel or address');
  await expect(panel.locator('a.ns-board')).toHaveAttribute('href', 'board.html');
});

test('a baked pair we truly do not serve still says so plainly', async ({ page }) => {
  // CMB → Galle is in the catalogue and has no scheduled seat: the lookup RAN and
  // came back empty, so the negative is a finding and stays stated as one.
  await gotoBooking(page, { path: '/search.html', query: 'from=cmb-airport&to=galle' });

  const panel = page.locator('.noshare');
  await expect(panel).toContainText('No shared seats on this route');
  await expect(panel).toContainText("We don't run a scheduled shared service");
  // ...but it is not a dead end: the board sells any route once 3 travellers are in, and it
  // pre-filters on place NAMES (board.js `filter`), so the link carries them.
  await expect(panel.locator('a.ns-board')).toHaveAttribute(
    'href', 'board.html?from=Colombo%20Airport%20(CMB)&to=Galle');
});

test('the shared card says which days it runs, and offers a phone-only jump to it', async ({ page }) => {
  await gotoBooking(page, { path: '/search.html', query: 'from=cmb-airport&to=sigiriya' });

  const card = page.locator('#shared-option');
  await expect(card).toContainText('Runs Wed & Sat');
  // This card leads to a pay-now checkout. "Nothing charged until it's confirmed" is the ride
  // board's promise (pre-approval) and must not be borrowed here.
  await expect(card).toContainText('pay now to reserve your seat');
  await expect(card).not.toContainText('nothing charged');
  // "One AC van" in the headline and "AC car or van" in the chips was the same card
  // describing two different vehicles.
  await expect(card).not.toContainText('AC car or van');

  // Desktop is two-up, so the jump link is hidden; at phone width the shared seat sits under
  // two private cards and the link is the only sign it exists.
  const jump = page.locator('a.shared-jump');
  await expect(jump).toBeHidden();
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(jump).toBeVisible();
  await expect(jump).toHaveAttribute('href', '#shared-option');
});
