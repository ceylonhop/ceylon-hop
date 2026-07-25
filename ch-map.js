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
      '@keyframes chSpin{to{transform:rotate(360deg)}}' +
      '.ch-map-expand{position:absolute;top:10px;right:10px;z-index:3;display:inline-flex;align-items:center;' +
      'gap:6px;padding:7px 11px;border:0;border-radius:999px;background:rgba(255,255,255,.96);color:#0a7d6f;' +
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
      '@media(max-width:760px){.ch-map-modal{padding:0}' +
      '.ch-map-modal-card{width:100vw;height:100dvh;border-radius:0}' +
      '.ch-map-modal-body{flex-direction:column}}';
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

  // computeRoutes() is billable and today every renderRoute() re-runs it — on each inline
  // re-render, and again when the expand modal opens. Memoise per page load, keyed on the
  // ordered stop list. The PROMISE is cached so concurrent callers share one request; a
  // rejection is evicted so a transient failure isn't cached for the rest of the session.
  const routeCache = new Map();
  function computeRouteCached(Route, stops) {
    const key = JSON.stringify(stops.map(toLoc));
    const hit = routeCache.get(key);
    if (hit) return hit;
    const p = Route.computeRoutes({
      origin: toLoc(stops[0]),
      destination: toLoc(stops[stops.length - 1]),
      intermediates: stops.slice(1, -1).map((n) => ({ location: toLoc(n) })),
      travelMode: 'DRIVING',
      region: 'lk',
      fields: ['path', 'legs', 'viewport'],
    });
    p.catch(() => routeCache.delete(key));
    routeCache.set(key, p);
    return p;
  }

  // View-only expanded map. Creates its OWN map instance rather than re-parenting the inline
  // one: plan.js re-renders the inline map whenever trip state changes, which would yank the
  // node out from under an open modal. The route memo makes the second instance cheap.
  function openExpanded(stops, opts) {
    opts = opts || {};
    const prevFocus = document.activeElement;
    const prevOverflow = document.body.style.overflow;

    const modal = document.createElement('div');
    modal.className = 'ch-map-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Your route, expanded');
    modal.innerHTML =
      '<div class="ch-map-modal-card">' +
        '<div class="ch-map-modal-head"><strong>Your route</strong>' +
        '<button type="button" class="ch-map-close" aria-label="Close map">×</button></div>' +
        '<div class="ch-map-modal-body"><div class="ch-map-modal-map"></div></div>' +
      '</div>';

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      if (modal.parentNode) modal.remove();
      if (prevFocus && prevFocus.focus) prevFocus.focus();
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
    renderRoute(modal.querySelector('.ch-map-modal-map'), stops, { greedy: true, onFail: close });
    return close;
  }

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
        // The inline card stays 'cooperative' so it never hijacks page scroll. The expand
        // modal passes greedy:true, which is the whole point of expanding — one-finger drag
        // and plain wheel zoom.
        gestureHandling: opts.greedy ? 'greedy' : 'cooperative',
      });
      let route = null;
      try {
        const res = await computeRouteCached(libs.Route, stops);
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
      // Only on a real, successful Google map — never over the loading spinner, and never on
      // the SVG island fallback (which replaces this whole wrap).
      if (opts.expandable) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ch-map-expand';
        btn.setAttribute('aria-label', 'Expand map');
        btn.innerHTML =
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" ' +
          'stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg><span>Expand</span>';
        btn.addEventListener('click', () => openExpanded(stops, { stopLabels: opts.stopLabels }));
        wrap.appendChild(btn);
      }
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
          scale: 1.5, anchor: new libs.Point(12, 22), labelOrigin: new libs.Point(12, 10),
        });
        const at = (loc) => ({ lat: loc.lat, lng: loc.lng }); // DirectionalLocation → LatLngLiteral
        const stopLocs = [at(rlegs[0].startLocation)].concat(rlegs.map((l) => at(l.endLocation)));
        stopLocs.forEach((pos, i) => {
          const first = i === 0, last = i === stopLocs.length - 1;
          new libs.Marker({
            map, position: pos, zIndex: 5,
            icon: pin(first ? '#0a7d6f' : last ? '#e8623a' : '#0AB9B6'),
            // The number ties each pin to the stops legend — without it the pins are
            // anonymous and "is stop 3 the right place?" can't be answered.
            label: { text: String(i + 1), color: '#ffffff', fontSize: '11px', fontWeight: '700' },
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
