# Ops Permissions & Roles — Reconciliation Plan (post-quote-merge)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status context:** the auth *core* — `api/src/lib/opsAuth.ts`, `api/src/lib/googleAuth.ts`, `api/src/lib/opsMiddleware.ts` and their 40 passing unit tests — is already salvaged and green on this branch (`ops-permissions-roles`). `cd api && npm run check` is currently **RED**: `ops.ts` and `internalQuote.ts` still reference the deleted `roleForKey`/two-arg `verifySession`/`c.set('role', ...)` surface. This plan is the remaining work only: rewiring every caller (`config.ts`, `app.ts`, `ops.ts`, `internalQuote.ts`, `admin.ts`, `ops-ui.html`) onto the salvaged core, folding in Roshen's two 2026-07-04 decisions (D-A quote tool opens to all 3 roles with margin stripped; D-B dev bypass + placeholder `OPS_USERS`), and getting `npm run check` green again.

**Goal:** Google Sign-In (with a dev bypass) replaces the shared-key logins on `/admin/ops/*` and `/admin/quote/*`; one `opsIdentity`/`requireCap` middleware pair enforces the `founder/finance/ops/system` capability matrix everywhere; margin/cost is stripped server-side for everyone except `margin:view`; `x-admin-key` is downgraded to a narrow `system` identity that only satisfies `admin:jobs`.

