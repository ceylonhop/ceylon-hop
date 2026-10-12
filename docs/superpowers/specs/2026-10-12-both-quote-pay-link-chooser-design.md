# Pay link for either option of a "both" quote — Design Spec

**Date:** 2026-10-12
**Status:** Approved design (owner, 2026-10-12). Build not started.
**Verified against:** `origin/main` @ `b6961860`. Line numbers are from that commit — re-find by the
quoted name if they have moved.

---

## 1. Goal

A quote recorded as **Customer asked for: both** is priced point-to-point, with the chauffeur-guide
price shown alongside (builder cards, copied WhatsApp/email message). If the customer then picks the
chauffeur option, the agent has to reopen and re-price the quote to get a payment link for it.

**Owner's choice (option 1):** pressing **Payment link** on such a quote asks the agent which option
the link is for — "Point-to-point $149" / "Chauffeur-guide $223" — and the link shows and charges
only that product. Rejected: one link whose pay page offers both (the pay page stays one product,
one price, one set of cancellation terms).

## 2. Owner decisions (2026-10-12)

| # | Decision |
|---|---|
| D1 | The agent picks at mint time; the pay page never offers a choice of service. |
| D2 | **Discounted "both" quote: no chauffeur link.** The chooser does not appear; `409 not_linkable / discounted`. The discount belongs to the point-to-point price only (same rule as part-of-trip links). |
| D3 | **A quote carrying a chauffeur alternative is founder-approval only** — no ops self-approval. Two prices are being approved. |
| D4 | **"Mark booked" (cash/bank) is unchanged** — it books the point-to-point option. A chooser there is a follow-up. |
| D5 | **Switching while a payment is in flight: warn, do not block.** The agent is told a payment was started on the current link and is not cancelled by switching. |
| D6 | Already-approved "both" quotes get no chooser until re-saved and re-approved. No backfill — a backfilled price would be one nobody approved. |

## 3. Current state (verified)

- A saved quote holds ONE product and ONE total: `/save` stores `product`, `totalCents`,
  `marginCents`, `request: { tool, engine }`, `result` priced on the live card
  (`routes/internalQuote.ts:941-953`). `/save` is refused outside `draft | changes_requested`
  (`:898-902`); `→ ready` only stamps the rate lock and validity (`:1600-1610`) — it never re-prices.
- The chauffeur figure on a "both" quote is recomputed live by `serviceChooserData`
  (`internalQuote.ts:515-535`; feasible only when every leg is dated and there are 2+ distinct
  dates, `:524-526`) and is **not stored**. It is always undiscounted.
- `POST /admin/quote/:id/pay-link` (`:1183-1294`): bodyless = whole trip at `quote.totalCents`; a
  part-of-trip body freezes `payLinkSelection` + `soldCents`; `payLinkSeq` bumps only when the
  normalised selection changes (`:1254-1256`), which is what retires an older link.
- The pay side (`routes/quotePay.ts`) charges `quote.soldCents ?? quote.totalCents` (`:268`, `:307`),
  builds copy with `payPageCopy(quote, sel)` and the booking with `quoteToBooking(quote, …)` — both
  read `request.engine`. `depositOffer` (`:62-68`) is 0 whenever a selection or `soldCents` is set.
- `pay.html` is fully server-driven (`copy.product`, `totals`, `deposit`) — no change needed.
- Readers that assume `payLinkSelection` is a leg selection and would break on anything else:
  `routes/ops.ts:318-320` (booking drawer coverage), `routes/webhooks.ts:443-447` (confirmation
  email coverage — a throw there means no confirmation), `chosenAddOns`
  (`quote/paySelection.ts:97-119`, via `db/bookingRepo.ts:357`, `db/postgresBookingRepo.ts:384/394`),
  `/pay-lines` → the ops part-of-trip picker (`ops-ui.html:6862-6863`).
- `stripQuoteMargin` (`internalQuote.ts:493-513`) is shallow: it would not strip margin figures
  nested under a new key in `result`.
- Ops self-approval (`quote/simpleApproval.ts:35-52`) allows a one-driving-leg quote — which, with a
  stay day on another date, has a feasible chauffeur alternative.

## 4. Design

### 4.1 Data — no migration
New pure module `api/src/quote/quoteAlternative.ts`.

- **The frozen alternative** lives in the existing `quotes.result_json`, written by `/save` only:
  `result.alt?: { product: 'chauffeur', engine: QuoteRequest, result: QuoteResult }`.
  Written when `requestedService === 'both'`, the priced product is `private`, the quote has **no
  discount** (D2) and the chauffeur pass is feasible and does not throw; priced on the same live
  card instance as the primary. Any failure → no `alt`, never a failed save. `result` (not
  `request`) so content-diff readers are untouched and `quote_revisions` versions it for free.
- **Which option a link is for** lives in the existing `quotes.pay_link_selection`:
  `PayLinkSelection = PaySelection | { service: 'chauffeur' }` (null = whole-trip primary).
  `sold_cents` is set to `alt.result.totalCents` at mint. A discriminated union makes the compiler
  flag every `.legIndexes` reader.
