# M11 — Quote Engine Spec

**Status: APPROVED (design).** Companion to [`quote-engine-worked-examples.md`](./quote-engine-worked-examples.md)
(the validated rate card + real-quote evidence). This doc is the engineering design; the
step-by-step build lives in the implementation plan.

---

## 1. Purpose & what it is

A single, **server-authoritative** pricing engine that turns a trip description into a priced quote.
It is the one place pricing lives, and it serves four surfaces:

1. **Website** real-time quotes (booking flow)
2. **Internal manual quoting tool** — a read-only calculator for WhatsApp leads (ops reads the
   number and copy-pastes it; no automation, no payment link)
3. **Ops dashboard** — display/recompute a booking's price
4. **Booking-time anti-tamper validation** — recompute on the server, reject a manipulated total

It is **pure pricing**: given a trip + distances, it returns money. It does **not** fetch distances,
send messages, or take payment.

> **Shipped state of *this* increment:** only the engine + `POST /quote` are built. None of the four
> surfaces above are wired yet — the website still prices with its frozen formula, bookings still use
> the legacy passthrough, and the internal tool / ops dashboard are separate future work. The list
> above is what the engine is *designed* to serve, not what ships first.

---

## 2. Source-of-truth decision — **DECIDED: Option A**

The frozen front-end prices with an older formula than the locked rate card:

| | Frozen `transfers-data.js` (live today) | M11 rate card |
|---|---|---|
| Car | `max($28, 22 + km×0.62)` | `max($29, km×0.46)` |
| Van | `max($38, 30 + km×0.86)` | `max($50, km×0.83)` |

**Decision (approved): Option A — the engine becomes the single source of truth.** The website will
later stop computing locally and call `POST /quote` for its displayed price, via the sanctioned
`window.CEYLON_HOP_API` flag (a *labelled* front-end integration — the allowed exception to the
freeze). Server and client then always agree.

**Sequencing (corrected after architecture review).** Charge authority must NOT move to the engine
until two preconditions hold: **(a)** the website *displays* the engine's number (displayed ==
charged), and **(b)** pricing is *deterministic* — the engine prices on the distance the customer was
shown, not a server re-fetch. (The maps adapter is non-deterministic: dev haversine vs prod Google
differ **14–36%** on real legs, so re-deriving distance server-side would make the "canonical" price
unstable and reject legitimate bookings.) Therefore:

1. **Ship the pure engine + `POST /quote`** — serves the internal quoting tool + ops dashboard. **No
   charge risk** (it only returns prices).
2. **Website-display integration** (a labelled front-end step): the booking page calls `/quote` and
   submits the resolved `distanceKm` / legs it priced on.
3. **Then** booking recompute becomes authoritative — **deterministic**, pricing on the *submitted
   quote request* (§8).

