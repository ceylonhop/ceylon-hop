# Booking gaps + manual payment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A booking converted from an ops quote represents that quote faithfully — gaps included — and an out-of-band (cash/bank) booking can be marked paid so it stops being stranded at "Awaiting payment".

**Architecture:** Two independent fixes. (1) `TripInput` gains an optional `driven: boolean[]`, one entry per segment, so a stop chain can express "we don't drive this bit"; `quoteToBooking` stops discarding non-chaining origins and carries per-leg dates; every renderer (ops view, customer email, ops drawer) reads `driven` and shows a gap as customer-arranged travel. (2) A new `POST /admin/bookings/:id/mark-paid` records a manual payment row and moves `payment_pending → paid`, unblocking the pipeline.

**Tech Stack:** Node 20 · TypeScript (strict) · Hono · Zod · Vitest · Drizzle + Postgres · Playwright (`web-tests/`)

## Owner decisions (2026-07-30)

| Question | Decision |
| --- | --- |
| Disconnected quote legs | **Match the quote** — the booking must represent gaps, not block or flatten them |
| Marking an out-of-band booking paid | **Record the money, and ask how it was paid** |
| Confirmation email on manual mark-paid | **Do not send.** Automatic sending is wanted later — leave a clean seam, build no email now |
| Who may mark paid | `payments:act` (founder/finance) — same tier as cancel, refund and no-show |

## Global Constraints

- **No migration.** Do not touch `api/src/db/schema.ts` or add a file to `api/drizzle/`. Both fixes are designed to avoid one: `TripInput` lives in a `jsonb` column, and the manual payment reuses existing `payments` columns.
- **No pricing change.** Do not touch `api/src/quote/rateCard.ts`, `api/src/db/departureRepo.ts`, or **`api/src/services/pricing.ts`**. See "The pricing boundary" below — this is deliberate and must be honoured.
- **No config change** (`api/src/config.ts`, env handling).
- **`driven` is optional and defaults to all-driven.** Every existing booking, and every public (website) booking, has no `driven` array and MUST behave exactly as it does today. Absent `driven` ≡ every segment driven.
- **`driven.length === stops.length - 1`** whenever present. One flag per segment.
- **No customer email is sent by mark-paid.** Not now.
- **Money code is recently hardened** (SH6/SH7/SH8). A `succeeded` payment row must carry a non-null `settlementSource` — that is a live DB CHECK (`schema.ts:111`). Do not weaken it.
- **Gate:** `cd api && npm run check` before every commit. For tasks touching `api/src/routes/ops-ui.html` or `web-tests/`, also `cd web-tests && npm run test:all`.
- **Branch:** `ops-autosave-drafts` (worktree `.claude/worktrees/ops-autosave-drafts`). One commit per task.
- **Exact strings** (pinned by tests, do not paraphrase):
  - Gap label in the ops drawer and ops route summary: `customer travels independently`
  - Gap separator in a joined route string: ` ⇢ ` (a dashed arrow, distinct from the driven ` → `)
  - Manual payment provider values: `cash`, `bank_transfer`, `manual_other`
  - Manual settlement source: `manual`
  - Mark-paid error when the booking is not awaiting payment: `not_awaiting_payment`

## The pricing boundary (read before Task 1)

`api/src/services/pricing.ts` prices a trip by walking consecutive stop pairs. It is **out of scope**, deliberately:

- Ops bookings created from a quote are **never re-priced** — `POST /admin/quote/:id/book` passes the quote's frozen `totalCents` straight through.
- Public/website bookings are the only callers that price a `TripInput`, and they never set `driven`.

