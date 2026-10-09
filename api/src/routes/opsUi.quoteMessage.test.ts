import { describe, it, expect, beforeAll } from 'vitest';
import { createApp } from '../app';

// The payment line of the quote message ops copies to the customer (WhatsApp and email, chauffeur
// quotes). Since deposits (spec 2026-10-07, rev. 2026-10-08) an eligible quote's pay link offers a
// deposit or full payment, so the message must say so — driven by the engine's own deposit figure,
// never a second copy of the eligibility rule. Owner asked for this wording 2026-10-09.

let body = '';

/** Lift `const NAME = …;` out of the ops shell (same idea as opsUi.dates.test.ts's lift). */
function lift(name: string): string {
  const m = new RegExp(`const ${name}\\s*=`).exec(body);
  expect(m, `${name} not found in the ops shell`).toBeTruthy();
  const start = m!.index;
  let depth = 0;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') depth--;
    else if (ch === ';' && depth === 0) return body.slice(start, i + 1);
  }
  throw new Error(`${name} never terminated`);
}

type Est = { amountDueNow?: { cents: number | null }; deposit?: { cents: number } };
let payLineText: (est: Est, totalCents: number, M: (c: number) => string) => string;
const M = (c: number) => '$' + (c / 100).toFixed(2);

beforeAll(async () => {
  body = await (await createApp().request('/ops')).text();
  payLineText = new Function(`${lift('payLineText')}; return payLineText;`)();
});

describe('quote message payment line', () => {
  it('offers the deposit and full payment on an eligible quote', () => {
    expect(payLineText({ amountDueNow: { cents: 64000 }, deposit: { cents: 6400 } }, 64000, M)).toBe(
      'Pay a deposit of $64.00 to confirm (balance $576.00 any time before your trip), or pay in full: $640.00.',
    );
  });

  it('keeps the full-payment line when the quote takes no deposit', () => {
    expect(payLineText({ amountDueNow: { cents: 12000 }, deposit: { cents: 0 } }, 12000, M)).toBe('Pay in full to confirm: $120.00.');
    expect(payLineText({ amountDueNow: { cents: 12000 } }, 12000, M)).toBe('Pay in full to confirm: $120.00.');
  });

  it('both messages use it — no second copy of the line', () => {
    expect(body.match(/payLineText\(lastEstimate, totalCents, M\)/g)?.length).toBe(2);
    expect(body).not.toMatch(/lines\.push\('', 'Pay in full to confirm: '/);
  });
});
