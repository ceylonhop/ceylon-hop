# Promo codes (backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** [`2026-09-14-promo-codes-design.md`](../specs/2026-09-14-promo-codes-design.md) — read it first; section numbers (§) below refer to it.

**Goal:** A founder creates promo codes (% or $ off, optional start, expiry, max uses) through a founder-only API, and `POST /bookings/single|trip` honour an optional `promoCode`, holding a use for 2 hours and counting it for good once paid.

**Architecture:** A pure domain module (`domain/promoCode.ts`) decides what a code is and whether a booking uses it. A `promo_codes` table stores codes; uses are never stored as a counter — `BookingRepo` counts them from `bookings` + `payments` inside the booking transaction, after locking the code row. The existing manual-discount arithmetic (`resolveDiscount`) prices the code.

**Tech Stack:** Node 20 · TypeScript strict · Hono · Zod 3 · Vitest 4 · Drizzle 0.45 + Postgres · npm.

## Global Constraints

- **Unattended run.** This plan is executed by a cloud session with nobody watching. It must **never merge**, never push to `main` or `production`, never set `PROMO_CODES_ENABLED` anywhere, and never touch staging or prod. It ends with **one draft PR** to `main`.
- **Branch:** `git fetch origin && git checkout -b feat/promo-codes-backend origin/docs/promo-codes-design`. One commit per task on this branch. Do **not** create stacked PRs (a merged parent strands the child here).
- **Tests first, proven.** For every task: write the test, run it and see it FAIL, implement, run it and see it PASS. Copy the red and green output tails into `docs/superpowers/plans/2026-09-14-promo-codes-evidence.md` (created in Task 1) — the PR body links it.
- **Stop rule (CLAUDE.md rule 7).** If a step fails twice after a genuine fix attempt, or the plan contradicts the code, **stop**: commit what is green, push, open the draft PR with a "Blocked at Task N" section explaining exactly what failed, and end.
- **Gate:** `cd api && npm run check` green before every commit. Read the real exit code — never `npm test | tail` (a pipe reports tail's status).
- **Postgres tests:** suites gated on `DATABASE_URL_TEST` skip without a database. If the environment has no Postgres, say so in the evidence file; CI (`ci.yml`) runs them on the PR.
- **Money is integer cents.** No floats. **Stage by path**, never `git add -A`.
- **Every commit message** ends with a blank line and `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` (the `git commit -m` commands below omit it for brevity — add it).
- **Do not touch** `api/src/quote/rateCard.ts`, `api/src/db/departureRepo.ts`, any `@generated:` block, or any root front-end file.
- **Clock:** new code takes `now: Date` from its caller; tests never hardcode calendar dates.
- Exact values from the spec: hold `PROMO_HOLD_MS = 2 * 60 * 60 * 1000`; code shape `^[A-Z0-9-]{3,32}$`; percentage `100–3000` basis points; fixed `> 0` cents; `max_uses >= 1`; start inclusive, expiry exclusive; migration `0050_promo_codes`; flag `PROMO_CODES_ENABLED` default off; capability `promo_codes:manage` founder-only.
- Error codes (§4.4), verbatim: `promo_code_invalid`, `promo_code_not_started`, `promo_code_expired`, `promo_code_used_up`, `promo_code_not_eligible`. Booking routes answer **422**; checkout answers **409**.

## File map

| File | Responsibility |
| --- | --- |
| `api/src/domain/promoCode.ts` (new) | Types, normalisation, availability, use classification, request schemas, `PromoCodeRefusedError` |
| `api/src/quote/discount.ts` | `DiscountRequest.source` widens to `'manual' \| 'code'` |
| `api/src/services/pricing.ts` | `priceSingle`/`priceTrip` accept an optional discount |
| `api/drizzle/0050_promo_codes.sql` (new), `api/drizzle/meta/_journal.json`, `api/src/db/schema.ts` | Table + two booking columns |
| `api/src/db/promoCodeRepo.ts` (new), `api/src/db/promoCodeRow.ts` (new), `api/src/db/postgresPromoCodeRepo.ts` (new) | Code storage |
| `api/src/db/bookingRepo.ts`, `api/src/db/postgresBookingRepo.ts` | Hold, count, list, re-hold |
| `api/src/routes/bookings.ts` | `promoCode` on single/trip/shared; checkout re-hold |
| `api/src/routes/quote.ts` | Estimate preview |
| `api/src/routes/promoCodes.ts` (new) | Founder API |
| `api/src/lib/opsAuth.ts`, `api/src/config.ts`, `api/src/app.ts`, `api/src/server.ts` | Capability, flag, wiring |

---

### Task 1: Promo code domain rules

**Files:**
- Create: `api/src/domain/promoCode.ts`
- Modify: `api/src/quote/discount.ts:16-19`
- Create: `api/src/domain/promoCode.test.ts`
- Create: `docs/superpowers/plans/2026-09-14-promo-codes-evidence.md`

**Interfaces:**
- Produces: `PromoCode`, `PromoMethod`, `PromoCodeErrorCode`, `PromoUseState`, `PROMO_HOLD_MS`, `PROMO_PAID_STATUSES`, `PROMO_HELD_STATUSES`, `normalizePromoCode(raw: unknown): string | null`, `promoCodeAvailability(code: PromoCode, now: Date): 'promo_code_invalid' | 'promo_code_not_started' | 'promo_code_expired' | null`, `promoDiscountRequest(code: PromoCode): DiscountRequest`, `promoUseState(b: { status: BookingStatus; promoHoldUntil: Date | null; hasSucceededPayment: boolean }, now: Date): PromoUseState`, `CreatePromoCodeSchema`, `PatchPromoCodeSchema`, `class PromoCodeRefusedError { code: PromoCodeErrorCode }`.

- [ ] **Step 1: Create the evidence file**

```markdown
# Promo codes backend — red→green evidence

One section per task: the failing run, then the passing run (last ~15 lines of each).
```

- [ ] **Step 2: Write the failing test** — `api/src/domain/promoCode.test.ts`

```ts
// Promo code domain rules (spec docs/superpowers/specs/2026-09-14-promo-codes-design.md §4–§5).
import { describe, it, expect } from 'vitest';
import {
  normalizePromoCode,
  promoCodeAvailability,
  promoDiscountRequest,
  promoUseState,
  CreatePromoCodeSchema,
  PatchPromoCodeSchema,
  PROMO_HOLD_MS,
  type PromoCode,
} from './promoCode';
import { resolveDiscount } from '../quote/discount';

const T0 = new Date(Math.floor(Date.now() / 1000) * 1000);
const at = (ms: number) => new Date(T0.getTime() + ms);
const HOUR = 3_600_000;

function code(over: Partial<PromoCode> = {}): PromoCode {
  return {
    id: '00000000-0000-0000-0000-00000000c0de',
    code: 'SAVE10',
    method: 'percentage',
    value: 1000,
    startsAt: null,
    expiresAt: at(30 * 24 * HOUR),
    maxUses: 5,
    active: true,
    createdBy: 'founder@ceylonhop.com',
    createdAt: T0,
    updatedBy: null,
    updatedAt: null,
    ...over,
  };
}

describe('normalizePromoCode', () => {
  it('trims and upper-cases a well-formed code', () => {
    expect(normalizePromoCode('  save10 ')).toBe('SAVE10');
    expect(normalizePromoCode('new-year-26')).toBe('NEW-YEAR-26');
  });
  it('rejects anything outside 3–32 of A–Z, 0–9, -', () => {
    expect(normalizePromoCode('ab')).toBeNull();
    expect(normalizePromoCode('SAVE 10')).toBeNull();
    expect(normalizePromoCode('A'.repeat(33))).toBeNull();
    expect(normalizePromoCode('SAVE_10')).toBeNull();
    expect(normalizePromoCode(10)).toBeNull();
    expect(normalizePromoCode(undefined)).toBeNull();
  });
});

describe('promoCodeAvailability — start inclusive, expiry exclusive', () => {
  it('works inside the window', () => {
    expect(promoCodeAvailability(code(), T0)).toBeNull();
  });
  it('is not started one ms before the start, and works AT the start', () => {
    const c = code({ startsAt: at(HOUR) });
    expect(promoCodeAvailability(c, at(HOUR - 1))).toBe('promo_code_not_started');
    expect(promoCodeAvailability(c, at(HOUR))).toBeNull();
  });
  it('works one ms before expiry and is expired AT expiry', () => {
    const c = code({ expiresAt: at(HOUR) });
    expect(promoCodeAvailability(c, at(HOUR - 1))).toBeNull();
    expect(promoCodeAvailability(c, at(HOUR))).toBe('promo_code_expired');
  });
  it('reports a switched-off code as invalid, even inside its window', () => {
    expect(promoCodeAvailability(code({ active: false }), T0)).toBe('promo_code_invalid');
  });
});

describe('promoDiscountRequest', () => {
  it('maps a percentage code to basis points and a fixed code to cents, source code', () => {
    expect(promoDiscountRequest(code())).toEqual({
      source: 'code', method: 'percentage', basisPoints: 1000, reason: 'promo code SAVE10',
    });
    expect(promoDiscountRequest(code({ method: 'fixed', value: 800, code: 'TENOFF' }))).toEqual({
      source: 'code', method: 'fixed', amountCents: 800, reason: 'promo code TENOFF',
    });
  });
});

// §4.3 — the owner-approved table, one-leg car, protected minimum $29.00.
describe('the owner-approved worked examples', () => {
  it('$80.00 at 10% → $8.00 off → $72.00', () => {
    const r = resolveDiscount(promoDiscountRequest(code({ value: 1000 })), 8000, 2900);
    expect(r.appliedCents).toBe(800);
    expect(8000 - r.appliedCents).toBe(7200);
  });
  it('$35.00 at 20% → asked $7.00, only $6.00 off → $29.00', () => {
    const r = resolveDiscount(promoDiscountRequest(code({ value: 2000 })), 3500, 2900);
    expect(r.requestedCents).toBe(700);
    expect(r.appliedCents).toBe(600);
    expect(r.capReason).toBe('vehicle_minimum');
  });
  it('$29.00 at 10% → $0.00 off (the code does not apply)', () => {
    const r = resolveDiscount(promoDiscountRequest(code({ value: 1000 })), 2900, 2900);
    expect(r.appliedCents).toBe(0);
  });
});

describe('promoUseState (§5.1)', () => {
  const held = (status: Parameters<typeof promoUseState>[0]['status'], holdMs: number | null, paid = false) =>
    promoUseState({ status, promoHoldUntil: holdMs === null ? null : at(holdMs), hasSucceededPayment: paid }, T0);

  it('counts a booking with a succeeded payment as paid, whatever its status', () => {
    expect(held('cancelled', null, true)).toBe('paid');
    expect(held('payment_pending', -HOUR, true)).toBe('paid');
  });
  it('counts every paid-or-later status as paid', () => {
    for (const s of ['paid', 'confirmed', 'in_progress', 'completed', 'refunded', 'no_show'] as const) {
      expect(held(s, null)).toBe('paid');
    }
  });
  it('holds an unpaid booking only while its hold is in the future', () => {
    expect(held('draft', PROMO_HOLD_MS)).toBe('held');
    expect(held('payment_pending', 1)).toBe('held');
    expect(held('awaiting_details', 1)).toBe('held');
    expect(held('draft', 0)).toBe('released');
    expect(held('draft', -1)).toBe('released');
    expect(held('draft', null)).toBe('released');
  });
  it('releases a booking cancelled before payment', () => {
    expect(held('cancelled', PROMO_HOLD_MS)).toBe('released');
  });
});

describe('CreatePromoCodeSchema', () => {
  const base = { code: 'save10', method: 'percentage', value: 1000, expiresAt: at(HOUR).toISOString(), maxUses: 5 };
  it('normalises the code and parses dates', () => {
    const r = CreatePromoCodeSchema.parse({ ...base, startsAt: T0.toISOString() });
    expect(r.code).toBe('SAVE10');
    expect(r.expiresAt).toBeInstanceOf(Date);
    expect(r.startsAt?.getTime()).toBe(T0.getTime());
  });
  it('accepts exactly 30% and refuses anything above it or below 1%', () => {
    expect(CreatePromoCodeSchema.safeParse({ ...base, value: 3000 }).success).toBe(true);
    expect(CreatePromoCodeSchema.safeParse({ ...base, value: 3001 }).success).toBe(false);
    expect(CreatePromoCodeSchema.safeParse({ ...base, value: 99 }).success).toBe(false);
  });
  it('refuses a zero fixed amount, a bad code, a start not before expiry, and unknown fields', () => {
    expect(CreatePromoCodeSchema.safeParse({ ...base, method: 'fixed', value: 0 }).success).toBe(false);
    expect(CreatePromoCodeSchema.safeParse({ ...base, code: 'no spaces' }).success).toBe(false);
    expect(CreatePromoCodeSchema.safeParse({ ...base, startsAt: at(HOUR).toISOString() }).success).toBe(false);
    expect(CreatePromoCodeSchema.safeParse({ ...base, maxUses: 0 }).success).toBe(false);
    expect(CreatePromoCodeSchema.safeParse({ ...base, active: false }).success).toBe(false);
  });
});

describe('PatchPromoCodeSchema', () => {
  it('allows only expiry, max uses and on/off, and requires at least one', () => {
    expect(PatchPromoCodeSchema.safeParse({ maxUses: 9 }).success).toBe(true);
    expect(PatchPromoCodeSchema.safeParse({ active: false }).success).toBe(true);
    expect(PatchPromoCodeSchema.safeParse({ code: 'OTHER' }).success).toBe(false);
    expect(PatchPromoCodeSchema.safeParse({ value: 500 }).success).toBe(false);
    expect(PatchPromoCodeSchema.safeParse({}).success).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd api && npx vitest run src/domain/promoCode.test.ts`
Expected: FAIL — `Failed to resolve import "./promoCode"`.

- [ ] **Step 4: Widen the discount source** — in `api/src/quote/discount.ts`, replace the `DiscountRequest` type:

```ts
/** Who asked: a founder on an ops quote, or a customer's promo code (spec 2026-09-14 §7). */
export type DiscountSource = 'manual' | 'code';

/** What a founder asks for. Clients submit this; they never submit applied cents. */
export type DiscountRequest =
  | { source: DiscountSource; method: 'fixed'; amountCents: number; reason: string }
  | { source: DiscountSource; method: 'percentage'; basisPoints: number; reason: string };
```

- [ ] **Step 5: Write the implementation** — `api/src/domain/promoCode.ts`

```ts
// Promo codes (spec docs/superpowers/specs/2026-09-14-promo-codes-design.md §4–§5).
// Pure: no database, no clock of its own, no HTTP. Routes and repos call these so every surface
// agrees on what a code is, when it works, and whether a booking is using one.
import { z } from 'zod';
import type { DiscountRequest } from '../quote/discount';
import type { BookingStatus } from './status';

/** How long a booking holds a use before it is paid (§5.2). */
export const PROMO_HOLD_MS = 2 * 60 * 60 * 1000;

const CODE_SHAPE = /^[A-Z0-9-]{3,32}$/;

export type PromoMethod = 'fixed' | 'percentage';

export interface PromoCode {
  id: string;
  code: string;
  method: PromoMethod;
  /** Cents for `fixed`; basis points (100–3000) for `percentage`. */
  value: number;
  startsAt: Date | null;
  expiresAt: Date;
  maxUses: number;
  active: boolean;
  createdBy: string;
  createdAt: Date;
  updatedBy: string | null;
  updatedAt: Date | null;
}

export type PromoCodeErrorCode =
  | 'promo_code_invalid'
  | 'promo_code_not_started'
  | 'promo_code_expired'
  | 'promo_code_used_up'
  | 'promo_code_not_eligible';

/** Thrown by repos when a use cannot be taken; routes map `code` straight onto the response. */
export class PromoCodeRefusedError extends Error {
  constructor(public readonly code: PromoCodeErrorCode) {
    super(code);
    this.name = 'PromoCodeRefusedError';
  }
}

/** Trimmed and upper-cased, or null when it cannot be a code at all. */
export function normalizePromoCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return CODE_SHAPE.test(code) ? code : null;
}

/** §4.2 — null when the code works at `now`. Start inclusive, expiry exclusive. */
export function promoCodeAvailability(
  code: PromoCode,
  now: Date,
): 'promo_code_invalid' | 'promo_code_not_started' | 'promo_code_expired' | null {
  if (!code.active) return 'promo_code_invalid';
  if (code.startsAt && now.getTime() < code.startsAt.getTime()) return 'promo_code_not_started';
  if (now.getTime() >= code.expiresAt.getTime()) return 'promo_code_expired';
  return null;
}

/** The engine request for a code — the same arithmetic and limits as a founder discount (§4.3). */
export function promoDiscountRequest(code: PromoCode): DiscountRequest {
  const reason = `promo code ${code.code}`;
  return code.method === 'fixed'
    ? { source: 'code', method: 'fixed', amountCents: code.value, reason }
    : { source: 'code', method: 'percentage', basisPoints: code.value, reason };
}

export const PROMO_PAID_STATUSES = [
  'paid', 'confirmed', 'in_progress', 'completed', 'refunded', 'no_show',
] as const satisfies readonly BookingStatus[];
export const PROMO_HELD_STATUSES = ['draft', 'payment_pending', 'awaiting_details'] as const satisfies readonly BookingStatus[];

export type PromoUseState = 'paid' | 'held' | 'released';

/**
 * §5.1 — whether a booking carrying a code uses it. The Postgres count in postgresBookingRepo.ts
 * is the SQL twin of this function; bookingPromo.test.ts holds both to the same cases.
 */
export function promoUseState(
  b: { status: BookingStatus; promoHoldUntil: Date | null; hasSucceededPayment: boolean },
  now: Date,
): PromoUseState {
  if (b.hasSucceededPayment || (PROMO_PAID_STATUSES as readonly string[]).includes(b.status)) return 'paid';
  if (
    (PROMO_HELD_STATUSES as readonly string[]).includes(b.status) &&
    b.promoHoldUntil !== null &&
    b.promoHoldUntil.getTime() > now.getTime()
  ) {
    return 'held';
  }
  return 'released';
}

const isoDate = z.string().datetime({ offset: true }).transform((s) => new Date(s));

/** POST /admin/promo-codes (§6.5). */
export const CreatePromoCodeSchema = z
  .object({
    code: z.string().transform((s, ctx) => {
      const normalized = normalizePromoCode(s);
      if (!normalized) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'code must be 3-32 characters of A-Z, 0-9 and -' });
        return z.NEVER;
      }
      return normalized;
    }),
    method: z.enum(['fixed', 'percentage']),
    value: z.number().int(),
    startsAt: isoDate.optional(),
    expiresAt: isoDate,
    maxUses: z.number().int().min(1),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.method === 'percentage' && (v.value < 100 || v.value > 3000)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'a percentage must be 100-3000 basis points (1%-30%)' });
    }
    if (v.method === 'fixed' && v.value <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'a fixed amount must be more than 0 cents' });
    }
    if (v.startsAt && v.startsAt.getTime() >= v.expiresAt.getTime()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expiresAt'], message: 'expiry must be after the start' });
    }
  });

/** PATCH /admin/promo-codes/:id — only these three may change (§4.1). */
export const PatchPromoCodeSchema = z
  .object({
    expiresAt: isoDate.optional(),
    maxUses: z.number().int().min(1).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to change' });
```

- [ ] **Step 6: Run it to verify it passes**

Run: `cd api && npx vitest run src/domain/promoCode.test.ts && npm run typecheck`
Expected: PASS, and `tsc` exits 0 (proves `source: 'code'` is accepted by `DiscountRequest`).

- [ ] **Step 7: Gate, record evidence, commit**

```bash
cd api && npm run check; echo "exit=$?"
cd .. && git add api/src/domain/promoCode.ts api/src/domain/promoCode.test.ts api/src/quote/discount.ts docs/superpowers/plans/2026-09-14-promo-codes-evidence.md
git commit -m "feat(promo): promo code domain rules and the code discount source"
```

---

### Task 2: Pricing accepts a code discount

**Files:**
- Modify: `api/src/services/pricing.ts` (`PriceOutcome`, `runEngine`, `priceSingle`, `priceTrip`)
- Test: `api/src/services/pricing.test.ts` (append)

**Interfaces:**
- Consumes: `DiscountRequest` (Task 1).
- Produces: `priceSingle(input, maps, rateCard = RATE_CARD, discount?: DiscountRequest)`, `priceTrip(input, maps, rateCard = RATE_CARD, discount?: DiscountRequest)`. The priced arm of `PriceOutcome` gains optional `discountCents?: number` and `totalBeforeDiscountCents?: number`, present **only when a discount was passed**.

- [ ] **Step 1: Write the failing test** — append to `api/src/services/pricing.test.ts`

```ts
describe('pricing with a promo code discount (spec 2026-09-14 §7)', () => {
  const maps = new FakeMapsAdapter();
  const galle: SingleTransferInput = { ...base, from: 'Colombo Airport (CMB)', to: 'Galle', adults: 2, bags: 2 };
  const tenPercent = { source: 'code' as const, method: 'percentage' as const, basisPoints: 1000, reason: 'promo code SAVE10' };

  it('takes 10% off the finished single-transfer price and reports both totals', async () => {
    const plain = await priceSingle(galle, maps);
    const off = await priceSingle(galle, maps, RATE_CARD, tenPercent);
    if (!plain.priced || !off.priced) throw new Error('expected both to price');
    // $78.00 finished → 10% = 780¢ → $70.20. The 30% cap ($23.40) and the $29 floor do not bind.
    expect(plain.totalCents).toBe(7800);
    expect(off.discountCents).toBe(780);
    expect(off.totalBeforeDiscountCents).toBe(7800);
    expect(off.totalCents).toBe(7020);
    expect(off.amountDueNowCents).toBe(7020);
  });

  it('adds no discount fields when no discount is passed', async () => {
    const plain = await priceSingle(galle, maps);
    expect('discountCents' in plain).toBe(false);
    expect('totalBeforeDiscountCents' in plain).toBe(false);
  });

  it('discounts a trip the same way', async () => {
    const t: TripInput = { ...trip, stops: ['Colombo Airport (CMB)', 'Galle'], nights: [0, 0], serviceType: 'private' };
    const plain = await priceTrip(t, maps);
    const off = await priceTrip(t, maps, RATE_CARD, tenPercent);
    if (!plain.priced || !off.priced) throw new Error('expected both to price');
    expect(off.discountCents).toBe(Math.floor((plain.totalCents * 1000 + 5000) / 10000));
    expect(off.totalCents).toBe(plain.totalCents - off.discountCents!);
  });

  it('stays unpriced when the route cannot be resolved', async () => {
    const off = await priceSingle({ ...base, from: 'Nowhere Town', to: 'Elsewhere Village' }, maps, RATE_CARD, tenPercent);
    expect(off.priced).toBe(false);
  });
});
```

(`trip` is the `TripInput` fixture already declared in this file; `base` is the `SingleTransferInput` fixture at the top.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd api && npx vitest run src/services/pricing.test.ts -t "promo code discount"`
Expected: FAIL — `expected undefined to be 780` (the 4th argument is ignored today).

- [ ] **Step 3: Implement** — in `api/src/services/pricing.ts`

Add the import: `import type { DiscountRequest } from '../quote/discount';`

Replace `PriceOutcome`:

```ts
export type PriceOutcome =
  | {
      currency: 'USD';
      totalCents: number;
      amountDueNowCents: number;
      priced: true;
      /** Present only when a discount was requested (spec 2026-09-14 §7). 0 = limits removed it all. */
      discountCents?: number;
      totalBeforeDiscountCents?: number;
    }
  | { priced: false; reason: string };
```

Replace `runEngine`:

```ts
function runEngine(req: QuoteRequest, rateCard: RateCard = RATE_CARD, discount?: DiscountRequest): PriceOutcome {
  try {
    const result = quote(req, rateCard, discount);
    return {
      currency: 'USD',
      totalCents: result.totalCents,
      amountDueNowCents: result.totalCents,
      priced: true,
      ...(discount
        ? {
            discountCents: result.discountCents ?? 0,
            totalBeforeDiscountCents: result.totalBeforeDiscountCents ?? result.totalCents,
          }
        : {}),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (INVALID_REQUEST_ERRORS.has(msg)) throw new InvalidPricingRequestError(msg);
    return unpriced(`engine rejected the request: ${msg}`);
  }
}
```

Change the signatures and the `runEngine` calls:

```ts
export async function priceSingle(
  input: SingleTransferInput,
  maps: MapsAdapter,
  rateCard: RateCard = RATE_CARD,
  discount?: DiscountRequest,
): Promise<PriceOutcome> {
  // …body unchanged, except the final call becomes:
  //   return runEngine({ …same request… }, rateCard, discount);
}

export async function priceTrip(
  input: TripInput,
  maps: MapsAdapter,
  rateCard: RateCard = RATE_CARD,
  discount?: DiscountRequest,
): Promise<PriceOutcome> {
  // …body unchanged, except BOTH runEngine calls gain `, discount` after `rateCard`.
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd api && npx vitest run src/services/pricing.test.ts`
Expected: PASS (all existing pricing tests still pass).

- [ ] **Step 5: Gate, record evidence, commit**

```bash
cd api && npm run check; echo "exit=$?"
cd .. && git add api/src/services/pricing.ts api/src/services/pricing.test.ts docs/superpowers/plans/2026-09-14-promo-codes-evidence.md
git commit -m "feat(promo): price a single transfer or trip with a code discount"
```

---

### Task 3: `promo_codes` table and code storage

**Files:**
- Create: `api/drizzle/0050_promo_codes.sql`
- Modify: `api/drizzle/meta/_journal.json` (append entry)
- Modify: `api/src/db/schema.ts` (new table; two `bookings` columns + index)
- Create: `api/src/db/promoCodeRepo.ts`, `api/src/db/promoCodeRow.ts`, `api/src/db/postgresPromoCodeRepo.ts`
- Create: `api/src/db/promoCodeRepo.test.ts`
- Modify: `api/src/db/postgres.test.ts` (append integration block)

**Interfaces:**
- Consumes: `PromoCode` (Task 1), `pgUniqueViolation` from `postgresBookingRepo.ts`.
- Produces: `NewPromoCode`, `PromoCodePatch`, `PromoCodeTakenError`, `interface PromoCodeRepo { create(input: NewPromoCode, now: Date): Promise<PromoCode>; get(id: string): Promise<PromoCode | null>; getByCode(code: string): Promise<PromoCode | null>; list(): Promise<PromoCode[]>; update(id: string, patch: PromoCodePatch, now: Date): Promise<PromoCode | null> }`, `InMemoryPromoCodeRepo`, `PostgresPromoCodeRepo`, `toPromoCode(row)`, `promoCodeRepoContract(name, make)`; schema exports `promoCodes`, `bookings.promoCodeId`, `bookings.promoHoldUntil`.

- [ ] **Step 1: Write the failing contract test** — `api/src/db/promoCodeRepo.test.ts`

```ts
// Promo code storage contract (spec 2026-09-14 §8.2). Exported so postgres.test.ts runs the SAME
// assertions against the real database — a fake that accepts what Postgres refuses is worse than none.
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  InMemoryPromoCodeRepo,
  PromoCodeTakenError,
  type NewPromoCode,
  type PromoCodeRepo,
} from './promoCodeRepo';

const HOUR = 3_600_000;
export const uniqueCode = () => `T-${randomUUID().slice(0, 8).toUpperCase()}`;

export function makePromoCode(over: Partial<NewPromoCode> = {}): NewPromoCode {
  return {
    code: uniqueCode(),
    method: 'percentage',
    value: 1000,
    startsAt: null,
    expiresAt: new Date(Date.now() + 30 * 24 * HOUR),
    maxUses: 5,
    createdBy: 'founder@ceylonhop.com',
    ...over,
  };
}

export function promoCodeRepoContract(name: string, make: () => Promise<PromoCodeRepo>): void {
  describe(name, () => {
    it('creates a code and reads it back by id and by code', async () => {
      const repo = await make();
      const now = new Date(Math.floor(Date.now() / 1000) * 1000);
      const input = makePromoCode({ startsAt: now });
      const created = await repo.create(input, now);
      expect(created).toMatchObject({
        code: input.code, method: 'percentage', value: 1000, maxUses: 5, active: true,
        createdBy: 'founder@ceylonhop.com', updatedBy: null, updatedAt: null,
      });
      expect(created.startsAt?.getTime()).toBe(now.getTime());
      expect(created.createdAt.getTime()).toBe(now.getTime());
      expect((await repo.get(created.id))?.code).toBe(input.code);
      expect((await repo.getByCode(input.code))?.id).toBe(created.id);
      expect(await repo.getByCode(uniqueCode())).toBeNull();
      expect(await repo.get(randomUUID())).toBeNull();
    });

    it('keeps a code name unique forever, even once switched off', async () => {
      const repo = await make();
      const input = makePromoCode();
      const first = await repo.create(input, new Date());
      await repo.update(first.id, { active: false, updatedBy: 'founder@ceylonhop.com' }, new Date());
      await expect(repo.create(makePromoCode({ code: input.code }), new Date())).rejects.toBeInstanceOf(PromoCodeTakenError);
    });

    it('lists newest first', async () => {
      const repo = await make();
      const t = Date.now();
      const older = await repo.create(makePromoCode(), new Date(t));
      const newer = await repo.create(makePromoCode(), new Date(t + 1000));
      const ids = (await repo.list()).map((c) => c.id).filter((id) => id === older.id || id === newer.id);
      expect(ids).toEqual([newer.id, older.id]);
    });

    it('changes only expiry, max uses and on/off, stamping who and when', async () => {
      const repo = await make();
      const created = await repo.create(makePromoCode(), new Date());
      const at = new Date(Math.floor(Date.now() / 1000) * 1000);
      const expiresAt = new Date(at.getTime() + 60 * 24 * HOUR);
      const updated = await repo.update(created.id, { maxUses: 9, active: false, expiresAt, updatedBy: 'f@x.com' }, at);
      expect(updated).toMatchObject({ maxUses: 9, active: false, updatedBy: 'f@x.com', code: created.code, value: 1000 });
      expect(updated?.expiresAt.getTime()).toBe(expiresAt.getTime());
      expect(updated?.updatedAt?.getTime()).toBe(at.getTime());
      expect(await repo.update(randomUUID(), { maxUses: 2, updatedBy: 'f@x.com' }, at)).toBeNull();
    });

    it('refuses the rows the database refuses', async () => {
      const repo = await make();
      await expect(repo.create(makePromoCode({ value: 3001 }), new Date())).rejects.toThrow();
      await expect(repo.create(makePromoCode({ method: 'fixed', value: 0 }), new Date())).rejects.toThrow();
      await expect(repo.create(makePromoCode({ maxUses: 0 }), new Date())).rejects.toThrow();
      const exp = new Date(Date.now() + HOUR);
      await expect(repo.create(makePromoCode({ startsAt: exp, expiresAt: exp }), new Date())).rejects.toThrow();
    });
  });
}

promoCodeRepoContract('InMemoryPromoCodeRepo', async () => new InMemoryPromoCodeRepo());
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd api && npx vitest run src/db/promoCodeRepo.test.ts`
Expected: FAIL — `Failed to resolve import "./promoCodeRepo"`.

- [ ] **Step 3: Write the migration** — `api/drizzle/0050_promo_codes.sql`

```sql
-- Promo codes for website bookings (spec docs/superpowers/specs/2026-09-14-promo-codes-design.md §8.1).
-- Uses are NOT stored here. They are counted from bookings (promo_code_id + promo_hold_until) and
-- payments, so there is no counter that can drift from the bookings it describes. Additive only.
CREATE TABLE "promo_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code" text NOT NULL,
  "method" text NOT NULL,
  "value" integer NOT NULL,
  "starts_at" timestamp with time zone,
  "expires_at" timestamp with time zone NOT NULL,
  "max_uses" integer NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" text,
  "updated_at" timestamp with time zone,
  CONSTRAINT "promo_codes_code_unique" UNIQUE ("code"),
  CONSTRAINT "promo_codes_code_shape" CHECK ("code" ~ '^[A-Z0-9-]{3,32}$'),
  CONSTRAINT "promo_codes_method_valid" CHECK ("method" in ('fixed', 'percentage')),
  CONSTRAINT "promo_codes_value_valid" CHECK (
    ("method" = 'percentage' AND "value" BETWEEN 100 AND 3000) OR ("method" = 'fixed' AND "value" > 0)
  ),
  CONSTRAINT "promo_codes_max_uses_positive" CHECK ("max_uses" >= 1),
  CONSTRAINT "promo_codes_window_valid" CHECK ("starts_at" IS NULL OR "starts_at" < "expires_at"),
  CONSTRAINT "promo_codes_created_by_present" CHECK (btrim("created_by") <> '')
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "promo_code_id" uuid REFERENCES "promo_codes"("id");
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "promo_hold_until" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "bookings_promo_code_idx" ON "bookings" ("promo_code_id");
--> statement-breakpoint
-- 0048 enabled RLS on every table that existed then; a newer table must protect itself (0049 did
-- the same). No policy: PostgREST roles have no business here. The API's postgres role bypasses RLS.
ALTER TABLE "promo_codes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "promo_codes" FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE promo_codes FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE promo_codes FROM authenticated';
  END IF;
END $$;
```

- [ ] **Step 4: Register it in the journal** — append to the `entries` array in `api/drizzle/meta/_journal.json`, after the `0049_customer_short_links` entry:

```json
    {
      "idx": 50,
      "version": "7",
      "when": 1789344000000,
      "tag": "0050_promo_codes",
      "breakpoints": true
    }
```

- [ ] **Step 5: Mirror it in the Drizzle schema** — `api/src/db/schema.ts`

In the `bookings` column object, directly after `needsPricing: boolean('needs_pricing'),` add:

```ts
    // Promo codes (spec 2026-09-14 §8.1, migration 0050). Both null unless the booking was made with
    // a code. Uses are COUNTED from these plus payments — never stored as a counter.
    promoCodeId: uuid('promo_code_id').references(() => promoCodes.id),
    promoHoldUntil: timestamp('promo_hold_until', { withTimezone: true }),
```

In the `bookings` table's constraint array, after the `bookings_status_valid` check, add:

```ts
    index('bookings_promo_code_idx').on(t.promoCodeId),
```

At the end of the file add:

```ts
// Promo codes for website bookings (spec 2026-09-14 §8.1) — migration 0050. `code` is stored
// normalised (upper-case) and is unique forever, including switched-off codes.
export const promoCodes = pgTable('promo_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull(),
  method: text('method').notNull(),
  value: integer('value').notNull(),
  startsAt: timestamp('starts_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  maxUses: integer('max_uses').notNull(),
  active: boolean('active').notNull().default(true),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
}, (t) => [
  unique('promo_codes_code_unique').on(t.code),
  check('promo_codes_code_shape', sql`${t.code} ~ '^[A-Z0-9-]{3,32}$'`),
  check('promo_codes_method_valid', sql`${t.method} in ('fixed', 'percentage')`),
  check('promo_codes_value_valid', sql`(${t.method} = 'percentage' AND ${t.value} BETWEEN 100 AND 3000) OR (${t.method} = 'fixed' AND ${t.value} > 0)`),
  check('promo_codes_max_uses_positive', sql`${t.maxUses} >= 1`),
  check('promo_codes_window_valid', sql`${t.startsAt} IS NULL OR ${t.startsAt} < ${t.expiresAt}`),
  check('promo_codes_created_by_present', sql`btrim(${t.createdBy}) <> ''`),
]);
```

- [ ] **Step 6: Write the repo interface and fake** — `api/src/db/promoCodeRepo.ts`

```ts
import { randomUUID } from 'node:crypto';
import type { PromoCode, PromoMethod } from '../domain/promoCode';

// Promo code storage (spec 2026-09-14 §8.2). Stores codes only — uses are counted by BookingRepo.

export interface NewPromoCode {
  code: string; // already normalised
  method: PromoMethod;
  value: number;
  startsAt: Date | null;
  expiresAt: Date;
  maxUses: number;
  createdBy: string;
}

export interface PromoCodePatch {
  expiresAt?: Date;
  maxUses?: number;
  active?: boolean;
  updatedBy: string;
}

export class PromoCodeTakenError extends Error {
  constructor() {
    super('CODE_TAKEN');
    this.name = 'PromoCodeTakenError';
  }
}

export interface PromoCodeRepo {
  create(input: NewPromoCode, now: Date): Promise<PromoCode>;
  get(id: string): Promise<PromoCode | null>;
  /** `code` must already be normalised. */
  getByCode(code: string): Promise<PromoCode | null>;
  /** Newest first. */
  list(): Promise<PromoCode[]>;
  /** Null when no such code. */
  update(id: string, patch: PromoCodePatch, now: Date): Promise<PromoCode | null>;
}

// The same rules as the migration's CHECK constraints, so the fake refuses what Postgres refuses.
function assertStorable(c: PromoCode): void {
  const valueOk = c.method === 'percentage'
    ? Number.isInteger(c.value) && c.value >= 100 && c.value <= 3000
    : c.method === 'fixed' && Number.isInteger(c.value) && c.value > 0;
  const ok = /^[A-Z0-9-]{3,32}$/.test(c.code)
    && valueOk
    && Number.isInteger(c.maxUses) && c.maxUses >= 1
    && (c.startsAt === null || c.startsAt.getTime() < c.expiresAt.getTime())
    && c.createdBy.trim() !== '';
  if (!ok) throw new Error('PROMO_CODE_CONSTRAINT');
}

const copy = (c: PromoCode): PromoCode => ({
  ...c,
  startsAt: c.startsAt ? new Date(c.startsAt) : null,
  expiresAt: new Date(c.expiresAt),
  createdAt: new Date(c.createdAt),
  updatedAt: c.updatedAt ? new Date(c.updatedAt) : null,
});

export class InMemoryPromoCodeRepo implements PromoCodeRepo {
  private byId = new Map<string, PromoCode>();

  async create(input: NewPromoCode, now: Date): Promise<PromoCode> {
    if ([...this.byId.values()].some((c) => c.code === input.code)) throw new PromoCodeTakenError();
    const row: PromoCode = {
      ...input,
      id: randomUUID(),
      active: true,
      createdAt: new Date(now),
      updatedBy: null,
      updatedAt: null,
    };
    assertStorable(row);
    this.byId.set(row.id, row);
    return copy(row);
  }

  async get(id: string): Promise<PromoCode | null> {
    const row = this.byId.get(id);
    return row ? copy(row) : null;
  }

  async getByCode(code: string): Promise<PromoCode | null> {
    const row = [...this.byId.values()].find((c) => c.code === code);
    return row ? copy(row) : null;
  }

  async list(): Promise<PromoCode[]> {
    return [...this.byId.values()]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(copy);
  }

  async update(id: string, patch: PromoCodePatch, now: Date): Promise<PromoCode | null> {
    const row = this.byId.get(id);
    if (!row) return null;
    const next: PromoCode = {
      ...row,
      ...(patch.expiresAt !== undefined ? { expiresAt: new Date(patch.expiresAt) } : {}),
      ...(patch.maxUses !== undefined ? { maxUses: patch.maxUses } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
      updatedBy: patch.updatedBy,
      updatedAt: new Date(now),
    };
    assertStorable(next);
    this.byId.set(id, next);
    return copy(next);
  }
}
```

- [ ] **Step 7: Write the row mapper** — `api/src/db/promoCodeRow.ts` (its own file so `postgresBookingRepo.ts` and `postgresPromoCodeRepo.ts` can both import it without a cycle)

```ts
import type { promoCodes } from './schema';
import type { PromoCode, PromoMethod } from '../domain/promoCode';

export function toPromoCode(r: typeof promoCodes.$inferSelect): PromoCode {
  return {
    id: r.id,
    code: r.code,
    method: r.method as PromoMethod,
    value: r.value,
    startsAt: r.startsAt,
    expiresAt: r.expiresAt,
    maxUses: r.maxUses,
    active: r.active,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    updatedBy: r.updatedBy,
    updatedAt: r.updatedAt,
  };
}
```

- [ ] **Step 8: Write the Postgres repo** — `api/src/db/postgresPromoCodeRepo.ts`

```ts
import { desc, eq } from 'drizzle-orm';
import type { Db } from './client';
import { promoCodes } from './schema';
import { pgUniqueViolation } from './postgresBookingRepo';
import { toPromoCode } from './promoCodeRow';
import {
  PromoCodeTakenError,
  type NewPromoCode,
  type PromoCodePatch,
  type PromoCodeRepo,
} from './promoCodeRepo';
import type { PromoCode } from '../domain/promoCode';

export class PostgresPromoCodeRepo implements PromoCodeRepo {
  constructor(private readonly db: Db) {}

  async create(input: NewPromoCode, now: Date): Promise<PromoCode> {
    try {
      const [row] = await this.db.insert(promoCodes).values({ ...input, createdAt: now }).returning();
      return toPromoCode(row);
    } catch (err) {
      // Let the unique constraint decide: two concurrent creates both pass a read-then-insert.
      if (pgUniqueViolation(err)?.constraint.includes('promo_codes_code_unique')) throw new PromoCodeTakenError();
      throw err;
    }
  }

  async get(id: string): Promise<PromoCode | null> {
    const [row] = await this.db.select().from(promoCodes).where(eq(promoCodes.id, id));
    return row ? toPromoCode(row) : null;
  }

  async getByCode(code: string): Promise<PromoCode | null> {
    const [row] = await this.db.select().from(promoCodes).where(eq(promoCodes.code, code));
    return row ? toPromoCode(row) : null;
  }

  async list(): Promise<PromoCode[]> {
    const rows = await this.db.select().from(promoCodes).orderBy(desc(promoCodes.createdAt));
    return rows.map(toPromoCode);
  }

  async update(id: string, patch: PromoCodePatch, now: Date): Promise<PromoCode | null> {
    const [row] = await this.db
      .update(promoCodes)
      .set({
        ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
        ...(patch.maxUses !== undefined ? { maxUses: patch.maxUses } : {}),
        ...(patch.active !== undefined ? { active: patch.active } : {}),
        updatedBy: patch.updatedBy,
        updatedAt: now,
      })
      .where(eq(promoCodes.id, id))
      .returning();
    return row ? toPromoCode(row) : null;
  }
}
```

- [ ] **Step 9: Run the Postgres contract too** — append to `api/src/db/postgres.test.ts`

Add imports at the top:

```ts
import { PostgresPromoCodeRepo } from './postgresPromoCodeRepo';
import { promoCodeRepoContract } from './promoCodeRepo.test';
```

Append at the end of the file:

```ts
describe.skipIf(!TEST_URL)('PostgresPromoCodeRepo (integration)', () => {
  promoCodeRepoContract('contract', async () => {
    const conn = createDb(TEST_URL as string);
    await migrate(conn.db, { migrationsFolder: 'drizzle' });
    return new PostgresPromoCodeRepo(conn.db);
  });
});
```

- [ ] **Step 10: Run to verify it passes**

Run: `cd api && npx vitest run src/db/promoCodeRepo.test.ts src/db/postgres.test.ts src/db/rlsEnabled.test.ts`
Expected: in-memory contract PASS. With `DATABASE_URL_TEST` set, the Postgres contract and `rlsEnabled` PASS too; without it they report skipped — write which one happened in the evidence file.

If Postgres is available locally, also prove the migration applies from scratch: `DATABASE_URL_TEST=… npx vitest run src/db/rlsEnabled.test.ts` must pass (it migrates and checks `promo_codes` has RLS).

- [ ] **Step 11: Gate, record evidence, commit**

```bash
cd api && npm run check; echo "exit=$?"
cd .. && git add api/drizzle/0050_promo_codes.sql api/drizzle/meta/_journal.json api/src/db/schema.ts \
  api/src/db/promoCodeRepo.ts api/src/db/promoCodeRow.ts api/src/db/postgresPromoCodeRepo.ts \
  api/src/db/promoCodeRepo.test.ts api/src/db/postgres.test.ts docs/superpowers/plans/2026-09-14-promo-codes-evidence.md
git commit -m "feat(promo): promo_codes table (migration 0050) and code storage"
```

---

### Task 4: Bookings hold, count and re-hold a code

**Files:**
- Modify: `api/src/db/bookingRepo.ts` (types, interface, `InMemoryBookingRepo`)
- Modify: `api/src/db/postgresBookingRepo.ts` (`insertBooking`, `assemble`, three new methods)
- Modify: `api/src/app.ts` (attach payments to the in-memory booking repo)
- Create: `api/src/db/bookingPromo.test.ts`
- Modify: `api/src/db/postgres.test.ts` (append integration block)

**Interfaces:**
- Consumes: Task 1 domain exports; `PromoCodeRepo`, `InMemoryPromoCodeRepo`, `PostgresPromoCodeRepo`, `toPromoCode`, `makePromoCode` (Task 3).
- Produces:
  - `NewBooking` single/trip variants gain `discountTotal?: number`.
  - `Booking` gains `promoCodeId?: string | null; promoHoldUntil?: string | null` (ISO). Present **only** on bookings made with a code.
  - `interface PromoHold { code: PromoCode; now: Date }`
  - `interface PromoBookingUse { bookingId: string; reference: string; status: BookingStatus; discountCents: number; createdAt: string; use: PromoUseState }`
  - `BookingRepo.create(b, opts?: { idempotencyKey?: string; promo?: PromoHold })` — throws `PromoCodeRefusedError`.
  - `BookingRepo.promoUsage(codeId: string, now: Date): Promise<{ paid: number; held: number }>`
  - `BookingRepo.promoBookings(codeId: string, now: Date): Promise<PromoBookingUse[]>` — newest first.
  - `BookingRepo.reholdPromo(bookingId: string, code: PromoCode, now: Date): Promise<void>` — throws `PromoCodeRefusedError`.
  - `InMemoryBookingRepo.attachPayments(payments: PaymentRepo): void`

- [ ] **Step 1: Write the failing contract test** — `api/src/db/bookingPromo.test.ts`

```ts
// Promo code uses, counted from bookings (spec 2026-09-14 §5, §6.3). Exported so postgres.test.ts
// runs the SAME cases against Postgres: the SQL count and promoUseState() must never disagree.
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { InMemoryBookingRepo, type BookingRepo, type NewBooking } from './bookingRepo';
import { InMemoryPaymentRepo, type PaymentRepo } from './paymentRepo';
import { InMemoryPromoCodeRepo, type PromoCodeRepo } from './promoCodeRepo';
import { makePromoCode } from './promoCodeRepo.test';
import { PROMO_HOLD_MS, PromoCodeRefusedError, type PromoCode } from '../domain/promoCode';

const HOUR = 3_600_000;

export interface PromoEnv { bookings: BookingRepo; payments: PaymentRepo; promoCodes: PromoCodeRepo }

const sample = (): NewBooking => ({
  mode: 'single',
  input: {
    from: 'Colombo Airport (CMB)', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 2,
    customer: { firstName: 'Maya', lastName: 'Silva', email: `maya+${randomUUID().slice(0, 6)}@example.com`, whatsapp: '+34600000000', country: 'Spain' },
  },
  total: 7020,
  amountDueNow: 7020,
  currency: 'USD',
  discountTotal: 780,
});

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof PromoCodeRefusedError) return err.code;
    throw err;
  }
  return 'accepted';
}

export function bookingPromoContract(name: string, make: () => Promise<PromoEnv>): void {
  describe(name, () => {
    const T0 = new Date(Math.floor(Date.now() / 1000) * 1000);
    const at = (ms: number) => new Date(T0.getTime() + ms);

    async function setup(over: Parameters<typeof makePromoCode>[0] = {}) {
      const env = await make();
      const code = await env.promoCodes.create(makePromoCode({ expiresAt: at(30 * 24 * HOUR), ...over }), T0);
      const book = (now: Date = T0, c: PromoCode = code) => env.bookings.create(sample(), { promo: { code: c, now } });
      const markPaid = async (bookingId: string, reference: string, manual = false) => {
        const p = await env.payments.create({
          bookingId, provider: 'fake', orderId: `${reference}-${randomUUID().slice(0, 6)}`,
          amount: 7020, currency: 'USD', idempotencyKey: `pay-${bookingId}`,
        });
        if (manual) await env.payments.markSucceededManually(p.id, { reference: 'bank-123', settledBy: 'f@x.com' });
        else await env.payments.markSucceeded(p.id);
      };
      return { env, code, book, markPaid };
    }

    it('stores the code, the hold and the discount on the booking', async () => {
      const { env, code, book } = await setup();
      const b = await book();
      expect(b.promoCodeId).toBe(code.id);
      expect(b.promoHoldUntil).toBe(at(PROMO_HOLD_MS).toISOString());
      expect(b.mode === 'single' && b.discountTotal).toBe(780);
      const read = await env.bookings.get(b.id);
      expect(read?.promoCodeId).toBe(code.id);
      expect(read?.promoHoldUntil).toBe(at(PROMO_HOLD_MS).toISOString());
      expect(read?.mode === 'single' && read.discountTotal).toBe(780);
    });

    it('counts a held booking until its hold passes, with no clean-up job', async () => {
      const { env, code, book } = await setup();
      await book();
      expect(await env.bookings.promoUsage(code.id, T0)).toEqual({ paid: 0, held: 1 });
      expect(await env.bookings.promoUsage(code.id, at(PROMO_HOLD_MS - 1))).toEqual({ paid: 0, held: 1 });
      expect(await env.bookings.promoUsage(code.id, at(PROMO_HOLD_MS))).toEqual({ paid: 0, held: 0 });
    });

    it('refuses when every use is taken, and frees a use once a hold passes', async () => {
      const { book } = await setup({ maxUses: 1 });
      await book();
      expect(await refusal(book(T0))).toBe('promo_code_used_up');
      expect(await refusal(book(at(PROMO_HOLD_MS + 1)))).toBe('accepted');
    });

    it('refuses a switched-off, not-started or expired code', async () => {
      const { env, code, book } = await setup({ startsAt: at(HOUR), expiresAt: at(3 * HOUR) });
      expect(await refusal(book(T0))).toBe('promo_code_not_started');
      expect(await refusal(book(at(3 * HOUR)))).toBe('promo_code_expired');
      const off = await env.promoCodes.update(code.id, { active: false, updatedBy: 'f@x.com' }, T0);
      expect(await refusal(book(at(2 * HOUR), off!))).toBe('promo_code_invalid');
    });

    it('counts a paid booking for good, even after it is cancelled', async () => {
      const { env, code, book, markPaid } = await setup();
      const b = await book();
      await markPaid(b.id, b.reference);
      await env.bookings.setStatus(b.id, 'payment_pending');
      await env.bookings.setStatus(b.id, 'paid');
      await env.bookings.setStatus(b.id, 'cancelled', { reason: 'customer asked', by: 'f@x.com' });
      expect(await env.bookings.promoUsage(code.id, at(3 * HOUR))).toEqual({ paid: 1, held: 0 });
    });

    it('counts a succeeded payment even before the status catches up (manual mark-paid)', async () => {
      const { env, code, book, markPaid } = await setup();
      const b = await book();
      await env.bookings.setStatus(b.id, 'payment_pending');
      await markPaid(b.id, b.reference, true);
      expect(await env.bookings.promoUsage(code.id, at(3 * HOUR))).toEqual({ paid: 1, held: 0 });
    });

    it('frees the use at once when a booking is cancelled before payment', async () => {
      const { env, code, book } = await setup();
      const b = await book();
      await env.bookings.setStatus(b.id, 'cancelled', { reason: 'changed plans', by: 'f@x.com' });
      expect(await env.bookings.promoUsage(code.id, T0)).toEqual({ paid: 0, held: 0 });
    });

    it('treats awaiting_details as held', async () => {
      const { env, code, book } = await setup();
      const b = await book();
      await env.bookings.setStatus(b.id, 'awaiting_details');
      expect(await env.bookings.promoUsage(code.id, T0)).toEqual({ paid: 0, held: 1 });
    });

    it('lists the bookings that carried a code, newest first, classified', async () => {
      const { env, code, book } = await setup();
      const first = await book(T0);
      await new Promise((r) => setTimeout(r, 5)); // distinct wall-clock createdAt
      const second = await book(at(1000));
      await env.bookings.setStatus(first.id, 'cancelled', { reason: 'x', by: 'f@x.com' });
      const uses = await env.bookings.promoBookings(code.id, at(2000));
      expect(uses.map((u) => [u.bookingId, u.use])).toEqual([[second.id, 'held'], [first.id, 'released']]);
      expect(uses[0]).toMatchObject({ reference: second.reference, status: 'draft', discountCents: 780 });
    });

    describe('reholdPromo (§6.3)', () => {
      it('refreshes a valid hold, even when the code has since been switched off', async () => {
        const { env, code, book } = await setup();
        const b = await book(T0);
        const off = await env.promoCodes.update(code.id, { active: false, updatedBy: 'f@x.com' }, T0);
        await env.bookings.reholdPromo(b.id, off!, at(HOUR));
        expect((await env.bookings.get(b.id))?.promoHoldUntil).toBe(at(HOUR + PROMO_HOLD_MS).toISOString());
      });

      it('re-holds a lapsed hold when a use is free', async () => {
        const { env, code, book } = await setup();
        const b = await book(T0);
        await env.bookings.reholdPromo(b.id, code, at(3 * HOUR));
        expect((await env.bookings.get(b.id))?.promoHoldUntil).toBe(at(3 * HOUR + PROMO_HOLD_MS).toISOString());
      });

      it('refuses a lapsed hold when the code is full, off or expired', async () => {
        const full = await setup({ maxUses: 1 });
        const a = await full.book(T0);
        await full.book(at(3 * HOUR)); // A lapsed, so B takes the only use
        expect(await refusal(full.env.bookings.reholdPromo(a.id, full.code, at(3 * HOUR)))).toBe('promo_code_used_up');

        const off = await setup();
        const b = await off.book(T0);
        const switched = await off.env.promoCodes.update(off.code.id, { active: false, updatedBy: 'f@x.com' }, T0);
        expect(await refusal(off.env.bookings.reholdPromo(b.id, switched!, at(3 * HOUR)))).toBe('promo_code_invalid');

        const expiring = await setup({ expiresAt: at(HOUR) });
        const c = await expiring.book(T0);
        expect(await refusal(expiring.env.bookings.reholdPromo(c.id, expiring.code, at(3 * HOUR)))).toBe('promo_code_expired');
      });
    });

    it('never gives away more uses than the limit under concurrent bookings', async () => {
      const { env, code, book } = await setup({ maxUses: 3 });
      const results = await Promise.allSettled(Array.from({ length: 10 }, () => book(T0)));
      const accepted = results.filter((r) => r.status === 'fulfilled');
      const refused = results.filter(
        (r) => r.status === 'rejected' && r.reason instanceof PromoCodeRefusedError && r.reason.code === 'promo_code_used_up',
      );
      expect(accepted).toHaveLength(3);
      expect(refused).toHaveLength(7);
      expect(await env.bookings.promoUsage(code.id, T0)).toEqual({ paid: 0, held: 3 });
    });
  });
}

bookingPromoContract('InMemoryBookingRepo', async () => {
  const bookings = new InMemoryBookingRepo();
  const payments = new InMemoryPaymentRepo();
  bookings.attachPayments(payments);
  return { bookings, payments, promoCodes: new InMemoryPromoCodeRepo() };
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd api && npx vitest run src/db/bookingPromo.test.ts`
Expected: FAIL — `bookings.attachPayments is not a function` (and typecheck errors on the new fields).

- [ ] **Step 3: Extend the types and interface** — `api/src/db/bookingRepo.ts`

Add imports:

```ts
import type { PaymentRepo } from './paymentRepo';
import {
  PROMO_HOLD_MS,
  PromoCodeRefusedError,
  promoCodeAvailability,
  promoUseState,
  type PromoCode,
  type PromoUseState,
} from '../domain/promoCode';
```

In **both** the `mode: 'single'` and `mode: 'trip'` variants of `NewBooking`, after `termsAcceptedAt?: Date;` add:

```ts
      // Cents taken off by a promo code (spec 2026-09-14 §6.1). Absent on every other booking.
      discountTotal?: number;
```

In the `Booking` type's intersection object, after `cancelledAt?: string | null;` add:

```ts
  // Promo code (spec 2026-09-14 §5). Present only on bookings made with a code.
  promoCodeId?: string | null;
  promoHoldUntil?: string | null; // ISO
```

After the `StatusAudit` interface add:

```ts
/** A booking taking one use of a code (spec 2026-09-14 §5.3). */
export interface PromoHold {
  code: PromoCode;
  now: Date;
}

/** One booking that carried a code, for the founder's detail view (§6.5). */
export interface PromoBookingUse {
  bookingId: string;
  reference: string;
  status: BookingStatus;
  discountCents: number;
  createdAt: string;
  use: PromoUseState;
}
```

In `interface BookingRepo`, replace the `create` line and add three methods:

```ts
  // `promo` takes one use of a code inside the same write; throws PromoCodeRefusedError when the
  // code no longer works or every use is paid or held (spec 2026-09-14 §5.3).
  create(b: NewBooking, opts?: { idempotencyKey?: string; promo?: PromoHold }): Promise<Booking>;
  /** Paid and held uses of a code at `now` (§5.1). */
  promoUsage(codeId: string, now: Date): Promise<{ paid: number; held: number }>;
  /** Every booking that carried the code, newest first (§6.5). */
  promoBookings(codeId: string, now: Date): Promise<PromoBookingUse[]>;
  /** §6.3 — refresh a valid hold, or re-take a lapsed one; throws PromoCodeRefusedError. */
  reholdPromo(bookingId: string, code: PromoCode, now: Date): Promise<void>;
```

- [ ] **Step 4: Implement the in-memory repo** — in `InMemoryBookingRepo`

Add fields after `private pricingSnapshots …`:

```ts
  private payments?: PaymentRepo;
  // Per-code queue standing in for Postgres's FOR UPDATE: the count and the insert are separated by
  // awaits, so without it two concurrent bookings could both see the last use as free.
  private promoLocks = new Map<string, Promise<void>>();

  /** Lets the count see succeeded payments exactly as the Postgres query does (§5.1). */
  attachPayments(payments: PaymentRepo): void {
    this.payments = payments;
  }

  private async withPromoLock<T>(codeId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.promoLocks.get(codeId) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.promoLocks.set(codeId, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.promoLocks.get(codeId) === tail) this.promoLocks.delete(codeId);
    }
  }

  private async useOf(b: Booking, now: Date): Promise<PromoUseState> {
    const hasSucceededPayment = this.payments
      ? (await this.payments.findByBookingId(b.id)).some((p) => p.status === 'succeeded')
      : false;
    return promoUseState(
      { status: b.status, promoHoldUntil: b.promoHoldUntil ? new Date(b.promoHoldUntil) : null, hasSucceededPayment },
      now,
    );
  }
```

Replace `create` with a thin dispatcher plus a private `insert` holding the **existing** body:

```ts
  async create(b: NewBooking, opts?: { idempotencyKey?: string; promo?: PromoHold }): Promise<Booking> {
    const key = opts?.idempotencyKey;
    if (key) {
      const existingId = this.byKey.get(key);
      if (existingId) return this.byId.get(existingId)!;
    }
    const promo = opts?.promo;
    if (!promo) return this.insert(b, key);
    return this.withPromoLock(promo.code.id, async () => {
      // Re-check under the lock: a concurrent retry with the same key may have inserted meanwhile.
      if (key) {
        const existingId = this.byKey.get(key);
        if (existingId) return this.byId.get(existingId)!;
      }
      const unavailable = promoCodeAvailability(promo.code, promo.now);
      if (unavailable) throw new PromoCodeRefusedError(unavailable);
      const { paid, held } = await this.promoUsage(promo.code.id, promo.now);
      if (paid + held >= promo.code.maxUses) throw new PromoCodeRefusedError('promo_code_used_up');
      return this.insert(b, key, {
        promoCodeId: promo.code.id,
        promoHoldUntil: new Date(promo.now.getTime() + PROMO_HOLD_MS).toISOString(),
      });
    });
  }

  private insert(b: NewBooking, key: string | undefined, promo?: { promoCodeId: string; promoHoldUntil: string }): Booking {
    let reference = generateReference();
    while (this.refs.has(reference)) reference = generateReference();
    const booking: Booking = {
      ...b,
      id: randomUUID(),
      reference,
      status: 'draft',
      createdAt: new Date().toISOString(),
      channel: b.channel ?? 'website',
      billing: b.billing ?? null, // normalise absent → null, as the SQL repo does
      termsAcceptedAt: b.termsAcceptedAt ? b.termsAcceptedAt.toISOString() : null,
      ...(promo ?? {}),
    };
    this.byId.set(booking.id, booking);
    this.refs.add(reference);
    if (key) this.byKey.set(key, booking.id);
    return booking;
  }
```

Add the three methods (anywhere inside the class, e.g. after `list`):

```ts
  async promoUsage(codeId: string, now: Date): Promise<{ paid: number; held: number }> {
    let paid = 0;
    let held = 0;
    for (const b of [...this.byId.values()]) {
      if (b.promoCodeId !== codeId) continue;
      const use = await this.useOf(b, now);
      if (use === 'paid') paid++;
      else if (use === 'held') held++;
    }
    return { paid, held };
  }

  async promoBookings(codeId: string, now: Date): Promise<PromoBookingUse[]> {
    const carrying = [...this.byId.values()]
      .filter((b) => b.promoCodeId === codeId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return Promise.all(carrying.map(async (b) => ({
      bookingId: b.id,
      reference: b.reference,
      status: b.status,
      discountCents: b.mode === 'shared' ? 0 : b.discountTotal ?? 0,
      createdAt: b.createdAt,
      use: await this.useOf(b, now),
    })));
  }

  async reholdPromo(bookingId: string, code: PromoCode, now: Date): Promise<void> {
    if (!this.byId.has(bookingId)) throw new BookingNotFoundError(bookingId);
    await this.withPromoLock(code.id, async () => {
      const b = this.byId.get(bookingId)!;
      if (b.promoCodeId !== code.id) throw new Error('PROMO_CODE_MISMATCH');
      const holdValid = !!b.promoHoldUntil && new Date(b.promoHoldUntil).getTime() > now.getTime();
      if (!holdValid) {
        const unavailable = promoCodeAvailability(code, now);
        if (unavailable) throw new PromoCodeRefusedError(unavailable);
        const { paid, held } = await this.promoUsage(code.id, now); // this booking's lapsed hold is not counted
        if (paid + held >= code.maxUses) throw new PromoCodeRefusedError('promo_code_used_up');
      }
      this.byId.set(bookingId, { ...b, promoHoldUntil: new Date(now.getTime() + PROMO_HOLD_MS).toISOString() });
    });
  }
```

`promoBookings` sorts on `createdAt`, which is wall-clock; the contract test pauses 5 ms between its two bookings so they never share a millisecond. Do not change how `createdAt` is set.

- [ ] **Step 5: Wire payments in the app** — `api/src/app.ts`, directly after `const payments = deps.payments ?? new InMemoryPaymentRepo();`

```ts
  // Promo code counts treat a succeeded payment as "paid" (spec 2026-09-14 §5.1); the in-memory
  // booking repo needs the payments to see that, exactly as the Postgres query joins them.
  if (bookings instanceof InMemoryBookingRepo && payments instanceof InMemoryPaymentRepo) {
    bookings.attachPayments(payments);
  }
```

- [ ] **Step 6: Run the in-memory contract**

Run: `cd api && npx vitest run src/db/bookingPromo.test.ts`
Expected: PASS for `InMemoryBookingRepo`.

- [ ] **Step 7: Implement the Postgres repo** — `api/src/db/postgresBookingRepo.ts`

Change the drizzle import and add imports:

```ts
import { and, desc, eq, exists, gt, inArray, or, sql } from 'drizzle-orm';
import { customers, bookings, transferRequests, tripRequests, sharedRequests, bookingLegs, payments, promoCodes } from './schema';
import { toPromoCode } from './promoCodeRow';
import {
  PROMO_HELD_STATUSES,
  PROMO_HOLD_MS,
  PROMO_PAID_STATUSES,
  PromoCodeRefusedError,
  promoCodeAvailability,
  promoUseState,
  type PromoCode,
} from '../domain/promoCode';
```

Add `type PromoHold, type PromoBookingUse` to the existing `./bookingRepo` import list, and below `type BookingRow = …` add:

```ts
type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];
```

Inside the class, add private helpers:

```ts
  // SQL twin of promoUseState() (domain/promoCode.ts); bookingPromo.test.ts holds both to the same cases.
  private succeededPayment() {
    return exists(
      this.db
        .select({ one: sql`1` })
        .from(payments)
        .where(and(eq(payments.bookingId, bookings.id), eq(payments.status, 'succeeded'))),
    );
  }

  private async countUses(tx: Transaction, codeId: string, now: Date): Promise<{ paid: number; held: number }> {
    const paid = or(inArray(bookings.status, [...PROMO_PAID_STATUSES]), this.succeededPayment());
    const held = and(inArray(bookings.status, [...PROMO_HELD_STATUSES]), gt(bookings.promoHoldUntil, now));
    const [row] = await tx
      .select({
        paid: sql<number>`count(*) filter (where ${paid})`.mapWith(Number),
        held: sql<number>`count(*) filter (where not (${paid}) and ${held})`.mapWith(Number),
      })
      .from(bookings)
      .where(eq(bookings.promoCodeId, codeId));
    return { paid: row?.paid ?? 0, held: row?.held ?? 0 };
  }

  /** Lock the code row and prove a use can be taken at `now` (§5.3). */
  private async takeUse(tx: Transaction, codeId: string, now: Date): Promise<PromoCode> {
    const [locked] = await tx.select().from(promoCodes).where(eq(promoCodes.id, codeId)).for('update');
    if (!locked) throw new PromoCodeRefusedError('promo_code_invalid');
    const code = toPromoCode(locked);
    const unavailable = promoCodeAvailability(code, now);
    if (unavailable) throw new PromoCodeRefusedError(unavailable);
    const { paid, held } = await this.countUses(tx, code.id, now);
    if (paid + held >= code.maxUses) throw new PromoCodeRefusedError('promo_code_used_up');
    return code;
  }
```

Change the signatures `create(b: NewBooking, opts?: { idempotencyKey?: string; promo?: PromoHold })` and `private async insertBooking(b: NewBooking, opts?: { idempotencyKey?: string; promo?: PromoHold })`. At the **top** of the `insertBooking` transaction callback, before the customer insert, add:

```ts
      // Re-reads the code under FOR UPDATE: a code switched off or filled mid-request is not honoured.
      if (opts?.promo) await this.takeUse(tx, opts.promo.code.id, opts.promo.now);
```

In the `bookings` insert `.values({ … })`, after `termsAcceptedAt: b.termsAcceptedAt ?? null,` add:

```ts
          discountTotal: b.mode !== 'shared' && b.discountTotal !== undefined ? b.discountTotal : null,
          promoCodeId: opts?.promo ? opts.promo.code.id : null,
          promoHoldUntil: opts?.promo ? new Date(opts.promo.now.getTime() + PROMO_HOLD_MS) : null,
```

In `assemble`, inside `const base = { … }`, after `termsAcceptedAt: …,` add:

```ts
      // Only bookings made with a code carry these, so every other booking's shape is unchanged.
      ...(row.promoCodeId
        ? {
            promoCodeId: row.promoCodeId,
            promoHoldUntil: row.promoHoldUntil ? row.promoHoldUntil.toISOString() : null,
            discountTotal: row.discountTotal ?? 0,
          }
        : {}),
```

Add the three public methods:

```ts
  async promoUsage(codeId: string, now: Date): Promise<{ paid: number; held: number }> {
    return this.db.transaction((tx) => this.countUses(tx, codeId, now));
  }

  async promoBookings(codeId: string, now: Date): Promise<PromoBookingUse[]> {
    const rows = await this.db
      .select({
        id: bookings.id,
        reference: bookings.reference,
        status: bookings.status,
        discountTotal: bookings.discountTotal,
        createdAt: bookings.createdAt,
        promoHoldUntil: bookings.promoHoldUntil,
        hasSucceededPayment: sql<boolean>`${this.succeededPayment()}`,
      })
      .from(bookings)
      .where(eq(bookings.promoCodeId, codeId))
      .orderBy(desc(bookings.createdAt));
    return rows.map((r) => ({
      bookingId: r.id,
      reference: r.reference,
      status: r.status as BookingStatus,
      discountCents: r.discountTotal ?? 0,
      createdAt: r.createdAt.toISOString(),
      use: promoUseState(
        { status: r.status as BookingStatus, promoHoldUntil: r.promoHoldUntil, hasSucceededPayment: r.hasSucceededPayment === true },
        now,
      ),
    }));
  }

  async reholdPromo(bookingId: string, code: PromoCode, now: Date): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(promoCodes).where(eq(promoCodes.id, code.id)).for('update');
      if (!locked) throw new PromoCodeRefusedError('promo_code_invalid');
      const [bk] = await tx
        .select({ promoCodeId: bookings.promoCodeId, promoHoldUntil: bookings.promoHoldUntil })
        .from(bookings)
        .where(eq(bookings.id, bookingId));
      if (!bk) throw new BookingNotFoundError(bookingId);
      if (bk.promoCodeId !== code.id) throw new Error('PROMO_CODE_MISMATCH');
      const holdValid = bk.promoHoldUntil !== null && bk.promoHoldUntil.getTime() > now.getTime();
      if (!holdValid) {
        const fresh = toPromoCode(locked);
        const unavailable = promoCodeAvailability(fresh, now);
        if (unavailable) throw new PromoCodeRefusedError(unavailable);
        const { paid, held } = await this.countUses(tx, fresh.id, now);
        if (paid + held >= fresh.maxUses) throw new PromoCodeRefusedError('promo_code_used_up');
      }
      await tx
        .update(bookings)
        .set({ promoHoldUntil: new Date(now.getTime() + PROMO_HOLD_MS) })
        .where(eq(bookings.id, bookingId));
    });
  }
