import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// <image-slot>'s :host used to set a fixed `height:160px`. Call sites that size a slot with
// `width:100%;aspect-ratio:4/3.2` never override height — and an explicit height BEATS
// aspect-ratio, which only ever computes a *missing* dimension. So ~15 slots across the site
// silently collapsed to a 160px-tall letterbox and hard-cropped their photo, while
// getComputedStyle still reported the author's aspect-ratio, making it look correct in DevTools.
//
// These assert the CSS contract at source level: jsdom has no layout engine, so a rendered-height
// assertion is not possible here. The invariant is "the host must not hard-set a height that
// defeats an author aspect-ratio".

const src = readFileSync(join(__dirname, '..', '..', 'image-slot.js'), 'utf8');

// The :host rule is built by string concatenation across lines; join them back up.
const hostRule = (() => {
  const i = src.indexOf(':host{');
  const j = src.indexOf('}', i);
  return src.slice(i, j + 1).replace(/'\s*\+\s*'/g, '').replace(/\s+/g, ' ');
})();

describe('image-slot :host sizing', () => {
  it('does not hard-set a pixel height (that would defeat author aspect-ratio)', () => {
    expect(hostRule).not.toMatch(/height:\s*\d+px/);
  });

  it('lets an author aspect-ratio drive the height', () => {
    expect(hostRule).toMatch(/height:\s*auto/);
  });

  it('still gives an unstyled slot a sensible default box', () => {
    // Default must stay visually 240x160 (3/2) so slots with no author sizing are unchanged.
    expect(hostRule).toMatch(/width:\s*240px/);
    expect(hostRule).toMatch(/aspect-ratio:\s*3\s*\/\s*2/);
  });
});
