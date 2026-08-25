import { test, expect } from '@playwright/test';
import { isApiRequest } from './_api-host.js';

// Share links used to be built as https://ceylonhop.com/board/<code> — the old WordPress
// apex, which 404s, on a path nothing serves. Every link a starter sent was dead, and the
// chat preview fell back to printing a bare domain. They now resolve against the API,
// which serves /r/<code> with that ride's own open-graph tags.

const LIST = {
  code: 'EA-7797', corridorId: 'airport-cultural', from: 'Colombo Airport (CMB)', to: 'Dambulla',
  date: '2099-08-15', slot: 'morning', lockedTime: '07:30', minSeats: 4, capacity: 6,
  seatPrice: 1900, status: 'gathering', note: null,
  cutoffAt: '2099-08-14T15:30:00.000Z', committed: 3,
  members: [
    { position: 1, firstName: 'Anna', country: 'PL', photoUrl: null, isStarter: true },
    { position: 2, firstName: 'Yuki', country: 'JP', photoUrl: null },
    { position: 3, firstName: 'Ben', country: 'IE', photoUrl: null },
  ],
};

// The API, wherever it lives — ops.ceylonhop.com today, *.onrender.com historically, and
// SAME-ORIGIN under the offline test server, which rewrites every live-API request to its own
// origin with the path intact (serve-booking.js). Both forms are matched, so these stay
// stubbed whether or not that rewrite is in play.
//

async function stubApi(page) {
  await page.route((u) => isApiRequest(u), (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/board') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ lists: [LIST] }) });
    }
    if (p === '/board/EA-7797') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LIST) });
    }
    if (p === '/board/me') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ me: null }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

test('the share link points at the API unfurl path, not the dead apex', async ({ page }) => {
  await stubApi(page);
  await page.goto('/board.html');

  await page.locator('.lcard').first().waitFor({ timeout: 15000 });
  await page.locator('.lcard [data-view]').first().click();
  await expect(page.locator('body')).toHaveClass(/detail-open/);

  const copyTarget = await page.locator('[data-copy]').first().getAttribute('data-copy');
  expect(copyTarget).toContain('/r/EA-7797');
  expect(copyTarget).not.toContain('/board/EA-7797');
  expect(copyTarget).not.toMatch(/^https:\/\/ceylonhop\.com/);

  // ...and the WhatsApp hand-off carries the same URL, not the old one.
  const wa = await page.locator('.d-share a.btn-wa').first().getAttribute('href');
  expect(decodeURIComponent(wa)).toContain('/r/EA-7797');
});

test('the ride domain, once configured, shortens links to a bare code', async ({ page }) => {
  await page.addInitScript(() => { window.CEYLON_HOP_SHARE_ORIGIN = 'https://ride.ceylonhop.com'; });
  await stubApi(page);
  await page.goto('/board.html');

  await page.locator('.lcard').first().waitFor({ timeout: 15000 });
  await page.locator('.lcard [data-view]').first().click();
  await expect(page.locator('body')).toHaveClass(/detail-open/);

  const copyTarget = await page.locator('[data-copy]').first().getAttribute('data-copy');
  expect(copyTarget).toBe('https://ride.ceylonhop.com/EA-7797');
});
