# Dateless booking capture — Phase 4: the customer sets it on the manage page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A customer who paid for a single transfer with "Decide later" can fill in the missing pickup date and/or time once, on their manage page. The team gets a `Date set:` email, and the reminder emails now link straight to that form.

**Architecture:**
- **Rule:** a pure function (`customerScheduleFill`) decides what a customer may fill. Only blank fields can be filled, and a value that is already set is never changed.
- **Endpoint:** `POST /bookings/view/schedule` takes the same bearer manage token as `/view/checkout-token`. It writes through Phase 1's `setSchedule`, which already records history and refuses stale writes, with `actor.type = 'customer'`.
- **Page:** `manage.html` gets one card above the ticket. It reuses the site's `datepicker.js` and the booking page's time format.

**Tech Stack:** Node 20 · TypeScript strict · Hono · Zod · Vitest · vanilla JS in `manage.html` · Playwright (`web-tests/`).

**Spec:** `docs/superpowers/specs/2026-10-17-dateless-booking-capture-design.md`:
- §3 D2: set-once.
- §4: the rules every write path shares.
- §5: the Phase 4 row.
- §6: security notes.

**Approved design:** the clickable mockup v2 reviewed in chat on 2026-10-21. States: needs both, picking, too soon, save failed, just saved, later visit, time missing, team set it, cancelled, reminder email.

**No migration.** Phase 1's `booking_schedule_events.actor_type` already allows `'customer'` (`api/drizzle/0072_booking_schedule_events.sql`). `schedule_set` is already a `customer_communications` kind. Alert `kind` is a free string (`api/src/adapters/alerts.ts:14`).

## Owner decisions (2026-10-17 and 2026-10-21)

- **Set-once (D2).** A customer may fill a blank date and/or time. Changing anything already set goes through WhatsApp → ops. Don't relitigate this.
- **Airport pickups speak in landing times.**
  - The card asks "When does your flight land?" with the fields *Landing date* and *Landing time*.
  - The time list steps every **15 minutes**.
  - The booking details label the row *Landing time*.
  - The reminder and "pickup set" emails say *flight landing date/time*.
  - An airport pickup is `from` matching `/airport|cmb|katunayake/i`, the same test as `payPageCopy.ts:88`.
- **Other pickups use the booking page's time list.** That means hourly slots labelled like `9:00 am · Morning pickup` (`booking.js:1010-1018`, `site.js:351`).
- **Leaving the time blank is a deliberate choice:** a "Don't know yet" checkbox. The time list opens on a placeholder, never on a value.
- **The save button names what it saves,** e.g. `Save Wed 4 Nov · 9:00 am` or `Save landing Wed 4 Nov · 9:00 am`. While the form is incomplete, the disabled button says what's missing. There is no separate confirm step and no warning box.
- **The green "Pick-up set" card shows only right after saving.** A later visit shows just the ticket. The page never says "set by you". It says "set by our team" when ops set the date.
- **The reminder email's main button opens the manage page with the form already open** (`#pickup`). WhatsApp becomes the fallback.
- **Refund and cancellation policy is unchanged.** Don't touch `cancellationPolicy()`, `terms.html`, or any refund copy.

## Global Constraints

- Single transfers only (`mode === 'single'`), and status `paid` or `confirmed` only (`SCHEDULE_EDITABLE_STATUSES`, `api/src/db/bookingRepo.ts:142`). Every other booking shows no card, and the endpoint answers `409 not_editable`.
- **Rules:** `scheduleProblem(date, time, now)` *without* `allowShortNotice`. The customer is bound by 12 h notice, not past, at most 12 months ahead, and a real `YYYY-MM-DD` / `HH:MM` (`api/src/domain/bookingSchedule.ts`).
- **Set-once:** a field that is already set must come back unchanged or `null`, otherwise `409 already_set`. A body that fills nothing returns `400 nothing_to_set`. A missing date after merging returns `400 date_required`.
- **No lost updates:** the write's `expected` is the value read in the same request. A `setSchedule` conflict returns `409 conflict` with `current`.
- **Emails are best-effort and never fail the write:**
  - the customer's `schedule_set` email (`sendScheduleSet`)
  - the team's `Date set:` email, sent through `deps.alerts`
  - `Date set:` is a fixed subject prefix that Gmail filters on (spec D4).
- **URGENT:** the team email's subject and pill say URGENT when the pickup date is today or tomorrow in Colombo.
- **Rate limit:** the POST falls under the existing per-IP `/bookings/*` limiter (`api/src/app.ts:426`). Set-once caps it at two writes per booking anyway. Add no new limiter.
- **Times:** stored as `HH:MM` 24-hour, as today. Only the manage page *displays* 12-hour times. Emails keep their current format.
- **Tests:** every date in a test is relative (`inDays(n)` in the api, `futureIsoDate(n)` in web-tests). A fixed calendar date in a test is a time bomb.
- **Gate before every commit:**
  - `cd api && npm run check` with `DATABASE_URL_TEST` pointing at a **local** test DB. Never use `api/.env`: its `DATABASE_URL` is prod.
  - `npm --prefix <abs path>/web-tests run test:all`. Run it from its own dir, and remember it includes Playwright.
  - After editing any root asset (`manage.html`), run `npm run stamp` at the repo root.
- **Git:**
  - Work in a worktree on branch `feat/manage-set-pickup` cut from `origin/main`.
  - Stage files by path, never `git add -A`.
  - One PR.

## File map

| File | Change |
|---|---|
| `api/src/domain/bookingSchedule.ts` (+ `.test.ts`) | `customerScheduleFill()`: the set-once merge |
| `api/src/quote/payPageCopy.ts` | export the existing `isAirportPlace` (one word) |
| `api/src/services/opsNotifications.ts` (+ `opsNotifications.scheduleSet.test.ts`) | `teamScheduleSetEmail()` |
| `api/src/services/notifications.ts` (+ `notifications.test.ts`) | Airport wording in `sendDetailsReminder` / `sendScheduleSet`. The reminder's main button goes to `#pickup`. |
| `api/src/routes/bookings.ts` (+ `bookings.viewSchedule.test.ts`) | `POST /view/schedule`; `scheduleSetBy` on `GET /view` |
| `api/src/app.ts` | pass `email` into `bookingRoutes` |
| `api/src/routes/customerPages.ts` | serve `datepicker.js` beside manage.html |
| `manage.html` | the pickup card, the facts-row changes, the datepicker script |
| `web-tests/unit/manage-pickup.test.js` | the page's pure helpers |
| `web-tests/e2e/manage-pickup.spec.js` | the card end to end, API stubbed |
| `docs/superpowers/specs/2026-10-17-dateless-booking-capture-design.md` | record the 2026-10-21 decisions |

---

### Task 1: The set-once rule

**Files:**
- Modify: `api/src/domain/bookingSchedule.ts`
- Test: `api/src/domain/bookingSchedule.test.ts`

**Interfaces:**
- Consumes: `ScheduleValue` from `api/src/db/bookingRepo.ts:144` (`{ date: string | null; time: string | null }`).
- Produces:
  ```ts
  export type CustomerFillRefusal = 'already_set' | 'nothing_to_set' | 'date_required';
  export function customerScheduleFill(
    current: ScheduleValue,
    sent: ScheduleValue,
  ): { ok: true; next: { date: string; time: string | null } } | { ok: false; reason: CustomerFillRefusal };
  ```

- [ ] **Step 1: Write the failing tests.** Append this to `api/src/domain/bookingSchedule.test.ts`, and add `customerScheduleFill` to that file's existing import from `./bookingSchedule`:

```ts
describe('customerScheduleFill — the manage page fills blanks only (spec D2)', () => {
  const blank = { date: null, time: null };

  it('fills both blanks', () => {
    expect(customerScheduleFill(blank, { date: '2026-11-04', time: '09:00' }))
      .toEqual({ ok: true, next: { date: '2026-11-04', time: '09:00' } });
  });

  it('fills the date and leaves the time for later', () => {
    expect(customerScheduleFill(blank, { date: '2026-11-04', time: null }))
      .toEqual({ ok: true, next: { date: '2026-11-04', time: null } });
  });

  it('fills only the time when ops already set the date (sent back unchanged or null)', () => {
    const cur = { date: '2026-11-04', time: null };
    expect(customerScheduleFill(cur, { date: '2026-11-04', time: '09:00' }))
      .toEqual({ ok: true, next: { date: '2026-11-04', time: '09:00' } });
    expect(customerScheduleFill(cur, { date: null, time: '09:00' }))
      .toEqual({ ok: true, next: { date: '2026-11-04', time: '09:00' } });
  });

  it('fills the date when only the time was known', () => {
    expect(customerScheduleFill({ date: null, time: '09:00' }, { date: '2026-11-04', time: null }))
      .toEqual({ ok: true, next: { date: '2026-11-04', time: '09:00' } });
  });

  it('never changes a value that is already set', () => {
    expect(customerScheduleFill({ date: '2026-11-04', time: null }, { date: '2026-11-05', time: '09:00' }))
      .toEqual({ ok: false, reason: 'already_set' });
    expect(customerScheduleFill({ date: '2026-11-04', time: '09:00' }, { date: '2026-11-04', time: '10:00' }))
      .toEqual({ ok: false, reason: 'already_set' });
  });

  it('refuses a fill that changes nothing', () => {
    expect(customerScheduleFill({ date: '2026-11-04', time: '09:00' }, { date: '2026-11-04', time: '09:00' }))
      .toEqual({ ok: false, reason: 'nothing_to_set' });
    expect(customerScheduleFill({ date: '2026-11-04', time: null }, { date: null, time: null }))
      .toEqual({ ok: false, reason: 'nothing_to_set' });
  });

  it('needs a date to end up with one (the time alone cannot be stored without it)', () => {
    expect(customerScheduleFill(blank, { date: null, time: '09:00' }))
      .toEqual({ ok: false, reason: 'date_required' });
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail.**
Run: `cd api && npx vitest run src/domain/bookingSchedule.test.ts`
Expected: FAIL. `customerScheduleFill` is not exported.

- [ ] **Step 3: Implement.** Append this to `api/src/domain/bookingSchedule.ts`, and add `import type { ScheduleValue } from '../db/bookingRepo';` at the top:

```ts
// The manage page may only fill what is blank (spec D2: set-once). A value already set must come
// back unchanged or null; changing it goes through WhatsApp → ops. The merge happens here, not in
// the page, so a forwarded manage link can complete a booking but never move an existing pickup.
export type CustomerFillRefusal = 'already_set' | 'nothing_to_set' | 'date_required';

