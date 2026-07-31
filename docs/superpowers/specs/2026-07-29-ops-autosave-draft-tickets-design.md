# Ops dashboard — autosave everything, assign from the first click

**Date:** 2026-07-29
**Status:** approved (owner, 2026-07-29)
**Scope:** ops quote builder + queue, `POST /admin/quote/*`, one new scheduler sweep. No
migration, no pricing change, no config change.

## Problem

An ops agent cannot assign a brand-new quote until they have pressed **Save**. The assignee
picker is rendered but disabled while `state.savedId` is unset (`ops-ui.html`
`renderHeaderAssign`), because assignment is a `PATCH` against an id that does not exist yet.
On a live call that is the wrong order of operations: the agent wants to claim the ticket, or
hand it to a colleague, before they have built anything worth pricing.

Autosave already exists (`fireAutosave`, 2.5s debounce on every `markDirty()`), but it bails
unless the quote is already a real row. New quotes were deliberately left "manual-first" so
half-typed enquiries would not pollute the queue. The owner's decision (2026-07-29) is to
reverse that: create the row eagerly, and clean up what nobody finishes.

## Owner decisions

| Question | Decision |
| --- | --- |
| What is blocked behind Save? | Assigning/claiming the quote |
| How early must assign work? | From the instant "+ New quote" is opened |
| How is a contentless row stored? | `$0` placeholder row — no migration |
| Can a `$0` quote be sent? | **Never.** Hard server-side gate |
| Do shells show in the queue? | Yes, visibly marked as not priced |
| Unfinished drafts? | Auto-delete after 24h untouched |
| Analytics | Exclude unpriced shells from the funnel projections |

## User stories

1. **Claim on the spot.** An agent clicks "+ New quote" while the customer is still talking.
   The ticket exists immediately; they pick their own name in the assignee dropdown before
   typing a single field.
2. **Hand it over cold.** The agent reassigns the empty ticket to a colleague, who gets the
   assignment email and finds it in their queue marked "Not priced yet".
3. **Never press Save.** From the moment the quote can be priced, every edit persists 2.5s
   after typing stops. Closing the tab loses nothing.
4. **Can't send an empty one.** Submit is disabled with a stated reason, and the server
   refuses to move an unpriced quote to `pending_review`, `ready` or `sent`.
5. **The queue cleans itself.** An abandoned click is gone by the next morning's tick;
   anything actually touched gets a fresh 24 hours.
6. **Analytics stay honest.** The funnel's draft count reflects real quotes being built, not
   every click of "+ New quote".

## Design

### The shell marker

A shell is identified by a **positive marker in JSON**, not by inference from `total_cents`:
`request_json` and `result_json` are both `{ "shell": true }`.

This is the whole reason no migration is needed. `product`, `total_cents`, `currency`,
`rate_card_version`, `request_json` and `result_json` are all `NOT NULL` on `quotes`
(`schema.ts`), and `0027_sh7_money_state_constraints` constrains bookings/payments only — so a
`$0` quote row is legal today. The marker also disappears **by construction**: `POST /save`
overwrites `request` and `result` wholesale, so the first real save cannot leave a stale flag
behind.

Derivation used everywhere downstream:

```
isUnpricedShell(q) = q.request?.shell === true
```

`total_cents <= 0` is *not* the test. A shell is a shell because it was never priced, and the
send gate needs a reason it can state precisely.

### 1. Shell creation — `POST /admin/quote/draft`

New route in `internalQuote.ts`, `csrf` + the same capability as `/save` (`quote:manage`).
Takes no body. Inserts:

- `status: 'draft'`, `channel: 'ops'`
- `product`: the builder's default service (`private`)
- `totalCents: 0`, `currency: RATE_CARD.currency`, `rateCardVersion: RATE_CARD.version`
- `requestJson: { shell: true }`, `resultJson: { shell: true }`
- `customerName: null`, `customerContact: null`, `requestedService: null`
- `createdBy` / `updatedBy` / `assignedTo`: the actor (same auto-assign-to-creator rule
  `/save` already applies)

Returns `201 { id, reference, status, assignedTo }` — the same shape `/save` returns on create,
so the builder's existing response handling is reused.

### 2. Builder — the row exists from the first frame

`ops-ui.html`:

- "+ New quote" calls `POST /admin/quote/draft` and sets `state.savedId`, `state.reference`,
  `state.assignedTo` before the first render.
- `renderHeaderAssign` loses its `unsaved` branch: no `disabled`, and the
  "Assigned to you on save" placeholder becomes plain "Unassigned".
- **Failure is non-blocking.** If the create call fails, the builder falls back to today's
  behaviour — unsaved, assign disabled, manual Save — rather than trapping the agent behind a
  network error. The existing `opsReportError` beacon reports it.
