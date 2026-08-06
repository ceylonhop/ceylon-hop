# Customer quote link — design

**Date:** 2026-08-05 · **Owner decision session:** Roshen, via brainstorming
**Status:** approved design, ready for an implementation plan

## 1. Goal

Today a quote reaches the customer as a WhatsApp message: a block of typed prose, a price,
and — when the customer asked about both services — a sentence appended by
`appendChauffeurUpsell()` reading *"If you'd prefer the chauffeur-guide option … that would
be $X total."* There is nothing to look at and nothing to act on. The only customer-facing
page a quote can produce is the **pay page**, which is a checkout: it exists to remove
friction between *decided* and *paid*.

This feature gives a quote its own customer-facing page — a **proposal**. It shows the trip
on a map, lays the itinerary out day by day, and when the customer asked about both
services, shows both prices side by side. It is read-only. When the customer is ready, it
hands off to the existing pay flow.

The owner's framing, verbatim:

> "the quote link should just be a much more robust we could even add the map where people
> can see their route etc."

> "no we dont give customers ability to update the quote, we update it if they want"

> "Customer can choose which one they want. However, both options only show if they asked
> for quotes for both options. Usually it will be the one option they asked for"

## 2. Decisions (all owner-confirmed)

- **D1 — A separate page, not a mode of `pay.html`.** The two have different jobs. The pay
  page is a checkout: one column, one number, one button. The quote page is a proposal —
  opened repeatedly, forwarded to a travel companion, sat on for days. Putting a map, a
  day-by-day itinerary and an option comparison inside the ticket layout would make it a
  worse checkout *and* a worse proposal.

- **D2 — New hostname `quote.ceylonhop.com`, same API service.** `pay.ceylonhop.com` is
  already a custom domain pointed at the API, which serves `pay.html`/`manage.html` itself
  out of `customerPages.ts` and injects `window.CEYLON_HOP_API = location.origin` into every
  page it serves. A second custom domain on the *same service* is therefore same-origin with
  the API for free — no CORS work, no second deployment, no second codebase. The name
  matters: the mint already returns `/p` rather than `/pay.html` because of *"eight
  characters off a link that a customer reads immediately before being asked for money"*.
  A proposal sent from a domain called **pay** presumes the sale.
  **Both hostnames stay one service.** A second deployment would create two customer-facing
  surfaces that can drift — which is exactly the failure the pay/manage 404 saga was.

