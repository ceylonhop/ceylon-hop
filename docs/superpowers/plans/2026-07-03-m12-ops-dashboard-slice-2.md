# M12 Slice 2 — Ops Dashboard Reshape + Wire-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reshape the deployed coordinator-centric ops backend to the agreed post-payment fulfilment model, then serve the "Control Tower" ops UI at `/ops` wired to the live `/admin/ops` API with a real login screen.

**Architecture:** The ops layer stays inside `api/` (Hono + Drizzle + Postgres). The fulfilment lifecycle simplifies to `paid → vehicle_confirmed → pickup_confirmed → on_trip → completed`; `awaiting_payment` is not a ride status — it is the view of a booking whose `status = 'payment_pending'`. Coordinator endpoints/repos are deleted (the `coordinators` DB table stays dormant — no destructive drop). The UI is a single self-contained HTML file served by the API (same pattern as the quote tool at `src/routes/quote-tool.html`), same-origin with the JSON endpoints so the session cookie just works.

**Tech Stack:** Node 20 · TypeScript strict · Hono · Zod · Vitest · Drizzle + Postgres (Supabase) · vanilla JS UI (no framework).

**Spec:** `docs/ops-dashboard-status.md` (canonical model, §1 and §3). Design decisions there are settled — do not re-litigate.

## Global Constraints

- One task = one branch = one PR (CLAUDE.md rule 1). Branch names: `m12s2-<n>-<slug>`.
- Tests first: write failing test, run to see RED, implement, see GREEN. Paste red→green evidence in the PR.
- Backend lives in `api/` only. NEVER touch root frozen front-end files (`*.html` at root, `site.css`, front-end `*.js`). The ops UI file lives at `api/src/routes/ops-ui.html` — inside `api/`, allowed.
- No real external services; adapters + fakes only.
- `cd api && npm run check` must be green before opening a PR.
- Money is integer minor units. IDs are uuid. Do not substitute stack pieces.
- Stage colour semantics (UI): stage colour = where it is; RED only for the action still needed. Never colour a positive state red.

---

### Task 1: Add `channel` to bookings

**Files:**
- Modify: `api/src/db/schema.ts` (bookings table, ~line 14–29)
- Create: `api/drizzle/0011_booking_channel.sql`
- Modify: `api/src/db/bookingRepo.ts` (Booking + NewBooking types, in-memory repo)
- Modify: `api/src/db/postgresBookingRepo.ts` (insert + row mapping)
- Modify: `api/src/services/opsView.ts` (OpsBookingRow gains `channel`)
- Test: extend `api/src/db/bookingRepo.test.ts` (or wherever the booking repo contract tests live), `api/src/services/opsView.test.ts`

**Interfaces:**
- Consumes: existing `BookingRepo.create(b: NewBooking)`, `toOpsRow(b, opts)`.
- Produces: `Booking.channel: 'website' | 'whatsapp'` (always present), `NewBooking.channel?: 'website' | 'whatsapp'` (defaults `'website'`), `OpsBookingRow.channel`. Task 3 and Task 4 rely on `channel` being on every ops row.

- [ ] **Step 1: Write the failing tests**

In the booking repo contract test file (the one that runs against both in-memory and Postgres fakes — follow the existing pattern in `bookingRepo.test.ts`):

```typescript
it('defaults channel to website', async () => {
  const b = await repo.create(newBookingFixture());
  expect(b.channel).toBe('website');
});

it('persists an explicit whatsapp channel', async () => {
  const b = await repo.create({ ...newBookingFixture(), channel: 'whatsapp' });
  expect(b.channel).toBe('whatsapp');
});
```

In `opsView.test.ts`:

```typescript
it('exposes booking channel on the ops row', () => {
  const row = toOpsRow(bookingFixture({ channel: 'whatsapp' }), { paid: true });
  expect(row.channel).toBe('whatsapp');
});
```

