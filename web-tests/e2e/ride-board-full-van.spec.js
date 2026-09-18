import { test, expect } from '@playwright/test';
import { isApiRequest } from './_api-host.js';

// A full van you are not on: the only action worth offering is "Start another van".
// The card (now a row) used to carry a second "See who's on" button beside it — the generic
// "open this ride" button wearing a full-van label — which competed with the real
// primary action for a roster the card already shows.

const FULL_VAN = {
  lists: [
    {
      code: 'FV-2222', corridorId: 'south-coast', from: 'Colombo Airport (CMB)', to: 'Dambulla',
      date: '2099-08-15', slot: 'morning', lockedTime: '07:30', minSeats: 4, capacity: 6,
      seatPrice: 1900, status: 'confirmed', note: 'Full van — six of us, leaving sharp.',
      cutoffAt: '2099-08-14T00:00:00.000Z', committed: 6,
      members: [
        { position: 1, firstName: 'Anna', country: 'PL', photoUrl: null, isStarter: true },
        { position: 2, firstName: 'Yuki', country: 'JP', photoUrl: null },
        { position: 3, firstName: 'Ben', country: 'IE', photoUrl: null },
        { position: 4, firstName: 'Mat', country: 'DE', photoUrl: null },
        { position: 5, firstName: 'Tom', country: 'AU', photoUrl: null },
        { position: 6, firstName: 'Ela', country: 'AU', photoUrl: null },
      ],
    },
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
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FULL_VAN) });
    }
    if (p === '/board/FV-2222') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FULL_VAN.lists[0]) });
    }
    if (p === '/board/me') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ me: null }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

test('a full van offers only "Start another van" — no second roster button', async ({ page }) => {
  await stubApi(page);
  await page.goto('/board.html');

  const card = page.locator('.rw').first();
  await expect(card).toBeVisible({ timeout: 15000 });

  await expect(card.locator('[data-again]')).toHaveText(/Start another van/);
  await expect(card.locator('[data-view]')).toHaveCount(0);
  await expect(card).not.toContainText("See who's on");
});

test('a full van card still opens its ride detail when clicked', async ({ page }) => {
  await stubApi(page);
  await page.goto('/board.html');

  const card = page.locator('.rw').first();
  await expect(card).toBeVisible({ timeout: 15000 });

  // The card-level handler used to read the code off the [data-view] button. Removing that
  // button from full vans left the whole card dead to a click.
  await card.locator('.rw-places').click();
  await expect(page.locator('body')).toHaveClass(/detail-open/);
});

test('a full van row keeps its price on one line on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 900 });
  await stubApi(page);
  await page.goto('/board.html');

  const row = page.locator('.rw').first();
  await expect(row).toBeVisible({ timeout: 15000 });
  // "≈ $19 each" is one line of ~.8rem text; two lines would be ~40px.
  const price = await row.locator('.rw-price').boundingBox();
  expect(price.height, `.rw-price is ${Math.round(price.height)}px tall — it has wrapped`).toBeLessThan(32);
});
