// Promo code domain rules (spec docs/superpowers/specs/2026-09-14-promo-codes-design.md §4–§5).
import { describe, it, expect } from 'vitest';
import {
  normalizePromoCode,
  promoCodeAvailability,
  promoDiscountRequest,
  promoUseState,
  CreatePromoCodeSchema,
  PatchPromoCodeSchema,
  PROMO_HOLD_MS,
  type PromoCode,
} from './promoCode';
import { resolveDiscount } from '../quote/discount';

const T0 = new Date(Math.floor(Date.now() / 1000) * 1000);
const at = (ms: number) => new Date(T0.getTime() + ms);
const HOUR = 3_600_000;

function code(over: Partial<PromoCode> = {}): PromoCode {
  return {
    id: '00000000-0000-0000-0000-00000000c0de',
    code: 'SAVE10',
    method: 'percentage',
    value: 1000,
    startsAt: null,
    expiresAt: at(30 * 24 * HOUR),
    maxUses: 5,
    active: true,
    createdBy: 'founder@ceylonhop.com',
    createdAt: T0,
    updatedBy: null,
    updatedAt: null,
    ...over,
  };
}

describe('normalizePromoCode', () => {
  it('trims and upper-cases a well-formed code', () => {
    expect(normalizePromoCode('  save10 ')).toBe('SAVE10');
    expect(normalizePromoCode('new-year-26')).toBe('NEW-YEAR-26');
  });
  it('rejects anything outside 3–32 of A–Z, 0–9, -', () => {
    expect(normalizePromoCode('ab')).toBeNull();
    expect(normalizePromoCode('SAVE 10')).toBeNull();
    expect(normalizePromoCode('A'.repeat(33))).toBeNull();
    expect(normalizePromoCode('SAVE_10')).toBeNull();
    expect(normalizePromoCode(10)).toBeNull();
    expect(normalizePromoCode(undefined)).toBeNull();
  });
});

describe('promoCodeAvailability — start inclusive, expiry exclusive', () => {
  it('works inside the window', () => {
    expect(promoCodeAvailability(code(), T0)).toBeNull();
  });
  it('is not started one ms before the start, and works AT the start', () => {
    const c = code({ startsAt: at(HOUR) });
    expect(promoCodeAvailability(c, at(HOUR - 1))).toBe('promo_code_not_started');
    expect(promoCodeAvailability(c, at(HOUR))).toBeNull();
  });
  it('works one ms before expiry and is expired AT expiry', () => {
    const c = code({ expiresAt: at(HOUR) });
    expect(promoCodeAvailability(c, at(HOUR - 1))).toBeNull();
    expect(promoCodeAvailability(c, at(HOUR))).toBe('promo_code_expired');
  });
  it('reports a switched-off code as invalid, even inside its window', () => {
    expect(promoCodeAvailability(code({ active: false }), T0)).toBe('promo_code_invalid');
  });
});

describe('promoDiscountRequest', () => {
  it('maps a percentage code to basis points and a fixed code to cents, source code', () => {
    expect(promoDiscountRequest(code())).toEqual({
      source: 'code', method: 'percentage', basisPoints: 1000, reason: 'promo code SAVE10',
    });
    expect(promoDiscountRequest(code({ method: 'fixed', value: 800, code: 'TENOFF' }))).toEqual({
      source: 'code', method: 'fixed', amountCents: 800, reason: 'promo code TENOFF',
    });
  });
});

// §4.3 — the owner-approved table, one-leg car, protected minimum $29.00.
describe('the owner-approved worked examples', () => {
  it('$80.00 at 10% → $8.00 off → $72.00', () => {
    const r = resolveDiscount(promoDiscountRequest(code({ value: 1000 })), 8000, 2900);
    expect(r.appliedCents).toBe(800);
    expect(8000 - r.appliedCents).toBe(7200);
  });
  it('$35.00 at 20% → asked $7.00, only $6.00 off → $29.00', () => {
    const r = resolveDiscount(promoDiscountRequest(code({ value: 2000 })), 3500, 2900);
    expect(r.requestedCents).toBe(700);
    expect(r.appliedCents).toBe(600);
    expect(r.capReason).toBe('vehicle_minimum');
  });
  it('$29.00 at 10% → $0.00 off (the code does not apply)', () => {
    const r = resolveDiscount(promoDiscountRequest(code({ value: 1000 })), 2900, 2900);
    expect(r.appliedCents).toBe(0);
  });
});

