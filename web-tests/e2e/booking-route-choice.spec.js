import { test, expect } from '@playwright/test';
import { gotoBooking, fillContact } from './_stubs.js';
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

// The estimate has no leg for a gap wire, so its legs must be matched to wires by skipping gaps.
test('on a trip with a gap, only the leg the engine could not confirm drops its local road', async ({ page }) => {
  const query = [
    'mode=trip',
    'stops=Colombo%20Airport%20(CMB)%7CKandy%7CElla%7CYala',
    'nights=0,1,1,0',
    'gaps=0',
    'roads=,no_tolls,no_tolls',
    'pax=2',
    'vehicle=car',
  ].join('&');
  const intents = captureIntents(page);
  const echo = echoRoads();
  await gotoBooking(page, {
    query,
    estimate: {
      respond: (intent) => {
        const out = echo(intent);
        for (const l of out.legs) if (l.from === 'Ella' && l.to === 'Yala') l.routeVariant = 'fastest';
        return out;
      },
    },
  });

  await expect(page.locator('#sum-road-note')).toHaveText(ECHO_COPY);
  await expect(page.locator('#sum-road')).toContainText('Kandy');
  await expect(page.locator('#sum-road')).not.toContainText('Yala');
  await expect.poll(() => intents.length).toBeGreaterThan(1);
  expect(intents[intents.length - 1].legs).toEqual([
    { from: 'Kandy', to: 'Ella', routeVariant: 'no_tolls' },
    { from: 'Ella', to: 'Yala' },
  ]);
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
});

test('going back to the planner keeps the chosen roads', async ({ page }) => {
  await gotoBooking(page, { query: TRIP, estimate: { respond: echoRoads() } });
  await page.locator('.tr-edit').click();
  await page.waitForURL(/plan\.html\?/);
  expect(new URL(page.url()).searchParams.get('roads')).toBe('no_tolls,');
});
