// Shared e2e harness: stubs Google Maps + PayHere in the page and mocks the API,
// so the booking journeys are deterministic and run fully offline.

// Runs in the PAGE before any site script. Must be self-contained (no closures).
function installStubs() {
  const latlng = (lat, lng) => ({ lat: () => lat, lng: () => lng });

  function DirectionsService() {}
  DirectionsService.prototype.route = function (req, cb) {
    const km = (typeof window.__E2E_ROUTE_KM === 'number') ? window.__E2E_ROUTE_KM : 100;
    cb({ routes: [{ legs: [{ distance: { value: km * 1000 }, duration: { value: Math.round((km / 0.7) * 60) } }] }] }, 'OK');
  };
  function DirectionsRenderer() {}
  DirectionsRenderer.prototype.setMap = function () {};
  DirectionsRenderer.prototype.setDirections = function () {};
  function MapCls() {}

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
              location: latlng(6.9 + n * 0.01, 79.9 + n * 0.01),
              displayName: `${input} Result ${n}`,
              formattedAddress: `${input} Result ${n}, Sri Lanka`,
            }),
          },
          }))), delay);
        }),
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

/**
 * Set up stubs + API mocks, then navigate to a page.
 * opts:
 *   query        - querystring for booking.html (without leading ?)
 *   path         - page path (default '/booking.html')
 *   routeKm      - distance the stubbed DirectionsService reports (default 100)
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
  } = opts;

  await page.addInitScript(installStubs);
  await page.addInitScript(([km, ph]) => {
    window.__E2E_ROUTE_KM = km;
    window.__E2E_PAYHERE = ph;
  }, [routeKm, payhere]);
  await page.addInitScript((delay) => {
    window.__E2E_GOOGLE_DELAY = delay;
  }, googleDelay);
  // Pre-seed the cookie choice so the consent banner never overlays controls near the
  // bottom of the viewport (it intercepts pointer events and flakes autocomplete clicks).
  await page.addInitScript(() => {
    try { localStorage.setItem('ceylonhop_consent', 'denied'); } catch (e) {}
  });

  // never hit the network for these
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.route('**/www.payhere.lk/**', (r) => r.abort());
  await page.route('**/*sandbox.payhere.lk/**', (r) => r.abort());
  await page.route('**/health', (r) => r.fulfill(json({ status: 'ok' })));

  // booking creation
  await page.route('**/bookings/single', (r) => {
    if (bookingStatus !== 201) return r.fulfill({ status: bookingStatus, contentType: 'application/json', body: '{"error":"boom"}' });
    const b = { id: 'e2e-booking-1', reference: 'CH-E2E01', status: 'draft', total: bookingTotal, currency: 'USD', mode: 'single' };
    if (bookingAmountDueNow !== undefined) b.amountDueNow = bookingAmountDueNow;
    return r.fulfill(json(b));
  });
  await page.route('**/bookings/trip', (r) => r.fulfill(json({ id: 'e2e-trip-1', reference: 'CH-E2ET1', status: 'draft', mode: 'trip' })));
  await page.route('**/bookings/shared', (r) => r.fulfill(json({ id: 'e2e-shared-1', reference: 'CH-E2ES1', status: 'draft', mode: 'shared' })));

  // Rate-lock: the client mints a 7-day locked quote before a single-transfer booking (§5).
  await page.route('**/quote/lock', (r) => r.fulfill(json({
    quoteId: 'ql-e2e-1', reference: 'Q-E2ELK',
    rateLockedUntil: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    totalCents: 12100,
  })));

  // checkout params
  await page.route('**/bookings/*/checkout', (r) => {
    if (checkout === 'payhere') {
      return r.fulfill(json({ checkoutUrl: 'https://sandbox.payhere.lk/pay/checkout', fields: { merchant_id: 'TEST', order_id: 'CH-E2E01', amount: '121.00', currency: 'USD', hash: 'X' } }));
    }
    return r.fulfill(json({ checkoutUrl: 'https://example.test/fake-gateway', fields: {} }));
  });

  await page.goto(`${path}?${query}`);
}

// Fill the lead-traveller form and accept terms (so payment can proceed).
export async function fillContact(page) {
  await page.evaluate(() => window.goStep && window.goStep(4));
  await page.fill('#f-first', 'Roshen');
  await page.fill('#f-last', 'W');
  await page.fill('#f-email', 'roshenw@gmail.com');
  await page.selectOption('#f-country', 'United States');
  await page.fill('#f-phone', '9176005055');
  await page.check('#agree');
}

// Pick a place from the live autocomplete dropdown for a given input id.
// The pickup/drop-off fields live on the "Pick-up & drop-off" step (panel 2).
export async function pickPlace(page, inputId, menuId, text, index = 0) {
  await page.evaluate(() => window.goStep && window.goStep(2));
  await page.fill(inputId, text);
  await page.waitForSelector(`#${menuId} .ac-item`);
  await page.click(`#${menuId} .ac-item >> nth=${index}`);
}
