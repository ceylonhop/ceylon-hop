import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { Db } from './client';
import { quotes } from './schema';
import { genReference, parseDateFilter } from './quoteRepo';
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

// Postgres unique-violation error code. See:
// https://www.postgresql.org/docs/current/errcodes-appendix.html
const UNIQUE_VIOLATION = '23505';
const MAX_REFERENCE_ATTEMPTS = 5;

function isReferenceCollision(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; constraint_name?: unknown; constraint?: unknown };
  const code = e.code;
  const constraint = String(e.constraint_name ?? e.constraint ?? '');
  return code === UNIQUE_VIOLATION && constraint.includes('reference');
}

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
    rateCardJson: r.rateCardJson,
    rateLockedUntil: r.rateLockedUntil,
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
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_REFERENCE_ATTEMPTS; attempt++) {
      try {
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
            rateCardJson: (q.rateCardJson ?? null) as object | null,
            rateLockedUntil: q.rateLockedUntil ?? null,
            notes: q.notes ?? null,
          })
          .returning();
        return toSaved(row);
      } catch (err) {
        if (!isReferenceCollision(err)) throw err;
        lastErr = err;
      }
    }
    throw lastErr;
  }

  async get(id: string): Promise<SavedQuote | null> {
    const rows = await this.db.select().from(quotes).where(eq(quotes.id, id));
    return rows[0] ? toSaved(rows[0]) : null;
  }

  async list(filter: QuoteListFilter = {}): Promise<QuoteSummary[]> {
    const conds = [];
    if (filter.status) conds.push(eq(quotes.status, filter.status));
    if (filter.product) conds.push(eq(quotes.product, filter.product));
    if (filter.from) conds.push(gte(quotes.createdAt, parseDateFilter(filter.from, 'from')));
    if (filter.to) conds.push(lte(quotes.createdAt, parseDateFilter(filter.to, 'to')));
    const rows = await this.db
      .select({
        id: quotes.id,
        reference: quotes.reference,
        status: quotes.status,
        product: quotes.product,
        vehicle: quotes.vehicle,
        customerName: quotes.customerName,
        customerContact: quotes.customerContact,
        totalCents: quotes.totalCents,
        currency: quotes.currency,
        createdAt: quotes.createdAt,
      })
      .from(quotes)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(quotes.createdAt), desc(quotes.reference));
    return rows.map((r) => ({
      id: r.id,
      reference: r.reference,
      status: r.status as QuoteStatus,
      product: r.product,
      vehicle: r.vehicle,
      customerName: r.customerName,
      customerContact: r.customerContact,
      totalCents: r.totalCents,
      currency: r.currency,
      createdAt: r.createdAt,
    }));
  }

  async patch(id: string, patch: QuotePatch): Promise<SavedQuote | null> {
    const [row] = await this.db
      .update(quotes)
      .set({
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.lostReason !== undefined ? { lostReason: patch.lostReason } : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
        ...(patch.rateLock !== undefined
          ? {
              rateCardJson: (patch.rateLock?.rateCardJson ?? null) as object | null,
              rateLockedUntil: patch.rateLock?.rateLockedUntil ?? null,
            }
          : {}),
        updatedAt: new Date(),
        ...(patch.status
          ? {
              sentAt:
                patch.status === 'sent'
                  ? sql`coalesce(${quotes.sentAt}, now())`
                  : sql`${quotes.sentAt}`,
              decidedAt: DECIDED.includes(patch.status)
                ? sql`coalesce(${quotes.decidedAt}, now())`
                : sql`${quotes.decidedAt}`,
            }
          : {}),
      })
      .where(eq(quotes.id, id))
      .returning();
    return row ? toSaved(row) : null;
  }

  async update(id: string, q: NewQuote): Promise<SavedQuote | null> {
    // Content only — status/reference/createdAt and the sent/decided stamps are left as-is.
    const [row] = await this.db
      .update(quotes)
      .set({
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
        rateCardJson: (q.rateCardJson ?? null) as object | null,
        rateLockedUntil: q.rateLockedUntil ?? null,
        notes: q.notes ?? null,
        updatedAt: new Date(),
      })
      .where(eq(quotes.id, id))
      .returning();
    return row ? toSaved(row) : null;
  }
}
