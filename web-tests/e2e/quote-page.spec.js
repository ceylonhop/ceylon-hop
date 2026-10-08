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

function opt({ service, name, totalCents, lead, legPrices = null }) {
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
    legPrices,
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

const PRICED_OPT = opt({ service: 'private', name: 'Private transfers', totalCents: 45_000, lead: true });
// No rounding row (owner, 2026-08-16): the projection spreads the rounding across the journeys,
// so what the page renders is rows that already add up to the Total.
PRICED_OPT.legPrices = {
  rows: [
    { label: 'Colombo Airport → Kandy', amountUsd: '$120' },
    { label: 'Kandy → Ella', amountUsd: '$140' },
  ],
  discount: null,
  totalUsd: '$260',
};

test('per-journey prices sit on each journey header, and stay days carry no price at all', async ({ page }) => {
  const body = { state: 'live', view: view({ options: [PRICED_OPT] }), validUntil: new Date(Date.now() + 7 * 864e5).toISOString() };
  await stubQuoteView(page, body);
  await page.goto(PAGE);

  await expect(page.locator('.hop:not(.is-stay) .hop-p')).toHaveText(['$120', '$140']);
  // DAYS has one stay row between the two journeys. It renders exactly as it did before this
  // feature existed — no price element, not even a "no charge" label (owner, 2026-08-16).
  await expect(page.locator('.hop.is-stay .hop-p')).toHaveCount(0);
  await expect(page.locator('.hop-sum .r.tot')).toContainText('$260');
  // The only summary row is the Total: nothing between the journeys and it.
  await expect(page.locator('.hop-sum .r')).toHaveCount(1);
});

test('no prices anywhere in the rail when the quote was not ticked', async ({ page }) => {
  const body = { state: 'live', view: view({ options: [PRIVATE_OPT] }), validUntil: new Date(Date.now() + 7 * 864e5).toISOString() };
  await stubQuoteView(page, body);
  await page.goto(PAGE);

  await expect(page.locator('.hop-p')).toHaveCount(0);
  await expect(page.locator('.hop-sum')).toHaveCount(0);
});

// A row beyond the driving-day count is an unattributed extra (e.g. "Sightseeing stops (up to
// 3h)") that legPricesFor pushed onto the end because no leg claimed it (customerQuoteView.ts).
// daysHtml only consumes one row per driving day, so this row has nowhere in the rail to land —
// it belongs in the summary, above the Total, or the column stops adding up and the whole point
// of the breakdown is defeated.
const OPT_WITH_EXTRA_ROW = opt({ service: 'private', name: 'Private transfers', totalCents: 46_800, lead: true });
OPT_WITH_EXTRA_ROW.legPrices = {
  rows: [
    { label: 'Colombo Airport → Kandy', amountUsd: '$120' },
    { label: 'Kandy → Ella', amountUsd: '$140' },
    { label: 'Sightseeing stops (up to 3h)', amountUsd: '$10' },
  ],
  discount: null,
  totalUsd: '$270',
};

test('an unattributed extra row reaches the summary, above the Total, instead of being dropped', async ({ page }) => {
  const body = { state: 'live', view: view({ options: [OPT_WITH_EXTRA_ROW] }), validUntil: new Date(Date.now() + 7 * 864e5).toISOString() };
  await stubQuoteView(page, body);
  await page.goto(PAGE);

  // DAYS has exactly 2 driving days — the third row is the surplus and must not vanish.
  await expect(page.locator('.hop:not(.is-stay) .hop-p')).toHaveText(['$120', '$140']);

  const rows = page.locator('.hop-sum .r');
  await expect(rows).toHaveText([
    'Sightseeing stops (up to 3h)$10', // surplus row first
    'Total$270', // then the total, last
  ]);
});

// Finding 3 (task-4 review): the rail's journey order comes from quoteDays.ts's `isStay`
// predicate; legPrices.rows order comes from the stored lineItems sliced by
// customerQuoteView.ts's own LOCAL `drives` predicate. Read side by side:
//   quoteDays.ts:          const isStay = (l) => (l.category || 'transfer') === 'stay_day';
//   customerQuoteView.ts:  const drives = (l) => (l.category || 'transfer') !== 'stay_day';
// `drives` is the exact logical negation of `isStay` — same default ('transfer'), same literal
// ('stay_day') — so the two files agree on every leg, today, by construction. This test guards
// that agreement from the rail's side: it would fail if a future edit made one file treat some
// leg as a stay while the other still counted it as driving, because the rows would then land on
// the wrong journey once more than one stay breaks up the itinerary.
const INTERLEAVED_DAYS = [
  { kind: 'journey', date: 'MON 10 AUG', title: 'Colombo Airport → Kandy', meta: '120 km · about 3 h', stops: [] },
  { kind: 'stay', date: 'TUE 11 AUG', title: 'In Kandy', meta: null, stops: [] },
  { kind: 'journey', date: 'WED 12 AUG', title: 'Kandy → Ella', meta: '140 km · about 4 h', stops: [] },
  { kind: 'stay', date: 'THU 13 AUG', title: 'In Ella', meta: null, stops: [] },
  { kind: 'journey', date: 'FRI 14 AUG', title: 'Ella → Galle', meta: '160 km · about 4 h', stops: [] },
];
const INTERLEAVED_OPT = opt({ service: 'private', name: 'Private transfers', totalCents: 62_000, lead: true });
INTERLEAVED_OPT.legPrices = {
  rows: [
    { label: 'Colombo Airport → Kandy', amountUsd: '$120' },
    { label: 'Kandy → Ella', amountUsd: '$140' },
    { label: 'Ella → Galle', amountUsd: '$360' },
  ],
  discount: null,
  totalUsd: '$620',
};

test('per-journey prices keep each named journey on its own figure across multiple interleaved stays', async ({ page }) => {
  const body = {
    state: 'live',
    view: view({ options: [INTERLEAVED_OPT], days: INTERLEAVED_DAYS }),
    validUntil: new Date(Date.now() + 7 * 864e5).toISOString(),
  };
  await stubQuoteView(page, body);
  await page.goto(PAGE);

  const journeys = page.locator('.hop:not(.is-stay)');
  await expect(journeys).toHaveCount(3);
  for (const [i, row] of INTERLEAVED_OPT.legPrices.rows.entries()) {
    await expect(journeys.nth(i).locator('.hop-title')).toHaveText(row.label);
    await expect(journeys.nth(i).locator('.hop-p')).toHaveText(row.amountUsd);
  }
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

// ── Partner experiences on the quote page (spec 2026-10-06 D12/D16/D17) ────────────────────────
// The ONE write this page makes: an "I’m interested" tap POSTs {t, experienceId, interested} to
// /quote-view/interest. It records a lead for ops and never touches the price or the quote.
const xpItem = (o) => ({
  id: '11111111-1111-4111-8111-111111111111', slug: 'placeholder-ayurvedic-massage', name: 'Ayurvedic massage',
  partnerName: 'Atherya Spa', areaLabel: 'Sigiriya', summary: 'A 90-minute Ayurvedic massage with herbal oils.',
  details: 'Some details.', priceCents: 3500, currency: 'USD', priceUnit: 'per_person', durationText: '90 min',
  openWeekdays: [0, 1, 2, 3, 4, 5, 6], startTimes: ['09:00'], photos: [], aboutKm: 4, interested: false, ...o,
});
const XP_MASSAGE = xpItem({});
const XP_COOKING = xpItem({
  id: '22222222-2222-4222-8222-222222222222', slug: 'placeholder-village-cooking-lesson', name: 'Village cooking lesson',
  partnerName: 'Suwee', summary: 'Cook a Sri Lankan village meal.', priceCents: 2500, interested: true,
});
const XP_STOPS = [{ place: 'Sigiriya', items: [XP_MASSAGE, XP_COOKING] }];
const liveBody = (extra = {}, state = 'live') => ({
  state, view: view({ options: [PRIVATE_OPT] }),
  validUntil: new Date(Date.now() + (state === 'lapsed' ? -3 : 7) * 864e5).toISOString(), ...extra,
});

// Records every POST body and answers with `status` (200 echoes the requested state).
async function stubInterest(page, status = 200) {
  const posts = [];
  await page.route('**/quote-view/interest', async (r) => {
    const req = r.request();
    const sent = JSON.parse(req.postData() || '{}');
    posts.push({ method: req.method(), body: sent });
    if (status !== 200) return r.fulfill({ status, contentType: 'application/json', body: '{"error":"boom"}' });
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ interested: sent.interested }) });
  });
  return posts;
}

