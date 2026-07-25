import { test, expect } from '@playwright/test';

// Regression: arriving on the WHEN step via the ?step=dates deep-link (e.g. "Back from the
// booking page") for a Google-only leg used to kill the date picker.
//
// plan.js portals each leg's date popover to <body>, and render() (the ROUTE board render)
// sweeps those popovers via clearLegDatePops(). A Google-only leg's live-km lookup resolves
// asynchronously and re-invokes render() — and when that fires AFTER showDatesStep() has
// already built + enhanced the date inputs (exactly the deep-link load order: render() then
// showDatesStep() at parse time, km resolves a tick later), the board render wipes the date
// popovers without rebuilding them. The calendar button was left pointing at a popover no
// longer in the DOM, so clicking it did nothing.

test('date picker still opens on the ?step=dates deep-link after a live-km re-render', async ({ page }) => {
  // Stub the Google Routes lib so the Google-only leg resolves to a real distance (120 km),
  // which is what makes requestLiveKm's success callback re-fire render().
  await page.addInitScript(() => {
    const Route = {
      computeRoutes: async () => ({ routes: [{ legs: [{ distanceMeters: 120000, durationMillis: 7200000 }] }] }),
    };
    const places = {
      AutocompleteSessionToken: function () {},
      AutocompleteSuggestion: { fetchAutocompleteSuggestions: async () => ({ suggestions: [] }) },
    };
    const libs = { routes: { Route }, places };
    window.google = { maps: { importLibrary: async (n) => libs[n] || {} } };
  });
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());

  // Neither place is in the baked transfer table → the leg needs a live routeStats lookup.
  await page.goto(
    '/plan.html?stops=' +
      encodeURIComponent('Yatiyanthota, Sri Lanka|Ratnapura, Sri Lanka') +
      '&pax=2&vehicle=car&step=dates',
  );

  // We land straight on the WHEN step.
  await expect(page.locator('#dates-wrap')).toBeVisible();

  // Wait for the live-km lookup to resolve and re-fire render() — the (hidden) board now
  // carries the resolved distance, which only a post-showDatesStep render() could have written.
  await expect(page.locator('#rail')).toContainText('120 km');

  // The calendar button must still open a visible popover.
  await page.locator('#dates-list .dr-date .dp-btn').first().click();
  await expect(page.locator('body > .dp-pop').first()).toBeVisible();
});
