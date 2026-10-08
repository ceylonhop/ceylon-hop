import { describe, it, expect } from 'vitest';
import { createApp as realCreateApp } from '../app';
import { InMemoryExperienceRepo } from '../db/experienceRepo';
import { InMemoryExperienceInterestRepo } from '../db/experienceInterestRepo';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryQuoteRepo } from '../db/quoteRepo';
import { FakeEmailAdapter, type EmailAdapter } from '../adapters/email';
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

// ── Confirmation email (spec 2026-10-06 D21) ────────────────────────────────
describe('lead schedule and confirmation email', () => {
  const customer = { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' };
  async function confirmSetup(opts: { email?: EmailAdapter } = {}) {
    const experiences = new InMemoryExperienceRepo();
    const bookings = new InMemoryBookingRepo();
    const quotes = new InMemoryQuoteRepo();
    const interests = new InMemoryExperienceInterestRepo({ bookings, quotes, experiences });
    const fake = new FakeEmailAdapter();
    const a = realCreateApp({
      auth: AUTH, adminApiKey: 'k', experiences, experienceInterests: interests, bookings, quotes,
      email: opts.email ?? fake, emailPolicy: { enabled: true },
    });
    const send = (method: string, path: string, body?: unknown, ck: string | null = OPS, extra: Record<string, string> = {}) =>
      a.request(path, {
        method,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(ck ? { cookie: ck } : {}), ...extra },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    const exp = await experiences.create({ ...BODY, createdBy: 'seed' } as never);
    const paidBooking = async (cust: typeof customer = customer) => {
      const b = await bookings.create({
        mode: 'single', total: 5000, amountDueNow: 5000, currency: 'USD',
        input: { from: 'Colombo Airport', to: 'Sigiriya', vehicleType: 'car', adults: 2, children: 0, bags: 2, customer: cust },
      });
      await bookings.setStatus(b.id, 'payment_pending');
      await bookings.setStatus(b.id, 'paid');
      return b;
    };
    const quoteLead = async (contact: string | null) => {
      const q = await quotes.save({
        product: 'private', vehicle: 'car', customerName: 'Luca Rossi', customerContact: contact, totalCents: 4048, currency: 'USD',
        rateCardVersion: '2026-06-28', marginCents: 900, request: { tool: { legs: [] } }, result: { totalCents: 4048 },
      });
      await quotes.patch(q.id, { status: 'sent' });
      return { q, i: await interests.record({ experience: exp, source: 'quote_page', quoteId: q.id }) };
    };
    const paid = async (id: string, extra: Record<string, unknown> = {}) =>
      (await send('PATCH', `/admin/experiences/leads/${id}`, { status: 'paid', paymentRef: 'PH-123', amountPaidCents: 3500, amountPaidCurrency: 'USD', ...extra })).json();
    const SCHEDULE = { scheduledDate: '2026-11-21', scheduledTime: '09:30', meetingPoint: 'Hotel lobby' };
    return { a, send, fake, exp, experiences, interests, bookings, quotes, paidBooking, quoteLead, paid, SCHEDULE };
  }
  const conf = (id: string) => `/admin/experiences/leads/${id}/confirmation`;

  describe('PATCH accepts the schedule', () => {
    it('stores date, time and meeting point; a partial patch keeps them', async () => {
      const s = await confirmSetup();
      const i = await s.interests.record({ experience: s.exp, source: 'booking_page', bookingId: (await s.paidBooking()).id });
      const res = await s.send('PATCH', `/admin/experiences/leads/${i.id}`, s.SCHEDULE);
      expect(res.status).toBe(200);
      expect((await res.json()).lead).toMatchObject(s.SCHEDULE);
      const again = await s.send('PATCH', `/admin/experiences/leads/${i.id}`, { opsNote: 'x' });
      expect((await again.json()).lead).toMatchObject(s.SCHEDULE);
      const cleared = await s.send('PATCH', `/admin/experiences/leads/${i.id}`, { meetingPoint: null });
      expect((await cleared.json()).lead).toMatchObject({ scheduledDate: '2026-11-21', meetingPoint: null });
    });
    it.each([
      ['a malformed date', { scheduledDate: '21/11/2026' }],
      ['an impossible date', { scheduledDate: '2026-02-30' }],
      ['a malformed time', { scheduledTime: '9:30' }],
      ['an out-of-range time', { scheduledTime: '24:00' }],
      ['a meeting point over 200 characters', { meetingPoint: 'x'.repeat(201) }],
    ])('rejects %s with 400', async (_name, body) => {
      const s = await confirmSetup();
      const i = await s.interests.record({ experience: s.exp, source: 'booking_page', bookingId: (await s.paidBooking()).id });
      expect((await s.send('PATCH', `/admin/experiences/leads/${i.id}`, body)).status).toBe(400);
    });
  });

  describe('POST /leads/:id/confirmation', () => {
    it('sends the email to the booking customer and stamps confirmationSentAt', async () => {
      const s = await confirmSetup();
      const b = await s.paidBooking();
      const i = await s.interests.record({ experience: s.exp, source: 'booking_page', bookingId: b.id });
      await s.paid(i.id, s.SCHEDULE);
      const res = await s.send('POST', conf(i.id), {});
      expect(res.status).toBe(200);
      const { lead } = await res.json();
      expect(typeof lead.confirmationSentAt).toBe('string');
      expect(s.fake.sent).toHaveLength(1);
      expect(s.fake.sent[0]).toMatchObject({ to: 'maya@example.com', subject: 'Confirmed: Ayurvedic massage on Sat 21 Nov' });
      expect(s.fake.sent[0]!.html).toContain('Hotel lobby');
      expect(s.fake.sent[0]!.html).toContain(b.reference);
      expect(s.fake.sent[0]!.html).toContain('PH-123');
      expect((await s.interests.get(i.id))!.confirmationSentAt).not.toBeNull();
    });

    it('resend is the same endpoint and sends again', async () => {
      const s = await confirmSetup();
      const i = await s.interests.record({ experience: s.exp, source: 'booking_page', bookingId: (await s.paidBooking()).id });
      await s.paid(i.id, s.SCHEDULE);
      expect((await s.send('POST', conf(i.id), {})).status).toBe(200);
      expect((await s.send('POST', conf(i.id), {})).status).toBe(200);
      expect(s.fake.sent).toHaveLength(2);
    });

    it('a quote-only lead uses the quote contact when it is an email address', async () => {
      const s = await confirmSetup();
      const { i, q } = await s.quoteLead('luca@example.com');
      await s.paid(i.id, s.SCHEDULE);
      const res = await s.send('POST', conf(i.id), {});
      expect(res.status).toBe(200);
      expect(s.fake.sent[0]).toMatchObject({ to: 'luca@example.com' });
      expect(s.fake.sent[0]!.html).toContain(q.reference);
      expect(s.fake.sent[0]!.html).toContain('Luca');
    });

    it('422 no_email for a quote whose contact is a phone number; nothing sent or stamped', async () => {
      const s = await confirmSetup();
      const { i } = await s.quoteLead('+94770000000');
      await s.paid(i.id, s.SCHEDULE);
      const res = await s.send('POST', conf(i.id), {});
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: 'no_email' });
      expect(s.fake.sent).toHaveLength(0);
      expect((await s.interests.get(i.id))!.confirmationSentAt).toBeNull();
    });

    it('422 no_email for a quote with no contact, and for a booking with no email', async () => {
      const s = await confirmSetup();
      const { i } = await s.quoteLead(null);
      await s.paid(i.id, s.SCHEDULE);
      expect((await s.send('POST', conf(i.id), {})).status).toBe(422);
      const bi = await s.interests.record({ experience: s.exp, source: 'booking_page', bookingId: (await s.paidBooking({ ...customer, email: '' })).id });
      await s.paid(bi.id, s.SCHEDULE);
      expect(await (await s.send('POST', conf(bi.id), {})).json()).toEqual({ error: 'no_email' });
      expect(s.fake.sent).toHaveLength(0);
    });

    it('409 not_paid unless the lead is paid', async () => {
      const s = await confirmSetup();
      const i = await s.interests.record({ experience: s.exp, source: 'booking_page', bookingId: (await s.paidBooking()).id });
      await s.send('PATCH', `/admin/experiences/leads/${i.id}`, s.SCHEDULE);
      const res = await s.send('POST', conf(i.id), {});
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'not_paid' });
      expect(s.fake.sent).toHaveLength(0);
    });

    it('400 schedule_required without a date or without a time', async () => {
      const s = await confirmSetup();
      const i = await s.interests.record({ experience: s.exp, source: 'booking_page', bookingId: (await s.paidBooking()).id });
      await s.paid(i.id);
      const none = await s.send('POST', conf(i.id), {});
      expect(none.status).toBe(400);
      expect(await none.json()).toEqual({ error: 'schedule_required' });
      await s.send('PATCH', `/admin/experiences/leads/${i.id}`, { scheduledDate: '2026-11-21' });
      expect((await s.send('POST', conf(i.id), {})).status).toBe(400);
      expect(s.fake.sent).toHaveLength(0);
    });

    it('the meeting point is optional', async () => {
      const s = await confirmSetup();
      const i = await s.interests.record({ experience: s.exp, source: 'booking_page', bookingId: (await s.paidBooking()).id });
      await s.paid(i.id, { scheduledDate: '2026-11-21', scheduledTime: '09:30' });
      expect((await s.send('POST', conf(i.id), {})).status).toBe(200);
      expect(s.fake.sent[0]!.html).not.toMatch(/Meeting point/i);
    });

    it('404 for an unknown or non-uuid id', async () => {
      const s = await confirmSetup();
      expect((await s.send('POST', conf('00000000-0000-4000-8000-000000000000'), {})).status).toBe(404);
      expect((await s.send('POST', conf('nope'), {})).status).toBe(404);
    });

    it('502 send_failed when the email adapter throws; confirmationSentAt stays unchanged', async () => {
      const boom: EmailAdapter = { send: async () => { throw new Error('resend down'); } };
      const s = await confirmSetup({ email: boom });
      const i = await s.interests.record({ experience: s.exp, source: 'booking_page', bookingId: (await s.paidBooking()).id });
      await s.paid(i.id, s.SCHEDULE);
      const res = await s.send('POST', conf(i.id), {});
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'send_failed' });
      expect((await s.interests.get(i.id))!.confirmationSentAt).toBeNull();
    });

    it('502 send_failed when the adapter reports the message was not delivered (kill switch)', async () => {
      const s = await confirmSetup();
      const i = await s.interests.record({ experience: s.exp, source: 'booking_page', bookingId: (await s.paidBooking()).id });
      await s.paid(i.id, s.SCHEDULE);
      const off = realCreateApp({
        auth: AUTH, adminApiKey: 'k', experiences: s.experiences, experienceInterests: s.interests, bookings: s.bookings, quotes: s.quotes,
        email: s.fake, emailPolicy: { enabled: false },
      });
      const res = await off.request(conf(i.id), { method: 'POST', headers: { cookie: OPS, 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(502);
      expect((await s.interests.get(i.id))!.confirmationSentAt).toBeNull();
    });

    it('finance is 403, no session is 401, cross-site is 403 bad_origin', async () => {
      const s = await confirmSetup();
      const i = await s.interests.record({ experience: s.exp, source: 'booking_page', bookingId: (await s.paidBooking()).id });
      await s.paid(i.id, s.SCHEDULE);
      expect((await s.send('POST', conf(i.id), {}, FINANCE)).status).toBe(403);
      expect((await s.send('POST', conf(i.id), {}, null)).status).toBe(401);
      const cross = await s.send('POST', conf(i.id), {}, OPS, { 'sec-fetch-site': 'cross-site' });
      expect(cross.status).toBe(403);
      expect(await cross.json()).toEqual({ error: 'bad_origin' });
      expect(s.fake.sent).toHaveLength(0);
    });
  });
});
