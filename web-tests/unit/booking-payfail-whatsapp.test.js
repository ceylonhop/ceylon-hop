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
//  Since 2026-09-24 the card form lives on PayHere's own page (top-level redirect,
//  booking-page-redirect.test.js): a decline or a "Back to Site" is answered on the
//  booking's manage page, which carries the same link (manage-redirect.spec.js). On
//  THIS page the overlay's end states are the ones before the gateway — a refused
//  checkout, a failed booking create — and a page restored from the back/forward
//  cache after Back from PayHere.
//
//  Same jsdom harness as booking-create-error.test.js: booking.js is a classic
//  script with no window exports, so load the real page + its script deps and
//  drive runPayment() against a stubbed fetch (the gateway form's submit() stubbed).
// ────────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const HTML = readFileSync(path.join(ROOT, 'booking.html'), 'utf8');
const DEPS = ['site.js', 'ta-data.js', 'routes-data.js', 'transfers-data.js', 'decline-help.js', 'checkout-handoff.js', 'ch-map.js', 'ch-pricing.js']
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
// `checkout` = [status, body] for POST /bookings/:id/checkout.
function armApi(w, booking, checkout = [502, null]) {
  const createReply = booking ? `reply(200, ${JSON.stringify(booking)})` : 'reply(502, null)';
  w.eval(`
    window.CEYLON_HOP_API = 'https://api.test';
    window.__submitted = 0;
    HTMLFormElement.prototype.submit = function(){ window.__submitted++; };
    navigator.sendBeacon = function(){ return true; };
    var reply = function(status, body){
      return Promise.resolve({ ok: status < 400, status: status, json: function(){ return Promise.resolve(body); } });
    };
    window.fetch = function(url){
      url = String(url);
      if (url.indexOf('/checkout') !== -1) return reply(${checkout[0]}, ${JSON.stringify(checkout[1])});
      if (url.indexOf('/bookings/') !== -1) return ${createReply};
      return reply(200, {});
    };
  `);
}

const PAYHERE = [200, { checkoutUrl: 'https://sandbox.payhere.lk/pay/checkout', fields: { order_id: 'CH-TEST1', hash: 'H' } }];
const flush = (w) => new Promise((r) => w.setTimeout(r, 20));

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
  it('shows a prefilled WhatsApp link carrying the reference when the checkout is refused', async () => {
    const w = loadBooking(QUERY);
    armApi(w, FAKE_BOOKING);
    await w.eval('runPayment()');
    await flush(w);

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

  it('shows the same link on a refusal that explains itself (no retry offered)', async () => {
    const w = loadBooking(QUERY);
    armApi(w, FAKE_BOOKING, [409, { error: 'not_chargeable' }]);
    await w.eval('runPayment()');
    await flush(w);

    const a = visibleWaLink(w);
    expect(a).not.toBeNull();
    expect(decodedText(a)).toContain('CH-TEST1');
    expect(w.document.getElementById('ph-retry').hidden).toBe(true);
  });

  it('never shows the link in the loading state', async () => {
    const w = loadBooking(QUERY);
    armApi(w, FAKE_BOOKING);
    await w.eval('runPayment()');
    await flush(w);
    expect(visibleWaLink(w)).not.toBeNull();

    // A retry starts a new attempt: the loading state must hide the link again.
    w.eval('phShowLoading("Setting up your secure payment…")');
    expect(visibleWaLink(w)).toBeNull();
  });

  it('never shows it on the hand-off to PayHere — nothing has gone wrong yet', async () => {
    const w = loadBooking(QUERY);
    armApi(w, FAKE_BOOKING, PAYHERE);
    await w.eval('runPayment()');
    await flush(w);
    expect(w.__submitted).toBe(1);
    expect(visibleWaLink(w)).toBeNull();
  });

  it('shows it, with the reference, when Back from PayHere restores the page', async () => {
    const w = loadBooking(QUERY);
    armApi(w, FAKE_BOOKING, PAYHERE);
    await w.eval('runPayment()');
    await flush(w);
    w.dispatchEvent(new w.PageTransitionEvent('pageshow', { persisted: true }));

    const a = visibleWaLink(w);
    expect(a).not.toBeNull();
    expect(decodedText(a)).toContain('CH-TEST1');
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
