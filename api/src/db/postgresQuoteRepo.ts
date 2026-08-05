import { and, desc, eq, gt, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Db } from './client';
import { quotes, quoteRevisions } from './schema';
import { genReference, parseDateFilter, LIVE_STATUSES, isUnpricedShell, sameQuoteContent } from './quoteRepo';
import { quoteRouteText, requestLegs } from './quoteRouteText';
import type {
  QuoteRepo,
  QuoteRevision,
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
    payLinkSelection: (r.payLinkSelection ?? null) as SavedQuote['payLinkSelection'],
    soldCents: r.soldCents ?? null,
    payLinkSeq: r.payLinkSeq ?? 0,
    customerTotalCents: r.customerTotalCents ?? null,
    customerTotalAt: r.customerTotalAt ?? null,
    customerTotalVia: (r.customerTotalVia ?? null) as SavedQuote['customerTotalVia'],
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

  async findByConvertedBookingId(bookingId: string): Promise<SavedQuote | null> {
    const rows = await this.db
      .select()
      .from(quotes)
      .where(and(eq(quotes.convertedBookingId, bookingId), isNull(quotes.deletedAt)))
      .limit(1);
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
        marginCents: quotes.marginCents, soldCents: quotes.soldCents, lostReason: quotes.lostReason,
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
        // Autosave shells never count as demand (spec 2026-07-29). request_json stays OUT of the
        // funnel's select — the response never carries it — but it IS referenced in this WHERE,
        // so Postgres still fetches and detoasts it off the heap to evaluate the predicate for
        // every candidate row. Not scalar-only cost-wise, just scalar-only on the wire. Fine at
        // today's volumes; revisit if this table or the shell-exclusion check ever gets heavier.
        // Compare as jsonb (->), not text (->>): ->> renders both the jsonb boolean `true` and
        // the jsonb string `"true"` as the identical text 'true', so a text comparison can't tell
        // a real shell marker from a string that merely says "true". The jsonb comparison here
        // must agree exactly with isUnpricedShell's `=== true` in quoteRepo.ts. NULL-safe: `->`
        // yields SQL NULL whenever request_json is SQL NULL, JSON null, a JSON scalar, or an
        // object without a `shell` key, and coalescing that NULL to false (then negating) keeps
        // all of those rows included rather than silently dropped by NULL's three-valued logic.
        sql`NOT coalesce(${quotes.requestJson} -> 'shell' = 'true'::jsonb, false)`,
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
        // Autosave shells never count as demand (spec 2026-07-29). Unlike listFunnelRows, this
        // query already selects request_json above (this is the one analytics query that needs
        // it), so referencing it again here in the WHERE adds no extra fetch/detoast cost — it's
        // already coming off the heap for the select.
        // Compare as jsonb (->), not text (->>): ->> renders both the jsonb boolean `true` and
        // the jsonb string `"true"` as the identical text 'true', so a text comparison can't tell
        // a real shell marker from a string that merely says "true". The jsonb comparison here
        // must agree exactly with isUnpricedShell's `=== true` in quoteRepo.ts. NULL-safe: `->`
        // yields SQL NULL whenever request_json is SQL NULL, JSON null, a JSON scalar, or an
        // object without a `shell` key, and coalescing that NULL to false (then negating) keeps
        // all of those rows included rather than silently dropped by NULL's three-valued logic.
        sql`NOT coalesce(${quotes.requestJson} -> 'shell' = 'true'::jsonb, false)`,
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
        ...(patch.payLinkSelection !== undefined
          ? { payLinkSelection: (patch.payLinkSelection ?? null) as object | null }
          : {}),
        ...(patch.soldCents !== undefined ? { soldCents: patch.soldCents } : {}),
        ...(patch.payLinkSeq !== undefined ? { payLinkSeq: patch.payLinkSeq } : {}),
        // Price-drift baseline (spec 2026-08-05) — all three or none.
        ...(patch.customerTotal !== undefined
          ? {
              customerTotalCents: patch.customerTotal.cents,
              customerTotalAt: patch.customerTotal.at,
              customerTotalVia: patch.customerTotal.via,
            }
          : {}),
        updatedAt: new Date(),
        ...(patch.status
          ? {
              sentAt:
                patch.status === 'sent'
                  ? sql`coalesce(${quotes.sentAt}, now())`
                  : sql`${quotes.sentAt}`,
              // Mirrors InMemoryQuoteRepo: keep the stamp while the quote stays decided (an
              // outcome flip must not move it between analytics windows), but clear it when
              // the quote returns to an editable state — a reopened quote is not decided, and
              // a stale stamp would report a revived-then-won quote as won on its expiry date.
              decidedAt: DECIDED.includes(patch.status)
                ? sql`coalesce(${quotes.decidedAt}, now())`
                : sql`null`,
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
    // Soft-delete guard (same as softDelete's): a deleted row is off-limits. The shell sweep can
    // delete a shell an operator still has open, and their next autosave would otherwise write
    // the real priced quote into the deleted row — a 200 for work that is invisible forever.
    //
    // One transaction (spec 2026-08-05 §5): the version snapshot and the content write land
    // together or not at all. A snapshot missing for a write that landed is a hole in the audit
    // trail; a snapshot for a write that didn't is a lie about what the quote once was.
    return this.db.transaction(async (tx) => {
    // FOR UPDATE: two concurrent saves must not both snapshot the same revision — the unique
    // (quote_id, revision) constraint would fail the loser and take a legitimate content write
    // down with it.
    const [before] = await tx
      .select()
      .from(quotes)
      .where(and(eq(quotes.id, id), isNull(quotes.deletedAt)))
      .for('update');
    if (!before) return null;

    if (!sameQuoteContent(before.requestJson, q.request)) {
      await tx.insert(quoteRevisions).values({
        quoteId: id,
        revision: before.revision,
        requestJson: before.requestJson as object | null,
        resultJson: before.resultJson as object | null,
        totalCents: before.totalCents,
        currency: before.currency,
        rateCardVersion: before.rateCardVersion,
        status: before.status,
        // An unedited revision 1 has no updatedBy — fall back to its author.
        updatedBy: before.updatedBy ?? before.createdBy,
      });
    }

    const [row] = await tx
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
        // A content write is a NEW REVISION, and whatever is holding the old one must be able
        // to tell. Pay links pin {quoteId, revision}; the bump is what lets quotePay.ts refuse a
        // link minted against a price that has since changed. Unconditional on purpose — this is
        // the ops save path, and "did the total really move?" is not a question a safety guard
        // should be asking. Saves happen only while draft/changes_requested, so autosave churn
        // costs nothing: the counter simply climbs while the quote is being worked on.
        revision: sql`${quotes.revision} + 1`,
        // The stored pay-link selection dies with the content it described: legIndexes are
        // POSITIONAL, so an edited itinerary leaves them pointing at legs nobody chose. The
        // revision bump above already retires the token; this stops the stale selection driving
        // the ops display or a re-mint. payLinkSeq is monotonic and deliberately NOT reset,
        // so a seq is never reused by a later selection (spec §6).
        payLinkSelection: null,
        soldCents: null,
        updatedAt: new Date(),
      })
      .where(and(eq(quotes.id, id), isNull(quotes.deletedAt)))
      .returning();
      return row ? quoteRowToSaved(row) : null;
    });
  }

  async listRevisions(quoteId: string): Promise<QuoteRevision[]> {
    const rows = await this.db
      .select()
      .from(quoteRevisions)
      .where(eq(quoteRevisions.quoteId, quoteId))
      .orderBy(desc(quoteRevisions.revision));
    return rows.map((r) => ({
      revision: r.revision,
      totalCents: r.totalCents,
      currency: r.currency,
      rateCardVersion: r.rateCardVersion,
      status: r.status,
      updatedBy: r.updatedBy,
      createdAt: r.createdAt,
      request: r.requestJson,
      result: r.resultJson,
    }));
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
