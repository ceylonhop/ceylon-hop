# M16 — SEO-Safe Site Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recreate the old site's per-route landing-page layer in the new static site, 301-map every old URL, and ship the missing SEO plumbing so the `ceylonhop.com` apex cutover is ranking-neutral or better.

**Architecture:** A dependency-free Node generator loads the single source of pricing/distance truth (`transfers-data.js`) via a `window` shim, merges it with hand-written route copy (`tools/route-content.json`), and emits 44 static route pages, a `/trip/` index, `sitemap.xml`, redirect stubs, and a Cloudflare bulk-redirect CSV. Generated output is committed; a Vitest codegen-diff test guarantees it can't drift from the data. A first Step 0 refines the UI freeze from a blanket `*.html` block to an explicit named-file list so new SEO html is permitted while every existing live-site file stays protected.

**Tech Stack:** Node 20 (ESM `.mjs`, no deps) · Vitest + Playwright (existing `web-tests/` harness, jsdom) · GitHub Pages (branch-root, `.nojekyll`) · Cloudflare Bulk Redirects (at cutover).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-02-m16-seo-migration-design.md` (approved; addenda A1–A4 govern mechanism).
- **Pricing truth = `transfers-data.js` `window.TRANSFERS`** — never hardcode prices/distances in pages or content; always read from the generator's loaded data (engine rate-card parity: car $0.46/km, van $0.83/km on billable km = road km ×1.10, min fares car $29 / van $50, deposit 10% capped $50).
- **New URLs:** route pages at `/trip/<from-id>-to-<to-id>/` (trailing-slash dir → `index.html`), slugs = `transfers-data.js` place ids (e.g. `cmb-airport`, `nuwara-eliya`, `arugam-bay`).
- **Canonical host = `https://ceylonhop.com`** (absolute) in every `<link rel=canonical>`, sitemap `<loc>`, and OG `url`. Internal navigation hrefs are **relative** (`../../index.html` from a route page) so pages work on the apex, the github.io project path, and local file serving.
- **No `aggregateRating` structured data anywhere.** Real rating is **5.0 with 30 reviews** on TripAdvisor — use in visible copy only, with a link to the listing.
- **No `CNAME` file** committed in M16 (cutover step).
- **Freeze:** after Step 0, the named existing live-site files stay protected. PR3's edits to the 8 existing pages require the temporary owner-authorized unfreeze + the `allow-ui-change` PR label, freeze restored after (GL-4 procedure). PR1/PR2 add only new files.
- **Delivery:** four labelled PRs in order — `m16-freeze-model` (Step 0) → `m16-route-pages` (Unit 1) → `m16-redirects-plumbing` (Unit 2) → `m16-head-unfreeze` (Unit 3). Each leaves `web-tests` (`npm run test:all` where runnable) and CI green.
- **Test invocation:** unit `cd web-tests && npm run test:unit`; e2e `cd web-tests && npm run test:e2e`.

---

## The 22 route pairs (each generates BOTH directions → 44 pages)

`cmb-airport↔kandy`, `cmb-airport↔sigiriya`, `cmb-airport↔galle`, `cmb-airport↔mirissa`, `cmb-airport↔ella`, `cmb-airport↔negombo`, `cmb-airport↔colombo`, `negombo↔sigiriya`, `negombo↔kandy`, `colombo↔kandy`, `colombo↔galle`, `colombo↔ella`, `sigiriya↔kandy`, `kandy↔ella`, `kandy↔nuwara-eliya`, `nuwara-eliya↔ella`, `ella↔yala`, `ella↔arugam-bay`, `ella↔mirissa`, `yala↔mirissa`, `mirissa↔galle`, `galle↔ella`.

Slug = `<a>-to-<b>` in the order the page presents (both orders generated). Directory: `trip/<a>-to-<b>/index.html`.

---

## Unit 0 — Freeze-model refinement (PR `m16-freeze-model`)

Convert the UI freeze from a blanket `*.html` block to an explicit list of the existing live-site files, so new SEO html (route pages, stubs, `terms/privacy/404.html`) is writable while every currently-frozen file stays protected. `.claude/` and `.github/` are outside the freeze, so these edits are allowed.

### Task 0.1: Refine the local PreToolUse hook + CI gate to a named-file allowlist

**Files:**
- Modify: `.claude/hooks/protect-ui.sh`
- Modify: `.github/workflows/ci.yml:25` (the `frozen=` grep)
- Test: `.claude/hooks/protect-ui.test.sh` (Create)

**Interfaces:**
- Produces: a hook that exits 2 (block) for the named frozen files and exits 0 (allow) for any other path, including new html under `trip/` and new root html not in the list.

- [ ] **Step 1: Write the failing test** — `.claude/hooks/protect-ui.test.sh`:

