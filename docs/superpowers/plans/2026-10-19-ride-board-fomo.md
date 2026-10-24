# Ride Board FOMO + Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get more names on the ride board. Traveller rides show real urgency: seats to go, a names-close clock, open seats and a private-car comparison. Every open ride gets a one-tap share. The home page shows who's going.

**Architecture:** One new pure helper file, `ride-fomo.js` (`window.CHRideFomo`, the same pattern as `shared-day.js`), holds every FOMO rule and the share wording. `board.js` uses it for rows, sharing and the momentum line. A new `home-rides.js` uses it for the home strip. Nothing in the API, pricing, schema or config changes. Every number comes from `GET /board` or the generated `transfers-data.js`.

**Tech Stack:** Vanilla ES5-style browser JS (`var`, `function`, matching `board.js`), page-local CSS in `board.html` and `index.html`, Vitest + jsdom unit tests, Playwright e2e (1.61, so `page.clock` is available).

**Prototype the owner approved (2026-10-19):** https://claude.ai/artifact/LHG6TjNZq5N4e9YseBaXnp — home section revised 2026-10-21 (screens C1 → C2).

**Three PRs, never stacked:**
- **PR 1** = Tasks 1–4 on `feat/board-fomo-rows`.
- **PR 2** = Tasks 5–7 on `feat/home-ride-strip`: the home strip and the board's `?hl=` landing.
- **PR 3** = Tasks 8–9 on `feat/board-scheduled-booked`: "N booked" on scheduled taxis.

PRs 2 and 3 are each cut from `origin/main` **after PR 1 has merged**, since both need `ride-fomo.js`. They don't depend on each other, but both edit `board.js` and `board.html`: whichever opens second merges `main` first and re-runs `npm run stamp` (the `?v=` stamp hunk always conflicts; resolve by regenerating, never `--theirs`). PR 3 adds a method to the `BookingRepo` interface (CLAUDE.md hard rule 5: an interface change is its own step). It reads only, needs no migration, and imports from `departureRepo.ts` without changing it.

## Decisions the owner must confirm before execution

1. **Momentum line and home strip count seeded names.** The `seed-rideboard:` placeholders already show on the board as people, and the public data can't tell them apart (no `sub` in the projection). Default: count and show everything the board shows. Excluding seeds needs an API change, which would be its own step.
2. **GA4.** This adds `share` events (`method`, `content_type: 'ride'`, `item_id`, `via`) and a home `select_item` (`item_list_id: 'home_rides'`). They reach the dataLayer through `chTrack`, but GTM has no tag for them, so they won't appear in GA4 until the owner adds the tags.
3. **Thresholds.** A live countdown under 72 h, red under 24 h, and a Sri Lanka date further out.
4. **When the home strip shows.** Default: whenever at least one open ride still needs people. A stricter rule (2+ rides, or one "1 seat to go") avoids a lone "2 seats to go" card under "Travel with others?", but at today's volume it would hide the strip most days.

## Global Constraints

- Owner's row layout calls stay:
  - Join is the only solid button in the list on phones.
  - Departure stays a 2-hour window.
  - Place tags stay on one line.
  - The desktop action column stays a fixed 156px.
  - Scheduled rows don't change.
  - A confirmed or names-closed ride never invites a join or a share.
- Real numbers only. Seats, deadline and fare come from the ride (`GET /board`). The private-car fare comes from `TRANSFERS.privateQuote(fromId, toId).car`. Nothing is padded or invented. If a figure is missing, leave its line out.
- Copy travellers see says **"shared taxi"**, never "van".
- The row price stays `≈ $X each`. The comparison is a separate line: `vs $Y private car`.
- Share wording is built only by `CHRideFomo.shareMessage`:
  - Someone on the ride says "I'm taking a shared taxi … Join me:".
  - Anyone else says "Shared taxi … Add your name:".
