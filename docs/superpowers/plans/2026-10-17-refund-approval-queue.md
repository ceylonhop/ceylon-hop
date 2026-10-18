# Refund approval queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anyone on the ops team can request a refund of any amount; only a founder can send or confirm it. Founders see every waiting request in the bookings queue. Spec: `docs/superpowers/specs/2026-10-17-refund-approval-queue-design.md`.

**Architecture:** The refund ledger already has a pending step (`manual_pending`) that reserves money, and the PayHere adapter already sends partial amounts. This plan changes **who** may call which refund route (server), alerts founders when ops files a request, adds one batched read so the bookings queue knows which bookings have a refund waiting, and reworks the ops UI's Refunds block (amount field, ops request flow, full/partial line, Late tag) plus a founder-only "Refunds waiting" queue chip.

**Tech Stack:** Node 20 · TypeScript strict · Hono · Zod · Vitest · Drizzle/Postgres · single-file ops UI (`api/src/routes/ops-ui.html`) · web-tests (vitest unit + Playwright e2e). No new dependencies.

## Global Constraints

- Work only in the worktree `$SCRATCHPAD/wt-refunds` on branch `docs/refund-approval-queue` (renamed to `feat/refund-approval-queue` in Task 8). Never touch the shared checkout. Stage files by path; never `git add -A`. Every command below runs **from the worktree root**; `cd` only inside a `( … )` subshell.
- **No migration, no pricing change, no config change.** If a task seems to need one, stop and ask.
- Roles (`api/src/lib/opsAuth.ts`, unchanged): founder holds `payments:reverse` + `bookings:operate` + `payments:act` + `bookings:read`; ops holds `bookings:operate` + `bookings:read`; finance holds `payments:act` + `bookings:read`; system holds only `admin:jobs`.
- The 24-hour rule (`mayReverse` / `reversalGate`) is removed from the **four refund routes only**. `POST /bookings/:id/cancel` keeps it exactly as it is.
- **Find code by function name, not line number.** `ops-ui.html` is the file every session edits; the approximate line numbers below were read on `origin/main` @ `1f5111be` and will drift.
- Exact copy (spec §2, §3, §5, §6):
  - Alert title: `Refund requested: <reference> · <amount> (full)` or `(partial)`, plus ` · LATE` when late. Amount format: `25.00 USD`.
  - Late tag: `Late — trip starts in under 24h`
  - Pending row scope line: `Full refund` or `Partial — <amount> of <captured> paid`
  - Ops pending row: `Waiting for a founder to approve`
  - Ops confirm dialog: `Request a refund of <amount>?\n\nA founder has to approve it before any money moves.`
  - Ops success toast: `Refund requested — waiting for a founder`
  - Founder confirm dialog (unchanged): `Refund <amount> now?\n\nThis sends the money back through PayHere immediately. There is no undo.`
  - Queue chip: `Refunds waiting`; row reason: `Refund waiting for your approval`
  - Cancel-only messages: `The trip starts in under 24 hours — only a founder can cancel from here.` and `This booking has no trip date, so the 24-hour rule cannot be checked. A founder can still cancel it.`
- **Full** = the request is for at least everything captured on the booking (Σ succeeded payments); anything less is **partial**. Same rule on the server (alert) and in the UI (row).
- Money is integer cents everywhere. The UI parses a typed amount from its decimal string — never `parseFloat`.
- **Gate before EVERY commit** (CLAUDE.md maintenance rule 4), exit codes read from the runners themselves:

  ```bash
  (cd api && npm run check); echo "api exit=$?"
  npm --prefix "$PWD/web-tests" run test:all; echo "web exit=$?"
  ```

  Both must print `exit=0`. Never commit red. The api gate needs `DATABASE_URL_TEST` for the Postgres tests; without it they **skip** — record which in the PR, never claim they ran.
- **Evidence** (CLAUDE.md hard rule 2): set once per shell `EVIDENCE="$SCRATCHPAD/refund-evidence"; mkdir -p "$EVIDENCE"`. Every "see it fail" run writes `"$EVIDENCE/taskN-red.txt"` and every "see it pass" run writes `"$EVIDENCE/taskN-green.txt"`. Task 8 pastes them into the PR.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## File map

| File | Responsibility |
| --- | --- |
| `api/src/routes/admin.ts` | **Modify.** Refund route permissions; `refund_requested` alert. |
| `api/src/domain/reversalWindow.ts` | **Modify.** Add `isLateRequest()`; header + two messages scoped to cancelling. |
| `api/src/db/refundRepo.ts` | **Modify.** Interface + InMemory `pendingCentsByBookingIds()`. |
| `api/src/db/postgresRefundRepo.ts` | **Modify.** Postgres `pendingCentsByBookingIds()`. |
| `api/src/services/opsView.ts` | **Modify.** `OpsBookingRow.refundWaitingCents`. |
| `api/src/services/opsBoardView.ts` | **Modify.** Board rows carry `refundWaitingCents: 0`. |
| `api/src/routes/ops.ts` | **Modify.** Batched read feeds the row field. |
| `api/src/routes/ops-ui.html` | **Modify.** Refunds block, both history reads, request + cancel handlers, queue chip, reason, badge. |
| `api/src/routes/refunds.test.ts` | **Modify.** Permission + alert tests. |
| `api/src/routes/admin.test.ts` | **Modify.** Retitle the 24h-on-refunds test. |
| `api/src/domain/reversalWindow.test.ts` | **Modify.** `isLateRequest` + message tests. |
| `api/src/db/refundRepo.pending.test.ts` | **Create.** InMemory `pendingCentsByBookingIds`. |
| `api/src/db/postgresRefundRepo.test.ts` | **Create.** Postgres `pendingCentsByBookingIds` (skips without `DATABASE_URL_TEST`). |
| `api/src/routes/ops.refundWaiting.test.ts` | **Create.** `refundWaitingCents` on `GET /admin/ops/bookings`. |
| `web-tests/unit/ops-refund-amount.test.js` | **Create.** `parseRefundCents`, `refundIsLate`. |
| `web-tests/unit/ops-refund-one-click.test.js` | **Modify.** Label assertion. |
| `web-tests/e2e/ops-refund-approval.spec.js` | **Create** (Task 5), extended in Tasks 6 and 7. |
| `web-tests/e2e/ops-refund-workflow.spec.js` | **Modify.** The "ops … cannot read the refund ledger" and "ops is locked out … 24 hours" tests. |
| `web-tests/e2e/ops-cancel-refund.spec.js` | **Modify.** The "OPS agent is locked out inside the last 24 hours" test + header comment. |

---

### Task 1: Server — who may call which refund route

**Files:**
- Modify: `api/src/routes/admin.ts` — header comment (~41-43), `GET`/`POST /bookings/:id/refunds` (~227-251), `…/confirm` (~317), `…/execute` (~339-350), `…/cancel` (~435)
- Modify: `api/src/routes/admin.test.ts` — test `'the ops time window applies to refunds too, not just cancellation'` (~282)
- Test: `api/src/routes/refunds.test.ts`

**Interfaces:**
- Consumes: `requireCap(action)` (`lib/opsMiddleware.ts`), the existing `fixture()`, `cookie()`, `requestRefund()` helpers in `refunds.test.ts` (`fixture()` returns `{ app, bookings, payments, email, alerts, booking, payment }`; its booking has **no trip date**).
- Produces: the route permission table from spec §1. No new exports.

- [ ] **Step 0: Prepare the worktree**

```bash
ln -s /Users/roshenw/claude_code/ceylon-hop/api/node_modules api/node_modules
ln -s /Users/roshenw/claude_code/ceylon-hop/web-tests/node_modules web-tests/node_modules
EVIDENCE="$SCRATCHPAD/refund-evidence"; mkdir -p "$EVIDENCE"
```

- [ ] **Step 1: Write the failing tests** — change the first import of `api/src/routes/refunds.test.ts` to `import { describe, expect, it, vi } from 'vitest';` and append:

```ts
describe('founder approval (spec 2026-10-17)', () => {
  const post = async (app: ReturnType<typeof createApp>, path: string, actor: string, body: unknown = {}) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: await cookie(actor) },
      body: JSON.stringify(body),
    });

  it('ops may request a partial amount, but only a founder may confirm it', async () => {
    const { app, booking } = await fixture();
    const res = await requestRefund(app, booking.id, 2500, 'ops@test');
    expect(res.status).toBe(201);
    const refund = await res.json();
    expect(refund).toMatchObject({ amountCents: 2500, status: 'manual_pending', requestedBy: 'ops@test' });

    const base = `/admin/bookings/${booking.id}/refunds/${refund.id}`;
    expect((await post(app, `${base}/confirm`, 'ops@test', { gatewayRef: 'PH-1' })).status).toBe(403);
    expect((await post(app, `${base}/confirm`, 'founder@test', { gatewayRef: 'PH-1' })).status).toBe(200);
  });

  it('ops may never send a refund through PayHere', async () => {
    const { app, booking } = await fixture();
    const refund = await (await requestRefund(app, booking.id, 2500, 'ops@test')).json();
    const res = await post(app, `/admin/bookings/${booking.id}/refunds/${refund.id}/execute`, 'ops@test');
    expect(res.status).toBe(403);
  });

  it('ops may cancel a pending request', async () => {
    const { app, booking } = await fixture();
    const refund = await (await requestRefund(app, booking.id, 2500, 'ops@test')).json();
    const res = await post(app, `/admin/bookings/${booking.id}/refunds/${refund.id}/cancel`, 'ops@test');
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('cancelled');
  });

  it('ops reads the ledger; the machine key still cannot', async () => {
    const { app, booking } = await fixture();
    const asOps = await app.request(`/admin/bookings/${booking.id}/refunds`, { headers: { cookie: await cookie('ops@test') } });
    expect(asOps.status).toBe(200);
    const asKey = await app.request(`/admin/bookings/${booking.id}/refunds`, { headers: { 'x-admin-key': KEY } });
    expect(asKey.status).toBe(403);
  });

  it('ops may request on an old booking with no trip date — the 24-hour rule no longer applies to refunds', async () => {
    const { app, booking } = await fixture(); // no date: mayReverse would say trip_start_unknown
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 48 * 3600_000); // past the fresh-booking grace
      expect((await requestRefund(app, booking.id, 2500, 'ops@test')).status).toBe(201);
    } finally {
      vi.useRealTimers();
    }
  });

  it('finance still may not request', async () => {
    const { app, booking } = await fixture();
    expect((await requestRefund(app, booking.id, 2500, 'finance@test')).status).toBe(403);
  });
});
```

