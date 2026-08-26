import { test, expect } from '@playwright/test';
import { gotoBooking, fillContact, pickPlace } from './_stubs.js';
import { futureIsoDate } from '../dates.js';

// Phase 3 (engine-driven pricing), Task 3: booking.js wires POST /quote/v2/estimate through
// CH_PRICING (ch-pricing.js, Task 1) onto the adoption slot (booking.js, Task 2). These specs
// pin the fetch wiring, the pending-state gate on Pay, and the raise-acknowledge rule.

test('shows the engine total on load, not the local formula figure', async ({ page }) => {
  await gotoBooking(page, { estimate: {} }); // default stub body: totalCents 12345
  await expect(page.locator('#sum-total')).toHaveText('$123.45');
});

test('an unstubbed estimate endpoint falls back to local pricing — the flag-off/default behaviour', async ({ page }) => {
  // No `estimate` opt: gotoBooking's own default answers 404 for **/quote/v2/estimate — exactly
  // the shape a deploy with QUOTE_V2_ENABLED unset answers today. $121 is the same local-formula
  // figure pricing-flow.spec.js pins for this identical default route/vehicle (cmb-airport →
  // hikkaduwa, AC car) — proof the 404 path is byte-identical to pre-engine behaviour, not a
  // freshly guessed number.
  await gotoBooking(page);
  await expect(page.locator('#sum-total')).toHaveText('$121');
  await fillContact(page);
  await page.click('#pay-btn');
  await expect.poll(
    () => page.locator('#pass-ref').textContent(),
    { timeout: 8000 },
  ).toMatch(/CH-/);
});

test('a stepper change fires a fresh estimate request and updates the total', async ({ page }) => {
  const hits = [];
  page.on('request', (r) => { if (r.url().includes('/quote/v2/estimate')) hits.push(r.url()); });
  // Keyed off the posted pax count (not request order) so the assertion holds regardless of
  // exactly how many requests the wizard's own re-render churn fires. A LOWER total for the
  // second figure keeps this test purely about the fetch mechanics (a new request fires, the
  // total updates) — the raise-acknowledge rule itself is the next test's job.
  await gotoBooking(page, { estimate: { respond: (intent) => ({ totalCents: intent.pax === 2 ? 8000 : 10000 }) } });

  await expect(page.locator('#sum-total')).toHaveText('$100');

  await page.evaluate(() => window.goStep && window.goStep(3));
  await page.click('#ad-step .ctrls button:has-text("+")');

  await expect(page.locator('#sum-total')).toHaveText('$80');
  expect(hits.length).toBe(2);
});

test('a higher engine total after a change requires acknowledgement before Continue', async ({ page }) => {
  // Keyed off the posted drop-off leg (not request order): the re-pick below changes it from
  // the settled area name to a Google-picked "… Result N" string.
  await gotoBooking(page, {
    pickGeo: { lat: 6.15, lng: 80.11 },
    estimate: { respond: (intent) => ({ totalCents: /Result/.test(intent.legs[0].to) ? 20000 : 10000 }) },
  });
  await expect(page.locator('#sum-total')).toHaveText('$100');

  // Re-pick the drop-off — a genuinely different itinerary, so a new (higher) estimate follows.
  await pickPlace(page, '#loc-to', 'ac-to', 'Hikkaduwa hotel', 1);

  // Heads-up appears in the persistent summary sidebar; total holds; Continue is gated. The OLD
  // local repriceDecision notice must NOT also fire — the engine path subsumes it.
  await expect(page.locator('#engine-reprice-note')).toBeVisible();
  await expect(page.locator('#engine-reprice-note')).toContainText('$100');
  await expect(page.locator('#engine-reprice-note')).toContainText('$200');
  await expect(page.locator('#reprice-note')).toHaveCount(0);
  await expect(page.locator('#sum-total')).toHaveText('$100');
  await expect(page.locator('#n1')).toBeDisabled();

  await page.click('#engine-reprice-note button');
  await expect(page.locator('#sum-total')).toHaveText('$200');
  await expect(page.locator('#engine-reprice-note')).toHaveCount(0);
  await expect(page.locator('#n1')).toBeEnabled();
});