- Don't touch any of these: pricing (`rateCard.ts`, `departureRepo.ts`), API, schema, config, `@generated` blocks, `site.css`, `transfers-data.js`.
- New home-page classes are prefixed `hr-`, because bare classes collide with the shared chrome (#983).
- Run `npm run stamp` at the repo root right after editing any root `.js` or `.html` asset, and commit the restamped pages.
- Stage by explicit path only. Never `git add -A`.
- Gate before every commit (run from the worktree):
  - `cd api && DATABASE_URL_TEST=postgres://localhost:5432/ceylonhop_test npm run check`
  - `npm --prefix "$WT/web-tests" run test:all`
  - Read each runner's own summary line and exit code.

## Setup (once per PR)

PR 1 worktree (already created 2026-10-19):

```bash
WT=/private/tmp/claude-501/-Users-roshenw-claude-code-ceylon-hop/d3ddb2ac-2f8d-4ce0-9909-94fc61c94335/scratchpad/wt-board-fomo
git -C "$WT" status --short --branch
```

Expected: `## feat/board-fomo-rows...origin/main` and a clean tree. `web-tests/node_modules` and `api/node_modules` are symlinks to the main checkout's.

PR 2, after PR 1 merges:

```bash
cd /Users/roshenw/claude_code/ceylon-hop && git fetch origin
WT2=/private/tmp/claude-501/-Users-roshenw-claude-code-ceylon-hop/d3ddb2ac-2f8d-4ce0-9909-94fc61c94335/scratchpad/wt-home-rides
git worktree add -b feat/home-ride-strip "$WT2" origin/main
ln -s /Users/roshenw/claude_code/ceylon-hop/web-tests/node_modules "$WT2/web-tests/node_modules"
ln -s /Users/roshenw/claude_code/ceylon-hop/api/node_modules "$WT2/api/node_modules"
test -f "$WT2/ride-fomo.js" && echo "ride-fomo.js present"
```

## File map

| File | PR | Responsibility |
|---|---|---|
| `ride-fomo.js` (new) | 1 (+2) | Pure FOMO rules: `seatsToGo`, `closesText`, `privateCarFare`, `shareMessage`, `momentum`, `momentumText` (PR 1); `stripRides`, `busTime`, minutes-only `closesText` (PR 2) |
| `web-tests/unit/ride-fomo.test.js` (new) | 1 (+2) | Unit tests for every `CHRideFomo` function |
| `board.js` | 1 | Rows use FOMO state; open seats; ticker; share (row, ride page, success step); momentum line |
| `board.html` | 1 | Loads `ride-fomo.js`; row, share-sheet and momentum CSS; share-sheet markup; success-step Share button |
| `web-tests/e2e/ride-board-fomo.spec.js` (new) | 1 | FOMO rows on phone and desktop widths |
| `web-tests/e2e/ride-board-share-sheet.spec.js` (new) | 1 | Native share, fallback sheet, no share on closed rides, ride-page message |
| `web-tests/e2e/ride-board-rows.spec.js`, `ride-board-scheduled.spec.js`, `ride-board-start-no-card.spec.js` | 1 | Assertions moved from "N of M in" / "decided" to the new wording |
| `home-rides.js` (new) | 2 | Home strip: fetch, stacked cards linking to `board.html?hl=CODE`, minute ticker, analytics |
| `index.html` | 2 | Section + skeleton + inline unhide + `hr-` CSS + script tags |
| `web-tests/e2e/home-ride-strip.spec.js` (new) | 2 | Strip renders, orders, says shared taxi, never a private car, hides, stacks |
| `board.js`, `board.html` (+ `web-tests/e2e/ride-board-landing.spec.js`) | 2 | `?hl=CODE`: tint that ride (saffron) and scroll to it once |
| `api/src/domain/scheduledSeats.ts` (+ test, new) | 3 | Pure: paid seats per van (pooled via `departureKeyFor`), one entry per boarding time |
| `api/src/db/bookingRepo.ts`, `api/src/db/postgresBookingRepo.ts` (+ 2 tests) | 3 | New `paidSharedSeats(from, to)` on `BookingRepo`, both implementations |
| `api/src/routes/rideBoard.ts`, `api/src/app.ts` (+ route test) | 3 | `GET /board/scheduled-seats?from=&days=`, wired with `sharedSeats: bookings` |
| `ride-fomo.js`, `board.js`, `board.html` (+ unit + e2e) | 3 | `bookedText(n)`; scheduled rows carry `corridorId`, fetch the counts once, show "· 7 booked" |

---

# PR 1 — FOMO rows + share (`feat/board-fomo-rows`)

### Task 1: `ride-fomo.js` pure helpers

**Files:**
- Create: `ride-fomo.js`
- Test: `web-tests/unit/ride-fomo.test.js`

**Interfaces:**
- Produces `window.CHRideFomo`:
  - `seatsToGo(list) → {need:number, text:string, hot:boolean} | null` — `list: {minSeats, committed, confirmed?}`
  - `closesText(cutoffMs:number, nowMs:number) → {text:string, live:boolean, urgent:boolean} | null`
  - `privateCarFare(fromId:string|null, toId:string|null, seat:number) → number | null`
  - `shareMessage({mine:boolean, route:string, when:string, need:number, fare:string, priv:string|null, closes:string|null}) → string`
  - `momentum(lists, nowMs) → {travellers, closingThisWeek, oneToGo}` — `lists` are board.js normalized lists (`committed, minSeats, confirmed, cancelled, cutoffMs`, optional `sched`)
  - `momentumText(m) → {head:string, sub:string} | null`

- [ ] **Step 1: Write the failing test** — create `web-tests/unit/ride-fomo.test.js`:

```js
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTransfers } from './_load.js';

// ride-fomo.js — seats to go, when names close, the private car a seat beats, and the words a
// traveller shares (plan 2026-10-19-ride-board-fomo). Pure: "now" is an argument.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let F;
beforeAll(() => {
  loadTransfers();
  // eslint-disable-next-line no-new-func
  new Function(readFileSync(path.join(ROOT, 'ride-fomo.js'), 'utf8'))();
  F = window.CHRideFomo;
});
const H = 3600000;
const NOW = Date.parse('2099-08-10T00:00:00Z');

describe('seatsToGo', () => {
  it('counts the seats a gathering ride still needs', () => {
    expect(F.seatsToGo({ minSeats: 3, committed: 1 })).toEqual({ need: 2, text: '2 seats to go', hot: false });
  });
  it('is hot with one seat to go', () => {
    expect(F.seatsToGo({ minSeats: 3, committed: 2 })).toEqual({ need: 1, text: '1 seat to go', hot: true });
  });
  it('says nothing once the ride has its minimum, or is confirmed', () => {
    expect(F.seatsToGo({ minSeats: 3, committed: 3 })).toBeNull();
    expect(F.seatsToGo({ minSeats: 3, committed: 1, confirmed: true })).toBeNull();
  });
});

describe('closesText', () => {
  it('runs a red clock inside a day', () => {
    expect(F.closesText(NOW + 9 * H + 12 * 60000, NOW)).toEqual({ text: 'Names close in 9h 12m', live: true, urgent: true });
  });
  it('runs a calm clock inside three days', () => {
    expect(F.closesText(NOW + 50 * H, NOW)).toEqual({ text: 'Names close in 2d 2h', live: true, urgent: false });
  });
  it('counts down to the second in the last hour', () => {
    expect(F.closesText(NOW + 12 * 60000 + 5000, NOW).text).toBe('Names close in 12m 05s');
  });
  it('gives the Sri Lanka date further out', () => {
    // 20:00 UTC on the 14th is 01:30 on the 15th in Colombo
    expect(F.closesText(Date.parse('2099-08-14T20:00:00Z'), NOW)).toEqual({ text: 'Names close Sat 15 Aug', live: false, urgent: false });
  });
  it('says names closed once the cutoff has passed', () => {
    expect(F.closesText(NOW - 1, NOW)).toEqual({ text: 'Names closed', live: false, urgent: false });
  });
  it('is null with no cutoff to go on', () => {
    expect(F.closesText(NaN, NOW)).toBeNull();
  });
});

describe('privateCarFare', () => {
  it("quotes the catalogue's private car for the pair", () => {
    const car = window.TRANSFERS.privateQuote('ella', 'mirissa').car;
    expect(F.privateCarFare('ella', 'mirissa', 28)).toBe(car);
  });
  it('is null when the pair is unknown', () => {
    expect(F.privateCarFare(null, 'mirissa', 28)).toBeNull();
    expect(F.privateCarFare('nowhere', 'mirissa', 28)).toBeNull();
  });
  it('is null when the car would not cost more than one seat', () => {
    const car = window.TRANSFERS.privateQuote('ella', 'mirissa').car;
    expect(F.privateCarFare('ella', 'mirissa', car)).toBeNull();
  });
});

describe('shareMessage', () => {
  const base = { route: 'Ella → Mirissa', when: 'Thu 22 Oct (7–9 am)', fare: '$28', priv: '$75', closes: 'Names close in 9h 12m' };
  it('speaks in the first person for someone on the ride', () => {
    expect(F.shareMessage({ ...base, mine: true, need: 1 })).toBe(
      "I'm taking a shared taxi Ella → Mirissa on Thu 22 Oct (7–9 am). 1 seat left to make it run — $28 each instead of $75 for a private car, nothing to pay unless it runs. Names close in 9h 12m. Join me:");
  });
  it('never claims "I\'m taking" for someone who is not on it', () => {
    expect(F.shareMessage({ ...base, mine: false, need: 1 })).toBe(
      'Shared taxi Ella → Mirissa on Thu 22 Oct (7–9 am). 1 seat left to make it run — $28 each instead of $75 for a private car, nothing to pay unless it runs. Names close in 9h 12m. Add your name:');
  });
  it('pluralises the seats', () => {
    expect(F.shareMessage({ ...base, mine: true, need: 2 })).toContain('2 seats left to make it run');
  });
  it('drops the comparison and the deadline when it has neither', () => {
    expect(F.shareMessage({ ...base, mine: true, need: 1, priv: null, closes: null })).toBe(
      "I'm taking a shared taxi Ella → Mirissa on Thu 22 Oct (7–9 am). 1 seat left to make it run — $28 each, nothing to pay unless it runs. Join me:");
  });
  it('says it is running when nothing more is needed', () => {
    expect(F.shareMessage({ ...base, mine: true, need: 0, closes: null })).toBe(
      "I'm taking a shared taxi Ella → Mirissa on Thu 22 Oct (7–9 am). It's running and there are seats left — $28 each instead of $75 for a private car. Join me:");
  });
});

describe('momentum + momentumText', () => {
  const ride = (o) => ({ minSeats: 3, committed: 1, confirmed: false, cancelled: false, cutoffMs: NOW + 2 * 24 * H, ...o });
  it('counts travellers on open rides, rides closing this week, and rides one short', () => {
    const m = F.momentum([
      ride({ committed: 2 }),                          // one short, closes in 2 days
      ride({ committed: 1, cutoffMs: NOW + 10 * 24 * H }),
      ride({ committed: 3, confirmed: true }),          // names closed — not counted
      ride({ committed: 2, cutoffMs: NOW - 1 }),        // cutoff passed — not counted
      { sched: true },                                  // a scheduled taxi row — not a ride
    ], NOW);
    expect(m).toEqual({ travellers: 3, closingThisWeek: 1, oneToGo: 1 });
  });
  it('words it, leaving out the parts that are zero', () => {
    expect(F.momentumText({ travellers: 9, closingThisWeek: 3, oneToGo: 1 }))
      .toEqual({ head: '9 travellers on the board right now', sub: '3 rides close this week · 1 needs just one more' });
    expect(F.momentumText({ travellers: 1, closingThisWeek: 0, oneToGo: 0 }))
      .toEqual({ head: '1 traveller on the board right now', sub: '' });
  });
  it('shows nothing rather than "0 travellers"', () => {
    expect(F.momentumText({ travellers: 0, closingThisWeek: 0, oneToGo: 0 })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd "$WT/web-tests" && npx vitest run unit/ride-fomo.test.js`
Expected: FAIL. `beforeAll` throws `ENOENT: no such file or directory … ride-fomo.js`.

- [ ] **Step 3: Write the implementation** — create `ride-fomo.js` at the repo root:

```js
/* ride-fomo.js — what makes a traveller ride worth joining NOW: the seats it still needs, when
   names close, what the same trip costs in a private car, and the words a traveller sends a
   friend (plan docs/superpowers/plans/2026-10-19-ride-board-fomo.md).

   Pure on purpose, like shared-day.js: "now" is an ARGUMENT and nothing here reads the clock or
   the DOM, so the board rows, the ride page and the home strip all say the same thing and all
   of it is unit-testable. Every figure comes from the ride itself (GET /board) or the generated
   price catalogue (transfers-data.js) — nothing here invents urgency. */
(function () {
  var HOUR = 3600000, DAY = 24 * HOUR;
  var LIVE_MS = 3 * DAY;              // under this, a running clock instead of a date
  var URGENT_MS = DAY;                // under this, the clock turns red
  var COLOMBO_OFFSET_MS = 5.5 * HOUR; // UTC+05:30, no daylight saving

  function pad(n) { return String(n).padStart(2, '0'); }

  // Remaining milliseconds → "2d 3h" / "9h 12m" / "12m 05s". Clamps at zero.
  function countdown(ms) {
    var s = Math.max(0, Math.floor(Number(ms) || 0));
    var h = Math.floor(s / HOUR), m = Math.floor((s % HOUR) / 60000), sec = Math.floor((s % 60000) / 1000);
    if (h >= 24) return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
    if (h >= 1) return h + 'h ' + pad(m) + 'm';
    return m + 'm ' + pad(sec) + 's';
  }

  // An instant → its Sri Lanka calendar date, "Fri 6 Nov".
  function colomboDay(ms) {
    return new Date(ms + COLOMBO_OFFSET_MS).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  }

  // How many more seats this ride needs before it runs; null once it has its minimum or is
  // confirmed — a ride with nothing left to fill has no "seats to go".
  function seatsToGo(list) {
    if (!list || list.confirmed) return null;
    var need = Math.max(0, (list.minSeats || 0) - (list.committed || 0));
    if (need === 0) return null;
    return { need: need, text: need === 1 ? '1 seat to go' : need + ' seats to go', hot: need === 1 };
  }

  // When names close: a running clock inside three days (red inside one), a Sri Lanka date
  // further out. null with no cutoff to go on.
  function closesText(cutoffMs, nowMs) {
    if (!isFinite(cutoffMs)) return null;
    var left = cutoffMs - nowMs;
    if (left <= 0) return { text: 'Names closed', live: false, urgent: false };
    if (left < LIVE_MS) return { text: 'Names close in ' + countdown(left), live: true, urgent: left < URGENT_MS };
    return { text: 'Names close ' + colomboDay(cutoffMs), live: false, urgent: false };
  }

  // The same trip in a private car, from the generated catalogue — the figure the search and
  // trip pages quote. null when the pair can't be priced, or when the car would not cost more
  // than one seat (then the comparison says nothing worth saying).
  function privateCarFare(fromId, toId, seat) {
    var T = typeof window !== 'undefined' && window.TRANSFERS;
    // Both ends must be catalogue places: privateQuote never throws for an unknown id — it
    // prices 0 km at the $29 floor, which would "beat" every seat on the board.
    if (!T || !T.privateQuote || !T.place || !fromId || !toId || !T.place(fromId) || !T.place(toId)) return null;
    var q;
    try { q = T.privateQuote(fromId, toId); } catch (e) { return null; }
    var car = q && Number(q.car);
    if (!isFinite(car) || car <= 0 || !(car > (Number(seat) || 0))) return null;
    return car;
  }

  // The words a traveller sends: the seats still needed, the fare and the private car it beats,
  // and when names close. Strings in, string out — the caller formats money and dates, so this
  // never disagrees with the row the traveller just read. Only someone ON the ride says "I'm
  // taking"; anyone else shares it plainly. The link travels separately (navigator.share's url).
  function shareMessage(r) {
    var parts = [(r.mine ? "I'm taking a shared taxi " : 'Shared taxi ') + r.route + ' on ' + r.when + '.'];
    var fare = r.fare + ' each' + (r.priv ? ' instead of ' + r.priv + ' for a private car' : '');
    parts.push(r.need > 0
      ? (r.need === 1 ? '1 seat left' : r.need + ' seats left') + ' to make it run — ' + fare + ', nothing to pay unless it runs.'
      : "It's running and there are seats left — " + fare + '.');
    if (r.closes) parts.push(r.closes + '.');
    parts.push(r.mine ? 'Join me:' : 'Add your name:');
    return parts.join(' ');
  }

  // The line at the top of the board: real counts off the open rides, never padded.
  function momentum(lists, nowMs) {
    var out = { travellers: 0, closingThisWeek: 0, oneToGo: 0 };
    (lists || []).forEach(function (L) {
      if (!L || L.sched || L.confirmed || L.cancelled) return;
      if (isFinite(L.cutoffMs) && L.cutoffMs <= nowMs) return;
      out.travellers += L.committed || 0;
      if (isFinite(L.cutoffMs) && L.cutoffMs - nowMs < 7 * DAY) out.closingThisWeek++;
      var g = seatsToGo(L);
      if (g && g.hot) out.oneToGo++;
    });
    return out;
  }

  function momentumText(m) {
    if (!m || m.travellers < 1) return null;
    var sub = [];
    if (m.closingThisWeek) sub.push(m.closingThisWeek + (m.closingThisWeek === 1 ? ' ride closes' : ' rides close') + ' this week');
    if (m.oneToGo) sub.push(m.oneToGo + (m.oneToGo === 1 ? ' needs' : ' need') + ' just one more');
    return { head: m.travellers + (m.travellers === 1 ? ' traveller' : ' travellers') + ' on the board right now', sub: sub.join(' · ') };
  }

  window.CHRideFomo = {
    seatsToGo: seatsToGo,
    closesText: closesText,
    privateCarFare: privateCarFare,
    shareMessage: shareMessage,
    momentum: momentum,
    momentumText: momentumText
  };
})();
```

- [ ] **Step 4: Run it to make sure it passes**

Run: `cd "$WT/web-tests" && npx vitest run unit/ride-fomo.test.js`
Expected: PASS. Vitest's summary reads `Tests  20 passed (20)` and the exit code is 0.

- [ ] **Step 5: Commit**

```bash
git -C "$WT" add ride-fomo.js web-tests/unit/ride-fomo.test.js docs/superpowers/plans/2026-10-19-ride-board-fomo.md
git -C "$WT" commit -m "feat(board): ride-fomo.js — seats to go, names-close clock, private-car fare, share wording

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

(`ride-fomo.js` isn't referenced by any page yet, so `npm run stamp` has nothing to do here.)

---

### Task 2: FOMO rows on the board

**Files:**
- Modify: `board.html` — script tag after `shared-day.js` (~line 1040); row CSS (~lines 186–203, 652–654, 620–633 and 694–703 on `origin/main` 96bb56e7)
- Modify: `board.js` — `faces()` (~line 744), `rowHtml()` (~line 800), `startTicker()` (~line 2189)
- Modify: `ride-fomo.js` (`closesText` gains `opts.short`), `web-tests/unit/ride-fomo.test.js`
- Modify: `web-tests/e2e/ride-board-rows.spec.js:42`, `web-tests/e2e/ride-board-scheduled.spec.js:66-89`
- Test: `web-tests/e2e/ride-board-fomo.spec.js` (new)

**Interfaces:**
- Consumes: `CHRideFomo.seatsToGo`, `.closesText`, `.privateCarFare` (Task 1).
- Produces these row markup hooks for Task 3:
  - `.rw-acts` wraps the row's action button(s).
  - `.rw-togo` (`.hot`) and `.rw-close[data-close]` (`.urgent`).
  - `.rw-open` dashed seats.
  - `.rw-vs`.
  - `.rw-state.fomo`.

- [ ] **Step 1: Write the failing test** — create `web-tests/e2e/ride-board-fomo.spec.js`:

```js
import { test, expect } from '@playwright/test';
import { isApiRequest } from './_api-host.js';

// FOMO rows (plan 2026-10-19-ride-board-fomo): a gathering ride says how many seats it still
// needs, when names close, and what the same trip costs in a private car; its open seats show
// as dashed faces. The clock is pinned so the countdown is exact.
const NOW = '2099-08-10T00:00:00.000Z';
const member = (n, c) => ({ firstName: n, country: c, photoUrl: null });
const ride = (o) => ({ corridorId: 'ella-south', from: 'Ella', to: 'Mirissa', slot: 'morning', minSeats: 3, capacity: 6,
  seatPrice: 2800, status: 'gathering', note: null, lockedTime: null, ...o });
const LISTS = [
  ride({ code: 'FO-1', date: '2099-08-12', cutoffAt: '2099-08-10T09:12:00.000Z', committed: 2, members: [member('Tom', 'GB'), member('Lea', 'FR')] }),
  ride({ code: 'FO-2', date: '2099-08-20', cutoffAt: '2099-08-18T01:30:00.000Z', committed: 1, members: [member('Sam', 'CA')] }),
  ride({ code: 'FO-3', date: '2099-08-11', cutoffAt: '2099-08-09T01:30:00.000Z', status: 'confirmed', committed: 3,
    members: [member('Ann', 'PL'), member('Yuki', 'JP'), member('Ben', 'IE')] }),
  // still "gathering" but past its cutoff — names closed, the sweep has not run yet
  ride({ code: 'FO-4', date: '2099-08-11', cutoffAt: '2099-08-09T01:30:00.000Z', committed: 1, members: [member('Ola', 'SE')] }),
  // full, with its cutoff still ahead
  ride({ code: 'FO-5', date: '2099-08-15', cutoffAt: '2099-08-13T01:30:00.000Z', status: 'confirmed', committed: 6,
    members: ['Tom', 'Ela', 'Kim', 'Nat', 'Jo', 'Sam'].map((n) => member(n, 'AU')) }),
];

async function stubApi(page, lists = LISTS) {
  await page.route((u) => isApiRequest(u), (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/board') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ lists }) });
    if (p === '/board/me') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ me: null }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

async function open(page) {
  await page.clock.setFixedTime(new Date(NOW));
  await stubApi(page);
  await page.goto('/board.html');
  await expect(page.locator('.rw[data-code="FO-1"]')).toBeVisible({ timeout: 15000 });
}

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('a ride one short says so, runs a red clock and shows its open seat', async ({ page }) => {
    await open(page);
    const row = page.locator('.rw[data-code="FO-1"]');
    await expect(row.locator('.rw-togo')).toHaveText('1 seat to go');
    await expect(row.locator('.rw-togo')).toHaveClass(/hot/);
    // on a phone the closing line rides on the time line, not under the pill — in its short form
    await expect(row.locator('.rw-when .rw-close')).toHaveText('Closes in 9h 12m');
    await expect(row.locator('.rw-when .rw-close')).toHaveClass(/urgent/);
    await expect(row.locator('.rw-state .rw-close')).toBeHidden();
    await expect(row.locator('.rw-open')).toHaveCount(1);
    await expect(row.locator('.rw-vs')).toHaveText(/^vs \$\d+(\.\d{2})? private car$/);
    // the ticker repaints every second and must keep each copy's form (the clock is pinned, so
    // the text itself cannot change — only its form could)
    await page.waitForTimeout(1200);
    await expect(row.locator('.rw-when .rw-close')).toHaveText('Closes in 9h 12m');
    await expect(row.locator('.rw-state .rw-close')).toHaveText('Names close in 9h 12m');
  });

  test('a ride further out gives its Sri Lanka closing date, calmly', async ({ page }) => {
    await open(page);
    const row = page.locator('.rw[data-code="FO-2"]');
    await expect(row.locator('.rw-togo')).toHaveText('2 seats to go');
    await expect(row.locator('.rw-togo')).not.toHaveClass(/hot/);
    // 01:30 UTC on the 18th is 07:00 on the 18th in Colombo
    await expect(row.locator('.rw-when .rw-close')).toHaveText('Closes 18 Aug');
    await expect(row.locator('.rw-open')).toHaveCount(2);
  });

  test('locked, names-closed and full rides keep their own wording — no seats to go, no closing line, no comparison', async ({ page }) => {
    await open(page);
    for (const [code, label] of [['FO-3', 'Locked in'], ['FO-4', 'Names closed'], ['FO-5', 'Full']]) {
      const row = page.locator(`.rw[data-code="${code}"]`);
      await expect(row.locator('.rw-state')).toContainText(label);
      await expect(row.locator('.rw-togo')).toHaveCount(0);
      await expect(row.locator('.rw-close')).toHaveCount(0);
      await expect(row.locator('.rw-vs')).toHaveCount(0);
      const over = await row.locator('.rw-when').evaluate((el) => el.scrollWidth > el.clientWidth + 1);
      expect(over, `${code}: the time line overflows`).toBe(false);
    }
  });

  test('a FOMO row stays inside the screen', async ({ page }) => {
    await open(page);
    const over = await page.locator('.rw[data-code="FO-1"]').evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(over).toBe(false);
    const pageOver = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(pageOver).toBe(false);
  });
});

for (const width of [768, 1020, 1280]) {
  test(`at ${width}px the seat state never runs into the price or the actions`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    const hit = (x, y) => x.x < y.x + y.width && y.x < x.x + x.width && x.y < y.y + y.height && y.y < x.y + x.height;
    for (const code of ['FO-1', 'FO-2']) {
      const row = page.locator(`.rw[data-code="${code}"]`);
      const s = await row.locator('.rw-state').boundingBox();
      const p = await row.locator('.rw-price').boundingBox();
      const a = await row.locator('.rw-acts').boundingBox();
      expect(hit(s, p), `${code}: state overlaps price`).toBe(false);
      expect(hit(s, a), `${code}: state overlaps actions`).toBe(false);
    }
  });
}
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd "$WT/web-tests" && npx playwright test e2e/ride-board-fomo.spec.js`
Expected: FAIL. `locator('.rw[data-code="FO-1"]').locator('.rw-togo')` — `Expected: "1 seat to go"`, `Received: <element(s) not found>`.

- [ ] **Step 3: Load `ride-fomo.js` on the board** — in `board.html`, change

```html
<script src="shared-day.js?v=cbcec2fb62" defer></script>
```

to

```html
<script src="shared-day.js?v=cbcec2fb62" defer></script>
<script src="ride-fomo.js" defer></script>
```

(Deferred scripts run in document order, so `window.CHRideFomo` exists before `board.js` runs. The `?v=` stamp is added in Step 9.)

- [ ] **Step 3b: A short form of the closing line, for a phone's time line.** Beside the price, the time line has ~170 px; "7–9 am · Names close Wed 12 Aug" needs 225. First the failing test — append to `web-tests/unit/ride-fomo.test.js`:

```js
describe("closesText, short form for a phone's time line", () => {
  it('says "Closes", drops the weekday, and keeps the clock', () => {
    expect(F.closesText(NOW + 9 * H + 12 * 60000, NOW, { short: true })).toEqual({ text: 'Closes in 9h 12m', live: true, urgent: true });
    expect(F.closesText(Date.parse('2099-08-14T20:00:00Z'), NOW, { short: true }).text).toBe('Closes 15 Aug');
    expect(F.closesText(NOW - 1, NOW, { short: true }).text).toBe('Closed');
  });
});
```

Run `cd "$WT/web-tests" && npx vitest run unit/ride-fomo.test.js` — it fails on `'Names close in 9h 12m'` ≠ `'Closes in 9h 12m'`. Then in `ride-fomo.js` replace the `colomboDay` and `closesText` functions with:

```js
  // An instant → its Sri Lanka calendar date, "Fri 6 Nov" — or "6 Nov" where the weekday has no room.
  function colomboDay(ms, short) {
    var fmt = short ? { day: 'numeric', month: 'short', timeZone: 'UTC' } : { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' };
    return new Date(ms + COLOMBO_OFFSET_MS).toLocaleDateString('en-GB', fmt);
  }

  // When names close: a running clock inside three days (red inside one), a Sri Lanka date
  // further out. null with no cutoff to go on. `opts.short` is the phone's time-line form —
  // "Closes 12 Aug" — where the full line does not fit beside the price.
  function closesText(cutoffMs, nowMs, opts) {
    if (!isFinite(cutoffMs)) return null;
    var short = !!(opts && opts.short);
    var lead = short ? 'Closes' : 'Names close';
    var left = cutoffMs - nowMs;
    if (left <= 0) return { text: short ? 'Closed' : 'Names closed', live: false, urgent: false };
    if (left < LIVE_MS) return { text: lead + ' in ' + countdown(left), live: true, urgent: left < URGENT_MS };
    return { text: lead + ' ' + colomboDay(cutoffMs, short), live: false, urgent: false };
  }
```

Run the unit file again: `Tests  21 passed (21)`.

- [ ] **Step 4: Open seats in `faces()`** — in `board.js`, replace

```js
  // Up to four faces (flags ride on the avatars) and a "+N" for the rest.
  function faces(L) {
    var ms = L.members;
    var html = ms.slice(0, 4).map(function (m, i) { return avatar(m, i, 'xs' + (i ? ' stack' : '')); }).join('');
    if (ms.length > 4) html += '<span class="avatar xs stack rw-more">+' + (ms.length - 4) + '</span>';
    return html;
  }
```

with

```js
  // Up to four faces (flags ride on the avatars), a "+N" for the rest, then a dashed seat per
  // place the ride still needs filled — the gap a joiner would fill (plan 2026-10-19-ride-board-fomo).
  function faces(L, open) {
    var ms = L.members;
    var html = ms.slice(0, 4).map(function (m, i) { return avatar(m, i, 'xs' + (i ? ' stack' : '')); }).join('');
    if (ms.length > 4) html += '<span class="avatar xs stack rw-more">+' + (ms.length - 4) + '</span>';
    var shown = Math.min(ms.length, 5);
    for (var k = 0; k < Math.min(open || 0, 3); k++) {
      html += '<span class="avatar xs rw-open' + (shown + k ? ' stack' : '') + '" aria-hidden="true">+</span>';
    }
    return html;
  }
```

- [ ] **Step 5: FOMO state in `rowHtml()`** — in `board.js`, replace the whole `function rowHtml(L) { … }` with:

```js
  function rowHtml(L) {
    if (L.sched) return schedRowHtml(L);
    var F = window.CHRideFomo;
    var mine = iAmOn(L);
    var st = rowState(L, mine);
    var dur = durationOf(L);
    var win = windowLabel(L.slot);
    var hook = st.cta.kind === 'again' ? 'data-again' : 'data-view';
    var primary = st.cta.text === 'Join';
    // FOMO (plan 2026-10-19-ride-board-fomo): a ride still gathering says how many seats it
    // needs and when names close, shows its open seats, and what a private car would cost.
    // Locked, full and names-closed rows keep rowState's wording.
    var togo = st.cls === 'g' ? F.seatsToGo(L) : null;
    var closes = togo ? F.closesText(L.cutoffMs, Date.now()) : null;
    var priv = togo ? F.privateCarFare(L.fromId, L.toId, L.cost) : null;
    // The closing line is rendered twice: on the time line for phones (.rw-close-w — where the old
    // "decided" date sat — in its short form, "Closes 12 Aug", since ~170px is all it gets beside
    // the price) and in full under the pill for wider screens (.rw-close-s). CSS shows one per
    // width; the ticker updates both through [data-close], keeping each one's form.
    var closeSpan = function (where, short) {
      // only a ride still gathering has a closing line — locked, full and names-closed rows keep
      // rowState's wording (closes is null for them, whatever their cutoff)
      if (!closes) return '';
      var c = short ? F.closesText(L.cutoffMs, Date.now(), { short: true }) : closes;
      return c
        ? '<span class="rw-close ' + where + (c.urgent ? ' urgent' : '') + '" data-close="' + L.cutoffMs + '"' +
            (short ? ' data-close-short=""' : '') + '>' + esc(c.text) + '</span>'
        : '';
    };
    var seatHtml = togo
      ? '<span class="rw-state fomo"><b class="rw-togo' + (togo.hot ? ' hot' : '') + '">' + esc(togo.text) + '</b>' +
          (closes || mine
            ? '<small>' + (mine ? '<span class="rw-you">You\'re on it · </span>' : '') + closeSpan('rw-close-s') + '</small>'
            : '') +
        '</span>'
      : '<span class="rw-state ' + st.cls + '"><b>' + esc(st.label) + '</b><small>' + esc(st.sub) + '</small></span>';
    return '<article class="rw' + (mine ? ' mine' : '') + '" data-code="' + esc(L.code) + '" tabindex="0"' +
      ' aria-label="' + esc(L.from + ' to ' + L.to + ', ' + L.whenLabel + ', ' + win + ', ' + (togo ? togo.text : st.label)) + '">' +
      '<div class="rw-when' + (closes ? ' has-close' : '') + '">' + esc(win) + (dur ? '<span class="rw-dur"> · ' + esc(dur) + '</span>' : '') + closeSpan('rw-close-w', true) + '</div>' +
      '<div class="rw-route"><span class="rw-places">' + placeTag(L.from, 'a') + '<span class="arr">→</span>' + placeTag(L.to, 'b') + '</span>' +
        (dur ? '<small>' + esc(dur) + '</small>' : '') + '</div>' +
      '<div class="rw-seats"><span class="rw-faces">' + faces(L, togo ? togo.need : 0) + '</span>' + seatHtml + '</div>' +
      '<div class="rw-price"><span class="rw-fare">≈ <b>' + money(L.cost) + '</b><span class="rw-each"> each</span></span>' +
        (priv ? '<span class="rw-vs">vs ' + money(priv) + ' private car</span>' : '') + '</div>' +
      '<div class="rw-acts">' +
        '<button class="btn btn-sm ' + (primary ? 'btn-primary' : 'btn-ghost') + ' rw-cta" ' + hook + '="' + esc(L.code) + '">' +
          esc(st.cta.text) + '</button>' +
      '</div>' +
      '</article>';
  }
```

(`rowState` is unchanged. It still returns `decided`, which nothing renders now. Its unit tests in `ride-board-rows.test.js` stay as they are.)

- [ ] **Step 6: Tick the names-close clock** — in `board.js` `startTicker()`, replace

```js
  function startTicker() {
    setInterval(function () {
      document.querySelectorAll('.countdown[data-cut]').forEach(function (el) {
```

with

```js
  function startTicker() {
    setInterval(function () {
      // FOMO rows' "Names close in …" (plan 2026-10-19-ride-board-fomo)
      var now = Date.now();
      document.querySelectorAll('[data-close]').forEach(function (el) {
        var c = window.CHRideFomo.closesText(+el.getAttribute('data-close'), now, { short: el.hasAttribute('data-close-short') });
        if (!c) return;
        if (el.textContent !== c.text) el.textContent = c.text;
        el.classList.toggle('urgent', c.urgent);
      });
      document.querySelectorAll('.countdown[data-cut]').forEach(function (el) {
```

- [ ] **Step 7: Row CSS** — in `board.html`:

(a) After the line `.rw-state.f b{color:var(--ink-soft)}`, insert:

```css
/* FOMO rows (plan 2026-10-19-ride-board-fomo): a gathering ride says how many seats it still
   needs and when names close, and leaves its open seats visible as dashed faces. The state
   has no g/l/f class, so .rw-state.g b's amber never reaches the pill. */
.rw-state.fomo{gap:3px}
.rw-togo{display:inline-flex;align-items:center;gap:6px;align-self:flex-start;padding:2px 9px;border-radius:999px;
  background:var(--pc-saffron);color:#7a4f00;font-size:.78rem;font-weight:800;white-space:nowrap}
.rw-togo::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--saffron);flex:none}
.rw-togo.hot{background:#fde4e0;color:#B01E0B}
.rw-togo.hot::before{background:var(--tomato);animation:rwPulse 1.6s ease-out infinite}
@keyframes rwPulse{0%{box-shadow:0 0 0 0 rgba(var(--cta-rgb),.5)}70%{box-shadow:0 0 0 7px rgba(var(--cta-rgb),0)}100%{box-shadow:0 0 0 0 rgba(var(--cta-rgb),0)}}
@media (prefers-reduced-motion:reduce){.rw-togo.hot::before{animation:none}}
.rw-close.urgent{color:#C82511;font-weight:700}
.rw-close-w{display:none} /* the time-line copy is for phones (see the 640px block) */
/* outranks .avatar.xs.stack (later in this sheet, same 3 classes), which would repaint the dashed border solid */
.rw-faces .avatar.xs.rw-open{background:var(--paper);color:#8f897a;border:1.5px dashed #b9b3a3;box-shadow:none;font-size:.8rem}
.rw-fare{display:block}
.rw-vs{display:block;font-size:.72rem;color:var(--ink-soft)}
```

(b) Replace `.rw .rw-cta{justify-self:end;white-space:nowrap}` with:

```css
.rw-acts{display:flex;align-items:center;justify-content:flex-end;gap:8px;min-width:0}
.rw .rw-cta{white-space:nowrap}
```

(c) In the `@media(max-width:1020px)` block, replace `.rw .rw-cta{grid-area:cta}` with `.rw-acts{grid-area:cta}`.

(d) Delete these three lines (now dead: nothing renders `.rw-dec-*`):

```css
.rw-dec-w{display:none}
/* its own line under "needs 1 more": beside it, a laptop row cut it to "decided …" */
.rw-dec-s{display:block}
```

(e) In the second phone block (the one with `.rws-more`), replace

```css
  /* the decided date rides on the time line, where there is room; the seat line stays one line */
  .rw-dec-w{display:inline}
  .rw-dec-s{display:none}
  /* ...and makes room for itself: a gathering row's duration (it is in the ride sheet) and the
     price's "each" give way, so the time line stays one line down to a 360px phone */
  .rw-when.has-dec .rw-dur,.rw-each{display:none}
```

with

```css
  /* the price's "each" gives way so the price stays one short line on a 360px phone */
  .rw-each{display:none}
```

(f) In the `@media(max-width:640px)` "two-line rows" block, after `.rw-state small::before{content:"· "}`, insert:

```css
  /* FOMO: beside the faces only the pill fits, so the closing line moves to the time line (where
     the old "decided" date sat) and the duration gives way to it, as it did before */
  .rw-state.fomo{flex-direction:column;align-items:flex-start;row-gap:3px}
  .rw-state.fomo small::before{content:none}
  .rw-state.fomo .rw-close-s{display:none}
  .rw-close-w{display:inline}
  .rw-close-w::before{content:" · "}
  .rw-when.has-close .rw-dur{display:none}
```

- [ ] **Step 8: Move the existing assertions to the new wording**

In `web-tests/e2e/ride-board-rows.spec.js`, replace

```js
  await expect(page.locator('.rw[data-code="RW-1"] .rw-state')).toContainText('3 of 4 in');
```

with

```js
  await expect(page.locator('.rw[data-code="RW-1"] .rw-state')).toContainText('1 seat to go');
```

In `web-tests/e2e/ride-board-scheduled.spec.js`, replace everything from `  test('a traveller ride says when it is decided, on the phone too', async ({ page }) => {` through the closing `  });` of `  test('on a laptop the decided date sits under the seat count instead', async ({ page }) => {` with:

```js
  test('a traveller ride says when names close, on the phone too', async ({ page }) => {
    await stubApi(page);
    await page.goto('/board.html');
    const row = page.locator('.rw[data-code="SC-1"]');
    await expect(row).toBeVisible({ timeout: 15000 });
    // 20:00 UTC on the 11th is the 12th in Colombo — far enough out to be a date, not a clock.
    // On a phone it rides on the time line (where the "decided" date used to), in its short form.
    const close = row.locator('.rw-when .rw-close');
    await expect(close).toBeVisible();
    await expect(close).toHaveText('Closes 12 Aug');
    await expect(row.locator('.rw-state .rw-close')).toBeHidden();
    // the whole line is on screen, not cut to "Names cl…"
    const clipped = await row.locator('.rw-when').evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(clipped).toBe(false);
  });

  test('on a laptop the closing date sits under the seats to go instead', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await stubApi(page);
    await page.goto('/board.html');
    const row = page.locator('.rw[data-code="SC-1"]');
    await expect(row).toBeVisible({ timeout: 15000 });
    await expect(row.locator('.rw-state .rw-close')).toBeVisible();
    await expect(row.locator('.rw-when .rw-close')).toBeHidden();
    const togo = await row.locator('.rw-togo').boundingBox();
    const close = await row.locator('.rw-state .rw-close').boundingBox();
    expect(close.y).toBeGreaterThan(togo.y);
  });
```

In `web-tests/e2e/ride-board-rows.spec.js` (the "on a phone a ride stays a compact row" test), replace

```js
    // 110: the price sits on the time line since the route took the full width (#622)
    expect(h - route, `${code}: ${Math.round(h)}px row, ${Math.round(route)}px of it route`).toBeLessThan(110);
```

with

```js
    // 135: a gathering ride now carries its seats-to-go pill beside the faces and the private-car
    // line under the fare (plan 2026-10-19-ride-board-fomo), ~123px without the route; 110 was the
    // plain two-line row. Still a row, not a card: a third line of anything would trip this.
    expect(h - route, `${code}: ${Math.round(h)}px row, ${Math.round(route)}px of it route`).toBeLessThan(135);
```

(The old rows were 130px with 104px outside the route; the FOMO row measured 155px with 129px outside it on 2026-10-21. The owner approved the taller row on the prototype.)

- [ ] **Step 9: Stamp, then run the board specs**

```bash
cd "$WT" && npm run stamp
cd "$WT/web-tests" && npx vitest run unit/ride-fomo.test.js && npx playwright test e2e/ride-board-fomo.spec.js e2e/ride-board-rows.spec.js e2e/ride-board-scheduled.spec.js e2e/ride-board-full-van.spec.js e2e/ride-board-closed-ride.spec.js e2e/ride-board-locked-cta.spec.js
```

Expected: `stamped N asset refs (…files changed)` with `board.html` among the changed files; vitest `Tests  21 passed (21)`; then Playwright's summary line shows every test passed, exit code 0.

- [ ] **Step 10: Commit**

```bash
git -C "$WT" add board.js board.html ride-fomo.js web-tests/unit/ride-fomo.test.js web-tests/e2e/ride-board-fomo.spec.js web-tests/e2e/ride-board-rows.spec.js web-tests/e2e/ride-board-scheduled.spec.js
git -C "$WT" status --short   # anything else stamp touched must be added by path too
git -C "$WT" commit -m "feat(board): rows say seats to go, when names close, and the private car they beat

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: One-tap sharing (row, ride page, "you're on the list")

**Files:**
- Modify: `board.html` — share-sheet markup and CSS; `#share-native` button in `#mstep-3`
- Modify: `board.js` — `SHARE_SVG`; share button in `rowHtml()`; `[data-share]` binding in `render()`; `.d-share` in `renderDetail()`; `prepShare()`; new sharing functions
- Modify: `web-tests/e2e/ride-board-start-no-card.spec.js` (one assertion)
- Modify: `web-tests/unit/gtm-event-coverage.test.js` (the new `share` event is deliberately untagged until the owner imports a GTM tag — Decision 2)
- Test: `web-tests/e2e/ride-board-share-sheet.spec.js` (new)

**Interfaces:**
- Consumes: `CHRideFomo.seatsToGo`, `.closesText`, `.privateCarFare`, `.shareMessage` (Task 1); `.rw-acts` (Task 2); existing `shareUrlFor(code)`, `windowLabel(slot)`, `money()`, `mySeatsOn(L)`, `iAmOn(L)`, `isClosed(L)`, `copy(text)`, `ev(name, params)`.
- Produces: `shareTextFor(L) → string`, `shareRide(L, via)`, `#share-sheet`, `[data-share]` on rows, `[data-share-detail]` on the ride page, `#share-native` on the success step.

- [ ] **Step 1: Write the failing test** — create `web-tests/e2e/ride-board-share-sheet.spec.js`:

```js
import { test, expect } from '@playwright/test';
import { isApiRequest } from './_api-host.js';

// Sharing a ride (plan 2026-10-19-ride-board-fomo): one tap from a row, the ride page or the
// "you're on the list" screen — the phone's own share menu when there is one, our sheet if not.
const NOW = '2099-08-10T00:00:00.000Z';
const OPEN = { code: 'SH-1', corridorId: 'ella-south', from: 'Ella', to: 'Mirissa', date: '2099-08-12', slot: 'morning',
  minSeats: 3, capacity: 6, seatPrice: 2800, status: 'gathering', note: null, lockedTime: null,
  cutoffAt: '2099-08-10T09:12:00.000Z', committed: 2,
  members: [{ firstName: 'Tom', country: 'GB', photoUrl: null }, { firstName: 'Lea', country: 'FR', photoUrl: null }] };
const CLOSED = { ...OPEN, code: 'SH-2', date: '2099-08-11', cutoffAt: '2099-08-09T01:30:00.000Z', status: 'confirmed', committed: 3,
  members: [...OPEN.members, { firstName: 'Ben', country: 'IE', photoUrl: null }] };
// Confirmed with its cutoff still ahead (a hand-moved cutoff), and full while still gathering —
// each fails ONE of the three share conditions on its own, so dropping any one condition fails a test.
const CONFIRMED_OPEN = { ...OPEN, code: 'SH-3', date: '2099-08-14', cutoffAt: '2099-08-12T01:30:00.000Z', status: 'confirmed', committed: 3,
  members: [...OPEN.members, { firstName: 'Ben', country: 'IE', photoUrl: null }] };
const FULL = { ...OPEN, code: 'SH-4', date: '2099-08-16', cutoffAt: '2099-08-14T01:30:00.000Z', committed: 6,
  members: ['Tom', 'Lea', 'Ben', 'Kim', 'Nat', 'Jo'].map((n) => ({ firstName: n, country: 'AU', photoUrl: null })) };
const LISTS = [OPEN, CLOSED, CONFIRMED_OPEN, FULL];

async function stubApi(page) {
  await page.route((u) => isApiRequest(u), (route) => {
    const p = new URL(route.request().url()).pathname;
    const json = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (p === '/board') return json({ lists: LISTS });
    if (p === '/board/me') return json({ me: null });
    const one = LISTS.find((l) => p === '/board/' + l.code);
    if (one) return json(one);
    return json({});
  });
}

async function open(page) {
  await page.clock.setFixedTime(new Date(NOW));
  await stubApi(page);
  await page.goto('/board.html');
  await expect(page.locator('.rw[data-code="SH-1"]')).toBeVisible({ timeout: 15000 });
}

test('a row shares through the phone menu — seats, saving, deadline — and stays on the board', async ({ page }) => {
  await page.addInitScript(() => {
    window.__shared = [];
    Object.defineProperty(navigator, 'share', { configurable: true, value: (d) => { window.__shared.push(d); return Promise.resolve(); } });
  });
  await open(page);
  await page.locator('.rw[data-code="SH-1"] [data-share]').click();
  const shared = await page.evaluate(() => window.__shared);
  expect(shared).toHaveLength(1);
  expect(shared[0].url).toContain('/r/SH-1');
  // a visitor is not on the ride, so it never says "I'm taking"
  expect(shared[0].text).toMatch(/^Shared taxi Ella → Mirissa on /);
  expect(shared[0].text).toContain('1 seat left to make it run');
  expect(shared[0].text).toMatch(/instead of \$\d+(\.\d{2})? for a private car/);
  expect(shared[0].text).toContain('Names close in 9h 12m');
  await expect(page.locator('body')).not.toHaveClass(/detail-open/);
});

test('with no phone menu, the sheet offers WhatsApp, Telegram, Facebook and the link', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(navigator, 'share', { configurable: true, value: undefined }); });
  await open(page);
  await page.locator('.rw[data-code="SH-1"] [data-share]').click();
  const sheet = page.locator('#share-sheet');
  await expect(sheet).toBeVisible();
  await expect(page.locator('#ss-msg')).toContainText('1 seat left to make it run');
  expect(decodeURIComponent(await page.locator('#ss-wa').getAttribute('href'))).toContain('/r/SH-1');
  expect(await page.locator('#ss-tg').getAttribute('href')).toMatch(/^https:\/\/t\.me\/share\/url\?url=/);
  expect(decodeURIComponent(await page.locator('#ss-fb').getAttribute('href'))).toContain('/r/SH-1');
  await expect(page.locator('#ss-url')).toHaveValue(/\/r\/SH-1$/);
  await page.locator('#ss-close').click();
  await expect(sheet).toBeHidden();
});

test('a ride that cannot take anyone — names closed, confirmed, or full — offers no share, on its row or its page', async ({ page }) => {
  await open(page);
  for (const code of ['SH-2', 'SH-3', 'SH-4']) {
    const row = page.locator(`.rw[data-code="${code}"]`);
    await expect(row.locator('[data-share]')).toHaveCount(0);
    // the whole row opens the ride (a full row has no [data-view] button to click)
    await row.locator('.rw-route').click();
    await expect(page.locator('body')).toHaveClass(/detail-open/);
    await expect(page.locator('.d-share')).toHaveCount(0);
    await page.locator('#d-back').click();
    await expect(page.locator('body')).not.toHaveClass(/detail-open/);
  }
});

test("the ride page's WhatsApp carries the same message, and a Share… button", async ({ page }) => {
  await open(page);
  await page.locator('.rw[data-code="SH-1"] [data-view]').click();
  await expect(page.locator('body')).toHaveClass(/detail-open/);
  const wa = decodeURIComponent(await page.locator('.d-share a.btn-wa').getAttribute('href'));
  expect(wa).toContain('1 seat left to make it run');
  expect(wa).toContain('/r/SH-1');
  await expect(page.locator('.d-share [data-share-detail]')).toBeVisible();
});
```

In `web-tests/e2e/ride-board-start-no-card.spec.js`, inside `test('starting a ride sends no billing details and goes straight to the share step', …)`, right after the line `  await expect(page.locator('#mstep-3')).toBeVisible();`, add:

```js
  // the share step leads with one tap to the phone's share menu (plan 2026-10-19-ride-board-fomo)
  await expect(page.locator('#share-native')).toBeVisible();
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd "$WT/web-tests" && npx playwright test e2e/ride-board-share-sheet.spec.js e2e/ride-board-start-no-card.spec.js`
Expected: FAIL. `locator('.rw[data-code="SH-1"] [data-share]')` times out waiting for the element, and `#share-native` is not found.

- [ ] **Step 3: Markup** — in `board.html`:

(a) In `#mstep-3`, replace

```html
        <div class="share-btns">
          <a class="btn btn-wa" id="wa-share" target="_blank" rel="noopener">
```

with

```html
        <button class="btn btn-primary btn-block" id="share-native" type="button" style="margin-bottom:10px">Share — fill it faster</button>
        <div class="share-btns">
          <a class="btn btn-wa" id="wa-share" target="_blank" rel="noopener">
```

(b) Immediately before `<main class="detail" id="detail">`, insert:

```html
<!-- Share sheet: only when the phone has no share menu of its own (plan 2026-10-19-ride-board-fomo) -->
<div class="share-sheet" id="share-sheet" role="dialog" aria-modal="true" aria-labelledby="ss-title" hidden>
  <div class="ss-card">
    <div class="ss-head"><h2 id="ss-title">Share this ride</h2><button class="ss-close" id="ss-close" type="button" aria-label="Close">✕</button></div>
    <p class="ss-msg" id="ss-msg"></p>
    <div class="ss-apps">
      <a class="btn btn-wa btn-sm" id="ss-wa" target="_blank" rel="noopener">WhatsApp</a>
      <a class="btn btn-ghost btn-sm" id="ss-tg" target="_blank" rel="noopener">Telegram</a>
      <a class="btn btn-ghost btn-sm" id="ss-fb" target="_blank" rel="noopener">Facebook</a>
    </div>
    <div class="copy-row"><input readonly id="ss-url" aria-label="Ride link"><button class="btn btn-ghost btn-sm" id="ss-copy" type="button">Copy</button></div>
  </div>
</div>
```

(c) CSS — after the Task 2 FOMO rules, insert:

```css
/* row share button: an outline circle beside Join, never a second solid button */
.rw-share{width:36px;height:36px;border-radius:50%;border:1px solid var(--line);background:#fff;color:var(--accent-deep);
  display:grid;place-items:center;cursor:pointer;flex:none;padding:0}
.rw-share svg{width:17px;height:17px}
.rw-share:hover{background:var(--pc-sky)}
.rw-share:focus-visible{outline:2px solid var(--accent-deep);outline-offset:2px}
/* share sheet — above the join overlay (z 100) */
.share-sheet{position:fixed;inset:0;z-index:110;background:rgba(40,38,39,.48);display:flex;align-items:flex-end;justify-content:center}
.share-sheet[hidden]{display:none}
.ss-card{width:min(520px,100%);box-sizing:border-box;background:var(--paper);border-radius:22px 22px 0 0;
  padding:16px 18px calc(20px + env(safe-area-inset-bottom,0px));display:flex;flex-direction:column;gap:14px;box-shadow:0 -8px 30px rgba(0,0,0,.18)}
@media(min-width:641px){.share-sheet{align-items:center}.ss-card{border-radius:22px}}
.ss-head{display:flex;align-items:center;justify-content:space-between}
.ss-head h2{margin:0;font-size:1.3rem}
.ss-close{width:44px;height:44px;border:0;background:none;font-size:1.1rem;color:var(--ink);cursor:pointer}
.ss-msg{margin:0;padding:12px 14px;background:#fff;border:1px solid var(--line);border-radius:14px;font-size:.88rem;line-height:1.5;color:var(--ink)}
.ss-apps{display:flex;gap:8px;flex-wrap:wrap}
```

- [ ] **Step 4: Share button on rows** — in `board.js`:

(a) After the `var CLOCK_SVG = …;` line, add:

```js
  var SHARE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"/><path d="M16 6l-4-4-4 4"/><path d="M12 2v13"/></svg>';
```

(b) In `rowHtml()` (Task 2 version), replace

```js
      '<div class="rw-acts">' +
        '<button class="btn btn-sm '
```

with

```js
      '<div class="rw-acts">' +
        // share only a ride that can still take someone: never one confirmed, closed or full
        (!L.confirmed && !isClosed(L) && L.committed < L.capacity
          ? '<button class="rw-share" type="button" data-share="' + esc(L.code) + '" aria-label="Share this ride">' + SHARE_SVG + '</button>'
          : '') +
        '<button class="btn btn-sm '
```

(c) In `render()`, after the `grid.querySelectorAll('[data-again]').forEach(…);` block, add:

```js
    grid.querySelectorAll('[data-share]').forEach(function (el) {
      el.addEventListener('click', function (e) { e.stopPropagation(); shareRide(state.byCode[el.getAttribute('data-share')], 'row'); });
    });
```

- [ ] **Step 5: The sharing functions** — in `board.js`, directly above `function prepShare(L, need) {`, add:

```js
  /* ---------------- sharing (plan 2026-10-19-ride-board-fomo) ----------------
     One way to share a ride from anywhere on the page: the phone's own share menu when there
     is one (every app the traveller has, one tap), else our sheet with WhatsApp, Telegram,
     Facebook and the link. The words come from CHRideFomo.shareMessage, so a row, the ride
     page and the "you're on the list" screen all send the same thing. */
  function shareTextFor(L) {
    var F = window.CHRideFomo;
    var togo = F.seatsToGo(L);
    var closes = F.closesText(L.cutoffMs, Date.now());
    var priv = F.privateCarFare(L.fromId, L.toId, L.cost);
    return F.shareMessage({
      mine: mySeatsOn(L) > 0 || iAmOn(L),
      route: L.from + ' → ' + L.to,
      when: L.whenLabel + ' (' + windowLabel(L.slot) + ')',
      need: togo ? togo.need : 0,
      fare: money(L.cost),
      priv: priv ? money(priv) : null,
      closes: closes && closes.text !== 'Names closed' ? closes.text : null
    });
  }

  var shareSheet = document.getElementById('share-sheet');
  function openShareSheet(L, text, url, via) {
    document.getElementById('ss-msg').textContent = text + ' ' + url;
    document.getElementById('ss-url').value = url;
    document.getElementById('ss-wa').href = 'https://wa.me/?text=' + encodeURIComponent(text + ' ' + url);
    document.getElementById('ss-tg').href = 'https://t.me/share/url?url=' + encodeURIComponent(url) + '&text=' + encodeURIComponent(text);
    document.getElementById('ss-fb').href = 'https://www.facebook.com/sharer/sharer.php?u=' + encodeURIComponent(url);
    ['ss-wa', 'ss-tg', 'ss-fb'].forEach(function (id) {
      document.getElementById(id).onclick = function () {
        ev('share', { method: id.slice(3), content_type: 'ride', item_id: L.code, via: via });
      };
    });
    document.getElementById('ss-copy').onclick = function () {
      var self = this;
      ev('share', { method: 'copy', content_type: 'ride', item_id: L.code, via: via });
      copy(url).then(function () { self.textContent = 'Copied ✓'; setTimeout(function () { self.textContent = 'Copy'; }, 1600); });
    };
    shareSheet.hidden = false;
    document.getElementById('ss-close').focus();
  }
  function closeShareSheet() { shareSheet.hidden = true; }
  document.getElementById('ss-close').addEventListener('click', closeShareSheet);
  shareSheet.addEventListener('click', function (e) { if (e.target === shareSheet) closeShareSheet(); });
  shareSheet.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeShareSheet(); });

  function shareRide(L, via) {
    if (!L) return;
    var url = shareUrlFor(L.code), text = shareTextFor(L);
    if (navigator.share) {
      navigator.share({ title: L.from + ' → ' + L.to + ' · shared taxi', text: text, url: url })
        .then(function () { ev('share', { method: 'native', content_type: 'ride', item_id: L.code, via: via }); })
        // AbortError = the traveller closed the menu; anything else, offer our sheet instead
        .catch(function (e) { if (!e || e.name !== 'AbortError') openShareSheet(L, text, url, via); });
      return;
    }
    openShareSheet(L, text, url, via);
  }
```

- [ ] **Step 6: Ride page + success step use it** — in `board.js`:

(a) In `renderDetail()`, replace

```js
    var waText = 'shared taxi ' + L.from + ' → ' + L.to + ', ' + L.whenLabel + ' — ≈' + money(L.cost) + ' each, $0 unless it runs: ' + shareUrl;
```

with

```js
    var waText = shareTextFor(L) + ' ' + shareUrl;
```

(b) In the same function, replace

```js
        '<button class="btn btn-ghost btn-sm" data-copy="' + esc(shareUrl) + '">Copy link</button>' +
```

with

```js
        '<button class="btn btn-ghost btn-sm" data-copy="' + esc(shareUrl) + '">Copy link</button>' +
        '<button class="btn btn-ghost btn-sm" type="button" data-share-detail>Share…</button>' +
```

(c) After the line `detailInner.querySelector('#d-back').addEventListener('click', closeDetail);`, add:

```js
    var sd = detailInner.querySelector('[data-share-detail]');
    if (sd) sd.addEventListener('click', function () { shareRide(L, 'detail'); });
```

(d) In `prepShare(L, need)`, replace

```js
    var msg = 'hey — I put my name on a shared taxi list, ' + L.from + ' → ' + L.to + ', ' + L.whenLabel + ' · ' + s + '. ≈' + money(L.cost) + ' each, runs when ' + (need > 0 ? need + ' more sign' : 'you grab a seat') + ', $0 if it doesn\'t happen. add your name: ' + url;
```

with

```js
    var msg = shareTextFor(L) + ' ' + url;
    document.getElementById('share-native').onclick = function () { shareRide(L, 'joined'); };
```

- [ ] **Step 6b: Tell the GTM coverage guard the `share` event is untagged on purpose.** `web-tests/unit/gtm-event-coverage.test.js` fails on any event the site emits that has no tag in `tools/analytics/build-gtm-missing-tags.mjs` and is not listed as deliberately untagged. Building the tag (and regenerating `docs/analytics/gtm-missing-tags.json` for the owner to import) is its own step — Decision 2 at the top of this plan. So in that test file replace

```js
const DELIBERATELY_UNTAGGED = new Set(['ch_context', 'experience_interest']);
```

with

```js
/* 'share' (plan 2026-10-19-ride-board-fomo, PR 1): one-tap sharing of a ride from the board. Its GA4
   tag is the owner's import step, like experience_interest. */
const DELIBERATELY_UNTAGGED = new Set(['ch_context', 'experience_interest', 'share']);
```

- [ ] **Step 6c (review fix): one predicate decides whether a ride is shareable, on all three surfaces.** The task reviewer found the ride page's `.d-share` block (gated on `shut`, which excludes confirmed rides) and the success step (no gate) still offered a share on confirmed and full rides — and `shareMessage` then says "It's running and there are seats left" for a full ride. A ride past its cutoff cannot be joined (the join route refuses it, #597), so a share link to it is the same dead end #717 removed for closed rides. In `board.js`:

Directly above `function shareTextFor(L) {`, add:

```js
  // A ride worth sharing is one a friend can still join: not confirmed (the join route refuses a
  // ride past its cutoff, #597), not closed, not full. Rows, the ride page and the share step all ask this.
  function canShare(L) { return !!L && !L.confirmed && !isClosed(L) && L.committed < L.capacity; }
```

In `rowHtml()`, replace

```js
        (!L.confirmed && !isClosed(L) && L.committed < L.capacity
          ? '<button class="rw-share"
```

with

```js
        (canShare(L)
          ? '<button class="rw-share"
```

In `shareTextFor`, replace `      closes: closes && closes.text !== 'Names closed' ? closes.text : null` with `      closes: closes && !isClosed(L) ? closes.text : null`.

In `openShareSheet`, replace

```js
    ['ss-wa', 'ss-tg', 'ss-fb'].forEach(function (id) {
      document.getElementById(id).onclick = function () {
        ev('share', { method: id.slice(3), content_type: 'ride', item_id: L.code, via: via });
      };
    });
```

with

```js
    // GA4 `method` values are dimension values once the owner builds the tag — full names, like
    // the 'native' and 'copy' the other paths send
    var METHOD = { 'ss-wa': 'whatsapp', 'ss-tg': 'telegram', 'ss-fb': 'facebook' };
    Object.keys(METHOD).forEach(function (id) {
      document.getElementById(id).onclick = function () {
        ev('share', { method: METHOD[id], content_type: 'ride', item_id: L.code, via: via });
      };
    });
```

In `renderDetail()`, replace

```js
      (shut ? '' :
        '<div class="d-share">
```

with

```js
      (!canShare(L) ? '' :
        '<div class="d-share">
```

In `prepShare(L, need)`, directly after `    var url = shareUrlFor(L.code);`, add:

```js
    // The share step only offers a share a friend can act on — not after the join that filled the
    // last seat, and not on a ride already locked. style.display, not `hidden`: the .btn and
    // .share-btns display rules outrank the [hidden] reset.
    var share = canShare(L);
    [document.getElementById('share-native'), document.querySelector('#mstep-3 .share-btns'),
      document.querySelector('#mstep-3 .copy-row'), document.querySelector('#mstep-3 .share-preview')]
      .forEach(function (el) { if (el) el.style.display = share ? '' : 'none'; });
```

Then bring `web-tests/e2e/ride-board-share-sheet.spec.js` to Step 1's text (it gained `CONFIRMED_OPEN`, `FULL`, a `LISTS` array the stub serves, and the three-way no-share test). Run that spec alone first: the SH-3 and SH-4 cases fail on `.d-share` count 1 before the `renderDetail` change, and pass after.

- [ ] **Step 7: Stamp, then run the share specs and the board specs again**

```bash
cd "$WT" && npm run stamp
cd "$WT/web-tests" && npx vitest run unit/gtm-event-coverage.test.js && npx playwright test e2e/ride-board-share-sheet.spec.js e2e/ride-board-start-no-card.spec.js e2e/ride-board-share-link.spec.js e2e/ride-board-fomo.spec.js e2e/ride-board-rows.spec.js e2e/ride-board-sheet-actions.spec.js
```

Expected: the vitest guard passes, then every test passed in Playwright's summary line, exit code 0. `ride-board-share-link.spec.js` still finds `/r/EA-7797` in `.d-share a.btn-wa`.

- [ ] **Step 8: Commit**

```bash
git -C "$WT" add board.js board.html web-tests/e2e/ride-board-share-sheet.spec.js web-tests/e2e/ride-board-start-no-card.spec.js web-tests/unit/gtm-event-coverage.test.js
git -C "$WT" status --short
git -C "$WT" commit -m "feat(board): one-tap share from rows, the ride page and the share step

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Momentum line at the top of the list

It renders as the first thing inside `#board-grid`, together with the rows, so it never pushes the page down after load.

**Files:**
- Modify: `board.js` — `render()`; new `momentumHtml()`
- Modify: `board.html` — CSS
- Test: add to `web-tests/e2e/ride-board-fomo.spec.js`

**Interfaces:**
- Consumes: `CHRideFomo.momentum`, `.momentumText` (Task 1); `avatar(m, i, cls)`, `isClosed(L)`, `state.filter`, `state.lists`.

- [ ] **Step 1: Write the failing test** — append to `web-tests/e2e/ride-board-fomo.spec.js`:

```js
test('the board leads with how many travellers are on it — real counts only', async ({ page }) => {
  await open(page);
  const m = page.locator('#board-grid .rw-momentum');
  // FO-1 (2) + FO-2 (1) are open; FO-3 is confirmed. FO-1 closes this week and is one short.
  await expect(m.locator('b')).toHaveText('3 travellers on the board right now');
  await expect(m.locator('small')).toHaveText('1 ride closes this week · 1 needs just one more');
});

test('a route-filtered board skips the line', async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));
  await stubApi(page);
  await page.goto('/board.html?from=Ella&to=Mirissa');
  await expect(page.locator('.rw[data-code="FO-1"]')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#board-grid .rw-momentum')).toHaveCount(0);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd "$WT/web-tests" && npx playwright test e2e/ride-board-fomo.spec.js -g "travellers are on it"`
Expected: FAIL. `.rw-momentum` is not found.

- [ ] **Step 3: Implement** — in `board.js`, directly above `function render() {`, add:

```js
  // "9 travellers on the board right now · 3 rides close this week" — the browse view only: a
  // route-filtered or My-rides board is already about one trip (plan 2026-10-19-ride-board-fomo).
  function momentumHtml() {
    var f = state.filter;
    if (f.mine || f.from !== 'all' || f.to !== 'all') return '';
    var F = window.CHRideFomo, now = Date.now();
    var t = F.momentumText(F.momentum(state.lists, now));
    if (!t) return '';
    var people = [];
    state.lists.forEach(function (L) {
      if (!L.confirmed && !L.cancelled && !isClosed(L, now)) L.members.forEach(function (m) { people.push(m); });
    });
    return '<div class="rw-momentum"><span class="mo-live" aria-hidden="true"></span>' +
      '<span class="rw-faces">' + people.slice(0, 4).map(function (m, i) { return avatar(m, i, 'xs' + (i ? ' stack' : '')); }).join('') + '</span>' +
      '<span class="mo-txt"><b>' + esc(t.head) + '</b>' + (t.sub ? '<small>' + esc(t.sub) + '</small>' : '') + '</span></div>';
  }
```

In `render()`, replace

```js
      grid.innerHTML = groups.map(function (g, i) {
```

with

```js
      grid.innerHTML = momentumHtml() + groups.map(function (g, i) {
```

In `board.html`, after the Task 3 share-sheet CSS, insert:

```css
/* momentum line — the first thing in the list, painted with the rows so nothing jumps */
.rw-momentum{display:flex;align-items:center;gap:12px;padding:16px 24px;border-bottom:1px solid var(--line);background:var(--paper)}
.mo-live{width:8px;height:8px;border-radius:50%;background:var(--btn-cta);flex:none;animation:moLive 1.8s ease-in-out infinite}
@keyframes moLive{0%,100%{opacity:1}50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.mo-live{animation:none}}
.mo-txt{display:flex;flex-direction:column;min-width:0;line-height:1.35}
.mo-txt b{font-size:.92rem}
.mo-txt small{font-size:.78rem;color:var(--ink-soft)}
@media(max-width:640px){.rw-momentum{padding:12px 16px}}
```

- [ ] **Step 4: Stamp and run**

```bash
cd "$WT" && npm run stamp
cd "$WT/web-tests" && npx playwright test e2e/ride-board-fomo.spec.js e2e/ride-board-rows.spec.js e2e/ride-board-load.spec.js e2e/ride-board-scheduled.spec.js
```

Expected: all passed, exit code 0. (`ride-board-rows.spec.js:39`'s `.rw-group:has(.rw) .rw-day-h` selector doesn't match `.rw-momentum`, so it's unaffected.)

- [ ] **Step 5: Full gate, look at it, open PR 1**

```bash
cd "$WT/api" && DATABASE_URL_TEST=postgres://localhost:5432/ceylonhop_test npm run check; echo "api exit $?"
npm --prefix "$WT/web-tests" run test:all; echo "web exit $?"
```

Expected: both exit 0. Quote vitest's `Tests  N passed` and Playwright's `N passed` lines in the PR.

Visual check: start the repo's own static server on the worktree, in the background (`CH_STATIC_PORT=8791 node "$WT/serve-booking.js"`; it serves its own directory). Then `preview_start {url:"http://localhost:8791/board.html"}`. Screenshot it at 375px and 1280px. `preview_start {name}` would serve the main checkout, not the worktree.

```bash
git -C "$WT" add board.js board.html web-tests/e2e/ride-board-fomo.spec.js
git -C "$WT" commit -m "feat(board): momentum line — travellers on the board, rides closing this week

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git -C "$WT" push -u origin feat/board-fomo-rows
git -C "$WT" ls-remote origin refs/heads/feat/board-fomo-rows   # must equal: git -C "$WT" rev-parse HEAD
```

Write `$WT/../pr1-body.md` (outside the repo) with these sections, filled from this run:
- **What:** FOMO rows, one-tap share, momentum line (plan link).
- **Why:** owner goal = names added.
- **Red→green:** each task's failing command plus its first failure line, then the passing summary line.
- **Gate:** `npm run check` and `test:all` summary lines with exit codes.
- **Screenshots:** 375px and 1280px.
- **Owner decisions:** the 3 from this plan's top.
- **Not done:** GTM tags.
- End with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

```bash
cd /private/tmp && gh pr create --repo ceylonhop/ceylon-hop --base main --head feat/board-fomo-rows \
  --title "feat(board): FOMO rows + one-tap share (plan 2026-10-19)" --body-file "$WT/../pr1-body.md"
```

Merging to `main` ships to **staging** only. Promote to prod is a separate, owner-approved `main → production` PR.

---

## PR 1 — post-review fixes (2026-10-21)

- **F1 — one private-car figure:** the ride page's `.vs-strip` now prints `CHRideFomo.privateCarFare` (the catalogue's) instead of the hand-kept `ALT.priv`, which disagreed with the row ($78 vs $75 for Ella → Mirissa); `ALT` keeps only the bus time.
- **F2 — no dangling "You're on it ·":** the separator moved from the text into a `.rw-you + .rw-close::before` rule, so phones (which hide the closing line) no longer show a trailing dot on your own rows.
- **F3 — the board survives without `ride-fomo.js`:** one guarded `var F = window.CHRideFomo || { … }` fallback replaces four unguarded reads; rows fall back to `rowState`'s wording, the momentum line stays off, and a share sends the link alone.
- **F4 — tests for the share step:** the start flow's native share sends the first-person text, and the join that filled the last seat offers no share (native button, share buttons, copy row all hidden).
- **F5 — no row share button on phones:** hidden under 640px, where the "2 seats to go" pill has no room beside it; the ride page (whole-row tap) keeps "Share…" and WhatsApp. The pill test measures the visible Join button, not the `.rw-acts` box (which is as wide as the price column above it).
- **F6 — short closing line at every width:** rows say "Closes in 9h 12m" / "Closes 12 Aug" in both copies, because the full "Names close in 9h 09m" clipped under the pill at 1280px; the share text keeps "Names close …".
- **F7 — stale comment:** the one above `.d-share` now says it is hidden for any ride a friend can no longer join (`canShare`), not only closed ones.
- **F8 — `shareRide` re-checks at click time:** `if (!L || !canShare(L)) return;`, so a row left open past its cutoff cannot share a dead ride.

# PR 2 — Home "Travel with others?" (`feat/home-ride-strip`)

**Start only after PR 1 is merged** (it needs `ride-fomo.js`). Design: the revised home section on the prototype, screens **C1 → C2** (2026-10-21). Owner's calls, fixed here:

- **A card opens the whole board, landed on that ride** (`board.html?hl=CODE`), with that ride tinted. Not the ride's sheet (`?r=`), not a route filter.
- **"Shared taxi" is said four ways**: the eyebrow, the lead line, a label on every card, and "a seat" pricing.
- **Compared with the bus, never our own private car.** That's the July spec's positioning rule, and this page sells the private car.
- **Calm.** No red "LIVE" eyebrow, no pulse, minutes never seconds.
- **Cards stacked, one per row on phones**, two columns from 720px. The route leads. No buttons and no share inside a card (sharing is one tap away on the board). At most 4.
- **One way out besides the cards:** "See every shared taxi on the board, or start your own →".
- **The landing tint is saffron, not teal.** On the real board a teal wash with a teal bar already means "you're on this ride" (`.rw.mine`), so the prototype's teal highlight would read as that.

**Pre-flight reconciliation (2026-10-22, before Task 5):** three plan lines had gone stale against `origin/main` after PR 1's fix commits — Task 5 (b) would have dropped F6's `opts.short` (merged: both options), Task 5's expected count is 26 not 25 (F6 added a test), and Task 7's `$27.49 a seat` expectation needs HR-1 priced at 2749 minor units (the fixture's default 2800 said `$28`). `select_item` is NOT deliberately untagged: it is already a planned funnel event (`tools/analytics/build-gtm-funnel-tags.mjs`), emitted by board.js, plan.js, search.js and quote.html, so the home strip's call site joins an event that already has a tag; Decision 2's "GTM has no tag" holds only for `share`.

Worktree (after PR 1 merges):

```bash
cd /Users/roshenw/claude_code/ceylon-hop && git fetch origin
WT2=/private/tmp/claude-501/-Users-roshenw-claude-code-ceylon-hop/d3ddb2ac-2f8d-4ce0-9909-94fc61c94335/scratchpad/wt-home-rides
git worktree add -b feat/home-ride-strip "$WT2" origin/main
ln -s /Users/roshenw/claude_code/ceylon-hop/web-tests/node_modules "$WT2/web-tests/node_modules"
ln -s /Users/roshenw/claude_code/ceylon-hop/api/node_modules "$WT2/api/node_modules"
test -f "$WT2/ride-fomo.js" && echo "ride-fomo.js present"
```

### Task 5: `stripRides`, `busTime`, and a minutes-only clock

**Files:**
- Modify: `ride-fomo.js`
- Test: `web-tests/unit/ride-fomo.test.js`

**Interfaces:**
- Produces: `CHRideFomo.stripRides(lists, nowMs, max) → list[]` (`lists` are normalized: `code, minSeats, committed, confirmed, cancelled, cutoffMs`).
- `CHRideFomo.busTime(corridorId) → string | null`, e.g. `'6h by bus'`.
- `CHRideFomo.closesText(cutoffMs, nowMs, opts?)` gains `opts.minutes: true` — inside the last hour it says `12m`, never `12m 05s`; under a minute, `under a minute`.

- [ ] **Step 1: Write the failing tests** — append to `web-tests/unit/ride-fomo.test.js`:

```js
describe('stripRides', () => {
  const ride = (o) => ({ minSeats: 3, committed: 1, confirmed: false, cancelled: false, cutoffMs: NOW + 5 * 24 * H, ...o });
  it('keeps open rides that need people — fewest seats to go first, then soonest to close', () => {
    const out = F.stripRides([
      ride({ code: 'A', committed: 1, cutoffMs: NOW + 2 * H }),
      ride({ code: 'B', committed: 2, cutoffMs: NOW + 9 * 24 * H }),
      ride({ code: 'C', committed: 2, cutoffMs: NOW + 3 * 24 * H }),
      ride({ code: 'D', committed: 3 }),               // has its minimum
      ride({ code: 'E', confirmed: true }),
      ride({ code: 'F', cutoffMs: NOW - 1 }),          // names closed
    ], NOW, 6);
    expect(out.map((r) => r.code)).toEqual(['C', 'B', 'A']);
  });
  it('stops at the limit', () => {
    const many = Array.from({ length: 9 }, (_, i) => ride({ code: 'R' + i }));
    expect(F.stripRides(many, NOW, 4)).toHaveLength(4);
  });
});

describe('busTime — the bus a seat beats, never our own private car', () => {
  it("names the corridor's bus time", () => {
    expect(F.busTime('airport-cultural')).toBe('6h by bus');
    expect(F.busTime('hill-line')).toBe('7h by bus and train');
  });
  it('says nothing for a corridor it does not know', () => {
    expect(F.busTime('south-airport')).toBeNull();
    expect(F.busTime(null)).toBeNull();
  });
});

describe('closesText with minutes only — no second hand on the home page', () => {
  it('drops the seconds inside the last hour, and keeps the rest as it was', () => {
    expect(F.closesText(NOW + 12 * 60000 + 5000, NOW, { minutes: true }).text).toBe('Names close in 12m');
    expect(F.closesText(NOW + 30000, NOW, { minutes: true }).text).toBe('Names close in under a minute');
    expect(F.closesText(NOW + 9 * H + 12 * 60000, NOW, { minutes: true }).text).toBe('Names close in 9h 12m');
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd "$WT2/web-tests" && npx vitest run unit/ride-fomo.test.js`
Expected: FAIL. `TypeError: F.stripRides is not a function` (and `F.busTime`); the minutes case gets `12m 05s`.

- [ ] **Step 3: Implement** — in `ride-fomo.js`:

(a) Replace the `countdown` function with:

```js
  // Remaining milliseconds → "2d 3h" / "9h 12m" / "12m 05s" — or, with `minutes`, "12m" and
  // "under a minute": the home page never shows a second hand. Clamps at zero.
  function countdown(ms, minutes) {
    var s = Math.max(0, Math.floor(Number(ms) || 0));
    var h = Math.floor(s / HOUR), m = Math.floor((s % HOUR) / 60000), sec = Math.floor((s % 60000) / 1000);
    if (h >= 24) return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
    if (h >= 1) return h + 'h ' + pad(m) + 'm';
    if (minutes) return m >= 1 ? m + 'm' : 'under a minute';
    return m + 'm ' + pad(sec) + 's';
  }
```

(b) Replace the `closesText` function with (PR 1's F6 added `opts.short`; keep it, and add `opts.minutes` beside it — reconciled 2026-10-22):

```js
  // When names close: a running clock inside three days (red inside one), a Sri Lanka date
  // further out. null with no cutoff to go on. `opts.short` is the phone's time-line form —
  // "Closes 12 Aug" — where the full line does not fit beside the price. `opts.minutes` drops
  // the seconds (the home page never shows a second hand).
  function closesText(cutoffMs, nowMs, opts) {
    if (!isFinite(cutoffMs)) return null;
    var short = !!(opts && opts.short), minutes = !!(opts && opts.minutes);
    var lead = short ? 'Closes' : 'Names close';
    var left = cutoffMs - nowMs;
    if (left <= 0) return { text: short ? 'Closed' : 'Names closed', live: false, urgent: false };
    if (left < LIVE_MS) return { text: lead + ' in ' + countdown(left, minutes), live: true, urgent: left < URGENT_MS };
    return { text: lead + ' ' + colomboDay(cutoffMs, short), live: false, urgent: false };
  }
```

(c) Above `window.CHRideFomo = {`, add:

```js
  // The bus the seat beats — board.js's ALT table, said in words. The comparison the July spec
  // asks for: against the bus, never our own private car. A corridor not listed says nothing.
  var BUS = {
    'airport-cultural': '6h by bus', 'hill-line': '7h by bus and train', 'ella-east': '6h by bus',
    'south-coast': '2.5h by bus', 'yala-south': '5h by bus', 'ella-south': '7h by bus'
  };
  function busTime(corridorId) { return (corridorId && BUS[corridorId]) || null; }

  // The home page's "Travel with others?": open rides that still need people, the closest to
  // running first (fewest seats to go), then the soonest to close.
  function stripRides(lists, nowMs, max) {
    return (lists || []).filter(function (L) {
      return L && !L.confirmed && !L.cancelled && seatsToGo(L) && !(isFinite(L.cutoffMs) && L.cutoffMs <= nowMs);
    }).sort(function (a, b) {
      return seatsToGo(a).need - seatsToGo(b).need ||
        (isFinite(a.cutoffMs) ? a.cutoffMs : Infinity) - (isFinite(b.cutoffMs) ? b.cutoffMs : Infinity);
    }).slice(0, max || 4);
  }
```

(d) Add `busTime: busTime,` and `stripRides: stripRides` to the `window.CHRideFomo` object (after `momentumText: momentumText,`).

- [ ] **Step 4: Run them to make sure they pass**

Run: `cd "$WT2/web-tests" && npx vitest run unit/ride-fomo.test.js`
Expected: PASS, `Tests  26 passed (26)` — PR 1's 21 still green (`closesText` without `opts.minutes` is unchanged, including the `short` form).

- [ ] **Step 5: Commit** (`ride-fomo.js` changed, so stamp first: `board.html`'s `?v=` moves)

```bash
cd "$WT2" && npm run stamp
git -C "$WT2" add ride-fomo.js web-tests/unit/ride-fomo.test.js board.html
git -C "$WT2" commit -m "feat(home): stripRides, busTime and a minutes-only clock for the home strip

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The board lands on `?hl=CODE`

The home card's target. The board tints that ride and brings it into view once — no sheet, no filter, nothing else changes. `?hl=` is a new query key: it never matches the Cloudflare Worker's `board.html?r=` route (so GitHub Pages serves it), and `openFromUrl` reads only `r` and the hash.

**Files:**
- Modify: `board.js` — above `function render() {` (~line 852, right after `var grid = …`), the `<article` line in `rowHtml()` (PR 1's version), the end of `render()`
- Modify: `board.html` — CSS after `.rw.mine{…}` (~line 154)
- Modify: `ride-fomo.js` (export `countdown`), `web-tests/unit/ride-board.test.js` and any other unit file that calls `RideBoard.fmtCountdown` or `RideBoard.cdText` (`grep -l "fmtCountdown\|cdText" web-tests/unit/*.test.js`)
- Test: `web-tests/e2e/ride-board-landing.spec.js` (new)

**Interfaces:**
- Produces: `board.html?hl=CODE` → `.rw.hl` on that row, scrolled into view once.

- [ ] **Step 1: Write the failing test** — create `web-tests/e2e/ride-board-landing.spec.js`:

```js
import { test, expect } from '@playwright/test';
import { isApiRequest } from './_api-host.js';

// Landing on one ride from the home page (plan 2026-10-19-ride-board-fomo, PR 2): ?hl=CODE
// tints that ride and brings it into view. No sheet opens, no filter is set.
const member = (n, c) => ({ firstName: n, country: c, photoUrl: null });
const ride = (code, date) => ({ code, corridorId: 'hill-line', from: 'Kandy', to: 'Ella', date, slot: 'morning', minSeats: 3, capacity: 6,
  seatPrice: 2100, status: 'gathering', note: null, lockedTime: null, cutoffAt: '2099-12-20T01:30:00.000Z', committed: 1, members: [member('Sam', 'CA')] });
// Eight rides on eight days, so the last one sits well below the first screen on a phone.
const LISTS = Array.from({ length: 8 }, (_, i) => ride('HL-' + (i + 1), '2099-12-' + String(22 + i).padStart(2, '0')));

async function stubApi(page) {
  await page.route((u) => isApiRequest(u), (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/board') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ lists: LISTS }) });
    if (p === '/board/me') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ me: null }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

test.use({ viewport: { width: 375, height: 812 } });

test('?hl=CODE tints that ride and scrolls it into view, without opening its sheet', async ({ page }) => {
  await stubApi(page);
  await page.goto('/board.html?hl=HL-8');
  const row = page.locator('.rw[data-code="HL-8"]');
  await expect(row).toHaveClass(/\bhl\b/, { timeout: 15000 });
  await expect(page.locator('.rw[data-code="HL-1"]')).not.toHaveClass(/\bhl\b/);
  await expect(page.locator('body')).not.toHaveClass(/detail-open/);
  const box = await row.boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(812);
});

test('an unknown code is harmless', async ({ page }) => {
  await stubApi(page);
  await page.goto('/board.html?hl=NOPE-1');
  await expect(page.locator('.rw[data-code="HL-1"]')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.rw.hl')).toHaveCount(0);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd "$WT2/web-tests" && npx playwright test e2e/ride-board-landing.spec.js`
Expected: FAIL. `toHaveClass(/\bhl\b/)` — received class `rw`.

- [ ] **Step 3: Implement**

`board.js`, directly above `function render() {` (after `var filtersEl = …;`), add:

```js
  // Landed here from the home page's "Travel with others?" (?hl=CODE, plan 2026-10-19-ride-board-fomo
  // PR 2): that ride is tinted on every paint and brought into view ONCE — a later re-render (My
  // rides, the seat counts) keeps the tint but must not yank the page again. Instant, not smooth: a
  // smooth scroll towards a row the next render replaces lands on the wrong spot.
  var HL_CODE = (function () { try { return new URLSearchParams(location.search).get('hl') || ''; } catch (e) { return ''; } })();
  var landed = false;
  function landOnRide() {
    if (!HL_CODE || landed) return;
    var row = grid.querySelector('.rw[data-code="' + HL_CODE + '"]');
    if (!row) return;
    landed = true;
    row.scrollIntoView({ block: 'center' });
  }
```

In `rowHtml()` (PR 1's version), replace

```js
    return '<article class="rw' + (mine ? ' mine' : '') + '" data-code="' + esc(L.code) + '" tabindex="0"' +
```

with

```js
    return '<article class="rw' + (mine ? ' mine' : '') + (L.code === HL_CODE ? ' hl' : '') + '" data-code="' + esc(L.code) + '" tabindex="0"' +
```

At the end of `render()`, replace

```js
    observe();
    playSeatFills();
  }
```

with

```js
    observe();
    playSeatFills();
    landOnRide();
  }
```

**One clock, not two** (Task 1's reviewer: `countdown` in `ride-fomo.js` duplicates `fmtCountdown` at `board.js:77-83`; owner 2026-10-21: accept in PR 1, unify here). In `ride-fomo.js` add `countdown: countdown,` to the `window.CHRideFomo` object. In `board.js` replace the whole body of `fmtCountdown` so it reads:

```js
  function fmtCountdown(ms) { return window.CHRideFomo.countdown(ms); }
```

(keep its comment; `ride-fomo.js` is loaded before `board.js` on the page since PR 1). The board's unit tests run `board.js` alone through `new Function(src)()`, so every unit file that calls `RideBoard.fmtCountdown` or `RideBoard.cdText` must load `ride-fomo.js` first: in its `beforeAll`, directly above the line that loads `board.js`, add the same `new Function(readFileSync(...))()` line for `ride-fomo.js`. Run `cd "$WT2/web-tests" && npx vitest run` to prove nothing else breaks.

`board.html`, after `.rw.mine{background:var(--pc-teal);box-shadow:inset 3px 0 0 var(--teal)}`, add:

```css
/* the ride a home-page card pointed at (?hl=CODE, PR 2): saffron, because teal already means "you're on it" */
.rw.hl{background:var(--pc-saffron);box-shadow:inset 3px 0 0 var(--saffron)}
```

- [ ] **Step 4: Stamp and run**

```bash
cd "$WT2" && npm run stamp
cd "$WT2/web-tests" && npx playwright test e2e/ride-board-landing.spec.js e2e/ride-board-rows.spec.js e2e/ride-board-share-link.spec.js e2e/ride-board-closed-ride.spec.js
```

Expected: all passed, exit code 0 (`share-link.spec.js` still finds `?r=` handling untouched).

- [ ] **Step 5: Commit**

```bash
git -C "$WT2" add board.js board.html web-tests/e2e/ride-board-landing.spec.js
git -C "$WT2" status --short
git -C "$WT2" commit -m "feat(board): ?hl=CODE lands on one ride — tinted, scrolled into view, no sheet

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: The home strip

**Files:**
- Create: `home-rides.js`
- Modify: `index.html` — section after the TRUST strip, inline unhide script, `hr-` CSS before `</style>`, two script tags after `transfers-data.js`
- Test: `web-tests/e2e/home-ride-strip.spec.js` (new)

**Interfaces:**
- Consumes: `CHRideFomo.seatsToGo`, `.closesText(…, { minutes: true })`, `.busTime`, `.stripRides` (Task 5); `board.html?hl=CODE` (Task 6); `window.CEYLON_HOP_API`; `window.chTrack`.

- [ ] **Step 1: Write the failing test** — create `web-tests/e2e/home-ride-strip.spec.js`:

```js
import { test, expect } from '@playwright/test';
import { blockLiveApi } from './_stubs.js';

// "Travel with others?" on the home page (plan 2026-10-19-ride-board-fomo, PR 2, design revised
// 2026-10-21): open shared-taxi rides that still need people, stacked, each one a link to the
// board landed on that ride. Says "shared taxi"; compares with the bus, never a private car.
const NOW = '2099-08-10T00:00:00.000Z';
const ride = (o) => ({ corridorId: 'ella-south', from: 'Ella', to: 'Mirissa', date: '2099-08-14', slot: 'morning', minSeats: 3, capacity: 6,
  seatPrice: 2800, status: 'gathering', note: null, lockedTime: null, cutoffAt: '2099-08-12T01:30:00.000Z', committed: 1,
  members: [{ firstName: 'Sam', country: 'CA', photoUrl: null }], ...o });
const LISTS = [
  ride({ code: 'HR-2' }),
  ride({ code: 'HR-1', corridorId: 'airport-cultural', from: 'Colombo Airport (CMB)', to: 'Sigiriya / Dambulla', committed: 2,
    seatPrice: 2749, cutoffAt: '2099-08-10T09:12:00.000Z',
    members: [{ firstName: 'Tom', country: 'GB', photoUrl: null }, { firstName: 'Lea', country: 'FR', photoUrl: null }] }),
  ride({ code: 'HR-5', date: '2099-08-12', cutoffAt: '2099-08-10T00:12:05.000Z' }), // closes in 12m 05s
  ride({ code: 'HR-3', status: 'confirmed', committed: 3 }),
  ride({ code: 'HR-4', cutoffAt: '2099-08-09T00:00:00.000Z' }),
];

async function stubBoard(page, body, status = 200) {
  await page.route(/\/board(\?|$)/, (r) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }));
}

test.beforeEach(async ({ page }) => {
  await blockLiveApi(page);
  await page.clock.setFixedTime(new Date(NOW));
});

test('shows the open rides that need people, closest to running first, each a link to the board landed on it', async ({ page }) => {
  await stubBoard(page, { lists: LISTS });
  await page.goto('/index.html');
  await expect(page.locator('#hr-title')).toHaveText('Travel with others?');
  const cards = page.locator('#home-rides .hr-card:not(.hr-sk)');
  await expect(cards).toHaveCount(3);
  const first = cards.first();
  await expect(first.locator('.hr-route')).toContainText('Colombo Airport');
  await expect(first.locator('.hr-togo')).toHaveText('1 seat to go');
  await expect(first.locator('.hr-kind')).toContainText('Shared taxi');
  await expect(first.locator('.hr-close')).toHaveText('Names close in 9h 12m');
  await expect(first).toHaveAttribute('href', 'board.html?hl=HR-1');
  await expect(first.locator('.hr-price')).toHaveText(/^\$27\.49 a seat · or 6h by bus$/);
  // the second closes in 12m 05s — the home page says minutes, never seconds
  await expect(cards.nth(1).locator('.hr-close')).toHaveText('Names close in 12m');
});

test('never compares with our own private car, and keeps no button or link inside a card', async ({ page }) => {
  await stubBoard(page, { lists: LISTS });
  await page.goto('/index.html');
  await expect(page.locator('#home-rides .hr-card:not(.hr-sk)')).toHaveCount(3);
  await expect(page.locator('#home-rides')).not.toContainText('private car');
  await expect(page.locator('#home-rides .hr-card button')).toHaveCount(0);
  await expect(page.locator('#home-rides .hr-card a')).toHaveCount(0);
});

test('stays hidden when the board has nothing open', async ({ page }) => {
  await stubBoard(page, { lists: [LISTS[3], LISTS[4]] });
  await page.goto('/index.html');
  await expect(page.locator('#home-rides')).toBeHidden();
});

test('stays hidden when the board cannot be reached', async ({ page }) => {
  await stubBoard(page, { error: 'down' }, 500);
  await page.goto('/index.html');
  await expect(page.locator('#home-rides')).toBeHidden();
});

test('on a phone the cards stack, and the page never scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await stubBoard(page, { lists: LISTS });
  await page.goto('/index.html');
  const cards = page.locator('#home-rides .hr-card:not(.hr-sk)');
  await expect(cards).toHaveCount(3);
  const a = await cards.nth(0).boundingBox();
  const b = await cards.nth(1).boundingBox();
  expect(Math.round(b.x)).toBe(Math.round(a.x));
  expect(b.y).toBeGreaterThan(a.y + a.height - 1);
  const over = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(over).toBe(false);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd "$WT2/web-tests" && npx playwright test e2e/home-ride-strip.spec.js`
Expected: FAIL. `#hr-title` is not found.

- [ ] **Step 3: Markup** — in `index.html`, between the TRUST section's closing `</section>` and `<!-- WHAT IS -->`, insert:

```html
<!-- TRAVEL WITH OTHERS? (plan 2026-10-19-ride-board-fomo, PR 2) — filled by home-rides.js from GET /board.
     Starts hidden for no-JS / api=off; the inline script below shows it BEFORE first paint, with
     two same-height skeleton cards, so filling it never moves the page. -->
<section class="hr-sec" id="home-rides" aria-labelledby="hr-title" hidden>
  <div class="wrap">
    <span class="eyebrow">Shared taxi &middot; The ride board</span>
    <h2 class="hr-title" id="hr-title">Travel with others?</h2>
    <p class="hr-lead">Share a taxi with travellers going soon &mdash; add your name, split the fare. You pay nothing unless it runs.</p>
    <div class="hr-list" id="hr-list" aria-busy="true"><div class="hr-card hr-sk"></div><div class="hr-card hr-sk"></div></div>
    <p class="hr-foot"><a href="board.html">See every shared taxi on the board, or start your own &rarr;</a></p>
  </div>
</section>
<script>if(window.CEYLON_HOP_API)document.getElementById('home-rides').hidden=false;</script>
```

(`.eyebrow` is the home page's own eyebrow class — the "What is Ceylon Hop?" section uses it.)

After `<script src="transfers-data.js?v=095fe1f9cc"></script>`, add:

```html
<script src="ride-fomo.js"></script>
<script src="home-rides.js"></script>
```

Immediately before the `</style>` that closes the head `<style>` block (~line 538), insert:

```css
/* ---------- travel with others? (plan 2026-10-19-ride-board-fomo, PR 2) ----------
   Real open shared-taxi rides from the ride board, stacked. Page-local hr- names: a bare class
   here collides with the shared chrome (#983). Cards keep a minimum height and the section ships
   two same-height skeletons, so filling it never moves the page. */
.hr-sec{padding:34px 0 30px}
.hr-title{margin:6px 0 0;font-size:clamp(1.45rem,2.6vw,2rem)}
.hr-lead{margin:8px 0 0;max-width:52ch;color:var(--ink-soft);font-size:.95rem;line-height:1.5}
.hr-list{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;margin-top:16px}
@media(min-width:720px){.hr-list{grid-template-columns:repeat(2,minmax(0,1fr))}}
.hr-card{display:flex;flex-direction:column;gap:10px;min-height:142px;box-sizing:border-box;padding:14px;background:var(--paper);
  border:1px solid var(--line);border-radius:16px;text-decoration:none;color:var(--ink)}
.hr-card:hover{background:var(--pc-sky)}
.hr-sk{height:142px;background:linear-gradient(90deg,var(--cream) 0%,var(--paper) 50%,var(--cream) 100%);background-size:200% 100%;animation:hrSk 1.4s linear infinite}
@keyframes hrSk{to{background-position:-200% 0}}
@media (prefers-reduced-motion:reduce){.hr-sk{animation:none}}
.hr-top{display:flex;align-items:center;justify-content:space-between;gap:10px}
.hr-route{margin:0;font-size:1.15rem;line-height:1.15;min-width:0}
.hr-arr{font-family:var(--body);font-weight:600;color:var(--accent-deep)}
.hr-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.hr-togo{flex:none;display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:999px;background:var(--pc-saffron);color:#7a4f00;font-size:.76rem;font-weight:800;white-space:nowrap}
.hr-togo::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--saffron)}
.hr-togo.hot{background:#fde4e0;color:#B01E0B}
.hr-togo.hot::before{background:var(--tomato)}
.hr-who{display:flex;align-items:center;gap:12px}
.hr-faces{display:flex;flex:none}
.hr-face{position:relative;width:32px;height:32px;border-radius:50%;border:2px solid var(--paper);display:grid;place-items:center;font-size:.66rem;font-weight:800;color:#fff}
.hr-face+.hr-face{margin-left:-8px}
.hr-face img{position:absolute;inset:0;width:100%;height:100%;border-radius:50%;object-fit:cover}
.hr-flag{position:absolute;right:-4px;bottom:-3px;font-size:.66rem}
.hr-open{background:var(--paper);border:1.5px dashed #b9b3a3;color:#8f897a}
.hr-meta{display:flex;flex-direction:column;gap:2px;min-width:0;line-height:1.35}
.hr-kind{font-size:.82rem;font-weight:600}
.hr-kind b{color:var(--teal-deep)}
.hr-close{font-size:.76rem;color:var(--ink-soft);font-variant-numeric:tabular-nums}
.hr-close.urgent{color:#C82511;font-weight:700}
.hr-foot-row{margin-top:auto;display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:10px;border-top:1px dashed var(--line)}
.hr-price{font-size:.82rem;color:var(--ink-soft)}
.hr-price b{font-family:var(--display);font-size:1.05rem;color:var(--ink)}
.hr-go{font-size:.82rem;font-weight:700;color:var(--accent-deep);white-space:nowrap}
.hr-foot{margin:14px 0 0;font-weight:700;font-size:.92rem}
```

- [ ] **Step 4: Implement** — create `home-rides.js` at the repo root:

```js
/* home-rides.js — "Travel with others?" on the home page (plan
   docs/superpowers/plans/2026-10-19-ride-board-fomo.md, PR 2; design revised 2026-10-21). The
   open shared-taxi rides that still need people, stacked: who's going, seats to go, when names
   close, and the bus the seat beats. Each card is ONE link to the board, landed on that ride
   (board.html?hl=CODE). Data: GET /board (public). Words and urgency: ride-fomo.js, the helper
   the board rows use, so the two pages never disagree. The section is shown before first paint
   by an inline script and hidden again only when there is nothing real to show.

   Says "shared taxi" on every card, and compares with the bus — never with our own private car,
   which this page sells (spec 2026-07-23, "Positioning"). */
(function () {
  var sec = document.getElementById('home-rides');
  var list = document.getElementById('hr-list');
  var F = window.CHRideFomo;
  var API = String(window.CEYLON_HOP_API || '').replace(/\/$/, '');
  if (!sec || !list) return;
  if (!F || !API) { sec.hidden = true; return; }

  var MAX = 4;
  var SLOT = { morning: '7–9 am', afternoon: '1–3 pm' };
  var AV = ['#0AB9B6', '#63BFD6', '#F9A429', '#8f7ad6', '#4aa66a', '#d66a9c', '#e0745f']; // board.js's avatar colours
  var MINUTES = { minutes: true }; // never a second hand on the home page

  function track(n, p) { try { if (window.chTrack) window.chTrack(n, p || {}); } catch (e) {} }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) { n = Number(n) || 0; return '$' + (Number.isInteger(n) ? String(n) : n.toFixed(2)); }
  function flagOf(c) {
    c = String(c || '').trim();
    if (!/^[A-Za-z]{2}$/.test(c)) return c;
    var up = c.toUpperCase();
    return String.fromCodePoint(0x1F1E6 + up.charCodeAt(0) - 65, 0x1F1E6 + up.charCodeAt(1) - 65);
  }
  // "Colombo Airport (CMB)" → "Colombo Airport", "Sigiriya / Dambulla" → "Sigiriya"
  function mainName(n) { return String(n || '').split(/\s*[(\/]/)[0].trim(); }
  function day(iso) {
    return /^\d{4}-\d{2}-\d{2}$/.test(iso || '')
      ? new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
      : '';
  }
  function fromWire(pl) {
    return {
      code: pl.code, corridorId: pl.corridorId || null, from: pl.from || '', to: pl.to || '', date: pl.date, slot: pl.slot || 'morning',
      minSeats: pl.minSeats != null ? pl.minSeats : 3, capacity: pl.capacity != null ? pl.capacity : 6,
      committed: pl.committed != null ? pl.committed : (pl.members || []).length,
      confirmed: pl.status === 'confirmed', cancelled: pl.status === 'cancelled' || pl.status === 'expired',
      cutoffMs: pl.cutoffAt ? Date.parse(pl.cutoffAt) : NaN,
      cost: (Number(pl.seatPrice) || 0) / 100,
      members: (pl.members || []).map(function (m) { return { name: m.firstName || '', flag: flagOf(m.country), photoUrl: m.photoUrl || null }; })
    };
  }
  function face(m, i) {
    return '<span class="hr-face" style="background:' + AV[i % AV.length] + '">' + esc((m.name || '·').slice(0, 2).toUpperCase()) +
      (m.photoUrl ? '<img src="' + esc(m.photoUrl) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">' : '') +
      (m.flag ? '<span class="hr-flag">' + m.flag + '</span>' : '') + '</span>';
  }
  function card(L, now) {
    var togo = F.seatsToGo(L), closes = F.closesText(L.cutoffMs, now, MINUTES), bus = F.busTime(L.corridorId);
    var faces = L.members.slice(0, 4).map(face).join('');
    for (var k = 0; k < Math.min(togo.need, 3); k++) faces += '<span class="hr-face hr-open" aria-hidden="true">+</span>';
    return '<a class="hr-card" href="board.html?hl=' + encodeURIComponent(L.code) + '" data-ride="' + esc(L.code) + '">' +
      '<div class="hr-top"><h3 class="hr-route">' + esc(mainName(L.from)) + ' <span class="hr-arr" aria-hidden="true">→</span><span class="hr-sr"> to </span> ' + esc(mainName(L.to)) + '</h3>' +
        '<span class="hr-togo' + (togo.hot ? ' hot' : '') + '">' + esc(togo.text) + '</span></div>' +
      '<div class="hr-who"><span class="hr-faces">' + faces + '</span><span class="hr-meta">' +
        '<span class="hr-kind"><b>Shared taxi</b> · ' + esc(day(L.date)) + ' · ' + esc(SLOT[L.slot] || SLOT.morning) + '</span>' +
        (closes ? '<span class="hr-close' + (closes.urgent ? ' urgent' : '') + '" data-close="' + L.cutoffMs + '">' + esc(closes.text) + '</span>' : '') +
      '</span></div>' +
      '<div class="hr-foot-row"><span class="hr-price"><b>' + money(L.cost) + '</b> a seat' + (bus ? ' · or ' + esc(bus) : '') + '</span>' +
        '<span class="hr-go">See it on the board ›</span></div>' +
      '</a>';
  }
  function render(lists) {
    var now = Date.now();
    var rides = F.stripRides(lists.map(fromWire), now, MAX);
    if (!rides.length) { sec.hidden = true; return; }
    list.removeAttribute('aria-busy');
    list.innerHTML = rides.map(function (L) { return card(L, now); }).join('');
    list.querySelectorAll('[data-ride]').forEach(function (a) {
      a.addEventListener('click', function () {
        track('select_item', { item_list_id: 'home_rides', item_list_name: 'Home: travel with others', item_id: a.getAttribute('data-ride') });
      });
    });
  }

  fetch(API + '/board', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) { if (!d || !Array.isArray(d.lists)) { sec.hidden = true; return; } render(d.lists); })
    .catch(function () { sec.hidden = true; });

  // Minutes only, so once a minute is plenty.
  setInterval(function () {
    var now = Date.now();
    list.querySelectorAll('[data-close]').forEach(function (el) {
      var c = F.closesText(+el.getAttribute('data-close'), now, MINUTES);
      if (!c) return;
      if (el.textContent !== c.text) el.textContent = c.text;
      el.classList.toggle('urgent', c.urgent);
    });
  }, 30000);
})();
```

- [ ] **Step 5: Stamp and run the home specs**

```bash
cd "$WT2" && npm run stamp
cd "$WT2/web-tests" && npx playwright test e2e/home-ride-strip.spec.js e2e/home-search-no-js.spec.js e2e/home-tour-cards.spec.js e2e/home-blog-links.spec.js e2e/home-review-source.spec.js
```

Expected: all passed, exit code 0. The other home specs don't stub `/board`, so the strip hides on their 404 and they're unaffected. If one fails on a layout measurement, the strip is shifting content: check the skeleton height (142px) against a real card's.

- [ ] **Step 6: Full gate, look at it, open PR 2**

```bash
cd "$WT2/api" && DATABASE_URL_TEST=postgres://localhost:5432/ceylonhop_test npm run check; echo "api exit $?"
npm --prefix "$WT2/web-tests" run test:all; echo "web exit $?"
```

Visual check at 375px and 1280px, served from `$WT2` as in Task 4: the home strip, then tap a card and confirm the board lands on the saffron-tinted ride. Then:

```bash
git -C "$WT2" add home-rides.js index.html web-tests/e2e/home-ride-strip.spec.js
git -C "$WT2" status --short
git -C "$WT2" commit -m "feat(home): Travel with others? — open shared taxis, each a link to the board landed on that ride

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git -C "$WT2" push -u origin feat/home-ride-strip
git -C "$WT2" ls-remote origin refs/heads/feat/home-ride-strip   # must equal: git -C "$WT2" rev-parse HEAD
```

Write `$WT2/../pr2-body.md` with the same sections as PR 1's body (What, Why, the seven design calls above, Red→green for Tasks 5–7, Gate, Screenshots at 375px and 1280px, Not done: GTM `select_item` tag), ending with the 🤖 line.

```bash
cd /private/tmp && gh pr create --repo ceylonhop/ceylon-hop --base main --head feat/home-ride-strip \
  --title "feat(home): Travel with others? strip (plan 2026-10-19, PR 2)" --body-file "$WT2/../pr2-body.md"
```

---

# PR 3 — "N booked" on scheduled taxis (`feat/board-scheduled-booked`)

**Start only after PR 1 is merged** (it needs `ride-fomo.js`). Doesn't depend on PR 2. Approved on the prototype 2026-10-19 (screen 2, scheduled rows).

**Design calls, fixed here:**
- **Paid seats only.** A scheduled seat is held the moment checkout starts, before payment (`api/src/routes/bookings.ts:878`). Unpaid holds are released only after 24 h (`api/src/services/scheduler.ts` `sweepStaleSharedHolds`). So `shared_departure.seats_booked` counts abandoned checkouts. The count reads paid shared bookings: statuses `paid`, `confirmed`, `in_progress`, `completed`.
- **Per van, not per leg.** CMB 07:00 and Negombo 07:30 ride one van. Both rows show the van's total, using the same pooling the inventory uses (`departureKeyFor`).
- **A count, never who.** No names, flags or contact details leave the API. Those customers bought a seat; they didn't agree to be shown.
- **From 2 up.** The board shows nothing for 0 or 1.
- **No "seats left".** `seat_capacity` is a hard-coded 12 even when the run goes out as a car.
- **Safe in either deploy order.** If board.js ships before the API, `GET /board/scheduled-seats` hits `/:code` and fails quietly; rows look as they do today.

Worktree:

```bash
cd /Users/roshenw/claude_code/ceylon-hop && git fetch origin
WT3=/private/tmp/claude-501/-Users-roshenw-claude-code-ceylon-hop/d3ddb2ac-2f8d-4ce0-9909-94fc61c94335/scratchpad/wt-sched-booked
git worktree add -b feat/board-scheduled-booked "$WT3" origin/main
ln -s /Users/roshenw/claude_code/ceylon-hop/web-tests/node_modules "$WT3/web-tests/node_modules"
ln -s /Users/roshenw/claude_code/ceylon-hop/api/node_modules "$WT3/api/node_modules"
test -f "$WT3/ride-fomo.js" && echo "ride-fomo.js present"
```

### Task 8: API — paid seats per scheduled taxi

**Files:**
- Create: `api/src/domain/scheduledSeats.ts`, `api/src/domain/scheduledSeats.test.ts`
- Modify: `api/src/db/bookingRepo.ts` (interface ~line 317, `InMemoryBookingRepo` ~line 647), `api/src/db/postgresBookingRepo.ts` (import line 1, class ~line 833)
- Modify: `api/src/routes/rideBoard.ts` (`RideBoardDeps` ~line 140; new route before `r.get('/:code'`), `api/src/app.ts` (`rideBoardRoutes({…})` ~line 565)
- Test: `api/src/db/bookingRepo.paidSharedSeats.test.ts`, `api/src/db/postgresBookingRepo.paidSharedSeats.test.ts`, `api/src/routes/rideBoard.scheduledSeats.test.ts`

**Interfaces:**
- Produces `SharedSeatCount { corridorId; date; time; seats }` and `ScheduledSeatCount { corridorId; date; time; booked }`, both from `api/src/domain/scheduledSeats.ts`.
- `scheduledSeatCounts(rows: SharedSeatCount[]): ScheduledSeatCount[]`.
- `BookingRepo.paidSharedSeats(fromDate: string, toDate: string): Promise<SharedSeatCount[]>` (dates inclusive, `YYYY-MM-DD`).
- `GET /board/scheduled-seats?from=YYYY-MM-DD&days=N` → `{ departures: ScheduledSeatCount[] }`, `cache-control: public, max-age=300`, and 400 `bad_request` on an unreadable `from`.

- [ ] **Step 1: Write the failing tests**

`api/src/domain/scheduledSeats.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { scheduledSeatCounts } from './scheduledSeats';

describe('scheduledSeatCounts — paid seats per van, keyed by each leg it boards', () => {
  it('pools legs that ride one van: CMB 07:00 and Negombo 07:30 both show the van total', () => {
    expect(scheduledSeatCounts([
      { corridorId: 'airport-cultural', date: '2099-08-12', time: '07:00', seats: 3 },
      { corridorId: 'airport-cultural', date: '2099-08-12', time: '07:30', seats: 2 },
    ])).toEqual([
      { corridorId: 'airport-cultural', date: '2099-08-12', time: '07:00', booked: 5 },
      { corridorId: 'airport-cultural', date: '2099-08-12', time: '07:30', booked: 5 },
    ]);
  });
  it('keeps Sigiriya → Kandy on its own van', () => {
    const out = scheduledSeatCounts([
      { corridorId: 'airport-cultural', date: '2099-08-12', time: '07:00', seats: 3 },
      { corridorId: 'airport-cultural', date: '2099-08-12', time: '11:30', seats: 1 },
    ]);
    expect(out).toContainEqual({ corridorId: 'airport-cultural', date: '2099-08-12', time: '07:00', booked: 3 });
    expect(out).toContainEqual({ corridorId: 'airport-cultural', date: '2099-08-12', time: '11:30', booked: 1 });
  });
  it('gives two legs boarding at the same time one entry', () => {
    expect(scheduledSeatCounts([{ corridorId: 'ella-south', date: '2099-08-15', time: '09:00', seats: 4 }]))
      .toEqual([{ corridorId: 'ella-south', date: '2099-08-15', time: '09:00', booked: 4 }]);
  });
  it('keeps dates apart', () => {
    expect(scheduledSeatCounts([
      { corridorId: 'ella-east', date: '2099-08-12', time: '09:00', seats: 2 },
      { corridorId: 'ella-east', date: '2099-08-15', time: '09:00', seats: 3 },
    ])).toEqual([
      { corridorId: 'ella-east', date: '2099-08-12', time: '09:00', booked: 2 },
      { corridorId: 'ella-east', date: '2099-08-15', time: '09:00', booked: 3 },
    ]);
  });
});
```

`api/src/db/bookingRepo.paidSharedSeats.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { InMemoryBookingRepo, type NewBooking } from './bookingRepo';

const customer = { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' };
const seat = (date: string, time: string, seats: number): NewBooking => ({
  mode: 'shared', input: { corridorId: 'airport-cultural', date, time, seats, customer },
  total: 2749 * seats, amountDueNow: 2749 * seats, currency: 'USD',
});

describe('InMemoryBookingRepo.paidSharedSeats', () => {
  it('sums paid seats per departure inside the window — nothing unpaid, cancelled or outside it', async () => {
    const repo = new InMemoryBookingRepo();
    const pay = async (b: NewBooking) => {
      const x = await repo.create(b);
      await repo.setStatus(x.id, 'payment_pending');
      return repo.setStatus(x.id, 'paid');
    };
    await pay(seat('2099-08-12', '07:00', 2));
    await pay(seat('2099-08-12', '07:00', 1));
    const gone = await pay(seat('2099-08-12', '07:00', 5));
    await repo.setStatus(gone.id, 'cancelled');
    await repo.create(seat('2099-08-12', '07:00', 4));        // checkout started, never paid
    await pay(seat('2099-09-30', '07:00', 3));                // outside the window
    expect(await repo.paidSharedSeats('2099-08-11', '2099-08-25')).toEqual([
      { corridorId: 'airport-cultural', date: '2099-08-12', time: '07:00', seats: 3 },
    ]);
  });
});
```

`api/src/db/postgresBookingRepo.paidSharedSeats.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import * as schema from './schema';
import { PostgresBookingRepo } from './postgresBookingRepo';
import { seedCorridors } from './postgresDepartureRepo';
import type { NewBooking } from './bookingRepo';

const TEST_URL = process.env.DATABASE_URL_TEST;
const customer = { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' };
// A date no other suite books, so the shared test database can't skew the sums.
const DAY = '2099-03-17';
const seat = (time: string, seats: number): NewBooking => ({
  mode: 'shared', input: { corridorId: 'airport-cultural', date: DAY, time, seats, customer },
  total: 2749 * seats, amountDueNow: 2749 * seats, currency: 'USD',
});

describe.skipIf(!TEST_URL)('PostgresBookingRepo.paidSharedSeats (integration)', () => {
  let repo: PostgresBookingRepo;
  beforeAll(async () => {
    const sql = postgres(TEST_URL as string);
    const db = drizzle(sql, { schema });
    await migrate(db, { migrationsFolder: 'drizzle' });
    await seedCorridors(sql);
    repo = new PostgresBookingRepo(db);
  });

  it('sums paid seats by departure and leaves unpaid ones out', async () => {
    const pay = async (b: NewBooking) => {
      const x = await repo.create(b);
      await repo.setStatus(x.id, 'payment_pending');
      return repo.setStatus(x.id, 'paid');
    };
    await pay(seat('07:00', 2));
    await pay(seat('07:00', 1));
    await pay(seat('07:30', 2));
    await repo.create(seat('07:00', 4)); // draft — not counted
    const rows = (await repo.paidSharedSeats(DAY, DAY)).filter((r) => r.corridorId === 'airport-cultural');
    expect(rows.sort((a, b) => a.time.localeCompare(b.time))).toEqual([
      { corridorId: 'airport-cultural', date: DAY, time: '07:00', seats: 3 },
      { corridorId: 'airport-cultural', date: DAY, time: '07:30', seats: 2 },
    ]);
  });
});
```

(Re-running the Postgres suite against the same database adds rows again. If it reruns locally without a reset, change `DAY` or truncate first. CI starts from a fresh database.)

`api/src/routes/rideBoard.scheduledSeats.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { InMemoryBookingRepo, type NewBooking } from '../db/bookingRepo';

// GET /board/scheduled-seats (plan 2026-10-19-ride-board-fomo, PR 3): paid seats per scheduled
// taxi, as a count — never who.
const customer = { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' };
const seat = (time: string, seats: number, date = '2099-08-12'): NewBooking => ({
  mode: 'shared', input: { corridorId: 'airport-cultural', date, time, seats, customer },
  total: 2749 * seats, amountDueNow: 2749 * seats, currency: 'USD',
});
async function paid(repo: InMemoryBookingRepo, b: NewBooking) {
  const x = await repo.create(b);
  await repo.setStatus(x.id, 'payment_pending');
  return repo.setStatus(x.id, 'paid');
}

describe('GET /board/scheduled-seats', () => {
  it('counts paid seats per van, on every boarding time that rides it — and names nobody', async () => {
    const bookings = new InMemoryBookingRepo();
    await paid(bookings, seat('07:00', 3));
    await paid(bookings, seat('07:30', 2));
    await bookings.create(seat('07:00', 4)); // checkout started, never paid
    const app = createApp({ bookings });
    const res = await app.request('/board/scheduled-seats?from=2099-08-11&days=14');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    const body = await res.json();
    expect(body.departures).toHaveLength(2);
    expect(body.departures).toEqual(expect.arrayContaining([
      { corridorId: 'airport-cultural', date: '2099-08-12', time: '07:00', booked: 5 },
      { corridorId: 'airport-cultural', date: '2099-08-12', time: '07:30', booked: 5 },
    ]));
    expect(JSON.stringify(body)).not.toContain('Maya');
  });
  it('leaves out seats outside the window', async () => {
    const bookings = new InMemoryBookingRepo();
    await paid(bookings, seat('07:00', 3, '2099-09-30'));
    const body = await (await createApp({ bookings }).request('/board/scheduled-seats?from=2099-08-11&days=14')).json();
    expect(body.departures).toEqual([]);
  });
  it('refuses a date it cannot read', async () => {
    const app = createApp({ bookings: new InMemoryBookingRepo() });
    expect((await app.request('/board/scheduled-seats?from=next-week')).status).toBe(400);
    expect((await app.request('/board/scheduled-seats?from=2099-02-31')).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd "$WT3/api" && npx vitest run src/domain/scheduledSeats.test.ts src/db/bookingRepo.paidSharedSeats.test.ts src/routes/rideBoard.scheduledSeats.test.ts`
Expected: FAIL. `Failed to resolve import "./scheduledSeats"`, `repo.paidSharedSeats is not a function`, and the route answers 404 instead of 200.

- [ ] **Step 3: The pure count** — create `api/src/domain/scheduledSeats.ts`:

```ts
import { SHARED_PRODUCTS, departureKeyFor } from '../db/departureRepo';

// Paid seats on the scheduled shared taxis, for the ride board's "7 booked"
// (plan docs/superpowers/plans/2026-10-19-ride-board-fomo.md, PR 3). A count per van, never who.

/** Paid seats as stored: one row per (corridor, date, boarding time) a booking holds. */
export interface SharedSeatCount { corridorId: string; date: string; time: string; seats: number }
/** What the board reads: the van's paid seats, once per boarding time that rides it. */
export interface ScheduledSeatCount { corridorId: string; date: string; time: string; booked: number }

/**
 * Legs that ride one van share its seats (departureKeyFor — the inventory's own pooling), so
 * CMB 07:00 and Negombo 07:30 both report the van's total. Two legs boarding at the same time
 * (Ella 09:00 → Weligama / → Ahangama) are one entry. A time no product publishes has no row
 * on the board, so it is dropped here.
 */
export function scheduledSeatCounts(rows: SharedSeatCount[]): ScheduledSeatCount[] {
  const pools = new Map<string, number>(); // corridor|date|pool → seats
  for (const r of rows) {
    const k = `${r.corridorId}|${r.date}|${departureKeyFor(r.corridorId, r.time)}`;
    pools.set(k, (pools.get(k) ?? 0) + r.seats);
  }
  const out: ScheduledSeatCount[] = [];
  const seen = new Set<string>();
  for (const [k, booked] of pools) {
    const [corridorId, date, pool] = k.split('|');
    for (const p of SHARED_PRODUCTS) {
      if (p.corridorId !== corridorId || departureKeyFor(corridorId, p.time) !== pool) continue;
      const key = `${corridorId}|${date}|${p.time}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ corridorId, date, time: p.time, booked });
    }
  }
  return out;
}
```

- [ ] **Step 4: The repo read** — in `api/src/db/bookingRepo.ts`:

(a) Add to the imports: `import type { SharedSeatCount } from '../domain/scheduledSeats';`

(b) Directly above `export interface BookingRepo {`, add:

```ts
// A seat someone has paid for: the statuses the ride board's "N booked" counts. Drafts and
// payment_pending also hold inventory (bookings.ts holds at checkout start), so they are out.
export const SEAT_SOLD_STATUSES = ['paid', 'confirmed', 'in_progress', 'completed'] as const;
```

(c) In `interface BookingRepo`, right after the `list(filter?: …): Promise<Booking[]>;` line, add:

```ts
  /** Paid shared seats per (corridor, date, time) for dates in [fromDate, toDate] — counts only. */
  paidSharedSeats(fromDate: string, toDate: string): Promise<SharedSeatCount[]>;
```

(d) In `InMemoryBookingRepo`, right after its `async list(…) { … }` method, add:

```ts
  async paidSharedSeats(fromDate: string, toDate: string): Promise<SharedSeatCount[]> {
    const sold: readonly string[] = SEAT_SOLD_STATUSES;
    const sums = new Map<string, SharedSeatCount>();
    for (const b of this.byId.values()) {
      if (b.mode !== 'shared' || !sold.includes(b.status)) continue;
      const { corridorId, date, time, seats } = b.input;
      if (date < fromDate || date > toDate) continue;
      const key = `${corridorId}|${date}|${time}`;
      const cur = sums.get(key);
      if (cur) cur.seats += seats;
      else sums.set(key, { corridorId, date, time, seats });
    }
    return [...sums.values()];
  }
```

In `api/src/db/postgresBookingRepo.ts`:

(e) Change line 1 to `import { and, asc, desc, eq, exists, gt, gte, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';`

(f) Add `SEAT_SOLD_STATUSES` to the existing `from './bookingRepo'` import, and add `import type { SharedSeatCount } from '../domain/scheduledSeats';`.

(g) Right after the class's `async list(…) { … }` method, add:

```ts
  async paidSharedSeats(fromDate: string, toDate: string): Promise<SharedSeatCount[]> {
    // One grouped read; shared_request holds the departure each booking bought.
    return this.db
      .select({
        corridorId: sharedRequests.corridorId,
        date: sharedRequests.date,
        time: sharedRequests.time,
        seats: sql<number>`sum(${sharedRequests.seats})`.mapWith(Number),
      })
      .from(sharedRequests)
      .innerJoin(bookings, eq(bookings.id, sharedRequests.bookingId))
      .where(and(
        eq(bookings.mode, 'shared'),
        inArray(bookings.status, [...SEAT_SOLD_STATUSES]),
        gte(sharedRequests.date, fromDate),
        lte(sharedRequests.date, toDate),
      ))
      .groupBy(sharedRequests.corridorId, sharedRequests.date, sharedRequests.time);
  }
```

(If `bookings` the table isn't already imported from `./schema` in this file, add it to that import.)

- [ ] **Step 5: The route** — in `api/src/routes/rideBoard.ts`:

(a) Add imports: `import type { BookingRepo } from '../db/bookingRepo';` and `import { scheduledSeatCounts } from '../domain/scheduledSeats';`

(b) In `interface RideBoardDeps`, after the `rateRevisions?: RateRevisionRepo;` line, add:

```ts
  // Paid seats on the scheduled taxis (plan 2026-10-19-ride-board-fomo, PR 3). Unset → no counts.
  sharedSeats?: Pick<BookingRepo, 'paidSharedSeats'>;
```

(c) Directly above `  // GET /board/dupe?from=&to=&date= — the dedupe nudge for the create flow.`, add:

```ts
  // GET /board/scheduled-seats?from=YYYY-MM-DD&days=14 — paid seats on each scheduled taxi, a
  // COUNT per departure and never who: those customers bought a seat, they did not sign up to be
  // shown. Registered before /:code, which would otherwise read "scheduled-seats" as a ride code.
  r.get('/scheduled-seats', async (c) => {
    const from = c.req.query('from') ?? '';
    const start = Date.parse(from + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || Number.isNaN(start) || new Date(start).toISOString().slice(0, 10) !== from) {
      return c.json({ error: 'bad_request' }, 400);
    }
    const days = Math.min(31, Math.max(1, Number.parseInt(c.req.query('days') ?? '14', 10) || 14));
    const to = new Date(start + days * 86400000).toISOString().slice(0, 10);
    const rows = deps.sharedSeats ? await deps.sharedSeats.paidSharedSeats(from, to) : [];
    c.header('cache-control', 'public, max-age=300');
    return c.json({ departures: scheduledSeatCounts(rows) });
  });
```

(The round-trip check refuses `2099-02-31`, which `Date.parse` would otherwise roll over to 3 March.)

In `api/src/app.ts`, inside `rideBoardRoutes({ … })`, add `      sharedSeats: bookings,` on its own line directly above `      memberLinkSecret: deps.bookingLinkSecret ?? config.BOOKING_LINK_SECRET,`. Don't anchor on `rateRevisions,`: that line appears twice in `app.ts`.

- [ ] **Step 6: Run them, then the whole API gate**

```bash
cd "$WT3/api" && DATABASE_URL_TEST=postgres://localhost:5432/ceylonhop_test npx vitest run src/domain/scheduledSeats.test.ts src/db/bookingRepo.paidSharedSeats.test.ts src/db/postgresBookingRepo.paidSharedSeats.test.ts src/routes/rideBoard.scheduledSeats.test.ts
cd "$WT3/api" && DATABASE_URL_TEST=postgres://localhost:5432/ceylonhop_test npm run check; echo "api exit $?"
```

Expected: the four files pass (the Postgres one runs, not skipped), then `npm run check` exits 0. Typecheck proves both repos implement `paidSharedSeats`.

- [ ] **Step 7: Commit**

```bash
git -C "$WT3" add api/src/domain/scheduledSeats.ts api/src/domain/scheduledSeats.test.ts api/src/db/bookingRepo.ts api/src/db/postgresBookingRepo.ts api/src/db/bookingRepo.paidSharedSeats.test.ts api/src/db/postgresBookingRepo.paidSharedSeats.test.ts api/src/routes/rideBoard.ts api/src/routes/rideBoard.scheduledSeats.test.ts api/src/app.ts
git -C "$WT3" commit -m "feat(api): GET /board/scheduled-seats — paid seats per scheduled taxi, a count only

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 9: The board shows "· 7 booked"

**Files:**
- Modify: `ride-fomo.js` (`bookedText`), `web-tests/unit/ride-fomo.test.js`
- Modify: `board.js` — `scheduledVans()` (~line 284), `scheduledRows()` (~line 309), `state` (~line 590), `schedRowHtml()` (~line 771), `boot()` (~line 2238), new `loadSchedSeats()`
- Modify: `board.html` — one CSS rule
- Test: `web-tests/e2e/ride-board-scheduled-booked.spec.js` (new)

**Interfaces:**
- Consumes: `GET /board/scheduled-seats` (Task 8). Rows match on `corridorId|date|time`.
- Produces: `CHRideFomo.bookedText(n) → string|null`. Scheduled rows carry `corridorId`, and their small lines get `.rws-booked`.

- [ ] **Step 1: Write the failing tests**

Append to `web-tests/unit/ride-fomo.test.js`:

```js
describe('bookedText', () => {
  it('says how many have booked, from two up', () => {
    expect(F.bookedText(7)).toBe('7 booked');
    expect(F.bookedText(2)).toBe('2 booked');
  });
  it('stays quiet below two — "1 booked" reads as empty, not busy', () => {
    expect(F.bookedText(1)).toBeNull();
    expect(F.bookedText(0)).toBeNull();
    expect(F.bookedText(undefined)).toBeNull();
  });
});
```

Create `web-tests/e2e/ride-board-scheduled-booked.spec.js`:

```js
import { test, expect } from '@playwright/test';
import { isApiRequest } from './_api-host.js';

// Paid seats on scheduled taxis (plan 2026-10-19-ride-board-fomo, PR 3): a count, never names,
// and only from 2 up. The clock is pinned to Mon 10 Aug 2099, so Wed 12 Aug is the first run.
const NOW = '2099-08-10T00:00:00.000Z';
const SEATS = { departures: [
  { corridorId: 'airport-cultural', date: '2099-08-12', time: '07:00', booked: 7 },
  { corridorId: 'airport-cultural', date: '2099-08-12', time: '07:30', booked: 7 },
  { corridorId: 'airport-cultural', date: '2099-08-12', time: '11:30', booked: 1 },
] };

async function stubApi(page, seats = SEATS) {
  const asked = [];
  await page.route((u) => isApiRequest(u), (route) => {
    const u = new URL(route.request().url());
    const json = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (u.pathname === '/board') return json({ lists: [] });
    if (u.pathname === '/board/me') return json({ me: null });
    if (u.pathname === '/board/scheduled-seats') { asked.push(u.search); return json(seats); }
    return json({});
  });
  return asked;
}

const wedRow = (page, time) => page.locator('.rw-group', { has: page.locator('.rw-day-h', { hasText: 'Wed 12 Aug' }) })
  .locator('.rws', { has: page.locator('.rw-when', { hasText: time }) });

test('a busy scheduled taxi says how many have booked; a quiet one says nothing', async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));
  const asked = await stubApi(page);
  await page.goto('/board.html');
  await expect(wedRow(page, '07:00').locator('.rws-booked').first()).toContainText('7 booked', { timeout: 15000 });
  await expect(wedRow(page, '11:30').locator('.rws-booked')).toHaveCount(0);
  expect(asked[0]).toContain('from=2099-08-11');
  expect(asked[0]).toContain('days=14');
});

test('the Negombo stop of the same van shows the same count', async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));
  await stubApi(page);
  await page.goto('/board.html?from=Negombo&to=' + encodeURIComponent('Sigiriya / Dambulla'));
  await expect(wedRow(page, '07:30').locator('.rws-booked').first()).toContainText('7 booked', { timeout: 15000 });
});

test('no counts when the API has none to give', async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));
  await stubApi(page, {});
  await page.goto('/board.html');
  await expect(wedRow(page, '07:00')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.rws-booked')).toHaveCount(0);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd "$WT3/web-tests" && npx vitest run unit/ride-fomo.test.js && npx playwright test e2e/ride-board-scheduled-booked.spec.js`
Expected: vitest FAILs with `F.bookedText is not a function`. (Run the Playwright spec after Step 3 too; on its own now it fails because `.rws-booked` is not found.)

- [ ] **Step 3: Implement**

`ride-fomo.js`: above `window.CHRideFomo = {`, add

```js
  // A scheduled taxi's paid seats (PR 3), said only when it reads as busy: "1 booked" reads as
  // empty. A count only — the API never says who.
  function bookedText(n) {
    n = Number(n) || 0;
    return n >= 2 ? n + ' booked' : null;
  }
```

and add `bookedText: bookedText` to the exported object.

`board.js`:

(a) In `scheduledVans()`, replace

```js
        vans.push({
          to: to, toId: t, days: so.days || [], freqText: so.freqText || '', seat: so.seat,
```

with

```js
        vans.push({
          to: to, toId: t, days: so.days || [], freqText: so.freqText || '', seat: so.seat, corridorId: so.corridorId,
```

(b) In `scheduledRows()`, replace

```js
        rows.push({ sched: true, date: iso, time: leg.time, from: leg.place, fromId: leg.placeId, point: leg.point,
```

with

```js
        rows.push({ sched: true, date: iso, time: leg.time, from: leg.place, fromId: leg.placeId, point: leg.point, corridorId: v.corridorId,
```

(c) In the `state` object, after `    lists: [],            // currently displayed normalized lists`, add

```js
    schedSeats: {},       // "corridorId|date|time" → paid seats on that scheduled taxi (PR 3)
```

(d) Replace the two comment lines above `function schedRowHtml(S) {` (starting `// A scheduled taxi: its clock time`) and the whole function with

```js
  // A scheduled taxi: its clock time, the solid clock mark, an exact price and no button — the
  // whole row is the link to book it on search.html for that date. "· 7 booked" when that many
  // have paid (plan 2026-10-19-ride-board-fomo, PR 3) — a count, never who.
  function schedRowHtml(S) {
    var href = 'search.html?' + new URLSearchParams({ from: S.fromId || S.from, to: S.toId || S.to, date: S.date }).toString();
    var booked = window.CHRideFomo.bookedText(state.schedSeats[S.corridorId + '|' + S.date + '|' + S.time]);
    var bk = booked ? '<span class="rws-booked"> · ' + esc(booked) + '</span>' : '';
    return '<a class="rws" href="' + esc(href) + '"' +
      ' aria-label="' + esc('Scheduled taxi, ' + S.from + ' to ' + S.to + ', departs ' + S.time + ', ' + money(S.seat) + ' a seat' + (booked ? ', ' + booked : '')) + '">' +
      '<div class="rw-when"><b>' + esc(S.time) + '</b></div>' +
      '<div class="rw-route"><span class="rw-places">' + placeTag(S.from, 'a') + '<span class="arr">→</span>' + placeTag(S.to, 'b') + '</span>' +
        '<span class="rws-short">' + esc(shortPlace(S.from)) + ' → ' + esc(shortPlace(S.to)) + '<small>Scheduled' + bk + '</small></span></div>' +
      '<div class="rws-kind"><span class="rws-mark">' + CLOCK_SVG + '</span>' +
        '<span class="rws-kt"><b>Scheduled</b><small>Always runs' + bk + ' · ' + esc(S.point) + '</small></span></div>' +
      '<div class="rw-price"><b>' + money(S.seat) + '</b><span class="rws-per"> / seat</span></div>' +
      '<span class="rws-go">Book a seat</span>' +
      '</a>';
  }

  // Paid seats on each scheduled taxi, once per page (the API caches it for five minutes).
  // Silent on failure: a scheduled row without a count is exactly what the board showed before.
  // Never repaints over a failed board load — that screen is the error message.
  function loadSchedSeats() {
    var from = addDaysIso(colomboToday(Date.now()), 1);
    return apiGet('/board/scheduled-seats?from=' + from + '&days=' + SCHED_DAYS).then(function (d) {
      var map = {};
      ((d && d.departures) || []).forEach(function (x) { map[x.corridorId + '|' + x.date + '|' + x.time] = x.booked; });
      state.schedSeats = map;
      if (Object.keys(map).length && !state.loadFailed) render();
    }).catch(function () {});
  }
```

(e) In `boot()`, replace `    var board = loadBoard();` with

```js
    var board = loadBoard();
    board.then(loadSchedSeats);
```

`board.html`: after the `.rws-kt small{…}` rule, add

```css
/* "· 7 booked" on a scheduled taxi (plan 2026-10-19-ride-board-fomo, PR 3) */
.rws-booked{color:var(--ink);font-weight:600}
```

- [ ] **Step 4: Stamp and run**

```bash
cd "$WT3" && npm run stamp
cd "$WT3/web-tests" && npx vitest run unit/ride-fomo.test.js unit/ride-board-scheduled.test.js && npx playwright test e2e/ride-board-scheduled-booked.spec.js e2e/ride-board-scheduled.spec.js e2e/ride-board-rows.spec.js
```

Expected: vitest `Tests  N passed` (ride-fomo now 27 if PR 2 has merged, else 22), and Playwright all passed, exit code 0.

- [ ] **Step 5: Full gate, look at it, open PR 3**

```bash
cd "$WT3/api" && DATABASE_URL_TEST=postgres://localhost:5432/ceylonhop_test npm run check; echo "api exit $?"
npm --prefix "$WT3/web-tests" run test:all; echo "web exit $?"
git -C "$WT3" add ride-fomo.js board.js board.html web-tests/unit/ride-fomo.test.js web-tests/e2e/ride-board-scheduled-booked.spec.js
git -C "$WT3" status --short
git -C "$WT3" commit -m "feat(board): scheduled taxis say how many have booked, from two up

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git -C "$WT3" push -u origin feat/board-scheduled-booked
git -C "$WT3" ls-remote origin refs/heads/feat/board-scheduled-booked   # must equal: git -C "$WT3" rev-parse HEAD
```

Visual check at 375px and 1280px as in Task 4, served from `$WT3`. Prod has no scheduled bookings in the test window, so stub it: open the page with the e2e stubs, or eyeball staging after merge.

Write `$WT3/../pr3-body.md` with these sections:
- **What / Why:** the design calls above (paid only, per van, count only, from 2, no seats left).
- **Red→green:** for Tasks 8 and 9.
- **Gate:** summary lines with exit codes.
- **Interface note:** a new `BookingRepo` method, read-only, no migration.
- End with the 🤖 line.

```bash
cd /private/tmp && gh pr create --repo ceylonhop/ceylon-hop --base main --head feat/board-scheduled-booked \
  --title "feat(board): \"N booked\" on scheduled taxis (plan 2026-10-19, PR 3)" --body-file "$WT3/../pr3-body.md"
```

The API change reaches staging when this merges to `main` and Render redeploys. Production needs the owner's `main → production` promote.

## Not in scope (separate follow-ups)

- **A broken promise.** `board.html`'s success step says "We'll email you the second someone signs under you", but no such email exists. Only the joiner and ops are mailed (`api/src/routes/rideBoard.ts` `mailJoinReceipt`).
- **Excluding seeded names from counts.** This needs a seed flag in the public projection (API change).
- **GTM tags** for `share` and the home `select_item`.
- **The `/r/CODE/card.png` unfurl image** still shows the old card design. The prototype's chat preview is a proposal for it.
