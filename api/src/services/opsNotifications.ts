import type { EmailAdapter } from '../adapters/email';
import { opsEmailShell, heroRef, detailTable, ctaBlock, money, esc, statusPill, keyFacts, section, TEAL_DEEP, MUTED, whatsappButton, whatsappLink, type SectionRow } from './opsEmail';
import { isUnpricedShell } from '../db/quoteRepo';
import type { RideList, RideMember } from '../domain/rideList';
import type { Booking } from '../db/bookingRepo';
import { factRows, routeText } from './notifications';
import { shortPlace } from '../quote/shortPlace';

// Internal staff notifications (spec 2026-07-16). Deliberately separate from
// services/notifications.ts: that file is customer-facing and Booking-shaped, this one goes to
// colleagues and is quote-shaped. Nothing here may carry cost or margin — an assignee can be
// finance/ops without margin:view, so this email only ever states the sell total.

export interface AssignedQuote {
  id: string;
  reference: string;
  status: string;
  customerName: string | null;
  totalCents: number;
  currency: string;
  // The stored request payload, carried purely so the template can spot an unpriced shell via the
  // one canonical marker check (isUnpricedShell) instead of keeping a second copy of it here.
  // Every caller passes a SavedQuote, which already has this.
  request: unknown;
}

// 'pending_review' → 'Pending review'
function statusLabel(s: string): string {
  const words = s.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// The whole point of the email: land on THIS quote, not the queue. ops-ui's routeStateFromUrl
// reads ?quote= before the hash, so no #quote fragment is needed. Empty when OPS_BASE_URL is
// unset — we'd rather send a linkless email than stay silent, so callers must tolerate ''.
export function quoteDeepLink(id: string, opsBaseUrl: string): string {
  const base = (opsBaseUrl || '').trim().replace(/\/+$/, '');
  return base ? `${base}/ops?quote=${encodeURIComponent(id)}` : '';
}

function assignedBody(q: AssignedQuote, lead: string, cta: { label: string; link: string }): { html: string; text: string } {
  // A shell is handed over BEFORE it is priced (spec 2026-07-29), so its stored total is a
  // placeholder 0 — mailing "$0.00" would tell the colleague the quote is worthless. Match the
  // queue's wording. (Only the assign path can reach this: the send gate blocks a shell from
  // pending_review/ready, so the approval and send-back mails never see one.)
  const total = isUnpricedShell(q) ? 'Not priced yet' : money(q.totalCents, q.currency);
  const rows: [string, string][] = [
    ['Customer', q.customerName || '—'],
    ['Total', total],
    ['Status', statusLabel(q.status)],
  ];
  const html = [
    `<p style="font-size:16px;margin:0 0 4px">${lead}</p>`,
    heroRef(q.reference),
    detailTable(rows),
    ctaBlock(cta.label, cta.link, 'Open it from the Quotes tab in the ops dashboard.'),
  ].join('');
  const text = [
    lead.replace(/<[^>]+>/g, ''),
    '',
    `Reference: ${q.reference}`,
    `Customer:  ${q.customerName || '—'}`,
    `Total:     ${total}`,
    `Status:    ${statusLabel(q.status)}`,
    '',
    cta.link ? `${cta.label}: ${cta.link}` : 'Open it from the Quotes tab in the ops dashboard.',
  ].join('\n');
  return opsEmailShell(html, text);
}

// Throws on a provider failure — callers make it best-effort. An assignment that only half-lands
// (row updated, nobody told) is bad, but an assign that 500s because Resend blipped is worse.
export async function sendQuoteAssigned(
  q: AssignedQuote,
  assignedTo: string,
  assignedBy: string,
  email: EmailAdapter,
  opsBaseUrl: string,
): Promise<void> {
  const link = quoteDeepLink(q.id, opsBaseUrl);
  const { html, text } = assignedBody(q, `<strong>${esc(assignedBy)}</strong> assigned you a quote.`, {
    label: 'Open the quote',
    link,
  });
  await email.send({ to: assignedTo, subject: `Quote ${q.reference} assigned to you — Ceylon Hop ops`, html, text, audience: 'ops' });
}

export async function sendQuoteAwaitingApproval(
  q: AssignedQuote,
  to: string,
  submittedBy: string,
  email: EmailAdapter,
  opsBaseUrl: string,
): Promise<void> {
  const link = quoteDeepLink(q.id, opsBaseUrl);
  const { html, text } = assignedBody(q, `<strong>${esc(submittedBy)}</strong> submitted a quote for approval.`, {
    label: 'Review the quote',
    link,
  });
  await email.send({ to, subject: `Quote ${q.reference} needs your approval — Ceylon Hop ops`, html, text, audience: 'ops' });
}

export async function sendQuoteSentBack(
  q: AssignedQuote,
  to: string,
  sentBackBy: string,
  note: string | null,
  email: EmailAdapter,
  opsBaseUrl: string,
): Promise<void> {
  const link = quoteDeepLink(q.id, opsBaseUrl);
  const lead = `<strong>${esc(sentBackBy)}</strong> sent your quote back for changes.`;
  const noteHtml = note ? `<p style="margin:0 0 20px;padding:12px 14px;background:#F0EEE5;border-radius:6px;font-size:14px">${esc(note)}</p>` : '';
  const html = [`<p style="font-size:16px;margin:0 0 4px">${lead}</p>`, heroRef(q.reference), noteHtml, ctaBlock('Open the quote', link, 'Open it from the Quotes tab in the ops dashboard.')].join('');
  const text = [lead.replace(/<[^>]+>/g, ''), '', `Reference: ${q.reference}`, note ? `\nNote: ${note}` : '', '', link ? `Open the quote: ${link}` : 'Open it from the Quotes tab.'].join('\n');
  const wrapped = opsEmailShell(html, text);
  await email.send({ to, subject: `Changes requested on quote ${q.reference} — Ceylon Hop ops`, html: wrapped.html, text: wrapped.text, audience: 'ops' });
}

// ---------------------------------------------------------------------------
// Ride Board: a seat was held (spec 2026-09-22). Until this, ops learned that a traveller had
// started or joined a shared ride only by opening the dashboard. One mail per commitment that
// moves — a list started, a name added, a seat count changed — on the same hook as the
// traveller's receipt, so it fires on the PayHere callback too (where every production join
// completes). Recipient is ALERT_EMAIL, the inbox the digest and watchdog already use.
// ---------------------------------------------------------------------------

export type SeatHeldKind = 'started' | 'joined' | 'changed';

export interface SeatHeldArgs {
  to: string;
  list: RideList;
  member: RideMember;
  /** Live seats on the list AFTER this commitment, so the subject reads "2 of 4 seats". */
  committed: number;
  kind: SeatHeldKind;
}

// ops-ui's routeStateFromUrl reads ?booking= and the sheet opener special-cases the board:
// prefix, so this lands on the van sheet itself. '' when OPS_BASE_URL is unset — same
// tolerate-a-linkless-email rule as quoteDeepLink.
export function boardDeepLink(code: string, opsBaseUrl: string): string {
  const base = (opsBaseUrl || '').trim().replace(/\/+$/, '');
  return base ? `${base}/ops?booking=board:${encodeURIComponent(code)}` : '';
}

// "Fri, 14 Aug 2026" — the same shape the traveller's receipt uses. Noon anchors the calendar
// date so no zone can roll it a day either way.
function rideDay(d: string): string {
  const dt = new Date(`${d}T12:00:00`);
  if (Number.isNaN(dt.getTime())) return d;
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(dt);
}

// Cutoff on the clock ops runs on.
function colomboStamp(at: Date): string {
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Colombo', day: 'numeric', month: 'short', year: 'numeric' }).format(at);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Colombo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  return `${day} at ${time}`;
}

const seatsWord = (n: number) => (n === 1 ? '1 seat' : `${n} seats`);

export async function sendRideSeatHeld(args: SeatHeldArgs, email: EmailAdapter, opsBaseUrl: string): Promise<void> {
  const { list, member, committed, kind } = args;
  const route = `${list.fromPlace} → ${list.toPlace}`;
  const day = rideDay(list.date);
  const viable = committed >= list.minSeats;
  const headline =
    kind === 'started' ? 'New shared ride' : kind === 'changed' ? 'Seats changed' : 'Seat taken';
  const subject = `${headline}: ${route}, ${day} (${committed} of ${list.minSeats} seats) — Ceylon Hop ops`;
  const lead =
    kind === 'started'
      ? `${member.firstName} started a shared ride and holds the first seat.`
      : kind === 'changed'
        ? `${member.firstName} now holds ${seatsWord(member.seats)} on this ride.`
        : `${member.firstName} added their name to this ride.`;
  const pill = kind === 'started' ? 'NEW SHARED RIDE' : kind === 'changed' ? 'SEATS CHANGED' : 'SEAT HELD';
  const fill = `${committed} of ${list.minSeats} needed · ${list.capacity} max`;
  const viableLine = viable ? 'The van is viable — enough names to run at the cutoff.' : 'Still short of the minimum.';
  const link = boardDeepLink(list.code, opsBaseUrl);
  const fallback = 'Find it under Bookings in the ops dashboard.';

  const rideRows: [string, string][] = [
    ['Departs', `${day} · ${list.slot}`],
    ['Committed', fill],
    ['Cutoff', colomboStamp(list.cutoffAt)],
    ['Seat price', money(list.seatPrice, 'USD')],
  ];
  const travellerRows: [string, string][] = [
    ['Traveller', `${member.firstName} (${member.country})`],
    ['Email', member.email],
    ['Seats', seatsWord(member.seats)],
  ];
  const html = [
    `<p style="margin:0 0 10px">${statusPill(pill, TEAL_DEEP, '#e2f0f3')}</p>`,
    `<p style="font-size:21px;font-weight:700;margin:0 0 2px">${esc(route)}</p>`,
    `<p style="font-size:15px;font-weight:600;color:${TEAL_DEEP};margin:0 0 12px">${esc(list.code)}</p>`,
    `<p style="font-size:15px;margin:0 0 16px">${esc(lead)}</p>`,
    keyFacts([['Seats', String(member.seats)], ['Filled', `${committed} of ${list.minSeats}`], ['Departs', `${shortDay(list.date)} · ${list.slot}`]]),
    `<p style="margin:0 0 18px;padding:12px 14px;background:#F0EEE5;border-radius:6px;font-size:14px;font-weight:500">${esc(viableLine)}</p>`,
    section('Ride', rideRows),
    section('Traveller', travellerRows),
    ctaBlock('Open the van', link, fallback),
  ].join('');
  const rows = (title: string, r: [string, string][]) => [title.toUpperCase(), ...r.map(([k, v]) => `${(k + ':').padEnd(12)}${v}`), ''];
  const text = [
    `${pill} · ${list.code}`,
    route,
    lead,
    '',
    viableLine,
    '',
    ...rows('Ride', rideRows),
    ...rows('Traveller', travellerRows),
    link ? `Open the van: ${link}` : fallback,
  ].join('\n');
  const wrapped = opsEmailShell(html, text);
  await email.send({ to: args.to, subject, html: wrapped.html, text: wrapped.text, audience: 'ops' });
}

// ---------------------------------------------------------------------------
// The team's "Paid:" email (owner, 2026-09-23). Money landed on a booking: who, where, when,
// which vehicle, how many people, how much. It was a monospace alert dump with no vehicle or
// head-count. The owner forwards these from Gmail on the subject prefix, so every subject
// here MUST start "Paid: " (guarded by opsNotifications.test.ts) and nothing else may.
// ---------------------------------------------------------------------------

// Lands on the booking sheet: ops-ui's routeStateFromUrl reads ?booking=<id>. '' without
// OPS_BASE_URL, same tolerate-a-linkless-email rule as quoteDeepLink.
export function bookingDeepLink(id: string, opsBaseUrl: string): string {
  const base = (opsBaseUrl || '').trim().replace(/\/+$/, '');
  return base ? `${base}/ops?booking=${encodeURIComponent(id)}` : '';
}

// "Fri 25 Sep" — short enough for a subject line. Noon anchors the calendar date.
function shortDay(d: string): string {
  const dt = new Date(`${d}T12:00:00`);
  if (Number.isNaN(dt.getTime())) return d;
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).format(dt).replace(',', '');
}

