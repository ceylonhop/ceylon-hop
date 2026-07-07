import { test, expect } from '@playwright/test';

// The planner's "Add your dates" step used to silently reorder the legs into
// chronological order when a customer typed an out-of-order date. It now keeps
// the route as the customer built it and *flags* the offending leg instead
// (mirroring the ops quote tool's "Dates out of order" flag). plan.js:outOfOrderFlags.

const STOPS = 'Colombo Airport (CMB)|Sigiriya|Kandy'; // -> Leg 1: CMB→Sigiriya, Leg 2: Sigiriya→Kandy

// The per-leg date input is turned into a hidden field by the custom datepicker,
// so drive it the way the app does: set the value and fire the change event.
async function setLegDate(page, legIndex, iso) {
  await page.$eval(
    `.date-row[data-i="${legIndex}"] input`,
    (el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); },
    iso,
  );
  await page.waitForTimeout(150);
}

async function pickPlannerPlace(page, field, query, label) {
  await field.click();
  await field.fill(query);
  await expect(page.locator('.place-menu')).toBeVisible();
  await page.locator('.place-option', { hasText: label }).first().click();
}

async function installGooglePlacesStub(page) {
  await page.addInitScript(() => {
    const latlng = (lat, lng) => ({ lat: () => lat, lng: () => lng });
    function DirectionsService() {}
    DirectionsService.prototype.route = function (req, cb) {
      cb({ routes: [{ legs: [{ distance: { value: 100000 }, duration: { value: 7200 } }] }] }, 'OK');
    };
    function DirectionsRenderer() {}
    DirectionsRenderer.prototype.setMap = function () {};
    DirectionsRenderer.prototype.setDirections = function () {};
    function MapCls() {}
    const places = {
      AutocompleteSessionToken: function () {},
      AutocompleteSuggestion: {
        fetchAutocompleteSuggestions: async ({ input }) => ({
          suggestions: [{
            placePrediction: {
              text: { text: `${input} Hotel, Colombo, Sri Lanka` },
              mainText: { text: `${input} Hotel` },
              secondaryText: { text: 'Colombo, Sri Lanka' },
              toPlace: () => ({
                fetchFields: async () => {},
                location: latlng(6.916, 79.85),
                displayName: `${input} Hotel`,
                formattedAddress: `${input} Hotel, Colombo, Sri Lanka`,
              }),
            },
          }],
        }),
      },
    };
    window.google = {
      maps: {
        Map: MapCls,
        DirectionsService,
        DirectionsRenderer,
        TravelMode: { DRIVING: 'DRIVING' },
        places,
        importLibrary: async (name) => (name === 'places' ? places : {}),
      },
    };
  });
}

test('out-of-order leg dates raise a flag and never reorder the itinerary', async ({ page }) => {
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.goto(`/plan.html?step=dates&stops=${encodeURIComponent(STOPS)}`);

  const rows = page.locator('#dates-list .date-row');
  await expect(rows).toHaveCount(2);
  const warn = page.locator('.dr-warn');

  // Drag-to-reorder is removed from the dates step (reordering there unchains the route).
  await expect(page.locator('#dates-list .date-row[draggable="true"]')).toHaveCount(0);
  await expect(page.locator('#dates-list .date-row .drag')).toHaveCount(0);

  // In chronological order → no flag.
  await setLegDate(page, 0, '2026-08-10');
  await setLegDate(page, 1, '2026-08-20');
  await expect(warn).toHaveCount(0);

  // Date Leg 2 BEFORE Leg 1. Old behaviour: Leg 2 slides above Leg 1.
  // New behaviour: order is preserved and Leg 2 is flagged.
  await setLegDate(page, 1, '2026-08-05');
  await expect(warn).toHaveCount(1);
  await expect(warn).toBeVisible();
  await expect(warn).toContainText(/out of order/i);

  // The itinerary did NOT reorder: Leg 1 is still first (CMB→Sigiriya),
  // and the flag sits on the second row (Sigiriya→Kandy).
  await expect(rows.first().locator('.dr-route')).toContainText('Colombo');
  await expect(rows.nth(1).locator('.dr-route')).toContainText('Kandy');
  await expect(page.locator('.date-row[data-i="1"] .dr-warn')).toBeVisible();

  // Fix the date so the trip runs forward again → flag clears.
  await setLegDate(page, 1, '2026-08-25');
  await expect(warn).toHaveCount(0);
});

