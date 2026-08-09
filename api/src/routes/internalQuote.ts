import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { quote } from '../quote/engine';
import { quoteBreakdown } from '../quote/breakdown';
import { RATE_CARD } from '../quote/rateCard';
import { rateCardFor } from '../quote/rateLock';
import type { QuoteRequest, QuoteResult, PrivateLeg, Ride, ExtraInput } from '../quote/types';
import type { Vehicle, RateCard } from '../quote/rateCard';
import type { SavedQuote } from '../db/quoteRepo';
import { KNOWN_PLACES, canonPlace, haversineKm, type MapsAdapter } from '../adapters/maps';
import { PlaceResolver, asLatLng } from '../services/placeResolver';
import type { PlaceResolutionRepo } from '../db/placeResolutionRepo';
import { QUOTE_STATUSES, canTransition, isUnpricedShell, type QuoteStatus, type QuotePatch } from '../db/quoteRepo';
import type { QuoteRepo } from '../db/quoteRepo';
import { InMemoryZonesRepo, hotZonesDisabled, type ZonesRepo } from '../db/zonesRepo';
import { can, resolveAssignee, approverOpsUsers } from '../lib/opsAuth';
import { opsIdentity, requireCap, type OpsAuthConfig } from '../lib/opsMiddleware';
import type { EmailAdapter } from '../adapters/email';
import { sendQuoteAssigned, sendQuoteAwaitingApproval, sendQuoteSentBack } from '../services/opsNotifications';
import { SingleTransferInput, CustomerInput } from '../domain/singleTransfer';
import { TripInput, MAX_TRIP_STOPS } from '../domain/trip';
import { PAYER_EDITABLE_STATUSES } from '../db/bookingRepo';
import type { BookingRepo, NewBooking } from '../db/bookingRepo';
import { quoteToBooking, QuoteNotBookableError, isQuoteBookable } from '../quote/quoteToBooking';
import {
  payLines,
  selectionAmountCents,
  isFullSelection,
  NotLineablePriceError,
  type PaySelection,
} from '../quote/paySelection';
import { changedFields } from '../quote/quoteDiff';
import { shortenRouteLabel, shortPlace } from '../quote/shortPlace';
import { signQuotePayToken, signQuoteViewToken } from '../lib/bookingToken';
// CATEGORIES/drives moved to quote/legCategory.ts so quoteView.ts shares one definition —
// a second copy here is how the customer page and the ops chooser drift on which legs drive.
import { drives } from '../quote/legCategory';

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
  // Multi-stop rides (phase 2): a leg may carry an ordered stop chain (2–8) instead of a single
  // from→to. `from`/`to` stay required (= first/last stop; the UI keeps sending them). segmentKms,
  // when present, is one entry per segment (stops.length−1); a null/≤0 entry is auto-resolved by
  // resolveAndPrice. Absent stops = the old point-to-point path, byte-for-byte unchanged.
  stops: z.array(z.string()).min(2, 'a ride needs at least 2 stops').max(8, 'a ride can have at most 8 stops').optional(),
  segmentKms: z.array(z.number().min(0).nullable()).optional(),
  addSightseeingFee: z.boolean().optional(),
  addWaitingFee: z.boolean().optional(),
  addSafariWait: z.boolean().optional(),
  // Route-choice (2026-07-20): which road the operator picked + what was offered when they
  // compared. Passthrough only — distanceKm stays the sole pricing input; both fields ride
  // into the saved quote's request_json verbatim (Phase-2 conversion data).
  routeVariant: z.enum(['fastest', 'no_tolls']).optional(),
  routeOptions: z
    .object({
      fastest: z.object({ km: z.number(), durationMin: z.number() }),
      noTolls: z.object({ km: z.number(), durationMin: z.number() }),
    })
    .optional(),
}).superRefine((leg, ctx) => {
  // Cross-field rules for a multi-stop leg (GC-9). Human-readable messages: this route 400s
  // with the FIRST issue's message. Only fire when `stops` is present (the old path has none).
  if (!leg.stops) return;
  if ((leg.category || 'transfer') === 'stay_day') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a stay day can\'t have stops', path: ['stops'] });
  }
  if (leg.segmentKms && leg.segmentKms.length !== leg.stops.length - 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `segmentKms needs one entry per segment (${leg.stops.length - 1})`,
      path: ['segmentKms'],
    });
  }
  for (let i = 0; i < leg.stops.length - 1; i++) {
    if (leg.stops[i].trim() === leg.stops[i + 1].trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a stop can\'t be the same as the one before it', path: ['stops', i] });
      break;
    }
  }
});
const ToolRequestSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  // Legacy ops-tool payloads used a single name. Keep accepting it so old clients/tests
  // and saved request.tool snapshots remain reopenable.
  name: z.string().optional(),
  contact: z.string().optional(),
  notes: z.string().optional(),
  // Internal ops notes (spec 2026-07-22) — free-text scratchpad, persisted to quotes.internal_notes.
  internalNotes: z.string().optional(),
  // Explicit service chooser (reflow). When present it overrides leg-derived product;
  // when absent, toEngineRequest keeps the derive-from-legs back-compat fallback.
  service: z.enum(['private', 'chauffeur']).optional(),
  // Quote intent (spec 2026-07-17). What the customer ASKED for, vs `service` = what we price.
  // Deliberately NOT defaulted from `service` (I4): a pre-filled value gets accepted unread,
  // which is the exact failure this field exists to prevent. No 'legacy' member — there is no
  // exemption (I7), so a client cannot mint one.
  // .nullable(): the builder always SENDS this key and it is null for a fresh draft; .optional()
  // alone rejects an explicit null → /save 400s. A null request is intended here (the status-change
  // gate below requires it, /save does not); the repo folds null/undefined alike via `?? null`.
  requestedService: z.enum(['private', 'chauffeur', 'both']).nullable().optional(),
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

// The fields the "Mark booked" modal supplies that the quote itself doesn't carry.
// CustomerInput enforces the full contactable set (email/whatsapp/country required).
const BookingDetailsSchema = z.object({
  customer: CustomerInput,
  vehicleType: z.enum(['car', 'van']),
  pax: z.number().int().min(1),
  bags: z.number().int().min(0),
  date: z.string().optional(),
  time: z.string().optional(),
});

function customerNameFor(body: ToolRequest): string | null {
  const splitName = [body.firstName, body.lastName]
    .map((s) => (s || '').trim())
    .filter(Boolean)
    .join(' ');
  return splitName || (body.name || '').trim() || null;
}

/* Did this save actually CHANGE the quote, or is it a no-op re-save?
   Editing someone else's quote hands it to you (owner, 2026-08-01) — but only on a real edit.
   Opening a quote to read it, and the save transition() fires just before a status change, must
   not quietly take it off the person who built it.

   Decided from the STORED row, never from a client flag: a flag the builder forgets to send, or
   sends wrongly, would move ownership silently — the exact failure this guard prevents. Key order
   is normalised because a reserialised-but-identical payload is not an edit. */
type ComparableQuote = {
  customerName?: string | null;
  customerContact?: string | null;
  totalCents?: number | null;
  notes?: string | null;
  internalNotes?: string | null;
  requestedService?: string | null;
  request?: unknown;
} | null | undefined;

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

