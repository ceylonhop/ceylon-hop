// Promo code uses, counted from bookings (spec 2026-09-14 §5, §6.3). Exported so postgres.test.ts
// runs the SAME cases against Postgres: the SQL count and promoUseState() must never disagree.
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { InMemoryBookingRepo, type BookingRepo, type NewBooking } from './bookingRepo';
import { InMemoryPaymentRepo, type PaymentRepo } from './paymentRepo';
import { InMemoryPromoCodeRepo, type PromoCodeRepo } from './promoCodeRepo';
import { makePromoCode } from './promoCodeRepo.test';
import { PROMO_HOLD_MS, PromoCodeRefusedError, type PromoCode } from '../domain/promoCode';

const HOUR = 3_600_000;

export interface PromoEnv { bookings: BookingRepo; payments: PaymentRepo; promoCodes: PromoCodeRepo }

const sample = (): NewBooking => ({
  mode: 'single',
  input: {
    from: 'Colombo Airport (CMB)', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 2,
    customer: { firstName: 'Maya', lastName: 'Silva', email: `maya+${randomUUID().slice(0, 6)}@example.com`, whatsapp: '+34600000000', country: 'Spain' },
  },
  total: 7020,
  amountDueNow: 7020,
  currency: 'USD',
  discountTotal: 780,
});

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof PromoCodeRefusedError) return err.code;
    throw err;
  }
  return 'accepted';
}

