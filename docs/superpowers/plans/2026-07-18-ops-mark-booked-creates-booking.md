# Ops "Mark booked" creates a Booking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ops quote tool's "Mark booked" button create a first-class `Booking` from the quote (behind a confirmation modal), populating `quotes.convertedBookingId` + status `won` so the booking appears in the bookings tab.

**Architecture:** A new `bookings:operate`-gated endpoint `POST /admin/quote/:id/book` loads the quote, maps its stored engine itinerary + the modal's contact/date/vehicle into a booking input (pure `quoteToBooking` module), creates a `draft` booking at the quote's frozen price, and stamps the quote. Idempotent on the quote id. The "Mark booked" button opens the modal instead of directly flipping status.

**Tech Stack:** Node 20 · TypeScript (strict) · Hono · Zod · Vitest · Drizzle/Postgres · npm. Backend in `api/`.

**Spec:** [docs/superpowers/specs/2026-07-18-ops-mark-booked-creates-booking-design.md](../specs/2026-07-18-ops-mark-booked-creates-booking-design.md)

## Global Constraints

- **Money = integer minor units + ISO currency.** The booking's `total`/`amountDueNow` are `quote.totalCents` verbatim — **never re-priced**.
- **No schema change / no migration.** The `converted_booking_id` column already exists. Do **not** run `npm run generate` or add a migration.
- **No pricing edits.** Do not touch `rateCard.ts` / `departureRepo.ts` or any `@generated:` block.
- **Green gate before every commit:** `cd api && npm run check` (typecheck + lint + test) must pass. For the UI task also run `npm run test:all` (web-tests) and verify in the browser preview.
- **TDD, red→green:** write the test, run it to see it FAIL, implement, run it GREEN. Paste red→green evidence in the PR.
- **Stage by path.** `git add <exact paths>` — never `git add -A` (multiple chats share this tree).
- **Commit footer:** end each commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## File Structure

- **Create** `api/src/quote/quoteToBooking.ts` — pure mapping: stored quote engine request + modal details → `{ mode, input, distanceKm }`.
- **Create** `api/src/quote/quoteToBooking.test.ts` — mapping unit tests.
- **Modify** `api/src/db/quoteRepo.ts` — add `convertedBookingId` to `QuotePatch`; apply it in `InMemoryQuoteRepo.patch`.
- **Modify** `api/src/db/postgresQuoteRepo.ts` — apply `convertedBookingId` in `PostgresQuoteRepo.patch`.
- **Modify** `api/src/db/quoteRepo.test.ts` — patch-sets-convertedBookingId test.
- **Modify** `api/src/routes/internalQuote.ts` — `bookings` dep, `BookingDetailsSchema`, `POST /:id/book`.
- **Modify** `api/src/app.ts` — pass `bookings` into `internalQuoteRoutes(...)`.
- **Modify** `api/src/routes/internalQuote.test.ts` — endpoint route tests.
- **Modify** `api/src/routes/ops-ui.html` — button show-condition, `markWon` opens the modal, the booking modal + submit.

---

### Task 1: Add `convertedBookingId` to `QuotePatch` and both repos

