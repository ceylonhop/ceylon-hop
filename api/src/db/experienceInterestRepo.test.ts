import { beforeAll, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client';
import { InMemoryBookingRepo, type BookingRepo, type NewBooking } from './bookingRepo';
import { InMemoryQuoteRepo, type NewQuote, type QuoteRepo, type QuoteStatus } from './quoteRepo';
import { PostgresBookingRepo } from './postgresBookingRepo';
import { PostgresQuoteRepo } from './postgresQuoteRepo';
import { InMemoryExperienceRepo, type ExperienceRepo } from './experienceRepo';
import { PostgresExperienceRepo } from './postgresExperienceRepo';
import { InMemoryExperienceInterestRepo, type ExperienceInterestRepo } from './experienceInterestRepo';
import { PostgresExperienceInterestRepo } from './postgresExperienceInterestRepo';
import { ExperienceInputSchema, type Experience } from '../experiences/experience';
import { futureIsoDate } from '../testSupport/dates';
import type { BookingStatus } from '../domain/status';

// One contract, two implementations (same idea as experienceRepo.test.ts). The Postgres block needs
// DATABASE_URL_TEST; the test database is shared and outlives the run, so every assertion looks only
// at rows this run created.
const TEST_URL = process.env.DATABASE_URL_TEST;

interface Env {
  interests: ExperienceInterestRepo;
  experiences: ExperienceRepo;
  bookings: BookingRepo;
  quotes: QuoteRepo;
}

const customer = { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' };
const single = (date?: string): NewBooking => ({
  mode: 'single',
  input: { from: 'Colombo Airport', to: 'Sigiriya', vehicleType: 'car', adults: 2, children: 0, bags: 2, customer, ...(date ? { date } : {}) },
  total: 5000, amountDueNow: 5000, currency: 'USD',
});
const newQuote = (legs: unknown[]): NewQuote => ({
  product: 'private', vehicle: 'car', customerName: 'Quote Customer', customerContact: '+94770000000',
  totalCents: 4048, currency: 'USD', rateCardVersion: '2026-06-28', marginCents: 900,
  request: { tool: { legs } }, result: { totalCents: 4048 },
});

const PATH: Record<string, BookingStatus[]> = {
  draft: [],
  paid: ['payment_pending', 'paid'],
  completed: ['payment_pending', 'paid', 'confirmed', 'in_progress', 'completed'],
  cancelled: ['cancelled'],
};

function contract(name: string, make: () => Promise<Env>) {
  describe(name, () => {
    let env: Env;
    let n = 0;
    beforeAll(async () => { env = await make(); });

    const experience = (over: Partial<{ priceCents: number; name: string; areaLabel: string }> = {}) =>
      env.experiences.create(ExperienceInputSchema.parse({
        slug: `int-${Date.now()}-${n++}`, name: over.name ?? 'Ayurvedic massage', partnerName: 'Atherya Spa',
        areaLabel: over.areaLabel ?? 'Sigiriya', summary: 's', priceCents: over.priceCents ?? 3500,
        priceUnit: 'per_person', openWeekdays: [1], startTimes: [], lat: 7.97, lng: 80.76,
      }));
    const booking = async (status: keyof typeof PATH, date?: string) => {
      const b = await env.bookings.create(single(date));
      for (const to of PATH[status]!) await env.bookings.setStatus(b.id, to, to === 'cancelled' ? { reason: 'test', by: 'f@x.com' } : undefined);
      return b;
    };
    const quote = async (status: QuoteStatus, legs: unknown[] = [{ from: 'A', to: 'B' }]) => {
      const q = await env.quotes.save(newQuote(legs));
      if (status !== 'draft') await env.quotes.patch(q.id, { status });
      return q;
    };
    const record = (e: Experience, o: { bookingId?: string; quoteId?: string }) =>
      env.interests.record({ experience: e, source: o.bookingId ? 'booking_page' : 'quote_page', ...o });

    it('record is idempotent per (experience, booking) and per (experience, quote)', async () => {
      const e = await experience();
      const b = await booking('paid');
      const first = await record(e, { bookingId: b.id });
      expect((await record(e, { bookingId: b.id })).id).toBe(first.id);
      const q = await quote('sent');
      const qi = await record(e, { quoteId: q.id });
      expect((await record(e, { quoteId: q.id })).id).toBe(qi.id);
      expect(qi.id).not.toBe(first.id);
      expect(first).toMatchObject({ experienceId: e.id, bookingId: b.id, quoteId: null, source: 'booking_page', status: 'new' });
    });

    it('snapshots come from the experience and survive a later price change', async () => {
      const e = await experience({ priceCents: 3500, name: 'Cooking lesson' });
      const b = await booking('paid');
      const i = await record(e, { bookingId: b.id });
      expect(i).toMatchObject({ nameSnapshot: 'Cooking lesson', priceCentsSnapshot: 3500, priceUnitSnapshot: 'per_person' });
      await env.experiences.patch(e.id, { priceCents: 9900, name: 'Renamed' });
      expect(await env.interests.get(i.id)).toMatchObject({ nameSnapshot: 'Cooking lesson', priceCentsSnapshot: 3500 });
    });

    it('withdrawFromQuote deletes a new row, and keeps one ops has acted on', async () => {
      const e = await experience();
      const q = await quote('sent');
      const i = await record(e, { quoteId: q.id });
      expect(await env.interests.withdrawFromQuote(e.id, q.id)).toBe(true);
      expect(await env.interests.get(i.id)).toBeNull();
      expect(await env.interests.withdrawFromQuote(e.id, q.id)).toBe(false);

      const again = await record(e, { quoteId: q.id });
      await env.interests.patch(again.id, { status: 'contacted', updatedBy: 'ops@x.com' });
      expect(await env.interests.withdrawFromQuote(e.id, q.id)).toBe(false);
      expect(await env.interests.get(again.id)).not.toBeNull();
    });

    it('linkQuoteToBooking sets bookingId once, and is a no-op the second time', async () => {
      const e1 = await experience();
      const e2 = await experience();
      const q = await quote('sent');
      const i1 = await record(e1, { quoteId: q.id });
      const i2 = await record(e2, { quoteId: q.id });
      const b = await booking('paid');
      expect(await env.interests.linkQuoteToBooking(q.id, b.id)).toBe(2);
      expect(await env.interests.get(i1.id)).toMatchObject({ bookingId: b.id, quoteId: q.id });
      expect(await env.interests.linkQuoteToBooking(q.id, b.id)).toBe(0);
      expect((await env.interests.listForBooking(b.id)).map((x) => x.id).sort()).toEqual([i1.id, i2.id].sort());
    });

    it('linkQuoteToBooking skips an experience the booking already has an interest in', async () => {
      const e = await experience();
      const q = await quote('sent');
      const b = await booking('paid');
      const fromBooking = await record(e, { bookingId: b.id });
      const fromQuote = await record(e, { quoteId: q.id });
      expect(await env.interests.linkQuoteToBooking(q.id, b.id)).toBe(0);
      expect((await env.interests.get(fromQuote.id))!.bookingId).toBeNull();
      expect((await env.interests.listForBooking(b.id)).map((x) => x.id)).toEqual([fromBooking.id]);
    });

    it('listForQuote returns the quote’s interests', async () => {
      const e = await experience();
      const q = await quote('sent');
      const i = await record(e, { quoteId: q.id });
      expect((await env.interests.listForQuote(q.id)).map((x) => x.id)).toEqual([i.id]);
      expect(await env.interests.listForBooking('00000000-0000-4000-8000-000000000000')).toEqual([]);
    });

    it('patch records status, payment and note; "paid" needs a reference; unknown id is null', async () => {
      const e = await experience();
      const b = await booking('paid');
      const i = await record(e, { bookingId: b.id });
      await expect(env.interests.patch(i.id, { status: 'paid', updatedBy: 'ops@x.com' })).rejects.toThrow();
      expect((await env.interests.get(i.id))!.status).toBe('new');

      await new Promise((r) => setTimeout(r, 5));
      const paid = await env.interests.patch(i.id, {
        status: 'paid', paymentRef: 'PH-123', amountPaidCents: 3500, amountPaidCurrency: 'USD', opsNote: 'paid by link', updatedBy: 'ops@x.com',
      });
      expect(paid).toMatchObject({
        status: 'paid', paymentRef: 'PH-123', amountPaidCents: 3500, amountPaidCurrency: 'USD', opsNote: 'paid by link', updatedBy: 'ops@x.com',
      });
      expect(paid!.updatedAt.getTime()).toBeGreaterThan(i.updatedAt.getTime());

      // a later status-only patch keeps the reference it already has
      expect(await env.interests.patch(i.id, { status: 'declined', updatedBy: 'ops@x.com' })).toMatchObject({ status: 'declined', paymentRef: 'PH-123' });
      expect(await env.interests.patch('00000000-0000-4000-8000-000000000000', { status: 'contacted', updatedBy: 'x' })).toBeNull();
    });

    describe('listLeads (spec D15)', () => {
      it('includes interests on paid / completed bookings and on ready / sent quotes', async () => {
        const e = await experience({ name: 'Jeep safari', areaLabel: 'Sigiriya' });
        const date = futureIsoDate(40);
        const paid = await record(e, { bookingId: (await booking('paid', date)).id });
        const done = await record(e, { bookingId: (await booking('completed')).id });
        const sent = await record(e, { quoteId: (await quote('sent')).id });
        const ready = await record(e, { quoteId: (await quote('ready')).id });
        const ids = (await env.interests.listLeads(500)).map((l) => l.id);
        for (const i of [paid, done, sent, ready]) expect(ids).toContain(i.id);
      });

      it('excludes drafts, cancelled bookings, lost / draft / deleted quotes, and finished leads', async () => {
        const e = await experience();
        const draft = await record(e, { bookingId: (await booking('draft')).id });
        const cancelled = await record(e, { bookingId: (await booking('cancelled')).id });
        const lost = await record(e, { quoteId: (await quote('lost')).id });
        const draftQuote = await record(e, { quoteId: (await quote('draft')).id });
        const deletedQuote = await quote('sent');
        const deleted = await record(e, { quoteId: deletedQuote.id });
        await env.quotes.softDelete(deletedQuote.id, 'f@x.com');
        const paidLead = await record(e, { bookingId: (await booking('paid')).id });
        await env.interests.patch(paidLead.id, { status: 'paid', paymentRef: 'PH-1', updatedBy: 'o@x.com' });
        const declinedLead = await record(e, { bookingId: (await booking('paid')).id });
        await env.interests.patch(declinedLead.id, { status: 'declined', updatedBy: 'o@x.com' });
        const open = await record(e, { bookingId: (await booking('paid')).id });
        await env.interests.patch(open.id, { status: 'link_sent', updatedBy: 'o@x.com' });

        const ids = (await env.interests.listLeads(500)).map((l) => l.id);
        for (const i of [draft, cancelled, lost, draftQuote, deleted, paidLead, declinedLead]) expect(ids).not.toContain(i.id);
        expect(ids).toContain(open.id);
      });

      it('carries reference, customer, contact, travel date, area and experience name — booking and quote', async () => {
        const e = await experience({ name: 'Elephant jeep safari', areaLabel: 'Minneriya' });
        const date = futureIsoDate(45);
        const b = await booking('paid', date);
        const bi = await record(e, { bookingId: b.id });
        const q = await quote('sent', [{ from: 'A', to: 'B' }, { from: 'B', to: 'C', date: '2099-02-02' }, { from: 'C', to: 'D', date: '2099-03-03' }]);
        const qi = await record(e, { quoteId: q.id });

        const leads = await env.interests.listLeads(500);
        const bl = leads.find((l) => l.id === bi.id)!;
        const ql = leads.find((l) => l.id === qi.id)!;
        expect(bl).toMatchObject({
          ownerKind: 'booking', reference: b.reference, customerName: 'Maya Silva', contact: '+34600000000',
          travelDate: date, areaLabel: 'Minneriya', experienceName: 'Elephant jeep safari', status: 'new',
        });
        expect(ql).toMatchObject({
          ownerKind: 'quote', reference: q.reference, customerName: 'Quote Customer', contact: '+94770000000',
          travelDate: '2099-02-02', areaLabel: 'Minneriya', experienceName: 'Elephant jeep safari',
        });
      });

      it('travelDate is null when nothing is dated, and a trip uses its earliest leg date', async () => {
        const e = await experience();
        const undated = await record(e, { bookingId: (await booking('paid')).id });
        const later = futureIsoDate(60);
        const earlier = futureIsoDate(50);
        const trip = await env.bookings.create({
          mode: 'trip', total: 1000, amountDueNow: 1000, currency: 'USD',
          input: { stops: ['Colombo', 'Sigiriya', 'Kandy'], nights: [1, 1], dates: [later, earlier], pax: 2, vehicleType: 'car', serviceType: 'private', customer },
        } as NewBooking);
        await env.bookings.setStatus(trip.id, 'payment_pending');
        await env.bookings.setStatus(trip.id, 'paid');
        const tripLead = await record(e, { bookingId: trip.id });
        const leads = await env.interests.listLeads(500);
        expect(leads.find((l) => l.id === undated.id)!.travelDate).toBeNull();
        expect(leads.find((l) => l.id === tripLead.id)!.travelDate).toBe(earlier);
      });

      it('lists newest first and honours the limit', async () => {
        const e = await experience();
        const a = await record(e, { bookingId: (await booking('paid')).id });
        await new Promise((r) => setTimeout(r, 5));
        const b = await record(e, { bookingId: (await booking('paid')).id });
        expect((await env.interests.listLeads(2)).map((l) => l.id)).toEqual([b.id, a.id]);
        expect(await env.interests.listLeads(1)).toHaveLength(1);
      });
    });

    // Same owner filter as listLeads (spec D10/D15), but across ALL statuses: an abandoned draft
    // checkout or a deleted quote must not inflate the owner's per-experience numbers.
    it('stats counts only real leads: not draft or cancelled bookings, not deleted quotes', async () => {
      const e = await experience();
      const real = await record(e, { bookingId: (await booking('paid')).id });
      const done = await record(e, { bookingId: (await booking('completed')).id });
      await record(e, { bookingId: (await booking('draft')).id });
      await record(e, { bookingId: (await booking('cancelled')).id });
      await record(e, { quoteId: (await quote('lost')).id }); // a lost quote is still a real lead
      const gone = await quote('sent');
      await record(e, { quoteId: gone.id });
      await env.quotes.softDelete(gone.id, 'f@x.com');
      await env.interests.patch(real.id, { status: 'paid', paymentRef: 'A', amountPaidCents: 3500, amountPaidCurrency: 'USD', updatedBy: 'o' });
      await env.interests.patch(done.id, { status: 'declined', updatedBy: 'o' });
      const s = (await env.interests.stats()).find((x) => x.experienceId === e.id)!;
      expect(s).toEqual({ experienceId: e.id, interested: 3, paid: 1, paidCents: { USD: 3500, LKR: 0 } });
    });

    it('stats counts interested and paid and sums paid cents per currency', async () => {
      const e = await experience();
      const mk = async () => record(e, { bookingId: (await booking('paid')).id });
      const i1 = await mk();
      const i2 = await mk();
      await mk();
      await env.interests.patch(i1.id, { status: 'paid', paymentRef: 'A', amountPaidCents: 3500, amountPaidCurrency: 'USD', updatedBy: 'o' });
      await env.interests.patch(i2.id, { status: 'paid', paymentRef: 'B', amountPaidCents: 1000000, amountPaidCurrency: 'LKR', updatedBy: 'o' });
      const s = (await env.interests.stats()).find((x) => x.experienceId === e.id)!;
      expect(s).toEqual({ experienceId: e.id, interested: 3, paid: 2, paidCents: { USD: 3500, LKR: 1000000 } });
    });
  });
}

contract('InMemoryExperienceInterestRepo', async () => {
  const bookings = new InMemoryBookingRepo();
  const quotes = new InMemoryQuoteRepo();
  const experiences = new InMemoryExperienceRepo();
  return { bookings, quotes, experiences, interests: new InMemoryExperienceInterestRepo({ bookings, quotes, experiences }) };
});

describe.skipIf(!TEST_URL)('PostgresExperienceInterestRepo', () => {
  contract('PostgresExperienceInterestRepo contract', async () => {
    const conn = createDb(TEST_URL as string);
    await migrate(conn.db, { migrationsFolder: 'drizzle' });
    return {
      bookings: new PostgresBookingRepo(conn.db), quotes: new PostgresQuoteRepo(conn.db),
      experiences: new PostgresExperienceRepo(conn.db), interests: new PostgresExperienceInterestRepo(conn.db),
    };
  });
});
