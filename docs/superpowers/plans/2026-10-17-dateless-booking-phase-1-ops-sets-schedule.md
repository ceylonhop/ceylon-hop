# Dateless booking capture — Phase 1: ops sets the pickup date/time — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An ops agent can set or change a paid single transfer's pickup date/time in the booking sheet. The change is validated, written to both stores in one transaction, recorded in a history table, and optionally confirmed to the customer by email.

**Architecture:** A pure validator (`domain/bookingSchedule.ts`) feeds one guarded repo write (`BookingRepo.setSchedule`). The repo updates `transfer_request` and `booking_legs` and inserts a `booking_schedule_events` row in a single transaction. The update is conditional on the `expected` old value, so a stale edit becomes a 409, not a silent overwrite. A CSRF-guarded ops route calls the repo and sends a best-effort `schedule_set` email. The ops sheet gets a small inline form.

**Tech Stack:** Node 20 · TypeScript strict · Hono · Zod · Vitest · Drizzle + Postgres · vanilla JS in `api/src/routes/ops-ui.html`.

**Spec:** `docs/superpowers/specs/2026-10-17-dateless-booking-capture-design.md`

## Global Constraints

- Work in a worktree off `origin/main`, never the shared tree; stage files by path, never `git add -A`.
- Only `mode = 'single'` bookings with status `paid` or `confirmed` are editable.
- `date` must be a real `YYYY-MM-DD`. `time` must be `HH:MM` (00:00–23:59) or `null`.
- Reject past dates (Asia/Colombo) and anything more than 12 months ahead. The 12 h notice rule (`isTooSoonPrivate`) applies to **customers** (Phase 4); **ops may set short notice** (a same-day fix after a WhatsApp call), via `allowShortNotice`.
- Every write carries `expected: { date, time }`. A mismatch is a `409 { error: 'conflict', current }`.
- Every applied change inserts one `booking_schedule_events` row.
- The customer email is best-effort and never fails the write.
- **This phase ships a migration** (`0072_booking_schedule_events`). Merging to `main` applies it on staging boot. Production gets it only through the owner-approved `main → production` promotion. Flag it in the PR body.
- If `main` already has a `0072`, renumber to the next free index **and** give the journal `when` a value larger than the last entry's (drizzle skips an older `when`).
- The gate before every commit is `cd api && npm run check`, plus `npm --prefix <abs-path>/web-tests run test:all`.

---

## File map

| File | Change |
|---|---|
| `api/src/domain/bookingSchedule.ts` | **Create.** `SCHEDULE_PROBLEMS`, `ScheduleProblem`, `scheduleProblem()` |
| `api/src/domain/bookingSchedule.test.ts` | **Create.** Validator tests |
| `api/drizzle/0072_booking_schedule_events.sql` | **Create.** Table + RLS + widen the `customer_communications` kind check |
| `api/drizzle/meta/_journal.json` | Append entry 72 |
| `api/src/db/schema.ts` | Add `bookingScheduleEvents`; add `'schedule_set'` to the kind check |
| `api/src/db/bookingRepo.ts` | Types + `setSchedule` / `listScheduleEvents` on the interface and the in-memory repo |
| `api/src/db/postgresBookingRepo.ts` | Postgres `setSchedule` / `listScheduleEvents` |
| `api/src/db/bookingSchedule.test.ts` | **Create.** One contract, run on both repos |
| `api/src/adapters/email.ts` | `'schedule_set'` kind |
| `api/src/domain/trackingContract.ts` (+ `.test.ts`) | `'schedule_set'` kind |
| `api/src/services/notifications.ts` (+ `.test.ts`) | Tracking default + `sendScheduleSet()` |
| `api/src/routes/devEmails.ts` | Preview entry |
| `api/src/routes/ops.ts` | `allowedOrigins` dep, `csrf`, `POST /bookings/:id/schedule`, `scheduleEvents` in the detail |
| `api/src/app.ts` | Pass `allowedOrigins` to `opsRoutes` |
| `api/src/routes/ops.schedule.test.ts` | **Create.** Route tests |
| `api/src/routes/ops-ui.html` | Sheet form, `SCHED_ERR`, actions, activity lines |
| `api/src/routes/opsUi.schedule.test.ts` | **Create.** Ops shell tests |

---

### Task 1: Schedule validator

**Files:**
- Create: `api/src/domain/bookingSchedule.ts`
- Test: `api/src/domain/bookingSchedule.test.ts`

**Interfaces:**
- Consumes: `isoToday`, `isTooSoonPrivate` from `api/src/domain/dateRules.ts`
- Produces: `SCHEDULE_PROBLEMS` (readonly tuple), `type ScheduleProblem`, `scheduleProblem(date: string, time: string | null, now?: Date, opts?: { allowShortNotice?: boolean }): ScheduleProblem | null`

- [ ] **Step 1: Write the failing test**

```ts
// api/src/domain/bookingSchedule.test.ts
import { describe, it, expect } from 'vitest';
import { scheduleProblem, SCHEDULE_PROBLEMS } from './bookingSchedule';

// 06:00Z = 11:30 in Colombo on 2026-10-17.
const NOW = new Date('2026-10-17T06:00:00Z');

describe('scheduleProblem', () => {
  it('accepts a future date with a time, and one without', () => {
    expect(scheduleProblem('2026-10-18', '09:00', NOW)).toBeNull();
    expect(scheduleProblem('2026-10-20', null, NOW)).toBeNull();
  });

  it('rejects malformed or impossible dates and times', () => {
    expect(scheduleProblem('18/10/2026', null, NOW)).toBe('bad_date');
    expect(scheduleProblem('2026-02-30', null, NOW)).toBe('bad_date');
    expect(scheduleProblem('2026-10-20', '9am', NOW)).toBe('bad_time');
    expect(scheduleProblem('2026-10-20', '24:00', NOW)).toBe('bad_time');
  });

  it('rejects a date that has passed in Colombo', () => {
    expect(scheduleProblem('2026-10-16', '09:00', NOW)).toBe('past');
  });

  it('applies the 12-hour notice rule, and refuses today without a time', () => {
    expect(scheduleProblem('2026-10-17', '20:00', NOW)).toBe('too_soon'); // 8.5 h away
    expect(scheduleProblem('2026-10-17', null, NOW)).toBe('too_soon');
  });

  it('lets ops waive the notice rule, but never accept a past date', () => {
    expect(scheduleProblem('2026-10-17', '20:00', NOW, { allowShortNotice: true })).toBeNull();
    expect(scheduleProblem('2026-10-16', '09:00', NOW, { allowShortNotice: true })).toBe('past');
  });

  it('allows up to 12 months ahead and no further (booking.js maxBookDate)', () => {
    expect(scheduleProblem('2027-10-17', null, NOW)).toBeNull();
    expect(scheduleProblem('2027-10-18', null, NOW)).toBe('too_far');
  });

  it('names every problem it can return', () => {
    expect([...SCHEDULE_PROBLEMS]).toEqual(['bad_date', 'bad_time', 'past', 'too_soon', 'too_far']);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd api && npx vitest run src/domain/bookingSchedule.test.ts`
