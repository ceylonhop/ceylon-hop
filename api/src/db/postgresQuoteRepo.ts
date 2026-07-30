import { and, desc, eq, gt, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Db } from './client';
import { quotes } from './schema';
import { genReference, parseDateFilter, LIVE_STATUSES, isUnpricedShell } from './quoteRepo';
import { quoteRouteText, requestLegs } from './quoteRouteText';
import type {
  QuoteRepo,
  NewQuote,
  SavedQuote,
  QuoteSummary,
  QuoteListFilter,
  QuotePatch,
  QuoteStatus,
  AnalyticsChannel,
  FunnelQuoteRow,
  DemandQuoteRow,
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

export function quoteRowToSaved(r: Row): SavedQuote {
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
    intent: r.intentJson,
    intentFingerprint: r.intentFingerprint,
    revision: r.revision,
    accessTokenDigest: r.accessTokenDigest,
    convertedBookingId: r.convertedBookingId,
    notes: r.notes,
    internalNotes: r.internalNotes,
    requestedService: r.requestedService,
    assignedTo: r.assignedTo,
    assignedAt: r.assignedAt,
    createdBy: r.createdBy,
    updatedBy: r.updatedBy,
    deletedAt: r.deletedAt,
    deletedBy: r.deletedBy,
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
            intentJson: (q.intent ?? null) as object | null,
            intentFingerprint: q.intentFingerprint ?? null,
            revision: q.revision ?? 1,
            accessTokenDigest: q.accessTokenDigest ?? null,
            notes: q.notes ?? null,
            internalNotes: q.internalNotes ?? null,
            requestedService: q.requestedService ?? null,
            createdBy: q.createdBy ?? null,
            updatedBy: q.updatedBy ?? null,
            assignedTo: q.assignedTo ?? null, // auto-assigned to the creator on insert (2026-07-22)
            assignedAt: q.assignedTo ? new Date() : null,
          })
          .returning();
        return quoteRowToSaved(row);
      } catch (err) {
        if (!isReferenceCollision(err)) throw err;
        lastErr = err;
      }
    }
    throw lastErr;
  }

  async get(id: string): Promise<SavedQuote | null> {
    const rows = await this.db
      .select()
      .from(quotes)
      .where(and(eq(quotes.id, id), isNull(quotes.deletedAt)));
    return rows[0] ? quoteRowToSaved(rows[0]) : null;
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
    const [updated] = await this.db
      .update(quotes)
      .set({
        product: args.quote.product,
        vehicle: args.quote.vehicle ?? null,
        totalCents: args.quote.totalCents,
        currency: args.quote.currency,
        rateCardVersion: args.quote.rateCardVersion,
        marginCents: args.quote.marginCents ?? null,
        requestJson: args.quote.request,
        resultJson: args.quote.result,
        intentJson: (args.quote.intent ?? null) as object | null,
        intentFingerprint: args.quote.intentFingerprint ?? null,
        revision: sql`${quotes.revision} + 1`,
        updatedAt: args.now,
      })
      .where(
        and(
          eq(quotes.id, args.id),
          eq(quotes.channel, 'web'),
          eq(quotes.accessTokenDigest, args.accessTokenDigest),
          eq(quotes.revision, args.expectedRevision),
          gt(quotes.rateLockedUntil, args.now),
          isNull(quotes.deletedAt),
          isNull(quotes.convertedBookingId),
        ),
      )
      .returning();
    if (updated) return { kind: 'updated', quote: quoteRowToSaved(updated) };

    const [current] = await this.db.select().from(quotes).where(eq(quotes.id, args.id));
    if (
      !current ||
      current.deletedAt ||
      current.channel !== 'web' ||
      !current.accessTokenDigest ||
      current.accessTokenDigest !== args.accessTokenDigest
    ) {
      return { kind: 'access_denied' };
    }
    if (current.convertedBookingId) return { kind: 'converted' };
    if (!current.rateLockedUntil || current.rateLockedUntil <= args.now) return { kind: 'expired' };
    return { kind: 'stale_revision' };
  }

  // Shared channel arm for the analytics projections ('all' = no channel condition).
  private channelCond(channel: AnalyticsChannel) {
    return channel === 'all' ? [] : [eq(quotes.channel, channel)];
  }

  async listFunnelRows(since: Date, limit: number, channel: AnalyticsChannel = 'ops'): Promise<{ rows: FunnelQuoteRow[]; truncated: boolean }> {
    // Window arm (any lifecycle stamp after `since`) OR live arm (open statuses, any age) —
    // the live set is what the pipeline/aging snapshots aggregate and is inherently small.
    // Scalars only: request_json/result_json are deliberately never selected here (perf).
    const rows = await this.db
      .select({
        id: quotes.id, status: quotes.status, product: quotes.product,
        totalCents: quotes.totalCents, currency: quotes.currency,
        marginCents: quotes.marginCents, lostReason: quotes.lostReason,
        createdAt: quotes.createdAt, sentAt: quotes.sentAt, decidedAt: quotes.decidedAt,
      })
      .from(quotes)
      .where(and(
        isNull(quotes.deletedAt),
        ...this.channelCond(channel),
        or(
          gte(quotes.createdAt, since),
          gte(quotes.sentAt, since),
          gte(quotes.decidedAt, since),
          inArray(quotes.status, [...LIVE_STATUSES]),
        ),
      ))
      .orderBy(desc(quotes.createdAt))
      .limit(limit + 1); // one extra row = cheap truncation probe
    const truncated = rows.length > limit;
    return {
      rows: rows.slice(0, limit).map((r) => ({ ...r, status: r.status as QuoteStatus })),
      truncated,
    };
  }

  async listDemandRows(from: Date, to: Date, limit: number, channel: AnalyticsChannel = 'ops'): Promise<{ rows: DemandQuoteRow[]; truncated: boolean }> {
    // The ONLY analytics query that touches request_json — bounded to created-in-range.
    const rows = await this.db
      .select({
        id: quotes.id, status: quotes.status, product: quotes.product,
        vehicle: quotes.vehicle, requestedService: quotes.requestedService,
        totalCents: quotes.totalCents, currency: quotes.currency,
        createdAt: quotes.createdAt, request: quotes.requestJson,
      })
      .from(quotes)
      .where(and(
        isNull(quotes.deletedAt),
        ...this.channelCond(channel),
        gte(quotes.createdAt, from),
        lte(quotes.createdAt, to),
      ))
      .orderBy(desc(quotes.createdAt))
      .limit(limit + 1);
    const truncated = rows.length > limit;
    return {
      rows: rows.slice(0, limit).map((r) => ({ ...r, status: r.status as QuoteStatus })),
      truncated,
    };
  }

  async list(filter: QuoteListFilter = {}): Promise<QuoteSummary[]> {
    const conds = [isNull(quotes.deletedAt)]; // soft-deleted quotes never appear in the queue
    if (filter.channel) conds.push(eq(quotes.channel, filter.channel));
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
        assignedTo: quotes.assignedTo,
        createdAt: quotes.createdAt,
        // The whole request_json rides along so routeText can be derived with the same
        // requestLegs()/quoteRouteText() JS used by the in-memory repo — one derivation, not a
        // second one written in SQL. That's only acceptable because /list is bounded by row
        // count, not by the projection: it's unbounded but the queue is ~24 rows today (see the
        // spec's cost note and D5's revisit trigger). The payoff is that this puts the entire
        // derivation under the in-memory tests that already run in CI, instead of splitting the
        // legs-lookup fallback across two implementations that can silently drift.
        request: quotes.requestJson,
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
      assignedTo: r.assignedTo,
      createdAt: r.createdAt,
      routeText: quoteRouteText(requestLegs(r.request)),
      unpriced: isUnpricedShell({ request: r.request }),
    }));
  }

  async patch(id: string, patch: QuotePatch): Promise<SavedQuote | null> {
    const [row] = await this.db
      .update(quotes)
      .set({
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.lostReason !== undefined ? { lostReason: patch.lostReason } : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
        ...(patch.internalNotes !== undefined ? { internalNotes: patch.internalNotes } : {}),
        ...(patch.rateLock !== undefined
          ? {
              rateCardJson: (patch.rateLock?.rateCardJson ?? null) as object | null,
              rateLockedUntil: patch.rateLock?.rateLockedUntil ?? null,
            }
          : {}),
        // Assignment moves as a unit with its stamp, so assignedAt can never disagree with
        // assignedTo (an assignee with no date, or a date with nobody holding it).
        ...(patch.assignedTo !== undefined
          ? { assignedTo: patch.assignedTo, assignedAt: patch.assignedTo ? new Date() : null }
          : {}),
        ...(patch.updatedBy !== undefined ? { updatedBy: patch.updatedBy } : {}),
        ...(patch.convertedBookingId !== undefined ? { convertedBookingId: patch.convertedBookingId } : {}),
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
    return row ? quoteRowToSaved(row) : null;
  }

  async update(id: string, q: NewQuote): Promise<SavedQuote | null> {
    // Content only — status/reference/createdAt, the sent/decided stamps, createdBy and the
    // assignment are all left as-is. (createdBy is write-once; assignment moves only via patch.)
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
        internalNotes: q.internalNotes ?? null,
        requestedService: q.requestedService ?? null,
        ...(q.updatedBy !== undefined ? { updatedBy: q.updatedBy ?? null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(quotes.id, id))
      .returning();
    return row ? quoteRowToSaved(row) : null;
  }

  async softDelete(id: string, deletedBy: string): Promise<SavedQuote | null> {
    // Only stamp a row that isn't already deleted, so a double-delete returns null rather than
    // silently re-stamping (and moving deletedBy/updatedAt).
    const now = new Date();
    const [row] = await this.db
      .update(quotes)
      .set({ deletedAt: now, deletedBy, updatedAt: now })
      .where(and(eq(quotes.id, id), isNull(quotes.deletedAt)))
      .returning();
    return row ? quoteRowToSaved(row) : null;
  }
}
