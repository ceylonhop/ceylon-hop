// Shared e2e harness: stubs Google Maps + PayHere in the page and mocks the API,
// so the booking journeys are deterministic and run fully offline.

// Runs in the PAGE before any site script. Must be self-contained (no closures).
// Exported so pages outside the booking journey (quote.html) can install the same Google
// stub and exercise the real ch-map render path offline.
export function installStubs() {
  const latlng = (lat, lng) => ({ lat: () => lat, lng: () => lng });

  // Mirrors the async-loaded Maps API (see ops-itin-map.spec.js): classes come ONLY from
  // importLibrary, and routing is the routes library's Route.computeRoutes — the legacy
  // DirectionsService/DirectionsRenderer are deliberately absent so any lingering use of
  // them throws. Requests are recorded on window.__computeRoutesReqs for assertions.
  function MapCls(el, opts) { (window.__chMaps = window.__chMaps || []).push(opts || {}); }
  MapCls.prototype.fitBounds = function () {};
  // Pins became zoom-aware (they re-group as you zoom, 2026-08-07) and the renderer now calls
  // getZoom()/addListener(). Without them the whole pin pass threw into its "markers are
  // non-essential" catch and every marker assertion silently saw an EMPTY list — map-expand's
  // and ops-map-pin-numbers' pin tests had been dark ever since.
  MapCls.prototype.getZoom = function () { return 10; };
  MapCls.prototype.addListener = function () { return { remove() {} }; };
  function Marker(opts) { (window.__chMarkers = window.__chMarkers || []).push(opts || {}); }
  Marker.prototype.setMap = function () {};
  function Point() {}
  function Polyline() {}
  Polyline.prototype.setOptions = function () {};
  Polyline.prototype.setMap = function () {};
  const Route = {
    computeRoutes: async (req) => {
      (window.__computeRoutesReqs = window.__computeRoutesReqs || []).push(req);
      const km = (typeof window.__E2E_ROUTE_KM === 'number') ? window.__E2E_ROUTE_KM : 100;
      return {
        routes: [{
          path: [],
          viewport: {},
          legs: [{
            distanceMeters: km * 1000,
            durationMillis: Math.round((km / 0.7) * 60) * 1000,
            startLocation: { lat: 6.93, lng: 79.85 },
            endLocation: { lat: 7.29, lng: 80.63 },
          }],
          createPolylines: () => [new Polyline()],
        }],
      };
    },
  };

  const places = {
    AutocompleteSessionToken: function () {},
    AutocompleteSuggestion: {
      fetchAutocompleteSuggestions: async ({ input }) => ({
        suggestions: await new Promise((resolve) => {
          const delay = Number(window.__E2E_GOOGLE_DELAY || 0);
          setTimeout(() => resolve([1, 2, 3].map((n) => ({
          placePrediction: {
            text: { text: `${input} Result ${n}` },
            mainText: { text: `${input} Result ${n}` },
            secondaryText: { text: 'Sri Lanka' },
            toPlace: () => ({
              fetchFields: async () => {},
              // Default picks sit near Colombo. A test can pin picks inside a specific
              // drop-off area via window.__E2E_PICK_GEO so the booking page's
              // "exact spot within 10 km of its area" guard is satisfied.
              location: (window.__E2E_PICK_GEO
                ? latlng(window.__E2E_PICK_GEO.lat + n * 0.002, window.__E2E_PICK_GEO.lng + n * 0.002)
                : latlng(6.9 + n * 0.01, 79.9 + n * 0.01)),
              displayName: `${input} Result ${n}`,
              formattedAddress: `${input} Result ${n}, Sri Lanka`,
            }),
          },
          }))), delay);
        }),
      }),
    },
  };

  const libs = { maps: { Map: MapCls, Polyline }, routes: { Route }, marker: { Marker }, core: { Point }, places };
  window.google = {
    maps: {
      importLibrary: async (name) => libs[name] || {},
      event: { trigger() {} },
    },
  };

  // PayHere SDK stub — outcome controlled by window.__E2E_PAYHERE.
  window.payhere = {
    onCompleted: null, onDismissed: null, onError: null,
    startPayment() {
      const r = window.__E2E_PAYHERE || 'completed';
      setTimeout(() => {
        if (r === 'completed' && this.onCompleted) this.onCompleted('TEST-PAY-ID');
        else if (r === 'dismissed' && this.onDismissed) this.onDismissed();
        else if (r === 'error' && this.onError) this.onError('e2e-error');
      }, 30);
    },
  };
}

const json = (obj) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });

