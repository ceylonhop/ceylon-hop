import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../');
const require = createRequire(import.meta.url);
const {
  formatRouteEstimate,
  isMaterialRouteChange,
  roundDistanceKm,
  roundDurationMin,
} = require(path.join(ROOT, 'route-estimate.js'));

describe('customer route-estimate rounding', () => {
  it('rounds short distances to 1 km and longer distances to 5 km', () => {
    expect(roundDistanceKm(7.4)).toBe(7);
    expect(roundDistanceKm(19.6)).toBe(20);
    expect(roundDistanceKm(22)).toBe(20);
    expect(roundDistanceKm(338)).toBe(340);
  });

  it('rounds duration by the public precision bands', () => {
    expect(roundDurationMin(18)).toBe(20);
    expect(roundDurationMin(59)).toBe(60);
    expect(roundDurationMin(68)).toBe(75);
    expect(roundDurationMin(239)).toBe(240);
    expect(roundDurationMin(297)).toBe(300);
    expect(roundDurationMin(322)).toBe(330);
  });

  it('does not expose minute-level false precision for long journeys', () => {
    expect(formatRouteEstimate({ distanceKm: 335, durationMin: 297, state: 'browse' }))
      .toBe('Approx. 335 km · around 5 hours');
    expect(formatRouteEstimate({ distanceKm: 338, durationMin: 322, state: 'browse' }))
      .toBe('Approx. 340 km · around 5½ hours');
  });
});

describe('customer route-estimate states', () => {
  it('explains a material exact-location update', () => {
    expect(formatRouteEstimate({ distanceKm: 338, durationMin: 322, state: 'exact' }))
      .toBe('Updated for your pickup and destination: approx. 340 km · around 5½ hours');
  });

  it('labels fallback figures as estimated', () => {
    expect(formatRouteEstimate({ distanceKm: 118, durationMin: 177, state: 'estimated' }))
      .toBe('Estimated journey — approx. 120 km · around 3 hours. Final route confirmed before payment.');
    expect(formatRouteEstimate({ state: 'estimated' }))
      .toBe('Estimated journey — final route confirmed before payment');
  });

  it('uses an explanatory unavailable state instead of placeholders', () => {
    expect(formatRouteEstimate({ state: 'unavailable' }))
      .toBe('We’ll confirm the journey time after reviewing your locations.');
    expect(formatRouteEstimate({ distanceKm: NaN, durationMin: -1, state: 'browse' }))
      .toBe('We’ll confirm the journey time after reviewing your locations.');
  });

  it('keeps partial safe information rather than inventing the missing half', () => {
    expect(formatRouteEstimate({ distanceKm: 41, state: 'browse' })).toBe('Approx. 40 km');
    expect(formatRouteEstimate({ durationMin: 58, state: 'browse' })).toBe('Around 60 minutes');
  });
});

describe('material route changes', () => {
  it('treats a 5 km or 15 minute raw change as material', () => {
    const original = { distanceKm: 100, durationMin: 120 };
    expect(isMaterialRouteChange(original, { distanceKm: 105, durationMin: 120 })).toBe(true);
    expect(isMaterialRouteChange(original, { distanceKm: 100, durationMin: 135 })).toBe(true);
  });

  it('does not interrupt the customer for smaller changes', () => {
    const original = { distanceKm: 100, durationMin: 120 };
    expect(isMaterialRouteChange(original, { distanceKm: 104.9, durationMin: 134.9 })).toBe(false);
  });

  it('treats a newly available or removed valid estimate as material', () => {
    expect(isMaterialRouteChange(null, { distanceKm: 100, durationMin: 120 })).toBe(true);
    expect(isMaterialRouteChange({ distanceKm: 100, durationMin: 120 }, null)).toBe(true);
    expect(isMaterialRouteChange(null, null)).toBe(false);
  });
});

describe('browser contract', () => {
  it('publishes the formatter on the shared CH namespace', () => {
    const published = globalThis.CH && globalThis.CH.routeEstimate;
    expect(published).toBeTruthy();
    expect(published.formatRouteEstimate).toBe(formatRouteEstimate);
  });
});
