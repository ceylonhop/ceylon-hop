import { test, expect } from '@playwright/test';

// A Google-only planner leg gets its distance from CH_MAP.routeStats. ch-map.js collapses
// transient routing failures (over-quota / rejected computeRoutes) into a resolved `null`,
// and plan.js used to CACHE that null — poisoning the leg so it stayed unpriceable for the
// whole session with no retry. A transient failure must instead leave the leg re-requestable.

test('a transient routeStats failure does not poison the leg — the next render retries', async ({ page }) => {
  await page.addInitScript(() => {
    window.__routeCalls = 0;
    const Route = {
      computeRoutes: async () => {
        window.__routeCalls += 1;
        if (window.__routeCalls === 1) throw new Error('OVER_QUERY_LIMIT'); // transient fail → null
        return { routes: [{ legs: [{ distanceMeters: 120000, durationMillis: 7200000 }] }] };
      },
    };
    const places = {
      AutocompleteSessionToken: function () {},
      AutocompleteSuggestion: { fetchAutocompleteSuggestions: async () => ({ suggestions: [] }) },
    };
    const libs = { routes: { Route }, places };
    window.google = {
      maps: { importLibrary: async (n) => libs[n] || {} },
    };
  });
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  // Google-only leg (neither place is in the baked transfer table) → needs routeStats.
  await page.goto('/plan.html?stops=' + encodeURIComponent('Yatiyanthota, Sri Lanka|Ratnapura, Sri Lanka') + '&pax=2&vehicle=car');

  const dist = () => page.locator('#rail .leg-card').first().locator('[data-dist]');
  // First routeStats failed (null) → the leg is not priced yet.
  await expect(dist()).toContainText('Pick both points');
  await page.waitForFunction(() => window.__routeCalls >= 1); // ensure the failed call resolved

  // Any re-render (adding a leg) re-requests the un-poisoned leg — the retry succeeds.
  await page.locator('#add-stop').click();
  await expect(dist()).toContainText('120 km', { timeout: 6000 });
});