describe('promoUseState (§5.1)', () => {
  const held = (status: Parameters<typeof promoUseState>[0]['status'], holdMs: number | null, paid = false) =>
    promoUseState({ status, promoHoldUntil: holdMs === null ? null : at(holdMs), hasSucceededPayment: paid }, T0);

  it('counts a booking with a succeeded payment as paid, whatever its status', () => {
    expect(held('cancelled', null, true)).toBe('paid');
    expect(held('payment_pending', -HOUR, true)).toBe('paid');
  });
  it('counts every paid-or-later status as paid', () => {
    for (const s of ['paid', 'confirmed', 'in_progress', 'completed', 'refunded', 'no_show'] as const) {
      expect(held(s, null)).toBe('paid');
    }
  });
  it('holds an unpaid booking only while its hold is in the future', () => {
    expect(held('draft', PROMO_HOLD_MS)).toBe('held');
    expect(held('payment_pending', 1)).toBe('held');
    expect(held('awaiting_details', 1)).toBe('held');
    expect(held('draft', 0)).toBe('released');
    expect(held('draft', -1)).toBe('released');
    expect(held('draft', null)).toBe('released');
  });
  it('releases a booking cancelled before payment', () => {
    expect(held('cancelled', PROMO_HOLD_MS)).toBe('released');
  });
});

describe('CreatePromoCodeSchema', () => {
  const base = { code: 'save10', method: 'percentage', value: 1000, expiresAt: at(HOUR).toISOString(), maxUses: 5 };
  it('normalises the code and parses dates', () => {
    const r = CreatePromoCodeSchema.parse({ ...base, startsAt: T0.toISOString() });
    expect(r.code).toBe('SAVE10');
    expect(r.expiresAt).toBeInstanceOf(Date);
    expect(r.startsAt?.getTime()).toBe(T0.getTime());
  });
  it('accepts exactly 30% and refuses anything above it or below 1%', () => {
    expect(CreatePromoCodeSchema.safeParse({ ...base, value: 3000 }).success).toBe(true);
    expect(CreatePromoCodeSchema.safeParse({ ...base, value: 3001 }).success).toBe(false);
    expect(CreatePromoCodeSchema.safeParse({ ...base, value: 99 }).success).toBe(false);
  });
  it('refuses a zero fixed amount, a bad code, a start not before expiry, and unknown fields', () => {
    expect(CreatePromoCodeSchema.safeParse({ ...base, method: 'fixed', value: 0 }).success).toBe(false);
    expect(CreatePromoCodeSchema.safeParse({ ...base, code: 'no spaces' }).success).toBe(false);
    expect(CreatePromoCodeSchema.safeParse({ ...base, startsAt: at(HOUR).toISOString() }).success).toBe(false);
    expect(CreatePromoCodeSchema.safeParse({ ...base, maxUses: 0 }).success).toBe(false);
    expect(CreatePromoCodeSchema.safeParse({ ...base, active: false }).success).toBe(false);
  });
});

describe('PatchPromoCodeSchema', () => {
  it('allows only expiry, max uses and on/off, and requires at least one', () => {
    expect(PatchPromoCodeSchema.safeParse({ maxUses: 9 }).success).toBe(true);
    expect(PatchPromoCodeSchema.safeParse({ active: false }).success).toBe(true);
    expect(PatchPromoCodeSchema.safeParse({ code: 'OTHER' }).success).toBe(false);
    expect(PatchPromoCodeSchema.safeParse({ value: 500 }).success).toBe(false);
    expect(PatchPromoCodeSchema.safeParse({}).success).toBe(false);
  });
});
