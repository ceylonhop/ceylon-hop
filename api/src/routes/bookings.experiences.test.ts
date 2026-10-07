import { describe, it, expect, vi, afterEach } from 'vitest';
import { createApp } from '../app';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryExperienceRepo } from '../db/experienceRepo';
import { InMemoryExperienceInterestRepo, type ExperienceInterestRepo } from '../db/experienceInterestRepo';
import { PLACEHOLDERS } from '../experiences/placeholders';
import { isoToday } from '../domain/dateRules';

// Partner experiences on the booking write (spec 2026-10-06 D10/D11/D17). The browser sends uuids
// only; a malformed list never costs a booking; every label ops sees is the server's.
const customer = { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' };
const single = { from: 'Colombo Airport', to: 'Sigiriya / Dambulla', vehicleType: 'car', adults: 2, children: 0, bags: 2, customer };
const trip = { stops: ['Colombo Airport (CMB)', 'Galle'], nights: [0, 0], pax: 2, vehicleType: 'car', serviceType: 'private', customer };

function futureServiceDay(): string {
  for (let i = 14; i < 60; i++) {
    const iso = isoToday('Asia/Colombo', new Date(Date.now() + i * 86_400_000));
    const wd = new Date(`${iso}T00:00:00Z`).getUTCDay();
    if (wd === 3 || wd === 6) return iso;
  }
  throw new Error('no service day found');
}
const shared = () => ({ from: 'Negombo', to: 'Sigiriya / Dambulla', date: futureServiceDay(), time: '07:30', seats: 2, customer });

const MODES: Array<[string, string, () => Record<string, unknown>]> = [
  ['single', '/bookings/single', () => single],
  ['trip', '/bookings/trip', () => trip],
  ['shared', '/bookings/shared', shared],
];

async function setup(interestRepo?: (base: InMemoryExperienceInterestRepo) => ExperienceInterestRepo) {
  const bookings = new InMemoryBookingRepo();
  const experiences = new InMemoryExperienceRepo();
  const [massage, cooking, safari] = await Promise.all(PLACEHOLDERS.map((p) => experiences.create(p)));
  const retired = await experiences.create({ ...PLACEHOLDERS[0], slug: 'retired-one', active: false });
  const base = new InMemoryExperienceInterestRepo({ bookings, experiences });
  const experienceInterests = interestRepo ? interestRepo(base) : base;
  const app = createApp({ bookings, experiences, experienceInterests });
  const send = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { app, send, experiences, experienceInterests, massage, cooking, safari, retired };
}

afterEach(() => vi.restoreAllMocks());

describe.each(MODES)('experienceIds on %s bookings', (_name, path, body) => {
  it('records one interest per id, snapshotted from the catalogue, source booking_page', async () => {
    const t = await setup();
    const res = await t.send(path, { ...body(), experienceIds: [t.massage.id, t.safari.id] });
    expect(res.status).toBe(201);
    const booking = await res.json();
    const rows = await t.experienceInterests.listForBooking(booking.id);
    expect(rows.map((r) => r.experienceId).sort()).toEqual([t.massage.id, t.safari.id].sort());
    const m = rows.find((r) => r.experienceId === t.massage.id)!;
    expect(m).toMatchObject({ source: 'booking_page', status: 'new', nameSnapshot: 'Ayurvedic massage', priceCentsSnapshot: 3500, priceUnitSnapshot: 'per_person' });
  });

  it('drops unknown, inactive and malformed ids and still creates the booking', async () => {
    const t = await setup();
    const res = await t.send(path, {
      ...body(), experienceIds: [t.retired.id, '3f1c2d4e-0000-4000-8000-000000000000', 'not-a-uuid', 42, null, t.cooking.id],
    });
    expect(res.status).toBe(201);
    const rows = await t.experienceInterests.listForBooking((await res.json()).id);
    expect(rows.map((r) => r.experienceId)).toEqual([t.cooking.id]);
  });

  it('dedupes repeated ids', async () => {
    const t = await setup();
    const res = await t.send(path, { ...body(), experienceIds: [t.massage.id, t.massage.id.toUpperCase(), t.massage.id] });
    expect(res.status).toBe(201);
    expect(await t.experienceInterests.listForBooking((await res.json()).id)).toHaveLength(1);
  });

  it('ignores a list that is not an array (never a 400)', async () => {
    const t = await setup();
    for (const experienceIds of ['x', 7, { a: 1 }, true]) {
      const res = await t.send(path, { ...body(), experienceIds });
      expect(res.status).toBe(201);
      expect(await t.experienceInterests.listForBooking((await res.json()).id)).toHaveLength(0);
    }
  });

  it('a repository that throws still gives 201, and logs', async () => {
    class Throwing extends InMemoryExperienceInterestRepo {
      async record(): Promise<never> { throw new Error('db down'); }
    }
    const t = await setup((base) => Object.assign(new Throwing(), base));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await t.send(path, { ...body(), experienceIds: [t.massage.id] });
    expect(res.status).toBe(201);
    expect(err).toHaveBeenCalled();
  });

  it('replaying the idempotency key does not duplicate the interest', async () => {
    const t = await setup();
    const headers = { 'Idempotency-Key': `idem-${_name}-experiences` };
    const first = await t.send(path, { ...body(), experienceIds: [t.massage.id] }, headers);
    const again = await t.send(path, { ...body(), experienceIds: [t.massage.id] }, headers);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    const id = (await first.json()).id;
    expect(await t.experienceInterests.listForBooking(id)).toHaveLength(1);
  });

  it('stores nothing a body label says — only the server snapshot', async () => {
    const t = await setup();
    const res = await t.send(path, {
      ...body(), experienceIds: [t.massage.id],
      experienceNames: ['<script>alert(1)</script>'], experienceLabels: { [t.massage.id]: '<img src=x onerror=1>' },
    });
    expect(res.status).toBe(201);
    const rows = await t.experienceInterests.listForBooking((await res.json()).id);
    expect(JSON.stringify(rows)).not.toContain('<');
    expect(rows[0].nameSnapshot).toBe('Ayurvedic massage');
  });

  it('keeps at most the first 10 ids', async () => {
    const t = await setup();
    const many: string[] = [];
    for (let i = 0; i < 12; i++) {
      many.push((await t.experiences.create({ ...PLACEHOLDERS[0], slug: `extra-${i}`, name: `Extra ${i}` })).id);
    }
    const res = await t.send(path, { ...body(), experienceIds: many });
    expect(res.status).toBe(201);
    const kept = (await t.experienceInterests.listForBooking((await res.json()).id)).map((r) => r.experienceId);
    expect(kept.sort()).toEqual(many.slice(0, 10).sort());
  });
});

describe('no experience repos wired', () => {
  it('a booking with experienceIds still works and records nothing', async () => {
    const app = createApp({ bookings: new InMemoryBookingRepo() });
    const res = await app.request('/bookings/single', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...single, experienceIds: ['3f1c2d4e-0000-4000-8000-000000000000'] }),
    });
    expect(res.status).toBe(201);
  });
});
