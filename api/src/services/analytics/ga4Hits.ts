// Measurement Protocol hits (spec 2026-10-03 §5.3-5.5). PURE: same input, same hit. The
// reporter stores the hit in the ledger at first claim and every retry re-sends it unchanged.
// Hard MP limits: ≤25 params per event, string values ≤100 chars, enforced here and tested.

import { createHash } from 'node:crypto';
import type { Ga4Event, Ga4Hit, Ga4Item } from '../../adapters/ga4';
import type { Booking } from '../../db/bookingRepo';
import type { GaIdentity } from '../../db/ga4Repo';
import type { Payment } from '../../db/paymentRepo';
import type { Refund } from '../../db/refundRepo';
import type { RideList, RideMember } from '../../domain/rideList';
import { projectBooking } from '../../routes/bookings';
import { promoDiscount } from '../notifications';
import { purchaseFacts, type PurchaseFacts } from './purchaseFacts';

export type Ga4PurchaseName = 'purchase' | 'purchase_server';
export const MAX_PARAMS = 25;
export const MAX_STRING = 100;

const cut = (s: string): string => s.slice(0, MAX_STRING);
const usd = (cents: number): number => Math.round(cents) / 100;
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const micros = (d: Date): number => d.getTime() * 1000;

// The site denies ad consent by default in the EEA, UK and Switzerland (booking.html:25-29).
// Country values are NAMES as entered on the booking / pay / board forms.
const EEA_UK_CH = new Set([
  'austria', 'belgium', 'bulgaria', 'croatia', 'cyprus', 'czech republic', 'czechia', 'denmark', 'estonia',
  'finland', 'france', 'germany', 'greece', 'hungary', 'ireland', 'italy', 'latvia', 'lithuania', 'luxembourg',
  'malta', 'netherlands', 'poland', 'portugal', 'romania', 'slovakia', 'slovenia', 'spain', 'sweden',
  'iceland', 'liechtenstein', 'norway', 'united kingdom', 'switzerland',
]);

export function consentFor(identity: GaIdentity | null, country: string | null | undefined): 'GRANTED' | 'DENIED' {
  if (identity?.adConsent === 'granted') return 'GRANTED';
  if (identity?.adConsent === 'denied') return 'DENIED';
  const c = (country ?? '').trim().toLowerCase();
  // 'Other' is the booking form's catch-all, not a known country: never grant on it.
  return c && c !== 'other' && !EEA_UK_CH.has(c) ? 'GRANTED' : 'DENIED';
}

// RideMember.country is a 2-letter code ('XX' when unknown), not a name. Name it so customer_country
// reads like the booking path; null when unknown or not a real code.
function boardCountryName(code: string | null | undefined): string | null {
  const c = (code ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c) || c === 'XX') return null;
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(c);
    return name && name !== c ? name : null;
  } catch {
    return null;
  }
}

// A booking we have no GA visitor for still counts: a deterministic synthetic id (retries reuse
// it), derived from the ledger key, never from anything personal.
const clientIdFor = (identity: GaIdentity | null, eventKey: string): string =>
  identity?.clientId ?? `srv.${sha(eventKey).slice(0, 16)}`;

export function bookingFacts(b: Booking): PurchaseFacts {
  const v = projectBooking(b);
  const chauffeur = b.mode === 'trip' && (b.input as { serviceType?: string }).serviceType === 'chauffeur';
  return purchaseFacts({
    service: b.mode === 'single' ? 'transfer' : b.mode === 'shared' ? 'shared_seat' : chauffeur ? 'chauffeur' : 'trip',
    stops: v.stops,
    pax: v.travellers,
    vehicle: v.vehicleType,
    date: v.date,
  });
}

const itemFor = (f: PurchaseFacts, value: number): Ga4Item => ({
  item_id: cut(f.route), item_name: cut(f.route), item_category: f.service_type, price: value, quantity: 1,
});

function factParams(f: PurchaseFacts, at: Date): Record<string, string | number> {
  const p: Record<string, string | number> = {
    service_type: f.service_type, route: cut(f.route), region_route: cut(f.region_route),
    pickup: f.pickup, dropoff: f.dropoff, pickup_region: f.pickup_region, dropoff_region: f.dropoff_region,
    vehicle_type: f.vehicle_type,
  };
  if (f.pax != null) p.pax = f.pax;
  if (f.travel_date) {
    p.travel_month = f.travel_date.slice(0, 7);
    p.days_to_travel = Math.max(0, Math.round((Date.parse(f.travel_date) - Date.parse(at.toISOString().slice(0, 10))) / 86_400_000));
  }
  return p;
}