- **D3 — The quote link FOLLOWS the quote. The pay token PINS.** One URL, minted once, sent
  once. It always renders the current version. Ops edits; the same link updates; ops says
  "updated it, have another look". Tapping Pay is what mints a revision-pinned token and
  freezes the amount.
  This is the core decision. Every content save bumps `revision` (`quoteRepo.ts:578` —
  *"a content write is a new revision, and that bump is what makes a pay link minted against
  the old price refuse to be paid"*), so a *pinned* quote link would die on every round of
  feedback. The owner's flow — send, they ask for edits, edit, send again, agree, send again
  — would produce three URLs for one trip, each older one a dead end reading "This quote has
  sailed off somewhere sunny". People scroll up in WhatsApp: they would tap the first link,
  see the dead end, and believe the trip was gone while a live link sat ten messages below.
  The safety property survives intact, because the freeze happens at commitment rather than
  at sending: **nobody can be charged an amount they were not shown.**

- **D4 — The mint is idempotent and the URL is stable.** Pressing "Copy quote link" twice
  yields a byte-identical URL — the same guarantee `payLinkSeq` already gives the pay link so
  ops can re-copy a link it already sent. The owner intends to re-paste the link into the
  chat rather than make the customer scroll: *"we might just keep sending becuase we may not
  want the customer keep scrolling up to find the link"*. With a following link that is free.

- **D5 — Read-only. The customer reads; ops writes.** No control on the page mutates the
  quote: no editing, no date picking, no "request a change" form. If the customer wants
  something different they message ops on WhatsApp, ops changes the quote, and the link
  updates. Choosing *which of two offered services to buy* is not editing the quote — it is
  choosing what to buy — and is the one customer action the page permits (D6).

- **D6 — `requestedService` drives which options appear.** The field already exists, is
  captured at intake, and a quote cannot reach `pending_review` or `ready` without it
  (`internalQuote.ts:1264`). No new switch and no new ops control:

  | `requestedService` | Page shows | Payable |
  |---|---|---|
  | `private` | one option | point-to-point |
  | `chauffeur` | one option | chauffeur |
  | `both` | two options side by side | either |

- **D7 — Approving a `both` quote is the sign-off on both numbers.** A reviewer approving a
  quote is looking at the ops service chooser with *both* totals on screen, priced against
  the card being locked. No second approval concept is introduced. The existing review gate
  is the gate.

- **D8 — One shared projection, three consumers.** The margin-safe view-model of a trip is
  extracted once and used by the quote page, the pay page, and the parked customer-quote
  email. `sendCustomerQuote()` in `notifications.ts` already takes a decoupled
  `CustomerQuoteView`, and its send-wiring has been parked since 2026-07-23 on the single
  blocker *"there is no customer-facing view/book a quote page today"*. This build is that
  page. Unifying the projection stops the three surfaces drifting in how they describe the
  same trip.

- **D9 — The share card carries the trip, never the total.** WhatsApp and Facebook fetch a
  link preview once and cache it against the URL for days — the reason `shareCard.ts` writes
  ride deadlines as fixed dates rather than countdowns. Because ops will re-send the same URL
  after an edit (D4), a price in the preview would show the *old* number under a page showing
  the new one. The card shows the route and the customer's name.

- **D10 — Content is the map, the day-by-day itinerary, and the options.** Photos of the
  destinations were considered and dropped: nothing maps a place name to a vetted photo, and
  it is the one item here with no existing machinery behind it.

## 3. What already exists (verified, not assumed)

| Need | Already built |
|---|---|
| Both services priced | `serviceChooserData()` prices the itinerary **both** ways against the quote's **locked** rate card, with no maps round-trip (`internalQuote.ts:423`) |
| Margin safety | Each side returns through `summary()` — total / deposit / amountDueNow only. No cost, no markup, no hot-zone annotation |
| Route map | `CH_MAP.renderRoute(host, stops)` — numbered pins, intermediate stops, expand-to-fullscreen with a legend, cached route computation, placeholder fallback with no key |
| Page copy | `payPageCopy()` — pure over the quote; returns product, greeting, title, subtitle, facts, legs, includedText, totalLabel |
| Page serving | `customerPages.ts` serves customer HTML + assets from the API host and rewrites `CEYLON_HOP_API` to `location.origin` |
| Expiry | `expireStaleQuotes()` closes `sent` quotes at 180 days off `sentAt`; `expired` is a reversible status |
| Price-drift visibility | `customerTotal` baseline, stamped when a customer-facing link is minted |

**Displaying two options needs no new pricing code and no data-model change.** *Selling* the
option that was not priced does — see §6.1, which is the only part of this design that
touches the money path.

## 4. Architecture

Three new modules, one extraction, one page.

```
quote.ceylonhop.com/q?t=<token>        (new custom domain → same API service)
   │
   ├─ GET  /quote-view?t=              quoteView.ts    → customerQuoteView projection
   └─ POST /quote-view/pay-intent      quoteView.ts    → returns pay.ceylonhop.com/p?t=<pinned>
                                                          for the chosen product
```

- **`api/src/quote/customerQuoteView.ts`** *(extraction)* — the margin-safe view-model.
  Absorbs `payPageCopy`'s output and adds the itinerary days, the map stops, and the option
  set. Pure over `(quote, options)`; no request, no I/O; unit-testable without a server.
  Consumed by `quoteView.ts`, `quotePay.ts` and `sendCustomerQuote()`.
- **`api/src/routes/quoteView.ts`** *(new)* — the customer half of quote links. Same two
  invariants as `quotePay.ts`, stated in its header: margin never reaches the wire, and
  **neither route in this module ever writes to the quote** — including `pay-intent`, which
  only validates and hands back a URL. Every write in this feature happens somewhere the
  customer cannot reach: the ops mint (`customerTotal`) and `/quote-pay/start`
  (`convertedBookingId`, `sold_product`).
- **`quote.html`** *(new)* — added to `customerPages.ts`'s `PAGES`, served at `/q`.
  Loads `ticket.css` for the shared travel-document language, plus its own stylesheet.

### 4.1 The following token

A new token kind, deliberately **not** a variant of the pay token. Packed like the others in
`bookingToken.ts`: `1 version + 1 purpose + 16 uuid = 18 bytes`, `PURPOSE_QUOTE_VIEW = 0x02`,
disjoint from `PURPOSE_QUOTE_PAY`. **It carries no revision and no seq**, so it cannot pin —
following is a property of the type, not of a branch in the code.

`signQuoteViewToken(quoteId, secret)` is deterministic, which is what makes D4 free.

### 4.2 State machine

Simpler than the pay page's, because `revised` cannot occur:

| State | When | Page |
|---|---|---|
| `live` | status `ready` or `sent` | the proposal |
| `booked` | quote `won`, or a settled booking | keepsake, reusing the pay page's paid screen language |
| `unavailable` | any other status, soft-deleted, expired, bad token | the "sailed off" screen |

`unavailable` is deliberately **soft** — no detail leak, same as `/quote-pay/view` returning
`{state:'unavailable'}` with a 200 for an unverifiable token.

## 5. The page

Four blocks, top to bottom. The design language is `ticket.css`; this is a proposal, so it
breathes more than the pay ticket does.

1. **Header** — greeting by first name, and the trip title and subtitle from the shared
   projection.
   **No "held until" date.** Ops quotes lock at approval with `rateLockedUntil = null` —
   they carry no rate-lock expiry (`rateLock.ts:8`), and the only other clock is the 180-day
   `sent` hygiene sweep, which is not a promise to a customer. A validity date on this page
   would be a commitment nothing enforces. If the business wants one, it needs to be a real
   stored field first.
2. **Route map** — `CH_MAP.renderRoute()` over the quote's stops, expandable. Falls back to
   the SVG placeholder when there is no key or routing fails, exactly as `booking.js` does.
3. **Day by day** — the itinerary as *days*, not the pay page's compact hop rail: date,
   route, distance, and what happens that day. Idle / `stay_day` legs are named honestly, but
   **not** surfaced as a priced sightseeing or rest line — chauffeur idle-day pricing is
   deliberately understated in quotes and must stay that way.
4. **Options** — one card, or two when `requestedService === 'both'`. Each card carries its
   total, what that service includes, **its own cancellation ladder** (chauffeur is capped at
   80% ten days out; a transfer is fully refundable to 24 hours — `pay.html` already switches
   on product and this must too), and its Pay button.

Below that: a WhatsApp line, which is the only route for anything the customer wants changed.

### 5.1 Degrading to one card on a `both` quote

`serviceChooserData` returns `{error: 'single-day — point-to-point only'}` for a one-day trip
and `{error: 'add a date to every leg'}` when any leg is undated — and tours default to blank
dates. On a `both` quote where chauffeur cannot be priced, the page shows the one option it
has. It must read as a complete page, not a broken two-card layout with a hole in it. Ops
sees the same error in the chooser at review time, so this is visible before sending.

## 6. Paying — the handoff

Tapping Pay on an option calls `POST /quote-view/pay-intent {t, product}`. The server
validates the token and the product against `requestedService`, then returns the existing
`pay.ceylonhop.com/p?t=<pinned>` URL. **The customer changes host at the moment they commit**
— a small, honest signal that something changed. The entire existing pay flow, its dead-end
screens, its decline recovery and its PayHere handoff are untouched.

### 6.1 Paying for the service that was not priced

On a `both` quote, one service is the quote's priced product and the other is a recompute.
Selling the recompute is a **money-path change** and needs the same rigor as the pay link
itself. It is bounded to `both` quotes:

- **Pay token v4** adds a 1-byte product discriminator. `0` = "the quote's priced product",
  which is what every existing v1/v2/v3 link means — so all live links keep working
  unchanged.
- `/quote-pay/view` and `/start` resolve the effective product from the token, price it via
  `toEngineRequest(tool, product)` against the **locked** card — the same call
  `serviceChooserData` already makes, so there is one pricing path, not two — and charge that
  total.
- `quoteToBooking()` takes a product override so the booking, the driver's itinerary and the
  confirmation email describe what was actually bought.
- The chosen product is written to the quote at booking creation (`sold_product`), so ops can
  see which option won. Without it the quote and its booking disagree about the product
  forever.

**Partial pay links stay scoped to the priced product.** A partial selection over a derived
product is a combination with no owner demand and a large test surface; it is explicitly out
of scope. `/pay-link` must refuse it rather than mint something untested.

## 7. Ops surface

One button in the quote builder beside "Payment link": **"Quote link"** — mint, copy, say so,
go quiet, exactly the one-press behaviour `copyPayLink()` already implements. Mintable from
`ready` and `sent`, the same gate as the pay link, and like it, minting does **not** move the
quote's status.

Minting stamps the `customerTotal` drift baseline, for the same reason the pay link does:
minting is a customer-facing moment, and with a following link the number can now move under
a customer who has already looked. The drift indicator is how ops sees that happened.

## 8. Error handling

- **No Maps key, or routing fails** → placeholder, page otherwise intact. The Maps key is
  referrer-restricted: `quote.ceylonhop.com` **must** be added to the allow-list or the map
  silently falls back with no error — the same trap as 127.0.0.1.
- **Bad / unverifiable token** → soft `unavailable`, no detail leak.
- **Quote un-priceable or legacy row** → `unavailable` rather than a 500. `lockedEstimate()`
  already degrades to `null` for a corrupt lock snapshot; the page must too.
- **`QUOTE_BASE_URL` unset** → the mint returns 503 `quote_links_unavailable`, matching how
  pay links already fail closed rather than minting a broken URL.

## 9. Testing

- **Unit** — `customerQuoteView` over the golden quotes: single, multi-leg, chauffeur, `both`,
  `both`-with-unpriceable-chauffeur, undated legs, soft-deleted. Assert **no margin field on
  any path** (the pay page's margin tests are the template).
- **Route** — the state machine across every quote status; the soft-unavailable contract; a
  token for a quote that gets edited still renders (the following property, asserted
  directly); `pay-intent` refuses a product the quote never offered.
- **Token** — v4 round-trip; v1/v2/v3 links still verify and resolve to the priced product;
  a view token is rejected by `verifyQuotePayToken` and vice versa.
- **e2e** (`web-tests/`) — open a live quote link, assert the map host and the day rows
  render, tap Pay, land on `/p`. Per the repo's own e2e lesson: **act, then verify** — assert
  against the state after the action, not the state that raced it.
- **Regression** — an existing pay link minted before this change still pays the same amount.

## 10. Build order

Two phases, because §6.1 is the only part that can charge a card and it should not ride in on
the same PR as a new page. Both phases are in scope — this is sequencing, not a reduction.

- **Phase 1 — the page.** New hostname, view token, `quoteView.ts`, the
  `customerQuoteView` extraction, `quote.html` with the map and the day-by-day itinerary, and
  the option cards. On a `both` quote both cards show both prices; the Pay button is live on
  the **priced** service and the other card's button routes to WhatsApp. Ships a complete,
  useful page with **zero change to the money path**.
- **Phase 2 — either option payable.** Pay token v4, product resolution in
  `/quote-pay/view` and `/start`, the `quoteToBooking` product override, and `sold_product`.
  Turns the second card's button live.

Phase 1 is worth shipping alone: `both` is the minority case, and every quote benefits from
the page.

## 11. Out of scope

- Photos of destinations (D10).
- Partial pay links over a derived product (§6.1).
- Customer-initiated edits of any kind (D5).
- Wiring `sendCustomerQuote()` to actually send. This build removes its blocker and shares
  its projection; turning the send on is a follow-up, and a small one.

## 12. Follow-ups this unblocks

1. **The parked customer-quote email** — template built and approved since 2026-07-23,
   blocked only on a Book-link destination. That destination now exists.
2. **Quote-page analytics** — opened, re-opened, which option was looked at longest. The
   funnel currently goes dark between "sent" and "paid".
