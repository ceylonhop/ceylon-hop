/* ============================================================
   CEYLON HOP — booking flow logic
   ============================================================ */
mountWA();
document.getElementById('bk-brand').innerHTML = cmark(30,'var(--accent)') + '<span>Ceylon Hop</span>';
document.getElementById('conf-wa').innerHTML = ICON.wa + ' Chat on WhatsApp';

// Pre-warm the API. The free hosting tier spins the service down when idle and a
// cold boot can take ~30s — firing a health ping on page load means it's usually
// awake by the time the customer reaches payment, so "Pay" doesn't time out.
(function warmApi(){
  const API = window.CEYLON_HOP_API;
  if(!API) return;
  try { fetch(API.replace(/\/$/,'')+'/health', { method:'GET', cache:'no-store' }).catch(()=>{}); } catch(e){}
})();

// put check icons in addon boxes
const CK='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="m5 12 5 5L20 7"/></svg>';
document.querySelectorAll('.addon .box').forEach(b=>b.innerHTML=CK);

const PHONE_COUNTRIES = [
  ['LK','Sri Lanka','+94'],['AF','Afghanistan','+93'],['AL','Albania','+355'],['DZ','Algeria','+213'],['AD','Andorra','+376'],['AO','Angola','+244'],['AG','Antigua and Barbuda','+1'],['AR','Argentina','+54'],['AM','Armenia','+374'],['AU','Australia','+61'],['AT','Austria','+43'],['AZ','Azerbaijan','+994'],['BS','Bahamas','+1'],['BH','Bahrain','+973'],['BD','Bangladesh','+880'],['BB','Barbados','+1'],['BY','Belarus','+375'],['BE','Belgium','+32'],['BZ','Belize','+501'],['BJ','Benin','+229'],['BT','Bhutan','+975'],['BO','Bolivia','+591'],['BA','Bosnia and Herzegovina','+387'],['BW','Botswana','+267'],['BR','Brazil','+55'],['BN','Brunei','+673'],['BG','Bulgaria','+359'],['BF','Burkina Faso','+226'],['BI','Burundi','+257'],['CV','Cabo Verde','+238'],['KH','Cambodia','+855'],['CM','Cameroon','+237'],['CA','Canada','+1'],['CF','Central African Republic','+236'],['TD','Chad','+235'],['CL','Chile','+56'],['CN','China','+86'],['CO','Colombia','+57'],['KM','Comoros','+269'],['CG','Congo','+242'],['CD','Congo (DRC)','+243'],['CR','Costa Rica','+506'],['CI','Cote d’Ivoire','+225'],['HR','Croatia','+385'],['CU','Cuba','+53'],['CY','Cyprus','+357'],['CZ','Czechia','+420'],['DK','Denmark','+45'],['DJ','Djibouti','+253'],['DM','Dominica','+1'],['DO','Dominican Republic','+1'],['EC','Ecuador','+593'],['EG','Egypt','+20'],['SV','El Salvador','+503'],['GQ','Equatorial Guinea','+240'],['ER','Eritrea','+291'],['EE','Estonia','+372'],['SZ','Eswatini','+268'],['ET','Ethiopia','+251'],['FJ','Fiji','+679'],['FI','Finland','+358'],['FR','France','+33'],['GA','Gabon','+241'],['GM','Gambia','+220'],['GE','Georgia','+995'],['DE','Germany','+49'],['GH','Ghana','+233'],['GR','Greece','+30'],['GD','Grenada','+1'],['GT','Guatemala','+502'],['GN','Guinea','+224'],['GW','Guinea-Bissau','+245'],['GY','Guyana','+592'],['HT','Haiti','+509'],['HN','Honduras','+504'],['HU','Hungary','+36'],['IS','Iceland','+354'],['IN','India','+91'],['ID','Indonesia','+62'],['IR','Iran','+98'],['IQ','Iraq','+964'],['IE','Ireland','+353'],['IL','Israel','+972'],['IT','Italy','+39'],['JM','Jamaica','+1'],['JP','Japan','+81'],['JO','Jordan','+962'],['KZ','Kazakhstan','+7'],['KE','Kenya','+254'],['KI','Kiribati','+686'],['KP','North Korea','+850'],['KR','South Korea','+82'],['KW','Kuwait','+965'],['KG','Kyrgyzstan','+996'],['LA','Laos','+856'],['LV','Latvia','+371'],['LB','Lebanon','+961'],['LS','Lesotho','+266'],['LR','Liberia','+231'],['LY','Libya','+218'],['LI','Liechtenstein','+423'],['LT','Lithuania','+370'],['LU','Luxembourg','+352'],['MG','Madagascar','+261'],['MW','Malawi','+265'],['MY','Malaysia','+60'],['MV','Maldives','+960'],['ML','Mali','+223'],['MT','Malta','+356'],['MH','Marshall Islands','+692'],['MR','Mauritania','+222'],['MU','Mauritius','+230'],['MX','Mexico','+52'],['FM','Micronesia','+691'],['MD','Moldova','+373'],['MC','Monaco','+377'],['MN','Mongolia','+976'],['ME','Montenegro','+382'],['MA','Morocco','+212'],['MZ','Mozambique','+258'],['MM','Myanmar','+95'],['NA','Namibia','+264'],['NR','Nauru','+674'],['NP','Nepal','+977'],['NL','Netherlands','+31'],['NZ','New Zealand','+64'],['NI','Nicaragua','+505'],['NE','Niger','+227'],['NG','Nigeria','+234'],['MK','North Macedonia','+389'],['NO','Norway','+47'],['OM','Oman','+968'],['PK','Pakistan','+92'],['PW','Palau','+680'],['PS','Palestine','+970'],['PA','Panama','+507'],['PG','Papua New Guinea','+675'],['PY','Paraguay','+595'],['PE','Peru','+51'],['PH','Philippines','+63'],['PL','Poland','+48'],['PT','Portugal','+351'],['QA','Qatar','+974'],['RO','Romania','+40'],['RU','Russia','+7'],['RW','Rwanda','+250'],['KN','Saint Kitts and Nevis','+1'],['LC','Saint Lucia','+1'],['VC','Saint Vincent and the Grenadines','+1'],['WS','Samoa','+685'],['SM','San Marino','+378'],['ST','Sao Tome and Principe','+239'],['SA','Saudi Arabia','+966'],['SN','Senegal','+221'],['RS','Serbia','+381'],['SC','Seychelles','+248'],['SL','Sierra Leone','+232'],['SG','Singapore','+65'],['SK','Slovakia','+421'],['SI','Slovenia','+386'],['SB','Solomon Islands','+677'],['SO','Somalia','+252'],['ZA','South Africa','+27'],['SS','South Sudan','+211'],['ES','Spain','+34'],['SD','Sudan','+249'],['SR','Suriname','+597'],['SE','Sweden','+46'],['CH','Switzerland','+41'],['SY','Syria','+963'],['TW','Taiwan','+886'],['TJ','Tajikistan','+992'],['TZ','Tanzania','+255'],['TH','Thailand','+66'],['TL','Timor-Leste','+670'],['TG','Togo','+228'],['TO','Tonga','+676'],['TT','Trinidad and Tobago','+1'],['TN','Tunisia','+216'],['TR','Turkey','+90'],['TM','Turkmenistan','+993'],['TV','Tuvalu','+688'],['UG','Uganda','+256'],['UA','Ukraine','+380'],['AE','United Arab Emirates','+971'],['GB','United Kingdom','+44'],['US','United States','+1'],['UY','Uruguay','+598'],['UZ','Uzbekistan','+998'],['VU','Vanuatu','+678'],['VA','Vatican City','+39'],['VE','Venezuela','+58'],['VN','Vietnam','+84'],['YE','Yemen','+967'],['ZM','Zambia','+260'],['ZW','Zimbabwe','+263']
];
function optionText(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
}
function populateCountryFields(){
  const country=document.getElementById('f-country');
  const ordered=[PHONE_COUNTRIES[0], ...PHONE_COUNTRIES.slice(1).sort((a,b)=>a[1].localeCompare(b[1]))];
  if(country){
    const current=country.value || 'Sri Lanka';
    country.innerHTML=ordered.map(([,name,code])=>`<option value="${optionText(name)}">${optionText(name)} ${optionText(code)}</option>`).join('');
    country.value=[...country.options].some(o=>o.value===current) ? current : 'Sri Lanka';
  }
  // The billing country reads from the SAME list — a second hand-kept list of countries is
  // how the two selects end up disagreeing about how to spell one. Names only: this is an
  // address field, so a dial code beside it would be noise.
  const bcountry=document.getElementById('f-bcountry');
  if(bcountry){
    const names=PHONE_COUNTRIES.map(c=>c[1]).sort((a,b)=>a.localeCompare(b));
    const keep=bcountry.value;
    bcountry.innerHTML='<option value="">Choose…</option>'
      + names.map(n=>`<option value="${optionText(n)}">${optionText(n)}</option>`).join('');
    // Deliberately NOT seeded from the phone select. That one defaults to Sri Lanka as a
    // convenience, which says nothing about where a traveller banks — and a wrong billing
    // country is a weaker AVS check, the very thing this block exists to strengthen. It
    // starts unanswered and follows the dial code the moment the payer sets one.
    bcountry.value=[...bcountry.options].some(o=>o.value===keep) ? keep : '';
  }
}
populateCountryFields();

/* Billing block wiring (2026-08-03), mirroring pay.html.

   The billing country FOLLOWS the phone country until the payer touches it — a traveller who
   sets their dial code to United States and then finds "Sri Lanka" sitting in the billing
   country has been handed a wrong answer to correct, and the pay page shipped exactly that
   bug on 2026-08-02. After they choose for themselves, their choice is never overwritten. */
(function(){
  const phone=document.getElementById('f-country'), bill=document.getElementById('f-bcountry');
  if(phone && bill){
    let touched=false;
    bill.addEventListener('change',()=>{ touched=true; });
    phone.addEventListener('change',()=>{
      if(touched) return;
      const name=(phone.value||'').trim();
      if([...bill.options].some(o=>o.value===name)) bill.value=name;
    });
  }
  // Cardholder name: asked only when the payer says it differs from the lead traveller, and
  // it travels in rather than appearing fully-formed (CH.motion — nothing on this site snaps).
  const diff=document.getElementById('f-diffbill'), names=document.getElementById('billnames');
  if(diff && names){
    diff.addEventListener('change',()=>{
      if(diff.checked){
        names.hidden=false;
        if(window.CH && CH.motion) CH.motion.enter(names);
        const f=document.getElementById('f-bfirst'); if(f) f.focus();
      } else {
        const done=()=>{ names.hidden=true; };
        if(window.CH && CH.motion) CH.motion.exit(names).then(done); else done();
      }
    });
  }
})();

// ---- params + state ----
const params=new URLSearchParams(location.search);
const mode=params.get('mode'); // 'private' | 'shared' | 'trip' | null (catalogue route)
let r, isCustom, unit, perVehicle=false, vehicleLabel='', vehicleKey='car', routeNamePrefix='';
let isTrip=false, tripStops=[], tripNights=[], tripDates=[], tripKms=[], tripGaps=new Set(), tripLegs=[], tripDays=0, tripBase=0, tripFallbackPrice=0, tripEditUrl='';
let routeFromId=null, routeToId=null, vehPrices=null; // for the car→van switch
function parsedKmList(v){
  return (v||'').split(',').map(s=>{
    const n=parseInt((s||'').trim(),10);
    return Number.isFinite(n) && n>0 ? n : null;
  });
}
function tripQuoteWithKms(veh){
  const T=window.TRANSFERS;
  const baked=T.tripQuote(tripStops, veh);
  // With gaps present we must walk the per-wire loop (which skips them) rather than trust
  // baked.total, which prices every consecutive stop-pair including the gap.
  if(!tripGaps.size && !tripKms.some(km=>km!=null)) return baked;
  const legs=[];
  let total=0, totalKm=0, hasEst=false;
  for(let i=0;i<Math.max(0,tripStops.length-1);i++){
    // A gap wire is a stretch the traveller arranges themselves — carried through for display,
    // but NEVER a priced leg (it must not enter the quote, the booking, or the total).
    if(tripGaps.has(i)){ legs.push({ from:tripStops[i], to:tripStops[i+1], gap:true, km:null, price:0 }); continue; }
    const bakedLeg=baked.legs[i]||{from:tripStops[i],to:tripStops[i+1],km:null,duration:'',price:55,est:true};
    const km=tripKms[i]!=null ? tripKms[i] : bakedLeg.km;
    // A leg with no resolvable distance must still charge the baked estimate (never $0),
    // exactly as T.tripQuote does — otherwise a single unpriceable leg silently drops out
    // of the total and the customer is quoted (and charged) for one fewer leg than they take.
    let price, est=false;
    if(km!=null){ price=T.legPrice(km, veh); totalKm+=km; }
    else { price=(bakedLeg.price!=null ? bakedLeg.price : 55); est=true; hasEst=true; }
    total+=price;
    legs.push({
      from:bakedLeg.from || tripStops[i],
      to:bakedLeg.to || tripStops[i+1],
      km,
      duration:km!=null ? T.durationText(km) : bakedLeg.duration,
      price,
      est,
    });
  }
  return { legs, total, totalKm, hasEst, vehicle:veh };
}

if(mode==='trip' && window.TRANSFERS){
  const T=window.TRANSFERS;
  isTrip=true;
  tripStops=(params.get('stops')||'').split('|').map(s=>s.trim()).filter(Boolean);
  tripNights=(params.get('nights')||'').split(',').map(n=>parseInt(n)||0);
  tripDates=(params.get('dates')||'').split(',').map(s=>s.trim());
  tripKms=parsedKmList(params.get('kms'));
  tripGaps=new Set((params.get('gaps')||'').split(',').map(n=>parseInt(n,10)).filter(n=>!isNaN(n)));
  tripFallbackPrice=parseInt(params.get('price')||'0',10)||0;
  vehicleKey=params.get('vehicle')||'car';
  vehicleLabel = vehicleKey==='van' ? 'AC van (up to 6)' : 'AC car (up to 3)';
  // Chauffeur is billed by the days the car is kept = trip date span (start→end inclusive).
  // Fall back to per-stop nights, then stop count, when the trip isn't fully dated.
  tripDays=chauffeurDuration().days||tripNights.reduce((a,b)=>a+b,0)||tripStops.length;
  const q=tripQuoteWithKms(vehicleKey);
  tripLegs=q.legs;
  tripBase=q.total || tripFallbackPrice;
  r={
    id:'trip', type:'trip',
    name:'Multi-stop trip · '+tripStops.length+' stops',
    stops:tripStops, price:tripBase, times:[]
  };
  isCustom=false; unit=tripBase; perVehicle=true;
} else if(mode && window.TRANSFERS){
  const T=window.TRANSFERS;
  routeFromId=params.get('from'); routeToId=params.get('to');
  const fromP=T.place(routeFromId)||{name:routeFromId||'Pick-up'};
  const toP=T.place(routeToId)||{name:routeToId||'Drop-off'};
  // Search passes both the polished display price and its raw fare. Keep the raw fare internally
  // so extras are added before the one final finishing pass; older links without rawPrice retain
  // their existing price contract and are finished once by calcTotal().
  let price=parseFloat(params.get('rawPrice') || params.get('price'))||0;
  vehicleKey=params.get('vehicle')||'car';
  vehicleLabel = vehicleKey==='van' ? 'AC van (up to 6)' : 'AC car (up to 3)';
  // pre-compute both vehicle prices so we can switch car→van when over capacity
  if(T.place(routeFromId) && T.place(routeToId)){
    const q=T.privateQuote(routeFromId, routeToId);
    // Keep the unfinished vehicle fares internally so extras are added before the one final
    // price-finishing pass in calcTotal(). privateQuote's car/van fields are display totals.
    vehPrices={ car:q.rawCar, van:q.rawVan };
  }
  r={
    id:'transfer', type:mode,
    name:(mode==='private'?'Private transfer':'Shared ride')+' · '+fromP.name+' → '+toP.name,
    stops:[fromP.name, toP.name], price:price, mapBg:'ph-teal',
    times:(params.get('times')||'').split(',').filter(Boolean)
  };
  isCustom=false; unit=price; perVehicle=(mode==='private');
  routeNamePrefix = (mode==='private'?'Private transfer':'Shared ride');
} else {
  r=getRoute(params.get('id'));
  // No/unknown catalogue id → send them to the planner rather than defaulting to a route.
  if(!r){ location.replace('plan.html'); throw new Error('no catalogue route — redirected to planner'); }
  // price==null is the "You decide" placeholder route: there is nothing real to charge for,
  // and it used to bill $60/adult. Treat it like an unknown id.
  if(r.price==null){ location.replace('plan.html'); throw new Error('placeholder route — redirected to planner'); }
  isCustom = false;
  unit = r.price;
}

const VEH_CAP = { car:{pax:3,bags:3}, van:{pax:6,bags:6} };
let maxBags = perVehicle ? (VEH_CAP[vehicleKey]||VEH_CAP.car).bags : 6;
let vehPax = perVehicle ? (VEH_CAP[vehicleKey]||VEH_CAP.car).pax : 6;
// luggage can be dialled past the current vehicle's limit so we can prompt a van
// upgrade (mirrors the passenger over-capacity flow); the van is the hard ceiling
const ABS_MAX_BAGS = perVehicle ? VEH_CAP.van.bags : 6;
const isShared = (!isTrip && r.type==='shared');
const sharedCorridorId = params.get('corridor') || (r && r.corridor) || '';

// Shared rides run a fixed weekly schedule — seats depart only on set weekdays
// (0=Sun … 6=Sat), passed via ?days= (search builds it from the corridor). Mirrors the
// backend `serviceDays` (POST /bookings/shared rejects off-schedule dates); default Wed &
// Sat if a shared link omits it. null for non-shared bookings.
const DOW_LABEL=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function parseServiceDays(s){
  const out=(s||'').split(',').map(n=>parseInt(n,10)).filter(n=>n>=0&&n<=6);
  return out.length?[...new Set(out)].sort((a,b)=>a-b):[3,6];
}
const sharedDays = isShared ? parseServiceDays(params.get('days')) : null;
const sharedDaysLabel = sharedDays ? sharedDays.map(d=>DOW_LABEL[d]).join(' & ') : '';

// trip start date (chauffeur day count)
const startParam = params.get('start') || params.get('date');
const timeParam = params.get('time') || '';
const state={
  date: startParam ? new Date(startParam+'T00:00:00') : null,
  dep: null,
  flexDate: false,
  flexTime: false,
  svc: 'private',          // 'private' | 'chauffeur' (trip mode only)
  payPlan: 'full',
  ad: Math.max(1, parseInt(params.get('ad'))||parseInt(params.get('pax'))||1),
  ch: Math.max(0, parseInt(params.get('ch'))||0),
  addons: new Set(),
  bags: Math.min(2, maxBags),
  locFrom: '',
  locTo: '',
  locFromGeo: null,   // {name,address,lat,lng} when picked from Google Places
  locToGeo: null
};
// Baseline "standard route" distance for the pre-filled endpoints — used to judge
// how far a customer's exact pick-up/drop-off drifts before we re-price.
state.anchorKm = (window.TRANSFERS ? window.TRANSFERS.kmBetween(r.stops[0], r.stops[r.stops.length-1]) : null);
state.pendingReprice = null; // {km, extraKm, prices:{car,van}} while awaiting acknowledgement
state.locTooFar = null;      // {which,name,area,km,limit} when an exact spot leaves its area

// The route estimate selected on Search travels separately from price. Keeping the raw km/min
// and its identity means Booking can render the exact same customer copy before any map or live
// re-price finishes. Older/direct links fall back to the reviewed catalogue pair when available.
function positiveNumberParam(name){
  const n=Number(params.get(name));
  return Number.isFinite(n) && n>0 ? n : null;
}
function selectedBrowseEstimate(){
  const passedKm=positiveNumberParam('estimateKm');
  const passedMin=positiveNumberParam('estimateMin');
  const passedState=params.get('estimateState');
  if(passedKm!=null || passedMin!=null){
    return {
      distanceKm:passedKm,
      durationMin:passedMin,
      state:passedState==='estimated'?'estimated':'browse',
      estimateId:params.get('estimateId')||'search-selection'
    };
  }
  if(window.TRANSFERS && routeFromId && routeToId){
    const q=window.TRANSFERS.privateQuote(routeFromId,routeToId);
    if(q && (q.km>0 || q.durationMin>0)) return {
      distanceKm:q.km,
      durationMin:q.durationMin,
      state:q.estimated?'estimated':'browse',
      estimateId:`${routeFromId}>${routeToId}:reviewed-v1`
    };
  }
  return { state:'unavailable', estimateId:'unavailable' };
}
const browseRouteEstimate=selectedBrowseEstimate();
let activeRouteEstimate=Object.assign({},browseRouteEstimate);
let routeEstimateUnavailable=false;
let lastRouteAnnouncement='';

