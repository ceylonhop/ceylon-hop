/* ============================================================
   CEYLON HOP — /trip/ index: "Leaving from" chip filter + hero form
   ============================================================
   Progressive enhancement only. Without this file (or with JS off) the
   ".fchips" chips are plain in-page anchors: clicking one just jumps to
   that origin's <section id="from-...">  — still a full, working way to
   find a route (see web-tests/unit/trip-index.test.js, "chips are anchor
   links that work without JS"). The hero form is a plain GET to
   search.html with JS off — it submits whatever text is in the field, and
   search.html already handles a free-typed name via its own engine path
   (see the F4 note below).

   With JS on, activating a chip instead shows only the matching
   "section.origin" block and hides the rest via the `hidden` attribute — no
   navigation, no scroll jump on its own. Every route link stays in the DOM
   the whole time (nothing is removed or unlinked; hidden sections are just
   display:none), so this never touches SEO/crawlability or the link count.

   Keyboard: the chips are declared role="button", so a screen-reader user is
   told "button" — but a plain <a> only fires a click on Enter natively; Space
   does nothing by default (or worse, scrolls the page, since the browser
   treats an unhandled Space as "page down"). Both keys are wired to the SAME
   activation function as the click handler below, and Space is
   preventDefault()-ed so it never falls through to a page scroll.

   Filter-result scroll: the chip row is sticky, so people often filter while
   scrolled well down the page. Hiding most of "section.origin" blocks can
   shrink the document a lot, and the browser clamps scrollY to the new
   (shorter) max — which can leave the viewport stuck on the closing band or
   footer, with the block you just picked scrolled off above it. After each
   activation, if "#routes" has scrolled above the viewport we bring it back
   to just under the sticky row (measured from that row's own height, never a
   magic number); if it's already on screen we leave scroll position alone —
   nobody filtering from the top of the page should feel a jump.

   F5 — arriving at #from-<id> (a bookmark, a shared link, back/forward):
   site.css gives "section.origin" and "#routes" scroll-margin-top so the
   browser's own fragment scroll already clears the sticky chip row (works
   with JS off too). But with JS on, "Everywhere" was still shown as pressed
   and nothing was filtered — the hash positioned the page, the chip state
   never caught up. On load, if the hash names a chip that exists, we
   activate it WITHOUT calling keepRoutesInView(): the browser has already
   put the target where it belongs, so re-running our own "bring it back
   under the sticky row" scroll would fight that positioning instead of
   leaving it alone.

   F4 — the hero form must submit a catalogue ID, not a typed name, whenever
   the two agree. search.js resolves from/to by ID (T.place(id)); a NAME it
   can't match falls to its "engine" path, which prices the route but never
   shows the shared-seat card even where one exists (shared is only looked
   up by ID) — so a customer who typed "Colombo Airport (CMB)" instead of
   picking cmb-airport can lose a real $27.49 shared seat for no reason. The
   datalist's <option> now carries the id as data-id (tools/generate-route-
   pages.mjs's faresForm()). On submit we take over with preventDefault(),
   trim each input and look for an EXACT, case-insensitive match against an
   option's value; a match submits that option's data-id instead of the
   typed text, and anything that doesn't match — a free-typed place like
   "My Hotel, Weligama Bay" — is submitted unchanged, exactly as search.html
   already handles it. No try/catch (house style for this file — a thrown
   error here isn't expected to be silently swallowed).
   ============================================================ */
