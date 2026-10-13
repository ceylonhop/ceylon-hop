import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// ────────────────────────────────────────────────────────────────────────────
//  booking.js — the checkout call gets a deadline.
//
//  Pay runs three calls in a row: the rate lock (8 s abort), the booking create (45 s
//  abort) and POST /bookings/:id/checkout — which had none. While it runs the overlay
//  hides both "Try again" and "Close" and the Pay button stays latched, so an API that
//  accepts the connection and never answers (a saturated pool, an instance mid-restart)
//  left the customer on a spinner with no way out but a reload. pay.html has carried a
//  20 s deadline on every call since the redirect checkout; this page gets the same.
//
//  Same jsdom harness as booking-payfail-whatsapp.test.js: booking.js is a classic
//  script with no window exports, so load the real page + its script deps and drive
//  runPayment() against a stubbed fetch. jsdom has no fetch, so the stub honours the
//  abort contract itself: a request whose `signal` fires rejects, as a browser's would.
// ────────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const HTML = readFileSync(path.join(ROOT, 'booking.html'), 'utf8');
const DEPS = ['site.js', 'ta-data.js', 'routes-data.js', 'transfers-data.js', 'decline-help.js', 'checkout-handoff.js', 'ch-map.js', 'ch-pricing.js']
  .map((f) => readFileSync(path.join(ROOT, f), 'utf8'));
const BOOKING_SRC = readFileSync(path.join(ROOT, 'booking.js'), 'utf8');

const QUERY = 'mode=private&from=cmb-airport&to=kandy&vehicle=car&price=90&rawPrice=90';
const FAKE_BOOKING = { id: 'b-test-1', reference: 'CH-TEST1', checkoutToken: 'x' };
const CHECKOUT_DEADLINE_MS = 20000;

function loadBooking(query) {
  const url = 'https://example.test/booking.html' + (query ? '?' + query : '');
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

// A backend whose rate-lock and booking create answer at once, and whose checkout never
// answers — unless the request is aborted, in which case it rejects like a real fetch.
// Timers are recorded, not run, so the test fires the deadline itself instead of waiting.
function armStalledCheckout(w) {
  w.eval(`
    window.CEYLON_HOP_API = 'https://api.test';
    window.__submitted = 0;
    window.__timers = [];
    HTMLFormElement.prototype.submit = function(){ window.__submitted++; };
    navigator.sendBeacon = function(){ return true; };
    var realSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = function(fn, ms){
      var entry = { fn: fn, ms: ms, id: realSetTimeout(function(){}, 0) };
      window.__timers.push(entry);
      return entry.id;
    };
    var reply = function(status, body){
      return Promise.resolve({ ok: status < 400, status: status, json: function(){ return Promise.resolve(body); } });
    };
    window.fetch = function(url, opts){
      url = String(url);
      if (url.indexOf('/checkout') !== -1) {
        return new Promise(function(_, reject){
          var signal = opts && opts.signal;
          if (signal) signal.addEventListener('abort', function(){ reject(new Error('aborted')); });
        });
      }
      if (url.indexOf('/bookings/') !== -1) return reply(200, ${JSON.stringify(FAKE_BOOKING)});
      return reply(200, {});
    };
  `);
}

const flush = (w) => new Promise((r) => setTimeout(r, 20));

describe('payment overlay — a checkout that never answers', () => {
  it('gives up after 20 s and shows the failure state with Try again, instead of a spinner forever', async () => {
    const w = loadBooking(QUERY);
    armStalledCheckout(w);
    w.eval('runPayment()');
    await flush(w);

    // Still waiting on the checkout: overlay up, actions hidden, Pay latched.
    expect(w.document.getElementById('ph-actions').hidden).toBe(true);
    expect(w.document.getElementById('pay-btn').disabled).toBe(true);

    const deadline = w.__timers.find((t) => t.ms === CHECKOUT_DEADLINE_MS);
    expect(deadline, 'the checkout fetch arms a 20 s deadline').toBeDefined();
    deadline.fn();
    await flush(w);

    expect(w.__submitted).toBe(0);
    expect(w.document.getElementById('ph-spin').style.display).toBe('none');
    expect(w.document.getElementById('ph-msg').textContent)
      .toBe('We couldn’t start your payment just now — no charge was made. Please try again in a moment.');
    expect(w.document.getElementById('ph-actions').hidden).toBe(false);
    expect(w.document.getElementById('ph-retry').hidden).toBe(false);
    expect(w.document.getElementById('ph-close').hidden).toBe(false);
    expect(w.document.getElementById('pay-btn').disabled).toBe(false);
  });
});
