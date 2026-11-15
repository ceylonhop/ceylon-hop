// Add-ons after booking (spec docs/superpowers/specs/2026-11-14-post-booking-add-ons-design.md §4,
// §7.1). What the ops routes call: send a request, cancel one, and read a booking's requests as
// the ops pane shows them. The rules themselves are pure and live in domain/addOns.ts; the repo
// guards the one-per-leg rule under the booking's lock. Nothing here writes to the booking: the
// original sale is never rewritten.
import type { Booking } from '../db/bookingRepo';
import type { Payment, PaymentRepo } from '../db/paymentRepo';
import { REFUNDED_STATUSES, type Refund, type RefundRepo } from '../db/refundRepo';
import { AddOnError, type AddOnRepo, type AddOnRequest, type StoredLeg } from '../db/addOnRepo';
import {
  addOnCatalogue, addOnLineLabel, addOnOrderId, addOnRequestState, bookingAddOnEligibility,
  isAddOnRequestPayable, isPrivateBooking, legAddOnEligibility,
  type AddOnCreateError, type AddOnRequestState, type AddOnRequestStatus,
} from '../domain/addOns';
import { isoToday } from '../domain/dateRules';
import { CHECKOUT_TOKEN_TTL_MS } from '../lib/bookingToken';
import { shortPlace } from '../quote/shortPlace';
import type { RateCard } from '../quote/rateCard';
import { wasDelivered, type EmailAdapter } from '../adapters/email';
import { manageUrl, sendAddOnRequest } from './notifications';

export interface AddOnDeps {
  addOns: AddOnRepo;
  payments: Pick<PaymentRepo, 'findByBookingId'>;
  // Absent = no refund is known, so every paid request reads as not refunded.
  refunds?: Pick<RefundRepo, 'list'>;
  /** The live rate card (`liveRateCard`): the code card with the Rates page's revisions applied. */
  rateCard: () => Promise<RateCard>;
  email?: EmailAdapter;
  // The customer site's origin and the link secret: together they make the manage link the
  // customer pays from. Without both, no request carries a pay link and none is emailed.
  baseUrl?: string;
  linkSecret?: string;
}

export interface AddOnCatalogueItem { code: string; label: string; priceCents: number }

/** One request as the ops API returns it. Times are ISO strings. */
export interface AddOnRequestView {
  id: string;
  seq: number;
  /** "A1": how the request is named beside its payment. */
  name: string;
  status: AddOnRequestStatus;
  state: AddOnRequestState;
  totalCents: number;
  currency: string;
  orderId: string;
  payable: boolean;
  /** The customer's manage page at its add-ons card. Only while payable. */
  payLink: string | null;
  /** When a checkout the customer has open stops blocking a cancel. Only while one is in flight. */
  inFlightUntil: string | null;
  /** Confirmed refunds on this request's own payment. */
  refundedCents: number;
  createdBy: string;
  createdAt: string;
  paidAt: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  lines: Array<{ id: string; legId: string; code: string; label: string; amountCents: number }>;
}

export interface AddOnViews {
  legs: StoredLeg[];
  addOnRequests: AddOnRequestView[];
  /** Present only when a request can be created on this booking (§4.1). */
  addOnCatalogue?: AddOnCatalogueItem[];
}

export type CreateAddOnResult =
  | { ok: true; request: AddOnRequestView; emailed: boolean }
  | { ok: false; error: AddOnCreateError };

export type CancelAddOnError = 'request_not_found' | 'already_paid' | 'not_open' | 'payment_in_flight';
export type CancelAddOnResult =
  | { ok: true; request: AddOnRequestView }
  | { ok: false; error: CancelAddOnError };

// The eligibility rules read `serviceType` at the top level; a Booking holds it inside `input`.
// Handing them the booking as it is typechecks and reads a private trip as not private.
const bookingFacts = (b: Booking) => ({
  mode: b.mode,
  serviceType: b.mode === 'trip' ? b.input.serviceType : null,
  status: b.status,
  needsPricing: b.needsPricing,
});

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

// Confirmed refunds per payment: money that has actually gone back (the admin cancel route sums
// the same two statuses for the whole booking).
function refundedByPayment(refunds: Refund[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of refunds) {
    if (REFUNDED_STATUSES.includes(r.status)) out.set(r.paymentId, (out.get(r.paymentId) ?? 0) + r.amountCents);
  }
  return out;
}

// What a request's stored row cannot say on its own: where the booking, its legs, the request's
// payment and "now" have left it.
interface ViewContext {
  booking: Booking;
  legs: StoredLeg[];
  payments: Payment[];
  refunded: Map<string, number>;
  manageLink: string | null;
  now: Date;
}

