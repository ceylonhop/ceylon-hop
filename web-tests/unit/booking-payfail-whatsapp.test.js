import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// ────────────────────────────────────────────────────────────────────────────
//  booking.js — the payment overlay's "Tell us what happened on WhatsApp" link.
//
//  Every incomplete PayHere payment in the last 60 days ended silently: no decline
//  webhook, no error on our page. The only source that can say what the customer
//  saw is the customer — so the failed/cancelled end states carry a one-tap
//  WhatsApp link whose prefilled message already names the booking reference.
//  The loading state never shows it, and a refusal before a booking exists shows
//  it without the "for booking …" clause.
//
//  Same jsdom harness as booking-create-error.test.js: booking.js is a classic
//  script with no window exports, so load the real page + its script deps and
//  drive runPayment() against a stubbed fetch + PayHere SDK.
// ────────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const HTML = readFileSync(path.join(ROOT, 'booking.html'), 'utf8');
const DEPS = ['site.js', 'ta-data.js', 'routes-data.js', 'transfers-data.js', 'decline-help.js', 'ch-map.js', 'ch-pricing.js']
  .map((f) => readFileSync(path.join(ROOT, f), 'utf8'));
const BOOKING_SRC = readFileSync(path.join(ROOT, 'booking.js'), 'utf8');

const QUERY = 'mode=private&from=cmb-airport&to=kandy&vehicle=car&price=90&rawPrice=90';
const WA_PREFIX = 'https://wa.me/94779669662?text=';
const FAKE_BOOKING = { id: 'b-test-1', reference: 'CH-TEST1', checkoutToken: 'x' };

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

// A backend that answers the rate-lock, the booking create, and the checkout.
// `booking` null = the create is refused with a 5xx (no reference ever exists).
function armApi(w, booking) {
  const createReply = booking ? `reply(200, ${JSON.stringify(booking)})` : 'reply(502, null)';
  w.eval(`
    window.CEYLON_HOP_API = 'https://api.test';
    window.payhere = { startPayment: function(){} };
    var reply = function(status, body){
      return Promise.resolve({ ok: status < 400, status: status, json: function(){ return Promise.resolve(body); } });
    };
    window.fetch = function(url){
      url = String(url);
      if (url.indexOf('/checkout') !== -1) return reply(200, { checkoutUrl: 'https://sandbox.payhere.lk/pay/checkout', fields: {} });
      if (url.indexOf('/bookings/') !== -1) return ${createReply};
      return reply(200, {});
    };
  `);
}

function waLink(w) {
  return w.document.querySelector('#ph-actions a[href^="https://wa.me/"]');
}
function visibleWaLink(w) {
  const a = waLink(w);
  return a && !a.hidden ? a : null;
}
function decodedText(a) {
  const href = a.getAttribute('href');
  expect(href.startsWith(WA_PREFIX)).toBe(true);
  return decodeURIComponent(href.slice(WA_PREFIX.length));
}

describe('payment overlay — "Tell us what happened on WhatsApp"', () => {
  it('shows a prefilled WhatsApp link carrying the reference when PayHere is dismissed', async () => {
    const w = loadBooking(QUERY);
    armApi(w, FAKE_BOOKING);
    await w.eval('runPayment()');
    w.eval('payhere.onDismissed()');

    const a = visibleWaLink(w);
    expect(a).not.toBeNull();
    expect(a.textContent.trim()).toBe('Tell us what happened on WhatsApp');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toContain('noopener');
    expect(decodedText(a)).toBe('Hi Ceylon Hop, my payment for booking CH-TEST1 didn\'t go through. What I saw: ');
    // "Try again" and "Close" are untouched.
    expect(w.document.getElementById('ph-retry').hidden).toBe(false);
    expect(w.document.getElementById('ph-close').hidden).toBe(false);
    expect(w.document.getElementById('ph-actions').hidden).toBe(false);
  });

  it('shows the same link when PayHere reports an error', async () => {
    const w = loadBooking(QUERY);
    armApi(w, FAKE_BOOKING);
    await w.eval('runPayment()');
    w.eval('payhere.onError()');

    const a = visibleWaLink(w);
    expect(a).not.toBeNull();
    expect(decodedText(a)).toContain('CH-TEST1');
    // the decline steps still render alongside it
    expect(w.document.getElementById('ph-help').hidden).toBe(false);
  });

  it('never shows the link in the loading state', async () => {
    const w = loadBooking(QUERY);
    armApi(w, FAKE_BOOKING);
    await w.eval('runPayment()');
    w.eval('payhere.onError()');
    expect(visibleWaLink(w)).not.toBeNull();

    // A retry starts a new attempt: the loading state must hide the link again.
    w.eval('phShowLoading("Setting up your secure payment…")');
    expect(visibleWaLink(w)).toBeNull();
  });

  it('drops the "for booking …" clause when no booking was ever created', async () => {
    const w = loadBooking(QUERY);
    armApi(w, null);
    await w.eval('runPayment()');

    const a = visibleWaLink(w);
    expect(a).not.toBeNull();
    expect(decodedText(a)).toBe('Hi Ceylon Hop, my payment didn\'t go through. What I saw: ');
  });
});
