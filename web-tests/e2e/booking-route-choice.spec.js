import { test, expect } from '@playwright/test';
import { gotoBooking, fillContact, pickPlace } from './_stubs.js';
import { futureIsoDate } from '../dates.js';

/*
  Customer route choice, 3/5: the booking page reads the road the customer chose (search's
  `road=no_tolls`, the planner's `roads=`), prices it, shows it, and books it.

  The estimate stub echoes the road it priced on each leg, as the API does: 213 km for the
  local road, 335 km for the expressway, at 42 cents a km. `fastest: true` makes it answer
  with the expressway whatever was asked — the "local road isn't available here" echo.
*/

const LOCAL_KM = 213;
const EXPRESS_KM = 335;

function echoRoads({ fastest = false } = {}) {
  return (intent) => {
    const legs = (intent.legs || []).map((l) => {
      const routeVariant = fastest ? 'fastest' : (l.routeVariant || 'fastest');
      const distanceKm = routeVariant === 'no_tolls' ? LOCAL_KM : EXPRESS_KM;
      return { from: l.from, to: l.to, distanceKm, durationMin: distanceKm, routeVariant };
    });
    const km = legs.reduce((s, l) => s + l.distanceKm, 0) || EXPRESS_KM;
    return { totalCents: km * 42, legs };
  };
}

// Every estimate intent the page posts, in order.
function captureIntents(page) {
  const intents = [];
  page.on('request', (r) => {
    if (r.url().includes('/quote/v2/estimate') && r.method() === 'POST') {
      try { intents.push(JSON.parse(r.postData() || '{}')); } catch { /* not ours */ }
    }
  });
  return intents;
}

// The local-road and catalogue (expressway) car/van fares for cmb-airport → ella, as the page
// prints them in the capacity hint.
async function vanFares(page) {
  return page.evaluate((localKm) => {
    const T = window.TRANSFERS;
    return { local: window.money(T.legPrice(localKm, 'van')), catalogue: window.money(T.privateQuote('cmb-airport', 'ella').rawVan) };
  }, LOCAL_KM);
}

const SINGLE = 'mode=private&from=cmb-airport&to=ella&vehicle=car&price=89.46&road=no_tolls&estimateKm=213&estimateMin=374';
const TRIP = [
  'mode=trip',
  'stops=Colombo%20Airport%20(CMB)%7CElla%7CYala',
  'nights=0,1,0',
  `dates=${futureIsoDate(30)},${futureIsoDate(32)}`,
  'roads=no_tolls,',
  'pax=2',
  'vehicle=car',
].join('&');

const SINGLE_COPY = 'Via the local road · no expressway';
const ECHO_COPY = 'The local road isn’t available for these exact points, so this is the expressway fare.';
const CHAUFFEUR_COPY = 'Local roads apply to private transfers, so a chauffeur-guide takes the usual roads.';

test('a single transfer on the local road asks the engine for it and says so in the summary', async ({ page }) => {
  const intents = captureIntents(page);
  await gotoBooking(page, { query: SINGLE, estimate: { respond: echoRoads() } });

  await expect.poll(() => intents.length).toBeGreaterThan(0);
  expect(intents[0].legs[0].routeVariant).toBe('no_tolls');
  await expect(page.locator('#sum-road')).toBeVisible();
  await expect(page.locator('#sum-road')).toHaveText(SINGLE_COPY);
  await expect(page.locator('#sum-road-note')).toBeHidden();
});

test('when the engine can only price the expressway, the page says so and stops asking for the local road', async ({ page }) => {
  const intents = captureIntents(page);
  await gotoBooking(page, { query: SINGLE, estimate: { respond: echoRoads({ fastest: true }) } });

  await expect(page.locator('#sum-road-note')).toBeVisible();
  await expect(page.locator('#sum-road-note')).toHaveText(ECHO_COPY);
  await expect(page.locator('#sum-road')).toBeHidden();
  // The next estimate is for the road the customer will actually get.
  await expect.poll(() => intents.length).toBeGreaterThan(1);
  expect(intents[0].legs[0].routeVariant).toBe('no_tolls');
  expect(intents[intents.length - 1].legs[0]).not.toHaveProperty('routeVariant');
  // The distance line describes the road now priced, not search's local-road figures.
  await expect(page.locator('#sum-route-estimate')).toContainText(`${EXPRESS_KM} km`);
  await expect(page.locator('#sum-route-estimate')).not.toContainText('215 km');
  // …and so does the van upsell: four travellers outgrow the car.
  const fares = await vanFares(page);
  expect(fares.local).not.toBe(fares.catalogue);
  await page.evaluate(() => { window.goStep(3); window.step('ad', 1); window.step('ad', 1); window.step('ad', 1); });
  await expect(page.locator('#cap-note')).toContainText(`Switch to AC van · ~${fares.catalogue}`);
  await expect(page.locator('#cap-note')).not.toContainText(fares.local);
});

