import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createApp } from '../app';
import { internalQuoteRoutes } from './internalQuote';
import { FakeMapsAdapter } from '../adapters/maps';
import { InMemoryQuoteRepo } from '../db/quoteRepo';
import { signSession } from '../lib/opsAuth';

type App = ReturnType<typeof createApp>;
function post(app: App, path: string, body: unknown) {
  return app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
const leg = (o: Record<string, unknown>) => ({ category: 'transfer', from: 'A', to: 'B', ...o });

describe('internal quoting tool route', () => {
  it('GET /places filters the offline known-place list', async () => {
    const res = await createApp().request('/admin/quote/places?q=kand');
    expect(res.status).toBe(200);
    expect((await res.json()).places).toEqual(['Kandy']);
  });

  it('GET /places returns [] for a too-short query', async () => {
    expect((await (await createApp().request('/admin/quote/places?q=k')).json()).places).toEqual([]);
  });

  it('POST /distance returns km + duration for known places', async () => {
    const res = await post(createApp(), '/admin/quote/distance', { from: 'Colombo City', to: 'Kandy' });
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.km).toBeGreaterThan(0);
    expect(d.durationMin).toBeGreaterThan(0);
  });

  it('POST /distance is 404 for an unknown route', async () => {
    const res = await post(createApp(), '/admin/quote/distance', { from: 'Nowhereville', to: 'Kandy' });
    expect(res.status).toBe(404);
  });

  it('estimate prices a private leg from a manual km (80km car = 4048¢); no drafts; lineItems carry cents', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', {
      name: 'Test', vehicle: 'car', passengerCount: 2, luggageCount: 2, legs: [leg({ distanceKm: 80 })],
    });
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.total.cents).toBe(4048);
    expect(d.amountDueNow.cents).toBe(4048); // private → full
    expect(d.drafts).toBeUndefined(); // V15: dead drafts removed
    expect(Number.isInteger(d.lineItems[0].amountCents)).toBe(true); // Fix 7: cents on line items
    expect(d.lineItems[0].meta.billableKm).toBe(88); // meta passthrough — client zips travel items with legs
    expect(d.comparison).toBeUndefined(); // reflow: car/van comparison removed
    // reflow: services chooser replaces comparison. Single undated leg → chauffeur infeasible.
    expect(d.services.pointToPoint.total.cents).toBe(4048);
    expect(d.services.chauffeur.error).toBeTruthy();
  });

  it('an empty-string date on an undated private leg is treated as absent, not invalid', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', {
      vehicle: 'car', passengerCount: 2, luggageCount: 2, legs: [leg({ distanceKm: 80, date: '' })],
    });
    expect(res.status).toBe(200); // regression: the tool always sends date:'' for undated legs
  });

  it('estimate auto-resolves the distance from known places when km is omitted', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', {
      vehicle: 'car', passengerCount: 2, luggageCount: 2, legs: [{ category: 'transfer', from: 'Colombo City', to: 'Kandy' }],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).total.cents).toBeGreaterThan(0);
  });

  it('estimate is 400 when distance is unknown and no manual km is given', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', {
      vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [{ category: 'transfer', from: 'Nowhereville', to: 'Kandy' }],
    });
    expect(res.status).toBe(400);
  });

  it('estimate is 400 with no legs', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', { vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [] });
    expect(res.status).toBe(400);
  });

  it('estimate is 400 with only a stay day (no travel leg)', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', {
      vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [{ category: 'stay_day', from: 'Kandy', to: '', date: '2026-02-15' }],
    });
    expect(res.status).toBe(400);
  });

  it('addSightseeingFee toggle adds the $10 sightseeing extra vs a plain transfer', async () => {
    const base = await (await post(createApp(), '/admin/quote/estimate', { vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [leg({ distanceKm: 80 })] })).json();
    const withS = await (await post(createApp(), '/admin/quote/estimate', { vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [leg({ distanceKm: 80, addSightseeingFee: true })] })).json();
    expect(withS.total.cents).toBe(base.total.cents + 1000);
  });

  it('POST /save persists a priced quote and returns a Q- reference; total matches /estimate', async () => {
    const app = createApp();
    const bodyReq = { name: 'Maya', contact: '+34600', vehicle: 'car', passengerCount: 2, luggageCount: 2, legs: [leg({ distanceKm: 80 })] };
    const est = await (await post(app, '/admin/quote/estimate', bodyReq)).json();
    const res = await post(app, '/admin/quote/save', bodyReq);
    expect(res.status).toBe(201);
    const saved = await res.json();
    expect(saved.reference).toMatch(/^Q-[A-HJ-NP-Z2-9]{5}$/); // 5 chars, unambiguous alphabet (no 0/O/1/I)
    expect(saved.status).toBe('draft');
    const got = await (await app.request(`/admin/quote/${saved.id}`)).json();
    expect(got.totalCents).toBe(est.total.cents); // saved total == previewed total
    expect(got.customerName).toBe('Maya');
    expect(got.rateCardVersion).toBe('2026-07-02');
  });

  it('POST /save re-prices server-side and ignores any client-supplied total', async () => {
    const app = createApp();
    const res = await post(app, '/admin/quote/save', {
      vehicle: 'car', passengerCount: 1, luggageCount: 0, total: 999999, totalCents: 999999, legs: [leg({ distanceKm: 80 })],
    });
    const saved = await res.json();
    const got = await (await app.request(`/admin/quote/${saved.id}`)).json();
    expect(got.totalCents).toBe(4048); // engine price, not the bogus client total
  });

  it('POST /save is 400 for an unpriceable trip (no travel leg)', async () => {
    const res = await post(createApp(), '/admin/quote/save', {
      vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [{ category: 'stay_day', from: 'Kandy', to: '' }],
    });
    expect(res.status).toBe(400); // stay-day-only → no travel leg
  });

  const patch = (app: App, path: string, body: unknown) =>
    app.request(path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('GET /list returns saved quotes newest-first and filters by status/product', async () => {
    const app = createApp();
    const a = await (await post(app, '/admin/quote/save', { vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [leg({ distanceKm: 80 })] })).json();
    await new Promise((r) => setTimeout(r, 5)); // distinct createdAt — same-ms ties order by reference, not insertion
    const b = await (await post(app, '/admin/quote/save', { vehicle: 'van_6', passengerCount: 1, luggageCount: 0, legs: [leg({ distanceKm: 80 })] })).json();
    const list = await (await app.request('/admin/quote/list')).json();
    expect(list.quotes[0].id).toBe(b.id); // newest first
    await patch(app, `/admin/quote/${a.id}`, { status: 'won' });
    const won = await (await app.request('/admin/quote/list?status=won')).json();
    expect(won.quotes.map((q: { id: string }) => q.id)).toEqual([a.id]);
  });

  it('PATCH /:id moves status, stamps timestamps, records lost_reason; 404 unknown; 400 bad status', async () => {
    const app = createApp();
    const q = await (await post(app, '/admin/quote/save', { vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [leg({ distanceKm: 80 })] })).json();
    const sent = await (await patch(app, `/admin/quote/${q.id}`, { status: 'sent' })).json();
    expect(sent.status).toBe('sent');
    expect(sent.sentAt).not.toBeNull();
    const lost = await (await patch(app, `/admin/quote/${q.id}`, { status: 'lost', lostReason: 'too expensive' })).json();
    expect(lost.decidedAt).not.toBeNull();
    expect(lost.lostReason).toBe('too expensive');
    expect((await patch(app, '/admin/quote/00000000-0000-0000-0000-000000000000', { status: 'won' })).status).toBe(404);
    expect((await patch(app, `/admin/quote/${q.id}`, { status: 'bogus' })).status).toBe(400);
  });

  it('accepts an injected QuoteRepo without breaking existing routes', async () => {
    const app = createApp({ quotes: new InMemoryQuoteRepo() });
    const res = await app.request('/admin/quote/places?q=kand');
    expect((await res.json()).places).toEqual(['Kandy']);
  });

  it('chauffeur: stay days become idle days; amountDueNow is the capped deposit', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', {
      vehicle: 'car', passengerCount: 2, luggageCount: 1, legs: [
        { category: 'transfer', from: 'Airport', to: 'Kandy', distanceKm: 120, date: '2026-02-14' },
        { category: 'stay_day', from: 'Kandy', to: '', date: '2026-02-15' },
        { category: 'transfer', from: 'Kandy', to: 'Ella', distanceKm: 140, date: '2026-02-16' },
      ],
    });
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.product).toBe('chauffeur');
    expect(d.amountDueNow.cents).toBe(d.deposit.cents); // chauffeur pays the deposit now
    expect(d.deposit.cents).toBeLessThanOrEqual(5000); // cap
  });

  it('derives chauffeur when a leg has a stay day (no explicit service)', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', {
      vehicle: 'car', passengerCount: 2, luggageCount: 1, legs: [
        { category: 'transfer', from: 'Airport', to: 'Kandy', distanceKm: 120, date: '2026-02-14' },
        { category: 'stay_day', from: 'Kandy', to: 'Kandy', date: '2026-02-15' },
        { category: 'transfer', from: 'Kandy', to: 'Ella', distanceKm: 140, date: '2026-02-16' },
      ],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).product).toBe('chauffeur');
  });

  it('a plain transfer itinerary is private', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', {
      vehicle: 'van_6', passengerCount: 4, luggageCount: 4, legs: [{ category: 'transfer', from: 'Kandy', to: 'Ella', distanceKm: 140 }],
    });
    const d = await res.json();
    expect(d.product).toBe('private');
    expect(d.total.cents).toBe(12782); // van 140km
  });

  it('sightseeing/waiting/safari-wait toggles add engine extras on a private trip', async () => {
    const base = await (await post(createApp(), '/admin/quote/estimate', { vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [{ category: 'transfer', from: 'A', to: 'B', distanceKm: 80 }] })).json();
    const withFees = await (await post(createApp(), '/admin/quote/estimate', { service: 'private', vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [{ category: 'transfer', from: 'A', to: 'B', distanceKm: 80, addSightseeingFee: true, addWaitingFee: true, addSafariWait: true }] })).json();
    expect(withFees.total.cents).toBe(base.total.cents + 1000 + 1000 + 1900); // sightseeing $10 + waiting $10 + safari-wait $19
  });

  it('van_9/van_14/custom are no longer gated — they price correctly (200, total > 0)', async () => {
    const cases: Array<{ vehicle: string; pax: number; expectedPerKmCents: number }> = [
      { vehicle: 'van_9',  pax: 8,  expectedPerKmCents: 55 }, // 154 billableKm × 55¢ = 8470
      { vehicle: 'van_14', pax: 12, expectedPerKmCents: 130 }, // 154 × 130¢ = 20020
      { vehicle: 'custom', pax: 20, expectedPerKmCents: 175 }, // 154 × 175¢ = 26950
    ];
    for (const { vehicle, pax, expectedPerKmCents } of cases) {
      const res = await post(createApp(), '/admin/quote/estimate', {
        vehicle, passengerCount: pax, luggageCount: 2,
        legs: [{ category: 'transfer', from: 'A', to: 'B', distanceKm: 140 }],
      });
      expect(res.status).toBe(200);
      const d = await res.json();
      expect(d.total.cents).toBe(154 * expectedPerKmCents); // 140km → 154 billableKm
      expect(d.total.cents).toBeGreaterThan(0);
    }
  });

  it('estimate includes a breakdown (km strip + per-leg prices)', async () => {
    const d = await (await post(createApp(), '/admin/quote/estimate', { vehicle: 'van_6', passengerCount: 4, luggageCount: 4, legs: [{ category: 'transfer', from: 'Kandy', to: 'Ella', distanceKm: 140 }] })).json();
    expect(d.breakdown.km).toEqual({ distanceKm: 140, bufferKm: 14, billableKm: 154 });
    expect(d.breakdown.legs[0].priceCents).toBe(12782);
  });

  it('GET /rate-card returns the locked rate card for the read-only Settings (all 5 tiers) + vehicle caps', async () => {
    const d = await (await createApp().request('/admin/quote/rate-card')).json();
    expect(d.version).toBe('2026-07-02');
    expect(d.perKmCents).toMatchObject({ car: 46, van: 83, van9: 55, van14: 130, custom: 175 });
    expect(d.floorCents).toMatchObject({ car: 2900, van: 5000, van9: 5000, van14: 8500, custom: 11000 });
    expect(d.chauffeurDayRateCents).toBe(3500);
    expect(d.fxUsdToLkr).toBe(320);
    // V12 server half: expose vehicle capacity caps for client-side vehicle labelling
    expect(d.vehicle).toMatchObject({
      car: { maxPax: 3, maxBags: 3 },
      van: { maxPax: 6, maxBags: 6 },
      van9: { maxPax: 9, maxBags: 8 },
      van14: { maxPax: 14, maxBags: 12 },
      custom: { maxPax: 99, maxBags: 99 },
    });
  });

  // Fix 1 (V18): Zod validation on /estimate.
  it('estimate is 400 when passengerCount is 0', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', { vehicle: 'car', passengerCount: 0, luggageCount: 0, legs: [leg({ distanceKm: 80 })] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeTruthy();
  });

  it('estimate is 400 when passengerCount is missing', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', { vehicle: 'car', luggageCount: 0, legs: [leg({ distanceKm: 80 })] });
    expect(res.status).toBe(400);
  });

  it('estimate is 400 with a Zod-rejected empty legs array', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', { vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [] });
    expect(res.status).toBe(400);
  });

  it('estimate is 400 for a bad leg category', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', { vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [{ category: 'teleport', from: 'A', to: 'B', distanceKm: 80 }] });
    expect(res.status).toBe(400);
  });

  it('estimate is 400 when a chauffeur itinerary has any undated leg (dates required on every leg incl. stay)', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', {
      vehicle: 'car', passengerCount: 2, luggageCount: 1, legs: [
        { category: 'transfer', from: 'Airport', to: 'Kandy', distanceKm: 120, date: '2026-02-14' },
        { category: 'stay_day', from: 'Kandy', to: '' }, // undated → should reject
        { category: 'transfer', from: 'Kandy', to: 'Ella', distanceKm: 140, date: '2026-02-16' },
      ],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/date/i);
  });

  // Legs are the only concept now (owner decision: a via-request = two same-date legs).
  // A plain leg with a missing km still auto-resolves via the maps adapter…
  it('estimate auto-resolves a single leg\'s distance via the maps adapter when km is omitted', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', {
      vehicle: 'car', passengerCount: 2, luggageCount: 2, legs: [{ category: 'transfer', from: 'Colombo City', to: 'Kandy' }],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).total.cents).toBeGreaterThan(0);
  });

  // …and an unresolvable leg still 400s naming the failing segment.
  it('estimate is 400 when a leg\'s distance cannot be resolved', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', {
      vehicle: 'car', passengerCount: 2, luggageCount: 2, legs: [{ category: 'transfer', from: 'Colombo City', to: 'Nowhereville' }],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/couldn't find the distance/i);
  });

  // Reflow: `services` chooser replaces the car/van comparison.
  it('services: a multi-day dated 2-leg itinerary prices BOTH pointToPoint and chauffeur', async () => {
    const d = await (await post(createApp(), '/admin/quote/estimate', {
      service: 'private', vehicle: 'car', passengerCount: 2, luggageCount: 2, legs: [
        { category: 'transfer', from: 'Airport', to: 'Kandy', distanceKm: 120, date: '2026-02-14' },
        { category: 'transfer', from: 'Kandy', to: 'Ella', distanceKm: 140, date: '2026-02-16' },
      ],
    })).json();
    expect(d.product).toBe('private'); // selected service drives the detailed response
    expect(d.services.pointToPoint.total.cents).toBeGreaterThan(0);
    expect(d.services.chauffeur.total.cents).toBeGreaterThan(0);
    expect(d.services.chauffeur.deposit.cents).toBeLessThanOrEqual(5000); // chauffeur deposit cap
    expect(d.services.chauffeur.amountDueNow.cents).toBe(d.services.chauffeur.deposit.cents);
    expect(d.comparison).toBeUndefined();
  });

  it('services: selecting chauffeur drives the detailed response and still prices pointToPoint', async () => {
    const d = await (await post(createApp(), '/admin/quote/estimate', {
      service: 'chauffeur', vehicle: 'car', passengerCount: 2, luggageCount: 2, legs: [
        { category: 'transfer', from: 'Airport', to: 'Kandy', distanceKm: 120, date: '2026-02-14' },
        { category: 'transfer', from: 'Kandy', to: 'Ella', distanceKm: 140, date: '2026-02-16' },
      ],
    })).json();
    expect(d.product).toBe('chauffeur');
    expect(d.services.pointToPoint.total.cents).toBeGreaterThan(0);
    expect(d.services.chauffeur.total.cents).toBeGreaterThan(0);
  });

  it('services: a single-day itinerary returns chauffeur error "single-day"', async () => {
    const d = await (await post(createApp(), '/admin/quote/estimate', {
      service: 'private', vehicle: 'car', passengerCount: 2, luggageCount: 2, legs: [
        { category: 'transfer', from: 'Airport', to: 'Kandy', distanceKm: 120, date: '2026-02-14' },
        { category: 'transfer', from: 'Kandy', to: 'Ella', distanceKm: 140, date: '2026-02-14' },
      ],
    })).json();
    expect(d.services.pointToPoint.total.cents).toBeGreaterThan(0);
    expect(d.services.chauffeur.error).toMatch(/single-day/i);
  });

  it('services: an undated multi-leg itinerary returns chauffeur error "add a date"', async () => {
    const d = await (await post(createApp(), '/admin/quote/estimate', {
      service: 'private', vehicle: 'car', passengerCount: 2, luggageCount: 2, legs: [
        { category: 'transfer', from: 'Airport', to: 'Kandy', distanceKm: 120 },
        { category: 'transfer', from: 'Kandy', to: 'Ella', distanceKm: 140 },
      ],
    })).json();
    expect(d.services.pointToPoint.total.cents).toBeGreaterThan(0);
    expect(d.services.chauffeur.error).toMatch(/add a date/i);
  });

  it('service:chauffeur does NOT charge sightseeing (engine rule); private DOES (+1000)', async () => {
    const legs = [
      { category: 'transfer', from: 'Airport', to: 'Kandy', distanceKm: 120, date: '2026-02-14', addSightseeingFee: true },
      { category: 'transfer', from: 'Kandy', to: 'Ella', distanceKm: 140, date: '2026-02-16' },
    ];
    const priv = await (await post(createApp(), '/admin/quote/estimate', { service: 'private', vehicle: 'car', passengerCount: 2, luggageCount: 2, legs })).json();
    const privNoFee = await (await post(createApp(), '/admin/quote/estimate', { service: 'private', vehicle: 'car', passengerCount: 2, luggageCount: 2, legs: legs.map((l) => ({ ...l, addSightseeingFee: false })) })).json();
    expect(priv.total.cents).toBe(privNoFee.total.cents + 1000); // private charges sightseeing

    const chauf = await (await post(createApp(), '/admin/quote/estimate', { service: 'chauffeur', vehicle: 'car', passengerCount: 2, luggageCount: 2, legs })).json();
    const chaufNoFee = await (await post(createApp(), '/admin/quote/estimate', { service: 'chauffeur', vehicle: 'car', passengerCount: 2, luggageCount: 2, legs: legs.map((l) => ({ ...l, addSightseeingFee: false })) })).json();
    expect(chauf.total.cents).toBe(chaufNoFee.total.cents); // chauffeur does NOT charge sightseeing
  });

  it('estimate rejects category "sightseeing" (no longer a valid leg category) with 400', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', { vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [{ category: 'sightseeing', from: 'A', to: 'B', distanceKm: 80 }] });
    expect(res.status).toBe(400);
  });

  it('estimate rejects category "safari_wait" (now a toggle, not a category) with 400', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', { vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [{ category: 'safari_wait', from: 'A', to: 'B', distanceKm: 80 }] });
    expect(res.status).toBe(400);
  });

  // Fix 8 (V19): /save persists the reopenable tool payload under request.tool (+ engine req).
  it('POST /save stores request.tool and request.engine for reopening', async () => {
    const app = createApp();
    const body = { name: 'Reo', vehicle: 'car', passengerCount: 2, luggageCount: 2, legs: [{ category: 'transfer', from: 'Colombo City', to: 'Kandy', distanceKm: 100 }] };
    const res = await post(app, '/admin/quote/save', body);
    expect(res.status).toBe(201);
    const saved = await res.json();
    const got = await (await app.request(`/admin/quote/${saved.id}`)).json();
    expect(got.request.tool.legs[0].from).toBe('Colombo City');
    expect(got.request.engine).toBeTruthy();
    expect(got.request.engine.product).toBe('private');
  });

  // Legs-only decision: an OLD saved quote whose request.tool legs still carry a `stopovers`
  // array (persisted before this change) must still reopen/reprice fine — Zod strips the
  // unknown key rather than rejecting the payload.
  it('re-pricing an old saved quote whose tool legs carry a leftover stopovers array still works', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', {
      vehicle: 'car', passengerCount: 2, luggageCount: 2,
      legs: [{ category: 'transfer', from: 'A', to: 'B', distanceKm: 80, stopovers: ['Old Data'] }],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).total.cents).toBe(4048);
  });
});