So a gap cannot reach the pricing path today. Task 1 pins that with a test rather than opening the pricing blast radius. If gaps ever do become reachable from public booking, pricing must be taught to skip non-driven segments — until then, do not touch it.

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `api/src/domain/trip.ts` | Modify | Add optional `driven` to the `TripInput` schema |
| `api/src/quote/quoteToBooking.ts` | Modify | Stop dropping non-chaining origins; emit `driven`; carry per-leg dates |
| `api/src/services/opsView.ts` | Modify | Route summary renders gaps with ` ⇢ ` |
| `api/src/services/notifications.ts` | Modify | Customer emails render a gap as customer-arranged travel |
| `api/src/routes/ops-ui.html` | Modify | Drawer leg list marks gaps; mark-paid control at the awaiting stage |
| `api/src/db/paymentRepo.ts` | Modify | Allow `'manual'` as a settlement source; add the manual-settle method |
| `api/src/db/postgresPaymentRepo.ts` | Modify | Implement the manual-settle method |
| `api/src/routes/admin.ts` | Modify | `POST /bookings/:id/mark-paid` |
| `web-tests/e2e/ops-booking-gaps.spec.js` | Create | e2e for the drawer's gap rendering + mark-paid |

---

### Task 1: A booking can express a gap

**Files:**
- Modify: `api/src/domain/trip.ts` (the `TripInput` Zod schema, ~line 14)
- Modify: `api/src/quote/quoteToBooking.ts` (`chainStops` ~line 34; the private-trip return ~line 77; the chauffeur return ~line 97)
- Test: `api/src/quote/quoteToBooking.test.ts`

**Interfaces:**
- Consumes: `Ride` / `normalizeRide` from `api/src/quote/types.ts` (a `Ride` is `{ stops: string[]; segmentKms: number[] }`).
- Produces:
  - `TripInput.driven?: boolean[]` — one flag per segment; `true` = we drive it, `false` = the customer arranges that hop themselves. Absent ≡ all driven.
  - `chainStops(rides)` now returns `{ stops: string[]; driven: boolean[] }` instead of `string[]`.

**Background.** Today `chainStops` is `[...rides[0].stops, ...rides.slice(1).flatMap(r => r.stops.slice(1))]` — every later ride contributes everything *after* its first stop, so when a ride does not begin where the previous one ended, its origin is **silently discarded**. That quirk was knowingly preserved as GC-13 in the multi-stop plan. It is now a live bug: a quote of `CMB→Ella`, `Galle→Colombo City`, `Kandy→Batticaloa` becomes the booking `CMB → Ella → Colombo City → Batticaloa`, losing Galle and Kandy and inventing a leg `Ella → Colombo City` that nobody drives. Fix it here.

**Dates: keep the chauffeur branch aligned; do NOT try to fix private dates here.** `dates` is one entry per segment, so inserting gap stops shifts every index — the chauffeur branch (`dates: days.map(d => d.date)`) must be realigned so each date still lands on the segment it belongs to, with gap segments carrying `''`.

The private branch keeps its current `dates: details.date ? [details.date] : undefined`. It looks wrong — a multi-leg private quote shows only one date — but the per-leg dates are **not available here**: `PrivateLeg` is `{ from, to, distanceKm }` with no date ([types.ts:4](api/src/quote/types.ts:4)). The dates the operator typed live in the *tool* payload (`quote.request.tool.legs[].date`), and `quoteToBooking` maps from `request.engine`. Sourcing them is a separate change to this function's input contract and is deliberately **out of scope** — it is logged as its own bug. Do not widen this task to chase it.

- [ ] **Step 1: Write the failing test**

Add to `api/src/quote/quoteToBooking.test.ts`, following the file's existing fixture helpers (read them first — reuse how it builds a `SavedQuote` with an engine request rather than inventing a new fixture):

