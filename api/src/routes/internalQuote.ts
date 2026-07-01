import { Hono } from 'hono';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { quote } from '../quote/engine';
import { quoteBreakdown } from '../quote/breakdown';
import { RATE_CARD } from '../quote/rateCard';
import { selectVehicle, vehicleRank } from '../quote/vehicle';
import type { QuoteRequest, QuoteResult } from '../quote/types';
import type { ExtraCode, Vehicle } from '../quote/rateCard';
import type { MapsAdapter } from '../adapters/maps';
import { QUOTE_STATUSES, type QuoteStatus } from '../db/quoteRepo';
import type { QuoteRepo } from '../db/quoteRepo';

// The single-page tool UI (served same-origin so it can call /admin/quote/estimate without CORS).
// Read per-request so edits hot-reload in dev without a server restart (success path only —
// a missing/unreadable file must not 500 every load with zero diagnostics). On a failed read we
// fall back to the last-good copy cached from a prior successful read; if we've never had a
// good read yet, `toolHtml()` returns null and the route serves a minimal unavailable body.
let cachedHtml: string | null = null;
const toolHtml = (): string | null => {
  try {
    const html = readFileSync(fileURLToPath(new URL('./quote-tool.html', import.meta.url)), 'utf8');
    cachedHtml = html;
    return html;
  } catch (e) {
    console.error('toolHtml: failed to read quote-tool.html', e);
    if (cachedHtml) return cachedHtml;
    return null;
  }
};

// Design leg categories. `drives` = the vehicle moves that day (km-priced); stay_day is idle.
const CATEGORIES: Record<string, { drives: boolean }> = {
  transfer: { drives: true },
  airport: { drives: true },
  train_support: { drives: true },
  sightseeing: { drives: true },
  safari_wait: { drives: true },
  stay_day: { drives: false },
};

// Tool vehicle tiers → engine vehicle class. All tiers now have rates.
const VEHICLE_MAP: Record<string, Vehicle | null> = {
  car: 'car', van_6: 'van', van_9: 'van9', van_14: 'van14', custom: 'custom',
};

// Zod schema for the tool's request payload (V18). Parsed at the route boundary so
// malformed payloads fail fast with a human-readable 400 rather than crashing the pricer.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ToolLegSchema = z.object({
  category: z.enum(['transfer', 'airport', 'train_support', 'sightseeing', 'safari_wait', 'stay_day']).optional(),
  date: z.string().regex(ISO_DATE, 'date must be YYYY-MM-DD').optional(),
  from: z.string(),
  to: z.string(),
  distanceKm: z.number().min(0).optional(),
  stopovers: z.array(z.string()).optional(),
  addSightseeingFee: z.boolean().optional(),
  addWaitingFee: z.boolean().optional(),
  hasDriver: z.boolean().optional(),
  hasCarStay: z.boolean().optional(),
});
const ToolRequestSchema = z.object({
  name: z.string().optional(),
  contact: z.string().optional(),
  notes: z.string().optional(),
  vehicle: z.enum(['car', 'van_6', 'van_9', 'van_14', 'custom']),
  passengerCount: z.number().int().min(1),
  luggageCount: z.number().int().min(0),
  legs: z.array(ToolLegSchema).min(1),
});
type ToolLeg = z.infer<typeof ToolLegSchema>;
type ToolRequest = z.infer<typeof ToolRequestSchema>;

// Thrown by resolveAndPrice so the route can map it to the right HTTP status.
class PriceError extends Error {
  constructor(message: string, readonly status: 400 | 422) {
    super(message);
  }
}

// Zod-validate a raw request body; PriceError 400 with the first human-readable issue on failure.
function parseToolRequest(raw: unknown): ToolRequest {
  const parsed = ToolRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new PriceError(first?.message || 'invalid request', 400);
  }
  return parsed.data;
}

// Shared by /estimate and /save: validate legs, auto-resolve missing distances via the
// maps adapter, then price with the engine. Mutates each driving leg's distanceKm in place.
async function resolveAndPrice(
  body: ToolRequest,
  maps: MapsAdapter,
): Promise<{ req: QuoteRequest; result: QuoteResult }> {
  const driving = body.legs.filter(drives);
  if (driving.length === 0) {
    throw new PriceError('add at least one travel leg (a stay day alone has no transfer)', 400);
  }
  for (const l of driving) {
    if (!l.distanceKm || Number(l.distanceKm) <= 0) {
      l.distanceKm = await resolveLegKm(l, maps);
    }
  }
  try {
    const req = toEngineRequest(body);
    return { req, result: quote(req) };
  } catch (e) {
    if (e instanceof PriceError) throw e;
    throw new PriceError(e instanceof Error ? e.message : 'could not price this trip', 422);
  }
}

