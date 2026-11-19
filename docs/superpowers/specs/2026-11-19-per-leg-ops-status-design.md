# Per-leg ops steps for private multi-stop trips — design

Status: **approved by owner 2026-11-19** (design + UX mockup) · checked against `main` at `bc7faabc`

## Problem

A multi-stop booking has one ops status for the whole trip. When ops click Confirm vehicle →
Confirm pickup → Mark on trip → Mark completed for the first leg, the whole booking becomes
Completed, leaves the open queue, and the later legs are never handled.

Reproduced 2026-11-18 on a local copy of `main` with a paid 3-leg private trip (21, 23, 25 Nov):
four clicks closed the booking with two legs still to run.

Cause (verified):

- `ride_ops` is keyed by `booking_id` with a single `fulfilment_status` (`api/src/db/schema.ts:776-779`).
- `completed` is terminal (`api/src/domain/rideStatus.ts:19`), so ops cannot reopen it.
- The queue hides completed bookings from "All open" (`api/src/routes/ops-ui.html:2318-2324`).
- The first "Mark completed" also sets the booking itself to `completed` (`api/src/routes/ops.ts:118-123`),
  which triggers the review-request email (`api/src/services/scheduler.ts:191`) — inferred, not reproduced.

## What ops will see

- **Drawer.** Each leg in the itinerary shows its own stage: Paid, Vehicle confirmed, Pickup
  confirmed, On trip, Done. The main button acts on the current leg and names it, for example
  "Confirm vehicle · leg 2 of 3 · Kandy → Ella".
- **Queue.** The trip stays one row. Its stage chip shows the current leg's stage, so after leg 1
  is done the row returns to "Needs vehicle" for leg 2.
- **Closing.** The booking becomes Completed, and leaves the open queue, only when the last leg is
  marked done.
- **Ticks.** "Photo in" and "Customer contacted" become per leg.
- **Cancel.** Hidden on a trip once its first leg is on trip (see Booking status below).

## Scope

In scope: **private multi-stop trips** (`mode = trip`, `serviceType = private`) that have stored
leg rows.

Unchanged:

- Single transfers, shared seats, ride board — keep the booking-level status.
- Chauffeur-guide trips — one car and driver for the whole journey, so one status.
- Older trips with no stored legs — keep the booking-level status (fallback).
- No-show — still closes the whole booking.

## Data

New ops-owned table, one row per driven leg (`kind = 'leg'`; gaps are not driven):

| column | notes |
|---|---|
| `leg_id` | primary key, references `booking_legs.id` |
| `fulfilment_status` | same values and transition rules as `ride_ops`, default `paid` |
| `vehicle_photo_received`, `customer_updated` | per-leg ticks |
| `vehicle_confirmed_at`, `updated_at` | timestamps |

- A leg with no row counts as `paid`, the same lazy pattern `ride_ops` uses.
- `booking_legs.id` is already the stable key for post-booking add-ons
  (`api/src/db/postgresAddOnRepo.ts:42`); nothing removes a leg (`api/src/db/addOnRepo.ts:149`),
  and trip dates cannot be edited in the ops tool (`api/src/db/postgresBookingRepo.ts:749`).
- **Migration:** additive — one new table, no change to existing rows. It applies to staging when
  PR 1 merges to `main`, and to prod only on a `main → production` promote.

## API

- New: set a leg's status, set a leg's ticks (same capability as today's booking-level endpoints).
- The existing booking-level status endpoint is unchanged for every other booking type.
- The queue list and booking detail return each stored leg's id and stage. The queue loads leg
  statuses for all rows in one batch (no per-row queries).

## Booking status follows the legs

| Leg event | Booking status |
|---|---|
| First leg: vehicle confirmed | `confirmed` |
| First leg: on trip | `in_progress` |
| Any non-final leg: done | no change |
| Last leg: done | `completed` |

The booking is `in_progress` from the first pickup to the last drop-off. The booking rules do not
allow cancelling from `in_progress` (`api/src/domain/status.ts:23`), which is why the Cancel
button is hidden for a started trip.

## Trips already under way when this ships

A private trip that is mid-way shows its remaining legs as Paid; ops re-click them. Trips already
closed stay closed.

## Known limits (not changed here)

- Cancelling the remaining legs mid-trip is not possible today and stays out of scope. Whether a
  partial refund works on an `in_progress` booking is unverified.
- Chauffeur trips: "Mark completed" on day 1 still closes the whole trip.
- The analytics "needs vehicle" count reads the booking-level status
  (`api/src/services/analytics/business.ts:219`), so it does not count later legs.

## Unverified

How many prod trips have no stored legs, or are mid-way now. A read-only run of the existing
`legs:check` script against prod would settle it (needs owner OK; not required to build).

## Build order — one PR each

1. Migration, leg status rules and storage. Starts with a failing test: "completing leg 1 must not
   close the trip".
2. Leg endpoints, booking-status follow-through, stored legs in the queue and detail, fallback for
   trips without stored legs.
3. Ops drawer and queue changes, including the Cancel rule; checked in the browser against a
   3-leg trip.
