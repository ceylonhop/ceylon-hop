/* ============================================================
   CEYLON HOP — transfers + corridors data & quote helpers
   Private transfer is the primary product; shared rides are
   offered on popular corridors where seats run daily.
   ============================================================ */
(function () {
  /* @generated:pricing — from api/src/quote/rateCard.ts · DO NOT EDIT BY HAND · run `npm run generate` */
  const PER_KM = {"car":0.4025,"van":0.5405};
  const FLOORS = {"car":29,"van":50};
  const BUFFER_PCT = 10;
  const CHAUFFEUR_DAY_FEE = 31.05;
  const DEPOSIT_PCT = 0.1;
  const DEPOSIT_CAP = 50;
  const EXTRAS = {"sightseeing":10,"safari-wait":19,"luggage":5,"front":8,"flex":12,"waiting":10};
  const CORRIDOR_SEAT = {"airport-cultural":19,"hill-line":21,"ella-east":23,"south-coast":14,"yala-south":16,"ella-south":24};
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
      label: 'Ella → Yala → East',
      stops: ['ella', 'yala', 'arugam-bay'],
      seat: CORRIDOR_SEAT['ella-east'], times: ['08:00'], days: SHARED_DAYS, freqText: 'Wed & Sat'
    },
    {
      id: 'south-coast',
      label: 'Galle → Mirissa coast',
      stops: ['galle', 'hikkaduwa', 'bentota', 'weligama', 'mirissa'],
      seat: CORRIDOR_SEAT['south-coast'], times: ['09:00', '14:00'], days: SHARED_DAYS, freqText: 'Wed & Sat'
    },
    {
      id: 'yala-south',
      label: 'Yala → South coast',
      stops: ['yala', 'mirissa', 'weligama', 'galle'],
      seat: CORRIDOR_SEAT['yala-south'], times: ['08:00'], days: SHARED_DAYS, freqText: 'Wed & Sat'
    },
    {
      id: 'ella-south',
      label: 'Ella → South coast',
      stops: ['ella', 'mirissa', 'weligama'],
      seat: CORRIDOR_SEAT['ella-south'], times: ['08:30'], days: SHARED_DAYS, freqText: 'Wed & Sat'
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
  // Engine rate-card parity (owner decision 2026-07-02): billable km = road km + 10%
  // routing buffer, then a per-km rate with a minimum fare — mirrors api/src/quote/.
  function privateQuote(fromId, toId) {
    const km = roadKm(fromId, toId);
    const real = realLeg(fromId, toId);
    const car = legPrice(km, 'car');         // sedan, up to 3 pax
    const van = legPrice(km, 'van');         // AC van, up to 6 pax
    return {
      km,
      duration: real ? minToText(real[1]) : durationText(km),
      car: roundPretty(car),
      van: roundPretty(van)
    };
  }
  function roundPretty(n) { return Math.round(n); }

  // ---- Shared lookup: do both points sit on one corridor? ----
  function sharedOption(fromId, toId) {
    if (fromId === toId) return null;
    for (const c of CORRIDORS) {
      const i = c.stops.indexOf(fromId), j = c.stops.indexOf(toId);
      if (i !== -1 && j !== -1) {
        return {
          corridorId: c.id, corridorLabel: c.label,
          seat: c.seat, times: c.times, days: c.days, freqText: c.freqText,
          // seat count varies a little by day/route for realism
          seatsLeft: 3 + ((fromId.length + toId.length + c.seat) % 6)
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
    ['Kitulgala', 6.99, 80.41]
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
  // distance between two arbitrary points (ids or typed names)
  function kmBetween(aName, bName){
    const a = byId[aName] ? byId[aName] : resolvePlace(aName);
    const b = byId[bName] ? byId[bName] : resolvePlace(bName);
    if(!a || !b) return null;
    const real = realLeg(a.id, b.id);
    if(real) return real[0];
    return Math.round(haversine(a,b) * 1.35);
  }
  // per-leg private price by vehicle — the engine formula: +BUFFER_PCT% km buffer, then the
  // per-km rate with a minimum fare. Every number comes from the generated pricing block at the
  // top of this IIFE (sourced from api/src/quote/rateCard.ts), so nothing here can drift.
  function legPrice(km, veh){
    if(km==null) return null;
    const bkm = Math.round(km * (1 + BUFFER_PCT/100));   // billable km: + routing buffer
    const car = Math.max(FLOORS.car, Math.round(bkm * PER_KM.car));
    const van = Math.max(FLOORS.van, Math.round(bkm * PER_KM.van));
    return veh==='van' ? van : car;
  }
  // Hybrid planner autocomplete: known Ceylon Hop places first (stable baked pricing),
  // then popular extras. Google exact-place suggestions can be appended later by a
  // backend adapter without changing the ranking contract below.
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
  //  - cheaper/equal, within the +10% buffer already charged, or no baseline
  //    → 'hold' (keep the quoted price)
  //  - MATERIALLY dearer (past the buffer) → 'confirm' (needs a heads-up before it changes)
  // Buffer mirrors legPrice's round(km × 1.10). No new rates — reuse legPrice.
  function repriceDecision(anchorKm, routedKm, currentUnit, veh){
    const newPrice = legPrice(routedKm, veh);
    if(newPrice == null || !anchorKm) return { action:'hold', price: currentUnit };
    if(newPrice <= currentUnit) return { action:'hold', price: currentUnit };
    if(routedKm <= Math.round(anchorKm * (1 + BUFFER_PCT/100))) return { action:'hold', price: currentUnit };
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
    roadKm, durationText, privateQuote, sharedOption,
    resolvePlace, kmBetween, legPrice, placeSuggestions, tripQuote, repriceDecision,
    PER_KM, FLOORS, BUFFER_PCT, EXTRAS, CHAUFFEUR_DAY_FEE, DEPOSIT_PCT, DEPOSIT_CAP,
    place: id => byId[id] || null
  };
})();
