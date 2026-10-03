// The one door to GA4 (spec 2026-10-03 §5.1). Hooks call it fire-and-forget; it never throws
// into the money path's awaited code, it never reports a team test booking, and it sends each
// event exactly once through the ledger, which also stores the hit for the cron sweep's retries.

import type { Ga4Adapter, Ga4Hit } from '../../adapters/ga4';
import type { AlertAdapter } from '../../adapters/alerts';
import { personKeyFor, type Booking, type BookingRepo } from '../../db/bookingRepo';
import type { AdConsent, Ga4EventKind, Ga4EventLogRepo, GaIdentity, GaIdentityRepo } from '../../db/ga4Repo';
import type { Payment, PaymentRepo } from '../../db/paymentRepo';
import type { Refund } from '../../db/refundRepo';
import type { RideList, RideMember } from '../../domain/rideList';
import { isTeamEmail } from '../testBookings';
import { boardHit, purchaseHit, refundHit, type Ga4PurchaseName } from './ga4Hits';

/** Measurement Protocol accepts timestamps at most 72 h old; older events can never be sent. */
export const MP_BACKDATE_MS = 72 * 60 * 60 * 1000;
const ALERT_AT_ATTEMPT = 5;

export interface Ga4Reporter {
  rememberVisitor(bookingId: string, raw: unknown): Promise<void>;
  reportPayment(booking: Booking, payment: Payment, settledAt: Date): Promise<void>;
  reportRefund(booking: Booking, refund: Refund): Promise<void>;
  reportBoardCharge(list: RideList, member: RideMember, amountCents: number, currency: string, at: Date): Promise<void>;
  sweep(): Promise<{ retried: number; sent: number; failed: number }>;
}

export interface Ga4ReporterDeps {
  adapter?: Ga4Adapter;
  log: Ga4EventLogRepo;
  identities: GaIdentityRepo;
  bookings: BookingRepo;
  payments: PaymentRepo;
  alerts: AlertAdapter;
  teamEmails: ReadonlySet<string>;
  eventName: Ga4PurchaseName;
  now?: () => Date;
}

const CLIENT_ID = /^\d{1,20}\.\d{1,20}$/;
const SESSION_ID = /^\d{6,12}$/;

/** The browser's `ga` checkout field (analytics.js chGaIds), validated. Null = nothing usable. */
export function parseGaIdentity(raw: unknown): GaIdentity | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const clientId = typeof r.clientId === 'string' && CLIENT_ID.test(r.clientId) ? r.clientId : null;
  const sessionId = typeof r.sessionId === 'string' && SESSION_ID.test(r.sessionId) ? r.sessionId : null;
  const adConsent: AdConsent = r.adConsent === 'granted' || r.adConsent === 'denied' ? r.adConsent : 'unknown';
  return clientId || sessionId ? { clientId, sessionId, adConsent } : null;
}

