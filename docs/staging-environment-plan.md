# Ceylon Hop — Staging Environment: Spec & Phased Rollout

**Status: v3 — IN BUILD (M0 repo prep done 2026-07-18).** Owner reference for standing up an
isolated staging environment covering **both** the customer site and the ops/quoting tool. Read
alongside the [go-live checklist](./go-live-checklist.md) and the actionable
[runbook](./staging-environment-runbook.md).

## v3 decisions (owner-approved 2026-07-18) — supersede the conflicting v2 text below

1. **Staging email = real sending fenced by an allowlist**, not a fake adapter. Real Resend, but
   `EMAIL_ALLOWLIST` drops any recipient that isn't a team address — so staging tests real
   deliverability with zero chance of emailing a customer. (Updates the §3 "Email" row.)
2. **Go straight to the gate (Flavor B now), not sandbox-first.** The site isn't live yet, so the
   cost of adopting the gate early is near-zero and it delivers "test on staging, release
   deliberately" from day one. (Updates the §7 recommendation.)
3. **Promote on the owner's word.** "This is good, push to prod" → the owner-run promote script
   verifies staging CI is green for that commit, moves `production`, and prod redeploys. Rollback
   is the same script pointed at a known-good commit.

**Also corrected:** the "Playwright e2e against the staged stack" idea (§6 G4) is implemented as
the ops⇄quote e2e running in **CI against an ephemeral Postgres** (the suite boots its own API
and writes to a throwaway DB — it is not built to hit a remote URL), **plus** a read-only
post-deploy **smoke** against the live URL. Both exist in the repo now.

**M0 build status:** `render.yaml`, `api/scripts/seed.ts`, `scripts/smoke-deploy.mjs`,
`scripts/promote-to-prod.mjs`, `.github/workflows/e2e.yml`, the `EMAIL_ALLOWLIST` adapter, and
`tools/stage-config.mjs` are all built + tested. Remaining work is dashboard/DNS/secrets — see
the [runbook](./staging-environment-runbook.md).

---

_Historical v2 text follows (recorded 2026-07-13). Where it conflicts with the v3 decisions
above, v3 wins._

---

## 1. Name the two goals — they need different solutions

"Staging" is doing double duty here, and the two jobs are not the same:

- **Goal A — early team access (a sandbox).** Let the team start quoting *now*, before the
  customer site launches, with zero risk to real data. Needs only **data isolation**.
- **Goal B — a pre-production gate.** Validate new code, config, and DB migrations on a
  staging copy *before* real customers hit them. Needs a **code gate** where changes land on
  staging first and are promoted to prod deliberately.

**"Staging before production deploy" = Goal B.** The team-quoting need = Goal A. They are
different problems: Goal A is solved by a second isolated deployment; Goal B additionally
requires a promotion flow. This plan delivers **A first** (fast, unblocks the team) and **B
later** (the real gate), and is explicit that **A alone is a sandbox, not a gate.**

## 2. Scope — both apps, one staging DB

This is a **full-stack** staging environment. Three tiers, isolated as a set:

1. **Customer website** (static front-end) — staged front-end pointing at the staging API.
2. **API + `/ops` dashboard** (Hono on Render) — staging service pointing at the staging DB.
3. **Database** (Supabase) — one staging project shared by both.

A test booking must flow **staging-site → staging-API → staging-DB → staging `/ops`**, entirely
on throwaway data.

## 3. Isolation guarantees — the complete list (including third parties)

Data isolation alone is not enough; the shared third-party sinks leak if unmanaged.

| Concern | Guarantee |
|---------|-----------|
| **Database** | Own Supabase project — staging can't read/write prod data. |
| **Payments** | `PAYHERE_MODE=sandbox` — no real card ever charged. |
| **Email** | **v3:** real `RESEND_API_KEY`, but `EMAIL_ALLOWLIST` fences delivery to team addresses (`AllowlistEmailAdapter`) — real deliverability testing, never a customer. |
| **Sessions/links** | Own `OPS_SESSION_SECRET` / `BOOKING_LINK_SECRET` / `ADMIN_API_KEY` — can't cross to prod. |
| **Apex** | Subdomain-only DNS — the live WordPress apex is never touched. |
| **Error beacon** | The front-end + ops error beacons must point at the **staging API** (`window.CEYLON_HOP_API` = staging), NOT prod — otherwise staging errors flood **prod Sentry** (exactly the bug the e2e tests caused). |
| **Analytics** | GTM/GA4/Clarity **off** on the staged site (or a separate GA property) — staging traffic must not pollute prod analytics. |
| **Maps key** | Prefer a **separate** browser Maps key restricted to the staging origins; at minimum know that a shared key bills the same Google account and burns the same quota. |
| **Observability** | Staging gets its **own** Sentry env + alert inbox, **on** (not off) — the point of a gate is that staging failures are *visible*. |

## 4. Architecture

