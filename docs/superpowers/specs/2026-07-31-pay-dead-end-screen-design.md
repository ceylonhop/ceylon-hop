# pay.html dead-end screen — "sailed off somewhere sunny" (owner-approved 2026-07-31)

## Problem

When a customer opens a stale payment link, pay.html renders one of two dead-end states —
`revised` (the quote was edited after the link was sent; made reachable by the revision bump,
PR #223) and `unavailable` (expired / closed / bad token). Both currently render as an amber
warning circle plus one grey sentence: the least-designed surfaces on the page, framing a
routine event as an error, with no personality and no reason to feel good about the trip.

The owner asked for these to be fun — the reference is the site's own **404 page**
(`404.html`, "You've wandered off the map"): an animated flat-illustration island scene, a
teal eyebrow, a big serif pun headline, one lead line, action buttons. The Amazon-404-dog
pattern, already in the house style.

## Decision history (all owner calls, 2026-07-31)

1. Tone: **properly funny** — a real joke, not corporate-cute.
2. Content: **generic Sri Lanka delight, front-end only** — the API deliberately returns no
   quote details on these states (`quotePay.ts` returns bare `{state}`; a stale bearer link
   must not leak trip data). No backend change. **This is a hard privacy constraint, not a
   convenience choice.**
3. Iterations v1–v3 (ticket-stub gags, stamps, departures boards) rejected: too crowded, the
   *why am I seeing this* buried, and off the site's style. The 404 page is the pattern.
4. Final: **ONE screen for both states, for now** — the "sailed off" design below. The
   revised-state nuance ("a fresh link is on its way") is dropped from the page copy in
   exchange for one simpler screen; WhatsApp is the single next step for both states.

## The approved design

A sibling of `404.html` — same skeleton, same illustration language, new scene. Mockup:
`.superpowers/brainstorm/91040-1785542860/content/state-screen-v4.html` (right-hand state).

**Layout** (the 404's `.nf` skeleton, centered, max-width 560px):

1. **Scene** — animated inline SVG, 480×300 viewBox, ~430px wide:
   *a little paper boat sailing away from the shore while the coral map pin watches.*
   Same world as the 404's island: cream-sky radial gradient (`#fdfbf3→#e7f4f0`), sea ellipse
   (`#a4ddd7→#54c1ba`), sand `#f4e7c8→#e7d1a1`, palm greens `#8fce9f`/`#4bb08a`, sun
   `#f6b44c` with rays, coral accent `#ef6a4a` (the watching pin), white wave squiggles.
   Animations mirror the 404's: gentle bob, slow sun spin, a sail/boat drift keyframe;
   all inside `@media (prefers-reduced-motion: reduce) { animation: none }`.
2. **Eyebrow** — `quote · no longer active` (small caps, teal-deep).
3. **Headline** — serif display, clamp-sized: **"This quote has sailed off somewhere sunny"**.
4. **Lead** — one line, the two facts that matter on a money page:
   **"Nothing has been charged."** (bold) + "Message us on **WhatsApp** and we'll get you
   moving again."
5. **Action** — one solid WhatsApp button (`.btn-wa`, `#0B7A44`, white text) →
   `https://wa.me/94779669662`.

The joke lives in the headline pun and the scene — nowhere else. No fine print, no rotating
gags, no stamps. The two-second read (link dead · nothing charged · WhatsApp us) survives.

## Where it lands

- `pay.html` only. `renderUnavailable()` and `renderRevised()` both render this one screen.
  Keep the two functions (the API still distinguishes the states and analytics/`state`
  handling flows through them) — they just share the markup. The existing
  `renderRevised`-specific copy ("we'll WhatsApp you a fresh link") is retired with it.
- CSS + SVG inline in pay.html's page-specific `<style>`/markup block, following the file's
  own convention ("page-specific pieces stay inline on their own page" — ticket.css header).
  **ticket.css is NOT touched** (it's shared with manage.html).
- The `paid` and `payable` states are untouched. The header, footer `waLine()`, and error
  beacons are untouched.

## Out of scope (explicitly)

- Any API/backend change; any new data on the wire for dead-end states.
- manage.html, 404.html, site.css, ticket.css.
- A distinct revised-state screen ("fresh link coming") — a possible later split; the
  functions stay separate so the split is a copy change, not a refactor.
- Localisation, server-side rendering of the scene, analytics events.

## Testing

Front-end visual + behaviour change → per repo rules, covered in `web-tests/` (the existing
`e2e/pay-page.spec.js` already drives the dead-end states):

- revised-state and unavailable-state responses both render the new screen: headline text
  present, **"Nothing has been charged"** visible, WhatsApp link/button present with the
  correct `wa.me` href.
- No quote data (total, route, name) appears in the rendered dead-end DOM.
- `prefers-reduced-motion` asserted by presence of the media-query guard (static check).
- Existing payable/paid specs stay green.

## Definition of done

`npm run test:all` (web-tests) green, `cd api && npm run check` green (pay.html is served by
the API in prod — see customer-pages memory — so opsUi/static specs must stay green), visual
check in the browser preview against the approved mockup, one PR.