// Resolve a driving leg's km via the maps adapter. With stopovers, resolve the CHAINED route
// [from, s1], [s1, s2] … [sn, to] and sum the km (S1); otherwise a single from→to lookup.
// Any unresolvable segment → 400 naming the failing segment.
async function resolveLegKm(l: ToolLeg, maps: MapsAdapter): Promise<number> {
  const stops = (l.stopovers ?? []).filter((s) => s.trim().length > 0);
  const points = stops.length > 0 ? [l.from, ...stops, l.to] : [l.from, l.to];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i];
    const to = points[i + 1];
    const d = await maps.distance(from, to);
    if (!d) {
      throw new PriceError(`couldn't find the distance for ${from || '?'} → ${to || '?'} — enter the km manually`, 400);
    }
    total += d.km;
  }
  return Math.round(total);
}

const fxRate = RATE_CARD.fxUsdToLkr;
const toLkr = (cents: number): number => Math.round((cents * fxRate) / 100);
const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
const lkr = (cents: number): string => `LKR ${toLkr(cents).toLocaleString('en-US')}`;

function drives(l: ToolLeg): boolean {
  return CATEGORIES[l.category || 'transfer']?.drives ?? true;
}
function isChauffeur(legs: ToolLeg[]): boolean {
  return legs.some((l) => (l.category || 'transfer') === 'stay_day' || l.hasDriver || l.hasCarStay);
}
function collectExtras(legs: ToolLeg[]): ExtraCode[] {
  const out: ExtraCode[] = [];
  for (const l of legs) {
    if (l.addSightseeingFee) out.push('sightseeing');
    if (l.addWaitingFee) out.push('waiting');
    if ((l.category || 'transfer') === 'safari_wait') out.push('safari-wait');
  }
  return out;
}

// Map the tool's typed itinerary to the engine's QuoteRequest. Driving legs price/travel;
// stay days become idle days for a chauffeur trip (the engine derives idle days from the date span).
function toEngineRequest(req: ToolRequest): QuoteRequest {
  const vehicle = VEHICLE_MAP[req.vehicle];
  if (!vehicle) throw new PriceError(`no rate is set for "${req.vehicle}" yet — pick Car or Van 6, or add its rate`, 400);
  const extras = collectExtras(req.legs);
  const driving = req.legs.filter(drives);
  if (isChauffeur(req.legs)) {
    // Every leg (driving AND stay) must carry a date, else an undated leg gets pinned to day 0 —
    // silently dropping a day rate + idle km (the confirmed underquote). No fallback.
    if (req.legs.some((l) => !l.date)) {
      throw new PriceError('chauffeur trips need a date on every leg (including stay days)', 400);
    }
    const dated = req.legs.map((l) => l.date as string);
    const sorted = [...dated].sort();
    return {
      product: 'chauffeur', vehicle, firstDate: sorted[0], lastDate: sorted[sorted.length - 1],
      travelDays: driving.map((l) => ({ date: l.date as string, from: l.from, to: l.to, distanceKm: Number(l.distanceKm) })),
      extras,
    };
  }
  return {
    product: 'private', vehicle, pax: req.passengerCount, bags: req.luggageCount,
    legs: driving.map((l) => ({ from: l.from, to: l.to, distanceKm: Number(l.distanceKm) })), extras,
  };
}

function money(cents: number) {
  return { cents, usd: usd(cents), lkr: lkr(cents), lkrAmount: toLkr(cents) };
}

function shape(result: QuoteResult) {
  return {
    product: result.product,
    total: money(result.totalCents),
    deposit: money(result.depositCents),
    amountDueNow: money(result.amountDueNowCents),
    margin: result.marginEstimateCents == null ? null : money(result.marginEstimateCents),
    warnings: result.warnings,
    lineItems: result.lineItems.map((li) => ({ label: li.label, amountCents: li.amountCents, usd: usd(li.amountCents), lkr: lkr(li.amountCents) })),
  };
}

// Place suggestions via the maps adapter (Google/offline fallback now lives in the adapter).
async function suggestPlaces(q: string, maps: MapsAdapter): Promise<string[]> {
  const query = (q || '').trim();
  if (query.length < 2) return [];
  return maps.places(query);
}

