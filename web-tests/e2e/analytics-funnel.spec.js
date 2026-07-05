import { test, expect } from '@playwright/test';

// Capture dataLayer events pushed before/after load.
async function events(page) {
  return page.evaluate(() => (window.dataLayer || []).filter(e => e && e.event).map(e => e.event));
}

test.describe('search funnel events', () => {
  test('search + view_item_list fire on the results page', async ({ page }) => {
    await page.goto('/search.html?from=kandy&to=ella&pax=2');
    await page.waitForSelector('#results .opt');
    const evs = await events(page);
    expect(evs).toContain('search');
    expect(evs).toContain('view_item_list');
  });

  test('select_item fires when a Select CTA is clicked', async ({ page }) => {
    await page.goto('/search.html?from=kandy&to=ella&pax=2');
    await page.waitForSelector('#results .opt-private a.btn');
    // don't navigate away — assert the event was queued on click
    await page.evaluate(() => {
      const a = document.querySelector('#results .opt-private a.btn');
      a.addEventListener('click', e => e.preventDefault(), { capture: true });
      a.click();
    });
    const evs = await events(page);
    expect(evs).toContain('select_item');
  });
});

test.describe('booking checkout funnel events', () => {
  test('begin_checkout fires on booking load', async ({ page }) => {
    await page.goto('/booking.html?mode=private&from=kandy&to=ella&pax=2');
    // .panel matches panel 2 first in DOM order (declared before panel 1) and it's
    // not the active/visible one, so wait on the active panel specifically.
    await page.waitForSelector('.panel.active');
    const evs = await page.evaluate(() => (window.dataLayer || []).map(e => e && e.event));
    expect(evs).toContain('begin_checkout');
  });

  test('add_payment_info fires when a pay plan is chosen', async ({ page }) => {
    await page.goto('/booking.html?mode=private&from=kandy&to=ella&pax=2');
    await page.waitForFunction(() => typeof window.setPayPlan === 'function');
    await page.evaluate(() => window.setPayPlan('full'));
    const evs = await page.evaluate(() => (window.dataLayer || []).map(e => e && e.event));
    expect(evs).toContain('add_payment_info');
  });
});
