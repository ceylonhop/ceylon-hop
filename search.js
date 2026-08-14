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
/* `from`/`to` carry a catalogue id when the traveller picked a known place, and the raw place
   NAME when they picked a Google suggestion. Both are honoured: a known pair prices instantly
   from the baked table, an unknown one is priced by the engine over the API (see below).
   An unknown place used to be diverted to the planner from the homepage and, if it got here
   anyway, treated as a broken link — so a traveller who typed a real destination we simply
   don't have baked was shown an itinerary builder instead of the price they asked for.
   booking.js already reads these params exactly this way (T.place(id) || {name:param}), which
   is what lets an engine-priced route carry straight through to booking. */
const hasFrom = !!params.get('from'), hasTo = !!params.get('to');
// A bare landing (no params at all) still gets a sensible demo route.
if (!hasFrom) fromId = 'cmb-airport';
if (!hasTo) toId = 'ella';
const fromPlace = T.place(fromId), toPlace = T.place(toId);
const fromP = fromPlace || { id: null, name: fromId };
const toP = toPlace || { id: null, name: toId };
// Only an unknown END needs the engine. A known pair must never pay for a network round trip.
const engineRoute = !fromPlace || !toPlace;
// The same place at both ends is a broken link however it was spelled — open the picker.
const sameEnds = fromP.name === toP.name;