function headCount(b: Booking): number {
  if (b.mode === 'trip') return b.input.pax;
  if (b.mode === 'shared') return b.input.seats;
  return b.input.adults + b.input.children;
}

// Everything the team emails say about a booking, computed once so "Paid:", "Cancelled:" and
// "Refunded:" describe the same booking in the same words.
function bookingFacts(b: Booking) {
  const c = b.input.customer;
  const shared = b.mode === 'shared';
  const n = headCount(b);
  const vehicle = b.mode === 'shared' ? '' : b.input.vehicleType === 'van' ? 'AC van' : 'AC car';
  const route = routeText(b);
  // Long itineraries are shortened in the subject only; the body keeps every stop.
  const subjectRoute =
    b.mode === 'trip' && b.input.stops.length > 2
      ? `${shortPlace(b.input.stops[0])} → … → ${shortPlace(b.input.stops[b.input.stops.length - 1])}`
      : route;
  const start = b.mode === 'trip' ? b.input.dates?.find(Boolean) : b.input.date;
  const when = start ? (b.mode === 'trip' ? `from ${shortDay(start)}` : shortDay(start)) : 'date TBC';
  const time = b.mode !== 'trip' && b.input.time ? ` · ${b.input.time}` : '';
  const people = shared ? `${n} seat${n === 1 ? '' : 's'}` : `${vehicle} · ${n} pax`;
  // The customer email's own fact rows, in the team's word for travellers.
  const tripRows = factRows(b).map(([k, v]): [string, string] => [k === 'Travellers' ? 'Passengers' : k, v]);
  if (b.mode === 'trip') tripRows.unshift(['Stops', route]);
  const customerRows: SectionRow[] = [
    ['Name', `${c.firstName} ${c.lastName}`],
    ['Email', c.email],
    ['WhatsApp', c.whatsapp, whatsappButton(c.whatsapp)],
  ];
  // What a paid booking actually took: a deposit booking charges amountDueNow, not the total.
  const paidNow = b.amountDueNow != null && b.amountDueNow < b.total ? b.amountDueNow : b.total;
  return { shared, n, vehicle, route, subjectRoute, when, time, people, tripRows, customerRows, paidNow };
}