describe('quoting tool — admin-key auth', () => {
  const keyed = () => {
    const a = new Hono();
    a.route('/admin/quote', internalQuoteRoutes({ maps: new FakeMapsAdapter(), quotes: new InMemoryQuoteRepo(), adminKey: 'secret' }));
    return a;
  };

  // Ops⇄quote merge T2: the standalone shell is retired — the tool lives in /ops now.
  it('GET / redirects to /ops (302) without needing a key', async () => {
    const res = await keyed().request('/admin/quote');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/ops');
  });

  it('401s a data route without the key and 200s with it', async () => {
    const app = keyed();
    expect((await app.request('/admin/quote/places?q=kand')).status).toBe(401);
    const ok = await app.request('/admin/quote/places?q=kand', { headers: { 'x-admin-key': 'secret' } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).places).toEqual(['Kandy']);
  });

  it('leaves data routes open when no key is configured (dev/preview)', async () => {
    // createApp default ADMIN_API_KEY is '' → open (NODE_ENV !== 'production' under vitest)
    expect((await createApp().request('/admin/quote/places?q=kand')).status).toBe(200);
  });
});

// Ops⇄quote merge T1: a founder ops-session cookie (ch_ops, same as /admin/ops) now unlocks
// /admin/quote/* alongside the legacy x-admin-key. Support NEVER sees quote data (margin/PII)
// — not even through the dev keyless bypass.
describe('quoting tool — founder ops-session cookie auth', () => {
  const SECRET = 'test-ops-session-secret';
  const founder = `ch_ops=${signSession('founder', SECRET)}`;
  const support = `ch_ops=${signSession('support', SECRET)}`;
  const build = (over: Record<string, unknown> = {}) => {
    const a = new Hono();
    a.route('/admin/quote', internalQuoteRoutes({
      maps: new FakeMapsAdapter(), quotes: new InMemoryQuoteRepo(),
      adminKey: 'K', sessionSecret: SECRET, ...over,
    }));
    return a;
  };

  it('founder cookie authorizes reads AND the PII/margin routes (rate-card, list)', async () => {
    const app = build();
    for (const p of ['/admin/quote/rate-card', '/admin/quote/list']) {
      expect((await app.request(p, { headers: { cookie: founder } })).status).toBe(200);
    }
  });

  it('support cookie is forbidden (403) on every data route', async () => {
    const app = build();
    for (const p of ['/admin/quote/rate-card', '/admin/quote/list', '/admin/quote/x']) {
      expect((await app.request(p, { headers: { cookie: support } })).status).toBe(403);
    }
    const est = await app.request('/admin/quote/estimate', {
      method: 'POST', headers: { cookie: support, 'content-type': 'application/json' }, body: '{}',
    });
    expect(est.status).toBe(403);
  });

  it('legacy x-admin-key still works (200)', async () => {
    expect((await build().request('/admin/quote/rate-card', { headers: { 'x-admin-key': 'K' } })).status).toBe(200);
  });

  it('no auth at all is 401', async () => {
    expect((await build().request('/admin/quote/rate-card')).status).toBe(401);
  });

  it('a founder cookie signed with the wrong secret is 401 (forgery)', async () => {
    const res = await build().request('/admin/quote/rate-card', {
      headers: { cookie: `ch_ops=${signSession('founder', 'WRONG')}` },
    });
    expect(res.status).toBe(401);
  });

  it('support cookie is still 403 even with no adminKey + allowNoKey:true (never falls through the dev bypass)', async () => {
    const app = build({ adminKey: undefined, allowNoKey: true });
    expect((await app.request('/admin/quote/rate-card', { headers: { cookie: support } })).status).toBe(403);
  });
});

