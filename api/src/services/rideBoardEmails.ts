import type { EmailAdapter } from '../adapters/email';
import type { RideList } from '../domain/rideList';

// ============================================================================
// Ride Board customer emails. Self-contained (a small branded shell) so this
// doesn't reach into the booking-centric notifications.ts. Sent by the cutoff
// job when a list confirms / expires / a charge fails.
// ============================================================================

const TEAL = '#0AB9B6';
const INK = '#2C2A2B';

function shell(heading: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="margin:0;background:#F4F2EA;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:${INK}">
  <div style="max-width:520px;margin:0 auto;padding:24px">
    <div style="background:${TEAL};color:#fff;padding:16px 20px;border-radius:14px 14px 0 0;font-weight:800;font-size:18px">Ceylon Hop · Ride Board</div>
    <div style="background:#fffdf8;border:1px solid #e7e3d6;border-top:none;border-radius:0 0 14px 14px;padding:22px 20px">
      <h1 style="font-size:20px;margin:0 0 12px">${heading}</h1>
      ${bodyHtml}
    </div>
    <p style="color:#6c6a6b;font-size:12px;text-align:center;margin:16px 0 0">Ceylon Hop · shared rides across Sri Lanka</p>
  </div></body></html>`;
}

const route = (l: RideList) => `${l.fromPlace} → ${l.toPlace}`;
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export async function sendRideConfirmed(
  email: EmailAdapter,
  args: { to: string; firstName: string; list: RideList; lockedTime: string },
): Promise<void> {
  const { list } = args;
  await email.send({
    to: args.to,
    subject: `It's on! Your ${route(list)} ride is confirmed`,
    html: shell(
      `It's on, ${args.firstName}! 🚐`,
      `<p>Enough travellers joined — your shared van is confirmed.</p>
       <p><b>${route(list)}</b><br>${list.date} · departs <b>${args.lockedTime}</b><br>${money(list.seatPrice)} per seat, charged now.</p>
       <p>We'll email your driver's name and WhatsApp the evening before. See you at the pickup!</p>`,
    ),
    text: `It's on, ${args.firstName}! Your ${route(list)} ride is confirmed for ${list.date}, departs ${args.lockedTime}. ${money(list.seatPrice)} per seat.`,
  });
}

export async function sendRideExpiredOptions(
  email: EmailAdapter,
  args: { to: string; firstName: string; list: RideList },
): Promise<void> {
  const { list } = args;
  await email.send({
    to: args.to,
    subject: `Your ${route(list)} list didn't fill — here's how you still travel`,
    html: shell(
      `Not enough names this time — but you still travel`,
      `<p>Hi ${args.firstName}, your <b>${route(list)}</b> list on ${list.date} didn't reach enough names by the cutoff, so <b>you were not charged</b>.</p>
       <p>You travel either way — reply to pick one:</p>
       <ul>
         <li><b>Private car</b>, split between whoever's in.</li>
         <li><b>The next scheduled shared ride</b> on this route.</li>
         <li><b>Nothing</b> — walk away, the card hold is released.</li>
       </ul>`,
    ),
    text: `Hi ${args.firstName}, your ${route(list)} list on ${list.date} didn't fill — you weren't charged. Options: private car (split), next scheduled shared ride, or walk away. Reply to choose.`,
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
      `<p>Hi ${args.firstName}, the van for <b>${route(list)}</b> on ${list.date} is confirmed, but we couldn't charge your card for your seat.</p>
       <p>Reply and we'll sort a fresh payment so you keep your spot.</p>`,
    ),
    text: `Hi ${args.firstName}, we couldn't charge your card for your ${route(list)} seat on ${list.date}. Reply to keep your spot.`,
  });
}
