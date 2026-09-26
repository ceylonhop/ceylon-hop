import type { Sql } from './client';
import type { AnalyticsDataRange, AnalyticsDataRepo } from './analyticsDataRepo';
import type {
  AnalyticsBookingRow,
  AnalyticsCheckoutEventRow,
  AnalyticsPaymentRow,
  AnalyticsRefundRow,
  AnalyticsRideListRow,
  BusinessAnalyticsData,
} from '../services/analytics/business';

interface BookingRow {
  id: string; reference: string; channel: string; mode: string; status: string;
  total_cents: number; amount_due_now_cents: number; currency: string; created_at: Date;
  travel_date: string | null; fulfilment_status: string | null;
}
interface PaymentRow {
  id: string; booking_id: string; status: 'pending' | 'succeeded' | 'failed'; amount_cents: number;
  currency: string; created_at: Date; settled_at: Date | null; attempt_count: number; last_attempt_at: Date | null;
}
interface RefundRow { booking_id: string; amount_cents: number; currency: string; confirmed_at: Date }
interface EventRow { booking_id: string | null; at: Date; action: string; outcome: string }
interface ListRow {
  id: string; code: string; from_place: string; to_place: string; status: string; date: string;
  cutoff_at: Date; min_seats: number; capacity: number; seat_price: number; created_at: Date;
}
interface MemberRow { list_id: string; seats: number; status: string; email: string; sub: string }

const SEED_NOTE = '[seed]';
const SEED_SUB_PREFIX = 'seed-rideboard:';

export class PostgresAnalyticsDataRepo implements AnalyticsDataRepo {
  constructor(private readonly sql: Sql) {}

