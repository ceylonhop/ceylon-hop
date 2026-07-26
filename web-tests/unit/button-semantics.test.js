import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The rule (docs/button-system-review.md):
//   tomato (btn-cta)  = the money action. One per page, max.
//   teal   (btn-primary) = the primary forward action in a flow.
//   ghost / light = secondary, chosen by BACKGROUND, never by importance.
//
// Before this was enforced, following a customer through plan -> booking made the
// forward button flip tomato -> teal -> tomato: same funnel, same action, three
// colour changes. These tests pin the cases that were actually wrong.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => readFileSync(path.join(root, f), 'utf8');

/** The full class attribute of the element carrying `id="..."`. */
function classesForId(file, id) {
  const src = read(file);
  const m = src.match(new RegExp(`<[^>]*\\bid="${id}"[^>]*>`)) || src.match(new RegExp(`<[^>]*class="([^"]*)"[^>]*\\bid="${id}"`));
  if (!m) throw new Error(`#${id} not found in ${file}`);
  const cls = m[0].match(/class="([^"]*)"/);
  return cls ? cls[1] : '';
}

describe('forward actions in the booking funnel are teal, not tomato', () => {
  const forward = [
    ['plan.html', 'request-btn', 'Next: add your dates'],
    ['plan.html', 'dates-continue', 'Continue to select service'],
  ];

  for (const [file, id, label] of forward) {
    it(`${label} (${file}#${id}) uses btn-primary`, () => {
      const cls = classesForId(file, id);
      expect(cls, `${label} should be a teal forward action`).toContain('btn-primary');
      expect(cls, `${label} must not be tomato — tomato is reserved for the money action`).not.toContain('btn-cta');
    });
  }

  it('tour.html "Customise this route" is navigation, so not tomato', () => {
    const cls = classesForId('tour.html', 'bk-edit');
    expect(cls).toContain('btn-primary');
    expect(cls).not.toContain('btn-cta');
  });
});

describe('tomato is reserved for the money action', () => {
  it('the homepage hero booker keeps it', () => {
    expect(read('index.html')).toMatch(/class="btn btn-cta book-go"/);
  });

  it('booking.html keeps exactly one tomato button (the payment step)', () => {
    const matches = read('booking.html').match(/class="btn btn-cta[^"]*"/g) || [];
    expect(matches.length, `expected 1 tomato button, found ${matches.length}`).toBe(1);
  });
});

describe('the same action does not get two different buttons', () => {
  // why.html had "Get a fixed price" twice, both pointing at index.html#book — one
  // tomato, one white — because the dark band was choosing the colour instead of the
  // action. That inversion is the root cause the review calls out.
  it('both "Get a fixed price" buttons in why.html match', () => {
    const src = read('why.html');
    const variants = [...src.matchAll(/class="btn (btn-[a-z]+)[^"]*"[^>]*>Get a fixed price/g)]
      .map((m) => m[1]);
    const alt = [...src.matchAll(/<a[^>]*href="index\.html#book"[^>]*class="btn (btn-[a-z]+)/g)]
      .map((m) => m[1]);
    const all = [...new Set([...variants, ...alt])];
    expect(all.length, `found mixed variants: ${all.join(', ')}`).toBe(1);
    expect(all[0]).toBe('btn-cta');
  });
});

describe('dead and orphan variants', () => {
  it('btn-ink is gone from site.css', () => {
    expect(read('site.css')).not.toMatch(/\.btn-ink\b/);
  });

  it('--blue is no longer mislabelled "primary"', () => {
    const m = read('site.css').match(/--blue:[^;]*;\s*\/\*([\s\S]*?)\*\//);
    expect(m, '--blue declaration + comment not found').toBeTruthy();
    expect(m[1]).not.toMatch(/—\s*primary/);
  });
});
