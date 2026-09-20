import { test, expect } from '@playwright/test';
import { gotoBooking } from './_stubs.js';

// The board lookup (#638) was wired into the off-day shared card only. A route with NO scheduled
// van — Kandy → Ella, the board's own best seller — got a static "See the ride board" link and
// never asked, so a ride already gathering for that exact date was invisible from search.
// On a hit the panel becomes a real card: the searcher has never seen the board, so it must
// state a price, how many more it needs, and that nobody is charged unless it runs.
const ROUTE = 'from=kandy&to=ella';
const THU = '2099-08-13';
const panel = (page) => page.locator('.noshare');
const going = { code: 'KE-4242', corridorId: null, from: 'Kandy', to: 'Ella', date: THU,
  slot: 'morning', lockedTime: null, minSeats: 3, capacity: 6, seatPrice: 2450, status: 'gathering', note: null,
  cutoffAt: '2099-08-11T01:30:00.000Z', committed: 2,
  members: [{ position: 1, firstName: 'Anna', country: 'PL', photoUrl: null, isStarter: true }, { position: 2, firstName: 'Yuki', country: 'JP', photoUrl: null }] };
const dupe = (page, body, status = 200) => page.route('**/board/dupe**', (r) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }));

const rideCard = (page) => page.locator('#board-ride');

test('no scheduled van, but someone is already going that day: search shows their ride as a card', async ({ page }) => {
  let asked = null;
  await page.route('**/board/dupe**', (r) => { asked = new URL(r.request().url()); return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ list: going }) }); });
  await gotoBooking(page, { path: '/search.html', query: `${ROUTE}&date=${THU}` });
  const c = rideCard(page);
  // a first-time searcher gets a price and a plain noun, not board shorthand
  await expect(c.locator('.tag-top')).toHaveText('Travellers going Thu 13 Aug');
  await expect(c.locator('.shared-price')).toContainText('$24.50');
  await expect(c.locator('a.sb-hop')).toHaveAttribute('href', 'board.html#/KE-4242');
  await expect(c.locator('a.sb-hop')).toContainText('Join this ride');
  // the card REPLACES the "No shared seats" panel — the two must never sit together
  await expect(panel(page)).toHaveCount(0);
  await expect(page.locator('#results')).not.toContainText('No shared seats');
  expect(asked.searchParams.get('from')).toBe('Kandy');
  expect(asked.searchParams.get('to')).toBe('Ella');
  expect(asked.searchParams.get('date')).toBe(THU);
});

test('the card says how many more it needs, and that the card is only charged if it runs', async ({ page }) => {
  await dupe(page, { list: going });
  await gotoBooking(page, { path: '/search.html', query: `${ROUTE}&date=${THU}` });
  const c = rideCard(page);
  await expect(c.locator('.br-status b')).toHaveText('Needs 1 more traveller to run');
  await expect(c.locator('.br-status')).toContainText('2 of 3 seats filled');
  await expect(c.locator('.br-pips i')).toHaveCount(3);
  await expect(c.locator('.br-pips i.on')).toHaveCount(2);
  const steps = c.locator('.br-steps li');
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(0)).toContainText('No fare charged now');
  // the cutoff is 2099-08-11T01:30Z = Tue 11 Aug in Colombo
  await expect(steps.nth(1)).toContainText('We check on Tue 11 Aug');
  await expect(steps.nth(2)).toContainText('charged $24.50 a seat');
  await expect(steps.nth(2)).toContainText('Not enough travellers, no charge');
  await expect(c.locator('a.sb-hop')).toContainText('$0 today');
});

test('needing two says "travellers"; enough to run turns the strip positive', async ({ page }) => {
  await dupe(page, { list: { ...going, committed: 1 } });
  await gotoBooking(page, { path: '/search.html', query: `${ROUTE}&date=${THU}` });
  await expect(rideCard(page).locator('.br-status b')).toHaveText('Needs 2 more travellers to run');

  await page.unroute('**/board/dupe**');
  await dupe(page, { list: { ...going, committed: 4 } });
  await page.reload();
  const st = rideCard(page).locator('.br-status');
  await expect(st).toHaveClass(/is-go/);
  await expect(st.locator('b')).toHaveText('Enough travellers to run');
  await expect(st).toContainText('4 seats taken · 2 left · confirmed Tue 11 Aug');
  await expect(rideCard(page).locator('.br-pips i.on')).toHaveCount(4);
});

