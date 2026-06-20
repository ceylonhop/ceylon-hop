// Shared Google Maps (JavaScript API) route renderer used by booking.js + plan.js.
// Draws a clean route line — no directions panel, no markers — and shows a loading
// skeleton while the API loads and the route resolves. Falls back to the caller's SVG
// placeholder when there's no key, the API isn't enabled, or routing fails.
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
          origin: q(stops[0]),
          destination: q(stops[stops.length - 1]),
          waypoints: stops.slice(1, -1).map((n) => ({ location: q(n), stopover: true })),
          travelMode: google.maps.TravelMode.DRIVING,
        },
        (res, status) => {
          if (done) return;
          clearTimeout(timer);
          if (status === 'OK') {
            renderer.setDirections(res);
            done = true;
            wrap.classList.add('ready');
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

  window.CH_MAP = { renderRoute };
})();
