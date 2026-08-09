import { and, desc, eq } from 'drizzle-orm';
import type { Db } from './client';
import { quoteDiscounts } from './schema';
import {
  DiscountAlreadyActiveError,
  type QuoteDiscountRepo,
  type QuoteDiscountRow,
  type NewQuoteDiscount,
  type DiscountStatus,
  type DiscountCapReason,
} from './quoteDiscountRepo';

type Row = typeof quoteDiscounts.$inferSelect;

function toRow(r: Row): QuoteDiscountRow {
  return {
    id: r.id,
    quoteId: r.quoteId,
    quoteRevision: r.quoteRevision,
    source: r.source as 'manual' | 'promotion',
    method: r.method as 'fixed' | 'percentage',
    value: r.value,
    reason: r.reason,
    subtotalBeforeCents: r.subtotalBeforeCents,
    totalBeforeCents: r.totalBeforeCents,
    requestedCents: r.requestedCents,
    appliedCents: r.appliedCents,
    totalAfterCents: r.totalAfterCents,
    capReason: r.capReason as DiscountCapReason | null,
    estimatedCostCents: r.estimatedCostCents,
    marginBeforeCents: r.marginBeforeCents,
    marginAfterCents: r.marginAfterCents,
    appliedBy: r.appliedBy,
    appliedAt: r.appliedAt,
    status: r.status as DiscountStatus,
    supersededBy: r.supersededBy,
    supersededAt: r.supersededAt,
  };
}

/** The partial unique index that guarantees one live discount per quote. */
const ONE_ACTIVE_INDEX = 'quote_discounts_one_active_per_quote';

export class PostgresQuoteDiscountRepo implements QuoteDiscountRepo {
  constructor(private readonly db: Db) {}

  async apply(input: NewQuoteDiscount): Promise<QuoteDiscountRow> {
    try {
      const [row] = await this.db.insert(quoteDiscounts).values(input).returning();
      return toRow(row);
    } catch (e) {
      // Let the DATABASE decide, not a prior read: two concurrent applies both pass a
      // check-then-insert, and only the index stops the second. Translating it here means callers
      // see one error whichever implementation they hold.
      if (e instanceof Error && e.message.includes(ONE_ACTIVE_INDEX)) throw new DiscountAlreadyActiveError();
      throw e;
    }
  }

  async supersede(
    quoteId: string,
    status: 'replaced' | 'removed',
    by: string,
  ): Promise<QuoteDiscountRow | null> {
    const [row] = await this.db
      .update(quoteDiscounts)
      .set({ status, supersededBy: by, supersededAt: new Date() })
      .where(and(eq(quoteDiscounts.quoteId, quoteId), eq(quoteDiscounts.status, 'active')))
      .returning();
    return row ? toRow(row) : null;
  }

  async activeFor(quoteId: string): Promise<QuoteDiscountRow | null> {
    const [row] = await this.db
      .select()
      .from(quoteDiscounts)
      .where(and(eq(quoteDiscounts.quoteId, quoteId), eq(quoteDiscounts.status, 'active')))
      .limit(1);
    return row ? toRow(row) : null;
  }

  async historyFor(quoteId: string): Promise<QuoteDiscountRow[]> {
    const rows = await this.db
      .select()
      .from(quoteDiscounts)
      .where(eq(quoteDiscounts.quoteId, quoteId))
      .orderBy(desc(quoteDiscounts.appliedAt));
    return rows.map(toRow);
  }
}
