import { test, expect } from '@playwright/test';
import { gotoBooking } from './_stubs.js';

// Security audit 2026-10-04: place names arrive in the URL (?from=, ?to=, ?stops=) and were
// interpolated into innerHTML unescaped, so a crafted link on the real domain ran script
// (search.js, booking.js, plan.js). A place name is DATA: it must render as literal text.
//
// The payload sets a global instead of calling alert(), so the assertion is a plain read and a
// dialog can never stall the run. If the markup is parsed, the <img> fails to load and onerror
// fires; if it is escaped, nothing runs and the literal text is on the page.
const PAYLOAD = '<img src=x onerror="window.__xss=(window.__xss||0)+1">';

async function expectInert(page) {
  // onerror for a broken <img> fires asynchronously; give it a beat before reading the flag.
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  expect(await page.locator('img[src="x"]').count()).toBe(0);
}

test('search.html prints a hostile ?from= as text', async ({ page }) => {
  await gotoBooking(page, {
    path: '/search.html',
    query: `from=${encodeURIComponent(PAYLOAD)}&to=Kandy`,
  });
  await expectInert(page);
  await expect(page.locator('body')).toContainText('<img src=x');
});

test('search.html prints a hostile ?to= as text', async ({ page }) => {
  await gotoBooking(page, {
    path: '/search.html',
    query: `from=Kandy&to=${encodeURIComponent(PAYLOAD)}`,
  });
  await expectInert(page);
});

test('booking.html (private) prints a hostile ?from= as text', async ({ page }) => {
  await gotoBooking(page, {
    query: `mode=private&from=${encodeURIComponent(PAYLOAD)}&to=Kandy`,
  });
  await expectInert(page);
});

test('booking.html (trip) prints hostile ?stops= as text', async ({ page }) => {
  await gotoBooking(page, {
    query: `mode=trip&stops=${encodeURIComponent(`Kandy|${PAYLOAD}|Ella`)}&nights=1,1&vehicle=car`,
  });
  await expectInert(page);
});

test('plan.html prints hostile ?stops= as text', async ({ page }) => {
  await gotoBooking(page, {
    path: '/plan.html',
    query: `stops=${encodeURIComponent(`Kandy|${PAYLOAD}`)}&pax=2&vehicle=car`,
  });
  await expectInert(page);
});
