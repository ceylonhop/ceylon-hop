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

export interface PaymentRepo {
  create(p: NewPayment): Promise<Payment>;
  findByIdempotencyKey(key: string): Promise<Payment | null>;
  findByOrderId(orderId: string): Promise<Payment | null>;
  markSucceeded(id: string): Promise<Payment>;
}

export class InMemoryPaymentRepo implements PaymentRepo {
  private byId = new Map<string, Payment>();
  private byKey = new Map<string, string>();
  private byOrder = new Map<string, string>();

  async create(p: NewPayment): Promise<Payment> {
    const existing = await this.findByIdempotencyKey(p.idempotencyKey);
    if (existing) return existing;
    const payment: Payment = { ...p, id: randomUUID(), status: 'pending' };
    this.byId.set(payment.id, payment);
    this.byKey.set(payment.idempotencyKey, payment.id);
    this.byOrder.set(payment.orderId, payment.id);
    return payment;
  }

  async findByIdempotencyKey(key: string): Promise<Payment | null> {
    const id = this.byKey.get(key);
    return id ? (this.byId.get(id) ?? null) : null;
  }

  async findByOrderId(orderId: string): Promise<Payment | null> {
    const id = this.byOrder.get(orderId);
    return id ? (this.byId.get(id) ?? null) : null;
  }

  async markSucceeded(id: string): Promise<Payment> {
    const p = this.byId.get(id);
    if (!p) throw new Error(`payment_not_found: ${id}`);
    const updated: Payment = { ...p, status: 'succeeded' };
    this.byId.set(id, updated);
    return updated;
  }
}