test('a lower engine total after a change applies silently — no note, no gate', async ({ page }) => {
  await gotoBooking(page, {
    pickGeo: { lat: 6.15, lng: 80.11 },
    estimate: { respond: (intent) => ({ totalCents: /Result/.test(intent.legs[0].to) ? 15000 : 20000 }) },
  });
  await expect(page.locator('#sum-total')).toHaveText('$200');

  await pickPlace(page, '#loc-to', 'ac-to', 'Hikkaduwa hotel', 1);

  await expect(page.locator('#sum-total')).toHaveText('$150');
  await expect(page.locator('#engine-reprice-note')).toHaveCount(0);
  await expect(page.locator('#n1')).toBeEnabled();
});

test('a delayed estimate blocks Pay until it settles', async ({ page }) => {
  // Generously long delay: fillContact() alone (goStep + several fills) already eats a real
  // chunk of wall-clock time in a live browser, and the assertion below needs the estimate to
  // still be in flight once it's done filling.
  await gotoBooking(page, { estimate: { delayMs: 4000 } });
  await fillContact(page);

  // Still resolving: Pay must refuse (disabled, with a reason) rather than open the overlay.
  await expect(page.locator('#pay-btn')).toBeDisabled();
  await expect(page.locator('#details-error')).toContainText('latest price');
  await expect(page.locator('#ph-overlay')).toBeHidden();

  // Playwright's own actionability wait mirrors "refused, then proceeds once settled": this
  // click only lands once #pay-btn re-enables, at which point the attempt goes through end to end.
  await page.click('#pay-btn');
  await expect.poll(
    () => page.locator('#pass-ref').textContent(),
    { timeout: 8000 },
  ).toMatch(/CH-/);
});

test('an "estimated" engine total shows the ~ approx treatment and refuses payment', async ({ page }) => {
  await gotoBooking(page, { estimate: { estimated: true } });
  await expect(page.locator('#sum-total')).toHaveText('~$123.45');

  await fillContact(page);
  await expect(page.locator('#pay-btn')).toBeDisabled();
  await expect(page.locator('#details-error')).toContainText('confirmed at checkout');
  await expect(page.locator('#ph-overlay')).toBeHidden();
});

test('a booking-create total more than $1 from the shown engine total gates before checkout', async ({ page }) => {
  // Engine estimate shows $123.45; the booking-create response (adoptServerQuote) lands
  // materially different — more than $1 away — so the accept gate must surface INSIDE the
  // overlay before the checkout/gateway step is ever reached.
  await gotoBooking(page, { estimate: {}, bookingTotal: 15000 }); // $123.45 shown → $150.00 on create
  await expect(page.locator('#sum-total')).toHaveText('$123.45');
  await fillContact(page);
  await page.click('#pay-btn');

  await expect(page.locator('#ph-overlay')).toBeVisible();
  await expect(page.locator('#ph-msg')).toContainText('$150');
  await expect(page.locator('#ph-msg')).toContainText('$123.45');
  await expect(page.locator('#ph-accept-reprice')).toBeVisible();

  const sawCheckout = await page
    .waitForRequest('**/bookings/*/checkout', { timeout: 1000 })
    .then(() => true)
    .catch(() => false);
  expect(sawCheckout).toBe(false); // not yet — still waiting on the accept

  const checkoutP = page.waitForRequest('**/bookings/*/checkout');
  await page.click('#ph-accept-reprice');
  await checkoutP;
  await expect.poll(
    () => page.locator('#pass-ref').textContent(),
    { timeout: 8000 },
  ).toMatch(/CH-/);
});

test('a booking-create total within $1 of the shown engine total adopts silently, as today', async ({ page }) => {
  await gotoBooking(page, { estimate: {}, bookingTotal: 12395 }); // $123.45 shown → $123.95 on create
  await expect(page.locator('#sum-total')).toHaveText('$123.45');
  await fillContact(page);
  await page.click('#pay-btn');

  await expect(page.locator('#ph-accept-reprice')).toHaveCount(0);
  await expect.poll(
    () => page.locator('#pass-ref').textContent(),
    { timeout: 8000 },
  ).toMatch(/CH-/);
  await expect(page.locator('#pass-paid')).toHaveText('$123.95');
});

