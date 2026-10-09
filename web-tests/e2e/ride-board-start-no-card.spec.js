import { test, expect } from '@playwright/test';
import { isApiRequest } from './_api-host.js';

// Owner 2026-10-07: starting a ride takes no card. Every abandoned start in the attempt log died on
// the PayHere page, and the ride it would have made stayed hidden where nobody could join it. The
// start sheet asks only for a phone number, never hands off to PayHere, and tells the starter that
// a payment link comes if the van runs. Joining an existing ride still approves a card.

const FROM = 'Negombo', TO = 'Sigiriya / Dambulla';
const THU = '2099-08-13';
const startLink = '/board.html?from=' + encodeURIComponent(FROM) + '&to=' + encodeURIComponent(TO) + '&date=' + THU + '&start=1';

const created = {
  code: 'NS-1234', corridorId: 'airport-cultural', from: FROM, to: TO,
  date: THU, slot: 'morning', lockedTime: null, minSeats: 3, capacity: 6,
  seatPrice: 2749, status: 'gathering', note: null,
  cutoffAt: '2099-08-11T01:30:00.000Z', committed: 1,
  members: [{ position: 1, firstName: 'Roshen', country: 'GB', photoUrl: null, seats: 1, isStarter: true, isYou: true, paysByLink: true }],
};
const other = {
  ...created, code: 'GM-2468', from: 'Galle', to: 'Mirissa', corridorId: 'south-coast', seatPrice: 1400,
  members: [{ position: 1, firstName: 'Ana', country: 'DE', photoUrl: null, seats: 1, isStarter: true, isYou: false }],
};

const ok = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function stubApi(page) {
  const seen = { creates: [] };
  await page.route((u) => isApiRequest(new URL(u.href)), async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (p === '/board/me') return route.fulfill(ok({ me: { firstName: 'Roshen', country: 'GB', photo: null } }));
    if (p === '/board' && req.method() === 'POST') {
      seen.creates.push(req.postDataJSON());
      return route.fulfill(ok({ list: created, manageToken: 't' }, 201));
    }
    if (p === '/board' && req.method() === 'GET') return route.fulfill(ok({ lists: [other] }));
    if (p === `/board/${created.code}`) return route.fulfill(ok(created));
    if (p === `/board/${other.code}`) return route.fulfill(ok(other));
    if (p === '/board/dupe') return route.fulfill(ok({ list: null }));
    if (p === '/board/mine') return route.fulfill(ok({ lists: [created] }));
    return route.fulfill(ok({}));
  });
  return seen;
}

async function toDetailsStep(page) {
  await page.goto(startLink);
  await expect(page.locator('#mstep-0')).toBeVisible({ timeout: 15000 });
  await page.locator('#c-continue').click();
  await expect(page.locator('#mstep-2')).toBeVisible();
}

test('the start sheet asks for a phone number only — no billing address, no PayHere', async ({ page }) => {
  await stubApi(page);
  await toDetailsStep(page);
  await expect(page.locator('#pay-phone')).toBeVisible();
  await expect(page.locator('#pay-city')).toBeHidden();
  await expect(page.locator('#pay-address')).toBeHidden();
  await expect(page.locator('#sign-btn')).toHaveText('Put it on the board');
  await expect(page.locator('#mstep-2 .deal')).toContainText('no card needed');
  await expect(page.locator('#mstep-2 .deal')).toContainText('we send you a link to pay');
  // The PayHere verification-charge note is for a card approval; none happens here.
  await expect(page.locator('#deal-fine')).toBeHidden();
  await expect(page.locator('#mstep-2 .paynote')).toBeHidden();
});

test('starting a ride sends no billing details and goes straight to the share step', async ({ page }) => {
  const seen = await stubApi(page);
  await toDetailsStep(page);
  await page.selectOption('#pay-cc', '+44');
  await page.fill('#pay-phone', '7700 900123');
  await page.locator('#sign-btn').click();

  await expect(page.locator('#mstep-3')).toBeVisible();
  await expect(page.locator('#pay-handoff')).toBeHidden();
  expect(seen.creates).toHaveLength(1);
  expect(seen.creates[0].payment).toEqual({ phone: '+447700900123' });
  await expect(page.locator('#done-sub')).toContainText('payment link');
});

test('the starter\'s own ride says a payment link comes — not "your card is approved"', async ({ page }) => {
  await stubApi(page);
  await page.goto('/board.html#/' + created.code);
  const hero = page.locator('.on-hero');
  await expect(hero).toBeVisible({ timeout: 15000 });
  await expect(hero).toContainText('payment link');
  await expect(hero).not.toContainText('card is approved');
});

test('joining someone else\'s ride still approves a card with PayHere', async ({ page }) => {
  await stubApi(page);
  await page.goto('/board.html');
  await page.locator(`[data-view="${other.code}"]`).click();
  await page.locator('[data-detail-join]').last().click();
  await expect(page.locator('#mstep-2')).toBeVisible();
  await expect(page.locator('#pay-city')).toBeVisible();
  await expect(page.locator('#pay-address')).toBeVisible();
  await expect(page.locator('#sign-btn')).toHaveText('Continue to PayHere');
  await expect(page.locator('#mstep-2 .deal')).toContainText('we only save your card');
});
