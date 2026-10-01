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

// Route choice (spec §4.3): the booking view carries `road` (roadRow's words) only when the
// customer bought the local road. The card prints it as a Road fact, right after Stops.
describe('manage card names the local road the customer chose', () => {
  it('prints a Road row after Stops', () => {
    const html = factsOf({ ...view, road: 'Local road, no expressway · about 6h 14m' });
    expect(html).toContain('<span class="k">Road</span><span class="v">Local road, no expressway · about 6h 14m</span>');
    expect(html.indexOf('>Road<')).toBeGreaterThan(html.indexOf('>Stops<'));
    expect(html.indexOf('>Road<')).toBeLessThan(html.indexOf('>Travellers<'));
  });

  it('prints nothing new on the expressway (no road on the view)', () => {
    expect(factsOf(view)).not.toContain('Road');
  });

  it('escapes the road', () => {
    expect(factsOf({ ...view, road: '<img src=x>' })).not.toContain('<img');
  });
});
