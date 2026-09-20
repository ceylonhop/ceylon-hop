# Apex cutover runbook — `ceylonhop.com` becomes the new site

Date: 2026-09-20
Status: **NOT STARTED.** Design agreed with the owner 2026-09-20; every phase below is
unexecuted. Tick the boxes as they land.

This is the **one-time** switch that makes the new stack the live customer site, retires
`prod.ceylonhop.com`, and stands up a login-gated `staging.ceylonhop.com` in its place. It
supersedes the "serve the new site on the apex" bullet in
[go-live-checklist.md](./go-live-checklist.md) §3 and the apex tail of
[seo-migration-plan.md](./seo-migration-plan.md); the env/console rows in the go-live
checklist still apply and are cross-referenced where relevant.

For the *recurring* deploy, see [promote-checklist.md](./promote-checklist.md). That flow does
not change — but after this cutover it gains a second job, described in §1.

---

## 0. End state

| Host | Serves | From branch | Who can reach it |
|---|---|---|---|
| `ceylonhop.com` + `www` | GitHub Pages | **`production`** | everyone |
| `staging.ceylonhop.com` | **Cloudflare Pages** (new project) | `main` | staff only, via Cloudflare Access |
| `ops.` / `pay.` / `quote.` / `ride.ceylonhop.com` | Render `ceylon-hop-api` | `production` | unchanged |
| `ops.staging.ceylonhop.com` | Render `ceylon-hop-staging` | `main` | unchanged |
| `prod.ceylonhop.com` | — | — | **retired** |

Owner decisions behind this shape (2026-09-20): `prod.ceylonhop.com` dies rather than being
kept as a second public copy; the replacement test surface is login-gated; the apex moves to
the `production` branch so a front-end merge stops being an instant customer release.

## 1. What changes about shipping

Today GitHub Pages serves `prod.ceylonhop.com` from `main`, so **merging any front-end change
to `main` ships it to whoever is looking, with no promote and no staging bake.** Only the API
half waits for a `production` promote.

After this cutover:

- `main` → **staging**, both halves together: Cloudflare Pages rebuilds
  `staging.ceylonhop.com` and Render redeploys `ceylon-hop-staging`. The site and the API a
  reviewer tests are cut from the same commit.
- `production` → **prod**, both halves together: the promote PR `main → production` now ships
  the customer site *and* the API in one merge.

The cost is real and worth stating: every front-end tweak now needs a promote PR, and several
concurrent sessions merge to `main` daily. The benefit is that the apex stops changing under
customers without a review.

**Docs that become wrong the moment Phase 1 lands** (update them in the same PR, §8):
`CLAUDE.md` maintenance rule 7 ("The static site on GitHub Pages still deploys from `main`"),
the go-live checklist §3 bullet, and the standing agent memory that says a front-end merge is a
customer release.

## 2. Preconditions — do not start Phase 1 until these are true

- [ ] **Prod `ALLOWED_ORIGINS` includes the apex and www.** Verified **missing** on
      2026-09-20: a preflight with `Origin: https://ceylonhop.com` came back with no
      `Access-Control-Allow-Origin` header, while `prod.ceylonhop.com` got one. The code
      default in `api/src/config.ts` *does* list the apex — Render's env var overrides it. If
      this is not fixed, every quote, booking and payment call on the new apex fails the
      instant DNS flips. This is Phase 0 work, but it is also a hard gate.
- [ ] **The six terms facts are filled in.** `terms.html` still renders 6
      `[… OWNER TO CONFIRM]` placeholders in production. Needed: company name + registration
      number, registered address, governing law, jurisdiction, shared-seat cancellation policy,
      effective date. Edit `tools/legal/terms.body.html` and regenerate — never the generated
      `terms.html` directly. On `prod.ceylonhop.com` these are an internal embarrassment; on
      the apex they are the refund contract a paying customer is agreeing to.
- [ ] **The current apex DNS records are exported and saved outside Cloudflare.** The apex is
      Cloudflare-proxied, so the WordPress origin address is visible only inside the Cloudflare
      dashboard. Without a saved copy, rollback (§9) means hunting for a hosting login under
      time pressure. Export the whole zone file.
