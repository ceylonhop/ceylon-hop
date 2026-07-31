# Quote payment links — design

**Date:** 2026-07-31 · **Owner decision session:** Roshen, via brainstorming + visual mockups
**Status:** approved design, ready for an implementation plan

## 1. Goal

The team runs the whole quote lifecycle in /ops (create → review → approve → mark sent →
mark booked) while the public site is dark. Today the only way to take card money for a
quote is to convert it to a booking by hand and collect out-of-band. This feature lets ops
attach a **payment link** to an approved quote, so the WhatsApp message that delivers the
quote also carries a way to pay — and the booking creates itself when the customer does.

The owner's lifecycle, verbatim:

| Quote stage | Meaning |
|---|---|
| **Ready to send** | payment link can be generated |
| **Sent** | ops sends quote + link manually over WhatsApp |
| **Won** (“Booked”) | the customer actually paid |

## 2. Decisions (all owner-confirmed)

- **D1 — Mechanism is the PayHere Checkout API.** PayHere (payhere.lk) has no
  link-creation API — its documented surfaces are Checkout, Charging (needs a pre-existing
  `customer_token`), Preapproval, Retrieval, Refund, Authorize, Capture; “Payment Links”
  exist only as a manual merchant-portal feature. A payment link is therefore **our page**
  that hands off to the hosted Checkout — the same integration the website already uses.
  The Preapproval+Charging pattern (authorise now, charge on confirmation) was considered
  and parked: it is a different product and needs a real tokenized adapter that doesn't
  exist yet.
- **D2 — The link writes nothing.** Generating a link creates **no booking and no DB row**.
  It is a signed URL over `{quoteId, revision}`. `payments.booking_id` is `NOT NULL`, so a
  booking must exist before checkout — it is created at the moment the customer commits to
  pay (D5). “Booked only if the customer pays” holds exactly.
- **D3 — Mintable from `ready` and `sent`; never changes quote status.** `ready` is the
  natural point — the link is part of what gets sent. Generating does **not** auto-mark
  `sent`: `sentAt` anchors the expiry clock and the aging report, `→ sent` auto-assigns
  the quote to the actor, and a link may be regenerated after revisions. Ops marks `sent`
  itself, exactly as today.
- **D4 — Amount is the full quote total.** Deposits/partial payments stay parked (owner:
  “I have not built the deposit logic yet”). The engine already sets
  `amountDueNowCents = totalCents`, so nothing changes in pricing.
- **D5 — Booking is created when the customer commits.** The pay page collects whatever
  `CustomerInput` fields the quote lacks (usually email + country; last name and WhatsApp
  when the quote's free-text contact can't supply them), then creates the booking at the
  quote's **frozen total** (never re-priced — same rule as `/admin/quote/:id/book`), moves
  it `draft → payment_pending`, stamps `convertedBookingId`, and opens PayHere. An
  abandoned checkout therefore leaves a booking in **Awaiting payment**, identical to the
  website's behaviour, and visible rather than hidden.
- **D6 — `won` means money arrived.** The quote's status is untouched at conversion.
  When the payment **settles** (PayHere webhook, or ops recording cash via mark-paid),
  the quote flips to `won` — `claimWonQuote(bookingId)`, the mirror of the existing
  `releaseWonQuote`. It must work from `sent` *and* `ready` (payment can land before ops
  marks sent; the DECIDED shortcut in `canTransition` already permits it). The Funnel's
  `won` tile and `wonValue` therefore mean received revenue. This deliberately changes the
  meaning `/book` gave `won` (“a booking exists”); the manual Mark-booked path keeps its
  current behaviour and is unaffected.
- **D7 — Token: signed, revision-pinned, dies with the quote.**
  `base64url({q: quoteId, r: revision}).hmacSHA256`, signed with `BOOKING_LINK_SECRET`
  (the customer-link secret; never the ops session secret), verified with
  `timingSafeEqual`. No independent expiry: the link is payable only while the quote is
  `ready` or `sent`, so quote expiry (180d), loss, or deletion kills it. **Revision
  mismatch never charges** — it renders the “quote updated” state. A bearer link is
  intended: anyone the customer forwards it to may pay it.
- **D8 — Page states.** The link wakes up in exactly one of:
  1. **Payable** — the ticket + *Pay with PayHere*.
  2. **Already paid** — full keepsake page: tick, “You're booked, {first name}”, booking
     reference chip, what-was-paid, “what happens next”, WhatsApp line. The Pay button is
     gone entirely.
  3. **Quote updated** (revision mismatch) — “This quote has been revised since this link
     was sent. We'll WhatsApp you a fresh link — nothing has been charged.”
  4. **Unavailable** (expired / lost / deleted / not-ready) — soft dead end: “This quote
     is no longer active — WhatsApp us and we'll sort it out.” No details are shown.
