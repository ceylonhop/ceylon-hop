import { desc, eq } from 'drizzle-orm';
import type { Db } from './client';
import { promoCodes } from './schema';
import { pgUniqueViolation } from './postgresBookingRepo';
import { toPromoCode } from './promoCodeRow';
import {
  PromoCodeTakenError,
  type NewPromoCode,
  type PromoCodePatch,
  type PromoCodeRepo,
} from './promoCodeRepo';
import type { PromoCode } from '../domain/promoCode';

export class PostgresPromoCodeRepo implements PromoCodeRepo {
  constructor(private readonly db: Db) {}

  async create(input: NewPromoCode, now: Date): Promise<PromoCode> {
    try {
      const [row] = await this.db.insert(promoCodes).values({ ...input, createdAt: now }).returning();
      return toPromoCode(row);
    } catch (err) {
      // Let the unique constraint decide: two concurrent creates both pass a read-then-insert.
      if (pgUniqueViolation(err)?.constraint.includes('promo_codes_code_unique')) throw new PromoCodeTakenError();
      throw err;
    }
  }

  async get(id: string): Promise<PromoCode | null> {
    const [row] = await this.db.select().from(promoCodes).where(eq(promoCodes.id, id));
    return row ? toPromoCode(row) : null;
  }

  async getByCode(code: string): Promise<PromoCode | null> {
    const [row] = await this.db.select().from(promoCodes).where(eq(promoCodes.code, code));
    return row ? toPromoCode(row) : null;
  }

  async list(): Promise<PromoCode[]> {
    const rows = await this.db.select().from(promoCodes).orderBy(desc(promoCodes.createdAt));
    return rows.map(toPromoCode);
  }

  async update(id: string, patch: PromoCodePatch, now: Date): Promise<PromoCode | null> {
    const [row] = await this.db
      .update(promoCodes)
      .set({
        ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
        ...(patch.maxUses !== undefined ? { maxUses: patch.maxUses } : {}),
        ...(patch.active !== undefined ? { active: patch.active } : {}),
        updatedBy: patch.updatedBy,
        updatedAt: now,
      })
      .where(eq(promoCodes.id, id))
      .returning();
    return row ? toPromoCode(row) : null;
  }
}
