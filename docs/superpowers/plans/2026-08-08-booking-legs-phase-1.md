# Booking legs (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every journey in a booking its own record, so a customer-supplied hotel can be
attached to a journey rather than to a position in an array.

**Architecture:** A pure derivation module turns a booking's input into leg rows; both Postgres
writers call it inside their existing transaction; a separate idempotent script backfills existing
bookings. The migration only creates a table — it moves no data, so no historical row can fail-close
the API on boot. `trip_request` / `transfer_request` are untouched and remain the priced record.

**Tech Stack:** Node 20 · TypeScript (strict) · Drizzle + Postgres · Vitest · npm.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-08-post-payment-trip-details-design.md`. Phase 1 only.
- Work in the worktree `/Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/pickup-details`
  on branch `spec/post-payment-trip-details`. Stage files **by path** — never `git add -A`.
- `cd api && npm run check` must pass before every commit. Never commit red.
- Tests first: write it, run it, see it FAIL, then implement (repo Hard rule 2).
- Money is integer minor units; IDs are uuid.
- **Migrations auto-apply on Render boot and fail closed.** Merging this migration releases it to
  staging. The owner's explicit ok is required before merge (CLAUDE.md maintenance rule 3 + 7).
- No customer-visible change ships in this phase. No endpoint, no UI.

## Scope decisions taken before writing this plan

Three findings from the current code changed Phase 1 against the spec. Each is a deliberate
reduction, recorded so a reader knows it was chosen:

1. **Re-derivation (spec §1.2) is NOT built here.** Nothing in the codebase edits a booking's route:
   ops exposes `GET /bookings/:id`, `POST /bookings/:id/status` and `POST /bookings/:id/flags`
   (`api/src/routes/ops.ts:240-282`), and no code calls `update(tripRequests)` or
   `update(transferRequests)`. The coordinate-matching rule belongs to whichever change first lets a
   booking's route be edited, and should ship with it.
2. **The backfill is a script, not a migration step.** The spec put it in the migration; migrations
   fail closed on boot, so a malformed historical row could keep the API down. A separate idempotent
   script removes that risk entirely and can be run deliberately against staging, then prod.
3. **No coordinates are resolved in Phase 1.** `from_lat`/`from_lng`/`to_lat`/`to_lng` are created
   but left null. Resolving a place inside booking creation would add a Google Distance Matrix call
   to the payment path. Phase 2 resolves lazily, when the guard first needs an anchor.

## File Structure

| File | Responsibility |
|---|---|
| `api/src/domain/bookingLegs.ts` (create) | Pure derivation: booking input → leg rows. No DB, no I/O. |
| `api/src/domain/bookingLegs.test.ts` (create) | Its tests. |
| `api/src/db/schema.ts` (modify) | The `booking_legs` table definition. |
| `api/drizzle/0042_booking_legs.sql` (create, generated) | The migration. Table only — no data movement. |
| `api/src/db/bookingLegsMigration.test.ts` (create) | Asserts the migration's SQL contains its constraints, per the `moneyConstraints.test.ts` pattern. |
| `api/src/db/postgresBookingRepo.ts` (modify) | Insert legs in the existing create transaction. |
| `api/src/db/postgresQuoteConversionRepo.ts` (modify) | Same, for quote-born bookings. |
| `api/scripts/backfill-booking-legs.ts` (create) | Idempotent backfill over existing bookings, reusing the pure module. Reports counts and skips. |
| `api/scripts/check-booking-legs.ts` (create) | Read-only reconciliation — the Phase 1 gate. |
| `api/package.json` (modify) | `legs:backfill` and `legs:check` scripts, alongside `db:preflight:money`. |

---

### Task 1: The pure derivation module

The whole of Phase 1's logic lives here, with no database in the way. Every later task calls it.

**Files:**
- Create: `api/src/domain/bookingLegs.ts`
- Test: `api/src/domain/bookingLegs.test.ts`

**Interfaces:**
- Consumes: `TripInput` (`api/src/domain/trip.ts:13`), `SingleTransferInput`
  (`api/src/domain/singleTransfer.ts`).
- Produces:
  - `type BookingLegKind = 'leg' | 'day' | 'gap'`
  - `interface DerivedLeg { seq: number; kind: BookingLegKind; fromPlace: string; toPlace: string; viaStops: string[]; travelDate: string | null; pickupTime: string | null }`
  - `function deriveSingleLegs(input: { from: string; to: string; date?: string | null; time?: string | null }): DerivedLeg[]`
  - `function deriveTripLegs(input: { stops: string[]; dates?: string[] | null; serviceType: 'private' | 'chauffeur' }): DerivedLeg[]`

- [ ] **Step 1: Write the failing tests**

Create `api/src/domain/bookingLegs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { deriveSingleLegs, deriveTripLegs } from './bookingLegs';

describe('deriveSingleLegs', () => {
  it('produces exactly one leg carrying the date and time', () => {
    expect(
      deriveSingleLegs({ from: 'Hiriketiya Beach', to: 'Negombo', date: '2026-08-22', time: '08:00' }),
    ).toEqual([
      {
        seq: 1,
        kind: 'leg',
        fromPlace: 'Hiriketiya Beach',
        toPlace: 'Negombo',
        viaStops: [],
        travelDate: '2026-08-22',
        pickupTime: '08:00',
      },
    ]);
  });

  it('leaves date and time null when the customer chose "decide later"', () => {
    const [leg] = deriveSingleLegs({ from: 'Ella', to: 'Kandy' });
    expect(leg.travelDate).toBeNull();
    expect(leg.pickupTime).toBeNull();
  });
});

