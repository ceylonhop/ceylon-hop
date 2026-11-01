import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, it, expect } from 'vitest';

// ────────────────────────────────────────────────────────────────────────────
//  The place menu must never cover the field it belongs to.
//
//  On a phone with the keyboard up (customer screenshot, iPhone, 2026-09-26)
//  typing "Colo" opened the menu over the pick-up field itself: the customer
//  could see the suggestions but not what they had typed. Reproduced on the
//  live site at 393×430 with the field 210px down — field 210–262, menu 12–292.
//
//  Cause: with too little room below, the menu flips above the field, and
//  `Math.max(12, …)` then pushed it back down to the top of the screen without
//  shortening it, so its 280px ran straight over the field.
//
//  Also held here:
//   - the menu picks ONE side for a query: the local rows paint first, and the
//     Google rows arriving must not throw the menu from below to above;
//   - the room is measured on the VISIBLE area (visualViewport), which is what
//     the phone keyboard shrinks and shifts.
// ────────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../');
const DEPS = ['transfers-data.js', 'site.js'].map((f) =>
  readFileSync(path.join(ROOT, f), 'utf8'),
);

const FIELD_H = 52; // measured on the home hero field, 393px wide
const ROW_H = 47.2; // measured .place-option height on a phone; menu chrome is 8+8 padding, 1+1 border
const GOOGLE_COLO = [
  { text: 'Colombo International Airport Ratmalana, Sri Lanka', main: 'Colombo International Airport Ratmalana' },
  { text: 'Colombo Fort Station, Colombo, Sri Lanka', main: 'Colombo Fort Station' },
  { text: 'Colombo Bandaranaike International Airport (CMB), Katunayake, Sri Lanka', main: 'Colombo Bandaranaike International Airport' },
  { text: 'Colombo City Centre Mall, Colombo, Sri Lanka', main: 'Colombo City Centre Mall' },
];

// `viewport` is the window; `visual`, when given, is window.visualViewport.
function mountPicker({ viewport, fieldTop, visual }) {
  const dom = new JSDOM('<!doctype html><body><input id="p"></body>', {
    url: 'https://example.test/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  Object.defineProperty(window, 'innerWidth', { value: viewport.width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: viewport.height, configurable: true });
  if (visual) Object.defineProperty(window, 'visualViewport', { value: visual, configurable: true });
  // jsdom has no layout: give the menu the height a browser would — its rows, capped by max-height.
  Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      if (!this.classList.contains('place-menu')) return 0;
      const cap = parseFloat(this.style.maxHeight);
      return Math.min(Number.isNaN(cap) ? Infinity : cap, this.querySelectorAll('.place-option').length * ROW_H + 18);
    },
  });
  DEPS.forEach((src) => {
    const el = window.document.createElement('script');
    el.textContent = src;
    window.document.body.appendChild(el);
  });
  window.CEYLON_MAPS_KEY = 'test-key';
  window.CH_MAP = { suggest: () => Promise.resolve(GOOGLE_COLO) };
  const input = window.document.getElementById('p');
  const rect = { top: fieldTop, bottom: fieldTop + FIELD_H, left: 35, right: 304, width: 269, height: FIELD_H };
  input.getBoundingClientRect = () => ({ ...rect, x: rect.left, y: rect.top });
  window.attachLocalPlaceAutocomplete(input);
  return { window, input, rect };
}

function readMenu(window) {
  const menu = window.document.querySelector('.place-menu');
  if (!menu) return null;
  const top = parseFloat(menu.style.top);
  const maxHeight = parseFloat(menu.style.maxHeight);
  return { top, maxHeight, bottom: top + menu.offsetHeight, rows: menu.querySelectorAll('.place-option').length };
}

// First paint is the local rows (plus "Searching Google…"); the Google promise
// repaints one microtask later.
async function type(window, input, value) {
  input.focus();
  input.value = value;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  const first = readMenu(window);
  await new Promise((r) => setTimeout(r, 0));
  return { first, final: readMenu(window) };
}

function coversField(menu, rect) {
  return menu.top < rect.bottom && menu.bottom > rect.top;
}

describe('the place menu never covers its own field', () => {
  it('phone with the keyboard up: the live repro (393×430, field 210px down)', async () => {
    const { window, input, rect } = mountPicker({ viewport: { width: 393, height: 430 }, fieldTop: 210 });
    const { final } = await type(window, input, 'Colo');

    expect(final.rows).toBe(6);
    expect(coversField(final, rect)).toBe(false);
    expect(final.top).toBeGreaterThanOrEqual(12);
  });

  it('holds for every field position on short screens', async () => {
    // One page per screen height; the field moves within it. A fresh JSDOM per position
    // (153 of them) made this the slowest unit test and timed it out under load. Reuse is
    // safe because paint() re-measures the field on every paint — the side is decided from
    // the space alone — and the field is cleared (menu closed) before each position.
    for (const height of [220, 300, 360, 430, 470]) {
      const { window, input, rect } = mountPicker({ viewport: { width: 393, height }, fieldTop: 0 });
      for (let fieldTop = 0; fieldTop <= height - FIELD_H; fieldTop += 10) {
        input.value = '';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        expect(readMenu(window)).toBeNull();
        rect.top = fieldTop;
        rect.bottom = fieldTop + FIELD_H;
        const { first, final } = await type(window, input, 'Colo');
        for (const menu of [first, final]) {
          expect(coversField(menu, rect), `height ${height}, field at ${fieldTop}`).toBe(false);
          expect(menu.top, `height ${height}, field at ${fieldTop}`).toBeGreaterThanOrEqual(12);
          expect(menu.bottom, `height ${height}, field at ${fieldTop}`).toBeLessThanOrEqual(height - 12);
        }
      }
    }
    // 5 mounts + 153 typed positions: ~1.6s alone, but 5.6s inside a loaded full run
    // (2026-10-07) — past vitest's 5s default with nothing wrong.
  }, 20_000);

  it('still opens below, full height, when there is room (desktop)', async () => {
    const { window, input, rect } = mountPicker({ viewport: { width: 1280, height: 800 }, fieldTop: 200 });
    const { final } = await type(window, input, 'Colo');

    expect(final.top).toBe(rect.bottom + 6);
    expect(final.maxHeight).toBe(280);
  });
});

describe('the menu keeps to one side while the Google rows arrive', () => {
  it('does not jump from below to above when the list grows', async () => {
    // 150px free below: enough for the 2 local rows, not for the full list.
    const { window, input } = mountPicker({ viewport: { width: 393, height: 430 }, fieldTop: 210 });
    const { first, final } = await type(window, input, 'Colo');

    expect(first.top < 210).toBe(final.top < 210);
  });
});

describe('room is measured on the visible area, not the window', () => {
  it('keeps the menu inside a keyboard-shrunk, shifted visual viewport', async () => {
    // Window still 932 tall; the keyboard leaves 470px visible, scrolled 22px down.
    const visual = { offsetTop: 22, height: 470, width: 430, addEventListener() {} };
    const { window, input, rect } = mountPicker({ viewport: { width: 430, height: 932 }, fieldTop: 250, visual });
    const { final } = await type(window, input, 'Colo');

    expect(coversField(final, rect)).toBe(false);
    expect(final.top).toBeGreaterThanOrEqual(22 + 12);
    expect(final.bottom).toBeLessThanOrEqual(22 + 470 - 12);
  });
});
