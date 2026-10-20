// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadTransfers } from './_load.js';

// The site's live price list (spec 2026-09-26 §9): transfers-data.js swaps GET /quote/pricing into
// its baked copy on load, all-or-nothing, within a 2.5 s cap.
const LIVE = {
  perKm: { car: 0.8, van: 1.1 }, floors: { car: 35, van: 60 }, bufferPct: 12,
  priceFinishing: { maxReductionBps: 250, roundToCents: 50 }, chauffeurDayFee: 40,
  chauffeurIdleMinKm: { car: 50, van: 100 }, depositPct: 0.1, depositMin: 50,
  extras: { sightseeing: 11, 'safari-wait': 20, luggage: 6, front: 9, flex: 13, waiting: 12 },
  corridorSeat: {}, seatPricing: { perKmCentsVan: 110, floorCentsVan: 6000, seatsCoveringVan: 3 }, sharedProducts: [],
};
const okFetch = (body) => vi.fn(async () => ({ ok: true, json: async () => body }));

let events;
const onPricing = () => events++;
beforeEach(() => {
  events = 0;
  document.addEventListener('ch:pricing', onPricing);
  document.documentElement.classList.add('prices-pending'); // what the page head does
});
afterEach(() => {
  document.removeEventListener('ch:pricing', onPricing);
  delete window.CEYLON_HOP_API;
  delete window.fetch;
  vi.useRealTimers();
});

describe('live price list', () => {
  it('applies a valid list: helpers price on it, the scalars are mirrored, ch:pricing fires, the hold lifts', async () => {
    window.CEYLON_HOP_API = 'https://api.test';
    window.fetch = okFetch(LIVE);
    const T = loadTransfers();
    const baked = { car: T.PER_KM.car, fee: T.CHAUFFEUR_DAY_FEE };
    expect(await T.pricingReady).toBe(true);
    expect(window.fetch).toHaveBeenCalledWith('https://api.test/quote/pricing', expect.objectContaining({ credentials: 'omit' }));
    expect(T.PER_KM).toEqual({ car: 0.8, van: 1.1 });
    expect(T.FLOORS).toEqual({ car: 35, van: 60 });
    expect(T.BUFFER_PCT).toBe(12);
    expect(T.CHAUFFEUR_DAY_FEE).toBe(40);
    expect(T.EXTRAS.waiting).toBe(12);
    expect(T.billableKm(100)).toBe(112); // the lexical BUFFER_PCT moved too, not just the export
    expect(baked).toEqual({ car: 0.4025, fee: 31.05 });
    expect(events).toBe(1);
    expect(document.documentElement.classList.contains('prices-pending')).toBe(false);
  });

  it.each([
    ['a network failure', () => vi.fn(async () => { throw new Error('offline'); })],
    ['a 404 (the API has no /quote/pricing yet)', () => vi.fn(async () => ({ ok: false, json: async () => ({}) }))],
    ['a malformed list', () => okFetch({ ...LIVE, perKm: { car: -1, van: 1.1 } })],
    ['a list missing an add-on', () => okFetch({ ...LIVE, extras: { waiting: 12 } })],
  ])('keeps every baked number on %s, and still lifts the hold', async (_label, makeFetch) => {
    window.CEYLON_HOP_API = 'https://api.test';
    window.fetch = makeFetch();
    const T = loadTransfers();
    expect(await T.pricingReady).toBe(false);
    expect(T.PER_KM).toEqual({ car: 0.4025, van: 0.5405 });
    expect(T.BUFFER_PCT).toBe(10);
    expect(T.EXTRAS.waiting).toBe(10);
    expect(events).toBe(0);
    expect(document.documentElement.classList.contains('prices-pending')).toBe(false);
  });

  it('gives up at 2.5 s and drops a late answer — a figure once shown never changes', async () => {
    vi.useFakeTimers();
    window.CEYLON_HOP_API = 'https://api.test';
    let answer;
    window.fetch = vi.fn(() => new Promise((res) => { answer = res; }));
    const T = loadTransfers();
    vi.advanceTimersByTime(2500);
    expect(await T.pricingReady).toBe(false);
    answer({ ok: true, json: async () => LIVE });
    await vi.runAllTimersAsync();
    expect(T.PER_KM.car).toBe(0.4025);
    expect(events).toBe(0);
  });

  it('does not fetch at all when the page has no API base (?api=off, or a page that shows no copy prices)', async () => {
    window.fetch = vi.fn();
    window.CEYLON_HOP_API = '';
    const T = loadTransfers();
    expect(await T.pricingReady).toBe(false);
    expect(window.fetch).not.toHaveBeenCalled();
  });
});
