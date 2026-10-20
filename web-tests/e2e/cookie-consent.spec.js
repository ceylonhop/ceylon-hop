// The Europe-only cookie strip (owner decision 2026-09-27), end to end in a real browser.
//
// Who is asked is decided by the device clock, so these specs pin Playwright's `timezoneId`.
// The rest of the suite runs on the host clock (UTC on CI, America/* locally), where the
// strip never appears on its own, which is why no other spec needs to dismiss it.
//
// GTM never loads off a real host, so window.dataLayer stays a plain array we can read.
import { test, expect } from '@playwright/test';
import { blockLiveApi } from './_stubs.js';

test.beforeEach(async ({ page }) => { await blockLiveApi(page); });

const consentUpdates = (page) =>
  page.evaluate(() =>
    (window.dataLayer || [])
      .map((e) => Array.from(e && e.length !== undefined ? e : []))
      .filter((a) => a[0] === 'consent' && a[1] === 'update')
      .map((a) => a[2]));

const box = (page, selector) =>
  page.locator(selector).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  });

test.describe('a visitor on a European clock', () => {
  test.use({ timezoneId: 'Europe/London' });

  test('is asked once; Accept grants advertising and is replayed on the next page', async ({ page }) => {
    await page.goto('/index.html');
    const strip = page.getByRole('region', { name: 'Cookie choices' });
    await expect(strip).toBeVisible();
    await expect(strip.getByRole('button', { name: 'Reject' })).toBeVisible();

    await strip.getByRole('button', { name: 'Accept' }).click();
    await expect(strip).toHaveCount(0);
    expect(await consentUpdates(page)).toEqual([
      { ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted' },
    ]);

    // Next page: not asked again, and the head snippet re-grants before GTM would load.
    await page.goto('/search.html?from=cmb-airport&to=kandy&pax=2');
    await expect(page.locator('#ch-consent')).toHaveCount(0);
    expect(await consentUpdates(page)).toEqual([
      { ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted' },
    ]);
  });

  test('Reject keeps advertising denied and is not asked again', async ({ page }) => {
    await page.goto('/index.html');
    await page.getByRole('button', { name: 'Reject' }).click();
    expect(await consentUpdates(page)).toEqual([
      { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' },
    ]);
    await page.goto('/trip/kandy-to-ella/');
    await expect(page.locator('#ch-consent')).toHaveCount(0);
  });

  test('is asked on a generated route page too', async ({ page }) => {
    await page.goto('/trip/kandy-to-ella/');
    await expect(page.getByRole('region', { name: 'Cookie choices' })).toBeVisible();
  });

  // Owner call: nothing competes with the price sheet or Pay.
  test('is not asked on the booking page', async ({ page }) => {
    await page.goto('/booking.html?from=cmb-airport&to=kandy&mode=private&vehicle=car');
    await page.waitForLoadState('load');
    await page.waitForTimeout(300); // give an (unwanted) async consent.js time to arrive
    await expect(page.locator('#ch-consent')).toHaveCount(0);
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 720 } });

    test('the WhatsApp button moves up clear of the strip, and back down after an answer', async ({ page }) => {
      await page.goto('/index.html');
      await expect(page.locator('#ch-consent')).toBeVisible();
      await expect(page.locator('.wa-fab')).toBeVisible();
      const strip = await box(page, '#ch-consent');
      const fab = await box(page, '.wa-fab');
      expect(fab.bottom, 'WhatsApp button overlaps the strip').toBeLessThanOrEqual(strip.top);

      await page.getByRole('button', { name: 'Accept' }).click();
      const fabAfter = await box(page, '.wa-fab');
      expect(fabAfter.bottom).toBeGreaterThan(fab.bottom); // back to its usual place
    });

    test("the board's Start bar stays tappable above the strip", async ({ page }) => {
      await page.goto('/board.html');
      await expect(page.locator('#ch-consent')).toBeVisible();
      await expect(page.locator('#start-bar')).toBeVisible();
      const strip = await box(page, '#ch-consent');
      const bar = await box(page, '#start-bar');
      expect(bar.bottom, 'Start bar overlaps the strip').toBeLessThanOrEqual(strip.top);
    });

    test('the page end is still reachable: the footer scrolls clear of the strip', async ({ page }) => {
      await page.goto('/index.html');
      await expect(page.locator('#ch-consent')).toBeVisible();
      await page.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0, document.body.scrollHeight); });
      const strip = await box(page, '#ch-consent');
      const lastLine = await box(page, '.footer .foot-bottom');
      expect(lastLine.bottom, 'footer ends under the strip').toBeLessThanOrEqual(strip.top + 1);
    });
  });
});

test.describe('a visitor outside Europe', () => {
  test.use({ timezoneId: 'Asia/Colombo' });

  test('is never asked, and nothing updates the defaults', async ({ page }) => {
    await page.goto('/index.html');
    await page.waitForLoadState('load');
    await page.waitForTimeout(300);
    await expect(page.locator('#ch-consent')).toHaveCount(0);
    await expect(page.locator('script[data-ch-consent]')).toHaveCount(0); // never even fetched
    expect(await consentUpdates(page)).toEqual([]);
  });

  test('can still opt out from the footer', async ({ page }) => {
    await page.goto('/index.html');
    await page.getByRole('link', { name: 'Cookie choices' }).click();
    await expect(page).toHaveURL(/\/index\.html$/); // the link opened the strip, not the policy
    await page.getByRole('button', { name: 'Reject' }).click();
    expect(await consentUpdates(page)).toEqual([
      { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' },
    ]);
  });
});
