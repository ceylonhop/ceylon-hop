/* ============================================================
   CEYLON HOP — booking flow logic
   ============================================================ */
mountWA();
document.getElementById('bk-brand').innerHTML = cmark(30,'var(--accent)') + '<span>Ceylon Hop</span>';
document.getElementById('conf-wa').innerHTML = ICON.wa + ' Message us on WhatsApp';

// Pre-warm the API. The free hosting tier spins the service down when idle and a
// cold boot can take ~30s — firing a health ping on page load means it's usually
// awake by the time the customer reaches payment, so "Pay" doesn't time out.
(function warmApi(){
  const API = window.CEYLON_HOP_API;
  if(!API) return;
  try { fetch(API.replace(/\/$/,'')+'/health', { method:'GET', cache:'no-store' }).catch(()=>{}); } catch(e){}
})();

// put check icons in addon boxes
const CK='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="m5 12 5 5L20 7"/></svg>';
document.querySelectorAll('.addon .box').forEach(b=>b.innerHTML=CK);

// ---- params + state ----
const params=new URLSearchParams(location.search);
const mode=params.get('mode'); // 'private' | 'shared' | 'trip' | null (catalogue route)
let r, isCustom, unit, perVehicle=false, vehicleLabel='', vehicleKey='car', routeNamePrefix='';
let isTrip=false, tripStops=[], tripNights=[], tripDates=[], tripDays=0, tripBase=0, tripEditUrl='';
let routeFromId=null, routeToId=null, vehPrices=null; // for the car→van switch

