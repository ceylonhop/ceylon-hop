# Unified route page (design A) — implementation plan

Date: 2026-08-16
Design: **A — one shared option.** Prototype: `_proto-route-A.html`
(compare against `_proto-route-B.html`, the rejected two-block version).
Status: **awaiting owner go.** Nothing in phases 1–4 is built.

---

## 0. The decision this plan encodes

Shared taxi and the ride board are **one product**, so the customer sees **one shared
option**. A shared seat is a *date with names on it*. The words "scheduled" and "ride
board" never appear in customer copy.

| | Before | After (A) |
|---|---|---|
| Customer-facing products | private, shared taxi, ride board | **private, shared** |
| "Is it available on my date?" | Wed & Sat only | **any date** — it runs when 3 names commit |
| Wed & Sat | a promise we don't keep (§D1) | a **seeding policy** — those lists start with names |
| Booking paths | `POST /bookings/shared` + `POST /board/:code/join` | **join only** |
| Route pages | `trip/*` (indexed, thin) → `search.html` (rich, noindex) | **one indexed page** |

The load-bearing simplification: there is **no "unavailable" state for shared**. Every date
can run. That deletes service-day gating from the customer's view entirely.

---

## 1. What is already built (branch `feat/shared-seat-catalogue`, 6 commits, unpushed)

| Commit | Survives under A? |
|---|---|
| `45c943ec` catalogue replaces adjacency | ✅ **Foundation.** Defines which routes have shared at all, their prices, stops and boarding times. A needs every bit of it. |
| `9e8bef5a` booking priced from the product | ✅ Correct now; the route it prices is retired in phase 2, but the pricing function moves with it. |
| `1f1c9144` board prices from the catalogue | ✅ **Foundation.** A's single price depends on this exact change. |
| `ebf244e8` list every pick-up point | ✅ Becomes the route page's "stops" line. |
| `31191c17` search: board lists + off-day handoff | ⚠️ **Half superseded.** The board-lists-on-search work is right; the *off-day handoff* (shift-a-day chips, `not_a_service_day` copy) describes a distinction A deletes. |
| `124df368` spec | ✅ Historical record. |

### 1.1 Recommendation — split the merge

**Merge now:** `45c943ec`, `9e8bef5a`, `1f1c9144`, `ebf244e8`, `124df368`.
They are correct, tested, and every later phase builds on them. They also fix live money
bugs (Negombo→Sigiriya at $19 against a real $27.49) that should not wait behind a page
redesign.

**Hold:** `31191c17`. Its off-day UI teaches a distinction we are about to remove, and
`search.html` is superseded by the route page. Cherry-pick its board-fetch logic into
phase 3 rather than shipping then deleting it.

> If the owner prefers one clean branch, the alternative is to revert `31191c17` on the
> branch and merge all five. Same outcome, one more commit.

---

## 2. Phase 1 — booking unification (backend). The only risky phase.

**Goal:** every shared seat is bought by joining a list. `POST /bookings/shared` retires.

This is the one phase that touches a live booking path, so it goes first and alone.

1. **Seeded lists.** A scheduled departure becomes a list Ceylon Hop creates in advance,
   **16 weeks ahead** (owner, 2026-08-16).
   Seeding job creates lists for the next N weeks on each catalogue leg's Wed & Sat, at
   the catalogue price, with the product's boarding time.
   - `minSeats` stays 3 → seeded lists still need to fill (matches D1 reality).
   - **If the owner ever wants a guaranteed van, `minSeats: 0` makes it born confirmed** —
     no model change, per the original spec.
2. **Any date is joinable.** Drop the `not_a_service_day` gate (`bookings.ts:488`).
   Service days become a seeding input, not a booking rule.
3. **`POST /bookings/shared` → 410**, with a body pointing at the list flow. Keep the
   route so old clients get an answer, not a 404.
4. **Existing `shared_request` bookings are untouched** and keep rendering in ops. Only
   creation stops.

**Not in this phase:** dropping `shared_departure` / `shared_request` / `sweepStaleSharedHolds`
/ `rideBoardEmails` merge. Those are phase 4, after a bake.

**Tests, red first:** a Tuesday shared booking succeeds via join; `POST /bookings/shared`
410s; a seeded Wed list exists at the catalogue price with the right boarding time; an
existing shared booking still loads in ops.

**Open question for the owner:** how far ahead do we seed, and does a seeded list that
never fills get swept silently or emailed? (`rideBoardCutoff` already emails a call-off.)

---

## 3. Phase 2 — the route page, static-first

**Goal:** `trip/<from>-to-<to>/` becomes the real product page.

The prototype is the spec for layout. The build constraint is the one I hit **twice**
while prototyping, and it is the single biggest risk here:

> **The generator must emit the complete flexible state as static HTML. JS may only layer
> date-specific behaviour on top.** Any JS-rendered region is invisible to Googlebot — and
> these pages exist to be indexed. Verify by stripping `<script>` and asserting the price,
> stops, dates and FAQ all survive.

1. `generate-route-pages.mjs` emits the two option cards fully rendered, from
   `sharedOption()` + a build-time board snapshot.
2. A small runtime script refreshes the list rows from `GET /board` and handles the date
   picker. Fails silent — prices are the page.
