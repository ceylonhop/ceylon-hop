import { describe, it, expect } from 'vitest';
import { createApp as realCreateApp, type AppDeps } from '../app';
import { InMemoryZonesRepo } from '../db/zonesRepo';
import { InMemoryQuoteRepo } from '../db/quoteRepo';
import { signSession } from '../lib/opsAuth';

const AUTH = { opsUsers: 'f@x.com:founder,op@x.com:ops', googleClientId: 'cid', opsSessionSecret: 'sek' };
const cookie = (email: string) => `ch_ops=${signSession({ email, exp: Date.now() + 60_000 }, AUTH.opsSessionSecret)}`;
const FOUNDER = cookie('f@x.com');
const OPS = cookie('op@x.com');

function app(deps: AppDeps = {}) {
  return realCreateApp({ auth: AUTH, adminApiKey: 'k', ...deps });
}
function post(a: ReturnType<typeof app>, path: string, body: unknown, ck = FOUNDER) {
  return a.request(path, { method: 'POST', headers: { 'content-type': 'application/json', cookie: ck }, body: JSON.stringify(body) });
}
function patch(a: ReturnType<typeof app>, path: string, body: unknown, ck = FOUNDER) {
  return a.request(path, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: ck }, body: JSON.stringify(body) });
}
function get(a: ReturnType<typeof app>, path: string, ck = FOUNDER) {
  return a.request(path, { headers: { cookie: ck } });
}

// A private Kandy→Ella transfer — touches the "Ella" hot zone.
const ELLA_TRIP = { service: 'private', vehicle: 'car', passengerCount: 2, luggageCount: 1, requestedService: 'private', legs: [{ category: 'transfer', from: 'Kandy', to: 'Ella', distanceKm: 140 }] };

async function seededApp(boostPct = 15) {
  const zones = new InMemoryZonesRepo();
  await zones.create({ placeName: 'Ella', boostPct });
  const quotes = new InMemoryQuoteRepo();
  return { a: app({ zones, quotes }), zones, quotes };
}

describe('hot zones — ops quote pricing + D9 visibility', () => {
  it('boosts an Ella ops quote and shows the founder the premium annotation', async () => {
    const { a } = await seededApp(15);
    const d = await (await post(a, '/admin/quote/estimate', ELLA_TRIP)).json();
    const ellaLine = d.lineItems.find((li: { label: string }) => li.label.includes('Ella'));
    expect(ellaLine.meta.hotZone).toEqual({ placeName: 'Ella', boostPct: 15, label: 'Ella premium +15%' });
    // Founder sees margin; no zone text leaks into warnings.
    expect(d.margin).toBeDefined();
    expect(JSON.stringify(d.warnings)).not.toMatch(/Ella|premium/i);
  });

  it('a zone raises the total vs no active zone', async () => {
    const withZone = await (await post((await seededApp(15)).a, '/admin/quote/estimate', ELLA_TRIP)).json();
    const noZone = await (await post(app({ zones: new InMemoryZonesRepo() }), '/admin/quote/estimate', ELLA_TRIP)).json();
    expect(withZone.total.cents).toBeGreaterThan(noZone.total.cents);
  });

  it('D9 leak: ops (no margin:view) sees the same total but NO zone annotation and NO margin', async () => {
    const { a } = await seededApp(15);
    const founder = await (await post(a, '/admin/quote/estimate', ELLA_TRIP, FOUNDER)).json();
    const ops = await (await post(a, '/admin/quote/estimate', ELLA_TRIP, OPS)).json();
    expect(ops.total.cents).toBe(founder.total.cents); // same price to quote the customer
    expect(ops.margin).toBeUndefined(); // margin stripped
    const opsEllaLine = ops.lineItems.find((li: { label: string }) => li.label.includes('Ella'));
    expect(opsEllaLine.meta?.hotZone).toBeUndefined(); // zone reason hidden
    expect(opsEllaLine.meta?.billableKm).toBeDefined(); // …but other meta intact
  });
});

