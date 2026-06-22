# Ops Dashboard — Slice 1 Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the backend API for the Ceylon Hop ops dashboard Slice 1 — an ops layer over the read-only website booking model, with coordinator assignment, the WhatsApp manifest, two-axis status, and the support/founder role boundary.

**Architecture:** New ops-layer tables (`coordinators`, `ride_ops`) reference website bookings by id; booking tables are never mutated. Hono routes under `/admin/ops/*` are auth-gated by a signed, role-bearing session cookie (support/founder), with the existing `x-admin-key` honoured as founder for CLI. Repos follow the existing interface + InMemory + Postgres seam.

**Tech Stack:** Node 20 · TypeScript (strict) · Hono · Zod · Vitest · Drizzle + Postgres (Supabase). Spec: `docs/ops-dashboard-slice-1-spec.md`.

## Global Constraints

- All backend code in `api/` only. Never edit the frozen front-end (root `*.html`/`*.js`, etc.).
- One step = one branch = one PR. Tests proven red→green. `cd api && npm run check` green before each PR.
- Money = integer minor units + ISO currency. IDs = uuid.
- Never mutate website booking tables (`bookings`, `customers`, `*_request`, `payments`). The ops layer only reads them and writes its own tables.
- Migrations are hand-written SQL applied via `npm run migrate` (drizzle-kit generate needs a TTY — do not use it). Continue the numbered sequence (next is `0007`).
- Repos expose an interface with an `InMemory*` (for unit tests) and a `Postgres*` (DB integration in CI) implementation, mirroring `bookingRepo.ts` / `conciergeTaskRepo.ts`.
- No new external services. The UI is a later plan; this plan is JSON endpoints only.

---

### Task 1: Ride fulfilment status domain

**Files:**
- Create: `api/src/domain/rideStatus.ts`
- Test: `api/src/domain/rideStatus.test.ts`

**Interfaces:**
- Produces: `RIDE_STATUSES: readonly RideStatus[]`, `type RideStatus`, `canRideTransition(from: RideStatus, to: RideStatus): boolean`, `assertRideTransition(from, to): void` (throws `Error` on illegal).

Mirror the existing `domain/status.ts` pattern (forward-only transitions).

- [ ] **Step 1: Write the failing test** — `api/src/domain/rideStatus.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { RIDE_STATUSES, canRideTransition, assertRideTransition } from './rideStatus';

describe('ride fulfilment status', () => {
  it('lists the seven states', () => {
    expect(RIDE_STATUSES).toEqual([
      'unassigned', 'assigned', 'sent_to_coordinator', 'acknowledged',
      'vehicle_confirmed', 'customer_updated', 'completed',
    ]);
  });
  it('allows the forward path', () => {
    expect(canRideTransition('unassigned', 'assigned')).toBe(true);
    expect(canRideTransition('assigned', 'sent_to_coordinator')).toBe(true);
    expect(canRideTransition('vehicle_confirmed', 'customer_updated')).toBe(true);
  });
  it('rejects skipping and going backwards', () => {
    expect(canRideTransition('unassigned', 'completed')).toBe(false);
    expect(canRideTransition('completed', 'assigned')).toBe(false);
  });
  it('allows re-assigning a coordinator (assigned → assigned) and un-assigning', () => {
    expect(canRideTransition('assigned', 'unassigned')).toBe(true);
    expect(canRideTransition('sent_to_coordinator', 'assigned')).toBe(true); // re-assign after send
  });
  it('assertRideTransition throws on an illegal move', () => {
    expect(() => assertRideTransition('unassigned', 'completed')).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `cd api && npx vitest run src/domain/rideStatus.test.ts` → FAIL (module not found).

- [ ] **Step 3: Write minimal implementation** — `api/src/domain/rideStatus.ts`

```ts
export const RIDE_STATUSES = [
  'unassigned', 'assigned', 'sent_to_coordinator', 'acknowledged',
  'vehicle_confirmed', 'customer_updated', 'completed',
] as const;

export type RideStatus = (typeof RIDE_STATUSES)[number];

// Forward path, plus a couple of operational backtracks (re-assign / pull back to assign).
const ALLOWED: Record<RideStatus, RideStatus[]> = {
  unassigned: ['assigned'],
  assigned: ['sent_to_coordinator', 'unassigned'],
  sent_to_coordinator: ['acknowledged', 'assigned'],
  acknowledged: ['vehicle_confirmed', 'assigned'],
  vehicle_confirmed: ['customer_updated', 'assigned'],
  customer_updated: ['completed', 'vehicle_confirmed'],
  completed: [],
};

export function canRideTransition(from: RideStatus, to: RideStatus): boolean {
  if (from === to) return true; // idempotent set
  return ALLOWED[from]?.includes(to) ?? false;
}

export function assertRideTransition(from: RideStatus, to: RideStatus): void {
  if (!canRideTransition(from, to)) throw new Error(`Illegal ride transition: ${from} → ${to}`);
}
```

- [ ] **Step 4: Run test to verify it passes** — `cd api && npx vitest run src/domain/rideStatus.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/domain/rideStatus.ts api/src/domain/rideStatus.test.ts
git commit -m "ops: ride fulfilment status domain (guarded transitions)"
```

---

### Task 2: Coordinator repo (interface + InMemory)

**Files:**
- Create: `api/src/db/coordinatorRepo.ts`
- Test: `api/src/db/coordinatorRepo.test.ts`

**Interfaces:**
- Produces:
  - `interface Coordinator { id: string; name: string; whatsapp: string; regions: string; active: boolean; createdAt: string }`
  - `interface NewCoordinator { name: string; whatsapp: string; regions?: string }`
  - `interface CoordinatorRepo { create(c: NewCoordinator): Promise<Coordinator>; get(id): Promise<Coordinator|null>; list(opts?: { activeOnly?: boolean }): Promise<Coordinator[]> }`
  - `class InMemoryCoordinatorRepo implements CoordinatorRepo`

- [ ] **Step 1: Write the failing test** — `api/src/db/coordinatorRepo.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { InMemoryCoordinatorRepo } from './coordinatorRepo';

