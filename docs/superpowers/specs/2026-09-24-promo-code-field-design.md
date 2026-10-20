# Promo code field on the booking page — design

**Status:** approved by the owner on 2026-09-27: Part 1 (2026-09-25), Part 2, the §9 calls, and
the review corrections folded in the same day. Implementation plan:
`docs/superpowers/plans/2026-09-27-promo-code-field.md`.
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
  (`api/src/routes/quote.ts:298-341`). The API lifts the code off before pricing, so the top-level
  `totalCents` is the **full** price with or without it. The answer adds one block:
  - success → `promoCode: { code, discountCents, totalBeforeDiscountCents, totalCents }`, where
    `code` is the normalised code (trimmed, upper-cased) and `totalCents` is the discounted total;
  - refusal → `promoCode: { error }`, the price itself unaffected.
  - The preview takes no hold. A code that previews fine can still be used up before the customer
    books.
  - On an **estimated** price (a place the engine could not route exactly, shown with "~"), the
    preview answers `promo_code_not_eligible` (`quote.ts:332-333`). This hardly matters on the page:
    an estimated price can't be paid there at all, because the Pay button is disabled while the
    estimate is marked estimated (`booking.js:2316-2323`).
- **Booking:** `/bookings/single` and `/bookings/trip` accept `promoCode`. The booking comes back
  with `total` and `amountDueNow` already discounted, plus `discountTotal` and `promoCodeId`
  (`api/src/routes/promoCodeBookings.test.ts:62-63`). A refusal is a `422 { error }`
  (`api/src/routes/bookings.ts:537, 559, 595, 651, 671, 721`). `/bookings/shared` refuses any code
  with `promo_code_not_eligible` (`bookings.ts:733`).
- **Error codes** (`api/src/domain/promoCode.ts:31-36`): `promo_code_invalid`,
  `promo_code_not_started`, `promo_code_expired`, `promo_code_used_up`, `promo_code_not_eligible`.
  With `PROMO_CODES_ENABLED` off, every code answers `promo_code_invalid`.
- **Holds:** an unpaid booking holds its code's use for 2 hours, counted from bookings, never
  stored (`promoCode.ts:9, 75`). The preview counts held uses too, including the customer's own
  (§10.1).
- **Price check:** the booking accepts `quotedTotal` as either the full or the discounted figure
  without raising a price-mismatch alert (`promoCodeBookings.test.ts:69`).
- **Rate limit:** `/quote/*` is under the per-IP limit (`api/src/app.ts:379`; default 20 requests
  a minute, `config.ts:60`). The live setting is unverified.

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
| **Checking** | Apply button disabled and reads "Checking…"; input read-only | Total and Due now show the existing loading shimmer while the new price is on its way |
| **Applied** | Chip: "**SAVE10** applied · Remove" | Row "Promo SAVE10 −$9" between the extras and the Total; Total and "Due now" show the discounted figure |
| **Refused on Apply** | Field stays open with the typed text; red message under it (§3.3) | No promo row; the price already shown stays |
| **Couldn't check on Apply** | Field stays open with the typed text; grey message "We couldn't check your code just now, please try again." Apply retries | No promo row; the price already shown stays |
| **Stopped applying later** (§9, call 1) | Muted chip: "**SAVE10** · can't be used on this booking · Remove" (the reason matches the refusal) | Row "Promo SAVE10" with "Doesn't apply" in place of an amount; full price |
| **Couldn't re-check later** | Muted chip: "**SAVE10** · couldn't be checked just now · Remove" | Row "Doesn't apply"; the page is on its offline price, exactly as it is today without codes |

"Remove" clears the code and returns the field to the **Open** state, empty. Enter in the input
does the same as **Apply**. An empty input does nothing.

"Refused" and "couldn't check" **on Apply** never keep the code. The code only sticks once the server
has accepted it. After that, a refusal caused by a trip change keeps it applied but muted (§9.1).

### 3.3 Messages (approved wording)

| Error | Message under the field |
|---|---|
| `promo_code_invalid` | That code isn't valid. |
| `promo_code_not_started` | That code isn't active yet. |
| `promo_code_expired` | That code has expired. |
| `promo_code_used_up` | That code has been fully used. |
| `promo_code_not_eligible` | That code can't be used on this booking. |
| pricing server unreachable | We couldn't check your code just now, please try again. |

On the page the apostrophes are typographic (’), as the rest of `booking.js`'s copy is. Messages sit
in a `role="status"` element so screen readers announce them. Refusals use the page's existing
error red (`#b13b22`, as `.form-error` uses) at body size, without `.form-error`'s red box: a
mistyped code is not an alarm. "Couldn't check" is grey, because it isn't the customer's mistake.