export function customerScheduleFill(
  current: ScheduleValue,
  sent: ScheduleValue,
): { ok: true; next: { date: string; time: string | null } } | { ok: false; reason: CustomerFillRefusal } {
  const clashes = (have: string | null, got: string | null) => have !== null && got !== null && got !== have;
  if (clashes(current.date, sent.date) || clashes(current.time, sent.time)) return { ok: false, reason: 'already_set' };
  const date = current.date ?? sent.date;
  const time = current.time ?? sent.time;
  if (date === current.date && time === current.time) return { ok: false, reason: 'nothing_to_set' };
  if (date === null) return { ok: false, reason: 'date_required' };
  return { ok: true, next: { date, time } };
}
```

- [ ] **Step 4: Run the tests and watch them pass.**
Run: `cd api && npx vitest run src/domain/bookingSchedule.test.ts`
Expected: PASS, the whole file.

- [ ] **Step 5: Commit**

```bash
git add api/src/domain/bookingSchedule.ts api/src/domain/bookingSchedule.test.ts
git commit -m "feat(schedule): set-once rule for a customer filling a blank pickup date/time"
```

---

### Task 2: The team's `Date set:` email

**Files:**
- Modify: `api/src/quote/payPageCopy.ts:89` (export only)
- Modify: `api/src/services/opsNotifications.ts`
- Test: `api/src/services/opsNotifications.scheduleSet.test.ts` (create)

**Interfaces:**
- Consumes: `ScheduleValue` (`api/src/db/bookingRepo.ts`), `isoToday` and `addIsoDays` (`api/src/domain/dateRules.ts`).
- Produces:
  - `export const isAirportPlace: (s: string | undefined) => boolean` (from `payPageCopy.ts`)
  - `export function teamScheduleSetEmail(b: Booking, was: ScheduleValue, opsBaseUrl: string, now?: Date): { subject: string; html: string; text: string }`

- [ ] **Step 1: Write the failing test.** Create `api/src/services/opsNotifications.scheduleSet.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { teamScheduleSetEmail } from './opsNotifications';
import type { Booking } from '../db/bookingRepo';

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const customer = { firstName: 'Sam', lastName: 'Perera', email: 's@x.com', whatsapp: '+447700900000', country: 'GB' };
const booking = (date: string, time: string | undefined): Booking => ({
  mode: 'single', id: '11111111-1111-4111-8111-111111111111', reference: 'CH-K7Q2M', status: 'paid',
  createdAt: new Date().toISOString(), total: 12400, currency: 'USD', channel: 'website',
  input: { from: 'Colombo Airport (CMB)', to: 'Ella', vehicleType: 'car', adults: 2, children: 0, bags: 2, customer, date, time },
} as Booking);

describe('teamScheduleSetEmail — the customer set their pickup on the manage page', () => {
  it('starts "Date set:" and names the booking, route and new pickup', () => {
    const m = teamScheduleSetEmail(booking(inDays(14), '09:00'), { date: null, time: null }, 'https://ops.example');
    expect(m.subject.startsWith('Date set: CH-K7Q2M — ')).toBe(true);
    expect(m.subject).toContain('Colombo Airport (CMB) → Ella');
    expect(m.subject).toContain('09:00');
    expect(m.subject).not.toContain('URGENT');
    expect(m.text).toContain('set it on their booking page');
    expect(m.text).toContain('was: no date, no time');
  });

  it('says URGENT when the pickup is tomorrow (Colombo)', () => {
    const m = teamScheduleSetEmail(booking(inDays(1), '20:00'), { date: null, time: null }, 'https://ops.example');
    expect(m.subject).toContain('URGENT');
    expect(m.html).toContain('URGENT');
  });

  it('names what was there before a time-only fill', () => {
    const m = teamScheduleSetEmail(booking(inDays(14), '09:00'), { date: inDays(14), time: null }, 'https://ops.example');
    expect(m.text).toContain('was: date set, no time');
  });
});
```

- [ ] **Step 2: Run the test and watch it fail.**
Run: `cd api && npx vitest run src/services/opsNotifications.scheduleSet.test.ts`
Expected: FAIL. `teamScheduleSetEmail` is not exported.

- [ ] **Step 3: Implement.**

In `api/src/quote/payPageCopy.ts`, change line 89 from `const isAirportPlace =` to `export const isAirportPlace =`. Nothing else in that file changes.

In `api/src/services/opsNotifications.ts`, add `import type { ScheduleValue } from '../db/bookingRepo';` (the file already imports `Booking` from there, so merge them) and `import { isoToday, addIsoDays } from '../domain/dateRules';`. Then add this after `teamUnpricedEmail`:

```ts
// ---------------------------------------------------------------------------
// Date set (dateless capture Phase 4, spec 2026-10-17 D4). The customer filled a blank pickup
// date/time on their manage page — book a driver. Subjects start "Date set: " so Gmail can filter
// them; URGENT when the pickup is today or tomorrow in Colombo (12 h notice still allows tomorrow).
// ---------------------------------------------------------------------------

export function teamScheduleSetEmail(b: Booking, was: ScheduleValue, opsBaseUrl: string, now: Date = new Date()): { subject: string; html: string; text: string } {
  const f = bookingFacts(b);
  const date = b.mode === 'single' ? b.input.date : undefined;
  const urgent = !!date && date <= addIsoDays(isoToday('Asia/Colombo', now), 1);
  const before = `${was.date ? 'date set' : 'no date'}, ${was.time ? 'time set' : 'no time'}`;
  const subject = `Date set: ${b.reference} — ${f.subjectRoute}, ${f.when}${f.time}${urgent ? ' — URGENT, travels within a day' : ''}`;
  return {
    subject,
    ...teamBookingBody(
      b,
      f,
      {
        pill: urgent ? ['URGENT · DATE SET', '#8a3b12', '#fbe9dc'] : ['DATE SET', '#1f6b3a', '#e3f1e6'],
        lead: 'pickup set by the customer',
        keys: bookingKeys(f, b),
        note:
          `${b.input.customer.firstName} set it on their booking page (was: ${before}). ` +
          `Book a driver${urgent ? ' today' : ''}. They can't change it there again — any change comes to us on WhatsApp.`,
        moneyTitle: 'Payment',
        moneyRows: [['Paid', money(f.paidNow, b.currency)], ['Channel', channelLabel(b)]],
        strong: [],
      },
      opsBaseUrl,
    ),
  };
}
```

- [ ] **Step 4: Run the test and watch it pass.**
Run: `cd api && npx vitest run src/services/opsNotifications.scheduleSet.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add api/src/quote/payPageCopy.ts api/src/services/opsNotifications.ts api/src/services/opsNotifications.scheduleSet.test.ts
git commit -m "feat(ops): Date set: team email when a customer sets their pickup"
```

---

### Task 3: The endpoint, plus who set it on the view

**Files:**
- Modify: `api/src/routes/bookings.ts`
  - deps interface at :279
  - `CustomerBookingView` at :160
  - `GET /view` at :990
  - new route after `/view/checkout-token`
- Modify: `api/src/app.ts:526-552` (pass `email`)
- Test: `api/src/routes/bookings.viewSchedule.test.ts` (create)

**Interfaces:**
- Consumes:
  - `customerScheduleFill` (Task 1)
  - `teamScheduleSetEmail` (Task 2)
  - `scheduleProblem` (`api/src/domain/bookingSchedule.ts`)
  - `bookings.setSchedule` / `bookings.listScheduleEvents` and `SCHEDULE_EDITABLE_STATUSES` (`api/src/db/bookingRepo.ts`)
  - `sendScheduleSet`, `manageUrl` (`api/src/services/notifications.ts`)
  - `signBookingToken` (`api/src/lib/bookingToken.ts`)
- Produces:
  - `POST /bookings/view/schedule`
    - header `Authorization: Bearer <manage token>`, body `{ date: string|null, time: string|null }`
    - `200 { view: CustomerBookingView, emailed: boolean }`
    - `400 { error: 'bad_request'|'nothing_to_set'|'date_required'|'bad_date'|'bad_time'|'past'|'too_soon'|'too_far' }`
    - `401 { error: 'invalid_link' }`
    - `404 { error: 'not_found' }`
    - `409 { error: 'not_editable' }`
    - `409 { error: 'already_set'|'conflict', current: { date, time } }`
  - `CustomerBookingView.scheduleSetBy?: 'staff' | 'customer'`: who made the latest schedule change. Absent when nobody has changed it since booking.

- [ ] **Step 1: Write the failing tests.** Create `api/src/routes/bookings.viewSchedule.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../app';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { FakeEmailAdapter } from '../adapters/email';
import { FakeAlertAdapter } from '../adapters/alerts';
import { signBookingToken } from '../lib/bookingToken';