  async load(range: AnalyticsDataRange): Promise<BusinessAnalyticsData> {
    const emails = [...range.teamEmails].map((e) => e.trim().toLowerCase()).filter(Boolean);
    const today = new Date(range.now.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
    const teamBookingFilter = emails.length
      ? this.sql`and lower(btrim(c.email)) not in ${this.sql(emails)}`
      : this.sql``;
    const relevant = this.sql`
      (b.created_at >= ${range.previousFrom}
       or b.status = 'payment_pending'
       or exists (select 1 from payments px where px.booking_id = b.id and px.settled_at >= ${range.previousFrom})
       or exists (select 1 from refunds rx where rx.booking_id = b.id and rx.confirmed_at >= ${range.previousFrom})
       or coalesce(
            (select min(bl.travel_date) from booking_leg bl where bl.booking_id = b.id and bl.removed_at is null),
            tr.travel_date, sr.date
          ) between ${today} and ${range.upcomingThrough})`;

    const bookingRows = await this.sql<BookingRow[]>`
      select b.id, b.reference, b.channel, b.mode, b.status,
             b.total as total_cents, coalesce(b.amount_due_now, b.total) as amount_due_now_cents,
             b.currency, b.created_at,
             coalesce(
               (select min(bl.travel_date) from booking_leg bl where bl.booking_id = b.id and bl.removed_at is null),
               tr.travel_date, sr.date
             ) as travel_date,
             ro.fulfilment_status
      from bookings b
      join customers c on c.id = b.customer_id
      left join transfer_request tr on tr.booking_id = b.id
      left join shared_request sr on sr.booking_id = b.id
      left join ride_ops ro on ro.booking_id = b.id
      where ${relevant} ${teamBookingFilter}
      order by b.created_at desc
      limit ${range.limit + 1}`;
    const truncatedBookings = bookingRows.length > range.limit;
    const keptBookings = bookingRows.slice(0, range.limit);
    const ids = keptBookings.map((b) => b.id);

    const payments = ids.length ? await this.sql<PaymentRow[]>`
      select id, booking_id, status, amount as amount_cents, currency, created_at, settled_at,
             attempt_count, last_attempt_at
      from payments where booking_id in ${this.sql(ids)}` : [];
    const refunds = ids.length ? await this.sql<RefundRow[]>`
      select booking_id, amount_cents, currency, confirmed_at
      from refunds
      where booking_id in ${this.sql(ids)}
        and status in ('manual_confirmed','api_confirmed') and confirmed_at is not null` : [];
    const events = ids.length ? await this.sql<EventRow[]>`
      select booking_id, at, action, outcome
      from booking_checkout_event
      where booking_id in ${this.sql(ids)} and at >= ${range.previousFrom}
      order by at asc limit ${range.limit * 5 + 1}` : [];

    const listRows = await this.sql<ListRow[]>`
      select id, code, from_place, to_place, status, date, cutoff_at, min_seats, capacity,
             seat_price, created_at
      from ride_list
      where (created_at >= ${range.previousFrom} or date between ${today} and ${range.upcomingThrough})
        and coalesce(note, '') not like ${'%' + SEED_NOTE + '%'}
      order by created_at desc limit ${range.limit + 1}`;
    const keptLists = listRows.slice(0, range.limit);
    const listIds = keptLists.map((l) => l.id);
    const memberRows = listIds.length ? await this.sql<MemberRow[]>`
      select list_id, seats, status, email, sub from ride_list_member
      where list_id in ${this.sql(listIds)}` : [];
    const teamMembers = memberRows.filter((m) => emails.includes(m.email.trim().toLowerCase()));
    const members = memberRows.filter((m) =>
      !emails.includes(m.email.trim().toLowerCase()) && !m.sub.startsWith(SEED_SUB_PREFIX),
    );
    // A list created only for a team member's testing is internal data too. Keep genuinely
    // empty public lists, and keep real lists after removing any internal members from them.
    const publicLists = keptLists.filter((list) => {
      const allMembers = memberRows.filter((m) => m.list_id === list.id);
      return allMembers.length === 0 || members.some((m) => m.list_id === list.id);
    });

    const [{ count: teamBookingCount }] = emails.length
      ? await this.sql<{ count: number }[]>`
          select count(*)::int as count from bookings b
          join customers c on c.id = b.customer_id
          left join transfer_request tr on tr.booking_id = b.id
          left join shared_request sr on sr.booking_id = b.id
          where ${relevant} and lower(btrim(c.email)) in ${this.sql(emails)}`
      : [{ count: 0 }];
    const [{ count: seedListCount }] = await this.sql<{ count: number }[]>`
      select count(*)::int as count from ride_list
      where (created_at >= ${range.previousFrom} or date between ${today} and ${range.upcomingThrough})
        and coalesce(note, '') like ${'%' + SEED_NOTE + '%'}`;
    const [{ count: teamQuoteCount }] = emails.length
      ? await this.sql<{ count: number }[]>`
          select count(*)::int as count from quotes
          where deleted_at is null
            and lower(btrim(customer_contact)) in ${this.sql(emails)}
            and (created_at >= ${range.previousFrom} or sent_at >= ${range.previousFrom}
                 or decided_at >= ${range.previousFrom}
                 or status in ('draft','sent','viewed'))`
      : [{ count: 0 }];

    const bookings: AnalyticsBookingRow[] = keptBookings.map((b) => ({
      id: b.id, reference: b.reference, channel: b.channel, mode: b.mode, status: b.status,
      totalCents: b.total_cents, amountDueNowCents: b.amount_due_now_cents, currency: b.currency,
      createdAt: new Date(b.created_at), travelDate: b.travel_date,
      fulfilmentStatus: b.fulfilment_status,
    }));
    const paymentRows: AnalyticsPaymentRow[] = payments.map((p) => ({
      id: p.id, bookingId: p.booking_id, status: p.status, amountCents: p.amount_cents,
      currency: p.currency, createdAt: new Date(p.created_at),
      settledAt: p.settled_at ? new Date(p.settled_at) : null, attemptCount: p.attempt_count,
      lastAttemptAt: p.last_attempt_at ? new Date(p.last_attempt_at) : null,
    }));
    const refundRows: AnalyticsRefundRow[] = refunds.map((r) => ({
      bookingId: r.booking_id, amountCents: r.amount_cents, currency: r.currency,
      confirmedAt: new Date(r.confirmed_at),
    }));
    const checkoutEvents: AnalyticsCheckoutEventRow[] = events.slice(0, range.limit * 5).map((e) => ({
      bookingId: e.booking_id, at: new Date(e.at), action: e.action, outcome: e.outcome,
    }));
    const rideLists: AnalyticsRideListRow[] = publicLists.map((l) => ({
      id: l.id, code: l.code, from: l.from_place, to: l.to_place, status: l.status,
      date: l.date, cutoffAt: new Date(l.cutoff_at), minSeats: l.min_seats, capacity: l.capacity,
      seatPriceCents: l.seat_price, createdAt: new Date(l.created_at),
      members: members.filter((m) => m.list_id === l.id).map((m) => ({ seats: m.seats, status: m.status })),
    }));

    return {
      bookings, payments: paymentRows, refunds: refundRows, checkoutEvents, rideLists,
      excluded: {
        teamBookings: teamBookingCount,
        teamQuoteContacts: teamQuoteCount,
        seedRideLists: seedListCount,
        teamRideMembers: teamMembers.length,
      },
      truncated: truncatedBookings || events.length > range.limit * 5 || listRows.length > range.limit,
    };
  }
}
