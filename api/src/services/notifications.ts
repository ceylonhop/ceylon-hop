import type { Booking } from '../db/bookingRepo';
import type { EmailAdapter } from '../adapters/email';

// Brand palette (kept inline — email clients ignore <style>/external CSS).
const TEAL = '#0AB9B6';
const TEAL_DEEP = '#0a7d6f';
const TOMATO = '#e8623a';
const INK = '#1b1b1b';
const MUTED = '#6b7280';
const FAINT = '#9ca3af';
const WA_URL = 'https://wa.me/94779669662';

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

interface Stop { color: string; label: string; place: string }

// The journey as labelled, colour-coded stops (pickup → drop-off, or each trip stop).
function journey(booking: Booking): Stop[] {
  if (booking.mode === 'trip') {
    const stops = booking.input.stops;
    return stops.map((s, i) => ({
      color: i === 0 ? TEAL_DEEP : i === stops.length - 1 ? TOMATO : TEAL,
      label: i === 0 ? 'Start' : i === stops.length - 1 ? 'End' : 'Stop',
      place: s,
    }));
  }
  if (booking.mode === 'shared') {
    return [{ color: TEAL, label: 'Service', place: 'Shared ride' }];
  }
  return [
    { color: TEAL_DEEP, label: 'Pickup', place: booking.input.from },
    { color: TOMATO, label: 'Drop-off', place: booking.input.to },
  ];
}

// The non-route facts (date, vehicle, travellers, …) as label/value pairs.
function factRows(booking: Booking): [string, string][] {
  if (booking.mode === 'trip') {
    const start = booking.input.dates?.find(Boolean);
    return [
      ['Service', booking.input.serviceType === 'chauffeur' ? 'Chauffeur-guide' : 'Private transfer'],
      ['Vehicle', vehicleLabel(booking.input.vehicleType)],
      ['Travellers', String(booking.input.pax)],
      ['Dates', start ? `From ${fmtDate(start)}` : 'To confirm'],
    ];
  }
  if (booking.mode === 'shared') {
    return [
      ['Seats', String(booking.input.seats)],
      ['Date & time', dateTime(booking.input.date, booking.input.time)],
    ];
  }
  return [
    ['Date & time', dateTime(booking.input.date, booking.input.time)],
    ['Vehicle', vehicleLabel(booking.input.vehicleType)],
    ['Travellers', travellers(booking.input.adults, booking.input.children)],
  ];
}

function routeText(booking: Booking): string {
  if (booking.mode === 'trip') return booking.input.stops.join(' → ');
  if (booking.mode === 'shared') return 'Shared ride';
  return `${booking.input.from} → ${booking.input.to}`;
}

function cancellationPolicy(booking: Booking): string {
  return booking.mode === 'trip' && booking.input.serviceType === 'chauffeur'
    ? 'Free cancellation up to 10 days before travel.'
    : 'Free cancellation up to 24 hours before travel.';
}

