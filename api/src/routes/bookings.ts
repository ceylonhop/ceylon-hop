import { Hono } from 'hono';
import { SingleTransferInput } from '../domain/singleTransfer';
import { quoteSingleTransfer } from '../services/pricing';
import type { BookingRepo } from '../db/bookingRepo';

export function bookingRoutes(repo: BookingRepo) {
  const r = new Hono();

  // 1.4 — create a single-transfer draft. Idempotent on the Idempotency-Key header:
  // a retry with the same key returns the existing booking (200), never a duplicate.
  r.post('/single', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = SingleTransferInput.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }

    const key = c.req.header('Idempotency-Key');
    if (key) {
      const existing = await repo.findByIdempotencyKey(key);
      if (existing) return c.json(existing, 200);
    }

    const { currency, total } = quoteSingleTransfer(parsed.data);
    const booking = await repo.create(
      { input: parsed.data, total, currency },
      { idempotencyKey: key },
    );
    return c.json(booking, 201);
  });

  // 1.5 — read a booking back.
  r.get('/:id', async (c) => {
    const booking = await repo.get(c.req.param('id'));
    if (!booking) return c.json({ error: 'not_found' }, 404);
    return c.json(booking, 200);
  });

  return r;
}
