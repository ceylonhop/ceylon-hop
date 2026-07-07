# Ceylon Hop Scoped UAT Stabilization Plan

Status: active · Owner: founder + Codex · Created: 2026-07-07

## Summary

Fix launch-blocking UAT issues in small, tested PRs. Do not redesign the site.
Any UI changes must preserve the existing Ceylon Hop visual language: current
typography, colors, spacing rhythm, card/button style, icons, and page structure.

## PR sequence

1. Date correctness — date-only parsing/formatting, 12-month booking horizon,
   stale date-warning clearing, and payload dates that match the visible date.
2. Planner state and navigation — added legs/dates survive refresh, and browser
   Back returns to the expected planner/booking step.
3. Price, distance, and map consistency — preserve equivalent baseline prices
   across search, booking, and add-stop planner flows; fix stale distances/maps.
4. Small mobile UX bug fixes — only confirmed mobile breakages, no broad redesign.
5. Contact form cleanup — first/last name consistency, country code + phone, and
   reporting country.

## Rules

- No new design system, palette, layout concept, or large page restructure.
- Reuse existing Ceylon Hop classes, components, spacing, colors, and icons.
- Every PR must add or update drift-prevention tests.
- Inspect the current implementation and existing tests before changing code.
- Run focused tests first, then the relevant broader checks.

## Deferred tracks

- Apple Pay / Google Pay research is a separate PayHere capability task.
- Search-first location entry is a future UX task unless needed for a confirmed bug.
- Quote-tool workflow fixes, backend hardening, and CI/docs guardrails follow after
  the customer-facing UAT blocker PRs.
