# Ceylon Hop — Go-Live Checklist

**The canonical list of everything that must change to take the site from the dev/sandbox
environment to production (real customers + real payments).** Nothing here is a bug — these
are conscious deferrals made while building. Add any new go-live item here the moment it
comes up, so launch is a clean, mechanical switch-over.

> Convention: tick a box when done. Keep this in sync as the source of truth.

---

## 1. Render environment variables (`ceylon-hop-api` service)

| Variable | Now (testing) | Set at launch |
|---|---|---|
| `APP_BASE_URL` | `http://localhost:4173` | `https://ceylonhop.com` |
| `PAYHERE_MODE` | `sandbox` | `live` |
| `PAYHERE_MERCHANT_ID` / `_SECRET` / `_NOTIFY_URL` (+ return/cancel) | sandbox creds | **live** merchant creds for the `ceylonhop.com` account |
| `EMAIL_FROM` | `Ceylon Hop <onboarding@resend.dev>` (test sender) | `Ceylon Hop <hello@send.ceylonhop.com>` |
| `ALLOWED_ORIGINS` | dev origins | include `https://ceylonhop.com` |
| `DATABASE_URL` | dev password (leaked in-session) | **rotated** password |
| `GOOGLE_MAPS_API_KEY` | unset → fake/haversine distances | **real server key (required)** — the quote tool's live distances/autocomplete and server-side repricing of typed addresses depend on it. Restrict to Distance Matrix + Places, no referrer restriction (server-side) |
| `RESEND_API_KEY` | ✅ set | (already fine) |
| `ADMIN_API_KEY` | empty → **ops endpoints return 401 (locked out)** | strong secret so staff can use the ops endpoints |
| `OPS_SESSION_SECRET` | `dev-ops-secret-change-me` (public default → forgeable cookies) | **strong random secret** (e.g. `openssl rand -hex 32`) |
| `OPS_FOUNDER_KEY` | empty | the founder login key for the ops dashboard |
| `OPS_SUPPORT_KEY` | empty | the support/agent login key for the ops dashboard |
| `ALERT_EMAIL` | unset → alerts log-only | **your email** — ops alerts (payment failures, API errors, DB down) + the daily digest land here (M17) |
| `SENTRY_DSN` | unset → error tracking dormant | DSN from the free Sentry project you create at launch (M17) |
| `RESEND_WEBHOOK_SECRET` | unset → `/webhooks/resend` disabled | signing secret from the Resend dashboard webhook (M17, bounce/complaint alerts) |

- [ ] `APP_BASE_URL` → apex
- [ ] PayHere → live mode + live credentials
- [ ] `EMAIL_FROM` → verified domain sender
- [ ] `ALLOWED_ORIGINS` includes the apex
- [ ] DB password rotated + `DATABASE_URL` updated
- [ ] real server `GOOGLE_MAPS_API_KEY` (required — quote tool + server repricing)
- [ ] strong `ADMIN_API_KEY` set (ops endpoints are locked out until then) — **also mirror it as a GitHub Actions repo secret `ADMIN_API_KEY`** so the `scheduled-notifications` workflow (daily reminders + review requests) can authenticate
- [ ] `ADMIN_API_KEY` also gates the internal quoting tool (`/admin/quote/*`), which stores customer PII and exposes cost/margin. ~~fails OPEN when unset~~ **Fixed 2026-07-02 (GL-1c): the tool now fails CLOSED in production** — an unset key means staff are locked out (401) until it's set, never exposed.

## 2. DNS / external consoles

- [ ] **Resend:** verify a sending domain — recommend **`send.ceylonhop.com`** (subdomain keeps existing `@ceylonhop.com` mail/SPF untouched). Add the SPF/DKIM/return-path records. Until done, email only delivers to the account owner.
- [ ] **Google Cloud console:** add `ceylonhop.com` (+ `www`) to the **front-end Maps/Places key** *Website restrictions* (today: `ceylonhop.github.io` + localhost). Key powers Maps JS + Places Autocomplete + Directions on `booking.html` / `plan.html`.
- [ ] **PayHere dashboard:** approved/live domain = the `ceylonhop.com` apex (PayHere is **apex-only** — no subdomains, no `github.io`).
- [ ] **Keep the API warm:** `keepalive.yml` (GHA, 13-min `/health` ping) exists but GitHub Actions cron is throttled and not reliable enough alone — still set up an external pinger (e.g. cron-job.org → `https://ceylon-hop-api.onrender.com/health` every ~10 min) **or** upgrade Render off the free tier.

## 3. Hosting / code / data

