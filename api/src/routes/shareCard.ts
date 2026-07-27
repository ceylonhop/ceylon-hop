import { Hono } from 'hono';
import type { RideListRepo, RideListWithMembers } from '../db/rideListRepo';
import { committedSeats } from '../domain/rideList';

/* ---------------------------------------------------------------------------
   GET /r/:code — what a chat app fetches when someone pastes a ride link.

   Its own path on purpose: /board/:code already answers JSON to board.js, and
   deciding between JSON and HTML off an Accept header is a coin-flip with
   crawlers. Everything a crawler needs is in the HTML head — they do not run
   JavaScript — and a human is bounced on to the board page.

   The deadline is always written as a fixed date, never "closes in 6h":
   WhatsApp and Facebook fetch a preview once and cache it against the URL for
   days, so a relative time would go stale and quietly lie about the ride.
--------------------------------------------------------------------------- */

export type ShareCopy = { title: string; description: string };

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const money = (cents: number): string => `$${Math.round(cents / 100)}`;

/** "Sat 15 Aug" — the ride's own date, in the reader's head, not a countdown. */
function shortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  });
}

/** "Fri 14 Aug, 9 PM" — Sri Lanka local, since that is where the van leaves from. */
function deadlineText(cutoff: Date): string {
  const day = cutoff.toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Colombo',
  });
  const time = cutoff.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Colombo',
  }).replace(':00', '');
  return `${day}, ${time}`;
}

/**
 * The words on the card. Pure, so the phrasing is testable without a request.
 *
 * The lead is whichever number is the actual ask: below the threshold it is how
 * many more names make the van roll; above it, how many seats are still for sale.
 */
export function shareCopy(found: RideListWithMembers): ShareCopy {
  const { list } = found;
  const taken = committedSeats(found.members);
  const left = Math.max(0, list.capacity - taken);
  const need = Math.max(0, list.minSeats - taken);
  const locked = list.status === 'confirmed' || need === 0;
  const route = `${list.fromPlace} → ${list.toPlace}`;
  const when = shortDate(list.date);

  let lead: string;
  if (locked && left === 0) lead = 'Van locked in';
  else if (locked) lead = `${left} seat${left === 1 ? '' : 's'} left`;
  else if (need === 1) lead = '1 more and it rolls';
  else lead = `${need} more and it rolls`;

  const price = money(list.seatPrice);
  const description = locked && left === 0
    ? `${taken} of ${list.capacity} seats taken at ${price} each. This van is full — start the next one on the same route.`
    : `≈${price} for your seat. $0 to join — you're only charged if the van fills. Closes ${deadlineText(list.cutoffAt)}.`;

  return { title: `${lead} · ${route}, ${when}`, description };
}

function page(opts: {
  title: string; description: string; image: string; canonical: string; landing: string;
}): string {
  const t = esc(opts.title);
  const d = esc(opts.description);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t}</title>
<meta name="description" content="${d}">
<link rel="canonical" href="${esc(opts.canonical)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:image" content="${esc(opts.image)}">
<meta property="og:url" content="${esc(opts.canonical)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<meta name="twitter:image" content="${esc(opts.image)}">
<meta http-equiv="refresh" content="0; url=${esc(opts.landing)}">
</head>
<body style="font-family:system-ui,sans-serif;padding:40px;text-align:center">
<p>Taking you to the ride board…</p>
<p><a href="${esc(opts.landing)}">${esc(opts.landing)}</a></p>
<script>location.replace(${JSON.stringify(opts.landing)});</script>
</body>
</html>`;
}

export function shareCardRoutes(deps: {
  rideLists: RideListRepo;
  /** Customer site origin — where board.html lives. */
  siteBaseUrl: string;
  /** This API's own origin, for absolute image/canonical URLs. */
  shareBaseUrl?: string;
}) {
  const r = new Hono();
  const site = deps.siteBaseUrl.replace(/\/$/, '');

  const origin = (reqUrl: string): string =>
    (deps.shareBaseUrl ?? new URL(reqUrl).origin).replace(/\/$/, '');

  r.get('/:code', async (c) => {
    const code = c.req.param('code');
    const found = await deps.rideLists.getByCode(code);
    const base = origin(c.req.url);

    if (!found) {
      // A stale link still has to unfurl — a bare domain in the chat reads as broken,
      // and the reader deserves to know the ride moved on rather than that we did.
      return c.html(
        page({
          title: 'This shared ride has closed',
          description: 'It may have already run, or the link expired. Browse the board for a ride going your way.',
          image: `${site}/og-cover.jpg`,
          canonical: `${base}/r/${encodeURIComponent(code)}`,
          landing: `${site}/board.html`,
        }),
        404,
      );
    }

    const { title, description } = shareCopy(found);
    return c.html(
      page({
        title,
        description,
        // The brand cover until the per-ride card renderer lands (it needs a rasterizer
        // dependency — see docs). When it does, this becomes
        //   `${base}/r/${code}/card.png?s=${taken}`
        // cache-busted on the seat count, because chat apps key their cached preview off
        // the image URL: a filling van has to change it or the card freezes at whatever
        // count it had the first time anyone pasted the link.
        image: `${site}/og-cover.jpg`,
        canonical: `${base}/r/${encodeURIComponent(found.list.code)}`,
        landing: `${site}/board.html#/${encodeURIComponent(found.list.code)}`,
      }),
    );
  });

  return r;
}
