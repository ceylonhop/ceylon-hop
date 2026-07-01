import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { quote } from '../quote/engine';
import { quoteBreakdown } from '../quote/breakdown';
import { RATE_CARD } from '../quote/rateCard';
import type { QuoteRequest, QuoteResult } from '../quote/types';
import type { ExtraCode, Vehicle } from '../quote/rateCard';
import { KNOWN_PLACES, type MapsAdapter } from '../adapters/maps';
import { QUOTE_STATUSES, type QuoteStatus } from '../db/quoteRepo';
import type { QuoteRepo } from '../db/quoteRepo';

// The single-page tool UI (served same-origin so it can call /admin/quote/estimate without CORS).
// Read per-request so edits hot-reload in dev without a server restart.
const toolHtml = (): string => readFileSync(fileURLToPath(new URL('./quote-tool.html', import.meta.url)), 'utf8');

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

interface ToolLeg {
  category?: string;
  date?: string;
  from: string;
  to: string;
  distanceKm?: number;
  addSightseeingFee?: boolean;
  addWaitingFee?: boolean;
  hasDriver?: boolean;
  hasCarStay?: boolean;
}
interface ToolRequest {
  name?: string;
  contact?: string;
  notes?: string;
  vehicle: string; // design tier id
  passengerCount: number;
  luggageCount: number;
  legs: ToolLeg[];
}

// Thrown by resolveAndPrice so the route can map it to the right HTTP status.
class PriceError extends Error {
  constructor(message: string, readonly status: 400 | 422) {
    super(message);
  }
}

