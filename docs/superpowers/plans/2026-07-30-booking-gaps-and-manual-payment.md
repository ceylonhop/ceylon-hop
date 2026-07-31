# Booking stop-loss + manual mark-paid — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a quote-to-booking conversion silently destroying stops, and let an out-of-band (cash/bank) booking be marked paid so it is no longer stranded at "Awaiting payment".

**Architecture:** Two independent fixes. (1) `chainStops` keeps every stop instead of discarding a non-chaining leg's origin, so no place is lost on conversion. (2) A new `POST /admin/bookings/:id/mark-paid` records a manual payment row and moves `payment_pending → paid`, unblocking the pipeline.

**Tech Stack:** Node 20 · TypeScript (strict) · Hono · Zod · Vitest · Drizzle + Postgres · Playwright (`web-tests/`)

## AMENDED 2026-07-30 — read this before Task 1

This plan originally added an optional per-segment `driven: boolean[]` to `TripInput` so a booking could mark "we don't drive this hop". **That is cancelled.** Two things killed it:

1. `TripInput` is **not** stored as `jsonb` for trips. `trip_request` is a normalised table with enumerated columns (`stops text[]`, `nights integer[]`, `dates text[]` — `api/src/db/schema.ts:212`), so `driven` would have needed a new column, and it silently vanished on write without one.
2. Asked to approve that column, the owner asked the better question: *why do the quote and the booking model a trip differently at all?* They don't need to. A quote stores **discrete legs** (each with its own `stops[]`), so a gap is simply an absence and needs no flag. The booking flattens everything into one chain, which is what destroys the information. `schema.ts:210` admits this outright — *"v1 stores the multi-stop trip as arrays … rather than the fully normalised itinerary/leg/stay of spec §5.2 — fine for the stub, normalise later"* — and `docs/backend-spec.md:157` §5.2 specifies exactly the leg model, `travel_date` included.

**Owner decision (2026-07-30): normalise the booking into discrete legs as its own spec'd piece, while the table is still nearly empty pre-launch.** That work will fix gaps, per-leg dates and this whole class of bug at the root. So `driven` is throwaway and is **not** built here.

What survives in this plan: the stop-loss fix (irreversible data loss, worth stopping now) and mark-paid (entirely independent).

**Known and accepted until the leg model lands:** a booking converted from a disconnected quote now keeps every place, but the drawer and the customer email will present the gap segments (`Ella → Galle`) as if they were legs we drive. That is not a regression — before this fix they showed a *different* invented leg (`Ella → Colombo City`) *and* lost two places. Logged in `docs/known-bugs.md`; fixed properly by the leg model.

## Owner decisions

| Question | Decision |
| --- | --- |
| Disconnected quote legs | Keep every stop now; **model legs properly** as its own next piece, not with a stopgap flag |
| Marking an out-of-band booking paid | **Record the money, and ask how it was paid** |
| Confirmation email on manual mark-paid | **Do not send.** Automatic sending is wanted later — leave a clean seam, build no email now |
| Who may mark paid | `payments:act` (founder/finance) — same tier as cancel, refund and no-show |

## Global Constraints

- **No migration.** Do not touch `api/src/db/schema.ts` or add a file to `api/drizzle/`. Both remaining fixes are designed to avoid one.
- **No pricing change.** Do not touch `api/src/quote/rateCard.ts`, `api/src/db/departureRepo.ts`, or **`api/src/services/pricing.ts`**.
- **No config change** (`api/src/config.ts`, env handling).
- **No `driven` field.** If you find one in `TripInput`, `quoteToBooking`, or any test, it is leftover from the cancelled design — remove it.
- **Money code is recently hardened** (SH6/SH7/SH8). A `succeeded` payment row must carry a non-null `settlementSource` — a live DB CHECK (`schema.ts:111`). Do not weaken it.
- **No customer email is sent by mark-paid.** Not now.
- **Gate:** `cd api && npm run check` before every commit. For tasks touching `api/src/routes/ops-ui.html` or `web-tests/`, also `cd web-tests && npm run test:all`.
- **Branch:** `ops-autosave-drafts` (worktree `.claude/worktrees/ops-autosave-drafts`). One commit per task.
- **Exact strings** (pinned by tests, do not paraphrase):
  - Manual payment provider values: `cash`, `bank_transfer`, `manual_other`
  - Manual settlement source: `manual`
  - Mark-paid error when the booking is not awaiting payment: `not_awaiting_payment`

---

### Task 1: Keep every stop, drop the cancelled `driven` design

**Files:**
- Modify: `api/src/domain/trip.ts`
- Modify: `api/src/quote/quoteToBooking.ts`
- Modify: `api/src/quote/quoteToBooking.test.ts`
- Modify: `docs/known-bugs.md`

**Starting point.** Commit `73969ef` already landed the full original design: `chainStops` preserving non-chaining origins **and** a `driven: boolean[]` on `TripInput`, plus a `rideIndex` array used to realign chauffeur dates. The stop-preservation is what we keep. Everything that exists only to express a gap flag comes out.