```ts
describe('a quote whose legs do not connect', () => {
  it('keeps every stop and marks the gaps as not driven', () => {
    // CMB→Ella, then the customer makes their own way to Galle, then Galle→Colombo City.
    const mapped = quoteToBooking(quoteWithLegs([
      { from: 'Colombo Airport (CMB)', to: 'Ella', distanceKm: 213 },
      { from: 'Galle', to: 'Colombo City', distanceKm: 132 },
      { from: 'Kandy', to: 'Batticaloa', distanceKm: 186 },
    ]), details());

    expect(mapped.mode).toBe('trip');
    expect(mapped.input.stops).toEqual([
      'Colombo Airport (CMB)', 'Ella', 'Galle', 'Colombo City', 'Kandy', 'Batticaloa',
    ]);
    // One flag per segment: drive, gap, drive, gap, drive.
    expect(mapped.input.driven).toEqual([true, false, true, false, true]);
    expect(mapped.input.driven).toHaveLength(mapped.input.stops.length - 1);
  });

  it('leaves a fully connected itinerary all-driven', () => {
    const mapped = quoteToBooking(quoteWithLegs([
      { from: 'A', to: 'B', distanceKm: 10 },
      { from: 'B', to: 'C', distanceKm: 20 },
    ]), details());
    expect(mapped.input.stops).toEqual(['A', 'B', 'C']);
    expect(mapped.input.driven).toEqual([true, true]);
  });

  it('keeps a chauffeur trip\'s dates on the right segments across a gap', () => {
    // Chauffeur days DO carry dates. Inserting a gap stop shifts the segment indices, so each
    // date must still land on the day it belongs to and the gap must carry none.
    const mapped = quoteToBooking(chauffeurQuoteWithDays([
      { date: '2026-07-22', from: 'A', to: 'B', distanceKm: 10 },
      { date: '2026-07-24', from: 'C', to: 'D', distanceKm: 20 },
    ]), details());
    expect(mapped.input.driven).toEqual([true, false, true]);
    expect(mapped.input.dates).toEqual(['2026-07-22', '', '2026-07-24']);
    expect(mapped.input.dates).toHaveLength(mapped.input.stops.length - 1);
  });
});
```

Use the test file's own existing fixture helpers for both the private and chauffeur cases — read them first rather than writing the `quoteWithLegs` / `chauffeurQuoteWithDays` helpers sketched above if equivalents already exist.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd api && npx vitest run src/quote/quoteToBooking.test.ts
```

Expected: FAIL — stops omit Galle/Kandy, and `driven` is undefined.

- [ ] **Step 3: Implement**

In `api/src/domain/trip.ts`, add to the `TripInput` schema beside `nights`:

```ts
  // Per-SEGMENT (stops[i] → stops[i+1]) flag: true = we drive it, false = the customer
  // arranges that hop themselves. Optional, and ABSENT MEANS ALL DRIVEN — every website
  // booking and every row written before gaps existed omits it and must keep behaving as
  // it always has. Present only on bookings converted from an ops quote whose legs don't
  // connect, which is a legitimate itinerary (a customer taking the train Ella→Galle), not
  // an error to reject.
  driven: z.array(z.boolean()).max(MAX_TRIP_STOPS).optional(),