type BookingFacts = ReturnType<typeof bookingFacts>;

// The three facts in the grey boxes. `dateLabel` is "Travels", "Starts" or "Was due".
function bookingKeys(f: BookingFacts, b: Booking, dateLabel?: string): [string, string][] {
  const label = dateLabel ?? (b.mode === 'trip' ? 'Starts' : 'Travels');
  return f.shared
    ? [['Seats', String(f.n)], [label, `${f.when}${f.time}`]]
    : [['Vehicle', f.vehicle], ['Passengers', String(f.n)], [label, `${f.when}${f.time}`]];
}

interface TeamBookingParts {
  pill: [string, string, string]; // label, colour, background
  lead?: string;
  keys: [string, string][];
  note?: string;
  moneyTitle: string;
  moneyRows: [string, string][];
  strong: string[];
}

function teamBookingBody(b: Booking, f: BookingFacts, p: TeamBookingParts, opsBaseUrl: string): { html: string; text: string } {
  const link = bookingDeepLink(b.id, opsBaseUrl);
  const fallback = 'Find it under Bookings in the ops dashboard.';
  const lead = p.lead ? ` <span style="font-size:14px;color:${MUTED};margin-left:6px">${esc(p.lead)}</span>` : '';
  const html = [
    `<p style="margin:0 0 10px">${statusPill(...p.pill)}${lead}</p>`,
    `<p style="font-size:21px;font-weight:700;margin:0 0 2px">${esc(f.route)}</p>`,
    `<p style="font-size:15px;font-weight:600;color:${TEAL_DEEP};margin:0 0 16px">${esc(b.reference)}</p>`,
    keyFacts(p.keys),
    p.note ? `<p style="margin:0 0 18px;padding:12px 14px;background:#F0EEE5;border-radius:6px;font-size:14px">${esc(p.note)}</p>` : '',
    section('Trip', f.tripRows),
    section('Customer', f.customerRows),
    section(p.moneyTitle, p.moneyRows, p.strong),
    ctaBlock('Open the booking', link, fallback),
  ].join('');
  const rows = (title: string, r: SectionRow[]) => [title.toUpperCase(), ...r.map(([k, v]) => `${(k + ':').padEnd(13)}${v}`), ''];
  const wa = whatsappLink(b.input.customer.whatsapp);
  const customerText: SectionRow[] = f.customerRows.map(([k, v]) => [k, k === 'WhatsApp' && wa ? `${v} · ${wa}` : v]);
  const text = [
    `${p.pill[0]} · ${b.reference}${p.lead ? ` · ${p.lead}` : ''}`,
    f.route,
    '',
    ...(p.note ? [p.note, ''] : []),
    ...rows('Trip', f.tripRows),
    ...rows('Customer', customerText),
    ...rows(p.moneyTitle, p.moneyRows),
    link ? `Open the booking: ${link}` : fallback,
  ].join('\n');
  return opsEmailShell(html, text);
}

