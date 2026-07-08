/* ============================================================
   CEYLON HOP — multi-stop itinerary planner (leg-based)
   Each itinerary card is ONE private transfer leg:
     • pick-up + drop-off locations (Google Places autocomplete)
     • an optional date
     • a distance Google calculates & fills in automatically
   Hotels are the traveller's own. Quote = sum of private legs.
   ============================================================ */
initChrome({ active:'plan.html', footerCta:false, navCta:false, breadcrumbs:[['Home','index.html'],['Trip planner']] });
mountWA();

const T = window.TRANSFERS;

// ---- Geo lookup: PLACES + popular extras (approx coords) ----
const GEO = {};
T.PLACES.forEach(p => { GEO[norm(p.name)] = { label:p.name, lat:p.lat, lng:p.lng, id:p.id }; });
const EXTRA = [
  ['Colombo','Colombo city',6.93,79.85],
  ['Dambulla','Dambulla',7.86,80.65],
  ['Habarana','Habarana',8.03,80.75],
  ['Polonnaruwa','Polonnaruwa',7.94,81.00],
  ['Udawalawe','Udawalawe',6.44,80.89],
  ['Tissamaharama','Tissamaharama',6.28,81.29],
  ['Tangalle','Tangalle',6.02,80.79],
  ['Unawatuna','Unawatuna',6.01,80.25],
  ['Nilaveli','Nilaveli',8.70,81.19],
  ['Pasikudah','Pasikudah',7.92,81.56],
  ['Hatton','Hatton',6.89,80.60],
  ["Adam's Peak","Adam's Peak",6.81,80.50],
  ['Wilpattu','Wilpattu',8.45,80.05],
  ['Kalpitiya','Kalpitiya',8.23,79.77],
  ['Jaffna','Jaffna',9.66,80.02],
  ['Haputale','Haputale',6.77,80.96],
  ['Kitulgala','Kitulgala',6.99,80.41]
];
EXTRA.forEach(([key,label,lat,lng]) => { const k=norm(key); if(!GEO[k]) GEO[k]={label,lat,lng,id:null}; });

function norm(s){ return (s||'').toLowerCase().replace(/\(.*?\)/g,'').replace(/[^a-z]/g,'').trim(); }
function words(s){ return (s||'').toLowerCase().replace(/\(.*?\)/g,' ').split(/[^a-z0-9]+/).filter(w=>w.length>1); }
function countrylessKey(s){ return words(s).filter(w=>w!=='sri' && w!=='lanka').join(''); }

// resolve a typed name to a geo point (fuzzy) — stands in for a Google Places match
function resolve(name){
  const k = norm(name);
  if(!k) return null;
  if(GEO[k]) return GEO[k];
  const ck = countrylessKey(name);
  if(ck && ck!==k && GEO[ck]) return GEO[ck];
  if(k.includes('airport') || k.includes('cmb')) return GEO[norm('Colombo Airport')];
  if(words(name).length===1){
    for(const key in GEO){ if(key.includes(k) || k.includes(key)) return GEO[key]; }
  }
  return null;
}

// haversine fallback for places that are not in the shared transfer table
function roadKm(a,b){
  const sharedKm = T.kmBetween(a.id || a.label, b.id || b.label);
  if(sharedKm!=null) return sharedKm;
  const R=6371,toR=d=>d*Math.PI/180;
  const dLat=toR(b.lat-a.lat),dLng=toR(b.lng-a.lng);
  const s=Math.sin(dLat/2)**2+Math.cos(toR(a.lat))*Math.cos(toR(b.lat))*Math.sin(dLng/2)**2;
  return Math.round(2*R*Math.asin(Math.sqrt(s))*1.35);
}
const liveKmCache = new Map();
const liveKmPending = new Set();
const liveKmWaiters = new Map();
function liveKmKey(a,b){ return norm(a)+'|'+norm(b); }
function legKm(a,b){
  const g1=resolve(a), g2=resolve(b);
  if(g1&&g2) return roadKm(g1,g2);
  const key=liveKmKey(a,b);
  return liveKmCache.has(key) ? liveKmCache.get(key) : null;
}
function requestLiveKm(a,b,cb){
  if(!a || !b || !window.CH_MAP || !window.CH_MAP.routeStats) return;
  if(resolve(a)&&resolve(b)) return;
  const key=liveKmKey(a,b);
  if(typeof cb==='function'){
    if(!liveKmWaiters.has(key)) liveKmWaiters.set(key, []);
    liveKmWaiters.get(key).push(cb);
  }
  if(liveKmCache.has(key)){
    const km=liveKmCache.get(key);
    if(km!=null && typeof cb==='function') cb(km);
    return;
  }
  if(liveKmPending.has(key)) return;
  liveKmPending.add(key);
  window.CH_MAP.routeStats([a,b]).then(stats=>{
    liveKmPending.delete(key);
    const km=stats && stats.km ? stats.km : null;
    liveKmCache.set(key, km);
    const waiters=liveKmWaiters.get(key)||[];
    liveKmWaiters.delete(key);
    if(km!=null) waiters.forEach(fn=>fn(km));
  }).catch(()=>{
    liveKmPending.delete(key);
    liveKmCache.set(key, null);
    liveKmWaiters.delete(key);
  });
}
function durationText(km){
  return T.durationText ? T.durationText(km) : `${km} km`;
}
function drivingMinutes(km){ return Math.round((km/42)*60); }
function minutesText(min){
  const h=Math.floor(min/60), m=Math.round(min%60);
  if(h<=0) return `${Math.max(20,m)} min`;
  return m>=8 ? `${h}h ${m}m` : `${h}h`;
}
function legPrice(km, veh){
  return T.legPrice(km, veh);
}
function minLegPrice(veh){
  return veh==='van' ? 50 : 29;
}
function guidePriceRange(totalPrice, veh){
  const lo=Math.max(minLegPrice(veh), Math.floor(totalPrice/50)*50);
  const hi=Math.ceil((totalPrice+1)/50)*50;
  return lo===hi ? `~$${lo}` : `$${lo}–$${hi}`;
}

