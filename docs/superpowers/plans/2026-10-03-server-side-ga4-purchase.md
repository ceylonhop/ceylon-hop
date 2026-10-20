# Server-side GA4 Purchase & Refund Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The API reports every settled payment, ops mark-paid, ride-board charge and confirmed refund to GA4 exactly once, through the Measurement Protocol. Each report carries privacy-safe sale details and is joined to the buyer's GA visit when we have it.

**Architecture:**
- The browser adds its GA ids to the existing checkout request. The API stores them in a small analytics-only table.
- Settlement hooks hand the booking and payment objects to a `Ga4Reporter`. The reporter:
  1. builds a pure, limit-checked Measurement Protocol hit;
  2. claims an exactly-once ledger row that **stores that hit**;
  3. sends it through an adapter (real or fake).
- Failed sends stay in the ledger. The existing notifications cron re-sends them for up to 72 h.

**Tech Stack:** Node 20, TypeScript (strict), Hono, Zod, Drizzle 0.45 + Postgres, Vitest. Plain browser JS (`analytics.js`), Vitest + jsdom, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-03-server-side-ga4-purchase-design.md`, owner-approved 2026-10-03 (commit `ae9af72f`). The acceptance criteria are its §3 user stories.

**Prerequisite:** PR 1 of `docs/superpowers/plans/2026-10-03-ga4-measurement-upgrade.md` (`knownPlace()` + route report, its Tasks 2-3) is merged. This plan imports `knownPlace` from `api/src/services/analytics/knownPlace.ts`.

## Deviations from the spec (flag to the owner at the PR; none change behaviour the owner sees)

1. **GA ids live in their own table, `booking_ga_identity`, not three new `bookings` columns (spec §5.8).** The data is the same. It keeps the heavily used `BookingRepo` and `Booking` type untouched, and all analytics data sits in one place.
2. **The ledger is the outbox.** The sweep re-sends the payload stored at first claim. It does not re-query "succeeded payments without a sent row" (spec §5.2). No new payment query is needed. Cost: a crash in the instant between settlement commit and the hook's claim misses that one event.
3. **The webhook reports only `settled`.**
   - `double_capture` and `unexpected_booking_state` (spec §5.2 table) are **not** reported. That money is refunded or reconciled by hand outside the refund tool, so reporting it would inflate GA4 revenue.
   - Both keep today's critical alerts.
4. **The ledger status set is `claimed` / `sent` / `failed`**, not `claimed` / `sent`. `failed` is how "back to unsent" is stored.

## Global Constraints

- **Measurement Protocol** (checked against Google's MP reference on 2026-10-03):
  - endpoint `https://www.google-analytics.com/mp/collect?measurement_id=…&api_secret=…`;
  - at most **25 params per event**;
  - string values **≤100 characters**;
  - `timestamp_micros` at most **72 hours** in the past;
  - `consent: { ad_user_data, ad_personalization }`, each `'GRANTED' | 'DENIED'`.
- **Event names:** `purchase_server` (shadow mode, the default), `purchase` (after switch-over), `refund`. Never both purchase names for one payment.
- **`value` = money received in this payment** (deposit = deposit). `booking_total` = the whole booking.
- **No personal data in any hit:** no name, email, phone, street address, typed place text, token, booking id or member `sub`. Places only via `knownPlace` (town/region or `Other`).
- **Test bookings never reported:** `isTeamEmail(email, teamEmails)` (`api/src/services/testBookings.ts:20-23`).
- **Analytics never blocks money:** every hook is `void reporter.x(...).catch(log)`, never awaited on the money path.
- **Config is dormant until set:** `GA4_API_SECRET`. Without it, GA ids are still captured, but nothing is sent or claimed.
- **Gates:**
  - Before each commit: `cd api && npx vitest run <changed tests>`.
  - Before each PR: `cd api && npm run check` and `npm --prefix <worktree>/web-tests run test:all`. Both green, judged from the runner's summary line and exit code.

## Working environment (read once)

- **Branch:** create one from current `origin/main` in a fresh worktree:
  `$GIT worktree add .claude/worktrees/ga4-server -b feat/ga4-server-purchase origin/main`.
  `GIT=/Library/Developer/CommandLineTools/usr/bin/git` (the Xcode licence blocks `/usr/bin/git`). Run `gh … --repo ceylonhop/ceylon-hop`.
- **Shell chains:** start every chain with `cd /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/ga4-server || exit 1`.
- **Staging:** stage by path only.
- **Never** run `npm run migrate` against `api/.env`. Its `DATABASE_URL` is **production**.
- **Migration release rule:** merging the migration releases it to **staging**, because pending migrations auto-apply on Render boot. **Production** gets it only on the owner-merged promote PR. Flag the migration in the PR description.
- **PRs:** PR A = Tasks 1-4. PR B = Tasks 5-9. Task 10 is owner operations.

## File map

| File | Change | Task |
|---|---|---|
| `api/src/services/analytics/purchaseFacts.ts` (+ `.test.ts`) | **new**: sale facts from known places | 1 |
| `api/drizzle/0063_ga4_server_events.sql`, `api/drizzle/meta/_journal.json`, `api/src/db/schema.ts`, `api/src/db/ga4ServerEventsMigration.test.ts` | migration + mirror + test | 2 |
| `api/src/db/ga4Repo.ts` (+ `.test.ts`), `api/src/db/postgresGa4Repo.ts` | identity + ledger repos | 3 |
| `analytics.js`, `web-tests/unit/analytics-ga-ids.test.js`, `booking.js:2753`, `manage.html:420`, `pay.html:1024` | browser sends GA ids with checkout | 4 |
| `api/src/adapters/ga4.ts` (+ `.test.ts`), `api/src/config.ts`, `api/src/server.ts` | adapter + config + wiring | 5 |
| `api/src/services/analytics/ga4Hits.ts` (+ `.test.ts`) | **pure** hit builders | 6 |
| `api/src/services/analytics/ga4Reporter.ts` (+ `.test.ts`) | reporter: identity, send, ledger, sweep | 7 |
| `api/src/app.ts`, `api/src/routes/bookings.ts`, `api/src/routes/webhooks.ts`, `api/src/routes/admin.ts`, `api/src/services/rideBoardCutoff.ts` + their tests | hooks + sweep wiring | 8 |
| `docs/analytics/property-tracking.md` | docs | 9 |

---

## PR A: capture the visitor

### Task 1: `purchaseFacts()`: sale facts from known places

**Files:**
- Create: `api/src/services/analytics/purchaseFacts.ts`
- Create: `api/src/services/analytics/purchaseFacts.test.ts`

**Interfaces:**
- Consumes: `knownPlace(place) → { town, region, type }` (prerequisite PR).
- Produces:
  - `ServiceType = 'transfer' | 'shared_seat' | 'trip' | 'chauffeur'`
  - `PurchaseFactsInput = { service: ServiceType; stops: string[]; pax: number | null; vehicle: string | null; date: string | null }`
  - `PurchaseFacts = { service_type; pickup; pickup_region; pickup_type; dropoff; dropoff_region; dropoff_type; route; region_route; pax: number | null; vehicle_type: 'car' | 'van' | 'shared' | 'unknown'; travel_date: string | null }`
  - `purchaseFacts(i: PurchaseFactsInput): PurchaseFacts`

- [ ] **Step 1: Write the failing test.** Create `purchaseFacts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { purchaseFacts } from './purchaseFacts';

describe('purchaseFacts', () => {
  it('a hotel-to-town transfer reports known towns, regions, types and the route', () => {
    expect(purchaseFacts({
      service: 'transfer', stops: ['Granbell Hotel Colombo, Marine Drive, Colombo, Sri Lanka', 'Ella'],
      pax: 2, vehicle: 'car', date: '2026-11-08',
    })).toEqual({
      service_type: 'transfer',
      pickup: 'Colombo City', pickup_region: 'Colombo', pickup_type: 'address',
      dropoff: 'Ella', dropoff_region: 'Hill country', dropoff_type: 'town',
      route: 'Colombo City → Ella', region_route: 'Colombo → Hill country',
      pax: 2, vehicle_type: 'car', travel_date: '2026-11-08',
    });
  });
  it('a typed free-text end reads Other — never the text', () => {
    const f = purchaseFacts({ service: 'transfer', stops: ['my villa near the lighthouse', 'Galle'], pax: 1, vehicle: 'van3', date: null });
    expect(f).toMatchObject({ pickup: 'Other', pickup_type: 'unknown', route: 'Other → Galle', vehicle_type: 'van', travel_date: null });
  });
  it('a shared seat has no vehicle tier; an unrecorded leg is Other → Other', () => {
    expect(purchaseFacts({ service: 'shared_seat', stops: ['Pickup', 'Drop-off'], pax: 1, vehicle: null, date: '2026-11-01' }))
      .toMatchObject({ vehicle_type: 'shared', route: 'Other → Other' });
  });
  it('a date that is not YYYY-MM-DD is dropped, not guessed', () => {
    expect(purchaseFacts({ service: 'trip', stops: ['Kandy', 'Ella'], pax: null, vehicle: 'car', date: 'to confirm' }).travel_date).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**
  - Run: `cd api && npx vitest run src/services/analytics/purchaseFacts.test.ts`
  - Expected: FAIL, `Cannot find module './purchaseFacts'`.

- [ ] **Step 3: Implement.** Create `purchaseFacts.ts`:

```ts
// Sale facts for GA4 (spec 2026-10-03 §5.4). Places go through knownPlace — a known town /
// region / type or "Other", never the stored string (privacy, and GA4 cardinality).

import { knownPlace } from './knownPlace';

export type ServiceType = 'transfer' | 'shared_seat' | 'trip' | 'chauffeur';

export interface PurchaseFactsInput {
  service: ServiceType;
  stops: string[];
  pax: number | null;
  vehicle: string | null;
  date: string | null;
}

export interface PurchaseFacts {
  service_type: ServiceType;
  pickup: string; pickup_region: string; pickup_type: string;
  dropoff: string; dropoff_region: string; dropoff_type: string;
  route: string; region_route: string;
  pax: number | null;
  vehicle_type: 'car' | 'van' | 'shared' | 'unknown';
  travel_date: string | null;
}

