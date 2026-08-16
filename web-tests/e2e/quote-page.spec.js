import { test, expect } from '@playwright/test';
import { installStubs } from './_stubs.js';

// The customer quote page (quote.html, backed by GET /quote-view) — spec 2026-08-05 D6: a
// READ-ONLY proposal, not a payment page. There is no pay button and no link to /p anywhere on
// it, which is the property that makes a forwarded copy of the link harmless — every action a
// customer can take is a wa.me deep link back to ops.
//
// Same offline pattern as manage-page.spec.js (its nearest sibling: also a customer page reached
// by a bare `?t=` token, also fetching its own state after first paint). quote.html defaults
// window.CEYLON_HOP_API to the PRODUCTION api host unless the API itself serves the page
// (customerPages.ts's forApiHost injection, which the static e2e server does not run) — so
// **/quote-view* is stubbed by URL glob regardless of host, exactly like manage-page.spec.js
// stubs **/bookings/view*, and the page never has to reach a real backend, real Postgres or a
// minted view token to be exercised here. The mint endpoint (/admin/quote/:id/quote-link) and
// the token itself are already covered by unit tests (internalQuote.test.ts,
// bookingToken.test.ts) — this file is about what renders once a customer opens the link.

test.use({ viewport: { width: 375, height: 812 } });

const PAGE = '/quote.html?t=test-token';
const REF = 'Q-E2E77';

function opt({ service, name, totalCents, lead }) {
  const dollars = `$${(totalCents / 100).toFixed(totalCents % 100 ? 2 : 0)}`;
  return {
    service,
    name,
    blurb: `${name} — the e2e blurb.`,
    included: { lead: 'Everything the trip needs, plus:', items: ['A car', 'A driver', 'Fuel and tolls'] },
    includedText: 'Everything the trip needs, included.',
    totalCents,
    totalUsd: dollars,
    deltaUsd: null,
    deltaText: null,
    cancellation: { headline: 'Free cancellation until 24 hours before departure.', ladder: ['Full refund more than 24h out.'] },
    lead,
    waText: `Hi! I'd like to book the ${name} option for quote ${REF}`,
  };
}

const PRIVATE_OPT = opt({ service: 'private', name: 'Private transfers', totalCents: 45_000, lead: true });
const CHAUFFEUR_OPT = opt({ service: 'chauffeur', name: 'Chauffeur-guide', totalCents: 61_000, lead: false });

const DAYS = [
  { kind: 'journey', date: 'MON 10 AUG', title: 'Colombo Airport → Kandy', meta: '120 km · about 3 h', stops: [] },
  { kind: 'stay', date: 'TUE 11 AUG', title: 'In Kandy', meta: null, stops: [] },
  { kind: 'journey', date: 'WED 12 AUG', title: 'Kandy → Ella', meta: '140 km · about 4 h', stops: [] },
];

function view({ options, days = DAYS, reference = REF }) {
  return {
    reference,
    greetingName: 'Anna',
    title: 'Colombo Airport → Ella',
    subtitle: `${days.length}-day private trip · 2 travellers`,
    heroTotalUsd: options[0].totalUsd,
    heroTotalNote: `${options[0].name.toLowerCase()}`,
    days,
    mapStops: [], // empty on purpose — keeps the map card (and its Google Maps script load) out of scope
    totalKm: 260,
    travelDays: days.filter((d) => d.kind === 'journey').length,
    options,
    waText: `Hi! I have a question about quote ${reference}`,
  };
}

