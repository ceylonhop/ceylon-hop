/* @generated:shortplace — from api/src/quote/shortPlace.ts · DO NOT EDIT BY HAND · run `npm run generate` */
(function (root) {
  // Short display labels for places (owner-reported 2026-08-06: full Google addresses wrap the ops
  // money pane to 3–4 lines a row, squeeze the leg inputs to "Colom…", and flow on to the pay page
  // and emails).
  //
  // DELIBERATELY TINY. An earlier design resolved every place once, stored a curated label and
  // guaranteed uniqueness across a quote — and it failed on its own terms: labels became dependent
  // on which other places were in the set, so reordering legs renamed a place, and a partial pay
  // link (whose booking covers a SUBSET of legs) showed the customer a different name than ops saw
  // for the same pickup. Correct within one render, unstable across renders.
  //
  // So: a pure function of ONE string. Same input, same output, everywhere, forever. It cannot know
  // about other places, which is exactly why it cannot be destabilised by them.
  //
  // The accepted cost: two identically-named places in one town read the same ("Villa Sunshine ·
  // Galle"). Rare, both in the same town, and ops always sees the full string in the editable field
  // and in the autocomplete — where a mis-pick would actually cost money.
  const COUNTRY_SUFFIX = /,\s*Sri Lanka\s*$/i;
  // Whole words only. "Umbrella Cafe" contains "ella"; a substring test would drop the town of Ella
  // and leave the customer unable to tell where they are being collected.
  function namesTown(venue, town) {
      const escaped = town.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${escaped}\\b`, 'i').test(venue);
  }
  /**
   * "The Den 23, Norris Canal Road, Colombo, Sri Lanka" → "The Den 23 · Colombo".
   * Render-time only — the stored string is never touched, so pricing, geocoding and the
   * place-identity guards are all unaffected.
   */
  function shortPlace(full) {
      if (!full)
          return '';
      const segments = full.trim().replace(COUNTRY_SUFFIX, '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!segments.length)
          return full.trim() ? full : '';
      if (segments.length < 2)
          return segments[0];
      const venue = segments[0];
      const town = segments[segments.length - 1];
      return namesTown(venue, town) ? venue : `${venue} · ${town}`;
  }
  // The engine bakes route labels as "A → B (car)" at pricing time (quotePrivateLegs). Both the ops
  // money pane and the pay-page receipt render those stored strings, so shortening splits on the
  // arrow we generated ourselves. A label with no arrow — "Final price adjustment" — passes through.
  //
  // The vehicle suffix is DROPPED (owner, 2026-08-06). `quotePrivateLegs` takes one `vehicle` for
  // the whole request, so the tier can never differ between legs — printing it on every row repeats
  // a per-quote fact the VEHICLE chips already state, and on a nine-leg quote it pushed rows onto
  // extra lines. The STORED label keeps it, so the tier a quote was priced on is never lost.
  const VEHICLE_SUFFIX = /\s*\((car|van\d*|custom)\)\s*$/i;
  function shortenRouteLabel(label) {
      if (!label)
          return '';
      const body = label.replace(VEHICLE_SUFFIX, '');
      if (!body.includes('→'))
          return label; // not a route row (extras, adjustments) — leave it be
      return body.split('→').map((part) => shortPlace(part.trim())).join(' → ');
  }

  root.CH = root.CH || {};
  root.CH.shortPlace = shortPlace;
  root.CH.shortenRouteLabel = shortenRouteLabel;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { shortPlace: shortPlace, shortenRouteLabel: shortenRouteLabel };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
/* @end:shortplace */