const channelLabel = (b: Booking) => (b.channel === 'whatsapp' ? 'WhatsApp' : 'Website');

export function teamPaidEmail(b: Booking, opsBaseUrl: string): { subject: string; html: string; text: string } {
  const f = bookingFacts(b);
  const balance = b.total - f.paidNow;
  const paid = money(f.paidNow, b.currency);
  const subject = `Paid: ${f.subjectRoute}, ${f.when} — ${f.people} — ${paid}`;
  const moneyRows: [string, string][] = [
    ['Paid', paid],
    ...(balance > 0 ? [['Balance due', money(balance, b.currency)] as [string, string]] : []),
    ['Channel', channelLabel(b)],
  ];
  return {
    subject,
    ...teamBookingBody(b, f, { pill: ['PAID', '#1f6b3a', '#e3f1e6'], keys: bookingKeys(f, b), moneyTitle: 'Payment', moneyRows, strong: ['Paid'] }, opsBaseUrl),
  };
}

// ---------------------------------------------------------------------------
// Cancelled / Refunded (owner, 2026-09-23). Both used to reach only the customer. Subjects
// start "Cancelled: " / "Refunded: " — deliberately NOT "Paid:", which the owner forwards on.
// ---------------------------------------------------------------------------

export interface TeamCancelledArgs {
  by: string;
  reason: string;
  /** Status before the cancel: a booking still awaiting payment took no money. */
  statusBefore: string;
  /** Sum already refunded (confirmed) before this cancel, minor units. */
  refundedCents: number;
}

