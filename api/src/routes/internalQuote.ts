import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { quote } from '../quote/engine';
import { quoteBreakdown } from '../quote/breakdown';
import { RATE_CARD } from '../quote/rateCard';
import { rateCardFor } from '../quote/rateLock';
import type { QuoteRequest, QuoteResult } from '../quote/types';
import type { ExtraCode, Vehicle, RateCard } from '../quote/rateCard';
import type { SavedQuote } from '../db/quoteRepo';
import { KNOWN_PLACES, type MapsAdapter } from '../adapters/maps';
import { QUOTE_STATUSES, canTransition, type QuoteStatus, type QuotePatch } from '../db/quoteRepo';
import type { QuoteRepo } from '../db/quoteRepo';
import { can, resolveAssignee } from '../lib/opsAuth';
import { opsIdentity, requireCap, type OpsAuthConfig } from '../lib/opsMiddleware';
import type { EmailAdapter } from '../adapters/email';
import { sendQuoteAssigned } from '../services/opsNotifications';

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
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  // Legacy ops-tool payloads used a single name. Keep accepting it so old clients/tests
  // and saved request.tool snapshots remain reopenable.
  name: z.string().optional(),
  contact: z.string().optional(),
  notes: z.string().optional(),
  // Explicit service chooser (reflow). When present it overrides leg-derived product;
  // when absent, toEngineRequest keeps the derive-from-legs back-compat fallback.
  service: z.enum(['private', 'chauffeur']).optional(),
  // Quote intent (spec 2026-07-17). What the customer ASKED for, vs `service` = what we price.
  // Deliberately NOT defaulted from `service` (I4): a pre-filled value gets accepted unread,
  // which is the exact failure this field exists to prevent. No 'legacy' member — there is no
  // exemption (I7), so a client cannot mint one.
  requestedService: z.enum(['private', 'chauffeur', 'both']).optional(),
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

function customerNameFor(body: ToolRequest): string | null {
  const splitName = [body.firstName, body.lastName]
    .map((s) => (s || '').trim())
    .filter(Boolean)
    .join(' ');
  return splitName || (body.name || '').trim() || null;
}

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
  let chauffeur = service ? service === 'chauffeur' : isChauffeur(req.legs);
  // Chauffeur needs >=2 distinct leg dates. A single-day request is priced as point-to-point,
  // mirroring the ops UI's client-side revert — the backend (canonical price + save recompute)
  // must never charge a chauffeur day rate on a single transfer, whoever calls it.
  if (chauffeur && new Set(req.legs.map((l) => l.date).filter(Boolean)).size < 2) {
    chauffeur = false;
  }
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
      pax: req.passengerCount, bags: req.luggageCount, // let the engine upgrade an undersized vehicle
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
type ServiceChoice = ServiceSummary | { error: string };
type ServiceChooserData = { pointToPoint: ServiceChoice; chauffeur: ServiceChoice };
function summary(result: QuoteResult): ServiceSummary {
  return { total: money(result.totalCents), deposit: money(result.depositCents), amountDueNow: money(result.amountDueNowCents) };
}

// D-A / spec §3.1: margin is stripped from the wire response unless the caller has
// margin:view (founder only) — finance/ops price customers without ever seeing cost.
function shape(result: QuoteResult, canMargin: boolean) {
  const base = {
    product: result.product,
    total: money(result.totalCents),
    deposit: money(result.depositCents),
    amountDueNow: money(result.amountDueNowCents),
    warnings: result.warnings,
    // meta passes through so the client can zip travel-leg items (meta.billableKm) with the itinerary.
    lineItems: result.lineItems.map((li) => ({ label: li.label, amountCents: li.amountCents, usd: usd(li.amountCents), lkr: lkr(li.amountCents), meta: li.meta })),
  };
  if (!canMargin) return base;
  return { ...base, margin: result.marginEstimateCents == null ? null : money(result.marginEstimateCents) };
}

