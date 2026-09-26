import { Hono } from 'hono';
import { z } from 'zod';
import { quote } from '../quote/engine';
import type { QuoteRequest } from '../quote/types';
import { EXTRA_CODES, RATE_CARD } from '../quote/rateCard';
import { rateLockUntil } from '../quote/rateLock';
import type { QuoteRepo } from '../db/quoteRepo';
import type { MapsAdapter } from '../adapters/maps';
import { isCatalogTown } from '../adapters/maps';
import { memoizeDistance } from './bookings';
import type { RateCard } from '../quote/rateCard';
import { InMemoryZonesRepo, type ZonesRepo } from '../db/zonesRepo';
import { InMemoryRateRevisionRepo, type RateRevisionRepo } from '../db/rateRevisionRepo';
import { liveRateCard } from '../quote/liveCard';
import { stripZoneMeta } from '../quote/stripZoneMeta';
import {
  WebQuoteIntentSchema,
  digestAccessToken,
  fingerprintIntent,
  safeDigestEqual,
  type WebQuoteIntent,
} from '../quote/webQuoteV2';
import { randomBytes } from 'node:crypto';
import type { BookingRepo } from '../db/bookingRepo';
import type { PromoCodeRepo } from '../db/promoCodeRepo';
import {
  normalizePromoCode,
  promoCodeAvailability,
  promoDiscountRequest,
  type PromoCode,
  type PromoCodeErrorCode,
} from '../domain/promoCode';

const ExtraCode = z.enum(EXTRA_CODES);
const ENGINE_ERRORS = new Set(['TOO_BIG', 'UNKNOWN_EXTRA', 'NO_LEGS']);

const QuoteSchema = z.discriminatedUnion('product', [
  z.object({
    product: z.literal('shared'),
    legs: z.array(z.object({
      routeId: z.string().min(1), seats: z.number().int().min(1),
      seatPriceCents: z.number().int().min(0), colomboPickup: z.boolean().optional(),
    })).min(1),
  }),
  z.object({
    product: z.literal('private'),
    vehicle: z.enum(['car', 'van', 'van9', 'van14', 'custom']), pax: z.number().int().min(1), bags: z.number().int().min(0),
    legs: z.array(z.object({ from: z.string().min(1), to: z.string().min(1), distanceKm: z.number().min(0) })).min(1),
    extras: z.array(ExtraCode).optional(),
  }),
  z.object({
    product: z.literal('chauffeur'),
    vehicle: z.enum(['car', 'van', 'van9', 'van14', 'custom']), firstDate: z.string().min(1), lastDate: z.string().min(1),
    travelDays: z.array(z.object({ date: z.string().min(1), from: z.string().min(1), to: z.string().min(1), distanceKm: z.number().min(0) })).min(1),
    extras: z.array(ExtraCode).optional(),
  }),
]);

const V2UpdateSchema = z.object({
  revision: z.number().int().min(1),
  intent: WebQuoteIntentSchema,
}).strict();

export interface ResolvedLeg { from: string; to: string; distanceKm: number; durationMin: number }
export interface ResolvedIntent { request: QuoteRequest; estimated: boolean; legs: ResolvedLeg[] }

