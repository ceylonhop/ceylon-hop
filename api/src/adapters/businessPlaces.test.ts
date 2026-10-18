import { describe, it, expect } from 'vitest';
import { GoogleBusinessPlaces, FakeBusinessPlaces, selectBusinessPlaces } from './businessPlaces';

// "Find the business on Google" (2026-10-18): the ops Experiences form searches Google for the partner
// and fills partner, area, pin and contact from the pick.

function stub(body: unknown, status = 200) {
  const urls: string[] = [];
  const f = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { f, urls };
}
const meter = () => { const keys: string[] = []; return { keys, bump: (k: string) => { keys.push(k); } }; };

const ATHERYA = {
  place_id: 'ChIJAtherya0000000000000', name: 'Atherya Ayurveda Spa', formatted_address: 'Kibissa, Sigiriya 21120, Sri Lanka',
  geometry: { location: { lat: 7.9571, lng: 80.7601 } },
};

describe('GoogleBusinessPlaces.search', () => {
  it('asks Text Search for the query in Sri Lanka and maps the results', async () => {
    const { f, urls } = stub({ status: 'OK', results: [ATHERYA] });
    const m = meter();
    const out = await new GoogleBusinessPlaces('KEY', f, m).search('atherya spa');
    const u = new URL(urls[0]!);
    expect(u.origin + u.pathname).toBe('https://maps.googleapis.com/maps/api/place/textsearch/json');
    expect(u.searchParams.get('query')).toBe('atherya spa');
    expect(u.searchParams.get('region')).toBe('lk');
    expect(u.searchParams.get('key')).toBe('KEY');
    expect(out).toEqual([{ placeId: ATHERYA.place_id, name: 'Atherya Ayurveda Spa', address: 'Kibissa, Sigiriya 21120, Sri Lanka', lat: 7.9571, lng: 80.7601 }]);
    expect(m.keys).toEqual(['maps.business_search']);
  });

  it('keeps only Sri Lankan, well-formed results, at most 5', async () => {
    const abroad = { ...ATHERYA, place_id: 'ChIJAbroad00000000000000', geometry: { location: { lat: 51.5, lng: -0.1 } } };
    const noId = { ...ATHERYA, place_id: undefined };
    const many = Array.from({ length: 8 }, (_, i) => ({ ...ATHERYA, place_id: `ChIJMany${String(i).padStart(14, '0')}` }));
    const { f } = stub({ status: 'OK', results: [abroad, noId, ...many] });
    const out = await new GoogleBusinessPlaces('KEY', f).search('spa');
    expect(out).toHaveLength(5);
    expect(out.every((c) => c.placeId.startsWith('ChIJMany'))).toBe(true);
  });

  it('is [] for a short query (no call), ZERO_RESULTS, a refused key, an HTTP error or a network failure', async () => {
    const none = stub({ status: 'OK', results: [] });
    expect(await new GoogleBusinessPlaces('KEY', none.f).search(' a ')).toEqual([]);
    expect(none.urls).toHaveLength(0);
    expect(await new GoogleBusinessPlaces('KEY', stub({ status: 'ZERO_RESULTS', results: [] }).f).search('spa')).toEqual([]);
    expect(await new GoogleBusinessPlaces('KEY', stub({ status: 'REQUEST_DENIED', error_message: 'no' }).f).search('spa')).toEqual([]);
    expect(await new GoogleBusinessPlaces('KEY', stub({}, 500).f).search('spa')).toEqual([]);
    const boom = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
    expect(await new GoogleBusinessPlaces('KEY', boom).search('spa')).toEqual([]);
  });
});

describe('GoogleBusinessPlaces.details', () => {
  const DETAILS = {
    status: 'OK',
    result: {
      ...ATHERYA, international_phone_number: '+94 77 123 4567', website: 'https://atherya.lk/',
      url: 'https://maps.google.com/?cid=123',
      address_components: [
        { long_name: 'Kibissa', types: ['sublocality', 'political'] },
        { long_name: 'Sigiriya', types: ['locality', 'political'] },
        { long_name: 'Matale', types: ['administrative_area_level_2', 'political'] },
      ],
    },
  };

  it('asks only for the fields the form fills, and maps them', async () => {
    const { f, urls } = stub(DETAILS);
    const m = meter();
    const out = await new GoogleBusinessPlaces('KEY', f, m).details(ATHERYA.place_id);
    const u = new URL(urls[0]!);
    expect(u.origin + u.pathname).toBe('https://maps.googleapis.com/maps/api/place/details/json');
    expect(u.searchParams.get('place_id')).toBe(ATHERYA.place_id);
    expect(u.searchParams.get('fields')!.split(',').sort()).toEqual(
      ['address_component', 'formatted_address', 'geometry/location', 'international_phone_number', 'name', 'opening_hours', 'place_id', 'url', 'website'].sort());
    expect(out).toEqual({
      placeId: ATHERYA.place_id, name: 'Atherya Ayurveda Spa', address: 'Kibissa, Sigiriya 21120, Sri Lanka',
      lat: 7.9571, lng: 80.7601, area: 'Sigiriya', phone: '+94 77 123 4567', website: 'https://atherya.lk/',
      mapsUrl: 'https://maps.google.com/?cid=123', openWeekdays: null,
    });
    expect(m.keys).toEqual(['maps.business_details']);
  });

  it('falls back to the sublocality for the area; drops a non-http website; null phone when missing', async () => {
    const r = { ...DETAILS.result, website: 'javascript:alert(1)', international_phone_number: undefined,
      address_components: [{ long_name: 'Kibissa', types: ['sublocality'] }] };
    const out = await new GoogleBusinessPlaces('KEY', stub({ status: 'OK', result: r }).f).details(ATHERYA.place_id);
    expect(out).toMatchObject({ area: 'Kibissa', website: null, phone: null });
  });

  it('is null for a malformed id (no call), a place outside Sri Lanka, or a non-OK answer', async () => {
    const s = stub(DETAILS);
    expect(await new GoogleBusinessPlaces('KEY', s.f).details('../x')).toBeNull();
    expect(s.urls).toHaveLength(0);
    const abroad = { status: 'OK', result: { ...DETAILS.result, geometry: { location: { lat: 51.5, lng: -0.1 } } } };
    expect(await new GoogleBusinessPlaces('KEY', stub(abroad).f).details(ATHERYA.place_id)).toBeNull();
    expect(await new GoogleBusinessPlaces('KEY', stub({ status: 'NOT_FOUND' }).f).details(ATHERYA.place_id)).toBeNull();
  });
});

