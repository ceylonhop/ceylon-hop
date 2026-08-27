/* ============================================================
   CEYLON HOP — transfers + corridors data & quote helpers
   Private transfer is the primary product; shared rides are
   offered on popular corridors where seats run on set weekdays (Wed & Sat).
   ============================================================ */
(function () {
  /* @generated:pricing — from api/src/quote/rateCard.ts · DO NOT EDIT BY HAND · run `npm run generate` */
  const PER_KM = {"car":0.4025,"van":0.5405};
  const FLOORS = {"car":29,"van":49.99};
  const BUFFER_PCT = 10;
  const PRICE_FINISHING = {"maxReductionBps":250,"roundToCents":50};
  const CHAUFFEUR_DAY_FEE = 31.05;
  const CHAUFFEUR_IDLE_MIN_KM = {"car":50,"van":100};
  const DEPOSIT_PCT = 0.1;
  const DEPOSIT_CAP = 50;
  const EXTRAS = {"sightseeing":10,"safari-wait":19,"luggage":5,"front":8,"flex":12,"waiting":10};
  const CORRIDOR_SEAT = {"airport-cultural":19,"hill-line":21,"ella-east":23,"south-coast":14,"yala-south":16,"ella-south":24,"south-airport":30};
  const SEAT_PRICING = {"perKmCentsVan":54.05,"floorCentsVan":4999,"seatsCoveringVan":3};
  const SHARED_PRODUCTS = [{"id":"negombo-sigiriya","corridorId":"airport-cultural","from":"Colombo Airport (CMB)","to":"Sigiriya / Dambulla","seat":27.49,"time":"07:00","pickup":"CMB Airport"},{"id":"negombo-sigiriya","corridorId":"airport-cultural","from":"Negombo","to":"Sigiriya / Dambulla","seat":27.49,"time":"07:30","pickup":"Zen Cafe, Negombo"},{"id":"sigiriya-kandy","corridorId":"airport-cultural","from":"Sigiriya / Dambulla","to":"Kandy","seat":19.99,"time":"11:30","pickup":"Barista Cafe, Sigiriya"},{"id":"ella-yala","corridorId":"ella-east","from":"Ella","to":"Yala","seat":22.99,"time":"09:00","pickup":"Barn by Starbeans Cafe, Ella"},{"id":"ella-south-coast","corridorId":"ella-south","from":"Ella","to":"Mirissa","seat":24,"time":"09:00","pickup":"Barn by Starbeans Cafe, Ella"},{"id":"ella-south-coast","corridorId":"ella-south","from":"Ella","to":"Weligama","seat":24,"time":"09:00","pickup":"Barn by Starbeans Cafe, Ella"},{"id":"ella-south-coast","corridorId":"ella-south","from":"Ella","to":"Ahangama","seat":24,"time":"09:00","pickup":"Barn by Starbeans Cafe, Ella"},{"id":"south-airport","corridorId":"south-airport","from":"Mirissa","to":"Colombo Airport (CMB)","seat":29.99,"time":"14:45","pickup":"Barista Cafe, Mirissa"},{"id":"south-airport","corridorId":"south-airport","from":"Weligama","to":"Colombo Airport (CMB)","seat":29.99,"time":"15:00","pickup":"Nomad Cafe, Weligama"}];
  /* @end:pricing */

  // ---- Places (approx lat/lng for distance) ----
  // region groups help the picker read nicely
  const PLACES = [
    { id: 'cmb-airport', name: 'Colombo Airport (CMB)', area: 'West coast', lat: 7.18, lng: 79.88 },
    { id: 'colombo', name: 'Colombo city', area: 'West coast', lat: 6.93, lng: 79.85 },
    { id: 'negombo', name: 'Negombo', area: 'West coast', lat: 7.21, lng: 79.84 },
    { id: 'bentota', name: 'Bentota', area: 'South coast', lat: 6.42, lng: 79.99 },
    { id: 'hikkaduwa', name: 'Hikkaduwa', area: 'South coast', lat: 6.14, lng: 80.10 },
    { id: 'galle', name: 'Galle', area: 'South coast', lat: 6.03, lng: 80.22 },
    { id: 'weligama', name: 'Weligama', area: 'South coast', lat: 5.97, lng: 80.42 },
    { id: 'mirissa', name: 'Mirissa', area: 'South coast', lat: 5.95, lng: 80.46 },
    { id: 'kandy', name: 'Kandy', area: 'Hill country', lat: 7.29, lng: 80.63 },
    { id: 'nuwara-eliya', name: 'Nuwara Eliya', area: 'Hill country', lat: 6.95, lng: 80.79 },
    { id: 'ella', name: 'Ella', area: 'Hill country', lat: 6.87, lng: 81.05 },
    { id: 'sigiriya', name: 'Sigiriya / Dambulla', area: 'Cultural triangle', lat: 7.95, lng: 80.76 },
    { id: 'anuradhapura', name: 'Anuradhapura', area: 'Cultural triangle', lat: 8.31, lng: 80.40 },
    { id: 'yala', name: 'Yala', area: 'East & wild', lat: 6.37, lng: 81.52 },
    { id: 'arugam-bay', name: 'Arugam Bay', area: 'East & wild', lat: 6.84, lng: 81.84 },
    { id: 'trincomalee', name: 'Trincomalee', area: 'East & wild', lat: 8.59, lng: 81.21 },
    { id: 'ahangama', name: 'Ahangama', area: 'South coast', lat: 5.97, lng: 80.36 },
    { id: 'hiriketiya', name: 'Hiriketiya', area: 'South coast', lat: 5.96, lng: 80.69 },
    { id: 'horton-plains', name: 'Horton Plains', area: 'Hill country', lat: 6.80, lng: 80.80 }
  ];
  const byId = {};
  PLACES.forEach(p => (byId[p.id] = p));

  // ---- Shared corridors: groups of stops that share a fixed-schedule seat service.
  // A shared option exists when BOTH endpoints sit on the same corridor. Seats run a
  // fixed WEEKLY schedule (not daily): `days` are the service weekdays (0=Sun … 6=Sat),
  // mirroring the backend `serviceDays` — the API rejects off-schedule shared bookings.
  const SHARED_DAYS = [3, 6]; // Wed & Sat
  const CORRIDORS = [
    {
      id: 'airport-cultural',
      label: 'Airport → Cultural Triangle',
      stops: ['cmb-airport', 'colombo', 'negombo', 'sigiriya', 'kandy'],
      seat: CORRIDOR_SEAT['airport-cultural'], times: ['07:30'], days: SHARED_DAYS, freqText: 'Wed & Sat'
    },
    {
      id: 'hill-line',
      label: 'Kandy → Hill Country',
      stops: ['kandy', 'nuwara-eliya', 'ella'],
      seat: CORRIDOR_SEAT['hill-line'], times: ['08:00'], days: SHARED_DAYS, freqText: 'Wed & Sat'
    },
    {
      id: 'ella-east',
      label: 'Ella → Yala → East Coast',
      stops: ['ella', 'yala', 'arugam-bay'],
      seat: CORRIDOR_SEAT['ella-east'], times: ['09:00'], days: SHARED_DAYS, freqText: 'Wed & Sat'
    },
    {
      id: 'south-coast',
      label: 'Galle → Mirissa Coast',
      stops: ['galle', 'hikkaduwa', 'bentota', 'weligama', 'mirissa'],
      seat: CORRIDOR_SEAT['south-coast'], times: ['09:00', '14:00'], days: SHARED_DAYS, freqText: 'Wed & Sat'
    },
    {
      id: 'yala-south',
      label: 'Yala → South Coast',
      stops: ['yala', 'mirissa', 'weligama', 'galle'],
      seat: CORRIDOR_SEAT['yala-south'], times: ['08:00'], days: SHARED_DAYS, freqText: 'Wed & Sat'
    },
    {
      id: 'ella-south',
      label: 'Ella → South Coast',
      stops: ['ella', 'mirissa', 'weligama', 'ahangama'],
      seat: CORRIDOR_SEAT['ella-south'], times: ['09:00'], days: SHARED_DAYS, freqText: 'Wed & Sat'
    },
    {
      // The southbound airport run. No other corridor joins the south coast to CMB, so
      // Mirissa/Weligama → Airport could not be represented at all before 2026-08-16.
      id: 'south-airport',
      label: 'South Coast → Airport',
      stops: ['mirissa', 'weligama', 'colombo', 'cmb-airport'],
      seat: CORRIDOR_SEAT['south-airport'], times: ['14:45'], days: SHARED_DAYS, freqText: 'Wed & Sat'
    }
  ];

  // ---- Geo helpers ----
  function haversine(a, b) {
    const R = 6371, toR = d => (d * Math.PI) / 180;
    const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  // Real road distances (Google Directions, baked) for known place pairs — keeps
  // search + planner pricing on ACTUAL driving distance, not straight-line, which
  // badly understates winding hill-country routes. Value = [km, minutes]. Symmetric.
  const REAL_KM = {
    "cmb-airport|colombo":[35,48],"cmb-airport|negombo":[7,18],"cmb-airport|bentota":[108,104],"cmb-airport|hikkaduwa":[144,130],"cmb-airport|galle":[153,135],"cmb-airport|weligama":[173,149],"cmb-airport|mirissa":[177,156],"cmb-airport|kandy":[118,177],"cmb-airport|nuwara-eliya":[161,298],"cmb-airport|ella":[335,297],"cmb-airport|sigiriya":[152,201],"cmb-airport|anuradhapura":[175,236],"cmb-airport|yala":[317,308],"cmb-airport|arugam-bay":[419,393],"cmb-airport|trincomalee":[240,293],
    "colombo|negombo":[40,53],"colombo|bentota":[87,104],"colombo|hikkaduwa":[123,131],"colombo|galle":[133,135],"colombo|weligama":[152,150],"colombo|mirissa":[156,157],"colombo|kandy":[123,208],"colombo|nuwara-eliya":[174,302],"colombo|ella":[314,297],"colombo|sigiriya":[180,232],"colombo|anuradhapura":[209,266],"colombo|yala":[296,309],"colombo|arugam-bay":[399,393],"colombo|trincomalee":[269,323],
    "negombo|bentota":[112,108],"negombo|hikkaduwa":[148,134],"negombo|galle":[157,139],"negombo|weligama":[177,153],"negombo|mirissa":[181,161],"negombo|kandy":[115,171],"negombo|nuwara-eliya":[165,300],"negombo|ella":[339,301],"negombo|sigiriya":[148,194],"negombo|anuradhapura":[172,227],"negombo|yala":[321,312],"negombo|arugam-bay":[423,397],"negombo|trincomalee":[237,286],
    "bentota|hikkaduwa":[37,56],"bentota|galle":[70,75],"bentota|weligama":[90,89],"bentota|mirissa":[94,96],"bentota|kandy":[176,247],"bentota|nuwara-eliya":[211,335],"bentota|ella":[251,236],"bentota|sigiriya":[229,271],"bentota|anuradhapura":[258,305],"bentota|yala":[234,248],"bentota|arugam-bay":[336,333],"bentota|trincomalee":[318,363],
    "hikkaduwa|galle":[19,35],"hikkaduwa|weligama":[58,67],"hikkaduwa|mirissa":[62,75],"hikkaduwa|kandy":[212,273],"hikkaduwa|nuwara-eliya":[275,326],"hikkaduwa|ella":[220,215],"hikkaduwa|sigiriya":[265,297],"hikkaduwa|anuradhapura":[294,331],"hikkaduwa|yala":[202,226],"hikkaduwa|arugam-bay":[305,311],"hikkaduwa|trincomalee":[354,389],
    "galle|weligama":[27,50],"galle|mirissa":[41,58],"galle|kandy":[221,278],"galle|nuwara-eliya":[253,309],"galle|ella":[198,198],"galle|sigiriya":[274,302],"galle|anuradhapura":[303,336],"galle|yala":[181,210],"galle|arugam-bay":[283,294],"galle|trincomalee":[363,394],
    "weligama|mirissa":[7,14],"weligama|kandy":[241,291],"weligama|nuwara-eliya":[233,294],"weligama|ella":[179,183],"weligama|sigiriya":[294,315],"weligama|anuradhapura":[323,349],"weligama|yala":[161,194],"weligama|arugam-bay":[263,279],"weligama|trincomalee":[383,407],
    "mirissa|kandy":[245,299],"mirissa|nuwara-eliya":[228,296],"mirissa|ella":[173,185],"mirissa|sigiriya":[298,323],"mirissa|anuradhapura":[327,357],"mirissa|yala":[155,197],"mirissa|arugam-bay":[258,282],"mirissa|trincomalee":[387,414],
    "kandy|nuwara-eliya":[76,158],"kandy|ella":[136,227],"kandy|sigiriya":[89,150],"kandy|anuradhapura":[137,201],"kandy|yala":[265,402],"kandy|arugam-bay":[214,307],"kandy|trincomalee":[178,242],
    "nuwara-eliya|ella":[54,107],"nuwara-eliya|sigiriya":[195,290],"nuwara-eliya|anuradhapura":[249,342],"nuwara-eliya|yala":[180,304],"nuwara-eliya|arugam-bay":[183,287],"nuwara-eliya|trincomalee":[290,383],
    "ella|sigiriya":[175,256],"ella|anuradhapura":[229,308],"ella|yala":[126,198],"ella|arugam-bay":[134,180],"ella|trincomalee":[270,349],
    "sigiriya|anuradhapura":[74,90],"sigiriya|yala":[304,408],"sigiriya|arugam-bay":[252,312],"sigiriya|trincomalee":[98,113],
    "anuradhapura|yala":[353,462],"anuradhapura|arugam-bay":[301,367],"anuradhapura|trincomalee":[108,127],
    "yala|arugam-bay":[192,271],"yala|trincomalee":[364,466],
    "arugam-bay|trincomalee":[248,332],
    // Tour-stop legs for Horton Plains / Ahangama / Hiriketiya — road estimates (refine with Google Directions).
    "nuwara-eliya|horton-plains":[32,78],"horton-plains|ella":[55,115],
    "galle|ahangama":[18,30],"ahangama|weligama":[9,15],"mirissa|hiriketiya":[30,45],"hiriketiya|arugam-bay":[228,270]
  };
  // baked real [km, min] for a known id pair (either direction), else null
  function realLeg(aId, bId) {
    if (!aId || !bId) return null;
    return REAL_KM[aId + '|' + bId] || REAL_KM[bId + '|' + aId] || null;
  }
  // road distance: real baked value when both ends are known places, else the
  // crow-flies × winding-factor estimate (for typed / not-yet-baked places).
  function roadKm(fromId, toId) {
    const real = realLeg(fromId, toId);
    if (real) return real[0];
    const a = byId[fromId], b = byId[toId];
    if (!a || !b) return 0;
    return Math.round(haversine(a, b) * 1.35);
  }
  function durationText(km) {
    const hrs = km / 42; // ~42 km/h realistic average incl. towns
    const h = Math.floor(hrs), m = Math.round((hrs - h) * 60);
    if (h <= 0) return `${Math.max(20, m)} min`;
    return m >= 8 ? `${h}h ${m}m` : `${h}h`;
  }
  function minToText(min) {
    const h = Math.floor(min / 60), m = Math.round(min % 60);
    if (h <= 0) return `${Math.max(20, m)} min`;
    return m >= 8 ? `${h}h ${m}m` : `${h}h`;
  }

  // ---- Private quote: door-to-door, your own vehicle ----
  // Engine rate-card parity (owner decision 2026-07-13): billable km = road km plus a
  // per-leg routing buffer clamped to 5..15 km, then a per-km rate with a minimum fare
  // — mirrors api/src/quote/.
  function privateQuote(fromId, toId) {
    const km = roadKm(fromId, toId);
    const real = realLeg(fromId, toId);
    const durationMin = real ? real[1] : Math.max(20, Math.round((km / 42) * 60));
    const rawCar = legPrice(km, 'car');         // sedan, up to 3 pax
    const rawVan = legPrice(km, 'van');         // AC van, up to 6 pax
    return {
      km,
      durationMin,
      duration: real ? minToText(durationMin) : durationText(km),
      estimated: !real,
      car: finishPrice(rawCar, FLOORS.car),
      van: finishPrice(rawVan, FLOORS.van),
      rawCar,
      rawVan,
    };
  }

  // Mirrors api/src/quote/priceFinish.ts in integer cents. This is display parity only; the
  // backend repeats the policy authoritatively before a booking or ops quote is persisted.
  // Kept byte-for-byte equivalent by web-tests/unit/backend-price-parity.test.js, which sweeps
  // the whole range rather than spot values — the two last diverged only at large totals.
  function finishPrice(amount, minimumAllowed) {
    if(!Number.isFinite(amount) || amount < 0) return amount;
    const rawCents = Math.round(amount * 100);
    const minimumAllowedCents = Math.round((minimumAllowed || 0) * 100);
    if(rawCents === 0) return 0;
    // A price that IS the protected minimum is already final — a $49.99 floor is a FINAL price.
    if(rawCents === minimumAllowedCents) return rawCents / 100;

    // Threshold finishing (owner 2026-08-19). The barriers get coarser as the number grows, and
    // the nine sits in the cents up to $100 ($49.99) and in the dollars above it ($149, $999).
    const stepFor = c => (c < 10000 ? 1000 : c < 100000 ? 5000 : 10000);
    const targetFor = a => (a <= 10000 ? a - 1 : a - 100);
    const isPow10 = c => { let n = c; while(n >= 10 && n % 10 === 0) n /= 10; return n === 1; };
    const isThreshold = c => {
      const step = stepFor(c), below = Math.floor(c / step) * step;
      return c === targetFor(below) || c === targetFor(below + step);
    };
    if(isThreshold(rawCents)) return rawCents / 100;

    // Drop the cents first and decide everything from that number, or the rule is not idempotent.
    const floored = Math.floor(rawCents / 100) * 100;
    const base = floored >= minimumAllowedCents ? floored : rawCents;

    if(base <= 500000) {
      const step = stepFor(base), anchor = Math.floor(base / step) * step;
      const target = targetFor(anchor);
      // 1% of the price, doubled when the barrier drops a digit, floored at $3.50, capped at $20.
      const budget = Math.min(Math.max(
        Math.round(base * 100 / 10000) * (isPow10(anchor) ? 2 : 1), 350), 2000);
      if(target >= minimumAllowedCents && target < base && base - target <= budget) return target / 100;
    }
    return base / 100;
  }

  // ---- Two different questions, deliberately two functions ----
  //
  // `sharedOption` answers "do we SELL a scheduled seat on this leg?" — an explicit,
  // directed catalogue (@generated SHARED_PRODUCTS, source api/src/db/departureRepo.ts).
  //
  // `corridorFor` answers "do these two places sit on one corridor's road?" — the old
  // adjacency match, kept broad. The ride board pools routes we do NOT schedule, so
  // narrowing what we advertise must never narrow what travellers can pool.
  //
  // These used to be one function, and reading adjacency as an offer put a shared seat
  // on 32 of 44 trip pages — 16 of them the REVERSE of the direction the van runs.

  /** The scheduled product for a DIRECTED leg, or null. Adjacency is not an offer. */
  function sharedOption(fromId, toId) {
    if (fromId === toId) return null;
    const from = byId[fromId], to = byId[toId];
    if (!from || !to) return null;
    const p = SHARED_PRODUCTS.find((x) => x.from === from.name && x.to === to.name);
    if (!p) return null;
    const c = CORRIDORS.find((c) => c.id === p.corridorId);
    // Every boarding point on this run, in departure order. One marketed product picks up at
    // several places — the Negombo→Sigiriya van leaves CMB at 7:00 and Negombo at 7:30 —
    // and a traveller needs the whole sequence to know where and when to stand, exactly as
    // the live product page lists it. Grouped by product AND destination, since one product
    // id can serve two destinations (Mirissa/Weligama → Colombo and → the airport).
    const pickups = SHARED_PRODUCTS
      .filter((x) => x.id === p.id && x.to === p.to)
      .slice()
      .sort((a, b) => a.time.localeCompare(b.time))
      .map((x) => ({ place: x.from, time: x.time, point: x.pickup }));
    return {
      corridorId: p.corridorId,
      corridorLabel: c ? c.label : p.corridorId,
      seat: p.seat,
      // The product's own boarding time at THIS stop — a corridor's time is when the van
      // leaves its first stop, which is wrong for every stop after it.
      times: [p.time],
      pickup: p.pickup,
      pickups,
      days: c ? c.days : SHARED_DAYS,
      freqText: c ? c.freqText : 'Wed & Sat'
    };
  }

  /**
   * What a ride-board seat costs on this leg — the SAME rule the server applies in
   * POST /board: the catalogue price where we sell a scheduled seat, otherwise the van
   * fare for the road distance split across the seats that cover the van.
   *
   * Computed in CENTS from SEAT_PRICING, not from the dollar PER_KM/FLOORS above: going
   * back through ×100 can cross a 50c rounding boundary and disagree with the server by
   * 50c. Returns dollars, or null when we have no road distance to price against.
   */
  function boardSeatPrice(fromId, toId) {
    const p = sharedOption(fromId, toId);
    if (p) return p.seat;
    const km = roadKm(fromId, toId);
    if (!km) return null;
    const vanFare = Math.max(Math.round(km * SEAT_PRICING.perKmCentsVan), SEAT_PRICING.floorCentsVan);
    const perSeat = vanFare / SEAT_PRICING.seatsCoveringVan;
    const round = PRICE_FINISHING.roundToCents;
    return (Math.round(perSeat / round) * round) / 100;
  }

  /** Corridor membership only — undirected, adjacency-based. Used by the ride board. */
  function corridorFor(fromId, toId) {
    if (fromId === toId) return null;
    for (const c of CORRIDORS) {
      if (c.stops.indexOf(fromId) !== -1 && c.stops.indexOf(toId) !== -1) {
        return {
          corridorId: c.id, corridorLabel: c.label,
          seat: c.seat, times: c.times, days: c.days, freqText: c.freqText
        };
      }
    }
    return null;
  }

  // ---- Extra well-known places (for free-text itinerary planning) ----
  const EXTRA = [
    ['Dambulla', 7.86, 80.65], ['Habarana', 8.03, 80.75], ['Polonnaruwa', 7.94, 81.00],
    ['Udawalawe', 6.44, 80.89], ['Tissamaharama', 6.28, 81.29], ['Tangalle', 6.02, 80.79],
    ['Unawatuna', 6.01, 80.25], ['Nilaveli', 8.70, 81.19], ['Pasikudah', 7.92, 81.56],
    ['Hatton', 6.89, 80.60], ["Adam's Peak", 6.81, 80.50], ['Wilpattu', 8.45, 80.05],
    ['Kalpitiya', 8.23, 79.77], ['Jaffna', 9.66, 80.02], ['Haputale', 6.77, 80.96],
    ['Kitulgala', 6.99, 80.41],
    // Server-vocabulary parity (api/src/adapters/maps.ts KNOWN_PLACES): via-stops the ops
    // quote tool offers must also resolve here, or kmBetween() returns null for them.
    ['Nilaveli Beach', 8.70, 81.19], ['Nanu Oya', 6.94, 80.77], ['Thanthirimale', 8.42, 80.22]
  ];
  function nrm(s){ return (s||'').toLowerCase().replace(/\(.*?\)/g,'').replace(/[^a-z]/g,'').trim(); }
  function words(s){
    return (s||'').toLowerCase().replace(/\(.*?\)/g,' ').split(/[^a-z0-9]+/).filter(w => w.length > 1);
  }
  // build a lookup of normalized-name → {lat,lng,name}
  const GEO = {};
  PLACES.forEach(p => { GEO[nrm(p.name)] = { lat:p.lat, lng:p.lng, name:p.name, id:p.id }; });
  EXTRA.forEach(([name,lat,lng]) => { const k=nrm(name); if(!GEO[k]) GEO[k]={lat,lng,name,id:null}; });
  // resolve free text (a typed location) to a geo point, fuzzily
  function resolvePlace(text){
    const k = nrm(text);
    if(!k) return null;
    if(GEO[k]) return GEO[k];
    if(k.includes('airport') || k.includes('cmb')) return GEO[nrm('Colombo Airport')];
    const ws = words(text);
    if(ws.length === 1){
      for(const key in GEO){ if(key.includes(k) || k.includes(key)) return GEO[key]; }
    }
    return null;
  }
  // Guard: the "exact spot" on the booking page is meant to REFINE the area the
  // customer already chose (a hotel/landmark inside it), not swap in a different
  // route. Anything past MAX_EXACT_KM straight-line from the original area point is
  // a route change, so the caller blocks it instead of silently re-pricing.
  const MAX_EXACT_KM = 10;
  function exactSpotDecision(areaPoint, spotPoint, maxKm){
    const lim = (maxKm == null) ? MAX_EXACT_KM : maxKm;
    // Can't measure (unknown coords) → fail open: don't block what we can't verify.
    if(!areaPoint || !spotPoint || areaPoint.lat == null || spotPoint.lat == null) return { ok:true, km:null, limit:lim };
    const km = haversine(areaPoint, spotPoint);
    return { ok: km <= lim, km: Math.round(km), limit: lim };
  }
  // distance between two arbitrary points (ids or typed names)
  function kmBetween(aName, bName){
    const a = byId[aName] ? byId[aName] : resolvePlace(aName);
    const b = byId[bName] ? byId[bName] : resolvePlace(bName);
    if(!a || !b) return null;
    const real = realLeg(a.id, b.id);
    if(real) return real[0];
    return Math.round(haversine(a,b) * 1.35);
  }
  function billableKm(km){
    if(km==null) return null;
    const buffer = Math.min(15, Math.max(5, Math.round(km * (BUFFER_PCT/100))));
    return km + buffer;
  }
  // per-leg private price by vehicle — the engine formula: buffer each leg, then the
  // per-km rate with a minimum fare. Every number comes from the generated pricing block at the
  // top of this IIFE (sourced from api/src/quote/rateCard.ts), so nothing here can drift.
  function legPrice(km, veh){
    if(km==null) return null;
    const bkm = billableKm(km);
    const car = Math.max(FLOORS.car, Math.round(bkm * (PER_KM.car * 100)) / 100);
    const van = Math.max(FLOORS.van, Math.round(bkm * (PER_KM.van * 100)) / 100);
    return veh==='van' ? van : car;
  }
  function distancePrice(km, veh){
    if(km==null) return null;
    const rate = veh==='van' ? PER_KM.van : PER_KM.car;
    return Math.round(km * (rate * 100)) / 100;
  }
  // Hybrid planner autocomplete: known Ceylon Hop places first (stable baked pricing),
  // then popular extras. Google exact-place suggestions can be appended later by a
  // backend adapter without changing the ranking contract below.
  /* "Is this free-text label one of OUR places?" — the identity question the name path could
     not answer. Google states a place in Google's vocabulary ("Sigiriya, Sri Lanka") while the
     catalogue states the same place in ours ("Sigiriya / Dambulla"), so the picker offered both
     and the id came down to which row got clicked. That id is not cosmetic: it decides baked
     vs engine pricing AND whether `sharedOption` is consulted at all (search.js), so the two
     rows sold different products.

     EXACT after stripping the country suffix — never a substring. ch-shortplace.js records why
     ("Umbrella Cafe" contains "ella"), and the failure direction is asymmetric: a miss just
     leaves the engine to price the route as it does today, while a false hit would swap a named
     pickup for an area centroid. Aliases are the place's own vocabulary only — its name, that
     name without the parenthetical, and its id. Deliberately NOT the halves of a slash-joined
     name: "Dambulla" is ~17km from Sigiriya, and folding it in is an owner call, not a freebie. */
  const COUNTRY_SUFFIX = /,\s*sri lanka\s*$/;
  function aliasKey(s){
    return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ').replace(COUNTRY_SUFFIX, '').trim();
  }
  const ALIAS_ID = {};
  PLACES.forEach(p => {
    [p.name, p.name.replace(/\(.*?\)/g, ''), p.id.replace(/-/g, ' ')].forEach(a => {
      const k = aliasKey(a);
      if(k && !(k in ALIAS_ID)) ALIAS_ID[k] = p.id;
    });
  });
  /** The catalogue id this label names, or null. Exact match only — see above. */
  function placeAliasId(text){
    const k = aliasKey(text);
    return k ? (ALIAS_ID[k] || null) : null;
  }
  function suggestionAliases(label, id){
    const aliases = [label, id || '', label.replace(/\(.*?\)/g, '')];
    if(id === 'cmb-airport') aliases.push('cmb', 'airport', 'colombo airport', 'bandaranaike');
    if(id === 'colombo') aliases.push('colombo city', 'colombo');
    return aliases.map(nrm).filter(Boolean);
  }
  function rankSuggestion(item, query){
    const q = nrm(query);
    if(!q) return 0;
    const aliases = suggestionAliases(item.label, item.id);
    if(aliases.some(a => a === q)) return 100;
    if(aliases.some(a => a.startsWith(q))) return 80;
    if(aliases.some(a => a.includes(q))) return 60;
    const qWords = words(query);
    if(qWords.length > 1){
      const wantsAirport = qWords.some(w => ['cmb', 'airport', 'bandaranaike'].includes(w));
      if(item.id === 'cmb-airport' && wantsAirport) return 95;
      if(item.id === 'colombo' && qWords.includes('colombo') && !wantsAirport) return 90;
      const aliasWords = new Set(aliases.flatMap(words));
      if(qWords.some(w => aliasWords.has(w))) return 45;
    }
    return 0;
  }
  function placeSuggestions(query, limit){
    const q = nrm(query);
    const known = PLACES.map(p => ({ label:p.name, id:p.id, source:'known', area:p.area }));
    const extras = EXTRA.map(([name]) => ({ label:name, id:null, source:'extra', area:'Popular places' }));
    if(!q) return known.concat(extras).slice(0, limit || 8);
    return known.concat(extras)
      .map((item, idx) => {
        const rank = rankSuggestion(item, query);
        return { item, idx, score: rank ? rank + (item.source === 'known' ? 10 : 0) : 0 };
      })
      .filter(x => x.score > 0)
      .sort((a,b) => (b.score - a.score) || (a.idx - b.idx) || a.item.label.localeCompare(b.item.label))
      .slice(0, limit || 8)
      .map(x => x.item);
  }
  // Decide what to do when a live routed distance comes back for a customer-set
  // route, given the price currently shown. The quoted price is a FIRM FLOOR — it
  // never drops:
  //  - cheaper/equal, within the per-leg buffer already charged, or no baseline
  //    → 'hold' (keep the quoted price)
  //  - MATERIALLY dearer (past the buffer) → 'confirm' (needs a heads-up before it changes)
  // Buffer mirrors legPrice's billableKm clamp. No new rates — reuse legPrice.
  function repriceDecision(anchorKm, routedKm, currentUnit, veh){
    const newPrice = legPrice(routedKm, veh);
    if(newPrice == null || !anchorKm) return { action:'hold', price: currentUnit };
    if(newPrice <= currentUnit) return { action:'hold', price: currentUnit };
    if(routedKm <= billableKm(anchorKm)) return { action:'hold', price: currentUnit };
    return { action:'confirm', price: newPrice, extraKm: Math.max(1, Math.round(routedKm - anchorKm)) };
  }
  // chauffeur-guide day fee (a driver-guide + car per day) plus deposit %/cap live in the
  // generated pricing block at the top of this IIFE (sourced from api/src/quote/rateCard.ts).

  // full multi-stop quote: an array of typed stop names + vehicle
  function tripQuote(stops, veh){
    veh = veh || 'car';
    const legs = [];
    let total = 0, totalKm = 0, hasEst = false;
    for(let i=0;i<stops.length-1;i++){
      const km = kmBetween(stops[i], stops[i+1]);
      let price;
      if(km==null){ price = 55; hasEst = true; }
      else { price = legPrice(km, veh); totalKm += km; }
      total += price;
      legs.push({ from:stops[i], to:stops[i+1], km, duration: km!=null?durationText(km):null, price, est: km==null });
    }
    return { legs, total, totalKm, hasEst, vehicle:veh };
  }

  // ---- expose ----
  window.TRANSFERS = {
    PLACES, byId, CORRIDORS, EXTRA,
    roadKm, durationText, privateQuote, sharedOption, corridorFor, boardSeatPrice,
    resolvePlace, placeAliasId, kmBetween, billableKm, legPrice, distancePrice, finishPrice, placeSuggestions, tripQuote, repriceDecision,
    exactSpotDecision, MAX_EXACT_KM,
    PER_KM, FLOORS, BUFFER_PCT, PRICE_FINISHING, EXTRAS, CHAUFFEUR_DAY_FEE, CHAUFFEUR_IDLE_MIN_KM, DEPOSIT_PCT, DEPOSIT_CAP,
    place: id => byId[id] || null
  };
})();
