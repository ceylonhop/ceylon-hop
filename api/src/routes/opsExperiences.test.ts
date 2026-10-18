import { describe, it, expect } from 'vitest';
import { createApp as realCreateApp } from '../app';
import { InMemoryExperienceRepo } from '../db/experienceRepo';
import { InMemoryExperienceInterestRepo } from '../db/experienceInterestRepo';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryQuoteRepo } from '../db/quoteRepo';
import { FakeEmailAdapter, type EmailAdapter } from '../adapters/email';
import { signSession } from '../lib/opsAuth';
import { FakeImageStore } from '../adapters/imageStore';
import { FakeBusinessPlaces } from '../adapters/businessPlaces';

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

  it('the Tripadvisor location id (D22): saved on create, replaced and cleared by PATCH, digits only', async () => {
    const { send } = setup();
    const made = (await (await send('POST', '/admin/experiences', { ...BODY, tripadvisorLocationId: '6789012' })).json()).experience;
    expect(made.tripadvisorLocationId).toBe('6789012');
    const noId = (await (await send('POST', '/admin/experiences', { ...BODY, slug: 'no-listing' })).json()).experience;
    expect(noId.tripadvisorLocationId).toBeNull();
    expect((await (await send('PATCH', `/admin/experiences/${made.id}`, { active: false })).json()).experience.tripadvisorLocationId).toBe('6789012');
    expect((await (await send('PATCH', `/admin/experiences/${made.id}`, { tripadvisorLocationId: '42' })).json()).experience.tripadvisorLocationId).toBe('42');
    expect((await (await send('PATCH', `/admin/experiences/${made.id}`, { tripadvisorLocationId: null })).json()).experience.tripadvisorLocationId).toBeNull();
    for (const bad of ['abc', '', 'https://www.tripadvisor.com/x-d1-Reviews', '1234567890123456']) {
      expect((await send('PATCH', `/admin/experiences/${made.id}`, { tripadvisorLocationId: bad })).status, bad).toBe(400);
    }
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
      expect(lead.confirmationChannel).toBe('email');
      expect((await s.interests.get(i.id))!.confirmationChannel).toBe('email');
    });

    describe('channel whatsapp (confirmed outside email)', () => {
      it('stamps the lead, records the channel, and sends nothing — even with no email on file', async () => {
        const s = await confirmSetup();
        const { i } = await s.quoteLead('+94770000000');
        await s.paid(i.id); // no schedule needed
        const res = await s.send('POST', conf(i.id), { channel: 'whatsapp' });
        expect(res.status).toBe(200);
        const { lead } = await res.json();
        expect(lead).toMatchObject({ confirmationChannel: 'whatsapp' });
        expect(typeof lead.confirmationSentAt).toBe('string');
        expect(s.fake.sent).toHaveLength(0);
        expect((await s.interests.get(i.id))).toMatchObject({ confirmationChannel: 'whatsapp' });
      });
      it('409 not_paid on an unpaid lead; nothing stamped', async () => {
        const s = await confirmSetup();
        const { i } = await s.quoteLead('+94770000000');
        const res = await s.send('POST', conf(i.id), { channel: 'whatsapp' });
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({ error: 'not_paid' });
        expect((await s.interests.get(i.id))!.confirmationSentAt).toBeNull();
      });
      it.each([['an unknown channel', { channel: 'sms' }], ['an unknown key', { channel: 'email', extra: 1 }]])('400 on %s', async (_n, body) => {
        const s = await confirmSetup();
        const { i } = await s.quoteLead('luca@example.com');
        await s.paid(i.id, s.SCHEDULE);
        expect((await s.send('POST', conf(i.id), body)).status).toBe(400);
        expect(s.fake.sent).toHaveLength(0);
      });
      it('channel email is the explicit form of the default', async () => {
        const s = await confirmSetup();
        const { i } = await s.quoteLead('luca@example.com');
        await s.paid(i.id, s.SCHEDULE);
        expect((await s.send('POST', conf(i.id), { channel: 'email' })).status).toBe(200);
        expect(s.fake.sent).toHaveLength(1);
      });
      it('a resend by email after WhatsApp re-stamps the channel as email', async () => {
        const s = await confirmSetup();
        const { i } = await s.quoteLead('luca@example.com');
        await s.paid(i.id, s.SCHEDULE);
        await s.send('POST', conf(i.id), { channel: 'whatsapp' });
        await s.send('POST', conf(i.id), {});
        expect((await s.interests.get(i.id))!.confirmationChannel).toBe('email');
      });
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

    // Staging 2026-10-13: the allowlist stops every address outside @ceylonhop.com, and the page answered
    // "try again" — the one thing that cannot help. A suppression is an operator setting, not a failure.
    it('422 email_suppressed (with the adapter reason) when the allowlist stops the message; nothing stamped', async () => {
      const allowlisted: EmailAdapter = { send: async () => ({ delivered: false, reason: 'suppressed_allowlist' }) };
      const s = await confirmSetup({ email: allowlisted });
      const i = await s.interests.record({ experience: s.exp, source: 'booking_page', bookingId: (await s.paidBooking()).id });
      await s.paid(i.id, s.SCHEDULE);
      const res = await s.send('POST', conf(i.id), {});
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: 'email_suppressed', reason: 'suppressed_allowlist' });
      expect((await s.interests.get(i.id))!.confirmationSentAt).toBeNull();
    });

    it('422 email_suppressed when the kill switch stops the message; nothing stamped', async () => {
      const s = await confirmSetup();
      const i = await s.interests.record({ experience: s.exp, source: 'booking_page', bookingId: (await s.paidBooking()).id });
      await s.paid(i.id, s.SCHEDULE);
      const off = realCreateApp({
        auth: AUTH, adminApiKey: 'k', experiences: s.experiences, experienceInterests: s.interests, bookings: s.bookings, quotes: s.quotes,
        email: s.fake, emailPolicy: { enabled: false },
      });
      const res = await off.request(conf(i.id), { method: 'POST', headers: { cookie: OPS, 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: 'email_suppressed', reason: 'suppressed_disabled' });
      expect(s.fake.sent).toHaveLength(0);
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

const jpeg = (n: number) => { const b = new Uint8Array(n); b.set([0xff, 0xd8, 0xff, 0xe0]); return b; };
function photoForm(large: Uint8Array<ArrayBuffer> | null = jpeg(2000), small: Uint8Array<ArrayBuffer> | null = jpeg(1000)) {
  const f = new FormData();
  if (large) f.set('large', new File([large], 'large.jpg', { type: 'image/jpeg' }));
  if (small) f.set('small', new File([small], 'small.jpg', { type: 'image/jpeg' }));
  return f;
}
function setupPhotos(store: FakeImageStore | null = new FakeImageStore()) {
  const experiences = new InMemoryExperienceRepo();
  const a = realCreateApp({
    auth: AUTH, adminApiKey: 'k', experiences, experienceInterests: new InMemoryExperienceInterestRepo(),
    photoStore: store ? { store, publicOrigin: 'https://img-staging.ceylonhop.com' } : null,
  });
  const upload = (body: FormData, ck: string | null = OPS, extra: Record<string, string> = {}) =>
    a.request('/admin/experiences/photos', { method: 'POST', headers: { ...(ck ? { cookie: ck } : {}), ...extra }, body });
  return { a, store, upload };
}

describe('POST /admin/experiences/photos (spec 2026-10-17)', () => {
  it('401 without a session, 403 for finance, 403 cross-site', async () => {
    const { upload } = setupPhotos();
    expect((await upload(photoForm(), null)).status).toBe(401);
    expect((await upload(photoForm(), FINANCE)).status).toBe(403);
    expect((await upload(photoForm(), OPS, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
  });

  it('503 uploads_off when no store is configured', async () => {
    const { upload } = setupPhotos(null);
    const res = await upload(photoForm());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'uploads_off' });
  });

  it('stores both sizes under one new uuid and answers an address the catalogue accepts', async () => {
    const { a, store, upload } = setupPhotos();
    // Both files at their caps still fit under the app-wide 1 MB limit.
    const large = jpeg(700_000), small = jpeg(250_000);
    const res = await upload(photoForm(large, small));
    expect(res.status).toBe(201);
    const { stem } = await res.json();
    expect(stem).toMatch(/^https:\/\/img-staging\.ceylonhop\.com\/experiences\/[0-9a-f-]{36}$/);
    const id = stem.split('/').pop();
    expect(store!.puts.map((p) => p.key)).toEqual([`experiences/${id}-1800.jpg`, `experiences/${id}-900.jpg`]);
    expect(store!.puts[0]).toMatchObject({ contentType: 'image/jpeg', cacheControl: 'public, max-age=31536000, immutable' });
    expect(Array.from(store!.puts[0]!.body)).toEqual(Array.from(large));
    expect(Array.from(store!.puts[1]!.body)).toEqual(Array.from(small));
    // Round trip: the returned address is a valid photo for a new experience.
    const created = await a.request('/admin/experiences', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: OPS }, body: JSON.stringify({ ...BODY, photos: [stem] }),
    });
    expect(created.status).toBe(201);
  });

  it('400 for a missing file, a non-JPEG, or an oversize file', async () => {
    const { store, upload } = setupPhotos();
    expect(await (await upload(photoForm(jpeg(2000), null))).json()).toEqual({ error: 'bad_request', field: 'small' });
    expect(await (await upload(photoForm(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), jpeg(10)))).json()).toEqual({ error: 'not_jpeg', field: 'large' });
    expect(await (await upload(photoForm(jpeg(700_001), jpeg(1000)))).json()).toEqual({ error: 'too_large', field: 'large' });
    expect(await (await upload(photoForm(jpeg(2000), jpeg(250_001)))).json()).toEqual({ error: 'too_large', field: 'small' });
    expect(store!.puts).toHaveLength(0);
  });

  it('413 from the app-wide 1 MB body limit, before the route reads anything', async () => {
    const { store, upload } = setupPhotos();
    const res = await upload(photoForm(jpeg(1_100_000), jpeg(1000)));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
    expect(store!.puts).toHaveLength(0);
  });

  it('502 upload_failed when the store fails', async () => {
    const store = new FakeImageStore();
    store.fail = true;
    const { upload } = setupPhotos(store);
    const res = await upload(photoForm());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'upload_failed' });
  });

  it('the catalogue GET says whether uploads are on', async () => {
    const on = setupPhotos();
    expect((await (await on.a.request('/admin/experiences', { headers: { cookie: OPS } })).json()).uploads).toBe(true);
    const off = setupPhotos(null);
    expect((await (await off.a.request('/admin/experiences', { headers: { cookie: OPS } })).json()).uploads).toBe(false);
  });
});