const isoDay = (s: string | null | undefined): string | null => {
  const d = String(s ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
};

export function purchaseFacts(i: PurchaseFactsInput): PurchaseFacts {
  const from = knownPlace(i.stops[0]);
  const to = knownPlace(i.stops[i.stops.length - 1]);
  const v = i.vehicle ?? '';
  return {
    service_type: i.service,
    pickup: from.town, pickup_region: from.region, pickup_type: from.type,
    dropoff: to.town, dropoff_region: to.region, dropoff_type: to.type,
    route: `${from.town} → ${to.town}`,
    region_route: `${from.region} → ${to.region}`,
    pax: typeof i.pax === 'number' && Number.isFinite(i.pax) ? i.pax : null,
    vehicle_type: i.service === 'shared_seat' ? 'shared' : v === 'car' ? 'car' : v.startsWith('van') ? 'van' : 'unknown',
    travel_date: isoDay(i.date),
  };
}
```

- [ ] **Step 4: Run.** `cd api && npx vitest run src/services/analytics/purchaseFacts.test.ts`. Expected: PASS (4).
- [ ] **Step 5: Commit.**

```bash
cd /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/ga4-server || exit 1
$GIT add api/src/services/analytics/purchaseFacts.ts api/src/services/analytics/purchaseFacts.test.ts
$GIT commit -m "feat(analytics): purchaseFacts — privacy-safe sale facts from known places"
```

### Task 2: Migration 0063: `booking_ga_identity` + `ga4_event_log`

**Files:**
- Create: `api/drizzle/0063_ga4_server_events.sql`
- Modify: `api/drizzle/meta/_journal.json` (append idx 63)
- Modify: `api/src/db/schema.ts` (after `bookingCheckoutEvents`, line ~528)
- Create: `api/src/db/ga4ServerEventsMigration.test.ts`

- [ ] **Step 1: Write the failing test.** Create `ga4ServerEventsMigration.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../../drizzle/0063_ga4_server_events.sql', import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};
const sql = migration.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

describe('0063_ga4_server_events', () => {
  it('creates the two analytics tables, both with RLS on', () => {
    expect(sql).toMatch(/create table if not exists "booking_ga_identity"/i);
    expect(sql).toMatch(/create table if not exists "ga4_event_log"/i);
    expect(sql).toMatch(/alter table "booking_ga_identity" enable row level security/i);
    expect(sql).toMatch(/alter table "ga4_event_log" enable row level security/i);
  });
  it('pins the shapes: GA ids, consent, ledger kind and status', () => {
    expect(sql).toMatch(/"booking_ga_identity_client_id_shape"/);
    expect(sql).toMatch(/"booking_ga_identity_session_id_shape"/);
    expect(sql).toMatch(/"ad_consent" in \('granted', 'denied', 'unknown'\)/i);
    expect(sql).toMatch(/"kind" in \('purchase', 'refund', 'board_purchase'\)/i);
    expect(sql).toMatch(/"status" in \('claimed', 'sent', 'failed'\)/i);
    expect(sql).toMatch(/"event_key" text not null unique/i);
  });
  it('is additive: no DML, no drops, nothing on bookings or payments', () => {
    expect(sql).not.toMatch(/\b(insert\s+into|delete\s+from|drop\s+(table|column))\b/i);
    expect(sql).not.toMatch(/\bupdate\s+\w+\s+set\b/i);
    expect(sql).not.toMatch(/alter table "(bookings|payments)"/i);
  });
  it('is journalled after 0062', () => {
    const position = journal.entries.findIndex((e) => e.tag === '0063_ga4_server_events');
    expect(journal.entries[position]!.idx).toBe(63);
    expect(journal.entries[position]!.when).toBeGreaterThan(journal.entries[position - 1]!.when);
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**
  - Run: `cd api && npx vitest run src/db/ga4ServerEventsMigration.test.ts`
  - Expected: FAIL with `ENOENT … 0063_ga4_server_events.sql`.

- [ ] **Step 3: Write the migration.** Create `api/drizzle/0063_ga4_server_events.sql`:

```sql
-- Server-side GA4 (docs/superpowers/specs/2026-10-03-server-side-ga4-purchase-design.md).
-- Two analytics-only tables, additive. Nothing on the money path reads them.
--
-- booking_ga_identity: the GA visitor (client id) and session the customer checked out from,
-- so the server's purchase joins that visit in GA4. One row per booking; the latest checkout
-- wins. No foreign key, like booking_checkout_event: best-effort writes must never fail a checkout.
CREATE TABLE IF NOT EXISTS "booking_ga_identity" (
  "booking_id" uuid PRIMARY KEY NOT NULL,
  "client_id" text,
  "session_id" text,
  "ad_consent" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "booking_ga_identity_client_id_shape"
    CHECK ("client_id" IS NULL OR "client_id" ~ '^[0-9]{1,20}\.[0-9]{1,20}$'),
  CONSTRAINT "booking_ga_identity_session_id_shape"
    CHECK ("session_id" IS NULL OR "session_id" ~ '^[0-9]{6,12}$'),
  CONSTRAINT "booking_ga_identity_ad_consent_known"
    CHECK ("ad_consent" IS NULL OR "ad_consent" IN ('granted', 'denied', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "booking_ga_identity" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- ga4_event_log: the exactly-once ledger AND the outbox. `payload` is the exact Measurement
-- Protocol hit built at first claim; retries re-send it unchanged.
CREATE TABLE IF NOT EXISTS "ga4_event_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "event_key" text NOT NULL UNIQUE,
  "kind" text NOT NULL,
  "status" text NOT NULL,
  "attempts" integer DEFAULT 1 NOT NULL,
  "payload" jsonb NOT NULL,
  "last_error" text,
  "claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "sent_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ga4_event_log_kind_known" CHECK ("kind" IN ('purchase', 'refund', 'board_purchase')),
  CONSTRAINT "ga4_event_log_status_known" CHECK ("status" IN ('claimed', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ga4_event_log_status_idx" ON "ga4_event_log" ("status");
--> statement-breakpoint
ALTER TABLE "ga4_event_log" ENABLE ROW LEVEL SECURITY;
```

- [ ] **Step 4: Journal.** In `api/drizzle/meta/_journal.json`, append after the idx 62 entry (mind the comma):

```json
    {
      "idx": 63,
      "version": "7",
      "when": 1790985600000,
      "tag": "0063_ga4_server_events",
      "breakpoints": true
    }
```

  `when` must be greater than the idx 62 entry's `1790899200000`. If another migration has landed on `main` meanwhile, renumber to the next idx and use a `when` greater than the last one. Parallel migration PRs must release in `when` order.

- [ ] **Step 5: Drizzle mirror.** In `api/src/db/schema.ts`, after the `bookingCheckoutEvents` table (ends `);` near line 528), add:

```ts
// Server-side GA4 (0063). The GA visitor + session a booking checked out from, latest wins.
export const bookingGaIdentity = pgTable('booking_ga_identity', {
  bookingId: uuid('booking_id').primaryKey(),
  clientId: text('client_id'),
  sessionId: text('session_id'),
  adConsent: text('ad_consent'), // granted | denied | unknown
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// Server-side GA4 (0063). Exactly-once ledger + outbox: `payload` is the stored MP hit.
export const ga4EventLog = pgTable(
  'ga4_event_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventKey: text('event_key').notNull().unique(),
    kind: text('kind').notNull(), // purchase | refund | board_purchase
    status: text('status').notNull(), // claimed | sent | failed
    attempts: integer('attempts').default(1).notNull(),
    payload: jsonb('payload').notNull(),
    lastError: text('last_error'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).defaultNow().notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('ga4_event_log_status_idx').on(t.status)],
);
```

- [ ] **Step 6: Run.**
  - Run: `cd api && npx vitest run src/db/ga4ServerEventsMigration.test.ts && npx tsc --noEmit -p .`
  - Expected: PASS, no type errors.
  - With `DATABASE_URL_TEST` set (local test DB only, **never** `api/.env`), also run `npx vitest run src/db/rlsEnabled.test.ts`. Expected: PASS, both new tables have RLS.
- [ ] **Step 7: Commit.**

```bash
cd /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/ga4-server || exit 1
$GIT add api/drizzle/0063_ga4_server_events.sql api/drizzle/meta/_journal.json api/src/db/schema.ts api/src/db/ga4ServerEventsMigration.test.ts
$GIT commit -m "feat(db): 0063 — booking_ga_identity + ga4_event_log (analytics only, additive, RLS on)"
```

### Task 3: Repos: GA identity + GA4 ledger

**Files:**
- Create: `api/src/db/ga4Repo.ts` (interfaces + in-memory)
- Create: `api/src/db/postgresGa4Repo.ts`
- Create: `api/src/db/ga4Repo.test.ts`

**Interfaces (produced, used by Tasks 7-8):**

```ts
export type AdConsent = 'granted' | 'denied' | 'unknown';
export interface GaIdentity { clientId: string | null; sessionId: string | null; adConsent: AdConsent }
export interface GaIdentityRepo { set(bookingId: string, id: GaIdentity): Promise<void>; get(bookingId: string): Promise<GaIdentity | null> }
export type Ga4EventKind = 'purchase' | 'refund' | 'board_purchase';
export interface Ga4Claim { eventKey: string; kind: Ga4EventKind; payload: unknown; attempts: number }
export interface Ga4EventLogRepo {
  claim(eventKey: string, kind: Ga4EventKind, payload: unknown, now: Date): Promise<Ga4Claim | null>;
  markSent(eventKey: string, now: Date): Promise<void>;
  markFailed(eventKey: string, error: string): Promise<void>;
  listRetryable(since: Date, now: Date): Promise<Ga4Claim[]>;
}
export const STALE_CLAIM_MS: number; // 10 minutes
```

- [ ] **Step 1: Write the failing test.** Create `api/src/db/ga4Repo.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { InMemoryGa4EventLogRepo, InMemoryGaIdentityRepo, STALE_CLAIM_MS } from './ga4Repo';

const T0 = new Date('2026-10-03T10:00:00Z');
const later = (ms: number) => new Date(T0.getTime() + ms);

describe('GA identity repo', () => {
  it('stores and returns the latest identity per booking', async () => {
    const repo = new InMemoryGaIdentityRepo();
    expect(await repo.get('b1')).toBeNull();
    await repo.set('b1', { clientId: '111.222', sessionId: '1700000000', adConsent: 'unknown' });
    await repo.set('b1', { clientId: '333.444', sessionId: null, adConsent: 'granted' });
    expect(await repo.get('b1')).toEqual({ clientId: '333.444', sessionId: null, adConsent: 'granted' });
  });
});

describe('GA4 event ledger', () => {
  it('first claim wins and stores the payload; a second claim gets nothing', async () => {
    const log = new InMemoryGa4EventLogRepo();
    expect(await log.claim('purchase:p1', 'purchase', { a: 1 }, T0)).toEqual({ eventKey: 'purchase:p1', kind: 'purchase', payload: { a: 1 }, attempts: 1 });
    expect(await log.claim('purchase:p1', 'purchase', { a: 2 }, T0)).toBeNull();
  });
  it('a sent event can never be claimed again', async () => {
    const log = new InMemoryGa4EventLogRepo();
    await log.claim('k', 'refund', {}, T0);
    await log.markSent('k', T0);
    expect(await log.claim('k', 'refund', {}, later(STALE_CLAIM_MS * 10))).toBeNull();
  });
  it('a failed event is re-claimable, keeps its FIRST payload, and counts attempts', async () => {
    const log = new InMemoryGa4EventLogRepo();
    await log.claim('k', 'purchase', { first: true }, T0);
    await log.markFailed('k', 'ga4_send_failed_500');
    const again = await log.claim('k', 'purchase', { first: false }, later(1000));
    expect(again).toEqual({ eventKey: 'k', kind: 'purchase', payload: { first: true }, attempts: 2 });
  });
  it('a claim abandoned for longer than STALE_CLAIM_MS is retryable; a fresh one is not', async () => {
    const log = new InMemoryGa4EventLogRepo();
    await log.claim('k', 'purchase', {}, T0);
    expect(await log.listRetryable(new Date(0), later(STALE_CLAIM_MS - 1))).toEqual([]);
    expect((await log.listRetryable(new Date(0), later(STALE_CLAIM_MS + 1))).map((r) => r.eventKey)).toEqual(['k']);
  });
  it('listRetryable ignores rows created before `since` (the 72 h MP window)', async () => {
    const log = new InMemoryGa4EventLogRepo();
    await log.claim('old', 'purchase', {}, T0);
    await log.markFailed('old', 'x');
    expect(await log.listRetryable(later(1), later(2))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and watch it fail.**
  - Run: `cd api && npx vitest run src/db/ga4Repo.test.ts`
  - Expected: FAIL, module missing.

- [ ] **Step 3: Implement the interfaces and in-memory repos.** Create `api/src/db/ga4Repo.ts`:

```ts
// Server-side GA4 (spec 2026-10-03). Two analytics-only stores:
//  - GaIdentityRepo: the GA visitor/session a booking checked out from (latest wins).
//  - Ga4EventLogRepo: exactly-once ledger + outbox. claim() is the arbiter — of two concurrent
//    callers exactly one gets the row; a failed or abandoned claim can be taken again, and the
//    payload stored at the FIRST claim is what every retry re-sends.

export type AdConsent = 'granted' | 'denied' | 'unknown';
export interface GaIdentity { clientId: string | null; sessionId: string | null; adConsent: AdConsent }

export interface GaIdentityRepo {
  set(bookingId: string, id: GaIdentity): Promise<void>;
  get(bookingId: string): Promise<GaIdentity | null>;
}

export type Ga4EventKind = 'purchase' | 'refund' | 'board_purchase';
export interface Ga4Claim { eventKey: string; kind: Ga4EventKind; payload: unknown; attempts: number }

export interface Ga4EventLogRepo {
  /** Own the send. Null when it is already sent or someone else holds a live claim. */
  claim(eventKey: string, kind: Ga4EventKind, payload: unknown, now: Date): Promise<Ga4Claim | null>;
  markSent(eventKey: string, now: Date): Promise<void>;
  markFailed(eventKey: string, error: string): Promise<void>;
  /** Failed rows, and claims older than STALE_CLAIM_MS, created at or after `since`. */
  listRetryable(since: Date, now: Date): Promise<Ga4Claim[]>;
}

/** A claim this old belongs to a process that died between claim and send. */
export const STALE_CLAIM_MS = 10 * 60 * 1000;

export class InMemoryGaIdentityRepo implements GaIdentityRepo {
  private readonly byBooking = new Map<string, GaIdentity>();
  async set(bookingId: string, id: GaIdentity): Promise<void> {
    this.byBooking.set(bookingId, { ...id });
  }
  async get(bookingId: string): Promise<GaIdentity | null> {
    const id = this.byBooking.get(bookingId);
    return id ? { ...id } : null;
  }
}

interface Row {
  eventKey: string; kind: Ga4EventKind; payload: unknown; attempts: number;
  status: 'claimed' | 'sent' | 'failed'; claimedAt: Date; createdAt: Date; lastError: string | null;
}

export class InMemoryGa4EventLogRepo implements Ga4EventLogRepo {
  private readonly rows = new Map<string, Row>();
  private view(r: Row): Ga4Claim {
    return { eventKey: r.eventKey, kind: r.kind, payload: r.payload, attempts: r.attempts };
  }
  private retryable(r: Row, now: Date): boolean {
    return r.status === 'failed' || (r.status === 'claimed' && now.getTime() - r.claimedAt.getTime() > STALE_CLAIM_MS);
  }
  async claim(eventKey: string, kind: Ga4EventKind, payload: unknown, now: Date): Promise<Ga4Claim | null> {
    const row = this.rows.get(eventKey);
    if (!row) {
      const fresh: Row = { eventKey, kind, payload, attempts: 1, status: 'claimed', claimedAt: now, createdAt: now, lastError: null };
      this.rows.set(eventKey, fresh);
      return this.view(fresh);
    }
    if (!this.retryable(row, now)) return null;
    row.status = 'claimed';
    row.attempts += 1;
    row.claimedAt = now;
    return this.view(row);
  }
  async markSent(eventKey: string): Promise<void> {
    const row = this.rows.get(eventKey);
    if (row) row.status = 'sent';
  }
  async markFailed(eventKey: string, error: string): Promise<void> {
    const row = this.rows.get(eventKey);
    if (row) { row.status = 'failed'; row.lastError = error.slice(0, 500); }
  }
  async listRetryable(since: Date, now: Date): Promise<Ga4Claim[]> {
    return [...this.rows.values()]
      .filter((r) => r.createdAt.getTime() >= since.getTime() && this.retryable(r, now))
      .map((r) => this.view(r));
  }
}
```

- [ ] **Step 4: Implement the Postgres repos.** Create `api/src/db/postgresGa4Repo.ts`:

```ts
import { and, eq, gte, lt, or, sql } from 'drizzle-orm';
import type { Db } from './client';
import { bookingGaIdentity, ga4EventLog } from './schema';
import {
  STALE_CLAIM_MS,
  type AdConsent, type Ga4Claim, type Ga4EventKind, type Ga4EventLogRepo, type GaIdentity, type GaIdentityRepo,
} from './ga4Repo';

export class PostgresGaIdentityRepo implements GaIdentityRepo {
  constructor(private readonly db: Db) {}

  async set(bookingId: string, id: GaIdentity): Promise<void> {
    await this.db
      .insert(bookingGaIdentity)
      .values({ bookingId, clientId: id.clientId, sessionId: id.sessionId, adConsent: id.adConsent })
      .onConflictDoUpdate({
        target: bookingGaIdentity.bookingId,
        set: { clientId: id.clientId, sessionId: id.sessionId, adConsent: id.adConsent, updatedAt: new Date() },
      });
  }

  async get(bookingId: string): Promise<GaIdentity | null> {
    const [row] = await this.db.select().from(bookingGaIdentity).where(eq(bookingGaIdentity.bookingId, bookingId));
    if (!row) return null;
    return { clientId: row.clientId, sessionId: row.sessionId, adConsent: (row.adConsent ?? 'unknown') as AdConsent };
  }
}

const claimView = { eventKey: ga4EventLog.eventKey, kind: ga4EventLog.kind, payload: ga4EventLog.payload, attempts: ga4EventLog.attempts };

export class PostgresGa4EventLogRepo implements Ga4EventLogRepo {
  constructor(private readonly db: Db) {}

  async claim(eventKey: string, kind: Ga4EventKind, payload: unknown, now: Date): Promise<Ga4Claim | null> {
    const stale = new Date(now.getTime() - STALE_CLAIM_MS);
    // The unique event_key arbitrates: a fresh insert, or a take-over of a failed / abandoned
    // claim. RETURNING is empty when the row is sent or someone else holds a live claim. The
    // stored payload is never overwritten — retries re-send the first hit.
    const rows = await this.db
      .insert(ga4EventLog)
      .values({ eventKey, kind, status: 'claimed', attempts: 1, payload, claimedAt: now })
      .onConflictDoUpdate({
        target: ga4EventLog.eventKey,
        set: { status: 'claimed', attempts: sql`${ga4EventLog.attempts} + 1`, claimedAt: now },
        setWhere: or(
          eq(ga4EventLog.status, 'failed'),
          and(eq(ga4EventLog.status, 'claimed'), lt(ga4EventLog.claimedAt, stale)),
        ),
      })
      .returning(claimView);
    const r = rows[0];
    return r ? { eventKey: r.eventKey, kind: r.kind as Ga4EventKind, payload: r.payload, attempts: r.attempts } : null;
  }

  async markSent(eventKey: string, now: Date): Promise<void> {
    await this.db.update(ga4EventLog).set({ status: 'sent', sentAt: now }).where(eq(ga4EventLog.eventKey, eventKey));
  }

  async markFailed(eventKey: string, error: string): Promise<void> {
    await this.db.update(ga4EventLog).set({ status: 'failed', lastError: error.slice(0, 500) }).where(eq(ga4EventLog.eventKey, eventKey));
  }

  async listRetryable(since: Date, now: Date): Promise<Ga4Claim[]> {
    const stale = new Date(now.getTime() - STALE_CLAIM_MS);
    const rows = await this.db
      .select(claimView)
      .from(ga4EventLog)
      .where(and(
        gte(ga4EventLog.createdAt, since),
        or(eq(ga4EventLog.status, 'failed'), and(eq(ga4EventLog.status, 'claimed'), lt(ga4EventLog.claimedAt, stale))),
      ));
    return rows.map((r) => ({ eventKey: r.eventKey, kind: r.kind as Ga4EventKind, payload: r.payload, attempts: r.attempts }));
  }
}
```

- [ ] **Step 5: Run.**
  - Run: `cd api && npx vitest run src/db/ga4Repo.test.ts && npx tsc --noEmit -p .`
  - Expected: PASS (6), no type errors.
- [ ] **Step 6: Commit.**

```bash
cd /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/ga4-server || exit 1
$GIT add api/src/db/ga4Repo.ts api/src/db/postgresGa4Repo.ts api/src/db/ga4Repo.test.ts
$GIT commit -m "feat(db): GA identity + GA4 exactly-once ledger repos"
```

### Task 4: The browser sends its GA ids with checkout

**Files:**
- Modify: `analytics.js`, directly after the `window.chTrack = function …};` block (lines 6-10), before the `chContactBound` guard
- Create: `web-tests/unit/analytics-ga-ids.test.js`
- Modify: `booking.js:2753`, `manage.html:420`, `pay.html:1024`

**Interfaces:**
- Produces:
  - `window.chGaIds() → { clientId: string|null, sessionId: string|null, adConsent: 'granted'|'denied'|'unknown' }`
  - `window.chWithGa(body) → body`, plus `ga` **only** when a client or session id exists.
- Consumed by: the API (Task 8 reads `body.ga`).

- [ ] **Step 1: Write the failing test.** Create `web-tests/unit/analytics-ga-ids.test.js`:

```js
// The GA visitor + session this browser is, sent with checkout so the SERVER's purchase joins
// this visit (spec 2026-10-03 §5.2). Read from GA's own cookies; nothing may ever block a checkout.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(__dirname, '..', '..', 'analytics.js'), 'utf8');

function load(cookie, stored = null) {
  const win = {
    location: { hostname: 'ceylonhop.com', pathname: '/' },
    document: { addEventListener() {}, readyState: 'complete', cookie },
    localStorage: { getItem: (k) => (k === 'ceylonhop_cookie_choice' ? stored : null) },
  };
  new Function('window', 'document', 'location', src)(win, win.document, win.location);
  return win;
}

describe('chGaIds', () => {
  it('reads the client id from _ga and the session id from a GS1 session cookie', () => {
    const w = load('_ga=GA1.1.123456789.1700000000; _ga_XEW62ZD7B3=GS1.1.1759400000.3.1.1759400100.0.0.0');
    expect(w.chGaIds()).toEqual({ clientId: '123456789.1700000000', sessionId: '1759400000', adConsent: 'unknown' });
  });
  it('reads the newer GS2 session cookie format', () => {
    const w = load('_ga=GA1.1.42.1700000000; _ga_XEW62ZD7B3=GS2.1.s1759400000$o3$g1$t1759400100$j0$l0$h0');
    expect(w.chGaIds().sessionId).toBe('1759400000');
  });
  it('passes on the stored ad-consent choice', () => {
    expect(load('', 'denied').chGaIds().adConsent).toBe('denied');
    expect(load('', 'granted').chGaIds().adConsent).toBe('granted');
  });
  it('no GA cookies (blocked, or first paint) → nulls, and checkout bodies stay unchanged', () => {
    const w = load('other=1');
    expect(w.chGaIds()).toEqual({ clientId: null, sessionId: null, adConsent: 'unknown' });
    expect(w.chWithGa({ returnTo: 'manage' })).toEqual({ returnTo: 'manage' });
  });
  it('adds ga to a checkout body only when there is an id to send', () => {
    const w = load('_ga=GA1.1.1.2');
    expect(w.chWithGa({ returnTo: 'pay-link' })).toEqual({ returnTo: 'pay-link', ga: { clientId: '1.2', sessionId: null, adConsent: 'unknown' } });
  });
});
```

- [ ] **Step 2: Run and watch it fail.**
  - Run: `npm --prefix /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/ga4-server/web-tests run test:unit -- analytics-ga-ids`
  - Expected: FAIL, `w.chGaIds is not a function`.

- [ ] **Step 3: Implement in `analytics.js`** (after `window.chTrack`):

```js
  // ── the GA visitor + session this browser is (2026-10-03) ─────────────────
  // Sent with checkout so the SERVER's GA4 purchase joins this visit (spec
  // docs/superpowers/specs/2026-10-03-server-side-ga4-purchase-design.md). GA's own
  // first-party cookies: `_ga` = GA1.1.<client id>; `_ga_XEW62ZD7B3` = GS1.1.<session id>.…
  // or GS2.1.s<session id>$…. Plus the stored ad-consent choice. Every field may be null —
  // blocked or not-yet-set cookies must never stop a checkout.
  window.chGaIds = function () {
    var out = { clientId: null, sessionId: null, adConsent: 'unknown' };
    try {
      var jar = String(document.cookie || '');
      var ga = /(?:^|;\s*)_ga=GA\d\.\d\.(\d{1,20}\.\d{1,20})(?:;|$)/.exec(jar);
      if (ga) out.clientId = ga[1];
      var gs = /(?:^|;\s*)_ga_XEW62ZD7B3=GS\d\.\d\.s?(\d{6,12})[.$]/.exec(jar);
      if (gs) out.sessionId = gs[1];
      var choice = window.localStorage && window.localStorage.getItem('ceylonhop_cookie_choice');
      if (choice === 'granted' || choice === 'denied') out.adConsent = choice;
    } catch (e) { /* cookies or storage blocked — send what we have */ }
    return out;
  };
  // A checkout body plus `ga` when there is an id to send. Unchanged otherwise, so a browser
  // without GA (blocked, local dev, tests) sends exactly what it always did.
  window.chWithGa = function (body) {
    var ids = window.chGaIds();
    return ids.clientId || ids.sessionId ? Object.assign({}, body, { ga: ids }) : body;
  };
```

- [ ] **Step 4: Callers.** Each page keeps working without `analytics.js` (the `typeof` guard).
  - `booking.js:2753`: replace `body:JSON.stringify({returnTo:'manage'})` with
    `body:JSON.stringify(typeof window.chWithGa==='function'?window.chWithGa({returnTo:'manage'}):{returnTo:'manage'})`
  - `manage.html:420`: replace `body: JSON.stringify({ returnTo: 'manage' }),` with
    `body: JSON.stringify(typeof window.chWithGa === 'function' ? window.chWithGa({ returnTo: 'manage' }) : { returnTo: 'manage' }),`
  - `pay.html:1024`: replace `body: JSON.stringify({ returnTo: 'pay-link' }),` with
    `body: JSON.stringify(typeof window.chWithGa === 'function' ? window.chWithGa({ returnTo: 'pay-link' }) : { returnTo: 'pay-link' }),`

- [ ] **Step 5: Run everything web.**
  - Run: `npm --prefix …/ga4-server/web-tests run test:all`
  - Expected: green.
  - The existing exact-body assertions stay valid, because no GA cookies exist in those tests:
    - `booking-page-redirect.test.js:157` and `booking-redirect.spec.js:53` expect `{ returnTo: 'manage' }`;
    - `manage-redirect.spec.js:58`;
    - `pay-page.spec.js:309`.
  - The regex tests (`manage-page-redirect.test.js:44`, `pay-page-redirect.test.js:52`) still find `returnTo: 'manage'` / `'pay-link'`.

- [ ] **Step 6: Commit, then PR A.**

```bash
cd /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/ga4-server || exit 1
$GIT add analytics.js web-tests/unit/analytics-ga-ids.test.js booking.js manage.html pay.html
$GIT commit -m "feat(analytics): send the GA visitor + session with checkout (only when present)"
```

  PR A must **not** merge until Task 8's server capture is in, or the field arrives unread. That's harmless, but nothing is stored either. **Recommended:** keep PR A and PR B as one stacked series, and merge PR B immediately after PR A. Or fold Tasks 1-4 into PR B if the owner prefers a single release. The migration (Task 2) ships with whichever merges first, so flag it in that PR.

---

## PR B: report to GA4

### Task 5: GA4 adapter + config + server wiring (dormant)

**Files:**
- Create: `api/src/adapters/ga4.ts`, `api/src/adapters/ga4.test.ts`
- Modify: `api/src/config.ts` (after `SENTRY_DSN`, line ~138)
- Modify: `api/src/server.ts` (adapter construction near the email adapter, lines 88-93; `createApp({...})`, lines 134-187)

**Interfaces (produced):**

```ts
export interface Ga4Item { item_id: string; item_name: string; item_category: string; price: number; quantity: number }
export interface Ga4Event { name: string; params: Record<string, string | number | Ga4Item[]> }
export type Ga4Consent = 'GRANTED' | 'DENIED';
export interface Ga4Hit { client_id: string; timestamp_micros: number; consent: { ad_user_data: Ga4Consent; ad_personalization: Ga4Consent }; events: Ga4Event[] }
export interface Ga4Adapter { send(hit: Ga4Hit): Promise<void> } // throws on failure
export class FakeGa4Adapter implements Ga4Adapter { readonly sent: Ga4Hit[]; failNext: number }
export class MeasurementProtocolAdapter implements Ga4Adapter { constructor(measurementId: string, apiSecret: string) }
```

- [ ] **Step 1: Failing test.** Create `api/src/adapters/ga4.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { FakeGa4Adapter, MeasurementProtocolAdapter, type Ga4Hit } from './ga4';

const HIT: Ga4Hit = {
  client_id: '1.2', timestamp_micros: 1, consent: { ad_user_data: 'DENIED', ad_personalization: 'DENIED' },
  events: [{ name: 'purchase_server', params: { transaction_id: 'CH-1', value: 10, currency: 'USD' } }],
};

afterEach(() => vi.unstubAllGlobals());

describe('GA4 adapters', () => {
  it('the fake records hits and can be told to fail', async () => {
    const fake = new FakeGa4Adapter();
    fake.failNext = 1;
    await expect(fake.send(HIT)).rejects.toThrow('ga4_fake_failure');
    await fake.send(HIT);
    expect(fake.sent).toEqual([HIT]);
  });
  it('the Measurement Protocol adapter POSTs the hit to /mp/collect with id + secret', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
      calls.push({ url, body: init.body });
      return new Response(null, { status: 204 });
    });
    await new MeasurementProtocolAdapter('G-TEST', 's3cret').send(HIT);
    expect(calls[0].url).toBe('https://www.google-analytics.com/mp/collect?measurement_id=G-TEST&api_secret=s3cret');
    expect(JSON.parse(calls[0].body)).toEqual(HIT);
  });
  it('throws on a non-2xx answer so the ledger records a failure', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }));
    await expect(new MeasurementProtocolAdapter('G-TEST', 's').send(HIT)).rejects.toThrow('ga4_send_failed_500');
  });
});
```

- [ ] **Step 2: Run and watch it fail.**
  - Run: `cd api && npx vitest run src/adapters/ga4.test.ts`
  - Expected: FAIL, module missing.

- [ ] **Step 3: Implement.** Create `api/src/adapters/ga4.ts`:

```ts
// GA4 Measurement Protocol (spec 2026-10-03). The real adapter is selected at startup only when
// GA4_API_SECRET is set; otherwise nothing is constructed and nothing is sent (CLAUDE.md hard
// rule 4: external services only behind an adapter with a fake). Throws on failure so the
// ledger can record it and the cron sweep can retry. Note: /mp/collect answers 2xx even for a
// malformed hit — correctness is pinned by ga4Hits' own tests, not by this status.

