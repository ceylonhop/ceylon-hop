# Quote Engine (M11) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a server-authoritative pricing engine (`api/src/quote/`) that prices shared / private / chauffeur trips from a locked rate card and exposes `POST /quote` for the internal quoting tool + ops dashboard. **Nothing is charged by this plan** — making the engine the booking *charge* authority is deferred to a follow-up plan (it requires the website to display the engine's price first, and a deterministic recompute; see "Follow-up plan" at the end).

**Architecture:** A pure, dependency-free pricing core (`src/quote/`) in **integer USD cents**, fed by a versioned rate-card config module. Shared seat prices are NOT duplicated — they stay in the corridor/`departureRepo` and are passed in. A thin Hono route (`POST /quote`) consumes the `quote()` function. The frozen front-end and the booking/charge path are **untouched** in this plan.

**Tech Stack:** Node 20, TypeScript (strict), Hono, Zod, Vitest, Drizzle/Postgres. Money = integer minor units (cents) + ISO currency string, matching the existing codebase convention.

## Why this scope (architecture-review outcome)

An adversarial review killed the original "recompute overrides the charge at booking time" approach: the frozen site still shows the *old* formula, and the maps adapter is **non-deterministic** (dev haversine vs prod Google differ 14–36%), so a server re-fetch would charge customers a number they never saw and trip the tamper check on nearly every booking. The fix: **the engine becomes the charge authority only after the website displays its price (so displayed == charged) and pricing is deterministic (price on the submitted inputs, not a re-fetch).** That work is a separate follow-up plan. This plan ships the safe half: the engine + `POST /quote`.

## Global Constraints

- **Backend lives in `api/` only.** Never edit the frozen front-end. (CLAUDE.md rule 3.)
- **Money = integer cents + currency string** (the existing convention). No floats in money math. No `Money` object wrapper.
- **Rate card is a versioned code module.** `RATE_CARD.version` stamped on every quote.
- **Rates (all sell prices include 25% markup):** car `46`¢/km, van `83`¢/km, chauffeur day `3500`¢, floors car `2900`¢ / van `5000`¢, idle-day min km car `100` / van `150`, deposit `min(10% × total, 5000¢)`, Colombo-pickup surcharge `300`¢/seat.
- **Vehicle (web):** car ≤ 3 pax & ≤ 3 bags · van ≤ 6 pax · bigger → not priced (`TOO_BIG`).
- **Extras (cents):** sightseeing `1000`, safari-wait `1900`, luggage `500`, front `800`, flex `1200`; extra bag `1000`.
- **Distance is an input** to the engine (caller supplies `distanceKm`); the engine never fetches it.
- **Shared seat price is an input** (`seatPriceCents`), sourced from the corridor repo — not the rate card.
- **TDD:** failing test → watch it fail → minimal impl → watch it pass → commit. Gate: `npm run check` green before each commit.
- **Commands run from `api/`.**

---

### Task 1: Rate-card config module

**Files:**
- Create: `api/src/quote/rateCard.ts`
- Test: `api/src/quote/rateCard.test.ts`

**Interfaces:**
- Produces: `RATE_CARD` (frozen const) + types `Vehicle = 'car' | 'van'`, `ExtraCode`.

- [ ] **Step 1: Write the failing test**

```ts
// api/src/quote/rateCard.test.ts
import { describe, it, expect } from 'vitest';
import { RATE_CARD } from './rateCard';

describe('RATE_CARD', () => {
  it('exposes the locked v1 rates in cents (incl. 25% markup)', () => {
    expect(RATE_CARD.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(RATE_CARD.currency).toBe('USD');
    expect(RATE_CARD.markupPct).toBe(25);
    expect(RATE_CARD.perKmCents).toEqual({ car: 46, van: 83 });
    expect(RATE_CARD.floorCents).toEqual({ car: 2900, van: 5000 });
    expect(RATE_CARD.chauffeur).toEqual({ dayRateCents: 3500, idleMinKm: { car: 100, van: 150 } });
    expect(RATE_CARD.deposit).toEqual({ pct: 10, capCents: 5000 });
    expect(RATE_CARD.vehicle).toEqual({ car: { maxPax: 3, maxBags: 3 }, van: { maxPax: 6, maxBags: 6 } });
    expect(RATE_CARD.extras['safari-wait']).toBe(1900);
    expect(RATE_CARD.shared.colomboPickupCents).toBe(300);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx vitest run src/quote/rateCard.test.ts`
Expected: FAIL — cannot find module `./rateCard`.

- [ ] **Step 3: Write minimal implementation**

```ts
// api/src/quote/rateCard.ts
export type Vehicle = 'car' | 'van';
export type ExtraCode = 'sightseeing' | 'safari-wait' | 'luggage' | 'front' | 'flex';

export const RATE_CARD = {
  version: '2026-06-28',
  currency: 'USD',
  markupPct: 25,
  perKmCents: { car: 46, van: 83 },
  costPerKmCents: { car: 37, van: 66 }, // for margin reporting only
  floorCents: { car: 2900, van: 5000 },
  chauffeur: { dayRateCents: 3500, idleMinKm: { car: 100, van: 150 } },
  deposit: { pct: 10, capCents: 5000 },
  vehicle: { car: { maxPax: 3, maxBags: 3 }, van: { maxPax: 6, maxBags: 6 } },
  extras: { sightseeing: 1000, 'safari-wait': 1900, luggage: 500, front: 800, flex: 1200 },
  shared: { colomboPickupCents: 300 },
} as const;
```