export function bookingPromoContract(name: string, make: () => Promise<PromoEnv>): void {
  describe(name, () => {
    const T0 = new Date(Math.floor(Date.now() / 1000) * 1000);
    const at = (ms: number) => new Date(T0.getTime() + ms);

    async function setup(over: Parameters<typeof makePromoCode>[0] = {}) {
      const env = await make();
      const code = await env.promoCodes.create(makePromoCode({ expiresAt: at(30 * 24 * HOUR), ...over }), T0);
      const book = (now: Date = T0, c: PromoCode = code) => env.bookings.create(sample(), { promo: { code: c, now } });
      const markPaid = async (bookingId: string, reference: string, manual = false) => {
        const p = await env.payments.create({
          bookingId, provider: 'fake', orderId: `${reference}-${randomUUID().slice(0, 6)}`,
          amount: 7020, currency: 'USD', idempotencyKey: `pay-${bookingId}`,
        });
        // Unique per call: payments has UNIQUE (provider, gateway_payment_id), and a reused test DB
        // keeps the rows from earlier runs.
        if (manual) await env.payments.markSucceededManually(p.id, { reference: `bank-${randomUUID().slice(0, 8)}`, settledBy: 'f@x.com' });
        else await env.payments.markSucceeded(p.id);
      };
      return { env, code, book, markPaid };
    }

    it('stores the code, the hold and the discount on the booking', async () => {
      const { env, code, book } = await setup();
      const b = await book();
      expect(b.promoCodeId).toBe(code.id);
      expect(b.promoHoldUntil).toBe(at(PROMO_HOLD_MS).toISOString());
      expect(b.mode === 'single' && b.discountTotal).toBe(780);
      const read = await env.bookings.get(b.id);
      expect(read?.promoCodeId).toBe(code.id);
      expect(read?.promoHoldUntil).toBe(at(PROMO_HOLD_MS).toISOString());
      expect(read?.mode === 'single' && read.discountTotal).toBe(780);
    });

    it('counts a held booking until its hold passes, with no clean-up job', async () => {
      const { env, code, book } = await setup();
      await book();
      expect(await env.bookings.promoUsage(code.id, T0)).toEqual({ paid: 0, held: 1 });
      expect(await env.bookings.promoUsage(code.id, at(PROMO_HOLD_MS - 1))).toEqual({ paid: 0, held: 1 });
      expect(await env.bookings.promoUsage(code.id, at(PROMO_HOLD_MS))).toEqual({ paid: 0, held: 0 });
    });

    it('refuses when every use is taken, and frees a use once a hold passes', async () => {
      const { book } = await setup({ maxUses: 1 });
      await book();
      expect(await refusal(book(T0))).toBe('promo_code_used_up');
      expect(await refusal(book(at(PROMO_HOLD_MS + 1)))).toBe('accepted');
    });

    it('refuses a switched-off, not-started or expired code', async () => {
      const { env, code, book } = await setup({ startsAt: at(HOUR), expiresAt: at(3 * HOUR) });
      expect(await refusal(book(T0))).toBe('promo_code_not_started');
      expect(await refusal(book(at(3 * HOUR)))).toBe('promo_code_expired');
      const off = await env.promoCodes.update(code.id, { active: false, updatedBy: 'f@x.com' }, T0);
      expect(await refusal(book(at(2 * HOUR), off!))).toBe('promo_code_invalid');
    });

    it('counts a paid booking for good, even after it is cancelled', async () => {
      const { env, code, book, markPaid } = await setup();
      const b = await book();
      await markPaid(b.id, b.reference);
      await env.bookings.setStatus(b.id, 'payment_pending');
      await env.bookings.setStatus(b.id, 'paid');
      await env.bookings.setStatus(b.id, 'cancelled', { reason: 'customer asked', by: 'f@x.com' });
      expect(await env.bookings.promoUsage(code.id, at(3 * HOUR))).toEqual({ paid: 1, held: 0 });
    });

    it('counts a succeeded payment even before the status catches up (manual mark-paid)', async () => {
      const { env, code, book, markPaid } = await setup();
      const b = await book();
      await env.bookings.setStatus(b.id, 'payment_pending');
      await markPaid(b.id, b.reference, true);
      expect(await env.bookings.promoUsage(code.id, at(3 * HOUR))).toEqual({ paid: 1, held: 0 });
    });

    it('frees the use at once when a booking is cancelled before payment', async () => {
      const { env, code, book } = await setup();
      const b = await book();
      await env.bookings.setStatus(b.id, 'cancelled', { reason: 'changed plans', by: 'f@x.com' });
      expect(await env.bookings.promoUsage(code.id, T0)).toEqual({ paid: 0, held: 0 });
    });

    it('treats awaiting_details as held', async () => {
      const { env, code, book } = await setup();
      const b = await book();
      await env.bookings.setStatus(b.id, 'awaiting_details');
      expect(await env.bookings.promoUsage(code.id, T0)).toEqual({ paid: 0, held: 1 });
    });

    it('lists the bookings that carried a code, newest first, classified', async () => {
      const { env, code, book } = await setup();
      const first = await book(T0);
      await new Promise((r) => setTimeout(r, 5)); // distinct wall-clock createdAt
      const second = await book(at(1000));
      await env.bookings.setStatus(first.id, 'cancelled', { reason: 'x', by: 'f@x.com' });
      const uses = await env.bookings.promoBookings(code.id, at(2000));
      expect(uses.map((u) => [u.bookingId, u.use])).toEqual([[second.id, 'held'], [first.id, 'released']]);
      expect(uses[0]).toMatchObject({ reference: second.reference, status: 'draft', discountCents: 780 });
    });

    describe('reholdPromo (§6.3)', () => {
      it('refreshes a valid hold, even when the code has since been switched off', async () => {
        const { env, code, book } = await setup();
        const b = await book(T0);
        const off = await env.promoCodes.update(code.id, { active: false, updatedBy: 'f@x.com' }, T0);
        await env.bookings.reholdPromo(b.id, off!, at(HOUR));
        expect((await env.bookings.get(b.id))?.promoHoldUntil).toBe(at(HOUR + PROMO_HOLD_MS).toISOString());
      });

      it('re-holds a lapsed hold when a use is free', async () => {
        const { env, code, book } = await setup();
        const b = await book(T0);
        await env.bookings.reholdPromo(b.id, code, at(3 * HOUR));
        expect((await env.bookings.get(b.id))?.promoHoldUntil).toBe(at(3 * HOUR + PROMO_HOLD_MS).toISOString());
      });

      it('refuses a lapsed hold when the code is full, off or expired', async () => {
        const full = await setup({ maxUses: 1 });
        const a = await full.book(T0);
        await full.book(at(3 * HOUR)); // A lapsed, so B takes the only use
        expect(await refusal(full.env.bookings.reholdPromo(a.id, full.code, at(3 * HOUR)))).toBe('promo_code_used_up');

        const off = await setup();
        const b = await off.book(T0);
        const switched = await off.env.promoCodes.update(off.code.id, { active: false, updatedBy: 'f@x.com' }, T0);
        expect(await refusal(off.env.bookings.reholdPromo(b.id, switched!, at(3 * HOUR)))).toBe('promo_code_invalid');

        const expiring = await setup({ expiresAt: at(HOUR) });
        const c = await expiring.book(T0);
        expect(await refusal(expiring.env.bookings.reholdPromo(c.id, expiring.code, at(3 * HOUR)))).toBe('promo_code_expired');
      });
    });

    it('never gives away more uses than the limit under concurrent bookings', async () => {
      const { env, code, book } = await setup({ maxUses: 3 });
      const results = await Promise.allSettled(Array.from({ length: 10 }, () => book(T0)));
      const accepted = results.filter((r) => r.status === 'fulfilled');
      const refused = results.filter(
        (r) => r.status === 'rejected' && r.reason instanceof PromoCodeRefusedError && r.reason.code === 'promo_code_used_up',
      );
      expect(accepted).toHaveLength(3);
      expect(refused).toHaveLength(7);
      expect(await env.bookings.promoUsage(code.id, T0)).toEqual({ paid: 0, held: 3 });
    });
  });
}

bookingPromoContract('InMemoryBookingRepo', async () => {
  const bookings = new InMemoryBookingRepo();
  const payments = new InMemoryPaymentRepo();
  bookings.attachPayments(payments);
  return { bookings, payments, promoCodes: new InMemoryPromoCodeRepo() };
});
