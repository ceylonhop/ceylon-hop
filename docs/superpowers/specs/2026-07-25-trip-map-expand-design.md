# Expandable trip map — design

**Date:** 2026-07-25
**Status:** Approved, ready for an implementation plan
**Scope:** Customer front-end only (`ch-map.js`, `plan.html`/`plan.js`, `booking.html`/`booking.js`)

## Problem

The route map on the trip planner is a ~344×250 card in the summary panel. Customers planning a
Sri Lanka trip usually do not know the country's geography, so they need to zoom, pan and read
the surroundings to confirm that the stops they typed are the places they meant. The card is too
small for that, and two things make it worse:

1. **The map is deliberately hard to manipulate.** It is created with
   `gestureHandling: 'cooperative'` (`ch-map.js`), so scroll-wheel zoom needs Ctrl and mobile
   panning needs two fingers. That is the right call for a small card inside a scrolling page —
   it stops the map hijacking the scroll — but it means the map cannot be explored in place.
2. **The pins are anonymous.** Markers are created with generic titles only — `'Pick-up'`,
   `'Drop-off'`, `'Stop N'` (`ch-map.js`) — with no place name and no number drawn on them. A
   customer can zoom to a pin and still not know *which* stop it is. The SVG island fallback is
   actually more informative here: it renders numbers and names.

The existing escape hatch is an "Open this area in Google Maps (opens a new window)" link, which
sends the customer off the site mid-planning and drops the branded route and stop ordering.

## Goals

- Let a customer open a much larger, freely manipulable map without leaving the page.
- Make each pin identifiable, so "is stop 3 the right place?" is answerable.
- One implementation shared by the planner summary map and the booking transfer map.

## Non-goals

- **No editing from the map.** The modal is view-only. Correcting a stop happens in the existing
  Pick-up / Drop-off fields, which already have Google autocomplete. The modal never mutates
  trip state.
- **No draggable pins.** Stops are named places, not coordinates; dragging would need a
  data-model change and collides with the 10 km exact-spot rule in the booking step.
- No change to routing, pricing, distance calculation, or the SVG fallback's own rendering.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Modal capability | View-only | Smallest surface; no duplicate autocomplete; no state mutation |
| Pages | Both planner and booking, via a shared `ch-map.js` flag | One implementation; the booking step is where a wrong pin costs money |
| Identification | Numbered legend **and** numbered markers | Legend alone can't be matched to anonymous pins |
| Map instance | Second instance in the modal, plus a route memo | Isolated from the inline map's re-render cycle |

### Why a second map instance rather than re-parenting

Moving the existing map node into the modal would use one map instance and no extra API calls.
It was rejected: `plan.js` re-renders the map whenever trip state changes, so an open modal could
have its map node pulled out from under it. This codebase has a documented history of
re-render/flicker races, and that guard is the fragile part.

A second instance is fully isolated — the inline card keeps behaving exactly as it does today.
Its cost is one extra dynamic-map load per open. The `computeRoutes()` cost is removed by the
route memo below, which also benefits the inline map.

## Design

### Expand affordance

A pill button (⤢ + "Expand") in the map's **top-right** corner. Google's zoom cluster owns the
right edge at mid-height and its logo the bottom-left, leaving the top corners free.

Rendered **only on the real Google map**, never on the SVG island fallback — expanding a
schematic gains nothing. The fallback path fires on gapped routes, fewer than two stops, or a
Maps failure.

### Modal

Visually mirrors the `.plan-modal` pattern already in `plan.html` — fixed overlay, blurred
backdrop, centred card, toggled by inline `style.display`.

**The modal must ship its own styles, not reuse `.plan-modal`.** `ch-map.js` is a shared module
and already injects its own scoped CSS through `ensureStyle()`; `.plan-modal` exists only on
`plan.html`, while `booking.html` has a different overlay (`.ph-overlay`). The modal's rules
(`.ch-map-modal`, `.ch-map-modal-card`, `.ch-map-legend`) go into `ensureStyle()` alongside the
existing `.ch-map-wrap` rules, so the component is self-contained on every page that loads it.

Note also that `.ch-map-wrap` is a fixed `height:260px`; the modal needs its own wrapper sizing
rather than reusing that class.

> Toggling by inline `style.display` is deliberate. Toggling these overlays with the `hidden`
> property would silently fail, because the overlay classes set an explicit `display` — see the
> `[hidden]` companion-rule fix from 2026-07-25 (PR #147).

- **Desktop:** `min(1120px, 94vw)` × `min(760px, 88vh)`. Large but never edge-to-edge — backdrop
  stays visible on all sides, per the "not full screen" requirement.
- **Mobile:** near-full-height sheet; the map needs every pixel on a 390 px screen.
- **Gestures:** the modal map uses `gestureHandling: 'greedy'` so one-finger drag and plain
  scroll-wheel zoom work. This is the core of the feature — the inline card keeps
  `'cooperative'`.

### Legend and numbered pins

A numbered stop list beside the map on desktop, collapsing above it on mobile:

```
① Colombo Airport    ② Kandy    ③ Ella
```

Each swatch is colour-matched to its pin: green pick-up (`#0a7d6f`), teal intermediate
(`#0AB9B6`), orange final drop-off (`#e8623a`) — the colours already used in `ch-map.js` and
mirrored by the SVG schematic.

Marker `label` gains the matching number so the legend and the map reference each other. Display
names strip the parenthetical qualifier, reusing the SVG path's existing convention
(`name.replace(/\s*\(.*?\)/,'')`), so "Colombo Airport (CMB)" reads as "Colombo Airport".

### `ch-map.js` API change

`renderRoute(host, names, opts)` gains `opts.expandable` (default falsy — existing callers are
unaffected). When set, `renderRoute` wires up the button, modal and legend, deriving the legend
from the `names` array it already receives.

Callers opt in with one argument each:
- `plan.js` — the summary map
- `booking.js` — the transfer map

### Route memo

Memoise the `Route.computeRoutes()` result in `ch-map.js`, keyed on the normalised stop list.
Today every `renderRoute()` call recomputes the route, including on each inline re-render. The
memo means the modal reuses the already-computed route (faster open, no extra Routes API call)
and the inline map stops recomputing needlessly.

Cache is per page-load, in memory, cleared when the stop list changes. No persistence.

### Edge cases

| Case | Behaviour |
|---|---|
| SVG island fallback showing | No expand button at all |
| Modal map fails to load | Close the modal back to the inline card; do not strand an empty box |
| Stops change while modal open | Modal keeps the route it opened with; it is a view of a moment |
| Single stop / no route | No button (fallback path already applies) |

### Accessibility

`role="dialog"` + `aria-modal="true"`; Esc closes; backdrop click closes; focus moves into the
dialog on open and is restored to the expand button on close; background scroll locked while
open; the button has an accessible name ("Expand map").

## Testing

Playwright (`web-tests/e2e/`), with the Maps API stubbed as it already is:

- Expand button present on a routed map, absent on the SVG fallback.
- Modal opens; closes via Esc, backdrop click, and the close button.
- Focus returns to the expand button after close.
- Legend entry count and order match the stop list.
- Present on both the planner and the booking page.

Vitest (`web-tests/unit/`):

- Route memo cache key: same stop list hits, changed stop list misses, order-sensitive.

## Risks

- **Extra dynamic-map load per open** (~$7/1000). Accepted; the route memo offsets it and removes
  an existing source of repeat Routes API calls.
- **`ch-map.js` is shared by four pages** (`plan`, `booking`, `index`, `search`). The new
  behaviour is strictly opt-in via `opts.expandable`, so `index`/`search` autocomplete usage is
  untouched.
