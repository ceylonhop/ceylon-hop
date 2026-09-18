# Ride Board Rows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ride board's card grid with day-grouped, scannable rows (spec: `docs/superpowers/specs/2026-09-18-ride-board-rows-design.md`).

**Architecture:** Four pure helpers (`windowLabel`, `durationOf`, `groupByDay`, `rowState`) are added to `board.js` and exported on `window.RideBoard`, unit-tested in jsdom. A new `rowHtml(L)` replaces `card(L)`; `render()` groups rows by day. Card-only CSS in `board.html` is replaced by `.rw*` rules with desktop / ≤1020px / ≤640px layouts.

**Tech Stack:** Vanilla ES5 browser IIFE (`board.js`), inline CSS in `board.html`, Vitest + jsdom (`web-tests/unit`), Playwright (`web-tests/e2e`), `npm run generate` (asset `?v=` stamps).

## Global Constraints
- Front-end only: `board.js`, `board.html`, `web-tests/**`, docs. No API, pricing, config, schema or generated-block edits.
- `board.js` stays ES5-style (`var`, `function`, no arrow functions) — match the file.
- Keep the hooks `data-view`, `data-again`, `data-code`, `#board-grid`, `.bskel`, `#start-bar-btn`, `.board-empty`.
- Ride sheet, modals, start bar style, intro copy: untouched.
- After editing any root asset run `cd /Users/roshenw/claude_code/ceylon-hop-wt-board-rows && npm run generate` or `asset-versions.test.js` fails.
- Gate before commit: `cd web-tests && npm run test:all` green; `cd api && npm run check` green.
- Dates in fixtures are 2099 (never rot into the past).

---

### Task 1: Pure row helpers

**Files:**
- Modify: `board.js` (SLOTS ~33-36; helpers after `whenLine` ~152; exports ~301-318)
- Test: `web-tests/unit/ride-board-rows.test.js` (create)

**Interfaces — Produces:**
- `windowLabel(slot: string) → '7–9 am' | '1–3 pm'` (unknown slot → morning)
- `durationOf(L: {corridorId}) → string` e.g. `'~4h'`, `''` when unknown
- `groupByDay(lists: L[]) → Array<{ date: string|null, label: string, lists: L[] }>` sorted by date asc (null last), morning before afternoon, input order otherwise
- `rowState(L, mine: boolean) → { cls: 'g'|'l'|'f', label: string, sub: string, cta: { kind: 'view'|'again', text: string } }`

- [ ] **Step 1: Write the failing test** — `web-tests/unit/ride-board-rows.test.js`

