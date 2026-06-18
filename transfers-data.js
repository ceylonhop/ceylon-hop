/* ============================================================
   CEYLON HOP — transfers + corridors data & quote helpers
   Private transfer is the primary product; shared rides are
   offered on popular corridors where seats run daily.
   ============================================================ */
(function () {
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
    { id: 'trincomalee', name: 'Trincomalee', area: 'East & wild', lat: 8.59, lng: 81.21 }
  ];
  const byId = {};
  PLACES.forEach(p => (byId[p.id] = p));

  // ---- Shared corridors: groups of stops that share a daily seat service.
  // A shared option exists when BOTH endpoints sit on the same corridor.
  const CORRIDORS = [
    {
      id: 'airport-cultural',
      label: 'Airport → Cultural Triangle',
      stops: ['cmb-airport', 'colombo', 'negombo', 'sigiriya', 'kandy'],
      seat: 19, times: ['07:30'], freqText: 'Daily'
    },
    {
      id: 'hill-line',
      label: 'Kandy → Hill Country',
      stops: ['kandy', 'nuwara-eliya', 'ella'],
      seat: 21, times: ['08:00'], freqText: 'Daily'
    },
    {
      id: 'ella-east',
      label: 'Ella → Yala → East',
      stops: ['ella', 'yala', 'arugam-bay'],
      seat: 23, times: ['08:00'], freqText: 'Daily 8:00am'
    },
    {
      id: 'south-coast',
      label: 'Galle → Mirissa coast',
      stops: ['galle', 'hikkaduwa', 'bentota', 'weligama', 'mirissa'],
      seat: 14, times: ['09:00', '14:00'], freqText: 'Twice daily'
    },
    {
      id: 'yala-south',
      label: 'Yala → South coast',
      stops: ['yala', 'mirissa', 'weligama', 'galle'],
      seat: 16, times: ['08:00'], freqText: 'Daily 8:00am'
    },
    {
      id: 'ella-south',
      label: 'Ella → South coast',
      stops: ['ella', 'mirissa', 'weligama'],
      seat: 24, times: ['08:30'], freqText: 'Daily 8:30am'
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
  // road distance ≈ crow-flies × winding factor (Sri Lankan roads are slow & curvy)
  function roadKm(fromId, toId) {
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

  // ---- Private quote: door-to-door, your own vehicle ----
  function privateQuote(fromId, toId) {
    const km = roadKm(fromId, toId);
    const carBase = 22, carRate = 0.62;     // sedan, up to 3 pax
    const vanRate = 0.86;                    // AC van, up to 6 pax
    const car = Math.max(28, Math.round((carBase + km * carRate) / 1) );
    const van = Math.max(38, Math.round((carBase + 8 + km * vanRate) / 1));
    return {
      km,
      duration: durationText(km),
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
          seat: c.seat, times: c.times, freqText: c.freqText,
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
  // build a lookup of normalized-name → {lat,lng,name}
  const GEO = {};
  PLACES.forEach(p => { GEO[nrm(p.name)] = { lat:p.lat, lng:p.lng, name:p.name, id:p.id }; });
  EXTRA.forEach(([name,lat,lng]) => { const k=nrm(name); if(!GEO[k]) GEO[k]={lat,lng,name,id:null}; });
  // resolve free text (a typed location) to a geo point, fuzzily
  function resolvePlace(text){
    const k = nrm(text);
    if(!k) return null;
    if(GEO[k]) return GEO[k];
    for(const key in GEO){ if(key.includes(k) || k.includes(key)) return GEO[key]; }
    if(k.includes('airport') || k.includes('cmb')) return GEO[nrm('Colombo Airport')];
    return null;
  }
  // distance between two arbitrary points (ids or typed names)
  function kmBetween(aName, bName){
    const a = byId[aName] ? byId[aName] : resolvePlace(aName);
    const b = byId[bName] ? byId[bName] : resolvePlace(bName);
    if(!a || !b) return null;
    return Math.round(haversine(a,b) * 1.35);
  }
  // per-leg private price by vehicle
  function legPrice(km, veh){
    if(km==null) return null;
    const car = Math.max(28, Math.round(22 + km*0.62));
    const van = Math.max(38, Math.round(22 + 8 + km*0.86));
    return veh==='van' ? van : car;
  }
  // chauffeur-guide: a driver-guide + car stays with the trip. Flat add-on per day.
  const CHAUFFEUR_DAY_FEE = 35;
  const DEPOSIT_PCT = 0.20;

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
    resolvePlace, kmBetween, legPrice, tripQuote,
    CHAUFFEUR_DAY_FEE, DEPOSIT_PCT,
    place: id => byId[id] || null
  };
})();
