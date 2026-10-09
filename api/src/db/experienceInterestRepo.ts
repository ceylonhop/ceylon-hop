import { randomUUID } from 'node:crypto';
import type { BookingRepo } from './bookingRepo';
import type { QuoteRepo } from './quoteRepo';
import type { ExperienceRepo } from './experienceRepo';
import { requestLegs } from './quoteRouteText';
import type { Experience, PriceUnit } from '../experiences/experience';

// One row per customer × experience (spec 2026-10-06 D5). Payment happens outside our system
// (D13): payment_ref + amount are the only record of it.
export type InterestStatus = 'new' | 'contacted' | 'link_sent' | 'paid' | 'declined';
export type ConfirmationChannel = 'email' | 'whatsapp';
export type InterestSource = 'booking_page' | 'quote_page';
export const OPEN_STATUSES: InterestStatus[] = ['new', 'contacted', 'link_sent'];
// The post-payment booking states (api/src/domain/status.ts): a draft booking is an abandoned
// checkout, so its interests are stored but never worked (spec D10, D15).
export const PAID_BOOKING_STATUSES = ['paid', 'confirmed', 'in_progress', 'completed'] as const;
// A quote is a live lead while it is ready or sent (a lapsed offer still counts — spec D12).
export const LIVE_QUOTE_STATUSES = ['ready', 'sent'] as const;