// Phase 3, Task 4: the vehicle switch (switchToVan/switchToCar) and the trip private/chauffeur
// toggle both mutate the estimate intent (vehicle, product), so Task 3's sig-driven
// requestEstimate() already re-quotes them — these specs pin that it actually happens, that
// Pay stays gated while the new estimate is in flight, and that the local vanPrice()/carPrice()
// figures the capacity-note upsell CTAs show stay ~ (comparison-only, not the engine total).
test('switching to the van re-estimates through the engine; the upsell CTA keeps its ~ local figure', async ({ page }) => {
  // Keyed off the posted vehicle, not request order: car → $200, van → $100 (delayed, so the
  // in-flight window is observable). A LOWER total for the van keeps this test about the switch
  // firing a fresh estimate and Pay staying gated while it's in flight — a HIGHER total on
  // switch would hit the raise-acknowledge gate (Task 3's own spec), which is not this test's job.
  await gotoBooking(page, {
    estimate: { respond: (intent) => ({ totalCents: intent.vehicle === 'van' ? 10000 : 20000, delayMs: intent.vehicle === 'van' ? 500 : 0 }) },
  });
  await expect(page.locator('#sum-total')).toHaveText('$200');

  await page.evaluate(() => window.goStep(3));
  await page.evaluate(() => { window.step('ad', 1); window.step('ad', 1); window.step('ad', 1); }); // 1 -> 4, over an AC car

  const note = page.locator('#cap-note');
  await expect(note).toContainText('Switch to AC van');
  // Display-only comparison figure (the local formula, not an engine total) — must read ~$…
  await expect(note).toContainText('~$');

  const hits = [];
  page.on('request', (r) => { if (r.url().includes('/quote/v2/estimate')) hits.push(r.url()); });

  await page.evaluate(() => window.switchToVan());

  // Van estimate is still in flight (500ms delay): Pay stays refused, and the total has not yet
  // dropped to the van's engine figure.
  await expect(page.locator('#pay-btn')).toBeDisabled();
  await expect(page.locator('#details-error')).toContainText('latest price');
  await expect(page.locator('#sum-total')).not.toHaveText('$100');

  // Settles: the van's distinct (lower) engine total lands and applies immediately — same rule
  // as any other lower re-quote — Pay releases, and a fresh request was fired for the switch
  // (not just reusing the car figure already on screen).
  await expect(page.locator('#sum-total')).toHaveText('$100');
  await expect(page.locator('#pay-btn')).toBeEnabled();
  expect(hits.length).toBeGreaterThan(0);
});

// Phase 3, Task 5: quotedTotal (createApiBooking's price-shown-to-price-charged evidence field)
// must be the exact figure the engine quoted, in minor units — not a re-derived or rounded one.
test('quotedTotal sent to POST /bookings/single equals the stubbed engine cents exactly', async ({ page }) => {
  let postedBody = null;
  page.on('request', (r) => {
    if (r.url().includes('/bookings/single')) postedBody = JSON.parse(r.postData() || '{}');
  });
  await gotoBooking(page, { estimate: {} }); // default stub body: totalCents 12345
  await expect(page.locator('#sum-total')).toHaveText('$123.45');
  await fillContact(page);
  await page.click('#pay-btn');
  await expect.poll(() => postedBody && postedBody.quotedTotal, { timeout: 8000 }).toBe(12345);
});

test('choosing chauffeur on a trip re-estimates through the engine with a distinct total', async ({ page }) => {
  const query = [
    'mode=trip',
    'stops=Colombo%20Airport%20(CMB)%7CKandy%7CElla',
    'nights=0,1,0',
    `dates=${futureIsoDate(30)},${futureIsoDate(32)}`,
    'pax=2',
    'vehicle=car',
  ].join('&');
  // Chauffeur below private, again to keep this test about the switch firing a fresh estimate
  // rather than about the raise-acknowledge gate a higher figure would trigger.
  await gotoBooking(page, {
    query,
    estimate: { respond: (intent) => ({ totalCents: intent.product === 'chauffeur' ? 10000 : 30000 }) },
  });
  await expect(page.locator('#sum-total')).toHaveText('$300');

  await page.locator('[data-svc="chauffeur"]').click();

  await expect(page.locator('#sum-total')).toHaveText('$100');
});