function viewOf(req: AddOnRequest, ctx: ViewContext): AddOnRequestView {
  const today = isoToday('Asia/Colombo', ctx.now);
  const payment = req.paymentId ? ctx.payments.find((p) => p.id === req.paymentId) : undefined;
  const refundedCents = payment ? (ctx.refunded.get(payment.id) ?? 0) : 0;
  const payable = isAddOnRequestPayable(req, ctx.booking, ctx.legs, today);
  // The same test the repo's cancel applies: a checkout started inside the last 30 minutes holds
  // the request, because a PayHere form cannot be recalled once it is open.
  const heldUntil =
    req.status === 'open' && payment?.status === 'pending' && payment.lastAttemptAt
      ? new Date(payment.lastAttemptAt.getTime() + CHECKOUT_TOKEN_TTL_MS)
      : null;
  return {
    id: req.id,
    seq: req.seq,
    name: `A${req.seq}`,
    status: req.status,
    state: addOnRequestState(req, ctx.booking, ctx.legs, today, refundedCents),
    totalCents: req.totalCents,
    currency: req.currency,
    orderId: addOnOrderId(ctx.booking.reference, req.seq),
    payable,
    payLink: payable && ctx.manageLink ? `${ctx.manageLink}#add-ons` : null,
    inFlightUntil: heldUntil && heldUntil > ctx.now ? heldUntil.toISOString() : null,
    refundedCents,
    createdBy: req.createdBy,
    createdAt: req.createdAt.toISOString(),
    paidAt: iso(req.paidAt),
    cancelledBy: req.cancelledBy,
    cancelledAt: iso(req.cancelledAt),
    cancelReason: req.cancelReason,
    lines: req.lines.map((l) => ({ id: l.id, legId: l.legId, code: l.code, label: l.label, amountCents: l.amountCents })),
  };
}

const manageLinkFor = (deps: AddOnDeps, booking: Booking): string | null =>
  deps.baseUrl && deps.linkSecret ? manageUrl(booking, deps.baseUrl, deps.linkSecret) : null;

/** The last day a request can be paid: the day of the earliest leg it touches. Null when none of
 *  its legs has a date yet (it is then payable until the trip is completed). */
export function addOnPayBy(request: Pick<AddOnRequest, 'lines'>, legs: StoredLeg[]): string | null {
  const days = request.lines
    .map((line) => legs.find((leg) => leg.id === line.legId)?.travelDate)
    .filter((day): day is string => !!day)
    .sort();
  return days[0] ?? null;
}

/** A booking's stored legs, its add-on requests as the ops pane shows them, and (only when a new
 *  request can be created) the add-ons on offer at today's prices. A caller that is already
 *  reading the booking's payments hands that read over, so they are not read twice. */
export async function addOnRequestViews(
  deps: AddOnDeps,
  booking: Booking,
  opts: { now?: Date; payments?: Promise<Payment[]> } = {},
): Promise<AddOnViews> {
  const now = opts.now ?? new Date();
  const facts = bookingFacts(booking);
  // All at once: this runs inside the booking sheet's open. The card is read only for a booking
  // that could ever get a catalogue (a shared seat or a chauffeur trip never does).
  const [legs, requests, payments, refunds, card] = await Promise.all([
    deps.addOns.listLegs(booking.id),
    deps.addOns.listByBooking(booking.id),
    opts.payments ?? deps.payments.findByBookingId(booking.id),
    deps.refunds ? deps.refunds.list(booking.id) : [],
    isPrivateBooking(facts) ? deps.rateCard() : null,
  ]);
  const ctx: ViewContext = {
    booking, legs, payments, refunded: refundedByPayment(refunds), manageLink: manageLinkFor(deps, booking), now,
  };
  const creatable = card !== null && bookingAddOnEligibility(facts, legs) === null;
  return {
    legs,
    addOnRequests: requests.map((req) => viewOf(req, ctx)),
    ...(creatable ? { addOnCatalogue: addOnCatalogue(card.extras) } : {}),
  };
}

/** Ops sends an add-on request: one or more rate-card add-ons, each on one driven leg. The price
 *  and the label of every line come from the live card, never from the caller. */