- [ ] **Step 1: Remove the `driven` field**

Delete `driven` from the `TripInput` schema in `api/src/domain/trip.ts`, and stop emitting it from both `TripInput` construction sites in `quoteToBooking.ts`. Remove every `driven` assertion from `quoteToBooking.test.ts`.

Keep `chainStops` preserving non-chaining origins — that is the fix. If its return shape (`{ stops, driven, rideIndex }`) still needs to carry per-segment ride ownership to realign chauffeur dates, keep that part and drop only `driven`; if `rideIndex` alone is enough, simplify to `{ stops, rideIndex }`. Do not keep an unused array.

- [ ] **Step 2: Keep the chauffeur date alignment**

Chauffeur days carry dates and gap stops shift the segment indices, so each date must still land on the segment it belongs to and a gap segment must carry `''`. That behaviour and its test stay exactly as committed — verify they still pass after the removal.

- [ ] **Step 3: Verify the stop-loss fix is intact**

The tests proving a disconnected quote keeps every stop must still pass, minus their `driven` assertions:

```ts
expect(mapped.input.stops).toEqual([
  'Colombo Airport (CMB)', 'Ella', 'Galle', 'Colombo City', 'Kandy', 'Batticaloa',
]);
```

- [ ] **Step 4: Log the accepted display gap**

Append one row to `docs/known-bugs.md`, matching the file's existing format and terse tone: a booking converted from a disconnected quote now keeps every place, but the ops drawer (`legsHtmlFor`, `api/src/routes/ops-ui.html`) and the customer itinerary email (`api/src/services/notifications.ts`) render every consecutive pair as a driven leg, so a gap reads as a leg we drive. Note that the booking's flat `stops` array cannot express a gap, and that the fix is the itinerary/leg/stay model of `docs/backend-spec.md` §5.2 (owner decision 2026-07-30).

- [ ] **Step 5: Run tests and the gate**

```bash
cd api && npx vitest run src/quote/quoteToBooking.test.ts && npm run check
```

Expected: PASS, with no reference to `driven` left anywhere:

```bash
grep -rn "driven" api/src/ | grep -v node_modules
```

Expected: no matches (other than the word appearing in unrelated prose).

- [ ] **Step 6: Commit**

```bash
git add api/src/domain/trip.ts api/src/quote/quoteToBooking.ts api/src/quote/quoteToBooking.test.ts docs/known-bugs.md
git commit -m "refactor(bookings): drop the cancelled driven flag, keep the stop-loss fix"
```

---

### Task 2: Mark an out-of-band booking paid (server)

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

**Why this exists.** A booking converted from an ops quote lands in `payment_pending` and is settled by cash or bank transfer, so **no PayHere webhook is ever coming**. The ops pipeline deliberately has no advance button at that stage (`ops-ui.html`: *"awaiting_payment has NO advance button — payment arrives via the webhook"*), so today such a booking is stranded forever and can never reach Completed.

**Why record the money rather than just flip the status.** A refund requires a captured payment — `refundRepo` throws `payment_not_captured` when no `succeeded` payment exists (`api/src/db/refundRepo.ts:88`). A status-only flip would leave every cash booking permanently unrefundable, defeating the manual refund ledger.

**Why a new repo method.** `markSucceeded()` stamps `settlementSource: 'legacy_backfill'` (`api/src/db/postgresPaymentRepo.ts:56`) — reusing it would label real cash as a backfill and destroy the provenance the SH7 work added. The DB CHECK requires a `succeeded` payment to have a non-null `settlementSource`; it does **not** enumerate values, so adding `'manual'` is a TypeScript-level change with **no migration**.

**No new columns.** The manual payment reuses what `payments` already has: `provider` carries the method (`cash` / `bank_transfer` / `manual_other` — the provider of a cash payment genuinely is cash), `settlementSource` is `'manual'`, and `gatewayPaymentId` holds the operator's optional reference. Recording *who* marked it goes in the booking's activity notes, not a new column.

- [ ] **Step 1: Write the failing tests**

In `api/src/routes/admin.test.ts`, following the file's existing patterns for authenticating a `payments:act` caller:

- Marking a `payment_pending` booking paid returns 200, moves it to `paid`, and creates exactly one payment row with `status: 'succeeded'`, `settlementSource: 'manual'`, `provider` equal to the posted method, and `amount` equal to the booking's amount due.
- The reference, when posted, lands on the payment; when omitted, the payment still succeeds.
- **Refunds now work on it** — after marking paid, requesting a refund does NOT fail with `payment_not_captured`. This is the whole reason for recording the money; assert it directly.
- A booking that is not awaiting payment returns `400 not_awaiting_payment` and is left untouched.
- An unknown method in the body returns `400`.
- A caller without `payments:act` is refused.
- **Idempotency:** posting twice does not create a second payment row or double-count the money.
- **No email is sent.** Assert the fake email adapter recorded nothing — an explicit owner decision, not an oversight.

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

