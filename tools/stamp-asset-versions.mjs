// Stamp ?v=<content-hash> onto every local CSS/JS reference in the customer pages.
//
// Why: nothing on the site was cache-busted — 68 bare `site.css` links behind GitHub
// Pages' CDN (and the API host's read-through cache for pay/quote/manage) meant a
// shipped fix looked unshipped until edge + browser caches expired, then silently
// corrected. That is the 2026-08-12 sweep's mechanism #3 for "the fixes have not
// fixed things". A content hash in the query string makes every deploy of an asset
// a new URL, so caches can be told to keep files forever and still never serve a
// stale byte after a change.
//
// Runs at the END of `npm run generate` (see package.json), so the stamps are part
// of the codegen contract: edit site.css without regenerating and the freshness
// checks fail with a diff instead of shipping stale stamps. Idempotent — existing
// ?v= values are replaced, and a run with no asset changes rewrites nothing.
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Directories at the repo root that are not customer pages. Everything else with an
// index.html (blog posts, legacy redirect stubs, trip/) is fair game — stubs simply
// contain no asset references and pass through untouched.
const SKIP_DIRS = new Set(['api', 'docs', 'tools', 'web-tests', 'img', 'node_modules', '.git', '.github', '.claude']);

function pageFiles() {
  const out = [];
  for (const entry of readdirSync(ROOT)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
    const full = join(ROOT, entry);
    const st = statSync(full);
    if (st.isFile() && entry.endsWith('.html')) out.push(full);
    if (st.isDirectory()) {
      const idx = join(full, 'index.html');
      if (existsSync(idx)) out.push(idx);
      // one more level: trip/<slug>/index.html
      for (const sub of readdirSync(full)) {
        const subIdx = join(full, sub, 'index.html');
        if (existsSync(subIdx)) out.push(subIdx);
      }
    }
  }
  return out;
}

const hashes = new Map();
function hashFor(file) {
  if (!hashes.has(file)) {
    hashes.set(file, createHash('sha1').update(readFileSync(file)).digest('hex').slice(0, 10));
  }
  return hashes.get(file);
}

// Local (no scheme, no protocol-relative) href/src ending in .css or .js, with an
// optional existing ?v= stamp to replace. Externals (https://…, //…) never match.
const REF = /\b(href|src)="((?!https?:|\/\/)[\w@./-]+\.(?:css|js))(\?v=[\w]+)?"/g;

let filesChanged = 0;
let refsStamped = 0;
for (const page of pageFiles()) {
  const src = readFileSync(page, 'utf8');
  const out = src.replace(REF, (whole, attr, ref) => {
    const target = resolve(dirname(page), ref);
    if (!existsSync(target)) return whole; // e.g. a reference served only by the API host
    refsStamped++;
    return `${attr}="${ref}?v=${hashFor(target)}"`;
  });
  if (out !== src) {
    writeFileSync(page, out);
    filesChanged++;
  }
}
console.log(`stamped ${refsStamped} asset refs (${filesChanged} files changed)`);