export function contentChanged(before: ComparableQuote, after: ComparableQuote): boolean {
  // No stored row to compare against — never assume "no-op" on missing information.
  if (!before || !after) return true;
  const sig = (q: NonNullable<ComparableQuote>) => stableStringify({
    customerName: q.customerName ?? null,
    customerContact: q.customerContact ?? null,
    totalCents: q.totalCents ?? null,
    notes: q.notes ?? null,
    internalNotes: q.internalNotes ?? null,
    requestedService: q.requestedService ?? null,
    // request.tool is the reopenable itinerary — the legs, vehicle, pax, dates and extras.
    request: (q.request as { tool?: unknown } | null)?.tool ?? null,
  });
  return sig(before) !== sig(after);
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
  rateCard: RateCard = RATE_CARD,
  resolver?: PlaceResolver,
): Promise<{ req: QuoteRequest; result: QuoteResult }> {
  const driving = body.legs.filter(drives);
  if (driving.length === 0) {
    throw new PriceError('add at least one travel leg (a stay day alone has no transfer)', 400);
  }
  for (const l of driving) {
    if (l.stops) {
      // Multi-stop leg: resolve each null/≤0 segment; mirror distanceKm = segment sum.
      await resolveRideSegments(l, maps, resolver);
    } else if (!l.distanceKm || Number(l.distanceKm) <= 0) {
      // Old point-to-point path — untouched.
      l.distanceKm = await resolveLegKm(l, maps, resolver);
    }
  }
  try {
    const req = toEngineRequest(body, serviceOverride);
    return { req, result: quote(req, rateCard) };
  } catch (e) {
    if (e instanceof PriceError) throw e;
    throw new PriceError(e instanceof Error ? e.message : 'could not price this trip', 422);
  }
}

// Positive location identification (spec 2026-08-02), STAGE 1 — non-blocking.
//
// When both endpoints are identified we hand the Distance Matrix exact coordinates rather than
// names, which is what stops a string like "Yala, Sri Lanka" from being re-geocoded to the wrong
// town, and what lets the implausibly-short floor guard apply to EVERY leg rather than only to
// catalog pairs.
//
// When an endpoint is not yet identified we still price it the old way and report it as
// unresolved, so ops can confirm it without being blocked mid-quote. Stage 2 turns that report
// into a refusal; this stage exists so the backlog can be cleared first.
async function distanceVia(
  maps: MapsAdapter,
  resolver: PlaceResolver | undefined,
  from: string,
  to: string,
): Promise<{ d: Awaited<ReturnType<MapsAdapter['distance']>>; unresolved: string[] }> {
  if (!resolver) return { d: await maps.distance(from, to), unresolved: [] };
  const [rf, rt] = await Promise.all([resolver.resolve(from), resolver.resolve(to)]);
  if (rf.kind === 'resolved' && rt.kind === 'resolved') {
    return { d: await maps.distance(asLatLng(rf), asLatLng(rt)), unresolved: [] };
  }
  const unresolved = [rf, rt].flatMap((r) => (r.kind === 'needs_confirmation' ? [r.name] : []));
  return { d: await maps.distance(from, to), unresolved };
}

// Both endpoints identified → their coordinate strings; otherwise null, meaning "fall back to
// the names" (stage 1 is non-blocking).
async function resolvePairForMaps(
  resolver: PlaceResolver,
  from: string,
  to: string,
): Promise<{ from: string; to: string } | null> {
  const [rf, rt] = await Promise.all([resolver.resolve(from), resolver.resolve(to)]);
  if (rf.kind !== 'resolved' || rt.kind !== 'resolved') return null;
  return { from: asLatLng(rf), to: asLatLng(rt) };
}

// Resolve a driving leg's km via the maps adapter (a single from→to lookup).
// Unresolvable → 400 naming the failing leg.
async function resolveLegKm(l: ToolLeg, maps: MapsAdapter, resolver?: PlaceResolver): Promise<number> {
  const { d } = await distanceVia(maps, resolver, l.from, l.to);
  if (!d) {
    throw new PriceError(`couldn't find the distance for ${l.from || '?'} → ${l.to || '?'} — enter the km manually`, 400);
  }
  return Math.round(d.km);
}

// Resolve a multi-stop leg's segment distances in place (one maps.distance per null/≤0 segment,
// sequential — mirrors resolveLegKm's per-PAIR error message, naming the failing stop pair).
// A missing segmentKms array is treated as all-null. Mutates the leg: segmentKms → resolved
// numbers, and distanceKm → the segment sum (legacy mirror, updated even when all were manual).
async function resolveRideSegments(l: ToolLeg, maps: MapsAdapter, resolver?: PlaceResolver): Promise<void> {
  const stops = l.stops as string[];
  const segs: (number | null)[] = l.segmentKms ? [...l.segmentKms] : new Array<null>(stops.length - 1).fill(null);
  for (let i = 0; i < stops.length - 1; i++) {
    const km = segs[i];
    if (km == null || km <= 0) {
      const from = stops[i];
      const to = stops[i + 1];
      const { d } = await distanceVia(maps, resolver, from, to);
      if (!d) {
        throw new PriceError(`couldn't find the distance for ${from || '?'} → ${to || '?'} — enter the km manually`, 400);
      }
      segs[i] = Math.round(d.km);
    }
  }
  l.segmentKms = segs as number[];
  l.distanceKm = (segs as number[]).reduce((sum, k) => sum + k, 0);
}

const fxRate = RATE_CARD.fxUsdToLkr;
const toLkr = (cents: number): number => Math.round((cents * fxRate) / 100);
const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
const lkr = (cents: number): string => `LKR ${toLkr(cents).toLocaleString('en-US')}`;

function isChauffeur(legs: ToolLeg[]): boolean {
  return legs.some((l) => (l.category || 'transfer') === 'stay_day');
}
// Map one driving tool leg to its engine shape. A leg WITH stops → a Ride (segmentKms are
// guaranteed all-numbers post-resolve — narrowed here with a runtime guard, never a blind cast);
// WITHOUT stops → the old { from, to, distanceKm } exactly as before.
function toEngineLeg(l: ToolLeg): PrivateLeg | Ride {
  if (l.stops) {
    const segmentKms = (l.segmentKms ?? []).map((k) => {
      // resolveRideSegments runs first and fills every entry; a null here means it was skipped.
      if (typeof k !== 'number') throw new PriceError('a ride segment distance is missing — enter the km manually', 422);
      return k;
    });
    return { stops: l.stops, segmentKms };
  }
  return { from: l.from, to: l.to, distanceKm: Number(l.distanceKm) };
}

