# Refunds in the ops booking sheet — one block, no dead ends — design

**Date:** 2026-08-07
**Status:** proposed (owner brainstorm 2026-08-07; **revised same day after self-critique** —
the refund-method picker that formed most of the first draft is deferred, see *Deferred*)
**Surface:** `/ops` booking sheet (`api/src/routes/ops-ui.html`) — **UI only**

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
Recovering took a DevTools session. Most operators would have stopped at "it's broken".

Two dead ends sit in the same block:

- An **`api_processing`** row shows a warning instructing the operator to *"find the payment in
  PayHere and either confirm this row with its reference or cancel it"* — and renders **neither
  control**. The server accepts a confirm from that state; only the UI refuses.
- After any refund action the header and queue row keep their **pre-refund status**, because the
  handlers call `reloadRefundDetail(id)` but never `refreshRow(id)`. The owner watched a booking
  read "Paid" seconds after a successful $29 refund and reasonably doubted the refund.

### What already exists (verified against `origin/main` @ `47446c2`)

- `refundHtmlFor(t,d)` renders the **Refunds** block between Payment and Vehicle & pickup;
  `reverseActionsFor(t,d)` renders **Cancel & refund** at the foot. Both are gated on the
  viewer's capabilities, not on each other.
- `openDetail(id)` **does** fetch the refund ledger on sheet open, guarded on `payments:act`
  and degrading to `refunds:[]` with a toast. The ledger is not missing on open.
- `refundSummary(d)` computes `remaining = captured − confirmed − pending`, where pending counts
  `RESERVING_STATUSES`. A full-amount `manual_pending` row therefore correctly drives
  `remaining` to 0 and hides the request button.
- `refundRepo.confirm()` accepts **`manual_pending` or `api_processing`** (`refundRepo.ts:190`),
  explicitly commented as confirmable "on purpose". `cancel()` accepts `manual_pending` only.
- The pending-row controls render on `r.status==='manual_pending' && mayFire` only — which is
  why `api_processing` gets a warning and no controls.
- Reversal is gated on `payments:reverse` (founder, unlimited) or the time-bounded
  `bookings:operate` grant (`domain/reversalWindow.ts`). Finance holds `payments:act`: it reads
  refund history and cannot request, confirm or cancel.
- Handlers `refundrequest`, `refundconfirm`, `refundexecute`, `refundcancel` all call
  `reloadRefundDetail(id)`; none calls `refreshRow(id)`. `cancelbooking` and `markpaid` call
  both.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | The **Refunds** block owns the whole job. **Cancel & refund** keeps only Cancel booking and is retitled **Cancel booking**. | The split is the reported defect. Refund controls belong beside the money summary they act on. |
| D2 | The request form (reason + **Refund $X in full**) moves from the foot into the Refunds block, directly under the summary. | It is the entry point to that block's workflow; putting it anywhere else is what caused the incident. |
| D3 | The confirm form renders for **`api_processing`** as well as `manual_pending`. | The server already permits it and the row's own warning instructs it. A screen that names an action it does not offer is worse than one that stays silent. |
| D4 | The **PayHere API button does not** render for `api_processing`. | The Refund API has no idempotency key; the money may already have moved. Confirm-by-reference and cancel are the only safe exits. |
| D5 | Every refund handler calls `refreshRow(id)` alongside `reloadRefundDetail(id)`. | Matches `cancelbooking`/`markpaid`. A booking reading "Paid" after a successful refund destroys trust in a working feature. |
| D6 | **No server, route, repo or schema change.** | Every story here is a rendering or refetch concern. Keeping the change UI-only means the money state machine is untouched and the blast radius is one file. |
| D7 | Do **not** make `api_failed` cancellable. | It changes which transitions are legal on a money row — a domain rule wanting its own red-green test, not a rider on a UI change. |
| D8 | Do **not** add a refund-method picker now. | See *Deferred*. It was most of the first draft; the critique below is why it is not here. |

## User stories

**US-1 — One place to refund.** As an ops agent, I want every refund control in one block, so I
don't conclude a refund is impossible because the button that starts it and the button that
finishes it are in different halves of the sheet.
- The Refunds block holds summary, request form, per-row completion controls and history.
- Cancel & refund keeps only Cancel booking and is retitled accordingly.
- No refund control appears anywhere else in the sheet.
- Requesting a refund leaves the operator looking at the row they just created, with its next
  action visible without scrolling.

**US-2 — A stuck refund has a way out.** As a founder, I want an `api_processing` row to offer
the actions its own warning tells me to take.
- The reference field and **Confirm** render for `api_processing` as well as `manual_pending`.
- The PayHere API button does **not** render for `api_processing`.
- **Cancel request** does not render for `api_processing` — `refundRepo.cancel()` rejects that
  state deliberately, because cancelling would release a reserve on money that may have moved.
  The warning text already tells the operator to resolve it in PayHere.

**US-3 — The header stops lying after a refund.** As a founder, I want the booking status to
update when a refund succeeds.
- `refundrequest`, `refundconfirm`, `refundexecute` and `refundcancel` each call `refreshRow(id)`
  alongside `reloadRefundDetail(id)`.
