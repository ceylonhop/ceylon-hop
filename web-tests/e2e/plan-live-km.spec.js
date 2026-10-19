import { test, expect } from '@playwright/test';
import { blockLiveApi } from './_stubs.js';

// plan.html pings the live API on load (0e0f077) — keep the suite offline.
test.beforeEach(async ({ page }) => { await blockLiveApi(page); });

test('planner keeps Google routed duration instead of deriving time from distance', async ({ page }) => {
  await page.addInitScript(() => {
    const Route = {
      computeRoutes: async () => ({
        routes: [{ legs: [{ distanceMeters: 118000, durationMillis: 177 * 60000 }] }],
      }),
    };
    const places = {
      AutocompleteSessionToken: function () {},
      AutocompleteSuggestion: { fetchAutocompleteSuggestions: async () => ({ suggestions: [] }) },
    };
    const libs = { routes: { Route }, places };
    window.google = { maps: { importLibrary: async (name) => libs[name] || {} } };
  });
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.goto('/plan.html?stops=' + encodeURIComponent('Yatiyanthota, Sri Lanka|Ratnapura, Sri Lanka') + '&pax=2&vehicle=car');

  const expected = 'Approx. 120 km · 3h';
  const meta = page.locator('#rail .leg-card').first().locator('[data-dist]');
  await expect(meta).toContainText(expected);
  await expect(meta).toContainText('Google route');
  await expect(meta).not.toContainText('2h 49m');
  await expect(page.locator('#st-drive')).toHaveText(expected);
});

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
  await expect(dist()).toContainText('Approx. 120 km · 2h', { timeout: 6000 });
  await expect(dist()).toContainText('Google route');
});

// Audit 2026-10-04: a CATALOGUE place was routed by its bare name, so Google geocoded "Yala" to
// somewhere ~55 km from Colombo and the planner showed "Yala → Colombo · from $29" while booking
// charged the engine's $123 (293 km). A place the planner already knows must be routed by its
// own coordinates; only free-text Google picks go by name. The stub answers a bare name with the
// wrong short road and a coordinate with the right one, so the shown distance says which was sent.
test('a known catalogue place is routed by its coordinates, not its bare name', async ({ page }) => {
  await page.addInitScript(() => {
    const Route = {
      computeRoutes: async (req) => {
        const byName = typeof req.origin === 'string' || typeof req.destination === 'string'
          || (req.origin && req.origin.address) || (req.destination && req.destination.address);
        const km = byName ? 55 : 293;
        return { routes: [{ legs: [{ distanceMeters: km * 1000, durationMillis: km * 80000 }] }] };
      },
    };
    const places = {
      AutocompleteSessionToken: function () {},
      AutocompleteSuggestion: { fetchAutocompleteSuggestions: async () => ({ suggestions: [] }) },
    };
    const libs = { routes: { Route }, places };
    window.google = { maps: { importLibrary: async (name) => libs[name] || {} } };
  });
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.goto('/plan.html?stops=' + encodeURIComponent('Yala|Colombo') + '&pax=2&vehicle=car');

  const meta = page.locator('#rail .leg-card').first().locator('[data-dist]');
  await expect(meta).toContainText('Google route');
  await expect(meta).toContainText('295 km'); // 293 km, shown rounded to 5
  await expect(meta).not.toContainText('55 km');
});
