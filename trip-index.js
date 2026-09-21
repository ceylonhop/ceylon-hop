/* ============================================================
   CEYLON HOP — /trip/ index: "Leaving from" chip filter
   ============================================================
   Progressive enhancement only. Without this file (or with JS off) the
   ".fchips" chips are plain in-page anchors: clicking one just jumps to
   that origin's <section id="from-...">  — still a full, working way to
   find a route (see web-tests/unit/trip-index.test.js, "chips are anchor
   links that work without JS").

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
   ============================================================ */
(function () {
  'use strict';
  var chips = Array.prototype.slice.call(document.querySelectorAll('.fchips [data-from]'));
  var blocks = Array.prototype.slice.call(document.querySelectorAll('section.origin'));
  if (!chips.length || !blocks.length) return;

  var routes = document.getElementById('routes');
  var sticky = document.querySelector('.fromsticky');

  function keepRoutesInView() {
    if (!routes) return;
    var r = routes.getBoundingClientRect();
    if (r.top >= 0) return; // already on screen (or below) — don't jump someone who hasn't scrolled past it
    var stickyH = sticky ? sticky.getBoundingClientRect().height : 0;
    // site.css sets html{scroll-behavior:smooth} globally; 'instant' keeps this deterministic
    // (a smooth scroll would leave the very next geometry read mid-animation).
    window.scrollTo({ top: window.scrollY + r.top - stickyH, left: 0, behavior: 'instant' });
  }

  function activate(chip) {
    var k = chip.getAttribute('data-from');
    chips.forEach(function (c) { c.setAttribute('aria-pressed', String(c === chip)); });
    blocks.forEach(function (b) { b.hidden = !!k && b.getAttribute('data-origin') !== k; });
    keepRoutesInView();
  }

  chips.forEach(function (chip) {
    chip.setAttribute('role', 'button');
    chip.setAttribute('aria-pressed', String(chip.getAttribute('data-from') === ''));
    chip.addEventListener('click', function (e) {
      e.preventDefault();
      activate(chip);
    });
    chip.addEventListener('keydown', function (e) {
      if (e.key === ' ' || e.key === 'Spacebar' || e.key === 'Space' || e.keyCode === 32) {
        e.preventDefault();
        activate(chip);
      }
    });
  });
})();
