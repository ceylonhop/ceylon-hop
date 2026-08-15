import { randomUUID } from 'node:crypto';

export type PaymentStatus = 'pending' | 'succeeded' | 'failed';

export interface NewPayment {
  bookingId: string;
  provider: string;
  orderId: string;
  amount: number;
  currency: string;
  idempotencyKey: string;
}

export interface Payment extends NewPayment {
  id: string;
  status: PaymentStatus;
}

export interface PaymentSettlementEvidence {
  gatewayPaymentId: string | null;
  settledAt: Date | null;
  // 'manual' = an operator recorded money that arrived out-of-band (cash / bank transfer for a
  // WhatsApp booking). Distinct from 'legacy_backfill' on purpose: that source means "we have no
  // idea how this settled", whereas a manual settlement has a named operator in the booking's
  // activity notes. The DB CHECK only requires this to be non-null for a succeeded payment, so
  // the new value needs no migration.
  settlementSource: 'webhook' | 'legacy_backfill' | 'manual' | null;
  // The staff email that recorded an out-of-band payment. Null for gateway money, which has no
  // human actor. Lives here rather than in ops_notes because that field is editable by a role
  // denied payments:act — the one person who must not be able to erase it (0043).
  settledBy: string | null;
  updatedAt: Date;
}

export type InternalPaymentRecord = Payment & PaymentSettlementEvidence;

export interface PaymentRepo {
  create(p: NewPayment): Promise<Payment>;
  findByIdempotencyKey(key: string): Promise<Payment | null>;
  findByOrderId(orderId: string): Promise<Payment | null>;
  findByBookingId(bookingId: string): Promise<Payment[]>;
  markSucceeded(id: string): Promise<Payment>;
  // Settle a payment that no gateway will ever confirm (cash / bank transfer taken by ops).
  // Separate from markSucceeded() so real out-of-band money is never stamped 'legacy_backfill';
  // `reference` is whatever the operator can cite (a bank slip number), and is optional.
  markSucceededManually(id: string, evidence: { reference: string | null; settledBy: string }): Promise<Payment>;
  markFailed(id: string): Promise<Payment>;
  // Did this booking's money arrive out-of-band? findByBookingId() returns the narrow Payment
  // shape, which drops the provenance; the watchdog needs exactly this distinction to tell a
  // cash/bank settlement (no confirmation email is ever sent, by design) from gateway money that
  // silently failed to confirm. A predicate rather than a row read: no caller wants the rows.
  hasManualSettlement(bookingId: string): Promise<boolean>;
  // The GATEWAY's own payment id, which the PayHere Refund API takes as `payment_id`. Same
  // reasoning as hasManualSettlement: the narrow Payment shape drops it on purpose, and the
  // refund path wants exactly this one field rather than the whole provenance record.
  //
  // Returns null unless the money actually arrived through the gateway. markSucceededManually()
  // also writes gatewayPaymentId — with whatever the operator could cite, typically a bank slip
  // number — and a numeric-looking slip handed to PayHere's Refund API would ask them to refund
  // a payment that is not theirs. Cash and bank transfers are refunded the way they were taken.
  gatewayPaymentIdFor(paymentId: string): Promise<string | null>;
  // Who recorded an out-of-band payment; null for gateway money. Same narrow-reader shape as
  // gatewayPaymentIdFor above — the Payment type drops provenance on purpose, and there is no
  // WRITER for this outside markSucceededManually, which is what makes the record immutable (0043).
  settledByFor(paymentId: string): Promise<string | null>;
}

export class InMemoryPaymentRepo implements PaymentRepo {
  private byId = new Map<string, InternalPaymentRecord>();
  private byKey = new Map<string, string>();
  private byOrder = new Map<string, string>();

  async create(p: NewPayment): Promise<Payment> {
    const existing = await this.findByIdempotencyKey(p.idempotencyKey);
    if (existing) return existing;
    const payment: InternalPaymentRecord = {
      ...p,
      id: randomUUID(),
      status: 'pending',
      gatewayPaymentId: null,
      settledAt: null,
      settlementSource: null,
      settledBy: null,
      updatedAt: new Date(),
    };
    this.byId.set(payment.id, payment);
    this.byKey.set(payment.idempotencyKey, payment.id);
    this.byOrder.set(payment.orderId, payment.id);
    return this.toPayment(payment);
  }