test('an out-of-order date blocks "Continue to booking" until it is fixed', async ({ page }) => {
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.goto(`/plan.html?step=dates&stops=${encodeURIComponent(STOPS)}`);

  const cont = page.locator('#dates-continue');
  const hint = page.locator('#dates-order-hint');

  // Put the legs out of chronological order.
  await setLegDate(page, 0, '2026-08-10');
  await setLegDate(page, 1, '2026-08-05');

  // CTA is disabled + a blocking hint shows, and clicking does NOT leave plan.html.
  await expect(cont).toHaveClass(/cta-disabled/);
  await expect(cont).toHaveAttribute('aria-disabled', 'true');
  await expect(hint).toBeVisible();
  await cont.click({ force: true }); // force past the cookie banner; the gate is in the handler
  await page.waitForTimeout(200);
  await expect(page).toHaveURL(/plan\.html/);

  // Fix the order → CTA re-enables and now proceeds to booking.
  await setLegDate(page, 1, '2026-08-20');
  await expect(cont).not.toHaveClass(/cta-disabled/);
  await expect(hint).toBeHidden();
  await cont.click({ force: true });
  await expect(page).toHaveURL(/booking\.html/);
});

test('added planner legs and dates survive refresh', async ({ page }) => {
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.goto('/plan.html?stops=Colombo%20Airport%20(CMB)%7CKandy&pax=2&vehicle=car');

  await page.locator('#add-stop').click();
  await expect(page.locator('#rail .leg-card')).toHaveCount(2);
  await pickPlannerPlace(page, page.locator('#rail .leg-card').nth(1).locator('.leg-to'), 'Ella', 'Ella');

  await page.locator('#request-btn').click();
  await setLegDate(page, 0, '2026-08-08');
  await setLegDate(page, 1, '2026-08-09');
  await expect(page.locator('#dates-list .date-row')).toHaveCount(2);

  await page.reload();

  await expect(page.locator('#dates-list .date-row')).toHaveCount(2);
  await expect(page.locator('.date-row[data-i="0"] input')).toHaveValue('2026-08-08');
  await expect(page.locator('.date-row[data-i="1"] input')).toHaveValue('2026-08-09');
  await expect(page.locator('.date-row[data-i="1"] .dr-route')).toContainText('Ella');
});

test('planner place search ranks CMB as airport and prices the baked CMB to Sigiriya route', async ({ page }) => {
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.goto('/plan.html?stops=Colombo%20city%7CSigiriya%20%2F%20Dambulla&pax=2&vehicle=car');

  const from = page.locator('#rail .leg-card').first().locator('.leg-from');
  await from.click();
  await from.fill('CMB');
  await expect(page.locator('.place-option').first()).toContainText('Colombo Airport (CMB)');
  await page.locator('.place-option', { hasText: 'Colombo Airport (CMB)' }).first().click();

  await expect(from).toHaveValue('Colombo Airport (CMB)');
  await expect(page.locator('#rail [data-dist]')).toContainText('152 km');
  await expect(page.locator('#rail [data-dist]')).toContainText('from $77');

  await page.reload();

  await expect(page.locator('#rail .leg-card').first().locator('.leg-from')).toHaveValue('Colombo Airport (CMB)');
  await expect(page.locator('#rail [data-dist]')).toContainText('152 km');
});

test('planner place search layers known, Google, then exact-place results for hotel text', async ({ page }) => {
  await installGooglePlacesStub(page);
  await page.goto('/plan.html?stops=Sigiriya%20%2F%20Dambulla%7CColombo%20city&pax=1&vehicle=car');

  const to = page.locator('#rail .leg-card').first().locator('.leg-to');
  await to.click();
  await to.fill('hilton colombo');

  const options = page.locator('.place-option');
  await expect(options.first()).toContainText('Colombo city');
  await expect(options.nth(1)).toContainText('hilton colombo Hotel');
  await expect(options.last()).toContainText('Use exact place: hilton colombo');
  await expect(page.locator('.place-option', { hasText: 'Galle' })).toHaveCount(0);

  await options.nth(1).click();
  await expect(to).toHaveValue('hilton colombo Hotel');
  await expect(page.locator('#rail [data-dist]')).toContainText('Pick both points');
});

test('planner dates step keeps a durable URL for browser back', async ({ page }) => {
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.goto(`/plan.html?step=dates&stops=${encodeURIComponent(STOPS)}`);

  await setLegDate(page, 0, '2026-08-10');
  await setLegDate(page, 1, '2026-08-20');

  const url = new URL(page.url());
  expect(url.pathname).toContain('plan.html');
  expect(url.searchParams.get('step')).toBe('dates');
  expect(url.searchParams.get('dates')).toBe('2026-08-10,2026-08-20');
  await expect(page.locator('#dates-wrap')).toBeVisible();
  await expect(page.locator('#dates-list .date-row')).toHaveCount(2);
  await expect(page.locator('.date-row[data-i="0"] input')).toHaveValue('2026-08-10');
  await expect(page.locator('.date-row[data-i="1"] input')).toHaveValue('2026-08-20');
});
