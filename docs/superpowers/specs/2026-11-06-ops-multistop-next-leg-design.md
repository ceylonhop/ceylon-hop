# Ops queue: file a multi-stop trip by its next leg — design

Owner request 2026-11-05. Read against `origin/main` 704fa5cd.

## Problem

A multi-stop trip is filed in the ops Bookings queue by its FIRST leg's date only
(`services/opsView.ts` `travel()`: `b.input.dates?.find(Boolean)`). Once that date passes:

- `isOverdue` (ops-ui.html) is true, so the whole trip moves to **Needs closing** and drops out of
  **All open** and the **On trip** chip — while the customer is still travelling.
- Leg 3 tomorrow never appears under **Tomorrow**. Ops has to remember it by hand.
- **Mark all completed** (bulk close-out, #359) can tick that trip and close it mid-trip, because
  its only guard is "the row is in Needs closing".
- The booking pane's leg list (`legsHtmlFor`) shows every leg the same way; nothing says which
  have run and which is next.

## User stories

1. Ops planning tomorrow sees every trip with a leg tomorrow under **Tomorrow**, including trips
   that started days ago.
2. **Today** shows every leg running today.
3. A mid-trip row says which leg is coming ("Leg 3 of 4 · Ella → Yala").
4. A trip under way stays in **All open** and **On trip** until its last leg.
5. **Needs closing** holds only trips whose last leg has passed.
6. **Mark all completed** can never select a trip still in progress.
7. In the booking pane, legs that have run are struck out and the next leg is tagged **Next**.
8. Unchanged: the When line, the reschedule controls and the 24-hour reversal rule keep using the
   trip's START date.

## Decisions

- **A leg is done when its date is before today** (date-based, automatic). No per-leg status, no
  schema change. A leg dated today is not done. Owner-confirmable; the alternative (ops ticks each
  leg) needs a per-leg status column and is out of scope.
- **"Today" is the page's existing `TODAY`** (ops-ui.html `isoOf(new Date())`), the same day every
  other queue rule already uses.
- **`travelDate` / `t.date` keep meaning the start date.** `tripStartMs` (reversal window, must
  agree with `domain/reversalWindow.ts`), the "Balance due — travels today" reason, the When line,
  the server sort and the `?date=` filter all read it. Only the queue's grouping and in-group sort
  move to the new anchor.
- **Expired stays on the start date.** An unpaid trip whose first day has gone is dead money,
  whatever its later legs say.
- **Bulk close-out is kept unchanged.** It becomes safe for multi-stop trips because they no longer
  reach Needs closing early.

## Design

### 1. Server — legs on the queue row (`services/opsView.ts`)

`OpsBookingRow` gains one additive field (existing fields unchanged; the client tolerates its
absence, so mocked e2e rows keep working):

```ts
/** A trip's driven legs in order (date, from, to) — gaps (the customer's own travel) left out.
 *  Empty on every non-trip row. The queue files a trip under its next leg from these. */
legs: Array<{ date: string | null; from: string; to: string }>;
```

Built in `toOpsRow` from `deriveTripLegs` (`domain/bookingLegs.ts`) — the same definition the
`booking_legs` writer uses — keeping `kind !== 'gap'`. A chauffeur trip's `day` rows come out as
one entry per travel day. `[]` for single, shared and ride-board rows. No new reads: the input is
already on the loaded booking. Trip dates live only in `trip_request.dates`
(`setSchedule` refuses non-single bookings), so there is one source and no drift.

### 2. Client — the anchor date (`ops-ui.html`)

- `rowToTicket` carries `legs: row.legs || []` (mocked rows and board rows have none).
- New pure helper:

  ```js
  /* The date a trip files under: its next leg still to run (today or later), else its last leg,
     else the booking's own date. A single transfer has no legs, so this is just t.date. */
  const anchorDate=t=>{ … };
  ```

- `isOverdue` uses `anchorDate(t)` instead of `t.date`; `dayGroup`'s Today/Tomorrow checks and the
  render's in-group `tkey` sort use it too. `isExpired` keeps `t.date`.
- A row whose next leg is not its first shows `Leg N of M · From → To` beside the date (the
  "when" cell shows the anchor date). Undated legs count toward M but are never the anchor.

### 3. Booking pane — past legs struck out (`legsHtmlFor`)

`legsHtmlFor(d)` reads `TODAY` (passed in by the lift in its test). For each driven leg:
date `< TODAY` → `leg leg-done` (faded, struck, ✓); the first dated leg `>= TODAY` → `leg leg-next`
with a **Next** tag; undated and later legs unchanged; gap rows unchanged.

## Testing (tests first)

- `api/src/services/opsView.test.ts` / `routes/ops.bookings.test.ts`: a 3-leg private trip returns
  3 legs; a gap is left out; a chauffeur trip returns one entry per day; a single transfer returns
  `[]`; `travelDate` is unchanged (start date).
- `web-tests/unit/ops-day-groups.test.js`: started yesterday + leg tomorrow → Tomorrow; leg today →
  Today; every leg past → Needs closing; no legs → exactly today's behaviour; unpaid with first
  date past → still Expired.
- `web-tests/unit/ops-booking-views.test.js`: a mid-trip row is in All open and the On trip chip.
- `web-tests/unit/ops-bulk-close.test.js`: a mid-trip trip is never offered for bulk close.
- `api/src/routes/opsUi.legs.test.ts`: lift with `TODAY`; past legs get `leg-done`, the next gets
  `leg-next`; replace the hard-coded 2026-11-02 date (now past) with dates relative to today.
- Visual check in the preview: queue row label and the pane's struck-out legs.
- Gate: `cd api && npm run check` and `npm run test:all`.

## Out of scope

Per-leg completion status; per-leg driver assignment; per-leg customer reminders; the analytics
"Trips next 7 days" tile and the server `?date=` filter (still start date); automatic completion.

## Release

No migration, pricing or config. One PR to `main` (→ staging); prod via the usual promote, owner's
call. `ops-ui.html` is the shared hot file — keep the diff small and bring the branch up to date with
`main` right before merge.
