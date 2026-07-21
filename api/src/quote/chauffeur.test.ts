// api/src/quote/chauffeur.test.ts
import { describe, it, expect } from 'vitest';
import { quoteChauffeur } from './chauffeur';
import { billableKm } from './private';
import { RATE_CARD } from './rateCard';
import { normalizeChauffeurDay, rideRawKm } from './types';
import type { ChauffeurTravelDay, ChauffeurRideDay } from './types';

describe('quoteChauffeur', () => {
  it('Ayan: 3 days, 1 idle (car); travel buffer clamps per leg before idle km = $276.29', () => {
    const travelDays: ChauffeurTravelDay[] = [
      { date: '2026-11-02', from: 'Hikkaduwa', to: 'N.Eliya', distanceKm: 165 },
      { date: '2026-11-04', from: 'N.Eliya', to: 'Hiriketiya', distanceKm: 210 },
    ];
    const r = quoteChauffeur({
      vehicle: 'car', firstDate: '2026-11-02', lastDate: '2026-11-04',
      travelDays: travelDays.map(normalizeChauffeurDay),
    });
    expect(r.meta).toEqual({ days: 3, idleDays: 1, travelKm: 375, idleKm: 50, billableKm: 455 });
    expect(r.subtotalCents).toBe(27629); // day 3×31.05=9315 + 455×40.25=18314; travel 165→180 and 210→225, idle 50 (car) unbuffered
  });

  it('Emma: 9 days, 4 idle (car); travel buffer clamps per leg before idle km = $708.92', () => {
    const travelDays: ChauffeurTravelDay[] = [
      { date: '2026-02-14', from: 'Airport', to: 'Kandy', distanceKm: 120 },
      { date: '2026-02-16', from: 'Kandy', to: 'Sigiriya day trip', distanceKm: 200 },
      { date: '2026-02-17', from: 'Kandy', to: 'Ella', distanceKm: 140 },
      { date: '2026-02-19', from: 'Ella', to: 'Bentota', distanceKm: 230 },
      { date: '2026-02-22', from: 'Bentota', to: 'Airport', distanceKm: 110 },
    ];
    const r = quoteChauffeur({
      vehicle: 'car', firstDate: '2026-02-14', lastDate: '2026-02-22',
      travelDays: travelDays.map(normalizeChauffeurDay),
    });
    expect(r.meta).toEqual({ days: 9, idleDays: 4, travelKm: 800, idleKm: 200, billableKm: 1067 });
    expect(r.subtotalCents).toBe(70892); // day 9×31.05=27945 + 1067×40.25=42947; travel legs buffer individually, idle 200 (car) unbuffered
  });

  it('clamps idleDays to 0 when travelDays exceed the date span (bad input)', () => {
    const travelDays: ChauffeurTravelDay[] = [
      { date: '2026-03-01', from: 'A', to: 'B', distanceKm: 50 },
      { date: '2026-03-01', from: 'B', to: 'C', distanceKm: 50 },
    ];
    const r = quoteChauffeur({
      vehicle: 'car', firstDate: '2026-03-01', lastDate: '2026-03-01',
      travelDays: travelDays.map(normalizeChauffeurDay),
    });
    expect(r.meta.days).toBe(1);
    expect(r.meta.idleDays).toBe(0); // not −1
    expect(r.meta.billableKm).toBe(110); // billableKm(50) + billableKm(50) + 0 idle = 55+55 = 110
  });

  it('ignores a time component on the dates (no SL-timezone off-by-one)', () => {
    const travelDays: ChauffeurTravelDay[] = [{ date: '2026-02-14', from: 'A', to: 'B', distanceKm: 50 }];
    const r = quoteChauffeur({
      vehicle: 'car', firstDate: '2026-02-14T23:30:00+05:30', lastDate: '2026-02-15T01:00:00+05:30',
      travelDays: travelDays.map(normalizeChauffeurDay),
    });
    expect(r.meta.days).toBe(2); // 14th and 15th, regardless of clock time
  });

  it('a 2-segment travel day buffers ONCE on the segment sum, not once per segment', () => {
    // Kandy→Dambulla (72km)→Habarana (23km) as ONE travel day: raw = 95km, buffer once =
    // 105km. If buffered per-segment instead (billableKm(72) + billableKm(23) = 79 + 28 =
    // 107km), the wrong (higher) total would sneak through — this test pins the correct,
    // lower, once-per-day figure.
    const day: ChauffeurRideDay = { date: '2026-11-02', stops: ['Kandy', 'Dambulla', 'Habarana'], segmentKms: [72, 23] };
    const rawKm = rideRawKm(day);
    const bufferedOnce = billableKm(rawKm);
    const bufferedPerSegment = billableKm(72) + billableKm(23);
    expect(rawKm).toBe(95);
    expect(bufferedOnce).toBe(105);
    expect(bufferedPerSegment).toBe(107); // proves the two strategies actually differ
    expect(bufferedOnce).not.toBe(bufferedPerSegment);

    const r = quoteChauffeur({
      vehicle: 'car', firstDate: '2026-11-02', lastDate: '2026-11-02',
      travelDays: [day],
    });
    expect(r.meta.travelKm).toBe(rawKm);
    expect(r.meta.billableKm).toBe(bufferedOnce); // 105, not 107
    const expectedDistanceCents = Math.round(bufferedOnce * RATE_CARD.perKmCents.car);
    const expectedDayCents = 1 * RATE_CARD.chauffeur.dayRateCents;
    expect(r.subtotalCents).toBe(expectedDayCents + expectedDistanceCents);
  });
});
