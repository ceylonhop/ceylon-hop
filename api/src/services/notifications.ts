import type { Booking } from '../db/bookingRepo';
import type { EmailAdapter } from '../adapters/email';
import { signBookingToken } from '../lib/bookingToken';

// Brand palette — "concierge letter" direction: warm paper, deep teal, coral, editorial
// serif. Colours are inline (email clients ignore external CSS); fonts are progressively
// enhanced via a <head> @import in page() with safe Georgia/Helvetica fallbacks.
const TEAL = '#0AB9B6';
const TEAL_DEEP = '#0a7d6f';
const TOMATO = '#cf5a2f'; // coral — route end + cancel/no-show eyebrows
const INK = '#2b2621'; // warm near-black
const MUTED = '#8d8272';
const FAINT = '#a99b86';
const PAPER = '#f4eee2'; // outer page tone
const CARD = '#fffefb'; // letter surface
const HAIR = '#efe6d6'; // hairline dividers
const ROUTE_LINE = '#dcc9a9'; // the connecting journey line
const SERIF = "'Fraunces', Georgia, 'Times New Roman', serif";
const SANS = "'Hanken Grotesk', Helvetica, Arial, sans-serif";
const MONO = "'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace";
const WA_URL = 'https://wa.me/94779669662';
const REVIEW_URL = 'https://g.page/ceylonhop/review';

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

interface Stop { color: string; label: string; place: string; sub?: string }

// True when a trip's last stop is the same place it started (a round trip). The website
// has no round-trip flag — it just repeats the origin as the final stop.
function isRoundTrip(booking: Booking): boolean {
  if (booking.mode !== 'trip') return false;
  const s = booking.input.stops;
  return s.length > 2 && s[0] === s[s.length - 1];
}

// The journey as labelled, colour-coded stops. For trips each stop also carries a `sub`
// line: nights stayed there + the travel date of the leg leaving it (both from the booking,
// so it renders website multi-stop / chauffeur / round-trip itineraries faithfully).
function journey(booking: Booking): Stop[] {
  if (booking.mode === 'trip') {
    const stops = booking.input.stops;
    const nights = booking.input.nights ?? [];
    const dates = booking.input.dates ?? [];
    const roundTrip = isRoundTrip(booking);
    return stops.map((s, i) => {
      const last = i === stops.length - 1;
      const parts: string[] = [];
      const n = nights[i] ?? 0;
      if (n > 0) parts.push(`${n} night${n > 1 ? 's' : ''}`);
      if (!last && dates[i]) parts.push(`depart ${fmtDate(dates[i])}`);
      return {
        color: i === 0 ? TEAL_DEEP : last ? TOMATO : TEAL,
        label: i === 0 ? 'Start' : last ? (roundTrip ? 'Return' : 'End') : 'Stop',
        place: s,
        sub: parts.join(' · ') || undefined,
      };
    });
  }
  if (booking.mode === 'shared') {
    return [{ color: TEAL, label: 'Service', place: 'Shared ride' }];
  }
  return [
    { color: TEAL_DEEP, label: 'Pickup', place: booking.input.from },
    { color: TOMATO, label: 'Drop-off', place: booking.input.to },
  ];
}

// Customer-facing labels for the booking extras (only `sightseeing` is website-selectable
// today; the rest can arrive on ops-made bookings — render whatever is present).
const EXTRA_LABELS: Record<string, string> = {
  sightseeing: 'Sightseeing stops',
  waiting: 'Driver waiting time',
  'safari-wait': 'Safari wait',
  luggage: 'Extra luggage',
  front: 'Front-seat guide',
  flex: 'Flexible booking',
};
function extrasLabel(extras?: string[]): string | null {
  if (!extras?.length) return null;
  const labels = extras.map((c) => EXTRA_LABELS[c] ?? c);
  return labels.join(', ');
}

