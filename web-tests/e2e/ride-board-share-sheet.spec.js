import { test, expect } from '@playwright/test';
import { isApiRequest } from './_api-host.js';

// Sharing a ride (plan 2026-10-19-ride-board-fomo): one tap from a row, the ride page or the
// "you're on the list" screen — the phone's own share menu when there is one, our sheet if not.
const NOW = '2099-08-10T00:00:00.000Z';
const OPEN = { code: 'SH-1', corridorId: 'ella-south', from: 'Ella', to: 'Mirissa', date: '2099-08-12', slot: 'morning',
  minSeats: 3, capacity: 6, seatPrice: 2800, status: 'gathering', note: null, lockedTime: null,
  cutoffAt: '2099-08-10T09:12:00.000Z', committed: 2,
  members: [{ firstName: 'Tom', country: 'GB', photoUrl: null }, { firstName: 'Lea', country: 'FR', photoUrl: null }] };
const CLOSED = { ...OPEN, code: 'SH-2', date: '2099-08-11', cutoffAt: '2099-08-09T01:30:00.000Z', status: 'confirmed', committed: 3,
  members: [...OPEN.members, { firstName: 'Ben', country: 'IE', photoUrl: null }] };

async function stubApi(page) {
  await page.route((u) => isApiRequest(u), (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/board') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ lists: [OPEN, CLOSED] }) });
    if (p === '/board/me') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ me: null }) });
    if (p === '/board/SH-1') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OPEN) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

async function open(page) {
  await page.clock.setFixedTime(new Date(NOW));
  await stubApi(page);
  await page.goto('/board.html');
  await expect(page.locator('.rw[data-code="SH-1"]')).toBeVisible({ timeout: 15000 });
}

test('a row shares through the phone menu — seats, saving, deadline — and stays on the board', async ({ page }) => {
  await page.addInitScript(() => {
    window.__shared = [];
    Object.defineProperty(navigator, 'share', { configurable: true, value: (d) => { window.__shared.push(d); return Promise.resolve(); } });
  });
  await open(page);
  await page.locator('.rw[data-code="SH-1"] [data-share]').click();
  const shared = await page.evaluate(() => window.__shared);
  expect(shared).toHaveLength(1);
  expect(shared[0].url).toContain('/r/SH-1');
  // a visitor is not on the ride, so it never says "I'm taking"
  expect(shared[0].text).toMatch(/^Shared taxi Ella → Mirissa on /);
  expect(shared[0].text).toContain('1 seat left to make it run');
  expect(shared[0].text).toMatch(/instead of \$\d+(\.\d{2})? for a private car/);
  expect(shared[0].text).toContain('Names close in 9h 12m');
  await expect(page.locator('body')).not.toHaveClass(/detail-open/);
});

test('with no phone menu, the sheet offers WhatsApp, Telegram, Facebook and the link', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(navigator, 'share', { configurable: true, value: undefined }); });
  await open(page);
  await page.locator('.rw[data-code="SH-1"] [data-share]').click();
  const sheet = page.locator('#share-sheet');
  await expect(sheet).toBeVisible();
  await expect(page.locator('#ss-msg')).toContainText('1 seat left to make it run');
  expect(decodeURIComponent(await page.locator('#ss-wa').getAttribute('href'))).toContain('/r/SH-1');
  expect(await page.locator('#ss-tg').getAttribute('href')).toMatch(/^https:\/\/t\.me\/share\/url\?url=/);
  expect(decodeURIComponent(await page.locator('#ss-fb').getAttribute('href'))).toContain('/r/SH-1');
  await expect(page.locator('#ss-url')).toHaveValue(/\/r\/SH-1$/);
  await page.locator('#ss-close').click();
  await expect(sheet).toBeHidden();
});

test('a ride whose names have closed offers no share', async ({ page }) => {
  await open(page);
  await expect(page.locator('.rw[data-code="SH-2"] [data-share]')).toHaveCount(0);
});

test("the ride page's WhatsApp carries the same message, and a Share… button", async ({ page }) => {
  await open(page);
  await page.locator('.rw[data-code="SH-1"] [data-view]').click();
  await expect(page.locator('body')).toHaveClass(/detail-open/);
  const wa = decodeURIComponent(await page.locator('.d-share a.btn-wa').getAttribute('href'));
  expect(wa).toContain('1 seat left to make it run');
  expect(wa).toContain('/r/SH-1');
  await expect(page.locator('.d-share [data-share-detail]')).toBeVisible();
});
