# Positive location identification — design

**Date:** 2026-08-02
**Status:** approved, not yet planned
**Follows:** PR #278 (`fix(maps): an ambiguous place label must not price a wrong-town distance`)

## The problem

Quote **Q-CEVGM** priced Yala → Colombo Airport at **78 km instead of ~286**, and went to the
customer at **$499 instead of $589**.

The leg's stop was stored as Google's autocomplete label `"Yala, Sri Lanka"` rather than the
catalog name `"Yala"`. `knownCoords()` matched `COORDS` on an exact lowercased name, so the
lookup missed, the coords pin never applied, and the bare string reached Google's geocoder —
which resolved it to a village near Horana (6.664, 80.071) instead of the national park
(6.464, 81.472).

PR #278 closed that specific class: a country suffix is now stripped before the catalog
lookup, `/places` no longer offers the ambiguous twin, and a physical floor guard (a road
cannot be shorter than the straight line between its endpoints) rejects an impossibly short
answer **when both endpoints are catalog places**.

**What #278 does not cover:** a stop that is not a catalog place at all — a hotel, a beach, a
villa. There is no trusted coordinate for it, so there is no floor to check against, and a bad
geocode still prices silently.

### Why we cannot detect this from the outside

Measured against the live Geocoding API on 2026-08-02:

| query | results | `partial_match` | top result |
|---|---|---|---|
| `Yala, Sri Lanka` | 1 | **false** | Yala, Sri Lanka (the wrong one) |
| `Yala` | 3 | false | Mueang Yala District — **Thailand** |
| `Ella` | 1 | false | Ella, Sri Lanka |

For the exact string that caused the incident, Google returns a single result and reports
**no** partial match. It is confident, and it is wrong. Any design keyed on Google's own
confidence signals is therefore dead on arrival.

Note also that bare `Yala` resolves to Thailand — which is what the existing coords pin has
been silently protecting against all along.

## The rule

> **A location may only be priced if it has been positively identified.**
> Identified means: it is a catalog place, or a human has confirmed it once.
> Anything else refuses to produce a distance and blocks the quote.

This is foolproof by construction: it never has to *recognise* the bad case. Google's
confidence being worthless stops mattering, because we stop asking Google whether it is sure.

Human effort is explicitly acceptable here (owner call, 2026-08-02). The goal is not zero
friction; the goal is that the system never silently chooses.

## Measured cost of the friction

Across all 62 quotes in production:

| metric | value |
|---|---|
| stop uses (every leg endpoint) | 213 |
| distinct exact strings | 63 |
| distinct **canonical keys** | 53 |
| ...already catalog | 17 |
| ...needing a confirmation | **36** |
| keys used more than once | 33 (62%) |

So the entire history of the business would have produced **36 prompts** — about one per six
stop entries. The twelve most-used non-catalog strings account for 52 of those uses, so a
single sitting covers the bulk of repeat traffic.

Crucially, several of those are **aliases of existing catalog entries** — `sigiriya` (7×),
`arugam bay beach` (7×), `yala national park` (6×), and a 5×-used full postal rendering of
Colombo airport. Confirming them onto the catalog coordinate merges them, which also repairs
the analytics fragmentation described in §7.

## Architecture

### The key decision: confirmations are keyed by string, server-side

A stop string is authored in at least five front-end paths — `acPick`, typed-then-blurred,
`addStop`/`removeStop`/`Return to start`, `addLeg` chaining a pickup from the previous
dropoff, and `rebuildSegments` on reorder — plus templates, tours, reopened quotes and
quote→booking conversion. Attaching a coordinate at each authoring site means touching all of
them, and missing one silently reopens the hole.

All of those paths converge on **one call**: `maps.distance(from, to)`, reached from
`POST /admin/quote/distance` and the server-side leg resolvers at `internalQuote.ts:189` and
`:208`. Nothing prices without passing through it.

Therefore the resolution lives there, and confirmations are stored server-side keyed by the
canonical string. No stop shape changes, no dual-shape era, no migration of the builder, and
every authoring path — including ones not enumerated here — is covered automatically.

### Canonical key