describe('deriveTripLegs — private', () => {
  it('makes one leg per consecutive pair, dates aligned by index', () => {
    const legs = deriveTripLegs({
      stops: ['Hiriketiya Beach', 'Ella', 'Kandy', 'Negombo'],
      dates: ['2026-08-22', '2026-08-25', '2026-08-27'],
      serviceType: 'private',
    });
    expect(legs.map((l) => [l.seq, l.kind, l.fromPlace, l.toPlace, l.travelDate])).toEqual([
      [1, 'leg', 'Hiriketiya Beach', 'Ella', '2026-08-22'],
      [2, 'leg', 'Ella', 'Kandy', '2026-08-25'],
      [3, 'leg', 'Kandy', 'Negombo', '2026-08-27'],
    ]);
    expect(legs.every((l) => l.viaStops.length === 0)).toBe(true);
  });

  it('keeps the legs when the trip has no dates yet', () => {
    const legs = deriveTripLegs({ stops: ['Galle', 'Mirissa', 'Ella'], serviceType: 'private' });
    expect(legs).toHaveLength(2);
    expect(legs.every((l) => l.travelDate === null)).toBe(true);
  });
});

describe('deriveTripLegs — chauffeur', () => {
  // quoteToBooking.ts:170 stores ONE DATE PER SEGMENT, so consecutive segments sharing a date
  // are one travel day. A day with three stops owns two segments.
  it('groups consecutive segments that share a date into one travel day', () => {
    const legs = deriveTripLegs({
      stops: ['Colombo', 'Pinnawala', 'Kandy', 'Ella'],
      dates: ['2026-08-22', '2026-08-22', '2026-08-23'],
      serviceType: 'chauffeur',
    });
    expect(legs).toEqual([
      {
        seq: 1,
        kind: 'day',
        fromPlace: 'Colombo',
        toPlace: 'Kandy',
        viaStops: ['Pinnawala'],
        travelDate: '2026-08-22',
        pickupTime: null,
      },
      {
        seq: 2,
        kind: 'day',
        fromPlace: 'Kandy',
        toPlace: 'Ella',
        viaStops: [],
        travelDate: '2026-08-23',
        pickupTime: null,
      },
    ]);
  });

  // chainStops (quoteToBooking.ts:46) pushes a stop we do NOT drive to as a gap; its date is ''.
  it('marks a blank-dated connector as a gap and never merges it into a day', () => {
    const legs = deriveTripLegs({
      stops: ['Colombo', 'Kandy', 'Galle', 'Mirissa'],
      dates: ['2026-08-22', '', '2026-08-25'],
      serviceType: 'chauffeur',
    });
    expect(legs.map((l) => [l.kind, l.fromPlace, l.toPlace, l.travelDate])).toEqual([
      ['day', 'Colombo', 'Kandy', '2026-08-22'],
      ['gap', 'Kandy', 'Galle', null],
      ['day', 'Galle', 'Mirissa', '2026-08-25'],
    ]);
  });

  it('does not merge two separate days that happen to be adjacent', () => {
    const legs = deriveTripLegs({
      stops: ['A', 'B', 'C'],
      dates: ['2026-08-22', '2026-08-23'],
      serviceType: 'chauffeur',
    });
    expect(legs).toHaveLength(2);
    expect(legs.map((l) => l.travelDate)).toEqual(['2026-08-22', '2026-08-23']);
  });

  it('falls back to one row per segment when a chauffeur trip has no dates at all', () => {
    const legs = deriveTripLegs({ stops: ['A', 'B', 'C'], serviceType: 'chauffeur' });
    expect(legs.map((l) => l.kind)).toEqual(['gap', 'gap']);
  });
});

