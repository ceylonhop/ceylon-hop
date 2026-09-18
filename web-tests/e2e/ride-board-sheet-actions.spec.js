import { test, expect } from '@playwright/test';
import { isApiRequest } from './_api-host.js';

// The joined traveller's sheet (owner, 2026-09-18):
//  * "Invite someone — fill it faster" only scrolled to the share block a few hundred px below —
//    the same action twice, in a louder green than the primary. Gone; the share block moves up
//    under the action buttons so the nudge stays.
//  * "Scratch my name off" removed the name on ONE click with no warning. It now asks first, and
//    nothing is sent until the traveller confirms.

const list = {
  code: 'SA-1000', corridorId: 'airport-cultural', from: 'Colombo Airport (CMB)', to: 'Sigiriya / Dambulla',
  date: '2099-08-15', slot: 'morning', lockedTime: null, minSeats: 3, capacity: 6, seatPrice: 2749,
  status: 'gathering', note: null, cutoffAt: '2099-08-13T01:30:00.000Z', committed: 1,
  members: [{ position: 1, firstName: 'Roshen', country: 'US', photoUrl: null, seats: 1, isStarter: true, isYou: true }],
};

async function stubApi(page, scratches) {
  await page.route((u) => isApiRequest(new URL(u.href)), (route) => {
    const path = new URL(route.request().url()).pathname;
    const j = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/board/me') return j({ me: { firstName: 'Roshen', country: 'US', photo: null } });
    if (path === '/board') return j({ lists: [list] });
    if (path === '/board/mine') return j({ lists: [list] });
    if (path === '/board/SA-1000') return j(list);
    if (path === '/board/SA-1000/scratch') {
      scratches.push(route.request().method());
      return j({ ok: true, list: { ...list, committed: 0, members: [] } });
    }
    return j({});
  });
}

test('a joined traveller sees no scroll-only invite button; the share block sits under the actions', async ({ page }) => {
  await stubApi(page, []);
  await page.goto('/board.html#/SA-1000');
  const join = page.locator('.d-join');
  await expect(join.locator('[data-scratch]')).toBeVisible({ timeout: 15000 });

  await expect(join.locator('[data-detail-share]')).toHaveCount(0);
  await expect(join).not.toContainText('fill it faster');
  const share = await join.locator('.d-share').boundingBox();
  const deadline = await join.locator('.deadline').boundingBox();
  expect(share.y, 'the share block should come before the deadline line').toBeLessThan(deadline.y);
  await expect(join.locator('.d-share a.btn-wa')).toBeVisible();
});

test('scratching asks first, and sends nothing until the traveller confirms', async ({ page }) => {
  const scratches = [];
  await stubApi(page, scratches);
  await page.goto('/board.html#/SA-1000');
  const join = page.locator('.d-join');
  const scratch = join.locator('[data-scratch]');
  await expect(scratch).toBeVisible({ timeout: 15000 });

  await scratch.click();
  const ask = join.locator('.scratch-ask');
  await expect(ask).toBeVisible();
  await expect(ask).toContainText(/hop back on/i);
  // the ask REPLACES the button — two "scratch" controls on screen at once is the confusion
  // this exists to remove (`hidden` alone loses to .btn's own display rule)
  await expect(scratch).toBeHidden();
  expect(scratches, 'no request before confirming').toEqual([]);

  // changed my mind
  await ask.getByRole('button', { name: 'Keep my seat' }).click();
  await expect(ask).toHaveCount(0);
  await expect(scratch).toBeVisible();
  expect(scratches).toEqual([]);

  // meant it
  await scratch.click();
  await ask.getByRole('button', { name: 'Yes, scratch me off' }).click();
  await expect.poll(() => scratches.length).toBe(1);
  await expect(page.locator('#toast')).toContainText('Name scratched off');
});