// ---- summary setup ----
const typeLabel={shared:'Shared ride',custom:'Private & custom',private:'Private transfer',trip:'Multi-stop trip'};
document.getElementById('sum-type').innerHTML=typeLabel[r.type];
document.getElementById('sum-name').textContent=r.name;
document.getElementById('sum-from').textContent=r.stops[0];
document.getElementById('sum-to').textContent=r.stops[r.stops.length-1];
document.querySelector('#s-wa .ic').innerHTML=ICON.wa;
document.getElementById('cal').dataset.x='';

// ---- location-first entry (maps-powered autocomplete) ----
// Suggestion list = known places (+ "— your hotel/town centre" variants).
const ACPLACES = (function(){
  const base = (window.placeNames ? window.placeNames() : []);
  const out=[];
  base.forEach(n=>{ out.push(n); out.push(n+' — your hotel'); out.push(n+' — town centre'); });
  out.push('Bandaranaike Intl Airport (CMB) — Arrivals');
  return [...new Set(out)];
})();

const locFrom=document.getElementById('loc-from'), locTo=document.getElementById('loc-to');
// The route's endpoints were chosen on the homepage — they're settled, shown as done
// chips above each field. The inputs stay EMPTY and collect only the exact spot
// (hotel/address/landmark); untouched, everything falls back to the area itself.
const AREA_FROM = r.stops[0], AREA_TO = r.stops[r.stops.length-1];
(function(){ const cf=document.querySelector('#loc-area-from b'), ct=document.querySelector('#loc-area-to b');
  if(cf) cf.textContent=AREA_FROM; if(ct) ct.textContent=AREA_TO; })();
state.locFrom = AREA_FROM;
state.locTo   = AREA_TO;
let _rmTimer=null;
let userSetLocation=false; // true once the customer actively picks a pickup/drop-off
function scheduleRouteMap(){ clearTimeout(_rmTimer); _rmTimer=setTimeout(renderRouteMap, 450); }
const acEsc = s => (s||'').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function setGeo(which, geo){ if(which==='from') state.locFromGeo=geo; else state.locToGeo=geo; }
function hasExactRouteInputs(){
  return !isTrip && !isShared && (state.locFrom!==AREA_FROM || state.locTo!==AREA_TO);
}

function onLoc(){
  // exact spot when given; otherwise the settled area (payload, summary, map and the
  // reprice anchor all read these, so "no exact spot yet" behaves like the old prefill)
  state.locFrom = locFrom.value.trim() || AREA_FROM;
  state.locTo   = locTo.value.trim()   || AREA_TO;
  if(!hasExactRouteInputs()){
    activeRouteEstimate=Object.assign({},browseRouteEstimate);
    routeEstimateUnavailable=false;
  }
  checkExactRadius();
  render(); checkWhere(); scheduleRouteMap();
}

// The exact spot must stay within its area — a hotel/landmark, not a new route.
// Resolve the current spot to a point (Google geo when picked, else the known-place
// coords for a typed name) and compare it to the area the customer already chose.
const _nrm = s => (s||'').toLowerCase().replace(/\(.*?\)/g,'').replace(/[^a-z]/g,'').trim();
function spotPoint(which){
  const geo = which==='from' ? state.locFromGeo : state.locToGeo;
  if(geo && geo.lat!=null) return { lat:geo.lat, lng:geo.lng };  // a real pick — precise
  const typed = which==='from' ? state.locFrom : state.locTo;
  const area  = which==='from' ? AREA_FROM : AREA_TO;
  if(!typed || typed===area) return null;                 // unchanged / the area itself
  const T=window.TRANSFERS, p = T && T.resolvePlace ? T.resolvePlace(typed) : null;
  // Only a settled, whole known place name counts — never a half-typed prefix that
  // happens to fuzzy-match (so the block doesn't flash while the customer is typing).
  return (p && _nrm(p.name)===_nrm(typed)) ? { lat:p.lat, lng:p.lng } : null;
}
function checkExactRadius(){
  state.locTooFar = null;
  const T=window.TRANSFERS;
  if(isTrip || !T || !T.exactSpotDecision || !T.resolvePlace) return;
  for(const which of ['from','to']){
    const area = which==='from' ? AREA_FROM : AREA_TO;
    const ap = T.resolvePlace(area), sp = spotPoint(which);
    if(!ap || !sp) continue;
    const d = T.exactSpotDecision(ap, sp);
    if(!d.ok){
      state.locTooFar = { which, name:(which==='from'?state.locFrom:state.locTo), area, km:d.km, limit:d.limit };
      state.pendingReprice = null;                         // a hard block supersedes any re-price offer
      if(typeof window.chTrack==='function') window.chTrack('exact_location_out_of_range',{which,km:d.km});
      break;
    }
  }
}
window.clearExactSpot=function(which){
  const input = which==='from' ? locFrom : locTo;
  input.value=''; setGeo(which,null); onLoc(); input.focus();
};

// "Decide later" — a legitimate answer: collapse the input into a friendly note and
// keep the area as the location (original anchor km, so the price never moves).
function wireDecideLater(which){
  const field=document.getElementById('loc-field-'+which), input=which==='from'?locFrom:locTo;
  const later=document.getElementById('loc-later-'+which), note=document.getElementById('loc-note-'+which);
  const undo=document.getElementById('loc-undo-'+which);
  if(!field||!later||!note||!undo) return;
  later.addEventListener('click',()=>{
    input.value=''; setGeo(which,null); onLoc();
    field.classList.add('decided-later'); note.hidden=false;
    if(typeof window.chTrack==='function') window.chTrack('exact_location_deferred',{which});
  });
  undo.addEventListener('click',()=>{
    field.classList.remove('decided-later'); note.hidden=true;
    input.focus();
  });
}
wireDecideLater('from'); wireDecideLater('to');

// Pickup/drop-off autocomplete. With the Maps key + Places API we show live
// Google suggestions restricted to Sri Lanka; otherwise we fall back to the
// built-in list of known places so the field still works offline.
function attachAC(input, menu, which){
  let active=-1, els=[], data=[], seq=0, committed=false, openedAt=0;
  const pinIco='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-4.7-7-10a7 7 0 0 1 14 0c0 5.3-7 10-7 10z"/><circle class="wp" cx="12" cy="11" r="2"/></svg>';
  function close(invalidate=true){ menu.classList.remove('open'); menu.innerHTML=''; active=-1; els=[]; data=[]; if(invalidate) seq++; }
  function paint(){ els.forEach((it,i)=>it.classList.toggle('active',i===active)); }

  async function choose(i){
    const d=data[i]; if(!d) return;
    committed=true;
    seq++;
    userSetLocation=true; // a deliberate selection — now the price may re-price
    input.value=d.label; onLoc(); close();
    if(d.kind==='google' && window.CH_MAP && window.CH_MAP.resolvePick){
      const geo = await window.CH_MAP.resolvePick(d.item);
      setGeo(which, geo);
      if(geo && geo.name) input.value=geo.name;
      onLoc();                       // re-run with geo in hand so the radius guard can see it
      renderRouteMap();
    } else {
      setGeo(which, null);
      onLoc();
      renderRouteMap();
    }
  }

  function renderMenu(opts={}){
    if(!data.length && !opts.loading){ close(false); return; }
    menu.innerHTML = data.map(d=>{
      const sub = d.secondary ? `<small>${acEsc(d.secondary)}</small>` : '';
      return `<div class="ac-item"><span class="ac-ic">${pinIco}</span><span class="ac-tx"><b>${acEsc(d.main||d.label)}</b>${sub}</span></div>`;
    }).join('') + (opts.loading ? `<div class="ac-item loading" aria-disabled="true"><span class="ac-ic">${pinIco}</span><span class="ac-tx"><b>Searching Google…</b><small>Google</small></span></div>` : '');
    menu.classList.add('open');
    openedAt=Date.now();
    els=[...menu.querySelectorAll('.ac-item:not(.loading)')]; active=-1;
    els.forEach((it,i)=>{
      it.addEventListener('mousedown',e=>{ e.preventDefault(); choose(i); });
      it.addEventListener('mouseenter',()=>{ active=i; paint(); });
    });
  }

  function localList(qs){
    if(window.TRANSFERS && window.TRANSFERS.placeSuggestions){
      const local = window.TRANSFERS.placeSuggestions(qs, 6).map(p=>({
        kind:'local',
        label:p.label,
        main:p.label,
        secondary:p.source==='known' ? 'Popular Route' : 'Popular place'
      }));
      if(local.length) return local;
    }
    const ql=qs.toLowerCase();
    const matches=(qs?ACPLACES.filter(p=>p.toLowerCase().includes(ql)):ACPLACES.slice(0,6)).slice(0,6);
    return matches.map(m=>({kind:'local', label:m, main:m, secondary:'Popular place'}));
  }
  function shouldAskGoogle(qs, local){
    if(!window.CH_MAP || !window.CH_MAP.suggest || !window.CEYLON_MAPS_KEY || qs.length<2) return false;
    const exactLocal = local.some(p => (p.label||'').toLowerCase() === qs.toLowerCase());
    const oneWord = !/\s/.test(qs.trim());
    return !exactLocal && !(oneWord && local.length>=3);
  }

  async function build(){
    const qs=input.value.trim();
    const mySeq=++seq;
    committed=false;
    const local = localList(qs);
    data = local;
    const loading = shouldAskGoogle(qs, local);
    renderMenu({ loading });
    // Ceylon Hop known/popular suggestions always stay first. Google fills in
    // hotels/landmarks/exact places when the local catalogue is weak.
    if(shouldAskGoogle(qs, local)){
      let sug=[];
      try{ sug=await window.CH_MAP.suggest(qs); }catch(e){ sug=[]; }
      if(mySeq!==seq || committed || document.activeElement!==input) return;            // a newer keystroke already fired
      if(sug.length){
        const seen=new Set(local.map(x=>(x.label||'').toLowerCase()));
        data = local.concat(sug.map(s=>({kind:'google', label:s.text, main:s.main, secondary:s.secondary || 'Google', item:s}))
          .filter(x=>!seen.has((x.label||'').toLowerCase()))).slice(0,8);
        renderMenu(); return;
      }
    }
    if(mySeq!==seq) return;
    data = local;
    renderMenu();
  }

  input.addEventListener('input',()=>{ setGeo(which, null); onLoc(); build(); });
  input.addEventListener('focus',build);
  input.addEventListener('keydown',e=>{
    if(!menu.classList.contains('open')) return;
    if(e.key==='ArrowDown'){ e.preventDefault(); active=Math.min(els.length-1,active+1); paint(); }
    else if(e.key==='ArrowUp'){ e.preventDefault(); active=Math.max(0,active-1); paint(); }
    else if(e.key==='Enter'){ if(active>=0){ e.preventDefault(); choose(active); } }
    else if(e.key==='Escape'){ close(); }
  });
  input.addEventListener('blur',()=>setTimeout(close,150));
  window.addEventListener('scroll',()=>{ if(Date.now()-openedAt>250) close(); },true);
  window.addEventListener('wheel',()=>close(),{passive:true});
  window.addEventListener('touchmove',()=>close(),{passive:true});
}
attachAC(locFrom, document.getElementById('ac-from'), 'from');
attachAC(locTo, document.getElementById('ac-to'), 'to');

// ---- route map on the Where step (Google-Maps-backed in production) ----
// Plots the pickup + drop-off on a stylised Sri Lanka map once both ends resolve.
function renderRouteMap(){
  clearTimeout(_rmTimer);
  const host=document.getElementById('route-map');
  if(!host || isTrip) return; // trip mode shows the full itinerary route elsewhere
  const T=window.TRANSFERS;
  const fromName=state.locFrom, toName=state.locTo;
  if(!fromName || !toName){ host.hidden=true; return; }
  host.hidden=false;

  const short = n => (n||'').replace(/\s*\(.*?\)/,'');
  // local coords only resolve for known places; typed Google places won't have them
  const a = T ? T.resolvePlace(fromName) : null;
  const b = T ? T.resolvePlace(toName)   : null;

  // Stylised-island SVG fallback — only drawable when both ends are known places.
  let svg='';
  if(a && b){
    const W=344, H=250, padX=80, padY=44;
    const LAT0=9.95, LAT1=5.80, LNG0=79.55, LNG1=82.0;
    const proj=(lat,lng)=>({
      x: padX + (lng-LNG0)/(LNG1-LNG0)*(W-2*padX),
      y: padY + (LAT0-lat)/(LAT0-LAT1)*(H-2*padY)
    });
    const pa=proj(a.lat,a.lng), pb=proj(b.lat,b.lng);
    const island=`<path d="M172 28 C214 32 246 64 248 112 C250 152 234 182 214 206 C199 224 184 234 172 234 C160 234 145 224 130 206 C110 182 94 152 96 112 C98 64 130 32 172 28 Z" fill="#cfe7da" stroke="#a9d2c2" stroke-width="1.5"/>`;
    const line=`<path d="M${pa.x.toFixed(1)} ${pa.y.toFixed(1)} L${pb.x.toFixed(1)} ${pb.y.toFixed(1)}" fill="none" stroke="#0AB9B6" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="1 7"/>`;
    const pin=(p,fill,num,name)=>{
      const labelLeft = p.x>W*0.58;
      const lx = labelLeft ? p.x-11 : p.x+11;
      const anchor = labelLeft ? 'end' : 'start';
      return `<g>
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="8.5" fill="${fill}" stroke="#fff" stroke-width="2"/>
        <text class="rm-pin-num" x="${p.x.toFixed(1)}" y="${(p.y+2.6).toFixed(1)}" text-anchor="middle">${num}</text>
        <text class="rm-pin-label" x="${lx.toFixed(1)}" y="${(p.y+2.5).toFixed(1)}" text-anchor="${anchor}">${short(name)}</text>
      </g>`;
    };
    svg=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Map from ${a.name} to ${b.name}">${island}${line}${pin(pa,'#24758A','A',a.name)}${pin(pb,'#EC3A24','B',b.name)}</svg>`;
  }

  const localKm = T ? T.kmBetween(fromName, toName) : null;
  // Customer copy comes only from the selected/server estimate. The map below is visual context;
  // its independent route result must never replace the figures Search handed into Booking.
  paintCustomerRouteEstimate();

  // Clean Google map (route line, no panel/markers) with a loading state; SVG fallback.
  const canvas=document.getElementById('rm-canvas');
  canvas.hidden=false;
  const showFallback=()=>{ canvas.innerHTML = svg; if(!svg) canvas.hidden=true; };
  if(window.CH_MAP && window.CH_MAP.renderRoute){
    const pFrom = state.locFromGeo && state.locFromGeo.lat!=null ? {lat:state.locFromGeo.lat, lng:state.locFromGeo.lng} : fromName;
    const pTo   = state.locToGeo   && state.locToGeo.lat!=null   ? {lat:state.locToGeo.lat,   lng:state.locToGeo.lng}   : toName;
    window.CH_MAP.renderRoute(canvas, [pFrom, pTo], {
      expandable: true,
      // pFrom/pTo are {lat,lng} once the customer picks from autocomplete, so the legend
      // can't read a name off them — hand it the display names explicitly.
      stopLabels: [fromName, toName],
      onFail: showFallback,
      onRoute: ({km, durationMin}) => {
        // re-price single private transfers from the REAL driving distance so the
        // summary total always matches the route actually shown on the map. Once the engine has
        // actually DELIVERED an estimate this session, its own figure already prices the real
        // route server-side (its intent carries place names, never a client-measured distance —
        // Global Constraints), so this local heads-up would just double the engine-raise notice
        // for the same drift. CH_PRICING.available() alone is the wrong gate here: it stays true
        // on a network error or timeout (only a 404 — flag off — latches it false), so gating on
        // it would silently drop the local notice in exactly the world where the local formula is
        // still the one setting the price. engineEst is only ever set by a successful adopt
        // (adoptEngineEstimate), so "has it ever been set" is "has the engine ever answered".
        const engineHandlesReprice = window.CH_PRICING && engineEst != null;
        if(km!=null && userSetLocation && perVehicle && !isTrip && T && T.legPrice && !state.locTooFar && !engineHandlesReprice){
          const dec = T.repriceDecision(state.anchorKm, km, unit, vehicleKey);
          state.routeKm = km;
          if(dec.action==='confirm'){
            // Material upward drift — park the new price, warn, don't touch the total yet.
            state.pendingReprice = { km, extraKm: dec.extraKm,
              prices: { car: T.legPrice(km,'car'), van: T.legPrice(km,'van') } };
            if(typeof window.chTrack==='function') window.chTrack('reprice_shown',{extra_km:dec.extraKm});
          } else {
            // 'hold' — firm floor: the quoted price never drops, so keep it and clear
            // any pending notice (e.g. the customer picked a closer/within-buffer spot).
            state.pendingReprice = null;
          }
          render(); checkWhere();
        }
      },
    });
  } else {
    showFallback();
  }
}

