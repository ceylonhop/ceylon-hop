# Ceylon Hop — M17: Observability & Alerting

**Status: BUILT 2026-07-03 (API side; env-gated, dormant until launch keys).** Implemented per
the approved design (`superpowers/specs/2026-07-03-m17-observability-design.md`): throttled
email alerts, env-gated Sentry, `/errors/client` beacon, webhook failure alerts, watchdog
sweep, `/health/deep`, Resend bounce webhook, daily digest. Launch activation steps live in
the go-live checklist §3. This document remains the original gap analysis.

---

## Current state (what exists today) — essentially nothing
- `console.error` at ~6 sites → Render stdout. On the free tier these logs are **ephemeral,
  unsearchable, no retention**.
- Global `onError` handler logs + returns a generic 500.
- `/health` endpoint — but **nothing alerts on it**. `keepalive.yml` pings it every 13 min with
  `|| true` (prevents sleep, stays silent if the API is down).
- CI goes red on failed builds; the daily `notifications.yml` goes red in GitHub if it fails —
  but **nobody is notified**.
- `notification_log` table = business record of sent reminder/review emails.

**No error tracking, no uptime alerting, no payment-failure alerts, no metrics, no log
retention, no frontend error capture.**

## Gaps, ranked for a payments business

| Priority | Gap | Why it bites |
|---|---|---|
| 🔴 1 | **Payment / webhook failure alerting** | A PayHere webhook failing signature, a booking stuck in `payment_pending`, or a 5xx on `/webhooks/payments` is **silent today** → lost revenue + confused customers you never hear about. #1 priority. |
| 🔴 2 | **Error tracking (Sentry/similar) on the API** | An unhandled 500 vanishes into ephemeral logs; you learn checkout broke from a customer complaint. |
| 🔴 3 | **Uptime/downtime alerting** | Render down or stuck-cold pages no one (keepalive swallows failures). |
| 🟠 4 | **Frontend error capture** | A JS error in the booking/payment flow silently kills conversions. |
| 🟠 5 | **Email deliverability monitoring** | Resend bounces/spam/failures aren't wired anywhere → a missing confirmation is silent. |
| 🟠 6 | **Anomaly checks** | paid bookings with no confirmation sent; **seat holds without a booking** (the known seat-hold leak); `payment_pending` older than ~30 min. No periodic check alerts. |
| 🟡 7 | **Log retention + structured logging + basic business metrics** | Can't debug last week's incident; no view of bookings/day, conversion, failed-payment rate. |

## Recommended stack (right-sized — free/cheap, NOT Datadog)
- **Sentry** (free tier) on **both** the API and the front-end booking flow — errors + breadcrumbs.
- **Better Stack / UptimeRobot** (free) monitoring `/health` → alert to **email + WhatsApp/Slack**.
- **Payments alert**: on webhook signature failure, webhook 5xx, or a `payment_pending` booking
  older than ~30 min → ping a WhatsApp/Slack webhook. (Extend the webhook handler + the existing
  cron tick — cheap to add.)
- **Resend webhooks** → capture bounces/deliveries (Resend already tracks this; wire the alert).
- **Supabase** built-in alerts (DB near-capacity / connection errors) — toggle on.

## Scope this milestone delivers
- API + frontend error tracking (Sentry) wired, with release/environment tags.
- Uptime monitor on `/health` with multi-channel alerting (incl. cold-start awareness).
- A **payments watchdog**: webhook-failure + stuck-`payment_pending` + paid-without-confirmation
  alerts to a WhatsApp/Slack channel (extend `webhooks.ts` + the scheduler cron).
- Resend bounce/delivery webhook → alert.
- Minimal structured logging + a tiny daily ops digest (bookings, paid, failures) — optional.
- Supabase alerts enabled.

## Effort
~1–2 days, mostly wiring + a small watchdog service. No new heavy infra. Most tools are free
at this volume.

## Notes / dependencies
- The **seat-hold leak** (hold committed then booking created in a separate txn) is a reliability
  bug in the build-plan hardening backlog — the anomaly check here would *detect* it, but the fix
  belongs to that backlog item.
- Frontend Sentry touches the frozen front-end (`booking.js` etc.) — a labelled exception to the
  "don't edit frozen front-end" rule, or done via a small additive snippet in the HTML.
- The WhatsApp alert channel can reuse the business WhatsApp (`+94 77 966 9662`) or a separate
  ops number; M13 (WhatsApp Business API) could later carry this.
