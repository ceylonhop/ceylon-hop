# Ceylon Hop — Staging Environment Runbook

**Companion to [staging-environment-plan.md](./staging-environment-plan.md) (the design).** This is
the *do-it* doc: what's already built in the repo, and the exact dashboard steps you (the owner)
run to stand staging up. Written 2026-07-18.

The model we agreed on: **`main` auto-deploys to STAGING; production deploys only from a
`production` branch, promoted deliberately.** You say "push to prod", and the promote script
verifies staging CI is green, moves `production`, and prod redeploys. Test everything on staging;
release on your own schedule.

---

## 1. What's already built (this PR — repo side, no live infra touched)

| Artifact | Path | What it does |
|----------|------|--------------|
| Render blueprint | `render.yaml` | Config-as-code for the **staging** API + staging static site (no secrets in the file). |
| Seed script | `api/scripts/seed.ts` → `npm run seed` | Migrates + seeds corridors into a fresh DB (the API also seeds on boot). |
| Post-deploy smoke | `scripts/smoke-deploy.mjs` | Hits `/health` + `/health/deep` on a live URL; tolerates cold starts; non-zero exit on failure. |
| **Promote (the gate)** | `scripts/promote-to-prod.mjs` | The only path to prod: refuses unless `ci.yml` is green for the commit, then fast-forwards `production` + tags the release. Has `--dry-run`, `--rollback`, `--force`. |
| e2e workflow | `.github/workflows/e2e.yml` | Runs the ops⇄quote Playwright suite against an ephemeral Postgres. **Manual-dispatch only** for now — see the ⚠ note below. |
| Email allowlist | `api/src/adapters/email.ts` (`AllowlistEmailAdapter`) + `EMAIL_ALLOWLIST` env | Staging sends **real** mail but only to allowlisted team addresses; everything else is dropped. **Unset in prod → no behavior change.** |
| Site staging transform | `tools/stage-config.mjs` | Build-time: points the staged site at the staging API, adds `noindex`, turns analytics off. Never touches committed source. |

Migrations already **auto-apply on Render boot** (fail-closed) via `api/src/server.ts` — staging
inherits this, so a fresh staging DB gets its schema on first deploy with no manual step.

---

## 2. API/ops env matrix (production vs staging)

Non-secret values are in `render.yaml`. Secrets/env-specific values (⚙) you set in the Render
dashboard. `config.ts` **fails closed** at boot if the session/booking secrets are missing or left
at their dev defaults — so a half-configured service refuses to serve rather than run insecure.