export interface Ga4Item { item_id: string; item_name: string; item_category: string; price: number; quantity: number }
export interface Ga4Event { name: string; params: Record<string, string | number | Ga4Item[]> }
export type Ga4Consent = 'GRANTED' | 'DENIED';
export interface Ga4Hit {
  client_id: string;
  timestamp_micros: number;
  consent: { ad_user_data: Ga4Consent; ad_personalization: Ga4Consent };
  events: Ga4Event[];
}

export interface Ga4Adapter {
  send(hit: Ga4Hit): Promise<void>;
}

export class FakeGa4Adapter implements Ga4Adapter {
  readonly sent: Ga4Hit[] = [];
  failNext = 0;
  async send(hit: Ga4Hit): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('ga4_fake_failure');
    }
    this.sent.push(hit);
  }
}

export class MeasurementProtocolAdapter implements Ga4Adapter {
  constructor(private readonly measurementId: string, private readonly apiSecret: string) {}

  async send(hit: Ga4Hit): Promise<void> {
    const url = `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(this.measurementId)}`
      + `&api_secret=${encodeURIComponent(this.apiSecret)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', body: JSON.stringify(hit), signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`ga4_send_failed_${res.status}`);
  }
}
```

- [ ] **Step 4: Config.** This is a config change, and the owner approved it on 2026-10-03. In `api/src/config.ts`, after the `SENTRY_DSN` line add:

```ts
  // Server-side GA4 (spec 2026-10-03). Dormant until GA4_API_SECRET is set (GA4 → Admin → Data
  // streams → Ceylon Hop Web → Measurement Protocol API secrets). GA4_SERVER_EVENT_NAME stays
  // `purchase_server` (shadow mode) until the owner switches over — the default can never
  // double-count against the browser's `purchase`.
  GA4_MEASUREMENT_ID: z.string().default('G-XEW62ZD7B3'),
  GA4_API_SECRET: z.string().optional(),
  GA4_SERVER_EVENT_NAME: z.enum(['purchase_server', 'purchase']).default('purchase_server'),
```

- [ ] **Step 5: Server wiring.** In `api/src/server.ts`:
  - Add the imports:
    `import { MeasurementProtocolAdapter } from './adapters/ga4';`
    `import { PostgresGa4EventLogRepo, PostgresGaIdentityRepo } from './db/postgresGa4Repo';`
  - After the email adapter (line ~93) add:

```ts
// Server-side GA4 — dormant without the secret: ids are still captured, nothing is sent.
const ga4Adapter = config.GA4_API_SECRET
  ? new MeasurementProtocolAdapter(config.GA4_MEASUREMENT_ID, config.GA4_API_SECRET)
  : undefined;
```

  - Inside `createApp({ … })`, next to `checkoutEvents: new PostgresBookingCheckoutEventRepo(db),`, add:

```ts
  gaIdentities: new PostgresGaIdentityRepo(db),
  ga4Log: new PostgresGa4EventLogRepo(db),
  ...(ga4Adapter ? { ga4Adapter } : {}),
  ga4EventName: config.GA4_SERVER_EVENT_NAME,
```

  (The `AppDeps` fields arrive in Task 8. Until then `tsc` fails here, so do this step together with Task 8 Step 3, or add the four optional `AppDeps` fields now, exactly as Task 8 Step 3 lists them.)

- [ ] **Step 6: Run.** `cd api && npx vitest run src/adapters/ga4.test.ts`. Expected: PASS (3).
- [ ] **Step 7: Commit.**

```bash
cd /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/ga4-server || exit 1
$GIT add api/src/adapters/ga4.ts api/src/adapters/ga4.test.ts api/src/config.ts api/src/server.ts
$GIT commit -m "feat(ga4): Measurement Protocol adapter + fake, dormant config"
```

### Task 6: `ga4Hits`: pure, limit-checked hit builders

**Files:**
- Create: `api/src/services/analytics/ga4Hits.ts`
- Create: `api/src/services/analytics/ga4Hits.test.ts`

**Interfaces:**
- Consumes:
  - `purchaseFacts` (Task 1);
  - `GaIdentity` (Task 3);
  - `Ga4Hit`, `Ga4Event`, `Ga4Item` (Task 5);
  - `projectBooking` (`api/src/routes/bookings.ts`);
  - `promoDiscount` (`api/src/services/notifications.ts:195`);
  - `Booking`, `Payment`, `Refund`, `RideList`, `RideMember` types.
- Produces:
  - `type Ga4PurchaseName = 'purchase' | 'purchase_server'`
  - `MAX_PARAMS = 25`, `MAX_STRING = 100`
  - `consentFor(identity: GaIdentity | null, country: string | null | undefined): 'GRANTED' | 'DENIED'`
  - `bookingFacts(b: Booking): PurchaseFacts`
  - `purchaseHit(i: PurchaseHitInput): Ga4Hit`
  - `refundHit(i: RefundHitInput): Ga4Hit`
  - `boardHit(i: BoardHitInput): Ga4Hit`

  where:
  - `PurchaseHitInput = { booking: Booking; payment: Payment; settledAt: Date; identity: GaIdentity | null; returning: boolean; secondPayment: boolean; eventName: Ga4PurchaseName }`
  - `RefundHitInput = { booking: Booking; refund: Refund; identity: GaIdentity | null; at: Date }`
  - `BoardHitInput = { list: RideList; member: RideMember; amountCents: number; currency: string; at: Date; eventName: Ga4PurchaseName }`

- [ ] **Step 1: Failing test.** Create `ga4Hits.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Booking } from '../../db/bookingRepo';
import type { Payment } from '../../db/paymentRepo';
import type { Refund } from '../../db/refundRepo';
import type { RideList, RideMember } from '../../domain/rideList';
import { MAX_PARAMS, boardHit, consentFor, purchaseHit, refundHit } from './ga4Hits';

const customer = { firstName: 'Emma', lastName: 'L', email: 'emma@example.test', phoneCountryCode: '+44', phoneNumber: '7700900000', country: 'United Kingdom' };
const booking = {
  id: 'b-1', reference: 'CH-TEST1', status: 'paid', mode: 'single', channel: 'website', currency: 'USD',
  total: 22900, amountDueNow: 22900, createdAt: '2026-10-28T10:00:00.000Z',
  input: { customer, from: 'Colombo Airport (CMB)', to: 'Galle', date: '2026-11-08', time: '09:00', adults: 2, children: 0, bags: 2, vehicleType: 'car' },
} as unknown as Booking;
const payment = { id: 'pay-abcdef12', bookingId: 'b-1', provider: 'payhere', orderId: 'CH-TEST1', amount: 22900, currency: 'USD', idempotencyKey: 'checkout:b-1', status: 'succeeded', attemptCount: 1, lastAttemptAt: null } as Payment;
const SETTLED = new Date('2026-10-29T08:00:00Z');
const identity = { clientId: '123.456', sessionId: '1761724800', adConsent: 'unknown' as const };

describe('purchaseHit', () => {
  const hit = purchaseHit({ booking, payment, settledAt: SETTLED, identity, returning: false, secondPayment: false, eventName: 'purchase_server' });
  const p = hit.events[0].params;

  it('joins the checkout visit and is stamped at settlement', () => {
    expect(hit.client_id).toBe('123.456');
    expect(hit.timestamp_micros).toBe(SETTLED.getTime() * 1000);
    expect(hit.events[0].name).toBe('purchase_server');
    expect(p.session_id).toBe('1761724800');
  });
  it('carries the money as received and the sale facts', () => {
    expect(p).toMatchObject({
      transaction_id: 'CH-TEST1', value: 229, currency: 'USD', payment_type: 'full', booking_total: 229,
      service_type: 'transfer', route: 'Colombo Airport (CMB) → Galle', region_route: 'Airport & Negombo → South coast',
      pickup: 'Colombo Airport (CMB)', dropoff: 'Galle', pax: 2, vehicle_type: 'car',
      travel_month: '2026-11', days_to_travel: 10, customer_country: 'United Kingdom', customer_type: 'new', channel: 'website',
    });
    expect(p.items).toEqual([{ item_id: 'Colombo Airport (CMB) → Galle', item_name: 'Colombo Airport (CMB) → Galle', item_category: 'transfer', price: 229, quantity: 1 }]);
  });
  it('never carries personal data', () => {
    const raw = JSON.stringify(hit);
    for (const pii of ['emma@example.test', 'Emma', '7700900000', 'b-1']) expect(raw).not.toContain(pii);
  });
  it('a deposit is a deposit; a second payment gets its own transaction id', () => {
    const dep = purchaseHit({ booking, payment: { ...payment, amount: 5000 }, settledAt: SETTLED, identity: null, returning: true, secondPayment: true, eventName: 'purchase' });
    expect(dep.events[0].params).toMatchObject({ value: 50, payment_type: 'deposit', booking_total: 229, customer_type: 'returning', transaction_id: 'CH-TEST1-pay-ab' });
    expect(dep.client_id).toMatch(/^srv\.[0-9a-f]{16}$/);
  });
  it('stays within the Measurement Protocol limits', () => {
    expect(Object.keys(p).length).toBeLessThanOrEqual(MAX_PARAMS);
    for (const v of Object.values(p)) if (typeof v === 'string') expect(v.length).toBeLessThanOrEqual(100);
  });
});

describe('consentFor', () => {
  it('the stored choice wins; otherwise only a known non-EEA/UK/CH country is granted', () => {
    expect(consentFor({ clientId: null, sessionId: null, adConsent: 'granted' }, 'Germany')).toBe('GRANTED');
    expect(consentFor({ clientId: null, sessionId: null, adConsent: 'denied' }, 'Australia')).toBe('DENIED');
    expect(consentFor(null, 'Australia')).toBe('GRANTED');
    expect(consentFor(null, 'United Kingdom')).toBe('DENIED');
    expect(consentFor(null, '')).toBe('DENIED');
  });
});

describe('refundHit', () => {
  it('mirrors the purchase it reverses, and drops a reason that looks like contact details', () => {
    const refund = { id: 'rf-1', bookingId: 'b-1', paymentId: 'pay-abcdef12', provider: 'payhere', amountCents: 22900, currency: 'USD', status: 'manual_confirmed', reason: 'call me on +94 77 123 4567', gatewayRef: 'R1', requestedBy: 'f@x.com', confirmedBy: 'f@x.com', confirmedAt: SETTLED } as unknown as Refund;
    const hit = refundHit({ booking, refund, identity, at: SETTLED });
    expect(hit.events[0].name).toBe('refund');
    expect(hit.events[0].params).toMatchObject({ transaction_id: 'CH-TEST1', value: 229, currency: 'USD' });
    expect(hit.events[0].params).not.toHaveProperty('refund_reason');
  });
});

describe('boardHit', () => {
  it('a charged seat: shared seat between known towns, no member id anywhere', () => {
    const list = { id: 'list-1', code: 'EM-4821', fromPlace: 'Ella', toPlace: 'Mirissa', date: '2026-11-08' } as RideList;
    const member = { sub: 'google-sub-123', email: 'm@x.com', firstName: 'M', country: 'Australia', seats: 2 } as RideMember;
    const hit = boardHit({ list, member, amountCents: 4800, currency: 'USD', at: SETTLED, eventName: 'purchase_server' });
    expect(hit.events[0].params).toMatchObject({ service_type: 'shared_seat', route: 'Ella → Mirissa', pax: 2, value: 48, channel: 'ride_board', vehicle_type: 'shared' });
    expect(String(hit.events[0].params.transaction_id)).toMatch(/^EM-4821-[0-9a-f]{8}$/);
    expect(JSON.stringify(hit)).not.toContain('google-sub-123');
    expect(hit.consent.ad_user_data).toBe('GRANTED');
  });
});
```

- [ ] **Step 2: Run and watch it fail.**
  - Run: `cd api && npx vitest run src/services/analytics/ga4Hits.test.ts`
  - Expected: FAIL, module missing.

- [ ] **Step 3: Implement.** Create `ga4Hits.ts`:

```ts
// Measurement Protocol hits (spec 2026-10-03 §5.3-5.5). PURE: same input, same hit. The
// reporter stores the hit in the ledger at first claim and every retry re-sends it unchanged.
// Hard MP limits: ≤25 params per event, string values ≤100 chars, enforced here and tested.

import { createHash } from 'node:crypto';
import type { Ga4Event, Ga4Hit, Ga4Item } from '../../adapters/ga4';
import type { Booking } from '../../db/bookingRepo';
import type { GaIdentity } from '../../db/ga4Repo';
import type { Payment } from '../../db/paymentRepo';
import type { Refund } from '../../db/refundRepo';
import type { RideList, RideMember } from '../../domain/rideList';
import { projectBooking } from '../../routes/bookings';
import { promoDiscount } from '../notifications';
import { purchaseFacts, type PurchaseFacts } from './purchaseFacts';

export type Ga4PurchaseName = 'purchase' | 'purchase_server';
export const MAX_PARAMS = 25;
export const MAX_STRING = 100;

const cut = (s: string): string => s.slice(0, MAX_STRING);
const usd = (cents: number): number => Math.round(cents) / 100;
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const micros = (d: Date): number => d.getTime() * 1000;

// The site denies ad consent by default in the EEA, UK and Switzerland (booking.html:25-29).
// Country values are NAMES as entered on the booking / pay / board forms.
const EEA_UK_CH = new Set([
  'austria', 'belgium', 'bulgaria', 'croatia', 'cyprus', 'czech republic', 'czechia', 'denmark', 'estonia',
  'finland', 'france', 'germany', 'greece', 'hungary', 'ireland', 'italy', 'latvia', 'lithuania', 'luxembourg',
  'malta', 'netherlands', 'poland', 'portugal', 'romania', 'slovakia', 'slovenia', 'spain', 'sweden',
  'iceland', 'liechtenstein', 'norway', 'united kingdom', 'switzerland',
]);

export function consentFor(identity: GaIdentity | null, country: string | null | undefined): 'GRANTED' | 'DENIED' {
  if (identity?.adConsent === 'granted') return 'GRANTED';
  if (identity?.adConsent === 'denied') return 'DENIED';
  const c = (country ?? '').trim().toLowerCase();
  return c && !EEA_UK_CH.has(c) ? 'GRANTED' : 'DENIED';
}

// A booking we have no GA visitor for still counts: a deterministic synthetic id (retries reuse
// it), derived from the ledger key, never from anything personal.
const clientIdFor = (identity: GaIdentity | null, eventKey: string): string =>
  identity?.clientId ?? `srv.${sha(eventKey).slice(0, 16)}`;

export function bookingFacts(b: Booking): PurchaseFacts {
  const v = projectBooking(b);
  const chauffeur = b.mode === 'trip' && (b.input as { serviceType?: string }).serviceType === 'chauffeur';
  return purchaseFacts({
    service: b.mode === 'single' ? 'transfer' : b.mode === 'shared' ? 'shared_seat' : chauffeur ? 'chauffeur' : 'trip',
    stops: v.stops,
    pax: v.travellers,
    vehicle: v.vehicleType,
    date: v.date,
  });
}

const itemFor = (f: PurchaseFacts, value: number): Ga4Item => ({
  item_id: cut(f.route), item_name: cut(f.route), item_category: f.service_type, price: value, quantity: 1,
});

function factParams(f: PurchaseFacts, at: Date): Record<string, string | number> {
  const p: Record<string, string | number> = {
    service_type: f.service_type, route: cut(f.route), region_route: cut(f.region_route),
    pickup: f.pickup, dropoff: f.dropoff, pickup_region: f.pickup_region, dropoff_region: f.dropoff_region,
    vehicle_type: f.vehicle_type,
  };
  if (f.pax != null) p.pax = f.pax;
  if (f.travel_date) {
    p.travel_month = f.travel_date.slice(0, 7);
    p.days_to_travel = Math.max(0, Math.round((Date.parse(f.travel_date) - Date.parse(at.toISOString().slice(0, 10))) / 86_400_000));
  }
  return p;
}

function checked(e: Ga4Event): Ga4Event {
  const n = Object.keys(e.params).length;
  if (n > MAX_PARAMS) throw new Error(`ga4_too_many_params_${n}`);
  for (const v of Object.values(e.params)) {
    if (typeof v === 'string' && v.length > MAX_STRING) throw new Error('ga4_param_too_long');
  }
  return e;
}

const countryOf = (b: Booking): string =>
  b.billing?.country ?? (b.input.customer as { country?: string }).country ?? '';

export interface PurchaseHitInput {
  booking: Booking; payment: Payment; settledAt: Date; identity: GaIdentity | null;
  returning: boolean; secondPayment: boolean; eventName: Ga4PurchaseName;
}

export function purchaseHit(i: PurchaseHitInput): Ga4Hit {
  const b = i.booking;
  const facts = bookingFacts(b);
  const value = usd(i.payment.amount);
  const promo = promoDiscount(b);
  const country = countryOf(b);
  const consent = consentFor(i.identity, country);
  const params: Ga4Event['params'] = {
    transaction_id: i.secondPayment ? `${b.reference}-${i.payment.id.slice(0, 6)}` : b.reference,
    value,
    currency: i.payment.currency,
    payment_type: i.payment.amount < b.total ? 'deposit' : 'full',
    ...(i.identity?.sessionId ? { session_id: i.identity.sessionId } : {}),
    engagement_time_msec: 1,
    items: [itemFor(facts, value)],
    ...factParams(facts, i.settledAt),
    booking_total: usd(b.total),
    ...(promo ? { coupon: cut(promo.code), discount: usd(promo.cents) } : {}),
    ...(country ? { customer_country: cut(country) } : {}),
    customer_type: i.returning ? 'returning' : 'new',
    channel: b.channel,
  };
  return {
    client_id: clientIdFor(i.identity, `purchase:${i.payment.id}`),
    timestamp_micros: micros(i.settledAt),
    consent: { ad_user_data: consent, ad_personalization: consent },
    events: [checked({ name: i.eventName, params })],
  };
}

export interface RefundHitInput { booking: Booking; refund: Refund; identity: GaIdentity | null; at: Date }

// A reason is free text typed by ops; drop it rather than risk an email or phone number in GA4.
const CONTACT_LIKE = /@|\d[\d\s-]{6,}\d/;

export function refundHit(i: RefundHitInput): Ga4Hit {
  const b = i.booking;
  const facts = bookingFacts(b);
  const value = usd(i.refund.amountCents);
  const consent = consentFor(i.identity, countryOf(b));
  const reason = i.refund.reason && !CONTACT_LIKE.test(i.refund.reason) ? cut(i.refund.reason) : null;
  return {
    client_id: clientIdFor(i.identity, `refund:${i.refund.id}`),
    timestamp_micros: micros(i.at),
    consent: { ad_user_data: consent, ad_personalization: consent },
    events: [checked({
      name: 'refund',
      params: {
        transaction_id: b.reference,
        value,
        currency: i.refund.currency,
        ...(i.identity?.sessionId ? { session_id: i.identity.sessionId } : {}),
        engagement_time_msec: 1,
        items: [itemFor(facts, value)],
        ...(reason ? { refund_reason: reason } : {}),
      },
    })],
  };
}

export interface BoardHitInput {
  list: RideList; member: RideMember; amountCents: number; currency: string; at: Date; eventName: Ga4PurchaseName;
}

export function boardHit(i: BoardHitInput): Ga4Hit {
  const facts = purchaseFacts({ service: 'shared_seat', stops: [i.list.fromPlace, i.list.toPlace], pax: i.member.seats, vehicle: null, date: i.list.date });
  const value = usd(i.amountCents);
  const consent = consentFor(null, i.member.country);
  return {
    client_id: clientIdFor(null, `board:${i.list.id}:${i.member.sub}`),
    timestamp_micros: micros(i.at),
    consent: { ad_user_data: consent, ad_personalization: consent },
    events: [checked({
      name: i.eventName,
      params: {
        transaction_id: `${i.list.code}-${sha(i.member.sub).slice(0, 8)}`,
        value,
        currency: i.currency,
        payment_type: 'full',
        engagement_time_msec: 1,
        items: [itemFor(facts, value)],
        ...factParams(facts, i.at),
        booking_total: value,
        ...(i.member.country ? { customer_country: cut(i.member.country) } : {}),
        channel: 'ride_board',
      },
    })],
  };
}
```

- [ ] **Step 4: Run.**
  - Run: `cd api && npx vitest run src/services/analytics/ga4Hits.test.ts && npx tsc --noEmit -p .`
  - Expected: PASS (8), no type errors. (If `tsc` reports an import cycle through `routes/bookings`, it is runtime-safe: `ga4Hits` is not imported by `bookings.ts`. Keep it.)
- [ ] **Step 5: Commit.**

```bash
cd /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/ga4-server || exit 1
$GIT add api/src/services/analytics/ga4Hits.ts api/src/services/analytics/ga4Hits.test.ts
$GIT commit -m "feat(ga4): pure, limit-checked purchase/refund/board hits — no personal data"
```

### Task 7: `Ga4Reporter`: identity, exactly-once send, sweep

**Files:**
- Create: `api/src/services/analytics/ga4Reporter.ts`
- Create: `api/src/services/analytics/ga4Reporter.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 5 and 6; `BookingRepo.listByPersonKey` and `personKeyFor` (`api/src/db/bookingRepo.ts:29, 266`); `PaymentRepo.findByBookingId` / `findByBookingIds`; `AlertAdapter`; `isTeamEmail`.
- Produces:

```ts
export interface Ga4Reporter {
  rememberVisitor(bookingId: string, raw: unknown): Promise<void>;
  reportPayment(booking: Booking, payment: Payment, settledAt: Date): Promise<void>;
  reportRefund(booking: Booking, refund: Refund): Promise<void>;
  reportBoardCharge(list: RideList, member: RideMember, amountCents: number, currency: string, at: Date): Promise<void>;
  sweep(): Promise<{ retried: number; sent: number; failed: number }>;
}
export interface Ga4ReporterDeps {
  adapter?: Ga4Adapter; log: Ga4EventLogRepo; identities: GaIdentityRepo; bookings: BookingRepo;
  payments: PaymentRepo; alerts: AlertAdapter; teamEmails: ReadonlySet<string>;
  eventName: Ga4PurchaseName; now?: () => Date;
}
export function parseGaIdentity(raw: unknown): GaIdentity | null;
export function createGa4Reporter(deps: Ga4ReporterDeps): Ga4Reporter;
export const MP_BACKDATE_MS: number; // 72 h
```

- [ ] **Step 1: Failing test.** Create `ga4Reporter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { FakeGa4Adapter } from '../../adapters/ga4';
import { FakeAlertAdapter } from '../../adapters/alerts';
import { InMemoryGa4EventLogRepo, InMemoryGaIdentityRepo } from '../../db/ga4Repo';
import { InMemoryBookingRepo, type Booking } from '../../db/bookingRepo';
import { InMemoryPaymentRepo, type Payment } from '../../db/paymentRepo';
import type { RideList, RideMember } from '../../domain/rideList';
import { createGa4Reporter, parseGaIdentity } from './ga4Reporter';

const NOW = new Date('2026-10-29T08:00:00Z');
const customer = (email: string) => ({ firstName: 'E', lastName: 'L', email, phoneCountryCode: '+44', phoneNumber: '7700900000', country: 'United Kingdom' });
const booking = (email = 'emma@example.test', over: Partial<Booking> = {}) => ({
  id: 'b-1', reference: 'CH-TEST1', status: 'paid', mode: 'single', channel: 'website', currency: 'USD', total: 22900, amountDueNow: 22900,
  createdAt: '2026-10-28T10:00:00.000Z',
  input: { customer: customer(email), from: 'Colombo Airport (CMB)', to: 'Galle', date: '2026-11-08', time: '09:00', adults: 2, children: 0, bags: 2, vehicleType: 'car' },
  ...over,
}) as unknown as Booking;
const payment = { id: 'pay-1', bookingId: 'b-1', provider: 'payhere', orderId: 'CH-TEST1', amount: 22900, currency: 'USD', idempotencyKey: 'k', status: 'succeeded', attemptCount: 1, lastAttemptAt: null } as Payment;

function setup(opts: { adapter?: FakeGa4Adapter | null; team?: string[] } = {}) {
  const adapter = opts.adapter === null ? undefined : (opts.adapter ?? new FakeGa4Adapter());
  const log = new InMemoryGa4EventLogRepo();
  const identities = new InMemoryGaIdentityRepo();
  const alerts = new FakeAlertAdapter();
  const reporter = createGa4Reporter({
    adapter, log, identities, bookings: new InMemoryBookingRepo(), payments: new InMemoryPaymentRepo(), alerts,
    teamEmails: new Set(opts.team ?? ['roshenw@gmail.com']), eventName: 'purchase_server', now: () => NOW,
  });
  return { reporter, adapter, log, identities, alerts };
}

describe('parseGaIdentity', () => {
  it('keeps only well-formed ids; nothing to send is null', () => {
    expect(parseGaIdentity({ clientId: '1.2', sessionId: '1761724800', adConsent: 'granted' })).toEqual({ clientId: '1.2', sessionId: '1761724800', adConsent: 'granted' });
    expect(parseGaIdentity({ clientId: 'x.y', sessionId: '12', adConsent: 'maybe' })).toBeNull();
    expect(parseGaIdentity({ clientId: '1.2', adConsent: 'maybe' })).toEqual({ clientId: '1.2', sessionId: null, adConsent: 'unknown' });
    expect(parseGaIdentity(undefined)).toBeNull();
  });
});

describe('Ga4Reporter', () => {
  it('reports a payment once, joined to the remembered visit', async () => {
    const { reporter, adapter, identities } = setup();
    await reporter.rememberVisitor('b-1', { clientId: '123.456', sessionId: '1761724800', adConsent: 'unknown' });
    expect(await identities.get('b-1')).toEqual({ clientId: '123.456', sessionId: '1761724800', adConsent: 'unknown' });
    await reporter.reportPayment(booking(), payment, NOW);
    await reporter.reportPayment(booking(), payment, NOW); // a replayed hook
    expect(adapter!.sent).toHaveLength(1);
    expect(adapter!.sent[0]).toMatchObject({ client_id: '123.456', events: [{ name: 'purchase_server' }] });
  });
  it('never reports a team test booking', async () => {
    const { reporter, adapter } = setup();
    await reporter.reportPayment(booking('Roshenw@Gmail.com'), payment, NOW);
    expect(adapter!.sent).toHaveLength(0);
  });
  it('without a secret it sends and claims nothing — but still remembers the visitor', async () => {
    const { reporter, log, identities } = setup({ adapter: null });
    await reporter.rememberVisitor('b-1', { clientId: '1.2' });
    await reporter.reportPayment(booking(), payment, NOW);
    expect(await identities.get('b-1')).not.toBeNull();
    expect(await log.listRetryable(new Date(0), new Date(NOW.getTime() + 3_600_000))).toEqual([]);
  });
  it('a failed send is retried by the sweep with the SAME hit, and alerts once at 5 attempts', async () => {
    const adapter = new FakeGa4Adapter();
    adapter.failNext = 5;
    const { reporter, alerts } = setup({ adapter });
    await reporter.reportPayment(booking(), payment, NOW); // attempt 1 fails
    for (let i = 0; i < 4; i++) await reporter.sweep(); // attempts 2-5 fail
    expect(alerts.sent.filter((a) => a.kind === 'ga4_send_failed')).toHaveLength(1);
    const res = await reporter.sweep(); // attempt 6 succeeds
    expect(res).toEqual({ retried: 1, sent: 1, failed: 0 });
    expect(adapter.sent).toHaveLength(1);
  });
  it('reports a ride-board charge, skipping a team member', async () => {
    const { reporter, adapter } = setup();
    const list = { id: 'l1', code: 'EM-1', fromPlace: 'Ella', toPlace: 'Mirissa', date: '2026-11-08' } as RideList;
    await reporter.reportBoardCharge(list, { sub: 's1', email: 'a@x.com', country: 'Australia', seats: 1 } as RideMember, 2400, 'USD', NOW);
    await reporter.reportBoardCharge(list, { sub: 's2', email: 'roshenw@gmail.com', country: 'LK', seats: 1 } as RideMember, 2400, 'USD', NOW);
    expect(adapter!.sent).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run and watch it fail.**
  - Run: `cd api && npx vitest run src/services/analytics/ga4Reporter.test.ts`
  - Expected: FAIL, module missing.

- [ ] **Step 3: Implement.** Create `ga4Reporter.ts`:

```ts
// The one door to GA4 (spec 2026-10-03 §5.1). Hooks call it fire-and-forget; it never throws
// into the money path's awaited code, it never reports a team test booking, and it sends each
// event exactly once through the ledger, which also stores the hit for the cron sweep's retries.

import type { Ga4Adapter, Ga4Hit } from '../../adapters/ga4';
import type { AlertAdapter } from '../../adapters/alerts';
import { personKeyFor, type Booking, type BookingRepo } from '../../db/bookingRepo';
import type { AdConsent, Ga4EventKind, Ga4EventLogRepo, GaIdentity, GaIdentityRepo } from '../../db/ga4Repo';
import type { Payment, PaymentRepo } from '../../db/paymentRepo';
import type { Refund } from '../../db/refundRepo';
import type { RideList, RideMember } from '../../domain/rideList';
import { isTeamEmail } from '../testBookings';
import { boardHit, purchaseHit, refundHit, type Ga4PurchaseName } from './ga4Hits';

/** Measurement Protocol accepts timestamps at most 72 h old; older events can never be sent. */
export const MP_BACKDATE_MS = 72 * 60 * 60 * 1000;
const ALERT_AT_ATTEMPT = 5;

export interface Ga4Reporter {
  rememberVisitor(bookingId: string, raw: unknown): Promise<void>;
  reportPayment(booking: Booking, payment: Payment, settledAt: Date): Promise<void>;
  reportRefund(booking: Booking, refund: Refund): Promise<void>;
  reportBoardCharge(list: RideList, member: RideMember, amountCents: number, currency: string, at: Date): Promise<void>;
  sweep(): Promise<{ retried: number; sent: number; failed: number }>;
}

export interface Ga4ReporterDeps {
  adapter?: Ga4Adapter;
  log: Ga4EventLogRepo;
  identities: GaIdentityRepo;
  bookings: BookingRepo;
  payments: PaymentRepo;
  alerts: AlertAdapter;
  teamEmails: ReadonlySet<string>;
  eventName: Ga4PurchaseName;
  now?: () => Date;
}

const CLIENT_ID = /^\d{1,20}\.\d{1,20}$/;
const SESSION_ID = /^\d{6,12}$/;

/** The browser's `ga` checkout field (analytics.js chGaIds), validated. Null = nothing usable. */
export function parseGaIdentity(raw: unknown): GaIdentity | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const clientId = typeof r.clientId === 'string' && CLIENT_ID.test(r.clientId) ? r.clientId : null;
  const sessionId = typeof r.sessionId === 'string' && SESSION_ID.test(r.sessionId) ? r.sessionId : null;
  const adConsent: AdConsent = r.adConsent === 'granted' || r.adConsent === 'denied' ? r.adConsent : 'unknown';
  return clientId || sessionId ? { clientId, sessionId, adConsent } : null;
}

export function createGa4Reporter(deps: Ga4ReporterDeps): Ga4Reporter {
  const now = deps.now ?? (() => new Date());

  async function attempt(eventKey: string, kind: Ga4EventKind, payload: unknown): Promise<'sent' | 'failed' | 'skipped'> {
    if (!deps.adapter) return 'skipped';
    const at = now();
    const claim = await deps.log.claim(eventKey, kind, payload, at);
    if (!claim) return 'skipped';
    try {
      await deps.adapter.send(claim.payload as Ga4Hit);
      await deps.log.markSent(eventKey, at);
      return 'sent';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await deps.log.markFailed(eventKey, msg);
      if (claim.attempts === ALERT_AT_ATTEMPT) {
        await deps.alerts.send({
          severity: 'warning',
          kind: 'ga4_send_failed',
          title: `GA4 could not record ${eventKey} after ${ALERT_AT_ATTEMPT} tries`,
          body: `Last error: ${msg}. The sweep keeps retrying for 72 h; after that GA4 can never receive it (revenue still in the database).`,
          dedupeKey: `ga4:${eventKey}`,
        }).catch(() => {});
      }
      return 'failed';
    }
  }

  async function returningBuyer(b: Booking): Promise<boolean> {
    const mine = await deps.bookings.listByPersonKey(personKeyFor(b.input.customer.email), 25);
    const earlier = mine.filter((x) => x.id !== b.id && Date.parse(x.createdAt) < Date.parse(b.createdAt));
    if (!earlier.length) return false;
    const paid = await deps.payments.findByBookingIds(earlier.map((x) => x.id));
    return paid.some((p) => p.status === 'succeeded');
  }

  return {
    async rememberVisitor(bookingId, raw) {
      const id = parseGaIdentity(raw);
      if (id) await deps.identities.set(bookingId, id);
    },

    async reportPayment(booking, payment, settledAt) {
      if (!deps.adapter || isTeamEmail(booking.input.customer.email, deps.teamEmails)) return;
      const siblings = await deps.payments.findByBookingId(booking.id);
      const secondPayment = siblings.some((p) => p.id !== payment.id && p.status === 'succeeded');
      const hit = purchaseHit({
        booking, payment, settledAt,
        identity: await deps.identities.get(booking.id),
        returning: await returningBuyer(booking),
        secondPayment,
        eventName: deps.eventName,
      });
      await attempt(`purchase:${payment.id}`, 'purchase', hit);
    },

    async reportRefund(booking, refund) {
      if (!deps.adapter || isTeamEmail(booking.input.customer.email, deps.teamEmails)) return;
      const hit = refundHit({ booking, refund, identity: await deps.identities.get(booking.id), at: now() });
      await attempt(`refund:${refund.id}`, 'refund', hit);
    },

    async reportBoardCharge(list, member, amountCents, currency, at) {
      if (!deps.adapter || isTeamEmail(member.email, deps.teamEmails)) return;
      const hit = boardHit({ list, member, amountCents, currency, at, eventName: deps.eventName });
      await attempt(`board:${list.id}:${member.sub}`, 'board_purchase', hit);
    },

    async sweep() {
      const at = now();
      const rows = await deps.log.listRetryable(new Date(at.getTime() - MP_BACKDATE_MS), at);
      let sent = 0;
      let failed = 0;
      for (const row of rows) {
        const outcome = await attempt(row.eventKey, row.kind, row.payload);
        if (outcome === 'sent') sent++;
        if (outcome === 'failed') failed++;
      }
      return { retried: rows.length, sent, failed };
    },
  };
}
```

- [ ] **Step 4: Run.**
  - Run: `cd api && npx vitest run src/services/analytics/ga4Reporter.test.ts && npx tsc --noEmit -p .`
  - Expected: PASS (6), no type errors.
- [ ] **Step 5: Commit.**

```bash
cd /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/ga4-server || exit 1
$GIT add api/src/services/analytics/ga4Reporter.ts api/src/services/analytics/ga4Reporter.test.ts
$GIT commit -m "feat(ga4): reporter — exactly-once sends, test bookings skipped, cron-retried"
```

### Task 8: Wire the hooks: checkout capture, webhook, mark-paid, refund, board, sweep

**Files:**
- Modify: `api/src/app.ts` (`AppDeps`, lines 74-169; defaults after `const alerts = …`, line ~239; `bookingRoutes(...)` 459-481; `webhookRoutes(...)` ~538-553; `adminRoutes(...)` ~643-670)
- Modify: `api/src/routes/bookings.ts` (deps type 262-292; checkout body parse, line ~1043)
- Modify: `api/src/routes/webhooks.ts` (deps type 149-177; settled block after the team alert try/catch, ~440)
- Modify: `api/src/routes/admin.ts` (deps type 43-61; `afterRefundConfirmed` end ~297; mark-paid after `claimWonQuote`, ~546; `/jobs/notifications` cutoff call + response, ~596-660)
- Modify: `api/src/services/rideBoardCutoff.ts` (deps type; confirmed branch after the team alert, ~226)
- Create: `api/src/routes/ga4Hooks.test.ts`
- Modify: `api/src/services/rideBoardCutoff.test.ts`

- [ ] **Step 1: Failing route test.** Create `api/src/routes/ga4Hooks.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { FakePaymentAdapter } from '../adapters/payments';
import { FakeGa4Adapter } from '../adapters/ga4';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryGa4EventLogRepo, InMemoryGaIdentityRepo } from '../db/ga4Repo';
import { futureIsoDate } from '../testSupport/dates';

// Verbatim from webhooks.test.ts:19-29 (origin/main @ b43cd9ae) — a bookable single transfer.
const valid = {
  from: 'Colombo Airport (CMB)',
  to: 'Ella',
  date: futureIsoDate(30), // anchored to "now" so the past-date rule never expires it
  time: '09:00',
  vehicleType: 'car',
  adults: 2,
  children: 0,
  bags: 2,
  customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
};

function ga4App() {
  const adapter = new FakePaymentAdapter();
  const ga4Adapter = new FakeGa4Adapter();
  const gaIdentities = new InMemoryGaIdentityRepo();
  const bookings = new InMemoryBookingRepo();
  const app = createApp({ adapter, bookings, ga4Adapter, ga4Log: new InMemoryGa4EventLogRepo(), gaIdentities, ga4EventName: 'purchase_server' });
  return { app, adapter, ga4Adapter, gaIdentities, bookings };
}

async function bookAndCheckout(app: ReturnType<typeof createApp>, ga?: unknown) {
  const b = await (await app.request('/bookings/single', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(valid),
  })).json();
  await app.request(`/bookings/${b.id}/checkout`, {
    method: 'POST',
    headers: { authorization: `Bearer ${b.checkoutToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(ga === undefined ? { returnTo: 'manage' } : { returnTo: 'manage', ga }),
  });
  return b;
}
const flush = () => new Promise((r) => setTimeout(r, 20)); // hooks are fire-and-forget

describe('server-side GA4 hooks', () => {
  it('checkout remembers the GA visitor; malformed ids are ignored and never fail the checkout', async () => {
    const { app, gaIdentities } = ga4App();
    const b = await bookAndCheckout(app, { clientId: '123.456', sessionId: '1761724800', adConsent: 'granted' });
    await flush();
    expect(await gaIdentities.get(b.id)).toEqual({ clientId: '123.456', sessionId: '1761724800', adConsent: 'granted' });
    const bad = await bookAndCheckout(app, { clientId: '<script>', sessionId: 'x' });
    await flush();
    expect(await gaIdentities.get(bad.id)).toBeNull();
  });

  it('a settled PayHere webhook reports exactly one purchase_server, joined to the visit', async () => {
    const { app, adapter, ga4Adapter } = ga4App();
    const b = await bookAndCheckout(app, { clientId: '123.456', sessionId: '1761724800' });
    const body = adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency });
    expect((await app.request('/webhooks/payments', { method: 'POST', body })).status).toBe(200);
    expect((await app.request('/webhooks/payments', { method: 'POST', body })).status).toBe(200); // PayHere retry
    await flush();
    expect(ga4Adapter.sent).toHaveLength(1);
    expect(ga4Adapter.sent[0]).toMatchObject({ client_id: '123.456', events: [{ name: 'purchase_server', params: { transaction_id: b.reference, value: b.total / 100 } }] });
  });

  it('a failed GA4 send never changes the webhook answer or the booking', async () => {
    const { app, adapter, ga4Adapter, bookings } = ga4App();
    ga4Adapter.failNext = 1;
    const b = await bookAndCheckout(app);
    const body = adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency });
    expect((await app.request('/webhooks/payments', { method: 'POST', body })).status).toBe(200);
    await flush();
    expect((await bookings.get(b.id))!.status).toBe('paid');
  });
});
```

  If `webhooks.test.ts`'s `valid` has changed since b43cd9ae, copy the current one. It is the source of truth for a bookable single transfer.

- [ ] **Step 2: Run and watch it fail.**
  - Run: `cd api && npx vitest run src/routes/ga4Hooks.test.ts`
  - Expected: FAIL. TypeScript rejects the unknown `createApp` deps `ga4Adapter`/`ga4Log`/`gaIdentities`/`ga4EventName`, or no identity/hit is recorded.

- [ ] **Step 3: `app.ts`.**
  - Imports:

```ts
import type { Ga4Adapter } from './adapters/ga4';
import type { Ga4EventLogRepo, GaIdentityRepo } from './db/ga4Repo';
import { createGa4Reporter } from './services/analytics/ga4Reporter';
```

  - In `AppDeps`, after `teamEmails?: ReadonlySet<string>;`:

```ts
  // Server-side GA4 (spec 2026-10-03). Without ga4Log + gaIdentities nothing is wired; without
  // ga4Adapter ids are captured but nothing is sent. Tests inject FakeGa4Adapter + in-memory repos.
  ga4Adapter?: Ga4Adapter;
  ga4Log?: Ga4EventLogRepo;
  gaIdentities?: GaIdentityRepo;
  ga4EventName?: 'purchase' | 'purchase_server';
