import type { Booking } from '../db/bookingRepo';
import type { EmailAdapter } from '../adapters/email';
import { signBookingToken } from '../lib/bookingToken';

// Brand palette (kept inline — email clients ignore <style>/external CSS).
const TEAL = '#0AB9B6';
const TEAL_DEEP = '#0a7d6f';
const TOMATO = '#e8623a';
const INK = '#1b1b1b';
const MUTED = '#6b7280';
const FAINT = '#9ca3af';
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
const AMBER = '#8a5a12';

// True when a paid booking still has an open detail we must confirm (a flexible/"to
// confirm" date). Drives the "we still need your details" follow-up. The exact pickup
// is always captured as an area (input.from is required), so date is the open field.
export function needsDetails(booking: Booking): boolean {
  if (booking.mode === 'shared') return false; // shared always books a fixed departure
  if (booking.mode === 'trip') return !booking.input.dates?.some(Boolean);
  return !booking.input.date;
}

function brandHeader(): string {
  return `<tr><td style="background:${TEAL_DEEP};padding:24px 32px">
    <span style="color:#ffffff;font-size:21px;font-weight:800;letter-spacing:-.01em">Ceylon Hop</span>
    <div style="color:#bfeae4;font-size:11px;letter-spacing:.12em;text-transform:uppercase;margin-top:3px">Ground transport · Sri Lanka</div>
  </td></tr>`;
}

function introBlock(eyebrow: string, eyebrowColor: string, heading: string, lede: string): string {
  return `<tr><td style="padding:30px 32px 6px">
    <div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${eyebrowColor}">${eyebrow}</div>
    <h1 style="margin:8px 0 4px;font-size:23px;font-weight:800;color:${INK}">${heading}</h1>
    <p style="margin:0;color:${MUTED};font-size:15px;line-height:1.5">${lede}</p>
  </td></tr>`;
}

function refCard(booking: Booking, badge: Badge): string {
  return `<tr><td style="padding:18px 32px 4px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1faf8;border:1px solid #d7ece7;border-radius:12px">
      <tr>
        <td style="padding:14px 18px">
          <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${MUTED}">Booking reference</div>
          <div style="font-size:21px;font-weight:800;letter-spacing:1.5px;color:${TEAL_DEEP};margin-top:2px">${esc(booking.reference)}</div>
        </td>
        <td align="right" style="padding:14px 18px">
          <span style="background:${badge.bg};color:${badge.color};border-radius:999px;padding:6px 13px;font-size:12px;font-weight:700">${esc(badge.label)}</span>
        </td>
      </tr>
    </table>
  </td></tr>`;
}

// Customer's view-only "manage my booking" link. baseUrl = front-end origin (APP_BASE_URL).
export function manageUrl(booking: Booking, baseUrl: string, secret: string): string {
  return `${baseUrl.replace(/\/$/, '')}/manage.html?t=${signBookingToken(booking.id, secret)}`;
}

// A CTA block consistent with the other block helpers (returns a table row for page()).
function manageButton(url: string): string {
  return `<tr><td style="padding:4px 32px 26px">`
    + `<a href="${url}" style="display:inline-block;background:${TEAL_DEEP};color:#fff;text-decoration:none;`
    + `padding:12px 24px;border-radius:999px;font-weight:700;font-size:.95rem">View your booking</a></td></tr>`;
}

function routeBlock(booking: Booking): string {
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
  return `<tr><td style="padding:20px 32px 4px">
    <div style="font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${FAINT};margin-bottom:8px">Your route</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${stopsHtml}</table>
  </td></tr>`;
}

function factsBlock(booking: Booking): string {
  const factsHtml = factRows(booking)
    .map(
      ([k, v]) =>
        `<tr>
          <td style="padding:9px 0;color:${MUTED};font-size:14px">${esc(k)}</td>
          <td style="padding:9px 0;text-align:right;color:${INK};font-weight:600;font-size:14px">${esc(v)}</td>
        </tr>`,
    )
    .join('');
  return `<tr><td style="padding:8px 32px 0">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eee">${factsHtml}</table>
  </td></tr>`;
}

function totalBlock(label: string, amount: string): string {
  return `<tr><td style="padding:6px 32px 22px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid #f0efe9">
      <tr>
        <td style="padding:14px 0;font-size:15px;color:${MUTED}">${esc(label)}</td>
        <td align="right" style="padding:14px 0;font-size:22px;font-weight:800;color:${INK}">${esc(amount)}</td>
      </tr>
    </table>
  </td></tr>`;
}

interface Cta { href: string; label: string; bg: string }
const CTA_WHATSAPP: Cta = { href: WA_URL, label: 'Message us on WhatsApp', bg: '#25D366' };

function infoBox(title: string, body: string, note?: string, cta: Cta = CTA_WHATSAPP): string {
  return `<tr><td style="padding:0 32px 26px">
    <div style="background:#f7faf9;border-radius:12px;padding:20px">
      <div style="font-size:15px;font-weight:700;color:${INK};margin-bottom:6px">${title}</div>
      <p style="margin:0 0 14px;color:${MUTED};font-size:14px;line-height:1.5">${body}</p>
      <table role="presentation" cellpadding="0" cellspacing="0">
        <tr><td bgcolor="${cta.bg}" style="border-radius:10px">
          <a href="${cta.href}" style="display:inline-block;padding:13px 22px;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px">${cta.label}</a>
        </td></tr>
      </table>
    </div>
    ${note ? `<p style="margin:16px 2px 0;color:${FAINT};font-size:13px">${esc(note)}</p>` : ''}
  </td></tr>`;
}

function footer(): string {
  return `<tr><td style="padding:20px 32px;background:#faf8f2;color:${FAINT};font-size:12px;line-height:1.7">
    <b style="color:${MUTED}">Ceylon Hop</b> &middot; Ground transport across Sri Lanka<br>
    Questions? Just reply to this email, or message us on WhatsApp.
  </td></tr>`;
}

function page(inner: string): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#eef0ea;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${INK};-webkit-font-smoothing:antialiased">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef0ea;padding:28px 12px">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06)">
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
      refCard(booking, BADGE_PAID) +
      (manageLink ? manageButton(manageLink) : '') +
      routeBlock(booking) +
      factsBlock(booking) +
      paidRows(booking).map(([label, amount]) => totalBlock(label, amount)).join('') +
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
      refCard(booking, BADGE_CANCELLED) +
      routeBlock(booking) +
      factsBlock(booking) +
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
      refCard(booking, BADGE_REFUNDED) +
      routeBlock(booking) +
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
      refCard(booking, BADGE_PAID) +
      (links.manage ? manageButton(links.manage) : '') +
      routeBlock(booking) +
      factsBlock(booking) +
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
      refCard(booking, { label: 'Completed', bg: '#e6f4ec', color: '#0c6b39' }) +
      routeBlock(booking) +
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
      refCard(booking, BADGE_ACTION) +
      (links.resume ? ctaRow(links.resume, 'Finish your booking') : '') +
      routeBlock(booking) +
      factsBlock(booking) +
      totalBlock('Amount due', due) +
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
      refCard(booking, BADGE_CONFIRMED) +
      (links.manage ? manageButton(links.manage) : '') +
      routeBlock(booking) +
      factsBlock(booking) +
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
      refCard(booking, BADGE_NO_SHOW) +
      routeBlock(booking) +
      factsBlock(booking) +
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
      refCard(booking, BADGE_ACTION) +
      (links.manage ? manageButton(links.manage) : '') +
      routeBlock(booking) +
      factsBlock(booking) +
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
