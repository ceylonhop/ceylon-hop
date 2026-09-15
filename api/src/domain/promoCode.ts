// Promo codes (spec docs/superpowers/specs/2026-09-14-promo-codes-design.md §4–§5).
// Pure: no database, no clock of its own, no HTTP. Routes and repos call these so every surface
// agrees on what a code is, when it works, and whether a booking is using one.
import { z } from 'zod';
import type { DiscountRequest } from '../quote/discount';
import type { BookingStatus } from './status';

/** How long a booking holds a use before it is paid (§5.2). */
export const PROMO_HOLD_MS = 2 * 60 * 60 * 1000;

const CODE_SHAPE = /^[A-Z0-9-]{3,32}$/;

export type PromoMethod = 'fixed' | 'percentage';

export interface PromoCode {
  id: string;
  code: string;
  method: PromoMethod;
  /** Cents for `fixed`; basis points (100–3000) for `percentage`. */
  value: number;
  startsAt: Date | null;
  expiresAt: Date;
  maxUses: number;
  active: boolean;
  createdBy: string;
  createdAt: Date;
  updatedBy: string | null;
  updatedAt: Date | null;
}

export type PromoCodeErrorCode =
  | 'promo_code_invalid'
  | 'promo_code_not_started'
  | 'promo_code_expired'
  | 'promo_code_used_up'
  | 'promo_code_not_eligible';

/** Thrown by repos when a use cannot be taken; routes map `code` straight onto the response. */
export class PromoCodeRefusedError extends Error {
  constructor(public readonly code: PromoCodeErrorCode) {
    super(code);
    this.name = 'PromoCodeRefusedError';
  }
}

/** Trimmed and upper-cased, or null when it cannot be a code at all. */
export function normalizePromoCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return CODE_SHAPE.test(code) ? code : null;
}

/** §4.2 — null when the code works at `now`. Start inclusive, expiry exclusive. */
export function promoCodeAvailability(
  code: PromoCode,
  now: Date,
): 'promo_code_invalid' | 'promo_code_not_started' | 'promo_code_expired' | null {
  if (!code.active) return 'promo_code_invalid';
  if (code.startsAt && now.getTime() < code.startsAt.getTime()) return 'promo_code_not_started';
  if (now.getTime() >= code.expiresAt.getTime()) return 'promo_code_expired';
  return null;
}

/** The engine request for a code — the same arithmetic and limits as a founder discount (§4.3). */
export function promoDiscountRequest(code: PromoCode): DiscountRequest {
  const reason = `promo code ${code.code}`;
  return code.method === 'fixed'
    ? { source: 'code', method: 'fixed', amountCents: code.value, reason }
    : { source: 'code', method: 'percentage', basisPoints: code.value, reason };
}

export const PROMO_PAID_STATUSES = [
  'paid', 'confirmed', 'in_progress', 'completed', 'refunded', 'no_show',
] as const satisfies readonly BookingStatus[];
export const PROMO_HELD_STATUSES = ['draft', 'payment_pending', 'awaiting_details'] as const satisfies readonly BookingStatus[];

export type PromoUseState = 'paid' | 'held' | 'released';

/**
 * §5.1 — whether a booking carrying a code uses it. The Postgres count in postgresBookingRepo.ts
 * is the SQL twin of this function; bookingPromo.test.ts holds both to the same cases.
 */
export function promoUseState(
  b: { status: BookingStatus; promoHoldUntil: Date | null; hasSucceededPayment: boolean },
  now: Date,
): PromoUseState {
  if (b.hasSucceededPayment || (PROMO_PAID_STATUSES as readonly string[]).includes(b.status)) return 'paid';
  if (
    (PROMO_HELD_STATUSES as readonly string[]).includes(b.status) &&
    b.promoHoldUntil !== null &&
    b.promoHoldUntil.getTime() > now.getTime()
  ) {
    return 'held';
  }
  return 'released';
}

const isoDate = z.string().datetime({ offset: true }).transform((s) => new Date(s));

/** POST /admin/promo-codes (§6.5). */
export const CreatePromoCodeSchema = z
  .object({
    code: z.string().transform((s, ctx) => {
      const normalized = normalizePromoCode(s);
      if (!normalized) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'code must be 3-32 characters of A-Z, 0-9 and -' });
        return z.NEVER;
      }
      return normalized;
    }),
    method: z.enum(['fixed', 'percentage']),
    value: z.number().int(),
    startsAt: isoDate.optional(),
    expiresAt: isoDate,
    maxUses: z.number().int().min(1),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.method === 'percentage' && (v.value < 100 || v.value > 3000)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'a percentage must be 100-3000 basis points (1%-30%)' });
    }
    if (v.method === 'fixed' && v.value <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'a fixed amount must be more than 0 cents' });
    }
    if (v.startsAt && v.startsAt.getTime() >= v.expiresAt.getTime()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expiresAt'], message: 'expiry must be after the start' });
    }
  });

/** PATCH /admin/promo-codes/:id — only these three may change (§4.1). */
export const PatchPromoCodeSchema = z
  .object({
    expiresAt: isoDate.optional(),
    maxUses: z.number().int().min(1).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to change' });
