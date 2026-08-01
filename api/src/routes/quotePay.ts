import { Hono } from 'hono';
import { z } from 'zod';
import type { QuoteRepo, SavedQuote } from '../db/quoteRepo';
import type { BookingRepo, NewBooking } from '../db/bookingRepo';
import type { PaymentRepo } from '../db/paymentRepo';
import { verifyQuotePayToken, signCheckoutToken } from '../lib/bookingToken';
import { payPageCopy } from '../quote/payPageCopy';
import { quoteToBooking, QuoteNotBookableError } from '../quote/quoteToBooking';
import { CustomerInput, BillingInput } from '../domain/singleTransfer';

// The customer half of quote pay links (spec 2026-07-31 §3). Public, bearer-token routes:
// whoever holds the link may view and pay the quote — intended, and identical to the
// existing manage-link semantics. Two invariants dominate this file:
//
//   1. MARGIN NEVER REACHES THE WIRE. The stored quote carries marginCents, the locked
//      rate card (cost + markup), and hot-zone annotations. /view therefore builds a
//      hand-picked projection — it never echoes `result`, `request`, or `rateCardJson`.
//
//   2. THE WRONG AMOUNT CAN NEVER BE PAID. The token pins the revision it was minted
//      for; a revised quote renders the 'revised' state and /start refuses. The booking
//      is priced at the quote's FROZEN total, never re-priced.
//
// The booking is created here, at pay-commit — not at mint (a link is stateless), and
// not on the webhook (payments.booking_id is NOT NULL, so settlement needs a booking to
// land on). Idempotent per quote+revision, so a double tap resumes rather than duplicates.

type PayState = 'paid' | 'revised' | 'payable' | 'unavailable';

// `billing` is optional so a cached older pay.html keeps working; when present it must carry
// the full address/city/country set (BillingInput), because a half-filled billing object is
// worse at the gateway than none at all.
const StartSchema = z.object({ t: z.string(), customer: CustomerInput, billing: BillingInput.optional() }).strict();

const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

// Best-effort prefill from what the quote already knows — the page asks only for the rest.
function prefillFor(quote: SavedQuote): { firstName: string; lastName: string; email: string; whatsapp: string; country: string } {
  const parts = (quote.customerName ?? '').trim().split(/\s+/).filter(Boolean);
  const contact = (quote.customerContact ?? '').trim();
  const isEmail = /@/.test(contact);
  return {
    firstName: parts[0] ?? '',
    lastName: parts.slice(1).join(' '),
    email: isEmail ? contact : '',
    whatsapp: isEmail ? '' : contact,
    country: '',
  };
}