```

  - After `const alerts = deps.alerts ?? new LogAlertAdapter();`:

```ts
  const ga4 = deps.ga4Log && deps.gaIdentities
    ? createGa4Reporter({
        adapter: deps.ga4Adapter, log: deps.ga4Log, identities: deps.gaIdentities, bookings, payments, alerts,
        teamEmails: deps.teamEmails ?? config.TEAM_EMAILS,
        eventName: deps.ga4EventName ?? config.GA4_SERVER_EVENT_NAME,
      })
    : undefined;
```

  (`bookings` and `payments` are the defaulted repos already used by `bookingRoutes`. If they are declared below this line, move this block directly after their declarations.)

  - Add `...(ga4 ? { ga4 } : {}),` as the last entry of the `bookingRoutes({ … })`, `webhookRoutes({ … })` and `adminRoutes({ … })` argument objects.

- [ ] **Step 4: `bookings.ts`.**
  - Import the type: `import type { Ga4Reporter } from '../services/analytics/ga4Reporter';`
  - Add to the deps type, after `checkoutEvents?: BookingCheckoutEventRepo;`:

```ts
  // Server-side GA4: remembers the checkout's GA visitor. Unset → nothing captured.
  ga4?: Ga4Reporter;
```

  - Change the checkout body parse (line ~1043) to:

```ts
    const body = (await c.req.json().catch(() => null)) as { returnTo?: unknown; ga?: unknown } | null;
    // The GA visitor this checkout comes from (analytics.js chWithGa), so the server's purchase
    // joins that visit. Best-effort and not awaited: analytics never delays or fails a checkout.
    if (deps.ga4 && body?.ga !== undefined) {
      void deps.ga4.rememberVisitor(booking.id, body.ga).catch((err) => console.error('ga4 visitor capture failed:', err));
    }