- [ ] **Step 2: Run them to see them fail, and save the output**

```bash
(cd api && npx vitest run src/routes/refunds.test.ts -t "founder approval") > "$EVIDENCE/task1-red.txt" 2>&1; echo "exit=$?"
```

Expected: `exit=1`. The file shows: ops confirm/execute not 403, ops ledger read 403, the 48h no-date request 403.

- [ ] **Step 3: Implement** in `api/src/routes/admin.ts`.

Header comment above `export function adminRoutes` becomes:

```ts
// Capability-gated staff API. Refunds (owner, 2026-10-17): founder and ops may REQUEST any
// amount; only a founder (payments:reverse) sends or confirms one. Cancelling a booking keeps
// the 24-hour rule (domain/reversalWindow.ts). The machine key (system) holds none of these.
// Cron/watchdog endpoints stay machine-driven via admin:jobs (system or founder).
```

GET ledger — replace its two comment lines and the `r.get` line with:

```ts
  // Everyone who works bookings reads the ledger — ops needs to see its own requests waiting.
  // Moving money is gated on the routes below, never here.
  r.get('/bookings/:id/refunds', requireCap('bookings:read'), async (c) => {
```

POST request — delete its two `reversalGate` lines so it opens:

```ts
  // A request moves no money and a founder decides every one, so it is not held to the 24-hour
  // rule (owner, 2026-10-17). It still reserves the amount, so requests never exceed the capture.
  r.post('/bookings/:id/refunds', requireCap('bookings:operate'), async (c) => {
    const parsed = RefundRequest.safeParse(await c.req.json().catch(() => null));
```

Confirm — capability changes and the two `reversalGate` lines go:

```ts
  r.post('/bookings/:id/refunds/:refundId/confirm', requireCap('payments:reverse'), async (c) => {
    const parsed = RefundConfirm.safeParse(await c.req.json().catch(() => null));
```

Execute — in its comment, replace "Same gate as confirm — this is the moment money moves, so the protected last day is protected here too." with "Same gate as confirm: founder only — this is the moment money moves." Then:

```ts
  r.post('/bookings/:id/refunds/:refundId/execute', requireCap('payments:reverse'), async (c) => {
    const adapter = deps.paymentAdapter;
```

Cancel:

```ts
  // Cancelling a pending request releases the reservation and moves no money: ops may do it.
  r.post('/bookings/:id/refunds/:refundId/cancel', requireCap('bookings:operate'), async (c) => {
    try {
```

`reversalGate` stays (still used by `POST /bookings/:id/cancel`).

- [ ] **Step 4: Retitle the obsolete test** in `api/src/routes/admin.test.ts`. Its assertions still hold (409 = nothing captured; finance 403); only the claim changes:

```ts
  it('refund requests are not held to the ops time window — the ledger decides', async () => {
```

and replace the comment above the two `op@x.com` expects with:

```ts
    // Since 2026-10-17 a refund REQUEST skips the 24-hour rule (a founder approves every one), so
    // ops reaches the ledger on both and it applies its own check: 409, nothing was captured.
```

- [ ] **Step 5: Run the refund and admin tests, and save the output**

```bash
(cd api && npx vitest run src/routes/refunds.test.ts src/routes/admin.test.ts) > "$EVIDENCE/task1-green.txt" 2>&1; echo "exit=$?"
```

Expected: `exit=0`. If an older test pinned ops sending or confirming a refund, change it to expect 403 and name it in the commit message.

- [ ] **Step 6: Gate and commit**

```bash
(cd api && npm run check); echo "api exit=$?"
npm --prefix "$PWD/web-tests" run test:all; echo "web exit=$?"
git add api/src/routes/admin.ts api/src/routes/admin.test.ts api/src/routes/refunds.test.ts
git commit -m "feat(refunds): ops requests any amount, only a founder sends or confirms

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Founders hear about an ops request (full/partial, Late), and the rule's wording

**Files:**
- Modify: `api/src/domain/reversalWindow.ts` (header comment, two messages in `mayReverse`, append `isLateRequest`)
- Modify: `api/src/routes/admin.ts` (imports; `POST /bookings/:id/refunds` handler)
- Test: `api/src/domain/reversalWindow.test.ts`, `api/src/routes/refunds.test.ts`

**Interfaces:**
- Produces: `export function isLateRequest(booking: Booking, at: Date): boolean` in `domain/reversalWindow.ts`.
- Consumes: `tripStartAt`, `REVERSAL_WINDOW_HOURS` (same file); `bookingDeepLink(id, opsBaseUrl)` (`services/opsNotifications.ts`); `can(role, action)` (`lib/opsAuth.ts`); the route's existing `alerts`, `bookings`, `deps.payments` (a required `PaymentRepo`) and `deps.opsBaseUrl`.

- [ ] **Step 1: Write the failing unit tests** — add `isLateRequest` to the import from `./reversalWindow` in `api/src/domain/reversalWindow.test.ts`, then append:

```ts
describe('isLateRequest — filed inside the last day before the trip (display only)', () => {
  // 2026-09-16 08:00 +05:30 = 02:30Z; the 24h line is 2026-09-15T02:30Z.
  const b = single('2026-09-16', '08:00');
  it('is not late more than 24 hours out', () => {
    expect(isLateRequest(b, at('2026-09-15T02:29:59Z'))).toBe(false);
  });
  it('is late from the 24-hour line on, and after the trip started', () => {
    expect(isLateRequest(b, at('2026-09-15T02:30:00Z'))).toBe(true);
    expect(isLateRequest(b, at('2026-09-17T00:00:00Z'))).toBe(true);
  });
  it('is never late without a trip date', () => {
    expect(isLateRequest(single(), at('2026-09-15T02:30:00Z'))).toBe(false);
  });
});

describe('mayReverse messages speak of cancelling only (refund requests left the rule 2026-10-17)', () => {
  it('inside the last day', () => {
    const v = mayReverse('ops', single('2026-09-16', '08:00'), at('2026-09-16T00:00:00Z'));
    expect(v).toEqual({
      ok: false, code: 'within_24h_founder_only',
      message: 'The trip starts in under 24 hours — only a founder can cancel from here.',
    });
  });
  it('with no trip date', () => {
    const v = mayReverse('ops', single(), at('2026-09-16T00:00:00Z'));
    expect(v).toEqual({
      ok: false, code: 'trip_start_unknown',
      message: 'This booking has no trip date, so the 24-hour rule cannot be checked. A founder can still cancel it.',
    });
  });
});
```

(`single()` builds a booking with no `createdAt`, so the fresh-booking grace never applies.)

- [ ] **Step 2: Write the failing route tests** — append inside `describe('founder approval (spec 2026-10-17)')` in `refunds.test.ts`:

```ts
  it('alerts the founders when ops files a request, says partial, and stays quiet for a founder', async () => {
    const { app, alerts, booking } = await fixture();
    const refund = await (await requestRefund(app, booking.id, 2500, 'ops@test')).json();
    const sent = alerts.sent.filter((a) => a.kind === 'refund_requested');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ severity: 'info', dedupeKey: refund.id });
    expect(sent[0].title).toBe(`Refund requested: ${booking.reference} · 25.00 USD (partial)`);
    expect(sent[0].body).toContain('ops@test');
    expect(sent[0].body).toContain('Customer request');
    expect(sent[0].body).toContain(`of ${(booking.total / 100).toFixed(2)} USD paid`);

    await requestRefund(app, booking.id, 100, 'founder@test');
    expect(alerts.sent.filter((a) => a.kind === 'refund_requested')).toHaveLength(1);
  });

  it('marks a full request on a trip starting within 24 hours as full and LATE', async () => {
    const { app, alerts, bookings, payments } = await fixture();
    // Today's date in Sri Lanka (fixed UTC+05:30), 23:59: the trip is inside its last day — or,
    // run late at night, just past — late either way.
    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    const b = await bookings.create({
      mode: 'single', total: 10000, amountDueNow: 10000, currency: 'USD',
      input: {
        from: 'Colombo Airport', to: 'Ella', vehicleType: 'car', adults: 2, children: 0, bags: 1, date: today, time: '23:59',
        customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+94770000000', country: 'Sri Lanka' },
      },
    });
    const p = await payments.create({
      bookingId: b.id, provider: 'payhere', orderId: b.reference, amount: 10000, currency: 'USD', idempotencyKey: `late:${b.id}`,
    });
    await payments.markSucceeded(p.id);
    expect((await requestRefund(app, b.id, 10000, 'ops@test')).status).toBe(201);
    const sent = alerts.sent.filter((a) => a.kind === 'refund_requested');
    expect(sent.at(-1)!.title).toBe(`Refund requested: ${b.reference} · 100.00 USD (full) · LATE`);
  });
