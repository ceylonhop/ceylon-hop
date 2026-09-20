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
  args: { to: string; firstName: string; list: RideList; lockedTime: string },
): Promise<void> {
  const { list } = args;
  await email.send({
    to: args.to,
    subject: `It's on! Your ${route(list)} ride is confirmed`,
    html: shell(
      `It's on, ${esc(args.firstName)}! 🚐`,
      `<p>Enough travellers joined — your shared van is confirmed.</p>
       <p><b>${routeHtml(list)}</b><br>${esc(list.date)} · departs <b>${esc(args.lockedTime)}</b><br>${money(list.seatPrice)} per seat, charged now.</p>
       <p>We'll email your driver's name and WhatsApp the evening before. See you at the pickup!</p>`,
    ),
    text: `It's on, ${args.firstName}! Your ${route(list)} ride is confirmed for ${list.date}, departs ${args.lockedTime}. ${money(list.seatPrice)} per seat.`,
  });
}

export async function sendRideCancelled(
  email: EmailAdapter,
  args: { to: string; firstName: string; list: RideList },
): Promise<void> {
  const { list } = args;
  await email.send({
    to: args.to,
    subject: `Your ${route(list)} ride has been called off — you weren't charged`,
    html: shell(
      `Not enough names this time`,
      `<p>Hi ${esc(args.firstName)}, not enough travellers joined your <b>${routeHtml(list)}</b> ride on ${esc(list.date)} by the cutoff, so it's been <b>called off</b>.</p>
       <p><b>You were not charged</b> — the card hold is released, nothing to do.</p>
       <p>Plenty of other routes are gathering names — start or join another anytime. It's always $0 unless the ride runs.</p>`,
    ),
    text: `Hi ${args.firstName}, not enough travellers joined your ${route(list)} ride on ${list.date}, so it's been called off. You were not charged — the hold is released. Start or join another anytime; $0 unless it runs.`,
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
      `<p>Hi ${esc(args.firstName)}, the van for <b>${routeHtml(list)}</b> on ${esc(list.date)} is confirmed, but we couldn't charge your card for your seat.</p>
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
  args: { to: string; firstName: string; list: RideList; seats: number; rideUrl: string },
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
      <p style="margin:10px 0 0;color:${MUTED};font-size:15px;line-height:1.6">We're gathering travellers for your shared van now. <b style="color:${INK}">Nothing has been charged</b> — your card is approved, and that's all.</p>
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
          <td style="padding:15px 0 4px;font-family:${SERIF};font-size:16px;font-weight:600;color:${INK}">Charged only if it runs</td>
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
      + `${seatsLabel(seats)} · ride ${list.code}. Nothing has been charged — we take ${money(total)} only if `
      + `at least ${list.minSeats} seats are pledged by the cutoff and the van runs. Names close ${cutoff} (Sri Lanka time). `
      + `View your ride or scratch your name off: ${args.rideUrl}`,
  });
}
