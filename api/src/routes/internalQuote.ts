import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { quote } from '../quote/engine';
import { RATE_CARD } from '../quote/rateCard';
import type { QuoteRequest, QuoteResult } from '../quote/types';
import type { ExtraCode, Vehicle } from '../quote/rateCard';
import { KNOWN_PLACES, type MapsAdapter } from '../adapters/maps';
import type { QuoteRepo } from '../db/quoteRepo';

// The single-page tool UI (served same-origin so it can call /admin/quote/estimate without CORS).
// Read per-request so edits hot-reload in dev without a server restart.
const toolHtml = (): string => readFileSync(fileURLToPath(new URL('./quote-tool.html', import.meta.url)), 'utf8');

// Leg "types" the tool offers. `drives` = the vehicle actually moves that day (priced as a travel
// leg); a stay day is an idle day for a chauffeur trip.
const LEG_TYPES: Record<string, { drives: boolean; extra?: ExtraCode }> = {
  transfer: { drives: true },
  train_support: { drives: true },
  airport: { drives: true },
  sightseeing: { drives: true, extra: 'sightseeing' },
  safari_wait: { drives: true, extra: 'safari-wait' },
  stay_day: { drives: false },
};

interface ToolLeg {
  type?: string;
  date?: string;
  from: string;
  to: string;
  distanceKm?: number;
  sightseeing?: boolean;
  waiting?: boolean;
}
interface ToolRequest {
  name?: string;
  product: 'private' | 'chauffeur';
  vehicle: Vehicle;
  pax: number;
  bags: number;
  legs: ToolLeg[];
}

const fxRate = RATE_CARD.fxUsdToLkr;
const toLkr = (cents: number): number => Math.round((cents * fxRate) / 100);
const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
const lkr = (cents: number): string => `LKR ${toLkr(cents).toLocaleString('en-US')}`;

function collectExtras(legs: ToolLeg[]): ExtraCode[] {
  const out: ExtraCode[] = [];
  for (const l of legs) {
    const t = LEG_TYPES[l.type || 'transfer'];
    if (t?.extra) out.push(t.extra);
    if (l.sightseeing) out.push('sightseeing');
    if (l.waiting) out.push('waiting');
  }
  return out;
}

// Map the tool's typed itinerary to the engine's QuoteRequest. Driving legs price/travel;
// stay days become idle days for a chauffeur trip (the engine derives idle days from the date span).
function toEngineRequest(req: ToolRequest): QuoteRequest {
  const extras = collectExtras(req.legs);
  const driving = req.legs.filter((l) => LEG_TYPES[l.type || 'transfer']?.drives);
  const dated = req.legs.map((l) => l.date).filter(Boolean) as string[];

  if (req.product === 'chauffeur') {
    if (dated.length < 1) throw new Error('chauffeur needs dates on the legs (to count the days)');
    const sorted = [...dated].sort();
    return {
      product: 'chauffeur',
      vehicle: req.vehicle,
      firstDate: sorted[0],
      lastDate: sorted[sorted.length - 1],
      travelDays: driving.map((l) => ({
        date: l.date || sorted[0],
        from: l.from,
        to: l.to,
        distanceKm: Number(l.distanceKm),
      })),
      extras,
    };
  }
  return {
    product: 'private',
    vehicle: req.vehicle,
    pax: req.pax,
    bags: req.bags,
    legs: driving.map((l) => ({ from: l.from, to: l.to, distanceKm: Number(l.distanceKm) })),
    extras,
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
  return LEG_TYPES[l.type || 'transfer']?.drives ? `${l.from} → ${l.to}` : `Stay in ${l.from || l.to}`;
}

function whatsappDraft(name: string, req: ToolRequest, result: QuoteResult): string {
  
  const lines = req.legs
    .filter((l) => LEG_TYPES[l.type || 'transfer']?.drives)
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
    .filter((l) => LEG_TYPES[l.type || 'transfer']?.drives)
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
    .filter((l) => LEG_TYPES[l.type || 'transfer']?.drives)
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

export function internalQuoteRoutes(deps: { maps: MapsAdapter; googleKey?: string; quotes: QuoteRepo }) {
  const r = new Hono();

  r.get('/', (c) => c.html(toolHtml()));

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
    if (!body || !Array.isArray(body.legs) || body.legs.length === 0) {
      return c.json({ error: 'add at least one leg' }, 400);
    }
    const driving = body.legs.filter((l) => LEG_TYPES[l.type || 'transfer']?.drives);
    if (driving.length === 0) return c.json({ error: 'add at least one travel leg (a stay day alone has no transfer)' }, 400);
    for (const l of driving) {
      if (!l.distanceKm || Number(l.distanceKm) <= 0) {
        const d = await deps.maps.distance(l.from, l.to);
        if (d) l.distanceKm = d.km;
        else return c.json({ error: `couldn't find the distance for ${l.from || '?'} → ${l.to || '?'} — enter the km manually` }, 400);
      }
    }
    try {
      const req = toEngineRequest(body);
      const result = quote(req);

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
        comparison,
        drafts: {
          whatsapp: whatsappDraft(body.name ?? '', body, result),
          email: emailDraft(body.name ?? '', body, result),
          notion: notionDraft(body, result),
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'could not price this trip';
      return c.json({ error: msg }, 422);
    }
  });

  return r;
}
