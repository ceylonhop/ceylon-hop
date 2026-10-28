import type { EmailAdapter } from '../adapters/email';
import { SLOT_TIMES, type RideList, type Slot } from '../domain/rideList';

// ============================================================================
// Ride Board customer emails. Self-contained (a small branded shell) so this
// doesn't reach into the booking-centric notifications.ts. Sent by the cutoff
// job when a list confirms / expires / a charge fails.
// ============================================================================

// The band carries white 800-weight type, so it takes the text-safe deep accent
// (#0AB9B6 under white was 2.43:1 — the exact pattern #441 retired on the site).
// Ink is the current Bristol Black, not the pre-rebrand #2C2A2B. The rest of the
// values follow the letter family in notifications.ts (still no shared code — the
// point of this file is independence — but the same design language).
const BAND = '#24758A';
const INK = '#3A3739';
const MUTED = '#6c6a6b'; // --ink-soft
const PAPER = '#F0EEE5'; // --cream page tone, same as the letters
const CARD = '#fffdf8'; // --paper
const LINE = '#e7e3d6'; // --line
const SERIF = "'Bodoni 72', 'Bodoni Moda', Didot, Georgia, 'Times New Roman', serif";
const SANS = "'Poppins', Helvetica, Arial, sans-serif";

// Same regex as notifications.ts's esc(): every interpolated value is text, never markup.
// First names and place names are user-influenced, and an email body is exactly where a
// stray <script> must become inert.
const esc = (s: string) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