describe('deriveTripLegs — defensive', () => {
  it('returns no legs for a stops array too short to contain a journey', () => {
    expect(deriveTripLegs({ stops: ['Ella'], serviceType: 'private' })).toEqual([]);
    expect(deriveTripLegs({ stops: [], serviceType: 'private' })).toEqual([]);
  });

  it('tolerates a dates array shorter than the segment count', () => {
    const legs = deriveTripLegs({
      stops: ['A', 'B', 'C'],
      dates: ['2026-08-22'],
      serviceType: 'private',
    });
    expect(legs.map((l) => l.travelDate)).toEqual(['2026-08-22', null]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd api && npx vitest run src/domain/bookingLegs.test.ts
```

Expected: FAIL — `Failed to resolve import "./bookingLegs"`.

- [ ] **Step 3: Write the implementation**

Create `api/src/domain/bookingLegs.ts`:

```ts
// One record per journey in a booking. A journey is currently a POSITION between two entries in
// trip_request.stops[], which means anything attached to it silently follows the position when the
// trip changes — see docs/superpowers/specs/2026-08-08-post-payment-trip-details-design.md §1.
//
// Pure on purpose: the writers and the backfill share this one definition, so a leg derived at
// booking time and a leg derived by the backfill can never disagree.

/**
 * `leg` — a journey between two overnight stops (single transfer, or a private trip's pair).
 * `day` — one chauffeur TRAVEL DAY, which may pass through several stops.
 * `gap`  — a connector chainStops() inserted between two chauffeur days (quoteToBooking.ts:46).
 *          Recorded so the route stays complete; never a journey we drive as one.
 */
export type BookingLegKind = 'leg' | 'day' | 'gap';

export interface DerivedLeg {
  seq: number;
  kind: BookingLegKind;
  fromPlace: string;
  toPlace: string;
  viaStops: string[];
  travelDate: string | null;
  pickupTime: string | null;
}

export function deriveSingleLegs(input: {
  from: string;
  to: string;
  date?: string | null;
  time?: string | null;
}): DerivedLeg[] {
  return [
    {
      seq: 1,
      kind: 'leg',
      fromPlace: input.from,
      toPlace: input.to,
      viaStops: [],
      travelDate: input.date || null,
      pickupTime: input.time || null,
    },
  ];
}

export function deriveTripLegs(input: {
  stops: string[];
  dates?: string[] | null;
  serviceType: 'private' | 'chauffeur';
}): DerivedLeg[] {
  const { stops, serviceType } = input;
  const dates = input.dates ?? [];
  if (stops.length < 2) return [];
  const rows =
    serviceType === 'chauffeur' ? chauffeurDays(stops, dates) : privateLegs(stops, dates);
  return rows.map((row, i) => ({ ...row, seq: i + 1 }));
}

type Unsequenced = Omit<DerivedLeg, 'seq'>;

function privateLegs(stops: string[], dates: string[]): Unsequenced[] {
  return stops.slice(0, -1).map((from, i) => ({
    kind: 'leg' as const,
    fromPlace: from,
    toPlace: stops[i + 1],
    viaStops: [],
    travelDate: dates[i] || null,
    pickupTime: null,
  }));
}

// A chauffeur booking stores one date per SEGMENT (quoteToBooking.ts:170), so consecutive segments
// carrying the same non-empty date are the same travel day. A blank date is chainStops()'s gap.
function chauffeurDays(stops: string[], dates: string[]): Unsequenced[] {
  const out: Unsequenced[] = [];
  const lastSegment = stops.length - 2;
  let i = 0;
  while (i <= lastSegment) {
    const date = dates[i] || '';
    if (!date) {
      out.push({
        kind: 'gap',
        fromPlace: stops[i],
        toPlace: stops[i + 1],
        viaStops: [],
        travelDate: null,
        pickupTime: null,
      });
      i += 1;
      continue;
    }
    let end = i;
    while (end < lastSegment && (dates[end + 1] || '') === date) end += 1;
    out.push({
      kind: 'day',
      fromPlace: stops[i],
      toPlace: stops[end + 1],
      viaStops: stops.slice(i + 1, end + 1),
      travelDate: date,
      pickupTime: null,
    });
    i = end + 1;
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd api && npx vitest run src/domain/bookingLegs.test.ts
```

Expected: PASS — 10 tests.

- [ ] **Step 5: Run the full gate**

```bash
cd api && npm run check
```

Expected: typecheck, lint and the whole suite green.

- [ ] **Step 6: Commit**

```bash
git add api/src/domain/bookingLegs.ts api/src/domain/bookingLegs.test.ts
git commit -m "feat(legs): derive a booking's journeys as records, not array positions"
```

---

### Task 2: The table and its migration

**Files:**
- Modify: `api/src/db/schema.ts` (append after `tripRequests`, which ends at line 273)
- Create: `api/drizzle/0042_booking_legs.sql` (generated by drizzle-kit — do not hand-write)
- Test: `api/src/db/bookingLegsMigration.test.ts`

**Interfaces:**
- Consumes: `bookings` (`schema.ts:23`), `BookingLegKind` from Task 1.
- Produces: `bookingLegs` — the Drizzle table object imported by Tasks 3 and 4.

- [ ] **Step 1: Write the failing migration test**

Create `api/src/db/bookingLegsMigration.test.ts` (same shape as `moneyConstraints.test.ts:1-8`):

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../../drizzle/0042_booking_legs.sql', import.meta.url),
  'utf8',
);

describe('0042_booking_legs', () => {
  it('creates the table', () => {
    expect(migration).toMatch(/create table[^;]*"?booking_legs"?/i);
  });

  it('constrains kind to the three derivable kinds', () => {
    expect(migration).toContain('booking_legs_kind_valid');
    for (const kind of ['leg', 'day', 'gap']) expect(migration).toContain(`'${kind}'`);
  });

  it('makes (booking_id, seq) unique so a re-run cannot duplicate a journey', () => {
    expect(migration).toContain('booking_legs_booking_seq_unique');
  });

  // The migration must MOVE NO DATA. Migrations auto-apply on Render boot and fail closed, so a
  // malformed historical row could keep the API down; the backfill is a separate script (Task 5).
  it('moves no data', () => {
    expect(migration).not.toMatch(/\binsert\s+into\b/i);
    expect(migration).not.toMatch(/\bupdate\s+\w+\s+set\b/i);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd api && npx vitest run src/db/bookingLegsMigration.test.ts
```

Expected: FAIL — `ENOENT: no such file or directory ... 0042_booking_legs.sql`.

- [ ] **Step 3: Add the table to the schema**

In `api/src/db/schema.ts`, immediately after the `tripRequests` table (ends line 273), add:

```ts
// One record per journey in a booking, so a customer-supplied hotel attaches to a JOURNEY rather
// than to a position in trip_request.stops[] — which silently follows the position when the trip
// changes. See docs/superpowers/specs/2026-08-08-post-payment-trip-details-design.md §1.
//
// This table does NOT price anything. trip_request / transfer_request stay the priced record; the
// two agree at booking time and may legitimately diverge afterwards, and flattening them would
// erase why the price is what it is.
export const bookingLegs = pgTable(
  'booking_legs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id),
    // Display order only. NEVER an identifier — that is the whole point of this table.
    seq: integer('seq').notNull(),
    kind: text('kind').notNull(),
    fromPlace: text('from_place').notNull(),
    toPlace: text('to_place').notNull(),
    // A chauffeur day's intermediate stops: itinerary, not accommodation. Recorded for ops
    // context, never prompted for.
    viaStops: text('via_stops').array().notNull().default(sql`'{}'::text[]`),
    travelDate: text('travel_date'),
    // Resolved endpoints. Deliberately null until Phase 2: resolving a place inside booking
    // creation would put a Google call in the payment path.
    fromLat: doublePrecision('from_lat'),
    fromLng: doublePrecision('from_lng'),
    toLat: doublePrecision('to_lat'),
    toLng: doublePrecision('to_lng'),
    // ── everything below is written by Phase 2 only; created now so this table is migrated once,
    // over already-paid bookings, rather than twice.
    pickupSpot: text('pickup_spot'),
    dropoffSpot: text('dropoff_spot'),
    pickupLat: doublePrecision('pickup_lat'),
    pickupLng: doublePrecision('pickup_lng'),
    dropoffLat: doublePrecision('dropoff_lat'),
    dropoffLng: doublePrecision('dropoff_lng'),
    pickupTime: text('pickup_time'),
    flightNo: text('flight_no'),
    detailFlag: text('detail_flag'),
    distanceCheck: text('distance_check'),
    refusedSpot: text('refused_spot'),
    refusedAt: timestamp('refused_at', { withTimezone: true }),
    detailsHistory: jsonb('details_history'),
    detailsUpdatedAt: timestamp('details_updated_at', { withTimezone: true }),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('booking_legs_booking_seq_unique').on(t.bookingId, t.seq),
    index('booking_legs_booking_idx').on(t.bookingId),
    check('booking_legs_kind_valid', sql`${t.kind} in ('leg', 'day', 'gap')`),
    check('booking_legs_seq_positive', sql`${t.seq} > 0`),
  ],
);
```

`sql` is already imported in this file (used by the `bookings` checks); `unique`, `index`, `check`,
`jsonb`, `doublePrecision` and `timestamp` are all in the line-1 import.

- [ ] **Step 4: Generate the migration**

```bash
cd api && npm run db:generate
```

Expected: writes `api/drizzle/0042_booking_legs.sql` and updates `api/drizzle/meta/_journal.json`.
Open the SQL and confirm it contains only `CREATE TABLE` / `ALTER TABLE ... ADD CONSTRAINT` /
`CREATE INDEX` statements. If drizzle names the file differently, rename it to
`0042_booking_legs.sql` and update the journal's `tag` to match.

- [ ] **Step 5: Run the migration test**

```bash
cd api && npx vitest run src/db/bookingLegsMigration.test.ts
```

Expected: PASS — 4 tests.

- [ ] **Step 6: Run the full gate**

```bash
cd api && npm run check
```

- [ ] **Step 7: Commit**

```bash
git add api/src/db/schema.ts api/drizzle/0042_booking_legs.sql api/drizzle/meta api/src/db/bookingLegsMigration.test.ts
git commit -m "feat(legs): add booking_legs — table only, no data movement"
```

---

### Task 3: Write legs when a website booking is created

**Files:**
- Modify: `api/src/db/postgresBookingRepo.ts:224-262` (the `create` transaction)
- Test: `api/src/db/postgresBookingRepo.legs.test.ts` (create)

**Interfaces:**
- Consumes: `deriveSingleLegs`, `deriveTripLegs` (Task 1); `bookingLegs` (Task 2).
- Produces: nothing new — legs are a side effect of the existing `create`.

This repo has no database-backed test harness (no pg-mem, no testcontainers), so the test asserts
the **rows handed to the insert**, using a fake transaction. That is the layer where a mistake would
actually live: the mapping from booking input to leg rows.

- [ ] **Step 1: Write the failing test**

Create `api/src/db/postgresBookingRepo.legs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { legRowsForBooking } from './postgresBookingRepo';

describe('legRowsForBooking', () => {
  const bookingId = '00000000-0000-4000-8000-000000000001';

  it('maps a single transfer to one leg row carrying its date and time', () => {
    const rows = legRowsForBooking(bookingId, {
      mode: 'single',
      input: { from: 'Hiriketiya Beach', to: 'Negombo', date: '2026-08-22', time: '08:00' },
    });
    expect(rows).toEqual([
      {
        bookingId,
        seq: 1,
        kind: 'leg',
        fromPlace: 'Hiriketiya Beach',
        toPlace: 'Negombo',
        viaStops: [],
        travelDate: '2026-08-22',
        pickupTime: '08:00',
      },
    ]);
  });

  it('maps a private trip to one row per consecutive pair', () => {
    const rows = legRowsForBooking(bookingId, {
      mode: 'trip',
      input: {
        stops: ['Galle', 'Ella', 'Kandy'],
        dates: ['2026-08-22', '2026-08-25'],
        serviceType: 'private',
      },
    });
    expect(rows.map((r) => [r.seq, r.kind, r.fromPlace, r.toPlace])).toEqual([
      [1, 'leg', 'Galle', 'Ella'],
      [2, 'leg', 'Ella', 'Kandy'],
    ]);
  });

  it('maps a chauffeur trip by travel day', () => {
    const rows = legRowsForBooking(bookingId, {
      mode: 'trip',
      input: {
        stops: ['Colombo', 'Pinnawala', 'Kandy'],
        dates: ['2026-08-22', '2026-08-22'],
        serviceType: 'chauffeur',
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('day');
    expect(rows[0].viaStops).toEqual(['Pinnawala']);
  });

  it('produces no rows for a shared seat — a corridor is not a journey with editable ends', () => {
    expect(
      legRowsForBooking(bookingId, {
        mode: 'shared',
        input: { corridorId: 'south-coast', date: '2026-08-22', time: '07:30', seats: 2 },
      }),
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd api && npx vitest run src/db/postgresBookingRepo.legs.test.ts
```

Expected: FAIL — `legRowsForBooking is not exported`.

- [ ] **Step 3: Add the mapper and call it in the transaction**

In `api/src/db/postgresBookingRepo.ts`, add to the imports at the top:

```ts
import { customers, bookings, transferRequests, tripRequests, sharedRequests, bookingLegs } from './schema';
import { deriveSingleLegs, deriveTripLegs, type DerivedLeg } from '../domain/bookingLegs';
```

Add above the class (exported so it can be tested without a database):

```ts
/** The leg rows a booking implies. Exported for test — see postgresBookingRepo.legs.test.ts. */
export function legRowsForBooking(
  bookingId: string,
  b: { mode: string; input: Record<string, unknown> },
): (Omit<DerivedLeg, never> & { bookingId: string })[] {
  const legs =
    b.mode === 'single'
      ? deriveSingleLegs(b.input as { from: string; to: string; date?: string; time?: string })
      : b.mode === 'trip'
        ? deriveTripLegs(
            b.input as { stops: string[]; dates?: string[]; serviceType: 'private' | 'chauffeur' },
          )
        : [];
  return legs.map((leg) => ({ ...leg, bookingId }));
}
```

Then, inside the `create` transaction, immediately **after** the `if (b.mode === 'trip') … else …`
block and **before** `return bk;` (currently line 261):

```ts
      const legs = legRowsForBooking(bk.id, b);
      if (legs.length) await tx.insert(bookingLegs).values(legs);
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd api && npx vitest run src/db/postgresBookingRepo.legs.test.ts
```

Expected: PASS — 4 tests.

- [ ] **Step 5: Run the full gate**

```bash
cd api && npm run check
```

- [ ] **Step 6: Commit**

```bash
git add api/src/db/postgresBookingRepo.ts api/src/db/postgresBookingRepo.legs.test.ts
git commit -m "feat(legs): write legs when a website booking is created"
```

---

### Task 4: Write legs when a quote is converted to a booking

**Files:**
- Modify: `api/src/db/postgresQuoteConversionRepo.ts:150-176`
- Test: `api/src/db/postgresQuoteConversionRepo.legs.test.ts` (create)

**Interfaces:**
- Consumes: `legRowsForBooking` (Task 3) — the same mapper, so a quote-born booking and a website
  booking can never derive legs differently.

- [ ] **Step 1: Write the failing test**

Create `api/src/db/postgresQuoteConversionRepo.legs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { legRowsForBooking } from './postgresBookingRepo';

// The pay-link path is the one this whole feature exists for: a quote-born booking has no exact
// spot and no time. It must produce the same legs a website booking of the same shape would.
describe('quote-born bookings derive the same legs', () => {
  const bookingId = '00000000-0000-4000-8000-000000000002';

  it('single transfer with no date or time still gets its leg', () => {
    const rows = legRowsForBooking(bookingId, {
      mode: 'single',
      input: { from: 'Hiriketiya Beach', to: 'Negombo' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].travelDate).toBeNull();
    expect(rows[0].pickupTime).toBeNull();
  });

  it('a chauffeur trip with a gap keeps the connector out of the travel days', () => {
    const rows = legRowsForBooking(bookingId, {
      mode: 'trip',
      input: {
        stops: ['Colombo', 'Kandy', 'Galle', 'Mirissa'],
        dates: ['2026-08-22', '', '2026-08-25'],
        serviceType: 'chauffeur',
      },
    });
    expect(rows.map((r) => r.kind)).toEqual(['day', 'gap', 'day']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd api && npx vitest run src/db/postgresQuoteConversionRepo.legs.test.ts
```

Expected: FAIL until Task 3 is merged; if Task 3 is already in, this file passes on the mapper and
the remaining work is the insert below — run it again after Step 3 regardless.

- [ ] **Step 3: Insert the legs in the conversion transaction**

In `api/src/db/postgresQuoteConversionRepo.ts`, add to the schema import block (lines 7-8):

```ts
  bookingLegs,
```

and add to the top-level imports:

```ts
import { legRowsForBooking } from './postgresBookingRepo';
```

Then, immediately **before** `return bookingRow.id;` (currently line 178):

```ts
  const legs = legRowsForBooking(bookingRow.id, { mode: booking.mode, input: booking.input });
  if (legs.length) await tx.insert(bookingLegs).values(legs);
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd api && npx vitest run src/db/postgresQuoteConversionRepo.legs.test.ts
```

Expected: PASS — 2 tests.

- [ ] **Step 5: Run the full gate**

```bash
cd api && npm run check
```

Expected: green. Pay attention to `postgresQuoteConversionRepo`'s existing tests — a conversion that
now inserts an extra table must not break their transaction fakes.

- [ ] **Step 6: Commit**

```bash
git add api/src/db/postgresQuoteConversionRepo.ts api/src/db/postgresQuoteConversionRepo.legs.test.ts
git commit -m "feat(legs): write legs when a quote becomes a booking"
```

---

### Task 5: The backfill script

Existing bookings — including ones already paid for — have no legs. This script gives them legs
without touching the API's boot path.

**Files:**
- Create: `api/scripts/backfill-booking-legs.ts`
- Test: `api/src/db/backfillBookingLegs.test.ts`

**Interfaces:**
- Consumes: `deriveSingleLegs` / `deriveTripLegs` (Task 1), `bookingLegs` (Task 2).
- Produces: `function planBackfill(rows: BackfillRow[]): { legs: NewLegRow[]; skipped: SkipReport[] }`
  — the pure decision half, exported so it can be tested without a database.

- [ ] **Step 1: Write the failing test**

Create `api/src/db/backfillBookingLegs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { planBackfill } from '../../scripts/backfill-booking-legs';

describe('planBackfill', () => {
  it('derives legs for a single transfer and a trip', () => {
    const { legs, skipped } = planBackfill([
      {
        bookingId: 'b1',
        mode: 'single',
        transfer: { fromPlace: 'Ella', toPlace: 'Kandy', travelDate: '2026-08-22', travelTime: '09:00' },
      },
      {
        bookingId: 'b2',
        mode: 'trip',
        trip: { stops: ['A', 'B', 'C'], dates: ['2026-08-22', '2026-08-24'], serviceType: 'private' },
      },
    ]);
    expect(skipped).toEqual([]);
    expect(legs.filter((l) => l.bookingId === 'b1')).toHaveLength(1);
    expect(legs.filter((l) => l.bookingId === 'b2')).toHaveLength(2);
  });

  // A historical row must never be able to stop the backfill — and must never be silently lost.
  it('skips a trip whose stops array is too short, and says why', () => {
    const { legs, skipped } = planBackfill([
      { bookingId: 'b3', mode: 'trip', trip: { stops: ['A'], dates: [], serviceType: 'private' } },
    ]);
    expect(legs).toEqual([]);
    expect(skipped).toEqual([{ bookingId: 'b3', reason: 'no_journey' }]);
  });

  it('skips a booking whose request row is missing entirely', () => {
    const { skipped } = planBackfill([{ bookingId: 'b4', mode: 'single' }]);
    expect(skipped).toEqual([{ bookingId: 'b4', reason: 'missing_request' }]);
  });

  it('ignores shared bookings without reporting them as problems', () => {
    const { legs, skipped } = planBackfill([{ bookingId: 'b5', mode: 'shared' }]);
    expect(legs).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it('carries the transfer time onto the leg, so the leg becomes the source of truth', () => {
    const { legs } = planBackfill([
      {
        bookingId: 'b6',
        mode: 'single',
        transfer: { fromPlace: 'A', toPlace: 'B', travelDate: null, travelTime: '06:30' },
      },
    ]);
    expect(legs[0].pickupTime).toBe('06:30');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd api && npx vitest run src/db/backfillBookingLegs.test.ts
```

Expected: FAIL — cannot resolve `../../scripts/backfill-booking-legs`.

- [ ] **Step 3: Write the script**

Create `api/scripts/backfill-booking-legs.ts`:

```ts
// Gives existing bookings — including ones already paid for — their legs.
//
// Deliberately a script, not a migration step. Migrations auto-apply on Render boot and fail
// closed, so a single malformed historical row inside one would keep the API down. Run this
// against staging first, read the report, then run it against prod.
//
// Idempotent: (booking_id, seq) is unique, and inserts are ON CONFLICT DO NOTHING, so a partial
// run completes rather than duplicates.
import { config as loadEnv } from 'dotenv';
import { eq, isNull } from 'drizzle-orm';
import { createDb } from '../src/db/client';
import { bookings, bookingLegs, transferRequests, tripRequests } from '../src/db/schema';
import { deriveSingleLegs, deriveTripLegs, type DerivedLeg } from '../src/domain/bookingLegs';

loadEnv({ path: '.env', quiet: true });

// DELIBERATELY NOT process.env.DATABASE_URL. The api/.env in this repo points at PRODUCTION
// Supabase, so an implicit read would backfill prod from a laptop by accident. The operator must
// name the target every time.
function targetUrl(): string {
  const url = process.env.BACKFILL_DATABASE_URL;
  if (!url) {
    throw new Error(
      'Set BACKFILL_DATABASE_URL to the database you mean to write to. ' +
        'DATABASE_URL is not used here on purpose — api/.env points at production.',
    );
  }
  return url;
}

export interface BackfillRow {
  bookingId: string;
  mode: string;
  transfer?: {
    fromPlace: string;
    toPlace: string;
    travelDate: string | null;
    travelTime: string | null;
  };
  trip?: { stops: string[]; dates: string[] | null; serviceType: string };
}

export type NewLegRow = DerivedLeg & { bookingId: string };
export interface SkipReport {
  bookingId: string;
  reason: 'missing_request' | 'no_journey';
}

/** The pure half: what this run WOULD write. Exported for test. */
export function planBackfill(rows: BackfillRow[]): { legs: NewLegRow[]; skipped: SkipReport[] } {
  const legs: NewLegRow[] = [];
  const skipped: SkipReport[] = [];
  for (const row of rows) {
    // A shared seat has no journey with editable ends. Not a problem — just not our business.
    if (row.mode === 'shared') continue;
    if (row.mode === 'single') {
      if (!row.transfer) {
        skipped.push({ bookingId: row.bookingId, reason: 'missing_request' });
        continue;
      }
      const derived = deriveSingleLegs({
        from: row.transfer.fromPlace,
        to: row.transfer.toPlace,
        date: row.transfer.travelDate,
        time: row.transfer.travelTime,
      });
      legs.push(...derived.map((l) => ({ ...l, bookingId: row.bookingId })));
      continue;
    }
    if (row.mode === 'trip') {
      if (!row.trip) {
        skipped.push({ bookingId: row.bookingId, reason: 'missing_request' });
        continue;
      }
      const derived = deriveTripLegs({
        stops: row.trip.stops ?? [],
        dates: row.trip.dates,
        serviceType: row.trip.serviceType === 'chauffeur' ? 'chauffeur' : 'private',
      });
      if (!derived.length) {
        skipped.push({ bookingId: row.bookingId, reason: 'no_journey' });
        continue;
      }
      legs.push(...derived.map((l) => ({ ...l, bookingId: row.bookingId })));
    }
  }
  return { legs, skipped };
}

async function main(): Promise<void> {
  const { sql, db } = createDb(targetUrl());
  const rows: BackfillRow[] = [];
  const all = await db
    .select({ id: bookings.id, mode: bookings.mode })
    .from(bookings)
    .leftJoin(bookingLegs, eq(bookingLegs.bookingId, bookings.id))
    .where(isNull(bookingLegs.id));

  for (const b of all) {
    if (b.mode === 'single') {
      const [t] = await db
        .select()
        .from(transferRequests)
        .where(eq(transferRequests.bookingId, b.id));
      rows.push({
        bookingId: b.id,
        mode: b.mode,
        transfer: t
          ? {
              fromPlace: t.fromPlace,
              toPlace: t.toPlace,
              travelDate: t.travelDate,
              travelTime: t.travelTime,
            }
          : undefined,
      });
    } else if (b.mode === 'trip') {
      const [t] = await db.select().from(tripRequests).where(eq(tripRequests.bookingId, b.id));
      rows.push({
        bookingId: b.id,
        mode: b.mode,
        trip: t ? { stops: t.stops, dates: t.dates, serviceType: t.serviceType } : undefined,
      });
    } else {
      rows.push({ bookingId: b.id, mode: b.mode });
    }
  }

  const { legs, skipped } = planBackfill(rows);
  if (legs.length) await db.insert(bookingLegs).values(legs).onConflictDoNothing();

  // Skips are REPORTED, never silent: a booking with no legs shows no card in Phase 2 and would
  // otherwise be invisible.
  console.log(`bookings examined : ${rows.length}`);
  console.log(`legs written      : ${legs.length}`);
  console.log(`skipped           : ${skipped.length}`);
  for (const report of skipped) console.log(`  ${report.bookingId} — ${report.reason}`);
  await sql.end();
}

if (process.argv[1]?.endsWith('backfill-booking-legs.ts')) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
```

This follows `api/scripts/preflight-money-constraints.ts:1-19` — dotenv, then `createDb(url)`.
There is no top-level `db` export; `createDb` returns `{ sql, db }` and the caller closes `sql`.

- [ ] **Step 4: Add the npm script**

In `api/package.json`, alongside `db:preflight:money` (line 20), add:

```json
    "legs:backfill": "tsx scripts/backfill-booking-legs.ts",
    "legs:check": "tsx scripts/check-booking-legs.ts",
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd api && npx vitest run src/db/backfillBookingLegs.test.ts
```

Expected: PASS — 5 tests.

- [ ] **Step 6: Run the full gate**

```bash
cd api && npm run check
```

- [ ] **Step 7: Commit**

```bash
git add api/scripts/backfill-booking-legs.ts api/src/db/backfillBookingLegs.test.ts api/package.json
git commit -m "feat(legs): idempotent backfill for existing bookings, with a skip report"
```

---

### Task 6: The Phase 1 gate — reconcile before anything else is built

Phase 2 must not start until legs are known to be correct in production. This task produces the
evidence.

**Files:**
- Create: `api/scripts/check-booking-legs.ts`

- [ ] **Step 1: Write the reconciliation script**

Create `api/scripts/check-booking-legs.ts`:

```ts
// Phase 1's gate. Prints one line per discrepancy between what a booking says its route is and
// what its legs say. Read-only — it writes nothing.
import { config as loadEnv } from 'dotenv';
import { eq } from 'drizzle-orm';
import { createDb } from '../src/db/client';
import { bookings, bookingLegs, transferRequests, tripRequests } from '../src/db/schema';

loadEnv({ path: '.env', quiet: true });

// Same rule as the backfill: name the target explicitly. api/.env points at production.
const url = process.env.BACKFILL_DATABASE_URL;
if (!url) throw new Error('Set BACKFILL_DATABASE_URL to the database you mean to read.');
const { db } = createDb(url);

async function main(): Promise<void> {
  const all = await db.select({ id: bookings.id, mode: bookings.mode, ref: bookings.reference }).from(bookings);
  let ok = 0;
  const problems: string[] = [];

  for (const b of all) {
    const legs = await db.select().from(bookingLegs).where(eq(bookingLegs.bookingId, b.id));
    if (b.mode === 'shared') {
      if (legs.length) problems.push(`${b.ref}: shared booking has ${legs.length} legs, expected 0`);
      else ok += 1;
      continue;
    }
    if (b.mode === 'single') {
      const [t] = await db.select().from(transferRequests).where(eq(transferRequests.bookingId, b.id));
      if (!t) { problems.push(`${b.ref}: single booking has no transfer_request`); continue; }
      if (legs.length !== 1) { problems.push(`${b.ref}: expected 1 leg, found ${legs.length}`); continue; }
      if (legs[0].fromPlace !== t.fromPlace || legs[0].toPlace !== t.toPlace) {
        problems.push(`${b.ref}: leg ${legs[0].fromPlace}→${legs[0].toPlace} ≠ transfer ${t.fromPlace}→${t.toPlace}`);
        continue;
      }
      ok += 1;
      continue;
    }
    const [t] = await db.select().from(tripRequests).where(eq(tripRequests.bookingId, b.id));
    if (!t) { problems.push(`${b.ref}: trip booking has no trip_request`); continue; }
    if (!legs.length) { problems.push(`${b.ref}: trip with ${t.stops.length} stops has no legs`); continue; }
    // Every leg's endpoints must appear in the trip's stops, and the chain must start and end where
    // the trip does. A day row legitimately spans several stops, so counts are not compared.
    if (legs[0].fromPlace !== t.stops[0] || legs[legs.length - 1].toPlace !== t.stops[t.stops.length - 1]) {
      problems.push(`${b.ref}: legs run ${legs[0].fromPlace}→${legs[legs.length - 1].toPlace}, trip runs ${t.stops[0]}→${t.stops[t.stops.length - 1]}`);
      continue;
    }
    ok += 1;
  }

  console.log(`reconciled : ${ok}`);
  console.log(`problems   : ${problems.length}`);
  for (const p of problems) console.log(`  ${p}`);
  process.exit(problems.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run the full gate**

```bash
cd api && npm run check
```

- [ ] **Step 3: Commit**

```bash
git add api/scripts/check-booking-legs.ts
git commit -m "chore(legs): reconciliation script — the Phase 1 gate"
```

- [ ] **Step 4: Open the PR**

```bash
cd /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/pickup-details
git push -u origin spec/post-payment-trip-details
gh pr create --base main --title "Phase 1: booking legs" --body "$(cat <<'EOF'
Gives every journey in a booking its own record, so Phase 2 can attach a customer-supplied hotel to
a journey rather than to a position in `trip_request.stops[]`.

**Contains a migration.** `0042_booking_legs.sql` creates a table and moves no data — merging it
releases it to staging (migrations auto-apply on Render boot). The backfill is a separate script,
run deliberately.

No customer-visible change. No endpoint, no UI.

Spec: `docs/superpowers/specs/2026-08-08-post-payment-trip-details-design.md`
Plan: `docs/superpowers/plans/2026-08-08-booking-legs-phase-1.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: After the PR merges to main (staging), run the backfill against staging**

```bash
cd api && BACKFILL_DATABASE_URL="<staging session-pooler URL>" npm run legs:backfill
cd api && BACKFILL_DATABASE_URL="<staging session-pooler URL>" npm run legs:check
```

**Never run these without `BACKFILL_DATABASE_URL` set to the database you mean.** `api/.env`'s
`DATABASE_URL` is production Supabase; the scripts refuse to fall back to it on purpose. Staging uses
the Session pooler on port 5432, not 6543.

Expected: the backfill reports a skip count of zero, or every skip is explained; the check reports
`problems : 0` and exits 0.

**Phase 2 does not begin until that check passes against production.**

---

## Self-Review

**Spec coverage (Phase 1 sections only):**

| Spec | Task |
|---|---|
| §1 `booking_legs` table and columns | Task 2 |
| §1 time has one source of truth — backfill copies `travel_time` in | Task 5 (`pickupTime` carried) |
| §1 written by both writers, in-transaction | Tasks 3, 4 |
| §1 `mode: 'shared'` produces none | Tasks 3, 5, 6 |
| §1.1 `kind` = leg / day; chauffeur grouped by travel day; via_stops recorded | Tasks 1, 2 |
| §1.1 idle days produce no row | Task 1 — idle days are not segments, so nothing derives them |
| §1.2 re-derivation on edit | **Deliberately deferred** — no caller exists (see Scope decisions) |
| §9 backfill: defensive, skips counted, idempotent | Task 5 |
| §9 phase 1 verified in prod before phase 2 | Task 6 |

**Not covered here, by design:** everything in §2–§8 and §10 is Phase 2 (card, endpoint, guard, ops
surface, instrumentation, history).

**Type consistency:** `DerivedLeg` (Task 1) is the shape returned by `deriveSingleLegs` /
`deriveTripLegs`, extended with `bookingId` by `legRowsForBooking` (Task 3) and by `planBackfill`
(Task 5) as `NewLegRow`. `BookingLegKind` values `'leg' | 'day' | 'gap'` match the
`booking_legs_kind_valid` check constraint in Task 2 and the assertions in Tasks 1, 3, 4.

**Deliberate deviation from the spec, restated for a reviewer:** the spec's §9 puts the backfill in
the migration. This plan does not, because migrations fail closed on boot and a malformed historical
row would keep the API down. The spec's intent — every existing booking gets legs, skips are counted
— is preserved.