```

In `api/src/quote/quoteToBooking.ts`, replace `chainStops` with a version that preserves the gap instead of swallowing it:

```ts
// Chain the rides into one stop list, recording which segments we actually drive. A later
// ride that does NOT start where the previous one ended contributes its origin too, and the
// synthetic segment bridging the two is marked NOT driven — that hop is the customer's own
// arrangement. This replaces the old behaviour, which dropped the non-chaining origin and so
// invented a leg nobody drives (GC-13); it reached the ops drawer AND the customer's email.
function chainStops(rides: Ride[]): { stops: string[]; driven: boolean[] } {
  const stops = [...rides[0].stops];
  const driven: boolean[] = rides[0].stops.slice(1).map(() => true);
  for (const ride of rides.slice(1)) {
    if (ride.stops[0] !== stops[stops.length - 1]) {
      stops.push(ride.stops[0]);
      driven.push(false); // the gap: we don't drive from the last drop-off to this pick-up
    }
    for (const stop of ride.stops.slice(1)) {
      stops.push(stop);
      driven.push(true);
    }
  }
  return { stops, driven };
}
```

Update both call sites to destructure `{ stops, driven }`, pass `driven` into the `TripInput`, and keep `nights` sized to `stops.length - 1` as before.

For the private branch, replace `dates: details.date ? [details.date] : undefined` with a per-segment array aligned to `driven`: each driven segment takes its leg's date (falling back to `details.date` for the first segment when the leg has none), and each gap segment takes `''`. Match whatever the chauffeur branch does for its own date handling so the two branches don't drift.

- [ ] **Step 4: Pin the pricing boundary**

Add a test asserting the guarantee the plan relies on — that a booking converted from a quote is priced at the quote's frozen total and never re-priced through `services/pricing.ts`. Look at `api/src/routes/internalQuote.test.ts`'s existing `/book` tests: assert the created booking's `total` equals the quote's `totalCents` for a quote with a gap. Add a comment naming why it matters (pricing walks consecutive stop pairs and would charge for a gap segment).

- [ ] **Step 5: Run tests and the gate**

```bash
cd api && npx vitest run src/quote/quoteToBooking.test.ts && npm run check
```

Expected: PASS. Existing `quoteToBooking` tests include one pinning the old drop-the-origin quirk — that test asserted the bug, so update it to the new behaviour and say so in your report.

- [ ] **Step 6: Commit**

```bash
git add api/src/domain/trip.ts api/src/quote/quoteToBooking.ts api/src/quote/quoteToBooking.test.ts api/src/routes/internalQuote.test.ts
git commit -m "fix(bookings): keep every stop when a quote's legs don't connect"
```

---

### Task 2: Server-side renderers tell the truth

**Files:**
- Modify: `api/src/services/opsView.ts` (`route()`, ~line 49)
- Modify: `api/src/services/notifications.ts` (`isRoundTrip` ~line 52, `journey()` ~line 61, `routeText()` ~line 141)
- Test: the existing suites for both (`opsView` and notifications/email tests)

**Interfaces:**
- Consumes: `TripInput.driven` (Task 1).
- Produces: nothing new.

**Why this matters most.** `notifications.ts` builds the **customer's** itinerary email from `input.stops`. Until Task 1 the data was wrong; now the data is right but these renderers would present a gap as a leg we drive. A customer must never be told we're driving them from Ella to Galle when they're taking the train.

- [ ] **Step 1: Write the failing tests**

In the notifications/email test suite, add a case for a trip booking whose `driven` is `[true, false, true]`: the rendered itinerary must mark the middle hop as customer-arranged (the exact copy is yours to choose, but it must contain `customer travels independently` — see Global Constraints) and must NOT present it as a driven leg. Add the mirror case in the `opsView` suite: `route()` must join with ` → ` across driven segments and ` ⇢ ` across a gap, so the summary reads:

```
Colombo Airport (CMB) → Ella ⇢ Galle → Colombo City ⇢ Kandy → Batticaloa
```

Also add a regression case to each: a booking with **no** `driven` renders byte-identically to today.

- [ ] **Step 2: Run them to verify they fail**

```bash
cd api && npx vitest run src/services/
```

Expected: FAIL — both renderers ignore `driven`.

- [ ] **Step 3: Implement**

`opsView.route()`: join stops pairwise, choosing the separator per segment from `driven` (absent ⇒ all ` → `).

`notifications.ts`:
- `routeText()` — same pairwise join.
- `journey()` — the per-stop list gains, on the stop that *begins* a gap, a `sub` line saying the customer travels independently to the next stop. Read how `sub` is currently composed (nights + the leg's travel date) and extend it rather than replacing it.
- `isRoundTrip()` — check whether the gap changes its "first stop equals last stop" test. If a gap can make a non-round trip look round (or vice versa), fix it and add a test; if not, leave it and say why in your report.

- [ ] **Step 4: Run tests and the gate**

```bash
cd api && npm run check
```

- [ ] **Step 5: Commit**

```bash
git add api/src/services/opsView.ts api/src/services/notifications.ts api/src/services/
git commit -m "fix(bookings): render a leg gap as customer-arranged travel, not a driven leg"
```

---

### Task 3: The ops drawer shows the real itinerary

**Files:**
- Modify: `api/src/routes/ops-ui.html` (`legsHtmlFor`, ~line 2180)

**Interfaces:**
- Consumes: `TripInput.driven` (Task 1), surfaced on `d.booking.input.driven`.

**Background.** `legsHtmlFor` renders every consecutive pair as a leg, which is exactly how the drawer came to display `Leg 2 · Ella → Colombo City` for a leg that does not exist. Read the current function first; keep its `esc()` escaping and its existing "Single transfer — no leg breakdown." fallback.

- [ ] **Step 1: Implement**

Render each segment from `driven` (absent ⇒ all driven):
- A **driven** segment keeps today's row shape: the date (or the `Leg N` fallback) then `from → to`.
- A **gap** segment renders as a visually quieter row reading `customer travels independently` between the two places, using the dashed arrow ` ⇢ `. It must not be numbered as one of our legs and must not claim a date.

Number the driven legs consecutively among themselves, so a three-leg quote with two gaps still reads Leg 1, Leg 2, Leg 3 — not Leg 1, Leg 3, Leg 5.

Add a muted CSS rule for the gap row next to the existing `.leg` rule. Match the file's existing muted token (grep the page's CSS for the token its secondary text already uses — do not invent a colour, and do not assume `--ink-3` exists). Check the specificity of the rule you are overriding: a bare class can lose to an existing more-specific selector and silently do nothing.

- [ ] **Step 2: Verify in the browser**

Boot against a **throwaway local Postgres** — never `api/.env`, whose `DATABASE_URL` is PRODUCTION. Create an ops quote with deliberately disconnected legs, mark it booked, then open it in the Bookings drawer and confirm: every stop appears, the gaps read as customer-arranged, the driven legs are numbered 1..N, and a normal connected booking is unchanged.

- [ ] **Step 3: Gates and commit**

```bash
cd api && npm run check && cd ../web-tests && npm run test:all
```

```bash
git add api/src/routes/ops-ui.html
git commit -m "fix(ops): show leg gaps in the booking drawer instead of inventing legs"
```

---

### Task 4: Mark an out-of-band booking paid (server)

**Files:**
- Modify: `api/src/db/paymentRepo.ts` (the `settlementSource` union ~line 22; the `PaymentRepo` interface ~line 28; `InMemoryPaymentRepo`)
- Modify: `api/src/db/postgresPaymentRepo.ts`
- Modify: `api/src/routes/admin.ts` (beside the other `payments:act` booking routes, ~line 112)
- Test: `api/src/routes/admin.test.ts`

**Interfaces:**
- Produces:
  - `settlementSource: 'webhook' | 'legacy_backfill' | 'manual' | null`
  - `PaymentRepo.markSucceededManually(id: string, evidence: { reference: string | null }): Promise<Payment>`
  - `POST /admin/bookings/:id/mark-paid` → `200` with the updated booking. Body: `{ method: 'cash' | 'bank_transfer' | 'manual_other', reference?: string }`.

**Why a new repo method.** `markSucceeded()` stamps `settlementSource: 'legacy_backfill'` ([postgresPaymentRepo.ts:56](api/src/db/postgresPaymentRepo.ts:56)) — reusing it would mislabel real cash as a backfill, defeating the provenance the SH7 work added. A DB CHECK requires a `succeeded` payment to carry a non-null `settlementSource` (`schema.ts:111`); it does **not** enumerate the allowed values, so adding `'manual'` is a TypeScript-level change with **no migration**.

**No new columns.** The manual payment reuses what `payments` already has: `provider` carries the method (`cash` / `bank_transfer` / `manual_other` — the provider of a cash payment genuinely is cash), `settlementSource` is `'manual'`, and `gatewayPaymentId` holds the operator's optional reference. Recording *who* marked it goes in the booking's activity notes, not a new column.

- [ ] **Step 1: Write the failing tests**

In `api/src/routes/admin.test.ts`, following the file's existing patterns for authenticating a `payments:act` caller:

- Marking a `payment_pending` booking paid returns 200, moves it to `paid`, and creates exactly one payment row with `status: 'succeeded'`, `settlementSource: 'manual'`, `provider` equal to the posted method, and `amount` equal to the booking's amount due.
- The reference, when posted, lands on the payment; when omitted, the payment still succeeds.
- **Refunds now work on it** — after marking paid, requesting a refund does NOT fail with `payment_not_captured`. (This is the whole reason for recording the money; assert it directly.)
- A booking that is not awaiting payment returns `400 not_awaiting_payment` and is left untouched.
- An unknown method in the body returns `400`.
- A caller without `payments:act` is refused.
- **Idempotency:** posting twice does not create a second payment row or double-count the money.
- **No email is sent.** Assert the fake email adapter recorded nothing — this is an explicit owner decision, not an oversight.

- [ ] **Step 2: Run to verify failure**

```bash
cd api && npx vitest run src/routes/admin.test.ts -t "mark-paid"
```

Expected: FAIL — route not registered (404).

- [ ] **Step 3: Implement**

Add `'manual'` to the `settlementSource` union in `paymentRepo.ts`, add `markSucceededManually` to the interface and both implementations (Postgres sets `status: 'succeeded'`, `settledAt: now`, `settlementSource: 'manual'`, `gatewayPaymentId: reference`), then add the route:

```ts
  // Ops marks an out-of-band booking paid (owner 2026-07-30). A booking converted from a
  // quote lands in payment_pending and is settled by cash or bank transfer, so no PayHere
  // webhook is ever coming — without this it is stranded at "Awaiting payment" forever and
  // can never advance through the pipeline. The money is RECORDED, not just asserted: a
  // refund requires a captured payment (refundRepo's payment_not_captured), so a status-only
  // flip would leave a cash booking unrefundable.
  // Deliberately sends NO customer email (owner 2026-07-30); automatic sending is wanted
  // later and belongs with the rest of the confirmation flow.
  r.post('/bookings/:id/mark-paid', requireCap('payments:act'), async (c) => { ... });
