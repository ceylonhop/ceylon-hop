# Icon Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the two merged icon libraries (`img/icons/badges/` — 34 SVGs, PR #378; `img/icons/line/` — 24 SVGs, PR #381) onto the pages that need them, and add a regression test so icon slots can never silently duplicate or 404 again.

**Architecture:** Purely additive front-end work. Every change is either (a) swapping an `<img class="ico" src=".png">` for the equivalent `.svg`, (b) adding an `<img class="ico">` to a card that has no visual today, or (c) replacing an inline `<svg>` with the family-marked equivalent from `img/icons/line/`. One new Vitest file pins the contract. No backend, no schema, no pricing, no generated files.

**Tech Stack:** Static HTML + per-page `<style>` blocks · Vitest (`web-tests/unit/`) · Playwright (`web-tests/e2e/`) · the icon SVGs already on `main`.

## Global Constraints

- **One task = one branch = one PR.** `main` is protected: PR + 3 green CI checks required.
- **The working tree at `/Users/roshenw/claude_code/ceylon-hop` is shared by several sessions and currently sits on `codex/sh9-refund-ops-workflow`.** Work in an isolated worktree off `origin/main`. **Never `git add -A`** — stage by explicit path.
- **Leave it green:** `cd web-tests && npm run test:unit` must pass before every commit. `web-tests` has no local `node_modules` in a fresh worktree — symlink the main checkout's (`ln -sf /Users/roshenw/claude_code/ceylon-hop/web-tests/node_modules node_modules`) and **delete the symlink before staging**.
- **Do not touch** `trip/*` (60 generated route pages), `terms`, `privacy`, `404`, `rateCard.ts`, `departureRepo.ts`, any migration, or `config.ts`. Route-page work is Task 9 and is deferred, not in scope.
- **Visual changes are verified in a browser, not asserted in a unit test** (CLAUDE.md maintenance rule 5). The unit test in Task 1 pins *wiring* (does the file exist, is it distinct), never appearance.
- **Alt text stays empty** (`alt=""`) on every decorative icon — these sit beside a heading that already carries the meaning. Adding alt text would make screen readers announce it twice.
- Badge SVGs are for 62–100px slots. Line SVGs are for 16–24px slots. Do not mix.
- **Every three-card row must rotate its disc colours** — teal `#0DB9B6` · sky `#34C2D9` · saffron `#F9A429`, no two neighbours alike. This is the rule in `img/icons/badges/README.md` and the one the original PNG trio followed. Owner call, 2026-07-29: where the plan's chosen subject has the wrong disc, **add a recoloured variant of that badge** rather than swapping to a less apt subject.
- **Recolouring a disc can swallow an inner accent.** Each badge's inner art carries brand-colour accents; if the new disc colour matches one, that accent disappears. Verified accent map:

| Badge | Disc | Inner accents | Safe recolours |
|---|---|---|---|
| `door-to-door` | saffron | teal | **sky only** |
| `pro-hopper` | saffron | teal | sky; **teal only if the cap button is changed to saffron** |
| `hop-van` | saffron | teal **and** sky | **none — must stay saffron** |
| `rate-lock` | teal | *(none)* | any |
| `free-cancel` | saffron | teal | sky |
| `licensed`, `flexi`, `thambili` | teal / sky / teal | *(none)* | any |

  Variants are named `<badge>-<colour>.svg` and live beside the originals in `img/icons/badges/`.

---

## Verified findings this plan depends on

Two things were checked in a browser before writing this plan. Both change what the tasks must do:

1. **`index.html:299` has `box-shadow:var(--shadow-s)` on `.val .ico`.** The badge discs are wobbly blobs, not circles, so a box-shadow on the element's circular border-box renders a **visible white halo ring** around the badge. It must be removed as part of Task 2. `why.html:52` and `about.html:47` have `border-radius:50%` but **no** box-shadow — tested, and the blob fits inside the clip with ~2px to spare, so those two pages need **no CSS change**.

