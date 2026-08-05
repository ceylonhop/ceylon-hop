# Partial-leg payment links — design

**Date:** 2026-08-04
**Status:** design approved by owner; build not started
**Builds on:** `docs/superpowers/specs/2026-07-31-quote-payment-link-design.md`

## 1. Problem

A payment link today always charges the quote's full total. Customers sometimes don't want to
buy the whole trip — they want two of the four legs and will arrange the rest themselves. Ops has
no way to send a link for part of a quote, so the choice is to re-price the quote down (losing the
record of what was offered) or to take the money out of band.

## 2. What this is, and is not

**It is a trimmed sale.** The legs that are not ticked are **not sold**. The customer is not
expected to pay for them later.

**It is not:**

- **A deposit or an instalment.** That is a separate, deferred feature
  (`2026-07-23-deposits-balance-payments-design.md`). Nothing here introduces a part-paid booking.
- **A chauffeur feature.** Chauffeur quotes keep today's full-total link — see §3.
- **A second sale against one quote.** One quote produces at most one booking, as today. Top-ups
  are explicitly out of scope; §10 records what would be needed.

## 3. Scope: private transfers only

Only `engine.product === 'private'` quotes can mint a partial link. Chauffeur quotes mint the
full-total link exactly as they do now.

Reason: a chauffeur "leg" in `api/src/quote/breakdown.ts` carries only the km share of that day.
The day rate, buffer and finishing sit above the legs, so a subset of chauffeur leg prices sums to
a number that means nothing and would systematically undercharge. Chauffeur partial sales, if ever
wanted, are a day-based feature with its own re-pricing, not this one.

## 4. The amount: sum the lines as quoted

The link charges **the sum of the ticked line prices, exactly as the quote already shows them**.
No re-pricing, no re-running the engine over the subset, no charm finishing on the subset.

Owner's rule: a price that has been quoted is not changed.

One consequence, handled explicitly. The per-leg lines sum to the **subtotal**; the quote's
headline total also carries the charm-finishing adjustment (`api/src/quote/priceFinish.ts`, capped
at $10). So "every line ticked" would land a few dollars below the full-total link.

**Rule:** if the selection covers every line, the amount is `quote.totalCents` verbatim — the
full-total link, unchanged. Only a genuine subset uses the summed-lines amount.

## 5. Ops UX

The existing **Payment link** button is unchanged: one press mints the full-total link and copies
it (`api/src/routes/ops-ui.html`, `mintPayLink`/`copyPayLink`). The fast path stays one press.

Next to it, a secondary affordance — **Part of trip…** — opens a picker:

- A flat list of the quote's own charge lines: every leg, and every extra.
- **Everything starts ticked.** Ops only ever unticks. The opening state of the picker is
  therefore today's link, which is why "nothing unticked" falls straight through to §4's
  full-total rule.
- Unticking a leg unticks the extras attributed to it (`legIndex`, see
  `api/src/quote/extrasDeposit.ts`). Re-ticking the leg re-ticks them. Ops can untick a leg's
  extra on its own.
- Trip-wide extras (no `legIndex`) sit in the same list and stay ticked until ops removes them.
  This errs toward charging what was quoted rather than silently dropping revenue; the customer
  sees the line on the pay page either way.
- A running total under the list, and a one-line summary: *"Covers 2 of 4 legs — $310.00"*.
- Confirm mints the link and copies it, with the same SANDBOX toast rules as today.
- **Blocked:** a selection with no legs. Extras alone are not a sale.

After minting, the quote's builder shows what the outstanding link covers (leg count + amount), so
ops does not have to remember what was sent.

## 6. Data model

Three new columns on `quotes` (migration `0038`, additive):

| column | type | meaning |
| --- | --- | --- |
| `pay_link_selection` | `jsonb` NULL | `{ legIndexes: number[], extraIndexes: number[] }` — indexes into `engine.legs` and `engine.extras`. `NULL` = the outstanding link is for the full quote |
| `sold_cents` | `integer` NULL | the frozen amount the outstanding partial link charges; `NULL` when the link is for the full total |
| `pay_link_seq` | `integer NOT NULL DEFAULT 0` | monotonic per quote; see below |

