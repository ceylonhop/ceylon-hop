# Promo codes for website bookings — backend design

**Date:** 2026-09-14
**Status:** design approved by the owner section by section, 2026-09-14. Build not started.
**Phase:** backend only. The website field, the ops management screen and customer-facing
discount wording are deliberately later phases (§10).
**Related:**
- [`2026-08-09-founder-manual-discounts-design.md`](./2026-08-09-founder-manual-discounts-design.md)
  — shipped. This design **reuses its arithmetic unchanged** (`api/src/quote/discount.ts`).
- [`2026-07-15-discounts-design.md`](./2026-07-15-discounts-design.md) — the full promotions
  design (versioned rules, automatic promotions, route/tour scope). This document is a
  **deliberately narrower** alternative for codes only. Where the two disagree on promo codes,
  this document governs; everything else in the parent (automatic promotions, scoping, versioning)
  stays unbuilt and undecided.

## 1. Problem

The owner wants to hand out discount codes: a code, how many times it can be used, how much it
takes off, and when it starts and stops working. Customers will enter it on the website.

Nothing like this exists. The only discount today is a founder's manual discount on an ops quote.
The public booking routes (`POST /bookings/single`, `/bookings/trip`) price with the engine and
accept no discount at all.

The owner asked for the backend to be built and fully tested before any website change.

## 2. Owner decisions (2026-09-14)