describe('FakeBusinessPlaces / selectBusinessPlaces', () => {
  it('the fake answers what it was given and records the calls', async () => {
    const fake = new FakeBusinessPlaces([{ placeId: ATHERYA.place_id, name: 'Atherya', address: 'Sigiriya', lat: 7.95, lng: 80.76,
      area: 'Sigiriya', phone: null, website: null, mapsUrl: null, openWeekdays: null }]);
    expect((await fake.search('ath')).map((c) => c.name)).toEqual(['Atherya']);
    expect((await fake.details(ATHERYA.place_id))?.area).toBe('Sigiriya');
    expect(await fake.details('ChIJunknown000000000000')).toBeNull();
    expect(fake.calls).toEqual(['search:ath', `details:${ATHERYA.place_id}`, 'details:ChIJunknown000000000000']);
  });
  it('Google when there is a key, otherwise off (null)', () => {
    expect(selectBusinessPlaces('KEY')).toBeInstanceOf(GoogleBusinessPlaces);
    expect(selectBusinessPlaces(undefined)).toBeNull();
    expect(selectBusinessPlaces('')).toBeNull();
  });
});

describe('GoogleBusinessPlaces.details — open days from opening hours (2026-10-18)', () => {
  const base = { ...ATHERYA, address_components: [] };
  const run = async (opening_hours: unknown) =>
    (await new GoogleBusinessPlaces('KEY', stub({ status: 'OK', result: { ...base, opening_hours } }).f).details(ATHERYA.place_id))!.openWeekdays;
  it('the days that have an opening, sorted (Google: 0 = Sunday, same as ours)', async () => {
    expect(await run({ periods: [{ open: { day: 1, time: '0900' } }, { open: { day: 3, time: '0900' } }, { open: { day: 1, time: '1500' } }] })).toEqual([1, 3]);
  });
  it('open 24/7 (one period, open day 0 at 0000, no close) is every day', async () => {
    expect(await run({ periods: [{ open: { day: 0, time: '0000' } }] })).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
  it('null when Google has no hours', async () => {
    expect(await run(undefined)).toBeNull();
    expect(await run({ periods: [] })).toBeNull();
  });
});

describe('GoogleBusinessPlaces.location — coordinates only, for the daily pin refresh', () => {
  it('asks only for place_id and the location, and is metered on its own key', async () => {
    const { f, urls } = stub({ status: 'OK', result: { place_id: ATHERYA.place_id, geometry: { location: { lat: 7.9572, lng: 80.7602 } } } });
    const m = meter();
    expect(await new GoogleBusinessPlaces('KEY', f, m).location(ATHERYA.place_id)).toEqual({ lat: 7.9572, lng: 80.7602 });
    expect(new URL(urls[0]!).searchParams.get('fields')).toBe('place_id,geometry/location');
    expect(m.keys).toEqual(['maps.business_location']);
  });
  it('null for a malformed id (no call), outside Sri Lanka, or a non-OK answer', async () => {
    const s = stub({});
    expect(await new GoogleBusinessPlaces('KEY', s.f).location('../x')).toBeNull();
    expect(s.urls).toHaveLength(0);
    expect(await new GoogleBusinessPlaces('KEY', stub({ status: 'OK', result: { geometry: { location: { lat: 51.5, lng: -0.1 } } } }).f).location(ATHERYA.place_id)).toBeNull();
    expect(await new GoogleBusinessPlaces('KEY', stub({ status: 'NOT_FOUND' }).f).location(ATHERYA.place_id)).toBeNull();
  });
  it('the fake answers the stored pin', async () => {
    const fake = new FakeBusinessPlaces([{ placeId: ATHERYA.place_id, name: 'A', address: '', lat: 7.95, lng: 80.76, area: null, phone: null, website: null, mapsUrl: null, openWeekdays: null }]);
    expect(await fake.location(ATHERYA.place_id)).toEqual({ lat: 7.95, lng: 80.76 });
    expect(await fake.location('ChIJunknown000000000000')).toBeNull();
  });
});