> Note: there is **no `extraBagCents`** in v1 — extra-bag handling is a front-end/shared concern, deferred. Bags drive *vehicle selection*, not a per-bag charge.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx vitest run src/quote/rateCard.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd api && git add src/quote/rateCard.ts src/quote/rateCard.test.ts
git commit -m "feat(quote): rate-card config module (M11 task 1)"
```

---

### Task 2: Shared engine types

**Files:**
- Create: `api/src/quote/types.ts`

**Interfaces:**
- Produces: `PrivateLeg`, `SharedLeg`, `ChauffeurTravelDay`, `QuoteRequest`, `LineItem`, `QuoteResult`.

- [ ] **Step 1: Write the module** (type-only; exercised by Task 3+ tests and `npm run typecheck`)

```ts
// api/src/quote/types.ts
import type { Vehicle, ExtraCode } from './rateCard';

export interface PrivateLeg { from: string; to: string; distanceKm: number }
export interface SharedLeg { routeId: string; seats: number; seatPriceCents: number; colomboPickup?: boolean }
export interface ChauffeurTravelDay { date: string; from: string; to: string; distanceKm: number }

export type QuoteRequest =
  | { product: 'shared'; legs: SharedLeg[] }
  | { product: 'private'; vehicle: Vehicle; pax: number; bags: number; legs: PrivateLeg[]; extras?: ExtraCode[] }
  | { product: 'chauffeur'; vehicle: Vehicle; firstDate: string; lastDate: string; travelDays: ChauffeurTravelDay[]; extras?: ExtraCode[] };

export interface LineItem { label: string; amountCents: number; meta?: Record<string, unknown> }

export interface QuoteResult {
  product: 'shared' | 'private' | 'chauffeur';
  currency: 'USD';
  lineItems: LineItem[];
  subtotalCents: number;
  totalCents: number;
  depositCents: number;
  amountDueNowCents: number;
  marginEstimateCents: number; // total − cost basis; surfaced to internal/ops callers only
  rateCardVersion: string;
  warnings: string[];
}
```

- [ ] **Step 2: Typecheck**

Run: `cd api && npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
cd api && git add src/quote/types.ts
git commit -m "feat(quote): engine domain types (M11 task 2)"
```

---

### Task 3: Vehicle selection

**Files:**
- Create: `api/src/quote/vehicle.ts`
- Test: `api/src/quote/vehicle.test.ts`

**Interfaces:**
- Consumes: `RATE_CARD`.
- Produces: `selectVehicle(pax: number, bags: number): 'car' | 'van' | 'too_big'`.

- [ ] **Step 1: Write the failing test**

```ts
// api/src/quote/vehicle.test.ts
import { describe, it, expect } from 'vitest';
import { selectVehicle } from './vehicle';