describe('InMemoryCoordinatorRepo', () => {
  it('creates and reads back a coordinator (active by default)', async () => {
    const repo = new InMemoryCoordinatorRepo();
    const c = await repo.create({ name: 'Nuwan', whatsapp: '+94770000000', regions: 'South coast' });
    expect(c.id).toBeTruthy();
    expect(c.active).toBe(true);
    expect((await repo.get(c.id))?.name).toBe('Nuwan');
  });
  it('lists coordinators, newest-first, with an active-only filter', async () => {
    const repo = new InMemoryCoordinatorRepo();
    const a = await repo.create({ name: 'A', whatsapp: '1' });
    await repo.create({ name: 'B', whatsapp: '2' });
    expect((await repo.list()).map((c) => c.name)).toEqual(['B', 'A']);
    // deactivate a via a fresh create flag is out of scope; just assert filter shape
    expect(await repo.list({ activeOnly: true })).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `cd api && npx vitest run src/db/coordinatorRepo.test.ts` → FAIL.

- [ ] **Step 3: Write minimal implementation** — `api/src/db/coordinatorRepo.ts`

```ts
import { randomUUID } from 'node:crypto';

export interface Coordinator {
  id: string; name: string; whatsapp: string; regions: string; active: boolean; createdAt: string;
}
export interface NewCoordinator { name: string; whatsapp: string; regions?: string }

export interface CoordinatorRepo {
  create(c: NewCoordinator): Promise<Coordinator>;
  get(id: string): Promise<Coordinator | null>;
  list(opts?: { activeOnly?: boolean }): Promise<Coordinator[]>;
}

export class InMemoryCoordinatorRepo implements CoordinatorRepo {
  private items: Coordinator[] = [];
  async create(c: NewCoordinator): Promise<Coordinator> {
    const row: Coordinator = {
      id: randomUUID(), name: c.name, whatsapp: c.whatsapp, regions: c.regions ?? '',
      active: true, createdAt: new Date().toISOString(),
    };
    this.items.push(row);
    return row;
  }
  async get(id: string): Promise<Coordinator | null> {
    return this.items.find((c) => c.id === id) ?? null;
  }
  async list(opts?: { activeOnly?: boolean }): Promise<Coordinator[]> {
    const all = [...this.items].reverse(); // newest-first
    return opts?.activeOnly ? all.filter((c) => c.active) : all;
  }
}
```

- [ ] **Step 4: Run test to verify it passes** — `cd api && npx vitest run src/db/coordinatorRepo.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/db/coordinatorRepo.ts api/src/db/coordinatorRepo.test.ts
git commit -m "ops: coordinator repo (interface + in-memory)"
```

---

### Task 3: RideOps repo (interface + InMemory)

**Files:**
- Create: `api/src/db/rideOpsRepo.ts`
- Test: `api/src/db/rideOpsRepo.test.ts`

**Interfaces:**
- Consumes: `RideStatus`, `assertRideTransition` from `domain/rideStatus`.
- Produces:
  - `interface RideOps { bookingId: string; coordinatorId: string | null; fulfilmentStatus: RideStatus; vehiclePhotoReceived: boolean; customerUpdated: boolean; opsNotes: string | null; assignedAt: string|null; sentAt: string|null; acknowledgedAt: string|null; vehicleConfirmedAt: string|null; updatedAt: string }`
  - `interface RideOpsRepo { getOrCreate(bookingId): Promise<RideOps>; get(bookingId): Promise<RideOps|null>; assign(bookingId, coordinatorId: string|null): Promise<RideOps>; setStatus(bookingId, to: RideStatus): Promise<RideOps>; setFlags(bookingId, flags: { vehiclePhotoReceived?: boolean; customerUpdated?: boolean; opsNotes?: string|null }): Promise<RideOps>; listByBookingIds(ids: string[]): Promise<RideOps[]> }`
  - `class InMemoryRideOpsRepo implements RideOpsRepo`

Behaviour: `getOrCreate` defaults a row at `unassigned`. `assign(id, coordId)` sets `coordinatorId`, stamps `assignedAt`, and if currently `unassigned` advances to `assigned`. `setStatus` calls `assertRideTransition` then stamps the matching timestamp (`sent_to_coordinator`→`sentAt`, `acknowledged`→`acknowledgedAt`, `vehicle_confirmed`→`vehicleConfirmedAt`). All writes bump `updatedAt`.

- [ ] **Step 1: Write the failing test** — `api/src/db/rideOpsRepo.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { InMemoryRideOpsRepo } from './rideOpsRepo';

describe('InMemoryRideOpsRepo', () => {
  it('lazily creates a ride_ops row at unassigned', async () => {
    const repo = new InMemoryRideOpsRepo();
    const r = await repo.getOrCreate('b1');
    expect(r.fulfilmentStatus).toBe('unassigned');
    expect(r.coordinatorId).toBeNull();
  });
  it('assigning a coordinator advances unassigned → assigned and stamps assignedAt', async () => {
    const repo = new InMemoryRideOpsRepo();
    const r = await repo.assign('b1', 'coord1');
    expect(r.coordinatorId).toBe('coord1');
    expect(r.fulfilmentStatus).toBe('assigned');
    expect(r.assignedAt).toBeTruthy();
  });
  it('setStatus enforces the transition guard and stamps timestamps', async () => {
    const repo = new InMemoryRideOpsRepo();
    await repo.assign('b1', 'coord1');
    const sent = await repo.setStatus('b1', 'sent_to_coordinator');
    expect(sent.sentAt).toBeTruthy();
    await expect(repo.setStatus('b1', 'completed')).rejects.toThrow(); // illegal skip
  });
  it('setFlags toggles photo/customerUpdated/notes', async () => {
    const repo = new InMemoryRideOpsRepo();
    const r = await repo.setFlags('b1', { vehiclePhotoReceived: true, opsNotes: 'gate code 4421' });
    expect(r.vehiclePhotoReceived).toBe(true);
    expect(r.opsNotes).toBe('gate code 4421');
  });
  it('listByBookingIds returns existing rows only', async () => {
    const repo = new InMemoryRideOpsRepo();
    await repo.getOrCreate('b1');
    expect((await repo.listByBookingIds(['b1', 'b2'])).map((r) => r.bookingId)).toEqual(['b1']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `cd api && npx vitest run src/db/rideOpsRepo.test.ts` → FAIL.

- [ ] **Step 3: Write minimal implementation** — `api/src/db/rideOpsRepo.ts`

```ts
import { assertRideTransition, type RideStatus } from '../domain/rideStatus';

export interface RideOps {
  bookingId: string;
  coordinatorId: string | null;
  fulfilmentStatus: RideStatus;
  vehiclePhotoReceived: boolean;
  customerUpdated: boolean;
  opsNotes: string | null;
  assignedAt: string | null;
  sentAt: string | null;
  acknowledgedAt: string | null;
  vehicleConfirmedAt: string | null;
  updatedAt: string;
}

export interface RideOpsRepo {
  getOrCreate(bookingId: string): Promise<RideOps>;
  get(bookingId: string): Promise<RideOps | null>;
  assign(bookingId: string, coordinatorId: string | null): Promise<RideOps>;
  setStatus(bookingId: string, to: RideStatus): Promise<RideOps>;
  setFlags(bookingId: string, flags: { vehiclePhotoReceived?: boolean; customerUpdated?: boolean; opsNotes?: string | null }): Promise<RideOps>;
  listByBookingIds(ids: string[]): Promise<RideOps[]>;
}

function blank(bookingId: string): RideOps {
  const now = new Date().toISOString();
  return {
    bookingId, coordinatorId: null, fulfilmentStatus: 'unassigned',
    vehiclePhotoReceived: false, customerUpdated: false, opsNotes: null,
    assignedAt: null, sentAt: null, acknowledgedAt: null, vehicleConfirmedAt: null, updatedAt: now,
  };
}

export class InMemoryRideOpsRepo implements RideOpsRepo {
  private byId = new Map<string, RideOps>();
  private touch(r: RideOps): RideOps { r.updatedAt = new Date().toISOString(); this.byId.set(r.bookingId, r); return { ...r }; }

  async getOrCreate(bookingId: string): Promise<RideOps> {
    const existing = this.byId.get(bookingId);
    if (existing) return { ...existing };
    const row = blank(bookingId);
    this.byId.set(bookingId, row);
    return { ...row };
  }
  async get(bookingId: string): Promise<RideOps | null> {
    const r = this.byId.get(bookingId);
    return r ? { ...r } : null;
  }
  async assign(bookingId: string, coordinatorId: string | null): Promise<RideOps> {
    const r = this.byId.get(bookingId) ?? blank(bookingId);
    r.coordinatorId = coordinatorId;
    r.assignedAt = new Date().toISOString();
    if (coordinatorId && r.fulfilmentStatus === 'unassigned') r.fulfilmentStatus = 'assigned';
    if (!coordinatorId) r.fulfilmentStatus = 'unassigned';
    return this.touch(r);
  }
  async setStatus(bookingId: string, to: RideStatus): Promise<RideOps> {
    const r = this.byId.get(bookingId) ?? blank(bookingId);
    assertRideTransition(r.fulfilmentStatus, to);
    r.fulfilmentStatus = to;
    if (to === 'sent_to_coordinator') r.sentAt = new Date().toISOString();
    if (to === 'acknowledged') r.acknowledgedAt = new Date().toISOString();
    if (to === 'vehicle_confirmed') r.vehicleConfirmedAt = new Date().toISOString();
    return this.touch(r);
  }
  async setFlags(bookingId: string, flags: { vehiclePhotoReceived?: boolean; customerUpdated?: boolean; opsNotes?: string | null }): Promise<RideOps> {
    const r = this.byId.get(bookingId) ?? blank(bookingId);
    if (flags.vehiclePhotoReceived !== undefined) r.vehiclePhotoReceived = flags.vehiclePhotoReceived;
    if (flags.customerUpdated !== undefined) r.customerUpdated = flags.customerUpdated;
    if (flags.opsNotes !== undefined) r.opsNotes = flags.opsNotes;
    return this.touch(r);
  }
  async listByBookingIds(ids: string[]): Promise<RideOps[]> {
    return ids.map((id) => this.byId.get(id)).filter((r): r is RideOps => !!r).map((r) => ({ ...r }));
  }
}
```

- [ ] **Step 4: Run test to verify it passes** — `cd api && npx vitest run src/db/rideOpsRepo.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/db/rideOpsRepo.ts api/src/db/rideOpsRepo.test.ts
git commit -m "ops: ride_ops repo (interface + in-memory, guarded status)"
```

---

### Task 4: Ops session/auth helper (sign + verify role cookie)

**Files:**
- Create: `api/src/lib/opsAuth.ts`
- Test: `api/src/lib/opsAuth.test.ts`
- Modify: `api/src/config.ts` (add `OPS_SUPPORT_KEY`, `OPS_FOUNDER_KEY`, `OPS_SESSION_SECRET`)

**Interfaces:**
- Produces:
  - `type OpsRole = 'support' | 'founder'`
  - `signSession(role: OpsRole, secret: string): string` — returns `role.hmac` token.
  - `verifySession(token: string|undefined, secret: string): OpsRole | null`
  - `roleForKey(key: string, cfg: { supportKey: string; founderKey: string }): OpsRole | null` — maps a login key to a role.

Use Node `crypto.createHmac('sha256', secret)` for a tamper-evident token; no DB.

- [ ] **Step 1: Write the failing test** — `api/src/lib/opsAuth.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { signSession, verifySession, roleForKey } from './opsAuth';

const SECRET = 'test-secret';

describe('opsAuth', () => {
  it('signs and verifies a role token round-trip', () => {
    const t = signSession('support', SECRET);
    expect(verifySession(t, SECRET)).toBe('support');
    expect(verifySession(signSession('founder', SECRET), SECRET)).toBe('founder');
  });
  it('rejects a tampered or wrong-secret token', () => {
    const t = signSession('support', SECRET);
    expect(verifySession(t, 'other-secret')).toBeNull();
    expect(verifySession('founder.deadbeef', SECRET)).toBeNull();
    expect(verifySession(undefined, SECRET)).toBeNull();
  });
  it('maps login keys to roles', () => {
    const cfg = { supportKey: 'sup', founderKey: 'fou' };
    expect(roleForKey('sup', cfg)).toBe('support');
    expect(roleForKey('fou', cfg)).toBe('founder');
    expect(roleForKey('nope', cfg)).toBeNull();
    expect(roleForKey('', cfg)).toBeNull(); // empty never matches even if a key is unset
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `cd api && npx vitest run src/lib/opsAuth.test.ts` → FAIL.

- [ ] **Step 3: Write minimal implementation** — `api/src/lib/opsAuth.ts`

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export type OpsRole = 'support' | 'founder';

function mac(role: OpsRole, secret: string): string {
  return createHmac('sha256', secret).update(role).digest('hex');
}

export function signSession(role: OpsRole, secret: string): string {
  return `${role}.${mac(role, secret)}`;
}

export function verifySession(token: string | undefined, secret: string): OpsRole | null {
  if (!token) return null;
  const [role, sig] = token.split('.');
  if (role !== 'support' && role !== 'founder') return null;
  const expected = mac(role, secret);
  if (!sig || sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return role;
}

export function roleForKey(key: string, cfg: { supportKey: string; founderKey: string }): OpsRole | null {
  if (!key) return null;
  if (cfg.founderKey && key === cfg.founderKey) return 'founder';
  if (cfg.supportKey && key === cfg.supportKey) return 'support';
  return null;
}
```

- [ ] **Step 4: Add config** — in `api/src/config.ts`, inside the `Env` object add:

```ts
  // Ops dashboard auth (Slice 1: per-role keys → signed session cookie).
  OPS_SUPPORT_KEY: z.string().default(''),
  OPS_FOUNDER_KEY: z.string().default(''),
  OPS_SESSION_SECRET: z.string().default('dev-ops-secret-change-me'),
```

- [ ] **Step 5: Run test to verify it passes** — `cd api && npx vitest run src/lib/opsAuth.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add api/src/lib/opsAuth.ts api/src/lib/opsAuth.test.ts api/src/config.ts
git commit -m "ops: signed role-session helper + config keys"
```

---

### Task 5: Ops routes scaffold — login + auth middleware + role gate

**Files:**
- Create: `api/src/routes/ops.ts`
- Test: `api/src/routes/ops.test.ts`
- Modify: `api/src/app.ts` (wire `opsRoutes`; pass new deps)

**Interfaces:**
- Consumes: `OpsRole`, `signSession`, `verifySession`, `roleForKey` (opsAuth); `CoordinatorRepo`, `RideOpsRepo`, `BookingRepo`, `PaymentRepo`.
- Produces: `opsRoutes(deps: { bookings: BookingRepo; payments: PaymentRepo; rideOps: RideOpsRepo; coordinators: CoordinatorRepo; auth: { supportKey: string; founderKey: string; sessionSecret: string; adminApiKey: string } }): Hono` mounted at `/admin/ops` by `app.ts`.
  - `POST /admin/ops/login` `{ key }` → sets `ch_ops` httpOnly cookie, returns `{ role }`. Invalid → 401.
  - `POST /admin/ops/logout` → clears cookie.
  - Middleware: every other route requires a valid session (cookie) OR `x-admin-key === adminApiKey` (treated as `founder`); else 401. A `requireFounder` helper returns 403 for `support`.
  - `GET /admin/ops/whoami` → `{ role }` (smoke route used by the UI + tests).

Use Hono's `getCookie`/`setCookie` from `hono/cookie`.

- [ ] **Step 1: Write the failing test** — `api/src/routes/ops.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { createApp } from '../app';

const deps = {
  auth: { opsSupportKey: 'sup', opsFounderKey: 'fou', opsSessionSecret: 'sek' },
  adminApiKey: 'adminkey',
};

describe('ops auth', () => {
  it('rejects unauthenticated access', async () => {
    const app = createApp(deps);
    const res = await app.request('/admin/ops/whoami');
    expect(res.status).toBe(401);
  });
  it('logs in with the support key and sets a session cookie', async () => {
    const app = createApp(deps);
    const login = await app.request('/admin/ops/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'sup' }),
    });
    expect(login.status).toBe(200);
    expect(await login.json()).toEqual({ role: 'support' });
    const cookie = login.headers.get('set-cookie')!;
    expect(cookie).toContain('ch_ops=');
    const who = await app.request('/admin/ops/whoami', { headers: { cookie: cookie.split(';')[0] } });
    expect(await who.json()).toEqual({ role: 'support' });
  });
  it('honours x-admin-key as founder', async () => {
    const app = createApp(deps);
    const who = await app.request('/admin/ops/whoami', { headers: { 'x-admin-key': 'adminkey' } });
    expect(await who.json()).toEqual({ role: 'founder' });
  });
  it('rejects a bad login key', async () => {
    const app = createApp(deps);
    const res = await app.request('/admin/ops/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'nope' }),
    });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `cd api && npx vitest run src/routes/ops.test.ts` → FAIL.

- [ ] **Step 3: Write minimal implementation** — `api/src/routes/ops.ts`

```ts
import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { BookingRepo } from '../db/bookingRepo';
import type { PaymentRepo } from '../db/paymentRepo';
import type { RideOpsRepo } from '../db/rideOpsRepo';
import type { CoordinatorRepo } from '../db/coordinatorRepo';
import { signSession, verifySession, roleForKey, type OpsRole } from '../lib/opsAuth';

export interface OpsDeps {
  bookings: BookingRepo;
  payments: PaymentRepo;
  rideOps: RideOpsRepo;
  coordinators: CoordinatorRepo;
  auth: { supportKey: string; founderKey: string; sessionSecret: string; adminApiKey: string };
}

const COOKIE = 'ch_ops';

export function opsRoutes(deps: OpsDeps) {
  const r = new Hono<{ Variables: { role: OpsRole } }>();
  const { auth } = deps;

  r.post('/login', async (c) => {
    const body = z.object({ key: z.string() }).safeParse(await c.req.json().catch(() => ({})));
    const role = body.success ? roleForKey(body.data.key, { supportKey: auth.supportKey, founderKey: auth.founderKey }) : null;
    if (!role) return c.json({ error: 'unauthorized' }, 401);
    setCookie(c, COOKIE, signSession(role, auth.sessionSecret), {
      httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 60 * 60 * 12,
    });
    return c.json({ role }, 200);
  });

  r.post('/logout', (c) => { setCookie(c, COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 }); return c.json({ ok: true }); });

  // auth middleware for everything below
  r.use('*', async (c, next) => {
    const headerRole = c.req.header('x-admin-key') && c.req.header('x-admin-key') === auth.adminApiKey ? 'founder' : null;
    const role = headerRole ?? verifySession(getCookie(c, COOKIE), auth.sessionSecret);
    if (!role) return c.json({ error: 'unauthorized' }, 401);
    c.set('role', role);
    await next();
  });

  r.get('/whoami', (c) => c.json({ role: c.get('role') }));

  return r;
}
```

- [ ] **Step 4: Wire into `app.ts`** — add to `AppDeps`: `rideOps?`, `coordinators?`, and an `auth?: { opsSupportKey; opsFounderKey; opsSessionSecret }`. Default the repos to the new InMemory classes and read keys from `config`. Mount:

```ts
import { opsRoutes } from './routes/ops';
import { InMemoryRideOpsRepo } from './db/rideOpsRepo';
import { InMemoryCoordinatorRepo } from './db/coordinatorRepo';
// inside createApp:
const rideOps = deps.rideOps ?? new InMemoryRideOpsRepo();
const coordinators = deps.coordinators ?? new InMemoryCoordinatorRepo();
const opsAuthCfg = {
  supportKey: deps.auth?.opsSupportKey ?? config.OPS_SUPPORT_KEY,
  founderKey: deps.auth?.opsFounderKey ?? config.OPS_FOUNDER_KEY,
  sessionSecret: deps.auth?.opsSessionSecret ?? config.OPS_SESSION_SECRET,
  adminApiKey,
};
app.route('/admin/ops', opsRoutes({ bookings, payments, rideOps, coordinators, auth: opsAuthCfg }));
```

Add `rideOps?: RideOpsRepo; coordinators?: CoordinatorRepo; auth?: { opsSupportKey: string; opsFounderKey: string; opsSessionSecret: string }` to `AppDeps`.

- [ ] **Step 5: Run test to verify it passes** — `cd api && npx vitest run src/routes/ops.test.ts` → PASS. Then `npm run check` to confirm nothing else broke.

- [ ] **Step 6: Commit**

```bash
git add api/src/routes/ops.ts api/src/routes/ops.test.ts api/src/app.ts
git commit -m "ops: routes scaffold — login, session middleware, role gate"
```

---

### Task 6: Booking view-model (shared shaper, no revenue leak)

**Files:**
- Create: `api/src/services/opsView.ts`
- Test: `api/src/services/opsView.test.ts`

**Interfaces:**
- Consumes: `Booking` (bookingRepo), `RideOps`, payment status.
- Produces:
  - `interface OpsBookingRow { id; reference; mode; bookingStatus; paymentStatus: 'paid'|'unpaid'|'partial'; amount: number; currency; customerFirstName; customerName; route: string; travelDate: string|null; travelTime: string|null; pax: number; coordinatorId: string|null; fulfilmentStatus: string; vehiclePhotoReceived: boolean; customerUpdated: boolean }`
  - `toOpsRow(booking: Booking, opts: { rideOps?: RideOps|null; paid: boolean }): OpsBookingRow`
  - `manifestLine(booking: Booking): string` — one WhatsApp line, **no money**.

This isolates "what ops sees" (incl. the amount on detail, but a single source of truth so list/detail never leak aggregate finance — there is simply no aggregation here).

- [ ] **Step 1: Write the failing test** — `api/src/services/opsView.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { toOpsRow, manifestLine } from './opsView';
import type { Booking } from '../db/bookingRepo';

const base: Booking = {
  mode: 'single', id: 'b1', reference: 'CH-AAA11', status: 'paid', createdAt: '2026-06-21T00:00:00Z',
  total: 12100, currency: 'USD',
  input: { from: 'Colombo Airport', to: 'Galle', vehicleType: 'car', adults: 2, children: 1, bags: 2,
    date: '2026-06-22', time: '09:00',
    customer: { firstName: 'Maya', lastName: 'Silva', email: 'm@x.com', whatsapp: '+34600', country: 'ES' } },
};

describe('opsView', () => {
  it('shapes a single-transfer row with route, pax and payment status', () => {
    const row = toOpsRow(base, { paid: true, rideOps: null });
    expect(row.route).toBe('Colombo Airport → Galle');
    expect(row.pax).toBe(3);
    expect(row.paymentStatus).toBe('paid');
    expect(row.fulfilmentStatus).toBe('unassigned'); // default when no ride_ops
    expect(row.customerFirstName).toBe('Maya');
  });
  it('marks unpaid bookings', () => {
    expect(toOpsRow({ ...base, status: 'payment_pending' }, { paid: false }).paymentStatus).toBe('unpaid');
  });
  it('manifestLine excludes money', () => {
    const line = manifestLine(base);
    expect(line).toContain('CH-AAA11');
    expect(line).toContain('09:00');
    expect(line).toContain('Colombo Airport → Galle');
    expect(line).not.toMatch(/\$|121|USD/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `cd api && npx vitest run src/services/opsView.test.ts` → FAIL.

- [ ] **Step 3: Write minimal implementation** — `api/src/services/opsView.ts`

```ts
import type { Booking } from '../db/bookingRepo';
import type { RideOps } from '../db/rideOpsRepo';

export interface OpsBookingRow {
  id: string; reference: string; mode: string; bookingStatus: string;
  paymentStatus: 'paid' | 'unpaid' | 'partial'; amount: number; currency: string;
  customerFirstName: string; customerName: string;
  route: string; travelDate: string | null; travelTime: string | null; pax: number;
  coordinatorId: string | null; fulfilmentStatus: string;
  vehiclePhotoReceived: boolean; customerUpdated: boolean;
}

function route(b: Booking): string {
  if (b.mode === 'trip') return b.input.stops.join(' → ');
  if (b.mode === 'shared') return `Shared · ${b.input.corridorId}`;
  return `${b.input.from} → ${b.input.to}`;
}
function pax(b: Booking): number {
  if (b.mode === 'trip') return b.input.pax;
  if (b.mode === 'shared') return b.input.seats;
  return b.input.adults + b.input.children;
}
function travel(b: Booking): { date: string | null; time: string | null } {
  if (b.mode === 'trip') return { date: b.input.dates?.find(Boolean) ?? null, time: null };
  if (b.mode === 'shared') return { date: b.input.date, time: b.input.time };
  return { date: b.input.date ?? null, time: b.input.time ?? null };
}

export function toOpsRow(b: Booking, opts: { rideOps?: RideOps | null; paid: boolean }): OpsBookingRow {
  const t = travel(b);
  const c = b.input.customer;
  return {
    id: b.id, reference: b.reference, mode: b.mode, bookingStatus: b.status,
    paymentStatus: opts.paid ? 'paid' : 'unpaid', amount: b.total, currency: b.currency,
    customerFirstName: c.firstName, customerName: `${c.firstName} ${c.lastName}`.trim(),
    route: route(b), travelDate: t.date, travelTime: t.time, pax: pax(b),
    coordinatorId: opts.rideOps?.coordinatorId ?? null,
    fulfilmentStatus: opts.rideOps?.fulfilmentStatus ?? 'unassigned',
    vehiclePhotoReceived: opts.rideOps?.vehiclePhotoReceived ?? false,
    customerUpdated: opts.rideOps?.customerUpdated ?? false,
  };
}

export function manifestLine(b: Booking): string {
  const t = travel(b);
  const c = b.input.customer;
  return `• ${t.time ?? 'TBC'} — ${route(b)} — ${pax(b)} pax — ${c.firstName} (${b.reference})`;
}
```

- [ ] **Step 4: Run test to verify it passes** — `cd api && npx vitest run src/services/opsView.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/services/opsView.ts api/src/services/opsView.test.ts
git commit -m "ops: booking view-model + manifest line (no revenue)"
```

---

### Task 7: All Bookings + detail + mutations endpoints

**Files:**
- Modify: `api/src/routes/ops.ts` (add routes below the auth middleware)
- Test: `api/src/routes/ops.bookings.test.ts`

**Interfaces:**
- Consumes: `toOpsRow`, `manifestLine`, the repos, `PaymentRepo.findByBooking` (verify the method name in `paymentRepo.ts`; if it differs, use the existing accessor that returns a booking's payment(s)).
- Produces routes (all auth-gated; founder + support both allowed in Slice 1):
  - `GET /admin/ops/bookings?status=&mode=&date=&q=` → `OpsBookingRow[]`, newest-first; `q` matches reference/name/email.
  - `GET /admin/ops/bookings/:id` → `{ booking, ops, payments }`.
  - `POST /admin/ops/bookings/:id/assign` `{ coordinatorId|null }` → updated `RideOps`.
  - `POST /admin/ops/bookings/:id/status` `{ to }` → updated `RideOps` (400 on illegal transition).
  - `POST /admin/ops/bookings/:id/flags` `{ vehiclePhotoReceived?, customerUpdated?, opsNotes? }` → updated `RideOps`.

> **Implementation note for the executor:** before writing, open `api/src/db/bookingRepo.ts` and `api/src/db/paymentRepo.ts` to confirm the exact accessor names (`list`, `get`, and the payment-by-booking lookup). Use a payment with `status === 'succeeded'` to compute `paid`. If no payment-by-booking accessor exists, add a tiny `findByBookingId(bookingId): Promise<Payment[]>` to `PaymentRepo` (interface + InMemory + Postgres) as its own committed step before this task.

- [ ] **Step 1: Write the failing test** — `api/src/routes/ops.bookings.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../app';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryRideOpsRepo } from '../db/rideOpsRepo';
import { InMemoryCoordinatorRepo } from '../db/coordinatorRepo';

const auth = { opsSupportKey: 'sup', opsFounderKey: 'fou', opsSessionSecret: 'sek' };
const hdr = { 'x-admin-key': 'adminkey', 'content-type': 'application/json' }; // founder via header

async function seed(bookings: InMemoryBookingRepo) {
  return bookings.create({
    mode: 'single', total: 12100, currency: 'USD',
    input: { from: 'Colombo Airport', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 1,
      date: '2026-06-22', time: '09:00',
      customer: { firstName: 'Maya', lastName: 'Silva', email: 'm@x.com', whatsapp: '+34600', country: 'ES' } },
  });
}

describe('ops bookings endpoints', () => {
  let app: ReturnType<typeof createApp>; let bookings: InMemoryBookingRepo; let bid: string;
  beforeEach(async () => {
    bookings = new InMemoryBookingRepo();
    const rideOps = new InMemoryRideOpsRepo();
    const coordinators = new InMemoryCoordinatorRepo();
    app = createApp({ bookings, rideOps, coordinators, auth, adminApiKey: 'adminkey' });
    bid = (await seed(bookings)).id;
  });

  it('lists bookings as ops rows, searchable by reference', async () => {
    const res = await app.request('/admin/ops/bookings', { headers: hdr });
    const rows = await res.json();
    expect(rows).toHaveLength(1);
    expect(rows[0].route).toBe('Colombo Airport → Galle');
    expect(rows[0].fulfilmentStatus).toBe('unassigned');
  });

  it('assigns a coordinator and advances fulfilment to assigned', async () => {
    const res = await app.request(`/admin/ops/bookings/${bid}/assign`, {
      method: 'POST', headers: hdr, body: JSON.stringify({ coordinatorId: 'coord-1' }),
    });
    const ops = await res.json();
    expect(ops.coordinatorId).toBe('coord-1');
    expect(ops.fulfilmentStatus).toBe('assigned');
  });

  it('rejects an illegal status transition with 400', async () => {
    const res = await app.request(`/admin/ops/bookings/${bid}/status`, {
      method: 'POST', headers: hdr, body: JSON.stringify({ to: 'completed' }),
    });
    expect(res.status).toBe(400);
  });

  it('toggles flags', async () => {
    const res = await app.request(`/admin/ops/bookings/${bid}/flags`, {
      method: 'POST', headers: hdr, body: JSON.stringify({ vehiclePhotoReceived: true }),
    });
    expect((await res.json()).vehiclePhotoReceived).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `cd api && npx vitest run src/routes/ops.bookings.test.ts` → FAIL.

- [ ] **Step 3: Write minimal implementation** — add to `api/src/routes/ops.ts` (after `whoami`):

```ts
  r.get('/bookings', async (c) => {
    const status = c.req.query('status'); const mode = c.req.query('mode');
    const date = c.req.query('date'); const q = (c.req.query('q') ?? '').toLowerCase();
    const all = await deps.bookings.list(status ? { status: status as never } : undefined);
    const ops = await deps.rideOps.listByBookingIds(all.map((b) => b.id));
    const opsById = new Map(ops.map((o) => [o.bookingId, o]));
    const rows = [];
    for (const b of all) {
      if (mode && b.mode !== mode) continue;
      const paid = (await deps.payments.findByBookingId(b.id)).some((p) => p.status === 'succeeded');
      const row = toOpsRow(b, { rideOps: opsById.get(b.id) ?? null, paid });
      if (date && row.travelDate !== date) continue;
      if (q && !(`${row.reference} ${row.customerName} ${b.input.customer.email}`.toLowerCase().includes(q))) continue;
      rows.push(row);
    }
    rows.reverse(); // newest-first (list() returns insertion order)
    return c.json(rows);
  });

  r.get('/bookings/:id', async (c) => {
    const b = await deps.bookings.get(c.req.param('id'));
    if (!b) return c.json({ error: 'not_found' }, 404);
    const ops = await deps.rideOps.getOrCreate(b.id);
    const payments = await deps.payments.findByBookingId(b.id);
    return c.json({ booking: b, ops, payments });
  });

  r.post('/bookings/:id/assign', async (c) => {
    const body = z.object({ coordinatorId: z.string().nullable() }).parse(await c.req.json());
    return c.json(await deps.rideOps.assign(c.req.param('id'), body.coordinatorId));
  });

  r.post('/bookings/:id/status', async (c) => {
    const body = z.object({ to: z.string() }).parse(await c.req.json());
    try {
      return c.json(await deps.rideOps.setStatus(c.req.param('id'), body.to as never));
    } catch {
      return c.json({ error: 'illegal_transition' }, 400);
    }
  });

  r.post('/bookings/:id/flags', async (c) => {
    const body = z.object({
      vehiclePhotoReceived: z.boolean().optional(),
      customerUpdated: z.boolean().optional(),
      opsNotes: z.string().nullable().optional(),
    }).parse(await c.req.json());
    return c.json(await deps.rideOps.setFlags(c.req.param('id'), body));
  });
```

Add the imports at the top of `ops.ts`: `import { toOpsRow } from '../services/opsView';`. (The executor adds `PaymentRepo.findByBookingId` per the implementation note if missing.)

- [ ] **Step 4: Run test to verify it passes** — `cd api && npx vitest run src/routes/ops.bookings.test.ts` → PASS. Then `npm run check`.

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/ops.ts api/src/routes/ops.bookings.test.ts api/src/db/paymentRepo.ts
git commit -m "ops: bookings list/detail + assign/status/flags endpoints"
```

---

### Task 8: Daily rides + coordinator CRUD + manifest

**Files:**
- Modify: `api/src/routes/ops.ts`
- Test: `api/src/routes/ops.daily.test.ts`

**Interfaces:**
- Produces:
  - `GET /admin/ops/rides?date=today|tomorrow|YYYY-MM-DD` → `{ date, rows: OpsBookingRow[] }` filtered to that travel date (shared rows carry corridor+time so the UI can group).
  - `GET /admin/ops/coordinators` / `POST /admin/ops/coordinators` `{ name, whatsapp, regions? }`.
  - `GET /admin/ops/manifest?coordinatorId=&date=` → `{ text }` (assigned rides for that coordinator+date, via `manifestLine`).
  - `POST /admin/ops/manifest/sent` `{ coordinatorId, date }` → advances each matching ride `assigned → sent_to_coordinator`.

Resolve `today`/`tomorrow` from a passed-in clock to keep tests deterministic: accept an explicit `YYYY-MM-DD` in tests; compute relative dates with `new Date()` only in the route (document that tests pass explicit dates).

- [ ] **Step 1: Write the failing test** — `api/src/routes/ops.daily.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../app';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryRideOpsRepo } from '../db/rideOpsRepo';
import { InMemoryCoordinatorRepo } from '../db/coordinatorRepo';

const auth = { opsSupportKey: 'sup', opsFounderKey: 'fou', opsSessionSecret: 'sek' };
const hdr = { 'x-admin-key': 'adminkey', 'content-type': 'application/json' };

describe('daily rides, coordinators, manifest', () => {
  let app: ReturnType<typeof createApp>; let bookings: InMemoryBookingRepo; let rideOps: InMemoryRideOpsRepo; let bid: string;
  beforeEach(async () => {
    bookings = new InMemoryBookingRepo(); rideOps = new InMemoryRideOpsRepo();
    app = createApp({ bookings, rideOps, coordinators: new InMemoryCoordinatorRepo(), auth, adminApiKey: 'adminkey' });
    bid = (await bookings.create({
      mode: 'single', total: 9000, currency: 'USD',
      input: { from: 'Galle', to: 'Mirissa', vehicleType: 'car', adults: 2, children: 0, bags: 0,
        date: '2026-06-25', time: '08:00',
        customer: { firstName: 'Sam', lastName: 'P', email: 's@x.com', whatsapp: '+1', country: 'US' } },
    })).id;
  });

  it('returns rides for a given travel date', async () => {
    const res = await app.request('/admin/ops/rides?date=2026-06-25', { headers: hdr });
    const body = await res.json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].route).toBe('Galle → Mirissa');
  });

  it('creates a coordinator and generates a manifest for assigned rides', async () => {
    const coord = await (await app.request('/admin/ops/coordinators', {
      method: 'POST', headers: hdr, body: JSON.stringify({ name: 'Nuwan', whatsapp: '+94770' }),
    })).json();
    await app.request(`/admin/ops/bookings/${bid}/assign`, { method: 'POST', headers: hdr, body: JSON.stringify({ coordinatorId: coord.id }) });
    const man = await (await app.request(`/admin/ops/manifest?coordinatorId=${coord.id}&date=2026-06-25`, { headers: hdr })).json();
    expect(man.text).toContain('Galle → Mirissa');
    expect(man.text).toContain('CH-');
    expect(man.text).not.toMatch(/\$|9000|USD/);
  });

  it('mark-sent advances assigned rides to sent_to_coordinator', async () => {
    const coord = await (await app.request('/admin/ops/coordinators', {
      method: 'POST', headers: hdr, body: JSON.stringify({ name: 'N', whatsapp: '+9' }),
    })).json();
    await app.request(`/admin/ops/bookings/${bid}/assign`, { method: 'POST', headers: hdr, body: JSON.stringify({ coordinatorId: coord.id }) });
    await app.request('/admin/ops/manifest/sent', { method: 'POST', headers: hdr, body: JSON.stringify({ coordinatorId: coord.id, date: '2026-06-25' }) });
    expect((await rideOps.get(bid))?.fulfilmentStatus).toBe('sent_to_coordinator');
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `cd api && npx vitest run src/routes/ops.daily.test.ts` → FAIL.

- [ ] **Step 3: Write minimal implementation** — add to `api/src/routes/ops.ts`:

```ts
import { manifestLine } from '../services/opsView'; // add to existing import line

  function resolveDate(q: string | undefined): string {
    if (q === 'today' || !q) return new Date().toISOString().slice(0, 10);
    if (q === 'tomorrow') { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); }
    return q;
  }

  async function rowsForDate(date: string) {
    const all = await deps.bookings.list();
    const ops = await deps.rideOps.listByBookingIds(all.map((b) => b.id));
    const opsById = new Map(ops.map((o) => [o.bookingId, o]));
    const out = [];
    for (const b of all) {
      const paid = (await deps.payments.findByBookingId(b.id)).some((p) => p.status === 'succeeded');
      const row = toOpsRow(b, { rideOps: opsById.get(b.id) ?? null, paid });
      if (row.travelDate === date) out.push({ b, row });
    }
    return out;
  }

  r.get('/rides', async (c) => {
    const date = resolveDate(c.req.query('date'));
    const rows = (await rowsForDate(date)).map((x) => x.row);
    return c.json({ date, rows });
  });

  r.get('/coordinators', async (c) => c.json(await deps.coordinators.list()));
  r.post('/coordinators', async (c) => {
    const body = z.object({ name: z.string().min(1), whatsapp: z.string().min(1), regions: z.string().optional() }).parse(await c.req.json());
    return c.json(await deps.coordinators.create(body), 201);
  });

  r.get('/manifest', async (c) => {
    const coordinatorId = c.req.query('coordinatorId'); const date = resolveDate(c.req.query('date'));
    const mine = (await rowsForDate(date)).filter((x) => x.row.coordinatorId === coordinatorId);
    const coord = coordinatorId ? await deps.coordinators.get(coordinatorId) : null;
    const header = `Ceylon Hop — ${date}${coord ? ` — ${coord.name}` : ''}\n`;
    const text = header + (mine.length ? mine.map((x) => manifestLine(x.b)).join('\n') : '(no rides assigned)');
    return c.json({ text });
  });

  r.post('/manifest/sent', async (c) => {
    const body = z.object({ coordinatorId: z.string(), date: z.string() }).parse(await c.req.json());
    const mine = (await rowsForDate(resolveDate(body.date))).filter((x) => x.row.coordinatorId === body.coordinatorId);
    let sent = 0;
    for (const x of mine) {
      if (x.row.fulfilmentStatus === 'assigned') { await deps.rideOps.setStatus(x.b.id, 'sent_to_coordinator'); sent++; }
    }
    return c.json({ sent });
  });
```

- [ ] **Step 4: Run test to verify it passes** — `cd api && npx vitest run src/routes/ops.daily.test.ts` → PASS. Then `npm run check`.

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/ops.ts api/src/routes/ops.daily.test.ts
git commit -m "ops: daily rides, coordinator CRUD, WhatsApp manifest + mark-sent"
```

---

### Task 9: Founder-only gate (reserved finance endpoint returns 403 for support)

**Files:**
- Modify: `api/src/routes/ops.ts` (add a `requireFounder` helper + a stub `GET /admin/ops/finance/summary` that only proves the gate)
- Test: `api/src/routes/ops.roles.test.ts`

**Interfaces:**
- Produces: `GET /admin/ops/finance/summary` → `403` for `support`, `200 { ok: true }` for `founder`. (Real finance content is a later slice; this locks the boundary now.)

- [ ] **Step 1: Write the failing test** — `api/src/routes/ops.roles.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { createApp } from '../app';

const auth = { opsSupportKey: 'sup', opsFounderKey: 'fou', opsSessionSecret: 'sek' };

async function sessionCookie(app: ReturnType<typeof createApp>, key: string) {
  const res = await app.request('/admin/ops/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }),
  });
  return res.headers.get('set-cookie')!.split(';')[0];
}

describe('founder gate', () => {
  it('blocks support from the finance endpoint, allows founder', async () => {
    const app = createApp({ auth, adminApiKey: 'adminkey' });
    const support = await sessionCookie(app, 'sup');
    const founder = await sessionCookie(app, 'fou');
    expect((await app.request('/admin/ops/finance/summary', { headers: { cookie: support } })).status).toBe(403);
    expect((await app.request('/admin/ops/finance/summary', { headers: { cookie: founder } })).status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `cd api && npx vitest run src/routes/ops.roles.test.ts` → FAIL.

- [ ] **Step 3: Write minimal implementation** — add to `api/src/routes/ops.ts`:

```ts
  const requireFounder = (c: { get: (k: 'role') => OpsRole; json: (b: unknown, s?: number) => Response }) =>
    c.get('role') === 'founder' ? null : c.json({ error: 'forbidden' }, 403);

  r.get('/finance/summary', (c) => {
    const blocked = requireFounder(c); if (blocked) return blocked;
    return c.json({ ok: true }); // real finance content lands in the finance slice
  });
```

- [ ] **Step 4: Run test to verify it passes** — `cd api && npx vitest run src/routes/ops.roles.test.ts` → PASS. Then `npm run check`.

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/ops.ts api/src/routes/ops.roles.test.ts
git commit -m "ops: founder-only role gate on reserved finance endpoint"
```

---

### Task 10: Postgres persistence + migration 0007 + server wiring

**Files:**
- Modify: `api/src/db/schema.ts` (add `coordinators`, `ride_ops` tables)
- Create: `api/src/db/postgresCoordinatorRepo.ts`, `api/src/db/postgresRideOpsRepo.ts`
- Create: the migration under the existing migrations dir (e.g. `api/drizzle/0007_ops_layer.sql`) + update the snapshot/journal the same way 0004–0006 were done (follow the existing files exactly)
- Modify: `api/src/server.ts` (instantiate the Postgres ops repos + pass `auth` keys from `config`)
- Test: extend the existing Postgres integration test pattern (the repo tests that run against `DATABASE_URL_TEST` in CI)

**Interfaces:**
- Produces: `class PostgresCoordinatorRepo implements CoordinatorRepo`, `class PostgresRideOpsRepo implements RideOpsRepo` — same interfaces as Tasks 2–3, so routes are unchanged.

> **Implementation note:** mirror `postgresBookingRepo.ts` / `postgresDepartureRepo.ts` for Drizzle usage and the integration-test style (the suite skips when `DATABASE_URL_TEST` is unset — that's why `npm run check` shows skipped tests locally). Tables:
> - `coordinators(id uuid pk, name text, whatsapp text, regions text default '', active boolean default true, created_at timestamptz default now())`
> - `ride_ops(booking_id uuid pk references bookings(id), coordinator_id uuid null references coordinators(id), fulfilment_status text not null default 'unassigned', vehicle_photo_received boolean not null default false, customer_updated boolean not null default false, ops_notes text, assigned_at timestamptz, sent_at timestamptz, acknowledged_at timestamptz, vehicle_confirmed_at timestamptz, updated_at timestamptz not null default now())`

- [ ] **Step 1: Add the schema** (Drizzle table defs in `schema.ts`) — no test yet.
- [ ] **Step 2: Write the migration SQL** (`0007_ops_layer.sql`) + snapshot/journal exactly like 0006.
- [ ] **Step 3: Write the Postgres repos** (`PostgresCoordinatorRepo`, `PostgresRideOpsRepo`) implementing the Task 2–3 interfaces.
- [ ] **Step 4: Write integration tests** mirroring an existing `postgres*Repo.test.ts` (assign → status → flags round-trip; created-coordinator read-back). They run in CI with an ephemeral Postgres.
- [ ] **Step 5: Apply locally** — `cd api && npm run migrate` against the test/dev DB; run `npm run check`.
- [ ] **Step 6: Wire `server.ts`** — instantiate the Postgres ops repos and pass them + `config.OPS_*` into `createApp`.
- [ ] **Step 7: Run `npm run check` and `npm run smoke`** → green.
- [ ] **Step 8: Commit**

```bash
git add api/src/db/schema.ts api/drizzle/ api/src/db/postgresCoordinatorRepo.ts api/src/db/postgresRideOpsRepo.ts api/src/server.ts api/src/db/*.test.ts
git commit -m "ops: postgres persistence + migration 0007 + server wiring"
```

---

## Self-Review

**Spec coverage:**
- All Bookings (all modes, payment status, search/filter) → Task 7 (`GET /bookings`) + Task 6 view-model. ✅
- Daily Control Tower (today/tomorrow, shared grouping data) → Task 8 (`GET /rides`). ✅
- Ops-layer data model (coordinators, ride_ops) → Tasks 2,3,10. ✅
- Coordinator assignment → Task 7 (`/assign`). ✅
- WhatsApp manifest + mark sent → Task 8. ✅
- Two-axis status (booking read-only; ride fulfilment guarded) → Tasks 1,3. ✅
- Booking detail → Task 7 (`GET /bookings/:id`). ✅
- Auth + role boundary (support/founder, revenue founder-gated) → Tasks 4,5,9. ✅
- No-revenue-leak on ops surfaces → Task 6 test + Task 8 manifest test. ✅
- Read-only website model (never mutated) → enforced by design; ops writes only `coordinators`/`ride_ops`. ✅
- UI (`/ops` served app) → **deliberately deferred to Plan 2 (UI)**. ✅

**Placeholder scan:** Task 10's migration/Postgres steps reference "mirror the existing files" rather than inlining the full Drizzle/SQL — this is intentional (the executor must match the repo's exact migration journal format, which only exists in-repo). Two flagged executor checks: confirm the `PaymentRepo` payment-by-booking accessor name (Task 7 note) and match the migration journal format (Task 10 note). No vague "add error handling" steps.

**Type consistency:** `RideStatus`, `RideOps`, `Coordinator`, `OpsBookingRow`, `OpsRole`, and the repo method names (`getOrCreate`/`assign`/`setStatus`/`setFlags`/`listByBookingIds`) are used consistently across Tasks 1–10. The one external dependency to verify is `PaymentRepo.findByBookingId` (flagged in Task 7).

## Execution Handoff

Plan 1 (Backend) covers the API. **Plan 2 (UI)** — the served `/ops` app (login screen, All Bookings, Daily Control Tower, booking detail, coordinator + manifest UI) — will be written after the backend is green.