```

- [ ] **Step 3: Run them to see them fail, and save the output**

```bash
(cd api && npx vitest run src/domain/reversalWindow.test.ts src/routes/refunds.test.ts -t "isLateRequest|cancelling only|alerts the founders|full and LATE") > "$EVIDENCE/task2-red.txt" 2>&1; echo "exit=$?"
```

Expected: `exit=1` — `isLateRequest` is not exported; messages still say "cancel or refund"; no `refund_requested` alert.

- [ ] **Step 4: Implement in `api/src/domain/reversalWindow.ts`.**

Replace the header comment's second paragraph (the one ending "…where it can be read.") with:

```ts
// This RELAXES the founder-only `payments:reverse` rule set earlier the same day: the capability
// stays founder-only (it is read elsewhere, and widening it would grant ops reversal everywhere),
// and the time-bounded grant lives here. Since 2026-10-17 it guards CANCELLING only: a refund
// request needs a founder's approval anyway, so it is never blocked — late ones are flagged
// instead (isLateRequest below).
```

In `mayReverse`, the two messages become:

```ts
      message: 'This booking has no trip date, so the 24-hour rule cannot be checked. A founder can still cancel it.',
```

```ts
    message: `The trip starts in under ${REVERSAL_WINDOW_HOURS} hours — only a founder can cancel from here.`,
```

Append:

```ts
/**
 * Was this refund request filed inside the last day before the trip (or after it began)? Display
 * only (spec 2026-10-17 §3): since requests need a founder's approval they are never blocked, but
 * a late one is flagged because the driver may already be committed. No trip date is never late.
 */
export function isLateRequest(booking: Booking, at: Date): boolean {
  const start = tripStartAt(booking);
  if (!start) return false;
  return at.getTime() >= start.getTime() - REVERSAL_WINDOW_HOURS * 3600_000;
}
```

- [ ] **Step 5: Implement the alert in `api/src/routes/admin.ts`.**

Imports: the `opsNotifications` import becomes
`import { teamCancelledEmail, teamRefundedEmail, bookingDeepLink } from '../services/opsNotifications';`,
the `reversalWindow` import becomes `import { mayReverse, isLateRequest } from '../domain/reversalWindow';`,
and add `import { can } from '../lib/opsAuth';`.

In the POST refunds handler, replace `return c.json(refund, 201);` with:

```ts
      // Founders hear about every request someone else files (spec 2026-10-17 §2). A founder's
      // own request is about to be fired, so it needs no email. Best-effort: never fails the request.
      const identity = c.get('identity');
      if (!can(identity.role, 'payments:reverse')) {
        const booking = await bookings.get(refund.bookingId);
        if (booking) {
          const capturedCents = (await deps.payments.findByBookingId(booking.id))
            .filter((p) => p.status === 'succeeded')
            .reduce((sum, p) => sum + p.amount, 0);
          // Full/partial on the title: an empty amount box means "everything" (spec §2).
          const scope = refund.amountCents >= capturedCents ? 'full' : 'partial';
          const late = isLateRequest(booking, refund.requestedAt);
          const fmt = (cents: number) => `${(cents / 100).toFixed(2)} ${refund.currency}`;
          const link = bookingDeepLink(booking.id, deps.opsBaseUrl ?? '');
          void alerts.send({
            severity: 'info',
            kind: 'refund_requested',
            title: `Refund requested: ${booking.reference} · ${fmt(refund.amountCents)} (${scope})${late ? ' · LATE' : ''}`,
            body:
              `${identity.email} asked for a refund of ${fmt(refund.amountCents)} of ${fmt(capturedCents)} paid ` +
              `on ${booking.reference}.\n\n` +
              `Reason: ${refund.reason}\n` +
              (late ? '\nLate — the trip starts in under 24 hours; the driver may already be committed.\n' : '') +
              `\nNo money has moved. Approve or cancel it in the ops tool${link ? `:\n${link}` : '.'}`,
            dedupeKey: refund.id,
          });
        }
      }
      return c.json(refund, 201);
```

- [ ] **Step 6: Run the tests, and save the output**

```bash
(cd api && npx vitest run src/domain/reversalWindow.test.ts src/routes/refunds.test.ts) > "$EVIDENCE/task2-green.txt" 2>&1; echo "exit=$?"
```

Expected: `exit=0`.

- [ ] **Step 7: Gate and commit.** The UI keeps its own copy of the 24-hour message (`reverseGate()`, changed in Task 5), so this task's server wording change does not touch any web test.

```bash
(cd api && npm run check); echo "api exit=$?"
npm --prefix "$PWD/web-tests" run test:all; echo "web exit=$?"
git add api/src/domain/reversalWindow.ts api/src/domain/reversalWindow.test.ts api/src/routes/admin.ts api/src/routes/refunds.test.ts
git commit -m "feat(refunds): alert founders when ops requests a refund (full/partial, late); 24h rule speaks of cancelling only

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Repo — pending refund totals for many bookings in one read

**Files:**
- Modify: `api/src/db/refundRepo.ts` (interface after `list(bookingId)`; InMemory method after its `list()`)
- Modify: `api/src/db/postgresRefundRepo.ts` (after `list()`)
- Create: `api/src/db/refundRepo.pending.test.ts`, `api/src/db/postgresRefundRepo.test.ts`

**Interfaces:**
- Produces: `RefundRepo.pendingCentsByBookingIds(bookingIds: string[]): Promise<Map<string, number>>` — sum of `amountCents` over `manual_pending` rows per booking; bookings with none are absent from the map.

- [ ] **Step 1: Write the failing InMemory test** — create `api/src/db/refundRepo.pending.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { InMemoryBookingRepo } from './bookingRepo';
import { InMemoryPaymentRepo } from './paymentRepo';
import { InMemoryRefundRepo } from './refundRepo';

async function paidBooking(bookings: InMemoryBookingRepo, payments: InMemoryPaymentRepo, total: number) {
  const b = await bookings.create({
    mode: 'single', total, amountDueNow: total, currency: 'USD',
    input: { from: 'Colombo Airport', to: 'Ella', vehicleType: 'car', adults: 2, children: 0, bags: 1,
      customer: { firstName: 'Maya', lastName: 'Silva', email: 'm@x.com', whatsapp: '+94770000000', country: 'LK' } },
  });
  const p = await payments.create({ bookingId: b.id, provider: 'payhere', orderId: b.reference, amount: total, currency: 'USD', idempotencyKey: `k:${b.id}` });
  await payments.markSucceeded(p.id);
  return b;
}

describe('pendingCentsByBookingIds', () => {
  it('sums only manual_pending requests, per booking, and leaves the rest out', async () => {
    const bookings = new InMemoryBookingRepo();
    const payments = new InMemoryPaymentRepo();
    const refunds = new InMemoryRefundRepo(bookings, payments);
    const a = await paidBooking(bookings, payments, 10000);
    const b = await paidBooking(bookings, payments, 10000);
    const c = await paidBooking(bookings, payments, 10000);
    const ask = (bookingId: string, amountCents: number) =>
      refunds.request({ bookingId, amountCents, currency: 'USD', reason: 'x', requestedBy: 'ops@test' });

    await ask(a.id, 1000);
    await ask(a.id, 2500);
    const cancelled = await ask(b.id, 4000);
    await refunds.cancel({ bookingId: b.id, refundId: cancelled.id });
    const confirmed = await ask(c.id, 500);
    await refunds.confirm({ bookingId: c.id, refundId: confirmed.id, gatewayRef: 'PH-1', confirmedBy: 'founder@test' });

    const got = await refunds.pendingCentsByBookingIds([a.id, b.id, c.id]);
    expect([...got.entries()]).toEqual([[a.id, 3500]]);
  });

  it('answers an empty map for no ids', async () => {
    const bookings = new InMemoryBookingRepo();
    const refunds = new InMemoryRefundRepo(bookings, new InMemoryPaymentRepo());
    expect((await refunds.pendingCentsByBookingIds([])).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to see it fail, and save the output**

```bash
(cd api && npx vitest run src/db/refundRepo.pending.test.ts) > "$EVIDENCE/task3-red.txt" 2>&1; echo "exit=$?"
```

Expected: `exit=1` — `refunds.pendingCentsByBookingIds is not a function`.

- [ ] **Step 3: Implement.** In the `RefundRepo` interface, after `list(bookingId: string): Promise<Refund[]>;`:

```ts
  // Σ manual_pending per booking, in ONE read — the ops bookings queue asks for every row at once
  // (spec 2026-10-17 §4). Bookings with nothing waiting are absent from the map.
  pendingCentsByBookingIds(bookingIds: string[]): Promise<Map<string, number>>;
