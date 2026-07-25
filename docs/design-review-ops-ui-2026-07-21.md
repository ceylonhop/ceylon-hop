# Ops dashboard UI/UX design review — 2026-07-21

> **Status update (2026-07-23): review fully closed.** All nine defects D1–D9 below were
> fixed by PR #103 (merged 2026-07-22, in production), with offline e2e regression specs
> `ops-typed-distance.spec.js`, `ops-rail-theme.spec.js`, `ops-back-guard.spec.js`.
> The "Polish / smaller UX notes" section was then closed by PR #135 (2026-07-23: mobile
> rail strip + drawer, booking-card keyboard a11y + login hidden/inert, entry-animation
> tuning, leg-input ellipsis, one-line autocomplete items, whole-dollar list prices;
> spec `ops-a11y-polish.spec.js`). This file is committed for the record — PR #103
> references it but it previously existed only in a local working tree.

Reviewed by Claude (Fable 5) by driving the real app: local API serving `/ops` from a clean
worktree at `origin/main` (76976ba, the same code staging runs), dev sign-in as founder and
ops roles, desktop + 375px mobile, light + dark themes. Read-only except one unsaved
throwaway quote draft (never saved). No code was changed.

## Overall

The console has a genuinely strong foundation: a confident, distinctive brand (serif display
headings, mono references, teal/cream palette) applied consistently from login through the
quote cockpit, and — more importantly — a workflow-first information architecture. The quote
queue groups by "who needs to act" and **relabels itself per role** (founder sees "Needs your
review — check pricing & margin"; ops sees "Ready to send — copy the message and send to the
customer" promoted to the top, and "Awaiting review — with the founder for approval"). The
maker-checker model is expressed in the UI unusually well: locked banners, a padlocked
customer-message panel ("Not ready to send yet — click Approve to reveal"), a read-only Rates
drawer with a version date, and disabled buttons that say *why* ("Record what the customer
asked for first"). The booking sheet's pipeline stepper, action hierarchy (big "Confirm
vehicle" vs. quiet "Mark no-show" link), activity timeline and internal notes are all right.
`prefers-reduced-motion` is respected.

The problems are concentrated in one interaction model (the collapsing nav rail), a handful of
state-consistency bugs in the quote builder, and a desktop-first layout that gets rough on
mobile.

## Defects (observed, repeatable)

| # | Severity | Finding |
|---|---|---|
| D1 | **P1** | **Collapsed rail swallows the first click.** A capture-phase handler turns any click on the collapsed rail into "expand" (`preventDefault` + `stopPropagation`), so every nav action needs two clicks — and the rail auto-collapses after a short idle, so users are almost always in the two-click state. Side effect: the theme button appears dead (its click gets eaten). ops-ui.html ~1769–1795. Recommend: navigate on first click even when collapsed (expand on hover/focus instead of click), or lengthen/remove auto-collapse. |
| D2 | **P1** | **Expanded rail renders in a broken narrow state** (~178px vs the normal ~317px) after expand→auto-collapse cycles: the logo wraps "Ceylon / Hop", "Bookings" truncates to "Booki", and the footer (avatar, role, theme, Logout) overlaps itself. Reproduced repeatedly on 1280×720. |
| D3 | **P1** | **Leg says "No distance" while the pricing panel prices it.** New quote, locations committed by typing + blur (not an autocomplete pick): the right rail shows "121 km + 12 buffer → 133 billable km" and a $53.50 total, while the leg row still shows the amber "No distance / set" pill and the "Check distances" warning stays up. Contradictory state; same family as the parked typed-location auto-distance bug (docs/bug-ops-quote-typed-location-no-autodistance.md) and quote-flicker Defect A. |
| D4 | P2 | **"Check distances" warning fires on an empty itinerary** — it claims "one or more legs couldn't be auto-located" before any location has been entered (visible the moment the trip basics are filled, zero-location leg). Warning copy should distinguish "no locations yet" from "couldn't locate". |
| D5 | **P1** | **Silent draft loss.** With an *Unsaved* new quote (name, vehicle, priced leg), clicking "← Queue" discards everything with no confirmation and no autosaved draft in the queue. The GL-1b unsaved-changes guard doesn't cover in-app back navigation. |
| D6 | P2 | **Bad quote deep links silently open a blank New-quote builder.** `/ops?quote=Q-FHEXB` (a reference, the identifier shown everywhere in the UI) isn't a valid key — no "quote not found" feedback, just an empty builder. Deep links should accept references or at least error visibly. |
| D7 | P2 | **"Reopened Q-XXXXX" toast when merely opening a quote.** `reopenQuote()` (load-into-builder) toasts "Reopened…", which reads as the *state transition* "Reopen to edit". Opening the locked in-review Silke quote shows "Reopened Q-FHEXB" while the banner says "In review — locked". Rename toast to "Opened …" or drop it. |
| D8 | P3 | **Static "Route on map" letterboxed** on the 11-leg dark-theme quote: small low-res map tile centered in a much larger grey container. (The 1-leg light-theme map filled its container fine — likely the Static Maps size cap vs. container size.) |
| D9 | P3 | **Theme toggle leaves stale chrome.** Right after switching to light, the topbar search field and inactive filter chips kept dark-theme colors (grey-on-grey, near-unreadable) until a later re-render/reload repainted them. |

## Polish / smaller UX notes

- **Mobile (375px):** the nav rail keeps ~38% of screen width; queue-row prices and status
  pills clip off-canvas; the booking card wraps awkwardly ("Vehicle not confirmed" pill
  overflows). Worth a pass before the deferred ops-PWA milestone makes phones a first-class
  surface.
- **Queue entry animation** is slow enough that the list reads as washed-out/disabled for a
  beat on every visit.
- **Accessibility:** quote rows are `<button>`s with no accessible name (contents are generic
  spans); booking cards aren't keyboard-reachable at all (click-only `data-act=open` divs) —
  the quote rows do have `role="button" tabindex="0"` + Enter/Space, so the pattern exists,
  Bookings just doesn't use it. The login form also stays in the DOM behind the app after
  sign-in.
- **Leg location inputs truncate** long place names ("Hiriketiya Beach, Sr…") with no
  ellipsis/tooltip; hard to verify the right place was committed.
- **Autocomplete menu** items wrap to three lines at default width ("Colombo Airport (CMB)" +
  POPULAR ROUTE tag competing for space).
- Chauffeur quote list prices show raw cents (e.g. draft at $4,439.06) — fine internally, just
  noting it's inconsistent with the charm-priced customer surfaces.

## Not covered

Route-compare modal (PR #93/#96 — Colombo→Kandy via typed commit didn't trigger it; the
staging-soak checklist item to eyeball the 2-route map is still open), finance role, the
post-approval WhatsApp/Email copy (would have required a real status transition), and the
Bookings search/channel filters beyond a smoke look.