const SECRET = 'test-link-secret';
// Relative dates: a fixed calendar date in a test is a time bomb.
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe('POST /bookings/view/schedule — the customer fills a blank pickup (Phase 4)', () => {
  let app: ReturnType<typeof createApp>;
  let bookings: InMemoryBookingRepo;
  let email: FakeEmailAdapter;
  let alerts: FakeAlertAdapter;
  let bid: string;
  let token: string;

  async function paidBooking(input: Record<string, unknown> = {}) {
    const b = await bookings.create({
      mode: 'single', total: 12400, amountDueNow: 12400, currency: 'USD',
      input: { from: 'Colombo Airport (CMB)', to: 'Ella', vehicleType: 'car', adults: 2, children: 0, bags: 2,
        customer: { firstName: 'Sam', lastName: 'Perera', email: 's@x.com', whatsapp: '+447700900000', country: 'GB' }, ...input },
    });
    await bookings.setStatus(b.id, 'payment_pending');
    await bookings.setStatus(b.id, 'paid');
    return b.id;
  }

  beforeEach(async () => {
    bookings = new InMemoryBookingRepo();
    email = new FakeEmailAdapter();
    alerts = new FakeAlertAdapter();
    app = createApp({ bookings, email, alerts, bookingLinkSecret: SECRET, bookingBaseUrl: 'https://ceylonhop.com' });
    bid = await paidBooking();
    token = signBookingToken(bid, SECRET);
  });

  const post = (body: unknown, t: string | null = token) =>
    app.request('/bookings/view/schedule', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) },
      body: JSON.stringify(body),
    });

  it('fills both blanks, records the customer as the actor, emails the customer and the team', async () => {
    const date = inDays(14);
    const res = await post({ date, time: '09:00' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.view).toMatchObject({ date, time: '09:00', scheduleSetBy: 'customer' });
    expect(body.emailed).toBe(true);
    const events = await bookings.listScheduleEvents(bid);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fromDate: null, fromTime: null, toDate: date, toTime: '09:00', actorType: 'customer', actorId: 'manage_link' });
    expect(email.sent.map((m) => m.subject)).toContain(`Your pickup is set — ${body.view.reference}`);
    expect(alerts.sent).toHaveLength(1);
    expect(alerts.sent[0].email?.subject.startsWith(`Date set: ${body.view.reference}`)).toBe(true);
  });

  it('lets the time be added later, once', async () => {
    const date = inDays(14);
    expect((await post({ date, time: null })).status).toBe(200);
    const res = await post({ date: null, time: '10:00' });
    expect(res.status).toBe(200);
    expect((await res.json()).view).toMatchObject({ date, time: '10:00' });
    expect(await bookings.listScheduleEvents(bid)).toHaveLength(2);
  });

  it('never moves a value that is already set (409 already_set with the current value)', async () => {
    const date = inDays(14);
    await post({ date, time: '09:00' });
    const res = await post({ date: inDays(15), time: '09:00' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'already_set', current: { date, time: '09:00' } });
    expect(await bookings.listScheduleEvents(bid)).toHaveLength(1);
  });

  it('binds the customer to 12 h notice (ops is not)', async () => {
    const res = await post({ date: inDays(0), time: '00:00' });
    expect(res.status).toBe(400);
    expect(['past', 'too_soon']).toContain((await res.json()).error);
  });

  it('400s an empty fill, a time with no date, and a malformed body', async () => {
    expect((await (await post({ date: null, time: null })).json()).error).toBe('nothing_to_set');
    expect((await (await post({ date: null, time: '09:00' })).json()).error).toBe('date_required');
    expect((await post({ date: 5 })).status).toBe(400);
  });

  it('401s without a valid manage token', async () => {
    expect((await post({ date: inDays(14), time: null }, null)).status).toBe(401);
    expect((await post({ date: inDays(14), time: null }, 'forged')).status).toBe(401);
  });

  it('409s a booking that is not paid', async () => {
    const b = await bookings.create({
      mode: 'single', total: 100, amountDueNow: 100, currency: 'USD',
      input: { from: 'A', to: 'B', vehicleType: 'car', adults: 1, children: 0, bags: 0,
        customer: { firstName: 'X', lastName: 'Y', email: 'x@x.com', whatsapp: '+1', country: 'US' } },
    });
    const res = await post({ date: inDays(14), time: null }, signBookingToken(b.id, SECRET));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('not_editable');
  });

  it('still saves when both emails fail', async () => {
    email.send = async () => { throw new Error('smtp down'); };
    alerts.send = async () => { throw new Error('alerts down'); };
    const res = await post({ date: inDays(14), time: '09:00' });
    expect(res.status).toBe(200);
    expect((await res.json()).emailed).toBe(false);
  });
});

