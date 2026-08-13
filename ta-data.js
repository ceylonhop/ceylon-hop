/* ============================================================
   CEYLON HOP — Tripadvisor figures (single source)
   ============================================================
   The review count is quoted in four places: the hero badge (twice — visible text
   and its aria-label), the reviews-section pill, the pay-page trust line, and the
   ride board. Those were four hand-synced copies behind a comment asking humans to
   keep them in step. Change the number HERE and the parity test flags any stale copy.
   Keep it matching the live listing:
   https://www.tripadvisor.com/Attraction_Review-g3736162-d33018957-Reviews-Ceylon_Hop-Seeduwa_Western_Province.html
   ============================================================ */
(function () {
  var TA = { reviews: 31 };
  window.TA = TA;

  // The pages still ship the number as static text — crawlers read the source, and a
  // JS-off render should not show a blank badge. This only refreshes it, so nothing
  // flashes while the two agree.
  function paint() {
    document.querySelectorAll('[data-ta-count]').forEach(function (el) {
      el.textContent = String(TA.reviews);
    });
    document.querySelectorAll('[data-ta-count-label]').forEach(function (el) {
      var label = el.getAttribute('aria-label');
      if (!label) return;
      el.setAttribute('aria-label', label.replace(/\d+(?=\s+(?:reviews|travellers))/, TA.reviews));
    });
  }
  TA.paint = paint;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paint);
  else paint();
})();