export function internalQuoteRoutes(deps: { maps: MapsAdapter; quotes: QuoteRepo; adminKey?: string }) {
  const r = new Hono();

  // Open shell (a browser navigation can't send a header). The JS attaches the key to
  // its fetches; the guard below protects every data/XHR route.
  r.get('/', (c) => {
    const html = toolHtml();
    if (html == null) {
      console.error('GET /admin/quote: no cached quote-tool.html available — serving fallback');
      return c.html('<h1>quote tool unavailable</h1>', 500);
    }
    return c.html(html);
  });

  // Enforce the admin key ONLY when one is configured, so dev/preview (no key) still works.
  // Prod MUST set ADMIN_API_KEY — see the go-live checklist.
  r.use('*', async (c, next) => {
    if (deps.adminKey && c.req.header('x-admin-key') !== deps.adminKey) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    return next();
  });

  // Autocomplete (delegated to the maps adapter; Google key/timeout live there now).
  r.get('/places', async (c) => c.json({ places: await suggestPlaces(c.req.query('q') || '', deps.maps) }));

  // Distance + duration between two places (Google Distance Matrix in prod, haversine in dev).
  r.post('/distance', async (c) => {
    const b = (await c.req.json().catch(() => null)) as { from?: string; to?: string } | null;
    if (!b?.from || !b?.to) return c.json({ error: 'need from + to' }, 400);
    const d = await deps.maps.distance(b.from, b.to);
    return d ? c.json(d) : c.json({ error: 'unknown route' }, 404);
  });

  r.post('/estimate', async (c) => {
    const raw = await c.req.json().catch(() => null);
    try {
      const body = parseToolRequest(raw);
      const { req, result } = await resolveAndPrice(body, deps.maps);
      // V4: an honest car-vs-van comparison. For private trips, a tier smaller than the party
      // requires is flagged as too small rather than silently upgraded by the engine (which
      // would print a van9 price under a "Car" label). Chauffeur has no pax → keep both feasible.
      const required = req.product === 'private' ? selectVehicle(req.pax, req.bags) : null;
      const comparison: Record<string, (ReturnType<typeof shape> & { vehicle: string }) | { error: string }> = {};
      for (const v of ['car', 'van'] as Vehicle[]) {
        if (required && required !== 'too_big' && vehicleRank(v) < vehicleRank(required)) {
          comparison[v] = { error: 'too small for this party' };
          continue;
        }
        try {
          comparison[v] = { ...shape(quote({ ...req, vehicle: v } as QuoteRequest)), vehicle: v };
        } catch (e) {
          comparison[v] = { error: e instanceof Error ? e.message : 'n/a' };
        }
      }
      return c.json({
        ...shape(result),
        fxUsdToLkr: fxRate,
        breakdown: quoteBreakdown(req),
        comparison,
      });
    } catch (e) {
      if (e instanceof PriceError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  });

  // Persist the currently-priced quote. Re-prices server-side — never trusts a client total.
  r.post('/save', async (c) => {
    const raw = await c.req.json().catch(() => null);
    try {
      const body = parseToolRequest(raw);
      const { req, result } = await resolveAndPrice(body, deps.maps);
      const saved = await deps.quotes.save({
        product: req.product,
        vehicle: 'vehicle' in req ? req.vehicle : null,
        customerName: body.name ?? null,
        customerContact: body.contact ?? null,
        totalCents: result.totalCents,
        currency: RATE_CARD.currency,
        rateCardVersion: RATE_CARD.version,
        marginCents: result.marginEstimateCents ?? null,
        // V19: persist the reopenable tool payload (with stopovers) alongside the engine request.
        // GET /:id returns request.tool for the UI to reopen the draft.
        request: { tool: body, engine: req },
        result,
        notes: body.notes ?? null,
      });
      return c.json({ id: saved.id, reference: saved.reference, status: saved.status }, 201);
    } catch (e) {
      if (e instanceof PriceError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  });

  // Read-only view of the locked rate card for the tool's Settings card.
  // MUST be registered before /:id so that /rate-card doesn't match the param route.
  r.get('/rate-card', (c) =>
    c.json({
      version: RATE_CARD.version,
      perKmCents: RATE_CARD.perKmCents,
      floorCents: RATE_CARD.floorCents,
      chauffeurDayRateCents: RATE_CARD.chauffeur.dayRateCents,
      bufferPct: RATE_CARD.bufferPct,
      depositPct: RATE_CARD.deposit.pct,
      extras: RATE_CARD.extras,
      fxUsdToLkr: RATE_CARD.fxUsdToLkr,
      vehicle: RATE_CARD.vehicle, // V12: per-tier maxPax/maxBags caps for client-side vehicle labelling
    }),
  );

  // List quotes (newest first), optionally filtered by status/product/from/to.
  // MUST be registered before /:id so that /list doesn't match the param route.
  r.get('/list', async (c) => {
    const status = c.req.query('status') as QuoteStatus | undefined;
    if (status && !QUOTE_STATUSES.includes(status)) return c.json({ error: 'bad_status' }, 400);
    const quotesList = await deps.quotes.list({
      status,
      product: c.req.query('product') || undefined,
      from: c.req.query('from') || undefined,
      to: c.req.query('to') || undefined,
    });
    return c.json({ quotes: quotesList });
  });

  // Full quote (incl. request/result JSON) for re-opening in the tool.
  r.get('/:id', async (c) => {
    const q = await deps.quotes.get(c.req.param('id'));
    return q ? c.json(q) : c.json({ error: 'not_found' }, 404);
  });

  // Update a quote's status, lostReason, or notes. Stamps sentAt/decidedAt via the repo.
  r.patch('/:id', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { status?: string; lostReason?: string | null; notes?: string | null } | null;
    if (!body) return c.json({ error: 'bad_request' }, 400);
    if (body.status && !QUOTE_STATUSES.includes(body.status as QuoteStatus)) return c.json({ error: 'bad_status' }, 400);
    const updated = await deps.quotes.patch(c.req.param('id'), {
      status: body.status as QuoteStatus | undefined,
      lostReason: body.lostReason,
      notes: body.notes,
    });
    return updated ? c.json(updated) : c.json({ error: 'not_found' }, 404);
  });

  return r;
}