// "Find the business on Google" (2026-10-18).
const ATHERYA = {
  placeId: 'ChIJAtherya0000000000000', name: 'Atherya Ayurveda Spa', address: 'Kibissa, Sigiriya 21120, Sri Lanka',
  lat: 7.9571, lng: 80.7601, area: 'Sigiriya', phone: '+94 77 123 4567', website: 'https://atherya.lk/', mapsUrl: 'https://maps.google.com/?cid=1',
  openWeekdays: [1, 2, 3, 4, 5, 6] as number[] | null,
};
function setupBusiness(fake: FakeBusinessPlaces | null = new FakeBusinessPlaces([ATHERYA])) {
  const a = realCreateApp({
    auth: AUTH, adminApiKey: 'k', experiences: new InMemoryExperienceRepo(), experienceInterests: new InMemoryExperienceInterestRepo(),
    businessPlaces: fake,
  });
  const get = (path: string, ck: string | null = OPS) => a.request(path, { headers: ck ? { cookie: ck } : {} });
  return { a, fake, get };
}

describe('GET /admin/experiences/business-search + /business/:placeId', () => {
  it('401 without a session, 403 for finance', async () => {
    const { get } = setupBusiness();
    expect((await get('/admin/experiences/business-search?q=ath', null)).status).toBe(401);
    expect((await get('/admin/experiences/business-search?q=ath', FINANCE)).status).toBe(403);
    expect((await get(`/admin/experiences/business/${ATHERYA.placeId}`, FINANCE)).status).toBe(403);
  });

  it('503 business_off without a Google key; the catalogue GET says whether search is on', async () => {
    const off = setupBusiness(null);
    expect((await off.get('/admin/experiences/business-search?q=ath')).status).toBe(503);
    expect((await (await off.get('/admin/experiences')).json()).businessSearch).toBe(false);
    const on = setupBusiness();
    expect((await (await on.get('/admin/experiences')).json()).businessSearch).toBe(true);
  });

  it('search passes the trimmed query and returns candidates', async () => {
    const { get, fake } = setupBusiness();
    const res = await get('/admin/experiences/business-search?q=%20Atherya%20');
    expect(res.status).toBe(200);
    expect((await res.json()).candidates).toEqual([{ placeId: ATHERYA.placeId, name: ATHERYA.name, address: ATHERYA.address, lat: 7.9571, lng: 80.7601 }]);
    expect(fake!.calls).toEqual(['search:Atherya']);
  });

  it('search refuses an over-long query without calling Google', async () => {
    const { get, fake } = setupBusiness();
    expect((await get('/admin/experiences/business-search?q=' + 'x'.repeat(101))).status).toBe(400);
    expect(fake!.calls).toEqual([]);
  });

  it('details returns the business; a malformed id is 404 without a call; an unknown id is 404', async () => {
    const { get, fake } = setupBusiness();
    const ok = await get(`/admin/experiences/business/${ATHERYA.placeId}`);
    expect(ok.status).toBe(200);
    expect((await ok.json()).business).toEqual(ATHERYA);
    expect((await get('/admin/experiences/business/not%20an%20id')).status).toBe(404);
    expect((await get('/admin/experiences/business/ChIJunknown000000000000')).status).toBe(404);
    expect(fake!.calls).toEqual([`details:${ATHERYA.placeId}`, 'details:ChIJunknown000000000000']);
  });

  it('an experience saved from a pick keeps the place id (ops-only)', async () => {
    const { a } = setupBusiness();
    const res = await a.request('/admin/experiences', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: OPS },
      body: JSON.stringify({ ...BODY, slug: 'atherya', googlePlaceId: ATHERYA.placeId }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).experience.googlePlaceId).toBe(ATHERYA.placeId);
  });
});

describe('business details: Area is our nearest catalogue town (2026-10-18)', () => {
  it('replaces Google’s sub-area with the town travellers know, and keeps Google’s when no town is near', async () => {
    const near = { ...ATHERYA, area: 'Kimbissa' };
    const far = { ...ATHERYA, placeId: 'ChIJFarAway00000000000000', area: 'Bibile', lat: 7.3, lng: 81.4 };
    const { get } = setupBusiness(new FakeBusinessPlaces([near, far]));
    expect((await (await get(`/admin/experiences/business/${near.placeId}`)).json()).business.area).toBe('Sigiriya');
    expect((await (await get(`/admin/experiences/business/${far.placeId}`)).json()).business.area).toBe('Bibile');
  });
});