- `fireAutosave` drops its `!state.savedId` bail. It **keeps** the `state.vehicleType` /
  priceable gate: `POST /save` runs `resolveAndPrice`, so an unpriceable payload cannot be
  persisted. That is a server constraint, not a policy choice.
- The **Save button stays**: the explicit path, and the escape hatch when autosave errors.
- The `beforeunload` / `_dirty` guard narrows to the pre-priceable window only — the one
  remaining state where typed content genuinely cannot be persisted yet.
- The save-state chip reads "Not priced yet" (rather than "Unsaved") while the quote is a
  shell, so the chip never implies work is at risk when the row already exists.

### 3. A `$0` quote can never be sent

Server-side, in the `PATCH /admin/quote/:id` status block, beside the existing
`requested_service_required` gate:

```
if ((to === 'pending_review' || to === 'ready' || to === 'sent') && isUnpricedShell(current))
  return 400 { error: 'unpriced_quote' }
```

Checked against the **stored row, never the body** — for exactly the reason the
`requestedService` gate is: only `POST /save` writes pricing, so trusting a body value here
would be a hole rather than a shortcut.

The client mirrors it (Submit disabled, reason stated). The client is honesty; the route is the
boundary.

### 4. Queue treatment

- `toSummary` (`quoteRepo.ts`) gains `unpriced: boolean` off the same derivation.
- The `.qtotal` slot in the `qrow` template renders **"Not priced yet"** instead of `$0`, with
  a muted row tone. The row's `aria-label` says the same, replacing the `$0.00` it would
  otherwise announce.
- `customerName` keeps its existing "Untitled" fallback — no new empty-state needed.

### 5. Cleanup sweep

`sweepAbandonedDrafts(now, { quotes })` in `src/services/abandonedDrafts.ts`, modelled directly
on `expireStaleQuotes`: pure over `(now, deps)` so it is deterministic in tests, naturally
idempotent (a deleted row no longer matches), and per-row best-effort so one bad row cannot
strand the sweep.

Rule: for each `channel: 'ops'`, `status: 'draft'` quote — if `isUnpricedShell(q)` and
`now - q.updatedAt >= 24h`, then `softDelete(q.id, 'system:draft-cleanup')`.

- Anchored on **`updatedAt`**, not `createdAt`, so a shell someone actually touched gets a
  fresh 24 hours.
- Assignment does **not** grant immortality: an assigned shell nobody built is exactly the
  noise this removes.
- Soft-delete only — the row stays in the table, so a wrong call is recoverable, consistent
  with the existing soft-delete contract.

Wired into `POST /admin/jobs/notifications` alongside `sweepStaleSharedHolds`,
`runRideBoardCutoff` and `expireStaleQuotes`, in the same `try/catch` best-effort style, adding
`abandonedDrafts` to the response. It runs on the existing daily 06:00 UTC tick
(`.github/workflows/notifications.yml`) — which sets the effective resolution at ~once a day
and is why the window is 24h rather than anything shorter.

### 6. Analytics

`listFunnelRows` / `listDemandRows` exclude unpriced shells, so the funnel's draft count keeps
meaning "quotes being built" rather than "clicks of + New quote".

## Costs accepted

- **Reference numbers gap.** Every "+ New quote" click consumes a reference via
  `genReference()`, so the customer-facing sequence will show gaps. Unavoidable once rows are
  eager; accepted by the owner.
- **Empty rows are real rows.** For up to ~24h the queue can hold shells nobody will finish.
  Bounded by the sweep and visibly marked.

## Testing

Vitest (`api`):

- `POST /admin/quote/draft` creates a `draft` shell, assigns it to the creator, returns
  `201` with a reference; requires the capability; requires csrf.
- `PATCH` to `pending_review`, `ready` and `sent` each return `400 unpriced_quote` for a
  shell; a priced quote is unaffected (existing transition tests stay green).
- A shell that gets a real `POST /save` stops being unpriced (marker cleared, total set) and
  can then be submitted.
- `sweepAbandonedDrafts`: deletes an unpriced draft older than 24h; spares one younger than
  24h; spares a priced draft of any age; spares a non-`draft` status; a repo error on one row
  does not stop the rest.
- `toSummary` sets `unpriced` for a shell and not for a priced quote.

Playwright (`web-tests/e2e`):

- "+ New quote" → the assignee picker is enabled and an assignment succeeds with **no Save
  click**.
- The queue row for a shell shows "Not priced yet", not `$0`.
- Submit is disabled on a shell with a stated reason.

Gates: `cd api && npm run check` and `npm run test:all` green before every commit.

## Out of scope

- Any change to pricing (`rateCard.ts`, `departureRepo.ts`) or to how `/save` prices.
- A pricing-less draft path with nullable money columns (considered and rejected in favour of
  the `$0` shell + send gate).
- Booking-side or Ride Board drafts.
- A more frequent cron tick.
