# Deposits — ops first — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ops can sell an eligible quote for a card deposit, the trip runs as secured, and ops collects the balance on day one with a card link it sends by hand.

**Architecture:** No new booking status. Payment state is derived from the `payments` ledger (`paid so far` = Σ succeeded payments; balance = total − paid), with a new `payments.purpose` (`full | deposit | balance`). The deposit is the booking's `amount_due_now`, frozen at creation; the balance is a second ordinary PayHere checkout with its own order id (`REF-B`). Every guard that today assumes one payment per booking learns that a `deposit` + `balance` pair is one sale.

**Tech Stack:** Node 20 · TypeScript strict · Hono · Zod · Vitest · Drizzle + Postgres · plain-JS front-end pages · Playwright (`web-tests/`).

**Spec:** `docs/superpowers/specs/2026-10-07-deposits-ops-first-design.md` (read it first).
**Code verified against:** `origin/main` @ `06caf849`. Line numbers below are from that commit — re-find by the quoted text if they have moved.

## Global Constraints

- Money is integer USD cents end-to-end. Never floats in storage.
- Deposit rule (fixed, not editable): `max(round(total × 10 / 100), 5000)`, capped at `total`; only when `product` is `private` or `chauffeur` **and** `total ≥ 15000`; otherwise no deposit (0). Shared rides: never.
- Order ids: first payment `REF` (unchanged); balance `REF-B`. Balance idempotency key: `checkout:${bookingId}:balance`.
- Balance checkout is allowed only when booking status ∈ {`paid`, `confirmed`, `in_progress`}, a succeeded `deposit` payment exists, and balance > 0. The client never sends an amount.
- No automated reminders, no tokenized charging, no cash deposits/balances, no website checkout change in this plan.
- Migration: next free number at build time (**0066** if PR #930 `0065_experiences` has merged; it is open as of 2026-10-07). Its journal `when` must be greater than every existing entry. Merging it to `main` applies it to staging; prod only via the `main → production` promote, with the owner's explicit OK.
- Pricing files (`rateCard.ts`) and `@generated` blocks: owner OK before PR 2 is opened; regenerate with `npm run generate`, never hand-edit generated output.
- Each PR: `cd api && npm run check` green **and** `npm --prefix <abs path>/web-tests run test:all` green before commit. Stage files by path only. Work in a worktree off `origin/main`, never the shared tree.
- Logic bugs: failing test first, run it red, then fix. Paste red→green in the PR.
- Customer copy is plain and short; the balance is "due on day one of your trip".

## File map

| File | Responsibility | PR |
|---|---|---|
| `api/drizzle/00NN_deposit_payments.sql` (+ journal, schema.ts) | `payments.purpose`, `quotes.pay_link_deposit_cents`, comms kind | 1 |
| `api/src/db/paymentRepo.ts`, `postgresPaymentRepo.ts`, `postgresPaymentSettlementRepo.ts` | carry `purpose` | 1 |
| `api/src/domain/balance.ts` (new) | `paidCents`, `balanceDueCents`, `isBalanceOpen` — the only balance maths | 1 |
| `api/src/routes/bookings.ts` (`projectBooking`, `/view`) | customer projection uses the ledger | 1 |
| `api/src/quote/rateCard.ts`, `extrasDeposit.ts`, `engine.ts`, `pricingPayload.ts`, `tools/generate-pricing.mjs`, `opsRates.ts` | deposit rule | 2 |
| `api/src/db/paymentSettlementRepo.ts`, `postgresPaymentSettlementRepo.ts` | `balance_settled` outcome | 3 |
| `api/src/routes/webhooks.ts`, `services/notifications.ts` (+ kind lists) | balance webhook path, receipt email | 3 |
| `api/src/domain/paymentCase.ts`, `services/bookingTracking.ts`, `services/watchdog.ts` | stop treating the pair as an incident | 3 |
| `api/src/db/refundRepo.ts`, `postgresRefundRepo.ts`, `routes/admin.ts` | refund per payment | 3 |
| `api/src/db/quoteRepo.ts`, `postgresQuoteRepo.ts`, `routes/internalQuote.ts` | deposit pay link | 4 |
| `api/src/routes/quotePay.ts`, `pay.html` | deposit sale on the pay page | 4 |
| `api/src/routes/bookings.ts` (checkout, checkout-token, pay-return), `manage.html` | balance payment | 5 |
| `api/src/services/opsView.ts`, `routes/ops.ts`, `routes/ops-ui.html` | ops sees and sends the balance | 4–5 |

---

# PR 1 — Ledger groundwork (no visible change; carries the migration)

Branch: `feat/deposits-ledger`. Title: `feat(payments): payment purpose + derived balance (migration 00NN)`.

### Task 1: Migration — payment purpose, quote deposit freeze, balance receipt kind

**Files:**
- Create: `api/drizzle/00NN_deposit_payments.sql`
- Modify: `api/drizzle/meta/_journal.json` (append entry)
- Modify: `api/src/db/schema.ts` (payments table ~`:127-177`; quotes table near `soldCents` `:751`; `customer_communications_kind_valid` `:633`)
- Test: `api/src/db/depositPaymentsMigration.test.ts` (new)

**Interfaces:**
- Produces: column `payments.purpose` (`'full'|'deposit'|'balance'`, not null, default `'full'`); column `quotes.pay_link_deposit_cents` (int, null, > 0); comms kind `'balance_received'`. Drizzle fields `payments.purpose`, `quotes.payLinkDepositCents`.

- [ ] **Step 1: Write the failing migration test** (pattern copied from `paymentsBookingIdIndexMigration.test.ts`)

```ts
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client';

// Deposits (spec 2026-10-07 §4): one booking can now hold a deposit and a balance payment.
const TAG = '00NN_deposit_payments'; // replace NN with the real number
const migration = readFileSync(new URL(`../../drizzle/${TAG}.sql`, import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};
const sql = migration.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

describe(TAG, () => {
  it('adds payments.purpose, defaulting existing rows to full', () => {
    expect(sql).toMatch(/alter table "payments" add column if not exists "purpose" text default 'full' not null/i);
    expect(sql).toMatch(/"payments_purpose_valid" check \("purpose" in \('full', 'deposit', 'balance'\)\)/i);
  });
  it('adds the frozen deposit amount on quotes', () => {
    expect(sql).toMatch(/alter table "quotes" add column if not exists "pay_link_deposit_cents" integer/i);
    expect(sql).toMatch(/"quotes_pay_link_deposit_cents_positive" check \("pay_link_deposit_cents" is null or "pay_link_deposit_cents" > 0\)/i);
  });
  it('allows the balance receipt kind', () => {
    expect(sql).toMatch(/'deposit_received', 'balance_received'\)/);
  });
  it('changes no rows', () => {
    expect(sql).not.toMatch(/\b(insert\s+into|delete\s+from|drop\s+table)\b/i);
    expect(sql).not.toMatch(/\bupdate\s+\w+\s+set\b/i);
  });
  it('is journalled last, with the latest when', () => {
    const position = journal.entries.findIndex((e) => e.tag === TAG);
    expect(position).toBe(journal.entries.length - 1);
    expect(journal.entries[position]!.when).toBeGreaterThan(Math.max(...journal.entries.slice(0, position).map((e) => e.when)));
  });
});

const TEST_URL = process.env.DATABASE_URL_TEST;
describe.skipIf(!TEST_URL)(`${TAG} on a migrated database`, () => {
  let db: ReturnType<typeof createDb>['sql'];
  beforeAll(async () => {
    const conn = createDb(TEST_URL as string);
    db = conn.sql;
    await migrate(conn.db, { migrationsFolder: 'drizzle' });
  });
  it('payments.purpose is not null with default full', async () => {
    const rows = await db<{ is_nullable: string; column_default: string }[]>`
      SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'payments' AND column_name = 'purpose'`;
    expect(rows[0]).toMatchObject({ is_nullable: 'NO' });
    expect(rows[0]!.column_default).toMatch(/'full'/);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL (file not found)**

Run: `cd api && npx vitest run src/db/depositPaymentsMigration.test.ts`
Expected: FAIL, `ENOENT … 00NN_deposit_payments.sql`.

- [ ] **Step 3: Write the migration**

`api/drizzle/00NN_deposit_payments.sql`:

```sql
-- Deposits, ops first (spec docs/superpowers/specs/2026-10-07-deposits-ops-first-design.md §4).
-- A booking can now hold two payments: a deposit and, later, its balance. `purpose` says which.
-- Every existing row is a full payment, which the constant default records without rewriting the
-- table (Postgres >= 11 stores a constant default in the catalogue).
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "purpose" text DEFAULT 'full' NOT NULL;
ALTER TABLE "payments" ADD CONSTRAINT "payments_purpose_valid" CHECK ("purpose" in ('full', 'deposit', 'balance'));

-- The deposit a deposit pay link charges, frozen at mint like sold_cents freezes a partial link.
ALTER TABLE "quotes" ADD COLUMN IF NOT EXISTS "pay_link_deposit_cents" integer;
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_pay_link_deposit_cents_positive" CHECK ("pay_link_deposit_cents" is null or "pay_link_deposit_cents" > 0);

-- The "you're fully paid" receipt (spec §6).
ALTER TABLE "customer_communications" DROP CONSTRAINT IF EXISTS "customer_communications_kind_valid";
ALTER TABLE "customer_communications" ADD CONSTRAINT "customer_communications_kind_valid" CHECK ("kind" in ('confirmation', 'details_needed', 'booking_confirmed', 'cancellation', 'refund', 'no_show_notice', 'trip_reminder', 'review_request', 'payment_recovery', 'payment_failed', 'deposit_received', 'balance_received'));
```

Append to `_journal.json` `entries` (use the next idx, and `when` = last entry's `when` + 86400000):

```json
    {
      "idx": NN,
      "version": "7",
      "when": <last when + 86400000>,
      "tag": "00NN_deposit_payments",
      "breakpoints": true
    }
```

In `schema.ts`, payments columns (after `lastAttemptAt`):

```ts
    // 00NN — deposits (spec 2026-10-07): which part of the sale this payment is.
    purpose: text('purpose').default('full').notNull(),
```

payments constraints (after `payments_status_valid`):

```ts
    check('payments_purpose_valid', sql`${t.purpose} in ('full', 'deposit', 'balance')`),
```

quotes columns (after `soldCents: integer('sold_cents'),`):

```ts
  // 00NN — the deposit a deposit pay link charges, frozen at mint (null = not a deposit link).
  payLinkDepositCents: integer('pay_link_deposit_cents'),
```

…and its check in the quotes constraints block: `check('quotes_pay_link_deposit_cents_positive', sql\`${t.payLinkDepositCents} is null or ${t.payLinkDepositCents} > 0\`)`. (If the quotes table has no constraints callback yet, add it the way `payments` does.)

`customer_communications_kind_valid` (`schema.ts:633`): append `, 'balance_received'` inside the list.

- [ ] **Step 4: Run — expect PASS**

Run: `cd api && npx vitest run src/db/depositPaymentsMigration.test.ts`
Expected: PASS (the DB block skips without `DATABASE_URL_TEST`; set it to a local test DB to run it — never `api/.env`'s `DATABASE_URL`, which is prod).

- [ ] **Step 5: Commit**

```bash
git add api/drizzle/00NN_deposit_payments.sql api/drizzle/meta/_journal.json api/src/db/schema.ts api/src/db/depositPaymentsMigration.test.ts
git commit -m "feat(db): payment purpose, frozen quote deposit, balance receipt kind (migration 00NN)"
```

### Task 2: Carry `purpose` through the payment repos

**Files:**
- Modify: `api/src/db/paymentRepo.ts` (`NewPayment`, `Payment`, `InMemoryPaymentRepo.create`)
- Modify: `api/src/db/postgresPaymentRepo.ts` (`toPayment` `:7-18`, `create` `:23-31`)
- Modify: `api/src/db/postgresPaymentSettlementRepo.ts` (`toPayment` `:19-31`)
- Test: `api/src/db/paymentRepo.test.ts`

**Interfaces:**
- Produces: `export type PaymentPurpose = 'full' | 'deposit' | 'balance'`; `NewPayment.purpose?: PaymentPurpose` (omitted = `'full'`); `Payment.purpose: PaymentPurpose`.

- [ ] **Step 1: Failing test** (append to `paymentRepo.test.ts`)

```ts
describe('payment purpose', () => {
  it('defaults to full and keeps an explicit purpose', async () => {
    const repo = new InMemoryPaymentRepo();
    const base = { bookingId: 'b1', provider: 'payhere', amount: 5000, currency: 'USD' };
    const full = await repo.create({ ...base, orderId: 'CH-A', idempotencyKey: 'k1' });
    const bal = await repo.create({ ...base, orderId: 'CH-A-B', idempotencyKey: 'k2', purpose: 'balance' });
    expect(full.purpose).toBe('full');
    expect(bal.purpose).toBe('balance');
    expect((await repo.findByBookingId('b1')).map((p) => p.purpose).sort()).toEqual(['balance', 'full']);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`purpose` undefined / type error)

Run: `cd api && npx vitest run src/db/paymentRepo.test.ts -t "payment purpose"`

- [ ] **Step 3: Implement**

`paymentRepo.ts`:

```ts
export type PaymentStatus = 'pending' | 'succeeded' | 'failed';
// Deposits (spec 2026-10-07): which part of the sale a payment is. 'full' for every booking that
// pays once — every row before the deposit feature.
export type PaymentPurpose = 'full' | 'deposit' | 'balance';

export interface NewPayment {
  bookingId: string;
  provider: string;
  orderId: string;
  amount: number;
  currency: string;
  idempotencyKey: string;
  purpose?: PaymentPurpose; // omitted = 'full'
}

export interface Payment extends Omit<NewPayment, 'purpose'> {
  id: string;
  status: PaymentStatus;
  purpose: PaymentPurpose;
  attemptCount: number;
  lastAttemptAt: Date | null;
}
```

`InMemoryPaymentRepo.create`: add `purpose: p.purpose ?? 'full',` to the record literal.

`postgresPaymentRepo.ts`: `toPayment` gets `purpose: r.purpose as PaymentPurpose,` (import the type); `create` inserts `.values({ ...p, purpose: p.purpose ?? 'full', status: 'pending' })`.

`postgresPaymentSettlementRepo.ts` `toPayment`: add `purpose: row.purpose as PaymentPurpose,`.

- [ ] **Step 4: Typecheck and fix literal `Payment` objects**

Run: `cd api && npm run typecheck`
Every compile error of the form "Property 'purpose' is missing" is a hand-built `Payment` (fixtures/tests/fakes). Add `purpose: 'full'` to each. Do not change behaviour anywhere.

- [ ] **Step 5: Run — expect PASS**, then `cd api && npm test`.

- [ ] **Step 6: Commit**

```bash
git add api/src/db/paymentRepo.ts api/src/db/postgresPaymentRepo.ts api/src/db/postgresPaymentSettlementRepo.ts api/src/db/paymentRepo.test.ts <each fixture file the typecheck named>
git commit -m "feat(payments): carry payment purpose through the repos"
```

### Task 3: `domain/balance.ts` — the only balance maths

**Files:**
- Create: `api/src/domain/balance.ts`
- Test: `api/src/domain/balance.test.ts`

**Interfaces:**
- Consumes: `Payment` (`status`, `amount`, `purpose`), `Booking` (`status`, `total`, `amountDueNow`).
- Produces:
  - `paidCents(payments: PaymentLike[]): number`
  - `balanceDueCents(booking: BookingLike, payments: PaymentLike[]): number`
  - `isBalanceOpen(booking: BookingLike, payments: PaymentLike[]): boolean`
  - `SECURED_STATUSES: ReadonlySet<string>` = `paid | confirmed | in_progress`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { balanceDueCents, isBalanceOpen, paidCents } from './balance';

const ok = (amount: number, purpose: 'full' | 'deposit' | 'balance' = 'full') => ({ status: 'succeeded' as const, amount, purpose });
const pending = (amount: number, purpose: 'full' | 'deposit' | 'balance' = 'balance') => ({ status: 'pending' as const, amount, purpose });
const booking = (status: string, total: number, amountDueNow: number | null = total) => ({ status, total, amountDueNow });

describe('paidCents', () => {
  it('sums succeeded payments only', () => {
    expect(paidCents([ok(5000, 'deposit'), pending(15000), ok(15000, 'balance')])).toBe(20000);
  });
});

describe('balanceDueCents', () => {
  it('a full-paid booking owes nothing', () => {
    expect(balanceDueCents(booking('paid', 20000), [ok(20000)])).toBe(0);
  });
  it('a deposit booking owes total minus what was paid, through confirmed and in_progress', () => {
    for (const s of ['paid', 'confirmed', 'in_progress']) {
      expect(balanceDueCents(booking(s, 20000, 5000), [ok(5000, 'deposit')])).toBe(15000);
    }
  });
  it('drops to zero once the balance lands', () => {
    expect(balanceDueCents(booking('confirmed', 20000, 5000), [ok(5000, 'deposit'), ok(15000, 'balance')])).toBe(0);
  });
  it('before any payment it is the planned split (today’s meaning)', () => {
    expect(balanceDueCents(booking('payment_pending', 20000, 5000), [])).toBe(15000);
    expect(balanceDueCents(booking('draft', 20000), [])).toBe(0);
  });
  it('a secured booking with no recorded payment falls back to the planned split, never the whole total', () => {
    expect(balanceDueCents(booking('paid', 20000), [])).toBe(0);
  });
  it('closed bookings owe nothing', () => {
    for (const s of ['cancelled', 'refunded', 'no_show', 'completed']) {
      expect(balanceDueCents(booking(s, 20000, 5000), [ok(5000, 'deposit')])).toBe(0);
    }
  });
});

describe('isBalanceOpen', () => {
  it('only for a secured booking with a settled deposit and money left to pay', () => {
    expect(isBalanceOpen(booking('confirmed', 20000, 5000), [ok(5000, 'deposit')])).toBe(true);
    expect(isBalanceOpen(booking('confirmed', 20000, 5000), [ok(5000, 'deposit'), ok(15000, 'balance')])).toBe(false);
    expect(isBalanceOpen(booking('payment_pending', 20000, 5000), [])).toBe(false);
    expect(isBalanceOpen(booking('paid', 20000), [ok(20000)])).toBe(false);
    expect(isBalanceOpen(booking('cancelled', 20000, 5000), [ok(5000, 'deposit')])).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module not found)

Run: `cd api && npx vitest run src/domain/balance.test.ts`

- [ ] **Step 3: Implement**

```ts
// Deposits (spec docs/superpowers/specs/2026-10-07-deposits-ops-first-design.md §4). The ONE place
// "how much is still owed" is worked out. Nothing stores a balance: it is the booking total minus
// the succeeded payments, so a balance can never disagree with the money actually held.

type PaymentLike = { status: string; amount: number; purpose: string };
type BookingLike = { status: string; total: number; amountDueNow: number | null };

// A trip that is going ahead. A deposit moves a booking to `paid` exactly like a full payment, and
// the balance can land after ops has confirmed the driver or the trip has started.
export const SECURED_STATUSES: ReadonlySet<string> = new Set(['paid', 'confirmed', 'in_progress']);
const CLOSED_STATUSES: ReadonlySet<string> = new Set(['cancelled', 'refunded', 'no_show', 'completed']);

export function paidCents(payments: PaymentLike[]): number {
  return payments.filter((p) => p.status === 'succeeded').reduce((sum, p) => sum + p.amount, 0);
}

export function balanceDueCents(booking: BookingLike, payments: PaymentLike[]): number {
  if (CLOSED_STATUSES.has(booking.status)) return 0;
  const paid = paidCents(payments);
  // From the ledger once money is in. A secured booking with NO recorded payment (a legacy or
  // repaired row) falls through to the planned split rather than claiming the whole total is owed.
  if (SECURED_STATUSES.has(booking.status) && paid > 0) return Math.max(0, booking.total - paid);
  return Math.max(0, booking.total - (booking.amountDueNow ?? booking.total));
}

export function isBalanceOpen(booking: BookingLike, payments: PaymentLike[]): boolean {
  return (
    SECURED_STATUSES.has(booking.status) &&
    payments.some((p) => p.purpose === 'deposit' && p.status === 'succeeded') &&
    balanceDueCents(booking, payments) > 0
  );
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add api/src/domain/balance.ts api/src/domain/balance.test.ts
git commit -m "feat(payments): derive paid-so-far and balance from the ledger"
```

### Task 4: Customer projection reads the ledger

**Files:**
- Modify: `api/src/routes/bookings.ts` — `CustomerBookingView` (`:175-177`), `projectBooking` (`:188-200`), `GET /view` (`:917-923`)
- Test: `api/src/routes/bookings.view.balance.test.ts` (new; copy the app/booking setup from an existing `GET /bookings/view` test — `grep -ln "bookings/view?t=" api/src/routes/*.test.ts`)

**Interfaces:**
- Consumes: `balanceDueCents`, `isBalanceOpen`, `paidCents` (Task 3).
- Produces: `projectBooking(b: Booking, payments: Payment[] = []): CustomerBookingView`; view gains `paidCents: number` and `balancePayable: boolean`. `balanceDueCents` keeps its name.

- [ ] **Step 1: Failing test** — a deposit booking (total 20000, amountDueNow 5000) moved to `paid` with one succeeded `deposit` payment of 5000:

```ts
it('shows the balance from the ledger and offers it', async () => {
  const res = await app.request(`/bookings/view?t=${token}`);
  const v = await res.json();
  expect(v).toMatchObject({ totalCents: 20000, amountDueNowCents: 5000, paidCents: 5000, balanceDueCents: 15000, balancePayable: true });
});
it('a fully paid deposit booking owes nothing', async () => {
  // …add a succeeded 'balance' payment of 15000 to the same booking first
  const v = await (await app.request(`/bookings/view?t=${token}`)).json();
  expect(v).toMatchObject({ paidCents: 20000, balanceDueCents: 0, balancePayable: false });
});
```

Create payments with `payments.create({ …, purpose: 'deposit' })` then `payments.markSucceeded(id)`.

- [ ] **Step 2: Run — expect FAIL** (`paidCents` undefined; balance 15000 already but `balancePayable` missing, and the second case shows 15000).

- [ ] **Step 3: Implement**

In `CustomerBookingView` after `balanceDueCents: number;`:

```ts
  // Money actually received (Σ succeeded payments) and whether the manage page may offer the
  // balance (spec 2026-10-07 §5.3).
  paidCents: number;
  balancePayable: boolean;
```

`projectBooking`:

```ts
export function projectBooking(b: Booking, payments: Payment[] = []): CustomerBookingView {
  const dueNow = b.amountDueNow ?? b.total;
  …
    amountDueNowCents: dueNow,
    balanceDueCents: balanceDueCents(b, payments),
    paidCents: paidCents(payments),
    balancePayable: isBalanceOpen(b, payments),
```

`GET /view`: `return c.json(projectBooking(booking, await payments.findByBookingId(booking.id)), 200);` (`payments` is already in scope in this router — it is used by `/pay-return`).

`ga4Hits.ts:61` calls `projectBooking(b)` for facts only — leave it.

- [ ] **Step 4: Run — expect PASS**; then `cd api && npm run check`.

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/bookings.ts api/src/routes/bookings.view.balance.test.ts
git commit -m "feat(manage): customer view shows paid-so-far and balance from the ledger"
```

- [ ] **Step 6: Open PR 1.** Body: the migration SQL in full, "nullable/defaulted adds + check constraints; no row changes; applies to staging on merge", `select version()` result from staging, red→green output. Wait for review.

---

# PR 2 — Deposit rule (pricing file: owner OK first)

Branch: `feat/deposits-rule`. Title: `feat(pricing): deposit = max(10%, $50), eligible ≥ $150 private/chauffeur`.

### Task 5: Reshape the rate-card deposit and its mirrors

**Files:**
- Modify: `api/src/quote/rateCard.ts` (`:51`, type `:80`)
- Modify: `api/src/quote/extrasDeposit.ts` (`:40-43`)
- Modify: `api/src/quote/engine.ts` (`:170-179` — `depositCents` call and the comment)
- Modify: `api/src/quote/pricingPayload.ts` (`:17-18`, `:57-58`), `tools/generate-pricing.mjs` (`:33-34`), regenerated `transfers-data.js`
- Modify: `booking.js:1889-1891` (dead code kept coherent)
- Modify: `api/src/routes/opsRates.ts:67-68`, `api/src/routes/ops-ui.html:8252-8255`, `api/src/routes/internalQuote.ts:1415`
- Test: `api/src/quote/extrasDeposit.test.ts`, `pricingPayload.test.ts:21-22`, `opsRates.test.ts:35`, goldens snapshot

**Interfaces:**
- Produces: `RATE_CARD.deposit: { pct: number; minCents: number; eligibleMinTotalCents: number }` = `{ pct: 10, minCents: 5000, eligibleMinTotalCents: 15000 }`; `depositFor(product: 'shared'|'private'|'chauffeur', totalCents: number, rateCard?: RateCard): number` (0 = not eligible). `QuoteResult.depositCents` = `depositFor(...)`. Payload `depositMin` (whole USD) replaces `depositCap`; site constant `DEPOSIT_MIN` replaces `DEPOSIT_CAP`.

- [ ] **Step 1: Failing boundary test** (replace the old `depositCents` tests in `extrasDeposit.test.ts`)

```ts
import { depositFor } from './extrasDeposit';

describe('depositFor (spec 2026-10-07 §2)', () => {
  it.each([
    ['private', 14_999, 0],      // under $150: no deposit
    ['private', 15_000, 5_000],  // $150 → $50 floor
    ['private', 50_000, 5_000],  // 10% = $50
    ['private', 60_000, 6_000],  // 10% above the floor
    ['chauffeur', 123_456, 12_346], // rounds to the cent
    ['shared', 90_000, 0],       // shared always pays in full
  ] as const)('%s %i → %i', (product, total, expected) => {
    expect(depositFor(product, total)).toBe(expected);
  });
  it('never exceeds the total', () => {
    expect(depositFor('private', 15_000)).toBeLessThanOrEqual(15_000);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`depositFor` not exported)

Run: `cd api && npx vitest run src/quote/extrasDeposit.test.ts`

- [ ] **Step 3: Implement**

`rateCard.ts:51`: `deposit: { pct: 10, minCents: 5000, eligibleMinTotalCents: 15000 },` and the type at `:80`: `deposit: { pct: number; minCents: number; eligibleMinTotalCents: number };`

`extrasDeposit.ts` — replace `depositCents`:

```ts
// The deposit an eligible booking may pay instead of the full total (spec 2026-10-07 §2, owner
// 2026-10-07): max(10%, $50), never more than the total, and only for private / chauffeur trips of
// $150 or more. 0 means "not eligible — pay in full". Shared rides always pay in full.
export function depositFor(
  product: 'shared' | 'private' | 'chauffeur',
  totalCents: number,
  rateCard: RateCard = RATE_CARD,
): number {
  const d = rateCard.deposit;
  if (product === 'shared' || totalCents < d.eligibleMinTotalCents) return 0;
  return Math.min(totalCents, Math.max(Math.round((totalCents * d.pct) / 100), d.minCents));
}
```

`engine.ts:170`: `const deposit = depositFor(req.product, totalCents, rateCard);` (update the import). Replace the comment at `:171-178` with:

```ts
  // amountDueNow stays the FULL total here: the engine prices, it does not sell. A deposit is
  // chosen at the point of sale (ops deposit link, spec 2026-10-07 §5.2) and written onto the
  // booking as amount_due_now. `deposit` is what that sale would charge — 0 when not eligible.
```

`pricingPayload.ts`: field `depositMin: number; // whole USD — the floor` replacing `depositCap`; value `depositMin: usd(card.deposit.minCents)`. `generate-pricing.mjs:34`: `` `const DEPOSIT_MIN = ${p.depositMin};` `` and rename `DEPOSIT_CAP` → `DEPOSIT_MIN` in the export list it emits. `booking.js:1889-1891`:

```js
const DEPOSIT_PCT = window.TRANSFERS.DEPOSIT_PCT;
const DEPOSIT_MIN = window.TRANSFERS.DEPOSIT_MIN; // USD floor
function depositDue(){ const t = calcTotal(); return Math.min(t, Math.max(Math.round(t*DEPOSIT_PCT), DEPOSIT_MIN)); }
```

`opsRates.ts:67-68`: comment "Shown, never edited: the deposit rule is fixed (owner 2026-10-07)." and `readOnly: { depositPct: RATE_CARD.deposit.pct, depositMinCents: RATE_CARD.deposit.minCents, depositEligibleMinCents: RATE_CARD.deposit.eligibleMinTotalCents }`. `ops-ui.html:8252-8255`:

```js
  // Read-only in both modes: the deposit rule is fixed (owner, 2026-10-07).
  var deposit = row('Deposit', 'optional on private & chauffeur trips from ' + rtUsd(d.readOnly.depositEligibleMinCents),
    view(esc(String(d.readOnly.depositPct)) + '%', 'min ' + rtUsd(d.readOnly.depositMinCents)), null);
```

`internalQuote.ts:1415`: keep `depositPct`; if it also sends `capCents`, rename to `minCents`.

- [ ] **Step 4: Regenerate and update expectations**

```bash
cd api && npm run generate
```

Then update `pricingPayload.test.ts:21-22` to `expect(p.depositMin).toBe(50);`, `opsRates.test.ts:35` to the new `readOnly` object, and run `npx vitest run -u src/quote/__snapshots__` **only after** checking the goldens diff shows nothing but `depositCents` values changing (`git diff api/src/quote/__snapshots__`). Any other changed field = stop and ask.

- [ ] **Step 5: Run the gates** — `cd api && npm run check`; `npm --prefix <abs>/web-tests run test:all` (parity tests compare `transfers-data.js` with the API).

- [ ] **Step 6: Commit and open PR 2** (body: "pricing file — owner OK given on <date>", the boundary table, the goldens diff summary).

```bash
git add api/src/quote/rateCard.ts api/src/quote/extrasDeposit.ts api/src/quote/extrasDeposit.test.ts api/src/quote/engine.ts api/src/quote/pricingPayload.ts api/src/quote/pricingPayload.test.ts tools/generate-pricing.mjs transfers-data.js booking.js api/src/routes/opsRates.ts api/src/routes/opsRates.test.ts api/src/routes/ops-ui.html api/src/routes/internalQuote.ts api/src/quote/__snapshots__/goldens.test.ts.snap
git commit -m "feat(pricing): deposit is max(10%, \$50) on private/chauffeur trips from \$150"
```

---

# PR 3 — Accept a deposit + balance pair everywhere (must merge before PR 4 enables real deposits)

Branch: `feat/deposits-second-payment`.

### Task 6: Settlement — `balance_settled` instead of `double_capture`

**Files:**
- Modify: `api/src/db/paymentSettlementRepo.ts` (outcome union `:9-28`; helper next to `recordedCaptureId` `:45-54`; in-memory `accept` `:160-185`)
- Modify: `api/src/db/postgresPaymentSettlementRepo.ts` (booking select `:54-58`; sibling query `:126-137`; branch `:153-155`)
- Test: `api/src/db/paymentSettlementRepo.test.ts`; `api/src/db/postgres.test.ts` (next to the `double_capture` cases `:1047`, `:1114`)

**Interfaces:**
- Produces: outcome `{ kind: 'balance_settled'; payment: Payment; booking: Booking }`; `isBalanceAfterDeposit(payment: {purpose; amount}, others: {purpose; amount}[], bookingTotal: number): boolean`.

- [ ] **Step 1: Failing in-memory tests** (append to `paymentSettlementRepo.test.ts`; uses its `fixture()`)

```ts
async function depositThenBalance(balanceAmount = 3_000) {
  const f = await fixture(); // booking total 4_000; its payment row is the 4_000 'full' row
  // Turn the fixture's row into the deposit: a fresh deposit payment of 1_000, settled.
  const deposit = await f.payments.create({
    bookingId: f.booking.id, provider: 'payhere', orderId: `${f.booking.reference}-D`,
    amount: 1_000, currency: 'USD', idempotencyKey: `dep-${f.booking.id}`, purpose: 'deposit',
  });
  await f.payments.markSucceeded(deposit.id);
  await f.bookings.setStatus(f.booking.id, 'paid');
  const balance = await f.payments.create({
    bookingId: f.booking.id, provider: 'payhere', orderId: `${f.booking.reference}-B`,
    amount: balanceAmount, currency: 'USD', idempotencyKey: `checkout:${f.booking.id}:balance`, purpose: 'balance',
  });
  const event = { ...f.event, orderId: balance.orderId, providerTxnId: 'PAY-BAL', amountCents: balanceAmount };
  return { f, balance, event };
}

it('settles a balance after its deposit as one sale, leaving the booking where it is', async () => {
  const { f, event } = await depositThenBalance();
  const outcome = await new InMemoryPaymentSettlementRepo(f).acceptVerifiedEvent(event);
  expect(outcome.kind).toBe('balance_settled');
  expect(outcome.payment.status).toBe('succeeded');
  expect((await f.bookings.get(f.booking.id))?.status).toBe('paid');
});

it('still flags a balance that would take more than the total', async () => {
  const { f, event } = await depositThenBalance(3_001);
  expect((await new InMemoryPaymentSettlementRepo(f).acceptVerifiedEvent(event)).kind).toBe('double_capture');
});

it('still flags a second full capture (no deposit)', async () => {
  // existing test 'flags a second capture on a booking already settled in cash' must stay green
});
```

- [ ] **Step 2: Run — expect FAIL** (`'double_capture'` received for the first case).

Run: `cd api && npx vitest run src/db/paymentSettlementRepo.test.ts`

- [ ] **Step 3: Implement**

Outcome union — add after `double_capture`:

```ts
  // The balance of a deposit booking (spec 2026-10-07 §5.1): a second capture that is the other
  // half of ONE sale, not a second sale. The payment is settled; the booking is left exactly where
  // it is (already paid / confirmed / in progress) — the deposit is what secured it.
  | { kind: 'balance_settled'; payment: Payment; booking: Booking }
```

Helper beside `recordedCaptureId`:

```ts
/** A balance arriving after its deposit is the second half of one sale. True only for a
 *  `balance` payment whose single sibling capture is the booking's `deposit`, and only while the
 *  two together stay within the total. Anything else is still a double capture. Shared by both
 *  repos so the in-memory fake and Postgres cannot disagree. */
export function isBalanceAfterDeposit(
  payment: { purpose: string; amount: number },
  others: Array<{ purpose: string; amount: number }>,
  bookingTotal: number,
): boolean {
  return (
    payment.purpose === 'balance' &&
    others.length === 1 &&
    others[0]!.purpose === 'deposit' &&
    others[0]!.amount + payment.amount <= bookingTotal
  );
}
```

In-memory `accept`: replace the `alreadyCaptured` read and its branch:

```ts
    // Read before our own write, so this asks only about OTHER payments on the booking.
    const otherCaptures = (await this.deps.payments.findByBookingId(paymentRecord.bookingId)).filter(
      (p) => p.id !== paymentRecord.id && p.status === 'succeeded',
    );
    …putForSettlement / failureHook unchanged…
    if (otherCaptures.length) {
      return {
        kind: isBalanceAfterDeposit(paymentRecord, otherCaptures, booking.total) ? 'balance_settled' : 'double_capture',
        payment: this.requirePayment(event.orderId),
        booking,
      };
    }
```

Postgres: booking select becomes `.select({ id: bookings.id, status: bookings.status, total: bookings.total })`; sibling query becomes

```ts
      const otherCaptures = await tx
        .select({ id: payments.id, purpose: payments.purpose, amount: payments.amount })
        .from(payments)
        .where(and(eq(payments.bookingId, payment.bookingId), eq(payments.status, 'succeeded'), ne(payments.id, payment.id)));
```

and the branch after the update:

```ts
      if (otherCaptures.length) {
        const kind = isBalanceAfterDeposit(payment, otherCaptures, booking.total)
          ? ('balance_settled' as const)
          : ('double_capture' as const);
        return { kind, payment: succeeded, bookingId: booking.id };
      }
```

(Import `isBalanceAfterDeposit`.) Keep the existing comment block and extend it with one line: "…unless it is the balance of a deposit booking (isBalanceAfterDeposit)".

- [ ] **Step 4: Postgres test** — in `postgres.test.ts`, beside the `double_capture` case at `:1047`, add the same deposit → balance scenario against `PostgresPaymentSettlementRepo` asserting `balance_settled` and booking status unchanged. Runs only with `DATABASE_URL_TEST` (CI has it; locally see memory "Local api gate needs DATABASE_URL_TEST").

- [ ] **Step 5: Run — expect PASS**; `cd api && npm run typecheck` will now flag every `switch`/`if` over `outcome.kind` that must handle the new kind — note them for Task 7.

- [ ] **Step 6: Commit**

```bash
git add api/src/db/paymentSettlementRepo.ts api/src/db/postgresPaymentSettlementRepo.ts api/src/db/paymentSettlementRepo.test.ts api/src/db/postgres.test.ts
git commit -m "feat(payments): a balance after its deposit settles as one sale, not a double capture"
```

### Task 7: Balance receipt email + webhook path

**Files:**
- Modify: `api/src/services/notifications.ts` (new `sendBalanceReceived` after `sendDepositReceived` `:895-939`; deposit copy `:919`)
- Modify: kind lists — `api/src/adapters/email.ts:10-21`, `api/src/domain/trackingContract.ts:9-21`, `api/src/db/notificationLogRepo.ts:5-13`
- Modify: `api/src/routes/webhooks.ts` (new branch before `if (outcome.kind === 'settled')` `:357`; team title `:436`)
- Modify: `api/src/routes/devEmails.ts` + `api/src/services/__fixtures__/sampleBookings.ts` (preview fixture)
- Test: `api/src/routes/webhooks.test.ts`, `api/src/services/notifications.test.ts`

**Interfaces:**
- Consumes: `balance_settled` (Task 6).
- Produces: `sendBalanceReceived(booking: Booking, balanceCents: number, email: EmailAdapter, links?: { manage?: string }): Promise<void>`; kinds `'balance_received'` in all four lists.

- [ ] **Step 1: Failing tests**

`notifications.test.ts` (use the file's fake email adapter):

```ts
it('balance receipt says fully paid with deposit, balance and total', async () => {
  await sendBalanceReceived(depositBooking /* total 20000, amountDueNow 5000 */, 15000, email, { manage: 'https://x/m' });
  const sent = email.sent.at(-1)!;
  expect(sent.subject).toBe(`You’re fully paid — ${depositBooking.reference}`);
  expect(sent.text).toContain('Deposit paid: $50.00');
  expect(sent.text).toContain('Balance paid: $150.00');
  expect(sent.text).toContain('Total paid: $200.00');
});
it('deposit email promises the balance link on day one', async () => {
  await sendDepositReceived(depositBooking, email);
  expect(email.sent.at(-1)!.html).toContain('link to pay the balance on the first day of your trip');
});
```

`webhooks.test.ts` (reuse its PayHere-signed notify helper): deposit booking paid, balance row pending, post a succeeded notify for `REF-B` →

```ts
expect(res.status).toBe(200);
expect(alerts.sent.find((a) => a.kind === 'payment_double_capture')).toBeUndefined();
expect(email.sent.at(-1)!.subject).toMatch(/^You’re fully paid/);
expect(await notificationLog.wasSent(booking.id, 'balance_received')).toBe(true);
expect(alerts.sent.find((a) => a.kind === 'booking_paid')!.title).toBe(`Balance paid: ${booking.reference} — $150.00`);
```

And for the existing deposit settle: the `booking_paid` title now shows the deposit amount (`Paid: REF — $50.00`).

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement**

`notifications.ts` — deposit copy at `:919`: replace "we’ll share the payment details on WhatsApp closer to the day." with "we’ll send you a link to pay the balance on the first day of your trip." and the comment at `:895-896` with "A deposit was collected; the balance is paid by a link ops sends on day one (spec 2026-10-07)." New function:

```ts
// ── Balance received (the second half of a deposit booking — now fully paid) ──
export async function sendBalanceReceived(
  booking: Booking,
  balanceCents: number,
  email: EmailAdapter,
  links: { manage?: string } = {},
): Promise<void> {
  const first = esc(booking.input.customer.firstName);
  const rows: [string, string][] = [
    ['Deposit paid', money(booking.total - balanceCents, booking.currency)],
    ['Balance paid', money(balanceCents, booking.currency)],
    ['Total paid', money(booking.total, booking.currency)],
  ];
  const html = page(
    brandHeader() +
      introBlock('Fully paid', TEAL_DEEP, `Thanks, ${first} — you’re fully paid`, 'We’ve received your balance. Nothing more is due for this trip.') +
      ticketCard(booking, BADGE_PAID) +
      rows.map(([label, amount]) => totalBlock(label, amount)).join('') +
      (links.manage ? manageButton(links.manage) : '') +
      footer(),
  );
  const text = textShell('balance received', 'We’ve received your balance — you’re fully paid.', booking, [
    ...factRows(booking).map(([k, v]) => `${k}: ${v}`),
    ...rows.map(([label, amount]) => `${label}: ${amount}`),
    ...(links.manage ? ['', `View your booking: ${links.manage}`] : []),
  ]);
  await email.send({
    to: booking.input.customer.email,
    subject: `You’re fully paid — ${booking.reference}`,
    html,
    text,
    tracking: emailTracking(booking, 'balance_received'),
  });
}
```

Add `| 'balance_received'` / `'balance_received',` to the three kind lists.

`webhooks.ts` — before `if (outcome.kind === 'settled') {`:

```ts
    // The balance of a deposit booking (spec 2026-10-07 §5.1). The booking was secured by the
    // deposit and has already had its confirmation, concierge task and quote claim — none of that
    // runs again. The customer gets a receipt; the team gets the money line; GA4 gets the payment
    // (ga4Hits labels a second payment 'balance'). All best-effort, like the paid branch below.
    if (outcome.kind === 'balance_settled') {
      const b = outcome.booking;
      try {
        await sendBalanceReceived(b, outcome.payment.amount, email, { manage: manageUrl(b, baseUrl, linkSecret) });
        await notificationLog?.markSent(b.id, 'balance_received');
      } catch (err) {
        console.error(`balance receipt failed for ${b.reference}:`, err);
        void alerts.send({
          severity: 'critical',
          kind: 'confirmation_email_failed',
          title: `Balance receipt failed for ${b.reference}`,
          body: `Booking ${b.reference}'s balance is PAID but the customer got no receipt. Error: ${err instanceof Error ? err.message : String(err)}`,
          dedupeKey: `${b.reference}:balance`,
        });
      }
      try {
        await alerts.send({
          severity: 'info',
          kind: 'booking_paid',
          title: `Balance paid: ${b.reference} — ${fmtMoney(outcome.payment.amount, b.currency)}`,
          body: `Balance of ${fmtMoney(outcome.payment.amount, b.currency)} received. ${b.reference} is now fully paid (${fmtMoney(b.total, b.currency)}).`,
          dedupeKey: `${b.reference}:balance`,
        });
      } catch (err) {
        console.error(`team balance notification failed for ${b.reference}:`, err);
      }
      if (deps.ga4) {
        void deps.ga4.reportPayment(b, outcome.payment, event.receivedAt).catch((err) => {
          console.error(`ga4 balance report failed for ${b.reference}:`, err instanceof Error ? err.message : String(err));
        });
      }
      return c.json({ ok: true }, 200);
    }
```

Team title at `:436`: `title: \`Paid: ${paid.reference} — ${fmtMoney(outcome.payment.amount, paid.currency)}\`,` (the amount actually paid; a deposit no longer reads as the whole total). Handle any other `outcome.kind` site the typecheck flagged in Task 6 (tracking/`track({ outcome })` calls) by treating `balance_settled` like `settled`.

Dev preview: add a `singleBalancePaid` fixture next to `singleDeposit` (`sampleBookings.ts:90-92`) and a `/dev/emails` entry calling `sendBalanceReceived(fixture, 15_000, …)`, mirroring the deposit entry at `devEmails.ts:102-106`.

- [ ] **Step 4: Run — expect PASS**; `cd api && npm run check`.

- [ ] **Step 5: Commit**

```bash
git add api/src/services/notifications.ts api/src/services/notifications.test.ts api/src/adapters/email.ts api/src/domain/trackingContract.ts api/src/db/notificationLogRepo.ts api/src/routes/webhooks.ts api/src/routes/webhooks.test.ts api/src/routes/devEmails.ts api/src/services/__fixtures__/sampleBookings.ts
git commit -m "feat(payments): balance webhook sends a fully-paid receipt and the team money line"
```

### Task 8: Payment case, tracking and watchdog stop calling the pair an incident

**Files:**
- Modify: `api/src/domain/paymentCase.ts` (`moneyOf` `:124-146`, `refundOf` capturedCents `:175`); its evidence loader in `api/src/services/paymentCase.ts` must include `purpose` on each payment
- Modify: `api/src/services/bookingTracking.ts:238` (succeeded filter)
- Modify: `api/src/services/watchdog.ts:264`
- Test: `api/src/domain/paymentCase.test.ts`, `api/src/services/bookingTracking.test.ts`, `api/src/services/watchdog.test.ts`

- [ ] **Step 1: Failing tests** (each uses the file's existing builders)

- paymentCase: evidence with a settled `deposit` card row (5000, success notice `PAY-D`) and a settled `balance` card row (15000, notice `PAY-B`) → `paymentVerdict(e).kind === 'paid'` (today: the balance is invisible; with refunds present `capturedCents` must be 20000).
- bookingTracking: a succeeded `balance` payment with no `→ paid` status event yields **no** `captured_payment_missing_transition` finding; a succeeded `full` payment without one still does.
- watchdog: a `paid` deposit booking older than `UNCONFIRMED_PAID_MS` with `'deposit_received'` logged and no `'confirmation'` raises **no** `watchdog_paid_unconfirmed` alert.

- [ ] **Step 2: Run — expect FAIL** (tracking and watchdog fail; the paymentCase test fails on `capturedCents`).

- [ ] **Step 3: Implement**

`paymentCase.ts` `moneyOf`:

```ts
  // The card payment the case is about is the FIRST one (full or deposit). A deposit booking's
  // balance is the second half of the same sale (spec 2026-10-07): counted in captured money,
  // never judged as a second capture.
  const gateway = e.payments.find((p) => !isManual(p) && p.purpose !== 'balance') ?? null;
  const balance = e.payments.find((p) => !isManual(p) && p.purpose === 'balance' && p.status === 'succeeded') ?? null;
```

Add `balance` to the `Money` interface and the returned object; `refundOf` `capturedCents` becomes `(m.cardPaid && m.gateway ? m.gateway.amount : 0) + (m.balance ? m.balance.amount : 0) + (m.manualPaid && m.manual ? m.manual.amount : 0)`. Add `purpose: string` to the `CaseEvidence['payments']` element type and pass it through in `services/paymentCase.ts`.

`bookingTracking.ts:238`: `payments.filter((payment) => payment.status === 'succeeded' && payment.purpose !== 'balance')` with the comment "A balance never moves the booking — the deposit did (spec 2026-10-07)."

`watchdog.ts:264`:

```ts
    // A deposit booking's confirmation IS the deposit-received email (webhooks.ts) — spec 2026-10-07.
    if ((await log.wasSent(b.id, 'confirmation')) || (await log.wasSent(b.id, 'deposit_received'))) continue;
```

- [ ] **Step 4: Run — expect PASS**; `cd api && npm run check`.

- [ ] **Step 5: Commit**

```bash
git add api/src/domain/paymentCase.ts api/src/domain/paymentCase.test.ts api/src/services/paymentCase.ts api/src/services/bookingTracking.ts api/src/services/bookingTracking.test.ts api/src/services/watchdog.ts api/src/services/watchdog.test.ts
git commit -m "fix(payments): payment case, tracking and watchdog accept a deposit + balance pair"
```

### Task 9: Refund against a named payment

**Files:**
- Modify: `api/src/db/refundRepo.ts` (`RefundError` codes `:53-55`; `request` input `:89-95`; in-memory `request` `:130-170`)
- Modify: `api/src/db/postgresRefundRepo.ts` (`request` `:50-95`)
- Modify: `api/src/routes/admin.ts` (`RefundRequest` `:207-213`)
- Modify: `api/src/routes/ops-ui.html` (`refundHtmlFor` `:3753-3810`, request handler `:3694-3721`)
- Test: `api/src/routes/refunds.test.ts`

**Interfaces:**
- Produces: `request({ …, paymentId?: string })`; new `RefundError` codes `'payment_ambiguous'` (several captures and no `paymentId`) and `'refund_exceeds_payment'`.

- [ ] **Step 1: Failing tests** (refunds.test.ts helpers)

```ts
it('refunds a named payment and caps it at that payment', async () => {
  // deposit 5000 + balance 15000 captured on one booking
  const over = await requestRefund(booking.id, { amountCents: 5001, currency: 'USD', reason: 'x', paymentId: deposit.id });
  expect(over.status).toBe(409);
  expect(await over.json()).toEqual({ error: 'refund_exceeds_payment' });
  const ok = await requestRefund(booking.id, { amountCents: 5000, currency: 'USD', reason: 'x', paymentId: deposit.id });
  expect(ok.status).toBe(201); // whatever status the existing success test asserts
  expect((await ok.json()).paymentId).toBe(deposit.id);
});
it('asks which payment when there are several and none is named', async () => {
  const res = await requestRefund(booking.id, { amountCents: 100, currency: 'USD', reason: 'x' });
  expect(await res.json()).toEqual({ error: 'payment_ambiguous' });
});
it('a one-payment booking needs no paymentId (unchanged)', async () => { /* existing tests stay green */ });
```

- [ ] **Step 2: Run — expect FAIL** (400 `invalid_refund_request` for the unknown `paymentId` key — the schema is `.strict()`).

- [ ] **Step 3: Implement**

`admin.ts` schema: add `paymentId: z.string().uuid().optional(),`.

Both repos, after `captured` is loaded and the currency check:

```ts
      // A deposit booking holds two captures (spec 2026-10-07). A refund belongs to ONE of them —
      // it is that payment's gateway id PayHere refunds — so with several, ops must say which.
      const target = input.paymentId
        ? captured.find((p) => p.id === input.paymentId)
        : captured.length === 1 ? captured[0] : undefined;
      if (!target) throw new RefundError(input.paymentId ? 'payment_not_captured' : 'payment_ambiguous');
```

Keep the booking-wide `reserved + amount > capturedCents` check, then add the per-payment one (Postgres shown; in-memory filters its refund list the same way):

```ts
      const [{ onTarget }] = await tx
        .select({ onTarget: dsql<number>`coalesce(sum(${refunds.amountCents}), 0)::int` })
        .from(refunds)
        .where(and(eq(refunds.paymentId, target.id), inArray(refunds.status, [...RESERVING_STATUSES])));
      if (onTarget + input.amountCents > target.amount) throw new RefundError('refund_exceeds_payment');
```

…and insert with `paymentId: target.id, provider: target.provider` instead of `captured[0]`. Add both codes to the `RefundError` union.

`ops-ui.html` refund block: when the detail carries more than one captured payment, render one "Request refund" button per payment (label `Refund deposit — $X remaining` / `Refund balance — $Y remaining`), each posting its `paymentId`; with one payment, today's single button, unchanged. Read where `refundSummary` (`:3610-3617`) gets its payments and add `id`/`purpose` to that data if the detail response lacks them (`routes/ops.ts:298` already loads `payments`).

- [ ] **Step 4: Run — expect PASS**; `cd api && npm run check`; `test:all`.

- [ ] **Step 5: Commit and open PR 3**

```bash
git add api/src/db/refundRepo.ts api/src/db/postgresRefundRepo.ts api/src/routes/admin.ts api/src/routes/refunds.test.ts api/src/routes/ops-ui.html
git commit -m "feat(refunds): a refund names the payment it returns; capped per payment"
```

---

# PR 4 — Ops deposit link

Branch: `feat/deposits-link`.

### Task 10: Mint a deposit pay link

**Files:**
- Modify: `api/src/db/quoteRepo.ts` (`SavedQuote` `:102-105`, patch type `:187-191`, in-memory init `:430-432`, patch `:573-575`, content-update clear `:643-644`)
- Modify: `api/src/db/postgresQuoteRepo.ts` (row map `:60-61`, patch `:399-402`, content-update clear `:511-512`)
- Modify: `api/src/routes/internalQuote.ts` (`POST /:id/pay-link` `:1183-1294`)
- Test: `api/src/routes/internalQuote.test.ts` (pay-link section)

**Interfaces:**
- Consumes: `depositFor` (Task 5).
- Produces: `SavedQuote.payLinkDepositCents: number | null`; patch key `payLinkDepositCents`; `POST /admin/quote/:id/pay-link` body `{ mode: 'deposit' }` → `{ url, payhereMode, amountCents /* the deposit */, coverage: null, depositCents, totalCents }`; refusal `409 { error: 'not_linkable', reason: 'deposit_ineligible' }`.

- [ ] **Step 1: Failing tests**

```ts
it('mints a deposit link for an eligible private quote', async () => {
  const q = await readyQuote(quotes, { totalCents: 21_900 }); // private, ≥ $150
  const res = await payLink(app, q.id, { mode: 'deposit' });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ amountCents: 5_000, depositCents: 5_000, totalCents: 21_900, coverage: null });
  expect((await quotes.get(q.id))!.payLinkDepositCents).toBe(5_000);
});
it('refuses a deposit on a quote under $150', async () => {
  const q = await readyQuote(quotes, { totalCents: 14_999 });
  expect(await (await payLink(app, q.id, { mode: 'deposit' })).json()).toEqual({ error: 'not_linkable', reason: 'deposit_ineligible' });
});
it('refuses a deposit combined with a part-of-trip selection', async () => {
  const q = await readyQuote(quotes, { totalCents: 21_900 });
  const res = await payLink(app, q.id, { mode: 'deposit', legIndexes: [0], extraIndexes: [] });
  expect(await res.json()).toEqual({ error: 'not_linkable', reason: 'deposit_ineligible' });
});
it('switching between full and deposit retires the other link', async () => {
  const q = await readyQuote(quotes, { totalCents: 21_900 });
  const full = await (await payLink(app, q.id)).json();
  const dep = await (await payLink(app, q.id, { mode: 'deposit' })).json();
  expect(dep.url).not.toBe(full.url);
  expect((await quotes.get(q.id))!.payLinkSeq).toBe(1);
  const again = await (await payLink(app, q.id)).json();
  expect((await quotes.get(q.id))!.payLinkDepositCents).toBeNull();
  expect(again.url).not.toBe(dep.url);
});
it('a content edit clears the frozen deposit', async () => { /* update the quote; expect payLinkDepositCents null */ });
```

(`payLink(app, id, body?)` = the file's existing pay-link request helper; add the optional body if it has none.)

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement**

Quote repos: add `payLinkDepositCents` beside `soldCents` in every place listed under Files (type, init `null`, patch passthrough, map from `r.payLinkDepositCents ?? null`, and `= null` wherever `soldCents = null` is cleared on a content update).

Route, after `const raw = …`:

```ts
    // Deposit link (spec 2026-10-07 §5.2): the whole trip, sold for its deposit now and the rest on
    // day one. Never a part of the trip — a deposit on a subset is undesigned — and only for an
    // eligible quote. The amount is the fixed rule's, frozen on the quote like soldCents.
    if (raw != null && 'mode' in raw && raw.mode !== 'deposit' && raw.mode !== 'full') {
      return c.json({ error: 'bad_request' }, 400);
    }
    const depositMode = raw?.mode === 'deposit';
    const depositCents = depositMode && !attemptsSelection ? depositFor(engine.product, quote.totalCents) : 0;
    if (depositMode && depositCents <= 0) {
      return c.json({ error: 'not_linkable', reason: 'deposit_ineligible' }, 409);
    }
```

(`attemptsSelection` must be computed before this block; move its line up if needed.)

`changed` becomes:

```ts
    const frozenDeposit = depositMode ? depositCents : null;
    const changed =
      JSON.stringify(normalizeSel(quote.payLinkSelection)) !== JSON.stringify(selection) ||
      (quote.payLinkDepositCents ?? null) !== frozenDeposit;
```

The patch's `changed` branch adds `payLinkDepositCents: frozenDeposit,`. The response:

```ts
      amountCents: depositMode ? depositCents : amountCents,
      coverage,
      ...(depositMode ? { depositCents, totalCents: quote.totalCents } : {}),
```

- [ ] **Step 4: Run — expect PASS**; `cd api && npm run check`.

- [ ] **Step 5: Commit**

```bash
git add api/src/db/quoteRepo.ts api/src/db/postgresQuoteRepo.ts api/src/routes/internalQuote.ts api/src/routes/internalQuote.test.ts
git commit -m "feat(quote): ops can mint a deposit pay link on an eligible quote"
```

### Task 11: The deposit sale — pay page and checkout

**Files:**
- Modify: `api/src/routes/quotePay.ts` (`/view` `:206-223`, `/start` `:302-325`)
- Modify: `api/src/routes/bookings.ts` (checkout `payments.create` `:1005-1012`)
- Modify: `pay.html` (payable view `:560-567`, `totalsHtml` `:638-649`, purchase value `:280-292`)
- Test: `api/src/routes/quotePay.test.ts`, `api/src/routes/checkout.test.ts`, `web-tests/unit/` (new `pay-page-deposit.test.js`, extracting `totalsHtml` the way `pay-page-discount.test.js` does)

**Interfaces:**
- Consumes: `quote.payLinkDepositCents` (Task 10).
- Produces: `/quotes/pay/view` payable body gains `deposit: { cents, usd, balanceCents, balanceUsd } | undefined` (`totals` stays the trip total); the created booking has `amountDueNow = payLinkDepositCents`; the checkout's first payment has `purpose: 'deposit'` when `amountDueNow < total`.

- [ ] **Step 1: Failing tests**

quotePay.test.ts:

```ts
it('a deposit link sells the whole trip for its deposit', async () => {
  const q = await readyQuote(quotes, { totalCents: 21_900 });
  await quotes.patch(q.id, { payLinkDepositCents: 5_000, payLinkSeq: 1 });
  const t = signQuotePayToken(q.id, q.revision, SECRET, 1);
  const v = await (await view(app, t)).json();
  expect(v.totals.cents).toBe(21_900);
  expect(v.deposit).toEqual({ cents: 5_000, usd: '$50.00', balanceCents: 16_900, balanceUsd: '$169.00' });
  const started = await (await start(app, t)).json();
  const b = await bookings.get(started.bookingId);
  expect(b).toMatchObject({ total: 21_900, amountDueNow: 5_000 });
});
```

(Match `usd()`'s actual format — check one existing assertion in the file.)

checkout.test.ts: a booking with `total 21_900, amountDueNow 5_000` → after `POST /bookings/:id/checkout`, `(await payments.findByBookingId(id))[0]` has `amount 5_000, purpose 'deposit', orderId booking.reference`; a full booking's row has `purpose 'full'`.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement**

`/view` payable branch, after `const soldCents = …`:

```ts
    // A deposit link (spec 2026-10-07 §5.2): the page shows the trip total, what is paid today and
    // what is left for day one. The charge is the deposit.
    const dep = quote.payLinkDepositCents;
    …
      totals: { cents: soldCents, usd: usd(soldCents) },
      ...(dep ? { deposit: { cents: dep, usd: usd(dep), balanceCents: soldCents - dep, balanceUsd: usd(soldCents - dep) } } : {}),
```

`/start`: both `amountDueNow: soldCents` become `amountDueNow: quote.payLinkDepositCents ?? soldCents`.

Checkout `payments.create`: add `purpose: dueNow < booking.total ? 'deposit' : 'full',`.

`pay.html` — `totalsHtml(copy, totals, discount, deposit)` gains, appended after the existing return value (build it into a variable first):

```js
    + (deposit
        ? '<div class="tot tot-sub"><span class="l">Deposit today</span><span class="v">' + esc(deposit.usd) + '</span></div>'
          + '<div class="tot tot-sub"><span class="l">Balance on day one</span><span class="v">' + esc(deposit.balanceUsd) + '</span></div>'
        : '')
```

Call it with `data.deposit`; the paysub line reads `(data.deposit ? 'Pay your deposit to secure the trip. ' + esc(data.deposit.usd) : 'Pay securely to confirm. ' + esc(tt.usd)) + ' — no extra fees.'`. `withMoney` / the purchase `value` uses `data.deposit ? data.deposit.cents : totals.cents` (the amount actually charged).

- [ ] **Step 4: Run — expect PASS**; `cd api && npm run check`; `test:all`. Eyeball `pay.html` with the dev server on a deposit link (memory: local preview cannot price — use the API test data path).

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/quotePay.ts api/src/routes/quotePay.test.ts api/src/routes/bookings.ts api/src/routes/checkout.test.ts pay.html web-tests/unit/pay-page-deposit.test.js
git commit -m "feat(pay): a deposit link charges the deposit and shows the day-one balance"
```

### Task 12: Ops quote builder — Deposit link button and copy

**Files:**
- Modify: `api/src/routes/ops-ui.html` — button set `:9767-9796`, action dispatch `:11100-11112`, `mintPayLink` `:6656-6674`, estimate chip `:8985-8992`
- Test: `api/src/routes/opsUi.paylink.test.ts` (this file already scans the action bar; follow its pattern)

- [ ] **Step 1: Failing test** — the action bar for a `ready`/`sent` quote whose estimate has `deposit.cents > 0` contains `mintDepositLink`; one with `deposit.cents === 0` does not; the dispatch maps `mintDepositLink` → `depositLinkPress`.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement**

Next to `var PAYLINK = …` (`:9767`) — read the estimate the chip uses (`est`, `:8985`; it carries `deposit: money(result.depositCents)` from `internalQuote.ts:455`):

```js
  /* Deposit link (spec 2026-10-07): whole trip, eligible quotes only — the server is the authority
     and refuses anything else with reason deposit_ineligible. */
  var DEPLINK = (est && est.deposit && est.deposit.cents > 0)
    ? B('mintDepositLink', 'Deposit link (' + fmtUsd(est.deposit.cents) + ')', 'ch-btn-outline', false, 'Copies a link to pay the deposit now and the balance on day one')
    : null;
```

and on each `ready`/`sent` line, after `PAYLINK`: `if (DEPLINK) out.push(DEPLINK);` — keep each line one line (the bar tests scan line by line).

Dispatch (`:11104` area): `} else if (action === 'mintDepositLink') { runAction(action, depositLinkPress);`.

After `payLinkPress`:

```js
/* Same press-mint-copy as the full link, with mode=deposit. Minting it retires a full link and
   vice versa (the server bumps the seq), so _payLink is replaced either way. */
async function depositLinkPress() {
  if (!state.savedId) return;
  try {
    var r = await api('/admin/quote/' + encodeURIComponent(state.savedId) + '/pay-link', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'deposit' }),
    });
    if (!r.ok) {
      var err = await jsonOrNull(r);
      showToast(err && err.reason === 'deposit_ineligible'
        ? 'This quote can’t take a deposit — it must be private or chauffeur, $150 or more, whole trip'
        : payLinkRefusal(err, 'Only an approved (ready or sent) quote can take a payment link'), 'error');
      return;
    }
    var body = await jsonOrNull(r);
    if (!body || !body.url) { showToast('Could not create the deposit link', 'error'); return; }
    _payLink = { url: body.url, mode: body.payhereMode || 'off' };
    _payPartial = null;
    copyPayLink();
  } catch (e) {
    window.opsReportError && window.opsReportError('mint deposit link', e);
    showToast('Could not create the deposit link', 'error');
  }
}
```

Estimate chip (`:8985-8992`) — replace "Pay in full to confirm … no balance due after checkout" with: label `Deposit option`, value `fmtUsd(est.deposit.cents)`, note `'balance ' + fmtUsd(est.total.cents - est.deposit.cents) + ' on day one'`, shown when `est.deposit && est.deposit.cents > 0` (any product, not only chauffeur). The WhatsApp copy lines at `:9478-9479` and `:9517-9518` ("Pay in full to confirm") stay — the full link is still the default.

- [ ] **Step 4: Run — expect PASS**; `test:all`; eyeball the builder in the browser preview (deposit button present on a $219 private quote, absent on a $120 one; toast on press).

- [ ] **Step 5: Commit and open PR 4**

```bash
git add api/src/routes/ops-ui.html api/src/routes/opsUi.paylink.test.ts
git commit -m "feat(ops): Deposit link button on eligible quotes"
```

---

# PR 5 — Balance link

Branch: `feat/deposits-balance`.

### Task 13: Balance checkout, checkout token and pay-return

**Files:**
- Modify: `api/src/routes/bookings.ts` — checkout `:955-1150`, `/view/checkout-token` `:924-940`, `/pay-return` `:885-916`
- Test: `api/src/routes/checkout.balance.test.ts` (new; copy setup from `checkout.test.ts`), `api/src/routes/payReturn.test.ts`

**Interfaces:**
- Consumes: `balanceDueCents`, `isBalanceOpen`, `SECURED_STATUSES` (Task 3).
- Produces: `POST /bookings/:id/checkout` body `{ purpose: 'balance', returnTo?: 'manage' }` → checkout params for `REF-B`; `409 { error: 'no_balance_due' }` otherwise.

- [ ] **Step 1: Failing tests**

```ts
// deposit booking: total 20000, amountDueNow 5000, status confirmed, deposit 5000 succeeded
it('charges exactly the balance on REF-B', async () => {
  const res = await checkout(booking.id, { purpose: 'balance', returnTo: 'manage' });
  expect(res.status).toBe(200);
  const rows = await payments.findByBookingId(booking.id);
  const bal = rows.find((p) => p.purpose === 'balance')!;
  expect(bal).toMatchObject({ orderId: `${booking.reference}-B`, amount: 15000, idempotencyKey: `checkout:${booking.id}:balance` });
  expect((await res.json()).amount).toBe(15000); // field name per the adapter's params
});
it('is idempotent', async () => { /* two calls → one balance row */ });
it('refuses when nothing is owed, without a deposit, or on a closed booking', async () => {
  // full-paid booking → 409 no_balance_due; payment_pending deposit booking → 409; cancelled → 409
});
it('the manage page may get a checkout token for an open balance', async () => {
  expect((await checkoutToken(manageToken)).status).toBe(200);
});
```

payReturn.test.ts:

```ts
it('a balance return is pending until the balance lands, even though the deposit succeeded', async () => {
  // deposit succeeded, balance row pending
  expect((await (await payReturn(rt)).json()).status).toBe('pending');
  // mark the balance succeeded
  expect((await (await payReturn(rt)).json()).status).toBe('paid');
});
```

- [ ] **Step 2: Run — expect FAIL** (`not_chargeable` 409 on a confirmed booking; pay-return answers `paid` immediately).

- [ ] **Step 3: Implement**

Checkout: move `const body = (await c.req.json().catch(() => null)) as { returnTo?: unknown; ga?: unknown; purpose?: unknown } | null;` to just after the booking is loaded (it is read once). Then replace the status gate with:

```ts
    // The balance of a deposit booking (spec 2026-10-07 §5.3). A secured booking may be charged
    // ONLY its balance, and only once a deposit has settled; the amount comes from the ledger,
    // never the client.
    const wantsBalance = body?.purpose === 'balance';
    let balanceCents = 0;
    if (wantsBalance) {
      const rows = await payments.findByBookingId(booking.id);
      if (!isBalanceOpen(booking, rows)) return c.json({ error: 'no_balance_due', status: booking.status }, 409);
      balanceCents = balanceDueCents(booking, rows);
    } else if (booking.status !== 'draft' && booking.status !== 'payment_pending') {
      return c.json({ error: 'not_chargeable', status: booking.status }, 409);
    }
```

`needsPricing` check unchanged. Then:

```ts
    const dueNow = wantsBalance ? balanceCents : booking.amountDueNow ?? booking.total;
    const idempotencyKey = wantsBalance ? `checkout:${booking.id}:balance` : `checkout:${booking.id}`;
```

Promo re-hold: guard with `if (!wantsBalance && booking.promoCodeId && deps.promoCodes)` (the code was honoured when the deposit sold). `payments.create`: `orderId: wantsBalance ? \`${booking.reference}-B\` : booking.reference,` and `purpose: wantsBalance ? 'balance' : dueNow < booking.total ? 'deposit' : 'full',`. After create/find, `if (payment.amount !== dueNow) return c.json({ error: 'amount_mismatch' }, 409);` (a stale balance row can't charge a different number). The draft → payment_pending move is already conditional on `draft`, so a secured booking skips it. `items: \`Ceylon Hop Travel - ${payment.orderId}\``.

`/view/checkout-token`:

```ts
    const open = (booking.status === 'draft' || booking.status === 'payment_pending') && !booking.needsPricing;
    if (!open && !isBalanceOpen(booking, await payments.findByBookingId(booking.id))) {
      return c.json({ error: 'not_chargeable', status: booking.status }, 409);
    }
```

`/pay-return`, after `const rows = …`:

```ts
    // A balance payer must not be told "paid" off the deposit (spec 2026-10-07 §5.3): once a
    // balance attempt exists, it alone is the answer.
    const balanceRow = rows.find((p) => p.purpose === 'balance');
    const judged = balanceRow ? [balanceRow] : rows;
```

and use `judged` in place of `rows` in the `status` expression.

- [ ] **Step 4: Run — expect PASS**; `cd api && npm run check`.

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/bookings.ts api/src/routes/checkout.balance.test.ts api/src/routes/payReturn.test.ts
git commit -m "feat(checkout): balance checkout on REF-B for a deposit booking"
```

### Task 14: Manage page — Pay balance

**Files:**
- Modify: `manage.html` — `payable` `:257`, `render` pay block `:359-368`, `pay` checkout body `:405-417`, `renderLoading` `:388`, `trackPurchase` `:161-174`
- Test: `web-tests/e2e/manage-balance.spec.js` (new; stub `/bookings/view` with `balancePayable: true` using the `_stubs.js` patterns; dates via `futureIsoDate`)

- [ ] **Step 1: Failing e2e** — stubbed view `{ status: 'confirmed', totalCents: 20000, amountDueNowCents: 5000, paidCents: 5000, balanceDueCents: 15000, balancePayable: true }` → page shows a button "Pay balance" and the text "Pay your balance. $150.00"; pressing it POSTs `/checkout` with body containing `"purpose":"balance"`. A view with `balancePayable: false` and status `paid` shows no pay button.

- [ ] **Step 2: Run — expect FAIL**: `npm --prefix <abs>/web-tests run test:all -- manage-balance`

- [ ] **Step 3: Implement**

```js
  function payable(v){ return (v.status === 'draft' || v.status === 'payment_pending') && v.amountDueNowCents > 0; }
  // The balance of a deposit booking (spec 2026-10-07): the server decides, the page only asks.
  function payingBalance(v){ return !payable(v) && v.balancePayable === true; }
  function chargeOf(v){ return payingBalance(v) ? Number(v.balanceDueCents || 0) : Number(v.amountDueNowCents || 0); }
```

`render`: `if (payable(v) || payingBalance(v)) {` with the button label `payingBalance(v) ? 'Pay balance' : 'Pay with PayHere'` and paysub `(payingBalance(v) ? 'Pay your balance. ' : 'Pay securely to confirm. ') + esc(money(chargeOf(v), v.currency)) + ' — no extra fees.'`; `begin_checkout` value and `renderLoading`'s `.amt` use `chargeOf(v)`.

`pay(v)` checkout body: `var intent = payingBalance(v) ? { returnTo: 'manage', purpose: 'balance' } : { returnTo: 'manage' };` passed through `chWithGa` as today. Before leaving for PayHere when paying a balance: `try { sessionStorage.setItem(STORE + ':balance', String(v.reference || '1')); } catch (e) {}`.

`trackPurchase`: first line after the sandbox/prod gates:

```js
    // A balance is the second payment on a reference the deposit already reported; the server's
    // purchase covers it with its own transaction id (ga4Hits). Never re-send the reference here.
    try { if (sessionStorage.getItem(STORE + ':balance') === String(v.reference || '1')) return; } catch (e) {}
```

- [ ] **Step 4: Run — expect PASS**; full `test:all`.

- [ ] **Step 5: Commit**

```bash
git add manage.html web-tests/e2e/manage-balance.spec.js
git commit -m "feat(manage): Pay balance button for a deposit booking"
```

### Task 15: Ops sees and sends the balance

**Files:**
- Modify: `api/src/services/opsView.ts` (`OpsBookingRow` `:33-45`, `toOpsRow` `:105-114`)
- Modify: `api/src/routes/ops.ts` (list `:237-243`, detail `payLink` `:298-307`)
- Modify: `api/src/routes/ops-ui.html` (`rowToTicket` `:2226-2234`, `reason` `:2113-2124`, list row `:2499`, drawer payment block `:4027-4034`)
- Test: `api/src/services/opsView.test.ts`, `api/src/routes/ops.test.ts` (or the file holding `GET /admin/ops/bookings` tests), an ops-ui text test beside `opsUi.paylink.test.ts`

**Interfaces:**
- Consumes: `paidCents`, `balanceDueCents`, `isBalanceOpen` (Task 3).
- Produces: `OpsBookingRow.paidCents: number`, `OpsBookingRow.balanceCents: number`; `toOpsRow(b, { …, payments?: Payment[] })`; detail `payLink` set for an open balance.

- [ ] **Step 1: Failing tests**

opsView: a confirmed deposit booking with a 5000 deposit → row `{ paymentStatus: 'paid', paidCents: 5000, balanceCents: 15000 }`; a full-paid booking → `balanceCents: 0`.
ops route: `GET /admin/ops/bookings/:id` for that booking returns a non-null `payLink` (the manage URL); after the balance settles, `payLink` is null.
ops-ui text test: `reason` returns `'Balance due — travels today'` for a ticket `{ stage: 'vehicle_confirmed', balance: 15000, date: TODAY }`.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement**

`opsView.ts` — row fields after `amount`:

```ts
  paidCents: number;    // Σ succeeded payments (spec 2026-10-07)
  balanceCents: number; // still owed — a deposit booking until its balance lands
```

`toOpsRow` opts: replace `paid: boolean` with `payments: Payment[]` (derive `paid` as `payments.some((p) => p.status === 'succeeded')` so `paymentStatus` is unchanged), and set `paidCents: paidCents(opts.payments), balanceCents: balanceDueCents(b, opts.payments)`. Update the one caller.

`ops.ts` list: group once — `const paymentsByBooking = Map<string, Payment[]>` from `allPayments` — and pass `payments: paymentsByBooking.get(b.id) ?? []`. Detail:

```ts
    // The pay-by-card link while the booking can be charged — or, for a deposit booking, while its
    // balance is open (spec 2026-10-07 §5.4). It is the same manage link; the page offers the balance.
    const chargeable = ((b.status === 'draft' || b.status === 'payment_pending') && !b.needsPricing) || isBalanceOpen(b, payments);
```

`ops-ui.html`:
- `rowToTicket`: add `paidCents:row.paidCents||0, balance:row.balanceCents||0,`.
- `reason`, right after the `awaiting_payment` line: `if(t.balance>0&&t.date===TODAY)return 'Balance due — travels today';`
- list row value (`:2499`): `<div class="val">${money(t)}</div>${t.balance>0?`<div class="when">Balance ${money({amount:t.balance,currency:t.currency})}</div>`:''}` — check `money()` reads `amount`/`currency` (it does for tickets: `t.amount`, `t.currency`).
- drawer payment block — after the Amount row:

```js
        ${t.balance>0?`<div class="kv"><span class="k">Paid so far</span><span class="v">${money({amount:t.paidCents,currency:t.currency})}</span></div>
        <div class="kv"><span class="k">Balance due</span><span class="v" style="color:var(--wait);font-weight:700">${money({amount:t.balance,currency:t.currency})} · day one</span></div>
        ${d&&d.payLink?`<div class="sheet-actions"><button class="btn" data-act="paylink" data-id="${esc(t.id)}">${ICON.copy} Copy balance link</button></div>`:''}`:''}
```

and the Status row reads `Deposit paid` (wait colour) when `t.paid && t.balance>0`, else today's Paid / Awaiting payment.
- Ride-board guard (`:4403`) already lists `'paylink'` — unchanged.

- [ ] **Step 4: Run — expect PASS**; `cd api && npm run check`; `test:all`; eyeball the ops drawer and list in the browser preview with a seeded deposit booking (memory: local preview cannot price — seed via the in-memory API).

- [ ] **Step 5: Commit and open PR 5**

```bash
git add api/src/services/opsView.ts api/src/services/opsView.test.ts api/src/routes/ops.ts api/src/routes/ops.test.ts api/src/routes/ops-ui.html <ops-ui test file>
git commit -m "feat(ops): show paid-so-far and balance; copy the balance link; flag balances due today"
```

---

## After PR 5 — release checklist (owner)

1. Staging: mint a deposit link on a ≥ $150 private quote → pay with a sandbox card (staging is PayHere sandbox) → booking `paid`, deposit email received, ops shows Balance due → Copy balance link → pay → "You’re fully paid" email, ops balance 0, payment lookup verdict `paid`.
2. Promote `main → production` only with the owner's explicit OK (it carries the migration).
3. First live deposit: watch the `booking_paid` alerts and the payment lookup for that booking.

## Known gaps (accepted, out of scope)

- `paidRows` (`notifications.ts:559-570`) keeps showing "Balance due" in later emails (e.g. `booking_confirmed`) even after the balance lands; the balance normally lands on day one, after those emails.
- Analytics "Payment outstanding" (`business.ts:213-218`) does not count open balances.
- A balance paid in cash cannot be recorded (owner: card only).
