# Ceylon Hop — Staging Environment: Spec & Phased Rollout

**Status: PLANNED — recorded 2026-07-13. Not started.** Owner reference for standing up a
truly isolated staging environment so the team can start using the ops/quoting tool ahead of
the customer-site launch, with a path toward using it as a pre-production gate. Read alongside
the [go-live checklist](./go-live-checklist.md) — staging is essentially a dry run of the
go-live config.

---

## 1. Why

`ceylonhop.com` is today a **live WordPress site** taking real bookings and payments. We are
rebuilding both the customer site and the ops/quoting tool (the new stack lives in this repo:
Hono API + `/ops` dashboard on Render, static site on GitHub Pages).

The immediate need: **let the team start generating quotes in the new quoting tool now**,
before the customer site cuts over to the apex — with **zero risk** to the live WordPress site
and **zero risk** to real production data. The team needs somewhere they can work (and break
things) freely.

The answer is a **truly separate staging environment**: its own database, its own API/ops
service, its own URL. Same code, isolated everything else.

## 2. Isolation guarantees (non-negotiable)

Staging must be incapable of touching production or real customers:

1. **Separate database** — its own Supabase project. Staging can never read or write prod data.
2. **Sandbox PayHere** — `PAYHERE_MODE=sandbox`; no real card is ever charged.
3. **No real email** — no `RESEND_API_KEY` (uses the fake email adapter), or a test sender; a
   staging run never emails a real customer.
4. **Own secrets** — its own `OPS_SESSION_SECRET` / `BOOKING_LINK_SECRET` / `ADMIN_API_KEY`, so
   a staging session/link can't be replayed against production and vice versa.
5. **No apex impact** — staging is a subdomain (or a raw `.onrender.com` URL). Subdomain DNS is
   independent of the apex, so the live WordPress site is never touched.

## 3. Architecture

| Component | Production | Staging (new) |
|-----------|-----------|---------------|
| Database | Supabase prod project | **New Supabase project** (own connection string + backups) |
| API + `/ops` service | `ceylon-hop-api` on Render | **2nd Render web service**, same repo, pointed at the staging DB |
| Ops URL | `ceylon-hop-api.onrender.com/ops` (→ apex later) | `ops-staging.ceylonhop.com/ops` (or the raw `.onrender.com/ops`) |
| Customer site | GitHub Pages (apex at cutover) | Optional/later — a preview deploy or a second Pages branch (not needed for quoting) |
| What differs | — | **Only the env vars.** Same code. |

The whole separation is in the environment variables — the code is identical.

## 4. Environment-variable matrix

| Variable | Production (at launch) | Staging |
|----------|------------------------|---------|
| `DATABASE_URL` | prod Supabase (rotated) | **staging Supabase** ← the isolation |
| `PAYHERE_MODE` + creds | `live` + live merchant | `sandbox` + sandbox creds |
| `RESEND_API_KEY` | set (real sender) | **unset** (fake adapter) or test sender |
| `EMAIL_FROM` | verified domain sender | `onboarding@resend.dev` (test) |
| `OPS_SESSION_SECRET` | strong, unique | **strong, unique, different** |
| `BOOKING_LINK_SECRET` | strong, unique | **strong, unique, different** |
| `ADMIN_API_KEY` | strong (cron/jobs) | strong, different |
| `OPS_USERS` | the 3 staff | same staff (they sign in on both) |
| `GOOGLE_OAUTH_CLIENT_ID` | prod OAuth client | same client — **add the staging origin** to its authorized JS origins |
| `ALLOWED_ORIGINS` | apex | staging origin(s) |
| `APP_BASE_URL` | `https://ceylonhop.com` | the staging ops URL |
| `ALERT_EMAIL` / `SENTRY_DSN` | prod values | optional (a test inbox / separate Sentry env, or leave off) |

Note the code **fails closed** in production on defaulted `OPS_SESSION_SECRET` /
`BOOKING_LINK_SECRET` (`config.ts`), so staging must still set real secret values.

## 5. Two flavors of staging — pick per phase

- **Flavor A — data isolation only (simplest):** the staging service deploys from **`main`**,
  same code as production, just a different DB. Unblocks the team immediately. It is *not* a
  "test new code before customers" gate — staging always has the same code as prod.
