import { describe, it, expect } from 'vitest';
import type { Booking } from '../../db/bookingRepo';
import type { Payment } from '../../db/paymentRepo';
import type { Refund } from '../../db/refundRepo';
import type { RideList, RideMember } from '../../domain/rideList';
import { MAX_PARAMS, boardHit, consentFor, purchaseHit, refundHit } from './ga4Hits';

const customer = { firstName: 'Emma', lastName: 'L', email: 'emma@example.test', phoneCountryCode: '+44', phoneNumber: '7700900000', country: 'United Kingdom' };
const booking = {
  id: 'b-1', reference: 'CH-TEST1', status: 'paid', mode: 'single', channel: 'website', currency: 'USD',
  total: 22900, amountDueNow: 22900, createdAt: '2026-10-28T10:00:00.000Z',
  input: { customer, from: 'Colombo Airport (CMB)', to: 'Galle', date: '2026-11-08', time: '09:00', adults: 2, children: 0, bags: 2, vehicleType: 'car' },
} as unknown as Booking;
const payment = { id: 'pay-abcdef12', bookingId: 'b-1', provider: 'payhere', orderId: 'CH-TEST1', amount: 22900, currency: 'USD', idempotencyKey: 'checkout:b-1', status: 'succeeded', attemptCount: 1, lastAttemptAt: null } as Payment;
const SETTLED = new Date('2026-10-29T08:00:00Z');
const identity = { clientId: '123.456', sessionId: '1761724800', adConsent: 'unknown' as const };

describe('purchaseHit', () => {
  const hit = purchaseHit({ booking, payment, settledAt: SETTLED, identity, returning: false, secondPayment: false, eventName: 'purchase_server' });
  const p = hit.events[0].params;

  it('joins the checkout visit and is stamped at settlement', () => {
    expect(hit.client_id).toBe('123.456');
    expect(hit.timestamp_micros).toBe(SETTLED.getTime() * 1000);
    expect(hit.events[0].name).toBe('purchase_server');
    expect(p.session_id).toBe('1761724800');
  });
  it('carries the money as received and the sale facts', () => {
    expect(p).toMatchObject({
      transaction_id: 'CH-TEST1', value: 229, currency: 'USD', payment_type: 'full', booking_total: 229,
      service_type: 'transfer', route: 'Colombo Airport (CMB) → Galle', region_route: 'Airport & Negombo → South coast',
      pickup: 'Colombo Airport (CMB)', dropoff: 'Galle', pax: 2, vehicle_type: 'car',
      travel_month: '2026-11', days_to_travel: 10, customer_country: 'United Kingdom', customer_type: 'new', channel: 'website',
    });
    expect(p.items).toEqual([{ item_id: 'Colombo Airport (CMB) → Galle', item_name: 'Colombo Airport (CMB) → Galle', item_category: 'transfer', price: 229, quantity: 1 }]);
  });
  it('never carries personal data', () => {
    const raw = JSON.stringify(hit);
    for (const pii of ['emma@example.test', 'Emma', '7700900000', 'b-1']) expect(raw).not.toContain(pii);
  });
  it('a first partial payment is a deposit', () => {
    const dep = purchaseHit({ booking, payment: { ...payment, amount: 5000 }, settledAt: SETTLED, identity: null, returning: true, secondPayment: false, eventName: 'purchase' });
    expect(dep.events[0].params).toMatchObject({ value: 50, payment_type: 'deposit', booking_total: 229, customer_type: 'returning', transaction_id: 'CH-TEST1' });
    expect(dep.client_id).toMatch(/^srv\.[0-9a-f]{16}$/);
  });
  it('a second payment is a balance with its own transaction id, even below the total', () => {
    const bal = purchaseHit({ booking, payment: { ...payment, amount: 5000 }, settledAt: SETTLED, identity: null, returning: true, secondPayment: true, eventName: 'purchase' });
    expect(bal.events[0].params).toMatchObject({ value: 50, payment_type: 'balance', booking_total: 229, transaction_id: 'CH-TEST1-pay-ab' });
    const full = purchaseHit({ booking, payment, settledAt: SETTLED, identity: null, returning: true, secondPayment: true, eventName: 'purchase' });
    expect(full.events[0].params).toMatchObject({ payment_type: 'balance' });
  });
  it('stays within the Measurement Protocol limits', () => {
    expect(Object.keys(p).length).toBeLessThanOrEqual(MAX_PARAMS);
    for (const v of Object.values(p)) if (typeof v === 'string') expect(v.length).toBeLessThanOrEqual(100);
  });
});

