# Customer quote intent (requested service) — design

**Date:** 2026-07-17
**Status:** decisions I1–I10 approved by owner; spec revised after owner critique (2026-07-17). Not yet built.
**Milestone:** follows M11 quote lifecycle + the 2026-07-01 service chooser

Record, on each quote, **which service the customer actually asked for** — point-to-point,
chauffeur-guide, or both — so the quote reviewer knows **which options to focus on** when
approving, instead of weighing two prices with no idea which one the customer wanted.

## Problem

The quote tool prices **one** service but shows **two**. Per the 2026-07-01 service-chooser spec
(R1), the builder renders a Point-to-point total and a Chauffeur-guide total side-by-side; the
submitter picks one via `state.service`, and that lands in `quotes.product`.

So the quote records **what was priced**. Nothing records **what was requested**. When the founder
opens a quote to approve it (maker-checker, `quote:approve`), there is no signal telling them which
of the two the customer asked about — they cannot tell a deliberate chauffeur quote from a
point-to-point quote whose chauffeur box is merely informational.

Note the distinction from the Output-tab **"Add chauffeur-guide option"** upsell toggle
(`outputIncludeChauffeurUpsell`): that is a *sales* decision about what goes in the outgoing
message. This is a *record* of what the customer asked for. They are related (see I9) but distinct.

## Decisions (owner, 2026-07-17)

| # | Decision | Rationale |
|---|---|---|
| I1 | **The submitter records it**, not the customer | v1 is ops-channel only (quote lifecycle D1); the request arrives by WhatsApp/email and the submitter transcribes it |
| I2 | **Values = `private` \| `chauffeur` \| `both`** | Mirrors the chooser's two services plus the "show me both" case. `shared` is excluded — the tool's chooser is private/chauffeur only |
| I3 | **Required before review** — blocks `→ pending_review` and `→ ready` | The field exists so the reviewer always has it; an optional field would be empty exactly when needed |
| I4 | **No default / no pre-fill** from the priced service | A pre-filled value gets accepted unread, which makes the record untrustworthy — the opposite of the goal |
| I5 | **Flat column**, not JSONB | Matches `product`/`vehicle`, and keeps the gate a plain column check |
| I6 | **No decoration of the recorded value** — no price-box markers, no header line, no queue pill; chooser and queue unchanged | Owner: *"It's not about the eye landing. It's about the quote reviewer knowing which options to focus on."* The recorded field answers that by being read; it does not need to compete for attention. The mismatch line (I8) is the one deliberate exception — it is a signal that something is *wrong*, not a restatement of the value |
| I7 | **No legacy exemption — every quote is gated** | REVERSED after owner critique: fewer than ~10 quotes are in flight, so a backfill sentinel + save-preservation logic cost more than the handful of clicks they save, and would leave a permanent hole in I3 |
| I8 | **Show a mismatch** when the recorded request ≠ the priced service | REVERSED after owner critique: comparing two values is nearly free, and it is the only part that makes this an active check rather than a passive note — it catches exactly the error the review exists to catch |
| I9 | **Recording `both` defaults the chauffeur upsell ON** (still overridable) | Without this, a submitter records "customer asked for both", the founder approves, and the message goes out with one price because a second, unrelated toggle was forgotten |
| I10 | **`both` requires a point-to-point-priced quote** | The upsell is one-directional — the tool can append a chauffeur price to a p2p quote but has no reciprocal "add point-to-point option". So `both` priced as chauffeur cannot express both prices, and is treated as a mismatch |

## Data model — `quotes` (next free migration; `0015_quote_assignment` landed 2026-07-16)

| column | type | notes |
|---|---|---|
| `requested_service` | `text` nullable | `'private' \| 'chauffeur' \| 'both'` |

```sql
ALTER TABLE quotes ADD COLUMN requested_service text;
```

That is the whole migration. **No backfill** (I7): existing rows keep `null`, which reads fine and
simply means *"nobody has recorded this yet"*. They are gated like any other quote — whoever picks
up an in-flight draft sets the field once on the way through.

Nullable by design. A `NOT NULL` constraint would either break reads on existing rows or force a
false backfill value; the requirement is a **workflow gate**, not a storage constraint.

## Capture (ops builder)

A three-way control labelled **"Customer asked for"** — Point-to-point / Chauffeur-guide / Both —
styled like the existing chips, placed near the service chooser **without modifying it**.

- Starts unselected (I4). Selecting it changes nothing about the price, `state.service`, or the
  itinerary — with one deliberate exception: choosing **Both** switches the Output tab's
  "Add chauffeur-guide option" toggle on (I9). The submitter can still switch it back off.