describe('hot zones — rate lock (C2)', () => {
  it('an approved quote keeps its zone price after the zone % later changes', async () => {
    const { a, zones } = await seededApp(15);
    // Save → submit → approve (freezes the card incl. the Ella zone).
    const saved = await (await post(a, '/admin/quote/save', ELLA_TRIP)).json();
    await patch(a, `/admin/quote/${saved.id}`, { status: 'pending_review' });
    await patch(a, `/admin/quote/${saved.id}`, { status: 'ready' });
    const lockedBefore = (await (await get(a, `/admin/quote/${saved.id}`)).json()).estimate.total.cents;

    // Founder later cranks the Ella zone to +50%.
    const [ella] = await zones.list();
    await zones.patch(ella.id, { boostPct: 50 });

    // The locked quote is unmoved; a fresh estimate reflects the new 50%.
    const lockedAfter = (await (await get(a, `/admin/quote/${saved.id}`)).json()).estimate.total.cents;
    const freshEstimate = (await (await post(a, '/admin/quote/estimate', ELLA_TRIP)).json()).total.cents;
    expect(lockedAfter).toBe(lockedBefore);
    expect(freshEstimate).toBeGreaterThan(lockedAfter);
  });
});

describe('hot zones — admin CRUD + RBAC (Phase 2)', () => {
  const SEC_FETCH = { 'sec-fetch-site': 'same-origin' as const };
  const write = (a: ReturnType<typeof app>, method: string, path: string, body: unknown, ck = FOUNDER) =>
    a.request(path, { method, headers: { 'content-type': 'application/json', cookie: ck, ...SEC_FETCH }, body: body === undefined ? undefined : JSON.stringify(body) });

  it('founder creates, lists, patches, and deletes a zone (audit stamped)', async () => {
    const a = app({ zones: new InMemoryZonesRepo() });
    const created = await (await write(a, 'POST', '/admin/quote/zones', { placeName: 'Ella', boostPct: 15 })).json();
    expect(created.placeName).toBe('Ella');
    expect(created.createdBy).toBe('f@x.com');
    const listed = await (await get(a, '/admin/quote/zones')).json();
    expect(listed.zones).toHaveLength(1);
    const patched = await (await write(a, 'PATCH', `/admin/quote/zones/${created.id}`, { boostPct: 25, active: false })).json();
    expect(patched.boostPct).toBe(25);
    expect(patched.active).toBe(false);
    expect((await write(a, 'DELETE', `/admin/quote/zones/${created.id}`, undefined)).status).toBe(200);
    expect((await (await get(a, '/admin/quote/zones')).json()).zones).toHaveLength(0);
  });

  it('ops (no margin:view / quote:approve) cannot read or write zones', async () => {
    const a = app({ zones: new InMemoryZonesRepo() });
    expect((await get(a, '/admin/quote/zones', OPS)).status).toBe(403);
    expect((await write(a, 'POST', '/admin/quote/zones', { placeName: 'Ella', boostPct: 15 }, OPS)).status).toBe(403);
    expect((await write(a, 'PATCH', '/admin/quote/zones/x', { boostPct: 20 }, OPS)).status).toBe(403);
    expect((await write(a, 'DELETE', '/admin/quote/zones/x', undefined, OPS)).status).toBe(403);
  });

  it('validation: boost out of 0–100, and a partial geo trio, are 400', async () => {
    const a = app({ zones: new InMemoryZonesRepo() });
    expect((await write(a, 'POST', '/admin/quote/zones', { placeName: 'Ella', boostPct: 150 })).status).toBe(400);
    expect((await write(a, 'POST', '/admin/quote/zones', { placeName: 'Ella', boostPct: -1 })).status).toBe(400);
    expect((await write(a, 'POST', '/admin/quote/zones', { placeName: '', boostPct: 10 })).status).toBe(400);
    expect((await write(a, 'POST', '/admin/quote/zones', { placeName: 'Ella', boostPct: 15, lat: 6.87 })).status).toBe(400); // lng/radius missing
    expect((await write(a, 'POST', '/admin/quote/zones', { placeName: 'Ella', boostPct: 15, lat: 6.87, lng: 81.05, radiusKm: 10 })).status).toBe(201); // full trio ok
  });

  it('patch/delete of an unknown id is 404', async () => {
    const a = app({ zones: new InMemoryZonesRepo() });
    expect((await write(a, 'PATCH', '/admin/quote/zones/nope', { boostPct: 20 })).status).toBe(404);
    expect((await write(a, 'DELETE', '/admin/quote/zones/nope', undefined)).status).toBe(404);
  });
});
