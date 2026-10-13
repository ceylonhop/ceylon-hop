import { describe, it, expect } from 'vitest';
import { createApp as realCreateApp } from '../app';
import { InMemoryExperienceRepo } from '../db/experienceRepo';
import { InMemoryExperienceInterestRepo } from '../db/experienceInterestRepo';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { signSession } from '../lib/opsAuth';

const AUTH = { opsUsers: 'f@x.com:founder,op@x.com:ops,fin@x.com:finance', googleClientId: 'cid', opsSessionSecret: 'sek' };
const cookie = (email: string) => `ch_ops=${signSession({ email, exp: Date.now() + 60_000 }, AUTH.opsSessionSecret)}`;
const FOUNDER = cookie('f@x.com');
const OPS = cookie('op@x.com');
const FINANCE = cookie('fin@x.com');

const BODY = {
  slug: 'ayurveda-massage', name: 'Ayurvedic massage', partnerName: 'Atherya Spa', areaLabel: 'Sigiriya',
  summary: 'A 90-minute massage', details: 'Oils, herbal steam.', priceCents: 3500, priceUnit: 'per_person',
  durationText: '90 min', openWeekdays: [1, 2, 3], startTimes: ['09:00', '14:00'], lat: 7.977, lng: 80.76,
  radiusKm: 5, photos: ['guides/sigiriya/ayurveda'], partnerContact: '+94 77 000 0000', active: true,
};

function setup() {
  const experiences = new InMemoryExperienceRepo();
  const interests = new InMemoryExperienceInterestRepo();
  const a = realCreateApp({ auth: AUTH, adminApiKey: 'k', experiences, experienceInterests: interests });
  const send = (method: string, path: string, body?: unknown, ck: string | null = FOUNDER, extra: Record<string, string> = {}) =>
    a.request(path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(ck ? { cookie: ck } : {}), ...extra },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return { a, experiences, interests, send };
}

describe('GET/POST/PATCH /admin/experiences', () => {
  it('401 without a session', async () => {
    const { send } = setup();
    expect((await send('GET', '/admin/experiences', undefined, null)).status).toBe(401);
    expect((await send('POST', '/admin/experiences', BODY, null)).status).toBe(401);
  });

  it('finance is 403 on the catalogue (read and write)', async () => {
    const { send } = setup();
    expect((await send('GET', '/admin/experiences', undefined, FINANCE)).status).toBe(403);
    expect((await send('POST', '/admin/experiences', BODY, FINANCE)).status).toBe(403);
  });

  it('ops can create; createdBy is the identity email; the list returns experiences and stats', async () => {
    const { send } = setup();
    const res = await send('POST', '/admin/experiences', BODY, OPS);
    expect(res.status).toBe(201);
    const { experience } = await res.json();
    expect(experience).toMatchObject({ slug: 'ayurveda-massage', currency: 'USD', createdBy: 'op@x.com', partnerContact: '+94 77 000 0000' });
    expect(typeof experience.createdAt).toBe('string');
    const list = await (await send('GET', '/admin/experiences', undefined, OPS)).json();
    expect(list.experiences).toHaveLength(1);
    expect(list.stats).toEqual([]);
  });

  it('a cross-site write is 403 bad_origin', async () => {
    const { send } = setup();
    const res = await send('POST', '/admin/experiences', BODY, FOUNDER, { 'sec-fetch-site': 'cross-site' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'bad_origin' });
    expect((await send('POST', '/admin/experiences', BODY, FOUNDER, { 'sec-fetch-site': 'same-origin' })).status).toBe(201);
  });

  it('a bad body is 400 with issues', async () => {
    const { send } = setup();
    const res = await send('POST', '/admin/experiences', { ...BODY, lat: 51.5 });
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toBe('bad_request');
    expect(j.issues.length).toBeGreaterThan(0);
    expect((await send('POST', '/admin/experiences', { ...BODY, bogus: 1 })).status).toBe(400);
  });

  it('a duplicate slug is 409 slug_taken on create and on patch', async () => {
    const { send } = setup();
    await send('POST', '/admin/experiences', BODY);
    const dup = await send('POST', '/admin/experiences', BODY);
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({ error: 'slug_taken' });
    const other = (await (await send('POST', '/admin/experiences', { ...BODY, slug: 'other-one' })).json()).experience;
    const p = await send('PATCH', `/admin/experiences/${other.id}`, { slug: 'ayurveda-massage' });
    expect(p.status).toBe(409);
  });

  it('a partial PATCH changes only what it names', async () => {
    const { send } = setup();
    const created = (await (await send('POST', '/admin/experiences', BODY)).json()).experience;
    const res = await send('PATCH', `/admin/experiences/${created.id}`, { active: false }, OPS);
    expect(res.status).toBe(200);
    const { experience } = await res.json();
    expect(experience.active).toBe(false);
    expect(experience).toMatchObject({
      radiusKm: 5, photos: ['guides/sigiriya/ayurveda'], details: 'Oils, herbal steam.', startTimes: ['09:00', '14:00'],
      partnerContact: '+94 77 000 0000', updatedBy: 'op@x.com',
    });
  });

  it('PATCH: unknown id is 404, a bad body is 400', async () => {
    const { send } = setup();
    expect((await send('PATCH', '/admin/experiences/00000000-0000-4000-8000-000000000000', { active: false })).status).toBe(404);
    const created = (await (await send('POST', '/admin/experiences', BODY)).json()).experience;
    expect((await send('PATCH', `/admin/experiences/${created.id}`, { priceCents: -1 })).status).toBe(400);
  });
});