```js
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTransfers } from './_load.js';

// Pure helpers behind the row layout of the ride board (spec 2026-09-18-ride-board-rows).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

let RB;
beforeAll(() => {
  loadTransfers();
  // eslint-disable-next-line no-new-func
  new Function(readFileSync(path.join(ROOT, 'board.js'), 'utf8'))();
  RB = window.RideBoard;
});

const L = (o) => ({ minSeats: 4, capacity: 6, committed: 1, confirmed: false, slot: 'morning', ...o });

describe('windowLabel — departures are 2-hour windows, never a clock time', () => {
  it('names each slot by its window', () => {
    expect(RB.windowLabel('morning')).toBe('7–9 am');
    expect(RB.windowLabel('afternoon')).toBe('1–3 pm');
  });
  it('falls back to the morning window like slotWindow does', () => {
    expect(RB.windowLabel('nonsense')).toBe('7–9 am');
  });
});

describe('durationOf — the only fact under a route', () => {
  it('trims the corridor time to the duration', () => {
    expect(RB.durationOf({ corridorId: 'airport-cultural' })).toBe('~4h');
    expect(RB.durationOf({ corridorId: 'south-coast' })).toBe('~1.5h');
  });
  it('says nothing for an unknown corridor rather than guessing', () => {
    expect(RB.durationOf({ corridorId: 'nowhere' })).toBe('');
    expect(RB.durationOf({})).toBe('');
  });
});

describe('groupByDay — day headings in date order, morning before afternoon', () => {
  it('groups, sorts days and sorts slots within a day', () => {
    const a = L({ code: 'A', date: '2099-08-16', slot: 'morning' });
    const b = L({ code: 'B', date: '2099-08-15', slot: 'afternoon' });
    const c = L({ code: 'C', date: '2099-08-15', slot: 'morning' });
    const g = RB.groupByDay([a, b, c]);
    expect(g.map((d) => d.date)).toEqual(['2099-08-15', '2099-08-16']);
    expect(g[0].lists.map((x) => x.code)).toEqual(['C', 'B']);
    expect(g[0].label).toBe('Sat 15 Aug');
  });
  it('puts a list with no date last instead of dropping it', () => {
    const g = RB.groupByDay([L({ code: 'N', date: null }), L({ code: 'D', date: '2099-08-15' })]);
    expect(g.map((d) => d.lists[0].code)).toEqual(['D', 'N']);
    expect(g[1].label).toBe('Date to be set');
  });
  it('handles an empty board', () => {
    expect(RB.groupByDay([])).toEqual([]);
  });
});

describe('rowState — one coloured state and one action per row', () => {
  it('gathering: amber count, how many more, Hop on', () => {
    const s = RB.rowState(L({ committed: 3 }), false);
    expect(s).toEqual({ cls: 'g', label: '3 of 4 in', sub: 'needs 1 more', cta: { kind: 'view', text: 'Hop on' } });
  });
  it('minimum reached but still gathering: green, seats left, still Hop on (#599)', () => {
    const s = RB.rowState(L({ committed: 4 }), false);
    expect(s.cls).toBe('l');
    expect(s.label).toBe('Locked in');
    expect(s.sub).toBe('2 seats left');
    expect(s.cta).toEqual({ kind: 'view', text: 'Hop on' });
  });
  it("confirmed (cutoff passed): no join invitation — See who's going (#597)", () => {
    const s = RB.rowState(L({ committed: 5, confirmed: true }), false);
    expect(s.sub).toBe('1 seat left');
    expect(s.cta).toEqual({ kind: 'view', text: "See who's going" });
  });
  it('full and not yours: grey, Start another van', () => {
    const s = RB.rowState(L({ committed: 6, confirmed: true }), false);
    expect(s).toEqual({ cls: 'f', label: 'Full', sub: '6 of 6', cta: { kind: 'again', text: 'Start another van' } });
  });
  it("yours: View your ride, and the state says you're on it", () => {
    expect(RB.rowState(L({ committed: 2 }), true)).toMatchObject({
      sub: "needs 2 more · you're on it", cta: { kind: 'view', text: 'View your ride' },
    });
    expect(RB.rowState(L({ committed: 6, confirmed: true }), true).cta).toEqual({ kind: 'view', text: 'View your ride' });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd /Users/roshenw/claude_code/ceylon-hop-wt-board-rows/web-tests && npx vitest run unit/ride-board-rows.test.js`
Expected: FAIL — `RB.windowLabel is not a function` (and the other three).

- [ ] **Step 3: Implement in `board.js`**