Guard on the booking's current status being `payment_pending` and return `400 { error: 'not_awaiting_payment', status }` otherwise, in the style of the file's other error returns. Make it idempotent on a stable key derived from the booking id, the same way `POST /admin/quote/:id/book` uses an `idempotencyKey` — a double-click must not record the money twice.

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

### Task 3: The mark-paid control (UI)

**Files:**
- Modify: `api/src/routes/ops-ui.html` (the `isPending` branch of the drawer, ~line 2300; the action dispatcher's `case` list, ~line 2592)

**Interfaces:**
- Consumes: `POST /admin/bookings/:id/mark-paid` (Task 2).

**Background.** The drawer's awaiting-payment branch renders only the follow-up note and "Copy payment reminder". Read that branch and the `noshow` case in the dispatcher first — the dispatcher's idiom is a `confirm()` guard, an `api.post`, a toast, then `refreshRow(id)`. Follow it. **Do not** build modal infrastructure; this view has none.

- [ ] **Step 1: Implement**

In the `isPending` branch, keep "Copy payment reminder" as the primary action and add beside it a method `<select>` (Cash / Bank transfer / Other) plus a secondary "Mark paid" button. On click: `confirm()` naming the amount and the chosen method, then POST, then toast and refresh both the drawer and the row.

Also fix the branch's copy. It currently asserts *"Payment link sent — follow up. Payment lands automatically via the webhook."* — untrue for a WhatsApp booking converted from a quote, which is settled out-of-band and has no webhook coming. Rewrite it to state honestly that payment is pending and can either arrive via the link or be recorded here once collected.

Handle the server's `not_awaiting_payment` with a human message rather than a raw code, matching how the dispatcher surfaces other errors.

- [ ] **Step 2: Verify in the browser**

Against a **throwaway local Postgres** (never `api/.env` — it is PRODUCTION): convert a quote to a booking, confirm it lands at Awaiting payment, mark it paid as cash, and confirm the pipeline advances to PAID and the remaining stages (`Confirm vehicle` → `Confirm pickup` → `Mark on trip` → `Mark completed`) are now reachable through to Done. This end-to-end walk is the point of the task — report what you saw at each stage.

- [ ] **Step 3: Gates and commit**

```bash
cd api && npm run check && cd ../web-tests && npm run test:all
```

```bash
git add api/src/routes/ops-ui.html
git commit -m "feat(ops): mark a booking paid from the drawer and unblock the pipeline"
```

---

### Task 4: End-to-end coverage

**Files:**
- Create: `web-tests/e2e/ops-mark-paid.spec.js`

Follow `web-tests/e2e/ops-ui.spec.js` for the harness: the `test.skip(process.env.CH_E2E_API !== '1', ...)` gate, the `OPS` base const, and its `login()` helper (`#devloginemail` + `requestSubmit()` on `#devloginform`). Do not invent a new harness. Read `web-tests/e2e/ops-autosave-drafts.spec.js` for a recent example in the same style.

- [ ] **Step 1: Write the spec**

One test: **the pipeline unblocks.** Sign in, open a booking that is awaiting payment, mark it paid as cash, and assert the pipeline's PAID step becomes current and an advance button appears. Assert against the real server round-trip (wait on the POST response), not just a DOM change.

Creating the fixture may need an API call rather than UI clicking — if so, drive it through the same authenticated session the harness establishes, and say in your report exactly how the fixture is built.

- [ ] **Step 2: Run it for real**

```bash
cd web-tests && CH_E2E_API=1 npx playwright test e2e/ops-mark-paid.spec.js
```

It must genuinely pass, not skip. **Negative-check it**: break the feature, confirm the test fails, revert cleanly (`git checkout --`), and report the failure output. A spec that cannot fail is not coverage.

- [ ] **Step 3: Gates and commit**

```bash
cd api && npm run check && cd ../web-tests && npm run test:all
```

```bash
git add web-tests/e2e/ops-mark-paid.spec.js
git commit -m "test(ops): e2e cover marking a booking paid and unblocking the pipeline"
```

---

## Done when

- A quote with disconnected legs converts to a booking that keeps **every** stop — nothing is silently discarded.
- A chauffeur trip's dates still land on the right segments once gap stops shift the indices.
- No `driven` field remains anywhere.
- An out-of-band booking can be marked paid, records a `manual`-sourced payment for the right amount, becomes refundable, and advances through the pipeline to Done.
- No customer email is sent by mark-paid.
- The accepted display gap is logged in `docs/known-bugs.md`.
- `cd api && npm run check` and `cd web-tests && npm run test:all` both green.
- No migration, no pricing change, no config change in the diff.

## Next piece (not this plan)

Normalise the booking's trip into discrete legs per `docs/backend-spec.md` §5.2 (`itinerary` / `leg` with `travel_date` / `stay`), matching how a quote already models a trip. Fixes leg gaps, per-leg dates, and this class of bug at the root. Needs its own brainstorm and spec — "what is a leg" touches pricing, the website booker, customer emails and driver dispatch.

## Deploy note

Merging to `main` deploys to **staging** only. Production is a separate promote PR and needs the owner's explicit ok.