### 3.4 Where the link does not appear

- **Shared seats** (`isShared`): the backend refuses codes there, so the link is never drawn.
- **Switch off** (§8): nothing is drawn at all.

## 4. How the page works (Part 2, approved)

### 4.1 State

New top-level bindings in `booking.js`, next to `engineEst`:

- `promoCode`: the normalised code the customer applied (trimmed, upper-cased), or `null`.
- `promoConfirmed`: true once an estimate has accepted the current code. This is what separates
  "refused on Apply" (drop the code) from "stopped applying later" (keep it muted).
- `promoApplyError`: the refusal code, or `promo_unchecked`, to show under the open field.
- `promoOpen`: whether the customer has opened the field.

The estimate's promo answer is kept **on the estimate itself**: `adoptEngineEstimate()` copies
`est.promoCode` into `engineEst.promo`. **The discount is always taken from the same estimate as
the full price it comes off.** A stale answer for an old itinerary can never be subtracted from a
new price, because it goes stale together with that price.

While a price rise is parked for the customer to acknowledge (the existing reprice notice), the
field shows **Checking** until they accept it.

### 4.2 The code rides in every estimate

`buildEstimateIntent()` adds `promoCode` while one is applied. Applying a code therefore changes the
intent signature, and the existing machinery does the rest: `requestEstimate` fires, the price
shimmers while it's on its way, and `handleEngineEstimate` adopts the answer. Every later change (a
traveller, an extra, the van, a date) re-checks the code for free.

**Dropping or removing a code doesn't fetch the price again.** Because the full price never depends
on the code (§2), the answer held for "this trip + code" *is* the answer for "this trip". The page
re-keys it to the trip without the code, instantly and with no shimmer.

**No change to the raise gate.** `customerDroveTheRaise()` stays as it is. Because the estimate's
top-level `totalCents` is the full price, adding or removing a code never moves it, so the gate
never sees a code change as a raise. A raise that does arrive alongside a code change is ordinary
routing drift and is gated exactly as today.

### 4.3 Two totals, on purpose

- **`calcTotal()` is unchanged. It stays the full price.** The summary's vehicle row is
  `calcTotal() − extras` (`booking.js:2202`). If the discount went into `calcTotal()`, the car's
  own line would shrink by the discount. That is the same bug shape as the 2026-08-27 report,
  where the car looked cheaper after an extra was ticked.
- **New `heldPromo()`**: the successful promo block on the estimate `calcTotal()` is currently
  reading from, or `null`. It follows `calcTotal()`'s own order: a parked raise holds `engineEst`,
  a live estimate wins, and a re-price in flight holds `engineEst`.
- **New `payableTotal()`**:
  - once the booking exists (`serverQuote` set) → `serverQuote.total` (already discounted);
  - else, when `heldPromo()` has a block → that block's `totalCents / 100`. This is the server's
    own discounted number, never a client-side subtraction;
  - else → `calcTotal()`.

### 4.4 Which figure goes where

| Place | Today | After |
|---|---|---|
| Summary vehicle row | `calcTotal() − extras` | unchanged |
| Summary promo row | — | `−heldPromo().discountCents / 100`, or "Doesn't apply" |
| Summary **Total** (`#sum-total`) | `calcTotal()` | `payableTotal()` |
| Mobile bar total | mirrors `#sum-total` (`booking.js:3202-3206`) | unchanged; it mirrors the new figure |
| **Due now** (`#pay-due`), before the booking | `calcTotal()` via `amountDueNow()` | `payableTotal()` |
| Pay overlay amount (`#ph-amt`) | `amountDueNow()` | unchanged; `amountDueNow()` now falls back to `payableTotal()` |
| `quotedTotal` sent with the booking (`booking.js:2871`) | `calcTotal()` | `payableTotal()` |
| Final price check before checkout (`booking.js:2518-2521`) | `calcTotal()` before vs after the booking lands | `payableTotal()` before vs after |
| Analytics `add_payment_info`, `payment_initiated` | `calcTotal()` | `payableTotal()` (what the customer pays) |
| Confirmation pass, `purchase` event | `calcTotal()` after the booking lands | unchanged; that is `serverQuote.total`, already discounted |
| Price-change notice (was / now / button) | full `fromCents`/`toCents` | `payableTotal()` / the parked estimate's own accepted promo total, else full |
| WhatsApp pre-filled message ("Quoted …") | `calcTotal()` | `payableTotal()` |

The final-price-check row matters. Without it, every booking with a code would compare the full
price (before) with the discounted booking total (after), differ by more than $1, and show the
customer a false "your price changed" screen.