// Strip persisted margin from a stored quote for non-margin:view roles (spec §3.1) —
// used by GET /:id and PATCH /:id, which echo the full SavedQuote from the repo.
// The top-level marginCents is NOT the only copy: the persisted `result` JSON is a full
// QuoteResult, and QuoteResult.marginEstimateCents is the same cost/margin figure. A shallow
// delete of marginCents alone leaks it nested. Strip both. (breakdown/lineItems carry only
// customer-facing prices, so no other nested field needs stripping — see quote/types.ts.)
function stripQuoteMargin<T extends { marginCents: unknown; result?: unknown }>(q: T): Omit<T, 'marginCents' | 'rateCardJson'> {
  const rest: Record<string, unknown> = { ...q };
  delete rest.marginCents;
  // The locked rate-card snapshot embeds cost/markup fields (costPerKmCents, markupPct,
  // chauffeur.dayRateCostCents) — same margin class as marginCents, so drop it for non-margin
  // roles. The client renders from `result` (sell prices), never from this snapshot.
  delete rest.rateCardJson;
  if (rest.result && typeof rest.result === 'object') {
    const safeResult: Record<string, unknown> = { ...(rest.result as Record<string, unknown>) };
    delete safeResult.marginEstimateCents;
    rest.result = safeResult;
  }
  return rest as Omit<T, 'marginCents' | 'rateCardJson'>;
}

function serviceChooserData(body: ToolRequest, rateCard: RateCard, selected: 'private' | 'chauffeur', selectedResult: QuoteResult): ServiceChooserData {
  const services: ServiceChooserData = { pointToPoint: { error: 'n/a' }, chauffeur: { error: 'n/a' } };

  services.pointToPoint = selected === 'private'
    ? summary(selectedResult)
    : summary(quote(toEngineRequest(body, 'private'), rateCard));

  const chauffeurLegs = body.legs.filter((l) => drives(l) || (l.category || 'transfer') === 'stay_day');
  const distinctDates = new Set(chauffeurLegs.map((l) => l.date).filter(Boolean));
  if (chauffeurLegs.some((l) => !l.date)) {
    services.chauffeur = { error: 'add a date to every leg' };
  } else if (distinctDates.size <= 1) {
    services.chauffeur = { error: 'single-day — point-to-point only' };
  } else {
    services.chauffeur = selected === 'chauffeur'
      ? summary(selectedResult)
      : summary(quote(toEngineRequest(body, 'chauffeur'), rateCard));
  }

  return services;
}

// Price a saved quote against the rate card it is LOCKED to (spec 2026-07-11 §3): the frozen
// snapshot for a ready/sent quote, the live card otherwise. Reuses the stored engine request
// (distances already resolved — no maps round-trip) so opening a ready quote shows the APPROVED
// price, never a live recompute on a card that may have moved since. null for a legacy row that
// predates the { tool, engine } request shape. shape() strips margin for non-margin:view callers.
function lockedEstimate(q: SavedQuote, canMargin: boolean, now: Date): (ReturnType<typeof shape> & { breakdown?: ReturnType<typeof quoteBreakdown>; services?: ServiceChooserData }) | null {
  const toolReq = (q.request as { tool?: ToolRequest } | null)?.tool;
  const engineReq = (q.request as { engine?: QuoteRequest } | null)?.engine;
  if (!engineReq) return null;
  // The whole locked-estimate computation is best-effort: a corrupt/legacy lock snapshot
  // (or an un-priceable stored request) must degrade to null, never 500 the quote-open path.
  // rateCardFor() is inside the guard too — a malformed rateLockedUntil would otherwise throw.
  try {
    const { rateCard } = rateCardFor(
      { rateCardJson: (q.rateCardJson ?? null) as RateCard | null, rateLockedUntil: q.rateLockedUntil },
      now,
    );
    const result = quote(engineReq, rateCard);
    const base = shape(result, canMargin);
    // Legacy/minimal row without a usable tool payload → base total only (no per-leg / services).
    if (!toolReq || !toolReq.vehicle || !Array.isArray(toolReq.legs) || typeof toolReq.passengerCount !== 'number' || typeof toolReq.luggageCount !== 'number') {
      return base;
    }
    // Match the live /estimate shape so a ready/sent quote renders its per-leg prices AND the
    // point-to-point vs chauffeur comparison — all priced against the LOCKED card (frozen numbers).
    const selected: 'private' | 'chauffeur' = engineReq.product === 'chauffeur' ? 'chauffeur' : 'private';
    return {
      ...base,
      breakdown: quoteBreakdown(engineReq, rateCard),
      services: serviceChooserData(toolReq, rateCard, selected, result),
    };
  } catch {
    return null;
  }
}
type PlaceSuggestion = { label: string; source: 'known' | 'google' };