// The echo that matters most in practice: an exact spot the local road can't serve. The dearer
// expressway figure is a raise the customer didn't drive, so it waits behind the gate — and
// accepting it must land on the echoed total (the parked figure is keyed to the NEW intent).
test('an exact spot that loses the local road parks the dearer fare, and accepting it keeps that fare', async ({ page }) => {
  // The follow-up estimate for the new (expressway) intent is held back, so the accept below is
  // settled by the PARKED figure alone — which only lands if it was parked against the new intent.
  const echo = (intent) => {
    const pinned = /Result/.test(intent.legs[0].to);
    const out = echoRoads({ fastest: pinned })(intent);
    return pinned && !intent.legs[0].routeVariant ? { ...out, delayMs: 8000 } : out;
  };
  await gotoBooking(page, { query: SINGLE, pickGeo: { lat: 6.87, lng: 81.05 }, estimate: { respond: echo } });
  await expect(page.locator('#sum-total')).toHaveText('$89.46');

  await pickPlace(page, '#loc-to', 'ac-to', 'Ella hotel', 1);

  await expect(page.locator('#engine-reprice-note')).toBeVisible();
  await expect(page.locator('#sum-total')).toHaveText('$89.46');
  await expect(page.locator('#sum-road-note')).toHaveText(ECHO_COPY);
  await expect(page.locator('#sum-road')).toBeHidden();

  await page.locator('#engine-reprice-note button').click();

  await expect(page.locator('#sum-total')).toHaveText('$140.70', { timeout: 2000 });
  await expect(page.locator('#engine-reprice-note')).toHaveCount(0);
});

test('the single booking carries the local road', async ({ page }) => {
  await gotoBooking(page, { query: SINGLE, estimate: { respond: echoRoads() } });
  await expect(page.locator('#sum-road')).toHaveText(SINGLE_COPY);
  await fillContact(page);
  const bookP = page.waitForRequest('**/bookings/single');
  await page.click('#pay-btn');
  const body = JSON.parse((await bookP).postData() || '{}');
  expect(body.routeVariant).toBe('no_tolls');
});

test('a trip asks for the local road on the chosen legs only and books one road per stop pair', async ({ page }) => {
  const intents = captureIntents(page);
  await gotoBooking(page, { query: TRIP, estimate: { respond: echoRoads() } });

  await expect.poll(() => intents.length).toBeGreaterThan(0);
  expect(intents[0].legs).toEqual([
    { from: 'Colombo Airport (CMB)', to: 'Ella', routeVariant: 'no_tolls' },
    { from: 'Ella', to: 'Yala' },
  ]);
  await expect(page.locator('#sum-road')).toBeVisible();
  await expect(page.locator('#sum-road')).toContainText('Local road for ');
  await expect(page.locator('#sum-road')).toContainText('Ella');
  await expect(page.locator('#sum-road')).not.toContainText('Yala');

  await fillContact(page);
  const bookP = page.waitForRequest('**/bookings/trip');
  await page.click('#pay-btn');
  const body = JSON.parse((await bookP).postData() || '{}');
  expect(body.routeVariants).toEqual(['no_tolls', 'fastest']);
});

// The estimate has no leg for a gap wire, so its legs must be matched to wires by skipping gaps —
// and a gap wire never asks for the local road, whatever the link says.
const GAP_TRIP = [
  'mode=trip',
  'stops=Colombo%20Airport%20(CMB)%7CKandy%7CElla%7CYala',
  'nights=0,1,1,0',
  'gaps=0',
  'kms=,213,213',
  'roads=no_tolls,no_tolls,no_tolls',
  'pax=2',
  'vehicle=car',
].join('&');
// The engine can't confirm the local road for Ella → Yala: it prices (and echoes) the expressway.
function echoExceptEllaYala(intent) {
  const legs = (intent.legs || []).map((l) => (l.from === 'Ella' && l.to === 'Yala' ? { from: l.from, to: l.to } : l));
  return echoRoads()({ ...intent, legs });
}

