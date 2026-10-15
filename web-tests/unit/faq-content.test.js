// The travel FAQ's JSON must be internally consistent, name photos that exist at both sizes with
// the dimensions it declares, credit every photographer, and never type a Ceylon Hop fare by hand
// (spec docs/superpowers/specs/2026-10-14-sri-lanka-travel-faq-design.md §4, §5, §6).
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Real pixel size from a JPEG's SOF marker — same reader as guide-content.test.js (no sips: CI is Linux). */
function jpegSize(file) {
  const buf = readFileSync(file);
  let offset = 2;
  while (offset < buf.length) {
    if (buf[offset] !== 0xff) throw new Error(`bad JPEG marker at ${offset} in ${file}`);
    const marker = buf[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const len = buf.readUInt16BE(offset + 2);
    const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    offset += 2 + len;
  }
  throw new Error(`no SOF marker found in ${file}`);
}

const FILE = path.join(ROOT, 'tools/faq/sri-lanka.json');
const f = JSON.parse(readFileSync(FILE, 'utf8'));
const raw = readFileSync(FILE, 'utf8');
const FARE_LITERAL = /\bUSD\s?\d+\.(?:49|99)\b/;
const ORDER = ['visa', 'before', 'money', 'around', 'start', 'safaris', 'beaches', 'culture', 'food', 'health'];

describe('tools/faq/sri-lanka.json', () => {
  it('has the page basics', () => {
    expect(f.slug).toBe('sri-lanka-travel-faq');
    expect(f.title.length).toBeLessThanOrEqual(60);
    expect(f.description.length).toBeLessThanOrEqual(158);
    expect(f.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(f.hero.photo).toBe('hero');
    expect(f.lede).toBeTruthy();
    expect(f.ask.wa).toMatch(/^Hi Ceylon Hop/);
  });
  it('lists the ten topics in trip-timeline order, each with a name, sub and shape', () => {
    expect(f.topics.map(t => t.id)).toEqual(ORDER);
    for (const t of f.topics) {
      expect(t.name, t.id).toBeTruthy();
      expect(t.sub, t.id).toBeTruthy();
      expect(['qa', 'compare'], t.id).toContain(t.shape);
      if (t.shape === 'qa') expect(t.items.length, t.id).toBeGreaterThan(0);
      else { expect(t.photo, t.id).toBeTruthy(); expect(t.pick.items.length, t.id).toBeGreaterThan(0); expect(t.cards.length, t.id).toBeGreaterThan(1); }
    }
  });
  it('every anchor id is unique and url-safe', () => {
    const ids = [];
    for (const t of f.topics) {
      ids.push(t.id);
      for (const q of t.items || []) ids.push(`${t.id}-${q.id}`);
    }
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('callouts are only "tip" or "know"; checked dates are ISO; offers carry a target', () => {
    for (const t of f.topics) {
      for (const q of t.items || []) {
        if (q.tip) { expect(['tip', 'know'], `${t.id}-${q.id}`).toContain(q.tip.kind); expect(q.tip.text).toBeTruthy(); }
        if (q.checked) { expect(q.checked.what).toBeTruthy(); expect(q.checked.date).toMatch(/^\d{4}-\d{2}-\d{2}$/); }
        if (q.offer) { expect(q.offer.title && q.offer.sub && q.offer.label).toBeTruthy(); expect(!!q.offer.href !== !!q.offer.wa, 'href xor wa').toBe(true); }
      }
      if (t.checked) expect(t.checked.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
  it('never types a Ceylon Hop fare by hand — fares are {fare:…} tokens', () => {
    expect(raw).not.toMatch(FARE_LITERAL);
    const tokens = raw.match(/\{fare:[^}]*\}/g) || [];
    expect(tokens.length).toBeGreaterThan(0);
    for (const tk of tokens) expect(tk).toMatch(/^\{fare:[a-z0-9-]+:[a-z0-9-]+:(?:shared|private)\}$/);
  });
  it('names only photos it declares, at both sizes, with the real pixel size — and no tuk-tuks or motorcycles', () => {
    const used = new Set([f.hero.photo, ...f.topics.filter(t => t.photo).map(t => t.photo)]);
    for (const k of used) expect(f.photos[k], `photos.${k}`).toBeTruthy();
    for (const [k, meta] of Object.entries(f.photos)) {
      for (const size of [900, 1800]) expect(existsSync(path.join(ROOT, 'img/faq', `${k}-${size}.jpg`)), `${k}-${size}`).toBe(true);
      const { width, height } = jpegSize(path.join(ROOT, 'img/faq', `${k}-1800.jpg`));
      expect([width, height], k).toEqual([meta.w, meta.h]);
      expect(meta.alt, `${k}.alt`).toBeTruthy();
      expect(meta.alt.toLowerCase()).not.toMatch(/tuk|motorcycle|motorbike/);
      expect(meta.credit, `${k}.credit`).toBeTruthy();
      expect(meta.creditUrl).toMatch(/^https:\/\/unsplash\.com\//);
      expect(meta.photoUrl).toMatch(/^https:\/\/unsplash\.com\/photos\//);
    }
    expect(existsSync(path.join(ROOT, 'img/faq/og.jpg'))).toBe(true);
    expect(jpegSize(path.join(ROOT, 'img/faq/og.jpg'))).toEqual({ width: 1200, height: 630 });
  });
  it('credits every photographer in credits.html', () => {
    const credits = readFileSync(path.join(ROOT, 'credits.html'), 'utf8');
    for (const [k, meta] of Object.entries(f.photos)) {
      expect(credits, `${k} → ${meta.credit}`).toContain(meta.creditUrl);
      expect(credits, `${k} → photo`).toContain(meta.photoUrl);
    }
  });
});
