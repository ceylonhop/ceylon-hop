import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// ────────────────────────────────────────────────────────────────────────────
//  booking.js — what the payment overlay says when POST /bookings/* is refused.
//
//  createApiBooking used to throw 'booking_failed_<status>' and drop the response
//  body, so every 400 surfaced as "please try again in a moment" — advice that
//  cannot work for a refusal the customer has to fix (a past date, a shared route
//  that doesn't run that day). The API writes customer-ready copy for exactly
//  these, so show it and keep the generic line for 5xx / network failures.
//
//  Same jsdom harness as booking-intent.test.js: booking.js is a classic script
//  with no window exports, so load the real page + its script deps and reach the
//  top-level bindings through window.eval.
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
  window.scrollTo = () => {};
  [...DEPS, BOOKING_SRC].forEach((src) => {
    const el = window.document.createElement('script');
    el.textContent = src;
    window.document.body.appendChild(el);
  });
  return window;
}

const GENERIC = 'We couldn’t start your booking just now — please try again in a moment.';

function failureFor(w, err) {
  return JSON.parse(w.eval(`JSON.stringify(bookingCreateFailure(${JSON.stringify(err)}))`));
}

describe('bookingCreateFailure — the words shown when the booking is refused', () => {
  it('shows the API’s own message for a refusal it wrote copy for', () => {
    const w = loadBooking('mode=private&from=cmb-airport&to=kandy&vehicle=car&price=90&rawPrice=90');
    expect(failureFor(w, {
      status: 400,
      body: { error: 'date_in_past', message: 'Trip dates cannot be in the past.' },
    })).toEqual(['error', 'Trip dates cannot be in the past.']);

    expect(failureFor(w, {
      status: 400,
      body: {
        error: 'not_a_service_day',
        message: 'This shared route only departs on Mondays. Pick one of those days, or book it as a private transfer.',
      },
    })[1]).toContain('only departs on Mondays');
  });

  it('falls back to the generic line when the server did not explain itself', () => {
    const w = loadBooking('mode=private&from=cmb-airport&to=kandy&vehicle=car&price=90&rawPrice=90');
    // 400s whose body is for us, not the customer — invalid_request carries Zod internals.
    expect(failureFor(w, { status: 400, body: { error: 'invalid_billing' } })).toEqual(['error', GENERIC]);
    expect(failureFor(w, { status: 400, body: { error: 'invalid_request', details: { fieldErrors: {} } } }))
      .toEqual(['error', GENERIC]);
    // a 5xx or an unparseable body — trying again really can help here
    expect(failureFor(w, { status: 502, body: null })).toEqual(['error', GENERIC]);
    // a network failure / abort never gets as far as a response
    expect(failureFor(w, {})).toEqual(['error', GENERIC]);
    expect(JSON.parse(w.eval('JSON.stringify(bookingCreateFailure(null))'))).toEqual(['error', GENERIC]);
  });
});

describe('createApiBooking — carries the refusal instead of discarding it', () => {
  it('attaches the status and parsed body to the thrown error', async () => {
    const w = loadBooking('mode=private&from=cmb-airport&to=kandy&vehicle=car&price=90&rawPrice=90');
    // jsdom exposes no Response constructor, so hand-roll the three members the code reads.
    // The rate-card lock (/quote/lock) is best-effort and answers first; only the booking
    // POST is refused.
    w.eval(`
      window.CEYLON_HOP_API = 'https://api.test';
      var reply = function(status, body){
        return Promise.resolve({ ok: status < 400, status: status, json: function(){ return Promise.resolve(body); } });
      };
      window.fetch = function(url){
        return String(url).indexOf('/bookings/') === -1
          ? reply(200, {})
          : reply(400, { error:'date_in_past', message:'Trip dates cannot be in the past.' });
      };
      window.__caught = createApiBooking().then(function(){ return {ok:true}; }, function(e){
        return { message: e.message, status: e.status, body: e.body };
      });
    `);
    const caught = await w.__caught;
    expect(caught.status).toBe(400);
    expect(caught.body).toEqual({ error: 'date_in_past', message: 'Trip dates cannot be in the past.' });
  });
});