// The non-route facts (date, vehicle, travellers, …) as label/value pairs.
function factRows(booking: Booking): [string, string][] {
  if (booking.mode === 'trip') {
    const start = booking.input.dates?.find(Boolean);
    const chauffeur = booking.input.serviceType === 'chauffeur';
    const rows: [string, string][] = [
      ['Service', chauffeur ? 'Chauffeur-guide' : 'Private transfer'],
      ['Vehicle', vehicleLabel(booking.input.vehicleType)],
      ['Travellers', String(booking.input.pax)],
    ];
    if (chauffeur && booking.input.days) rows.push(['Duration', `${booking.input.days} day${booking.input.days > 1 ? 's' : ''} · car & driver-guide`]);
    rows.push(['Dates', start ? `From ${fmtDate(start)}` : 'To confirm']);
    return rows;
  }
  if (booking.mode === 'shared') {
    return [
      ['Seats', String(booking.input.seats)],
      ['Date & time', dateTime(booking.input.date, booking.input.time)],
    ];
  }
  const rows: [string, string][] = [
    ['Date & time', dateTime(booking.input.date, booking.input.time)],
    ['Vehicle', vehicleLabel(booking.input.vehicleType)],
    ['Travellers', travellers(booking.input.adults, booking.input.children)],
  ];
  if (booking.input.bags > 0) rows.push(['Luggage', `${booking.input.bags} bag${booking.input.bags > 1 ? 's' : ''}`]);
  const extras = extrasLabel(booking.input.extras);
  if (extras) rows.push(['Extras', extras]);
  return rows;
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

// ── Reusable branded shell ────────────────────────────────────────────────
// Every customer email shares one layout (header, reference card, optional
// route/facts/total, a message box, footer); each email supplies its own
// eyebrow/heading/lede, status badge and message block.

interface Badge { label: string; bg: string; color: string }
const BADGE_PAID: Badge = { label: 'Paid', bg: '#e7f6ec', color: '#0c6b39' };
const BADGE_CANCELLED: Badge = { label: 'Cancelled', bg: '#f1efe9', color: '#6b645f' };
const BADGE_REFUNDED: Badge = { label: 'Refunded', bg: '#e6f0fc', color: '#1f5fb0' };
const BADGE_CONFIRMED: Badge = { label: 'Confirmed', bg: '#e0f3f0', color: TEAL_DEEP };
const BADGE_ACTION: Badge = { label: 'Action needed', bg: '#fdf1dc', color: '#8a5a12' };
const BADGE_NO_SHOW: Badge = { label: 'No-show', bg: '#f1efe9', color: '#6b645f' };
const BADGE_DEPOSIT: Badge = { label: 'Deposit paid', bg: '#e7f6ec', color: '#0c6b39' };
const BADGE_FAILED: Badge = { label: 'Payment failed', bg: '#fdf1dc', color: '#8a5a12' };
const AMBER = '#8a5a12';

// True when a paid booking still has an open detail we must confirm (a flexible/"to
// confirm" date). Drives the "we still need your details" follow-up. The exact pickup
// is always captured as an area (input.from is required), so date is the open field.
export function needsDetails(booking: Booking): boolean {
  if (booking.mode === 'shared') return false; // shared always books a fixed departure
  if (booking.mode === 'trip') return !booking.input.dates?.some(Boolean);
  return !booking.input.date;
}

// Header lockup: a teal monogram + serif wordmark on the warm card (no heavy band —
// this is a letter, not a dashboard). The monogram is a coloured cell, not a remote image,
// so it survives images-off with no hosting dependency.
function brandHeader(): string {
  return `<tr><td style="padding:30px 34px 0">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      <td valign="middle" style="padding-right:11px">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td width="34" height="34" align="center" valign="middle" style="background:${TEAL_DEEP};border-radius:50%;color:#ffffff;font-family:${SERIF};font-size:19px;font-weight:600">C</td>
        </tr></table>
      </td>
      <td valign="middle">
        <div style="font-family:${SERIF};font-size:19px;font-weight:600;color:${INK};letter-spacing:.01em">Ceylon Hop</div>
        <div style="font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:${FAINT};margin-top:1px">Ground transport · Sri Lanka</div>
      </td>
    </tr></table>
  </td></tr>`;
}

function introBlock(eyebrow: string, eyebrowColor: string, heading: string, lede: string): string {
  return `<tr><td style="padding:26px 34px 0">
    <div style="font-size:11px;font-weight:600;letter-spacing:.2em;text-transform:uppercase;color:${eyebrowColor}">${eyebrow}</div>
    <h1 style="margin:9px 0 0;font-family:${SERIF};font-size:31px;line-height:1.12;font-weight:500;color:${INK}">${heading}</h1>
    <p style="margin:10px 0 0;color:${MUTED};font-size:15px;line-height:1.6">${lede}</p>
  </td></tr>`;
}

const EYEBROW = `font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:${FAINT};font-weight:600`;

// A small status pill (colour-coded), sitting beside the reference chip.
function statusPill(badge: Badge): string {
  return `<span style="display:inline-block;background:${badge.bg};color:${badge.color};border-radius:999px;padding:5px 12px;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase">${esc(badge.label)}</span>`;
}

// A short vehicle/service tag for the centre of the route line.
function vehicleTag(booking: Booking): string {
  if (booking.mode === 'shared') return 'Shared ride';
  const car = booking.input.vehicleType === 'van' ? 'van' : 'car';
  if (booking.mode === 'trip') return booking.input.serviceType === 'chauffeur' ? 'Chauffeur-guide' : `Private ${car}`;
  return `Private ${car}`;
}

// A single dot for the journey line.
function dot(color: string): string {
  return `<div style="width:11px;height:11px;border-radius:50%;background:${color}"></div>`;
}

// The reference chip + status pill row.
function metaRow(booking: Booking, badge: Badge): string {
  return `<tr><td style="padding:18px 34px 0">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td valign="middle">
        <span style="display:inline-block;font-family:${MONO};font-size:13px;letter-spacing:.16em;color:${TEAL_DEEP};border:1px solid #d7ece7;background:#f3faf8;border-radius:7px;padding:6px 12px">${esc(booking.reference)}</span>
      </td>
      <td valign="middle" align="right">${statusPill(badge)}</td>
    </tr></table>
  </td></tr>`;
}

// The journey as a connected line: centred single (shared), horizontal From → To with a
// solid line through the dot centres (single transfer), or a vertical timeline (trip).
function routeRow(booking: Booking): string {
  const stops = journey(booking);
  let inner: string;
  if (stops.length === 1) {
    inner = `<div style="text-align:center">
      <div style="${EYEBROW}">${esc(stops[0].label)}</div>
      <div style="font-family:${SERIF};font-size:19px;font-weight:600;color:${INK};margin-top:4px">${esc(stops[0].place)}</div>
    </div>`;
  } else if (stops.length === 2) {
    const [a, b] = stops;
    inner = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td align="left" style="${EYEBROW}">${esc(a.label)}</td><td align="right" style="${EYEBROW}">${esc(b.label)}</td></tr>
      <tr>
        <td align="left" style="font-family:${SERIF};font-size:19px;font-weight:600;color:${INK};padding-top:2px">${esc(a.place)}</td>
        <td align="right" style="font-family:${SERIF};font-size:19px;font-weight:600;color:${INK};padding-top:2px">${esc(b.place)}</td>
      </tr>
      <tr><td colspan="2" style="padding-top:13px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr valign="middle">
          <td width="12">${dot(a.color)}</td>
          <td><div style="height:2px;background:${ROUTE_LINE};font-size:0;line-height:0">&nbsp;</div></td>
          <td align="center" style="padding:0 2px"><div style="font-size:10px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:${MUTED};background:${CARD};border:1px solid #e7dcc7;border-radius:999px;padding:4px 12px;white-space:nowrap">${esc(vehicleTag(booking))}</div></td>
          <td><div style="height:2px;background:${ROUTE_LINE};font-size:0;line-height:0">&nbsp;</div></td>
          <td width="12" align="right">${dot(b.color)}</td>
        </tr></table>
      </td></tr>
    </table>`;
  } else {
    const rows = stops
      .map(
        (s, i) =>
          `<tr>
            <td valign="top" style="width:20px;border-left:2px solid ${ROUTE_LINE};padding:0 0 ${i === stops.length - 1 ? '0' : '18px'}"><div style="width:11px;height:11px;border-radius:50%;background:${s.color};margin-left:-7px"></div></td>
            <td style="padding:0 0 ${i === stops.length - 1 ? '0' : '18px'} 14px"><div style="${EYEBROW}">${esc(s.label)}</div><div style="font-family:${SERIF};font-size:17px;font-weight:600;color:${INK};margin-top:1px">${esc(s.place)}</div>${s.sub ? `<div style="font-size:12px;color:${FAINT};margin-top:3px">${esc(s.sub)}</div>` : ''}</td>
          </tr>`,
      )
      .join('');
    inner = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>`;
  }
  return `<tr><td style="padding:24px 34px 0">
    <div style="border-top:1px solid ${HAIR};padding-top:22px">${inner}</div>
  </td></tr>`;
}

// The non-route facts as an editorial list with hairline dividers.
function detailsRow(booking: Booking): string {
  const rows = factRows(booking)
    .map(
      ([k, v]) =>
        `<tr>
          <td style="padding:11px 0;border-top:1px solid ${HAIR};color:${MUTED};font-size:14px">${esc(k)}</td>
          <td align="right" style="padding:11px 0;border-top:1px solid ${HAIR};color:${INK};font-size:14px;font-weight:600">${esc(v)}</td>
        </tr>`,
    )
    .join('');
  return `<tr><td style="padding:20px 34px 0">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
  </td></tr>`;
}

// Composes the letter body: reference + status, the journey line, then (optionally) the
// facts list. Keeps the same call shape the senders already use.
function ticketCard(booking: Booking, badge: Badge, opts: { facts?: boolean } = {}): string {
  return metaRow(booking, badge) + routeRow(booking) + (opts.facts !== false ? detailsRow(booking) : '');
}

// Customer's view-only "manage my booking" link. baseUrl = front-end origin (APP_BASE_URL).
export function manageUrl(booking: Booking, baseUrl: string, secret: string): string {
  return `${baseUrl.replace(/\/$/, '')}/manage.html?t=${signBookingToken(booking.id, secret)}`;
}

// Primary CTA (returns a table row for page()). WhatsApp lives in the info box below,
// so it isn't repeated here.
function manageButton(url: string): string {
  return `<tr><td style="padding:24px 34px 4px">
    <a href="${url}" style="display:inline-block;background:${TEAL_DEEP};color:#fff;text-decoration:none;padding:13px 26px;border-radius:9px;font-weight:600;font-size:14px">View your booking</a>
  </td></tr>`;
}

function totalBlock(label: string, amount: string): string {
  return `<tr><td style="padding:0 34px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid #eadfce">
      <tr>
        <td style="padding:15px 0 4px;font-family:${SERIF};font-size:16px;font-weight:600;color:${INK}">${esc(label)}</td>
        <td align="right" style="padding:15px 0 4px;font-family:${SERIF};font-size:21px;font-weight:600;color:${INK}">${esc(amount)}</td>
      </tr>
    </table>
  </td></tr>`;
}

interface Cta { href: string; label: string; bg: string }
const CTA_WHATSAPP: Cta = { href: WA_URL, label: 'Message us on WhatsApp', bg: '#25D366' };

function infoBox(title: string, body: string, note?: string, cta: Cta = CTA_WHATSAPP): string {
  return `<tr><td style="padding:26px 34px 0">
    <div style="background:#faf5ea;border:1px solid #efe6d6;border-radius:14px;padding:20px 22px">
      <div style="font-family:${SERIF};font-size:16px;font-weight:600;color:${INK};margin-bottom:6px">${title}</div>
      <p style="margin:0 0 14px;color:${MUTED};font-size:14px;line-height:1.6">${body}</p>
      <table role="presentation" cellpadding="0" cellspacing="0">
        <tr><td bgcolor="${cta.bg}" style="border-radius:9px">
          <a href="${cta.href}" style="display:inline-block;padding:12px 20px;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px">${cta.label}</a>
        </td></tr>
      </table>
    </div>
    ${note ? `<p style="margin:14px 2px 0;color:${FAINT};font-size:13px;line-height:1.6">${esc(note)}</p>` : ''}
  </td></tr>`;
}

function footer(): string {
  return `<tr><td style="padding:26px 34px 32px">
    <div style="border-top:1px solid ${HAIR};padding-top:18px;font-size:13px;line-height:1.6;color:${FAINT}">
      <span style="font-family:${SERIF};color:${MUTED}">Ceylon Hop</span> &middot; Ground transport across Sri Lanka.<br>
      Just reply to this email, or message us on WhatsApp &mdash; a real person answers.
    </div>
  </td></tr>`;
}

function page(inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Hanken+Grotesk:wght@400;500;600;700&display=swap');</style>
  </head><body style="margin:0;padding:0;background:${PAPER};font-family:${SANS};color:${INK};-webkit-font-smoothing:antialiased">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};padding:26px 12px">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${CARD};border:1px solid #ece2d0;border-radius:18px;overflow:hidden">
        ${inner}
      </table>
    </td></tr>
  </table></body></html>`;
}

function textShell(title: string, lede: string, booking: Booking, lines: string[]): string {
  return [
    `CEYLON HOP — ${title}`,
    '',
    `Hi ${booking.input.customer.firstName},`,
    '',
    lede,
    '',
    `Reference: ${booking.reference}`,
    `Trip: ${routeText(booking)}`,
    ...lines,
    '',
    `WhatsApp: ${WA_URL}`,
    '',
    'Ceylon Hop · Ground transport across Sri Lanka',
  ].join('\n');
}

// ── Booking confirmation (→ paid) ──────────────────────────────────────────
// Historical/ops-safe: when less than the total was paid, show deposit + balance instead
// of a single total line. Public bookings currently pay in full.
function paidRows(booking: Booking): [string, string][] {
  const due = booking.amountDueNow;
  if (due != null && due < booking.total) {
    return [
      ['Deposit paid', money(due, booking.currency)],
      ['Balance due', money(booking.total - due, booking.currency)],
    ];
  }
  return [['Total paid', money(booking.total, booking.currency)]];
}

function renderHtml(booking: Booking, manageLink?: string): string {
  const first = esc(booking.input.customer.firstName);
  return page(
    brandHeader() +
      introBlock(
        '✓ Booking confirmed',
        TEAL_DEEP,
        `You&rsquo;re all set, ${first}!`,
        'Your trip is booked. Keep this email for your records &mdash; we&rsquo;ll take it from here.',
      ) +
      ticketCard(booking, BADGE_PAID) +
      paidRows(booking).map(([label, amount]) => totalBlock(label, amount)).join('') +
      (manageLink ? manageButton(manageLink) : '') +
      infoBox(
        'What happens next',
        'Our team will message you on WhatsApp to confirm your exact pickup time and place. Reply there any time if something changes.',
        cancellationPolicy(booking),
      ) +
      footer(),
  );
}

function renderText(booking: Booking, manageLink?: string): string {
  return textShell("your booking is confirmed", "You're all set! Your trip details:", booking, [
    ...factRows(booking).map(([k, v]) => `${k}: ${v}`),
    ...paidRows(booking).map(([label, amount]) => `${label}: ${amount}`),
    '',
    'What happens next: our team will message you on WhatsApp to confirm your exact pickup time and place.',
    cancellationPolicy(booking),
    ...(manageLink ? ['', `View your booking: ${manageLink}`] : []),
  ]);
}

export async function sendBookingConfirmation(
  booking: Booking,
  email: EmailAdapter,
  links: { manage?: string } = {},
): Promise<void> {
  await email.send({
    to: booking.input.customer.email,
    subject: `Your Ceylon Hop booking is confirmed — ${booking.reference}`,
    html: renderHtml(booking, links.manage),
    text: renderText(booking, links.manage),
  });
}

// ── Cancellation (→ cancelled) ─────────────────────────────────────────────
export async function sendCancellationConfirmation(booking: Booking, email: EmailAdapter): Promise<void> {
  const first = esc(booking.input.customer.firstName);
  const html = page(
    brandHeader() +
      introBlock(
        'Booking cancelled',
        TOMATO,
        `Your booking is cancelled, ${first}`,
        'This booking has been cancelled. We&rsquo;ve kept the details below for your records.',
      ) +
      ticketCard(booking, BADGE_CANCELLED) +
      infoBox(
        'Anything we can do?',
        'If you&rsquo;ve already paid, any refund due will be processed separately and you&rsquo;ll get a confirmation. Questions about this cancellation? Just reply or message us on WhatsApp.',
      ) +
      footer(),
  );
  const text = textShell('your booking is cancelled', 'This booking has been cancelled. Details for your records:', booking, [
    ...factRows(booking).map(([k, v]) => `${k}: ${v}`),
    '',
    "If you've already paid, any refund due will be processed separately.",
  ]);
  await email.send({
    to: booking.input.customer.email,
    subject: `Your Ceylon Hop booking was cancelled — ${booking.reference}`,
    html,
    text,
  });
}

// ── Refund processed (→ refunded) ──────────────────────────────────────────
export async function sendRefundConfirmation(booking: Booking, email: EmailAdapter): Promise<void> {
  const first = esc(booking.input.customer.firstName);
  const amount = money(booking.total, booking.currency);
  const html = page(
    brandHeader() +
      introBlock(
        'Refund processed',
        TEAL_DEEP,
        `Your refund is on its way, ${first}`,
        'We&rsquo;ve processed a refund for the booking below.',
      ) +
      ticketCard(booking, BADGE_REFUNDED, { facts: false }) +
      totalBlock('Amount refunded', amount) +
      infoBox(
        'When will I see it?',
        'Refunds usually land in 5&ndash;10 business days, depending on your bank or card provider. Questions? Just reply or message us on WhatsApp.',
      ) +
      footer(),
  );
  const text = textShell('refund processed', "We've processed a refund for your booking.", booking, [
    `Amount refunded: ${amount}`,
    '',
    'Refunds usually land in 5-10 business days, depending on your bank or card provider.',
  ]);
  await email.send({
    to: booking.input.customer.email,
    subject: `Your Ceylon Hop refund is processed — ${booking.reference}`,
    html,
    text,
  });
}

// ── Pre-trip reminder (scheduled, ~24–48h before travel) ───────────────────
export async function sendTripReminder(
  booking: Booking,
  email: EmailAdapter,
  links: { manage?: string } = {},
): Promise<void> {
  const first = esc(booking.input.customer.firstName);
  const html = page(
    brandHeader() +
      introBlock(
        'Trip reminder',
        TEAL_DEEP,
        `Your trip is almost here, ${first}`,
        'A quick reminder about your upcoming Ceylon Hop journey — here are the details again.',
      ) +
      ticketCard(booking, BADGE_PAID) +
      (links.manage ? manageButton(links.manage) : '') +
      infoBox(
        'Before you travel',
        "Our team will share your driver&rsquo;s name and vehicle on WhatsApp shortly before pickup. Anything changed? Just reply or message us.",
      ) +
      footer(),
  );
  const text = textShell('your trip is coming up', 'A quick reminder about your upcoming journey:', booking, [
    ...factRows(booking).map(([k, v]) => `${k}: ${v}`),
    '',
    "We'll share your driver's details on WhatsApp shortly before pickup.",
    ...(links.manage ? ['', `View your booking: ${links.manage}`] : []),
  ]);
  await email.send({
    to: booking.input.customer.email,
    subject: `Your Ceylon Hop trip is coming up — ${booking.reference}`,
    html,
    text,
  });
}

// ── Thank-you + review request (scheduled, after travel) ───────────────────
export async function sendReviewRequest(booking: Booking, email: EmailAdapter): Promise<void> {
  const first = esc(booking.input.customer.firstName);
  const html = page(
    brandHeader() +
      introBlock(
        'Thank you',
        TEAL_DEEP,
        `Thanks for travelling with us, ${first}!`,
        'We hope your journey was smooth and the views were worth it.',
      ) +
      ticketCard(booking, { label: 'Completed', bg: '#e6f4ec', color: '#0c6b39' }, { facts: false }) +
      infoBox(
        'How did we do?',
        'A quick Google review would mean the world to our small team &mdash; it helps other travellers find us. Thank you! 🌴',
        undefined,
        { href: REVIEW_URL, label: 'Leave a review', bg: TEAL_DEEP },
      ) +
      footer(),
  );
  const text = textShell('thanks for travelling with us', 'We hope your journey was smooth!', booking, [
    '',
    `A quick Google review would mean the world to our small team: ${REVIEW_URL}`,
  ]);
  await email.send({
    to: booking.input.customer.email,
    subject: `How was your trip? — ${booking.reference}`,
    html,
    text,
  });
}

// A pill CTA row consistent with manageButton, but with a custom label.
function ctaRow(url: string, label: string): string {
  return `<tr><td style="padding:4px 32px 26px">`
    + `<a href="${url}" style="display:inline-block;background:${TEAL_DEEP};color:#fff;text-decoration:none;`
    + `padding:12px 24px;border-radius:999px;font-weight:700;font-size:.95rem">${esc(label)}</a></td></tr>`;
}