| Tier | Production | Staging |
|------|-----------|---------|
| Database | prod Supabase | **staging Supabase project** |
| API + `/ops` | `ceylon-hop-api` on Render → prod DB | **2nd Render service** → staging DB |
| Customer site | GitHub Pages (apex at cutover) | **staged front-end** (`staging` branch on Pages, or Cloudflare/Render static) → staging API |
| Ops URL | onrender.com/ops (→ apex) | `ops-staging.ceylonhop.com/ops` |
| Site URL | apex | `staging.ceylonhop.com` |
| Maps key / analytics / beacon / Sentry | prod-scoped | **staging-scoped** (see §3) |

The code is identical across environments — the whole separation lives in env/config.

## 5. Env / config matrix

**API + `/ops` service (Render):**

| Variable | Production | Staging |
|----------|-----------|---------|
| `DATABASE_URL` | prod Supabase (rotated) | **staging Supabase** ← the core isolation |
| `PAYHERE_MODE` + creds | `live` + live | `sandbox` + sandbox |
| `RESEND_API_KEY` / `EMAIL_FROM` | real | unset (fake) / test sender |
| `OPS_SESSION_SECRET` / `BOOKING_LINK_SECRET` / `ADMIN_API_KEY` | strong, unique | strong, unique, **different** |
| `OPS_USERS` / `GOOGLE_OAUTH_CLIENT_ID` | 3 staff / prod client | same staff / same client + **staging origin added** |
| `ALLOWED_ORIGINS` / `APP_BASE_URL` | apex | staging origins / staging URL |
| `SENTRY_DSN` / `ALERT_EMAIL` | prod | **staging env DSN / test inbox (on)** |

Note: `config.ts` **fails closed** in production on defaulted secrets, so staging must still set
real secret values.

**Customer site (front-end config, at build/deploy):**

- `window.CEYLON_HOP_API` → **staging API** (so bookings + error beacons hit staging).
- Analytics (GTM) → disabled or a staging GA property.
- Any hard-coded prod URLs (canonical/OG) are irrelevant on staging but must not be indexed →
  `noindex` the staged site.

## 6. Drift & correctness guards (automated — required, not aspirational)

A second environment must *reduce* risk, not add a manual chore that becomes a new source of
drift. So these guards are **required and automated** — each replaces a "remember to do X" with
a check that fails loudly. (The 0013/0014 prod incident was a *manual* migration miss; a second
DB doubles that surface, so manual discipline is explicitly **not** an acceptable control here.)

- **G1 — Schema can't drift (automated).** Either run `drizzle-kit migrate` automatically on
  every deploy (staging + prod, via a Render pre-deploy hook), **or** add a CI check that
  asserts the target DB's applied-migration set equals the repo's migration files and **blocks
  the deploy** if not. Staging migrates first, prod follows. This *deletes* the manual "run it
  on both" step rather than documenting it.
- **G2 — Migrations run before the code that needs them.** Bake the order into the deploy
  itself (`migrate → then deploy code`) so it can't happen out of order — the exact fault behind
  the 0013/0014 500s. Never ship code that reads a column the DB lacks.
- **G3 — Config can't silently diverge.** `render.yaml` is the reviewed source of truth for
  every **non-secret** env var (config-as-code). Secrets live only in the dashboard, but
  `config.ts` already **fails closed** at boot on missing/default secrets — keep that as the
  presence check. A short "env parity" list in the runbook covers the dashboard-only values.
- **G4 — "It works" is proven by tests, not eyeballs.** CI runs the full suite — `api npm run
  check` + `web-tests` (Vitest) + a Playwright e2e against the staged stack — and a **green run
  is the promotion gate**: nothing reaches prod unless it passed on staging. No manual
  click-through substitutes for this.
- **G5 — Every deploy self-verifies (smoke).** A tiny post-deploy smoke script hits
  `/health/deep` (DB connectivity) then creates + reads back a quote (write path), and **fails
  the deploy** if either breaks — so a broken deploy is caught in seconds, automatically, on
  both environments.

**Keep the machinery small.** Fewer moving parts = fewer bugs. Prefer Render's built-in
pre-deploy/migrate hooks and (if it fits) preview environments or promote-a-known-commit over a
hand-rolled `production` branch — evaluate at M4. The guards above matter more than the branch
mechanics, and they are what actually make this plan *reduce* risk rather than add it.

## 7. Two flavors — sandbox vs gate (be honest about which)

- **Flavor A — data-isolated sandbox (Goal A).** Staging deploys from `main`, **same code as
  prod**, different DB + isolated third parties. Unblocks the team immediately. It does **not**
  gate code — staging always mirrors prod.
- **Flavor B — pre-prod code gate (Goal B).** `main` → **staging** auto-deploys; **production
  deploys only from a `production` branch (or release tag)** you promote to once staging looks
  good, following the migration-ordering + rollback discipline. *This* is "staging before
  production deploy."

