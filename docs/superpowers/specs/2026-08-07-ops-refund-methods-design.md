# Refund methods in the ops booking sheet — design

**Date:** 2026-08-07
**Status:** proposed (owner brainstorm 2026-08-07; approaches A/B/C → **A** chosen)
**Surface:** `/ops` → booking sheet (`api/src/routes/ops-ui.html`), `POST /admin/bookings/:id/refunds*` (`api/src/routes/admin.ts`), `api/src/db/refundRepo.ts`

## Problem

Refunding a booking is one job split across two parts of the sheet, and the split is not
discoverable.

**Refund $X in full** sits in the **Cancel & refund** block at the foot of the sheet. Pressing it
records a request and nothing else — no money moves. The controls that *actually* move money
(the PayHere API call, the reference field, Confirm) are in the **Refunds** block near the top,
under Payment. Worse, requesting the refund makes the button that started it disappear: a
full-amount pending row reserves the balance, so `remaining` drops to $0 and the button
correctly hides.

The owner hit exactly this on 2026-08-07 with a live $29 pending on `CH-MCF8D`: pressed Refund,
watched the button vanish, scrolled the foot of the sheet, found nothing, and reasonably
concluded the refund UI was broken. It was not — the controls were two blocks above the fold.

Second gap: the only refund channel the UI acknowledges is PayHere. Every label says PayHere.
But a refund sometimes has to go out another way — most concretely during the 2026-08-03→07
window when the Refund API returned 403 at the OAuth token endpoint and no card refund was
possible at all. Recording "we sent this customer a bank transfer" is possible today only by
typing the transfer reference into a field labelled *PayHere refund reference*.

### What already exists (verified against `origin/main` @ `47446c2`)

- **`refunds.provider` is inherited, not chosen.** `refundRepo.request()` sets
  `provider: captured[0].provider` — the provider of the payment being reversed.
- **No CHECK constrains `refunds.provider`.** `schema.ts` declares it `text('provider').notNull()`.
  Storing `'bank_transfer'` needs **no migration**.
- **`refunds_confirmation_evidence_valid` enforces evidence in the database:** a
  `manual_confirmed` / `api_confirmed` row must have `gatewayRef`, `confirmedBy` and
  `confirmedAt` all non-null, and any other status must have all three null.
- **`refunds_provider_gateway_ref_unique`** is a UNIQUE on `(provider, gateway_ref)` — the same
  reference cannot be recorded twice against one provider. `confirm()` maps the collision to
  `gateway_ref_conflict`.
- `MANUAL_PAYMENT_METHODS = ['cash', 'bank_transfer', 'manual_other']` already exists for
  `mark-paid` (`domain/paymentMethod.ts`), so the vocabulary is established.
- `RESERVING_STATUSES` = `manual_pending`, `manual_confirmed`, `api_processing`, `api_confirmed`.
  `api_failed` is deliberately excluded — PayHere said the money did not move.
- `confirm()` accepts `manual_pending` **or** `api_processing` (`refundRepo.ts:190`); `cancel()`
  accepts only `manual_pending`.
- The UI renders the pending-row controls on `r.status==='manual_pending' && mayFire` only, so
  `api_processing` renders a warning telling the operator to "confirm this row with its
  reference or cancel it" and **no control to do either**.
- Refund handlers call `reloadRefundDetail(id)` but not `refreshRow(id)`, so the sheet header
  and queue row keep their pre-refund status until a reload.
- Reversal is gated on `payments:reverse` (founder, unlimited) or the time-bounded
  `bookings:operate` grant (`domain/reversalWindow.ts`). Finance holds `payments:act`: it reads
  refund history and cannot request, confirm or cancel.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | The **Refunds** block owns the whole job. **Cancel & refund** keeps only Cancel booking and is retitled **Cancel booking**. | The split is the reported defect. Refund controls belong beside the money summary they act on. |