```

- [ ] **Step 8: Run the Postgres contract too** — append to `api/src/db/postgres.test.ts`

Imports:

```ts
import { bookingPromoContract } from './bookingPromo.test';
```

Block:

```ts
describe.skipIf(!TEST_URL)('Postgres promo code uses (integration)', () => {
  bookingPromoContract('contract', async () => {
    const conn = createDb(TEST_URL as string);
    await migrate(conn.db, { migrationsFolder: 'drizzle' });
    return {
      bookings: new PostgresBookingRepo(conn.db),
      payments: new PostgresPaymentRepo(conn.db),
      promoCodes: new PostgresPromoCodeRepo(conn.db),
    };
  });
});
```

- [ ] **Step 9: Run everything touched**

Run: `cd api && npx vitest run src/db/bookingPromo.test.ts src/db/postgres.test.ts src/routes/bookings.test.ts src/routes/checkout.test.ts`
Expected: PASS (Postgres suites PASS with `DATABASE_URL_TEST`, otherwise skipped — record which).

- [ ] **Step 10: Gate, record evidence, commit**

```bash
cd api && npm run check; echo "exit=$?"
cd .. && git add api/src/db/bookingRepo.ts api/src/db/postgresBookingRepo.ts api/src/app.ts \
  api/src/db/bookingPromo.test.ts api/src/db/postgres.test.ts docs/superpowers/plans/2026-09-14-promo-codes-evidence.md
