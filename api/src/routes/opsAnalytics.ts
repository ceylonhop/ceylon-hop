import { Hono } from 'hono';
import { z } from 'zod';
import type { QuoteRepo, AnalyticsChannel } from '../db/quoteRepo';
import { opsIdentity, requireCap, type OpsAuthConfig } from '../lib/opsMiddleware';
import { computeFunnel, type AnalyticsRange } from '../services/analytics/funnel';
import { computeDemand } from '../services/analytics/demand';

// Founder analytics (spec 2026-07-23). Read-only aggregates over the quotes table, gated on
// analytics:view (founder-only). Perf contract: the repo fetches are BOUNDED by the requested
// window (plus the small live set for funnel snapshots) with hard row caps — a capped response
// says so via `truncated: true`, which the UI must surface, never silently under-count.

export interface OpsAnalyticsDeps {
  quotes: QuoteRepo;
  auth: OpsAuthConfig;
}

const FUNNEL_LIMIT = 10_000; // scalars only — ~1MB worst case
const DEMAND_LIMIT = 5_000;  // carries request_json, so the cap is tighter
const DEFAULT_RANGE_DAYS = 28;
const DAY_MS = 24 * 3600 * 1000;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const QuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  bucket: z.enum(['day', 'week']).default('day'),
  channel: z.enum(['ops', 'web', 'all']).default('ops'),
});

// A YYYY-MM-DD from the founder means that Colombo-local calendar day: `from` starts at its
// Colombo midnight (UTC−5:30 shift), `to` ends just before the next one.
const COLOMBO_OFFSET_MS = 5.5 * 3600 * 1000;
const dayStart = (d: string) => new Date(Date.parse(`${d}T00:00:00.000Z`) - COLOMBO_OFFSET_MS);
const dayEnd = (d: string) => new Date(dayStart(d).getTime() + DAY_MS - 1);

function parseRange(q: z.infer<typeof QuerySchema>, now: Date): AnalyticsRange | null {
  const to = q.to ? dayEnd(q.to) : now;
  const from = q.from ? dayStart(q.from) : new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);
  if (from.getTime() > to.getTime()) return null;
  return { from, to, bucket: q.bucket, now };
}

export function opsAnalyticsRoutes(deps: OpsAnalyticsDeps) {
  const r = new Hono();
  r.use('*', opsIdentity(deps.auth));
  r.use('*', requireCap('analytics:view'));

  r.get('/funnel', async (c) => {
    const parsed = QuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'bad query' }, 400);
    const range = parseRange(parsed.data, new Date());
    if (!range) return c.json({ error: 'from must not be after to' }, 400);
    // Widened once past `from` so the previous-equal-window deltas are computable.
    const since = new Date(range.from.getTime() - (range.to.getTime() - range.from.getTime()));
    const { rows, truncated } = await deps.quotes.listFunnelRows(since, FUNNEL_LIMIT, parsed.data.channel as AnalyticsChannel);
    return c.json({ ...computeFunnel(rows, range), truncated });
  });

  r.get('/demand', async (c) => {
    const parsed = QuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'bad query' }, 400);
    const range = parseRange(parsed.data, new Date());
    if (!range) return c.json({ error: 'from must not be after to' }, 400);
    const { rows, truncated } = await deps.quotes.listDemandRows(range.from, range.to, DEMAND_LIMIT, parsed.data.channel as AnalyticsChannel);
    return c.json({ ...computeDemand(rows, range), truncated });
  });

  return r;
}
