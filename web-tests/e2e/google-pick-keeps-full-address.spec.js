import { test, expect } from '@playwright/test';
import { blockLiveApi, gotoBooking } from './_stubs.js';

// CH-E7EE8 / CH-FHYQT (2026-10-18): a customer picked "Casa Selvita" from Google's list in the
// planner. The page then replaced Google's full text ("Casa Selvita, Wariyapola Sri Sumangala
// Mawatha, Kandy, Sri Lanka") with the short main text, the server couldn't place the bare name,
// and the booking landed unpriced. Three days later the same leg priced first time with the full
// text (CH-SA45S). Four more unpriced single transfers came through the booking page's exact-spot
// fields, which drop the full text the same way. A pick must keep what Google gave us.

const FULL = 'Casa Selvita, Wariyapola Sri Sumangala Mawatha, Kandy, Sri Lanka';
const MAIN = 'Casa Selvita';

// Real Google predictions carry a long `text` and a short `mainText`; the shared stub makes them
// equal, which hides this bug. Swap in a prediction shaped like the real one whenever the page's
// Google stub is installed (by this spec or by _stubs.js), whichever init script runs first.
function realisticPrediction({ full, main, lat, lng }) {
  const patch = (g) => {
    const orig = g.maps.importLibrary;
    g.maps.importLibrary = async (name) => {
      const lib = await orig(name);
      if (name !== 'places') return lib;
      return {
        ...lib,
        AutocompleteSessionToken: function () {},
        AutocompleteSuggestion: {
          fetchAutocompleteSuggestions: async () => ({
            suggestions: [{
              placePrediction: {
                text: { text: full },
                mainText: { text: main },
                secondaryText: { text: full.slice(main.length + 2) },
                toPlace: () => ({
                  fetchFields: async () => {},
                  location: { lat: () => lat, lng: () => lng },
                  displayName: main,
                  formattedAddress: full,
                }),
              },
            }],
          }),
        },
      };
    };
    return g;
  };
  let current;
  Object.defineProperty(window, 'google', {
    configurable: true,
    get: () => current,
    set: (v) => { current = v && v.maps ? patch(v) : v; },
  });
}

test('the planner keeps Google’s full text for a picked place, in the field and the trip', async ({ page }) => {
  await blockLiveApi(page);
  await page.addInitScript(realisticPrediction, { full: FULL, main: MAIN, lat: 7.29, lng: 80.63 });
  await page.addInitScript(() => {
    const Route = { computeRoutes: async () => ({ routes: [{ legs: [{ distanceMeters: 87000, durationMillis: 7200000 }] }] }) };
    window.google = { maps: { importLibrary: async (n) => ({ routes: { Route }, places: {} }[n] || {}), event: { trigger() {} } } };
  });
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.goto('/plan.html?stops=' + encodeURIComponent('Sigiriya|Kandy') + '&pax=2&vehicle=car');

  const to = page.locator('#rail .leg-card').first().locator('.leg-to');
  await to.click();
  await to.fill('');
  await to.pressSequentially('Casa Sel', { delay: 30 });
  await page.locator('.place-menu .place-option', { hasText: MAIN }).first().click();

  await expect(to).toHaveValue(FULL);
  await expect.poll(() => new URL(page.url()).searchParams.get('stops')).toContain(FULL);
});

test('the booking page keeps Google’s full text for a picked drop-off', async ({ page }) => {
  // Hikkaduwa, so the "exact spot within 10 km of its area" guard accepts the pick.
  await page.addInitScript(realisticPrediction, { full: FULL, main: MAIN, lat: 6.14, lng: 80.10 });
  const intents = [];
  await gotoBooking(page, { estimate: { respond: (intent) => { intents.push(intent); return {}; } } });
  await page.evaluate(() => window.goStep && window.goStep(2));
  await page.fill('#loc-to', 'Casa Sel');
  await page.locator('#ac-to .ac-item', { hasText: MAIN }).first().click();

  await expect(page.locator('#loc-to')).toHaveValue(FULL);
  // What the server prices is the full text...
  await expect.poll(() => intents.some((i) => (i.legs || []).some((l) => l.to === FULL))).toBe(true);
  // ...while the summary still reads short, as it does for a home-search booking today.
  await expect(page.locator('#sum-name')).toContainText('Casa Selvita · Kandy');
});
