# Per-pair seat pricing for shared corridors

Status: design, awaiting owner approval. Not implemented.

## 1. Problem

Shared seats are priced per **corridor**, not per journey. `CORRIDOR_ROUTES` in
`api/src/db/departureRepo.ts` gives each corridor one flat `seat` price, and a seat exists
between *any* two stops on that corridor at that price:

```
airport-cultural:  Colombo Airport (CMB) → Colombo city → Negombo → Sigiriya / Dambulla → Kandy   $19/seat
```

That one number covers all 10 stop-pairs. The owner wants **Colombo Airport ↔ Sigiriya at
$27.49** while the other nine pairs stay at **$19**. The model cannot express this: there is
no per-pair price anywhere in the system.

This is a base-price change, not a discount. It is unrelated to
`2026-07-15-discounts-design.md`, which excludes shared seats from promotions (§7.1, §7.5)
and only ever reduces a price.

## 2. Goals and success criteria

- A named stop-pair on a corridor can carry its own seat price; every other pair on that
  corridor keeps the corridor price.
- `Colombo Airport (CMB) ↔ Sigiriya / Dambulla` prices at **$27.49** in both directions, on
  the website and in the API, and the two agree.
- The other nine `airport-cultural` pairs still price at **$19** and stay bookable.
- A booking cannot obtain the cheaper corridor price for an overridden pair by omitting
  `from`/`to`.
- One corridor still means one vehicle and one seat pool. Seat inventory is unchanged.
- No DB schema change and no migration.

## 3. Confirmed owner decisions

| # | Decision |
|---|---|
| D1 | Only `Colombo Airport (CMB) ↔ Sigiriya / Dambulla` is repriced. |
| D2 | The price is **$27.49** per seat. |
| D3 | Symmetric — same price in both directions. |
| D4 | The other nine pairs on `airport-cultural` remain at $19. |
| D5 | Repricing the whole corridor was considered and rejected. |
| D6 | Persisting the travelled pair on bookings is deferred (needs a migration). |

## 4. Scope

### 4.1 In scope

- An optional per-pair override list on `CorridorRoute`, resolved symmetrically.
- A resolver used by the booking path, the quote path, and the codegen payload.
- Website mirror of the overrides, so quoted price equals charged price.
- Rejecting a booking that cannot identify its pair on an overridden corridor.
- Tests and the parity guard.

### 4.2 Out of scope

- Persisting `from`/`to` on shared bookings (see §10 Follow-ups).
- Direction-specific pricing (D3 makes overrides symmetric).
- Per-pair pricing for any corridor other than `airport-cultural`. The mechanism is
  general; only one override is configured.
- Distance-derived or per-km shared pricing.
- Shared discounts, promotions, or psychological finishing — all excluded by
  `2026-07-15-discounts-design.md` and unchanged here.

## 5. Pair identity

`2026-07-15-discounts-design.md` §5.1 states that matching "must not depend on free-text
place labels". Shared corridors satisfy that principle differently from private routes, and
the distinction matters.

A corridor stop is **not** free text. `CORRIDOR_ROUTES[].stops` is a closed list in code,
and `corridorIdForRoute()` already resolves a corridor by exact, case-insensitive,
trimmed name match against it. A request whose `from`/`to` do not match a stop name
resolves no corridor at all and is rejected `unknown_corridor` — it fails **closed**. Within
the shared model the stop name is therefore already the canonical identifier, and a
`corridorId` is the only alternative identity the system stores.

Overrides are keyed on **the same normalized stop names**, using the same comparison as
`corridorIdForRoute()`. This introduces no new identity scheme and no new failure mode.

Known coupling, called out deliberately: the backend catalogue holds place **names**
(`'Sigiriya / Dambulla'`) while `transfers-data.js` keys corridors by place **ids**
(`'sigiriya'`). The two lists are maintained in parallel and already must agree; the comment
above `CORRIDOR_ROUTES` says so. They are bridged by the website's `PLACES` table, whose
`name` for each id is exactly the backend stop name — that correspondence is what makes
`booking.js` posting a place name resolve server-side at all. It is load-bearing but
currently unasserted for override pairs, so the parity test in §9 must cover them.

## 6. Data model

`CorridorRoute` gains one optional field. Nothing else changes.