Use the existing fixture helpers in those files; add `channel` to the fixture type as needed.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && npx vitest run src/db/bookingRepo.test.ts src/services/opsView.test.ts`
Expected: FAIL — `channel` does not exist on type / undefined.

- [ ] **Step 3: Implement**

`api/src/db/schema.ts` — add to `bookings`:

```typescript
channel: text('channel').notNull().default('website'),
```

`api/drizzle/0011_booking_channel.sql`:

```sql
ALTER TABLE "bookings" ADD COLUMN "channel" text DEFAULT 'website' NOT NULL;
```

(Generate via `npm run db:generate` if it produces the same statement; otherwise hand-write with this exact content and register it in the drizzle journal the same way 0010 is registered.)

`api/src/db/bookingRepo.ts`:

```typescript
export type BookingChannel = 'website' | 'whatsapp';
// Booking gains:  channel: BookingChannel;
// NewBooking gains:  channel?: BookingChannel;
```

In-memory repo `create`: `channel: b.channel ?? 'website'`.

`api/src/db/postgresBookingRepo.ts`: include `channel: b.channel ?? 'website'` in the bookings insert; include `channel` in the row→Booking mapping (both in `get` and `list` paths).

`api/src/services/opsView.ts` — `OpsBookingRow` gains `channel: 'website' | 'whatsapp'`; `toOpsRow` copies `b.channel`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && npm run check`
Expected: PASS, everything green.

- [ ] **Step 5: Commit + PR**

```bash
git checkout -b m12s2-1-booking-channel
git add api/
git commit -m "feat(ops): add channel column to bookings (website|whatsapp)"
gh pr create --title "M12S2-1: bookings.channel" --body "<red→green evidence>"
```

---

### Task 2: Simplify the ride fulfilment status machine

**Files:**
- Modify: `api/src/domain/rideStatus.ts` (full rewrite)
- Create: `api/drizzle/0012_ops_fulfilment_reshape.sql`
- Modify: `api/src/db/schema.ts` (`ride_ops.fulfilment_status` default → `'paid'`)
- Modify: `api/src/db/rideOpsRepo.ts` (drop `assign`, default status)
- Modify: `api/src/db/postgresRideOpsRepo.ts` (same; timestamp writes)
- Test: `api/src/domain/rideStatus.test.ts` (if none exists, create), `api/src/db/rideOpsRepo.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `RIDE_STATUSES = ['paid','vehicle_confirmed','pickup_confirmed','on_trip','completed']`, `canRideTransition(from, to)`, `assertRideTransition(from, to)`. `RideOpsRepo` loses `assign()`; `RideOps` loses `coordinatorId` from the type (column stays in DB, unread). `getOrCreate` creates rows at `'paid'`. Task 3 relies on these exact status strings.

- [ ] **Step 1: Write the failing tests**

`rideStatus.test.ts`:

```typescript
import { RIDE_STATUSES, canRideTransition } from './rideStatus';

it('has the fulfilment lifecycle statuses', () => {
  expect(RIDE_STATUSES).toEqual(['paid', 'vehicle_confirmed', 'pickup_confirmed', 'on_trip', 'completed']);
});

it('allows the forward path', () => {
  expect(canRideTransition('paid', 'vehicle_confirmed')).toBe(true);
  expect(canRideTransition('vehicle_confirmed', 'pickup_confirmed')).toBe(true);
  expect(canRideTransition('pickup_confirmed', 'on_trip')).toBe(true);
  expect(canRideTransition('on_trip', 'completed')).toBe(true);
});

it('allows single-step backtracks except from completed', () => {
  expect(canRideTransition('vehicle_confirmed', 'paid')).toBe(true);
  expect(canRideTransition('pickup_confirmed', 'vehicle_confirmed')).toBe(true);
  expect(canRideTransition('on_trip', 'pickup_confirmed')).toBe(true);
  expect(canRideTransition('completed', 'on_trip')).toBe(false);
});

it('rejects skips and old statuses', () => {
  expect(canRideTransition('paid', 'on_trip')).toBe(false);
  // @ts-expect-error old status removed
  expect(canRideTransition('assigned', 'vehicle_confirmed')).toBe(false);
});
```

`rideOpsRepo.test.ts`: update existing tests — `getOrCreate` yields `fulfilmentStatus: 'paid'`; `setStatus` walks the new path and stamps `vehicleConfirmedAt` when entering `vehicle_confirmed`; all `assign`/coordinator tests deleted.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && npx vitest run src/domain/rideStatus.test.ts src/db/rideOpsRepo.test.ts`
Expected: FAIL — old statuses still present.

- [ ] **Step 3: Implement**

`api/src/domain/rideStatus.ts` (complete new contents):

