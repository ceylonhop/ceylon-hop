import { test, expect } from '@playwright/test';
import { isApiRequest } from './_api-host.js';

// The ride board's phone refusals (2026-09-24).
//
// #761 made POST /board and POST /board/:code/join answer 400 phone_invalid for a number that is
// not + then 6–15 digits. A missing number has answered 400 phone_required since #755. board.js
// had a branch for neither, so both fell through to "Couldn't add your name / Try again in a
// moment": advice that cannot work for a number the traveller has to retype. And report()
// beaconed each one to /errors/client as a fault, because 400 is not one of its quiet statuses.

const list = {
  code: 'GM-2468', corridorId: 'south-coast', from: 'Galle', to: 'Mirissa',
  date: '2099-01-01', slot: 'morning', lockedTime: null, minSeats: 3, capacity: 6,
  seatPrice: 1400, status: 'gathering', note: null,
  cutoffAt: '2098-12-30T00:00:00.000Z', committed: 1,
  members: [{ position: 1, firstName: 'Ana', country: 'DE', photoUrl: null, seats: 1, isStarter: true, isYou: false }],
};

const ok = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
const refusal = (body) => ({ status: 400, contentType: 'application/json', body: JSON.stringify(body) });
const RULE = 'Phone number must be + followed by 6–15 digits (e.g. +94771234567)';

// Signed in, one open ride, and the join + error-report calls counted. sendBeacon is removed so
// report()'s /errors/client call takes its fetch fallback: page.route() sees a fetch, not a beacon.
async function stubBoard(page, joinAnswer) {
  const seen = { joins: 0, errorReports: 0 };
  await page.addInitScript(() => { delete navigator.__proto__.sendBeacon; navigator.sendBeacon = undefined; });
  await page.route((u) => isApiRequest(new URL(u.href)), async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (p === '/errors/client') { seen.errorReports++; return route.fulfill({ status: 204, body: '' }); }
    if (p === `/board/${list.code}/join`) { seen.joins++; return route.fulfill(joinAnswer); }
    if (p === '/board/me') return route.fulfill(ok({ me: { firstName: 'Roshen', country: 'GB', photo: null } }));
    if (p === '/board' && req.method() === 'GET') return route.fulfill(ok({ lists: [list] }));
    if (p === `/board/${list.code}` && req.method() === 'GET') return route.fulfill(ok(list));
    if (p === '/board/mine') return route.fulfill(ok({ lists: [] }));
    return route.fulfill(ok({}));
  });
  return seen;
}

const events = (page, name) =>
  page.evaluate((n) => (window.dataLayer || []).filter((e) => e && e.event === n), name);

async function joinWith(page, phone) {
  await page.goto('/board.html');
  await page.locator(`[data-view="${list.code}"]`).click();
  await page.locator('[data-detail-join]').last().click();
  await page.selectOption('#pay-cc', '+44');
  await page.fill('#pay-phone', phone);
  await page.fill('#pay-city', 'London');
  await page.fill('#pay-address', '12 River Street');
  await page.locator('#sign-btn').click();
}

for (const body of [{ error: 'phone_invalid', message: RULE }, { error: 'phone_required' }]) {
  test(`a join refused as ${body.error} asks for the number again, cursor in it, and reports nothing`, async ({ page }) => {
    const seen = await stubBoard(page, refusal(body));
    await joinWith(page, '7700 900123');

    const err = page.locator('#sheet-err');
    await expect(err).toContainText('Check your phone number');
    await expect(err).toContainText('Use your country code and number, e.g. +94 77 123 4567.');
    // Back on the form they have to correct, the cursor in the box to retype, their number kept.
    await expect(page.locator('#mstep-2')).toBeVisible();
    await expect(page.locator('#pay-phone')).toBeFocused();
    await expect(page.locator('#pay-phone')).toHaveValue('7700 900123');
    expect(seen.joins).toBe(1);

    // Still counted as a refusal, with its reason. Not reported as a fault: report() pushes an
    // `exception` event before it beacons, so an empty list means it never ran.
    await expect.poll(() => events(page, 'ride_board_refused')).toHaveLength(1);
    expect((await events(page, 'ride_board_refused'))[0]).toMatchObject({ reason: body.error, http_status: 400 });
    expect(await events(page, 'exception')).toHaveLength(0);
    expect(seen.errorReports).toBe(0);
  });
}

// The API check is the backstop, not the first line: a number that cannot pass is refused on the
// page, before the PayHere hand-off screen goes up and before the request goes out.
for (const [what, typed] of [
  ['too short (+44 then 123 is 5 digits)', '123'],
  ['too long (the CH-T74DT number, 26 digits)', '+94123134124123412312312312'],
]) {
  test(`a number ${what} is refused before anything is sent`, async ({ page }) => {
    // Answer as the API would, so only the request count can tell a page refusal from the API's.
    const seen = await stubBoard(page, refusal({ error: 'phone_invalid', message: RULE }));
    await joinWith(page, typed);

    await expect(page.locator('#sheet-err')).toContainText('Check your phone number');
    await expect(page.locator('#pay-phone')).toBeFocused();
    expect(seen.joins).toBe(0);
  });
}