```ts
interface SeatOverride {
  between: [string, string]; // two stop names from this corridor's `stops`, any order
  seat: number;              // USD per seat for this pair
}

interface CorridorRoute {
  id: string;
  stops: string[];
  seat: number;              // corridor default, unchanged
  days: number[];
  seatOverrides?: SeatOverride[];
}
```

Configured value:

```ts
{ id: 'airport-cultural',
  stops: ['Colombo Airport (CMB)', 'Colombo city', 'Negombo', 'Sigiriya / Dambulla', 'Kandy'],
  seat: 19,
  days: SHARED_SERVICE_DAYS,
  seatOverrides: [{ between: ['Colombo Airport (CMB)', 'Sigiriya / Dambulla'], seat: 27.49 }] }
```

`seat` stays whole-USD for every corridor. `seatOverrides[].seat` is the first non-whole
price in the catalogue; `27.49 * 100` is exactly `2749` in IEEE-754, so the existing
`seat * 100` conversion to minor units stays integer-safe. The resolver asserts this rather
than assuming it (§9).

### 6.1 Why this shape

The corridor catalogue already keeps `stops` and `days` **in code** while the DB `corridor`
table stores only endpoints/price/capacity; `serviceDaysForCorridor(id)` resolves schedule
from code with a fallback. Overrides follow that established precedent exactly, which is
what keeps this off the migration path.

## 7. Resolver

One function, in `departureRepo.ts` beside `serviceDaysForCorridor`:

```ts
export function seatUsdForPair(corridorId: string, from: string, to: string): number | null
```

- Normalizes `from`/`to` exactly as `corridorIdForRoute` does.
- Returns the override `seat` when both names match an override's `between` in either order.
- Returns `null` when the corridor has no override for that pair, meaning "use the corridor
  price" — the caller keeps reading `corridor.seatPrice` from the DB.
- Returns `null` for an unknown corridor id.

Returning `null` rather than the corridor default keeps the DB price authoritative for the
normal case (`bookings.ts:359` — "the corridor DB price is authoritative") and confines this
change to the exception.

### 7.1 Rejected alternative: a second corridor

Adding `airport-sigiriya: [CMB, Sigiriya] @ 27.49` ahead of `airport-cultural` would work
for price lookup, since both front-end and backend return the first corridor carrying both
stops. It is rejected because seat inventory is keyed by corridor:
`shared_departure (corridor_id, date, time, seats_total, seats_booked)`. A second corridor
gets its own `seats_total`, so the same physical 12-seat van would be sold up to 24 times —
12 on each corridor — with neither departure aware of the other. It also silently removes
`Negombo ↔ Sigiriya`, `Colombo city ↔ Sigiriya` and `Sigiriya ↔ Kandy` as shared options,
because `sharedOption()` requires both stops on one corridor.

## 8. Behaviour changes

### 8.1 Booking (`api/src/routes/bookings.ts`)

Today the corridor resolves from `corridorId`, or from `from`/`to` when absent, and price
comes from `corridor.seatPrice`.

New rule, in order:

1. Resolve the corridor as today.
2. If the resolved corridor has `seatOverrides` **and** the request lacks `from`/`to`,
   reject `400 pair_required` before holding seats. Without this a client books
   `corridorId: 'airport-cultural'` alone and pays $19 for the airport run.
3. Otherwise compute `seatUsd = seatUsdForPair(corridor.id, from, to)`; price with
   `seatUsd * 100` when non-null, else `corridor.seatPrice`.

`SharedBookingRequest.from/to` stay optional in the schema — they remain genuinely optional
for corridors without overrides. The requirement is conditional on the resolved corridor,
enforced in the route, and covered by a test. This avoids a breaking interface change for
every other corridor.

The rejection is ordered **before** `holdSeats` so a rejected request never touches
inventory, matching the existing `not_a_service_day` ordering.

### 8.2 Website (`transfers-data.js`)

`sharedOption(fromId, toId)` returns `seat: c.seat` today. It gains an override lookup that
resolves each id to its `PLACES` **name** and compares against the emitted override names,
returning the override seat when the pair matches in either order, else `c.seat`.

The website is the side that already owns the id↔name mapping: every `PLACES` entry carries
a `name` that is exactly the backend stop name (`sigiriya` → `'Sigiriya / Dambulla'`,
`cmb-airport` → `'Colombo Airport (CMB)'`, and so on). Resolving on the website therefore
needs no new mapping anywhere.

### 8.3 Codegen (`pricingPayload.ts` → `tools/generate-pricing.mjs`)

