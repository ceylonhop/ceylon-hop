import { describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { FakePaymentAdapter } from '../adapters/payments';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryPaymentRepo } from '../db/paymentRepo';
import { InMemoryQuoteRepo } from '../db/quoteRepo';
import { InMemoryQuoteConversionRepo } from '../db/quoteConversionRepo';
import { FakeMapsAdapter } from '../adapters/maps';
import { quote } from '../quote/engine';
import type { QuoteRequest } from '../quote/types';
import type { RateCard } from '../quote/rateCard';

class CountingMapsAdapter extends FakeMapsAdapter {
  calls = 0;

  override async distance(from: string, to: string) {
    this.calls += 1;
    return super.distance(from, to);
  }
}

const intent = {
  product: 'private',
  routeId: 'kandy-nanu-oya',
  vehicle: 'car',
  pax: 2,
  bags: 1,
  date: '2026-09-10',
  time: '09:00',
  legs: [{ from: 'Kandy', to: 'Nanu Oya' }],
  extras: [],
};

const customer = {
  firstName: 'Maya',
  lastName: 'Silva',
  email: 'maya@example.com',
  whatsapp: '+94770000000',
  country: 'Sri Lanka',
};

async function lock(app: ReturnType<typeof createApp>, value: unknown = intent) {
  const response = await app.request('/quote/v2/lock', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
  expect(response.status).toBe(201);
  return response.json();
}

async function convert(
  app: ReturnType<typeof createApp>,
  locked: { quoteId: string; accessToken: string; revision: number },
  value: unknown = intent,
) {
  const details =
    value && typeof value === 'object' && 'product' in value && value.product === 'chauffeur'
      ? { customer }
      : { customer, date: intent.date, time: intent.time };
  return app.request('/bookings/from-quote-v2', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${locked.accessToken}`,
    },
    body: JSON.stringify({
      quoteId: locked.quoteId,
      revision: locked.revision,
      intent: value,
      bookingDetails: details,
    }),
  });
}

describe('POST /bookings/from-quote-v2', () => {
  it('is default-off without changing legacy booking routes', async () => {
    const app = createApp();
    const response = await app.request('/bookings/from-quote-v2', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(404);

    const legacy = await app.request('/bookings/single', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: 'Kandy',
        to: 'Nanu Oya',
        vehicleType: 'car',
        adults: 2,
        children: 0,
        bags: 1,
        customer,
      }),
    });
    expect(legacy.status).toBe(201);
  });

  it('converts once at the stored quote amount through checkout and webhook', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const payments = new InMemoryPaymentRepo();
    const adapter = new FakePaymentAdapter();
    const maps = new CountingMapsAdapter();
    const app = createApp({
      quotes,
      bookings,
      payments,
      adapter,
      maps,
      quoteV2Enabled: true,
    });
    const locked = await lock(app);
    const mapsCallsAtLock = maps.calls;
    const savedQuote = await quotes.get(locked.quoteId);
    expect(savedQuote).not.toBeNull();
    expect(
      quote(
        (savedQuote!.request as { engine: QuoteRequest }).engine,
        savedQuote!.rateCardJson as RateCard,
      ),
    ).toEqual(savedQuote!.result);
    const response = await convert(app, locked);
    expect(response.status).toBe(201);
    expect(maps.calls).toBe(mapsCallsAtLock);
    const booking = await response.json();
    expect(booking.total).toBe(locked.totalCents);
    expect(booking.amountDueNow).toBe(locked.amountDueNowCents);
    expect(booking.currency).toBe('USD');

    const replay = await convert(app, locked);
    expect(replay.status).toBe(200);
    expect((await replay.json()).id).toBe(booking.id);
    const editAfterConversion = await app.request(`/quote/v2/${locked.quoteId}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${locked.accessToken}`,
      },
      body: JSON.stringify({ revision: locked.revision, intent: { ...intent, pax: 3 } }),
    });
    expect(editAfterConversion.status).toBe(409);
    expect((await editAfterConversion.json()).error).toBe('quote_already_converted');

    const checkout = await app.request(`/bookings/${booking.id}/checkout`, { method: 'POST' });
    expect(checkout.status).toBe(200);
    const checkoutBody = await checkout.json();
    expect(checkoutBody.amount).toBe(locked.amountDueNowCents);
    expect((await payments.findByOrderId(booking.reference))?.amount).toBe(locked.amountDueNowCents);

    const webhook = adapter.simulateWebhook({
      orderId: booking.reference,
      amount: locked.amountDueNowCents,
      currency: 'USD',
    });
    expect(
      (await app.request('/webhooks/payments', { method: 'POST', body: webhook })).status,
    ).toBe(200);
    expect((await bookings.get(booking.id))?.status).toBe('paid');
    expect(bookings.getPricingSnapshotForQuoteConversion(booking.id)).toMatchObject({
      quoteId: locked.quoteId,
      quoteRevision: locked.revision,
      totalCents: locked.totalCents,
      amountDueNowCents: locked.amountDueNowCents,
      currency: 'USD',
    });
  });

  it('serializes concurrent conversion attempts into one booking', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ quotes, bookings, quoteV2Enabled: true });
    const locked = await lock(app);

    const [first, second] = await Promise.all([convert(app, locked), convert(app, locked)]);
    expect([first.status, second.status].sort()).toEqual([200, 201]);
    expect((await first.json()).id).toBe((await second.json()).id);
    expect(await bookings.list()).toHaveLength(1);
  });

  it.each([
    {
      name: 'multi-leg private',
      intent: {
        ...intent,
        legs: [
          { from: 'Kandy', to: 'Nanu Oya' },
          { from: 'Nanu Oya', to: 'Ella' },
        ],
      },
      serviceType: 'private',
    },
    {
      name: 'chauffeur',
      intent: {
        product: 'chauffeur',
        tourId: 'hill-country',
        vehicle: 'car',
        pax: 2,
        bags: 1,
        firstDate: '2026-09-10',
        lastDate: '2026-09-11',
        travelDays: [
          { date: '2026-09-10', from: 'Kandy', to: 'Nanu Oya' },
          { date: '2026-09-11', from: 'Nanu Oya', to: 'Ella' },
        ],
        extras: [],
      },
      serviceType: 'chauffeur',
    },
  ])('converts a $name quote into the matching trip without repricing', async (fixture) => {
    const app = createApp({ quoteV2Enabled: true });
    const locked = await lock(app, fixture.intent);
    const response = await convert(app, locked, fixture.intent);
    expect(response.status).toBe(201);
    const booking = await response.json();
    expect(booking).toMatchObject({
      mode: 'trip',
      total: locked.totalCents,
      amountDueNow: locked.amountDueNowCents,
      input: { serviceType: fixture.serviceType },
    });
  });

  it.each(['after_booking_insert', 'after_quote_update'] as const)(
    'rolls back an injected %s failure and permits a clean retry',
    async (failurePoint) => {
      const quotes = new InMemoryQuoteRepo();
      const bookings = new InMemoryBookingRepo();
      let shouldFail = true;
      const failing = new InMemoryQuoteConversionRepo(
        quotes,
        bookings,
        () => new Date(),
        (point) => {
          if (shouldFail && point === failurePoint) {
            shouldFail = false;
            throw new Error(`injected:${point}`);
          }
        },
      );
      const app = createApp({
        quotes,
        bookings,
        quoteConversions: failing,
        quoteV2Enabled: true,
      });
      const locked = await lock(app);

      expect((await convert(app, locked)).status).toBe(500);
      expect(await bookings.list()).toHaveLength(0);
      expect((await quotes.get(locked.quoteId))?.convertedBookingId).toBeNull();
      expect((await quotes.get(locked.quoteId))?.status).toBe('draft');

      const retry = await convert(app, locked);
      expect(retry.status).toBe(201);
      expect(await bookings.list()).toHaveLength(1);
    },
  );

  it('rejects an expired quote and changed booking date without mutation', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const expiredApp = createApp({
      quotes,
      bookings,
      quoteConversions: new InMemoryQuoteConversionRepo(
        quotes,
        bookings,
        () => new Date(Date.now() + 8 * 24 * 60 * 60 * 1000),
      ),
      quoteV2Enabled: true,
    });
    const locked = await lock(expiredApp);
    const expired = await convert(expiredApp, locked);
    expect(expired.status).toBe(409);
    expect((await expired.json()).error).toBe('quote_expired');

    const liveApp = createApp({ quotes, bookings, quoteV2Enabled: true });
    const changedDetails = await liveApp.request('/bookings/from-quote-v2', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${locked.accessToken}`,
      },
      body: JSON.stringify({
        quoteId: locked.quoteId,
        revision: locked.revision,
        intent,
        bookingDetails: { customer, date: '2026-09-11', time: intent.time },
      }),
    });
    expect(changedDetails.status).toBe(409);
    expect((await changedDetails.json()).error).toBe('quote_intent_mismatch');
    expect(await bookings.list()).toHaveLength(0);
  });

  it.each([
    ['route', { ...intent, legs: [{ from: 'Kandy', to: 'Ella' }] }],
    ['travellers', { ...intent, pax: 3 }],
    ['vehicle', { ...intent, vehicle: 'van' }],
    ['date', { ...intent, date: '2026-09-11' }],
    [
      'service',
      {
        product: 'chauffeur',
        tourId: 'hill-country',
        vehicle: 'car',
        pax: 2,
        bags: 1,
        firstDate: '2026-09-10',
        lastDate: '2026-09-10',
        travelDays: [{ date: '2026-09-10', from: 'Kandy', to: 'Nanu Oya' }],
        extras: [],
      },
    ],
    ['extras', { ...intent, extras: ['waiting'] }],
  ])('rejects a changed %s without creating a booking', async (_field, changed) => {
    const bookings = new InMemoryBookingRepo();
    const app = createApp({
      quotes: new InMemoryQuoteRepo(),
      bookings,
      quoteV2Enabled: true,
    });
    const locked = await lock(app);
    const response = await convert(app, locked, changed);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe('quote_intent_mismatch');
    expect(await bookings.list()).toHaveLength(0);
  });

  it('rejects a forged token and stale revision without mutation', async () => {
    const bookings = new InMemoryBookingRepo();
    const app = createApp({
      quotes: new InMemoryQuoteRepo(),
      bookings,
      quoteV2Enabled: true,
    });
    const locked = await lock(app);
    const forged = await app.request('/bookings/from-quote-v2', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer forged',
      },
      body: JSON.stringify({
        quoteId: locked.quoteId,
        revision: locked.revision,
        intent,
        bookingDetails: { customer, date: intent.date, time: intent.time },
      }),
    });
    expect(forged.status).toBe(403);

    const stale = await app.request('/bookings/from-quote-v2', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${locked.accessToken}`,
      },
      body: JSON.stringify({
        quoteId: locked.quoteId,
        revision: locked.revision + 1,
        intent,
        bookingDetails: { customer, date: intent.date, time: intent.time },
      }),
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toBe('stale_revision');
    expect(await bookings.list()).toHaveLength(0);
  });
});
