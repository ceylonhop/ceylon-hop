# Dateless booking capture — Phase 2: reminder emails + ops chase — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A paid single transfer still missing its pickup date **or** time gets up to two reminder emails (about 2 and 7 days after payment) with a WhatsApp button. Reminders stop when the details arrive or ops marks the customer contacted. After two reminders with no reply, the booking appears in the daily ops digest for a WhatsApp chase and stays open.

**Architecture:** A pure rule (`domain/detailsReminder.ts`) decides which reminder, if any, is due from plain facts. The existing scheduled tick (`runScheduledNotifications`) gathers those facts and sends through its own `dispatch`. That reuses the notification-log claim, the per-run send budget and dry run unchanged. The digest lists bookings due a chase. The ops sheet shows when each reminder went out.

**Tech Stack:** Node 20 · TypeScript strict · Hono · Zod · Vitest · Drizzle + Postgres · vanilla JS in `api/src/routes/ops-ui.html`.

**Spec:** `docs/superpowers/specs/2026-10-17-dateless-booking-capture-design.md` §5 (Phase 2), plus the owner decisions below.

## Prerequisite

**PR ceylonhop/ceylon-hop#1010 must be merged first**, then merge `main` into this branch before Task 3. #1010 adds `Payment.settledAt` (the reminder clock) and edits the same ops-ui rows. Check with `gh pr view 1010 --repo ceylonhop/ceylon-hop --json state`. If it isn't merged, stop.

## Owner decisions (2026-10-18)

- **No reply after two reminders:** ops chases on WhatsApp and the **booking stays open**. Nothing is refunded or cancelled automatically.
- **Refund and cancellation policy is unchanged.** Don't edit `cancellationPolicy()`, `terms.html`, or any refund copy.

## Global Constraints

- Single transfers only (`mode === 'single'`). Trips and shared rides never get these reminders.
- "Missing details" means no date **or** no time (`needsDetails`, fixed in Task 1).
- **Timing:**
  - Reminder 1 when payment settled at least **2 days** ago.
  - Reminder 2 when payment settled at least **7 days** ago **and** reminder 1 went out at least **3 days** earlier.
  - Never more than two.
- **Stop conditions:**
  - status is not `paid`/`confirmed`
  - details are complete
  - ops ticked **"Customer contacted · pickup confirmed"** (`ride_ops.customer_updated`)
  - a date is set and has already passed (Colombo)
  - the payment settled before the release epoch
- **Release safety:**
  - `DETAILS_REMINDER_EPOCH` is a code constant: the UTC midnight of the day the PR opens. The existing backlog of undated bookings is never emailed.
  - Run the tick's `?dryRun=1` on staging before promoting.
- **Sending:**
  - Reminders go through `dispatch` in `runScheduledNotifications`, so they share the run budget, the claim/release ledger and dry run.
  - A failed send releases its claim and is retried on a later tick.
- **This phase ships migration `0073_details_reminder_kinds`.** It only widens the `customer_communications` kind check. It applies on staging at merge and reaches prod only through the owner's promotion. Renumber it if `main` already has a 0073, and make its journal `when` larger than the previous entry's.
- Gate before every commit: `cd api && npm run check` with `DATABASE_URL_TEST` set to a **local** test DB (never `api/.env`), plus `npm --prefix <abs>/web-tests run test:all`.
- Work in a worktree; stage files by path.

---

## File map

| File | Change |
|---|---|
| `api/src/services/notifications.ts` (+ `.test.ts`) | `needsDetails` covers a missing time. `sendDetailsReminder()`. Tracking defaults for two kinds |
| `api/src/domain/detailsReminder.ts` (+ `.test.ts`) | **Create.** The pure "which reminder is due" rule |
| `api/src/adapters/email.ts`, `api/src/domain/trackingContract.ts` (+ `.test.ts`) | Kinds `details_reminder_1`, `details_reminder_2` |
| `api/src/db/notificationLogRepo.ts` | The same two kinds on `NotificationKind` |
| `api/drizzle/0073_details_reminder_kinds.sql`, `meta/_journal.json`, `api/src/db/schema.ts` | Widen the kind check |
| `api/src/db/detailsReminderMigration.test.ts` | **Create.** Migration test |
| `api/src/services/scheduler.ts` (+ `.test.ts`) | Optional `payments`/`rideOps` deps. The reminder branch. `detailsReminders` count |
| `api/src/routes/admin.ts` | Pass `payments`/`rideOps` to the scheduler and `notificationLog`/`rideOps` to the digest |
| `api/src/services/digest.ts` (+ `.test.ts`) | "Chase on WhatsApp" section |
| `api/src/routes/ops.ts`, `api/src/routes/ops-ui.html` | `reminders` in the booking detail. Activity lines |
| `api/src/routes/devEmails.ts` | Preview entries |

---

### Task 1: A missing time also counts as missing details

**Files:**
- Modify: `api/src/services/notifications.ts` (`needsDetails`, ~line 314)
- Test: `api/src/services/notifications.test.ts` (`describe('needsDetails')`)

