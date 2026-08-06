import { randomUUID } from 'node:crypto';
import { quoteRouteText, requestLegs } from './quoteRouteText';
import type { PaySelection } from '../quote/paySelection';

export type QuoteStatus =
  | 'draft' | 'pending_review' | 'changes_requested' | 'ready' | 'sent' | 'won' | 'lost' | 'expired';
export const QUOTE_STATUSES: readonly QuoteStatus[] =
  ['draft', 'pending_review', 'changes_requested', 'ready', 'sent', 'won', 'lost', 'expired'];
const DECIDED: readonly QuoteStatus[] = ['won', 'lost', 'expired'];

// Legal status moves in the maker-checker review lifecycle. Approval (→ ready) is reachable
// ONLY from pending_review: a quote must be Submitted for review before it can be approved, for
// everyone — the founder-only "self-approve straight from a draft" shortcut was removed
// (2026-07-19) so the lifecycle is respected end to end. The route additionally requires
// quote:approve for → ready / → changes_requested (a non-approver still can't approve).
const ALLOWED_TRANSITIONS: Record<QuoteStatus, readonly QuoteStatus[]> = {
  draft:             ['pending_review'],
  changes_requested: ['pending_review', 'draft'],
  pending_review:    ['ready', 'changes_requested', 'draft'],
  ready:             ['sent', 'draft'],
  sent:              ['draft'], // reopen-to-edit a sent quote (founder-gated in the route)
  won:               [],
  lost:              [],
  // Reopen-to-edit an EXPIRED quote (2026-07-31). Expiry is applied by a background sweep,
  // not by a person, so a terminal 'expired' meant the clock could silently strand real work
  // with no way back — the operator could only mark it won or lost, never revise and re-send.
  // Reopening drops the frozen rate card (see the route), so a revived quote re-prices at
  // today's rates and can never carry a months-old locked price back to a customer.
  expired:           ['draft'],
};
export function canTransition(from: QuoteStatus, to: QuoteStatus): boolean {
  if (DECIDED.includes(to) && from !== 'draft') return true; // outcome flip from any live state
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export interface NewQuote {
  channel?: 'ops' | 'web';
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
  // Rate-lock (spec 2026-07-11): the RATE_CARD snapshot this quote is priced against, and when
  // that lock expires (null = no expiry / not yet locked). See api/src/quote/rateLock.ts.
  rateCardJson?: unknown;
  rateLockedUntil?: Date | null;
  intent?: unknown;
  intentFingerprint?: string | null;
  revision?: number;
  accessTokenDigest?: string | null;
  notes?: string | null;
  // Internal ops notes (spec 2026-07-22) — free-text, distinct from the send-back `notes`.
  internalNotes?: string | null;
  // Quote intent (spec 2026-07-17). What the customer ASKED for ('private'|'chauffeur'|'both'),
  // vs `product` = what was priced. Optional here; the submit gate lives in the route.
  requestedService?: string | null;
  // Audit (spec 2026-07-16). The acting staff email. On save() both are stamped; on update()
  // only updatedBy moves — createdBy is write-once, so a founder editing an ops person's quote
  // never becomes its author.
  createdBy?: string | null;
  updatedBy?: string | null;
  // Assignment (spec 2026-07-22): a new quote is auto-assigned to its creator on save() so it
  // opens already showing a holder. Reassignment happens via the patch/picker (and, from
  // 2026-07-26, automatically on the ready/sent transitions), and update() leaves assignment
  // untouched — so this only takes effect on insert.
  assignedTo?: string | null;
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
  rateCardJson: unknown;
  rateLockedUntil: Date | null;
  intent: unknown;
  intentFingerprint: string | null;
  revision: number;
  // Partial-leg pay links (spec 2026-08-04). null selection = the outstanding link is for the
  // full quote; soldCents is the frozen amount a partial link charges; payLinkSeq is monotonic.
  payLinkSelection: PaySelection | null;
  soldCents: number | null;
  payLinkSeq: number;
  // Price-drift baseline (spec 2026-08-05): the quote total when the customer was last quoted.
  customerTotalCents: number | null;
  customerTotalAt: Date | null;
  customerTotalVia: 'sent' | 'pay_link' | null;
  accessTokenDigest: string | null;
  convertedBookingId: string | null;
  notes: string | null;
  internalNotes: string | null;
  requestedService: string | null;
  offerValidUntil: Date | null;
  assignedTo: string | null;
  assignedAt: Date | null;
  createdBy: string | null;
  updatedBy: string | null;
  deletedAt: Date | null;
  deletedBy: string | null;
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
  // The queue renders an assignee chip on every row (and floats your rows to the top of each
  // status section) off this, so it must survive the narrow projection. Sell-side only — this
  // stays free of cost/margin (see the list route's note).
  assignedTo: string | null;
  // Trip places, joined for the queue's search (spec 2026-07-25). Derived per request from
  // request_json.legs — NOT a stored column. Null when a quote has no usable legs.
  routeText: string | null;
  // Autosave shells (spec 2026-07-29): true when this row was created by "+ New quote" and has
  // never been priced. The queue renders "Not priced yet" instead of a $0 total, and the send
  // gate refuses to move it out of draft. Derived from the request marker, NEVER from the price —
  // a $0 total is a symptom, the marker is the fact.
  unpriced: boolean;
  createdAt: Date;
}

export interface QuoteListFilter {
  status?: QuoteStatus;
  product?: string;
  from?: string;
  to?: string;
  channel?: 'ops' | 'web'; // the ops review queue passes 'ops' so customer web quotes never show
}

export interface QuotePatch {
  status?: QuoteStatus;
  lostReason?: string | null;
  notes?: string | null;
  internalNotes?: string | null;
  // Rate-lock (spec 2026-07-11). The snapshot + expiry always move together, so they patch as a
  // unit: `undefined` = leave the lock untouched; an object = stamp it (ops freeze at approval);
  // `null` = clear it (reopen-to-edit → back to the live card). See api/src/quote/rateLock.ts.
  rateLock?: { rateCardJson: unknown; rateLockedUntil: Date | null } | null;
  // Assignment (spec 2026-07-16). Tri-state, like rateLock: `undefined` = leave the assignment
  // alone (so a status/notes patch never disturbs it — assignment is manual-only, never a
  // side effect of a transition); a string = assign (route-validated against OPS_USERS first);
  // `null` = unassign. assignedAt follows automatically.
  assignedTo?: string | null;
  updatedBy?: string | null;
  // Back-link to the booking a won quote became. System-set only — POST /admin/quote/:id/book
  // writes it; the ops PATCH route's zod schema deliberately does not accept it.
  convertedBookingId?: string;
  // Partial-leg pay links (spec 2026-08-04). Tri-state like rateLock: `undefined` = leave alone,
  // an object = store, `null` = clear. payLinkSeq is set explicitly by the mint; it is monotonic
  // and the repo never resets it.
  payLinkSelection?: PaySelection | null;
  soldCents?: number | null;
  payLinkSeq?: number;
  // Price-drift baseline (spec 2026-08-05). Moves as a UNIT, like rateLock: `undefined` = leave
  // alone, an object = stamp all three. There is no clear case — a quote that has been shown to a
  // customer has been shown to a customer.
  customerTotal?: { cents: number; at: Date; via: 'sent' | 'pay_link' };
  // Offer validity (spec 2026-08-05 D9). Stamped on → ready; null = no validity recorded.
  offerValidUntil?: Date | null;
}

// Analytics projections (spec 2026-07-23 founder analytics). Two BOUNDED fetches so analytics
// cost scales with the viewed window, not table age (owner perf requirement):
//   - Funnel rows are scalars only — request_json/result_json are never pulled for the funnel.
//   - Demand rows are the ONLY projection carrying request_json, bounded to created-in-range.
// `channel` defaults to 'ops' (the internal quoting funnel); 'web'/'all' exist so later
// customer-website analytics is a parameter, not a rework.
export type AnalyticsChannel = 'ops' | 'web' | 'all';

export interface FunnelQuoteRow {
  id: string;
  status: QuoteStatus;
  product: string;
  totalCents: number;
  // Partial-leg pay links (spec 2026-08-04): the amount actually sold when only some legs were
  // bought, else null. wonValue uses it; sent/pipeline/aging keep using totalCents, because what
  // was OFFERED is still the whole quote.
  soldCents: number | null;
  currency: string;
  marginCents: number | null;
  lostReason: string | null;
  createdAt: Date;
  sentAt: Date | null;
  decidedAt: Date | null;
}

export interface DemandQuoteRow {
  id: string;
  status: QuoteStatus;
  product: string;
  vehicle: string | null;
  requestedService: string | null;
  offerValidUntil: Date | null;
  totalCents: number;
  currency: string;
  createdAt: Date;
  request: unknown;
}

// Statuses that are "live" right now — the pipeline/aging/in-review snapshots need this whole
// set regardless of age, so listFunnelRows includes them outside the time window too.
export const LIVE_STATUSES: readonly QuoteStatus[] = ['sent', 'pending_review', 'changes_requested', 'ready'];

// Quote version history (spec 2026-08-05 §4). One superseded state.
export interface QuoteRevision {
  revision: number;
  totalCents: number;
  currency: string;
  rateCardVersion: string | null;
  status: string | null;
  updatedBy: string | null;
  createdAt: Date;
  // Raw content, for the route's field-level diff. NEVER echoed to the wire — it carries margin.
  request: unknown;
  result: unknown;
}

// Key-order-stable, so re-serialising identical content can't fake a change.
function stableStringify(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(
          Object.entries(val as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y)),
        )
      : val,
  );
}

