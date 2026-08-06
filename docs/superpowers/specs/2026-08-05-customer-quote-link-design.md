# Customer quote link — design

**Date:** 2026-08-05 · **Owner decision session:** Roshen, via brainstorming
**Status:** approved design, ready for an implementation plan

## 1. Goal

Today a quote reaches the customer as a WhatsApp message: typed prose, a price, and — when
they asked about both services — a sentence appended by `appendChauffeurUpsell()` reading
*"If you'd prefer the chauffeur-guide option … that would be $X total."* There is nothing to
look at. The only customer-facing page a quote can produce is the **pay page**, which is a
checkout: it exists to remove friction between *decided* and *paid*.

This gives a quote its own page — a **proposal**. It shows the trip on a map, lays the
itinerary out day by day, and shows both prices when the customer asked about both services.
It is read-only, and **it cannot reach the money path at all**. When the customer agrees, ops
sends the existing pay link.

The owner's framing, verbatim:

> "the quote link should just be a much more robust we could even add the map where people
> can see their route etc."

> "no we dont give customers ability to update the quote, we update it if they want"

> "Customer can choose which one they want. However, both options only show if they asked
> for quotes for both options. Usually it will be the one option they asked for"

> "If a customer were to agree we can send a pay.ceylonhop.com link. Therefore pay is
> isolated from risk incase the csutoemr shared the link publickly?"

## 2. Decisions (all owner-confirmed)

- **D1 — A separate page, not a mode of `pay.html`.** Different jobs. The pay page is a
  checkout: one column, one number, one button. The quote page is a proposal — opened
  repeatedly, forwarded to a travel companion, sat on for days. A map, a day-by-day itinerary
  and an option comparison inside the ticket layout would make it a worse checkout *and* a
  worse proposal.

- **D2 — New hostname `quote.ceylonhop.com`, same API service.** `pay.ceylonhop.com` is
  already a custom domain on the API, which serves `pay.html`/`manage.html` itself out of
  `customerPages.ts` and injects `window.CEYLON_HOP_API = location.origin`. A second custom
  domain on the *same service* is same-origin with the API for free — no CORS work, no second
  deployment. The name matters: the mint already returns `/p` rather than `/pay.html` because
  of *"eight characters off a link that a customer reads immediately before being asked for
  money"*. A proposal sent from a domain called **pay** presumes the sale.
  **Both hostnames stay one service** — a second deployment would create two customer-facing
  surfaces that can drift, which is what the pay/manage 404 saga was.