**Architecture (unchanged from spec, restated for this plan's scope):** `opsAuth.ts` (pure: roles, `can()`, allowlist parsing, identity-cookie sign/verify) ← `googleAuth.ts` (Google ID-token verification, injectable verifier) ← `opsMiddleware.ts` (`opsIdentity` resolves `{email, role}` per request from cookie+allowlist or `x-admin-key`→`system`; `requireCap(action)` guards; `issueSessionCookie`; `devBypassEnabled`). This plan's job is exclusively the **callers**: `config.ts`, `app.ts`, `ops.ts`, `internalQuote.ts`, `admin.ts`, `ops-ui.html`, and their tests.

## Global Constraints

- **Do not touch `opsAuth.ts`, `googleAuth.ts`, `opsMiddleware.ts` or their `.test.ts` files** — they are done and green. If a caller task seems to need a core change, stop and flag it; don't improvise on the core.
- **Real mount prefixes:** ops = `/admin/ops/*`, quote tool = `/admin/quote/*`, cancel/refund/jobs = `/admin/*`. Login is `POST /admin/ops/login`. The Control Tower UI shell is `GET /ops` (`api/src/routes/opsUi.ts` serving `ops-ui.html`) — a **different** mount than `/admin/ops/*` (the API). Both exist today; do not conflate them.
- **D-A (quote tool opens to all 3 roles):** every route currently gated `founder`-only in `internalQuote.ts` and the Quote nav button in `ops-ui.html` move to `quote:manage` (founder ✅, finance ✅, ops ✅ per the existing `CAPABILITIES` map — no core change needed, this is purely a caller-side gate change). Cost/margin fields are stripped from quote responses unless the resolved role has `margin:view` (founder only).
- **D-B (dev bypass + placeholder config):** build against `NODE_ENV !== 'production'` dev bypass and placeholder `OPS_USERS`/`GOOGLE_OAUTH_CLIENT_ID` values in tests/dev. Real Google Cloud client ID + real 3-person `OPS_USERS` string are supplied at deploy time (Task T-F documents the steps; do not fetch/create real Google credentials in this plan).
- **`x-admin-key` behavior CHANGES from today:** today it authorizes `/admin/quote/*` as founder (see `internalQuote.ts` lines 246-254) and `/admin/*` cancel/refund/jobs unconditionally. After this work it resolves to `system`, which per the capability matrix satisfies **only** `admin:jobs`. It must be **rejected (403)** on quote routes and on `payments:act` routes (`cancel`/`refund`). This is an intentional behavior break from the pre-reconciliation state — call it out in the PR description, since any external cron/script currently using the admin key against quote or cancel/refund will break (expected: nothing does today except manual testing).
- **`ops-ui.html` is a single 3596-line file with embedded `<script>` — edits there are text edits, not component edits.** Grep before editing; do not assume line numbers are stable across tasks.
- **Fail closed in production:** missing `OPS_USERS`/`GOOGLE_OAUTH_CLIENT_ID` must deny human login when `NODE_ENV === 'production'`; the existing `OPS_SESSION_SECRET` prod guard in `config.ts` (`buildConfig`) stays as-is (it already throws if unset/default in production) and needs no change — just confirm it isn't broken by the `OPS_USERS`/key-removal edit in the same block.
- **Role is never in the cookie.** Re-affirming the already-built invariant: nothing in this reconciliation should start caching role in the cookie for convenience.
- TDD, one behavior per test, frequent commits. `npm test` / `npm run check` run from `api/`.

---

## Task T-A: Config + app wiring

Swap the env surface (`OPS_SUPPORT_KEY`/`OPS_FOUNDER_KEY` → `OPS_USERS`/`GOOGLE_OAUTH_CLIENT_ID`) and wire `opsIdentity` onto `/admin/ops/*` and `/admin/quote/*` in `app.ts`. This task alone will NOT make typecheck green (it doesn't touch `ops.ts`/`internalQuote.ts` bodies) — that's expected; T-B/T-D land in the same PR-worthy sequence before the full suite is green again. Keep commits granular but know `npm run check` stays red until T-D lands.

**Files:**
- Modify: `api/src/config.ts` (lines 33-38, the ops-auth env block)
- Modify: `api/src/app.ts` (`AppDeps.auth` type, line 40; `opsAuthCfg`, lines 70-75; the three `app.route(...)` calls at lines 158/163-173)
- Test: `api/src/config.opsusers.test.ts` (new, mirrors the old plan's Task 3 Step 5)

**Interfaces produced:**
- `config.OPS_USERS: string` (default `''`), `config.GOOGLE_OAUTH_CLIENT_ID: string` (default `''`)
- `AppDeps.auth?: { opsUsers: string; googleClientId: string; opsSessionSecret: string }`
- `opsAuthCfg: OpsAuthConfig` (the exact interface from `opsMiddleware.ts`: `{ opsUsers, googleClientId, sessionSecret, adminApiKey, nodeEnv }`)

**Interfaces consumed:** `OpsAuthConfig` type from `../lib/opsMiddleware` (already exists).

- [ ] **Step 1: Edit `config.ts`** — replace lines 33-38:

```ts
  // Ops/quote auth (Google sign-in + capability roles). See docs/go-live-checklist.md.
  // OPS_USERS = "email:role,email:role" over roles founder|finance|ops (exactly the 3 staff).
  OPS_USERS: z.string().default(''),
  GOOGLE_OAUTH_CLIENT_ID: z.string().default(''),
  OPS_SESSION_SECRET: z.string().default('dev-ops-secret-change-me'),
  // Quote engine internal key — passed to quoteRoutes to gate marginEstimateCents.
  INTERNAL_QUOTE_KEY: z.string().default(''),
```

This deletes `OPS_SUPPORT_KEY`, `OPS_FOUNDER_KEY`. Leave `ADMIN_API_KEY` (line 11) and the `buildConfig` prod guard (lines 48-63) untouched — re-read them after the edit to confirm the guard still references `OPS_SESSION_SECRET` correctly (it does not touch the two deleted keys).

- [ ] **Step 2: Add the config-parse test** — create `api/src/config.opsusers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseOpsUsers, roleForEmail } from './lib/opsAuth';

describe('OPS_USERS wiring', () => {
  it('a realistic 3-person string resolves all three roles', () => {
    const u = parseOpsUsers('a@ceylonhop.com:founder,b@ceylonhop.com:finance,c@ceylonhop.com:ops');
    expect(roleForEmail('a@ceylonhop.com', u)).toBe('founder');
    expect(roleForEmail('b@ceylonhop.com', u)).toBe('finance');
    expect(roleForEmail('c@ceylonhop.com', u)).toBe('ops');
  });
});
```

Run: `cd api && npx vitest run src/config.opsusers.test.ts`
Expected: PASS immediately (this exercises already-green `opsAuth.ts`; it is a wiring-intent test, not a red/green step, since the core is done — still worth having as a regression guard on the env-var contract).

- [ ] **Step 3: Edit `app.ts` — `AppDeps.auth` type** (line 40):

```ts
  auth?: { opsUsers: string; googleClientId: string; opsSessionSecret: string };
```

- [ ] **Step 4: Edit `app.ts` — `opsAuthCfg`** (lines 70-75), replacing the `supportKey`/`founderKey` shape:

```ts
  const opsAuthCfg = {
    opsUsers: deps.auth?.opsUsers ?? config.OPS_USERS,
    googleClientId: deps.auth?.googleClientId ?? config.GOOGLE_OAUTH_CLIENT_ID,
    sessionSecret: deps.auth?.opsSessionSecret ?? config.OPS_SESSION_SECRET,
    adminApiKey,
    nodeEnv: config.NODE_ENV,
  };
```

Note the field is `sessionSecret` (not `opsSessionSecret`) to match `OpsAuthConfig` in `opsMiddleware.ts` — confirm against that file's actual interface before committing (it is `{ opsUsers; googleClientId; sessionSecret; adminApiKey; nodeEnv }`).

- [ ] **Step 5: Do NOT change the `app.route(...)` calls yet for `ops`/`internalQuote`** — those routers' own `deps.auth` param shape is rewritten in T-B/T-D. Changing `app.ts`'s route-wiring lines now would just move the typecheck error from "wrong opsAuthCfg shape" to "router doesn't accept this shape" — no net progress and it muddies the diff. Leave lines 158 and 167-173 as they are for this task; T-B/T-D touch them.

  Exception: nothing in `admin.ts`'s wiring changes shape in this task either (T-E does that) — leave line 174-186 alone too.

- [ ] **Step 6: Typecheck (expect the SAME pre-existing errors, not new ones)**

Run: `cd api && npm run typecheck 2>&1 | head -30`
Expected: the errors are exactly the ones that exist today in `ops.ts`/`internalQuote.ts` (see Global Constraints preamble) — no *new* errors introduced by this task's edits to `config.ts`/`app.ts` beyond what those two router files already had. If `app.ts` itself now shows a new error (e.g. `opsAuthCfg` shape mismatch against the still-old `opsRoutes`/`internalQuoteRoutes` signatures), that is expected and will disappear once T-B/T-D land — confirm by reading the error text: it must name `opsRoutes`/`internalQuoteRoutes`, not something unrelated.

- [ ] **Step 7: Commit**

```bash
git add api/src/config.ts api/src/app.ts api/src/config.opsusers.test.ts
git commit -m "feat(auth): config + app wiring for OPS_USERS + Google client id"
```

---

## Task T-B: `ops.ts` — Google login, identity cookie, capability gates, `whoami`

Rewrite the ops router's auth surface end to end: login accepts a Google ID token (not `{key}`), the `r.use('*')` block is replaced by the shared `opsIdentity` middleware, every handler gets an explicit `requireCap(...)`, and `whoami` returns `{email, role, caps}`.

**Files:**
- Modify: `api/src/routes/ops.ts` (full rewrite of the auth portion, lines 1-56; gate additions on lines 57-107)
- Modify: `api/src/app.ts` (line 158 — `app.route('/admin/ops', ...)`)
- Test (all five rewrite off `{opsSupportKey,opsFounderKey}` + `/login {key}` onto `{opsUsers,googleClientId,opsSessionSecret}` + minted cookies): `api/src/routes/ops.test.ts`, `api/src/routes/ops.auth.test.ts`, `api/src/routes/ops.roles.test.ts`, `api/src/routes/ops.bookings.test.ts`, `api/src/routes/ops.search.test.ts`, `api/src/routes/ops.watchdog.test.ts` (grep this one too — it wasn't in the original file list but showed up in this repo; check its `auth:` shape and update if it uses the old fields).

**Interfaces produced:**
- `OpsDeps` becomes `{ bookings; payments; rideOps; auth: OpsAuthConfig; googleVerifier?: JwtVerifier }`
- `GET /admin/ops/whoami` → `{ email: string; role: OpsRole; caps: OpsAction[] }` (caps = every action `can(role, action)` is true for — the UI needs this to decide what to show without hardcoding the matrix client-side)
- `POST /admin/ops/login` accepts `{ credential: string }` (Google ID token), returns `{ email, role }` on success
- `POST /admin/ops/dev-login` accepts `{ email: string }`, mints a cookie for that allowlisted email, refuses (404) when `!devBypassEnabled(auth)`

**Interfaces consumed:** `opsIdentity`, `requireCap`, `issueSessionCookie`, `devBypassEnabled`, `OPS_COOKIE`, `OpsAuthConfig` (all from `../lib/opsMiddleware`); `verifyGoogleIdToken`, `JwtVerifier` (from `../lib/googleAuth`); `can`, `parseOpsUsers`, `roleForEmail`, `CAPABILITIES`-derived action list (from `../lib/opsAuth` — if there's no exported "all actions" list, derive `caps` in `ops.ts` itself by checking each of the six known `OpsAction` literals against `can(role, action)`; do NOT export a new symbol from `opsAuth.ts` for this — that file is frozen per Global Constraints).

- [ ] **Step 1: Write failing tests.** Replace `api/src/routes/ops.auth.test.ts` in full:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../app';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryRideOpsRepo } from '../db/rideOpsRepo';
import { issueSessionCookie } from '../lib/opsMiddleware';
import { Hono } from 'hono';

const auth = { opsUsers: 'op@x.com:ops', googleClientId: 'cid', opsSessionSecret: 'sek' };

// Mint a session cookie for an email without invoking Google (mirrors opsMiddleware.test.ts's pattern).
function cookie(email: string, secret = 'sek') {
  const c = new Hono();
  c.get('/', (ctx) => { issueSessionCookie(ctx, email, secret, Date.now()); return ctx.text('ok'); });
  return c.request('/').then((r) => r.headers.get('set-cookie')!.split(';')[0]);
}
function makeApp() {
  const bookings = new InMemoryBookingRepo();
  const app = createApp({ bookings, rideOps: new InMemoryRideOpsRepo(), auth, adminApiKey: 'adminkey' });
  return app;
}

describe('ops authorization surface', () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => { app = makeApp(); });

  it('rejects reads without auth (401)', async () => {
    expect((await app.request('/admin/ops/bookings')).status).toBe(401);
    expect((await app.request('/admin/ops/whoami')).status).toBe(401);
  });
  it('rejects a forged cookie', async () => {
    const res = await app.request('/admin/ops/bookings', { headers: { cookie: 'ch_ops=deadbeef.deadbeef' } });
    expect(res.status).toBe(401);
  });
  it('rejects a cookie signed with the wrong secret', async () => {
    const res = await app.request('/admin/ops/bookings', { headers: { cookie: await cookie('op@x.com', 'other-secret') } });
    expect(res.status).toBe(401);
  });
  it('accepts a valid ops session (200)', async () => {
    const res = await app.request('/admin/ops/bookings', { headers: { cookie: await cookie('op@x.com') } });
    expect(res.status).toBe(200);
  });
  it('x-admin-key satisfies admin:jobs elsewhere but is NOT a founder backdoor here', async () => {
    // system only has admin:jobs; /admin/ops/bookings needs bookings:read, which system lacks.
    const res = await app.request('/admin/ops/bookings', { headers: { 'x-admin-key': 'adminkey' } });
    expect(res.status).toBe(403);
  });
});
```

Replace `api/src/routes/ops.roles.test.ts` in full:

```ts
import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { issueSessionCookie } from '../lib/opsMiddleware';
import { Hono } from 'hono';

const auth = { opsUsers: 'f@x.com:founder,fin@x.com:finance,op@x.com:ops', googleClientId: 'cid', opsSessionSecret: 'sek' };
function cookie(email: string) {
  const c = new Hono();
  c.get('/', (ctx) => { issueSessionCookie(ctx, email, 'sek', Date.now()); return ctx.text('ok'); });
  return c.request('/').then((r) => r.headers.get('set-cookie')!.split(';')[0]);
}

describe('ops capability gates', () => {
  it('finance/summary is margin:view-gated — 403 for finance and ops, 200 for founder', async () => {
    const app = createApp({ auth, adminApiKey: 'adminkey' });
    expect((await app.request('/admin/ops/finance/summary', { headers: { cookie: await cookie('op@x.com') } })).status).toBe(403);
    expect((await app.request('/admin/ops/finance/summary', { headers: { cookie: await cookie('fin@x.com') } })).status).toBe(403);
    expect((await app.request('/admin/ops/finance/summary', { headers: { cookie: await cookie('f@x.com') } })).status).toBe(200);
  });

  it('bookings:operate mutators reject finance (403) but allow ops and founder', async () => {
    const app = createApp({ auth, adminApiKey: 'adminkey' });
    const res = await app.request('/admin/ops/bookings/does-not-exist/status', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: await cookie('fin@x.com') },
      body: JSON.stringify({ to: 'vehicle_confirmed' }),
    });
    expect(res.status).toBe(403);
  });

  it('whoami returns {email, role, caps} — caps reflects the resolved role, not the cookie', async () => {
    const app = createApp({ auth, adminApiKey: 'adminkey' });
    const res = await app.request('/admin/ops/whoami', { headers: { cookie: await cookie('op@x.com') } });
    const body = await res.json();
    expect(body.email).toBe('op@x.com');
    expect(body.role).toBe('ops');
    expect(body.caps).toEqual(expect.arrayContaining(['quote:manage', 'bookings:operate', 'bookings:read']));
    expect(body.caps).not.toContain('margin:view');
    expect(body.caps).not.toContain('payments:act');
  });
});
```

Also delete/replace `api/src/routes/ops.test.ts` — its two tests (`role:'support'`, key-login, `x-admin-key`→founder) are obsolete under the new model. Replace its body with a Google-login-route test using an injected verifier (the `googleVerifier` test seam):

```ts
import { describe, it, expect } from 'vitest';
import { createApp } from '../app';

const auth = { opsUsers: 'f@x.com:founder', googleClientId: 'cid', opsSessionSecret: 'sek' };

describe('ops Google login route', () => {
  it('verifies the ID token, allowlist-checks, and sets the session cookie', async () => {
    const googleVerifier = async () => ({ payload: {
      iss: 'https://accounts.google.com', aud: 'cid', email: 'f@x.com', email_verified: true,
    } });
    const app = createApp({ auth, adminApiKey: 'k', googleVerifier });
    const res = await app.request('/admin/ops/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: 'tok' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: 'f@x.com', role: 'founder' });
    expect(res.headers.get('set-cookie')).toContain('ch_ops=');
  });

  it('403s a verified email that is not in OPS_USERS', async () => {
    const googleVerifier = async () => ({ payload: {
      iss: 'https://accounts.google.com', aud: 'cid', email: 'stranger@x.com', email_verified: true,
    } });
    const app = createApp({ auth, adminApiKey: 'k', googleVerifier });
    const res = await app.request('/admin/ops/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: 'tok' }),
    });
    expect(res.status).toBe(403);
  });

  it('401s an invalid token', async () => {
    const googleVerifier = async () => { throw new Error('bad signature'); };
    const app = createApp({ auth, adminApiKey: 'k', googleVerifier });
    const res = await app.request('/admin/ops/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: 'tok' }),
    });
    expect(res.status).toBe(401);
  });
});
```

> **Note:** `createApp`'s `AppDeps` doesn't currently have a `googleVerifier` passthrough — Step 3 below adds it (threaded to `opsRoutes` only, per the spec's login flow being solely on `/admin/ops/login`).

Also grep `api/src/routes/ops.bookings.test.ts`, `ops.search.test.ts`, `ops.watchdog.test.ts` for `opsSupportKey`/`opsFounderKey` and replace with the same `{opsUsers, googleClientId, opsSessionSecret}` shape + `cookie()` helper pattern shown above (mechanical find-replace of the `auth` fixture + swapping any raw `x-admin-key`-as-founder assumption for a minted cookie of the right role).

- [ ] **Step 2: Run to verify fail**

Run: `cd api && npx vitest run src/routes/ops.test.ts src/routes/ops.auth.test.ts src/routes/ops.roles.test.ts src/routes/ops.bookings.test.ts src/routes/ops.search.test.ts src/routes/ops.watchdog.test.ts`
Expected: FAIL — `ops.ts` still imports `roleForKey`, old `auth` shape, no `/login {credential}` support, no `caps` in whoami.

- [ ] **Step 3: Rewrite `ops.ts`.** Replace the whole file:

```ts
import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { BookingRepo } from '../db/bookingRepo';
import type { PaymentRepo } from '../db/paymentRepo';
import type { RideOpsRepo } from '../db/rideOpsRepo';
import { can, parseOpsUsers, roleForEmail, type OpsAction } from '../lib/opsAuth';
import {
  opsIdentity, requireCap, issueSessionCookie, devBypassEnabled, OPS_COOKIE,
  type OpsAuthConfig,
} from '../lib/opsMiddleware';
import { verifyGoogleIdToken, type JwtVerifier } from '../lib/googleAuth';
import { toOpsRow, type OpsBookingRow } from '../services/opsView';