**Why stored, rather than packed into the token:** the link must stay short (`/p?t=…`), ops needs
to see what an outstanding link covers, and a stored selection is the shape a future top-up would
read. The cost is that minting is no longer purely stateless.

**The mint must write via `QuoteRepo.patch`, never `update`.** `update()` bumps `revision`
(`api/src/db/quoteRepo.ts`), which would instantly invalidate the token the mint just produced.
`patch()` does not. Add `payLinkSelection`, `soldCents` and `payLinkSeq` to `QuotePatch`.

Minting still never touches `status`, `sentAt` or the assignee.

### Token: v3 pins the selection

The v2 pay token is a packed 20-byte body of `{version, purpose, uuid, revision}`
(`api/src/lib/bookingToken.ts`). Add **v3**: the same body plus a `uint16` carrying
`pay_link_seq`.

`pay_link_seq` is bumped whenever a mint stores a selection **different from the current one** —
including switching from partial to full, or full to partial. Re-minting an identical selection
leaves it alone and returns the identical URL, preserving today's press-twice-get-the-same-link
property. It is monotonic and never reset, so a seq is never reused by a later selection.

`/view` and `/start` require `token.seq === quote.pay_link_seq`; a mismatch renders the existing
**revised** dead-end screen (the "this quote has sailed off" page), which is already the right
message. Without this, ops could change the selection after sending and the link already in the
customer's hand would silently charge the new amount.

**Every** new mint issues a v3 token, full-total ones included — otherwise a full-total link would
carry no seq and could not be retired by a later partial mint. Legacy v1/v2 tokens keep working,
and mean "the full quote", but only while the quote has never had a selection stored
(`pay_link_seq = 0`); once a partial link exists, older full-total links retire. Fails safe, and
matches the precedent set by revision-bump retirement.

## 7. Customer-facing pay page

`GET /quotes/pay/view` gains, for a partial link only:

- `lines: { label, amountCents }[]` — the ticked lines, so the page renders a receipt rather than
  a bare number. Labels come from the existing per-leg names and `EXTRA_LABELS`.
- `coverage: { soldLegs: number, totalLegs: number }` — rendered as one plain sentence, e.g.
  *"This covers 2 of the 4 legs in your itinerary."*

The margin invariant is unchanged: `/view` stays a hand-built projection. Line labels and amounts
are customer-facing numbers already shown on the quote; no cost, markup, hot-zone or rate-card
field is added to the wire. The existing test that asserts the raw wire carries no
`margin`/`hotZone`/`rateCardJson` must cover the new fields too.

Excluded legs are **not** enumerated. The count sentence is enough to stop anyone assuming the
whole trip is covered, without reading as a list of things they failed to buy.

## 8. The booking must be the sold legs only

This is the correctness centre of the feature, not the pay page.

`quoteToBooking` (`api/src/quote/quoteToBooking.ts`) maps **all** of `engine.legs`. If a partial
link commits unchanged, the booking, the driver's itinerary and the confirmation email all promise
legs nobody paid for.

Changes:

- `quoteToBooking(quote, details, opts?)` takes an optional `legIndexes`. When present it maps
  only those rides, and `distanceKm` sums only those rides.
- Single/trip mode is decided **after** the filter: a subset that leaves one 2-stop ride is a
  `single` booking, exactly as a one-leg quote is today.
- `isQuoteBookable()` runs against the **subset**, at mint time. A selection that cannot map to a
  booking is refused where ops can see it, never at the customer's Continue tap — the same rule,
  and the same reason, as the original pay-link gate.
- `booking.total` and `amountDueNow` = the frozen `soldCents`, not `quote.totalCents`.
- The chained-stops rule (`chainStops`) is unchanged and still applies to the filtered rides: a
  dropped middle leg leaves a gap between two rides, which is exactly what a gap stop already
  models.