- **D3 — The quote link FOLLOWS the quote. The pay token PINS.** One URL, minted once, sent
  once, always rendering the current version. Ops edits; the same link updates.
  Every content save bumps `revision` (`quoteRepo.ts:578` — *"a content write is a new
  revision, and that bump is what makes a pay link minted against the old price refuse to be
  paid"*), so a *pinned* quote link would die on every round of feedback. The owner's flow —
  send, they ask for edits, edit, send again, agree, send again — would produce three URLs
  for one trip, each older one a dead end reading "This quote has sailed off somewhere
  sunny". People scroll up in WhatsApp: they would tap the first link, see the dead end, and
  believe the trip was gone while a live link sat ten messages below.

- **D4 — The mint is idempotent and the URL is stable.** Pressing "Copy quote link" twice
  yields a byte-identical URL — the guarantee `payLinkSeq` already gives the pay link. The
  owner intends to re-paste rather than make the customer scroll: *"we might just keep
  sending becuase we may not want the customer keep scrolling up to find the link"*.

- **D5 — Read-only. The customer reads; ops writes.** No control mutates the quote. If the
  customer wants something different they message ops, ops changes the quote, the link
  updates.

- **D6 — No Pay button on the quote page. The money path is unreachable from a quote link.**
  This is the decision that makes a shared or forwarded quote link safe. Every option card's
  call to action is *"message us to book"* — a WhatsApp deep link. When the customer agrees,
  ops mints and sends a `pay.ceylonhop.com` link in the thread they are already in.
  A leaked quote link therefore exposes a name, an itinerary and a price, and **nothing it
  can reach writes anything or starts a payment**. The pay link stays what it is today:
  revision-pinned, and only in the hands of someone ops chose to send it to.
  This also removes the entire "pay for the service that wasn't priced" problem. Because ops
  mints the pay link *after* the customer chooses, ops sets the product — switching the
  quote's service and minting is the existing workflow. No product discriminator in the pay
  token, no `quoteToBooking` override, no derived-product pricing path, no new column.
  **This feature changes nothing about how money moves.**

- **D7 — `requestedService` drives which options appear.** The field exists, is captured at
  intake, and a quote cannot reach `pending_review` or `ready` without it
  (`internalQuote.ts:1264`). No new switch:

  | `requestedService` | Page shows |
  |---|---|
  | `private` | one option |
  | `chauffeur` | one option |
  | `both` | two options, side by side on wide screens, stacked on a phone |

  Every card carries a price ops must be willing to honour, so approving a `both` quote is
  the sign-off on both numbers — the reviewer sees both in the ops service chooser, priced
  against the card being locked. The existing review gate is the gate.

- **D8 — Link liveness is status-driven. No TTL in the token.** Live while the quote is
  `ready` or `sent`; dead when it is `lost`, `expired`, `won` or soft-deleted. This keeps the
  URL byte-stable (D4) and gives ops an **instant kill switch** a timer cannot: marking a
  quote lost kills its link immediately. The 180-day `expireStaleQuotes` sweep remains the
  backstop.
  A hard link TTL was considered and rejected: the sweep was raised 30 → 180 days precisely
  because the team parks quotes in `sent` as a working state (44 live when measured, the
  oldest 18 days old), so a short link timer would kill links on active quotes.

- **D9 — A 7-day offer validity, stored and shown.** Separate from link liveness: this is how
  long the *price* is honoured. Today it is honoured forever — ops quotes lock at approval
  with `rateLockedUntil = null`. A new stored field is set when a quote is approved, and the
  page shows "held until 12 August". Past it the page reads as **lapsed** and invites the
  customer to get in touch for a current price.

- **D10 — One shared projection, three consumers.** The margin-safe view-model is extracted
  once and used by the quote page, the pay page, and the parked customer-quote email.
  `sendCustomerQuote()` already takes a decoupled `CustomerQuoteView`, and its send-wiring has
  been parked since 2026-07-23 on the single blocker *"there is no customer-facing view/book
  a quote page today"*. This build is that page.

- **D11 — The share card carries the trip, never the total.** WhatsApp and Facebook fetch a
  preview once and cache it against the URL for days — the reason `shareCard.ts` writes ride
  deadlines as fixed dates. Because ops re-sends the same URL after an edit (D4), a price in
  the preview would show the old number under a page showing the new one.

- **D12 — Content is the map, the day-by-day itinerary, and the options.** Photos of
  destinations were considered and dropped: nothing maps a place name to a vetted photo.

- **D13 — Shared design language, but not the ticket chrome.** The page uses `ticket.css`'s
  palette, type pairing, radii, card treatment and the `.hop` rail idiom — but **not** the
  perforation, the tear line or the stub. Those are a boarding pass: they say *you have
  bought this*. A quote has not been bought, and dressing a proposal as a ticket implies
  otherwise. The ticket chrome stays exclusive to `pay.html`, so tearing off a stub remains
  the visual reward for paying.
  Designed in `docs/prototypes/customer-quote-page.html`.

## 3. What already exists (verified, not assumed)

| Need | Already built |
|---|---|
| Both services priced | `serviceChooserData()` prices the itinerary **both** ways against the quote's **locked** rate card, no maps round-trip (`internalQuote.ts:423`) |
| Margin safety | Each side returns through `summary()` — total / deposit / amountDueNow only. No cost, no markup, no hot-zone annotation |
| Route map | `CH_MAP.renderRoute(host, stops)` — numbered pins, intermediate stops, expand-to-fullscreen, placeholder fallback with no key |
| Page copy | `payPageCopy()` — pure; returns product, greeting, title, subtitle, facts, legs, includedText, totalLabel |
| Page serving | `customerPages.ts` serves customer HTML + assets from the API host, rewriting `CEYLON_HOP_API` to `location.origin` |
| Consent + analytics | `consent.js` and `analytics.js` are already in the served asset list |
| Backstop expiry | `expireStaleQuotes()` closes `sent` quotes at 180 days off `sentAt`; `expired` is reversible |

**This feature needs no new pricing code and no change to the money path.** The only schema
change is D9's validity field.

## 4. Architecture

```
quote.ceylonhop.com/q?t=<token>     (new custom domain → same API service)
   └─ GET /quote-view?t=            quoteView.ts → customerQuoteView projection
```

One endpoint. It reads, and nothing else.

- **`api/src/quote/customerQuoteView.ts`** *(extraction)* — the margin-safe view-model.
  Absorbs `payPageCopy`'s output and adds the itinerary days, the map stops, and the option
  set. Pure over `(quote, options)`; no I/O; unit-testable without a server. Consumed by
  `quoteView.ts`, `quotePay.ts` and `sendCustomerQuote()`.
- **`api/src/routes/quoteView.ts`** *(new)* — two invariants in its header: margin never
  reaches the wire, and **this module never writes**. There is no POST.
- **`quote.html`** *(new)* — added to `customerPages.ts`'s `PAGES`, served at `/q`, loading
  `ticket.css` plus its own stylesheet, `consent.js` and `analytics.js`.

### 4.1 The token

A new kind, deliberately not a variant of the pay token. Packed like the others in
`bookingToken.ts`: `1 version + 1 purpose + 16 uuid = 18 bytes`, `PURPOSE_QUOTE_VIEW = 0x02`,
disjoint from `PURPOSE_QUOTE_PAY`. **No revision, no seq, no expiry** — following is a
property of the type, not a branch in the code, and liveness is read from the quote (D8).
`signQuoteViewToken(quoteId, secret)` is deterministic, which is what makes D4 free.

A view token must be rejected by `verifyQuotePayToken` and vice versa.

### 4.2 State machine

| State | When | Page |
|---|---|---|
| `live` | `ready` or `sent`, within the validity window | the proposal |
| `lapsed` | `ready` or `sent`, past `offerValidUntil` | the proposal, prices marked out of date, invited to get in touch |
| `booked` | `won`, or a settled booking | keepsake; payload carries the booking's manage-link URL for "View your booking" |
| `unavailable` | any other status, soft-deleted, bad token | the "sailed off" screen |

`unavailable` is deliberately **soft** — no detail leak, matching `/quote-pay/view` returning
`{state:'unavailable'}` with a 200 for an unverifiable token.

### 4.3 Caching

`/quote-view` responses must be sent `Cache-Control: no-store`. A following link whose
response is cached anywhere — CDN, proxy, browser — silently becomes a pinned link, which is
the exact behaviour D3 exists to avoid, failing in the way that is hardest to notice because
it works for whoever tests it first. **Verify whether Cloudflare proxies this hostname before
launch**, and assert the header in a route test.

### 4.4 Map cost

`routeCache` in `ch-map.js` is memoised **per page load** (its own comment says so), so today
every open bills one `computeRoutes` call. This page is designed to be opened repeatedly and
forwarded to a travel group, and D4 encourages re-sending the link — so the naive wiring
turns one quote into dozens of billable calls.

Two mitigations, both required:

1. **Server-side route cache**, keyed on the ordered stop list and shared across quotes. Route
   geometry for a given stop chain is stable, and the same corridors recur constantly across
   quotes, so the hit rate is high. The client renders from the cached geometry and only
   computes live on a miss.
2. **Defer the map** until it scrolls into view, so an open that never reaches it costs
   nothing.

Two more map requirements, both learned from the prototype:

- **A muted map style is part of the build, not a polish item.** Default Google tiles — POI
  pins, road shields, saturated parks — fight the page's cream-and-teal design everywhere.
  The live map needs a Google cloud style (desaturated terrain, POI labels off) so it sits
  inside the `.ticket` card instead of shouting from it.
- **The fallback is designed, not apologised for.** The stylized-island SVG in the prototype
  *is* the no-map state — stops as numbered pins on a hand-drawn island, matching the share
  card's art. Given the referrer-key trap makes a silent fallback the likely first-deploy
  state, the fallback must look intentional.

## 5. The page

Mobile-first: these links are opened from WhatsApp, so the ~375px layout is the primary
design and the wide layout is the variant. Four blocks — **decision information first, the
itinerary as supporting detail**. The share card deliberately carries no price (D11), so
this page is the first place the customer sees a number; it must not be three screens down.

1. **Header** — greeting by first name, trip title and subtitle, **the total in the hero**
   ("$840 · all-in · private transfers"; on a `both` quote, both numbers: "$840 · or $1,180
   with your driver throughout"), and **"held until <date>"** from D9's stored field. The
   lapsed state reuses the same held-until row in amber — one visual system across states,
   and no state gets its own layout.
2. **Route map** — `CH_MAP.renderRoute()` over the quote's stops, expandable, deferred until
   visible (§4.4). Falls back to the designed SVG placeholder when there is no key or
   routing fails. `ch-map.js` fixes the inline height at 260px; the quote page needs its own
   height on a phone rather than inheriting that.
3. **Options** — one card, or two when `requestedService === 'both'`: side by side from
   560px, **stacked on a phone**. Each carries its total, what that service includes, its
   own cancellation ladder (chauffeur is capped at 80% ten days out; a transfer is fully
   refundable to 24 hours — `pay.html` already switches on product and this must too), and a
   WhatsApp CTA. No Pay button (D6). On a `both` quote the second card carries a **delta
   line** ("+$340 — your driver stays with you throughout"), so the page does the arithmetic
   rather than making the customer diff two Included paragraphs.
4. **Day by day** — the itinerary as *days*, below the offer it supports.

**Every CTA is a `wa.me` deep link with prefilled text** naming the quote reference and, on
an option card, the tapped option — *"Hi! I'd like to book the chauffeur & guide option for
quote Q-7F3KX"*. Without the prefill both buttons open the same bare chat, ops receives
"hi", and has to ask which option — the round-trip this page exists to remove. The prefill
is the mechanism by which the customer's choice reaches ops (D6: ops switches the priced
service if needed and mints the pay link).

**First paint gets a skeleton.** `ticket.css` grew `.tk-sk` precisely because pay.html's
unskeletoned first paint jumped, and this page is heavier. Same idiom, this page's own shape.

**The booked state links onward.** Its payload carries the booking's manage-link URL, so
"View your booking" hands the customer to `manage.html` — the keepsake must not be a dead
end when the booking now has a real home.

### 5.1 What a day row is built from

There is **no free-text per-day description anywhere in the data**. `ToolLegSchema` carries
`category`, `date`, `from`, `to`, `distanceKm`, `stops[]` and fee flags; quote-level `notes`
is the send-back reason field, not a customer description. So a day row is generated from
structured fields only:

| Leg | Renders as |
|---|---|
| driving (`transfer`, `airport`, `train_support`) | route bold · date in the mono caption (`hop-d`'s ticket.css duty) · **distance and duration at body size** — they are primary information on this page and must not be set in caption type |
| `stay_day` | date · "In <place>" — named, and nothing more |
| `addSightseeingFee` / `addWaitingFee` / `addSafariWait` | included time on that day, phrased as inclusion, never as a priced line |

**Gap days are synthesized.** The data only has legs, so a trip dated 20–28 with legs on
20/22/24/28 would render a section titled "Day by day" with days visibly missing — and a
customer will count. Every calendar day between the first and last leg date renders: days
with no leg become quiet "In <the last place reached>" rows, and consecutive identical ones
collapse into a range ("MON 25 – WED 27 AUG · In Ella"). Pure date arithmetic in the
projection; no new data. If any leg is undated, synthesis is skipped and the section falls
back to journeys-only.

Chauffeur idle-day pricing is deliberately understated in quotes and must stay that way: a
`stay_day` or synthesized gap day is never surfaced as a priced sightseeing or rest line.

An ops-authored per-day description would make this page substantially better, but it is a
new field plus new ops UI — see §10.

### 5.2 Degrading to one card on a `both` quote

`serviceChooserData` returns `{error: 'single-day — point-to-point only'}` for a one-day trip
and `{error: 'add a date to every leg'}` when any leg is undated — and tours default to blank
dates. The page then shows the one option it has, and must read as a complete page rather
than a two-card layout with a hole in it. Ops sees the same error in the chooser at review
time, so it is visible before sending.

## 6. Booking — the handoff

There is no handoff in software. The customer messages ops; ops mints the existing pay link
and sends it. The pay flow, its dead-end screens, its decline recovery and its PayHere
handoff are untouched, and no code in this feature can start a payment (D6).

## 7. Ops surface

One button beside "Payment link": **"Quote link"** — mint, copy, say so, go quiet, the
one-press behaviour `copyPayLink()` already implements. Mintable from `ready` and `sent`, the
same gate as the pay link, and like it, minting does not move the quote's status.

Minting stamps the `customerTotal` drift baseline, for the reason the pay link does: minting
is a customer-facing moment, and with a following link the number can move under a customer
who has already looked. The drift indicator is how ops sees that happened.

**D9's validity field** is set on the transition into `ready`, as approval date + 7 days, and
reset on re-approval. It gates the quote page's display only — it does **not** block minting
a pay link, because honouring a lapsed offer is ops's call to make.

## 8. Error handling

- **No Maps key, or routing fails** → placeholder, page otherwise intact. The Maps key is
  referrer-restricted: `quote.ceylonhop.com` **must** be added to the allow-list or the map
  silently falls back with no error — the same trap as 127.0.0.1.
- **Bad / unverifiable token** → soft `unavailable`, no detail leak.
- **Quote un-priceable or legacy row** → `unavailable`, never a 500. `lockedEstimate()`
  already degrades to `null` for a corrupt lock snapshot; the page must too.
- **`QUOTE_BASE_URL` unset** → the mint returns 503 `quote_links_unavailable`, matching how
  pay links already fail closed rather than minting a broken URL.

## 9. Testing

- **Unit** — `customerQuoteView` over the golden quotes: single, multi-leg, chauffeur, `both`,
  `both`-with-unpriceable-chauffeur, undated legs, multi-stop legs, soft-deleted. Assert **no
  margin field on any path** (the pay page's margin tests are the template). Day-row
  generation per leg category, including that a `stay_day` never renders a price; **gap-day
  synthesis** — a 20–28 trip with legs on 20/22/24/28 yields a row for every calendar day,
  consecutive identical stays collapsed to one range row, and synthesis skipped when any leg
  is undated. The `both` delta line equals the difference of the two card totals.
- **Route** — the state machine across every quote status; the `lapsed` boundary either side
  of `offerValidUntil`; the soft-unavailable contract; **`Cache-Control: no-store` asserted**;
  and the following property asserted directly — a token for a quote that is then edited
  still renders, showing the new content.
- **Token** — round-trip; a view token rejected by `verifyQuotePayToken` and vice versa.
- **Migration** — the validity column auto-applies on boot (merging it is its release), so it
  must be nullable and every existing quote must render with it null.
- **e2e** (`web-tests/`) — open a live quote link on a mobile viewport, assert the hero
  total, the map host, the day rows and both option cards render stacked; assert each CTA's
  `wa.me` href carries the quote reference and, on an option card, that option's name. Per
  the repo's e2e lesson: **act, then verify** — assert against the state after the action,
  not the state that raced it.
- **Regression** — pay links and the pay page are untouched by this branch; the existing pay
  suites must pass unchanged.

## 10. Out of scope

- Photos of destinations (D12).
- An ops-authored per-day description (§5.1) — a real improvement, but a new field plus ops
  UI, and the page is useful without it.
- Customer-initiated edits of any kind (D5).
- Any change to the money path (D6).
- Wiring `sendCustomerQuote()` to send. This build removes its blocker and shares its
  projection; turning the send on is a small follow-up.

## 11. Reconciling two earlier documents

- **`docs/prototypes/customer-quote-share-card.html` (28 Jul) — still live.** It designs the
  WhatsApp unfurl card that sits on top of this page, and D11 follows it. Its open question
  (b) — *"is 7 days the right shelf life"* — is answered yes by D9, but its **mechanism does
  not work**: it assumed the link expires with `rateLockedUntil`, which is `null` for ops
  quotes (they lock at approval with no expiry), so there was nothing to expire against.
  Hence a stored field. Its question (a) — *"does the customer page need the pay button in
  the first cut"* — is answered no, permanently, by D6.
- **`docs/superpowers/specs/2026-07-23-deposits-balance-payments-design.md` Slice 1 —
  superseded for the page and token.** It specced `ceylonhop.com/quote.html?t=` keyed on a
  stored random `payToken` column with `GET /pay/quote/:token`. Pay links then shipped on
  **signed stateless tokens**, and this design follows what shipped. The deposits work itself
  is untouched and still parked.

## 12. Follow-ups this unblocks

1. **The parked customer-quote email** — template built and approved since 2026-07-23,
   blocked only on a Book-link destination. That destination now exists.
2. **Quote-page analytics** — opened, re-opened, which option was looked at longest. The
   funnel currently goes dark between "sent" and "paid".