test('a saving is only claimed against a known party size', async ({ page }) => {
  await dupe(page, { list: going });
  await gotoBooking(page, { path: '/search.html', query: `${ROUTE}&date=${THU}` });
  await expect(rideCard(page)).toBeVisible();
  await expect(rideCard(page).locator('.shared-save')).toHaveCount(0);
  await gotoBooking(page, { path: '/search.html', query: `${ROUTE}&date=${THU}&pax=1` });
  await expect(rideCard(page).locator('.shared-save')).toContainText(/Save ~\d+% vs a private car/);
});

test('the saving waits for the fare it is measured against (#652: a shown percentage never changes)', async ({ page }) => {
  // A $24.50 seat, one traveller. The engine answers late, and with a zone-boosted $70 car.
  await page.route('**/quote/v2/estimate', async (r) => {
    const intent = JSON.parse(r.request().postData() || '{}');
    await new Promise((res) => setTimeout(res, 600));
    await r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ totalCents: intent.vehicle === 'van' ? 9000 : 7000, legs: [{ from: 'a', to: 'b', distanceKm: 135, durationMin: 225 }] }) });
  });
  await page.route('**/health', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  await dupe(page, { list: going });
  await page.goto(`/search.html?${ROUTE}&date=${THU}&pax=1`);
  await expect(page.locator('.opt-private.is-pending')).toHaveCount(1);
  await expect(rideCard(page)).toBeVisible();                       // the ride itself does not wait
  await expect(rideCard(page).locator('.shared-save')).toBeHidden();
  await expect(page.locator('.opt-private .veh-row').nth(0)).toContainText('$70');
  await expect(rideCard(page).locator('.shared-save')).toBeVisible();
  await expect(rideCard(page).locator('.shared-save')).toHaveText(/Save ~65%/);   // 1 − 24.50/70
});

test('a full van is not offered: the panel stays', async ({ page }) => {
  await dupe(page, { list: { ...going, committed: 6 } });
  await gotoBooking(page, { path: '/search.html', query: `${ROUTE}&date=${THU}` });
  await expect(panel(page).locator('a.ns-board')).toBeVisible();
  await expect(rideCard(page)).toHaveCount(0);
});

test('nobody going yet: the panel keeps its link to the board', async ({ page }) => {
  await dupe(page, { list: null });
  await gotoBooking(page, { path: '/search.html', query: `${ROUTE}&date=${THU}` });
  await expect(panel(page).locator('a.ns-board')).toHaveAttribute('href', 'board.html?from=Kandy&to=Ella');
  await expect(rideCard(page)).toHaveCount(0);
});

test('the lookup only ever upgrades the panel: an error leaves the link', async ({ page }) => {
  await dupe(page, {}, 500);
  await gotoBooking(page, { path: '/search.html', query: `${ROUTE}&date=${THU}` });
  await expect(panel(page).locator('a.ns-board')).toBeVisible();
  await expect(rideCard(page)).toHaveCount(0);
});

test('a ride that is no longer gathering is never offered as "Hop on"', async ({ page }) => {
  await dupe(page, { list: { ...going, status: 'confirmed' } });
  await gotoBooking(page, { path: '/search.html', query: `${ROUTE}&date=${THU}` });
  await expect(panel(page).locator('a.ns-board')).toBeVisible();
  await expect(rideCard(page)).toHaveCount(0);
});

test('no date searched: nothing to match a ride against, so the board is not asked', async ({ page }) => {
  let calls = 0;
  await page.route('**/board/dupe**', (r) => { calls++; return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ list: going }) }); });
  await gotoBooking(page, { path: '/search.html', query: ROUTE });
  await expect(panel(page).locator('a.ns-board')).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(calls).toBe(0);
  await expect(rideCard(page)).toHaveCount(0);
});
