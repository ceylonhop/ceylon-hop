import { describe, expect, it } from 'vitest';
import { MAX_PER_STOP, matchExperiences } from './match';

// Sigiriya catalogue point (transfers-data.js) and pins due north at known offsets; 0.009° lat ≈ 1 km.
const SIGIRIYA = { label: 'Sigiriya', lat: 7.95, lng: 80.76 };
const KANDY = { label: 'Kandy', lat: 7.2906, lng: 80.6337 };
const exp = (id: string, kmNorth: number, radiusKm: number, active = true) =>
  ({ id, lat: 7.95 + kmNorth * 0.009, lng: 80.76, radiusKm, active });

describe('matchExperiences (spec D6)', () => {
  it('shows an experience inside its own radius and hides one outside it', () => {
    const r = matchExperiences([SIGIRIYA], [exp('near', 3, 5), exp('far', 8, 5)]);
    expect(r[0]!.items.map((m) => m.experience.id)).toEqual(['near']);
    expect(r[0]!.items[0]!.distanceKm).toBeCloseTo(3, 0);
  });
  it('uses each experience’s own reach: 25 km out with a 30 km radius matches', () => {
    expect(matchExperiences([SIGIRIYA], [exp('safari', 25, 30)])[0]!.items[0]!.experience.id).toBe('safari');
  });
  it('sorts nearest first', () => {
    const r = matchExperiences([SIGIRIYA], [exp('a', 4, 10), exp('b', 1, 10), exp('c', 2, 10)]);
    expect(r[0]!.items.map((m) => m.experience.id)).toEqual(['b', 'c', 'a']);
  });
  it('ignores inactive experiences', () => {
    expect(matchExperiences([SIGIRIYA], [exp('off', 1, 5, false)])).toEqual([]);
  });
  it(`caps a stop at ${MAX_PER_STOP}`, () => {
    const many = Array.from({ length: 9 }, (_, i) => exp(`e${i}`, 1, 5));
    expect(matchExperiences([SIGIRIYA], many)[0]!.items).toHaveLength(MAX_PER_STOP);
  });
  it('never repeats an experience under a later stop', () => {
    const r = matchExperiences([SIGIRIYA, KANDY], [exp('both', 1, 200)]);
    expect(r).toHaveLength(1);
    expect(r[0]!.place).toBe('Sigiriya');
  });
  it('omits stops with no matches', () => {
    expect(matchExperiences([KANDY], [exp('near-sigiriya', 1, 5)])).toEqual([]);
  });
});