Until step 2 lands, the booking flow keeps its current behaviour **unchanged**; the engine does not
override any charge. (The earlier "charge canonical + log drift while the frozen site shows the old
formula" idea is rejected — it would charge customers a number they never saw.)

---

## 3. Where it lives & constraints

- `api/src/quote/` — new module. Node 20, TypeScript strict, Zod at the edges, Vitest.
- **Money = bare integer cents** (a `number`) + an ISO currency string (`'USD'`), matching the
  existing codebase convention — **no `Money` wrapper object**. No floats in money math. LKR/FX is
  out of scope for v1.
- **Rate card is a versioned code module**, not a DB table — quotes are reproducible and reviewed in
  PRs. A DB/preset-override table is deferred (§11, §13).
- Backend-only; the engine never imports front-end code.

---

## 4. Domain model (types)

```ts
type Vehicle = 'car' | 'van';
type ExtraCode = 'sightseeing' | 'safari-wait' | 'luggage' | 'front' | 'flex';

// ---- Inputs (discriminated by `product`) ----
type PrivateLeg = { from: string; to: string; distanceKm: number };
type SharedLeg  = { routeId: string; seats: number; seatPriceCents: number; colomboPickup?: boolean };
type ChauffeurTravelDay = { date: string; from: string; to: string; distanceKm: number };

type QuoteRequest =
  | { product: 'shared';    legs: SharedLeg[] }
  | { product: 'private';   vehicle: Vehicle; pax: number; bags: number; legs: PrivateLeg[]; extras?: ExtraCode[] }
  | { product: 'chauffeur'; vehicle: Vehicle; firstDate: string; lastDate: string; travelDays: ChauffeurTravelDay[]; extras?: ExtraCode[] };

// ---- Output (every amount is integer USD cents) ----
type LineItem = { label: string; amountCents: number; meta?: Record<string, unknown> };
type QuoteResult = {
  product: 'shared' | 'private' | 'chauffeur';
  currency: 'USD';
  lineItems: LineItem[];        // every charge, itemised
  subtotalCents: number;
  totalCents: number;
  depositCents: number;         // min(10%, $50)
  amountDueNowCents: number;    // chauffeur → deposit; else → total
  marginEstimateCents: number | null;  // total − cost basis (internal/ops only); null for shared (not modelled)
  rateCardVersion: string;      // e.g. "2026-06-28"
  warnings: string[];           // e.g. "leg hit the $29 car minimum"
};
```

Two inputs are **supplied by the caller**, not the engine:
- `distanceKm` — from the website Directions API or ops typing it (a curated distance source is deferred).
- `seatPriceCents` — the shared seat price, read from the corridor/`departureRepo` (the existing source of truth — **not** duplicated into the rate card).

---

## 5. The rate card module

```ts
export const RATE_CARD = {
  version: '2026-06-28',
  currency: 'USD',
  markupPct: 25,

  // sell rates (already include the 25% markup); cost shown for margin reporting
  perKmCents:     { car: 46, van: 83 },
  costPerKmCents: { car: 37, van: 66 },
  floorCents:     { car: 2900, van: 5000 },

  chauffeur: { dayRateCents: 3500, idleMinKm: { car: 100, van: 150 } },

  deposit: { pct: 10, capCents: 5000 },

  vehicle: { car: { maxPax: 3, maxBags: 3 }, van: { maxPax: 6, maxBags: 6 } },

  extras: {                       // server-validated; client cannot set prices
    sightseeing: 1000, 'safari-wait': 1900, luggage: 500, front: 800, flex: 1200,
  },
  shared: { colomboPickupCents: 300 },
} as const;
// No extra-bag charge in v1 — bags drive vehicle selection, not a per-bag fee (deferred).
```

**Shared seat prices are NOT in the rate card** — they live in the corridor/`departureRepo` (the
existing source of truth) and are passed into the engine as `seatPriceCents` per leg. The rate card
holds only the *rates* (per-km, day, floors, deposit, extras, surcharge).

Changing a price = a one-line edit + a PR + golden tests re-run. `version` stamps every quote (true
repricing of an old booking also needs the stored `QuoteRequest` — see §11).

---

## 6. Pricing logic (per product)

**Private leg**
```
legPrice(leg, vehicle) = max( floorCents[vehicle], round(leg.distanceKm × perKmCents[vehicle]) )
```
**Route / multi-stop private** = `Σ legPrice(...)` + `priceExtras(extras)`. A "single transfer" is
just a one-leg route — no separate code path.

**Vehicle used for pricing** = the **larger** of the requested vehicle and `selectVehicle(pax, bags)`
— the client's `vehicle` is **never trusted blindly**: a car requested for 6 pax is priced (and a
warning emitted) as the **required van**, a van upgrade is always allowed, and `too_big` → `TOO_BIG`.
This closes an undercharge/tamper hole.

**Shared** = `Σ ( seatPriceCents × seats + (colomboPickup ? colomboPickupCents × seats : 0) )` —
`seatPriceCents` supplied per leg from the corridor repo. Distance unused.

**Chauffeur**
```
days       = max(1, dateDiff(lastDate, firstDate) + 1)   // dates parsed date-only (no SL-TZ off-by-one)
idleDays   = max(0, days − travelDays.length)
billableKm = Σ travelDays.distanceKm  +  idleDays × idleMinKm[vehicle]
total      = days × dayRateCents  +  round(billableKm × perKmCents[vehicle])  +  extras
```
Idle-day minimum **kept as-is** (owner decision) — you charge for holding the car + driver
regardless of how the customer spends the day. The numeric values live in
`RATE_CARD.chauffeur` (`api/src/quote/rateCard.ts`, version-stamped) — **that is canonical**;
figures quoted in this M11-era doc (e.g. §5) may lag it.

### 6a. Idle days — derivation, naming & customer presentation (annotated 2026-07-10)

**Derivation (quoting tool).** `idleDays` is inferred purely from a **gap in the leg dates** —
any day inside `firstDate..lastDate` with no transfer leg. The old per-leg **"Add stay day"
button was retired**; ops no longer marks stay days explicitly, so idle days fall straight out
of the itinerary dates (see `toEngineRequest` in `api/src/routes/internalQuote.ts` and
`idleDays` in `api/src/quote/chauffeur.ts`).

