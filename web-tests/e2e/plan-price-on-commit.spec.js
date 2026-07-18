import { test, expect } from '@playwright/test';

// A leg must be priced only once the traveller COMMITS a location (picks a suggestion or
// blurs onto a real place) — never from half-typed text. Previously the recompute ran on
// every keystroke and sent the raw partial string to Google, so typing "ga" resolved to
// some place and showed a bogus distance/price before anything was selected.
//
// We assert on the Google distance calls (Route.computeRoutes): typing must add none;
// committing a place must make one and price the leg.

function stubGoogleRecording() {
  window.__computeRoutesReqs = [];
  const Route = {
    computeRoutes: async (req) => {
      window.__computeRoutesReqs.push(req);
      return { routes: [{ legs: [{ distanceMeters: 100000, durationMillis: 5400000 }] }] };
    },
  };
  const places = {
    AutocompleteSessionToken: function () {},
    AutocompleteSuggestion: { fetchAutocompleteSuggestions: async () => ({ suggestions: [] }) },
  };
  window.google = {
    maps: { importLibrary: async (n) => ({ routes: { Route }, places }[n] || {}), event: { trigger() {} } },
  };
}

test('a leg is not priced from half-typed text — only after a place is committed', async ({ page }) => {
  await page.addInitScript(stubGoogleRecording);
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.goto('/plan.html?stops=' + encodeURIComponent('Colombo|Kandy') + '&pax=2&vehicle=car');

  const leg = page.locator('#rail .leg-card').first();
  const to = leg.locator('.leg-to');

  // Let any load-time resolution settle, then snapshot the Google-distance call count.
  await expect(leg).toBeVisible();
  await page.waitForTimeout(400);
  const before = await page.evaluate(() => window.__computeRoutesReqs.length);

  // Type a partial, non-committed destination — this must NOT be geocoded/priced.
  await to.click();
  await to.fill('');
  await to.pressSequentially('xyz', { delay: 30 });
  await page.waitForTimeout(400);

  const afterTyping = await page.evaluate(() => window.__computeRoutesReqs.length);
  expect(afterTyping).toBe(before); // typing added no distance request

  // Committing a real place DOES resolve + price the leg.
  await to.fill('');
  await to.pressSequentially('Ell', { delay: 30 });
  await page.locator('.place-menu .place-option').first().click();
  await expect(leg.locator('[data-dist]')).toHaveClass(/on/);
});
