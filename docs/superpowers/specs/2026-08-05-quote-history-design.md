# Quote version history — design

**Date:** 2026-08-05
**Status:** design approved by owner; build not started

## 1. Problem

A quote row is overwritten in place on every save. There is no record of what it used to be.

On 2026-08-04 a customer-facing quote moved from $109.00 to $99.00 and nobody could say why.
Answering it took forensic arithmetic — reconstructing the old state from the charm adjustment,
then querying Google's Distance Matrix to rule out the pickup change — because the $109 state
existed only in a screenshot. The cause turned out to be a $10 extra coming off a fee chip, most
likely a stray click on a row that sits directly under the stop inputs.

Two failures, not one:

1. **Nothing recorded it.** With 27 revisions on that quote, the edit that dropped the fee is
   unrecoverable, along with who made it.
2. **Nothing showed it.** A $10 change was completely silent — no signal anywhere near the money.

`quotes.revision` does not help. It is a **write counter**, not a change counter: `update()` bumps
it unconditionally (deliberately — see §7), autosave fires on a 2.5s debounce after every keystroke
burst, and `transition()` flushes a save even on a clean quote. Most of those 27 revisions are
noise, and some changed nothing at all.

## 2. User stories

1. **Price drift is visible before it reaches a customer.** As ops, I want the quote total to show
   what the customer last saw beside what it says now, so I never send a different price by accident.
2. **Silence means safe.** As ops, I want that line to disappear when the price matches what was
   sent, so no indicator is a positive signal rather than an absent one.
3. **A surprise change can be explained, not reconstructed.** As the founder, I want every
   superseded version stored with who saved it and when.
4. **I can tell which edit did it.** As the founder, I want each version to name the fields that
   changed, so a pickup edit is distinguishable from a dropped fee.
5. **The list is readable.** As the founder, I want autosave noise and no-op saves left out.
6. **Evidence outlives the quote.** As the founder, I want history to survive the quote being
   edited, sent and won.

## 3. Scope

**In:** an append-only version table, a customer-facing-price baseline, a quiet drift indicator in
the ops builder, a `quote:manage` read endpoint, and a minimal history panel (a list — no diff
view). Delivered as **two independent slices** — see §11: the indicator first, since it is the half
that prevents the problem.

**Out, deliberately:**
- **Revert / restore.** Rewinding a quote mid-lifecycle tangles with rate-lock, the revision
  counter and pay-link retirement. Its own feature, if ever.
- **Diff visualisation** beyond the changed-field list of §6.
- **Pruning.** See §8 — at current volumes retention is a problem for a much later year.

## 4. What gets stored

New table `quote_revisions`, one row per **superseded** state:

| column | type | notes |
| --- | --- | --- |
| `id` | `uuid` pk | |
| `quote_id` | `uuid` → `quotes.id` | indexed with `revision` |
| `revision` | `integer` | the revision this snapshot **was** |
| `request_json` | `jsonb` | the itinerary (engine + tool halves) |
| `result_json` | `jsonb` | the priced breakdown, including `lineItems` |
| `total_cents` | `integer` | queryable without parsing JSON |
| `currency` | `text` | |
| `rate_card_version` | `text` | which card priced it |
| `status` | `text` | the quote's status when this content was live |
| `updated_by` | `text` | staff email, falling back to `created_by` (a never-edited revision 1 has no `updated_by`, and an author-less first version is a needless hole); null for the customer web flow |
| `created_at` | `timestamptz` | when this version was SUPERSEDED |

Unique on `(quote_id, revision)` — a snapshot per revision, at most once.

**Snapshot-before-overwrite.** `update()` copies the *current* row into `quote_revisions`, then
writes the new content. History therefore holds every superseded state and `quotes` always holds
the live one — no duplication, and "what did revision 27 look like" is exactly one row. The full
timeline is history ∪ the current row.

**Margin is stored, not served.** `result_json` carries `marginEstimateCents` and hot-zone
annotations, exactly as `quotes.result_json` does. That is fine at rest; §6 governs the wire.

## 5. When it is written