`corridorSeat: Record<string, number>` (corridorId → whole USD) cannot express a pair
price. Add a sibling rather than changing its shape, so existing consumers are untouched:

```
CORRIDOR_PAIR_SEAT = { "airport-cultural": [{ "between": ["Colombo Airport (CMB)","Sigiriya / Dambulla"], "seat": 27.49 }] }
```

Overrides are emitted using backend stop **names**, not front-end place ids. The backend has
no knowledge of the website's place ids, and inventing a backend-side id map purely for
codegen would create a second identity scheme — exactly what §5 avoids. Names are already
the shared vocabulary across the wire: `booking.js` posts the place name, and
`corridorIdForRoute()` matches on it. The website resolves ids to names locally (§8.2).

`CORRIDOR_SEAT` keeps its current shape and values. Emitted into the existing
`@generated: pricing` block via `npm run generate`; never hand-edited.

### 8.4 Quote path

`routes/quote.ts` accepts `seatPriceCents` from the client (`z.number().int()`) and
`quoteSharedLegs` multiplies it. This spec does not change that; server-authoritative shared
quoting is the subject of the separate `docs/server-authoritative-pricing` work. The booking
path (§8.1) is authoritative and is where the override is enforced, consistent with the
existing GL-3 comment that the client's `quotedTotal` "is never stored, only compared and
flagged when it disagrees".

## 9. Testing

Red first, per the contract.

**Unit — resolver**
- `CMB ↔ Sigiriya` returns `27.49` in both orderings.
- Each of the other nine `airport-cultural` pairs returns `null`.
- Case/whitespace variants of the stop names resolve identically.
- Unknown corridor id returns `null`.
- `Math.round(27.49 * 100) === 2749` and `Number.isInteger(27.49 * 100)` — pins the
  minor-units invariant rather than trusting it.

**Unit — booking**
- `corridorId: 'airport-cultural'` with no `from`/`to` → `400 pair_required`, and
  `holdSeats` is never called.
- `from: 'Colombo Airport (CMB)', to: 'Sigiriya / Dambulla'`, 2 seats → total `5498` cents.
- `from: 'Negombo', to: 'Kandy'`, 2 seats → total `3800` cents (unchanged).
- A corridor without overrides still books with `corridorId` alone (no regression).

**Unit — website**
- `sharedOption('cmb-airport','sigiriya').seat === 27.49`, both orderings.
- `sharedOption('negombo','sigiriya').seat === 19`.

**Parity guard** (`web-tests/unit/backend-price-parity.test.js`)
- Every emitted override name resolves to exactly one `PLACES` entry, so the website can
  always map it back to an id. This is the test that catches the name↔id drift in §5.
- Every emitted override name is one of the stops on that corridor in the website's own
  `CORRIDORS` definition — catching an override that silently matches nothing.
- The website's resolved seat for `cmb-airport ↔ sigiriya` equals the backend's resolved
  seat for `'Colombo Airport (CMB)' ↔ 'Sigiriya / Dambulla'`.

**Codegen** — `npm run generate` produces no drift; the CI `codegen-fresh` job passes.

**Inventory** — booking the overridden pair decrements the same `shared_departure` row as
any other `airport-cultural` pair. This is the regression guard for §7.1.

## 10. Rollout and follow-ups

This is a live price change. `main` deploys the API to Render and the site to Pages, so it
ships only on the owner's explicit go.

No migration. The DB `corridor` row for `airport-cultural` keeps `seat_price = 1900` as the
corridor default; `seedCorridors` upserts it unchanged at server start. The override lives
in code and activates on deploy. Front-end and API deploy from the same commit, so the
quoted and charged price change together.

Rollback is reverting the commit and redeploying; no data is written that would survive it.

Follow-ups, deliberately not in this spec:

- **Persist the travelled pair on shared bookings.** `SharedInput` stores only
  `corridorId`, which is why the customer-safe booking view shows literal `'Pickup'` /
  `'Drop-off'` placeholders (`bookings.ts:133-134`). Fixing that needs a schema change and
  a migration, and would also let reporting attribute revenue per pair.
- **Server-authoritative shared quoting**, tracked by `docs/server-authoritative-pricing`.
- **`#add-stay` in `plan.js:341`** has no element in `plan.html`; harmlessly guarded, but
  dead wiring. Unrelated to pricing; noted while reading the area.
