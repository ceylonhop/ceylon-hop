import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

// The balance of a deposit booking, on the same pay link (spec 2026-10-07 §5.3). The pure helpers
// are extracted from pay.html itself (loadFn pattern — see pay-page-deposit.test.js).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.resolve(__dirname, '../../pay.html'), 'utf8');

function loadFn(signature) {
  const re = new RegExp('function ' + signature.replace(/[()]/g, '\\$&') + ' \\{[\\s\\S]*?\\n  \\}');
  const m = html.match(re);
  if (!m) throw new Error(signature + ' not found in pay.html');
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // eslint-disable-next-line no-new-func
  return new Function('esc', 'return (' + m[0] + ')')(esc);
}
const balanceRowsHtml = loadFn('balanceRowsHtml(b, on, due)');
const balanceDueText = loadFn('balanceDueText(copy)');
const paidOnLabel = loadFn('paidOnLabel(iso)');
const chargedCents = loadFn('chargedCents(view, choice)');

const BALANCE = { title: 'Colombo Airport (CMB) → Galle', totalUsd: '$219.00', paidUsd: '$50.00', paidOn: '2026-10-05', balanceCents: 16900, balanceUsd: '$169.00' };

describe('the balance rows', () => {
  it('shows the trip total, the deposit paid — marked and dated — and the balance with when it is due', () => {
    const out = balanceRowsHtml(BALANCE, '5 Oct 2026', 'due on your arrival day · Fri 14 Nov');
    expect(out).toContain('Trip total');
    expect(out).toContain('$219.00');
    // The paid row is its own, clearly marked row (owner, 2026-10-12: "the paid amount should be more clear").
    expect(out).toMatch(/<div class="tot tot-paid"><span class="l">&#10003; Deposit paid · 5 Oct 2026<\/span><span class="v">\$50\.00/);
    expect(out).toMatch(/<div class="tot tot-final"><span class="l">Balance<small>due on your arrival day · Fri 14 Nov<\/small><\/span><span class="v">\$169\.00/);
  });
  it('still reads cleanly with no paid date and no due line', () => {
    const out = balanceRowsHtml(BALANCE, '', '');
    expect(out).toMatch(/&#10003; Deposit paid<\/span>/);
    expect(out).toMatch(/<span class="l">Balance<\/span>/);
  });
  it('escapes what it prints', () => {
    expect(balanceRowsHtml({ ...BALANCE, balanceUsd: '<b>x</b>' }, '', '<i>y</i>')).not.toMatch(/<b>x<\/b>|<i>y<\/i>/);
  });
});

// Owner, 2026-10-12: a chauffeur trip's balance is "due on arrival day"; a transfer's on the day it runs.
describe('when the balance is due', () => {
  it('a chauffeur trip: on the arrival day, with the date when the quote has one', () => {
    expect(balanceDueText({ product: 'chauffeur', facts: [{ k: 'Starts', v: 'Fri 14 Nov' }] })).toBe('due on your arrival day · Fri 14 Nov');
    expect(balanceDueText({ product: 'chauffeur', facts: [{ k: 'Starts', v: '—' }] })).toBe('due on your arrival day');
  });
  it('a single transfer: on the day of the transfer', () => {
    expect(balanceDueText({ product: 'single', facts: [] })).toBe('due on the day of your transfer');
  });
  it('any other trip: on its first day; and nothing known says only "any time"', () => {
    expect(balanceDueText({ product: 'trip', facts: [] })).toBe('due on the first day of your trip');
    expect(balanceDueText(null)).toBe('pay any time before your trip');
  });
});

describe('paidOnLabel', () => {
  it('prints a date-only string as that calendar day, whatever the viewer’s timezone', () => {
    expect(paidOnLabel('2026-10-05')).toBe('5 Oct 2026');
    expect(paidOnLabel('2026-01-31')).toBe('31 Jan 2026');
  });
  it('prints nothing for a missing or odd value', () => {
    for (const bad of [null, undefined, '', 'yesterday', '2026-00-10', '2026-10-5']) expect(paidOnLabel(bad)).toBe('');
  });
});

describe('what a balance attempt charges (for the stash and the loading screen)', () => {
  it('is the balance, not the trip total', () => {
    expect(chargedCents({ state: 'balance', balance: BALANCE }, 'full')).toBe(16900);
  });
  it('is unchanged for a payable view', () => {
    expect(chargedCents({ totals: { cents: 21900 }, deposit: { cents: 5000 } }, 'deposit')).toBe(5000);
    expect(chargedCents({ totals: { cents: 21900 } }, 'full')).toBe(21900);
  });
});

describe('the balance flow in the page source', () => {
  it('calls /quotes/pay/balance and then the checkout with purpose:"balance"', () => {
    expect(html).toMatch(/fetchJson\(A \+ '\/quotes\/pay\/balance'/);
    expect(html).toMatch(/postCheckout\(st, \{ purpose: 'balance' \}\)/);
  });
  it('flags the balance hand-off so the return leg sends no browser purchase', () => {
    expect(html).toMatch(/setItem\(STORE \+ ':balance', '1'\)/);
    expect(html).toMatch(/if \(balanceReturn\(\)\) return;/);
  });
  it('a fresh payment clears the flag, so a later purchase is still counted', () => {
    expect(html).toMatch(/removeItem\(STORE \+ ':balance'\)/);
  });
});