export interface OpsDeps {
  bookings: BookingRepo;
  payments: PaymentRepo;
  rideOps: RideOpsRepo;
  auth: OpsAuthConfig;
  googleVerifier?: JwtVerifier; // test seam — bypasses real Google JWKS
}

// Every action the capability matrix knows about — used only to compute whoami's `caps`
// list from the resolved role, never to grant anything (can() remains the sole gate).
const ALL_ACTIONS: OpsAction[] = [
  'quote:manage', 'margin:view', 'bookings:operate', 'bookings:read', 'payments:act', 'admin:jobs',
];

const QUEUE_STATUSES = ['payment_pending', 'paid'] as const;

export function opsRoutes(deps: OpsDeps) {
  const r = new Hono();
  const { auth } = deps;
  const users = parseOpsUsers(auth.opsUsers);

  // Google sign-in: the browser POSTs the Google ID token; we verify, allowlist-check, set cookie.
  r.post('/login', async (c) => {
    const body = z.object({ credential: z.string() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    if (!auth.googleClientId || !auth.opsUsers) return c.json({ error: 'login_unavailable' }, 503); // fail closed
    let id;
    try {
      id = await verifyGoogleIdToken(body.data.credential, { clientId: auth.googleClientId, verifier: deps.googleVerifier });
    } catch {
      return c.json({ error: 'invalid_token' }, 401);
    }
    if (!id.emailVerified) return c.json({ error: 'email_unverified' }, 403);
    const role = roleForEmail(id.email, users);
    if (!role) return c.json({ error: 'not_authorised', email: id.email }, 403);
    issueSessionCookie(c, id.email, auth.sessionSecret, Date.now());
    return c.json({ email: id.email, role }, 200);
  });

  // Dev-only bypass: mint a session for a chosen allowlisted email without Google.
  // Refuses (404, no cookie) when NODE_ENV === 'production' — asserted in Task T-F.
  r.post('/dev-login', async (c) => {
    if (!devBypassEnabled(auth)) return c.json({ error: 'not_found' }, 404);
    const body = z.object({ email: z.string() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    if (!roleForEmail(body.data.email, users)) return c.json({ error: 'not_authorised' }, 403);
    issueSessionCookie(c, body.data.email, auth.sessionSecret, Date.now());
    return c.json({ ok: true }, 200);
  });

  r.post('/logout', (c) => {
    setCookie(c, OPS_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
    return c.json({ ok: true });
  });

  // Identity + guards for everything below.
  r.use('*', opsIdentity(auth));

  r.get('/whoami', requireCap('bookings:read'), (c) => {
    const identity = c.get('identity');
    const caps = ALL_ACTIONS.filter((a) => can(identity.role, a));
    return c.json({ email: identity.email, role: identity.role, caps });
  });

  r.get('/finance/summary', requireCap('margin:view'), (c) => c.json({ ok: true }));

  r.get('/bookings', requireCap('bookings:read'), async (c) => {
    const stage = c.req.query('stage'); const date = c.req.query('date');
    const q = (c.req.query('q') ?? '').toLowerCase();
    const all = await deps.bookings.list({ status: [...QUEUE_STATUSES] });
    const ops = await deps.rideOps.listByBookingIds(all.map((b) => b.id));
    const opsById = new Map(ops.map((o) => [o.bookingId, o]));
    const rows: OpsBookingRow[] = [];
    for (const b of all) {
      const paid = (await deps.payments.findByBookingId(b.id)).some((p) => p.status === 'succeeded');
      const row = toOpsRow(b, { rideOps: opsById.get(b.id) ?? null, paid });
      if (stage && row.stage !== stage) continue;
      if (date && row.travelDate !== date) continue;
      if (q && !`${row.reference} ${row.customerName} ${b.input.customer.email}`.toLowerCase().includes(q)) continue;
      rows.push(row);
    }
    rows.sort((a, b) => {
      if (a.travelDate === b.travelDate) return 0;
      if (a.travelDate === null) return 1;
      if (b.travelDate === null) return -1;
      return a.travelDate < b.travelDate ? -1 : 1;
    });
    return c.json(rows);
  });

  // Spec §3.1 [CORRECTED]: the payments row carries no cost/margin field (confirmed against
  // db/paymentRepo.ts's Payment interface — amount/status/provider/orderId only). There is
  // nothing to strip here. If cost tracking is ever added to this response, gate it behind
  // can(identity.role, 'margin:view') and add a test on both sides before shipping it.
  r.get('/bookings/:id', requireCap('bookings:read'), async (c) => {
    const b = await deps.bookings.get(c.req.param('id'));
    if (!b) return c.json({ error: 'not_found' }, 404);
    const ops = await deps.rideOps.getOrCreate(b.id);
    const payments = await deps.payments.findByBookingId(b.id);
    return c.json({ booking: b, ops, payments });
  });

  r.post('/bookings/:id/status', requireCap('bookings:operate'), async (c) => {
    const body = z.object({ to: z.string() }).parse(await c.req.json());
    try {
      return c.json(await deps.rideOps.setStatus(c.req.param('id'), body.to as never));
    } catch {
      return c.json({ error: 'illegal_transition' }, 400);
    }
  });

  r.post('/bookings/:id/flags', requireCap('bookings:operate'), async (c) => {
    const body = z.object({
      vehiclePhotoReceived: z.boolean().optional(),
      customerUpdated: z.boolean().optional(),
      opsNotes: z.string().nullable().optional(),
    }).parse(await c.req.json());
    return c.json(await deps.rideOps.setFlags(c.req.param('id'), body));
  });

  return r;
}
```

Confirm `toOpsRow`/`OpsBookingRow` import path against `services/opsView.ts` (re-grep — the old plan referenced `manifestLine` too, which no longer exists post-m12s2; do not import it).

- [ ] **Step 4: Wire `createApp` to accept `googleVerifier` and pass it through.** In `app.ts`, add to `AppDeps`:

```ts
  googleVerifier?: JwtVerifier; // test seam, threaded to opsRoutes only
```//

and to the `app.route('/admin/ops', ...)` call (line 158):

```ts
  app.route('/admin/ops', opsRoutes({ bookings, payments, rideOps, auth: opsAuthCfg, googleVerifier: deps.googleVerifier }));
```

Import `JwtVerifier` from `./lib/googleAuth` in `app.ts`.

- [ ] **Step 5: Run to verify pass**

Run: `cd api && npx vitest run src/routes/ops.test.ts src/routes/ops.auth.test.ts src/routes/ops.roles.test.ts src/routes/ops.bookings.test.ts src/routes/ops.search.test.ts src/routes/ops.watchdog.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add api/src/routes/ops.ts api/src/routes/ops.test.ts api/src/routes/ops.auth.test.ts api/src/routes/ops.roles.test.ts api/src/routes/ops.bookings.test.ts api/src/routes/ops.search.test.ts api/src/routes/ops.watchdog.test.ts api/src/app.ts
git commit -m "feat(auth): ops routes on Google login + capability gates + whoami{email,role,caps}"
```

---

## Task T-C: `ops-ui.html` — Google Sign-In button, dev-bypass affordance, `quote:manage` nav gate, `{role,caps}` consumption

Browser-side changes to the login overlay and the role-gating logic. This task is **UI-only** — no new server routes (T-B already added `/login` accepting `{credential}}` and `/dev-login`). Controller (you) browser-verifies with the preview tools after editing; there is no Vitest for HTML string content beyond `opsUi.test.ts`'s existing string assertions, which this task updates.

**Files:**
- Modify: `api/src/routes/ops-ui.html` — login overlay markup (`~812-824`), `setNav()` (`~946-949`), `showQuoteView()`/`render()`/click-handler role checks (`~1098,1117,1144`), `bootApp()` (`~1171-1185`), login form submit handler (`~1187-1198`), boot IIFE (`~1203-1212`)
- Modify: `api/src/routes/opsUi.test.ts` (string-literal assertions reference the old `state.role==='founder'` gate)

**Interfaces consumed:** `POST /admin/ops/login` now expects `{ credential }` (Google ID token) instead of `{ key }`; `POST /admin/ops/dev-login` expects `{ email }` (dev-only, 404 in prod); `GET /admin/ops/whoami` now returns `{ email, role, caps }` instead of `{ role }`.

- [ ] **Step 1: Update the failing/changing assertions in `opsUi.test.ts` first (TDD for the shell string content).**

Change:
```ts
    expect(body).toContain("state.role==='founder'"); // founder gate in the script
```
to:
```ts
    expect(body).toContain("state.caps.includes('quote:manage')"); // Quote nav gated on the capability, not a hardcoded role (D-A: all 3 roles get quote:manage)
```

Run: `cd api && npx vitest run src/routes/opsUi.test.ts`
Expected: FAIL (the string isn't in the HTML yet).

- [ ] **Step 2: Replace the login overlay markup** (`~817-821`). Remove the password input; add a Google Identity Services button mount + a dev-only fallback form (visible only when the server tells the client dev mode is on — simplest approach: always render the dev affordance element but only wire/show it after an unauthenticated boot **and** a cheap client-side signal; since the client can't read `NODE_ENV` directly, gate visibility by attempting the dev button and letting the server 404 do the work, OR simpler: have `whoami`'s 401 response body include a `devBypass: boolean` flag computed from `devBypassEnabled(auth)` so the UI knows whether to render the dev affordance. **This requires a small T-B follow-up**: extend the 401 body of an unauthenticated `/admin/ops/whoami` call — flag this ambiguity, see "Ambiguities" section below; for now, plan assumes the simplest fallback — always render the dev-login link, and let it 404 harmlessly in production (a stray "Dev sign-in" link doing nothing in prod is low-severity, but is flagged for a decision).

```html
    <form id="loginform" autocomplete="off">
      <div id="g_id_signin"></div>
      <div class="err" id="loginerr"></div>
    </form>
    <div class="foot" id="devlogin-foot">
      <button type="button" id="devloginbtn" style="display:none">Dev sign-in (local only)</button>
    </div>
    <div class="foot">Restricted operational console</div>
```

Add the Google script tag before `</body>` (or in `<head>`) with `data-client_id` templated server-side — this means `opsUiRoutes`/`internalQuoteRoutes`'s HTML-serving handler needs to inject `GOOGLE_OAUTH_CLIENT_ID` into the served HTML rather than serving a static cached string. **This is a bigger change than a pure client edit** — flag: today `opsUi.ts`'s `uiHtml()` caches the file content as a static string (`cachedHtml`) read once. Injecting a per-request/per-config client ID means either (a) templating at cache-time using `config.GOOGLE_OAUTH_CLIENT_ID` (fine — the client ID is not a secret and doesn't vary per request), or (b) fetching it client-side from a small unauthenticated `GET /admin/ops/config` endpoint. Recommend (a): pass `googleClientId` into `opsUiRoutes(googleClientId)` and do a single string replace (`{{GOOGLE_CLIENT_ID}}` placeholder in the HTML) at cache-build time. Wire `app.ts`'s `app.route('/ops', opsUiRoutes(opsAuthCfg.googleClientId))` accordingly. This is a small addition to `opsUi.ts` (not in the "frozen core" — it's a caller) — include it in this task's diff.

```html
<script src="https://accounts.google.com/gsi/client" async defer></script>
```

and initialize in the boot script (Step 4).

- [ ] **Step 3: Update `setNav()`** (`~946-949`) — swap the role check for a caps check:

```js
    (state.caps && state.caps.includes('quote:manage')?`<button data-route="quote" class="${state.route==='quote'?'active':''}">${NAV_ICONS.quote} Quote</button>`:'');
```

- [ ] **Step 4: Update every other `role==='founder'`/`role!=='founder'` gate that governed quote access** (`showQuoteView()` line 1098, `render()` line 1117, the nav click handler line 1144). Replace each with the equivalent `state.caps.includes('quote:manage')` check. Do **not** touch anything checking a *different* capability (there is none today besides the quote gate — finance/bookings-operate UI gating is out of scope for this reconciliation since the Bookings view is universally visible already).

- [ ] **Step 5: Update `bootApp(role)` → `bootApp(identity)`** (`~1171-1185`) to accept `{email, role, caps}` and store all three:

```js
function bootApp(identity){
  hideLogin();
  state.role=identity.role; state.caps=identity.caps; state.email=identity.email;
  window.opsShowLogin=showLogin;
  window.opsGoBookings=()=>{state.route='tickets';render();};
  if(location.hash==='#quote'&&state.caps.includes('quote:manage'))state.route='quote';
  else{state.route='tickets';if(location.hash)history.replaceState(null,'',location.pathname+location.search);}
  const initials=identity.role.slice(0,2).toUpperCase();
  const roleLabel=identity.role.charAt(0).toUpperCase()+identity.role.slice(1);
  $('#railfoot').innerHTML=`<div class="avatar">${initials}</div><div><b>Signed in</b><span>${esc(identity.email)} · ${roleLabel}</span></div><button class="logout" id="logoutbtn">Logout</button>`;
  setNav();
  if(state.route==='quote')render();
  loadQueue().catch(e=>{if(e.message!=='auth')toast('Could not load bookings');});
}
```

(`esc` already exists in the file for HTML-escaping — reuse it, don't inline the email unescaped.)

- [ ] **Step 6: Replace the login form submit handler** (`~1187-1198`) — remove the key POST; add the Google callback + dev-bypass button handler:

```js
function onGoogleCredential(resp){
  const errEl=$('#loginerr');errEl.textContent='';
  fetch('/admin/ops/login',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({credential:resp.credential})})
    .then(async r=>{
      if(r.ok){const identity=await r.json();bootApp(identity);}
      else{const card=$('#login-card');card.classList.remove('shake');void card.offsetWidth;card.classList.add('shake');errEl.textContent='This Google account isn\'t authorised';}
    }).catch(()=>{errEl.textContent='Network error — try again';});
}
$('#devloginbtn') && $('#devloginbtn').addEventListener('click',async()=>{
  const email=prompt('Dev sign-in — allowlisted email:');
  if(!email)return;
  const r=await fetch('/admin/ops/dev-login',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({email})});
  if(r.ok){const who=await fetch('/admin/ops/whoami',{credentials:'same-origin'});bootApp(await who.json());}
  else{$('#loginerr').textContent='Not authorised for dev sign-in';}
});
```

Initialize GIS in the boot IIFE (Step 7) with `window.onGoogleCredential = onGoogleCredential` referenced from `data-callback`.

- [ ] **Step 7: Update the boot IIFE** (`~1203-1212`) to consume the new `whoami` shape and render the Google button:

```js
(async function(){
  localStorage.removeItem('chAdminKey');
  if(window.google && google.accounts && google.accounts.id){
    google.accounts.id.initialize({client_id:'{{GOOGLE_CLIENT_ID}}',callback:onGoogleCredential});
    google.accounts.id.renderButton($('#g_id_signin'),{theme:'filled_black',size:'large',shape:'pill'});
  }
  try{
    const r=await fetch('/admin/ops/whoami',{credentials:'same-origin'});
    if(r.ok){bootApp(await r.json());}
    else{
      showLogin();
      if($('#devloginbtn') && r.status===401){ /* show the dev affordance only after a real 401; still visible in prod today per the flagged ambiguity — see plan notes */ $('#devloginbtn').style.display='inline-block'; }
    }
  }catch(_){showLogin();}
})();
```

- [ ] **Step 8: Update `opsUi.ts`** to inject the client ID:

```ts
export function opsUiRoutes(googleClientId: string): Hono {
  const app = new Hono();
  app.get('/', (c) => {
    const html = uiHtml(googleClientId);
    if (html == null) return c.html('<h1>ops dashboard unavailable</h1>', 500);
    return c.html(html);
  });
  return app;
}
```

and change `uiHtml()`'s cache key to include the client ID (or simplest: do the string replace on every call — the file read is already cached, only the placeholder substitution is per-call, which is cheap):

```ts
function uiHtml(googleClientId: string): string | null {
  const raw = rawHtml();
  return raw == null ? null : raw.replace('{{GOOGLE_CLIENT_ID}}', googleClientId);
}
let cachedRaw: string | null = null;
function rawHtml(): string | null {
  if (cachedRaw) return cachedRaw;
  try {
    cachedRaw = readFileSync(fileURLToPath(new URL('./ops-ui.html', import.meta.url)), 'utf8');
    return cachedRaw;
  } catch (e) {
    console.error('opsUi: failed to read ops-ui.html', e);
    return null;
  }
}
```

Update `app.ts`'s `app.route('/ops', opsUiRoutes())` call to `app.route('/ops', opsUiRoutes(opsAuthCfg.googleClientId))`.

- [ ] **Step 9: Run the shell test + typecheck**

Run: `cd api && npx vitest run src/routes/opsUi.test.ts && npm run typecheck`
Expected: `opsUi.test.ts` PASS. Typecheck may still show `internalQuote.ts`/`admin.ts` errors (unaffected by this task) — confirm no *new* errors from `opsUi.ts`/`app.ts` changes.

- [ ] **Step 10: Browser-verify manually** (no Vitest coverage for interactive GIS flow — mocking Google's script is out of scope for unit tests; this is exactly why the dev bypass exists). Start the dev server, hit `/ops`, confirm:
  - unauthenticated boot shows the login card with a Google button placeholder (won't fully render without a real client ID in dev — expected, since T-F supplies the real one at deploy)
  - the dev-bypass button (if visible) POSTs to `/admin/ops/dev-login` and, given `OPS_USERS` includes a test email, successfully boots the app
  - the Quote nav button appears for a `finance`/`ops` dev-login email now (previously founder-only) — this is the visible proof of D-A

Use `mcp__Claude_Preview__preview_start` / `preview_screenshot` / `preview_console_logs` for this verification pass; do not skip it even though there's no automated test for the GIS button itself.

- [ ] **Step 11: Commit**

```bash
git add api/src/routes/ops-ui.html api/src/routes/opsUi.ts api/src/routes/opsUi.test.ts api/src/app.ts
git commit -m "feat(auth): ops-ui Google Sign-In button + dev-bypass affordance + quote:manage nav gate"
```

---

## Task T-D: `internalQuote.ts` — replace the founder-cookie/admin-key guard with `opsIdentity` + `requireCap('quote:manage')`; margin-strip responses

This is the task that reverts #14's founder-only quote gating (D-A) and completes the typecheck fix started in T-A.

**Files:**
- Modify: `api/src/routes/internalQuote.ts` (deps interface `~203-210`, the guard block `~240-254`, `shape()` `~183-194`, the `/estimate` handler `~267-310`)
- Modify: `api/src/app.ts` (the `app.route('/admin/quote', ...)` call, `~167-173`)
- Test: `api/src/routes/internalQuote.test.ts` (extend — replace the founder-cookie-only assertions with quote:manage-for-all-three + margin-strip-for-non-founder)

**Interfaces produced:** `internalQuoteRoutes` deps become `{ maps: MapsAdapter; quotes: QuoteRepo; auth: OpsAuthConfig }` — drops `adminKey`, `allowNoKey`, `sessionSecret`, `allowedOrigins` is **kept** (CSRF stays; it's orthogonal to auth).

**Interfaces consumed:** `opsIdentity`, `requireCap`, `OpsAuthConfig` (from `../lib/opsMiddleware`); `can` (from `../lib/opsAuth`).

- [ ] **Step 1: Write failing tests.** Add to `api/src/routes/internalQuote.test.ts` (keep existing CSRF/pricing tests; add these):

```ts
import { issueSessionCookie } from '../lib/opsMiddleware';
import { Hono } from 'hono';

function cookie(email: string, secret = 'sek') {
  const c = new Hono();
  c.get('/', (ctx) => { issueSessionCookie(ctx, email, secret, Date.now()); return ctx.text('ok'); });
  return c.request('/').then((r) => r.headers.get('set-cookie')!.split(';')[0]);
}
const auth = { opsUsers: 'f@x.com:founder,fin@x.com:finance,op@x.com:ops', googleClientId: 'cid', opsSessionSecret: 'sek' };

describe('quote tool authorization (D-A: all 3 roles get quote:manage)', () => {
  it('rejects the data routes without a session (401)', async () => {
    const app = createApp({ auth, adminApiKey: 'k' });
    expect((await app.request('/admin/quote/list')).status).toBe(401);
  });

  it('x-admin-key is REJECTED on quote routes (system lacks quote:manage) — behavior change from pre-reconciliation', async () => {
    const app = createApp({ auth, adminApiKey: 'k' });
    const res = await app.request('/admin/quote/list', { headers: { 'x-admin-key': 'k' } });
    expect(res.status).toBe(403);
  });

  it('founder, finance, and ops sessions all reach /rate-card (quote:manage, not founder-only)', async () => {
    const app = createApp({ auth, adminApiKey: 'k' });
    for (const email of ['f@x.com', 'fin@x.com', 'op@x.com']) {
      const res = await app.request('/admin/quote/rate-card', { headers: { cookie: await cookie(email) } });
      expect(res.status).toBe(200);
    }
  });

  it('omits margin for finance and ops sessions, includes it for founder', async () => {
    const app = createApp({ auth, adminApiKey: 'k' });
    const body = { vehicle: 'car', passengerCount: 2, luggageCount: 1, legs: [{ from: 'A', to: 'B', distanceKm: 100 }] };
    for (const email of ['fin@x.com', 'op@x.com']) {
      const res = await app.request('/admin/quote/estimate', {
        method: 'POST', headers: { 'content-type': 'application/json', cookie: await cookie(email) }, body: JSON.stringify(body),
      });
      expect(await res.json()).not.toHaveProperty('margin');
    }
    const fRes = await app.request('/admin/quote/estimate', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: await cookie('f@x.com') }, body: JSON.stringify(body),
    });
    expect(await fRes.json()).toHaveProperty('margin');
  });
});
```

Also **delete/replace** any existing test asserting `role==='support'` → 403 on quote routes, or `x-admin-key` → founder access to quote — those assertions are now wrong under D-A/D6 and must be removed, not left red.

- [ ] **Step 2: Run to verify fail**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts`
Expected: FAIL (compile error today per the Global Constraints preamble — `verifySession` 2-arg call, `role==='founder'` string comparison against `SessionPayload`). This is the same red state already present; the test additions make the target behavior explicit.