SLOTS gains a `win` field:
```js
  var SLOTS = {
    morning: { label: 'morning', range: 'departs 7–9 am', win: '7–9 am', opts: ['07:00', '08:00', '09:00'] },
    afternoon: { label: 'afternoon', range: 'departs 1–3 pm', win: '1–3 pm', opts: ['13:00', '14:00', '15:00'] }
  };
```
After `whenLine`:
```js
  /* ---------------- board rows (pure) ---------------- */
  // A row always shows the 2-hour window, never a pinned clock time: every other row is still
  // gathering on a window, and a column mixing "08:30" with "7–9 am" stops scanning.
  function windowLabel(slot) { return slotWindow(slot).win; }

  // "~4h door to door" → "~4h" — duration is the one fact that sits under a route.
  function durationOf(list) {
    var t = list && CORRIDOR_TIME[list.corridorId];
    return t ? t.replace(/\s*door to door$/, '') : '';
  }

  var SLOT_ORDER = { morning: 0, afternoon: 1 };
  // Day headings in date order; morning before afternoon; a dateless list goes last, not missing.
  function groupByDay(lists) {
    var sorted = (lists || []).map(function (L, i) { return { L: L, i: i }; }).sort(function (a, b) {
      var da = a.L.date || '￿', db = b.L.date || '￿';
      if (da !== db) return da < db ? -1 : 1;
      var sa = SLOT_ORDER[a.L.slot] || 0, sb = SLOT_ORDER[b.L.slot] || 0;
      return sa !== sb ? sa - sb : a.i - b.i;
    });
    var groups = [];
    sorted.forEach(function (x) {
      var last = groups[groups.length - 1];
      var date = x.L.date || null;
      if (!last || last.date !== date) {
        last = { date: date, label: date ? fmtDate(date) : 'Date to be set', lists: [] };
        groups.push(last);
      }
      last.lists.push(x.L);
    });
    return groups;
  }

  // One coloured seat state and one action per row. The action rules are #597/#599's: a
  // confirmed list is past its cutoff and the join route refuses it, so it never says "Hop on";
  // a list that has only reached its minimum is still gathering and still takes joiners.
  function rowState(list, mine) {
    var min = list.minSeats, cap = list.capacity;
    var need = Math.max(0, min - list.committed);
    var left = Math.max(0, cap - list.committed);
    var you = mine ? " · you're on it" : '';
    var cta = mine ? { kind: 'view', text: 'View your ride' }
      : left === 0 ? { kind: 'again', text: 'Start another van' }
      : list.confirmed ? { kind: 'view', text: "See who's going" }
      : { kind: 'view', text: 'Hop on' };
    if (left === 0) return { cls: 'f', label: 'Full', sub: list.committed + ' of ' + cap + you, cta: cta };
    if (list.confirmed || need === 0) {
      return { cls: 'l', label: 'Locked in', sub: left + ' seat' + (left === 1 ? '' : 's') + ' left' + you, cta: cta };
    }
    return { cls: 'g', label: list.committed + ' of ' + min + ' in', sub: 'needs ' + need + ' more' + you, cta: cta };
  }
```
Exports (next to `whenLine: whenLine,`):
```js
    windowLabel: windowLabel,
    durationOf: durationOf,
    groupByDay: groupByDay,
    rowState: rowState,
```

- [ ] **Step 4: Run it to see it pass**

Run: `cd web-tests && npx vitest run unit/ride-board-rows.test.js unit/ride-board.test.js`
Expected: PASS (both files).

- [ ] **Step 5: Commit**
```bash
git add board.js web-tests/unit/ride-board-rows.test.js
git commit -m "feat(board): pure helpers for the row layout — window, duration, day groups, row state"
```

---

### Task 2: Render rides as rows

**Files:**
- Modify: `board.js` — replace `listRows`, `rosterStrip`, `card` (~480-613) with `faces`/`rowHtml`/`routeInvite`; rewrite `render` (~618-672), `playSeatFills` (~683-706), `refreshMineCodes` selector (~869), `renderFilters` (~766-768), `showSkeleton` (~784-795); remove `MOBILE_CAP`.
- Modify: `board.html` — replace card CSS (~117-121 `.board` grid, ~124-136 skeleton, ~140-206 `.lcard*`/`.lrow`/`.tear`/`.stamp`/`.lprice`/`.lcard-new`, ~483-488 roster/board-more, ~497-500 hot/mine/mine-tag, ~606-622 phone card rules) with `.rw*`; update the start-bar comment (~953).
- Modify: `web-tests/e2e/ride-board-locked-cta.spec.js`, `ride-board-full-van.spec.js`, `ride-board-load.spec.js`, `ride-board-share-link.spec.js`, `web-tests/unit/display-weight-and-icon-stroke.test.js`.
- Test: `web-tests/e2e/ride-board-rows.spec.js` (create)

**Interfaces — Consumes:** Task 1's `windowLabel`, `durationOf`, `groupByDay`, `rowState`; existing `avatar(m, i, cls)`, `money`, `esc`, `iAmOn`, `openDetail(code)`, `startAnother(code)`, `openModal(null, prefill)`, `observe()`.

- [ ] **Step 1: Write the failing e2e** — `web-tests/e2e/ride-board-rows.spec.js`