```

In `InMemoryRefundRepo`, after `list()`:

```ts
  async pendingCentsByBookingIds(bookingIds: string[]): Promise<Map<string, number>> {
    const wanted = new Set(bookingIds);
    const out = new Map<string, number>();
    for (const refund of this.rows.values()) {
      if (refund.status !== 'manual_pending' || !wanted.has(refund.bookingId)) continue;
      out.set(refund.bookingId, (out.get(refund.bookingId) ?? 0) + refund.amountCents);
    }
    return out;
  }
```

In `PostgresRefundRepo`, after `list()` (`and`, `eq`, `inArray`, `sql as dsql` are already imported on line 1):

```ts
  async pendingCentsByBookingIds(bookingIds: string[]): Promise<Map<string, number>> {
    if (bookingIds.length === 0) return new Map();
    const rows = await this.db
      .select({ bookingId: refunds.bookingId, cents: dsql<number>`sum(${refunds.amountCents})::int` })
      .from(refunds)
      .where(and(inArray(refunds.bookingId, bookingIds), eq(refunds.status, 'manual_pending')))
      .groupBy(refunds.bookingId);
    return new Map(rows.map((row) => [row.bookingId, Number(row.cents)]));
  }
```

- [ ] **Step 4: Write the Postgres integration test** — create `api/src/db/postgresRefundRepo.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client';
import { PostgresBookingRepo } from './postgresBookingRepo';
import { PostgresPaymentRepo } from './postgresPaymentRepo';
import { PostgresRefundRepo } from './postgresRefundRepo';
import { futureIsoDate } from '../testSupport/dates';

const TEST_URL = process.env.DATABASE_URL_TEST;

describe.skipIf(!TEST_URL)('PostgresRefundRepo.pendingCentsByBookingIds (integration)', () => {
  let bookings: PostgresBookingRepo;
  let payments: PostgresPaymentRepo;
  let refunds: PostgresRefundRepo;

  beforeAll(async () => {
    const conn = createDb(TEST_URL as string);
    await migrate(conn.db, { migrationsFolder: 'drizzle' });
    bookings = new PostgresBookingRepo(conn.db);
    payments = new PostgresPaymentRepo(conn.db);
    refunds = new PostgresRefundRepo(conn.db);
  });

  const paid = async () => {
    const b = await bookings.create({
      mode: 'single',
      input: {
        from: 'Colombo Airport (CMB)', to: 'Ella', date: futureIsoDate(30), time: '09:00', vehicleType: 'car',
        adults: 2, children: 0, bags: 2,
        customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
      },
      total: 10000, amountDueNow: 10000, currency: 'USD',
    });
    const p = await payments.create({
      bookingId: b.id, provider: 'fake', orderId: b.reference, amount: 10000, currency: 'USD', idempotencyKey: `checkout:${b.id}`,
    });
    await payments.markSucceeded(p.id);
    return b;
  };

  it('sums manual_pending per booking and leaves cancelled requests out', async () => {
    const a = await paid();
    const b = await paid();
    await refunds.request({ bookingId: a.id, amountCents: 1000, currency: 'USD', reason: 'x', requestedBy: 'ops@test' });
    await refunds.request({ bookingId: a.id, amountCents: 2500, currency: 'USD', reason: 'x', requestedBy: 'ops@test' });
    const gone = await refunds.request({ bookingId: b.id, amountCents: 4000, currency: 'USD', reason: 'x', requestedBy: 'ops@test' });
    await refunds.cancel({ bookingId: b.id, refundId: gone.id });

    const got = await refunds.pendingCentsByBookingIds([a.id, b.id]);
    expect(got.get(a.id)).toBe(3500);
    expect(got.has(b.id)).toBe(false);
  });
});
```

- [ ] **Step 5: Run both, and save the output**

```bash
(cd api && npx vitest run src/db/refundRepo.pending.test.ts src/db/postgresRefundRepo.test.ts) > "$EVIDENCE/task3-green.txt" 2>&1; echo "exit=$?"
```

Expected: `exit=0`. The file shows the Postgres test as passed when `DATABASE_URL_TEST` is set, otherwise **skipped** — note which.

- [ ] **Step 6: Gate and commit**

```bash
(cd api && npm run check); echo "api exit=$?"
npm --prefix "$PWD/web-tests" run test:all; echo "web exit=$?"
git add api/src/db/refundRepo.ts api/src/db/postgresRefundRepo.ts api/src/db/refundRepo.pending.test.ts api/src/db/postgresRefundRepo.test.ts
git commit -m "feat(refunds): read pending refund totals for many bookings at once

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Ops bookings row carries `refundWaitingCents`

**Files:**
- Modify: `api/src/services/opsView.ts` (`OpsBookingRow`, `toOpsRow`)
- Modify: `api/src/services/opsBoardView.ts` (the row object it returns)
- Modify: `api/src/routes/ops.ts` (`r.get('/bookings', …)`)
- Create: `api/src/routes/ops.refundWaiting.test.ts`

**Interfaces:**
- Consumes: `RefundRepo.pendingCentsByBookingIds` (Task 3); `deps.refunds?: RefundRepo` already on `opsRoutes` and wired by `createApp`.
- Produces: `OpsBookingRow.refundWaitingCents: number` (0 when none, always 0 on ride-board rows); `toOpsRow(b, { …, refundWaitingCents?: number })`.

- [ ] **Step 1: Write the failing test** — create `api/src/routes/ops.refundWaiting.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createApp } from '../app';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryPaymentRepo } from '../db/paymentRepo';
import { InMemoryRideOpsRepo } from '../db/rideOpsRepo';
import { InMemoryRefundRepo } from '../db/refundRepo';
import { issueSessionCookie } from '../lib/opsMiddleware';

const auth = { opsUsers: 'f@x.com:founder', googleClientId: 'cid', opsSessionSecret: 'sek' };

async function hdr() {
  const c = new Hono();
  c.get('/', (ctx) => { issueSessionCookie(ctx, 'f@x.com', 'sek', Date.now()); return ctx.text('ok'); });
  return { cookie: (await c.request('/')).headers.get('set-cookie')!.split(';')[0] };
}

describe('ops list — refund waiting for approval (spec 2026-10-17 §4)', () => {
  it('carries the sum of pending requests, and 0 when there are none', async () => {
    const bookings = new InMemoryBookingRepo();
    const payments = new InMemoryPaymentRepo();
    const refunds = new InMemoryRefundRepo(bookings, payments);
    const app = createApp({ bookings, payments, refunds, rideOps: new InMemoryRideOpsRepo(), auth, adminApiKey: 'k' });
    const make = async () => {
      const b = await bookings.create({
        mode: 'single', total: 10000, amountDueNow: 10000, currency: 'USD',
        input: { from: 'Colombo Airport', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 1, date: '2030-06-22', time: '09:00',
          customer: { firstName: 'Maya', lastName: 'Silva', email: 'm@x.com', whatsapp: '+34600', country: 'ES' } },
      });
      await bookings.setStatus(b.id, 'payment_pending');
      const p = await payments.create({ bookingId: b.id, provider: 'payhere', orderId: b.reference, amount: 10000, currency: 'USD', idempotencyKey: `checkout:${b.id}` });
      await payments.markSucceeded(p.id);
      await bookings.setStatus(b.id, 'paid');
      return b;
    };
    const waiting = await make();
    const quiet = await make();
    await refunds.request({ bookingId: waiting.id, amountCents: 2550, currency: 'USD', reason: 'Dropped a leg', requestedBy: 'ops@test' });

    const rows = await (await app.request('/admin/ops/bookings', { headers: await hdr() })).json();
    const byId = new Map(rows.map((r: { id: string }) => [r.id, r]));
    expect(byId.get(waiting.id)).toMatchObject({ refundWaitingCents: 2550 });
    expect(byId.get(quiet.id)).toMatchObject({ refundWaitingCents: 0 });
  });
});
```

- [ ] **Step 2: Run it to see it fail, and save the output**

```bash
(cd api && npx vitest run src/routes/ops.refundWaiting.test.ts) > "$EVIDENCE/task4-red.txt" 2>&1; echo "exit=$?"
```

Expected: `exit=1` — `refundWaitingCents` is undefined on both rows.

- [ ] **Step 3: Implement.**

`api/src/services/opsView.ts` — in `OpsBookingRow`, after `serviceType`:

```ts
  /** Σ refund requests waiting for a founder (manual_pending), 0 when none. Drives the founder's
   *  "Refunds waiting" queue chip (spec 2026-10-17 §4). Always 0 on a ride-board row. */
  refundWaitingCents: number;
```

`toOpsRow`'s `opts` type gains `refundWaitingCents?: number;` and the returned object gains, after `serviceType: …`:

```ts
    refundWaitingCents: opts.refundWaitingCents ?? 0,
```

`api/src/services/opsBoardView.ts` — in the returned row object, after `serviceType: null,`:

```ts
    refundWaitingCents: 0,
```

`api/src/routes/ops.ts` — in `r.get('/bookings', …)`, replace the `const [ops, allPayments] = await Promise.all([…]);` line with:

```ts
    const [ops, allPayments, waiting] = await Promise.all([
      deps.rideOps.listByBookingIds(ids),
      deps.payments.findByBookingIds(ids),
      // Batched with the two above for the same reason: one read for the whole queue.
      deps.refunds ? deps.refunds.pendingCentsByBookingIds(ids) : Promise.resolve(new Map<string, number>()),
    ]);
```