test.describe('partner experiences on the quote page', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('https://ceylonhop.com/img/**', (r) => r.abort());
  });

  test('renders after "Day by day" and before the change-request note, with the owner-approved copy', async ({ page }) => {
    await stubQuoteView(page, liveBody({ experiences: XP_STOPS }));
    await page.goto(PAGE);

    const block = page.locator('#experiences-block');
    await expect(block).toBeVisible();
    // Header copy appears exactly once (owner, 2026-10-07), the heading names the place.
    await expect(block.locator('.xp-kicker')).toHaveCount(1);
    await expect(block.locator('.xp-kicker')).toHaveText('Hand-picked by the Ceylon Hop concierge');
    await expect(block.locator('h3')).toHaveText('While you’re in Sigiriya');
    await expect(block.locator('.xp-sub')).toHaveCount(1);
    await expect(block.locator('.xp-sub')).toHaveText(
      'Request any of these free. Our concierge messages you to arrange it — you only pay if you go ahead.',
    );
    // The old green box and the per-row reassurance are gone.
    await expect(block.locator('.xp-note')).toHaveCount(0);
    await expect(block.locator('.xp-after')).toHaveCount(0);
    await expect(block).not.toContainText('Nothing to pay now');
    await expect(block).not.toContainText('won’t be charged');
    await expect(block).not.toContainText('Same as booking direct');

    await expect(block.locator('.xp-list')).toHaveCount(1);
    await expect(block.locator('.xp-row')).toHaveCount(2);
    const row = block.locator('.xp-row').first();
    await expect(row.locator('.xp-name')).toHaveText('Ayurvedic massage');
    await expect(row.locator('.xp-meta')).toHaveText('Atherya Spa · 4 km · 90 min · Daily');
    await expect(row.locator('.xp-price')).toHaveText('$35 pp');
    await expect(row.locator('.xp-btn')).toHaveText('Request');
    await expect(row.locator('.xp-more')).toContainText('Details');
    // No ratings yet (Tripadvisor is a later step).
    await expect(block).not.toContainText('★ ');
    // No button promises "free" / "no charge".
    for (const t of await block.locator('.xp-btn').allTextContents()) expect(t).not.toMatch(/free|no charge/i);

    // DOM order: Day by day ticket, then the experiences, then the pp-note.
    const order = await page.evaluate(() => {
      const pos = (el) => el && Array.from(document.querySelectorAll('#app *')).indexOf(el);
      const day = Array.from(document.querySelectorAll('.t-ref')).find((e) => e.textContent === 'Day by day');
      return { day: pos(day), xp: pos(document.getElementById('experiences-block')), note: pos(document.querySelector('.pp-note')) };
    });
    expect(order.day).toBeGreaterThan(-1);
    expect(order.xp).toBeGreaterThan(order.day);
    expect(order.note).toBeGreaterThan(order.xp);
  });

  test('later stops repeat only the "While you’re in" heading', async ({ page }) => {
    const second = xpItem({ id: '33333333-3333-4333-8333-333333333333', slug: 'placeholder-tea', name: 'Tea tasting', partnerName: 'Hills' });
    await stubQuoteView(page, liveBody({ experiences: [...XP_STOPS, { place: 'Ella', items: [second] }] }));
    await page.goto(PAGE);
    const block = page.locator('#experiences-block');
    await expect(block.locator('h3')).toHaveText(['While you’re in Sigiriya', 'While you’re in Ella']);
    await expect(block.locator('.xp-kicker')).toHaveCount(1);
    await expect(block.locator('.xp-sub')).toHaveCount(1);
  });

  test('initial state comes from item.interested', async ({ page }) => {
    await stubQuoteView(page, liveBody({ experiences: XP_STOPS }));
    await page.goto(PAGE);
    const rows = page.locator('#experiences-block .xp-row');
    await expect(rows.nth(0).locator('.xp-btn')).toHaveAttribute('aria-pressed', 'false');
    await expect(rows.nth(0).locator('.xp-btn')).toHaveText('Request');
    await expect(rows.nth(1).locator('.xp-btn')).toHaveAttribute('aria-pressed', 'true');
    await expect(rows.nth(1).locator('.xp-btn')).toHaveText('✓ Requested');
    await expect(rows.nth(1)).toHaveClass(/\bon\b/);
  });

  test('a tap POSTs {t, experienceId, interested:true} and flips the row; a second tap withdraws', async ({ page }) => {
    await stubQuoteView(page, liveBody({ experiences: XP_STOPS }));
    const posts = await stubInterest(page);
    await page.goto(PAGE);

    const row = page.locator('#experiences-block .xp-row').first();
    const btn = row.locator('.xp-btn');
    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    await expect(btn).toHaveText('✓ Requested');
    await expect(row.locator('.xp-after')).toHaveCount(0);
    expect(posts).toEqual([{ method: 'POST', body: { t: 'test-token', experienceId: XP_MASSAGE.id, interested: true } }]);

    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
    await expect(btn).toHaveText('Request');
    expect(posts[1].body).toEqual({ t: 'test-token', experienceId: XP_MASSAGE.id, interested: false });
  });

  test('a selected row stays white (accent bar, not a tint)', async ({ page }) => {
    await stubQuoteView(page, liveBody({ experiences: XP_STOPS }));
    await stubInterest(page);
    await page.goto(PAGE);
    const row = page.locator('#experiences-block .xp-row').first();
    await row.locator('.xp-btn').click();
    await expect(row).toHaveClass(/\bon\b/);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(250); // let the 150ms transition settle
    const css = await row.evaluate((el) => {
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, shadow: s.boxShadow };
    });
    expect(css.bg).toBe('rgb(255, 255, 255)');
    expect(css.shadow).not.toBe('none'); // the 3px accent bar on the left
  });

  test('the price on the page never moves when a row is tapped', async ({ page }) => {
    await stubQuoteView(page, liveBody({ experiences: XP_STOPS }));
    await stubInterest(page);
    await page.goto(PAGE);
    const total = page.locator('.opts .ticket').first().locator('.tot .v');
    const before = await total.textContent();
    await page.locator('#experiences-block .xp-btn').first().click();
    await expect(page.locator('#experiences-block .xp-btn').first()).toHaveAttribute('aria-pressed', 'true');
    await expect(total).toHaveText(before);
  });

  test('a failed save reverts the row and says so; the next tap retries', async ({ page }) => {
    await stubQuoteView(page, liveBody({ experiences: XP_STOPS }));
    const posts = await stubInterest(page, 500);
    await page.goto(PAGE);

    const row = page.locator('#experiences-block .xp-row').first();
    const btn = row.locator('.xp-btn');
    await btn.click();
    await expect(row.locator('.xp-err')).toHaveText('Couldn’t save — try again');
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
    await expect(btn).toHaveText('Request');
    expect(posts).toHaveLength(1);

    // The next tap retries, and a success clears the line.
    await page.unroute('**/quote-view/interest');
    await stubInterest(page);
    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    await expect(row.locator('.xp-err')).toBeHidden();
  });

  test('a failed withdraw restores the requested state', async ({ page }) => {
    await stubQuoteView(page, liveBody({ experiences: XP_STOPS }));
    await stubInterest(page, 500);
    await page.goto(PAGE);
    const row = page.locator('#experiences-block .xp-row').nth(1);
    await row.locator('.xp-btn').click();
    await expect(row.locator('.xp-err')).toBeVisible();
    await expect(row.locator('.xp-btn')).toHaveAttribute('aria-pressed', 'true');
    await expect(row.locator('.xp-btn')).toHaveText('✓ Requested');
  });

  test('the server’s answer wins: a withdraw that comes back {interested:true} stays ticked', async ({ page }) => {
    await stubQuoteView(page, liveBody({ experiences: XP_STOPS }));
    await page.route('**/quote-view/interest', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: '{"interested":true}' }));
    await page.goto(PAGE);
    const btn = page.locator('#experiences-block .xp-row').nth(1).locator('.xp-btn');
    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
  });

  test('experiences: [] renders nothing, and so does a missing key', async ({ page }) => {
    await stubQuoteView(page, liveBody({ experiences: [] }));
    await page.goto(PAGE);
    await expect(page.locator('.pp-title')).toBeVisible();
    await expect(page.locator('#experiences-block')).toHaveCount(0);

    await page.unroute('**/quote-view*');
    await stubQuoteView(page, liveBody());
    await page.reload();
    await expect(page.locator('.pp-title')).toBeVisible();
    await expect(page.locator('#experiences-block')).toHaveCount(0);
  });

  test('a lapsed quote still shows the section and still accepts a tap', async ({ page }) => {
    await stubQuoteView(page, liveBody({ experiences: XP_STOPS }, 'lapsed'));
    const posts = await stubInterest(page);
    await page.goto(PAGE);
    await expect(page.locator('.held.warn')).toContainText('expired on');
    await expect(page.locator('#experiences-block .xp-row')).toHaveCount(2);
    const btn = page.locator('#experiences-block .xp-row').first().locator('.xp-btn');
    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    expect(posts).toHaveLength(1);
  });

  test('"Details ›" opens an inline panel', async ({ page }) => {
    await stubQuoteView(page, liveBody({ experiences: XP_STOPS }));
    await page.goto(PAGE);
    const row = page.locator('#experiences-block .xp-row').first();
    await expect(row.locator('.xp-panel')).toBeHidden();
    await row.locator('.xp-more').click();
    await expect(row.locator('.xp-panel')).toBeVisible();
    await expect(row.locator('.xp-panel')).toContainText('Some details.');
    await expect(row.locator('.xp-panel')).toContainText('Open: Daily');
    await expect(row.locator('.xp-panel')).toContainText('Times: 09:00');
    await expect(row.locator('.xp-more')).toHaveAttribute('aria-expanded', 'true');
    await row.locator('.xp-more').click();
    await expect(row.locator('.xp-panel')).toBeHidden();
  });

  test('a hostile name is rendered as text, not markup', async ({ page }) => {
    const evil = xpItem({ name: `<img src=x onerror="window.__pwned=1">'"&`, partnerName: `Bob's <b>spa</b>` });
    await stubQuoteView(page, liveBody({ experiences: [{ place: 'Sigiriya', items: [evil] }] }));
    await page.goto(PAGE);
    await expect(page.locator('#experiences-block .xp-name')).toHaveText(evil.name);
    await expect(page.locator('#experiences-block .xp-meta')).toContainText(evil.partnerName);
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  });

  test('at 375px nothing overflows sideways and names are not ellipsis-truncated', async ({ page }) => {
    const long = xpItem({ name: 'Sunrise guided hike with a traditional village breakfast and tea', partnerName: 'A very long partner name Ltd' });
    await page.setViewportSize({ width: 375, height: 800 });
    await stubQuoteView(page, liveBody({ experiences: [{ place: 'Sigiriya', items: [long, XP_COOKING] }] }));
    await page.goto(PAGE);
    await expect(page.locator('#experiences-block .xp-row')).toHaveCount(2);
    const m = await page.evaluate(() => {
      const de = document.documentElement;
      const names = Array.from(document.querySelectorAll('#experiences-block .xp-name'));
      return {
        overflowX: de.scrollWidth - de.clientWidth,
        // text-overflow stays 'ellipsis' in computed style even when it cannot fire; measure what is clipped.
        truncated: names.filter((n) => n.scrollWidth > n.clientWidth + 1 || n.scrollHeight > n.clientHeight + 1).length,
        wrapped: names.every((n) => getComputedStyle(n).whiteSpace === 'normal'),
      };
    });
    expect(m.overflowX).toBeLessThanOrEqual(0);
    expect(m.truncated).toBe(0);
    expect(m.wrapped).toBe(true);
  });

  test('a tap is reported to analytics as source quote_page', async ({ page }) => {
    await stubQuoteView(page, liveBody({ experiences: XP_STOPS }));
    await stubInterest(page);
    await page.goto(PAGE);
    await page.locator('#experiences-block .xp-btn').first().click();
    // Tracked on the server's confirmation, a beat after the optimistic flip.
    await page.waitForFunction(() => window.dataLayer.some((e) => e.event === 'experience_interest'));
    const hit = await page.evaluate(() => window.dataLayer.find((e) => e.event === 'experience_interest'));
    expect(hit).toMatchObject({ experience_slug: 'placeholder-ayurvedic-massage', place: 'Sigiriya', source: 'quote_page', interested: true });
  });
});
