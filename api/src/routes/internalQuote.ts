import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';
import { quote } from '../quote/engine';
import { quoteBreakdown } from '../quote/breakdown';
import { RATE_CARD } from '../quote/rateCard';
import type { QuoteRequest, QuoteResult } from '../quote/types';
import type { ExtraCode, Vehicle } from '../quote/rateCard';
import type { MapsAdapter } from '../adapters/maps';
import { QUOTE_STATUSES, type QuoteStatus } from '../db/quoteRepo';
import type { QuoteRepo } from '../db/quoteRepo';
import { verifySession } from '../lib/opsAuth';

// Same session cookie as /admin/ops (ops.ts) — one login covers both surfaces.
const COOKIE = 'ch_ops';

// Design leg categories. `drives` = the vehicle moves that day (km-priced); stay_day is idle.
const CATEGORIES: Record<string, { drives: boolean }> = {
  transfer: { drives: true },
  airport: { drives: true },
  train_support: { drives: true },
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
  category: z.enum(['transfer', 'airport', 'train_support', 'stay_day']).optional(),
  // The tool sends date:'' for undated legs — treat empty as absent, not invalid.
  date: z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(ISO_DATE, 'date must be YYYY-MM-DD').optional()),
  from: z.string(),
  to: z.string(),
  distanceKm: z.number().min(0).optional(),
  addSightseeingFee: z.boolean().optional(),
  addWaitingFee: z.boolean().optional(),
  addSafariWait: z.boolean().optional(),
});
const ToolRequestSchema = z.object({
  name: z.string().optional(),
  contact: z.string().optional(),
  notes: z.string().optional(),
  // Explicit service chooser (reflow). When present it overrides leg-derived product;
  // when absent, toEngineRequest keeps the derive-from-legs back-compat fallback.
  service: z.enum(['private', 'chauffeur']).optional(),
  vehicle: z.enum(['car', 'van_6', 'van_9', 'van_14', 'custom']),
  passengerCount: z.number().int().min(1),
  luggageCount: z.number().int().min(0),
  legs: z.array(ToolLegSchema).min(1),
  // GL-1d: van14/custom are custom-priced per quote — the operator's per-km rate in cents.
  // Bounded to catch fat-finger dollars-vs-cents mistakes ($1000/km ceiling).
  customRatePerKmCents: z.number().int().min(1).max(100_000).optional(),
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
  serviceOverride?: 'private' | 'chauffeur',
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
    const req = toEngineRequest(body, serviceOverride);
    return { req, result: quote(req) };
  } catch (e) {
    if (e instanceof PriceError) throw e;
    throw new PriceError(e instanceof Error ? e.message : 'could not price this trip', 422);
  }
}

// Resolve a driving leg's km via the maps adapter (a single from→to lookup).
// Unresolvable → 400 naming the failing leg.
async function resolveLegKm(l: ToolLeg, maps: MapsAdapter): Promise<number> {
  const d = await maps.distance(l.from, l.to);
  if (!d) {
    throw new PriceError(`couldn't find the distance for ${l.from || '?'} → ${l.to || '?'} — enter the km manually`, 400);
  }
  return Math.round(d.km);
}

const fxRate = RATE_CARD.fxUsdToLkr;
const toLkr = (cents: number): number => Math.round((cents * fxRate) / 100);
const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
const lkr = (cents: number): string => `LKR ${toLkr(cents).toLocaleString('en-US')}`;

function drives(l: ToolLeg): boolean {
  return CATEGORIES[l.category || 'transfer']?.drives ?? true;
}
function isChauffeur(legs: ToolLeg[]): boolean {
  return legs.some((l) => (l.category || 'transfer') === 'stay_day');
}
function collectExtras(legs: ToolLeg[]): ExtraCode[] {
  const out: ExtraCode[] = [];
  for (const l of legs) {
    if (l.addSightseeingFee) out.push('sightseeing');
    if (l.addWaitingFee) out.push('waiting');
    if (l.addSafariWait) out.push('safari-wait');
  }
  return out;
}