```bash
#!/usr/bin/env bash
# Verifies protect-ui.sh blocks the frozen live-site files and allows new SEO files.
set -u
HOOK="$(dirname "$0")/protect-ui.sh"
fail=0
check() { # <path> <expected-exit>
  echo "{\"tool_input\":{\"file_path\":\"$1\"}}" | bash "$HOOK" >/dev/null 2>&1
  local got=$?; [ "$got" = "$2" ] || { echo "FAIL $1: want $2 got $got"; fail=1; }
}
# frozen → blocked (exit 2)
for f in index.html about.html blog.html booking.html plan.html search.html tour.html tours.html why.html _ops-preview.html \
         site.css favicon.svg image-slots.state.json site.js booking.js plan.js search.js datepicker.js image-slot.js tours-data.js transfers-data.js routes-data.js tweaks.js; do
  check "/repo/$f" 2
done
# new SEO files → allowed (exit 0)
for f in trip/kandy-to-ella/index.html trip/index.html terms.html privacy.html 404.html about-us/index.html sitemap.xml robots.txt tools/generate-route-pages.mjs; do
  check "/repo/$f" 0
done
# api/docs/.claude/.github always allowed
for f in api/src/x.ts docs/y.md .claude/settings.json .github/workflows/ci.yml; do
  check "/repo/$f" 0
done
[ "$fail" = 0 ] && echo "protect-ui: ALL PASS" || { echo "protect-ui: FAILURES"; exit 1; }
```

- [ ] **Step 2: Run it against the current hook to see it fail**

Run: `bash .claude/hooks/protect-ui.test.sh`
Expected: FAIL — `trip/kandy-to-ella/index.html` (and the other new html) return 2, because the current hook blocks by `*.html` basename.

- [ ] **Step 3: Rewrite the hook's match block** — replace the `case "$base"` block in `.claude/hooks/protect-ui.sh` with an explicit list keyed on the path's basename, and note the model change:

```bash
# The frozen live-site surface — the EXISTING files only. New SEO html (route
# pages under trip/, redirect stubs, terms/privacy/404) is intentionally allowed
# (M16). PR3's edits to the existing pages below use the labelled unfreeze.
base="$(basename "$path")"
case "$base" in
  index.html|about.html|blog.html|booking.html|plan.html|search.html|tour.html|tours.html|why.html|_ops-preview.html|\
  site.css|favicon.svg|image-slots.state.json|\
  site.js|booking.js|plan.js|search.js|datepicker.js|image-slot.js|tours-data.js|transfers-data.js|routes-data.js|tweaks.js)
    echo "BLOCKED: '$base' is a frozen front-end / live-site file (CLAUDE.md rule 3). New SEO files are allowed; to edit an existing page use the owner-authorized unfreeze + 'allow-ui-change' label." >&2
    exit 2 ;;
esac
exit 0
```

- [ ] **Step 4: Refine the CI gate** — in `.github/workflows/ci.yml`, replace the `frozen=` line's regex so it matches the named existing files, not all root html:

```yaml
          frozen="$(echo "$changed" | grep -E '^(index|about|blog|booking|plan|search|tour|tours|why|_ops-preview)\.html$|^(site\.css|favicon\.svg|image-slots\.state\.json)$|^(booking|datepicker|image-slot|plan|routes-data|search|site|tours-data|transfers-data|tweaks)\.js$' || true)"
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bash .claude/hooks/protect-ui.test.sh`
Expected: `protect-ui: ALL PASS`

- [ ] **Step 6: Commit**

```bash
git add .claude/hooks/protect-ui.sh .claude/hooks/protect-ui.test.sh .github/workflows/ci.yml
git commit -m "chore(m16): freeze protects named live-site files, permits new SEO html (Step 0)"
```

---

## Unit 1 — Route pages (PR `m16-route-pages`)

New files only. Builds the generator, content, 44 pages + `/trip/` index + `sitemap.xml`, and tests.

### Task 1.1: Root package scripts + the transfers-data loader

**Files:**
- Create: `package.json` (root)
- Create: `tools/load-transfers.mjs`
- Test: `web-tests/unit/seo-loader.test.js`

**Interfaces:**
- Produces: `loadTransfers()` → the `window.TRANSFERS` object (`PLACES`, `byId`, `CORRIDORS`, `privateQuote(fromId,toId)`, `sharedOption(fromId,toId)`, `DEPOSIT_PCT`, `DEPOSIT_CAP`, `place(id)`). Loaded by the generator and by tests.

- [ ] **Step 1: Create root `package.json`** (dependency-free; scripts only):

```json
{
  "name": "ceylon-hop-site",
  "private": true,
  "type": "module",
  "description": "Static marketing/booking site + SEO route-page generator.",
  "scripts": {
    "generate": "node tools/generate-route-pages.mjs",
    "generate:redirects": "node tools/generate-redirects.mjs"
  }
}
```

