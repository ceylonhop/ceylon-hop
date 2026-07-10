import { randomUUID } from 'node:crypto';

export type QuoteStatus =
  | 'draft' | 'pending_review' | 'changes_requested' | 'ready' | 'sent' | 'won' | 'lost' | 'expired';
export const QUOTE_STATUSES: readonly QuoteStatus[] =
  ['draft', 'pending_review', 'changes_requested', 'ready', 'sent', 'won', 'lost', 'expired'];
const DECIDED: readonly QuoteStatus[] = ['won', 'lost', 'expired'];

// Legal status moves in the maker-checker review lifecycle (structural legality only — the
// route separately requires quote:approve for → ready / → changes_requested, so draft → ready
// is a legal SELF-APPROVE that a non-approver still can't perform).
const ALLOWED_TRANSITIONS: Record<QuoteStatus, readonly QuoteStatus[]> = {
  draft:             ['pending_review', 'ready'],
  changes_requested: ['pending_review', 'ready', 'draft'],
  pending_review:    ['ready', 'changes_requested', 'draft'],
  ready:             ['sent', 'draft'],
  sent:              [],
  won:               [],
  lost:              [],
  expired:           [],
};
export function canTransition(from: QuoteStatus, to: QuoteStatus): boolean {
  if (DECIDED.includes(to) && from !== 'draft') return true; // outcome flip from any live state
  return ALLOWED_TRANSITIONS[from].includes(to);
}

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
  // Rewrite an existing quote's priced CONTENT in place (re-priced server-side on save).
  // Leaves the lifecycle alone — status/reference/createdAt and the sent/decided stamps are
  // untouched — so a founder editing a quote mid-review corrects the same row, never a
  // duplicate. Returns null for an unknown id.
  update(id: string, q: NewQuote): Promise<SavedQuote | null>;
}

// Same unambiguous alphabet as bookingRepo.generateReference (no 0/O/1/I), so a
// reference is easy to read over the phone or paste into WhatsApp. 5 chars over this
// 32-symbol alphabet gives 32^5 (~33.5M) combinations.
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// A short, human-referenceable code (e.g. "Q-7F3KX") for pasting into WhatsApp.
export function genReference(): string {
  let s = 'Q-';
  for (let i = 0; i < 5; i++) {
    s += REF_ALPHABET[Math.floor(Math.random() * REF_ALPHABET.length)];
  }
  return s;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// A date-only filter string (e.g. "2026-07-01") is ambiguous as an instant: naively
// parsing it gives midnight UTC, which excludes the whole "to" day. Treat date-only
// strings as the start/end of that UTC day depending on which bound they're used for;
// anything else (already a full timestamp) is parsed as-is.
export function parseDateFilter(value: string, bound: 'from' | 'to'): Date {
  if (DATE_ONLY.test(value)) {
    return new Date(`${value}T${bound === 'from' ? '00:00:00.000' : '23:59:59.999'}Z`);
  }
  return new Date(value);
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
  private readonly usedReferences = new Set<string>();

  private nextReference(): string {
    let reference = genReference();
    while (this.usedReferences.has(reference)) reference = genReference();
    this.usedReferences.add(reference);
    return reference;
  }

  async save(q: NewQuote): Promise<SavedQuote> {
    const now = new Date();
    const row: SavedQuote = {
      id: randomUUID(),
      reference: this.nextReference(),
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
    if (filter.from) rows = rows.filter((r) => r.createdAt >= parseDateFilter(filter.from as string, 'from'));
    if (filter.to) rows = rows.filter((r) => r.createdAt <= parseDateFilter(filter.to as string, 'to'));
    rows.sort((a, b) => {
      const timeComp = b.createdAt.getTime() - a.createdAt.getTime();
      if (timeComp !== 0) return timeComp;
      return a.reference < b.reference ? 1 : a.reference > b.reference ? -1 : 0;
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

  async update(id: string, q: NewQuote): Promise<SavedQuote | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    // Content only — id/reference/channel/status/createdAt and the sent/decided stamps stay put.
    row.product = q.product;
    row.vehicle = q.vehicle ?? null;
    row.customerName = q.customerName ?? null;
    row.customerContact = q.customerContact ?? null;
    row.totalCents = q.totalCents;
    row.currency = q.currency;
    row.rateCardVersion = q.rateCardVersion;
    row.marginCents = q.marginCents ?? null;
    row.request = q.request;
    row.result = q.result;
    row.notes = q.notes ?? null;
    row.updatedAt = new Date();
    return { ...row };
  }
}