export interface ExperienceInterest {
  id: string;
  experienceId: string;
  bookingId: string | null;
  quoteId: string | null;
  source: InterestSource;
  nameSnapshot: string;
  priceCentsSnapshot: number;
  priceUnitSnapshot: PriceUnit;
  status: InterestStatus;
  paymentRef: string | null;
  amountPaidCents: number | null;
  amountPaidCurrency: 'USD' | 'LKR' | null;
  opsNote: string | null;
  /** D21: when and where, as the partner gave it. YYYY-MM-DD and 'HH:MM', Sri Lanka local time. */
  scheduledDate: string | null;
  scheduledTime: string | null;
  meetingPoint: string | null;
  /** When the customer was last told it is confirmed; null = never. */
  confirmationSentAt: Date | null;
  /** How: the email we sent, or ops confirmed it on WhatsApp. null until confirmed. */
  confirmationChannel: ConfirmationChannel | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// An interest joined to what ops needs to act on it, from one query (spec D15).
export interface Lead extends ExperienceInterest {
  areaLabel: string;
  experienceName: string;
  ownerKind: 'booking' | 'quote';
  reference: string;
  customerName: string;
  contact: string | null;
  travelDate: string | null;
}

export interface InterestPatch {
  status?: InterestStatus;
  opsNote?: string | null;
  paymentRef?: string | null;
  amountPaidCents?: number | null;
  amountPaidCurrency?: 'USD' | 'LKR' | null;
  scheduledDate?: string | null;
  scheduledTime?: string | null;
  meetingPoint?: string | null;
  updatedBy: string;
}

// `interested` = every customer who tapped (any status); `paid` = those ops marked paid.
export interface ExperienceStats {
  experienceId: string;
  interested: number;
  paid: number;
  paidCents: { USD: number; LKR: number };
}

export interface ExperienceInterestRepo {
  /** Idempotent per (experience, booking) and per (experience, quote): a repeat returns the same row. */
  record(i: { experience: Experience; source: InterestSource; bookingId?: string; quoteId?: string }): Promise<ExperienceInterest>;
  get(id: string): Promise<ExperienceInterest | null>;
  /** Deletes only while the interest is still 'new'; true when a row was removed. */
  withdrawFromQuote(experienceId: string, quoteId: string): Promise<boolean>;
  /** Sets booking_id on the quote's unlinked interests; returns how many moved. */
  linkQuoteToBooking(quoteId: string, bookingId: string): Promise<number>;
  listForBooking(bookingId: string): Promise<ExperienceInterest[]>;
  listForQuote(quoteId: string): Promise<ExperienceInterest[]>;
  /** Open leads on real bookings and live quotes, newest first. ONE query (spec D15). A paid lead stays
   *  until it has been confirmed to the customer, by email or on WhatsApp (D21), or its scheduled date
   *  (Sri Lanka) has passed: it still has a date, a time and a confirmation to do. */
  listLeads(limit: number): Promise<Lead[]>;
  /** Per experience, counting only real leads: the owner filter of listLeads, across all statuses. */
  stats(): Promise<ExperienceStats[]>;
  /** null for an unknown id. 'paid' without a payment reference rejects. */
  patch(id: string, p: InterestPatch): Promise<ExperienceInterest | null>;
  /** Stamps confirmation_sent_at + channel (D21) and nothing else; null for an unknown id. */
  markConfirmationSent(id: string, at: Date, channel: ConfirmationChannel): Promise<ExperienceInterest | null>;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// A quote's travel date for a lead: the FIRST leg that carries a date. Deliberately not
// quoteTravelDate(), which returns the last (it answers "is the trip over?", not "when does it start?").
export function firstQuoteTravelDate(request: unknown): string | null {
  const legs = requestLegs(request);
  if (!Array.isArray(legs)) return null;
  for (const leg of legs) {
    const raw = leg && typeof leg === 'object' ? (leg as { date?: unknown }).date : undefined;
    if (typeof raw !== 'string') continue;
    const d = raw.trim();
    if (ISO_DATE.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`))) return d;
  }
  return null;
}

export class InMemoryExperienceInterestRepo implements ExperienceInterestRepo {
  private rows = new Map<string, ExperienceInterest>();

  // The booking / quote / experience repos let listLeads be faked in route tests. Test-only.
  constructor(private readonly deps: { bookings?: BookingRepo; quotes?: QuoteRepo; experiences?: ExperienceRepo } = {}) {}

  async record(i: { experience: Experience; source: InterestSource; bookingId?: string; quoteId?: string }): Promise<ExperienceInterest> {
    if (!i.bookingId && !i.quoteId) throw new Error('interest_needs_owner');
    const existing = [...this.rows.values()].find((r) => r.experienceId === i.experience.id
      && (i.bookingId ? r.bookingId === i.bookingId : r.quoteId === i.quoteId));
    if (existing) return { ...existing };
    const now = new Date();
    const row: ExperienceInterest = {
      id: randomUUID(), experienceId: i.experience.id, bookingId: i.bookingId ?? null, quoteId: i.quoteId ?? null,
      source: i.source, nameSnapshot: i.experience.name, priceCentsSnapshot: i.experience.priceCents,
      priceUnitSnapshot: i.experience.priceUnit, status: 'new', paymentRef: null, amountPaidCents: null,
      amountPaidCurrency: null, opsNote: null, scheduledDate: null, scheduledTime: null, meetingPoint: null,
      confirmationSentAt: null, confirmationChannel: null, updatedBy: null, createdAt: now, updatedAt: now,
    };
    this.rows.set(row.id, row);
    return { ...row };
  }

  async get(id: string): Promise<ExperienceInterest | null> {
    const r = this.rows.get(id);
    return r ? { ...r } : null;
  }

  async withdrawFromQuote(experienceId: string, quoteId: string): Promise<boolean> {
    for (const r of this.rows.values()) {
      if (r.experienceId === experienceId && r.quoteId === quoteId && r.status === 'new') {
        this.rows.delete(r.id);
        return true;
      }
    }
    return false;
  }

  async linkQuoteToBooking(quoteId: string, bookingId: string): Promise<number> {
    let moved = 0;
    for (const r of this.rows.values()) {
      if (r.quoteId !== quoteId || r.bookingId) continue;
      const taken = [...this.rows.values()].some((x) => x.experienceId === r.experienceId && x.bookingId === bookingId);
      if (taken) continue;
      r.bookingId = bookingId;
      r.updatedAt = new Date();
      moved++;
    }
    return moved;
  }

  async listForBooking(bookingId: string): Promise<ExperienceInterest[]> {
    return [...this.rows.values()].filter((r) => r.bookingId === bookingId).map((r) => ({ ...r }));
  }

  async listForQuote(quoteId: string): Promise<ExperienceInterest[]> {
    return [...this.rows.values()].filter((r) => r.quoteId === quoteId).map((r) => ({ ...r }));
  }

  async listLeads(limit: number): Promise<Lead[]> {
    const { bookings, quotes, experiences } = this.deps;
    const out: Lead[] = [];
    // Newest first; reversing insertion order first makes a same-millisecond tie fall newest-first too.
    // Today in Sri Lanka, like the Postgres repo's (now() AT TIME ZONE 'Asia/Colombo')::date; en-CA formats YYYY-MM-DD.
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Colombo' }).format(new Date());
    const awaitingConfirmation = (r: ExperienceInterest) =>
      r.status === 'paid' && !r.confirmationSentAt && (r.scheduledDate == null || r.scheduledDate >= today);
    const open = [...this.rows.values()].reverse().filter((r) => OPEN_STATUSES.includes(r.status) || awaitingConfirmation(r))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    for (const r of open) {
      const exp = await experiences?.get(r.experienceId);
      if (!exp) continue;
      const base = { ...r, areaLabel: exp.areaLabel, experienceName: exp.name };
      if (r.bookingId) {
        const b = await bookings?.get(r.bookingId);
        if (!b || !(PAID_BOOKING_STATUSES as readonly string[]).includes(b.status)) continue;
        const c = b.input.customer;
        const dates = b.mode === 'trip' ? (b.input.dates ?? []).filter(Boolean).sort() : [b.input.date].filter((d): d is string => !!d);
        out.push({
          ...base, ownerKind: 'booking', reference: b.reference,
          customerName: [c.firstName, c.lastName].filter(Boolean).join(' '), contact: c.whatsapp ?? null,
          travelDate: dates[0] ?? null,
        });
      } else if (r.quoteId) {
        const q = await quotes?.get(r.quoteId); // get() hides soft-deleted quotes
        if (!q || !(LIVE_QUOTE_STATUSES as readonly string[]).includes(q.status)) continue;
        out.push({
          ...base, ownerKind: 'quote', reference: q.reference, customerName: q.customerName ?? '',
          contact: q.customerContact, travelDate: firstQuoteTravelDate(q.request),
        });
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  async stats(): Promise<ExperienceStats[]> {
    const { bookings, quotes } = this.deps;
    const by = new Map<string, ExperienceStats>();
    for (const r of this.rows.values()) {
      // Real leads only — the listLeads owner filter, across every status (spec D10/D15).
      if (r.bookingId) {
        const b = await bookings?.get(r.bookingId);
        if (!b || !(PAID_BOOKING_STATUSES as readonly string[]).includes(b.status)) continue;
      } else if (!r.quoteId || !(await quotes?.get(r.quoteId))) continue; // get() hides soft-deleted quotes
      const s = by.get(r.experienceId) ?? { experienceId: r.experienceId, interested: 0, paid: 0, paidCents: { USD: 0, LKR: 0 } };
      s.interested++;
      if (r.status === 'paid') {
        s.paid++;
        if (r.amountPaidCents != null && r.amountPaidCurrency) s.paidCents[r.amountPaidCurrency] += r.amountPaidCents;
      }
      by.set(r.experienceId, s);
    }
    return [...by.values()];
  }

  async patch(id: string, p: InterestPatch): Promise<ExperienceInterest | null> {
    const r = this.rows.get(id);
    if (!r) return null;
    const next = { ...r };
    if (p.status !== undefined) next.status = p.status;
    if (p.opsNote !== undefined) next.opsNote = p.opsNote;
    if (p.paymentRef !== undefined) next.paymentRef = p.paymentRef;
    if (p.amountPaidCents !== undefined) next.amountPaidCents = p.amountPaidCents;
    if (p.amountPaidCurrency !== undefined) next.amountPaidCurrency = p.amountPaidCurrency;
    if (p.scheduledDate !== undefined) next.scheduledDate = p.scheduledDate;
    if (p.scheduledTime !== undefined) next.scheduledTime = p.scheduledTime;
    if (p.meetingPoint !== undefined) next.meetingPoint = p.meetingPoint;
    // Mirrors the experience_interests_paid_has_ref CHECK.
    if (next.status === 'paid' && next.paymentRef == null) throw new Error('paid_requires_ref');
    next.updatedBy = p.updatedBy;
    next.updatedAt = new Date(Math.max(Date.now(), r.updatedAt.getTime() + 1));
    this.rows.set(id, next);
    return { ...next };
  }

  async markConfirmationSent(id: string, at: Date, channel: ConfirmationChannel): Promise<ExperienceInterest | null> {
    const r = this.rows.get(id);
    if (!r) return null;
    r.confirmationSentAt = at;
    r.confirmationChannel = channel;
    return { ...r };
  }
}
