// Founder API for promo codes (spec 2026-09-14 §6.5).
import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { signSession } from '../lib/opsAuth';
import { InMemoryBookingRepo, type NewBooking } from '../db/bookingRepo';
import { InMemoryPromoCodeRepo } from '../db/promoCodeRepo';

const AUTH = { opsUsers: 'f@x.com:founder,fin@x.com:finance,op@x.com:ops', googleClientId: 'cid', opsSessionSecret: 'sek' };
const cookie = (email: string) => `ch_ops=${signSession({ email, exp: Date.now() + 60_000 }, AUTH.opsSessionSecret)}`;
const FOUNDER = cookie('f@x.com');
const HOUR = 3_600_000;
const EXPIRES = new Date(Date.now() + 30 * 24 * HOUR).toISOString();
const NEW = { code: 'summer10', method: 'percentage', value: 1000, expiresAt: EXPIRES, maxUses: 5 };

const booking: NewBooking = {
  mode: 'single',
  input: {
    from: 'Kandy', to: 'Ella', vehicleType: 'car', adults: 2, children: 0, bags: 2,
    customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
  },
  total: 9000, amountDueNow: 9000, currency: 'USD', discountTotal: 1000,
};

function world(enabled = true) {
  const promoCodes = new InMemoryPromoCodeRepo();
  const bookings = new InMemoryBookingRepo();
  const app = createApp({ auth: AUTH, adminApiKey: 'k', bookingLinkSecret: 'test-link-secret', promoCodes, bookings, promoCodesEnabled: enabled });
  const call = (method: string, path: string, body?: unknown, jar = FOUNDER, headers: Record<string, string> = {}) =>
    app.request(`/admin/promo-codes${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(jar ? { cookie: jar } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { promoCodes, bookings, call };
}

describe('/admin/promo-codes', () => {
  it('lets a founder create a code, normalised and attributed', async () => {
    const w = world();
    const res = await w.call('POST', '', NEW);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      code: 'SUMMER10', method: 'percentage', value: 1000, maxUses: 5, active: true,
      createdBy: 'f@x.com', expiresAt: EXPIRES, uses: { paid: 0, held: 0, remaining: 5 }, worksNow: true,
    });
  });

  it('refuses a duplicate code and a code over 30%', async () => {
    const w = world();
    await w.call('POST', '', NEW);
    const dup = await w.call('POST', '', { ...NEW, code: 'SUMMER10' });
    expect(dup.status).toBe(409);
    expect((await dup.json()).error).toBe('code_taken');
    expect((await w.call('POST', '', { ...NEW, code: 'BIG', value: 3500 })).status).toBe(400);
  });

  it('is founder-only', async () => {
    const w = world();
    expect((await w.call('GET', '', undefined, cookie('op@x.com'))).status).toBe(403);
    expect((await w.call('POST', '', NEW, cookie('fin@x.com'))).status).toBe(403);
    expect((await w.call('GET', '', undefined, '')).status).toBe(401);
  });

  it('refuses a cross-site write', async () => {
    const w = world();
    const res = await w.call('POST', '', NEW, FOUNDER, { 'sec-fetch-site': 'cross-site' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('bad_origin');
  });

  it('lists codes with their uses, and shows the bookings behind one code', async () => {
    const w = world();
    const created = await (await w.call('POST', '', NEW)).json();
    const code = await w.promoCodes.get(created.id);
    const held = await w.bookings.create(booking, { promo: { code: code!, now: new Date() } });

    const list = await (await w.call('GET', '')).json();
    expect(list.codes).toHaveLength(1);
    expect(list.codes[0].uses).toEqual({ paid: 0, held: 1, remaining: 4 });

    const detail = await (await w.call('GET', `/${created.id}`)).json();
    expect(detail.bookings).toEqual([
      expect.objectContaining({ bookingId: held.id, reference: held.reference, use: 'held', discountCents: 1000 }),
    ]);
  });

  it('changes expiry, max uses and on/off only', async () => {
    const w = world();
    const created = await (await w.call('POST', '', { ...NEW, startsAt: new Date(Date.now() + HOUR).toISOString() })).json();
    const patched = await w.call('PATCH', `/${created.id}`, { maxUses: 9, active: false });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ maxUses: 9, active: false, updatedBy: 'f@x.com', worksNow: false });
    expect((await w.call('PATCH', `/${created.id}`, { value: 500 })).status).toBe(400);
    // An expiry at or before the code's start is refused.
    expect((await w.call('PATCH', `/${created.id}`, { expiresAt: new Date(Date.now()).toISOString() })).status).toBe(400);
  });

  it('answers 404 for an unknown or malformed id', async () => {
    const w = world();
    expect((await w.call('GET', '/00000000-0000-0000-0000-000000000000')).status).toBe(404);
    expect((await w.call('GET', '/not-a-uuid')).status).toBe(404);
    expect((await w.call('PATCH', '/not-a-uuid', { active: false })).status).toBe(404);
  });

  it('with the flag off: creating is refused, switching a code off still works', async () => {
    const on = world();
    const created = await (await on.call('POST', '', NEW)).json();
    const offApp = createApp({ auth: AUTH, adminApiKey: 'k', bookingLinkSecret: 'test-link-secret', promoCodes: on.promoCodes, bookings: on.bookings, promoCodesEnabled: false });
    const req = (method: string, path: string, body: unknown) => offApp.request(`/admin/promo-codes${path}`, {
      method, headers: { 'content-type': 'application/json', cookie: FOUNDER }, body: JSON.stringify(body),
    });
    const create = await req('POST', '', { ...NEW, code: 'ANOTHER' });
    expect(create.status).toBe(403);
    expect((await create.json()).error).toBe('promo_codes_disabled');
    expect((await req('PATCH', `/${created.id}`, { active: false })).status).toBe(200);
  });
});
