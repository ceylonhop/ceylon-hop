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

/* The BODY of the page (task B2): the drive, what's included + the proof row, the FAQ as a
   native accordion, and the where-next cards. Same rule as above — all of it static. */
describe('trip page — body', () => {
  it.each(slugs)('%s: the drive is a route line from origin to destination with every highlight between', (slug) => {
    const d = dom(slug);
    const stops = [...d.querySelectorAll('.drive ol.stops > li')];
    expect(stops.length).toBeGreaterThanOrEqual(3);
    expect(stops[0].classList.contains('end')).toBe(true);
    expect(stops[stops.length - 1].classList.contains('end')).toBe(true);
    expect(d.querySelector('.drive h2').textContent.trim().length).toBeGreaterThan(0);
    const photo = d.querySelector('.drive figure img');
    expect(photo.getAttribute('loading')).toBe('lazy');
    expect(photo.getAttribute('src')).not.toBe(d.querySelector('img.hero-img').getAttribute('src'));
    expect(existsSync(join(ROOT, 'trip', slug, photo.getAttribute('src')))).toBe(true);
  });

  // Only the two pairs the prototype mocked get a written title; the other 42 pages use the
  // fallback rather than 44 hand-written headings nobody would keep current. The reverse
  // direction of a titled pair falls back too — the title describes the drive one way round.
  it('the two mocked pairs carry their own drive title; everything else uses the fallback', () => {
    expect(dom('kandy-to-ella').querySelector('.drive h2').textContent.trim()).toBe('Tea, waterfalls and hairpins');
    expect(dom('cmb-airport-to-sigiriya').querySelector('.drive h2').textContent.trim()).toBe('Coconut country to the rock');
    expect(dom('ella-to-kandy').querySelector('.drive h2').textContent.trim()).toBe('The road from Ella to Kandy');
    expect(dom('sigiriya-to-cmb-airport').querySelector('.drive h2').textContent.trim())
      .toBe('The road from Sigiriya / Dambulla to Colombo Airport (CMB)');
  });

  it.each(slugs)('%s: FAQ is a native accordion whose text equals the JSON-LD', (slug) => {
    const d = dom(slug);
    const items = [...d.querySelectorAll('.faq details')];
    expect(items.length).toBeGreaterThanOrEqual(4);
    expect(items[0].hasAttribute('open')).toBe(true);
    const ld = [...d.querySelectorAll('script[type="application/ld+json"]')].map(s => JSON.parse(s.textContent)).find(j => j['@type'] === 'FAQPage');
    expect(items.map(i => i.querySelector('summary').textContent.trim())).toEqual(ld.mainEntity.map(q => q.name));
    expect(d.querySelectorAll('.faq [data-fare]').length).toBe(2);
  });

  // The two questions the old WordPress pages ranked for keep their words; only the three
  // generic ones were shortened. seo-legacy-keywords.test.js polices the shared-taxi one.
  it.each(slugs)('%s: the keyword-bearing questions keep their place names', (slug) => {
    const d = dom(slug);
    const card = d.querySelector('[data-live-fares]');
    const from = card.getAttribute('data-from-name'), to = card.getAttribute('data-to-name');
    const qs = [...d.querySelectorAll('.faq details summary')].map(s => s.textContent.trim());
    expect(qs).toContain(`How much is a taxi from ${from} to ${to}?`);
    expect(qs.some(q => /shared taxi/i.test(q) && q.includes(from) && q.includes(to))).toBe(true);
    expect(qs).toContain('How long does the drive take?');
    expect(qs).toContain('How do I book?');
  });

  it.each(slugs)('%s: review count comes from ta-data.js, never a literal', (slug) => {
    const src = readFileSync(join(ROOT, 'tools/generate-route-pages.mjs'), 'utf8');
    expect(src).not.toMatch(/\b31 reviews\b/);
    expect(dom(slug).querySelector('.proof [data-ta-reviews]')).toBeTruthy();
  });

  // The quote is the homepage's, word for word — a second, softer version of the founder's
  // words would be a different claim wearing the same name.
  it.each(slugs)('%s: the proof row quotes the founder and shows his photo', (slug) => {
    const proof = dom(slug).querySelector('.proof');
    expect(proof.querySelector('blockquote').textContent)
      .toContain('Every guest rides with a driver we’d trust with our own family.');
    expect(proof.querySelector('cite').textContent).toMatch(/Roshen\s+—\s+Co-founder, Ceylon ?Hop/);
    const img = proof.querySelector('img');
    expect(img.getAttribute('src')).toMatch(/team-roshen\.jpg$/);
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(Number(img.getAttribute('width'))).toBeGreaterThan(0);
    expect(Number(img.getAttribute('height'))).toBeGreaterThan(0);
  });

  it.each(slugs)('%s: what’s included states four claims and never a meet-and-greet', (slug) => {
    const inc = dom(slug).querySelector('.included');
    expect(inc.querySelectorAll('h3').length).toBe(4);
    for (const claim of ['A fixed price', 'Door to door', 'Stops when you want', 'Free cancellation']) {
      expect(inc.textContent).toContain(claim);
    }
    expect(inc.textContent).not.toMatch(/meet[- ]and[- ]greet|name board|sign with your name/i);
  });

  it.each(slugs)('%s: where-next cards carry photos, list-fare hooks and a Return trip label on the reverse', (slug) => {
    const d = dom(slug);
    const cards = [...d.querySelectorAll('.next a.rt-card')];
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) {
      expect(c.querySelector('img[loading=lazy]')).toBeTruthy();
      const f = c.querySelector('[data-list-fare]');
      expect(f.getAttribute('data-from-name')).toBeTruthy();
      expect(f.getAttribute('data-to-name')).toBeTruthy();
    }
    const [a, b] = slug.split('-to-');
    const rev = cards.find(c => c.getAttribute('href').includes(`/${b}-to-${a}/`));
    if (rev) expect(rev.querySelector('.rt-ret').textContent).toBe('Return trip');
  });

  // The grid and the card must not share a class: on the sibling /trip/ index the two did,
  // so the container's `gap` applied INSIDE each card and pushed its text off the photo.
  it.each(slugs)('%s: the card grid and the cards are different elements', (slug) => {
    const d = dom(slug);
    expect(d.querySelector('.next').classList.contains('rt-card')).toBe(false);
    for (const c of d.querySelectorAll('.next a.rt-card')) expect(c.classList.contains('next')).toBe(false);
  });

  it.each(slugs)('%s: the markup it replaces is gone, not left behind', (slug) => {
    const html = readFileSync(join(ROOT, 'trip', slug, 'index.html'), 'utf8');
    for (const dead of ['route-body', 'faq-q', 'rt-grid', 'route-hl']) expect(html, dead).not.toContain(dead);
  });
});