While a re-estimate is in flight, the promo row keeps its last figure, as the vehicle row does
(`booking.js:2203-2207`). Total and Due now read "Calculating…" as they do today.

### 4.5 Sending the booking

`createApiBooking()` adds `promoCode` to the `/bookings/single` and `/bookings/trip` payloads
**only** when the estimate currently priced for this itinerary accepted the code. It is never sent
in the doesn't-apply, couldn't-check or offline-price states, and never to `/bookings/shared`.

The idempotency key is built from the payload without `quotedTotal` (`booking.js:2979-2986`), so a
retry without the code is correctly a different request.

### 4.6 A refusal when the booking is made

A code can pass the preview and still be refused on the booking: the last use was taken in the
meantime, or the code expired. `runPayment()` already has this shape for the local road
(`booking.js:2496-2502`: drop it, `render()`, then `phShowEnd('error', …, {retry:false})`, so
there is no one-click retry and the customer sees the new price before paying). The promo refusal
follows it exactly:

1. The 422 body's `error` is one of the five promo codes.
2. Drop the applied code and re-key the held price to the trip without it (§4.2), then `render()`.
   The full price shows at once.
3. Open the promo field with the typed code and the §3.3 message for that error.
4. The payment overlay ends in its error state with **no retry button**. Its line reads the §3.3
   message plus "Your total is now the full price." **No payment is taken.** Closing the overlay
   returns the customer to the Payment step, where they can press Pay again at the full price they
   can now see, or try another code.
5. The refused code is remembered for the rest of the visit (`promoRefusedAtBooking`, keyed by the
   normalised code). Re-applying the SAME code shows the same §3.3 message again without asking the
   server: `ch-pricing.js` caches estimate answers by intent in `sessionStorage`, so a fresh preview
   would just replay the OLD "accepted" answer for it, not the refusal the booking just hit.

### 4.7 Pricing server unreachable

- **On Apply:** the code is not kept. Keeping it would change the priced trip to "trip + code".
  With no answer for that, `calcTotal()` would fall back to the page's rough offline formula, a
  different figure nobody was shown. On the default test route that is $121 instead of the $100
  already on screen. So the page forgets the code, the $100 stays current, and the field shows the
  grey "couldn't check" message with the typed text so Apply retries.
- **For a code already accepted,** when a later trip change can't be re-checked: the code stays
  applied but muted ("couldn't be checked just now"), nothing is taken off, and the page is on its
  offline price, exactly as it is today without codes.

No code is sent in either case.

## 5. Files touched

- `booking.html`: the promo markup in the Payment step, the summary promo row, and styles in the
  page's own `<style>` block (the pay-step styles already live there, `booking.html:471-483`).
- `booking.js`: everything in §4.
- `web-tests/`: tests (§6).

No API, pricing, schema, migration or config changes. No `site.css` change: the styles are
page-only.

## 6. Testing

**Unit** (`web-tests/unit/booking-promo.test.js`, the jsdom harness `booking-intent.test.js`
already uses). These test the logic, not rendered rows:

- `buildEstimateIntent()` carries `promoCode` only while a code is applied, and never with the
  switch off or on a shared seat.
- `payableTotal()` is the promo block's total while `calcTotal()` stays the full price;
  `amountDueNow()` follows it.
- `payableTotal()` ignores a promo block on an estimate for a different trip, and equals
  `serverQuote.total` once the booking exists.
- Settling answers:
  - an accepted code is confirmed;
  - a code refused on Apply is dropped and the price re-keyed, with no second fetch;
  - a confirmed code refused later stays, muted;
  - an unconfirmed code whose check couldn't run is dropped with the grey message.
- Every error code maps to its §3.3 message.
- The booking payload carries `promoCode` and the discounted `quotedTotal` (single and trip), and
  carries no code once it stopped applying.

**End to end** (`web-tests/e2e/booking-promo-code.spec.js`, estimate and booking mocked via
`_stubs.js` like `booking-engine-price.spec.js`):

- Switch off → nothing drawn, no `promoCode` in any estimate request. Shared seat → nothing drawn.
- Apply:
  - the chip and the promo row appear;
  - the vehicle row keeps its price and Total/Due now are discounted;
  - the booking request carries `promoCode` and the discounted `quotedTotal`;
  - checkout is reached with no false price-change stop.
- A refused code → its message, the typed text kept, full price, no `promoCode` sent.
- Remove → full price, field empty.
- Stopped applying later → muted chip, "Doesn't apply" row, full price, no `promoCode` sent; it
  comes back when the trip qualifies again.
- Couldn't check on Apply → grey message, typed text kept, the price already shown stays.
- Booking-time refusal (booking stub answers `422 promo_code_used_up`):
  - the overlay shows the message with no retry button;
  - the field shows the message, and the price is full;
  - pressing Pay again sends no `promoCode`.