// The direction the two switch tests above deliberately skip — and the only one real pricing
// ever takes, since both a chauffeur-guide and a van cost MORE than what they replace. A raise
// the customer drove by picking a different product or vehicle needs no acknowledgement: the
// click is the acknowledgement, and both the service chooser and the van CTA name their price
// before it. Gating them announced "your price has been updated" about the very change just
// asked for, and — because private and chauffeur trips carry identically labelled summary rows
// (#490) — held the card showing the chauffeur trip at the private figure with nothing on screen
// saying which one you'd get.
test('choosing chauffeur adopts the dearer chauffeur total immediately — no acknowledge gate', async ({ page }) => {
  // Dates anchored to now, not written down: a fixed date silently becomes a PAST date and
  // takes tripDatesComplete() (which gates the chauffeur chooser) with it. Two days apart, as
  // a chauffeur trip's legs must be.
  const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const query = [
    'mode=trip',
    'stops=Colombo%20Airport%20(CMB)%7CKandy%7CElla',
    'nights=0,1,0',
    `dates=${day(14)},${day(16)}`,
    'pax=2',
    'vehicle=car',
  ].join('&');
  await gotoBooking(page, {
    query,
    estimate: { respond: (intent) => ({ totalCents: intent.product === 'chauffeur' ? 50000 : 30000 }) },
  });
  await expect(page.locator('#sum-total')).toHaveText('$300');

  await page.locator('[data-svc="chauffeur"]').click();

  // Headroom over the default 5s: setNum tweens the figure, so the assertion has to outlast the
  // debounce + fetch + the count-up itself, which is tighter than it looks on a loaded CI box.
  await expect(page.locator('#sum-total')).toHaveText('$500', { timeout: 10000 });
  await expect(page.locator('#engine-reprice-note')).toHaveCount(0);
  await expect(page.locator('#n1')).toBeEnabled();
});

test('the van upsell adopts its dearer engine total immediately — no acknowledge gate', async ({ page }) => {
  await gotoBooking(page, {
    estimate: { respond: (intent) => ({ totalCents: intent.vehicle === 'van' ? 20000 : 10000 }) },
  });
  await expect(page.locator('#sum-total')).toHaveText('$100');

  await page.evaluate(() => window.goStep(3));
  await page.evaluate(() => { window.step('ad', 1); window.step('ad', 1); window.step('ad', 1); }); // 1 -> 4, over an AC car
  await expect(page.locator('#cap-note')).toContainText('Switch to AC van');

  await page.evaluate(() => window.switchToVan());

  await expect(page.locator('#sum-total')).toHaveText('$200', { timeout: 10000 });
  await expect(page.locator('#engine-reprice-note')).toHaveCount(0);
  await expect(page.locator('#n1')).toBeEnabled();
});

// A raise the customer did NOT choose keeps its gate — this is the line the exemption must not
// cross. Same trip, same vehicle, same product: only the itinerary moved.
test('a raise with no product or vehicle change is still gated', async ({ page }) => {
  await gotoBooking(page, {
    pickGeo: { lat: 6.15, lng: 80.11 },
    estimate: { respond: (intent) => ({ totalCents: /Result/.test(intent.legs[0].to) ? 20000 : 10000 }) },
  });
  await expect(page.locator('#sum-total')).toHaveText('$100');

  await pickPlace(page, '#loc-to', 'ac-to', 'Hikkaduwa hotel', 1);

  await expect(page.locator('#engine-reprice-note')).toBeVisible();
  await expect(page.locator('#sum-total')).toHaveText('$100');
});

// The in-flight window. Changing a priced itinerary (service, vehicle, pax, a re-pinned spot)
// makes engineEst stale, and calcTotal() used to fall straight through to the LOCAL formula for
// the ~1.2s until the new estimate landed — a figure that is the OFFLINE FALLBACK, not anything
// the customer was ever quoted. On a trip the drop is dramatic (the local chauffeur formula
// prices the browser's static km table, not the engine's measured distances), so the total
// visibly counted DOWN to a number we would not honour and then back up. The summary now says
// what is actually happening instead of showing a price nobody quoted.
const TRIP_QUERY = [
  'mode=trip',
  'stops=Colombo%20Airport%20(CMB)%7CKandy%7CElla',
  'nights=0,1,0',
  `dates=${futureIsoDate(30)},${futureIsoDate(32)}`,
  'pax=2',
  'vehicle=car',
].join('&');

// Records every value #sum-total takes from here on, so an intermediate figure that exists for
// only a frame can't hide between two assertions. Install BEFORE the interaction under test.
async function watchTotal(page) {
  await page.evaluate(() => {
    const el = document.getElementById('sum-total');
    window.__seenTotals = [el.textContent];
    new MutationObserver(() => window.__seenTotals.push(el.textContent))
      .observe(el, { childList: true, characterData: true, subtree: true });
  });
}
// Every numeric value seen. "Calculating…" carries no digits, so it drops out here rather than
// parsing as a bogus figure.
async function seenNumbers(page) {
  const seen = await page.evaluate(() => window.__seenTotals);
  return seen
    .map((t) => parseFloat(String(t).replace(/[^0-9.]/g, '')))
    .filter((n) => !Number.isNaN(n));
}

