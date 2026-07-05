import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { FakeAlertAdapter, ThrottledAlerts } from '../adapters/alerts';
import { InMemoryAlertLogRepo } from '../db/alertLogRepo';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { signBookingToken } from '../lib/bookingToken';

// M17: an unhandled route error still returns the same generic 500, but now also raises
// a throttled critical alert (and reports to Sentry when configured — covered in track.test).
//
// Booking-access-selfservice Task 2 removed the open GET /bookings/:id (replaced by the
// tokenized GET /bookings/view). These tests used GET /:id purely as a route that calls
// bookings.get() so a throwing repo triggers app.onError — repointed at /bookings/view
// with a validly-signed token so they still exercise the same onError path.
const SECRET = 'dev-booking-link-secret-change-me';

describe('app.onError alerting', () => {
  const throwingBookings = (): InMemoryBookingRepo => {
    const repo = new InMemoryBookingRepo();
    repo.get = async () => {
      throw new Error('db exploded');
    };
    return repo;
  };

  // POST /bookings/:id/checkout also calls bookings.get() first, and — unlike
  // /bookings/view?t=... — keeps the varying part IN the path itself (c.req.path strips
  // query strings), so it's the route that can actually demonstrate distinct-path dedupe keys.
  const checkout = (app: ReturnType<typeof createApp>, id: string) =>
    app.request(`/bookings/${id}/checkout`, { method: 'POST' });

  it('returns the unchanged 500 body and sends one critical alert', async () => {
    const inner = new FakeAlertAdapter();
    const app = createApp({
      bookings: throwingBookings(),
      alerts: new ThrottledAlerts(inner, new InMemoryAlertLogRepo()),
    });
    const res = await app.request(`/bookings/view?t=${signBookingToken('some-id', SECRET)}`);
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
    await checkout(app, 'a');
    await checkout(app, 'b'); // same route pattern, same error name, different concrete path → separate key
    await checkout(app, 'a'); // identical path repeat
    // /bookings/a/checkout and /bookings/b/checkout are different concrete paths → 2 keys; the repeat of /a is suppressed.
    expect(inner.sent).toHaveLength(2);
  });

  it('a failing alert adapter never changes the API response', async () => {
    const boom = { send: async () => { throw new Error('alert channel down'); } };
    const app = createApp({
      bookings: throwingBookings(),
      alerts: new ThrottledAlerts(boom, new InMemoryAlertLogRepo()),
    });
    const res = await app.request(`/bookings/view?t=${signBookingToken('some-id', SECRET)}`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal_error' });
  });
});