// Every status before money is taken (domain/status.ts): a cancel from one of these refunds nothing.
const UNPAID_STATUSES = new Set(['draft', 'payment_pending', 'awaiting_details']);

export function teamCancelledEmail(b: Booking, a: TeamCancelledArgs, opsBaseUrl: string): { subject: string; html: string; text: string } {
  const f = bookingFacts(b);
  const tookMoney = !UNPAID_STATUSES.has(a.statusBefore);
  const subject = f.shared
    ? `Cancelled: ${f.subjectRoute}, ${f.when} — ${f.people} released — ${b.reference}`
    : `Cancelled: ${f.subjectRoute}, ${f.when} — ${f.people} — ${b.reference}`;
  const owed = f.paidNow - a.refundedCents;
  const moneyRows: [string, string][] = tookMoney
    ? [
        ['Paid', money(f.paidNow, b.currency)],
        [
          'Refund',
          a.refundedCents <= 0
            ? 'Not refunded yet — open the booking to refund'
            : owed > 0
              ? `${money(a.refundedCents, b.currency)} refunded · ${money(owed, b.currency)} not refunded`
              : `${money(a.refundedCents, b.currency)} refunded (full)`,
        ],
      ]
    : [['Paid', 'Not paid — nothing to refund']];
  if (f.shared) f.tripRows.push(['Released', `${f.people} back on sale`]);
  return {
    subject,
    ...teamBookingBody(
      b,
      f,
      {
        pill: ['CANCELLED', '#8a6a63', '#f2eae8'],
        lead: `Cancelled by ${a.by}`,
        keys: bookingKeys(f, b, 'Was due'),
        note: `Reason: ${a.reason}`,
        moneyTitle: 'Money',
        moneyRows,
        strong: ['Refund'],
      },
      opsBaseUrl,
    ),
  };
}

export interface TeamRefundedArgs {
  amountCents: number;
  currency: string;
  full: boolean;
  by: string;
  reason: string;
  gatewayRef: string | null;
  viaApi: boolean;
}

export function teamRefundedEmail(b: Booking, a: TeamRefundedArgs, opsBaseUrl: string): { subject: string; html: string; text: string } {
  const f = bookingFacts(b);
  const amount = money(a.amountCents, a.currency);
  const subject = `Refunded: ${f.subjectRoute}, ${f.when} — ${amount} back to customer${a.full ? '' : ' (partial)'} — ${b.reference}`;
  const moneyRows: [string, string][] = [
    ['Paid', money(f.paidNow, b.currency)],
    ['Refunded', `${amount} (${a.full ? 'full' : 'partial'})`],
    ['Method', a.viaApi ? 'PayHere (automatic)' : 'PayHere (by hand)'],
    ...(a.gatewayRef ? [['PayHere ref', a.gatewayRef] as [string, string]] : []),
  ];
  const keys: [string, string][] = [['Refunded', amount], ...bookingKeys(f, b).slice(0, 2)];
  return {
    subject,
    ...teamBookingBody(
      b,
      f,
      {
        pill: ['REFUNDED', '#6b4f8a', '#eee8f4'],
        lead: `Refunded by ${a.by}`,
        keys,
        note: `Reason: ${a.reason}`,
        moneyTitle: 'Money',
        moneyRows,
        strong: ['Refunded'],
      },
      opsBaseUrl,
    ),
  };
}