// index/why/tours/tour/search/plan.html each fire a fire-and-forget GET to
// CEYLON_HOP_API + '/health' on load, to warm a cold Render instance before showing a price
// (see 0e0f077). gotoBooking() below already stubs '**/health' for the booking journey; specs
// that navigate to those six pages directly must call this first, or the "offline by default"
// suite (playwright.config.js) fires a real request at the production API on every local run.
// booking.html ALSO loads ch-pricing.js unconditionally (Phase 3), which fires its own POST
// /quote/v2/estimate on load regardless of whether the spec knows about engine pricing — a
// spec that reaches booking.html by any route other than gotoBooking() (which stubs this
// itself) must call blockLiveApi() too, or that POST goes to the real prod API. 404 is the
// flag-off shape the real API answers with today, matching gotoBooking's own default.
export async function blockLiveApi(page) {
  await page.route('**/health', (r) => r.fulfill(json({ status: 'ok' })));
  await page.route('**/quote/v2/estimate', (r) => r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' }));
}

// Engine price estimate (Phase 3, POST /quote/v2/estimate). Pass this via gotoBooking's own
// `estimate` opt (registered BEFORE navigation) rather than calling it again after — ch-pricing.js
// debounces only 400ms, and gotoBooking's own default 404 can already have landed and latched
// CH_PRICING.available() false by the time `await gotoBooking(...)` returns (page.goto() waits
// for the 'load' event, which on a real page can easily take longer than 400ms); once latched, a
// route registered afterwards never even gets a fetch to answer.
//
// `respond(intent, n)` is how a spec gets a DIFFERENT body for a LATER request (e.g. "higher
// total after a change") without depending on request ORDER matching the order the spec expects:
// it's called with the posted intent (so it can key off the actual pax/legs/etc, not a guess at
// which request this is) and the 1-based call count, and its return value is merged over the
// defaults below. `sequence` is the simpler array form for when call order genuinely is what
// varies the response — the Nth request gets `sequence[N-1]`, and the last entry repeats past
// the end of the array. The default single-response body is deterministic and distinct from
// every local-formula figure the fixtures use, so a spec can tell "engine total shown" from
// "local fallback" apart at a glance.
export async function installEstimateStub(page, opts = {}) {
  const { sequence = null, respond = null, ...single } = opts;
  let n = 0;
  await page.route('**/quote/v2/estimate', async (r) => {
    n += 1;
    const intent = JSON.parse(r.request().postData() || '{}');
    const o = respond ? (respond(intent, n) || {})
      : sequence ? sequence[Math.min(n - 1, sequence.length - 1)]
      : single;
    const {
      status = 200,
      totalCents = 12345,
      amountDueNowCents = totalCents,
      estimated = false,
      legs = [{ from: 'A', to: 'B', distanceKm: 100, durationMin: 120 }],
      delayMs = 0,
    } = o;
    if (delayMs) await new Promise((res) => setTimeout(res, delayMs));
    if (status !== 200) {
      return r.fulfill({ status, contentType: 'application/json', body: '{"error":"not_found"}' });
    }
    return r.fulfill(json({ totalCents, amountDueNowCents, estimated, legs }));
  });
}

/**
 * Set up stubs + API mocks, then navigate to a page.
 * opts:
 *   query        - querystring for booking.html (without leading ?)
 *   path         - page path (default '/booking.html')
 *   routeKm      - distance the stubbed Route.computeRoutes reports (default 100)
 *   bookingStatus- HTTP status for POST /bookings/* (default 201)
 *   checkout     - 'fake' (default, simulate path) | 'payhere'
 *   payhere      - 'completed' (default) | 'dismissed' | 'error'
 */
export async function gotoBooking(page, opts = {}) {
  const {
    query = 'mode=private&from=cmb-airport&to=hikkaduwa&price=121&vehicle=car',
    path = '/booking.html',
    routeKm = 100,
    bookingStatus = 201,
    checkout = 'fake',
    payhere = 'completed',
    bookingTotal = 12100,            // server-authoritative total (minor units) from /bookings/single
    bookingAmountDueNow = undefined, // optional charge-now amount (deposit); defaults to total
    googleDelay = 0,
    pickGeo = null,                  // {lat,lng}: pin Google picks inside a drop-off area
    checkoutError = null,            // {status, body}: make POST /bookings/:id/checkout refuse
    estimate = null,                 // installEstimateStub opts: switches this spec into the engine-priced world
  } = opts;

  await page.addInitScript(installStubs);
  await page.addInitScript(([km, ph]) => {
    window.__E2E_ROUTE_KM = km;
    window.__E2E_PAYHERE = ph;
  }, [routeKm, payhere]);
  await page.addInitScript((delay) => {
    window.__E2E_GOOGLE_DELAY = delay;
  }, googleDelay);
  if (pickGeo) {
    await page.addInitScript((g) => { window.__E2E_PICK_GEO = g; }, pickGeo);
  }
  // (Until 2026-08-16 this pre-seeded 'ceylonhop_consent' so the consent banner could not
  // overlay controls near the bottom of the viewport. The banner is gone, so is the seed.)

  // never hit the network for these
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.route('**/www.payhere.lk/**', (r) => r.abort());
  await page.route('**/*sandbox.payhere.lk/**', (r) => r.abort());
  // Belt and braces with the hostname gate in site-chrome.mjs's analyticsSnippet: the
  // gate already stops the loader firing off localhost, but a spec that stubs its own
  // page or hard-codes a real host would slip past it. GTM loading here is not a
  // harmless extra request — Clarity and GA4 each count a SESSION per page load, and
  // ~100 spec files' worth of loads showed up as hundreds of "live users" per CI run.
  await page.route('**/www.googletagmanager.com/**', (r) => r.abort());
  await page.route('**/*.clarity.ms/**', (r) => r.abort());
  await page.route('**/health', (r) => r.fulfill(json({ status: 'ok' })));

  // booking creation
  await page.route('**/bookings/single', (r) => {
    if (bookingStatus !== 201) return r.fulfill({ status: bookingStatus, contentType: 'application/json', body: '{"error":"boom"}' });
    const b = { id: 'e2e-booking-1', reference: 'CH-E2E01', status: 'draft', total: bookingTotal, currency: 'USD', mode: 'single', checkoutToken: 'e2e-checkout-token' };
    if (bookingAmountDueNow !== undefined) b.amountDueNow = bookingAmountDueNow;
    return r.fulfill(json(b));
  });
  await page.route('**/bookings/trip', (r) => r.fulfill(json({ id: 'e2e-trip-1', reference: 'CH-E2ET1', status: 'draft', mode: 'trip', checkoutToken: 'e2e-trip-checkout-token' })));
  await page.route('**/bookings/shared', (r) => r.fulfill(json({ id: 'e2e-shared-1', reference: 'CH-E2ES1', status: 'draft', mode: 'shared', checkoutToken: 'e2e-shared-checkout-token' })));

  // Rate-lock: the client mints a 7-day locked quote before a single-transfer booking (§5).
  await page.route('**/quote/lock', (r) => r.fulfill(json({
    quoteId: 'ql-e2e-1', reference: 'Q-E2ELK',
    rateLockedUntil: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    totalCents: 12100,
  })));

  // Engine price estimate (Phase 3, booking.js's CH_PRICING wiring). booking.html loads
  // ch-pricing.js unconditionally, so EVERY booking spec fires POST /quote/v2/estimate whether
  // it knows about engine pricing or not — CLAUDE.md rules out real external services, so this
  // MUST always be intercepted here, not left to specs to opt into individually. Default is 404
  // (QUOTE_V2_ENABLED off), the exact shape the real API answers with today and the one every
  // pre-existing booking spec was written against: ch-pricing.js's 404-latch makes that byte-
  // identical to local-pricing-only behaviour (see booking-engine-price.spec.js's flag-off spec).
  // Pass gotoBooking's `estimate` option (or call installEstimateStub again after navigating, to
  // change the response mid-test) to switch a spec into the engine-priced world.
  await installEstimateStub(page, estimate ? { ...estimate } : { status: 404 });

  // checkout params
  await page.route('**/bookings/*/checkout', (r) => {
    // The API refuses a checkout with a 409 and a reason (awaiting_price, already_paid,
    // not_chargeable). Tests pass the body they want so the page's handling of each is real.
    if (checkoutError) {
      return r.fulfill({
        status: checkoutError.status || 409,
        contentType: 'application/json',
        body: JSON.stringify(checkoutError.body || {}),
      });
    }
    if (checkout === 'payhere') {
      return r.fulfill(json({ checkoutUrl: 'https://sandbox.payhere.lk/pay/checkout', fields: { merchant_id: 'TEST', order_id: 'CH-E2E01', amount: '121.00', currency: 'USD', hash: 'X' } }));
    }
    return r.fulfill(json({ checkoutUrl: 'https://example.test/fake-gateway', fields: {} }));
  });

  await page.goto(`${path}?${query}`);
}

// Fill the lead-traveller form, the billing block and the terms tick — everything the page
// requires before it will start a payment. Billing joined this list on 2026-08-03: the
// gateway needs a real address, so an unfilled one now blocks submission exactly as an
// unfilled email does.
export async function fillContact(page) {
  await page.evaluate(() => window.goStep && window.goStep(4));
  await page.fill('#f-first', 'Roshen');
  await page.fill('#f-last', 'W');
  await page.fill('#f-email', 'roshenw@gmail.com');
  await page.selectOption('#f-country', 'United States');
  await page.fill('#f-phone', '9176005055');
  await fillBilling(page);
  await page.check('#agree');
}

// The billing block on its own, for tests that want to vary it.
export async function fillBilling(page, opts = {}) {
  const { address = '31 River Court, Apt 105', city = 'Jersey City', state = 'NJ', postcode = '07310', country = 'United States' } = opts;
  await page.fill('#f-addr', address);
  await page.fill('#f-city', city);
  await page.fill('#f-state', state);
  await page.fill('#f-postcode', postcode);
  if (country) await page.selectOption('#f-bcountry', country);
}

// Pick a place from the live autocomplete dropdown for a given input id.
// The pickup/drop-off fields live on the "Pick-up & drop-off" step (panel 2).
export async function pickPlace(page, inputId, menuId, text, index = 0) {
  await page.evaluate(() => window.goStep && window.goStep(2));
  await page.fill(inputId, text);
  await page.waitForSelector(`#${menuId} .ac-item`);
  await page.click(`#${menuId} .ac-item >> nth=${index}`);
}
