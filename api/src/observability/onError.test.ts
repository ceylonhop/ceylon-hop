import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { FakeAlertAdapter, ThrottledAlerts } from '../adapters/alerts';
import { InMemoryAlertLogRepo } from '../db/alertLogRepo';
import { InMemoryBookingRepo } from '../db/bookingRepo';

// M17: an unhandled route error still returns the same generic 500, but now also raises
// a throttled critical alert (and reports to Sentry when configured — covered in track.test).
describe('app.onError alerting', () => {
  const throwingBookings = (): InMemoryBookingRepo => {
    const repo = new InMemoryBookingRepo();
    repo.get = async () => {
      throw new Error('db exploded');
    };
    return repo;
  };

  it('returns the unchanged 500 body and sends one critical alert', async () => {
    const inner = new FakeAlertAdapter();
    const app = createApp({
      bookings: throwingBookings(),
      alerts: new ThrottledAlerts(inner, new InMemoryAlertLogRepo()),
    });
    const res = await app.request('/bookings/some-id');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal_error' });
    expect(inner.sent).toHaveLength(1);
    expect(inner.sent[0].severity).toBe('critical');
    expect(inner.sent[0].kind).toBe('api_error');
    expect(inner.sent[0].body).toContain('db exploded');
  });

  it('throttles repeats of the same error on the same route', async () => {
    const inner = new FakeAlertAdapter();
    const app = createApp({
      bookings: throwingBookings(),
      alerts: new ThrottledAlerts(inner, new InMemoryAlertLogRepo()),
    });
    await app.request('/bookings/a');
    await app.request('/bookings/b'); // same route pattern, same error name → same dedupe key path? (path differs)
    await app.request('/bookings/a'); // identical path repeat
    // /bookings/a and /bookings/b are different concrete paths → 2 keys; the repeat of /a is suppressed.
    expect(inner.sent).toHaveLength(2);
  });

  it('a failing alert adapter never changes the API response', async () => {
    const boom = { send: async () => { throw new Error('alert channel down'); } };
    const app = createApp({
      bookings: throwingBookings(),
      alerts: new ThrottledAlerts(boom, new InMemoryAlertLogRepo()),
    });
    const res = await app.request('/bookings/some-id');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal_error' });
  });
});
