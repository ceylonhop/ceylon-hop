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
  const real = (name) => {
    const f = html.match(new RegExp(`function ${name}\\([^)]*\\)\\{[\\s\\S]*?\\n  \\}`));
    if (!f) throw new Error(`${name} not found in manage.html`);
    // eslint-disable-next-line no-new-func
    return new Function('return (' + f[0] + ')')();
  };
  // eslint-disable-next-line no-new-func
  return new Function('esc', 'legsOf', 'longDate', 'vehicleLabel', 'fmtTime', 'isAirport', 'pickupNeeds', 'return (' + m[0] + ')')(
    esc, () => [{}], (d) => d, (v) => v, real('fmtTime'), real('isAirport'), real('pickupNeeds'),
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

// factsOf now formats the time (fmtTime) and names it "Landing time" on an airport pickup (isAirport).
describe('manage card time row', () => {
  it('prints a 12-hour pick-up time in Sri Lanka time', () => {
    const html = factsOf({ ...view, from: 'Kandy', time: '09:00' });
    expect(html).toContain('<span class="k">Pick-up time</span><span class="v">9:00 am<small>Sri Lanka time</small></span>');
  });
  it('calls it Landing time on an airport pickup', () => {
    expect(factsOf({ ...view, from: 'Colombo Airport (CMB)', time: '09:00' })).toContain('<span class="k">Landing time</span>');
  });
  // The amber chip is a to-do, so it shows only where the customer can act (pickupNeeds non-null).
  const paidSingle = { ...view, mode: 'single', status: 'paid', from: 'Kandy' };
  it('flags a missing time and a missing date on a paid single transfer', () => {
    expect(factsOf({ ...paidSingle, time: 'to confirm' })).toContain('<span class="k">Pick-up time</span><span class="v"><span class="need">Not set yet</span></span>');
    expect(factsOf({ ...paidSingle, date: 'to confirm' })).toContain('<span class="k">Trip start</span><span class="v"><span class="need">Not set yet</span></span>');
  });
  it('keeps plain "To be confirmed" on a trip, whose time is always blank', () => {
    const html = factsOf({ ...view, mode: 'trip', status: 'paid', from: 'Kandy', time: 'to confirm', date: 'to confirm' });
    expect(html).not.toContain('class="need"');
    expect(html).toContain('<span class="k">Pick-up time</span><span class="v">To be confirmed</span>');
    expect(html).toContain('<span class="k">Trip start</span><span class="v">To be confirmed</span>');
  });
  it('keeps plain "To be confirmed" on a single transfer not yet paid', () => {
    const html = factsOf({ ...view, mode: 'single', status: 'payment_pending', from: 'Kandy', time: 'to confirm', date: 'to confirm' });
    expect(html).not.toContain('class="need"');
    expect(html).toContain('To be confirmed');
  });
  it('never puts the chip on other rows (Trip end, Vehicle)', () => {
    const html = factsOf({ ...paidSingle, endDate: '', vehicleType: '' });
    expect(html).toContain('<span class="k">Trip end</span><span class="v">To be confirmed</span>');
  });
  it('says the team set the date, never "you"', () => {
    expect(factsOf({ ...view, from: 'Kandy', scheduleSetBy: 'staff' })).toContain('set by our team');
    expect(factsOf({ ...view, from: 'Kandy', scheduleSetBy: 'customer' })).not.toMatch(/set by/);
  });
});