git commit -m "feat(promo): bookings hold, count and re-hold a code use"
```

---

### Task 5: Booking routes accept a code; checkout re-checks the hold

**Files:**
- Modify: `api/src/config.ts` (flag), `api/src/app.ts` (deps + wiring), `api/src/server.ts` (Postgres repo)
- Modify: `api/src/routes/bookings.ts`
- Create: `api/src/routes/promoCodeBookings.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: `AppDeps.promoCodes?: PromoCodeRepo`, `AppDeps.promoCodesEnabled?: boolean`, `AppDeps.promoNow?: () => Date`; `bookingRoutes` deps gain the same three. Request body field `promoCode` on `/bookings/single`, `/bookings/trip`, `/bookings/shared`. Booking responses for code bookings carry `discountTotal`, `promoCodeId`, `promoHoldUntil`.

- [ ] **Step 1: Write the failing test** — `api/src/routes/promoCodeBookings.test.ts`

```ts
// Promo codes on the public booking routes and checkout (spec 2026-09-14 §6.1–§6.3).
import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { FakeMapsAdapter, type DistanceResult } from '../adapters/maps';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryPaymentRepo } from '../db/paymentRepo';
import { InMemoryConciergeTaskRepo } from '../db/conciergeTaskRepo';
import { InMemoryPromoCodeRepo, type NewPromoCode } from '../db/promoCodeRepo';
import { PROMO_HOLD_MS } from '../domain/promoCode';

const HOUR = 3_600_000;
const customer = { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' };
// Priced by the engine at $78.00 on the live card (see bookings.test.ts "prices a resolvable route").
const GALLE = { from: 'Colombo Airport (CMB)', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 2, customer };
const TRIP = { stops: ['Colombo Airport (CMB)', 'Galle'], nights: [0, 0], pax: 2, vehicleType: 'car', serviceType: 'private', customer };

class ShortHopMaps extends FakeMapsAdapter {
  async distance(): Promise<DistanceResult | null> {
    return { km: 5, durationMin: 10 };
  }
}

function world(opts: { enabled?: boolean; maps?: FakeMapsAdapter } = {}) {
  const promoCodes = new InMemoryPromoCodeRepo();
  const bookings = new InMemoryBookingRepo();
  const payments = new InMemoryPaymentRepo();
  const conciergeTasks = new InMemoryConciergeTaskRepo();
  const clock = { now: new Date(Math.floor(Date.now() / 1000) * 1000) };
  const make = (enabled = opts.enabled ?? true) =>
    createApp({
      bookings, payments, conciergeTasks, promoCodes, promoCodesEnabled: enabled, promoNow: () => clock.now,
      ...(opts.maps ? { maps: opts.maps } : {}),
    });
  const app = make();
  const seed = (over: Partial<NewPromoCode> = {}) =>
    promoCodes.create({
      code: 'SAVE10', method: 'percentage', value: 1000, startsAt: null,
      expiresAt: new Date(clock.now.getTime() + 30 * 24 * HOUR), maxUses: 5, createdBy: 'f@x.com', ...over,
    }, clock.now);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const checkout = (target: ReturnType<typeof createApp>, b: { id: string; checkoutToken: string }) =>
    target.request(`/bookings/${b.id}/checkout`, { method: 'POST', headers: { authorization: `Bearer ${b.checkoutToken}` } });
  const later = (ms: number) => { clock.now = new Date(clock.now.getTime() + ms); };
  return { app, make, promoCodes, bookings, conciergeTasks, clock, seed, post, checkout, later };
}

async function refused(w: ReturnType<typeof world>, body: unknown, error: string, path = '/bookings/single') {
  const before = (await w.bookings.list()).length;
  const res = await w.post(path, body);
  expect(res.status).toBe(422);
  expect((await res.json()).error).toBe(error);
  expect((await w.bookings.list()).length).toBe(before); // a refused code never creates a booking
}

describe('POST /bookings/single with a promo code', () => {
  it('books at the discounted price and holds a use for 2 hours', async () => {
    const w = world();
    const code = await w.seed();
    const res = await w.post('/bookings/single', { ...GALLE, promoCode: ' save10 ' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      total: 7020, amountDueNow: 7020, discountTotal: 780, promoCodeId: code.id,
      promoHoldUntil: new Date(w.clock.now.getTime() + PROMO_HOLD_MS).toISOString(),
    });
    expect(await w.bookings.promoUsage(code.id, w.clock.now)).toEqual({ paid: 0, held: 1 });
  });

  it('raises no price-mismatch alert when the site sent the full OR the discounted price', async () => {
    const w = world();
    await w.seed();
    await w.post('/bookings/single', { ...GALLE, promoCode: 'SAVE10', quotedTotal: 7800 });
    await w.post('/bookings/single', { ...GALLE, promoCode: 'SAVE10', quotedTotal: 7020 });
    expect(await w.conciergeTasks.list()).toHaveLength(0);
    await w.post('/bookings/single', { ...GALLE, promoCode: 'SAVE10', quotedTotal: 5000 });
    expect((await w.conciergeTasks.list()).map((t) => t.note)).toEqual([expect.stringContaining('price mismatch')]);
  });

  it('refuses a bad code with the right error and creates no booking', async () => {
    const w = world();
    const code = await w.seed({ maxUses: 1 });
    await refused(w, { ...GALLE, promoCode: 'NOPE-NOPE' }, 'promo_code_invalid');
    await refused(w, { ...GALLE, promoCode: 'x' }, 'promo_code_invalid');
    await w.seed({ code: 'LATER', startsAt: new Date(w.clock.now.getTime() + HOUR) });
    await refused(w, { ...GALLE, promoCode: 'LATER' }, 'promo_code_not_started');
    await w.seed({ code: 'GONE', expiresAt: new Date(w.clock.now.getTime() - 1) });
    await refused(w, { ...GALLE, promoCode: 'GONE' }, 'promo_code_expired');
    expect((await w.post('/bookings/single', { ...GALLE, promoCode: 'SAVE10' })).status).toBe(201);
    await refused(w, { ...GALLE, promoCode: 'SAVE10' }, 'promo_code_used_up');
    await w.promoCodes.update(code.id, { active: false, updatedBy: 'f@x.com' }, w.clock.now);
    await refused(w, { ...GALLE, promoCode: 'SAVE10' }, 'promo_code_invalid');
  });

  it('refuses every code while PROMO_CODES_ENABLED is off', async () => {
    const w = world({ enabled: false });
    await w.seed();
    await refused(w, { ...GALLE, promoCode: 'SAVE10' }, 'promo_code_invalid');
  });

  it('refuses a code on a booking the engine cannot price', async () => {
    const w = world();
    await w.seed();
    await refused(w, { ...GALLE, from: 'Colombo Airport', to: 'Ella', promoCode: 'SAVE10' }, 'promo_code_not_eligible');
  });

  it('refuses a code the vehicle minimum reduces to $0, and takes no use', async () => {
    const w = world({ maps: new ShortHopMaps() });
    const code = await w.seed();
    const plain = await (await w.post('/bookings/single', GALLE)).json();
    // PRECONDITION: a 5 km car hop costs exactly the $29.00 car minimum. If this assertion fails the
    // fixture is wrong, not the feature — STOP and report it (plan Global Constraints, stop rule).
    expect(plain.total).toBe(2900);
    await refused(w, { ...GALLE, promoCode: 'SAVE10' }, 'promo_code_not_eligible');
    expect(await w.bookings.promoUsage(code.id, w.clock.now)).toEqual({ paid: 0, held: 0 });
  });

  it('takes no second use when the same request is retried with its Idempotency-Key', async () => {
    const w = world();
    const code = await w.seed({ maxUses: 1 });
    const headers = { 'idempotency-key': 'promo-retry-1' };
    const first = await w.post('/bookings/single', { ...GALLE, promoCode: 'SAVE10' }, headers);
    const second = await w.post('/bookings/single', { ...GALLE, promoCode: 'SAVE10' }, headers);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect((await second.json()).id).toBe((await first.json()).id);
    expect(await w.bookings.promoUsage(code.id, w.clock.now)).toEqual({ paid: 0, held: 1 });
  });
});

describe('trips and shared seats', () => {
  it('discounts a trip', async () => {
    const w = world();
    const code = await w.seed();
    const plain = await (await w.post('/bookings/trip', TRIP)).json();
    const res = await w.post('/bookings/trip', { ...TRIP, promoCode: 'SAVE10' });
    expect(res.status).toBe(201);
    const off = Math.floor((plain.total * 1000 + 5000) / 10000);
    expect(await res.json()).toMatchObject({ total: plain.total - off, discountTotal: off, promoCodeId: code.id });
  });

  it('refuses a code on a shared seat before looking at anything else', async () => {
    const w = world();
    await w.seed();
    const res = await w.post('/bookings/shared', { promoCode: 'SAVE10' });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('promo_code_not_eligible');
  });
});

describe('POST /bookings/:id/checkout re-checks the hold (§6.3)', () => {
  async function booked(w: ReturnType<typeof world>, over: Partial<NewPromoCode> = {}) {
    const code = await w.seed(over);
    const b = await (await w.post('/bookings/single', { ...GALLE, promoCode: 'SAVE10' })).json();
    return { code, b };
  }

  it('charges the discounted amount while the hold is valid, and refreshes the hold', async () => {
    const w = world();
    const { b } = await booked(w);
    w.later(HOUR);
    const res = await w.checkout(w.app, b);
    expect(res.status).toBe(200);
    expect((await res.json()).amount).toBe(7020);
    expect((await w.bookings.get(b.id))?.promoHoldUntil).toBe(new Date(w.clock.now.getTime() + PROMO_HOLD_MS).toISOString());
  });

  it('honours a valid hold even though the code has expired since', async () => {
    const w = world();
    const { b } = await booked(w, { expiresAt: new Date(w.clock.now.getTime() + HOUR / 2) });
    w.later(HOUR);
    expect((await w.checkout(w.app, b)).status).toBe(200);
  });

  it('re-holds a lapsed hold when a use is free', async () => {
    const w = world();
    const { b } = await booked(w);
    w.later(3 * HOUR);
    expect((await w.checkout(w.app, b)).status).toBe(200);
    expect((await w.bookings.get(b.id))?.promoHoldUntil).toBe(new Date(w.clock.now.getTime() + PROMO_HOLD_MS).toISOString());
  });

  it('refuses a lapsed hold once someone else has taken the last use', async () => {
    const w = world();
    const { b: first } = await booked(w, { maxUses: 1 });
    w.later(3 * HOUR);
    expect((await w.post('/bookings/single', { ...GALLE, promoCode: 'SAVE10' })).status).toBe(201);
    const res = await w.checkout(w.app, first);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('promo_code_used_up');
  });

  it('refuses a lapsed hold on a switched-off code, and on an expired one', async () => {
    const w = world();
    const { code, b } = await booked(w);
    await w.promoCodes.update(code.id, { active: false, updatedBy: 'f@x.com' }, w.clock.now);
    w.later(3 * HOUR);
    const off = await w.checkout(w.app, b);
    expect(off.status).toBe(409);
    expect((await off.json()).error).toBe('promo_code_invalid');

    const v = world();
    const { b: late } = await booked(v, { expiresAt: new Date(v.clock.now.getTime() + HOUR) });
    v.later(3 * HOUR);
    const expired = await v.checkout(v.app, late);
    expect(expired.status).toBe(409);
    expect((await expired.json()).error).toBe('promo_code_expired');
  });

  it('still honours a held code after PROMO_CODES_ENABLED is turned off', async () => {
    const w = world();
    const { b } = await booked(w);
    const res = await w.checkout(w.make(false), b);
    expect(res.status).toBe(200);
    expect((await res.json()).amount).toBe(7020);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd api && npx vitest run src/routes/promoCodeBookings.test.ts`