- [ ] **Confirm whether `ceylon-hop-staging` has its own Supabase project.** Check
      `DATABASE_URL` on that Render service. If it points at the prod database, then
      `staging.ceylonhop.com` is *not* a safe sandbox and Phase 4's data-isolation claim is
      false — fix that before relying on it for test bookings.
      ([staging-environment-plan.md](./staging-environment-plan.md) §3 planned a separate
      project; whether it was created has not been verified from the repo.)

## 3. Phase 0 — additive prep (safe, nothing user-visible)

Every item here only *adds* an allowed value. None of it changes what a visitor sees, so it can
be done hours or days ahead, and it should be — Phase 2 is much less tense when this is done.

- [ ] Render `ceylon-hop-api` → `ALLOWED_ORIGINS` += `https://ceylonhop.com`,
      `https://www.ceylonhop.com`. Keep the existing values for now; §8 trims them later.
- [ ] Google Cloud console → **browser** Maps/Places key → Website restrictions +=
      `ceylonhop.com/*`, `www.ceylonhop.com/*`. (Two Maps keys exist — browser and server. This
      is the browser one; the server key takes no referrer restriction.)
- [ ] Google Cloud console → OAuth client → Authorised JavaScript origins +=
      `https://ceylonhop.com`, `https://www.ceylonhop.com`. Covers both ops sign-in and the
      ride board's customer sign-in.
- [ ] GitHub → repo/org settings → **verify the apex domain** for Pages (add the
      `_github-pages-challenge-…` TXT record). Prevents anyone else claiming `ceylonhop.com`
      on Pages later. `prod.ceylonhop.com` is already verified; the apex is not.
- [ ] PayHere dashboard: confirm the apex is an approved domain. Live money currently settles
      on `pay.ceylonhop.com` under the apex registration (2026-08-02), so this is expected to
      be a no-op — confirm, don't assume.

Verify Phase 0 landed:

```bash
curl -s -o /dev/null -D - -X OPTIONS \
  -H "Origin: https://ceylonhop.com" \
  -H "Access-Control-Request-Method: POST" \
  https://ceylon-hop-api.onrender.com/quote | grep -i access-control-allow-origin
```

Expect `access-control-allow-origin: https://ceylonhop.com`. No header means not done.

## 4. Phase 1 — the release gate (order matters)

**Read this before clicking anything.** GitHub Pages reads the `CNAME` *file* from whichever
branch it serves, and repoints the custom domain to whatever that file says. So the branch
switch has to happen before the file changes, and the file has to end up correct on `main` as
well as `production`.

1. [ ] **Pages source branch `main` → `production`.** At this moment `production`'s `CNAME`
       file still reads `prod.ceylonhop.com`, so the site keeps serving at the old address,
       just built from the `production` branch. `production` may be a few commits behind
       `main`; that brief content regression on a domain that is about to be retired is
       acceptable.
2. [ ] **Change `CNAME` to `ceylonhop.com` on `main`** (one-line PR) and merge it.
       `staging.ceylonhop.com` does not read this file — Cloudflare Pages takes its domain from
       its own project settings — so `main` carrying the apex value is correct and necessary:
       if `main` kept `prod.ceylonhop.com`, the *next* promote would silently revert the apex.
3. [ ] **Merge the promote PR `main → production`.** Check it for migrations first
       (`git diff --name-only origin/production...origin/main -- api/drizzle`) — a migration in
       the range auto-applies on Render boot and is its own release decision. The instant this
       merges, Pages repoints to `ceylonhop.com` and **`prod.ceylonhop.com` stops serving.**

Between step 3 and the certificate issuing in Phase 2, the new site is unreachable at *any*
address. Customers are unaffected — WordPress still answers the apex until Phase 2 — but the
team is locked out of the new site for that window. Do not start Phase 1 without time to finish
Phase 2.

## 5. Phase 2 — DNS, certificate, redirects

The apex already sits on Cloudflare (`eve/titan.ns.cloudflare.com`), so this is all in an
account you own.

- [ ] Point `ceylonhop.com` and `www` at GitHub Pages (apex via CNAME flattening to
      `ceylonhop.github.io`, or the four Pages A records). **Change A/AAAA/CNAME for the apex
      and www only. Do not touch MX or TXT** — those carry your mail and the Resend SPF/DKIM
      for `send.ceylonhop.com`.
