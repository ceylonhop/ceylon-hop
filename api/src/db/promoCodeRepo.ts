import { randomUUID } from 'node:crypto';
import type { PromoCode, PromoMethod } from '../domain/promoCode';

// Promo code storage (spec 2026-09-14 §8.2). Stores codes only — uses are counted by BookingRepo.

export interface NewPromoCode {
  code: string; // already normalised
  method: PromoMethod;
  value: number;
  startsAt: Date | null;
  expiresAt: Date;
  maxUses: number;
  createdBy: string;
}

export interface PromoCodePatch {
  expiresAt?: Date;
  maxUses?: number;
  active?: boolean;
  updatedBy: string;
}

export class PromoCodeTakenError extends Error {
  constructor() {
    super('CODE_TAKEN');
    this.name = 'PromoCodeTakenError';
  }
}

export interface PromoCodeRepo {
  create(input: NewPromoCode, now: Date): Promise<PromoCode>;
  get(id: string): Promise<PromoCode | null>;
  /** `code` must already be normalised. */
  getByCode(code: string): Promise<PromoCode | null>;
  /** Newest first. */
  list(): Promise<PromoCode[]>;
  /** Null when no such code. */
  update(id: string, patch: PromoCodePatch, now: Date): Promise<PromoCode | null>;
}

// The same rules as the migration's CHECK constraints, so the fake refuses what Postgres refuses.
function assertStorable(c: PromoCode): void {
  const valueOk = c.method === 'percentage'
    ? Number.isInteger(c.value) && c.value >= 100 && c.value <= 3000
    : c.method === 'fixed' && Number.isInteger(c.value) && c.value > 0;
  const ok = /^[A-Z0-9-]{3,32}$/.test(c.code)
    && valueOk
    && Number.isInteger(c.maxUses) && c.maxUses >= 1
    && (c.startsAt === null || c.startsAt.getTime() < c.expiresAt.getTime())
    && c.createdBy.trim() !== '';
  if (!ok) throw new Error('PROMO_CODE_CONSTRAINT');
}

const copy = (c: PromoCode): PromoCode => ({
  ...c,
  startsAt: c.startsAt ? new Date(c.startsAt) : null,
  expiresAt: new Date(c.expiresAt),
  createdAt: new Date(c.createdAt),
  updatedAt: c.updatedAt ? new Date(c.updatedAt) : null,
});

export class InMemoryPromoCodeRepo implements PromoCodeRepo {
  private byId = new Map<string, PromoCode>();

  async create(input: NewPromoCode, now: Date): Promise<PromoCode> {
    if ([...this.byId.values()].some((c) => c.code === input.code)) throw new PromoCodeTakenError();
    const row: PromoCode = {
      ...input,
      id: randomUUID(),
      active: true,
      createdAt: new Date(now),
      updatedBy: null,
      updatedAt: null,
    };
    assertStorable(row);
    this.byId.set(row.id, row);
    return copy(row);
  }

  async get(id: string): Promise<PromoCode | null> {
    const row = this.byId.get(id);
    return row ? copy(row) : null;
  }

  async getByCode(code: string): Promise<PromoCode | null> {
    const row = [...this.byId.values()].find((c) => c.code === code);
    return row ? copy(row) : null;
  }

  async list(): Promise<PromoCode[]> {
    return [...this.byId.values()]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(copy);
  }

  async update(id: string, patch: PromoCodePatch, now: Date): Promise<PromoCode | null> {
    const row = this.byId.get(id);
    if (!row) return null;
    const next: PromoCode = {
      ...row,
      ...(patch.expiresAt !== undefined ? { expiresAt: new Date(patch.expiresAt) } : {}),
      ...(patch.maxUses !== undefined ? { maxUses: patch.maxUses } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
      updatedBy: patch.updatedBy,
      updatedAt: new Date(now),
    };
    assertStorable(next);
    this.byId.set(id, next);
    return copy(next);
  }
}