**Why:** today `needsDetails` returns false once a date exists, so a booking with a date and no time gets no "we need your details" email (the webhook calls it at payment, `webhooks.ts:472`) and would get no reminders.

- [ ] **Step 1: Write the failing test**

In `describe('needsDetails', …)`, replace the first `it(...)` with:

```ts
  it('true for a single transfer missing its date or its time, false once both are set', () => {
    expect(needsDetails(single)).toBe(true); // fixture has neither
    expect(needsDetails({ ...single, input: { ...single.input, date: '2026-08-01' } } as Booking)).toBe(true); // no time
    expect(needsDetails({ ...single, input: { ...single.input, time: '09:00' } } as Booking)).toBe(true); // no date
    expect(needsDetails({ ...single, input: { ...single.input, date: '2026-08-01', time: '09:00' } } as Booking)).toBe(false);
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd api && npx vitest run src/services/notifications.test.ts -t needsDetails`
Expected: FAIL, because a date-only booking returns `false`.

- [ ] **Step 3: Implement**

```ts
// True when a paid booking still has an open detail we must confirm. A single transfer needs
// BOTH a date and a pickup time — "Decide later" can leave either blank (booking.js), and a
// driver can't be sent with only one. A trip needs at least one date. Shared rides always book
// a fixed departure.
export function needsDetails(booking: Booking): boolean {
  if (booking.mode === 'shared') return false;
  if (booking.mode === 'trip') return !booking.input.dates?.some(Boolean);
  return !booking.input.date || !booking.input.time;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd api && npx vitest run src/services/notifications.test.ts src/routes/webhooks*.test.ts`
Expected: PASS. If a webhook test asserted that a dated, time-less booking gets **no** details email, it was pinning the bug; update that expectation and say so in the PR.

- [ ] **Step 5: Commit**

```bash
git add api/src/services/notifications.ts api/src/services/notifications.test.ts
git commit -m "fix(notifications): a missing pickup time also needs the customer's details"
```

---

### Task 2: The reminder rule

**Files:**
- Create: `api/src/domain/detailsReminder.ts`
- Test: `api/src/domain/detailsReminder.test.ts`

**Interfaces — produces:**
- `DETAILS_REMINDER_KINDS = ['details_reminder_1', 'details_reminder_2'] as const` and `type DetailsReminderKind`
- `DETAILS_REMINDER_EPOCH: Date`
- `interface DetailsReminderFacts { missing: boolean; active: boolean; datePassed: boolean; paused: boolean; paidAt: Date | null; firstSentAt: Date | null; secondSentAt: Date | null }`
- `detailsReminderDue(f: DetailsReminderFacts, now: Date, epoch?: Date): DetailsReminderKind | null`

- [ ] **Step 1: Write the failing test**

```ts
// api/src/domain/detailsReminder.test.ts
import { describe, it, expect } from 'vitest';
import { detailsReminderDue, type DetailsReminderFacts } from './detailsReminder';

const DAY = 24 * 3600_000;
const EPOCH = new Date('2026-10-01T00:00:00Z');
const NOW = new Date('2026-10-20T10:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

const base: DetailsReminderFacts = {
  missing: true, active: true, datePassed: false, paused: false,
  paidAt: ago(3), firstSentAt: null, secondSentAt: null,
};
const due = (over: Partial<DetailsReminderFacts>) => detailsReminderDue({ ...base, ...over }, NOW, EPOCH);

describe('detailsReminderDue', () => {
  it('sends the first reminder two days after payment, not before', () => {
    expect(due({ paidAt: ago(1.9) })).toBeNull();
    expect(due({ paidAt: ago(2) })).toBe('details_reminder_1');
  });

  it('sends the second at seven days, only three days after the first', () => {
    expect(due({ paidAt: ago(6.9), firstSentAt: ago(4) })).toBeNull();
    expect(due({ paidAt: ago(7), firstSentAt: ago(5) })).toBe('details_reminder_2');
    // A tick outage: first went out yesterday although payment was 9 days ago — wait.
    expect(due({ paidAt: ago(9), firstSentAt: ago(1) })).toBeNull();
  });

  it('never sends a third', () => {
    expect(due({ paidAt: ago(30), firstSentAt: ago(25), secondSentAt: ago(20) })).toBeNull();
  });

  it('stays quiet once the details are in, the booking is closed, the date passed, or ops paused it', () => {
    expect(due({ missing: false })).toBeNull();
    expect(due({ active: false })).toBeNull();
    expect(due({ datePassed: true })).toBeNull();
    expect(due({ paused: true })).toBeNull();
  });

  it('never reminds about a payment from before the release, or one with no settle time', () => {
    expect(due({ paidAt: new Date('2026-09-30T23:59:00Z') })).toBeNull();
    expect(due({ paidAt: null })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd api && npx vitest run src/domain/detailsReminder.test.ts`
Expected: FAIL, with "Cannot find module './detailsReminder'".

- [ ] **Step 3: Implement**

