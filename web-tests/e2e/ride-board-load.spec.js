import { test, expect } from '@playwright/test';

// board.js used to chain its two boot requests: /board did not even start until /board/me
// had come back. On Render's free tier the instance sleeps, so the first request wakes it
// (tens of seconds) and the chained second one then waits out a further round trip.
//
// These tests hold /board/me open deliberately. If the chain ever comes back, /board will
// not be requested until the delay elapses and the parallelism assertion fails.

const ME_DELAY_MS = 1000;

const LISTS = {
  lists: [
    {
      code: 'AA-1111', corridorId: 'south-coast', from: 'Galle', to: 'Mirissa',
      date: '2099-01-01', slot: 'morning', lockedTime: null, minSeats: 4, capacity: 6,
      seatPrice: 1400, status: 'gathering', note: null,
      cutoffAt: '2099-01-01T00:00:00.000Z', committed: 1,
      members: [{ position: 1, firstName: 'Ana', country: 'DE', photoUrl: null, isStarter: true }],
    },
  ],
};

const isMe = (u) => new URL(u).pathname === '/board/me';
const isBoard = (u) => new URL(u).pathname === '/board';
// The API, wherever it lives — ops.ceylonhop.com today, *.onrender.com historically, and
// SAME-ORIGIN under the offline test server, which rewrites every live-API request to its own
// origin with the path intact (serve-booking.js). Both forms are matched, so these stay
// stubbed whether or not that rewrite is in play.
//
// Still deliberately NOT "anything non-local": fonts, GTM and the GIS script must keep
// loading. The path arm is just as narrow — /board.html and /site.css do not match it,
// because `board` must be followed by a slash or end-of-path.
const API_PATH = /^\/(board|health|errors)(\/|$)/;
const isApiHost = (u) => /(^|\.)ceylonhop\.com$/.test(u.hostname)
  || /\.onrender\.com$/.test(u.hostname)
  || API_PATH.test(u.pathname);

/** Stub the board API, holding /board/me open for ME_DELAY_MS. Returns a timing log. */
async function stubApi(page) {
  const t0 = Date.now();
  const marks = { meStart: null, meEnd: null, boardStart: null };

  await page.route((u) => isMe(u.href), async (route) => {
    marks.meStart ??= Date.now() - t0;
    await new Promise((r) => setTimeout(r, ME_DELAY_MS));
    marks.meEnd = Date.now() - t0;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ me: null }) });
  });

  await page.route((u) => isBoard(u.href), async (route) => {
    marks.boardStart ??= Date.now() - t0;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LISTS) });
  });

  // Anything else on the API host — /board/dupe, /board/mine, analytics — is not the
  // subject here and must not slow the page down. Matched by predicate, not a hostname
  // glob: board.html points at ops.ceylonhop.com (same-site, for the ch_cust cookie), and
  // a glob that misses the real host would let these tests hit the live API.
  await page.route((u) => isApiHost(u), (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/board' || p === '/board/me') return route.fallback();
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  return marks;
}

test('/board does not wait for /board/me', async ({ page }) => {
  const marks = await stubApi(page);
  await page.goto('/board.html');
  await expect(page.locator('.lcard').first()).toBeVisible({ timeout: 15000 });

  // Wait for the held request to land so both marks are populated.
  await expect.poll(() => marks.meEnd, { timeout: 10000 }).not.toBeNull();

  expect(marks.boardStart, '/board was never requested').not.toBeNull();

  // The invariant, in terms of when requests are SENT rather than when the page paints
  // (paint timing varies with machine load and made this assertion flaky): /board goes
  // out while /board/me is still in flight. Under the old chained boot, /board could not
  // be sent until /board/me had resolved, so boardStart would be >= meEnd.
  expect(
    marks.boardStart,
    `/board was sent at ${marks.boardStart}ms but /board/me only resolved at ${marks.meEnd}ms — ` +
      'the boot requests are serialized again',
  ).toBeLessThan(marks.meEnd);
});

test('the grid shows a skeleton while the board is loading', async ({ page }) => {
  // Hold /board open until the test releases it. A fixed delay made this racy — the
  // skeleton's lifetime became a wall-clock window that a slow page load could outlast.
  let release;
  const held = new Promise((r) => { release = r; });
  await page.route((u) => new URL(u.href).pathname === '/board', async (route) => {
    await held;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LISTS) });
  });
  await page.route((u) => isApiHost(u), (route) => {
    if (new URL(route.request().url()).pathname === '/board') return route.fallback();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ me: null }) });
  });

  await page.goto('/board.html', { waitUntil: 'domcontentloaded' });

  const grid = page.locator('#board-grid');
  await expect(grid.locator('.bskel').first()).toBeVisible();
  await expect(grid).toHaveAttribute('aria-busy', 'true');

  // …and it gives way to the real cards, rather than lingering.
  release();
  await expect(page.locator('.lcard').first()).toBeVisible({ timeout: 15000 });
  await expect(grid.locator('.bskel')).toHaveCount(0);
  await expect(grid).not.toHaveAttribute('aria-busy', 'true');
});
