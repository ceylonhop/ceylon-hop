import { randomUUID } from 'node:crypto';

export type QuoteStatus = 'draft' | 'sent' | 'won' | 'lost' | 'expired';
export const QUOTE_STATUSES: readonly QuoteStatus[] = ['draft', 'sent', 'won', 'lost', 'expired'];
const DECIDED: readonly QuoteStatus[] = ['won', 'lost', 'expired'];

export interface NewQuote {
  channel?: 'ops';
  product: string;
  vehicle?: string | null;
  customerName?: string | null;
  customerContact?: string | null;
  totalCents: number;
  currency: string;
  rateCardVersion: string;
  marginCents?: number | null;
  request: unknown;
  result: unknown;
  notes?: string | null;
}

export interface SavedQuote {
  id: string;
  reference: string;
  channel: string;
  status: QuoteStatus;
  lostReason: string | null;
  product: string;
  vehicle: string | null;
  customerName: string | null;
  customerContact: string | null;
  totalCents: number;
  currency: string;
  rateCardVersion: string;
  marginCents: number | null;
  request: unknown;
  result: unknown;
  convertedBookingId: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  sentAt: Date | null;
  decidedAt: Date | null;
}

export interface QuoteSummary {
  id: string;
  reference: string;
  status: QuoteStatus;
  product: string;
  vehicle: string | null;
  customerName: string | null;
  customerContact: string | null;
  totalCents: number;
  currency: string;
  createdAt: Date;
}

export interface QuoteListFilter {
  status?: QuoteStatus;
  product?: string;
  from?: string;
  to?: string;
}

export interface QuotePatch {
  status?: QuoteStatus;
  lostReason?: string | null;
  notes?: string | null;
}

export interface QuoteRepo {
  save(q: NewQuote): Promise<SavedQuote>;
  get(id: string): Promise<SavedQuote | null>;
  list(filter?: QuoteListFilter): Promise<QuoteSummary[]>;
  patch(id: string, patch: QuotePatch): Promise<SavedQuote | null>;
}

// A short, human-referenceable code (e.g. "Q-7F3K") for pasting into WhatsApp.
export function genReference(): string {
  return 'Q-' + randomUUID().replace(/-/g, '').slice(0, 4).toUpperCase();
}

function toSummary(q: SavedQuote): QuoteSummary {
  return {
    id: q.id,
    reference: q.reference,
    status: q.status,
    product: q.product,
    vehicle: q.vehicle,
    customerName: q.customerName,
    customerContact: q.customerContact,
    totalCents: q.totalCents,
    currency: q.currency,
    createdAt: q.createdAt,
  };
}

export class InMemoryQuoteRepo implements QuoteRepo {
  private readonly rows = new Map<string, SavedQuote>();
  private insertionOrder: string[] = [];
  private insertionIndex = 0;
  private readonly insertionIndices = new Map<string, number>();

  async save(q: NewQuote): Promise<SavedQuote> {
    const now = new Date();
    const row: SavedQuote = {
      id: randomUUID(),
      reference: genReference(),
      channel: q.channel ?? 'ops',
      status: 'draft',
      lostReason: null,
      product: q.product,
      vehicle: q.vehicle ?? null,
      customerName: q.customerName ?? null,
      customerContact: q.customerContact ?? null,
      totalCents: q.totalCents,
      currency: q.currency,
      rateCardVersion: q.rateCardVersion,
      marginCents: q.marginCents ?? null,
      request: q.request,
      result: q.result,
      convertedBookingId: null,
      notes: q.notes ?? null,
      createdAt: now,
      updatedAt: now,
      sentAt: null,
      decidedAt: null,
    };
    this.rows.set(row.id, row);
    this.insertionIndices.set(row.id, this.insertionIndex++);
    return { ...row };
  }

  async get(id: string): Promise<SavedQuote | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async list(filter: QuoteListFilter = {}): Promise<QuoteSummary[]> {
    let rows = [...this.rows.values()];
    if (filter.status) rows = rows.filter((r) => r.status === filter.status);
    if (filter.product) rows = rows.filter((r) => r.product === filter.product);
    if (filter.from) rows = rows.filter((r) => r.createdAt >= new Date(filter.from as string));
    if (filter.to) rows = rows.filter((r) => r.createdAt <= new Date(filter.to as string));
    rows.sort((a, b) => {
      const timeComp = b.createdAt.getTime() - a.createdAt.getTime();
      if (timeComp !== 0) return timeComp;
      return (this.insertionIndices.get(b.id) ?? 0) - (this.insertionIndices.get(a.id) ?? 0);
    });
    return rows.map(toSummary);
  }

  async patch(id: string, patch: QuotePatch): Promise<SavedQuote | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    const now = new Date();
    if (patch.status) {
      row.status = patch.status;
      if (patch.status === 'sent' && !row.sentAt) row.sentAt = now;
      if (DECIDED.includes(patch.status) && !row.decidedAt) row.decidedAt = now;
    }
    if (patch.lostReason !== undefined) row.lostReason = patch.lostReason;
    if (patch.notes !== undefined) row.notes = patch.notes;
    row.updatedAt = now;
    return { ...row };
  }
}
