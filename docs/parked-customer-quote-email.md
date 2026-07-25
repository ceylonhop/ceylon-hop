# Parked: customer-quote email (send-wiring)

**Status: PARKED — owner call 2026-07-23.** The email *template* is built and approved
("template first"); the send-wiring is deliberately not built yet. Resume here when we want
ops to email quotes to customers.

## What IS built (on `feat/emails-boarding-pass`)
- `sendCustomerQuote(view, email, links)` in `api/src/services/notifications.ts` — renders a
  clean proposal from a decoupled `CustomerQuoteView` (itinerary timeline + dates/nights,
  service/vehicle/pax, "what's included", one total, "held until" validity, Book CTA).
  Deliberately **no internal per-leg/margin breakdown** (owner decision).
- Previewable now: `GET /dev/emails/customer-quote` (dev harness) with `sampleQuote`
  in `api/src/services/__fixtures__/sampleBookings.ts`.
- Sending is NOT a gap — Resend is already the adapter for every email; this function would
  send the moment something calls it.

## What is PARKED (the send-wiring)
The quote email has no automatic trigger (unlike every other email, which fires off a system
event). A human sends it. To finish, we need:

1. **A trigger.** An ops action that calls `sendCustomerQuote`. Cleanest: hook it onto the
   quote lifecycle's existing "mark as sent" step (`routes/internalQuote.ts`) rather than a
   separate button. Verify what that transition currently does.
2. **The Book link destination.** The email's "Book this trip" button needs somewhere to go.
   There is no customer-facing "view/book a quote" page today — either build a small one or
   point the link at the booking flow pre-filled from the quote (signed link, reuse the
   `BOOKING_LINK_SECRET` / `bookingToken.ts` HMAC pattern).
3. **A quote → `CustomerQuoteView` map.** Small transform from the DB quote
   (`request_json.tool` legs + `result_json`) into the clean view-model. Lives in the trigger.
4. **⚠️ Verify first: does the quote store the customer's EMAIL?** Ops captures a customer
   name (split first/last); confirm an email address is captured on the quote — without it we
   can't address the message, and that's a field to add before any of the above.
5. *(Optional)* Tracking: a `quotes.customer_emailed_at` column (migration, auto-applies to
   staging on merge) so ops can see a quote was sent.

## Related
- Itinerary data lives on the Quote, not the Booking — see the booking/quote data-model map
  work from 2026-07-23. Route variants, idle/`stay_day` legs, sightseeing/wait flags, and
  per-leg line items are all on the quote's `request_json.tool` / `result_json`.