// ── Payment didn't complete (abandoned checkout recovery) ──────────────────
// Swept from payment_pending by the watchdog; one-shot, with a link to finish.
export async function sendPaymentIncomplete(
  booking: Booking,
  email: EmailAdapter,
  links: { resume?: string } = {},
): Promise<void> {
  const first = esc(booking.input.customer.firstName);
  const due = money(booking.amountDueNow ?? booking.total, booking.currency);
  const html = page(
    brandHeader() +
      introBlock(
        'Payment didn’t go through',
        AMBER,
        `You’re almost there, ${first}`,
        'We saved your booking, but the payment didn’t complete — so your spot isn’t held yet.',
      ) +
      ticketCard(booking, BADGE_ACTION) +
      totalBlock('Amount due', due) +
      (links.resume ? ctaRow(links.resume, 'Finish your booking') : '') +
      infoBox(
        'Finish in a minute',
        'Pick up where you left off — your details are saved. Once payment clears we’ll confirm everything by email. Trouble paying? Just reply or message us on WhatsApp.',
      ) +
      footer(),
  );
  const text = textShell('finish your booking', 'Your payment didn’t complete, so your booking isn’t held yet.', booking, [
    ...factRows(booking).map(([k, v]) => `${k}: ${v}`),
    `Amount due: ${due}`,
    ...(links.resume ? ['', `Finish your booking: ${links.resume}`] : []),
  ]);
  await email.send({
    to: booking.input.customer.email,
    subject: `Finish your Ceylon Hop booking — ${booking.reference}`,
    html,
    text,
  });
}