| D2 | The method is chosen when the refund is **requested**, and stored on the row. | The owner chose "log the intent, confirm later" for manual methods. An intent to refund by an unspecified method is not a complete intent — "we owe them $39 **by bank transfer**" is the chaseable fact. |
| D3 | Methods are **PayHere** and **Bank transfer**. No cash. | Owner call, 2026-08-07. Both carry a real reference, so `refunds_confirmation_evidence_valid` is satisfied with no migration. Cash has no reference and would have forced relaxing a money-integrity constraint. |
| D4 | The picker **defaults to the payment's provider**, and may be overridden. | Steers to the obvious answer without trapping the operator when the card route is unavailable — the 403 window is the worked example. A `cash` / `manual_other` payment has no matching refund method and defaults to `bank_transfer`. |
| D5 | `provider` on the refund row changes meaning: *the channel we are refunding through*, not *the provider of the payment*. | One column, one line in `request()`. Downstream already keys off it. The two meanings coincide whenever the operator does not override, which is the common case. |
| D6 | `execute` refuses a non-`payhere` row with `refund_method_mismatch`. | Nothing stops the API being fired at a bank-transfer row today. PayHere would reject it, but the refusal belongs where the reason is knowable. |
| D7 | Fold in the `api_processing` escape and the missing `refreshRow`. | Both are edits to lines this redesign rewrites anyway. Leaving them means editing the same condition twice, and shipping a redesign whose header still misreports state. |
| D8 | Do **not** fold in making `api_failed` cancellable. | It changes which state transitions are legal on a money row — a domain rule deserving its own red-green test, not a rider on a UI change. |

## User stories

**US-1 — One place to refund.** As an ops agent, I want every refund control in one block, so I
don't conclude a refund is impossible because the button that starts it and the button that
finishes it are in different halves of the sheet.
- The Refunds block holds summary, request, method, completion and history.
- Cancel & refund keeps only Cancel booking.
- No refund control appears elsewhere in the sheet.

**US-2 — Refund a card payment in one click.** As a founder, I want to refund a PayHere payment
without opening PayHere's dashboard.
- Refund $X → picker with **PayHere** preselected → reason → pending row marked `payhere`.
- Row shows **Refund now via PayHere**; on success stores the returned reference, marks
  `api_confirmed`, sets the booking to `refunded`, emails the customer.
- Header and queue row stop reading "Paid" without a manual reload.

**US-3 — Refund by bank transfer when the card route is unavailable.** As a founder, I want to
refund by bank transfer even though they paid by card.
- Picker overrides to **Bank transfer**; pending row records `bank_transfer`.
- Row shows a **transfer reference** field and **Confirm transfer sent** — no API button.
- Confirming behaves identically downstream: booking → `refunded`, seats released, customer
  emailed, quote un-won on a full refund.

**US-4 — See money promised but not sent.** As a founder, I want a requested-but-unsent refund
visible as an outstanding debt.
- Pending row shows method, amount, reason, requester and time.
- It reserves the balance; Refund $X hides while a full-amount refund is outstanding.
- Cancelling it releases the reserve and restores the button.

**US-5 — Don't fire the card API at a bank-transfer refund.** As a founder, I want the system to
refuse a nonsensical action rather than let PayHere refuse it.
- `execute` returns `refund_method_mismatch` unless `provider === 'payhere'`.
- The UI never renders the API button on a `bank_transfer` row; the server check is defence in
  depth.

**US-6 — Reversal permissions unchanged.** As the business owner, I want the picker to change
nothing about who may reverse a sale.
- Every entry point stays behind `payments:reverse` or the time-bounded `bookings:operate` grant.
- Finance (`payments:act`) reads history, sees no request/method/confirm control.
- Ops keeps the 24-hour window and the fresh-intake grace.

**US-8 — A stuck refund has a way out.** As a founder, I want an `api_processing` row to offer
the actions its own warning tells me to take.
- The confirm form (reference + Confirm) renders for `api_processing` as well as
  `manual_pending`. The server already accepts it.
- The API button does **not** render for `api_processing` — the money may have moved and the
  Refund API has no idempotency key.

**US-9 — The header stops lying after a refund.** As a founder, I want the booking status to
update when a refund succeeds.
- Every refund handler calls `refreshRow(id)` alongside `reloadRefundDetail(id)`.

## UI

The Refunds block, in order:

1. **Summary** — Captured / Previously refunded / Pending / Refundable remaining. Unchanged.
2. **Request** — rendered only when `remaining > 0` and the viewer may reverse:
   - **Method**: two radio-style chips, PayHere ⦁ Bank transfer, defaulted per D4.
   - **Reason**: required, existing field, moved here from the foot.
   - **Refund $X in full** — the existing full-remainder behaviour.
3. **History** — newest first. Per row: status label, amount, reason, requester; plus
   - `manual_pending` + `payhere` → **Refund now via PayHere**, **Cancel request**, and the
     manual fallback (PayHere reference + **Confirm manual refund**).
   - `manual_pending` + `bank_transfer` → **transfer reference** + **Confirm transfer sent**,
     **Cancel request**.
   - `api_processing` → the existing do-not-retry warning **plus** reference + Confirm (US-8).
   - `api_failed` → PayHere's message. No controls (D8).
   - settled → reference and confirming actor, as today.