2. **`board.html` has no numbered card row.** The "1. / 2. / 3." I referenced earlier is inline bold text inside a `<details>` FAQ answer (`board.html`, "How does the board work?") — not a card grid, and not an icon slot. The real board slots are `.gb-ico` (40px circle, 22px inline svg) and `.on-hero>svg` (24px), and both are rendered from **`board.js`**, not `board.html`. They are line-icon slots, handled in Task 7.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `img/icons/badges/{door-to-door-sky,pro-hopper-teal,rate-lock-sky}.svg` | **Create.** Recoloured variants so each row rotates | 2a |
| `web-tests/unit/icon-slots.test.js` | **Create.** Pins: every `img.ico` src exists on disk; the three `.val` rows have three *distinct* srcs each | 1 |
| `index.html:299` | **Modify.** Drop `box-shadow` from `.val .ico` | 2 |
| `index.html:522-524` | **Modify.** 3 badge swaps (variants from Task 2a) | 2 |
| `why.html:138-140` | **Modify.** 3 badge swaps | 3 |
| `about.html:111-113` | **Modify.** 3 badge swaps — different badges from why.html | 3 |
| `why.html:47-53,150-153` | **Modify.** Badges into the four `.step-card`s + CSS for the new element | 4 |
| `tours.html:100-103,143-158` | **Modify.** Badges into the three `.hiw` cards + CSS | 5 |
| `index.html:420-424` | **Modify.** 4 of 5 trust-row marks → line icons | 6 |
| `board.js:770,802` | **Modify.** 2 inline marks → line icons | 7 |
| `plan.html:108` + markup | **Modify.** `.rail-empty` mark → line icon | 8 |

---

### Task 1: Regression test for icon slots

The test that would have caught the bug this rollout exists to fix — `why.html` and `about.html` currently show the *same three PNGs* under different labels ("Fair" vs "Affordable"). Write it first, watch it fail on that duplication, then let Tasks 2–3 turn it green.

**Files:**
- Create: `web-tests/unit/icon-slots.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing importable. Later tasks must keep this file green.

- [ ] **Step 1: Write the failing test**

Create `web-tests/unit/icon-slots.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../../tools/generate-route-pages.mjs';

const read = p => readFileSync(join(ROOT, p), 'utf8');

// Every page that carries a `.val` value-proposition row. Each row is three cards;
// each card must have its own icon, or the row is saying one thing three times.
const VAL_PAGES = ['index.html', 'why.html', 'about.html'];

