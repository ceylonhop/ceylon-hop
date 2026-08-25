import { eq } from 'drizzle-orm';
import type { Db } from './client';
import { customerShortLinks } from './schema';
import {
  CustomerShortLinkCollisionError,
  customerShortLinkTargetsEqual,
  type CustomerShortLinkRepo,
  type CustomerShortLinkTarget,
} from './customerShortLinkRepo';

type Row = typeof customerShortLinks.$inferSelect;

function toTarget(row: Row): CustomerShortLinkTarget {
  if (row.kind === 'quote_view') return { kind: 'quote_view', quoteId: row.quoteId };
  if (row.kind === 'quote_pay' && row.quoteRevision !== null && row.payLinkSeq !== null) {
    return {
      kind: 'quote_pay',
      quoteId: row.quoteId,
      revision: row.quoteRevision,
      seq: row.payLinkSeq,
    };
  }
  // The migration check makes this unreachable; fail closed if the database was changed by hand.
  throw new Error('invalid_customer_short_link_target');
}

export class PostgresCustomerShortLinkRepo implements CustomerShortLinkRepo {
  constructor(private readonly db: Db) {}

  async put(codeDigest: string, target: CustomerShortLinkTarget): Promise<void> {
    const values = target.kind === 'quote_view'
      ? {
          codeDigest,
          kind: target.kind,
          quoteId: target.quoteId,
          quoteRevision: null,
          payLinkSeq: null,
        }
      : {
          codeDigest,
          kind: target.kind,
          quoteId: target.quoteId,
          quoteRevision: target.revision,
          payLinkSeq: target.seq,
        };
    const inserted = await this.db
      .insert(customerShortLinks)
      .values(values)
      .onConflictDoNothing({ target: customerShortLinks.codeDigest })
      .returning({ id: customerShortLinks.id });
    if (inserted.length > 0) return;

    const existing = await this.getByDigest(codeDigest);
    if (existing && customerShortLinkTargetsEqual(existing, target)) return;
    throw new CustomerShortLinkCollisionError();
  }

  async getByDigest(codeDigest: string): Promise<CustomerShortLinkTarget | null> {
    const rows = await this.db
      .select()
      .from(customerShortLinks)
      .where(eq(customerShortLinks.codeDigest, codeDigest))
      .limit(1);
    return rows[0] ? toTarget(rows[0]) : null;
  }
}
