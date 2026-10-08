// web-tests/unit/api-override-host-gate.test.js
// `?api=` may only steer a page that is served from a developer's machine.
//
// Every customer page that talks to the API opens with the same inline bootstrap: it reads
// `?api=<origin>` (or `?api=off`) from its own URL and uses it as window.CEYLON_HOP_API. Until
// 2026-10-07 it did that on ANY host, so a crafted link such as
//   https://ceylonhop.com/booking.html?…&api=https://evil.example
// made the live booking page send the customer's name, email and WhatsApp to that server, show
// its prices and hand the browser to whatever "checkout" it answered — on a genuine
// ceylonhop.com URL. Local dev (`?api=http://localhost:8787`) and the e2e suite (served from
// localhost, `?api=off` / `?api=https://api.test`) are the only legitimate users, so the
// override is now honoured only when the PAGE is on localhost, 127.0.0.1, [::1], *.localhost
// or *.test. Everywhere else the parameter is ignored and the page keeps its own base (the
// pre-set staging value, else the production default).
//
// The guard runs the REAL bootstrap of every page that carries one, so a new page, a hand
// edit, or a generator regression (a template literal eats `\.` → `.`) is caught.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SKIP_DIRS = new Set(['api', 'docs', 'tools', 'web-tests', 'img', 'node_modules', '.git', '.github', '.claude', 'test-results']);

function htmlFiles(dir = ROOT, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) htmlFiles(full, out);
    else if (name.endsWith('.html')) out.push(full);
  }
  return out;
}

// The bootstrap: an attribute-less inline <script> that reads the `api` query parameter.
const BOOTSTRAP = /<script>([\s\S]*?)<\/script>/g;
const readsApiParam = (js) => /\.get\(\s*['"]api['"]\s*\)/.test(js);

const pages = htmlFiles()
  .map((f) => ({ rel: path.relative(ROOT, f), src: readFileSync(f, 'utf8') }))
  .filter((p) => readsApiParam(p.src))
  .map((p) => ({ ...p, boots: [...p.src.matchAll(BOOTSTRAP)].map((m) => m[1]).filter(readsApiParam) }));

// Run one page's bootstrap as the browser would at `url`, with an optional pre-set base
// (tools/build-staging.mjs sets one before the page's own script). Returns the API base.
function apiBase(js, url, preset) {
  const classList = { add() {}, remove() {} };
  const sandbox = {
    location: new URL(url), URLSearchParams, setTimeout() {},
    document: { documentElement: { classList } },
  };
  sandbox.window = sandbox;
  if (preset !== undefined) sandbox.CEYLON_HOP_API = preset;
  vm.runInNewContext(js, sandbox);
  return sandbox.CEYLON_HOP_API;
}

const EVIL = 'https://evil.example';
const STAGING_API = 'https://ops.staging.ceylonhop.com';

describe('the ?api= bootstrap', () => {
  it('is found on every page family that has one (not a vacuous walk)', () => {
    const rels = pages.map((p) => p.rel);
    expect(pages.length).toBeGreaterThan(60);
    for (const f of ['booking.html', 'index.html', 'plan.html', 'search.html', 'why.html', 'board.html', 'trip/index.html']) {
      expect(rels).toContain(f);
    }
    expect(rels.some((r) => /^trip\/[^/]+\/index\.html$/.test(r))).toBe(true);
    expect(rels.some((r) => /^guides\/[^/]+\/index\.html$/.test(r))).toBe(true);
    for (const p of pages) expect(p.boots, p.rel).toHaveLength(1);
  });

  describe.each(pages.map((p) => [p.rel, p.boots[0]]))('%s', (rel, js) => {
    const page = (host) => `${host}/${rel.replace(/index\.html$/, '')}`;
    const prodDefault = apiBase(js, page('https://ceylonhop.com'));

    it('has a live default on the production host', () => {
      expect(prodDefault).toMatch(/^https:\/\/(ceylon-hop-api\.onrender\.com|ops\.ceylonhop\.com)$/);
    });

    it('ignores a foreign ?api= on the production host', () => {
      expect(apiBase(js, page('https://ceylonhop.com') + '?mode=private&api=' + encodeURIComponent(EVIL))).toBe(prodDefault);
      expect(apiBase(js, page('https://www.ceylonhop.com') + '?api=' + EVIL)).toBe(prodDefault);
    });

    it('ignores ?api=off on the production host — no demo checkout from a link', () => {
      expect(apiBase(js, page('https://ceylonhop.com') + '?api=off')).toBe(prodDefault);
    });

    it('keeps the staging build’s pre-set base on the staging host', () => {
      expect(apiBase(js, page('https://staging.ceylonhop.com') + '?api=' + EVIL, STAGING_API)).toBe(STAGING_API);
    });

    it('does not treat look-alike hosts as local', () => {
      for (const host of ['https://localhost.evil.example', 'https://evil-localhost', 'https://ceylonhop.test.evil.example', 'http://127a0b0c1', 'http://1']) {
        expect(apiBase(js, page(host) + '?api=' + EVIL), host).toBe(prodDefault);
      }
    });

    it('honours ?api= when the page is served from a developer machine', () => {
      for (const host of ['http://localhost:4173', 'http://127.0.0.1:4180', 'http://[::1]:4173', 'http://ceylon.localhost:4173', 'https://site.test']) {
        expect(apiBase(js, page(host) + '?api=http://localhost:8787'), host).toBe('http://localhost:8787');
        expect(apiBase(js, page(host) + '?api=off'), host).toBe('');
      }
      expect(apiBase(js, page('http://localhost:4173') + '?api=https://api.test')).toBe('https://api.test');
    });
  });
});