```typescript
export const RIDE_STATUSES = [
  'paid',
  'vehicle_confirmed',
  'pickup_confirmed',
  'on_trip',
  'completed',
] as const;

export type RideStatus = (typeof RIDE_STATUSES)[number];

// Forward path plus single-step operational backtracks (completed is terminal).
const ALLOWED: Record<RideStatus, RideStatus[]> = {
  paid: ['vehicle_confirmed'],
  vehicle_confirmed: ['pickup_confirmed', 'paid'],
  pickup_confirmed: ['on_trip', 'vehicle_confirmed'],
  on_trip: ['completed', 'pickup_confirmed'],
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

`api/drizzle/0012_ops_fulfilment_reshape.sql`:

```sql
ALTER TABLE "ride_ops" ALTER COLUMN "fulfilment_status" SET DEFAULT 'paid';
--> statement-breakpoint
UPDATE "ride_ops" SET "fulfilment_status" = CASE "fulfilment_status"
  WHEN 'unassigned' THEN 'paid'
  WHEN 'assigned' THEN 'paid'
  WHEN 'sent_to_coordinator' THEN 'paid'
  WHEN 'acknowledged' THEN 'paid'
  WHEN 'customer_updated' THEN 'pickup_confirmed'
  ELSE "fulfilment_status" END;
```

(Register in the drizzle journal like previous migrations. The `coordinator_id`, `assigned_at`, `sent_at`, `acknowledged_at` columns stay in the DB, dormant — no drop.)

`api/src/db/schema.ts`: `fulfilmentStatus: text('fulfilment_status').notNull().default('paid'),`

`api/src/db/rideOpsRepo.ts`: delete `assign()` from the interface and the in-memory repo; delete `coordinatorId`, `assignedAt`, `sentAt`, `acknowledgedAt` from the `RideOps` type; in-memory `getOrCreate` creates at `'paid'`.

`api/src/db/postgresRideOpsRepo.ts`: delete `assign`; `setStatus` keeps `assertRideTransition` and stamps `vehicle_confirmed_at` when target is `vehicle_confirmed`; stop writing `sent_at`/`acknowledged_at`; row mapping drops the removed fields.

- [ ] **Step 4: Run full check** — `cd api && npm run check`. Expected: only failures left are in `ops.ts` routes still calling `assign`/coordinators — if so, minimal stub removals belong to Task 3; if the compile breaks here, move the route deletions forward into this task's branch ONLY as far as needed to compile, and note it in the PR. (In practice Task 2 + Task 3 may need to ship as one PR if the compiler forces it — acceptable, note in PR body.)

- [ ] **Step 5: Commit + PR**

```bash
git checkout -b m12s2-2-fulfilment-machine
git add api/
git commit -m "feat(ops): simplify fulfilment lifecycle to paid→vehicle→pickup→on_trip→completed"
gh pr create --title "M12S2-2: fulfilment status machine reshape" --body "<red→green evidence>"
```

---

### Task 3: Reshape ops routes + view model (drop coordinators, unified queue)

**Files:**
- Modify: `api/src/routes/ops.ts` (delete coordinator routes; reshape list)
- Modify: `api/src/services/opsView.ts` (row shape)
- Modify: `api/src/db/bookingRepo.ts` + `api/src/db/postgresBookingRepo.ts` (`list` accepts status array)
- Delete: `api/src/db/coordinatorRepo.ts`, `api/src/db/postgresCoordinatorRepo.ts`, `api/src/db/coordinatorRepo.test.ts`
- Modify: `api/src/app.ts` (ops deps no longer take a coordinator repo)
- Test: `api/src/routes/ops.bookings.test.ts`, `ops.test.ts`, `ops.daily.test.ts` (delete daily/manifest/coordinator suites), `opsView.test.ts`

**Interfaces:**
- Consumes: Task 1 `channel`, Task 2 statuses.
- Produces:
  - `BookingRepo.list(filter?: { status?: BookingStatus | BookingStatus[] })`.
  - `OpsBookingRow` (final shape — Task 4 consumes this verbatim):

```typescript
export interface OpsBookingRow {
  id: string;
  reference: string;
  mode: string;
  channel: 'website' | 'whatsapp';
  bookingStatus: string;
  stage: 'awaiting_payment' | 'paid' | 'vehicle_confirmed' | 'pickup_confirmed' | 'on_trip' | 'completed';
  paymentStatus: 'paid' | 'unpaid';
  amount: number;            // minor units
  currency: string;
  customerFirstName: string;
  customerName: string;
  route: string;
  travelDate: string | null;
  travelTime: string | null;
  pax: number;
  vehiclePhotoReceived: boolean;
  customerUpdated: boolean;
  opsNotes: string | null;
}
```

  - Surviving routes: `POST /login`, `POST /logout`, `GET /whoami`, `GET /finance/summary` (founder), `GET /bookings`, `GET /bookings/:id`, `POST /bookings/:id/status`, `POST /bookings/:id/flags`. Everything else under `/admin/ops` is gone.
  - `stage` rule: `bookingStatus === 'payment_pending'` → `'awaiting_payment'`; else the `ride_ops.fulfilmentStatus` (rows without ride_ops → `'paid'`).
  - `GET /bookings` default (no query): bookings with `status IN ('payment_pending','paid')`, ordered by `travelDate` ascending, nulls last. Query params kept: `q` (search), `stage` (exact stage filter), `date` (exact travel date).

- [ ] **Step 1: Write the failing tests**

In `ops.bookings.test.ts` (using the existing `createApp(deps)` + fake-repo pattern and an authed session cookie helper already present in these files):

```typescript
it('lists payment_pending and paid bookings as the ops queue, ordered by travel date', async () => {
  await seedBooking({ status: 'paid', travelDate: '2026-07-10' });
  await seedBooking({ status: 'payment_pending', travelDate: '2026-07-05' });
  await seedBooking({ status: 'draft' });      // excluded
  await seedBooking({ status: 'completed' });  // excluded (booking-level)
  const res = await authedGet('/admin/ops/bookings');
  const rows = await res.json();
  expect(rows).toHaveLength(2);
  expect(rows[0].travelDate).toBe('2026-07-05');
  expect(rows[0].stage).toBe('awaiting_payment');
  expect(rows[1].stage).toBe('paid');
  expect(rows[0].channel).toBe('website');
});

