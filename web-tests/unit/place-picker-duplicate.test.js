import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, it, expect } from 'vitest';

// ────────────────────────────────────────────────────────────────────────────
//  The place picker must not offer the same place twice.
//
//  Typing "Sigiriya" produced two rows that read as one place to a customer:
//
//      [Popular]  Sigiriya / Dambulla     (id: sigiriya)
//      [Google]   Sigiriya, Sri Lanka     (no id)
//
//  They are not interchangeable. The id decides baked pricing AND whether
//  search.js ever consults `sharedOption` — so picking the Google row silently
//  swapped the $27.49 shared seat on CMB → Sigiriya for an engine-priced route
//  with a panel claiming we run no shared service on it. A coin-flip in the
//  dropdown, with the shared product on one face.
//
//  Type "Negombo" or "Ella" and there is no second row: `shouldAskGoogle` sees an
//  exact local match and never queries Google. That already holds for 16 of the
//  19 places — the duplicate only appears for the three whose catalogue name is
//  not what a person types (Sigiriya / Dambulla, Colombo Airport (CMB),
//  Colombo city). This closes that gap.
//
//  What must NOT change: Google is still ASKED for these queries. Collapsing the
//  duplicate row is not the same as walling off Google — "Sigiriya Village Hotel"
//  has to stay reachable, so the fix drops one row from the merge rather than
//  skipping the lookup.
// ────────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../');
const DEPS = ['transfers-data.js', 'site.js'].map((f) =>
  readFileSync(path.join(ROOT, f), 'utf8'),
);

const GOOGLE = {
  Sigiriya: [
    { text: 'Sigiriya, Sri Lanka', main: 'Sigiriya', secondary: 'Sri Lanka' },
    { text: 'Sigiriya Village Hotel, Kandalama Road, Sri Lanka', main: 'Sigiriya Village Hotel', secondary: 'Kandalama Road' },
    { text: 'Sigiriya Rock, Sri Lanka', main: 'Sigiriya Rock', secondary: 'Sri Lanka' },
  ],
  'Colombo Airport': [
    { text: 'Colombo Airport, Sri Lanka', main: 'Colombo Airport', secondary: 'Sri Lanka' },
    { text: 'Colombo Airport Garden Hotel, Sri Lanka', main: 'Colombo Airport Garden Hotel', secondary: 'Sri Lanka' },
  ],
};

function mountPicker() {
  const dom = new JSDOM('<!doctype html><body><input id="p"></body>', {
    url: 'https://example.test/search.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  DEPS.forEach((src) => {
    const el = window.document.createElement('script');
    el.textContent = src;
    window.document.body.appendChild(el);
  });
  const asked = [];
  window.CEYLON_MAPS_KEY = 'test-key';
  window.CH_MAP = {
    suggest: (q) => {
      asked.push(q);
      return Promise.resolve(GOOGLE[q] || []);
    },
  };
  const input = window.document.getElementById('p');
  window.attachLocalPlaceAutocomplete(input);
  return { window, input, asked };
}

// The menu paints synchronously for local rows and again when the Google promise
// settles, so one microtask drain is enough — no timers involved.
async function type(window, input, value) {
  input.focus();
  input.value = value;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  const menu = window.document.querySelector('.place-menu');
  const rows = [...(menu ? menu.querySelectorAll('.place-option:not(.loading)') : [])];
  return rows.map((r) => ({
    label: r.querySelector('span').textContent,
    badge: r.querySelector('small').textContent,
    el: r,
  }));
}

describe('the picker collapses a Google row onto the catalogue place it duplicates', () => {
  it('offers "Sigiriya" once, as the row that carries the id', async () => {
    const { window, input } = mountPicker();
    const rows = await type(window, input, 'Sigiriya');
    const labels = rows.map((r) => r.label);

    expect(labels).toContain('Sigiriya / Dambulla');
    expect(labels).not.toContain('Sigiriya, Sri Lanka');
    expect(labels.filter((l) => l === 'Sigiriya / Dambulla')).toHaveLength(1);
  });

  it('keeps the surviving row bound to the catalogue id', async () => {
    const { window, input } = mountPicker();
    const rows = await type(window, input, 'Sigiriya');
    rows.find((r) => r.label === 'Sigiriya / Dambulla').el.click();

    expect(input.value).toBe('Sigiriya / Dambulla');
    expect(input.dataset.placeId).toBe('sigiriya');
  });

  it('does the same for Colombo Airport, the other compound-named place', async () => {
    const { window, input } = mountPicker();
    const labels = (await type(window, input, 'Colombo Airport')).map((r) => r.label);

    expect(labels).toContain('Colombo Airport (CMB)');
    expect(labels).not.toContain('Colombo Airport, Sri Lanka');
  });
});

describe('collapsing the duplicate does not wall off Google', () => {
  it('still asks Google for the query', async () => {
    const { window, input, asked } = mountPicker();
    await type(window, input, 'Sigiriya');
    expect(asked).toContain('Sigiriya');
  });

  it('still offers hotels and landmarks that merely contain the place name', async () => {
    const { window, input } = mountPicker();
    const labels = (await type(window, input, 'Sigiriya')).map((r) => r.label);

    expect(labels).toContain('Sigiriya Village Hotel, Kandalama Road, Sri Lanka');
    expect(labels).toContain('Sigiriya Rock, Sri Lanka');
  });

  it('never drops a Google row whose catalogue twin is not on screen', async () => {
    const { window, input } = mountPicker();
    const labels = (await type(window, input, 'Colombo Airport')).map((r) => r.label);
    expect(labels).toContain('Colombo Airport Garden Hotel, Sri Lanka');
  });
});
