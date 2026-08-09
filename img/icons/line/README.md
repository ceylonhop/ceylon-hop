# Line icons

24 stroke icons for UI chrome — nav rails, chips, buttons, list rows. The companion to
[`img/icons/badges/`](../badges/README.md), which does the marketing surfaces.

Same grammar as the stroke icons already inline in `index.html`, `board.html` and
`api/src/routes/ops-ui.html`: **24×24, `fill="none"`, `stroke="currentColor"`, width 2, round
caps and joins.** Drop-in beside them.

Browse the set at three sizes, plus on the dark ops rail, in
[`docs/prototypes/icon-set-proposal.html`](../../../docs/prototypes/icon-set-proposal.html).

## The family rule

Every icon carries **exactly one filled waypoint dot** — the endpoint of the homepage route
doodle, and the orange "C" shrunk to a pixel. It is what makes one of these recognisable at
16px, and it is enforced: `class="wp"` on a `<circle>` in every file.

Beyond that: dashed strokes always mean *journey*, dots always mean *place*, true circles and
arcs only, and never more than two ideas per icon.

## Using one

**Inline is the intended path** — copy the file's inner markup into your HTML so the icon
inherits `currentColor` from the surrounding text, exactly like the existing stroke icons:

    <button class="nav-item">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <!-- paths from img/icons/line/hot-zone.svg -->
      </svg>
      Hot zones
    </button>

Style the waypoint dot from CSS when you want it to carry the brand colour:

    .nav-item .wp { fill: var(--saffron); stroke: none; }

Referencing the file directly via `<img src>` works too, but the icon can no longer inherit
colour — the standalone files pin `color:#2C2A2B` so they are legible on their own.

## The set

**Ride Board** — `shared-van` `your-line` `locked-in` `called-off` `zero-hold` `closes-soon`

**Journey** — `pickup` `door-to-door` `bags` `travellers` `nine-arch` `palm`

**Promise & trust** — `backed` `free-cancel` `rate-lock` `whatsapp-7d` `live-count` `secure-pay`

**Ops desk** — `hot-zone` `route-compare` `assign` `demand-map` `send-quote` `night-watch`

The ops group is designed to sit beside the three marks already in `ops-ui.html`
(`tickets` = ticket, `quotes` = price tag, `analytics` = trend line), not replace them.

## Sizes

Built for 16–24px and tested down to 16. Above about 40px prefer a badge from
`img/icons/badges/` — these are line marks, not illustrations, and they thin out when enlarged.

## Nothing is wired up yet

This is a library, not a change to any page. No existing icon has been swapped.
