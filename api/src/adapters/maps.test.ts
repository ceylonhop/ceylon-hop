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

  it('biases geocoding to Sri Lanka (region=lk) on the Distance Matrix call', async () => {
    let capturedUrl = '';
    global.fetch = (async (url: string) => {
      capturedUrl = String(url);
      return new Response(
        JSON.stringify({ status: 'OK', rows: [{ elements: [{ status: 'OK', distance: { value: 180000 }, duration: { value: 15420 } }] }] }),
        { status: 200 },
      );
    }) as typeof fetch;
    await new GoogleMapsAdapter('my-key').distance('Colombo', 'Galle');
    expect(capturedUrl).toContain('region=lk');
  });

  it('rejects an implausibly long distance (off-island bad geocode) as unresolved', async () => {
    // A half-typed place like "miris" geocodes outside Sri Lanka and Google returns a
    // ~10,284 km "route". No Sri Lankan road trip is that long, so treat it as unresolved
    // (→ null → the tool asks for a manual km) rather than pricing a fantasy distance.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    global.fetch = (async () =>
      new Response(
        JSON.stringify({ status: 'OK', rows: [{ elements: [{ status: 'OK', distance: { value: 10_284_000 }, duration: { value: 805_980 } }] }] }),
        { status: 200 },
      )) as typeof fetch;
    const r = await new GoogleMapsAdapter('test-key').distance('Colombo Airport (CMB)', 'miris');
    expect(r).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('implausible'));
  });

  it('accepts the longest realistic in-country distance (~640 km)', async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify({ status: 'OK', rows: [{ elements: [{ status: 'OK', distance: { value: 640_000 }, duration: { value: 46_800 } }] }] }),
        { status: 200 },
      )) as typeof fetch;
    const r = await new GoogleMapsAdapter('test-key').distance('Jaffna', 'Kataragama');
    expect(r).toEqual({ km: 640, durationMin: 780 });
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

    it('falls back to KNOWN_PLACES filter and logs when top-level status is OVER_QUERY_LIMIT', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      global.fetch = (async () =>
        new Response(JSON.stringify({ status: 'OVER_QUERY_LIMIT', predictions: [] }), { status: 200 })) as typeof fetch;
      const r = await new GoogleMapsAdapter('test-key').places('kandy');
      expect(r).toEqual(['Kandy']);
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

describe('known-place distance resolution (Popular-route picks)', () => {
  const origFetch = global.fetch;
  afterEach(() => { global.fetch = origFetch; vi.restoreAllMocks(); });

  it('FakeMapsAdapter resolves a known pair that has no baked corridor (Trincomalee → Ella)', async () => {
    const r = await new FakeMapsAdapter().distance('Trincomalee', 'Ella');
    expect(r).not.toBeNull();
    expect(r!.km).toBeGreaterThan(0);
  });

  it('GoogleMapsAdapter sends known places as exact coords, not the ambiguous bare name', async () => {
    let capturedUrl = '';
    global.fetch = (async (url: string) => {
      capturedUrl = String(url);
      return new Response(
        JSON.stringify({ status: 'OK', rows: [{ elements: [{ status: 'OK', distance: { value: 290000 }, duration: { value: 20000 } }] }] }),
        { status: 200 },
      );
    }) as typeof fetch;
    const r = await new GoogleMapsAdapter('k').distance('Trincomalee', 'Ella');
    expect(r).toEqual({ km: 290, durationMin: 333 });
    // coords, not "Ella"/"Trincomalee" (bare "Ella" geocodes outside Sri Lanka)
    expect(capturedUrl).toContain(encodeURIComponent('8.59,81.21')); // Trincomalee
    expect(capturedUrl).toContain(encodeURIComponent('6.87,81.05')); // Ella
    expect(capturedUrl).not.toMatch(/origins=Trincomalee/i);
  });

  it('falls back to the offline estimate for a known pair when Google fails', async () => {
    global.fetch = (async () => { throw new Error('network down'); }) as typeof fetch;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await new GoogleMapsAdapter('k').distance('Trincomalee', 'Ella');
    expect(r).not.toBeNull();      // was null before → "No distance" in the tool
    expect(r!.km).toBeGreaterThan(0);
  });

  it('still returns null when Google fails and the places are unknown', async () => {
    global.fetch = (async () => { throw new Error('down'); }) as typeof fetch;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await new GoogleMapsAdapter('k').distance('Nowhereville', 'Elsewhereton')).toBeNull();
  });
});

