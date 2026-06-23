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
| `GOOGLE_MAPS_API_KEY` | unset → fake/haversine distances | real key, restricted to Distance Matrix *(optional)* |
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
- [ ] (optional) real `GOOGLE_MAPS_API_KEY`
- [ ] strong `ADMIN_API_KEY` set (ops endpoints are locked out until then)

## 2. DNS / external consoles

- [ ] **Resend:** verify a sending domain — recommend **`send.ceylonhop.com`** (subdomain keeps existing `@ceylonhop.com` mail/SPF untouched). Add the SPF/DKIM/return-path records. Until done, email only delivers to the account owner.
- [ ] **Google Cloud console:** add `ceylonhop.com` (+ `www`) to the **front-end Maps/Places key** *Website restrictions* (today: `ceylonhop.github.io` + localhost). Key powers Maps JS + Places Autocomplete + Directions on `booking.html` / `plan.html`.
- [ ] **PayHere dashboard:** approved/live domain = the `ceylonhop.com` apex (PayHere is **apex-only** — no subdomains, no `github.io`).
- [ ] **Keep the API warm:** set up an external pinger (e.g. cron-job.org → `https://ceylon-hop-api.onrender.com/health` every ~10 min) **or** upgrade Render off the free tier. (GitHub Actions cron is throttled to ~hours and isn't reliable enough; front-end pre-warm covers visitors but not the very first cold hit.)

## 3. Hosting / code / data

- [ ] **Serve the new site on the `ceylonhop.com` apex** (currently the live business site). Required because PayHere only works on the apex.
- [ ] **Clear all test data** from Supabase (it's the same DB that'll serve production) — **run `api/scripts/clear-test-data.sql`**. It truncates every transactional + ops table (bookings/customers/payments/tasks/trip+shared requests/ride_ops/coordinators) **and resets `shared_departure` seat inventory**, while keeping the seeded `corridor` reference data. Run **once, pre-launch**, while everything is still test data (covers the sandbox `CH-NDYDS`, e2e rows, demo bookings, abandoned drafts — no need to enumerate them).
- [ ] **Chauffeur deposit charge:** checkout charges the FULL total today; chauffeur (deposit) bookings should charge `amountDueNow` (the deposit). Small route/adapter fix.
- [ ] **Harden the rate limiter:** it keys on the client-supplied `X-Forwarded-For` (spoofable) — use a trusted source before public traffic.
- [ ] **Trim CORS dev origins:** once on the apex, drop `ceylonhop.github.io` + `localhost` from `ALLOWED_ORIGINS` (keep only `https://ceylonhop.com`).
- [ ] **Confirm the front-end API URL:** `window.CEYLON_HOP_API` in `booking.html` defaults to the Render URL — update if the API moves to a custom domain.
- [ ] **Check public URLs use the apex:** canonical / Open-Graph / `schema.org` `url` / any sitemap should point to `https://ceylonhop.com` (not github.io/localhost).

## 4. Verify after switching (smoke test on production)

- [ ] A real (small) booking on `ceylonhop.com` completes a **live** PayHere payment → booking goes `paid`.
- [ ] The confirmation email actually arrives at a **non-owner** address (proves the domain is verified).
- [ ] Maps + Places autocomplete work on the apex (no referrer/console errors).
- [ ] WhatsApp CTA opens the correct number (`+94779669662`).
- [ ] `web-tests` (`npm run test:all`) and `api` (`npm run check`) both green.

---

## Still-to-build (not launch-blocking — but finish or consciously defer)

- **Customer emails** beyond confirmation: ✅ **cancellation** (`POST /admin/bookings/:id/cancel`) and ✅ **refund** (`/refund`) now built + branded. Still to do: deposit/balance (blocked by the chauffeur deposit-charge fix), driver-assigned, "we need your details", payment-didn't-complete. **Reminders + thank-you/review request need a job runner (M14).** (Tracked in the agent's email roadmap notes.)
- **M11** authoritative pricing engine (interim: site sends `quotedTotal`, API stores it, checkout charges exactly that — site = DB = charge agree today; the authoritative server engine is M11) · **M12** ops dashboard (Slice-1 backend shipped; UI prototype parked — see `ops-dashboard-status.md`) · **M13** WhatsApp Business API · **M14** reminders/SLA timers · **M15** reporting/CSV export.

---

_Last updated: 2026-06-23. Add new items as they arise — don't rely on memory._