/* The hero line used to be "first sentence of the intro if it fits, else a template naming
   both places". Both halves read badly on the shipped page: the template repeated the two
   place names already in the h1 directly above it, and where the first sentence WAS used it
   turned up again word for word as the opening of the body copy one screen below. So the
   fallback names no place, the first sentence is only borrowed when it reads as a standalone
   line, and when it is borrowed the body starts from the second sentence. */
const FALLBACK_PITCH = 'Your own air-conditioned car or van, door to door, at a fixed price.';
const squash = s => s.replace(/\s+/g, ' ').trim();

describe('trip page — the hero line never repeats the page', () => {
  it('has pages of both kinds, or the two rules below prove nothing', () => {
    const lines = slugs.map(s => squash(dom(s).querySelector('.hero-sub').textContent));
    expect(lines.filter(l => l === FALLBACK_PITCH).length).toBeGreaterThan(0);
    expect(lines.filter(l => l !== FALLBACK_PITCH).length).toBeGreaterThan(0);
  });

  it.each(slugs)('%s: the fallback line names neither place, and no line is a fragment', (slug) => {
    const d = dom(slug);
    const line = squash(d.querySelector('.hero-sub').textContent);
    expect(line.length).toBeGreaterThanOrEqual(40);
    if (line !== FALLBACK_PITCH) return;
    const card = d.querySelector('[data-live-fares]');
    expect(line).not.toContain(card.getAttribute('data-from-name'));
    expect(line).not.toContain(card.getAttribute('data-to-name'));
  });

  it.each(slugs)('%s: the hero line is not repeated verbatim in the drive section', (slug) => {
    const d = dom(slug);
    const line = squash(d.querySelector('.hero-sub').textContent);
    expect(squash(d.querySelector('.drive').textContent)).not.toContain(line);
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