  async findByIdempotencyKey(key: string): Promise<Payment | null> {
    const id = this.byKey.get(key);
    return id ? this.toPayment(this.byId.get(id) ?? null) : null;
  }

  async findByOrderId(orderId: string): Promise<Payment | null> {
    const id = this.byOrder.get(orderId);
    return id ? this.toPayment(this.byId.get(id) ?? null) : null;
  }

  async findByBookingId(bookingId: string): Promise<Payment[]> {
    return [...this.byId.values()].filter((p) => p.bookingId === bookingId).map((p) => this.toPayment(p));
  }

  async markSucceeded(id: string): Promise<Payment> {
    const p = this.byId.get(id);
    if (!p) throw new Error(`payment_not_found: ${id}`);
    const updated: InternalPaymentRecord = { ...p, status: 'succeeded', updatedAt: new Date() };
    this.byId.set(id, updated);
    return this.toPayment(updated);
  }

  async markSucceededManually(id: string, evidence: { reference: string | null; settledBy: string }): Promise<Payment> {
    const p = this.byId.get(id);
    if (!p) throw new Error(`payment_not_found: ${id}`);
    const now = new Date();
    const updated: InternalPaymentRecord = {
      ...p,
      status: 'succeeded',
      gatewayPaymentId: evidence.reference,
      settledAt: now,
      settlementSource: 'manual',
      settledBy: evidence.settledBy,
      updatedAt: now,
    };
    this.byId.set(id, updated);
    return this.toPayment(updated);
  }

  async markFailed(id: string): Promise<Payment> {
    const p = this.byId.get(id);
    if (!p) throw new Error(`payment_not_found: ${id}`);
    const updated: InternalPaymentRecord = { ...p, status: 'failed', updatedAt: new Date() };
    this.byId.set(id, updated);
    return this.toPayment(updated);
  }

  async hasManualSettlement(bookingId: string): Promise<boolean> {
    return [...this.byId.values()].some(
      (p) => p.bookingId === bookingId && p.status === 'succeeded' && p.settlementSource === 'manual',
    );
  }

  async gatewayPaymentIdFor(paymentId: string): Promise<string | null> {
    const row = this.byId.get(paymentId);
    if (!row || row.status !== 'succeeded' || row.settlementSource !== 'webhook') return null;
    return row.gatewayPaymentId ?? null;
  }

  async settledByFor(paymentId: string): Promise<string | null> {
    return this.byId.get(paymentId)?.settledBy ?? null;
  }

  getForSettlement(id: string): InternalPaymentRecord | null {
    const payment = this.byId.get(id);
    return payment ? { ...payment, updatedAt: new Date(payment.updatedAt), settledAt: payment.settledAt ? new Date(payment.settledAt) : null } : null;
  }

  findByOrderIdForSettlement(orderId: string): InternalPaymentRecord | null {
    const id = this.byOrder.get(orderId);
    return id ? this.getForSettlement(id) : null;
  }

  putForSettlement(payment: InternalPaymentRecord): void {
    this.byId.set(payment.id, {
      ...payment,
      updatedAt: new Date(payment.updatedAt),
      settledAt: payment.settledAt ? new Date(payment.settledAt) : null,
    });
  }

  snapshotForSettlement(): Map<string, InternalPaymentRecord> {
    return new Map([...this.byId].map(([id, payment]) => [id, this.cloneRecord(payment)]));
  }

  restoreForSettlement(snapshot: Map<string, InternalPaymentRecord>): void {
    this.byId = new Map([...snapshot].map(([id, payment]) => [id, this.cloneRecord(payment)]));
  }

  private cloneRecord(payment: InternalPaymentRecord): InternalPaymentRecord {
    return {
      ...payment,
      updatedAt: new Date(payment.updatedAt),
      settledAt: payment.settledAt ? new Date(payment.settledAt) : null,
    };
  }

  private toPayment(payment: InternalPaymentRecord): Payment;
  private toPayment(payment: InternalPaymentRecord | null): Payment | null;
  private toPayment(payment: InternalPaymentRecord | null): Payment | null {
    if (!payment) return null;
    return {
      id: payment.id,
      bookingId: payment.bookingId,
      provider: payment.provider,
      orderId: payment.orderId,
      amount: payment.amount,
      currency: payment.currency,
      idempotencyKey: payment.idempotencyKey,
      status: payment.status,
    };
  }
}
