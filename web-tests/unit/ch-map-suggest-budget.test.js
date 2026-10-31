import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(__dirname, '..', '..', 'ch-map.js'), 'utf8');

// Every Places autocomplete request is billed unless the customer ends the session by picking a
// Google row — and they rarely do (Oct 2026: 11,803 requests for 216 picks). The booking, search
// and plan boxes ask on every keystroke and again on focus, which made suggestions the largest
// Maps cost after the CI fix (~$18/month). CH_MAP.suggest() therefore budgets its own requests:
// it waits for typing to pause, needs 3 characters, and never asks twice for the same text on
// one page. A call that a newer one overtakes resolves [] — every caller already drops a stale
// answer by sequence number.
function loadChMap() {
  new Function(src)();
  return window.CH_MAP;
}

function stubPlaces() {
  const calls = [];
  function AutocompleteSessionToken() {}
  const AutocompleteSuggestion = {
    fetchAutocompleteSuggestions: async ({ input }) => {
      calls.push(input);
      return {
        suggestions: [{
          placePrediction: {
            text: { text: input + ' Hotel, Galle, Sri Lanka' },
            mainText: { text: input + ' Hotel' },
            secondaryText: { text: 'Galle, Sri Lanka' },
            toPlace: () => ({ fetchFields: async () => {}, location: null }),
          },
        }],
      };
    },
  };
  window.google = {
    maps: {
      importLibrary: async (n) => (n === 'places' ? { AutocompleteSuggestion, AutocompleteSessionToken } : {}),
    },
  };
  return calls;
}

describe('CH_MAP.suggest request budget', () => {
  let calls, CH_MAP;

  beforeEach(() => {
    vi.useFakeTimers();
    window.CEYLON_MAPS_KEY = 'test-key';
    delete window.CH_MAP;
    calls = stubPlaces();
    CH_MAP = loadChMap();
  });
  afterEach(() => vi.useRealTimers());

  it('asks Google once for a burst of keystrokes, with the last text typed', async () => {
    const typed = ['Lig', 'Ligh', 'Light', 'Lighth', 'Lightho'].map((t) => CH_MAP.suggest(t));
    await vi.advanceTimersByTimeAsync(1000);
    const results = await Promise.all(typed);
    expect(calls).toEqual(['Lightho']);
    expect(results.slice(0, 4)).toEqual([[], [], [], []]);
    expect(results[4][0].main).toBe('Lightho Hotel');
  });

  it('does not answer before typing pauses', async () => {
    let done = false;
    CH_MAP.suggest('Jetwing').then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toEqual([]);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toEqual(['Jetwing']);
    expect(done).toBe(true);
  });

  it('asks again after a pause when the customer keeps typing', async () => {
    const a = CH_MAP.suggest('Jetw');
    await vi.advanceTimersByTimeAsync(1000);
    const b = CH_MAP.suggest('Jetwing Light');
    await vi.advanceTimersByTimeAsync(1000);
    expect((await a)[0].main).toBe('Jetw Hotel');
    expect((await b)[0].main).toBe('Jetwing Light Hotel');
    expect(calls).toEqual(['Jetw', 'Jetwing Light']);
  });

  it('needs three characters before asking', async () => {
    const p = CH_MAP.suggest('Ga');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('answers a repeated text from memory — refocusing the box costs nothing', async () => {
    const first = CH_MAP.suggest('Amangalla');
    await vi.advanceTimersByTimeAsync(1000);
    await first;
    const again = await CH_MAP.suggest('  amangalla ');
    expect(again[0].main).toBe('Amangalla Hotel');
    expect(calls).toEqual(['Amangalla']);
  });

  it('forgets remembered answers once a pick ends the billing session', async () => {
    const first = CH_MAP.suggest('Amangalla');
    await vi.advanceTimersByTimeAsync(1000);
    const [row] = await first;
    await CH_MAP.resolvePick(row);
    const again = CH_MAP.suggest('Amangalla');
    await vi.advanceTimersByTimeAsync(1000);
    await again;
    expect(calls).toEqual(['Amangalla', 'Amangalla']);
  });
});
