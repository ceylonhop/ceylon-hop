// web-tests/e2e/_ops-estimate.js
//
// The debounced /admin/quote/estimate stub for the ops-builder specs.
//
// WHY THIS EXISTS. Every ops spec opens with a `**/admin/**` catch-all that fulfils `{}`, which
// is fine for the endpoints it is standing in for — and fatal for the estimate. The builder's
// price pane reads `est.total.cents` unguarded (`api/src/routes/ops-ui.html`, the total/deposit
// lines), so an empty estimate throws:
//
//     Uncaught TypeError: Cannot read properties of undefined (reading 'cents')
//
// inside render(). And `addLeg()` calls refreshEstimate() BEFORE render():
//
//     state.legs = state.legs.concat([leg]);
//     refreshEstimate();   // throws here…
//     render();            // …so this never runs
//
// The leg exists in state and never reaches the DOM. The test then fails as
// "element(s) not found" for `.ch-leg` nth(1) — which reads exactly like a lost click, and is
// why this was chased as a render race for weeks (docs/known-bugs.md, 2026-07-25: two
// hypotheses disproved, both about the click). It only bites when the throw lands inside the
// interaction rather than harmlessly before it, which is why it looked like pure load flake.
//
// Measured on ops-addleg-date with `--repeat-each=8 --workers=6 --retries=0`:
// 8/8 FAILED without this stub, 8/8 PASSED with it.
//
// Register it AFTER the catch-all: Playwright matches routes in reverse registration order.
export async function routeOpsEstimate(page, over = {}) {
  const body = {
    product: 'private',
    total: { cents: 12100, lkr: 'LKR 39,930' },
    lineItems: [{ label: 'Leg 1 (car)', amountCents: 12100, lkr: 'LKR 39,930' }],
    breakdown: { km: { distanceKm: 152, bufferKm: 15, billableKm: 167 }, legs: [{ cents: 12100 }] },
    services: {
      pointToPoint: { total: { cents: 12100, lkr: 'LKR 39,930' } },
      chauffeur: { error: 'single-day trip — point-to-point only' },
    },
    warnings: [],
    ...over,
  };
  await page.route('**/admin/quote/estimate', (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(body),
  }));
}
