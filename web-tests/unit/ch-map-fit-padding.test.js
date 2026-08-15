import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const src = readFileSync(path.join(ROOT, 'ch-map.js'), 'utf8');

// The inline route card is FORCED SHORT by its callers — plan.html pins the summary map to
// `--map-h: clamp(104px,17vh,180px)`, and drops it to 76–110px on a short laptop. A fixed
// 36px fitBounds padding (written for the 760px-tall expand modal) eats more than half of
// that box top-to-bottom, so Google zooms out until the route clears the sliver that's left
// — the frame swells past the island to southern India and the route becomes a squiggle in
// the corner. Padding has to scale to the container it's padding.
function loadChMap() {
  new Function(src)();
  return window.CH_MAP;
}

// jsdom reports 0 for every offset dimension; the renderer measures the map div it creates
// itself, so size it through the prototype rather than by reaching for the element.
const sized = (w, h) => {
  window.__testW = w;
  window.__testH = h;
};
for (const prop of ['offsetWidth', 'offsetHeight']) {
  Object.defineProperty(window.HTMLElement.prototype, prop, {
    configurable: true,
    get() { return (prop === 'offsetWidth' ? window.__testW : window.__testH) || 0; },
  });
}
afterAll(() => {
  for (const prop of ['offsetWidth', 'offsetHeight']) {
    delete window.HTMLElement.prototype[prop];
  }
});

function stubGoogle() {
  const fits = [];
  const mapOpts = [];
  function MapCls(el, opts) { mapOpts.push(opts || {}); }
  MapCls.prototype.fitBounds = function (bounds, pad) { fits.push(pad); };
  MapCls.prototype.getZoom = function () { return 8; };
  MapCls.prototype.addListener = function () { return { remove() {} }; };
  function Marker(opts) { (window.__markers = window.__markers || []).push(opts || {}); }
  Marker.prototype.setMap = function () {};
  function Point() {}
  function Polyline() {}
  Polyline.prototype.setOptions = function () {};
  Polyline.prototype.setMap = function () {};
  const Route = {
    computeRoutes: async () => ({
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
    }),
  };
  const libs = { maps: { Map: MapCls, Polyline }, routes: { Route }, marker: { Marker }, core: { Point } };
  window.google = { maps: { importLibrary: async (n) => libs[n] || {}, event: { trigger() {} } } };
  return { fits, mapOpts };
}

describe('renderRoute framing', () => {
  let stub, CH_MAP;

  beforeEach(() => {
    document.body.innerHTML = '';
    window.CEYLON_MAPS_KEY = 'test-key';
    window.__markers = [];
    delete window.CH_MAP;
    stub = stubGoogle();
    CH_MAP = loadChMap();
  });

  const host = () => {
    const d = document.createElement('div');
    document.body.appendChild(d);
    return d;
  };

  it('pads a short summary card proportionally, not with the modal constant', async () => {
    sized(272, 137); // plan.html's sticky summary at a typical laptop height
    await CH_MAP.renderRoute(host(), ['Colombo', 'Polonnaruwa', 'Ratnapura']);
    expect(stub.fits).toHaveLength(1);
    expect(stub.fits[0]).toBeLessThanOrEqual(12);
    expect(stub.fits[0]).toBeGreaterThanOrEqual(6);
  });

  it('still pads generously in the expanded modal', async () => {
    sized(1040, 700);
    await CH_MAP.renderRoute(host(), ['Colombo', 'Ella'], { greedy: true });
    expect(stub.fits[0]).toBe(36);
  });

  it('falls back to the old padding when the container has no size yet', async () => {
    sized(0, 0); // created inside a collapsed step panel; the ResizeObserver re-fits later
    await CH_MAP.renderRoute(host(), ['Colombo', 'Ella']);
    expect(stub.fits[0]).toBe(36);
  });

  // Every inline caller (plan, booking, quote) passes expandable:true, so the small card has
  // a better affordance than a +/- stack covering a third of its height.
  it('keeps the zoom control for the expanded map only', async () => {
    sized(272, 137);
    await CH_MAP.renderRoute(host(), ['Colombo', 'Ella'], { expandable: true });
    sized(1040, 700);
    await CH_MAP.renderRoute(host(), ['Colombo', 'Kandy'], { greedy: true });
    expect(stub.mapOpts.map((o) => !!o.zoomControl)).toEqual([false, true]);
  });

  // Owner's call, 2026-08-15: the brand tint shipped in #482 (cream land, pale blue water)
  // was compared against Google's default palette and the default won. The style array
  // declutters — it does not recolour. Don't reintroduce a `color` styler here.
  it('declutters the basemap without repainting it', async () => {
    sized(272, 137);
    await CH_MAP.renderRoute(host(), ['Colombo', 'Ella']);
    const styles = stub.mapOpts[0].styles;
    expect(Array.isArray(styles)).toBe(true);
    expect(JSON.stringify(styles)).toContain('poi');
    const stylers = styles.flatMap((s) => s.stylers || []);
    expect(stylers.filter((st) => 'color' in st)).toEqual([]);
    expect(stylers.every((st) => 'visibility' in st)).toBe(true);
  });

  // The inline card is a picture of the route; the modal is a map you read. Place and road
  // labels belong to the second — inline they are mostly the mainland the frame catches, and
  // the "Sri Lanka" label lands across the route line.
  // Road NAMES are clutter on a card this size; PLACE names are how a customer reads the
  // route — "does it go through Kandy?" is the question the picture has to answer. Both were
  // dropped when the card was 122px tall; the owner asked for the towns back (2026-08-15).
  it('drops road names on the card but never the town names', async () => {
    sized(272, 137);
    await CH_MAP.renderRoute(host(), ['Colombo', 'Ella']);
    sized(1040, 700);
    await CH_MAP.renderRoute(host(), ['Colombo', 'Kandy'], { greedy: true });
    const hidden = (styles, feature) => styles.some((s) =>
      s.featureType === feature && s.elementType === 'labels'
      && s.stylers.some((st) => st.visibility === 'off'));
    // road labels: off inline, on when expanded
    expect(hidden(stub.mapOpts[0].styles, 'road')).toBe(true);
    expect(hidden(stub.mapOpts[1].styles, 'road')).toBe(false);
    // place labels: on everywhere
    for (const opts of stub.mapOpts) expect(hidden(opts.styles, 'administrative')).toBe(false);
  });

  it('draws smaller pins on the inline card than in the modal', async () => {
    sized(272, 137);
    await CH_MAP.renderRoute(host(), ['Colombo', 'Ella']);
    const inline = window.__markers[0].icon.scale;
    window.__markers = [];
    sized(1040, 700);
    await CH_MAP.renderRoute(host(), ['Colombo', 'Kandy'], { greedy: true });
    expect(inline).toBeLessThan(window.__markers[0].icon.scale);
  });
});