describe('selectVehicle', () => {
  it('car for ≤3 pax and ≤3 bags', () => {
    expect(selectVehicle(1, 1)).toBe('car');
    expect(selectVehicle(3, 3)).toBe('car');
  });
  it('van when pax 4–6, or 1–3 pax with too many bags', () => {
    expect(selectVehicle(4, 2)).toBe('van');
    expect(selectVehicle(6, 6)).toBe('van');
    expect(selectVehicle(2, 5)).toBe('van');
  });
  it('too_big above van capacity', () => {
    expect(selectVehicle(7, 1)).toBe('too_big');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx vitest run src/quote/vehicle.test.ts`
Expected: FAIL — cannot find module `./vehicle`.

- [ ] **Step 3: Write minimal implementation**

```ts
// api/src/quote/vehicle.ts
import { RATE_CARD, type Vehicle } from './rateCard';

export function selectVehicle(pax: number, bags: number): Vehicle | 'too_big' {
  const { car, van } = RATE_CARD.vehicle;
  if (pax <= car.maxPax && bags <= car.maxBags) return 'car';
  if (pax <= van.maxPax) return 'van';
  return 'too_big';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx vitest run src/quote/vehicle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd api && git add src/quote/vehicle.ts src/quote/vehicle.test.ts
git commit -m "feat(quote): vehicle selection (M11 task 3)"
```

---

### Task 4: Private leg + route pricing (with floor)

**Files:**
- Create: `api/src/quote/private.ts`
- Test: `api/src/quote/private.test.ts`

**Interfaces:**
- Consumes: `RATE_CARD`, `PrivateLeg`, `Vehicle`.
- Produces:
  - `legPriceCents(distanceKm: number, vehicle: Vehicle): number`
  - `quotePrivateLegs(legs: PrivateLeg[], vehicle: Vehicle): { lineItems: LineItem[]; subtotalCents: number; warnings: string[] }`

- [ ] **Step 1: Write the failing test** (golden cases from the worked-examples doc)

```ts
// api/src/quote/private.test.ts
import { describe, it, expect } from 'vitest';
import { legPriceCents, quotePrivateLegs } from './private';

describe('legPriceCents', () => {
  it('prices per km (Tatia Kandy→Nanu Oya 80km car = $36.80)', () => {
    expect(legPriceCents(80, 'car')).toBe(3680);
  });
  it('applies the $29 car floor on short legs (35km → $29)', () => {
    expect(legPriceCents(35, 'car')).toBe(2900);
  });
  it('applies the $50 van floor (40km van = 3320 → floored to 5000)', () => {
    expect(legPriceCents(40, 'van')).toBe(5000);
  });
  it('van per-km above the floor (200km van = $166)', () => {
    expect(legPriceCents(200, 'van')).toBe(16600);
  });
});

describe('quotePrivateLegs', () => {
  it('sums legs and warns on floored legs (Julián Mirissa→Tangalle + Yala→Tangalle)', () => {
    const r = quotePrivateLegs(
      [
        { from: 'Mirissa', to: 'Tangalle', distanceKm: 35 }, // → floor $29
        { from: 'Yala', to: 'Tangalle', distanceKm: 75 },    // → $34.50
      ],
      'car',
    );
    expect(r.subtotalCents).toBe(2900 + 3450);
    expect(r.lineItems).toHaveLength(2);
    expect(r.warnings).toContain('Mirissa→Tangalle hit the $29 car minimum');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx vitest run src/quote/private.test.ts`
Expected: FAIL — cannot find module `./private`.

- [ ] **Step 3: Write minimal implementation**

```ts
// api/src/quote/private.ts
import { RATE_CARD, type Vehicle } from './rateCard';
import type { PrivateLeg, LineItem } from './types';

export function legPriceCents(distanceKm: number, vehicle: Vehicle): number {
  const perKm = Math.round(distanceKm * RATE_CARD.perKmCents[vehicle]);
  return Math.max(RATE_CARD.floorCents[vehicle], perKm);
}

export function quotePrivateLegs(
  legs: PrivateLeg[],
  vehicle: Vehicle,
): { lineItems: LineItem[]; subtotalCents: number; warnings: string[] } {
  const lineItems: LineItem[] = [];
  const warnings: string[] = [];
  let subtotalCents = 0;
  const floor = RATE_CARD.floorCents[vehicle];
  const dollars = vehicle === 'car' ? '$29' : '$50';

  for (const leg of legs) {
    const amountCents = legPriceCents(leg.distanceKm, vehicle);
    if (amountCents === floor && Math.round(leg.distanceKm * RATE_CARD.perKmCents[vehicle]) < floor) {
      warnings.push(`${leg.from}→${leg.to} hit the ${dollars} ${vehicle} minimum`);
    }
    lineItems.push({
      label: `${leg.from} → ${leg.to} (${vehicle})`,
      amountCents,
      meta: { distanceKm: leg.distanceKm, vehicle },
    });
    subtotalCents += amountCents;
  }
  return { lineItems, subtotalCents, warnings };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx vitest run src/quote/private.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd api && git add src/quote/private.ts src/quote/private.test.ts
git commit -m "feat(quote): private leg + route pricing with floors (M11 task 4)"
```

---

### Task 5: Shared pricing

> **Note (shared price source — open ops decision, does NOT block this function):** `seatPriceCents`
> is a **passed-in input**, so `quoteSharedLegs` is correct regardless of the price values. Separately,
> the *canonical* seat-price source (the corridor repo) and whether shared is priced **per-corridor**
> (one flat price) or **per-leg-pair** are unresolved — the corridor repo's seeded prices don't yet
> match the worked-examples, and one corridor currently can't hold per-leg prices (Negombo→Sigiriya
> $19 and Sigiriya→Kandy $17 are the *same* corridor). That reconciliation belongs to the
> website-display/recompute follow-up, not this engine function. The golden test below uses an
> explicit `seatPriceCents` literal, so it's unaffected.

**Files:**
- Create: `api/src/quote/shared.ts`
- Test: `api/src/quote/shared.test.ts`

**Interfaces:**
- Consumes: `RATE_CARD`, `SharedLeg`.
- Produces: `quoteSharedLegs(legs: SharedLeg[]): { lineItems: LineItem[]; subtotalCents: number }`. Seat price supplied per leg (`seatPriceCents`, from the corridor repo). Colombo pickup adds `RATE_CARD.shared.colomboPickupCents` per seat.

- [ ] **Step 1: Write the failing test** (Arvid, Hakan from the worked-examples doc)

```ts
// api/src/quote/shared.test.ts
import { describe, it, expect } from 'vitest';
import { quoteSharedLegs } from './shared';

describe('quoteSharedLegs', () => {
  it('seat price × seats (Arvid Negombo→Sigiriya 2 seats @ $19 = $38)', () => {
    const r = quoteSharedLegs([{ routeId: 'negombo->sigiriya', seats: 2, seatPriceCents: 1900 }]);
    expect(r.subtotalCents).toBe(3800);
  });
  it('adds the $3/seat Colombo pickup surcharge (Hakan 1 seat @ $19 + $3 = $22)', () => {
    const r = quoteSharedLegs([
      { routeId: 'negombo->sigiriya', seats: 1, seatPriceCents: 1900, colomboPickup: true },
    ]);
    expect(r.subtotalCents).toBe(2200);
    expect(r.lineItems).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx vitest run src/quote/shared.test.ts`
Expected: FAIL — cannot find module `./shared`.

- [ ] **Step 3: Write minimal implementation**

```ts
// api/src/quote/shared.ts
import { RATE_CARD } from './rateCard';
import type { SharedLeg, LineItem } from './types';

export function quoteSharedLegs(legs: SharedLeg[]): { lineItems: LineItem[]; subtotalCents: number } {
  const lineItems: LineItem[] = [];
  let subtotalCents = 0;
  for (const leg of legs) {
    const seatTotal = leg.seatPriceCents * leg.seats;
    lineItems.push({ label: `${leg.routeId} × ${leg.seats} seat(s)`, amountCents: seatTotal });
    subtotalCents += seatTotal;
    if (leg.colomboPickup) {
      const surcharge = RATE_CARD.shared.colomboPickupCents * leg.seats;
      lineItems.push({ label: `Colombo city pickup × ${leg.seats}`, amountCents: surcharge });
      subtotalCents += surcharge;
    }
  }
  return { lineItems, subtotalCents };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx vitest run src/quote/shared.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd api && git add src/quote/shared.ts src/quote/shared.test.ts
git commit -m "feat(quote): shared seat pricing (M11 task 5)"
```

---

### Task 6: Chauffeur pricing

**Files:**
- Create: `api/src/quote/chauffeur.ts`
- Test: `api/src/quote/chauffeur.test.ts`

**Interfaces:**
- Consumes: `RATE_CARD`, `ChauffeurTravelDay`, `Vehicle`.
- Produces: `quoteChauffeur(input: { vehicle: Vehicle; firstDate: string; lastDate: string; travelDays: ChauffeurTravelDay[] }): { lineItems: LineItem[]; subtotalCents: number; meta: { days: number; idleDays: number; billableKm: number } }`. `firstDate`/`lastDate` are **date-only** `YYYY-MM-DD` (any time component is stripped, to avoid SL-timezone off-by-one). `days = lastDate − firstDate + 1`, clamped to ≥ 1. `idleDays = max(0, days − travelDays.length)`.

- [ ] **Step 1: Write the failing test** (Ayan + Emma golden cases + the guard cases)

```ts
// api/src/quote/chauffeur.test.ts
import { describe, it, expect } from 'vitest';
import { quoteChauffeur } from './chauffeur';

describe('quoteChauffeur', () => {
  it('Ayan: 3 days, 2 travel + 1 idle (car) = $323.50', () => {
    const r = quoteChauffeur({
      vehicle: 'car', firstDate: '2026-11-02', lastDate: '2026-11-04',
      travelDays: [
        { date: '2026-11-02', from: 'Hikkaduwa', to: 'N.Eliya', distanceKm: 165 },
        { date: '2026-11-04', from: 'N.Eliya', to: 'Hiriketiya', distanceKm: 210 },
      ],
    });
    expect(r.meta).toEqual({ days: 3, idleDays: 1, billableKm: 475 });
    expect(r.subtotalCents).toBe(32350);
  });

  it('Emma: 9 days, 5 travel + 4 idle (car) = $867', () => {
    const r = quoteChauffeur({
      vehicle: 'car', firstDate: '2026-02-14', lastDate: '2026-02-22',
      travelDays: [
        { date: '2026-02-14', from: 'Airport', to: 'Kandy', distanceKm: 120 },
        { date: '2026-02-16', from: 'Kandy', to: 'Sigiriya day trip', distanceKm: 200 },
        { date: '2026-02-17', from: 'Kandy', to: 'Ella', distanceKm: 140 },
        { date: '2026-02-19', from: 'Ella', to: 'Bentota', distanceKm: 230 },
        { date: '2026-02-22', from: 'Bentota', to: 'Airport', distanceKm: 110 },
      ],
    });
    expect(r.meta).toEqual({ days: 9, idleDays: 4, billableKm: 1200 });
    expect(r.subtotalCents).toBe(86700);
  });

  it('clamps idleDays to 0 when travelDays exceed the date span (bad input)', () => {
    const r = quoteChauffeur({
      vehicle: 'car', firstDate: '2026-03-01', lastDate: '2026-03-01',
      travelDays: [
        { date: '2026-03-01', from: 'A', to: 'B', distanceKm: 50 },
        { date: '2026-03-01', from: 'B', to: 'C', distanceKm: 50 },
      ],
    });
    expect(r.meta.days).toBe(1);
    expect(r.meta.idleDays).toBe(0); // not −1
    expect(r.meta.billableKm).toBe(100);
  });

  it('ignores a time component on the dates (no SL-timezone off-by-one)', () => {
    const r = quoteChauffeur({
      vehicle: 'car', firstDate: '2026-02-14T23:30:00+05:30', lastDate: '2026-02-15T01:00:00+05:30',
      travelDays: [{ date: '2026-02-14', from: 'A', to: 'B', distanceKm: 50 }],
    });
    expect(r.meta.days).toBe(2); // 14th and 15th, regardless of clock time
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx vitest run src/quote/chauffeur.test.ts`
Expected: FAIL — cannot find module `./chauffeur`.

- [ ] **Step 3: Write minimal implementation**

```ts
// api/src/quote/chauffeur.ts
import { RATE_CARD, type Vehicle } from './rateCard';
import type { ChauffeurTravelDay, LineItem } from './types';

// Parse only the YYYY-MM-DD part as UTC midnight, so a time/offset never shifts the day count.
function dayNumber(date: string): number {
  const ymd = date.slice(0, 10);
  return Math.floor(Date.parse(`${ymd}T00:00:00Z`) / 86_400_000);
}

export function quoteChauffeur(input: {
  vehicle: Vehicle;
  firstDate: string;
  lastDate: string;
  travelDays: ChauffeurTravelDay[];
}): { lineItems: LineItem[]; subtotalCents: number; meta: { days: number; idleDays: number; billableKm: number } } {
  const { vehicle, firstDate, lastDate, travelDays } = input;
  const days = Math.max(1, dayNumber(lastDate) - dayNumber(firstDate) + 1);
  const idleDays = Math.max(0, days - travelDays.length);
  const travelKm = travelDays.reduce((sum, d) => sum + d.distanceKm, 0);
  const idleKm = idleDays * RATE_CARD.chauffeur.idleMinKm[vehicle];
  const billableKm = travelKm + idleKm;

  const dayCharge = days * RATE_CARD.chauffeur.dayRateCents;
  const distanceCharge = Math.round(billableKm * RATE_CARD.perKmCents[vehicle]);

  const lineItems: LineItem[] = [
    { label: `Chauffeur day rate — ${days} day(s)`, amountCents: dayCharge },
    { label: `Distance — ${billableKm} km (${travelKm} travel + ${idleKm} idle-day min)`, amountCents: distanceCharge, meta: { vehicle } },
  ];
  return { lineItems, subtotalCents: dayCharge + distanceCharge, meta: { days, idleDays, billableKm } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx vitest run src/quote/chauffeur.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd api && git add src/quote/chauffeur.ts src/quote/chauffeur.test.ts
git commit -m "feat(quote): chauffeur day-rate + idle-day pricing with guards (M11 task 6)"
```

---

### Task 7: Extras + deposit helpers

**Files:**
- Create: `api/src/quote/extrasDeposit.ts`
- Test: `api/src/quote/extrasDeposit.test.ts`

**Interfaces:**
- Consumes: `RATE_CARD`, `ExtraCode`, `LineItem`.
- Produces:
  - `priceExtras(codes: ExtraCode[]): { lineItems: LineItem[]; subtotalCents: number }`
  - `depositCents(totalCents: number): number` — `min(round(total×10%), 5000)`.

- [ ] **Step 1: Write the failing test**

```ts
// api/src/quote/extrasDeposit.test.ts
import { describe, it, expect } from 'vitest';
import { priceExtras, depositCents } from './extrasDeposit';

describe('priceExtras', () => {
  it('sums known extras (sightseeing $10 + safari-wait $19 = $29)', () => {
    const r = priceExtras(['sightseeing', 'safari-wait']);
    expect(r.subtotalCents).toBe(2900);
    expect(r.lineItems).toHaveLength(2);
  });
  it('throws on an unknown extra code', () => {
    // @ts-expect-error invalid code on purpose
    expect(() => priceExtras(['bogus'])).toThrow('UNKNOWN_EXTRA');
  });
});

describe('depositCents', () => {
  it('10% under the cap ($400 → $40)', () => {
    expect(depositCents(40000)).toBe(4000);
  });
  it('caps at $50 ($867 → $50, not $86.70)', () => {
    expect(depositCents(86700)).toBe(5000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx vitest run src/quote/extrasDeposit.test.ts`
Expected: FAIL — cannot find module `./extrasDeposit`.

- [ ] **Step 3: Write minimal implementation**

```ts
// api/src/quote/extrasDeposit.ts
import { RATE_CARD, type ExtraCode } from './rateCard';
import type { LineItem } from './types';

const EXTRA_LABELS: Record<ExtraCode, string> = {
  sightseeing: 'Sightseeing stops (up to 3h)',
  'safari-wait': 'Wait for Safari',
  luggage: 'Luggage rack',
  front: 'Child seat',
  flex: 'Flexi ticket',
};

export function priceExtras(codes: ExtraCode[]): { lineItems: LineItem[]; subtotalCents: number } {
  const lineItems: LineItem[] = [];
  let subtotalCents = 0;
  for (const code of codes) {
    const amountCents = (RATE_CARD.extras as Record<string, number>)[code];
    if (amountCents === undefined) throw new Error('UNKNOWN_EXTRA');
    lineItems.push({ label: EXTRA_LABELS[code], amountCents });
    subtotalCents += amountCents;
  }
  return { lineItems, subtotalCents };
}

export function depositCents(totalCents: number): number {
  const pct = Math.round((totalCents * RATE_CARD.deposit.pct) / 100);
  return Math.min(pct, RATE_CARD.deposit.capCents);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx vitest run src/quote/extrasDeposit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd api && git add src/quote/extrasDeposit.ts src/quote/extrasDeposit.test.ts
git commit -m "feat(quote): extras + deposit helpers (M11 task 7)"
```

---

### Task 8: Top-level `quote()` dispatcher

**Files:**
- Create: `api/src/quote/engine.ts`
- Test: `api/src/quote/engine.test.ts`

**Interfaces:**
- Consumes: all Task 3–7 functions, `QuoteRequest`, `QuoteResult`.
- Produces: `quote(req: QuoteRequest): QuoteResult`. Assembles line items, totals, deposit, `amountDueNow` (deposit for chauffeur, else total), `marginEstimateCents`, `rateCardVersion`, warnings. Throws `Error('TOO_BIG')` when private/chauffeur pax+bags exceed van; throws `Error('NO_LEGS')` when a private/chauffeur request has no legs/travelDays.

- [ ] **Step 1: Write the failing test** (full-trip golden cases + guards)

```ts
// api/src/quote/engine.test.ts
import { describe, it, expect } from 'vitest';
import { quote } from './engine';
import { RATE_CARD } from './rateCard';

describe('quote()', () => {
  it('private single leg with deposit = full total (Tatia Kandy→Nanu Oya $36.80)', () => {
    const r = quote({ product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [{ from: 'Kandy', to: 'Nanu Oya', distanceKm: 80 }] });
    expect(r.totalCents).toBe(3680);
    expect(r.amountDueNowCents).toBe(3680);
    expect(r.rateCardVersion).toBe(RATE_CARD.version);
  });

  it('private with extras adds them to the total', () => {
    const r = quote({ product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [{ from: 'Kandy', to: 'Nanu Oya', distanceKm: 80 }], extras: ['sightseeing'] });
    expect(r.totalCents).toBe(3680 + 1000);
  });

  it('chauffeur → amountDueNow is the capped deposit (Emma $867 → $50)', () => {
    const r = quote({
      product: 'chauffeur', vehicle: 'car', firstDate: '2026-02-14', lastDate: '2026-02-22',
      travelDays: [
        { date: '2026-02-14', from: 'Airport', to: 'Kandy', distanceKm: 120 },
        { date: '2026-02-16', from: 'Kandy', to: 'Sigiriya day trip', distanceKm: 200 },
        { date: '2026-02-17', from: 'Kandy', to: 'Ella', distanceKm: 140 },
        { date: '2026-02-19', from: 'Ella', to: 'Bentota', distanceKm: 230 },
        { date: '2026-02-22', from: 'Bentota', to: 'Airport', distanceKm: 110 },
      ],
    });
    expect(r.totalCents).toBe(86700);
    expect(r.amountDueNowCents).toBe(5000);
  });

  it('shared total (Hakan $22 incl pickup)', () => {
    const r = quote({ product: 'shared', legs: [{ routeId: 'negombo->sigiriya', seats: 1, seatPriceCents: 1900, colomboPickup: true }] });
    expect(r.totalCents).toBe(2200);
  });

  it('throws TOO_BIG when private pax exceeds van', () => {
    expect(() => quote({ product: 'private', vehicle: 'van', pax: 7, bags: 1, legs: [{ from: 'A', to: 'B', distanceKm: 10 }] })).toThrow('TOO_BIG');
  });

  it('never undercharges: car requested for 6 pax is priced as the required van', () => {
    const r = quote({ product: 'private', vehicle: 'car', pax: 6, bags: 1, legs: [{ from: 'A', to: 'B', distanceKm: 100 }] });
    expect(r.totalCents).toBe(8300); // 100 km × van 83¢, NOT car 46¢
    expect(r.warnings.some((w) => w.includes('vehicle set to van'))).toBe(true);
  });

  it('throws NO_LEGS on an empty private request', () => {
    expect(() => quote({ product: 'private', vehicle: 'car', pax: 1, bags: 0, legs: [] })).toThrow('NO_LEGS');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx vitest run src/quote/engine.test.ts`
Expected: FAIL — cannot find module `./engine`.

- [ ] **Step 3: Write minimal implementation**

```ts
// api/src/quote/engine.ts
import { RATE_CARD } from './rateCard';
import type { QuoteRequest, QuoteResult, LineItem } from './types';
import { selectVehicle } from './vehicle';
import { quotePrivateLegs } from './private';
import { quoteSharedLegs } from './shared';
import { quoteChauffeur } from './chauffeur';
import { priceExtras, depositCents } from './extrasDeposit';

export function quote(req: QuoteRequest): QuoteResult {
  const lineItems: LineItem[] = [];
  const warnings: string[] = [];
  let subtotalCents = 0;
  let costCents = 0;

  if (req.product === 'shared') {
    if (req.legs.length === 0) throw new Error('NO_LEGS');
    const s = quoteSharedLegs(req.legs);
    lineItems.push(...s.lineItems);
    subtotalCents += s.subtotalCents;
    // shared cost basis not modelled → margin reported as 0 (see warning)
    warnings.push('margin not modelled for shared');
  } else if (req.product === 'private') {
    if (req.legs.length === 0) throw new Error('NO_LEGS');
    const minVehicle = selectVehicle(req.pax, req.bags);
    if (minVehicle === 'too_big') throw new Error('TOO_BIG');
    // Price with the LARGER of (requested, required) — never below what the party needs; a van upgrade is allowed.
    // (Do NOT trust req.vehicle blindly: car requested for 6 pax must not be priced as a car.)
    const vehicle = req.vehicle === 'van' || minVehicle === 'van' ? 'van' : 'car';
    if (vehicle !== req.vehicle) warnings.push(`vehicle set to ${vehicle} for ${req.pax} pax / ${req.bags} bags`);
    const p = quotePrivateLegs(req.legs, vehicle);
    lineItems.push(...p.lineItems);
    warnings.push(...p.warnings);
    subtotalCents += p.subtotalCents;
    costCents += req.legs.reduce((s, l) => s + Math.round(l.distanceKm * RATE_CARD.costPerKmCents[vehicle]), 0);
    if (req.extras?.length) {
      const e = priceExtras(req.extras);
      lineItems.push(...e.lineItems);
      subtotalCents += e.subtotalCents;
    }
  } else {
    if (req.travelDays.length === 0) throw new Error('NO_LEGS');
    const c = quoteChauffeur(req);
    lineItems.push(...c.lineItems);
    subtotalCents += c.subtotalCents;
    costCents += Math.round(c.meta.billableKm * RATE_CARD.costPerKmCents[req.vehicle]);
    if (req.extras?.length) {
      const e = priceExtras(req.extras);
      lineItems.push(...e.lineItems);
      subtotalCents += e.subtotalCents;
    }
  }

  const totalCents = subtotalCents;
  const deposit = depositCents(totalCents);
  const amountDueNowCents = req.product === 'chauffeur' ? deposit : totalCents;

  return {
    product: req.product,
    currency: 'USD',
    lineItems,
    subtotalCents,
    totalCents,
    depositCents: deposit,
    amountDueNowCents,
    marginEstimateCents: totalCents - costCents,
    rateCardVersion: RATE_CARD.version,
    warnings,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx vitest run src/quote/engine.test.ts`
Expected: PASS.

- [ ] **Step 5: Full check + commit**

Run: `cd api && npm run check`
Expected: typecheck + lint + all tests PASS.

```bash
cd api && git add src/quote/engine.ts src/quote/engine.test.ts
git commit -m "feat(quote): top-level quote() dispatcher (M11 task 8)"
```

---

### Task 9: `POST /quote` endpoint

**Files:**
- Create: `api/src/routes/quote.ts`
- Test: `api/src/routes/quote.test.ts`
- Modify: `api/src/app.ts` (register the route)

**Interfaces:**
- Consumes: `quote()` (Task 8), `createApp` test pattern.
- Produces: `quoteRoutes()` factory mounted at `/quote`. Returns `QuoteResult` minus `marginEstimateCents` unless an `x-internal-key` header matches `INTERNAL_QUOTE_KEY`. Maps engine errors to `422` with codes `TOO_BIG | UNKNOWN_EXTRA | NO_LEGS`.

- [ ] **Step 1: Write the failing test**

```ts
// api/src/routes/quote.test.ts
import { describe, it, expect } from 'vitest';
import { createApp } from '../app';

function post(app: ReturnType<typeof createApp>, body: unknown, headers: Record<string, string> = {}) {
  return app.request('/quote', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

describe('POST /quote', () => {
  it('prices a private leg and hides margin from public callers', async () => {
    const res = await post(createApp(), { product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [{ from: 'Kandy', to: 'Nanu Oya', distanceKm: 80 }] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalCents).toBe(3680);
    expect(body.marginEstimateCents).toBeUndefined();
  });

  it('422 with TOO_BIG on an oversize request', async () => {
    const res = await post(createApp(), { product: 'private', vehicle: 'van', pax: 9, bags: 1, legs: [{ from: 'A', to: 'B', distanceKm: 10 }] });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('TOO_BIG');
  });

  it('400 on a malformed body', async () => {
    const res = await post(createApp(), { product: 'private' });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx vitest run src/routes/quote.test.ts`
Expected: FAIL — `/quote` returns 404 (route not mounted).

- [ ] **Step 3: Write the route**

```ts
// api/src/routes/quote.ts
import { Hono } from 'hono';
import { z } from 'zod';
import { quote } from '../quote/engine';
import type { QuoteRequest } from '../quote/types';

const ExtraCode = z.enum(['sightseeing', 'safari-wait', 'luggage', 'front', 'flex']);
const ENGINE_ERRORS = new Set(['TOO_BIG', 'UNKNOWN_EXTRA', 'NO_LEGS']);

const QuoteSchema = z.discriminatedUnion('product', [
  z.object({
    product: z.literal('shared'),
    legs: z.array(z.object({
      routeId: z.string().min(1), seats: z.number().int().min(1),
      seatPriceCents: z.number().int().min(0), colomboPickup: z.boolean().optional(),
    })).min(1),
  }),
  z.object({
    product: z.literal('private'),
    vehicle: z.enum(['car', 'van']), pax: z.number().int().min(1), bags: z.number().int().min(0),
    legs: z.array(z.object({ from: z.string().min(1), to: z.string().min(1), distanceKm: z.number().min(0) })).min(1),
    extras: z.array(ExtraCode).optional(),
  }),
  z.object({
    product: z.literal('chauffeur'),
    vehicle: z.enum(['car', 'van']), firstDate: z.string().min(1), lastDate: z.string().min(1),
    travelDays: z.array(z.object({ date: z.string().min(1), from: z.string().min(1), to: z.string().min(1), distanceKm: z.number().min(0) })).min(1),
    extras: z.array(ExtraCode).optional(),
  }),
]);

export function quoteRoutes(deps: { internalKey?: string } = {}) {
  const r = new Hono();
  r.post('/', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = QuoteSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    try {
      const result = quote(parsed.data as QuoteRequest);
      const isInternal = !!deps.internalKey && c.req.header('x-internal-key') === deps.internalKey;
      const { marginEstimateCents, ...pub } = result;
      return c.json(isInternal ? result : pub, 200);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'BAD_REQUEST';
      return c.json({ error: ENGINE_ERRORS.has(msg) ? msg : 'BAD_REQUEST' }, 422);
    }
  });
  return r;
}
```

- [ ] **Step 4: Register the route in `app.ts`**

Add near the other route imports in `api/src/app.ts`:

```ts
import { quoteRoutes } from './routes/quote';
```

and mount it alongside the existing `app.route(...)` calls (after the `/bookings` line, ~`src/app.ts:83`):

```ts
app.route('/quote', quoteRoutes({ internalKey: process.env.INTERNAL_QUOTE_KEY }));
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd api && npx vitest run src/routes/quote.test.ts`
Expected: PASS.

- [ ] **Step 6: Full check + commit**

Run: `cd api && npm run check`
Expected: all green.

```bash
cd api && git add src/routes/quote.ts src/routes/quote.test.ts src/app.ts
git commit -m "feat(quote): POST /quote endpoint (M11 task 9)"
```

---

## This plan stops here (deliberately)

The engine is live behind `POST /quote` and powers the **internal quoting tool** (margin-aware via `x-internal-key`) and the **ops dashboard**. **No customer is charged by anything above.** The legacy `pricing.ts` stubs and the `quotedTotal` passthrough in `bookings.ts` are **left untouched** — the booking/charge path does not change in this plan.

## Follow-up plan (separate — do NOT fold into this one)

Making the engine the booking *charge* authority is its own plan because it touches the frozen front-end and the live payments path. Design (from spec §2/§8, post-review):

1. **Website-display integration (labelled front-end step).** The booking page calls `POST /quote`, shows the engine's number, and submits the **full structured `QuoteRequest` (incl. the `distanceKm` it priced on)** at booking. *Displayed now equals the future charge.* This is the allowed exception to the frozen-front-end rule and must be labelled.

2. **Deterministic booking recompute.** In `bookings.ts`, replace the `quotedTotal` passthrough with:
   - map the booking payload to a `QuoteRequest` — **`pax = adults + children`** (the single-transfer schema has no `pax`; this was the bug the review caught), vehicle from `vehicleType`/`selectVehicle`, shared `seatPriceCents` from the corridor repo;
   - re-run `quote(request)` on the **submitted inputs** (deterministic — no maps re-fetch) → `canonicalCents`;
   - **total integrity:** reject `QUOTE_TAMPERED` (422) if `clientTotal !== canonicalCents` (±1¢);
   - **distance plausibility:** independently estimate each leg via the maps adapter; reject `DISTANCE_IMPLAUSIBLE` (422) if a submitted `distanceKm` is **< 60%** of the server estimate;
   - run the recompute/validation **before** `departures.holdSeats(...)` so a reject never leaks a seat hold (review finding S1);
   - persist the full `QuoteRequest` (new `quoteRequest` JSONB column on the booking) + `canonicalCents` + `rateCardVersion`;
   - then retire the `pricing.ts` stubs.

3. **Chauffeur stays OUT of web auto-charge.** `TripInput` has no per-day travel structure, so chauffeur recompute needs a new per-day itinerary interface (its own step), and a **manual discount/override field** (the model runs 15–30% above historical hand-quotes by design). Until both exist, chauffeur quotes are generated in the **internal tool only**.

## Out of scope (deferred — spec §13)

Curated common-routes distance/price table · preset-price/manual-override table · long-trip taper · per-day km cap · Loop-pass products · tiered shared seats · LKR/FX (PayHere settles LKR; the engine is USD — conversion is a separate concern).

## Open data dependencies (fill before the follow-up plan, not blocking this build)

- Canonical shared seat-price table in the corridor repo (the seeded values don't yet match the worked-examples per-leg prices; tiered pricing unconfirmed — review finding S3).