```

- [ ] **Step 5: `webhooks.ts`.**
  - Import `import type { Ga4Reporter } from '../services/analytics/ga4Reporter';`
  - Add `ga4?: Ga4Reporter;` to the deps type, after `duplicates?: …;`. Then, in the `outcome.kind === 'settled'` block, directly **after** the team "Paid:" alert's `try { … } catch (err) { … }`, add:

```ts
      // Server-side GA4 purchase (spec 2026-10-03). After everything the paid booking needs and
      // not awaited — PayHere must get its 200 regardless. A replay never gets here (duplicate).
      if (deps.ga4) {
        void deps.ga4.reportPayment(paid, outcome.payment, event.receivedAt).catch((err) => {
          console.error(`ga4 purchase report failed for ${paid.reference}:`, err);
        });
      }
```

- [ ] **Step 6: `admin.ts`.**
  - Import `import type { Ga4Reporter } from '../services/analytics/ga4Reporter';`
  - Add `ga4?: Ga4Reporter;` to the `adminRoutes` deps type, after `checkoutEvents?: …;`.
  - At the end of `afterRefundConfirmed`, after its last `try { … } catch …`, add:

```ts
    if (deps.ga4) {
      void deps.ga4.reportRefund(after, outcome.refund).catch((err) => {
        console.error(`ga4 refund report failed for ${after.reference}:`, err);
      });
    }