test('an in-flight re-estimate says so instead of showing the local fallback figure', async ({ page }) => {
  // Both engine figures sit ABOVE this trip's local chauffeur formula ($226, measured — the
  // local private figure is $112.50). That's what makes the bound below meaningful: a tween
  // frame between $300 and $250 can never fall under $250, so anything that does is the local
  // formula leaking through, not the count itself.
  await gotoBooking(page, {
    query: TRIP_QUERY,
    estimate: {
      respond: (intent) => (intent.product === 'chauffeur'
        ? { totalCents: 25000, delayMs: 900 }
        : { totalCents: 30000 }),
    },
  });
  await expect(page.locator('#sum-total')).toHaveText('$300');

  await watchTotal(page);
  await page.locator('[data-svc="chauffeur"]').click();

  // In flight: the total, and the Due now figure beside it on the payment step, both say the
  // price is being worked out rather than each showing a different number.
  await expect(page.locator('#sum-total')).toHaveText(/Calculating/);
  await expect(page.locator('#pay-due .amt')).toHaveText(/Calculating/);

  // Settles on the engine's chauffeur figure (lower than the private one, so it applies
  // silently — the raise-acknowledge gate is a different spec's job).
  await expect(page.locator('#sum-total')).toHaveText('$250');
  await expect(page.locator('#pay-due .amt')).toHaveText('$250');

  // The whole journey from $300 to $250 never dipped below the pair — no third figure.
  const nums = await seenNumbers(page);
  expect(Math.min(...nums)).toBeGreaterThanOrEqual(250);
});

test('an estimate that fails mid-change hands the total to the local fallback, not a stale engine figure', async ({ page }) => {
  // A 500 (transient) rather than a 404: a 404 latches CH_PRICING off for the whole session,
  // which is the flag-off world two specs above already pin. Here the engine is meant to be on
  // and simply fails this one request — the moment we genuinely HAVE lost it, so the local
  // formula is the honest number to fall back to and holding $300 would strand a price for an
  // itinerary the customer no longer has.
  await gotoBooking(page, {
    query: TRIP_QUERY,
    estimate: {
      respond: (intent) => (intent.product === 'chauffeur'
        ? { status: 500, delayMs: 700 }
        : { totalCents: 30000 }),
    },
  });
  await expect(page.locator('#sum-total')).toHaveText('$300');

  await page.locator('[data-svc="chauffeur"]').click();
  await expect(page.locator('#sum-total')).toHaveText(/Calculating/);

  // $226 is this trip's local chauffeur formula — the fallback taking over, as it does with the
  // flag off entirely. Pay is released too: there is no longer an estimate to wait for.
  await expect(page.locator('#sum-total')).toHaveText('$225');
  await expect(page.locator('#pay-due .amt')).toHaveText('$225');
});

test('the engine timing out never suppresses the local reprice notice (engine must have actually answered, not merely "not yet 404")', async ({ page }) => {
  // The estimate endpoint never settles within ch-pricing.js's own 3s abort — a timeout, not a
  // flag-off 404. window.CH_PRICING.available() stays true the whole time (only a 404 latches it
  // false), so gating the local reprice heads-up on available() alone would wrongly treat this as
  // "the engine owns repricing" even though it never delivered a single estimate this session.
  await gotoBooking(page, { routeKm: 400, pickGeo: { lat: 6.15, lng: 80.11 }, estimate: { delayMs: 4000 } });
  await expect(page.locator('#sum-total')).toHaveText('$121');

  // Let the in-flight estimate actually time out before pinning, so this proves the engine truly
  // never answered this session — not just "hasn't answered yet".
  await page.waitForTimeout(3500);

  await pickPlace(page, '#loc-to', 'ac-to', 'Hikkaduwa hotel', 1);

  // The engine never delivered an estimate this session — the pre-existing LOCAL reprice notice
  // (repriceDecision) must still fire; the local formula is still the one in charge of the total.
  await expect(page.locator('#reprice-note')).toBeVisible();
  await expect(page.locator('#sum-total')).toHaveText('$121');
});
