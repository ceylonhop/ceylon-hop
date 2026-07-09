# Mobile booking: sticky total+CTA bar with summary bottom sheet — design

**Date:** 2026-07-09 · **Owner decision:** Roshen (Option B, straight to sticky bar)
**Scope:** booking.html / booking.js / web-tests. Mobile only (≤880px). Desktop unchanged.

## Problem

On mobile, `booking.html:484` (`@media(max-width:880px){ .layout > aside{order:-1} }`) moves the
full summary card above the step content. Measured at 390×844: summary occupies y≈157–640, so the
active step starts below the first screen on EVERY step, and the primary button sits at the bottom
of a ~2,500px page on the details step. Travelers scroll past ~500px of unchanging summary to reach
each step's inputs, then scroll a full form to find Continue. The payment step also duplicates the
total ("Due now" box).

## Goals

1. Step content starts on the first screen on mobile.
2. Price (live-updating) and the step's primary CTA are ALWAYS visible.
3. Reassurance content (route/date, per-leg rows, perks, WhatsApp) remains one tap away.
4. Zero behavior drift: no changes to pricing, validation, step logic, or analytics events.
5. Desktop (≥881px) renders exactly as today.

## Design (three mobile-only pieces)

### 1. Context strip (new, replaces the summary's top position)
A slim card under the progress stepper, visible ≤880px only:
`[route: "Colombo Airport → Ella"] · [date chip]` — one line, ellipsized, ~48–60px tall.
Tapping it opens the summary sheet (same action as the bar's total button). Content is read from
the existing `#sum-from` / `#sum-to` / `#sum-date` nodes (see Sync).

### 2. Sticky bottom bar
Fixed to the viewport bottom, ≤880px only, `padding-bottom:env(safe-area-inset-bottom)`:
- **Left — total button:** "Total **$169** ⌃" (`aria-expanded`), opens the sheet. Text mirrors
  `#sum-total`.
- **Right — proxy CTA:** mirrors the ACTIVE panel's primary button (`.panel.active .nav-btns
  .btn`): label, disabled state, and `btn-primary`/`btn-cta` accent. Click = programmatic
  `.click()` on the real (hidden) button, so ALL existing handlers/validation/analytics fire
  unchanged.
- The panel's own primary button is `display:none` ≤880px; its `.back-link` stays in-page.
- **Visibility rules:** hidden when (a) viewport >880px; (b) no active panel primary button exists
  (receipt/confirmation views); (c) a text input/textarea/select inside the active panel has focus
  (keyboard open — prevents covering fields); (d) the summary sheet is open (the sheet has its own
  close affordances).
- z-index sits BELOW the cookie-consent banner and any payment overlay.

### 3. Summary bottom sheet
The EXISTING `aside`/`#summary` node restyled (≤880px) as a bottom sheet: `position:fixed; bottom:0;
translateY(100%)`, `.open → translateY(0)`, max-height `78dvh`, internal scroll, scrim behind,
body scroll-lock while open. Close: scrim tap, ✕ button (injected header), Escape.
Because it is the same DOM node, every live-updating id (`sum-*`, `s-deposit` appends, addons)
keeps working with zero renderer changes. Desktop styles untouched (all changes media-scoped).
`prefers-reduced-motion`: no slide transition.

### Sync mechanism (observation only — the no-drift guarantee)
One new fenced section in booking.js (`/* ── mobile sticky bar ── */`), all read-only:
- `MutationObserver` on `#summary` subtree → copies total/route/date text into bar + strip.
- `MutationObserver` on panel `class` attributes → detects step changes → rebinds the proxy CTA
  (label/accent) and re-observes the new primary button's `disabled` attribute.
- No edits to `goStep`, `render`, pricing, or any existing function. If the observers fail, the
  page degrades to today's behavior minus the hidden buttons — which is why the CSS that hides
  panel buttons is applied by JS (add a class) rather than static CSS: no JS ⇒ no hiding ⇒ no
  regression for non-JS/old browsers.

## What changes for existing tests (deliberate updates, not breakage)
- `mobile-ux.spec.js` "summary before the active payment panel": rewritten to assert the NEW
  contract — strip visible above panel, strip height ≤90px, active panel starts within the first
  viewport (y < 480), sticky bar visible with a total.
- `mobile-ux.spec.js` gutter test: `#summary` gutter assertion moves to the strip + bar; `#summary`
  gutters asserted with the sheet open.
- All other suites must pass unmodified (desktop viewport is untouched by media-scoped changes).

## New tests (web-tests/e2e/booking-mobile-bar.spec.js, 390×844)
1. Bar + strip visible; bar total text equals `#sum-total`; panel content starts < 480px.
2. Proxy CTA: advances the step (private mode); label switches to "Continue to secure payment →"
   on the details step; disabled mirrors the real button (terms unchecked ⇒ disabled).
3. Live total: changing travelers via steppers updates the bar total.
4. Sheet: opens from total button AND strip; shows perks + WhatsApp link; closes via scrim and
   Escape; `#summary` has proper gutters while open.
5. Keyboard: focusing a details-step input hides the bar; blur restores it.
6. Desktop 1280×900: bar and strip absent; aside in the right column; panel primary buttons
   visible (unchanged from today).

## Non-goals
- No desktop changes; no pricing/step-logic changes; no new analytics events (proxy preserves the
  existing `checkout_step`/`begin_checkout` firing); no changes to plan.html/search.html (their
  own summary UX is out of scope).

## Rollout
Single commit set on main (repo workflow), gated by: full web unit + full offline e2e green,
before/after screenshots at 390px and 1280px reviewed, then push (GitHub Pages deploy).
