# Ride Board: tell ops when a seat is held

**Date:** 2026-09-22 · **Status:** approved by owner in chat, building

## Problem

When a traveller starts a shared ride or adds their name to one, the only way ops learns of
it is by opening the ops dashboard. The traveller already gets a receipt (PR #666,
`sendRideJoined`), but nothing internal fires. Ops asked for a ping.

## Scope

One internal email per *commitment that moved*: a list started, a name added, a rejoin, or a
seat count changed. It rides the exact hook the traveller receipt already uses, so it fires
in every path into a live seat, including the PayHere callback that completes every prod join.

Out of scope: traveller-facing changes (already shipped), Slack or any non-email channel,
a per-list digest, schema changes.

## Design

- **Sender:** `sendRideSeatHeld` in `api/src/services/opsNotifications.ts` (the team-facing
  family, rendered through `opsEmailShell`, `audience: 'ops'`).
- **Recipient:** `ALERT_EMAIL`, the inbox that already receives the digest and watchdog alerts.
  Unset → nothing is sent (same rule as the digest). Threaded into `rideBoardRoutes` as
  `opsNotify: { to, opsBaseUrl }` from `app.ts`, using `deps.digestTo ?? config.ALERT_EMAIL`.
- **Subject:** `New shared ride: Ella → Mirissa, Sat 8 Aug 2026 — Ceylon Hop ops` for the
  starter; `Seat taken: … (2 of 4 seats) — Ceylon Hop ops` for a join; `Seats changed: …` for a
  seat-count change.
- **Body:** ride code, traveller (first name, country, email), seats, committed of minimum and
  capacity with a "van is viable" line once the threshold is met, departure day + slot, cutoff
  in Colombo time, CTA to `${OPS_BASE_URL}/ops?booking=board:<code>`, which the dashboard
  already resolves to the van sheet. Seat price only, nothing margin-shaped.
- **Hook:** `mailJoinReceipt` in `rideBoard.ts` sends the traveller receipt and the ops mail
  independently (one failing never blocks the other), still best-effort so a mail outage never
  fails a join. Seed members and members without an email send neither, as today.
- **Duplicates:** unchanged repeat joins already send nothing; the ops mail inherits that.
- **No send budget:** one email per human action, nothing a backfill can trigger.
- **Preview:** added to `/dev/emails` as `ride-seat-held-ops`.

## Tests

- `opsNotifications.test.ts`: recipient, the three subjects, body fields, escaping, viable line,
  link and the no-link fallback.
- `rideBoard.write.test.ts`: ops mail on create, on join, after a PayHere callback, on a seat
  change; none on an unchanged repeat join; none when no recipient is configured; join still
  succeeds when the provider is down.
