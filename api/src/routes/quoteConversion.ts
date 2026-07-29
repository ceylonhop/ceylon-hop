import { Hono } from 'hono';
import { z } from 'zod';
import { CustomerInput } from '../domain/singleTransfer';
import {
  QuoteConversionError,
  type QuoteConversionRepo,
} from '../db/quoteConversionRepo';
import { WebQuoteIntentSchema } from '../quote/webQuoteV2';

const RequestSchema = z
  .object({
    quoteId: z.string().uuid(),
    revision: z.number().int().min(1),
    intent: WebQuoteIntentSchema,
    bookingDetails: z
      .object({
        customer: CustomerInput,
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      })
      .strict(),
  })
  .strict();

export function quoteConversionRoutes(deps: {
  conversions?: QuoteConversionRepo;
  enabled: boolean;
}) {
  const r = new Hono();
  r.post('/from-quote-v2', async (c) => {
    if (!deps.enabled) return c.notFound();
    if (!deps.conversions) return c.json({ error: 'not_available' }, 501);
    const authorization = c.req.header('authorization') ?? '';
    const accessToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!accessToken) return c.json({ error: 'quote_access_denied' }, 403);

    const parsed = RequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    try {
      const outcome = await deps.conversions.convert({ ...parsed.data, accessToken });
      return c.json(outcome.booking, outcome.replay ? 200 : 201);
    } catch (error) {
      if (error instanceof QuoteConversionError) {
        const status = error.code === 'quote_access_denied' ? 403 : 409;
        return c.json({ error: error.code }, status);
      }
      throw error;
    }
  });
  return r;
}
