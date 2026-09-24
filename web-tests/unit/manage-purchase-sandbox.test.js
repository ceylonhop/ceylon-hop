import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';

// manage.html's `purchase` gate (review of #774, finding 6). `purchase` becomes GA4 revenue and
// cannot be taken back, so a SANDBOX settlement must never fire it. The return leg never sees the
// checkout URL, so it used to learn the gateway from a private sessionStorage key that manage.html
// AND booking.js wrote at hand-off — a cross-page secret handshake that a blocked storage, a
// different tab or a missed write silently turned into "live". The answer now comes from our own
// server: GET /bookings/pay-return says `sandbox`, from the payment adapter's mode.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');
const HTML = read('manage.html');
const DEPS = ['decline-help.js', 'checkout-handoff.js'].map(read);

const VIEW = {
  reference: 'CH-HAFDZ', status: 'paid', firstName: 'Roshen', from: 'Colombo Airport (CMB)', to: 'Ella',
  date: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10), time: null, travellers: 2, vehicleType: 'car', totalCents: 22900, balanceDueCents: 0,
  amountDueNowCents: 22900, currency: 'USD',
};

// Load the real page on the production host, with analytics recorded and the API stubbed.
function load(payReturn, { prod = true } = {}) {
  const events = [];
  const dom = new JSDOM(HTML, {
    url: 'https://ceylonhop.com/manage.html?t=tok&rt=rt-1',
    runScripts: 'dangerously',
    beforeParse(w) {
      DEPS.forEach((src) => w.eval(src));
      w.CEYLON_HOP_API = 'https://api.test';
      // analytics.js is an external script jsdom does not load; these are its two hooks.
      Object.defineProperty(w, 'chTrack', { value: (e, p) => events.push({ event: e, ...p }), writable: false });
      Object.defineProperty(w, 'chIsProd', { value: () => prod, writable: false });
      const reply = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
      w.fetch = (url) => {
        url = String(url);
        if (url.includes('/bookings/pay-return')) return reply(payReturn);
        if (url.includes('/bookings/view')) return reply(VIEW);
        return reply({});
      };
    },
  });
  return { w: dom.window, events };
}

const settle = (w) => new Promise((r) => w.setTimeout(r, 60));
const purchases = (events) => events.filter((e) => e.event === 'purchase');

describe('manage.html purchase gate', () => {
  it('never fires purchase for a settlement the server says was on the sandbox gateway', async () => {
    const { w, events } = load({ status: 'paid', reference: 'CH-HAFDZ', sandbox: true });
    await settle(w);
    expect(w.document.querySelector('.t-stat').textContent).toBe('Confirmed');
    expect(purchases(events)).toEqual([]);
  });

  it('never fires it when the server does not say (an older API) — fail closed', async () => {
    const { w, events } = load({ status: 'paid', reference: 'CH-HAFDZ' });
    await settle(w);
    expect(purchases(events)).toEqual([]);
  });

  it('fires it once for a live settlement, with the booking’s value', async () => {
    const { w, events } = load({ status: 'paid', reference: 'CH-HAFDZ', sandbox: false });
    await settle(w);
    expect(purchases(events)).toEqual([{ event: 'purchase', transaction_id: 'CH-HAFDZ', value: 229, currency: 'USD' }]);
  });

  it('ignores any leftover sessionStorage sandbox flag — the server’s answer is the only input', async () => {
    const { w, events } = load({ status: 'paid', reference: 'CH-HAFDZ', sandbox: false });
    w.sessionStorage.setItem('ch_manage_pay_v1:sandbox', '1');
    await settle(w);
    expect(purchases(events)).toHaveLength(1);
  });

  it('reads no private sandbox key, and booking.js writes none', () => {
    const strip = (s) => s.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(strip(HTML)).not.toMatch(/:sandbox/);
    expect(strip(HTML)).not.toMatch(/markSandbox|sandboxUsed/);
    expect(strip(read('booking.js'))).not.toMatch(/ch_manage_pay_v1/);
  });
});