3. `search.html` keeps working for **engine routes** (Google-picked places with no static
   page) and redirects catalogue pairs to their `trip/` URL.
4. Homepage search lands on `/trip/a-to-b/` for known pairs.

**Test:** for every generated page, the script-stripped HTML contains price, stops, dates
and FAQ; no page mentions a shared seat it does not sell.

---

## 4. Phase 3 — make the pages reachable

Today **nothing** links to `trip/*` — not the nav, not the footer, not the homepage. The
only internal link is on `404.html`. 45 URLs sit in `sitemap.xml` and that is it.

- Nav/footer entry to `/trip/` (touches shared chrome — propose first).
- Homepage popular-routes cards link to route pages, not `search.html?from=…`.
- Add the three sellable legs that have **no page at all**: `weligama→cmb-airport`,
  `mirissa→colombo`, `weligama→colombo` (needs new `route-content.json` copy).
- Retire `board.html` as a destination, or keep it as a cross-route "all dates" index.
  **Owner decision.**

---

## 5. Phase 4 — cleanup (only after phase 1 has baked)

Drop `shared_departure`, `shared_request`, `sweepStaleSharedHolds`; fold
`rideBoardEmails.ts` into `notifications.ts`; remove `corridor.seat_price` (unread since
`9e8bef5a`). One migration, last, when nothing has used them for weeks.

---

## 6. Sequencing — REVISED 2026-08-16 after two findings

### 6.1 Finding A — the ride board never takes a card

`api/src/app.ts:141` is `deps.paygw ?? new FakeTokenizedPaymentAdapter()`, and `server.ts`
passes no `paygw`. **Production runs the fake.** No real tokenized adapter exists in the
repo — only `FakeTokenizedPaymentAdapter` implements the interface. So today, joining a
list tokenizes nothing and the cutoff charges nothing, while the UI says *"your card is
saved, charged only when the van is confirmed."*

This would have made the original phase 1 ship a disaster: `POST /bookings/shared` takes
**real money** through PayHere checkout, and retiring it in favour of the join flow would
have moved all shared revenue onto a stub.

**Owner has a separate thread building real card-on-file for the board.** This plan does
NOT touch `tokenizedPayments.ts`, the `paygw` wiring, or the join payment path — that work
is theirs, and phase 1 waits on it.

### 6.2 Finding B — the board already accepts any date

`POST /board` has **no service-day gating at all** (zero references to `serviceDays` /
`isoWeekday` / `not_a_service_day`). Design A's core promise — *a van runs on any date once
3 travellers commit* — is **already true in the backend.** The Wed & Sat rule is enforced
only by `POST /bookings/shared`, the path design A stops using.

So the route page does not depend on phase 1 at all. It can be built honestly today.

### 6.3 Revised order

```
merge #535 ──► phase 2 (route page)  ──► phase 3 (reachability)
  money bugs     UNBLOCKED — the board          nav, homepage,
  fixed now      already does any-date          missing pages
                          │
   [owner's card thread] ─┴──► phase 1 (retire POST /bookings/shared) ──► phase 4 (cleanup)
                                  needs real card capture first
```

Phase 2 moved ahead of phase 1: it is unblocked, it is the visible half, and it is the half
that stops the page contradicting itself. Phase 1 became a *cleanup* — removing a payment
path — rather than the enabling step, and it cannot start until the owner's card work lands.

---

## 6.4 Owner decisions, 2026-08-16

| | Decision |
|---|---|
| Seeding horizon | **16 weeks** of Wed & Sat lists per catalogue leg |
| `board.html` | **Kept** — the cross-route "see it all in one place" view. It stops being the *only* place pooling lives, not a page that goes away. |
| Card capture | **Separate owner thread.** Out of scope here. |

**Consequence of 16 weeks + real cards (for the card thread to consider, not this plan):**
someone joining a list 16 weeks out holds a token until 48h before departure
(`CUTOFF_HOURS_BEFORE = 48`). Whether PayHere tokens survive ~4 months, and whether that
hold is acceptable to the customer, is a payment-side question.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| Phase 1 touches a live booking path | Ships alone, behind its own PR. `POST /bookings/shared` 410s rather than 404s. Existing bookings untouched. |
| Route pages are indexed; a JS-only render is invisible to Google | Static-first rule (§3) + a script-stripped assertion in the test suite. Hit this twice in the prototype. |
| Seeded lists that never fill look like dead stock | `rideBoardCutoff` already calls off and emails. Confirm the seeding horizon with the owner. |
| Losing "guaranteed departure" as a sales line | Already not true (D1). `minSeats: 0` restores it later with no model change. |
| SEO change on 54 indexed pages | Content grows rather than shrinks; URLs unchanged; `search.html` redirects rather than 404s. |

---

## 8. Still open, unchanged by this plan

- The two assumed prices: CMB→Sigiriya **$27.49**, Mirissa/Weligama→Colombo **$29.99**.
- **WordPress still sells daily departures** and must be reduced to Wed & Sat. Live,
  customer-facing, outside this repo — **ahead of everything here**.
- Porting "free cancellation up to 10 days" into `terms.html` §7.
- CMB/Negombo→Kandy through-leg: physically possible, no product, no price.