// legIndex must be the DRIVING index — toEngineRequest hands the engine
// `req.legs.filter(drives)`, so a raw state.legs index drifts by one for every stay day
// before it and would name the wrong leg. Non-driving legs still contribute their extras,
// unattributed, exactly as before: dropping them would change a total.
function collectExtras(legs: ToolLeg[]): ExtraInput[] {
  const out: ExtraInput[] = [];
  let drivingIndex = -1;
  for (const l of legs) {
    const legIndex = drives(l) ? ++drivingIndex : undefined;
    if (l.addSightseeingFee) out.push({ code: 'sightseeing', legIndex });
    if (l.addWaitingFee) out.push({ code: 'waiting', legIndex });
    if (l.addSafariWait) out.push({ code: 'safari-wait', legIndex });
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
      // With stops → { date, stops, segmentKms }; without → the old flat { date, from, to, distanceKm }.
      travelDays: driving.map((l) => ({ date: l.date as string, ...toEngineLeg(l) })),
      extras, customPerKmCents,
    };
  }
  return {
    product: 'private', vehicle, pax: req.passengerCount, bags: req.luggageCount,
    legs: driving.map(toEngineLeg), extras, customPerKmCents,
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
// Hot zones (D9): the founder-only "Ella premium +15%" annotation rides in a line item's
// meta.hotZone. It's a margin-class disclosure — WHY a price is elevated — so it must be stripped
// for any role without margin:view, exactly like marginCents. Returns meta with hotZone removed
// (undefined when there was no other meta), leaving every other meta field intact.
function stripZoneMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta || !('hotZone' in meta)) return meta;
  const rest = { ...meta };
  delete rest.hotZone;
  return Object.keys(rest).length ? rest : undefined;
}

// Short labels for the places in a tool payload, keyed by the raw string (2026-08-06).
//
// The ops builder composes the customer message from its own UNSAVED state, so a few rows (a
// chauffeur "Stay in …") have no engine line item to read a label off. Rather than let the client
// keep its own copy of the shortening rule — which is how ops, the pay page and emails drift
// apart — the server hands over the answers and the client looks them up.
function displayPlacesFor(toolLegs: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(toolLegs)) return out;
  for (const leg of toolLegs as { from?: string; to?: string; stops?: string[] }[]) {
    const places = Array.isArray(leg?.stops) && leg.stops.length ? leg.stops : [leg?.from, leg?.to];
    for (const p of places) if (typeof p === 'string' && p.trim()) out[p] = shortPlace(p);
  }
  return out;
}

function shape(result: QuoteResult, canMargin: boolean) {
  const base = {
    product: result.product,
    total: money(result.totalCents),
    deposit: money(result.depositCents),
    amountDueNow: money(result.amountDueNowCents),
    warnings: result.warnings,
    // meta passes through so the client can zip travel-leg items (meta.billableKm) with the itinerary.
    // The founder-only zone annotation is stripped for non-margin:view roles (D9).
    // `displayLabel` is the ONE place a route row gets shortened (2026-08-06). Clients render
    // what they are given rather than each keeping a copy of the rule — ops-ui had one, and
    // manage.html and the drawer were about to grow two more. `label` stays exact for search,
    // tooltips and anything that needs the address as stored.
    lineItems: result.lineItems.map((li) => ({ label: li.label, displayLabel: shortenRouteLabel(li.label), amountCents: li.amountCents, usd: usd(li.amountCents), lkr: lkr(li.amountCents), meta: canMargin ? li.meta : stripZoneMeta(li.meta) })),
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
    // The founder-only hot-zone annotation (D9) is persisted inside result.lineItems[].meta.hotZone.
    // Strip it per line item for non-margin roles — same margin-class disclosure as marginEstimateCents.
    if (Array.isArray(safeResult.lineItems)) {
      safeResult.lineItems = (safeResult.lineItems as { meta?: Record<string, unknown> }[]).map((li) =>
        li && li.meta && 'hotZone' in li.meta ? { ...li, meta: stripZoneMeta(li.meta) } : li,
      );
    }
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
function lockedEstimate(q: SavedQuote, canMargin: boolean, now: Date): (ReturnType<typeof shape> & { breakdown?: ReturnType<typeof quoteBreakdown>; services?: ServiceChooserData; displayPlaces?: Record<string, string> }) | null {
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
      displayPlaces: displayPlacesFor(toolReq.legs),
    };
  } catch {
    return null;
  }
}
type PlaceSuggestion = { label: string; source: 'known' | 'google' };

// Body of POST /place-confirm. Coordinates are bounded to real values; the string itself is
// canonicalised repo-side, so "Yala, Sri Lanka" and "yala" confirm the same row.
const PlaceConfirmSchema = z
  .object({
    name: z.string().trim().min(1).max(300),
    displayName: z.string().trim().min(1).max(300),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  })
  .strict();

// "6.37,81.52" → the point, for measuring candidates against the previous stop. null on anything else.
function parseNear(raw: string | undefined): [number, number] | null {
  if (!raw) return null;
  const [a, b] = raw.split(',').map((n) => Number(n.trim()));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a < -90 || a > 90 || b < -180 || b > 180) return null;
  return [a, b];
}

