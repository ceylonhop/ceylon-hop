/* ============================================================
   CEYLON HOP — search results / proposal logic
   Always proposes a private transfer; surfaces a shared seat
   when the corridor supports one.
   ============================================================ */
mountHeader('', false, false);
mountFooter(false);
mountWA();

const T = window.TRANSFERS;
const ICONS = {
  car:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l1.5-4.5A2 2 0 0 1 8.4 7h7.2a2 2 0 0 1 1.9 1.5L19 13M5 13h14m-14 0v4m0 0v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1m10 0v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1m0 0v-4M7 17h.01M17 17h.01"/></svg>',
  van:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 14V7a2 2 0 0 1 2-2h9l5 5v4M3 14h18M3 14v3h2m14-3v3h-2M9 5v5h9M7 20a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm10 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"/></svg>',
  share:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM7 14a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm10 7a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM9.5 12.5l5 2.5M14.6 8.6l-5.2 2.6"/></svg>',
  clock:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  seat:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 11V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v5m-8 0h12a2 2 0 0 1 2 2v3H5v-3a2 2 0 0 1 0-4zm0 9v-2m12 2v-2"/></svg>',
  pin:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s-7-4.5-7-10a7 7 0 0 1 14 0c0 5.5-7 10-7 10z"/><circle cx="12" cy="11" r="2.5"/></svg>',
  route:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h7a4 4 0 0 0 0-8H9a4 4 0 0 1 0-8h7"/></svg>',
  cal:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v4M16 3v4"/></svg>',
  ck:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 7"/></svg>'
};

// ---- params ----
const params = new URLSearchParams(location.search);
let fromId = params.get('from'), toId = params.get('to');
let date = params.get('date') || '';
let pax = Math.max(1, parseInt(params.get('pax')) || 1);
// fall back to a sensible demo route if params are missing
if (!T.place(fromId)) fromId = 'cmb-airport';
if (!T.place(toId) || toId === fromId) toId = 'ella';

// ---- populate the edit bar ----
(function () {
  const ef = document.getElementById('e-from'), et = document.getElementById('e-to');
  ef.value = T.place(fromId).name; et.value = T.place(toId).name;
  ef.dataset.placeId = fromId; et.dataset.placeId = toId;
  attachLocalPlaceAutocomplete(ef);
  attachLocalPlaceAutocomplete(et);
  document.getElementById('e-date').value = date;
  document.getElementById('e-pax').value = String(Math.min(6, pax));
  document.getElementById('e-swap').addEventListener('click', () => {
    const a = ef.value, aid = ef.dataset.placeId || '', asrc = ef.dataset.placeSource || '';
    ef.value = et.value; ef.dataset.placeId = et.dataset.placeId || ''; ef.dataset.placeSource = et.dataset.placeSource || '';
    et.value = a; et.dataset.placeId = aid; et.dataset.placeSource = asrc;
  });
})();
window.updateSearch = function (e) {
  e.preventDefault();
  const fromEl = document.getElementById('e-from'), toEl = document.getElementById('e-to');
  const paxEl = document.getElementById('e-pax');
  const f = resolvePlaceInput(fromEl.value), t = resolvePlaceInput(toEl.value);
  const err = document.getElementById('srch-err');
  if (!f.name || !t.name) {
    if(err){ err.textContent = 'Choose both pick-up and drop-off places.'; err.hidden = false; }
    return false;
  }
  if (f.name === t.name) {
    if(err){ err.textContent = 'Pick-up and drop-off are the same — choose two different places.'; err.hidden = false; }
    return false;
  }
  if(err) err.hidden = true;
  const selectedPax = paxEl ? paxEl.value : '';
  const selectedDate = document.getElementById('e-date').value || '';
  if(selectedPax === '6'){
    const msg = [
      'Hi Ceylon Hop! I need help with a group transfer quote.',
      'Route: ' + f.name + ' to ' + t.name,
      selectedDate ? ('Date: ' + selectedDate) : 'Date: flexible',
      'Travelers: 6+'
    ].join('\n');
    location.href = 'https://wa.me/94779669662?text=' + encodeURIComponent(msg);
    return false;
  }
  if(!f.known || !t.known){
    const p = new URLSearchParams({ stops: [f.name, t.name].join('|') });
    location.href = 'plan.html?' + p.toString();
    return false;
  }
  const p = new URLSearchParams({ from: f.id, to: t.id, date: selectedDate, pax: selectedPax });
  location.href = 'search.html?' + p.toString();
  return false;
};

