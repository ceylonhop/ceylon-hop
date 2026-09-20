// The estimate previews a promo code and never holds a use (spec 2026-09-14 §6.4).
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { quoteRoutes } from './quote';
import { InMemoryQuoteRepo } from '../db/quoteRepo';
import { FakeMapsAdapter } from '../adapters/maps';
import { InMemoryBookingRepo, type NewBooking } from '../db/bookingRepo';
import { InMemoryPromoCodeRepo, type NewPromoCode } from '../db/promoCodeRepo';

const HOUR = 3_600_000;
const NOW = new Date(Math.floor(Date.now() / 1000) * 1000);
// Kandy → Ella, not Kandy → Nanu Oya: on the fake maps adapter Nanu Oya prices at exactly the $29.00
// car minimum, where a 10% code correctly comes to $0 (§4.3 row 3) and previews as not eligible.
const V2_PRIVATE = {
  product: 'private', routeId: 'kandy-ella', vehicle: 'car', pax: 2, bags: 2,
  legs: [{ from: 'Kandy', to: 'Ella' }], extras: [],
};
const booking: NewBooking = {
  mode: 'single',
  input: {
    from: 'Kandy', to: 'Nanu Oya', vehicleType: 'car', adults: 2, children: 0, bags: 2,
    customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
  },
  total: 5000, amountDueNow: 5000, currency: 'USD', discountTotal: 500,
};

function world(enabled = true) {
  const promoCodes = new InMemoryPromoCodeRepo();
  const bookings = new InMemoryBookingRepo();
  const app = new Hono();
  app.route('/quote', quoteRoutes({
    quotes: new InMemoryQuoteRepo(), maps: new FakeMapsAdapter(), v2Enabled: true,
    promoCodes, bookings, promoCodesEnabled: enabled, promoNow: () => NOW,
  }));
  const seed = (over: Partial<NewPromoCode> = {}) => promoCodes.create({
    code: 'SAVE10', method: 'percentage', value: 1000, startsAt: null,
    expiresAt: new Date(NOW.getTime() + 30 * 24 * HOUR), maxUses: 5, createdBy: 'f@x.com', ...over,
  }, NOW);
  const send = (body: unknown) => app.request('/quote/v2/estimate', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { promoCodes, bookings, seed, send };
}

describe('POST /quote/v2/estimate with a promo code', () => {
  it('previews the discount next to the unchanged price', async () => {
    const w = world();
    await w.seed();
    const res = await w.send({ ...V2_PRIVATE, promoCode: 'save10' });
    expect(res.status).toBe(200);
    const body = await res.json();
    // PRECONDITION: the fixture must price above the $29.00 car minimum, or the floor leaves no room.
    expect(body.totalCents).toBeGreaterThan(2900 / 0.9);
    const off = Math.floor((body.totalCents * 1000 + 5000) / 10000);
    expect(body.promoCode).toEqual({
      code: 'SAVE10', discountCents: off, totalBeforeDiscountCents: body.totalCents, totalCents: body.totalCents - off,
    });
  });

  it('adds nothing when no code is sent', async () => {
    const body = await (await world().send(V2_PRIVATE)).json();
    expect('promoCode' in body).toBe(false);
  });

  it('reports a bad code without failing the price', async () => {
    const w = world();
    const unknown = await (await w.send({ ...V2_PRIVATE, promoCode: 'NOPE-NOPE' })).json();
    expect(unknown.promoCode).toEqual({ error: 'promo_code_invalid' });
    expect(unknown.totalCents).toBeGreaterThan(0);

    const off = world(false);
    await off.seed();
    expect((await (await off.send({ ...V2_PRIVATE, promoCode: 'SAVE10' })).json()).promoCode).toEqual({ error: 'promo_code_invalid' });
  });

  it('reports a code whose uses are all taken, and never holds one itself', async () => {
    const w = world();
    const code = await w.seed({ maxUses: 1 });
    await w.send({ ...V2_PRIVATE, promoCode: 'SAVE10' });
    await w.send({ ...V2_PRIVATE, promoCode: 'SAVE10' });
    expect(await w.bookings.promoUsage(code.id, NOW)).toEqual({ paid: 0, held: 0 });
    expect(await w.bookings.list()).toHaveLength(0);

    await w.bookings.create(booking, { promo: { code, now: NOW } });
    expect((await (await w.send({ ...V2_PRIVATE, promoCode: 'SAVE10' })).json()).promoCode).toEqual({ error: 'promo_code_used_up' });
  });

  it('still rejects any other unknown field on the intent', async () => {
    const w = world();
    await w.seed();
    expect((await w.send({ ...V2_PRIVATE, promoCode: 'SAVE10', foo: 1 })).status).toBe(400);
  });
});
