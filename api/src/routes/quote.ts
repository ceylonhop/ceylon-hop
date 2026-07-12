import { Hono } from 'hono';
import { z } from 'zod';
import { quote } from '../quote/engine';
import type { QuoteRequest } from '../quote/types';
import { EXTRA_CODES, RATE_CARD } from '../quote/rateCard';
import { rateLockUntil } from '../quote/rateLock';
import type { QuoteRepo } from '../db/quoteRepo';

const ExtraCode = z.enum(EXTRA_CODES);
const ENGINE_ERRORS = new Set(['TOO_BIG', 'UNKNOWN_EXTRA', 'NO_LEGS']);

const QuoteSchema = z.discriminatedUnion('product', [
  z.object({
    product: z.literal('shared'),
    legs: z.array(z.object({
      routeId: z.string().min(1), seats: z.number().int().min(1),
      seatPriceCents: z.number().int().min(0), colomboPickup: z.boolean().optional(),
    })).min(1),
  }),
  z.object({
    product: z.literal('private'),
    vehicle: z.enum(['car', 'van', 'van9', 'van14', 'custom']), pax: z.number().int().min(1), bags: z.number().int().min(0),
    legs: z.array(z.object({ from: z.string().min(1), to: z.string().min(1), distanceKm: z.number().min(0) })).min(1),
    extras: z.array(ExtraCode).optional(),
  }),
  z.object({
    product: z.literal('chauffeur'),
    vehicle: z.enum(['car', 'van', 'van9', 'van14', 'custom']), firstDate: z.string().min(1), lastDate: z.string().min(1),
    travelDays: z.array(z.object({ date: z.string().min(1), from: z.string().min(1), to: z.string().min(1), distanceKm: z.number().min(0) })).min(1),
    extras: z.array(ExtraCode).optional(),
  }),
]);

export function quoteRoutes(deps: { internalKey?: string; quotes?: QuoteRepo } = {}) {
  const r = new Hono();
  r.post('/', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = QuoteSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    try {
      const result = quote(parsed.data as QuoteRequest);
      const isInternal = !!deps.internalKey && c.req.header('x-internal-key') === deps.internalKey;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { marginEstimateCents, ...pub } = result;
      return c.json(isInternal ? result : pub, 200);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'BAD_REQUEST';
      return c.json({ error: ENGINE_ERRORS.has(msg) ? msg : 'BAD_REQUEST' }, 422);
    }
  });

  // Rate-lock (spec 2026-07-11 §5): commit a customer-facing quote. Prices the itinerary against
  // the CURRENT card and persists a channel='web' quote carrying that card as a snapshot, held for
  // 7 days. Returns a quote id the customer can book against (POST /bookings/* with quoteId) or
  // return to within the window — the booking then prices with this locked card, so a rate-card
  // change under the hood can't move the price the customer was quoted. Margin is never returned.
  r.post('/lock', async (c) => {
    if (!deps.quotes) return c.json({ error: 'not_available' }, 501);
    const body = await c.req.json().catch(() => null);
    const parsed = QuoteSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    try {
      const req = parsed.data as QuoteRequest;
      const result = quote(req);
      const saved = await deps.quotes.save({
        channel: 'web',
        product: req.product,
        vehicle: 'vehicle' in req ? req.vehicle : null,
        totalCents: result.totalCents,
        currency: RATE_CARD.currency,
        rateCardVersion: RATE_CARD.version,
        marginCents: result.marginEstimateCents ?? null,
        request: { engine: req },
        result,
        rateCardJson: RATE_CARD,
        rateLockedUntil: rateLockUntil(new Date()),
      });
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { marginEstimateCents, ...pub } = result;
      return c.json({ quoteId: saved.id, reference: saved.reference, rateLockedUntil: saved.rateLockedUntil, ...pub }, 201);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'BAD_REQUEST';
      return c.json({ error: ENGINE_ERRORS.has(msg) ? msg : 'BAD_REQUEST' }, 422);
    }
  });
  return r;
}