function shell(heading: string, bodyHtml: string): string {
  // Table layout, not a max-width div — Outlook's Word engine ignores max-width and
  // stretched these full-window. Head carries charset (the route arrow and 🚐 were
  // mojibake bait without one) and the light-only color-scheme declaration.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
  <style>@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700;800&display=swap');</style>
  </head><body style="margin:0;padding:0;background:${PAPER};font-family:${SANS};color:${INK}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%">
        <tr><td style="background:${BAND};color:#fff;padding:16px 20px;border-radius:14px 14px 0 0;font-weight:800;font-size:18px">Ceylon Hop · Ride Board</td></tr>
        <tr><td style="background:${CARD};border:1px solid ${LINE};border-top:none;border-radius:0 0 14px 14px;padding:22px 20px">
          <h1 style="font-family:${SERIF};font-size:22px;font-weight:700;margin:0 0 12px">${heading}</h1>
          ${bodyHtml}
        </td></tr>
        <tr><td style="color:${MUTED};font-size:12px;text-align:center;padding:16px 0 0">Ceylon Hop · shared rides across Sri Lanka</td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

// Subjects and text bodies are plain text — no entities there; html gets the escaped form.
const route = (l: RideList) => `${l.fromPlace} → ${l.toPlace}`;
const routeHtml = (l: RideList) => esc(route(l));
// Money matches the letter family's formatter (thousands separators included) —
// the old toFixed(2) disagreed with notifications.ts on $1,000+.
const money = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

// Sri Lanka is where the traveller is standing when the deadline bites, so the
// cutoff renders in Asia/Colombo — not UTC, and not the server's zone. Date and
// time are formatted together: a bare time would read as a departure.
const cutoffLabel = (at: Date) =>
  `${new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Colombo', day: 'numeric', month: 'short', year: 'numeric' }).format(at)}`
  + ` at ${new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Colombo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)}`;

// The window a list is gathering for, before a single time is pinned at lock.
const slotWindow = (slot: string) => {
  const times = SLOT_TIMES[slot as Slot];
  return times ? `${times[0]}–${times[times.length - 1]}` : slot;
};

const seatsLabel = (seats: number) => (seats > 1 ? `${seats} seats` : '1 seat');

export async function sendRideConfirmed(
  email: EmailAdapter,
  // payLater: the traveller who started the ride gave no card (domain/rideList.ts paysByLink),
  // so nothing was charged — ops sends them a payment link.
  args: { to: string; firstName: string; list: RideList; lockedTime: string; payLater?: boolean },
): Promise<void> {
  const { list } = args;
  const pay = args.payLater
    ? `${money(list.seatPrice)} per seat — we'll send you a payment link shortly.`
    : `${money(list.seatPrice)} per seat, charged now.`;
  await email.send({
    to: args.to,
    subject: `It's on! Your ${route(list)} ride is confirmed`,
    html: shell(
      `It's on, ${esc(args.firstName)}! 🚐`,
      `<p>Enough travellers joined — your shared taxi is confirmed.</p>
       <p><b>${routeHtml(list)}</b><br>${esc(list.date)} · departs <b>${esc(args.lockedTime)}</b><br>${esc(pay)}</p>
       <p>We'll email your driver's name and WhatsApp the evening before. See you at the pickup!</p>`,
    ),
    text: `It's on, ${args.firstName}! Your ${route(list)} ride is confirmed for ${list.date}, departs ${args.lockedTime}. ${args.payLater ? pay : `${money(list.seatPrice)} per seat.`}`,
  });
}

export async function sendRideCancelled(
  email: EmailAdapter,
  // payLater: a starter who gave no card has no hold to release.
  args: { to: string; firstName: string; list: RideList; payLater?: boolean },
): Promise<void> {
  const { list } = args;
  const released = args.payLater ? 'nothing to do.' : 'the card hold is released, nothing to do.';
  await email.send({
    to: args.to,
    subject: `Your ${route(list)} ride has been called off — you weren't charged`,
    html: shell(
      `Not enough names this time`,
      `<p>Hi ${esc(args.firstName)}, not enough travellers joined your <b>${routeHtml(list)}</b> ride on ${esc(list.date)} by the cutoff, so it's been <b>called off</b>.</p>
       <p><b>You were not charged</b> — ${released}</p>
       <p>Plenty of other routes are gathering names — start or join another anytime. It's always $0 unless the ride runs.</p>`,
    ),
    text: `Hi ${args.firstName}, not enough travellers joined your ${route(list)} ride on ${list.date}, so it's been called off. You were not charged${args.payLater ? '' : ' — the hold is released'}. Start or join another anytime; $0 unless it runs.`,
  });
}

// The van was called off AFTER this traveller's card had already been charged: enough seats
// were held to start charging, then enough of those charges failed to drop the list below its
// minimum. sendRideCancelled is wrong for them — its subject is "you weren't charged" — so
// they get this instead. Says the charge happened, that the refund is ours to make and not
// theirs to chase, and how long it takes to appear.
export async function sendRideCalledOffRefundDue(
  email: EmailAdapter,
  args: { to: string; firstName: string; list: RideList },
): Promise<void> {
  const { list } = args;
  await email.send({
    to: args.to,
    subject: `Your ${route(list)} ride was called off — your refund is on the way`,
    html: shell(
      `Called off — we're refunding you`,
      `<p>Hi ${esc(args.firstName)}, not enough travellers made it onto your <b>${routeHtml(list)}</b> ride on ${esc(list.date)}, so it's been <b>called off</b>.</p>
       <p><b>Your card was charged before that happened, and we are refunding it in full.</b> You don't need to do anything — the money goes back to the card you paid with, and it usually appears within 5–10 working days depending on your bank.</p>
       <p>We're sorry — this isn't how it's meant to go. If you'd like a hand finding another way to travel that day, just reply to this email and we'll sort you out.</p>`,
    ),
    text: `Hi ${args.firstName}, not enough travellers made it onto your ${route(list)} ride on ${list.date}, so it's been called off. Your card was charged before that happened and we are refunding it in full — you don't need to do anything. It usually appears within 5-10 working days. Reply to this email if you'd like help travelling that day another way.`,
  });
}

export async function sendRideAtRisk(
  email: EmailAdapter,
  args: { to: string; firstName: string; list: RideList },
): Promise<void> {
  const { list } = args;
  await email.send({
    to: args.to,
    subject: `Action needed: your seat on ${route(list)} is at risk`,
    html: shell(
      `Your card couldn't be charged`,
      `<p>Hi ${esc(args.firstName)}, the taxi for <b>${routeHtml(list)}</b> on ${esc(list.date)} is confirmed, but we couldn't charge your card for your seat.</p>
       <p>Reply and we'll sort a fresh payment so you keep your spot.</p>`,
    ),
    text: `Hi ${args.firstName}, we couldn't charge your card for your ${route(list)} seat on ${list.date}. Reply to keep your spot.`,
  });
}


// ----------------------------------------------------------------------------
// The joiner's receipt wears the customer LETTER (notifications.ts page()), not the
// band shell above. It is the first thing a traveller ever receives from the board and
// it sits in their inbox beside the booking letters, so it has to read as the same
// company: blue rule, monogram masthead, eyebrow + serif headline, reference chip and
// status pill, the journey line, hairline facts, serif total, cream info box, pill CTA.
// Values are copied, not imported — this file stays independent of the booking-centric
// notifications.ts by design (shared design language, no shared code).
// ----------------------------------------------------------------------------
const BLUE = '#63BFD6'; // Bachelor Button — the sender-identifying rule
const TEAL = '#0AB9B6'; // route start marker (graphic only, never type)
const TOMATO = '#EC3A24'; // route end marker (graphic only)
const FAINT = '#8a8272'; // --ink-faint
const ROUTE_LINE = '#dcc9a9';
const MONO = "'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace";
const EYEBROW = `font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:${FAINT};font-weight:600`;

// Same formatter as the letters' fmtDate: "Fri, 14 Aug 2026". Noon anchors the
// calendar date so no zone can roll it a day either way.
const fmtDate = (d: string) => {
  const dt = new Date(`${d}T12:00:00`);
  if (Number.isNaN(dt.getTime())) return d;
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(dt);
};

function letter(inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
  <style>@import url('https://fonts.googleapis.com/css2?family=Bodoni+Moda:opsz,wght@6..96,400;6..96,500;6..96,600;6..96,700&family=Poppins:wght@400;500;600;700;800&display=swap');</style>
  </head><body style="margin:0;padding:0;background:${PAPER};font-family:${SANS};color:${INK};-webkit-font-smoothing:antialiased">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};padding:26px 12px">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${CARD};border:1px solid ${LINE};border-radius:18px;overflow:hidden">
        ${inner}
      </table>
    </td></tr>
  </table></body></html>`;
}

const dot = (color: string) => `<div style="width:11px;height:11px;border-radius:50%;background:${color}"></div>`;

const factRow = (k: string, v: string) => `<tr>
  <td style="padding:11px 12px 11px 0;border-top:1px solid ${LINE};color:${MUTED};font-size:14px;white-space:nowrap">${esc(k)}</td>
  <td align="right" style="padding:11px 0;border-top:1px solid ${LINE};color:${INK};font-size:14px;font-weight:600">${esc(v)}</td>
</tr>`;

/** The receipt for adding your name. A joiner has a card preapproved against a ride
 *  that may never run, so this is the only record they hold of what was committed,
 *  what it will cost, when the decision lands — and how to get back to the page that
 *  can take their name off again. Sent on join and on starting a list. */
export async function sendRideJoined(
  email: EmailAdapter,
  // payLater: the starter gave no card (domain/rideList.ts paysByLink) — a link comes if it runs.
  args: { to: string; firstName: string; list: RideList; seats: number; rideUrl: string; payLater?: boolean },
): Promise<void> {
  const { list, seats } = args;
  const total = list.seatPrice * Math.max(1, seats);
  const cutoff = cutoffLabel(list.cutoffAt);
  const url = esc(args.rideUrl);
  const date = fmtDate(list.date);

  const html = letter(`
    <tr><td style="padding:0"><div style="height:5px;line-height:5px;font-size:0;background:${BLUE}">&nbsp;</div></td></tr>
    <tr><td style="padding:26px 34px 0">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td valign="middle" style="padding-right:11px">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td width="34" height="34" align="center" valign="middle" style="background:${BAND};border-radius:50%;color:#ffffff;font-family:${SERIF};font-size:19px;font-weight:600">C</td>
          </tr></table>
        </td>
        <td valign="middle">
          <div style="font-family:${SERIF};font-size:19px;font-weight:600;color:${INK};letter-spacing:.01em">Ceylon Hop</div>
          <div style="font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:${FAINT};margin-top:1px">Ride Board · Shared rides</div>
        </td>
      </tr></table>
    </td></tr>

    <tr><td style="padding:26px 34px 0">
      <div style="font-size:11px;font-weight:600;letter-spacing:.2em;text-transform:uppercase;color:${BAND}">Your name is down</div>
      <h1 style="margin:9px 0 0;font-family:${SERIF};font-size:31px;line-height:1.12;font-weight:500;color:${INK}">You're on the list, ${esc(args.firstName)}.</h1>
      <p style="margin:10px 0 0;color:${MUTED};font-size:15px;line-height:1.6">We're gathering travellers for your shared van now. ${args.payLater
        ? `<b style="color:${INK}">No card needed and nothing charged.</b> If the van runs, we'll send you a payment link.`
        : `<b style="color:${INK}">No ride fare has been charged.</b> PayHere may show a small card-verification charge, which is reversed automatically.`}</p>
    </td></tr>

    <tr><td style="padding:18px 34px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td valign="middle">
          <span style="display:inline-block;font-family:${MONO};font-size:13px;letter-spacing:.16em;color:${BAND};border:1px solid #d7ece7;background:#f3faf8;border-radius:7px;padding:6px 12px">${esc(list.code)}</span>
        </td>
        <td valign="middle" align="right"><span style="display:inline-block;background:#fff6e8;color:#8a5a12;border-radius:999px;padding:5px 12px;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase">Gathering names</span></td>
      </tr></table>
    </td></tr>

    <tr><td style="padding:24px 34px 0">
      <div style="border-top:1px solid ${LINE};padding-top:22px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><td align="left" style="${EYEBROW}">From</td><td align="right" style="${EYEBROW}">To</td></tr>
          <tr>
            <td align="left" style="font-family:${SERIF};font-size:19px;font-weight:600;color:${INK};padding-top:2px">${esc(list.fromPlace)}</td>
            <td align="right" style="font-family:${SERIF};font-size:19px;font-weight:600;color:${INK};padding-top:2px">${esc(list.toPlace)}</td>
          </tr>
          <tr><td colspan="2" style="padding-top:13px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr valign="middle">
              <td width="12">${dot(TEAL)}</td>
              <td width="50%"><div style="height:2px;background:${ROUTE_LINE};font-size:0;line-height:0">&nbsp;</div></td>
              <td align="center" width="1" style="padding:0 2px"><div style="display:inline-block;font-size:10px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:${MUTED};background:${CARD};border:1px solid #e7dcc7;border-radius:999px;padding:4px 12px;white-space:nowrap">Shared ride</div></td>
              <td width="50%"><div style="height:2px;background:${ROUTE_LINE};font-size:0;line-height:0">&nbsp;</div></td>
              <td width="12" align="right">${dot(TOMATO)}</td>
            </tr></table>
          </td></tr>
        </table>
      </div>
    </td></tr>

    <tr><td style="padding:20px 34px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${factRow('Date', date)}
        ${factRow('Departs', `Between ${slotWindow(list.slot)}`)}
        ${factRow('Your seats', seatsLabel(seats))}
        ${factRow('Runs if', `${list.minSeats} seats are pledged`)}
        ${factRow('Names close', cutoff)}
      </table>
    </td></tr>

    <tr><td style="padding:0 34px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid #eadfce">
        <tr>
          <td style="padding:15px 0 4px;font-family:${SERIF};font-size:16px;font-weight:600;color:${INK}">${args.payLater ? 'You pay only if it runs' : 'Charged only if it runs'}</td>
          <td align="right" style="padding:15px 0 4px;font-family:${SERIF};font-size:21px;font-weight:600;color:${INK}">${money(total)}</td>
        </tr>
      </table>
      <p style="margin:6px 0 0;color:${FAINT};font-size:13px;line-height:1.6">If not enough travellers join by then, the ride is called off and you pay nothing. The exact departure time is set when the van locks. Times are Sri Lanka time.</p>
    </td></tr>

    <tr><td style="padding:26px 34px 0">
      <div style="background:#faf5ea;border:1px solid #efe6d6;border-radius:14px;padding:20px 22px">
        <div style="font-family:${SERIF};font-size:16px;font-weight:600;color:${INK};margin-bottom:6px">Changed your plans?</div>
        <p style="margin:0 0 14px;color:${MUTED};font-size:14px;line-height:1.6">Open your ride and scratch your name off any time before names close — no questions, no charge. It's also where you invite a friend to fill the van faster.</p>
        <table role="presentation" cellpadding="0" cellspacing="0">
          <tr><td bgcolor="${BAND}" style="border-radius:999px">
            <a href="${url}" style="display:inline-block;padding:12px 24px;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px">View your ride</a>
          </td></tr>
        </table>
      </div>
    </td></tr>

    <tr><td style="padding:26px 34px 32px">
      <div style="border-top:1px solid ${LINE};padding-top:18px;font-size:13px;line-height:1.6;color:${FAINT}">
        <span style="font-family:${SERIF};color:${MUTED}">Ceylon Hop</span> &middot; Ground transport across Sri Lanka.<br>
        Just reply to this email, or message us on WhatsApp &mdash; a real person answers.
      </div>
    </td></tr>`);

  await email.send({
    to: args.to,
    subject: `You're on the list — ${route(list)}, ${date}`,
    html,
    text: `You're on the list, ${args.firstName}. ${route(list)} on ${date}, departs ${slotWindow(list.slot)}. `
      + `${seatsLabel(seats)} · ride ${list.code}. `
      + (args.payLater
        ? `No card needed and nothing charged — if the van runs, we'll send you a payment link. You pay ${money(total)} only if `
        : `No ride fare has been charged (PayHere may show a small card-verification charge, which is reversed automatically) — we take ${money(total)} only if `)
      + `at least ${list.minSeats} seats are pledged by the cutoff and the van runs. Names close ${cutoff} (Sri Lanka time). `
      + `View your ride or scratch your name off: ${args.rideUrl}`,
  });
}

