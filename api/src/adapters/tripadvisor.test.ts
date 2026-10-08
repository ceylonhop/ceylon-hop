import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeTripadvisorAdapter, HttpTripadvisorAdapter, NullTripadvisorAdapter, type TripadvisorAdapter } from './tripadvisor';

// Tripadvisor Content API (spec 2026-10-06 D22). Never called for real: fetch is stubbed.
const GOOD = {
  rating: '4.5', num_reviews: '312',
  rating_image_url: 'https://www.tripadvisor.com/img/cdsi/img2/ratings/traveler/4.5-12345-5.svg',
  web_url: 'https://www.tripadvisor.com/Attraction_Review-g1-d6789012-Reviews-Spa.html?m=63959',
};
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const orig = global.fetch;
afterEach(() => { global.fetch = orig; vi.useRealTimers(); vi.restoreAllMocks(); });
const stub = (res: Response | (() => Promise<Response>)) => {
  const f = vi.fn(async () => (typeof res === 'function' ? res() : res));
  global.fetch = f as unknown as typeof fetch;
  return f;
};
const adapter = () => new HttpTripadvisorAdapter('KEY123', 'https://ceylonhop.com');

describe('HttpTripadvisorAdapter', () => {
  it('maps the details response, turning the string rating and review count into numbers', async () => {
    stub(ok(GOOD));
    expect(await adapter().details('6789012')).toEqual({
      rating: 4.5, numReviews: 312, ratingImageUrl: GOOD.rating_image_url, webUrl: GOOD.web_url,
    });
  });

  it('accepts a numeric rating and tacdn image hosts', async () => {
    stub(ok({ ...GOOD, rating: 4, num_reviews: 7, rating_image_url: 'https://static.tacdn.com/img2/ratings/4.0.svg' }));
    expect(await adapter().details('1')).toMatchObject({ rating: 4, numReviews: 7, ratingImageUrl: 'https://static.tacdn.com/img2/ratings/4.0.svg' });
  });

  it('calls the details endpoint with the key, language, currency and the Referer the key is restricted to', async () => {
    const f = stub(ok(GOOD));
    await adapter().details('6789012');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://api.content.tripadvisor.com/api/v1/location/6789012/details');
    expect(u.searchParams.get('key')).toBe('KEY123');
    expect(u.searchParams.get('language')).toBe('en');
    expect(u.searchParams.get('currency')).toBe('USD');
    expect((init.headers as Record<string, string>).Referer).toBe('https://ceylonhop.com');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('never calls out for an id that is not digits', async () => {
    const f = stub(ok(GOOD));
    expect(await adapter().details('../../x')).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('non-200, a network error and bad JSON are all null — never a throw', async () => {
    stub(ok({ error: 'nope' }, 403));
    expect(await adapter().details('1')).toBeNull();
    stub(() => Promise.reject(new Error('boom')));
    expect(await adapter().details('1')).toBeNull();
    stub(new Response('<html>', { status: 200 }));
    expect(await adapter().details('1')).toBeNull();
  });

  it('a request that takes longer than 2 seconds is aborted and answers null', async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn((_u: unknown, init?: RequestInit) => new Promise((_res, rej) => {
      init!.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    })) as unknown as typeof fetch;
    const p = adapter().details('1');
    await vi.advanceTimersByTimeAsync(2100);
    expect(await p).toBeNull();
  });

  it('invalid fields are null: missing rating, rating out of range, no reviews, non-numeric', async () => {
    for (const bad of [
      { ...GOOD, rating: undefined }, { ...GOOD, rating: '6' }, { ...GOOD, rating: '-1' }, { ...GOOD, rating: 'great' },
      { ...GOOD, num_reviews: undefined }, { ...GOOD, num_reviews: 'many' }, { ...GOOD, num_reviews: '-3' },
    ]) {
      stub(ok(bad));
      expect(await adapter().details('1'), JSON.stringify(bad)).toBeNull();
    }
  });

  it('refuses an image or link that is not an https Tripadvisor URL', async () => {
    for (const patch of [
      { rating_image_url: 'https://evil.example/4.5.svg' },
      { rating_image_url: 'http://www.tripadvisor.com/4.5.svg' },
      { rating_image_url: 'https://tripadvisor.com.evil.example/4.5.svg' },
      { rating_image_url: 'https://eviltripadvisor.com/4.5.svg' },
      { rating_image_url: 'javascript:alert(1)' },
      { web_url: 'javascript:alert(1)' },
      { web_url: 'https://evil.example/Attraction' },
      { web_url: 'data:text/html,x' },
      { rating_image_url: undefined }, { web_url: undefined },
    ]) {
      stub(ok({ ...GOOD, ...patch }));
      expect(await adapter().details('1'), JSON.stringify(patch)).toBeNull();
    }
  });
});

describe('NullTripadvisorAdapter and FakeTripadvisorAdapter', () => {
  it('Null always answers null', async () => {
    const adapter: TripadvisorAdapter = new NullTripadvisorAdapter();
    expect(await adapter.details('1')).toBeNull();
  });
  it('Fake answers what it was given and records the calls', async () => {
    const fake = new FakeTripadvisorAdapter({ '1': { rating: 4.5, numReviews: 312, ratingImageUrl: GOOD.rating_image_url, webUrl: GOOD.web_url } });
    expect((await fake.details('1'))!.numReviews).toBe(312);
    expect(await fake.details('2')).toBeNull();
    expect(fake.calls).toEqual(['1', '2']);
  });
});