- **D9 — Content per product** (the “compact rule”, stress-tested in mockups):
  - **Single transfer** shows its journey: route as the title, date + pick-up, travellers,
    vehicle, km/duration, total.
  - **Multi-leg** shows **every leg**, because a multi-leg quote is separate bookings
    sharing one payment and the customer must be able to check each pickup. One thin row
    per leg: *place → place, date*. **No per-leg prices, no per-leg km.** Six legs fit a
    phone; quotes beyond ~5 legs are chauffeur-territory and get no special collapse.
  - **Chauffeur** shows its **shape**, not its itinerary: Trip (first → last stop, with
    “full day-by-day plan in your quote”), Days (“N with your driver, including your free
    days” — answers “why am I paying for N days?”), Travellers · vehicle, Starts (first
    date). An 18-day 15-stop tour renders at the same height as a 6-day one. The full
    itinerary lives in the quote ops sends alongside the link — this page's one job is
    the payment.
- **D10 — Visual design** (approved v2/v3 mockups): warm “travel document” on site.css
  tokens. Ticket card with perforated stub; total large in the stub (serif) + LKR
  approximation; greeting with first name. **Button is the site's `.btn .btn-cta`
  verbatim** — pill, `#D52812`, white text (the contrast-guarded system;
  `button-contrast.test.js` applies) — copy **“Pay with PayHere”**, with the wizard's
  “Pay securely to confirm. ${amount} — no extra fees.” line and card badges beneath.
  Desktop: the same ticket centred at ~470px on the postcard wash with the site header;
  never stretched. `noindex`, like manage.html.
- **D11 — Copy generation is deterministic** — `payPageCopy(quote)`, a pure function like
  `tripCal`; no free text, no AI. Greeting = first word of `customerName`, else the
  greeting line is omitted. Titles: single → the route; multi-leg → “{Count} journeys,
  {date range}” (count as a word for 2–12, digits beyond; date clause dropped if legs are
  undated); chauffeur → “{Span} days across Sri Lanka” (span from the same maths as
  `tripCal`, so the title can never disagree with “Total · N days”). Vehicle labels map
  customer-facing: `car → car`, `van_* → van`. Any unresolvable case falls back to
  first-stop → last-stop.

## 3. Architecture

New pieces are deliberately thin; everything heavy is reused.

```
ops (quote view, ready|sent)
  └─ POST /admin/quote/:id/pay-link            [new, ops-authed, CSRF]
       → { url: https://<site>/pay.html?t=<token> }   (stateless; same URL per revision)

customer
  └─ GET  /quotes/pay/view?t=…                 [new, public, token-authed]
       → { state, copy, facts, legs?, totals } (customer-safe projection — see §5)
  └─ POST /quotes/pay/start                    [new, public, token-authed]
       body: { customer: CustomerInput }
       → creates booking via quoteToBooking at quote.totalCents
         (idempotencyKey `pay:quote:{id}:r{revision}`), draft→payment_pending,
         patches convertedBookingId (status untouched),
         → { bookingId, checkoutToken }
  └─ POST /bookings/:id/checkout               [existing, unchanged]
       → PayHere params → hosted checkout / JS SDK popup

PayHere notify → existing webhook → settlement → booking paid
  └─ claimWonQuote(bookingId)                  [new, best-effort]
       quote = findByConvertedBookingId; if status ∈ {ready, sent} → won
  (also wired into POST /admin/bookings/:id/mark-paid — cash after a link sent)

pay.html                                        [new static page, web root]
  manage.html pattern: site.css + CEYLON_HOP_API + PayHere JS SDK; renders the
  ticket from /view, collects missing details, drives /start → checkout;
  onCompleted → poll /view until state=paid → keepsake.
```

