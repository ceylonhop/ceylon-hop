# Shared-seat catalogue, price correction, and ride board on search — design

Date: 2026-08-16
Status: **ready to plan.** All blocking inputs received; two prices assumed and flagged
(§1.2).
Owner decisions were all made explicitly in the brainstorming session of 2026-08-16.

---

## 0. Summary

The site advertises a shared seat wherever two places happen to be **adjacent on a
corridor's `stops` array**. That is not what Ceylon Hop sells. The result is 32 live pages
offering seats on services that do not run — 16 of them the *reverse* of the corridor's
direction — one real product underpriced by $8.49, and three real products missing
entirely.

The fix is to stop deriving offers from adjacency and hold an explicit, hand-priced
catalogue of the eight directed legs actually sold, with their real per-stop departure
times.

Shared service is being reduced from daily to Wed & Sat because daily vans are not filling
(§1.0). That makes the last step the important one: on the 5 non-service days, the ride
board becomes the offer instead of a refusal, at the same price as the scheduled seat.

**Three PRs:**

| | What | Outcome |
|---|---|---|
| 1 | Catalogue replaces adjacency; per-product prices; regenerate | 27 pages stop advertising rides that do not run; 5 keep a correct one |
| 2 | Board prices catalogue legs from the catalogue | one journey never shows two prices |
| 3 | Board lists on search + non-service-day handoff | Thursday travellers pool a van instead of being turned away |

---

## 1. The catalogue (from the live WordPress product pages, 2026-08-16)

Source: four product pages supplied by the owner as PDFs, captured 2026-08-16. Prices are
per adult.

### 1.0 Frequency: daily today, Wed & Sat by decision (RESOLVED 2026-08-16)

**The repo needs no change here.** The owner confirmed the WordPress pages are accurate —
service *is* daily today — but is **deliberately reducing to Wed & Sat** because daily vans
are not filling. `SHARED_DAYS = [3, 6]` in `transfers-data.js:50` and
`departureRepo.ts:49` already encodes the target state, as does the
`not_a_service_day` guard in `bookings.ts:470`.

Action sits on **WordPress**, which still sells daily departures and is the live booking
surface. Out of scope for this repo; flagged to the owner.

Per-leg departure times (§1.1) are unaffected — frequency and time of day are independent.

The original finding is preserved below, because it documents what the live pages say and
why the mismatch existed.

<details><summary>Original finding — the pages say DAILY</summary>

