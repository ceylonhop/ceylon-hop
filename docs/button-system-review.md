# Button system review — 2026-07-25

Triggered by: "button colors across the site have no rhyme or reason."

They don't, and this documents exactly how. It also records a contrast problem found
during the audit that is more serious than the inconsistency.

## Status

| Part | State |
|---|---|
| Contrast fix (button fills darkened, guard test added) | **DONE** — this change |
| Semantics fix (which colour means what) | **PROPOSED, not built** — needs a decision, see below |

---

## 1. What exists

Defined in `site.css`:

| Variant | Fill | Role as built |
|---|---|---|
| `btn-primary` | teal | primary-ish — but see §2 |
| `btn-cta` | tomato | conversion-ish — but see §2 |
| `btn-ghost` | `--paper` + border | secondary on light backgrounds |
| `btn-light` | `#fff` + shadow | secondary on dark / photo bands |
| `btn-wa` | `#0B7A44` | WhatsApp, brand-locked |
| `btn-ink` | `--ink` | **dead — zero usages site-wide** |

Defined *outside* the system, in `board.html`'s inline `<style>`:

| Variant | Fill | Note |
|---|---|---|
| `btn-fb` | `#1877F2` | Facebook, brand-locked; unavailable to other pages |
| `btn-scratch` | paper, tomato on hover | ad-hoc destructive-ish action |

## 2. The inconsistency

Neither teal nor tomato maps to a job. The same action gets different colours:

| Action | Page | Colour |
|---|---|---|
| "See prices & book" | index hero | tomato |
| "Update" (same reprice job) | search | teal |
| "Next: add your dates" | plan | tomato |
| "Continue" ×3 | booking steps | teal |
| "Continue to secure payment" | booking | tomato |
| "Continue" (sticky mobile bar) | booking | teal |

Following one customer through plan → booking, the forward button flips
tomato → teal → tomato. Same funnel, same action, three colour changes.

Two further symptoms:

- **Tomato also does navigation.** `tour.html:188` "Customise this route" is `btn-cta`
  — a link to the planner dressed as a conversion. Meanwhile "Read the guide",
  "View itinerary" and "See what makes us different" are all teal.
- **Same label, two buttons.** `why.html:90` and `why.html:166` are both
  "Get a fixed price" pointing at `index.html#book`; one is tomato, one is white
  `btn-light`. The second sits on a dark photo band, so white is defensible for
  contrast — but that means **the background is choosing the colour, not the
  action's importance.** That is the root cause of the whole mess.

## 3. The contrast problem (fixed in this change)

Solid buttons carry white text at `.97rem`/600 — below the WCAG "large text"
threshold (18.66px bold), so they need the full **4.5:1**, not 3:1.

| Variant | Was | Now |
|---|---|---|
| `btn-primary` (most-used button on the site) | `#0AB9B6` — **2.43:1** | `#07817F` — 4.71:1 |
| `btn-primary:hover` | `#08938f` — 3.76:1 | `#066F6D` — 6.00:1 |
| `btn-cta` | `#EC3A24` — 4.04:1 | `#D52812` — 5.07:1 |
| `btn-cta:hover` | `brightness(1.05)` | `#C82511` — 5.63:1 |
| `btn-wa:hover` | `#1ebe5a` — **2.45:1** | `#15853F` — 4.71:1 |

The `btn-wa` case is worth calling out: its *base* had already been fixed once
(`site.css` still carries the comment `was #25D366 — white on it was 1.98:1`), but
the `:hover` was left behind at 2.45:1 — so hovering undid the fix. That is exactly
the kind of drift the new guard test catches.

### How it was scoped

`--accent` has **92 usages across 12 files** — hairlines, nav underlines, focus
rings, the datepicker's selected day, eyebrow rules. Those carry no text on them, so
the bright teal is correct there and darkening `--accent` globally would have been a
large, mostly-unwanted change.

So the fix introduces **button-only tokens** (`--btn-accent`, `--btn-accent-hover`,
`--btn-cta`, `--btn-cta-hover`) and leaves `--accent`/`--cta` untouched. The chosen
values are the *smallest* darkenings that clear 4.5:1, so the hues still read as the
brand.

Guarded by `web-tests/unit/button-contrast.test.js`, which parses the real values out
of `site.css` (verified to fail when a fill is reverted).

## 4. Proposed semantics — NOT BUILT

One job per colour, then usage follows:

- **tomato** — the money action. One per page, maximum.
- **teal** — the primary forward action in a flow (continue, submit, search).
- **ghost / light** — secondary. Chosen by *background*, never by importance.
- delete `btn-ink`; move `btn-fb`/`btn-scratch` into `site.css` or drop them.

### The open decision

The homepage hero is the one real judgement call:

- **(a) Tomato covers all conversion moments**, including the hero booker. Keeps the
  hero's punch. Recommended.
- **(b) Tomato means payment only.** Hero goes teal. Calmer and stricter, but the
  strongest button on the site's most important page gets quieter.

Under (a) the visible changes would be: plan.html continues → teal, tour.html
"Customise this route" → teal or ghost, booking's sticky mobile "Continue" → matches
the step button it mirrors.

## 5. Smaller findings

- `--blue: #63BFD6 /* Bachelor Button — primary */` (`site.css:10`) — the token
  commented "primary" is not the primary; `--accent` is teal. `--blue` is used once
  site-wide, as an icon background in `board.js:628`. Fix the comment or drop the token.
- `btn-ink` is defined and never used.
- `btn-ghost` vs `btn-light` is a real distinction (light background vs dark) but the
  names don't say so, which is why picking between them is guesswork.
