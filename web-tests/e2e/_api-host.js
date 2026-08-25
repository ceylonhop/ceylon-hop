// "Is this request addressed to the Ceylon Hop API?" — the one definition.
//
// Four spec files grew their own copy of this predicate (ride-board load / full-van /
// share-link / payhere), which matters because the offline test server rewrites every
// live-API request to its OWN origin with the path intact (serve-booking.js). A predicate
// that only knows the HOSTNAME silently stops matching under that rewrite, un-stubs the
// spec, and the page then renders half-loaded — which is how ride-board-payhere.spec.js
// broke the moment it merged. Import this instead of writing a fifth copy.
//
// Both forms are matched on purpose, so a spec stays stubbed whether or not the rewrite is
// active (e.g. a reused dev-preview server, where it is not).
//
// Deliberately NOT "anything non-local": fonts, GTM and the GIS script must keep loading.
// The path arm is just as narrow — `board` must be followed by a slash or end-of-path, so
// /board.html and /site.css never match.
const LIVE_HOST = /(^|\.)ceylonhop\.com$/;
const LEGACY_HOST = /\.onrender\.com$/;
const API_PATH = /^\/(board|health|errors)(\/|$)/;

/** @param {URL} u */
export const isApiRequest = (u) => LIVE_HOST.test(u.hostname)
  || LEGACY_HOST.test(u.hostname)
  || API_PATH.test(u.pathname);
