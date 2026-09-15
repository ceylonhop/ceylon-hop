// Founder API for promo codes (spec docs/superpowers/specs/2026-09-14-promo-codes-design.md §6.5).
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { opsIdentity, requireCap, type OpsAuthConfig } from '../lib/opsMiddleware';
import type { BookingRepo } from '../db/bookingRepo';
import { PromoCodeTakenError, type PromoCodeRepo } from '../db/promoCodeRepo';
import {
  CreatePromoCodeSchema,
  PatchPromoCodeSchema,
  promoCodeAvailability,
  type PromoCode,
} from '../domain/promoCode';

const isUuid = (s: string) => z.string().uuid().safeParse(s).success;

function serialize(code: PromoCode) {
  return {
    id: code.id,
    code: code.code,
    method: code.method,
    value: code.value,
    startsAt: code.startsAt ? code.startsAt.toISOString() : null,
    expiresAt: code.expiresAt.toISOString(),
    maxUses: code.maxUses,
    active: code.active,
    createdBy: code.createdBy,
    createdAt: code.createdAt.toISOString(),
    updatedBy: code.updatedBy,
    updatedAt: code.updatedAt ? code.updatedAt.toISOString() : null,
  };
}

export function promoCodeRoutes(deps: {
  promoCodes: PromoCodeRepo;
  bookings: BookingRepo;
  auth: OpsAuthConfig;
  allowedOrigins?: string[];
  /** PROMO_CODES_ENABLED — gates CREATING only; listing and switching codes off always work. */
  enabled: boolean;
  now?: () => Date;
}) {
  const r = new Hono();
  const now = deps.now ?? (() => new Date());

  // Same CSRF rule as /admin/quote (internalQuote.ts): the ch_ops cookie is ambient browser state.
  const csrf: MiddlewareHandler = async (c, next) => {
    const site = c.req.header('sec-fetch-site');
    if (site) {
      if (site !== 'same-origin' && site !== 'none') return c.json({ error: 'bad_origin' }, 403);
      return next();
    }
    const origin = c.req.header('origin');
    if (origin && !(deps.allowedOrigins ?? []).includes(origin)) return c.json({ error: 'bad_origin' }, 403);
    return next();
  };

  r.use('*', opsIdentity(deps.auth));
  r.use('*', requireCap('promo_codes:manage'));

  async function withUsage(code: PromoCode, at: Date) {
    const { paid, held } = await deps.bookings.promoUsage(code.id, at);
    return {
      ...serialize(code),
      uses: { paid, held, remaining: Math.max(0, code.maxUses - paid - held) },
      worksNow: promoCodeAvailability(code, at) === null,
    };
  }

  r.get('/', async (c) => {
    const at = now();
    const codes = await deps.promoCodes.list();
    return c.json({ codes: await Promise.all(codes.map((code) => withUsage(code, at))) });
  });

  r.post('/', csrf, async (c) => {
    if (!deps.enabled) return c.json({ error: 'promo_codes_disabled' }, 403);
    const parsed = CreatePromoCodeSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    const at = now();
    try {
      const created = await deps.promoCodes.create(
        { ...parsed.data, startsAt: parsed.data.startsAt ?? null, createdBy: c.get('identity').email },
        at,
      );
      return c.json(await withUsage(created, at), 201);
    } catch (err) {
      if (err instanceof PromoCodeTakenError) return c.json({ error: 'code_taken' }, 409);
      throw err;
    }
  });

  r.get('/:id', async (c) => {
    const id = c.req.param('id');
    const code = isUuid(id) ? await deps.promoCodes.get(id) : null;
    if (!code) return c.json({ error: 'not_found' }, 404);
    const at = now();
    return c.json({ ...(await withUsage(code, at)), bookings: await deps.bookings.promoBookings(code.id, at) });
  });

  r.patch('/:id', csrf, async (c) => {
    const id = c.req.param('id');
    const existing = isUuid(id) ? await deps.promoCodes.get(id) : null;
    if (!existing) return c.json({ error: 'not_found' }, 404);
    const parsed = PatchPromoCodeSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    if (
      parsed.data.expiresAt &&
      existing.startsAt &&
      existing.startsAt.getTime() >= parsed.data.expiresAt.getTime()
    ) {
      return c.json({ error: 'invalid_request', details: { fieldErrors: { expiresAt: ['expiry must be after the start'] } } }, 400);
    }
    const at = now();
    const updated = await deps.promoCodes.update(id, { ...parsed.data, updatedBy: c.get('identity').email }, at);
    if (!updated) return c.json({ error: 'not_found' }, 404);
    return c.json(await withUsage(updated, at), 200);
  });

  return r;
}
