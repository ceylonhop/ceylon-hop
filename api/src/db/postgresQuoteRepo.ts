import { and, desc, eq, gte, lte } from 'drizzle-orm';
import type { Db } from './client';
import { quotes } from './schema';
import { genReference } from './quoteRepo';
import type {
  QuoteRepo,
  NewQuote,
  SavedQuote,
  QuoteSummary,
  QuoteListFilter,
  QuotePatch,
  QuoteStatus,
} from './quoteRepo';

type Row = typeof quotes.$inferSelect;
const DECIDED: readonly QuoteStatus[] = ['won', 'lost', 'expired'];

function toSaved(r: Row): SavedQuote {
  return {
    id: r.id,
    reference: r.reference,
    channel: r.channel,
    status: r.status as QuoteStatus,
    lostReason: r.lostReason,
    product: r.product,
    vehicle: r.vehicle,
    customerName: r.customerName,
    customerContact: r.customerContact,
    totalCents: r.totalCents,
    currency: r.currency,
    rateCardVersion: r.rateCardVersion,
    marginCents: r.marginCents,
    request: r.requestJson,
    result: r.resultJson,
    convertedBookingId: r.convertedBookingId,
    notes: r.notes,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    sentAt: r.sentAt,
    decidedAt: r.decidedAt,
  };
}

export class PostgresQuoteRepo implements QuoteRepo {
  constructor(private readonly db: Db) {}

  async save(q: NewQuote): Promise<SavedQuote> {
    const [row] = await this.db
      .insert(quotes)
      .values({
        reference: genReference(),
        channel: q.channel ?? 'ops',
        product: q.product,
        vehicle: q.vehicle ?? null,
        customerName: q.customerName ?? null,
        customerContact: q.customerContact ?? null,
        totalCents: q.totalCents,
        currency: q.currency,
        rateCardVersion: q.rateCardVersion,
        marginCents: q.marginCents ?? null,
        requestJson: q.request,
        resultJson: q.result,
        notes: q.notes ?? null,
      })
      .returning();
    return toSaved(row);
  }

  async get(id: string): Promise<SavedQuote | null> {
    const rows = await this.db.select().from(quotes).where(eq(quotes.id, id));
    return rows[0] ? toSaved(rows[0]) : null;
  }

  async list(filter: QuoteListFilter = {}): Promise<QuoteSummary[]> {
    const conds = [];
    if (filter.status) conds.push(eq(quotes.status, filter.status));
    if (filter.product) conds.push(eq(quotes.product, filter.product));
    if (filter.from) conds.push(gte(quotes.createdAt, new Date(filter.from)));
    if (filter.to) conds.push(lte(quotes.createdAt, new Date(filter.to)));
    const rows = await this.db
      .select()
      .from(quotes)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(quotes.createdAt));
    return rows.map((r) => {
      const s = toSaved(r);
      return {
        id: s.id,
        reference: s.reference,
        status: s.status,
        product: s.product,
        vehicle: s.vehicle,
        customerName: s.customerName,
        customerContact: s.customerContact,
        totalCents: s.totalCents,
        currency: s.currency,
        createdAt: s.createdAt,
      };
    });
  }

  async patch(id: string, patch: QuotePatch): Promise<SavedQuote | null> {
    const current = await this.get(id);
    if (!current) return null;
    const now = new Date();
    const set: Partial<Row> = { updatedAt: now };
    if (patch.status) {
      set.status = patch.status;
      if (patch.status === 'sent' && !current.sentAt) set.sentAt = now;
      if (DECIDED.includes(patch.status) && !current.decidedAt) set.decidedAt = now;
    }
    if (patch.lostReason !== undefined) set.lostReason = patch.lostReason;
    if (patch.notes !== undefined) set.notes = patch.notes;
    const [row] = await this.db.update(quotes).set(set).where(eq(quotes.id, id)).returning();
    return toSaved(row);
  }
}
