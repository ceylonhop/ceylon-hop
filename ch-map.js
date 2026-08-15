// Shared Google Maps (JavaScript API) route renderer used by booking.js + plan.js.
// Draws a clean route line with a pick-up + drop-off pin, fits the whole route in view,
// and shows a loading skeleton while the API loads and the route resolves. Falls back to
// the caller's SVG placeholder when there's no key, the API isn't enabled, or routing fails.
(function () {
  let loaderPromise = null;

  function ensureStyle() {
    if (document.getElementById('ch-map-style')) return;
    const st = document.createElement('style');
    st.id = 'ch-map-style';
    st.textContent =
      '.ch-map-wrap{position:relative;width:100%;height:260px;overflow:hidden}' +
      // map renders at full size/opacity from the start (so tiles actually load); the loader
      // overlay sits on top and fades out once the route is ready.
      '.ch-map-wrap .ch-map-gmap{position:absolute;inset:0}' +
      '.ch-map-load{position:absolute;inset:0;z-index:2;display:flex;flex-direction:column;align-items:center;' +
      'justify-content:center;gap:11px;background:linear-gradient(170deg,#eaf4f1,#dfeee9);' +
      'color:#24758A;font-family:var(--body,system-ui,sans-serif);font-weight:600;font-size:.82rem;transition:opacity .4s ease}' +
      '.ch-map-wrap.ready .ch-map-load{opacity:0;pointer-events:none}' +
      '.ch-map-spin{width:26px;height:26px;border-radius:50%;border:3px solid #c3dde8;' +
      'border-top-color:#24758A;animation:chSpin .8s linear infinite}' +
      '@keyframes chSpin{to{transform:rotate(360deg)}}' +
      '.ch-map-expand{position:absolute;top:10px;right:10px;z-index:3;display:inline-flex;align-items:center;' +
      'gap:6px;padding:7px 11px;border:0;border-radius:999px;background:rgba(255,255,255,.96);color:#24758A;' +
      'font-family:var(--body,system-ui,sans-serif);font-weight:700;font-size:.76rem;cursor:pointer;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.18)}' +
      '.ch-map-expand:hover{background:#fff}' +
      '.ch-map-expand svg{width:13px;height:13px}' +
      '.ch-map-modal{position:fixed;inset:0;z-index:400;background:rgba(20,30,28,.55);display:flex;' +
      'align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(3px)}' +
      '.ch-map-modal-card{background:#fff;border-radius:18px;box-shadow:0 30px 80px rgba(0,0,0,.3);' +
      'width:min(1120px,94vw);height:min(760px,88vh);display:flex;flex-direction:column;overflow:hidden}' +
      '.ch-map-modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;' +
      'padding:14px 18px;border-bottom:1px solid #e6ebe8;font-family:var(--body,system-ui,sans-serif)}' +
      '.ch-map-modal-body{flex:1;display:flex;min-height:0}' +
      '.ch-map-modal-map{flex:1;position:relative;min-width:0}' +
      '.ch-map-modal-map .ch-map-wrap{height:100%}' +
      '.ch-map-close{border:0;background:#f1f5f3;border-radius:50%;width:32px;height:32px;cursor:pointer;' +
      'font-size:1.15rem;line-height:1;color:#2b3a35}' +
      '.ch-map-legend{width:248px;flex:none;border-left:1px solid #e6ebe8;overflow:auto;padding:14px 16px;' +
      'font-family:var(--body,system-ui,sans-serif)}' +
      '.ch-map-legend ol{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}' +
      '.ch-map-legend li{display:flex;align-items:center;gap:10px;font-size:.86rem;color:#2b3a35}' +
      '.ch-map-legend .ch-lg-n{width:22px;height:22px;border-radius:50%;flex:none;display:grid;' +
      'place-items:center;color:#fff;font-weight:700;font-size:.72rem}' +
      '@media(max-width:760px){.ch-map-modal{padding:0}' +
      '.ch-map-modal-card{width:100vw;height:100dvh;border-radius:0}' +
      '.ch-map-modal-body{flex-direction:column}' +
      '.ch-map-legend{width:auto;border-left:0;border-top:1px solid #e6ebe8;max-height:34vh}}';
    document.head.appendChild(st);
  }

  function loadJs(key) {
    if (window.google && window.google.maps && window.google.maps.importLibrary) return Promise.resolve();
    if (loaderPromise) return loaderPromise;
    loaderPromise = new Promise((resolve, reject) => {
      window.__chMapsReady = () => resolve();
      const s = document.createElement('script');
      s.src =
        'https://maps.googleapis.com/maps/api/js?key=' +
        encodeURIComponent(key) +
        '&callback=__chMapsReady&loading=async';
      s.async = true;
      s.onerror = () => reject(new Error('maps_load_failed'));
      document.head.appendChild(s);
    });
    return loaderPromise;
  }

  // The async-loaded Maps API exposes classes only via importLibrary; pull the libraries the
  // route renderer needs once. A failed import stays rejected → callers fall back to SVG.
  let libsPromise = null;
  function loadLibs() {
    if (libsPromise) return libsPromise;
    libsPromise = Promise.all([
      google.maps.importLibrary('maps'),
      google.maps.importLibrary('routes'),
      google.maps.importLibrary('marker'),
      google.maps.importLibrary('core'),
    ]).then(([m, r, mk, c]) => {
      // LatLngBounds is deliberately NOT in the required set below: only a journey split across
      // several route queries needs it (to union their viewports), and that case degrades to the
      // first viewport. Requiring it would turn a partial API load into an SVG fallback.
      const libs = { Map: m.Map, Route: r.Route, Marker: mk.Marker, Point: c.Point, LatLngBounds: c.LatLngBounds };
      if (!libs.Map || !libs.Route || !libs.Marker || !libs.Point) throw new Error('maps_libs_missing');
      return libs;
    });
    return libsPromise;
  }

  // Place names → geocodable query (drop "(CMB)"/slashes, anchor to Sri Lanka).
  const q = (s) => (s || '').replace(/\s*\([^)]*\)/, '').replace(/\s*\/\s*/g, ' ').trim() + ', Sri Lanka';
  // A stop may be a name string OR a {lat,lng} from a picked Places result —
  // exact coords route more accurately than re-geocoding the name.
  const toLoc = (s) => (s && typeof s === 'object' && s.lat != null) ? { lat: s.lat, lng: s.lng } : q(s);

  // computeRoutes() is billable and today every renderRoute() re-runs it — on each inline
  // re-render, and again when the expand modal opens. Memoise per page load, keyed on the
  // ordered stop list. The PROMISE is cached so concurrent callers share one request; a
  // rejection is evicted so a transient failure isn't cached for the rest of the session.
  const routeCache = new Map();
  /* Group the journey's stops into PINS. A round trip's last stop lands on its first, so a pin
     per STOP means the last is drawn over the first and hides it — the customer sees a map that
     appears to start numbering at 2 (owner-reported on the ops map, 2026-08-06; this file had the
     identical bug). One pin per PLACE, carrying every stop number that lands there: "1·3".

     Tolerance ~50 m because Google snaps to the road network, so a return leg can finish metres
     from where it started — tight enough that two hotels on one strip stay separate pins.

     DELIBERATE SECOND COPY of mapPins() in api/src/routes/ops-ui.html. The ops shell is a
     self-contained single-file app served from a different origin and cannot import this file;
     there is no shared runtime to put this in. Change one, change both — the pair is covered by
     web-tests/unit/ops-map-pins.test.js and web-tests/unit/ch-map-pins.test.js. */
  function mapPins(pts, zoom) {
    var SAME_PLACE = 0.0005;   // ~50 m — one place, merged at EVERY zoom (a round trip's start/end)
    var MERGE_PX = 34;         // a pin head — closer than this and the labels collide on screen
    // Web Mercator world pixels, so "do these collide?" is asked in the units the eye actually uses.
    var px = function (p) {
      var scale = 256 * Math.pow(2, zoom);
      var s = Math.max(-0.9999, Math.min(0.9999, Math.sin(p.lat * Math.PI / 180)));
      return {
        x: (p.lng + 180) / 360 * scale,
        y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale
      };
    };
    var collide = function (a, b) {
      if (Math.abs(a.lat - b.lat) < SAME_PLACE && Math.abs(a.lng - b.lng) < SAME_PLACE) return true;
      if (typeof zoom !== 'number') return false;
      var pa = px(a), pb = px(b), dx = pa.x - pb.x, dy = pa.y - pb.y;
      return Math.sqrt(dx * dx + dy * dy) < MERGE_PX;
    };
    var pins = [];
    (pts || []).forEach(function (loc, i) {
      var hit = null;
      for (var k = 0; k < pins.length; k++) { if (collide(pins[k], loc)) { hit = pins[k]; break; } }
      if (hit) hit.stops.push(i + 1);
      else pins.push({ lat: loc.lat, lng: loc.lng, stops: [i + 1] });
    });
    var last = (pts || []).length;
    return pins.map(function (p) {
      // A consecutive run reads as a range ("3–7"); a revisited place keeps its dots ("1·3").
      var runs = p.stops.length > 2 && p.stops[p.stops.length - 1] - p.stops[0] === p.stops.length - 1;
      return {
        lat: p.lat, lng: p.lng, stops: p.stops,
        text: p.stops.length === 1 ? String(p.stops[0])
          : (runs || p.stops.length === 2) && p.stops[p.stops.length - 1] - p.stops[0] === p.stops.length - 1
            ? p.stops[0] + '–' + p.stops[p.stops.length - 1]
            : p.stops.join('·'),
        isFirst: p.stops.indexOf(1) >= 0,
        isLast: p.stops.indexOf(last) >= 0
      };
    });
  }

  /* DECLUTTER ONLY — no recolouring. Google's own land/water palette stays: the owner
     compared it against a cream-and-pale-blue brand tint (shipped in #482) and preferred the
     default, 2026-08-15. Don't repaint the basemap; the route line and pins are where the
     brand belongs. What stays off is noise, not colour: POI pins, transit, state borders,
     sea labels. Classic `styles` works because these maps set no mapId — adding one would
     silently disable all of this.

     `detailed` (the expanded modal) keeps road labels: at street zoom a map with no road
     names reads as broken. The inline card drops them — at country zoom they are noise over
     a route line that is the whole point of the picture. */
  function mapStyle(detailed) {
    const s = [
      { featureType: 'poi', stylers: [{ visibility: 'off' }] },
      { featureType: 'transit', stylers: [{ visibility: 'off' }] },
      { featureType: 'administrative', elementType: 'geometry', stylers: [{ visibility: 'off' }] },
      { featureType: 'water', elementType: 'labels', stylers: [{ visibility: 'off' }] },
    ];
    if (!detailed) {
      s.push({ featureType: 'road', elementType: 'labels', stylers: [{ visibility: 'off' }] });
      // A landscape card framing a north–south island always catches some of the mainland, and
      // the styler can't scope labels by country — so at this size "Thiruvananthapuram" was the
      // biggest word on a Sri Lanka trip map, and the "Sri Lanka" label itself lands across the
      // route line. Inline the map is a PICTURE of the route: shape, line, pins, no type. The
      // expanded map (detailed) keeps every label.
      s.push({ featureType: 'administrative', elementType: 'labels', stylers: [{ visibility: 'off' }] });
    }
    return s;
  }

  /* fitBounds padding has to SCALE to the box it is padding. The old flat 36px was written
     for the 760px-tall expand modal; the inline callers force a far shorter card (plan.html
     pins the summary map to `--map-h: clamp(104px,17vh,180px)`, and 76–110px on a short
     laptop), where 36px top + bottom eats more than half the height. Google then zooms out
     until the route clears the sliver that remains — the frame swells past the island to
     southern India and the route shrinks into a corner (owner-reported, 2026-08-14).

     6% of the smaller dimension, floored at 6px so a pin never sits flush against an edge and
     capped at the old 36 so the modal is unchanged. A container with no size yet (created
     inside a collapsed step panel) keeps 36; the ResizeObserver re-fits once it has one. */
  function fitPadding(w, h) {
    const min = Math.min(w || 0, h || 0);
    if (!min) return 36;
    return Math.max(6, Math.min(36, Math.round(min * 0.06)));
  }

  function pinLabelsVisible(zoom) {
    // Below a regional view a long itinerary is a wall of unreadable digits, and the route line is
    // the story anyway — the expanded map's legend still carries the full numbered order.
    return typeof zoom !== 'number' || zoom >= 9;
  }

  // avoidTolls is PART of the key. A quote pinned to the local road in ops and one over the
  // same stops on the expressway are two different lines; sharing a cache entry would draw
  // whichever was asked for first, for both.
  function computeRouteCached(Route, stops, avoidTolls) {
    const key = JSON.stringify([stops.map(toLoc), !!avoidTolls]);
    const hit = routeCache.get(key);
    if (hit) return hit;
    const p = Route.computeRoutes({
      origin: toLoc(stops[0]),
      destination: toLoc(stops[stops.length - 1]),
      intermediates: stops.slice(1, -1).map((n) => ({ location: toLoc(n) })),
      travelMode: 'DRIVING',
      region: 'lk',
      routeModifiers: avoidTolls ? { avoidTolls: true } : undefined,
      fields: ['path', 'legs', 'viewport'],
    });
    // Evict BOTH a rejection and a routeless resolution. The Routes API reports "no route
    // found" as a SUCCESSFUL response with an empty routes array, so caching that would pin
    // the failure for the whole page load — on booking that means onRoute never fires again
    // and the summary stays stuck on the offline distance estimate, with no self-heal on a
    // later vehicle or date change.
    p.then(
      (res) => { if (!(res && res.routes && res.routes[0])) routeCache.delete(key); },
      () => routeCache.delete(key),
    );
    routeCache.set(key, p);
    return p;
  }

  // View-only expanded map. Creates its OWN map instance rather than re-parenting the inline
  // one: plan.js re-renders the inline map whenever trip state changes, which would yank the
  // node out from under an open modal. The route memo makes the second instance cheap.
  function openExpanded(stops, opts) {
    opts = opts || {};
    // There is deliberately no focus trap, so the background Expand button stays tabbable —
    // Enter on it (or a fast double-click) would otherwise stack a second modal.
    if (document.querySelector('.ch-map-modal')) return;
    const prevFocus = document.activeElement;
    const prevOverflow = document.body.style.overflow;

    // A stop is a name string OR a {lat,lng} picked from Places. Callers that pass coords
    // (booking.js) supply opts.stopLabels so the legend can still name them.
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const labelFor = (stop, i) => {
      const given = opts.stopLabels && opts.stopLabels[i];
      if (given) return String(given).replace(/\s*\(.*?\)/, '');
      if (typeof stop === 'string') return stop.replace(/\s*\(.*?\)/, '');
      return 'Stop ' + (i + 1);
    };
    const legend = stops.map((s, i) => {
      const fill = i === 0 ? '#24758A' : i === stops.length - 1 ? '#EC3A24' : '#0AB9B6';
      return '<li><span class="ch-lg-n" style="background:' + fill + '">' + (i + 1) + '</span>' +
             '<span>' + esc(labelFor(s, i)) + '</span></li>';
    }).join('');

    const modal = document.createElement('div');
    modal.className = 'ch-map-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Your route, expanded');
    modal.innerHTML =
      '<div class="ch-map-modal-card">' +
        '<div class="ch-map-modal-head"><strong>Your route</strong>' +
        '<button type="button" class="ch-map-close" aria-label="Close map">×</button></div>' +
        '<div class="ch-map-modal-body"><div class="ch-map-modal-map"></div>' +
        '<aside class="ch-map-legend"><ol>' + legend + '</ol></aside></div>' +
      '</div>';

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      if (modal.parentNode) modal.remove();
      // plan.js re-renders the inline map whenever trip state changes (see the comment above
      // openExpanded), which can destroy prevFocus and build a new expand button while the
      // modal is open. A detached node's focus() is a silent no-op, so check isConnected and
      // fall back to whatever expand button currently exists — focus lands somewhere sensible
      // and adjacent instead of being dropped to <body>.
      const target = (prevFocus && prevFocus.isConnected) ? prevFocus : document.querySelector('.ch-map-expand');
      if (target && target.focus) target.focus();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };

    document.addEventListener('keydown', onKey);
    modal.addEventListener('mousedown', (e) => { if (e.target === modal) close(); });
    modal.querySelector('.ch-map-close').addEventListener('click', close);

    document.body.style.overflow = 'hidden';
    document.body.appendChild(modal);
    modal.querySelector('.ch-map-close').focus();

    // No expandable flag here — never nest a modal inside a modal. A failure closes back to
    // the inline card rather than stranding an empty box.
    renderRoute(modal.querySelector('.ch-map-modal-map'), stops, { greedy: true, onFail: close, runs: opts.runs });
    return close;
  }

  // host: container element. names: ordered place-name strings (>=2). opts.onFail: SVG fallback.
  async function renderRoute(host, names, opts) {
    opts = opts || {};
    const key = window.CEYLON_MAPS_KEY;
    // Drop the labels for any falsy stop in lockstep, so the legend can never shift out of
    // alignment with the stops it is naming. Callers build stopLabels from their pre-filter
    // list, so filtering the stops alone would leave the two arrays off by one.
    const keep = (names || []).map((n) => !!n);
    const stops = (names || []).filter(Boolean);
    const stopLabels = opts.stopLabels ? opts.stopLabels.filter((_, i) => keep[i]) : undefined;
    // opts.runs: [{stops, avoidTolls, continues}] — the journey split into stretches that each
    // need their own route query, because avoidTolls is a per-REQUEST modifier while the road
    // choice is per LEG. Callers without a road choice pass none and get the single default run
    // this has always drawn. Runs too short to route are dropped; if that leaves nothing, fall
    // back to the whole stop list rather than showing no map at all.
    const given = (opts.runs || []).filter((r) => r && (r.stops || []).length >= 2);
    const runs = given.length ? given : [{ stops, avoidTolls: false, continues: false }];
    if (!key || stops.length < 2) {
      if (opts.onFail) opts.onFail();
      return;
    }
    ensureStyle();
    host.innerHTML =
      '<div class="ch-map-wrap"><div class="ch-map-gmap"></div>' +
      '<div class="ch-map-load"><div class="ch-map-spin"></div><span>Loading map…</span></div></div>';
    const wrap = host.firstElementChild;
    const mapDiv = wrap.querySelector('.ch-map-gmap');

    let done = false;
    const fail = () => {
      if (done) return;
      done = true;
      if (opts.onFail) opts.onFail();
    };
    const timer = setTimeout(fail, 12000); // never spin forever

    try {
      await loadJs(key);
      const libs = await loadLibs();
      const map = new libs.Map(mapDiv, {
        // explicit centre/zoom on Sri Lanka so base tiles load immediately —
        // the renderer re-fits to the route once it resolves (avoids grey tiles).
        center: { lat: 7.87, lng: 80.77 },
        zoom: 7,
        disableDefaultUI: true,
        // Only the expanded map gets a +/- stack. On the inline card it covers a third of a
        // ~137px-tall box to duplicate an affordance the Expand pill already offers — and
        // every inline caller (plan, booking, quote) passes expandable:true.
        zoomControl: !!opts.greedy,
        clickableIcons: false,
        styles: mapStyle(!!opts.greedy),
        // The inline card stays 'cooperative' so it never hijacks page scroll. The expand
        // modal passes greedy:true, which is the whole point of expanding — one-finger drag
        // and plain wheel zoom.
        gestureHandling: opts.greedy ? 'greedy' : 'cooperative',
      });
      // One query per RUN. A run is a stretch of the journey drawn with one set of route
      // modifiers; callers that know the quote's per-leg road choice (quote.html, from the
      // view's mapRuns) pass them in, and everyone else gets the single default run this
      // has always drawn — same one request, same line.
      const settled = await Promise.all(runs.map((run) =>
        computeRouteCached(libs.Route, run.stops, run.avoidTolls)
          .then((res) => (res && res.routes && res.routes[0]) || null)
          .catch(() => null)));
      if (done) return;
      clearTimeout(timer);
      // All or nothing, as this has always been: half a journey drawn with the rest silently
      // missing reads as a complete route to a customer, and the SVG island is the honest
      // failure. (The ops map makes the opposite call — it is a working surface, not a promise.)
      if (settled.some((r) => !r)) {
        fail();
        return;
      }
      done = true;
      wrap.classList.add('ready');
      // Only on a real, successful Google map — never over the loading spinner, and never on
      // the SVG island fallback (which replaces this whole wrap).
      if (opts.expandable) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ch-map-expand';
        btn.setAttribute('aria-label', 'Expand map');
        btn.innerHTML =
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" ' +
          'stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg><span>Expand</span>';
        // The expanded map must draw the same roads as the card it expands — pass the runs on.
        btn.addEventListener('click', () => openExpanded(stops, { stopLabels, runs: opts.runs }));
        wrap.appendChild(btn);
      }
      // Route line styled like the old DirectionsRenderer line (each render gets a fresh
      // map, so there's no previous line to clear).
      settled.forEach((r) => {
        r.createPolylines().forEach((p) => {
          p.setOptions({ strokeColor: '#0AB9B6', strokeWeight: 5, strokeOpacity: 0.92 });
          p.setMap(map);
        });
      });

      // Brand pin at EVERY stop, not just the endpoints (createWaypointAdvancedMarkers
      // needs a map ID, so we keep our own pins). One pin per stop = the start of the first
      // leg, then the end of each leg. Green = pick-up, orange = final drop-off, teal for
      // every stop in between — matches the summary's numbered route.
      try {
        const pin = (fill) => ({
          path: 'M12 2C7.6 2 4 5.6 4 10c0 5.6 8 12 8 12s8-6.4 8-12c0-4.4-3.6-8-8-8z',
          fillColor: fill, fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 2,
          // 1.5 is a modal-sized pin; on the short inline card three of them swamp the island
          // they are supposed to sit on. (anchor/labelOrigin are path units — scale-invariant.)
          scale: opts.greedy ? 1.5 : 1.1,
          anchor: new libs.Point(12, 22), labelOrigin: new libs.Point(12, 10),
        });
        const at = (loc) => ({ lat: loc.lat, lng: loc.lng }); // DirectionalLocation → LatLngLiteral
        const stopLocs = [];
        settled.forEach((r, i) => {
          const rlegs = r.legs || [];
          if (!rlegs.length) return;
          // A run split off from the one before it (a road-choice change) SHARES its first stop
          // with that run's last, so pinning it again double-counts the stop — mapPins() merges
          // the pair and the label reads "2·3" where the journey has a plain stop 2.
          if (!(i > 0 && runs[i].continues)) stopLocs.push(at(rlegs[0].startLocation));
          rlegs.forEach((l) => stopLocs.push(at(l.endLocation)));
        });
        // One pin per PLACE, not per stop — see mapPins(). Redrawn on zoom, because whether two
        // pins collide is a question about SCREEN distance and the answer changes as you zoom.
        let drawn = [];
        const drawPins = () => {
          drawn.forEach((m) => m.setMap(null));
          drawn = [];
          const z = map.getZoom();
          const showText = pinLabelsVisible(z);
          mapPins(stopLocs, z).forEach((p) => {
            drawn.push(new libs.Marker({
              map, position: { lat: p.lat, lng: p.lng }, zIndex: 5,
              icon: pin(p.isFirst ? '#24758A' : p.isLast ? '#EC3A24' : '#0AB9B6'),
              // The number ties each pin to the stops legend — without it the pins are
              // anonymous and "is stop 3 the right place?" can't be answered. Hidden at country
              // zoom, where a long itinerary is an unreadable wall of digits and the legend
              // carries the order anyway.
              label: showText
                ? { text: p.text, color: '#ffffff', fontSize: p.text.length > 2 ? '9px' : '11px', fontWeight: '700' }
                : undefined,
              // The title is the full truth even when the label is hidden.
              title: p.stops.length > 1
                ? 'Stops ' + p.stops.join(', ')
                : (p.isFirst ? 'Pick-up' : p.isLast ? 'Drop-off' : 'Stop ' + p.stops[0]),
            }));
          });
        };
        drawPins();
        map.addListener('zoom_changed', drawPins);
      } catch (e) { /* markers are non-essential */ }

      // Fit the whole route in view, and re-fit if the container gains its size later:
      // the map can be created while its step panel is still collapsed (0-width), which
      // otherwise leaves grey tiles + a tiny un-fitted route.
      // Across runs, union the viewports so a split journey isn't framed on its first stretch.
      // LatLngBounds is guarded rather than required: loadLibs() has never demanded it, and a
      // partial API load (or a test stub) must degrade to the first viewport, not throw.
      const viewport = () => {
        const vps = settled.map((r) => r.viewport).filter(Boolean);
        if (vps.length < 2 || !libs.LatLngBounds) return vps[0];
        try {
          const b = new libs.LatLngBounds();
          vps.forEach((v) => b.union(v));
          return b;
        } catch (e) { return vps[0]; }
      };
      const fitTo = viewport();
      // Measured at fit time, not once: the ResizeObserver below re-fits when the container
      // finally gains its size, and the padding must be re-derived from the new box.
      const fit = () => {
        if (fitTo) map.fitBounds(fitTo, fitPadding(mapDiv.offsetWidth, mapDiv.offsetHeight));
      };
      fit();
      if (window.ResizeObserver) {
        let lastW = mapDiv.offsetWidth;
        const ro = new ResizeObserver(() => {
          if (mapDiv.offsetWidth && mapDiv.offsetWidth !== lastW) {
            lastW = mapDiv.offsetWidth;
            // Legacy "resize" nudge — a no-op on the modern async-loaded API (maps
            // auto-handle container resize), and google.maps.event isn't always present
            // (partial API load, ad-blockers, headless/test stubs). Guard it so the
            // ResizeObserver never throws; fit() below does the actual re-fit regardless.
            if (google.maps.event && typeof google.maps.event.trigger === 'function') {
              google.maps.event.trigger(map, 'resize');
            }
            fit();
          }
        });
        ro.observe(mapDiv);
      }
      // report the REAL road distance + drive time so callers can show a
      // figure that matches the route on the map (not an offline estimate).
      if (opts.onRoute) {
        try {
          let meters = 0, ms = 0;
          settled.forEach((r) => (r.legs || []).forEach((l) => {
            meters += l.distanceMeters || 0;
            ms += l.durationMillis || 0;
          }));
          opts.onRoute({ km: Math.round(meters / 1000), durationMin: Math.round(ms / 60000) });
        } catch (e) { /* leave the estimate in place */ }
      }
    } catch (e) {
      clearTimeout(timer);
      fail();
    }
  }

  async function routeStats(names) {
    const key = window.CEYLON_MAPS_KEY;
    const stops = (names || []).filter(Boolean);
    if (!key || stops.length < 2) return null;
    try {
      await loadJs(key);
      // Stats only — import just the routes library (no map/marker classes needed), and
      // request only the legs field so we're not billed for path/viewport we won't use.
      const { Route } = await google.maps.importLibrary('routes');
      const res = await Route.computeRoutes({
        origin: toLoc(stops[0]),
        destination: toLoc(stops[stops.length - 1]),
        intermediates: stops.slice(1, -1).map((s) => ({ location: toLoc(s) })),
        travelMode: 'DRIVING',
        region: 'lk',
        fields: ['legs'],
      });
      const r0 = res && res.routes && res.routes[0];
      if (!r0) return null;
      let meters = 0, ms = 0;
      (r0.legs || []).forEach((l) => {
        meters += l.distanceMeters || 0;
        ms += l.durationMillis || 0;
      });
      return { km: Math.round(meters / 1000), durationMin: Math.round(ms / 60000) };
    } catch (e) {
      // Transient failures (over-quota, network, rejected computeRoutes) collapse to null —
      // callers treat null as "no answer yet", never as a cacheable result (plan-live-km spec).
      return null;
    }
  }

  // ---- Places autocomplete (new Places API) ----
  let placesReady = null;
  let sessionToken = null;
  const ftext = (x) => (x && x.text != null ? x.text : x ? String(x) : '');

  function loadPlaces(key) {
    if (placesReady) return placesReady;
    placesReady = loadJs(key).then(() => google.maps.importLibrary('places'));
    return placesReady;
  }

  // Live suggestions restricted to Sri Lanka. Returns [] on any failure so the
  // caller can fall back to its offline list.
  async function suggest(input) {
    const key = window.CEYLON_MAPS_KEY;
    const text = (input || '').trim();
    if (!key || text.length < 1) return [];
    try {
      const { AutocompleteSuggestion, AutocompleteSessionToken } = await loadPlaces(key);
      if (!sessionToken) sessionToken = new AutocompleteSessionToken();
      const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions({
        input: text,
        includedRegionCodes: ['lk'],
        sessionToken,
      });
      return (suggestions || [])
        .map((s) => s.placePrediction)
        .filter(Boolean)
        .map((p) => ({
          text: ftext(p.text),
          main: ftext(p.mainText) || ftext(p.text),
          secondary: ftext(p.secondaryText),
          _p: p,
        }));
    } catch (e) {
      return [];
    }
  }

  // Resolve a picked suggestion to coordinates; ends the billing session.
  async function resolvePick(item) {
    try {
      const place = item._p.toPlace();
      await place.fetchFields({ fields: ['location', 'displayName', 'formattedAddress'] });
      sessionToken = null;
      const loc = place.location;
      return {
        name: item.main || place.displayName || (place.formattedAddress || '').split(',')[0],
        address: place.formattedAddress || '',
        lat: loc ? loc.lat() : null,
        lng: loc ? loc.lng() : null,
      };
    } catch (e) {
      sessionToken = null;
      return null;
    }
  }

  window.CH_MAP = { renderRoute, suggest, resolvePick, routeStats };
})();
