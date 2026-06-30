import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { quote } from '../quote/engine';
import { RATE_CARD } from '../quote/rateCard';
import type { QuoteRequest, QuoteResult } from '../quote/types';
import type { ExtraCode, Vehicle } from '../quote/rateCard';

// The single-page tool UI (served same-origin so it can call /admin/quote/estimate without CORS).
const HTML = readFileSync(fileURLToPath(new URL('./quote-tool.html', import.meta.url)), 'utf8');

interface ToolLeg {
  date?: string;
  from: string;
  to: string;
  distanceKm: number;
  keepCarDriver?: boolean;
  sightseeing?: boolean;
  waiting?: boolean;
}
interface ToolRequest {
  product: 'private' | 'chauffeur';
  vehicle: Vehicle;
  pax: number;
  bags: number;
  legs: ToolLeg[];
  firstDate?: string;
  lastDate?: string;
}

const fxRate = RATE_CARD.fxUsdToLkr;
const toLkr = (cents: number): number => Math.round((cents * fxRate) / 100);
const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
const lkr = (cents: number): string => `LKR ${toLkr(cents).toLocaleString('en-US')}`;

function legExtras(legs: ToolLeg[]): ExtraCode[] {
  const out: ExtraCode[] = [];
  for (const l of legs) {
    if (l.sightseeing) out.push('sightseeing');
    if (l.waiting) out.push('waiting');
  }
  return out;
}

// Build the engine QuoteRequest from the tool's itinerary. Mapping rule (issue I12):
// any "keep car + driver" leg -> the whole trip is one chauffeur request; else N private legs.
function toEngineRequest(req: ToolRequest): QuoteRequest {
  const extras = legExtras(req.legs);
  const isChauffeur = req.product === 'chauffeur' || req.legs.some((l) => l.keepCarDriver);
  if (isChauffeur) {
    const dates = req.legs.map((l) => l.date).filter(Boolean) as string[];
    const firstDate = req.firstDate || dates[0];
    const lastDate = req.lastDate || dates[dates.length - 1] || firstDate;
    if (!firstDate || !lastDate) throw new Error('chauffeur needs a trip start and end date');
    return {
      product: 'chauffeur',
      vehicle: req.vehicle,
      firstDate,
      lastDate,
      travelDays: req.legs.map((l) => ({
        date: l.date || firstDate,
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
    legs: req.legs.map((l) => ({ from: l.from, to: l.to, distanceKm: Number(l.distanceKm) })),
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
    rateCardVersion: result.rateCardVersion,
    lineItems: result.lineItems.map((li) => ({ label: li.label, usd: usd(li.amountCents), lkr: lkr(li.amountCents) })),
  };
}

function whatsappDraft(name: string, result: QuoteResult): string {
  const lines = result.lineItems.map((li) => `• ${li.label} — ${lkr(li.amountCents)}`).join('\n');
  const due =
    result.product === 'chauffeur'
      ? `\nDeposit to confirm: ${lkr(result.amountDueNowCents)} (balance on/after the trip).`
      : '';
  return (
    `Hi ${name || 'there'}, thanks for the details! Here's your quote:\n\n` +
    `${lines}\n\n` +
    `Total: ${lkr(result.totalCents)} (~${usd(result.totalCents)})${due}\n\n` +
    `This is a private ${result.product} service including fuel, driver, tolls, and door-to-door pickup. ` +
    `Let me know if you'd like to proceed. 🚗`
  );
}

export function internalQuoteRoutes() {
  const r = new Hono();

  // The tool page.
  r.get('/', (c) => c.html(HTML));

  // Itinerary -> engine -> LKR/USD + drafts + car/van comparison.
  r.post('/estimate', async (c) => {
    const body = (await c.req.json().catch(() => null)) as ToolRequest | null;
    if (!body || !Array.isArray(body.legs) || body.legs.length === 0) {
      return c.json({ error: 'add at least one leg with a distance' }, 400);
    }
    for (const l of body.legs) {
      if (!l.distanceKm || Number(l.distanceKm) <= 0) {
        return c.json({ error: `enter a distance for ${l.from || '?'} → ${l.to || '?'}` }, 400);
      }
    }
    try {
      const req = toEngineRequest(body);
      const result = quote(req);

      // Car vs van comparison (same trip, both vehicles) — for the private/chauffeur paths.
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
        whatsapp: whatsappDraft((body as ToolRequest & { name?: string }).name ?? '', result),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'could not price this trip';
      return c.json({ error: msg }, 422);
    }
  });

  return r;
}
