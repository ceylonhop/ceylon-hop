# Quote rate-card lock (price durability) — design

Lock the rate card to a quote so its price can't drift when the rate card changes under it —
on **both** the ops quoting tool and the customer web flow.

## Problem

Neither side holds the price today:

- **Ops quotes** persist the priced `result_json` + `rate_card_version`, but opening a quote
  **re-prices live** (`reopenQuote → refreshEstimate`) and the customer message is built from that
  recompute. An "Approved — ready to send" quote silently drifts to the current rate when support
  opens it to send. Approval doesn't lock the price.
- **Customer bookings** are priced client-side, then the backend **recomputes at checkout** and
  charges the *server* price (mismatch flag + anti-undercut floor). A customer can be charged ≠ what
  they were quoted if the rate moved. The existing `repriceDecision` only holds against **distance**
  drift, not rate-card drift.

Sri Lanka fuel prices can jump; once a price is shown to a customer it must stick.

## Requirements (owner, 2026-07-11)

1. **A quote locks the RATE CARD, not a fixed total.** The customer/operator can keep editing (add
   legs); the total recomputes, but the per-km rate / day rate / floors / markup stay fixed to the
   locked rate card — until the lock ends.
2. **Customer web:** the rate card **locks at first quote generation** (the quote id), held **7 days**.
   Within 7 days, everything for that quote id prices against the **locked** rate card. **After 7 days
   AND the rate card has changed → use the new rate card** (re-lock).
3. **Ops:** the rate card **locks at Approve → ready to send.** A draft stays on the live rate while
   the operator builds it; **Reopen to edit** unlocks (re-locks on re-approval). Send uses the locked
   price.
4. **Store the rate card WITH its version** on the quote (snapshot, self-contained).
5. **(Deferred — documented, not built now):** a founder-only ops API to update the rate card, so a
   new rate card can be published without a deploy. Out of scope for this build; see §9.

## Design

### 1. Rate-card snapshot on the quote (storage)

The `quotes` table already has `rate_card_version` + `result_json`. Add:

| Column | Type | Meaning |
|---|---|---|
| `rate_card_json` | `jsonb` | full snapshot of the `RATE_CARD` used to price this quote (self-contained; no version registry to maintain) |
| `rate_locked_until` | `timestamptz null` | when the lock expires; null = not time-limited (ops quotes) |

The customer web flow becomes **server-backed**: a customer quote is a `quotes` row with
`channel = 'web'` — created at first generation with the snapshot + `rate_locked_until = now + 7d`.
Ops quotes (`channel = 'ops'`) get the snapshot stamped when they move to `ready` (approval), with
`rate_locked_until = null`.

### 2. The engine prices against a *given* rate card

Today `private.ts` / `chauffeur.ts` / `engine.ts` / `breakdown.ts` / `extrasDeposit.ts` /
`pricingPayload.ts` read the global `RATE_CARD`. Thread an explicit `rateCard: RateCard` parameter
through the pricing functions, **defaulting to the current `RATE_CARD`** so existing callers are
unchanged. A quote is then priced with `quote(req, lockedRateCard)`. This is the core refactor and
the riskiest part — do it first, with the golden-number suite green, before any lock logic.

### 3. Lock lifecycle

Helper `rateCardFor(quote, now)`:
- **No lock yet** (fresh quote / first generation): use the **current** `RATE_CARD`; stamp
  `rate_card_json` + `rate_card_version` (+ `rate_locked_until` for web).
- **Locked and valid** (`rate_locked_until` is null, or `> now`): use the **stored** `rate_card_json`.
- **Locked and expired** (`rate_locked_until <= now`): use the **current** `RATE_CARD` and **re-lock**
  (restamp snapshot + version + a fresh `now + 7d`). If the current version equals the locked version
  the price is unchanged; only a real rate change moves it — satisfying "after 7 days AND the rate
  card changed → new rate card."

**Customer web:** every estimate/edit/checkout for a quote id runs through `rateCardFor`, so adding
legs re-prices against the locked card for 7 days, then rolls to current.

**Ops:** `draft` / `changes_requested` price with the **current** card (operator is actively building).
Transition to `ready` **stamps the snapshot** (locks it). `ready` / `sent` price + render the customer
message from the **locked** snapshot (no live recompute). `Reopen to edit` clears the lock (back to
draft → current); re-approval re-stamps.

### 4. Checkout honors the lock (anti-tamper preserved)

At booking/checkout the backend prices the submitted itinerary with the **quote's locked rate card**
(via its quote id), not the current `RATE_CARD`. The existing anti-undercut floor + mismatch check
still run (a tampered client total can't be charged below the locked-card price). So the customer is
charged the price the **locked** card produces for their final legs.

### 5. Customer client integration

Minimal: the static site keeps pricing client-side for display (its loaded codegen'd rate card is
already stable per page-load). The server is the source of truth for the lock:
- On **first commit to a bookable quote** (entering the booking flow), the client POSTs to create a
  `channel='web'` quote → receives a **quote id** (lock created, snapshot + `+7d`).
- Editing (add legs) updates that quote id; checkout submits it. The backend always prices with the
  quote's locked card.
- The quote id can be surfaced in a shareable/bookmarkable link so a return within 7 days re-hydrates
  the same locked price.

## Data-model / migration

- Add `rate_card_json jsonb` + `rate_locked_until timestamptz null` to `quotes` (Drizzle migration).
- Backfill existing rows: `rate_card_json = result_json`'s implied card is unavailable, so set
  `rate_card_json = current RATE_CARD` and leave `rate_locked_until = null` (existing quotes just
  behave as today until re-saved).

## §9 — Deferred: founder ops rate-card editor (documented, not built)

A future founder-only endpoint (`PATCH /admin/rate-card`, `margin:view`+ gated) to publish a new
rate card version without a code deploy: persist the new `RATE_CARD` to a `rate_cards` table
(append-only, version-stamped), and have the engine read the **active** persisted card (falling back
to the compiled `RATE_CARD`). This composes with the lock (each quote already snapshots the card it
used). The front-end codegen (`pricingPayload → transfers-data.js`) would need a republish step.
**Not in this build** — noted so the storage shape above (snapshot + version) stays compatible.

## Testing

- Engine: golden-number suite stays green after the `rateCard`-param refactor (default path). New
  tests: pricing the same request against two different rate cards yields the two expected totals.
- Lock lifecycle (unit): `rateCardFor` returns locked card while valid; current + re-lock after
  expiry; only a version change moves the price post-expiry.
- Ops (e2e): approve a quote → change the rate card → reopen the *ready* quote → the customer message
  still shows the **approved** price (locked), not the new rate.
- Customer (api): create a web quote (locks card v1) → change the rate card to v2 → add a leg / checkout
  within 7 days → priced with **v1**; simulate `rate_locked_until` in the past → priced with **v2**.

## Rollout

Staged, each landing independently green: (1) engine takes a `rateCard` param (no behavior change);
(2) `quotes` columns + `rateCardFor` helper + lock lifecycle; (3) ops freeze-on-approval (send from
locked); (4) customer web-quote + 7-day lock + checkout-honors-lock. The deferred founder editor (§9)
is a later, separate build.
