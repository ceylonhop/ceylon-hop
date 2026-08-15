import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/*
  The OG cards are rasterised server-side by resvg from a hand-built SVG string, so the brand
  mark cannot be an <img src>: it has to be the path data itself, inlined in the renderer.

  That inlining is a copy, and a copy drifts. The mark was ALREADY re-drawn by hand once — the
  pay page shipped a bespoke stroke-path "C" in a saffron square, which read as almost-right and
  was caught by the owner (2026-07-31); the cards then made the same mistake with a Bodoni "C"
  in a circle, caught again (2026-08-10). This test is the thing that makes the third time
  impossible: if img/brand-c.svg is ever redrawn, the cards fail until they are updated too.
*/

const svg = readFileSync(path.join(root, 'img/brand-c.svg'), 'utf8');
const renderer = readFileSync(path.join(root, 'api/src/routes/shareCardImage.ts'), 'utf8');

const assetPath = svg.match(/ d="([^"]+)"/)[1];
const inlined = renderer.match(/export const BRAND_MARK_PATH = '([^']+)'/)?.[1];

describe('the brand mark on the rasterised cards', () => {
  it('is inlined in the renderer', () => {
    expect(inlined, 'BRAND_MARK_PATH not found in shareCardImage.ts').toBeTruthy();
  });

  it('is byte-for-byte the path in img/brand-c.svg', () => {
    expect(inlined).toBe(assetPath);
  });

  it('is the real mark, not a hand-drawn approximation', () => {
    // The bespoke ones were short — a few dozen characters of arcs. The real glyph is thousands.
    expect(assetPath.length).toBeGreaterThan(2000);
  });

  it('the declared glyph bounds match the path the helper is scaling', () => {
    // brandMark() offsets by these numbers to put the mark where a card asks for it. If the
    // asset is redrawn within the same 1024 box, the path check above still passes while every
    // card silently misplaces the mark — so the bounds are pinned to the path too.
    const declared = renderer.match(/const MARK = \{ x: ([\d.]+), y: ([\d.]+), w: ([\d.]+), h: ([\d.]+) \}/);
    expect(declared, 'MARK bounds not found in shareCardImage.ts').toBeTruthy();
    const [, x, y, w, h] = declared.map(Number);

    // All commands in this path are absolute (M/C/L/Z), so every number pair is a point.
    const nums = assetPath.match(/-?\d*\.?\d+/g).map(Number);
    const xs = [];
    const ys = [];
    for (let i = 0; i + 1 < nums.length; i += 2) { xs.push(nums[i]); ys.push(nums[i + 1]); }

    expect(Math.min(...xs)).toBeCloseTo(x, 0);
    expect(Math.min(...ys)).toBeCloseTo(y, 0);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(w, 0);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(h, 0);
  });
});
