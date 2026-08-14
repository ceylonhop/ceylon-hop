// web-tests/unit/asset-versions.test.js
// Every local CSS/JS reference on the customer pages must carry ?v=<content-hash of the
// file it points at> (stamped by tools/stamp-asset-versions.mjs at the end of `npm run
// generate`). Without the stamp, GitHub Pages' CDN and the API host's read-through cache
// kept serving old bytes after a fix shipped — the 2026-08-12 sweep's mechanism #3 for
// "the fixes have not fixed things". A stale stamp here means someone edited an asset
// without re-running `npm run generate`.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SKIP_DIRS = new Set(['api', 'docs', 'tools', 'web-tests', 'img', 'node_modules', '.git', '.github', '.claude']);

function pageFiles() {
  const out = [];
  for (const entry of readdirSync(ROOT)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
    const full = path.join(ROOT, entry);
    const st = statSync(full);
    if (st.isFile() && entry.endsWith('.html')) out.push(full);
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

const hashFor = (file) => createHash('sha1').update(readFileSync(file)).digest('hex').slice(0, 10);

// Same shape the stamper matches, but with the ?v= part captured separately so we can
// tell "missing" apart from "stale".
const REF = /\b(?:href|src)="((?!https?:|\/\/)[\w@./-]+\.(?:css|js))(\?v=([\w]+))?"/g;

describe('local CSS/JS references carry a current content-hash stamp', () => {
  const pages = pageFiles();

  it('finds the customer pages at all (guards the scan itself)', () => {
    expect(pages.length).toBeGreaterThan(50);
  });

  for (const page of pages) {
    const rel = path.relative(ROOT, page);
    const refs = [...readFileSync(page, 'utf8').matchAll(REF)]
      .map((m) => ({ ref: m[1], stamp: m[3] }))
      .filter((r) => existsSync(path.resolve(path.dirname(page), r.ref)));
    if (refs.length === 0) continue; // redirect stubs and asset-free pages
    it(`${rel} (${refs.length} refs)`, () => {
      for (const { ref, stamp } of refs) {
        const want = hashFor(path.resolve(path.dirname(page), ref));
        expect(stamp, `${rel}: ${ref} should carry ?v=${want} — run \`npm run generate\``).toBe(want);
      }
    });
  }
});