```

Guard on the booking's current status being `payment_pending` and return `400 { error: 'not_awaiting_payment', status }` otherwise, in the style of the file's other error returns. Make it idempotent on a stable key derived from the booking id, the same way `POST /:id/book` uses an `idempotencyKey` — a double-click must not record the money twice.

Record the audit trail as a booking note naming the operator, the method and the reference, using whatever note mechanism the booking activity already reads (`buildActivity` in `ops-ui.html` renders `t.notes` — find where those are written server-side and follow it).

- [ ] **Step 4: Run tests and the gate**

```bash
cd api && npm run check
```

- [ ] **Step 5: Commit**

```bash
git add api/src/db/paymentRepo.ts api/src/db/postgresPaymentRepo.ts api/src/routes/admin.ts api/src/routes/admin.test.ts
git commit -m "feat(bookings): mark an out-of-band booking paid and record the money"
```

---

### Task 5: The mark-paid control (UI)

**Files:**
- Modify: `api/src/routes/ops-ui.html` (the `isPending` branch of the drawer, ~line 2300; the action dispatcher's `case` list, ~line 2592)

**Interfaces:**
- Consumes: `POST /admin/bookings/:id/mark-paid` (Task 4).

**Background.** The drawer's awaiting-payment branch currently renders only the follow-up note and "Copy payment reminder". Read that branch and the `noshow` case in the dispatcher first — the dispatcher's existing idiom is a `confirm()` guard, an `api.post`, a toast, then `refreshRow(id)`. Follow it. **Do not** build modal infrastructure; this view has none.

- [ ] **Step 1: Implement**

In the `isPending` branch, keep "Copy payment reminder" as the primary action and add beside it a method `<select>` (Cash / Bank transfer / Other) plus a secondary "Mark paid" button. On click: `confirm()` naming the amount and the chosen method, then POST, then toast and refresh both the drawer and the row.

Also fix the branch's copy. It currently asserts *"Payment link sent — follow up. Payment lands automatically via the webhook."* — untrue for a WhatsApp booking converted from a quote, which is settled out-of-band and has no webhook coming. Rewrite it to state honestly that payment is pending and can either arrive via the link or be recorded here once collected.

Handle the server's `not_awaiting_payment` with a human message rather than a raw code, matching how the dispatcher surfaces other errors.

- [ ] **Step 2: Verify in the browser**

Against a **throwaway local Postgres** (never `api/.env` — it is PRODUCTION): convert a quote to a booking, confirm it lands at Awaiting payment, mark it paid as cash, and confirm the pipeline advances to PAID and the remaining stages (`Confirm vehicle` → `Confirm pickup` → `Mark on trip` → `Mark completed`) are now reachable through to Done. This end-to-end walk is the actual point of the task — report what you saw at each stage.

- [ ] **Step 3: Gates and commit**

```bash
cd api && npm run check && cd ../web-tests && npm run test:all
```

```bash
git add api/src/routes/ops-ui.html
git commit -m "feat(ops): mark a booking paid from the drawer and unblock the pipeline"
```

---

### Task 6: End-to-end coverage

**Files:**
- Create: `web-tests/e2e/ops-booking-gaps.spec.js`

Follow `web-tests/e2e/ops-ui.spec.js` for the harness: the `test.skip(process.env.CH_E2E_API !== '1', ...)` gate, the `OPS` base const, and its `login()` helper (`#devloginemail` + `requestSubmit()` on `#devloginform`). Do not invent a new harness. Read `web-tests/e2e/ops-autosave-drafts.spec.js` for a recent example in the same style.

