import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.resolve(__dirname, '../../api/src/routes/ops-ui.html'), 'utf8');

// Pay on the day (owner 2026-10-29/30): a founder books a WhatsApp customer whose card failed as
// "Customer pays cash on the day". The booking is confirmed with nothing paid, and the customer
// pays USD cash to the Ceylon Hop team at the first pickup. The ops console must not call that
// booking "Paid". The helpers are pure consts inside ops-ui.html; lift and eval the real code.
function liftConst(name) {
  const start = html.indexOf(`const ${name}=`);
  if (start < 0) throw new Error(`const ${name} not found in ops-ui.html`);
  let depth = 0;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') depth--;
    else if (ch === ';' && depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`const ${name} never terminated`);
}

// eslint-disable-next-line no-new-func
const { cashDue, stageLabel, pipeLabel } = new Function(`
  ${liftConst('STAGE')}
  ${liftConst('isBoard')}
  ${liftConst('boardShut')}
  ${liftConst('cashDue')}
  ${liftConst('stageLabel')}
  ${liftConst('pipeLabel')}
  return { cashDue, stageLabel, pipeLabel };
`)();

const onTheDay = (over) => ({ source: 'booking', stage: 'paid', paid: false, paymentArrangement: 'on_the_day', cashDue: 34200, ...over });

describe('cashDue', () => {
  it('is true for a pay-on-the-day booking with cash still to collect', () => {
    expect(cashDue(onTheDay())).toBe(true);
  });
  it('is false once the cash is recorded, or without the arrangement', () => {
    expect(cashDue(onTheDay({ cashDue: 0, paid: true }))).toBe(false);
    expect(cashDue({ source: 'booking', stage: 'paid', paid: true, paymentArrangement: null, cashDue: 0 })).toBe(false);
    expect(cashDue({ source: 'booking', stage: 'paid', paid: true })).toBe(false);
  });
});

describe('stageLabel', () => {
  it('says "Confirmed · cash due" — never "Paid" — while the cash is still owed', () => {
    expect(stageLabel(onTheDay())).toBe('Confirmed · cash due');
  });
  it('keeps the fulfilment label at later stages (the row adds a "Cash due" chip)', () => {
    expect(stageLabel(onTheDay({ stage: 'vehicle_confirmed' }))).toBe('Vehicle confirmed');
  });
  it('is unchanged without cash due', () => {
    expect(stageLabel(onTheDay({ cashDue: 0, paid: true }))).toBe('Paid');
    expect(stageLabel({ source: 'booking', stage: 'paid', paid: true })).toBe('Paid');
    expect(stageLabel({ source: 'booking', stage: 'vehicle_confirmed', paid: true })).toBe('Vehicle confirmed');
  });
});

describe('pipeLabel — the sheet pipeline rail', () => {
  it('reads "Cash due" on the Paid step while cash is owed', () => {
    expect(pipeLabel(onTheDay(), 'paid')).toBe('Cash due');
    expect(pipeLabel(onTheDay({ stage: 'pickup_confirmed' }), 'paid')).toBe('Cash due');
  });
  it('leaves every other step, and a settled booking, as today', () => {
    expect(pipeLabel(onTheDay(), 'vehicle_confirmed')).toBe('Vehicle');
    expect(pipeLabel(onTheDay({ cashDue: 0, paid: true }), 'paid')).toBe('Paid');
    expect(pipeLabel({ source: 'booking', stage: 'paid', paid: true }, 'paid')).toBe('Paid');
  });
});

describe('copy', () => {
  it('never names the driver as the cash collector', () => {
    expect(html).not.toMatch(/driver (collects|takes) (the )?cash/i);
    expect(html).not.toMatch(/cash (to|for) the driver/i);
  });
});