// ── Payment failed (immediate, on a declined/cancelled checkout) ───────────
// Fires the moment PayHere reports a non-success on an unsettled payment. The booking
// stays payment_pending so the customer can retry; this is the instant nudge (distinct
// from the delayed watchdog recovery email).
export async function sendPaymentFailed(
  booking: Booking,
  email: EmailAdapter,
  links: { resume?: string } = {},
): Promise<void> {
  const first = esc(booking.input.customer.firstName);
  const due = money(booking.amountDueNow ?? booking.total, booking.currency);
  const html = page(
    brandHeader() +
      introBlock(
        'Payment didn’t go through',
        AMBER,
        `Let’s try that again, ${first}`,
        'Your payment didn’t complete, so your booking isn’t held yet — but nothing’s lost. You can pick up right where you left off.',
      ) +
      ticketCard(booking, BADGE_FAILED) +
      totalBlock('Amount due', due) +
      (links.resume ? ctaRow(links.resume, 'Try payment again') : '') +
      infoBox(
        'Trouble paying?',
        'Some cards block international payments by default — a quick note to your bank usually clears it. Or message us on WhatsApp and we’ll send another way to pay.',
      ) +
      footer(),
  );
  const text = textShell('your payment didn’t go through', 'Your payment didn’t complete, so your booking isn’t held yet.', booking, [
    ...factRows(booking).map(([k, v]) => `${k}: ${v}`),
    `Amount due: ${due}`,
    ...(links.resume ? ['', `Try payment again: ${links.resume}`] : []),
  ]);
  await email.send({
    to: booking.input.customer.email,
    subject: `Your payment didn’t go through — ${booking.reference}`,
    html,
    text,
  });
}

