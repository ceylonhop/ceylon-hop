# Ops Permissions & Roles — Design Spec

**Date:** 2026-07-03
**Status:** Designed — implementation deferred until the M12 slice 2 ops-dashboard branch (`m12s2-ops-dashboard`) lands, because both touch `api/src/app.ts` and the ops routes.
**Scope:** the two internal tools (quoting tool, ops bookings dashboard). The customer-facing website stays anonymous — no customer accounts (out of scope, see §8).

## 1. Problem

Ceylon Hop has three people and two internal tools, each with a different, weaker-than-needed auth story:

| Surface | Today | Problem |
| --- | --- | --- |
| Ops bookings dashboard (`/ops/*`) | Two shared keys (`OPS_SUPPORT_KEY`, `OPS_FOUNDER_KEY`) → HMAC-signed session cookie with role | Shared secrets; no idea *who* acted; no expiry on the cookie |
| Quoting tool (`/admin/quote/*`) | One shared `ADMIN_API_KEY` typed into a browser `prompt()` | Everyone with the key sees customer PII **and** cost/margin; different mechanism from `/ops`; key pasted into browsers |
| Customer website | No accounts (anonymous booking; `my-account/` redirects home) | Not a problem — intentionally out of scope |

## 2. Decision summary

- **D1 — Login is "Sign in with Google"** (Google Identity Services ID-token flow), not typed keys and not passwords. Free; no new vendor; uses the existing Google Cloud project (where the Maps keys live). Supabase Auth was considered and rejected: it still requires the same Google OAuth client, plus `supabase-js` and JWT plumbing, and earns nothing at 3 users.
- **D2 — Three roles:** `founder`, `finance`, `ops`. Exactly three people; each email maps to one role.
- **D3 — Allowlist is an env var**, `OPS_USERS="email:role,email:role,…"`. No user table, no management UI. Add/remove/re-role someone = edit the env var on Render.
- **D4 — Margins are founder-only.** Cost/margin data is stripped **server-side** for `finance` and `ops` — never sent to the browser, not merely hidden by the UI. (Finance can approve a refund from the customer-facing total without seeing driver cost.) See §3.1 for the exact routes/fields this gates.
- **D5 — One session, both tools; the cookie carries identity, not authorisation.** The HMAC-signed cookie holds `{email, exp}` only. **The role is looked up fresh from `OPS_USERS` on every request** — never baked into the cookie. This makes revocation instant: remove an email from the allowlist and their next request is denied, with no multi-day lag on an already-issued cookie. The quoting tool drops its `prompt()`/`x-admin-key` flow for humans and sits behind the same session as `/ops`.
- **D6 — Machines get a narrow `system` role, not founder.** `x-admin-key: ADMIN_API_KEY` authorises **only** the cron/job endpoints (`admin:jobs`) — it can NOT hit `payments:act` or any human capability. A leaked cron key therefore cannot issue refunds. There is no "break-glass founder via the key"; if Google sign-in is down (rare) the founder waits it out. (Rationale: the whole point of this milestone is attribution and least privilege — a max-privilege shared secret would reintroduce exactly what we're removing.)
- **D7 — Permission checks go through one capability map** — `can(role, action)` in `api/src/lib/opsAuth.ts` — not scattered `if (role !== 'founder')` comparisons.
- **D8 — Sessions expire after 7 days**; re-login is one tap of the Google button. Expiry bounds a *stolen cookie's* lifetime; *access revocation* is immediate via D5 (allowlist is authoritative per request). Rotating `OPS_SESSION_SECRET` is the "log everyone out now" lever (e.g. a stolen laptop).

## 3. Roles & capability matrix

| Capability (action key) | founder | finance | ops | system (machine) |
| --- | --- | --- | --- | --- |
| `quote:manage` — create/edit/send quotes, customer-facing prices | ✅ | ✅ | ✅ | ❌ |
| `margin:view` — cost/margin data in quote tool + dashboard | ✅ | ❌ | ❌ | ❌ |
| `bookings:operate` — day-to-day: view, assign vehicle, pickup/on-trip/complete | ✅ | ❌ | ✅ | ❌ |
| `bookings:read` — read-only bookings visibility (context for refunds) | ✅ | ✅ | ✅ | ❌ |
| `payments:act` — change a booking's money status + customer money emails. Today: cancel (releases shared seats, sends cancellation email) and refund (sends refund email; actual PayHere refund stays manual in their dashboard). Future actions inherit it: charging chauffeur balances, marking manual payments received | ✅ | ✅ | ❌ | ❌ |
| `admin:jobs` — watchdog/job endpoints (cron-driven) | ✅ | ❌ | ❌ | ✅ |

`system` is not a login role — no human can hold it. It is the identity minted for a valid `x-admin-key` header (D6) and is scoped to `admin:jobs` alone.

The matrix lives as data in `opsAuth.ts`; routes declare the action they need. Adding a capability is one row, not a route audit.

### 3.1 What `margin:view` gates (exhaustive)

Margin/cost must not leak through any surface, so this capability is enforced at every route that can carry it, not just the quote tool:

- **`/admin/quote/*` responses** — cost, margin, driver-cost, and any per-leg cost breakdown fields stripped for non-founder.
- **`/ops/finance/summary`** — founder-only route (returns 403 for finance/ops), since it aggregates cost/margin.
- **`/ops/bookings/:id`** — ~~the `payments` array may echo internal cost~~ **[CORRECTED 2026-07-04 during implementation]**: the booking-detail response (`booking` + `ride_ops` + `payments`) carries **no** cost/margin field — those live only on the *quote* entity, which this endpoint does not return. There is nothing to strip here, so the gate was **removed** (an inert strip is worse than none — false security theater). A code comment marks the spot: if cost tracking is ever added to this response, gate it behind `can(role, 'margin:view')` and test both sides. The real ops-layer cost surface is `/finance/summary` (above), and cost/margin exposure is enforced in the quote tool.
- **Daily ops digest email (M17)** — money/margin lines are founder-addressed; if finance/ops are ever added as recipients, the cost lines are omitted from their copy.

Stripping is server-side in every case; the UI merely hides panels when the fields are absent.

## 4. Auth flow

1. `/ops/login` (shared login page, served by the API) renders the Google Identity Services button with our OAuth **client ID** (public; no client secret in this flow).
2. Google returns an **ID token (JWT)** to the browser, which POSTs it to `POST /ops/login`.
3. The API verifies the token: signature against Google's published JWKS (cached), `aud` = our client ID, `iss` = Google, not expired, `email_verified === true`.
4. The verified email is looked up in `OPS_USERS` (case-insensitive). No match → `403` with a friendly "this Google account isn't authorised" page. Match → role.
5. The API sets the session cookie: HMAC-signed `{email, exp: now + 7d}` — **identity only, no role** — using the existing `OPS_SESSION_SECRET` (HttpOnly, Secure, SameSite=Lax — as today).
6. Middleware on `/ops/*` and `/admin/quote/*` verifies the cookie per request, then **re-resolves the role from `OPS_USERS` for the cookie's email on every request** (D5). Cookie expired/absent → redirect (HTML) or `401` (JSON). Cookie valid but email no longer in the allowlist → `403` (revoked). `x-admin-key` header match short-circuits to the `system` identity (`{email: "cron", role: "system"}`), which satisfies only `admin:jobs`.

Ops log lines and alert emails include the session email, so actions are attributable per person (complements M17 observability).

## 5. What changes where

> **Note on staleness:** this section references the ops routes as they stand *before* the in-flight `m12s2-ops-dashboard` reshape. The decisions above are stable; the exact symbol/line references below may shift once m12s2 lands and should be re-grepped at implementation time.

**`api/src/lib/opsAuth.ts`** — `OpsRole` becomes `'founder' | 'finance' | 'ops' | 'system'`; session payload becomes `{email, exp}` (no role); new `roleForEmail(email, cfg)` (case-insensitive, returns `null` when not in allowlist); new `can(role, action)` capability map (the §3 matrix as data); `roleForKey` and the key→role login path are deleted; the `x-admin-key` path resolves to the `system` role.

**`api/src/routes/ops.ts`** — login route swaps key-check for Google ID-token verification; the auth middleware verifies the cookie **and re-resolves the role per request** (returns 403 if the email left the allowlist); existing founder-only checks become `can(...)` calls; login page gains the Google button.

**`api/src/routes/internalQuote.ts` + `quote-tool.html`** — human auth switches from `prompt()`/`x-admin-key` to the shared session (unauthenticated browser hit → redirect to `/ops/login`). Quote payloads have cost/margin fields removed server-side unless `can(role, 'margin:view')`; the UI hides the corresponding panels when the fields are absent.

**Margin enforcement (per §3.1):** `/ops/finance/summary` becomes founder-gated; `/ops/bookings/:id` strips cost fields from its `payments` array for non-founder.

**Config (`api/src/config.ts` + Render env):**

| Env var | Change |
| --- | --- |
| `OPS_USERS` | **new** — `"email:role,…"`, exactly the 3 staff emails |
| `GOOGLE_OAUTH_CLIENT_ID` | **new** — from the existing Google Cloud project |
| `OPS_FOUNDER_KEY`, `OPS_SUPPORT_KEY` | **removed** (replaced by Google login) |
| `OPS_SESSION_SECRET` | kept — still signs the identity cookie |
| `ADMIN_API_KEY` | kept — **machines only** (`system` role, `admin:jobs`); no longer a human login or founder backdoor |

**`docs/go-live-checklist.md`** — env table updated at implementation time (add the two new vars, drop the two key rows, note the Google OAuth client setup step: authorised JS origins = the API origin + `ceylonhop.com` + `http://localhost:<dev-port>`).

**Token verification dependency:** verify Google ID tokens with a small JWKS/JWT library (e.g. `jose`) rather than hand-rolling; JWKS response cached with sane TTL so login survives brief Google JWKS latency.

**Dev & e2e login (must not depend on real Google):**
- **Unit tests** mock Google verification at the JWKS boundary and construct cookies directly.
- **Playwright e2e** authenticates by POSTing to a login path with a **dev-only signed-session helper** gated behind `NODE_ENV !== 'production'` — i.e. the test harness mints a valid `{email, exp}` cookie for a chosen allowlisted email without invoking Google. This bypass is compiled out / refuses to run in production (asserted by a test).
- **Local human dev** either uses the same dev bypass or a real dev OAuth client with `localhost` as an authorised origin — implementer's choice; the bypass is the low-friction default.

## 6. Error handling

- Email not in allowlist at **login** → `403`, friendly page naming the signed-in email so the user knows which account they used.
- Email removed from allowlist while holding a **valid cookie** (revocation) → next request re-resolves the role, finds none, returns `403` (HTML redirect to a "no longer authorised" page / `401`-style JSON). No wait for cookie expiry.
- Expired session → browser routes redirect to login; JSON routes return `401` and the tool UIs show a "session expired — sign in again" toast that links to login.
- Malformed/forged cookie → treated as absent (as today).
- `OPS_USERS` or `GOOGLE_OAUTH_CLIENT_ID` unset in production → ops/quote human login **fails closed** (same posture as the GL-1c quote-tool fix); machine key path unaffected.
- Google outage → **no founder backdoor via the key** (D6); the `system` identity can only reach `admin:jobs`, so cron keeps running but humans wait out the outage. Accepted for a 3-person team; Google Identity Services outages are rare and short. "Log everyone out immediately" (stolen device) is done by rotating `OPS_SESSION_SECRET`.

## 7. Testing

Tests-first, in the existing Vitest suites:

- `opsAuth` unit: identity-cookie round-trip with expiry (fresh, expired, tampered), `roleForEmail` (all three roles, unknown email → `null`, case-insensitive match), `can()` full matrix **including the `system` row** (system satisfies only `admin:jobs`).
- Login route: verified-token happy path per role, bad `aud`, unverified email, non-allowlisted email → 403, missing config → fails closed. Google verification is mocked at the JWKS boundary.
- **Revocation:** a request bearing a still-valid cookie whose email was removed from `OPS_USERS` → `403` (proves role is re-resolved per request, not read from the cookie).
- Route authorisation: each capability-gated route returns 403 for a role outside the matrix (esp. `payments:act` for ops, `admin:jobs` for finance, and `payments:act`/`quote:manage` for `system`).
- Margin stripping (per §3.1): quote responses **and** `/ops/bookings/:id` payment cost fields contain no cost/margin keys for finance **and** ops; only founder sees them; `/ops/finance/summary` returns 403 for finance/ops.
- Machine path: `x-admin-key` authorises the cron endpoints as `system` but is **rejected** (403) on `payments:act`/human routes.
- **Dev bypass safety:** the e2e signed-session helper refuses to run when `NODE_ENV === 'production'`.

## 8. Out of scope

- **Customer accounts** on the website — anonymous booking stays; a tokenized "manage your booking" email link is the future answer if needed, not login.
- User-management UI, audit-log table (log-line attribution is enough for now), Supabase Auth, refresh tokens/silent renewal.

## 9. Rollout & operational notes

- **Sequencing:** implement only after `m12s2-ops-dashboard` merges; this spec's changes then rebase cleanly onto the reshaped ops routes.
- **Google Cloud setup (one-time, ~10 min):** create an OAuth consent screen and a Web OAuth client ID; add the API origin, `ceylonhop.com`, and `http://localhost:<dev-port>` as authorised JavaScript origins. **User-type caveat:** the "Internal" consent-screen type is only available if the staff emails belong to a Google Workspace organisation. For personal `@gmail.com` accounts, use **"External"** and add the 3 emails as **test users** (an unverified external app in "testing" works indefinitely for a fixed test-user list and needs no Google verification review — fine at 3 users). The ID-token sign-in flow here uses only the public client ID (no client secret).
- **The 3 Google accounts become the security boundary.** All three must have 2-step verification enabled — whoever controls one of those inboxes gets that role.