Reuse `canonPlace()` from `api/src/adapters/maps.ts` (shipped in #278): trim, lowercase,
collapse internal whitespace, strip a trailing `, sri lanka`.

### New table: `place_resolutions`

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `canon_key` | text, **unique, not null** | output of `canonPlace()` |
| `display_name` | text not null | what ops sees; from Google or the catalog |
| `lat`, `lng` | double precision not null | the trusted coordinate |
| `source` | text not null | `catalog` \| `confirmed` \| `auto_linked` |
| `confirmed_by` | text null | ops identity email; null for `catalog` |
| `confirmed_at` | timestamptz null | null for `catalog` |
| `created_at` | timestamptz not null default now() | |

The migration seeds the 21 `COORDS` entries as `source='catalog'`. `COORDS` stays in code as
the seed and as the offline-estimate source; it is no longer the only lookup.

### Resolution order inside `maps.distance`

1. `canonPlace(name)` → `place_resolutions` row → use its `lat,lng`.
2. Miss → attempt **auto-link** (below). A geocode may be issued here, but *only* to test the
   string against already-trusted anchors — its result is **never** used to price directly.
   That distinction is the whole design: a geocode may identify a place we already trust, it
   may not introduce a new one.
3. Auto-link declines → return a distinct `needs_confirmation` outcome naming the unresolved
   endpoint. No distance is produced.
4. Both endpoints resolved → send coordinates to Distance Matrix, never a name, and apply the
   floor guard. Because every resolved stop now carries a coordinate, **the floor guard becomes
   universal** — including hotels, which is the gap #278 left.

### Auto-link (removes most residual friction)

On a miss, geocode the string once to get a candidate point. If that point falls within
**1.0 km** of exactly one existing `confirmed` or `catalog` row, write an `auto_linked` row
pointing at the same coordinate and proceed without prompting.

This is not the system guessing: the anchor was human-verified, and an independent geocode
agrees with it to within a kilometre. If the point is within 1.0 km of *more than one* existing
row, or of none, it prompts.

### Confirmation flow

- `GET /admin/quote/place-candidates?q=<string>&near=<lat,lng>` — returns up to 6 candidates,
  each with `display_name`, `lat`, `lng`, an administrative-area label, and, when `near` is
  supplied (the previous stop's coordinate), the straight-line distance from it. The candidate
  list is what makes the choice unmistakable: `Yala · Western Province · 240 km from Arugam
  Bay` beside `Yala National Park · Southern Province · 175 km`.
- `POST /admin/quote/place-confirm` — body `{ canonKey, displayName, lat, lng }`, writes the
  row with `source='confirmed'` and the caller's identity.
- Capability: **`quote:manage`**. Confirming a location is an identification act, not a pricing
  policy act — any ops user building a quote must be able to unblock themselves. Setting a
  hot-zone surcharge on a place remains founder-only and is unchanged.

### Front-end

Reuse the existing refusal vocabulary rather than inventing one:

- The leg renders the existing "No distance" warn state, with a **Confirm location** action.
- The unconfirmed stop becomes a `submitBlockers()` entry, so Submit/Approve already reports
  *"N things are still missing — press to see them."*
- The confirm panel is one new small panel; it does not touch stop state, `acPick`, chaining,
  or templates.

## Error handling

| situation | behaviour |
|---|---|
| Geocoder unreachable while fetching candidates | Panel shows the failure and a retry. Nothing is written; the leg stays blocked. |
| Distance Matrix unreachable, both endpoints resolved | Existing behaviour: offline estimate flagged `estimated`, on which pricing already declines to charge. |
| Floor guard violated | Refuse the answer, fall back to the flagged estimate (as #278 already does). |
| Two rows claim the same `canon_key` | Impossible — unique constraint. Confirm is an upsert. |
| A confirmed row is later found to be wrong | Out of scope for v1; correcting it is a direct DB edit. See §Deferred. |

## Testing

- **Unit** (`maps.test.ts`): resolution order; `needs_confirmation` on a miss; no geocode-and-guess
  on a miss; floor guard now firing for a non-catalog pair; auto-link inside and outside the
  1.0 km boundary; auto-link declining when two anchors are in range.
- **Unit** (`internalQuote.test.ts`): both endpoints must resolve before a distance is returned;
  `place-confirm` requires `quote:manage`; confirm is idempotent on `canon_key`.
- **e2e** (`web-tests/e2e/`): a leg with an unconfirmed stop shows no price and blocks Approve;
  confirming it prices the leg and clears the blocker.
- **Regression**: pin the incident directly — a leg whose stop is `"Yala, Sri Lanka"` must never
  yield 78 km.

## Rollout

Migrations auto-apply on Render boot and merging one **is** releasing it, so this ships in two
deliberate stages to avoid blocking ops on day one with 36 unconfirmed places:

1. **Stage 1 — non-blocking.** Table, seeds, resolution, auto-link, candidates/confirm
   endpoints, and the confirm panel. An unresolved stop **warns** and still prices via today's
   path. Ops confirms the high-traffic backlog (~12 strings covers most volume).
2. **Stage 2 — flip to blocking.** Unresolved stops stop producing a distance and become submit
   blockers. One small change, once the backlog is empty.

Stage 1 is safe to promote at any time; Stage 2 is the behavioural change and should promote on
its own.

## Analytics (§7)

`services/analytics/extractLegs.ts` canonicalizes against `KNOWN_PLACES` with its own local
`canonPlace` that does **not** strip the country suffix — so today `Yala` and `Yala, Sri Lanka`
are counted as two destinations, and the demand data is already fragmented.

Point it at `place_resolutions` instead. Aliases then merge, and the Demand and movers cards
finally count one place once.

**This will change existing charts** — historical counts re-merge. That is the intended repair,
but it should not be a surprise when the numbers move.

## Deferred (explicitly not in v1)

- **Ranking suggestions by real usage.** The original motivation. It becomes easy once
  identities are clean — `extractLegs` already aggregates the data and no new table is needed —
  but ranking split counts would be worse than not ranking, so it waits for this.
- **Editing or revoking a confirmed row** through the UI.
- **Re-verifying stale confirmations.** Coordinates do not rot the way Google `place_id`s do
  (Google documents that IDs change, go `NOT_FOUND`, and should be refreshed if older than 12
  months) — which is precisely why this design stores coordinates and not IDs.
- **The assertive map.** Pin 9 of Q-CEVGM already drew the error on screen; labelling pins with
  their leg number and flagging one far off the corridor is a cheap, separate improvement.
- **Making the "legs don't connect" banner report every seam.** It currently reports only the
  first, which is why it stayed silent about the Yala seam.

## Out of scope

The three live quotes still holding the ambiguous string keep their stored kilometres; code
cannot retro-fix saved numbers. `Q-4CQ66` is `sent` at $135.50 against a true ~281 km (~23%
under) and needs a separate business decision.
