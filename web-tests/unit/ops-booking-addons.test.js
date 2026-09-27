import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Extract the booking sheet's add-on picker from ops-ui.html by source markers (the same trick as
// ops-pay-selection.test.js), handing it the page's own EXTRA_LBL so the labels are the real ones.
function load() {
  const html = readFileSync(path.resolve(__dirname, '../../api/src/routes/ops-ui.html'), 'utf8');
  const fn = html.match(/function bookingAddOns\(booking\) \{[\s\S]*?\n\}/);
  const lbl = html.match(/const EXTRA_LBL=(\{[^\n]*\});/);
  if (!fn || !lbl) throw new Error('bookingAddOns(booking) or EXTRA_LBL not found in ops-ui.html');
  // eslint-disable-next-line no-new-func
  return new Function('return (' + fn[0].replace('function bookingAddOns', 'function (EXTRA_LBL) { return function bookingAddOns') + '})')()(
    // eslint-disable-next-line no-new-func
    new Function('return ' + lbl[1])(),
  );
}
const bookingAddOns = load();

// The Extras row in the ops booking sheet: what the customer chose, and nothing when they chose
// nothing. A booking made from a quote carries its add-ons as the quote named them.
describe('booking sheet add-ons', () => {
  it('lists a quote-booked booking’s add-ons as the quote named them', () => {
    expect(bookingAddOns({ addOns: ['Waiting fee — Kandy → Ella'], input: {} })).toEqual(['Waiting fee — Kandy → Ella']);
  });

  it('still labels a website transfer’s own extras codes', () => {
    expect(bookingAddOns({ input: { extras: ['sightseeing'] } })).toEqual(['Sightseeing stops']);
  });

  it('is empty when nothing was chosen', () => {
    expect(bookingAddOns({ input: {} })).toEqual([]);
    expect(bookingAddOns(undefined)).toEqual([]);
  });
});