Expected: FAIL — typecheck-free vitest runs, and the first test gets `total: 7800` (the code is ignored) / `createApp` ignores the new deps.

- [ ] **Step 3: Add the flag** — `api/src/config.ts`, directly after the `OPS_MANUAL_DISCOUNTS_ENABLED` block:

```ts
  // Promo codes for website bookings (spec 2026-09-14 §11). Gates ACCEPTING a new code on a booking
  // and CREATING codes. A booking already holding a code is honoured at checkout regardless, so
  // turning this off never changes a price a customer has been shown.
  PROMO_CODES_ENABLED: z
    .enum(['0', '1', 'false', 'true'])
    .default('false')
    .transform((value) => value === '1' || value === 'true'),
```

- [ ] **Step 4: Wire the app** — `api/src/app.ts`

Import: `import { InMemoryPromoCodeRepo, type PromoCodeRepo } from './db/promoCodeRepo';`

In `AppDeps`, after `opsManualDiscountsEnabled?: boolean;`:

```ts
  promoCodes?: PromoCodeRepo;
  /** Gates accepting and creating codes; a held code is honoured regardless (spec 2026-09-14 §11). */
  promoCodesEnabled?: boolean;
  /** Promo-code clock (holds, expiry). Separate from checkoutNow, which signs checkout tokens. */
  promoNow?: () => Date;
```

