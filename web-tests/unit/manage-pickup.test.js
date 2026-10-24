import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { futureIsoDate } from '../dates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.resolve(__dirname, '../../manage.html'), 'utf8');

// Pull named functions out of manage.html (loadFn pattern — see manage-page-addons.test.js).
function grab(name) {
  const m = html.match(new RegExp(`function ${name}\\([^)]*\\)\\{[\\s\\S]*?\\n  \\}`));
  if (!m) throw new Error(`${name} not found in manage.html`);
  return m[0];
}
const MON3 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const isoParts = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? { y: +m[1], mo: +m[2], d: +m[3] } : null; };
// eslint-disable-next-line no-new-func
const lib = new Function('MON3', 'isoParts',
  ['isAirport', 'fmtTime', 'slotLabel', 'pickupNeeds', 'timeChoices', 'shortDate', 'saveLabel'].map(grab).join('\n')
  + '\nreturn { isAirport, fmtTime, pickupNeeds, timeChoices, saveLabel, shortDate };')(MON3, isoParts);

const paid = { mode: 'single', status: 'paid', from: 'Kandy', date: 'to confirm', time: 'to confirm' };

describe('pickupNeeds — when the card shows, and what it asks for', () => {
  it('asks for both, the date, or the time', () => {
    expect(lib.pickupNeeds(paid)).toBe('both');
    expect(lib.pickupNeeds({ ...paid, time: '09:00' })).toBe('date');
    expect(lib.pickupNeeds({ ...paid, date: futureIsoDate() })).toBe('time');
  });
  it('shows nothing once both are set, or on a booking the customer may not edit', () => {
    expect(lib.pickupNeeds({ ...paid, date: futureIsoDate(), time: '09:00' })).toBeNull();
    for (const status of ['draft', 'payment_pending', 'cancelled', 'refunded', 'completed']) {
      expect(lib.pickupNeeds({ ...paid, status })).toBeNull();
    }
    expect(lib.pickupNeeds({ ...paid, mode: 'trip' })).toBeNull();
    expect(lib.pickupNeeds({ ...paid, status: 'confirmed' })).toBe('both');
  });
});

describe('time choices match the booking page; airports step every 15 min', () => {
  it('hotel pickups: 24 hourly slots, labelled like booking.js', () => {
    const t = lib.timeChoices(paid);
    expect(t).toHaveLength(24);
    expect(t[9]).toEqual({ value: '09:00', label: '9:00 am · Morning pickup' });
    expect(t[0].label).toBe('12:00 am · Night pickup');
    expect(t[13].label).toBe('1:00 pm · Afternoon pickup');
  });
  it('airport landings: 96 quarter-hour slots, no pickup labels', () => {
    const t = lib.timeChoices({ ...paid, from: 'Colombo Airport (CMB)' });
    expect(t).toHaveLength(96);
    expect(t[35]).toEqual({ value: '08:45', label: '8:45 am' });
  });
});

describe('the save button names what it will save, or what is missing', () => {
  const d = '2026-11-04'; // date-bomb-ok: input to a pure formatter (shortDate), paired with a literal expected label; no rule here reads "today"
  it('says what is missing while it cannot save', () => {
    expect(lib.saveLabel(paid, '', '', false, false)).toEqual({ text: 'Choose a date', ready: false });
    expect(lib.saveLabel(paid, d, '', false, false)).toEqual({ text: 'Choose a pick-up time', ready: false });
    expect(lib.saveLabel({ ...paid, from: 'CMB' }, d, '', false, false)).toEqual({ text: 'Choose a landing time', ready: false });
    expect(lib.saveLabel(paid, d, '09:00', false, true)).toEqual({ text: 'Too soon to set here', ready: false });
  });
  it('names the exact value once it can', () => {
    expect(lib.saveLabel(paid, d, '09:00', false, false)).toEqual({ text: 'Save Wed 4 Nov · 9:00 am', ready: true });
    expect(lib.saveLabel({ ...paid, from: 'Colombo Airport (CMB)' }, d, '08:45', false, false)).toEqual({ text: 'Save landing Wed 4 Nov · 8:45 am', ready: true });
    expect(lib.saveLabel(paid, d, '', true, false)).toEqual({ text: 'Save Wed 4 Nov · time later', ready: true });
  });
});