Expected: FAIL, because `./bookingSchedule` cannot be resolved.

- [ ] **Step 3: Implement**

```ts
// api/src/domain/bookingSchedule.ts
import { isoToday, isTooSoonPrivate } from './dateRules';

// What a pickup date/time set AFTER booking must satisfy (spec 2026-10-17 §4) — the same limits
// the booking page applies: 12 h notice (isTooSoonPrivate), at most 12 months out (booking.js
// maxBookDate), all on the Colombo calendar. One list, so the ops sheet can name every refusal.
export const SCHEDULE_PROBLEMS = ['bad_date', 'bad_time', 'past', 'too_soon', 'too_far'] as const;
export type ScheduleProblem = (typeof SCHEDULE_PROBLEMS)[number];

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// "2026-02-30" passes the regex but not the calendar: Date rolls it into March.
function isRealDate(v: string): boolean {
  if (!ISO.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

// `allowShortNotice`: ops, fixing a pickup on the phone, may set one inside the 12 h window — the
// notice rule protects us from a customer booking what we can't staff, not from our own staff.
export function scheduleProblem(
  date: string,
  time: string | null,
  now: Date = new Date(),
  opts: { allowShortNotice?: boolean } = {},
): ScheduleProblem | null {
  if (!isRealDate(date)) return 'bad_date';
  if (time !== null && !HHMM.test(time)) return 'bad_time';
  const today = isoToday('Asia/Colombo', now);
  if (date < today) return 'past';
  if (!opts.allowShortNotice && isTooSoonPrivate(date, time, now)) return 'too_soon';
  // Same calendar day next year; ISO strings compare correctly as text.
  const lastBookable = `${Number(today.slice(0, 4)) + 1}${today.slice(4)}`;
  if (date > lastBookable) return 'too_far';
  return null;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd api && npx vitest run src/domain/bookingSchedule.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add api/src/domain/bookingSchedule.ts api/src/domain/bookingSchedule.test.ts
git commit -m "feat(schedule): validate a pickup date/time set after booking"
```

---

### Task 2: History table + guarded repo write

**Files:**
- Create: `api/drizzle/0072_booking_schedule_events.sql`
- Modify: `api/drizzle/meta/_journal.json` (append after the `0071_usage_counters` entry)
- Modify: `api/src/db/schema.ts` (new table after `bookingStatusEvents`; kind check at `schema.ts:636`)
- Modify: `api/src/db/bookingRepo.ts` (types near `StatusAudit`; interface `BookingRepo`; class `InMemoryBookingRepo`)
- Modify: `api/src/db/postgresBookingRepo.ts`
- Test: `api/src/db/bookingSchedule.test.ts`
- Test: `api/src/db/bookingScheduleMigration.test.ts` (same shape as `depositPaymentsMigration.test.ts`)

**Interfaces:**
- Produces, in `bookingRepo.ts`:
  - `interface ScheduleValue { date: string | null; time: string | null }`
  - `interface ScheduleChange { date: string; time: string | null; expected: ScheduleValue; actor: { type: 'staff' | 'customer'; id: string } }`
  - `type SetScheduleResult = { ok: true; booking: Booking } | { ok: false; reason: 'not_found' } | { ok: false; reason: 'not_editable' | 'conflict'; booking: Booking }`
  - `interface BookingScheduleEvent { id: string; bookingId: string; fromDate: string | null; fromTime: string | null; toDate: string; toTime: string | null; actorType: 'staff' | 'customer'; actorId: string; createdAt: string }`
  - `const SCHEDULE_EDITABLE_STATUSES = ['paid', 'confirmed'] as const`
  - `BookingRepo.setSchedule(id: string, change: ScheduleChange): Promise<SetScheduleResult>`
  - `BookingRepo.listScheduleEvents(bookingId: string): Promise<BookingScheduleEvent[]>` (oldest first)
- Produces, in `schema.ts`: `bookingScheduleEvents`

- [ ] **Step 1: Write the failing contract test**

```ts
// api/src/db/bookingSchedule.test.ts
import { beforeAll, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { and, eq } from 'drizzle-orm';
import { createDb, type Db } from './client';
import { InMemoryBookingRepo, type BookingRepo, type NewBooking } from './bookingRepo';
import { PostgresBookingRepo } from './postgresBookingRepo';
import { bookingLegs } from './schema';

// One contract, two implementations: the route tests lean on the in-memory fake, so it must
// refuse and record exactly what Postgres does (spec 2026-10-17 §4).
const TEST_URL = process.env.DATABASE_URL_TEST;
const staff = { type: 'staff' as const, id: 'ops@x.com' };
const MISSING = '00000000-0000-4000-8000-0000000000ff';

function single(date?: string, time?: string): NewBooking {
  return {
    mode: 'single', total: 12100, amountDueNow: 12100, currency: 'USD',
    input: {
      from: 'Colombo Airport', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 1,
      ...(date ? { date } : {}), ...(time ? { time } : {}),
      customer: { firstName: 'Maya', lastName: 'Silva', email: 'm@x.com', whatsapp: '+34600', country: 'ES' },
    },
  };
}

function contract(name: string, make: () => Promise<BookingRepo>) {
  describe(name, () => {
    let repo: BookingRepo;
    beforeAll(async () => { repo = await make(); });

    async function paid(b: NewBooking) {
      const made = await repo.create(b);
      await repo.setStatus(made.id, 'payment_pending');
      await repo.setStatus(made.id, 'paid');
      return made;
    }

    it('fills a blank date and time and records who did it', async () => {
      const b = await paid(single());
      const r = await repo.setSchedule(b.id, { date: '2026-11-04', time: '09:00', expected: { date: null, time: null }, actor: staff });
      expect(r.ok).toBe(true);
      const got = await repo.get(b.id);
      expect(got!.mode === 'single' && [got!.input.date, got!.input.time]).toEqual(['2026-11-04', '09:00']);
      const events = await repo.listScheduleEvents(b.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ fromDate: null, fromTime: null, toDate: '2026-11-04', toTime: '09:00', actorType: 'staff', actorId: 'ops@x.com' });
    });

    it('changes a set date when the expected value matches, and can clear the time', async () => {
      const b = await paid(single('2026-11-04', '09:00'));
      const r = await repo.setSchedule(b.id, { date: '2026-11-05', time: null, expected: { date: '2026-11-04', time: '09:00' }, actor: staff });
      expect(r.ok).toBe(true);
      const got = await repo.get(b.id);
      expect(got!.mode === 'single' && [got!.input.date, got!.input.time ?? null]).toEqual(['2026-11-05', null]);
    });

    it('refuses a stale edit with the current booking, and writes nothing', async () => {
      const b = await paid(single('2026-11-04', '09:00'));
      const r = await repo.setSchedule(b.id, { date: '2026-12-01', time: '10:00', expected: { date: null, time: null }, actor: staff });
      expect(r).toMatchObject({ ok: false, reason: 'conflict' });
      const got = await repo.get(b.id);
      expect(got!.mode === 'single' && got!.input.date).toBe('2026-11-04');
      expect(await repo.listScheduleEvents(b.id)).toHaveLength(0);
    });

    it('refuses a booking that is not paid or confirmed', async () => {
      const b = await repo.create(single());
      await repo.setStatus(b.id, 'payment_pending');
      const r = await repo.setSchedule(b.id, { date: '2026-11-04', time: null, expected: { date: null, time: null }, actor: staff });
      expect(r).toMatchObject({ ok: false, reason: 'not_editable' });
    });

    it('reports a booking that does not exist', async () => {
      const r = await repo.setSchedule(MISSING, { date: '2026-11-04', time: null, expected: { date: null, time: null }, actor: staff });
      expect(r).toEqual({ ok: false, reason: 'not_found' });
    });
  });
}

contract('InMemoryBookingRepo schedule', async () => new InMemoryBookingRepo());

describe.skipIf(!TEST_URL)('PostgresBookingRepo schedule', () => {
  let db: Db;
  // Outer beforeAll runs before the contract's own, so every test below sees a migrated db.
  beforeAll(async () => {
    const conn = createDb(TEST_URL as string);
    db = conn.db;
    await migrate(conn.db, { migrationsFolder: 'drizzle' });
  });
  contract('PostgresBookingRepo schedule contract', async () => new PostgresBookingRepo(db));

  // The date lives twice for a single transfer (spec §2); the driver-facing legs must move too.
  it('moves the booking leg with the request, in the same write', async () => {
    const repo = new PostgresBookingRepo(db);
    const b = await repo.create(single());
    await repo.setStatus(b.id, 'payment_pending');
    await repo.setStatus(b.id, 'paid');
    await repo.setSchedule(b.id, { date: '2026-11-04', time: '09:00', expected: { date: null, time: null }, actor: staff });
    const [leg] = await db.select().from(bookingLegs).where(and(eq(bookingLegs.bookingId, b.id), eq(bookingLegs.kind, 'leg')));
    expect([leg.travelDate, leg.pickupTime]).toEqual(['2026-11-04', '09:00']);
  });
});
```