// ----------------------------------------------------------------------------
// "How to fill your van" (owner ask 2026-10-27; design signed off 2026-10-28). Sent by the
// fill-tip sweep (rideBoardFillTips.ts) a day after a traveller joins a ride that is still
// short. The definitive guide, in the order that works: Facebook groups, WhatsApp groups,
// a story, Reddit — each with the post written and the tagged link already inside the
// button. Honest about the deal (a bit of posting saves the private-car fare), never
// pushy, and the $0 safety net at the end. The letter shell, so it sits beside the
// receipt as the same company.
// ----------------------------------------------------------------------------
import {
  FACEBOOK_GROUPS, WHATSAPP_GROUPS, SUBREDDITS, INSTAGRAM_HANDLE,
  taggedRideLink, storyImageLink, boardRideLink, sharePost, whatsappShareLink, redditSubmitLink,
} from './rideBoardShareTargets';

// The site's own monospace stack (site.css), not a third face the site never loads.
const MONO_SITE = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
const FB_BLUE = '#1877F2';
const WA_GREEN = '#075E54'; // WhatsApp's dark teal: white on it clears 7:1 (opsEmail.ts)
const REDDIT = '#FF4500';

const pill = (href: string, label: string, bg: string, fg = '#ffffff') =>
  `<a href="${esc(href)}" style="display:inline-block;background:${bg};color:${fg};border-radius:999px;padding:9px 16px;font-weight:700;font-size:13px;text-decoration:none;white-space:nowrap">${esc(label)}</a>`;

