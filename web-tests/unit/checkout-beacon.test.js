import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// ────────────────────────────────────────────────────────────────────────────
//  booking.js — the hand-off to PayHere is beaconed to the API (2026-09-24).
//
//  Audit: every incomplete PayHere payment in 60 days ended silently. When a customer
//  (CH-8UVYG) reached the gateway twice and pressed "Try again" twice, nobody could say what he
//  saw. #770 made the page send what happened to POST /bookings/:id/checkout-events, carrying the
//  checkout token in the body because a sendBeacon cannot set an Authorization header.
//
//  Since the website left PayHere's iframe SDK for a top-level redirect (same day,
//  booking-page-redirect.test.js), the page can report only one thing: `opened`, sent the instant
//  before the browser leaves for PayHere (a sendBeacon survives the navigation). There are no SDK
//  dismissed/error callbacks any more; the outcome is logged server side when the customer comes
//  back through GET /bookings/pay-return.
//
//  Same jsdom harness as booking-create-error.test.js: load the real page + its script deps and
//  reach the top-level bindings through window.eval. The form's submit() is a stub.
// ────────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const HTML = readFileSync(path.join(ROOT, 'booking.html'), 'utf8');
const DEPS = ['site.js', 'ta-data.js', 'routes-data.js', 'transfers-data.js', 'decline-help.js', 'checkout-handoff.js', 'ch-map.js', 'ch-pricing.js']
  .map((f) => readFileSync(path.join(ROOT, f), 'utf8'));
const BOOKING_SRC = readFileSync(path.join(ROOT, 'booking.js'), 'utf8');

function loadBooking() {
  const url = 'https://example.test/booking.html?mode=private&from=cmb-airport&to=kandy&vehicle=car&price=90&rawPrice=90';
  const dom = new JSDOM(HTML, { url, runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  window.scrollTo = () => {};
  [...DEPS, BOOKING_SRC].forEach((src) => {
    const el = window.document.createElement('script');
    el.textContent = src;
    window.document.body.appendChild(el);
  });
  return window;
}

const BOOKING = { id: 'b-123', reference: 'CH-8UVYG', checkoutToken: 'tok.abc' };
const CHECKOUT = { checkoutUrl: 'https://sandbox.payhere.lk/pay/checkout', fields: { order_id: 'CH-8UVYG', hash: 'H' }, attempt: 2 };

// Stub the form submit and the beacon; both record into one ordered log.
function arm(w, { beaconThrows = false } = {}) {
  w.eval(`
    window.CEYLON_HOP_API = 'https://api.test/';
    window.__log = [];
    window.__beacons = [];
    window.__fetches = [];
    HTMLFormElement.prototype.submit = function(){ window.__log.push('submit'); };
    navigator.sendBeacon = function(url, data){
      if (${beaconThrows}) throw new Error('beacon exploded');
      window.__log.push('beacon');
      window.__beacons.push({ url: String(url), data: data });
      return true;
    };
    window.fetch = function(url, opts){ window.__fetches.push({ url: String(url), opts: opts }); return Promise.resolve({ ok: true }); };
    window.chTrack = function(){};
  `);
}

// jsdom's Blob has no .text(); read it the way a 2015 browser would.
function blobText(w, blob) {
  return new Promise((resolve, reject) => {
    const r = new w.FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsText(blob);
  });
}

async function decoded(w, i) {
  const b = w.__beacons[i];
  return { url: b.url, type: b.data.type, body: JSON.parse(await blobText(w, b.data)) };
}

const handOff = (w) => w.eval(`redirectToPayHere(${JSON.stringify(CHECKOUT)}, ${JSON.stringify(BOOKING)})`);

describe('redirectToPayHere beacons the hand-off', () => {
  it('reports ONE `opened`, with the token and attempt, before the browser leaves', async () => {
    const w = loadBooking();
    arm(w);
    handOff(w);
    expect(w.__log).toEqual(['beacon', 'submit']);
    expect(w.__beacons).toHaveLength(1);
    const b = await decoded(w, 0);
    expect(b.url).toBe('https://api.test/bookings/b-123/checkout-events');
    expect(b.type).toBe('application/json');
    expect(b.body).toEqual({ outcome: 'opened', token: 'tok.abc', attempt: 2 });
  });

  it('no longer claims a dismissed or error outcome — there is no SDK to report one', () => {
    const src = BOOKING_SRC.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(src).not.toMatch(/sendCheckoutEvent\([^)]*'(dismissed|error)'/);
    expect(src.match(/sendCheckoutEvent\(checkout, booking, 'opened'\)/g) || []).toHaveLength(1);
  });

  it('caps a reason at 200 characters and copes with an Error object', async () => {
    const w = loadBooking();
    arm(w);
    w.eval(`sendCheckoutEvent(${JSON.stringify(CHECKOUT)}, ${JSON.stringify(BOOKING)}, 'opened', new Error('x'.repeat(500)))`);
    expect((await decoded(w, 0)).body.reason).toHaveLength(200);
  });

  it('falls back to a keepalive fetch when sendBeacon is missing', () => {
    const w = loadBooking();
    arm(w);
    w.eval('delete navigator.sendBeacon; navigator.sendBeacon = undefined;');
    handOff(w);
    expect(w.__beacons).toHaveLength(0);
    expect(w.__fetches).toHaveLength(1);
    expect(w.__fetches[0].url).toBe('https://api.test/bookings/b-123/checkout-events');
    expect(w.__fetches[0].opts).toMatchObject({ method: 'POST', keepalive: true });
    expect(JSON.parse(w.__fetches[0].opts.body)).toMatchObject({ outcome: 'opened', token: 'tok.abc' });
    expect(w.__log).toEqual(['submit']);
  });

  it('never lets the beacon touch the payment flow', () => {
    const w = loadBooking();
    arm(w, { beaconThrows: true });
    expect(() => handOff(w)).not.toThrow();
    expect(w.__log).toEqual(['submit']);
  });
});