if(mode==='trip' && window.TRANSFERS){
  const T=window.TRANSFERS;
  isTrip=true;
  tripStops=(params.get('stops')||'').split('|').map(s=>s.trim()).filter(Boolean);
  tripNights=(params.get('nights')||'').split(',').map(n=>parseInt(n)||0);
  tripDates=(params.get('dates')||'').split(',').map(s=>s.trim());
  vehicleKey=params.get('vehicle')||'car';
  vehicleLabel = vehicleKey==='van' ? 'AC van (up to 6)' : 'AC car (up to 3)';
  // Chauffeur is billed by the days the car is kept = trip date span (start→end inclusive).
  // Fall back to per-stop nights, then stop count, when the trip isn't fully dated.
  tripDays=chauffeurDuration().days||tripNights.reduce((a,b)=>a+b,0)||tripStops.length;
  const q=T.tripQuote(tripStops, vehicleKey);
  tripBase=q.total;
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
  const price=parseFloat(params.get('price'))||0;
  vehicleKey=params.get('vehicle')||'car';
  vehicleLabel = vehicleKey==='van' ? 'AC van (up to 6)' : 'AC car (up to 3)';
  // pre-compute both vehicle prices so we can switch car→van when over capacity
  if(T.place(routeFromId) && T.place(routeToId)){
    const q=T.privateQuote(routeFromId, routeToId);
    vehPrices={ car:q.car, van:q.van };
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
  r=getRoute(params.get('id')) || ROUTES[0];
  isCustom = r.price==null;
  unit = isCustom ? 60 : r.price;
}

const VEH_CAP = { car:{pax:3,bags:3}, van:{pax:6,bags:6} };
let maxBags = perVehicle ? (VEH_CAP[vehicleKey]||VEH_CAP.car).bags : 6;
let vehPax = perVehicle ? (VEH_CAP[vehicleKey]||VEH_CAP.car).pax : 6;
// luggage can be dialled past the current vehicle's limit so we can prompt a van
// upgrade (mirrors the passenger over-capacity flow); the van is the hard ceiling
const ABS_MAX_BAGS = perVehicle ? VEH_CAP.van.bags : 6;
const isShared = (!isTrip && r.type==='shared');
const sharedCorridorId = params.get('corridor') || '';

// trip start date (for deposit-window logic + chauffeur day count)
const startParam = params.get('start') || params.get('date');
const timeParam = params.get('time') || '';
const state={
  date: startParam ? new Date(startParam+'T00:00:00') : null,
  dep: null,
  flexDate: false,
  flexTime: false,
  svc: 'private',          // 'private' | 'chauffeur' (trip mode only)
  payPlan: 'full',         // 'full' | 'deposit'
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

// ---- summary setup ----
const typeLabel={loop:'Island loop',shared:'Shared ride',custom:'Private & custom',private:'Private transfer',trip:'Multi-stop trip'};
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
// pre-fill with the route's endpoints so the user can refine to an exact spot
locFrom.value = r.stops[0];
locTo.value   = r.stops[r.stops.length-1];
state.locFrom = locFrom.value;
state.locTo   = locTo.value;
let _rmTimer=null;
let userSetLocation=false; // true once the customer actively picks a pickup/drop-off
function scheduleRouteMap(){ clearTimeout(_rmTimer); _rmTimer=setTimeout(renderRouteMap, 450); }
const acEsc = s => (s||'').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function setGeo(which, geo){ if(which==='from') state.locFromGeo=geo; else state.locToGeo=geo; }

function onLoc(){
  state.locFrom = locFrom.value.trim();
  state.locTo   = locTo.value.trim();
  render(); checkWhere(); scheduleRouteMap();
}

// Pickup/drop-off autocomplete. With the Maps key + Places API we show live
// Google suggestions restricted to Sri Lanka; otherwise we fall back to the
// built-in list of known places so the field still works offline.
function attachAC(input, menu, which){
  let active=-1, els=[], data=[], seq=0;
  const pinIco='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-5.5-7-11a7 7 0 0 1 14 0c0 5.5-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>';
  function close(){ menu.classList.remove('open'); menu.innerHTML=''; active=-1; els=[]; data=[]; }
  function paint(){ els.forEach((it,i)=>it.classList.toggle('active',i===active)); }

  async function choose(i){
    const d=data[i]; if(!d) return;
    userSetLocation=true; // a deliberate selection — now the price may re-price
    input.value=d.label; onLoc(); close();
    if(d.kind==='google' && window.CH_MAP && window.CH_MAP.resolvePick){
      const geo = await window.CH_MAP.resolvePick(d.item);
      setGeo(which, geo);
      if(geo && geo.name){ input.value=geo.name; onLoc(); }
      renderRouteMap();
    } else {
      setGeo(which, null);
      renderRouteMap();
    }
  }

  function renderMenu(){
    if(!data.length){ close(); return; }
    menu.innerHTML = data.map(d=>{
      const sub = d.secondary ? `<small>${acEsc(d.secondary)}</small>` : '';
      return `<div class="ac-item"><span class="ac-ic">${pinIco}</span><span class="ac-tx"><b>${acEsc(d.main||d.label)}</b>${sub}</span></div>`;
    }).join('');
    menu.classList.add('open');
    els=[...menu.querySelectorAll('.ac-item')]; active=-1;
    els.forEach((it,i)=>{
      it.addEventListener('mousedown',e=>{ e.preventDefault(); choose(i); });
      it.addEventListener('mouseenter',()=>{ active=i; paint(); });
    });
  }

  function localList(qs){
    const ql=qs.toLowerCase();
    const matches=(qs?ACPLACES.filter(p=>p.toLowerCase().includes(ql)):ACPLACES.slice(0,6)).slice(0,6);
    return matches.map(m=>({kind:'local', label:m, main:m}));
  }

  async function build(){
    const qs=input.value.trim();
    const mySeq=++seq;
    // live Google suggestions when available; fall back to the offline list
    if(window.CH_MAP && window.CH_MAP.suggest && window.CEYLON_MAPS_KEY && qs.length>=2){
      let sug=[];
      try{ sug=await window.CH_MAP.suggest(qs); }catch(e){ sug=[]; }
      if(mySeq!==seq) return;            // a newer keystroke already fired
      if(sug.length){
        data = sug.slice(0,6).map(s=>({kind:'google', label:s.text, main:s.main, secondary:s.secondary, item:s}));
        renderMenu(); return;
      }
    }
    if(mySeq!==seq) return;
    data = localList(qs);
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
    svg=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Map from ${a.name} to ${b.name}">${island}${line}${pin(pa,'#0a7d6f','A',a.name)}${pin(pb,'#e8623a','B',b.name)}</svg>`;
  }

  // distance/time bar — shows the REAL Google route once it resolves, falling
  // back to the offline straight-line estimate while loading / if routing fails.
  const truck='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 13h18M5 13V8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v5M6 17v2M18 17v2"/></svg>';
  const info='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/></svg>';
  const minsToText=mins=>{ const h=Math.floor(mins/60), m=mins%60; if(h<=0) return `${Math.max(5,m)} min`; return m>=8?`${h}h ${m}m`:`${h}h`; };
  const setBar=(km,durText)=>{
    const meta = km!=null
      ? `${truck}<span><b>${km} km</b> · about ${durText} drive</span>`
      : `${info}<span>Distance confirmed on request</span>`;
    const bar=document.getElementById('rm-bar');
    if(bar) bar.innerHTML =
      `<div class="rm-route"><span>${short(fromName)}</span><span class="ar">→</span><span>${short(toName)}</span></div>`+
      `<div class="rm-meta">${meta}</div>`;
  };
  const localKm = T ? T.kmBetween(fromName, toName) : null;
  setBar(localKm, localKm!=null ? T.durationText(localKm) : null);

  // Clean Google map (route line, no panel/markers) with a loading state; SVG fallback.
  const canvas=document.getElementById('rm-canvas');
  const showFallback=()=>{ canvas.innerHTML = svg; if(!svg) host.hidden=true; };
  if(window.CH_MAP && window.CH_MAP.renderRoute){
    const pFrom = state.locFromGeo && state.locFromGeo.lat!=null ? {lat:state.locFromGeo.lat, lng:state.locFromGeo.lng} : fromName;
    const pTo   = state.locToGeo   && state.locToGeo.lat!=null   ? {lat:state.locToGeo.lat,   lng:state.locToGeo.lng}   : toName;
    window.CH_MAP.renderRoute(canvas, [pFrom, pTo], {
      onFail: showFallback,
      onRoute: ({km, durationMin}) => {
        setBar(km, durationMin!=null ? minsToText(durationMin) : (localKm!=null?T.durationText(localKm):null));
        // re-price single private transfers from the REAL driving distance so the
        // summary total always matches the route actually shown on the map.
        if(km!=null && userSetLocation && perVehicle && !isTrip && T && T.legPrice){
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
  document.getElementById('s1-title').textContent='Your trip & how you’ll travel';
  document.getElementById('s1-sub').textContent='Review your route and choose how you’d like to travel. Your dates carry over from the planner — we’ll fine-tune every stop and time with you after booking.';
  // render the route summary with an edit link back to the planner
  const tr=document.getElementById('trip-route');
  tr.style.display='block';
  const fmtLeg=(iso)=>{ if(!iso) return ''; const d=new Date(iso+'T00:00:00'); return isNaN(d)?'':d.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'}); };
  let html='<div class="tr-list">';
  tripStops.forEach((s,i)=>{
    const cls=i===0?'first':(i===tripStops.length-1?'last':'');
    const nights = (i<tripStops.length-1 && tripNights[i]>0) ? `${tripNights[i]} night${tripNights[i]>1?'s':''}` : '';
    html+=`<div class="tr-stop ${cls}"><span class="dot"></span><span class="tr-name">${s}</span>${nights?`<span class="nt">${nights}</span>`:''}</div>`;
    if(i<tripStops.length-1){
      const dt=fmtLeg(tripDates[i]);
      html+=`<div class="tr-wire"><span class="tw-line"></span>`+
            (dt?`<span class="tw-date"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>${dt}</span>`
                :`<span class="tw-date flex">date flexible</span>`)+
            `</div>`;
    }
  });
  html+='</div>';
  const editUrl='plan.html?'+new URLSearchParams({stops:tripStops.join('|'),nights:tripNights.join(','),dates:tripDates.join(','),pax:String(state.ad+state.ch),vehicle:vehicleKey,start:(startParam||'')}).toString();
  // booking sits after the planner's “When” step, so Back / “Add your dates” should land on the
  // dates step (not the route-building view); “Edit this itinerary” still opens the route view
  const datesUrl=editUrl+'&step=dates';
  // chauffeur status (missing-dates prompt or day-count confirmation) lives INSIDE this card,
  // so the itinerary and the service status read as a single consolidated box (filled by render)
  html+='<div id="chauffeur-extra" class="cx-inline" style="display:none"></div>';
  html+=`<div class="tr-foot"><button type="button" class="tr-edit" onclick="location.href='${editUrl}'"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg> Edit this itinerary</button></div>`;
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
  // show the private vs chauffeur chooser — but a single-day trip can't "keep the car for days",
  // so the chauffeur-guide option is removed when the whole trip fits in one day
  const svcCh=document.getElementById('svc-chooser');
  svcCh.style.display='grid';
  if(isSingleDayTrip()){
    state.svc='private';
    const chBtn=svcCh.querySelector('.svc[data-svc="chauffeur"]'); if(chBtn) chBtn.style.display='none';
    svcCh.style.gridTemplateColumns='1fr';
    svcCh.querySelectorAll('.svc').forEach(b=>b.classList.toggle('on', b.dataset.svc==='private'));
  }
  // adjust the progress label
  const lbl=document.getElementById('lbl-s1'); if(lbl) lbl.textContent='Trip & service';

  // Dates are chosen per leg in the planner, so the standalone “When” step is dropped here.
  // Show the whole multi-stop journey as one 5-step bar — Route · Dates were done on the
  // planner, then Service · Travelers · Payment happen here — so travellers always see where
  // they are and what’s left.
  (function buildJourney(){
    // NOTE: in the markup panel 1 is the standalone "When" step and panel 2 is the
    // "Where" step that we repurpose into the trip itinerary + service chooser.
    const tripPanel=document.querySelector('.panel[data-panel="2"]');   // Trip & service (repurposed Where)
    const whenPanel=document.querySelector('.panel[data-panel="1"]');   // When (dropped — dates come from the planner)
    const tvPanel=document.querySelector('.panel[data-panel="3"]');     // Travelers
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
      const carSvg='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l1.5-4.5A2 2 0 0 1 8.4 7h7.2a2 2 0 0 1 1.9 1.5L19 13M5 13h14m-14 0v4m0 0v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1m10 0v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1m0 0v-4M7 17h.01M17 17h.01"/></svg>';
      const vanSvg='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 14V7a2 2 0 0 1 2-2h9v9M14 9h3l3 3.5V14M3 14h17"/><circle cx="7" cy="17" r="1.6"/><circle cx="17" cy="17" r="1.6"/></svg>';
      const tickSvg='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 7"/></svg>';
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
            const q=window.TRANSFERS.tripQuote(tripStops, key); tripBase=q.total; unit=tripBase; r.price=tripBase;
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
        '<div class="pstep" data-s="4"><span class="dot">4</span><span class="lbl">Payment</span></div>';
      // the two leading nodes jump back to the planner (Route / Dates live there)
      steps.querySelectorAll('.planner-step').forEach(ps=>{ ps.title='Back to the planner'; ps.addEventListener('click',()=>{ location.href=editUrl; }); });
    }
    // rewire navigation to the journey numbering (n1’s click listener is made trip-aware where it’s bound)
    const n4=document.getElementById('n4'); if(n4) n4.setAttribute('onclick','goStep(4)'); // (parked) Travelers → Payment
    if(tvBack) tvBack.setAttribute('onclick','goStep(3)');                                  // (parked) Travelers ← Service
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

// ===== SHARED RIDE: fixed route + fixed daily schedule, sold per seat =====
// A shared seat is not a private/custom transfer: the corridor and the departure
// times are set, so we don't ask for locations or an arbitrary pick-up time. We
// confirm the ride, then collect a date + a scheduled departure + how many seats.
if(!isTrip && r.type==='shared'){
  const fmtT=function(t){var p=String(t).split(':');var H=+p[0];return (((H+11)%12)+1)+':'+p[1]+' '+(H<12?'am':'pm');};
  const times=(r.times&&r.times.length)?r.times:['07:30'];
  const timesTxt=times.map(fmtT).join(' & ');
  const ICO_CLOCK='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
  const ICO_SEAT='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 11V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v5m-8 0h12a2 2 0 0 1 2 2v3M5 11a2 2 0 0 0-2 2v3m0 0h18"/></svg>';
  const ICO_INFO='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/></svg>';

  // STEP 1 — confirm the fixed ride (no editable pick-up/drop-off)
  const locWrap=document.getElementById('loc-wrap'); if(locWrap) locWrap.style.display='none';
  const pvtNote=document.getElementById('pvt-note'); if(pvtNote) pvtNote.style.display='none';
  const s1t=document.getElementById('s1-title'); if(s1t) s1t.textContent='Your shared ride';
  const s1s=document.getElementById('s1-sub'); if(s1s) s1s.textContent='A reserved seat on our daily service along this route. Pick-up and drop-off are at set meeting points.';
  const card=document.createElement('div'); card.className='shared-route';
  card.innerHTML=
    '<div class="sr-line"><span class="sr-pin from"></span><div><span class="sr-lbl">Board at</span><b>'+r.stops[0]+'</b></div></div>'+
    '<div class="sr-wire"></div>'+
    '<div class="sr-line"><span class="sr-pin to"></span><div><span class="sr-lbl">Drop-off</span><b>'+r.stops[r.stops.length-1]+'</b></div></div>'+
    '<div class="sr-foot">'+
      '<span class="sr-fact">'+ICO_CLOCK+'<span>Departs <b>'+timesTxt+'</b> \u00b7 daily</span></span>'+
      '<span class="sr-fact">'+ICO_SEAT+'<span><b>'+money(r.price)+'</b> per seat</span></span>'+
    '</div>'+
    '<p class="sr-note">'+ICO_INFO+'Exact pick-up &amp; drop-off are set meeting points along the route \u2014 our team confirms them with you after you book.</p>';
  if(locWrap) locWrap.after(card);

  // STEP 2 — pick a date + a SCHEDULED departure (no "any time", no decide-later time)
  const s2t=document.getElementById('s2-title'); if(s2t) s2t.textContent='When are you travelling?';
  const s2s=document.getElementById('s2-sub'); if(s2s) s2s.textContent='Pick your travel date \u2014 our shared service runs once daily.';
  const depLabel=document.getElementById('dep-label'); if(depLabel) depLabel.textContent='Departure';
  const dateLabel=document.getElementById('date-label'); if(dateLabel) dateLabel.textContent='Travel date';
  const ftChk=document.getElementById('flex-time-chk'); if(ftChk){ var ftl=ftChk.closest('.flex-chk'); if(ftl) ftl.style.display='none'; }
  const fb=document.getElementById('flex-banner-tx'); if(fb) fb.innerHTML='<b>Not sure of your date yet?</b> Reserve now and lock in your travel date any time up to <b>12 hours before</b> \u2014 seats are subject to availability.';

  // STEP 3 — seats, not vehicle/luggage upgrades
  const tvPanel=document.querySelector('.panel[data-panel="3"]');
  if(tvPanel){
    var h3=tvPanel.querySelector('h2'); if(h3) h3.textContent='How many seats?';
    var sub3=tvPanel.querySelector('.sub'); if(sub3) sub3.textContent='Reserve a seat for each traveller. Every traveller gets one large bag free \u2014 extra bags are $10 each.';
  }

  // progress labels: this isn't a "pick-up & drop-off" or "travelers" journey
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
let viewMonth = state.date ? new Date(state.date.getFullYear(),state.date.getMonth(),1) : (()=>{const d=new Date();return new Date(d.getFullYear(),d.getMonth(),1);})();
const today=new Date();today.setHours(0,0,0,0);
const MN=['January','February','March','April','May','June','July','August','September','October','November','December'];

function buildCal(){
  const y=viewMonth.getFullYear(), m=viewMonth.getMonth();
  const first=new Date(y,m,1).getDay();
  const days=new Date(y,m+1,0).getDate();
  const prevDisabled = (y===today.getFullYear()&&m===today.getMonth());
  let html=`<div class="cal-head">
    <button ${prevDisabled?'disabled style=opacity:.3':''} onclick="calMove(-1)">‹</button>
    <b>${MN[m]} ${y}</b>
    <button onclick="calMove(1)">›</button></div>
    <div class="cal-grid">`;
  ['S','M','T','W','T','F','S'].forEach(d=>html+=`<div class="dow">${d}</div>`);
  for(let i=0;i<first;i++)html+='<div></div>';
  for(let d=1;d<=days;d++){
    const date=new Date(y,m,d);
    const off = date<today;
    const sel = state.date && date.getTime()===state.date.getTime();
    html+=`<div class="cal-day ${off?'off':''} ${sel?'sel':''}" ${off?'':`onclick="pickDate(${y},${m},${d})"`}>${d}</div>`;
  }
  html+='</div>';
  document.getElementById('cal').innerHTML=html;
}
window.calMove=function(dir){viewMonth=new Date(viewMonth.getFullYear(),viewMonth.getMonth()+dir,1);buildCal();};

window.pickDate=function(y,m,d){
  state.date=new Date(y,m,d); state.flexDate=false;
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
    hint.textContent='Reserve a seat on a daily departure.';
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
    : (state.flexTime ? 'No time locked in — we’ll confirm your departure with you later.' : 'Reserve a seat on a daily departure.');
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
  state.svc=svc;
  document.querySelectorAll('.svc').forEach(b=>b.classList.toggle('on', b.dataset.svc===svc));
  // chauffeur is always deposit; private trips default full
  state.payPlan = svc==='chauffeur' ? 'deposit' : state.payPlan;
  render();
};
function renderRepriceNote(){
  let el=document.getElementById('reprice-note');
  const p=state.pendingReprice;
  if(!p){ if(el) el.remove(); return; }
  const newPrice = p.prices[vehicleKey];
  if(!el){
    el=document.createElement('div'); el.id='reprice-note'; el.className='reprice-note';
    const wrap=document.getElementById('loc-wrap');
    if(wrap && wrap.parentNode) wrap.parentNode.insertBefore(el, wrap.nextSibling);
    else { const panel=document.querySelector('[data-panel="2"]'); if(panel) panel.appendChild(el); }
  }
  el.innerHTML =
    '<b>Heads up — this trip is longer than the standard route.</b> '+
    'Your exact stops add about '+p.extraKm+' km, so the fixed price updates from '+
    money(unit)+' to '+money(newPrice)+'.'+
    '<div class="rn-actions">'+
      '<button type="button" class="btn btn-primary btn-sm" onclick="acceptReprice()">Got it — use '+money(newPrice)+'</button>'+
      '<button type="button" class="rn-change" onclick="dismissReprice()">Change location</button>'+
    '</div>';
}
window.acceptReprice=function(){
  const p=state.pendingReprice; if(!p) return;
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
    '.reprice-note .rn-change{background:none;border:0;color:#8a5a12;text-decoration:underline;cursor:pointer;font:inherit;padding:0}';
  document.head.appendChild(s);
})();
function checkWhere(){
  const haveWhere = isTrip ? true : (state.locFrom && state.locTo);
  document.getElementById('n1').disabled = !haveWhere || !!state.pendingReprice;
}
// For shared rides a date is required before continuing — there's only one
// departure per day so we need to know which day. Private transfers can
// proceed without a date (confirmed later on WhatsApp).
function checkWhen(){
  const n2=document.getElementById('n2');
  if(!n2) return;
  if(isShared){
    const ok = !!(state.date && !state.flexDate);
    n2.disabled = !ok;
    n2.style.opacity = ok ? '' : '.45';
    n2.style.cursor = ok ? '' : 'not-allowed';
  } else {
    n2.disabled = false;
    n2.style.opacity = '';
    n2.style.cursor = '';
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
const addonPrices={sightseeing:10,luggage:5,front:8,flex:12};
const addonNames={sightseeing:'Sightseeing stops (3h)',luggage:'Luggage rack',front:'Child seat',flex:'Flexi ticket'};

window.payMethod=function(el){document.querySelectorAll('.pm').forEach(x=>x.classList.remove('on'));el.classList.add('on');};
window.setPayPlan=function(plan){ state.payPlan=plan; document.querySelectorAll('.pc-opt').forEach(o=>o.classList.toggle('on',o.dataset.plan===plan)); render();
  if(typeof window.chTrack==='function') window.chTrack('add_payment_info',{payment_type:plan,currency:'USD',value:calcTotal()}); };

// chauffeur-guide fee + deposit helpers
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
  // chauffeur is billed per day from the trip START plus the nights at each stop, so we only
  // need a start anchor to price it — intermediate legs may stay flexible and still quote
  return !!((tripDates[0]||'').trim() || (startParam||'').trim());
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
// GL-4 (owner decision 2026-07-02): chauffeur distance is billed in bulk across the
// whole trip — buffered travel km plus a minimum km for every idle (no-travel) day —
// at the per-km rate, with NO per-leg minimum fares. Mirrors api/src/quote/chauffeur.ts.
function chauffeurDistanceCharge(){
  const days = Math.max(1, tripDays);
  const idleDays = Math.max(0, days - Math.max(0, tripStops.length-1));
  const idleKm = idleDays * (vehicleKey==='van' ? 150 : 100);
  const bulkKm = Math.round(window.TRANSFERS.tripQuote(tripStops, vehicleKey).totalKm * 1.10) + idleKm;
  return Math.round(bulkKm * (vehicleKey==='van' ? 0.83 : 0.46));
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

// deposit applies for chauffeur (always) or a private trip booked far ahead and the user opts in
function isDeposit(){
  // once the server has priced it, deposit-ness is simply "charged now < full total"
  if(serverQuote) return serverQuote.dueNow < serverQuote.total - 0.005;
  if(isTrip && state.svc==='chauffeur') return true;
  if(state.payPlan==='deposit' && daysUntilStart()>30) return true;
  return false;
}

// ---- totals + render ----
function calcTotal(){
  if(serverQuote) return serverQuote.total;
  // chauffeur-guide trips use the engine's bulk model: day rate × days + ONE distance
  // charge across the whole trip — not the per-leg fares (which carry minimum floors)
  let t = chauffeurFee()>0
    ? chauffeurFee() + chauffeurDistanceCharge()
    : (perVehicle ? unit : (unit*state.ad + unit*0.6*state.ch));
  if(isShared){ const free=Math.max(1,state.ad+state.ch); t += Math.max(0,state.bags-free)*10; }
  state.addons.forEach(a=>t+=addonPrices[a]);
  return t;
}
const DEPOSIT_PCT = (window.TRANSFERS && window.TRANSFERS.DEPOSIT_PCT) || 0.10;
const DEPOSIT_CAP = (window.TRANSFERS && window.TRANSFERS.DEPOSIT_CAP) || 50; // USD
function depositDue(){ return Math.min(Math.round(calcTotal()*DEPOSIT_PCT), DEPOSIT_CAP); }
function amountDueNow(){ if(serverQuote) return serverQuote.dueNow; return isDeposit() ? depositDue() : calcTotal(); }
function money(n){return '$'+ (Math.round(n*100)/100).toFixed(2).replace(/\.00$/,'');}

// price of an AC van for this journey (single transfer or whole trip)
function vanPrice(){
  if(isTrip) return window.TRANSFERS.tripQuote(tripStops,'van').total;
  if(vehPrices) return vehPrices.van;
  return null;
}
// price of an AC car for this journey (single transfer or whole trip)
function carPrice(){
  if(isTrip) return window.TRANSFERS.tripQuote(tripStops,'car').total;
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
function render(){
  renderRepriceNote();
  // live route from the actual entered locations
  const _sf=document.getElementById('sum-from'); if(_sf) _sf.textContent = state.locFrom || r.stops[0];
  const _stp=document.getElementById('sum-to'); if(_stp) _stp.textContent = state.locTo || r.stops[r.stops.length-1];
  // keep the summary title in sync with the entered route (single transfers)
  const _sn=document.getElementById('sum-name');
  if(_sn && routeNamePrefix && !isTrip){
    _sn.textContent = `${routeNamePrefix} · ${state.locFrom||r.stops[0]} → ${state.locTo||r.stops[r.stops.length-1]}`;
  }
  document.getElementById('sum-date').textContent = state.flexDate ? 'To confirm (12h before)' : (state.date ? state.date.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}) : '—');
  document.getElementById('sum-time').textContent = state.flexTime ? 'To confirm (12h before)' : (state.dep ? fmtTime(state.dep) : '—');
  document.getElementById('sum-bags').textContent = state.bags>0 ? (state.bags+' large bag'+(state.bags>1?'s':'')) : 'No large bags';

  // service-chooser tags (trip mode)
  if(isTrip){
    const pvt=document.getElementById('svc-private-tag'), chf=document.getElementById('svc-chauffeur-tag');
    if(pvt) pvt.textContent='Pay in full today';
    if(chf) chf.textContent='+ $'+window.TRANSFERS.CHAUFFEUR_DAY_FEE+'/day · pay deposit';

    // chauffeur is billed per day, so it needs every leg dated before we can quote it
    const cx=document.getElementById('chauffeur-extra');
    const datesOK=tripDatesComplete();
    if(cx){
      if(state.svc==='chauffeur' && !datesOK){
        cx.className='cx-inline warn'; cx.style.display='block';
        cx.innerHTML='<div class="cx-h"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg><b>Add your start date to price this</b></div>'+
          '<p>A driver-guide is charged per day, so we can only quote it once we know when your trip begins. Set your start date in the planner, then come back to see your rate.</p>'+
          '<button type="button" class="cx-btn" onclick="location.href=\''+tripEditUrl+'\'">Add your dates →</button>';
      } else if(state.svc==='chauffeur'){
        const days=chauffeurDayList();
        cx.className='cx-inline ok'; cx.style.display='block';
        cx.innerHTML='<div class="cx-h"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4-3.9-3.8 5.4-.8z"/></svg><b>Your car &amp; driver-guide stays with you all '+days.length+' day'+(days.length>1?'s':'')+'</b></div>'+
          '<p>Same friendly face the whole trip — your driver-guide&rsquo;s daily rate is included in your trip total.</p>';
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
        const vanP = vanPrice();
        const reason = (paxOver && bagsOver)
          ? `${pax} travellers and ${state.bags} bags won’t fit an AC car`
          : (paxOver
              ? `${pax} travellers won’t fit an AC car (up to ${VEH_CAP.car.pax})`
              : `${state.bags} large bags won’t fit an AC car (up to ${VEH_CAP.car.bags})`);
        note.innerHTML=`<b>${reason}.</b> An AC van seats up to ${VEH_CAP.van.pax} with room for ${VEH_CAP.van.bags} bags.`+
          `<button type="button" class="cap-switch" onclick="switchToVan()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 13h18M5 13V8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v5M6 17v2M18 17v2"/></svg> Switch to AC van${vanP?` · ${money(vanP)}`:''}</button>`;
      } else {
        note.textContent=`That’s over an AC van’s limit too (up to ${VEH_CAP.van.pax} travellers · ${VEH_CAP.van.bags} bags) — message us and we’ll arrange a larger vehicle.`;
      }
    } else if(perVehicle && vehicleKey==='van' && pax<=VEH_CAP.car.pax && state.bags<=VEH_CAP.car.bags){
      // party now fits an AC car again — recommend the cheaper vehicle to save money
      const carP=carPrice(), vanP=(vehPrices?vehPrices.van:unit);
      const save=(carP!=null && vanP!=null)?vanP-carP:null;
      if(carP!=null && save!=null && save>0){
        note.className='cap-note show ok';
        note.innerHTML=`<b>An AC car fits your group</b> — ${pax} traveller${pax>1?'s':''}${state.bags>0?` · ${state.bags} bag${state.bags>1?'s':''}`:''}. Downgrade and save.`+
          `<button type="button" class="cap-switch" onclick="switchToCar()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13l2-5.5A2 2 0 0 1 6.9 6h10.2a2 2 0 0 1 1.9 1.5L21 13v4a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1H6v1a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M3 13h18"/></svg> Switch to AC car · save ${money(save)}</button>`;
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
  // block progressing past Travelers while over the vehicle's seat OR luggage limit —
  // we can't accommodate it, so the traveller must upgrade or message us first
  const overCap = perVehicle && (paxOver || bagsOver);
  // over-capacity blocks Continue — dim it so the disabled state is visible (mirrors n2)
  const n4=document.getElementById('n4');
  if(n4){ n4.disabled = overCap; n4.style.opacity = overCap ? '.45' : ''; n4.style.cursor = overCap ? 'not-allowed' : ''; }
  // "sightseeing stops" extra only makes sense on a single point-to-point private transfer
  const extras=document.getElementById('extras-block');
  if(extras) extras.style.display = (!isTrip && perVehicle) ? 'block' : 'none';
  const chrow=document.getElementById('sum-chrow');
  if(perVehicle){
    document.getElementById('sum-adlabel').textContent = isTrip ? (vehicleKey==='van'?'Private AC van · all legs':'Private AC car · all legs') : vehicleLabel;
    // a priced chauffeur trip shows the bulk distance charge here (the day rate is its own row)
    document.getElementById('sum-adamt').textContent=money(chauffeurFee()>0 ? chauffeurDistanceCharge() : unit);
    chrow.style.display='flex';
    document.getElementById('sum-chlabel').textContent='Travelers';
    document.getElementById('sum-chamt').textContent=`${state.ad+state.ch} · included`;
  } else {
    document.getElementById('sum-adlabel').textContent= isShared ? `Seats × ${state.ad}` : `Adults × ${state.ad}`;
    document.getElementById('sum-adamt').textContent=money(unit*state.ad);
    if(!isShared && state.ch>0){chrow.style.display='flex';document.getElementById('sum-chlabel').textContent=`Children × ${state.ch}`;document.getElementById('sum-chamt').textContent=money(unit*0.6*state.ch);}
    else chrow.style.display='none';
  }
  let addonHtml='';
  if(chauffeurFee()>0){ addonHtml+=`<div class="s-row"><span>Chauffeur-guide · ${tripDays} days</span><b>${money(chauffeurFee())}</b></div>`; }
  if(isShared){ const free=Math.max(1,state.ad+state.ch); const xb=Math.max(0,state.bags-free); if(xb>0){ addonHtml+=`<div class="s-row"><span>Extra bag${xb>1?'s':''} × ${xb}</span><b>${money(xb*10)}</b></div>`; } }
  state.addons.forEach(a=>{addonHtml+=`<div class="s-row"><span>${addonNames[a]}</span><b>${money(addonPrices[a])}</b></div>`;});
  document.getElementById('sum-addons').innerHTML=addonHtml;
  document.getElementById('sum-total').textContent=money(calcTotal());

  // deposit messaging in the summary
  let depEl=document.getElementById('s-deposit');
  if(!depEl){ depEl=document.createElement('div'); depEl.id='s-deposit'; depEl.className='s-deposit'; document.getElementById('sum-total').closest('.s-body').appendChild(depEl); }
  if(isDeposit()){
    depEl.style.display='block';
    depEl.innerHTML = (isTrip && state.svc==='chauffeur')
      ? `Secure your chauffeur-guide with a <b>${money(amountDueNow())} deposit</b> today · balance before you travel.`
      : `Booking early — pay a <b>${money(amountDueNow())} deposit</b> now, balance due before arrival.`;
  } else { depEl.style.display='none'; }

  // cancellation language adapts to the service (24h transfers · 10 days chauffeur-guide)
  const perk=document.getElementById('perk-cancel');
  if(perk) perk.innerHTML=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 12 5 5L20 7"/></svg> ${cancelText()}`;
  const paySub=document.getElementById('pay-sub');
  if(paySub) paySub.textContent=`Pay securely to confirm. ${cancelText()}.`;

  // clarity note about how the service works (Where step)
  const pvtNote=document.getElementById('pvt-note'), pvtTx=document.getElementById('pvt-note-tx');
  if(pvtNote && pvtTx){
    if(isTrip && state.svc==='chauffeur'){
      pvtTx.innerHTML='<b>One car &amp; driver-guide for the whole trip.</b> Your chauffeur-guide stays with you from start to finish — same friendly face every day, flexible stops along the way.';
    } else if(isTrip){
      pvtTx.innerHTML='<b>Door-to-door pick-ups &amp; drop-offs, every leg.</b> Each leg of your trip is a private transfer booked fresh, so you may not have the exact same car or driver every day.';
    } else {
      pvtTx.innerHTML='<b>It’s a door-to-door pick-up &amp; drop-off.</b> A private transfer covers this one journey — we pick you up at your spot and drop you at your destination.';
    }
  }

  // payment step: due-now row + early-booking pay choice
  const payDue=document.getElementById('pay-due');
  if(payDue){
    payDue.innerHTML = `<span class="lbl">Due now${isDeposit()?' (deposit)':''}<b>${(isTrip&&state.svc==='chauffeur')?'Chauffeur-guide':(isTrip?'Private transfer':r.name)}</b></span>`+
      `<span class="amt">${money(amountDueNow())}${isDeposit()?`<small>of ${money(calcTotal())} total</small>`:''}</span>`;
  }
  // show the full/deposit choice only for a private trip booked >30 days out
  let choice=document.getElementById('pay-choice');
  const showChoice = isTrip && state.svc!=='chauffeur' && daysUntilStart()>30;
  if(showChoice && !choice){
    choice=document.createElement('div'); choice.id='pay-choice'; choice.className='pay-choice';
    document.getElementById('pay-due').after(choice);
  }
  if(choice){
    choice.style.display = showChoice ? 'grid' : 'none';
    if(showChoice){
      choice.innerHTML=`
        <label class="pc-opt ${state.payPlan==='full'?'on':''}" data-plan="full"><input type="radio" name="pp" ${state.payPlan==='full'?'checked':''} onchange="setPayPlan('full')"><span><b>Pay in full today</b><small>${money(calcTotal())} — done and dusted</small></span></label>
        <label class="pc-opt ${state.payPlan==='deposit'?'on':''}" data-plan="deposit"><input type="radio" name="pp" ${state.payPlan==='deposit'?'checked':''} onchange="setPayPlan('deposit')"><span><b>Pay ${Math.round(DEPOSIT_PCT*100)}% deposit now</b><small>${money(depositDue())} now, balance before arrival</small></span></label>`;
    }
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
};

// ---- payment ----
document.getElementById('pay-btn').addEventListener('click',async ()=>{
  // validate the lead traveller's contact details before payment
  const first=document.getElementById('f-first'), last=document.getElementById('f-last'),
        email=document.getElementById('f-email'), wa=document.getElementById('f-wa');
  const derr=document.getElementById('details-error');
  [first,last,email,wa].forEach(el=>el.classList.remove('inp-bad'));
  if(derr) derr.hidden=true;
  const fail=(el,msg)=>{ el.classList.add('inp-bad'); if(derr){derr.textContent=msg; derr.hidden=false;} el.focus(); };
  const emailRe=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if(!first.value.trim()) return fail(first,'Please add the lead traveller’s first name.');
  if(!last.value.trim()) return fail(last,'Please add the lead traveller’s last name.');
  if(!emailRe.test(email.value.trim())) return fail(email,'Enter a valid email so we can send your confirmation.');
  if(wa.value.replace(/[^\d]/g,'').length<7) return fail(wa,'Enter a valid WhatsApp number, including country code.');
  if(!document.getElementById('agree').checked){
    document.getElementById('agree').closest('.addon').style.borderColor='var(--tomato)';
    return;
  }

  runPayment();
});

// Runs the actual payment after the contact form passes validation. Every outcome
// (working / failed / cancelled) is surfaced INSIDE the PayHere overlay so the
// customer always sees what happened where they expect it — never a stray note on
// the form. The overlay opens immediately so clicking Pay always shows feedback.
async function runPayment(){
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
  catch(e){ clearTimeout(slow); return phShowEnd('error','We couldn’t start your booking just now — please try again in a moment.'); }
  clearTimeout(slow);
  if(!booking){ return simulatePayThenConfirm(null); }

  // Adopt the server's authoritative price so the overlay, PayHere and confirmation all show
  // exactly what is charged — not the wizard's browser-distance estimate.
  adoptServerQuote(booking);
  const _amt=document.getElementById('ph-amt'); if(_amt) _amt.textContent=money(amountDueNow());

  // Ask the API for checkout params; if it's real PayHere, open the hosted checkout.
  let checkout=null;
  try{
    const res = await fetch(API.replace(/\/$/,'')+'/bookings/'+booking.id+'/checkout',{method:'POST'});
    if(res.ok) checkout = await res.json();
  }catch(e){}

  if(checkout && checkout.checkoutUrl && /payhere\.lk/.test(checkout.checkoutUrl) && window.payhere){
    document.getElementById('ph-msg').textContent='Opening secure payment…';
    return startPayHere(checkout, booking);
  }
  // Backend without a real gateway (fake adapter) → simulated interstitial, real reference.
  return simulatePayThenConfirm(booking);
}

// ---- payment overlay states (loading / problem) ----
function phShowLoading(msg){
  const amt=document.getElementById('ph-amt'); if(amt){ amt.style.display=''; amt.textContent=money(amountDueNow()); }
  document.getElementById('ph-spin').style.display='block';
  const ico=document.getElementById('ph-ico'); if(ico) ico.hidden=true;
  const sub=document.getElementById('ph-sub'); if(sub) sub.style.display='';
  const sec=document.getElementById('ph-secure'); if(sec) sec.style.display='';
  const m=document.getElementById('ph-msg'); m.className='ph-msg'; m.textContent=msg||'Processing your payment securely…';
  document.getElementById('ph-actions').hidden=true;
  document.getElementById('ph-overlay').classList.add('show');
}
// kind: 'error' (red, something went wrong) | 'cancelled' (amber, user backed out)
function phShowEnd(kind, msg){
  document.getElementById('ph-spin').style.display='none';
  const amt=document.getElementById('ph-amt'); if(amt) amt.style.display='none';
  const sub=document.getElementById('ph-sub'); if(sub) sub.style.display='none';
  const sec=document.getElementById('ph-secure'); if(sec) sec.style.display='none';
  const ico=document.getElementById('ph-ico');
  if(ico){
    ico.hidden=false; ico.className='ph-ico '+(kind==='error'?'err':'warn');
    ico.innerHTML = kind==='error'
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/></svg>';
  }
  const m=document.getElementById('ph-msg'); m.className='ph-msg ph-msg-big'; m.textContent=msg;
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

function showPayFailed(){
  if(typeof window.chTrack==='function') window.chTrack('payment_failed',{});
  phShowEnd('error','Your payment didn’t go through — no charge was made. Please try again.');
}
function showPayDismissed(){
  if(typeof window.chTrack==='function') window.chTrack('payment_dismissed',{});
  phShowEnd('cancelled','Payment cancelled — your booking isn’t confirmed yet. You can try again when you’re ready.');
}

// M7 — when a backend is configured, create a real booking and use its reference.
// Handles all three flows: single transfer, multi-stop trip, and shared seat.
// Returns null only when no backend is configured (demo mode, default site behaviour);
// when a backend IS set, a failed save throws so the caller shows an error instead of a
// fake confirmation.
async function createApiBooking(){
  const API = window.CEYLON_HOP_API;
  if(!API) return null;
  const customer = {
    firstName: document.getElementById('f-first').value.trim(),
    lastName: document.getElementById('f-last').value.trim(),
    email: document.getElementById('f-email').value.trim(),
    whatsapp: document.getElementById('f-wa').value.trim(),
    country: document.getElementById('f-country').value
  };
  // the price the customer was shown (minor units) — the backend records this, so the
  // confirmation, the DB and the eventual charge all agree.
  const quotedTotal = calcTotal() > 0 ? Math.round(calcTotal() * 100) : undefined;
  let endpoint, payload;
  if(isTrip){
    endpoint = '/bookings/trip';
    payload = {
      stops: tripStops,
      nights: tripNights,
      dates: tripDates.some(Boolean) ? tripDates : undefined,
      pax: state.ad + state.ch,
      vehicleType: (vehicleKey==='van') ? 'van' : 'car',
      serviceType: state.svc,
      customer,
      quotedTotal,
      days: (state.svc==='chauffeur') ? tripDays : undefined,
      driverNights: (state.svc==='chauffeur') ? Math.max(0, tripDays-1) : undefined
    };
  } else if(isShared){
    endpoint = '/bookings/shared';
    payload = {
      corridorId: sharedCorridorId || undefined,
      from: state.locFrom || r.stops[0],
      to: state.locTo || r.stops[r.stops.length-1],
      date: (state.flexDate || !state.date) ? undefined : state.date.toISOString().slice(0,10),
      time: state.dep || undefined,
      seats: state.ad + state.ch,
      customer,
      quotedTotal
    };
  } else {
    endpoint = '/bookings/single';
    payload = {
      from: state.locFrom || r.stops[0],
      to: state.locTo || r.stops[r.stops.length-1],
      date: (state.flexDate || !state.date) ? undefined : state.date.toISOString().slice(0,10),
      time: (state.flexTime || !state.dep) ? undefined : state.dep,
      vehicleType: (vehicleKey==='van') ? 'van' : 'car',
      adults: state.ad, children: state.ch, bags: state.bags,
      customer,
      quotedTotal,
      // selected add-ons use the engine's ExtraCode values, priced server-side (GL-4)
      extras: state.addons.size ? Array.from(state.addons) : undefined
    };
  }
  // A backend IS configured, so a failure here must surface — never fake a confirmation.
  // (Returning null is reserved for "no backend configured" = intentional demo mode.)
  const ctrl = new AbortController();
  const timer = setTimeout(()=>ctrl.abort(), 45000); // allow for a free-tier cold start
  let res;
  try{
    res = await fetch(API.replace(/\/$/,'')+endpoint, {
      method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload), signal: ctrl.signal
    });
  } finally { clearTimeout(timer); }
  if(!res.ok) throw new Error('booking_failed_'+res.status);
  return await res.json();
}

// Render the confirmation / boarding pass. Takes the created booking (or null in demo
// mode). Booking creation + payment happen in the pay-btn handler before this runs.
function finalizeBooking(apiBooking){
  const ref = apiBooking ? apiBooking.reference
    : ('CH-'+Math.random().toString(36).slice(2,7).toUpperCase()+'-'+ (new Date().getFullYear()));
  const first=document.getElementById('f-first').value||'Guest';
  const last=document.getElementById('f-last').value||'';
  const dateText = state.flexDate ? 'To confirm' : (state.date?state.date.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'}):'To confirm');
  const timeText = state.flexTime ? 'To confirm' : (state.dep?fmtTime(state.dep):'To confirm');
  document.getElementById('pass-brand').innerHTML=cmark(26,'var(--accent)')+'<span>Ceylon Hop</span>';
  document.getElementById('pass-from').innerHTML=`${r.stops[0]}<small>${isTrip?'Trip start':'From'}</small>`;
  document.getElementById('pass-to').innerHTML=`${r.stops[r.stops.length-1]}<small>${isTrip?'Trip end':'To'}</small>`;
  document.getElementById('pass-date').textContent=dateText;
  document.getElementById('pass-time').textContent=timeText;
  document.getElementById('pass-pax').textContent=`${state.ad} adult${state.ad>1?'s':''}${state.ch?', '+state.ch+' child':''}`;
  document.getElementById('pass-pickup').textContent=isTrip ? ((state.svc==='chauffeur')?'Chauffeur-guide':'Private transfer') : (state.locFrom||r.stops[0]);
  document.getElementById('pass-name').textContent=(first+' '+last).trim();
  document.getElementById('pass-paid').textContent= isDeposit()? `${money(amountDueNow())} dep.` : money(calcTotal());
  document.getElementById('pass-ref').textContent=ref;
  // tailor the confirmation concierge note to flexible/deposit
  const cc=document.getElementById('conf-concierge');
  if(cc){
    let extra='';
    if(state.flexDate||state.flexTime) extra=' Just let us know your exact date & time any time up to 12 hours before — a quick WhatsApp is all it takes.';
    if(isDeposit()) extra+=' We’ll send a secure link for the balance closer to your travel date.';
    cc.innerHTML=`A Ceylon Hop planner will message you on WhatsApp shortly to confirm your pickup. We work Sri&nbsp;Lanka hours (GMT+5:30) — booked overnight? You’ll hear from us first thing in the morning.${extra}`;
  }
  document.getElementById('main-layout').style.display='none';
  document.getElementById('psteps').style.display='none';
  document.getElementById('confirm').style.display='block';
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
  // travelers/luggage live at step 3 normally, step 4 in the multi-stop journey
  if(bagRow){ bagRow.classList.add('editable'); bagRow.title='Edit travelers'; bagRow.addEventListener('click',()=>window.goStep(isTrip?4:3)); }
  paintSteps();
})();

// multi-stop trips begin at the Service step (Route & Dates were completed on the planner)
// drop the paint-suppression class first so goStep can make panels visible
if(isTrip && window.goStep){ document.documentElement.classList.remove('mode-trip'); window.goStep(3); }
// single transfer: if date was already chosen on the search page, skip the date picker
else if(!isTrip && startParam && window.goStep) window.goStep(2);