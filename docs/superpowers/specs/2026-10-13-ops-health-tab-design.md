# Ops "Health" tab — system health, usage and quota signals (design)

**Date:** 2026-10-13 · **Owner decision:** go (after the scale audit of the same day)
**Scope:** one PR, `api/` + `ops-ui.html`, one small migration (`usage_counters`), two config defaults.

## Why

The owner is growing bookings ~5× over three months on free tiers everywhere (Render, Supabase,
Resend, Sentry, Google Maps per-SKU allowances). The scale audit found the stack has 40 alert kinds
but **no usage signal at all**: nothing counts Resend sends against the 100/day cap, Google calls
against the 10k/SKU/month allowances, or rate-limit refusals; the watchdog heartbeat is readable
only on `/health/deep`, which nothing calls; and the ops portal has business analytics but no
system surface. External uptime monitoring (UptimeRobot) and vendor-native alerts are being set up
separately — they catch outages. This tab shows what **only our own process and database know**.

## Not in scope (deliberately)

Render CPU/memory or Google usage pulled from vendor APIs (link out instead); request latency or
access logs; a log drain; alert severity in the alerts list (`alert_log` stores none; kind names
are self-explanatory); any change to how alerts are delivered.

## Design

### 1. Usage counters (the only new storage)

`usage_counters(day date, key text, n integer, primary key (day, key))` — one row per UTC day and
counter key, RLS enabled like every table since 0048. Migration `0071_usage_counters`.

Keys (all `text`, dotted):

| key | bumped by | meaning |
|---|---|---|
| `email.sent` | `MeteredEmailAdapter` | provider accepted the message |
| `email.failed` | `MeteredEmailAdapter` | adapter threw (Resend non-2xx, timeout) |
| `email.suppressed` | `MeteredEmailAdapter` | outcome `delivered:false` (guard/allowlist) |
| `maps.distance` · `maps.route_variants` · `maps.places` · `maps.geocode` · `maps.place_candidates` | `MeteredMapsAdapter` | a **live** Google call (cache hits never reach it) |
| `ratelimit.refused` | `rateLimit()` via `onLimited` | a 429 served |

**UTC days**, stated in the UI. Vendors reset on their own clocks; UTC is the honest approximation
and avoids a second day convention next to Analytics' Colombo days.

### 2. `UsageMeter` — count in memory, write coalesced

`bump(key, n=1)` increments an in-process map keyed `day|key` and arms one `setTimeout(flush, 10 s)`
(unref'd). `flush()` upserts each pending `(day, key)` with `n = n + excluded.n`. A failed write logs
and keeps the pending counts for the next flush. So a burst of a thousand 429s costs one row write
per 10 s, and a crash loses at most 10 s of a gauge. The health route calls `flush()` before reading
so the page is never behind by more than a request.

### 3. Metering wrappers (adapters with fakes, as always)

`MeteredEmailAdapter(inner, meter)` wraps the **raw** Resend adapter in `server.ts`, below the
`GuardedEmailAdapter`/`ObservingEmailAdapter` that `app.ts` adds — so alerts and the digest, which
bypass the guard, are counted too. `MeteredMapsAdapter(inner, meter)` wraps the raw Google adapter
**inside** `CachedMapsAdapter`, so only cache misses count. Optional methods (`geocode`,
`placeCandidates`) are assigned conditionally, mirroring `CachedMapsAdapter`. Keyless dev keeps the
bare fakes and counts nothing.

### 4. Heartbeats

`WATCHDOG_TICK` already exists. The daily notifications tick gets the same footprint —
`NOTIFICATIONS_TICK = { kind: 'notifications_tick', key: 'last' }`, written last so a tick that
threw leaves none — and both bookkeeping kinds are excluded from alert counts in the digest and the
health payload.

### 5. `GET /admin/ops/health` (founder: `analytics:view`)

No new capability — the matrix row would be identical to `analytics:view`, and "founder-only system
page" is what that capability already means. Payload:

```
{ generatedAt, dayBasis: 'utc',
  build:   { commit, startedAt, uptimeSec },
  db:      { sizeBytes | null },
  jobs:    { watchdog: { lastRunAt, stale }, notificationsTick: { lastRunAt, stale } },
  alerts:  { last24h: [{ kind, keys }], last7d: [{ kind, keys }] },   // alert_log keys per kind
  carts:   { paymentPending, paymentPendingLast24h, drafts },
  email:   { today: { sent, failed, suppressed }, month: { sent }, dailyLimit, monthlyLimit },
  maps:    { today: { byKey, total }, month: { byKey, total } },
  rateLimit: { refusedToday, refusedMonth },
  links:   [{ label, url }] }
```
`alerts.*.keys` is the number of distinct `(kind, dedupe_key)` rows whose last send falls in the
window — the same approximation the digest uses, labelled as such. `notificationsTick.stale` is
`> 26 h`; `watchdog.stale` reuses `WATCHDOG_STALE_MS`. `db.sizeBytes` is
`pg_database_size(current_database())`, null in dev/tests. `links` are the vendor dashboards (no
secrets), so the tab is the one place to start from.

### 6. One new watchdog rule

After its sweeps, the watchdog reads today's `email.sent`; at **≥ 70 % of `EMAIL_DAILY_LIMIT`** it
sends a `critical` `email_quota_near` alert deduped per UTC day. The point is to upgrade Resend
*before* the cap — once it bites, the `confirmation_email_failed` alert can't be delivered either.
`EMAIL_DAILY_LIMIT` (default 100) and `EMAIL_MONTHLY_LIMIT` (default 3000) are config so the
owner flips them on upgrade; they drive the tab's limit display too.

### 7. The tab

`#health`, nav "Health" after Analytics, gated and bounced exactly like Analytics. `viewHealth()`
fetches `/health` once per entry (no cache; a Refresh button re-fetches) and renders with the
existing `an-tiles` / `an-tile` / `an-card` vocabulary: a build/jobs row, email vs limits (today
and month, with the 70 % line), Maps live calls today/month per key, 429s, carts, alerts (24 h /
7 d), DB size, vendor links. Numbers only; no charts.

## Testing

Unit: `UsageMeter` (day keys, coalescing, failed-write retention), both wrappers (counts and
pass-through, failure rethrown), `rateLimit` `onLimited`, `collectSystemHealth` shape and
windowing, `emailQuotaAlert` threshold/dedupe. DB: `PostgresUsageCounterRepo` upsert-add and
range (skips without `DATABASE_URL_TEST`, like its siblings); RLS test covers the new table. Route:
401/403/200 gating mirrors `opsAnalytics.test.ts`. Watchdog: the rule fires at 70 %, not below.
Admin: the tick writes its heartbeat. UI: `opsUi.test.ts` asserts the gated nav and route strings.

## Release

Staging-first via the normal `main` merge (the migration auto-applies on Render boot); prod on the
next promote with the owner's ok. Rollback: the table is additive; removing the wrappers restores
the previous wiring.
