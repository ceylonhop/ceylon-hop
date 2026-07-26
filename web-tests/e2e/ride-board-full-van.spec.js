import { test, expect } from '@playwright/test';

// A full van you are not on: the only action worth offering is "Start another van".
// The card used to carry a second "See who's on" button beside it — the generic
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

const isApiHost = (u) => /(^|\.)ceylonhop\.com$/.test(u.hostname) || /\.onrender\.com$/.test(u.hostname);

async function stubApi(page) {
  await page.route((u) => isApiHost(u), (route) => {
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

  const card = page.locator('.lcard').first();
  await expect(card).toBeVisible({ timeout: 15000 });

  await expect(card.locator('[data-again]')).toHaveText(/Start another van/);
  await expect(card.locator('[data-view]')).toHaveCount(0);
  await expect(card).not.toContainText("See who's on");
});

test('a full van card still opens its ride detail when clicked', async ({ page }) => {
  await stubApi(page);
  await page.goto('/board.html');

  const card = page.locator('.lcard').first();
  await expect(card).toBeVisible({ timeout: 15000 });

  // The card-level handler used to read the code off the [data-view] button. Removing that
  // button from full vans left the whole card dead to a click.
  await card.locator('.lcard-route').click();
  await expect(page.locator('body')).toHaveClass(/detail-open/);
});

test('the card foot wraps instead of crushing the price into a ragged column', async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 900 });
  await stubApi(page);
  await page.goto('/board.html');

  const card = page.locator('.lcard').first();
  await expect(card).toBeVisible({ timeout: 15000 });

  // The foot was a no-wrap row, so the button squeezed .lprice down to ~100px and its two
  // sentences broke into four ragged lines ("≈ $19 each ·" / "$0 to join" / "vs $62
  // private ·" / "6h bus"). The copy is authored as two lines and should stay two.
  // ~19px per line at .86rem/1.35, so anything past three lines is the crush.
  const price = await card.locator('.lprice').boundingBox();
  expect(price.height, `.lprice is ${Math.round(price.height)}px tall — it has wrapped past two lines`)
    .toBeLessThan(50);
});