- A 375px run: the chip and the promo row fit without horizontal scroll.

Gate: `cd api && npm run check` and `npm --prefix web-tests run test:all` (Playwright included),
both green before committing.

## 7. Out of scope

- Ops screen for creating codes (§10.2 of the backend spec). Codes are still created through the
  founder API.
- Promo wording in the confirmation email and on the manage page (§10.3).
- `plan.html`, `pay.html` and pay links.
- Any change to `PROMO_CODES_ENABLED` or other API config.
- An analytics event for applied or refused codes (owner call, 2026-09-27: not now).

## 8. Rollout

Two switches, both off:

1. **Backend** `PROMO_CODES_ENABLED` (Render env). Off → every code answers `promo_code_invalid`.
2. **Page** `const PROMO_FIELD_ENABLED = false` in `booking.js`. Off → no link, no row, no
   `promoCode` in any request. The page behaves as it does today. (The hidden markup is added, and
   the totals route through `payableTotal()`, which returns `calcTotal()` when no code is applied.)

Order:

1. **Merge to `main` with the page switch off.** GitHub Pages serves the **`production`** branch
   (checked 2026-09-27: `gh api repos/ceylonhop/ceylon-hop/pages` → `source.branch: production`),
   so nothing reaches customers until a promote. Even then the switch keeps it invisible.
2. **Staging test, end to end, before any prod change.** There is no staging copy of the site, but
   a local copy can drive the staging API. Staging answers `access-control-allow-origin:
   http://localhost:4173` (checked 2026-09-27 with a preflight to
   `ops.staging.ceylonhop.com/quote/v2/estimate`).
   1. Set `PROMO_CODES_ENABLED=1` on `ceylon-hop-staging` only.
   2. Create a test code through the staging founder API (`/admin/promo-codes`).
   3. In a local checkout, set `PROMO_FIELD_ENABLED = true`. **Don't commit this.**
   4. Start `node serve-booking.js` (port 4173) and open
      `http://localhost:4173/booking.html?api=https://ops.staging.ceylonhop.com&…`.
   5. Run apply, refuse, remove, and a full booking with PayHere sandbox. Confirm the booking shows
      `discountTotal` in ops staging.
3. **Go-live, only with the owner's explicit go:** set `PROMO_CODES_ENABLED=1` on prod first, then
   a one-line PR setting `PROMO_FIELD_ENABLED = true`, promoted `main → production`.

**Making codes (owner guidance):**

- Prefer **multi-use** codes (§10.1).
- Use codes that are **hard to guess** (§10.2): a name plus random characters, for example
  `ROSHEN-7KQ2`, rather than a word like `SAVE10`.

Rollback: set the page switch back to `false` and promote. Bookings already holding a code keep
their price (backend spec §11).

## 9. Calls made while writing (confirmed by the owner, 2026-09-27)

1. **A code that stops applying later is kept, not dropped.** Example: the customer applies SAVE10,
   goes back and adds a traveller, and the vehicle minimum now leaves no room for a discount. The
   code stays applied. The summary row reads "Doesn't apply" and the chip turns muted with the
   reason, so the price rise is explained on every step and not only on Payment. If a later change
   makes it eligible again, the discount comes back by itself.
2. **No change to `customerDroveTheRaise()`** (§4.2). It isn't needed, because the estimate's
   full-price total never moves when a code is added or removed.
3. **An estimated ("~") price gets the general "can't be used on this booking" message.** This is
   moot in practice: such a price can't be paid on the page (§2).

## 10. Known limits (accepted by the owner, 2026-09-27)

1. **A single-use code and a failed payment.** The customer's own unpaid booking holds the code's
   one use for 2 hours. Card failures at the 3-D Secure step are common for us (payment-failure
   audit, 2026-09-24).
   - **If the customer retries unchanged:** that re-sends the same booking (same idempotency key),
     and the backend honours its hold.
   - **If they change anything first:** the new preview counts their own hold and says the code has
     been fully used, so the discount is lost.
   - **Accepted for now:** the owner will prefer multi-use codes.
   - **A real fix would be a backend change:** the preview would have to ignore the customer's own
     hold. That needs its own design.
2. **Codes can be guessed.** The preview endpoint is public, and "expired" or "fully used" reveal
   that a code exists where "isn't valid" doesn't. It is rate-limited per IP (§2), but a short word
   like SAVE10 is still guessable from a list. The defence is code naming (§8), not page code.
3. **Previews can be minutes old.** `ch-pricing.js` caches estimate answers in `sessionStorage` by
   intent. A code used up since then is caught when the booking is made (§4.6).