// GL-1d: van14/custom are custom-priced per quote — the tool sends customRatePerKmCents.
describe('quoting tool — custom per-km rate for Van 14 / Custom', () => {
  const openApp = () => {
    const a = new Hono();
    a.route('/admin/quote', internalQuoteRoutes({ maps: new FakeMapsAdapter(), quotes: new InMemoryQuoteRepo(), allowNoKey: true }));
    return a;
  };
  const estimate = (body: unknown) =>
    openApp().request('/admin/quote/estimate', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });

  it('van_14 + customRatePerKmCents prices at the overridden rate', async () => {
    const res = await estimate({
      vehicle: 'van_14', passengerCount: 12, luggageCount: 8, service: 'private',
      legs: [{ from: 'A', to: 'B', distanceKm: 140 }],
      customRatePerKmCents: 90,
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.total.cents).toBe(154 * 90); // billable 154km × 90¢, not the 130¢ placeholder
  });

  it('400s a custom rate on a non-custom tier (car)', async () => {
    const res = await estimate({
      vehicle: 'car', passengerCount: 2, luggageCount: 1, service: 'private',
      legs: [{ from: 'A', to: 'B', distanceKm: 100 }],
      customRatePerKmCents: 90,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Van 14|Custom/);
  });
});

// GL-1c: the tool stores customer PII and exposes cost/margin. With no key configured the
// guard must fail CLOSED unless dev-openness is explicitly requested (allowNoKey) — a
// misconfigured production deploy must lock, not expose.
describe('quoting tool — fail-closed when no key is configured', () => {
  const locked = () => {
    const a = new Hono();
    a.route('/admin/quote', internalQuoteRoutes({ maps: new FakeMapsAdapter(), quotes: new InMemoryQuoteRepo() }));
    return a;
  };

  it('401s data routes when no adminKey is set and allowNoKey is absent (production default)', async () => {
    const app = locked();
    expect((await app.request('/admin/quote/places?q=kand')).status).toBe(401);
    expect((await app.request('/admin/quote/list')).status).toBe(401);
    const est = await app.request('/admin/quote/estimate', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(est.status).toBe(401);
  });

  it('still redirects GET / to /ops when locked (the redirect carries no quote data)', async () => {
    const res = await locked().request('/admin/quote');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/ops');
  });

  it('allowNoKey: true keeps data routes open without a key (dev/preview)', async () => {
    const a = new Hono();
    a.route('/admin/quote', internalQuoteRoutes({ maps: new FakeMapsAdapter(), quotes: new InMemoryQuoteRepo(), allowNoKey: true }));
    expect((await a.request('/admin/quote/places?q=kand')).status).toBe(200);
  });
});

describe('quoting tool — /places delegates to the maps adapter', () => {
  it('returns whatever the injected adapter.places() yields (Google now lives in the adapter)', async () => {
    const a = new Hono();
    const stubMaps = { provider: 'stub', places: async (q: string) => [`Stubbed`, q].slice(0, 1), distance: async () => null };
    a.route('/admin/quote', internalQuoteRoutes({ maps: stubMaps, quotes: new InMemoryQuoteRepo(), allowNoKey: true }));
    const res = await a.request('/admin/quote/places?q=colombo');
    expect(res.status).toBe(200);
    expect((await res.json()).places).toEqual(['Stubbed']);
  });

  it('returns [] for a too-short query without touching the adapter', async () => {
    const a = new Hono();
    let called = false;
    const stubMaps = { provider: 'stub', places: async (q: string) => { called = q.length >= 0; return ['Nope']; }, distance: async () => null };
    a.route('/admin/quote', internalQuoteRoutes({ maps: stubMaps, quotes: new InMemoryQuoteRepo(), allowNoKey: true }));
    const res = await a.request('/admin/quote/places?q=c');
    expect((await res.json()).places).toEqual([]);
    expect(called).toBe(false);
  });
});

// Ops⇄quote merge T2: the standalone quote shell is retired — GET / is a plain 302 to /ops
// (where the tool now lives). The old toolHtml()/readFileSync resilience suite went with it.
describe('quoting tool — GET / redirects to /ops', () => {
  it('app-level: GET /admin/quote → 302 with location /ops', async () => {
    const res = await createApp().request('/admin/quote');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/ops');
  });
});

// Ops⇄quote merge T2: CSRF on the state-changing routes. A founder's browser holds an ambient
// ch_ops cookie, so a cross-site page could otherwise fire authenticated POSTs. Mutations check
// Sec-Fetch-Site first (modern browsers), then fall back to the Origin allow-list (older ones).
// Neither header present = non-browser caller (curl/fetch from scripts) — the auth guard still
// applies. GET reads stay CSRF-exempt: autocomplete must stay fast and reads carry no writes.
describe('quoting tool — CSRF (Sec-Fetch-Site/Origin) on mutations', () => {
  const SECRET = 'test-ops-session-secret';
  const founder = `ch_ops=${signSession('founder', SECRET)}`;
  const OWN_ORIGIN = 'http://localhost:4173'; // in the app's default ALLOWED_ORIGINS
  const build = () => {
    const a = new Hono();
    a.route('/admin/quote', internalQuoteRoutes({
      maps: new FakeMapsAdapter(), quotes: new InMemoryQuoteRepo(),
      adminKey: 'K', sessionSecret: SECRET, allowedOrigins: [OWN_ORIGIN],
    }));
    return a;
  };
  const estimateBody = JSON.stringify({
    vehicle: 'car', passengerCount: 1, luggageCount: 0,
    legs: [{ category: 'transfer', from: 'A', to: 'B', distanceKm: 80 }],
  });
  const estimate = (headers: Record<string, string>) =>
    build().request('/admin/quote/estimate', {
      method: 'POST', body: estimateBody,
      headers: { cookie: founder, 'content-type': 'application/json', ...headers },
    });

  it('403 bad_origin on Sec-Fetch-Site: cross-site, even with a valid founder cookie', async () => {
    const res = await estimate({ 'sec-fetch-site': 'cross-site' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('bad_origin');
  });

  it('403 bad_origin on a disallowed Origin when Sec-Fetch-Site is absent (older browsers)', async () => {
    const res = await estimate({ origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('bad_origin');
  });

  it('passes with an allow-listed Origin (the app\'s own serving origin)', async () => {
    const res = await estimate({ origin: OWN_ORIGIN });
    expect(res.status).toBe(200);
  });

  it('passes with neither header (non-browser caller; the auth guard still protects)', async () => {
    const res = await estimate({});
    expect(res.status).toBe(200);
  });

  it('covers every mutation: POST /distance, POST /save, PATCH /:id all 403 cross-site', async () => {
    const app = build();
    const bad = { cookie: founder, 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' };
    const dist = await app.request('/admin/quote/distance', { method: 'POST', headers: bad, body: '{"from":"A","to":"B"}' });
    expect(dist.status).toBe(403);
    expect((await dist.json()).error).toBe('bad_origin');
    const save = await app.request('/admin/quote/save', { method: 'POST', headers: bad, body: estimateBody });
    expect(save.status).toBe(403);
    const patch = await app.request('/admin/quote/some-id', { method: 'PATCH', headers: bad, body: '{"status":"won"}' });
    expect(patch.status).toBe(403);
  });

  it('GET reads are exempt — a cross-site Sec-Fetch-Site still reads /rate-card and /list', async () => {
    const app = build();
    const headers = { cookie: founder, 'sec-fetch-site': 'cross-site' };
    expect((await app.request('/admin/quote/rate-card', { headers })).status).toBe(200);
    expect((await app.request('/admin/quote/list', { headers })).status).toBe(200);
  });

  it('app-level wiring: createApp passes its allow-list into the mount', async () => {
    // Default ALLOWED_ORIGINS includes http://localhost:4173; the dev keyless bypass opens
    // auth under vitest, so a CSRF 403 here can only come from the mounted allow-list.
    const app = createApp();
    const post = (origin?: string) => app.request('/admin/quote/estimate', {
      method: 'POST', body: estimateBody,
      headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    });
    expect((await post('https://evil.example')).status).toBe(403);
    expect((await post(OWN_ORIGIN)).status).toBe(200);
  });
});