**Naming is deliberate — "idle day", not "rest" or "sightseeing".** Ops can't know in advance
whether the customer will relax *or* go sightseeing that day, so the quote commits to neither.
The `idleMinKm` charge is the **driver + vehicle availability fee** — they're reserved for the
customer that day no matter what the customer chooses to do.

**Deliberately understated in the customer message (pricing-psychology decision).** The idle
day is folded into the priced totals only:
- it's inside the day count on the `Chauffeur day rate — N day(s)` line, and
- its km appears as `+ N idle-day min` inside the single `Distance — …` line item.

It is **not** rendered as its own itinerary row — there is no `Stay in …` / `Sightseeing …`
line. A day that might just be relaxing should not lead with an expensive-looking line item.
⚠️ **Do not "fix" this by surfacing the idle day more prominently** (adding a stay/sightseeing
itinerary line, renaming "idle-day min", etc.) **without an explicit owner decision** — the
understatement is intentional. The reconciled e2e spec `web-tests/e2e/quote-tool.spec.js` (V1)
asserts exactly this behaviour: no stay line; the rest day charged via day-count + non-zero
idle-day km.

**Extras** = `Σ extras[code]`. Unknown code → `UNKNOWN_EXTRA`. (No extra-bag charge in v1.)
An empty `legs` / `travelDays` request → `NO_LEGS`.

**Deposit** = `min( round(total × deposit.pct / 100), deposit.capCents )`. `amountDueNow` = deposit
for chauffeur, else full total.

**Margin** (`marginEstimateCents = total − cost`) is modelled for **private + chauffeur** only.
**Shared margin is NOT modelled** (no per-seat cost basis), so for shared the engine reports
`marginEstimateCents = total` and emits a `'margin not modelled for shared'` warning — internal/ops
callers must not read shared margin as real.

**Rounding rule:** the buffer rounds km first (`billableKm = round(km × 1.10)`), then the leg price
rounds to whole cents (`round(billableKm × perKmCents)`) — **two rounds**, both deterministic. Because
every caller prices through the engine, client and server always agree (matters for the §8 recompute).
Sums are exact. Documented and tested so it
never drifts.

---

## 7. Vehicle selection

```
selectVehicle(pax, bags):
  car  if pax ≤ 3 and bags ≤ 3
  van  if pax ≤ 6 and bags ≤ 6
  else → 'too_big'
```
On `too_big` the engine **throws `Error('TOO_BIG')`**; the `/quote` route maps it to **422 `TOO_BIG`**
and the website shows a "contact us" prompt. Bigger vehicles (van 9/14, bus, multi-van) are
**internal-tool / manual** only — never auto-priced on the web.

---

## 8. Server-authoritative validation (anti-tamper) — **deterministic, post-display**

Activates **only after** the website-display step (§2). The engine prices on the **inputs the
customer was shown**, never a server re-fetch — because re-deriving distance is non-deterministic
(§2) and would reject legitimate bookings.

1. Booking submits the **full structured QuoteRequest** (legs incl. `distanceKm`, vehicle, dates,
   extras) — the exact object the site priced for display — **plus** the displayed `clientTotal`.
2. Server re-runs `quote(request)` on those **same inputs** → `canonicalCents` (deterministic; equals
   what was displayed, because the inputs are identical).
3. **Total integrity:** `clientTotal` must equal `canonicalCents` (±1¢ rounding). Mismatch →
   reject `QUOTE_TAMPERED` (the total was edited without going through the engine).
4. **Input plausibility (the real anti-tamper):** independently estimate each leg's distance via the
   maps adapter and reject if a submitted `distanceKm` is implausibly low — **< 60% of the server
   estimate** (a generous bound that absorbs the 14–36% source variance while still catching someone
   halving the distance to pay less). Implausible → reject `DISTANCE_IMPLAUSIBLE`.
5. **Charge `canonicalCents`** (which equals the displayed total). Persist the **full QuoteRequest +
   `canonicalCents` + `rateCardVersion`** so the booking is genuinely repriceable (§11).

Error codes are consistent across the engine and the booking route: `TOO_BIG`, `UNKNOWN_EXTRA`,
`NO_LEGS`, `QUOTE_TAMPERED`, `DISTANCE_IMPLAUSIBLE` — all HTTP **422**.

---

## 9. API surface