// ---- state: an ordered list of transfer legs ----
const params=new URLSearchParams(location.search);
const startStops = (params.get('stops')||'Colombo Airport (CMB)|Sigiriya|Ella').split('|').map(s=>s.trim()).filter(Boolean);
// Optional per-stop nights (e.g. from a tour hand-off). Index i = nights at stops[i];
// the final stop is a departure point and carries no nights.
const nightsParam = (params.get('nights')||'').split(',').map(n=>parseInt(n,10)||0);
function buildLegs(stops, nights){
  const hasNights = nights && nights.some(n=>n>0);
  if(stops.length<2) return [{ type:'transfer', from:stops[0]||'', to:'', date:null, nights:1 }];
  const N = i => (nights && nights[i]>0) ? nights[i] : 0;
  const legs=[];
  // a night at the origin becomes a leading stay so the reviewed day-count is preserved
  if(hasNights && N(0)>0) legs.push({ type:'stay', from:stops[0], to:stops[0], date:null, nights:N(0) });
  for(let i=0;i<stops.length-1;i++){
    legs.push({ type:'transfer', from:stops[i], to:stops[i+1], date:null, nights:1 });
    // stay at each intermediate destination (skip the final stop — you depart from there)
    if(hasNights && i+1<stops.length-1 && N(i+1)>0) legs.push({ type:'stay', from:stops[i+1], to:stops[i+1], date:null, nights:N(i+1) });
  }
  return legs;
}
// per-day rate when a chauffeur-guide stays with the guest (no intercity travel)
const DAY_FEE = (window.TRANSFERS && window.TRANSFERS.CHAUFFEUR_DAY_FEE) || 55;
const state = {
  pax: Math.min(6, Math.max(1, parseInt(params.get('pax'))||2)),
  vehicle: params.get('vehicle')==='van' ? 'van' : 'car',
  legs: buildLegs(startStops, nightsParam),
  hideTemplates: params.has('stops') || params.has('nights') || params.has('dates')
};
// Restore the travel dates the customer already chose: the booking step passes them back
// as `dates`, where dates[k] is the k-th transfer leg (in order). We deliberately do NOT
// auto-fill from `start` — a tour hand-off carries a default start the customer never
// picked, so legs stay blank and "Add your dates" means what it says (fixes tour auto-dates).
const datesParam = (params.get('dates')||'').split(',');
let _tIdx = 0;
state.legs.forEach(l=>{
  if(l.type!=='transfer') return;
  const ds = (datesParam[_tIdx++]||'').trim();
  if(ds){ const d=new Date(ds+'T00:00:00'); if(!isNaN(d.getTime())) l.date=d; }
});
if(state.pax>3) state.vehicle='van';

