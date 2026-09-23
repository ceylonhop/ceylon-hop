import { test, expect } from '@playwright/test';
import { isApiRequest } from './_api-host.js';

// Scheduled taxis on the ride board (spec 2026-09-22-ride-board-scheduled-rows). The Wed/Sat
// taxis we run share the day groups with the lists travellers start, and must never be mistaken
// for one: a clock time, the clock mark, no button. Join stays the one solid button in the list.
// Scheduled rows come from the catalogue for the next 14 days, so they exist whenever this runs;
// the traveller rides are in 2099 so they never collide with them.

const GATHERING = {
  code: 'SC-1', corridorId: 'ella-east', from: 'Ella', to: 'Yala', date: '2099-08-13', slot: 'morning',
  minSeats: 3, capacity: 6, seatPrice: 2299, status: 'gathering', note: null, lockedTime: null,
  cutoffAt: '2099-08-11T20:00:00.000Z', committed: 1,
  members: [{ firstName: 'Liam', country: 'IE', photoUrl: null, isStarter: true }],
};

async function stubApi(page, lists = [GATHERING]) {
  await page.route((u) => isApiRequest(u), (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/board') {
      const f = u.searchParams.get('from'), t = u.searchParams.get('to');
      const hit = lists.filter((l) => (!f || l.from === f) && (!t || l.to === t));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ lists: hit }) });
    }
    if (u.pathname === '/board/me') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ me: null }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('scheduled taxis sit in the list on their own days, one short line each, with no button', async ({ page }) => {
    await stubApi(page);
    await page.goto('/board.html');
    const sched = page.locator('.rws');
    await expect(sched.first()).toBeVisible({ timeout: 15000 });

    // only ever on a Wednesday or a Saturday
    const days = await page.locator('.rw-group:has(.rws) .rw-day-h').allTextContents();
    expect(days.length).toBeGreaterThan(0);
    for (const d of days) expect(d).toMatch(/^(Wed|Sat) /);

    const first = sched.first();
    await expect(first.locator('.rw-when')).toHaveText(/^\d{2}:\d{2}$/); // a clock time, not a window
    await expect(first).toContainText('Scheduled');
    await expect(first.locator('button')).toHaveCount(0);
    expect(await first.getAttribute('href')).toMatch(/^search\.html\?from=[a-z-]+&to=[a-z-]+&date=\d{4}-\d{2}-\d{2}$/);
    const box = await first.boundingBox();
    expect(box.height).toBeLessThan(80);
  });

  test('Join is the only solid button in the list', async ({ page }) => {
    await stubApi(page);
    await page.goto('/board.html');
    await expect(page.locator('.rw[data-code="SC-1"]')).toBeVisible({ timeout: 15000 });

    const solid = page.locator('#board-grid .btn-primary');
    await expect(solid).toHaveCount(1);
    await expect(solid).toHaveText('Join');
    // and it reads as a button: filled, not the text link every other action is
    const bg = await solid.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('a traveller ride says when it is decided, on the phone too', async ({ page }) => {
    await stubApi(page);
    await page.goto('/board.html');
    const row = page.locator('.rw[data-code="SC-1"]');
    await expect(row).toBeVisible({ timeout: 15000 });
    // 20:00 UTC on the 11th is the 12th in Colombo; on a phone it rides on the time line
    const dec = row.locator('.rw-dec-w');
    await expect(dec).toBeVisible();
    await expect(dec).toHaveText(' · decided Wed 12 Aug');
    await expect(row.locator('.rw-dec-s')).toBeHidden();
    // the whole line is on screen, not cut to "dec…"
    const clipped = await row.locator('.rw-when').evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(clipped).toBe(false);
  });

  test('on a laptop the decided date sits under the seat count instead', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await stubApi(page);
    await page.goto('/board.html');
    const row = page.locator('.rw[data-code="SC-1"]');
    await expect(row).toBeVisible({ timeout: 15000 });
    await expect(row.locator('.rw-dec-s')).toBeVisible();
    await expect(row.locator('.rw-dec-w')).toBeHidden();
  });

  test('the board says the timetable keeps going past the two weeks it lists', async ({ page }) => {
    await stubApi(page);
    await page.goto('/board.html');
    const more = page.locator('.rws-more');
    await expect(more).toBeVisible({ timeout: 15000 });
    await expect(more).toContainText('Scheduled taxis keep running every Wed & Sat');
    // it sits before the 2099 ride, i.e. at the end of the window, not after everything
    const moreTop = (await more.boundingBox()).y;
    const rideTop = (await page.locator('.rw[data-code="SC-1"]').boundingBox()).y;
    expect(moreTop).toBeLessThan(rideTop);
  });

  test('nothing on the page runs off the side of the screen', async ({ page }) => {
    await stubApi(page);
    await page.goto('/board.html');
    await expect(page.locator('.rws').first()).toBeVisible({ timeout: 15000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test('filtered to a route, both kinds narrow to it and the scheduled row books that route', async ({ page }) => {
  await stubApi(page);
  await page.goto('/board.html?from=Ella&to=Yala');
  await expect(page.locator('.rw[data-code="SC-1"]')).toBeVisible({ timeout: 15000 });

  const sched = page.locator('.rws');
  expect(await sched.count()).toBeGreaterThan(0);
  for (const href of await sched.evaluateAll((els) => els.map((a) => a.getAttribute('href')))) {
    expect(href).toContain('from=ella&to=yala&date=');
  }
  await expect(page.locator('.rws-more a')).toHaveAttribute('href', 'search.html?from=ella&to=yala');
});

test('a route we do not schedule shows no scheduled rows', async ({ page }) => {
  await stubApi(page, [{ ...GATHERING, code: 'KE-1', corridorId: 'hill-line', from: 'Kandy', to: 'Ella' }]);
  await page.goto('/board.html?from=Kandy&to=Ella');
  await expect(page.locator('.rw[data-code="KE-1"]')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.rws')).toHaveCount(0);
  await expect(page.locator('.rws-more')).toHaveCount(0);
});
