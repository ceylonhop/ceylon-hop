import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './client';
import { experienceInterests } from './schema';
import {
  firstQuoteTravelDate, LIVE_QUOTE_STATUSES, OPEN_STATUSES, PAID_BOOKING_STATUSES,
  type ConfirmationChannel, type ExperienceInterest, type ExperienceInterestRepo, type ExperienceStats, type InterestPatch,
  type InterestSource, type Lead,
} from './experienceInterestRepo';
import type { Experience } from '../experiences/experience';

type Row = typeof experienceInterests.$inferSelect;

function toInterest(r: Row): ExperienceInterest {
  return {
    id: r.id, experienceId: r.experienceId, bookingId: r.bookingId, quoteId: r.quoteId,
    source: r.source as InterestSource, nameSnapshot: r.nameSnapshot, priceCentsSnapshot: r.priceCentsSnapshot,
    priceUnitSnapshot: r.priceUnitSnapshot as ExperienceInterest['priceUnitSnapshot'],
    status: r.status as ExperienceInterest['status'], paymentRef: r.paymentRef, amountPaidCents: r.amountPaidCents,
    amountPaidCurrency: r.amountPaidCurrency as ExperienceInterest['amountPaidCurrency'], opsNote: r.opsNote,
    scheduledDate: r.scheduledDate, scheduledTime: r.scheduledTime, meetingPoint: r.meetingPoint,
    confirmationSentAt: r.confirmationSentAt, confirmationChannel: r.confirmationChannel as ConfirmationChannel | null, updatedBy: r.updatedBy, createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

export class PostgresExperienceInterestRepo implements ExperienceInterestRepo {
  constructor(private readonly db: Db) {}

  async record(i: { experience: Experience; source: InterestSource; bookingId?: string; quoteId?: string }): Promise<ExperienceInterest> {
    // ON CONFLICT DO NOTHING covers both partial unique indexes; then read back whichever row won.
    await this.db.insert(experienceInterests).values({
      experienceId: i.experience.id, bookingId: i.bookingId ?? null, quoteId: i.quoteId ?? null, source: i.source,
      nameSnapshot: i.experience.name, priceCentsSnapshot: i.experience.priceCents, priceUnitSnapshot: i.experience.priceUnit,
    }).onConflictDoNothing();
    const owner = i.bookingId ? eq(experienceInterests.bookingId, i.bookingId) : eq(experienceInterests.quoteId, i.quoteId ?? '');
    const rows = await this.db.select().from(experienceInterests)
      .where(and(eq(experienceInterests.experienceId, i.experience.id), owner)).limit(1);
    return toInterest(rows[0]!);
  }

  async get(id: string): Promise<ExperienceInterest | null> {
    const rows = await this.db.select().from(experienceInterests).where(eq(experienceInterests.id, id)).limit(1);
    return rows[0] ? toInterest(rows[0]) : null;
  }

  async withdrawFromQuote(experienceId: string, quoteId: string): Promise<boolean> {
    const rows = await this.db.delete(experienceInterests)
      .where(and(eq(experienceInterests.experienceId, experienceId), eq(experienceInterests.quoteId, quoteId), eq(experienceInterests.status, 'new')))
      .returning({ id: experienceInterests.id });
    return rows.length > 0;
  }

  async linkQuoteToBooking(quoteId: string, bookingId: string): Promise<number> {
    const rows = await this.db.execute(sql`
      UPDATE experience_interests i SET booking_id = ${bookingId}, updated_at = now()
      WHERE i.quote_id = ${quoteId} AND i.booking_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM experience_interests x WHERE x.experience_id = i.experience_id AND x.booking_id = ${bookingId})
      RETURNING i.id`);
    return rows.length;
  }

  async listForBooking(bookingId: string): Promise<ExperienceInterest[]> {
    const rows = await this.db.select().from(experienceInterests).where(eq(experienceInterests.bookingId, bookingId)).orderBy(experienceInterests.createdAt);
    return rows.map(toInterest);
  }

  async listForQuote(quoteId: string): Promise<ExperienceInterest[]> {
    const rows = await this.db.select().from(experienceInterests).where(eq(experienceInterests.quoteId, quoteId)).orderBy(experienceInterests.createdAt);
    return rows.map(toInterest);
  }

  // ONE statement (spec D15): the ops bookings list was N+1 until #703, so a per-row lookup here
  // would repeat it. Open leads only, on real bookings (post-payment) and live, undeleted quotes.
  async listLeads(limit: number): Promise<Lead[]> {
    const rows = await this.db.execute<{
      id: string; experience_id: string; booking_id: string | null; quote_id: string | null; source: string;
      name_snapshot: string; price_cents_snapshot: number; price_unit_snapshot: string; status: string;
      payment_ref: string | null; amount_paid_cents: number | null; amount_paid_currency: string | null;
      ops_note: string | null; scheduled_date_text: string | null; scheduled_time: string | null; meeting_point: string | null;
      confirmation_sent_at: string | Date | null; confirmation_channel: string | null; updated_by: string | null; created_at: string | Date; updated_at: string | Date;
      area_label: string; experience_name: string;
      booking_ref: string | null; first_name: string | null; last_name: string | null; whatsapp: string | null;
      booking_travel_date: string | null;
      quote_ref: string | null; quote_customer: string | null; quote_contact: string | null; quote_request: unknown;
    }>(sql`
      SELECT i.*, i.scheduled_date::text AS scheduled_date_text, e.area_label, e.name AS experience_name,
             b.reference AS booking_ref, c.first_name, c.last_name, c.whatsapp,
             (SELECT min(l.travel_date) FROM booking_legs l WHERE l.booking_id = b.id) AS booking_travel_date,
             q.reference AS quote_ref, q.customer_name AS quote_customer, q.customer_contact AS quote_contact,
             q.request_json AS quote_request
      FROM experience_interests i
      JOIN experiences e ON e.id = i.experience_id
      LEFT JOIN bookings b ON b.id = i.booking_id
      LEFT JOIN customers c ON c.id = b.customer_id
      LEFT JOIN quotes q ON q.id = i.quote_id
      WHERE (i.status IN (${sql.join(OPEN_STATUSES.map((s) => sql`${s}`), sql`, `)})
             OR (i.status = 'paid' AND i.confirmation_sent_at IS NULL
                 AND (i.scheduled_date IS NULL OR i.scheduled_date >= (now() AT TIME ZONE 'Asia/Colombo')::date)))
        AND ( (i.booking_id IS NOT NULL AND b.status IN (${sql.join(PAID_BOOKING_STATUSES.map((s) => sql`${s}`), sql`, `)}))
           OR (i.booking_id IS NULL AND q.status IN (${sql.join(LIVE_QUOTE_STATUSES.map((s) => sql`${s}`), sql`, `)}) AND q.deleted_at IS NULL) )
      ORDER BY i.created_at DESC
      LIMIT ${limit}`);
    return rows.map((r): Lead => {
      const isBooking = r.booking_id != null;
      // A raw (non-drizzle-mapped) jsonb column can arrive as text; parse it defensively.
      const request = typeof r.quote_request === 'string' ? safeParse(r.quote_request) : r.quote_request;
      return {
        id: r.id, experienceId: r.experience_id, bookingId: r.booking_id, quoteId: r.quote_id,
        source: r.source as InterestSource, nameSnapshot: r.name_snapshot, priceCentsSnapshot: r.price_cents_snapshot,
        priceUnitSnapshot: r.price_unit_snapshot as Lead['priceUnitSnapshot'], status: r.status as Lead['status'],
        paymentRef: r.payment_ref, amountPaidCents: r.amount_paid_cents,
        amountPaidCurrency: r.amount_paid_currency as Lead['amountPaidCurrency'], opsNote: r.ops_note,
        scheduledDate: r.scheduled_date_text, scheduledTime: r.scheduled_time, meetingPoint: r.meeting_point,
        confirmationSentAt: r.confirmation_sent_at ? new Date(r.confirmation_sent_at) : null,
        confirmationChannel: r.confirmation_channel as ConfirmationChannel | null,
        updatedBy: r.updated_by, createdAt: new Date(r.created_at), updatedAt: new Date(r.updated_at),
        areaLabel: r.area_label, experienceName: r.experience_name,
        ownerKind: isBooking ? 'booking' : 'quote',
        reference: (isBooking ? r.booking_ref : r.quote_ref) ?? '',
        customerName: isBooking ? [r.first_name, r.last_name].filter(Boolean).join(' ') : (r.quote_customer ?? ''),
        contact: isBooking ? r.whatsapp : r.quote_contact,
        travelDate: isBooking ? r.booking_travel_date : firstQuoteTravelDate(request),
      };
    });
  }

  async stats(): Promise<ExperienceStats[]> {
    // The listLeads owner filter without the status filter: an abandoned draft checkout or a deleted
    // quote is not a lead, so it must not count towards what the owner reads per experience.
    const rows = await this.db.execute<{ experience_id: string; interested: number; paid: number; paid_usd: string; paid_lkr: string }>(sql`
      SELECT i.experience_id,
             count(*)::int AS interested,
             (count(*) FILTER (WHERE i.status = 'paid'))::int AS paid,
             coalesce(sum(i.amount_paid_cents) FILTER (WHERE i.status = 'paid' AND i.amount_paid_currency = 'USD'), 0) AS paid_usd,
             coalesce(sum(i.amount_paid_cents) FILTER (WHERE i.status = 'paid' AND i.amount_paid_currency = 'LKR'), 0) AS paid_lkr
      FROM experience_interests i
      LEFT JOIN bookings b ON b.id = i.booking_id
      LEFT JOIN quotes q ON q.id = i.quote_id
      WHERE (i.booking_id IS NOT NULL AND b.status IN (${sql.join(PAID_BOOKING_STATUSES.map((s) => sql`${s}`), sql`, `)}))
         OR (i.booking_id IS NULL AND q.id IS NOT NULL AND q.deleted_at IS NULL)
      GROUP BY i.experience_id`);
    return rows.map((r) => ({
      experienceId: r.experience_id, interested: Number(r.interested), paid: Number(r.paid),
      paidCents: { USD: Number(r.paid_usd), LKR: Number(r.paid_lkr) },
    }));
  }

  async patch(id: string, p: InterestPatch): Promise<ExperienceInterest | null> {
    // Only provided fields go into the SET, so a status-only patch never clears the payment ref.
    // The paid-needs-a-ref rule is the table's CHECK constraint; its error propagates.
    const set: Partial<typeof experienceInterests.$inferInsert> = { updatedAt: new Date(), updatedBy: p.updatedBy };
    if (p.status !== undefined) set.status = p.status;
    if (p.opsNote !== undefined) set.opsNote = p.opsNote;
    if (p.paymentRef !== undefined) set.paymentRef = p.paymentRef;
    if (p.amountPaidCents !== undefined) set.amountPaidCents = p.amountPaidCents;
    if (p.amountPaidCurrency !== undefined) set.amountPaidCurrency = p.amountPaidCurrency;
    if (p.scheduledDate !== undefined) set.scheduledDate = p.scheduledDate;
    if (p.scheduledTime !== undefined) set.scheduledTime = p.scheduledTime;
    if (p.meetingPoint !== undefined) set.meetingPoint = p.meetingPoint;
    const rows = await this.db.update(experienceInterests).set(set).where(eq(experienceInterests.id, id)).returning();
    return rows[0] ? toInterest(rows[0]) : null;
  }

  // Not a patch: sending the email is not an edit, so it neither bumps updated_at nor changes updated_by.
  async markConfirmationSent(id: string, at: Date, channel: ConfirmationChannel): Promise<ExperienceInterest | null> {
    const rows = await this.db.update(experienceInterests).set({ confirmationSentAt: at, confirmationChannel: channel }).where(eq(experienceInterests.id, id)).returning();
    return rows[0] ? toInterest(rows[0]) : null;
  }
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