describe('GET /bookings/view says who set the pickup', () => {
  it('is absent until someone changes it, then names the latest actor', async () => {
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ bookings, bookingLinkSecret: SECRET });
    const b = await bookings.create({
      mode: 'single', total: 100, amountDueNow: 100, currency: 'USD',
      input: { from: 'Kandy', to: 'Ella', vehicleType: 'car', adults: 1, children: 0, bags: 0,
        customer: { firstName: 'X', lastName: 'Y', email: 'x@x.com', whatsapp: '+1', country: 'US' } },
    });
    await bookings.setStatus(b.id, 'payment_pending');
    await bookings.setStatus(b.id, 'paid');
    const view = async () => (await app.request(`/bookings/view?t=${signBookingToken(b.id, SECRET)}`)).json();
    expect((await view()).scheduleSetBy).toBeUndefined();
    await bookings.setSchedule(b.id, { date: inDays(14), time: null, expected: { date: null, time: null }, actor: { type: 'staff', id: 'f@x.com' } });
    expect((await view()).scheduleSetBy).toBe('staff');
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail.**
Run: `cd api && npx vitest run src/routes/bookings.viewSchedule.test.ts`
Expected: FAIL. The POST answers 404 (no route), and `scheduleSetBy` is undefined after the staff change.

- [ ] **Step 3: Implement.**

1. `api/src/routes/bookings.ts` imports: add these to the existing import blocks:
   - `customerScheduleFill` and `scheduleProblem` from `'../domain/bookingSchedule'`
   - `SCHEDULE_EDITABLE_STATUSES` from `'../db/bookingRepo'` (beside `websitePricingSnapshot`)
   - `sendScheduleSet` and `manageUrl` from `'../services/notifications'` (beside `promoDiscount`)
   - `teamScheduleSetEmail` from `'../services/opsNotifications'` (beside `teamUnpricedEmail`)
   - `import type { EmailAdapter } from '../adapters/email';`

2. In `CustomerBookingView`, after `discountCents?: number;`, add:

```ts
  // Who made the latest pickup date/time change after booking (booking_schedule_events). Absent
  // when nobody has. The manage page says "set by our team" for 'staff' and never "set by you".
  scheduleSetBy?: 'staff' | 'customer';
```

3. In the `bookingRoutes` deps, after `opsBaseUrl?: string;`, add:

```ts
  // The customer's "Your pickup is set" email after they fill it on the manage page (Phase 4).
  // Unset → nothing is emailed; the change still saves.
  email?: EmailAdapter;
```

4. Replace the body of `r.get('/view', …)` with:

```ts
    const id = verifyBookingToken(c.req.query('t'), deps.linkSecret);
    if (!id) return c.json({ error: 'invalid_link' }, 401);
    const booking = await deps.bookings.get(id);
    if (!booking) return c.json({ error: 'not_found' }, 404);
    const last = (await deps.bookings.listScheduleEvents(booking.id)).at(-1);
    // ga4Item: the item manage.html's browser `purchase` carries (ga4Hits.ts browserItem).
    return c.json({
      ...projectBooking(booking, await payments.findByBookingId(booking.id)),
      ...(last ? { scheduleSetBy: last.actorType } : {}),
      ga4Item: browserItem(booking),
    }, 200);
```

5. After the `r.post('/view/checkout-token', …)` handler, add:

```ts
  // Dateless capture Phase 4 (spec 2026-10-17 §5): the customer fills a BLANK pickup date/time on
  // the manage page. Set-once (D2): customerScheduleFill refuses to change anything already set —
  // that goes through WhatsApp → ops. Same bearer token as /view/checkout-token (never the query
  // string, which reaches logs). Under /bookings/*, so the per-IP POST limiter already applies.
  r.post('/view/schedule', async (c) => {
    const id = verifyBookingToken(bearerToken(c.req.header('authorization')), deps.linkSecret);
    if (!id) return c.json({ error: 'invalid_link' }, 401);
    const body = z.object({ date: z.string().nullable(), time: z.string().nullable() })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const booking = await bookings.get(id);
    if (!booking) return c.json({ error: 'not_found' }, 404);
    if (booking.mode !== 'single' || !(SCHEDULE_EDITABLE_STATUSES as readonly string[]).includes(booking.status)) {
      return c.json({ error: 'not_editable' }, 409);
    }
    const current = { date: booking.input.date ?? null, time: booking.input.time ?? null };
    const fill = customerScheduleFill(current, body.data);
    if (!fill.ok) return c.json(fill.reason === 'already_set' ? { error: fill.reason, current } : { error: fill.reason }, fill.reason === 'already_set' ? 409 : 400);
    // No allowShortNotice: the 12 h rule binds the customer, not ops (spec §4).
    const problem = scheduleProblem(fill.next.date, fill.next.time);
    if (problem) return c.json({ error: problem }, 400);

    const result = await bookings.setSchedule(id, { ...fill.next, expected: current, actor: { type: 'customer', id: 'manage_link' } });
    if (!result.ok) {
      if (result.reason === 'not_found') return c.json({ error: 'not_found' }, 404);
      const b = result.booking;
      const now = b.mode === 'single' ? { date: b.input.date ?? null, time: b.input.time ?? null } : null;
      return c.json({ error: result.reason, current: now }, 409);
    }

    // Both best-effort: a mail failure must not undo what the customer just set.
    let emailed = false;
    if (deps.email) {
      try {
        const links = deps.manageBaseUrl ? { manage: manageUrl(result.booking, deps.manageBaseUrl, deps.linkSecret) } : {};
        await sendScheduleSet(result.booking, deps.email, links);
        emailed = true;
      } catch (err) {
        console.error(`schedule_set email failed for ${result.booking.reference}:`, err);
      }
    }
    if (deps.alerts) {
      try {
        await deps.alerts.send({
          severity: 'info',
          kind: 'schedule_set_by_customer',
          title: `Date set: ${result.booking.reference} by the customer`,
          body: `${result.booking.reference}: pickup set to ${fill.next.date}${fill.next.time ? ` ${fill.next.time}` : ''} on the manage page.`,
          email: teamScheduleSetEmail(result.booking, current, deps.opsBaseUrl ?? ''),
          // A later time-only fill is a new event, not a repeat of the first.
          dedupeKey: `${result.booking.id}:${fill.next.date}:${fill.next.time ?? ''}`,
        });
      } catch (err) {
        console.error(`Date set alert failed for ${result.booking.reference}:`, err);
      }
    }
    const view = { ...projectBooking(result.booking, await payments.findByBookingId(id)), scheduleSetBy: 'customer' as const };
    return c.json({ view, emailed }, 200);
  });
```

6. In `api/src/app.ts`, inside the `bookingRoutes({ … })` call (after `alerts,` at :550), add `email,`. That's the adapter `const email` built at :252. Read 245-260 first and confirm the name. If it's named differently there, pass that variable.

- [ ] **Step 4: Run the tests and watch them pass.**
Run: `cd api && npx vitest run src/routes/bookings.viewSchedule.test.ts src/routes/bookingView.test.ts src/routes/bookings.view.balance.test.ts`
Expected: PASS. If `createApp` doesn't accept `bookingBaseUrl`/`bookingLinkSecret` in that shape, read `api/src/app.ts:140-175` and use its real option names. Change the test, not the app.

- [ ] **Step 5: Run the whole gate, then commit.**
Run: `cd api && npm run check`
Expected: typecheck, lint and tests all pass. Read the real exit code; don't run it through a pipe.

```bash
git add api/src/routes/bookings.ts api/src/routes/bookings.viewSchedule.test.ts api/src/app.ts
git commit -m "feat(bookings): customer fills a blank pickup date/time from the manage link (set-once)"
```

---

### Task 4: The emails speak in landing times; the reminder leads to the form

**Files:**
- Modify: `api/src/services/notifications.ts`
  - `sendDetailsReminder` at :1121
  - `sendScheduleSet` at :1170
- Test: `api/src/services/notifications.test.ts` (the `sendDetailsReminder` describe at :945 and the `sendScheduleSet` tests above it)

**Interfaces:**
- Consumes: `isAirportPlace` (Task 2, `api/src/quote/payPageCopy.ts`) and `ctaRow(url, label)` (`notifications.ts:813`).
- Produces: no new exports. The reminder's HTML and text lead with `<manage>#pickup`.

- [ ] **Step 1: Write the failing tests.** In `api/src/services/notifications.test.ts`, add these inside `describe('sendDetailsReminder …')`:

```ts
  it('leads with the manage page, form open, and keeps WhatsApp as the fallback', async () => {
    const email = new FakeEmailAdapter();
    await sendDetailsReminder(single, email, { nth: 1, manage: 'https://ceylonhop.com/manage.html?t=abc' });
    const m = email.sent[0];
    const form = m.html.indexOf('manage.html?t=abc#pickup');
    expect(form).toBeGreaterThan(-1);
    expect(form).toBeLessThan(m.html.indexOf('wa.me/94779669662'));
    expect(m.html).toContain('Or tell us on WhatsApp');
    expect(m.html).not.toContain('View your booking'); // the form link replaces it
    expect(m.text.indexOf('#pickup')).toBeLessThan(m.text.indexOf('wa.me'));
  });

  it('asks an airport arrival for their flight landing date and time', async () => {
    const email = new FakeEmailAdapter();
    await sendDetailsReminder(single, email, { nth: 1 }); // fixture: from 'Colombo Airport'
    expect(email.sent[0].subject).toBe('Reminder: your flight landing date and time — CH-ABC12');
    expect(email.sent[0].html).toContain('flight landing date and time');
  });

  it('keeps "pickup" for a pickup that is not an airport', async () => {
    const email = new FakeEmailAdapter();
    await sendDetailsReminder({ ...single, input: { ...single.input, from: 'Kandy' } } as Booking, email, { nth: 1 });
    expect(email.sent[0].subject).toBe('Reminder: your pickup date and time — CH-ABC12');
  });
```

Update the two existing tests in that describe, which pinned the old airport wording. The fixture's `from` is `'Colombo Airport'`. If you leave that `from` unchanged, the new expectations are:
- `'Reminder: your flight landing date and time — CH-ABC12'`
- `toContain('flight landing time')`
- `not.toContain('flight landing date and time')`

The cleaner alternative is to give those two tests `from: 'Kandy'` and keep their "pickup" expectations. Do that: they're about missing-field wording, not about airports.

The existing `sendScheduleSet` test `'says the time is still to confirm when only the date is set'` expects `'pickup time to confirm'` on the airport fixture, so it would now read "landing time to confirm". Give that test `from: 'Kandy'` too.

Then add this beside the existing `sendScheduleSet` tests:

```ts
  it('tells an airport arrival their driver meets the landing time', async () => {
    const email = new FakeEmailAdapter();
    await sendScheduleSet({ ...single, input: { ...single.input, date: '2030-11-04', time: '09:00' } } as Booking, email);
    expect(email.sent[0].html).toContain('lands 09:00 (Sri Lanka time)');
  });
```

(`2030-11-04` is safe here: `sendScheduleSet` doesn't check whether the date is past.)

- [ ] **Step 2: Run the tests and watch them fail.**
Run: `cd api && npx vitest run src/services/notifications.test.ts -t "sendDetailsReminder|sendScheduleSet"`
Expected: FAIL. There's no `#pickup`, the wording is still "pickup", and there's no "lands".

- [ ] **Step 3: Implement.** In `api/src/services/notifications.ts`, add `import { isAirportPlace } from '../quote/payPageCopy';`. Then make these changes in `sendDetailsReminder`:

```ts
  const first = esc(booking.input.customer.firstName);
  // An arrival knows when the flight lands, not when a driver should turn up (owner, 2026-10-21).
  const noun = isAirportPlace(booking.input.from) ? 'flight landing' : 'pickup';
  const missing = !booking.input.date && !booking.input.time
    ? `${noun} date and time`
    : !booking.input.date ? `${noun} date` : `${noun} time`;
```

Then replace the `html` / `text` bodies so that, when `opts.manage` is set, the manage-page button leads and WhatsApp follows:

```ts
  // The form on the manage page leads (Phase 4); WhatsApp stays as the fallback. `#pickup` opens it.
  const form = opts.manage ? `${opts.manage}#pickup` : null;
  const html = page(
    brandHeader() +
      introBlock(
        'Reminder',
        AMBER,
        `What's your ${missing}, ${first}?`,
        `Your booking is paid and safe. We just need your ${missing} to book your driver.`,
      ) +
      ticketCard(booking, BADGE_ACTION) +
      (form ? ctaRow(form, `Add your ${missing}`) : '') +
      infoBox(
        form ? 'Or tell us on WhatsApp' : 'Tell us on WhatsApp',
        `Tap below and send us your ${missing}. Already told us? You can ignore this email.`,
        undefined,
        ask,
      ) +
      footer(),
  );
  const text = textShell(`what's your ${missing}?`, `Your booking is paid — we just need your ${missing}.`, booking, [
    ...factRows(booking).map(([k, v]) => `${k}: ${v}`),
    '',
    ...(form ? [`Add it here: ${form}`, ''] : []),
    `${form ? 'Or tell us' : 'Tell us'} on WhatsApp: ${ask.href}`,
    'Already told us? You can ignore this email.',
  ]);
```

(This drops the old `manageButton(opts.manage)` and the "View your booking" text line: the form link replaces them.)

In `sendScheduleSet`, replace the `when` lines with:

```ts
  const lands = isAirportPlace(booking.input.from);
  const when = booking.input.time
    ? `${fmtDate(booking.input.date)} · ${lands ? 'lands ' : ''}${booking.input.time} (Sri Lanka time)`
    : `${fmtDate(booking.input.date)} · ${lands ? 'landing' : 'pickup'} time to confirm`;
```

- [ ] **Step 4: Run the tests and watch them pass.**
Run: `cd api && npx vitest run src/services/notifications.test.ts`
Expected: PASS, the whole file. Also run `cd api && npx vitest run src/services/scheduler` to check that the reminder dispatch tests still pass.

- [ ] **Step 5: Commit**

```bash
git add api/src/services/notifications.ts api/src/services/notifications.test.ts
git commit -m "feat(email): reminder leads to the manage-page form; airport arrivals asked for landing times"
```

---

### Task 5: The manage page's pure helpers and booking-detail rows

**Files:**
- Modify: `manage.html`: add helpers inside the main IIFE, after `vehicleLabel`; change `factsOf`.
- Test: `web-tests/unit/manage-pickup.test.js` (create)

**Interfaces:**
- Consumes: the view fields `mode`, `status`, `from`, `date`, `time`, `scheduleSetBy` (Task 3).
- Produces (functions inside `manage.html`, extracted by tests with the loadFn pattern):
  - `isAirport(v) → boolean`
  - `fmtTime('09:00') → '9:00 am'`
  - `pickupNeeds(v) → null | 'both' | 'date' | 'time'`: null when the card must not show
  - `timeChoices(v) → [{ value, label }]`: airport every 15 min, plain labels; otherwise hourly with the booking page's labels
  - `saveLabel(v, date, time, noTime, soon) → { text, ready }`

- [ ] **Step 1: Write the failing tests.** Create `web-tests/unit/manage-pickup.test.js`:

```js
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { futureIsoDate } from '../dates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.resolve(__dirname, '../../manage.html'), 'utf8');

// Pull named functions out of manage.html (loadFn pattern — see manage-page-addons.test.js).
function grab(name) {
  const m = html.match(new RegExp(`function ${name}\\([^)]*\\)\\{[\\s\\S]*?\\n  \\}`));
  if (!m) throw new Error(`${name} not found in manage.html`);
  return m[0];
}
const MON3 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const isoParts = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? { y: +m[1], mo: +m[2], d: +m[3] } : null; };
// eslint-disable-next-line no-new-func
const lib = new Function('MON3', 'isoParts',
  ['isAirport', 'fmtTime', 'slotLabel', 'pickupNeeds', 'timeChoices', 'shortDate', 'saveLabel'].map(grab).join('\n')
  + '\nreturn { isAirport, fmtTime, pickupNeeds, timeChoices, saveLabel, shortDate };')(MON3, isoParts);

const paid = { mode: 'single', status: 'paid', from: 'Kandy', date: 'to confirm', time: 'to confirm' };

describe('pickupNeeds — when the card shows, and what it asks for', () => {
  it('asks for both, the date, or the time', () => {
    expect(lib.pickupNeeds(paid)).toBe('both');
    expect(lib.pickupNeeds({ ...paid, time: '09:00' })).toBe('date');
    expect(lib.pickupNeeds({ ...paid, date: futureIsoDate() })).toBe('time');
  });
  it('shows nothing once both are set, or on a booking the customer may not edit', () => {
    expect(lib.pickupNeeds({ ...paid, date: futureIsoDate(), time: '09:00' })).toBeNull();
    for (const status of ['draft', 'payment_pending', 'cancelled', 'refunded', 'completed']) {
      expect(lib.pickupNeeds({ ...paid, status })).toBeNull();
    }
    expect(lib.pickupNeeds({ ...paid, mode: 'trip' })).toBeNull();
    expect(lib.pickupNeeds({ ...paid, status: 'confirmed' })).toBe('both');
  });
});

describe('time choices match the booking page; airports step every 15 min', () => {
  it('hotel pickups: 24 hourly slots, labelled like booking.js', () => {
    const t = lib.timeChoices(paid);
    expect(t).toHaveLength(24);
    expect(t[9]).toEqual({ value: '09:00', label: '9:00 am · Morning pickup' });
    expect(t[0].label).toBe('12:00 am · Night pickup');
    expect(t[13].label).toBe('1:00 pm · Afternoon pickup');
  });
  it('airport landings: 96 quarter-hour slots, no pickup labels', () => {
    const t = lib.timeChoices({ ...paid, from: 'Colombo Airport (CMB)' });
    expect(t).toHaveLength(96);
    expect(t[35]).toEqual({ value: '08:45', label: '8:45 am' });
  });
});

describe('the save button names what it will save, or what is missing', () => {
  const d = '2026-11-04'; // shortDate only formats; no rule here reads "today"
  it('says what is missing while it cannot save', () => {
    expect(lib.saveLabel(paid, '', '', false, false)).toEqual({ text: 'Choose a date', ready: false });
    expect(lib.saveLabel(paid, d, '', false, false)).toEqual({ text: 'Choose a pick-up time', ready: false });
    expect(lib.saveLabel({ ...paid, from: 'CMB' }, d, '', false, false)).toEqual({ text: 'Choose a landing time', ready: false });
    expect(lib.saveLabel(paid, d, '09:00', false, true)).toEqual({ text: 'Too soon to set here', ready: false });
  });
  it('names the exact value once it can', () => {
    expect(lib.saveLabel(paid, d, '09:00', false, false)).toEqual({ text: 'Save Wed 4 Nov · 9:00 am', ready: true });
    expect(lib.saveLabel({ ...paid, from: 'Colombo Airport (CMB)' }, d, '08:45', false, false)).toEqual({ text: 'Save landing Wed 4 Nov · 8:45 am', ready: true });
    expect(lib.saveLabel(paid, d, '', true, false)).toEqual({ text: 'Save Wed 4 Nov · time later', ready: true });
  });
});
```

Also update `web-tests/unit/manage-page-addons.test.js`. Its `loadFactsOf` (line 17) passes only `esc, legsOf, longDate, vehicleLabel` into the extracted `factsOf`, which now also calls `fmtTime` and `isAirport`. Replace its `return new Function(…)(…)` with a version that passes the page's real helpers:

```js
  const real = (name) => {
    const f = html.match(new RegExp(`function ${name}\\([^)]*\\)\\{[\\s\\S]*?\\n  \\}`));
    if (!f) throw new Error(`${name} not found in manage.html`);
    // eslint-disable-next-line no-new-func
    return new Function('return (' + f[0] + ')')();
  };
  // eslint-disable-next-line no-new-func
  return new Function('esc', 'legsOf', 'longDate', 'vehicleLabel', 'fmtTime', 'isAirport', 'return (' + m[0] + ')')(
    esc, () => [{}], (d) => d, (v) => v, real('fmtTime'), real('isAirport'),
  );
```

Then add these tests to the same file:

```js
// factsOf now formats the time (fmtTime) and names it "Landing time" on an airport pickup (isAirport).
describe('manage card time row', () => {
  it('prints a 12-hour pick-up time in Sri Lanka time', () => {
    const html = factsOf({ ...view, from: 'Kandy', time: '09:00' });
    expect(html).toContain('<span class="k">Pick-up time</span><span class="v">9:00 am<small>Sri Lanka time</small></span>');
  });
  it('calls it Landing time on an airport pickup', () => {
    expect(factsOf({ ...view, from: 'Colombo Airport (CMB)', time: '09:00' })).toContain('<span class="k">Landing time</span>');
  });
  it('flags a missing value', () => {
    expect(factsOf({ ...view, from: 'Kandy', time: 'to confirm' })).toContain('<span class="need">Not set yet</span>');
  });
  it('says the team set the date, never "you"', () => {
    expect(factsOf({ ...view, from: 'Kandy', scheduleSetBy: 'staff' })).toContain('set by our team');
    expect(factsOf({ ...view, from: 'Kandy', scheduleSetBy: 'customer' })).not.toMatch(/set by/);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail.**
Run: `npm --prefix "$PWD/web-tests" exec -- vitest run unit/manage-pickup.test.js unit/manage-page-addons.test.js` (from the worktree root).
Expected: FAIL. `isAirport not found in manage.html`.

- [ ] **Step 3: Implement.** In `manage.html`, inside the main IIFE right after `function vehicleLabel(v){…}`, add the helpers. Each one starts with `  function` and ends at a line that is exactly `  }`, which is what the tests' regex extracts. Keep it that way.

```js
  // ---- Pickup date/time, set once by the customer (dateless capture Phase 4) ----
  // An airport pickup is asked for its LANDING time (owner, 2026-10-21) — same test as payPageCopy.ts.
  function isAirport(v){
    return /airport|cmb|katunayake/i.test(String((v && v.from) || ''));
  }
  // booking.js:1010 — the booking page's own format, so a customer sees the same "9:00 am" twice.
  function fmtTime(t){
    var h = +t.slice(0, 2);
    return ((h + 11) % 12 + 1) + ':' + t.slice(3, 5) + ' ' + (h < 12 ? 'am' : 'pm');
  }
  // booking.js:1017 — the booking page's slot labels, verbatim.
  function slotLabel(h){
    return h < 5 ? 'Night pickup' : (h < 8 ? 'Early start' : (h < 12 ? 'Morning pickup' : (h < 17 ? 'Afternoon pickup' : (h < 20 ? 'Evening pickup' : 'Night pickup'))));
  }
  // What the card asks for; null = no card. Only a paid single transfer with a blank is editable here
  // (the server's SCHEDULE_EDITABLE_STATUSES + mode check, mirrored).
  function pickupNeeds(v){
    if (!v || v.mode !== 'single' || (v.status !== 'paid' && v.status !== 'confirmed')) return null;
    var noDate = !v.date || v.date === 'to confirm', noTime = !v.time || v.time === 'to confirm';
    return noDate && noTime ? 'both' : noDate ? 'date' : noTime ? 'time' : null;
  }
  // Hotel pickups: the booking page's hourly list (site.js hourlyTimes). Airports: every 15 minutes,
  // because a flight lands at 8:40, not on the hour (owner, 2026-10-21).
  function timeChoices(v){
    var air = isAirport(v), step = air ? 15 : 60, out = [];
    for (var m = 0; m < 24 * 60; m += step) {
      var h = Math.floor(m / 60), t = (h < 10 ? '0' : '') + h + ':' + (m % 60 < 10 ? '0' : '') + (m % 60);
      out.push({ value: t, label: fmtTime(t) + (air ? '' : ' · ' + slotLabel(h)) });
    }
    return out;
  }
  // 'Wed 4 Nov' — built from UTC parts, like longDate().
  function shortDate(iso){
    var p = isoParts(iso);
    if (!p) return '';
    var d = new Date(Date.UTC(p.y, p.mo - 1, p.d));
    return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()] + ' ' + p.d + ' ' + MON3[p.mo - 1];
  }
  // The button says exactly what it will save — the set-once confirmation lives in its label —
  // or, while it can't save, what is missing.
  function saveLabel(v, date, time, noTime, soon){
    var air = isAirport(v);
    if (!date) return { text: 'Choose a date', ready: false };
    if (soon) return { text: 'Too soon to set here', ready: false };
    if (!time && !noTime) return { text: air ? 'Choose a landing time' : 'Choose a pick-up time', ready: false };
    return { text: 'Save ' + (air ? 'landing ' : '') + shortDate(date) + ' · ' + (noTime ? 'time later' : fmtTime(time)), ready: true };
  }
```

Then, in `factsOf(v)`, replace the `Trip start` and `Pick-up time` rows and the row renderer:

```js
      { k: 'Trip start', v: longDate(v.date) || 'To be confirmed', sub: v.scheduleSetBy === 'staff' ? 'set by our team' : '' },
```
```js
      { k: isAirport(v) ? 'Landing time' : 'Pick-up time',
        v: (v.time && v.time !== 'to confirm') ? fmtTime(v.time) : 'To be confirmed',
        sub: (v.time && v.time !== 'to confirm') ? 'Sri Lanka time' : '' },
```
```js
      var val = r.lines ? r.lines.map(function(l){ return esc(l); }).join('<br>') : esc(r.v);
      // A blank is something to do, not a fact: say so plainly.
      if (r.v === 'To be confirmed') val = '<span class="need">Not set yet</span>';
```

and in `subtitleOf`, change `'Date to be confirmed'` to `'Pick-up date not set yet'`. Add the `.need` style to the page's `<style>` block:

```css
  /* A blank pickup date/time on the card — something still to do (Phase 4). */
  .fact .v .need{color:#96631a;background:#fbf0d8;border-radius:99px;padding:2px 9px;font-size:.74rem;font-weight:800}
```

- [ ] **Step 4: Run the tests and watch them pass.**
Run the Step 2 command again. Expected: PASS for both files.

Then search the e2e specs for copy you just changed: `grep -rn "Date to be confirmed\|To be confirmed" web-tests/e2e/manage*.spec.js`.
- `manage-page.spec.js` asserts the Pick-up time fact `toContainText('To be confirmed')`. The value now renders as "Not set yet". Change that assertion to `'Not set yet'` and say so in the PR: the old assertion was pinning the copy this phase replaces.
- Its fixture is an airport booking (`from: 'Colombo Airport (CMB)'`), so select that fact by `'Landing time'`.

- [ ] **Step 5: Commit**

```bash
git add manage.html web-tests/unit/manage-pickup.test.js web-tests/unit/manage-page-addons.test.js web-tests/e2e/manage-page.spec.js
git commit -m "feat(manage): pickup helpers; card shows 12-hour times, Landing time for arrivals, Not set yet"
```

---

### Task 6: The pickup card on the manage page

**Files:**
- Modify: `manage.html`: the `<head>` script tag, the styles, `pickupCard`/`wirePickup`, and `render()`
- Modify: `api/src/routes/customerPages.ts:66-78`: serve `datepicker.js`
- Test: `web-tests/e2e/manage-pickup.spec.js` (create)

**Interfaces:**
- Consumes: Task 5's helpers; `POST /bookings/view/schedule` (Task 3); `window.enhanceDate(input)` from `datepicker.js` (`datepicker.js`, end of file); `t` (the manage token) and `A` (the API base) already in scope in `manage.html`.
- Produces: no new interface. The DOM ids the e2e test drives are `#pickup`, `#pkopen`, `#pkdate`, `#pktime`, `#pkdk`, `#pksave`, `#pkerr`, `#pkfail` and `#pklater`.

- [ ] **Step 1: Write the failing e2e spec.** Create `web-tests/e2e/manage-pickup.spec.js`:

```js
import { test, expect } from '@playwright/test';
import { futureIsoDate } from '../dates.js';

// Phase 4: a customer who booked with "Decide later" fills the blank pickup ONCE on the manage
// page. Offline: /bookings/view and /bookings/view/schedule are stubbed.

const PAGE = '/manage.html?t=test-token';
const BASE = {
  reference: 'CH-K7Q2M', status: 'paid', mode: 'single', firstName: 'Sam',
  from: 'Kandy', to: 'Ella', date: 'to confirm', endDate: 'to confirm', time: 'to confirm',
  travellers: 2, vehicleType: 'car', totalCents: 12400, balanceDueCents: 0, amountDueNowCents: 0, currency: 'USD',
};
const DAY = futureIsoDate(30);

async function stub(page, view, schedule) {
  // By pathname: the older specs' '**/bookings/view*' glob would also swallow /view/schedule.
  await page.route((u) => u.pathname.endsWith('/bookings/view'), (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(view) }));
  await page.route((u) => u.pathname.endsWith('/bookings/view/schedule'), schedule);
  await page.route('https://www.googletagmanager.com/**', (r) => r.fulfill({ status: 200, body: '' }));
}
// The datepicker keeps a real <input type=date>: set it the way a day click does.
async function pickDate(page, iso) {
  await page.locator('#pkdate').evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }, iso);
}

test('a booking with nothing set asks for it, and saves exactly what the button names', async ({ page }) => {
  let sent = null;
  await stub(page, BASE, async (r) => {
    sent = { body: JSON.parse(r.request().postData()), auth: r.request().headers().authorization };
    const view = { ...BASE, date: DAY, endDate: DAY, time: '09:00', scheduleSetBy: 'customer' };
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ view, emailed: true }) });
  });
  await page.goto(PAGE);
  await expect(page.locator('.pp-sub')).toHaveText('Pick-up date not set yet');
  await expect(page.locator('#pickup')).toContainText('Add your pick-up date & time');
  await page.locator('#pkopen').click();
  await expect(page.locator('#pksave')).toHaveText('Choose a date');
  await expect(page.locator('#pksave')).toBeDisabled();
  await pickDate(page, DAY);
  await expect(page.locator('#pksave')).toHaveText('Choose a pick-up time');
  await expect(page.locator('#pktime option').nth(1)).toHaveText('12:00 am · Night pickup');
  await page.locator('#pktime').selectOption('09:00');
  await expect(page.locator('#pksave')).toHaveText(/^Save \w{3} \d{1,2} \w{3} · 9:00 am$/);
  await page.locator('#pksave').click();
  expect(sent).toEqual({ body: { date: DAY, time: '09:00' }, auth: 'Bearer test-token' });
  await expect(page.locator('#pickup')).toContainText('Pick-up set');
  await expect(page.locator('.fact', { hasText: 'Pick-up time' })).toContainText('9:00 am');
  await expect(page.locator('body')).not.toContainText('set by you');
});

test('an airport arrival is asked for a landing time in 15-minute steps', async ({ page }) => {
  await stub(page, { ...BASE, from: 'Colombo Airport (CMB)' }, (r) => r.abort());
  await page.goto(PAGE);
  await page.locator('#pkopen').click();
  await expect(page.locator('#pickup')).toContainText('When does your flight land?');
  await pickDate(page, DAY);
  await page.locator('#pktime').selectOption('08:45');
  await expect(page.locator('#pksave')).toHaveText(/^Save landing .* · 8:45 am$/);
});

test('"Don\'t know yet" saves the date alone', async ({ page }) => {
  let body = null;
  await stub(page, BASE, async (r) => {
    body = JSON.parse(r.request().postData());
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ view: { ...BASE, date: DAY, endDate: DAY }, emailed: true }) });
  });
  await page.goto(PAGE);
  await page.locator('#pkopen').click();
  await pickDate(page, DAY);
  await page.locator('#pkdk').check();
  await expect(page.locator('#pksave')).toHaveText(/· time later$/);
  await page.locator('#pksave').click();
  expect(body).toEqual({ date: DAY, time: null });
});

test('the reminder link (#pickup) lands with the form already open', async ({ page }) => {
  await stub(page, BASE, (r) => r.abort());
  await page.goto(PAGE + '#pickup');
  await expect(page.locator('#pkdate')).toBeAttached();
  await expect(page.locator('#pickup')).toBeInViewport();
});

test('a date ops already set is shown fixed; only the time is asked for', async ({ page }) => {
  await stub(page, { ...BASE, date: DAY, endDate: DAY, scheduleSetBy: 'staff' }, (r) => r.abort());
  await page.goto(PAGE);
  await expect(page.locator('#pickup')).toContainText('Add your pick-up time');
  await expect(page.locator('#pickup')).toContainText('set by our team');
  await expect(page.locator('#pkdate')).toHaveCount(0);
  await expect(page.locator('#pkdk')).toHaveCount(0);
});

test('the team got there first: says so and shows their value', async ({ page }) => {
  await stub(page, BASE, (r) => r.fulfill({ status: 409, contentType: 'application/json',
    body: JSON.stringify({ error: 'already_set', current: { date: DAY, time: '10:00' } }) }));
  await page.goto(PAGE);
  await page.locator('#pkopen').click();
  await pickDate(page, DAY);
  await page.locator('#pktime').selectOption('09:00');
  await page.locator('#pksave').click();
  await expect(page.locator('#pickup')).toContainText('Our team has already set your pick-up');
  await expect(page.locator('#pickup')).toContainText('10:00 am');
});

test('too soon (server says so): explains and offers WhatsApp', async ({ page }) => {
  await stub(page, BASE, (r) => r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'too_soon' }) }));
  await page.goto(PAGE);
  await page.locator('#pkopen').click();
  await pickDate(page, DAY);
  await page.locator('#pktime').selectOption('09:00');
  await page.locator('#pksave').click();
  await expect(page.locator('#pkerr')).toBeVisible();
  await expect(page.locator('#pkerr')).toContainText('12 hours');
});

test('a failed save says nothing changed and keeps the choice', async ({ page }) => {
  await stub(page, BASE, (r) => r.fulfill({ status: 500, body: '' }));
  await page.goto(PAGE);
  await page.locator('#pkopen').click();
  await pickDate(page, DAY);
  await page.locator('#pktime').selectOption('09:00');
  await page.locator('#pksave').click();
  await expect(page.locator('#pkfail')).toContainText('nothing has changed');
  await expect(page.locator('#pktime')).toHaveValue('09:00');
  await expect(page.locator('#pksave')).toBeEnabled();
});

test('no card on a booking the customer cannot edit, or once both are set', async ({ page }) => {
  for (const view of [{ ...BASE, status: 'cancelled' }, { ...BASE, status: 'payment_pending' }, { ...BASE, date: DAY, endDate: DAY, time: '09:00' }]) {
    await stub(page, view, (r) => r.abort());
    await page.goto(PAGE);
    await expect(page.locator('.ticket')).toBeVisible();
    await expect(page.locator('#pickup')).toHaveCount(0);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
});
```

- [ ] **Step 2: Run it and watch it fail.**
Run: `npm --prefix "$PWD/web-tests" exec -- playwright test e2e/manage-pickup.spec.js`
Expected: FAIL. `#pickup` is not found.

- [ ] **Step 3: Implement.**

1. In `manage.html`'s `<head>`, after `checkout-handoff.js`, add `<script src="datepicker.js"></script>`. `npm run stamp` adds the `?v=` in Step 4.

2. In `api/src/routes/customerPages.ts` `ASSETS`, after `checkout-handoff.js`, add:
```ts
  ['datepicker.js', JS], // the site's date picker — manage.html's pickup card (dateless Phase 4)
```
`customerPages.test.ts:43` ("serves every local script … the customer pages reference") fails until you add this line. That's the guard working.

3. Add the card styles to `manage.html`'s `<style>`. These are the reviewed mockup's v2 styles: `.pk`, `.pk-top`, `.pk-ic`, `.pk h2`, `.pk p`, `.pk .btn`, `.pk .btn:disabled`, `.pk-fine`, `.pk-row`, `.pk-lbl`, `.pk-chk`, `.pk-fixed`, `.pk select`, `.pk-pill`, `.pk-err`, `.pk-later`, `.pk.ok`, `.pk.info`. Copy them verbatim:

```css
  /* The pickup card (dateless capture Phase 4): one thing left to do, above the ticket. */
  .pk{background:var(--paper);border:1px solid var(--warn-line);border-radius:var(--r);box-shadow:var(--shadow-s);padding:16px 18px;margin:0 0 14px;scroll-margin-top:16px}
  .pk-top{display:flex;gap:12px;align-items:flex-start}
  .pk-ic{width:36px;height:36px;border-radius:50%;background:var(--warn-bg);color:#c98a1a;display:grid;place-items:center;flex:none}
  .pk-ic svg{width:20px;height:20px}
  .pk h2{font-family:var(--display);font-weight:700;font-size:1.2rem;line-height:1.15;margin:2px 0 4px}
  .pk p{font-size:.84rem;line-height:1.5;color:var(--ink-soft);margin:0}
  .pk .btn{width:100%;margin-top:16px}
  .pk .btn:disabled{background:var(--cream-deep);color:var(--ink-soft);box-shadow:none;cursor:default;transform:none}
  .pk-fine{font-size:.74rem;color:var(--ink-soft);text-align:center;margin-top:9px}
  .pk-fine a,.pk p a,.pk-err a{color:var(--accent-deep);font-weight:700;text-decoration:none}
  .pk-row{display:flex;justify-content:space-between;align-items:center;margin:16px 0 6px}
  .pk-lbl{font-size:.64rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-soft)}
  .pk-lbl i{font-style:normal;text-transform:none;letter-spacing:0;font-weight:600}
  .pk-chk{display:flex;align-items:center;gap:6px;font-size:.78rem;font-weight:600;color:var(--ink-soft);cursor:pointer}
  .pk-chk input{width:16px;height:16px;accent-color:var(--btn-accent)}
  .pk-fixed{font-weight:700;font-size:.95rem;padding:.72rem .8rem;border:1.5px dashed var(--line);border-radius:10px;background:var(--cream)}
  .pk-fixed small{font-weight:600;color:var(--ink-soft);font-size:.74rem;margin-left:6px}
  .pk select{width:100%;padding:.72rem .8rem;border:1.5px solid var(--line);border-radius:10px;font-family:inherit;font-size:.95rem;background:var(--white);color:var(--ink)}
  .pk-pill{display:flex;align-items:center;gap:.5rem;background:var(--warn-bg);border:1px solid var(--warn-line);border-radius:10px;padding:.72rem .8rem;font-size:.84rem;color:var(--warn)}
  /* .pk-pill and .pk select set a display, so [hidden] has to be said. */
  .pk-pill[hidden],.pk select[hidden],.pk-err[hidden]{display:none}
  .pk-err{margin-top:12px;padding:10px 13px;border-radius:12px;background:#fdecea;border:1px solid #f4c7c0;color:#b23214;font-size:.82rem;font-weight:600;line-height:1.45}
  .pk-later{display:block;width:100%;background:none;border:0;margin-top:4px;font:700 .82rem var(--body);color:var(--ink-soft);cursor:pointer;padding:6px}
  .pk.ok{border-color:var(--ok-line);background:var(--ok-bg)}
  .pk.ok .pk-ic{background:#fff;color:var(--ok)}
  .pk.ok h2{color:var(--ok)}
  .pk.info{border-color:var(--pc-line);background:var(--pc-sky)}
  .pk.info .pk-ic{background:#fff;color:var(--accent-deep)}
```

4. In the IIFE, after Task 5's helpers, add the card. `cardMode` is per page load: `'saved'` only right after a save, `'conflict'` after a 409. A reload starts from the server's view again.

```js
  var IC_CLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5" stroke-dasharray="3.3 3.3"/><path d="M12 12V7.6M12 12l3.5 2.1"/></svg>';
  var IC_PLANE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 17h18M5.5 13.5l3.2-.9L6 7.5l1.6-.5 5 4.3 4.6-1.3a1.6 1.6 0 0 1 .9 3.1L6.6 16"/></svg>';
  var IC_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M8.5 12.5l2.4 2.4 4.8-5"/><circle cx="12" cy="12" r="9"/></svg>';
  var IC_INFO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>';
  var WA_LINK = '<a href="https://wa.me/94779669662" target="_blank" rel="noopener">WhatsApp us</a>';
  var cardMode = null; // null | 'open' | 'saved' | 'conflict'
  var cardFail = false;
  // 12 h notice in Sri Lanka time (UTC+5:30), as booking.js and the server's isTooSoonPrivate do.
  // The server re-checks; this only stops the button offering what will be refused.
  function tooSoon(iso, time){
    var p = isoParts(iso); if (!p) return false;
    var q = (time || '23:59').split(':').map(Number);
    return Date.UTC(p.y, p.mo - 1, p.d, q[0], q[1]) - 330 * 60000 - Date.now() < 12 * 3600000;
  }
  function pickupCard(v){
    var air = isAirport(v), icon = air ? IC_PLANE : IC_CLOCK;
    if (cardMode === 'saved') return '<div class="pk ok" id="pickup"><div class="pk-top"><span class="pk-ic">' + IC_OK + '</span><div>'
      + '<h2>Pick-up set</h2><p><b>' + esc(shortDate(v.date)) + (v.time && v.time !== 'to confirm' ? ' · ' + esc(fmtTime(v.time)) + '</b> Sri Lanka time' : '</b>, time to follow')
      + '. We’ve emailed you a copy.</p><p style="margin-top:6px">Need to change it? ' + WA_LINK + '.</p></div></div></div>';
    if (cardMode === 'conflict') return '<div class="pk info" id="pickup"><div class="pk-top"><span class="pk-ic">' + IC_INFO + '</span><div>'
      + '<h2>Our team has already set your pick-up</h2><p><b>' + esc(shortDate(v.date))
      + (v.time && v.time !== 'to confirm' ? ' · ' + esc(fmtTime(v.time)) : '') + '</b> Sri Lanka time, so we didn’t save yours.</p>'
      + '<p style="margin-top:6px">Not right? ' + WA_LINK + ' and we’ll fix it.</p></div></div></div>';
    var needs = pickupNeeds(v);
    if (!needs) return '';
    if (needs !== 'time' && cardMode !== 'open') return '<div class="pk" id="pickup"><div class="pk-top"><span class="pk-ic">' + icon + '</span><div>'
      + '<h2>' + (air ? 'Add your landing date &amp; time' : 'Add your pick-up date &amp; time') + '</h2>'
      + '<p>You booked with “Decide later”. Add it here once you know, and we’ll book your driver.</p></div></div>'
      + '<button class="btn btn-primary" id="pkopen">Add date &amp; time</button>'
      + '<div class="pk-fine">You can set this once. To change it afterwards, ' + WA_LINK + '.</div></div>';
    var timeOnly = needs === 'time';
    var opts = '<option value="" selected disabled>' + (air ? 'Choose a landing time…' : 'Choose a pick-up time…') + '</option>'
      + timeChoices(v).map(function(c){ return '<option value="' + c.value + '">' + esc(c.label) + '</option>'; }).join('');
    return '<div class="pk" id="pickup"><div class="pk-top"><span class="pk-ic">' + icon + '</span><div>'
      + '<h2>' + (timeOnly ? (air ? 'Add your landing time' : 'Add your pick-up time') : (air ? 'When does your flight land?' : 'When should we pick you up?')) + '</h2>'
      + '<p>' + (air ? 'Your driver will be waiting at arrivals in ' + esc(v.from) + '.' : 'From ' + esc(v.from) + ', any time of day.') + '</p></div></div>'
      + '<div class="pk-row"><span class="pk-lbl">' + (air ? 'Landing date' : 'Pick-up date') + '</span></div>'
      + (timeOnly
          ? '<div class="pk-fixed">' + esc(shortDate(v.date)) + (v.scheduleSetBy === 'staff' ? '<small>set by our team</small>' : '') + '</div>'
          : '<input type="date" id="pkdate" data-placeholder="Choose a date" aria-label="' + (air ? 'Landing date' : 'Pick-up date') + '">')
      + '<div class="pk-row"><span class="pk-lbl">' + (air ? 'Landing time' : 'Pick-up time') + ' <i>· Sri Lanka time</i></span>'
      + (timeOnly ? '' : '<label class="pk-chk"><input type="checkbox" id="pkdk"> Don’t know yet</label>') + '</div>'
      + '<select id="pktime" aria-label="' + (air ? 'Landing time' : 'Pick-up time') + '">' + opts + '</select>'
      + '<div class="pk-pill" id="pkpill" hidden>No time yet. You can add it here later.</div>'
      + '<div class="pk-err" id="pkerr" role="alert" hidden>That’s less than 12 hours away, too soon to set here. ' + WA_LINK + ' and we’ll do our best to fit you in.</div>'
      + '<div class="pk-err" id="pkfail" role="alert"' + (cardFail ? '' : ' hidden') + '>We couldn’t save that, so nothing has changed. Try again, or ' + WA_LINK + '.</div>'
      + '<button class="btn btn-primary" id="pksave" disabled>Choose a date</button>'
      + '<div class="pk-fine">Once saved, changes go through ' + WA_LINK + '.</div>'
      + (timeOnly ? '' : '<button class="pk-later" id="pklater">Not now</button>') + '</div>';
  }
  function wirePickup(v){
    var open = document.getElementById('pkopen');
    if (open) open.addEventListener('click', function(){ cardMode = 'open'; render(v); focusCard(); });
    var later = document.getElementById('pklater');
    if (later) later.addEventListener('click', function(){ cardMode = null; render(v); });
    var dIn = document.getElementById('pkdate'), tIn = document.getElementById('pktime');
    if (!tIn) return;
    if (dIn && window.enhanceDate) window.enhanceDate(dIn);
    var dk = document.getElementById('pkdk'), pill = document.getElementById('pkpill');
    var err = document.getElementById('pkerr'), fail = document.getElementById('pkfail'), save = document.getElementById('pksave');
    function state(){ return { date: dIn ? dIn.value : v.date, time: tIn.value, noTime: !!(dk && dk.checked) }; }
    function upd(){
      var s = state();
      tIn.hidden = s.noTime; pill.hidden = !s.noTime;
      var soon = !!s.date && tooSoon(s.date, s.noTime ? '' : s.time);
      err.hidden = !soon;
      var label = saveLabel(v, s.date, s.time, s.noTime, soon);
      save.textContent = label.text; save.disabled = !label.ready;
    }
    [dIn, tIn, dk].forEach(function(el){ if (el) el.addEventListener('change', function(){ fail.hidden = true; upd(); }); });
    upd();
    save.addEventListener('click', function(){
      var s = state();
      save.disabled = true;
      fetch(A + '/bookings/view/schedule', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t },
        // Send only what this card fills: a date ops already set goes back unchanged (set-once).
        body: JSON.stringify({ date: dIn ? s.date : v.date, time: s.noTime ? null : s.time }),
      }).then(function(res){
        return res.json().catch(function(){ return {}; }).then(function(b){ return { status: res.status, body: b }; });
      }).then(function(r){
        if (r.status === 200 && r.body.view) { cardMode = 'saved'; cardFail = false; render(r.body.view); focusCard(); return; }
        if (r.status === 409 && r.body.current) {
          cardMode = 'conflict';
          render(Object.assign({}, v, { date: r.body.current.date || 'to confirm', endDate: r.body.current.date || 'to confirm', time: r.body.current.time || 'to confirm', scheduleSetBy: 'staff' }));
          return;
        }
        // The server's clock wins over the page's: show the 12 h message even if upd() thought it fine.
        if (r.status === 400 && (r.body.error === 'too_soon' || r.body.error === 'past')) { upd(); err.hidden = false; save.disabled = true; return; }
        throw new Error('schedule ' + r.status);
      }).catch(function(e){
        report('bookings/view/schedule failed', e);
        fail.hidden = false; save.disabled = false;
      });
    });
  }
  // After a re-render, keep the card where the customer is looking.
  function focusCard(){ var el = document.getElementById('pickup'); if (el) el.scrollIntoView({ block: 'start' }); }
```

5. In `render(v, …)`:
   - Append `+ pickupCard(v)` right after the `pp-sub` paragraph in the `html` string.
   - Right after `paint(html);`, add `wirePickup(v);`.
   - At the top of the IIFE's boot, just before `fetch(A + '/bookings/view?t=' …)`, add a one-time deep-link check, so `#pickup` opens the form on the first render only:

```js
  // The reminder email's main button links here with #pickup: land with the form already open.
  if (location.hash === '#pickup') cardMode = 'open';
```

   Inside `render`, after `wirePickup(v);`, add:

```js
    if (location.hash === '#pickup' && cardMode === 'open') focusCard();
```

`report(…)` is the page's existing handled-error reporter (used in `renderReturn`). Before relying on it, `grep -n "function report" manage.html`. If it's named differently there, use that name.

- [ ] **Step 4: Stamp, then run the tests and watch them pass.**
Run, from the worktree root:
```bash
npm run stamp
npm --prefix "$PWD/web-tests" exec -- playwright test e2e/manage-pickup.spec.js e2e/manage-page.spec.js e2e/manage.spec.js e2e/manage-redirect.spec.js
cd api && npx vitest run src/routes/customerPages.test.ts
```
Expected: all pass. `npm run stamp` rewrites `datepicker.js` to `datepicker.js?v=<hash>` in `manage.html`.

- [ ] **Step 5: Check it in the browser.** Start the static preview and open `manage.html?t=x` with `/bookings/view` stubbed, the same way the mockup did. Look at it at 375 px wide in each state:
- needs both
- picking
- don't know yet
- too soon
- save failed
- saved
- time only
- team set it
- airport

Take a screenshot of each for the PR.

- [ ] **Step 6: Full gate, then commit.**
Run: `cd api && npm run check` and `npm --prefix "$PWD/web-tests" run test:all`. Expected: both exit 0.

```bash
git add manage.html api/src/routes/customerPages.ts web-tests/e2e/manage-pickup.spec.js
git commit -m "feat(manage): customer sets a blank pickup date/time once (dateless Phase 4)"
```

---

### Task 7: Record the decisions; open the PR

**Files:**
- Modify: `docs/superpowers/specs/2026-10-17-dateless-booking-capture-design.md` (§3 and §5)

- [ ] **Step 1: Update the spec.**
- Under §3, add a **D5 (owner, 2026-10-21)** bullet:
  - Airport pickups are asked for the landing time, in 15-minute steps.
  - The save button names its value; there is no extra confirm step.
  - "Pick-up set" shows only right after saving.
  - "Set by our team" appears when ops set it; the page never says "set by you".
  - The reminder email's main button opens the form (`#pickup`), with WhatsApp as the fallback.
- In the §5 table's Phase 4 row, append `— plan: docs/superpowers/plans/2026-10-21-dateless-booking-phase-4-manage-set-once.md`.

- [ ] **Step 2: Commit, push and open the PR.**

```bash
git add docs/superpowers/specs/2026-10-17-dateless-booking-capture-design.md
git commit -m "docs(spec): dateless capture — Phase 4 decisions (2026-10-21)"
git push -u origin feat/manage-set-pickup
```

The PR body must include:
- **red→green evidence** for each task (the failing run and the passing run)
- **No migration.** Say so explicitly.
- **The two copy changes existing tests pinned:**
  - `manage-page.spec.js`: "To be confirmed" became "Not set yet", and the airport fixture's row is now "Landing time".
  - `notifications.test.ts`: the reminder tests moved to a non-airport fixture.
- the Step 5 screenshots
- **Release note:** it reaches staging on merge and prod only through the owner's `main → production` promote. Before promoting, set a date on an undated staging booking through its manage link. Check that both emails arrive: the customer's "Your pickup is set" and the team's "Date set:".

## Not in this phase (noted, not built)

- Booking-page times stay hourly. 15-minute steps are for airport landings on the manage page only.
- The confirmation, trip-reminder and other emails keep "Date & time" / "pickup". Only the reminder and "pickup set" emails say "landing".
- Emails keep 24-hour times. Only the manage page shows 12-hour times.
- Flight number (L2), rough travel month (L1), chauffeur per-day dates (L3), exact pickup spot (L4).
