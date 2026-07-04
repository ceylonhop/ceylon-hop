# Ops Permissions & Roles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the shared-key auth on Ceylon Hop's two internal tools (ops dashboard, quoting tool) with "Sign in with Google" over a 3-person allowlist, enforced through one capability map, with margins visible to the founder only and machine callers scoped to cron jobs.

**Architecture:** A pure, fully-unit-tested auth core (`opsAuth.ts`) owns roles, the capability map, the identity-only session cookie, and `OPS_USERS` parsing — no Hono, no I/O. A separate Google ID-token verifier (`googleAuth.ts`, backed by `jose`) is the only network dependency. A single Hono middleware (`opsMiddleware.ts`) resolves identity per request (session cookie → email → **role re-looked-up from the allowlist every request**, or `x-admin-key` → `system`) and exposes a `requireCap(action)` guard. Every guarded route across `/admin/ops`, `/admin/quote`, and `/admin` declares the capability it needs instead of comparing roles inline. Margin/cost fields are stripped server-side unless the resolved role has `margin:view`.

**Tech Stack:** TypeScript, Hono, Zod, Vitest (existing). New runtime dep: `jose` (JWKS/JWT verification). Google Identity Services button on the login page (loaded from Google's script tag; only the public client ID is embedded).

## Global Constraints

- **Sequencing:** implement only after `m12s2-ops-dashboard` merges. As of **2026-07-03 that branch is PR #13, still OPEN — not on `main`.** Do not start route work until it lands. Rebase this branch onto the merged `main` first.
- **m12s2 reshape — known route deletions (confirmed from the m12s2 record, verify after merge):** m12s2 **removes the coordinator layer entirely** — `/admin/ops/coordinators`, `/admin/ops/manifest`, `/admin/ops/rides`, and `/admin/ops/bookings/:id/assign` **no longer exist**, and the `coordinators` repo/table + `ride_ops.coordinator_id` are dropped. The ride lifecycle becomes `paid→vehicle_confirmed→pickup_confirmed→on_trip→completed`, and a Control Tower UI is served at `GET /ops` via `api/src/routes/ops-ui.html`. **Task 5 must therefore be re-derived against the reshaped router:** drop the `requireCap` lines for the deleted routes; keep gates only on routes that survive (`/bookings`, `/bookings/:id`, `/bookings/:id/status`, `/bookings/:id/flags`, `/finance/summary`, `whoami`) plus whatever new stage-advance routes m12s2 introduced. Also fold in the m12s2 to-do "add `Secure` to the ops session cookie" — `issueSessionCookie` in Task 4 already sets `secure: true`, so that item is satisfied here.
- The route files below (`ops.ts`, `admin.ts`, `internalQuote.ts`) will have moved/renamed symbols after the reshape — **re-grep every `Modify:` line reference at execution time**; the auth-core tasks (1–2) are unaffected by the reshape.
- **Fail closed in production:** any missing required config (`OPS_USERS`, `GOOGLE_OAUTH_CLIENT_ID`) must deny human login when `NODE_ENV === 'production'`. Never fail open. (Mirrors the existing GL-1c quote-tool posture.)
- **Role is never stored in the cookie.** The cookie carries `{email, exp}` only; the role is resolved from `OPS_USERS` on every request so removing an email revokes access immediately.
- **`system` is not a human role.** It is minted only for a valid `x-admin-key` and satisfies only `admin:jobs`. There is no key-based founder backdoor.
- **Margins are founder-only.** `finance` and `ops` never receive cost/margin fields; stripping is server-side, not UI-only.
- **Dev bypass must refuse to run when `NODE_ENV === 'production'`** and this must be asserted by a test.
- **Real mount prefixes** (not the spec's shorthand): ops = `/admin/ops/*`, quote tool = `/admin/quote/*`, cancel/refund/jobs = `/admin/*`. Login is `POST /admin/ops/login`.
- Roles today are `support | founder`; this plan renames `support → ops` and adds `finance`. No `support` string survives.
- TDD, one behaviour per test, frequent commits. `npm test` / `npm run check` run from `api/`.

---

## File Structure

**New files**
- `api/src/lib/googleAuth.ts` — verify a Google ID token; `verifyGoogleIdToken()`. Test: `api/src/lib/googleAuth.test.ts`.
- `api/src/lib/opsMiddleware.ts` — Hono identity middleware + `requireCap` + dev bypass. Test: `api/src/lib/opsMiddleware.test.ts`.

**Modified files**
- `api/src/lib/opsAuth.ts` — roles, capability map, `can()`, `parseOpsUsers()`, `roleForEmail()`, identity cookie. Test: `api/src/lib/opsAuth.test.ts` (rewrite).
- `api/src/config.ts` — add `OPS_USERS`, `GOOGLE_OAUTH_CLIENT_ID`; remove `OPS_SUPPORT_KEY`, `OPS_FOUNDER_KEY`.
- `api/src/app.ts` — reshape `opsAuthCfg`, `AppDeps.auth`; pass the shared middleware config into the three routers.
- `api/src/routes/ops.ts` — Google login route, apply middleware, `requireCap` gates, margin strip on `/bookings/:id`. Tests: `ops.auth.test.ts`, `ops.roles.test.ts` (rewrite).
- `api/src/routes/internalQuote.ts` + `api/src/routes/quote-tool.html` — session auth, margin strip. Test: `internalQuote.test.ts` (extend).
- `api/src/routes/admin.ts` — cancel/refund → `payments:act`, `/jobs/*` → `admin:jobs`, `/bookings` list → `bookings:read`. Test: `admin.test.ts` (rewrite auth portions).
- `docs/go-live-checklist.md` — env table + Google OAuth setup step.

---

## Task 1: Auth core — roles, capabilities, identity cookie, allowlist

Pure logic, no Hono. This task is unaffected by the m12s2 reshape.

**Files:**
- Modify: `api/src/lib/opsAuth.ts` (full rewrite of the 28-line file)
- Test: `api/src/lib/opsAuth.test.ts` (rewrite)

**Interfaces:**
- Produces:
  - `type OpsRole = 'founder' | 'finance' | 'ops' | 'system'`
  - `type OpsAction = 'quote:manage' | 'margin:view' | 'bookings:operate' | 'bookings:read' | 'payments:act' | 'admin:jobs'`
  - `function can(role: OpsRole, action: OpsAction): boolean`
  - `function parseOpsUsers(raw: string): Map<string, OpsRole>` (lowercased emails → role; ignores blanks/malformed entries)
  - `function roleForEmail(email: string, users: Map<string, OpsRole>): OpsRole | null` (case-insensitive; `null` when absent)
  - `interface SessionPayload { email: string; exp: number }` (exp = epoch ms)
  - `function signSession(payload: SessionPayload, secret: string): string`
  - `function verifySession(token: string | undefined, secret: string, now: number): SessionPayload | null` (returns `null` for tampered, malformed, or expired)

- [ ] **Step 1: Write failing tests for `can()` and the matrix**

Replace the body of `api/src/lib/opsAuth.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  can, parseOpsUsers, roleForEmail, signSession, verifySession,
  type OpsRole, type OpsAction,
} from './opsAuth';

describe('can() capability matrix', () => {
  const rows: [OpsRole, OpsAction, boolean][] = [
    ['founder', 'quote:manage', true], ['founder', 'margin:view', true],
    ['founder', 'bookings:operate', true], ['founder', 'bookings:read', true],
    ['founder', 'payments:act', true], ['founder', 'admin:jobs', true],
    ['finance', 'quote:manage', true], ['finance', 'margin:view', false],
    ['finance', 'bookings:operate', false], ['finance', 'bookings:read', true],
    ['finance', 'payments:act', true], ['finance', 'admin:jobs', false],
    ['ops', 'quote:manage', true], ['ops', 'margin:view', false],
    ['ops', 'bookings:operate', true], ['ops', 'bookings:read', true],
    ['ops', 'payments:act', false], ['ops', 'admin:jobs', false],
    ['system', 'admin:jobs', true], ['system', 'payments:act', false],
    ['system', 'quote:manage', false], ['system', 'bookings:read', false],
  ];
  it.each(rows)('%s can %s === %s', (role, action, expected) => {
    expect(can(role, action)).toBe(expected);
  });
});

describe('parseOpsUsers / roleForEmail', () => {
  const users = parseOpsUsers('Founder@x.com:founder, fin@x.com:finance ,ops@x.com:ops');
  it('maps each email to its role, case-insensitively', () => {
    expect(roleForEmail('founder@x.com', users)).toBe('founder');
    expect(roleForEmail('FOUNDER@X.COM', users)).toBe('founder');
    expect(roleForEmail('fin@x.com', users)).toBe('finance');
    expect(roleForEmail('ops@x.com', users)).toBe('ops');
  });
  it('returns null for an unknown email', () => {
    expect(roleForEmail('nobody@x.com', users)).toBeNull();
  });
  it('ignores malformed / blank entries and an unknown role string', () => {
    const u = parseOpsUsers('good@x.com:founder,,garbage,bad@x.com:wizard');
    expect(roleForEmail('good@x.com', u)).toBe('founder');
    expect(roleForEmail('bad@x.com', u)).toBeNull();
    expect(u.size).toBe(1);
  });
});

describe('identity session cookie', () => {
  const secret = 'sek';
  it('round-trips {email, exp}', () => {
    const tok = signSession({ email: 'a@x.com', exp: 2000 }, secret);
    expect(verifySession(tok, secret, 1000)).toEqual({ email: 'a@x.com', exp: 2000 });
  });
  it('rejects an expired cookie', () => {
    const tok = signSession({ email: 'a@x.com', exp: 500 }, secret);
    expect(verifySession(tok, secret, 1000)).toBeNull();
  });
  it('rejects a tampered payload (HMAC must verify)', () => {
    const tok = signSession({ email: 'a@x.com', exp: 2000 }, secret);
    const [body] = tok.split('.');
    const forged = `${body}.deadbeef`;
    expect(verifySession(forged, secret, 1000)).toBeNull();
  });
  it('rejects a cookie signed with a different secret', () => {
    const tok = signSession({ email: 'a@x.com', exp: 2000 }, 'other');
    expect(verifySession(tok, secret, 1000)).toBeNull();
  });
  it('treats undefined/garbage as null', () => {
    expect(verifySession(undefined, secret, 1000)).toBeNull();
    expect(verifySession('not-a-token', secret, 1000)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && npx vitest run src/lib/opsAuth.test.ts`
Expected: FAIL — `can`, `parseOpsUsers`, etc. not exported / old signatures.

- [ ] **Step 3: Rewrite `opsAuth.ts`**

Replace the whole file:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export type OpsRole = 'founder' | 'finance' | 'ops' | 'system';
export type OpsAction =
  | 'quote:manage' | 'margin:view' | 'bookings:operate'
  | 'bookings:read' | 'payments:act' | 'admin:jobs';

// The capability matrix as data (spec §3). Adding a capability is one row here.
const CAPABILITIES: Record<OpsRole, ReadonlySet<OpsAction>> = {
  founder: new Set(['quote:manage', 'margin:view', 'bookings:operate', 'bookings:read', 'payments:act', 'admin:jobs']),
  finance: new Set(['quote:manage', 'bookings:read', 'payments:act']),
  ops: new Set(['quote:manage', 'bookings:operate', 'bookings:read']),
  system: new Set(['admin:jobs']),
};

export function can(role: OpsRole, action: OpsAction): boolean {
  return CAPABILITIES[role]?.has(action) ?? false;
}

const ROLE_VALUES: ReadonlySet<string> = new Set(['founder', 'finance', 'ops']);

// Parse OPS_USERS="email:role,email:role". Emails lowercased. 'system' is NOT a
// valid login role, so it is rejected here alongside any other unknown string.
export function parseOpsUsers(raw: string): Map<string, OpsRole> {
  const out = new Map<string, OpsRole>();
  for (const entry of (raw ?? '').split(',')) {
    const [email, role] = entry.split(':').map((s) => s.trim());
    if (!email || !role || !ROLE_VALUES.has(role)) continue;
    out.set(email.toLowerCase(), role as OpsRole);
  }
  return out;
}

export function roleForEmail(email: string, users: Map<string, OpsRole>): OpsRole | null {
  return users.get((email ?? '').toLowerCase()) ?? null;
}

export interface SessionPayload {
  email: string;
  exp: number; // epoch ms
}

function mac(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

// Cookie = base64url(json).hmac. Identity only — no role (spec D5).
export function signSession(payload: SessionPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${mac(body, secret)}`;
}

export function verifySession(token: string | undefined, secret: string, now: number): SessionPayload | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = mac(body, secret);
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch { return null; }
  const p = parsed as Partial<SessionPayload>;
  if (typeof p?.email !== 'string' || typeof p?.exp !== 'number') return null;
  if (p.exp <= now) return null;
  return { email: p.email, exp: p.exp };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && npx vitest run src/lib/opsAuth.test.ts`
Expected: PASS (all matrix rows + allowlist + cookie cases).

- [ ] **Step 5: Commit**

```bash
git add api/src/lib/opsAuth.ts api/src/lib/opsAuth.test.ts
git commit -m "feat(auth): opsAuth core — roles, capability map, identity cookie, allowlist"
```

---

## Task 2: Google ID-token verification

Isolate the only network dependency behind one function so routes and tests never touch Google directly.

**Files:**
- Create: `api/src/lib/googleAuth.ts`
- Create: `api/src/lib/googleAuth.test.ts`
- Modify: `api/package.json` (add `jose`)

**Interfaces:**
- Consumes: `jose` (`createRemoteJWKSet`, `jwtVerify`).
- Produces:
  - `interface GoogleIdentity { email: string; emailVerified: boolean }`
  - `function verifyGoogleIdToken(token: string, opts: { clientId: string; verifier?: JwtVerifier }): Promise<GoogleIdentity>` — throws on bad signature/aud/iss/expiry. `verifier` is an injection seam for tests (defaults to the real JWKS-backed verify).
  - `type JwtVerifier = (token: string, clientId: string) => Promise<{ payload: Record<string, unknown> }>`

- [ ] **Step 1: Add `jose`**

Run: `cd api && npm install jose`
Expected: `jose` appears under `dependencies` in `package.json`.

- [ ] **Step 2: Write failing tests (verifier injected — no real network)**

Create `api/src/lib/googleAuth.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { verifyGoogleIdToken, type JwtVerifier } from './googleAuth';

const CLIENT_ID = 'client-123.apps.googleusercontent.com';

// A fake verifier that returns a chosen payload, standing in for jose+JWKS.
const verifierReturning = (payload: Record<string, unknown>): JwtVerifier =>
  async () => ({ payload });

describe('verifyGoogleIdToken', () => {
  it('returns the verified email + verification flag on a good token', async () => {
    const v = verifierReturning({
      iss: 'https://accounts.google.com', aud: CLIENT_ID,
      email: 'Person@x.com', email_verified: true,
    });
    const id = await verifyGoogleIdToken('tok', { clientId: CLIENT_ID, verifier: v });
    expect(id).toEqual({ email: 'Person@x.com', emailVerified: true });
  });

  it('rejects a token whose issuer is not Google', async () => {
    const v = verifierReturning({ iss: 'https://evil.com', aud: CLIENT_ID, email: 'a@x.com', email_verified: true });
    await expect(verifyGoogleIdToken('tok', { clientId: CLIENT_ID, verifier: v })).rejects.toThrow(/issuer/i);
  });

  it('propagates a verifier failure (bad signature / aud / expiry)', async () => {
    const v: JwtVerifier = async () => { throw new Error('signature verification failed'); };
    await expect(verifyGoogleIdToken('tok', { clientId: CLIENT_ID, verifier: v })).rejects.toThrow();
  });

  it('surfaces email_verified === false as emailVerified:false (caller decides)', async () => {
    const v = verifierReturning({ iss: 'accounts.google.com', aud: CLIENT_ID, email: 'a@x.com', email_verified: false });
    const id = await verifyGoogleIdToken('tok', { clientId: CLIENT_ID, verifier: v });
    expect(id.emailVerified).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd api && npx vitest run src/lib/googleAuth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `googleAuth.ts`**

Create `api/src/lib/googleAuth.ts`:

```ts
import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface GoogleIdentity {
  email: string;
  emailVerified: boolean;
}

export type JwtVerifier = (
  token: string,
  clientId: string,
) => Promise<{ payload: Record<string, unknown> }>;

const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

// Cached JWKS — one fetch per process, refreshed by jose on key rotation.
const JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

// Default verifier: jose checks signature, expiry and audience against Google's keys.
const defaultVerifier: JwtVerifier = async (token, clientId) => {
  const { payload } = await jwtVerify(token, JWKS, {
    audience: clientId,
    // jose validates exp/nbf; issuer checked explicitly below so we can normalise both forms.
  });
  return { payload: payload as Record<string, unknown> };
};

export async function verifyGoogleIdToken(
  token: string,
  opts: { clientId: string; verifier?: JwtVerifier },
): Promise<GoogleIdentity> {
  const verifier = opts.verifier ?? defaultVerifier;
  const { payload } = await verifier(token, opts.clientId);
  const iss = String(payload.iss ?? '');
  if (!GOOGLE_ISSUERS.has(iss)) throw new Error(`bad issuer: ${iss}`);
  const email = payload.email;
  if (typeof email !== 'string' || !email) throw new Error('token has no email');
  return { email, emailVerified: payload.email_verified === true };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd api && npx vitest run src/lib/googleAuth.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add api/src/lib/googleAuth.ts api/src/lib/googleAuth.test.ts api/package.json api/package-lock.json
git commit -m "feat(auth): Google ID-token verification via jose (injectable verifier)"
```

---

## Task 3: Config + app wiring

Swap the env surface and thread the new config through `createApp`. Keep this task green by leaving the routers reading the old fields until Tasks 5–7 replace them — so change only what compiles.

**Files:**
- Modify: `api/src/config.ts` (the ops-auth env block — re-grep, was `:33-38`)
- Modify: `api/src/app.ts` (`AppDeps.auth` type ~line 39; `opsAuthCfg` ~lines 69-73; route wiring lines ~157/160)
- Modify: `api/src/server.ts` (~lines 82-85 — the real server passes `opsSupportKey/opsFounderKey` into `createApp`; switch to `opsUsers/googleClientId`)
- Test: covered by the route tasks; add one config-parse assertion here.

> **POST-REBASE:** `server.ts` lines 82-85 currently read `auth: { opsSupportKey: config.OPS_SUPPORT_KEY, opsFounderKey: config.OPS_FOUNDER_KEY, opsSessionSecret: config.OPS_SESSION_SECRET }`. Replace with `auth: { opsUsers: config.OPS_USERS, googleClientId: config.GOOGLE_OAUTH_CLIENT_ID, opsSessionSecret: config.OPS_SESSION_SECRET }`. If this isn't updated, the build breaks (removed config fields) — so `server.ts` must land in the same commit as the config/app change.

**Interfaces:**
- Produces: `config.OPS_USERS: string`, `config.GOOGLE_OAUTH_CLIENT_ID: string`; `AppDeps.auth` becomes `{ opsUsers: string; googleClientId: string; opsSessionSecret: string }`.
- Consumes: nothing new.

- [ ] **Step 1: Edit `config.ts`** — replace the ops-auth block (lines 33-38):

```ts
  // Ops/quote auth (M12s3: Google sign-in + capability roles). See docs/go-live-checklist.md.
  // OPS_USERS = "email:role,email:role" over roles founder|finance|ops (exactly the 3 staff).
  OPS_USERS: z.string().default(''),
  GOOGLE_OAUTH_CLIENT_ID: z.string().default(''),
  OPS_SESSION_SECRET: z.string().default('dev-ops-secret-change-me'),
  // Quote engine internal key — passed to quoteRoutes to gate marginEstimateCents.
  INTERNAL_QUOTE_KEY: z.string().default(''),
```

(Deletes `OPS_SUPPORT_KEY`, `OPS_FOUNDER_KEY`; keeps `ADMIN_API_KEY` at line 11 unchanged.)

- [ ] **Step 2: Edit `app.ts` — `AppDeps.auth` type (line 36)**

```ts
  auth?: { opsUsers: string; googleClientId: string; opsSessionSecret: string };
```

- [ ] **Step 3: Edit `app.ts` — `opsAuthCfg` (lines 55-60)**

```ts
  const opsAuthCfg = {
    opsUsers: deps.auth?.opsUsers ?? config.OPS_USERS,
    googleClientId: deps.auth?.googleClientId ?? config.GOOGLE_OAUTH_CLIENT_ID,
    sessionSecret: deps.auth?.opsSessionSecret ?? config.OPS_SESSION_SECRET,
    adminApiKey,
    nodeEnv: config.NODE_ENV,
  };
```

- [ ] **Step 4: Leave the router calls compiling**

At this point `opsRoutes`/`internalQuoteRoutes`/`adminRoutes` still expect their old params. Do NOT change their signatures yet — just confirm the project still type-checks with the new `opsAuthCfg` shape by temporarily passing the fields each router currently reads. If a router destructures `supportKey`/`founderKey`, those are gone; that router is rewritten in its own task. To keep this commit green, wire `opsAuthCfg` into `opsRoutes` only after Task 5. **Therefore: reorder execution so Step 5 below is a typecheck, and defer the `app.route(...)` edits to Tasks 5–7.** Here, only add a parse test.

- [ ] **Step 5: Add a config assertion test** — create `api/src/config.opsusers.test.ts`:

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

- [ ] **Step 6: Typecheck + test**

Run: `cd api && npm run typecheck && npx vitest run src/config.opsusers.test.ts`
Expected: typecheck may still reference old fields inside routers — if so, this task's commit is deferred until Task 5 lands the router change. Commit config + type + test together with Task 5 if needed. Otherwise:

```bash
git add api/src/config.ts api/src/app.ts api/src/config.opsusers.test.ts
git commit -m "feat(auth): config + app wiring for OPS_USERS + Google client id"
```

> **Note:** Tasks 3, 5, 6, 7 touch `app.ts` route wiring together. If splitting commits leaves a red typecheck, land Task 3's `app.route(...)` edits inside whichever router task first needs them. The plan keeps them separate for review clarity; collapse if the build demands it.

---

## Task 4: Shared identity middleware + `requireCap` + dev bypass

One middleware used by all three routers. Consumes Tasks 1–2.

**Files:**
- Create: `api/src/lib/opsMiddleware.ts`
- Create: `api/src/lib/opsMiddleware.test.ts`

**Interfaces:**
- Consumes: `verifySession`, `roleForEmail`, `parseOpsUsers`, `can`, `OpsRole`, `OpsAction` (Task 1).
- Produces:
  - `interface OpsIdentity { email: string; role: OpsRole }`
  - `interface OpsAuthConfig { opsUsers: string; googleClientId: string; sessionSecret: string; adminApiKey: string; nodeEnv: string }`
  - `const OPS_COOKIE = 'ch_ops'`
  - `function opsIdentity(cfg: OpsAuthConfig): MiddlewareHandler` — resolves identity, sets `c.set('identity', OpsIdentity)`; on failure sets nothing (does not 401 — guards do).
  - `function requireCap(action: OpsAction): MiddlewareHandler` — 401 if no identity, 403 if identity lacks the capability.
  - `function issueSessionCookie(c, email, sessionSecret, now)` — sets the signed cookie (7-day exp), HttpOnly/Secure/SameSite=Lax.
  - `function devBypassEnabled(cfg): boolean` — `cfg.nodeEnv !== 'production'`.

- [ ] **Step 1: Write failing tests** — create `api/src/lib/opsMiddleware.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { opsIdentity, requireCap, issueSessionCookie, type OpsAuthConfig } from './opsMiddleware';

const cfg: OpsAuthConfig = {
  opsUsers: 'f@x.com:founder,fin@x.com:finance,op@x.com:ops',
  googleClientId: 'cid', sessionSecret: 'sek', adminApiKey: 'adminkey', nodeEnv: 'test',
};

function appWith(action: Parameters<typeof requireCap>[0]) {
  const app = new Hono();
  app.use('*', opsIdentity(cfg));
  app.get('/probe', requireCap(action), (c) => c.json({ role: c.get('identity').role }));
  // helper to mint a cookie for a chosen email
  app.post('/mint', async (c) => {
    const { email } = await c.req.json();
    issueSessionCookie(c, email, cfg.sessionSecret, Date.now()); // real clock — cookie must be unexpired vs Date.now() at verify
    return c.json({ ok: true });
  });
  return app;
}

async function cookieFor(app: Hono, email: string) {
  const res = await app.request('/mint', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
  return res.headers.get('set-cookie')!.split(';')[0];
}

describe('opsIdentity + requireCap', () => {
  it('401 when no cookie and no key', async () => {
    const app = appWith('bookings:read');
    expect((await app.request('/probe')).status).toBe(401);
  });

  it('allows founder through payments:act', async () => {
    const app = appWith('payments:act');
    const cookie = await cookieFor(app, 'f@x.com');
    expect((await app.request('/probe', { headers: { cookie } })).status).toBe(200);
  });

  it('403 for ops on payments:act (capability denied)', async () => {
    const app = appWith('payments:act');
    const cookie = await cookieFor(app, 'op@x.com');
    expect((await app.request('/probe', { headers: { cookie } })).status).toBe(403);
  });

  it('revokes instantly: a valid cookie whose email left OPS_USERS → 403', async () => {
    const app = appWith('bookings:read');
    const cookie = await cookieFor(app, 'f@x.com');
    // rebuild the app with the founder removed from the allowlist, same secret
    const app2 = new Hono();
    app2.use('*', opsIdentity({ ...cfg, opsUsers: 'fin@x.com:finance' }));
    app2.get('/probe', requireCap('bookings:read'), (c) => c.json({ ok: true }));
    expect((await app2.request('/probe', { headers: { cookie } })).status).toBe(403);
  });

  it('x-admin-key → system satisfies admin:jobs but not payments:act', async () => {
    const jobs = appWith('admin:jobs');
    const pay = appWith('payments:act');
    expect((await jobs.request('/probe', { headers: { 'x-admin-key': 'adminkey' } })).status).toBe(200);
    expect((await pay.request('/probe', { headers: { 'x-admin-key': 'adminkey' } })).status).toBe(403);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd api && npx vitest run src/lib/opsMiddleware.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `opsMiddleware.ts`**

```ts
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import {
  verifySession, signSession, parseOpsUsers, roleForEmail, can,
  type OpsRole, type OpsAction,
} from './opsAuth';

export const OPS_COOKIE = 'ch_ops';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface OpsIdentity { email: string; role: OpsRole }
export interface OpsAuthConfig {
  opsUsers: string;
  googleClientId: string;
  sessionSecret: string;
  adminApiKey: string;
  nodeEnv: string;
}

declare module 'hono' {
  interface ContextVariableMap { identity: OpsIdentity; revoked: boolean }
}

export function devBypassEnabled(cfg: OpsAuthConfig): boolean {
  return cfg.nodeEnv !== 'production';
}

export function issueSessionCookie(c: Context, email: string, sessionSecret: string, now: number): void {
  const token = signSession({ email, exp: now + SESSION_TTL_MS }, sessionSecret);
  setCookie(c, OPS_COOKIE, token, {
    httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: SESSION_TTL_MS / 1000,
  });
}

// Resolve identity from (a) x-admin-key → system, or (b) session cookie → email → role
// looked up FRESH from OPS_USERS every request. Never throws; guards enforce.
export function opsIdentity(cfg: OpsAuthConfig): MiddlewareHandler {
  const users = parseOpsUsers(cfg.opsUsers);
  return async (c, next) => {
    const key = c.req.header('x-admin-key');
    if (key && cfg.adminApiKey && key === cfg.adminApiKey) {
      c.set('identity', { email: 'cron', role: 'system' });
      return next();
    }
    const payload = verifySession(getCookie(c, OPS_COOKIE), cfg.sessionSecret, Date.now());
    if (payload) {
      const role = roleForEmail(payload.email, users);
      if (role) c.set('identity', { email: payload.email, role });
      else c.set('revoked', true); // valid cookie, email no longer allowlisted → 403 at the guard
    }
    return next();
  };
}

export function requireCap(action: OpsAction): MiddlewareHandler {
  return async (c, next) => {
    const id = c.get('identity');
    if (!id) {
      if (c.get('revoked')) return c.json({ error: 'forbidden' }, 403); // authenticated but deallowlisted
      return c.json({ error: 'unauthorized' }, 401);
    }
    if (!can(id.role, action)) return c.json({ error: 'forbidden' }, 403);
    return next();
  };
}
```

> `Date.now()` inside the middleware is fine in production; tests that need determinism assert via short-TTL cookies rather than freezing time. The `issueSessionCookie(c, email, secret, now)` `now` param keeps cookie minting testable.

- [ ] **Step 4: Run to verify pass**

Run: `cd api && npx vitest run src/lib/opsMiddleware.test.ts`
Expected: PASS (401/allow/403/revoke/system rows).

- [ ] **Step 5: Commit**

```bash
git add api/src/lib/opsMiddleware.ts api/src/lib/opsMiddleware.test.ts
git commit -m "feat(auth): shared opsIdentity middleware + requireCap + cookie issuing"
```

---

## Task 5: Ops routes — Google login, capability gates, margin strip

Rewrite the ops router's auth. **Re-grep line numbers post-m12s2.**

**Files:**
- Modify: `api/src/routes/ops.ts` (login route, middleware, gates, `/bookings/:id`)
- Modify: `api/src/app.ts:100` (pass new `opsAuthCfg` + verifier)
- Test (all migrate off the old `{opsSupportKey,opsFounderKey}` + `/login {key}` model to the new `{opsUsers,googleClientId,opsSessionSecret}` shape + minted session cookies): `api/src/routes/ops.auth.test.ts`, `api/src/routes/ops.roles.test.ts`, `api/src/routes/ops.test.ts` (asserts `{role:'support'}` and "bad login key" — both obsolete, rewrite), `api/src/routes/ops.bookings.test.ts`, `api/src/routes/ops.search.test.ts`. Provide a shared `mintCookie(email)` test helper (wraps `issueSessionCookie`) so all five files authenticate the same way.

**Interfaces:**
- Consumes: `opsIdentity`, `requireCap`, `issueSessionCookie`, `devBypassEnabled` (Task 4); `verifyGoogleIdToken` (Task 2); `can` (Task 1).
- Produces: `OpsDeps.auth` becomes `OpsAuthConfig`; adds optional `googleVerifier?: JwtVerifier` for tests.

- [ ] **Step 1: Rewrite the ops auth tests**

Replace `api/src/routes/ops.roles.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { issueSessionCookie } from '../lib/opsMiddleware';
import { Hono } from 'hono';

const auth = {
  opsUsers: 'f@x.com:founder,fin@x.com:finance,op@x.com:ops',
  googleClientId: 'cid', opsSessionSecret: 'sek',
};

// Mint a session cookie for an email without invoking Google (matches the dev bypass path).
function cookie(email: string) {
  const c = new Hono();
  let out = '';
  c.get('/', (ctx) => { issueSessionCookie(ctx, email, 'sek', Date.now()); return ctx.text('ok'); });
  return c.request('/').then((r) => r.headers.get('set-cookie')!.split(';')[0]);
}

describe('ops capability gates', () => {
  it('finance/summary is founder-only (403 finance/ops, 200 founder)', async () => {
    const app = createApp({ auth, adminApiKey: 'adminkey' });
    expect((await app.request('/admin/ops/finance/summary', { headers: { cookie: await cookie('op@x.com') } })).status).toBe(403);
    expect((await app.request('/admin/ops/finance/summary', { headers: { cookie: await cookie('fin@x.com') } })).status).toBe(403);
    expect((await app.request('/admin/ops/finance/summary', { headers: { cookie: await cookie('f@x.com') } })).status).toBe(200);
  });

  it('bookings:operate mutators reject finance (403) but allow ops', async () => {
    const app = createApp({ auth, adminApiKey: 'adminkey' });
    const res = await app.request('/admin/ops/bookings/x/assign', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: await cookie('fin@x.com') },
      body: JSON.stringify({ coordinatorId: null }),
    });
    expect(res.status).toBe(403);
  });
});
```

Replace `api/src/routes/ops.auth.test.ts` — keep the "401 without auth" and "forged cookie" cases, but drop key-login and adapt the positive control to a minted cookie:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../app';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryRideOpsRepo } from '../db/rideOpsRepo';
import { InMemoryCoordinatorRepo } from '../db/coordinatorRepo';
import { issueSessionCookie } from '../lib/opsMiddleware';
import { Hono } from 'hono';

const auth = { opsUsers: 'op@x.com:ops', googleClientId: 'cid', opsSessionSecret: 'sek' };

function cookie(email: string, secret = 'sek') {
  const c = new Hono();
  c.get('/', (ctx) => { issueSessionCookie(ctx, email, secret, Date.now()); return ctx.text('ok'); });
  return c.request('/').then((r) => r.headers.get('set-cookie')!.split(';')[0]);
}
function makeApp() {
  const bookings = new InMemoryBookingRepo();
  const app = createApp({ bookings, rideOps: new InMemoryRideOpsRepo(), coordinators: new InMemoryCoordinatorRepo(), auth, adminApiKey: 'adminkey' });
  return { app, bookings };
}

describe('ops authorization surface', () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => { app = makeApp().app; });

  it('rejects reads and mutators without auth (401)', async () => {
    for (const [m, p] of [['GET', '/admin/ops/bookings'], ['GET', '/admin/ops/coordinators']] as const) {
      expect((await app.request(p, { method: m })).status).toBe(401);
    }
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
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd api && npx vitest run src/routes/ops.auth.test.ts src/routes/ops.roles.test.ts`
Expected: FAIL — new `auth` shape, missing login behaviour.

- [ ] **Step 3: Rewrite `ops.ts` login + middleware + gates**

Replace the imports, `OpsDeps`, cookie/login block, and the middleware (lines 1-53) with:

```ts
import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { BookingRepo } from '../db/bookingRepo';
import type { PaymentRepo } from '../db/paymentRepo';
import type { RideOpsRepo } from '../db/rideOpsRepo';
import type { CoordinatorRepo } from '../db/coordinatorRepo';
import { can, parseOpsUsers, roleForEmail } from '../lib/opsAuth';
import {
  opsIdentity, requireCap, issueSessionCookie, devBypassEnabled, OPS_COOKIE,
  type OpsAuthConfig,
} from '../lib/opsMiddleware';
import { verifyGoogleIdToken, type JwtVerifier } from '../lib/googleAuth';
import { toOpsRow, manifestLine } from '../services/opsView';

export interface OpsDeps {
  bookings: BookingRepo;
  payments: PaymentRepo;
  rideOps: RideOpsRepo;
  coordinators: CoordinatorRepo;
  auth: OpsAuthConfig;
  googleVerifier?: JwtVerifier; // test seam
}

export function opsRoutes(deps: OpsDeps) {
  const r = new Hono();
  const { auth } = deps;
  const users = parseOpsUsers(auth.opsUsers);

  // Google sign-in: browser POSTs the Google ID token; we verify, allowlist-check, set cookie.
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
  // Refuses in production (spec constraint; asserted by a test in Task 8).
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
  r.get('/whoami', requireCap('bookings:read'), (c) => c.json(c.get('identity')));
  r.get('/finance/summary', requireCap('margin:view'), (c) => c.json({ ok: true }));
```

Then apply guards to the existing handlers (keep their bodies), e.g.:

```ts
  r.get('/bookings', requireCap('bookings:read'), async (c) => { /* unchanged body */ });
  r.get('/bookings/:id', requireCap('bookings:read'), async (c) => {
    const b = await deps.bookings.get(c.req.param('id'));
    if (!b) return c.json({ error: 'not_found' }, 404);
    const ops = await deps.rideOps.getOrCreate(b.id);
    const payments = await deps.payments.findByBookingId(b.id);
    const canMargin = can(c.get('identity').role, 'margin:view');
    return c.json({ booking: b, ops, payments: canMargin ? payments : payments.map(stripCost) });
  });
  r.post('/bookings/:id/status', requireCap('bookings:operate'), async (c) => { /* unchanged */ });
  r.post('/bookings/:id/flags', requireCap('bookings:operate'), async (c) => { /* unchanged */ });
```

> **POST-REBASE (m12s2):** the coordinator layer is gone. The reshaped `ops.ts` route surface is exactly: `/login`, `/logout`, `/whoami`, `/finance/summary`, `/bookings`, `/bookings/:id`, `/bookings/:id/status`, `/bookings/:id/flags`. Do **not** add gates for `/coordinators`, `/manifest`, `/rides`, or `/bookings/:id/assign` — they no longer exist. Gate only the eight routes above (login/logout are pre-middleware and ungated; whoami/finance/summary/bookings* get the `requireCap` shown).

Add the cost-stripper near the top of the file (adjust field names to the real payment shape at implementation time):

```ts
// Remove any internal cost/margin fields from a payment row before it leaves the API
// for a non-margin:view role. Customer-facing amount/status stay. Delete-by-key (not a
// rest-destructure) to avoid no-unused-vars lint on the dropped names. Confirm the real
// cost/margin field names on the payment row at implementation time.
const COST_FIELDS = ['cost', 'costCents', 'margin', 'marginCents'] as const;
function stripCost<T extends Record<string, unknown>>(p: T): T {
  const out = { ...p };
  for (const k of COST_FIELDS) delete (out as Record<string, unknown>)[k];
  return out;
}
```

- [ ] **Step 4: Update `app.ts` route wiring** (line 100):

```ts
  app.route('/admin/ops', opsRoutes({ bookings, payments, rideOps, coordinators, auth: opsAuthCfg }));
```

(`opsAuthCfg` from Task 3 now matches `OpsAuthConfig` — it already carries `nodeEnv`.)

- [ ] **Step 5: Run to verify pass**

Run: `cd api && npx vitest run src/routes/ops.auth.test.ts src/routes/ops.roles.test.ts && npm run typecheck`
Expected: PASS + clean typecheck.

- [ ] **Step 6: Commit**

```bash
git add api/src/routes/ops.ts api/src/routes/ops.auth.test.ts api/src/routes/ops.roles.test.ts api/src/app.ts api/src/config.ts api/src/config.opsusers.test.ts
git commit -m "feat(auth): ops routes on Google login + capability gates + margin strip"
```

---

## Task 6: Quote tool — session auth + margin strip

Drop the `prompt()`/`x-admin-key` human path; sit behind the shared session, gated by `quote:manage`; strip margin unless `margin:view`.

**Files:**
- Modify: `api/src/routes/internalQuote.ts:217-244` (deps + guard), `:197-208` (`shape` margin), `:290-300` (estimate response)
- Modify: `api/src/routes/quote-tool.html` (remove key prompt/`x-admin-key` header; on 401 redirect to `/admin/ops/login`)
- Modify: `api/src/app.ts:102`
- Test: `api/src/routes/internalQuote.test.ts` (extend)

**Interfaces:**
- Consumes: `opsIdentity`, `requireCap` (Task 4); `can` (Task 1).
- Produces: `internalQuoteRoutes` deps become `{ maps; quotes; auth: OpsAuthConfig }` (drops `adminKey`/`allowNoKey`).

- [ ] **Step 1: Write failing tests** — add to `internalQuote.test.ts`:

```ts
it('rejects the quote tool data routes without a session (401)', async () => {
  const app = createApp({ auth: { opsUsers: 'op@x.com:ops', googleClientId: 'cid', opsSessionSecret: 'sek' }, adminApiKey: 'k' });
  expect((await app.request('/admin/quote/list')).status).toBe(401);
});

it('omits margin for an ops session, includes it for founder', async () => {
  const auth = { opsUsers: 'f@x.com:founder,op@x.com:ops', googleClientId: 'cid', opsSessionSecret: 'sek' };
  const app = createApp({ auth, adminApiKey: 'k' });
  const body = { vehicle: 'car', passengerCount: 2, luggageCount: 1, legs: [{ from: 'A', to: 'B', distanceKm: 100 }] };
  const opsRes = await app.request('/admin/quote/estimate', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: await cookie('op@x.com') }, body: JSON.stringify(body),
  });
  expect((await opsRes.json()).margin).toBeUndefined();
  const fRes = await app.request('/admin/quote/estimate', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: await cookie('f@x.com') }, body: JSON.stringify(body),
  });
  expect((await fRes.json())).toHaveProperty('margin');
});
```

(Reuse the `cookie()` helper pattern from Task 5; import `issueSessionCookie`.)

- [ ] **Step 2: Run to verify fail**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts`
Expected: FAIL — routes currently key-gated / margin always present.

- [ ] **Step 3: Replace the guard block** (`internalQuote.ts` lines 217-244) with:

```ts
export function internalQuoteRoutes(deps: { maps: MapsAdapter; quotes: QuoteRepo; auth: OpsAuthConfig }) {
  const r = new Hono();

  // Open HTML shell (a navigation can't send auth); the page's fetches carry the cookie.
  r.get('/', (c) => {
    const html = toolHtml();
    if (html == null) { console.error('GET /admin/quote: no cached html'); return c.html('<h1>quote tool unavailable</h1>', 500); }
    return c.html(html);
  });

  // Every data route requires a quote:manage session (spec §5). No key path for humans.
  r.use('*', opsIdentity(deps.auth));
  r.use('*', (c, next) => (c.req.path === '/admin/quote' ? next() : requireCap('quote:manage')(c, next)));
```

Import at top: `import { opsIdentity, requireCap, type OpsAuthConfig } from '../lib/opsMiddleware'; import { can } from '../lib/opsAuth';`

- [ ] **Step 4: Gate margin in the response shaping**

In `shape()` (line ~197), take a `canMargin` flag and drop the key when false:

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

Update the `/estimate` handler to compute `const canMargin = can(c.get('identity').role, 'margin:view');` and call `shape(result, canMargin)`. (The `/save` route persists `marginCents` server-side regardless — that's storage, not exposure — so leave `save` unchanged.)

- [ ] **Step 5: Update `app.ts`** (line 102):

```ts
  app.route('/admin/quote', internalQuoteRoutes({ maps, quotes, auth: opsAuthCfg }));
```

- [ ] **Step 6: Update `quote-tool.html`**

Remove the `prompt()` for the admin key and the `x-admin-key` header on fetches. On any `401` from a data route, `window.location = '/admin/ops/login'`. Hide the margin panel when the `margin` field is absent from `/estimate` responses (it already renders from the payload; guard the DOM write with `if (data.margin !== undefined)`). Grep the file for `x-admin-key` and `prompt(` to find every site.

- [ ] **Step 7: Run to verify pass**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts && npm run typecheck`
Expected: PASS + clean typecheck.

- [ ] **Step 8: Commit**

```bash
git add api/src/routes/internalQuote.ts api/src/routes/quote-tool.html api/src/app.ts api/src/routes/internalQuote.test.ts
git commit -m "feat(auth): quote tool behind ops session + server-side margin strip"
```

---

## Task 7: Admin routes — payments:act + admin:jobs split

`admin.ts` currently guards everything with the raw key. Split: cancel/refund need `payments:act` (founder/finance session); `/jobs/*` need `admin:jobs` (system key or founder); `/bookings` list needs `bookings:read`.

**Files:**
- Modify: `api/src/routes/admin.ts` (replace `authed` with the shared middleware + `requireCap`)
- Modify: `api/src/app.ts:103`
- Test: `api/src/routes/admin.test.ts` (rewrite auth assertions)

**Interfaces:**
- Consumes: `opsIdentity`, `requireCap` (Task 4).
- Produces: `adminRoutes` deps gain `auth: OpsAuthConfig` (keeps `adminApiKey` inside it).

- [ ] **Step 1: Write failing tests** — in `admin.test.ts`, assert the new matrix:

```ts
// jobs: system key works; a founder session works; an ops session is 403
it('jobs/notifications: system key 200, ops session 403', async () => {
  const auth = { opsUsers: 'op@x.com:ops,f@x.com:founder', googleClientId: 'cid', opsSessionSecret: 'sek' };
  const app = createApp({ auth, adminApiKey: 'k' });
  expect((await app.request('/admin/jobs/notifications', { method: 'POST', headers: { 'x-admin-key': 'k' } })).status).toBe(200);
  expect((await app.request('/admin/jobs/notifications', { method: 'POST', headers: { cookie: await cookie('op@x.com') } })).status).toBe(403);
});

// cancel/refund: finance session works; the raw key does NOT (system lacks payments:act)
it('cancel requires payments:act — key is rejected, finance allowed', async () => {
  const auth = { opsUsers: 'fin@x.com:finance', googleClientId: 'cid', opsSessionSecret: 'sek' };
  const { app, bid } = await seededApp(auth); // helper: create app + a cancellable booking
  expect((await app.request(`/admin/bookings/${bid}/cancel`, { method: 'POST', headers: { 'x-admin-key': 'k' } })).status).toBe(403);
  expect((await app.request(`/admin/bookings/${bid}/cancel`, { method: 'POST', headers: { cookie: await cookie('fin@x.com') } })).status).toBe(200);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd api && npx vitest run src/routes/admin.test.ts`
Expected: FAIL.

- [ ] **Step 3: Rewrite `admin.ts` auth**

Replace the `authed` helper and the per-route `if (!authed(c))` checks with middleware + `requireCap`:

```ts
export function adminRoutes(deps: {
  bookings: BookingRepo; departures: DepartureRepo; email: EmailAdapter;
  notificationLog: NotificationLogRepo; auth: OpsAuthConfig;
}) {
  const { bookings, departures, email, notificationLog, auth } = deps;
  const r = new Hono();
  r.use('*', opsIdentity(auth));

  r.get('/bookings', requireCap('bookings:read'), async (c) => { /* body unchanged, drop the authed() check */ });

  // transitionAndNotify keeps its body but loses the authed() gate (the route guards now).
  r.post('/bookings/:id/cancel', requireCap('payments:act'), (c) => transitionAndNotify(c, 'cancelled', sendCancellationConfirmation));
  r.post('/bookings/:id/refund', requireCap('payments:act'), (c) => transitionAndNotify(c, 'refunded', sendRefundConfirmation));

  r.post('/jobs/notifications', requireCap('admin:jobs'), async (c) => { /* body unchanged, drop authed() */ });

  return r;
}
```

Import: `import { opsIdentity, requireCap, type OpsAuthConfig } from '../lib/opsMiddleware';`. Remove the now-unused `authed` and the `Boolean(adminApiKey) && header===key` checks from each handler body.

- [ ] **Step 4: Update `app.ts`** (line 103):

```ts
  app.route('/admin', adminRoutes({ bookings, departures, email, notificationLog, auth: opsAuthCfg }));
```

- [ ] **Step 5: Run to verify pass**

Run: `cd api && npx vitest run src/routes/admin.test.ts && npm run typecheck`
Expected: PASS + clean typecheck.

- [ ] **Step 6: Commit**

```bash
git add api/src/routes/admin.ts api/src/app.ts api/src/routes/admin.test.ts
git commit -m "feat(auth): admin routes split — payments:act for cancel/refund, admin:jobs for cron"
```

---

## Task 8: Dev-bypass safety, go-live checklist, full green

**Files:**
- Test: `api/src/routes/ops.dev-login.test.ts` (new)
- Modify: `docs/go-live-checklist.md`

- [ ] **Step 1: Write the production-refusal test** — create `api/src/routes/ops.dev-login.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { opsRoutes } from './ops';
import { Hono } from 'hono';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryPaymentRepo } from '../db/paymentRepo';
import { InMemoryRideOpsRepo } from '../db/rideOpsRepo';
import { InMemoryCoordinatorRepo } from '../db/coordinatorRepo';

function appFor(nodeEnv: string) {
  const app = new Hono();
  app.route('/admin/ops', opsRoutes({
    bookings: new InMemoryBookingRepo(), payments: new InMemoryPaymentRepo(),
    rideOps: new InMemoryRideOpsRepo(), coordinators: new InMemoryCoordinatorRepo(),
    auth: { opsUsers: 'op@x.com:ops', googleClientId: 'cid', sessionSecret: 'sek', adminApiKey: 'k', nodeEnv },
  }));
  return app;
}

describe('dev-login bypass', () => {
  it('works in development for an allowlisted email', async () => {
    const res = await appFor('development').request('/admin/ops/dev-login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'op@x.com' }),
    });
    expect(res.status).toBe(200);
  });
  it('refuses in production (404, no cookie)', async () => {
    const res = await appFor('production').request('/admin/ops/dev-login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'op@x.com' }),
    });
    expect(res.status).toBe(404);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect pass** (behaviour already implemented in Task 5)

Run: `cd api && npx vitest run src/routes/ops.dev-login.test.ts`
Expected: PASS. If the production case fails, fix `devBypassEnabled`/the `dev-login` guard, not the test.

- [ ] **Step 3: Update `docs/go-live-checklist.md`**

Edit the env table: **add** `OPS_USERS` (`"email:role,…"` — the 3 staff emails; roles `founder|finance|ops`) and `GOOGLE_OAUTH_CLIENT_ID`; **remove** the `OPS_SUPPORT_KEY` and `OPS_FOUNDER_KEY` rows; keep `ADMIN_API_KEY` but re-annotate it "cron/watchdog only — no longer a human or founder login". Add a setup line:

> **Google OAuth (one-time):** create a Web OAuth client ID in the existing Google Cloud project. Consent screen: if staff use `@gmail.com` (not Workspace), choose **External** and add the 3 emails as **test users** (an app in "testing" needs no verification review at 3 users). Authorised JavaScript origins: the API origin, `https://ceylonhop.com`, and `http://localhost:<dev-port>`. Copy the client ID into `GOOGLE_OAUTH_CLIENT_ID`. All 3 Google accounts must have 2-step verification on — those inboxes are the security boundary.

- [ ] **Step 4: Full suite + check**

Run: `cd api && npm run check`
Expected: typecheck + lint + all tests PASS. Grep to prove the old surface is gone:

Run: `grep -rn "roleForKey\|OPS_SUPPORT_KEY\|OPS_FOUNDER_KEY\|'support'" api/src` → expect no matches.

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/ops.dev-login.test.ts docs/go-live-checklist.md
git commit -m "feat(auth): dev-login prod-refusal test + go-live checklist for Google sign-in"
```

---

## Self-Review notes (for the executor)

- **Spec §3.1 margin surfaces:** `/admin/quote/*` (Task 6), `/admin/ops/finance/summary` founder-gate (Task 5), `/admin/ops/bookings/:id` payment-cost strip (Task 5). The M17 digest-email recipient case is out of scope here — flag it in the M17 plan, don't build it now.
- **Path aliasing:** the spec says `/ops/*`; the code mounts `/admin/ops/*`. All tasks use real paths. If m12s2 introduces a bare `/ops` alias, re-point the tests.
- **`stripCost` field names** are a guess against the current payment row — confirm the real cost/margin keys on the `payments` shape at implementation time and update the destructure.
- **Not covered by design (leave alone):** the public `/quote` route's `INTERNAL_QUOTE_KEY` margin gate is a separate mechanism for a different surface; do not fold it into this work.
- **Logout** cookie-clear is written inline; if the m12s2 reshape adds a cookie helper, use it.