- [ ] **Step 3: Replace the deps interface and guard block.** In `internalQuote.ts`, change the imports (drop `getCookie`, `verifySession`; add the middleware):

```ts
import { opsIdentity, requireCap, type OpsAuthConfig } from '../lib/opsMiddleware';
import { can } from '../lib/opsAuth';
```

Replace `export function internalQuoteRoutes(deps: {...})` signature:

```ts
export function internalQuoteRoutes(deps: {
  maps: MapsAdapter;
  quotes: QuoteRepo;
  auth: OpsAuthConfig;
  allowedOrigins?: string[];
}) {
```

Replace the guard block (current lines ~240-254, the `GL-1c + ops⇄quote merge T1` comment through the `r.use('*', async (c, next) => {...})` block) with:

```ts
  // D-A (2026-07-04): the quote tool opens to ALL THREE roles via quote:manage — reverts
  // the earlier founder-only gate. Cost/margin is stripped server-side per-response for
  // any role without margin:view (see shape() below), so finance/ops can quote customers
  // without ever seeing driver cost. system (x-admin-key) does NOT have quote:manage —
  // a leaked cron key cannot see customer PII or issue quotes (D6).
  r.use('*', opsIdentity(deps.auth));
  r.use('*', (c, next) => (c.req.path === '/admin/quote' ? next() : requireCap('quote:manage')(c, next)));
```

