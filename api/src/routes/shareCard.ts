import { Hono, type Context } from 'hono';
import { Resvg } from '@resvg/resvg-js';
import { fileURLToPath } from 'node:url';
import type { RideListRepo, RideListWithMembers } from '../db/rideListRepo';
import { committedSeats } from '../domain/rideList';
import { cardModel, cardSvg } from './shareCardImage';

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
export type RideCopy = ShareCopy & {
  lead: string; leadSub: string; hot: boolean; price: string; deadline: string;
  when: string; locked: boolean;
};

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
  const { title, description } = rideCopy(found);
  return { title, description };
}

/**
 * Every phrase the share link uses, in one place: the chat preview and the card image
 * must never disagree about how many seats are left.
 *
 * The lead is whichever number is the actual ask — below the threshold it is how many
 * more names make the van roll; above it, how many seats are still for sale.
 */
export function rideCopy(found: RideListWithMembers): RideCopy {
  const { list } = found;
  const taken = committedSeats(found.members);
  const left = Math.max(0, list.capacity - taken);
  const need = Math.max(0, list.minSeats - taken);
  const locked = list.status === 'confirmed' || need === 0;
  const full = locked && left === 0;
  const route = `${list.fromPlace} → ${list.toPlace}`;
  const when = shortDate(list.date);
  const price = `≈${money(list.seatPrice)}`;

  let lead: string;
  let leadSub: string;
  let hot = false;
  if (full) {
    lead = 'Van locked in';
    leadSub = 'This one is full — start the next van on the same route.';
  } else if (locked) {
    lead = `${left} seat${left === 1 ? '' : 's'} left`;
    hot = left === 1;
    leadSub = left === 1
      ? 'Take it and the van is full — everyone rolls.'
      : 'The van is locked in. These seats are still going.';
  } else if (need === 1) {
    lead = '1 more and it rolls';
    leadSub = `${taken} on board. One more name locks the van in.`;
  } else {
    lead = `${need} more and it rolls`;
    leadSub = `${taken} on board so far. ${need} more names and it is on.`;
  }

  const deadline = full
    ? `Departs ${when}`
    : `Closes ${deadlineText(list.cutoffAt)}`;

  const description = full
    ? `${taken} of ${list.capacity} seats taken at ${money(list.seatPrice)} each. This van is full — start the next one on the same route.`
    : `${price} for your seat. $0 to join — you're only charged if the van fills. Closes ${deadlineText(list.cutoffAt)}.`;

  return {
    title: `${lead} · ${route}, ${when}`,
    description, lead, leadSub, hot, price, deadline, when, locked: full,
  };
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

/**
 * Brand fonts are vendored (OFL) and loaded explicitly: the rasterizer reads only
 * TTF/OTF, and a Render container has no system fonts to fall back on — without
 * these the card renders as a blank rectangle.
 */
const FONT_FILES = [
  'Newsreader-ExtraBold.ttf',
  'HankenGrotesk-Bold.ttf',
  'HankenGrotesk-SemiBold.ttf',
].map((f) => fileURLToPath(new URL(`../../assets/fonts/${f}`, import.meta.url)));

export function renderCard(model: Parameters<typeof cardSvg>[0]): Buffer {
  return new Resvg(cardSvg(model), {
    font: { fontFiles: FONT_FILES, loadSystemFonts: false },
    fitTo: { mode: 'width', value: 1200 },
  }).render().asPng();
}

/**
 * A ride code: two route initials and four digits (see makeCode). Mounting the share
 * routes at the root of the share domain means this pattern is the only thing standing
 * between them and every real API path, so it is deliberately tight.
 */
const CODE = /^[A-Za-z]{2}-\d{4}$/;

export interface ShareDeps {
  rideLists: RideListRepo;
  /** Customer site origin — where board.html lives. */
  siteBaseUrl: string;
  /**
   * Public origin the links are built from — the share domain (ride.ceylonhop.com) when
   * set. Unset falls back to whatever host the request arrived on, which is what keeps
   * local dev and staging self-consistent.
   */
  shareBaseUrl?: string;
}

export function shareCardRoutes(deps: ShareDeps, opts: { prefix?: string; guardCode?: boolean } = {}) {
  const r = new Hono();
  const site = deps.siteBaseUrl.replace(/\/$/, '');
  const prefix = opts.prefix ?? '/r';

  /**
   * Absolute origin for og:url / og:image / canonical.
   *
   * Render terminates TLS at its edge, so `c.req.url` inside the container is http://
   * even though the world reached us over https. Emitting an http:// og:image on an
   * https page gets the image downgraded, ignored or refused by crawlers — no preview,
   * which is the whole point of this endpoint. Trust x-forwarded-proto when present.
   */
  const origin = (c: Context): string => {
    if (deps.shareBaseUrl) return deps.shareBaseUrl.replace(/\/$/, '');
    const url = new URL(c.req.url);
    const proto = (c.req.header('x-forwarded-proto') || url.protocol.replace(':', '')).split(',')[0].trim();
    return `${proto}://${url.host}`;
  };

  // GET <prefix>/:code/card.png — the og:image itself. Declared before the catch-all.
  r.get('/:code/card.png', async (c) => {
    const code = c.req.param('code');
    if (opts.guardCode && !CODE.test(code)) return c.notFound();
    const found = await deps.rideLists.getByCode(code);
    if (!found) return c.json({ error: 'not_found' }, 404);

    const copy = rideCopy(found);
    const png = renderCard(cardModel(found, copy));

    // Chat apps re-fetch rarely; the ?s= seat count in the URL is what actually busts
    // their cache, so the image itself can be cached hard.
    return c.body(new Uint8Array(png), 200, {
      'content-type': 'image/png',
      'cache-control': 'public, max-age=300, s-maxage=300',
    });
  });

  r.get('/:code', async (c) => {
    const code = c.req.param('code');
    // At the root of the share domain this is the only thing keeping /health, /board and
    // friends out of the share handler — fall through rather than answering for them.
    if (opts.guardCode && !CODE.test(code)) return c.notFound();
    const found = await deps.rideLists.getByCode(code);
    const base = origin(c);

    if (!found) {
      // A stale link still has to unfurl — a bare domain in the chat reads as broken,
      // and the reader deserves to know the ride moved on rather than that we did.
      return c.html(
        page({
          title: 'This shared ride has closed',
          description: 'It may have already run, or the link expired. Browse the board for a ride going your way.',
          image: `${site}/og-cover.jpg`,
          canonical: `${base}${prefix}/${encodeURIComponent(code)}`,
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
        // Cache-busted on the seat count: chat apps key their cached preview off the
        // image URL, so a filling van has to change it or the card freezes at whatever
        // count it had the first time anyone pasted the link.
        image: `${base}${prefix}/${encodeURIComponent(found.list.code)}/card.png?s=${committedSeats(found.members)}`,
        canonical: `${base}${prefix}/${encodeURIComponent(found.list.code)}`,
        landing: `${site}/board.html#/${encodeURIComponent(found.list.code)}`,
      }),
    );
  });

  return r;
}
