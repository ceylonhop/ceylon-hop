import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
  The share/pay/quote OG cards are SVG rasterised by @resvg/resvg-js with
  loadSystemFonts:false. That means:

    · a font-family string that matches no BUNDLED face renders blank glyphs —
      there is nothing to fall back to, and nothing throws; and
    · a single missing GLYPH blanks its whole text run.

  Both failure modes are silent and only visible in a WhatsApp unfurl, which is
  exactly where nobody looks. Two near-misses during the Bodoni/Poppins swap:
  Google's static Bodoni Moda calls itself "Bodoni Moda 11pt" (plain "Bodoni Moda"
  would have rendered nothing), and Poppins has no '→' where Hanken Grotesk did.

  So this reads the real TTF name tables and asserts the renderers agree with them.
*/

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FONT_DIR = path.join(root, 'api/assets/fonts');
const RENDERERS = ['shareCardImage', 'quoteCard', 'payCard'].map((n) =>
  path.join(root, 'api/src/routes', `${n}.ts`),
);

/** Read family names (nameID 1 and 16) out of a TTF's `name` table. */
function familyNames(file) {
  const d = readFileSync(file);
  const numTables = d.readUInt16BE(4);
  let off = null;
  for (let i = 0; i < numTables; i++) {
    const e = 12 + i * 16;
    if (d.subarray(e, e + 4).toString('latin1') === 'name') off = d.readUInt32BE(e + 8);
  }
  if (off === null) throw new Error(`no name table in ${file}`);
  const count = d.readUInt16BE(off + 2);
  const stringOffset = d.readUInt16BE(off + 4);
  const out = new Set();
  for (let i = 0; i < count; i++) {
    const r = off + 6 + i * 12;
    const platformId = d.readUInt16BE(r);
    const nameId = d.readUInt16BE(r + 6);
    const len = d.readUInt16BE(r + 8);
    const o = d.readUInt16BE(r + 10);
    if (nameId !== 1 && nameId !== 16) continue;
    // Windows (platform 3) records are UTF-16BE; Mac (platform 1) are single-byte.
    const raw = d.subarray(off + stringOffset + o, off + stringOffset + o + len);
    out.add(platformId === 3 ? Buffer.from(raw).swap16().toString('utf16le') : raw.toString('latin1'));
  }
  return out;
}

/** Every character the font can actually draw, from its cmap. */
function codepoints(file) {
  const d = readFileSync(file);
  const numTables = d.readUInt16BE(4);
  let off = null;
  for (let i = 0; i < numTables; i++) {
    const e = 12 + i * 16;
    if (d.subarray(e, e + 4).toString('latin1') === 'cmap') off = d.readUInt32BE(e + 8);
  }
  if (off === null) return new Set();
  const n = d.readUInt16BE(off + 2);
  const chars = new Set();
  for (let i = 0; i < n; i++) {
    const rec = off + 4 + i * 8;
    const sub = off + d.readUInt32BE(rec + 4);
    const format = d.readUInt16BE(sub);
    if (format === 4) {
      const segX2 = d.readUInt16BE(sub + 6);
      const seg = segX2 / 2;
      for (let s = 0; s < seg; s++) {
        const end = d.readUInt16BE(sub + 14 + s * 2);
        const start = d.readUInt16BE(sub + 16 + segX2 + s * 2);
        if (start === 0xffff) continue;
        for (let c = start; c <= Math.min(end, 0xffff); c++) chars.add(c);
      }
    } else if (format === 12) {
      const groups = d.readUInt32BE(sub + 12);
      for (let g = 0; g < groups; g++) {
        const b = sub + 16 + g * 12;
        const start = d.readUInt32BE(b);
        const end = d.readUInt32BE(b + 4);
        for (let c = start; c <= end; c++) chars.add(c);
      }
    }
  }
  return chars;
}

const fontFiles = readdirSync(FONT_DIR).filter((f) => f.endsWith('.ttf'));
const bundledFamilies = new Set(fontFiles.flatMap((f) => [...familyNames(path.join(FONT_DIR, f))]));

describe('rasterised card fonts', () => {
  it('bundles at least one face', () => {
    expect(fontFiles.length).toBeGreaterThan(0);
  });

  // The two constants the renderers pass to font-family.
  const src = readFileSync(path.join(root, 'api/src/routes/shareCardImage.ts'), 'utf8');
  const declared = [...src.matchAll(/export const (?:DISPLAY|BODY) = '([^']+)'/g)].map((m) => m[1]);

  it('declares both DISPLAY and BODY', () => {
    expect(declared).toHaveLength(2);
  });

  for (const family of declared) {
    it(`"${family}" matches a bundled TTF family name`, () => {
      expect(
        bundledFamilies.has(family),
        `"${family}" is not a family in ${FONT_DIR}. Bundled: ${[...bundledFamilies].join(', ')}`,
      ).toBe(true);
    });
  }

  // No renderer may emit a font-family that isn't one of the two constants —
  // a hardcoded string is how the old Newsreader/Hanken names survived a swap.
  for (const file of RENDERERS) {
    it(`${path.basename(file)} names fonts only via DISPLAY/BODY`, () => {
      const s = readFileSync(file, 'utf8');
      const literals = [...s.matchAll(/font-family="([^"$][^"]*)"/g)].map((m) => m[1]);
      expect(literals, `hardcoded font-family in ${path.basename(file)}`).toEqual([]);
    });
  }

  // '→' is the glyph that has bitten this code twice. If no bundled face has it,
  // no renderer may emit one literally — it must be deArrow'd or drawn as a path.
  it('no renderer emits a glyph none of the bundled faces can draw', () => {
    const covered = fontFiles.map((f) => codepoints(path.join(FONT_DIR, f)));
    const anyHas = (ch) => covered.some((set) => set.has(ch.codePointAt(0)));
    for (const file of RENDERERS) {
      const s = readFileSync(file, 'utf8');
      // Text nodes only — comments and paths are not rendered as type.
      const textContent = [...s.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((m) => m[1]).join('');
      for (const ch of ['→', '←', '↔']) {
        if (anyHas(ch)) continue;
        expect(
          textContent.includes(ch),
          `${path.basename(file)} renders "${ch}" as type, but no bundled face has that glyph`,
        ).toBe(false);
      }
    }
  });
});