```js
import { test, expect } from '@playwright/test';
import { isApiRequest } from './_api-host.js';

// The board as rows (spec 2026-09-18-ride-board-rows). Pins what the row layout promises:
// day headings in order, the 2-hour window, columns that never collide, and a phone row
// that stays a row.

const member = (n, c, extra = {}) => ({ firstName: n, country: c, photoUrl: null, ...extra });
const base = { corridorId: 'airport-cultural', from: 'Colombo Airport (CMB)', to: 'Sigiriya / Dambulla',
  minSeats: 4, capacity: 6, seatPrice: 1900, status: 'gathering', note: null, lockedTime: null,
  cutoffAt: '2099-08-10T00:00:00.000Z' };
const LISTS = [
  { ...base, code: 'RW-3', date: '2099-08-16', slot: 'morning', committed: 1, members: [member('Priya', 'CA', { isStarter: true })] },
  { ...base, code: 'RW-2', date: '2099-08-15', slot: 'afternoon', committed: 2, members: [member('Jo', 'NL', { isStarter: true }), member('So', 'ES')] },
  { ...base, code: 'RW-1', date: '2099-08-15', slot: 'morning', committed: 3,
    members: [member('Anna', 'PL', { isStarter: true }), member('Yuki', 'JP'), member('Ben', 'IE')] },
];

async function stubApi(page, lists = LISTS) {
  await page.route((u) => isApiRequest(u), (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/board') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ lists }) });
    if (p === '/board/me') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ me: null }) });
    const hit = lists.find((l) => p === '/board/' + l.code);
    if (hit) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(hit) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

test('rides are grouped under day headings, in date order, each showing its 2-hour window', async ({ page }) => {
  await stubApi(page);
  await page.goto('/board.html');
  await expect(page.locator('.rw').first()).toBeVisible({ timeout: 15000 });

  await expect(page.locator('.rw-day-h')).toHaveText(['Sat 15 Aug', 'Sun 16 Aug']);
  const first = page.locator('.rw-group').first().locator('.rw');
  await expect(first.locator('.rw-when')).toHaveText([/7–9 am/, /1–3 pm/]);
  await expect(page.locator('.rw[data-code="RW-1"] .rw-state')).toContainText('3 of 4 in');
  await expect(page.locator('.rw[data-code="RW-1"] [data-view]')).toHaveText('Hop on');
  // no card-era markup survives
  await expect(page.locator('.lcard')).toHaveCount(0);
});

test('a row opens the ride sheet from anywhere on it, and from the keyboard', async ({ page }) => {
  await stubApi(page);
  await page.goto('/board.html');
  const row = page.locator('.rw[data-code="RW-1"]');
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.locator('.rw-places').click();
  await expect(page.locator('body')).toHaveClass(/detail-open/);

  await page.goto('/board.html');
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('body')).toHaveClass(/detail-open/);
});

test('at tablet width the seat state never runs into the price', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1000 });
  await stubApi(page);
  await page.goto('/board.html');
  await expect(page.locator('.rw').first()).toBeVisible({ timeout: 15000 });

  for (const code of ['RW-1', 'RW-2', 'RW-3']) {
    const row = page.locator(`.rw[data-code="${code}"]`);
    const s = await row.locator('.rw-state').boundingBox();
    const p = await row.locator('.rw-price').boundingBox();
    const overlaps = s.x < p.x + p.width && p.x < s.x + s.width && s.y < p.y + p.height && p.y < s.y + s.height;
    expect(overlaps, `${code}: .rw-state ${JSON.stringify(s)} overlaps .rw-price ${JSON.stringify(p)}`).toBe(false);
  }
});

test('on a phone a ride stays a compact row, and Start a ride lives in the bottom bar', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubApi(page);
  await page.goto('/board.html');
  await expect(page.locator('.rw').first()).toBeVisible({ timeout: 15000 });

  for (const code of ['RW-1', 'RW-2', 'RW-3']) {
    const h = (await page.locator(`.rw[data-code="${code}"]`).boundingBox()).height;
    expect(h, `${code} is ${Math.round(h)}px tall on a phone`).toBeLessThan(140);
  }
  await expect(page.locator('#f-start')).toBeHidden();
  await expect(page.locator('#start-bar-btn')).toBeVisible();
});

test('on a laptop Start a ride sits in the filter bar and opens the create form', async ({ page }) => {
  await stubApi(page);
  await page.goto('/board.html');
  const start = page.locator('#f-start');
  await expect(start).toBeVisible({ timeout: 15000 });
  await start.click();
  await expect(page.locator('#m-title')).toHaveText('Start a list');
});

test('with a route chosen, the list closes with one invite to start a van on that route', async ({ page }) => {
  await stubApi(page, [LISTS[2]]);
  await page.goto('/board.html?from=' + encodeURIComponent(base.from) + '&to=' + encodeURIComponent(base.to));
  const invite = page.locator('.rw-invite');
  await expect(invite).toBeVisible({ timeout: 15000 });
  await expect(invite).toContainText('Colombo Airport (CMB) → Sigiriya / Dambulla');
  await expect(page.locator('.rw-invite')).toHaveCount(1);
});

test('with no route chosen there is no invite row in the list', async ({ page }) => {
  await stubApi(page);
  await page.goto('/board.html');
  await expect(page.locator('.rw').first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.rw-invite')).toHaveCount(0);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd web-tests && npx playwright test e2e/ride-board-rows.spec.js --reporter=line`