describe('the fullest purchase hit', () => {
  // Every optional param present at once: promo, session, returning buyer, billing country, every
  // fact. This is the biggest hit we can send; GA4 drops events over 25 params. The exact count
  // is pinned so adding a param is a deliberate change to this test, not an accident.
  const full = {
    ...booking, promoCode: 'SUMMER-15', discountTotal: 670,
    billing: { country: 'Germany' },
  } as unknown as Booking;
  const hit = purchaseHit({ booking: full, payment, settledAt: SETTLED, identity, returning: true, secondPayment: false, eventName: 'purchase_server' });
  const p = hit.events[0].params;

  it('has every optional param, and its count is pinned under the 25 limit', () => {
    expect(p).toMatchObject({ session_id: '1761724800', coupon: 'SUMMER-15', discount: 6.7, customer_type: 'returning', pax: 2, travel_month: '2026-11', days_to_travel: 10 });
    expect(Object.keys(p).length).toBeLessThanOrEqual(MAX_PARAMS);
    expect(Object.keys(p)).toHaveLength(24);
  });
  it('billing country wins over the customer country', () => {
    expect(p.customer_country).toBe('Germany');
    expect(hit.consent).toEqual({ ad_user_data: 'DENIED', ad_personalization: 'DENIED' });
  });
});

describe('consentFor', () => {
  it('the stored choice wins; otherwise only a known non-EEA/UK/CH country is granted', () => {
    expect(consentFor({ clientId: null, sessionId: null, adConsent: 'granted' }, 'Germany')).toBe('GRANTED');
    expect(consentFor({ clientId: null, sessionId: null, adConsent: 'denied' }, 'Australia')).toBe('DENIED');
    expect(consentFor(null, 'Australia')).toBe('GRANTED');
    expect(consentFor(null, 'United Kingdom')).toBe('DENIED');
    expect(consentFor(null, '')).toBe('DENIED');
    expect(consentFor(null, 'Other')).toBe('DENIED');
    expect(consentFor(null, ' other ')).toBe('DENIED');
  });
});

describe('refundHit', () => {
  it('mirrors the purchase it reverses', () => {
    const refund = { id: 'rf-1', bookingId: 'b-1', paymentId: 'pay-abcdef12', provider: 'payhere', amountCents: 22900, currency: 'USD', status: 'manual_confirmed', reason: 'call me on +94 77 123 4567', gatewayRef: 'R1', requestedBy: 'f@x.com', confirmedBy: 'f@x.com', confirmedAt: SETTLED } as unknown as Refund;
    const hit = refundHit({ booking, refund, identity, at: SETTLED, secondPayment: false });
    expect(hit.events[0].name).toBe('refund');
    expect(hit.events[0].params).toMatchObject({ transaction_id: 'CH-TEST1', value: 229, currency: 'USD' });
    expect(hit.events[0].params).not.toHaveProperty('refund_reason');
  });
  it('carries no ops free text, even a reason holding a name', () => {
    const refund = { id: 'rf-3', bookingId: 'b-1', paymentId: 'pay-abcdef12', amountCents: 22900, currency: 'USD', reason: 'Emma Larsson asked to cancel' } as unknown as Refund;
    const hit = refundHit({ booking, refund, identity, at: SETTLED, secondPayment: false });
    expect(hit.events[0].params).not.toHaveProperty('refund_reason');
    expect(JSON.stringify(hit)).not.toContain('Larsson');
  });
  it('uses the purchase\'s client_id when given and no identity is stored; an identity wins', () => {
    const refund = { id: 'rf-4', bookingId: 'b-1', paymentId: 'pay-abcdef12', amountCents: 22900, currency: 'USD', reason: '' } as unknown as Refund;
    expect(refundHit({ booking, refund, identity: null, at: SETTLED, secondPayment: false, clientId: 'srv.0123456789abcdef' }).client_id).toBe('srv.0123456789abcdef');
    expect(refundHit({ booking, refund, identity, at: SETTLED, secondPayment: false, clientId: 'srv.0123456789abcdef' }).client_id).toBe('123.456');
    expect(refundHit({ booking, refund, identity: null, at: SETTLED, secondPayment: false }).client_id).toMatch(/^srv\.[0-9a-f]{16}$/);
  });
  it('a refund of a second payment carries that payment\'s transaction id', () => {
    const refund = { id: 'rf-2', bookingId: 'b-1', paymentId: 'abcdef123456', amountCents: 5000, currency: 'USD', reason: '' } as unknown as Refund;
    expect(refundHit({ booking, refund, identity, at: SETTLED, secondPayment: true }).events[0].params.transaction_id).toBe('CH-TEST1-abcdef');
    expect(refundHit({ booking, refund, identity, at: SETTLED, secondPayment: false }).events[0].params.transaction_id).toBe('CH-TEST1');
  });
});