// Shared by /estimate and /save: validate legs, auto-resolve missing distances via the
// maps adapter, then price with the engine. Mutates each driving leg's distanceKm in place.
async function resolveAndPrice(
  body: ToolRequest,
  maps: MapsAdapter,
): Promise<{ req: QuoteRequest; result: QuoteResult }> {
  if (!body || !Array.isArray(body.legs) || body.legs.length === 0) {
    throw new PriceError('add at least one leg', 400);
  }
  const driving = body.legs.filter(drives);
  if (driving.length === 0) {
    throw new PriceError('add at least one travel leg (a stay day alone has no transfer)', 400);
  }
  for (const l of driving) {
    if (!l.distanceKm || Number(l.distanceKm) <= 0) {
      const d = await maps.distance(l.from, l.to);
      if (d) l.distanceKm = d.km;
      else throw new PriceError(`couldn't find the distance for ${l.from || '?'} → ${l.to || '?'} — enter the km manually`, 400);
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
    const dated = req.legs.map((l) => l.date).filter(Boolean) as string[];
    if (dated.length < 1) throw new PriceError('chauffeur trips need dates on the legs (to count the days)', 400);
    const sorted = [...dated].sort();
    return {
      product: 'chauffeur', vehicle, firstDate: sorted[0], lastDate: sorted[sorted.length - 1],
      travelDays: driving.map((l) => ({ date: l.date || sorted[0], from: l.from, to: l.to, distanceKm: Number(l.distanceKm) })),
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
    lineItems: result.lineItems.map((li) => ({ label: li.label, usd: usd(li.amountCents), lkr: lkr(li.amountCents) })),
  };
}

function legLabel(l: ToolLeg): string {
  return drives(l) ? `${l.from} → ${l.to}` : `Stay in ${l.from || l.to}`;
}

function whatsappDraft(name: string, req: ToolRequest, result: QuoteResult): string {

  const lines = req.legs
    .filter(drives)
    .map((l) => `${l.date ? l.date + ' — ' : ''}${legLabel(l)}`)
    .join('\n');
  const due = result.product === 'chauffeur' ? `\nDeposit to confirm: ${lkr(result.amountDueNowCents)} (balance on/after the trip).` : '';
  return (
    `Hi ${name || 'there'}, thank you for sharing the details.\n\n` +
    `We can help with this. Based on your itinerary, here is the quote:\n\n${lines}\n\n` +
    `Total: ${lkr(result.totalCents)}${due}\n\n` +
    `This is for a private ${req.vehicle} and includes fuel, driver cost, tolls, and pickup/drop-off from your locations.` +
    (result.product === 'chauffeur' ? ' It also covers the driver staying with you for the nights marked, including driver meals and accommodation.' : '') +
    `\n\nPlease let me know if you have any questions or if you would like to proceed.`
  );
}

function emailDraft(name: string, req: ToolRequest, result: QuoteResult): string {

  const lines = req.legs
    .filter(drives)
    .map((l) => `  ${l.date ? l.date + '   ' : ''}${legLabel(l)}`)
    .join('\n');
  return (
    `Subject: Ceylon Hop Transport Quote for Your Sri Lanka Trip\n\n` +
    `Hi ${name || 'there'},\n\n` +
    `Thank you for reaching out to Ceylon Hop. Based on the itinerary you shared, please find the transport quote below.\n\n` +
    `${lines}\n\n` +
    `Total (private ${req.vehicle}): ${lkr(result.totalCents)}\n\n` +
    `This quote includes fuel, driver cost, tolls, and pickup/drop-off from the agreed locations.\n\n` +
    `Please let us know if you would like to proceed and we can send over the booking/payment details.\n\nBest,\nRoshen\nCeylon Hop`
  );
}

function notionDraft(req: ToolRequest, result: QuoteResult): string {

  const body = req.legs
    .filter(drives)
    .map((l) => `| ${l.date || ''} | ${legLabel(l)} | |`)
    .join('\n');
  return (
    `| Date | Route | Price Given |\n|---|---|---|\n${body}\n` +
    `| PRIVATE TRANSFER VIA ${req.vehicle.toUpperCase()} | | ${lkr(result.totalCents)} |`
  );
}

// Place suggestions: Google Places Autocomplete when a server key is configured, else the
// offline known-place list (so the tool works in dev without a key).
async function suggestPlaces(q: string, googleKey?: string): Promise<string[]> {
  const query = (q || '').trim();
  if (query.length < 2) return [];
  if (googleKey) {
    try {
      const url =
        'https://maps.googleapis.com/maps/api/place/autocomplete/json' +
        `?input=${encodeURIComponent(query)}&components=country:lk&key=${googleKey}`;
      const res = await fetch(url);
      const j = (await res.json()) as { predictions?: { description: string }[] };
      const out = (j.predictions || []).slice(0, 6).map((p) => p.description);
      if (out.length) return out;
    } catch {
      /* fall through to the offline list */
    }
  }
  const ql = query.toLowerCase();
  return KNOWN_PLACES.filter((p) => p.toLowerCase().includes(ql)).slice(0, 6);
}

export function internalQuoteRoutes(deps: { maps: MapsAdapter; googleKey?: string; quotes: QuoteRepo; adminKey?: string }) {
  const r = new Hono();

  // Open shell (a browser navigation can't send a header). The JS attaches the key to
  // its fetches; the guard below protects every data/XHR route.
  r.get('/', (c) => c.html(toolHtml()));

  // Enforce the admin key ONLY when one is configured, so dev/preview (no key) still works.
  // Prod MUST set ADMIN_API_KEY — see the go-live checklist.
  r.use('*', async (c, next) => {
    if (deps.adminKey && c.req.header('x-admin-key') !== deps.adminKey) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    return next();
  });

  // Autocomplete (server-side; key never reaches the browser).
  r.get('/places', async (c) => c.json({ places: await suggestPlaces(c.req.query('q') || '', deps.googleKey) }));

  // Distance + duration between two places (Google Distance Matrix in prod, haversine in dev).
  r.post('/distance', async (c) => {
    const b = (await c.req.json().catch(() => null)) as { from?: string; to?: string } | null;
    if (!b?.from || !b?.to) return c.json({ error: 'need from + to' }, 400);
    const d = await deps.maps.distance(b.from, b.to);
    return d ? c.json(d) : c.json({ error: 'unknown route' }, 404);
  });

  r.post('/estimate', async (c) => {
    const body = (await c.req.json().catch(() => null)) as ToolRequest | null;
    try {
      const { req, result } = await resolveAndPrice(body as ToolRequest, deps.maps);
      const comparison: Record<string, ReturnType<typeof shape> | { error: string }> = {};
      for (const v of ['car', 'van'] as Vehicle[]) {
        try {
          comparison[v] = shape(quote({ ...req, vehicle: v } as QuoteRequest));
        } catch (e) {
          comparison[v] = { error: e instanceof Error ? e.message : 'n/a' };
        }
      }
      return c.json({
        ...shape(result),
        fxUsdToLkr: fxRate,
        breakdown: quoteBreakdown(req),
        comparison,
        drafts: {
          whatsapp: whatsappDraft(body?.name ?? '', body as ToolRequest, result),
          email: emailDraft(body?.name ?? '', body as ToolRequest, result),
          notion: notionDraft(body as ToolRequest, result),
        },
      });
    } catch (e) {
      if (e instanceof PriceError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  });

  // Persist the currently-priced quote. Re-prices server-side — never trusts a client total.
  r.post('/save', async (c) => {
    const body = (await c.req.json().catch(() => null)) as (ToolRequest & { name?: string; contact?: string; notes?: string }) | null;
    try {
      const { req, result } = await resolveAndPrice(body as ToolRequest, deps.maps);
      const saved = await deps.quotes.save({
        product: req.product,
        vehicle: 'vehicle' in req ? req.vehicle : null,
        customerName: body?.name ?? null,
        customerContact: body?.contact ?? null,
        totalCents: result.totalCents,
        currency: RATE_CARD.currency,
        rateCardVersion: RATE_CARD.version,
        marginCents: result.marginEstimateCents ?? null,
        request: req,
        result,
        notes: body?.notes ?? null,
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