describe('distanceVariants', () => {
  const origFetch = global.fetch;
  afterEach(() => { global.fetch = origFetch; vi.restoreAllMocks(); });

  // Mirrors the file's existing OK-payload shape (status/rows/elements), parameterized by km + minutes.
  function distanceMatrixResponse(km: number, durationMin: number): Response {
    return new Response(
      JSON.stringify({
        status: 'OK',
        rows: [{ elements: [{ status: 'OK', distance: { value: km * 1000 }, duration: { value: durationMin * 60 } }] }],
      }),
      { status: 200 },
    );
  }

  it('fires two Distance Matrix calls, exactly one with avoid=tolls', async () => {
    const urls: string[] = [];
    global.fetch = (async (url: string) => {
      urls.push(String(url));
      return distanceMatrixResponse(292, 330);
    }) as typeof fetch;
    await new GoogleMapsAdapter('test-key').distanceVariants('Colombo City', 'Ella');
    expect(urls).toHaveLength(2);
    expect(urls.filter((u) => u.includes('avoid=tolls'))).toHaveLength(1);
    // Known-coords substitution applies to both calls, not just the default one.
    const colomboCoords = encodeURIComponent('6.93,79.85');
    expect(urls[0]).toContain(colomboCoords);
    expect(urls[1]).toContain(colomboCoords);
  });

  it('reports a choice when the toll-free route is ≥30 min slower', async () => {
    global.fetch = (async (url: string) => {
      if (String(url).includes('avoid=tolls')) return distanceMatrixResponse(205, 390);
      return distanceMatrixResponse(292, 330);
    }) as typeof fetch;
    const r = await new GoogleMapsAdapter('test-key').distanceVariants('Colombo City', 'Ella');
    expect(r).toEqual({
      fastest: { km: 292, durationMin: 330 },
      noTolls: { km: 205, durationMin: 390 },
      hasChoice: true,
    });
  });

  it('reports NO choice when routes are near-identical', async () => {
    global.fetch = (async (url: string) => {
      if (String(url).includes('avoid=tolls')) return distanceMatrixResponse(90, 155);
      return distanceMatrixResponse(90, 150);
    }) as typeof fetch;
    const r = await new GoogleMapsAdapter('test-key').distanceVariants('Colombo City', 'Ella');
    expect(r).toEqual({
      fastest: { km: 90, durationMin: 150 },
      noTolls: null,
      hasChoice: false,
    });
  });

  it('degrades to no-choice when the avoid=tolls call fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    global.fetch = (async (url: string) => {
      if (String(url).includes('avoid=tolls')) throw new Error('network down');
      return distanceMatrixResponse(292, 330);
    }) as typeof fetch;
    const r = await new GoogleMapsAdapter('test-key').distanceVariants('Colombo City', 'Ella');
    expect(r).toEqual({
      fastest: { km: 292, durationMin: 330 },
      noTolls: null,
      hasChoice: false,
    });
  });

  it('never claims a choice off the offline fallback', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    global.fetch = (async () => { throw new Error('network down'); }) as typeof fetch;
    const r = await new GoogleMapsAdapter('test-key').distanceVariants('Colombo City', 'Ella');
    const offline = await new FakeMapsAdapter().distance('Colombo City', 'Ella');
    expect(r).toEqual({ fastest: offline, noTolls: null, hasChoice: false });
  });

  it('applies MAX_SL_ROAD_KM to the toll-free result too', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    global.fetch = (async (url: string) => {
      // 10,284 km is the field-observed off-island bad-geocode value (see distance() tests above).
      if (String(url).includes('avoid=tolls')) return distanceMatrixResponse(10_284, 500);
      return distanceMatrixResponse(292, 330);
    }) as typeof fetch;
    const r = await new GoogleMapsAdapter('test-key').distanceVariants('Colombo City', 'Ella');
    expect(r).toEqual({
      fastest: { km: 292, durationMin: 330 },
      noTolls: null,
      hasChoice: false,
    });
  });

  it('caches successful comparisons (no refetch on second call)', async () => {
    let fetchCount = 0;
    global.fetch = (async (url: string) => {
      fetchCount++;
      if (String(url).includes('avoid=tolls')) return distanceMatrixResponse(205, 390);
      return distanceMatrixResponse(292, 330);
    }) as typeof fetch;
    const adapter = new GoogleMapsAdapter('test-key');
    const first = await adapter.distanceVariants('Colombo City', 'Ella');
    expect(fetchCount).toBe(2);
    const second = await adapter.distanceVariants('Colombo City', 'Ella');
    expect(fetchCount).toBe(2); // no new fetches — served from cache
    expect(second).toEqual(first);
  });

  it('does NOT cache failures — a Google blip must not hide the local road for 24h', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let fetchCount = 0;
    let failSlow = true;
    global.fetch = (async (url: string) => {
      fetchCount++;
      if (String(url).includes('avoid=tolls')) {
        if (failSlow) throw new Error('network down');
        return distanceMatrixResponse(205, 390);
      }
      return distanceMatrixResponse(292, 330);
    }) as typeof fetch;
    const adapter = new GoogleMapsAdapter('test-key');
    const first = await adapter.distanceVariants('Colombo City', 'Ella');
    expect(first?.hasChoice).toBe(false);
    expect(fetchCount).toBe(2);
    failSlow = false;
    const second = await adapter.distanceVariants('Colombo City', 'Ella');
    expect(second?.hasChoice).toBe(true);
    expect(fetchCount).toBe(4); // nothing served from cache after the failure
  });

  it('a 40-minute-slower toll-free route is NOT a choice (below the 45-min bar)', async () => {
    global.fetch = (async (url: string) => {
      if (String(url).includes('avoid=tolls')) return distanceMatrixResponse(205, 370); // 370 - 330 = 40
      return distanceMatrixResponse(292, 330);
    }) as typeof fetch;
    const adapter = new GoogleMapsAdapter('test-key');
    const r = await adapter.distanceVariants('Colombo City', 'Ella');
    expect(r?.hasChoice).toBe(false);
    expect(r?.noTolls).toBeNull();
  });

  it('a 60-minute-slower toll-free route IS a choice (at/above the 45-min bar)', async () => {
    global.fetch = (async (url: string) => {
      if (String(url).includes('avoid=tolls')) return distanceMatrixResponse(205, 390); // 390 - 330 = 60
      return distanceMatrixResponse(292, 330);
    }) as typeof fetch;
    const adapter = new GoogleMapsAdapter('test-key');
    const r = await adapter.distanceVariants('Colombo City', 'Ella');
    expect(r?.hasChoice).toBe(true);
  });

  it('a slower route with near-identical km is NOT a choice (below the 15% km bar)', async () => {
    // Price is per-km, so ~same distance means ~same quote: a fork that only trades time
    // for nothing is noise. 280 vs 292 km is a 4% gap — under the bar despite +90 min.
    global.fetch = (async (url: string) => {
      if (String(url).includes('avoid=tolls')) return distanceMatrixResponse(280, 420);
      return distanceMatrixResponse(292, 330);
    }) as typeof fetch;
    const r = await new GoogleMapsAdapter('test-key').distanceVariants('Colombo City', 'Ella');
    expect(r).toEqual({
      fastest: { km: 292, durationMin: 330 },
      noTolls: null,
      hasChoice: false,
    });
  });

  it('a km gap just under 15% is NOT a choice; at 15% it is', async () => {
    const run = async (slowKm: number) => {
      global.fetch = (async (url: string) => {
        if (String(url).includes('avoid=tolls')) return distanceMatrixResponse(slowKm, 420);
        return distanceMatrixResponse(300, 330);
      }) as typeof fetch;
      return new GoogleMapsAdapter('test-key').distanceVariants('Colombo City', 'Ella');
    };
    expect((await run(256))?.hasChoice).toBe(false); // 44/300 ≈ 14.7%
    expect((await run(255))?.hasChoice).toBe(true); // 45/300 = 15%
  });

  describe('FakeMapsAdapter.distanceVariants', () => {
    it('gates synthetic pairs both ways (Colombo City↔Ella forks, Airport↔Galle does not)', async () => {
      const fake = new FakeMapsAdapter();
      const a = await fake.distanceVariants('Colombo City', 'Ella');
      expect(a).toEqual({
        fastest: { km: 292, durationMin: 330 },
        noTolls: { km: 205, durationMin: 390 },
        hasChoice: true,
      });
      expect(await fake.distanceVariants('Ella', 'Colombo City')).toEqual(a);

      // Airport↔Galle's real corridor figures (148 vs 130 km) sit under the 15% km bar:
      // the coastal road only trades +85 min for ~$8 — same gate as the Google adapter.
      const b = await fake.distanceVariants('Colombo Airport (CMB)', 'Galle');
      expect(b).toEqual({
        fastest: { km: 148, durationMin: 120 },
        noTolls: null,
        hasChoice: false,
      });
      expect(await fake.distanceVariants('Galle', 'Colombo Airport (CMB)')).toEqual(b);
    });

    it('returns no-choice offline estimate for other known pairs', async () => {
      const fake = new FakeMapsAdapter();
      const r = await fake.distanceVariants('Kandy', 'Nuwara Eliya');
      const offline = await fake.distance('Kandy', 'Nuwara Eliya');
      expect(r).toEqual({ fastest: offline, noTolls: null, hasChoice: false });
    });

    it('returns null for an unresolvable pair', async () => {
      const fake = new FakeMapsAdapter();
      expect(await fake.distanceVariants('Galadari Hotel, Colombo', 'Galle')).toBeNull();
    });
  });
});
