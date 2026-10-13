import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { opsIdentity, requireCap, type OpsAuthConfig } from '../lib/opsMiddleware';
import { ExperienceInputSchema, type Experience } from '../experiences/experience';
import { SlugTakenError, type ExperienceRepo } from '../db/experienceRepo';
import type { ExperienceInterestRepo } from '../db/experienceInterestRepo';

// Ops Experiences page (spec 2026-10-06 D14/D15). Catalogue writes need experiences:manage
// (founder + ops: the price is display-only); moving a lead is booking work, so bookings:operate.
// .partial() wraps each field in ZodOptional, so an omitted field stays undefined and its default
// never fires — a PATCH changes only what it names.
const PatchExperience = ExperienceInputSchema.partial().strict();
const PatchLead = z.object({
  status: z.enum(['new', 'contacted', 'link_sent', 'paid', 'declined']).optional(),
  opsNote: z.string().trim().max(1000).nullable().optional(),
  paymentRef: z.string().trim().min(3).max(100).nullable().optional(),
  amountPaidCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
  amountPaidCurrency: z.enum(['USD', 'LKR']).nullable().optional(),
}).strict();

const isUuid = (s: string) => z.string().uuid().safeParse(s).success;
const serialize = (e: Experience) => ({ ...e, createdAt: e.createdAt.toISOString(), updatedAt: e.updatedAt.toISOString() });

export function opsExperiencesRoutes(deps: {
  experiences: ExperienceRepo;
  interests: ExperienceInterestRepo;
  auth: OpsAuthConfig;
  allowedOrigins?: string[];
}) {
  const r = new Hono();
  // Same CSRF rule as /admin/rates (opsRates.ts): the ch_ops cookie is ambient browser state.
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

  r.get('/', requireCap('experiences:manage'), async (c) => {
    const [list, stats] = await Promise.all([deps.experiences.list(), deps.interests.stats()]);
    return c.json({ experiences: list.map(serialize), stats });
  });

  r.post('/', csrf, requireCap('experiences:manage'), async (c) => {
    const parsed = ExperienceInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400);
    try {
      const e = await deps.experiences.create({ ...parsed.data, createdBy: c.get('identity').email });
      return c.json({ experience: serialize(e) }, 201);
    } catch (err) {
      if (err instanceof SlugTakenError) return c.json({ error: 'slug_taken' }, 409);
      throw err;
    }
  });

  r.patch('/:id', csrf, requireCap('experiences:manage'), async (c) => {
    // A non-uuid id would reach Postgres as a bad cast (500); it is simply not found.
    if (!isUuid(c.req.param('id'))) return c.json({ error: 'not_found' }, 404);
    const parsed = PatchExperience.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400);
    try {
      const e = await deps.experiences.patch(c.req.param('id'), { ...parsed.data, updatedBy: c.get('identity').email });
      return e ? c.json({ experience: serialize(e) }) : c.json({ error: 'not_found' }, 404);
    } catch (err) {
      if (err instanceof SlugTakenError) return c.json({ error: 'slug_taken' }, 409);
      throw err;
    }
  });

  r.get('/leads', requireCap('experiences:manage'), async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 200, 1), 500);
    return c.json({ leads: await deps.interests.listLeads(limit) });
  });

  r.patch('/leads/:id', csrf, requireCap('bookings:operate'), async (c) => {
    if (!isUuid(c.req.param('id'))) return c.json({ error: 'not_found' }, 404);
    const parsed = PatchLead.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400);
    const current = await deps.interests.get(c.req.param('id'));
    if (!current) return c.json({ error: 'not_found' }, 404);
    // A "paid" with no PayHere reference can't be reconciled (spec D5); the DB checks it too.
    const ref = parsed.data.paymentRef !== undefined ? parsed.data.paymentRef : current.paymentRef;
    if ((parsed.data.status ?? current.status) === 'paid' && !ref) return c.json({ error: 'paid_requires_ref' }, 400);
    const row = await deps.interests.patch(current.id, { ...parsed.data, updatedBy: c.get('identity').email });
    return row ? c.json({ lead: row }) : c.json({ error: 'not_found' }, 404);
  });

  return r;
}