Also write the migration test (it reads the SQL file, so it runs without a database):

```ts
// api/src/db/bookingScheduleMigration.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const TAG = '0072_booking_schedule_events';
const migration = readFileSync(new URL(`../../drizzle/${TAG}.sql`, import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};
const sql = migration.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

describe(TAG, () => {
  it('creates the history table with RLS on', () => {
    expect(sql).toMatch(/create table "booking_schedule_events"/i);
    expect(sql).toMatch(/alter table "booking_schedule_events" enable row level security/i);
  });
  it('keeps every existing email kind and adds schedule_set', () => {
    for (const k of ['confirmation', 'details_needed', 'booking_confirmed', 'cancellation', 'refund', 'no_show_notice',
      'trip_reminder', 'review_request', 'payment_recovery', 'payment_failed', 'deposit_received', 'balance_received', 'schedule_set']) {
      expect(sql).toContain(`'${k}'`);
    }
  });
  it('changes no rows', () => {
    expect(sql).not.toMatch(/\b(insert\s+into|delete\s+from|drop\s+table)\b/i);
    expect(sql).not.toMatch(/\bupdate\s+\w+\s+set\b/i);
  });
  it('is journalled after every earlier entry (drizzle skips an older `when`)', () => {
    const i = journal.entries.findIndex((e) => e.tag === TAG);
    expect(i).toBeGreaterThan(0);
    expect(journal.entries[i].when).toBeGreaterThan(journal.entries[i - 1].when);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd api && npx vitest run src/db/bookingSchedule.test.ts src/db/bookingScheduleMigration.test.ts`
Expected: FAIL at compile time, because `setSchedule` / `listScheduleEvents` don't exist on `BookingRepo`. With `DATABASE_URL_TEST` set, the Postgres block fails the same way.

- [ ] **Step 3: Write the migration**

```sql
-- api/drizzle/0072_booking_schedule_events.sql
-- Dateless booking capture, Phase 1 (spec 2026-10-17 §4). Hand-written: drizzle-kit generate needs a TTY.
-- Every pickup date/time change made AFTER booking — from → to, staff or customer, who, when —
-- because the change overwrites transfer_request/booking_legs in place. Also widens the
-- customer_communications kind check for the 'schedule_set' email. Changes no rows. Rollback: drop
-- the table; restoring the old kind list first needs any 'schedule_set' rows deleted, or the check fails.
CREATE TABLE "booking_schedule_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"from_date" text,
	"from_time" text,
	"to_date" text NOT NULL,
	"to_time" text,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_schedule_events_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id"),
	CONSTRAINT "booking_schedule_events_actor_type_valid" CHECK ("actor_type" in ('staff', 'customer'))
);
--> statement-breakpoint
CREATE INDEX "booking_schedule_events_booking_created_idx" ON "booking_schedule_events" USING btree ("booking_id","created_at");
--> statement-breakpoint
-- Migration 0048 protected every table that existed then; later tables protect themselves.
ALTER TABLE "booking_schedule_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "customer_communications" DROP CONSTRAINT IF EXISTS "customer_communications_kind_valid";
--> statement-breakpoint
ALTER TABLE "customer_communications" ADD CONSTRAINT "customer_communications_kind_valid" CHECK ("kind" in ('confirmation', 'details_needed', 'booking_confirmed', 'cancellation', 'refund', 'no_show_notice', 'trip_reminder', 'review_request', 'payment_recovery', 'payment_failed', 'deposit_received', 'balance_received', 'schedule_set'));
```

Append to the `entries` array in `api/drizzle/meta/_journal.json` (keep the comma on the previous entry):

```json
    {
      "idx": 72,
      "version": "7",
      "when": 1792022400000,
      "tag": "0072_booking_schedule_events",
      "breakpoints": true
    }
```

- [ ] **Step 4: Mirror the migration in `schema.ts`**

Insert after the `bookingStatusEvents` table:

```ts
// Every pickup date/time change made AFTER booking (spec 2026-10-17 §4, migration 0072). The
// change overwrites transfer_request + booking_legs in place, so this is the only record of what
// it was before and who moved it. Written only by BookingRepo.setSchedule, inside the same write.
export const bookingScheduleEvents = pgTable(
  'booking_schedule_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookingId: uuid('booking_id').notNull().references(() => bookings.id),
    fromDate: text('from_date'),
    fromTime: text('from_time'),
    toDate: text('to_date').notNull(),
    toTime: text('to_time'),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    check('booking_schedule_events_actor_type_valid', sql`${t.actorType} in ('staff', 'customer')`),
    index('booking_schedule_events_booking_created_idx').on(t.bookingId, t.createdAt),
  ],
);
```

