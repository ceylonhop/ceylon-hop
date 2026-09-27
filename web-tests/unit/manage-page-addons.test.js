import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { futureIsoDate } from '../dates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Extract factsOf from manage.html itself (loadFn pattern — see pay-page-lines.test.js), with its
// page helpers stubbed: only the rows it chooses to print are under test here.
function loadFactsOf() {
  const html = readFileSync(path.resolve(__dirname, '../../manage.html'), 'utf8');
  const m = html.match(/function factsOf\(v\)\{[\s\S]*?\n  \}/);
  if (!m) throw new Error('factsOf(v) not found in manage.html');
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // eslint-disable-next-line no-new-func
  return new Function('esc', 'legsOf', 'longDate', 'vehicleLabel', 'return (' + m[0] + ')')(
    esc, () => [{}], (d) => d, (v) => v,
  );
}
const factsOf = loadFactsOf();
const day = futureIsoDate();
const view = { date: day, endDate: day, time: '09:00', travellers: 2, vehicleType: 'car' };

// The add-ons the customer chose reach the manage card as the booking view carries them.
describe('manage card names the add-ons the customer chose', () => {
  it('prints an Extras row, one add-on per line', () => {
    const html = factsOf({ ...view, addOns: ['Waiting fee — Kandy → Ella', 'Wait for Safari — Ella → Yala'] });
    expect(html).toContain('<span class="k">Extras</span>');
    expect(html).toContain('Waiting fee — Kandy → Ella<br>Wait for Safari — Ella → Yala');
  });

  it('prints no Extras row when nothing was chosen', () => {
    expect(factsOf(view)).not.toContain('Extras');
    expect(factsOf({ ...view, addOns: [] })).not.toContain('Extras');
  });

  it('escapes the labels', () => {
    expect(factsOf({ ...view, addOns: ['<img src=x>'] })).not.toContain('<img');
  });
});
