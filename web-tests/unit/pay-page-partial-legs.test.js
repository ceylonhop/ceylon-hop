import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Extract ticketBody from pay.html itself (house loadFn pattern), injecting esc.
function loadFn(signature) {
  const html = readFileSync(path.resolve(__dirname, '../../pay.html'), 'utf8');
  const re = new RegExp('function ' + signature.replace(/[()]/g, '\\$&') + '\\s*\\{[\\s\\S]*?\\n  \\}');
  const m = html.match(re);
  if (!m) throw new Error(signature + ' not found in pay.html');
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // eslint-disable-next-line no-new-func
  return new Function('esc', 'return (' + m[0] + ')')(esc);
}
const ticketBody = loadFn('ticketBody(c)');

const legs = (covered) => ({
  facts: [],
  legs: [
    { route: 'Colombo Airport (CMB) → Unawatuna', date: 'FRI 7 AUG', covered: covered?.[0] },
    { route: 'Unawatuna → Trincomalee', date: 'WED 12 AUG', covered: covered?.[1] },
  ],
});

describe('pay page — partial itinerary', () => {
  it('marks a journey this payment does NOT cover', () => {
    const html = ticketBody(legs([true, false]));
    expect(html).toContain('not in this payment');
    // …and only once: the covered leg must not be labelled.
    expect(html.match(/not in this payment/g)).toHaveLength(1);
  });

  it('gives the uncovered row a class the stylesheet can dim', () => {
    expect(ticketBody(legs([true, false]))).toContain('is-uncovered');
  });

  it('says nothing extra on a whole-trip link', () => {
    const html = ticketBody(legs(undefined)); // no `covered` at all
    expect(html).not.toContain('not in this payment');
    expect(html).not.toContain('is-uncovered');
  });

  it('still lists every journey', () => {
    const html = ticketBody(legs([true, false]));
    expect(html).toContain('Colombo Airport (CMB)');
    expect(html).toContain('Trincomalee');
  });
});
