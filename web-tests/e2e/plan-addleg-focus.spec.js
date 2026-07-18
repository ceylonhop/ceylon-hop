import { test, expect } from '@playwright/test';

// Adding a leg on the trip planner focuses the new leg's location field so the traveller
// can type the destination immediately. It must NOT auto-open the place-suggestion menu —
// that should appear only once they start typing.
//
// Why it would otherwise pop open: the add-stop/add-stay handlers .focus() the new (empty)
// field; wirePlaceSearch opens the menu on 'focus'; and placeSuggestions('') returns the
// popular places (transfers-data.js), so an empty focused field renders a full menu.

test('adding a leg focuses the new field but does not auto-open the place menu', async ({ page }) => {
  // Minimal Google Maps stub so plan.js's map/places wiring initialises offline.
  await page.addInitScript(() => {
    const places = {
      AutocompleteSessionToken: function () {},
      AutocompleteSuggestion: { fetchAutocompleteSuggestions: async () => ({ suggestions: [] }) },
    };
    const Route = {
      computeRoutes: async () => ({ routes: [{ legs: [{ distanceMeters: 100000, durationMillis: 5400000 }] }] }),
    };
    window.google = {
      maps: { importLibrary: async (n) => ({ routes: { Route }, places }[n] || {}), event: { trigger() {} } },
    };
  });
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());

  // Seed one leg (two stops) so "Add stop" appends a second leg with the pickup pre-filled
  // and an empty drop-off — the exact case that focuses the new .leg-to field.
  await page.goto('/plan.html?stops=' + encodeURIComponent('Colombo|Kandy') + '&pax=2&vehicle=car');
  await expect(page.locator('#rail .leg-card')).toHaveCount(1);

  await page.locator('#add-stop').click();
  await expect(page.locator('#rail .leg-card')).toHaveCount(2);

  const lastTo = page.locator('#rail .leg-card').last().locator('.leg-to');
  // The new empty drop-off field is focused (ready to type)...
  await expect(lastTo).toBeFocused();
  // ...but the place-suggestion menu must NOT be open yet.
  await expect(page.locator('.place-menu')).toHaveCount(0);

  // Typing surfaces the menu on demand.
  await lastTo.pressSequentially('Ell', { delay: 20 });
  await expect(page.locator('.place-menu')).toHaveCount(1);
});