| Variable | Production | Staging |
|----------|-----------|---------|
| `DATABASE_URL` ⚙ | prod Supabase | **staging Supabase project** ← core isolation |
| `PAYHERE_MODE` | `live` | `sandbox` |
| `PAYHERE_MERCHANT_ID/SECRET` ⚙ | live creds | **sandbox creds** |
| `PAYHERE_NOTIFY_URL` ⚙ | prod webhook | `https://<staging-api>/webhooks/payhere` |
| `RESEND_API_KEY` ⚙ | real | real (fenced by allowlist ↓) |
| `EMAIL_ALLOWLIST` ⚙ | **unset** | `@ceylonhop.com` (or explicit team addresses) |
| `EMAIL_FROM` | `…@ceylonhop.com` | `Ceylon Hop (staging) <onboarding@resend.dev>` |
| `OPS_SESSION_SECRET` / `BOOKING_LINK_SECRET` / `ADMIN_API_KEY` / `INTERNAL_QUOTE_KEY` ⚙ | strong, unique | strong, unique, **different** |
| `OPS_USERS` ⚙ | 3 staff | same 3 staff |
| `GOOGLE_OAUTH_CLIENT_ID` ⚙ | prod client | same client + **staging origin added** in Google console |
| `GOOGLE_MAPS_API_KEY` / `MAPS_BROWSER_KEY` ⚙ | prod-scoped | prefer **staging-restricted** keys (a shared key just bills the same quota) |
| `ALLOWED_ORIGINS` / `APP_BASE_URL` | apex | staging origins / `https://staging.ceylonhop.com` |
| `SENTRY_DSN` ⚙ | prod project | **staging Sentry project** (never the prod DSN — that was the e2e-flood bug) |
| `ALERT_EMAIL` ⚙ | prod inbox | team inbox (alerts ON — a gate's failures must be visible) |

Generate the unique secrets with, e.g.: `openssl rand -hex 32`.

---

## 3. Owner steps — stand up staging (do these when you're ready)

Order matters where noted. None of this touches production.

1. **Supabase — staging project.** Create a new project (separate from prod). Copy its connection
   string. Use the **pooler** URL with scheme `postgresql://`, URL-encode `@` in the password as
   `%40`, and quote the whole value. This becomes `DATABASE_URL`.
2. **Sentry — staging project.** Create a project for the staging environment; copy its DSN.
3. **Render — staging API service.** Either import `render.yaml` as a Blueprint, **or** create a
   Web Service manually: repo = this repo, branch = `main`, root dir = `api`, build =`npm ci`,
   start = `npm start`, health check path = `/health`. Then set every ⚙ var from §2 in the
   dashboard (Environment tab). Deploy. Render sets `RENDER=true`, so migrations apply on boot.
4. **Render — staging static site.** Create a Static Site: branch = `main`, build command =
   `node tools/stage-config.mjs .`, publish dir = `.`, and set `STAGING_API_URL` to the staging
   API's public URL (from step 3). Deploy.
5. **Google OAuth.** In the existing OAuth client, add the staging origins
   (`https://staging.ceylonhop.com`, and the raw `*.onrender.com` URLs while you test) to the
   authorized JS origins so ops sign-in works on staging.
6. **PayHere.** Put the **sandbox** merchant id/secret in the staging service; set the notify URL
   to the staging API's `/webhooks/payhere`.
7. **DNS (later, M3).** Cloudflare CNAMEs for `ops-staging.ceylonhop.com` and
   `staging.ceylonhop.com` → the Render services; add the custom domains in Render (auto-TLS).
   The apex/WordPress site is untouched.

**Verify the first deploy** (guard G5):

```
node scripts/smoke-deploy.mjs https://<your-staging-api>.onrender.com
```

Green = the API is serving and the DB answers. Then do a test booking on the staging site and
confirm it appears in staging `/ops`, and that **nothing** reached the prod DB / prod Sentry.

---

## 4. Flip on the gate (M4 — do this once staging feels solid)

1. **First promotion / create `production`.** From a clean checkout with `gh` authenticated:
   ```
   node scripts/promote-to-prod.mjs --dry-run   # preview
   node scripts/promote-to-prod.mjs             # creates `production` at the current green main
   ```
2. **Point prod at `production`.** In the **existing** prod Render API service, change the deploy
   branch from `main` → `production` (one dashboard setting). Now merges to `main` no longer touch
   prod — only a promote does.
3. **Prod website.** GitHub Pages (legacy) allows only one source branch, so either: (a) change
   the Pages source from `main` → `production` in repo Settings → Pages, **or** (b) move the prod
   site onto a Render static site from `production` for a uniform gate. Recommendation: (a) is the
   smaller change.
4. **Fix + fold e2e into the gate.** ⚠ The ops⇄quote e2e is currently **manual-dispatch only**
   because its first CI run surfaced pre-existing drift: 10 of 187 specs fail — the quote
   save/approve paths in `web-tests/e2e/quote-tool.spec.js` and `ops-ui.spec.js` don't set the
   `requested_service` field that became **required** in migration 0017 (PR #56). The harness
   itself is sound (177 pass). To make it a gate: (a) update those specs to select a requested
   service before saving, (b) switch `e2e.yml`'s trigger to `pull_request` + `push`, (c) add
   `'e2e.yml'` to `REQUIRED_WORKFLOWS` in `scripts/promote-to-prod.mjs`.

**Rollback:** `node scripts/promote-to-prod.mjs --rollback <known-good-sha>` (find one with
`git log --first-parent origin/production`). Render redeploys prod to that commit.

---

## 5. The daily loop (after the gate is on)

1. You build/merge features to `main` → they auto-deploy to **staging**.
2. You test on staging.
3. You say **"this is good, push to prod."**
4. I run `node scripts/promote-to-prod.mjs` → it checks staging CI is green → moves `production` →
   prod redeploys (migrations first, fail-closed) → I run the smoke against the prod URL.

---

## 6. Caveats to own

- **Free-tier sleep.** Free Render sleeps after ~15 min (cold starts); free Supabase pauses. The
  smoke script tolerates cold starts, but for daily team use budget a paid tier. If you want the
  staging API kept warm, add a staging copy of `.github/workflows/keepalive.yml` pointed at the
  staging URL (not added now — the URL doesn't exist yet).
- **No real card on staging.** PayHere is sandbox-only there; the first *live* charge is still a
  go-live-checklist item on the apex.
- **Secrets differ from prod.** Don't reuse prod secrets on staging — `config.ts` won't stop you,
  but the whole point is isolation. Generate fresh ones.