export async function engineRequestFor(
  intent: WebQuoteIntent,
  maps: MapsAdapter,
): Promise<ResolvedIntent | null> {
  if (intent.product === 'private') {
    const resolved = await Promise.all(
      intent.legs.map(async (leg) => ({ leg, distance: await maps.distance(leg.from, leg.to) })),
    );
    if (resolved.some(({ distance }) => !distance)) return null;
    const estimated = resolved.some(({ distance }) => distance!.estimated === true);
    const legs: ResolvedLeg[] = resolved.map(({ leg, distance }) => ({
      from: leg.from,
      to: leg.to,
      distanceKm: distance!.km,
      durationMin: distance!.durationMin,
    }));
    return {
      estimated,
      legs,
      request: {
        product: 'private',
        vehicle: intent.vehicle,
        pax: intent.pax,
        bags: intent.bags,
        legs: legs.map(({ from, to, distanceKm }) => ({ from, to, distanceKm })),
        extras: intent.extras,
      },
    };
  }
  const resolved = await Promise.all(
    intent.travelDays.map(async (day) => ({ day, distance: await maps.distance(day.from, day.to) })),
  );
  if (resolved.some(({ distance }) => !distance)) return null;
  const estimated = resolved.some(({ distance }) => distance!.estimated === true);
  const legs: ResolvedLeg[] = resolved.map(({ day, distance }) => ({
    from: day.from,
    to: day.to,
    distanceKm: distance!.km,
    durationMin: distance!.durationMin,
  }));
  return {
    estimated,
    legs,
    request: {
      product: 'chauffeur',
      vehicle: intent.vehicle,
      pax: intent.pax,
      bags: intent.bags,
      firstDate: intent.firstDate,
      lastDate: intent.lastDate,
      travelDays: resolved.map(({ day, distance }) => ({
        date: day.date,
        from: day.from,
        to: day.to,
        distanceKm: distance!.km,
      })),
      extras: intent.extras,
    },
  };
}

// D9: the founder-only "Ella premium +15%" zone annotation (meta.hotZone) is a margin-class
// disclosure, same as marginEstimateCents above — strip it from every line item before a result
// reaches an unauthenticated customer. internalQuote.ts strips the same field for non-margin:view
// ops roles via the same stripZoneMeta().
function publicLineItems(lineItems: ReturnType<typeof quote>['lineItems']) {
  return lineItems.map((li) => ({ ...li, meta: stripZoneMeta(li.meta) }));
}

function publicV2(saved: Awaited<ReturnType<QuoteRepo['get']>>, result: ReturnType<typeof quote>) {
  if (!saved) throw new Error('quote_not_saved');
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { marginEstimateCents, ...pub } = result;
  return {
    quoteId: saved.id,
    reference: saved.reference,
    revision: saved.revision,
    expiresAt: saved.rateLockedUntil,
    ...pub,
    lineItems: publicLineItems(pub.lineItems),
  };
}