(function () {
  'use strict';
  var chips = Array.prototype.slice.call(document.querySelectorAll('.fchips [data-from]'));
  var blocks = Array.prototype.slice.call(document.querySelectorAll('section.origin'));

  if (chips.length && blocks.length) {
    var routes = document.getElementById('routes');
    var sticky = document.querySelector('.fromsticky');

    var keepRoutesInView = function () {
      if (!routes) return;
      var r = routes.getBoundingClientRect();
      if (r.top >= 0) return; // already on screen (or below) — don't jump someone who hasn't scrolled past it
      var stickyH = sticky ? sticky.getBoundingClientRect().height : 0;
      // site.css sets html{scroll-behavior:smooth} globally; 'instant' keeps this deterministic
      // (a smooth scroll would leave the very next geometry read mid-animation).
      window.scrollTo({ top: window.scrollY + r.top - stickyH, left: 0, behavior: 'instant' });
    };

    var activate = function (chip, skipScroll) {
      var k = chip.getAttribute('data-from');
      chips.forEach(function (c) { c.setAttribute('aria-pressed', String(c === chip)); });
      blocks.forEach(function (b) { b.hidden = !!k && b.getAttribute('data-origin') !== k; });
      if (!skipScroll) keepRoutesInView();
    };

    chips.forEach(function (chip) {
      chip.setAttribute('role', 'button');
      chip.setAttribute('aria-pressed', String(chip.getAttribute('data-from') === ''));
      chip.addEventListener('click', function (e) {
        e.preventDefault();
        activate(chip, false);
      });
      chip.addEventListener('keydown', function (e) {
        if (e.key === ' ' || e.key === 'Spacebar' || e.key === 'Space' || e.keyCode === 32) {
          e.preventDefault();
          activate(chip, false);
        }
      });
    });

    // F5(b): the hash already positioned the page (or, with no-JS, would have) — activate
    // the matching chip's STATE only, and skip the "bring #routes back under the sticky row"
    // scroll that a click does, so we don't fight the position the browser already found.
    var hashMatch = /^#from-(.+)$/.exec(String(window.location.hash || ''));
    if (hashMatch) {
      var wanted = hashMatch[1];
      var target = null;
      for (var i = 0; i < chips.length; i++) {
        if (chips[i].getAttribute('data-from') === wanted) { target = chips[i]; break; }
      }
      if (target) activate(target, true);
    }
  }

  // F4: teach the hero form to submit a catalogue id when the typed text is an exact
  // (case-insensitive) match for a place name, so search.html takes the fast, ID-based path
  // that can show a shared seat instead of falling to its engine path.
  var form = document.querySelector('form.ix-form');
  if (form) {
    var listId = form.querySelector('input[list]').getAttribute('list');
    var datalist = document.getElementById(listId);
    var options = datalist ? Array.prototype.slice.call(datalist.querySelectorAll('option')) : [];

    // The site's place picker (site.js), when it loaded: the same menu the home hero uses.
    // The datalist stays in the HTML only as the no-JS fallback; left attached, Chrome would
    // open its own list on top of ours.
    var fields = form.querySelectorAll('input[list]');
    if (typeof window.attachLocalPlaceAutocomplete === 'function' && window.TRANSFERS) {
      for (var f = 0; f < fields.length; f++) {
        fields[f].removeAttribute('list');
        window.attachLocalPlaceAutocomplete(fields[f]);
      }
    }

    var resolveField = function (raw) {
      // resolvePlaceInput also knows the catalogue's aliases ("Airport", "Sigiriya") — the
      // same answer the home hero submits.
      if (typeof window.resolvePlaceInput === 'function' && window.TRANSFERS) {
        var r = window.resolvePlaceInput(raw);
        if (r.known) return r.id;
      }
      var trimmed = String(raw).trim();
      var lower = trimmed.toLowerCase();
      for (var i = 0; i < options.length; i++) {
        if (String(options[i].getAttribute('value')).trim().toLowerCase() === lower) {
          return options[i].getAttribute('data-id');
        }
      }
      return trimmed; // free-typed place — search.html's own engine path handles this
    };

    form.addEventListener('submit', function (e) {
      // Native `required` validation has already run by the time 'submit' fires — an empty
      // field never gets here at all, so nothing extra is needed to keep that behaviour.
      e.preventDefault();
      var fromInput = form.querySelector('input[name="from"]');
      var toInput = form.querySelector('input[name="to"]');
      var params = new URLSearchParams();
      params.set('from', resolveField(fromInput.value));
      params.set('to', resolveField(toInput.value));
      window.location.href = form.getAttribute('action') + '?' + params.toString();
    });
  }
})();