// ---- TRIP MODE: itinerary route + service chooser instead of single locations ----
if(isTrip){
  // hide single-location entry; the itinerary stops ARE the route
  document.getElementById('loc-wrap').style.display='none';
  // A single-day trip has only one sensible shape, so there's no "how you'll travel"
  // choice to make — the copy drops the "choose how" framing (see the chooser below).
  const _oneDay = isSingleDayTrip();
  document.getElementById('s1-title').textContent = _oneDay ? 'Your trip' : 'Your trip & how you’ll travel';
  document.getElementById('s1-sub').textContent = _oneDay
    ? 'Review your route — your dates carry over from the planner, and we’ll fine-tune every stop and time with you after booking.'
    : 'Review your route and choose how you’d like to travel. Your dates carry over from the planner — we’ll fine-tune every stop and time with you after booking.';
  // render the route summary with an edit link back to the planner
  const tr=document.getElementById('trip-route');
  tr.style.display='block';
  const fmtLeg=(iso)=>{ if(!iso) return ''; const d=new Date(iso+'T00:00:00'); return isNaN(d)?'':d.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'}); };
  let html='<div class="tr-leg-list">';
  let _legNo=0;
  tripLegs.forEach((leg,i)=>{
    if(leg.gap){
      html+=`<div class="tr-leg tr-gap"><div class="tr-leg-main"><span class="tr-leg-title">${leg.from} <span class="tr-ar">→</span> ${leg.to}</span></div>`+
        `<div class="tr-leg-meta"><span class="tr-chip muted">You arrange this stretch — not included</span></div></div>`;
      return;
    }
    const dt=fmtLeg(tripDates[i]);
    const drive=leg.km!=null ? `${leg.km} km · ${leg.duration}` : 'Distance on request';
    html+=`<div class="tr-leg">`+
      `<div class="tr-leg-main"><span class="tr-leg-badge">Leg ${++_legNo}</span><span class="tr-leg-title">${leg.from} <span class="tr-ar">→</span> ${leg.to}</span></div>`+
      `<div class="tr-leg-meta">`+
        (dt?`<span class="tr-chip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 9.5h17M8 2.8V6M16 2.8V6"/><circle class="wp" cx="12" cy="15" r="1.9"/></svg>${dt}</span>`:`<span class="tr-chip muted">Date flexible</span>`)+
        `<span class="tr-chip muted">${drive}</span>`+
      `</div></div>`;
  });
  html+='</div>';
  const editUrl='plan.html?'+new URLSearchParams({stops:tripStops.join('|'),nights:tripNights.join(','),dates:tripDates.join(','),kms:tripKms.map(km=>km!=null?String(km):'').join(','),gaps:[...tripGaps].join(','),pax:String(state.ad+state.ch),vehicle:vehicleKey,start:(startParam||'')}).toString();
  // booking sits after the planner's “When” step, so Back / “Add your dates” should land on the
  // dates step (not the route-building view); “Edit this itinerary” still opens the route view
  const datesUrl=editUrl+'&step=dates';
  // chauffeur status (missing-dates prompt or day-count confirmation) lives INSIDE this card,
  // so the itinerary and the service status read as a single consolidated box (filled by render)
  html+='<div id="chauffeur-extra" class="cx-inline" style="display:none"></div>';
  html+=`<div class="tr-foot"><button type="button" class="tr-edit" onclick="location.href='${editUrl}'"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg> Edit this itinerary</button></div>`;
  tr.innerHTML=html;
  tripEditUrl=datesUrl;
  // a clear way back to the planner from the booking flow (task: no way back)
  const nav1=document.getElementById('nav1');
  if(nav1 && nav1.firstElementChild){
    const back=document.createElement('button');
    back.type='button'; back.className='back-link'; back.textContent='← Back to planner';
    back.onclick=()=>location.href=datesUrl;
    nav1.replaceChild(back, nav1.firstElementChild);
  }
  // Show the private vs chauffeur chooser ONLY when there's a real choice — i.e. a multi-day
  // trip, where "keep the car with you" vs "a fresh transfer each leg" actually differ. A
  // single-day trip has one sensible shape (a private car & driver through your stops that
  // day), so the chooser is hidden entirely rather than shown as a one-option "choice".
  const svcCh=document.getElementById('svc-chooser');
  const chBtn=svcCh.querySelector('.svc[data-svc="chauffeur"]');
  if(isSingleDayTrip()){
    state.svc='private';
    svcCh.style.display='none';
  } else {
    svcCh.style.display='grid';
    svcCh.style.gridTemplateColumns='';
    if(chBtn) chBtn.style.display='';   // undo any prior single-day hide
  }
  // adjust the progress label
  const lbl=document.getElementById('lbl-s1'); if(lbl) lbl.textContent='Trip & service';

  // Dates are chosen per leg in the planner, so the standalone “When” step is dropped here.
  // Show the whole multi-stop journey as one 5-step bar — Route · Dates were done on the
  // planner, then Service · Travellers · Payment happen here — so travellers always see where
  // they are and what’s left.
  (function buildJourney(){
    // NOTE: in the markup panel 1 is the standalone "When" step and panel 2 is the
    // "Where" step that we repurpose into the trip itinerary + service chooser.
    const tripPanel=document.querySelector('.panel[data-panel="2"]');   // Trip & service (repurposed Where)
    const whenPanel=document.querySelector('.panel[data-panel="1"]');   // When (dropped — dates come from the planner)
    const tvPanel=document.querySelector('.panel[data-panel="3"]');     // Travellers
    const dtPanel=document.querySelector('.panel[data-panel="4"]');     // Details & payment
    const tvBack=tvPanel && tvPanel.querySelector('.back-link');
    const dtBack=dtPanel && dtPanel.querySelector('.back-link');
    // trips already know the headcount up front and price per vehicle, so the adult/child split
    // adds nothing here — slim this step to luggage + the capacity/van check.
    const adStep=document.getElementById('ad-step'); if(adStep) adStep.style.display='none';
    const chStep=document.getElementById('ch-step'); if(chStep) chStep.style.display='none';
    if(tvPanel){
      const pax=state.ad+state.ch;
      const h=tvPanel.querySelector('h2'); if(h) h.textContent='Your vehicle';
      const bagCap=document.getElementById('bag-cap'); const bagStepper=bagCap?bagCap.closest('.stepper'):null; if(bagStepper) bagStepper.style.display='none';
      // Offer BOTH vehicles here so travellers can switch car ⇄ van. A car seats 3, so it's
      // only selectable when the group fits (4+ travellers ⇒ van only). Switching re-prices the trip.
      const carSvg='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l1.5-4.5A2 2 0 0 1 8.4 7h7.2a2 2 0 0 1 1.9 1.5L19 13M5 13h14m-14 0v4m0 0v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1m10 0v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1m0 0v-4M7 17h.01M17 17h.01"/></svg>';
      const vanSvg='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 14V7a2 2 0 0 1 2-2h9v9M14 9h3l3 3.5V14M3 14h17"/><circle cx="7" cy="17" r="1.6"/><circle cx="17" cy="17" r="1.6"/></svg>';
      const tickSvg='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 7"/></svg>';
      const vehChoose=document.createElement('div'); vehChoose.className='trip-veh-choose';
      function vehOptHtml(key,label,cap,ico){
        const disabled = key==='car' && pax>3;
        return '<button type="button" class="tvc-opt'+(key===vehicleKey?' on':'')+'" data-veh="'+key+'"'+(disabled?' disabled':'')+'>'+
          '<span class="tvc-ico">'+ico+'</span>'+
          '<span class="tvc-tx"><b>'+label+'</b><small>'+(disabled?('Too small for '+pax+' travellers'):('Room for up to '+cap+' large bags'))+'</small></span>'+
          '<span class="tvc-check">'+tickSvg+'</span></button>';
      }
      function paintVeh(){
        vehChoose.innerHTML=vehOptHtml('car','AC car (up to 3)',3,carSvg)+vehOptHtml('van','AC van (up to 6)',6,vanSvg);
        vehChoose.querySelectorAll('.tvc-opt').forEach(btn=>{
          if(btn.disabled) return;
          btn.addEventListener('click',()=>{
            const key=btn.dataset.veh; if(key===vehicleKey) return;
            vehicleKey=key;
            vehicleLabel = key==='van' ? 'AC van (up to 6)' : 'AC car (up to 3)';
            maxBags=(VEH_CAP[key]||VEH_CAP.car).bags; vehPax=(VEH_CAP[key]||VEH_CAP.car).pax;
            if(state.bags>maxBags) state.bags=maxBags;
            const q=tripQuoteWithKms(key); tripLegs=q.legs; tripBase=q.total; unit=tripBase; r.price=tripBase;
            paintVeh(); render();
          });
        });
      }
      paintVeh();
      const subEl=tvPanel.querySelector('.sub'); if(subEl) subEl.after(vehChoose);
      const sb=document.getElementById('sum-bags'); if(sb && sb.closest('.s-row')) sb.closest('.s-row').style.display='none';
      const sub=tvPanel.querySelector('.sub'); if(sub) sub.textContent=`You\u2019re all set for ${pax} traveller${pax>1?'s':''} \u2014 we send the vehicle you picked, with room for your bags.`;
    }
    // renumber panels into the journey: Service=3, Payment=4; park the dropped When + vehicle steps
    if(whenPanel){ whenPanel.dataset.panel='99'; whenPanel.classList.remove('active'); }
    if(tripPanel) tripPanel.dataset.panel='3';
    // vehicle & headcount are fixed in the planner, so the standalone vehicle step is dropped here
    if(tvPanel){ tvPanel.dataset.panel='97'; tvPanel.classList.remove('active'); }
    if(dtPanel) dtPanel.dataset.panel='4';
    // rebuild the progress bar as the full 4-step journey (Route/Dates already completed on the planner)
    const steps=document.getElementById('psteps');
    if(steps){
      steps.innerHTML=
        '<div class="pstep planner-step" data-s="1"><span class="dot">1</span><span class="lbl">Route</span></div>'+
        '<div class="pline"></div>'+
        '<div class="pstep planner-step" data-s="2"><span class="dot">2</span><span class="lbl">Dates</span></div>'+
        '<div class="pline"></div>'+
        '<div class="pstep active" data-s="3"><span class="dot">3</span><span class="lbl">Service</span></div>'+
        '<div class="pline"></div>'+
        '<div class="pstep" data-s="4"><span class="dot">4</span><span class="lbl">Pay</span></div>';
      // the two leading nodes jump back to the planner (Route / Dates live there)
      steps.querySelectorAll('.planner-step').forEach(ps=>{ ps.title='Back to the planner'; ps.addEventListener('click',()=>{ location.href=editUrl; }); });
    }
    // rewire navigation to the journey numbering (n1’s click listener is made trip-aware where it’s bound)
    const n4=document.getElementById('n4'); if(n4) n4.setAttribute('onclick','goStep(4)'); // (parked) Travellers → Payment
    if(tvBack) tvBack.setAttribute('onclick','goStep(3)');                                  // (parked) Travellers ← Service
    if(dtBack) dtBack.setAttribute('onclick','goStep(3)');                                  // Payment ← Service
    // tidy the summary: no single departure time on a multi-leg trip; label the date as the trip start
    const timeRow=document.getElementById('sum-time'); if(timeRow && timeRow.closest('.s-row')) timeRow.closest('.s-row').style.display='none';
    const dateRow=document.getElementById('sum-date'); if(dateRow && dateRow.closest('.s-row')){ const lab=dateRow.closest('.s-row').querySelector('span'); if(lab) lab.textContent='Trip start'; }
    // the full itinerary (every stop + leg date) already lives in the main column,
    // so the sidebar doesn't repeat it — a concise “Trip start” line is enough here
    const sRoute=document.getElementById('s-route');
    if(sRoute) sRoute.style.display='none';
  })();
}

// ===== SHARED RIDE: fixed route + fixed weekly schedule, sold per seat =====
// A shared seat is not a private/custom transfer: the corridor and the departure
// times are set, so we don't ask for locations or an arbitrary pick-up time. We
// confirm the ride, then collect a date + a scheduled departure + how many seats.
if(!isTrip && r.type==='shared'){
  const fmtT=function(t){var p=String(t).split(':');var H=+p[0];return (((H+11)%12)+1)+':'+p[1]+' '+(H<12?'am':'pm');};
  const times=(r.times&&r.times.length)?r.times:['07:30'];
  const timesTxt=times.map(fmtT).join(' & ');
  const ICO_CLOCK='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
  const ICO_SEAT='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M5 11V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v5m-8 0h12a2 2 0 0 1 2 2v3M5 11a2 2 0 0 0-2 2v3m0 0h18"/></svg>';
  const ICO_INFO='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/></svg>';

  // STEP 1 — confirm the fixed ride (no editable pick-up/drop-off)
  const locWrap=document.getElementById('loc-wrap'); if(locWrap) locWrap.style.display='none';
  const pvtNote=document.getElementById('pvt-note'); if(pvtNote) pvtNote.style.display='none';
  const s1t=document.getElementById('s1-title'); if(s1t) s1t.textContent='Your shared ride';
  const s1s=document.getElementById('s1-sub'); if(s1s) s1s.textContent='A reserved seat on our scheduled service ('+sharedDaysLabel+') along this route. Pick-up and drop-off are at set meeting points.';
  const card=document.createElement('div'); card.className='shared-route';
  card.innerHTML=
    '<div class="sr-line"><span class="sr-pin from"></span><div><span class="sr-lbl">Board at</span><b>'+r.stops[0]+'</b></div></div>'+
    '<div class="sr-wire"></div>'+
    '<div class="sr-line"><span class="sr-pin to"></span><div><span class="sr-lbl">Drop-off</span><b>'+r.stops[r.stops.length-1]+'</b></div></div>'+
    '<div class="sr-foot">'+
      '<span class="sr-fact">'+ICO_CLOCK+'<span>Departs <b>'+timesTxt+'</b> \u00b7 '+sharedDaysLabel+'</span></span>'+
      '<span class="sr-fact">'+ICO_SEAT+'<span><b>'+money(r.price)+'</b> per seat</span></span>'+
    '</div>'+
    '<p class="sr-note">'+ICO_INFO+'Exact pick-up &amp; drop-off are set meeting points along the route \u2014 our team confirms them with you after you book.</p>';
  if(locWrap) locWrap.after(card);

  // STEP 2 — pick a date + a SCHEDULED departure (no "any time", no decide-later time)
  const s2t=document.getElementById('s2-title'); if(s2t) s2t.textContent='When are you travelling?';
  const s2s=document.getElementById('s2-sub'); if(s2s) s2s.textContent='Pick your travel date \u2014 our shared seats run on set days ('+sharedDaysLabel+').';
  const calEl=document.getElementById('cal');
  if(calEl && !document.getElementById('shared-cal-note')){
    const cnote=document.createElement('p'); cnote.id='shared-cal-note'; cnote.className='shared-cal-note';
    // Naming the alternative without linking it left the customer to re-navigate by hand.
    cnote.innerHTML='<b>'+sharedDaysLabel+' only.</b> Our shared seats run on these days \u2014 <a href="'+backToSearchUrl()+'">book a private transfer</a> for any other day.';
    calEl.after(cnote);
  }
  const depLabel=document.getElementById('dep-label'); if(depLabel) depLabel.textContent='Departure';
  const dateLabel=document.getElementById('date-label'); if(dateLabel) dateLabel.textContent='Travel date';
  const ftChk=document.getElementById('flex-time-chk'); if(ftChk){ var ftl=ftChk.closest('.flex-chk'); if(ftl) ftl.style.display='none'; }
  // A shared seat is a specific departure, so "Decide later" can't work here. It used to stay
  // visible next to a banner inviting it, then silently disabled Continue with no explanation.
  const fdChk=document.getElementById('flex-date'); if(fdChk){ fdChk.checked=false; var fdl=fdChk.closest('.flex-chk'); if(fdl) fdl.style.display='none'; }
  state.flexDate=false;
  // The banner's default mark is flexi-time — a dashed rim, which in the line-icon family
  // means "not fixed yet". That is the opposite of what this copy says, so the shared-ride
  // branch swaps it for closes-soon: a solid-rimmed stopwatch, i.e. a scheduled departure.
  const fbIco=document.querySelector('.flex-banner svg');
  if(fbIco) fbIco.innerHTML='<circle cx="12" cy="13" r="7.5"/><path d="M12 9.5V13l2.6 1.8"/><path d="M9.5 3h5"/><path d="M17.5 5.5l1.5 1.5" stroke-dasharray="2 2.6"/><circle class="wp" cx="12" cy="13" r="1.3"/>';
  const fb=document.getElementById('flex-banner-tx'); if(fb) fb.innerHTML='<b>Shared seats run to a fixed timetable.</b> Pick the day you want and we\u2019ll reserve your seat on that van \u2014 if your dates are still open, a private transfer runs any day you like.';

  // STEP 3 — seats, not vehicle/luggage upgrades
  const tvPanel=document.querySelector('.panel[data-panel="3"]');
  if(tvPanel){
    var h3=tvPanel.querySelector('h2'); if(h3) h3.textContent='How many seats?';
    var sub3=tvPanel.querySelector('.sub'); if(sub3) sub3.textContent='Reserve a seat for each traveller. Every traveller gets one large bag free \u2014 extra bags are $10 each.';
  }

  // progress labels: this isn't a "pick-up & drop-off" or "travellers" journey
  // no adults/children split on a shared seat — every traveller is just a seat
  var chStepEl=document.getElementById('ch-step'); if(chStepEl) chStepEl.style.display='none';
  var adStepEl=document.getElementById('ad-step');
  if(adStepEl){ var adB=adStepEl.querySelector('b'); if(adB) adB.textContent='Travellers'; var adSub=adStepEl.querySelector('.muted'); if(adSub) adSub.textContent='One seat each'; }
  state.ch=0; state.bags=Math.max(1, state.ad);
  var bnEl=document.getElementById('bg-n'); if(bnEl) bnEl.textContent=state.bags;
  var setLbl=function(sn,txt){var el=document.querySelector('.pstep[data-s="'+sn+'"] .lbl'); if(el) el.textContent=txt;};
  setLbl(2,'Your ride'); setLbl(3,'Seats');
}

// document brand title
document.title='Book '+r.name+' — Ceylon Hop';

// ---- Calendar ----
const today=new Date();today.setHours(0,0,0,0);
const minBookDate=new Date(today);minBookDate.setDate(minBookDate.getDate()+1);
const maxBookDate=new Date(today.getFullYear(),today.getMonth()+12,today.getDate());
// A date arriving via the URL (?date= / ?start=, e.g. a stale search result or a shared/
// hand-edited link) must still satisfy the booking window. An unparseable, past, same-day,
// or too-far date is dropped here so the calendar step is SHOWN (not skipped, see the
// goStep(2) gate below) and the traveller must pick a valid one — the next-day rule can't
// be bypassed by pre-seeding state.date.
if(state.date && (isNaN(state.date.getTime()) || state.date<minBookDate || state.date>maxBookDate)) state.date=null;
let viewMonth = state.date ? new Date(state.date.getFullYear(),state.date.getMonth(),1) : (()=>{const d=new Date();return new Date(d.getFullYear(),d.getMonth(),1);})();
const MN=['January','February','March','April','May','June','July','August','September','October','November','December'];
function fmtISO(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }

function buildCal(){
  const y=viewMonth.getFullYear(), m=viewMonth.getMonth();
  const first=new Date(y,m,1).getDay();
  const days=new Date(y,m+1,0).getDate();
  const prevDisabled = new Date(y,m,1) <= new Date(minBookDate.getFullYear(),minBookDate.getMonth(),1);
  const nextMonth=new Date(y,m+1,1);
  const nextDisabled = new Date(nextMonth.getFullYear(),nextMonth.getMonth(),1) > new Date(maxBookDate.getFullYear(),maxBookDate.getMonth(),1);
  let html=`<div class="cal-head">
    <button ${prevDisabled?'disabled style=opacity:.3':''} onclick="calMove(-1)">‹</button>
    <b>${MN[m]} ${y}</b>
    <button ${nextDisabled?'disabled style=opacity:.3':''} onclick="calMove(1)">›</button></div>
    <div class="cal-grid">`;
  ['S','M','T','W','T','F','S'].forEach(d=>html+=`<div class="dow">${d}</div>`);
  for(let i=0;i<first;i++)html+='<div></div>';
  for(let d=1;d<=days;d++){
    const date=new Date(y,m,d);
    const dow=date.getDay();
    const off = date<minBookDate || date>maxBookDate;
    const noSvc = !!(sharedDays && !sharedDays.includes(dow)); // shared: not a service weekday
    const dis = off || noSvc;
    const sel = state.date && date.getTime()===state.date.getTime();
    const title = noSvc && !off ? ` title="Shared seats run ${sharedDaysLabel} only"` : '';
    // Real buttons, not divs: a calendar of clickable <div>s cannot be reached by keyboard at
    // all, and picking a date is the hard gate on the shared-ride flow.
    const label = date.toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
    const aria = noSvc && !off ? `${label} — no shared service` : label;
    html+=`<button type="button" class="cal-day ${off?'off':''} ${noSvc?'no-svc':''} ${sel?'sel':''}" data-dow="${dow}"${title} aria-label="${aria}"${sel?' aria-current="date"':''} ${dis?'disabled':`onclick="pickDate(${y},${m},${d})"`}>${d}</button>`;
  }
  html+='</div>';
  const cal=document.getElementById('cal');
  cal.dataset.minDate=fmtISO(minBookDate);
  cal.dataset.maxDate=fmtISO(maxBookDate);
  cal.innerHTML=html;
}
window.calMove=function(dir){viewMonth=new Date(viewMonth.getFullYear(),viewMonth.getMonth()+dir,1);buildCal();};

window.pickDate=function(y,m,d){
  const picked=new Date(y,m,d);
  if(picked<minBookDate || picked>maxBookDate) return;
  if(sharedDays && !sharedDays.includes(picked.getDay())) return; // not a shared service day
  state.date=picked; state.flexDate=false;
  const fd=document.getElementById('flex-date'); if(fd) fd.checked=false;
  document.getElementById('cal').classList.remove('dim');
  document.getElementById('flex-date-pill').classList.remove('show');
  buildCal(); renderDeps(); render(); checkWhen();
};
function fmtTime(t){const[h,mn]=t.split(':');const H=+h;return `${((H+11)%12)+1}:${mn} ${H<12?'am':'pm'}`;}

// build the time dropdown — private pickups run any hour of the day
function departuresFor(){
  if(perVehicle){
    const times = (window.hourlyTimes ? window.hourlyTimes() : ['06:00','07:00','08:00','09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00','18:00']);
    return times.map(t=>{ const h=+t.slice(0,2);
      const label = h<5?'Night pickup':(h<8?'Early start':(h<12?'Morning pickup':(h<17?'Afternoon pickup':(h<20?'Evening pickup':'Night pickup'))));
      return {time:t, label}; });
  }
  const base = (r.times&&r.times.length) ? r.times : (r.type==='shared' ? ['07:30'] : ['07:00','08:30','10:00']);
  return base.map((t,i)=>({time:t, label:i===0?'Morning hop':(i===1?'Midday hop':'Late hop')}));
}
function renderDeps(){
  const sel=document.getElementById('dep-select');
  const hint=document.getElementById('dep-hint');
  const deps=departuresFor();

  // Shared ride with a single fixed departure — show a read-only card, no picker needed
  if(isShared && deps.length===1){
    const dp=deps[0];
    sel.style.display='none';
    hint.style.display='block';
    hint.textContent='Reserve a seat on a scheduled departure.';
    let card=document.getElementById('single-dep-card');
    if(!card){
      card=document.createElement('div');
      card.id='single-dep-card';
      card.className='single-dep-card';
      sel.parentNode.insertBefore(card,sel);
    }
    card.textContent=fmtTime(dp.time)+' · '+dp.label;
    const ftWrap=document.getElementById('flex-time-chk');
    if(ftWrap){ const lbl=ftWrap.closest('.flex-chk'); if(lbl) lbl.style.display='none'; }
    return;
  }

  // remove single-dep card if switching away
  const old=document.getElementById('single-dep-card'); if(old) old.remove();
  sel.style.display='block';
  sel.disabled = state.flexTime;
  sel.style.opacity = state.flexTime ? '.45' : '1';
  hint.style.display='block';
  hint.textContent = perVehicle
    ? (state.flexTime ? 'No time locked in — we’ll confirm your pick-up time with you later.' : 'Choose any time of day — your private vehicle leaves when you do.')
    : (state.flexTime ? 'No time locked in — we’ll confirm your departure with you later.' : 'Reserve a seat on a scheduled departure.');
  let opts=`<option value="" ${!state.dep?'selected':''} disabled>Choose a ${perVehicle?'pick-up time':'departure'}…</option>`;
  opts+=deps.map(dp=>`<option value="${dp.time}" ${state.dep===dp.time?'selected':''}>${fmtTime(dp.time)} · ${dp.label}</option>`).join('');
  sel.innerHTML=opts;
}
window.pickDepSel=function(){
  const v=document.getElementById('dep-select').value;
  state.flexTime=false;
  const chk=document.getElementById('flex-time-chk'); if(chk) chk.checked=false;
  state.dep=v;
  render(); checkWhen();
};
// "decide later" for the time
window.toggleFlexTime=function(){
  state.flexTime=document.getElementById('flex-time-chk').checked;
  if(state.flexTime) state.dep=null;
  const pill=document.getElementById('flex-time-pill'); if(pill) pill.classList.toggle('show', state.flexTime);
  renderDeps(); render(); checkWhen();
};
// flexible date toggle
window.toggleFlexDate=function(){
  state.flexDate=document.getElementById('flex-date').checked;
  const cal=document.getElementById('cal');
  if(state.flexDate){
    state.date=null;
    cal.classList.add('dim');
    document.getElementById('flex-date-pill').classList.add('show');
    buildCal();
  } else {
    cal.classList.remove('dim');
    document.getElementById('flex-date-pill').classList.remove('show');
  }
  renderDeps(); render(); checkWhen();
};
// service chooser (trip mode)
window.pickSvc=function(svc){
  if(isTrip && svc==='chauffeur' && !tripDatesComplete()) return;
  if(svc===state.svc) return;                 // re-pressing the active option shouldn't animate
  state.svc=svc;
  document.querySelectorAll('.svc').forEach(b=>b.classList.toggle('on', b.dataset.svc===svc));
  state.payPlan = 'full';
  // Switching service rewrites the whole summary — different rows, different total, often a
  // different height. Doing that in one frame made the panel look like it was replaced rather
  // than re-priced, and shifted everything below it without warning. Travel between the two
  // heights instead; the figures inside are already counting (setNum).
  const card=document.querySelector('.summary .s-body') || document.querySelector('.summary');
  if(card && window.CH && CH.motion) CH.motion.resize(card, render, { duration:300 });
  else render();
};
function ensureRepriceEl(){
  let el=document.getElementById('reprice-note');
  if(!el){
    el=document.createElement('div'); el.id='reprice-note'; el.className='reprice-note';
    const wrap=document.getElementById('loc-wrap');
    if(wrap && wrap.parentNode) wrap.parentNode.insertBefore(el, wrap.nextSibling);
    else { const panel=document.querySelector('[data-panel="2"]'); if(panel) panel.appendChild(el); }
  }
  return el;
}
// The engine-raise notice (Task 3) can be triggered from any step — a traveller count change on
// the Travellers step, a re-picked spot on Where — unlike the local repriceDecision notice above,
// which only ever fires from the Where step's own map. It needs a home that's visible no matter
// which step is open, so it lives beside the running total in the persistent summary sidebar
// rather than beside loc-wrap.
// …which is true of the sidebar on a DESKTOP. On a phone that same sidebar is the collapsed
// bottom sheet (body.js-mbar, booking.html:594), so a notice parked in it renders ~500px below
// the fold behind visibility:hidden — and it holds the only control that releases the Continue
// gate. Owner-reported (2026-08-15): correct an out-of-area pick-up and Continue never comes
// back. So on a phone the notice lives with the step the customer is actually looking at, and
// because a raise can fire from ANY step it has to travel with the active panel (see goStep).
const phoneLayout = () => document.body.classList.contains('js-mbar')
  && window.matchMedia('(max-width:880px)').matches;
function engineNoteHome(){
  if(phoneLayout()){
    const panel=document.querySelector('.panel.active');
    // Above the step's own nav row, so it reads as the reason the CTA below it is waiting.
    if(panel) return { parent:panel, before:panel.querySelector('.nav-btns') };
  }
  const total=document.querySelector('#summary .s-total');
  if(total && total.parentNode) return { parent:total.parentNode, before:total.nextSibling };
  const summary=document.getElementById('summary');
  return summary ? { parent:summary, before:null } : null;
}
function ensureEngineRepriceEl(){
  let el=document.getElementById('engine-reprice-note');
  if(!el){ el=document.createElement('div'); el.id='engine-reprice-note'; el.className='reprice-note'; }
  const home=engineNoteHome();
  // Re-homed on every pass, not just on create: the step (and the viewport) can move under it.
  // Everything below is gated on the parent actually CHANGING, so an unchanged gate re-rendering
  // (which happens on nearly every keystroke) never yanks the page around.
  if(home && el.parentNode!==home.parent){
    home.parent.insertBefore(el, home.before||null);
    // In the phone layout the CTA this blocks is the sticky bar — always in view — while the
    // notice sits at the end of a long panel. Landing it in the flow isn't enough on its own:
    // bring it to them, or the dead button still has no visible reason beside it.
    if(phoneLayout()) el.scrollIntoView({ block:'center' });
  }
  return el;
}
function renderRepriceNote(){
  const far=state.locTooFar;
  // A spot outside its area is a hard stop — it takes over the notice and blocks Continue.
  if(far){
    const el=ensureRepriceEl(); el.className='reprice-note reprice-block';
    const spot=far.which==='from'?'pick-up':'drop-off';
    el.innerHTML =
      '<b>That’s outside your '+spot+' area.</b> '+
      '“'+acEsc(far.name)+'” is about '+far.km+' km from '+acEsc(far.area)+', but an exact '+spot+
      ' needs to be within '+far.limit+' km. To travel a different route, change your search on the home page.'+
      '<div class="rn-actions">'+
        '<button type="button" class="btn btn-primary btn-sm" onclick="clearExactSpot(\''+far.which+'\')">Clear this spot</button>'+
        `<a class="rn-change" href="${backToSearchUrl()}">Change your search</a>`+
      '</div>';
    return;
  }
  const p=state.pendingReprice;
  // Only one of the two notices is ever relevant at a time (the onRoute handler that sets the
  // local shape is itself gated off once CH_PRICING is available — see renderRouteMap), but
  // clean up whichever one is stale so an old notice can never linger under the other's id.
  const localEl=document.getElementById('reprice-note');
  const engineEl=document.getElementById('engine-reprice-note');
  if(!p || p.engineRaise){ if(localEl) localEl.remove(); }
  if(!p || !p.engineRaise){ if(engineEl) engineEl.remove(); }
  if(!p) return;
  if(p.engineRaise){
    const eEl=ensureEngineRepriceEl();
    const toAmt=money(p.toCents/100), fromAmt=money(p.fromCents/100);
    eEl.innerHTML =
      '<b>Your price has been updated.</b> '+
      'Based on your latest details, your total is now '+toAmt+' (it was '+fromAmt+').'+
      '<div class="rn-actions">'+
        '<button type="button" class="btn btn-primary btn-sm" onclick="acceptReprice()">Got it — use '+toAmt+'</button>'+
      '</div>';
    return;
  }
  const newPrice = p.prices[vehicleKey];
  const shownCurrentPrice = window.TRANSFERS.finishPrice(unit);
  const shownNewPrice = window.TRANSFERS.finishPrice(newPrice);
  const el=ensureRepriceEl(); el.className='reprice-note';
  el.innerHTML =
    '<b>Heads up — this trip is longer than the standard route.</b> '+
    'Your exact stops add about '+p.extraKm+' km, so the fixed price updates from '+
    money(shownCurrentPrice)+' to '+money(shownNewPrice)+'.'+
    '<div class="rn-actions">'+
      '<button type="button" class="btn btn-primary btn-sm" onclick="acceptReprice()">Got it — use '+money(shownNewPrice)+'</button>'+
      '<button type="button" class="rn-change" onclick="dismissReprice()">Change location</button>'+
    '</div>';
}
window.acceptReprice=function(){
  const p=state.pendingReprice; if(!p) return;
  if(p.engineRaise){
    adoptEngineEstimate(p.est, p.sig);
    state.pendingReprice=null;
    if(typeof window.chTrack==='function') window.chTrack('reprice_accepted',{extra_km:null,new_value:calcTotal()});
    render(); checkWhere();
    return;
  }
  vehPrices=p.prices; unit=p.prices[vehicleKey]; r.price=unit;
  state.anchorKm=p.km; state.pendingReprice=null;
  if(typeof window.chTrack==='function') window.chTrack('reprice_accepted',{extra_km:p.extraKm,new_value:calcTotal()});
  render(); checkWhere();
};
window.dismissReprice=function(){
  state.pendingReprice=null; render(); checkWhere();
  const to=document.getElementById('loc-to'); if(to) to.focus();
};
// one-time styles (site.css is frozen — keep this self-contained)
(function injectRepriceCss(){
  if(document.getElementById('reprice-css')) return;
  const s=document.createElement('style'); s.id='reprice-css';
  s.textContent='.reprice-note{margin:.75rem 0 0;padding:.85rem 1rem;border:1px solid #f0c07a;'+
    'background:#fff7ea;border-radius:12px;font-size:.9rem;line-height:1.4;color:#5c4a2a}'+
    '.reprice-note b{color:#8a5a12}'+
    '.reprice-note .rn-actions{display:flex;gap:.75rem;align-items:center;margin-top:.6rem;flex-wrap:wrap}'+
    '.reprice-note .rn-change{background:none;border:0;color:#8a5a12;text-decoration:underline;cursor:pointer;font:inherit;padding:0}'+
    '.reprice-note.reprice-block{border-color:#e0a091;background:#fcece7;color:#7a3320}'+
    '.reprice-note.reprice-block b{color:#b23214}'+
    '.reprice-note.reprice-block .rn-change{color:#b23214}';
  document.head.appendChild(s);
})();
function checkWhere(){
  const haveWhere = isTrip ? true : (state.locFrom && state.locTo);
  document.getElementById('n1').disabled = !haveWhere || !!state.pendingReprice || !!state.locTooFar;
}
// For shared rides a date is required before continuing — there's only one
// departure per day so we need to know which day. Private transfers can
// proceed without a date (confirmed later on WhatsApp).
function checkWhen(){
  const n2=document.getElementById('n2');
  if(!n2) return;
  if(isShared){
    // Shared seats depart at fixed times — a concrete date AND departure are both required,
    // else the backend (which requires `time`) 400s at the moment of payment.
    const ok = !!(state.date && !state.flexDate && state.dep);
    n2.disabled = !ok;
    // Never leave a greyed-out button with no reason next to it.
    var why=document.getElementById('when-blocked');
    if(!why){
      why=document.createElement('p'); why.id='when-blocked'; why.className='when-blocked'; why.setAttribute('role','status');
      n2.parentNode.insertBefore(why, n2);
    }
    why.textContent = ok ? '' : (!state.date ? 'Pick a travel date above \u2014 shared seats need a set departure day.' : 'Choose a departure time to continue.');
    why.style.display = ok ? 'none' : '';
  } else {
    n2.disabled = false;
  }
}
document.getElementById('n1').addEventListener('click',()=>goStep(isTrip?4:3));

// ---- steppers ----
window.step=function(which,d){
  if(which==='ad')state.ad=Math.max(1,state.ad+d);
  else if(which==='ch')state.ch=Math.max(0,state.ch+d);
  else if(which==='bg'){const bm=isShared?(Math.max(1,state.ad+state.ch)+5):ABS_MAX_BAGS;state.bags=Math.max(0,Math.min(bm,state.bags+d));}
  document.getElementById('ad-n').textContent=state.ad;
  document.getElementById('ch-n').textContent=state.ch;
  document.getElementById('bg-n').textContent=state.bags;
  render();
};
window.toggleAddon=function(el){
  const a=el.dataset.addon;
  if(state.addons.has(a)){state.addons.delete(a);el.classList.remove('on');}
  else{state.addons.add(a);el.classList.add('on');}
  render();
};
// Add-on prices come from the generated EXTRAS table (transfers-data.js, sourced from
// api/src/quote/rateCard.ts) so they can never drift from the backend. The flow only offers
// the keys in addonNames; EXTRAS carrying additional codes (safari-wait, waiting) is harmless.
const addonPrices=(window.TRANSFERS && window.TRANSFERS.EXTRAS) || {};
const addonNames={sightseeing:'Sightseeing stops (3h)',luggage:'Luggage rack',front:'Child seat',flex:'Flexi ticket'};

// The wallet chips were decorative - selecting Apple/Google Pay changed nothing and the customer
// still landed in a card form. The row is now a plain statement of what actually happens.
window.setPayPlan=function(plan){ state.payPlan=plan; document.querySelectorAll('.pc-opt').forEach(o=>o.classList.toggle('on',o.dataset.plan===plan)); render();
  if(typeof window.chTrack==='function') window.chTrack('add_payment_info',{payment_type:plan,currency:'USD',value:calcTotal()}); };

// Longest known dial code (digits only) that prefixes `digits`, or '' if none.
function matchDialCode(digits){
  let best='';
  for(const c of PHONE_COUNTRIES){
    const d=(c[2]||'').replace(/[^\d]/g,'');
    if(d && digits.indexOf(d)===0 && d.length>best.length) best=d;
  }
  return best;
}
// Split the phone field into { code, number, whatsapp } so the three always agree
// (code + number === whatsapp). Two inputs used to corrupt it:
//   (a) a "+"-prefixed international number kept the SELECTOR's dial code — now the split is
//       derived from the typed number itself, so the columns never disagree with whatsapp.
//   (b) a number typed WITH the country code but no "+" doubled it — now the leading dial code
//       is stripped before re-prefixing.
function phoneParts(){
  const countryEl=document.getElementById('f-country');
  const phoneEl=document.getElementById('f-phone');
  const country=(countryEl&&countryEl.value?countryEl.value:'Sri Lanka').trim();
  const match=PHONE_COUNTRIES.find(([,name])=>name===country);
  const selCode=match ? match[2] : '+94';
  const selDigits=selCode.replace(/[^\d]/g,'');
  const raw=(phoneEl&&phoneEl.value?phoneEl.value:'').trim();
  const hasIntl=/^\s*\+/.test(raw);
  const digits=raw.replace(/[^\d]/g,'');
  if(hasIntl){
    const dc=matchDialCode(digits);
    return { code: dc ? '+'+dc : '', number: dc ? digits.slice(dc.length) : digits, whatsapp: '+'+digits };
  }
  let number=digits.replace(/^0+/,'');
  if(selDigits && number.indexOf(selDigits)===0 && number.length>selDigits.length){
    number=number.slice(selDigits.length); // operator typed the code too — don't double it
  }
  return { code: selCode, number, whatsapp: selCode + number };
}

// chauffeur-guide fee helpers
// the whole trip fits in one day when there are no overnight stays and every dated leg is the same day
function isSingleDayTrip(){
  const nights = tripNights.reduce((a,b)=>a+(parseInt(b)||0),0);
  if(nights>0) return false;
  const wires = Math.max(0, tripStops.length-1);
  const ds=[]; for(let i=0;i<wires;i++){ const d=(tripDates[i]||'').trim(); if(d) ds.push(d); }
  if(wires>0 && ds.length===wires) return new Set(ds).size<=1;
  return false;
}
// a multi-stop trip is fully dated when every leg (stop-to-stop) carries a travel date
function tripDatesComplete(){
  if(!isTrip || tripStops.length<2) return false;
  const wires = Math.max(0, tripStops.length-1);
  for(let i=0;i<wires;i++){
    if(!(tripDates[i]||'').trim()) return false;
  }
  return true;
}
// Chauffeur duration from the trip dates: nights on the road = (last date − first date),
// days the car is kept = nights + 1. Driver accommodation = one night per night away.
function chauffeurDuration(){
  const dated=tripDates.filter(d=>(d||'').trim());
  if(!dated.length) return { days:0, nights:0 };
  const a=new Date(dated[0]+'T00:00:00'), b=new Date(dated[dated.length-1]+'T00:00:00');
  if(isNaN(a)||isNaN(b)||b<a) return { days:0, nights:0 };
  const nights=Math.round((b-a)/86400000);
  return { days:nights+1, nights };
}
// the calendar days the car & driver-guide is retained (chauffeur is billed per day)
function chauffeurDayList(){
  const startISO = (tripDates.find(d=>(d||'').trim()) || startParam || '');
  const base = startISO ? new Date(startISO+'T00:00:00') : null;
  const n=Math.max(1,tripDays), days=[];
  for(let i=0;i<n;i++){
    const d = base ? new Date(base.getFullYear(),base.getMonth(),base.getDate()+i) : null;
    days.push({ n:i+1, label: d&&!isNaN(d) ? d.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'}) : ('Day '+(i+1)) });
  }
  return days;
}
// chauffeur is only priced once the trip is fully dated (we charge per day)
function chauffeurFee(){ return (isTrip && state.svc==='chauffeur' && tripDatesComplete()) ? (window.TRANSFERS.CHAUFFEUR_DAY_FEE * Math.max(1,tripDays)) : 0; }
// GL-4 (owner decision 2026-07-02): chauffeur distance is billed from the sum of buffered
// travel legs plus a minimum km for every idle (no-travel) day — at the per-km rate, with
// NO per-leg minimum fares. Mirrors api/src/quote/chauffeur.ts.
function chauffeurDistanceCharge(){
  const T = window.TRANSFERS;
  const days = Math.max(1, tripDays);
  const idleDays = Math.max(0, days - Math.max(0, tripStops.length-1));
  const idleKm = idleDays * (T.CHAUFFEUR_IDLE_MIN_KM[vehicleKey] ?? T.CHAUFFEUR_IDLE_MIN_KM.car); // per-vehicle idle-day min km (generated from rateCard.ts)
  const q = tripQuoteWithKms(vehicleKey);
  const bufferedTravelKm = (q.legs || []).reduce((sum, leg) => sum + (leg.km!=null ? T.billableKm(leg.km) : 0), 0);
  if(bufferedTravelKm<=0 && idleKm<=0) return Math.max(0, tripBase || unit || 0);
  const bulkKm = bufferedTravelKm + idleKm;
  // Bulk km × per-km rate, with NO per-leg minimum-fare floor — the backend engine
  // (api/src/quote/chauffeur.ts) has no such floor, so flooring at the private per-leg total
  // (tripBase) over-quoted short-leg chauffeur trips and made the price drop at the pay step.
  return T.distancePrice(bulkKm, vehicleKey);
}
function daysUntilStart(){ if(!state.date) return 999; return Math.round((state.date - new Date())/86400000); }
// Server-authoritative price. Until the booking is created the wizard shows a best-effort
// estimate (priced off the browser's measured distance); the API reprices from its own
// server-side Distance Matrix, so the two can drift by a few percent. Once /bookings/* returns,
// we adopt its amounts (minor units → USD) so the pay overlay, PayHere and the confirmation pass
// all show EXACTLY what is charged — the customer is never billed a number they weren't shown.
let serverQuote = null; // { total, dueNow } in USD, or null before the booking exists
function adoptServerQuote(b){
  if(!b) return;
  const t = typeof b.total === 'number' ? b.total/100 : null;
  const d = typeof b.amountDueNow === 'number' ? b.amountDueNow/100 : t;
  if(t==null && d==null) return;
  serverQuote = { total: t!=null?t:d, dueNow: d!=null?d:t };
}

function isDeposit(){
  return false;
}

// Estimate-adoption slot (Phase 3 — mirrors adoptServerQuote just above): the local formula
// stays the instant first paint and the no-backend fallback, but once a live estimate from
// POST /quote/v2/estimate lands for the CURRENT itinerary, calcTotal() prefers it. Unlike
// serverQuote (set once, after the booking exists, and never re-computed), engineEst tracks the
// intent it was priced against — a figure for an itinerary the customer has since changed must
// never win, so calcTotal() only trusts it while the signature still matches. No fetch wiring
// yet (Task 3): this task only builds the intent and the adoption slot calcTotal() reads from.
let engineEst = null;        // { totalCents, amountDueNowCents, estimated, legs, intentSig } | null
let estimatePending = false; // true while an estimate fetch for the current intent is in flight (Task 3 gates payment on this)

// The itinerary as the pricing engine sees it: place-name legs only — never a client-measured
// distance (Global Constraints: the intent carries names, distances come back on the response) —
// so a routing change on the API side is never shadowed by a stale km the browser had on hand.
// null means "nothing to price": shared seats run their own fixed-schedule local formula
// (Global Constraints) and never call the estimate endpoint.
function buildEstimateIntent(){
  if(isShared) return null;
  const vehicle = (vehicleKey==='van') ? 'van' : 'car';
  const pax = state.ad + state.ch;
  const bags = state.bags;
  const extras = Array.from(state.addons);
  if(isTrip){
    if(state.svc==='chauffeur'){
      // Chauffeur trips are billed by the calendar span the car is kept, not per leg (see
      // chauffeurFee/chauffeurDistanceCharge below) — so the intent carries the span
      // (firstDate/lastDate) plus the dated travel days, the same tripDates array the trip
      // payload derives its own day count from (createApiBooking, :1765-1777). A gap wire is
      // the traveller's own arrangement and never enters a priced itinerary (tripQuoteWithKms, :110).
      const dated = tripDates.filter(d=>(d||'').trim());
      const firstDate = dated.length ? dated[0] : undefined;
      const lastDate = dated.length ? dated[dated.length-1] : undefined;
      const travelDays = [];
      for(let i=0;i<tripStops.length-1;i++){
        if(tripGaps.has(i)) continue;
        const date = (tripDates[i]||'').trim();
        if(!date) continue; // an undated wire has no day to attach to the estimate
        travelDays.push({ date, from: tripStops[i], to: tripStops[i+1] });
      }
      return { product:'chauffeur', vehicle, pax, bags, firstDate, lastDate, travelDays, extras };
    }
    // Trip + private: one leg per non-gap wire (mirrors tripQuoteWithKms, :110).
    const legs = [];
    for(let i=0;i<tripStops.length-1;i++){
      if(tripGaps.has(i)) continue;
      legs.push({ from: tripStops[i], to: tripStops[i+1] });
    }
    return { product:'private', vehicle, pax, bags, legs, extras };
  }
  // Single transfer: the same place strings the booking payload sends (createApiBooking,
  // :1808-1809) — including the exact-spot-refined string once the customer has pinned one.
  const legs = [{ from: state.locFrom || r.stops[0], to: state.locTo || r.stops[r.stops.length-1] }];
  const date = (state.flexDate || !state.date) ? undefined : fmtISO(state.date);
  const time = (state.flexTime || !state.dep) ? undefined : state.dep;
  return { product:'private', vehicle, pax, bags, legs, extras, date, time };
}
// A stable key for "is this the itinerary engineEst was priced against". Cheap to recompute (a
// handful of strings/numbers) so, unlike the real debounce ch-pricing.js owns (Task 1), this is
// called fresh rather than cached across state mutations — that keeps calcTotal() honest the
// instant a pax/vehicle/route change lands, ahead of the next re-estimate.
function intentSig(intent){ return JSON.stringify(intent); }
function currentIntentSig(){ return intentSig(buildEstimateIntent()); }
function routeInputSig(intent){
  if(!intent) return 'none';
  const legs=Array.isArray(intent.legs) ? intent.legs.map(l=>({from:l.from,to:l.to}))
    : Array.isArray(intent.travelDays) ? intent.travelDays.map(l=>({from:l.from,to:l.to})) : [];
  return JSON.stringify({product:intent.product,legs});
}
function currentRouteInputSig(){ return routeInputSig(buildEstimateIntent()); }
function routeFingerprint(value){
  let hash=2166136261;
  for(const ch of String(value||'')){ hash^=ch.charCodeAt(0); hash=Math.imul(hash,16777619); }
  return `r${(hash>>>0).toString(36)}`;
}
// Called once a live estimate settles (Task 3 wires the fetch); sig is the intent signature it
// was requested for, so an out-of-order or now-stale response can never silently override the total.
function adoptEngineEstimate(est, sig){
  if(!est) return;
  engineEst = {
    totalCents: est.totalCents,
    amountDueNowCents: est.amountDueNowCents,
    estimated: est.estimated,
    legs: est.legs,
    intentSig: sig
  };
}

// engineEst that is actually priced against the itinerary as it stands RIGHT NOW — the same
// guard calcTotal() applies, exposed so render()/the pay gate don't each re-derive it.
function currentEngineEst(){
  return (engineEst && engineEst.intentSig===currentIntentSig()) ? engineEst : null;
}

function announceRouteEstimate(text){
  if(!text || text===lastRouteAnnouncement) return;
  lastRouteAnnouncement=text;
  const live=document.getElementById('route-estimate-status');
  if(live) live.textContent=text;
}
function adoptCustomerRouteEstimate(est, sig){
  if(!hasExactRouteInputs() || sig!==currentIntentSig()) return;
  const leg=est && Array.isArray(est.legs) ? est.legs.find(l=>l && (l.distanceKm>0 || l.durationMin>0)) : null;
  if(!leg){
    routeEstimateUnavailable=true;
    announceRouteEstimate(window.CH && CH.routeEstimate
      ? CH.routeEstimate.formatRouteEstimate({state:'unavailable'})
      : 'We’ll confirm the journey time after reviewing your locations.');
    return;
  }
  const next={distanceKm:leg.distanceKm,durationMin:leg.durationMin};
  const material=!!(window.CH && CH.routeEstimate && CH.routeEstimate.isMaterialRouteChange(activeRouteEstimate,next));
  activeRouteEstimate={
    distanceKm:next.distanceKm,
    durationMin:next.durationMin,
    state:est.estimated===true?'estimated':(material?'exact':'browse'),
    estimateId:'engine-v2',
    routeSig:routeInputSig(buildEstimateIntent())
  };
  routeEstimateUnavailable=false;
  if(material){
    const text=CH.routeEstimate.formatRouteEstimate(activeRouteEstimate);
    announceRouteEstimate(text);
    if(typeof window.chTrack==='function') window.chTrack('route_estimate_update',{
      surface:'booking',estimate_state:activeRouteEstimate.state,material:true,
      route_fingerprint:routeFingerprint(activeRouteEstimate.routeSig)
    });
  }
}

// True while a fresh estimate is on its way for an itinerary the figure we hold no longer
// prices — a service switch, a vehicle switch, a pax change, a re-pinned exact spot.
//
// NOT estimatePending on its own. On a COLD start there is no engine figure yet, and the local
// formula is the deliberate instant first paint as well as the entire flag-off/offline world
// (:1209-1215) — there is nothing being *re*-priced and nothing to withhold. This is only ever
// about the window between "the price you can see is out of date" and "the new one has landed".
function repricing(){ return estimatePending && !!engineEst && !currentEngineEst(); }
// What the total reads while that window is open. Deliberately carries no digits: setNum's
// tween declines on a shape change (site.js's tweenNumber bails when one side has no number),
// so the figure swaps out and back cleanly instead of counting through values on the way.
const PRICING_LABEL = 'Calculating…';

// Task 5: the rate-lock request (createApiBooking's `lockReq`, sent to POST /quote/lock) used to
// seed every leg's distanceKm from TRANSFERS.kmBetween, a static client-side table. A live engine
// estimate already carries a real measured distanceKm per leg (Global Constraints: the estimate
// RESPONSE, never a client distance, is what feeds the lock) — prefer that when there is a fresh
// one for THIS leg, matched by from/to. A stale or absent estimate (flag off, or the estimate
// hasn't caught up with the current itinerary) falls back to kmBetween exactly as before the
// engine existed, so the flag-off world stays byte-identical to today.
function lockLegKm(from, to){
  const est = currentEngineEst();
  if(est && Array.isArray(est.legs)){
    const match = est.legs.find(function(l){ return l && l.from===from && l.to===to; });
    if(match && typeof match.distanceKm === 'number') return match.distanceKm;
  }
  return (window.TRANSFERS && window.TRANSFERS.kmBetween) ? (window.TRANSFERS.kmBetween(from, to) || 0) : 0;
}

// ---- fetch wiring (Task 3) ----
// The sig we last ASKED CH_PRICING about. render() runs on nearly every mutation in this file
// (every stepper click, every keystroke that touches state), so without this guard we'd fire a
// fresh CH_PRICING.estimate() call every single repaint even when nothing pricing-relevant
// changed — ch-pricing.js's own 400ms debounce absorbs bursts of calls for the SAME intent, but
// it can't know two calls in a row are for the same intent unless we only call it when the
// intent actually moved.
let lastRequestedSig = null;
function requestEstimate(){
  if(!window.CH_PRICING || isShared) return; // shared seats price locally only (Global Constraints)
  const intent = buildEstimateIntent();
  if(!intent) return; // null = nothing priceable yet
  const sig = intentSig(intent);
  if(sig === lastRequestedSig) return;
  lastRequestedSig = sig;
  estimatePending = true;
  if(hasExactRouteInputs()) routeEstimateUnavailable=false;
  window.CH_PRICING.estimate(intent, {
    onResult: function(est){ estimatePending = false; handleEngineEstimate(est, sig); },
    // Flag off, a network hiccup, or a timeout — the local formula is already what's on
    // screen (engineEst is only ever touched by a successful onResult), so there's nothing to
    // repaint about the TOTAL; we still re-render so the pending-gate on Pay/#n1 releases.
    onUnavailable: function(reason){
      estimatePending = false;
      if(sig===currentIntentSig() && hasExactRouteInputs()){
        routeEstimateUnavailable=true;
        const text=window.CH && CH.routeEstimate
          ? CH.routeEstimate.formatRouteEstimate({state:'unavailable'})
          : 'We’ll confirm the journey time after reviewing your locations.';
        announceRouteEstimate(text);
        if(typeof window.chTrack==='function') window.chTrack('route_estimate_unavailable',{
          surface:'booking',reason:reason||'unknown',
          route_fingerprint:routeFingerprint(currentRouteInputSig())
        });
      }
      render();
    }
  });
}

// True when the only thing that moved between two priced intents is the product or the vehicle —
// i.e. the customer pressed "Chauffeur-guide" or "Switch to AC van". A raise they DROVE that way
// is not a surprise to acknowledge: the press is the acknowledgement, and both the service
// chooser and the upsell CTA name their price before it happens. Gating these announced "your
// price has been updated" about the very change just asked for, and held the summary at the
// figure for the service they'd just left — invisible on a trip, where private and chauffeur
// carry identically labelled rows (:1546-1551), so the card read as the old price for the new
// service with nothing on screen to tell them apart.
function switchedProductOrVehicle(sig, priorSig){
  let now, prior;
  try { now = JSON.parse(sig); prior = JSON.parse(priorSig); } catch(e){ return false; }
  if(!now || !prior) return false;
  return now.product !== prior.product || now.vehicle !== prior.vehicle;
}
// Settles a live estimate for `sig`. A raise over whatever engine total was already on screen
// must never apply silently (Global Constraints) — it's parked behind the same acknowledge gate
// renderRepriceNote already runs for the local repriceDecision path; a same-or-lower figure is
// exactly what the customer would expect a live quote to look like, so it lands immediately.
// The one raise that skips the gate is the one the customer chose outright — see above.
function handleEngineEstimate(est, sig){
  // The customer may have moved on to a different itinerary while this was in flight (their next
  // render() already re-requested for it — see requestEstimate's sig guard) — a response for a
  // sig that's no longer current is stale and must not touch what's on screen.
  if(sig !== currentIntentSig()){ render(); return; }
  adoptCustomerRouteEstimate(est,sig);
  const priorCents = engineEst ? engineEst.totalCents : null;
  if(priorCents!=null && est.totalCents > priorCents && !switchedProductOrVehicle(sig, engineEst.intentSig)){
    state.pendingReprice = { engineRaise:true, fromCents:priorCents, toCents:est.totalCents, est:est, sig:sig };
    render();
    checkWhere();
    return;
  }
  adoptEngineEstimate(est, sig);
  state.pendingReprice = null; // a fresh figure supersedes any stale reprice notice too
  render();
  checkWhere();
}

// ---- totals + render ----
function calcTotal(){
  if(serverQuote) return serverQuote.total;
  // An engine raise awaiting acknowledgement HOLDS at the figure the customer was last shown —
  // the same "never move the number until they say so" rule the local repriceDecision notice
  // enforces. Without this, the moment the intent sig moves past what engineEst was adopted for
  // (which is exactly what triggers a raise in the first place — see handleEngineEstimate), the
  // very next check below would fall straight past the stale engineEst to the LOCAL FORMULA —
  // an unrelated third figure the customer was never shown at all.
  if(state.pendingReprice && state.pendingReprice.engineRaise) return state.pendingReprice.fromCents/100;
  // A live engine estimate outranks the local formula, but only while it was priced against
  // the itinerary as it stands right now — a stale figure for a changed trip must never show.
  if(engineEst && engineEst.intentSig===currentIntentSig()) return engineEst.totalCents/100;
  // Mid-re-estimate, everything DERIVED from the total (Due now, the deposit) stands at the
  // figure the customer was last quoted rather than dropping to the local formula. That formula
  // is the offline fallback for when the engine is gone — not a price anyone was shown — and on
  // a trip it prices the browser's static km table instead of the engine's measured distances,
  // so falling to it made the summary count DOWN to a number we would not honour and back up
  // ~1.2s later. The summary total itself prints PRICING_LABEL rather than this held figure
  // (render(), :1610) — it is the one number the customer is actually watching. Once the
  // estimate fails outright, repricing() goes false and the fallback correctly takes over: at
  // that point the engine really is gone, and holding would strand a price for an itinerary
  // they no longer have.
  if(repricing()) return engineEst.totalCents/100;
  // chauffeur-guide trips use the engine's bulk model: day rate × days + ONE distance
  // charge across the whole trip — not the per-leg fares (which carry minimum floors)
  let t = (isTrip && state.svc==='chauffeur')
    ? chauffeurFee() + chauffeurDistanceCharge()
    : (perVehicle ? unit : (unit*state.ad + unit*0.6*state.ch));
  if(isShared){ const free=Math.max(1,state.ad+state.ch); t += Math.max(0,state.bags-free)*10; }
  state.addons.forEach(a=>t+=addonPrices[a]);
  if(isShared) return t;
  const privateFloor = (isTrip && state.svc!=='chauffeur')
    ? tripLegs.filter(l=>!l.gap).length * window.TRANSFERS.FLOORS[vehicleKey]
    : (!isTrip && perVehicle ? window.TRANSFERS.FLOORS[vehicleKey] : 0);
  return window.TRANSFERS.finishPrice(t, privateFloor);
}
// Deposit %/cap come from the generated rate-card block (transfers-data.js, sourced from
// api/src/quote/rateCard.ts) — no hardcoded fallback copy that could drift from the backend.
const DEPOSIT_PCT = window.TRANSFERS.DEPOSIT_PCT;
const DEPOSIT_CAP = window.TRANSFERS.DEPOSIT_CAP; // USD
function depositDue(){ return Math.min(Math.round(calcTotal()*DEPOSIT_PCT), DEPOSIT_CAP); }
function amountDueNow(){ if(serverQuote) return serverQuote.dueNow; return calcTotal(); }
function money(n){return '$'+ (Math.round(n*100)/100).toFixed(2).replace(/\.00$/,'');}

/* WhatsApp CTAs on this page opened an EMPTY chat, so an enquiry landed in the inbox with no
   idea what the customer had been looking at — ops had to ask the route, the date and the
   party size back before they could say anything useful. quote.html has prefilled its CTAs
   since 2026-08-07 (waHref, quote.html:91) and search.js does the same for its route cards;
   booking.html's two were the ones still bare.

   Built entirely from what is already on screen. WhatsApp shows the customer the draft before
   they send it, so nothing here is hidden from them and nothing leaves the page unless they
   press send. Deliberately no name, phone or email — the message is about the TRIP; their
   identity comes with the WhatsApp account itself.

   Every field falls back rather than throwing: this runs on every render, including before a
   date is picked or a price exists, and a broken href is worse than a vaguer message. */
function waTripSummary(){
  const stops = (isTrip && Array.isArray(tripStops) && tripStops.length) ? tripStops
    : [state.locFrom || (r && r.stops ? r.stops[0] : ''), state.locTo || (r && r.stops ? r.stops[r.stops.length-1] : '')];
  const route = stops.filter(Boolean).join(' → ');
  const when = state.flexDate ? 'Date to confirm'
    : (state.date ? state.date.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',year:'numeric'}) : 'Date to confirm');
  const pax = state.ad + state.ch;
  const veh = (vehicleKey === 'van') ? 'AC van' : 'AC car';
  const svc = isShared ? 'Shared seat' : (isTrip && state.svc === 'chauffeur' ? 'Chauffeur-guide' : 'Private transfer');
  let priced = '';
  try { const t = calcTotal(); if (t > 0) priced = '\nQuoted ' + money(t); } catch (e) {}
  return 'Hi Ceylon Hop — I’d like to ask about this trip:\n'
    + (route ? route + '\n' : '')
    + when + ' · ' + pax + ' traveller' + (pax === 1 ? '' : 's') + ' · ' + veh + ' · ' + svc
    + priced;
}
function waHrefFor(text){ return 'https://wa.me/94779669662?text=' + encodeURIComponent(text); }
function updateWaLinks(){
  const s = document.getElementById('s-wa');
  if (s) s.href = waHrefFor(waTripSummary());
}

// price of an AC van for this journey (single transfer or whole trip)
function vanPrice(){
  if(isTrip) return tripQuoteWithKms('van').total;
  if(vehPrices) return vehPrices.van;
  return null;
}
// price of an AC car for this journey (single transfer or whole trip)
function carPrice(){
  if(isTrip) return tripQuoteWithKms('car').total;
  if(vehPrices) return vehPrices.car;
  return null;
}
// upgrade car → van when the party is over a car's capacity, and re-price
window.switchToVan=function(){
  vehicleKey='van'; vehicleLabel='AC van (up to 6)';
  vehPax=VEH_CAP.van.pax; maxBags=VEH_CAP.van.bags;
  const vp=vanPrice(); if(vp!=null){ unit=vp; if(isTrip) tripBase=vp; }
  render();
};
// downgrade van → car when the party fits a car again, and re-price (saves money)
window.switchToCar=function(){
  vehicleKey='car'; vehicleLabel='AC car (up to 3)';
  vehPax=VEH_CAP.car.pax; maxBags=VEH_CAP.car.bags;
  const cp=carPrice(); if(cp!=null){ unit=cp; if(isTrip) tripBase=cp; }
  render();
};
// free-cancellation window depends on the service type
function cancelText(){
  return (isTrip && state.svc==='chauffeur')
    ? 'Free cancellation up to 10 days before'
    : 'Free cancellation up to 24 hours before';
}
/* The summary figures change on almost every interaction in this flow — a traveller added, a
   bag, an extra, a switch between private and shared — and each change rewrote the number
   outright. On a RUNNING TOTAL that loses the only thing the customer is watching for: whether
   what they just did made it go up or down. Counting from whatever is already on screen makes
   the direction of travel visible without adding a word of copy.

   CH.motion.tweenNumber declines on its own when counting would be wrong: mismatched number
   shapes ("—" → "$139"), no actual change, reduced motion, or a hidden tab. It also carries a
   timer that writes the true value even if not one animation frame runs, so a stalled count can
   never strand an out-of-date PRICE in front of someone about to pay. */
function setNum(el, next){
  if(!el) return;
  if(window.CH && CH.motion) CH.motion.tweenNumber(el, el.textContent, next);
  else el.textContent = next;
}
// A Google-picked place arrives as its full formatted address ("… (CMB), Airport and Aviation
// Services (Sri Lanka) (Private) Limited, Canada Friendship Rd, Katunayake, Sri Lanka"), and the
// summary panel printed every segment of it — five wrapped lines in the teal route box, five more
// in the serif <h3>. CH.shortPlace is the SAME shortener ops, the pay page, the emails and plan.js
// use (ch-shortplace.js is compiled from api/src/quote/shortPlace.ts), so the customer sees the
// label everyone else already sees for that place.
//
// DISPLAY ONLY. state.locFrom/locTo keep the full string, so re-pricing, the routed-distance
// lookup, the out-of-area guard and what we submit in the booking are all unchanged.
function shortPlaceLabel(place){
  return (window.CH && CH.shortPlace) ? CH.shortPlace(place) : place;
}
function customerRouteEstimateText(){
  if(isTrip) return '';
  if(hasExactRouteInputs()){
    if(routeEstimateUnavailable){
      return window.CH && CH.routeEstimate
        ? CH.routeEstimate.formatRouteEstimate({state:'unavailable'})
        : 'We’ll confirm the journey time after reviewing your locations.';
    }
    const routeChanged=activeRouteEstimate.routeSig!==currentRouteInputSig();
    if(estimatePending && routeChanged) return 'Updating journey estimate…';
  }
  return window.CH && CH.routeEstimate
    ? CH.routeEstimate.formatRouteEstimate(activeRouteEstimate)
    : '';
}
function paintCustomerRouteEstimate(){
  const text=customerRouteEstimateText();
  const summary=document.getElementById('sum-route-estimate');
  if(summary){ summary.textContent=text; summary.hidden=!text; }
  const bar=document.getElementById('rm-bar');
  if(!bar || isTrip) return;
  const from=shortPlaceLabel(state.locFrom || r.stops[0]);
  const to=shortPlaceLabel(state.locTo || r.stops[r.stops.length-1]);
  const clock='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
  bar.innerHTML=
    `<div class="rm-route"><span>${acEsc(from)}</span><span class="ar">→</span><span>${acEsc(to)}</span></div>`+
    `<div class="rm-meta">${clock}<span>${acEsc(text)}</span></div>`;
}
function render(){
  requestEstimate(); // no-op unless the priced itinerary actually changed (see its own guard)
  renderRepriceNote();
  updateWaLinks();   // keeps the summary's WhatsApp draft in step with the trip on screen
  // live route from the actual entered locations
  const _from = state.locFrom || r.stops[0], _to = state.locTo || r.stops[r.stops.length-1];
  const _sf=document.getElementById('sum-from'); if(_sf) _sf.textContent = shortPlaceLabel(_from);
  const _stp=document.getElementById('sum-to'); if(_stp) _stp.textContent = shortPlaceLabel(_to);
  // keep the summary title in sync with the entered route (single transfers)
  const _sn=document.getElementById('sum-name');
  if(_sn && routeNamePrefix && !isTrip){
    _sn.textContent = `${routeNamePrefix} · ${shortPlaceLabel(_from)} → ${shortPlaceLabel(_to)}`;
  }
  paintCustomerRouteEstimate();
  document.getElementById('sum-date').textContent = state.flexDate ? 'To confirm (12h before)' : (state.date ? state.date.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}) : '—');
  document.getElementById('sum-time').textContent = state.flexTime ? 'To confirm (12h before)' : (state.dep ? fmtTime(state.dep) : '—');
  document.getElementById('sum-bags').textContent = state.bags>0 ? (state.bags+' large bag'+(state.bags>1?'s':'')) : 'No large bags';

  // service-chooser tags (trip mode)
  if(isTrip){
    const pvt=document.getElementById('svc-private-tag'), chf=document.getElementById('svc-chauffeur-tag');
    if(pvt) pvt.textContent='Priced per leg · pay in full';

    // chauffeur is billed per day, so it needs every leg dated before we can quote it
    const cx=document.getElementById('chauffeur-extra');
    const datesOK=tripDatesComplete();
    const chBtn=document.querySelector('.svc[data-svc="chauffeur"]');
    if(chf) chf.textContent=datesOK ? 'Priced for the whole trip · pay in full' : 'Add all dates to quote';
    if(chBtn && chBtn.style.display!=='none'){
      chBtn.disabled=!datesOK;
      chBtn.setAttribute('aria-disabled', datesOK?'false':'true');
      chBtn.classList.toggle('disabled', !datesOK);
    }
    if(!datesOK && state.svc==='chauffeur'){
      state.svc='private';
      document.querySelectorAll('.svc').forEach(b=>b.classList.toggle('on', b.dataset.svc==='private'));
    }
    if(cx){
      if(!datesOK){
        cx.className='cx-inline warn'; cx.style.display='block';
        cx.innerHTML='<div class="cx-h"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg><b>Add all leg dates to quote chauffeur-guide</b></div>'+
          '<p>A chauffeur-guide is priced by the length of your journey, so we can only quote it once every transfer leg has a date.</p>'+
          '<button type="button" class="cx-btn" onclick="location.href=\''+tripEditUrl+'\'">Add your dates →</button>';
      } else if(state.svc==='chauffeur'){
        const days=chauffeurDayList();
        cx.className='cx-inline ok'; cx.style.display='block';
        cx.innerHTML='<div class="cx-h"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4-3.9-3.8 5.4-.8z"/></svg><b>Your car &amp; driver-guide stays with you all '+days.length+' day'+(days.length>1?'s':'')+'</b></div>'+
          '<p>Same friendly face the whole trip — your driver-guide is included in your trip total.</p>';
      } else { cx.style.display='none'; cx.innerHTML=''; }
    }
    // can't proceed on a chauffeur trip until it's fully dated (no per-day rate without the days)
    const n1=document.getElementById('n1'); if(n1) n1.disabled = (state.svc==='chauffeur' && !datesOK);
  }

  // luggage capacity controls + note (step 2)
  const pax=state.ad+state.ch;
  const paxOver  = perVehicle && pax>vehPax;            // too many travellers for this vehicle
  const bagsOver = perVehicle && state.bags>maxBags;    // too much luggage for this vehicle
  const freeBags = Math.max(1, pax);            // one free large bag per traveller
  const sharedBagMax = freeBags + 5;            // allow a handful of paid extras
  const bgUp=document.getElementById('bg-up'); if(bgUp) bgUp.disabled = state.bags >= (isShared ? sharedBagMax : ABS_MAX_BAGS);
  const cap=document.getElementById('bag-cap'); if(cap) cap.textContent = isShared ? `One large bag per traveller free · extra bags $10 each` : (perVehicle ? `${vehicleLabel} · up to ${maxBags} bags` : `Up to ${maxBags} bags`);
  const note=document.getElementById('cap-note');
  if(note){
    if(paxOver || bagsOver){
      note.className='cap-note show warn';
      // an AC van (6 seats · 6 bags) clears most overflows from a car — offer the upgrade
      const vanFixes = vehicleKey==='car' && pax<=VEH_CAP.van.pax && state.bags<=VEH_CAP.van.bags;
      if(vanFixes){
        // vanPrice() is the local formula, not the adopted engine total — this note has to render
        // instantly as the traveller/bag steppers are clicked, and a round trip to /quote/v2/estimate
        // for every click would make the capacity warning lag behind the input. It's a comparison
        // figure only ("about this much more"), so it's marked ~ rather than presented as the price
        // the switch will actually charge — switchToVan() itself re-estimates through the engine.
        const vanP = vanPrice();
        const reason = (paxOver && bagsOver)
          ? `${pax} travellers and ${state.bags} bags won’t fit an AC car`
          : (paxOver
              ? `${pax} travellers won’t fit an AC car (up to ${VEH_CAP.car.pax})`
              : `${state.bags} large bags won’t fit an AC car (up to ${VEH_CAP.car.bags})`);
        note.innerHTML=`<b>${reason}.</b> An AC van seats up to ${VEH_CAP.van.pax} with room for ${VEH_CAP.van.bags} bags.`+
          `<button type="button" class="cap-switch" onclick="switchToVan()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M3 13h18M5 13V8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v5M6 17v2M18 17v2"/></svg> Switch to AC van${vanP?` · ~${money(vanP)}`:''}</button>`;
      } else {
        const waMsg=encodeURIComponent(`Hi Ceylon Hop — I need a larger vehicle for ${state.ad+state.ch} travellers${r&&r.name?` (${r.name})`:''}.`);
        note.innerHTML=`That’s over an AC van’s limit too (up to ${VEH_CAP.van.pax} travellers · ${VEH_CAP.van.bags} bags) — <a href="https://wa.me/94779669662?text=${waMsg}" target="_blank" rel="noopener">message us on WhatsApp</a> and we’ll arrange a larger vehicle.`;
      }
    } else if(perVehicle && vehicleKey==='van' && pax<=VEH_CAP.car.pax && state.bags<=VEH_CAP.car.bags){
      // party now fits an AC car again — recommend the cheaper vehicle to save money.
      // Same reasoning as the van-upsell note above: carPrice()/vehPrices.van are the local
      // formula's instant figures, kept only for this comparison (not the total) — hence the ~.
      const carP=carPrice(), vanP=(vehPrices?vehPrices.van:unit);
      const save=(carP!=null && vanP!=null)?vanP-carP:null;
      if(carP!=null && save!=null && save>0){
        note.className='cap-note show ok';
        note.innerHTML=`<b>An AC car fits your group</b> — ${pax} traveller${pax>1?'s':''}${state.bags>0?` · ${state.bags} bag${state.bags>1?'s':''}`:''}. Downgrade and save.`+
          `<button type="button" class="cap-switch" onclick="switchToCar()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13l2-5.5A2 2 0 0 1 6.9 6h10.2a2 2 0 0 1 1.9 1.5L21 13v4a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1H6v1a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M3 13h18"/></svg> Switch to AC car · save ~${money(save)}</button>`;
      } else { note.className='cap-note'; note.textContent=''; }
    } else if(isShared && state.bags>freeBags){
      const extra=state.bags-freeBags;
      note.className='cap-note show ok';
      note.innerHTML=`<b>${extra} extra bag${extra>1?'s':''} · +${money(extra*10)}</b> — every traveller gets one bag free; extras are $10 each, added to your total.`;
    } else if(!isShared && state.bags >= maxBags){
      note.className='cap-note show ok';
      note.textContent = !perVehicle
        ? `That’s the bag limit for a shared seat.`
        : (vehicleKey==='van'
            ? `That’s the max for an AC van. Need more space? Add a luggage rack below.`
            : `That’s the max for an AC car. Got more bags? Switch to a van, or add a luggage rack below.`);
    } else { note.className='cap-note'; note.textContent=''; }
  }
  // block progressing past Travellers while over the vehicle's seat OR luggage limit —
  // we can't accommodate it, so the traveller must upgrade or message us first
  const overCap = perVehicle && (paxOver || bagsOver);
  const n4=document.getElementById('n4');
  if(n4){ n4.disabled = overCap; }
  // "sightseeing stops" extra only makes sense on a single point-to-point private transfer
  const extras=document.getElementById('extras-block');
  if(extras) extras.style.display = (!isTrip && perVehicle) ? 'block' : 'none';
  const chrow=document.getElementById('sum-chrow');
  if(perVehicle){
    // A chauffeur-guide trip used to split this into "Chauffeur distance" + a "Chauffeur-guide · N days"
    // row. Pricing the driver out in the open invited "why am I paying that much for a driver?", so
    // (owner decision 2026-08-14) car and driver-guide bill as ONE whole-trip line — same label as a
    // private-transfer trip. The service chooser is what tells the two apart, not the summary rows.
    document.getElementById('sum-adlabel').textContent = isTrip
      ? (vehicleKey==='van'?'Private AC van · whole trip':'Private AC car · whole trip')
      : vehicleLabel;
    // The base line absorbs the one finishing adjustment AND the chauffeur day rate: it equals the
    // finished Total minus every OTHER visible row — the extras. So the rows on screen always sum
    // exactly to Total, and no raw pre-finishing number is ever shown here.
    let otherRows = 0; state.addons.forEach(function(a){ otherRows += (addonPrices[a] || 0); });
    const baseAmt = calcTotal() - otherRows;
    setNum(document.getElementById('sum-adamt'), money(baseAmt));
    chrow.style.display='flex';
    document.getElementById('sum-chlabel').textContent='Travellers';
    setNum(document.getElementById('sum-chamt'), `${state.ad+state.ch} · included`);
  } else {
    document.getElementById('sum-adlabel').textContent= isShared ? `Seats × ${state.ad}` : `Adults × ${state.ad}`;
    setNum(document.getElementById('sum-adamt'), money(unit*state.ad));
    if(!isShared && state.ch>0){chrow.style.display='flex';document.getElementById('sum-chlabel').textContent=`Children × ${state.ch}`;setNum(document.getElementById('sum-chamt'), money(unit*0.6*state.ch));}
    else chrow.style.display='none';
  }
  let addonHtml='';
  if(isShared){ const free=Math.max(1,state.ad+state.ch); const xb=Math.max(0,state.bags-free); if(xb>0){ addonHtml+=`<div class="s-row"><span>Extra bag${xb>1?'s':''} × ${xb}</span><b>${money(xb*10)}</b></div>`; } }
  state.addons.forEach(a=>{addonHtml+=`<div class="s-row"><span>${addonNames[a]}</span><b>${money(addonPrices[a])}</b></div>`;});
  // Ticking an extra used to make a summary row and a new total appear in the same frame, which
  // read as the panel redrawing rather than the customer's choice landing in it. The rows are
  // rebuilt wholesale (they're cheap), so the CONTAINER travels between its old and new height
  // and the rows fade up inside it — one movement, not a jump plus a repaint.
  const addonsEl=document.getElementById('sum-addons');
  if(addonsEl.innerHTML!==addonHtml){
    if(window.CH && CH.motion) CH.motion.resize(addonsEl, ()=>{ addonsEl.innerHTML=addonHtml; }, { duration:260 });
    else addonsEl.innerHTML=addonHtml;
  }
  // A response the engine itself flags `estimated` (a route it can't fully price yet) gets the
  // same "~" approx treatment the trip itinerary already uses for a leg with no resolvable
  // distance (:557-570's "Distance on request" pattern) — the figure on screen is a heads-up,
  // not the final number, and the Pay gate below refuses until checkout can confirm it for real.
  const curEst = currentEngineEst();
  // While a fresh estimate is in flight for a changed itinerary, the total says what is
  // happening instead of printing a figure. The class carries the styling AND is what the
  // sticky mobile bar reads to match (:2470) — the bar mirrors this element's text, and
  // "Calculating…" in a nowrap display face at 1.35rem would otherwise crush its CTA.
  const busy = repricing();
  const totalEl = document.getElementById('sum-total');
  setNum(totalEl, busy ? PRICING_LABEL : (curEst && curEst.estimated ? '~' : '') + money(calcTotal()));
  if(totalEl){
    totalEl.classList.toggle('is-pricing', busy);
    if(busy) totalEl.setAttribute('aria-busy','true'); else totalEl.removeAttribute('aria-busy');
  }

  // Deposit messaging is disabled for now: every customer booking pays in full.
  let depEl=document.getElementById('s-deposit');
  if(!depEl){ depEl=document.createElement('div'); depEl.id='s-deposit'; depEl.className='s-deposit'; document.getElementById('sum-total').closest('.s-body').appendChild(depEl); }
  depEl.style.display='none';

  // cancellation language adapts to the service (24h transfers · 10 days chauffeur-guide)
  const perk=document.getElementById('perk-cancel');
  // Keep this mark in step with the one in booking.html's .s-perks — this line replaces the
  // whole row, so a stale tick here silently undoes the markup a moment after it renders.
  if(perk) perk.innerHTML=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 9.5h17M8 2.8V6M16 2.8V6"/><path d="M15.3 14.6a3.3 3.3 0 1 0 .6 2.4"/><path d="M15.9 12.4v2.4h-2.4"/><circle class="wp" cx="8" cy="2.8" r="1.2"/></svg> ${cancelText()}`;
  const paySub=document.getElementById('pay-sub');
  if(paySub) paySub.textContent=`Pay securely to confirm. ${cancelText()}.`;

  // clarity note about how the service works (Where step)
  const pvtNote=document.getElementById('pvt-note'), pvtTx=document.getElementById('pvt-note-tx');
  if(pvtNote && pvtTx){
    if(isTrip && state.svc==='chauffeur'){
      pvtTx.innerHTML='<b>One car &amp; driver-guide for the whole trip.</b> One price covers the car, your driver-guide and every kilometre. Your chauffeur-guide stays with you from start to finish — same friendly face every day, flexible stops along the way.';
    } else if(isTrip){
      pvtTx.innerHTML='<b>Door-to-door pick-ups &amp; drop-offs, every leg.</b> Each leg is priced as its own private transfer and booked fresh, so you may not have the exact same car or driver every day.';
    } else {
      pvtTx.innerHTML='<b>It’s a door-to-door pick-up &amp; drop-off.</b> A private transfer covers this one journey — we pick you up at your spot and drop you at your destination.';
    }
  }

  // payment step: all customer bookings pay in full for now
  const payDue=document.getElementById('pay-due');
  if(payDue){
    // Due now sits beside the summary total on this step, so it takes the same treatment — one
    // of the two reading "Calculating…" while the other showed a figure would be its own
    // small lie about which number is current.
    payDue.innerHTML = `<span class="lbl">Due now<b>${(isTrip&&state.svc==='chauffeur')?'Chauffeur-guide':(isTrip?'Private transfer':r.name)}</b></span>`+
      `<span class="amt${busy?' is-pricing':''}">${busy ? PRICING_LABEL : money(amountDueNow())}</span>`;
  }
  let choice=document.getElementById('pay-choice');
  if(choice){
    choice.style.display = 'none';
  }

  // Pay gate (Task 3): the established disabled treatment (same idiom as #n1/#n4 above) for the
  // three states a charge must never start from — a fresh price still in flight, a raise
  // awaiting acknowledgement, or a figure the engine itself flags as not-yet-final. A disabled
  // control never leaves the customer guessing why (the #when-blocked paragraph next to #n2 set
  // this precedent), so the reason is shown proactively here — not only surfaced reactively if a
  // stale enabled button gets clicked anyway (the click handler carries that belt-and-braces
  // copy of the same checks). #details-error lives inside the payment panel, so it's invisible
  // whenever that panel isn't the active step regardless of its own `hidden` — safe to set on
  // every render() without tracking which step is open.
  const payBtn=document.getElementById('pay-btn');
  const payGateReason = estimatePending
    ? 'Still getting your latest price — one moment…'
    : state.pendingReprice
      ? 'Please review the updated price above before continuing.'
      : (curEst && curEst.estimated)
        ? 'This trip’s exact price will be confirmed at checkout — nothing is charged until then.'
        : null;
  if(payBtn) payBtn.disabled = !!payGateReason;
  const gateNote=document.getElementById('details-error');
  if(gateNote){
    if(payGateReason){ gateNote.textContent=payGateReason; gateNote.hidden=false; gateNote.dataset.gate='1'; }
    else if(gateNote.dataset.gate){ gateNote.hidden=true; gateNote.textContent=''; delete gateNote.dataset.gate; }
  }
}

// ---- step navigation ----
let current=1;
window.goStep=function(n){
  // a journey step with no panel (e.g. the planner-only Route/Dates nodes) is a no-op here
  if(!document.querySelector('.panel[data-panel="'+n+'"]')) return;
  current=n;
  document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active',+p.dataset.panel===n));
  document.querySelectorAll('.pstep').forEach(ps=>{
    const s=+ps.dataset.s;
    ps.classList.toggle('active',s===n);
    ps.classList.toggle('done',s<n);
    if(s<n)ps.querySelector('.dot').innerHTML=CK;
    else ps.querySelector('.dot').textContent=s;
  });
  document.querySelectorAll('.pline').forEach((l,i)=>l.classList.toggle('done',i<n-1));
  window.scrollTo({top:0,behavior:'smooth'});
  // An unacknowledged raise blocks EVERY step's CTA, so its notice follows the customer here
  // rather than staying on the step it fired from (phone layout — see engineNoteHome). It runs
  // AFTER the scroll home so that its own scrollIntoView is the one that lands: a new step with
  // a blocked CTA should open on the reason, not on a top-of-page the customer must scroll off.
  renderRepriceNote();
};

// Clear the consent warning as soon as they tick it, so the red border can't stick around.
(function(){
  const agree=document.getElementById('agree');
  if(!agree) return;
  agree.addEventListener('change',()=>{
    if(!agree.checked) return;
    const box=agree.closest('.addon'); if(box) box.style.borderColor='';
    const derr=document.getElementById('details-error');
    if(derr && /Terms & cancellation/.test(derr.textContent||'')) derr.hidden=true;
  });
})();

// The 7-day rate lock was completely invisible to the customer, which is a reassurance we had
// already built and paid for. Only ever shown once a lock actually exists.
function showRateLock(){
  const due=document.getElementById('pay-due');
  if(!due || document.getElementById('rate-lock-note')) return;
  const p=document.createElement('p');
  p.id='rate-lock-note'; p.className='rate-lock-note';
  p.textContent='This price is locked for 7 days.';
  due.after(p);
}

// The summary perks are static markup, so a private transfer was promised a guide "on board".
(function(){
  const crew=document.getElementById('perk-crew');
  if(crew && isShared) crew.lastChild.textContent=' Pro Hopper guide on board';
})();

// Back to search WITH the route intact - dropping them on the homepage threw away everything
// they had already chosen.
function backToSearchUrl(){
  try{
    const p=new URLSearchParams();
    const from=params.get('from'), to=params.get('to');
    if(from) p.set('from',from);
    if(to) p.set('to',to);
    return p.toString() ? 'search.html?'+p.toString() : 'index.html';
  }catch(e){ return 'index.html'; }
}

// ---- payment ----
document.getElementById('pay-btn').addEventListener('click',async ()=>{
  const derr=document.getElementById('details-error');
  // Pay gate (Task 3) — the button is already disabled for these in render(); this is the
  // belt-and-braces check for the moment a stale enabled button gets clicked anyway (e.g. a
  // click queued a frame before a re-render lands).
  if(estimatePending){
    if(derr){ derr.textContent='Still getting your latest price — please wait a moment and try again.'; derr.hidden=false; }
    return;
  }
  if(state.pendingReprice){
    if(derr){ derr.textContent='Please review the updated price above before continuing.'; derr.hidden=false; }
    return;
  }
  const activeEst=currentEngineEst();
  if(activeEst && activeEst.estimated){
    if(derr){ derr.textContent='This trip’s exact price will be confirmed at checkout — nothing is charged until then.'; derr.hidden=false; }
    return;
  }
  // validate the lead traveller's contact details before payment
  const first=document.getElementById('f-first'), last=document.getElementById('f-last'),
        email=document.getElementById('f-email'), phone=document.getElementById('f-phone');
  [first,last,email,phone].forEach(el=>el.classList.remove('inp-bad'));
  if(derr) derr.hidden=true;
  const fail=(el,msg)=>{ el.classList.add('inp-bad'); if(derr){derr.textContent=msg; derr.hidden=false;} el.focus(); };
  const emailRe=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if(!first.value.trim()) return fail(first,'Please add the lead traveller’s first name.');
  if(!last.value.trim()) return fail(last,'Please add the lead traveller’s last name.');
  if(!emailRe.test(email.value.trim())) return fail(email,'Enter a valid email so we can send your confirmation.');
  if(phoneParts().number.length<7) return fail(phone,'Enter a valid WhatsApp number.');

  // Billing goes to the card gateway, so it is required in the same way the email is —
  // named box by named box, never a generic "check the form". Postcode and state are
  // deliberately absent from this list: most of the world has no state, and a field nobody
  // can fill must never block a payment.
  const addr=document.getElementById('f-addr'), city=document.getElementById('f-city'),
        bcountry=document.getElementById('f-bcountry');
  [addr,city,bcountry].forEach(el=>el && el.classList.remove('inp-bad'));
  if(!addr.value.trim()) return fail(addr,'Please enter your billing address — the one on your card statement.');
  if(!city.value.trim()) return fail(city,'Please enter your billing city.');
  if(!bcountry.value.trim()) return fail(bcountry,'Please choose your billing country.');
  const diffbill=document.getElementById('f-diffbill');
  if(diffbill && diffbill.checked){
    const bfirst=document.getElementById('f-bfirst'), blast=document.getElementById('f-blast');
    [bfirst,blast].forEach(el=>el && el.classList.remove('inp-bad'));
    if(!bfirst.value.trim()) return fail(bfirst,'Please enter the cardholder’s first name.');
    if(!blast.value.trim()) return fail(blast,'Please enter the cardholder’s last name.');
  }

  const agree=document.getElementById('agree');
  if(!agree.checked){
    // Was a red border and nothing else: colour-only, no message, and it never reset.
    agree.closest('.addon').style.borderColor='var(--tomato)';
    if(derr){ derr.textContent='Please tick the box to agree to the Terms & cancellation policy.'; derr.hidden=false; }
    agree.focus();
    return;
  }

  runPayment();
});

// Runs the actual payment after the contact form passes validation. Every outcome
// (working / failed / cancelled) is surfaced INSIDE the PayHere overlay so the
// customer always sees what happened where they expect it — never a stray note on
// the form. The overlay opens immediately so clicking Pay always shows feedback.
//
// One checkout per press. The overlay is not enough on its own: a double-tap on
// mobile lands two clicks before the first repaint paints the scrim, and the retry
// button re-enters this function with no scrim in the way at all. Two runs mean two
// draft bookings and two PayHere hand-offs for one trip (pay.html has carried the
// same latch since #357). Released only at a terminal state: phShowEnd (every
// failure/cancel path) or finalizeBooking (success).
let paySubmitting = false;
function payRelease(){
  paySubmitting = false;
  const b = document.getElementById('pay-btn');
  if(b) b.disabled = false;
}
async function runPayment(){
  if(paySubmitting) return;
  paySubmitting = true;
  // Also disable the source button — the mobile bar mirrors it via its MutationObserver.
  const _payBtn = document.getElementById('pay-btn');
  if(_payBtn) _payBtn.disabled = true;
  if(typeof window.chTrack==='function') window.chTrack('payment_initiated',{payment_type:state.payPlan,currency:'USD',value:calcTotal()});
  phShowLoading('Setting up your secure payment…');
  const API = window.CEYLON_HOP_API;
  // No backend configured → demo mode: simulated interstitial, then confirm.
  if(!API){ return simulatePayThenConfirm(null); }

  // Backend configured: create the real (draft) booking first. On the free hosting
  // tier the API can be waking from idle, so reassure the customer if it's slow.
  const slow = setTimeout(()=>{
    const m=document.getElementById('ph-msg');
    if(m && document.getElementById('ph-actions').hidden) m.textContent='Just waking up our booking system — one moment…';
  }, 6000);
  let booking;
  try { booking = await createApiBooking(); }
  catch(e){ clearTimeout(slow); return phShowEnd(...bookingCreateFailure(e)); }
  clearTimeout(slow);
  if(!booking){ return simulatePayThenConfirm(null); }

  // Adopt the server's authoritative price so the overlay, PayHere and confirmation all show
  // exactly what is charged — not the wizard's browser-distance estimate. The LOCAL formula is
  // already understood to be a rough guide the server can legitimately reprice from (a few
  // percent of routing drift) and has always adopted silently — that pre-existing behaviour is
  // untouched. A live ENGINE estimate is a different promise: it's the server's own pricing
  // engine, shown moments ago, so a booking-create total landing more than $1 away from IT is
  // the LAST hop where the "never charge a figure not shown immediately beforehand" rule
  // (renderRepriceNote, applied mid-wizard) can still be broken, and gets the same gate here.
  const shownEngineEst = currentEngineEst();
  const shownBeforeAdopt = calcTotal();
  adoptServerQuote(booking);
  if(shownEngineEst && Math.abs(calcTotal()-shownBeforeAdopt) > 1){
    return phShowFinalRepriceGate(booking, shownBeforeAdopt, calcTotal());
  }
  return continueToCheckout(booking);
}

// The rest of a payment attempt once the draft booking exists and its total has been accepted
// (either silently, within $1, or explicitly via the final-reprice gate above). Split out so
// that gate can pause here and resume on the customer's own click, rather than duplicating the
// checkout-params fetch and gateway hand-off.
async function continueToCheckout(booking){
  const API = window.CEYLON_HOP_API;
  phShowLoading('Setting up your secure payment…');
  const _amt=document.getElementById('ph-amt'); if(_amt) _amt.textContent=money(amountDueNow());

  // Ask the API for checkout params; if it's real PayHere, open the hosted checkout.
  //
  // A refusal here is a 409 that SAYS why — awaiting_price (ops is pricing this by hand),
  // already_paid, not_chargeable — and each needs different words. Reading only res.ok
  // collapsed all three into "try again in a moment", which for every one of them is advice
  // that cannot work: the price isn't coming back in a moment, and a paid booking will never
  // become unpaid. So read the body, and only fall back to the generic line when the server
  // didn't explain itself.
  let checkout=null, refusal=null;
  try{
    const checkoutHeaders = booking.checkoutToken
      ? { authorization: 'Bearer '+booking.checkoutToken }
      : {};
    const res = await fetch(
      API.replace(/\/$/,'')+'/bookings/'+booking.id+'/checkout',
      {method:'POST',headers:checkoutHeaders}
    );
    if(res.ok) checkout = await res.json();
    else refusal = await res.json().catch(()=>null);
  }catch(e){}

  // No checkout params (a refusal, a network error, a 5xx, or the backend's amount-mismatch
  // guard) → a real failure. NEVER show a fake "approved" screen for an unpaid booking.
  if(!checkout || !checkout.checkoutUrl){
    return phShowEnd(...checkoutRefusal(refusal));
  }
  // Real PayHere gateway.
  if(/payhere\.lk/.test(checkout.checkoutUrl)){
    if(!window.payhere){
      // SDK failed to load (often an ad-blocker). Don't fake success.
      return phShowEnd('error','We couldn’t open the secure payment window — please turn off any ad-blocker for this page and try again. No charge was made.');
    }
    document.getElementById('ph-msg').textContent='Opening secure payment…';
    return startPayHere(checkout, booking);
  }
  // Backend returned a non-PayHere checkout URL → the fake/dev gateway is configured
  // (no real money gateway). Simulated interstitial with the real reference.
  return simulatePayThenConfirm(booking);
}

// The overlay's own amber gate for the booking-create total drifting from what was shown (see
// runPayment above). Reuses the overlay's warn styling (phShowEnd's 'warn' icon) rather than the
// summary panel's reprice-note: at this point the wizard panels are behind the overlay's scrim,
// so the note has to live where the customer is actually looking.
function ensurePhAcceptBtn(){
  let el=document.getElementById('ph-accept-reprice');
  if(!el){
    el=document.createElement('button');
    el.type='button'; el.id='ph-accept-reprice'; el.className='ph-btn ph-btn-primary';
    const actions=document.getElementById('ph-actions');
    if(actions) actions.insertBefore(el, actions.firstChild);
  }
  return el;
}
function phShowFinalRepriceGate(booking, fromAmt, toAmt){
  // The overlay fully covers the page (it's the same modal Pay opened into), so releasing the
  // submit latch here is safe — nothing beneath it is reachable until this gate is resolved one
  // way or the other, and a stuck latch would otherwise leave Pay permanently disabled if the
  // customer backs out via Close.
  payRelease();
  document.getElementById('ph-spin').style.display='none';
  const amt=document.getElementById('ph-amt'); if(amt) amt.style.display='none';
  const sub=document.getElementById('ph-sub'); if(sub) sub.style.display='none';
  const sec=document.getElementById('ph-secure'); if(sec) sec.style.display='none';
  const ico=document.getElementById('ph-ico');
  if(ico){
    ico.hidden=false; ico.className='ph-ico warn';
    ico.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>';
  }
  const m=document.getElementById('ph-msg');
  m.className='ph-msg ph-msg-big';
  m.textContent=`Your confirmed total is ${money(toAmt)} (you were shown ${money(fromAmt)}) — accept to continue to payment.`;
  const help=document.getElementById('ph-help'); if(help){ help.innerHTML=''; help.hidden=true; }
  const retry=document.getElementById('ph-retry'); if(retry) retry.hidden=true;
  const close=document.getElementById('ph-close');
  const onClose=()=>{ if(close) close.removeEventListener('click', onClose); };
  if(close){ close.hidden=false; close.addEventListener('click', onClose, { once:true }); }
  const acc=ensurePhAcceptBtn();
  acc.textContent='Accept '+money(toAmt)+' & continue';
  acc.hidden=false;
  acc.onclick=()=>{
    acc.hidden=true; acc.onclick=null;
    if(close) close.removeEventListener('click', onClose);
    continueToCheckout(booking);
  };
  document.getElementById('ph-actions').hidden=false;
  document.getElementById('ph-overlay').classList.add('show');
}

/* Turn a refused POST /bookings/* (the error createApiBooking throws) into words.
   Returns the phShowEnd(kind, msg, opts) argument list.

   Shows the server's own `message` and nothing else: those 400s carry copy written for the
   customer where the rule lives — a date in the past, a shared route that doesn't run that
   day or at that time — and re-writing them here is how the two drift. Everything without
   one keeps the generic line, which is honest advice for exactly those cases: a 5xx
   (`internal_error`, no message), an aborted/failed fetch, or a body naming only an internal
   code (invalid_request's Zod details) can all succeed on a retry. */
function bookingCreateFailure(err){
  const msg = err && err.body && err.body.message;
  return ['error', msg || 'We couldn’t start your booking just now — please try again in a moment.'];
}

/* Turn a refused POST /bookings/:id/checkout into words + an honest retry button.
   Returns the phShowEnd(kind, msg, opts) argument list.

   `awaiting_price` carries the server's own customer-facing copy, written where the rule
   lives; repeating it here is how the two drift. The others are named because their message
   is about THIS page's state, not the pricing rule. */
function checkoutRefusal(body){
  const err = body && body.error;
  if(err==='awaiting_price'){
    return ['error', body.message
      || 'We’re confirming the price for this trip by hand — we’ll message you shortly with the final amount.',
      {retry:false}];
  }
  if(err==='already_paid'){
    return ['error','This booking is already paid — nothing more is owed. Check your email for the confirmation, or message us on WhatsApp if it hasn’t arrived.',{retry:false}];
  }
  if(err==='not_chargeable'){
    return ['error','This booking can no longer be paid for. Message us on WhatsApp and we’ll sort it out — no charge was made.',{retry:false}];
  }
  return ['error','We couldn’t start your payment just now — no charge was made. Please try again in a moment.'];
}

// ---- payment overlay states (loading / problem) ----
function phShowLoading(msg){
  const amt=document.getElementById('ph-amt'); if(amt){ amt.style.display=''; amt.textContent=money(amountDueNow()); }
  document.getElementById('ph-spin').style.display='block';
  const ico=document.getElementById('ph-ico'); if(ico) ico.hidden=true;
  const sub=document.getElementById('ph-sub'); if(sub) sub.style.display='';
  const sec=document.getElementById('ph-secure'); if(sec) sec.style.display='';
  const m=document.getElementById('ph-msg'); m.className='ph-msg'; m.textContent=msg||'Processing your payment securely…';
  // Clear the previous attempt's end-state, or a second try inherits the first's decline
  // steps and its suppressed retry button.
  const help=document.getElementById('ph-help'); if(help){ help.innerHTML=''; help.hidden=true; }
  const retry=document.getElementById('ph-retry'); if(retry) retry.hidden=false;
  document.getElementById('ph-actions').hidden=true;
  document.getElementById('ph-overlay').classList.add('show');
}
// kind: 'error' (red, something went wrong) | 'cancelled' (amber, user backed out)
// opts.help  — decline steps (decline-help.js). Pass ONLY after a real attempt at the
//              gateway; a booking that never reached a card gets no bank advice.
// opts.retry — false when trying again cannot possibly work (an already-paid booking).
function phShowEnd(kind, msg, opts){
  // Terminal state: re-arm the latch here, where the retry button appears. Without this a
  // refused card would leave Pay locked with no way to try again — strictly worse than the
  // double-click the latch guards against.
  payRelease();
  document.getElementById('ph-spin').style.display='none';
  const amt=document.getElementById('ph-amt'); if(amt) amt.style.display='none';
  const sub=document.getElementById('ph-sub'); if(sub) sub.style.display='none';
  const sec=document.getElementById('ph-secure'); if(sec) sec.style.display='none';
  // Leftover from the final-reprice gate (phShowFinalRepriceGate), if this attempt passed
  // through it — every OTHER overlay state uses the two static buttons only.
  const acc=document.getElementById('ph-accept-reprice'); if(acc){ acc.hidden=true; acc.onclick=null; }
  const ico=document.getElementById('ph-ico');
  if(ico){
    ico.hidden=false; ico.className='ph-ico '+(kind==='error'?'err':'warn');
    ico.innerHTML = kind==='error'
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/></svg>';
  }
  const m=document.getElementById('ph-msg'); m.className='ph-msg ph-msg-big'; m.textContent=msg;
  const o=opts||{};
  const help=document.getElementById('ph-help');
  if(help){
    if(o.help && o.help.length){
      help.innerHTML='<h3>If your card was declined</h3><ol>'
        + o.help.map(t=>`<li>${optionText(t)}</li>`).join('') + '</ol>';
      help.hidden=false;
    } else { help.innerHTML=''; help.hidden=true; }
  }
  const retry=document.getElementById('ph-retry');
  if(retry) retry.hidden = o.retry === false;
  document.getElementById('ph-actions').hidden=false;
  document.getElementById('ph-overlay').classList.add('show');
}
document.getElementById('ph-retry').addEventListener('click', ()=>runPayment());
document.getElementById('ph-close').addEventListener('click', ()=>document.getElementById('ph-overlay').classList.remove('show'));

// Demo / no real gateway: the simulated "Redirecting to PayHere…" interstitial, then the pass.
function simulatePayThenConfirm(booking){
  const ov=document.getElementById('ph-overlay');
  document.getElementById('ph-amt').textContent=money(amountDueNow());
  document.getElementById('ph-msg').textContent='Redirecting you to PayHere…';
  document.getElementById('ph-spin').style.display='block';
  ov.classList.add('show');
  setTimeout(()=>{ document.getElementById('ph-msg').textContent='Processing your payment securely…'; }, 1300);
  setTimeout(()=>{ document.getElementById('ph-spin').style.display='none';
    document.getElementById('ph-msg').innerHTML='✓ Payment approved — returning to Ceylon Hop…'; }, 2500);
  setTimeout(()=>{ ov.classList.remove('show'); finalizeBooking(booking); }, 3400);
}

// Real PayHere hosted checkout via the JS SDK (popup). The notify webhook is the source of
// truth for "paid"; onCompleted just shows the customer their confirmation.
function startPayHere(checkout, booking){
  const payment = Object.assign({ sandbox: /sandbox\.payhere\.lk/.test(checkout.checkoutUrl) }, checkout.fields);
  payhere.onCompleted = function(){ document.getElementById('ph-overlay').classList.remove('show'); finalizeBooking(booking); };
  payhere.onDismissed = function(){ showPayDismissed(); };
  payhere.onError = function(){ showPayFailed(); };
  payhere.startPayment(payment);
}

// PayHere's SDK reports a decline and a plain "I closed the window" through two different
// callbacks, but neither one says WHICH — a declined card also closes the window. So both
// outcomes carry the decline steps, and the heading asks rather than asserts ("if your card
// was declined"). Guessing wrong in either direction is worse than letting the payer pick.
function declineHelp(){ return window.CH_DECLINE_HELP || []; }

function showPayFailed(){
  // Same dimensions as payment_initiated, so a failure can be compared against
  // its own initiation — otherwise GA4 shows a count with nothing to divide by.
  if(typeof window.chTrack==='function') window.chTrack('payment_failed',{payment_type:state.payPlan,currency:'USD',value:calcTotal()});
  phShowEnd('error','Your payment didn’t go through — no charge was made.',{help:declineHelp()});
}
function showPayDismissed(){
  if(typeof window.chTrack==='function') window.chTrack('payment_dismissed',{payment_type:state.payPlan,currency:'USD',value:calcTotal()});
  phShowEnd('cancelled','Payment cancelled — your booking isn’t confirmed yet. You can try again when you’re ready.',{help:declineHelp()});
}

// Rate-lock (spec 2026-07-11 §5): mint — or reuse — a 7-day locked quote for the current
// itinerary, so a customer who returns within the window books the price they were quoted even if
// the rate card moved (fuel-driven changes). Best-effort and NON-BLOCKING: any failure returns
// undefined and the booking prices on the live card, exactly as before. The quote id is cached in
// localStorage keyed by the itinerary, so a same-device return within 7 days reuses the lock and a
// changed trip re-locks. `lockReq` is a POST /quote/lock (QuoteSchema) body.
async function ensureLockedQuoteId(apiBase, lockReq){
  if(!apiBase) return undefined;
  let sig;
  try { sig = JSON.stringify(lockReq); } catch(e){ return undefined; }
  try {
    const cached = JSON.parse(localStorage.getItem('chQuoteLock') || 'null');
    if (cached && cached.sig === sig && cached.quoteId && cached.exp > Date.now()) return cached.quoteId;
  } catch(e){ /* storage blocked or bad JSON — fall through and mint a fresh one */ }
  const ctrl = new AbortController();
  const timer = setTimeout(()=>ctrl.abort(), 8000); // never let the lock step hold up checkout
  try {
    const res = await fetch(apiBase.replace(/\/$/,'')+'/quote/lock', {
      method:'POST', headers:{'content-type':'application/json'}, body: sig, signal: ctrl.signal
    });
    if(!res.ok) return undefined;
    const q = await res.json();
    if(!q || !q.quoteId) return undefined;
    const exp = q.rateLockedUntil ? Date.parse(q.rateLockedUntil) : (Date.now() + 7*24*3600*1000);
    try { localStorage.setItem('chQuoteLock', JSON.stringify({ sig: sig, quoteId: q.quoteId, exp: exp })); } catch(e){}
    showRateLock();
    return q.quoteId;
  } catch(e){ return undefined; }
  finally { clearTimeout(timer); }
}

// Task 5: the idempotency key createApiBooking sends with its POST — split out so the
// duplicate-draft-race fix (excluding quotedTotal, see the call site) is unit-testable on its
// own, without exercising the whole booking-creation flow (DOM reads, fetch, PayHere).
function idempotencyKeyFor(payload){
  const source = JSON.stringify(Object.assign({}, payload, { quotedTotal: undefined }));
  let h = 0; for (let i = 0; i < source.length; i++) h = ((h << 5) - h + source.charCodeAt(i)) | 0;
  return 'ch-' + (h >>> 0).toString(36);
}

// M7 — when a backend is configured, create a real booking and use its reference.
// Handles all three flows: single transfer, multi-stop trip, and shared seat.
// Returns null only when no backend is configured (demo mode, default site behaviour);
// when a backend IS set, a failed save throws so the caller shows an error instead of a
// fake confirmation.
async function createApiBooking(){
  const API = window.CEYLON_HOP_API;
  if(!API) return null;
  const phone = phoneParts();
  const customer = {
    firstName: document.getElementById('f-first').value.trim(),
    lastName: document.getElementById('f-last').value.trim(),
    email: document.getElementById('f-email').value.trim(),
    phoneCountryCode: phone.code,
    phoneNumber: phone.number,
    whatsapp: phone.whatsapp,
    country: document.getElementById('f-country').value
  };
  // the price the customer was shown (minor units) — the backend records this, so the
  // confirmation, the DB and the eventual charge all agree.
  const quotedTotal = calcTotal() > 0 ? Math.round(calcTotal() * 100) : undefined;
  let endpoint, payload;
  if(isTrip){
    endpoint = '/bookings/trip';
    const tVeh = (vehicleKey==='van') ? 'van' : 'car';
    // Lock the rate card for this tour (best-effort; undefined → prices live). We lock as a plain
    // 'private' itinerary of the trip's legs — the lock captures the whole CARD regardless of
    // product, and the booking re-prices the real trip (private OR chauffeur) against it, so we
    // don't need to reconstruct the chauffeur day-model here just to freeze the rates.
    const tripLegs = [];
    for(let i=0; i<tripStops.length-1; i++){
      if(tripGaps.has(i)) continue; // a self-arranged gap is not part of the quoted/locked trip
      const tf = tripStops[i], tt = tripStops[i+1];
      tripLegs.push({ from: tf, to: tt, distanceKm: lockLegKm(tf, tt) });
    }
    const tQuoteId = tripLegs.length
      ? await ensureLockedQuoteId(API, { product:'private', vehicle:tVeh, pax: state.ad + state.ch, bags: 0, legs: tripLegs })
      : undefined;
    payload = {
      stops: tripStops,
      nights: tripNights,
      dates: tripDates.some(Boolean) ? tripDates : undefined,
      pax: state.ad + state.ch,
      vehicleType: tVeh,
      serviceType: state.svc,
      customer,
      quotedTotal,
      quoteId: tQuoteId,
      days: (state.svc==='chauffeur') ? tripDays : undefined,
      driverNights: (state.svc==='chauffeur') ? Math.max(0, tripDays-1) : undefined
    };
  } else if(isShared){
    endpoint = '/bookings/shared';
    payload = {
      corridorId: sharedCorridorId || undefined,
      from: state.locFrom || r.stops[0],
      to: state.locTo || r.stops[r.stops.length-1],
      date: (state.flexDate || !state.date) ? undefined : fmtISO(state.date),
      time: state.dep || undefined,
      seats: state.ad + state.ch,
      bags: state.bags,
      customer,
      quotedTotal
    };
  } else {
    endpoint = '/bookings/single';
    const sFrom = state.locFrom || r.stops[0];
    const sTo = state.locTo || r.stops[r.stops.length-1];
    const sVeh = (vehicleKey==='van') ? 'van' : 'car';
    // Lock the rate card for this transfer (best-effort; undefined → prices live). distanceKm is
    // the engine's own measured figure when a fresh estimate covers this leg (lockLegKm), else
    // the client's kmBetween estimate — either way the booking re-resolves it server-side, and
    // the lock captures the CARD regardless, so a rough/zero km here never affects what the
    // customer is charged.
    const sQuoteId = await ensureLockedQuoteId(API, {
      product:'private', vehicle:sVeh, pax: state.ad + state.ch, bags: state.bags,
      legs: [{ from: sFrom, to: sTo, distanceKm: lockLegKm(sFrom, sTo) }]
    });
    payload = {
      from: sFrom,
      to: sTo,
      date: (state.flexDate || !state.date) ? undefined : fmtISO(state.date),
      time: (state.flexTime || !state.dep) ? undefined : state.dep,
      vehicleType: sVeh,
      adults: state.ad, children: state.ch, bags: state.bags,
      customer,
      quotedTotal,
      quoteId: sQuoteId,
      // selected add-ons use the engine's ExtraCode values, priced server-side (GL-4)
      extras: state.addons.size ? Array.from(state.addons) : undefined
    };
  }
  // Terms + cancellation acceptance travels WITH the booking (2026-08-01). The checkbox was
  // client-side only and recorded nothing, so a refund dispute had no evidence either way;
  // the API now requires this and stamps terms_accepted_at on the booking. The #agree gate
  // above already blocks submission, so reaching here means it is ticked.
  payload.termsAccepted = true;
  // Billing details for the card (2026-08-03). Sent for every mode, because every mode goes
  // through the same PayHere checkout. The empty optionals are OMITTED rather than sent as
  // '': BillingInput requires a non-empty string when the key is present, so a blank postcode
  // would 400 — the same block on a Hong Kong or UAE payer, just moved to the server.
  const bill = {
    address: document.getElementById('f-addr').value.trim(),
    city: document.getElementById('f-city').value.trim(),
    country: document.getElementById('f-bcountry').value.trim(),
  };
  const bpost = document.getElementById('f-postcode').value.trim();
  const bstate = document.getElementById('f-state').value.trim();
  if(bpost) bill.postcode = bpost;
  if(bstate) bill.state = bstate;
  if(document.getElementById('f-diffbill').checked){
    bill.firstName = document.getElementById('f-bfirst').value.trim();
    bill.lastName  = document.getElementById('f-blast').value.trim();
  }
  payload.billing = bill;
  // A backend IS configured, so a failure here must surface — never fake a confirmation.
  // (Returning null is reserved for "no backend configured" = intentional demo mode.)
  const body = JSON.stringify(payload);
  // Idempotency: a stable key derived from the request, but WITHOUT quotedTotal (Task 5 — kills
  // a duplicate-draft race). A retried or duplicated POST (free-tier cold-start timeout, the
  // ph-retry button) must return the SAME booking instead of creating a second draft — but if a
  // re-estimate lands between the original attempt and its retry, quotedTotal alone would change
  // and mint a fresh key, defeating that. The server prices engine-first (bookings.ts GL-3), so
  // quotedTotal is advisory only — dropping it from the key is safe. Any OTHER change to the
  // request (different trip, pax, dates, …) still produces a new key exactly as before.
  const idemKey = idempotencyKeyFor(payload);
  const ctrl = new AbortController();
  const timer = setTimeout(()=>ctrl.abort(), 45000); // allow for a free-tier cold start
  let res;
  try{
    res = await fetch(API.replace(/\/$/,'')+endpoint, {
      method:'POST', headers:{'content-type':'application/json','idempotency-key':idemKey}, body, signal: ctrl.signal
    });
  } finally { clearTimeout(timer); }
  // Carry the refusal, don't discard it: the API answers some 400s with copy written for the
  // customer (date_in_past, not_a_service_day…), and throwing only the status collapsed every
  // one of them into "try again in a moment" — advice that can never work for a refusal the
  // customer has to go back and fix. Same error shape board.js's apiFetch throws (status +
  // parsed body), read by bookingCreateFailure.
  if(!res.ok){
    const err = new Error('booking_failed_'+res.status);
    err.status = res.status;
    err.body = await res.json().catch(()=>null);
    throw err;
  }
  return await res.json();
}

// The pass used to print stops[0] → stops[last], so everything between them vanished: a
// Colombo city · Horton Plains · Peliyagoda booking read "Colombo city → Peliyagoda" on the
// customer's own keepsake (owner, 2026-08-09 — "feels wrong and deceptive"). pay.html had
// already refused to do this and fell back to the trip title, reasoning that "picking two of
// its stops would imply the rest don't exist"; the confirmation email lists every stop. This
// shows the real chain instead of either compromise.
// Past two intermediate stops the names stop fitting on one line, so the middle collapses to
// a count — still honest that there is more, which dropping them silently was not.
// Built as DOM nodes rather than an innerHTML template because stop names come straight from
// the URL's ?stops= parameter.
function renderPassRoute(stops, trip){
  const row = document.querySelector('#pass .pass-route');
  if(!row || !stops || !stops.length) return;
  const mid = stops.slice(1,-1);
  const cells = [{ name: stops[0], label: trip?'Trip start':'From', id: 'pass-from' }];
  if(mid.length && mid.length<=2) mid.forEach(s=>cells.push({ name:s, label:'Stop' }));
  else if(mid.length>2) cells.push({ name:'+'+mid.length+' stops', label:'Along the way' });
  if(stops.length>1) cells.push({ name: stops[stops.length-1], label: trip?'Trip end':'To', id:'pass-to', end:true });

  row.innerHTML='';
  // marks the >2-cell layout so the page-local narrow-screen rule can wrap it; a plain
  // two-endpoint pass keeps exactly the shared styling it has always had, here and on pay.html
  row.classList.toggle('is-chain', cells.length>2);
  cells.forEach((c,i)=>{
    if(i){
      const d=document.createElement('div');
      d.className='dash';
      d.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
      row.appendChild(d);
    }
    const el=document.createElement('div');
    el.className='pt';
    if(c.id) el.id=c.id;
    if(c.end) el.style.textAlign='right';
    // two endpoints keep the original 1.5rem; a longer chain gives up some size to stay on one line
    if(cells.length>2) el.style.fontSize='1.15rem';
    el.appendChild(document.createTextNode(c.name));
    const s=document.createElement('small');
    s.textContent=c.label;
    el.appendChild(s);
    row.appendChild(el);
  });
}

// Render the confirmation / boarding pass. Takes the created booking (or null in demo
// mode). Booking creation + payment happen in the pay-btn handler before this runs.
function finalizeBooking(apiBooking){
  payRelease(); // terminal state — the flow moves past payment, so the latch re-arms
  const ref = apiBooking ? apiBooking.reference
    : ('CH-'+Math.random().toString(36).slice(2,7).toUpperCase()+'-'+ (new Date().getFullYear()));
  const first=document.getElementById('f-first').value||'Guest';
  const last=document.getElementById('f-last').value||'';
  /* Past this point a real booking exists, so the confirmation CTA leads with the REFERENCE
     rather than a trip summary — ops can look that up and see everything, which beats any
     description. `ref` falls back to a locally minted code when the API booking is missing
     (see above); that is still the code shown on the customer's pass, so quoting it back is
     the fastest thing they can tell us either way. */
  const confWa=document.getElementById('conf-wa');
  if(confWa) confWa.href=waHrefFor('Hi Ceylon Hop — a question about my booking '+ref+'.');
  const dateText = state.flexDate ? 'To confirm' : (state.date?state.date.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'}):'To confirm');
  const timeText = state.flexTime ? 'To confirm' : (state.dep?fmtTime(state.dep):'To confirm');
  document.getElementById('pass-brand').innerHTML=cmark(26,'var(--accent)')+'<span>Ceylon Hop</span>';
  renderPassRoute(r.stops, isTrip);
  document.getElementById('pass-date').textContent=dateText;
  document.getElementById('pass-time').textContent=timeText;
  document.getElementById('pass-pax').textContent=`${state.ad} adult${state.ad>1?'s':''}${state.ch?', '+state.ch+' '+(state.ch>1?'children':'child'):''}`;
  document.getElementById('pass-pickup').textContent=isTrip ? ((state.svc==='chauffeur')?'Chauffeur-guide':'Private transfer') : (state.locFrom||r.stops[0]);
  document.getElementById('pass-name').textContent=(first+' '+last).trim();
  document.getElementById('pass-paid').textContent=money(calcTotal());
  document.getElementById('pass-ref').textContent=ref;
  // tailor the confirmation concierge note to flexible timing
  const cc=document.getElementById('conf-concierge');
  if(cc){
    let extra='';
    if(state.flexDate||state.flexTime) extra=' Just let us know your exact date & time any time up to 12 hours before — a quick WhatsApp is all it takes.';
    cc.innerHTML=`A Ceylon Hop planner will message you on WhatsApp shortly to confirm your pickup. We work Sri&nbsp;Lanka hours (GMT+5:30) — booked overnight? You’ll hear from us first thing in the morning.${extra}`;
  }
  // "Your seat is booked! ... See you on board" was shown for every product, including a
  // multi-day private trip where there is no seat and no "board".
  const ct=document.getElementById('confirm-title');
  const cl=document.getElementById('confirm-lead');
  if(ct) ct.textContent = isShared ? 'Your seat is booked!' : (isTrip ? 'Your trip is booked!' : 'Your transfer is booked!');
  if(cl){
    const base = isShared
      ? 'We\u2019ve sent your confirmation and pick-up details. Our team will reach out on WhatsApp to lock in your exact pick-up. See you on board \ud83c\udf34'
      : 'We\u2019ve sent your confirmation and pick-up details. Our team will reach out on WhatsApp to lock in your exact pick-up.';
    cl.textContent = base;
  }
  document.getElementById('main-layout').style.display='none';
  document.getElementById('psteps').style.display='none';
  document.getElementById('confirm').style.display='block';
  // The mobile pay-bar + context strip live OUTSIDE #main-layout and are kept visible by the
  // body.js-mbar CSS; force-hide them so the "Continue to secure payment" CTA can't float over
  // — and be re-tapped on — the boarding pass (which would create a duplicate booking/charge).
  ['mbar','mstrip','mbar-scrim'].forEach(id=>{ const el=document.getElementById(id); if(el) el.style.display='none'; });
  document.body.classList.remove('mbar-lock');
  const _confAside=document.querySelector('.layout > aside'); if(_confAside) _confAside.classList.remove('open');
  window.scrollTo({top:0,behavior:'smooth'});
  // funnel: purchase — PROD only, and only for a real backend booking, so sandbox/demo
  // and pre-cutover Pages traffic never pollute GA4 revenue. Deduped later (Phase 1) by ref.
  if (apiBooking && typeof window.chTrack === 'function' && typeof window.chIsProd === 'function' && window.chIsProd()) {
    window.chTrack('purchase', {
      transaction_id: apiBooking.reference,
      currency: 'USD', value: calcTotal(),
      payment_type: state.payPlan
    });
  }
  return true;
}
window.finalizeBooking = finalizeBooking;

// single transfer: pre-select the pick-up time if one was chosen upstream,
// or when a shared ride runs a single fixed departure
if(!isTrip && !state.dep){
  const valid = departuresFor().map(d=>d.time);
  if(timeParam && valid.includes(timeParam)) state.dep = timeParam;
  else if(r.type==='shared' && valid.length===1) state.dep = valid[0];
}

// ---- init ----
buildCal(); renderDeps(); checkWhen();
document.getElementById('ad-n').textContent=state.ad;
document.getElementById('ch-n').textContent=state.ch;
document.getElementById('bg-n').textContent=state.bags;
// single mode: nothing to gate at init beyond the Where step's locations.
if(isCustom){document.getElementById('pay-btn').firstChild.textContent='Confirm request ';}
// Pay-step disclaimer: honest per mode. With a backend the Pay button hands off to the real
// PayHere gateway (sandbox until go-live, which PayHere's own modal flags); ?api=off / no
// backend is the simulated demo flow.
(function(){
  const d=document.getElementById('pay-disclaimer'); if(!d) return;
  d.innerHTML = window.CEYLON_HOP_API
    ? '🔒 Secure checkout — card payments are processed by <b>PayHere</b>, Sri Lanka’s Central Bank-approved payment gateway.'
    : '🔒 Demo checkout — the PayHere step is simulated, no real payment is taken.';
})();
render(); checkWhere(); renderRouteMap();

// funnel: entering the booking flow (Phase 0 analytics)
if (typeof window.chTrack === 'function') {
  window.chTrack('begin_checkout', {
    currency: 'USD', value: calcTotal(),
    mode: isTrip ? 'trip' : (r && r.type === 'shared' ? 'shared' : 'private'),
    route: (r && r.stops) ? r.stops[0] + '→' + r.stops[r.stops.length - 1] : ''
  });
}

// ---- clickable progress + summary edit: jump back to any step reached ----
(function(){
  let maxStep=1;
  const _go=window.goStep;
  var STEP_NAME = { 1: 'when', 2: 'where', 3: isTrip ? 'service' : 'pax', 4: 'payment' };
  window.goStep=function(n){
    var advanced = n > maxStep;                 // only a genuine forward move counts
    maxStep=Math.max(maxStep,n); _go(n); paintSteps();
    if (advanced && typeof window.chTrack === 'function' && STEP_NAME[n]) {
      window.chTrack('checkout_step', { step: n, name: STEP_NAME[n] });
    }
  };
  function paintSteps(){
    document.querySelectorAll('.pstep').forEach(ps=>{
      const s=+ps.dataset.s, can=s<=maxStep;
      ps.classList.toggle('clickable',can);
      ps.setAttribute('aria-disabled', can?'false':'true');
    });
  }
  document.querySelectorAll('.pstep').forEach(ps=>{
    ps.setAttribute('role','button'); ps.tabIndex=0;
    const jump=()=>{ const s=+ps.dataset.s; if(s<=maxStep) window.goStep(s); };
    ps.addEventListener('click',jump);
    ps.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); jump(); } });
  });
  const route=document.getElementById('s-route');
  if(route){ route.style.cursor='pointer'; route.title=isTrip?'Trip & service':'Edit pick-up & drop-off'; route.addEventListener('click',()=>window.goStep(isTrip?3:2)); }
  const rowOf=id=>{ const el=document.getElementById(id); return el?el.closest('.s-row'):null; };
  if(!isTrip){
    // single transfers still edit date & time at the When step
    [rowOf('sum-date'),rowOf('sum-time')].forEach(r=>{ if(r){ r.classList.add('editable'); r.title='Edit date & time'; r.addEventListener('click',()=>window.goStep(1)); } });
  }
  const bagRow=rowOf('sum-bags');
  // travellers/luggage live at step 3 normally, step 4 in the multi-stop journey
  if(bagRow){ bagRow.classList.add('editable'); bagRow.title='Edit travellers'; bagRow.addEventListener('click',()=>window.goStep(isTrip?4:3)); }
  paintSteps();
})();

