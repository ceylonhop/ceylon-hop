# Customer quote intent (requested service) — design

**Date:** 2026-07-17
**Status:** approved for build (owner decisions recorded below)
**Milestone:** follows M11 quote lifecycle + the 2026-07-01 service chooser

Record, on each quote, **which service the customer actually asked for** — point-to-point,
chauffeur-guide, or both — so the founder reviewing the quote knows which of the two side-by-side
prices to verify and which to ignore.

## Problem

The quote tool prices **one** service but shows **two**. Per the 2026-07-01 service-chooser spec
(R1), the builder renders a Point-to-point total and a Chauffeur-guide total side-by-side, and the
submitter picks one via `state.service`; that choice lands in the `quotes.product` column.

So the quote records **what was priced**. Nothing records **what was requested**. When the founder
opens a quote to approve it (maker-checker, `quote:approve`), both prices are on screen and there is
no signal telling them which one the customer asked about. They cannot tell a deliberate
chauffeur quote from a point-to-point quote whose chauffeur box is merely informational.

Note the distinction from the existing Output-tab **"Add chauffeur-guide option"** upsell toggle
(`outputIncludeChauffeurUpsell`): that is a *sales* decision about what goes in the outgoing message.
This is a *record* of what the customer asked for. They are independent and stay independent.

## Decisions (owner, 2026-07-17)

| # | Decision | Rationale |
|---|---|---|
| I1 | **The submitter records it**, not the customer | v1 is ops-channel only (quote lifecycle D1); the customer's request arrives by WhatsApp/email and the submitter transcribes it |
| I2 | **Values = `private` \| `chauffeur` \| `both`** | Mirrors the chooser's two services plus the "show me both" case. `shared` is excluded — the tool's chooser is private/chauffeur only |
| I3 | **Required before review** — blocks `→ pending_review` and `→ ready` | The field exists so the founder always has it; an optional field would be empty exactly when needed |
| I4 | **No default / no pre-fill** from the priced service | A pre-filled value gets accepted unread, which makes the record untrustworthy — the opposite of the goal |
| I5 | **Flat column**, not JSONB | Matches `product`/`vehicle`; keeps it queryable for conversion tracking (what customers ask for vs what they buy — the stated M11 goal) |
| I6 | **No new founder-facing surface** — chooser, queue and Output tab unchanged | Owner: "it can keep the toggle/button choice as is". The recorded field is itself what the founder reads |
| I7 | **Legacy quotes are exempt** via a `'legacy'` backfill sentinel | Owner chose to gate only quotes created after this ships, so in-flight drafts aren't stranded |
| I8 | **No mismatch warning** when requested ≠ priced | YAGNI; the founder reads both boxes and judges. Revisit only if it actually bites |

## Data model — `quotes` (migration 0015)

| column | type | notes |
|---|---|---|
| `requested_service` | `text` nullable | `'private' \| 'chauffeur' \| 'both' \| 'legacy'` |

Nullable by design. A `NOT NULL` constraint would either break reads on existing rows or force a
false backfill value; the requirement is a **workflow gate**, not a storage constraint.

The migration is two statements:

```sql
ALTER TABLE quotes ADD COLUMN requested_service text;
UPDATE quotes SET requested_service = 'legacy' WHERE requested_service IS NULL;
```

The backfill is what implements I7. After it runs the rule is simply **null is gated, non-null
passes** — no cutoff timestamp to go stale. Rows that existed at migration time carry `'legacy'`;
rows created afterwards start null and are gated.

`'legacy'` is a real value in the domain, not a null-alias. It means *"this quote pre-dates the
field"* — distinct from `null`, which means *"nobody has recorded this yet"*. Keeping them separate
is what lets the gate be a one-line null check while old quotes still move.

## Capture (ops builder)

A three-way control labelled **"Customer asked for"** — Point-to-point / Chauffeur-guide / Both —
styled like the existing chips, placed near the service chooser **without modifying it**.

- Starts unselected (I4). Selecting it changes nothing else: not the price, not `state.service`,
  not the itinerary, not the upsell toggle.
- Rides in the tool payload beside the existing `service` field
  (`internalQuote.ts` `parseToolRequest`, currently `service: z.enum(['private','chauffeur']).optional()`)
  as `requestedService: z.enum(['private','chauffeur','both']).optional()`, and persists through the
  existing `POST /save`. The enum deliberately **excludes `'legacy'`**: that value is written only by
  the migration's backfill, so no client can mint an exemption for a new quote.
- Follows the builder's existing editability rules: editable in `draft` / `pending_review` /
  `changes_requested`, locked once `ready` / `sent`, editable again after a founder reopens.
- A `'legacy'` row renders as **"Not recorded — older quote"** with nothing selected. The submitter
  may set a real value, which replaces the exemption.

### Save must not trap legacy quotes

`POST /save` writes `requested_service` **only when the payload provides one**. Re-saving a
`'legacy'` quote whose control was never touched preserves `'legacy'` rather than nulling it — which
would silently pull an exempt quote behind the gate mid-edit, contradicting I7.

## Enforcement

**Server (authoritative).** `PATCH /:id` rejects `→ pending_review` and `→ ready` when the row's
`requested_service` is null:

```
400 { error: 'requested_service_required' }
```

Checked against the **stored** row, not the request body. It covers both the submitter's "Submit for
review" and the founder's `draft → ready` self-approve (a legal transition per `canTransition`, so it
needs the same gate). It sits alongside the existing maker-checker checks in the same handler.

**Client (UX only).** "Submit for review" is disabled with a hint naming the missing field. This is
convenience — a client that bypasses it still gets the 400.

**`POST /save` is NOT gated.** Only submission is. A submitter must always be able to save
work-in-progress on a quote they haven't finished transcribing.

## Testing (red first, per CLAUDE.md rule 5)

| layer | test |
|---|---|
| `quoteRepo` | `requestedService` round-trips through create/get/patch; absent → null |
| migration | an existing row is stamped `'legacy'`; a row created after is null |
| `POST /save` | persists a supplied value; omitting it on a `'legacy'` row preserves `'legacy'` |
| `PATCH /:id` | `→ pending_review` 400s on a null row, 200s once set; `'legacy'` row passes; founder `draft → ready` self-approve is gated identically |
| ops shell | the "Customer asked for" control renders; a `'legacy'` quote shows "Not recorded — older quote" |

Gates: `cd api && npm run check` and `web-tests` `npm run test:all` green before commit.

## Out of scope

- **Mismatch warning** when requested ≠ priced (I8).
- **Queue column / price-box markers / header line** (I6).
- **The Output-tab upsell toggle** — untouched; recording `'both'` does not flip it on.
- **`shared` product** — not offered by the chooser.
- **Customer-facing capture** — v1 is ops-channel only (D1). If web quoting lands, the customer's own
  selection becomes the natural source and this field should take it directly.

## Risks

- **Schema change ships on merge.** CLAUDE.md rule 3 flags migrations as stop-and-ask; the owner has
  approved this one. Since PR #50 (2026-07-16) Render applies pending migrations on boot, fail-closed,
  so there is no manual release step — but the column lands in prod the moment this merges.
- **Accepted hole (I7).** An old quote can still reach the founder with no recorded intent. The
  exemption is permanent for those rows and shrinks only as they are sent or closed out.