(The `GET /` → 302 `/ops` redirect stays exactly as-is above this block, unauthenticated, per current code — do not add auth to it.)

- [ ] **Step 4: Gate margin in `shape()`.** Change its signature and callers:

```ts
function shape(result: QuoteResult, canMargin: boolean) {
  const base = {
    product: result.product,
    total: money(result.totalCents),
    deposit: money(result.depositCents),
    amountDueNow: money(result.amountDueNowCents),
    warnings: result.warnings,
    lineItems: result.lineItems.map((li) => ({ label: li.label, amountCents: li.amountCents, usd: usd(li.amountCents), lkr: lkr(li.amountCents), meta: li.meta })),
  };
  if (!canMargin) return base;
  return { ...base, margin: result.marginEstimateCents == null ? null : money(result.marginEstimateCents) };
}
```

In the `/estimate` handler, compute `const canMargin = can(c.get('identity').role, 'margin:view');` and pass it to every `shape(result, ...)` call (there is exactly one call site building the main response — re-grep for other `shape(` call sites, e.g. inside a comparison path, and pass `canMargin` to each).

**`/save` is unaffected** — it persists `marginCents` server-side via `deps.quotes.save({...marginCents: result.marginEstimateCents...})` regardless of role; that's storage, not exposure over the wire, so leave it. But **`GET /:id`** (returns the full persisted quote, including `marginCents`, per line ~371-374 `r.get('/:id', ...)`) DOES expose margin over the wire and must also be gated:

```ts
  r.get('/:id', async (c) => {
    const q = await deps.quotes.get(c.req.param('id'));
    if (!q) return c.json({ error: 'not_found' }, 404);
    const canMargin = can(c.get('identity').role, 'margin:view');
    return c.json(canMargin ? q : stripQuoteMargin(q));
  });
```

Add a small helper near `shape()`:

```ts
// Strip persisted margin from a stored quote for non-margin:view roles (spec §3.1).
function stripQuoteMargin<T extends Record<string, unknown>>(q: T): T {
  const { marginCents: _drop, ...rest } = q as Record<string, unknown>;
  return rest as T;
}
```

Also update `GET /list` (`r.get('/list', ...)`): confirmed at planning time that `db/quoteRepo.ts`'s `QuoteSummary` (the return type of `list()`) DOES include `marginCents` (line 147's mapping, field declared line 35) — so `/list` leaks margin per-quote today and must be gated too:

```ts
  r.get('/list', async (c) => {
    const status = c.req.query('status') as QuoteStatus | undefined;
    if (status && !QUOTE_STATUSES.includes(status)) return c.json({ error: 'bad_status' }, 400);
    const quotesList = await deps.quotes.list({
      status, product: c.req.query('product') || undefined,
      from: c.req.query('from') || undefined, to: c.req.query('to') || undefined,
    });
    const canMargin = can(c.get('identity').role, 'margin:view');
    return c.json({ quotes: canMargin ? quotesList : quotesList.map(stripQuoteMargin) });
  });
```

(Reuses the `stripQuoteMargin` helper defined for `GET /:id` below — define it once, use in both places.)

- [ ] **Step 5: Update `app.ts`'s route wiring** (`~167-173`):

```ts
  app.route('/admin/quote', internalQuoteRoutes({ maps, quotes, auth: opsAuthCfg, allowedOrigins }));
```

(Drops `adminKey`, `allowNoKey`, `sessionSecret` — `allowedOrigins` for CSRF stays.)

- [ ] **Step 6: Run to verify pass**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts && npm run typecheck`
Expected: PASS + the `internalQuote.ts`/`internalQuote.test.ts` typecheck errors from the Global Constraints preamble are now GONE. (`ops.ts` errors are already gone from T-B; `admin.ts` may still show pre-existing lint-only issues, unaffected here — full green comes at T-F.)

- [ ] **Step 7: Commit**

```bash
git add api/src/routes/internalQuote.ts api/src/routes/internalQuote.test.ts api/src/app.ts
git commit -m "feat(auth): quote tool opens to all 3 roles via quote:manage; margin stripped unless margin:view"
```

---

## Task T-E: `admin.ts` — `payments:act` / `admin:jobs` split; `x-admin-key` → `system`

Today every route in `admin.ts` (`GET /bookings`, `POST /bookings/:id/cancel`, `POST /bookings/:id/refund`, `POST /jobs/notifications`, `POST /jobs/watchdog`) is gated by the single `authed(c)` helper comparing `x-admin-key` against the raw `ADMIN_API_KEY`. This task splits that into capability-appropriate gates and moves cancel/refund off the machine key entirely (system does not have `payments:act`).

**Files:**
- Modify: `api/src/routes/admin.ts` (remove `authed`/`Context` raw-key checks; add `opsIdentity` + `requireCap`)
- Modify: `api/src/app.ts` (the `app.route('/admin', ...)` call, `~174-186`)
- Test: `api/src/routes/admin.test.ts` (rewrite auth assertions)

**Interfaces produced:** `adminRoutes` deps gain `auth: OpsAuthConfig` (drops the standalone `adminApiKey` param — it now lives inside `auth.adminApiKey`, consistent with `ops.ts`/`internalQuote.ts`).

**Interfaces consumed:** `opsIdentity`, `requireCap` (from `../lib/opsMiddleware`).

- [ ] **Step 1: Write failing tests.** In `api/src/routes/admin.test.ts`, replace the raw-key assertions with capability-based ones:

```ts
import { issueSessionCookie } from '../lib/opsMiddleware';
import { Hono } from 'hono';

function cookie(email: string, secret = 'sek') {
  const c = new Hono();
  c.get('/', (ctx) => { issueSessionCookie(ctx, email, secret, Date.now()); return ctx.text('ok'); });
  return c.request('/').then((r) => r.headers.get('set-cookie')!.split(';')[0]);
}
const auth = { opsUsers: 'f@x.com:founder,fin@x.com:finance,op@x.com:ops', googleClientId: 'cid', opsSessionSecret: 'sek' };

describe('admin capability gates', () => {
  it('jobs/notifications: system key 200, ops session 403', async () => {
    const app = createApp({ auth, adminApiKey: 'k' });
    expect((await app.request('/admin/jobs/notifications', { method: 'POST', headers: { 'x-admin-key': 'k' } })).status).toBe(200);
    expect((await app.request('/admin/jobs/notifications', { method: 'POST', headers: { cookie: await cookie('op@x.com') } })).status).toBe(403);
  });

  it('cancel requires payments:act — the machine key is REJECTED (system lacks payments:act), finance session is allowed', async () => {
    // seed a cancellable paid booking via the existing test helper pattern used elsewhere in this file
    const { app, bookingId } = await seedCancellableBooking({ auth, adminApiKey: 'k' }); // reuse/adapt existing seeding helper in this file
    expect((await app.request(`/admin/bookings/${bookingId}/cancel`, { method: 'POST', headers: { 'x-admin-key': 'k' } })).status).toBe(403);
    expect((await app.request(`/admin/bookings/${bookingId}/cancel`, { method: 'POST', headers: { cookie: await cookie('fin@x.com') } })).status).toBe(200);
  });

  it('ops session (no payments:act) is rejected on cancel', async () => {
    const { app, bookingId } = await seedCancellableBooking({ auth, adminApiKey: 'k' });
    expect((await app.request(`/admin/bookings/${bookingId}/cancel`, { method: 'POST', headers: { cookie: await cookie('op@x.com') } })).status).toBe(403);
  });

  it('GET /admin/bookings needs bookings:read — any of the 3 roles works, no key needed', async () => {
    const app = createApp({ auth, adminApiKey: 'k' });
    expect((await app.request('/admin/bookings', { headers: { cookie: await cookie('op@x.com') } })).status).toBe(200);
  });
});
```

(`seedCancellableBooking` is a placeholder name — re-grep `admin.test.ts`'s existing booking-seeding pattern for cancel/refund tests today and adapt it rather than inventing a new helper; the file already has to create a paid booking to test `authed()`-gated cancel, so this is a rename/adapt of existing scaffolding, not new infrastructure.)

- [ ] **Step 2: Run to verify fail**

Run: `cd api && npx vitest run src/routes/admin.test.ts`
Expected: FAIL.

- [ ] **Step 3: Rewrite `admin.ts`.** Replace the `authed` helper and `deps` signature:

```ts
import { opsIdentity, requireCap, type OpsAuthConfig } from '../lib/opsMiddleware';