const stepHead = (n: number, title: string, rank: string) => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td valign="top" width="44"><div style="width:34px;height:34px;border-radius:50%;background:${BAND};color:#fff;font-weight:800;font-size:16px;text-align:center;line-height:34px">${n}</div></td>
    <td valign="top">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font-family:${SERIF};font-size:21px;font-weight:600;color:${INK}">${esc(title)}</td>
        <td align="right" style="white-space:nowrap;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${BAND}">${esc(rank)}</td>
      </tr></table>`;
const stepTail = `</td></tr></table>`;

const groupRow = (name: string, blurb: string, button: string, last: boolean) => `
  <tr>
    <td style="padding:12px 0;border-top:1px solid ${LINE}${last ? `;border-bottom:1px solid ${LINE}` : ''}"><b>${esc(name)}</b><div style="font-size:12px;color:${FAINT};margin-top:2px">${esc(blurb)}</div></td>
    <td align="right" style="padding:12px 0 12px 12px;border-top:1px solid ${LINE}${last ? `;border-bottom:1px solid ${LINE}` : ''};white-space:nowrap">${button}</td>
  </tr>`;

export async function sendRideFillTip(
  email: EmailAdapter,
  args: {
    to: string;
    firstName: string;
    list: RideList;
    /** Live seats on the list now. */
    committed: number;
    /** The list's creator: their post says "I've started"; a joiner's "join me". */
    isStarter: boolean;
    /** Customer site origin, for the way back to the ride and the hero photo. */
    boardBaseUrl: string;
    /** Share origin the ride link and story image live on. */
    shareBaseUrl: string;
  },
): Promise<void> {
  const { list, firstName, isStarter } = args;
  const need = Math.max(0, list.minSeats - args.committed);
  const more = need === 1 ? '1 more person' : `${need} more people`;
  const cutoff = cutoffLabel(list.cutoffAt);
  const seat = Math.round(list.seatPrice / 100);
  const link = (source: 'whatsapp' | 'facebook' | 'reddit' | 'instagram') => taggedRideLink(args.shareBaseUrl, list.code, source);
  const fbPost = sharePost(list, need, isStarter, link('facebook'));
  const waPost = sharePost(list, need, isStarter, link('whatsapp'));
  const rdPost = sharePost(list, need, isStarter, link('reddit'));
  const story = storyImageLink(args.shareBaseUrl, list.code);
  const ride = boardRideLink(args.boardBaseUrl, list.code);
  const hero = `${args.boardBaseUrl.replace(/\/+$/, '')}/img/ride-board-fill.jpg`;
  const routeText = route(list);

  const html = letter(`
    <tr><td style="padding:0;background:${INK}">
      <img src="${esc(hero)}" width="600" alt="Travellers on a Ceylon Hop shared ride" style="width:100%;max-width:600px;height:auto;display:block">
    </td></tr>
    <tr><td style="padding:22px 28px 0;background:${BAND};color:#ffffff">
      <div style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;font-weight:700;color:#bfe6ef">${esc(more)} to fill &middot; names close ${esc(cutoff)}</div>
      <div style="margin-top:8px;font-family:${SERIF};font-size:32px;line-height:1.08;font-weight:600">How to fill your<br>${routeHtml(list)} van</div>
      <div style="margin:8px 0 22px;font-size:14px;color:#dff3f7">Three places to post. About ten minutes. We've written the posts.</div>
    </td></tr>

    <tr><td style="padding:24px 28px 0">
      <p style="margin:0;font-size:15px;line-height:1.6">Hi ${esc(firstName)}. You need ${esc(more)} for this ride to run. They're easier to find than you'd think: many of the vans that run were posted in one or two of the groups below. <b>Fill it and the trip is about $${seat} a seat instead of a private car</b>, with company for the drive.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;background:${PAPER};border-radius:12px">
        <tr><td style="padding:14px 16px;font-size:14px;line-height:1.5"><b>If you only do one thing:</b> post in the Facebook groups below. That alone fills many vans.</td></tr>
      </table>
    </td></tr>

    <tr><td style="padding:18px 28px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td bgcolor="${INK}" style="border-radius:12px;padding:12px 16px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="font-family:${MONO_SITE};font-size:14px;color:#fff;word-break:break-all">${esc(link('facebook').replace(/\?.*$/, '').replace(/^https?:\/\//, ''))}</td>
            <td align="right" style="font-size:11px;font-weight:700;color:#bfe6ef;text-transform:uppercase;letter-spacing:.1em;white-space:nowrap;padding-left:12px">Your ride link</td>
          </tr></table>
        </td></tr>
      </table>
      <p style="margin:8px 0 0;font-size:12px;color:${FAINT}">Already inside every button below. Pasted anywhere, it shows your ride card: route, date, seats left, price.</p>
    </td></tr>

    <tr><td style="padding:28px 28px 0">
      ${stepHead(1, 'Facebook groups', '●●● Works best · 5 min')}
      <p style="margin:6px 0 0;font-size:14px;line-height:1.55;color:${MUTED}">The groups travellers in Sri Lanka actually read. Tap a group, paste the post below, done.</p>
      ${stepTail}
      <div style="margin:14px 0 0;padding:12px 14px;background:${PAPER};border-radius:10px;font-size:14px;line-height:1.55">${esc(fbPost)}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;font-size:14px">
        ${FACEBOOK_GROUPS.map((g, i) => groupRow(g.name, g.blurb, pill(g.url, 'Post here', FB_BLUE), i === FACEBOOK_GROUPS.length - 1)).join('')}
      </table>
      <p style="margin:10px 0 0;font-size:12px;line-height:1.5;color:${FAINT}">Drivers may message you offering a car. Your ride is already sorted, so you can ignore those.</p>
    </td></tr>

    <tr><td style="padding:28px 28px 0">
      ${stepHead(2, 'WhatsApp groups', '●●○ Works well · 3 min')}
      <p style="margin:6px 0 0;font-size:14px;line-height:1.55;color:${MUTED}">Backpackers and people living in Sri Lanka run a few big ones. Join and post the same message. Then send it to your own chats too: the hostel group, the people from the train.</p>
      ${stepTail}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;font-size:14px">
        ${WHATSAPP_GROUPS.map((g) => groupRow(g.name, g.blurb, pill(g.url, 'Join group', WA_GREEN), false)).join('')}
        ${groupRow('Your own chats', 'Message written, you pick the chat', pill(whatsappShareLink(waPost), 'Send on WhatsApp', WA_GREEN), true)}
      </table>
    </td></tr>

    <tr><td style="padding:28px 28px 0">
      ${stepHead(3, 'Instagram story', '●○○ Nice extra · 1 min')}
      <p style="margin:6px 0 0;font-size:14px;line-height:1.55;color:${MUTED}">We made a story image for your ride. Post it, add a link sticker with your ride link, and <b style="color:${INK}">tag @${INSTAGRAM_HANDLE}</b>: we reshare every tagged ride to our followers, so your story reaches people you've never met.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:12px"><tr>
        <td style="padding-right:10px">${pill(story, 'Save story image', BAND)}</td>
        <td><a href="${esc(link('instagram'))}" style="font-size:13px;color:${BAND};font-weight:600;text-decoration:none">Copy ride link for the sticker →</a></td>
      </tr></table>
      ${stepTail}
    </td></tr>

    <tr><td style="padding:24px 28px 0">
      ${stepHead(4, 'Reddit', '●○○ Nice extra · 2 min')}
      <p style="margin:6px 0 0;font-size:14px;line-height:1.55;color:${MUTED}">Written as a question, which is what the subs allow. The post is ready.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:12px"><tr>
        ${SUBREDDITS.map((s) => `<td style="padding:0 10px 8px 0">${pill(redditSubmitLink(s.name, list, rdPost), `Post on r/${s.name}`, REDDIT)}<div style="font-size:12px;color:${FAINT};margin-top:4px">${esc(s.blurb)}</div></td>`).join('')}
      </tr></table>
      ${stepTail}
    </td></tr>

    <tr><td style="padding:30px 28px 28px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BAND};border-radius:14px;color:#fff">
        <tr><td style="padding:20px 22px">
          <div style="font-family:${SERIF};font-size:20px;font-weight:600">That's it.</div>
          <p style="margin:8px 0 14px;font-size:14px;line-height:1.55;color:#dff3f7">Each person who joins shows up on your ride page. If it isn't full by ${esc(cutoff)} (Sri Lanka time) the ride is called off and you pay $0, so there's nothing to lose by posting.</p>
          ${pill(ride, 'Open my ride', '#fffdf8', BAND)}
        </td></tr>
      </table>
    </td></tr>

    <tr><td style="padding:0 28px 26px;font-size:12px;line-height:1.6;color:${FAINT}">
      <div style="border-top:1px solid ${LINE};padding-top:16px"><span style="font-family:${SERIF};color:${MUTED}">Ceylon Hop</span> &middot; Ground transport across Sri Lanka. Stuck? Reply to this email or message us on WhatsApp, a real person answers.</div>
    </td></tr>`);

  const text = [
    `Hi ${firstName}. You need ${more} for your ${routeText} ride (${list.code}) to run. Names close ${cutoff} (Sri Lanka time).`,
    `Fill it and the trip is about $${seat} a seat instead of a private car. Here is where to post, in the order that works:`,
    '',
    `1. FACEBOOK GROUPS (works best). Paste this post:`,
    `   ${fbPost}`,
    ...FACEBOOK_GROUPS.map((g) => `   ${g.name}: ${g.url}`),
    '',
    `2. WHATSAPP GROUPS (works well). Join and post the same message, then send it to your own chats:`,
    ...WHATSAPP_GROUPS.map((g) => `   ${g.name}: ${g.url}`),
    `   Send on WhatsApp: ${whatsappShareLink(waPost)}`,
    '',
    `3. INSTAGRAM STORY. Save the image, add a link sticker, tag @${INSTAGRAM_HANDLE} and we reshare it: ${story}`,
    `   Link for the sticker: ${link('instagram')}`,
    '',
    `4. REDDIT. Post it as a question:`,
    ...SUBREDDITS.map((s) => `   r/${s.name}: ${redditSubmitLink(s.name, list, rdPost)}`),
    '',
    `If it isn't full by the cutoff the ride is called off and you pay $0. Open your ride: ${ride}`,
  ].join('\n');

  await email.send({
    to: args.to,
    subject: `How to fill your ${routeText} van (it takes 10 minutes)`,
    html,
    text,
  });
}