In `createApp`, after `const shortLinks = …;`:

```ts
  const promoCodes = deps.promoCodes ?? new InMemoryPromoCodeRepo();
  const promoCodesEnabled = deps.promoCodesEnabled ?? config.PROMO_CODES_ENABLED;
```

In the `bookingRoutes({ … })` call (the `app.route('/bookings', bookingRoutes({` block), after `checkoutNow: deps.checkoutNow,` add:

```ts
      promoCodes,
      promoCodesEnabled,
      promoNow: deps.promoNow,
```

- [ ] **Step 5: Wire production** — `api/src/server.ts`

Import: `import { PostgresPromoCodeRepo } from './db/postgresPromoCodeRepo';`
In the `createApp({ … })` call, after `shortLinks: new PostgresCustomerShortLinkRepo(db),` add:

```ts
  // Promo codes. WITHOUT this line app.ts falls back to an empty in-memory repo: every code a founder
  // creates vanishes on restart and no customer code ever resolves — the same trap quoteDiscounts hit.
  promoCodes: new PostgresPromoCodeRepo(db),
```

- [ ] **Step 6: Implement the routes** — `api/src/routes/bookings.ts`

(a) Imports, after the `../lib/bookingToken` import:

```ts
import {
  normalizePromoCode,
  promoCodeAvailability,
  promoDiscountRequest,
  PromoCodeRefusedError,
  type PromoCode,
  type PromoCodeErrorCode,
} from '../domain/promoCode';
import type { PromoCodeRepo } from '../db/promoCodeRepo';
```

