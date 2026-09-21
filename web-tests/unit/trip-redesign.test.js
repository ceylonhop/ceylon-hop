import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { ROOT, generateAll } from '../../tools/generate-route-pages.mjs';

/* The /trip/ page redesign (docs/superpowers/specs/2026-09-21-trip-pages-redesign-design.md).
   The page now LEADS with a photo of where you're going and a bookable price, instead of
   opening on a paper postcard and making the reader scroll to two grey option cards.

   Everything asserted here is STATIC markup, for the same reason route-page-unified.test.js
   is: these pages exist to be indexed, so a crawler must see the photo, both fares and the
   CTA with no JavaScript at all. */

// trip/ on disk also holds ~25 hand-built legacy directories (redirect stubs, old tour slugs), so
// enumerate the GENERATED route pages the way route-page-unified.test.js does — never readdir.
const slugs = [...generateAll().keys()].map(k => (k.match(/^trip\/(.+-to-.+)\/index\.html$/) || [])[1]).filter(Boolean);
const dom = slug => new JSDOM(readFileSync(join(ROOT, 'trip', slug, 'index.html'), 'utf8')).window.document;
const SHARED = slugs.filter(s => dom(s).querySelector('[data-shared-cta]'));
const PRIVATE_ONLY = slugs.filter(s => !SHARED.includes(s));

describe('trip page — leads with a photo and a bookable price', () => {
  it.each(slugs)('%s: hero photo is a real, sized, eager <img> whose file exists', (slug) => {
    const img = dom(slug).querySelector('.route-hero img.hero-img');
    expect(img).toBeTruthy();
    expect(img.getAttribute('alt')).toBeTruthy();
    expect(img.getAttribute('width')).toBeTruthy();
    expect(img.getAttribute('height')).toBeTruthy();
    expect(img.getAttribute('fetchpriority')).toBe('high');
    expect(existsSync(join(ROOT, 'trip', slug, img.getAttribute('src')))).toBe(true);
  });
  it.each(slugs)('%s: exactly one eager image', (slug) => {
    const imgs = [...dom(slug).querySelectorAll('main img')];
    expect(imgs.filter(i => i.getAttribute('loading') !== 'lazy')).toHaveLength(1);
  });
  it.each(slugs)('%s: fares card sits inside the hero with two radios, both fares and the CTA', (slug) => {
    const card = dom(slug).querySelector('.route-hero article.opt-private[data-live-fares]');
    expect(card).toBeTruthy();
    const radios = [...card.querySelectorAll('input[type=radio][name=vehicle]')];
    expect(radios.map(r => r.value)).toEqual(['car', 'van']);
    expect(radios[0].hasAttribute('checked')).toBe(true);
    expect(card.querySelector('[data-fare=car]').textContent).toMatch(/^\$\d/);
    expect(card.querySelector('[data-fare=van]').textContent).toMatch(/^\$\d/);
    for (const k of ['data-cat-car', 'data-cat-van', 'data-raw-car', 'data-raw-van']) expect(Number(card.getAttribute(k))).toBeGreaterThan(0);
    const href = card.querySelector('a.opt-cta').getAttribute('href');
    expect(href).toContain('booking.html?');
    expect(href).toContain('vehicle=car');
  });
  it.each(slugs)('%s: no WhatsApp button in the hero; one in the FAQ', (slug) => {
    const d = dom(slug);
    expect(d.querySelector('.route-hero a[href*="wa.me"]')).toBeNull();
    expect(d.querySelector('.faq a[href*="wa.me"]')).toBeTruthy();
  });
  it.each(slugs)('%s: trust strip states the four claims and not the Wed/Sat one', (slug) => {
    const t = dom(slug).querySelector('.trip-trust').textContent;
    for (const s of ['Fully insured', 'AC cars', 'Free cancellation 24h before', 'WhatsApp support 7 days']) expect(t).toContain(s);
    expect(t).not.toMatch(/Wed/);
  });
  it.each(slugs)('%s: the sticky book bar ships hidden, priced and linked', (slug) => {
    const bar = dom(slug).querySelector('.trip-bookbar');
    expect(bar).toBeTruthy();
    expect(bar.hasAttribute('hidden')).toBe(true);
    expect(bar.querySelector('[data-bar-label]')).toBeTruthy();
    expect(bar.querySelector('span[data-fare=car]').textContent).toMatch(/^\$\d/);
    expect(bar.querySelector('a.bar-cta').getAttribute('href')).toContain('booking.html?');
  });
});

describe('trip page — shared ride is a section or a sentence, never a grey card', () => {
  it.each(PRIVATE_ONLY)('%s: says so in one line with a board link', (slug) => {
    const d = dom(slug);
    expect(d.querySelector('.opt-none')).toBeNull();
    const note = d.querySelector('p.no-share');
    expect(note.textContent).toMatch(/^No shared van runs /);
    expect(note.querySelector('a[href*="board.html?from="]')).toBeTruthy();
    expect(d.querySelector('#share')).toBeNull();
  });
  it.each(SHARED)('%s: #share states seat price and every boarding time statically, and the card links to it', (slug) => {
    const d = dom(slug);
    const s = d.querySelector('section#share');
    expect(s.querySelector('.seat-price b').textContent).toMatch(/^\$\d/);
    expect(s.querySelectorAll('.pickups li').length).toBeGreaterThan(0);
    expect(s.querySelector('[data-shared-cta] a.opt-cta')).toBeTruthy();
    expect(d.querySelector('.route-hero a.share-strip[href="#share"]')).toBeTruthy();
  });
});