export function adminRoutes(deps: {
  bookings: BookingRepo;
  departures: DepartureRepo;
  email: EmailAdapter;
  notificationLog: NotificationLogRepo;
  auth: OpsAuthConfig;
  alerts?: AlertAdapter;
  alertLog?: AlertLogRepo;
  digestTo?: string;
}) {
  const { bookings, departures, email, notificationLog, auth } = deps;
  const alerts: AlertAdapter = deps.alerts ?? { send: async () => {} };
  const r = new Hono();
  r.use('*', opsIdentity(auth));

  r.get('/bookings', requireCap('bookings:read'), async (c) => {
    const status = c.req.query('status');
    if (status && !(BOOKING_STATUSES as readonly string[]).includes(status)) {
      return c.json({ error: 'bad_status' }, 400);
    }
    const list = await bookings.list(status ? { status: status as BookingStatus } : undefined);
    return c.json(list, 200);
  });

  async function transitionAndNotify(
    c: Context,
    to: BookingStatus,
    notify: (b: Booking, e: EmailAdapter) => Promise<void>,
  ) {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'not_found' }, 404);
    const booking = await bookings.get(id);
    if (!booking) return c.json({ error: 'not_found' }, 404);
    let updated: Booking;
    try {
      updated = await bookings.setStatus(id, to);
    } catch (err) {
      if (err instanceof IllegalTransitionError) {
        return c.json({ error: 'illegal_transition', from: err.from, to: err.to }, 409);
      }
      throw err;
    }
    if (updated.mode === 'shared' && !(to === 'refunded' && booking.status === 'cancelled')) {
      try {
        await departures.releaseSeats({
          corridorId: updated.input.corridorId, date: updated.input.date,
          time: updated.input.time, seats: updated.input.seats,
        });
      } catch (err) {
        console.error(`seat release failed for ${updated.reference}:`, err);
      }
    }
    try {
      await notify(updated, email);
    } catch (err) {
      console.error(`${to} email failed for ${updated.reference}:`, err);
    }
    return c.json(updated, 200);
  }

  r.post('/bookings/:id/cancel', requireCap('payments:act'), (c) => transitionAndNotify(c, 'cancelled', sendCancellationConfirmation));
  r.post('/bookings/:id/refund', requireCap('payments:act'), (c) => transitionAndNotify(c, 'refunded', sendRefundConfirmation));

  r.post('/jobs/notifications', requireCap('admin:jobs'), async (c) => {
    const result = await runScheduledNotifications(new Date(), { bookings, log: notificationLog, email });
    let staleSharedHolds = 0;
    try {
      staleSharedHolds = (await sweepStaleSharedHolds({ bookings, departures, now: new Date() })).swept;
    } catch (err) {
      console.error('stale shared-hold sweep failed:', err);
    }
    let digest = false;
    if (deps.digestTo) {
      try {
        const d = await buildDigest(new Date(), { bookings, alertLog: deps.alertLog });
        await email.send({ to: deps.digestTo, subject: d.subject, html: d.html, text: d.text });
        digest = true;
      } catch (err) {
        console.error('ops digest failed:', err);
      }
    }
    return c.json({ ...result, staleSharedHolds, digest }, 200);
  });

  r.post('/jobs/watchdog', requireCap('admin:jobs'), async (c) => {
    const result = await runWatchdog(new Date(), { bookings, log: notificationLog, alerts });
    return c.json(result, 200);
  });

  return r;
}
```

Note `founder` and `finance` both have `payments:act` (per the matrix), so cancel/refund now work for either role's session — this is correct per spec §3, not a widening bug. `founder` also has `admin:jobs`, so a founder session (not just the system key) can trigger `/jobs/*` too — also correct per the matrix (founder is a superset).

- [ ] **Step 4: Update `app.ts`'s route wiring** (`~174-186`):

```ts
  app.route(
    '/admin',
    adminRoutes({
      bookings, departures, email, notificationLog,
      auth: opsAuthCfg,
      alerts,
      alertLog: deps.alertLog,
      digestTo: deps.digestTo ?? config.ALERT_EMAIL,
    }),
  );
```

- [ ] **Step 5: Run to verify pass**

Run: `cd api && npx vitest run src/routes/admin.test.ts && npm run typecheck`
Expected: PASS + clean typecheck (this should be the LAST remaining typecheck error source — confirm `npm run typecheck` is now fully clean).

- [ ] **Step 6: Commit**

```bash
git add api/src/routes/admin.ts api/src/routes/admin.test.ts api/src/app.ts
git commit -m "feat(auth): admin routes — payments:act for cancel/refund, admin:jobs for cron; x-admin-key no longer a founder backdoor"
```

---

## Task T-F: Dev-bypass prod-refusal test, security/smoke/e2e updates, go-live checklist, full green

Closes out the reconciliation: the safety-net test the spec explicitly calls for (§7 "Dev bypass safety"), then sweeps every remaining test/doc surface that still assumes the old key model.

**Files:**
- Test (new): `api/src/routes/ops.dev-login.test.ts`
- Modify: `api/src/security.test.ts` (re-grep for any `OPS_SUPPORT_KEY`/`OPS_FOUNDER_KEY`/raw-key assumption — grep showed none directly, but re-check after T-A's config change since it may reference `ADMIN_API_KEY` behavior that changed)
- Modify: `api/src/smoke.test.ts` (uses `x-admin-key` against `/admin/bookings?status=paid` — this now needs `bookings:read`, which `system` does NOT have per the matrix; **this smoke test will break** and must be updated to use a founder/finance session cookie instead of the raw key, since `system` only has `admin:jobs`)
- Modify: `web-tests/e2e/ops-ui.spec.js`, `web-tests/e2e/quote-tool.spec.js` (both currently log in via `#loginkey` + `OPS_FOUNDER_KEY`/`OPS_SUPPORT_KEY` env vars — rewrite to use the dev-bypass POST `/admin/ops/dev-login` with an `OPS_USERS`-seeded email, and update the "support" role name to `ops`/`finance` per the new 3-role model; also update the "founder-only Quote nav" assertions since D-A makes Quote visible to all 3 roles now)
- Modify: `docs/go-live-checklist.md` (env table + Google OAuth setup step)
- Modify: `.claude/memory` note `ceylon-hop-permissions-roles.md` is NOT a repo file (it's the user's cross-session memory) — do not edit it as part of this branch; flag to Roshen to update it manually once merged (see Ambiguities).

- [ ] **Step 1: Write the production-refusal test.** Create `api/src/routes/ops.dev-login.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createApp } from '../app';

function appFor(nodeEnv: string) {
  // createApp reads config.NODE_ENV for opsAuthCfg.nodeEnv; inject via the auth override path
  // used elsewhere in this suite is not available for nodeEnv directly (it comes from config),
  // so exercise opsRoutes directly with an explicit OpsAuthConfig instead of through createApp.
  return createApp({
    auth: { opsUsers: 'op@x.com:ops', googleClientId: 'cid', opsSessionSecret: 'sek' },
    adminApiKey: 'k',
    // NOTE: see Ambiguity A-1 below — createApp does not currently expose a nodeEnv override.
  });
}

describe('dev-login bypass', () => {
  it('works in development/test for an allowlisted email', async () => {
    const app = appFor('test');
    const res = await app.request('/admin/ops/dev-login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'op@x.com' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('ch_ops=');
  });

  it('refuses in production (404, no cookie)', async () => {
    // Requires opsAuthCfg.nodeEnv === 'production' — see Ambiguity A-1 for how AppDeps
    // needs a nodeEnv override to test this without mutating process.env.
    const res = await appFor('production').request('/admin/ops/dev-login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'op@x.com' }),
    });
    expect(res.status).toBe(404);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});
```

**This step surfaces Ambiguity A-1 (see below): `AppDeps`/`opsAuthCfg` currently derives `nodeEnv` unconditionally from `config.NODE_ENV`, with no per-test override, unlike `opsUsers`/`googleClientId`/`sessionSecret` which all accept a `deps.auth` override.** Fix as part of this step: add `nodeEnv?: string` to `AppDeps.auth` in `app.ts` (T-A's interface, extend it here) so `opsAuthCfg.nodeEnv = deps.auth?.nodeEnv ?? config.NODE_ENV`. This is a one-line addition to T-A's already-landed `app.ts` edit — do it here since this is the task that needs it, and it doesn't conflict with T-A's diff (additive field).

- [ ] **Step 2: Run to verify pass**

Run: `cd api && npx vitest run src/routes/ops.dev-login.test.ts`
Expected: PASS. If the production case fails, fix the `dev-login` route/`devBypassEnabled` wiring in `ops.ts`/`app.ts` — do NOT touch `opsMiddleware.ts`'s `devBypassEnabled` itself (it's core, already correct: `cfg.nodeEnv !== 'production'`).

- [ ] **Step 3: Fix `smoke.test.ts`.** Its `x-admin-key` calls against `/admin/bookings?status=paid` (lines ~50-53, ~92-95) now get 403 (system lacks `bookings:read`). Replace with a minted founder/finance session cookie:

```ts
import { issueSessionCookie } from './lib/opsMiddleware';
import { Hono } from 'hono';
// ... existing imports

function cookieFor(email: string, secret: string) {
  const c = new Hono();
  c.get('/', (ctx) => { issueSessionCookie(ctx, email, secret, Date.now()); return ctx.text('ok'); });
  return c.request('/').then((r) => r.headers.get('set-cookie')!.split(';')[0]);
}
```

and change `createApp({ adapter, email, conciergeTasks, adminApiKey })` call sites to also pass `auth: { opsUsers: 'smoke@x.com:founder', googleClientId: 'cid', opsSessionSecret: 'smoke-sek' }`, then replace `headers: { 'x-admin-key': adminApiKey }` with `headers: { cookie: await cookieFor('smoke@x.com', 'smoke-sek') }`.

Run: `cd api && npx vitest run src/smoke.test.ts`
Expected: FAIL first (confirm the 403 with the key), then PASS after the cookie swap.

- [ ] **Step 4: Re-check `security.test.ts`.** Re-grep it for any assumption that `x-admin-key` unlocks `/admin/ops/*` or `/admin/quote/*` as founder (the "keys on the rightmost forwarded entry" test found in the initial grep is about rate-limiting, likely unaffected — but re-read the full file at execution time to confirm no other admin-key-as-founder assumption exists before declaring this file done).

Run: `cd api && npx vitest run src/security.test.ts`
Expected: PASS with no changes, OR identify and fix the specific broken assertion.

- [ ] **Step 5: Rewrite the two Playwright e2e specs.** Both `web-tests/e2e/ops-ui.spec.js` and `web-tests/e2e/quote-tool.spec.js` currently:
  - `test.skip` when `OPS_FOUNDER_KEY`/`OPS_SUPPORT_KEY` env vars are empty
  - log in via `#loginkey` fill + form submit
  - assert "founder sees Quote nav; support does not" and "support session gets 403 on /admin/quote/rate-card"

  Rewrite the `login(page, ...)` helper to use the dev-bypass route instead of the UI form (faster and matches how the spec says e2e should authenticate — §5 "Playwright e2e authenticates by POSTing to a login path with a dev-only signed-session helper"):

```js
async function loginAs(page, email) {
  await page.goto(OPS_URL);
  await page.evaluate(async (email) => {
    await fetch('/admin/ops/dev-login', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }),
    });
  }, email);
  await page.reload();
}
```

  Gate the whole suite on `OPS_USERS` being set (rather than the two deleted key vars):

```js
const FOUNDER_EMAIL = process.env.OPS_TEST_FOUNDER_EMAIL || 'founder@dev.test';
const FINANCE_EMAIL = process.env.OPS_TEST_FINANCE_EMAIL || 'finance@dev.test';
const OPS_EMAIL = process.env.OPS_TEST_OPS_EMAIL || 'ops@dev.test';
test.skip(!process.env.OPS_USERS, 'OPS_USERS is empty — cannot resolve roles for dev-login');
```

  And **update the D-A-affected assertions**: "founder sees the Quote nav; support does not" → "founder, finance, and ops ALL see the Quote nav (quote:manage)"; "support session gets a 403 from the API on /admin/quote/rate-card" → delete this test (no role gets 403 on `/rate-card` anymore under quote:manage-for-all) and replace with "a session without margin:view (finance/ops) gets an estimate response with no `margin` key, while founder's does" (mirrors the Vitest assertion in T-D, but end-to-end through the real dev server + browser).

  Also update `web-tests/README`/`package.json` env docs if they reference `OPS_FOUNDER_KEY`/`OPS_SUPPORT_KEY` as required e2e env vars (re-grep at execution time).

  Run: `cd web-tests && npx playwright test e2e/ops-ui.spec.js e2e/quote-tool.spec.js` (requires a running dev server with `OPS_USERS` set to include the three dev-bypass emails, and `NODE_ENV` NOT `production`)
  Expected: PASS. This step is downstream of a running server — coordinate with whichever npm script boots it for e2e (re-grep `package.json`'s `test:e2e*` scripts for the exact invocation, since this plan does not have that command memorized).

- [ ] **Step 6: Update `docs/go-live-checklist.md`.** Edit the env table: **add** `OPS_USERS` (`"email:role,…"` — the 3 staff emails; roles `founder|finance|ops`) and `GOOGLE_OAUTH_CLIENT_ID`; **remove** `OPS_SUPPORT_KEY`/`OPS_FOUNDER_KEY` rows; keep `ADMIN_API_KEY`, re-annotated "cron/watchdog only (`admin:jobs`) — no longer a human login or founder backdoor; rejected on quote/payments routes." Add:

> **Google OAuth (one-time, ~10 min):** create a Web OAuth client ID in the existing Google Cloud project (where the Maps keys live). Consent screen: if the 3 staff use personal `@gmail.com` (not Google Workspace), choose **External** and add the 3 emails as **test users** — an app in "testing" needs no verification review at 3 users and works indefinitely. Authorised JavaScript origins: the API's production origin, `https://ceylonhop.com`, and `http://localhost:<dev-port>`. Copy the client ID into `GOOGLE_OAUTH_CLIENT_ID`. All 3 Google accounts must have 2-step verification on — those inboxes are now the security boundary (spec §9).

Also re-grep `docs/go-live-checklist.md` for any other now-stale reference to the key-based ops login (e.g. a rotation instruction for `OPS_FOUNDER_KEY`) and remove it.

- [ ] **Step 7: Full suite + grep-proof the old surface is gone**

Run: `cd api && npm run check`
Expected: typecheck + lint + ALL tests PASS.

Run: `grep -rn "roleForKey\|OPS_SUPPORT_KEY\|OPS_FOUNDER_KEY\|opsSupportKey\|opsFounderKey\|role==='founder'\|role !== 'founder'\|'support'" api/src --include=*.ts --include=*.html`
Expected: no matches (the `ops-ui.html` `role==='founder'` gates were all converted to `caps.includes('quote:manage')` in T-C; `'support'` as a role string is fully gone — the three roles are `founder|finance|ops`).

- [ ] **Step 8: Commit**

```bash
git add api/src/routes/ops.dev-login.test.ts api/src/smoke.test.ts api/src/app.ts web-tests/e2e/ops-ui.spec.js web-tests/e2e/quote-tool.spec.js docs/go-live-checklist.md
git commit -m "feat(auth): dev-login prod-refusal test, e2e/smoke updated to sessions, go-live checklist for Google sign-in"
```

- [ ] **Step 9: Deploy notes (documentation only — do not perform these against real infra in this plan).** Record for the deploy step (e.g. append to the PR description, not a new doc file unless Roshen asks):
  1. Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID → Web application. Authorised JS origins: prod API origin + `https://ceylonhop.com` + local dev port. No redirect URIs needed (GIS ID-token flow is origin-based, not redirect-based).
  2. OAuth consent screen: External + the 3 staff emails as test users (unless they're on a Workspace domain, in which case Internal is simpler).
  3. Set `GOOGLE_OAUTH_CLIENT_ID` on Render to the client ID.
  4. Set `OPS_USERS="alice@gmail.com:founder,bob@gmail.com:finance,carol@gmail.com:ops"` (real 3 emails) on Render.
  5. Remove `OPS_FOUNDER_KEY`/`OPS_SUPPORT_KEY` from Render's env (no longer read).
  6. Keep `ADMIN_API_KEY` for the existing cron/watchdog job callers — no change needed to the cron caller itself (it never touched quote/payments, only `/admin/jobs/*`, which still accepts the key as `system`).
  7. Confirm all 3 Google accounts have 2FA enabled before flipping the switch (spec §9 — this is the new security boundary).

---

## Ambiguities / risks flagged during planning (do not improvise past these — confirm or decide before/while executing)

1. **A-1 — `AppDeps`/`opsAuthCfg` has no `nodeEnv` override today.** `config.ts`'s `NODE_ENV` is read directly into `opsAuthCfg.nodeEnv` in `app.ts`; unlike `opsUsers`/`googleClientId`/`sessionSecret`, there's no `deps.auth?.nodeEnv` override, so the dev-bypass prod-refusal test (T-F Step 1) can't set `nodeEnv: 'production'` through `createApp()` without either (a) the one-line additive fix folded into T-F Step 1 above (add `nodeEnv?: string` to `AppDeps.auth`), or (b) testing `opsRoutes()` directly (bypassing `createApp`) the way the old plan's Task 8 did. This plan picks (a) for consistency with how every other `auth` field is already overridable, but flag it since it's a small interface addition made *after* T-A nominally "closed" that file — harmless (additive optional field), but worth a reviewer's eye.

2. **A-2 — the login-overlay's dev-bypass button visibility.** The spec doesn't say how the browser should decide whether to *show* a dev-sign-in affordance (only that the route itself must refuse in prod). T-C's plan renders the button unconditionally and lets the 404 be silently swallowed in production, which means a dead "Dev sign-in" button/link would be visible in the real production login page. Options: (a) accept the cosmetic wart (button does nothing in prod, discoverable only by clicking it), (b) have `whoami`'s 401 (or a tiny new unauthenticated endpoint) report `devBypass: boolean` so the client can hide the button, which is a small T-B addition. This plan defaulted to (a) to avoid widening T-B's scope, but this is a product/polish call, not an engineering necessity — flag for Roshen's call before/while implementing T-C.

3. **A-3 — Google Identity Services can't be meaningfully browser-tested without a real client ID.** T-C's Step 10 browser-verification will show a broken/placeholder Google button in local dev (since `GOOGLE_OAUTH_CLIENT_ID` is empty/placeholder per D-B). This is expected and fine — the dev-bypass path is the one that gets exercised in dev/CI/e2e. Do not spend time trying to make the real Google button work locally; that only becomes real at deploy time (T-F Step 9).

4. **A-4 — `/admin/ops/bookings/:id`'s margin note is now a comment, not a gate** (per the spec's own 2026-07-04 correction: there is no cost/margin field on the `Payment` row today, confirmed against `db/paymentRepo.ts`). T-B's rewrite of `ops.ts` keeps this as a code comment rather than a `stripCost` function, matching the spec's explicit instruction not to ship "security theater." If a future milestone adds cost tracking to bookings/payments, whoever does that must add the `margin:view` gate then — flagged in the code comment, not silently forgotten.

5. **A-5 — RESOLVED during planning, not actually ambiguous:** confirmed `db/quoteRepo.ts`'s `QuoteSummary` (the `list()` return type) includes `marginCents` (field at line 35, populated at line 147). T-D Step 4 now includes the concrete `/list` strip — this is not open, just noting it was checked rather than assumed.

6. **A-6 — `.claude` cross-session memory file `ceylon-hop-permissions-roles.md`** (referenced in the system context, not a repo file) says the feature is "STILL BLOCKED — implement only after m12s2 merges to main." Since m12s2 (PR #13) has since merged and this reconciliation work is now proceeding on top of it, that memory note is stale. This plan does not touch it (it lives outside the repo), but flag it for Roshen to update once this reconciliation PR lands, so the memory index doesn't keep asserting a blocker that's cleared.

7. **A-7 — e2e env var naming.** T-F Step 5 invents `OPS_TEST_FOUNDER_EMAIL`/`OPS_TEST_FINANCE_EMAIL`/`OPS_TEST_OPS_EMAIL` as new e2e-only env vars (replacing `OPS_FOUNDER_KEY`/`OPS_SUPPORT_KEY`). This is a naming choice, not a spec requirement — confirm it doesn't collide with an existing e2e env convention elsewhere in `web-tests/` before adopting (re-grep `web-tests/` for any existing `OPS_TEST_*` or similar pattern at execution time).