- **Flavor B — data isolation + code gate:** `main` → **staging** auto-deploys; production
  deploys only from a **`production` branch** (or a release tag) you promote to once staging
  looks good. This is the real "staging before prod" flow, but it changes how prod deploys
  (today `main` is prod for both the API and Pages).

**Recommendation:** start with **A** now (immediate, minimal change), move to **B** as the
customer-site apex cutover approaches and a code gate actually earns its keep.

## 6. Phased milestones

### M0 — Prep (repo work only; no live infra)
- Add an `npm run seed` script (`api/`) that runs the existing `seedCorridors()` so a fresh
  staging DB gets the 6 shared corridors. (No seed CLI exists today.)
- Optional: a `render.yaml` blueprint so the staging service is reproducible config-as-code.
- Write the exact env-var checklist + step-by-step runbook (Supabase → migrate/seed → Render →
  DNS → OAuth).
- **Exit:** everything needed to stand up staging exists in the repo; nothing touched live.

### M1 — Stand up staging (data-isolated; Flavor A)
- Create the staging Supabase project; capture its `DATABASE_URL`.
- `cd api && DATABASE_URL=<staging> npm run migrate` then `npm run seed` (corridors).
- Create the 2nd Render web service from the repo, root `api`, staging env vars (§4).
- Team uses the raw `.onrender.com/ops` URL for now; deploys from `main`.
- **Exit:** staff can sign in, generate + send a quote on staging, and a spot-check confirms
  **nothing** landed in the prod DB. Break-freely environment is live.

### M2 — Branded subdomain + polish
- Add `ops-staging.ceylonhop.com` as a custom domain on the staging Render service (auto-TLS).
- Cloudflare: add the `ops-staging` CNAME → Render's target.
- Google Cloud: add `https://ops-staging.ceylonhop.com` to the OAuth client's authorized JS
  origins.
- Optional: redirect the subdomain root (`/`) → `/ops` for a clean URL.
- **Exit:** team uses `ops-staging.ceylonhop.com/ops`; the live WordPress apex is untouched.

### M3 — Code gate / promotion flow (Flavor B) — when a gate is worth it
- Introduce a `production` branch (or release tags): `main` → staging (auto), promote →
  production (manual/merge).
- Document the promotion runbook (verify on staging → promote → verify on prod).
- **Exit:** a change demonstrably flows `main` → staging → (verify) → production.

### M4 — Fold into go-live
- At the customer-site apex cutover, keep staging as the standing pre-prod gate.
- Cross-reference the [go-live checklist](./go-live-checklist.md): staging validates the same
  env/config switches before they hit real customers.
- **Exit:** go-live uses staging as the dry run.

## 7. Repo work vs. dashboard work

- **Repo (can be prepared ahead — my side):** the `seed` script, `render.yaml`, the runbook,
  the env-var checklist, and (for Flavor B) the branch/promote wiring docs.
- **Dashboards (owner action, needs your accounts):** create the Supabase project, create the
  Render service, add the DNS record, add the OAuth origin. Cloud accounts/services can't be
  created from the repo.

## 8. Open decisions (resolve when picking this up)

- **Flavor A vs B, and when** to move A → B (recommendation: A now, B near apex cutover).
- **Subdomain name:** `ops-staging.ceylonhop.com` vs `staging-ops…` vs `ops.staging…`.
- **Customer-site staging:** do we also want a staged front-end (preview deploy / second Pages
  branch), or is ops-only staging enough for now? (Quoting needs only the API + `/ops`.)
- **Seed data:** corridors are required; do we also want a few demo bookings/quotes for staff
  training on staging?
- **Tier/cost:** free Supabase + Render tiers (they sleep / have limits) vs paid for a snappier
  staging. Free is fine to start.
- **Payment-collection dependency (important):** quoting works fully on staging today, but
  turning a quote into a *paid* booking still needs the payment path — the customer site on the
  apex (PayHere) or the WhatsApp payment-link tool (unbuilt). Staging quoting is live before
  payment *collection* is.

---

_Recorded 2026-07-13. Add updates here as this is picked up._
