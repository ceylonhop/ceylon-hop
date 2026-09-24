import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// ────────────────────────────────────────────────────────────────────────────
//  booking.js — the PayHere SDK's outcome is beaconed to the API (2026-09-24).
//
//  Audit: every incomplete PayHere payment in 60 days ended silently. The SDK's onError message
//  was discarded (`payhere.onError = function(){ showPayFailed(); }`), so when a customer
//  (CH-8UVYG) reached the gateway twice and pressed "Try again" twice, nobody could say what he
//  saw. startPayHere now sends `opened` / `dismissed` / `error` (with the SDK's reason) to
//  POST /bookings/:id/checkout-events, carrying the checkout token in the body because a
//  sendBeacon cannot set an Authorization header.
//
//  Same jsdom harness as booking-create-error.test.js: load the real page + its script deps and
//  reach the top-level bindings through window.eval. The SDK itself is a stub.
// ────────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const HTML = readFileSync(path.join(ROOT, 'booking.html'), 'utf8');
const DEPS = ['site.js', 'ta-data.js', 'routes-data.js', 'transfers-data.js', 'decline-help.js', 'ch-map.js', 'ch-pricing.js']
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
const CHECKOUT = { checkoutUrl: 'https://sandbox.payhere.lk/pay/checkout', fields: { order_id: 'CH-8UVYG' }, attempt: 2 };

// Install the SDK stub and the beacon spy; returns the recorded beacons.
function arm(w, { beaconThrows = false } = {}) {
  w.eval(`
    window.CEYLON_HOP_API = 'https://api.test/';
    window.__beacons = [];
    window.__started = 0;
    window.__fetches = [];
    window.payhere = { startPayment: function(){ window.__started++; } };
    navigator.sendBeacon = function(url, data){
      if (${beaconThrows}) throw new Error('beacon exploded');
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

describe('startPayHere beacons the gateway outcome', () => {
  it('reports `opened` right before the SDK is handed the payment, with the token and attempt', async () => {
    const w = loadBooking();
    arm(w);
    w.eval(`startPayHere(${JSON.stringify(CHECKOUT)}, ${JSON.stringify(BOOKING)})`);
    expect(w.__started).toBe(1);
    expect(w.__beacons).toHaveLength(1);
    const b = await decoded(w, 0);
    expect(b.url).toBe('https://api.test/bookings/b-123/checkout-events');
    expect(b.type).toBe('application/json');
    expect(b.body).toEqual({ outcome: 'opened', token: 'tok.abc', attempt: 2 });
  });

  it('reports `dismissed` when the customer closes the gateway, then shows the dismissed screen', async () => {
    const w = loadBooking();
    arm(w);
    w.eval(`startPayHere(${JSON.stringify(CHECKOUT)}, ${JSON.stringify(BOOKING)})`);
    w.eval('payhere.onDismissed()');
    expect(w.__beacons).toHaveLength(2);
    expect((await decoded(w, 1)).body).toMatchObject({ outcome: 'dismissed', token: 'tok.abc' });
    expect(w.document.getElementById('ph-msg').textContent).toMatch(/cancelled/i);
  });

  it('reports `error` with the SDK’s reason (PH-0014 …) instead of discarding it', async () => {
    const w = loadBooking();
    arm(w);
    w.eval(`startPayHere(${JSON.stringify(CHECKOUT)}, ${JSON.stringify(BOOKING)})`);
    w.eval("payhere.onError('PH-0014 Unauthorized payment request. Hash mismatch.')");
    expect(w.__beacons).toHaveLength(2);
    expect((await decoded(w, 1)).body).toMatchObject({
      outcome: 'error',
      reason: 'PH-0014 Unauthorized payment request. Hash mismatch.',
      token: 'tok.abc',
    });
    expect(w.document.getElementById('ph-msg').textContent).toMatch(/didn’t go through/);
  });

  it('caps the reason at 200 characters and copes with an Error object', async () => {
    const w = loadBooking();
    arm(w);
    w.eval(`startPayHere(${JSON.stringify(CHECKOUT)}, ${JSON.stringify(BOOKING)})`);
    w.eval("payhere.onError(new Error('x'.repeat(500)))");
    expect((await decoded(w, 1)).body.reason).toHaveLength(200);
  });

  it('falls back to a keepalive fetch when sendBeacon is missing', () => {
    const w = loadBooking();
    arm(w);
    w.eval('delete navigator.sendBeacon; navigator.sendBeacon = undefined;');
    w.eval(`startPayHere(${JSON.stringify(CHECKOUT)}, ${JSON.stringify(BOOKING)})`);
    expect(w.__beacons).toHaveLength(0);
    expect(w.__fetches).toHaveLength(1);
    expect(w.__fetches[0].url).toBe('https://api.test/bookings/b-123/checkout-events');
    expect(w.__fetches[0].opts).toMatchObject({ method: 'POST', keepalive: true });
    expect(JSON.parse(w.__fetches[0].opts.body)).toMatchObject({ outcome: 'opened', token: 'tok.abc' });
  });

  it('never lets the beacon touch the payment flow', () => {
    const w = loadBooking();
    arm(w, { beaconThrows: true });
    expect(() => w.eval(`startPayHere(${JSON.stringify(CHECKOUT)}, ${JSON.stringify(BOOKING)})`)).not.toThrow();
    expect(w.__started).toBe(1);
    expect(() => w.eval("payhere.onError('boom')")).not.toThrow();
    expect(w.document.getElementById('ph-msg').textContent).toMatch(/didn’t go through/);
  });
});