**Idempotency & races.** `/start` is idempotent on the quote id + revision: a second tap
returns the same booking. If a payment already succeeded → `already_paid`, page shows the
paid state. Booking exists *before* checkout, so there is no “paid but nothing to settle
against” window — this is why D5's architecture was chosen over converting on the webhook.
Ops taking cash after sending a link is safe today (mark-paid's `already_paid` guard); the
quote still flips to won.

**Ops UI.** “Create payment link” on `ready`/`sent` quotes → shows the URL + Copy. When
`payhereMode !== 'live'` (new field on an ops config/whoami response), the button renders
a sandbox warning instead of a live-looking link — a sandbox link takes fake money and
marks real bookings Paid.

**Watchdog re-arm.** The stuck-payment sweep currently exempts `channel === 'whatsapp'`
wholesale (valid when every ops booking was settled by hand). Pay-page bookings keep
channel `whatsapp` but must be watched: change the exemption to skip only bookings with
**no pending gateway payment** — a booking whose PayHere checkout was started and
abandoned gets the ops alert + the customer recovery email, exactly like a website cart.

## 4. Error handling

- **State derivation, in precedence order:** (1) linked booking has a **succeeded**
  payment, or quote is `won` → **paid**; (2) token revision ≠ quote revision →
  **revised**; (3) quote `ready|sent` → **payable** — including when a
  `payment_pending` booking already exists from an earlier tap (the idempotent `/start`
  resumes it); (4) anything else (draft, review, lost, expired, deleted, missing) →
  **unavailable**. `won` is never `unavailable`: a paid customer reopening their link
  must always find the keepsake, not a dead end.
- Invalid/forged/garbled token → state `unavailable` (no detail leak, 200 with soft page).
- Revision mismatch → `/start` refuses with 409 `quote_revised`.
- `/start` on a non-payable state → 409 (`already_paid` / `quote_unavailable`).
- `quoteToBooking` throws (`QuoteNotBookableError` — shared/legacy quote) → the mint
  route already refuses at generation time (only priced private/chauffeur ops quotes can
  mint), so the customer can never reach this; belt-and-braces 409 on `/start`.
- Checkout/webhook failures: unchanged from the website flow (watchdog + recovery email).
- `claimWonQuote` is best-effort like `releaseWonQuote`: a flip failure logs and never
  breaks settlement; the daily tick is a natural retry point (idempotent — `won` stays won).

## 5. Security

- **Margin can never reach the page.** `/view` returns a hand-built projection (copy
  fields, facts, totals) — it never echoes `result`, `rateCardJson`, or `marginCents`.
  The projection is built server-side from the same stripped shapes finance/ops get.
- Token signed with `BOOKING_LINK_SECRET`; constant-time compare; ops secrets never
  involved. Bearer semantics are intended: whoever holds the link may view and pay it —
  correct for WhatsApp, and identical to the existing manage-link behaviour.
- `/start` validates `CustomerInput` fully (Zod) and rate-limits like other public writes.
- The pay page is `noindex`; the URL carries no PII.

## 6. Testing

- **Unit:** `payPageCopy` (titles per product, number-words, undated fallback, no-name
  greeting, vehicle labels); token round-trip, revision pinning, wrong-secret, tamper;
  `claimWonQuote` (from sent, from ready, idempotent, no-op on lost/expired, best-effort
  on repo failure — mirror of `releaseWonQuote`'s suite).
- **Route:** mint — allowed from ready+sent, refused from the other six statuses, quote
  status/sentAt/assignee untouched, same URL twice; view — four states, margin absent
  from the wire; start — creates once, idempotent on double-tap, 409 matrix
  (revised/paid/unavailable), booking lands `payment_pending` at the frozen total with
  `convertedBookingId` set; settlement — webhook flips quote to won, mark-paid flips too.
- **Watchdog:** link-booking with pending gateway payment alerts + recovery email;
  hand-settled booking still exempt (the ledger-keyed rule from #210/#207 evolves, its
  tests extend).
- **E2E (offline, stubbed API — the `ops-trip-calendar` pattern):** ops button mints and
  copies; pay.html renders all three products + paid + revised states from stubbed
  `/view` responses; act-then-verify, serial file.
- **No new migration**; nothing to preflight.

## 7. Shipping gates (build ≠ ship)

1. `PAYHERE_MODE=live` + live merchant credentials on Render (prod is on sandbox today —
   go-live checklist). The sandbox banner (D10/ops UI) makes the state visible meanwhile.
2. Owner walk-through on staging with a real sandbox payment end to end.
3. The WhatsApp message template ops pastes (quote + link) is the team's own copy — no
   product change needed, but agree the wording before first customer use.

## 8. Out of scope (explicit)

- Deposits / partial payments (parked; `docs/deferred-manual-payment-amounts.md`).
- PayHere Preapproval + Charging (“authorise now, charge on confirm”) — a future,
  arguably better product for tours; needs a real tokenized adapter and the fake-adapter
  prod guard first (`docs/known-bugs.md` 2026-07-26).
- Ops-editable trip title override (generated titles carry v1).
- Collapse UI for >N-leg multi-leg quotes (that shape belongs to chauffeur).
- Any change to the manual Mark-booked flow — it remains for cash-first customers.
