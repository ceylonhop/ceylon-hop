# Ops "Mark booked" creates a Booking — Design

**Date:** 2026-07-18
**Status:** drafted — pending owner review
**Phase:** Maintenance (tweaks & bug-fixing). Completes the deferred item from the
2026-06-30 quote-lifecycle spec: *"Auto-link won quote → booking (populate
`converted_booking_id`)."*

## Problem

Marking an ops quote "booked" (the teal button in the quote tool) only flips its status to
`won` — it creates **no** `Booking`. `markWon` → `markOutcome('won')` → a `PATCH` that sets
`status: 'won'` and nothing else. Consequences:

- Booked quotes never reach the bookings tab (the reported case: **Q-RDUCM** was marked
  booked but never appeared as a booking).
- `quotes.converted_booking_id` is declared but never written, so a won quote cannot be
  joined to the booking it became.

`bookings.create` is called in exactly three places — all the public `/bookings/*` routes.
Nothing in the ops flow creates a booking.

## Goal

Make "Mark booked" create a real, first-class `Booking` from the quote — behind a
confirmation modal — and populate the back-link (`converted_booking_id` + status `won`), so
the booking shows in the bookings tab and the quote is joinable to it.

## Scope

**In:**
- New endpoint `POST /admin/quote/:id/book` (added to `internalQuoteRoutes`, gated
  `bookings:operate`).
- A confirmation modal in the quote tool, triggered by the existing **"Mark booked"** button.
- Booking created as `draft`, priced at the **quote's frozen total** (never re-priced).
- Server-side quote→booking mapping module (`api/src/quote/quoteToBooking.ts`).
- Extend the `QuotePatch` interface with `convertedBookingId`; handle it in both repos.

**Out (deferred / by decision):**
- **Payment recording.** No manual-payment path exists today — the ledger is fed only by the
  PayHere checkout → webhook loop. The booking is created `draft`; recording the out-of-band
  payment is deferred to the future *"payment-link → webhook auto-creates the booking"* flow.
  **Consequence accepted:** the booking reads unpaid (balance due) until that lands.
- The **web self-serve** `converted_booking_id` stamp (the customer `/bookings/*` path) — a
  separate, smaller change if still wanted.