- [ ] **Step 2: Write the failing test** — `web-tests/unit/seo-loader.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { loadTransfers } from '../../tools/load-transfers.mjs';

describe('loadTransfers', () => {
  const T = loadTransfers();
  it('exposes the TRANSFERS API', () => {
    expect(typeof T.privateQuote).toBe('function');
    expect(typeof T.sharedOption).toBe('function');
    expect(T.byId['kandy'].name).toBe('Kandy');
  });
  it('prices Kandy→Ella from the engine rate card', () => {
    const q = T.privateQuote('kandy', 'ella'); // real leg 136 km
    expect(q.km).toBe(136);
    // billable = round(136*1.10)=150; car=max(29,round(150*0.46))=69; van=max(50,round(150*0.83))=125
    expect(q.car).toBe(69);
    expect(q.van).toBe(125);
  });
  it('finds a shared corridor where one exists', () => {
    expect(T.sharedOption('kandy', 'ella')).toBeTruthy();      // hill-line
    expect(T.sharedOption('cmb-airport', 'galle')).toBeNull(); // no shared corridor
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `cd web-tests && npm run test:unit -- seo-loader`
Expected: FAIL — `tools/load-transfers.mjs` does not exist.

- [ ] **Step 4: Implement `tools/load-transfers.mjs`** (sandbox the browser IIFE with a `window` shim):

```js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadTransfers() {
  const src = readFileSync(join(ROOT, 'transfers-data.js'), 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'transfers-data.js' });
  if (!sandbox.window.TRANSFERS) throw new Error('transfers-data.js did not define window.TRANSFERS');
  return sandbox.window.TRANSFERS;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd web-tests && npm run test:unit -- seo-loader`
Expected: PASS (3 tests). If a price assertion is off, read the true value from `transfers-data.js` `legPrice` and correct the test — the data is the source of truth, not this plan's arithmetic.

- [ ] **Step 6: Commit**

```bash
git add package.json tools/load-transfers.mjs web-tests/unit/seo-loader.test.js
git commit -m "feat(m16): dependency-free loader for transfers-data.js pricing (root generate scripts)"
```

### Task 1.2: Route-content data file

**Files:**
- Create: `tools/route-content.json`
- Test: `web-tests/unit/seo-content.test.js`

**Interfaces:**
- Produces: `route-content.json` with `places{ <id>: { short } }` and `pairs{ "<a>|<b>": { intro, highlights[], back? } }`. `intro` is the a→b narrative; optional `back` overrides the b→a narrative (else the generator swaps endpoint names in a direction-neutral template). Consumed by the generator; every one of the 22 pairs and every referenced place must have an entry.

- [ ] **Step 1: Write the failing test** — `web-tests/unit/seo-content.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadTransfers } from '../../tools/load-transfers.mjs';
const content = JSON.parse(readFileSync(new URL('../../tools/route-content.json', import.meta.url)));
const PAIRS = [
  ['cmb-airport','kandy'],['cmb-airport','sigiriya'],['cmb-airport','galle'],['cmb-airport','mirissa'],
  ['cmb-airport','ella'],['cmb-airport','negombo'],['cmb-airport','colombo'],['negombo','sigiriya'],
  ['negombo','kandy'],['colombo','kandy'],['colombo','galle'],['colombo','ella'],['sigiriya','kandy'],
  ['kandy','ella'],['kandy','nuwara-eliya'],['nuwara-eliya','ella'],['ella','yala'],['ella','arugam-bay'],
  ['ella','mirissa'],['yala','mirissa'],['mirissa','galle'],['galle','ella'],
];
describe('route-content.json', () => {
  const T = loadTransfers();
  it('has a blurb for every place used by a pair', () => {
    const ids = new Set(PAIRS.flat());
    for (const id of ids) {
      expect(content.places[id], `place ${id}`).toBeTruthy();
      expect(content.places[id].short.length).toBeGreaterThan(20);
    }
  });
  it('has an intro + >=3 highlights for every pair', () => {
    for (const [a,b] of PAIRS) {
      const p = content.pairs[`${a}|${b}`];
      expect(p, `pair ${a}|${b}`).toBeTruthy();
      expect(p.intro.length).toBeGreaterThan(120);
      expect(Array.isArray(p.highlights) && p.highlights.length >= 3).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd web-tests && npm run test:unit -- seo-content`
Expected: FAIL — `route-content.json` missing / entries absent.

- [ ] **Step 3: Author `tools/route-content.json`.** Fill `places` for all 15 referenced ids and `pairs` for all 22. Copy must be original, specific, and traveller-useful (what the drive is like, what you pass, why book private vs shared) — NOT templated filler. Two worked examples to match in tone/length:

```json
{
  "places": {
    "kandy": { "short": "the hill-country capital, home to the Temple of the Sacred Tooth Relic and the lake at the city's heart." },
    "ella": { "short": "a laid-back mountain town of tea slopes, the Nine Arch Bridge and the Little Adam's Peak hike." }
  },
  "pairs": {
    "kandy|ella": {
      "intro": "The road from Kandy to Ella is one of Sri Lanka's most scenic drives — climbing through Nuwara Eliya's tea country, past waterfalls and cloud forest, before dropping into Ella's valley. It's about 136 km and takes close to four hours by car, longer than the map suggests because the hill roads wind. Many travellers pair the private transfer with a stop at a tea factory or the famous train section.",
      "highlights": ["Tea estates and factory stops around Nuwara Eliya", "Ramboda and Devon waterfall viewpoints", "Optional: ride the scenic train for one leg while your driver meets you"],
      "back": "Leaving Ella for Kandy you climb back up through the tea hills — a good morning drive with cool air and long views, about 136 km and close to four hours. Ask your driver about a mid-route tea-estate stop."
    }
  }
}
```

Add the remaining 13 places and 21 pairs to the same standard. (During workflow execution this file is produced by fanning out one Fable 5 agent per pair, then merged.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web-tests && npm run test:unit -- seo-content`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/route-content.json web-tests/unit/seo-content.test.js
git commit -m "content(m16): route-page narratives + place blurbs for 22 corridors"
```

### Task 1.3: The generator (page template, JSON-LD, header/footer, /trip index, sitemap)

**Files:**
- Create: `tools/generate-route-pages.mjs`
- Create: `tools/site-chrome.mjs` (shared header/footer/head partials with `../../` relative links)
- Test: `web-tests/unit/seo-generate.test.js`

**Interfaces:**
- Consumes: `loadTransfers()`; `route-content.json`.
- Produces: `generateAll()` → `Map<string, string>` of `{ repoRelativePath: htmlOrXml }`, covering `trip/<a>-to-<b>/index.html` ×44, `trip/index.html`, `sitemap.xml`. Also `renderChrome({ depth, active })` in `site-chrome.mjs` → `{ headExtras, header, footer }` with correct relative prefixes. Running the module directly (`node tools/generate-route-pages.mjs`) writes every entry to disk.

- [ ] **Step 1: Write the failing test** — `web-tests/unit/seo-generate.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { generateAll } from '../../tools/generate-route-pages.mjs';

describe('generateAll', () => {
  const out = generateAll();
  it('emits 44 route pages + index + sitemap', () => {
    const routes = [...out.keys()].filter(k => /^trip\/[a-z-]+-to-[a-z-]+\/index\.html$/.test(k));
    expect(routes.length).toBe(44);
    expect(out.has('trip/index.html')).toBe(true);
    expect(out.has('sitemap.xml')).toBe(true);
  });
  it('kandy-to-ella page carries engine prices, canonical, JSON-LD, no aggregateRating', () => {
    const html = out.get('trip/kandy-to-ella/index.html');
    expect(html).toContain('<link rel="canonical" href="https://ceylonhop.com/trip/kandy-to-ella/">');
    expect(html).toContain('$69');            // car price from the rate card
    expect(html).toMatch(/"@type":\s*"FAQPage"/);
    expect(html).not.toContain('aggregateRating');
    expect(html).toContain('../../site.css'); // relative asset ref
  });
  it('CTA deep-links into search with from/to prefilled', () => {
    const html = out.get('trip/kandy-to-ella/index.html');
    expect(html).toContain('../../search.html?from=kandy&to=ella');
  });
  it('sitemap lists every route page with absolute apex URLs', () => {
    const xml = out.get('sitemap.xml');
    expect(xml).toContain('<loc>https://ceylonhop.com/trip/kandy-to-ella/</loc>');
    expect((xml.match(/<loc>/g) || []).length).toBeGreaterThanOrEqual(45);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd web-tests && npm run test:unit -- seo-generate`
Expected: FAIL — generator modules absent.

- [ ] **Step 3: Implement `tools/site-chrome.mjs`** — static header/footer mirroring `site.js` output but with a `prefix` (`'../../'` for route pages, `''` for root pages) and a hardcoded year; includes a tiny inline burger script. Keep classes identical to `site.css` (`.nav`, `.nav-inner`, `.brand`, `.nav-links`, `.footer`, `.foot-grid`, `.foot-bottom`). WhatsApp = `https://wa.me/94779669662`, displayed number **+94 77 966 9662**. (Full markup authored here — mirror the nav links `Plan a trip/plan.html, Tours/tours.html, Travel Guide/blog.html, Why us/why.html, About/about.html` and the footer columns from `site.js` `mountFooter`, each href prefixed.)

- [ ] **Step 4: Implement `tools/generate-route-pages.mjs`** — for each of the 44 ordered pairs: read `privateQuote`/`sharedOption`, pull copy from `route-content.json`, render `<head>` (unique title/description, absolute self-canonical, OG), the hero (CSS-gradient, H1 `"<From> to <To> — private transfer & shared ride"`), price-from block (car/van, + shared seat when `sharedOption` non-null), the route narrative + highlights, a 4–5 item FAQ (duration/cost/luggage/stops/booking with numbers filled), CTAs (`<prefix>search.html?from=<a>&to=<b>` + WhatsApp), and JSON-LD (`BreadcrumbList`, `FAQPage`, `Service`+`Offer` USD price-from — **no aggregateRating**). Build `trip/index.html` (all 44 grouped by hub) and `sitemap.xml` (absolute apex `<loc>` for the 44 routes + `/trip/` + `index/about/why/blog/tours/plan`). Export `generateAll()`; when run directly, `writeFileSync` each entry (creating dirs).

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd web-tests && npm run test:unit -- seo-generate`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add tools/generate-route-pages.mjs tools/site-chrome.mjs web-tests/unit/seo-generate.test.js
git commit -m "feat(m16): route-page generator — pages, /trip index, sitemap, JSON-LD"
```

### Task 1.4: Generate and commit the pages, with a codegen-drift guard

**Files:**
- Create (generated): `trip/**/index.html` ×44, `trip/index.html`, `sitemap.xml`
- Test: `web-tests/unit/seo-codegen.test.js`

- [ ] **Step 1: Write the failing test** — `web-tests/unit/seo-codegen.test.js` (committed files must equal generator output):

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateAll } from '../../tools/generate-route-pages.mjs';
const ROOT = new URL('../../', import.meta.url).pathname;
describe('generated files match the generator (no drift)', () => {
  for (const [rel, content] of generateAll()) {
    it(rel, () => {
      let onDisk;
      try { onDisk = readFileSync(join(ROOT, rel), 'utf8'); }
      catch { throw new Error(`missing generated file ${rel} — run: npm run generate`); }
      expect(onDisk).toBe(content);
    });
  }
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd web-tests && npm run test:unit -- seo-codegen`
Expected: FAIL — files not yet written.

- [ ] **Step 3: Generate the files**

Run: `npm run generate` (from repo root)
Expected: writes 44 route dirs + `trip/index.html` + `sitemap.xml`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web-tests && npm run test:unit -- seo-codegen`
Expected: PASS (46 cases).

- [ ] **Step 5: Commit**

```bash
git add trip sitemap.xml web-tests/unit/seo-codegen.test.js
git commit -m "feat(m16): generate 44 route pages + /trip index + sitemap"
```

### Task 1.5: Static SEO invariant tests

**Files:**
- Test: `web-tests/unit/seo-invariants.test.js`

- [ ] **Step 1: Write the test** (uniqueness + hygiene across all route pages):

```js
import { describe, it, expect } from 'vitest';
import { generateAll } from '../../tools/generate-route-pages.mjs';
const out = generateAll();
const routes = [...out].filter(([k]) => /^trip\/.+\/index\.html$/.test(k));
const pick = (h, re) => (h.match(re) || [,''])[1];
describe('route-page SEO invariants', () => {
  it('unique <title> and canonical per page', () => {
    const titles = new Set(), canon = new Set();
    for (const [, h] of routes) {
      const t = pick(h, /<title>([^<]+)<\/title>/); const c = pick(h, /rel="canonical" href="([^"]+)"/);
      expect(t, 'title present').toBeTruthy(); expect(titles.has(t), `dup title ${t}`).toBe(false); titles.add(t);
      expect(canon.has(c), `dup canonical ${c}`).toBe(false); canon.add(c);
    }
  });
  it('exactly one <h1>, a meta description, and no noindex on route pages', () => {
    for (const [k, h] of routes) {
      expect((h.match(/<h1[ >]/g) || []).length, `${k} h1 count`).toBe(1);
      expect(h, `${k} description`).toMatch(/<meta name="description"/);
      expect(h, `${k} must be indexable`).not.toContain('noindex');
    }
  });
  it('no aggregateRating anywhere in generated output', () => {
    for (const [, h] of out) expect(h).not.toContain('aggregateRating');
  });
});
```

- [ ] **Step 2: Run it**

Run: `cd web-tests && npm run test:unit -- seo-invariants`
Expected: PASS. If a dup title surfaces, fix the title template in the generator (Task 1.3) and re-run `npm run generate` + the codegen test.

- [ ] **Step 3: Commit**

```bash
git add web-tests/unit/seo-invariants.test.js
git commit -m "test(m16): route-page SEO invariants (unique titles/canonicals, single h1, no noindex/aggregateRating)"
```

### Task 1.6: Route-page rendering e2e (Playwright)

**Files:**
- Test: `web-tests/e2e/route-pages.spec.js`

**Interfaces:**
- Consumes: `web-tests/playwright.config.js` `webServer`/`baseURL` (serves the repo root). Confirm it serves the project root so `/trip/kandy-to-ella/` and `/search.html` resolve; if it currently serves a subdir, add a project-root static-server config.

- [ ] **Step 1: Write the test:**

```js
import { test, expect } from '@playwright/test';
test('route page renders with nav, prices, and a working search CTA', async ({ page }) => {
  await page.goto('/trip/kandy-to-ella/');
  await expect(page.locator('h1')).toContainText('Kandy to Ella');
  await expect(page.locator('.nav-links')).toBeVisible();
  await expect(page.getByText('$69')).toBeVisible();
  await page.getByRole('link', { name: /get.*price|book|see prices/i }).first().click();
  await expect(page).toHaveURL(/search\.html\?from=kandy&to=ella/);
});
```

- [ ] **Step 2: Run it**

Run: `cd web-tests && npm run test:e2e -- route-pages`
Expected: PASS. Adjust the CTA name regex to the actual button label from the generator.

- [ ] **Step 3: Commit**

```bash
git add web-tests/e2e/route-pages.spec.js web-tests/playwright.config.js
git commit -m "test(m16): e2e route-page render + search deep-link"
```

- [ ] **Step 4: Full suite green, then open PR**

Run: `cd web-tests && npm run test:all`
Expected: all green. Push branch `m16-route-pages`, open PR (no `allow-ui-change` label needed — new files only).

---

## Unit 2 — Redirects + plumbing (PR `m16-redirects-plumbing`)

New files only. Redirect map → stubs + Cloudflare CSV; robots/404; ported terms/privacy; sitemap updated.

### Task 2.1: Redirect map → static stubs + Cloudflare CSV

**Files:**
- Create: `tools/redirect-map.json`
- Create: `tools/generate-redirects.mjs`
- Create (generated): `docs/cloudflare-redirects.csv`, redirect stub `index.html` files under each old path
- Test: `web-tests/unit/seo-redirects.test.js`

**Interfaces:**
- Produces: `generateRedirects()` → `Map<path,content>` for each stub + the CSV. `redirect-map.json` = array of `{ from: "/old/path/", to: "/trip/new/" | "tour.html?id=..." | "/" }` (the full map is spec §2). Stub HTML: `<meta http-equiv="refresh" content="0; url=<relativeTo>">`, absolute `<link rel="canonical" href="https://ceylonhop.com<to>">`, a visible fallback link, `<meta name="robots" content="noindex">`.

- [ ] **Step 1: Write the failing test:**

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { generateRedirects } from '../../tools/generate-redirects.mjs';
const map = JSON.parse(readFileSync(new URL('../../tools/redirect-map.json', import.meta.url)));
const out = generateRedirects();
describe('redirects', () => {
  it('every old /trip/ URL from the live sitemap is mapped', () => {
    const froms = map.map(m => m.from);
    for (const u of ['/trip/kandy_to_ella/','/trip/shared-ride-negombo-to-sigiri/','/trip/ella-to-arugambay-shared-ride/','/routes/','/about-us/','/terms-and-conditions/','/privacy-policy/'])
      expect(froms, u).toContain(u);
  });
  it('each stub has a canonical to the apex target and a meta refresh', () => {
    for (const [, html] of out) {
      if (!html.includes('<html')) continue;
      expect(html).toMatch(/http-equiv="refresh"/);
      expect(html).toMatch(/rel="canonical" href="https:\/\/ceylonhop\.com/);
      expect(html).toContain('noindex');
    }
  });
  it('emits a Cloudflare CSV with a row per mapping', () => {
    const csv = out.get('docs/cloudflare-redirects.csv');
    expect(csv.trim().split('\n').length).toBeGreaterThanOrEqual(map.length);
  });
});
```

- [ ] **Step 2: Run it to see it fail** — `cd web-tests && npm run test:unit -- seo-redirects` → FAIL (modules absent).

- [ ] **Step 3: Author `tools/redirect-map.json`** from spec §2 (every old URL from the live Yoast sitemaps → new target), and **implement `tools/generate-redirects.mjs`** emitting the stubs + `docs/cloudflare-redirects.csv` (columns: `source URL,target URL,status` with `status=301`, absolute apex URLs). A cross-check the test can assert: every `to` that begins `/trip/` exists in the route-page output — import `generateAll` and verify.

- [ ] **Step 4: Run to pass** — `cd web-tests && npm run test:unit -- seo-redirects` → PASS.

- [ ] **Step 5: Generate + commit**

```bash
npm run generate:redirects
git add tools/redirect-map.json tools/generate-redirects.mjs docs/cloudflare-redirects.csv trip/../ web-tests/unit/seo-redirects.test.js
git add -A   # picks up the stub dirs (old WP paths)
git commit -m "feat(m16): redirect map → static stubs + Cloudflare bulk-redirect CSV"
```

### Task 2.2: robots.txt + 404.html

**Files:**
- Create: `robots.txt`, `404.html`
- Test: `web-tests/unit/seo-plumbing.test.js`

- [ ] **Step 1: Write the test:**

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const read = p => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
describe('site plumbing', () => {
  it('robots allows all and points at the sitemap', () => {
    const r = read('robots.txt');
    expect(r).toMatch(/User-agent:\s*\*/);
    expect(r).toContain('Sitemap: https://ceylonhop.com/sitemap.xml');
  });
  it('404 page is branded and links home + /trip/', () => {
    const h = read('404.html');
    expect(h).toContain('Ceylon Hop');
    expect(h).toMatch(/href="\/?trip\/?"/);
  });
});
```

- [ ] **Step 2: Run → fail; Step 3: create `robots.txt`** (`User-agent: *` / `Allow: /` / `Sitemap: https://ceylonhop.com/sitemap.xml`) and **`404.html`** (branded, self-contained header/footer via a `renderChrome({depth:0})` call or inline root-relative markup, links to `/` and `/trip/`).

- [ ] **Step 4: Run → pass; Step 5: commit**

```bash
git add robots.txt 404.html web-tests/unit/seo-plumbing.test.js
git commit -m "feat(m16): robots.txt + branded 404.html"
```

### Task 2.3: Port terms.html + privacy.html

**Files:**
- Create: `terms.html`, `privacy.html`
- Test: extend `web-tests/unit/seo-plumbing.test.js`

- [ ] **Step 1: Fetch live content** — retrieve the body text of `https://ceylonhop.com/terms-and-conditions/` and `https://ceylonhop.com/privacy-policy/` (WebFetch during execution). Rebuild each in the site chrome: same `<head>` conventions, self-contained header/footer (`renderChrome`), self-canonical (`https://ceylonhop.com/terms.html` / `/privacy.html`), a `.section .wrap` prose body carrying the ported text. Preserve legal substance verbatim; only reflow into the new layout.

- [ ] **Step 2: Write the test** (append to seo-plumbing):

```js
it('terms and privacy exist, self-canonical, with site chrome', () => {
  for (const [p, slug] of [['terms.html','terms.html'],['privacy.html','privacy.html']]) {
    const h = read(p);
    expect(h).toContain(`<link rel="canonical" href="https://ceylonhop.com/${slug}">`);
    expect(h).toContain('data-footer'); // or the static footer marker used by renderChrome
    expect(h.length).toBeGreaterThan(1500);
  }
});
```

- [ ] **Step 3: Run → pass; Step 4: commit**

```bash
git add terms.html privacy.html web-tests/unit/seo-plumbing.test.js
git commit -m "feat(m16): port terms + privacy pages into the new site chrome"
```

### Task 2.4: Sitemap includes terms/privacy; redirect e2e

**Files:**
- Modify: `tools/generate-route-pages.mjs` (add terms/privacy to sitemap), regenerate `sitemap.xml`
- Test: `web-tests/e2e/redirects.spec.js`

- [ ] **Step 1:** Add `terms.html` + `privacy.html` `<loc>`s to the sitemap builder; `npm run generate`; the codegen test (Task 1.4) now also covers the new sitemap — run `cd web-tests && npm run test:unit -- seo-codegen` → PASS.
- [ ] **Step 2: Redirect e2e** — `web-tests/e2e/redirects.spec.js`:

```js
import { test, expect } from '@playwright/test';
test('old /trip/ URL redirects to the new route page', async ({ page }) => {
  await page.goto('/trip/kandy_to_ella/');           // old stub
  await expect(page).toHaveURL(/\/trip\/kandy-to-ella\/?$/);
  await expect(page.locator('h1')).toContainText('Kandy to Ella');
});
```

- [ ] **Step 3:** `cd web-tests && npm run test:e2e -- redirects` → PASS.
- [ ] **Step 4: Full suite + PR**

```bash
git add sitemap.xml web-tests/e2e/redirects.spec.js
git commit -m "test(m16): sitemap covers terms/privacy; redirect-stub e2e"
cd web-tests && npm run test:all   # green
```

Push branch `m16-redirects-plumbing`, open PR (new files only).

---

## Unit 3 — Head unfreeze (PR `m16-head-unfreeze`, label: `allow-ui-change`)

Owner-authorized edits to the 8 existing pages' `<head>` + the rating corrections. Temporarily lifts those files from the freeze, then restores it.

### Task 3.1: Temporarily unfreeze the existing pages

**Files:**
- Modify: `.claude/hooks/protect-ui.sh` (comment-out the 8 html + booking.html/index.html from the block list for this PR), `.claude/settings.json` (remove the matching `Edit(*.html)` behavior for the duration)

- [ ] **Step 1:** In `protect-ui.sh`, temporarily remove `index.html about.html blog.html booking.html plan.html search.html tour.html tours.html why.html` from the `case` list (leave `_ops-preview.html` + assets + `.js` protected). Add a comment: `# M16 PR3 (2026-07-02): existing pages temporarily unfrozen for head/rating metadata — restored in the final commit.` The local `settings.json` deny uses `Edit(*.html)`; leave a note, and rely on the hook (the deny blocks Edit but the head edits use Edit — so also drop `Edit(*.html)` from deny for this PR, mirroring GL-4's removal of the specific-file denies).
- [ ] **Step 2: Commit**

```bash
git add .claude/hooks/protect-ui.sh .claude/settings.json
git commit -m "chore(m16): temporarily unfreeze existing pages for PR3 head/rating edits (owner-authorized)"
```

### Task 3.2: Sitewide canonical + OG + noindex on param pages

**Files:**
- Modify (head only): `about.html`, `blog.html`, `plan.html`, `search.html`, `booking.html`, `tours.html`, `tour.html`, `why.html`

**Interfaces:**
- Each page gains: `<link rel="canonical" href="https://ceylonhop.com/<file>">` (self, absolute), OG `og:title`/`og:description`/`og:url`/`og:type`/`og:site_name` where missing. `search.html` and `booking.html` additionally get `<meta name="robots" content="noindex,follow">` (param-driven, must not be indexed).

- [ ] **Step 1: Write the test first** — `web-tests/unit/seo-existing-pages.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const read = p => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const PAGES = ['about','blog','plan','search','booking','tours','tour','why','index'];
describe('existing-page head metadata', () => {
  it('every page self-canonicalizes to the apex', () => {
    for (const p of PAGES)
      expect(read(`${p}.html`), p).toContain(`<link rel="canonical" href="https://ceylonhop.com/${p}.html">`.replace('index.html','').replace('ceylonhop.com/"','ceylonhop.com/"'));
  });
  it('param pages are noindex; content pages are not', () => {
    for (const p of ['search','booking']) expect(read(`${p}.html`), p).toMatch(/name="robots"[^>]*noindex/);
    for (const p of ['about','why','plan','tours','blog']) expect(read(`${p}.html`), p).not.toMatch(/noindex/);
  });
});
```

Note: `index.html` canonical is `https://ceylonhop.com/` (already present) — special-case it in the assertion.

- [ ] **Step 2: Run → fail** (`cd web-tests && npm run test:unit -- seo-existing-pages`).
- [ ] **Step 3: Edit each page's `<head>`** — add the canonical + OG tags; add the `noindex,follow` robots meta to `search.html` and `booking.html`. Head-only; no body/behaviour changes.
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit**

```bash
git add about.html blog.html plan.html search.html booking.html tours.html tour.html why.html web-tests/unit/seo-existing-pages.test.js
git commit -m "seo(m16): sitewide self-canonical + OG; noindex the param-driven search/booking pages"
```

### Task 3.3: Correct the rating everywhere + fix homepage structured data

**Files:**
- Modify: `index.html` (meta description, OG description, JSON-LD, hero badge line ~385, section heading ~520), `booking.html` (trust line ~574)

**Interfaces:**
- Rating copy → **"5.0 on Tripadvisor · 30 reviews"** (or "Rated 5.0 on Tripadvisor" in meta). JSON-LD `TravelAgency` keeps name/url/telephone/areaServed/priceRange, **drops `aggregateRating`**, and **adds `"sameAs": ["<real TripAdvisor listing URL>"]`**. Hero badge + booking trust line link to the real listing.

- [ ] **Step 1: Extend the test** — append to `seo-existing-pages.test.js`:

```js
it('no aggregateRating markup and no stale 4.9/600 anywhere', () => {
  for (const p of ['index','booking']) {
    const h = read(`${p}.html`);
    expect(h, `${p} aggregateRating`).not.toContain('aggregateRating');
    expect(h, `${p} 4.9`).not.toContain('4.9');
    expect(h, `${p} 600`).not.toMatch(/600\+?\s*(reviews|travellers)/i);
  }
});
it('index JSON-LD has sameAs to the TripAdvisor listing', () => {
  expect(read('index.html')).toMatch(/"sameAs":\s*\[/);
});
```

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Edit `index.html` + `booking.html`** — replace all `4.9`/`600+` rating strings with the true `5.0` / `30 reviews`; remove `aggregateRating` from the JSON-LD; add `sameAs`; point the hero badge (`~385`) and booking trust line (`~574`) `href` at the real TripAdvisor listing URL (confirm the URL at PR review; use the verified listing).
- [ ] **Step 4: Run → pass.** Also run the existing FE suite to confirm no regression: `cd web-tests && npm run test:unit` (table-integrity/pricing tests stay green).
- [ ] **Step 5: Commit**

```bash
git add index.html booking.html web-tests/unit/seo-existing-pages.test.js
git commit -m "seo(m16): correct rating to 5.0/30 reviews, drop self-serving aggregateRating, add sameAs"
```

### Task 3.4: Restore the freeze

**Files:**
- Modify: `.claude/hooks/protect-ui.sh`, `.claude/settings.json`

- [ ] **Step 1:** Re-add the 9 pages to the hook's block list and restore the `settings.json` denies to the Step 0 state (the named-file model, with all existing pages protected again).
- [ ] **Step 2: Verify** the hook blocks `index.html` again: `echo '{"tool_input":{"file_path":"/r/index.html"}}' | bash .claude/hooks/protect-ui.sh; echo $?` → `2`. Run `bash .claude/hooks/protect-ui.test.sh` → ALL PASS.
- [ ] **Step 3: Commit + PR**

```bash
git add .claude/hooks/protect-ui.sh .claude/settings.json
git commit -m "chore(m16): restore the front-end freeze after PR3 head/rating edits"
```

Push branch `m16-head-unfreeze`, open PR **with the `allow-ui-change` label**, request owner review (touches frozen files).

---

## Post-merge / cutover checklist additions (not built in M16)

Append to `docs/go-live-checklist.md` §3 at merge: at apex cutover — commit `CNAME` (apex); point Cloudflare DNS → GitHub Pages; import `docs/cloudflare-redirects.csv` as Cloudflare Bulk Redirects (301); GSC submit `sitemap.xml` + request indexing of top route pages; monitor Coverage/404 for 4–6 weeks. Trim CORS + confirm apex canonicals (already listed).

---

## Self-review

- **Spec coverage:** route pages (U1) · redirect map + stubs + CSV (U2.1) · sitemap/robots/404/CNAME — CNAME deferred per S8/A-constraint (cutover), rest in U1/U2 · canonical+OG sitewide + noindex param pages (U3.2) · structured data incl. BreadcrumbList/FAQ/Service, aggregateRating dropped (U1.3, U3.3) · rating correction 5.0/30 (U3.3) · freeze handling (U0, U3.1/3.4) · terms/privacy port (U2.3). Images (A3) explicitly deferred with a documented hero slot — flagged, not silently dropped.
- **Placeholders:** the only intentionally-open value is the real TripAdvisor listing URL (Task 3.3), confirmed at PR review; and route-content.json prose authored during execution to the two worked examples' standard. No code steps left abstract.
- **Type consistency:** `loadTransfers()`, `generateAll()`, `generateRedirects()`, `renderChrome({depth})` names are used consistently across tasks and tests.
