import { test, expect } from '@playwright/test';
import { isApiRequest } from './_api-host.js';

// A ride stops taking names at its cutoff — POST /board/:code/join answers 409 'closed' past it
// (#597). The board never looked: the countdown clamped to "closes in 0m 00s" and the row still
// said "Hop on". The traveller tapped it, worked through the join sheet, typed their phone,
// address and city, and only on submit were they told the ride had closed.
//
// Not a corner case: rides are marked closed by a sweep that runs once a day, so one whose
// cutoff passes just after a sweep sits like this for nearly 24 h. EA-8707 was in exactly this
// state on production.
//
// `status: 'confirmed'` already suppressed the invitation (ride-board-locked-cta.spec.js). This
// is the ride still GATHERING when its deadline goes by.

const base = {
  corridorId: 'ella-east', from: 'Ella', to: 'Arugam Bay',
  date: '2099-08-15', slot: 'morning', lockedTime: null, minSeats: 3, capacity: 6,
  seatPrice: 2400, note: null, committed: 1, status: 'gathering',
  members: [{ position: 1, firstName: 'Sabrina', country: 'DE', photoUrl: null, isStarter: true, seats: 1 }],
};

// Deliberately past — the whole point. A far-future date with a cutoff behind us is exactly the
// shape production produced.
const SHUT = { ...base, code: 'SH-1111', cutoffAt: '2020-01-01T00:00:00.000Z' };
const OPEN = { ...base, code: 'OP-2222', cutoffAt: '2099-08-14T00:00:00.000Z' };

async function stubApi(page, lists) {
  await page.route((u) => isApiRequest(u), (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/board') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ lists }) });
    }
    if (p === '/board/me') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ me: null }) });
    }
    const hit = lists.find((l) => p === '/board/' + l.code);
    if (hit) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(hit) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

test('a ride past its cutoff says so and does not invite a join', async ({ page }) => {
  await stubApi(page, [SHUT]);
  await page.goto('/board.html');

  const card = page.locator('.rw[data-code="SH-1111"]');
  await expect(card).toBeVisible({ timeout: 15000 });

  await expect(card).toContainText('Names closed');
  await expect(card).not.toContainText('Join');
  await expect(card.locator('[data-view]')).toHaveText(/See who's going/);
});

test('its sheet explains instead of offering a button that can only fail', async ({ page }) => {
  await stubApi(page, [SHUT]);
  await page.goto('/board.html');

  const card = page.locator('.rw[data-code="SH-1111"]');
  await expect(card).toBeVisible({ timeout: 15000 });
  await card.locator('[data-view]').click();

  const sheet = page.locator('.d-join');
  await expect(sheet).toBeVisible({ timeout: 15000 });
  // the join is gone, and the reason is on screen
  await expect(sheet.locator('[data-detail-join]')).toHaveCount(0);
  await expect(sheet).toContainText(/names have closed/i);
  // the "$0 to add your name today" promise must not survive either — it is no longer true
  await expect(sheet).not.toContainText('to add your name today');
  // nor the nudge to fill it: no scarcity pill urging seats that cannot be taken...
  await expect(sheet).not.toContainText(/lock it in/i);
  // ...and no share block, which would land a friend on the same dead end one step further away
  await expect(sheet.locator('.d-share')).toHaveCount(0);
});

test('the countdown does not sit at "closes in 0m 00s"', async ({ page }) => {
  await stubApi(page, [SHUT]);
  await page.goto('/board.html');
  await expect(page.locator('.rw[data-code="SH-1111"]')).toBeVisible({ timeout: 15000 });
  await page.locator('.rw[data-code="SH-1111"] [data-view]').click();
  await expect(page.locator('.d-join')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.countdown .cd').first()).toHaveText('names closed');
});

test('an open ride is completely unaffected', async ({ page }) => {
  await stubApi(page, [OPEN]);
  await page.goto('/board.html');

  const card = page.locator('.rw[data-code="OP-2222"]');
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(card.locator('[data-view]')).toHaveText('Join');
  await expect(card).not.toContainText('Names closed');

  await card.locator('[data-view]').click();
  await expect(page.locator('.d-join [data-detail-join]').first()).toBeVisible({ timeout: 15000 });
});