(b) In `resolveTotals`, replace the `if (outcome.priced) { … }` block with:

```ts
  if (outcome.priced) {
    const differs = (cents: number) =>
      quotedTotal !== undefined && Math.abs(quotedTotal - cents) > MISMATCH_TOLERANCE_CENTS;
    // A promo-code booking matches the site's figure at EITHER total (spec 2026-09-14 §6.1): today's
    // site sends the undiscounted price; the code-aware site will send the discounted one.
    const mismatch =
      differs(outcome.totalCents) &&
      (outcome.totalBeforeDiscountCents === undefined || differs(outcome.totalBeforeDiscountCents));
    return { total: outcome.totalCents, amountDueNow: outcome.amountDueNowCents, mismatch, unpriced: false };
  }
```

(c) After the module-level `billingFrom` function add:

```ts
// Promo code (spec 2026-09-14 §6.1), read off the raw body for the same reason as billing and terms
// above: the shared domain input schemas stay untouched. Blank counts as not sent.
function promoCodeFrom(body: unknown): { sent: false } | { sent: true; code: string | null } {
  const raw = (body as { promoCode?: unknown } | null)?.promoCode;
  if (raw === undefined || raw === null || raw === '') return { sent: false };
  return { sent: true, code: normalizePromoCode(raw) };
}
```

(d) In the `bookingRoutes(deps: { … })` parameter type, after `payBaseUrl?: string;` add:

```ts
  promoCodes?: PromoCodeRepo;
  promoCodesEnabled?: boolean;
  promoNow?: () => Date;
```

(e) Inside `bookingRoutes`, after `const checkoutNow = deps.checkoutNow ?? Date.now;` add:

```ts
  const promoNow = deps.promoNow ?? (() => new Date());

  // §6.1 step 1 — a sent code resolved to a working PromoCode, or the error to answer with. Runs
  // before any Maps call, so a bad code costs nothing. The use count is taken later, under the lock.
  async function lookupPromo(
    body: unknown,
    now: Date,
  ): Promise<{ ok: true; code: PromoCode | null } | { ok: false; error: PromoCodeErrorCode }> {
    const sent = promoCodeFrom(body);
    if (!sent.sent) return { ok: true, code: null };
    if (!deps.promoCodesEnabled || !deps.promoCodes || !sent.code) return { ok: false, error: 'promo_code_invalid' };
    const code = await deps.promoCodes.getByCode(sent.code);
    if (!code) return { ok: false, error: 'promo_code_invalid' };
    const unavailable = promoCodeAvailability(code, now);
    return unavailable ? { ok: false, error: unavailable } : { ok: true, code };
  }
```

(f) In `r.post('/single', …)`, replace everything from `// The engine is the pricing truth; …` down to and including `return c.json(withCheckoutToken(booking), 201);` with:

```ts
    const now = promoNow();
    const promo = await lookupPromo(body, now);
    if (!promo.ok) return c.json({ error: promo.error }, 422);

    // The engine is the pricing truth; a client quotedTotal is never adopted — an unpriced
    // booking takes the server placeholder and is flagged for ops.
    const legMaps = memoizeDistance(maps);
    const rateCard = await bookingRateCard(parsed.data.quoteId);
    let outcome;
    try {
      outcome = await priceSingle(parsed.data, legMaps, rateCard, promo.code ? promoDiscountRequest(promo.code) : undefined);
    } catch (err) {
      if (err instanceof InvalidPricingRequestError) return c.json({ error: err.code }, 422);
      throw err;
    }
    // §4.3 — a code that cannot price, or that the limits reduce to $0, does not apply.
    const discountTotal = promo.code && outcome.priced ? (outcome.discountCents ?? 0) : 0;
    if (promo.code && discountTotal <= 0) return c.json({ error: 'promo_code_not_eligible' }, 422);
    const resolved = resolveTotals(outcome, parsed.data.quotedTotal, quoteSingleTransfer(parsed.data).total);
    // M8 — enrich with road distance/duration (best-effort; never blocks the booking).
    let distance = null;
    try {
      distance = await legMaps.distance(parsed.data.from, parsed.data.to);
    } catch {
      distance = null;
    }
    let booking: Booking;
    try {
      booking = await bookings.create(
        {
          mode: 'single',
          input: parsed.data,
          total: resolved.total,
          amountDueNow: resolved.amountDueNow,
          needsPricing: resolved.unpriced,
          currency: 'USD',
          distanceKm: distance?.km ?? null,
          durationMin: distance?.durationMin ?? null,
          billing: billing.billing, // what the card gateway is handed; absent => PayHere collects it
          termsAcceptedAt: termsAcceptedAt(body), // evidence for a refund dispute; absent = never recorded
          ...(promo.code ? { discountTotal } : {}),
        },
        { idempotencyKey: key, ...(promo.code ? { promo: { code: promo.code, now } } : {}) },
      );
    } catch (err) {
      if (err instanceof PromoCodeRefusedError) return c.json({ error: err.code }, 422);
      throw err;
    }
    await flagPricing(booking, resolved, parsed.data.quotedTotal);
    return c.json(withCheckoutToken(booking), 201);
```