/** Every `src` on an `<img class="ico">`, in document order. */
function icoSrcs(html) {
  return [...html.matchAll(/<img[^>]*class="ico"[^>]*>/g)]
    .map(([tag]) => (tag.match(/src="([^"]+)"/) || [])[1])
    .filter(Boolean);
}

describe('icon slots', () => {
  for (const page of VAL_PAGES) {
    it(`${page}: every icon file it points at actually exists`, () => {
      const missing = icoSrcs(read(page)).filter(src => !existsSync(join(ROOT, src)));
      expect(missing).toEqual([]);
    });

    it(`${page}: no two value cards share the same icon`, () => {
      const srcs = icoSrcs(read(page));
      expect(srcs.length).toBeGreaterThan(0);
      expect(new Set(srcs).size).toBe(srcs.length);
    });
  }

  it('why.html and about.html do not reuse each other’s icons', () => {
    const why = new Set(icoSrcs(read('why.html')));
    const about = icoSrcs(read('about.html'));
    const shared = about.filter(src => why.has(src));
    expect(shared).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails on the real duplication**

```bash
cd web-tests && npx vitest run unit/icon-slots.test.js
```

Expected: the two "exists" tests and the two per-page "no two cards share" tests **PASS** (today each page's three PNGs are distinct within the page). The cross-page test **FAILS**:

```
AssertionError: expected [ 'img/icons/flexible-routes.png', …3 items ] to deeply equal []
```

That failure is the bug — `why.html` and `about.html` use all three of the same images.

- [ ] **Step 3: Commit the failing test**

```bash
git add web-tests/unit/icon-slots.test.js
git commit -m "test(icons): pin icon-slot wiring — files exist, no card reuses another's mark

Fails today on why.html/about.html, which show the same three PNGs under
different labels (\"Fair\" vs \"Affordable\"). Tasks 2-3 turn it green."
```

Leave it red on the branch — Task 3 fixes it. Do **not** open a PR until Task 3 is done; CI must be green to merge.

---

### Task 2a: three recoloured badge variants

Every three-card row must rotate teal · sky · saffron. The plan's chosen subjects do not, so three of them get a recoloured variant. Subjects stay; only the disc changes.

**Files:**
- Create: `img/icons/badges/door-to-door-sky.svg`, `img/icons/badges/pro-hopper-teal.svg`, `img/icons/badges/rate-lock-sky.svg`
- Modify: `img/icons/badges/README.md`

**Interfaces:**
- Produces: the three filenames above. Task 2 uses `door-to-door-sky` and `pro-hopper-teal`; Task 3 uses `rate-lock-sky`.

- [ ] **Step 1: Make each variant by copying the original and changing only the disc fill**

The disc is the **first** `<path>` in the file — a bare `<path d="…" fill="#COLOR"/>` that sits *before* the filtered `<g>` blocks. **It carries no `filter` attribute of its own** (the filter lives on the `<g>` that wraps the artwork), so do not try to match on one — a `fill="…" filter` pattern matches nothing and silently produces an unchanged copy. Anchor on the first `<path>` line instead, and diff the result to confirm exactly one `fill` changed.

Brand colours: teal `#0DB9B6`, sky `#34C2D9`, saffron `#F9A429`.

- [ ] **Step 2: Fix the accent that `pro-hopper-teal` swallows**

`pro-hopper` has a **teal** cap button. On a teal disc it disappears. In `pro-hopper-teal.svg` only, change that one inner `fill="#0DB9B6"` (a `<circle>`, not the disc `<path>`) to saffron `#F9A429`.

`door-to-door-sky` and `rate-lock-sky` need no accent fix — verified: `door-to-door` has no sky inside, and `rate-lock`'s only inner accent is a saffron stroke, which does not conflict with a sky disc.

- [ ] **Step 3: Verify each variant renders and kept its accents**

For each of the three files, load it in a headless browser and screenshot at 120px. Confirm: the disc is the intended colour, the artwork is intact, and no inner shape has vanished into the disc. On `pro-hopper-teal.svg` specifically, confirm the cap button is visible and saffron.

- [ ] **Step 4: Document the variants**

In `img/icons/badges/README.md`, under "## The set", add:

```markdown
## Colour variants

Every three-card row rotates teal · sky · saffron, so a few badges exist in a second disc
colour. Named `<badge>-<colour>.svg`:

`door-to-door-sky` · `pro-hopper-teal` · `rate-lock-sky`

Recolouring a disc can swallow an inner accent that shares the new colour — `pro-hopper-teal`
has its cap button in saffron for exactly that reason. Check the artwork after any recolour.
`hop-van` carries both teal and sky inside and therefore has no variant: it stays saffron.
```

- [ ] **Step 5: Commit**

```bash
git add img/icons/badges/door-to-door-sky.svg img/icons/badges/pro-hopper-teal.svg img/icons/badges/rate-lock-sky.svg img/icons/badges/README.md
git commit -m "feat(icons): recoloured badge variants so every row rotates its discs

The set's own rule is teal - sky - saffron across a row. pro-hopper-teal
moves its cap button to saffron, which the teal disc would otherwise
swallow. hop-van carries both teal and sky inside, so it has no variant."
```

---

### Task 2: index.html — WITHDRAWN (owner call, 2026-07-29)

**Do not implement. `index.html` stays exactly as it is on `main`.**

The three homepage value-row icons — `hop-on-hop-off.png`, `change-the-route.png`,
`book-your-seat.png` — are the **reference artwork** the whole badge set was drawn to match.
They were shared as the inspiration for the style, not as slots to fill. Replacing them was a
misreading of the brief.

Consequences, all applied:

- The three `src` swaps and the `.val .ico` `box-shadow` removal on `index.html` are reverted.
  The shadow is *correct* for the original PNGs — they are true circles, so a circular
  box-shadow fits them exactly. The halo problem only arises with the blob-shaped badge discs,
  which no longer appear on that page.
- `door-to-door-sky.svg` and `pro-hopper-teal.svg` existed only to rotate that row's discs.
  With the row unchanged they are unused, and are removed. `rate-lock-sky.svg` stays — `why.html`
  uses it.
- The disc-rotation test must ignore non-SVG icons, or it will try to read a `<path fill>` out
  of a PNG. `index.html` legitimately carries three PNGs now.
- Rows still rotate where badges are used: `why.html` saffron · teal · sky, `about.html`
  sky · saffron · teal.

Scope for the rest of the rollout is unchanged: Tasks 4–8 add icons to slots that have **no**
artwork today, and never touch the three reference icons.

---

### Task 3: why.html + about.html — six swaps, and the duplication ends

The two pages get **different** badges. That is the point of the task: today they share all three PNGs.

**Files:**
- Modify: `why.html:138-140`, `about.html:111-113`

**Interfaces:**
- Consumes: `img/icons/badges/{free-cancel,licensed,rate-lock-sky,flexi,pro-hopper,thambili}.svg`. `rate-lock-sky` comes from Task 2a. why.html reads **saffron · teal · sky**; about.html reads **sky · saffron · teal**.
- Produces: turns the Task 1 cross-page test green.

- [ ] **Step 1: Swap why.html**

`why.html:138-140` — change `src` only:

| Line | Heading | To |
|---|---|---|
| 138 | Flexible | `img/icons/badges/free-cancel.svg` (the sesath — "we've got you covered") |
| 139 | Safe | `img/icons/badges/licensed.svg` |
| 140 | Fair | `img/icons/badges/rate-lock-sky.svg` (the Ceylon sapphire, sky disc so the row rotates) |

Line 138 becomes:

```html
      <div class="val"><img class="ico" src="img/icons/badges/free-cancel.svg" alt="" width="70" height="70" loading="lazy"><h3>Flexible</h3><p>Free changes and cancellation — up to 24 hours before a transfer, or 10 days before a chauffeur-guide tour.</p></div>
```

- [ ] **Step 2: Swap about.html**

`about.html:111-113` — deliberately different marks:

| Line | Heading | To |
|---|---|---|
| 111 | Flexible | `img/icons/badges/flexi.svg` |
| 112 | Safe | `img/icons/badges/pro-hopper.svg` |
| 113 | Affordable | `img/icons/badges/thambili.svg` |

Line 111 becomes:

```html
      <div class="val"><img class="ico" src="img/icons/badges/flexi.svg" alt="" width="70" height="70" loading="lazy"><h3>Flexible</h3><p>Change dates, times and stops up to the day before &mdash; your trip flexes with you.</p></div>
```

- [ ] **Step 3: Confirm no CSS change is needed**

Do **not** touch `why.html:52` or `about.html:47`. They have `border-radius:50%` and no box-shadow; the blob fits inside the clip with room to spare. This was tested — leave them alone.

- [ ] **Step 4: Run the tests — all green now**

```bash
cd web-tests && npm run test:unit
```

Expected: **PASS, including the cross-page test.** If it still fails, two pages are sharing a badge — fix the src, don't weaken the test.

- [ ] **Step 5: Verify in the browser**

```bash
open why.html && open about.html
```

Both rows: three badges each, six distinct marks across the two pages.

- [ ] **Step 6: Commit, then open the PR for Tasks 1–3 together**

```bash
git add why.html about.html
git commit -m "feat(site): distinct badge icons on why + about

why.html and about.html shipped the same three PNGs under different labels
(\"Fair\" vs \"Affordable\") — same picture, two different claims. Each page
now carries its own marks. Pinned by web-tests/unit/icon-slots.test.js."
git push -u origin feat/icons-value-rows
gh pr create --base main --head feat/icons-value-rows \
  --title "Badge icons on the three value rows, and a test that pins icon slots" \
  --body 'Swaps six PNGs for badge SVGs across `index.html`, `why.html` and `about.html`, and adds `web-tests/unit/icon-slots.test.js`.

The test catches a real bug this fixes: `why.html` and `about.html` shipped the **same three PNGs** under different labels ("Fair" vs "Affordable") — same picture, two different claims. It asserts every `img.ico` src exists on disk, that no two cards in a row share a mark, and that the two pages do not reuse each other'"'"'s.

Also drops `box-shadow` from `index.html` `.val .ico`: the badge disc is a hand-drawn blob, and a shadow on the element'"'"'s circular border-box draws a visible white ring around it. Verified in a browser.

Additive and visual only — no backend, no generated files.'
```

**This is the Tier 1 PR.** Tasks 4+ are separate branches off `main` after this merges.

---

### Task 4: why.html — the four steps get badges

`why.html:150-153` is four `.step-card`s carrying a bare number. The biggest visual gap on the site: a whole explainer section with no imagery.

**Files:**
- Modify: `why.html:47-50` (CSS), `why.html:150-153` (markup)

**Interfaces:**
- Consumes: `img/icons/badges/{door-to-door,zero-coin,locked-in,pro-hopper}.svg`. (`secure-pay` exists **only** in `img/icons/line/` — it is a 24px stroke mark, not a badge. Do not reach for it here.)

- [ ] **Step 1: Add the CSS for the badge inside a step card**

After `why.html:48` (`.step-card .num{…}`), add:

```css
  .step-card{position:relative}
  /* the badge sits opposite the number, top-right, so the number keeps its reading order */
  .step-card .step-ico{position:absolute;top:18px;right:18px;width:46px;height:46px}
  @media (max-width:560px){ .step-card .step-ico{width:38px;height:38px;top:16px;right:16px} }
```

- [ ] **Step 2: Add the four badges**

`why.html:150-153`. Each line gains one `<img>` directly after the opening `<div class="step-card">`:

| Line | Step | Badge |
|---|---|---|
| 150 | Tell us where | `door-to-door.svg` |
| 151 | See your fixed price | `zero-coin.svg` |
| 152 | Book in minutes | `locked-in.svg` |
| 153 | Your driver, your door | `pro-hopper.svg` |

Line 150 becomes:

```html
      <div class="step-card"><img class="step-ico" src="img/icons/badges/door-to-door.svg" alt="" width="46" height="46" loading="lazy"><div class="num">1</div><h3>Tell us where</h3><p>Pick-up, drop-off &mdash; any two points on the island. Add stops if you like.</p></div>
```

Note the class is `step-ico`, **not** `ico` — the Task 1 test only governs `.val` rows, and these are not value cards.

- [ ] **Step 3: Verify in the browser at both widths**

```bash
open why.html
```

Desktop: badge top-right of each card, number top-left, headline clears both. Then narrow the window under 560px and confirm the badge shrinks and never overlaps the `<h3>`.

- [ ] **Step 4: Run the tests**

```bash
cd web-tests && npm run test:unit
```

Expected: PASS (571+ tests).

- [ ] **Step 5: Commit**

```bash
git add why.html
git commit -m "feat(why): badge per step in Four simple steps

The section carried a bare number and no imagery. Badge sits opposite the
number so reading order is untouched. Verified desktop and <560px."
```

---

### Task 5: tours.html — the three how-it-works cards get badges

Same shape as Task 4, different class names (`.hiw` / `.hiw-n`).

**Files:**
- Modify: `tours.html:100-103` (CSS), `tours.html:143-158` (markup)

**Interfaces:**
- Consumes: `img/icons/badges/{ella-train,ambalama,chauffeur}.svg`.

- [ ] **Step 1: Add the CSS**

After `tours.html:101` (`.hiw-n{…}`), add:

```css
  .hiw{position:relative}
  .hiw .hiw-ico{position:absolute;top:18px;right:18px;width:46px;height:46px}
  @media (max-width:560px){ .hiw .hiw-ico{width:38px;height:38px;top:16px;right:16px} }
```

- [ ] **Step 2: Add the three badges**

| Card | Heading | Badge |
|---|---|---|
| 1 | Pick a route & your dates | `ella-train.svg` |
| 2 | Book your own hotels | `ambalama.svg` (the wayside rest — where you stop for the night) |
| 3 | We handle the road | `chauffeur.svg` |

Card 1 becomes:

```html
      <div class="hiw">
        <img class="hiw-ico" src="img/icons/badges/ella-train.svg" alt="" width="46" height="46" loading="lazy">
        <span class="hiw-n">1</span>
        <h3>Pick a route &amp; your dates</h3>
        <p>Choose a tour below, set your start date and how many of you are travelling. Tweak any day &mdash; add, drop or swap stops.</p>
      </div>
```

- [ ] **Step 3: Verify in the browser**

```bash
open tours.html
```

- [ ] **Step 4: Run the tests**

```bash
cd web-tests && npm run test:unit
```

- [ ] **Step 5: Commit**

```bash
git add tours.html
git commit -m "feat(tours): badge per card in the three-step row"
```

---

### Task 6: index.html — trust row onto the line-icon family

Five generic stroke marks today, none sharing a family cue. Four have direct replacements that carry the waypoint dot; the fifth (AC cars & vans) has no equivalent and **stays as-is**.

**Files:**
- Modify: `index.html:207` (CSS), `index.html:420,422,423,424` (markup)

**Interfaces:**
- Consumes: `img/icons/line/{backed,shared-van,free-cancel,whatsapp-7d}.svg` — inlined, not `<img>`'d.

- [ ] **Step 1: Let the waypoint dot take the brand colour**

`index.html:207` currently:

```css
  .trust-row svg{width:32px;height:32px;padding:7px;flex:none;color:#39d6d0;background:rgba(10,185,182,.13);border-radius:50%}
```

Add immediately after it:

```css
  /* the family mark: one filled waypoint dot per icon, in saffron against the teal */
  .trust-row svg .wp{fill:var(--saffron);stroke:none}
```

- [ ] **Step 2: Replace four of the five inline SVGs**

Copy the inner paths from each file — the `<svg>` wrapper attributes on the page stay exactly as they are.

Line 420 (`Fully insured & safe drivers`), from `img/icons/line/backed.svg`:

```html
    <div class="item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 5 5.6v5.6c0 4.6 3 7.6 7 9.8 4-2.2 7-5.2 7-9.8V5.6z"/><path d="m8.8 11.7 2.4 2.4 4.2-4.6"/><circle class="wp" cx="12" cy="3" r="1.4"/></svg> Fully insured &amp; safe drivers</div>
```

Line 422 (`Shared seats every Wed & Sat`):

```html
    <div class="item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 16.5v-6a1 1 0 0 1 1-1h9l3.5 3.5H19a1 1 0 0 1 1 1v2.5"/><path d="M4.5 16.5H5m9.6 0H9.4m9.2 0h.9"/><circle cx="7.2" cy="16.8" r="1.8"/><circle cx="16.8" cy="16.8" r="1.8"/><path d="M4.5 5.5C8 3.9 11.5 7 15 5.4" stroke-dasharray="2.6 2.6"/><circle class="wp" cx="18.5" cy="4.8" r="1.5"/></svg> Shared seats every Wed &amp; Sat</div>
```

Line 423 (`Free cancellation up to 24h before`):

```html
    <div class="item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 9.5h17M8 2.8V6M16 2.8V6"/><path d="M15.3 14.6a3.3 3.3 0 1 0 .6 2.4"/><path d="M15.9 12.4v2.4h-2.4"/><circle class="wp" cx="8" cy="2.8" r="1.2"/></svg> Free cancellation up to 24h before</div>
```

Line 424 (`WhatsApp support 7 days`):

```html
    <div class="item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.5a2 2 0 0 1-2 2H7.5l-4 3.5V5.5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/><circle cx="8.5" cy="10" r=".4"/><circle cx="15.5" cy="10" r=".4"/><circle class="wp" cx="12" cy="10" r="1.3"/></svg> WhatsApp support 7 days</div>
```

**Leave line 421 (`AC cars & vans`) untouched** — there is no line icon for it yet.

- [ ] **Step 3: Verify in the browser, including the mobile scroller**

```bash
open index.html
```

Trust row: four marks now carry a saffron dot, the AC one does not (expected). Narrow under 720px and confirm the horizontal scroll-snap row still works.

- [ ] **Step 4: Run the tests**

```bash
cd web-tests && npm run test:unit
```

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat(home): trust row onto the line-icon family

Four of five marks now carry the waypoint dot. AC cars & vans has no line
icon yet and is deliberately unchanged."
```

---

### Task 7: board.js — the two guarantee marks

Both are rendered from JS, not from `board.html`. `.gb-ico` is a 40px teal circle holding a 22px white mark; `.on-hero>svg` is a 24px mark.

**Files:**
- Modify: `board.js:770`, `board.js:802`

**Interfaces:**
- Consumes: `img/icons/line/{backed,locked-in}.svg`.

- [ ] **Step 1: Swap the guarantee-banner shield**

`board.js:770`. The existing shield is already close; the change is the family dot. Replace the two `<path>`s inside the `.gb-ico` svg so the fragment reads:

```js
      '<div class="guarantee-banner"><span class="gb-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 5 5.6v5.6c0 4.6 3 7.6 7 9.8 4-2.2 7-5.2 7-9.8V5.6z"/><path d="m8.8 11.7 2.4 2.4 4.2-4.6"/><circle class="wp" cx="12" cy="3" r="1.4"/></svg></span>' +
```

Keep the trailing `+` and the surrounding string concatenation exactly as they are — this line is one term in a larger expression.

- [ ] **Step 2: Swap the on-list tick**

`board.js:802` — replace the single `<path d="M20 6 9 17l-5-5"/>` with `locked-in.svg`'s inner paths, so the svg opening through closing tag reads:

```js
'<div class="on-hero"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5" stroke-dasharray="3.3 3.3"/><path d="m8.3 12.3 2.6 2.6 4.8-5.4"/><circle class="wp" cx="12" cy="3.5" r="1.5"/></svg><div><b>You\'re on this list'
```

The rest of that line — the seat-count ternary, the `conf` branch, the escaped apostrophes — is untouched.

- [ ] **Step 3: Make the dot legible on both backgrounds**

The `.gb-ico` mark is white on teal; the `.on-hero` mark is teal on pale teal. Add to `board.html`'s style block, next to the existing `.gb-ico` rules (~line 476):

```css
.gb-ico svg .wp{fill:#fff;stroke:none}
.on-hero>svg .wp{fill:var(--saffron);stroke:none}
```

- [ ] **Step 4: Verify against a real list**

```bash
open board.html
```

Join a seeded list so both states render. If the board API isn't reachable locally, see `docs/known-bugs.md` and the memory note on `board.html` defaulting to the **prod** API — do not point it at prod to test this.

- [ ] **Step 5: Run the full suite (board has e2e coverage)**

```bash
cd web-tests && npm run test:all
```

If the Ride Board e2e specs fail with "#login not found", a foreign process owns port 8787 — kill it and re-run. That is not a regression from this change.

- [ ] **Step 6: Commit**

```bash
git add board.js board.html
git commit -m "feat(board): guarantee marks onto the line-icon family"
```

---

### Task 8: plan.html — the empty-state mark

**Files:**
- Modify: `plan.html:108` (CSS) and the `.rail-empty` markup

**Interfaces:**
- Consumes: `img/icons/line/pickup.svg`.

- [ ] **Step 1: Find the markup**

```bash
grep -n 'class="rail-empty"' plan.html
```

- [ ] **Step 2: Replace the inline svg's paths** with `pickup.svg`'s, keeping the wrapper attributes the page already uses:

```html
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-4.7-7-10a7 7 0 0 1 14 0c0 5.3-7 10-7 10z"/><circle class="wp" cx="12" cy="11" r="2"/></svg>
```

- [ ] **Step 3: Colour the dot**

After `plan.html:108`, add:

```css
  .rail-empty svg .wp{fill:var(--accent);stroke:none}
```

- [ ] **Step 4: Verify** — open `plan.html` with an empty itinerary so the empty state shows.

- [ ] **Step 5: Run tests and commit**

```bash
cd web-tests && npm run test:unit
git add plan.html
git commit -m "feat(plan): empty-state mark onto the line-icon family"
```

---

## Deferred — do not start without a fresh go from the owner

### Task 9: route pages (60 files) — **generator change, not a page edit**

`trip/*/index.html` are produced by `tools/generate-route-pages.mjs`. Per the drift rules, they change **via the generator plus `npm run generate`**, never by hand. A per-corridor place badge (`ella-train` for hill country, `palm-coast` for the south, `paw` for Yala, `dagoba` for the cultural triangle) would be strong, but it needs: a corridor→badge map, a generator template change, a regenerate across 60 files, and the `seo-codegen` freshness gate to stay green. Its own spec and its own PR.

### Task 10: the 12 customer emails — **needs raster, not SVG**

`api/src/services/notifications.ts` renders 12 templates and currently uses **zero images**. **Outlook desktop does not render SVG**, so badges in email means PNG exports plus either hosted URLs on the API host or CID attachments — real infrastructure, plus a deliverability question (remote images are often blocked by default, which would leave a broken box at the top of every email). Not an icon rollout; a separate piece of work.

## Explicitly out of scope

- `index.html:465-467` "what's included" — three identical check marks are **correct**. A checklist should scan as a checklist; distinct pictures would weaken the "it's all included" read.
- `credits.html`, `manage.html` — attribution and transactional-error pages. An icon there is decoration, not information.
- `ops-ui.html` — the ops line icons (`hot-zone`, `route-compare`, `assign`, `demand-map`, `send-quote`, `night-watch`) map onto real features, but the ops app is in daily internal use and its nav was redesigned on 2026-07-23. Worth doing, worth asking first.

## PR grouping

| PR | Tasks | Scope |
|---|---|---|
| 1 | 1, 2, 3 | Tier 1 — the three value rows + the regression test |
| 2 | 4, 5 | Tier 2 — the step/card rows that had no visual |
| 3 | 6, 7, 8 | Tier 3 — line icons into inline UI |

Each off a fresh worktree from `origin/main`, merged before the next starts.