describe('leads', () => {
  async function withLead() {
    const s = setup();
    const created = await s.experiences.create({ ...BODY, createdBy: 'seed' } as never);
    const lead = await s.interests.record({ experience: created, source: 'booking_page', bookingId: 'b-1' });
    return { ...s, lead };
  }

  it('GET /leads needs experiences:manage and returns { leads }', async () => {
    const { send } = await withLead();
    expect((await send('GET', '/admin/experiences/leads', undefined, FINANCE)).status).toBe(403);
    const res = await send('GET', '/admin/experiences/leads?limit=5', undefined, OPS);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ leads: [] }); // no booking repo behind the fake: nothing is a "real" lead
  });

  it('GET /leads returns a lead on a paid booking', async () => {
    const experiences = new InMemoryExperienceRepo();
    const bookings = new InMemoryBookingRepo();
    const interests = new InMemoryExperienceInterestRepo({ bookings, experiences });
    const a = realCreateApp({ auth: AUTH, adminApiKey: 'k', experiences, experienceInterests: interests, bookings });
    const e = await experiences.create({ ...BODY, createdBy: 'seed' } as never);
    const b = await bookings.create({
      mode: 'single', total: 5000, amountDueNow: 5000, currency: 'USD',
      input: { from: 'Colombo Airport', to: 'Sigiriya', vehicleType: 'car', adults: 2, children: 0, bags: 2, customer: { firstName: 'Maya', lastName: 'Silva', email: 'm@x.com', whatsapp: '+34600000000', country: 'Spain' } },
    });
    await bookings.setStatus(b.id, 'payment_pending');
    await bookings.setStatus(b.id, 'paid');
    await interests.record({ experience: e, source: 'booking_page', bookingId: b.id });
    const res = await a.request('/admin/experiences/leads', { headers: { cookie: FOUNDER } });
    const { leads } = await res.json();
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ customerName: 'Maya Silva', reference: b.reference, areaLabel: 'Sigiriya' });
  });

  it('PATCH lead to paid without a ref is 400; with a ref it is 200', async () => {
    const { send, lead } = await withLead();
    const bad = await send('PATCH', `/admin/experiences/leads/${lead.id}`, { status: 'paid' }, OPS);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'paid_requires_ref' });
    const ok = await send('PATCH', `/admin/experiences/leads/${lead.id}`,
      { status: 'paid', paymentRef: 'PH-123', amountPaidCents: 3500, amountPaidCurrency: 'USD' }, OPS);
    expect(ok.status).toBe(200);
    expect((await ok.json()).lead).toMatchObject({ status: 'paid', paymentRef: 'PH-123', updatedBy: 'op@x.com' });
  });

  it('PATCH lead to paid is fine when a ref is already stored; a status-only patch keeps it', async () => {
    const { send, lead } = await withLead();
    await send('PATCH', `/admin/experiences/leads/${lead.id}`, { status: 'link_sent', paymentRef: 'PH-9' });
    const res = await send('PATCH', `/admin/experiences/leads/${lead.id}`, { status: 'paid' });
    expect(res.status).toBe(200);
    expect((await res.json()).lead.paymentRef).toBe('PH-9');
  });

  it('PATCH lead: finance 403, unknown 404, bad body 400, cross-site 403', async () => {
    const { send, lead } = await withLead();
    expect((await send('PATCH', `/admin/experiences/leads/${lead.id}`, { status: 'contacted' }, FINANCE)).status).toBe(403);
    expect((await send('PATCH', '/admin/experiences/leads/00000000-0000-4000-8000-000000000000', { status: 'contacted' })).status).toBe(404);
    expect((await send('PATCH', `/admin/experiences/leads/${lead.id}`, { status: 'nope' })).status).toBe(400);
    expect((await send('PATCH', `/admin/experiences/leads/${lead.id}`, { status: 'contacted' }, FOUNDER, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
  });
});