The method chip is rendered once, on the request form — not per history row, where it is a fact
rather than a choice. History rows label their method in the status line.

**Legacy rows.** The provider fallback above governs rows written from now on; rows already in
the database inherited the payment's provider unfiltered, so a refund against a cash- or
`manual_other`-paid booking can hold a provider neither method covers. A history row whose
provider is neither `payhere` nor `bank_transfer` renders its method label verbatim and offers
the **manual confirm** path only (reference + Confirm) — never the PayHere API button. This is
the same shape as the `bank_transfer` row, so it needs no extra branch: the API button is gated
on `provider === 'payhere'` positively rather than on `!== 'bank_transfer'`. Stated explicitly
because an unrecognised provider silently rendering the *card* control is precisely the failure
D6 exists to prevent.

## API

- `POST /admin/bookings/:id/refunds` — body gains `method: z.enum(['payhere','bank_transfer']).optional()`.
- `refundRepo.request()` — the provider written to the row is, exactly:

  ```
  input.method ?? (captured[0].provider === 'payhere' ? 'payhere' : 'bank_transfer')
  ```

  So an explicit method always wins; otherwise a PayHere payment yields a PayHere refund and
  every other payment provider (`cash`, `bank_transfer`, `manual_other`, and any gateway added
  later that has no refund path here) yields `bank_transfer`. The refund row's provider is
  therefore always one of the two supported refund methods — never a value the UI cannot render
  a control for.
- `POST /admin/bookings/:id/refunds/:refundId/execute` — 409 `refund_method_mismatch` when the
  row's `provider !== 'payhere'`, checked before `beginApi` so no row is claimed.
- `confirm` / `cancel` — unchanged.

No migration. No new status. No change to `RESERVING_STATUSES` or the evidence CHECK.

## Error handling

- `refund_method_mismatch` → toast "This refund is set to bank transfer — confirm it with the
  transfer reference instead."
- Existing `refund_outcome_unknown`, `refund_declined`, `refund_api_unavailable`,
  `gateway_ref_conflict` handling is unchanged.
- A `gateway_ref_conflict` on a bank transfer means the reference is already recorded against
  another `bank_transfer` refund — toast "That transfer reference is already recorded against
  another refund."
- The method chips are disabled while a request is in flight, alongside the existing
  `refundBusy` guard.

## Testing

Server (`api/src/routes/refunds.test.ts`, `api/src/db/refundRepo.test.ts`):
- request with `method:'bank_transfer'` on a PayHere payment stores `provider:'bank_transfer'`
- request with no method on a PayHere payment stores `provider:'payhere'`
- request with no method on a `cash` payment stores `provider:'bank_transfer'` (D4 fallback)
- `execute` on a `bank_transfer` row → 409 `refund_method_mismatch`, and the row is **not**
  claimed (still `manual_pending`, `apiAttemptedAt` still null)
- confirming a `bank_transfer` row settles it, releases seats and emails, exactly as PayHere does
- finance (`payments:act`) still cannot request, confirm or cancel by any method
- ops outside the 24h window still cannot request by any method
- a legacy row whose provider is neither supported method (e.g. `cash`) is confirmable by
  reference and is refused by `execute` with `refund_method_mismatch`

UI (`api/src/routes/opsUi.test.ts` — served-HTML assertions, the pattern already used):
- the served shell contains the method chips and the bank-transfer confirm control
- Cancel & refund contains no refund control
- the confirm form is gated on `manual_pending` **or** `api_processing`, and the API button on
  `manual_pending` + payhere only
- every refund handler calls `refreshRow`

E2E (`web-tests/e2e/ops-refund-workflow.spec.js`, `CH_E2E_API=1`): request-by-bank-transfer →
confirm with a reference → booking reads Refunded without a reload. **Note:** these specs need
`DATABASE_URL_TEST` and were not run during this session.

## Out of scope

- **Cash refunds** (D3).
- **Making `api_failed` cancellable** (D8) — separate PR. The 2026-08-03 row on `CH-MCF8D`
  stays stuck until then; it reserves nothing, so it blocks no future refund.
- Partial refunds. Our PayHere setup cannot do them and the UI deliberately offers no amount box.
- Refund notifications beyond the existing customer email.

## Related

[[ceylon-hop-refunds-live]] · `docs/superpowers/specs/2026-07-23-deposits-balance-payments-design.md`