```
POST /quote
  body:  QuoteRequest (Zod-validated)
  200 →  QuoteResult
  400 →  { error: 'invalid_request', details }        // Zod parse failure
  422 →  { error: 'TOO_BIG' | 'UNKNOWN_EXTRA' | 'NO_LEGS' | 'BAD_REQUEST' }
```
- Same endpoint powers website + internal tool (internal tool also reads `marginEstimateCents` via an
  `x-internal-key` header; the public response omits it).
- Booking validation calls the engine **in-process** (not over HTTP).
- **Rate-limited** (`app.use('/quote', rateLimit)`); `/quote` needs no auth (prices only). The
  `marginEstimateCents` field is gated to callers whose `x-internal-key` header matches
  `config.INTERNAL_QUOTE_KEY` (CORS allows that header); everyone else gets it stripped.
- **Edge validation:** the Zod schema rejects an unknown extra or empty `legs`/`travelDays` at the
  edge → **400 `invalid_request`**. So the engine's `UNKNOWN_EXTRA`/`NO_LEGS` **422** only fires for
  *in-process* callers (defense-in-depth); over HTTP those surface as **400**.

---

## 10. Testing strategy (TDD)

- **Golden cases** — every customer in the worked-examples doc + the 10 Notion leads becomes a unit
  test: `quote(request) === expectedTotal`. Locks the engine to validated numbers.
- **Floor tests** — short legs hit `$29 / $50`; just-above legs don't.
- **Chauffeur tests** — idle-day math **+ the 10% travel-km buffer** (Emma → **$903.80**, Ayan → **$340.98**; the $867 / $323.50 figures are the *pre-buffer* values — buffer/waiting/FX are added in plan Tasks 10–14, which this §10 predates).
- **Deposit tests** — cap vs percentage boundary ($500 → $50; $400 → $40).
- **Property tests** — `total ≥ Σ floors`; `deposit ≤ cap`; money never negative; rounding stable.
- **Tamper tests** (follow-up plan, §8) — `clientTotal ≠ canonicalCents` → `QUOTE_TAMPERED`; a submitted
  `distanceKm` below 60% of the maps estimate → `DISTANCE_IMPLAUSIBLE`; matching inputs → charge canonical.

---

## 11. Versioning & reproducibility

A version string alone is **not** enough to reprice a booking — you also need the inputs and the card
body. So reproducibility requires all three:
- `RATE_CARD.version` stamped on every quote.
- The **full `QuoteRequest`** (legs incl. resolved `distanceKm`, vehicle, dates, extras) persisted on
  the booking — add a `quoteRequest` JSONB column (the current schema stores only `total` + booking
  input, which is insufficient). Done at the recompute step (§8), not the engine step.
- A `RATE_CARDS[version]` registry once a second version ships; until then there is exactly one card.

(Without the persisted `QuoteRequest`, "reproducible" is a hollow claim — flagged in review.)

---

## 12. Open data dependencies (config values — do not block the engine build)

- **Shared seat table** — canonical per-corridor seat prices.
- ~~**Loop passes** as named products~~ — **DROPPED 2026-07-11:** loops are multi-stop trips, engine-priced, not a named product.
- **Tiered vs flat shared seat** (Anna's $19.50/$17.50/$16.50).
- **Manual discount/override** field — competitive quotes (Pauline).

Scaffolded as config with placeholders + warnings; ops fills in the values.

---

## 13. Out of scope for v1 (deferred)

Curated common-routes distance/price table · preset-price & manual-override table · long-trip taper ·
per-day km cap · LKR/FX · WhatsApp automation / payment-link from the internal tool · vehicles bigger
than van.

---

## 14. Build phases (re-sequenced after review)

**This plan (safe to build now — no charge change):**
1. **Types + rate card module** (no logic) — compiles, exported.
2. **Pricing functions** TDD against golden cases — vehicle → private → shared → chauffeur → extras →
   deposit → `quote()` dispatcher.
3. **`POST /quote`** endpoint + Zod + consistent errors. Serves the internal tool (margin-aware via
   header) + ops dashboard. **Nothing is charged.**

**Follow-up plan (separate — touches the frozen front-end + charge authority):**
4. **Website-display integration** (labelled): booking page calls `/quote`, submits resolved
   `distanceKm` / legs. *Display now equals the future charge.*
5. **Deterministic booking recompute** (§8): price on the submitted request; total-integrity +
   distance-plausibility checks; persist the `QuoteRequest`; charge canonical. Retire the legacy
   `pricing.ts` stubs here.

**Explicitly NOT auto-charged on the web yet:** chauffeur (needs a per-day itinerary structure + the
manual discount/override field, and knowingly runs 15–30% above historical hand-quotes — see §13).
