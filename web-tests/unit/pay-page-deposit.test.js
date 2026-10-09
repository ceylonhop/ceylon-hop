import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

// The deposit-or-full choice on the pay link (spec 2026-10-07 §5.2). The helpers are extracted from
// pay.html itself (loadFn pattern — see pay-page-discount.test.js), so the page and the test can
// never drift apart. They take the /view payload and the choice as arguments: no DOM, no globals.

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
const chargedCents = loadFn('chargedCents(view, choice)');
const payOptionsHtml = loadFn('payOptionsHtml(view, choice)');
const payCtaText = loadFn('payCtaText(view, choice)');
const paySubText = loadFn('paySubText(view, choice)');

const TOTALS = { cents: 21900, usd: '$219.00' };
const DEPOSIT = { cents: 5000, usd: '$50.00', balanceCents: 16900, balanceUsd: '$169.00' };
const WITH = { totals: TOTALS, deposit: DEPOSIT };
const WITHOUT = { totals: TOTALS };

describe('the pay link’s deposit choice — what is charged', () => {
  it('charges the trip total by default and when full is chosen', () => {
    expect(chargedCents(WITH, 'full')).toBe(21900);
  });
  it('charges the deposit when the deposit is chosen', () => {
    expect(chargedCents(WITH, 'deposit')).toBe(5000);
  });
  it('ignores a deposit choice when the server offered none', () => {
    expect(chargedCents(WITHOUT, 'deposit')).toBe(21900);
  });
});

describe('the two options', () => {
  it('renders nothing at all when the server offered no deposit', () => {
    expect(payOptionsHtml(WITHOUT, 'full')).toBe('');
  });
  it('offers Pay in full and Pay a deposit, with the figures the server sent', () => {
    const out = payOptionsHtml(WITH, 'full');
    expect(out).toContain('Pay in full');
    expect(out).toContain('$219.00');
    expect(out).toContain('Pay a deposit');
    expect(out).toContain('$50.00');
    expect(out).toContain('balance $169.00 any time before your trip');
  });
  it('full is the default selection; the deposit is chosen only on request', () => {
    const full = payOptionsHtml(WITH, 'full');
    expect(full).toMatch(/value="full" checked/);
    expect(full).not.toMatch(/value="deposit" checked/);
    const dep = payOptionsHtml(WITH, 'deposit');
    expect(dep).toMatch(/value="deposit" checked/);
    expect(dep).not.toMatch(/value="full" checked/);
  });
  it('escapes what the server sent', () => {
    const out = payOptionsHtml({ totals: TOTALS, deposit: { ...DEPOSIT, usd: '<b>x</b>' } }, 'full');
    expect(out).not.toContain('<b>x</b>');
  });
});

describe('the button and the reassurance line follow the choice', () => {
  it('are exactly today’s copy when no deposit is offered', () => {
    expect(payCtaText(WITHOUT, 'full')).toBe('Pay with PayHere');
    expect(paySubText(WITHOUT, 'full')).toBe('Pay securely to confirm. $219.00 — no extra fees.');
  });
  it('name the full amount when full is chosen', () => {
    expect(payCtaText(WITH, 'full')).toBe('Pay $219.00 with PayHere');
    expect(paySubText(WITH, 'full')).toBe('Pay securely to confirm. $219.00 — no extra fees.');
  });
  it('name the deposit and the balance when the deposit is chosen', () => {
    expect(payCtaText(WITH, 'deposit')).toBe('Pay $50.00 deposit with PayHere');
    expect(paySubText(WITH, 'deposit')).toContain('$50.00 now');
    expect(paySubText(WITH, 'deposit')).toContain('$169.00 any time before your trip');
  });
});

describe('the page wires the choice through', () => {
  it('sends payment on /start only when a deposit was offered — an unchanged body otherwise', () => {
    const m = html.match(/function startPayment\(\)\{[\s\S]*?\n  \}\n/);
    expect(m, 'startPayment not found').toBeTruthy();
    expect(m[0]).toMatch(/if \(data && data\.deposit\) startBody\.payment = payChoice/);
    expect(m[0]).toMatch(/JSON\.stringify\(startBody\)/);
  });
  it('stashes what is actually charged for the return leg’s purchase', () => {
    expect(html).toMatch(/cents: chargedCents\(data, payChoice\)/);
  });
  it('reports the stashed charge, not the trip total, as the purchase value', () => {
    const m = html.match(/function trackPurchase\(reference\)\{[\s\S]*?\n  \}\n/);
    expect(m, 'trackPurchase not found').toBeTruthy();
    expect(m[0]).toMatch(/stashedCents/);
    expect(m[0]).toMatch(/p\.value = /);
  });
});