// ── Deposit received (a partial deposit was collected; balance due later) ──
// Dormant today: the engine charges the full amount for every booking, so no public flow
// produces amountDueNow < total. Wired to fire only on a real partial deposit.
export async function sendDepositReceived(
  booking: Booking,
  email: EmailAdapter,
  links: { manage?: string } = {},
): Promise<void> {
  const first = esc(booking.input.customer.firstName);
  const balance = money(booking.total - (booking.amountDueNow ?? booking.total), booking.currency);
  const html = page(
    brandHeader() +
      introBlock(
        'Deposit received',
        TEAL_DEEP,
        `Thanks, ${first} — your deposit is in`,
        'We’ve received your deposit and your spot is secured. The balance is due before you travel.',
      ) +
      ticketCard(booking, BADGE_DEPOSIT) +
      paidRows(booking).map(([label, amount]) => totalBlock(label, amount)).join('') +
      (links.manage ? manageButton(links.manage) : '') +
      infoBox(
        'Paying the balance',
        `Your remaining balance of ${esc(balance)} is due before travel — we’ll share the payment details on WhatsApp closer to the day.`,
        cancellationPolicy(booking),
      ) +
      footer(),
  );
  const text = textShell('deposit received', 'We’ve received your deposit — your spot is secured.', booking, [
    ...factRows(booking).map(([k, v]) => `${k}: ${v}`),
    ...paidRows(booking).map(([label, amount]) => `${label}: ${amount}`),
    '',
    `Balance due before travel: ${balance}`,
    ...(links.manage ? ['', `View your booking: ${links.manage}`] : []),
  ]);
  await email.send({
    to: booking.input.customer.email,
    subject: `We’ve received your deposit — ${booking.reference}`,
    html,
    text,
  });
}

