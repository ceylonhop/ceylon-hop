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
  settlementSource: 'webhook' | 'legacy_backfill' | null;
  updatedAt: Date;
}

export type InternalPaymentRecord = Payment & PaymentSettlementEvidence;

export interface PaymentRepo {
  create(p: NewPayment): Promise<Payment>;
  findByIdempotencyKey(key: string): Promise<Payment | null>;
  findByOrderId(orderId: string): Promise<Payment | null>;
  findByBookingId(bookingId: string): Promise<Payment[]>;
  markSucceeded(id: string): Promise<Payment>;
  markFailed(id: string): Promise<Payment>;
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

  async markFailed(id: string): Promise<Payment> {
    const p = this.byId.get(id);
    if (!p) throw new Error(`payment_not_found: ${id}`);
    const updated: InternalPaymentRecord = { ...p, status: 'failed', updatedAt: new Date() };
    this.byId.set(id, updated);
    return this.toPayment(updated);
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