// ---- populate the edit bar ----
(function () {
  const ef = document.getElementById('e-from'), et = document.getElementById('e-to');
  ef.value = fromP.name; et.value = toP.name;
  // Only a catalogue place has an id to carry; a Google-picked place is its name and nothing
  // else. Stamping the raw name in as a placeId would make resolvePlaceInput() treat it as a
  // known id on Update and quietly reprice a different route.
  if (fromP.id) ef.dataset.placeId = fromP.id; else delete ef.dataset.placeId;
  if (toP.id) et.dataset.placeId = toP.id; else delete et.dataset.placeId;
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
  // A place we don't have baked is no longer a reason to abandon the search: it travels as its
  // NAME and gets priced by the engine on the way back in. Only a single leg is ever offered
  // here, so this page can always answer it.
  const p = new URLSearchParams({ from: f.known ? f.id : f.name, to: t.known ? t.id : t.name, date: selectedDate });
  if (selectedPax) p.set('pax', selectedPax);  // left on "How many?" stays unset, not `pax=`
  location.href = 'search.html?' + p.toString();
  return false;
};

// ---- header / title ----
/* A baked pair is priced synchronously, exactly as before — no network, no skeleton, nothing
   to wait for. An engine route starts with no numbers at all and fills them in when the
   estimate lands, so `quote` is a variable rather than a constant and everything that reads
   it renders through a function. `shared` stays null for an engine route: a shared seat is a
   scheduled corridor in the baked table, and no such service exists for an arbitrary place. */
let quote = engineRoute ? null : T.privateQuote(fromId, toId);
const shared = engineRoute ? null : T.sharedOption(fromId, toId);
const displayPrice = n => { const c=Math.round(n*100); return c%100===0 ? String(c/100) : (c/100).toFixed(2); };
document.title = `${fromP.name} → ${toP.name} — Ceylon Hop`;

document.getElementById('route-title').innerHTML =
  `${fromP.name} <span class="arr">${ICONS.route}</span> ${toP.name}`;
const dateText = date ? new Date(date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : 'Flexible date';
// 'measuring' only while an estimate is genuinely in flight — once it has failed there is
// nothing being measured, and leaving the line up reads as a page still working on it.
function renderMeta(measuring) {
  document.getElementById('route-meta').innerHTML =
    (quote
      ? `<span>${ICONS.pin} ~${quote.km} km</span><span>${ICONS.clock} approx ${quote.duration} drive</span>`
      : measuring ? `<span>${ICONS.pin} Measuring your route…</span>` : '') +
    `<span>${ICONS.cal} ${dateText}</span>` +
    (paxText ? `<span>${ICONS.seat} ${paxText}</span>` : '');
}
renderMeta(engineRoute);

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

// Pick-up and drop-off the same (stale bookmark, mistyped link) used to hard-redirect to 404.
// Open the picker with an explanation instead, so warm traffic can recover in place. An
// unrecognised place is no longer part of this condition — it gets priced, not questioned.
if (sameEnds) {
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
    err.textContent = 'Pick-up and drop-off are the same place — choose where you want to go.';
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
  const all = Object.assign(base, extra);
  // An engine-priced route has no separate unfinished fare, so rawPrice comes through null —
  // drop it rather than sending the literal string "null", which parseFloat would turn into 0
  // and booking would read as a free transfer.
  Object.keys(all).forEach(function (k) { if (all[k] == null) delete all[k]; });
  return 'booking.html?' + new URLSearchParams(all).toString();
}

function privateCardHtml() { return `
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
  </article>`; }

/* Engine-priced routes show the card with its prices still arriving. A skeleton rather than a
   spinner because the card's shape is already known and only two numbers are missing —
   swapping the whole card in later would move everything under the traveller's cursor. */
function privateSkeletonHtml() { return `
  <article class="opt opt-private is-pending" aria-busy="true">
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
        <div class="v-price"><div class="amt sk-amt">&nbsp;</div><small>working out your price…</small></div>
      </div>
      <div class="veh-row">
        <div class="v-ico">${ICONS.van}</div>
        <div class="v-info"><b>AC van</b><small>Up to 6 travellers + bags</small></div>
        <div class="v-price"><div class="amt sk-amt">&nbsp;</div><small>working out your price…</small></div>
      </div>
    </div>
  </article>`; }

/* No price, and no way to get one — the API is unreachable or can't route these two points.
   There is no local formula to fall back on for a place that isn't in the baked table, so the
   honest answer is a human one rather than an invented number. */
function unpricedHtml() { return `
  <article class="opt opt-private opt-unpriced">
    <div class="o-head">
      <div class="o-ico">${ICONS.car}</div>
      <div><h2>Private transfer</h2><div class="o-sub">Door-to-door · your own vehicle</div></div>
    </div>
    <p class="o-desc">We couldn't work out a live price for ${fromP.name} → ${toP.name} just now. Send us the route and we'll price it by hand — usually within minutes during Sri&nbsp;Lanka hours.</p>
    <a class="btn btn-wa o-cta" target="_blank" rel="noopener" href="https://wa.me/94779669662?text=${encodeURIComponent('Hi Ceylon Hop! Could I get a price for ' + fromP.name + ' → ' + toP.name + '?')}">${ICON.wa} Get a price on WhatsApp</a>
  </article>`; }

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
// `state` is 'priced' | 'pending' | 'unpriced'; a baked route is only ever 'priced'.
function renderResults(state) {
  const left = state === 'priced' ? privateCardHtml()
    : state === 'pending' ? privateSkeletonHtml()
    : unpricedHtml();
  document.getElementById('results').innerHTML =
    `<div class="opt-grid">${left}${shared ? sharedCard : noShare}</div>`;
}
renderResults(engineRoute ? 'pending' : 'priced');

// ---- funnel: search + results view (Phase 0 analytics) ----
// Called once prices exist. An engine route reports after its estimate lands, so view_item_list
// never carries a placeholder price — and a route we never managed to price reports no items.
function trackResults() {
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
}
if (!engineRoute) trackResults();

/* ---- engine prices for a route that isn't in the baked table ----
   The catalogue can't price an arbitrary place, so the engine does it: POST /quote/v2/estimate
   resolves the distance server-side and prices it against the live card without persisting
   anything. ch-pricing.js owns the fetch (debounce, dedupe, timeout, and latching off when the
   endpoint 404s because QUOTE_V2_ENABLED is off for the deploy).

   Two calls, one per vehicle, because the card offers both and an intent names exactly one.
   `pax:1, bags:0` is not a guess about the party: the engine reads pax/bags only to UPGRADE a
   vehicle that would be too small (selectVehicle), so the smallest party is the only value
   that returns the fare for the vehicle actually asked for. The real traveller count is
   collected on the booking step, exactly as it is for a baked route.

   If either call fails there is no fallback price to show — no local formula can price a place
   with no baked distance — so the card becomes an honest "we'll price it by hand" instead. */
if (engineRoute) (function () {
  // "3h 21m" / "45 min" — the same shape the baked table's durationText produces.
  function minutesText(min) {
    const h = Math.floor(min / 60), m = Math.round(min % 60);
    if (h <= 0) return `${Math.max(20, m)} min`;
    return m >= 8 ? `${h}h ${m}m` : `${h}h`;
  }
  const legs = [{ from: fromP.name, to: toP.name }];
  const base = { product: 'private', pax: 1, bags: 0, legs, extras: [] };
  if (date) base.date = date;

  function ask(vehicle) {
    return new Promise(function (resolve) {
      if (!window.CH_PRICING) return resolve(null);
      window.CH_PRICING.estimate(Object.assign({ vehicle }, base), {
        onResult: function (est) { resolve(est); },
        onUnavailable: function () { resolve(null); }
      });
    });
  }

  /* Sequential, NOT Promise.all. ch-pricing.js tracks exactly one intent at a time by design —
     a call for a different intent supersedes whatever is pending and orphans its callbacks, so
     firing car and van together means the car's onResult never runs and the card waits forever.
     Asking in turn costs a second round trip on a cold route; both are then in ch-pricing's
     sessionStorage, so a re-render or a return visit is instant. */
  ask('car').then(function (car) {
    return ask('van').then(function (van) { return [car, van]; });
  }).then(function (res) {
    const car = res[0], van = res[1];
    if (!car || !van || typeof car.totalCents !== 'number' || typeof van.totalCents !== 'number') {
      renderMeta(false);
      renderResults('unpriced');
      return;
    }
    const leg = (car.legs && car.legs[0]) || {};
    const km = leg.distanceKm != null ? Math.round(leg.distanceKm) : null;
    quote = {
      km: km,
      // Prefer the routed duration that came back with the distance; fall back to the local
      // km→time curve so the meta line never sits empty next to a real price.
      duration: leg.durationMin != null ? minutesText(leg.durationMin) : (km != null ? T.durationText(km) : '—'),
      car: car.totalCents / 100,
      van: van.totalCents / 100,
      // The engine total IS the final fare — there is no separate unfinished figure to hand on,
      // so booking receives `price` alone and re-prices through the same endpoint on arrival.
      rawCar: null, rawVan: null
    };
    if (quote.km == null) { quote = null; renderMeta(false); renderResults('unpriced'); return; }
    renderMeta(false);
    renderResults('priced');
    trackResults();
  });
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
    <a class="btn btn-wa" href="https://wa.me/94779669662?text=${encodeURIComponent('Hi Ceylon Hop! I have a question about '+fromP.name+' → '+toP.name+'.')}" target="_blank" rel="noopener">${ICON.wa} Chat on WhatsApp</a>`;
}

initReveal();