(g) In `r.post('/trip', …)`, replace everything from `// Engine-first; customer bookings currently collect the full amount now.` down to and including its `return c.json(withCheckoutToken(booking), 201);` with:

```ts
    const now = promoNow();
    const promo = await lookupPromo(body, now);
    if (!promo.ok) return c.json({ error: promo.error }, 422);

    // Engine-first; customer bookings currently collect the full amount now.
    const legMaps = memoizeDistance(maps);
    const rateCard = await bookingRateCard(parsed.data.quoteId);
    let outcome;
    try {
      outcome = await priceTrip(parsed.data, legMaps, rateCard, promo.code ? promoDiscountRequest(promo.code) : undefined);
    } catch (err) {
      if (err instanceof InvalidPricingRequestError) return c.json({ error: err.code }, 422);
      throw err;
    }
    const discountTotal = promo.code && outcome.priced ? (outcome.discountCents ?? 0) : 0;
    if (promo.code && discountTotal <= 0) return c.json({ error: 'promo_code_not_eligible' }, 422);
    const resolved = resolveTotals(
      outcome,
      parsed.data.quotedTotal,
      quoteTrip(parsed.data).total,
    );
    // M8 — total road distance/duration across the trip's legs (best-effort; null if any
    // leg can't be resolved, since a partial sum would understate the trip).
    const stops = parsed.data.stops;
    let tripKm: number | null = 0;
    let tripMin: number | null = 0;
    try {
      for (let i = 0; i < stops.length - 1; i++) {
        const leg = await legMaps.distance(stops[i], stops[i + 1]);
        if (!leg) {
          tripKm = null;
          tripMin = null;
          break;
        }
        tripKm += leg.km;
        tripMin += leg.durationMin;
      }
    } catch {
      tripKm = null;
      tripMin = null;
    }
    let booking: Booking;
    try {
      booking = await bookings.create(
        {
          mode: 'trip',
          input: parsed.data,
          total: resolved.total,
          amountDueNow: resolved.amountDueNow,
          needsPricing: resolved.unpriced,
          currency: 'USD',
          distanceKm: tripKm === null ? null : Math.round(tripKm),
          durationMin: tripMin === null ? null : Math.round(tripMin),
          billing: billing.billing, // what the card gateway is handed; absent => PayHere collects it
          termsAcceptedAt: termsAcceptedAt(body), // evidence for a refund dispute; absent = never recorded
          ...(promo.code ? { discountTotal } : {}),
        },
        { idempotencyKey: key, ...(promo.code ? { promo: { code: promo.code, now } } : {}) },
      );
    } catch (err) {
      if (err instanceof PromoCodeRefusedError) return c.json({ error: err.code }, 422);
      throw err;
    }
    await flagPricing(booking, resolved, parsed.data.quotedTotal);
    return c.json(withCheckoutToken(booking), 201);
```

(h) In `r.post('/shared', …)`, directly after its first line `const body = await c.req.json().catch(() => null);` add:

```ts
    // §6.2 — shared seats are per-seat corridor prices with no vehicle minimum to protect.
    if (promoCodeFrom(body).sent) return c.json({ error: 'promo_code_not_eligible' }, 422);
```

(i) In `r.post('/:id/checkout', …)`, directly after the block

```ts
    if (payment && payment.status === 'succeeded') {
      return c.json({ error: 'already_paid', status: booking.status }, 409);
    }
```

add:

```ts
    // §6.3 — a booking made with a code re-checks its hold before a payment starts. Runs whatever
    // PROMO_CODES_ENABLED says: the flag gates accepting codes, never honouring one already held.
    if (booking.promoCodeId && deps.promoCodes) {
      const code = await deps.promoCodes.get(booking.promoCodeId);
      if (!code) return c.json({ error: 'promo_code_invalid' }, 409);
      try {
        await bookings.reholdPromo(booking.id, code, promoNow());
      } catch (err) {
        if (err instanceof PromoCodeRefusedError) return c.json({ error: err.code }, 409);
        throw err;
      }
    }
```

- [ ] **Step 7: Run to verify it passes**

Run: `cd api && npx vitest run src/routes/promoCodeBookings.test.ts src/routes/bookings.test.ts src/routes/checkout.test.ts src/routes/discountReachesBooking.test.ts`
Expected: PASS.

- [ ] **Step 8: Gate, record evidence, commit**

```bash
cd api && npm run check; echo "exit=$?"
cd .. && git add api/src/config.ts api/src/app.ts api/src/server.ts api/src/routes/bookings.ts \
  api/src/routes/promoCodeBookings.test.ts docs/superpowers/plans/2026-09-14-promo-codes-evidence.md
git commit -m "feat(promo): booking routes accept a promo code; checkout re-checks the hold"
```

---

### Task 6: Estimate previews a code

**Files:**
- Modify: `api/src/routes/quote.ts` (deps, helper, `/v2/estimate` handler)
- Modify: `api/src/app.ts` (`quoteRoutes` mount)
- Create: `api/src/routes/promoCodeEstimate.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, 4, 5 (`AppDeps.promoNow`).
- Produces: `quoteRoutes` deps gain `promoCodes?`, `bookings?`, `promoCodesEnabled?`, `promoNow?`. `/quote/v2/estimate` accepts a top-level `promoCode` and returns `promoCode: { code, discountCents, totalBeforeDiscountCents, totalCents } | { error }` alongside the unchanged undiscounted price.

- [ ] **Step 1: Write the failing test** — `api/src/routes/promoCodeEstimate.test.ts`

```ts
// The estimate previews a promo code and never holds a use (spec 2026-09-14 §6.4).
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { quoteRoutes } from './quote';
import { InMemoryQuoteRepo } from '../db/quoteRepo';
import { FakeMapsAdapter } from '../adapters/maps';
import { InMemoryBookingRepo, type NewBooking } from '../db/bookingRepo';
import { InMemoryPromoCodeRepo, type NewPromoCode } from '../db/promoCodeRepo';

const HOUR = 3_600_000;
const NOW = new Date(Math.floor(Date.now() / 1000) * 1000);
const V2_PRIVATE = {
  product: 'private', routeId: 'kandy-nanu-oya', vehicle: 'car', pax: 2, bags: 2,
  legs: [{ from: 'Kandy', to: 'Nanu Oya' }], extras: [],
};
const booking: NewBooking = {
  mode: 'single',
  input: {
    from: 'Kandy', to: 'Nanu Oya', vehicleType: 'car', adults: 2, children: 0, bags: 2,
    customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
  },
  total: 5000, amountDueNow: 5000, currency: 'USD', discountTotal: 500,
};

