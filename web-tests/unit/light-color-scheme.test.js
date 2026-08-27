// web-tests/unit/light-color-scheme.test.js
// The site is light-only and must SAY so, or browsers invent a dark rendering of it.
//
// There is not one `prefers-color-scheme` rule in the customer site. Until 2026-08-27 there was no
// `color-scheme` declaration either, so nothing stopped Chrome's Auto Dark Theme (and friends) from
// force-darkening it: a friend's screenshots came back with blog.html's --paper card (#fffdf8)
// rendered near-black under cream Bodoni, and plan.js's schematic map island stripped of its
// #cfe7da fill down to a bare outline. A design nobody drew, reviewed as if we had.
//
// Two things are pinned here, because the declaration is one line and silently losing it costs
// nothing at build time and everything on a real phone:
//   1. site.css declares `color-scheme: only light` on :root. `only` is load-bearing — plain
//      `light` just names the schemes we support, and force-dark applies to light-only pages
//      exactly BECAUSE they are light-only.
//   2. every customer-facing page actually loads site.css, so the declaration reaches it.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SKIP_DIRS = new Set(['api', 'docs', 'tools', 'web-tests', 'img', 'node_modules', '.git', '.github', '.claude', 'test-results']);
// Ops-internal surfaces are not customer-facing (ops-ui.html lives in api/ and is its own app).
const SKIP_FILES = new Set(['_ops-preview.html', 'board.html']);

function htmlFiles(dir = ROOT, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) htmlFiles(full, out);
    else if (name.endsWith('.html') && !SKIP_FILES.has(name)) out.push(full);
  }
  return out;
}

// A WordPress-era redirect stub: <meta http-equiv="refresh"> straight back out again. It is on
// screen for a frame and carries no design, so it needs no stylesheet.
const isRedirectStub = (src) => /http-equiv=["']refresh["']/i.test(src);
// tools/blog/*.body.html and friends are content FRAGMENTS the generator inlines, not pages.
const isFragment = (src) => !/<html[\s>]/i.test(src);

// Comments are stripped before scanning, the way retired-hexes.test.js does it: a comment cannot
// style anything, and the block introducing this very declaration has to spell out both
// `prefers-color-scheme` and plain `light` to explain why neither is used. Scanning raw source
// made this file fail on its own prose.
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

describe('the site declares itself light-only', () => {
  const css = stripComments(readFileSync(path.join(ROOT, 'site.css'), 'utf8'));

  it('site.css sets color-scheme on :root', () => {
    expect(css).toMatch(/color-scheme\s*:/);
  });

  it('uses `only light` — the keyword that actually opts out of forced darkening', () => {
    const decl = css.match(/color-scheme\s*:\s*([^;]+);/);
    expect(decl).not.toBeNull();
    expect(decl[1].trim()).toBe('only light');
  });

  it('still has no dark-mode rules that the declaration would contradict', () => {
    expect(css).not.toMatch(/prefers-color-scheme/);
  });
});

describe('the declaration reaches every customer-facing page', () => {
  it('every real page loads site.css', () => {
    const missing = htmlFiles()
      .filter((f) => {
        const src = readFileSync(f, 'utf8');
        return !isRedirectStub(src) && !isFragment(src) && !/site\.css/.test(src);
      })
      .map((f) => path.relative(ROOT, f));

    expect(missing).toEqual([]);
  });
});