// ---- header / title ----
const fromP = T.place(fromId), toP = T.place(toId);
const quote = T.privateQuote(fromId, toId);
const shared = T.sharedOption(fromId, toId);
document.title = `${fromP.name} → ${toP.name} — Ceylon Hop`;

document.getElementById('route-title').innerHTML =
  `${fromP.name} <span class="arr">${ICONS.route}</span> ${toP.name}`;
const dateText = date ? new Date(date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : 'Flexible date';
document.getElementById('route-meta').innerHTML =
  `<span>${ICONS.pin} ~${quote.km} km</span>` +
  `<span>${ICONS.clock} approx ${quote.duration} drive</span>` +
  `<span>${ICONS.cal} ${dateText}</span>` +
  `<span>${ICONS.seat} ${pax} traveler${pax > 1 ? 's' : ''}</span>`;

// ---- locked search summary (Kayak/Expedia pattern) ----
// The chosen search shows read-only; the edit fields stay collapsed until the
// customer clicks "Edit search". Changing a param is a deliberate act (then Update).
document.getElementById('sl-route').innerHTML =
  `${fromP.name} <span class="arr">${ICONS.route}</span> ${toP.name}`;
document.getElementById('sl-meta').textContent =
  `~${quote.km} km · approx ${quote.duration} drive · ${dateText} · ${pax} traveler${pax > 1 ? 's' : ''}`;
window.editSearch = function () {
  document.getElementById('srch-locked').hidden = true;
  document.getElementById('srch-bar').hidden = false;
  document.getElementById('sl-cancel').hidden = false;
  const f = document.getElementById('e-from');
  if (f) f.focus();
};
window.cancelEdit = function () {
  document.getElementById('srch-bar').hidden = true;
  document.getElementById('sl-cancel').hidden = true;
  const err = document.getElementById('srch-err');
  if (err) err.hidden = true;
  document.getElementById('srch-locked').hidden = false;
};

// grow this transfer into a multi-stop trip without starting over
(function(){
  const a=document.getElementById('add-stops'); if(!a) return;
  const p=new URLSearchParams({stops:fromP.name+'|'+toP.name, pax:String(pax)});
  if(date) p.set('start', date);
  a.href='plan.html?'+p.toString();
  a.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg> Add stops to this trip';
  a.hidden=false;
})();

// ---- build CTAs ----
function bookUrl(extra) {
  return 'booking.html?' + new URLSearchParams(Object.assign(
    { from: fromId, to: toId, date, pax: String(pax) }, extra)).toString();
}

const privateCard = `
  <article class="opt opt-private">
    <span class="tag-top">Most flexible · recommended</span>
    <div class="o-head">
      <div class="o-ico">${ICONS.car}</div>
      <div><h2>Private transfer</h2><div class="o-sub">Door-to-door · your own vehicle</div></div>
    </div>
    <p class="o-desc">Leave exactly when you want and stop wherever you like along the way. A vetted driver takes just your group, ${fromP.name} straight to ${toP.name}.</p>
    <div class="veh">
      <div class="veh-row">
        <div class="v-ico">${ICONS.car}</div>
        <div class="v-info"><b>AC car</b><small>Up to 3 travelers + bags</small></div>
        <div class="v-price"><div class="amt">$${quote.car}</div><small>total, fixed</small></div>
        <a class="btn btn-primary btn-sm" href="${bookUrl({ mode: 'private', vehicle: 'car', price: quote.car })}">Select</a>
      </div>
      <div class="veh-row">
        <div class="v-ico">${ICONS.van}</div>
        <div class="v-info"><b>AC van</b><small>Up to 6 travelers + bags</small></div>
        <div class="v-price"><div class="amt">$${quote.van}</div><small>total, fixed</small></div>
        <a class="btn btn-primary btn-sm" href="${bookUrl({ mode: 'private', vehicle: 'van', price: quote.van })}">Select</a>
      </div>
    </div>
    <div class="incl">
      <span class="chip">${ICONS.ck} Private to your group</span>
      <span class="chip">${ICONS.ck} Pick your own time</span>
      <span class="chip">${ICONS.ck} Stops on request</span>
      <span class="chip">${ICONS.ck} Fixed price, no meter</span>
    </div>
  </article>`;

let sharedCard = '';
let noShare = '';
if (shared) {
  const perPaxPrivate = quote.car / Math.min(3, Math.max(1, pax));
  const savePct = Math.max(15, Math.round((1 - (shared.seat / perPaxPrivate)) * 100));
  const timeStr = shared.times.map(t => { const [h, m] = t.split(':'); const H = +h; return `${((H + 11) % 12) + 1}:${m}${H < 12 ? 'am' : 'pm'}`; }).join(' & ');
  const low = shared.seatsLeft <= 4;
  sharedCard = `
  <article class="opt opt-shared">
    <span class="tag-top">Best value · share &amp; save</span>
    <div class="o-head">
      <div class="o-ico">${ICONS.share}</div>
      <div><h2>Shared ride</h2><div class="o-sub">A seat on our daily service</div></div>
    </div>
    <p class="o-desc">Hop a reserved seat on our <b>${shared.corridorLabel}</b> service. Same AC comfort, a friendly Pro&nbsp;Hopper guide on board — for a fraction of the price.</p>
    <div class="shared-price"><span class="amt">$${shared.seat}</span><span class="per">/ seat</span></div>
    <span class="shared-save">${ICONS.ck} Save ~${savePct}% vs a private car</span>
    <div class="shared-meta">
      <div class="sm">${ICONS.clock} Departs ${timeStr} · ${shared.freqText}</div>
      <div class="sm">${ICONS.seat} <span class="${low ? 'low' : ''}">${shared.seatsLeft} seat${shared.seatsLeft > 1 ? 's' : ''} left</span> for ${pax} traveler${pax > 1 ? 's' : ''}</div>
    </div>
    <div class="incl">
      <span class="chip">${ICONS.ck} AC car or van</span>
      <span class="chip">${ICONS.ck} Pro Hopper guide</span>
      <span class="chip">${ICONS.ck} Meet other travelers</span>
    </div>
    <a class="btn btn-primary o-cta" href="${bookUrl({ mode: 'shared', price: shared.seat, times: shared.times.join(','), corridor: shared.corridorId })}">Book a seat ${ICON.arrow}</a>
  </article>`;
} else {
  noShare = `
  <div class="noshare">
    <div class="ns-ico">${ICONS.share}</div>
    <div>
      <b>No shared seats on this route — yet</b>
      <p>We don't run a daily shared service between ${fromP.name} and ${toP.name} right now, so your private transfer is the way to go. It still covers you door-to-door at a fixed price.</p>
    </div>
  </div>`;
}

// When there's no shared service, the "no shared seats" panel takes the shared card's
// slot in the right column (instead of spanning full-width below) so the two-up layout
// reads the same whether or not a shared option exists.
document.getElementById('results').innerHTML =
  `<div class="opt-grid">${privateCard}${shared ? sharedCard : noShare}</div>`;

// ---- funnel: search + results view (Phase 0 analytics) ----
(function () {
  if (typeof window.chTrack !== 'function') return;
  var listId = fromId + '_' + toId;
  var items = [
    { item_id: fromId + '_' + toId, item_name: fromP.name + ' → ' + toP.name, item_category: 'private', item_variant: 'car', price: quote.car, quantity: pax },
    { item_id: fromId + '_' + toId, item_name: fromP.name + ' → ' + toP.name, item_category: 'private', item_variant: 'van', price: quote.van, quantity: pax }
  ];
  if (shared) items.push({ item_id: fromId + '_' + toId, item_name: fromP.name + ' → ' + toP.name, item_category: 'shared', item_variant: 'seat', price: shared.seat, quantity: pax });

  window.chTrack('search', { from: fromId, to: toId, date: date, pax: pax, source: 'search' });
  window.chTrack('view_item_list', { item_list_id: listId, currency: 'USD', items: items });

  // select_item: delegate on the results container; read mode/vehicle from the CTA href.
  var box = document.getElementById('results');
  if (box) box.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href*="booking.html"]') : null;
    if (!a) return;
    var q = new URLSearchParams(a.getAttribute('href').split('?')[1] || '');
    window.chTrack('select_item', { item_list_id: listId, mode: q.get('mode') || '', item_variant: q.get('vehicle') || 'seat' });
  }, true); // capture: fires before navigation starts
})();

// breadcrumbs
mountBreadcrumbs([['Home','index.html'],['Search'],[`${fromP.name} → ${toP.name}`]]);

// WhatsApp help card under results
const help=document.getElementById('srch-help');
if(help){
  help.innerHTML=`
    <div class="help-ico">${ICON.wa}</div>
    <div class="help-txt">
      <b>Not sure which to pick, or need a custom route?</b>
      <p>Message a real Hop planner — we usually reply in minutes during Sri Lanka hours.</p>
    </div>
    <a class="btn btn-wa" href="https://wa.me/94779669662?text=${encodeURIComponent('Hi Ceylon Hop! I have a question about '+fromP.name+' → '+toP.name+'.')}" target="_blank" rel="noopener">${ICON.wa} Ask on WhatsApp</a>`;
}

initReveal();
