// api/src/quote/chauffeur.test.ts
import { describe, it, expect } from 'vitest';
import { quoteChauffeur } from './chauffeur';

describe('quoteChauffeur', () => {
  it('Ayan: 3 days, 1 idle (car); buffer on travel only = $260.55', () => {
    const r = quoteChauffeur({
      vehicle: 'car', firstDate: '2026-11-02', lastDate: '2026-11-04',
      travelDays: [
        { date: '2026-11-02', from: 'Hikkaduwa', to: 'N.Eliya', distanceKm: 165 },
        { date: '2026-11-04', from: 'N.Eliya', to: 'Hiriketiya', distanceKm: 210 },
      ],
    });
    expect(r.meta).toEqual({ days: 3, idleDays: 1, travelKm: 375, idleKm: 100, billableKm: 513 });
    expect(r.subtotalCents).toBe(26055); // day 3×27=8100 + 513×35=17955; travel 375→413, idle 100 unbuffered
  });

  it('Emma: 9 days, 4 idle (car); buffer on travel only = $691.00', () => {
    const r = quoteChauffeur({
      vehicle: 'car', firstDate: '2026-02-14', lastDate: '2026-02-22',
      travelDays: [
        { date: '2026-02-14', from: 'Airport', to: 'Kandy', distanceKm: 120 },
        { date: '2026-02-16', from: 'Kandy', to: 'Sigiriya day trip', distanceKm: 200 },
        { date: '2026-02-17', from: 'Kandy', to: 'Ella', distanceKm: 140 },
        { date: '2026-02-19', from: 'Ella', to: 'Bentota', distanceKm: 230 },
        { date: '2026-02-22', from: 'Bentota', to: 'Airport', distanceKm: 110 },
      ],
    });
    expect(r.meta).toEqual({ days: 9, idleDays: 4, travelKm: 800, idleKm: 400, billableKm: 1280 });
    expect(r.subtotalCents).toBe(69100); // day 9×27=24300 + 1280×35=44800; travel 800→880, idle 400 unbuffered
  });

  it('clamps idleDays to 0 when travelDays exceed the date span (bad input)', () => {
    const r = quoteChauffeur({
      vehicle: 'car', firstDate: '2026-03-01', lastDate: '2026-03-01',
      travelDays: [
        { date: '2026-03-01', from: 'A', to: 'B', distanceKm: 50 },
        { date: '2026-03-01', from: 'B', to: 'C', distanceKm: 50 },
      ],
    });
    expect(r.meta.days).toBe(1);
    expect(r.meta.idleDays).toBe(0); // not −1
    expect(r.meta.billableKm).toBe(110); // billableKm(100) + 0 idle = 110
  });

  it('ignores a time component on the dates (no SL-timezone off-by-one)', () => {
    const r = quoteChauffeur({
      vehicle: 'car', firstDate: '2026-02-14T23:30:00+05:30', lastDate: '2026-02-15T01:00:00+05:30',
      travelDays: [{ date: '2026-02-14', from: 'A', to: 'B', distanceKm: 50 }],
    });
    expect(r.meta.days).toBe(2); // 14th and 15th, regardless of clock time
  });
});
