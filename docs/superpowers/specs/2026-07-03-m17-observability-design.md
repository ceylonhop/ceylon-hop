# M17 — Observability & Alerting (design)

**Date:** 2026-07-03
**Status:** awaiting owner review
**Milestone:** M17 (strongly recommended before real payments — see `docs/go-live-checklist.md` §3)
**Parent plan:** `docs/observability-plan.md` (gap analysis, ranked)

## Why

Production today has **no error tracking, no uptime alerting, and no payment-failure
alerts** — a failed PayHere webhook, a stuck `payment_pending`, or a 500 in checkout is
silent (`console.error` → ephemeral Render logs). Running real money like that means the
first report of a broken checkout is an angry customer. M17 wires the minimum a
one-founder payments business needs, with free/cheap tools, everything env-gated so it
ships now and activates at launch.

## Decisions (owner 2026-07-03 unless marked *delegated*)

| # | Decision |
|---|---|
| O1 | **Alerts land on email only** — sent through the existing Resend `EmailAdapter` to a new `ALERT_EMAIL` env. No Telegram/Slack/WhatsApp channel in v1. *Recorded limitation:* an email-stack outage can't self-report; mitigated by the independent external uptime monitor (and Sentry once configured). |
| O2 | **Sentry (free tier) is the error tracker; the owner creates the account/DSN later.** Everything is env-gated on `SENTRY_DSN` and dormant until set. |
| O3 | **Front-end error capture is included** — an additive head `<script>` on the frozen pages via the labelled-unfreeze procedure (same as M16 PR3 / GL-4). |
| O4 | *Delegated:* **client errors go to our own API** (`POST /errors/client`), not the Sentry browser SDK. Rationale: works today with zero accounts, no DSN baked into frozen files (a DSN-later browser SDK would force a *second* frozen-file edit at launch), one server-side integration point forwards to Sentry (tagged `frontend`) once keys exist. |
| O5 | *Delegated:* **alert de-duplication is DB-backed** (`alert_log` table, per-key cooldown, default 30 min) so an error storm sends one email per key per window and a server restart doesn't re-spam. |
| O6 | *Delegated:* `/health` stays static-fast (keep-warm pings + booking-page warm-up depend on it); a new **`/health/deep`** does a real `SELECT 1` for the uptime monitor. |
| O7 | *Delegated:* the watchdog sweep is an **authed idempotent tick** (`POST /admin/jobs/watchdog`) driven by the external cron service the go-live checklist already requires (cron-job.org supports headers), every ~15 min; the daily GitHub Actions cron is the approximate backup. |
| O8 | *Delegated (YAGNI):* structured logging, log retention, and business-metrics dashboards are **out of scope** for v1; a minimal daily ops digest email is included (rides the existing daily notifications tick). |

## Components

### 1. `AlertAdapter` — `api/src/adapters/alerts.ts`
`send({ severity: 'critical'|'warning'|'info', kind, title, body, dedupeKey })`.
- **`EmailAlertAdapter`** — formats a compact alert email and sends via the existing
  `EmailAdapter` to `ALERT_EMAIL`. Selected when `ALERT_EMAIL` is set.
- **`LogAlertAdapter`** — `console.error` only (dev default / env unset).
- **`FakeAlertAdapter`** — records calls (tests).
- **Throttle:** before sending, check `alert_log` (`kind` + `dedupe_key`): if the last
  send is inside the cooldown (default 30 min), increment `count` and skip; else send and
  upsert `last_sent_at`. Storms → one email per key per window, restart-safe.

### 2. API error tracking — Sentry, env-gated
- Dependency `@sentry/node`, initialized in `server.ts` **only when `SENTRY_DSN` is set**
  (release = git SHA env, environment = `NODE_ENV`).
- A thin `track(err, ctx)` module (`api/src/observability/track.ts`) is the only file that
  touches the SDK — everything else calls `track`, tests inject a fake (rule 4).
- `app.onError` → `track()` + throttled `critical` alert (dedupeKey = `err.name + route`).
  Response behavior unchanged (500 `internal_error`).

### 3. Client error capture — own endpoint, no browser SDK
- **API:** `POST /errors/client` — public (the pages are public), hard rate-limited
  (per-IP, existing limiter), body capped (~2 KB: message, stack head, url, ua), Zod-validated.
  Forwards to `track()` tagged `frontend` + throttled `warning` alert
  (dedupeKey = message hash). Never 500s; always 204.