Set `DETAILS_REMINDER_EPOCH` to **UTC midnight of the day you open the PR** (e.g. `2026-10-21T00:00:00Z`).

```ts
// api/src/domain/detailsReminder.ts

// "We still need your pickup date/time" reminders (spec 2026-10-17 §5, Phase 2). A paid single
// transfer booked with "Decide later" gets at most two, then ops chases on WhatsApp (owner
// 2026-10-18: the booking stays open, no auto refund or cancel). Pure: the scheduler gathers the
// facts, this decides.
export const DETAILS_REMINDER_KINDS = ['details_reminder_1', 'details_reminder_2'] as const;
export type DetailsReminderKind = (typeof DETAILS_REMINDER_KINDS)[number];

// Payments settled before this never get a reminder, so the release does not email the
// backlog that was already sitting in "No date yet". UTC midnight of the release PR's day.
export const DETAILS_REMINDER_EPOCH = new Date('2026-10-21T00:00:00Z');

const DAY_MS = 24 * 3600_000;
const FIRST_AFTER_MS = 2 * DAY_MS;
const SECOND_AFTER_MS = 7 * DAY_MS;
// The second never follows the first closely, even when a tick outage makes both look due.
const MIN_GAP_MS = 3 * DAY_MS;

export interface DetailsReminderFacts {
  missing: boolean; // needsDetails(): no date or no time
  active: boolean; // status paid or confirmed
  datePassed: boolean; // a date is set and is before today in Colombo — nothing left to ask
  paused: boolean; // ops ticked "Customer contacted · pickup confirmed"
  paidAt: Date | null; // earliest succeeded payment's settledAt
  firstSentAt: Date | null;
  secondSentAt: Date | null;
}

export function detailsReminderDue(
  f: DetailsReminderFacts,
  now: Date,
  epoch: Date = DETAILS_REMINDER_EPOCH,
): DetailsReminderKind | null {
  if (!f.missing || !f.active || f.datePassed || f.paused || !f.paidAt) return null;
  if (f.paidAt.getTime() < epoch.getTime()) return null;
  const sincePaid = now.getTime() - f.paidAt.getTime();
  if (!f.firstSentAt) return sincePaid >= FIRST_AFTER_MS ? 'details_reminder_1' : null;
  if (f.secondSentAt || sincePaid < SECOND_AFTER_MS) return null;
  return now.getTime() - f.firstSentAt.getTime() >= MIN_GAP_MS ? 'details_reminder_2' : null;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd api && npx vitest run src/domain/detailsReminder.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add api/src/domain/detailsReminder.ts api/src/domain/detailsReminder.test.ts
git commit -m "feat(reminders): the rule for when a details reminder is due"
```

---

### Task 3: The reminder email and its kinds (migration 0073)

Merge `main` into this branch first, so #1010 is in (see Prerequisite).

**Files:**
- Modify:
  - `api/src/adapters/email.ts` (`CustomerCommunicationKind`)
  - `api/src/domain/trackingContract.ts` and `.test.ts`
  - `api/src/db/notificationLogRepo.ts` (`NotificationKind`)
  - `api/src/services/notifications.ts` (`trackingDefaults` and a new `sendDetailsReminder`, after `sendDetailsNeeded`)
  - `api/src/routes/devEmails.ts`
- Create: `api/drizzle/0073_details_reminder_kinds.sql`. Modify: `api/drizzle/meta/_journal.json` and `api/src/db/schema.ts` (kind check)
- Test: `api/src/services/notifications.test.ts`, `api/src/db/detailsReminderMigration.test.ts`