function normPlace(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Place suggestions via local known places first, then the maps adapter (Google/offline fallback lives there).
async function suggestPlaces(q: string, maps: MapsAdapter): Promise<PlaceSuggestion[]> {
  const query = (q || '').trim();
  if (query.length < 2) return [];
  const ql = query.toLowerCase();
  const local: PlaceSuggestion[] = KNOWN_PLACES.filter((p) => p.toLowerCase().includes(ql)).map((label) => ({ label, source: 'known' }));
  const seen = new Set(local.map((p) => normPlace(p.label)));
  const remote: PlaceSuggestion[] = (await maps.places(query))
    .filter((label) => {
      const key = normPlace(label);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((label) => ({ label, source: 'google' as const }));
  return local.concat(remote).slice(0, 6);
}

export function internalQuoteRoutes(deps: {
  maps: MapsAdapter;
  quotes: QuoteRepo;
  auth: OpsAuthConfig;
  allowedOrigins?: string[];
  // Assignment notification (spec 2026-07-16 §6). Optional: with no adapter, assignment still
  // works — it just goes unannounced, exactly as it did before this feature existed.
  email?: EmailAdapter;
  opsBaseUrl?: string; // origin serving /ops, for the email's deep link (config.OPS_BASE_URL)
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

  // D-A (2026-07-04): the quote tool opens to ALL THREE roles via quote:manage — reverts
  // the earlier founder-only gate. Cost/margin is stripped server-side per-response for
  // any role without margin:view (see shape()/stripQuoteMargin() below), so finance/ops
  // can quote customers without ever seeing driver cost. system (x-admin-key) does NOT
  // have quote:manage — a leaked cron key cannot see customer PII or issue quotes (D6).
  r.use('*', opsIdentity(deps.auth));
  r.use('*', (c, next) => (c.req.path === '/admin/quote' ? next() : requireCap('quote:manage')(c, next)));

  // Autocomplete (delegated to the maps adapter; Google key/timeout live there now).
  r.get('/places', async (c) => {
    const suggestions = await suggestPlaces(c.req.query('q') || '', deps.maps);
    return c.json({ places: suggestions.map((p) => p.label), suggestions });
  });

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
      const canMargin = can(c.get('identity').role, 'margin:view');
      // Price the SELECTED service (explicit body.service, else derived) for the detailed response.
      const { req, result } = await resolveAndPrice(body, deps.maps);
      const selected: 'private' | 'chauffeur' = req.product === 'chauffeur' ? 'chauffeur' : 'private';

      // Reflow: `services` chooser replaces the old car/van comparison. Two pricing passes max —
      // reuse the selected result for its side; price only the OTHER service additionally.
      const services = serviceChooserData(body, RATE_CARD, selected, result);

      return c.json({
        ...shape(result, canMargin),
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
  // An optional `id` on the body means "update this existing quote in place" (the founder
  // editing a quote mid-review, or an operator re-saving a reopened one) — same row, no
  // orphaned duplicate, lifecycle untouched. An unknown id falls back to an insert.
  r.post('/save', csrf, async (c) => {
    const raw = await c.req.json().catch(() => null);
    const existingId = raw && typeof (raw as { id?: unknown }).id === 'string' ? (raw as { id: string }).id : null;
    // Maker-checker: a content re-save is only allowed while the quote is still editable. A
    // ready/sent/decided quote must be reopened first (PATCH → draft, founder-gated) — otherwise
    // any quote:manage role could rewrite an already-approved quote's price and send it unreviewed.
    if (existingId) {
      const current = await deps.quotes.get(existingId);
      if (current && !(['draft', 'pending_review', 'changes_requested'] as QuoteStatus[]).includes(current.status)) {
        return c.json({ error: 'not_editable', status: current.status }, 409);
      }
    }
    try {
      const body = parseToolRequest(raw);
      const { req, result } = await resolveAndPrice(body, deps.maps);
      const content = {
        product: req.product,
        vehicle: 'vehicle' in req ? req.vehicle : null,
        customerName: customerNameFor(body),
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
        // Quote intent (spec 2026-07-17). Stored flat so the submit gate is a plain column
        // check; it also rides inside request.tool above, which is what the builder reopens from.
        requestedService: body.requestedService ?? null,
        // Audit (spec 2026-07-16). Both stamped on create; on a re-save the repo applies only
        // updatedBy, so authorship stays with whoever built the quote.
        createdBy: c.get('identity').email,
        updatedBy: c.get('identity').email,
      };
      const updated = existingId ? await deps.quotes.update(existingId, content) : null;
      if (updated) return c.json({ id: updated.id, reference: updated.reference, status: updated.status }, 200);
      const saved = await deps.quotes.save(content);
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
  // Margin note [CORRECTED 2026-07-04 during T-D]: the plan's A-5 assumed QuoteSummary (this
  // endpoint's return type) carries marginCents. As of the current db/quoteRepo.ts, it does
  // NOT — QuoteSummary has no marginCents field and toSummary() never populates one, so there
  // is nothing to strip here (an inert strip is worse than none — false security theater, per
  // spec §3.1's own correction elsewhere). If marginCents is ever added to QuoteSummary, gate
  // it behind can(identity.role, 'margin:view') via stripQuoteMargin() below and test both sides.
  r.get('/list', async (c) => {
    const status = c.req.query('status') as QuoteStatus | undefined;
    if (status && !QUOTE_STATUSES.includes(status)) return c.json({ error: 'bad_status' }, 400);
    const quotesList = await deps.quotes.list({
      channel: 'ops', // the review queue is ops-authored quotes only — never customer web quotes
      status,
      product: c.req.query('product') || undefined,
      from: c.req.query('from') || undefined,
      to: c.req.query('to') || undefined,
    });
    return c.json({ quotes: quotesList });
  });

  // Full quote (incl. request/result JSON) for re-opening in the tool. marginCents is
  // stripped for non-margin:view roles — /save persists it regardless (storage, not
  // exposure over the wire), but this read path must never echo it back to finance/ops.
  r.get('/:id', async (c) => {
    const q = await deps.quotes.get(c.req.param('id'));
    if (!q) return c.json({ error: 'not_found' }, 404);
    const canMargin = can(c.get('identity').role, 'margin:view');
    // Ship the quote priced against its locked card so the tool renders the frozen (approved)
    // price for a ready/sent quote instead of live-recomputing. Reopen consumes this directly.
    const estimate = lockedEstimate(q, canMargin, new Date());
    const view = canMargin ? q : stripQuoteMargin(q);
    return c.json({ ...view, estimate });
  });

  // Update a quote's status, lostReason, or notes. Stamps sentAt/decidedAt via the repo.
  r.patch('/:id', csrf, async (c) => {
    // Validate, don't cast: non-string lostReason/notes (e.g. an object) must not reach the DB.
    const parsed = z
      .object({
        status: z.string().optional(),
        lostReason: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
        assignedTo: z.string().nullable().optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'bad_request' }, 400);
    const body = parsed.data;
    if (body.status && !QUOTE_STATUSES.includes(body.status as QuoteStatus)) return c.json({ error: 'bad_status' }, 400);
    // Assignment (spec 2026-07-16 §5). Resolve the assignee against OPS_USERS BEFORE it reaches
    // the DB: assignment sends that person a link to the quote, so an unvalidated value would
    // mail a customer's quote to whatever address was typed. `null` = unassign, and is exempt.
    let assignedTo: string | null | undefined = undefined;
    if (body.assignedTo !== undefined) {
      if (body.assignedTo === null) assignedTo = null;
      else {
        assignedTo = resolveAssignee(body.assignedTo, deps.auth.opsUsers);
        if (assignedTo === null) return c.json({ error: 'unknown_assignee' }, 400);
      }
    }
    // Maker-checker gate: only legal status moves, and only the founder (quote:approve) can
    // mark a quote ready-to-send or send it back for changes (incl. the draft→ready self-approve).
    // Rate-lock (spec 2026-07-11 §3): approval freezes the card the customer will be quoted from;
    // reopening a locked (`ready`) quote back to an editable state drops to the live card again.
    let rateLock: QuotePatch['rateLock'] = undefined;
    // Read the pre-patch row once when either path needs it: the status gate below, and the
    // notification's "did the assignee actually change?" test (re-assigning to the same person
    // is not news, so it must not re-mail them).
    let current: SavedQuote | null = null;
    if (body.status || assignedTo !== undefined) {
      current = await deps.quotes.get(c.req.param('id'));
      if (!current) return c.json({ error: 'not_found' }, 404);
    }
    if (body.status && current) {
      const to = body.status as QuoteStatus;
      if (!canTransition(current.status, to)) return c.json({ error: 'illegal_transition' }, 409);
      // Quote intent (spec 2026-07-17, I3): a quote may not enter review — or be self-approved
      // straight to ready — until the submitter has recorded what the customer asked for.
      // Checked against the STORED row, never the body: only POST /save writes this field, so
      // trusting a body value here would be a hole, not a shortcut. Deliberately NOT applied to
      // /save (work-in-progress must stay savable) nor to any other transition. No exemption for
      // rows predating the field (I7) — there are few in flight, and an exemption would leave a
      // permanent hole in the rule.
      if ((to === 'pending_review' || to === 'ready') && !current.requestedService) {
        return c.json({ error: 'requested_service_required' }, 400);
      }
      const EDITABLE = ['draft', 'pending_review', 'changes_requested'] as QuoteStatus[];
      // Reopening an already-SENT quote is founder-only — it pulls a quote back from the
      // customer for changes, so it needs the same approval authority as sending it did.
      const reopeningSent = current.status === 'sent' && EDITABLE.includes(to);
      if ((to === 'ready' || to === 'changes_requested' || reopeningSent) && !can(c.get('identity').role, 'quote:approve')) {
        return c.json({ error: 'approve_forbidden' }, 403);
      }
      if (to === 'ready') {
        // Freeze the current card (no expiry — ops locks are held until reopened, not time-boxed).
        // The stored total was priced against RATE_CARD at /save; today RATE_CARD only changes on
        // deploy, so the current card is the one that produced this price. When the deferred founder
        // rate-card API lands (design doc §9), approval should re-price from this snapshot.
        rateLock = { rateCardJson: RATE_CARD, rateLockedUntil: null };
      } else if ((current.status === 'ready' || current.status === 'sent') && EDITABLE.includes(to)) {
        rateLock = null; // reopen-to-edit (from ready OR sent) unlocks; sending keeps the lock
      }
    }
    const updated = await deps.quotes.patch(c.req.param('id'), {
      status: body.status as QuoteStatus | undefined,
      lostReason: body.lostReason,
      notes: body.notes,
      rateLock,
      assignedTo,
      updatedBy: c.get('identity').email,
    });
    if (!updated) return c.json({ error: 'not_found' }, 404);
    // Tell the new assignee (spec §6). Only on a real handover: not a self-assign (you know), not
    // an unassign (nobody to tell), and not a no-op re-assign. Best-effort — the assignment is the
    // durable fact, so a provider outage must not 500 the patch and lose it.
    const actor = c.get('identity').email;
    const handoverTo =
      assignedTo && assignedTo !== (current?.assignedTo ?? null) && assignedTo !== actor.toLowerCase()
        ? assignedTo
        : null;
    if (handoverTo && deps.email) {
      try {
        await sendQuoteAssigned(updated, handoverTo, actor, deps.email, deps.opsBaseUrl ?? '');
      } catch (err) {
        console.error('quote assignment email failed', { quote: updated.reference, err });
      }
    }
    // Same strip as GET /:id — the updated SavedQuote carries marginCents; a routine
    // status/notes edit by finance/ops must not echo cost/margin back to them.
    const canMargin = can(c.get('identity').role, 'margin:view');
    return c.json(canMargin ? updated : stripQuoteMargin(updated));
  });

  return r;
}
