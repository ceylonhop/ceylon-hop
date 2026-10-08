import { test, expect } from '@playwright/test';

// A real browser, a real page, the production hostname: `?api=` must not steer it.
//
// Until 2026-10-07 every customer page took its API base from `?api=` on any host, so a link
// such as https://ceylonhop.com/booking.html?…&api=https://evil.example sent the customer's
// booking to that server. api-override-host-gate.test.js pins the bootstrap's logic in a VM;
// this proves it in Chromium, with the page actually served AS ceylonhop.com.
//
// Fully offline: every request to ceylonhop.com is answered from the local static server
// (the same files), and every other host — the foreign API, GTM, fonts, the live API — is
// aborted and recorded. sendBeacon bypasses routing, so it is replaced with a recorder.

const PROD = 'https://ceylonhop.com';
const EVIL = 'https://evil.example';
const LIVE_API = 'https://ceylon-hop-api.onrender.com';
const PAGES = [
  '/booking.html?mode=private&from=cmb-airport&to=kandy&vehicle=car&price=90&rawPrice=90',
  '/index.html',
  '/trip/colombo-to-kandy/',
];

async function serveAsProduction(context, baseURL) {
  const foreign = [];
  await context.addInitScript(() => {
    window.__beacons = [];
    navigator.sendBeacon = (u) => { window.__beacons.push(String(u)); return true; };
  });
  await context.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === 'ceylonhop.com') {
      const local = new URL(u.pathname + u.search, baseURL);
      const response = await route.fetch({ url: local.href });
      return route.fulfill({ response });
    }
    foreign.push(u.href);
    return route.abort();
  });
  return foreign;
}

for (const target of PAGES) {
  test(`ceylonhop.com${target.split('?')[0]} ignores a foreign ?api=`, async ({ page, context, baseURL }) => {
    const foreign = await serveAsProduction(context, baseURL);
    const sep = target.includes('?') ? '&' : '?';
    await page.goto(`${PROD}${target}${sep}api=${encodeURIComponent(EVIL)}`);
    await page.waitForLoadState('networkidle');

    expect(await page.evaluate(() => location.hostname)).toBe('ceylonhop.com');
    expect(await page.evaluate(() => window.CEYLON_HOP_API)).toBe(LIVE_API);
    const beacons = await page.evaluate(() => window.__beacons);
    const toEvil = [...foreign, ...beacons].filter((u) => u.startsWith(EVIL));
    expect(toEvil, `requests addressed to the foreign API: ${toEvil.join(', ')}`).toEqual([]);
  });
}

test('ceylonhop.com ignores ?api=off too — a link cannot switch on the demo checkout', async ({ page, context, baseURL }) => {
  await serveAsProduction(context, baseURL);
  await page.goto(`${PROD}${PAGES[0]}&api=off`);
  expect(await page.evaluate(() => window.CEYLON_HOP_API)).toBe(LIVE_API);
  await expect(page.locator('#pay-disclaimer')).not.toContainText('Demo checkout');
});

// Control: the same routing on a local host still honours ?api=, so the checks above are
// not passing merely because this harness can never set the base.
test('a local host still honours ?api= (control)', async ({ page }) => {
  await page.route(`${EVIL}/**`, (route) => route.abort());
  await page.goto(`${PAGES[0]}&api=${encodeURIComponent(EVIL)}`);
  expect(await page.evaluate(() => window.CEYLON_HOP_API)).toBe(EVIL);
});
