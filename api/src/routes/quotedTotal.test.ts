import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { InMemoryConciergeTaskRepo } from '../db/conciergeTaskRepo';
import { isoToday, isoWeekday } from '../domain/dateRules';

// The next shared service day (Wed/Sat) a few days out — dodges both the past-date guard and
// the not-a-service-day guard whenever the suite runs. Computed, so it never rots.
const SOON = (() => {
  for (let i = 1; i <= 14; i++) {
    const iso = isoToday('UTC', new Date(Date.now() + i * 86_400_000));
    if ([3, 6].includes(isoWeekday(iso)!)) return iso;
  }
  /* istanbul ignore next */ throw new Error('no service day within two weeks');
})();

const customer = {
  firstName: 'Maya',
  lastName: 'Silva',
  email: 'maya@example.com',
  whatsapp: '+34600000000',
  country: 'Spain',
};
const single = { from: 'A', to: 'B', vehicleType: 'car', adults: 1, children: 0, bags: 0, customer };
// Resolvable by the fake maps adapter → the engine prices it: CMB→Galle km 180 →
// billable 198 → car round(198×35) = 6930.
const knownSingle = { ...single, from: 'Colombo Airport (CMB)', to: 'Galle' };

function post(app: ReturnType<typeof createApp>, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function appWithTasks() {
  const conciergeTasks = new InMemoryConciergeTaskRepo();
  return { app: createApp({ conciergeTasks }), conciergeTasks };
}

// GL-3 — the engine is the pricing truth. The client's quotedTotal is only a fallback
// when the engine can't price, and a mismatch with the engine is flagged for ops.
describe('engine-authoritative totals (quotedTotal no longer trusted)', () => {
  it('stores the engine price, ignoring a divergent quotedTotal, and files a mismatch task', async () => {
    const { app, conciergeTasks } = appWithTasks();
    const r = await post(app, '/bookings/single', { ...knownSingle, quotedTotal: 9000 });
    expect(r.status).toBe(201);
    const b = await r.json();
    expect(b.total).toBe(7970); // engine wins
    expect(b.amountDueNow).toBe(7970);
    const tasks = await conciergeTasks.listByBooking(b.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].type).toBe('follow_up');
    expect(tasks[0].note).toBe(`price mismatch ${b.reference}: site quoted 9000¢, engine priced 7970¢`);
  });

  it('does not flag a quotedTotal within $1 of the engine price', async () => {
    const { app, conciergeTasks } = appWithTasks();
    const b = await (await post(app, '/bookings/single', { ...knownSingle, quotedTotal: 7965 })).json();
    expect(b.total).toBe(7970);
    expect(await conciergeTasks.listByBooking(b.id)).toHaveLength(0);
  });

  it('falls back to the quotedTotal when the distance is unresolvable, flagged for ops', async () => {
    const { app, conciergeTasks } = appWithTasks();
    const r = await post(app, '/bookings/single', { ...single, quotedTotal: 7000 });
    expect(r.status).toBe(201);
    const b = await r.json();
    expect(b.total).toBe(7000);
    expect(b.amountDueNow).toBe(7000);
    const tasks = await conciergeTasks.listByBooking(b.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].note).toBe('unpriced booking — distance unresolved, verify price');
  });

  it('falls back to the placeholder quote when unpriced and no quotedTotal (API-only callers)', async () => {
    const r = await post(createApp(), '/bookings/single', single);
    expect((await r.json()).total).toBe(4000); // stub: 1 adult, car
  });

  it('rejects an out-of-bounds quoted total (tampering guard)', async () => {
    const r = await post(createApp(), '/bookings/single', { ...single, quotedTotal: 5 }); // < $1
    expect(r.status).toBe(400);
  });

  it('a chauffeur trip falling back to quotedTotal still collects the full amount now', async () => {
    const { app } = appWithTasks();
    const r = await post(app, '/bookings/trip', {
      stops: ['Nowhere', 'Elsewhere'], // unresolvable → quotedTotal fallback
      nights: [0, 0],
      pax: 2,
      vehicleType: 'car',
      serviceType: 'chauffeur',
      quotedTotal: 40000,
      customer,
    });
    expect(r.status).toBe(201);
    const b = await r.json();
    expect(b.total).toBe(40000);
    expect(b.amountDueNow).toBe(40000);
  });

  it('shared seats always store the server corridor price; a divergent quotedTotal is flagged', async () => {
    const { app, conciergeTasks } = appWithTasks();
    const r = await post(app, '/bookings/shared', {
      corridorId: 'hill-line',
      date: SOON,
      time: '08:00',
      seats: 2,
      quotedTotal: 9000,
      customer,
    });
    expect(r.status).toBe(201);
    const b = await r.json();
    expect(b.total).toBe(4200); // 2 × $21 (hill-line) — never the client's 9000
    expect(b.amountDueNow).toBe(4200);
    const tasks = await conciergeTasks.listByBooking(b.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].note).toBe(`price mismatch ${b.reference}: site quoted 9000¢, engine priced 4200¢`);
  });
});
