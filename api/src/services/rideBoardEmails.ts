import type { EmailAdapter } from '../adapters/email';
import type { RideList } from '../domain/rideList';

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