In the `customer_communications_kind_valid` check (`schema.ts:636`), append `, 'schedule_set'` after `'balance_received'`.

- [ ] **Step 5: Add the types and interface methods to `bookingRepo.ts`**

After the `StatusAudit` interface:

```ts
// Pickup date/time set or changed after booking (spec 2026-10-17 §4). Single transfers only, and
// only once the booking is paid: before that the customer can still change it on the booking page.
export const SCHEDULE_EDITABLE_STATUSES = ['paid', 'confirmed'] as const;

export interface ScheduleValue { date: string | null; time: string | null }

export interface ScheduleChange {
  date: string;
  time: string | null;
  // What the editor was looking at. A mismatch means someone else changed it meanwhile — the
  // write is refused rather than silently winning.
  expected: ScheduleValue;
  actor: { type: 'staff' | 'customer'; id: string };
}

export type SetScheduleResult =
  | { ok: true; booking: Booking }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'not_editable' | 'conflict'; booking: Booking };

export interface BookingScheduleEvent {
  id: string;
  bookingId: string;
  fromDate: string | null;
  fromTime: string | null;
  toDate: string;
  toTime: string | null;
  actorType: 'staff' | 'customer';
  actorId: string;
  createdAt: string; // ISO
}
```

Inside `interface BookingRepo`, after `setAmountDueNowToTotal`:

```ts
  // Set a single transfer's pickup date/time after booking. Implementations MUST make the
  // expected-value check part of the write and update BOTH stores of the date (transfer_request
  // and booking_legs) plus the history row in one transaction.
  setSchedule(id: string, change: ScheduleChange): Promise<SetScheduleResult>;
  /** Every applied schedule change for one booking, oldest first. */
  listScheduleEvents(bookingId: string): Promise<BookingScheduleEvent[]>;
```

- [ ] **Step 6: Implement the in-memory repo**

In `class InMemoryBookingRepo`, add a field next to the other private collections, then the two methods after `setAmountDueNowToTotal`:

```ts
  private scheduleEvents: BookingScheduleEvent[] = [];

  async setSchedule(id: string, change: ScheduleChange): Promise<SetScheduleResult> {
    const current = this.byId.get(id);
    if (!current) return { ok: false, reason: 'not_found' };
    if (current.mode !== 'single' || !(SCHEDULE_EDITABLE_STATUSES as readonly string[]).includes(current.status)) {
      return { ok: false, reason: 'not_editable', booking: await this.present(current) };
    }
    const from: ScheduleValue = { date: current.input.date ?? null, time: current.input.time ?? null };
    if (from.date !== change.expected.date || from.time !== change.expected.time) {
      return { ok: false, reason: 'conflict', booking: await this.present(current) };
    }
    const updated = { ...current, input: { ...current.input, date: change.date, time: change.time ?? undefined } } as Booking;
    this.byId.set(id, updated);
    this.scheduleEvents.push({
      id: randomUUID(), bookingId: id,
      fromDate: from.date, fromTime: from.time, toDate: change.date, toTime: change.time,
      actorType: change.actor.type, actorId: change.actor.id, createdAt: new Date().toISOString(),
    });
    return { ok: true, booking: await this.present(updated) };
  }

  async listScheduleEvents(bookingId: string): Promise<BookingScheduleEvent[]> {
    return this.scheduleEvents.filter((e) => e.bookingId === bookingId).map((e) => ({ ...e }));
  }
```

- [ ] **Step 7: Implement the Postgres repo**

In `postgresBookingRepo.ts`, add `bookingScheduleEvents` to the `./schema` import. Add `SCHEDULE_EDITABLE_STATUSES`, `type ScheduleChange`, `type SetScheduleResult` and `type BookingScheduleEvent` to the `./bookingRepo` import. Then add after `setAmountDueNowToTotal`:

```ts
  async setSchedule(id: string, change: ScheduleChange): Promise<SetScheduleResult> {
    const outcome = await this.db.transaction(async (tx) => {
      // Lock the booking so two editors serialise; the expected-value guard below then decides
      // the race, instead of the last write silently winning.
      const [bk] = await tx
        .select({ status: bookings.status, mode: bookings.mode })
        .from(bookings)
        .where(eq(bookings.id, id))
        .for('update');
      if (!bk) return 'not_found' as const;
      if (bk.mode !== 'single' || !(SCHEDULE_EDITABLE_STATUSES as readonly string[]).includes(bk.status)) {
        return 'not_editable' as const;
      }
      // `is not distinct from` so an expected NULL matches a NULL column. The ::text casts give
      // Postgres a type for a NULL parameter.
      const [tr] = await tx
        .update(transferRequests)
        .set({ travelDate: change.date, travelTime: change.time })
        .where(and(
          eq(transferRequests.bookingId, id),
          sql`${transferRequests.travelDate} is not distinct from ${change.expected.date}::text`,
          sql`${transferRequests.travelTime} is not distinct from ${change.expected.time}::text`,
        ))
        .returning({ id: transferRequests.id });
      if (!tr) return 'conflict' as const;
      // The date's second home (spec §2). A legacy row without legs updates nothing here.
      await tx
        .update(bookingLegs)
        .set({ travelDate: change.date, pickupTime: change.time })
        .where(and(eq(bookingLegs.bookingId, id), eq(bookingLegs.kind, 'leg')));
      await tx.insert(bookingScheduleEvents).values({
        bookingId: id,
        fromDate: change.expected.date, fromTime: change.expected.time,
        toDate: change.date, toTime: change.time,
        actorType: change.actor.type, actorId: change.actor.id,
      });
      return 'ok' as const;
    });
    const fresh = await this.get(id);
    if (outcome === 'not_found' || !fresh) return { ok: false, reason: 'not_found' };
    if (outcome === 'ok') return { ok: true, booking: fresh };
    return { ok: false, reason: outcome, booking: fresh };
  }

  async listScheduleEvents(bookingId: string): Promise<BookingScheduleEvent[]> {
    const rows = await this.db
      .select()
      .from(bookingScheduleEvents)
      .where(eq(bookingScheduleEvents.bookingId, bookingId))
      .orderBy(asc(bookingScheduleEvents.createdAt), asc(bookingScheduleEvents.id));
    return rows.map((r) => ({
      id: r.id, bookingId: r.bookingId,
      fromDate: r.fromDate, fromTime: r.fromTime, toDate: r.toDate, toTime: r.toTime,
      actorType: r.actorType as 'staff' | 'customer', actorId: r.actorId,
      createdAt: r.createdAt.toISOString(),
    }));
  }
```

- [ ] **Step 8: Run it and watch it pass, on both repos**

Run: `cd api && DATABASE_URL_TEST=<local test db url> npx vitest run src/db/bookingSchedule.test.ts`
Expected: PASS, 5 in-memory + 6 Postgres tests. Without `DATABASE_URL_TEST`, the Postgres block shows as skipped. That's not a pass, so run it with the URL.

- [ ] **Step 9: Run the gate**

