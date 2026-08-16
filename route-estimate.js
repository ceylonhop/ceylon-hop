/* ============================================================
   CEYLON HOP — customer-facing route estimate presentation

   Pure display policy only. This module does not calculate routes,
   choose a Maps result, or affect pricing. Consumers pass the
   authoritative distance/duration and the state it was returned in.
   ============================================================ */
(function (root) {
  'use strict';

  const MATERIAL_DISTANCE_KM = 5;
  const MATERIAL_DURATION_MIN = 15;
  const UNAVAILABLE = 'We’ll confirm the journey time after reviewing your locations.';

  function isValidMetric(value) {
    return Number.isFinite(value) && value > 0;
  }

  function roundDistanceKm(km) {
    if (!isValidMetric(km)) return null;
    return km < 20 ? Math.round(km) : Math.round(km / 5) * 5;
  }

  function roundDurationMin(minutes) {
    if (!isValidMetric(minutes)) return null;
    if (minutes < 60) return Math.max(5, Math.round(minutes / 5) * 5);
    if (minutes < 240) return Math.round(minutes / 15) * 15;
    return Math.round(minutes / 30) * 30;
  }

  function durationWords(rawMinutes) {
    const rounded = roundDurationMin(rawMinutes);
    if (rounded == null) return '';
    // Preserve the short-journey unit even when 58–59 minutes rounds to 60. It reads as an
    // honest short-trip estimate instead of crossing presentation bands because of rounding.
    if (rawMinutes < 60) return `${rounded} minutes`;

    const hours = Math.floor(rounded / 60);
    const minutes = rounded % 60;
    if (minutes === 0) return `${hours} hour${hours === 1 ? '' : 's'}`;
    if (minutes === 30) return `${hours}½ hours`;
    return `${hours} hour${hours === 1 ? '' : 's'} ${minutes} minutes`;
  }

  function estimateDetails(distanceKm, durationMin) {
    const roundedKm = roundDistanceKm(distanceKm);
    const duration = durationWords(durationMin);
    const parts = [];
    if (roundedKm != null) parts.push(`Approx. ${roundedKm} km`);
    if (duration) parts.push(`${parts.length ? 'around' : 'Around'} ${duration}`);
    return parts.join(' · ');
  }

  function lowerFirst(value) {
    return value ? value.charAt(0).toLowerCase() + value.slice(1) : value;
  }

  function formatRouteEstimate(input) {
    const route = input || {};
    const state = route.state || 'browse';
    if (state === 'unavailable') return UNAVAILABLE;

    const details = estimateDetails(route.distanceKm, route.durationMin);
    if (state === 'estimated') {
      return details
        ? `Estimated journey — ${lowerFirst(details)}. Final route confirmed before payment.`
        : 'Estimated journey — final route confirmed before payment';
    }
    if (!details) return UNAVAILABLE;
    if (state === 'exact') {
      return `Updated for your pickup and destination: ${lowerFirst(details)}`;
    }
    return details;
  }

  function hasEstimate(route) {
    return !!route && (isValidMetric(route.distanceKm) || isValidMetric(route.durationMin));
  }

  function isMaterialRouteChange(previous, next) {
    const hadEstimate = hasEstimate(previous);
    const hasNextEstimate = hasEstimate(next);
    if (hadEstimate !== hasNextEstimate) return true;
    if (!hadEstimate) return false;

    const distanceChanged = isValidMetric(previous.distanceKm) && isValidMetric(next.distanceKm)
      ? Math.abs(previous.distanceKm - next.distanceKm) >= MATERIAL_DISTANCE_KM
      : isValidMetric(previous.distanceKm) !== isValidMetric(next.distanceKm);
    const durationChanged = isValidMetric(previous.durationMin) && isValidMetric(next.durationMin)
      ? Math.abs(previous.durationMin - next.durationMin) >= MATERIAL_DURATION_MIN
      : isValidMetric(previous.durationMin) !== isValidMetric(next.durationMin);
    return distanceChanged || durationChanged;
  }

  const api = {
    MATERIAL_DISTANCE_KM,
    MATERIAL_DURATION_MIN,
    formatRouteEstimate,
    isMaterialRouteChange,
    roundDistanceKm,
    roundDurationMin,
  };

  root.CH = root.CH || {};
  root.CH.routeEstimate = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