// ── Booking confirmed (paid → confirmed; ops arranged the driver) ──────────
export async function sendBookingConfirmed(
  booking: Booking,
  email: EmailAdapter,
  links: { manage?: string } = {},
): Promise<void> {
  const first = esc(booking.input.customer.firstName);
  const html = page(
    brandHeader() +
      introBlock(
        '✓ Confirmed',
        TEAL_DEEP,
        `You’re confirmed, ${first}!`,
        'Good news — your driver is arranged and your trip is locked in.',
      ) +
      ticketCard(booking, BADGE_CONFIRMED) +
      (links.manage ? manageButton(links.manage) : '') +
      infoBox(
        'Your driver details',
        'We’ll send your driver’s name and vehicle on WhatsApp shortly before pickup. Anything changed? Just reply or message us there.',
        cancellationPolicy(booking),
      ) +
      footer(),
  );
  const text = textShell('your booking is confirmed', 'Your driver is arranged — you’re all set.', booking, [
    ...factRows(booking).map(([k, v]) => `${k}: ${v}`),
    '',
    'We’ll share your driver’s name and vehicle on WhatsApp shortly before pickup.',
    cancellationPolicy(booking),
    ...(links.manage ? ['', `View your booking: ${links.manage}`] : []),
  ]);
  await email.send({
    to: booking.input.customer.email,
    subject: `You’re confirmed — ${booking.reference}`,
    html,
    text,
  });
}