- [ ] **Serve the new site on the `ceylonhop.com` apex** (currently the live business site). Required because PayHere only works on the apex.
  - ✅ **M16 SEO migration MERGED to main** (PR #7, 2026-07-03; adversarially reviewed + fixed): 44 static route pages (`/trip/<from>-to-<to>/`) generated from the rate card, a `/trip/` index, `sitemap.xml`, `robots.txt`, branded `404.html`, ported `terms.html`/`privacy.html`, sitewide canonical/OG, `noindex` on param pages, corrected Tripadvisor rating (5.0/30, no self-serving `aggregateRating`), and a full old→new **redirect map** (stubs + `docs/cloudflare-redirects.csv`). Plan: [`seo-migration-plan.md`](./seo-migration-plan.md), spec: [`superpowers/specs/2026-07-02-m16-seo-migration-design.md`](./superpowers/specs/2026-07-02-m16-seo-migration-design.md).
  - **At cutover (M16 tail — NOT yet done):** (1) commit a `CNAME` file = `ceylonhop.com` (deliberately omitted until now so it doesn't re-point Pages while apex DNS still serves WordPress); (2) point the founder's **existing Cloudflare** account's DNS → GitHub Pages and **import `docs/cloudflare-redirects.csv` as Bulk Redirects** (301) for true server-side redirects; (3) Search Console: submit `sitemap.xml`, request indexing of the top route pages, monitor Coverage/404 for 4–6 weeks.
  - ⚠️ **Owner decision — refund ladder is self-contradictory (surfaced by the M16 review, before real payments).** `terms.html` §6 (ported verbatim from the live WordPress site) reads "Within 10 days: 80% · Within 7 days: 40% · Within 2 days: 60%" — **non-monotonic** (cancelling 1–2 days out refunds *more* than a week out; the 40/60 look transposed). The port is faithful, but this is the binding refund contract. Fix the source figures (likely 7 days → 60%, 2 days → 40%, or restate as explicit day-ranges) — **not** to be changed silently since it alters refund entitlements.
  - **Founder follow-ups (non-blocking, flagged during M16):** route pages ship with a CSS-gradient hero and **no route photos** — supply ~10–20 for the P2 image-SEO win (a shared social OG image, `og-cover.jpg`, is already wired site-wide); the ported **privacy policy is thin** (3 bullets) and the **terms describe the old "travel pass" hop-on/hop-off model** (six-month validity, pass downgrades, "ticket price" refunds) not the new deposit-plus-balance booking product — review/expand both before real customers; confirm whether shared-corridor seats run **both directions** daily (route pages show a shared option on reverse legs too, mirroring the live site's direction-agnostic logic); the 6 old blog posts currently 301 to `blog.html` (re-port later if desired).
- [ ] **Clear all test data** from Supabase (it's the same DB that'll serve production) — **run `api/scripts/clear-test-data.sql`**. It truncates every transactional + ops table (bookings/customers/payments/tasks/trip+shared requests/ride_ops/coordinators) **and resets `shared_departure` seat inventory**, while keeping the seeded `corridor` reference data. Run **once, pre-launch**, while everything is still test data (covers the sandbox `CH-NDYDS`, e2e rows, demo bookings, abandoned drafts — no need to enumerate them).
- [x] **Chauffeur deposit charge:** ✅ **Done 2026-07-02 (GL-3 piece 3, PR #5)** — checkout now charges `amountDueNow` (the deposit) for chauffeur bookings; confirmation email states deposit paid + balance due.
- [x] **Engine-authoritative public bookings (GL-3 — MUST land before real payments).** ✅ **Done 2026-07-02 (PR #5)** — booking creation reprices server-side with the M11 engine (private/chauffeur) and validates shared against the DB corridor price; client `quotedTotal` is no longer trusted.
- [x] **Front-end pricing parity (GL-4).** ✅ **Done 2026-07-02 (PR #6)** — client rate table synced to the engine rate card (car 46¢/km billable, van 83¢, deposit 10% cap $50) across `transfers-data.js`/`plan.js`/`booking.js`; owner-authorized unfreeze, freeze restored after.
- [x] **Charged amount = shown amount at the payment moment (GL-4 follow-up).** ✅ **Done 2026-07-05** — the wizard's on-page estimate is priced off the browser's measured distance, but the API reprices off its own server-side Distance Matrix, so the two can drift a few % (observed live: CMB→Kandy showed **$60**, server charged **$57.50** off 114 km vs the browser's 118 km). `booking.js` now adopts the server-authoritative `total`/`amountDueNow` from the `/bookings/*` response, so the pay overlay, PayHere and the confirmation pass all show **exactly** what is charged — the customer can never be billed a figure they weren't shown at Pay. Covered by two e2e specs (`payment.spec.js`). Residual (cosmetic, non-blocking): the *wizard sidebar* still shows the pre-payment estimate until Pay; unifying the two distance sources would remove even that small gap. Also fixed here: the stale `booking.html` "Demo checkout — simulated" disclaimer now reflects reality (real PayHere gateway with a backend; "simulated" only for the `?api=off` demo).
- [x] **Shared seat-hold release (GL-3).** ✅ **Done 2026-07-02 (piece 4, PR #5)** — seats release on cancel/refund + a stale-hold sweep reclaims abandoned drafts.
- [x] **Harden the rate limiter:** ✅ **Done 2026-07-02 (piece 5, PR #5)** — keys on the trusted proxy hop, not spoofable client headers.
- [ ] **Trim CORS dev origins:** once on the apex, drop `ceylonhop.github.io` + `localhost` from `ALLOWED_ORIGINS` (keep only `https://ceylonhop.com`).
- [ ] **Confirm the front-end API URL:** `window.CEYLON_HOP_API` in `booking.html` defaults to the Render URL — update if the API moves to a custom domain.
- [ ] **Check public URLs use the apex:** canonical / Open-Graph / `schema.org` `url` / any sitemap should point to `https://ceylonhop.com` (not github.io/localhost).

- [ ] **Observability & alerting (M17) — BUILT (env-gated, dormant until keys set); activate at launch.** Code shipped 2026-07-03: throttled email alerts (30-min dedupe via `alert_log`), env-gated Sentry on the API, front-end error beacon → `/errors/client`, payment-webhook failure alerts, watchdog sweep, `/health/deep`, Resend bounce webhook, daily ops digest. Spec: [`superpowers/specs/2026-07-03-m17-observability-design.md`](./superpowers/specs/2026-07-03-m17-observability-design.md). **Launch activation steps:**
  - [ ] set `ALERT_EMAIL` on Render (alerts + daily digest start flowing)
  - [ ] create the free **Sentry** project → set `SENTRY_DSN` on Render
  - [ ] **apply migration 0011** (`alert_log`) at deploy — alongside 0010
  - [ ] **UptimeRobot** (free): monitor `https://ceylon-hop-api.onrender.com/health/deep` every 5 min → email alert (independent of the email stack — this is the channel that catches an email outage)
  - [ ] **cron-job.org**: `POST /admin/jobs/watchdog` every 15 min with header `x-admin-key: <ADMIN_API_KEY>` (same service as the keep-warm pinger)
  - [ ] **Resend dashboard**: add a webhook → `https://ceylon-hop-api.onrender.com/webhooks/resend` (events: bounced, complained) → set `RESEND_WEBHOOK_SECRET`
  - [ ] **Supabase**: toggle the built-in DB alerts on

## 4. Verify after switching (smoke test on production)

- [ ] A real (small) booking on `ceylonhop.com` completes a **live** PayHere payment → booking goes `paid`.
- [ ] The confirmation email actually arrives at a **non-owner** address (proves the domain is verified).
- [ ] Maps + Places autocomplete work on the apex (no referrer/console errors).
- [ ] WhatsApp CTA opens the correct number (`+94779669662`).
- [ ] `web-tests` (`npm run test:all`) and `api` (`npm run check`) both green.

---

## Still-to-build (not launch-blocking — but finish or consciously defer)

- **Customer emails** beyond confirmation: ✅ **cancellation** (`POST /admin/bookings/:id/cancel`), ✅ **refund** (`/refund`), and ✅ **pre-trip reminder + thank-you/review request** (M14 scheduler — `POST /admin/jobs/notifications`, driven daily by the `scheduled-notifications` workflow) now built + branded. Still to do: deposit/balance (blocked by the chauffeur deposit-charge fix), driver-assigned, "we need your details", payment-didn't-complete. (Tracked in the agent's email roadmap notes.)
- **M11** pricing engine + quoting tool + quote lifecycle ✅ **MERGED to main 2026-07-02** (PRs #1–#4: engine, tool, Postgres quotes, Ops Quote Generator). Remaining M11 scope: wire the engine into the PUBLIC booking flow (GL-3 above) and web-channel quote capture (deferred). · **M12** ops dashboard (Slice-1 backend shipped; UI prototype parked — see `ops-dashboard-status.md`) · **M13** WhatsApp Business API · **M14** reminders/SLA timers (pre-trip reminder + review request ✅ shipped via the scheduler; remaining: balance-due reminders, "confirm your details" nudges, SLA timers) · **M15** reporting/CSV export.

### Owner pricing decisions (2026-07-02) — recorded so launch work doesn't re-ask
- **The engine rate card is the pricing truth** (`api/src/quote/rateCard.ts`): car 46¢/km, van6 83¢, van9 55¢ on billable km (×1.10), deposit 10% capped $50. The front-end's old table is superseded (see GL-4 item above).
- **Van 14 / Custom are custom-priced per quote** — the operator sets $/km in the quote tool (rate-card 130¢/175¢ are prefill defaults only).
- **Quote delivery = manual copy → WhatsApp** (Copy button in the tool; deliberately no wa.me deep link).

---

_Last updated: 2026-07-02 (GL-3 + GL-4 merged: engine-authoritative bookings, deposit-correct checkout, seat-hold release, rate-limiter hardening, front-end pricing parity). Add new items as they arise — don't rely on memory._