Run: `cd api && npm run check`
Expected: exit 0. If an existing migration or schema test pins the old kind list, update that expectation to include `'schedule_set'`; that is the intended change.

- [ ] **Step 10: Commit**

```bash
git add api/drizzle/0072_booking_schedule_events.sql api/drizzle/meta/_journal.json api/src/db/schema.ts api/src/db/bookingRepo.ts api/src/db/postgresBookingRepo.ts api/src/db/bookingSchedule.test.ts api/src/db/bookingScheduleMigration.test.ts
git commit -m "feat(schedule): guarded pickup date/time write with history (migration 0072)"
```

---

### Task 3: `schedule_set` customer email

**Files:**
- Modify: `api/src/adapters/email.ts` (the `CustomerCommunicationKind` union)
- Modify: `api/src/domain/trackingContract.ts` and `api/src/domain/trackingContract.test.ts` (`TRACKED_BOOKING_EMAIL_KINDS`)
- Modify: `api/src/services/notifications.ts` (`trackingDefaults`; new `sendScheduleSet` after `sendDetailsNeeded`)
- Modify: `api/src/routes/devEmails.ts` (preview list)
- Test: `api/src/services/notifications.test.ts`

**Interfaces:**
- Produces: `sendScheduleSet(booking: Booking, email: EmailAdapter, links?: { manage?: string }): Promise<void>`. It does nothing unless the booking is a single transfer with a date.

- [ ] **Step 1: Write the failing test**

Add `sendScheduleSet` to the existing `./notifications` import block in `notifications.test.ts`, then append:

```ts
describe('sendScheduleSet — pickup set after booking', () => {
  const scheduled = { ...single, status: 'paid', input: { ...single.input, date: '2026-11-04', time: '09:00' } } as Booking;

  it('states the weekday, date and Sri Lanka time, and offers WhatsApp for corrections', async () => {
    const email = new FakeEmailAdapter();
    await sendScheduleSet(scheduled, email, { manage: 'https://ceylonhop.com/manage.html?t=abc' });
    expect(email.sent).toHaveLength(1);
    const m = email.sent[0];
    expect(m.subject).toBe('Your pickup is set — CH-ABC12');
    expect(m.html).toMatch(/Wed,? 4 Nov 2026/); // ICU builds differ on the comma
    expect(m.html).toContain('09:00');
    expect(m.html).toContain('Sri Lanka time');
    expect(m.html.toLowerCase()).toContain('whatsapp');
    expect(m.html).toContain('manage.html?t=abc');
    expect(m.text).not.toContain('<');
    expect(m.tracking?.kind).toBe('schedule_set');
  });

  it('says the time is still to confirm when only the date is set', async () => {
    const email = new FakeEmailAdapter();
    await sendScheduleSet({ ...scheduled, input: { ...scheduled.input, time: undefined } } as Booking, email);
    expect(email.sent[0].html).toContain('pickup time to confirm');
  });

  it('sends nothing for a booking without a date', async () => {
    const email = new FakeEmailAdapter();
    await sendScheduleSet(single, email);
    expect(email.sent).toHaveLength(0);
  });
});
```

In `trackingContract.test.ts`, append `'schedule_set',` after `'balance_received',` in the expected list.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd api && npx vitest run src/services/notifications.test.ts src/domain/trackingContract.test.ts`
Expected: FAIL: `sendScheduleSet` is not exported, and the contract list doesn't match.

- [ ] **Step 3: Register the kind**

- `email.ts`: add `| 'schedule_set'` after `| 'balance_received'` in `CustomerCommunicationKind`.
- `trackingContract.ts`: add `'schedule_set',` after `'balance_received',` in `TRACKED_BOOKING_EMAIL_KINDS`.
- `notifications.ts`, in `trackingDefaults`, after `balance_received`:

```ts
  schedule_set: { templateKey: 'booking-schedule-set', source: 'ops', actorType: 'staff' },
```

- [ ] **Step 4: Implement the email**

In `notifications.ts`, after `sendDetailsNeeded`:

```ts
// ── Your pickup is set (date/time filled or changed after booking) ─────────
// Spec 2026-10-17 §4. The reader is often abroad, so the time is labelled Sri Lanka time and the
// weekday is spelled out — this is where a wrong date is easiest to catch.
export async function sendScheduleSet(
  booking: Booking,
  email: EmailAdapter,
  links: { manage?: string } = {},
): Promise<void> {
  if (booking.mode !== 'single' || !booking.input.date) return;
  const first = esc(booking.input.customer.firstName);
  const when = booking.input.time
    ? `${fmtDate(booking.input.date)} · ${booking.input.time} (Sri Lanka time)`
    : `${fmtDate(booking.input.date)} · pickup time to confirm`;
  const html = page(
    brandHeader() +
      introBlock('Pickup set', TEAL_DEEP, `Your pickup is set, ${first}`, `${esc(when)}. Please check it now.`) +
      ticketCard(booking, BADGE_CONFIRMED) +
      (links.manage ? manageButton(links.manage) : '') +
      infoBox('Something not right?', 'Message us on WhatsApp with your booking reference and we will fix it.') +
      footer(),
  );
  const text = textShell('your pickup is set', `${when}. Please check it now.`, booking, [
    ...factRows(booking).map(([k, v]) => `${k}: ${v}`),
    '',
    'Something not right? Message us on WhatsApp with your booking reference.',
    ...(links.manage ? ['', `View your booking: ${links.manage}`] : []),
  ]);
  await email.send({
    to: booking.input.customer.email,
    subject: `Your pickup is set — ${booking.reference}`,
    html,
    text,
    tracking: emailTracking(booking, 'schedule_set'),
  });
}
```

In `devEmails.ts`, add `sendScheduleSet` to the `../services/notifications` import, and add this after the `details-needed` entry:

```ts
  { name: 'schedule-set', label: 'Pickup set (after booking)', run: (b, e) => sendScheduleSet(b.mode === 'single' ? ({ ...b, input: { ...b.input, date: '2026-11-04', time: '09:00' } } as Booking) : b, e, { manage: LINKS.manage }) },