- After a full refund the sheet header and the queue row both read **Refunded** with no reload.

**US-4 — Reversal permissions unchanged.** As the business owner, I want the reshuffle to change
nothing about who may reverse a sale.
- The request form stays behind exactly the gate it has today — `payments:reverse`, or the
  time-bounded `bookings:operate` grant, via the existing `mayReverseNow` / `reverseActionsFor`
  logic, which moves with it.
- Finance (`payments:act`) keeps read-only refund history and sees no request or confirm control.
- Ops keeps the 24-hour window and the fresh-intake grace.

## UI

The **Refunds** block, in order:

1. **Summary** — Captured / Previously refunded / Pending / Refundable remaining. Unchanged.
2. **Request** — rendered only when `remaining > 0` **and** the viewer may reverse (the existing
   `mayReverseNow` test, relocated with the form): required **Reason**, then **Refund $X in
   full**. When blocked by the ops time window, the existing explanatory note renders here
   instead, unchanged in wording.
3. **History** — newest first. Per row: status label, amount, reason, requester; plus
   - `manual_pending` → **Refund now via PayHere**, **Cancel request**, and the manual path
     (reference + **Confirm manual refund**). Unchanged from today.
   - `api_processing` → the existing do-not-retry warning, **plus** reference + **Confirm**.
     No API button, no Cancel request.
   - `api_failed` → PayHere's message. No controls (D7).
   - settled → reference and confirming actor. Unchanged.

**Cancel & refund** at the foot becomes **Cancel booking**: the reason field it shares with the
refund request stays, because cancelling still requires one.

**The shared reason field splits in two.** Today a single `#reversereason` input serves both
cancel and refund, because they sit in the same block. Separating the blocks means **two fields
with distinct ids** (`#cancelreason`, `#refundreason`), each cleared by the action that consumes
it. Not one field read by both: a reason typed for a cancellation and then left behind would be
silently attached to a refund, and both are written to permanent audit records. One extra id and
a second `clearInput` call is a cheap price for that not being possible.

## Testing

UI (`api/src/routes/opsUi.test.ts` — served-HTML assertions, the pattern already used there):
- the Refunds block contains the reason input and the request button
- the Cancel & refund block contains **no** refund control
- the confirm form is gated on `manual_pending` **or** `api_processing`
- the PayHere API button is gated on `manual_pending` only
- **Cancel request** is gated on `manual_pending` only
- each of the four refund handlers calls `refreshRow`

Regression guard on the capability gate (`api/src/routes/opsUi.test.ts`): the relocated request
form is still behind `mayReverseNow`, so a time-blocked ops agent gets the explanatory note and
no button. The gate moving location is the risk this change carries; it is the one thing worth a
dedicated assertion.

E2E (`web-tests/e2e/ops-refund-workflow.spec.js`, `CH_E2E_API=1`): after a successful refund the
queue row reads Refunded without a reload. **Not run in this session** — these specs require
`DATABASE_URL_TEST`, and the only local copy sits beside the production `DATABASE_URL`.

## Deferred — the refund-method picker

The first draft of this spec was mostly a PayHere / bank-transfer method picker: method chosen at
request time, defaulted to the payment's provider, overridable, stored on `refunds.provider`.
It is deferred, not rejected. Four problems surfaced on self-critique:

1. **It may solve a problem that no longer exists.** The justification throughout was the
   2026-08-03→07 window when the PayHere Refund API returned 403 and no card refund was
   possible. That outage is over — a live API refund succeeded 2026-08-07 19:51 UTC. Nobody has
   established how often a bank-transfer refund is actually wanted.
2. **No way to change a refund's method** — and that gap sits precisely in the scenario used to
   justify the feature. Request intending PayHere, the API fails, now you want a bank transfer:
   the method is baked into the row, so the only route is cancel-and-recreate, losing the
   original `requestedAt` and reason and leaving a cancelled row explained by nothing but a UI
   limitation. Either the pending row needs an editable method, or the method belongs at
   **confirm** time — which is the approach that was considered and set aside.
3. **The pending state was sold as a chaseable debt and nothing makes it chaseable.** A pending
   refund is visible only inside the booking's own sheet. No queue filter, no badge, no digest
   line. Without one of those, the second step is friction with no payoff.
4. **"No migration" was a false economy.** Reaching it meant overloading `refunds.provider` so it
   means *provider of the payment* on existing rows and *channel we refunded through* on new
   ones, distinguishable only by write date. A nullable `method` column is a trivial migration
   and the honest modelling.

If a real bank-transfer refund is wanted, revisit with those four resolved — starting with
whether the method belongs at request or confirm time.

## Out of scope

- Refund methods other than PayHere (deferred, above).
- Making `api_failed` cancellable (D7) — separate PR. The 2026-08-03 row on `CH-MCF8D` stays
  stuck until then; it reserves nothing, so it blocks no future refund.
- Partial refunds. Our PayHere setup cannot do them and the UI deliberately offers no amount box.
- A cross-booking view of outstanding refunds (see Deferred #3).

## Related

[[ceylon-hop-refunds-live]] · `docs/superpowers/specs/2026-07-23-deposits-balance-payments-design.md`
