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
  car:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l1.5-4.5A2 2 0 0 1 8.4 7h7.2a2 2 0 0 1 1.9 1.5L19 13M5 13h14m-14 0v4m0 0v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1m10 0v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1m0 0v-4M7 17h.01M17 17h.01"/></svg>',
  van:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 14V7a2 2 0 0 1 2-2h9l5 5v4M3 14h18M3 14v3h2m14-3v3h-2M9 5v5h9M7 20a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm10 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"/></svg>',
  share:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M17 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM7 14a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm10 7a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM9.5 12.5l5 2.5M14.6 8.6l-5.2 2.6"/></svg>',
  clock:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  seat:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M5 11V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v5m-8 0h12a2 2 0 0 1 2 2v3H5v-3a2 2 0 0 1 0-4zm0 9v-2m12 2v-2"/></svg>',
  pin:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M12 21s-7-4.5-7-10a7 7 0 0 1 14 0c0 5.5-7 10-7 10z"/><circle cx="12" cy="11" r="2.5"/></svg>',
  route:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h7a4 4 0 0 0 0-8H9a4 4 0 0 1 0-8h7"/></svg>',
  cal:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v4M16 3v4"/></svg>',
  ck:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 7"/></svg>'
};

// ---- params ----
const params = new URLSearchParams(location.search);
let fromId = params.get('from'), toId = params.get('to');
let date = params.get('date') || '';
/* The party size is the ONE thing that decides which product is cheaper here: shared is
   per seat, private is per vehicle. The homepage hero deliberately asks a single question
   (from + to) and nothing on the site links here with `pax`, so on a normal landing we have
   simply never been told. This used to default to 1 and then state a saving derived from
   that guess — right for a solo traveller, wrong for everyone else. Unset now means unset,
   mirroring the planner's traveller gate (plan.js), and every consumer below omits its
   clause rather than inventing a number. */
const paxParam = parseInt(params.get('pax'), 10);
let pax = (paxParam >= 1 && paxParam <= 6) ? paxParam : null;
const paxText = pax == null ? '' : `${pax} traveller${pax > 1 ? 's' : ''}`;
// fall back to a sensible demo route when NO destination was given (a bare landing on the
// page). But if a `to` WAS provided and we can't honour it (unknown place, or same as the
// pick-up), that's a stale/broken route link — send them to the 404 rather than silently
// swapping in a different destination and quoting a trip they never asked for.
if (!T.place(fromId)) fromId = 'cmb-airport';
let unknownDestination = false;
if (!T.place(toId) || toId === fromId) {
  // Was location.replace('404.html') — a hard dead end for a bookmarked or mistyped link.
  if (params.get('to')) unknownDestination = true;
  toId = 'ella'; // safe default while the picker is shown
}

// ---- populate the edit bar ----
(function () {
  const ef = document.getElementById('e-from'), et = document.getElementById('e-to');
  ef.value = T.place(fromId).name; et.value = T.place(toId).name;
  ef.dataset.placeId = fromId; et.dataset.placeId = toId;
  attachLocalPlaceAutocomplete(ef);
  attachLocalPlaceAutocomplete(et);
  document.getElementById('e-date').value = date;
  // blank (the "How many?" placeholder) until the customer picks — preselecting 1 is the
  // same guess in a different place, and it makes Update silently commit it.
  document.getElementById('e-pax').value = pax == null ? '' : String(Math.min(6, pax));
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
      'Travellers: 6+'
    ].join('\n');
    // Not an anchor click, so analytics.js's delegated listener never sees it.
    // Highest-intent contact on the site — track it explicitly or it's invisible.
    if (window.chTrack) window.chTrack('contact_whatsapp', { method: 'whatsapp', link_id: 'search-group-6plus', page: location.pathname });
    location.href = 'https://wa.me/94779669662?text=' + encodeURIComponent(msg);
    return false;
  }
  if(!f.known || !t.known){
    const p = new URLSearchParams({ stops: [f.name, t.name].join('|') });
    location.href = 'plan.html?' + p.toString();
    return false;
  }
  const p = new URLSearchParams({ from: f.id, to: t.id, date: selectedDate });
  if (selectedPax) p.set('pax', selectedPax);  // left on "How many?" stays unset, not `pax=`
  location.href = 'search.html?' + p.toString();
  return false;
};

