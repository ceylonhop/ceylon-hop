import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { quote } from '../quote/engine';
import { RATE_CARD } from '../quote/rateCard';
import type { QuoteRequest, QuoteResult } from '../quote/types';
import type { ExtraCode, Vehicle } from '../quote/rateCard';

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

export function internalQuoteRoutes() {
  const r = new Hono();

  r.get('/', (c) => c.html(toolHtml()));

  r.post('/estimate', async (c) => {
    const body = (await c.req.json().catch(() => null)) as ToolRequest | null;
    if (!body || !Array.isArray(body.legs) || body.legs.length === 0) {
      return c.json({ error: 'add at least one leg' }, 400);
    }
    const driving = body.legs.filter((l) => LEG_TYPES[l.type || 'transfer']?.drives);
    if (driving.length === 0) return c.json({ error: 'add at least one travel leg (a stay day alone has no transfer)' }, 400);
    for (const l of driving) {
      if (!l.distanceKm || Number(l.distanceKm) <= 0) {
        return c.json({ error: `set a distance for ${l.from || '?'} → ${l.to || '?'}` }, 400);
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
