# Ceylon Hop — brand book (canonical)

Transcribed from `Brand book low.pdf` (13pp, designed by Hash Kayleb Bandara). The PDF
is not in the repo; this file is the version the code is held to. When the two disagree,
this file wins — and if that is wrong, fix this file in the same PR as the code.

Where the product deliberately departs from the book, the departure is recorded under
**Deviations** at the bottom with the reason. Nothing else may depart silently.

## Colour

| Role | Hex | Pantone | Token |
| --- | --- | --- | --- |
| **Primary** | `#63BFD6` | Bachelor Button | `--blue` |
| Secondary — warmth | `#F9A429` | Saffron 14-1064 TCX | `--saffron` |
| Secondary — support | `#0AB9B6` | Tiffany Blue 1837 C | `--teal` |
| Secondary — conversion | `#EC3A24` | Cherry Tomato 17-1563 TCX | `--tomato` |
| Neutral — ink | `#3A3739` | Bristol Black 19-1100 TCX | `--ink` |
| Neutral — paper | `#F0EEE5` | Marshmallow 11-4300 TCX | `--cream` |

Bachelor Button is the primary: p4 says it "sets the tone for our brand and will be
prominently featured across all our materials". It owns brand surfaces, washes, chrome
and accents.

The Tiffany Blue hex genuinely is `#0AB9B6`, not `#6AB9B6` — the p4 label is easy to
misread at low zoom. Do not "correct" it.

**Primary is not the same as CTA.** `#63BFD6` is 2.10:1 on white, so it can never carry
white button text. Cherry Tomato drives conversion; solid button fills are darkened
derivatives that clear 4.5:1 (see `--btn-*` in `site.css` and
`web-tests/unit/button-contrast.test.js`).

## Typography

| Role | Face | Minimum |
| --- | --- | --- |
| Main headings | Bodoni 72 Bold | 35pt |
| Subheadings | Bodoni 72 Book | 10pt |
| Body | Poppins Regular | 12pt |

Bodoni 72 is an Apple system font with no web licence. The web substitute is
**Bodoni Moda** (Google Fonts) — same Bodoni-72 lineage, variable optical size, and it
holds up at screen sizes where a straight Bodoni cut would lose its hairlines. Poppins
is used as specified.

The 35pt heading floor is a print number. On the web it is honoured as intent, not
arithmetic: Bodoni Moda is display-only, and anything that would land under ~24px uses
Poppins instead. This keeps the hairlines off the sizes that would break them.

## Logo

The logo is the stacked "Ceylon / Hop" wordmark.

- Clear space on all sides: **0.5×** the logo's own height.
- Minimum height: **100pt**.
- Nothing — text, graphic, image — may encroach on the clear-space buffer.

## Mark

The brand icon is the streamlined "C". It is the default in most placements; the full
wordmark is reserved for logo outros, the website, and tight spaces where the lockup
still has to carry the identity.

- Clear space: **0.5×** its own height.
- Over imagery: centred, **92% opacity**, minimum **48pt**, colour contrasting with the
  photo, **no outline**.
- Never: low-contrast against its background, off-centre, or over a heavily filtered or
  oversaturated photo.

## Iconography

Two systems, both derived from the letter C:

1. **"C" shapes** — abstract marks. The *shape is fixed*; only the colour may change.
   They must contrast with the background and carry no outline.
2. **Single-line drawings** — stroke thickness between **0.25** and **0.75** of the
   icon's own stroke reference.

The book gives those stroke numbers without a unit, and no scale makes them literal on
screen: read as points on a 24px icon they are sub-pixel hairlines that disappear, and
read as a fraction of the box they are heavier than anything the book's own artwork
shows. What the rule is actually asking for is a *single-line* system — one consistent
fine weight, not a mix.

So the implementation takes the intent: every line icon in the product is
`viewBox="0 0 24 24"`, `stroke="currentColor"`, **`stroke-width="1.75"`** — one weight,
finer than the 2/2.2/2.4/3 mixture that was there before, and still legible at 16px.
Weights outside that set belong to things that are not icons (map route lines, seat
rings, progress arcs) and are deliberately untouched.

## Image usage

Clean, high-resolution, timeless. Sri Lanka's colonial architecture, serene nature,
beaches and vibrant culture; each image should capture the essence of its subject.

- Avoid busy or crowded frames.
- No heavy filters or manipulated photos.
- Saturation and vibrancy may be lifted by **at most +5**.

Scrims and gradients used for text legibility are a layout device, not a photo filter —
but they must stay light enough that the photograph still reads as the photograph.

## Tone of voice

**Upbeat · Trendy · Joyful · Youthful.** Optimistic and in tune with the latest trends,
written to make readers eager to plan a trip to Sri Lanka.

## Deviations

| Where | Departure | Why |
| --- | --- | --- |
| Solid buttons | Darkened derivatives of the book hues, not the hues themselves | The book colours are 2.10:1 (blue) to 4.04:1 (tomato) on white; white button text needs 4.5:1. Guarded by `button-contrast.test.js`. |
| Booking + payment copy | Reassurance-led, not "joyful" | These surfaces convert on trust. The book's register applies to marketing surfaces: home, tours, blog, ride board. |
| Body face at small sizes | Poppins carries anything under ~24px | Bodoni's hairlines break below display sizes; see Typography above. |
| Ops UI | Adds JetBrains Mono for references and money columns | Internal tool; tabular figures are a legibility requirement the book does not cover. |