// Dedupe key for the suggestion list. Uses the SAME canonical form the coords lookup uses,
// so a Google description ("Yala, Sri Lanka") collides with the catalog entry it duplicates
// ("Yala") and is dropped. Before this the two spellings were distinct keys, so the dropdown
// offered both and picking the Google twin bypassed the coords pin — see canonPlace().
function normPlace(s: string): string {
  return canonPlace(s);
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

// Canonical form of a selection: deduped and sorted, so [1,0] and [0,1] are ONE selection and
// re-minting the same picks can't look like a change (which would retire the link ops just sent).
function normalizeSel(sel: PaySelection | null | undefined): PaySelection | null {
  if (!sel) return null;
  return {
    legIndexes: [...new Set(sel.legIndexes)].sort((a, b) => a - b),
    extraIndexes: [...new Set(sel.extraIndexes)].sort((a, b) => a - b),
  };
}

export function internalQuoteRoutes(deps: {
  maps: MapsAdapter;
  quotes: QuoteRepo;
  // Optional: with no repo injected the router uses an empty in-memory one ⇒ zero active zones ⇒
  // pricing identical to pre-hot-zones. Prod injects the Postgres repo (server.ts → app.ts).
  zones?: ZonesRepo;
  bookings: BookingRepo;
  auth: OpsAuthConfig;
  allowedOrigins?: string[];
  // Assignment notification (spec 2026-07-16 §6). Optional: with no adapter, assignment still
  // works — it just goes unannounced, exactly as it did before this feature existed.
  email?: EmailAdapter;
  opsBaseUrl?: string; // origin serving /ops, for the email's deep link (config.OPS_BASE_URL)
  // Pay links (spec 2026-07-31): the public site origin the link points at, the customer
  // link secret that signs it, and which PayHere mode the server is running — surfaced so
  // the ops UI can label a sandbox link instead of letting it pass for a live one.
  payBaseUrl?: string;
  // Customer quote links (spec 2026-08-05): the public site origin the link points at. Falls
  // back to payBaseUrl (see app.ts) so dev/staging keep working with one host.
  quoteBaseUrl?: string;
  linkSecret?: string;
  payhereMode?: string;
  // Positive location identification (spec 2026-08-02). Optional: with no repo injected there
  // is no resolver, and every distance takes the legacy name path exactly as before — so this
  // router keeps working unchanged in tests and keyless dev.
  placeResolutions?: PlaceResolutionRepo;
}) {
  const r = new Hono();
  const resolver = deps.placeResolutions
    ? new PlaceResolver(deps.placeResolutions, deps.maps)
    : undefined;

  // The live rate card composed with the currently-active hot zones (spec D5). Built per request so
  // a zone edit is reflected on the next quote; frozen into the snapshot at approval (C2). Zero
  // active zones (or HOT_ZONES_DISABLED) ⇒ hotZones is [] ⇒ pricing identical to pre-hot-zones.
  const zonesRepo = deps.zones ?? new InMemoryZonesRepo();
  const liveCard = async (): Promise<RateCard> => ({ ...RATE_CARD, hotZones: await zonesRepo.activeZones() });

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

  // ── Positive location identification (spec 2026-08-02) ──────────────────────────────────
  // Candidates for the ops "Confirm location" panel. Each carries its administrative area and,
  // when `near` (the previous stop) is supplied, the straight-line distance from it — because
  // Google's own labels do NOT distinguish the two Yalas: both render as plain "Sri Lanka",
  // which is exactly how the wrong one got picked.
  r.get('/place-candidates', requireCap('quote:manage'), async (c) => {
    const q = (c.req.query('q') || '').trim();
    if (q.length < 2) return c.json({ candidates: [] });
    const near = parseNear(c.req.query('near'));
    const raw = (await deps.maps.placeCandidates?.(q)) ?? [];
    const candidates = raw.slice(0, 6).map((p) => ({
      displayName: p.displayName,
      lat: p.lat,
      lng: p.lng,
      area: p.area,
      kmFromPrevious: near ? Math.round(haversineKm(near, [p.lat, p.lng])) : null,
    }));
    return c.json({ candidates });
  });

  // Record a human's identification of a string. Capability is quote:manage, not founder:
  // identifying a place is not a pricing decision (a hot-zone surcharge on that place still is,
  // and stays founder-only), and whoever is building the quote must be able to unblock it.
  r.post('/place-confirm', csrf, requireCap('quote:manage'), async (c) => {
    if (!deps.placeResolutions) return c.json({ error: 'not_configured' }, 503);
    const parsed = PlaceConfirmSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'bad_request', details: parsed.error.flatten() }, 400);
    const { name, displayName, lat, lng } = parsed.data;
    const saved = await deps.placeResolutions.upsert({
      canonKey: name,
      displayName,
      lat,
      lng,
      source: 'confirmed',
      confirmedBy: c.get('identity').email,
    });
    return c.json(saved, 201);
  });

  // Distance + duration between two places (Google Distance Matrix in prod, haversine in dev).
  // With compare:true (the ops "Compare routes" button) the response also carries the
  // expressway-vs-local-road variants when a materially different toll-free route exists;
  // top-level km/durationMin stay = fastest so the auto-resolve path's shape is unchanged.
  r.post('/distance', csrf, async (c) => {
    const b = (await c.req.json().catch(() => null)) as { from?: string; to?: string; compare?: boolean } | null;
    if (!b?.from || !b?.to) return c.json({ error: 'need from + to' }, 400);
    if (b.compare) {
      // Same reasoning as below: resolve first so a compared variant is measured between the
      // same identified points the quote is priced from.
      const pair = resolver ? await resolvePairForMaps(resolver, b.from, b.to) : null;
      const v = await deps.maps.distanceVariants(pair?.from ?? b.from, pair?.to ?? b.to);
      if (!v) return c.json({ error: 'unknown route' }, 404);
      return c.json({
        ...v.fastest,
        hasChoice: v.hasChoice,
        ...(v.hasChoice && v.noTolls ? { variants: { fastest: v.fastest, noTolls: v.noTolls } } : {}),
      });
    }
    // This is the path the ops builder's auto-distance actually uses, so it must resolve
    // through the same identity check as server-side pricing — otherwise the km the operator
    // sees (and saves onto the leg) is still a name-geocode, and stage 1 protects nothing they
    // can see. `unresolved` names the endpoints nobody has identified yet, which is what the
    // leg's "Confirm location" affordance keys off.
    const { d, unresolved } = await distanceVia(deps.maps, resolver, b.from, b.to);
    if (!d) return c.json({ error: 'unknown route' }, 404);
    return c.json(unresolved.length ? { ...d, unresolved } : d);
  });

  r.post('/estimate', csrf, async (c) => {
    const raw = await c.req.json().catch(() => null);
    try {
      const body = parseToolRequest(raw);
      const canMargin = can(c.get('identity').role, 'margin:view');
      // Compose the live rate card with the active hot zones once, and price every pass against it
      // so the total, per-leg breakdown, and the service chooser all agree (a zone boost reaches
      // ops quotes here; the website is a separate release — see the hot-zones spec §8).
      const card = await liveCard();
      // Price the SELECTED service (explicit body.service, else derived) for the detailed response.
      const { req, result } = await resolveAndPrice(body, deps.maps, undefined, card, resolver);
      const selected: 'private' | 'chauffeur' = req.product === 'chauffeur' ? 'chauffeur' : 'private';

      // Reflow: `services` chooser replaces the old car/van comparison. Two pricing passes max —
      // reuse the selected result for its side; price only the OTHER service additionally.
      const services = serviceChooserData(body, card, selected, result);

      return c.json({
        ...shape(result, canMargin),
        fxUsdToLkr: fxRate,
        breakdown: quoteBreakdown(req, card),
        services,
        displayPlaces: displayPlacesFor(body.legs),
      });
    } catch (e) {
      if (e instanceof PriceError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  });

  // "+ New quote" (spec 2026-07-29). Creates the row BEFORE anything is priceable, so an ops
  // agent can claim or hand over the ticket on the call rather than after a Save. /save prices
  // via resolveAndPrice() and therefore cannot create an empty row — hence this separate insert.
  // The row is a $0 SHELL: request/result are the { shell: true } marker, which POST /save
  // overwrites wholesale on the first real save. Nothing else about the row is special, so the
  // queue, assignment, soft-delete and reopen paths all work on it unchanged.
  r.post('/draft', csrf, async (c) => {
    const actor = c.get('identity').email;
    const saved = await deps.quotes.save({
      channel: 'ops',
      product: 'private', // the builder's default service; the first real save overwrites it
      totalCents: 0,
      currency: RATE_CARD.currency,
      rateCardVersion: RATE_CARD.version,
      request: { shell: true },
      result: { shell: true },
      createdBy: actor,
      updatedBy: actor,
      assignedTo: actor, // same auto-assign-to-creator rule /save applies on insert
    });
    return c.json({ id: saved.id, reference: saved.reference, status: saved.status, assignedTo: saved.assignedTo }, 201);
  });

  // Persist the currently-priced quote. Re-prices server-side — never trusts a client total.
  // An optional `id` on the body means "update this existing quote in place" (the founder
  // editing a quote mid-review, or an operator re-saving a reopened one) — same row, no
  // orphaned duplicate, lifecycle untouched. An id that no longer names a live row (the shell
  // sweep deleted it under the operator, or it was never ours) is a 409 quote_deleted — never an
  // insert, which would silently mint a SECOND quote with a brand-new reference.
  r.post('/save', csrf, async (c) => {
    const raw = await c.req.json().catch(() => null);
    const existingId = raw && typeof (raw as { id?: unknown }).id === 'string' ? (raw as { id: string }).id : null;
    // Kept in scope past the editability check: the assignment rule below needs the stored row.
    let existing: SavedQuote | null = null;
    // Maker-checker: a content re-save is only allowed while the quote is still editable.
    // Review lock (owner, 2026-07-17): SUBMISSION freezes content — pending_review is no longer
    // editable, so the founder approves exactly what they reviewed; the one door back in is the
    // explicit reopen-to-draft. ready/sent stay locked as before. changes_requested stays
    // editable — that state exists to be edited.
    if (existingId) {
      existing = await deps.quotes.get(existingId);
      if (existing && !(['draft', 'changes_requested'] as QuoteStatus[]).includes(existing.status)) {
        return c.json({ error: 'not_editable', status: existing.status }, 409);
      }
    }
    try {
      const body = parseToolRequest(raw);
      // Price against the live card + active zones, so a saved quote's stored total/margin already
      // reflect any hot-zone boost (it freezes on approval — see the PATCH → 'ready' path).
      const { req, result } = await resolveAndPrice(body, deps.maps, undefined, await liveCard(), resolver);
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
        internalNotes: body.internalNotes ?? null,
        // Quote intent (spec 2026-07-17). Stored flat so the submit gate is a plain column
        // check; it also rides inside request.tool above, which is what the builder reopens from.
        requestedService: body.requestedService ?? null,
        // Audit (spec 2026-07-16). Both stamped on create; on a re-save the repo applies only
        // updatedBy, so authorship stays with whoever built the quote.
        createdBy: c.get('identity').email,
        updatedBy: c.get('identity').email,
      };
      // What we actually charged, and the distances we had to resolve to get there. The builder
      // prices only its READY legs while one still lacks a distance ("Covers the ready legs"),
      // but the save above prices the WHOLE itinerary — so the stored total could be higher than
      // the number on the operator's screen, and nothing told them. resolveAndPrice mutates the
      // legs in place, so `body.legs` now carries the resolved values; echo them positionally
      // (same order the builder sent) so it can adopt them and re-price to match.
      const priced = {
        totalCents: result.totalCents,
        legs: body.legs.map((l) => ({
          distanceKm: typeof l.distanceKm === 'number' ? l.distanceKm : null,
          segmentKms: l.segmentKms ?? null,
        })),
      };
      if (existingId) {
        /* Editing someone else's quote hands it to you (owner, 2026-08-01), reversing the
           insert-only rule from spec 2026-07-22. Gated on a REAL change so that merely opening a
           quote — or the save transition() fires just before a status change — never takes it off
           the person who built it. contentChanged compares the stored row, not a client flag. */
        const actor = c.get('identity').email;
        const takeOver = contentChanged(existing, content) && existing?.assignedTo !== actor;
        const updated = await deps.quotes.update(existingId, takeOver ? { ...content, assignedTo: actor } : content);
        if (updated) {
          return c.json({
            id: updated.id, reference: updated.reference, status: updated.status,
            // Echo it only when it MOVED, so the builder can repaint the picker without a reload.
            ...(takeOver ? { assignedTo: actor } : {}),
            ...priced,
          }, 200);
        }
        // update() refuses a soft-deleted (or absent) row. Falling through to the insert would
        // hand the operator a duplicate under a reference nobody has seen — tell them instead so
        // they can re-create the quote from what is still on their screen.
        return c.json({ error: 'quote_deleted' }, 409);
      }
      // Auto-assign a NEW quote to its creator (spec 2026-07-22) so it lands in their "Assigned to
      // me". Insert-only: update() above leaves assignment to the picker.
      const saved = await deps.quotes.save({ ...content, assignedTo: c.get('identity').email });
      // Return assignedTo so the builder reflects the auto-assignment immediately (the update path
      // above omits it — a re-save must not move the assignee client-side either).
      return c.json({ id: saved.id, reference: saved.reference, status: saved.status, assignedTo: saved.assignedTo, ...priced }, 201);
    } catch (e) {
      if (e instanceof PriceError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  });

  // Create a real booking from a booked quote (spec 2026-07-18). The ops "Mark booked" modal
  // POSTs the contact/date/vehicle the quote lacks; the booking is priced at the quote's frozen
  // total (never re-priced) and the quote is stamped with the back-link + 'won'. Idempotent on
  // the quote id — a double-submit or a mid-failure retry returns the same booking.
  r.post('/:id/book', csrf, requireCap('bookings:operate'), async (c) => {
    const id = c.req.param('id');
    const quote = await deps.quotes.get(id);
    if (!quote) return c.json({ error: 'not_found' }, 404);
    if (quote.channel !== 'ops' || (quote.status !== 'sent' && quote.status !== 'won')) {
      return c.json({ error: 'not_bookable', status: quote.status }, 409);
    }

    const idempotencyKey = `book:quote:${id}`;

    // Read the form FIRST. This used to sit below the already-booked branch, so a re-book
    // returned the existing booking without the submitted details ever being parsed — the
    // operator's entry was discarded by a code path that then answered 200, which the ops UI
    // cannot tell from a real save. On prod (2026-08-04) that left a live booking carrying a
    // test's name and a staff email address, which is where the customer's mail would have
    // gone. Same failure as #274/#279 on the pay side: the resume branch dropped the
    // submission it had just been handed.
    const parsed = BookingDetailsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      // `details` (flatten) keys only by the TOP-level field, so a bad customer.email
      // arrives as "customer: Invalid email" — no use to an operator staring at a form
      // with five customer fields. `message` carries the full path per issue so the ops
      // toast can name the box to fix. Additive: `details` is unchanged.
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
        .join('; ');
      return c.json({ error: 'bad_request', message, details: parsed.error.flatten() }, 400);
    }

    // A quote is welded to at most one booking (idempotency key + a unique constraint on
    // converted_booking_id), because a double-clicked Confirm must never bill one trip twice.
    // So a re-book UPDATES that booking rather than making another.
    const prior = quote.convertedBookingId
      ? await deps.bookings.get(quote.convertedBookingId)
      : await deps.bookings.findByIdempotencyKey(idempotencyKey);
    if (prior) {
      // Once money has moved the payer on the row is evidence, not a draft. Refuse, and NAME
      // the booking — "already booked" with nothing to go on is how an operator ends up
      // pressing the button again.
      if (!(PAYER_EDITABLE_STATUSES as readonly string[]).includes(prior.status)) {
        return c.json(
          {
            error: 'already_booked',
            reference: prior.reference,
            status: prior.status,
            // `message` is what the ops toast shows. Name the booking and say what to do with
            // it, or the operator's only move is to press Confirm again.
            message: `This quote is already booked as ${prior.reference}, and that booking is ${prior.status.replace(/_/g, ' ')} — its details can no longer be changed here. Open it from the Bookings queue.`,
          },
          409,
        );
      }
      const updated = await deps.bookings.refreshPayerDetails(prior.id, { customer: parsed.data.customer });
      // Unconditionally, not just when the link was missing: a quote sat in `sent` with a
      // booking attached because this only ran on the first pass.
      await deps.quotes.patch(id, { convertedBookingId: prior.id, status: 'won' });
      return c.json(updated, 200);
    }

    let mapped;
    try {
      mapped = quoteToBooking(quote, parsed.data);
    } catch (e) {
      if (e instanceof QuoteNotBookableError) return c.json({ error: 'not_bookable' }, 409);
      throw e;
    }

    // Validate the built input against the same schema the public booking routes use —
    // a bad mapping fails loudly instead of persisting a malformed booking.
    const schema = mapped.mode === 'single' ? SingleTransferInput : TripInput;
    if (!schema.safeParse(mapped.input).success) {
      // The one rejection an operator can actually act on, and the one a real itinerary hits:
      // chaining inserts a stop wherever a leg doesn't start where the previous one ended (the
      // customer's own train hop), so a long multi-day tour can pass the cap on gaps alone. The
      // cap stays where it is — it is a Maps-spend and latency bound on a schema the public
      // booker shares — so name the cause instead, with both levers they have: shorten, or close
      // the gaps. Anything else stays the generic invalid_booking (a mapping bug, not their doing).
      if (mapped.mode === 'trip' && mapped.input.stops.length > MAX_TRIP_STOPS) {
        return c.json(
          {
            error: 'itinerary_too_long',
            message: `This itinerary needs ${mapped.input.stops.length} stops once the gaps between legs that don't connect are counted — over the ${MAX_TRIP_STOPS}-stop limit for a booking. Shorten the itinerary, or close the gaps so each leg starts where the previous one ended.`,
          },
          400,
        );
      }
      return c.json({ error: 'invalid_booking' }, 400);
    }

    const newBooking: NewBooking =
      mapped.mode === 'single'
        ? { mode: 'single', input: mapped.input, total: quote.totalCents, amountDueNow: quote.totalCents,
            currency: quote.currency, distanceKm: mapped.distanceKm, durationMin: null, channel: 'whatsapp' }
        : { mode: 'trip', input: mapped.input, total: quote.totalCents, amountDueNow: quote.totalCents,
            currency: quote.currency, distanceKm: mapped.distanceKm, durationMin: null, channel: 'whatsapp' };

    const created = await deps.bookings.create(newBooking, { idempotencyKey });
    // Land it in payment_pending so it surfaces in the ops Bookings queue ("Awaiting
    // payment") — a draft is hidden there. No payment row is recorded; payment is collected
    // out-of-band / via the payment-link flow. Guard on 'draft' so an idempotent retry (which
    // returns the existing payment_pending booking) never attempts an illegal self-transition.
    let booking = created;
    if (created.status === 'draft') {
      try {
        booking = await deps.bookings.setStatus(created.id, 'payment_pending');
      } catch {
        // A concurrent double-submit already moved this booking out of draft — re-read it
        // rather than surface a 500 on a booking that was, in fact, created.
        booking = (await deps.bookings.get(created.id)) ?? created;
      }
    }
    await deps.quotes.patch(id, {
      convertedBookingId: booking.id,
      status: 'won',
      // A full-quote booking contradicts any outstanding partial link, so retire it rather than
      // leaving a live link that could mint a SECOND booking for the same quote (spec §10).
      ...(quote.payLinkSelection
        ? { payLinkSelection: null, soldCents: null, payLinkSeq: quote.payLinkSeq + 1 }
        : {}),
    });
    return c.json(booking, 201);
  });

  // Partial-leg pay links (spec 2026-08-04). Indexes into engine.legs / engine.extras.
  const PayLinkSelectionSchema = z.object({
    legIndexes: z.array(z.number().int().min(0)),
    extraIndexes: z.array(z.number().int().min(0)),
  }).strict();

  // Mint a payment link for a ready|sent quote (spec 2026-07-31). STATELESS on purpose:
  // no booking, no DB row — the URL is a signed capability over {quoteId, revision}, so a
  // double-click yields the identical URL and generating can never touch the quote (sentAt
  // anchors the expiry clock and the aging report; → sent auto-assigns; none of that may
  // fire from a mint). The booking is born later, at the customer's pay-commit
  // (routes/quotePay.ts). Same shape gate as /book: only a priced, engine-bearing ops
  // quote can ever be paid, so refuse the rest at generation time rather than letting a
  // customer discover it.
  r.post('/:id/pay-link', csrf, async (c) => {
    const quote = await deps.quotes.get(c.req.param('id'));
    if (!quote) return c.json({ error: 'not_found' }, 404);
    const engine = (quote.request as { engine?: QuoteRequest } | null)?.engine;
    if (
      quote.channel !== 'ops' ||
      (quote.status !== 'ready' && quote.status !== 'sent') ||
      isUnpricedShell(quote) ||
      !engine ||
      engine.product === 'shared' ||
      // …and the itinerary must actually map to a booking. Without this the link mints fine
      // and dies at the customer's Continue tap (owner-caught, 2026-07-31). Fail here, where
      // ops can see it, not there.
      !isQuoteBookable(quote)
    ) {
      return c.json({ error: 'not_linkable', status: quote.status }, 409);
    }
    if (!deps.linkSecret || !deps.payBaseUrl) return c.json({ error: 'pay_links_unavailable' }, 503);

    // No body — or a body that says nothing about a selection (e.g. `{}`) — is the full-total
    // link, exactly as before this feature existed (spec §4). Only a body that ATTEMPTS a
    // selection is validated: half a selection charging the wrong amount is the failure mode.
    const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const attemptsSelection = raw != null && ('legIndexes' in raw || 'extraIndexes' in raw);
    const parsedSel = attemptsSelection ? PayLinkSelectionSchema.safeParse(raw) : null;
    if (parsedSel && !parsedSel.success) return c.json({ error: 'bad_request' }, 400);
    let selection: PaySelection | null = parsedSel ? normalizeSel(parsedSel.data) : null;

    let amountCents = quote.totalCents;
    let coverage: { soldLegs: number; totalLegs: number } | null = null;

    if (selection) {
      // Private and priced, or nothing — payLines throws for chauffeur, shells and legacy rows.
      let lines;
      try {
        lines = payLines(quote);
      } catch (e) {
        if (e instanceof NotLineablePriceError) return c.json({ error: 'not_linkable' }, 409);
        throw e;
      }
      if (isFullSelection(lines, selection)) {
        // Nothing was unticked. Fall through to the STORED total so charm finishing survives —
        // the leg lines alone sum to the subtotal, a few dollars under (spec §4).
        selection = null;
      } else {
        if (!selection.legIndexes.length) return c.json({ error: 'not_linkable' }, 409);
        if (!isQuoteBookable(quote, { legIndexes: selection.legIndexes })) {
          return c.json({ error: 'not_linkable' }, 409);
        }
        amountCents = selectionAmountCents(lines, selection);
        if (amountCents <= 0) return c.json({ error: 'not_linkable' }, 409);
        // From the lines, not engine.legs: payLines has already established this is a private
        // quote, and one source for "how many legs" is one fewer thing to disagree.
        coverage = {
          soldLegs: selection.legIndexes.length,
          totalLegs: lines.filter((l) => l.kind === 'leg').length,
        };
      }
    }

    // The seq moves ONLY when the selection actually changes, so pressing the button twice still
    // yields a byte-identical URL — the property ops relies on to re-copy a link it already sent.
    const changed =
      JSON.stringify(normalizeSel(quote.payLinkSelection)) !== JSON.stringify(selection);
    const seq = changed ? quote.payLinkSeq + 1 : quote.payLinkSeq;

    // Price-drift baseline (spec 2026-08-05 §9). Minting a link is a customer-facing moment — for
    // many quotes the ONLY one, since a link can go out without Mark sent ever being pressed. It
    // records the quote TOTAL, deliberately NOT `amountCents`: a partial link charges less than
    // the total by design, and storing that would leave the indicator permanently lit on this
    // quote. The charged amount is persisted as soldCents just above.
    const customerTotal =
      quote.customerTotalCents !== quote.totalCents
        ? { cents: quote.totalCents, at: new Date(), via: 'pay_link' as const }
        : undefined;

    // `seq` is untouched by the stamp — bumping it would retire the link being minted.
    if (changed || customerTotal) {
      await deps.quotes.patch(quote.id, {
        ...(changed
          ? {
              payLinkSelection: selection,
              soldCents: selection ? amountCents : null,
              payLinkSeq: seq,
            }
          : {}),
        ...(customerTotal ? { customerTotal } : {}),
      });
    }

    const token = signQuotePayToken(quote.id, quote.revision, deps.linkSecret, seq);
    return c.json({
      // `/p`, not `/pay.html` — see customerPages.ts. Eight characters off a link that a
      // customer reads immediately before being asked for money.
      url: `${deps.payBaseUrl.replace(/\/$/, '')}/p?t=${token}`,
      payhereMode: deps.payhereMode ?? 'off',
      amountCents,
      coverage,
    });
  });

  // The customer quote link (spec 2026-08-05). Same gate as the pay link — an approved quote —
  // but it mints no state: the token pins nothing, so pressing this twice is byte-identical and
  // ops can re-paste the link into the thread instead of making the customer scroll.
  r.post('/:id/quote-link', csrf, async (c) => {
    const quote = await deps.quotes.get(c.req.param('id'));
    if (!quote) return c.json({ error: 'not_found' }, 404);
    if (quote.channel !== 'ops' || (quote.status !== 'ready' && quote.status !== 'sent')) {
      return c.json({ error: 'not_linkable', status: quote.status }, 409);
    }
    const base = deps.quoteBaseUrl || deps.payBaseUrl;
    if (!deps.linkSecret || !base) return c.json({ error: 'quote_links_unavailable' }, 503);

    // Same price-drift baseline the pay link stamps, for the same reason: minting is a
    // customer-facing moment, and with a FOLLOWING link the number can move under a customer
    // who has already looked.
    if (quote.customerTotalCents !== quote.totalCents) {
      await deps.quotes.patch(quote.id, {
        customerTotal: { cents: quote.totalCents, at: new Date(), via: 'quote_link' as const },
      });
    }
    return c.json({ url: `${base.replace(/\/$/, '')}/q?t=${signQuoteViewToken(quote.id, deps.linkSecret)}` });
  });

  // The version timeline (spec 2026-08-05 §6). Gated on `quote:manage` — the same capability as
  // editing the quote, deliberately NOT founder-only: this response carries no margin, and ops
  // are the people making the edits, so ops are the people who need to see what an edit did.
  r.get('/:id/revisions', async (c) => {
    const id = c.req.param('id');
    const quote = await deps.quotes.get(id);
    if (!quote) return c.json({ error: 'not_found' }, 404);
    const history = await deps.quotes.listRevisions(id); // newest first

    // Each entry is compared against the version that SUPERSEDED it. For the newest entry that
    // successor is the CURRENT quote row — history holds only superseded states, so without this
    // cross-table read the top (and most interesting) entry would come back with nothing changed.
    const successors = [
      { request: quote.request, totalCents: quote.totalCents },
      ...history.map((h) => ({ request: h.request, totalCents: h.totalCents })),
    ];

    return c.json({
      // Hand-picked projection: request/result never reach the wire — they carry margin and
      // hot-zone annotations, exactly as the stored quote does.
      revisions: history.map((h, i) => ({
        revision: h.revision,
        totalCents: h.totalCents,
        currency: h.currency,
        status: h.status,
        updatedBy: h.updatedBy,
        createdAt: h.createdAt,
        changed: changedFields({ request: h.request, totalCents: h.totalCents }, successors[i]),
      })),
    });
  });

  // The charge lines of a quote, for the ops "Part of trip…" picker. Read-only: looking stores
  // nothing. Registered next to the mint so the two can never disagree about what a line is.
  r.get('/:id/pay-lines', async (c) => {
    const quote = await deps.quotes.get(c.req.param('id'));
    if (!quote) return c.json({ error: 'not_found' }, 404);
    try {
      return c.json({
        lines: payLines(quote),
        totalCents: quote.totalCents,
        selection: quote.payLinkSelection,
      });
    } catch (e) {
      if (e instanceof NotLineablePriceError) return c.json({ error: 'not_linkable' }, 409);
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

  // ── Hot zones admin (spec §7) — the founder's pricing lever. Reads are visible under margin:view;
  // every WRITE is gated by quote:approve ON TOP OF the router's quote:manage guard (both = founder
  // today, D4). CSRF applies to writes. Audit: created_by/updated_by are stamped from the session
  // identity — a % change is never anonymous. Registered BEFORE /:id so /zones never matches the
  // param route.
  const zoneShape = z.object({
    placeName: z.string().trim().min(1).max(120),
    boostPct: z.number().int().min(0).max(100),
    active: z.boolean().optional(),
    lat: z.number().nullable().optional(),
    lng: z.number().nullable().optional(),
    radiusKm: z.number().nullable().optional(),
  });
  // The geo trio is all-or-nothing (spec §4): either none set, or all three with radiusKm > 0.
  const geoTrioOk = (v: { lat?: number | null; lng?: number | null; radiusKm?: number | null }): boolean => {
    const present = [v.lat, v.lng, v.radiusKm].filter((x) => x != null).length;
    return present === 0 || (present === 3 && Number(v.radiusKm) > 0);
  };
  const createZone = zoneShape.refine(geoTrioOk, { message: 'lat/lng/radiusKm must be all set (radiusKm > 0) or all empty' });
  const patchZone = zoneShape.partial().refine(geoTrioOk, { message: 'lat/lng/radiusKm must be all set (radiusKm > 0) or all empty' });

  r.get('/zones', requireCap('margin:view'), async (c) => c.json({ zones: await zonesRepo.list(), disabled: hotZonesDisabled() }));

  r.post('/zones', csrf, requireCap('quote:approve'), async (c) => {
    const parsed = createZone.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'bad_request', detail: parsed.error.issues[0]?.message }, 400);
    const email = c.get('identity').email;
    const created = await zonesRepo.create({ ...parsed.data, createdBy: email, updatedBy: email });
    return c.json(created, 201);
  });

  r.patch('/zones/:id', csrf, requireCap('quote:approve'), async (c) => {
    const parsed = patchZone.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'bad_request', detail: parsed.error.issues[0]?.message }, 400);
    const updated = await zonesRepo.patch(c.req.param('id'), { ...parsed.data, updatedBy: c.get('identity').email });
    if (!updated) return c.json({ error: 'not_found' }, 404);
    return c.json(updated);
  });

  r.delete('/zones/:id', csrf, requireCap('quote:approve'), async (c) => {
    const ok = await zonesRepo.remove(c.req.param('id'));
    if (!ok) return c.json({ error: 'not_found' }, 404);
    return c.json({ ok: true });
  });

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
        internalNotes: z.string().nullable().optional(),
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
    let offerValidUntil: Date | undefined;
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
      // Lowercased to compare against stored assignees, which resolveAssignee normalises.
      const actorEmail = c.get('identity').email.toLowerCase();
      // Autosave shells (spec 2026-07-29, owner: "make sure zero $ quotes can never be sent").
      // A shell is a real draft row created before anything was priceable; it must never reach
      // review, approval or the customer. Checked against the STORED row, never the body — only
      // POST /save writes pricing, so a body value here would be a hole, not a shortcut.
      // Assignment and internal notes stay allowed: that is the whole point of the early row.
      // Deliberately ahead of the canTransition check below: a caller jumping straight from draft
      // to ready/sent must see unpriced_quote, not the generic illegal_transition — the price gate
      // is the more specific (and more important) reason the request cannot proceed.
      if ((to === 'pending_review' || to === 'ready' || to === 'sent') && isUnpricedShell(current)) {
        return c.json({ error: 'unpriced_quote' }, 400);
      }
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
      // Reviving an EXPIRED quote is deliberately NOT founder-gated, unlike pulling back a
      // 'sent' one: nobody chose to close it — a background sweep did — so restoring it is
      // undoing the system's action, not overriding a person's. It also re-prices at the live
      // card (rateLock above), so a revived quote can never carry a stale price to a customer.
      const reopeningSent = current.status === 'sent' && EDITABLE.includes(to);
      if ((to === 'ready' || to === 'changes_requested' || reopeningSent) && !can(c.get('identity').role, 'quote:approve')) {
        return c.json({ error: 'approve_forbidden' }, 403);
      }
      if (to === 'ready') {
        // Freeze the current card + its active HOT ZONES (no expiry — ops locks are held until
        // reopened, not time-boxed). Composing the zones INTO the snapshot is what satisfies C2: a
        // later zone edit (or deactivation) must never re-price this approved quote — it keeps the
        // zones it was locked with. lockedEstimate() reads hotZones straight back out of the snapshot.
        rateLock = { rateCardJson: await liveCard(), rateLockedUntil: null };
        // Offer validity (spec D9): the price is honoured for 7 days from approval. Re-approving
        // resets it, so the fix for a lapsed quote is the thing ops was going to do anyway.
        // Deliberately NOT rateLockedUntil, which stays null for ops quotes — that is precisely
        // why this field exists.
        offerValidUntil = new Date(Date.now() + 7 * 24 * 3600 * 1000);
      } else if ((current.status === 'ready' || current.status === 'sent' || current.status === 'expired') && EDITABLE.includes(to)) {
        // Reopen-to-edit (from ready, sent, OR expired) unlocks; sending keeps the lock.
        // 'expired' matters most here: a quote can now sit closed for months before someone
        // revives it, and re-pricing against the card it was frozen at would quote a stale
        // rate. Dropping the lock re-prices at today's card, which is the whole point.
        rateLock = null;
      }
      // Auto-assign on hand-off (owner, 2026-07-26). These are the two moments a quote changes
      // hands, and leaving them manual meant approved quotes sat in "Ready to send" still held by
      // the founder who approved them, and nothing owned a quote once it went out. An explicit
      // assignedTo on the SAME patch always wins — this only fills a gap, never overrides intent.
      if (assignedTo === undefined) {
        if (to === 'ready') {
          // Approval hands the quote back to the agent who built it, so it lands on the plate of
          // whoever has to send it. Only when nobody holds it or the approver does: a deliberate
          // assignment to a third person is somebody's decision and must survive. resolveAssignee
          // re-validates against OPS_USERS because createdBy is stored history — the person may
          // have left, and we must never assign (and mail) a quote to a stranger.
          const heldByApprover = (current.assignedTo ?? null) === actorEmail;
          if ((current.assignedTo == null || heldByApprover) && current.createdBy) {
            const back = resolveAssignee(current.createdBy, deps.auth.opsUsers);
            if (back) assignedTo = back;
          }
        } else if (to === 'sent') {
          // Whoever sent it owns the follow-up. Unconditional — this is a statement about who
          // acted, not a gap-fill, so it takes the quote off its previous holder.
          assignedTo = actorEmail;
        }
      }
    }
    // Price-drift baseline (spec 2026-08-05 §9). Sending a quote IS the moment a customer is
    // quoted a number, so record the total as it stands right now. Read from the STORED row, never
    // the body — only POST /save writes pricing, so a body value here would be a hole.
    const customerTotal: QuotePatch['customerTotal'] =
      body.status === 'sent' && current
        ? { cents: current.totalCents, at: new Date(), via: 'sent' as const }
        : undefined;

    const updated = await deps.quotes.patch(c.req.param('id'), {
      status: body.status as QuoteStatus | undefined,
      lostReason: body.lostReason,
      notes: body.notes,
      internalNotes: body.internalNotes,
      rateLock,
      assignedTo,
      updatedBy: c.get('identity').email,
      customerTotal,
      offerValidUntil,
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
    // Awaiting-approval → all quote:approve holders except the actor (spec 2026-07-18).
    if (body.status === 'pending_review' && deps.email) {
      for (const u of approverOpsUsers(deps.auth.opsUsers)) {
        if (u.email === actor.toLowerCase()) continue;
        try {
          await sendQuoteAwaitingApproval(updated, u.email, actor, deps.email, deps.opsBaseUrl ?? '');
        } catch (err) {
          console.error('quote awaiting-approval email failed', { quote: updated.reference, to: u.email, err });
        }
      }
    }
    // Sent-back → the maker (createdBy), except the actor, carrying the note (spec 2026-07-18).
    if (body.status === 'changes_requested' && deps.email && updated.createdBy && updated.createdBy.toLowerCase() !== actor.toLowerCase()) {
      try {
        await sendQuoteSentBack(updated, updated.createdBy, actor, body.notes ?? null, deps.email, deps.opsBaseUrl ?? '');
      } catch (err) {
        console.error('quote sent-back email failed', { quote: updated.reference, err });
      }
    }
    // Same strip as GET /:id — the updated SavedQuote carries marginCents; a routine
    // status/notes edit by finance/ops must not echo cost/margin back to them.
    const canMargin = can(c.get('identity').role, 'margin:view');
    return c.json(canMargin ? updated : stripQuoteMargin(updated));
  });

  // Delete a quote (spec 2026-07-22). SOFT delete — the row is hidden from the queue/tool but
  // retained in the table (recoverable, audit-preserving), never a hard wipe. Gated by lifecycle
  // state, layered on top of the route-wide quote:manage requirement:
  //   draft | changes_requested → any quote:manage holder (ops) — unlocked, never sent
  //   pending_review | ready     → founder only (quote:approve)  — locked, not yet sent
  //   sent | won | lost | expired → NOBODY                        — customer-facing / decided
  const DELETABLE_BY_OPS: readonly QuoteStatus[] = ['draft', 'changes_requested'];
  const DELETABLE_BY_FOUNDER: readonly QuoteStatus[] = ['pending_review', 'ready'];
  r.delete('/:id', csrf, async (c) => {
    const id = c.req.param('id');
    const quote = await deps.quotes.get(id);
    if (!quote) return c.json({ error: 'not_found' }, 404);
    const st = quote.status;
    if (!DELETABLE_BY_OPS.includes(st) && !DELETABLE_BY_FOUNDER.includes(st)) {
      // sent / won / lost / expired — a quote the customer has seen is never deletable.
      return c.json({ error: 'not_deletable', reason: 'sent_or_decided' }, 409);
    }
    if (DELETABLE_BY_FOUNDER.includes(st) && !can(c.get('identity').role, 'quote:approve')) {
      return c.json({ error: 'forbidden', reason: 'founder_only' }, 403);
    }
    const deleted = await deps.quotes.softDelete(id, c.get('identity').email);
    if (!deleted) return c.json({ error: 'not_found' }, 404); // raced with another delete
    return c.json({ id: deleted.id, deleted: true }, 200);
  });

  return r;
}