and the `toOpsRow` call in the loop becomes:

```ts
      const row = toOpsRow(b, {
        rideOps: opsById.get(b.id) ?? null, paid: paidIds.has(b.id), teamEmails: deps.teamEmails,
        payments: paymentsById.get(b.id) ?? [], refundWaitingCents: waiting.get(b.id) ?? 0,
      });
```

- [ ] **Step 4: Run the test and the existing row tests, and save the output**

```bash
(cd api && npx vitest run src/routes/ops.refundWaiting.test.ts src/routes/ops.balance.test.ts src/services/opsView.test.ts) > "$EVIDENCE/task4-green.txt" 2>&1; echo "exit=$?"
```

Expected: `exit=0`. If an existing test does a full `toEqual` on a row, add `refundWaitingCents: 0` to its expectation and stage that file too.

- [ ] **Step 5: Gate and commit**

```bash
(cd api && npm run check); echo "api exit=$?"
npm --prefix "$PWD/web-tests" run test:all; echo "web exit=$?"
git add api/src/services/opsView.ts api/src/services/opsBoardView.ts api/src/routes/ops.ts api/src/routes/ops.refundWaiting.test.ts
git commit -m "feat(ops): bookings rows say how much refund is waiting for approval

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Ops UI — the request form: amount field, ops may request, no 24-hour block

**Files:**
- Modify: `api/src/routes/ops-ui.html` — new helpers after `refundTargets`; `reverseGate` messages; `refundRequestFor`; `refundHtmlFor` first line + the "No amount box" comment; the sheet loader's refund-history read; `reloadRefundDetail`; the `refundrequest` click handler
- Create: `web-tests/unit/ops-refund-amount.test.js`, `web-tests/e2e/ops-refund-approval.spec.js`
- Modify: `web-tests/unit/ops-refund-one-click.test.js`, `web-tests/e2e/ops-refund-workflow.spec.js`, `web-tests/e2e/ops-cancel-refund.spec.js`

**Interfaces:**
- Consumes: existing `tripStartMs(t)`, `REFUND_CUTOFF_MS`, `refundSummary(d)` (→ `{captured, confirmed, pending, remaining, currency}`), `refundTargets(d)`, `refundPaymentName(p)`, `money({amount,currency})`, `esc`, `isBoard(t)`, `fireRefund`, `reloadRefundDetail`, `clearInput`, `toast`, `$`.
- Produces: `function parseRefundCents(raw)` → integer cents or `null`; `function refundIsLate(t, r)` → boolean (used by Task 6). Element ids `#refundamount`, `#refundreason`. The e2e file `ops-refund-approval.spec.js` with `baseRow`, `boot(page, { role, row, store })` and `openSheet(page)` (extended by Tasks 6–7).

- [ ] **Step 1: Write the failing unit test** — create `web-tests/unit/ops-refund-amount.test.js`:

```js
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.resolve(__dirname, '../../api/src/routes/ops-ui.html'), 'utf8');

function extract(name) {
  const m = html.match(new RegExp(`function ${name}\\([^)]*\\)\\{[\\s\\S]*?\\n\\}`));
  if (!m) throw new Error(`${name} not found in ops-ui.html`);
  return m[0];
}
// eslint-disable-next-line no-new-func
const parseRefundCents = new Function(`${extract('parseRefundCents')}\nreturn parseRefundCents;`)();
// eslint-disable-next-line no-new-func
const refundIsLate = new Function('tripStartMs', 'REFUND_CUTOFF_MS',
  `${extract('refundIsLate')}\nreturn refundIsLate;`,
)((t) => (t.date ? Date.parse(`${t.date}T${t.time || '00:00'}:00+05:30`) : null), 24 * 3600 * 1000);

describe('parseRefundCents — a typed amount to integer cents, no floating point', () => {
  it.each([['25', 2500], ['25.5', 2550], ['25.50', 2550], ['19.99', 1999], [' $1,200.10 ', 120010], ['0.01', 1]])(
    '%s → %d', (raw, cents) => expect(parseRefundCents(raw)).toBe(cents),
  );
  it.each(['', '0', '0.00', '-5', '1.234', 'abc', '1e3', '.5'])('rejects %j', (raw) => {
    expect(parseRefundCents(raw)).toBeNull();
  });
});

describe('refundIsLate — filed inside the last 24h before the trip', () => {
  const t = { date: '2030-01-15', time: '09:00' }; // 03:30Z; the line is 2030-01-14T03:30Z
  it('is not late a day and a minute out', () => {
    expect(refundIsLate(t, { requestedAt: '2030-01-14T03:29:00.000Z' })).toBe(false);
  });
  it('is late on and after the line', () => {
    expect(refundIsLate(t, { requestedAt: '2030-01-14T03:30:00.000Z' })).toBe(true);
    expect(refundIsLate(t, { requestedAt: '2030-01-16T00:00:00.000Z' })).toBe(true);
  });
  it('is never late without a trip date', () => {
    expect(refundIsLate({ date: null }, { requestedAt: '2030-01-14T03:30:00.000Z' })).toBe(false);
  });
});
```

- [ ] **Step 2: Write the failing e2e** — create `web-tests/e2e/ops-refund-approval.spec.js`:

```js
import { test, expect } from '@playwright/test';

// Spec 2026-10-17: ops requests any refund, a founder approves. These pin the ops side of the
// Refunds block and the founder's "Refunds waiting" chip. Clicks use dispatchEvent('click'), as
// ops-refund-workflow.spec.js does, so a sticky footer can never intercept them.
const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

const baseRow = {
  id: 'booking-1', reference: 'CH-RA001', channel: 'web', customerName: 'Approval Traveller',
  customerFirstName: 'Approval', mode: 'single', route: 'Colombo → Kandy', travelDate: '2030-01-15',
  travelTime: '09:00', pax: 2, amount: 10000, currency: 'USD', stage: 'paid', paymentStatus: 'paid',
  vehiclePhotoReceived: false, customerUpdated: false, opsNotes: '', refundWaitingCents: 0,
};
const detail = {
  booking: {
    id: 'booking-1', reference: 'CH-RA001', mode: 'single', status: 'paid', total: 10000, currency: 'USD',
    createdAt: '2030-01-01T10:00:00.000Z',
    input: { from: 'Colombo', to: 'Kandy', customer: { firstName: 'Approval', lastName: 'Traveller', email: 'a@example.com', whatsapp: '+94770000000', country: 'Sri Lanka' } },
  },
  ops: {},
  payments: [{ id: 'payment-1', bookingId: 'booking-1', provider: 'payhere', orderId: 'CH-RA001', amount: 10000, currency: 'USD', status: 'succeeded' }],
};
const CAPS = {
  ops: ['bookings:read', 'bookings:operate'],
  founder: ['bookings:read', 'bookings:operate', 'payments:act', 'payments:reverse'],
};

async function boot(page, { role, row = baseRow, store }) {
  store.posts = [];
  await page.addInitScript(() => {
    window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } }, maps: { importLibrary: async () => ({}) } };
  });
  // Last registered wins in Playwright: catch-all first, specifics after.
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: [] })));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: `${role}@e2e.test`, role, caps: CAPS[role] })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([row])));
  await page.route('**/admin/ops/bookings/booking-1', (r) => r.fulfill(json(detail)));
  await page.route('**/admin/bookings/booking-1/refunds', async (r) => {
    if (r.request().method() === 'GET') return r.fulfill(json(store.refunds));
    const body = r.request().postDataJSON();
    store.posts.push(body);
    const refund = {
      id: `refund-${store.refunds.length + 1}`, bookingId: 'booking-1', paymentId: 'payment-1', provider: 'payhere',
      amountCents: body.amountCents, currency: 'USD', status: 'manual_pending', reason: body.reason, gatewayRef: null,
      requestedBy: `${role}@e2e.test`, requestedAt: store.requestedAt || '2030-01-02T10:00:00.000Z',
      confirmedBy: null, confirmedAt: null, createdAt: '2030-01-02T10:00:00.000Z', updatedAt: '2030-01-02T10:00:00.000Z',
    };
    store.refunds.push(refund);
    return r.fulfill(json(refund, 201));
  });
  await page.route(/\/admin\/bookings\/booking-1\/refunds\/([^/]+)\/cancel$/, async (r) => {
    const id = new URL(r.request().url()).pathname.match(/refunds\/([^/]+)\/cancel$/)[1];
    const refund = store.refunds.find((x) => x.id === id);
    refund.status = 'cancelled';
    store.cancelled = (store.cancelled || 0) + 1;
    return r.fulfill(json(refund));
  });
  await page.goto(OPS_FILE + '#bookings');
  await page.waitForSelector('#approot:not([hidden]) #nav button', { timeout: 10000 });
}
const openSheet = async (page) => {
  await page.locator('[data-act="open"][data-id="booking-1"]').dispatchEvent('click');
  await page.waitForSelector('#sheet.show .sheet-b', { timeout: 10000 });
};

test('ops requests a partial refund; nothing that moves money is offered', async ({ page }) => {
  const store = { refunds: [] };
  page.on('dialog', (d) => d.accept());
  await boot(page, { role: 'ops', store });
  await openSheet(page);
  await page.locator('#refundamount').fill('25.50');
  await page.locator('#refundreason').fill('Customer dropped the Kandy leg');
  await page.locator('[data-act="refundrequest"]').dispatchEvent('click');
  await expect(page.locator('.refund-row')).toHaveCount(1);
  expect(store.posts).toEqual([{ amountCents: 2550, currency: 'USD', reason: 'Customer dropped the Kandy leg' }]);
  await expect(page.getByText('Refund requested — waiting for a founder')).toBeVisible();
  await expect(page.locator('[data-act="refundexecute"]')).toHaveCount(0);
  await expect(page.locator('[data-act="refundconfirm"]')).toHaveCount(0);
});

test('an amount above what is left is refused before anything is posted', async ({ page }) => {
  const store = { refunds: [] };
  page.on('dialog', (d) => d.accept());
  await boot(page, { role: 'ops', store });
  await openSheet(page);
  await page.locator('#refundamount').fill('150');
  await page.locator('#refundreason').fill('Too much');
  await page.locator('[data-act="refundrequest"]').dispatchEvent('click');
  await expect(page.getByText('more than the $100 left to refund')).toBeVisible();
  expect(store.posts).toEqual([]);
});

test('the ops sheet survives a refund history that is not a list', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const store = { refunds: {} }; // what a catch-all mock (or an odd server answer) hands back
  await boot(page, { role: 'ops', store });
  await openSheet(page);
  await expect(page.getByText('Refundable remaining')).toBeVisible();
  expect(errors).toEqual([]);
});
```

