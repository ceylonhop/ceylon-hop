import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.resolve(__dirname, '../../ch-pricing.js'), 'utf8');

// ch-pricing.js is a browser IIFE that assigns `window.CH_PRICING`. No DOM dependencies beyond
// fetch/sessionStorage/timers, all ambient in the jsdom test environment — same trick _load.js's
// loadTransfers() uses for transfers-data.js: eval straight into the global scope and read the
// exported API back out. A fresh eval per test gives each test its own module-closure state
// (the debounce timer, the 404 latch, the in-flight request) with no source changes needed.
function loadPricing(){
  // eslint-disable-next-line no-new-func
  new Function(src)();
  return window.CH_PRICING;
}

function deferred(){
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function jsonResponse(status, body){
  return { ok: status >= 200 && status < 300, status: status, json: () => Promise.resolve(body) };
}
// Flushes the microtask queue a few times — enough for a fetch .then(res => res.json().then(...))
// chain to fully settle after a fake-timer advance.
async function flush(){ for(let i=0;i<4;i++) await Promise.resolve(); }

describe('CH_PRICING', () => {
  let CH, fetchMock;

  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    window.CEYLON_HOP_API = 'https://api.test';
    fetchMock = vi.fn();
    window.fetch = fetchMock;
    CH = loadPricing();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete window.CEYLON_HOP_API;
  });

  it('POSTs the intent as JSON after a 400ms debounce; two rapid calls collapse to one request for the latest intent', async () => {
    const d = deferred();
    fetchMock.mockReturnValueOnce(d.promise);
    const cb1 = { onResult: vi.fn(), onUnavailable: vi.fn() };
    const cb2 = { onResult: vi.fn(), onUnavailable: vi.fn() };

    CH.estimate({ product: 'private', legs: [{ from: 'A', to: 'B' }] }, cb1);
    await vi.advanceTimersByTimeAsync(100); // still inside the debounce window
    CH.estimate({ product: 'private', legs: [{ from: 'A', to: 'C' }] }, cb2);
    await vi.advanceTimersByTimeAsync(400);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.test/quote/v2/estimate');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ product: 'private', legs: [{ from: 'A', to: 'C' }] });
  });

  it('serves a repeat of the same intent from cache, with no second fetch', async () => {
    const est = { totalCents: 1000, amountDueNowCents: 1000, estimated: false, legs: [] };
    fetchMock.mockReturnValueOnce(Promise.resolve(jsonResponse(200, est)));
    const intent = { product: 'private', legs: [{ from: 'A', to: 'B' }] };
    const cb1 = { onResult: vi.fn(), onUnavailable: vi.fn() };

    CH.estimate(intent, cb1);
    await vi.advanceTimersByTimeAsync(400);
    await flush();
    expect(cb1.onResult).toHaveBeenCalledWith(est);

    const cb2 = { onResult: vi.fn(), onUnavailable: vi.fn() };
    CH.estimate(intent, cb2);
    expect(cb2.onResult).toHaveBeenCalledWith(est);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('dedupes two calls for the same intent while a fetch is in flight — one fetch, both onResult fire', async () => {
    const d = deferred();
    fetchMock.mockReturnValueOnce(d.promise);
    const intent = { product: 'private', legs: [{ from: 'A', to: 'B' }] };
    const cb1 = { onResult: vi.fn(), onUnavailable: vi.fn() };
    const cb2 = { onResult: vi.fn(), onUnavailable: vi.fn() };

    CH.estimate(intent, cb1);
    await vi.advanceTimersByTimeAsync(400); // debounce fires, fetch starts (unresolved)
    CH.estimate(intent, cb2); // same intent, joins the in-flight request
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const est = { totalCents: 500, amountDueNowCents: 500, estimated: false, legs: [] };
    d.resolve(jsonResponse(200, est));
    await flush();
    expect(cb1.onResult).toHaveBeenCalledWith(est);
    expect(cb2.onResult).toHaveBeenCalledWith(est);
  });

  it('404 latches unavailable; subsequent calls fire onUnavailable immediately with no fetch', async () => {
    fetchMock.mockReturnValueOnce(Promise.resolve(jsonResponse(404, {})));
    const cb1 = { onResult: vi.fn(), onUnavailable: vi.fn() };
    CH.estimate({ product: 'private', legs: [{ from: 'A', to: 'B' }] }, cb1);
    await vi.advanceTimersByTimeAsync(400);
    await flush();
    expect(cb1.onUnavailable).toHaveBeenCalledWith('flag_off');
    expect(CH.available()).toBe(false);

    const cb2 = { onResult: vi.fn(), onUnavailable: vi.fn() };
    CH.estimate({ product: 'private', legs: [{ from: 'C', to: 'D' }] }, cb2);
    expect(cb2.onUnavailable).toHaveBeenCalledWith('flag_off');
    expect(fetchMock).toHaveBeenCalledTimes(1); // no new fetch for the second call
  });

  it('a network rejection reports unavailable but leaves availability true (transient)', async () => {
    // Reject lazily (mockImplementationOnce), not a pre-built Promise.reject — a rejected
    // promise built before ch-pricing.js's own .catch is attached reports as an unhandled
    // rejection to Node in the tick before the fake-timer debounce fires.
    fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError('network down')));
    const cb1 = { onResult: vi.fn(), onUnavailable: vi.fn() };
    CH.estimate({ product: 'private', legs: [{ from: 'A', to: 'B' }] }, cb1);
    await vi.advanceTimersByTimeAsync(400);
    await flush();
    expect(cb1.onUnavailable).toHaveBeenCalled();
    expect(CH.available()).toBe(true);
  });

  it('aborts after a 3s timeout and reports unavailable, leaving availability true (transient)', async () => {
    fetchMock.mockImplementationOnce((url, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const cb1 = { onResult: vi.fn(), onUnavailable: vi.fn() };
    CH.estimate({ product: 'private', legs: [{ from: 'A', to: 'B' }] }, cb1);
    await vi.advanceTimersByTimeAsync(400); // debounce fires, fetch starts
    await vi.advanceTimersByTimeAsync(3000); // the module's own 3s deadline fires and aborts
    await flush();
    expect(cb1.onUnavailable).toHaveBeenCalled();
    expect(CH.available()).toBe(true);
    // a fresh call for the same intent must retry, not stay latched
    const cb2 = { onResult: vi.fn(), onUnavailable: vi.fn() };
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    CH.estimate({ product: 'private', legs: [{ from: 'A', to: 'B' }] }, cb2);
    await vi.advanceTimersByTimeAsync(400);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('with no API base configured, reports unavailable without fetching', () => {
    delete window.CEYLON_HOP_API;
    const cb1 = { onResult: vi.fn(), onUnavailable: vi.fn() };
    CH.estimate({ product: 'private', legs: [{ from: 'A', to: 'B' }] }, cb1);
    expect(cb1.onUnavailable).toHaveBeenCalledWith('no_api');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes est.estimated through untouched', async () => {
    const est = { totalCents: 700, amountDueNowCents: 700, estimated: true, legs: [{ from: 'A', to: 'B', distanceKm: 10, durationMin: 20 }] };
    fetchMock.mockReturnValueOnce(Promise.resolve(jsonResponse(200, est)));
    const cb1 = { onResult: vi.fn(), onUnavailable: vi.fn() };
    CH.estimate({ product: 'private', legs: [{ from: 'A', to: 'B' }] }, cb1);
    await vi.advanceTimersByTimeAsync(400);
    await flush();
    expect(cb1.onResult).toHaveBeenCalledWith(expect.objectContaining({ estimated: true }));
  });

  it('discards a late-arriving older result once a newer intent has superseded it (out-of-order guard)', async () => {
    const dA = deferred();
    const dB = deferred();
    fetchMock.mockReturnValueOnce(dA.promise).mockReturnValueOnce(dB.promise);
    const cbA = { onResult: vi.fn(), onUnavailable: vi.fn() };
    const cbB = { onResult: vi.fn(), onUnavailable: vi.fn() };

    CH.estimate({ product: 'private', legs: [{ from: 'A', to: 'B' }] }, cbA);
    await vi.advanceTimersByTimeAsync(400); // fetch #1 (intent A) in flight

    CH.estimate({ product: 'private', legs: [{ from: 'X', to: 'Y' }] }, cbB);
    await vi.advanceTimersByTimeAsync(400); // fetch #2 (intent B) in flight, supersedes A

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const estB = { totalCents: 200, amountDueNowCents: 200, estimated: false, legs: [] };
    dB.resolve(jsonResponse(200, estB));
    await flush();
    expect(cbB.onResult).toHaveBeenCalledWith(estB);

    // A's fetch lands late, after B already settled — must be discarded, not shown.
    const estA = { totalCents: 999, amountDueNowCents: 999, estimated: false, legs: [] };
    dA.resolve(jsonResponse(200, estA));
    await flush();
    expect(cbA.onResult).not.toHaveBeenCalled();
  });

  it('sessionStorage failure (private-mode quota, disabled storage) never breaks pricing — fetch still happens and onResult fires', async () => {
    // Stub both getItem and setItem to throw, simulating Safari private mode or disabled storage.
    // Use vi.spyOn(Storage.prototype, ...) to actually intercept the calls — direct assignment
    // is a no-op in jsdom due to platform-object semantics.
    const getSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    const setSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });

    try {
      const est = { totalCents: 1500, amountDueNowCents: 1500, estimated: false, legs: [] };
      fetchMock.mockReturnValueOnce(Promise.resolve(jsonResponse(200, est)));
      const cb = { onResult: vi.fn(), onUnavailable: vi.fn() };

      CH.estimate({ product: 'private', legs: [{ from: 'A', to: 'B' }] }, cb);
      await vi.advanceTimersByTimeAsync(400);
      await flush();

      // Fetch must happen despite storage failure
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // onResult must fire despite storage failure
      expect(cb.onResult).toHaveBeenCalledWith(est);
      expect(cb.onUnavailable).not.toHaveBeenCalled();
    } finally {
      // Restore original methods
      getSpy.mockRestore();
      setSpy.mockRestore();
    }
  });
});
