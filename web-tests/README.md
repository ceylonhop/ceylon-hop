# Ceylon Hop — front-end tests

Covers the static booking site (`../*.js`, `../*.html`). The backend has its own
Vitest suite in `../api`; this folder is the **front-end** safety net.

## Layers

**Unit (`unit/`, Vitest + jsdom)** — the pricing engine in `transfers-data.js`.
Loads the browser IIFE into jsdom and asserts `window.TRANSFERS`. Fast, offline,
no source changes. Guards the money math: the baked real-distance table,
`privateQuote` / `legPrice` / `tripQuote` formulas, `kmBetween` fallbacks,
`sharedOption`, and regression locks (e.g. CMB→Ella must price the real 335km).

**E2E (`e2e/`, Playwright)** — the real booking journeys against the static site.
Google Maps, the PayHere SDK, and the API are stubbed per-test (`e2e/_stubs.js`)
so runs are deterministic and fully offline. Covers:
- price holds on load, then re-prices after a deliberate place selection
- car↔van upgrade prompt / downgrade recommendation + re-pricing
- payment overlay states (loading, API error, PayHere cancel, demo success)
- search → booking price handoff on real distances
- a no-uncaught-errors smoke test across every key page

## Run

```bash
cd web-tests
npm install
npx playwright install chromium   # first time only

npm run test          # unit only (fast)
npm run test:e2e      # e2e only
npm run test:all      # unit + e2e
```

The e2e runner starts the static server (`../serve-booking.js`) automatically and
reuses one if it's already on :4173.

## Adding coverage
When you change front-end pricing or a booking flow, add/adjust a test here so the
change is locked in. Pure logic → `unit/`; anything that touches the DOM, Maps,
payment, or navigation → `e2e/`.