function renderHtml(booking: Booking): string {
  const first = esc(booking.input.customer.firstName);
  const amount = money(booking.total, booking.currency);

  const stopsHtml = journey(booking)
    .map(
      (s) =>
        `<tr>
          <td valign="top" style="width:24px;padding:6px 0"><span style="display:inline-block;width:11px;height:11px;border-radius:50%;background:${s.color}"></span></td>
          <td style="padding:3px 0">
            <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${FAINT}">${esc(s.label)}</div>
            <div style="font-size:16px;font-weight:700;color:${INK}">${esc(s.place)}</div>
          </td>
        </tr>`,
    )
    .join('');

  const factsHtml = factRows(booking)
    .map(
      ([k, v]) =>
        `<tr>
          <td style="padding:9px 0;color:${MUTED};font-size:14px">${esc(k)}</td>
          <td style="padding:9px 0;text-align:right;color:${INK};font-weight:600;font-size:14px">${esc(v)}</td>
        </tr>`,
    )
    .join('');

  return `<!doctype html><html><body style="margin:0;padding:0;background:#eef0ea;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${INK};-webkit-font-smoothing:antialiased">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef0ea;padding:28px 12px">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06)">

        <tr><td style="background:${TEAL_DEEP};padding:24px 32px">
          <span style="color:#ffffff;font-size:21px;font-weight:800;letter-spacing:-.01em">Ceylon Hop</span>
          <div style="color:#bfeae4;font-size:11px;letter-spacing:.12em;text-transform:uppercase;margin-top:3px">Ground transport · Sri Lanka</div>
        </td></tr>

        <tr><td style="padding:30px 32px 6px">
          <div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${TEAL_DEEP}">✓ Booking confirmed</div>
          <h1 style="margin:8px 0 4px;font-size:23px;font-weight:800;color:${INK}">You&rsquo;re all set, ${first}!</h1>
          <p style="margin:0;color:${MUTED};font-size:15px;line-height:1.5">Your trip is booked. Keep this email for your records &mdash; we&rsquo;ll take it from here.</p>
        </td></tr>

        <tr><td style="padding:18px 32px 4px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1faf8;border:1px solid #d7ece7;border-radius:12px">
            <tr>
              <td style="padding:14px 18px">
                <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${MUTED}">Booking reference</div>
                <div style="font-size:21px;font-weight:800;letter-spacing:1.5px;color:${TEAL_DEEP};margin-top:2px">${esc(booking.reference)}</div>
              </td>
              <td align="right" style="padding:14px 18px">
                <span style="background:#e7f6ec;color:#0c6b39;border-radius:999px;padding:6px 13px;font-size:12px;font-weight:700">Paid</span>
              </td>
            </tr>
          </table>
        </td></tr>

        <tr><td style="padding:20px 32px 4px">
          <div style="font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${FAINT};margin-bottom:8px">Your route</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${stopsHtml}</table>
        </td></tr>

        <tr><td style="padding:8px 32px 0">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eee">${factsHtml}</table>
        </td></tr>

        <tr><td style="padding:6px 32px 22px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid #f0efe9">
            <tr>
              <td style="padding:14px 0;font-size:15px;color:${MUTED}">Total paid</td>
              <td align="right" style="padding:14px 0;font-size:22px;font-weight:800;color:${INK}">${esc(amount)}</td>
            </tr>
          </table>
        </td></tr>

        <tr><td style="padding:0 32px 26px">
          <div style="background:#f7faf9;border-radius:12px;padding:20px">
            <div style="font-size:15px;font-weight:700;color:${INK};margin-bottom:6px">What happens next</div>
            <p style="margin:0 0 14px;color:${MUTED};font-size:14px;line-height:1.5">Our team will message you on WhatsApp to confirm your exact pickup time and place. Reply there any time if something changes.</p>
            <table role="presentation" cellpadding="0" cellspacing="0">
              <tr><td bgcolor="#25D366" style="border-radius:10px">
                <a href="${WA_URL}" style="display:inline-block;padding:13px 22px;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px">Message us on WhatsApp</a>
              </td></tr>
            </table>
          </div>
          <p style="margin:16px 2px 0;color:${FAINT};font-size:13px">${esc(cancellationPolicy(booking))}</p>
        </td></tr>

        <tr><td style="padding:20px 32px;background:#faf8f2;color:${FAINT};font-size:12px;line-height:1.7">
          <b style="color:${MUTED}">Ceylon Hop</b> &middot; Ground transport across Sri Lanka<br>
          Questions? Just reply to this email, or message us on WhatsApp.
        </td></tr>

      </table>
    </td></tr>
  </table></body></html>`;
}

function renderText(booking: Booking): string {
  const lines = [
    'CEYLON HOP — your booking is confirmed',
    '',
    `Hi ${booking.input.customer.firstName},`,
    '',
    "You're all set! Your trip details:",
    '',
    `Reference: ${booking.reference}`,
    `Trip: ${routeText(booking)}`,
    ...factRows(booking).map(([k, v]) => `${k}: ${v}`),
    `Total paid: ${money(booking.total, booking.currency)}`,
    '',
    'What happens next: our team will message you on WhatsApp to confirm your exact pickup time and place.',
    `WhatsApp: ${WA_URL}`,
    cancellationPolicy(booking),
    '',
    'Ceylon Hop · Ground transport across Sri Lanka',
  ];
  return lines.join('\n');
}

export async function sendBookingConfirmation(booking: Booking, email: EmailAdapter): Promise<void> {
  await email.send({
    to: booking.input.customer.email,
    subject: `Your Ceylon Hop booking is confirmed — ${booking.reference}`,
    html: renderHtml(booking),
    text: renderText(booking),
  });
}
