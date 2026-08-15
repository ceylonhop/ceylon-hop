import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { futureIsoDate } from '../dates.js';

// ────────────────────────────────────────────────────────────────────────────
//  booking.js estimate-intent builder + engine-price adoption slot (Phase 3,
//  Task 2 — 2026-08-13).
//
//  booking.js is a classic (non-module) script that runs top-to-bottom the
//  moment it loads, wiring up the real page DOM as it goes — it has no window
//  export of its internals (state, calcTotal, tripStops…), by design: those
//  names would otherwise leak onto every other page's global scope. To reach
//  them for a real (not string-regex) behavioural test, this harness loads
//  the ACTUAL booking.html plus its real script dependencies into a jsdom
//  document as genuine <script> elements (not a single `new Function`/`eval`
//  call each — jsdom's window.eval does NOT share the top-level let/const
//  lexical scope across separate calls, only appended <script> elements do,
//  matching how real browsers execute multiple <script> tags in one
//  document). Once loaded, `w.eval('<expr>')` reaches booking.js's top-level
//  bindings exactly as devtools' console would on the real page.
// ────────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const HTML = readFileSync(path.join(ROOT, 'booking.html'), 'utf8');
const DEPS = ['site.js', 'ta-data.js', 'routes-data.js', 'transfers-data.js', 'decline-help.js', 'ch-map.js', 'ch-pricing.js']
  .map((f) => readFileSync(path.join(ROOT, f), 'utf8'));
const BOOKING_SRC = readFileSync(path.join(ROOT, 'booking.js'), 'utf8');