it('reflects ride_ops fulfilment as stage for paid bookings', async () => {
  const b = await seedBooking({ status: 'paid' });
  await rideOps.getOrCreate(b.id);
  await rideOps.setStatus(b.id, 'vehicle_confirmed');
  const res = await authedGet('/admin/ops/bookings');
  const rows = await res.json();
  expect(rows.find((r) => r.id === b.id).stage).toBe('vehicle_confirmed');
});

it('advances stage via POST /bookings/:id/status with the new machine', async () => {
  const b = await seedBooking({ status: 'paid' });
  const res = await authedPost(`/admin/ops/bookings/${b.id}/status`, { to: 'vehicle_confirmed' });
  expect(res.status).toBe(200);
  const bad = await authedPost(`/admin/ops/bookings/${b.id}/status`, { to: 'completed' });
  expect(bad.status).toBe(400);
});

it('has no coordinator, manifest, or rides routes', async () => {
  for (const path of ['/admin/ops/coordinators', '/admin/ops/manifest', '/admin/ops/rides']) {
    expect((await authedGet(path)).status).toBe(404);
  }
});
```

Adapt `seedBooking`/`authedGet`/`authedPost` to the helpers that already exist in these test files — do not invent a parallel harness.

- [ ] **Step 2: Run to verify failures** — `npx vitest run src/routes/ops.bookings.test.ts`. Expected: FAIL (old routes exist, no `stage` field).

- [ ] **Step 3: Implement**

- `bookingRepo.list`: accept `status?: BookingStatus | BookingStatus[]`; Postgres uses `inArray(bookings.status, list)`; in-memory filters by inclusion.
- `opsView.ts`: reshape `OpsBookingRow` to the interface above; `toOpsRow(b, { rideOps, paid })` computes `stage` per the rule; delete `coordinatorId`; keep `manifestLine` deleted along with manifest route.
- `ops.ts`: delete `assign`, `coordinators` (GET/POST), `manifest`, `manifest/sent`, `rides` routes and their imports; list handler queries `['payment_pending','paid']`, joins ride_ops via `listByBookingIds`, sorts by travelDate (nulls last), applies `q`/`stage`/`date` filters in the service layer.
- `app.ts`: drop the coordinator repo from ops deps + `createApp` deps; delete the repo files and their tests.

- [ ] **Step 4: Full check** — `cd api && npm run check`. Expected: green, no references to coordinators anywhere (`grep -ri coordinator api/src` → empty).

- [ ] **Step 5: Commit + PR**

```bash
git checkout -b m12s2-3-ops-routes-reshape
git add -A api/
git commit -m "feat(ops): unified post-payment queue; remove coordinator layer from API"
gh pr create --title "M12S2-3: ops routes + view reshape" --body "<red→green evidence>"
```

---

### Task 4: Serve the Control Tower UI at `/ops`, wired to the live API

**Files:**
- Create: `api/src/routes/ops-ui.html` (adapted from repo-root `_ops-preview.html` — READ THAT FILE FIRST; it is the design source of truth)
- Modify: `api/src/app.ts` (mount `GET /ops`)
- Create: `api/src/routes/opsUi.ts`
- Test: `api/src/routes/opsUi.test.ts`

**Interfaces:**
- Consumes: Task 3's `OpsBookingRow`, routes, and the `ch_ops` cookie session.
- Produces: `GET /ops` → the HTML app (no auth to fetch the shell; all data behind session).

**UI adaptation spec** (base = `_ops-preview.html`, keep the entire "Control Tower" design system — fonts, espresso rail, colour spines, stepper, motion, `prefers-reduced-motion`):

1. **Delete** mock arrays `team`, `coordinators`, `templates` (keep only the `payreminder` template text as a constant), `ME`, all `owner`/coordinator/manifest/schedule/templates code: `viewSchedule`, `viewCoordinators`, `viewTemplates`, `setCoordModal`, `manifestModal`, dispatch cases `setcoord`, `pickcoord`, `manifest`, `newcoord`, `tpl`, `copytpl`, `watpl`, `copymanifest`, and the `.owner` CSS.
2. **Login screen**: full-viewport overlay in the same design language (espresso backdrop, Newsreader heading "Ceylon Hop — Ops", single key input + "Sign in" button). Flow: on load `GET /admin/ops/whoami` → 200 hides overlay and boots the app; 401 shows overlay. Submit → `POST /admin/ops/login {key}` → 200 boots; 401 shakes + "Wrong key". Rail foot shows the returned role (`founder`/`support`) with a Logout action → `POST /admin/ops/logout` → back to overlay.
3. **API client** (replace mock mutations — same-origin `fetch`, always `credentials:'same-origin'`):

```javascript
const api = {
  async get(p){ const r = await fetch('/admin/ops'+p); if(r.status===401){showLogin();throw new Error('auth');} return r.json(); },
  async post(p,body){ const r = await fetch('/admin/ops'+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body??{})}); if(r.status===401){showLogin();throw new Error('auth');} if(!r.ok) throw new Error('api '+r.status); return r.json(); },
};
async function loadQueue(){ const rows = await api.get('/bookings'); tickets = rows.map(rowToTicket); render(); }
```

4. **Row mapping** (`rowToTicket`): `reference→ref`, `channel==='whatsapp'?'wa':'web'→chan`, `customerName→cust`, `mode`, `route` (single string; render it in the row where `from → to` was shown), `travelDate→date`, `travelTime→time`, `pax→guests`, `amount/100→value` with `currency`, `stage→stage`, `vehiclePhotoReceived→photo`, `customerUpdated→updated`, `opsNotes` split on `\n` → notes list. Detail slide-over fetches `GET /bookings/:id` for `{booking, ops, payments}`; multi-leg table renders from the booking's trip legs when `mode==='trip'`; Payment section renders read-only from `payments` + `amount`.
5. **Actions**: advance → `POST /bookings/:id/status {to: NEXT[stage]}` (the `NEXT` map now only covers `paid→vehicle_confirmed→pickup_confirmed→on_trip→completed`); **no advance button on `awaiting_payment`** — show the "Payment link sent — follow up" reason and a "Copy payment reminder" action (copies the `payreminder` template text with the customer name and amount interpolated). Toggles → `POST /bookings/:id/flags {vehiclePhotoReceived|customerUpdated}`. Add note → append `[{today} {HH:MM}] {text}` line to existing `opsNotes` and `POST /flags {opsNotes}`. After every mutation, re-fetch the row (or splice the returned `RideOps` in) and re-render; keep the toast + motion behaviour.
6. **Grouping/facets stay as-is** (Pending/Today/Tomorrow/Upcoming/Completed via `travelDate` vs today's date computed client-side; facet definitions unchanged). Activity section renders: booking created (from `createdAt`), payment events (from `payments`), stage timestamps (`vehicleConfirmedAt`, `updatedAt`), then note lines.

`api/src/routes/opsUi.ts` (complete, mirrors the quote-tool pattern):

```typescript
import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let cachedHtml: string | null = null;
function uiHtml(): string | null {
  if (cachedHtml) return cachedHtml;
  try {
    cachedHtml = readFileSync(fileURLToPath(new URL('./ops-ui.html', import.meta.url)), 'utf8');
    return cachedHtml;
  } catch (e) {
    console.error('opsUi: failed to read ops-ui.html', e);
    return null;
  }
}