```

- [ ] **Step 5: Run it and watch it pass**

Run: `cd api && npx vitest run src/services/notifications.test.ts src/domain/trackingContract.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add api/src/adapters/email.ts api/src/domain/trackingContract.ts api/src/domain/trackingContract.test.ts api/src/services/notifications.ts api/src/services/notifications.test.ts api/src/routes/devEmails.ts
git commit -m "feat(schedule): 'your pickup is set' customer email"
```

---

### Task 4: Ops route `POST /admin/ops/bookings/:id/schedule`

**Files:**
- Modify: `api/src/routes/ops.ts` (imports; `OpsDeps`; `csrf` inside `opsRoutes`; new route after `/bookings/:id/flags`; `scheduleEvents` in `GET /bookings/:id`)
- Modify: `api/src/app.ts:647` (pass `allowedOrigins`)
- Test: `api/src/routes/ops.schedule.test.ts`

**Interfaces:**
- Consumes: `scheduleProblem` (Task 1); `BookingRepo.setSchedule` / `listScheduleEvents` (Task 2); `sendScheduleSet` (Task 3).
- Produces (HTTP):
  - **Request:** `POST { date: string, time: string|null, expected: { date: string|null, time: string|null }, notifyCustomer: boolean }`
  - **Success:** `200 { date, time, emailed: boolean, driverNotified: boolean }`
  - **Errors:**
    - `400 { error: 'bad_request' | ScheduleProblem }`
    - `404 { error: 'not_found' }`
    - `409 { error: 'conflict' | 'not_editable', current: { date, time } | null }`
    - `403 { error: 'bad_origin' }`
  - `GET /admin/ops/bookings/:id` gains `scheduleEvents: BookingScheduleEvent[]`.

- [ ] **Step 1: Write the failing test**

```ts
// api/src/routes/ops.schedule.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createApp } from '../app';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryRideOpsRepo } from '../db/rideOpsRepo';
import { FakeEmailAdapter } from '../adapters/email';
import { issueSessionCookie } from '../lib/opsMiddleware';

const auth = { opsUsers: 'f@x.com:founder', googleClientId: 'cid', opsSessionSecret: 'sek' };

async function hdr(extra: Record<string, string> = {}) {
  const c = new Hono();
  c.get('/', (ctx) => { issueSessionCookie(ctx, 'f@x.com', 'sek', Date.now()); return ctx.text('ok'); });
  const cookie = (await c.request('/')).headers.get('set-cookie')!.split(';')[0];
  return { cookie, 'content-type': 'application/json', ...extra };
}