- Rides in the tool payload beside the existing `service` field
  (`internalQuote.ts` `parseToolRequest`, currently `service: z.enum(['private','chauffeur']).optional()`)
  as `requestedService: z.enum(['private','chauffeur','both']).optional()`, and persists through the
  existing `POST /save`.
- Follows the builder's existing editability rules: editable in `draft` / `pending_review` /
  `changes_requested`, locked once `ready` / `sent`, editable again after a founder reopens.

## Mismatch (I8)

Shown in the builder whenever a request is recorded and the quote does not express it. Plain text
near the service chooser — **not a blocker**, because the reviewer decides:

| recorded | priced | verdict |
|---|---|---|
| `private` | `private` | ok |
| `chauffeur` | `chauffeur` | ok |
| `both` | `private` | ok — the chauffeur upsell carries the second price (I9) |
| `private` | `chauffeur` | **mismatch** — "Customer asked for Point-to-point; this quote is priced Chauffeur-guide" |
| `chauffeur` | `private` | **mismatch** — reciprocal wording |
| `both` | `chauffeur` | **mismatch** (I10) — "Customer asked for both; a chauffeur-priced quote can't carry the point-to-point price. Price it point-to-point and add the chauffeur option." |

The `both`/`chauffeur` row exists because the upsell is one-directional: `appendChauffeurUpsell()`
adds a chauffeur total to a point-to-point message, and `setService()` force-clears
`outputIncludeChauffeurUpsell` whenever the service isn't `private`. There is no
"add point-to-point option" counterpart, so a chauffeur-priced quote structurally cannot show both.

Display-only: it reads `state.requestedService` against `state.service`, so it needs no server work
and no extra column.

## Enforcement

**Server (authoritative).** `PATCH /:id` rejects `→ pending_review` and `→ ready` when the row's
`requested_service` is null:

```
400 { error: 'requested_service_required' }
```

Checked against the **stored** row, not the request body. Covers both the submitter's "Submit for
review" and the founder's `draft → ready` self-approve (a legal transition per `canTransition`, so
it needs the same gate). Sits alongside the existing maker-checker checks in the same handler.

**Client (UX only).** "Submit for review" is disabled with a hint naming the missing field. A client
that bypasses it still gets the 400.

**`POST /save` is NOT gated.** Only submission is — a submitter must always be able to save
work-in-progress on a quote they haven't finished transcribing.

**The mismatch does NOT block** submission or approval (I8 is a signal, not a gate). A submitter may
legitimately quote a different service than asked; the reviewer needs to *see* that, not be stopped.

## Testing (red first, per CLAUDE.md rule 5)

| layer | test |
|---|---|
| `quoteRepo` | `requestedService` round-trips through create/get/patch; absent → null |
| `POST /save` | persists a supplied value; omitting it leaves null |
| `PATCH /:id` | `→ pending_review` 400s on a null row, 200s once set; founder `draft → ready` self-approve is gated identically; a pre-existing (null) row is gated too — no exemption (I7) |
| mismatch | the table above, as a pure function over (recorded, priced) — including `both`+`chauffeur` → mismatch |
| ops shell | the "Customer asked for" control renders; choosing Both turns the chauffeur upsell on, and it can still be turned back off (I9) |

Gates: `cd api && npm run check` and `web-tests` `npm run test:all` green before commit.

## Out of scope

- **Queue column / price-box markers / header line** (I6).
- **A reciprocal "add point-to-point option" upsell.** It would make `both` work from a
  chauffeur-priced quote and delete the I10 mismatch row — a bigger change to the output builder,
  worth its own decision. Noted, not assumed.
- **`shared` product** — not offered by the chooser.
- **Customer-facing capture** — v1 is ops-channel only (D1). If web quoting lands, the customer's own
  selection becomes the natural source and this field should take it directly.
- **Auditing who set/changed the field.** The quote-assignment audit trail exists; extending it here
  is not requested.

## Risks

- **Schema change ships on merge.** CLAUDE.md rule 7: since PR #50 (2026-07-16) Render applies
  pending migrations on boot, fail-closed, so **merging is the schema release** — no owner-run
  migrate stands between the merge and prod's schema. The owner has approved this migration; flag it
  again at PR time.
- **Every in-flight draft needs the field set once** before it can be submitted (I7). Owner
  confirmed fewer than ~10 are in flight, which is what makes this the cheaper trade.
- **The record is only as good as the transcription.** Nothing verifies the submitter recorded what
  the customer truly asked for; I4 (no pre-fill) is the only safeguard, and it is a weak one. If the
  field starts being filled in reflexively, the mismatch signal (I8) is what will expose it.