- [ ] Set those records **DNS-only (grey cloud) first.** GitHub issues the Let's Encrypt
      certificate by fetching the domain itself, and that fetch fails while Cloudflare proxies
      it. Wait for the Pages settings page to report the certificate as issued.
- [ ] **Then turn the proxy back on (orange cloud)** and set Cloudflare SSL mode to **Full
      (strict)**.
- [ ] Import [`cloudflare-redirects.csv`](./cloudflare-redirects.csv) (27 rules) as **Bulk
      Redirects**, 301. Bulk Redirects only run on a *proxied* record — they do nothing until
      the previous step is done.
- [ ] Add a `www → apex` 301 redirect rule.

These two requirements pull against each other for a few minutes: the certificate needs the
proxy off, the redirects need it on. Sequence them; don't try to satisfy both at once.

## 6. Phase 3 — flip the API base and verify

- [ ] Render `ceylon-hop-api` → `APP_BASE_URL` = `https://ceylonhop.com`. **Last**, because
      booking and manage links are minted from this value and would 404 until the apex serves
      the new site.

Then verify — each command proves one specific thing, and a green health check proves none of
them:

```bash
# the apex is the NEW site, not WordPress
curl -s https://ceylonhop.com/ | grep -c wp-content          # expect 0
curl -s https://ceylonhop.com/ | grep -o 'site\.css?v=[a-z0-9]*'   # expect the stamp on production

# CORS actually works from the apex (the Phase 0 gate, re-proven in place)
curl -s -o /dev/null -D - -X OPTIONS -H "Origin: https://ceylonhop.com" \
  -H "Access-Control-Request-Method: POST" \
  https://ceylon-hop-api.onrender.com/quote | grep -i access-control-allow-origin

# legacy URLs 301 to their new homes (spot-check three from the CSV)
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://ceylonhop.com/trip/kandy_to_ella/
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://www.ceylonhop.com/

# the canonical a route page claims now resolves (it 404'd for the whole pre-cutover period)
curl -s https://ceylonhop.com/trip/kandy-to-ella/ | grep canonical
curl -s -o /dev/null -w '%{http_code}\n' https://ceylonhop.com/sitemap.xml
```

- [ ] Open the apex in a browser and get a **live price quote** — this is the real CORS proof;
      the preflight above only proves the header.
- [ ] Complete one small **live booking** end to end and confirm the confirmation email
      arrives at a non-owner address.
- [ ] **GA4 DebugView: confirm `purchase` fires.** It has been suppressed by design —
      `chIsProd()` in `analytics.js` matches only `(www|pay|quote|ride.)ceylonhop.com`, and the
      site has been served from `prod.ceylonhop.com`. At the apex it starts matching with **no
      code change**. If `purchase` still does not appear, the cause is the GTM tag, not
      `chIsProd`.
- [ ] Search Console: submit `sitemap.xml`, request indexing of the top route pages, then watch
      Coverage/404 for 4–6 weeks. Expect a short ranking wobble that recovers if the redirects
      are clean.

## 7. Phase 4 — `staging.ceylonhop.com`

GitHub Pages allows **one custom domain per repository** and offers no authentication of any
kind, so staging cannot be a second Pages site on this repo. It goes on Cloudflare Pages, which
is already where the DNS lives and which can sit behind Cloudflare Access.

- [ ] Create a **Cloudflare Pages** project connected to this repo, production branch = `main`.
- [ ] Build command `node tools/build-staging.mjs`, output directory `.dist-staging/`.
- [ ] Custom domain `staging.ceylonhop.com`.
- [ ] **Cloudflare Access** policy on that hostname: the three staff Google accounts (free tier
      covers up to 50 users). Without this, staging is a public duplicate of the site — which
      is an SEO problem as well as a privacy one.

`tools/build-staging.mjs` copies the site into `.dist-staging/` (dot-prefixed so a local
build stays invisible to the unit tests that walk the repo root for pages) and injects into
every page, **ahead of that page's first script**:

```html
<script>window.CEYLON_HOP_API='https://ops.staging.ceylonhop.com'</script>
<meta name="robots" content="noindex">
```

