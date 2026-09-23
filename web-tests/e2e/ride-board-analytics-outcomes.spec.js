import { test, expect } from '@playwright/test';
import { isApiRequest } from './_api-host.js';

// Ride-board GA4 outcomes (2026-09-22).
//
// In production every join and every start goes through PayHere: board.js hands off, PayHere
// sends the traveller back, and the page polls until the signed callback has landed. That return
// path never fired join_ride / create_ride_list — so GA4 counted almost none of the board's real
// conversions. And a refused join ("That list just closed", EA-8707) or a card approval that
// didn't complete fired nothing at all.

const list = {
  code: 'GM-2468', corridorId: 'south-coast', from: 'Galle', to: 'Mirissa',
  date: '2099-01-01', slot: 'morning', lockedTime: null, minSeats: 3, capacity: 6,
  seatPrice: 1400, status: 'gathering', note: null,
  cutoffAt: '2098-12-30T00:00:00.000Z', committed: 1,
  members: [{ position: 1, firstName: 'Ana', country: 'DE', photoUrl: null, seats: 1, isStarter: true, isYou: false }],
};

const ok = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function stubBoard(page, extra) {
  await page.route((u) => isApiRequest(new URL(u.href)), async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    // `extra` answers the one path a test is about with a fulfill spec, or nothing.
    const special = extra(path, req);
    if (special) return route.fulfill(special);
    if (path === '/board/me') return route.fulfill(ok({ me: { firstName: 'Roshen', country: 'GB', photo: null } }));
    if (path === '/board' && req.method() === 'GET') return route.fulfill(ok({ lists: [list] }));
    if (path === `/board/${list.code}` && req.method() === 'GET') return route.fulfill(ok(list));
    if (path === '/board/mine') return route.fulfill(ok({ lists: [] }));
    return route.fulfill(ok({}));
  });
}

const events = (page, name) =>
  page.evaluate((n) => (window.dataLayer || []).filter((e) => e && e.event === n), name);

test('a join completed through PayHere fires join_ride, once, marked as via PayHere', async ({ page }) => {
  const joined = {
    ...list, committed: 3,
    members: [...list.members,
      { position: 2, firstName: 'Roshen', country: 'GB', photoUrl: null, seats: 2, isStarter: false, isYou: true }],
  };
  await stubBoard(page, (path) =>
    path === '/board/payments/RBPA-test' && (ok({ status: 'succeeded', list: joined, manageToken: 't' })));

  await page.goto('/board.html?ridePayment=RBPA-test');
  await expect(page.locator('#done-head')).toBeVisible({ timeout: 10000 });

  await expect.poll(() => events(page, 'join_ride')).toHaveLength(1);
  expect((await events(page, 'join_ride'))[0]).toMatchObject({
    item_list_id: 'ride_board', item_id: list.code, quantity: 2, value: 28,
    seats_committed: 3, seats_needed: 3, van_runs: true, via: 'payhere',
  });
  expect(await events(page, 'create_ride_list')).toHaveLength(0);
});

// Every value on the board's GA4 events read `L.seatPrice`, a field normalizeList() never sets
// (it is `seatPriceCents`), so join_ride, create_ride_list and begin_checkout all reported $0.
test('begin_checkout carries the seat price, not zero', async ({ page }) => {
  await stubBoard(page, () => null);
  await page.goto('/board.html');
  await page.locator(`[data-view="${list.code}"]`).click();
  await page.locator('[data-detail-join]').last().click();
  await expect.poll(() => events(page, 'begin_checkout')).toHaveLength(1);
  expect((await events(page, 'begin_checkout'))[0]).toMatchObject({ flow: 'join_list', item_id: list.code, value: 14 });
});

test('a ride started through PayHere fires create_ride_list', async ({ page }) => {
  const started = {
    ...list, committed: 1,
    members: [{ position: 1, firstName: 'Roshen', country: 'GB', photoUrl: null, seats: 1, isStarter: true, isYou: true }],
  };
  await stubBoard(page, (path) =>
    path === '/board/payments/RBPA-new' && (ok({ status: 'succeeded', list: started, manageToken: 't' })));

  await page.goto('/board.html?ridePayment=RBPA-new');
  await expect(page.locator('#done-head')).toBeVisible({ timeout: 10000 });
  await expect.poll(() => events(page, 'create_ride_list')).toHaveLength(1);
  expect(await events(page, 'join_ride')).toHaveLength(0);
});

test('a card approval cancelled at PayHere is counted', async ({ page }) => {
  await stubBoard(page, (path) =>
    path === '/board/payments/RBPA-test/cancel' && (ok({ ok: true })));
  await page.goto('/board.html?ridePayment=RBPA-test&cancelled=1');
  await expect.poll(() => events(page, 'ride_board_payment_failed')).toHaveLength(1);
  expect((await events(page, 'ride_board_payment_failed'))[0]).toMatchObject({ item_list_id: 'ride_board', reason: 'cancelled' });
});

test('a card approval that did not complete is counted', async ({ page }) => {
  await stubBoard(page, (path) =>
    path === '/board/payments/RBPA-test' && (ok({ status: 'failed', error: 'payment_expired' })));
  await page.goto('/board.html?ridePayment=RBPA-test');
  await expect.poll(() => events(page, 'ride_board_payment_failed')).toHaveLength(1);
  expect((await events(page, 'ride_board_payment_failed'))[0]).toMatchObject({ reason: 'payment_expired' });
});

test('a join refused because the list closed fires ride_board_refused with the reason', async ({ page }) => {
  await stubBoard(page, (path) =>
    path === `/board/${list.code}/join` &&
      ({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'closed' }) }));

  await page.goto('/board.html');
  await page.locator(`[data-view="${list.code}"]`).click();
  await page.locator('[data-detail-join]').last().click();
  await page.selectOption('#pay-cc', '+44');
  await page.fill('#pay-phone', '7700 900123');
  await page.fill('#pay-city', 'London');
  await page.fill('#pay-address', '12 River Street');
  await page.locator('#sign-btn').click();

  await expect.poll(() => events(page, 'ride_board_refused')).toHaveLength(1);
  expect((await events(page, 'ride_board_refused'))[0]).toMatchObject({
    item_list_id: 'ride_board', flow: 'join_list', item_id: list.code, reason: 'closed', http_status: 409,
  });
});
