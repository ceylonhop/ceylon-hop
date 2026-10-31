import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

// Pay on the day (owner 2026-10-29/30): a booking confirmed as USD cash to the Ceylon Hop team at
// the first pickup, with no payment yet. Reopening the pay link must say what is owed and how —
// never "Paid", never a way to pay by card. The markup builder is extracted from pay.html itself
// (loadFn pattern — see pay-page-balance.test.js).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.resolve(__dirname, '../../pay.html'), 'utf8');

function source(signature) {
  const re = new RegExp('function ' + signature.replace(/[()]/g, '\\$&') + ' ?\\{[\\s\\S]*?\\n  \\}');
  const m = html.match(re);
  if (!m) throw new Error(signature + ' not found in pay.html');
  return m[0];
}
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const MASK = ' data-clarity-mask="true"';
// eslint-disable-next-line no-new-func
const passCell = new Function('esc', 'MASK', 'return (' + source('passCell(k, v, sensitive)') + ')')(esc, MASK);
// eslint-disable-next-line no-new-func
const payOnDayHtml = new Function('esc', 'MASK', 'passCell', 'return (' + source('payOnDayHtml(p)') + ')')(esc, MASK, passCell);

const P = { reference: 'CH-AB123', firstName: 'Nimal', amountUsd: '$342.00', title: 'Colombo Airport (CMB) → Galle' };

describe('the pay-on-the-day screen', () => {
  it('says what is owed, how, and that nothing is paid online', () => {
    const out = payOnDayHtml(P);
    expect(out).toContain('Booked');
    expect(out).toContain('You’re booked, Nimal');
    expect(out).toContain('To pay on the day');
    expect(out).toContain('$342.00');
    expect(out).toContain('Cash, US dollars, to the Ceylon Hop team at your first pickup');
    expect(out).toContain('There’s nothing to pay online.');
    expect(out).toContain('CH-AB123');
  });

  it('never says Paid, never offers a button or a form, never claims an email went out', () => {
    const out = payOnDayHtml(P);
    expect(out).not.toMatch(/Paid/);
    expect(out).not.toMatch(/<button|<form|<input/i);
    expect(out).not.toMatch(/email/i);
    expect(out).not.toMatch(/driver/i);
  });

  it('falls back to a plain heading without a name', () => {
    const out = payOnDayHtml({ ...P, firstName: null });
    expect(out).toContain('You’re booked<');
  });

  it('escapes every value it prints', () => {
    const out = payOnDayHtml({ reference: '<i>r</i>', firstName: '<b>n</b>', amountUsd: '<s>a</s>', title: '<u>t</u>' });
    expect(out).not.toMatch(/<i>r<\/i>|<b>n<\/b>|<s>a<\/s>|<u>t<\/u>/);
  });
});

describe('routing', () => {
  it('sends the pay_on_day state to renderPayOnDay wherever paid is routed', () => {
    const paidRoutes = html.match(/v\.state === 'paid'/g) || [];
    const podRoutes = html.match(/if \(v\.state === 'pay_on_day'\) \{ forget\(\); return renderPayOnDay\(v\); \}/g) || [];
    expect(paidRoutes.length).toBeGreaterThan(0);
    expect(podRoutes.length).toBe(paidRoutes.length);
  });
});