Every one of the four pages is headed **"Daily Pick-up and Drop-off Times"**, and three say
"daily" in body copy ("Departs from Barista Cafe at Sigiriya **daily** at 11.30am";
"Departs from Barn by Starbeans at Ella **daily** at 9AM"; "Departs **Daily** from Barista
Cafe Mirissa and Nomad Cafe at Weligama").

The codebase encodes `SHARED_DAYS = [3, 6]` — Wed & Sat — in **both**
`transfers-data.js:50` and `api/src/db/departureRepo.ts:49`. And
`POST /bookings/shared` **rejects** any non-service-day date with `not_a_service_day`
(`api/src/routes/bookings.ts:470`).

**So the new stack would refuse bookings on 5 days out of 7 for services that run every
day.**

</details>

*Superseded: the owner is reducing service to Wed & Sat, so the code is already correct.*

### 1.1 The two daily circuits

The products are not independent routes — they are **legs of two daily circuits with timed
stops**:

**Northbound** (products 1 & 2)

| Stop | Time | Place |
|---|---|---|
| CMB Airport | depart 07:00 | CMB Airport |
| Negombo | pick-up 07:30 | Zen Cafe, Negombo |
| Sigiriya | drop-off / depart 11:30 | Barista Cafe, Sigiriya |
| Kandy | arrive **~14:00 (approx)** | — |

Kandy has no published arrival time. Owner chose to show an approximate one, derived from
`REAL_KM` (Sigiriya→Kandy 89 km / 150 min → 11:30 + 2h30) and **labelled as approximate**
on the page.

**Southbound** (products 4 & 5)

| Stop | Time | Place |
|---|---|---|
| Mirissa | depart 14:45 | Barista Cafe |
| Weligama | depart 15:00 | Nomad Cafe |
| Colombo | drop-off 18:30 | Barista Cafe, Nawam Mawatha |
| CMB Airport | drop-off 19:00–20:00 | CMB Airport |

**Ella → Yala** (product 3) is its own daily run

| Stop | Time | Place |
|---|---|---|
| Ella | depart 09:00 | Barn by Starbeans Cafe |
| Yala | drop-off 11:15 | Chef Lady, **Tissamaharama** |

Note the marketed "Yala" drop-off is physically **Tissamaharama**.

### 1.2 The catalogue — 8 directed legs

| # | Product | From | To | Seat | Departs |
|---|---|---|---|---|---|
| 1 | Shared Ride – Negombo to Sigiriya | `cmb-airport` | `sigiriya` | **$27.49** ᴬ | 07:00 daily |
| 2 | Shared Ride – Negombo to Sigiriya | `negombo` | `sigiriya` | **$27.49** | 07:30 daily |
| 3 | Shared Ride – Sigiriya to Kandy | `sigiriya` | `kandy` | **$19.99** | 11:30 daily |
| 4 | Shared Ride – Ella to Yala | `ella` | `yala` | **$22.99** | 09:00 daily |
| 5 | Mirissa/Weligama to Airport | `mirissa` | `cmb-airport` | **$29.99** | 14:45 daily |
| 6 | Mirissa/Weligama to Airport | `weligama` | `cmb-airport` | **$29.99** | 15:00 daily |
| 7 | Mirissa/Weligama to Airport | `mirissa` | `colombo` | **$29.99** ᴮ | 14:45 daily |
| 8 | Mirissa/Weligama to Airport | `weligama` | `colombo` | **$29.99** ᴮ | 15:00 daily |

Each marketed product carries multiple pickup or drop-off points, exactly as the live
Mirissa/Weligama page already does. All legs are **one direction only**.

**Assumptions to confirm — both default to the product's single published price, which is
how the live Mirissa/Weligama page already treats its two pickup points:**

- ᴬ **CMB → Sigiriya at $27.49.** Owner confirmed the airport is a boarding point ("7am
  airport then go to Negombo 7.30 zen cafe") but gave no separate price. Treated as a
  second pickup point on the Negombo product.
- ᴮ **Mirissa/Weligama → Colombo at $29.99.** Owner confirmed it is sellable but gave no
  price. Colombo is a shorter leg than the airport, so this may warrant its own price.

**Not added — flagged, not invented:** the northbound van continues Sigiriya → Kandy on the
same 11:30 departure, so **CMB/Negombo → Kandy is physically possible**. It is not a
marketed product and no price exists, so it is excluded. Worth an owner decision.

### 1.3 Product terms (currently absent from the new stack)

Identical across all four pages unless noted:

- **Free cancellation up to 10 days before departure** — this is the policy `terms.html` §7
  is missing (§8).
- Changes permitted up to 24 hours before.
- Instant confirmation · flexible duration · minimum 1 day.
- **Included:** reserved seat; Hop Concierge Team (via WhatsApp on product 4); unlimited
  water bottles; restaurant/hotel/activity recommendations; Pro Hopper guide in vehicle
  (products 1–3); pick-up and drop-off (product 3).
- **Not included:** entrance tickets (Sigiriya, Yala); accommodation, activities and
  reservations; meals.

### 1.4 Named pickup points

Operational data with nowhere to live in the current model — the new stack has no field for
a boarding location:

| Place | Point |
|---|---|
| Negombo | Zen Cafe |
| Sigiriya | Barista Cafe |
| Ella | Barn by Starbeans Cafe |
| Yala / Tissamaharama | Chef Lady |
| Mirissa | Barista Cafe |
| Weligama | Nomad Cafe |
| Colombo | Barista Cafe, Nawam Mawatha |

### 1.5 What is live today vs the catalogue

| Product | Live price | Actual | Gap |
|---|---|---|---|
| Negombo → Sigiriya | $19 | $27.49 | **−$8.49 undercharged** |
| Sigiriya → Kandy | $19 (trip page only, unlisted product) | $19.99 | −$0.99 |
| Ella → Yala | $23 | $22.99 | ≈ correct |
| Mirissa/Weligama → Airport | not offered | $29.99 | product missing |

### 1.6 Withdrawn

Marketed with landing pages, blurbs, hero images and "Wed & Sat · 8am" tags, but **not
sold** (D9):

- `yala-mirissa` — "Yala to Mirissa / Weligama / Ahangama", $16
- `ella-arugam` — "Ella to Arugam Bay", $23

Removing `yala-mirissa` leaves **Ahangama** with no shared mention anywhere.

### 1.7 Prices are a catalogue, not a formula

One $29.99 price covers Mirissa→CMB (177 km) and Weligama→CMB (173 km), and none of the
five match `seatPriceForDistance`:

| Leg | Formula would give | Catalogue |
|---|---|---|
| Negombo → Sigiriya | $26.50 | $27.49 |
| Sigiriya → Kandy | $16.50 | $19.99 |
| Ella → Yala | $22.50 | $22.99 |
| Mirissa → Airport | $32.00 | $29.99 |
| Weligama → Airport | $31.00 | $29.99 |

**This supersedes the earlier "live distance for both" decision (D2/D3) for the shared
product.** The 35-leg repricing table and the distance machinery drop out of the shared
side entirely — it becomes five numbers. Distance pricing survives only on the ride board,
for legs with no catalogue entry (§6).

---

## 2. Owner decisions

| # | Question | Decision |
|---|---|---|
| D1 | Do scheduled vans run regardless of load? | **No** — they run only if they fill. |
| D4 | Fixed Wed/Sat schedule in the consolidated model | **Dropped**, re-addable later as `minSeats: 0`. |
| D5 | Search block scope | **Read-only teaser** — joining stays on `board.html`. |
| D7 | Which legs are sold | **Explicit owner-supplied catalogue** (§1), not adjacency. |
| D8 | Sequencing | **Narrow + correct prices first**, then surface on search. |
| D9 | `yala-mirissa`, `ella-arugam` | **Discontinued — remove.** |
| D10 | Board price on catalogue legs | **Catalogue price wins.** Distance pricing only off-catalogue. |
| D11 | Mirissa/Weligama → Airport | **One direction only.** No return service. |

Superseded: D2 (live distance for both) and D3 (accept `SEATS_COVERING_VAN = 3` repricing)
— both overtaken by §1.3. They still govern the **board's** off-catalogue pricing.

---

## 3. Non-goals

- Retiring the shared taxi product, its booking flow, or `shared_departure` /
  `shared_request`. No migration in this spec.
- Merging `rideBoardEmails.ts` into `notifications.ts`.
- Any change to **private** transfer pricing.
- Inline joining from the search page (D5).
- Fixing the deposit-taken-for-a-van-that-may-not-run gap (§8).

---

## 4. Design: a catalogue replaces adjacency

`sharedOption()` currently does two unrelated jobs — "is there a shared product here?" and
"which corridor do these two places share?". Only the first should narrow. The board is
precisely the mechanism for routes that are *not* scheduled, so its corridor matching must
stay broad.

Split the function:

```js
// The scheduled product. DIRECTED, exact match, catalogue only.
function sharedOption(fromId, toId) {
  const p = SHARED_PRODUCTS.find(p => p.from === fromId && p.to === toId);
  return p ? { corridorId: p.corridor, corridorLabel: …, seat: p.seat,
               times: p.times, days: p.days, freqText: … } : null;
}

// Corridor membership only — the old adjacency logic, unchanged.
function corridorFor(fromId, toId) { … }
```

- `sharedOption()` consumers keep working unchanged, because they only read `.seat`,
  `.times`, `.freqText`: `search.js:155`, `index.html:692`, `why.html:193`,
  `tools/generate-pricing.mjs:95`, `tools/generate-route-pages.mjs:116`.
- `board.js:1107` `pairCorridor()` switches from `sharedOption` to `corridorFor`, so
  pooling coverage is unaffected by the narrowing.

`SHARED_PRODUCTS` is generated into the `@generated:pricing` block from a single backend
source of truth in `api/src/db/departureRepo.ts` — prices never hand-edited in
`transfers-data.js`, per the drift rules.

### 4.1 The new corridor

`south-airport` (`mirissa`/`weligama` → `cmb-airport`) is added to `DEFAULT_CORRIDORS`.
`seedCorridors()` upserts the catalogue at server start
(`api/src/db/postgresDepartureRepo.ts:12`), so this needs **no migration** — it lands on
staging when merged to `main`, and on prod at the promote.

It also makes Mirissa/Weligama → Airport poolable on the ride board, which it is not today.

### 4.2 Per-product prices, not per-corridor

`corridor.seat_price` holds one price per corridor, but `airport-cultural` now carries two
products at $27.49 and $19.99. So `POST /bookings/shared`
(`api/src/routes/bookings.ts:439`) prices from the **product**, not the corridor.

`corridor.seat_price` stays in the schema, unread by pricing. No migration; it is removed
in a later cleanup.

---

## 5. Step 1 — catalogue, coverage and prices

One PR, two commits (coverage, then prices) so each is revertible.

0. ~~Daily service~~ — **dropped (§1.0).** `SHARED_DAYS = [3, 6]` already matches the
   owner's target schedule. "Wed & Sat" copy stays as-is and becomes accurate once
   WordPress is reduced to match.
1. `departureRepo.ts` — add `SHARED_PRODUCTS` with per-leg departure times, add the
   `south-airport` corridor, remove the two withdrawn products.
2. `transfers-data.js` — split `sharedOption` / `corridorFor` per §4; `SHARED_PRODUCTS`
   arrives via the generated block.
3. `board.js` — `pairCorridor()` → `corridorFor()`.
4. `bookings.ts` — `POST /bookings/shared` prices per product; reject a pair with no
   catalogue entry (`not_a_shared_route`, 400) instead of pricing off a corridor.
5. `routes-data.js` — remove `yala-mirissa` and `ella-arugam`; add `sigiriya-kandy` and
   `mirissa-weligama-airport`; prices come from codegen.
6. `npm run generate` — rewrites the 44 `trip/*.html` pages (28 lose their shared chip,
   title, meta description and FAQ entry; two gain one) and restamps every root asset's
   `?v=` cache-buster, without which CI goes red.

**Expected page-level outcome:** of 32 pages currently advertising a shared seat, **5**
keep it. The other 27 revert to private-only — which is what they should always have said.

### 5.1 Three sellable legs have no trip page

Five of the eight catalogue legs have a `trip/*` page. **Three do not**, because the place
pairs never appear in `BASE_PAIRS` (`tools/generate-route-pages.mjs:13`):

| Leg | Page |
|---|---|
| `weligama` → `cmb-airport` | none — `weligama` is absent from `BASE_PAIRS` entirely |
| `mirissa` → `colombo` | none |
| `weligama` → `colombo` | none |

So three legs Ceylon Hop actively sells have no landing page and no SEO presence. Adding
them to `BASE_PAIRS` generates pages — but each also mints its reverse page and needs new
`route-content.json` copy (`intro`, `back`, `highlights`), so this is **out of scope here**
and flagged for a decision rather than done silently.

---

## 6. Step 2 — board reads the catalogue (D10)

`POST /board` (`api/src/routes/rideBoard.ts:213`) currently always calls
`seatPriceForDistance(distance.km)`. It gains a catalogue lookup first:

```
seatPrice = catalogueSeat(fromPlace, toPlace) ?? seatPriceForDistance(distance.km)
```

A board list for Negombo→Sigiriya then prices at $27.49, matching the scheduled seat. The
distance call — and its `cannot_price_route` 503 — is skipped entirely on catalogue legs.

This also fixes an existing defect: the board's create form quotes `pairCorridor().seat`
client-side while the server persists a distance-derived price, so the two can already
disagree. After this they agree by construction on catalogue legs, and the form should
compute the same fallback the server does off-catalogue.

---

## 7. Step 3 — board lists on search, and the non-service-day handoff

Own PR, after steps 1–2 are green. **Step 2 must land first**: the handoff promises the
same price on both, which is only true once the board reads the catalogue.

### 7.0 Why this is the point of the whole exercise

The owner is reducing shared service from daily to Wed & Sat because daily vans are not
filling (§1.0). Under that schedule a traveller wanting a Thursday is **refused outright**
— `POST /bookings/shared` 400s `not_a_service_day`, the datepicker greys the day out, and
the search page shows a shared card they cannot use.

That loses the booking, not just the empty seat. The ride board already solves it: the
traveller starts a list for Thursday and the van runs only if enough names commit. So on
the 5 non-service days the board becomes the offer rather than a dead end.

Under D10 a Thursday Negombo→Sigiriya list prices at **$27.49** — the same as the Wednesday
seat. One price, two commitments: *Wed & Sat you buy a seat; other days you start a list
and it runs if it fills.*

This is only possible because `corridorFor()` (§4) keeps the board's matching broad while
`sharedOption()` narrows. Legs leaving the shared catalogue stay poolable.

### 7.0.1 The three handoff points

| Surface | Today | After |
|---|---|---|
| `search.js` shared card | shows a Wed/Sat card whatever date is picked | Wed/Sat → card as now. Other days → matching board lists, or a start-a-list CTA if none. Private transfer stays alongside either way. |
| `bookings.ts:470` `not_a_service_day` | *"Pick one of those days, or book it as a private transfer."* | adds the board as a third option instead of a dead end |
| `booking.js` datepicker | non-service days greyed out for shared | selectable, with a board handoff rather than a block |

Search's `date` is frequently blank ("Flexible date"). Blank is **not** treated as a
non-service day: show the scheduled card and any pooled lists together, and let the
traveller choose.

**Matching already works.** `GET /board?from=&to=` filters on place name, trimmed and
lowercased (`api/src/db/postgresRideListRepo.ts:110`). Search holds `fromP.name` /
`toP.name`; the board stores `placeName(id)`. Both resolve from the same `PLACES[].name`,
so `"Colombo Airport (CMB)"` matches exactly. No id mapping, no new endpoint.

- **Directional** — an Ella→Mirissa list never shows on a Mirissa→Ella search.
- **Deep-linkable** — `board.html#/<code>` already opens a list's detail sheet
  (`board.js:1494`), so the CTA is a plain link.
- **Skipped for engine routes** — a Google-picked place can never have a list.

### 7.1 Placement and behaviour

A block **below** the private/shared `opt-grid` (`search.js:365`): *"2 travellers are
already going this way"* — stacked avatars, `3 of 4 names`, date, seat price, link.

Below rather than inside, because the grid means *what you buy* while this means *who else
is going*; it also collapses to nothing when empty and renders late without reflowing the
prices the traveller came for.

The `noShare` panel (`search.js:349`) gains the most — after step 1 it will be shown on 27
more pages, and it currently states a falsehood whenever someone is pooling that route.

- **Dates.** Search's `date` is often blank. Fetch without a date filter and sort exact
  matches first; filtering to the exact date leaves the block empty almost always.
- **Failure is silent.** On error, render nothing and report via the existing `report()`
  path. Search must never block on the board.
- Do **not** route through `ch-pricing.js` `estimate()` — it tracks a single intent and
  concurrent calls orphan each other. A plain `fetch` is independent.

---

## 8. Known gap, deliberately not fixed here

Per D1, a scheduled van runs only if it fills — but `POST /bookings/shared` creates a real
booking and takes `amountDueNow` at book time, and `terms.html` §7 defines no cancellation
rule for a shared seat (already logged in `docs/known-bugs.md`). There is no shared
equivalent of `rideBoardCutoff`'s call-off-and-refund path.

Not customer-live at the apex (still WordPress), but it should be scheduled **before the
WordPress cutover**.

---

## 9. Testing

Red-then-green throughout.

1. **Coverage, must fail first:** `sharedOption()` returns `null` for every reverse leg
   (`kandy→cmb-airport`, `sigiriya→negombo`, …) and for every non-catalogue pair
   (`weligama→mirissa`, `cmb-airport→negombo`, …). Exactly the five catalogue legs return
   an offer.
2. **The board is not narrowed:** `corridorFor()` still resolves every adjacent pair, so
   `pairCorridor()` coverage is unchanged.
3. **Prices:** each of the five equals its catalogue value, on both front end and backend
   — extends `web-tests/unit/backend-price-parity.test.js`, the anti-drift guard.
4. **Generated output:** exactly 5 of 44 trip pages contain a shared chip (§5.1 — three
   catalogue legs have no page); no page title or FAQ mentions a shared seat without one;
   **no page anywhere contains the string "Wed & Sat"**. `pricing-codegen.test.js` stays
   green and `npm run generate` is idempotent.
4b. **Service days unchanged:** `POST /bookings/shared` still 400s `not_a_service_day`
   outside Wed & Sat, and each catalogue leg reports its own departure time rather than the
   corridor's. Existing guards must stay green.
5. **Booking:** `POST /bookings/shared` prices per product; a non-catalogue pair 400s with
   `not_a_shared_route`.
6. **Board:** a catalogue leg persists the catalogue price and makes **no** distance call;
   an off-catalogue leg still uses `seatPriceForDistance`.
7. **Step 3 — matching:** match / no-match / reverse-direction; blank-date sorting; a
   failing `/board` leaves search fully functional; CTA href is `board.html#/<code>`.
8. **Step 3 — handoff:** a Wed/Sat date renders the scheduled card; a Thursday renders the
   board offer and **no** unusable shared card; a blank date renders both. A Thursday
   catalogue leg quotes the same price as the Wednesday seat (guards the §7.0 promise).
9. **Step 3 — no dead ends:** `not_a_service_day` carries a board option; the datepicker
   no longer blocks non-service days.

Gates: `cd api && npm run check`, and `npm run test:all` from `web-tests/`.

### 9.1 Open items

All blocking inputs are in. Outstanding, none blocking:

**Assumed prices** (§1.2) — both default to the product's single published price, matching
how the live Mirissa/Weligama page treats its two pickup points. A one-line change if wrong:

- CMB → Sigiriya at $27.49
- Mirissa/Weligama → Colombo at $29.99 (a shorter leg than the airport, so it may warrant
  its own price)

**Owner decisions deferred, not lost:**

- Landing pages for the three sellable legs that have none (§5.1) — needs new
  `route-content.json` copy.
- CMB/Negombo → Kandy: physically possible on the same van, no marketed product, no price
  (§1.2).
- Porting "free cancellation up to 10 days before departure" into `terms.html` §7 (§1.3,
  §8) — the policy exists on WordPress and is absent from the new stack.
- **Outside this repo:** WordPress still sells daily departures and must be reduced to
  Wed & Sat (§1.0). It is the live booking surface.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| 27 indexed pages stop offering a shared seat — a real SEO change. | They advertise services that do not run; the exposure is the status quo, not the fix. Titles/descriptions become accurate private-transfer copy. |
| Negombo→Sigiriya rises $19 → $27.49 (+45%) on a live page. | Owner-supplied actual price; the site is currently underselling it. |
| `seedCorridors()` upserts at boot, so `south-airport` reaches staging on merge. | Same auto-apply property as migrations. Flagged for explicit sign-off; verify on staging before promoting. |
| Removing `yala-mirissa` leaves Ahangama with no shared mention. | Confirmed discontinued (D9). Noted in case Ahangama needs separate copy. |
| Generated files (`trip/*`, `routes-data.js`) are stop-and-ask. | Nothing hand-edited; all output flows from `npm run generate`. |
| Existing `shared_request` rows on withdrawn routes. | Not checked — `api/.env` `DATABASE_URL` points at **prod** and was not queried. Withdrawal stops new bookings; existing ones are untouched and still render in ops. |