**Recommendation (v2):** A now, B later. **Superseded by v3:** go straight to B (the gate) — the
site isn't live yet, so adopting the gate early costs almost nothing and delivers the
"test-on-staging, release-deliberately" workflow immediately. Staging still deploys from `main`
(so it mirrors what you're testing); the gate is that **prod** deploys only from `production`.

## 8. Blocking dependency: payment collection (not a footnote)

Quoting works fully on staging. **Turning a quote into a *paid* booking does not** — it needs
the payment path, which is either the customer site on the apex (PayHere is **apex-only**) or
the **WhatsApp payment-link tool that isn't built yet**. So on staging the team can do the whole
quote lifecycle **except collect payment**.

**Decision to make up front:** is quote-only enough for the team's early use (they quote + send;
payment handled however it is today on WordPress), or does the payment-link tool need to be
built before staging delivers real value? This gates how useful M1–M2 actually are.

## 9. Milestones

Each has an owner split (repo = can be prepped ahead; dashboard = your accounts) and an exit
criterion.

### M0 — Repo prep + the guards (no live infra)
- `npm run seed` (`api/`) → runs `seedCorridors()` for a fresh staging DB.
- `render.yaml` blueprint (config-as-code; **no secrets in the file** — those go in Render) — **G3**.
- **Pre-deploy migrate hook** so every deploy migrates before it serves — **G1 + G2**.
- **CI wiring:** `api` check + `web-tests` + a Playwright e2e against staging, gating promotion — **G4**.
- **Smoke script** (`/health/deep` → create+read a quote) run post-deploy — **G5**.
- Front-end **env switch** for `CEYLON_HOP_API` + analytics-off + beacon target (staged build
  points at staging cleanly).
- Runbook + migration-state note.
- **Exit:** all of the above exist in the repo and pass in CI; nothing live touched. The guards
  are in place *before* any environment is stood up.

### M1 — Staging DB + API/`ops` (Goal A / Flavor A)
- Create staging Supabase; the migrate hook (G1/G2) applies schema on first deploy; `npm run seed`.
- 2nd Render service, staging env (§5) incl. **its own Sentry + beacon isolation**.
- Team uses the raw `.onrender.com/ops` at first; deploys from `main`.
- **Exit:** the **smoke (G5) is green** and migrations were applied by the hook (not by hand);
  staff quote on staging; a spot-check confirms **nothing** reached the prod DB, prod Sentry, or
  prod analytics.

### M2 — Staged customer site (full-stack)
- Deploy the front-end to a staging URL, `CEYLON_HOP_API` → staging API, analytics off, beacon
  → staging, `noindex`.
- **Exit:** a test booking flows staged-site → staging-API → staging-DB → appears in staging
  `/ops`. (Payment step blocked per §8 — that's expected.)

### M3 — Branded subdomains + OAuth
- `ops-staging.ceylonhop.com` + `staging.ceylonhop.com` custom domains (auto-TLS), Cloudflare
  CNAMEs, and the staging origins added to the Google OAuth client.
- **Exit:** team uses branded URLs; apex untouched.

### M4 — Code gate (Flavor B / Goal B)
- Introduce a `production` branch or release tags: `main` → staging (auto), promote → prod.
- **The gate is automated:** promotion is allowed only when **G4 is green on staging** and runs
  **G2** ordering (migrate → deploy). Add a **rollback** path (revert the prod branch / redeploy
  the prior release).
- **Exit:** a change demonstrably flows `main` → staging → (CI green) → production, migrations
  first, with a tested rollback.

### M5 — Fold into go-live
- Keep staging as the standing pre-prod gate; it validates the same env/config switches the
  go-live checklist flips before real customers see them.
- **Exit:** go-live uses staging as its dry run.

## 10. Realities & open decisions (own these when picking it up)

- **Free-tier reality:** free Render **sleeps** (15-min cold starts) and free Supabase
  **pauses**. For an environment the team uses *daily*, budget for a paid tier or accept the
  cold starts — "free is fine" was optimistic.
- **Payment-collection blocker** (§8) — resolve before assuming staging is "end to end."
- **Migration sync is automated** by G1/G2 (§6); the residual cost is reviewing migrations in
  PRs, not running them by hand. If you *don't* build G1/G2, do not build staging — the manual
  version reintroduces the 0013/0014 failure at double the surface.
- **Verify the actual Render auto-deploy branch** before Flavor B — don't assume `main` is wired
  the way you think.
- **Subdomain names** — `ops-staging` / `staging` vs alternatives.
- **Demo data** — seed a few sample bookings/quotes for staff training, or start empty?
- **Staging data hygiene** — periodic reset (reuse the pre-launch purge SQL) so staging junk
  doesn't accumulate.

## 11. Repo work vs. dashboard work

- **Repo (prep ahead):** `seed` script, `render.yaml`, front-end env switch, runbook, migration
  log, Flavor-B branch/promote docs.
- **Dashboards (owner):** create the Supabase project, Render service, staged front-end host,
  DNS records, OAuth origins, secrets, and a staging Maps key.

---

_Recorded 2026-07-13 (v2). Add updates here as this is picked up._
