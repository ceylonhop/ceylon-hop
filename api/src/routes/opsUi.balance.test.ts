import { describe, it, expect, beforeAll } from 'vitest';
import { createApp } from '../app';

// Ops shell — the open balance of a deposit booking (spec 2026-10-07 §5.4, rev. 2026-10-08). The
// shell is one inlined script, so the pure helpers are lifted out and table-tested, and the drawer
// wiring is pinned by source.

let body: string;

function liftConst(src: string, name: string): string {
  const start = src.indexOf(`const ${name}=`);
  expect(start, `${name} not found in the ops shell`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') depth--;
    else if (ch === ';' && depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${name} never terminated`);
}

beforeAll(async () => {
  body = await (await createApp().request('/ops')).text();
});

const TODAY = '2026-10-08';
function reasonFn() {
  const src = `${liftConst(body, 'CLOSED')} ${liftConst(body, 'reason')}`;
  return new Function('TODAY', `${src}; return reason;`)(TODAY) as (t: unknown) => string;
}

describe('reason() — a balance that is still open on the day of travel', () => {
  const live = { source: 'booking', stage: 'paid', balance: 16900, updated: false };

  it('says "Balance due — travels today" when the balance is open and the trip is today', () => {
    expect(reasonFn()({ ...live, date: TODAY })).toBe('Balance due — travels today');
  });
  it('ranks above the vehicle and contact nags, which it would otherwise hide', () => {
    expect(reasonFn()({ ...live, stage: 'vehicle_confirmed', date: TODAY })).toBe('Balance due — travels today');
  });
  it('stays quiet about the balance on any other day — it can be paid any time before', () => {
    expect(reasonFn()({ ...live, date: '2026-10-09' })).toBe('Vehicle not confirmed yet');
    expect(reasonFn()({ ...live, date: '2026-10-07' })).toBe('Trip date passed — mark completed or no-show');
  });
  it('stays quiet when nothing is owed, or the booking is closed', () => {
    expect(reasonFn()({ ...live, balance: 0, date: TODAY })).toBe('Vehicle not confirmed yet');
    expect(reasonFn()({ ...live, stage: 'cancelled', date: TODAY })).toBe('');
  });
});

describe('the ticket carries the ledger figures', () => {
  it('maps paidCents and balanceCents off the row', () => {
    const start = body.indexOf('function rowToTicket(');
    expect(start).toBeGreaterThan(-1);
    let depth = 0; let i = body.indexOf('{', start);
    for (; i < body.length; i++) { if (body[i] === '{') depth++; else if (body[i] === '}' && --depth === 0) break; }
    const fn = new Function(`${body.slice(start, i + 1)}; return rowToTicket;`)() as (r: unknown) => { paidCents: number; balance: number };
    expect(fn({ id: 'b', reference: 'CH-1', paidCents: 5000, balanceCents: 16900, opsNotes: '' })).toMatchObject({ paidCents: 5000, balance: 16900 });
    expect(fn({ id: 'b', reference: 'CH-1', opsNotes: '' })).toMatchObject({ paidCents: 0, balance: 0 });
  });
});

describe('ops shell: balance wiring', () => {
  it('the list row shows a "Balance $X" pill only when a balance is owed', () => {
    expect(body).toMatch(/t\.paid&&t\.balance>0\?`<span class="pill pill-bal"[^`]*Balance \$\{money\(\{amount:t\.balance/);
  });
  it('the drawer shows Paid so far / Balance due and the "Deposit paid" status', () => {
    expect(body).toContain('Paid so far');
    expect(body).toContain('Balance due');
    expect(body).toContain('Deposit paid');
  });
  it('Copy pay link is offered only with a balancePayLink, and copies exactly that', () => {
    expect(body).toMatch(/\$\{d\.balancePayLink\?`<div class="sheet-actions"><button class="btn" data-act="balancelink"/);
    expect(body).toMatch(/case 'balancelink':\{const link=state\.detailData&&state\.detailData\.balancePayLink;/);
    expect(body).toMatch(/case 'balancelink':[^\n]*writeText\(link\)/);
  });
});