- **Front-end:** a ~15-line inline head snippet wiring `window.onerror` +
  `unhandledrejection` → `navigator.sendBeacon(API_BASE + '/errors/client', …)`, with a
  per-page cap (max 5 beacons) so a hot loop can't flood. Deployed two ways:
  - the 9 existing frozen pages: additive head edit under the **labelled unfreeze** (O3);
  - generated route pages: emitted by the M16 generator chrome (`tools/site-chrome.mjs`)
    + regenerate (codegen-drift test keeps it in sync).

### 4. Payments watchdog
- **Inline (webhooks.ts):** throttled `critical` alerts on (a) invalid signature, (b)
  amount mismatch, (c) confirmation-email send failure (booking went `paid` but the
  customer got nothing — today only console.error'd).
- **Sweep (`POST /admin/jobs/watchdog`, `ADMIN_API_KEY`-authed, idempotent):**
  - `payment_pending` bookings older than 30 min → `critical` per booking (dedupe = booking id);
  - `paid` bookings with no `confirmation` row in `notification_log` after 15 min → `critical`;
  - sweep result returned as JSON (counts) for the cron service's logs.
- **Cadence:** external cron (cron-job.org) every ~15 min with the admin header (O7);
  documented in the go-live checklist next to the existing keep-warm pinger item.

### 5. Uptime
- `/health` unchanged (static, fast). New **`/health/deep`**: `SELECT 1` through the pool;
  200 `{status:'ok',db:'ok'}` or 503. The external monitor (UptimeRobot free, founder
  account at launch) watches `/health/deep`; checklist gets the exact setup steps.

### 6. Email deliverability — Resend webhook
- **`POST /webhooks/resend`** — enabled only when `RESEND_WEBHOOK_SECRET` is set
  (otherwise 404), svix-style signature verification, alerts (`warning`) on
  `email.bounced` / `email.complained` with the recipient + subject. Founder adds the
  webhook in the Resend dashboard at launch (checklist).

### 7. Daily ops digest (small)
- Rides the existing daily `POST /admin/jobs/notifications` tick: after the notification
  run, if `ALERT_EMAIL` is set, email one compact digest — bookings created / paid /
  cancelled in the last 24 h, watchdog alert counts (from `alert_log`), stale-hold sweeps.
  Pure read queries; failure is best-effort (never blocks notifications).

## Data

Migration `0011`: `alert_log` — `id uuid pk, kind text, dedupe_key text, last_sent_at timestamptz, count int default 1`, unique `(kind, dedupe_key)`. **Apply at deploy** (join the migration checklist with 0010).

## Env (all optional → feature dormant)

`ALERT_EMAIL` · `SENTRY_DSN` · `RESEND_WEBHOOK_SECRET` · (existing `ADMIN_API_KEY` gates the watchdog tick). Added to the go-live checklist env table.

## Testing

Vitest throughout, fakes for every external (rule 4): alert throttle behavior (cooldown,
restart-safety via DB), onError → track + alert, `/errors/client` (validation, rate limit,
cap, 204-always), webhook alert paths (signature/mismatch/email-fail), watchdog sweep with
a fake clock + seeded bookings (stuck pending, paid-without-confirmation, dedupe),
`/health/deep` ok + db-down 503, Resend webhook signature verify + disabled-when-unset,
digest content. Front-end snippet: web-tests unit asserts the snippet is present on all
pages (frozen + generated) and Playwright e2e triggers a synthetic error → beacon stub.

## Delivery — two labelled PRs

1. **m17-api-observability** — everything in `api/` + migration + docs/checklist (new files + api edits; no frozen files).
2. **m17-fe-error-capture** — head snippet on the 9 frozen pages (labelled `allow-ui-change`, freeze restored) + generator chrome emit + regenerate.

## At launch (go-live checklist additions)

Create Sentry project → set `SENTRY_DSN`; set `ALERT_EMAIL`; UptimeRobot monitor on
`/health/deep` (5-min interval, email alert); cron-job.org job for `POST
/admin/jobs/watchdog` every 15 min with the `x-admin-key` header; Resend dashboard webhook
→ `RESEND_WEBHOOK_SECRET`; Supabase built-in alerts toggled on; apply migration 0011.