- [ ] **Step 3: Run them to see them fail, and save the output**

```bash
(cd web-tests && npx vitest run unit/ops-refund-amount.test.js; npx playwright test e2e/ops-refund-approval.spec.js) > "$EVIDENCE/task5-red.txt" 2>&1; echo "exit=$?"
```

Expected: `exit=1`. The file shows `parseRefundCents not found`, and the e2e failing on a missing `#refundamount` / no Refunds block for ops.

- [ ] **Step 4: Add the two helpers** — in `ops-ui.html`, directly after `function refundTargets(d){…}`:

```js
/* A typed refund amount → integer cents, or null when it is not a usable amount (spec 2026-10-17
   §5). Read from the decimal STRING, never parseFloat: "19.99" must be 1999, not 1998.99…
   Accepts "25", "25.5", "25.50", "$1,200.10"; refuses 0, negatives, >2 decimals, anything else.
   Empty is the caller's business — it means "the full remaining amount". */
function parseRefundCents(raw){
  const s=String(raw==null?'':raw).trim().replace(/^\$/,'').replace(/,/g,'');
  const m=s.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if(!m)return null;
  const cents=Number(m[1])*100+Number((m[2]||'').padEnd(2,'0'));
  return Number.isSafeInteger(cents)&&cents>0?cents:null;
}
/* Filed less than 24h before the trip starts, or after. Display only — mirrors isLateRequest() in
   domain/reversalWindow.ts. A booking with no trip date is never late. */
function refundIsLate(t, r){
  const at=tripStartMs(t),req=Date.parse((r&&r.requestedAt)||'');
  if(at===null||!Number.isFinite(req))return false;
  return req>=at-REFUND_CUTOFF_MS;
}
```

- [ ] **Step 5: Scope `reverseGate` to cancelling.** Its leading comment becomes `/* Who may CANCEL, and whether the ops time window has closed on them. Refund requests are not held to it (owner, 2026-10-17). */` and its `why` becomes:

```js
    why: tripStartMs(t) === null
      ? 'This booking has no trip date, so the 24-hour rule cannot be checked — a founder can still cancel it'
      : 'The trip starts in under 24 hours — only a founder can cancel from here',
```

- [ ] **Step 6: Replace `refundRequestFor`** (the whole function and its leading comment block) with:

```js
/* The refund request form (spec 2026-10-17 §5). Founder and ops may ask for any amount up to what
   is left; only a founder's press also moves the money. Not held to the 24-hour rule — a founder
   approves every request, and late ones are flagged on the row instead. Lives INSIDE the Refunds
   block, above the ledger, so a request and its follow-up actions sit in reading order (2026-08-07). */
function refundRequestFor(t, d){
  const founder=!!(state.caps&&state.caps.includes('payments:reverse'));
  const opsAgent=!founder&&!!(state.caps&&state.caps.includes('bookings:operate'));
  if((!founder&&!opsAgent)||isBoard(t))return '';
  const s=refundSummary(d);
  if(s.remaining<=0)return '';            // nothing left to ask for; the ledger below says why
  const verb=founder?'Refund':'Request refund';
  const tip=founder?'Refunds through PayHere immediately — there is no undo':'Files a refund request — a founder approves it before any money moves';
  const targets=refundTargets(d);
  const several=targets.length>1;
  const amountBox=`<label class="reverse-reason">Amount <span class="muted">empty = the full remaining amount</span>
      <input id="refundamount" inputmode="decimal" autocomplete="off" placeholder="${several?'Full remaining of the payment you pick':esc(money({amount:s.remaining,currency:s.currency}))}">
    </label>`;
  /* Its own reason field, not one shared with Cancel booking: a reason typed for a cancellation
     and left behind would be silently attached to a refund — both are permanent audit records. */
  const reasonBox=`<label class="reverse-reason">Reason <span class="req">required</span>
      <input id="refundreason" maxlength="500" autocomplete="off" placeholder="e.g. customer dropped the Kandy → Ella leg">
    </label>`;
  const buttons=several
    ? targets.filter(p=>p.remaining>0).map(p=>`<button class="btn btn-noshow" data-act="refundrequest" data-id="${esc(t.id)}" data-payment-id="${esc(p.id)}" title="${tip}">${verb}: ${refundPaymentName(p)} — ${money({amount:p.remaining,currency:s.currency})} remaining</button>`).join('')
    : `<button class="btn btn-noshow" data-act="refundrequest" data-id="${esc(t.id)}" title="${tip}">${verb}</button>`;
  return `${amountBox}${reasonBox}<div class="reverse-actions">${buttons}</div>`;
}
```

- [ ] **Step 7: Open the Refunds block to ops.** In `refundHtmlFor`, the first line becomes:

```js
  if(!state.caps||!state.caps.includes('bookings:read'))return '';
```

and the comment block above `const request=refundRequestFor(t,d);` ("No amount box: our PayHere setup cannot do partial refunds…") becomes:

```js
  /* An amount box since 2026-10-17: our PayHere plan now does partial refunds, and a founder
     approves every request. See refundRequestFor. */
```

- [ ] **Step 8: Both refund-history reads keep only a list.** In the sheet loader, replace

```js
    if(state.caps&&state.caps.includes('payments:act')){
      try{detail.refunds=await adminApi.get('/bookings/'+id+'/refunds');}
```

with

```js
    /* Everyone who works bookings reads the ledger since 2026-10-17. Keep only a list: a mock
       catch-all (or an odd answer) of {} would otherwise reach refundSummary's .filter and throw. */
    if(state.caps&&state.caps.includes('bookings:read')){
      try{const got=await adminApi.get('/bookings/'+id+'/refunds');detail.refunds=Array.isArray(got)?got:[];}
```

and in `reloadRefundDetail`, replace `detail.refunds=await adminApi.get('/bookings/'+id+'/refunds');` with:

```js
  const got=await adminApi.get('/bookings/'+id+'/refunds');
  detail.refunds=Array.isArray(got)?got:[];
```

- [ ] **Step 9: Rework the `refundrequest` handler.** Replace from `case 'refundrequest':{` through the `if(!amountCents){…}` and `if(!reason){…}` lines with:

```js
    case 'refundrequest':{
      /* Founder or ops; never held to the 24-hour rule (spec 2026-10-17). The server enforces the
         same: request is bookings:operate, sending is payments:reverse. */
      const willFire=!!(state.caps&&state.caps.includes('payments:reverse'));
      if(!willFire&&!(state.caps&&state.caps.includes('bookings:operate')))break;
      const busyKey='request:'+id;if(refundBusy.has(busyKey))break;
      const s=refundSummary(state.detailData);
      /* A button that names a payment refunds against that payment (deposit bookings); the plain
         button against the booking's single capture. */
      const paymentId=el.dataset.paymentId||'';
      const target=paymentId?refundTargets(state.detailData).find(p=>p.id===paymentId):null;
      const remaining=target?target.remaining:s.remaining;
      const amountEl=$('#refundamount');
      const typed=((amountEl&&amountEl.value)||'').trim();
      const amountCents=typed?parseRefundCents(typed):remaining;
      const reasonEl=$('#refundreason');
      const reason=((reasonEl&&reasonEl.value)||'').trim();
      if(!remaining){toast('Nothing left to refund','error');break;}
      if(amountCents===null){toast('Enter an amount like 25 or 25.50','error');if(amountEl)amountEl.focus();break;}
      if(amountCents>remaining){toast('That is more than the '+money({amount:remaining,currency:s.currency})+' left to refund','error');if(amountEl)amountEl.focus();break;}
      if(!reason){toast('Give a reason first — it is saved against the refund','error');if(reasonEl)reasonEl.focus();break;}
```

Then delete the later `const willFire=…` line (now declared above), and change the dialog text and the non-founder success branch to:

```js
      const ask=willFire
        ?`Refund ${amountLabel} now?\n\nThis sends the money back through PayHere immediately. There is no undo.`
        :`Request a refund of ${amountLabel}?\n\nA founder has to approve it before any money moves.`;
```