export function createGa4Reporter(deps: Ga4ReporterDeps): Ga4Reporter {
  const now = deps.now ?? (() => new Date());

  // Only the message string ever leaves this file: the Measurement Protocol URL carries the API
  // secret, so an error object (or its cause) must never reach the ledger, an alert or a log.
  const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  /** Which event was lost: its ledger key and the booking reference or board list code (no PII). */
  interface Lost { key: string; ref: string }

  /** Analytics must never break a money path: record the failure, then swallow it. */
  async function swallow<T>(what: string, fallback: T, fn: () => Promise<T>, lost?: Lost): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const msg = messageOf(err);
      const who = lost ? ` (${lost.ref}, ${lost.key})` : '';
      // Message string only, never the error object: the Measurement Protocol URL carries the secret.
      console.error(`GA4 reporter failed in ${what}${who}: ${msg}`);
      await deps.alerts.send({
        severity: 'warning',
        kind: 'ga4_report_error',
        title: `GA4 reporter failed in ${what}${who}`,
        body: `Error: ${msg}. The payment or refund itself was not affected.`,
        dedupeKey: lost ? `ga4:error:${what}:${lost.ref}:${lost.key}` : `ga4:error:${what}`,
      }).catch(() => {});
      return fallback;
    }
  }

  async function attempt(eventKey: string, kind: Ga4EventKind, payload: unknown): Promise<'sent' | 'failed' | 'skipped'> {
    if (!deps.adapter) return 'skipped';
    const at = now();
    const claim = await deps.log.claim(eventKey, kind, payload, at);
    if (!claim) return 'skipped';
    try {
      await deps.adapter.send(claim.payload as Ga4Hit);
    } catch (err) {
      const msg = messageOf(err);
      await deps.log.markFailed(eventKey, msg);
      if (claim.attempts === ALERT_AT_ATTEMPT) {
        await deps.alerts.send({
          severity: 'warning',
          kind: 'ga4_send_failed',
          title: `GA4 could not record ${eventKey} after ${ALERT_AT_ATTEMPT} tries`,
          body: `Last error: ${msg}. The sweep keeps retrying for 72 h; after that GA4 can never receive it (revenue still in the database).`,
          dedupeKey: `ga4:${eventKey}`,
        }).catch(() => {});
      }
      return 'failed';
    }
    await deps.log.markSent(eventKey, at);
    return 'sent';
  }

  async function returningBuyer(b: Booking): Promise<boolean> {
    const mine = await deps.bookings.listByPersonKey(personKeyFor(b.input.customer.email), 25);
    const earlier = mine.filter((x) => x.id !== b.id && Date.parse(x.createdAt) < Date.parse(b.createdAt));
    if (!earlier.length) return false;
    const paid = await deps.payments.findByBookingIds(earlier.map((x) => x.id));
    return paid.some((p) => p.status === 'succeeded');
  }

  /** The transaction_id a purchase went out with, from its stored hit; null if unknown or unreadable. */
  async function sentTransactionId(eventKey: string): Promise<string | null> {
    let payload: unknown;
    try {
      payload = await deps.log.payloadOf(eventKey);
    } catch {
      return null;
    }
    const txn = (payload as Ga4Hit | null)?.events?.[0]?.params?.transaction_id;
    return typeof txn === 'string' ? txn : null;
  }

  return {
    rememberVisitor: (bookingId, raw) => swallow('rememberVisitor', undefined, async () => {
      const id = parseGaIdentity(raw);
      if (id) await deps.identities.set(bookingId, id);
    }, { key: 'ga_identity', ref: bookingId }),

    reportPayment: (booking, payment, settledAt) => swallow('reportPayment', undefined, async () => {
      if (!deps.adapter || isTeamEmail(booking.input.customer.email, deps.teamEmails)) return;
      const siblings = await deps.payments.findByBookingId(booking.id);
      const secondPayment = siblings.some((p) => p.id !== payment.id && p.status === 'succeeded');
      const hit = purchaseHit({
        booking, payment, settledAt,
        identity: await deps.identities.get(booking.id),
        returning: await returningBuyer(booking),
        secondPayment,
        eventName: deps.eventName,
      });
      await attempt(`purchase:${payment.id}`, 'purchase', hit);
    }, { key: `purchase:${payment.id}`, ref: booking.reference }),

    reportRefund: (booking, refund) => swallow('reportRefund', undefined, async () => {
      if (!deps.adapter || isTeamEmail(booking.input.customer.email, deps.teamEmails)) return;
      // A refund must carry the transaction_id its purchase was actually SENT with. A Payment has no
      // creation time to recompute "which came first", so read it back from the ledger's stored hit.
      // No row, or an unreadable payload, means the browser sent the bare reference (pre-launch).
      const sentTxn = await sentTransactionId(`purchase:${refund.paymentId}`);
      const hit = refundHit({
        booking, refund, identity: await deps.identities.get(booking.id), at: now(),
        secondPayment: sentTxn !== null && sentTxn !== booking.reference,
      });
      await attempt(`refund:${refund.id}`, 'refund', hit);
    }, { key: `refund:${refund.id}`, ref: booking.reference }),

    reportBoardCharge: (list, member, amountCents, currency, at) => swallow('reportBoardCharge', undefined, async () => {
      if (!deps.adapter || isTeamEmail(member.email, deps.teamEmails)) return;
      const hit = boardHit({ list, member, amountCents, currency, at, eventName: deps.eventName });
      await attempt(`board:${list.id}:${member.sub}`, 'board_purchase', hit);
    }, { key: `board:${list.id}`, ref: list.code }),

    sweep: () => swallow('sweep', { retried: 0, sent: 0, failed: 0 }, async () => {
      const at = now();
      const rows = await deps.log.listRetryable(new Date(at.getTime() - MP_BACKDATE_MS), at);
      let sent = 0;
      let failed = 0;
      for (const row of rows) {
        // One bad row must not strand the rest of the queue.
        // Name the row by kind and the hit's transaction_id (a reference or list code): a board
        // eventKey embeds the member's Google id, which must not reach an alert or a log.
        const txn = (row.payload as Ga4Hit | null)?.events?.[0]?.params?.transaction_id;
        const outcome = await swallow('sweep-row', 'failed' as const, () => attempt(row.eventKey, row.kind, row.payload),
          { key: row.kind, ref: typeof txn === 'string' ? txn : 'unknown' });
        if (outcome === 'sent') sent++;
        if (outcome === 'failed') failed++;
      }
      return { retried: rows.length, sent, failed };
    }),
  };
}