describe('boardHit', () => {
  it('a charged seat: shared seat between known towns, no member id anywhere', () => {
    const list = { id: 'list-1', code: 'EM-4821', fromPlace: 'Ella', toPlace: 'Mirissa', date: '2026-11-08' } as RideList;
    const member = { sub: 'google-sub-123', email: 'm@x.com', firstName: 'M', country: 'AU', seats: 2 } as RideMember;
    const hit = boardHit({ list, member, amountCents: 4800, currency: 'USD', at: SETTLED, eventName: 'purchase_server' });
    expect(hit.events[0].params).toMatchObject({ service_type: 'shared_seat', route: 'Ella → Mirissa', pax: 2, value: 48, channel: 'ride_board', vehicle_type: 'shared' });
    expect(String(hit.events[0].params.transaction_id)).toMatch(/^EM-4821-[0-9a-f]{8}$/);
    expect(JSON.stringify(hit)).not.toContain('google-sub-123');
    expect(hit.consent).toEqual({ ad_user_data: 'DENIED', ad_personalization: 'DENIED' });
  });

  // RideMember.country is a 2-letter code (rideBoard.ts), 'XX' when unknown. A board hit has no
  // session, so it never grants ad consent; the code only names customer_country.
  const boardFor = (country: string) => boardHit({
    list: { id: 'list-1', code: 'EM-4821', fromPlace: 'Ella', toPlace: 'Mirissa', date: '2026-11-08' } as RideList,
    member: { sub: 's', email: 'm@x.com', firstName: 'M', country, seats: 1 } as RideMember,
    amountCents: 4800, currency: 'USD', at: SETTLED, eventName: 'purchase_server',
  });
  it('a known non-EEA code is named in customer_country but never granted', () => {
    const hit = boardFor('AU');
    expect(hit.consent).toEqual({ ad_user_data: 'DENIED', ad_personalization: 'DENIED' });
    expect(hit.events[0].params.customer_country).toBe('Australia');
  });
  it('EU and ZZ (not countries) are denied too', () => {
    for (const c of ['EU', 'ZZ']) expect([c, boardFor(c).consent]).toEqual([c, { ad_user_data: 'DENIED', ad_personalization: 'DENIED' }]);
  });
  it('an unknown code is denied and sends no country', () => {
    for (const c of ['XX', '', 'zz9']) {
      const hit = boardFor(c);
      expect(hit.consent.ad_user_data).toBe('DENIED');
      expect(hit.consent.ad_personalization).toBe('DENIED');
      expect(hit.events[0].params).not.toHaveProperty('customer_country');
    }
  });
  it('every EEA/UK/CH code is denied', () => {
    const codes = 'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO GB CH'.split(' ');
    expect(codes).toHaveLength(32);
    for (const c of codes) expect([c, boardFor(c).consent.ad_user_data]).toEqual([c, 'DENIED']);
  });
});