```js
        clearInput(reasonEl);clearInput(amountEl);
        if(!willFire){await reloadRefundDetail(id);toast('Refund requested — waiting for a founder');break;}
```

Keep the "One press, one refund (owner, 2026-08-08)" comment and everything from `refundBusy.add(busyKey)` on unchanged.

- [ ] **Step 10: Update the tests that pin the old rule.**

`web-tests/unit/ops-refund-one-click.test.js` — the test `'promises a refund only to operators who can actually move money'` becomes:

```js
  it('promises a refund only to operators who can actually move money', () => {
    expect(html).toMatch(/const verb=founder\?'Refund':'Request refund'/);
    expect(html).toMatch(/const founder=!!\(state\.caps&&state\.caps\.includes\('payments:reverse'\)\)/);
  });
```

`web-tests/e2e/ops-refund-workflow.spec.js` — the test `'ops may reverse a far-off trip, but still cannot read the refund ledger'` (and its comment) becomes:

```js
// Since 2026-10-17 ops reads the ledger (to see its own requests waiting) and may still cancel a
// far-off trip; only a founder moves money.
test('ops may cancel a far-off trip, and reads the refund ledger', async ({ page }) => {
  const store = { refunds: [] };
  await boot(page, { role: 'ops', store });
  await expect(page.locator('[data-act="cancelbooking"]')).toBeVisible();
  await expect(page.getByText('Refundable remaining')).toBeVisible();
  expect(store.refundReads).toBeGreaterThan(0);
  await expect(page.locator('[data-act="refundrequest"]')).toHaveText('Request refund');
});
```

and the test `'ops is locked out once the trip is inside 24 hours'` becomes:

```js
test('inside 24 hours ops cannot cancel, but may still request a refund', async ({ page }) => {
  const store = { refunds: [] };
  const today = new Date().toISOString().slice(0, 10);
  await boot(page, { role: 'ops', store, travelDate: today });
  await expect(page.locator('[data-act="cancelbooking"]')).toHaveCount(0);
  await expect(page.getByText('only a founder can cancel from here')).toBeVisible();
  await expect(page.locator('#cancelreason')).toHaveCount(0);
  await expect(page.locator('#refundreason')).toBeVisible();
});
```

`web-tests/e2e/ops-cancel-refund.spec.js` — the test `'an OPS agent is locked out inside the last 24 hours, and told why'` becomes:

```js
test('an OPS agent cannot cancel inside the last 24 hours, and is told why', async ({ page }) => {
  await boot(page, { caps: OPS, travelDate: iso(Date.now() + 0.5 * DAY) });
  await expect(page.locator('[data-act="cancelbooking"]')).toHaveCount(0);
  await expect(page.locator('#sheet')).toContainText('only a founder can cancel from here');
  await expect(page.locator('#cancelreason')).toHaveCount(0);
  // Refund REQUESTS are not held to the window (2026-10-17): a founder approves every one.
  await expect(page.locator('[data-act="refundrequest"]')).toBeVisible();
});
```

and its file header comment's sentence "the refund is always the full remainder — our PayHere setup cannot do partials, so an amount box would only invite records the gateway can't honour" becomes "refunds take an amount (since 2026-10-17) and an ops request waits for a founder's approval; the 24-hour rule now guards Cancel only".

- [ ] **Step 11: Run this task's web tests, and save the output**

```bash
(cd web-tests && npx vitest run unit/ops-refund-amount.test.js unit/ops-refund-one-click.test.js && npx playwright test e2e/ops-refund-approval.spec.js e2e/ops-refund-workflow.spec.js e2e/ops-cancel-refund.spec.js) > "$EVIDENCE/task5-green.txt" 2>&1; echo "exit=$?"
```

Expected: `exit=0`. Any other assertion that matched the old `Refund $X` button text: update it to `Refund` / `Request refund` and name it in the commit message.

- [ ] **Step 12: Eyeball it** — start the preview from `.claude/launch.json`, open the e2e fixture page or an existing paid booking as ops and as founder, and check the amount + reason fields at desktop and 390px width. `/ops` is cached: reload with `?cb=<n>`. The local preview cannot price, so don't create bookings there.

- [ ] **Step 13: Gate and commit**

```bash
(cd api && npm run check); echo "api exit=$?"
npm --prefix "$PWD/web-tests" run test:all; echo "web exit=$?"
git add api/src/routes/ops-ui.html web-tests/unit/ops-refund-amount.test.js web-tests/unit/ops-refund-one-click.test.js web-tests/e2e/ops-refund-approval.spec.js web-tests/e2e/ops-refund-workflow.spec.js web-tests/e2e/ops-cancel-refund.spec.js
git commit -m "feat(ops-ui): refund requests take an amount; ops may request, unblocked by the 24h rule

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Ops UI — the waiting row: full/partial line, Late tag, ops may withdraw

**Files:**
- Modify: `api/src/routes/ops-ui.html` — `refundHtmlFor` (row map), the `refundcancel` click handler
- Test: `web-tests/e2e/ops-refund-approval.spec.js` (append)

**Interfaces:**
- Consumes: `refundIsLate(t, r)` (Task 5), `refundSummary(d).captured`, the e2e `baseRow`/`boot`/`openSheet` (Task 5), `REFUND_LABEL.cancelled === 'Cancelled'`.
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing e2e** — append to `web-tests/e2e/ops-refund-approval.spec.js`:

```js
test('ops sees its request waiting for a founder, partial, and may withdraw it', async ({ page }) => {
  const store = { refunds: [] };
  page.on('dialog', (d) => d.accept());
  await boot(page, { role: 'ops', store });
  await openSheet(page);
  await page.locator('#refundamount').fill('25.50');
  await page.locator('#refundreason').fill('Customer dropped the Kandy leg');
  await page.locator('[data-act="refundrequest"]').dispatchEvent('click');
  const row = page.locator('.refund-row');
  await expect(row).toContainText('Partial — $25.50 of $100 paid');
  await expect(row).toContainText('Waiting for a founder to approve');
  await expect(row).not.toContainText('Late');
  await row.locator('[data-act="refundcancel"]').dispatchEvent('click');
  await expect(row).toContainText('Cancelled');
  expect(store.cancelled).toBe(1);
});

test('a request inside the last 24 hours is flagged Late, and an empty amount is a full refund', async ({ page }) => {
  const today = new Date().toISOString().slice(0, 10);
  const store = { refunds: [], requestedAt: new Date().toISOString() };
  page.on('dialog', (d) => d.accept());
  await boot(page, { role: 'ops', store, row: { ...baseRow, travelDate: today, travelTime: '23:59' } });
  await openSheet(page);
  await page.locator('#refundreason').fill('Flight cancelled');
  await page.locator('[data-act="refundrequest"]').dispatchEvent('click');
  const row = page.locator('.refund-row');
  await expect(row).toContainText('Late — trip starts in under 24h');
  await expect(row).toContainText('Full refund');
  expect(store.posts[0].amountCents).toBe(10000);
});
```

- [ ] **Step 2: Run them to see them fail, and save the output**

```bash
(cd web-tests && npx playwright test e2e/ops-refund-approval.spec.js -g "waiting for a founder, partial|flagged Late") > "$EVIDENCE/task6-red.txt" 2>&1; echo "exit=$?"
```

Expected: `exit=1` — no scope line, no waiting text, no cancel button for ops, no Late tag.

- [ ] **Step 3: Implement in `refundHtmlFor`.** After `const mayFire=state.caps.includes('payments:reverse');` add:

```js
  const mayRequest=state.caps.includes('bookings:operate');
```

Inside the `rows` map, after the `stuck` constant, add:

```js
    /* Full or partial at a glance (spec 2026-10-17 §5): an empty amount box means "everything",
       and a founder approving quickly must see which one this is. */
    const scope=r.status==='manual_pending'
      ?`<p class="refund-meta">${r.amountCents>=s.captured?'Full refund':`Partial — ${money({amount:r.amountCents,currency:r.currency})} of ${money({amount:s.captured,currency:s.currency})} paid`}</p>`:'';
    /* Display only: the driver may already be committed (spec §3). */
    const late=r.status==='manual_pending'&&refundIsLate(t,r)?'<p class="refund-warning">Late — trip starts in under 24h</p>':'';
    /* Ops filed it (or can see it) but cannot move money: say who acts next, and let them withdraw it. */
    const waiting=r.status==='manual_pending'&&!mayFire&&mayRequest?`
      <p class="refund-meta">Waiting for a founder to approve</p>
      <div class="refund-confirm"><button class="btn btn-noshow" data-act="refundcancel" data-id="${esc(t.id)}" data-refund-id="${esc(r.id)}">Cancel request</button></div>`:'';
```

and the row template's last line becomes:

```js
      ${why}${stuck}${scope}${late}${pendingActions}${waiting}</div>`;
```

- [ ] **Step 4: Let ops withdraw a request** — the `refundcancel` handler's first line becomes:

```js
      if(!state.caps||!state.caps.includes('bookings:operate'))break; // releases a reservation; moves no money
```

- [ ] **Step 5: Run the refund e2e set, and save the output**

```bash
(cd web-tests && npx playwright test e2e/ops-refund-approval.spec.js e2e/ops-refund-workflow.spec.js e2e/ops-cancel-refund.spec.js) > "$EVIDENCE/task6-green.txt" 2>&1; echo "exit=$?"
```

Expected: `exit=0`.