// Relative dates: a fixed calendar date in a test is a time bomb.
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe('POST /admin/ops/bookings/:id/schedule', () => {
  let app: ReturnType<typeof createApp>;
  let bookings: InMemoryBookingRepo;
  let rideOps: InMemoryRideOpsRepo;
  let email: FakeEmailAdapter;
  let bid: string;

  beforeEach(async () => {
    bookings = new InMemoryBookingRepo();
    rideOps = new InMemoryRideOpsRepo();
    email = new FakeEmailAdapter();
    app = createApp({ bookings, rideOps, email, auth, adminApiKey: 'adminkey' });
    const b = await bookings.create({
      mode: 'single', total: 12100, amountDueNow: 12100, currency: 'USD',
      input: { from: 'Colombo Airport', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 1,
        customer: { firstName: 'Maya', lastName: 'Silva', email: 'm@x.com', whatsapp: '+34600', country: 'ES' } },
    });
    bid = b.id;
    await bookings.setStatus(bid, 'payment_pending');
    await bookings.setStatus(bid, 'paid');
  });

  const post = async (body: unknown, extra: Record<string, string> = {}, id = bid) =>
    app.request(`/admin/ops/bookings/${id}/schedule`, { method: 'POST', headers: await hdr(extra), body: JSON.stringify(body) });

  const blank = { date: null, time: null };

  it('fills a blank date/time, emails the customer and shows the change in the detail', async () => {
    const date = inDays(10);
    const res = await post({ date, time: '09:00', expected: blank, notifyCustomer: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ date, time: '09:00', emailed: true, driverNotified: false });
    expect(email.sent.map((m) => m.subject)).toContain(`Your pickup is set — ${(await bookings.get(bid))!.reference}`);
    const detail = await (await app.request(`/admin/ops/bookings/${bid}`, { headers: await hdr() })).json();
    expect(detail.booking.input.date).toBe(date);
    expect(detail.scheduleEvents).toHaveLength(1);
    expect(detail.scheduleEvents[0]).toMatchObject({ toDate: date, toTime: '09:00', actorType: 'staff', actorId: 'f@x.com' });
  });

  it('does not email when the operator unticks it', async () => {
    const res = await post({ date: inDays(10), time: null, expected: blank, notifyCustomer: false });
    expect((await res.json()).emailed).toBe(false);
    expect(email.sent).toHaveLength(0);
  });

  it('409s a stale edit and returns the current value', async () => {
    await post({ date: inDays(10), time: '09:00', expected: blank, notifyCustomer: false });
    const res = await post({ date: inDays(12), time: '10:00', expected: blank, notifyCustomer: false });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'conflict', current: { date: inDays(10), time: '09:00' } });
  });

  it('400s a past date and a malformed body', async () => {
    expect((await (await post({ date: inDays(-1), time: null, expected: blank, notifyCustomer: false })).json()).error).toBe('past');
    expect((await post({ date: inDays(10) })).status).toBe(400);
  });

  it('409s a booking that is not paid yet', async () => {
    const b = await bookings.create({
      mode: 'single', total: 100, amountDueNow: 100, currency: 'USD',
      input: { from: 'A', to: 'B', vehicleType: 'car', adults: 1, children: 0, bags: 0,
        customer: { firstName: 'X', email: 'x@x.com', whatsapp: '+1', country: 'US' } },
    });
    const res = await post({ date: inDays(10), time: null, expected: blank, notifyCustomer: false }, {}, b.id);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('not_editable');
  });

  it('404s an unknown or malformed id', async () => {
    expect((await post({ date: inDays(10), time: null, expected: blank, notifyCustomer: false }, {}, '00000000-0000-4000-8000-0000000000ff')).status).toBe(404);
    expect((await post({ date: inDays(10), time: null, expected: blank, notifyCustomer: false }, {}, 'not-a-uuid')).status).toBe(404);
  });

  it('tells the operator when a driver already has the job', async () => {
    await rideOps.setStatus(bid, 'vehicle_confirmed');
    const res = await post({ date: inDays(10), time: '09:00', expected: blank, notifyCustomer: false });
    expect((await res.json()).driverNotified).toBe(true);
  });

  it('refuses a cross-site request (CSRF)', async () => {
    const res = await post({ date: inDays(10), time: null, expected: blank, notifyCustomer: false }, { 'sec-fetch-site': 'cross-site' });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd api && npx vitest run src/routes/ops.schedule.test.ts`
Expected: FAIL. The route doesn't exist, so the first test gets a 404 where it expects 200.

- [ ] **Step 3: Implement the route**

In `ops.ts`:

1. Change the first import to `import { Hono, type MiddlewareHandler } from 'hono';`. Add `import { scheduleProblem } from '../domain/bookingSchedule';`. Change the notifications import to `import { sendNoShowNotice, sendScheduleSet, manageUrl } from '../services/notifications';`.
2. In `interface OpsDeps`, add:

```ts
  // CSRF allow-list for mutation routes that need it (spec 2026-10-17 §6) — same list as /admin/rates.
  allowedOrigins?: string[];
```

3. Inside `opsRoutes`, right after the router is created, add:

```ts
  // Same CSRF rule as /admin/rates and /admin/quote: the ch_ops cookie is ambient browser state.
  const csrf: MiddlewareHandler = async (c, next) => {
    const site = c.req.header('sec-fetch-site');
    if (site) {
      if (site !== 'same-origin' && site !== 'none') return c.json({ error: 'bad_origin' }, 403);
      return next();
    }
    const origin = c.req.header('origin');
    if (origin && !(deps.allowedOrigins ?? []).includes(origin)) return c.json({ error: 'bad_origin' }, 403);
    return next();
  };
```

4. In `GET /bookings/:id`, change the final `return c.json({ booking: b, ops, payments, ... experienceInterests })` so the object also includes `scheduleEvents: await deps.bookings.listScheduleEvents(b.id)`.
5. After the `/bookings/:id/flags` route, add:

```ts
  // Set or change a single transfer's pickup date/time after booking (spec 2026-10-17 §4).
  // `expected` is what the operator was looking at: if it changed meanwhile (another operator,
  // later the customer) the write is refused with the current value instead of silently winning.
  r.post('/bookings/:id/schedule', csrf, requireCap('bookings:operate'), async (c) => {
    const id = c.req.param('id');
    if (!z.string().uuid().safeParse(id).success) return c.json({ error: 'not_found' }, 404);
    const Value = z.string().nullable();
    const body = z.object({
      date: z.string(),
      time: z.string().nullable(),
      expected: z.object({ date: Value, time: Value }),
      notifyCustomer: z.boolean(),
    }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const { date, time, expected, notifyCustomer } = body.data;
    const problem = scheduleProblem(date, time, new Date(), { allowShortNotice: true });
    if (problem) return c.json({ error: problem }, 400);

    const result = await deps.bookings.setSchedule(id, {
      date, time, expected, actor: { type: 'staff', id: c.get('identity').email },
    });
    if (!result.ok) {
      if (result.reason === 'not_found') return c.json({ error: 'not_found' }, 404);
      const b = result.booking;
      const current = b.mode === 'single' ? { date: b.input.date ?? null, time: b.input.time ?? null } : null;
      return c.json({ error: result.reason, current }, 409);
    }

    // A driver who already has the job is holding the OLD time — the sheet tells the operator.
    const ride = await deps.rideOps.get(id);
    const driverNotified = !!ride && ride.fulfilmentStatus !== 'paid';
    // Best-effort, like the stage emails: a mail failure must not undo a change ops just made.
    let emailed = false;
    if (notifyCustomer && deps.email) {
      try {
        const links = deps.baseUrl && deps.linkSecret ? { manage: manageUrl(result.booking, deps.baseUrl, deps.linkSecret) } : {};
        await sendScheduleSet(result.booking, deps.email, links);
        emailed = true;
      } catch (err) {
        console.error(`[ops] schedule_set email failed for ${result.booking.reference}:`, err);
      }
    }
    return c.json({ date, time, emailed, driverNotified });
  });
```

In `app.ts`, in the `opsRoutes({...})` call at line 647, add `allowedOrigins,` after `experiences, experienceInterests,`.

- [ ] **Step 4: Run it and watch it pass**

Run: `cd api && npx vitest run src/routes/ops.schedule.test.ts src/routes/ops.bookings.test.ts`
Expected: PASS. The existing ops bookings tests still pass, because they send no `sec-fetch-site` or `origin` header.

- [ ] **Step 5: Run the gate**

Run: `cd api && npm run check`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add api/src/routes/ops.ts api/src/app.ts api/src/routes/ops.schedule.test.ts
git commit -m "feat(ops): set a booking's pickup date/time from the ops tool"
```

---

### Task 5: Ops sheet form

**Files:**
- Modify: `api/src/routes/ops-ui.html`:
  - `buildActivity` (~line 3738)
  - the sheet's "When" row in `renderSheet` (~line 4250)
  - the action `switch` (next to `case 'addnote'`, ~line 4729)
  - new `SCHED_ERR` constant and `scheduleFormHtml` function
- Test: `api/src/routes/opsUi.schedule.test.ts`

**Interfaces:**
- Consumes: the HTTP contract from Task 4, and `SCHEDULE_PROBLEMS` from Task 1 (drift test).

- [ ] **Step 1: Write the failing test**

```ts
// api/src/routes/opsUi.schedule.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { createApp } from '../app';
import { SCHEDULE_PROBLEMS } from '../domain/bookingSchedule';

let body = '';

// Lift `const NAME = …;` out of the ops shell (same idea as opsUi.dates.test.ts's lift).
function lift(name: string): string {
  const m = new RegExp(`const ${name}\\s*=`).exec(body);
  expect(m, `${name} not found in the ops shell`).toBeTruthy();
  let depth = 0;
  for (let i = m!.index; i < body.length; i++) {
    const ch = body[i];
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') depth--;
    else if (ch === ';' && depth === 0) return body.slice(m!.index, i + 1);
  }
  throw new Error(`${name} never terminated`);
}

beforeAll(async () => {
  body = await (await createApp().request('/ops')).text();
});

describe('ops sheet — set pickup date/time', () => {
  it('has the form and posts to the schedule route with the expected value', () => {
    expect(body).toContain('data-act="schedopen"');
    expect(body).toContain('data-act="schedsave"');
    expect(body).toContain('/schedule`');
    expect(body).toMatch(/expected:\{date:/);
  });

  it('has a message for every refusal the server can send', () => {
    const errs = new Function(`${lift('SCHED_ERR')}; return SCHED_ERR;`)() as Record<string, string>;
    for (const code of [...SCHEDULE_PROBLEMS, 'conflict', 'not_editable']) {
      expect(errs[code], `no message for ${code}`).toBeTruthy();
    }
  });

  it('warns before saving when a driver already has the job', () => {
    expect(body).toContain('data-testid="sched-driver-warn"');
  });

  it('guards the save against a double press', () => {
    expect(lift('MUTATES')).toContain("'schedsave'");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd api && npx vitest run src/routes/opsUi.schedule.test.ts`
Expected: FAIL, with "SCHED_ERR not found in the ops shell" and missing `data-act`.

- [ ] **Step 3: Add the constant and the form**

Add the form's styles after `.notebox input:focus{...}` (`.muted` and `.warn` don't fit inside a `.kv` row):

```css
  .sched input[type=date],.sched input[type=time]{border:1px solid var(--line);background:var(--paper);color:inherit;border-radius:10px;padding:7px 10px;font:inherit;font-size:.88rem}
  .sched input:focus{outline:none;border-color:var(--teal)}
  .sched .sched-hint{display:block;color:var(--ink-faint);font-size:.78rem;font-weight:400;margin-top:4px}
  .sched .sched-warn{color:#c7841f;font-size:.85rem;margin:8px 0 0}
  .sched .btn-go{margin-top:10px}
```


Above `function renderSheet(){`:

```js
/* Pickup set after booking (spec 2026-10-17). One message per refusal the schedule route can
   send — opsUi.schedule.test.ts fails if the server learns a new one and this list doesn't. */
const SCHED_ERR={past:'That date has passed',too_soon:'Too soon — we need 12 hours notice',too_far:'More than 12 months ahead',bad_date:'Not a valid date',bad_time:'Not a valid time',conflict:'Someone changed this booking — reloaded, check and try again',not_editable:'This booking can no longer be rescheduled here'};
/* `expected` rides along with the save so a change someone else made meanwhile comes back as a
   conflict, not a silent overwrite. */
function scheduleFormHtml(t,d){
  const inp=d.booking.input||{};
  const driverHasIt=STAGES.indexOf(t.stage)>=STAGES.indexOf('vehicle_confirmed');
  return `<div class="sched" data-testid="sched-form">
    <div class="kv"><span class="k">Date</span><span class="v"><input type="date" id="schedDate" value="${esc(inp.date||'')}"></span></div>
    <div class="kv"><span class="k">Pickup time</span><span class="v"><input type="time" id="schedTime" value="${esc(inp.time||'')}"><span class="sched-hint">Sri Lanka time · blank if not known yet</span></span></div>
    <label class="togg"><span>Email the customer</span><input type="checkbox" id="schedNotify" checked></label>
    ${driverHasIt?`<p class="sched-warn" data-testid="sched-driver-warn">A driver already has this job — send them the new time after saving.</p>`:''}
    <button class="btn btn-go" data-act="schedsave" data-id="${esc(t.id)}">Save</button>
  </div>`;
}
```

In `renderSheet`, replace the "When" row:

```js
        <div class="kv"><span class="k">When</span><span class="v">${t.date?fmtDate(t.date):'Flexible'}${t.time?' · '+esc(t.time):''}</span></div>
```

with:

```js
        <div class="kv"><span class="k">When</span><span class="v">${t.date?fmtDate(t.date):'Flexible'}${t.time?' · '+esc(t.time):''}${canSchedule?` <button class="btn" data-act="schedopen" data-id="${esc(t.id)}">${t.date?'Change':'Set date &amp; time'}</button>`:''}</span></div>
        ${canSchedule&&state.schedOpen===t.id?scheduleFormHtml(t,d):''}
```

and add this line next to `const isPending=...` in `renderSheet`:

```js
  const canSchedule=d?.booking?.mode==='single'&&['paid','confirmed'].includes(d.booking.status)&&!!state.caps&&state.caps.includes('bookings:operate');
```

- [ ] **Step 4: Add the actions and activity lines**

In the click handler, add `'schedsave'` to both lists that precede the `switch`. It joins the `isBoard(t)&&[...]` list, because a ride-board van has no booking behind it. It also joins `MUTATES`, so a double press can't send two writes and the button shows the spinner:

```js
  if(isBoard(t)&&['advance','noshow','toggle','addnote','payreminder','paylink','cancelbooking','refundrequest','refundconfirm','refundexecute','refundcancel','schedsave'].includes(act))return;
```
```js
  const MUTATES=['closedone','advance','noshow','toggle','addnote','cancelbooking','markpaid','refundrequest','refundconfirm','refundexecute','refundcancel','schedsave'];
```

In the action `switch`, next to `case 'addnote'`:

```js
    case 'schedopen':{state.schedOpen=state.schedOpen===id?null:id;renderSheet();break;}
    case 'schedsave':{
      const inp=state.detailData?.booking?.input||{};
      const date=($('#schedDate')||{}).value||'';const time=($('#schedTime')||{}).value||null;
      if(!date){toast('Pick a date','error');break;}
      const payload={date,time,expected:{date:inp.date??null,time:inp.time??null},notifyCustomer:!!($('#schedNotify')||{}).checked};
      try{
        const r=await fetch(`/admin/ops/bookings/${encodeURIComponent(id)}/schedule`,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
        if(r.status===401){showLogin();break;}
        const res=await r.json().catch(()=>({}));
        if(!r.ok){toast(SCHED_ERR[res.error]||'Could not save the date','error');if(res.error==='conflict'){await refreshDetail(id);await refreshRow(id);}break;}
        state.schedOpen=null;
        toast(res.driverNotified?'Saved — send the new time to the driver':res.emailed?'Saved — customer emailed':'Saved');
        await refreshDetail(id);await refreshRow(id);
      }catch(err){window.opsReportError&&window.opsReportError('booking schedule',err);toast('Could not save the date','error');}
      break;}
```

In `buildActivity`, before `t.notes.forEach(...)`:

```js
  (d?.scheduleEvents||[]).forEach(e=>acts.push([fmtDateTime(e.createdAt),`Pickup ${e.fromDate?'changed':'set'} · ${fmtDate(e.toDate)}${e.toTime?' '+e.toTime:''} · by ${e.actorType==='customer'?'customer':e.actorId}`]));
```

- [ ] **Step 5: Run it and watch it pass**

Run: `cd api && npx vitest run src/routes/opsUi.schedule.test.ts src/routes/opsUi.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify in the browser**

1. Start the API with `preview_start` (the `.claude/launch.json` API entry), then sign in through dev login.
2. Open `/ops?cb=<n>`; the shell is cached, so add a cache-buster.
3. On a paid single transfer in "No date yet", click **Set date & time**, pick a date about 10 days out with 09:00, and save. Expected:
   - the "Saved — customer emailed" toast
   - the row moves out of "No date yet"
   - Activity shows "Pickup set · … · by <you>"
4. Click **Change** and pick a date that has passed. Expected: the "That date has passed" toast.
5. Screenshot the sheet with the form open for the PR.

- [ ] **Step 7: Run the full gate and commit**

Run:
- `cd api && npm run check`, expecting exit 0
- `npm --prefix /ABS/PATH/web-tests run test:all`, expecting exit 0

```bash
git add api/src/routes/ops-ui.html api/src/routes/opsUi.schedule.test.ts
git commit -m "feat(ops-ui): set or change a booking's pickup date/time from the sheet"
```

---

### Task 6: PR

- [ ] Push the branch and open a PR to `main`. In the body, include:
  - the red→green evidence from each task
  - the browser screenshot
  - **"Ships migration 0072_booking_schedule_events — applies on staging at merge; prod only via the owner-approved promotion."**
- [ ] Bind the PR with the ccd_pr tools. Don't promote to `production`; that's the owner's call.

---

## Later phases (separate plans, after this merges)

- **Phase 2: reminders.** `needsDetails` also covers a missing time. Reminders at about 2 and 7 days with a WhatsApp CTA. Epoch fence and dry run. Pause while ops is handling it; check whether the existing "Customer contacted · pickup confirmed" toggle (`ops-ui.html:4274`) can be the pause before adding a flag. Digest line. Blocked on the owner's no-reply policy.
- **Phase 3: queue and copy.** Days since payment and reminder count in "No date yet". Booking-page copy.
- **Phase 4: manage page, set-once.** Calls `setSchedule` with `actor.type = 'customer'` and `expected` = the current value. The route refuses any change to a field that is already set; only blanks can be filled. Rate limit, `Date set:` ops email.