| Question | Decision |
| --- | --- |
| Where codes are used | The website — but backend first, fully tested, before `booking.html` changes |
| What a code can take off | A percentage or a fixed dollar amount (the ops discount's two methods) |
| Extra options | A **start date**. No minimum spend, no per-code dollar cap |
| Limits on the discount | The ops discount's two limits, unchanged: 30% ceiling and the vehicle minimum fare |
| A code that the minimum cuts to $0 | The code "doesn't apply to this trip" and **no use is taken** (worked example, §4.3) |
| When a use counts | **Hold, then count when paid.** A booking holds a use for 2 hours; paid = counted for good; unpaid past the hold = freed |
| Per-customer limit | **None.** Total uses only |
| Build shape | Approach A: a `promo_codes` table; uses **counted from bookings**, never stored as a counter |

## 3. Scope

### 3.1 In this build

- A `promo_codes` table and founder-only API to create, list, inspect and change codes.
- Optional `promoCode` on `POST /bookings/single` and `POST /bookings/trip`.
- A hold re-check on `POST /bookings/:id/checkout`.
- A read-only discount preview on `POST /quote/v2/estimate`.
- A rollout flag, `PROMO_CODES_ENABLED`, default off.

### 3.2 Not in this build (§10)

- The code field in `booking.html` and the discount in the booking summary.
- An ops screen for managing codes.
- "Code SUMMER10: −$8" wording in the confirmation email and on the manage page.
- Codes on ops quotes or pay links.
- Per-customer limits, minimum spend, per-code dollar caps, automatic promotions, route/tour scope.

## 4. What a code is

### 4.1 Settings

| Setting | Rule |
| --- | --- |
| Code | 3–32 characters of `A–Z`, `0–9`, `-`. Input is trimmed and upper-cased, so `summer10` matches `SUMMER10`. **Unique forever**, including switched-off codes, so a code name never means two things in the history |
| Method | `percentage` or `fixed` |
| Value | Percentage: basis points, **100–3000** (1%–30%). A code above 30% is refused at creation, not silently capped later. Fixed: cents, **> 0** |
| Start | Optional `starts_at`. Absent = works from creation |
| Expiry | Required `expires_at`, strictly after `starts_at` when a start is given |
| Maximum uses | Required integer ≥ 1 |
| On/off | `active`, default on |
| Audit | `created_by`, `created_at`, `updated_by`, `updated_at` (staff email, timestamps) |

After creation only **expiry, maximum uses and on/off** may change. The code, method and value are
fixed: bookings refer to the code, and changing its discount would make history misleading. To
change a discount, switch the code off and create a new one.

Lowering maximum uses below the current count is allowed. Nothing already held or paid is revoked;
the code simply accepts no more.

### 4.2 When a code works

A code **works now** when all hold: `active` is true, `starts_at` is null or `starts_at <= now`, and
`now < expires_at` (start inclusive, expiry exclusive).

### 4.3 What it takes off

The discount is resolved by the existing `resolveDiscount()` against the **finished quoted total**,
with the engine's protected minimum (one vehicle minimum per leg; 0 for chauffeur). Extras are
included, exactly as for a founder discount. So a code is limited by:

- the 30% ceiling (`MAX_DISCOUNT_PCT`), and
- the vehicle minimum fare ($29.00 car, $49.99 van, per leg).

Worked examples the owner approved (one-leg car, protected minimum $29.00):

| Quoted | Code | Requested | Applied | Customer pays | Outcome |
| --- | --- | --- | --- | --- | --- |
| $80.00 | 10% | $8.00 | $8.00 | $72.00 | Discounted |
| $35.00 | 20% | $7.00 | $6.00 | $29.00 | Discounted, limited by the minimum |
| $29.00 | 10% | $2.90 | $0.00 | — | `promo_code_not_eligible`, no booking, no use |

A code applies only to **private transfers and trips (private or chauffeur)**. Shared seats are not
eligible. A booking the engine cannot price (unresolved or estimated distance) is not eligible: the
code is refused and the customer may book without it.

### 4.4 Customer-facing errors

Stable error codes, shared by every route in §6:

| Code | Meaning |
| --- | --- |
| `promo_code_invalid` | Unknown, switched off, malformed, or the flag is off. One code for all four, so a switched-off code is indistinguishable from a guess |
| `promo_code_not_started` | Exists and is on, but `now < starts_at` |
| `promo_code_expired` | `now >= expires_at` |
| `promo_code_used_up` | Every use is paid or held |
| `promo_code_not_eligible` | Shared seat, unpriced booking, or the limits reduce it to $0 |

## 5. How uses are counted

### 5.1 The rule

Uses are **never stored as a counter**. They are counted from bookings on demand. A booking with
`promo_code_id = code.id` **uses** the code when either:

1. **It was paid:** a `payments` row for it has `status = 'succeeded'`, **or** its status is one of
   `paid`, `confirmed`, `in_progress`, `completed`, `refunded`, `no_show`; or
2. **It is held:** its status is `draft`, `payment_pending` or `awaiting_details`, and
   `promo_hold_until > now`.

Consequences, each covered by a test (§9):

- A paid booking that is later cancelled or refunded **still counts** (clause 1, via its payment).
- A booking cancelled **before** payment stops counting immediately (it matches neither clause).
- An unpaid booking whose hold has passed stops counting, with no clean-up job.

**Why payments and not a stamp on status change:** `PostgresPaymentSettlementRepo` moves a booking
to `paid` with its own `UPDATE`, not through `BookingRepo.setStatus`. A stamp written in
`setStatus` would miss production's main payment path. Both paid paths — PayHere settlement and the
founder's manual mark-paid (`markSucceededManually`) — leave a succeeded payment row, so clause 1
covers both.

### 5.2 The hold

`PROMO_HOLD_MS = 2 hours`, a code constant (not configuration). The hold is set when the booking is
created and **refreshed to `now + 2h` when checkout starts** (§6.3), which covers the PayHere session.

### 5.3 No overselling

Whenever a use is **taken** (booking creation, checkout re-hold), the count and the write happen in
one Postgres transaction that first locks the code's row with `SELECT … FOR UPDATE` — the same
pattern `PostgresQuoteRepo` uses for revision snapshots. Concurrent customers for the last use are
serialised, and exactly `max_uses` succeed.

**Known, accepted edge:** the limit can be exceeded by one only if a customer starts payment, their
hold lapses because they sit on the PayHere page for more than 2 hours, someone else takes the freed
use, and the first customer then completes payment. Money already taken is always honoured, so that
booking is not refused. This needs a two-hour abandoned-then-resumed payment racing a second
customer for the last use, and is accepted rather than designed around.

## 6. Where it plugs in

### 6.1 `POST /bookings/single` and `POST /bookings/trip`

`promoCode` is read from the raw body by a `promoCodeFrom(body)` helper, the same way `billingFrom`
and `termsAcceptedAt` already are. `SingleTransferInput` and `TripInput` are **not** changed.

Order of operations, after the existing validation and idempotency early return:

1. If `promoCode` is present: flag off → `promo_code_invalid`. Look up the normalised code and check
   §4.2, failing fast **before** any Maps call.
2. Price with the engine, passing the code's discount (§7).
3. Unpriced, or applied discount of 0 → `promo_code_not_eligible`.
4. Create the booking with the discounted `total` and `amountDueNow`, `discount_total` = applied
   cents, `promo_code_id`, and `promo_hold_until = now + 2h`. Inside the booking transaction, lock the
   code row, recount (§5.1), and refuse with `promo_code_used_up` if full. Re-check §4.2 under the
   lock too, so a code switched off mid-request is not honoured.

All code errors on these routes return **422** and **create no booking**.

**Idempotency:** a retry with the same `Idempotency-Key` returns the existing booking before
pricing, so it never takes a second use. Two submissions *without* a key are two bookings and two
holds, exactly as duplicate bookings behave today.

**Price-mismatch alert:** today the site sends `quotedTotal` without any discount. So that a code
booking does not raise a false ops alert, the mismatch check (`resolveTotals`/`flagPricing`) treats
the site's figure as matching when it is within tolerance of **either** the discounted total **or**
the total before discount. The second arm keeps working once the website sends the discounted figure.

### 6.2 `POST /bookings/shared`

A present `promoCode` → **422** `promo_code_not_eligible`, no booking.

### 6.3 `POST /bookings/:id/checkout`

Runs only when the booking has a `promo_code_id`, after the existing status and `needsPricing`
checks. In one transaction with the code row locked:

| Situation | Result |
| --- | --- |
| Hold still valid | Refresh hold to `now + 2h`; proceed — **even if the code has since expired or been switched off** (the booking was made in good faith) |
| Hold lapsed, code works (§4.2) and a use is free (counting uses **other than** this booking) | Re-hold to `now + 2h`; proceed |
| Hold lapsed, code switched off | **409** `promo_code_invalid` |
| Hold lapsed, code expired or not started | **409** `promo_code_expired` / `promo_code_not_started` |
| Hold lapsed, code full | **409** `promo_code_used_up` |

A refused booking stays unpaid and, with its hold lapsed, stops counting. The customer rebooks. The
check runs **regardless of `PROMO_CODES_ENABLED`**: the flag gates creating, never honouring (the
same rule as `OPS_MANUAL_DISCOUNTS_ENABLED`).

### 6.4 `POST /quote/v2/estimate`

`WebQuoteIntentSchema` is `.strict()`, so the route removes a top-level `promoCode` from the body
**before** parsing the intent. With a code, the response adds either:

- `promoCode: { code, discountCents, totalBeforeDiscountCents, totalCents }`, or
- `promoCode: { error: <§4.4 code> }`, alongside the normal undiscounted price.

The preview checks §4.2, eligibility and whether a use is currently free, with a plain read and **no
lock**. It **never holds a use** and writes nothing. A code that previews fine can still be
`promo_code_used_up` at booking.

`/quote/v2/lock` and `PUT /quote/v2/:id` are **unchanged**: the website books through
`/bookings/single|trip`, not the quote-lock path.

### 6.5 Founder API: `/admin/promo-codes`

Mounted with `opsIdentity` + `requireCap('promo_codes:manage')`, the CSRF allowed-origins guard on
mutations (as `/admin/quote`), and its own rate limiter (no general `/admin/*` limiter exists).

| Route | Behaviour |
| --- | --- |
| `POST /admin/promo-codes` | Create (§4.1). 400 invalid; 409 `code_taken`; 403 `promo_codes_disabled` when the flag is off |
| `GET /admin/promo-codes` | All codes, newest first, each with `uses: { paid, held, remaining }` and whether it works now |
| `GET /admin/promo-codes/:id` | One code, plus the bookings that used it: reference, status, applied discount, created at, and `paid` / `held` / `released` |
| `PATCH /admin/promo-codes/:id` | Change `expiresAt`, `maxUses`, `active` only. Any other field → 400. Records `updated_by`/`updated_at`. **Allowed with the flag off**, so switching a code off always works |

`promo_codes:manage` is a new capability granted to **founder only**, the same class as
`discount:apply_manual`.

## 7. Engine change

`DiscountRequest` in `api/src/quote/discount.ts` widens its `source` literal from `'manual'` to
`'manual' | 'code'` on both arms. `resolveDiscount()` is otherwise **unchanged**: same arithmetic,
same limits. The route sets `reason` to `promo code <CODE>` for a code, so `ResolvedDiscount` keeps
its shape. The undiscounted path stays byte-identical, and `goldens.test.ts` proves it.

`priceSingle` and `priceTrip` (`api/src/services/pricing.ts`) take an optional `DiscountRequest`,
pass it to `quote()`, and add `discountCents` and `totalBeforeDiscountCents` to the priced arm of
`PriceOutcome` when a discount was applied.

## 8. Storage

### 8.1 Migration `0050`

> **Release note:** merging this to `main` applies it to **staging** on boot; it reaches **prod**
> only through a `main → production` promote. It is additive: no existing column changes meaning.

- `CREATE TABLE promo_codes` with the §4.1 columns, and checks for: code format, method, percentage
  100–3000, fixed > 0, `max_uses >= 1`, `starts_at < expires_at` when present, non-empty
  `created_by`.
- Unique index on `code`.
- `ALTER TABLE bookings ADD COLUMN promo_code_id uuid REFERENCES promo_codes(id)` and
  `ADD COLUMN promo_hold_until timestamptz`, both nullable; index on `promo_code_id`.
- `ALTER TABLE promo_codes ENABLE ROW LEVEL SECURITY` — required by `rlsEnabled.test.ts`; no
  policies, matching 0048.
- `bookings.discount_total` already exists and is now also written by `/bookings/single|trip`.

### 8.2 Repositories

- `PromoCodeRepo` — `create`, `get`, `getByCode`, `list`, `update`. Storage of codes only; it
  never counts uses. In-memory and Postgres implementations satisfy **one shared contract test**, as
  in `quoteDiscountRepo.test.ts`.
- **Counting lives on `BookingRepo`** (amended while planning, 2026-09-14), because the count must
  run inside the booking transaction and needs both `bookings` and `payments`:
  - `create(b, { idempotencyKey?, promo?: { code, now } })` — locks the code row, re-checks §4.2
    and the count, then inserts with `promo_code_id` and `promo_hold_until`.
  - `promoUsage(codeId, now)` → `{ paid, held }`.
  - `promoBookings(codeId, now)` → every booking that carried the code, classified
    `paid` / `held` / `released`.
  - `reholdPromo(bookingId, code, now)` — performs §6.3.
  All additive. The in-memory repo mirrors §5.1 exactly: it is handed the in-memory payments repo
  (`attachPayments`) so "a succeeded payment" means the same thing in both, and it serialises
  concurrent takers of one code with a per-code lock in place of `FOR UPDATE`. One contract test
  runs against both implementations.

## 9. Testing

Every item is written as a failing test first, then made green. All time-dependent tests use the
injected clock, never literal dates.

| Area | Proves |
| --- | --- |
| Code rules | Format and normalisation; >30% refused at create; start inclusive, expiry exclusive; off; unique forever |
| §4.3 table | The three rows through `resolveDiscount()`, plus one engine-level booking test |
| Engine | A `code` request prices identically to the equivalent manual request; zero-discount goldens unchanged |
| Counting (contract: fake + Postgres) | Held unpaid counts; lapsed hold does not; cancelled-before-paid frees; cancelled-after-paid and refunded count; `awaiting_details` held; manual mark-paid counts |
| Last use (Postgres) | N concurrent bookings for the final use → exactly `max_uses` succeed, modelled on `departureRepo.test.ts` "never oversells" |
| Booking routes | Discounted total, `discount_total`, hold stored; each §4.4 error creates no booking; idempotent retry takes no second use; shared refused; no false mismatch alert |
| Checkout | Every row of the §6.3 table, including "hold valid but code expired → proceeds" |
| Estimate | Discount and error previews; never holds; strict intent still rejects other unknown fields |
| Founder API | Create, list with usage, detail with bookings, patch limits; ops/finance → 403; flag off blocks create but not patch |
| Flag | Off → codes refused at booking; an existing held booking still pays at its discounted total |
| Security | `rlsEnabled.test.ts` covers `promo_codes` with no change |

Gate before every commit: `cd api && npm run check` and `npm run test:all` (web-tests).

## 10. Later phases (not designed here)

1. **Website:** a code field in `booking.html`, preview via `/quote/v2/estimate`, discounted total
   and error messages in the summary, `promoCode` sent on booking. This is a customer release when
   merged (Pages serves from `main`).
2. **Ops screen:** create and manage codes in the ops tool. Until then, codes are created through
   the founder API.
3. **Customer wording:** "Code SUMMER10: −$8" in the confirmation email and on the manage page.
   Until then they show the discounted total without the breakdown.

## 11. Rollout

1. Merge with `PROMO_CODES_ENABLED` off: migration applies to staging; no behaviour changes.
2. Turn the flag on for **staging**, create test codes through the founder API, and exercise
   booking, checkout and the hold with PayHere sandbox.
3. Promote to prod and turn the flag on there **only with the owner's explicit go**.

Rollback: turn the flag off. New codes are refused; bookings already holding a code still pay at
the price the customer was shown.

## 12. Changes that need owner sign-off (CLAUDE.md maintenance rules)

- Migration `0050` (§8.1).
- New setting `PROMO_CODES_ENABLED` in `config.ts`.
- New capability `promo_codes:manage` in the shared capability matrix (`opsAuth.ts`).
- The `DiscountRequest.source` type change, and the additive `BookingRepo` and `PriceOutcome`
  interface changes (§7, §8.2).

`rateCard.ts` and `departureRepo.ts` are **not** touched. No generated files change.
