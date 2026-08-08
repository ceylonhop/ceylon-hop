# Badge icons

Circular illustration badges in the same language as `img/icons/*.png` (the six originals:
`hop-on-hop-off`, `change-the-route`, `book-your-seat`, `affordable`, `authenticity`,
`flexible-routes`) — but as SVG rather than PNG: ~2 KB each instead of 13–20 KB, sharp at any
size, and recolourable.

Browse them all, at four sizes and in context, in
[`docs/prototypes/badge-icon-set.html`](../../../docs/prototypes/badge-icon-set.html)
(open the file directly in a browser — it renders standalone).

## Using one

Drop-in replacement for the existing 62px slots. No CSS change:

```html
<img class="ico" src="img/icons/badges/thambili.svg" alt="" width="62" height="62" loading="lazy">
```

They also inline safely — each badge's filter ids are unique across the base set, so two
inlined badges on one page will not collide. A colour variant (see "Colour variants" below)
is the exception: it byte-copies its original's filter ids rather than getting its own. That's
still harmless — via `<img src>` each is its own document with its own id scope regardless, and
even inlined, two copies of the same id are fine here because the duplicated `<filter>` elements
are byte-identical. But don't rely on the "unique across the whole set" claim if you ever inline
a badge alongside its own colour variant on the same page.

## House rules these follow

- **Solid disc, art inset to ~62% of the diameter.** The disc does the colour work.
- **Cream artwork with a charcoal outline.** Never a colour-on-colour shape.
- **One accent per badge** — a single saffron or teal note. Two turns to noise.
- **Hand-drawn render, on purpose.** The disc is a nine-point blob rather than a circle; the
  fill and the outline are displaced on *different* noise seeds so the colour prints slightly
  off-register; every badge sits at its own small tilt. The noise is baked, not animated — a
  badge renders identically every time, it just does not look measured.
- **Palette** (sampled from the original PNGs): teal `#0DB9B6`, sky `#34C2D9`,
  saffron `#F9A429`, cream `#FAF1E4`, outline `#4A4648`.

## Sizes

Designed for 62–100px. They hold shape down to about 34px; below that the wobble eats the
detail, so use a plain stroke icon instead.

## The set

**Getting around** — `hop-van` `ambalama` `thambili` `tuk-tuk` `called-off` `invite`

**Places worth the drive** — `ella-train` `sigiriya` `surfer` `turtle` `dagoba` `stilt-fisher`
`tea-hills` `paw` `whale` `palm-coast` `elephant`

**The promise, island-style** — `rate-lock` `free-cancel` `we-answer` `pro-hopper`
`safari-wait` `bags`

**Utility** — `zero-coin` `van-fills` `locked-in` `closes-soon` `licensed` `ac-comfort`
`door-to-door` `child-seat` `sightseeing` `flexi` `chauffeur`

Scenic badges suit marketing surfaces (home, route pages, blog, emails). Utility badges suit
places where the icon has a job to do (seat counters, bag counts, rate-card extras).

## Colour variants

Every three-card row rotates teal · sky · saffron, so a few badges exist in a second disc
colour. Named `<badge>-<colour>.svg`:

`door-to-door-sky` · `pro-hopper-teal` · `rate-lock-sky`

Recolouring a disc can swallow an inner accent that shares the new colour — `pro-hopper-teal`
has its cap button in saffron for exactly that reason. Check the artwork after any recolour.
`hop-van` carries both teal and sky inside and therefore has no variant: it stays saffron.

These three variants do not appear in
[`docs/prototypes/badge-icon-set.html`](../../../docs/prototypes/badge-icon-set.html) — that
page only renders the base set.

## Known rough edge

`whale.svg` is a raised fluke breaking the surface (the whale-watching image), not a side-on whale —
a side-on whale reads as a fish at this size. `surfer.svg` is a board and a wave rather than a
rider, for the same reason. Both are deliberate.
