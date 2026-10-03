import { and, eq, gte, lt, ne, or, sql } from 'drizzle-orm';
import type { Db } from './client';
import { bookingGaIdentity, ga4EventLog } from './schema';
import {
  STALE_CLAIM_MS,
  type AdConsent, type Ga4Claim, type Ga4EventKind, type Ga4EventLogRepo, type GaIdentity, type GaIdentityRepo,
} from './ga4Repo';

export class PostgresGaIdentityRepo implements GaIdentityRepo {
  constructor(private readonly db: Db) {}

  async set(bookingId: string, id: GaIdentity): Promise<void> {
    await this.db
      .insert(bookingGaIdentity)
      .values({ bookingId, clientId: id.clientId, sessionId: id.sessionId, adConsent: id.adConsent })
      .onConflictDoUpdate({
        target: bookingGaIdentity.bookingId,
        set: { clientId: id.clientId, sessionId: id.sessionId, adConsent: id.adConsent, updatedAt: new Date() },
      });
  }

  async get(bookingId: string): Promise<GaIdentity | null> {
    const [row] = await this.db.select().from(bookingGaIdentity).where(eq(bookingGaIdentity.bookingId, bookingId));
    if (!row) return null;
    return { clientId: row.clientId, sessionId: row.sessionId, adConsent: (row.adConsent ?? 'unknown') as AdConsent };
  }
}

const claimView = { eventKey: ga4EventLog.eventKey, kind: ga4EventLog.kind, payload: ga4EventLog.payload, attempts: ga4EventLog.attempts };

export class PostgresGa4EventLogRepo implements Ga4EventLogRepo {
  constructor(private readonly db: Db) {}

  async claim(eventKey: string, kind: Ga4EventKind, payload: unknown, now: Date): Promise<Ga4Claim | null> {
    const stale = new Date(now.getTime() - STALE_CLAIM_MS);
    // The unique event_key arbitrates: a fresh insert, or a take-over of a failed / abandoned
    // claim. RETURNING is empty when the row is sent or someone else holds a live claim. The
    // stored payload is never overwritten — retries re-send the first hit.
    const rows = await this.db
      .insert(ga4EventLog)
      .values({ eventKey, kind, status: 'claimed', attempts: 1, payload, claimedAt: now })
      .onConflictDoUpdate({
        target: ga4EventLog.eventKey,
        set: { status: 'claimed', attempts: sql`${ga4EventLog.attempts} + 1`, claimedAt: now },
        setWhere: or(
          eq(ga4EventLog.status, 'failed'),
          and(eq(ga4EventLog.status, 'claimed'), lt(ga4EventLog.claimedAt, stale)),
        ),
      })
      .returning(claimView);
    const r = rows[0];
    return r ? { eventKey: r.eventKey, kind: r.kind as Ga4EventKind, payload: r.payload, attempts: r.attempts } : null;
  }

  async markSent(eventKey: string, now: Date): Promise<void> {
    await this.db.update(ga4EventLog).set({ status: 'sent', sentAt: now }).where(eq(ga4EventLog.eventKey, eventKey));
  }

  async markFailed(eventKey: string, error: string): Promise<void> {
    await this.db.update(ga4EventLog).set({ status: 'failed', lastError: error.slice(0, 500) })
      // Never downgrade a sent row: a slow, stale process erroring after a takeover must not re-open it.
      .where(and(eq(ga4EventLog.eventKey, eventKey), ne(ga4EventLog.status, 'sent')));
  }

  async listRetryable(since: Date, now: Date): Promise<Ga4Claim[]> {
    const stale = new Date(now.getTime() - STALE_CLAIM_MS);
    const rows = await this.db
      .select(claimView)
      .from(ga4EventLog)
      .where(and(
        gte(ga4EventLog.createdAt, since),
        or(eq(ga4EventLog.status, 'failed'), and(eq(ga4EventLog.status, 'claimed'), lt(ga4EventLog.claimedAt, stale))),
      ));
    return rows.map((r) => ({ eventKey: r.eventKey, kind: r.kind as Ga4EventKind, payload: r.payload, attempts: r.attempts }));
  }
}