// multi-stop trips begin at the Service step (Route & Dates were completed on the planner)
// drop the paint-suppression class first so goStep can make panels visible
if(isTrip && window.goStep){ document.documentElement.classList.remove('mode-trip'); window.goStep(3); }
// single transfer: if a VALID date was already chosen on the search page, skip the date
// picker. state.date is null here when the URL date failed the booking-window check above,
// so an out-of-window/stale link falls through to the calendar instead of skipping it.
else if(!isTrip && startParam && state.date && window.goStep) window.goStep(2);

/* ── mobile sticky bar + summary sheet ─────────────────────────────────────────
   Observation-only UI shell (spec 2026-07-09-mobile-booking-sticky-bar-design.md):
   the bar's CTA proxies the ACTIVE panel's real primary button and MutationObservers
   mirror #summary text, so pricing/validation/step logic and analytics stay untouched.
   No JS (or missing markup) ⇒ body.js-mbar never applies ⇒ the legacy mobile layout. */
(function(){
  const bar=document.getElementById('mbar'), scrim=document.getElementById('mbar-scrim'),
        strip=document.getElementById('mstrip'), cta=document.getElementById('mbar-cta'),
        totBtn=document.getElementById('mbar-total'), amt=document.getElementById('mbar-amt'),
        msRoute=document.getElementById('ms-route'), msDate=document.getElementById('ms-date'),
        aside=document.querySelector('.layout > aside'), summary=document.getElementById('summary');
  if(!bar||!scrim||!strip||!cta||!totBtn||!amt||!aside||!summary) return;
  document.body.classList.add('js-mbar');

  // sheet close button (only styled/visible in sheet mode via CSS scoping)
  const closeBtn=document.createElement('button');
  closeBtn.type='button'; closeBtn.className='s-close'; closeBtn.setAttribute('aria-label','Close summary');
  closeBtn.innerHTML='&times;';
  summary.prepend(closeBtn);

  const primaryBtn=()=>document.querySelector('.panel.active .nav-btns .btn');

  // ── CTA proxy: mirror label/accent/disabled of the real button; click forwards to it
  let btnObs=null;
  function syncCta(){
    const b=primaryBtn();
    if(!b){ bar.hidden=true; strip.hidden=true; if(btnObs)btnObs.disconnect(); return; }
    bar.hidden=false; strip.hidden=false;
    cta.textContent=b.textContent;
    cta.disabled=b.disabled;
    const isCta=b.classList.contains('btn-cta');
    cta.classList.toggle('btn-cta',isCta);
    cta.classList.toggle('btn-primary',!isCta);
    if(btnObs) btnObs.disconnect();
    btnObs=new MutationObserver(()=>{ cta.disabled=b.disabled; cta.textContent=b.textContent; });
    btnObs.observe(b,{attributes:true,attributeFilter:['disabled'],childList:true,characterData:true,subtree:true});
  }
  cta.addEventListener('click',()=>{ const b=primaryBtn(); if(b&&!b.disabled) b.click(); });

  // ── info mirror: total into the bar; route + date into the strip
  const txt=id=>{ const el=document.getElementById(id); return el?el.textContent.trim():''; };
  function syncInfo(){
    // The sticky mobile bar mirrors the summary total, so it needs the same count — otherwise
    // on a phone (where the bar is the ONLY total in view) the figure still snaps.
    setNum(amt, txt('sum-total')||'—');
    // …and the same in-flight treatment, read off the source element rather than matched
    // against its words. This observer doesn't watch attributes, but it doesn't need to: the
    // class only ever flips together with the text it mirrors, which is a childList mutation.
    const sumTot=document.getElementById('sum-total');
    amt.classList.toggle('is-pricing', !!sumTot && sumTot.classList.contains('is-pricing'));
    const from=txt('sum-from'), to=txt('sum-to');
    msRoute.textContent=(from&&to&&from!=='—')?from+' → '+to:(txt('sum-name')||'Your trip');
    const d=txt('sum-date');
    msDate.textContent=(d&&d!=='—')?d:'';
  }
  new MutationObserver(syncInfo).observe(summary,{subtree:true,childList:true,characterData:true});
  // panels toggle .active via goStep — watch class flips to rebind the proxy
  new MutationObserver(syncCta).observe(document.getElementById('main-layout'),
    {subtree:true,attributes:true,attributeFilter:['class']});

  // ── bottom sheet open/close
  function openSheet(){ summary.scrollLeft=0; aside.classList.add('open'); scrim.hidden=false; bar.classList.add('sheet-open');
    totBtn.setAttribute('aria-expanded','true'); document.body.classList.add('mbar-lock'); }
  function closeSheet(){ aside.classList.remove('open'); scrim.hidden=true; bar.classList.remove('sheet-open');
    totBtn.setAttribute('aria-expanded','false'); document.body.classList.remove('mbar-lock'); }
  totBtn.addEventListener('click',()=>{ aside.classList.contains('open')?closeSheet():openSheet(); });
  strip.addEventListener('click',openSheet);
  scrim.addEventListener('click',closeSheet);
  closeBtn.addEventListener('click',closeSheet);
  document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&aside.classList.contains('open')) closeSheet(); });

  // ── keyboard: never cover a focused field with the bar
  document.addEventListener('focusin',e=>{
    if(e.target.matches && e.target.matches('.panel input, .panel textarea, .panel select')) bar.classList.add('kb');
  });
  document.addEventListener('focusout',()=>bar.classList.remove('kb'));

  syncCta(); syncInfo();
})();
