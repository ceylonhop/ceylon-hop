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
