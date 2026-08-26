import { test, expect } from '@playwright/test';
import { isApiRequest } from './_api-host.js';

// The card CTA used to read "See ride · hop on" for every card the board draws as locked.
// "Locked" on a card is `L.confirmed || committed >= minSeats`, which is two different
// states wearing one label:
//
//   * status 'confirmed' — set only by the cutoff sweep, so the cutoff has passed. The join
//     route refuses a seat here (a seat nothing can charge for), so "hop on" invited an
//     action that could only fail.
//   * still 'gathering', minimum reached, cutoff ahead, seats spare — joins fine, and is the
//     card most worth offering a hop-on. It keeps the invitation.
//
// A confirmed van that is also FULL is a third case, covered by ride-board-full-van.spec.js:
// it gets "Start another van" and no [data-view] at all.

const base = {
  corridorId: 'south-coast', from: 'Colombo Airport (CMB)', to: 'Dambulla',
  date: '2099-08-15', slot: 'morning', lockedTime: '07:30', minSeats: 4, capacity: 6,
  seatPrice: 1900, note: null, cutoffAt: '2099-08-14T00:00:00.000Z', committed: 4,
  members: [
    { position: 1, firstName: 'Anna', country: 'PL', photoUrl: null, isStarter: true },
    { position: 2, firstName: 'Yuki', country: 'JP', photoUrl: null },
    { position: 3, firstName: 'Ben', country: 'IE', photoUrl: null },
    { position: 4, firstName: 'Mat', country: 'DE', photoUrl: null },
  ],
};

// Same seat maths on both — only `status` differs, which is the whole point.
const LOCKED = { ...base, code: 'LK-1111', status: 'confirmed' };
const GATHERING = { ...base, code: 'GA-3333', status: 'gathering' };

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
    if (hit) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(hit) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

test('a confirmed van invites you to look, not to join', async ({ page }) => {
  await stubApi(page, [LOCKED]);
  await page.goto('/board.html');

  const card = page.locator('.lcard[data-code="LK-1111"]');
  await expect(card).toBeVisible({ timeout: 15000 });

  await expect(card.locator('[data-view]')).toHaveText(/See who's going/);
  // the point of the change: no join invitation on a card whose join is refused
  await expect(card).not.toContainText('hop on');
  await expect(card).not.toContainText('See ride & join');
});

test('a van that has merely hit its minimum still invites you on', async ({ page }) => {
  await stubApi(page, [GATHERING]);
  await page.goto('/board.html');

  const card = page.locator('.lcard[data-code="GA-3333"]');
  await expect(card).toBeVisible({ timeout: 15000 });

  // it draws as locked ("Van's locked" on the roster strip) but the seat is still sellable
  await expect(card).toContainText("Van's locked");
  await expect(card.locator('[data-view]')).toHaveText(/See ride · hop on/);
});