test('on a trip with a gap, only the leg the engine could not confirm drops its local road', async ({ page }) => {
  const intents = captureIntents(page);
  await gotoBooking(page, { query: GAP_TRIP, estimate: { respond: echoExceptEllaYala } });

  await expect(page.locator('#sum-road-note')).toHaveText(ECHO_COPY);
  await expect(page.locator('#sum-road')).toContainText('Kandy');
  await expect(page.locator('#sum-road')).not.toContainText('Yala');
  await expect(page.locator('#sum-road')).not.toContainText('Colombo');
  await expect.poll(() => intents.length).toBeGreaterThan(1);
  expect(intents[0].legs).toEqual([
    { from: 'Kandy', to: 'Ella', routeVariant: 'no_tolls' },
    { from: 'Ella', to: 'Yala', routeVariant: 'no_tolls' },
  ]);
  expect(intents[intents.length - 1].legs).toEqual([
    { from: 'Kandy', to: 'Ella', routeVariant: 'no_tolls' },
    { from: 'Ella', to: 'Yala' },
  ]);
  // The dropped leg's chip shows the road now priced; the kept one keeps the local km.
  await expect(page.locator('.tr-leg[data-wire="2"] .tr-drive')).toContainText(`${EXPRESS_KM} km`);
  await expect(page.locator('.tr-leg[data-wire="1"] .tr-drive')).toContainText(`${LOCAL_KM} km`);

  await fillContact(page);
  const bookP = page.waitForRequest('**/bookings/trip');
  await page.click('#pay-btn');
  const body = JSON.parse((await bookP).postData() || '{}');
  expect(body.routeVariants).toEqual(['fastest', 'no_tolls', 'fastest']);
});

test('after a road is dropped, the planner link carries only the roads still chosen', async ({ page }) => {
  await gotoBooking(page, { query: GAP_TRIP, estimate: { respond: echoExceptEllaYala } });
  await expect(page.locator('#sum-road-note')).toHaveText(ECHO_COPY);
  await page.locator('.tr-edit').click();
  await page.waitForURL(/plan\.html\?/);
  expect(new URL(page.url()).searchParams.get('roads')).toBe(',no_tolls,');
});

test('a chauffeur-guide trip drops the local road and says why', async ({ page }) => {
  await gotoBooking(page, { query: TRIP, estimate: { respond: echoRoads() } });
  await expect(page.locator('#sum-road')).toBeVisible();

  await page.locator('[data-svc="chauffeur"]').click();

  await expect(page.locator('#sum-road')).toBeHidden();
  await expect(page.locator('#sum-road-note')).toBeVisible();
  await expect(page.locator('#sum-road-note')).toHaveText(CHAUFFEUR_COPY);

  await fillContact(page);
  const bookP = page.waitForRequest('**/bookings/trip');
  await page.click('#pay-btn');
  const body = JSON.parse((await bookP).postData() || '{}');
  expect(body.serviceType).toBe('chauffeur');
  expect(body).not.toHaveProperty('routeVariants');
});

test('a booking refused because the local road cannot be confirmed shows why and re-prices on the expressway', async ({ page }) => {
  const intents = captureIntents(page);
  await gotoBooking(page, { query: SINGLE, estimate: { respond: echoRoads() } });
  await page.route('**/bookings/single', (r) => r.fulfill({
    status: 422,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'route_choice_unavailable', message: 'X' }),
  }));
  await expect(page.locator('#sum-road')).toHaveText(SINGLE_COPY);
  await fillContact(page);
  await page.click('#pay-btn');

  await expect(page.locator('#ph-msg')).toHaveText('X');
  // No one-click retry: the customer has to see the new price and press Pay again.
  await expect(page.locator('#ph-retry')).toBeHidden();
  await expect(page.locator('#sum-road')).toBeHidden();
  await expect.poll(() => {
    const last = intents[intents.length - 1];
    return last && last.legs && !('routeVariant' in last.legs[0]);
  }).toBe(true);

  // The distance line goes back to the catalogue (expressway) figures.
  const catalogueText = await page.evaluate(() => {
    const q = window.TRANSFERS.privateQuote('cmb-airport', 'ella');
    return window.CH.routeEstimate.formatRouteEstimate({ distanceKm: q.km, durationMin: q.durationMin, state: 'browse' });
  });
  await expect(page.locator('#sum-route-estimate')).toHaveText(catalogueText);
  await expect(page.locator('#sum-route-estimate')).not.toContainText('215 km');

  // Pay stays shut until the customer has reviewed the expressway fare.
  await page.locator('#ph-close').click();
  await expect(page.locator('#engine-reprice-note')).toBeVisible();
  await expect(page.locator('#pay-btn')).toBeDisabled();
  await page.locator('#engine-reprice-note button').click();
  await expect(page.locator('#sum-total')).toHaveText('$140.70');
  await expect(page.locator('#pay-btn')).toBeEnabled();
});

test('going back to the planner keeps the chosen roads', async ({ page }) => {
  await gotoBooking(page, { query: TRIP, estimate: { respond: echoRoads() } });
  await page.locator('.tr-edit').click();
  await page.waitForURL(/plan\.html\?/);
  expect(new URL(page.url()).searchParams.get('roads')).toBe('no_tolls,');
});
