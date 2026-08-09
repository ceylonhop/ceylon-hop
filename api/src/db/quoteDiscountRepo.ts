import { randomUUID } from 'node:crypto';

// Founder manual discounts — storage contract (spec 2026-08-09 §4).
//
// The table is append-only in effect: `apply` inserts, and replace/remove SUPERSEDE rather than
// update in place. That is the whole point — a discount's history is the audit trail, so a removed
// discount must stay legible afterwards, including who removed it.
//
// Both implementations here and in postgresQuoteDiscountRepo.ts satisfy the same tests.

export type DiscountStatus = 'active' | 'replaced' | 'removed';
export type DiscountCapReason = 'percentage_cap' | 'vehicle_minimum';

export interface QuoteDiscountRow {
  id: string;
  quoteId: string;
  /** The revision this was decided at. A stamp, not an FK — see schema.ts. */
  quoteRevision: number;
  source: 'manual' | 'promotion';
  method: 'fixed' | 'percentage';
  /** Cents for `fixed`, basis points for `percentage`. The founder's raw input. */
  value: number;
  reason: string;
  subtotalBeforeCents: number;
  totalBeforeCents: number;
  requestedCents: number;
  appliedCents: number;
  totalAfterCents: number;
  capReason: DiscountCapReason | null;
  /** Reporting only. The limits never read these (§5.2). */
  estimatedCostCents: number | null;
  marginBeforeCents: number | null;
  marginAfterCents: number | null;
  appliedBy: string;
  appliedAt: Date;
  status: DiscountStatus;
  supersededBy: string | null;
  supersededAt: Date | null;
}

export type NewQuoteDiscount = Omit<
  QuoteDiscountRow,
  'id' | 'appliedAt' | 'status' | 'supersededBy' | 'supersededAt'
>;

export interface QuoteDiscountRepo {
  /**
   * Insert a new active discount. The caller supersedes any existing active row FIRST — this
   * method does not do it implicitly, so a replace is always two visible, ordered writes inside
   * one transaction rather than a hidden cascade.
   */
  apply(input: NewQuoteDiscount): Promise<QuoteDiscountRow>;
  /** End the quote's active discount, recording who and when. No-op returning null if none. */
  supersede(quoteId: string, status: 'replaced' | 'removed', by: string): Promise<QuoteDiscountRow | null>;
  /** The one live discount, or null. */
  activeFor(quoteId: string): Promise<QuoteDiscountRow | null>;
  /** Every decision ever made on this quote, newest first. */
  historyFor(quoteId: string): Promise<QuoteDiscountRow[]>;
}

export class DiscountAlreadyActiveError extends Error {
  constructor() { super('DISCOUNT_ALREADY_ACTIVE'); }
}

export class InMemoryQuoteDiscountRepo implements QuoteDiscountRepo {
  private rows: QuoteDiscountRow[] = [];
  constructor(private now: () => Date = () => new Date()) {}

  async apply(input: NewQuoteDiscount): Promise<QuoteDiscountRow> {
    // Mirrors the partial unique index. Without this the fake would accept states Postgres refuses,
    // and every route test above it would be testing a world that cannot exist.
    if (this.rows.some((r) => r.quoteId === input.quoteId && r.status === 'active')) {
      throw new DiscountAlreadyActiveError();
    }
    const row: QuoteDiscountRow = {
      ...input,
      id: randomUUID(),
      appliedAt: this.now(),
      status: 'active',
      supersededBy: null,
      supersededAt: null,
    };
    this.rows.push(row);
    return { ...row };
  }

  async supersede(quoteId: string, status: 'replaced' | 'removed', by: string): Promise<QuoteDiscountRow | null> {
    const row = this.rows.find((r) => r.quoteId === quoteId && r.status === 'active');
    if (!row) return null;
    row.status = status;
    row.supersededBy = by;
    row.supersededAt = this.now();
    return { ...row };
  }

  async activeFor(quoteId: string): Promise<QuoteDiscountRow | null> {
    const row = this.rows.find((r) => r.quoteId === quoteId && r.status === 'active');
    return row ? { ...row } : null;
  }

  async historyFor(quoteId: string): Promise<QuoteDiscountRow[]> {
    return this.rows
      .filter((r) => r.quoteId === quoteId)
      .slice()
      .reverse()
      .map((r) => ({ ...r }));
  }
}
