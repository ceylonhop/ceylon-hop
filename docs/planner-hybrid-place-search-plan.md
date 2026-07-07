# Planner Hybrid Place Search Plan

## Summary
Replace the planner route-step native place dropdowns with a hybrid autocomplete. Scope this first implementation to `plan.html` / `plan.js` only. Do not redesign the planner cards, route summary, map, date step, booking flow, or global search page.

The autocomplete ranks Ceylon Hop known places first so baked distances and prices stay stable, while still leaving room for exact hotels and landmarks as a later Google-backed extension.

## Goals
- Make `CMB`, `airport`, and common town names easy to search without confusing `Colombo Airport (CMB)` with `Colombo city`.
- Preserve current baked-route pricing whenever a selected suggestion maps to a known Ceylon Hop place.
- Keep legacy planner URLs working, including `stops=Colombo Airport (CMB)|Kandy`.
- Keep the existing planner visual language: same cards, labels, teal focus treatment, compact controls, and no new layout concept.
- Add regression tests that prevent location-ranking and state drift.

## Non-Goals
- Do not replace search-page dropdowns in this PR.
- Do not introduce a new design system, map UI, or modal.
- Do not silently price unknown free text as if it were a verified exact place.
- Do not expose an unrestricted Google Places key in front-end code.

## UX Spec
Each planner location field becomes a text input with an attached suggestion menu:

- Placeholder examples remain contextual, such as `Choose a place...`, `Where to next...`, and `Where you're based...`.
- Suggestions are grouped conceptually by rank, but kept visually compact:
  - Known Ceylon Hop places first.
  - Popular extra places second.
  - Google exact-place suggestions can be added later through a backend adapter.
- Selecting a suggestion writes its display label into the field and planner state.
- Typing without selecting still updates visible text, but the leg is only priced when the value resolves to a known/extra place.
- If no resolvable place exists, the leg distance shows the existing “Pick both points” hint.

## Ranking Rules
1. Exact known-place alias match, for example `cmb` → `Colombo Airport (CMB)`.
2. Known Ceylon Hop places whose name/id/aliases start with the query.
3. Known Ceylon Hop places whose name/id/aliases contain the query.
4. Popular extra places with the same start/contains ranking.
5. Cap menu results to keep the card compact.

## State And Compatibility
- Continue storing leg `from` and `to` as display strings for this planner-first PR.
- Continue serializing URL `stops` as pipe-separated display labels.
- Continue restoring legacy URLs with plain strings.
- Inject no hidden state into booking URLs until Google exact-place support exists.

## Pricing Rules
- Known/extra place resolves: compute km through `resolve()` / `roadKm()` as today.
- Unknown free text: no price; show the existing unresolved-distance hint.
- Known route table stays authoritative for known Ceylon Hop place pairs.

## Tests
- Unit: place suggestion ranking puts `Colombo Airport (CMB)` before `Colombo city` for `cmb` / `airport`.
- E2E: typing `CMB` in a planner field opens suggestions and selecting airport prices CMB → Sigiriya with the baked distance.
- E2E: added planner leg survives refresh after autocomplete selection.
- E2E: legacy `stops=` URL still renders and prices existing routes.

## Rollout
1. Implement planner-only helper and styling.
2. Keep all existing planner pricing/date/map tests green.
3. After this is stable, consider reusing the helper in search/edit-search as a separate PR.
