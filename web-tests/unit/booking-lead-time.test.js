import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { futureIsoDate } from '../dates.js';

// ────────────────────────────────────────────────────────────────────────────
//  Minimum notice in the booking wizard (owner rule, 2026-08-16): a private
//  transfer needs 12 hours, a chauffeur-guide trip needs 7 days. The API is the
//  real gate (api/src/domain/dateRules.ts + routes/bookings.ts); these assert
//  the wizard never OFFERS what the API would refuse with lead_time_too_short.
//
//  Same harness as booking-intent.test.js: booking.js is a classic script with
//  no exports, so the real page + its script deps are loaded into jsdom as
//  genuine <script> elements and reached through w.eval.
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

const ev = (w, expr) => JSON.parse(w.eval(`JSON.stringify((function(){ return (${expr}); })())`) ?? 'null');

const HOUR = 3600000;
// The Asia/Colombo wall clock `hours` from now. Colombo is a fixed UTC+05:30, so shifting the
// instant by the offset and reading its UTC fields gives the local date and time exactly — the
// same trick booking.js and api/src/testSupport/dates.ts use. Anchored to now, never a literal,
// so the suite cannot rot (see unit/no-date-bombs.test.js).
function colomboIn(hours) {
  const iso = new Date(Date.now() + hours * HOUR + 5.5 * HOUR).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

describe('private transfer — 12 hours notice', () => {
  const PRIVATE = 'mode=private&from=cmb-airport&to=kandy&vehicle=car&price=90&rawPrice=90&ad=2';

  it('flags a pick-up inside the window and clears one beyond it', () => {
    const w = loadBooking(PRIVATE);
    const soon = colomboIn(6);
    w.eval(`state.date=new Date('${soon.date}T00:00:00');`);
    expect(ev(w, `tooSoonToPickUp('${soon.time}')`)).toBe(true);

    const later = colomboIn(20);
    w.eval(`state.date=new Date('${later.date}T00:00:00');`);
    expect(ev(w, `tooSoonToPickUp('${later.time}')`)).toBe(false);
  });

  it('offers no pick-up time that is less than 12 hours away', () => {
    const w = loadBooking(PRIVATE);
    // Tomorrow — the earliest the calendar allows, and the only day the rule can bite.
    w.eval('state.date=new Date(Date.now()+86400000); state.date.setHours(0,0,0,0); renderDeps();');
    const iso = ev(w, 'fmtISO(state.date)');
    const offered = [...w.document.getElementById('dep-select').options]
      .map((o) => o.value)
      .filter(Boolean);

    expect(offered.length).toBeGreaterThan(0); // a whole day is never wiped out
    for (const time of offered) {
      const hoursAway = (Date.parse(`${iso}T${time}:00+05:30`) - Date.now()) / HOUR;
      expect(hoursAway).toBeGreaterThanOrEqual(12);
    }
  });

  it('drops a chosen time that the notice window has overtaken', () => {
    const w = loadBooking(PRIVATE);
    const soon = colomboIn(2);
    // A time carried in from a stale link, on a date it is now far too late for.
    w.eval(`state.date=new Date('${soon.date}T00:00:00'); state.dep='${soon.time}'; renderDeps();`);
    expect(ev(w, 'state.dep')).toBe(null);
  });

  it('leaves a comfortably future date untouched — every time is still on offer', () => {
    const w = loadBooking(PRIVATE);
    w.eval(`state.date=new Date('${futureIsoDate(30)}T00:00:00'); renderDeps();`);
    const offered = [...w.document.getElementById('dep-select').options].map((o) => o.value).filter(Boolean);
    expect(offered).toEqual(ev(w, 'departuresFor().map(function(d){return d.time})'));
    expect(w.document.getElementById('dep-hint').textContent).toContain('Choose any time of day');
  });
});

describe('chauffeur-guide — 7 days notice', () => {
  // Chauffeur legs stay 2 days apart, the api suite's own convention.
  const tripQuery = (d1, d2) =>
    `mode=trip&stops=Colombo|Kandy|Ella&nights=1,2&dates=${d1},${d2}&kms=&gaps=&vehicle=car&price=200&ad=2`;

  it('is too soon inside 7 days, and fine beyond', () => {
    const near = loadBooking(tripQuery(futureIsoDate(3), futureIsoDate(5)));
    expect(ev(near, 'chauffeurTooSoon()')).toBe(true);

    const far = loadBooking(tripQuery(futureIsoDate(30), futureIsoDate(32)));
    expect(ev(far, 'chauffeurTooSoon()')).toBe(false);
  });

  it('judges the EARLIEST date, not the first one listed', () => {
    const w = loadBooking(tripQuery(futureIsoDate(30), futureIsoDate(3)));
    expect(ev(w, 'chauffeurTooSoon()')).toBe(true);
  });

  it('disables the chauffeur option and explains why', () => {
    const w = loadBooking(tripQuery(futureIsoDate(3), futureIsoDate(5)));
    const btn = w.document.querySelector('.svc[data-svc="chauffeur"]');
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    const cx = w.document.getElementById('chauffeur-extra');
    expect(cx.style.display).toBe('block');
    expect(cx.textContent).toContain('7 days');
    expect(cx.textContent).toContain('earliest chauffeur start is');
  });

  /* The notice window is a WEBSITE rule, not a capacity one -- the API deliberately exempts
     ops bookings, so staff can still take a chauffeur trip inside it by hand. A refusal that
     ends on "no" therefore turns away a journey we are able to run. The explainer has to
     offer the one route that still works, and it has to carry the itinerary so the traveller
     does not retype what they just entered. */
  it('offers WhatsApp as the way through, carrying the trip with it', () => {
    const w = loadBooking(tripQuery(futureIsoDate(3), futureIsoDate(5)));
    const wa = w.document.querySelector('#chauffeur-extra a[href*="wa.me"]');
    expect(wa, 'no WhatsApp handoff in the chauffeur notice explainer').toBeTruthy();
    expect(wa.target).toBe('_blank');
    expect(wa.rel).toContain('noopener');

    const msg = decodeURIComponent(wa.getAttribute('href').split('?text=')[1] || '');
    expect(msg, 'the message should name the constraint being asked about').toContain('chauffeur-guide starting earlier');
    // waTripSummary() -- the itinerary travels with the enquiry
    expect(msg).toContain('Ceylon Hop');
    expect(msg.length).toBeGreaterThan(60);
  });

  it('will not let a chauffeur selection stand on a trip inside the window', () => {
    const w = loadBooking(tripQuery(futureIsoDate(3), futureIsoDate(5)));
    w.eval("state.svc='chauffeur'; render();");
    expect(ev(w, 'state.svc')).toBe('private');
  });

  it('leaves the option live on a trip beyond the window', () => {
    const w = loadBooking(tripQuery(futureIsoDate(30), futureIsoDate(32)));
    expect(w.document.querySelector('.svc[data-svc="chauffeur"]').disabled).toBe(false);
    w.eval("window.pickSvc('chauffeur')");
    expect(ev(w, 'state.svc')).toBe('chauffeur');
  });
});
