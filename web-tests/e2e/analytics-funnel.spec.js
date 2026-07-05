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
