import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

// Booked, payment due (owner 2026-11-01): ops pressed Mark booked without cash on the day, so the
// trip is booked but no money is in. The pay link used to show the paid keepsake ("Confirmation
// emailed", "Paid $X"). It must say what is still owed — never "Paid", never a card, no email
// claim. The markup builder is extracted from pay.html itself (see pay-page-pay-on-day.test.js).

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
const paymentDueHtml = new Function('esc', 'MASK', 'passCell', 'return (' + source('paymentDueHtml(p)') + ')')(esc, MASK, passCell);

const P = { reference: 'CH-AB123', firstName: 'Nimal', amountUsd: '$342.00', title: 'Colombo Airport (CMB) → Galle' };

describe('the booked, payment due screen', () => {
  it('says the trip is booked, what is still owed, and that the team will arrange payment', () => {
    const out = paymentDueHtml(P);
    expect(out).toContain('Booked');
    expect(out).toContain('You’re booked, Nimal');
    expect(out).toContain('Still to pay');
    expect(out).toContain('$342.00');
    expect(out).toContain('The Ceylon Hop team will be in touch to arrange payment');
    expect(out).toContain('Nothing has been charged yet.');
    expect(out).toContain('CH-AB123');
  });

  it('never says Paid, never offers a button or a form, never claims an email went out', () => {
    const out = paymentDueHtml(P);
    expect(out).not.toMatch(/Paid/);
    expect(out).not.toMatch(/<button|<form|<input/i);
    expect(out).not.toMatch(/email/i);
    expect(out).not.toMatch(/driver/i);
  });

  it('falls back to a plain heading without a name', () => {
    const out = paymentDueHtml({ ...P, firstName: null });
    expect(out).toContain('You’re booked<');
  });

  it('escapes every value it prints', () => {
    const out = paymentDueHtml({ reference: '<i>r</i>', firstName: '<b>n</b>', amountUsd: '<s>a</s>', title: '<u>t</u>' });
    expect(out).not.toMatch(/<i>r<\/i>|<b>n<\/b>|<s>a<\/s>|<u>t<\/u>/);
  });
});

describe('routing', () => {
  it('sends the payment_due state to renderPaymentDue wherever paid is routed', () => {
    const paidRoutes = html.match(/v\.state === 'paid'/g) || [];
    const dueRoutes = html.match(/if \(v\.state === 'payment_due'\) \{ forget\(\); return renderPaymentDue\(v\); \}/g) || [];
    expect(paidRoutes.length).toBeGreaterThan(0);
    expect(dueRoutes.length).toBe(paidRoutes.length);
  });
});