Insertion point matters. Every page reads
`window.CEYLON_HOP_API || 'https://ceylon-hop-api.onrender.com'` (and `board.html` defaults to
`https://ops.ceylonhop.com`), so the value has to be set before that line runs — after which
the page's own `||` fallback keeps it.

Two properties this design deliberately preserves:

- **Nothing committed is modified.** The stamping happens only inside Cloudflare's build, so no
  `@generated:` block is edited in the repo and the codegen/parity tests stay green.
- **Analytics needs no work.** `chIsProd()` does not match `staging.ceylonhop.com`, so GA4
  revenue events stay off there by the gate that already exists.

Guarded by `web-tests/unit/build-staging.test.js`. The assertion is **positional, not
textual**: each page keeps its own `|| 'https://ceylon-hop-api.onrender.com'` fallback in the
file — unused, because the variable is already set — so "no page mentions prod" would be a
false invariant. The test requires the staging assignment to appear *before* any prod host the
page mentions. A build that appended the assignment instead would satisfy a grep and point the
whole staged site at production.

## 8. Phase 5 — after it beds in

- [ ] Trim `ceylonhop.github.io` and `localhost` out of prod `ALLOWED_ORIGINS`, leaving the
      apex and www. (Note: this makes a local front-end unable to price against prod — that is
      the intent, and the local-API recipe is the supported path.)
- [ ] Flip `web-tests e2e (offline)` to a **required** check on `main`. This was deferred to
      cutover deliberately (owner, 2026-08-15): while WordPress served customers a regression
      cost a bad demo; now it costs bookings. Worth proving `--workers=4` over a few runs first
      so the gate people cannot bypass is also the fast one.
- [ ] Update the docs that now describe the old release model: `CLAUDE.md` maintenance rule 7,
      go-live-checklist §3, seo-migration-plan's status header.
- [ ] Decide what happens to the `prod.ceylonhop.com` DNS record — removing it is cleanest;
      leaving it pointed at Pages means it serves the apex's content under the wrong hostname.

## 9. Rollback

Rollback has two halves, and doing only the first leaves the new site stranded.

1. **DNS:** restore the apex and www A/AAAA/CNAME records from the export taken in §2.
   WordPress answers the apex again within the TTL.
2. **Pages:** set the `CNAME` file back to `prod.ceylonhop.com` (on both `main` and
   `production`, for the reason in §4 step 2), or point the Pages custom domain back from the
   settings page. Otherwise Pages still believes it owns an apex that now resolves elsewhere,
   and the new site is reachable nowhere.

`APP_BASE_URL` should go back to its previous value at the same time, or freshly minted booking
links will point at a WordPress 404.

Nothing in this cutover touches the database, so there is no data rollback and no migration to
reverse.

## 10. Known traps

- **The `CNAME` file is the Pages custom domain.** Editing it on the served branch repoints the
  site immediately. This is why Phase 1 switches the branch first.
- **A promote reverts the apex** if `main`'s `CNAME` file is left at `prod.ceylonhop.com`.
- **The certificate and the redirects want opposite proxy states** (§5).
- **A green `/health` proves nothing about a deploy** — during a Render rollout it is the *old*
  instance answering. Check the specific expected asset stamp instead.
- **Pages ignores commits that only touch API files, and Render's build filter ignores commits
  that only touch root HTML.** After Phase 1 the apex needs a promote *and* the promote needs
  to contain something the relevant builder watches.
- **`prod.ceylonhop.com` is in the test suites and docs.** It appears in `analytics.js`,
  `board.html`, `api/src/routes/rideBoard.ts`, several tests and several docs. Most of those
  references are correct as-is (they describe the API host or assert the analytics gate), so
  sweep them deliberately rather than with a global replace.

## 11. Division of labour

**Owner only** (no repo access can do these): all Render env vars, the GitHub Pages source
branch and custom domain, every Cloudflare change (DNS, proxy, bulk redirects, Pages project,
Access policy), both Google consoles, PayHere, Search Console, and the six terms facts.

**Agent** (PRs, reviewable): the `CNAME` file change, `tools/build-staging.mjs` and its test,
the promote PR, the doc updates in §8, and running every verification probe in §6.