export function quotePayRoutes(deps: {
  quotes: QuoteRepo;
  bookings: BookingRepo;
  payments: PaymentRepo;
  linkSecret: string;
  checkoutNow?: () => number;
}) {
  const r = new Hono();
  const checkoutNow = deps.checkoutNow ?? (() => Date.now());

  // State precedence per spec §4: paid → revised → payable → unavailable. Paid is checked
  // FIRST so a customer reopening their link after paying always finds the keepsake — a
  // won quote must never read as a dead end, and a settled booking must never re-offer Pay.
  async function stateFor(
    quote: SavedQuote | null,
    revision: number,
  ): Promise<{ state: PayState; paidVia?: { bookingId: string } }> {
    if (!quote) return { state: 'unavailable' };
    if (quote.convertedBookingId) {
      const settled = (await deps.payments.findByBookingId(quote.convertedBookingId)).some(
        (p) => p.status === 'succeeded',
      );
      if (settled || quote.status === 'won') {
        return { state: 'paid', paidVia: { bookingId: quote.convertedBookingId } };
      }
    } else if (quote.status === 'won') {
      return { state: 'paid' };
    }
    if (quote.revision !== revision) return { state: 'revised' };
    if (quote.status === 'ready' || quote.status === 'sent') return { state: 'payable' };
    return { state: 'unavailable' };
  }

  r.get('/view', async (c) => {
    const parsed = verifyQuotePayToken(c.req.query('t'), deps.linkSecret);
    if (!parsed) return c.json({ state: 'unavailable' as const }, 200); // soft — no detail leak
    const quote = await deps.quotes.get(parsed.quoteId);
    const { state, paidVia } = await stateFor(quote, parsed.revision);

    if (state === 'paid' && quote) {
      const booking = paidVia ? await deps.bookings.get(paidVia.bookingId) : null;
      const payment = paidVia
        ? (await deps.payments.findByBookingId(paidVia.bookingId)).find((p) => p.status === 'succeeded')
        : undefined;
      return c.json({
        state,
        paid: {
          reference: booking?.reference ?? null,
          firstName: prefillFor(quote).firstName || null,
          amountUsd: payment ? usd(payment.amount) : usd(quote.totalCents),
          title: payPageCopy(quote).title,
        },
      });
    }
    if (state !== 'payable' || !quote) return c.json({ state });

    return c.json({
      state,
      copy: payPageCopy(quote),
      totals: { cents: quote.totalCents, usd: usd(quote.totalCents) },
      prefill: prefillFor(quote),
    });
  });

  r.post('/start', async (c) => {
    const body = StartSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      // Name the failing box, the way /admin/quote/:id/book does — a customer staring at
      // a two-field form deserves better than "bad request".
      const message = body.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
      return c.json({ error: 'bad_request', message }, 400);
    }
    const parsed = verifyQuotePayToken(body.data.t, deps.linkSecret);
    if (!parsed) return c.json({ error: 'quote_unavailable' }, 409);
    const quote = await deps.quotes.get(parsed.quoteId);
    const { state } = await stateFor(quote, parsed.revision);
    if (state === 'paid') return c.json({ error: 'already_paid' }, 409);
    if (state === 'revised') return c.json({ error: 'quote_revised' }, 409);
    if (state !== 'payable' || !quote) return c.json({ error: 'quote_unavailable' }, 409);

    // Resume an earlier tap: the booking already exists, hand back a fresh checkout token.
    const idempotencyKey = `pay:quote:${quote.id}:r${parsed.revision}`;
    const prior = quote.convertedBookingId
      ? await deps.bookings.get(quote.convertedBookingId)
      : await deps.bookings.findByIdempotencyKey(idempotencyKey);
    if (prior) {
      return c.json(
        { bookingId: prior.id, checkoutToken: signCheckoutToken(prior.id, deps.linkSecret, checkoutNow()) },
        200,
      );
    }

    // Map the quote + the customer's details into a bookable input — the same translation
    // the ops "Mark booked" modal drives, with the modal's fields derived from the quote.
    const tool = (quote.request as { tool?: { passengerCount?: number; luggageCount?: number; legs?: { date?: string }[] } } | null)?.tool;
    const firstDate = (tool?.legs ?? []).map((l) => l.date).find((d) => !!d);
    let mapped;
    try {
      mapped = quoteToBooking(quote, {
        customer: body.data.customer,
        vehicleType: quote.vehicle && quote.vehicle.startsWith('van') ? 'van' : 'car',
        pax: typeof tool?.passengerCount === 'number' ? tool.passengerCount : 2,
        bags: typeof tool?.luggageCount === 'number' ? tool.luggageCount : 0,
        date: firstDate,
        time: undefined,
      });
    } catch (e) {
      if (e instanceof QuoteNotBookableError) return c.json({ error: 'quote_unavailable' }, 409);
      throw e;
    }

    const newBooking: NewBooking =
      mapped.mode === 'single'
        ? { mode: 'single', input: mapped.input, total: quote.totalCents, amountDueNow: quote.totalCents,
            currency: quote.currency, distanceKm: mapped.distanceKm, durationMin: null, channel: 'whatsapp', billing: body.data.billing }
        : { mode: 'trip', input: mapped.input, total: quote.totalCents, amountDueNow: quote.totalCents,
            currency: quote.currency, distanceKm: mapped.distanceKm, durationMin: null, channel: 'whatsapp', billing: body.data.billing };

    const created = await deps.bookings.create(newBooking, { idempotencyKey });
    let booking = created;
    if (created.status === 'draft') {
      try {
        booking = await deps.bookings.setStatus(created.id, 'payment_pending');
      } catch {
        booking = (await deps.bookings.get(created.id)) ?? created;
      }
    }
    // Link the quote to its booking — STATUS DELIBERATELY UNTOUCHED. Awaiting payment is
    // not business won; settlement (webhook/mark-paid → claimWonQuote) does the flip.
    await deps.quotes.patch(quote.id, { convertedBookingId: booking.id });

    return c.json(
      { bookingId: booking.id, checkoutToken: signCheckoutToken(booking.id, deps.linkSecret, checkoutNow()) },
      201,
    );
  });

  return r;
}