function loadBooking(query) {
  const url = 'https://example.test/booking.html' + (query ? '?' + query : '');
  const dom = new JSDOM(HTML, { url, runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  // jsdom has no layout engine — scrollTo (called from goStep) just logs "not implemented"
  // noise otherwise; harmless in a real browser, so a no-op stub here is faithful, not a fake.
  window.scrollTo = () => {};
  [...DEPS, BOOKING_SRC].forEach((src) => {
    const el = window.document.createElement('script');
    el.textContent = src;
    window.document.body.appendChild(el);
  });
  return window;
}

// Evaluate an expression in booking.js's top-level scope. JSON round-trips the result so
// Sets/Maps/undefined survive the eval boundary in a test-assertable shape.
function ev(w, expr) {
  return JSON.parse(w.eval(`JSON.stringify((function(){ return (${expr}); })())`) ?? 'null');
}

describe('buildEstimateIntent — single transfer', () => {
  it('builds a private intent from the place strings the booking payload sends', () => {
    const w = loadBooking('mode=private&from=cmb-airport&to=kandy&vehicle=car&price=90&rawPrice=90&ad=2&ch=1');
    // exact-spot refinement: the customer typed a specific hotel inside the "Kandy" area —
    // the intent must carry the refined string, exactly as createApiBooking's payload does.
    w.eval("state.locFrom='Kingsbury Colombo'; state.locTo='Earl Regency Kandy';");
    w.eval("state.addons.add('sightseeing')");
    w.eval("state.bags=3");
    expect(ev(w, 'buildEstimateIntent()')).toEqual({
      product: 'private',
      vehicle: 'car',
      pax: 3,
      bags: 3,
      legs: [{ from: 'Kingsbury Colombo', to: 'Earl Regency Kandy' }],
      extras: ['sightseeing'],
      date: undefined,
      time: undefined,
    });
  });

  it('falls back to the route endpoints when no exact spot was pinned', () => {
    const w = loadBooking('mode=private&from=cmb-airport&to=kandy&vehicle=van&price=120&rawPrice=120');
    const intent = ev(w, 'buildEstimateIntent()');
    expect(intent.vehicle).toBe('van');
    expect(intent.legs).toEqual([{ from: w.eval('r.stops[0]'), to: w.eval('r.stops[r.stops.length-1]') }]);
    expect(intent.extras).toEqual([]);
  });

  it('carries the chosen date and time', () => {
    const w = loadBooking('mode=private&from=cmb-airport&to=kandy&vehicle=car&price=90&rawPrice=90');
    const iso = futureIsoDate(30);
    w.eval(`state.date=new Date('${iso}T00:00:00'); state.dep='09:00';`);
    const intent = ev(w, 'buildEstimateIntent()');
    expect(intent.date).toBe(iso);
    expect(intent.time).toBe('09:00');
  });
});

describe('buildEstimateIntent — trip + private', () => {
  it('emits one leg per non-gap wire, gap wires excluded', () => {
    const w = loadBooking('mode=trip&stops=Colombo|Kandy|Ella|Galle&nights=1,1,1&dates=,,,&kms=&gaps=1&vehicle=car&price=200&ad=2');
    const intent = ev(w, 'buildEstimateIntent()');
    expect(intent.product).toBe('private');
    expect(intent.vehicle).toBe('car');
    expect(intent.pax).toBe(2);
    // wire 1 (Kandy→Ella) is the gap — mirrors tripQuoteWithKms, which skips it too.
    expect(intent.legs).toEqual([
      { from: 'Colombo', to: 'Kandy' },
      { from: 'Ella', to: 'Galle' },
    ]);
  });
});

describe('buildEstimateIntent — trip + chauffeur', () => {
  // Chauffeur legs stay 2 days apart, mirroring the api suite's own date-bomb guard
  // (a booking-route test convention: web-tests/unit/no-date-bombs.test.js forbids literals).
  const day1 = futureIsoDate(30);
  const day2 = futureIsoDate(32);

  it('builds firstDate/lastDate/travelDays from the dated wires', () => {
    const w = loadBooking(
      `mode=trip&stops=Colombo|Kandy|Ella&nights=1,2&dates=${day1},${day2}&kms=&gaps=&vehicle=car&price=200&ad=2`,
    );
    w.eval("window.pickSvc('chauffeur')");
    expect(ev(w, 'state.svc')).toBe('chauffeur');
    const intent = ev(w, 'buildEstimateIntent()');
    expect(intent.product).toBe('chauffeur');
    expect(intent.firstDate).toBe(day1);
    expect(intent.lastDate).toBe(day2);
    expect(intent.travelDays).toEqual([
      { date: day1, from: 'Colombo', to: 'Kandy' },
      { date: day2, from: 'Kandy', to: 'Ella' },
    ]);
  });

  it('excludes gap wires from travelDays', () => {
    const w = loadBooking(
      `mode=trip&stops=Colombo|Kandy|Ella&nights=1,2&dates=${day1},${day2}&kms=&gaps=0&vehicle=car&price=200&ad=2`,
    );
    w.eval("window.pickSvc('chauffeur')");
    const intent = ev(w, 'buildEstimateIntent()');
    expect(intent.travelDays).toEqual([{ date: day2, from: 'Kandy', to: 'Ella' }]);
  });
});

describe('buildEstimateIntent — shared mode', () => {
  it('returns null — shared never calls the estimate endpoint', () => {
    const w = loadBooking('mode=shared&from=cmb-airport&to=kandy&vehicle=car&price=20&rawPrice=20');
    expect(ev(w, 'isShared')).toBe(true);
    expect(w.eval('buildEstimateIntent()')).toBe(null);
  });
});

describe('adoptEngineEstimate + calcTotal', () => {
  it('calcTotal() returns the adopted engine figure once the signature matches the current intent', () => {
    const w = loadBooking('mode=private&from=cmb-airport&to=kandy&vehicle=car&price=90&rawPrice=90&ad=1');
    const localTotal = w.eval('calcTotal()');
    const sig = w.eval('currentIntentSig()');
    w.eval(`adoptEngineEstimate({ totalCents: 12345, amountDueNowCents: 12345, estimated: false, legs: [] }, ${JSON.stringify(sig)})`);
    expect(w.eval('calcTotal()')).toBe(123.45);
    expect(w.eval('calcTotal()')).not.toBe(localTotal);
  });

  it('falls back to the local formula once a pricing input moves the intent signature', () => {
    const w = loadBooking('mode=private&from=cmb-airport&to=kandy&vehicle=car&price=90&rawPrice=90&ad=1');
    const sig = w.eval('currentIntentSig()');
    w.eval(`adoptEngineEstimate({ totalCents: 12345, amountDueNowCents: 12345, estimated: false, legs: [] }, ${JSON.stringify(sig)})`);
    expect(w.eval('calcTotal()')).toBe(123.45);

    // Mutate a pricing input (pax) without a fresh adoption — the sig no longer matches,
    // so the stale engine figure must not keep showing.
    w.eval('state.ad = state.ad + 1');
    const localAfterChange = w.eval(
      '(function(){ const saved=engineEst; engineEst=null; const t=calcTotal(); engineEst=saved; return t; })()',
    );
    // With no estimate on its way, the engine is simply gone for this itinerary and the local
    // formula — the offline fallback — is the honest number.
    w.eval('estimatePending = false');
    expect(w.eval('calcTotal()')).toBe(localAfterChange);
    expect(w.eval('calcTotal()')).not.toBe(123.45);

    // But while a replacement estimate IS in flight, the last figure the customer was quoted
    // holds instead. Dropping to the local formula for that ~1.2s put a number nobody was ever
    // shown in front of them — and on a trip it visibly counted DOWN to it and back up.
    w.eval('estimatePending = true');
    expect(w.eval('calcTotal()')).toBe(123.45);
    expect(w.eval('calcTotal()')).not.toBe(localAfterChange);
    w.eval('estimatePending = false');

    // A fresh adoption against the NEW signature takes over again.
    const newSig = w.eval('currentIntentSig()');
    w.eval(`adoptEngineEstimate({ totalCents: 20000, amountDueNowCents: 20000, estimated: false, legs: [] }, ${JSON.stringify(newSig)})`);
    expect(w.eval('calcTotal()')).toBe(200);
  });

  it('serverQuote (post-booking) outranks engineEst', () => {
    const w = loadBooking('mode=private&from=cmb-airport&to=kandy&vehicle=car&price=90&rawPrice=90&ad=1');
    const sig = w.eval('currentIntentSig()');
    w.eval(`adoptEngineEstimate({ totalCents: 12345, amountDueNowCents: 12345, estimated: false, legs: [] }, ${JSON.stringify(sig)})`);
    expect(w.eval('calcTotal()')).toBe(123.45);

    w.eval('adoptServerQuote({ total: 99900, amountDueNow: 99900 })');
    expect(w.eval('calcTotal()')).toBe(999);
  });
});

// Task 5: the rate-lock request booking.js sends to POST /quote/lock (ensureLockedQuoteId's
// `lockReq`) prefers the engine's own measured distanceKm for a leg over the client-side
// TRANSFERS.kmBetween lookup table, but only while that estimate is still priced against the
// itinerary as it stands — a stale or absent estimate (flag off) must fall back exactly as
// before the engine existed, so the flag-off world stays byte-identical.
describe('lockLegKm — rate-lock leg distance, engine vs local fallback', () => {
  it('prefers the engine-measured distanceKm once engineEst is adopted for the current intent', () => {
    const w = loadBooking('mode=private&from=cmb-airport&to=kandy&vehicle=car&price=90&rawPrice=90&ad=1');
    const from = ev(w, 'state.locFrom || r.stops[0]');
    const to = ev(w, 'state.locTo || r.stops[r.stops.length-1]');
    const sig = w.eval('currentIntentSig()');
    w.eval(
      `adoptEngineEstimate({ totalCents: 12345, amountDueNowCents: 12345, estimated: false, ` +
      `legs: [{ from: ${JSON.stringify(from)}, to: ${JSON.stringify(to)}, distanceKm: 77, durationMin: 90 }] }, ${JSON.stringify(sig)})`,
    );
    expect(ev(w, `lockLegKm(${JSON.stringify(from)}, ${JSON.stringify(to)})`)).toBe(77);
  });

  it('falls back to TRANSFERS.kmBetween with no fresh engine estimate — the flag-off path', () => {
    const w = loadBooking('mode=private&from=cmb-airport&to=kandy&vehicle=car&price=90&rawPrice=90&ad=1');
    const from = ev(w, 'state.locFrom || r.stops[0]');
    const to = ev(w, 'state.locTo || r.stops[r.stops.length-1]');
    const expectedKm = ev(w, `(window.TRANSFERS && window.TRANSFERS.kmBetween) ? (window.TRANSFERS.kmBetween(${JSON.stringify(from)}, ${JSON.stringify(to)}) || 0) : 0`);
    expect(ev(w, `lockLegKm(${JSON.stringify(from)}, ${JSON.stringify(to)})`)).toBe(expectedKm);
  });

  it('falls back once the engine estimate goes stale — a pax change moves the sig past what it was adopted for', () => {
    const w = loadBooking('mode=private&from=cmb-airport&to=kandy&vehicle=car&price=90&rawPrice=90&ad=1');
    const from = ev(w, 'state.locFrom || r.stops[0]');
    const to = ev(w, 'state.locTo || r.stops[r.stops.length-1]');
    const sig = w.eval('currentIntentSig()');
    w.eval(
      `adoptEngineEstimate({ totalCents: 12345, amountDueNowCents: 12345, estimated: false, ` +
      `legs: [{ from: ${JSON.stringify(from)}, to: ${JSON.stringify(to)}, distanceKm: 77, durationMin: 90 }] }, ${JSON.stringify(sig)})`,
    );
    w.eval('state.ad = state.ad + 1');
    const expectedKm = ev(w, `(window.TRANSFERS && window.TRANSFERS.kmBetween) ? (window.TRANSFERS.kmBetween(${JSON.stringify(from)}, ${JSON.stringify(to)}) || 0) : 0`);
    expect(ev(w, `lockLegKm(${JSON.stringify(from)}, ${JSON.stringify(to)})`)).toBe(expectedKm);
  });
});

// Task 5: the idempotency-key race. A retried/duplicated POST to createApiBooking's endpoint
// must reuse the SAME key even when a re-estimate landed a different quotedTotal between
// attempts — otherwise the retry mints a fresh draft instead of returning the one already
// created. quotedTotal is advisory (the server prices engine-first, bookings.ts GL-3), so
// dropping it from the key is safe; any OTHER change to the request still produces a new key.
describe('idempotencyKeyFor — payload without quotedTotal', () => {
  it('produces the same key for the same trip even when quotedTotal differs', () => {
    const w = loadBooking('mode=private&from=cmb-airport&to=kandy&vehicle=car&price=90&rawPrice=90&ad=1');
    const payloadA = { from: 'cmb-airport', to: 'kandy', adults: 1, children: 0, quotedTotal: 9000 };
    const payloadB = { from: 'cmb-airport', to: 'kandy', adults: 1, children: 0, quotedTotal: 12345 };
    const keyA = ev(w, `idempotencyKeyFor(${JSON.stringify(payloadA)})`);
    const keyB = ev(w, `idempotencyKeyFor(${JSON.stringify(payloadB)})`);
    expect(keyA).toBe(keyB);
  });

  it('produces a different key for a different trip', () => {
    const w = loadBooking('mode=private&from=cmb-airport&to=kandy&vehicle=car&price=90&rawPrice=90&ad=1');
    const payloadA = { from: 'cmb-airport', to: 'kandy', adults: 1, children: 0, quotedTotal: 9000 };
    const payloadB = { from: 'cmb-airport', to: 'galle', adults: 1, children: 0, quotedTotal: 9000 };
    const keyA = ev(w, `idempotencyKeyFor(${JSON.stringify(payloadA)})`);
    const keyB = ev(w, `idempotencyKeyFor(${JSON.stringify(payloadB)})`);
    expect(keyA).not.toBe(keyB);
  });
});
