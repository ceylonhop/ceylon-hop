import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const src = readFileSync(path.join(ROOT, 'ch-map.js'), 'utf8');

// ch-map.js is a browser IIFE that hangs CH_MAP off window. Re-running it per test gives
// each test a fresh closure, so the module-level route cache starts empty.
function loadChMap() {
  new Function(src)();
  return window.CH_MAP;
}

// Minimal async-Maps stub: classes come only from importLibrary, mirroring the real API.
function stubGoogle() {
  const calls = [];
  function MapCls() {}
  MapCls.prototype.fitBounds = function () {};
  function Marker() {}
  function Point() {}
  function Polyline() {}
  Polyline.prototype.setOptions = function () {};
  Polyline.prototype.setMap = function () {};
  const Route = {
    computeRoutes: async (req) => {
      calls.push(req);
      return {
        routes: [{
          viewport: {},
          legs: [{
            distanceMeters: 100000,
            durationMillis: 3600000,
            startLocation: { lat: 6.93, lng: 79.85 },
            endLocation: { lat: 7.29, lng: 80.63 },
          }],
          createPolylines: () => [new Polyline()],
        }],
      };
    },
  };
  const libs = { maps: { Map: MapCls, Polyline }, routes: { Route }, marker: { Marker }, core: { Point } };
  window.google = { maps: { importLibrary: async (n) => libs[n] || {}, event: { trigger() {} } } };
  return calls;
}

describe('renderRoute route memo', () => {
  let calls, CH_MAP;

  beforeEach(() => {
    document.body.innerHTML = '';
    window.CEYLON_MAPS_KEY = 'test-key';
    delete window.CH_MAP;
    calls = stubGoogle();
    CH_MAP = loadChMap();
  });

  const host = () => {
    const d = document.createElement('div');
    document.body.appendChild(d);
    return d;
  };

  it('computes the route once for repeated renders of the same stops', async () => {
    await CH_MAP.renderRoute(host(), ['Kandy', 'Ella']);
    await CH_MAP.renderRoute(host(), ['Kandy', 'Ella']);
    expect(calls).toHaveLength(1);
  });

  it('recomputes when the stop list changes', async () => {
    await CH_MAP.renderRoute(host(), ['Kandy', 'Ella']);
    await CH_MAP.renderRoute(host(), ['Kandy', 'Galle']);
    expect(calls).toHaveLength(2);
  });

  it('is order sensitive', async () => {
    await CH_MAP.renderRoute(host(), ['Kandy', 'Ella']);
    await CH_MAP.renderRoute(host(), ['Ella', 'Kandy']);
    expect(calls).toHaveLength(2);
  });

  it('does not cache a failed route', async () => {
    // Make the FIRST computeRoutes reject, then succeed. A rejection must be evicted from
    // the cache, otherwise one transient failure poisons the route for the whole session.
    let shouldFail = true;
    const original = window.google.maps.importLibrary;
    window.google.maps.importLibrary = async (name) => {
      const lib = await original(name);
      if (name !== 'routes') return lib;
      return {
        Route: {
          computeRoutes: async (req) => {
            if (shouldFail) { calls.push(req); throw new Error('boom'); }
            return lib.Route.computeRoutes(req);
          },
        },
      };
    };
    // Reload so loadLibs() captures the wrapped routes library.
    delete window.CH_MAP;
    const CH = loadChMap();

    await CH.renderRoute(host(), ['Kandy', 'Ella'], { onFail() {} });
    expect(calls).toHaveLength(1);

    shouldFail = false;
    await CH.renderRoute(host(), ['Kandy', 'Ella'], { onFail() {} });
    expect(calls).toHaveLength(2);
  });

  // A quote's legs can be pinned to the toll-free road in ops (routeVariant: 'no_tolls').
  // The customer's map must draw the road they were quoted, not the expressway.
  it('asks for the toll-free route when a run says so', async () => {
    await CH_MAP.renderRoute(host(), ['Kandy', 'Ella'], {
      runs: [{ stops: ['Kandy', 'Ella'], avoidTolls: true }],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].routeModifiers).toEqual({ avoidTolls: true });
  });

  it('sends no route modifiers without a run — the default route, unchanged', async () => {
    await CH_MAP.renderRoute(host(), ['Kandy', 'Ella']);
    expect(calls[0].routeModifiers).toBeUndefined();
  });

  // The memo is keyed on the stop list. Two quotes over the same stops that differ only in
  // road choice would otherwise share one cached line, and the second would be drawn wrong.
  it('does not serve a cached expressway line to a toll-free request', async () => {
    await CH_MAP.renderRoute(host(), ['Kandy', 'Ella']);
    await CH_MAP.renderRoute(host(), ['Kandy', 'Ella'], {
      runs: [{ stops: ['Kandy', 'Ella'], avoidTolls: true }],
    });
    expect(calls).toHaveLength(2);
    expect(calls[1].routeModifiers).toEqual({ avoidTolls: true });
  });

  // avoidTolls is per REQUEST; routeVariant is per LEG. A journey whose legs disagree is
  // drawn as one query per run — and only then, so the common all-agree case stays one call.
  it('queries each run separately when the legs disagree', async () => {
    await CH_MAP.renderRoute(host(), ['Ella', 'Kandy', 'Colombo City'], {
      runs: [
        { stops: ['Ella', 'Kandy'], avoidTolls: true },
        { stops: ['Kandy', 'Colombo City'], avoidTolls: false, continues: true },
      ],
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].routeModifiers).toEqual({ avoidTolls: true });
    expect(calls[1].routeModifiers).toBeUndefined();
  });

  it('does not cache a routeless response', async () => {
    // The Routes API expresses "no route found" as a successful response with an EMPTY
    // `routes` array — that's not a rejection, so it must be evicted on resolution too, or
    // the first empty response would be sticky for the rest of the page load and a later
    // render (e.g. after a vehicle/date change) could never recover.
    let empty = true;
    const original = window.google.maps.importLibrary;
    window.google.maps.importLibrary = async (name) => {
      const lib = await original(name);
      if (name !== 'routes') return lib;
      return {
        Route: {
          computeRoutes: async (req) => {
            if (empty) { calls.push(req); return { routes: [] }; }
            return lib.Route.computeRoutes(req);
          },
        },
      };
    };
    // Reload so loadLibs() captures the wrapped routes library.
    delete window.CH_MAP;
    const CH = loadChMap();

    await CH.renderRoute(host(), ['Kandy', 'Ella'], { onFail() {} });
    expect(calls).toHaveLength(1);

    empty = false;
    await CH.renderRoute(host(), ['Kandy', 'Ella'], { onFail() {} });
    expect(calls).toHaveLength(2);
  });
});