**Files:**
- Modify: `api/src/db/quoteRepo.ts` (the `QuotePatch` interface ~109-123; `InMemoryQuoteRepo.patch` ~247-269)
- Modify: `api/src/db/postgresQuoteRepo.ts` (`PostgresQuoteRepo.patch` ~147-182)
- Test: `api/src/db/quoteRepo.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `QuotePatch.convertedBookingId?: string` — a `patch(id, { convertedBookingId })` call sets the column; `SavedQuote.convertedBookingId` reflects it.

- [ ] **Step 1: Write the failing test**

Add to `api/src/db/quoteRepo.test.ts` (inside the existing top-level `describe`, matching the file's existing `new InMemoryQuoteRepo()` + `save(...)` usage):

```ts
it('patch stamps convertedBookingId (the booking a won quote became)', async () => {
  const repo = new InMemoryQuoteRepo();
  const q = await repo.save({
    product: 'private', totalCents: 21900, currency: 'USD',
    rateCardVersion: 'v1', request: {}, result: {},
  });
  const updated = await repo.patch(q.id, { convertedBookingId: 'booking-123', status: 'won' });
  expect(updated?.convertedBookingId).toBe('booking-123');
  expect(updated?.status).toBe('won');
  expect((await repo.get(q.id))?.convertedBookingId).toBe('booking-123');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx vitest run src/db/quoteRepo.test.ts -t "convertedBookingId"`
Expected: FAIL — `updated.convertedBookingId` is `null` (patch ignores the field), so `toBe('booking-123')` fails.

- [ ] **Step 3: Implement**

In `api/src/db/quoteRepo.ts`, add the field to `QuotePatch` (after `updatedBy?`):

```ts
  updatedBy?: string | null;
  // Back-link to the booking a won quote became. System-set only — POST /admin/quote/:id/book
  // writes it; the ops PATCH route's zod schema deliberately does not accept it.
  convertedBookingId?: string;
}
```

In `InMemoryQuoteRepo.patch`, add before `row.updatedAt = now;`:

```ts
    if (patch.convertedBookingId !== undefined) row.convertedBookingId = patch.convertedBookingId;
```

In `api/src/db/postgresQuoteRepo.ts`, inside `patch`'s `.set({ ... })`, add alongside the other conditional spreads (e.g. after the `updatedBy` spread):

```ts
        ...(patch.convertedBookingId !== undefined ? { convertedBookingId: patch.convertedBookingId } : {}),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx vitest run src/db/quoteRepo.test.ts -t "convertedBookingId"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd api && npm run check
git add api/src/db/quoteRepo.ts api/src/db/postgresQuoteRepo.ts api/src/db/quoteRepo.test.ts
git commit -m "feat(quotes): allow patch to set convertedBookingId

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `quoteToBooking` mapping module

**Files:**
- Create: `api/src/quote/quoteToBooking.ts`
- Test: `api/src/quote/quoteToBooking.test.ts`

**Interfaces:**
- Consumes: `SavedQuote` (from `../db/quoteRepo`), `QuoteRequest` (from `./types`), `SingleTransferInput`/`TripInput`/`CustomerInput` (from `../domain/*`).
- Produces:
  - `interface BookingDetails { customer: CustomerInput; vehicleType: 'car'|'van'; pax: number; bags: number; date?: string; time?: string }`
  - `type MappedBooking = { mode:'single'; input: SingleTransferInput; distanceKm: number|null } | { mode:'trip'; input: TripInput; distanceKm: number|null }`
  - `class QuoteNotBookableError extends Error`
  - `function quoteToBooking(quote: SavedQuote, details: BookingDetails): MappedBooking`

- [ ] **Step 1: Write the failing tests**

Create `api/src/quote/quoteToBooking.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { quoteToBooking, QuoteNotBookableError, type BookingDetails } from './quoteToBooking';
import type { SavedQuote } from '../db/quoteRepo';

const CUST = { firstName: 'A', lastName: 'B', email: 'a@b.com', whatsapp: '+94123456', country: 'LK' };
const DETAILS: BookingDetails = { customer: CUST, vehicleType: 'car', pax: 2, bags: 1, date: '2026-08-01', time: '09:00' };

// Minimal SavedQuote for mapping — only request.engine + totals matter here.
function q(engine: unknown): SavedQuote {
  return { id: 'q1', reference: 'Q-1', channel: 'ops', status: 'sent', totalCents: 21900,
    currency: 'USD', request: { engine }, result: {}, convertedBookingId: null } as unknown as SavedQuote;
}

describe('quoteToBooking', () => {
  it('private single leg → single booking', () => {
    const m = quoteToBooking(q({ product: 'private', vehicle: 'car', pax: 2, bags: 1,
      legs: [{ from: 'CMB', to: 'Galle', distanceKm: 120 }] }), DETAILS);
    expect(m.mode).toBe('single');
    if (m.mode === 'single') {
      expect(m.input.from).toBe('CMB');
      expect(m.input.to).toBe('Galle');
      expect(m.input.adults).toBe(2);
      expect(m.input.children).toBe(0);
      expect(m.input.vehicleType).toBe('car');
      expect(m.input.customer.email).toBe('a@b.com');
    }
    expect(m.distanceKm).toBe(120);
  });

  it('private multi-leg → trip with chained stops', () => {
    const m = quoteToBooking(q({ product: 'private', vehicle: 'car', pax: 2, bags: 1, legs: [
      { from: 'CMB', to: 'Sigiriya', distanceKm: 170 },
      { from: 'Sigiriya', to: 'CMB', distanceKm: 170 }] }), DETAILS);
    expect(m.mode).toBe('trip');
    if (m.mode === 'trip') {
      expect(m.input.stops).toEqual(['CMB', 'Sigiriya', 'CMB']);
      expect(m.input.serviceType).toBe('private');
      expect(m.input.pax).toBe(2);
    }
    expect(m.distanceKm).toBe(340);
  });

  it('chauffeur → trip with days/driverNights from the date span', () => {
    const m = quoteToBooking(q({ product: 'chauffeur', vehicle: 'van',
      firstDate: '2026-08-01', lastDate: '2026-08-03', travelDays: [
        { date: '2026-08-01', from: 'CMB', to: 'Kandy', distanceKm: 120 },
        { date: '2026-08-03', from: 'Kandy', to: 'CMB', distanceKm: 120 }] }), DETAILS);
    expect(m.mode).toBe('trip');
    if (m.mode === 'trip') {
      expect(m.input.serviceType).toBe('chauffeur');
      expect(m.input.days).toBe(3);
      expect(m.input.driverNights).toBe(2);
      expect(m.input.stops).toEqual(['CMB', 'Kandy', 'CMB']);
    }
  });

  it('shared or engine-less quote is not bookable', () => {
    expect(() => quoteToBooking(q({ product: 'shared', legs: [] }), DETAILS)).toThrow(QuoteNotBookableError);
    expect(() => quoteToBooking(q(undefined), DETAILS)).toThrow(QuoteNotBookableError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && npx vitest run src/quote/quoteToBooking.test.ts`
Expected: FAIL — `Cannot find module './quoteToBooking'`.

- [ ] **Step 3: Implement**

Create `api/src/quote/quoteToBooking.ts`:

```ts
import type { SavedQuote } from '../db/quoteRepo';
import type { QuoteRequest } from './types';
import type { SingleTransferInput, CustomerInput } from '../domain/singleTransfer';
import type { TripInput } from '../domain/trip';

// The booking fields the quote can't supply — collected by the ops "Mark booked" modal.
export interface BookingDetails {
  customer: CustomerInput;
  vehicleType: 'car' | 'van';
  pax: number;
  bags: number;
  date?: string;
  time?: string;
}

export type MappedBooking =
  | { mode: 'single'; input: SingleTransferInput; distanceKm: number | null }
  | { mode: 'trip'; input: TripInput; distanceKm: number | null };

// The quote has no bookable itinerary (shared, or a legacy row with no engine request).
export class QuoteNotBookableError extends Error {}

function sumKm(legs: { distanceKm: number }[]): number | null {
  if (!legs.length) return null;
  const total = legs.reduce((a, l) => a + (Number(l.distanceKm) || 0), 0);
  return total > 0 ? Math.round(total) : null;
}

// Inclusive day span between two ISO dates (e.g. 08-01..08-03 = 3 days).
function daySpan(firstDate: string, lastDate: string): number {
  const ms = Date.parse(lastDate) - Date.parse(firstDate);
  if (Number.isNaN(ms)) return 1;
  return Math.max(1, Math.round(ms / 86_400_000) + 1);
}

// Map a stored ops quote's engine request + the modal details into a bookable input.
// Private single-leg → single; private multi-leg or chauffeur → trip. Shared / engine-less
// quotes throw (ops quotes are private/chauffeur; nothing else reaches this path).
export function quoteToBooking(quote: SavedQuote, details: BookingDetails): MappedBooking {
  const engine = (quote.request as { engine?: QuoteRequest } | null)?.engine;
  if (!engine || engine.product === 'shared') {
    throw new QuoteNotBookableError('quote has no bookable itinerary');
  }

  if (engine.product === 'private') {
    const legs = engine.legs;
    if (!legs.length) throw new QuoteNotBookableError('private quote has no legs');
    const distanceKm = sumKm(legs);
    if (legs.length === 1) {
      return {
        mode: 'single',
        distanceKm,
        input: {
          from: legs[0].from,
          to: legs[0].to,
          date: details.date,
          time: details.time,
          vehicleType: details.vehicleType,
          adults: details.pax,
          children: 0,
          bags: details.bags,
          customer: details.customer,
        },
      };
    }
    return {
      mode: 'trip',
      distanceKm,
      input: {
        stops: [legs[0].from, ...legs.map((l) => l.to)],
        nights: [],
        dates: details.date ? [details.date] : undefined,
        pax: details.pax,
        vehicleType: details.vehicleType,
        serviceType: 'private',
        customer: details.customer,
      },
    };
  }

  // chauffeur
  const days = [...engine.travelDays].sort((a, b) => a.date.localeCompare(b.date));
  if (!days.length) throw new QuoteNotBookableError('chauffeur quote has no travel days');
  const span = daySpan(engine.firstDate, engine.lastDate);
  return {
    mode: 'trip',
    distanceKm: sumKm(days),
    input: {
      stops: [days[0].from, ...days.map((d) => d.to)],
      nights: [],
      dates: days.map((d) => d.date),
      pax: details.pax,
      vehicleType: details.vehicleType,
      serviceType: 'chauffeur',
      customer: details.customer,
      days: span,
      driverNights: Math.max(0, span - 1),
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && npx vitest run src/quote/quoteToBooking.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd api && npm run check
git add api/src/quote/quoteToBooking.ts api/src/quote/quoteToBooking.test.ts
git commit -m "feat(quotes): map a stored quote itinerary to a bookable input

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `POST /admin/quote/:id/book` endpoint (+ wiring)

**Files:**
- Modify: `api/src/routes/internalQuote.ts` (imports; `deps` type + `bookings`; a `BookingDetailsSchema`; the new route — register right after `r.post('/save', ...)`)
- Modify: `api/src/app.ts` (line ~211 — add `bookings` to the `internalQuoteRoutes({...})` call)
- Test: `api/src/routes/internalQuote.test.ts`

**Interfaces:**
- Consumes: `quoteToBooking`, `QuoteNotBookableError`, `BookingDetails` (Task 2); `QuotePatch.convertedBookingId` (Task 1); `BookingRepo`, `NewBooking` (`../db/bookingRepo`); `SingleTransferInput`, `TripInput`, `CustomerInput` (`../domain/*`).
- Produces: `POST /admin/quote/:id/book` → `201` booking (created) · `200` booking (already booked, idempotent) · `404`/`409`/`400`/`403`.

- [ ] **Step 1: Write the failing tests**

In `api/src/routes/internalQuote.test.ts`, add the import (top of file, with the other imports):

```ts
import { InMemoryBookingRepo } from '../db/bookingRepo';
```

Add this `describe` block at the end of the file (it reuses the file's existing `createApp`, `cookie`, `AUTH`, `FOUNDER_COOKIE`):

```ts
describe('POST /admin/quote/:id/book — create a booking from a quote', () => {
  const BODY = {
    customer: { firstName: 'A', lastName: 'B', email: 'a@b.com', whatsapp: '+94123456', country: 'LK' },
    vehicleType: 'car', pax: 2, bags: 1, date: '2026-08-01', time: '09:00',
  };

  async function sentQuote(quotes: InMemoryQuoteRepo) {
    const q = await quotes.save({
      channel: 'ops', product: 'private', vehicle: 'car', totalCents: 21900, currency: 'USD',
      rateCardVersion: 'v1', result: {},
      request: { engine: { product: 'private', vehicle: 'car', pax: 2, bags: 1,
        legs: [{ from: 'CMB', to: 'Galle', distanceKm: 120 }] } },
    });
    await quotes.patch(q.id, { status: 'sent' });
    return q.id;
  }

  function book(app: App, id: string, body: unknown, cookieStr = FOUNDER_COOKIE) {
    return app.request(`/admin/quote/${id}/book`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieStr },
      body: JSON.stringify(body),
    });
  }

  it('books a sent quote: draft booking at the quote price, quote stamped won+linked', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const id = await sentQuote(quotes);
    const res = await book(createApp({ quotes, bookings }), id, BODY);
    expect(res.status).toBe(201);
    const b = await res.json();
    expect(b.status).toBe('draft');
    expect(b.mode).toBe('single');
    expect(b.total).toBe(21900);
    expect(b.amountDueNow).toBe(21900);
    const q = await quotes.get(id);
    expect(q?.status).toBe('won');
    expect(q?.convertedBookingId).toBe(b.id);
    expect(await bookings.get(b.id)).not.toBeNull();
  });

  it('books an already-won quote (backfill) and leaves it won', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const id = await sentQuote(quotes);
    await quotes.patch(id, { status: 'won' });
    const res = await book(createApp({ quotes, bookings }), id, BODY);
    expect(res.status).toBe(201);
    const q = await quotes.get(id);
    expect(q?.status).toBe('won');
    expect(q?.convertedBookingId).toBeTruthy();
  });

  it('is idempotent: a second book returns the same booking, no duplicate', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const id = await sentQuote(quotes);
    const app = createApp({ quotes, bookings });
    const first = await (await book(app, id, BODY)).json();
    const res2 = await book(app, id, BODY);
    expect(res2.status).toBe(200);
    expect((await res2.json()).id).toBe(first.id);
    expect((await bookings.list()).length).toBe(1);
  });

  it('requires bookings:operate — finance is 403', async () => {
    const quotes = new InMemoryQuoteRepo();
    const id = await sentQuote(quotes);
    const res = await book(createApp({ quotes, bookings: new InMemoryBookingRepo() }), id, BODY, cookie('fin@x.com'));
    expect(res.status).toBe(403);
  });

  it('rejects a non-sent/won quote with 409', async () => {
    const quotes = new InMemoryQuoteRepo();
    const q = await quotes.save({
      channel: 'ops', product: 'private', vehicle: 'car', totalCents: 1000, currency: 'USD',
      rateCardVersion: 'v1', result: {},
      request: { engine: { product: 'private', vehicle: 'car', pax: 1, bags: 0,
        legs: [{ from: 'A', to: 'B', distanceKm: 10 }] } },
    }); // stays 'draft'
    const res = await book(createApp({ quotes, bookings: new InMemoryBookingRepo() }), q.id, BODY);
    expect(res.status).toBe(409);
  });

  it('rejects missing required contact fields with 400', async () => {
    const quotes = new InMemoryQuoteRepo();
    const id = await sentQuote(quotes);
    const bad = { ...BODY, customer: { firstName: 'A', lastName: 'B' } };
    const res = await book(createApp({ quotes, bookings: new InMemoryBookingRepo() }), id, bad);
    expect(res.status).toBe(400);
  });

  it('404s an unknown quote', async () => {
    const res = await book(createApp({ quotes: new InMemoryQuoteRepo(), bookings: new InMemoryBookingRepo() }), 'nope', BODY);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts -t "create a booking from a quote"`
Expected: FAIL — the route doesn't exist, so `POST /admin/quote/:id/book` returns 404 (or the `bookings` dep isn't wired), failing the 201 assertions.

- [ ] **Step 3: Implement — wire `bookings` + add the route**

In `api/src/routes/internalQuote.ts`, extend the imports:

```ts
import { SingleTransferInput, CustomerInput } from '../domain/singleTransfer';
import { TripInput } from '../domain/trip';
import type { BookingRepo, NewBooking } from '../db/bookingRepo';
import { quoteToBooking, QuoteNotBookableError } from '../quote/quoteToBooking';
```

Add `bookings` to the `internalQuoteRoutes` deps type (alongside `quotes: QuoteRepo;`):

```ts
  quotes: QuoteRepo;
  bookings: BookingRepo;
```

Add the request schema near the top of the module (below `ToolRequestSchema`):

```ts
// The fields the "Mark booked" modal supplies that the quote itself doesn't carry.
// CustomerInput enforces the full contactable set (email/whatsapp/country required).
const BookingDetailsSchema = z.object({
  customer: CustomerInput,
  vehicleType: z.enum(['car', 'van']),
  pax: z.number().int().min(1),
  bags: z.number().int().min(0),
  date: z.string().optional(),
  time: z.string().optional(),
});
```

Register the route immediately after `r.post('/save', ...)` (inside `internalQuoteRoutes`, so `csrf` and `deps` are in scope):

```ts
  // Create a real booking from a booked quote (spec 2026-07-18). The ops "Mark booked" modal
  // POSTs the contact/date/vehicle the quote lacks; the booking is priced at the quote's frozen
  // total (never re-priced) and the quote is stamped with the back-link + 'won'. Idempotent on
  // the quote id — a double-submit or a mid-failure retry returns the same booking.
  r.post('/:id/book', csrf, requireCap('bookings:operate'), async (c) => {
    const id = c.req.param('id');
    const quote = await deps.quotes.get(id);
    if (!quote) return c.json({ error: 'not_found' }, 404);
    if (quote.channel !== 'ops' || (quote.status !== 'sent' && quote.status !== 'won')) {
      return c.json({ error: 'not_bookable', status: quote.status }, 409);
    }

    const idempotencyKey = `book:quote:${id}`;
    // Already booked → return the existing booking; never create a second.
    const prior = quote.convertedBookingId
      ? await deps.bookings.get(quote.convertedBookingId)
      : await deps.bookings.findByIdempotencyKey(idempotencyKey);
    if (prior) {
      if (!quote.convertedBookingId) await deps.quotes.patch(id, { convertedBookingId: prior.id, status: 'won' });
      return c.json(prior, 200);
    }

    const parsed = BookingDetailsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'bad_request', details: parsed.error.flatten() }, 400);

    let mapped;
    try {
      mapped = quoteToBooking(quote, parsed.data);
    } catch (e) {
      if (e instanceof QuoteNotBookableError) return c.json({ error: 'not_bookable' }, 409);
      throw e;
    }

    // Validate the built input against the same schema the public booking routes use —
    // a bad mapping fails loudly instead of persisting a malformed booking.
    const schema = mapped.mode === 'single' ? SingleTransferInput : TripInput;
    if (!schema.safeParse(mapped.input).success) return c.json({ error: 'invalid_booking' }, 400);

    const newBooking: NewBooking =
      mapped.mode === 'single'
        ? { mode: 'single', input: mapped.input, total: quote.totalCents, amountDueNow: quote.totalCents,
            currency: quote.currency, distanceKm: mapped.distanceKm, durationMin: null, channel: 'whatsapp' }
        : { mode: 'trip', input: mapped.input, total: quote.totalCents, amountDueNow: quote.totalCents,
            currency: quote.currency, distanceKm: mapped.distanceKm, durationMin: null, channel: 'whatsapp' };

    const booking = await deps.bookings.create(newBooking, { idempotencyKey });
    await deps.quotes.patch(id, { convertedBookingId: booking.id, status: 'won' });
    return c.json(booking, 201);
  });
```

In `api/src/app.ts`, add `bookings` to the `internalQuoteRoutes` call (~line 211):

```ts
  app.route('/admin/quote', internalQuoteRoutes({
    maps, quotes, bookings,
    auth: opsAuthCfg,
    allowedOrigins,
    email,
    opsBaseUrl: deps.opsBaseUrl ?? config.OPS_BASE_URL,
  }));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts -t "create a booking from a quote"`
Expected: PASS (7 tests).

- [ ] **Step 5: Full check + commit**

```bash
cd api && npm run check
git add api/src/routes/internalQuote.ts api/src/app.ts api/src/routes/internalQuote.test.ts
git commit -m "feat(ops): POST /admin/quote/:id/book creates a booking from a quote

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Ops UI — "Mark booked" opens the booking modal

**Files:**
- Modify: `api/src/routes/ops-ui.html` (the `QuoteView` module: `actionsFor` button list ~3983; the action dispatch `markWon` ~4503; add modal state + render, mirroring the `ratesOpen` modal ~4302; and the quote-load in `openQuote` so `state.convertedBookingId` is populated)

**Verification:** browser preview (this is UI wiring over the Task 3 endpoint, which is already unit-tested). No new Vitest test; confirm the flow end-to-end in the preview.

- [ ] **Step 1: Populate `convertedBookingId` in quote state**

In `QuoteView.openQuote` (where the `GET /admin/quote/:id` response is loaded into `state`), ensure the loaded quote's back-link is kept:

```js
state.convertedBookingId = quote.convertedBookingId || null;
```

(Add this line next to where `state.status`/`state.savedId` are set from the fetched quote. Read the surrounding block first to match the existing assignment style.)

- [ ] **Step 2: Show "Mark booked" on `won`-without-a-booking too, and open the modal**

In `actionsFor` (~3983), the button currently appears only for `s === 'sent'`. In **both** the `approver` and non-`approver` branches, add a `won`-without-booking case so the backlog (already-won quotes) is reachable. After the existing `else if (s === 'sent') { ... }` line in each branch, add:

```js
    else if (s === 'won' && !state.convertedBookingId) { out.push(B('markWon', 'Mark booked', 'ch-btn-teal')); }
```

- [ ] **Step 3: Change the `markWon` action to open the modal (not flip status)**

In the action dispatch (~4503), replace:

```js
    } else if (action === 'markWon') {
      markOutcome('won');
```

with:

```js
    } else if (action === 'markWon') {
      bookOpen = true;
      render();
```

Add the modal-state var next to the other modal flags (~2067, with `ratesOpen`/`sendBackOpen`):

```js
var bookOpen = false; // "Mark booked" → create-a-booking confirmation modal
```

- [ ] **Step 4: Render the booking modal + submit**

In `QuoteView`'s `render()` (~4078), where `ratesOpen ? [...]` appends the rates modal (~4302), append a parallel block for `bookOpen`. Mirror the existing modal markup/classes. The form pre-fills from `state` (name split, contact, vehicle, pax, bags) and **requires** first/last name, email, WhatsApp, country, date, time. Wire a submit handler:

```js
async function bookQuote() {
  var b = {
    customer: {
      firstName: val('bk-first'), lastName: val('bk-last'),
      email: val('bk-email'), whatsapp: val('bk-whatsapp'), country: val('bk-country'),
    },
    vehicleType: val('bk-vehicle') || 'car',
    pax: Number(val('bk-pax')) || 1,
    bags: Number(val('bk-bags')) || 0,
    date: val('bk-date') || undefined,
    time: val('bk-time') || undefined,
  };
  // Client-side required-field guard (server re-validates via Zod).
  if (!b.customer.firstName || !b.customer.lastName || !b.customer.email || !b.customer.whatsapp || !b.customer.country || !b.date || !b.time) {
    showToast('Fill in name, email, WhatsApp, country, date and time'); return;
  }
  var res = await fetch('/admin/quote/' + state.savedId + '/book', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(b),
  });
  var out = await res.json().catch(function () { return null; });
  if (!res.ok) { showToast('Could not book — ' + ((out && out.error) || res.status)); return; }
  bookOpen = false;
  state.status = 'won';
  state.convertedBookingId = out.id;
  showToast('Booked · ' + out.reference);
  if (window.opsRefreshQuotes) window.opsRefreshQuotes();
  render();
}
```

Use the module's existing helpers for field reads and toasts (`val(id)` = `document.getElementById(id).value.trim()` — define a small local helper if one doesn't already exist; `showToast` already exists). Add a Cancel control that sets `bookOpen = false; render();`. Wire the confirm button through the existing action-dispatch switch (e.g. `action === 'confirmBook'` → `bookQuote()`, `action === 'cancelBook'` → `bookOpen = false; render();`), matching how `confirmSendBack`/`cancelSendBack` are wired (~4497).

- [ ] **Step 5: Verify in the browser preview**

Start the API (dev-login enabled in non-prod) and drive the flow:

```
- preview_start { name: "api" }   # or the launch.json dev server for api/
- Open /ops, dev-login as a founder/ops user, open a `sent` quote.
- Click "Mark booked" → the modal opens (does NOT immediately flip status).
- Fill required fields → Confirm → toast "Booked · CH-…", quote reads `won`.
- Open the Bookings tab → the new booking is listed.
- read_console_messages / preview_logs → no errors.
- Re-open the now-won quote → "Mark booked" is gone (convertedBookingId set).
```

Also confirm the modal's Cancel leaves a `sent` quote unchanged (still `sent`, no booking).

- [ ] **Step 6: Run web-tests + commit**

```bash
cd api && npm run check
cd .. && npm run test:all   # web-tests green
git add api/src/routes/ops-ui.html
git commit -m "feat(ops-ui): Mark booked opens a create-booking modal

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Endpoint `POST /admin/quote/:id/book`, `bookings:operate` gated → Task 3. ✓
- Booking `draft` at quote's frozen price → Task 3 (`total = amountDueNow = quote.totalCents`). ✓
- Stamp `convertedBookingId` + `won` → Task 1 (repo) + Task 3 (call). ✓
- Idempotency `book:quote:<id>` → Task 3 (+ test). ✓
- Mapping (single/trip/chauffeur/vehicle) → Task 2 (+ tests). ✓
- Modal, trigger on `sent`/`won`-without-booking, full required fields → Task 4. ✓
- No schema/migration; `QuotePatch` additive; PATCH zod untouched → Task 1. ✓
- Auth: finance 403 → Task 3 test. ✓
- Error handling 404/409/400/200/201 → Task 3 route + tests. ✓
- Out of scope (payments, web self-serve stamp) → not built. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. Task 4's modal markup references the existing `ratesOpen` block as the pattern to mirror (the file's own convention) rather than a placeholder — its logic (submit/POST/dispatch) is given in full.

**Type consistency:** `quoteToBooking`/`BookingDetails`/`MappedBooking`/`QuoteNotBookableError` names match across Task 2 → Task 3. `convertedBookingId?: string` matches across Task 1 → Task 3. `NewBooking` fields (`mode`/`input`/`total`/`amountDueNow`/`currency`/`distanceKm`/`durationMin`/`channel`) match `bookingRepo.ts`. Endpoint path `/admin/quote/:id/book` matches across Task 3 and Task 4.
