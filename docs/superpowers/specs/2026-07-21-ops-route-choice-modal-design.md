# Ops route-choice modal — design

**Date:** 2026-07-21
**Status:** Draft for review
**Scope:** Ops quote tool only (`api/src/routes/ops-ui.html`). Customer booker is out of scope (route-choice Phase 2, separate spec).
**Supersedes the ops-side UI of:** `docs/superpowers/plans/2026-07-20-route-choice-ops-quote.md` (Phase 1, shipped 2026-07-21 via PRs #83/#85/#88). Backend, persistence, and the note-string contract from Phase 1 are **reused unchanged**.

## Problem

Phase 1 shipped route choice as an on-demand `Compare routes` link that, when clicked, reveals two inline pills (Expressway / Local road). In practice the link is **easy to miss** — an agent building a quote can quote the default fast/tolled route without ever noticing a materially cheaper toll-free alternative existed. Making the affordance louder on *every* leg would be noise, because most legs have no meaningful alternative.

## Goal

Surface the choice so agents **cannot miss it when it matters**, without nagging them when it doesn't, and without stealing focus at the wrong moment. When a leg genuinely has two materially different routes, present a clear, honest, map-backed comparison. Otherwise, show nothing.

## Solution overview

Replace the inline two-pill picker with a **route-choice modal** that:

1. **Auto-opens** the moment a point-to-point leg resolves to a real fork (`hasChoice`) — so it can't be skated past.
2. Presents both routes on a **map** plus two **option cards** framed as an honest time-vs-money tradeoff (neither pre-sold).
3. Is **dismissible** and **never blocks permanently** — dismissing keeps the fast default, and the leg keeps a compact inline affordance to reopen and change the choice any time.

The approved visual (two option cards, each leading with its own strength, a stat grid, a route swatch tied to the map line, and a "best for" cue; blue/amber route colors kept off the brand teal) is the reference design for this build.

## Why this is mostly a front-end change

The backend already does the hard part. `api/src/adapters/maps.ts` compares the default (fastest) route against an `avoid=tolls` route and returns `variants: { fastest, noTolls }` **only when the toll-free route is materially different** — specifically when it is at least `CHOICE_MIN_TIME_SAVED_MIN` (currently 30) minutes slower:

```
hasChoice = !!fast && !!slow && slow.durationMin - fast.durationMin >= CHOICE_MIN_TIME_SAVED_MIN
```

The "computed threshold" trigger we want is therefore **already implemented** as `hasChoice`. Today the client only asks for it on demand (`compareRoutes(legId)` behind the button). The redesign makes that request **proactive** and **auto-opens the modal** on the result.

## Detailed behavior

### Trigger (proactive fetch + auto-open)

- When a **point-to-point driving leg** has both endpoints resolved and its distance auto-resolves (the existing auto-distance path), fire the compare fetch automatically — the same `POST /admin/quote/distance { compare: true }` call `compareRoutes` uses today, debounced, instead of waiting for a click.
- If the response includes `variants` (i.e. `hasChoice`), and **all** guardrails below pass, open the modal for that leg.
- **Raise `CHOICE_MIN_TIME_SAVED_MIN` from 30 to 45.** Only auto-pop when the toll-free route is ≥ 45 minutes slower — a higher bar than the current on-demand value, chosen so the modal fires only for genuinely significant forks. No dollar-saving condition. This constant is the single source of truth for "has a fork," so there is no divergent behavior once the on-demand pills are removed.
- Skip the fetch entirely for: manual-distance legs, non–point-to-point legs (stays, per-day chauffeur legs), and legs missing an endpoint.

### Guardrails (so it never nags)

1. **Once per leg.** Track a per-leg "prompted" flag in leg state. Auto-open fires at most once per leg; re-renders, autosaves, and unrelated edits never re-pop it.
2. **Only while editable.** Auto-open only in `draft` / `changes_requested`. Never in `pending_review` / `ready` / `sent`.
3. **Only when undecided.** If the leg already has a `routeVariant` (e.g. a reopened quote where a choice was persisted), do not auto-pop — respect the saved choice.
4. **One at a time.** If a modal is already open (or the itinerary is mid-build with several legs resolving at once), additional qualifying legs do **not** stack or queue modals — they silently fall back to their inline affordance, which the agent opens when ready.
5. **Endpoint change re-arms.** Editing a leg's pickup/dropoff clears the prompted flag and the prior `routeVariant`/`routeOptions` (this reset already happens today), so a genuinely new route can prompt again.

### The modal

- Header: "Two routes for this leg" + "`<from>` → `<to>` · pick which one to quote", with a dismiss `X`.
- Body: a map (both routes drawn) on the left; two option cards on the right.
  - **Expressway** card leads with drive **time**, tagged `Current` (it is the auto-resolved default), stat grid = distance / tolls / price, "best for tight flight connections."
  - **Local road** card leads with **price** + `saves $X`, stat grid = time (`+Xh Ym`) / distance / toll-free, "best for budget or scenic hill country."
  - Selecting a card emphasizes its route on the map and updates the primary button.
- Footer: ghost `Keep expressway, decide later` (dismiss) + primary `Use expressway` / `Use local road`.

### The map

The `variants` payload carries only `{ km, durationMin }` — **no route geometry**. The modal therefore draws both lines with a **real Google map** (decided): reuse the existing Maps JS + polyline rendering already used by the itinerary "Route on map" section, and render two routes (default and `avoid: tolls`) via the client `DirectionsService`, styled so the selected route is emphasized. Accurate, low-risk, and reuses code that already ships. The stylized SVG map from the mock is **not** planned for v1.

### On pick

- **Use expressway** → set `routeVariant = 'fastest'`, apply the fastest km/duration (already the working default), re-price. The customer-message note gains "(via expressway)".
- **Use local road** → set `routeVariant = 'no_tolls'`, apply the toll-free km/duration, re-price. Note gains "(via local road, no highway tolls)".
- **Dismiss** → leave `routeVariant` undefined (no note — matches the Phase 1 contract that the note requires an *explicit* pick), keep the fastest km, mark the leg prompted.

These map onto the existing `routeFastest` / `routeNoTolls` handlers and the existing note logic — no new pricing or persistence code. `routeVariant` and `routeOptions` already serialize on save and rehydrate on reopen.

### Inline affordance (change-it-later + on-their-terms)

The leg keeps a **compact inline control** (replacing the old whisper-link), shown only when the leg has a fork:

- Undecided / dismissed → `Compare routes` (opens the modal).
- Decided → a small `Route: Expressway ▾` / `Route: Local road ▾` chip (opens the modal to switch).

This is how an agent changes the route without the modal ever auto-firing again, and how the choice stays visible after it's made.

### Locked and reopened quotes

- The inline affordance and modal are inert while the quote is content-locked (`pending_review`) or rate-locked (`ready`/`sent`), consistent with every other field.
- To change a committed quote's route, the agent uses the existing **Reopen to edit** path, which drops the rate lock and re-prices live (spec 2026-07-11 §3). On reopen the modal does **not** auto-pop (guardrail 3); the agent opens the inline affordance if they want to change it. No new locking logic.

## Cost

One extra Distance call per point-to-point leg (the `avoid=tolls` compare), where today that call only happens on a button click. `maps.ts` already caches variants for 24h, so repeats and re-renders are free. Acceptable.

## Out of scope

- Customer-facing booker route choice (Phase 2 — separate spec).
- A curated corridor list (a list could replace/augment the computed threshold later without touching the UI).
- The stylized SVG map (v1 uses a real Google map).

## Decisions (resolved 2026-07-21)

1. **Map:** real Google map with two `DirectionsService` routes. Stylized SVG deferred.
2. **Trigger source:** computed `hasChoice` threshold (no curated list).
3. **Threshold:** `CHOICE_MIN_TIME_SAVED_MIN` raised 30 → **45** minutes; no dollar condition.
4. **Pills:** the Phase 1 inline two-pill picker is **removed**; the modal plus the compact inline chip are the only picker.

## Testing

- **Unit:** trigger/guardrail logic (once-per-leg, editable-only, undecided-only, one-at-a-time); note-string on each pick vs dismiss. Reuse `FAKE_VARIANT_PAIRS` (Colombo↔Ella already present) for deterministic variants offline.
- **e2e:** extend `web-tests/e2e/ops-quote-route-choice.spec.js` — auto-open on a fork, no modal on a same-route leg, pick each option updates km/price/note, dismiss keeps default, reopen does not re-pop.

## Rollout

Staging-first per the deploy pipeline (`main` → staging auto). Soak on `ops.staging.ceylonhop.com`, then promote `main` → `production`.
