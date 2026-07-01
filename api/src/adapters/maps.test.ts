import { describe, it, expect, afterEach, vi } from 'vitest';
import { FakeMapsAdapter, GoogleMapsAdapter } from './maps';

describe('FakeMapsAdapter', () => {
  const maps = new FakeMapsAdapter();

  it('estimates road distance + duration for known places', async () => {
    const r = await maps.distance('Colombo Airport (CMB)', 'Galle');
    expect(r).not.toBeNull();
    // crow-flies × 1.35 ≈ 180 km, matching the marketing site's estimate
    expect(r!.km).toBeGreaterThanOrEqual(175);
    expect(r!.km).toBeLessThanOrEqual(185);
    expect(r!.durationMin).toBeGreaterThan(0);
  });

  it('is case-insensitive on place names', async () => {
    const r = await maps.distance('kandy', 'ELLA');
    expect(r).not.toBeNull();
    expect(r!.km).toBeGreaterThan(0);
  });

  it('returns null for an unknown / typed address (needs real geocoding)', async () => {
    expect(await maps.distance('Galadari Hotel, Colombo', 'Galle')).toBeNull();
  });

  it('places: case-insensitive substring match, up to 6', async () => {
    const r = await maps.places('kand');
    expect(r).toEqual(['Kandy']);
  });

  it('places: no match returns []', async () => {
    expect(await maps.places('zz')).toEqual([]);
  });
});

describe('GoogleMapsAdapter', () => {
  const origFetch = global.fetch;
  afterEach(() => {
    global.fetch = origFetch;
    vi.restoreAllMocks();
  });

  it('parses a Distance Matrix response into km + minutes', async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify({ status: 'OK', rows: [{ elements: [{ status: 'OK', distance: { value: 180000 }, duration: { value: 15420 } }] }] }),
        { status: 200 },
      )) as typeof fetch;
    const r = await new GoogleMapsAdapter('test-key').distance('Colombo', 'Galle');
    expect(r).toEqual({ km: 180, durationMin: 257 });
  });

  it('returns null when the route has no result', async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ status: 'OK', rows: [{ elements: [{ status: 'ZERO_RESULTS' }] }] }), { status: 200 })) as typeof fetch;
    expect(await new GoogleMapsAdapter('test-key').distance('Nowhere', 'Elsewhere')).toBeNull();
  });

  it('returns null and logs when top-level status is REQUEST_DENIED', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    global.fetch = (async () =>
      new Response(JSON.stringify({ status: 'REQUEST_DENIED', rows: [] }), { status: 200 })) as typeof fetch;
    const r = await new GoogleMapsAdapter('test-key').distance('Colombo', 'Galle');
    expect(r).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('REQUEST_DENIED'));
  });

  it('distance() calls fetch with an AbortSignal (timeout wiring)', async () => {
    let capturedInit: RequestInit | undefined;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return new Response(
        JSON.stringify({ status: 'OK', rows: [{ elements: [{ status: 'OK', distance: { value: 1000 }, duration: { value: 60 } }] }] }),
        { status: 200 },
      );
    }) as typeof fetch;
    await new GoogleMapsAdapter('test-key').distance('Colombo', 'Galle');
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
  });

  describe('places()', () => {
    it('parses predictions into descriptions (max 6)', async () => {
      global.fetch = (async () =>
        new Response(
          JSON.stringify({
            status: 'OK',
            predictions: [
              { description: 'Kandy, Sri Lanka' },
              { description: 'Kandy Lake' },
              { description: 'Kandy Rd' },
              { description: 'Kandy A' },
              { description: 'Kandy B' },
              { description: 'Kandy C' },
              { description: 'Kandy D' },
            ],
          }),
          { status: 200 },
        )) as typeof fetch;
      const r = await new GoogleMapsAdapter('test-key').places('kandy');
      expect(r).toHaveLength(6);
      expect(r[0]).toBe('Kandy, Sri Lanka');
    });

    it('builds the URL with input/components/key', async () => {
      let capturedUrl = '';
      global.fetch = (async (url: string) => {
        capturedUrl = String(url);
        return new Response(JSON.stringify({ status: 'OK', predictions: [] }), { status: 200 });
      }) as typeof fetch;
      await new GoogleMapsAdapter('my-key').places('galle');
      expect(capturedUrl).toContain('input=galle');
      expect(capturedUrl).toContain('components=country:lk');
      expect(capturedUrl).toContain('key=my-key');
    });

    it('falls back to KNOWN_PLACES filter when Google returns no predictions', async () => {
      global.fetch = (async () =>
        new Response(JSON.stringify({ status: 'OK', predictions: [] }), { status: 200 })) as typeof fetch;
      const r = await new GoogleMapsAdapter('test-key').places('kand');
      expect(r).toEqual(['Kandy']);
    });

    it('returns [] and logs when top-level status is OVER_QUERY_LIMIT', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      global.fetch = (async () =>
        new Response(JSON.stringify({ status: 'OVER_QUERY_LIMIT', predictions: [] }), { status: 200 })) as typeof fetch;
      const r = await new GoogleMapsAdapter('test-key').places('kandy');
      expect(r).toEqual([]);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('OVER_QUERY_LIMIT'));
    });

    it('falls back to KNOWN_PLACES filter and logs once when fetch throws', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      global.fetch = (async () => {
        throw new Error('network down');
      }) as typeof fetch;
      const r = await new GoogleMapsAdapter('test-key').places('kand');
      expect(r).toEqual(['Kandy']);
      expect(errSpy).toHaveBeenCalledTimes(1);
    });

    it('calls fetch with an AbortSignal (timeout wiring)', async () => {
      let capturedInit: RequestInit | undefined;
      global.fetch = (async (_url: string, init?: RequestInit) => {
        capturedInit = init;
        return new Response(JSON.stringify({ status: 'OK', predictions: [] }), { status: 200 });
      }) as typeof fetch;
      await new GoogleMapsAdapter('test-key').places('galle');
      expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
    });
  });
});