- **`soldView(quote): SavedQuote | null`** — the quote "as sold": unchanged without a service
  selection; with one and a matching `alt` whose total equals `soldCents`, the quote with
  `product`, `totalCents`, `marginCents`, `request.engine`, `result` taken from `alt` and the
  selection cleared; otherwise `null` → the link reads `unavailable` (fail closed).

### 4.2 API
- `POST /admin/quote/:id/pay-link` accepts `{ service: 'private' | 'chauffeur' }`.
  Absent or equal to the priced product → today's path, byte-identical. With
  `legIndexes`/`extraIndexes`, or an invalid value → `400 bad_request`. The alternative requires a
  stored `alt` and a bookable projection, else `409 { error: 'not_linkable', reason:
  'no_alternative' | 'discounted' }`. Success: selection `{ service: 'chauffeur' }`, `soldCents` and
  `amountCents` = the alt total, seq by the existing "changed" rule. Response adds `service`.
- `GET /admin/quote/:id` adds `payOptions: null | { primary: { service, totalCents }, alternative:
  { service, totalCents, depositCents }, linkedService }` — sell-side numbers only.
- `lockedEstimate` and the customer quote view prefer the stored alt total for the non-priced
  service, so the builder cards, the copied message, the quote page, the chooser and the charge all
  show one number.
- `stripQuoteMargin` strips margin and hot-zone meta under `result.alt` too.
- `simpleApproval`: a quote with an `alt` is not self-approvable (D3).

### 4.3 Pay side
`/quotes/pay/view`, `/start` and `/balance` call `soldView` straight after loading the quote;
everything below is unchanged. A chauffeur link therefore gets chauffeur copy, a
`serviceType: 'chauffeur'` booking at the frozen total, and the deposit offer when the total is
≥ $150. Each option gets its own booking (idempotency keys are per seq). The retired link shows the
existing "revised" screen.

### 4.4 Ops tool (`routes/ops-ui.html`)
- `payLinkPress`: when `payOptions.alternative` exists and the quote is `ready | sent`, open a
  chooser in the existing pay-picker slot — two buttons with their totals, a deposit note on the
  chauffeur one, Cancel. Otherwise unchanged.
- A pick mints with `{ service }`, copies the link and names the product in the toast. The same
  option again copies from cache; the other option mints and retires the first.
- A line shows which option's link is out. When a booking has been started on the current link:
  "a payment was started on the current link — it is not cancelled by switching" (D5).
- "Part of trip…" is unchanged (point-to-point only).

### 4.5 Deliberately unchanged
Token format and short links · single-service quotes · the bodyless mint · `pay.html`, `quote.html` ·
booking/payment/webhook flow · price-drift baseline · "Mark booked" (D4) · the quote row itself
(stays `product: private`, `totalCents` = the point-to-point price).

## 5. PR sequence (readers before any writer)

| PR | Scope | Notes |
|---|---|---|
| 1 | Freeze the alternative at `/save`; strip margin under `alt`; stored-alt-wins in `lockedEstimate` and the quote view; founder-only approval | **Stores a second chargeable price and tightens the approval gate — owner OK given 2026-10-12.** |
| 2 | Union type + `soldView`; every reader of `payLinkSelection` (pay routes, ops drawer, confirmation email, add-ons, `/pay-lines`) | Dormant — nothing writes a service selection yet. **Must reach prod before or with PR 3 and never be reverted once a service link exists.** |
| 3 | Mint API (`service` on `/pay-link`, `payOptions` on `GET /:id`) | Test pins `amountCents === soldCents === alt total === /view total`. |
| 4 | Ops chooser UI | May merge with PR 3. |

Each PR: failing test first, `cd api && npm run check` and `web-tests` `test:all` green.

## 6. Risks
1. **Order / rollback** — a stored `{ service }` selection breaks pre-PR-2 code in the ops drawer and
   the confirmation email. PR 2 ships first and stays.
2. **Margin leak** through nested `result.alt` to non-founder roles — covered by a red test in PR 1.
3. **Product / amount mismatch** if a reader skips `soldView` — one call at the top of each handler,
   fail-closed null, and an equality check against `soldCents`.
4. **Two payments** if the customer pays the first link after the agent switched (the checkout token
   lives 30 minutes) — D5: warn only; settlement's existing double-capture alert still applies.
5. **Reporting** — a quote won as chauffeur stays `product: private` in quote-level reports; value is
   right via `soldCents`. Follow-up.
6. Displayed vs stored price can differ between the last save and approval if the rate card moves —
   already true for the primary price; stored-wins closes it for `ready | sent`.

## 7. Out of scope
A choice of service on the customer's pay page or quote page · a chooser on "Mark booked" · a
chauffeur link on a discounted quote · backfilling approved quotes · a point-to-point alternative on
a chauffeur-priced quote.