// ---------------------------------------------------------------------------
// Ride Board: the ride locked in and the cards were charged (owner, 2026-09-23). The
// travellers get "It's on!"; this is the team's copy, and it doubles as the driver manifest.
// A "Paid:" mail like teamPaidEmail — money landed — so the owner's Gmail forward catches it.
// ---------------------------------------------------------------------------

export interface RideLockedArgs {
  list: RideList;
  /** The departure the sweep just pinned. */
  time: string;
  /** Real travellers whose seat is paid (or whose charge outcome is unknown — see below). */
  charged: RideMember[];
  /** Real travellers whose card declined: emailed "at risk", not on the van unless they pay. */
  declined: RideMember[];
  /** Subset of `charged` whose charge reply was lost — flagged, since that money is in doubt. */
  unknown: RideMember[];
  /** Placeholder seats that helped clear the minimum but are nobody. */
  seedSeats: number;
  currency: string;
}

export function teamRideLockedEmail(a: RideLockedArgs, opsBaseUrl: string): { subject: string; html: string; text: string } {
  const { list, time } = a;
  const route = `${list.fromPlace} → ${list.toPlace}`;
  const pax = a.charged.reduce((n, m) => n + m.seats, 0);
  const collected = money(pax * list.seatPrice, a.currency);
  const unknownSubs = new Set(a.unknown.map((m) => m.sub));
  const subject = `Paid: Locked in — ${route}, ${shortDay(list.date)} ${time} — Shared taxi · ${pax} pax — ${collected} collected`;

  const rideRows: [string, string][] = [
    ['Departs', `${rideDay(list.date)} · ${time} (locked)`],
    ['Vehicle', `Shared taxi · ${list.capacity} seats max`],
    ['Passengers', `${pax} paid${a.seedSeats ? ` + ${a.seedSeats} placeholder seat${a.seedSeats === 1 ? '' : 's'} (not people)` : ''}`],
    ['Seat price', money(list.seatPrice, a.currency)],
  ];
  const onBoard: [string, string][] = a.charged.map((m) => [
    `${m.firstName} (${m.country})`,
    `${seatsWord(m.seats)} · ${unknownSubs.has(m.sub) ? 'charge unconfirmed' : 'paid'} · ${m.email}`,
  ]);
  const moneyRows: [string, string][] = [
    ['Collected', `${collected} (${seatsWord(pax)})`],
    ...(a.unknown.length ? [['Unconfirmed', `${a.unknown.length} charge(s) — check PayHere before chasing`] as [string, string]] : []),
    ['Card declined', a.declined.length ? a.declined.map((m) => `${m.firstName} (${seatsWord(m.seats)}, ${m.email})`).join('; ') : 'None'],
  ];
  const link = boardDeepLink(list.code, opsBaseUrl);
  const fallback = 'Find it under Bookings in the ops dashboard.';

  const html = [
    `<p style="margin:0 0 10px">${statusPill('RIDE LOCKED IN', '#1f6b3a', '#e3f1e6')}</p>`,
    `<p style="font-size:21px;font-weight:700;margin:0 0 2px">${esc(route)}</p>`,
    `<p style="font-size:15px;font-weight:600;color:${TEAL_DEEP};margin:0 0 16px">${esc(list.code)}</p>`,
    keyFacts([['Vehicle', 'Shared taxi'], ['Passengers', String(pax)], ['Departs', `${shortDay(list.date)} · ${time}`]]),
    section('Ride', rideRows),
    section('On board', onBoard),
    section('Money', moneyRows, ['Collected']),
    ctaBlock('Open the ride', link, fallback),
  ].join('');
  const rows = (title: string, r: [string, string][]) => [title.toUpperCase(), ...r.map(([k, v]) => `${(k + ':').padEnd(15)}${v}`), ''];
  const text = [
    `PAID · RIDE LOCKED IN · ${list.code}`,
    route,
    '',
    ...rows('Ride', rideRows),
    ...rows('On board', onBoard),
    ...rows('Money', moneyRows),
    link ? `Open the ride: ${link}` : fallback,
  ].join('\n');
  return { subject, ...opsEmailShell(html, text) };
}