export function opsUiRoutes(): Hono {
  const app = new Hono();
  app.get('/', (c) => {
    const html = uiHtml();
    if (html == null) return c.html('<h1>ops dashboard unavailable</h1>', 500);
    return c.html(html);
  });
  return app;
}
```

`app.ts`: `app.route('/ops', opsUiRoutes());`

- [ ] **Step 1: Write the failing test** (`opsUi.test.ts`):

```typescript
it('serves the ops UI shell without auth', async () => {
  const res = await app.request('/ops');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/html');
  const body = await res.text();
  expect(body).toContain('Ceylon Hop');
  expect(body).toContain('/admin/ops'); // wired to the real API, not mock data
  expect(body).not.toContain('CH-TMRJR'); // no mock bookings shipped
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/routes/opsUi.test.ts`. Expected: 404.
- [ ] **Step 3: Build `ops-ui.html` per the adaptation spec + mount the route.**
- [ ] **Step 4: Full check** — `cd api && npm run check`. Expected: green.
- [ ] **Step 5: Commit + PR**

```bash
git checkout -b m12s2-4-ops-ui
git add api/
git commit -m "feat(ops): serve Control Tower ops UI at /ops with login, wired to /admin/ops"
gh pr create --title "M12S2-4: ops UI at /ops" --body "<red→green evidence + screenshot>"
```

---

### Task 5: End-to-end local verification (no PR — evidence gathering)

- [ ] Start the API dev server (`ceylon-hop-api` launch config, port 8787) with local ops env: `OPS_SESSION_SECRET=dev-ops-secret-change-me OPS_FOUNDER_KEY=dev-founder OPS_SUPPORT_KEY=dev-support` (put in `api/.env` if the server loads it, else inline — do NOT commit).
- [ ] Seed data: create a booking via `POST /bookings/single` (draft→checkout→`payment_pending`), then drive one to `paid` via the fake/sandbox webhook path used by `scripts/demo.ts` (reuse that script if it does this already).
- [ ] Open `http://localhost:8787/ops` in the preview browser: verify login (wrong key rejected, right key in), queue groups render, awaiting-payment row shows follow-up reason with no advance button, advancing a paid booking walks the stepper, toggles + notes persist across a reload, logout returns to the login screen.
- [ ] Check console + network tabs are clean (no errors, no 4xx besides the deliberate 401 probe).
- [ ] Screenshot the queue + detail slide-over as evidence.

### Task 6: Deploy

- [ ] Merge order: Tasks 1→4 PRs squash-merged to `main` (Render auto-deploys `main`).
- [ ] Apply migrations 0011 + 0012 to live Supabase: `cd api && DATABASE_URL=<live> npm run migrate`. Do this BEFORE or immediately after the deploy lands (new code reads `bookings.channel`).
- [ ] Render env vars (from `docs/go-live-checklist.md` §1): set `OPS_SESSION_SECRET` (`openssl rand -hex 32`), `OPS_FOUNDER_KEY`, `OPS_SUPPORT_KEY` (strong random), confirm `ADMIN_API_KEY`. If Render/Supabase credentials are not available locally, STOP and hand the exact commands + generated values to the founder instead.
- [ ] Verify live: `GET https://<render-app>/ops` serves the UI; login with founder key; queue loads (may be empty or test data).
- [ ] Update `docs/ops-dashboard-status.md` (mark reshape + wire-up done, list what remains: WhatsApp payment-link tool, prototype file retirement) and add M12 Slice 2 to `docs/build-plan.md` progress notes. Delete/retire root `_ops-preview.html` note (file itself is untracked; leave on disk).

---

## Self-review notes

- Spec coverage: status-doc §3 items 1–5 map to Tasks 1, 2, 3, 3/4, 4; resume-checklist item 4 (WhatsApp quote→PayHere link tool) is explicitly OUT of scope here (separate build, noted in Task 6 doc update).
- `awaiting_payment` handled as a booking-status view, not a ride status — consistent across Tasks 2, 3, 4.
- Type consistency: `OpsBookingRow` defined once in Task 3 and consumed verbatim by Task 4's `rowToTicket`; status strings identical across `rideStatus.ts`, migration 0012, route tests, and the UI `NEXT` map.
- Booking-level `completed`/`cancelled`: ops queue only shows `payment_pending`/`paid` per the status doc; ride-level `completed` still renders in the Completed group until the booking itself is closed out — matches prototype behaviour.