Inside `QuoteRepo.update()` — the sole ops content-write path (`POST /admin/quote/save`) — and
`updateWebV2()`, the customer web-quote edit. Those are the only two places that bump `revision`
(verified against `postgresQuoteRepo.ts`), so they are the only two places content can change.

**In the same transaction as the update.** `db.transaction` is already the pattern in
`postgresBookingRepo` / `postgresRefundRepo`. A snapshot must never be missing for a write that
landed, and a failed snapshot must never let the write land alone.

Postgres note: `.update().returning()` hands back the NEW row, so the transaction must `SELECT`
the existing row first (inside the same transaction) and insert that into `quote_revisions` before
the update runs. `SELECT … FOR UPDATE` on the quote row, so two concurrent saves can't both
snapshot the same revision.

**No-op saves record nothing.** If the incoming content matches the stored content, no snapshot row
is written. `transition()` flushes a save on a clean quote, and those rows would carry zero
information while making the timeline unreadable.

"Matches" is decided by comparing the **incoming `request_json` against the stored one**, not the
result: `result_json` is re-priced server-side on every save, so a rate-card change could make it
differ while the operator changed nothing. Compare with a key-order-stable serialisation
(`JSON.stringify` over a sorted-key replacer) so key ordering can never fake a change. If the
comparison is ever wrong the failure is benign — an extra history row, never a missing one.

The revision counter still bumps on a no-op, exactly as today (§7). So **revision numbers in
history will have gaps** — that is correct and informative: a gap means the counter moved and the
content did not.

## 6. Reading it

`GET /admin/quote/:id/revisions` — gated on **`quote:manage`**, the same capability as editing the
quote. Deliberately NOT founder-only: the founder gate exists to protect margin, and this response
carries none (see below). Ops are the people making the edits, so ops are the people who need to
see what an edit did — locking it to the founder would leave the person who can self-diagnose
unable to look.

Returns newest-first:

```
{ revision, totalCents, currency, updatedBy, createdAt, status, changed: string[] }
```

`changed` names **fields, not values**: `legs`, `stops`, `distance`, `extras`, `vehicle`, `pax`,
`bags`, `dates`, `total`. "Extras changed, total changed" is what turns yesterday's mystery into a
sentence. (Per-revision `totalCents` is served — it is the number the whole feature is about.)

**Computing it spans two tables.** Snapshot-before-overwrite means history holds only *superseded*
states while `quotes` holds the live one, so the newest entry — the one anybody opens this panel
to read — is the **newest history row compared against the current `quotes` row**. Older entries
compare consecutive history rows as usual. Implemented naively against `quote_revisions` alone, the
top entry (the most recent change, and the interesting one) would come back with no `changed` list
at all.

**The wire carries no margin, no rate-card snapshot and no hot-zone annotation** — the same
invariant as `/quotes/pay/view`, and a test asserts it against the raw response.

**History panel:** in the quote builder, same `quote:manage` gate as the endpoint. A list —
revision, when, who, total, and the changed-field chips. No diff viewer. Without any UI, "so we
know when something goes wrong" means running SQL by hand, which is roughly today's situation.

## 7. What is NOT changing

`update()` keeps bumping `revision` unconditionally, including on a no-op save. This is
load-bearing: reaching `ready` re-flushes a save, and that bump is what retires a pay link already
sent to a customer. There is a test pinning exactly this
(`internalQuote.test.ts`, "re-approving with NO edit still retires the link already sent").

History is additive. Nothing about existing quote behaviour moves.

## 8. Volume and retention

Measured on prod 2026-08-05: **93 quotes, 306 revisions, ~1.3 kB of JSON per version** — the entire
history to date would be about 400 kB.

**No pruning, no archival, no TTL.** At a hundred times the current rate this is still tens of
megabytes. Building a pruner now would be inventing a problem.

## 9. The baseline and the drift indicator

Three columns on `quotes`:

| column | meaning |
| --- | --- |
| `customer_total_cents` | **the QUOTE TOTAL** as of the last customer-facing moment; null if never |
| `customer_total_at` | when that was |
| `customer_total_via` | `'sent'` or `'pay_link'` |

Stamped in exactly two places, both of which already patch the row:

- the status → `sent` transition
- the pay-link mint

### It stores the quote total, NOT the amount charged

