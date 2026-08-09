import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Extract the two partial-link render helpers from pay.html itself (loadFn pattern — see
// ops-pay-selection.test.js), injecting a local esc since the page's esc needs a DOM.
function loadFn(signature) {
  const html = readFileSync(path.resolve(__dirname, '../../pay.html'), 'utf8');
  const re = new RegExp('function ' + signature.replace(/[()]/g, '\\$&') + ' \\{[\\s\\S]*?\\n  \\}');
  const m = html.match(re);
  if (!m) throw new Error(signature + ' not found in pay.html');
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // eslint-disable-next-line no-new-func
  return new Function('esc', 'return (' + m[0] + ')')(esc);
}
const linesHtml = loadFn('linesHtml(lines)');
const coverageSentence = loadFn('coverageSentence(coverage)');

describe('partial pay page receipt', () => {
  it('renders one row per paid line, amounts in dollars', () => {
    const html = linesHtml([
      { label: 'Colombo → Kandy (car)', amountCents: 5000 },
      { label: 'Luggage rack — Kandy → Ella', amountCents: 500 },
    ]);
    expect(html).toContain('Colombo → Kandy (car)');
    expect(html).toContain('$50.00');
    expect(html).toContain('$5.00');
  });

  it('escapes place names', () => {
    expect(linesHtml([{ label: '<script>x</script>', amountCents: 100 }])).not.toContain('<script>');
  });

  it('is empty for a full-quote link, which sends no lines', () => {
    expect(linesHtml(undefined)).toBe('');
    expect(linesHtml([])).toBe('');
  });

  it('states coverage in words', () => {
    expect(coverageSentence({ soldLegs: 2, totalLegs: 4 }))
      .toBe('This covers 2 of the 4 legs in your itinerary.');
  });

  it('says nothing when coverage is absent', () => {
    expect(coverageSentence(undefined)).toBe('');
  });
});