Expected: FAIL — `.rw` never appears (timeout).

- [ ] **Step 3: Implement the row renderer in `board.js`**

Delete `listRows`, `rosterStrip`, `card` and add in their place (keep `taCaption`/`taBadge` between as they are):
```js
  /* ---------------- board row ---------------- */
  // Up to four faces (flags ride on the avatars) and a "+N" for the rest.
  function faces(L) {
    var ms = L.members;
    var html = ms.slice(0, 4).map(function (m, i) { return avatar(m, i, 'xs' + (i ? ' stack' : '')); }).join('');
    if (ms.length > 4) html += '<span class="avatar xs stack rw-more">+' + (ms.length - 4) + '</span>';
    return html;
  }

  function rowHtml(L) {
    var mine = iAmOn(L);
    var st = rowState(L, mine);
    var dur = durationOf(L);
    var win = windowLabel(L.slot);
    var hook = st.cta.kind === 'again' ? 'data-again' : 'data-view';
    var primary = st.cta.text === 'Hop on';
    return '<article class="rw' + (mine ? ' mine' : '') + '" data-code="' + esc(L.code) + '" tabindex="0"' +
      ' aria-label="' + esc(L.from + ' to ' + L.to + ', ' + L.whenLabel + ', ' + win + ', ' + st.label) + '">' +
      '<div class="rw-when">' + esc(win) + (dur ? '<span class="rw-dur"> · ' + esc(dur) + '</span>' : '') + '</div>' +
      '<div class="rw-route"><span class="rw-places">' + esc(L.from) + ' <span class="arr">→</span> ' + esc(L.to) + '</span>' +
        (dur ? '<small>' + esc(dur) + '</small>' : '') + '</div>' +
      '<div class="rw-seats"><span class="rw-faces">' + faces(L) + '</span>' +
        '<span class="rw-state ' + st.cls + '"><b>' + esc(st.label) + '</b><small>' + esc(st.sub) + '</small></span></div>' +
      '<div class="rw-price">≈ <b>' + money(L.cost) + '</b> each</div>' +
      '<button class="btn btn-sm ' + (primary ? 'btn-primary' : 'btn-ghost') + ' rw-cta" ' + hook + '="' + esc(L.code) + '">' +
        esc(st.cta.text) + '</button>' +
      '</article>';
  }

  // Only when a route is chosen: the list ends with one way to start a van on it. With no
  // route there is nothing to prefill, and the filter bar's Start button already covers it.
  function routeInvite() {
    var f = state.filter;
    if (f.mine || f.from === 'all' || f.to === 'all') return '';
    return '<div class="rw-invite"><p><b>Not your day?</b> Start a van on ' + esc(f.from) + ' → ' + esc(f.to) +
      ' for your date — $0 to add your name.</p>' +
      '<button class="btn btn-ghost btn-sm" id="rw-start">Start a ride +</button></div>';
  }
```
Replace `render()` with:
```js
  function render() {
    var shown = state.lists;
    grid.removeAttribute('aria-busy');
    if (!shown.length) {
      grid.innerHTML = '<div class="board-empty"><div class="plus">🗺️</div>' +
        '<h3>No lists match yet' + (state.filter.mine ? " — you haven't joined any" : '') + '.</h3>' +
        '<p>' + (state.filter.mine ? 'Add your name to a ride and it shows up here.' : "Be the first to start this one — we'll help gather names, and it's $0 unless it runs.") + '</p>' +
        '<button class="btn btn-primary" id="empty-start">' + (state.filter.mine ? 'Browse the board' : 'Start this list') + '</button></div>';
    } else {
      grid.innerHTML = groupByDay(shown).map(function (g) {
        return '<section class="rw-group"><h3 class="rw-day-h">' + esc(g.label) + '</h3>' + g.lists.map(rowHtml).join('') + '</section>';
      }).join('') + routeInvite();
    }

    var es = document.getElementById('empty-start');
    if (es) es.addEventListener('click', function () {
      if (state.filter.mine) { state.filter.mine = false; loadBoard(); }
      else openModal(null);
    });
    var rs = document.getElementById('rw-start');
    if (rs) rs.addEventListener('click', function () { openModal(null, { from: state.filter.from, to: state.filter.to }); });
    grid.querySelectorAll('[data-view]').forEach(function (el) {
      el.addEventListener('click', function (e) { e.stopPropagation(); openDetail(el.getAttribute('data-view')); });
    });
    grid.querySelectorAll('[data-again]').forEach(function (el) {
      el.addEventListener('click', function (e) { e.stopPropagation(); startAnother(el.getAttribute('data-again')); });
    });
    grid.querySelectorAll('.rw').forEach(function (r) {
      var code = r.getAttribute('data-code');
      // the whole row opens the ride — read the code off the row, since a full van has no
      // [data-view] button to read it from
      r.addEventListener('click', function (e) {
        if (e.target.closest('button,a')) return;
        openDetail(code);
      });
      r.addEventListener('keydown', function (e) {
        if (e.target !== r || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        openDetail(code);
      });
    });
    observe();
    playSeatFills();
  }
```
Replace the body of `playSeatFills` (keep its comment block, but update the first paragraph to say the row's seat state is animated) with:
```js
  var _prevCommitted = Object.create(null);
  function playSeatFills() {
    var reduce = window.CH && CH.motion ? CH.motion.reduce() : false;
    document.querySelectorAll('.rw[data-code]').forEach(function (rowEl) {
      var code = rowEl.getAttribute('data-code');
      var L = state.byCode[code];
      if (!L) return;
      var prev = _prevCommitted[code];
      _prevCommitted[code] = L.committed;
      // First sight of this list, or no gain — nothing happened worth pointing at. (A LOSS
      // isn't animated either: someone leaving a ride is not a moment to celebrate.)
      if (reduce || prev == null || L.committed <= prev) return;
      var b = rowEl.querySelector('.rw-state b');
      if (!b || typeof b.animate !== 'function') return;
      b.animate([
        { transform: 'scale(.85)', opacity: .4 },
        { transform: 'scale(1.12)', opacity: 1, offset: .55 },
        { transform: 'scale(1)', opacity: 1 },
      ], { duration: 460, easing: 'cubic-bezier(.22,.75,.3,1)', fill: 'backwards' });
    });
  }
```
In `refreshMineCodes` change `grid.querySelectorAll('.lcard.mine')` → `grid.querySelectorAll('.rw.mine')`.

In `renderFilters`, after `countHtml;` in the innerHTML concatenation, append the button, and wire it:
```js
      countHtml +
      '<button class="btn btn-primary btn-sm f-start" id="f-start">Start a ride +</button>';
```
```js
    var fs = document.getElementById('f-start');
    if (fs) fs.addEventListener('click', function () { openModal(null); });
```
Replace `showSkeleton` body's markup with a row-shaped placeholder (keep `.bskel`):
```js
    var row =
      '<div class="bskel" aria-hidden="true">' +
        '<div class="bskel-line w40"></div>' +
        '<div class="bskel-line w60"></div>' +
        '<div class="bskel-dots"><i></i><i></i><i></i></div>' +
      '</div>';
    grid.innerHTML = new Array((n || 4) + 1).join(row);
```
Delete `var MOBILE_CAP = 4; ...` (line ~50).

- [ ] **Step 4: Replace the card CSS in `board.html`**

`.board` grid rules (lines ~119-121) become:
```css
.board{background:var(--paper);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow);overflow:hidden}
.board .board-empty{border:0;border-radius:0;background:none}
```
Skeleton block: change the comment's first line to "Mirrors a ride row's shape so the list doesn't jump when the real rows land." and `.bskel` to:
```css
.bskel{display:grid;grid-template-columns:96px 1.5fr 1.35fr;gap:18px;align-items:center;padding:18px 24px;border-top:1px solid var(--line)}
.bskel:first-child{border-top:0}
```
and `.bskel-dots{display:flex;gap:6px}` / `.bskel-dots i{width:28px;height:28px;border-radius:50%}` (drop `margin-top:auto`, `min-height`, `background`, `box-shadow`, `border-radius:var(--r-lg)` from `.bskel`).

Delete every rule from `/* ---------- list card (a ticket with a sign-up list) ---------- */` through the `.lcard-new .hand{…}` line, EXCEPT keep the `.goal-dots` rules and `.avatar` / `.avatar .flag` rules (the ride sheet uses them). Insert in their place:
```css
/* ---------- ride rows ----------
   One ride per line: window · route · who's in · price · action. The day heading carries the
   date, so a row never repeats it. See docs/superpowers/specs/2026-09-18-ride-board-rows-design.md */
.rw-group+.rw-group{border-top:1px solid var(--line)}
.rw-day-h{margin:0;padding:16px 24px 8px;font-family:var(--display);font-weight:700;font-size:1.08rem;letter-spacing:0}
.rw{display:grid;grid-template-columns:96px minmax(0,1.5fr) minmax(0,1.35fr) 104px auto;gap:18px;align-items:center;
  padding:14px 24px;border-top:1px solid var(--line);cursor:pointer;transition:background .15s}
.rw:hover{background:var(--pc-sky)}
.rw:focus-visible{outline:2px solid var(--accent-deep);outline-offset:-2px}
.rw.mine{background:var(--pc-teal);box-shadow:inset 3px 0 0 var(--teal)}
.rw-when{font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
.rw-dur{display:none}
.rw-route{min-width:0}
.rw-places{font-family:var(--display);font-weight:700;font-size:1.15rem;line-height:1.25}
.rw-places .arr{color:var(--accent-deep);font-family:var(--body);font-weight:400}
.rw-route small{display:block;font-size:.76rem;color:var(--ink-soft);margin-top:2px}
.rw-seats{display:flex;align-items:center;gap:12px;min-width:0}
.rw-faces{display:flex;align-items:center;flex:none}
.rw-more{background:var(--cream-deep);color:var(--ink-soft)}
.rw-state{display:flex;flex-direction:column;min-width:0;line-height:1.3}
.rw-state b{font-size:.9rem;font-weight:700}
.rw-state small{font-size:.76rem;color:var(--ink-soft);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rw-state.g b{color:var(--warn)}
.rw-state.l b{color:var(--ok)}
.rw-state.f b{color:var(--ink-soft)}
.rw-price{text-align:right;white-space:nowrap;font-size:.8rem;color:var(--ink-soft);font-variant-numeric:tabular-nums}
.rw-price b{font-family:var(--display);font-weight:700;font-size:1.1rem;color:var(--ink)}
.rw .rw-cta{justify-self:end;white-space:nowrap}
.rw-invite{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;padding:16px 24px;
  border-top:1px solid var(--line);background:var(--cream);font-size:.9rem;color:var(--ink-soft)}
.rw-invite p{margin:0}
.rw-invite b{color:var(--ink)}
.filters .f-start{margin-left:4px}
@media(max-width:1020px){
  .rw{grid-template-columns:88px minmax(0,1fr) auto auto;grid-template-areas:"when route price cta" "when seats price cta";row-gap:8px}
  .rw-when{grid-area:when}.rw-route{grid-area:route}.rw-seats{grid-area:seats}.rw-price{grid-area:price}.rw .rw-cta{grid-area:cta}
}
```
Delete `.lcard-roster{display:none}`, `.board-more{display:none}` and their comments (~483-488), and the `.lcard.hot`, `.lcard.hot:hover`, `.lcard.mine`, `.mine-tag` rules (~497-500).

In the `@media(max-width:640px)` phone block, delete `.lcard-list`, `.lcard-roster`, `.rfaces`, `.rslot`, `.rfaces .avatar:first-child`, `.rtxt`, `.rtxt b`, `.rhand`, `.lcard-top`, `.lcard-foot`, `.lcard .started`, `.lcard-new`, the `n+5 mirrors MOBILE_CAP` comment + rule, and the `.board-more{…}` rule; add:
```css
  /* two-line rows: route + price, window + duration, faces + state + a text-link action */
  .filters .f-start{display:none}
  .rw-day-h{padding:14px 16px 6px}
  .rw{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"route price" "when when" "seats cta";gap:6px 12px;padding:13px 16px}
  .rw-route small{display:none}
  .rw-when{font-weight:500;font-size:.82rem;color:var(--ink-soft)}
  .rw-dur{display:inline}
  .rw-places{font-size:1.05rem}
  .rw .rw-cta,.rw .rw-cta:hover{background:none;border:0;box-shadow:none;color:var(--accent-deep);padding:6px 0;min-height:44px;transform:none}
  .rw .rw-cta::after{content:" ›"}
  .rw-invite{padding:14px 16px}
```
Start-bar HTML comment (~953): "Phones only (see .start-bar). On a phone the filter bar has no room for the Start button, so the action lives in a bar that never scrolls away."

- [ ] **Step 5: Update the existing specs and the display-face test**

- `ride-board-locked-cta.spec.js`: `.lcard[` → `.rw[`; first test keep `toHaveText(/See who's going/)` and `not.toContainText('Hop on')` (capital H, the row's wording) and drop the `'See ride & join'` line; second test: `toContainText('Locked in')` instead of `"Van's locked"`, `[data-view]` `toHaveText('Hop on')`. Update the header comment's quoted labels to "Hop on" / "See who's going".
- `ride-board-full-van.spec.js`: `.lcard` → `.rw`; `.lcard-route` → `.rw-places`; replace the third test with:
```js
test('a full van row keeps its price on one line on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 900 });
  await stubApi(page);
  await page.goto('/board.html');

  const row = page.locator('.rw').first();
  await expect(row).toBeVisible({ timeout: 15000 });
  // "≈ $19 each" is one line of ~.8rem text; two lines would be ~40px.
  const price = await row.locator('.rw-price').boundingBox();
  expect(price.height, `.rw-price is ${Math.round(price.height)}px tall — it has wrapped`).toBeLessThan(32);
});
```
  and change its header comment "The card used to carry…" to "The card (now a row) used to carry…".
- `ride-board-load.spec.js`: both `.lcard` → `.rw`; "real cards" → "real rows" in the comment.
- `ride-board-share-link.spec.js`: `.lcard` → `.rw` (4 places).
- `display-weight-and-icon-stroke.test.js`: `['board.html', '.lcard-route']` → `['board.html', '.rw-places']`, `['board.html', '.lprice b']` → `['board.html', '.rw-price b']`.

- [ ] **Step 6: Regenerate stamps and run the board tests**

Run:
```bash
cd /Users/roshenw/claude_code/ceylon-hop-wt-board-rows && npm run generate
cd web-tests && npx vitest run && npx playwright test e2e/ride-board --reporter=line
```
Expected: vitest all pass; all `ride-board-*` specs pass including the 7 new ones.

- [ ] **Step 7: Commit**
```bash
git add board.js board.html web-tests/e2e/ride-board-*.spec.js web-tests/unit/display-weight-and-icon-stroke.test.js <files npm run generate restamped>
git commit -m "feat(board): show rides as day-grouped rows instead of cards"
```

---

### Task 3: Full gate, visual check, PR

- [ ] **Step 1:** `cd web-tests && npm run test:all` (read the real exit code, not a piped tail) — expect green.
- [ ] **Step 2:** `cd api && npm run check` — expect green (no api changes; confirms the tree).
- [ ] **Step 3:** Browser pane: serve the worktree (`serve-booking.js`), load `/board.html` with the API stubbed via prod read-only, screenshot desktop, 820px and 390px.
- [ ] **Step 4:** Push `feat/board-rows`, open PR to `main` with the spec link, screenshots, and the note that a Pages merge ships to prod.ceylonhop.com immediately.