function checked(e: Ga4Event): Ga4Event {
  const n = Object.keys(e.params).length;
  if (n > MAX_PARAMS) throw new Error(`ga4_too_many_params_${n}`);
  for (const v of Object.values(e.params)) {
    if (typeof v === 'string' && v.length > MAX_STRING) throw new Error('ga4_param_too_long');
  }
  return e;
}

const countryOf = (b: Booking): string =>
  b.billing?.country ?? (b.input.customer as { country?: string }).country ?? '';

export interface PurchaseHitInput {
  booking: Booking; payment: Payment; settledAt: Date; identity: GaIdentity | null;
  returning: boolean; secondPayment: boolean; eventName: Ga4PurchaseName;
}

export function purchaseHit(i: PurchaseHitInput): Ga4Hit {
  const b = i.booking;
  const facts = bookingFacts(b);
  const value = usd(i.payment.amount);
  const promo = promoDiscount(b);
  const country = countryOf(b);
  const consent = consentFor(i.identity, country);
  const params: Ga4Event['params'] = {
    transaction_id: i.secondPayment ? `${b.reference}-${i.payment.id.slice(0, 6)}` : b.reference,
    value,
    currency: i.payment.currency,
    payment_type: i.secondPayment ? 'balance' : i.payment.amount < b.total ? 'deposit' : 'full',
    ...(i.identity?.sessionId ? { session_id: i.identity.sessionId } : {}),
    engagement_time_msec: 1,
    items: [itemFor(facts, value)],
    ...factParams(facts, i.settledAt),
    booking_total: usd(b.total),
    ...(promo ? { coupon: cut(promo.code), discount: usd(promo.cents) } : {}),
    ...(country ? { customer_country: cut(country) } : {}),
    customer_type: i.returning ? 'returning' : 'new',
    channel: b.channel,
  };
  return {
    client_id: clientIdFor(i.identity, `purchase:${i.payment.id}`),
    timestamp_micros: micros(i.settledAt),
    consent: { ad_user_data: consent, ad_personalization: consent },
    events: [checked({ name: i.eventName, params })],
  };
}

export interface RefundHitInput {
  booking: Booking; refund: Refund; identity: GaIdentity | null; at: Date; secondPayment: boolean;
  /** The purchase event name in force: in shadow mode (`purchase_server`) the refund shadows too. */
  eventName: Ga4PurchaseName;
  /** The client_id the purchase was sent with; used when no identity is stored (spec §5.4: same client_id). */
  clientId?: string;
}

export function refundHit(i: RefundHitInput): Ga4Hit {
  const b = i.booking;
  const facts = bookingFacts(b);
  const value = usd(i.refund.amountCents);
  const consent = consentFor(i.identity, countryOf(b));
  return {
    client_id: i.identity?.clientId ?? i.clientId ?? clientIdFor(null, `refund:${i.refund.id}`),
    timestamp_micros: micros(i.at),
    consent: { ad_user_data: consent, ad_personalization: consent },
    events: [checked({
      name: i.eventName === 'purchase' ? 'refund' : 'refund_server',
      params: {
        // Same formula as purchaseHit, so the refund lands on the purchase it reverses.
        transaction_id: i.secondPayment ? `${b.reference}-${i.refund.paymentId.slice(0, 6)}` : b.reference,
        value,
        currency: i.refund.currency,
        ...(i.identity?.sessionId ? { session_id: i.identity.sessionId } : {}),
        engagement_time_msec: 1,
        items: [itemFor(facts, value)],
      },
    })],
  };
}

export interface BoardHitInput {
  list: RideList; member: RideMember; amountCents: number; currency: string; at: Date; eventName: Ga4PurchaseName;
}

export function boardHit(i: BoardHitInput): Ga4Hit {
  const facts = purchaseFacts({ service: 'shared_seat', stops: [i.list.fromPlace, i.list.toPlace], pax: i.member.seats, vehicle: null, date: i.list.date });
  const value = usd(i.amountCents);
  const country = boardCountryName(i.member.country);
  return {
    client_id: clientIdFor(null, `board:${i.list.id}:${i.member.sub}`),
    timestamp_micros: micros(i.at),
    // A synthetic visitor with no session gains nothing from granted ad consent: always denied.
    consent: { ad_user_data: 'DENIED', ad_personalization: 'DENIED' },
    events: [checked({
      name: i.eventName,
      params: {
        transaction_id: `${i.list.code}-${sha(i.member.sub).slice(0, 8)}`,
        value,
        currency: i.currency,
        payment_type: 'full',
        engagement_time_msec: 1,
        items: [itemFor(facts, value)],
        ...factParams(facts, i.at),
        booking_total: value,
        ...(country ? { customer_country: cut(country) } : {}),
        channel: 'ride_board',
      },
    })],
  };
}