// Map the tool's typed itinerary to the engine's QuoteRequest. Driving legs price/travel;
// stay days become idle days for a chauffeur trip (the engine derives idle days from the date span).
// `serviceOverride` forces the product (used by /estimate to price both services); when omitted,
// an explicit body.service wins, else we fall back to deriving from legs (back-compat).
function toEngineRequest(req: ToolRequest, serviceOverride?: 'private' | 'chauffeur'): QuoteRequest {
  const vehicle = VEHICLE_MAP[req.vehicle];
  if (!vehicle) throw new PriceError(`no rate is set for "${req.vehicle}" yet — pick Car or Van 6, or add its rate`, 400);
  // GL-1d: a custom rate only makes sense on the custom-priced tiers — friendly 400 here;
  // the engine's CUSTOM_RATE_ONLY_FOR_CUSTOM_TIERS check remains the backstop.
  if (req.customRatePerKmCents != null && vehicle !== 'van14' && vehicle !== 'custom') {
    throw new PriceError('a custom $/km rate only applies to Van 14 or Custom vehicles', 400);
  }
  const customPerKmCents = req.customRatePerKmCents;
  const extras = collectExtras(req.legs);
  const driving = req.legs.filter(drives);
  const service = serviceOverride ?? req.service;
  const chauffeur = service ? service === 'chauffeur' : isChauffeur(req.legs);
  if (chauffeur) {
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
      extras, customPerKmCents,
    };
  }
  return {
    product: 'private', vehicle, pax: req.passengerCount, bags: req.luggageCount,
    legs: driving.map((l) => ({ from: l.from, to: l.to, distanceKm: Number(l.distanceKm) })), extras, customPerKmCents,
  };
}

function money(cents: number) {
  return { cents, usd: usd(cents), lkr: lkr(cents), lkrAmount: toLkr(cents) };
}

// Compact per-service summary for the chooser (NOT the full breakdown).
type ServiceSummary = { total: ReturnType<typeof money>; deposit: ReturnType<typeof money>; amountDueNow: ReturnType<typeof money> };
function summary(result: QuoteResult): ServiceSummary {
  return { total: money(result.totalCents), deposit: money(result.depositCents), amountDueNow: money(result.amountDueNowCents) };
}

function shape(result: QuoteResult) {
  return {
    product: result.product,
    total: money(result.totalCents),
    deposit: money(result.depositCents),
    amountDueNow: money(result.amountDueNowCents),
    margin: result.marginEstimateCents == null ? null : money(result.marginEstimateCents),
    warnings: result.warnings,
    // meta passes through so the client can zip travel-leg items (meta.billableKm) with the itinerary.
    lineItems: result.lineItems.map((li) => ({ label: li.label, amountCents: li.amountCents, usd: usd(li.amountCents), lkr: lkr(li.amountCents), meta: li.meta })),
  };
}

// Place suggestions via the maps adapter (Google/offline fallback now lives in the adapter).
async function suggestPlaces(q: string, maps: MapsAdapter): Promise<string[]> {
  const query = (q || '').trim();
  if (query.length < 2) return [];
  return maps.places(query);
}