// ---- header / title ----
const fromP = T.place(fromId), toP = T.place(toId);
const quote = T.privateQuote(fromId, toId);
const shared = T.sharedOption(fromId, toId);
const displayPrice = n => { const c=Math.round(n*100); return c%100===0 ? String(c/100) : (c/100).toFixed(2); };
document.title = `${fromP.name} → ${toP.name} — Ceylon Hop`;

document.getElementById('route-title').innerHTML =
  `${fromP.name} <span class="arr">${ICONS.route}</span> ${toP.name}`;
const dateText = date ? new Date(date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : 'Flexible date';
document.getElementById('route-meta').innerHTML =
  `<span>${ICONS.pin} ~${quote.km} km</span>` +
  `<span>${ICONS.clock} approx ${quote.duration} drive</span>` +
  `<span>${ICONS.cal} ${dateText}</span>` +
  (paxText ? `<span>${ICONS.seat} ${paxText}</span>` : '');

// ---- collapsed search editor (Kayak/Expedia pattern) ----
// The chosen search stays put; the edit fields stay collapsed behind "Edit search", so
// changing a param is a deliberate act (then Update). The route summary the button used to
// sit beside is gone — the h1 + meta above ARE the summary, and stating them twice on one
// screen was the whole complaint. Only the button toggles now; the hero never moves.
window.editSearch = function () {
  document.getElementById('sl-edit').hidden = true;
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
  document.getElementById('sl-edit').hidden = false;
};

// An unrecognised destination (stale bookmark, mistyped link) used to hard-redirect to 404.
// Open the picker with an explanation instead, so warm traffic can recover in place.
if (unknownDestination) {
  const editBtn = document.getElementById('sl-edit');
  const bar = document.getElementById('srch-bar');
  const err = document.getElementById('srch-err');
  if (editBtn && bar) {
    editBtn.hidden = true;
    bar.hidden = false;
    const cancel = document.getElementById('sl-cancel');
    if (cancel) cancel.hidden = true; // nothing valid to cancel back to
  }
  if (err) {
    err.textContent = "We couldn't find that destination — choose your pick-up and drop-off below.";
    err.hidden = false;
  }
}

// grow this transfer into a multi-stop trip without starting over
(function(){
  const a=document.getElementById('add-stops'); if(!a) return;
  const p=new URLSearchParams({stops:fromP.name+'|'+toP.name});
  if(pax != null) p.set('pax', String(pax));  // don't hand the planner a count we invented
  if(date) p.set('start', date);
  a.href='plan.html?'+p.toString();
  a.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg> Add stops to this trip';
  a.hidden=false;
})();

// ---- build CTAs ----
function bookUrl(extra) {
  // `pax` is forwarded only when the customer actually chose one. Booking collects the
  // traveller count properly on its own step, so an absent param costs nothing there —
  // whereas a guessed one arrives pre-filled and looks like their answer.
  const base = { from: fromId, to: toId, date };
  if (pax != null) base.pax = String(pax);
  return 'booking.html?' + new URLSearchParams(Object.assign(base, extra)).toString();
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
        <div class="v-info"><b>AC car</b><small>Up to 3 travellers + bags</small></div>
        <div class="v-price"><div class="amt">$${displayPrice(quote.car)}</div><small>total, fixed</small></div>
        <a class="btn btn-primary btn-sm" href="${bookUrl({ mode: 'private', vehicle: 'car', price: quote.car, rawPrice: quote.rawCar })}">Select</a>
      </div>
      <div class="veh-row">
        <div class="v-ico">${ICONS.van}</div>
        <div class="v-info"><b>AC van</b><small>Up to 6 travellers + bags</small></div>
        <div class="v-price"><div class="amt">$${displayPrice(quote.van)}</div><small>total, fixed</small></div>
        <a class="btn btn-primary btn-sm" href="${bookUrl({ mode: 'private', vehicle: 'van', price: quote.van, rawPrice: quote.rawVan })}">Select</a>
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
  // A saving can only be stated against a known party size — the private car is one fixed
  // fare however many ride in it, so "% saved" moves entirely with the head count (on
  // Kandy → Ella: ~64% for one, ~29% for two, and by three the private car is the cheaper
  // of the two). With no count given we show both prices and claim nothing.
  const perPaxPrivate = pax == null ? null : quote.car / Math.min(3, pax);
  const savePct = perPaxPrivate == null ? null : Math.round((1 - (shared.seat / perPaxPrivate)) * 100);
  const timeStr = shared.times.map(t => { const [h, m] = t.split(':'); const H = +h; return `${((H + 11) % 12) + 1}:${m}${H < 12 ? 'am' : 'pm'}`; }).join(' & ');
  sharedCard = `
  <article class="opt opt-shared">
    <span class="tag-top">Best value · share &amp; save</span>
    <div class="o-head">
      <div class="o-ico">${ICONS.share}</div>
      <div><h2>Shared ride</h2><div class="o-sub">A reserved seat on our scheduled service</div></div>
    </div>
    <p class="o-desc">Hop a reserved seat on our <b>${shared.corridorLabel}</b> service. Same AC comfort, a friendly Pro&nbsp;Hopper guide on board — for a fraction of the price.</p>
    <div class="shared-price"><span class="amt">$${shared.seat}</span><span class="per">/ seat</span></div>
    ${savePct != null && savePct >= 5 ? `<span class="shared-save">${ICONS.ck} Save ~${savePct}% vs a private car</span>` : ''}
    <div class="shared-meta">
      <div class="sm">${ICONS.clock} Departs ${timeStr} · ${shared.freqText}</div>
      <div class="sm">${ICONS.seat} ${paxText ? `Seats for ${paxText} — we` : 'We'} confirm availability on WhatsApp</div>
    </div>
    <div class="incl">
      <span class="chip">${ICONS.ck} AC car or van</span>
      <span class="chip">${ICONS.ck} Pro Hopper guide</span>
      <span class="chip">${ICONS.ck} Meet other travellers</span>
    </div>
    <a class="btn btn-primary o-cta" href="${bookUrl({ mode: 'shared', price: shared.seat, times: shared.times.join(','), days: shared.days.join(','), corridor: shared.corridorId })}">Book a seat ${ICON.arrow}</a>
  </article>`;
} else {
  noShare = `
  <div class="noshare">
    <div class="ns-ico">${ICONS.share}</div>
    <div>
      <b>No shared seats on this route — yet</b>
      <p>We don't run a scheduled shared service between ${fromP.name} and ${toP.name} right now, so your private transfer is the way to go. It still covers you door-to-door at a fixed price.</p>
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
  // GA4 wants an integer quantity on every item, so an unknown count reports as 1 rather
  // than null (a null risks the whole item being dropped). The honest signal lives on the
  // `search` event instead: `pax` is present only when the customer chose one, and
  // `pax_set` says which of the two happened — chTrack is a bare dataLayer push, so an
  // absent key, undefined and null are indistinguishable downstream. A boolean isn't.
  var qty = pax == null ? 1 : pax;
  var items = [
    { item_id: fromId + '_' + toId, item_name: fromP.name + ' → ' + toP.name, item_category: 'private', item_variant: 'car', price: quote.car, quantity: qty },
    { item_id: fromId + '_' + toId, item_name: fromP.name + ' → ' + toP.name, item_category: 'private', item_variant: 'van', price: quote.van, quantity: qty }
  ];
  if (shared) items.push({ item_id: fromId + '_' + toId, item_name: fromP.name + ' → ' + toP.name, item_category: 'shared', item_variant: 'seat', price: shared.seat, quantity: qty });

  var searchEvent = { from: fromId, to: toId, date: date, pax_set: pax != null, source: 'search' };
  if (pax != null) searchEvent.pax = pax;
  window.chTrack('search', searchEvent);
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

// breadcrumbs — no route crumb. It restated "A → B" in full a few hundred pixels above an
// h1 that says exactly that, which is a lot of trail for one hop off the homepage.
mountBreadcrumbs([['Home','index.html'],['Search']]);

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
