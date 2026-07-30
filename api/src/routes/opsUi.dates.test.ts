import { describe, it, expect, beforeAll } from 'vitest';
import { createApp } from '../app';
import { quoteChauffeur } from '../quote/chauffeur';
import { normalizeChauffeurDay } from '../quote/types';

// The trip calendar's maths (ops-ui.html `tripCal`) exists so an operator can SEE that the
// dates are right before the price goes out. That only works if its numbers are the ones the
// engine actually prices from — so beyond unit-testing the helper, this suite pins it byte-
// for-byte against quoteChauffeur's own day counting (the drift test at the bottom).

let body = '';

/** Lift `const NAME = …;` out of the ops shell, however many lines it spans (same idea as
 * opsUi.board.test.ts's liftConst, but tolerant of spaces around the `=`). */
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

type Leg = { date: string; category?: string; stops?: string[] };
type CalModel = {
  start: string; end: string; span: number; drivingLegs: number; chargedIdle: number;
  byDay: Record<number, Leg[]>; undated: number;
};
type TripCal = {
  addDays(iso: string, n: number): string;
  model(legs: Leg[]): CalModel | null;
  biggestGap(m: CalModel): { fromDay: number; days: number } | null;
  warning(m: CalModel | null, charged?: boolean): string | null;
};
let cal: TripCal;

beforeAll(async () => {
  body = await (await createApp().request('/ops')).text();
  cal = new Function(`${lift('tripCal')}; return tripCal;`)() as TripCal;
});

const leg = (date: string, category = 'transfer'): Leg => ({ date, category, stops: ['A', 'B'] });

describe('tripCal.model', () => {
  it('computes the span, driving legs and charged idle over a normal itinerary', () => {
    const m = cal.model([leg('2026-08-12'), leg('2026-08-13'), leg('2026-08-15'), leg('2026-08-17')])!;
    expect(m.start).toBe('2026-08-12');
    expect(m.end).toBe('2026-08-17');
    expect(m.span).toBe(6);
    expect(m.drivingLegs).toBe(4);
    expect(m.chargedIdle).toBe(2);
    expect(Object.keys(m.byDay).map(Number).sort((a, b) => a - b)).toEqual([1, 2, 4, 6]);
    expect(m.undated).toBe(0);
  });

  it('a stay day joins the span but is not a driving leg — engine semantics', () => {
    const m = cal.model([leg('2026-08-12'), leg('2026-08-13', 'stay_day'), leg('2026-08-14')])!;
    expect(m.span).toBe(3);
    expect(m.drivingLegs).toBe(2);
    expect(m.chargedIdle).toBe(1); // span − driving LEGS, exactly as chauffeur.ts counts it
  });

  it('returns null with nothing dated, and counts undated legs otherwise', () => {
    expect(cal.model([leg(''), leg('')])).toBeNull();
    const m = cal.model([leg('2026-08-12'), leg('')])!;
    expect(m.span).toBe(1);
    expect(m.undated).toBe(1);
  });

  it('two driving legs on one day: span 1, idle floored at 0', () => {
    const m = cal.model([leg('2026-08-12'), leg('2026-08-12')])!;
    expect(m.span).toBe(1);
    expect(m.chargedIdle).toBe(0);
  });
});

describe('tripCal.warning — the month-typo net', () => {
  it('stays quiet on a plausible multi-day tour', () => {
    expect(cal.warning(cal.model([leg('2026-08-12'), leg('2026-08-13'), leg('2026-08-15'), leg('2026-08-17')]))).toBeNull();
  });

  it('a genuine long tour (10 driving days over 12) is not nagged', () => {
    const legs = Array.from({ length: 10 }, (_, i) => leg(cal.addDays('2026-08-01', i + (i > 4 ? 2 : 0))));
    expect(cal.warning(cal.model(legs))).toBeNull();
  });

  it('flags a fat-fingered month and names the gap', () => {
    const m = cal.model([leg('2026-08-12'), leg('2026-08-13'), leg('2026-09-14'), leg('2026-09-15')])!;
    const w = cal.warning(m, true)!;
    expect(w).toContain('35-day span');
    expect(w).toContain('31 idle days will be charged');
    // A point-to-point trip must not be told about a charge the engine won't make.
    expect(cal.warning(m, false)).toContain('31 idle days in between');
    expect(cal.warning(m, false)).not.toContain('charged');
    const gap = cal.biggestGap(m)!;
    expect(gap.days).toBe(31);
    expect(gap.fromDay).toBe(3);
  });

  it('flags idle-heavy shapes even inside two weeks', () => {
    // 2 driving legs across 9 days: 7 idle > 2 driving + 2.
    expect(cal.warning(cal.model([leg('2026-08-12'), leg('2026-08-20')]))).toContain('9-day span');
  });

  it('never warns about a single day — that is the point-to-point note, not a warning', () => {
    expect(cal.warning(cal.model([leg('2026-08-12'), leg('2026-08-12')]))).toBeNull();
  });
});

describe('tripCal.addDays', () => {
  it('crosses month ends and years without drifting', () => {
    expect(cal.addDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(cal.addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(cal.addDays('2026-09-01', -1)).toBe('2026-08-31');
    expect(cal.addDays('2028-02-28', 1)).toBe('2028-02-29'); // leap year
  });
  it('returns empty for an unparseable base', () => {
    expect(cal.addDays('', 1)).toBe('');
    expect(cal.addDays('not-a-date', 1)).toBe('');
  });
});

// The drift guard. tripCal's summary is only trustworthy if it counts days the way the
// engine prices them; if chauffeur.ts's model ever changes, this is the test that goes red.
describe('tripCal mirrors quoteChauffeur', () => {
  const cases: Leg[][] = [
    [leg('2026-08-12'), leg('2026-08-13'), leg('2026-08-15'), leg('2026-08-17')],
    [leg('2026-08-12'), leg('2026-08-13', 'stay_day'), leg('2026-08-14')],
    [leg('2026-08-12'), leg('2026-08-13'), leg('2026-09-14'), leg('2026-09-15')], // the typo
    [leg('2026-08-12'), leg('2026-08-12'), leg('2026-08-13')], // two legs one day
  ];
  it('span and charged idle equal the engine’s days and idleDays for every shape', () => {
    for (const legs of cases) {
      const m = cal.model(legs)!;
      const travelDays = legs
        .filter((l) => l.category !== 'stay_day')
        .map((l) => normalizeChauffeurDay({ date: l.date, from: 'Colombo City', to: 'Kandy', distanceKm: 100 }));
      const engine = quoteChauffeur({ vehicle: 'car', firstDate: m.start, lastDate: m.end, travelDays });
      expect(m.span, `span for ${legs.map((l) => l.date)}`).toBe(engine.meta.days);
      expect(m.chargedIdle, `idle for ${legs.map((l) => l.date)}`).toBe(engine.meta.idleDays);
    }
  });
});

describe('the ops shell wires the calendar up', () => {
  it('keeps the native date input alongside the new steppers and chips', () => {
    expect(body).toContain('data-field="date"');
    expect(body).toContain('data-action="stepDate"');
    expect(body).toContain('data-action="setDateRel"');
    expect(body).toContain('id="trip-cal"');
  });
  it('steppers clamp both ways — the messages that prove the guards exist', () => {
    expect(body).toContain('This leg can’t start before the leg above it');
    expect(body).toContain('— move that one first');
  });
  it('the strip states the point-to-point revert instead of leaving it silent', () => {
    expect(body).toContain('priced point-to-point, no chauffeur day rate');
  });
});
