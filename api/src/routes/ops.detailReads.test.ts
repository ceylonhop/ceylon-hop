import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createApp } from '../app';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryPaymentRepo } from '../db/paymentRepo';
import { InMemoryRideOpsRepo } from '../db/rideOpsRepo';
import { InMemoryQuoteRepo } from '../db/quoteRepo';
import { InMemoryBookingCheckoutEventRepo } from '../db/bookingCheckoutEventRepo';
import { InMemoryExperienceInterestRepo } from '../db/experienceInterestRepo';
import { InMemoryNotificationLogRepo } from '../db/notificationLogRepo';
import { issueSessionCookie } from '../lib/opsMiddleware';

// Opening a booking in the ops tool waits on GET /admin/ops/bookings/:id. Each awaited read is a
// round-trip from Render to the Supabase pooler (~94 ms, /health/deep − /health on prod,
// 2026-11-05), so reading the sheet's tables one after another was over a second of the wait.
// Once the booking is in hand none of them needs another's answer.

const auth = { opsUsers: 'f@x.com:founder', googleClientId: 'cid', opsSessionSecret: 'sek' };

async function hdr() {
  const app = new Hono();
  app.get('/', (c) => { issueSessionCookie(c, 'f@x.com', 'sek', Date.now()); return c.text('ok'); });
  return { cookie: (await app.request('/')).headers.get('set-cookie')!.split(';')[0] };
}

function fixture() {
  const bookings = new InMemoryBookingRepo();
  const payments = new InMemoryPaymentRepo();
  const rideOps = new InMemoryRideOpsRepo();
  const quotes = new InMemoryQuoteRepo();
  const checkoutEvents = new InMemoryBookingCheckoutEventRepo();
  const experienceInterests = new InMemoryExperienceInterestRepo();
  const notificationLog = new InMemoryNotificationLogRepo();
  const app = createApp({
    bookings, payments, rideOps, quotes, checkoutEvents, experienceInterests, notificationLog, auth, adminApiKey: 'adminkey',
  });
  return { app, bookings, payments, rideOps, quotes, checkoutEvents, experienceInterests, notificationLog };
}

type Fixture = ReturnType<typeof fixture>;

async function seed(f: Fixture) {
  const b = await f.bookings.create({
    mode: 'single', total: 12100, amountDueNow: 12100, currency: 'USD',
    input: { from: 'Colombo Airport', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 1, date: '2030-06-22', time: '09:00',
      customer: { firstName: 'Maya', lastName: 'Silva', email: 'm@x.com', whatsapp: '+34600', country: 'ES' } },
  } as never);
  await f.bookings.setStatus(b.id, 'payment_pending');
  await f.bookings.setStatus(b.id, 'paid');
  return b;
}

// The in-memory bookings.get() looks up the booking's quote itself, which Postgres does on its own
// query, so what these tests watch starts only once the route holds the booking.
function bookingHeld(f: Fixture) {
  const held = { now: false };
  const real = f.bookings.get.bind(f.bookings);
  f.bookings.get = async (id: string) => {
    const b = await real(id);
    held.now = true;
    return b;
  };
  return held;
}

// Every read the sheet makes once it holds the booking.
const reads = (f: Fixture) => [
  [f.rideOps, 'getOrCreate'], [f.payments, 'findByBookingId'], [f.quotes, 'findByConvertedBookingId'],
  [f.bookings, 'websitePricingSnapshot'], [f.checkoutEvents, 'listByBookingId'], [f.experienceInterests, 'listForBooking'],
  [f.bookings, 'listScheduleEvents'], [f.notificationLog, 'listByBookingId'],
] as unknown as Array<[Record<string, (...args: unknown[]) => Promise<unknown>>, string]>;

describe('GET /admin/ops/bookings/:id', () => {
  it('starts every read of the sheet before any of them has finished', async () => {
    const f = fixture();
    const b = await seed(f);
    const held = bookingHeld(f);
    const started: string[] = [];
    let startedWhenFirstFinished: string[] | null = null;
    for (const [repo, method] of reads(f)) {
      const real = repo[method].bind(repo);
      repo[method] = async (...args: unknown[]) => {
        if (!held.now) return real(...args);
        started.push(method);
        await new Promise((resolve) => setTimeout(resolve, 1));
        startedWhenFirstFinished ??= [...started];
        return real(...args);
      };
    }
    const res = await f.app.request(`/admin/ops/bookings/${b.id}`, { headers: await hdr() });
    expect(res.status).toBe(200);
    expect(startedWhenFirstFinished).toEqual(expect.arrayContaining(reads(f).map(([, method]) => method)));
    expect(startedWhenFirstFinished).toHaveLength(reads(f).length);
  });

  // Same promise as before they ran together: these blocks are a courtesy, and losing one costs
  // that block only.
  it.each([
    ['the source quote', (f: Fixture) => f.quotes, 'findByConvertedBookingId'],
    ['the pricing snapshot', (f: Fixture) => f.bookings, 'websitePricingSnapshot'],
    ['the checkout log', (f: Fixture) => f.checkoutEvents, 'listByBookingId'],
    ['the reminders', (f: Fixture) => f.notificationLog, 'listByBookingId'],
    ['the experience interests', (f: Fixture) => f.experienceInterests, 'listForBooking'],
  ] as const)('still answers when %s cannot be read', async (_name, repoOf, method) => {
    const f = fixture();
    const b = await seed(f);
    const held = bookingHeld(f);
    const repo = repoOf(f) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const real = repo[method].bind(repo);
    repo[method] = async (...args: unknown[]) => {
      if (held.now) throw new Error('read failed');
      return real(...args);
    };
    const res = await f.app.request(`/admin/ops/bookings/${b.id}`, { headers: await hdr() });
    expect(res.status).toBe(200);
    expect((await res.json()).booking.id).toBe(b.id);
  });
});
