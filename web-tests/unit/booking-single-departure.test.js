import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { nextIsoWeekday, isoParts } from '../dates.js';

// ────────────────────────────────────────────────────────────────────────────
//  The departure step of a shared seat that has ONE scheduled departure.
//
//  Clarity, 2026-09-24 (booking CH-V43ZU): Mirissa → Colombo Airport, corridor
//  south-airport, times=14:45. The step showed a single read-only box reading
//  "2:45 pm · Morning hop". It was styled exactly like the dropdown it replaces, so
//  the customer clicked it twice (two dead clicks) and abandoned.
//
//  Two defects:
//   1. departuresFor() labelled non-private departures by ARRAY POSITION — index 0
//      was always "Morning hop" — so a 14:45 departure was a "Morning hop". Labels
//      must follow the hour, as the private branch already does.
//   2. The single departure was only ever drawn as a plain <div>: nothing read as
//      selected and nothing answered a click. It must render as a pre-selected,
//      pressed control whose click is a harmless no-op, so the only thing left for
//      the customer to do is pick a date.
//
//  Same harness as booking-lead-time.test.js: booking.js is a classic script with
//  no exports, so the real page + its script deps are loaded into jsdom as genuine
//  <script> elements and reached through w.eval.
// ────────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const HTML = readFileSync(path.join(ROOT, 'booking.html'), 'utf8');
const DEPS = ['site.js', 'ta-data.js', 'routes-data.js', 'transfers-data.js', 'decline-help.js', 'checkout-handoff.js', 'ch-map.js', 'ch-pricing.js']
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
const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();

// The exact link search.html built for the recorded customer.
const SOUTH_AIRPORT = 'from=mirissa&to=cmb-airport&mode=shared&price=29.99&times=14%3A45&days=3%2C6&corridor=south-airport';
// The same corridor reached through the catalogue (routes-data.js: south-airport, times ['14:45']).
const SOUTH_AIRPORT_CATALOGUE = 'id=south-airport';
// A corridor with two scheduled departures — the dropdown path, which must not change.
const TWO_DEPARTURES = 'mode=shared&from=cmb-airport&to=kandy&price=19&times=07:30,14:45&days=3,6&corridor=airport-cultural';

describe('departure labels follow the clock, not the array position', () => {
  it('calls a 14:45 shared departure an Afternoon hop', () => {
    const w = loadBooking(SOUTH_AIRPORT);
    expect(ev(w, 'departuresFor()')).toEqual([{ time: '14:45', label: 'Afternoon hop' }]);
  });

  it('labels the catalogue copy of the same corridor the same way', () => {
    const w = loadBooking(SOUTH_AIRPORT_CATALOGUE);
    expect(ev(w, 'departuresFor()')).toEqual([{ time: '14:45', label: 'Afternoon hop' }]);
  });

  it('keeps the "… hop" wording across the day', () => {
    const w = loadBooking('mode=shared&from=cmb-airport&to=kandy&price=19&times=07:30,11:30,14:45,18:00,21:00&days=3,6&corridor=airport-cultural');
    expect(ev(w, 'departuresFor().map(function(d){return d.label})'))
      .toEqual(['Morning hop', 'Morning hop', 'Afternoon hop', 'Evening hop', 'Late hop']);
  });
});

describe('a single scheduled departure is pre-selected — no click needed', () => {
  it('sets the departure the moment the page loads and shows it in the summary', () => {
    const w = loadBooking(SOUTH_AIRPORT);
    expect(ev(w, 'state.dep')).toBe('14:45');
    expect(w.document.getElementById('sum-time').textContent).toBe('2:45 pm');
  });

  it('draws the departure as a pressed control that reads as selected', () => {
    const w = loadBooking(SOUTH_AIRPORT);
    const chip = w.document.getElementById('single-dep-card');
    expect(chip, 'the single-departure chip should exist').toBeTruthy();
    expect(chip.tagName).toBe('BUTTON');
    expect(chip.getAttribute('type')).toBe('button');
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(chip.classList.contains('on')).toBe(true);
    expect(text(chip)).toBe('2:45 pm · Afternoon hop');
    // the dropdown it replaces stays out of the way
    expect(w.document.getElementById('dep-select').style.display).toBe('none');
  });

  it('treats a click on it as a no-op that stays selected', () => {
    const w = loadBooking(SOUTH_AIRPORT);
    const chip = w.document.getElementById('single-dep-card');
    chip.click();
    chip.click(); // the two dead clicks in the recording
    expect(ev(w, 'state.dep')).toBe('14:45');
    expect(ev(w, 'state.flexTime')).toBe(false);
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(chip.classList.contains('on')).toBe(true);
    expect(w.document.getElementById('sum-time').textContent).toBe('2:45 pm');
  });

  it('enables Continue on the date alone — the departure never needs a click', () => {
    const w = loadBooking(SOUTH_AIRPORT);
    const n2 = w.document.getElementById('n2');
    expect(n2.disabled, 'no date picked yet').toBe(true);
    expect(w.document.getElementById('when-blocked').textContent).toContain('Pick a travel date');
    const { year, monthIndex, day } = isoParts(nextIsoWeekday(3)); // a Wednesday — a service day
    w.eval(`window.pickDate(${year},${monthIndex},${day})`);
    expect(n2.disabled).toBe(false);
    expect(ev(w, 'state.dep')).toBe('14:45');
  });

  it('re-selects the departure whenever the chip is redrawn, even if state was cleared', () => {
    const w = loadBooking(SOUTH_AIRPORT);
    w.eval('state.dep=null; renderDeps();');
    expect(ev(w, 'state.dep')).toBe('14:45');
    expect(w.document.getElementById('single-dep-card').getAttribute('aria-pressed')).toBe('true');
  });

  it('leaves a two-departure corridor on the dropdown with nothing pre-selected', () => {
    const w = loadBooking(TWO_DEPARTURES);
    expect(w.document.getElementById('single-dep-card')).toBeNull();
    expect(w.document.getElementById('dep-select').style.display).not.toBe('none');
    expect(ev(w, 'state.dep')).toBe(null);
  });
});