- [ ] **Step 1: Write the specs**

Two tests:
1. **The pipeline unblocks.** Sign in, open a booking that is awaiting payment, mark it paid, and assert the pipeline's PAID step becomes current and an advance button appears. Assert against the real server round-trip (wait on the POST response), not just a DOM change.
2. **A gap renders as a gap.** For a booking whose legs don't connect, assert the drawer's leg list contains `customer travels independently` and does NOT contain the fabricated driven leg (assert the specific wrong string is absent).

Creating the fixtures may need an API call rather than UI clicking — if so, drive it through the same authenticated session the harness establishes, and say in your report exactly how the fixture is built.

- [ ] **Step 2: Run them for real**

```bash
cd web-tests && CH_E2E_API=1 npx playwright test e2e/ops-booking-gaps.spec.js
```

They must genuinely pass, not skip. **Negative-check each**: break the feature, confirm the test fails, revert cleanly (`git checkout --`), and report the failure output. A spec that cannot fail is not coverage.

- [ ] **Step 3: Gates and commit**

```bash
cd api && npm run check && cd ../web-tests && npm run test:all
```

```bash
git add web-tests/e2e/ops-booking-gaps.spec.js
git commit -m "test(ops): e2e cover the mark-paid pipeline and gap rendering"
```

---

## Done when

- A quote with disconnected legs converts to a booking that keeps **every** stop, with gaps flagged.
- The ops drawer, the ops route summary and the customer email all present a gap as customer-arranged travel — never as a leg we drive.
- A chauffeur trip's dates still land on the right segments once gap stops shift the indices.
- An out-of-band booking can be marked paid, records a `manual`-sourced payment for the right amount, becomes refundable, and advances through the pipeline to Done.
- No customer email is sent by mark-paid.
- Bookings with no `driven` array behave exactly as before.
- `cd api && npm run check` and `cd web-tests && npm run test:all` both green.
- No migration, no pricing change, no config change in the diff.

## Deploy note

Merging to `main` deploys to **staging** only. Production is a separate promote PR and needs the owner's explicit ok.
