# Dateless booking capture — design

**Status:** design agreed in chat 2026-10-17; Phase 1 plan at
`docs/superpowers/plans/2026-10-17-dateless-booking-phase-1-ops-sets-schedule.md`.
**Facts below were read from `origin/main` @ `1f5111be`.**

## 1. Problem

The booking page lets a customer pay for a private transfer with the date and/or time left as
"Decide later" (`booking.html:985`). After that, nothing can put the date in:

- No ops route edits a booking's date — `api/src/routes/ops.ts` writes only `status` and `flags`.
- No customer route edits it — `api/src/routes/bookings.ts` has create/view/checkout only.
- The "we still need your details" email fires once, at payment (`webhooks.ts:472`), and only when
  the **date** is missing (`needsDetails`, `notifications.ts:313`); a missing **time** sends nothing.
- The scheduler skips undated bookings (`scheduler.ts:122-127`), so they never get the pre-trip reminder.
- The booking page copy promises "You can change this any time before you travel" — untrue today.

Ops already sees these bookings in the "No date yet" group (`ops-ui.html:2094`).

## 2. Where the date lives (the constraint everything follows)

For a single transfer the date/time is stored **twice**:

1. `transfer_request.travel_date` / `travel_time` — read back as `booking.input.date` / `.time`
   (`postgresBookingRepo.ts:296-309`).
2. `booking_legs.travel_date` / `pickup_time` — written once at creation
   (`postgresBookingRepo.ts:530`, via `deriveSingleLegs`).

Any edit writes **both in one transaction**. Pricing does not read date or time (no date term in
`services/pricing.ts` or `quote/rateCard.ts`), so a schedule edit never changes what is owed.

## 3. Decisions (owner, 2026-10-17)

- **D1 — Ops edits the booking itself** (approach A), with a history table — not a separate
  "confirmed date" column every reader would have to prefer.
- **D2 — Manage page is set-once.** A customer may fill a *blank* date/time; changing an already-set
  one goes through WhatsApp → ops.
- **D3 — Single private transfers first.** Chauffeur trips (a date per day) come later.
- **D4 — Ops alerts are email**, reusing the team-email pattern (`opsNotifications.ts`) and the daily
  digest; each new subject gets a fixed prefix (e.g. `Date set:`) so Gmail can filter it.

## 4. Rules every write path shares

- **Valid value:** `date` is a real `YYYY-MM-DD`; `time` is `HH:MM` (00–23:00–59) or null.
- **Not past, not too soon:** reject a date before today in Asia/Colombo, and anything
  `isTooSoonPrivate` (`dateRules.ts:61`) rejects — 12 h notice with a time, after-today without.
- **Not too far:** no later than 12 months ahead (the website's own `maxBookDate`, `booking.js:952`).
- **Editable bookings only:** `mode = 'single'` and status `paid` or `confirmed`.
- **No lost updates:** every write carries the value it expects to replace; a mismatch is a
  `409 conflict` that returns the current value.
- **History:** every applied change writes a `booking_schedule_events` row (from → to, actor type
  `staff`/`customer`, actor id, time).
- **Customer told:** an applied change can send the `schedule_set` email ("Your pickup is set for
  Tue 4 Nov · 09:00, Sri Lanka time"); it is best-effort and never fails the write.

## 5. Phases (each its own plan → branch → PR)

| Phase | Builds | Stories | Migration? |
|---|---|---|---|
| **1** | Ops sets/changes date & time in the booking sheet; history; `schedule_set` email; driver warning | O1, O2, A1, C4, C5, D1 | **Yes** — `booking_schedule_events` + `schedule_set` email kind |
| **2** | Reminders: `needsDetails` covers a missing time; reminder at ~2 d and ~7 d after payment with a WhatsApp CTA; "awaiting entry" pause; epoch fence + dry run; digest line for unanswered ones | C2, C3, O4, O6, A2 | **Yes** — two reminder email kinds + the pause flag |
| **3** | Queue + copy: "No date yet" shows days since paid, reminders sent, "time to confirm"; booking-page copy stops promising "change any time" | O3, C1 | No |
| **4** | Manage page set-once: same picker, same rules, `actor_type='customer'`, ops `Date set:` email, URGENT for next-day | C6, C7, O5 | No (reuses Phase 1 table) |

Phase 2 is blocked on the **no-reply policy** (§7). Phases 3 and 4 depend only on Phase 1.

## 6. Security notes

- The ops route sits behind `bookings:operate` and the same CSRF guard the other ops tools use
  (`opsRates.ts:44`). `ops.ts`'s existing POST routes have no CSRF guard — a separate issue, not fixed here.
- The manage link is a non-expiring, unscoped HMAC of the booking id (`bookingToken.ts:32-40`).
  Phase 4 makes it able to *fill a blank* only (D2), rate-limits it, records the change in history and
  emails the booking's own address — so a forwarded link cannot move an existing pickup.
  `manage.html:130` already strips the token from the address bar.

## 7. Open decisions (owner)

1. **No reply after two reminders** — keep the booking open with ops chasing, or offer a refund after N days? (blocks Phase 2's O6)
2. **Cancellation rule while undated** — "free cancellation 24 h before travel" has no anchor.
3. **Rough travel month at "Decide later"** (L1) — lets reminders be timed to the trip, not the payment.

## 8. Later (not scheduled)

L1 rough travel window · L2 flight number for airport pickups · L3 chauffeur trips (per-day dates) ·
L4 exact pickup spot.
