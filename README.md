# Ceylon Hop

Static marketing + booking site for Ceylon Hop — private transfers, shared rides,
multi-stop trips and packaged tours across Sri Lanka. Built as plain HTML/CSS/JS
(no build step) from a Claude Design handoff.

## Running locally

The site is fully static. Any static file server pointed at this folder works.
A tiny zero-dependency Node server is included:

```bash
node serve-booking.js
# serves this folder at http://localhost:4173  (/ → index.html)
```

Or use anything equivalent, e.g.:

```bash
python3 -m http.server 4173
```

Then open http://localhost:4173/.

## Pages

| Page | Purpose |
|------|---------|
| `index.html` | Home — hero, single/multi-stop search widget, highlights |
| `search.html` | Transfer results — private (car/van) vs. shared-seat pricing |
| `booking.html` | Booking flow — `?mode=private` / `shared` / `trip` |
| `plan.html` | Multi-stop trip planner (route, nights, dates) |
| `tours.html` | Packaged tour listing |
| `tour.html` | Tour detail — review then customise into the planner |
| `about.html` / `why.html` / `blog.html` | Content pages |

## Entry points / flows

1. **Single transfer** — Home → `search.html` → `booking.html?mode=private`
   (date & time → exact pickup/drop-off → travellers → pay).
2. **Shared taxi** — when `search.html` finds a shared corridor →
   `booking.html?mode=shared` (fixed route, date → seats → pay).
3. **Multi-stop** — Home (Multi-stop tab) → `plan.html` → `booking.html?mode=trip`
   (itinerary + dates from the planner → private-vs-chauffeur service → pay).
4. **Tours** — `tours.html` → `tour.html` → "Customise" → `plan.html`
   (stops, per-stop nights and start date carry through) → multi-stop flow.

## Structure

- `site.css` / `site.js` — shared chrome (header, footer, scroll reveal) used by every page.
- `routes-data.js` / `transfers-data.js` / `tours-data.js` — pricing, places and tour data.
- `booking.js` / `plan.js` / `search.js` / `datepicker.js` — per-flow logic.
- `image-slot.js` + `image-slots.state.json` — fillable image placeholders; images
  are embedded as base64 data URIs in the sidecar (fetched at runtime).
- `tweaks.js` — applies persisted theme variables (accent, font, corners) site-wide.
- `api/` — the live backend (Hono + Drizzle/Postgres, PayHere adapter) the booking flow
  calls via `window.CEYLON_HOP_API`; see [`api/README.md`](api/README.md).
- `tools/` — codegen (pricing, route pages, terms/privacy, redirects); `web-tests/` —
  Vitest unit + Playwright e2e; generated `trip/` route pages, `terms.html`/`privacy.html`,
  `404.html`, `manage.html` (emailed booking view), `/ops` (founder dashboard, served by the API).

## Notes

- Backend is **live**: the booking flow calls the API in `api/` and drives a real PayHere
  checkout. PayHere runs in **sandbox** mode today (real sandbox charges, not live money).
- Empty "Drop a photo" boxes are unfilled image slots from the design, not errors.
