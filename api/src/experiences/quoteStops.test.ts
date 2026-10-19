import { describe, expect, it } from 'vitest';
import { InMemoryPlaceResolutionRepo } from '../db/placeResolutionRepo';
import { quoteStopPoints } from './quoteStops';

// Spec D9: a quote's stops are its driving legs' destinations, resolved from names we already trust.
const req = (legs: unknown[]) => ({ tool: { legs } });
const places = () => new InMemoryPlaceResolutionRepo();

describe('quoteStopPoints', () => {
  it('returns each driving leg’s destination in order; the airport origin is never a stop', async () => {
    const r = await quoteStopPoints(req([
      { from: 'Colombo Airport (CMB)', to: 'Sigiriya / Dambulla' },
      { from: 'Sigiriya / Dambulla', to: 'Kandy' },
    ]), places());
    expect(r.map((s) => s.label)).toEqual(['Sigiriya', 'Kandy']);
    expect(r[0]).toMatchObject({ lat: 7.95, lng: 80.76 });
  });

  it('reads legs kept at the top level of older rows', async () => {
    const r = await quoteStopPoints({ legs: [{ from: 'Negombo', to: 'Galle' }] }, places());
    expect(r.map((s) => s.label)).toEqual(['Galle']);
  });

  it('skips stay days', async () => {
    const r = await quoteStopPoints(req([
      { from: 'Ella', to: 'Ella', category: 'stay_day' },
      { from: 'Ella', to: 'Kandy', category: 'transfer' },
    ]), places());
    expect(r.map((s) => s.label)).toEqual(['Kandy']);
  });

  it('de-duplicates by canonical name', async () => {
    const r = await quoteStopPoints(req([
      { from: 'Negombo', to: 'Galle' },
      { from: 'Galle', to: 'Kandy' },
      { from: 'Kandy', to: 'Galle, Sri Lanka' },
    ]), places());
    expect(r.map((s) => s.label)).toEqual(['Galle', 'Kandy']);
  });

  it('resolves a literal "lat,lng" through knownCoords', async () => {
    const r = await quoteStopPoints(req([{ from: 'Kandy', to: '7.9,80.7' }]), places());
    expect(r).toEqual([{ label: '7.9,80.7', lat: 7.9, lng: 80.7 }]);
  });

  it('falls back to place_resolutions for names the catalogue does not know', async () => {
    const repo = places();
    await repo.upsert({ canonKey: 'lunuganga estate', displayName: 'Lunuganga Estate', lat: 6.3, lng: 80.0, source: 'confirmed' });
    const r = await quoteStopPoints(req([{ from: 'Galle', to: 'Lunuganga Estate, Sri Lanka' }]), repo);
    expect(r).toEqual([{ label: 'Lunuganga Estate, Sri Lanka', lat: 6.3, lng: 80.0 }]);
  });

  it('skips unresolved names and malformed input', async () => {
    expect((await quoteStopPoints(req([{ from: 'A', to: 'Nowhereville' }, { from: 'A' }, null, 7]), places()))).toEqual([]);
    expect(await quoteStopPoints(null, places())).toEqual([]);
    expect(await quoteStopPoints({ tool: { legs: 'x' } }, places())).toEqual([]);
  });
});
