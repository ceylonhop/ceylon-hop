import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { futureIsoDate } from '../dates.js';

// ────────────────────────────────────────────────────────────────────────────
//  manage.html — the two checkout calls get a deadline.
//
//  Pay with PayHere paints "Taking you to PayHere…" (a screen with no button) and then runs
//  two calls in a row: POST /bookings/view/checkout-token, then POST /bookings/:id/checkout.
//  Neither had a deadline, so an API that accepts the connection and never answers (a
//  saturated pool, an instance mid-restart) held the customer on that screen with no way out
//  but a reload. pay.html has given every call 20 s since the redirect checkout and booking.js
//  got the same for its checkout call (#974); this page gets the same. An abort must land in
//  the page's EXISTING failure state — the booking view rebuilt with the error named on it and
//  the Pay button back — and never show the browser's own abort wording.
//
//  Same jsdom harness as manage-purchase-sandbox.test.js, with the fetch stub honouring the
//  abort contract (a request whose `signal` fires rejects with an AbortError, as a browser's
//  would) and timers recorded, not run, so the test fires the deadline itself.
// ────────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');
const HTML = read('manage.html');
const DEPS = ['decline-help.js', 'checkout-handoff.js'].map(read);

const DEADLINE_MS = 20000;
const VIEW = {
  reference: 'CH-HAFDZ', status: 'payment_pending', firstName: 'Roshen', from: 'Colombo Airport (CMB)', to: 'Ella',
  date: futureIsoDate(), time: null, travellers: 2, vehicleType: 'car', totalCents: 22900, balanceDueCents: 0,
  amountDueNowCents: 22900, currency: 'USD',
};
const TOKEN = { bookingId: 'b-1', checkoutToken: 'ct-1' };

// Load the real page with the API stubbed: /view answers at once, and whichever checkout call
// `stall` names never answers — unless its request is aborted, in which case it rejects the way
// a browser's fetch does. 'checkout-body' answers the headers at once and then stalls the body
// (aborting the request then rejects the body read, as a browser's does); 'checkout-offline'
// fails the way a dropped connection does. Every other call answers 200.
function load(stall) {
  const events = [];
  const dom = new JSDOM(HTML, {
    url: 'https://ceylonhop.com/manage.html?t=tok',
    runScripts: 'dangerously',
    beforeParse(w) {
      DEPS.forEach((src) => w.eval(src));
      w.CEYLON_HOP_API = 'https://api.test';
      Object.defineProperty(w, 'chTrack', { value: (e, p) => events.push({ event: e, ...p }), writable: false });
      w.__submitted = 0;
      w.chSubmitToGateway = () => { w.__submitted++; };
      w.__timers = [];
      const realSetTimeout = w.setTimeout.bind(w);
      w.setTimeout = (fn, ms) => {
        const entry = { fn, ms, id: realSetTimeout(() => {}, 0), cleared: false };
        w.__timers.push(entry);
        return entry.id;
      };
      w.clearTimeout = (id) => { w.__timers.forEach((t) => { if (t.id === id) t.cleared = true; }); };
      const reply = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
      const hang = (opts) => new Promise((_, reject) => {
        const signal = opts && opts.signal;
        if (signal) signal.addEventListener('abort', () => reject(new w.DOMException('The user aborted a request.', 'AbortError')));
      });
      w.fetch = (url, opts) => {
        url = String(url);
        if (url.includes('/bookings/view/checkout-token')) return stall === 'checkout-token' ? hang(opts) : reply(TOKEN);
        if (url.includes('/bookings/b-1/checkout')) {
          if (stall === 'checkout') return hang(opts);
          if (stall === 'checkout-body') return Promise.resolve({ ok: true, status: 200, json: () => hang(opts) });
          if (stall === 'checkout-offline') return Promise.reject(new TypeError('Failed to fetch'));
          return reply({});
        }
        if (url.includes('/bookings/view')) return reply(VIEW);
        return reply({});
      };
    },
  });
  return { w: dom.window, events };
}

const settle = () => new Promise((r) => setTimeout(r, 30));
// The 20 s deadlines armed so far, oldest first — one per checkout call made.
const deadlines = (w) => w.__timers.filter((t) => t.ms === DEADLINE_MS);
// The ones still live — a cleared deadline can never fire.
const live = (w) => deadlines(w).filter((t) => !t.cleared);

async function pressPay(stall) {
  const { w, events } = load(stall);
  await settle();
  const btn = w.document.getElementById('paybtn');
  expect(btn, 'the booking renders with its Pay button').not.toBeNull();
  btn.click();
  await settle();
  // Still waiting on the API: the hand-off screen, which has no button on it.
  expect(w.document.querySelector('.pp-loading')).not.toBeNull();
  expect(w.document.getElementById('paybtn')).toBeNull();
  return { w, events };
}

async function expectFailureState(w) {
  await settle();
  expect(w.__submitted).toBe(0);
  expect(w.document.querySelector('.pp-loading'), 'the hand-off screen is gone').toBeNull();
  // The page's existing failure state: the booking view rebuilt, the error named on it, Pay back.
  const err = w.document.getElementById('payerr');
  expect(err).not.toBeNull();
  expect(err.hidden).toBe(false);
  expect(err.textContent).toBe('We couldn’t start your payment just now — no charge was made.');
  expect(w.document.getElementById('paybtn')).not.toBeNull();
  // In the page's own words — never "The user aborted a request." or any browser's variant.
  expect(w.document.getElementById('app').textContent).not.toMatch(/abort/i);
}

describe('manage.html — a checkout call that never answers', () => {
  it('gives the checkout-token call 20 s, then shows the failure state with Pay back', async () => {
    const { w, events } = await pressPay('checkout-token');
    const armed = deadlines(w);
    expect(armed, 'the checkout-token fetch arms a 20 s deadline').toHaveLength(1);
    armed[0].fn();
    await expectFailureState(w);
    expect(events.filter((e) => e.event === 'payment_start_failed')).toHaveLength(1);
  });

  it('gives the checkout call its own 20 s, then shows the failure state with Pay back', async () => {
    const { w } = await pressPay('checkout');
    const armed = deadlines(w);
    expect(armed, 'each of the two calls arms its own 20 s deadline').toHaveLength(2);
    armed[1].fn();
    await expectFailureState(w);
  });

  it('keeps the deadline running while the body is read, so headers-then-silence still ends', async () => {
    const { w } = await pressPay('checkout-body');
    const pending = live(w);
    expect(pending, 'the checkout’s deadline is still armed while its body is read').toHaveLength(1);
    pending[0].fn();
    await expectFailureState(w);
  });

  it('a dropped connection shows the same failure state, never the browser’s “Failed to fetch”', async () => {
    const { w } = load('checkout-offline');
    await settle();
    w.document.getElementById('paybtn').click();
    await expectFailureState(w);
    expect(w.document.getElementById('app').textContent).not.toContain('Failed to fetch');
  });
});
