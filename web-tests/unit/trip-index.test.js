import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { ROOT, generateAll } from '../../tools/generate-route-pages.mjs';
import { loadTransfers } from '../../tools/load-transfers.mjs';

const d = new JSDOM(readFileSync(join(ROOT, 'trip/index.html'), 'utf8')).window.document;
// trip/ on disk also holds ~25 hand-built legacy directories (redirect stubs, old tour slugs), so
// enumerate the GENERATED route pages the way route-page-unified.test.js does — never readdir.
const slugs = [...generateAll().keys()].map(k => (k.match(/^trip\/(.+-to-.+)\/index\.html$/) || [])[1]).filter(Boolean);
// Index links are written '../trip/<slug>/' today; keep whatever form the generator already uses.
const slugOf = a => (a.getAttribute('href').match(/trip\/([^/]+)\/?$/) || [])[1];

describe('/trip/ index', () => {
  it('links every generated route exactly once in the origin blocks, as a real href', () => {
    const hrefs = [...d.querySelectorAll('.origins a.dest')].map(a => slugOf(a));
    expect([...hrefs].sort()).toEqual([...slugs].sort());
  });
  it('groups each route under the place it leaves from', () => {
    for (const s of d.querySelectorAll('section.origin')) {
      const id = s.getAttribute('data-origin');
      expect(s.id).toBe(`from-${id}`);
      for (const a of s.querySelectorAll('a.dest')) expect(slugOf(a).startsWith(`${id}-to-`)).toBe(true);
      expect(s.querySelector('h2').textContent).toMatch(/^From /);
      expect(s.querySelector('img[loading=lazy]')).toBeTruthy();
    }
  });
  it('chips are anchor links that work without JS', () => {
    const chips = [...d.querySelectorAll('.fchips a')];
    expect(chips[0].getAttribute('href')).toBe('#routes');
    for (const c of chips.slice(1)) expect(d.querySelector(c.getAttribute('href'))).toBeTruthy();
  });
  it('flags a shared seat only where that route page sells one', () => {
    for (const a of d.querySelectorAll('a.dest')) {
      const slug = slugOf(a);
      const sells = readFileSync(join(ROOT, 'trip', slug, 'index.html'), 'utf8').includes('data-shared-cta');
      expect(!!a.querySelector('.sh'), slug).toBe(sells);
    }
  });
  it('every list price carries the hook and both place names', () => {
    const fares = [...d.querySelectorAll('[data-list-fare]')];
    expect(fares.length).toBeGreaterThanOrEqual(slugs.length);
    for (const f of fares) { expect(f.getAttribute('data-from-name')).toBeTruthy(); expect(f.getAttribute('data-to-name')).toBeTruthy(); expect(f.textContent).toMatch(/^\$\d/); }
  });
  it('keeps its H1 and offers a way out for unlisted routes', () => {
    expect(d.querySelector('h1').textContent.trim()).toBe('Sri Lanka transfer routes');
    expect(d.querySelector('.anywhere a[href$="search.html"]')).toBeTruthy();
    expect(d.querySelector('.anywhere a[href$="plan.html"]')).toBeTruthy();
  });

  // Added per task instructions: the hero picker is a plain no-JS form (no fourth place picker,
  // no site.js edit) that hands off to search.html the same way the rest of the site does.
  it('offers a plain no-JS way to search any two places', () => {
    const form = d.querySelector('form.ix-form');
    expect(form).toBeTruthy();
    expect(form.getAttribute('action')).toMatch(/search\.html$/);
    expect(form.getAttribute('method')).toBe('get');
    const fromInput = form.querySelector('input[name="from"]');
    const toInput = form.querySelector('input[name="to"]');
    expect(fromInput).toBeTruthy();
    expect(toInput).toBeTruthy();
    expect(fromInput.hasAttribute('required')).toBe(true);
    expect(toInput.hasAttribute('required')).toBe(true);
    expect(fromInput.getAttribute('autocomplete')).toBe('off');
    expect(toInput.getAttribute('autocomplete')).toBe('off');
    expect(d.querySelector('label[for="ix-from"]').textContent).toBe('Pick-up');
    expect(d.querySelector('label[for="ix-to"]').textContent).toBe('Drop-off');
    // One datalist, shared by both inputs, listing every catalogue place (all 19, not just the
    // 11 the /trip/ pages generate routes for).
    expect(fromInput.getAttribute('list')).toBe('ix-places');
    expect(toInput.getAttribute('list')).toBe('ix-places');
    const T = loadTransfers();
    const options = [...d.querySelectorAll('#ix-places option')];
    expect(options.length).toBe(T.PLACES.length);
    const optionValues = new Set(options.map(o => o.getAttribute('value')));
    for (const place of T.PLACES) expect(optionValues.has(place.name), place.name).toBe(true);
  });

  it('has exactly one eager (non-lazy) image in <main> — the hero photo', () => {
    const imgs = [...d.querySelectorAll('main img')];
    expect(imgs.length).toBeGreaterThan(0);
    const eager = imgs.filter(img => img.getAttribute('loading') !== 'lazy');
    expect(eager.length).toBe(1);
  });

  // F4: search.js resolves from/to by catalogue ID (T.place(id)); a typed NAME falls to the
  // engine path where shared=null, so the hero form must give trip-index.js a way to recover
  // the id behind a matched name.
  it('every datalist option carries a real catalogue place id, one per place (F4)', () => {
    const T = loadTransfers();
    const options = [...d.querySelectorAll('#ix-places option')];
    expect(options.length).toBe(T.PLACES.length);
    const seenIds = new Set();
    for (const o of options) {
      const id = o.getAttribute('data-id');
      expect(id, `option "${o.getAttribute('value')}" is missing data-id`).toBeTruthy();
      expect(Object.prototype.hasOwnProperty.call(T.byId, id), id).toBe(true);
      seenIds.add(id);
    }
    expect(seenIds.size).toBe(T.PLACES.length);
  });

  // F6 (spec §8): the "Most booked" cards must not lift on hover for a visitor who has asked
  // the OS/browser to reduce motion.
  it('disables the card hover lift under prefers-reduced-motion (F6)', () => {
    const styleText = [...d.querySelectorAll('style')].map(s => s.textContent).join('\n');
    expect(styleText).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.rt-card/);
  });
});
