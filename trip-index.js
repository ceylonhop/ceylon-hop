/* ============================================================
   CEYLON HOP — /trip/ index: "Leaving from" chip filter
   ============================================================
   Progressive enhancement only. Without this file (or with JS off) the
   ".fchips" chips are plain in-page anchors: clicking one just jumps to
   that origin's <section id="from-...">  — still a full, working way to
   find a route (see web-tests/unit/trip-index.test.js, "chips are anchor
   links that work without JS").

   With JS on, a click instead shows only the matching "section.origin"
   block and hides the rest via the `hidden` attribute — no navigation, no
   scroll jump. Every route link stays in the DOM the whole time (nothing
   is removed or unlinked; hidden sections are just display:none), so this
   never touches SEO/crawlability or the link count.
   ============================================================ */
(function () {
  'use strict';
  var chips = Array.prototype.slice.call(document.querySelectorAll('.fchips [data-from]'));
  var blocks = Array.prototype.slice.call(document.querySelectorAll('section.origin'));
  if (!chips.length || !blocks.length) return;

  chips.forEach(function (chip) {
    chip.setAttribute('role', 'button');
    chip.setAttribute('aria-pressed', String(chip.getAttribute('data-from') === ''));
    chip.addEventListener('click', function (e) {
      e.preventDefault();
      var k = chip.getAttribute('data-from');
      chips.forEach(function (c) { c.setAttribute('aria-pressed', String(c === chip)); });
      blocks.forEach(function (b) { b.hidden = !!k && b.getAttribute('data-origin') !== k; });
    });
  });
})();
