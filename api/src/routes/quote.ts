import { Hono } from 'hono';
import { z } from 'zod';
import { quote } from '../quote/engine';
import type { QuoteRequest } from '../quote/types';

const ExtraCode = z.enum(['sightseeing', 'safari-wait', 'luggage', 'front', 'flex', 'waiting']);
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
    vehicle: z.enum(['car', 'van']), pax: z.number().int().min(1), bags: z.number().int().min(0),
    legs: z.array(z.object({ from: z.string().min(1), to: z.string().min(1), distanceKm: z.number().min(0) })).min(1),
    extras: z.array(ExtraCode).optional(),
  }),
  z.object({
    product: z.literal('chauffeur'),
    vehicle: z.enum(['car', 'van']), firstDate: z.string().min(1), lastDate: z.string().min(1),
    travelDays: z.array(z.object({ date: z.string().min(1), from: z.string().min(1), to: z.string().min(1), distanceKm: z.number().min(0) })).min(1),
    extras: z.array(ExtraCode).optional(),
  }),
]);

export function quoteRoutes(deps: { internalKey?: string } = {}) {
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
  return r;
}
