# Ceylon Hop — Staging Environment: Spec & Phased Rollout

**Status: PLANNED — recorded 2026-07-13 (rewritten to be full-stack + honest about the
sandbox-vs-gate distinction). Not started.** Owner reference for standing up an isolated
staging environment covering **both** the customer site and the ops/quoting tool. Read
alongside the [go-live checklist](./go-live-checklist.md) — staging is the dry run of the
go-live config.

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
| **Email** | No `RESEND_API_KEY` (fake adapter) or a test sender — never emails a real customer. |
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

## 6. Migration discipline (the hard operational cost)

A second database **doubles** the manual-migration surface, and migrations are **not** applied
automatically (this is what caused the 0013/0014 prod incident — see the go-live checklist).
Owning this is the price of a second environment, and done right it turns staging into the
thing that *catches* migration problems:

- **Rule: every migration runs on staging first**, is verified, then runs on prod. Staging is
  the migration dry-run.
- **During a promotion (Flavor B): migrations run BEFORE the code that needs them.** Order:
  `migrate prod DB → deploy prod code`. Never ship code that reads a column the DB lacks.
- **Track which migration each environment is at** (a short log in this doc or the runbook), so
  staging and prod never silently diverge.

## 7. Two flavors — sandbox vs gate (be honest about which)

- **Flavor A — data-isolated sandbox (Goal A).** Staging deploys from `main`, **same code as
  prod**, different DB + isolated third parties. Unblocks the team immediately. It does **not**
  gate code — staging always mirrors prod.
- **Flavor B — pre-prod code gate (Goal B).** `main` → **staging** auto-deploys; **production
  deploys only from a `production` branch (or release tag)** you promote to once staging looks
  good, following the migration-ordering + rollback discipline. *This* is "staging before
  production deploy."

**Recommendation:** **A now** (fast, unblocks quoting), **B before the customer-site apex
cutover** (when a gate earns its keep). Do not mistake A for a gate.

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

### M0 — Repo prep (no live infra)
- `npm run seed` (`api/`) → runs `seedCorridors()` for a fresh staging DB.
- `render.yaml` blueprint (config-as-code; **no secrets in the file** — those go in Render).
- Front-end **env switch** for `CEYLON_HOP_API` + analytics-off + beacon target (so a staged
  build points at staging cleanly).
- Runbook + a migration-state log.
- **Exit:** everything to stand up staging exists in the repo; nothing live touched.

### M1 — Staging DB + API/`ops` (Goal A / Flavor A)
- Create staging Supabase; `DATABASE_URL=<staging> npm run migrate` then `npm run seed`.
- 2nd Render service, staging env (§5) incl. **its own Sentry + beacon isolation**.
- Team uses the raw `.onrender.com/ops` at first; deploys from `main`.
- **Exit:** staff quote on staging; a spot-check confirms **nothing** reached the prod DB, prod
  Sentry, or prod analytics.

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
- Document the **promotion runbook**: migrate prod → deploy prod → verify; and a **rollback**
  path (revert the prod branch / redeploy the prior release).
- **Exit:** a change demonstrably flows `main` → staging → (verify) → production, migrations
  first.

### M5 — Fold into go-live
- Keep staging as the standing pre-prod gate; it validates the same env/config switches the
  go-live checklist flips before real customers see them.
- **Exit:** go-live uses staging as its dry run.

## 10. Realities & open decisions (own these when picking it up)

- **Free-tier reality:** free Render **sleeps** (15-min cold starts) and free Supabase
  **pauses**. For an environment the team uses *daily*, budget for a paid tier or accept the
  cold starts — "free is fine" was optimistic.
- **Payment-collection blocker** (§8) — resolve before assuming staging is "end to end."
- **Migration sync is a standing manual cost** (§6).
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