// ---- hybrid place search: known Ceylon Hop places first, popular extras second ----
function escAttr(s){
  return String(s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function closePlaceMenus(except){
  document.querySelectorAll('.place-menu').forEach(m=>{ if(m!==except) m.remove(); });
}
function placeSourceLabel(source){
  if(source==='google') return 'Google';
  return source==='known' ? 'Popular Route' : 'Popular place';
}
function googlePlaceSuggestions(q, localItems){
  const text=q.trim();
  const localStrong = localItems.some(p=>p.source==='known' && norm(p.label)===norm(text));
  const localEnough = localItems.length >= 3 && words(text).length <= 1;
  if(!window.CH_MAP || !window.CH_MAP.suggest || !window.CEYLON_MAPS_KEY || text.length<2 || localStrong || localEnough){
    return Promise.resolve([]);
  }
  return window.CH_MAP.suggest(text).then(list => (list||[]).map(s=>({
    label:s.text || s.main,
    main:s.main || s.text,
    secondary:s.secondary,
    source:'google',
    id:null,
    item:s
  }))).catch(()=>[]);
}
function mergePlaceSuggestions(localItems, googleItems){
  const seen=new Set();
  const out=[];
  function add(p){
    const key=norm(p.label || p.main);
    if(!key || seen.has(key)) return;
    seen.add(key); out.push(p);
  }
  localItems.forEach(add);
  googleItems.forEach(add);
  return out.slice(0,8);
}
let placeMenuSeq=0;
function renderPlaceMenu(input){
  const q=input.value.trim();
  const seq=++placeMenuSeq;
  closePlaceMenus();
  const baseItems=(T.placeSuggestions?T.placeSuggestions(q,6):[]).filter(Boolean);
  const paint=(items)=>{
    if(seq!==placeMenuSeq) return;
    closePlaceMenus();
    if(!items.length) return;
    const menu=document.createElement('div');
    menu.className='place-menu';
    menu.setAttribute('role','listbox');
    menu.innerHTML=items.map((p,idx)=>`<button type="button" class="place-option${idx===0?' hi':''}" role="option" data-place="${escAttr(p.label)}"><span>${escAttr(p.main||p.label)}</span><small>${placeSourceLabel(p.source)}</small>${p.secondary?`<em>${escAttr(p.secondary)}</em>`:''}</button>`).join('');
    menu.addEventListener('mousedown',e=>e.preventDefault());
    menu.addEventListener('click',async e=>{
      const opt=e.target.closest('.place-option'); if(!opt) return;
      const picked=items[[...menu.querySelectorAll('.place-option')].indexOf(opt)];
      input.value=opt.dataset.place||'';
      closePlaceMenus();
      if(picked && picked.source==='google' && window.CH_MAP && window.CH_MAP.resolvePick){
        const geo=await window.CH_MAP.resolvePick(picked.item);
        if(geo && geo.name) input.value=geo.name;
      }
      input.dispatchEvent(new Event('input',{bubbles:true}));
      input.dispatchEvent(new Event('change',{bubbles:true}));
    });
    input.parentNode.appendChild(menu);
  };
  paint(mergePlaceSuggestions(baseItems, []));
  googlePlaceSuggestions(q, baseItems).then(googleItems=>{
    if(seq!==placeMenuSeq || !googleItems.length) return;
    paint(mergePlaceSuggestions(baseItems, googleItems));
  });
}
function wirePlaceSearch(input){
  input.setAttribute('autocomplete','off');
  input.addEventListener('focus',()=>renderPlaceMenu(input));
  input.addEventListener('input',()=>renderPlaceMenu(input));
  input.addEventListener('blur',()=>setTimeout(()=>closePlaceMenus(),120));
  input.addEventListener('keydown',e=>{
    const menu=input.parentNode.querySelector('.place-menu');
    if(e.key==='Escape'){ closePlaceMenus(); return; }
    if(e.key==='Enter' && menu){
      const first=menu.querySelector('.place-option');
      if(first){ e.preventDefault(); first.click(); }
    }
  });
}

// ---- top controls ---- (dates are collected in the separate “When” step)
const paxSel=document.getElementById('pax');
paxSel.value=String(state.pax);
paxSel.addEventListener('change',()=>{
  state.pax=+paxSel.value;
  if(state.pax>3) state.vehicle='van';
  render();
});
document.getElementById('veh').addEventListener('click',e=>{
  const b=e.target.closest('.veh-btn'); if(!b || b.disabled) return;
  if(b.dataset.veh===state.vehicle) return;
  state.vehicle=b.dataset.veh;
  refreshVehiclePricing();
});
function syncVehBtns(){
  const lockCar = state.pax>3;
  document.querySelectorAll('.veh-btn').forEach(x=>{
    const isCar = x.dataset.veh==='car';
    x.disabled = isCar && lockCar;
    x.classList.toggle('on', x.dataset.veh===state.vehicle && !(isCar&&lockCar));
  });
  const note=document.getElementById('veh-note'), tx=document.getElementById('veh-note-tx');
  if(note&&tx){
    if(lockCar){ note.style.display='flex'; tx.innerHTML=`<b>${state.pax} travellers need a van.</b> A private AC car seats up to 3 — we’ve set you up with an AC van (up to 6).`; }
    else { note.style.display='none'; }
  }
}
function syncTemplateStrip(){
  const strip=document.getElementById('tpl-strip');
  if(strip) strip.hidden=!!state.hideTemplates;
}
function markRouteCustomized(){
  state.hideTemplates=true;
  syncTemplateStrip();
}

// ---- add another transfer leg (pre-fills pick-up from the previous drop-off) ----
document.getElementById('add-stop').addEventListener('click',()=>{
  if(state.legs.length>=10) return;
  markRouteCustomized();
  const prevTo = state.legs.length ? state.legs[state.legs.length-1].to : '';
  state.legs.push({ type:'transfer', from:prevTo, to:'', date:null, nights:1 });
  render();
  const inputs=document.querySelectorAll('#rail .leg-card');
  if(inputs.length){
    const last=inputs[inputs.length-1];
    const target = prevTo ? last.querySelector('.leg-to') : last.querySelector('.leg-from');
    if(target) target.focus();
  }
});

// ---- add a stay (no intercity travel; in chauffeur mode the car waits with you) ----
const addStayBtn=document.getElementById('add-stay');
if(addStayBtn) addStayBtn.addEventListener('click',()=>{
  if(state.legs.length>=10) return;
  markRouteCustomized();
  const prevTo = state.legs.length ? state.legs[state.legs.length-1].to : '';
  state.legs.push({ type:'stay', from:prevTo, to:prevTo, date:null, nights:1 });
  render();
  const cards=document.querySelectorAll('#rail .leg-card');
  if(cards.length){ const f=cards[cards.length-1].querySelector('.leg-from'); if(f && !f.value) f.focus(); }
});

// ---- helpers ----
function fmtISO(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function addDays(d,n){ const x=new Date(d); x.setDate(x.getDate()+n); return x; }
function fmtDate(d){ return d.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'}); }
function money(n){ return '$'+Math.round(n); }

// route as an ordered list of {place, nights}, merging consecutive same places.
// A stay adds nights to its place; a transfer adds its from/to as 0-night points.
function routeSeq(){
  const seq=[];
  const addPlace=(place,nights)=>{
    if(!place) return;
    if(seq.length && norm(seq[seq.length-1].place)===norm(place)) seq[seq.length-1].nights+=nights;
    else seq.push({ place, nights });
  };
  state.legs.forEach(l=>{
    if(l.type==='stay'){ addPlace(l.from||'', l.nights||0); }
    else { addPlace(l.from||'',0); addPlace(l.to||'',0); }
  });
  return seq;
}
// like routeSeq, but also returns a date per WIRE (the gap between two places).
// Each transfer leg's date lands on the wire it creates, so dates set in the
// “When” step flow through to the booking itinerary in the right place.
function routeSeqDetailed(){
  const seq=[]; const wires=[];
  const addPlace=(place,nights)=>{
    if(!place) return false;
    if(seq.length && norm(seq[seq.length-1].place)===norm(place)){ seq[seq.length-1].nights+=nights; return false; }
    seq.push({ place, nights }); return true;
  };
  state.legs.forEach(l=>{
    if(l.type==='stay'){ addPlace(l.from||'', l.nights||0); }
    else {
      addPlace(l.from||'',0);
      addPlace(l.to||'',0);
      if(seq.length>=2) wires[seq.length-2] = l.date ? fmtISO(l.date) : '';
    }
  });
  const dates=[]; for(let i=0;i<Math.max(0,seq.length-1);i++) dates.push(wires[i]||'');
  return { seq, dates };
}
function syncPlanUrl(){
  const { seq, dates } = routeSeqDetailed();
  if(seq.length){
    const p=new URLSearchParams(location.search);
    p.set('stops', seq.map(s=>s.place).join('|'));
    p.set('nights', seq.map(s=>s.nights).join(','));
    p.set('dates', dates.join(','));
    p.set('pax', String(state.pax));
    p.set('vehicle', state.vehicle);
    const datesWrap=document.getElementById('dates-wrap');
    if(datesWrap && !datesWrap.hidden) p.set('step','dates');
    else p.delete('step');
    history.replaceState(null, '', location.pathname+'?'+p.toString());
  }
}
// ordered list of place names along the whole route
function points(){ return routeSeq().map(s=>s.place); }

const PIN_GOOGLE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-5.5-7-11a7 7 0 0 1 14 0c0 5.5-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>';
const CAR_ICO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 13l1.5-4.5A2 2 0 0 1 8.4 7h7.2a2 2 0 0 1 1.9 1.5L19 13M5 13h14m-14 0v4m14-4v4M7 17h.01M17 17h.01"/></svg>';

function distHtml(km, price){
  if(km==null){
    return `<span class="lm-hint">Pick both points — Google fills in distance &amp; price</span>`;
  }
  return `<span class="lm-dist"><b>${km} km</b> · ~${durationText(km)}</span>`+
         `<span class="lm-src" title="Distance &amp; time estimated by Google">Google distance</span>`+
         `<span class="lm-sep">·</span>`+
         `<span class="lm-price">from <b>${money(price)}</b></span>`;
}

// remove any portaled date popovers left over from the previous render
function clearLegDatePops(){ document.querySelectorAll('.leg-dp-pop').forEach(p=>p.remove()); }
function enhanceLegDate(input){
  if(window.enhanceDate){
    window.enhanceDate(input);
    const pop=document.body.lastElementChild;
    if(pop && pop.classList && pop.classList.contains('dp-pop')) pop.classList.add('leg-dp-pop');
  }
}

// ---- render ----
let dragEl=null;
function render(){
  const rail=document.getElementById('rail');
  clearLegDatePops();
  rail.innerHTML='';
  const n=state.legs.length;

  state.legs.forEach((leg,i)=>{
    const isStay = leg.type==='stay';
    const km=!isStay?legKm(leg.from,leg.to):null;
    if(!isStay && km==null && leg.from && leg.to) requestLiveKm(leg.from, leg.to, ()=>render());
    const price=km!=null?legPrice(km,state.vehicle):null;
    const badge = isStay ? `Stay ${i+1}` : `Leg ${i+1}`;

    // body differs by type: a transfer has pick-up→drop-off + distance;
    // a stay has one place and a nights count (no intercity travel). Dates
    // are collected in a later step, so cards carry no date field here.

    const transferBody = `
        <div class="route-block">
          <div class="rb-rail"><span class="rb-pin from"></span><span class="rb-wire"></span><span class="rb-pin to"></span></div>
          <div class="rb-fields">
            <div class="rb-field"><label>Pick-up</label>
              <input class="leg-from place-input" required placeholder="Choose a place…" value="${escAttr(leg.from)}"></div>
            <div class="rb-divider"><button type="button" class="rb-swap" aria-label="Swap pick-up and drop-off" title="Swap"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3"/></svg></button></div>
            <div class="rb-field"><label>Drop-off</label>
              <input class="leg-to place-input" required placeholder="Where to next…" value="${escAttr(leg.to)}"></div>
          </div>
        </div>`;

    const stayBody = `
        <div class="loc-row stay">
          <span class="pin stay"></span>
          <div class="loc-f"><label>Staying in</label>
            <input class="leg-from place-input" required placeholder="Where you’re based…" value="${escAttr(leg.from)}"></div>
        </div>
        <div class="leg-foot">
          <div class="stay-nights-ctrl">
            <span class="lbl">Nights here</span>
            <span class="ctrls"><button type="button" class="sn-dn" ${(leg.nights||0)<=0?'disabled':''} aria-label="Fewer nights">–</button><b>${leg.nights||0}</b><button type="button" class="sn-up" aria-label="More nights">+</button></span>
          </div>
        </div>
        <div class="stay-note">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
          <span><b>No intercity travel.</b> With a <b>chauffeur-guide</b>, your car &amp; driver stay with you — at your disposal for local trips (about ${money(DAY_FEE)}/day). With <b>point-to-point transfers</b>, there’s no car needed on these days.</span>
        </div>`;

    const wrap=document.createElement('div');
    wrap.className='leg'+(isStay?' is-stay':'');
    wrap.dataset.i=i;
    wrap.innerHTML=`
      <div class="leg-card" draggable="true" data-i="${i}">
        <div class="leg-head">
          <span class="drag" title="Drag to reorder"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg></span>
          <span class="leg-badge ${isStay?'stay':''}">${badge}</span>
          <div class="leg-head-right">
            ${isStay?'':`<div class="leg-meta ${km!=null?'on':''}" data-dist>${distHtml(km,price)}</div>`}
          <button class="leg-rm ${n<=1?'hide':''}" title="Remove this card" aria-label="Remove this card"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
          </div>
        </div>
        ${isStay?stayBody:transferBody}
      </div>`;
    rail.appendChild(wrap);

    const card=wrap.querySelector('.leg-card');
    const fromI=wrap.querySelector('.leg-from'), toI=wrap.querySelector('.leg-to');
    [fromI,toI].forEach(input=>{ if(input) wirePlaceSearch(input); });

    if(!isStay){
      // transfer wiring — live distance recompute without re-render (keeps focus)
      const distEl=wrap.querySelector('[data-dist]');
      function recompute(){
        markRouteCustomized();
        state.legs[i].from=fromI.value; state.legs[i].to=toI.value;
        const k=legKm(fromI.value,toI.value);
        const pr=k!=null?legPrice(k,state.vehicle):null;
        distEl.innerHTML=distHtml(k,pr);
        distEl.classList.toggle('on', k!=null);
        if(k==null && fromI.value && toI.value){
          requestLiveKm(fromI.value, toI.value, liveK=>{
            if(state.legs[i] && state.legs[i].from===fromI.value && state.legs[i].to===toI.value){
              const livePrice=legPrice(liveK,state.vehicle);
              distEl.innerHTML=distHtml(liveK,livePrice);
              distEl.classList.add('on');
              updateSummary();
            }
          });
        }
        updateSummary();
      }
      fromI.addEventListener('input',recompute);
      toI.addEventListener('input',recompute);
      fromI.addEventListener('change',()=>{ markRouteCustomized(); state.legs[i].from=fromI.value; render(); });
      toI.addEventListener('change',()=>{ markRouteCustomized(); state.legs[i].to=toI.value; render(); });
      const swap=wrap.querySelector('.rb-swap');
      if(swap) swap.addEventListener('click',()=>{ markRouteCustomized(); const t=state.legs[i].from; state.legs[i].from=state.legs[i].to; state.legs[i].to=t; render(); });
    } else {
      // stay wiring — one place (mirrors to drop-off so chaining continues)
      fromI.addEventListener('input',()=>{ markRouteCustomized(); state.legs[i].from=fromI.value; state.legs[i].to=fromI.value; updateSummary(); });
      fromI.addEventListener('change',()=>{ markRouteCustomized(); state.legs[i].from=fromI.value; state.legs[i].to=fromI.value; render(); });
      const up=wrap.querySelector('.sn-up'), dn=wrap.querySelector('.sn-dn');
      if(up) up.addEventListener('click',()=>{ markRouteCustomized(); state.legs[i].nights=(state.legs[i].nights||0)+1; render(); });
      if(dn) dn.addEventListener('click',()=>{ if((state.legs[i].nights||0)>0){ markRouteCustomized(); state.legs[i].nights--; render(); } });
    }

    // remove
    wrap.querySelector('.leg-rm').addEventListener('click',()=>{ if(state.legs.length>1){ markRouteCustomized(); state.legs.splice(i,1); render(); } });

    // drag to reorder
    card.addEventListener('dragstart',e=>{ markRouteCustomized(); dragEl=wrap; card.classList.add('dragging'); e.dataTransfer.effectAllowed='move'; });
    card.addEventListener('dragend',()=>{ card.classList.remove('dragging'); commitOrder(); dragEl=null; });

    // connector between cards
    if(i<n-1){
      const nextStay = state.legs[i+1] && state.legs[i+1].type==='stay';
      const conn=document.createElement('div');
      conn.className='leg-gap';
      conn.innerHTML=`<span class="lg-line"></span><span class="lg-tx">${nextStay||isStay?'·':'then continue…'}</span><span class="lg-line"></span>`;
      rail.appendChild(conn);
    }
  });

  rail.ondragover=e=>{
    e.preventDefault();
    if(!dragEl) return;
    const cards=[...rail.querySelectorAll('.leg')].filter(s=>s!==dragEl);
    const after=cards.find(s=>{ const b=s.getBoundingClientRect(); return e.clientY < b.top+b.height/2; });
    if(after) rail.insertBefore(dragEl, after);
    else rail.appendChild(dragEl);
  };

  updateSummary();
  const transfers=state.legs.filter(l=>l.type!=='stay').length;
  const stays=state.legs.filter(l=>l.type==='stay').length;
  document.getElementById('stop-count').textContent =
    `${transfers} transfer${transfers!==1?'s':''}${stays?` · ${stays} stay${stays!==1?'s':''}`:''}`;
  const reorderHint=document.getElementById('reorder-hint');
  if(reorderHint) reorderHint.hidden=state.legs.length<=1;
  syncVehBtns();
  syncTemplateStrip();
  syncPlanUrl();
}

function refreshVehiclePricing(){
  document.querySelectorAll('#rail .leg').forEach(el=>{
    const i=+el.dataset.i;
    const leg=state.legs[i];
    if(!leg || leg.type==='stay') return;
    const distEl=el.querySelector('[data-dist]');
    if(!distEl) return;
    const km=legKm(leg.from,leg.to);
    const price=km!=null?legPrice(km,state.vehicle):null;
    distEl.innerHTML=distHtml(km,price);
    distEl.classList.toggle('on', km!=null);
  });
  updateSummary({ refreshMap:false });
  syncVehBtns();
  syncPlanUrl();
}

// rebuild leg order from the DOM after a drag
function commitOrder(){
  const els=[...document.querySelectorAll('#rail .leg')];
  state.legs=els.map(el=>state.legs[+el.dataset.i]);
  render();
}

// every transfer needs a pick-up AND drop-off; a stay needs its place —
// returns the index of the first incomplete leg, or -1 when all are filled
function firstIncompleteLeg(){
  for(let i=0;i<state.legs.length;i++){
    const l=state.legs[i];
    if(l.type==='stay'){ if(!(l.from||'').trim()) return i; }
    else if(!(l.from||'').trim() || !(l.to||'').trim()) return i;
  }
  return -1;
}
// highlight an incomplete leg card, scroll it into view and focus the empty field
function flagIncompleteLeg(i){
  const card=document.querySelector(`#rail .leg-card[data-i="${i}"]`);
  if(!card) return;
  card.classList.add('leg-bad');
  const y=card.getBoundingClientRect().top+window.scrollY-90;
  window.scrollTo({top:y,behavior:'smooth'});
  const f=card.querySelector('.leg-from'), t=card.querySelector('.leg-to');
  const target=(f&&!f.value.trim())?f:(t&&!t.value.trim()?t:f);
  if(target) target.focus({preventScroll:true});
  setTimeout(()=>card.classList.remove('leg-bad'),2200);
}

function updateSummary(opts={}){
  const refreshMap = opts.refreshMap !== false;
  let totalKm=0, totalPrice=0, resolvedLegs=0, transferLegs=0, stayNights=0;
  state.legs.forEach(l=>{
    if(l.type==='stay'){ stayNights+=(l.nights||0); return; }
    transferLegs++;
    const km=legKm(l.from,l.to);
    if(km!=null){ totalKm+=km; totalPrice+=legPrice(km,state.vehicle); resolvedLegs++; }
  });

  const dated=state.legs.filter(l=>l.date).map(l=>l.date).sort((a,b)=>a-b);
  document.getElementById('sum-dates').textContent = dated.length
    ? `${dated[0].toLocaleDateString('en-GB',{day:'numeric',month:'short'})}${dated.length>1?' – '+dated[dated.length-1].toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}):', '+dated[0].getFullYear()} · ${state.pax} traveller${state.pax>1?'s':''}`
    : `Dates flexible · ${state.pax} traveller${state.pax>1?'s':''}`;

  const seq=routeSeq();
  document.getElementById('st-stops').textContent=seq.length;
  document.getElementById('st-nights').textContent = stayNights ? `${stayNights} night${stayNights!==1?'s':''}` : 'None';
  document.getElementById('st-legs').textContent=transferLegs;
  document.getElementById('st-drive').textContent=totalKm?`${totalKm} km · ${durationText(totalKm)}`:'On request';
  document.getElementById('sum-route').innerHTML =
    seq.map(s=>`<span>${s.place||'…'}${s.nights?` <small class="rt-n">${s.nights}n</small>`:''}</span>`).join('<span class="hop"> → </span>');

  if(refreshMap) renderMap();

  const amt=document.getElementById('sum-amt');
  if(totalPrice>0 && resolvedLegs>=1){
    amt.textContent = guidePriceRange(totalPrice, state.vehicle);
  } else {
    amt.textContent='~$—';
  }

  // gate the “Next” CTA until every leg has a pick-up AND drop-off (we can't price a blank leg)
  const incompleteLeg = firstIncompleteLeg()>=0;
  const reqBtn=document.getElementById('request-btn');
  if(reqBtn){ reqBtn.classList.toggle('cta-disabled', incompleteLeg); reqBtn.setAttribute('aria-disabled', incompleteLeg?'true':'false'); }
  const reqHint=document.getElementById('route-incomplete-hint');
  if(reqHint) reqHint.hidden=!incompleteLeg;
}

// ---- route map: pins plotted from each point's coordinates ----
function renderMap(){
  const host=document.getElementById('trip-map'); if(!host) return;
  const W=344, H=250, padX=80, padY=44;
  const LAT0=9.95, LAT1=5.80, LNG0=79.55, LNG1=82.0;
  const proj=(lat,lng)=>({ x: padX + (lng-LNG0)/(LNG1-LNG0)*(W-2*padX), y: padY + (LAT0-lat)/(LAT0-LAT1)*(H-2*padY) });
  const names=points().filter(Boolean);
  const pts=names.map(name=>{
    if(!name) return null; const g=T.resolvePlace(name); if(!g) return null;
    return {name, ...proj(g.lat,g.lng)};
  }).filter(Boolean);
  const island=`<path d="M172 28 C214 32 246 64 248 112 C250 152 234 182 214 206 C199 224 184 234 172 234 C160 234 145 224 130 206 C110 182 94 152 96 112 C98 64 130 32 172 28 Z" fill="#cfe7da" stroke="#a9d2c2" stroke-width="1.5"/>`;
  if(pts.length<2 && !(window.CH_MAP && names.length>=2)){
    host.innerHTML=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Route map">${island}</svg>`+
      `<div class="tm-empty">Add a pick-up and drop-off to see your route mapped.</div>`;
    return;
  }
  const line=`<path d="M${pts.map(p=>`${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L')}" fill="none" stroke="#0AB9B6" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="1 7" opacity="0.9"/>`;
  const pins=pts.map((p,idx)=>{
    const first=idx===0, last=idx===pts.length-1;
    const fill=first?'#0a7d6f':(last?'#e8623a':'#0AB9B6');
    const labelLeft = p.x>W*0.6;
    const lx = labelLeft ? p.x-9 : p.x+9;
    const anchor = labelLeft ? 'end' : 'start';
    const short = p.name.replace(/\s*\(.*?\)/,'');
    return `<g>
      <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="8.5" fill="${fill}" stroke="#fff" stroke-width="2"/>
      <text class="tm-pin-num" x="${p.x.toFixed(1)}" y="${(p.y+3).toFixed(1)}" text-anchor="middle" font-size="8">${idx+1}</text>
      <text class="tm-pin-label" x="${lx.toFixed(1)}" y="${(p.y+2.5).toFixed(1)}" text-anchor="${anchor}">${short}</text>
    </g>`;
  }).join('');
  const svg=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Your route across Sri Lanka">${island}${line}${pins}</svg>`;
  // Clean Google map (JS API: route line + waypoints, no panel/markers) with a loading state.
  if(window.CH_MAP && names.length>=2){ window.CH_MAP.renderRoute(host, names, { onFail(){ host.innerHTML=svg; } }); }
  else { host.innerHTML=svg; }
}

// ---- continue into the booking flow ----
document.querySelector('#sum-wa .ic').innerHTML=ICON.wa;
// ---- step 2: “When” — add an optional date to each transfer / stay ----
// No drag-to-reorder here: the dates step keeps the route in the order it was built on the
// route step. Reordering legs whose pick-up/drop-off are fixed would unchain the itinerary
// (a leg's drop-off ≠ the next leg's pick-up), which corrupts the stop list handed to booking.
// Reordering lives on the route step; here you only assign dates.
function renderDatesStep(){
  clearLegDatePops();
  const list=document.getElementById('dates-list');
  list.innerHTML='';
  const WARN_ICO='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>';
  const flags=outOfOrderFlags();
  const driveIssue=sameDayDrivingIssue();
  state.legs.forEach((leg,i)=>{
    const isStay=leg.type==='stay';
    const bad=flags.has(i);
    const routeTxt = isStay
      ? `Stay in ${leg.from||'…'}${leg.nights?` · ${leg.nights} night${leg.nights>1?'s':''}`:''}`
      : `${leg.from||'…'} <span class="dr-ar">→</span> ${leg.to||'…'}`;
    const row=document.createElement('div');
    row.className='date-row'+(isStay?' stay':'')+(bad?' dr-flagged':'');
    row.dataset.i=i;
    row.innerHTML=`
      <div class="dr-info">
        <span class="dr-badge ${isStay?'stay':''}">${isStay?`Stay ${i+1}`:`Leg ${i+1}`}</span>
        <span class="dr-route">${routeTxt}</span>
      </div>
      <div class="dr-date">
        <input type="date" class="dates-step-input" data-placeholder="${isStay?'Arrival date':'Travel date'}" aria-label="Date for ${isStay?'stay':'leg'} ${i+1}">
      </div>
      ${bad?`<div class="dr-warn" role="status"><span class="dr-warn-ic">${WARN_ICO}</span><span><b>Dates out of order.</b> This ${isStay?'stay':'leg'} is dated before an earlier stop in your trip — double-check the date, or go back to reorder your route.</span></div>`:''}`;
    list.appendChild(row);
    const inp=row.querySelector('input');
    if(leg.date) inp.value=fmtISO(leg.date);
    enhanceLegDate(inp);
    inp.addEventListener('change',()=>{ state.legs[i].date = inp.value ? new Date(inp.value+'T00:00:00') : null; renderDatesStep(); });
  });
  // gate the "Continue to booking" CTA while any leg is dated out of order — the customer
  // must fix the dates (or reorder on the route step) before we hand the route to booking
  const hasOOO=flags.size>0;
  const hardDriveBlock=driveIssue && driveIssue.level==='block';
  const cont=document.getElementById('dates-continue');
  if(cont){ cont.classList.toggle('cta-disabled',hasOOO||hardDriveBlock); cont.setAttribute('aria-disabled',(hasOOO||hardDriveBlock)?'true':'false'); }
  const oooHint=document.getElementById('dates-order-hint');
  if(oooHint) oooHint.hidden=!hasOOO;
  const driveHint=document.getElementById('dates-drive-hint');
  if(driveHint){
    driveHint.hidden=!driveIssue;
    driveHint.classList.toggle('is-blocking', !!hardDriveBlock);
    if(driveIssue){
      driveHint.innerHTML=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg> `+
        (hardDriveBlock
          ? `That day has about ${minutesText(driveIssue.minutes)} of driving across ${driveIssue.count} transfers. It is too much for one day, so we cannot proceed with those dates. Please split the route across another day.`
          : `That day has about ${minutesText(driveIssue.minutes)} of driving across ${driveIssue.count} transfers. It is a long travel day, so we recommend splitting it if your schedule allows.`);
    }
  }
  syncPlanUrl();
}
// A leg dated earlier than a stop that comes before it in the route reads as a mistake
// (the journey runs forward). We deliberately no longer silently reorder the customer's
// itinerary — instead we flag the offending leg (see .dr-warn) and let them fix the date
// or drag to reorder. Mirrors the ops quote tool's "Dates out of order" flag.
// Returns the set of leg indices that fall before an earlier-dated stop.
function outOfOrderFlags(){
  const flags=new Set(); let runningMax=null;
  state.legs.forEach((leg,i)=>{
    if(!leg.date) return;
    if(runningMax && leg.date < runningMax) flags.add(i);
    if(!runningMax || leg.date > runningMax) runningMax=leg.date;
  });
  return flags;
}
function sameDayDrivingIssue(){
  const byDate=new Map();
  state.legs.forEach(leg=>{
    if(leg.type==='stay' || !leg.date) return;
    const km=legKm(leg.from, leg.to);
    if(km==null) return;
    const key=fmtISO(leg.date);
    const day=byDate.get(key) || { minutes:0, count:0 };
    day.minutes += drivingMinutes(km);
    day.count += 1;
    byDate.set(key, day);
  });
  let issue=null;
  byDate.forEach(day=>{
    if(day.count<2 || day.minutes<=7*60) return;
    const level=day.minutes>10*60 ? 'block' : 'warn';
    if(!issue || day.minutes>issue.minutes || level==='block') issue={...day, level};
  });
  return issue;
}
// ---- journey progress bar (Route · Dates here; Service · Travelers · Payment on booking) ----
function setJourney(step){
  document.querySelectorAll('#journey .jstep').forEach(j=>{
    const s=+j.dataset.j;
    j.classList.toggle('active', s===step);
    j.classList.toggle('done', s<step);
    const dot=j.querySelector('.jdot'); if(dot) dot.textContent = s<step ? '✓' : s;
  });
  document.querySelectorAll('#journey .jline').forEach((l,i)=>l.classList.toggle('done', i<step-1));
}
// the first two nodes navigate between the planner’s own steps; 3–5 are downstream (booking)
(function wireJourney(){
  const datesHidden=()=>document.getElementById('dates-wrap').hidden;
  document.querySelectorAll('#journey .jstep').forEach(j=>{
    const s=+j.dataset.j;
    if(s===1){ j.classList.add('jnav'); j.addEventListener('click',()=>{ if(!datesHidden()) backToRoute(); }); }
    if(s===2){ j.classList.add('jnav'); j.addEventListener('click',()=>{ if(datesHidden()) showDatesStep(); }); }
  });
  setJourney(1);
})();

function showDatesStep(){
  const bad=firstIncompleteLeg();
  if(bad>=0){ flagIncompleteLeg(bad); return; }
  const seq=routeSeq();
  if(seq.length<2){ alert('Add a pick-up and drop-off to continue.'); return; }
  document.querySelector('.board-wrap').style.display='none';
  // the “Build your route” hero belongs to step 1 — hide it on the dates step, which has its own header
  const head=document.querySelector('.plan-head'); if(head) head.style.display='none';
  document.getElementById('dates-wrap').hidden=false;
  setJourney(2);
  renderDatesStep();
  window.scrollTo({top:0,behavior:'smooth'});
}
function backToRoute(){
  document.getElementById('dates-wrap').hidden=true;
  document.querySelector('.board-wrap').style.display='';
  const head=document.querySelector('.plan-head'); if(head) head.style.display='';
  setJourney(1);
  render();
  window.scrollTo({top:0,behavior:'smooth'});
}

// nudge the customer to the first out-of-order leg instead of proceeding with a scrambled route
function nudgeOutOfOrder(i){
  const row=document.querySelector(`#dates-list .date-row[data-i="${i}"]`);
  if(!row) return;
  const y=row.getBoundingClientRect().top+window.scrollY-90;
  window.scrollTo({top:y,behavior:'smooth'});
  row.classList.add('dr-nudge');
  setTimeout(()=>row.classList.remove('dr-nudge'),900);
}
// ---- continue into the booking flow ----
function goToBooking(){
  // block progression while any leg is dated out of order (see outOfOrderFlags) — proceeding
  // with a non-chronological / reordered route corrupts the stop list handed to booking
  const ooo=outOfOrderFlags();
  if(ooo.size){ nudgeOutOfOrder([...ooo][0]); return; }
  const driveIssue=sameDayDrivingIssue();
  if(driveIssue && driveIssue.level==='block') return;
  const { seq, dates } = routeSeqDetailed();
  if(seq.length<2){ alert('Add a pick-up and drop-off to continue.'); return; }
  const stops=seq.map(s=>s.place);
  const nights=seq.map(s=>s.nights);   // stays carry through as nights at each place
  const kms=[];
  state.legs.forEach(l=>{
    if(l.type==='stay') return;
    const km=legKm(l.from,l.to);
    kms.push(km!=null ? String(km) : '');
  });
  const firstDated=dates.find(Boolean) || (state.legs.find(l=>l.date)?fmtISO(state.legs.find(l=>l.date).date):'');
  const p=new URLSearchParams({
    mode:'trip',
    stops:stops.join('|'),
    nights:nights.join(','),
    dates:dates.join(','),     // one date per leg/wire (empty = flexible)
    kms:kms.join(','),          // planner-measured Google distances for exact-place legs
    pax:String(state.pax),
    vehicle:state.vehicle,
    start: firstDated || ''
  });
  window.location.href='booking.html?'+p.toString();
}
document.getElementById('request-btn').addEventListener('click',showDatesStep);
const backRouteBtn=document.getElementById('back-route'); if(backRouteBtn) backRouteBtn.addEventListener('click',backToRoute);
const datesBack2=document.getElementById('dates-back2'); if(datesBack2) datesBack2.addEventListener('click',backToRoute);
const datesContinue=document.getElementById('dates-continue'); if(datesContinue) datesContinue.addEventListener('click',goToBooking);

// ---- ready-made route templates: load a tour's stops as legs ----
(function(){
  if(!window.TOURS) return;
  const strip=document.getElementById('tpl-strip'), chips=document.getElementById('tpl-chips');
  if(!strip||!chips) return;
  chips.innerHTML = window.TOURS.slice(0,4).map(t=>
    `<button type="button" class="tpl-chip" data-id="${t.id}">${t.name} <small>${t.days} days</small></button>`
  ).join('');
  chips.addEventListener('click',e=>{
    const b=e.target.closest('.tpl-chip'); if(!b) return;
    const t=window.getTour(b.dataset.id); if(!t) return;
    markRouteCustomized();
    state.legs = buildLegs(t.stops);
    render();
    window.scrollTo({top:0,behavior:'smooth'});
  });
  syncTemplateStrip();
})();

// ---- go ----
render();
// deep-link: arriving with ?step=dates (e.g. “Add your dates” / Back from the booking page)
// jumps straight to the When step instead of the route-building view
if((params.get('step')||'').toLowerCase()==='dates') showDatesStep();
