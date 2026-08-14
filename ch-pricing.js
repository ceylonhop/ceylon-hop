/* ============================================================
   CEYLON HOP — engine price estimates (client)
   ============================================================
   Owns fetch/debounce/dedupe/fallback for POST /quote/v2/estimate. booking.js (Task 2+ of the
   engine-pricing plan) reads window.CH_PRICING guardedly and keeps its local formula as the
   fallback — this module NEVER decides what the page shows, only whether/what the engine says.

   Behaviour pinned by web-tests/unit/ch-pricing.test.js:
   - estimate(intent, {onResult, onUnavailable}) is debounced 400ms. The page has ONE active
     intent at a time (whatever the wizard currently shows), so there is a single shared timer
     for the whole module rather than one per call site — a second call before the timer fires
     just replaces what's about to be asked for.
   - A repeat of an intent already answered this session is served from sessionStorage instantly
     (no debounce, no fetch) — keyed on JSON.stringify(intent), so a stepper bounced back to a
     value it already showed doesn't wait another 400ms + round trip.
   - While a fetch for the CURRENT intent is in flight, further calls for that same intent join
     it (one fetch, every caller's onResult fires) instead of racing a second request.
   - A call for a DIFFERENT intent supersedes whatever the module was tracking — including an
     already in-flight fetch for the old one. The old callbacks are simply never invoked: each
     request carries a monotonically increasing id, and a result only reaches its callbacks if
     the module is still tracking that exact request when the response lands. That's what makes
     an out-of-order network race safe (an old, slow response landing after a newer, faster one
     must never clobber what's already on screen).
   ============================================================ */
(function(){
  const DEBOUNCE_MS = 400;
  const TIMEOUT_MS = 3000;
  const ENDPOINT = '/quote/v2/estimate';

  // Latched false only once the backend answers 404 — that means QUOTE_V2_ENABLED is off for
  // this deploy, a fact about the SESSION, not about any one intent, so every future call skips
  // the fetch entirely once we've learned it. Network errors and a timed-out request are NOT
  // latched: those are transient (a dropped signal, a cold Render boot waking up) and the very
  // next call should try again rather than give up on engine pricing for the rest of the visit.
  let available = true;

  // The one request the module is tracking, or null. At most one at a time — a new, different
  // intent replaces it outright (see the module comment above for why that's safe).
  let pending = null; // { sig, intent, callbacks:[{onResult,onUnavailable}], requestId, timer }
  let nextRequestId = 0;

  function cacheKey(sig){ return 'chEst:' + sig; }
  function readCache(sig){
    // sessionStorage can throw (private-mode quota, disabled storage) — a cache is an
    // optimisation, never a requirement, so any failure here just means "no cache hit".
    try { const raw = sessionStorage.getItem(cacheKey(sig)); return raw ? JSON.parse(raw) : null; }
    catch(e){ return null; }
  }
  function writeCache(sig, est){
    try { sessionStorage.setItem(cacheKey(sig), JSON.stringify(est)); } catch(e){}
  }

  // Only fires callbacks if `record` is still the module's current request — an older request
  // that lands late after being superseded is silently dropped here.
  function settle(record, fn, arg){
    if(pending !== record) return;
    pending = null;
    record.callbacks.forEach(function(cb){ try { if(cb[fn]) cb[fn](arg); } catch(e){} });
  }

  function doFetch(record){
    const API = window.CEYLON_HOP_API;
    const ctrl = new AbortController();
    const abortTimer = setTimeout(function(){ ctrl.abort(); }, TIMEOUT_MS);
    fetch(API.replace(/\/$/,'') + ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(record.intent),
      signal: ctrl.signal
    }).then(function(res){
      clearTimeout(abortTimer);
      if(res.status === 404){
        // Flag off for this deploy — a session-wide fact, so latch it even if this particular
        // fetch is no longer the one anybody's waiting on.
        available = false;
        return settle(record, 'onUnavailable', 'flag_off');
      }
      if(!res.ok) return settle(record, 'onUnavailable', 'http_error');
      return res.json().then(function(est){
        writeCache(record.sig, est); // cache is keyed by intent, so it's fine to write even if stale
        settle(record, 'onResult', est);
      });
    }).catch(function(){
      clearTimeout(abortTimer);
      // A network error, or our own 3s abort firing — transient either way. Availability is
      // untouched so the next estimate() call for this (or any) intent tries again.
      settle(record, 'onUnavailable', 'network');
    });
  }

  // Starts tracking a brand-new request for `intent` and arms its debounce timer.
  function track(intent, sig, callbacks){
    const record = { sig: sig, intent: intent, callbacks: callbacks, requestId: ++nextRequestId, timer: null };
    pending = record;
    record.timer = setTimeout(function(){ record.timer = null; doFetch(record); }, DEBOUNCE_MS);
  }

  function estimate(intent, callbacks){
    callbacks = callbacks || {};
    if(!window.CEYLON_HOP_API){
      if(callbacks.onUnavailable) callbacks.onUnavailable('no_api');
      return;
    }
    if(!available){
      if(callbacks.onUnavailable) callbacks.onUnavailable('flag_off');
      return;
    }
    let sig;
    try { sig = JSON.stringify(intent); }
    catch(e){ if(callbacks.onUnavailable) callbacks.onUnavailable('bad_intent'); return; }

    const cached = readCache(sig);
    if(cached){ if(callbacks.onResult) callbacks.onResult(cached); return; }

    if(pending && pending.sig === sig){
      // Same intent the module is already asking about (still debouncing, or already in
      // flight) — join it rather than mint a second request.
      pending.callbacks.push(callbacks);
      if(pending.timer){
        clearTimeout(pending.timer);
        const record = pending;
        record.timer = setTimeout(function(){ record.timer = null; doFetch(record); }, DEBOUNCE_MS);
      }
      return;
    }

    // A different intent supersedes whatever was pending, including an in-flight fetch for it
    // — its callbacks are simply orphaned; settle()'s requestId guard makes that safe even if
    // that old fetch is already underway and lands later.
    if(pending && pending.timer) clearTimeout(pending.timer);
    track(intent, sig, [callbacks]);
  }

  window.CH_PRICING = {
    estimate: estimate,
    available: function(){ return available; }
  };
})();
