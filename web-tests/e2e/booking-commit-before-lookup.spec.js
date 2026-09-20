import { test, expect } from '@playwright/test';
import { gotoBooking, pickPlace } from './_stubs.js';

// The "Hotel or address (optional)" box used to hand Google whatever was in it on EVERY keystroke.
// Type five letters of "Jaffna" and the site asked Google to route to the place "jaffn":
//
//     renderRoute stops: ["Colombo Airport (CMB)", "jaffn"]
//
// The map legend then printed the customer's half-typed text back at them in lowercase (which is
// what the 2026-08-27 screenshot showed), and — more seriously — the distance Google measured for
// that guess comes back through onRoute, where it can park a repriceDecision. A half-finished word
// could nudge the price.
//
// plan.js has always drawn this line and says so: a live distance "is resolved only once a place is
// COMMITTED — on 'change' (a dropdown pick or a blur onto a real place) ... never here on raw
// keystrokes, so a half-typed string like 'ga' is never geocoded or priced". The booking page's
// exact-spot field simply never got the same rule. It has it now.
//
// Committed means: picked from the menu, or the field was left (blur). An EMPTY field is committed
// too — that is the customer saying "no exact spot", and the map correctly falls back to the area.

async function instrument(page) {
  await page.evaluate(() => {
    window.__routeCalls = [];
    const orig = window.CH_MAP.renderRoute.bind(window.CH_MAP);
    window.CH_MAP.renderRoute = (host, stops, opts) => {
      window.__routeCalls.push(JSON.parse(JSON.stringify(stops)));
      return orig(host, stops, opts);
    };
  });
}
const calls = (page) => page.evaluate(() => window.__routeCalls);
const flat = (cs) => JSON.stringify(cs);

test('typing a partial place name never reaches Google', async ({ page }) => {
  await gotoBooking(page, { pickGeo: { lat: 6.15, lng: 80.11 } });
  await instrument(page);

  // Commit a real pick first — this is what arms the re-price path in a real session.
  await pickPlace(page, '#loc-to', 'ac-to', 'Hikkaduwa hotel', 1);
  await page.waitForTimeout(700);
  await page.evaluate(() => { window.__routeCalls = []; });

  // Type a half-finished string and pick nothing. The debounce is 450ms; wait well past it.
  await page.fill('#loc-to', 'jaffn');
  await page.waitForTimeout(1200);

  expect(flat(await calls(page))).not.toContain('jaffn');
});

test('leaving the field commits it, and then it is looked up', async ({ page }) => {
  await gotoBooking(page, { pickGeo: { lat: 6.15, lng: 80.11 } });
  await instrument(page);

  // the exact-spot fields live on the "Where" step (2), same as pickPlace() in _stubs.js
  await page.evaluate(() => window.goStep && window.goStep(2));
  await page.fill('#loc-to', 'Some Beach Villa');
  await page.waitForTimeout(700);
  expect(flat(await calls(page))).not.toContain('Some Beach Villa');

  // Click away — the customer has finished with the field.
  await page.locator('#loc-from').click();
  await page.waitForTimeout(1200);

  expect(flat(await calls(page))).toContain('Some Beach Villa');
});

test('picking from the menu still looks the place up immediately', async ({ page }) => {
  await gotoBooking(page, { pickGeo: { lat: 6.15, lng: 80.11 } });
  await instrument(page);

  await pickPlace(page, '#loc-to', 'ac-to', 'Hikkaduwa hotel', 1);
  await page.waitForTimeout(900);

  // A menu pick resolves to coordinates, so the stop is a {lat,lng} rather than a name — what
  // matters is that the lookup HAPPENED without waiting for a blur.
  const cs = await calls(page);
  expect(cs.length).toBeGreaterThan(0);
});

test('clearing the field falls back to the area, without a blur', async ({ page }) => {
  await gotoBooking(page, { pickGeo: { lat: 6.15, lng: 80.11 } });
  await pickPlace(page, '#loc-to', 'ac-to', 'Hikkaduwa hotel', 1);
  await page.waitForTimeout(700);
  await instrument(page);

  // Emptying the box IS a committed state: "I have no exact spot". The map must go back to the
  // settled drop-off area rather than freezing on the spot that was just removed.
  await page.fill('#loc-to', '');
  await page.waitForTimeout(1200);

  expect(flat(await calls(page))).toContain('Hikkaduwa');
});
