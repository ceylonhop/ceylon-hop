import type { Booking } from '../db/bookingRepo';
import type { EmailAdapter } from '../adapters/email';

const ACCENT = '#0AB9B6';
const INK = '#1b1b1b';

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}
function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}
function vehicleLabel(v: 'car' | 'van'): string {
  return v === 'van' ? 'AC van (up to 6)' : 'AC car (up to 3)';
}
function fmtDate(d: string): string {
  const dt = new Date(`${d}T12:00:00`);
  if (Number.isNaN(dt.getTime())) return d;
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(dt);
}
function dateTime(date?: string, time?: string): string {
  if (!date) return 'To confirm';
  return time ? `${fmtDate(date)} · ${time}` : fmtDate(date);
}
function travellers(adults: number, children: number): string {
  let s = `${adults} adult${adults > 1 ? 's' : ''}`;
  if (children > 0) s += `, ${children} child${children > 1 ? 'ren' : ''}`;
  return s;
}

// The labelled detail rows for this booking, in display order. Used for both the HTML
// table and the plain-text version so they never drift.
function detailRows(booking: Booking): [string, string][] {
  const rows: [string, string][] = [['Reference', booking.reference]];
  if (booking.mode === 'trip') {
    const start = booking.input.dates?.find(Boolean);
    rows.push(['Trip', booking.input.stops.join(' → ')]);
    rows.push(['Service', booking.input.serviceType === 'chauffeur' ? 'Chauffeur-guide' : 'Private transfer']);
    rows.push(['Vehicle', vehicleLabel(booking.input.vehicleType)]);
    rows.push(['Travellers', String(booking.input.pax)]);
    rows.push(['Dates', start ? `From ${fmtDate(start)}` : 'To confirm']);
  } else if (booking.mode === 'shared') {
    rows.push(['Service', 'Shared ride']);
    rows.push(['Seats', String(booking.input.seats)]);
    rows.push(['Date & time', dateTime(booking.input.date, booking.input.time)]);
  } else {
    rows.push(['Trip', `${booking.input.from} → ${booking.input.to}`]);
    rows.push(['Vehicle', vehicleLabel(booking.input.vehicleType)]);
    rows.push(['Travellers', travellers(booking.input.adults, booking.input.children)]);
    rows.push(['Date & time', dateTime(booking.input.date, booking.input.time)]);
  }
  rows.push(['Total paid', money(booking.total, booking.currency)]);
  return rows;
}

function cancellationPolicy(booking: Booking): string {
  return booking.mode === 'trip' && booking.input.serviceType === 'chauffeur'
    ? 'Free cancellation up to 10 days before travel.'
    : 'Free cancellation up to 24 hours before travel.';
}

function renderHtml(booking: Booking, rows: [string, string][]): string {
  const first = esc(booking.input.customer.firstName);
  const rowsHtml = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:7px 0;color:#6b7280;font-size:14px">${esc(k)}</td>` +
        `<td style="padding:7px 0;text-align:right;color:${INK};font-weight:600;font-size:14px">${esc(v)}</td></tr>`,
    )
    .join('');
  return `<!doctype html><html><body style="margin:0;background:#f3f1ea;font-family:Helvetica,Arial,sans-serif;color:${INK}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f1ea;padding:24px 0">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden">
        <tr><td style="background:${ACCENT};padding:20px 28px">
          <span style="color:#ffffff;font-size:20px;font-weight:800;letter-spacing:-.01em">Ceylon Hop</span>
        </td></tr>
        <tr><td style="padding:28px">
          <p style="margin:0 0 6px;font-size:18px;font-weight:700">You&rsquo;re booked, ${first}!</p>
          <p style="margin:0 0 20px;color:#4b5563;font-size:15px;line-height:1.5">Your Ceylon Hop trip is confirmed. Here are the details &mdash; keep this email for your records.</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #ececec;border-bottom:1px solid #ececec;margin-bottom:20px">
            ${rowsHtml}
          </table>
          <p style="margin:0 0 6px;font-size:15px;font-weight:700">What happens next</p>
          <p style="margin:0 0 16px;color:#4b5563;font-size:14px;line-height:1.5">Our team will message you on <b>WhatsApp</b> to confirm your exact pickup time and place. Reply there any time if something changes.</p>
          <p style="margin:0;color:#6b7280;font-size:13px">${esc(cancellationPolicy(booking))}</p>
        </td></tr>
        <tr><td style="padding:18px 28px;background:#faf8f2;color:#9ca3af;font-size:12px">
          Ceylon Hop &middot; Ground transport across Sri Lanka
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

function renderText(booking: Booking, rows: [string, string][]): string {
  return [
    'Ceylon Hop — your booking is confirmed',
    '',
    `Hi ${booking.input.customer.firstName},`,
    '',
    "You're booked! Your trip details:",
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    'What happens next: our team will message you on WhatsApp to confirm your exact pickup time and place.',
    cancellationPolicy(booking),
    '',
    'Ceylon Hop · Ground transport across Sri Lanka',
  ].join('\n');
}

export async function sendBookingConfirmation(booking: Booking, email: EmailAdapter): Promise<void> {
  const rows = detailRows(booking);
  await email.send({
    to: booking.input.customer.email,
    subject: `Your Ceylon Hop booking is confirmed — ${booking.reference}`,
    html: renderHtml(booking, rows),
    text: renderText(booking, rows),
  });
}
