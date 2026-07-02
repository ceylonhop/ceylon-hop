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
  - ⚠️ **SEO RISK — do M16 first.** The current site ranks via per-route landing pages (`/trip/<from>-to-<to>/`) the new app-style site doesn't have. Cutting over without recreating route pages + 301-redirecting old URLs will drop long-tail rankings. Full plan: [`seo-migration-plan.md`](./seo-migration-plan.md) (sitemap/robots/404/CNAME + canonical/OG live there too).
- [ ] **Clear all test data** from Supabase (it's the same DB that'll serve production) — **run `api/scripts/clear-test-data.sql`**. It truncates every transactional + ops table (bookings/customers/payments/tasks/trip+shared requests/ride_ops/coordinators) **and resets `shared_departure` seat inventory**, while keeping the seeded `corridor` reference data. Run **once, pre-launch**, while everything is still test data (covers the sandbox `CH-NDYDS`, e2e rows, demo bookings, abandoned drafts — no need to enumerate them).
- [ ] **Chauffeur deposit charge:** checkout charges the FULL total today; chauffeur (deposit) bookings should charge `amountDueNow` (the deposit). Small route/adapter fix. *(In flight: GL-3.)*
- [ ] **Engine-authoritative public bookings (GL-3 — MUST land before real payments).** Audit 2026-07-02: the booking endpoints trust the client's `quotedTotal` verbatim (`bookings.ts` — `quotedTotal ?? placeholder`); the M11 engine is wired only to `/admin/quote`. Anyone can POST a $1 booking. Reprice server-side with the engine on create; validate shared against the DB corridor price.
- [ ] **Front-end pricing parity (GL-4).** Owner decision 2026-07-02: **the engine rate card is the pricing truth** (car 46¢/km on billable km, van 83¢, deposit 10% cap $50). The frozen front-end still shows the OLD table (car $22 + $0.62/km, van + $0.86/km, `DEPOSIT_PCT = 0.20` — `transfers-data.js`, dupes in `plan.js`/`booking.js`). Sync before customers see one price and get charged another. Sanctioned unfreeze of exactly these files, labelled PR.
- [ ] **Shared seat-hold release (GL-3).** `holdSeats` fires at draft creation and no release path exists — abandoned/cancelled bookings permanently shrink corridor capacity. Add release on cancel + stale-draft sweep.
- [ ] **Harden the rate limiter:** it keys on the client-supplied `X-Forwarded-For` (spoofable) — use a trusted source before public traffic. *(In flight: GL-3.)*
- [ ] **Trim CORS dev origins:** once on the apex, drop `ceylonhop.github.io` + `localhost` from `ALLOWED_ORIGINS` (keep only `https://ceylonhop.com`).
- [ ] **Confirm the front-end API URL:** `window.CEYLON_HOP_API` in `booking.html` defaults to the Render URL — update if the API moves to a custom domain.
- [ ] **Check public URLs use the apex:** canonical / Open-Graph / `schema.org` `url` / any sitemap should point to `https://ceylonhop.com` (not github.io/localhost).

- [ ] **Observability & alerting (M17) — strongly recommended before taking real payments.** Production today has **no error tracking, uptime alerting, or payment-failure alerts** (just `console.error` to ephemeral Render logs). At minimum wire: error tracking (Sentry, API + front-end), an uptime monitor on `/health` with alerts, and a payments watchdog (webhook failure / stuck `payment_pending` / paid-without-confirmation → WhatsApp/Slack). Full plan: [`observability-plan.md`](./observability-plan.md).

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

_Last updated: 2026-07-02 (full go-live audit: engine-authority gap, seat-hold leak, pricing-parity decision, fail-closed tool auth, M11 merge). Add new items as they arise — don't rely on memory._
