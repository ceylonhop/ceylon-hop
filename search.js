/* ============================================================
   CEYLON HOP — search results / proposal logic
   Always proposes a private transfer; surfaces a shared seat
   when the corridor supports one.
   ============================================================ */
mountHeader('', false, false);
mountFooter(false);
mountWA();

const T = window.TRANSFERS;
/* Marks drawn from the house line set (img/icons/line/) carry `class="wp"` on one filled
   waypoint dot — the family rule. The dot renders as an invisible hairline ring unless
   search.html fills it; every slot below has a matching `.wp{fill:…}` rule there, and
   web-tests/unit/line-icon-family.test.js pins the pair together.

   `route` and `ck` are deliberately NOT from the set: it has no plain connector arrow and no
   tick. */
const ICONS = {
  /* img/icons/line/{private-car,private-van}.svg — the same body as `shared-van` with the
     waypoint dot moved INSIDE the cabin. That swap is the whole meaning: a dot out on a dashed
     arc is a stop on a line others ride, a dot in the cabin is your own seat. Never use
     `shared-van` on these rows. */
  car:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 16.5v-2.6a1 1 0 0 1 .7-1l2-.6 2.1-3a2 2 0 0 1 1.6-.8h4.8a2 2 0 0 1 1.6.8l2.1 3 2 .6a1 1 0 0 1 .7 1v2.6"/><path d="M3.9 16.5H5m4.4 0h5.4m4.4 0h1.1"/><circle cx="7.2" cy="16.8" r="1.8"/><circle cx="16.8" cy="16.8" r="1.8"/><circle class="wp" cx="12" cy="11.4" r="1.7"/></svg>',
  van:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 16.5v-6a1 1 0 0 1 1-1h9l3.5 3.5H19a1 1 0 0 1 1 1v2.5"/><path d="M4.5 16.5H5m9.6 0H9.4m9.2 0h.9"/><circle cx="7.2" cy="16.8" r="1.8"/><circle cx="16.8" cy="16.8" r="1.8"/><circle class="wp" cx="8.2" cy="12.2" r="1.7"/></svg>',
  // img/icons/line/door-to-door.svg — a single point-to-point transfer. The set's README is
  // explicit that this, not `chauffeur`, is the point-to-point mark.
  d2d:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="18.5" r="2"/><path d="M6.8 16.7C11 12.7 13 9.7 17.2 7.7" stroke-dasharray="2.7 2.7"/><circle class="wp" cx="19" cy="6.5" r="2"/></svg>',
  // img/icons/line/shared-van.svg — carries both the shared card's header and the
  // "no shared seats" note, which are mutually exclusive renders.
  share:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 16.5v-6a1 1 0 0 1 1-1h9l3.5 3.5H19a1 1 0 0 1 1 1v2.5"/><path d="M4.5 16.5H5m9.6 0H9.4m9.2 0h.9"/><circle cx="7.2" cy="16.8" r="1.8"/><circle cx="16.8" cy="16.8" r="1.8"/><path d="M4.5 5.5C8 3.9 11.5 7 15 5.4" stroke-dasharray="2.6 2.6"/><circle class="wp" cx="18.5" cy="4.8" r="1.5"/></svg>',
  clock:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  // img/icons/line/travellers.svg
  seat:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="7.8" r="3.3"/><path d="M3.5 20c0-3.2 2.5-5.3 5.5-5.3s5.5 2.1 5.5 5.3"/><path d="M15.5 12.6c2.9 0 5 2.1 5 5.1"/><circle class="wp" cx="16.7" cy="7.5" r="2"/></svg>',
  // img/icons/line/pickup.svg
  pin:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-4.7-7-10a7 7 0 0 1 14 0c0 5.3-7 10-7 10z"/><circle class="wp" cx="12" cy="11" r="2"/></svg>',
  /* The private-transfer promises — img/icons/line/{flexi-time,your-line,rate-lock}.svg.
     Deliberately NOT `chauffeur` for "private to your group": booking.html:735 uses that mark
     for the chauffeur PRODUCT, one click further on, and the set's README keeps the two apart
     on purpose. Reusing it here would advertise a different service. */
  flexi:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5" stroke-dasharray="3.3 3.3"/><path d="M12 12V7.6M12 12l3.5 2.1"/><circle class="wp" cx="12" cy="12" r="1.6"/></svg>',
  stops:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 13.5c2-5 4-5 4.7-2 .6 2.7 2.2 2.9 4-1.1"/><path d="M4 18.5h13.5" stroke-dasharray="2.7 2.9"/><circle class="wp" cx="20.5" cy="18.5" r="1.5"/></svg>',
  lock:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="10.5" width="13" height="9.5" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/><circle class="wp" cx="12" cy="15.2" r="1.5"/></svg>',
  // img/icons/line/{closes-soon,live-count}.svg — the shared service's departure and its
  // seat availability.
  departs:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="7.5"/><path d="M12 9.5V13l2.6 1.8"/><path d="M9.5 3h5"/><path d="M17.5 5.5l1.5 1.5" stroke-dasharray="2 2.6"/><circle class="wp" cx="12" cy="13" r="1.3"/></svg>',
  avail:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13h3.6l2.2-5.4 3.8 9.8 2.3-5.6"/><path d="M17.5 11.8h3" stroke-dasharray="2.2 2.6"/><circle class="wp" cx="15" cy="11.8" r="1.6"/></svg>',
  route:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h7a4 4 0 0 0 0-8H9a4 4 0 0 1 0-8h7"/></svg>',
  // img/icons/line/trip-date.svg — the datepicker button sits ~150px below this row and now
  // carries the same mark; two different calendars that close together read as a mistake.
  cal:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 9.5h17M8 2.8V6M16 2.8V6"/><circle class="wp" cx="12" cy="15" r="1.9"/></svg>',
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
const browseEstimateId = `${fromId}>${toId}:${engineRoute ? 'engine-v2' : 'reviewed-v1'}`;
function routeFingerprint(value) {
  let hash=2166136261;
  for(const ch of String(value||'')){ hash^=ch.charCodeAt(0); hash=Math.imul(hash,16777619); }
  return `r${(hash>>>0).toString(36)}`;
}
function tagRouteEstimate(q, state) {
  if (!q) return q;
  q.estimateState = state || (q.estimated ? 'estimated' : 'browse');
  q.estimateId = browseEstimateId;
  return q;
}
tagRouteEstimate(quote);
const displayPrice = n => { const c=Math.round(n*100); return c%100===0 ? String(c/100) : (c/100).toFixed(2); };
/* Display label ONLY. A Google place arrives as its full formatted address ("Ratmalana
   Airport, New Airport Road, Dehiwala-Mount Lavinia, Sri Lanka") and, set in the h1's
   display face on a phone, that is a four-line wall of serif. URLs, pricing calls, the
   edit-search inputs, WhatsApp prefills and analytics all keep the full stored name —
   place identity must never change shape on the way to the API (see ch-shortplace.js). */
const dispFrom = (window.CH && CH.shortPlace) ? CH.shortPlace(fromP.name) : fromP.name;
const dispTo = (window.CH && CH.shortPlace) ? CH.shortPlace(toP.name) : toP.name;
document.title = `${dispFrom} → ${dispTo} — Ceylon Hop`;

document.getElementById('route-title').innerHTML =
  `${dispFrom} <span class="arr">${ICONS.route}</span> ${dispTo}`;
const dateText = date ? new Date(date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : 'Flexible date';
// 'measuring' only while an estimate is genuinely in flight — once it has failed there is
// nothing being measured, and leaving the line up reads as a page still working on it.
function renderMeta(measuring) {
  const estimateText = quote && window.CH && CH.routeEstimate
    ? CH.routeEstimate.formatRouteEstimate({
        distanceKm: quote.km,
        durationMin: quote.durationMin,
        state: quote.estimateState,
      })
    : '';
  document.getElementById('route-meta').innerHTML =
    (quote && estimateText
      ? `<span class="route-estimate">${ICONS.clock} ${estimateText}</span>`
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
  if (quote) {
    base.estimateKm = String(quote.km);
    if (quote.durationMin != null) base.estimateMin = String(quote.durationMin);
    base.estimateState = quote.estimateState || 'browse';
    base.estimateId = quote.estimateId || browseEstimateId;
  }
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
      <div class="o-ico">${ICONS.d2d}</div>
      <div><h2>Private transfer</h2><div class="o-sub">Door-to-door · your own vehicle</div></div>
    </div>
    <p class="o-desc">Leave exactly when you want and stop wherever you like along the way. A vetted driver takes just your group, ${dispFrom} straight to ${dispTo}.</p>
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
      <span class="chip">${ICONS.seat} Private to your group</span>
      <span class="chip">${ICONS.flexi} Pick your own time</span>
      <span class="chip">${ICONS.stops} Stops on request</span>
      <span class="chip">${ICONS.lock} Fixed price, no meter</span>
    </div>
  </article>`; }

/* Engine-priced routes show the card with its prices still arriving. A skeleton rather than a
   spinner because the card's shape is already known and only two numbers are missing —
   swapping the whole card in later would move everything under the traveller's cursor. */
function privateSkeletonHtml() { return `
  <article class="opt opt-private is-pending" aria-busy="true">
    <span class="tag-top">Most flexible · recommended</span>
    <div class="o-head">
      <div class="o-ico">${ICONS.d2d}</div>
      <div><h2>Private transfer</h2><div class="o-sub">Door-to-door · your own vehicle</div></div>
    </div>
    <p class="o-desc">Leave exactly when you want and stop wherever you like along the way. A vetted driver takes just your group, ${dispFrom} straight to ${dispTo}.</p>
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
      <div class="o-ico">${ICONS.d2d}</div>
      <div><h2>Private transfer</h2><div class="o-sub">Door-to-door · your own vehicle</div></div>
    </div>
    <p class="o-desc">We couldn't work out a live price for ${dispFrom} → ${dispTo} just now. Send us the route and we'll price it by hand — usually within minutes during Sri&nbsp;Lanka hours.</p>
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
      <div class="sm">${ICONS.departs} Departs ${timeStr} · ${shared.freqText}</div>
      <div class="sm">${ICONS.avail} ${paxText ? `Seats for ${paxText} — we` : 'We'} confirm availability on WhatsApp</div>
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
      <p>We don't run a scheduled shared service between ${dispFrom} and ${dispTo} right now, so your private transfer is the way to go. It still covers you door-to-door at a fixed price.</p>
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

  var searchEvent = {
    from: fromId, to: toId, date: date, pax_set: pax != null, source: 'search',
    estimate_state: quote.estimateState,
    route_fingerprint: routeFingerprint(quote.estimateId)
  };
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
    const km = leg.distanceKm != null ? leg.distanceKm : null;
    quote = tagRouteEstimate({
      km: km,
      durationMin: leg.durationMin != null ? leg.durationMin : null,
      estimated: car.estimated === true,
      car: car.totalCents / 100,
      van: van.totalCents / 100,
      // The engine total IS the final fare — there is no separate unfinished figure to hand on,
      // so booking receives `price` alone and re-prices through the same endpoint on arrival.
      rawCar: null, rawVan: null
    }, car.estimated === true ? 'estimated' : 'browse');
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
