import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';

// Why this file exists: on 2026-09-24 PayHere's decline list showed two website payments
// (CH-Y5RXW, CH-V43ZU) as "3ds Authentication Failed" with no notify ever reaching us — the 3-D
// Secure bank challenge dying inside the SDK's cross-origin iframe (docs/checkout-redirect-spec.md
// §1.4). pay.html left the SDK in #310–#318 and manage.html in #772; the website wizard was the
// last page running it (spec §10). It now does the same top-level form POST and sends the customer
// back to their booking's manage page, which asks our own server for the outcome.
// Same guards as pay-page-redirect.test.js / manage-page-redirect.test.js.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const HTML = readFileSync(path.join(ROOT, 'booking.html'), 'utf8');
const BOOKING_SRC = readFileSync(path.join(ROOT, 'booking.js'), 'utf8');

// Comments explain the history and legitimately mention the old SDK by name; stripping them keeps
// these guards about the CODE. Block comments first, then whole-line `//` comments (a blanket
// '//' strip would eat the '//' in URLs).
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const html = strip(HTML);
const js = strip(BOOKING_SRC);

describe('booking page uses a top-level redirect, not the PayHere iframe SDK', () => {
  it('does not load PayHere’s JavaScript SDK', () => {
    expect(html).not.toMatch(/payhere\.lk\/lib\/payhere\.js/);
  });

  it('never calls the SDK’s in-page checkout, or waits for it to load', () => {
    expect(js).not.toMatch(/payhere\s*\.\s*startPayment/);
    expect(js).not.toMatch(/payhere\s*\.\s*on(Completed|Dismissed|Error)/);
    expect(js).not.toMatch(/window\.payhere/);
    expect(js).not.toMatch(/function\s+startPayHere\b/);
  });

  // The form itself lives in checkout-handoff.js, shared by booking.html and manage.html
  // (checkout-handoff.test.js drives it); this page must hand the server's answer over untouched.
  it('submits a real top-level form POST to the gateway’s own URL, fields verbatim', () => {
    const shared = readFileSync(path.join(__dirname, '..', '..', 'checkout-handoff.js'), 'utf8');
    expect(shared).toMatch(/createElement\('form'\)/);
    expect(shared).toMatch(/\.method\s*=\s*'POST'/);
    expect(shared).toMatch(/\.action\s*=\s*checkout\.checkoutUrl/);
    expect(shared).toMatch(/Object\.keys\(checkout\.fields\)/);
    expect(shared).toMatch(/\.submit\(\)/);
    expect(js).toMatch(/chSubmitToGateway\(checkout\)/);
    expect(js).not.toMatch(/fields\.(amount|hash|merchant_id|order_id)\s*=/);
  });

  it('asks the server for a manage-page return, stating intent rather than a URL', () => {
    expect(js).toMatch(/returnTo:\s*'manage'/);
    expect(js).not.toMatch(/returnUrl:\s*['"]http/);
  });
});

describe('booking page analytics for a real-gateway payment', () => {
  // The outcome is only known on the way back, and the way back is manage.html — which fires
  // `purchase` (production host, never sandbox, once per booking) and `payment_failed` from our
  // server's answer. booking.js firing either as well would double-count, or count a payment
  // nobody confirmed.
  it('fires no failure or dismissal events — those came from SDK callbacks that no longer exist', () => {
    expect(js).not.toMatch(/chTrack\(\s*'payment_failed'/);
    expect(js).not.toMatch(/chTrack\(\s*'payment_dismissed'/);
  });

  it('fires purchase only from finalizeBooking, which the real gateway never reaches', () => {
    const calls = js.match(/chTrack\(\s*'purchase'/g) || [];
    expect(calls).toHaveLength(1);
    const fin = js.slice(js.indexOf('function finalizeBooking('));
    expect(fin).toMatch(/chTrack\(\s*'purchase'/);
  });

  it('still fires payment_initiated at the start of the attempt', () => {
    expect(js).toMatch(/chTrack\('payment_initiated',\{payment_type:state\.payPlan,currency:'USD',value:calcTotal\(\)\}\)/);
  });
});

// ── behaviour, in jsdom: the real page and booking.js, the gateway call stubbed ─────────────────
const DEPS = ['site.js', 'ta-data.js', 'routes-data.js', 'transfers-data.js', 'decline-help.js', 'checkout-handoff.js', 'ch-map.js', 'ch-pricing.js']
  .map((f) => readFileSync(path.join(ROOT, f), 'utf8'));

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

const FIELDS = {
  merchant_id: 'm-1', return_url: 'https://site.test/manage.html?t=a&rt=b', cancel_url: 'https://site.test/manage.html?t=a&rt=b&c=1',
  notify_url: 'https://api.test/webhooks/payments', order_id: 'CH-8UVYG', items: 'Ceylon Hop', currency: 'USD',
  amount: '121.00', first_name: 'Maya', hash: 'HASHVALUE',
};

function arm(w, checkoutUrl, extra = {}) {
  w.eval(`
    window.CEYLON_HOP_API = 'https://api.test/';
    window.__fetches = [];
    window.__submitted = [];
    window.dataLayer = [];
    window.chTrack = function(e, p){ window.dataLayer.push(Object.assign({ event: e }, p || {})); };
    navigator.sendBeacon = function(){ return true; };
    HTMLFormElement.prototype.submit = function(){
      window.__submitted.push({
        method: this.method, action: this.action,
        inputs: Array.from(this.elements).map(function(i){ return [i.name, i.value, i.type]; }),
        attached: document.body.contains(this),
        msg: document.getElementById('ph-msg').textContent,
      });
    };
    window.fetch = function(url, opts){
      window.__fetches.push({ url: String(url), opts: opts });
      return Promise.resolve({ ok: true, json: function(){ return Promise.resolve({
        checkoutUrl: ${JSON.stringify(checkoutUrl)}, payReturnToken: 'rt-1', attempt: 1, fields: ${JSON.stringify(FIELDS)},
        ...${JSON.stringify(extra)} }); } });
    };
  `);
}

const flush = (w) => new Promise((r) => w.setTimeout(r, 20));

describe('continueToCheckout hands the browser to PayHere', () => {
  it('POSTs a top-level form with every field verbatim, in the server’s order', async () => {
    const w = loadBooking();
    arm(w, 'https://www.payhere.lk/pay/checkout');
    w.eval(`continueToCheckout({ id: 'b-123', reference: 'CH-8UVYG', checkoutToken: 'tok.abc' })`);
    await flush(w);
    expect(w.__submitted).toHaveLength(1);
    const f = w.__submitted[0];
    expect(f.method).toBe('post');
    expect(f.action).toBe('https://www.payhere.lk/pay/checkout');
    expect(f.attached).toBe(true);
    expect(f.inputs).toEqual(Object.entries(FIELDS).map(([k, v]) => [k, v, 'hidden']));
    // The overlay says where they are going until the browser actually leaves.
    expect(f.msg).toBe('Opening secure payment…');
    expect(w.document.getElementById('ph-overlay').classList.contains('show')).toBe(true);
  });

  it('asks for the manage-page return with a JSON body and the checkout capability', async () => {
    const w = loadBooking();
    arm(w, 'https://sandbox.payhere.lk/pay/checkout');
    w.eval(`continueToCheckout({ id: 'b-123', reference: 'CH-8UVYG', checkoutToken: 'tok.abc' })`);
    await flush(w);
    const call = w.__fetches.find((c) => c.url.endsWith('/bookings/b-123/checkout'));
    expect(call.url).toBe('https://api.test/bookings/b-123/checkout');
    expect(call.opts.method).toBe('POST');
    expect(call.opts.headers).toEqual({ authorization: 'Bearer tok.abc', 'content-type': 'application/json' });
    expect(JSON.parse(call.opts.body)).toEqual({ returnTo: 'manage' });
  });

  it('shows no confirmation and fires no outcome event before the customer has even paid', async () => {
    const w = loadBooking();
    arm(w, 'https://www.payhere.lk/pay/checkout');
    w.eval(`continueToCheckout({ id: 'b-123', reference: 'CH-8UVYG', checkoutToken: 'tok.abc' })`);
    await flush(w);
    await new Promise((r) => w.setTimeout(r, 200));
    expect(w.document.getElementById('confirm').style.display).not.toBe('block');
    const events = w.dataLayer.map((e) => e.event);
    expect(events).not.toContain('purchase');
    expect(events).not.toContain('payment_failed');
    expect(events).not.toContain('payment_dismissed');
  });

  // manage.html's purchase gate reads which gateway it handed off to from this tab's storage (the
  // return leg never sees the URL); a website hand-off must record it the same way, or a sandbox
  // payment returning to a production host would be counted as revenue.
  it('records a sandbox hand-off where manage.html’s purchase gate looks for it', async () => {
    const w = loadBooking();
    arm(w, 'https://sandbox.payhere.lk/pay/checkout');
    w.eval(`continueToCheckout({ id: 'b-123', reference: 'CH-8UVYG', checkoutToken: 'tok.abc' })`);
    await flush(w);
    expect(w.sessionStorage.getItem('ch_manage_pay_v1:sandbox')).toBe('1');
    const live = loadBooking();
    arm(live, 'https://www.payhere.lk/pay/checkout');
    live.eval(`continueToCheckout({ id: 'b-123', reference: 'CH-8UVYG', checkoutToken: 'tok.abc' })`);
    await flush(live);
    expect(live.sessionStorage.getItem('ch_manage_pay_v1:sandbox')).toBe('0');
  });

  // Review of #774, finding 3: the return URL no longer carries the manage token, so the website
  // (which has none of its own) stashes the one the checkout answer hands it, under manage.html's
  // key, BEFORE it leaves — or the customer comes back to a page that cannot show their booking.
  it('stashes the checkout’s manage token under manage.html’s key before handing off', async () => {
    const w = loadBooking();
    arm(w, 'https://www.payhere.lk/pay/checkout', { manageToken: 'mt-123' });
    w.eval(`HTMLFormElement.prototype.submit = (function(orig){ return function(){
      window.__stashAtSubmit = sessionStorage.getItem(window.CH_MANAGE_TOKEN_KEY); return orig.call(this); }; })(HTMLFormElement.prototype.submit);`);
    w.eval(`continueToCheckout({ id: 'b-123', reference: 'CH-8UVYG', checkoutToken: 'tok.abc' })`);
    await flush(w);
    expect(w.CH_MANAGE_TOKEN_KEY).toBe('chManageToken');
    expect(w.__stashAtSubmit).toBe('mt-123');
    expect(w.__submitted).toHaveLength(1);
  });

  it('still hands off when storage refuses the token — manage.html has minimal states for that', async () => {
    const w = loadBooking();
    arm(w, 'https://www.payhere.lk/pay/checkout', { manageToken: 'mt-123' });
    w.eval(`Storage.prototype.setItem = function(){ throw new Error('SecurityError'); };`);
    w.eval(`continueToCheckout({ id: 'b-123', reference: 'CH-8UVYG', checkoutToken: 'tok.abc' })`);
    await flush(w);
    expect(w.__submitted).toHaveLength(1);
  });

  // Back from PayHere with the browser's Back button restores this page from the back/forward
  // cache exactly as it was left: the hand-off spinner up and Pay latched. It must not stay that way.
  it('a page restored from the back/forward cache gets a working retry, not a dead spinner', async () => {
    const w = loadBooking();
    arm(w, 'https://www.payhere.lk/pay/checkout');
    w.eval(`paySubmitting = true; document.getElementById('pay-btn').disabled = true;`);
    w.eval(`continueToCheckout({ id: 'b-123', reference: 'CH-8UVYG', checkoutToken: 'tok.abc' })`);
    await flush(w);
    expect(w.__submitted).toHaveLength(1);
    w.dispatchEvent(new w.PageTransitionEvent('pageshow', { persisted: true }));
    expect(w.document.getElementById('ph-spin').style.display).toBe('none');
    expect(w.document.getElementById('ph-msg').textContent).toMatch(/came back before finishing/);
    expect(w.document.getElementById('ph-retry').hidden).toBe(false);
    expect(w.document.getElementById('pay-btn').disabled).toBe(false);
    // An ordinary (non-restored) show, or one with no hand-off behind it, changes nothing.
    const fresh = loadBooking();
    fresh.dispatchEvent(new fresh.PageTransitionEvent('pageshow', { persisted: true }));
    expect(fresh.document.getElementById('ph-overlay').classList.contains('show')).toBe(false);
  });

  it('keeps the fake gateway on the simulated interstitial — no form, no navigation', async () => {
    const w = loadBooking();
    arm(w, 'https://example.test/fake-gateway');
    w.eval(`continueToCheckout({ id: 'b-123', reference: 'CH-8UVYG', checkoutToken: 'tok.abc' })`);
    await flush(w);
    expect(w.__submitted).toHaveLength(0);
    expect(w.document.getElementById('ph-msg').textContent).toMatch(/Redirecting you to PayHere/);
  });
});
