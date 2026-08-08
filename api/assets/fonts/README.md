# Vendored brand fonts

The card renderers (`src/routes/shareCardImage.ts`, `quoteCard.ts`, `payCard.ts`) rasterise
SVG to PNG with `@resvg/resvg-js`, which reads only TTF/OTF — not woff/woff2 — and a Render
container has no system fonts to fall back on. Without these files the cards render blank.

| File | Family name in the TTF | Role |
|---|---|---|
| `BodoniModa-ExtraBold.ttf` | **`Bodoni Moda 11pt`** | display (`DISPLAY`) |
| `Poppins-Bold.ttf` | `Poppins` | body, 700 (`BODY`) |
| `Poppins-Regular.ttf` | `Poppins` | body, 400 (`BODY`) |

Both families are licensed under the SIL Open Font License 1.1 (`OFL.txt`), which permits
bundling and redistribution. They are the same two families `site.css` loads for the web,
so the cards match the site rather than approximating it.

## Two traps, both silent

**1. Name faces by the string in the TTF, not the CSS family.** Google's static Bodoni Moda
reports itself as `Bodoni Moda 11pt`, so `font-family="Bodoni Moda"` resolves to nothing and
draws nothing. Resvg does not warn.

**2. Only RIBBI weights keep the plain family name.** Google splits families wider than
Regular/Italic/Bold/BoldItalic by suffixing the family — `Poppins-SemiBold.ttf` is family
`Poppins SemiBold`, style `Regular`, which would need its own font-family string to resolve.
That is why only 400 and 700 are bundled and the renderers ask for those two weights.

A missing GLYPH blanks its whole text run the same way. Neither face has `→`, so route
strings go through `deArrow()` and the ride card draws its arrow as a path.

`web-tests/unit/card-font-families.test.js` reads the real name tables and cmaps and asserts
all of the above, so a future font swap fails in CI rather than in a WhatsApp unfurl.