// ── No-show (confirmed/in_progress → no_show; fare forfeited) ──────────────
export async function sendNoShowNotice(booking: Booking, email: EmailAdapter): Promise<void> {
  const first = esc(booking.input.customer.firstName);
  const html = page(
    brandHeader() +
      introBlock(
        'Missed pickup',
        TOMATO,
        `We missed you, ${first}`,
        'Your driver was at the pickup at the booked time, but we weren’t able to reach you.',
      ) +
      ticketCard(booking, BADGE_NO_SHOW) +
      infoBox(
        'About your fare',
        'Because the driver was dispatched and waited, this booking is marked as a no-show and the fare isn’t refundable. Still need to travel? Message us and we’ll help you arrange a new booking.',
      ) +
      footer(),
  );
  const text = textShell('missed pickup', 'Your driver was at the pickup, but we couldn’t reach you.', booking, [
    ...factRows(booking).map(([k, v]) => `${k}: ${v}`),
    '',
    'This booking is marked as a no-show and the fare isn’t refundable. Message us to arrange a new booking.',
  ]);
  await email.send({
    to: booking.input.customer.email,
    subject: `Your Ceylon Hop pickup — ${booking.reference}`,
    html,
    text,
  });
}

// ── We still need your details (paid but date/time flexible) ───────────────
export async function sendDetailsNeeded(
  booking: Booking,
  email: EmailAdapter,
  links: { manage?: string } = {},
): Promise<void> {
  const first = esc(booking.input.customer.firstName);
  const html = page(
    brandHeader() +
      introBlock(
        'One more thing',
        AMBER,
        `We just need a detail or two, ${first}`,
        'Your booking is paid and safe — we only need to lock in your exact pickup time and spot.',
      ) +
      ticketCard(booking, BADGE_ACTION) +
      (links.manage ? manageButton(links.manage) : '') +
      infoBox(
        'What happens now',
        'Your date/time is still flexible. Our team will reach out on WhatsApp to confirm your exact pickup spot and time — or reply to this email any time with the details.',
      ) +
      footer(),
  );
  const text = textShell('we still need your details', 'Your booking is paid — we just need your exact pickup time and spot.', booking, [
    ...factRows(booking).map(([k, v]) => `${k}: ${v}`),
    '',
    'Our team will reach out on WhatsApp to confirm — or reply any time with your exact pickup and time.',
    ...(links.manage ? ['', `View your booking: ${links.manage}`] : []),
  ]);
  await email.send({
    to: booking.input.customer.email,
    subject: `We need a couple of details — ${booking.reference}`,
    html,
    text,
  });
}