**Interfaces — produces:** `sendDetailsReminder(booking: Booking, email: EmailAdapter, opts: { nth: 1 | 2; manage?: string }): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Add `sendDetailsReminder` to the `./notifications` import in `notifications.test.ts`, then append:

```ts
describe('sendDetailsReminder — still need the pickup date/time', () => {
  it('asks on WhatsApp with the reference already typed, and says to ignore it if they already told us', async () => {
    const email = new FakeEmailAdapter();
    await sendDetailsReminder(single, email, { nth: 1, manage: 'https://ceylonhop.com/manage.html?t=abc' });
    const m = email.sent[0];
    expect(m.subject).toBe('Reminder: your pickup date and time — CH-ABC12');
    expect(m.html).toContain('wa.me/94779669662?text=');
    expect(m.html).toContain(encodeURIComponent('CH-ABC12'));
    expect(m.html.toLowerCase()).toContain('already told us');
    expect(m.text).not.toContain('<');
    expect(m.tracking?.kind).toBe('details_reminder_1');
  });

  it('names only what is missing', async () => {
    const email = new FakeEmailAdapter();
    await sendDetailsReminder({ ...single, input: { ...single.input, date: '2026-11-04' } } as Booking, email, { nth: 2 });
    expect(email.sent[0].html).toContain('pickup time');
    expect(email.sent[0].html).not.toContain('pickup date and time');
    expect(email.sent[0].tracking?.kind).toBe('details_reminder_2');
  });
});
```

Add `'details_reminder_1', 'details_reminder_2',` after `'schedule_set',` in the expected list in `trackingContract.test.ts`.

```ts
// api/src/db/detailsReminderMigration.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const TAG = '0073_details_reminder_kinds';
const migration = readFileSync(new URL(`../../drizzle/${TAG}.sql`, import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};
const sql = migration.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

describe(TAG, () => {
  it('keeps every existing email kind and adds the two reminders', () => {
    for (const k of ['confirmation', 'details_needed', 'booking_confirmed', 'cancellation', 'refund', 'no_show_notice',
      'trip_reminder', 'review_request', 'payment_recovery', 'payment_failed', 'deposit_received', 'balance_received',
      'schedule_set', 'details_reminder_1', 'details_reminder_2']) {
      expect(sql).toContain(`'${k}'`);
    }
  });
  it('changes no rows and drops no table', () => {
    expect(sql).not.toMatch(/\b(insert\s+into|delete\s+from|drop\s+table)\b/i);
    expect(sql).not.toMatch(/\bupdate\s+\w+\s+set\b/i);
  });
  it('is journalled after every earlier entry', () => {
    const i = journal.entries.findIndex((e) => e.tag === TAG);
    expect(i).toBeGreaterThan(0);
    expect(journal.entries[i].when).toBeGreaterThan(journal.entries[i - 1].when);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd api && npx vitest run src/services/notifications.test.ts src/domain/trackingContract.test.ts src/db/detailsReminderMigration.test.ts`
Expected: FAIL: `sendDetailsReminder is not a function`, the contract list mismatches, and ENOENT for 0073.

- [ ] **Step 3: Write the migration**

```sql
-- api/drizzle/0073_details_reminder_kinds.sql
-- Dateless booking capture, Phase 2 (plan 2026-10-18). Hand-written: drizzle-kit generate needs a TTY.
-- The two "we still need your pickup date/time" reminders get their own kinds, so each send has its
-- own tracking key (`bookingId:kind`). Widens the check only; changes no rows. Rollback: restore the
-- previous list after deleting any rows of these two kinds.
ALTER TABLE "customer_communications" DROP CONSTRAINT IF EXISTS "customer_communications_kind_valid";
--> statement-breakpoint
ALTER TABLE "customer_communications" ADD CONSTRAINT "customer_communications_kind_valid" CHECK ("kind" in ('confirmation', 'details_needed', 'booking_confirmed', 'cancellation', 'refund', 'no_show_notice', 'trip_reminder', 'review_request', 'payment_recovery', 'payment_failed', 'deposit_received', 'balance_received', 'schedule_set', 'details_reminder_1', 'details_reminder_2'));
```

Append to `_journal.json` (keep the comma on the 0072 entry):

```json
    {
      "idx": 73,
      "version": "7",
      "when": 1792108800000,
      "tag": "0073_details_reminder_kinds",
      "breakpoints": true
    }
```

In `schema.ts`'s `customer_communications_kind_valid` check, change `'schedule_set')` to `'schedule_set', 'details_reminder_1', 'details_reminder_2')`.

- [ ] **Step 4: Register the kinds**

- `email.ts`: change `| 'schedule_set';` to `| 'schedule_set'\n  | 'details_reminder_1'\n  | 'details_reminder_2';`
- `trackingContract.ts`: add `'details_reminder_1',` and `'details_reminder_2',` after `'schedule_set',`
- `notificationLogRepo.ts`: change `| 'no_show_notice';` to `| 'no_show_notice'\n  | 'details_reminder_1'\n  | 'details_reminder_2';`
- `notifications.ts`, in `trackingDefaults` after `schedule_set`:

```ts
  details_reminder_1: { templateKey: 'booking-details-reminder', source: 'scheduled_job', actorType: 'scheduler' },
  details_reminder_2: { templateKey: 'booking-details-reminder', source: 'scheduled_job', actorType: 'scheduler' },
```

- [ ] **Step 5: Implement the email**

In `notifications.ts`, after `sendDetailsNeeded`:

```ts
// ── Reminder: we still need the pickup date/time (Phase 2, plan 2026-10-18) ─
// Sent by the scheduled tick at ~2 and ~7 days after payment while a single transfer is still
// missing its date or time. WhatsApp is the ask — the reference is already typed, so replying is
// one tap. Says plainly to ignore it if they already told us: ops may not have entered it yet.
export async function sendDetailsReminder(
  booking: Booking,
  email: EmailAdapter,
  opts: { nth: 1 | 2; manage?: string },
): Promise<void> {
  if (booking.mode !== 'single') return;
  const first = esc(booking.input.customer.firstName);
  const missing = !booking.input.date && !booking.input.time
    ? 'pickup date and time'
    : !booking.input.date ? 'pickup date' : 'pickup time';
  const msg = `Hi Ceylon Hop, for booking ${booking.reference} my ${missing} is: `;
  const ask: Cta = { ...CTA_WHATSAPP, href: `${WA_URL}?text=${encodeURIComponent(msg).replace(/'/g, '%27')}` };
  const html = page(
    brandHeader() +
      introBlock(
        'Reminder',
        AMBER,
        `What's your ${missing}, ${first}?`,
        `Your booking is paid and safe. We just need your ${missing} to book your driver.`,
      ) +
      ticketCard(booking, BADGE_ACTION) +
      infoBox(
        'Tell us on WhatsApp',
        `Tap below and send us your ${missing}. Already told us? You can ignore this email.`,
        undefined,
        ask,
      ) +
      (opts.manage ? manageButton(opts.manage) : '') +
      footer(),
  );
  const text = textShell(`what's your ${missing}?`, `Your booking is paid — we just need your ${missing}.`, booking, [
    ...factRows(booking).map(([k, v]) => `${k}: ${v}`),
    '',
    `Tell us on WhatsApp: ${ask.href}`,
    'Already told us? You can ignore this email.',
    ...(opts.manage ? ['', `View your booking: ${opts.manage}`] : []),
  ]);
  await email.send({
    to: booking.input.customer.email,
    subject: `Reminder: your ${missing} — ${booking.reference}`,
    html,
    text,
    tracking: emailTracking(booking, opts.nth === 1 ? 'details_reminder_1' : 'details_reminder_2'),
  });
}
```

In `devEmails.ts`, add `sendDetailsReminder` to the notifications import, and add after the `schedule-set` entry:

```ts
  { name: 'details-reminder-1', label: 'Reminder 1: still need date/time', run: (b, e) => sendDetailsReminder(b, e, { nth: 1, manage: LINKS.manage }) },
  { name: 'details-reminder-2', label: 'Reminder 2: still need date/time', run: (b, e) => sendDetailsReminder(b, e, { nth: 2, manage: LINKS.manage }) },
```

- [ ] **Step 6: Run them and watch them pass, then run the gate**

Run: `cd api && npx vitest run src/services/notifications.test.ts src/domain/trackingContract.test.ts src/db/detailsReminderMigration.test.ts`
Expected: PASS.
Then `cd api && npm run check` (with `DATABASE_URL_TEST`): exit 0.

- [ ] **Step 7: Commit**

```bash
git add api/drizzle/0073_details_reminder_kinds.sql api/drizzle/meta/_journal.json api/src/db/schema.ts api/src/db/detailsReminderMigration.test.ts api/src/adapters/email.ts api/src/domain/trackingContract.ts api/src/domain/trackingContract.test.ts api/src/db/notificationLogRepo.ts api/src/services/notifications.ts api/src/services/notifications.test.ts api/src/routes/devEmails.ts
git commit -m "feat(reminders): 'still need your pickup date/time' email (migration 0073)"
```

---

### Task 4: Send the reminders from the scheduled tick

**Files:**
- Modify: `api/src/services/scheduler.ts` (imports; `runScheduledNotifications` deps, the loop and the return value)
- Modify: `api/src/routes/admin.ts` (both `runScheduledNotifications` calls in `POST /jobs/notifications`)
- Test: `api/src/services/scheduler.test.ts`

**Interfaces:**
- Consumes: `detailsReminderDue` (Task 2), `sendDetailsReminder` and `needsDetails` (Tasks 1 and 3), `Payment.settledAt` (from #1010).
- Produces: `runScheduledNotifications` deps gain `payments?: { findByBookingId(id: string): Promise<Array<{ status: string; settledAt: Date | null }>> }` and `rideOps?: { get(id: string): Promise<{ customerUpdated: boolean } | null> }`. The result gains `detailsReminders: number`.

- [ ] **Step 1: Write the failing test**

Append to `scheduler.test.ts`:

```ts
describe('details reminders (dateless capture Phase 2)', () => {
  const EPOCH = new Date('2026-06-01T00:00:00Z');
  const at = (days: number) => new Date(NOW.getTime() - days * 24 * 3600_000);

  async function undatedPaid(bookings: InMemoryBookingRepo) {
    const b = await bookings.create({
      mode: 'single',
      input: { from: 'Colombo Airport', to: 'Ella', vehicleType: 'car', adults: 1, children: 0, bags: 0, customer },
      total: 5000, amountDueNow: 5000, currency: 'USD',
    });
    await bookings.setStatus(b.id, 'payment_pending');
    await bookings.setStatus(b.id, 'paid');
    return b;
  }

  function deps(bookings: InMemoryBookingRepo, log: InMemoryNotificationLogRepo, email: FakeEmailAdapter, paidDaysAgo: number, paused = false) {
    return {
      bookings, log, email, baseUrl: 'https://ceylonhop.com', linkSecret: 's',
      payments: { findByBookingId: async () => [{ status: 'succeeded', settledAt: at(paidDaysAgo) }] },
      rideOps: { get: async () => ({ customerUpdated: paused }) },
      detailsReminderEpoch: EPOCH,
    };
  }

  it('sends reminder 1 at two days, once, and nothing to a booking with full details', async () => {
    const bookings = new InMemoryBookingRepo();
    const log = new InMemoryNotificationLogRepo();
    const email = new FakeEmailAdapter();
    const b = await undatedPaid(bookings);
    await paidSingle(bookings, '2026-07-10', '09:00'); // complete details: never reminded
    const r1 = await runScheduledNotifications(NOW, deps(bookings, log, email, 2));
    expect(r1.detailsReminders).toBe(1);
    expect(email.sent.map((m) => m.tracking?.kind)).toEqual(['details_reminder_1']);
    expect(await log.wasSent(b.id, 'details_reminder_1')).toBe(true);
    const r2 = await runScheduledNotifications(NOW, deps(bookings, log, email, 2));
    expect(r2.detailsReminders).toBe(0);
  });

  it('stays quiet while ops has marked the customer contacted', async () => {
    const bookings = new InMemoryBookingRepo();
    const log = new InMemoryNotificationLogRepo();
    const email = new FakeEmailAdapter();
    await undatedPaid(bookings);
    const r = await runScheduledNotifications(NOW, deps(bookings, log, email, 3, true));
    expect(r.detailsReminders).toBe(0);
    expect(email.sent).toHaveLength(0);
  });

  it('plans but does not send on a dry run', async () => {
    const bookings = new InMemoryBookingRepo();
    const log = new InMemoryNotificationLogRepo();
    const email = new FakeEmailAdapter();
    const b = await undatedPaid(bookings);
    const r = await runScheduledNotifications(NOW, { ...deps(bookings, log, email, 3), dryRun: true });
    expect(r.plan).toEqual([{ reference: b.reference, kind: 'details_reminder_1' }]);
    expect(email.sent).toHaveLength(0);
  });

  it('does nothing without the payments dep (callers that have not opted in)', async () => {
    const bookings = new InMemoryBookingRepo();
    const log = new InMemoryNotificationLogRepo();
    const email = new FakeEmailAdapter();
    await undatedPaid(bookings);
    const r = await runScheduledNotifications(NOW, { bookings, log, email, baseUrl: 'x', linkSecret: 's' });
    expect(r.detailsReminders).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd api && npx vitest run src/services/scheduler.test.ts -t "details reminders"`
Expected: FAIL. `r1.detailsReminders` is `undefined`, and typecheck rejects the unknown deps.

- [ ] **Step 3: Implement in `scheduler.ts`**

Imports:

```ts
import { sendTripReminder, sendReviewRequest, sendDetailsReminder, needsDetails, manageUrl } from './notifications';
import { detailsReminderDue, DETAILS_REMINDER_EPOCH } from '../domain/detailsReminder';
import { isoToday } from '../domain/dateRules';
```

Add to the `deps` type of `runScheduledNotifications`:

```ts
    // Dateless capture Phase 2: both are needed to send details reminders; without them the
    // tick behaves exactly as before. payments gives the settle time (the reminder clock),
    // rideOps the "Customer contacted · pickup confirmed" pause.
    payments?: { findByBookingId(id: string): Promise<Array<{ status: string; settledAt: Date | null }>> };
    rideOps?: { get(id: string): Promise<{ customerUpdated: boolean } | null> };
    // Test seam; production uses the code constant.
    detailsReminderEpoch?: Date;
```

Change the return type to `Promise<{ reminders: number; reviews: number; detailsReminders: number; plan?: PlannedSend[] }>`, and add `let detailsReminders = 0;` next to `let reviews = 0;`.

Inside the `for (const b of all)` loop, **after** the `epoch` check and **before** `const { start, end } = tripWindow(b);`:

```ts
    // Details reminders run BEFORE the trip-window guard below, which skips every undated
    // booking. Single transfers only; the rule itself lives in domain/detailsReminder.ts.
    if (deps.payments && deps.rideOps && b.mode === 'single' && needsDetails(b)) {
      const succeeded = (await deps.payments.findByBookingId(b.id))
        .filter((p) => p.status === 'succeeded' && p.settledAt)
        .map((p) => p.settledAt!.getTime());
      const sentAt = new Map((await log.listByBookingId(b.id)).map((r) => [r.kind, r.sentAt]));
      const kind = detailsReminderDue(
        {
          missing: true,
          active: b.status === 'paid' || b.status === 'confirmed',
          datePassed: !!b.input.date && b.input.date < isoToday('Asia/Colombo', now),
          paused: (await deps.rideOps.get(b.id))?.customerUpdated ?? false,
          paidAt: succeeded.length ? new Date(Math.min(...succeeded)) : null,
          firstSentAt: sentAt.get('details_reminder_1') ?? null,
          secondSentAt: sentAt.get('details_reminder_2') ?? null,
        },
        now,
        deps.detailsReminderEpoch ?? DETAILS_REMINDER_EPOCH,
      );
      if (kind && await dispatch(b, kind, () => sendDetailsReminder(b, email, {
        nth: kind === 'details_reminder_1' ? 1 : 2, manage: manageUrl(b, baseUrl, linkSecret),
      }))) {
        detailsReminders++;
      }
    }
```

Change the final `return` to `return { reminders, reviews, detailsReminders, ...(dryRun ? { plan } : {}) };`.

- [ ] **Step 4: Wire it in `admin.ts`**

In `POST /jobs/notifications`, add `payments: deps.payments, rideOps: deps.rideOps,` to **both** `runScheduledNotifications(...)` option objects, the dry run and the real one.

- [ ] **Step 5: Run it and watch it pass, then run the gate**

Run: `cd api && npx vitest run src/services/scheduler.test.ts src/routes/admin*.test.ts`
Expected: PASS. If an admin test snapshots the job's JSON response exactly, add `detailsReminders: 0` to it.
Then `cd api && npm run check` (with `DATABASE_URL_TEST`): exit 0.

- [ ] **Step 6: Commit**

```bash
git add api/src/services/scheduler.ts api/src/services/scheduler.test.ts api/src/routes/admin.ts
git commit -m "feat(reminders): send details reminders from the scheduled tick"
```

---

### Task 5: Ops sees the reminders, and the digest asks for a chase

**Files:**
- Modify: `api/src/services/digest.ts` and `api/src/routes/admin.ts` (the `buildDigest` call)
- Test: `api/src/services/digest.test.ts`
- Modify: `api/src/routes/ops.ts` (`GET /bookings/:id`) and `api/src/routes/ops-ui.html` (`buildActivity`)
- Test: `api/src/routes/ops.schedule.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `digest.test.ts`, reusing that file's existing imports and fixtures. Add `InMemoryNotificationLogRepo` to the imports if missing.

```ts
describe('chase on WhatsApp (dateless capture Phase 2)', () => {
  it('lists paid single transfers still missing details after both reminders, unless ops paused them', async () => {
    const bookings = new InMemoryBookingRepo();
    const log = new InMemoryNotificationLogRepo();
    const mk = async () => {
      const b = await bookings.create({
        mode: 'single', total: 5000, amountDueNow: 5000, currency: 'USD',
        input: { from: 'Colombo Airport', to: 'Ella', vehicleType: 'car', adults: 1, children: 0, bags: 0,
          customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'ES' } },
      });
      await bookings.setStatus(b.id, 'payment_pending');
      await bookings.setStatus(b.id, 'paid');
      return b;
    };
    const chase = await mk();
    const paused = await mk();
    const early = await mk();
    for (const b of [chase, paused]) await log.markSent(b.id, 'details_reminder_2');
    await log.markSent(early.id, 'details_reminder_1');
    const rideOps = { get: async (id: string) => ({ customerUpdated: id === paused.id }) };
    const d = await buildDigest(new Date(), { bookings, notificationLog: log, rideOps, opsBaseUrl: 'https://ops.example' });
    expect(d.text).toContain('Chase on WhatsApp (1)');
    expect(d.text).toContain(chase.reference);
    expect(d.text).not.toContain(paused.reference);
    expect(d.text).not.toContain(early.reference);
    expect(d.html).toContain(`/ops?booking=${chase.id}`);
  });
});
```

Append to `ops.schedule.test.ts` (it already has the app and a paid undated `bid`):

```ts
  it('shows which details reminders went out', async () => {
    const log = new InMemoryNotificationLogRepo();
    app = createApp({ bookings, rideOps, email, notificationLog: log, auth, adminApiKey: 'adminkey' });
    await log.markSent(bid, 'details_reminder_1');
    const detail = await (await app.request(`/admin/ops/bookings/${bid}`, { headers: await hdr() })).json();
    expect(detail.reminders.map((r: { kind: string }) => r.kind)).toEqual(['details_reminder_1']);
  });
```

Add `import { InMemoryNotificationLogRepo } from '../db/notificationLogRepo';` to that file. If `createApp` names the dep differently, use its name; check `AppDeps` in `app.ts`.

- [ ] **Step 2: Run them and watch them fail**

Run: `cd api && npx vitest run src/services/digest.test.ts src/routes/ops.schedule.test.ts`
Expected: FAIL. The digest has no chase section, and `detail.reminders` is undefined.

- [ ] **Step 3: Implement the digest section**

In `digest.ts`:
- Add `import { needsDetails } from './notifications';` and `import { bookingDeepLink } from './opsNotifications';`.
- Add `import type { NotificationLogRepo } from '../db/notificationLogRepo';`.
- Extend the `deps` type:

```ts
    // Dateless capture Phase 2: who to chase on WhatsApp. Both optional — absent, no section.
    notificationLog?: Pick<NotificationLogRepo, 'sentAmong'>;
    rideOps?: { get(id: string): Promise<{ customerUpdated: boolean } | null> };
```

After the `alertRows` block:

```ts
  // Both details reminders went out and the pickup date/time is still missing: ops chases on
  // WhatsApp, the booking stays open (owner 2026-10-18). Listed every day until it's in, unless
  // ops ticked "Customer contacted · pickup confirmed".
  let chase: typeof all = [];
  if (deps.notificationLog && deps.rideOps) {
    const open = all.filter((b) => b.mode === 'single' && (b.status === 'paid' || b.status === 'confirmed')
      && needsDetails(b) && !isTeamEmail(b.input.customer.email, team));
    const reminded = await deps.notificationLog.sentAmong(open.map((b) => b.id), ['details_reminder_2']);
    for (const b of open.filter((x) => reminded.has(x.id))) {
      if (!(await deps.rideOps.get(b.id))?.customerUpdated) chase.push(b);
    }
  }
  const chaseLine = (b: (typeof all)[number]) => `${b.reference} · ${b.input.customer.firstName} · ${b.input.customer.whatsapp}`;
```

In `textLines`, before the `Dashboard` line:

```ts
    ...(chase.length ? ['', `Chase on WhatsApp (${chase.length}) — paid, still no pickup date/time after 2 reminders:`, ...chase.map((b) => `  ${chaseLine(b)}`)] : []),
```

In the `html` array, before the dashboard link:

```ts
    chase.length
      ? `<h3 style="font-size:14px;margin:12px 0 8px">Chase on WhatsApp (${chase.length})</h3><p style="font-size:13px;color:#6b7280;margin:0 0 8px">Paid, still no pickup date/time after 2 reminders.</p>` +
        chase.map((b) => {
          const href = bookingDeepLink(b.id, deps.opsBaseUrl ?? '');
          const label = chaseLine(b).replace(/&/g, '&amp;').replace(/</g, '&lt;');
          return `<p style="font-size:14px;margin:0 0 6px">${href ? `<a href="${href}" style="color:#24758A">${label}</a>` : label}</p>`;
        }).join('')
      : '',
```

In `admin.ts`, add `notificationLog, rideOps: deps.rideOps` to the `buildDigest(...)` deps object.

- [ ] **Step 4: Implement the ops sheet lines**

In `ops.ts` `GET /bookings/:id`, before the `return c.json(...)`:

```ts
    // Which details reminders went out (dateless capture Phase 2). Best-effort like checkoutEvents.
    const reminders = deps.notificationLog
      ? (await deps.notificationLog.listByBookingId(b.id).catch(() => []))
          .filter((r) => r.kind === 'details_reminder_1' || r.kind === 'details_reminder_2')
      : [];
```

Then add `reminders` to the returned object.

In `ops-ui.html` `buildActivity`, next to the `scheduleEvents` line:

```js
  (d?.reminders||[]).forEach(r=>acts.push([fmtDateTime(r.sentAt),`Reminder ${r.kind==='details_reminder_1'?'1':'2'} sent · still need pickup date/time`]));
```

- [ ] **Step 5: Run them and watch them pass, then verify in the browser**

Run: `cd api && npx vitest run src/services/digest.test.ts src/routes/ops.schedule.test.ts src/routes/opsUi.test.ts`
Expected: PASS.

Browser check (local API on a **local test DB**, never `api/.env`, with dev login):
1. Seed an undated paid single transfer.
2. Insert its succeeded payment with `settled_at` 3 days ago and `created_at` after `DETAILS_REMINDER_EPOCH`. In the local DB only, you may set `DETAILS_REMINDER_EPOCH` back temporarily in a scratch copy; never commit that.
3. `POST /admin/jobs/notifications?dryRun=1`. It should plan `details_reminder_1` for that booking.
4. Run it for real, then open the sheet. Activity shows "Reminder 1 sent".
5. Open `/dev/emails`, then `details-reminder-1` for the `flexible` booking. It renders with the WhatsApp button.

- [ ] **Step 6: Run the full gate and commit**

Run:
- `cd api && npm run check` (with `DATABASE_URL_TEST`), expecting exit 0
- `npm --prefix <abs>/web-tests run test:all`, expecting exit 0

```bash
git add api/src/services/digest.ts api/src/services/digest.test.ts api/src/routes/admin.ts api/src/routes/ops.ts api/src/routes/ops-ui.html api/src/routes/ops.schedule.test.ts
git commit -m "feat(reminders): ops sees reminders sent; digest lists who to chase on WhatsApp"
```

---

### Task 6: PR and safe release

- [ ] Re-check that `main` has no `0073`, then merge `main` in.
- [ ] Push and open the PR. In the body, include:
  - red→green per task
  - both gate summaries
  - the browser check
  - **"Ships migration 0073_details_reminder_kinds (kind check widened only)."**
  - **"`DETAILS_REMINDER_EPOCH` = <date>: bookings paid before it are never emailed."**
- [ ] Bind the PR with the ccd_pr tools. Don't merge without the owner's go.
- [ ] **Before the owner promotes to prod:** after the merge reaches staging, run `POST /admin/jobs/notifications?dryRun=1` on staging. Paste the planned `details_reminder_*` sends into the PR or the promotion PR. Staging email is sandboxed (Resend allowlist).

## Not in this phase

- Customers adding the date themselves (Phase 4).
- A rough travel month at "Decide later", and flight numbers.
- Chauffeur trips.
- The refund/cancellation policy is **unchanged** by owner decision.
- Known small gap from Phase 1: a second "pickup set" email for the same booking reuses tracking key `bookingId:schedule_set`, so the ledger doesn't record it separately (the email itself still sends). Fix separately if the ledger needs it.