// Did a save actually change the quote? Compares REQUEST only: `result` is re-priced server-side
// on every save, so a rate-card move would look like an operator edit and record phantom history.
// A wrong answer here must fail benignly — an extra revision row, never a missing one.
export function sameQuoteContent(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

export interface QuoteRepo {
  save(q: NewQuote): Promise<SavedQuote>;
  get(id: string): Promise<SavedQuote | null>;
  // The quote a booking was converted from, if any. Reverse of convertedBookingId, so a
  // booking that dies can take its quote's "won" outcome down with it (services/quoteOutcome).
  findByConvertedBookingId(bookingId: string): Promise<SavedQuote | null>;
  list(filter?: QuoteListFilter): Promise<QuoteSummary[]>;
  // Rows whose created/sent/decided stamp falls after `since`, PLUS every currently-live row
  // (see LIVE_STATUSES). Ordered createdAt desc; `truncated` = the limit cut rows off.
  listFunnelRows(since: Date, limit: number, channel?: AnalyticsChannel): Promise<{ rows: FunnelQuoteRow[]; truncated: boolean }>;
  // Rows created in [from, to]. Ordered createdAt desc so a truncation keeps the most recent.
  listDemandRows(from: Date, to: Date, limit: number, channel?: AnalyticsChannel): Promise<{ rows: DemandQuoteRow[]; truncated: boolean }>;
  patch(id: string, patch: QuotePatch): Promise<SavedQuote | null>;
  // Superseded versions, newest first. Empty for a quote never edited.
  listRevisions(quoteId: string): Promise<QuoteRevision[]>;
  // Rewrite an existing quote's priced CONTENT in place (re-priced server-side on save).
  // Leaves the lifecycle alone — status/reference/createdAt and the sent/decided stamps are
  // untouched — so a founder editing a quote mid-review corrects the same row, never a
  // duplicate. Returns null for an unknown id.
  update(id: string, q: NewQuote): Promise<SavedQuote | null>;
  // Soft-delete: stamp deletedAt/deletedBy and hide the row from get()/list() while keeping it in
  // the table. Idempotent-ish: returns null for an unknown or already-deleted id. Role/status
  // gating lives in the route, not here — the repo only records the intent.
  softDelete(id: string, deletedBy: string): Promise<SavedQuote | null>;
  updateWebV2(args: {
    id: string;
    accessTokenDigest: string;
    expectedRevision: number;
    now: Date;
    quote: NewQuote;
  }): Promise<
    | { kind: 'updated'; quote: SavedQuote }
    | { kind: 'access_denied' | 'expired' | 'stale_revision' | 'converted' }
  >;
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

// A shell is the row "+ New quote" creates before anything is priceable: request_json and
// result_json are both { shell: true }. POST /save overwrites request/result wholesale, so the
// marker cannot survive a real save — that is what makes it safe to store a $0 row with no
// nullable-money migration.
export function isUnpricedShell(q: { request: unknown }): boolean {
  return !!q.request && typeof q.request === 'object' && (q.request as { shell?: unknown }).shell === true;
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
    assignedTo: q.assignedTo,
    routeText: quoteRouteText(requestLegs(q.request)),
    unpriced: isUnpricedShell(q),
    createdAt: q.createdAt,
  };
}

export class InMemoryQuoteRepo implements QuoteRepo {
  private rows = new Map<string, SavedQuote>();
  // Superseded versions, oldest-first per quote (listRevisions reverses).
  private revisions = new Map<string, QuoteRevision[]>();
  private usedReferences = new Set<string>();

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
      rateCardJson: q.rateCardJson ?? null,
      rateLockedUntil: q.rateLockedUntil ?? null,
      intent: q.intent ?? null,
      intentFingerprint: q.intentFingerprint ?? null,
      revision: q.revision ?? 1,
      payLinkSelection: null,
      soldCents: null,
      payLinkSeq: 0,
      customerTotalCents: null,
      customerTotalAt: null,
      customerTotalVia: null,
      accessTokenDigest: q.accessTokenDigest ?? null,
      convertedBookingId: null,
      notes: q.notes ?? null,
      internalNotes: q.internalNotes ?? null,
      requestedService: q.requestedService ?? null,
      // Offer validity (spec 2026-08-05 D9): never set at save() — a new quote isn't approved
      // yet. Stamped later via patch() on the → ready transition.
      offerValidUntil: null,
      assignedTo: q.assignedTo ?? null, // auto-assigned to the creator on save (spec 2026-07-22)
      assignedAt: q.assignedTo ? now : null,
      createdBy: q.createdBy ?? null,
      updatedBy: q.updatedBy ?? null,
      deletedAt: null,
      deletedBy: null,
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
    return row && !row.deletedAt ? { ...row } : null;
  }

  async findByConvertedBookingId(bookingId: string): Promise<SavedQuote | null> {
    for (const row of this.rows.values()) {
      if (!row.deletedAt && row.convertedBookingId === bookingId) return { ...row };
    }
    return null;
  }

  async list(filter: QuoteListFilter = {}): Promise<QuoteSummary[]> {
    let rows = [...this.rows.values()].filter((r) => !r.deletedAt);
    if (filter.channel) rows = rows.filter((r) => r.channel === filter.channel);
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

  private analyticsBase(channel: AnalyticsChannel): SavedQuote[] {
    return [...this.rows.values()].filter(
      (r) => !r.deletedAt && (channel === 'all' || r.channel === channel),
    );
  }

  async listFunnelRows(since: Date, limit: number, channel: AnalyticsChannel = 'ops'): Promise<{ rows: FunnelQuoteRow[]; truncated: boolean }> {
    const all = this.analyticsBase(channel)
      .filter((r) =>
        (r.createdAt >= since ||
        (r.sentAt && r.sentAt >= since) ||
        (r.decidedAt && r.decidedAt >= since) ||
        LIVE_STATUSES.includes(r.status)) &&
        // Autosave shells never count as demand (spec 2026-07-29): they are rows created by clicking
        // "+ New quote", not quotes anyone built. Counting them would inflate the funnel's draft stage.
        !isUnpricedShell(r))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const rows = all.slice(0, limit).map((r): FunnelQuoteRow => ({
      id: r.id, status: r.status, product: r.product, totalCents: r.totalCents, soldCents: r.soldCents,
      currency: r.currency, marginCents: r.marginCents, lostReason: r.lostReason,
      createdAt: r.createdAt, sentAt: r.sentAt, decidedAt: r.decidedAt,
    }));
    return { rows, truncated: all.length > limit };
  }

  async listDemandRows(from: Date, to: Date, limit: number, channel: AnalyticsChannel = 'ops'): Promise<{ rows: DemandQuoteRow[]; truncated: boolean }> {
    const all = this.analyticsBase(channel)
      .filter((r) =>
        r.createdAt >= from && r.createdAt <= to &&
        // Autosave shells never count as demand (spec 2026-07-29): they are rows created by clicking
        // "+ New quote", not quotes anyone built. Counting them would inflate the funnel's draft stage.
        !isUnpricedShell(r))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const rows = all.slice(0, limit).map((r): DemandQuoteRow => ({
      id: r.id, status: r.status, product: r.product, vehicle: r.vehicle,
      requestedService: r.requestedService, offerValidUntil: r.offerValidUntil, totalCents: r.totalCents,
      currency: r.currency, createdAt: r.createdAt, request: r.request,
    }));
    return { rows, truncated: all.length > limit };
  }

  async listRevisions(quoteId: string): Promise<QuoteRevision[]> {
    return [...(this.revisions.get(quoteId) ?? [])].reverse().map((r) => ({ ...r }));
  }

  async patch(id: string, patch: QuotePatch): Promise<SavedQuote | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    const now = new Date();
    if (patch.status) {
      row.status = patch.status;
      if (patch.status === 'sent' && !row.sentAt) row.sentAt = now;
      // Write-once WHILE decided: an outcome flip (won→lost when a booking is cancelled)
      // deliberately keeps the original decision date, so correcting an outcome never moves
      // the row between analytics windows. But returning to an editable state means the quote
      // is no longer decided at all — leaving the stamp would make a revived-then-won quote
      // report as won on the day it EXPIRED. Clear it and let the next decision stamp fresh.
      if (DECIDED.includes(patch.status)) {
        if (!row.decidedAt) row.decidedAt = now;
      } else {
        row.decidedAt = null;
      }
    }
    if (patch.lostReason !== undefined) row.lostReason = patch.lostReason;
    if (patch.notes !== undefined) row.notes = patch.notes;
    if (patch.internalNotes !== undefined) row.internalNotes = patch.internalNotes;
    if (patch.rateLock !== undefined) {
      row.rateCardJson = patch.rateLock?.rateCardJson ?? null;
      row.rateLockedUntil = patch.rateLock?.rateLockedUntil ?? null;
    }
    if (patch.assignedTo !== undefined) {
      row.assignedTo = patch.assignedTo;
      row.assignedAt = patch.assignedTo ? now : null;
    }
    if (patch.updatedBy !== undefined) row.updatedBy = patch.updatedBy;
    if (patch.convertedBookingId !== undefined) row.convertedBookingId = patch.convertedBookingId;
    if (patch.payLinkSelection !== undefined) row.payLinkSelection = patch.payLinkSelection;
    if (patch.soldCents !== undefined) row.soldCents = patch.soldCents;
    if (patch.payLinkSeq !== undefined) row.payLinkSeq = patch.payLinkSeq;
    // All three together or none: a baseline amount without its date would render an indicator
    // that cannot say when the customer was quoted it.
    if (patch.customerTotal !== undefined) {
      row.customerTotalCents = patch.customerTotal.cents;
      row.customerTotalAt = patch.customerTotal.at;
      row.customerTotalVia = patch.customerTotal.via;
    }
    if (patch.offerValidUntil !== undefined) row.offerValidUntil = patch.offerValidUntil;
    row.updatedAt = now;
    return { ...row };
  }

  async update(id: string, q: NewQuote): Promise<SavedQuote | null> {
    const row = this.rows.get(id);
    // Same guard softDelete uses: a deleted row is off-limits to a content write. The shell sweep
    // can delete a shell an operator still has open, and their next autosave would otherwise
    // write the real priced quote into the deleted row — invisible in the queue forever.
    if (!row || row.deletedAt) return null; // unknown or deleted
    // Snapshot the state being SUPERSEDED (spec 2026-08-05 §4) — before a single field moves, and
    // only when the content really changed. A no-op flush (transition() saves even a clean quote)
    // would otherwise fill the timeline with rows carrying no information.
    if (!sameQuoteContent(row.request, q.request)) {
      const list = this.revisions.get(id) ?? [];
      list.push({
        revision: row.revision,
        totalCents: row.totalCents,
        currency: row.currency,
        rateCardVersion: row.rateCardVersion,
        status: row.status,
        // An unedited revision 1 has no updatedBy — fall back to its author rather than showing
        // a version nobody wrote.
        updatedBy: row.updatedBy ?? row.createdBy,
        createdAt: new Date(),
        request: row.request,
        result: row.result,
      });
      this.revisions.set(id, list);
    }
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
    row.rateCardJson = q.rateCardJson ?? null;
    row.rateLockedUntil = q.rateLockedUntil ?? null;
    row.notes = q.notes ?? null;
    row.internalNotes = q.internalNotes ?? null;
    row.requestedService = q.requestedService ?? null;
    // The stored pay-link selection dies with the content it described. legIndexes are POSITIONAL,
    // so an edit that reorders or deletes a leg leaves them pointing at legs nobody chose — the
    // revision bump already retires the token, this stops the stale selection driving the ops
    // display or a re-mint. payLinkSeq is monotonic and deliberately NOT reset (spec §6).
    row.payLinkSelection = null;
    row.soldCents = null;
    // createdBy is deliberately NOT touched here — a re-save by another staff member must not
    // rewrite authorship. Assignment is likewise untouched: it moves only via patch().
    if (q.updatedBy !== undefined) row.updatedBy = q.updatedBy ?? null;
    // See postgresQuoteRepo.update(): a content write is a new revision, and that bump is what
    // makes a pay link minted against the old price refuse to be paid.
    row.revision += 1;
    row.updatedAt = new Date();
    return { ...row };
  }

  async softDelete(id: string, deletedBy: string): Promise<SavedQuote | null> {
    const row = this.rows.get(id);
    if (!row || row.deletedAt) return null; // unknown or already deleted
    const now = new Date();
    row.deletedAt = now;
    row.deletedBy = deletedBy;
    row.updatedAt = now;
    return { ...row };
  }

  async updateWebV2(args: {
    id: string;
    accessTokenDigest: string;
    expectedRevision: number;
    now: Date;
    quote: NewQuote;
  }): Promise<
    | { kind: 'updated'; quote: SavedQuote }
    | { kind: 'access_denied' | 'expired' | 'stale_revision' | 'converted' }
  > {
    const row = this.rows.get(args.id);
    if (
      !row ||
      row.deletedAt ||
      row.channel !== 'web' ||
      !row.accessTokenDigest ||
      row.accessTokenDigest !== args.accessTokenDigest
    ) {
      return { kind: 'access_denied' };
    }
    if (row.convertedBookingId) return { kind: 'converted' };
    if (!row.rateLockedUntil || row.rateLockedUntil <= args.now) return { kind: 'expired' };
    if (row.revision !== args.expectedRevision) return { kind: 'stale_revision' };

    // Snapshot the superseded state (spec 2026-08-05 §5). AFTER every guard above: a refused edit
    // changed nothing, so recording a version for it would claim history that never happened.
    if (!sameQuoteContent(row.request, args.quote.request)) {
      const list = this.revisions.get(args.id) ?? [];
      list.push({
        revision: row.revision,
        totalCents: row.totalCents,
        currency: row.currency,
        rateCardVersion: row.rateCardVersion,
        status: row.status,
        updatedBy: row.updatedBy ?? row.createdBy,
        createdAt: new Date(),
        request: row.request,
        result: row.result,
      });
      this.revisions.set(args.id, list);
    }

    row.product = args.quote.product;
    row.vehicle = args.quote.vehicle ?? null;
    row.totalCents = args.quote.totalCents;
    row.currency = args.quote.currency;
    row.rateCardVersion = args.quote.rateCardVersion;
    row.marginCents = args.quote.marginCents ?? null;
    row.request = args.quote.request;
    row.result = args.quote.result;
    row.intent = args.quote.intent ?? null;
    row.intentFingerprint = args.quote.intentFingerprint ?? null;
    row.revision += 1;
    row.updatedAt = args.now;
    return { kind: 'updated', quote: { ...row } };
  }

  snapshotForQuoteConversion(): {
    rows: Map<string, SavedQuote>;
    usedReferences: Set<string>;
  } {
    return {
      rows: structuredClone(this.rows),
      usedReferences: structuredClone(this.usedReferences),
    };
  }

  restoreForQuoteConversion(snapshot: ReturnType<InMemoryQuoteRepo['snapshotForQuoteConversion']>): void {
    this.rows = structuredClone(snapshot.rows);
    this.usedReferences = structuredClone(snapshot.usedReferences);
  }
}