- Any pricing change; any DB schema/migration (`converted_booking_id` already exists); any
  change to the quote state machine (`won` stays terminal).

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Trigger = the existing "Mark booked" button**, which now opens a confirmation modal. On confirm the booking is created; **cancel leaves the quote untouched.** | The owner's ask: mark booked *creates* a booking, gated by a confirmation modal so the agent means it. Reuses the button already there — no second "Create booking" button. |
| D2 | **Button shows on `sent` OR `won`-without-a-`convertedBookingId`.** | `won` is terminal (`won → draft` is illegal — can't reopen), so an already-won quote like Q-RDUCM has no other route to the modal. Widening the show-condition rescues the backlog without touching the state machine. |
| D3 | **Approach A — dedicated server endpoint `POST /admin/quote/:id/book`.** | Server owns the price (quote total verbatim), does create + stamp in one round-trip, leaves the quote `PATCH` and the public booking routes alone. *Rejected:* overloading `PATCH /:id` (mixes booking-creation into dense maker-checker logic); client-orchestrated public route (re-prices, doesn't stamp, racy across two client calls). |
| D4 | **Booking created `draft`; payments subsystem untouched.** | No manual-payment path exists; payment is deferred (see Scope-Out). |
| D5 | **Price = `quote.totalCents` verbatim** (`total = amountDueNow = quote.totalCents`, `currency = quote.currency`); never recomputed. | Honor the agreed quoted price; keep the change out of the pricing engine. |
| D6 | **Idempotency key `book:quote:<id>`.** If the quote already has a `convertedBookingId`, or a booking exists for the key, return that booking instead of creating another. | Double-click / two-agent safe (no duplicate booking). A retry after a partial failure (booking created, stamp not yet applied) heals rather than duplicates. |
| D7 | **Modal requires the full web-booking customer set** — first name, last name, email, WhatsApp, country — plus travel date/time; pre-filled from the quote. The built input is validated against the existing `SingleTransferInput`/`TripInput` Zod schemas. | Owner call ("all standard fields required"); produces a first-class booking; reusing the existing validation makes a bad mapping fail loudly instead of persisting junk. |
| D8 | **Auth = `bookings:operate`** (per-route), on top of the tool-wide `quote:manage`. | Creating a booking is an operate action. Founder + ops hold both caps; finance (quote-only) gets `403` — consistent with the capability matrix. |
| D9 | **Mapping:** 1 driving leg → `single`; ≥2 legs or chauffeur → `trip` (chauffeur ⇒ `serviceType:'chauffeur'`, with `days`/`driverNights` from the quote's dated legs). Vehicle: `car → car`; `van_6/9/14/custom → van`. | Fits the booking's `single`/`trip` modes and 2-value `vehicleType`. The van-tier detail is lossy but is retained on the linked quote. |
| D10 | **No schema change / migration.** `QuotePatch` gains an optional `convertedBookingId` (internal interface, additive); the ops `PATCH /:id` zod schema is **not** extended, so the field stays system-set only. | The column already exists; keeping it off the PATCH schema keeps operators from setting it by hand. |

## Endpoint — `POST /admin/quote/:id/book`

**Middleware:** tool-wide `quote:manage` (existing global guard) + `bookings:operate`
(new, per-route) + `csrf` (state-changing, like `/save` and `PATCH`).

**Request body** — the fields the quote lacks or the agent confirms in the modal:

```
{
  customer: { firstName, lastName, email, whatsapp, country,
              phoneCountryCode?, phoneNumber?, marketingOptIn? },
  vehicleType: 'car' | 'van',
  pax: int,
  bags: int,
  date?: 'YYYY-MM-DD',   // single: the transfer date; trip: optional start date
  time?: 'HH:mm'
}
```

**Server flow:**
1. Load the quote → `404 not_found` if missing.
2. Reject unless `channel === 'ops'` **and** status ∈ {`sent`, `won`} → `409 not_bookable`.
3. **Idempotency:** if `quote.convertedBookingId` is set, return that booking (`200`).
   Otherwise check `bookings.findByIdempotencyKey('book:quote:' + id)`; a hit returns that
   booking (`200`).
4. `quoteToBooking(quote, body)` builds `{ mode, input }` — structure from the stored quote,
   contact/date/vehicle/pax from the body. Validate `input` against the mode's Zod schema →
   `400 invalid_booking` on failure.
5. `bookings.create({ mode, input, total: quote.totalCents, amountDueNow: quote.totalCents,
   currency: quote.currency, distanceKm, durationMin }, { idempotencyKey: 'book:quote:' + id })`.
   `distanceKm`/`durationMin` = best-effort sum of the quote legs' distances, else `null`.
6. Stamp the quote: `quotes.patch(id, { convertedBookingId: booking.id, status: 'won' })`.
7. Return `201` with the booking.

Create → stamp is **not** transactional (two repos, no shared transaction); D6 idempotency
is what makes a mid-failure retry safe. If step 6 throws after step 5, the booking persists;
the operator retries, step 3 returns the existing booking, and the stamp is re-applied.

## Mapping — `api/src/quote/quoteToBooking.ts` (pure, unit-tested)

Reads the stored quote's `request.engine` (the canonical `QuoteRequest`) and, where needed,
`request.tool` (leg detail). Rules:

- **Mode / stops:** private single-leg → `single` (`from`/`to` from the leg). Private
  multi-leg → `trip`, `stops` chained from the legs, `nights` = zeros. Chauffeur → `trip`,
  `serviceType:'chauffeur'`, `days` = distinct-date span, `driverNights = days − 1`, `dates`
  from the quote.
- **Vehicle:** tier → `car`/`van` (D9); the body's `vehicleType` overrides if the agent
  changed it.
- **Customer / date / pax / bags:** from the body (contact the quote lacks, the date/time the
  agent sets, pax/bags confirmed — defaulted from the quote where present). For `single`,
  `adults = pax` and `children = 0` (quotes track a single `passengerCount`, not a child
  split); `trip` uses `pax` directly.
- **Named edge cases (each tested):** non-contiguous legs (a stop hop is lost — acceptable,
  called out), undated private trip (dates left flexible / "to confirm"), custom & van14
  tiers (→ `van`), stay-day-only quote (already impossible — a quote requires a driving leg).

## Repo change

`QuotePatch` gains `convertedBookingId?: string`. `InMemoryQuoteRepo.patch` and
`PostgresQuoteRepo.patch` apply it when present (mirrors the existing "`undefined` = leave
alone" tri-state pattern). No other interface changes.

`internalQuoteRoutes` deps gain `bookings: BookingRepo`, injected in `app.ts` (the same repo
already constructed for `bookingRoutes`).

## UI — quote tool (`api/src/routes/ops-ui.html`)

- **Show condition:** the "Mark booked" button (`markWon` action) renders on `sent` (as
  today) **and** on `won && !convertedBookingId`.
- **Action change:** clicking "Mark booked" now **opens the booking modal** instead of
  directly transitioning to `won`. The old direct `sent → won` flip is replaced by the
  server-side create + stamp on modal confirm.
- **Modal:** pre-filled from the on-screen quote (name split, contact, legs, vehicle tier,
  pax, bags) plus the frozen total (read-only). Requires first/last name, email, WhatsApp,
  country, and date/time. Confirm → `POST /admin/quote/:id/book`; on success it closes,
  toasts, and refreshes (the quote now reads `won` + linked; the booking is in the bookings
  tab). Required-field validation runs client-side before submit.
- Once `convertedBookingId` is set, the button is replaced by a link to the booking.

## Error handling

`404` unknown quote · `409 not_bookable` (wrong status / non-ops channel) · `400`
(`invalid_booking` from Zod, or `bad_request` for a malformed body) · `403` (no
`bookings:operate`) · `200` already booked (idempotent) · `201` created. **No customer email
fires on create** — bookings are born `draft` and customer comms are milestone/webhook-driven,
so modal contact data is not emailed anywhere in this flow.

## Testing (TDD, red → green per CLAUDE.md)

- **Unit — `quoteToBooking`:** single, multi-leg private, chauffeur (asserts `days` /
  `driverNights`), each vehicle tier, non-contiguous legs, undated trip.
- **Route — `internalQuote.test.ts`:** booking a `sent` quote creates a `draft` booking at
  the quote's total and stamps `convertedBookingId` + `won`; booking a `won`-without-booking
  quote creates the booking and stays `won`; a double-POST returns one booking (idempotent);
  `bookings:operate` is enforced (finance → `403`); a non-ops channel or bad status → `409`;
  invalid contact → `400`; an already-linked quote → `200` with the same booking.
- **Repo:** `InMemoryQuoteRepo.patch` sets `convertedBookingId`; the Postgres repo round-trips
  it (existing harness).
- **web-tests:** the button appears on `sent` and on `won`-without-booking; the modal
  validates required fields; the happy-path POST creates and links.

## Rollout

Additive — new endpoint, one interface field, UI wiring. No migration (the column exists), no
pricing or schema change. Money-adjacent (creates a priced booking), so **this spec is the
owner sign-off**; the `main` deploy carries no migration.

## Open items (carried forward)

- Payment-link → webhook auto-creates/settles the booking — the eventual replacement for the
  manual modal on the payment side.
- The web self-serve `converted_booking_id` stamp (the original narrow task), if still wanted.
- Per-leg trip dates in the modal (v1 collects a single start date; refine later in the
  bookings tab).
