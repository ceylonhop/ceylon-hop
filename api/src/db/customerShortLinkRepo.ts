export type CustomerShortLinkTarget =
  | { kind: 'quote_view'; quoteId: string }
  | { kind: 'quote_pay'; quoteId: string; revision: number; seq: number };

export interface CustomerShortLinkRepo {
  put(codeDigest: string, target: CustomerShortLinkTarget): Promise<void>;
  getByDigest(codeDigest: string): Promise<CustomerShortLinkTarget | null>;
}

function sameTarget(a: CustomerShortLinkTarget, b: CustomerShortLinkTarget): boolean {
  if (a.kind !== b.kind || a.quoteId !== b.quoteId) return false;
  if (a.kind === 'quote_view' || b.kind === 'quote_view') return true;
  return a.revision === b.revision && a.seq === b.seq;
}

export class CustomerShortLinkCollisionError extends Error {
  constructor() {
    super('customer_short_link_collision');
    this.name = 'CustomerShortLinkCollisionError';
  }
}

export class InMemoryCustomerShortLinkRepo implements CustomerShortLinkRepo {
  private readonly rows = new Map<string, CustomerShortLinkTarget>();

  async put(codeDigest: string, target: CustomerShortLinkTarget): Promise<void> {
    const existing = this.rows.get(codeDigest);
    if (existing && !sameTarget(existing, target)) throw new CustomerShortLinkCollisionError();
    if (!existing) this.rows.set(codeDigest, { ...target });
  }

  async getByDigest(codeDigest: string): Promise<CustomerShortLinkTarget | null> {
    const target = this.rows.get(codeDigest);
    return target ? { ...target } : null;
  }
}

export function customerShortLinkTargetsEqual(
  a: CustomerShortLinkTarget,
  b: CustomerShortLinkTarget,
): boolean {
  return sameTarget(a, b);
}
