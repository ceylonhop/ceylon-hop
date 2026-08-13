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
  var TA = {
    reviews: 31,
    url: 'https://www.tripadvisor.com/Attraction_Review-g3736162-d33018957-Reviews-Ceylon_Hop-Seeduwa_Western_Province.html'
  };
  window.TA = TA;

  // Real reviews from the listing above, owner-picked 2026-08-13. The homepage previously
  // showed three invented testimonials under a "5.0 on Tripadvisor" heading, which read as
  // if Tripadvisor's travellers had written them.
  //
  // QUOTED VERBATIM — do not fix the typos, spacing or punctuation. These are travellers'
  // own words and the whole point is that they are theirs. If a card overflows, trim from
  // the end with an ellipsis; never reword. `written` is the review's own date, shown on
  // the card so a quote can't imply it is more current than it is.
  TA.quotes = [
    {
      name: 'Marie-Eve W',
      where: '',                       // no location on this reviewer's profile — card omits the line
      written: 'August 2026',
      text: 'We loved Ceylon Hop ! We loved it so much we ended up using it 3 times during our trip for the big travel days we had! The van had AC and were very comfortable! The driver could make stops you wanted no problem!'
    },
    {
      name: 'brydaitom',
      where: 'Melbourne, Australia',
      written: 'March 2026',
      text: '2 x couples spent 14 days going to the usual tourist places e.g. Sigiriya, Kandy, Ella, Tissa and South Coast. Excellent drivers, good vehicles, prompt,flexible and great communication. Also, good value for money'
    },
    {
      name: 'carlasgs1709',
      where: 'Sri Lanka',
      written: 'September 2025',
      text: 'I had a great trip thanks to Ceylon Hop. The van was air-conditioned, there were four of us, and we were able to split the cost. The driver was lovely, punctual, and assistance was available. It’s a truly trustworthy company. I recommend it 100%!'
    }
  ];

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
