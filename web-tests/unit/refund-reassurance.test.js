import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { futureIsoDate } from '../dates.js';

// ────────────────────────────────────────────────────────────────────────────
//  Refund reassurance (owner, 2026-09-23): customers were asking about the
//  refund policy, so the free-cancellation window has to be visible where they
//  CHOOSE and where they PAY, not only in the Terms. Two windows exist
//  (terms.html §7): 24 hours for transfers and shared seats, 10 days — then a
//  tiered refund — for a chauffeur-guide trip.
//
//  Booking harness as in booking-lead-time.test.js: booking.js is a classic
//  script, loaded into jsdom as a real <script> and reached through w.eval.
// ────────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');
const HTML = read('booking.html');
const DEPS = ['site.js', 'ta-data.js', 'routes-data.js', 'transfers-data.js', 'decline-help.js', 'checkout-handoff.js', 'ch-map.js', 'ch-pricing.js'].map(read);
const BOOKING_SRC = read('booking.js');

function loadBooking(query) {
  const dom = new JSDOM(HTML, { url: 'https://example.test/booking.html?' + query, runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  window.scrollTo = () => {};
  [...DEPS, BOOKING_SRC].forEach((src) => {
    const el = window.document.createElement('script');
    el.textContent = src;
    window.document.body.appendChild(el);
  });
  return window;
}

// A multi-day trip well outside the chauffeur notice window, so both service cards are live.
const TRIP = `mode=trip&stops=Colombo|Kandy|Ella&nights=1,2&dates=${futureIsoDate(30)},${futureIsoDate(32)}&kms=&gaps=&vehicle=car&price=200&ad=2`;
const txt = (w, sel) => (w.document.querySelector(sel) || { textContent: '' }).textContent.replace(/\s+/g, ' ');

describe('checkout — service chooser states each option’s window', () => {
  it('private card: 24 hours; chauffeur card: 10 days', () => {
    const w = loadBooking(TRIP);
    expect(txt(w, '.svc[data-svc="private"]')).toContain('Free cancellation up to 24h before');
    expect(txt(w, '.svc[data-svc="chauffeur"]')).toContain('Free cancellation up to 10 days before');
  });
});

describe('checkout — Pay step spells out the policy, not just a link', () => {
  it('a transfer shows the 24-hour rule', () => {
    const w = loadBooking(TRIP);
    const pol = w.document.getElementById('pay-pol');
    expect(pol, 'no refund-policy disclosure on the Pay step').toBeTruthy();
    expect(pol.textContent).toContain('Free cancellation until 24 hours before departure');
    expect(pol.textContent).not.toContain('80%');
  });

  it('a chauffeur-guide trip shows the whole tiered ladder', () => {
    const w = loadBooking(TRIP);
    w.eval("window.pickSvc('chauffeur')");
    const pol = w.document.getElementById('pay-pol').textContent;
    expect(pol).toContain('Free cancellation until 10 days before your trip starts');
    expect(pol).toContain('80% refund');
    expect(pol).toContain('60% refund');
    expect(pol).toContain('40% refund');
  });

  it('switching back to private puts the 24-hour rule back', () => {
    const w = loadBooking(TRIP);
    w.eval("window.pickSvc('chauffeur')");
    w.eval("window.pickSvc('private')");
    expect(w.document.getElementById('pay-pol').textContent).toContain('24 hours before departure');
  });
});

describe('browse — tours, tour detail and planner reassure before checkout', () => {
  it.each([
    ['tours.html', /class="assure"[\s\S]*?Free cancellation[\s\S]*?<\/div>/],
    ['tour.html', /class="incl-mini"[\s\S]*?Free cancellation[\s\S]*?<\/ul>/],
    ['plan.html', /class="incl"[\s\S]*?Free cancellation[\s\S]*?<\/div>\s*<\/div>/],
  ])('%s names the free-cancellation windows', (file, re) => {
    const m = read(file).match(re);
    expect(m, `${file}: no free-cancellation line in its reassurance block`).toBeTruthy();
    expect(m[0]).toContain('24h');
    expect(m[0]).toContain('10 days');
  });
});