A partial-leg link (spec 2026-08-04) charges `selectionAmountCents(...)`, which is deliberately
**less** than `quote.totalCents`. Stamping that charged amount would compare a partial baseline
against the live full total and show **permanent false drift** on every quote that ever had a
partial link — "Sent at $63.00 · now $99.00" forever, with nothing wrong.

That failure is worse than it looks: story 2 makes the indicator's *absence* the all-clear, so an
always-lit indicator destroys the signal the whole feature rests on.

So the baseline is always the **quote total at that moment**, giving a like-for-like comparison
against the live total. The amount a partial link actually charged is not lost — it is already
stored in `quotes.sold_cents`.

⚠️ **The mint currently patches only when the selection changed.** A plain full-total mint writes
nothing today, so it must stamp the marker regardless — otherwise the most common way a customer
sees a price leaves no baseline at all.

**The indicator** sits beside the quote total in the builder, and renders **only when
`customer_total_cents` exists and differs from the live total**:

> **Sent at $109.00 · now $99.00**

Quiet by design (owner call): no toast, no confirmation gate, no blocking. Per the motion standard
the number transitions rather than snaps when it moves, and per story 2 its **absence is the
all-clear** — so it must never be suppressed for any other reason.

## 10. Testing

- **Snapshot on write:** an ops save stores the PREVIOUS content at the PREVIOUS revision; the
  live row holds the new one.
- **Atomicity:** a failing snapshot rolls the content write back (no orphan revision). ⚠️ This
  needs fault injection against a real database, and `postgres.test.ts` is DB-gated — it will not
  run in normal CI. Write it, but do not count it as coverage: the in-memory repo cannot model a
  partial transaction, so the guarantee rests on the code review of the transaction block.
- **No-op:** an identical save writes no history row, and `revision` still bumps.
- **Key order:** the same content with its JSON keys in a different order is NOT a change.
- **Re-price:** identical content whose `result_json` differs (a rate-card move) is NOT a change.
- **Web flow:** `updateWebV2` snapshots too.
- **`changed`:** dropping an extra reports `['extras','total']`; moving a pickup that leaves the
  price alone reports `['stops']` and NOT `total` — the Q-DMKNW case in both directions.
- **Wire:** `/revisions` carries no margin, hot-zone or rate-card field; a caller without
  `quote:manage` gets 403, and an ops-role caller with it gets 200.
- **`changed` at the head:** the newest entry compares the newest history row against the CURRENT
  quote row — a timeline whose top entry has an empty `changed` list is the bug this test exists
  to catch.
- **Baseline:** marking sent stamps it; a full-total pay-link mint stamps it; an ops edit does not.
- **Baseline on a PARTIAL link:** minting a 2-of-3-leg link stamps the QUOTE TOTAL, not the
  charged amount — so the indicator stays hidden afterwards rather than showing permanent drift.
- **Indicator:** hidden when equal, shown when different, and hidden again once a fresh send
  re-baselines it.
- **Regression:** the existing "re-approving with NO edit still retires the link already sent" test
  must stay green — history must not tempt anyone into making the revision bump conditional.

## 11. Rollout — two slices, protection first

The two halves are **independent**: the indicator reads three columns on `quotes` and needs nothing
from `quote_revisions`. Bundling them would hold the cheap protective half hostage to the larger
forensic one, so they ship separately.

**Slice 1 — the indicator (prevents the bug).** Three nullable columns, two stamp sites
(mark-sent, pay-link mint), one line of UI beside the total. No new table, no transaction change,
no endpoint. This is the half that stops a silent price change reaching a customer, and it is a
fraction of the work and the risk.

**Slice 2 — the history (explains the bug).** The `quote_revisions` table, the
snapshot-before-overwrite transaction in `update()`/`updateWebV2()`, the `/revisions` endpoint and
the panel.

Both are additive: every existing quote simply has no baseline until its next send, and no history
until its next save. `main` → staging automatically; migrations apply on boot, fail-closed, so
merging a migration is its release. Prod follows via the usual promote PR.

**Backfill:** none. Inventing history for the 93 existing quotes would be fabricating a record, and
a fabricated audit trail is worse than an absent one.
