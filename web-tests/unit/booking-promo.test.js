import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// ────────────────────────────────────────────────────────────────────────────
//  booking.js promo code field (spec docs/superpowers/specs/
//  2026-09-24-promo-code-field-design.md).
//
//  Same harness as booking-intent.test.js: the real booking.html and its real
//  scripts in jsdom, reached through w.eval (booking.js is a classic script with
//  no exports). `promo: true` sets the test switch BEFORE booking.js runs, the
//  way the e2e spec's init script does — PROMO_FIELD_ENABLED itself stays false.
//  Live pricing is unplugged after load: every test adopts its estimate answer by
//  hand, so nothing asynchronous can land mid-test.
// ────────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const HTML = readFileSync(path.join(ROOT, 'booking.html'), 'utf8');
const DEPS = ['site.js', 'ta-data.js', 'routes-data.js', 'transfers-data.js', 'decline-help.js', 'checkout-handoff.js', 'ch-map.js', 'ch-pricing.js', 'route-estimate.js']
  .map((f) => readFileSync(path.join(ROOT, f), 'utf8'));
const BOOKING_SRC = readFileSync(path.join(ROOT, 'booking.js'), 'utf8');

const SINGLE = 'mode=private&from=cmb-airport&to=kandy&vehicle=car&price=90&rawPrice=90&ad=1';
const TRIP = 'mode=trip&stops=Colombo|Kandy|Ella&nights=1,2&dates=,,&kms=&gaps=&vehicle=car&price=200&ad=2';
const SHARED = 'mode=shared&from=cmb-airport&to=kandy&price=19&times=07:30&corridor=airport-cultural&days=3,6&pax=1';

function loadBooking(query, { promo = true } = {}) {
  const url = 'https://example.test/booking.html?' + query;
  const dom = new JSDOM(HTML, { url, runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  window.scrollTo = () => {};
  if (promo) window.CH_PROMO_FIELD = true;
  [...DEPS, BOOKING_SRC].forEach((src) => {
    const el = window.document.createElement('script');
    el.textContent = src;
    window.document.body.appendChild(el);
  });
  window.eval('window.CH_PRICING = null; estimatePending = false;');
  return window;
}

function ev(w, expr) {
  return JSON.parse(w.eval(`JSON.stringify((function(){ return (${expr}); })())`) ?? 'null');
}

// An estimate answer shaped like POST /quote/v2/estimate's (api/src/routes/quote.ts:325-349): the
// top-level total is always the FULL price; a code only adds the promoCode block beside it.
const FULL = { totalCents: 9000, amountDueNowCents: 9000, estimated: false, legs: [] };
const OK = { code: 'SAVE10', discountCents: 900, totalBeforeDiscountCents: 9000, totalCents: 8100 };

// Applies `code`, then lands `promo` as the engine's answer for the trip as it now stands.
function applyWith(w, code, promo) {
  w.eval(`promoCode = ${JSON.stringify(code)}; promoConfirmed = false;`);
  const est = promo === undefined ? FULL : { ...FULL, promoCode: promo };
  w.eval(`adoptEngineEstimate(${JSON.stringify(est)}, currentIntentSig())`);
}

describe('promo switch + estimate intent', () => {
  it('is off by default: no code ever enters the intent', () => {
    const w = loadBooking(SINGLE, { promo: false });
    w.eval("promoCode = 'SAVE10'");
    expect(ev(w, 'buildEstimateIntent()')).not.toHaveProperty('promoCode');
  });

  it('carries the applied code, and only while one is applied', () => {
    const w = loadBooking(SINGLE);
    expect(ev(w, 'buildEstimateIntent()')).not.toHaveProperty('promoCode');
    w.eval("promoCode = 'SAVE10'");
    expect(ev(w, 'buildEstimateIntent()').promoCode).toBe('SAVE10');
  });

  it('never turns on for a shared seat', () => {
    const w = loadBooking(SHARED);
    expect(ev(w, 'promoFieldOn')).toBe(false);
  });

  it('keeps the promo answer on the adopted estimate', () => {
    const w = loadBooking(SINGLE);
    applyWith(w, 'SAVE10', OK);
    expect(ev(w, 'engineEst.promo')).toEqual(OK);
  });
});

// Captures the JSON body createApiBooking() posts to `endpoint` ('/bookings/single' or '/bookings/trip').
async function bookingBody(query, endpoint, setup) {
  const w = loadBooking(query);
  setup(w);
  w.eval(`
    window.CEYLON_HOP_API = 'https://api.test';
    window.__body = null;
    window.fetch = function(url, init){
      if(String(url).indexOf(${JSON.stringify(endpoint)}) !== -1) window.__body = JSON.parse(init.body);
      return Promise.resolve({ ok: true, status: 200, json: function(){ return Promise.resolve({ quoteId: 'q1' }); } });
    };
    window.__done = createApiBooking();
  `);
  await w.__done;
  return ev(w, 'window.__body');
}

describe('payableTotal', () => {
  it('takes the discount from the estimate while calcTotal() stays the full price', () => {
    const w = loadBooking(SINGLE);
    applyWith(w, 'SAVE10', OK);
    expect(ev(w, 'calcTotal()')).toBe(90);
    expect(ev(w, 'payableTotal()')).toBe(81);
    expect(ev(w, 'amountDueNow()')).toBe(81);
  });

  it('ignores a discount priced for a different trip', () => {
    const w = loadBooking(SINGLE);
    applyWith(w, 'SAVE10', OK);
    w.eval('state.ad = 2');
    expect(ev(w, 'heldPromo()')).toBe(null);
    expect(ev(w, 'payableTotal()')).toBe(ev(w, 'calcTotal()'));
  });

  it("is the booking's own total once the booking exists", () => {
    const w = loadBooking(SINGLE);
    applyWith(w, 'SAVE10', OK);
    w.eval('adoptServerQuote({ total: 7700, amountDueNow: 7700 })');
    expect(ev(w, 'payableTotal()')).toBe(77);
  });

  it('ignores a promo block while the switch is off', () => {
    const w = loadBooking(SINGLE, { promo: false });
    applyWith(w, 'SAVE10', OK);
    expect(ev(w, 'payableTotal()')).toBe(90);
  });

  it('sends the discounted figure as quotedTotal', async () => {
    const body = await bookingBody(SINGLE, '/bookings/single', (w) => applyWith(w, 'SAVE10', OK));
    expect(body.quotedTotal).toBe(8100);
  });
});
