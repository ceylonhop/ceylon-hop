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
      'color:#0a7d6f;font-family:var(--body,system-ui,sans-serif);font-weight:600;font-size:.82rem;transition:opacity .4s ease}' +
      '.ch-map-wrap.ready .ch-map-load{opacity:0;pointer-events:none}' +
      '.ch-map-spin{width:26px;height:26px;border-radius:50%;border:3px solid #bfe0d6;' +
      'border-top-color:#0a7d6f;animation:chSpin .8s linear infinite}' +
      '@keyframes chSpin{to{transform:rotate(360deg)}}';
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
      const libs = { Map: m.Map, Route: r.Route, Marker: mk.Marker, Point: c.Point };
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

  // host: container element. names: ordered place-name strings (>=2). opts.onFail: SVG fallback.
  async function renderRoute(host, names, opts) {
    opts = opts || {};
    const key = window.CEYLON_MAPS_KEY;
    const stops = (names || []).filter(Boolean);
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
        zoomControl: true,
        clickableIcons: false,
        gestureHandling: 'cooperative',
      });
      let route = null;
      try {
        const res = await libs.Route.computeRoutes({
          origin: toLoc(stops[0]),
          destination: toLoc(stops[stops.length - 1]),
          intermediates: stops.slice(1, -1).map((n) => ({ location: toLoc(n) })),
          travelMode: 'DRIVING',
          region: 'lk',
          fields: ['path', 'legs', 'viewport'],
        });
        route = res && res.routes && res.routes[0];
      } catch (e) { /* unroutable → fail() below */ }
      if (done) return;
      clearTimeout(timer);
      if (!route) {
        fail();
        return;
      }
      done = true;
      wrap.classList.add('ready');
      // Route line styled like the old DirectionsRenderer line (each render gets a fresh
      // map, so there's no previous line to clear).
      route.createPolylines().forEach((p) => {
        p.setOptions({ strokeColor: '#0AB9B6', strokeWeight: 5, strokeOpacity: 0.92 });
        p.setMap(map);
      });

      // Brand pin at EVERY stop, not just the endpoints (createWaypointAdvancedMarkers
      // needs a map ID, so we keep our own pins). One pin per stop = the start of the first
      // leg, then the end of each leg. Green = pick-up, orange = final drop-off, teal for
      // every stop in between — matches the summary's numbered route.
      try {
        const rlegs = route.legs;
        const pin = (fill) => ({
          path: 'M12 2C7.6 2 4 5.6 4 10c0 5.6 8 12 8 12s8-6.4 8-12c0-4.4-3.6-8-8-8z',
          fillColor: fill, fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 2,
          scale: 1.5, anchor: new libs.Point(12, 22),
        });
        const at = (loc) => ({ lat: loc.lat, lng: loc.lng }); // DirectionalLocation → LatLngLiteral
        const stopLocs = [at(rlegs[0].startLocation)].concat(rlegs.map((l) => at(l.endLocation)));
        stopLocs.forEach((pos, i) => {
          const first = i === 0, last = i === stopLocs.length - 1;
          new libs.Marker({
            map, position: pos, zIndex: 5,
            icon: pin(first ? '#0a7d6f' : last ? '#e8623a' : '#0AB9B6'),
            title: first ? 'Pick-up' : last ? 'Drop-off' : 'Stop ' + (i + 1),
          });
        });
      } catch (e) { /* markers are non-essential */ }

      // Fit the whole route in view, and re-fit if the container gains its size later:
      // the map can be created while its step panel is still collapsed (0-width), which
      // otherwise leaves grey tiles + a tiny un-fitted route.
      const fit = () => { if (route.viewport) map.fitBounds(route.viewport, 36); };
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
          const legs = route.legs || [];
          let meters = 0, ms = 0;
          legs.forEach((l) => {
            meters += l.distanceMeters || 0;
            ms += l.durationMillis || 0;
          });
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
