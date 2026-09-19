import type { promoCodes } from './schema';
import type { PromoCode, PromoMethod } from '../domain/promoCode';

export function toPromoCode(r: typeof promoCodes.$inferSelect): PromoCode {
  return {
    id: r.id,
    code: r.code,
    method: r.method as PromoMethod,
    value: r.value,
    startsAt: r.startsAt,
    expiresAt: r.expiresAt,
    maxUses: r.maxUses,
    active: r.active,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    updatedBy: r.updatedBy,
    updatedAt: r.updatedAt,
  };
}
