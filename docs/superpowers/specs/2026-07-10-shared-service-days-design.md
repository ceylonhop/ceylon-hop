# Shared-ride service-day enforcement (server-side)

**Date:** 2026-07-10
**Status:** design → implementation
**Scope:** `api/` only. The front-end analogue (calendar/`pickDate` guards + `days` on each
corridor in `transfers-data.js`) already ships; this is its server-side counterpart, in the
same spirit as the deferred server-side date-window enforcement.

## Problem

Shared seats run a **fixed weekly schedule**, not a daily one — every corridor currently
departs **Wed & Sat**. The website enforces this (it greys out non-service days and
`pickDate` refuses them), but the API does not: a shared booking hand-crafted against
`POST /bookings/shared` with an off-schedule date (e.g. a Monday) is accepted, holds a seat,
and creates a booking for a departure that never runs.

## Fix

Give the corridor model a service-weekday concept and reject out-of-schedule shared bookings
with a clear `400`.

## Design decisions

- **D1 — Representation.** `serviceDays: number[]`, weekdays as `0=Sun … 6=Sat` (JS
  `getDay()` convention), mirroring the front-end's `SHARED_DAYS = [3, 6]` in
  `transfers-data.js`. All six corridors are `[3, 6]` (Wed & Sat).

- **D2 — Source of truth is code, not a DB column.** The corridor catalogue (intermediate
  `stops`, and now `serviceDays`) already lives in `departureRepo.ts` `CORRIDOR_ROUTES`; the
  `corridor` table stores only endpoints + price + capacity. `serviceDays` is catalogue data
  of exactly the same kind as `stops`, so it lives in code — **no migration**. The Postgres
  repo merges it in via `serviceDaysForCorridor(id)`. `CORRIDOR_ROUTES` stays the single
  source the front-end mirrors.

- **D3 — Field name `serviceDays`, not `days`.** `schema.ts` already uses `days` for an
  unrelated integer (chauffeur car-retention day count on `tripRequests`). `serviceDays`
  avoids the collision and reads clearly.

- **D4 — Error shape & placement.** `{ error: 'not_a_service_day', message }` at HTTP **400**
  — consistent with the existing `date_in_past` (also a 400 with a message) and unlike the
  409 `sold_out` (which is an inventory conflict, not a bad request). Checked **after**
  corridor resolution (needs `corridor.serviceDays`) and **before** `holdSeats`, so an
  off-schedule request never holds a seat. The past-date check stays first, so a past date
  still reports `date_in_past`.

- **D5 — Only valid ISO dates are judged.** `isoWeekday` returns `null` for a non-ISO /
  absent value, and the rule skips when it can't determine a weekday — mirroring
  `isPastIsoDate`'s leniency. (`SharedBookingRequest` already requires a non-empty `date`;
  the site only posts `YYYY-MM-DD`.) Weekday is computed from the calendar fields in UTC so
  the result never drifts with the server timezone.

- **D6 — Schedule values.** Wed & Sat (`[3, 6]`) for every corridor, matching the front-end.

## Touch list

- `api/src/domain/dateRules.ts` — new pure helpers `isoWeekday`, `serviceDaysLabel` (+ tests).
- `api/src/db/departureRepo.ts` — `serviceDays` on `Corridor` + `CorridorRoute`,
  `SHARED_SERVICE_DAYS`, `serviceDaysForCorridor(id)`; map into `DEFAULT_CORRIDORS`. Update
  the "mirror the front-end" comment.
- `api/src/db/postgresDepartureRepo.ts` — `getCorridor` merges `serviceDays` from the catalogue.
- `api/src/routes/bookings.ts` — the `not_a_service_day` guard in `POST /bookings/shared`.
- `api/src/domain/shared.ts` — fix the stale "fixed daily corridor service" comment.
- `api/src/db/schema.ts` — fix the stale "daily shared service" comment.
- Tests: new route tests in `shared.test.ts`; happy-path shared fixtures in
  `shared.test.ts` / `smoke.test.ts` / `admin.test.ts` / `quotedTotal.test.ts` move off the
  coincidental Monday (`2026-07-20`) onto a service day.

## Out of scope

Per-corridor or seasonal schedules, and persisting `serviceDays` to Postgres, are not needed
while every corridor is a fixed Wed & Sat — revisit if schedules start to vary.
