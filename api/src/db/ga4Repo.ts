// Server-side GA4 (spec 2026-10-03). Two analytics-only stores:
//  - GaIdentityRepo: the GA visitor/session a booking checked out from (latest wins).
//  - Ga4EventLogRepo: exactly-once ledger + outbox. claim() is the arbiter — of two concurrent
//    callers exactly one gets the row; a failed or abandoned claim can be taken again, and the
//    payload stored at the FIRST claim is what every retry re-sends.

export type AdConsent = 'granted' | 'denied' | 'unknown';
export interface GaIdentity { clientId: string | null; sessionId: string | null; adConsent: AdConsent }

export interface GaIdentityRepo {
  set(bookingId: string, id: GaIdentity): Promise<void>;
  get(bookingId: string): Promise<GaIdentity | null>;
}

export type Ga4EventKind = 'purchase' | 'refund' | 'board_purchase';
export interface Ga4Claim { eventKey: string; kind: Ga4EventKind; payload: unknown; attempts: number }

export interface Ga4EventLogRepo {
  /** Own the send. Null when it is already sent or someone else holds a live claim. */
  claim(eventKey: string, kind: Ga4EventKind, payload: unknown, now: Date): Promise<Ga4Claim | null>;
  markSent(eventKey: string, now: Date): Promise<void>;
  markFailed(eventKey: string, error: string): Promise<void>;
  /** Failed rows, and claims older than STALE_CLAIM_MS, created at or after `since`. */
  listRetryable(since: Date, now: Date): Promise<Ga4Claim[]>;
}

/** A claim this old belongs to a process that died between claim and send. */
export const STALE_CLAIM_MS = 10 * 60 * 1000;

export class InMemoryGaIdentityRepo implements GaIdentityRepo {
  private readonly byBooking = new Map<string, GaIdentity>();
  async set(bookingId: string, id: GaIdentity): Promise<void> {
    this.byBooking.set(bookingId, { ...id });
  }
  async get(bookingId: string): Promise<GaIdentity | null> {
    const id = this.byBooking.get(bookingId);
    return id ? { ...id } : null;
  }
}

interface Row {
  eventKey: string; kind: Ga4EventKind; payload: unknown; attempts: number;
  status: 'claimed' | 'sent' | 'failed'; claimedAt: Date; createdAt: Date; sentAt: Date | null; lastError: string | null;
}

export class InMemoryGa4EventLogRepo implements Ga4EventLogRepo {
  private readonly rows = new Map<string, Row>();
  private view(r: Row): Ga4Claim {
    return { eventKey: r.eventKey, kind: r.kind, payload: r.payload, attempts: r.attempts };
  }
  private retryable(r: Row, now: Date): boolean {
    return r.status === 'failed' || (r.status === 'claimed' && now.getTime() - r.claimedAt.getTime() > STALE_CLAIM_MS);
  }
  async claim(eventKey: string, kind: Ga4EventKind, payload: unknown, now: Date): Promise<Ga4Claim | null> {
    const row = this.rows.get(eventKey);
    if (!row) {
      const fresh: Row = { eventKey, kind, payload, attempts: 1, status: 'claimed', claimedAt: now, createdAt: now, sentAt: null, lastError: null };
      this.rows.set(eventKey, fresh);
      return this.view(fresh);
    }
    if (!this.retryable(row, now)) return null;
    row.status = 'claimed';
    row.attempts += 1;
    row.claimedAt = now;
    return this.view(row);
  }
  async markSent(eventKey: string, now: Date): Promise<void> {
    const row = this.rows.get(eventKey);
    if (row) { row.status = 'sent'; row.sentAt = now; }
  }
  async markFailed(eventKey: string, error: string): Promise<void> {
    const row = this.rows.get(eventKey);
    if (row) { row.status = 'failed'; row.lastError = error.slice(0, 500); }
  }
  async listRetryable(since: Date, now: Date): Promise<Ga4Claim[]> {
    return [...this.rows.values()]
      .filter((r) => r.createdAt.getTime() >= since.getTime() && this.retryable(r, now))
      .map((r) => this.view(r));
  }
}