// Stub GET /quote-view* with a fixed CustomerQuoteView response, and keep the run offline: the
// GTM tag and the error beacon both point at real hosts by default (quote.html's own comments
// call this out — the same trap board.html/booking.html are known for), and maps.googleapis.com
// would otherwise be hit by ch-map.js if a map card ever did render.
async function stubQuoteView(page, body) {
  await page.route('**/quote-view*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }));
  await page.route('**/errors/client', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('https://www.googletagmanager.com/**', (r) => r.fulfill({ status: 200, body: '' }));
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
}

// The prefilled WhatsApp text an <a class="pp-cta"> carries, decoded.
async function waText(locator) {
  const href = await locator.getAttribute('href');
  expect(href, 'CTA must be a wa.me link').toMatch(/^https:\/\/wa\.me\/94779669662\?text=/);
  return decodeURIComponent(href.split('text=')[1]);
}

test('a live quote link renders the trip, a priced option and a WhatsApp CTA', async ({ page }) => {
  const body = { state: 'live', view: view({ options: [PRIVATE_OPT] }), validUntil: new Date(Date.now() + 7 * 864e5).toISOString() };
  await stubQuoteView(page, body);
  await page.goto(PAGE);

  await expect(page.locator('.pp-title')).toHaveText(body.view.title);
  await expect(page.locator('.hop')).not.toHaveCount(0);

  const card = page.locator('.opts .ticket').first();
  await expect(card.locator('.tot .v')).toHaveText(/^\$\d/);

  const cta = card.locator('a.pp-cta');
  const text = await waText(cta);
  expect(text, 'CTA text must carry the quote reference').toContain(REF);
  expect(text, "the option card's CTA must carry that option's name").toContain(PRIVATE_OPT.name);
});

// What the money buys, one line per inclusion (owner, 2026-08-16) — the customer's question at
// this box is "what am I being charged for", and a `·`-joined sentence answered it as a paragraph.
test('the included box lists each inclusion as its own line, lead-in above them', async ({ page }) => {
  const body = { state: 'live', view: view({ options: [PRIVATE_OPT] }), validUntil: new Date(Date.now() + 7 * 864e5).toISOString() };
  await stubQuoteView(page, body);
  await page.goto(PAGE);

  const box = page.locator('.opts .ticket').first().locator('.included');
  await expect(box.locator('.inc-list li')).toHaveText(PRIVATE_OPT.included.items);
  // The lead-in describes the list; bulleting it would claim it as an inclusion of its own.
  await expect(box.locator('.inc-lead')).toHaveText(PRIVATE_OPT.included.lead);
});

test('an option served without bullets still shows its inclusions as a sentence', async ({ page }) => {
  const legacy = { ...PRIVATE_OPT, included: undefined };
  const body = { state: 'live', view: view({ options: [legacy] }), validUntil: new Date(Date.now() + 7 * 864e5).toISOString() };
  await stubQuoteView(page, body);
  await page.goto(PAGE);

  const box = page.locator('.opts .ticket').first().locator('.included');
  await expect(box).toContainText(PRIVATE_OPT.includedText);
  await expect(box.locator('.inc-list')).toHaveCount(0);
});

test('every option-card CTA is a wa.me link naming its own option', async ({ page }) => {
  const body = { state: 'live', view: view({ options: [PRIVATE_OPT, CHAUFFEUR_OPT] }), validUntil: new Date(Date.now() + 7 * 864e5).toISOString() };
  await stubQuoteView(page, body);
  await page.goto(PAGE);

  const cards = page.locator('.opts .ticket');
  await expect(cards).toHaveCount(2);
  for (const [i, o] of [PRIVATE_OPT, CHAUFFEUR_OPT].entries()) {
    const text = await waText(cards.nth(i).locator('a.pp-cta'));
    expect(text).toContain(REF);
    expect(text).toContain(o.name);
  }
});

test('option cards stack, full width, at a 375px viewport', async ({ page }) => {
  const body = { state: 'live', view: view({ options: [PRIVATE_OPT, CHAUFFEUR_OPT] }), validUntil: new Date(Date.now() + 7 * 864e5).toISOString() };
  await stubQuoteView(page, body);
  await page.goto(PAGE);

  const cards = page.locator('.opts .ticket');
  await expect(cards).toHaveCount(2);
  const a = await cards.nth(0).boundingBox();
  const b = await cards.nth(1).boundingBox();
  expect(b.y, 'second card must sit below the first, not beside it').toBeGreaterThan(a.y + a.height - 5);
  expect(Math.abs(a.width - b.width), 'stacked cards must share a width').toBeLessThan(2);
});

test('no pay button and no /p link exists anywhere on the page', async ({ page }) => {
  const body = { state: 'live', view: view({ options: [PRIVATE_OPT, CHAUFFEUR_OPT] }), validUntil: new Date(Date.now() + 7 * 864e5).toISOString() };
  await stubQuoteView(page, body);
  await page.goto(PAGE);

  await expect(page.locator('.opts .ticket')).toHaveCount(2); // page has actually rendered
  await expect(page.getByRole('button', { name: /pay/i })).toHaveCount(0);
  await expect(page.locator('#paybtn')).toHaveCount(0);
  await expect(page.locator('a[href*="/p?t="]')).toHaveCount(0);
  await expect(page.locator('a[href*="/p.html"]')).toHaveCount(0);
});

// The customer must see the road the quote was PRICED on. Ops can pin a leg to the toll-free
// road; before this the view never carried that choice and ch-map always asked Google for its
// default, so a Local-road quote showed the customer an expressway line (2026-08-08).
test('the map draws the toll-free road when the quote was quoted on it', async ({ page }) => {
  await page.addInitScript(installStubs); // real ch-map path, offline — loadJs() short-circuits
  const v = view({ options: [PRIVATE_OPT] });
  v.mapStops = ['Ella', 'Colombo City'];
  v.mapRuns = [{ stops: ['Ella', 'Colombo City'], avoidTolls: true, continues: false }];
  await stubQuoteView(page, { state: 'live', view: v, validUntil: new Date(Date.now() + 7 * 864e5).toISOString() });
  await page.goto(PAGE);

  // The map is IntersectionObserver-deferred, so it only mounts once scrolled to.
  await page.locator('#map').scrollIntoViewIfNeeded();
  await expect(page.locator('#map .ch-map-wrap.ready')).toBeVisible({ timeout: 10000 });

  const reqs = await page.evaluate(() => window.__computeRoutesReqs || []);
  expect(reqs).toHaveLength(1); // one run → one query, the same billing as before
  expect(reqs[0].routeModifiers).toEqual({ avoidTolls: true });

  // Expanding must not quietly switch roads — the modal draws what the card drew.
  await page.locator('#map .ch-map-expand').click();
  await expect(page.locator('.ch-map-modal-map .ch-map-wrap')).toBeVisible();
  const after = await page.evaluate(() => window.__computeRoutesReqs || []);
  expect(after.every((r) => r.routeModifiers && r.routeModifiers.avoidTolls === true)).toBe(true);
});

test('a default-road quote asks for no modifiers — one query, unchanged', async ({ page }) => {
  await page.addInitScript(installStubs);
  const v = view({ options: [PRIVATE_OPT] });
  v.mapStops = ['Ella', 'Colombo City'];
  v.mapRuns = [{ stops: ['Ella', 'Colombo City'], avoidTolls: false, continues: false }];
  await stubQuoteView(page, { state: 'live', view: v, validUntil: new Date(Date.now() + 7 * 864e5).toISOString() });
  await page.goto(PAGE);

  await page.locator('#map').scrollIntoViewIfNeeded();
  await expect(page.locator('#map .ch-map-wrap.ready')).toBeVisible({ timeout: 10000 });
  const reqs = await page.evaluate(() => window.__computeRoutesReqs || []);
  expect(reqs).toHaveLength(1);
  expect(reqs[0].routeModifiers).toBeUndefined();
});

// A journey whose legs disagree on the road takes one query per run, and the two runs SHARE
// the stop where they meet. Pinning it twice is the trap: mapPins merges pins within ~50 m and
// the label reads "2·3" where the journey plainly has a stop 2.
test('a split journey pins its join stop once, not twice', async ({ page }) => {
  // Local stub, not the shared one: this needs a distinct route per request so the pins land in
  // distinct places (the shared stub answers every request with the same two coordinates).
  await page.addInitScript(() => {
    const AT = {
      'Ella, Sri Lanka': { lat: 6.87, lng: 81.05 },
      'Kandy, Sri Lanka': { lat: 7.29, lng: 80.63 },
      'Colombo City, Sri Lanka': { lat: 6.93, lng: 79.85 },
    };
    function MapCls() {}
    MapCls.prototype.fitBounds = function () {};
    MapCls.prototype.getZoom = function () { return 10; };
    MapCls.prototype.addListener = function () { return { remove() {} }; };
    function Marker(opts) { (window.__chMarkers = window.__chMarkers || []).push(opts || {}); }
    Marker.prototype.setMap = function () {};
    function Point() {}
    function Polyline() {}
    Polyline.prototype.setOptions = function () {};
    Polyline.prototype.setMap = function () {};
    const Route = {
      computeRoutes: async (req) => ({
        routes: [{
          path: [],
          viewport: {},
          legs: [{ startLocation: AT[req.origin], endLocation: AT[req.destination] }],
          createPolylines: () => [new Polyline()],
        }],
      }),
    };
    const libs = { maps: { Map: MapCls, Polyline }, routes: { Route }, marker: { Marker }, core: { Point } };
    window.google = { maps: { importLibrary: async (n) => libs[n] || {}, event: { trigger() {} } } };
  });

  const v = view({ options: [PRIVATE_OPT] });
  v.mapStops = ['Ella', 'Kandy', 'Colombo City'];
  v.mapRuns = [
    { stops: ['Ella', 'Kandy'], avoidTolls: true, continues: false },
    { stops: ['Kandy', 'Colombo City'], avoidTolls: false, continues: true },
  ];
  await stubQuoteView(page, { state: 'live', view: v, validUntil: new Date(Date.now() + 7 * 864e5).toISOString() });
  await page.goto(PAGE);

  await page.locator('#map').scrollIntoViewIfNeeded();
  await expect(page.locator('#map .ch-map-wrap.ready')).toBeVisible({ timeout: 10000 });

  const labels = await page.evaluate(() =>
    (window.__chMarkers || []).map((m) => m.label && m.label.text));
  expect(labels).toEqual(['1', '2', '3']); // Kandy is stop 2 — once — not a merged "2·3"
});

test('a lapsed quote shows the expiry row and still renders the itinerary', async ({ page }) => {
  const body = { state: 'lapsed', view: view({ options: [PRIVATE_OPT] }), validUntil: new Date(Date.now() - 3 * 864e5).toISOString() };
  await stubQuoteView(page, body);
  await page.goto(PAGE);

  await expect(page.locator('.pp-title')).toHaveText(body.view.title); // the trip itself is untouched
  await expect(page.locator('.hop')).toHaveCount(DAYS.length); // full itinerary still renders
  await expect(page.locator('.held.warn')).toContainText('expired on');
  await expect(page.locator('.lapse')).toContainText('Everything below is still exactly the trip we planned');
  // Never reads as "your trip is gone" — the sailed-off dead-end art must not appear here.
  await expect(page.locator('.de-wrap')).toHaveCount(0);
});
