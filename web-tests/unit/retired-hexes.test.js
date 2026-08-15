// web-tests/unit/retired-hexes.test.js
// No customer-facing file may use a retired pre-rebrand colour. #441 swept these out of
// the site, but the sweep was grep-driven and missed whole files — credits.html shipped
// the old teal hero for another month because nothing scanned it (fixed in #455). This
// test scans EVERY customer-facing HTML/CSS/JS file, so a future page can't be missed
// the same way. Comments are stripped first: a comment can't paint, and index.html
// documents the old CTA hex on purpose.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SKIP_DIRS = new Set(['api', 'docs', 'tools', 'web-tests', 'img', 'node_modules', '.git', '.github', '.claude']);
// Ops-internal surfaces are not customer-facing; board.* is the ops ride board.
const SKIP_FILES = new Set(['_ops-preview.html', 'board.html', 'board.js', 'serve-booking.js']);

// The pre-rebrand palette, from PR #441's diff plus the 2026-08-12 sweep. Every entry
// has zero legitimate occurrences in customer files; if one reappears, either a page
// was hand-edited back or a generator fallback regressed — both are bugs.
const RETIRED = [
  '#0d8f8c', '#2aa9bf',             // old teal-green hero gradient (credits.html was the last carrier)
  '#0a9d9a', '#0f8a80', '#39d6d0', '#7fe3df', // old teal family
  '#0a7d6f',                         // old deep teal (tour.html gcue was the last carrier)
  '#3a9fc0', '#2d7e93',             // old blues (site.css .pill-blue was the last carrier)
  '#12312e', '#2C2A2B', '#0c3a38',  // old inks
  '#4a5a57', '#5a6b68',             // old greenish ink-softs (generator fallbacks)
  '#f6f3ec', '#e7e2d8',             // old cream-deep / line (generator fallbacks)
  '#e8623a', '#f6543b',             // old CTA oranges
  '#25D366',                        // raw WhatsApp green under white glyphs (site.css:250's fix; low-alpha
                                    // 8-digit tints like #25d3660d are deliberate and excluded by the
                                    // boundary check below)
];

function customerFiles() {
  const out = [];
  const wanted = (f) => /\.(html|css|js)$/.test(f) && !SKIP_FILES.has(path.basename(f));
  for (const entry of readdirSync(ROOT)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
    const full = path.join(ROOT, entry);
    const st = statSync(full);
    if (st.isFile() && wanted(entry)) out.push(full);
    if (st.isDirectory()) {
      const idx = path.join(full, 'index.html');
      if (existsSync(idx)) out.push(idx);
      for (const sub of readdirSync(full)) {
        const subIdx = path.join(full, sub, 'index.html');
        if (existsSync(subIdx)) out.push(subIdx);
      }
    }
  }
  return out;
}

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');

describe('no customer-facing file uses a retired pre-rebrand colour', () => {
  const files = customerFiles();

  it('finds the customer files at all (guards the scan itself)', () => {
    expect(files.length).toBeGreaterThan(80);
  });

  for (const file of files) {
    const rel = path.relative(ROOT, file);
    it(rel, () => {
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const hex of RETIRED) {
        // Boundary check: '#25d366' must not match the 8-digit tint '#25d3660d'.
        const re = new RegExp(hex.replace('#', '#') + '(?![0-9a-fA-F])', 'i');
        const m = src.match(re);
        expect(m, `${rel} uses retired ${hex} — see the 2026-08-12 sweep / #441`).toBeNull();
      }
    });
  }
});
