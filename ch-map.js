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
    if (window.google && window.google.maps) return Promise.resolve();
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
      const map = new google.maps.Map(mapDiv, {
        // explicit centre/zoom on Sri Lanka so base tiles load immediately —
        // the renderer re-fits to the route once it resolves (avoids grey tiles).
        center: { lat: 7.87, lng: 80.77 },
        zoom: 7,
        disableDefaultUI: true,
        zoomControl: true,
        clickableIcons: false,
        gestureHandling: 'cooperative',
      });
      const renderer = new google.maps.DirectionsRenderer({
        map,
        suppressMarkers: true, // hide the A/B pins — the route line + the bar below convey it
        polylineOptions: { strokeColor: '#0AB9B6', strokeWeight: 5, strokeOpacity: 0.92 },
      });
      new google.maps.DirectionsService().route(
        {
          origin: toLoc(stops[0]),
          destination: toLoc(stops[stops.length - 1]),
          waypoints: stops.slice(1, -1).map((n) => ({ location: toLoc(n), stopover: true })),
          travelMode: google.maps.TravelMode.DRIVING,
        },
        (res, status) => {
          if (done) return;
          clearTimeout(timer);
          if (status === 'OK') {
            renderer.setDirections(res);
            done = true;
            wrap.classList.add('ready');

            // Brand pins at the true routed endpoints (the renderer's default A/B pins are
            // suppressed). Teal = pick-up, orange = drop-off — matches the summary markers.
            try {
              const rlegs = res.routes[0].legs;
              const pin = (fill) => ({
                path: 'M12 2C7.6 2 4 5.6 4 10c0 5.6 8 12 8 12s8-6.4 8-12c0-4.4-3.6-8-8-8z',
                fillColor: fill, fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 2,
                scale: 1.5, anchor: new google.maps.Point(12, 22),
              });
              new google.maps.Marker({ map, position: rlegs[0].start_location, icon: pin('#0a7d6f'), title: 'Pick-up', zIndex: 5 });
              new google.maps.Marker({ map, position: rlegs[rlegs.length - 1].end_location, icon: pin('#e8623a'), title: 'Drop-off', zIndex: 5 });
            } catch (e) { /* markers are non-essential */ }

            // Fit the whole route in view, and re-fit if the container gains its size later:
            // the map can be created while its step panel is still collapsed (0-width), which
            // otherwise leaves grey tiles + a tiny un-fitted route.
            const fit = () => { if (res.routes[0].bounds) map.fitBounds(res.routes[0].bounds, 36); };
            fit();
            if (window.ResizeObserver) {
              let lastW = mapDiv.offsetWidth;
              const ro = new ResizeObserver(() => {
                if (mapDiv.offsetWidth && mapDiv.offsetWidth !== lastW) {
                  lastW = mapDiv.offsetWidth;
                  google.maps.event.trigger(map, 'resize');
                  fit();
                }
              });
              ro.observe(mapDiv);
            }
            // report the REAL road distance + drive time so callers can show a
            // figure that matches the route on the map (not an offline estimate).
            if (opts.onRoute) {
              try {
                const legs = (res.routes[0] && res.routes[0].legs) || [];
                let meters = 0, secs = 0;
                legs.forEach((l) => {
                  meters += l.distance ? l.distance.value : 0;
                  secs += l.duration ? l.duration.value : 0;
                });
                opts.onRoute({ km: Math.round(meters / 1000), durationMin: Math.round(secs / 60) });
              } catch (e) { /* leave the estimate in place */ }
            }
          } else {
            fail();
          }
        },
      );
    } catch (e) {
      clearTimeout(timer);
      fail();
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

  window.CH_MAP = { renderRoute, suggest, resolvePick };
})();