```

  - In mark-paid, directly after `await claimWonQuote(booking.id, deps);`, add:

```ts
    // Server-side GA4: cash and bank transfers are revenue too. transitionPaymentId is the
    // manual payment this request recorded (or claimed); the repair path reports nothing new.
    if (deps.ga4 && transitionPaymentId) {
      const settled = (await deps.payments.findByBookingId(booking.id)).find((p) => p.id === transitionPaymentId);
      if (settled && settled.status === 'succeeded') {
        void deps.ga4.reportPayment(paid, settled, new Date()).catch((err) => {
          console.error(`ga4 purchase report failed for ${paid.reference}:`, err);
        });
      }
    }
```

  - In `/jobs/notifications`:
    - add `ga4: deps.ga4` to the `runRideBoardCutoff(new Date(), { … })` deps object;
    - before the final `return c.json(`, add:

```ts
    // GA4 retries ride the same tick, best-effort.
    let ga4 = { retried: 0, sent: 0, failed: 0 };
    if (deps.ga4) {
      try {
        ga4 = await deps.ga4.sweep();
      } catch (err) {
        console.error('ga4 sweep failed:', err);
      }
    }
```

    - add `ga4,` to the returned object (next to `rideBoard,`).

- [ ] **Step 7: `rideBoardCutoff.ts`.**
  - Import the type: `import type { Ga4Reporter } from './analytics/ga4Reporter';`
  - Add to `RideBoardCutoffDeps`:

```ts
  // Server-side GA4: each successfully charged seat is a purchase. Unset → nothing reported.
  ga4?: Ga4Reporter;
```

  - In the `ranThisList` branch, after the team `ride_board_locked` alert block, add:

```ts
      // Only charges whose outcome we KNOW — an `unknown` charge may be refunded by hand, and a
      // called-off van (the other branch) refunds everyone, so neither is revenue to report.
      if (deps.ga4) {
        const unsure = new Set(indeterminate.map((i) => i.member.sub));
        for (const m of chargedOk) {
          if (unsure.has(m.sub)) continue;
          void deps.ga4.reportBoardCharge(list, m, list.seatPrice * m.seats, currency, now).catch((err) => {
            console.error(`ga4 board report failed for ${list.code}:`, err);
          });
        }
      }
```

- [ ] **Step 8: Cutoff test.** In `rideBoardCutoff.test.ts`, inside `describe('runRideBoardCutoff', …)`, add:

```ts
  it('reports each successfully charged seat to GA4 — never an indeterminate charge', async () => {
    const repo = new InMemoryRideListRepo();
    const paygw = new FakeTokenizedPaymentAdapter();
    const email = new FakeEmailAdapter();
    const list = await repo.createList(listArgs());
    await fill(repo, list.id, 4);
    const reported: string[] = [];
    const ga4 = {
      rememberVisitor: async () => {}, reportPayment: async () => {}, reportRefund: async () => {},
      reportBoardCharge: async (_l: unknown, m: { sub: string }) => { reported.push(m.sub); },
      sweep: async () => ({ retried: 0, sent: 0, failed: 0 }),
    };
    await runRideBoardCutoff(NOW, { rideLists: repo, paygw, email, ga4 });
    await new Promise((r) => setTimeout(r, 10));
    expect(reported.sort()).toEqual(['u0', 'u1', 'u2', 'u3']);
  });
```

- [ ] **Step 9: Run.**
  - Run: `cd api && npx vitest run src/routes/ga4Hooks.test.ts src/services/rideBoardCutoff.test.ts && npm run check`
  - Expected: PASS, and `check` exits 0. The existing webhook, admin and cutoff suites are unchanged, because no ga4 deps are passed there.
- [ ] **Step 10: Commit.**

```bash
cd /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/ga4-server || exit 1
$GIT add api/src/app.ts api/src/routes/bookings.ts api/src/routes/webhooks.ts api/src/routes/admin.ts api/src/services/rideBoardCutoff.ts api/src/routes/ga4Hooks.test.ts api/src/services/rideBoardCutoff.test.ts
$GIT commit -m "feat(ga4): report settlements, mark-paid, refunds and board charges; sweep retries"
```

### Task 9: Docs + PR B

**Files:**
- Modify: `docs/analytics/property-tracking.md` (section 6.1, append)

- [ ] **Step 1:** Append to section 6.1:

```md
### 6.1b Server-side purchase (2026-10-03, spec docs/superpowers/specs/2026-10-03-server-side-ga4-purchase-design.md)
The API reports every settled payment (PayHere webhook, ops mark-paid, ride-board charge) and every
confirmed refund via the Measurement Protocol, exactly once (`ga4_event_log`), joined to the checkout
visit (`booking_ga_identity`). Event `purchase_server` while `GA4_SERVER_EVENT_NAME=purchase_server`
(shadow mode); `purchase` after switch-over, when GTM's "GA4 - purchase" tag is paused. Register
(event scope) dimensions `service_type, route, region_route, pickup, dropoff, pickup_region,
dropoff_region, vehicle_type, travel_month, customer_country, customer_type, channel`; metrics `pax`
(Standard), `booking_total` (Currency), `discount` (Currency), `days_to_travel` (Standard).
```

- [ ] **Step 2: Full gate.**
  - `cd api && npm run check`. Expected: exit 0.
  - `npm --prefix …/ga4-server/web-tests run test:all`. Expected: 0 failed.
- [ ] **Step 3: Commit and open the PR.**
  - Commit the doc.
  - Run `gh pr create --repo ceylonhop/ceylon-hop`. The body covers:
    - the spec link;
    - the 4 deviations;
    - **migration 0063** (merging releases it to staging);
    - the red→green evidence per task;
    - the dormant config.
  - End the body with the attribution line.
- [ ] **Step 4: Release.**
  - Merge to `main`. The API goes to staging and migration 0063 is applied there. Check staging `/health` reports the merge sha.
  - The owner merges the promote PR `main → production`: **this releases migration 0063 to prod**.

---

### Task 10: Owner operations: secret, registration, shadow mode, switch-over

No code. Each step names who does it.

- [ ] **Step 1 (owner, GA4):** Admin → Data streams → Ceylon Hop Web → **Measurement Protocol API secrets** → Create, nickname `ceylonhop-api`. Copy the value.
- [ ] **Step 2 (owner, Render, a config change):** on `ceylon-hop-api`, add `GA4_API_SECRET=<value>`. Leave `GA4_SERVER_EVENT_NAME` unset, so it defaults to `purchase_server`. Choose **Save and deploy**.
- [ ] **Step 3 (owner or agent, GA4):** Admin → Custom definitions:
  - create the 12 event-scoped dimensions and 4 metrics listed in Task 9;
  - that makes 26/50 dimensions in use;
  - do **not** mark `purchase_server` as a key event.
- [ ] **Step 4 (verify within 48 h of the first real sale):** Explore → Free form, event name = `purchase_server`, rows *Transaction ID, Route, Session source/medium*, metric *Event value*. The rows exist and match ops "Recently booked" by reference and amount.
- [ ] **Step 5 (shadow mode, about 2 weeks):** the spec §8 go/no-go. For each booking paid in the window, pair the browser `purchase` with `purchase_server` by Transaction ID. **Go when all hold:**
  1. ≥95% of pairs share Session source/medium.
  2. `purchase_server` covers 100% of non-test paid bookings older than 24 h.
  3. Σ `purchase_server` Event value equals Σ succeeded payments in the database for the window.

  If check 1 fails, stop: keep shadow mode and bring the numbers to the owner (spec §8, D1-alt).
- [ ] **Step 6 (switch-over: owner, in the same hour):**
  1. Render: `GA4_SERVER_EVENT_NAME=purchase` → Save and deploy.
  2. GTM: pause **GA4 - purchase** (Google Ads, Meta and TikTok purchase tags stay on the browser event) → preview-test with the session's `gtm_auth` harness → publish.
  3. Re-fetch the live `gtm.js` and confirm the version and that the GA4 purchase tag is paused.
  4. Next day: check GA4 Monetization → Transactions shows each new paid booking **once**.
- [ ] **Step 7 (acceptance, after 14 days on `purchase`):** walk spec §3 stories 1-7, 11, 20, 21, 23 and 27 in the named GA4 places. Record pass or fail per story in the PR B thread.

## Self-review notes

- **Spec coverage:**
  - §5.1 units → Tasks 1, 3, 5, 6, 7, 8 (the sweep is in Task 7 + the Task 8 wiring).
  - §5.2 capture → Tasks 4 and 8.
  - Hooks → Task 8 (webhook `settled` only: deviation 3).
  - §5.3-5.5 → Task 6.
  - §5.6 errors → Task 7 (ledger, alert at 5).
  - §5.7 config → Task 5.
  - §5.8 schema → Task 2 (deviation 1).
  - §5.9 and §8 → Task 10.
  - §6 testing → each task.
- **Known gap kept from the spec:** chargebacks (D4) and board refunds (spec §9) are not sent.
