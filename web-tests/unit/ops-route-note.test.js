import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// routeText lives inside the served ops-ui.html and is fully self-contained (no DOM, no
// state), so extract it by its source markers and evaluate it directly — same trick as
// _load.js uses for the site IIFEs. Pins the OWNER-APPROVED customer-facing route note
// (copy gate cleared 2026-07-21): these strings go into WhatsApp/email quotes verbatim,
// so any wording change must consciously update this test.
function loadRouteText() {
  const html = readFileSync(path.resolve(__dirname, '../../api/src/routes/ops-ui.html'), 'utf8');
  const m = html.match(/function routeText\(leg\) \{[\s\S]*?\n\}/);
  if (!m) throw new Error('routeText not found in ops-ui.html');
  // eslint-disable-next-line no-new-func
  return new Function('return (' + m[0] + ')')();
}

const routeText = loadRouteText();
const OPTIONS = { fastest: { km: 292, durationMin: 330 }, noTolls: { km: 205, durationMin: 390 } };
const leg = (o) => ({ pickupLocation: 'Colombo City', dropoffLocation: 'Ella', ...o });

describe('ops quote route note (owner-approved copy, 2026-07-21)', () => {
  it('an explicit local-road pick appends the exact approved note', () => {
    expect(routeText(leg({ routeVariant: 'no_tolls', routeOptions: OPTIONS })))
      .toBe('Colombo City → Ella (via local road, no highway tolls)');
  });

  it('an explicit expressway pick appends the exact approved note', () => {
    expect(routeText(leg({ routeVariant: 'fastest', routeOptions: OPTIONS })))
      .toBe('Colombo City → Ella (via expressway E01)');
  });

  it('no picked variant → no note (pre-feature and auto-resolved legs)', () => {
    expect(routeText(leg({}))).toBe('Colombo City → Ella');
  });

  it('a cleared pick (variant gone, options still cached) → no note', () => {
    expect(routeText(leg({ routeOptions: OPTIONS }))).toBe('Colombo City → Ella');
  });

  it('stay legs are untouched', () => {
    expect(routeText({ category: 'stay_day', dropoffLocation: 'Ella' })).toBe('Stay in Ella');
  });
});