export function quoteRoutes(deps: {
  internalKey?: string;
  quotes?: QuoteRepo;
  maps?: MapsAdapter;
  v2Enabled?: boolean;
  now?: () => Date;
  zones?: ZonesRepo;
  rateRevisions?: RateRevisionRepo;
  promoCodes?: PromoCodeRepo;
  bookings?: BookingRepo; // read-only here: the preview counts uses, it never takes one
  promoCodesEnabled?: boolean;
  promoNow?: () => Date;
} = {}) {
  // No repo injected => an empty in-memory one => zero active zones => pricing identical to today.
  const zonesRepo = deps.zones ?? new InMemoryZonesRepo();
  // No revisions repo injected ⇒ an empty one ⇒ the code card (spec 2026-09-26 §8.2).
  const revisionsRepo = deps.rateRevisions ?? new InMemoryRateRevisionRepo();
  const liveCard = (): Promise<RateCard> => liveRateCard(zonesRepo, revisionsRepo);

  // §6.4 — resolve a code for a PREVIEW. A plain read with no lock: it can say "used up", but a code
  // that previews fine can still be taken by someone else before the customer books.
  async function previewPromo(raw: unknown): Promise<{ code: PromoCode } | { error: PromoCodeErrorCode }> {
    const normalized = normalizePromoCode(raw);
    if (!deps.promoCodesEnabled || !deps.promoCodes || !normalized) return { error: 'promo_code_invalid' };
    const code = await deps.promoCodes.getByCode(normalized);
    if (!code) return { error: 'promo_code_invalid' };
    const now = (deps.promoNow ?? (() => new Date()))();
    const unavailable = promoCodeAvailability(code, now);
    if (unavailable) return { error: unavailable };
    if (deps.bookings) {
      const { paid, held } = await deps.bookings.promoUsage(code.id, now);
      if (paid + held >= code.maxUses) return { error: 'promo_code_used_up' };
    }
    return { code };
  }

  const r = new Hono();
  r.post('/', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = QuoteSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    try {
      const result = quote(parsed.data as QuoteRequest, await liveCard());
      const isInternal = !!deps.internalKey && c.req.header('x-internal-key') === deps.internalKey;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { marginEstimateCents, ...pub } = result;
      return c.json(isInternal ? result : { ...pub, lineItems: publicLineItems(pub.lineItems) }, 200);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'BAD_REQUEST';
      return c.json({ error: ENGINE_ERRORS.has(msg) ? msg : 'BAD_REQUEST' }, 422);
    }
  });

  // Rate-lock (spec 2026-07-11 §5): commit a customer-facing quote. Prices the itinerary against
  // the CURRENT card and persists a channel='web' quote carrying that card as a snapshot, held for
  // 7 days. Returns a quote id the customer can book against (POST /bookings/* with quoteId) or
  // return to within the window — the booking then prices with this locked card, so a rate-card
  // change under the hood can't move the price the customer was quoted. Margin is never returned.
  r.post('/lock', async (c) => {
    if (!deps.quotes) return c.json({ error: 'not_available' }, 501);
    const body = await c.req.json().catch(() => null);
    const parsed = QuoteSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    try {
      const req = parsed.data as QuoteRequest;
      const card = await liveCard();
      const result = quote(req, card);
      const saved = await deps.quotes.save({
        channel: 'web',
        product: req.product,
        vehicle: 'vehicle' in req ? req.vehicle : null,
        totalCents: result.totalCents,
        currency: RATE_CARD.currency,
        rateCardVersion: card.version,
        marginCents: result.marginEstimateCents ?? null,
        request: { engine: req },
        result,
        rateCardJson: card,
        rateLockedUntil: rateLockUntil(new Date()),
      });
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { marginEstimateCents, ...pub } = result;
      return c.json({ quoteId: saved.id, reference: saved.reference, rateLockedUntil: saved.rateLockedUntil, ...pub, lineItems: publicLineItems(pub.lineItems) }, 201);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'BAD_REQUEST';
      return c.json({ error: ENGINE_ERRORS.has(msg) ? msg : 'BAD_REQUEST' }, 422);
    }
  });

  // Price an intent WITHOUT persisting anything — the customer-side twin of the ops tool's
  // /estimate (vs /save). Rendering a price must never write a quotes row. Unlike /v2/lock this
  // will return a price built on an estimated distance, flagged so the page can label it and
  // checkout can refuse it.
  r.post('/v2/estimate', async (c) => {
    if (!deps.v2Enabled) return c.notFound();
    if (!deps.maps) return c.json({ error: 'not_available' }, 501);
    const raw = await c.req.json().catch(() => null);
    // WebQuoteIntentSchema is .strict(), so a promo code is lifted off the body before the intent is
    // parsed (spec 2026-09-14 §6.4). Every other unknown field is still refused.
    let rawPromo: unknown;
    let intentBody: unknown = raw;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const { promoCode, ...rest } = raw as Record<string, unknown>;
      rawPromo = promoCode;
      intentBody = rest;
    }
    const parsed = WebQuoteIntentSchema.safeParse(intentBody);
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    const resolved = await engineRequestFor(parsed.data, deps.maps);
    if (!resolved) return c.json({ error: 'quote_unpriced' }, 422);
    try {
      const card = await liveCard();
      const result = quote(resolved.request, card);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { marginEstimateCents, ...pub } = result;
      let promoCode: Record<string, unknown> | undefined;
      if (rawPromo !== undefined && rawPromo !== null && rawPromo !== '') {
        const promo = await previewPromo(rawPromo);
        if ('error' in promo) {
          promoCode = { error: promo.error };
        } else {
          const discounted = quote(resolved.request, card, promoDiscountRequest(promo.code));
          // A booking refuses an estimated distance, so a preview on one must not promise a discount.
          promoCode = !resolved.estimated && (discounted.discountCents ?? 0) > 0
            ? {
                code: promo.code.code,
                discountCents: discounted.discountCents,
                totalBeforeDiscountCents: discounted.totalBeforeDiscountCents,
                totalCents: discounted.totalCents,
              }
            : { error: 'promo_code_not_eligible' };
        }
      }
      return c.json({
        ...pub,
        lineItems: publicLineItems(pub.lineItems),
        estimated: resolved.estimated,
        legs: resolved.legs,
        ...(promoCode ? { promoCode } : {}),
      }, 200);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'BAD_REQUEST';
      return c.json({ error: ENGINE_ERRORS.has(msg) ? msg : 'BAD_REQUEST' }, 422);
    }
  });

  // Many list prices in ONE request (spec 2026-09-21 §6.1): the /trip/ index and "where next"
  // cards advertise the engine's fare, and ch-pricing can only ask one intent at a time.
  // Each intent takes the SAME path as /v2/estimate — engineRequestFor → quote() on the live card —
  // so a list price and the page it links to cannot disagree. Two deliberate differences:
  //   • only catalogue-town legs are priced. Those are the pairs CachedMapsAdapter persists, so
  //     across requests a catalogue pair costs at most one billed distance call, EVER. Anything
  //     else is null — this endpoint must not become a way to fan 60 arbitrary addresses out to
  //     Google.
  //   • an estimated distance is null, not flagged: a list has nowhere to put the caveat.
  // One bad intent never fails the batch; the page keeps its catalogue figure for that row.
  // WITHIN one request, two intents can share a (from,to) pair (the same corridor priced for
  // car and for van) — under Promise.all both would otherwise race a cold cache miss and each
  // bill their own lookup. memoizeDistance (bookings.ts's per-request de-duper, reused as-is)
  // wraps deps.maps once per batch so every engineRequestFor call below shares one in-flight
  // lookup per distinct pair, coalescing concurrent — not just sequential — duplicates.
  const BatchSchema = z.object({ intents: z.array(z.unknown()).min(1).max(60) }).strict();
  r.post('/v2/estimate-batch', async (c) => {
    if (!deps.v2Enabled) return c.notFound();
    if (!deps.maps) return c.json({ error: 'not_available' }, 501);
    const envelope = BatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!envelope.success) return c.json({ error: 'invalid_request', details: envelope.error.flatten() }, 400);
    const maps = memoizeDistance(deps.maps);
    const card = await liveCard();
    const results = await Promise.all(envelope.data.intents.map(async (raw) => {
      try {
        const parsed = WebQuoteIntentSchema.safeParse(raw);
        if (!parsed.success || parsed.data.product !== 'private') return null;
        if (!parsed.data.legs.every((l) => isCatalogTown(l.from) && isCatalogTown(l.to))) return null;
        const resolved = await engineRequestFor(parsed.data, maps);
        if (!resolved || resolved.estimated) return null;
        const result = quote(resolved.request, card);
        return { totalCents: result.totalCents, currency: result.currency };
      } catch {
        return null;
      }
    }));
    return c.json({ results }, 200);
  });

  r.post('/v2/lock', async (c) => {
    if (!deps.v2Enabled) return c.notFound();
    if (!deps.quotes || !deps.maps) return c.json({ error: 'not_available' }, 501);
    const parsed = WebQuoteIntentSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    const resolved = await engineRequestFor(parsed.data, deps.maps);
    // A LOCK is a commitment, so it still refuses an estimated distance — only /estimate may show one.
    if (!resolved || resolved.estimated) return c.json({ error: 'quote_unpriced' }, 422);
    const engineRequest = resolved.request;
    try {
      const card = await liveCard();
      const result = quote(engineRequest, card);
      const now = deps.now?.() ?? new Date();
      const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const accessToken = randomBytes(32).toString('base64url');
      const saved = await deps.quotes.save({
        channel: 'web',
        product: engineRequest.product,
        vehicle: 'vehicle' in engineRequest ? engineRequest.vehicle : null,
        totalCents: result.totalCents,
        currency: RATE_CARD.currency,
        rateCardVersion: card.version,
        marginCents: result.marginEstimateCents ?? null,
        request: { v: 2, intent: parsed.data, engine: engineRequest },
        result,
        rateCardJson: card,
        rateLockedUntil: expiresAt,
        intent: parsed.data,
        intentFingerprint: fingerprintIntent(parsed.data),
        revision: 1,
        accessTokenDigest: digestAccessToken(accessToken),
      });
      return c.json({ ...publicV2(saved, result), accessToken }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'BAD_REQUEST';
      return c.json({ error: ENGINE_ERRORS.has(message) ? message : 'BAD_REQUEST' }, 422);
    }
  });

  r.put('/v2/:id', async (c) => {
    if (!deps.v2Enabled) return c.notFound();
    if (!deps.quotes || !deps.maps) return c.json({ error: 'not_available' }, 501);
    const authorization = c.req.header('authorization') ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!token) return c.json({ error: 'quote_access_denied' }, 403);
    const parsed = V2UpdateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    const existing = await deps.quotes.get(c.req.param('id'));
    const tokenDigest = digestAccessToken(token);
    if (
      !existing ||
      existing.channel !== 'web' ||
      !existing.accessTokenDigest ||
      !safeDigestEqual(existing.accessTokenDigest, tokenDigest)
    ) {
      return c.json({ error: 'quote_access_denied' }, 403);
    }
    if (existing.convertedBookingId) {
      return c.json({ error: 'quote_already_converted' }, 409);
    }
    const now = deps.now?.() ?? new Date();
    if (!existing.rateLockedUntil || existing.rateLockedUntil <= now) {
      return c.json({ error: 'quote_expired' }, 409);
    }
    if (existing.revision !== parsed.data.revision) {
      return c.json({ error: 'stale_revision' }, 409);
    }
    const resolved = await engineRequestFor(parsed.data.intent, deps.maps);
    // An UPDATE re-prices a locked quote, so it stays a commitment too — refuse an estimated distance.
    if (!resolved || resolved.estimated) return c.json({ error: 'quote_unpriced' }, 422);
    const engineRequest = resolved.request;
    try {
      const lockedRateCard = existing.rateCardJson as RateCard;
      const result = quote(engineRequest, lockedRateCard);
      const updated = await deps.quotes.updateWebV2({
        id: existing.id,
        accessTokenDigest: tokenDigest,
        expectedRevision: parsed.data.revision,
        now,
        quote: {
          channel: 'web',
          product: engineRequest.product,
          vehicle: 'vehicle' in engineRequest ? engineRequest.vehicle : null,
          totalCents: result.totalCents,
          currency: existing.currency,
          rateCardVersion: existing.rateCardVersion,
          marginCents: result.marginEstimateCents ?? null,
          request: { v: 2, intent: parsed.data.intent, engine: engineRequest },
          result,
          intent: parsed.data.intent,
          intentFingerprint: fingerprintIntent(parsed.data.intent),
        },
      });
      if (updated.kind === 'access_denied') return c.json({ error: 'quote_access_denied' }, 403);
      if (updated.kind === 'converted') return c.json({ error: 'quote_already_converted' }, 409);
      if (updated.kind === 'expired') return c.json({ error: 'quote_expired' }, 409);
      if (updated.kind === 'stale_revision') return c.json({ error: 'stale_revision' }, 409);
      if (!('quote' in updated)) throw new Error('quote_update_outcome_invalid');
      return c.json(publicV2(updated.quote, result), 200);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'BAD_REQUEST';
      return c.json({ error: ENGINE_ERRORS.has(message) ? message : 'BAD_REQUEST' }, 422);
    }
  });
  return r;
}