The confirmation email and driver itinerary need no separate change — they read the booking, and
the booking now carries only what was sold.

## 9. Money and analytics

- Settlement is unchanged: the webhook (and ops mark-paid) flips the quote to `won` via
  `claimWonQuote`. A partial sale is still a won quote.
- **`wonValue` must not use `totalCents`.** `api/src/services/analytics/funnel.ts` sums
  `r.totalCents` for won quotes, which would book the full quote value on every partial sale and
  overstate revenue. Add `soldCents` to `FunnelQuoteRow` and use `soldCents ?? totalCents` for
  `wonValue`. `sentValue`, `pipeline` and `aging` keep using `totalCents` — they measure what was
  offered, which is still the full quote.
- Refunds are untouched: they are per-payment and evidence-backed, and the payment row carries the
  amount actually charged.
- `quote.totalCents` is never rewritten. The quote remains the record of what was offered; the
  booking and the payment record what was bought. That gap is intentional and is the same shape as
  the existing recorded-vs-priced mismatch signal on quote intent.

## 10. Deferred: top-ups

Letting a later payment add legs to the same booking is a coherent next step and the stored
selection is shaped for it. It is not in this build because it changes things that are live and
carry real money:

- "Paid" stops being binary — a settled booking could return to part-paid, and booking status, the
  Awaiting-payment chip, the watchdog and the quote → `won` flip all key off a one-way transition.
- `booking.total` would move after settlement, so every reader (receipt, emails, refund evidence,
  revenue) has to become "paid vs current total".
- Mint would need to refuse legs already sold, and pay-commit would need to re-check it.
- An amended-itinerary email and a re-issued driver itinerary become necessary.
- Rate-lock is per revision, so a top-up weeks later would honour a price that may be stale.

If ops instead needs to sell the remaining legs later, today's answer is a new quote for those
legs with its own link. If that proves tedious, **"Duplicate quote"** is the feature to build —
smaller, and more generally useful, than top-up plumbing.

## 11. Guards

| condition | result |
| --- | --- |
| `engine.product !== 'private'` and a selection is supplied | `409 not_linkable` |
| selection contains no legs | `409 not_linkable` |
| computed amount ≤ 0 | `409 not_linkable` |
| subset fails `isQuoteBookable` | `409 not_linkable` |
| quote not `ready`/`sent`, unpriced shell, no engine | `409 not_linkable` (unchanged) |
| token seq ≠ stored seq | `revised` state — sailed-off screen, `/start` refuses |
| every line ticked | full-total link, `pay_link_selection` cleared to `NULL` |

## 12. Testing

- **Amount:** subset sums the ticked lines; all-ticked returns `totalCents` including finishing;
  a leg's extra follows its leg; a trip-wide extra can be dropped.
- **Token:** v3 round-trips; a token minted for selection A is `revised` after selection B is
  minted; re-minting an identical selection returns a byte-identical URL; a v2 token resolves to a
  full-quote link while `pay_link_seq = 0` and is `revised` once a selection has been stored.
- **Mapping:** a subset booking carries only the sold legs' stops and their km; a one-leg subset of
  a multi-leg quote maps to `single`; a subset with a gap keeps the gap stop.
- **Guards:** every row of §11.
- **Wire:** `/view` for a partial link carries `lines` and `coverage` and still no margin, hot-zone
  or rate-card data.
- **Analytics:** `wonValue` for a partial won quote is `soldCents`, while `sentValue` stays
  `totalCents`.
- **Chain:** extend `web-tests/e2e/pay-link-chain.spec.js` with a partial mint → view → start →
  settle pass, asserting the booking's leg count and total.

## 13. Rollout

Additive migration, additive columns, additive token version; a quote with no selection behaves
exactly as it does today. `main` → staging automatically; prod via the promote PR. Migrations apply
on boot, fail-closed, so merging `0038` is its release.