export function internalQuoteRoutes(deps: {
  maps: MapsAdapter;
  quotes: QuoteRepo;
  adminKey?: string;
  allowNoKey?: boolean;
  sessionSecret?: string;
  allowedOrigins?: string[];
}) {
  const r = new Hono();

  // Ops⇄quote merge T2: the standalone quote shell is retired — the tool lives inside /ops
  // now. Kept as a redirect (not a 404) so old bookmarks/muscle memory land on the new home.
  // Registered above the guard: a bare browser navigation carries no auth, and the redirect
  // itself exposes nothing — /ops runs its own login.
  r.get('/', (c) => c.redirect('/ops', 302));

  // Ops⇄quote merge T2: CSRF on state-changing routes. The founder's ch_ops cookie is ambient
  // browser state, so a cross-site page could otherwise fire authenticated mutations. Check
  // Sec-Fetch-Site first (modern browsers always send it); fall back to the Origin allow-list
  // (older browsers send Origin on POST/PATCH). Both absent = a non-browser caller (curl,
  // scripts) — let it through; the auth guard below still applies. GET reads are exempt:
  // they carry no writes, and /places autocomplete must stay fast.
  const csrf: MiddlewareHandler = async (c, next) => {
    const site = c.req.header('sec-fetch-site');
    if (site) {
      // Sec-Fetch-Site is a browser-set forbidden header a page cannot spoof. When present it
      // is authoritative: same-origin/none pass regardless of Origin (so a same-origin /ops
      // POST works even if its exact host isn't in ALLOWED_ORIGINS); anything cross-site is CSRF.
      if (site !== 'same-origin' && site !== 'none') return c.json({ error: 'bad_origin' }, 403);
      return next();
    }
    // No Sec-Fetch-Site (older browser or non-browser): fall back to the Origin allow-list.
    const origin = c.req.header('origin');
    if (origin && !(deps.allowedOrigins ?? []).includes(origin)) return c.json({ error: 'bad_origin' }, 403);
    return next();
  };

  // GL-1c + ops⇄quote merge T1: fail CLOSED. The tool stores customer PII and exposes
  // cost/margin, so a data route unlocks only for (a) the legacy x-admin-key, (b) a valid
  // FOUNDER ops-session cookie (same ch_ops login as /admin/ops), or (c) the explicit
  // dev-only keyless bypass (allowNoKey — app.ts passes NODE_ENV !== 'production').
  // A support session is never enough — margin/PII stay founder-only (403, even in dev).
  // A misconfigured production deploy must lock, not expose — see the go-live checklist.
  r.use('*', async (c, next) => {
    const key = c.req.header('x-admin-key');
    if (deps.adminKey && key && key === deps.adminKey) return next(); // legacy admin key → founder
    const role = verifySession(getCookie(c, COOKIE), deps.sessionSecret ?? '');
    if (role === 'founder') return next(); // founder ops session
    if (role === 'support') return c.json({ error: 'forbidden' }, 403); // support: never quote data
    if (!deps.adminKey && deps.allowNoKey) return next(); // dev-only keyless bypass
    return c.json({ error: 'unauthorized' }, 401);
  });

  // Autocomplete (delegated to the maps adapter; Google key/timeout live there now).
  r.get('/places', async (c) => c.json({ places: await suggestPlaces(c.req.query('q') || '', deps.maps) }));

  // Distance + duration between two places (Google Distance Matrix in prod, haversine in dev).
  r.post('/distance', csrf, async (c) => {
    const b = (await c.req.json().catch(() => null)) as { from?: string; to?: string } | null;
    if (!b?.from || !b?.to) return c.json({ error: 'need from + to' }, 400);
    const d = await deps.maps.distance(b.from, b.to);
    return d ? c.json(d) : c.json({ error: 'unknown route' }, 404);
  });

  r.post('/estimate', csrf, async (c) => {
    const raw = await c.req.json().catch(() => null);
    try {
      const body = parseToolRequest(raw);
      // Price the SELECTED service (explicit body.service, else derived) for the detailed response.
      const { req, result } = await resolveAndPrice(body, deps.maps);
      const selected: 'private' | 'chauffeur' = req.product === 'chauffeur' ? 'chauffeur' : 'private';

      // Reflow: `services` chooser replaces the old car/van comparison. Two pricing passes max —
      // reuse the selected result for its side; price only the OTHER service additionally.
      const services: {
        pointToPoint: ServiceSummary | { error: string };
        chauffeur: ServiceSummary | { error: string };
      } = { pointToPoint: { error: 'n/a' }, chauffeur: { error: 'n/a' } };

      // Point-to-point is always priceable (extras included, dates ignored).
      services.pointToPoint = selected === 'private'
        ? summary(result)
        : summary((await resolveAndPrice(body, deps.maps, 'private')).result);

      // Chauffeur is only offered when every driving+stay leg has a date AND the trip spans >1 date.
      const chauffeurLegs = body.legs.filter((l) => drives(l) || (l.category || 'transfer') === 'stay_day');
      const distinctDates = new Set(chauffeurLegs.map((l) => l.date).filter(Boolean));
      if (chauffeurLegs.some((l) => !l.date)) {
        services.chauffeur = { error: 'add a date to every leg' };
      } else if (distinctDates.size <= 1) {
        services.chauffeur = { error: 'single-day — point-to-point only' };
      } else {
        services.chauffeur = selected === 'chauffeur'
          ? summary(result)
          : summary((await resolveAndPrice(body, deps.maps, 'chauffeur')).result);
      }

      return c.json({
        ...shape(result),
        fxUsdToLkr: fxRate,
        breakdown: quoteBreakdown(req),
        services,
      });
    } catch (e) {
      if (e instanceof PriceError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  });

  // Persist the currently-priced quote. Re-prices server-side — never trusts a client total.
  r.post('/save', csrf, async (c) => {
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
        // V19: persist the reopenable tool payload alongside the engine request.
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
  r.patch('/:id', csrf, async (c) => {
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
