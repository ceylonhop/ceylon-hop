// Promo codes on the public booking routes and checkout (spec 2026-09-14 §6.1–§6.3).
import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { FakeMapsAdapter, type DistanceResult } from '../adapters/maps';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryPaymentRepo } from '../db/paymentRepo';
import { InMemoryConciergeTaskRepo } from '../db/conciergeTaskRepo';
import { InMemoryPromoCodeRepo, type NewPromoCode } from '../db/promoCodeRepo';
import { PROMO_HOLD_MS } from '../domain/promoCode';

const HOUR = 3_600_000;
const customer = { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' };
// Priced by the engine at $78.00 on the live card (see bookings.test.ts "prices a resolvable route").
const GALLE = { from: 'Colombo Airport (CMB)', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 2, customer };
const TRIP = { stops: ['Colombo Airport (CMB)', 'Galle'], nights: [0, 0], pax: 2, vehicleType: 'car', serviceType: 'private', customer };

class ShortHopMaps extends FakeMapsAdapter {
  async distance(): Promise<DistanceResult | null> {
    return { km: 5, durationMin: 10 };
  }
}

function world(opts: { enabled?: boolean; maps?: FakeMapsAdapter } = {}) {
  const promoCodes = new InMemoryPromoCodeRepo();
  const bookings = new InMemoryBookingRepo();
  const payments = new InMemoryPaymentRepo();
  const conciergeTasks = new InMemoryConciergeTaskRepo();
  const clock = { now: new Date(Math.floor(Date.now() / 1000) * 1000) };
  const make = (enabled = opts.enabled ?? true) =>
    createApp({
      bookings, payments, conciergeTasks, promoCodes, promoCodesEnabled: enabled, promoNow: () => clock.now,
      ...(opts.maps ? { maps: opts.maps } : {}),
    });
  const app = make();
  const seed = (over: Partial<NewPromoCode> = {}) =>
    promoCodes.create({
      code: 'SAVE10', method: 'percentage', value: 1000, startsAt: null,
      expiresAt: new Date(clock.now.getTime() + 30 * 24 * HOUR), maxUses: 5, createdBy: 'f@x.com', ...over,
    }, clock.now);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const checkout = (target: ReturnType<typeof createApp>, b: { id: string; checkoutToken: string }) =>
    target.request(`/bookings/${b.id}/checkout`, { method: 'POST', headers: { authorization: `Bearer ${b.checkoutToken}` } });
  const later = (ms: number) => { clock.now = new Date(clock.now.getTime() + ms); };
  return { app, make, promoCodes, bookings, conciergeTasks, clock, seed, post, checkout, later };
}

async function refused(w: ReturnType<typeof world>, body: unknown, error: string, path = '/bookings/single') {
  const before = (await w.bookings.list()).length;
  const res = await w.post(path, body);
  expect(res.status).toBe(422);
  expect((await res.json()).error).toBe(error);
  expect((await w.bookings.list()).length).toBe(before); // a refused code never creates a booking
}

describe('POST /bookings/single with a promo code', () => {
  it('books at the discounted price and holds a use for 2 hours', async () => {
    const w = world();
    const code = await w.seed();
    const res = await w.post('/bookings/single', { ...GALLE, promoCode: ' save10 ' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      total: 7020, amountDueNow: 7020, discountTotal: 780, promoCodeId: code.id,
      promoHoldUntil: new Date(w.clock.now.getTime() + PROMO_HOLD_MS).toISOString(),
    });
    expect(await w.bookings.promoUsage(code.id, w.clock.now)).toEqual({ paid: 0, held: 1 });
  });

  it('raises no price-mismatch alert when the site sent the full OR the discounted price', async () => {
    const w = world();
    await w.seed();
    await w.post('/bookings/single', { ...GALLE, promoCode: 'SAVE10', quotedTotal: 7800 });
    await w.post('/bookings/single', { ...GALLE, promoCode: 'SAVE10', quotedTotal: 7020 });
    expect(await w.conciergeTasks.list()).toHaveLength(0);
    await w.post('/bookings/single', { ...GALLE, promoCode: 'SAVE10', quotedTotal: 5000 });
    expect((await w.conciergeTasks.list()).map((t) => t.note)).toEqual([expect.stringContaining('price mismatch')]);
  });

  it('refuses a bad code with the right error and creates no booking', async () => {
    const w = world();
    const code = await w.seed({ maxUses: 1 });
    await refused(w, { ...GALLE, promoCode: 'NOPE-NOPE' }, 'promo_code_invalid');
    await refused(w, { ...GALLE, promoCode: 'x' }, 'promo_code_invalid');
    await w.seed({ code: 'LATER', startsAt: new Date(w.clock.now.getTime() + HOUR) });
    await refused(w, { ...GALLE, promoCode: 'LATER' }, 'promo_code_not_started');
    await w.seed({ code: 'GONE', expiresAt: new Date(w.clock.now.getTime() - 1) });
    await refused(w, { ...GALLE, promoCode: 'GONE' }, 'promo_code_expired');
    expect((await w.post('/bookings/single', { ...GALLE, promoCode: 'SAVE10' })).status).toBe(201);
    await refused(w, { ...GALLE, promoCode: 'SAVE10' }, 'promo_code_used_up');
    await w.promoCodes.update(code.id, { active: false, updatedBy: 'f@x.com' }, w.clock.now);
    await refused(w, { ...GALLE, promoCode: 'SAVE10' }, 'promo_code_invalid');
  });

  it('refuses every code while PROMO_CODES_ENABLED is off', async () => {
    const w = world({ enabled: false });
    await w.seed();
    await refused(w, { ...GALLE, promoCode: 'SAVE10' }, 'promo_code_invalid');
  });

  it('refuses a code on a booking the engine cannot price', async () => {
    const w = world();
    await w.seed();
    await refused(w, { ...GALLE, from: 'Colombo Airport', to: 'Ella', promoCode: 'SAVE10' }, 'promo_code_not_eligible');
  });

  it('refuses a code the vehicle minimum reduces to $0, and takes no use', async () => {
    const w = world({ maps: new ShortHopMaps() });
    const code = await w.seed();
    const plain = await (await w.post('/bookings/single', GALLE)).json();
    // PRECONDITION: a 5 km car hop costs exactly the $29.00 car minimum. If this assertion fails the
    // fixture is wrong, not the feature — STOP and report it (plan Global Constraints, stop rule).
    expect(plain.total).toBe(2900);
    await refused(w, { ...GALLE, promoCode: 'SAVE10' }, 'promo_code_not_eligible');
    expect(await w.bookings.promoUsage(code.id, w.clock.now)).toEqual({ paid: 0, held: 0 });
  });

  it('takes no second use when the same request is retried with its Idempotency-Key', async () => {
    const w = world();
    const code = await w.seed({ maxUses: 1 });
    const headers = { 'idempotency-key': 'promo-retry-1' };
    const first = await w.post('/bookings/single', { ...GALLE, promoCode: 'SAVE10' }, headers);
    const second = await w.post('/bookings/single', { ...GALLE, promoCode: 'SAVE10' }, headers);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect((await second.json()).id).toBe((await first.json()).id);
    expect(await w.bookings.promoUsage(code.id, w.clock.now)).toEqual({ paid: 0, held: 1 });
  });
});

describe('trips and shared seats', () => {
  it('discounts a trip', async () => {
    const w = world();
    const code = await w.seed();
    const plain = await (await w.post('/bookings/trip', TRIP)).json();
    const res = await w.post('/bookings/trip', { ...TRIP, promoCode: 'SAVE10' });
    expect(res.status).toBe(201);
    const off = Math.floor((plain.total * 1000 + 5000) / 10000);
    expect(await res.json()).toMatchObject({ total: plain.total - off, discountTotal: off, promoCodeId: code.id });
  });

  it('refuses a code on a shared seat before looking at anything else', async () => {
    const w = world();
    await w.seed();
    const res = await w.post('/bookings/shared', { promoCode: 'SAVE10' });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('promo_code_not_eligible');
  });
});

describe('POST /bookings/:id/checkout re-checks the hold (§6.3)', () => {
  async function booked(w: ReturnType<typeof world>, over: Partial<NewPromoCode> = {}) {
    const code = await w.seed(over);
    const b = await (await w.post('/bookings/single', { ...GALLE, promoCode: 'SAVE10' })).json();
    return { code, b };
  }

  it('charges the discounted amount while the hold is valid, and refreshes the hold', async () => {
    const w = world();
    const { b } = await booked(w);
    w.later(HOUR);
    const res = await w.checkout(w.app, b);
    expect(res.status).toBe(200);
    expect((await res.json()).amount).toBe(7020);
    expect((await w.bookings.get(b.id))?.promoHoldUntil).toBe(new Date(w.clock.now.getTime() + PROMO_HOLD_MS).toISOString());
  });

  it('honours a valid hold even though the code has expired since', async () => {
    const w = world();
    const { b } = await booked(w, { expiresAt: new Date(w.clock.now.getTime() + HOUR / 2) });
    w.later(HOUR);
    expect((await w.checkout(w.app, b)).status).toBe(200);
  });

  it('re-holds a lapsed hold when a use is free', async () => {
    const w = world();
    const { b } = await booked(w);
    w.later(3 * HOUR);
    expect((await w.checkout(w.app, b)).status).toBe(200);
    expect((await w.bookings.get(b.id))?.promoHoldUntil).toBe(new Date(w.clock.now.getTime() + PROMO_HOLD_MS).toISOString());
  });

  it('refuses a lapsed hold once someone else has taken the last use', async () => {
    const w = world();
    const { b: first } = await booked(w, { maxUses: 1 });
    w.later(3 * HOUR);
    expect((await w.post('/bookings/single', { ...GALLE, promoCode: 'SAVE10' })).status).toBe(201);
    const res = await w.checkout(w.app, first);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('promo_code_used_up');
  });

  it('refuses a lapsed hold on a switched-off code, and on an expired one', async () => {
    const w = world();
    const { code, b } = await booked(w);
    await w.promoCodes.update(code.id, { active: false, updatedBy: 'f@x.com' }, w.clock.now);
    w.later(3 * HOUR);
    const off = await w.checkout(w.app, b);
    expect(off.status).toBe(409);
    expect((await off.json()).error).toBe('promo_code_invalid');

    const v = world();
    const { b: late } = await booked(v, { expiresAt: new Date(v.clock.now.getTime() + HOUR) });
    v.later(3 * HOUR);
    const expired = await v.checkout(v.app, late);
    expect(expired.status).toBe(409);
    expect((await expired.json()).error).toBe('promo_code_expired');
  });

  it('still honours a held code after PROMO_CODES_ENABLED is turned off', async () => {
    const w = world();
    const { b } = await booked(w);
    const res = await w.checkout(w.make(false), b);
    expect(res.status).toBe(200);
    expect((await res.json()).amount).toBe(7020);
  });
});
