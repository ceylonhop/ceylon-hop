import { test, expect } from '@playwright/test';

// Regression: the ops money-pane line items (.ch-line) once forced `white-space:nowrap` on the
// label, so the long chauffeur "Distance — … (buffered + idle)" label overran the row and the
// money card clipped the amount off the right. The label must wrap; the amount must stay visible.
// Renders the real ops CSS against the real markup structure (offline webServer, no DB).

const OPS_FILE = '/api/src/routes/ops-ui.html';

test('ops money-pane long line label wraps and never clips the amount', async ({ page }) => {
  const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  await page.addInitScript(() => { window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } }, maps: { importLibrary: async () => ({}) } }; });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'f@e2e.test', role: 'founder', caps: ['quote:manage'] })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });

  // Inject a money card with the real long chauffeur breakdown line at the pane's inner width.
  const clip = await page.evaluate(() => {
    const qv = document.getElementById('quoteRoot');
    const wrap = document.createElement('div');
    wrap.style.cssText = 'width:360px;position:fixed;top:60px;left:640px;background:#fff;padding:16px;overflow:hidden';
    wrap.className = 'ch-money-card';
    wrap.innerHTML =
      '<div class="ch-line"><span class="ch-line-label">Chauffeur day rate — 8 day(s)</span><span class="ch-line-val">$280.00</span></div>' +
      '<div class="ch-line" id="probe"><span class="ch-line-label">Distance — 1621 km (1021 buffered travel + 600 idle-day min)</span><span class="ch-line-val" id="probe-val">$567.35</span></div>';
    qv.appendChild(wrap);
    const card = wrap.getBoundingClientRect();
    const val = document.getElementById('probe-val').getBoundingClientRect();
    const label = document.getElementById('probe').querySelector('.ch-line-label').getBoundingClientRect();
    return {
      valVisible: val.right <= card.right + 0.5,   // amount fully inside the card
      labelWrapped: Math.round(label.height) > 22, // wrapped to more than one line
    };
  });

  expect(clip.valVisible, 'amount must be fully inside the card (not clipped)').toBe(true);
  expect(clip.labelWrapped, 'long label should wrap to more than one line').toBe(true);
});
