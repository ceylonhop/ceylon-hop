import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Pure functions inside ops-ui.html, extracted by source marker and eval'd (same trick as
// ops-pay-selection.test.js), so this exercises the REAL page code.
const fmtUsd = (c) => '$' + (c / 100).toFixed(2);
function loadFn(signature) {
  const html = readFileSync(path.resolve(__dirname, '../../api/src/routes/ops-ui.html'), 'utf8');
  const re = new RegExp('function ' + signature.replace(/[()]/g, '\\$&') + ' ?\\{[\\s\\S]*?\\n\\}');
  const m = html.match(re);
  if (!m) throw new Error(signature + ' not found in ops-ui.html');
  // eslint-disable-next-line no-new-func
  return new Function('fmtUsd', 'return (' + m[0] + ')')(fmtUsd);
}
const partSaleText = loadFn('partSaleText(sale)');
const quoteRowCents = loadFn('quoteRowCents(q)');

const SALE = { soldLegs: 1, totalLegs: 4, soldCents: 9293, quotedCents: 26700, bookingReference: 'CH-SLJNB' };

describe('partSaleText', () => {
  it('says what sold, what was quoted, what did not sell, and which booking', () => {
    expect(partSaleText(SALE)).toBe('Sold 1 of 4 legs: $92.93 of the $267.00 quoted · 3 legs not sold · CH-SLJNB');
  });

  it('counts one unsold leg in the singular', () => {
    expect(partSaleText({ ...SALE, soldLegs: 3 })).toContain('· 1 leg not sold ·');
  });
});

describe('quoteRowCents', () => {
  it('a booked quote shows what was sold', () => {
    expect(quoteRowCents({ status: 'won', totalCents: 26700, soldCents: 9293 })).toBe(9293);
  });

  it('a booked quote with no sold amount shows the quote total', () => {
    expect(quoteRowCents({ status: 'won', totalCents: 26700, soldCents: null })).toBe(26700);
  });

  it('an open quote with a part-of-trip link out still shows the quote total: nothing sold yet', () => {
    expect(quoteRowCents({ status: 'sent', totalCents: 26700, soldCents: 9293 })).toBe(26700);
  });
});