function world(enabled = true) {
  const promoCodes = new InMemoryPromoCodeRepo();
  const bookings = new InMemoryBookingRepo();
  const app = new Hono();
  app.route('/quote', quoteRoutes({
    quotes: new InMemoryQuoteRepo(), maps: new FakeMapsAdapter(), v2Enabled: true,
    promoCodes, bookings, promoCodesEnabled: enabled, promoNow: () => NOW,
  }));
  const seed = (over: Partial<NewPromoCode> = {}) => promoCodes.create({
    code: 'SAVE10', method: 'percentage', value: 1000, startsAt: null,
    expiresAt: new Date(NOW.getTime() + 30 * 24 * HOUR), maxUses: 5, createdBy: 'f@x.com', ...over,
  }, NOW);
  const send = (body: unknown) => app.request('/quote/v2/estimate', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { promoCodes, bookings, seed, send };
}

describe('POST /quote/v2/estimate with a promo code', () => {
  it('previews the discount next to the unchanged price', async () => {
    const w = world();
    await w.seed();
    const res = await w.send({ ...V2_PRIVATE, promoCode: 'save10' });
    expect(res.status).toBe(200);
    const body = await res.json();
    const off = Math.floor((body.totalCents * 1000 + 5000) / 10000);
    expect(body.promoCode).toEqual({
      code: 'SAVE10', discountCents: off, totalBeforeDiscountCents: body.totalCents, totalCents: body.totalCents - off,
    });
  });

  it('adds nothing when no code is sent', async () => {
    const body = await (await world().send(V2_PRIVATE)).json();
    expect('promoCode' in body).toBe(false);
  });

  it('reports a bad code without failing the price', async () => {
    const w = world();
    const unknown = await (await w.send({ ...V2_PRIVATE, promoCode: 'NOPE-NOPE' })).json();
    expect(unknown.promoCode).toEqual({ error: 'promo_code_invalid' });
    expect(unknown.totalCents).toBeGreaterThan(0);

    const off = world(false);
    await off.seed();
    expect((await (await off.send({ ...V2_PRIVATE, promoCode: 'SAVE10' })).json()).promoCode).toEqual({ error: 'promo_code_invalid' });
  });

  it('reports a code whose uses are all taken, and never holds one itself', async () => {
    const w = world();
    const code = await w.seed({ maxUses: 1 });
    await w.send({ ...V2_PRIVATE, promoCode: 'SAVE10' });
    await w.send({ ...V2_PRIVATE, promoCode: 'SAVE10' });
    expect(await w.bookings.promoUsage(code.id, NOW)).toEqual({ paid: 0, held: 0 });
    expect(await w.bookings.list()).toHaveLength(0);

    await w.bookings.create(booking, { promo: { code, now: NOW } });
    expect((await (await w.send({ ...V2_PRIVATE, promoCode: 'SAVE10' })).json()).promoCode).toEqual({ error: 'promo_code_used_up' });
  });

  it('still rejects any other unknown field on the intent', async () => {
    const w = world();
    await w.seed();
    expect((await w.send({ ...V2_PRIVATE, promoCode: 'SAVE10', foo: 1 })).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd api && npx vitest run src/routes/promoCodeEstimate.test.ts`
Expected: FAIL — the strict intent schema answers **400** for the `promoCode` field.

- [ ] **Step 3: Implement** — `api/src/routes/quote.ts`

Imports:

```ts
import type { BookingRepo } from '../db/bookingRepo';
import type { PromoCodeRepo } from '../db/promoCodeRepo';
import {
  normalizePromoCode,
  promoCodeAvailability,
  promoDiscountRequest,
  type PromoCode,
  type PromoCodeErrorCode,
} from '../domain/promoCode';
```

In `quoteRoutes(deps: { … })`, after `zones?: ZonesRepo;` add:

```ts
  promoCodes?: PromoCodeRepo;
  bookings?: BookingRepo; // read-only here: the preview counts uses, it never takes one
  promoCodesEnabled?: boolean;
  promoNow?: () => Date;
```

After `const liveCard = …;` add:

```ts
  // §6.4 — resolve a code for a PREVIEW. A plain read with no lock: it can say "used up", but a code
  // that previews fine can still be taken by someone else before the customer books.
  async function previewPromo(raw: unknown): Promise<{ code: PromoCode } | { error: PromoCodeErrorCode }> {
    const normalized = normalizePromoCode(raw);
    if (!deps.promoCodesEnabled || !deps.promoCodes || !normalized) return { error: 'promo_code_invalid' };
    const code = await deps.promoCodes.getByCode(normalized);
    if (!code) return { error: 'promo_code_invalid' };
    const now = (deps.promoNow ?? (() => new Date()))();
    const unavailable = promoCodeAvailability(code, now);
    if (unavailable) return { error: unavailable };
    if (deps.bookings) {
      const { paid, held } = await deps.bookings.promoUsage(code.id, now);
      if (paid + held >= code.maxUses) return { error: 'promo_code_used_up' };
    }
    return { code };
  }
```

Replace the whole `r.post('/v2/estimate', …)` handler with:

```ts
  r.post('/v2/estimate', async (c) => {
    if (!deps.v2Enabled) return c.notFound();
    if (!deps.maps) return c.json({ error: 'not_available' }, 501);
    const raw = await c.req.json().catch(() => null);
    // WebQuoteIntentSchema is .strict(), so a promo code is lifted off the body before the intent is
    // parsed (spec 2026-09-14 §6.4). Every other unknown field is still refused.
    let rawPromo: unknown;
    let intentBody: unknown = raw;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const { promoCode, ...rest } = raw as Record<string, unknown>;
      rawPromo = promoCode;
      intentBody = rest;
    }
    const parsed = WebQuoteIntentSchema.safeParse(intentBody);
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    const resolved = await engineRequestFor(parsed.data, deps.maps);
    if (!resolved) return c.json({ error: 'quote_unpriced' }, 422);
    try {
      const card = await liveCard();
      const result = quote(resolved.request, card);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { marginEstimateCents, ...pub } = result;
      let promoCode: Record<string, unknown> | undefined;
      if (rawPromo !== undefined && rawPromo !== null && rawPromo !== '') {
        const promo = await previewPromo(rawPromo);
        if ('error' in promo) {
          promoCode = { error: promo.error };
        } else {
          const discounted = quote(resolved.request, card, promoDiscountRequest(promo.code));
          // A booking refuses an estimated distance, so a preview on one must not promise a discount.
          promoCode = !resolved.estimated && (discounted.discountCents ?? 0) > 0
            ? {
                code: promo.code.code,
                discountCents: discounted.discountCents,
                totalBeforeDiscountCents: discounted.totalBeforeDiscountCents,
                totalCents: discounted.totalCents,
              }
            : { error: 'promo_code_not_eligible' };
        }
      }
      return c.json({
        ...pub,
        lineItems: publicLineItems(pub.lineItems),
        estimated: resolved.estimated,
        legs: resolved.legs,
        ...(promoCode ? { promoCode } : {}),
      }, 200);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'BAD_REQUEST';
      return c.json({ error: ENGINE_ERRORS.has(msg) ? msg : 'BAD_REQUEST' }, 422);
    }
  });
```

In `api/src/app.ts`, in the `app.route('/quote', quoteRoutes({ … }))` call, after `zones,` add:

```ts
    promoCodes,
    bookings,
    promoCodesEnabled,
    promoNow: deps.promoNow,
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd api && npx vitest run src/routes/promoCodeEstimate.test.ts src/routes/quote.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate, record evidence, commit**

```bash
cd api && npm run check; echo "exit=$?"
cd .. && git add api/src/routes/quote.ts api/src/app.ts api/src/routes/promoCodeEstimate.test.ts docs/superpowers/plans/2026-09-14-promo-codes-evidence.md
git commit -m "feat(promo): the website estimate previews a promo code without holding a use"
```

---

### Task 7: Founder API for managing codes

**Files:**
- Modify: `api/src/lib/opsAuth.ts` (capability)
- Create: `api/src/routes/promoCodes.ts`
- Modify: `api/src/app.ts` (rate limiter + mount)
- Create: `api/src/routes/promoCodes.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, 4, 5.
- Produces: `promoCodeRoutes(deps: { promoCodes: PromoCodeRepo; bookings: BookingRepo; auth: OpsAuthConfig; allowedOrigins?: string[]; enabled: boolean; now?: () => Date })`; capability `'promo_codes:manage'`; routes `GET|POST /admin/promo-codes`, `GET|PATCH /admin/promo-codes/:id`.

- [ ] **Step 1: Write the failing test** — `api/src/routes/promoCodes.test.ts`

```ts
// Founder API for promo codes (spec 2026-09-14 §6.5).
import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { signSession } from '../lib/opsAuth';
import { InMemoryBookingRepo, type NewBooking } from '../db/bookingRepo';
import { InMemoryPromoCodeRepo } from '../db/promoCodeRepo';

const AUTH = { opsUsers: 'f@x.com:founder,fin@x.com:finance,op@x.com:ops', googleClientId: 'cid', opsSessionSecret: 'sek' };
const cookie = (email: string) => `ch_ops=${signSession({ email, exp: Date.now() + 60_000 }, AUTH.opsSessionSecret)}`;
const FOUNDER = cookie('f@x.com');
const HOUR = 3_600_000;
const EXPIRES = new Date(Date.now() + 30 * 24 * HOUR).toISOString();
const NEW = { code: 'summer10', method: 'percentage', value: 1000, expiresAt: EXPIRES, maxUses: 5 };

const booking: NewBooking = {
  mode: 'single',
  input: {
    from: 'Kandy', to: 'Ella', vehicleType: 'car', adults: 2, children: 0, bags: 2,
    customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
  },
  total: 9000, amountDueNow: 9000, currency: 'USD', discountTotal: 1000,
};

function world(enabled = true) {
  const promoCodes = new InMemoryPromoCodeRepo();
  const bookings = new InMemoryBookingRepo();
  const app = createApp({ auth: AUTH, adminApiKey: 'k', bookingLinkSecret: 'test-link-secret', promoCodes, bookings, promoCodesEnabled: enabled });
  const call = (method: string, path: string, body?: unknown, jar = FOUNDER, headers: Record<string, string> = {}) =>
    app.request(`/admin/promo-codes${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(jar ? { cookie: jar } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { promoCodes, bookings, call };
}

describe('/admin/promo-codes', () => {
  it('lets a founder create a code, normalised and attributed', async () => {
    const w = world();
    const res = await w.call('POST', '', NEW);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      code: 'SUMMER10', method: 'percentage', value: 1000, maxUses: 5, active: true,
      createdBy: 'f@x.com', expiresAt: EXPIRES, uses: { paid: 0, held: 0, remaining: 5 }, worksNow: true,
    });
  });

  it('refuses a duplicate code and a code over 30%', async () => {
    const w = world();
    await w.call('POST', '', NEW);
    const dup = await w.call('POST', '', { ...NEW, code: 'SUMMER10' });
    expect(dup.status).toBe(409);
    expect((await dup.json()).error).toBe('code_taken');
    expect((await w.call('POST', '', { ...NEW, code: 'BIG', value: 3500 })).status).toBe(400);
  });

  it('is founder-only', async () => {
    const w = world();
    expect((await w.call('GET', '', undefined, cookie('op@x.com'))).status).toBe(403);
    expect((await w.call('POST', '', NEW, cookie('fin@x.com'))).status).toBe(403);
    expect((await w.call('GET', '', undefined, '')).status).toBe(401);
  });

  it('refuses a cross-site write', async () => {
    const w = world();
    const res = await w.call('POST', '', NEW, FOUNDER, { 'sec-fetch-site': 'cross-site' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('bad_origin');
  });

  it('lists codes with their uses, and shows the bookings behind one code', async () => {
    const w = world();
    const created = await (await w.call('POST', '', NEW)).json();
    const code = await w.promoCodes.get(created.id);
    const held = await w.bookings.create(booking, { promo: { code: code!, now: new Date() } });

    const list = await (await w.call('GET', '')).json();
    expect(list.codes).toHaveLength(1);
    expect(list.codes[0].uses).toEqual({ paid: 0, held: 1, remaining: 4 });

    const detail = await (await w.call('GET', `/${created.id}`)).json();
    expect(detail.bookings).toEqual([
      expect.objectContaining({ bookingId: held.id, reference: held.reference, use: 'held', discountCents: 1000 }),
    ]);
  });

  it('changes expiry, max uses and on/off only', async () => {
    const w = world();
    const created = await (await w.call('POST', '', { ...NEW, startsAt: new Date(Date.now() + HOUR).toISOString() })).json();
    const patched = await w.call('PATCH', `/${created.id}`, { maxUses: 9, active: false });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ maxUses: 9, active: false, updatedBy: 'f@x.com', worksNow: false });
    expect((await w.call('PATCH', `/${created.id}`, { value: 500 })).status).toBe(400);
    // An expiry at or before the code's start is refused.
    expect((await w.call('PATCH', `/${created.id}`, { expiresAt: new Date(Date.now()).toISOString() })).status).toBe(400);
  });

  it('answers 404 for an unknown or malformed id', async () => {
    const w = world();
    expect((await w.call('GET', '/00000000-0000-0000-0000-000000000000')).status).toBe(404);
    expect((await w.call('GET', '/not-a-uuid')).status).toBe(404);
    expect((await w.call('PATCH', '/not-a-uuid', { active: false })).status).toBe(404);
  });

  it('with the flag off: creating is refused, switching a code off still works', async () => {
    const on = world();
    const created = await (await on.call('POST', '', NEW)).json();
    const offApp = createApp({ auth: AUTH, adminApiKey: 'k', bookingLinkSecret: 'test-link-secret', promoCodes: on.promoCodes, bookings: on.bookings, promoCodesEnabled: false });
    const req = (method: string, path: string, body: unknown) => offApp.request(`/admin/promo-codes${path}`, {
      method, headers: { 'content-type': 'application/json', cookie: FOUNDER }, body: JSON.stringify(body),
    });
    const create = await req('POST', '', { ...NEW, code: 'ANOTHER' });
    expect(create.status).toBe(403);
    expect((await create.json()).error).toBe('promo_codes_disabled');
    expect((await req('PATCH', `/${created.id}`, { active: false })).status).toBe(200);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd api && npx vitest run src/routes/promoCodes.test.ts`
Expected: FAIL — the first request answers **404** (no route mounted).

- [ ] **Step 3: Add the capability** — `api/src/lib/opsAuth.ts`

Extend the union's last line to `| 'discount:apply_manual' | 'promo_codes:manage';`, add to the comment block above `CAPABILITIES`:

```ts
// promo_codes:manage — creating and changing customer promo codes (spec 2026-09-14 §6.5). Founder
// only: a code gives money away to anyone who types it, the same class as discount:apply_manual.
```

and add `'promo_codes:manage'` to the end of the `founder` set.

(`ops.roles.test.ts` and `opsUi.test.ts` derive their expectations from the matrix, so they stay green.)

- [ ] **Step 4: Write the routes** — `api/src/routes/promoCodes.ts`

```ts
// Founder API for promo codes (spec docs/superpowers/specs/2026-09-14-promo-codes-design.md §6.5).
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { opsIdentity, requireCap, type OpsAuthConfig } from '../lib/opsMiddleware';
import type { BookingRepo } from '../db/bookingRepo';
import { PromoCodeTakenError, type PromoCodeRepo } from '../db/promoCodeRepo';
import {
  CreatePromoCodeSchema,
  PatchPromoCodeSchema,
  promoCodeAvailability,
  type PromoCode,
} from '../domain/promoCode';

const isUuid = (s: string) => z.string().uuid().safeParse(s).success;

function serialize(code: PromoCode) {
  return {
    id: code.id,
    code: code.code,
    method: code.method,
    value: code.value,
    startsAt: code.startsAt ? code.startsAt.toISOString() : null,
    expiresAt: code.expiresAt.toISOString(),
    maxUses: code.maxUses,
    active: code.active,
    createdBy: code.createdBy,
    createdAt: code.createdAt.toISOString(),
    updatedBy: code.updatedBy,
    updatedAt: code.updatedAt ? code.updatedAt.toISOString() : null,
  };
}

export function promoCodeRoutes(deps: {
  promoCodes: PromoCodeRepo;
  bookings: BookingRepo;
  auth: OpsAuthConfig;
  allowedOrigins?: string[];
  /** PROMO_CODES_ENABLED — gates CREATING only; listing and switching codes off always work. */
  enabled: boolean;
  now?: () => Date;
}) {
  const r = new Hono();
  const now = deps.now ?? (() => new Date());

  // Same CSRF rule as /admin/quote (internalQuote.ts): the ch_ops cookie is ambient browser state.
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

  r.use('*', opsIdentity(deps.auth));
  r.use('*', requireCap('promo_codes:manage'));

  async function withUsage(code: PromoCode, at: Date) {
    const { paid, held } = await deps.bookings.promoUsage(code.id, at);
    return {
      ...serialize(code),
      uses: { paid, held, remaining: Math.max(0, code.maxUses - paid - held) },
      worksNow: promoCodeAvailability(code, at) === null,
    };
  }

  r.get('/', async (c) => {
    const at = now();
    const codes = await deps.promoCodes.list();
    return c.json({ codes: await Promise.all(codes.map((code) => withUsage(code, at))) });
  });

  r.post('/', csrf, async (c) => {
    if (!deps.enabled) return c.json({ error: 'promo_codes_disabled' }, 403);
    const parsed = CreatePromoCodeSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    const at = now();
    try {
      const created = await deps.promoCodes.create(
        { ...parsed.data, startsAt: parsed.data.startsAt ?? null, createdBy: c.get('identity').email },
        at,
      );
      return c.json(await withUsage(created, at), 201);
    } catch (err) {
      if (err instanceof PromoCodeTakenError) return c.json({ error: 'code_taken' }, 409);
      throw err;
    }
  });

  r.get('/:id', async (c) => {
    const id = c.req.param('id');
    const code = isUuid(id) ? await deps.promoCodes.get(id) : null;
    if (!code) return c.json({ error: 'not_found' }, 404);
    const at = now();
    return c.json({ ...(await withUsage(code, at)), bookings: await deps.bookings.promoBookings(code.id, at) });
  });

  r.patch('/:id', csrf, async (c) => {
    const id = c.req.param('id');
    const existing = isUuid(id) ? await deps.promoCodes.get(id) : null;
    if (!existing) return c.json({ error: 'not_found' }, 404);
    const parsed = PatchPromoCodeSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    if (
      parsed.data.expiresAt &&
      existing.startsAt &&
      existing.startsAt.getTime() >= parsed.data.expiresAt.getTime()
    ) {
      return c.json({ error: 'invalid_request', details: { fieldErrors: { expiresAt: ['expiry must be after the start'] } } }, 400);
    }
    const at = now();
    const updated = await deps.promoCodes.update(id, { ...parsed.data, updatedBy: c.get('identity').email }, at);
    if (!updated) return c.json({ error: 'not_found' }, 404);
    return c.json(await withUsage(updated, at), 200);
  });

  return r;
}
```

- [ ] **Step 5: Mount it** — `api/src/app.ts`

Import: `import { promoCodeRoutes } from './routes/promoCodes';`

After the `/admin/quote/*` limiter lines (`app.use('/admin/quote/*', …)`) add:

```ts
  // Founder promo-code API (spec 2026-09-14 §6.5). Session-gated, but still throttled like the other
  // admin surfaces. Hono's '/admin/promo-codes/*' also matches the bare parent path.
  app.use('/admin/promo-codes/*', rateLimit({ ...rl, methods: ['POST', 'GET', 'PATCH'] }));
```

Directly **before** `app.route('/admin/quote', internalQuoteRoutes({` add (mounted before the catch-all `/admin` routes so their middleware never runs first):

```ts
  app.route('/admin/promo-codes', promoCodeRoutes({
    promoCodes,
    bookings,
    auth: opsAuthCfg,
    allowedOrigins,
    enabled: promoCodesEnabled,
    now: deps.promoNow,
  }));
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd api && npx vitest run src/routes/promoCodes.test.ts src/routes/ops.roles.test.ts src/routes/opsUi.test.ts`
Expected: PASS.

- [ ] **Step 7: Gate, record evidence, commit**

```bash
cd api && npm run check; echo "exit=$?"
cd .. && git add api/src/lib/opsAuth.ts api/src/routes/promoCodes.ts api/src/app.ts api/src/routes/promoCodes.test.ts docs/superpowers/plans/2026-09-14-promo-codes-evidence.md
git commit -m "feat(promo): founder-only API to create, list and change promo codes"
```

---

### Task 8: Full verification and the draft PR

**Files:** none new (evidence file only).

- [ ] **Step 1: Full gate**

```bash
cd api && npm run check; echo "api check exit=$?"
```
Expected: exit 0.

- [ ] **Step 2: Postgres suites, if a database is available**

If `DATABASE_URL_TEST` is set (or a local Postgres can be started), run:
```bash
cd api && npx vitest run src/db/postgres.test.ts src/db/rlsEnabled.test.ts; echo "exit=$?"
```
Record the result — or record plainly that no Postgres was available and CI must prove these.

- [ ] **Step 3: Web tests**

```bash
cd web-tests && npm ci && npx playwright install chromium && npm run test:all; echo "exit=$?"
```
No front-end file changed, so this must be green. If Playwright browsers cannot be installed in this environment, record that verbatim; do not claim it passed.

- [ ] **Step 4: Push and verify the push really landed**

```bash
git log --oneline origin/main..HEAD
git push -u origin feat/promo-codes-backend
test "$(git ls-remote origin refs/heads/feat/promo-codes-backend | cut -f1)" = "$(git rev-parse HEAD)" && echo "remote matches HEAD"
```

- [ ] **Step 5: Open a DRAFT PR to `main`** (never merge)

Write the body to a temp file, then `gh pr create --draft --base main --head feat/promo-codes-backend --title "feat(promo): promo codes for website bookings — backend" --body-file <file>`. If `gh` is unavailable, print the compare URL instead.

Body must contain, in this order:
1. **What:** one paragraph from the spec §1–§2.
2. **Owner sign-offs this PR carries (spec §12):** migration `0050_promo_codes` (merging applies it to **staging** on boot; prod only on promote), new setting `PROMO_CODES_ENABLED` (default off — nothing changes until it is turned on), capability `promo_codes:manage`, the `DiscountRequest.source` type change and additive `BookingRepo`/`PriceOutcome` changes.
3. **Not in this PR:** website field, ops screen, email wording (spec §10).
4. **Evidence:** link to `docs/superpowers/plans/2026-09-14-promo-codes-evidence.md`, and whether the Postgres suites and web tests ran here or rely on CI.
5. **Rollout (spec §11)**, and: "Do not merge until the owner has reviewed."
6. End with: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`

- [ ] **Step 6: Watch CI once**

`gh pr checks --watch` (or poll `gh pr checks` every few minutes, up to 30 minutes). If a check fails: read its log, fix the cause, commit, push, and watch again. If it fails a **second** time, stop: add a PR comment explaining what fails and what was tried, and end the session. Never merge, never re-run with a bypass.