export async function createAddOnRequest(
  deps: AddOnDeps,
  booking: Booking,
  input: { lines: Array<{ legId: string; code: string }>; notifyCustomer: boolean; createdBy: string; now: Date },
): Promise<CreateAddOnResult> {
  const legs = await deps.addOns.listLegs(booking.id);
  const refusal = bookingAddOnEligibility(bookingFacts(booking), legs);
  if (refusal) return { ok: false, error: refusal };

  // Neither repo checks that a line's leg belongs to this booking, so it is checked here: a leg
  // id from another booking is simply not one of this booking's legs.
  const today = isoToday('Asia/Colombo', input.now);
  const legOf = (legId: string) => legs.find((leg) => leg.id === legId);
  for (const line of input.lines) {
    const legRefusal = legAddOnEligibility(legOf(line.legId), today);
    if (legRefusal) return { ok: false, error: legRefusal };
  }

  const card = await deps.rateCard();
  const catalogue = addOnCatalogue(card.extras);
  const itemOf = (code: string) => catalogue.find((item) => item.code === code);
  if (input.lines.some((line) => !itemOf(line.code))) return { ok: false, error: 'unknown_add_on' };

  // Against add-ons bought with the trip, only where it is unambiguous (§4.3): a booking with
  // exactly one driven leg. Booking-time add-ons carry the add-on's label, with the leg's name
  // after it when the quote tied one to a leg ("Waiting fee — Kandy → Ella").
  if (legs.filter((leg) => leg.kind === 'leg').length === 1) {
    const bought = booking.addOns ?? [];
    const has = (label: string) => bought.some((b) => b === label || b.startsWith(`${label} — `));
    if (input.lines.some((line) => has(itemOf(line.code)!.label))) return { ok: false, error: 'already_bought_at_booking' };
  }

  const [payments, refunds] = await Promise.all([
    deps.payments.findByBookingId(booking.id),
    deps.refunds ? deps.refunds.list(booking.id) : [],
  ]);
  const refunded = refundedByPayment(refunds);
  // A paid add-on whose payment has gone back in full no longer holds its place on the leg.
  const fullyRefundedPaymentIds = payments
    .filter((p) => p.purpose === 'add_on' && p.status === 'succeeded' && (refunded.get(p.id) ?? 0) >= p.amount)
    .map((p) => p.id);

  let created: AddOnRequest;
  try {
    created = await deps.addOns.createRequest({
      bookingId: booking.id,
      lines: input.lines.map((line) => {
        const leg = legOf(line.legId)!;
        return {
          legId: line.legId,
          code: line.code,
          // Short place names, as every customer surface prints them: a full address would swamp
          // the line on the email and the manage page.
          label: addOnLineLabel(line.code, shortPlace(leg.from), shortPlace(leg.to)),
          amountCents: itemOf(line.code)!.priceCents,
        };
      }),
      currency: booking.currency,
      rateCardVersion: card.version,
      createdBy: input.createdBy,
      now: input.now,
      fullyRefundedPaymentIds,
    });
  } catch (err) {
    if (err instanceof AddOnError && err.code === 'duplicate_add_on') return { ok: false, error: 'duplicate_add_on' };
    throw err;
  }

  const request = viewOf(created, { booking, legs, payments, refunded, manageLink: manageLinkFor(deps, booking), now: input.now });
  // Best-effort, like the schedule email: a mail failure must not undo a request ops just sent.
  // `emailed` means DELIVERED; the pane tells the operator to WhatsApp the pay link when it isn't.
  let emailed = false;
  if (input.notifyCustomer && deps.email && request.payLink) {
    try {
      emailed = wasDelivered(await sendAddOnRequest(booking, {
        requestId: created.id,
        totalCents: created.totalCents,
        currency: created.currency,
        lines: created.lines.map((l) => ({ label: l.label, amountCents: l.amountCents, travelDate: legOf(l.legId)?.travelDate ?? null })),
        payBy: addOnPayBy(created, legs),
        payLink: request.payLink,
      }, deps.email));
    } catch (err) {
      console.error(`[ops] add_on_request email failed for ${booking.reference}:`, err);
    }
  }
  return { ok: true, request, emailed };
}

/** Ops cancels a request that has not been paid. A paid one is refunded instead; one whose
 *  payment form the customer opened in the last 30 minutes is held until that window passes. */
export async function cancelAddOnRequest(
  deps: AddOnDeps,
  booking: Booking,
  requestId: string,
  input: { by: string; reason: string; now: Date },
): Promise<CancelAddOnResult> {
  // A request id from another booking is not this booking's request.
  const existing = await deps.addOns.get(requestId);
  if (!existing || existing.bookingId !== booking.id) return { ok: false, error: 'request_not_found' };
  let cancelled: AddOnRequest;
  try {
    cancelled = await deps.addOns.cancel(requestId, {
      by: input.by,
      reason: input.reason,
      now: input.now,
      inFlightAfter: new Date(input.now.getTime() - CHECKOUT_TOKEN_TTL_MS),
    });
  } catch (err) {
    if (err instanceof AddOnError && err.code !== 'booking_not_found' && err.code !== 'duplicate_add_on') {
      return { ok: false, error: err.code };
    }
    throw err;
  }
  // A request that could be cancelled was never paid, so it has no refunds and nothing in flight:
  // its view needs no further reads.
  return {
    ok: true,
    request: viewOf(cancelled, {
      booking, legs: [], payments: [], refunded: new Map(), manageLink: null, now: input.now,
    }),
  };
}
