# Promo code field on the booking page — design

**Status:** design approved in conversation (Part 1 on 2026-09-25, Part 2 on 2026-09-27). §9 lists
three calls made while writing this spec that the owner has not yet confirmed.
**Phase:** §10.1 of `2026-09-14-promo-codes-design.md` (the website field). The backend is
already live on prod (#618, promoted in #644/#645) behind `PROMO_CODES_ENABLED`, which is off.
**Mockup:** `2026-09-24-promo-code-field-mockup.html` (next to this file) shows every state below,
drawn with the page's own CSS.

## 1. Goal

Let a customer type a promo code on `booking.html`, see the discount before paying, and be charged
the discounted price. The owner hands codes out personally, so there is **no** `?promo=` link that
fills the code in: the customer always types it.

Nothing changes for customers until the owner turns it on (§8).

## 2. What the backend already does (read on `origin/main` @ `ea28bd72`)

- **Preview:** `POST /quote/v2/estimate` accepts an optional `promoCode` next to the intent
  (`api/src/routes/quote.ts:298-341`). The top-level `totalCents` stays the **full** price. The
  answer adds one block:
  - success → `promoCode: { code, discountCents, totalBeforeDiscountCents, totalCents }`, where
    `code` is the normalised code (trimmed, upper-cased) and `totalCents` is the discounted total;
  - refusal → `promoCode: { error }`, the price itself unaffected.
  - The preview takes no hold. A code that previews fine can still be used up before the customer
    books.
  - On an **estimated** price (a place the engine could not route exactly, shown with "~"), the
    preview answers `promo_code_not_eligible`, because the booking would refuse it too
    (`quote.ts:332-333`).
- **Booking:** `/bookings/single` and `/bookings/trip` accept `promoCode`. The booking comes back
  with `total` and `amountDueNow` already discounted, plus `discountTotal` and `promoCodeId`
  (`api/src/routes/promoCodeBookings.test.ts:62-63`). A refusal is a `422 { error }`
  (`api/src/routes/bookings.ts:537, 559, 595, 651, 671, 721`). `/bookings/shared` refuses any code
  with `promo_code_not_eligible` (`bookings.ts:733`).
- **Error codes** (`api/src/domain/promoCode.ts:31-36`): `promo_code_invalid`,
  `promo_code_not_started`, `promo_code_expired`, `promo_code_used_up`, `promo_code_not_eligible`.
  With `PROMO_CODES_ENABLED` off, every code answers `promo_code_invalid`.
- **Price check:** the booking accepts `quotedTotal` as either the full or the discounted figure
  without raising a price-mismatch alert (`promoCodeBookings.test.ts:69`).

## 3. What the customer sees (Part 1, approved)

### 3.1 Placement

On the **Payment** step, a small text link, **"Have a promo code?"**, sits between the Tripadvisor
trust line and the "Due now" row (`#pay-due`, `booking.html:969`). It is collapsed by default.
Clicking it reveals the field in place.

### 3.2 States

| State | Payment step | Summary panel (and the mobile summary sheet) |
|---|---|---|
| **Collapsed** (default) | "Have a promo code?" link | No promo row |
| **Open** | Label "Promo code", a text input, an **Apply** button | No promo row |
| **Checking** | Apply button disabled and reads "Checking…"; input read-only | Total shimmers as for any re-price (the existing `is-pricing` treatment) |
| **Applied** | Chip: "**SAVE10** applied · Remove" | Row "Promo SAVE10 −$9" between the extras and the Total; Total and "Due now" show the discounted figure |
| **Refused on Apply** | Input stays open with the typed text; message under it (§3.3) | No promo row; price unchanged |
| **Stopped applying later** (§9, call 1) | Chip turns muted: "**SAVE10** · can't be used on this booking · Remove" | Row "Promo SAVE10" with "Doesn't apply" in place of an amount; full price |
| **Price check unavailable** | Message "We couldn't check your code just now, please try again." | No promo row; full price |

"Remove" clears the code and returns the field to the **Open** state, empty.

Enter in the input does the same as **Apply**. An empty input does nothing.

### 3.3 Messages (approved wording)

| Error | Message under the field |
|---|---|
| `promo_code_invalid` | That code isn't valid. |
| `promo_code_not_started` | That code isn't active yet. |
| `promo_code_expired` | That code has expired. |
| `promo_code_used_up` | That code has been fully used. |
| `promo_code_not_eligible` | That code can't be used on this booking. |
| engine unreachable / local fallback price | We couldn't check your code just now, please try again. |

Messages sit in a `role="status"` element so screen readers announce them. The colour is the page's
existing error red (`#b13b22`, as `.form-error` uses) at body size, without `.form-error`'s red box:
a mistyped code is not an alarm.

### 3.4 Where the link does not appear

- **Shared seats** (`isShared`): the backend refuses codes there, so the link is never drawn.
- **Switch off** (§8): nothing is drawn at all.

## 4. How the page works (Part 2, approved)

### 4.1 State

- A new top-level binding in `booking.js`, next to `engineEst`: `promoCode`, the normalised code
  the customer applied (trimmed, upper-cased), or `null`.
- The estimate's answer is kept **on the estimate itself**: `adoptEngineEstimate()` copies
  `est.promoCode` into `engineEst.promo`, and a parked raise keeps it in `pendingReprice.est`.

Keeping the promo answer on the estimate is what makes the maths safe. **The discount is always
taken from the same estimate as the full price it comes off.** A stale answer for an old itinerary
can never be subtracted from a new price, because it goes stale together with that price.

### 4.2 The code rides in every estimate

`buildEstimateIntent()` adds `promoCode` while one is applied. Applying or removing a code
therefore changes the intent signature, and the existing machinery does the rest: `requestEstimate`
fires, `repricing()` shimmers the Total, and `handleEngineEstimate` adopts the answer. Every later
change (a traveller, an extra, the van, a date) re-checks the code for free.

**No change to the raise gate.** `customerDroveTheRaise()` stays as it is. Because the estimate's
top-level `totalCents` is the full price, adding or removing a code never moves it, so the gate
never sees a code change as a raise. A raise that does arrive alongside a code change is ordinary
routing drift and is gated exactly as today. (Part 2 as presented on 2026-09-25 planned a clause
here; reading `handleEngineEstimate` showed it isn't needed.)

### 4.3 Two totals, on purpose

- **`calcTotal()` is unchanged. It stays the full price.** The summary's vehicle row is
  `calcTotal() − extras` (`booking.js:2202`). If the discount went into `calcTotal()`, the car's
  own line would shrink by the discount. That is the same bug shape as the 2026-08-27 report,
  where the car looked cheaper after an extra was ticked.
- **New `payableTotal()`**:
  - once the booking exists (`serverQuote` set) → `serverQuote.total` (already discounted);
  - else, when the estimate `calcTotal()` is reading from carries a successful promo block →
    that block's `totalCents / 100`. This is the server's own discounted number, never a
    client-side subtraction;
  - else → `calcTotal()`.
- **New `promoDiscount()`**: the `discountCents / 100` from that same block, or 0. Used only to
  draw the summary row.

### 4.4 Which figure goes where

| Place | Today | After |
|---|---|---|
| Summary vehicle row | `calcTotal() − extras` | unchanged |
| Summary promo row | — | `−promoDiscount()` |
| Summary **Total** (`#sum-total`) | `calcTotal()` | `payableTotal()` |
| Mobile bar total | mirrors `#sum-total` (`booking.js:3202-3206`) | unchanged; it mirrors the new figure |
| **Due now** (`#pay-due`), before the booking | `calcTotal()` via `amountDueNow()` | `payableTotal()` |
| Pay overlay amount (`#ph-amt`) | `amountDueNow()` | unchanged; `amountDueNow()` now falls back to `payableTotal()` |
| `quotedTotal` sent with the booking (`booking.js:2871`) | `calcTotal()` | `payableTotal()` |
| Final price check before checkout (`booking.js:2518-2521`) | `calcTotal()` before vs after the booking lands | `payableTotal()` before vs after |
| Analytics `add_payment_info`, `payment_initiated` | `calcTotal()` | `payableTotal()` (what the customer pays) |
| Confirmation pass, `purchase` event | `calcTotal()` after the booking lands | unchanged; that is `serverQuote.total`, already discounted |

The final-price-check row matters. Without it, every booking with a code would compare the full
price (before) with the discounted booking total (after), differ by more than $1, and show the
customer a false "your price changed" screen.

While a re-estimate is in flight, the promo row keeps its last figure, as the vehicle row does
(`booking.js:2203-2207`). Total and Due now read "Calculating…" as they do today.

### 4.5 Sending the booking

`createApiBooking()` adds `promoCode` to the `/bookings/single` and `/bookings/trip` payloads
**only** when the estimate currently priced for this itinerary carries a successful promo block.
It is never sent in the "doesn't apply", "couldn't check" or local-fallback states, and never to
`/bookings/shared`.

The idempotency key is built from the payload without `quotedTotal` (`booking.js:2979-2986`), so a
retry without the code is correctly a different request.

### 4.6 A refusal when the booking is made

A code can pass the preview and still be refused on the booking: the last use was taken in the
meantime, or the code expired. `runPayment()` already has this shape for the local road
(`booking.js:2496-2502`: drop it, `render()`, then `phShowEnd('error', …, {retry:false})`, so
there is no one-click retry and the customer sees the new price before paying). The promo refusal
follows it exactly:

1. The 422 body's `error` is one of the five promo codes.
2. Drop the applied code (`promoCode = null`) and `render()`. The price goes back to full through
   the normal re-estimate.
3. Open the promo field with the typed code and the §3.3 message for that error.
4. End the payment overlay with the same error state and **no retry button**. The overlay line
   reads the §3.3 message plus "Your total is now the full price." **No payment is taken.**
   Closing the overlay returns the customer to the Payment step, where they can press Pay again at
   the full price they can now see, or try another code.

### 4.7 Price check unavailable

When the engine is unreachable, the page prices with its local formula (the offline fallback).
That price carries no promo block, so no discount is shown or sent, and the field shows "We
couldn't check your code just now, please try again." The code stays applied. If the engine comes
back on a later re-estimate, the discount appears.

## 5. Files touched

- `booking.html`: the promo markup in the Payment step, the summary promo row, and styles in the
  page's own `<style>` block (the pay-step styles already live there, `booking.html:471-483`).
- `booking.js`: everything in §4.
- `web-tests/`: tests (§6).

No API, pricing, schema, migration or config changes. No `site.css` change: the styles are
page-only.

## 6. Testing

**Unit** (`web-tests/unit/`, the jsdom harness `booking-intent.test.js` already uses):

- `buildEstimateIntent()` carries `promoCode` only while a code is applied.
- With an adopted estimate `{ totalCents: 9000, promoCode: { discountCents: 900, totalCents: 8100, … } }`
  and a $10 extra: vehicle row $80, promo row −$9, Total $81, Due now $81, `calcTotal()` still 90.
- `payableTotal()` ignores a promo block on an estimate for a different intent signature.
- `payableTotal()` equals `serverQuote.total` once the booking exists.

**End to end** (`web-tests/e2e/booking-promo-code.spec.js`, estimate and booking mocked via
`_stubs.js` like `booking-engine-price.spec.js`):

- Apply → chip, promo row, discounted Total and Due now; the booking request carries `promoCode`
  and the discounted `quotedTotal`.
- Each refusal code → its message; price unchanged; no `promoCode` sent.
- Remove → full price, field empty.
- Stopped applying later: apply, then change travellers so the stub answers `not_eligible` →
  muted chip, "Doesn't apply" row, full price, no `promoCode` sent.
- Booking-time refusal: booking stub answers `422 promo_code_used_up` → message, full price, no
  payment overlay; pressing Pay again sends no `promoCode`.
- The final price check does not fire for a discounted booking.
- Hidden when the switch is off, and for a shared seat.
- A 375px run: the chip and the promo row fit without horizontal scroll.

Gate: `cd api && npm run check` and `npm --prefix web-tests run test:all` (Playwright included),
both green before committing.

## 7. Out of scope

- Ops screen for creating codes (§10.2 of the backend spec). Codes are still created through the
  founder API.
- Promo wording in the confirmation email and on the manage page (§10.3).
- `plan.html`, `pay.html` and pay links.
- Any change to `PROMO_CODES_ENABLED` or other API config.

## 8. Rollout

Two switches, both off:

1. **Backend** `PROMO_CODES_ENABLED` (Render env). Off → every code answers `promo_code_invalid`.
2. **Page** `const PROMO_FIELD_ENABLED = false` at the top of `booking.js`. Off → no link, no row,
   no `promoCode` in any request. The page is byte-for-byte today's behaviour.

Order:

1. Merge to `main` with the page switch off. GitHub Pages serves the **`production`** branch
   (checked 2026-09-27: `gh api repos/ceylonhop/ceylon-hop/pages` → `source.branch: production`),
   so nothing reaches customers until a promote. Even then the switch keeps it invisible.
2. Staging test: set `PROMO_CODES_ENABLED=1` on `ceylon-hop-staging`, create a test code through
   the founder API, and flip the page switch on a local or staging copy. Run a full booking with
   PayHere sandbox.
3. Go-live, only with the owner's explicit go: `PROMO_CODES_ENABLED=1` on prod first, then a
   one-line PR setting `PROMO_FIELD_ENABLED = true`, promoted `main → production`.

Rollback: set the page switch back to `false` and promote. Bookings already holding a code keep
their price (backend spec §11).

## 9. Calls made while writing, for the owner to confirm

1. **A code that stops applying later is kept, not dropped.** Example: the customer applies SAVE10,
   goes back and adds a traveller, and the vehicle minimum now leaves no room for a discount. The
   code stays applied. The summary row reads "Doesn't apply" and the chip turns muted with the
   reason, so the price rise is explained on every step and not only on Payment. If a later change
   makes it eligible again, the discount comes back by itself. The alternative is to drop the code
   silently and show a message only on the Payment step.
2. **No change to `customerDroveTheRaise()`** (§4.2). This refines Part 2 as presented, where the
   code change was going to count as the customer's own raise. It isn't needed, because the
   estimate's full-price total never moves when a code is added or removed.
3. **An estimated ("~") price says "That code can't be used on this booking."** That is the
   backend's answer (§2). The wording is accurate but doesn't say *why*. A specific message such as
   "Codes apply once we've confirmed your exact route" would need a way to tell this case apart,
   which the preview does not give today. Proposed: accept the general message for now.