- [ ] **Step 6: Eyeball it** — as ops and as founder, a pending row shows the scope line and (on a same-day trip) the Late tag; founder rows keep their send/confirm controls. Check at 390px.

- [ ] **Step 7: Gate and commit**

```bash
(cd api && npm run check); echo "api exit=$?"
npm --prefix "$PWD/web-tests" run test:all; echo "web exit=$?"
git add api/src/routes/ops-ui.html web-tests/e2e/ops-refund-approval.spec.js
git commit -m "feat(ops-ui): waiting refund rows say full or partial, flag late requests, let ops withdraw

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Ops UI — the founder's "Refunds waiting" chip

**Files:**
- Modify: `api/src/routes/ops-ui.html` — `rowToTicket`, `reason`, `GROUPS`, `inGroup`, the nav badge in `setNav`, the chip render in `viewTickets`
- Test: `web-tests/e2e/ops-refund-approval.spec.js` (append)

**Interfaces:**
- Consumes: `OpsBookingRow.refundWaitingCents` (Task 4); e2e `baseRow`/`boot` (Task 5).
- Produces: ticket field `t.refundWaiting` (cents); group id `'refunds'`; `const isFounderUi=()=>…`.

- [ ] **Step 1: Write the failing e2e** — append to `web-tests/e2e/ops-refund-approval.spec.js`:

```js
test('a founder sees Refunds waiting, including a cancelled booking', async ({ page }) => {
  const waitingRow = { ...baseRow, stage: 'cancelled', refundWaitingCents: 5000 };
  await boot(page, { role: 'founder', store: { refunds: [] }, row: waitingRow });
  const chip = page.locator('.fchip[data-g="refunds"]');
  await expect(chip).toContainText('Refunds waiting');
  await expect(chip.locator('.fc')).toHaveText('1');
  await expect(page.locator('#nav-attn')).toHaveText('1');
  await chip.dispatchEvent('click');
  await expect(page.locator('[data-act="open"][data-id="booking-1"]')).toBeVisible();
  await expect(page.locator('#view')).toContainText('Refund waiting for your approval');
});

test('ops gets no Refunds waiting chip', async ({ page }) => {
  await boot(page, { role: 'ops', store: { refunds: [] }, row: { ...baseRow, refundWaitingCents: 5000 } });
  await expect(page.locator('.fchip[data-g="refunds"]')).toHaveCount(0);
});
```

- [ ] **Step 2: Run them to see them fail, and save the output**

```bash
(cd web-tests && npx playwright test e2e/ops-refund-approval.spec.js -g "Refunds waiting") > "$EVIDENCE/task7-red.txt" 2>&1; echo "exit=$?"
```

Expected: `exit=1` — no `.fchip[data-g="refunds"]` for the founder. (The ops test already passes; that's fine.)

- [ ] **Step 3: Implement.**

`rowToTicket` — after `created:row.createdAt||null, serviceType:row.serviceType||null,` add:

```js
    /* Σ refund requests waiting for a founder (spec 2026-10-17 §4). */
    refundWaiting:row.refundWaitingCents||0,
```

Just above `const reason=t=>{` add:

```js
/* Founder = may move money. The "Refunds waiting" pile is theirs alone. */
const isFounderUi=()=>!!(state.caps&&state.caps.includes('payments:reverse'));
```

In `reason`, directly after `if(t.source==='ride_board')return '';` and BEFORE `if(CLOSED.includes(t.stage))return '';`:

```js
  /* Before the closed-stage return on purpose: cancel-then-refund is the common case, and a
     cancelled booking with money waiting to go back is exactly what a founder must act on. */
  if(t.refundWaiting>0&&isFounderUi())return 'Refund waiting for your approval';
```

`GROUPS` — after the `all` entry:

```js
  /* Founder only, and it includes closed bookings (spec 2026-10-17 §4). */
  {id:'refunds',label:'Refunds waiting',c:'#b4232c',founder:true},
```

`inGroup` — after the `if(g==='all')…` line:

```js
  if(g==='refunds')return t.refundWaiting>0;
```

Chip render in `viewTickets` — `GROUPS.map(g=>{` becomes `GROUPS.filter(g=>!g.founder||isFounderUi()).map(g=>{`.

Nav badge in `setNav` — the `const attn=…` line becomes:

```js
  /* A founder's badge also counts refunds waiting on them — including closed bookings, which
     "All open" leaves out. Each row counts once. */
  const attn=tickets.filter(t=>!t.test&&((inGroup(t,'all')&&isAttn(t))||(isFounderUi()&&inGroup(t,'refunds')))).length;
```

No other reader needs changing (checked on `origin/main` @ `1f5111be`): `GROUPS` is read only by the chip render, and `state.group` is set only by a chip click and never persisted, so an ops user can never land on `'refunds'`. Choosing the chip lists cancelled rows under the existing "Closed" section (`inQueue` → `inGroup`; `dayGroup` files closed stages as "Closed").

- [ ] **Step 4: Run the whole refund e2e set, and save the output**

```bash
(cd web-tests && npx playwright test e2e/ops-refund-approval.spec.js e2e/ops-refund-workflow.spec.js e2e/ops-cancel-refund.spec.js) > "$EVIDENCE/task7-green.txt" 2>&1; echo "exit=$?"
```

Expected: `exit=0`.

- [ ] **Step 5: Eyeball it** — founder view with one cancelled booking holding a pending refund: chip shows with count 1, the row's reason reads "Refund waiting for your approval", the nav badge includes it; ops view shows no chip. Check at 390px.

- [ ] **Step 6: Gate and commit**

```bash
(cd api && npm run check); echo "api exit=$?"
npm --prefix "$PWD/web-tests" run test:all; echo "web exit=$?"
git add api/src/routes/ops-ui.html web-tests/e2e/ops-refund-approval.spec.js
git commit -m "feat(ops-ui): founder's Refunds waiting chip in the bookings queue

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Full gate and PR

**Files:** none in the repo (writes `$EVIDENCE/pr-body.md`).

- [ ] **Step 1: Bring the branch up to date and rename it**

```bash
git fetch origin && git rebase origin/main
git branch -m docs/refund-approval-queue feat/refund-approval-queue
```

If `ops-ui.html` conflicts, resolve by hand keeping both sides; never `--theirs`.

- [ ] **Step 2: Run the full gate, and save the output**

```bash
(cd api && npm run check) > "$EVIDENCE/final-api.txt" 2>&1; echo "api exit=$?"
npm --prefix "$PWD/web-tests" run test:all > "$EVIDENCE/final-web.txt" 2>&1; echo "web exit=$?"
grep -n "postgresRefundRepo" "$EVIDENCE/final-api.txt"
```

Expected: `api exit=0` and `web exit=0`. The grep shows whether the Postgres refund test ran or was skipped.

- [ ] **Step 3: Write the PR body**

```bash
{
  echo '## What'
  echo 'Anyone on the ops team can now request a refund of **any amount**; only a founder can send it through PayHere or record a manual refund. Spec: `docs/superpowers/specs/2026-10-17-refund-approval-queue-design.md`.'
  echo
  echo '- **Server:** ledger read is `bookings:read`; request and cancel-request are `bookings:operate` with no 24-hour rule; execute and confirm are `payments:reverse` (founder only). Closes the gap where ops could send a refund of any amount through the API.'
  echo '- **Alert:** `refund_requested` to founders when someone else files a request, marked `(full)`/`(partial)` and `· LATE` inside the last day.'
  echo '- **Queue:** rows carry `refundWaitingCents` from one batched read; founders get a **Refunds waiting** chip (includes cancelled bookings) and badge count.'
  echo '- **Sheet:** amount field (empty = full remaining), ops request flow, full/partial line, Late tag, ops may withdraw a request; both refund-history reads keep only a list. Cancelling a booking keeps the 24-hour rule.'
  echo
  echo '**No migration, no pricing change, no config change.**'
  echo
  echo '## Release check (owner, before promoting to production)'
  echo 'PayHere repeat partial refunds are unverified (their docs are behind a bot check). Refund a small part of one real PayHere payment, then a second part, and confirm both in the PayHere dashboard. A refusal fails safely (`api_failed`, money freed).'
  echo
  echo '## Red → green, per task'
  for n in 1 2 3 4 5 6 7; do
    for kind in red green; do
      f="$EVIDENCE/task$n-$kind.txt"
      [ -f "$f" ] || continue
      echo "### Task $n — $kind"; echo '```'; tail -n 8 "$f"; echo '```'
    done
  done
  echo
  echo '## Final gate'
  echo '```'; tail -n 8 "$EVIDENCE/final-api.txt"; echo '---'; tail -n 8 "$EVIDENCE/final-web.txt"; echo '```'
  echo
  echo '🤖 Generated with [Claude Code](https://claude.com/claude-code)'
} > "$EVIDENCE/pr-body.md"
```

Read `pr-body.md` once before using it, and add one line under "Final gate" saying whether the Postgres tests ran or skipped (from Step 2's grep).

- [ ] **Step 4: Push and open the PR — only after the owner says go**

```bash
git push -u origin feat/refund-approval-queue
gh pr create --base main --title "feat(refunds): ops requests any refund, a founder approves" --body-file "$EVIDENCE/pr-body.md"
```

- [ ] **Step 5: Tell the owner** — merging to `main` ships to staging only. Before the `main → production` promotion, the owner does the PayHere repeat-partial check above.
