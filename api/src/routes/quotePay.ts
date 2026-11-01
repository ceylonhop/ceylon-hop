import { Hono } from 'hono';
import { z } from 'zod';
import type { QuoteRepo, SavedQuote } from '../db/quoteRepo';
import type { Booking, BookingRepo, NewBooking } from '../db/bookingRepo';
import type { PaymentRepo } from '../db/paymentRepo';
import { verifyQuotePayToken, signCheckoutToken } from '../lib/bookingToken';
import type { ExperienceInterestRepo } from '../db/experienceInterestRepo';
import type { ExperienceRepo } from '../db/experienceRepo';
import type { PlaceResolutionRepo } from '../db/placeResolutionRepo';
import { cancelSupersededBooking } from '../services/supersededPayLink';
import { linkQuoteInterests } from '../experiences/bookingInterests';
import { offeredForQuote, publicOffered } from '../experiences/offeredForQuote';
import { payPageCopy } from '../quote/payPageCopy';
import { quoteToBooking, QuoteNotBookableError } from '../quote/quoteToBooking';
import { legSelectionOf, payLines } from '../quote/paySelection';
import { soldView, soldViewFor } from '../quote/quoteAlternative';
import { shortenRouteLabel } from '../quote/shortPlace';
import { browserItem } from '../services/analytics/ga4Hits';
import { depositFor } from '../quote/extrasDeposit';
import { balanceDueCents, isBalanceOpen, paidCents } from '../domain/balance';
import { isoToday } from '../domain/dateRules';
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

type PayState = 'balance' | 'pay_on_day' | 'paid' | 'revised' | 'payable' | 'unavailable';

// `billing` is optional so a cached older pay.html keeps working; when present it must carry
// the full address/city/country set (BillingInput), because a half-filled billing object is
// worse at the gateway than none at all.
// `termsAccepted` must be literally true — the customer is agreeing to a cancellation policy
// that, for a chauffeur trip, caps their refund the moment they are inside 10 days. A
// client-side checkbox alone leaves no evidence, which is exactly what a refund dispute asks
// for; the acceptance timestamp is recorded on the booking.
const StartSchema = z.object({
  t: z.string(),
  customer: CustomerInput,
  billing: BillingInput.optional(),
  termsAccepted: z.literal(true),
  // The customer's choice on an eligible link (spec 2026-10-07 §5.2). Missing = full, so an older
  // cached pay.html keeps working. Never an amount: the server recomputes the deposit.
  payment: z.enum(['full', 'deposit']).optional(),
}).strict();

// How many times one pay link's booking may be cancelled and replaced before /start stops minting more.
const MAX_REPLACEMENTS = 20;

// The quote with its one driving leg dated as the booking now is (R13). Only a single transfer:
// that is the only booking ops can re-date today, and a multi-leg quote's legs don't map onto a
// single date. Anything else, or a booking with no date, leaves the quote as it was.
function datedByBooking(quote: SavedQuote, booking: Booking | null): SavedQuote {
  if (booking?.mode !== 'single' || !booking.input.date) return quote;
  const req = (quote.request ?? {}) as { tool?: { legs?: { date?: string; category?: string }[] } };
  const legs = req.tool?.legs;
  const driving = (l: { category?: string }) => (l.category || 'transfer') !== 'stay_day';
  if (!Array.isArray(legs) || legs.filter(driving).length !== 1) return quote;
  const date = booking.input.date;
  return { ...quote, request: { ...req, tool: { ...req.tool, legs: legs.map((l) => (driving(l) ? { ...l, date } : l)) } } as SavedQuote['request'] };
}

const BalanceSchema = z.object({ t: z.string() }).strict();

// A "Request info" tap on the paid confirmation (owner, 2026-10-15). Same limits the quote page's had.
const InterestSchema = z.object({ t: z.string().max(2000), experienceId: z.string().uuid(), interested: z.boolean() }).strict();

const PAY_ON_DAY_STATUSES: ReadonlySet<string> = new Set(['confirmed', 'in_progress', 'completed']);

const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

// The deposit a customer may pay instead of the full amount on this link, in cents; 0 = not
// offered (spec 2026-10-07 §5.2, rev. 2026-10-08). Only a link for the WHOLE trip qualifies — a
// part-of-trip link (a selection, or a frozen soldCents) always pays in full — and only a quote
// the fixed rule makes eligible. ONE helper for /view and /start so the page can never offer
// what the server would refuse, or the reverse. The rule reads the quote's own total, which is
// what a whole-trip link charges.
function depositOffer(quote: SavedQuote): number {
  if (quote.payLinkSelection || quote.soldCents != null) return 0;
  const engine = (quote.request as { engine?: { product?: string } } | null)?.engine;
  const product = engine?.product ?? quote.product;
  if (product !== 'private' && product !== 'chauffeur') return 0;
  return depositFor(product, quote.totalCents);
}

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

/**
 * The founder's negotiation, as two strings for the pay page (owner, 2026-08-10): "show the
 * discount amount … this is just to keep reminding customers they are getting a discount".
 *
 * PRESENTATION ONLY. `totals` still carries the single post-discount figure, and that is the
 * number the gateway is handed — the engine prices WITH the discount applied (#422), so nothing
 * about the charge changes. These two strings only let the page say what the trip was and what
 * came off it, instead of showing a number that has quietly moved with no explanation.
 *
 * FULL LINKS ONLY; the caller gates on that. On a subset link the per-leg lines sum to the
 * subtotal while the discount sits between subtotal and total, so printing one over ticked lines
 * would imply an allocation nobody authorised — the same reasoning that stops a subset link from
 * being minted on a discounted quote at all (#428).
 *
 * Both figures come straight off the STORED result: no recompute, no extra query, and they
 * reconcile exactly (totalBefore − discount === total).
 */
function discountView(quote: SavedQuote): { totalBeforeUsd: string; discountUsd: string } | undefined {
  const stored = (quote.result ?? {}) as { totalBeforeDiscountCents?: number; discountCents?: number };
  const off = stored.discountCents && stored.discountCents > 0 ? stored.discountCents : null;
  if (off == null) return undefined;
  /* DERIVED when the stored result predates the finishing reorder (#422), which renamed
     discountedSubtotalCents → totalBeforeDiscountCents. Requiring the new field is precisely what
     made this breakdown vanish on the customer quote page for a genuinely discounted quote (#424,
     Q-ZKPZY $259 → $229). total + discount is exact under the current order — total IS
     totalBefore − discount — so this is the same arithmetic read the other way, not a fallback. */
  const before = stored.totalBeforeDiscountCents ?? quote.totalCents + off;
  return { totalBeforeUsd: usd(before), discountUsd: usd(off) };
}

// The customer-facing half of a partial link: the ticked lines, and how much of the itinerary
// they cover. HAND-PICKED on purpose — PayLine's kind/index/legIndex are internal, and `result`
// itself carries margin and hot-zone annotations that must never reach the wire (invariant 1).
// Returns null for anything that can't produce lines, so a partial link on an odd quote degrades
// to today's single-total page rather than erroring in front of a paying customer.
function partialView(
  quote: SavedQuote,
  sel: { legIndexes: number[]; extraIndexes: number[] },
): { lines: { label: string; amountCents: number }[]; coverage: { soldLegs: number; totalLegs: number } } | null {
  let all;
  try {
    all = payLines(quote);
  } catch {
    return null;
  }
  const ticked = all.filter((l) =>
    l.kind === 'leg' ? sel.legIndexes.includes(l.index) : sel.extraIndexes.includes(l.index),
  );
  if (!ticked.length) return null;
  return {
    // Short labels (2026-08-06): the stored engine label is a full address pair.
    lines: ticked.map((l) => ({ label: shortenRouteLabel(l.label), amountCents: l.amountCents })),
    coverage: {
      soldLegs: sel.legIndexes.length,
      totalLegs: all.filter((l) => l.kind === 'leg').length,
    },
  };
}

export function quotePayRoutes(deps: {
  quotes: QuoteRepo;
  bookings: BookingRepo;
  payments: PaymentRepo;
  linkSecret: string;
  checkoutNow?: () => number;
  // The staff address list, so a submission cannot record an operator as the customer
  // (spec 2026-08-08 §4.4, as revised). Optional: absent = the guard is simply off.
  opsUsers?: string;
  experienceInterests?: ExperienceInterestRepo;
  // Partner experiences on the paid / balance screens (owner, 2026-10-15). Optional: without them
  // those screens simply carry none.
  experiences?: ExperienceRepo;
  placeResolutions?: PlaceResolutionRepo;
}) {
  // Four live bookings were recorded under the owner's name because a pay link was opened in a
  // staff browser and Chrome autofilled the empty surname and email boxes (spec 2026-08-08).
  //
  // Deliberately NOT a flat ban on staff addresses: the owner books trips for himself, and that
  // submission is truthful. It is refused only when it would CONTRADICT the quote — i.e. the
  // quote was raised against somebody else. A quote whose own contact is that address may be
  // paid from it.
  const opsEmails = new Set(
    (deps.opsUsers ?? '')
      .split(',')
      .map((entry) => entry.split(':')[0].trim().toLowerCase())
      .filter(Boolean),
  );
  function impersonatesStaff(quote: SavedQuote, email: string): boolean {
    const submitted = email.trim().toLowerCase();
    if (!opsEmails.has(submitted)) return false;
    // The quote's own contact is the test: if the quote belongs to this address, it is not
    // impersonation. Compared loosely — the contact field holds a phone OR an email.
    return (quote.customerContact ?? '').trim().toLowerCase() !== submitted;
  }

  const r = new Hono();
  const checkoutNow = deps.checkoutNow ?? (() => Date.now());

  // State precedence per spec §4: balance → pay_on_day → paid → revised → payable → unavailable. Paid is checked
  // FIRST so a customer reopening their link after paying always finds the keepsake — a
  // won quote must never read as a dead end, and a settled booking must never re-offer Pay.
  // `balance` sits before it for the same reason: a customer who paid a deposit reopens the link
  // they hold and must find what they still owe, not a "paid" keepsake (spec 2026-10-07 §5.3).
  async function stateFor(
    quote: SavedQuote | null,
    parsed: { revision: number; seq: number },
  ): Promise<{ state: PayState; paidVia?: { bookingId: string } }> {
    if (!quote) return { state: 'unavailable' };
    if (quote.convertedBookingId) {
      const rows = await deps.payments.findByBookingId(quote.convertedBookingId);
      const booking = await deps.bookings.get(quote.convertedBookingId);
      if (booking && isBalanceOpen(booking, rows)) {
        return { state: 'balance', paidVia: { bookingId: booking.id } };
      }
      const settled = rows.some((p) => p.status === 'succeeded');
      // Pay on the day (owner 2026-10-29/30): booked with no money in. Until ops records the cash
      // this link says what is owed and how — never "Paid", never a card checkout. Only while the
      // trip is going ahead or done: a cancelled / no-show / refunded one is a dead link, not "booked".
      if (booking?.paymentArrangement && !settled) {
        return PAY_ON_DAY_STATUSES.has(booking.status)
          ? { state: 'pay_on_day', paidVia: { bookingId: booking.id } }
          : { state: 'unavailable' };
      }
      if (settled || quote.status === 'won') {
        return { state: 'paid', paidVia: { bookingId: quote.convertedBookingId } };
      }
    } else if (quote.status === 'won') {
      return { state: 'paid' };
    }
    if (quote.revision !== parsed.revision) return { state: 'revised' };
    // A re-pick retires the outstanding link exactly as an edit does — same screen, same reason:
    // the number this link was minted for is no longer the number ops is asking for (spec §6).
    if (quote.payLinkSeq !== parsed.seq) return { state: 'revised' };
    if (quote.status === 'ready' || quote.status === 'sent') return { state: 'payable' };
    return { state: 'unavailable' };
  }

  // Walk a link's chain of bookings: baseKey, then `:after:<dead booking>` for each booking that
  // can no longer be charged, stopping at the first chargeable one (`existing`, else null with the
  // key the walk ended on). The chain is derived from THIS link's own bookings only — never from
  // `convertedBookingId`, which /start moves to every booking it creates (it used to be the
  // fallback, so on a re-minted link the derived key changed on every tap: three taps, three
  // bookings, only the last reachable from the quote). Each cancelled booking adds one link to the
  // chain, so a double tap after a cancellation (the Q-2J358 case) still yields ONE replacement,
  // and a replacement that is itself cancelled is replaced in turn instead of bricking the link.
  const isChargeable = (b: { status: string } | null): boolean => !!b && (b.status === 'draft' || b.status === 'payment_pending');
  async function linkBooking(baseKey: string): Promise<{ key: string; existing: Booking | null } | 'exhausted'> {
    let key = baseKey;
    let existing = await deps.bookings.findByIdempotencyKey(key);
    for (let hops = 0; existing && !isChargeable(existing); hops += 1) {
      // A link ops has cancelled this many times needs a person, not another booking.
      if (hops >= MAX_REPLACEMENTS) return 'exhausted';
      key = `${baseKey}:after:${existing.id}`;
      existing = await deps.bookings.findByIdempotencyKey(key);
    }
    return { key, existing };
  }

  // Partner experiences near the trip AS SOLD, for a customer who has paid (owner, 2026-10-15): on
  // the `paid` keepsake and the `balance` "you're booked" screen, never before payment. `interested`
  // reads the BOOKING's interests — a tick the quote carried in arrives there at /start. A courtesy:
  // whatever goes wrong costs the customer nothing but the section (spec D17).
  async function experiencesFor(sold: SavedQuote, bookingId: string | undefined): Promise<unknown[]> {
    if (!bookingId || !deps.experienceInterests) return [];
    try {
      const matched = await offeredForQuote(sold.request, deps);
      if (!matched.length) return [];
      const ticked = new Set((await deps.experienceInterests.listForBooking(bookingId)).map((i) => i.experienceId));
      return publicOffered(matched, ticked);
    } catch (err) {
      console.error(`[experiences] pay-view could not list experiences for booking ${bookingId}:`, err);
      return [];
    }
  }

  r.get('/view', async (c) => {
    const parsed = verifyQuotePayToken(c.req.query('t'), deps.linkSecret);
    if (!parsed) return c.json({ state: 'unavailable' as const }, 200); // soft — no detail leak
    const quote = await deps.quotes.get(parsed.quoteId);
    const { state, paidVia } = await stateFor(quote, parsed);

    // Once a booking exists, "as sold" follows the BOOKING (soldViewFor), not the quote's current
    // selection: the agent may have switched the link after this customer's booking was created.
    if (state === 'balance' && quote && paidVia) {
      const booking = await deps.bookings.get(paidVia.bookingId);
      const sold = soldViewFor(quote, booking);
      const rows = await deps.payments.findByBookingId(paidVia.bookingId);
      const deposit = rows.find((p) => p.purpose === 'deposit' && p.status === 'succeeded');
      const settledAt = deposit ? (await deps.payments.provenanceFor(deposit.id))?.settledAt ?? null : null;
      const balance = booking ? balanceDueCents(booking, rows) : 0;
      const copy = payPageCopy(sold, legSelectionOf(sold.payLinkSelection));
      return c.json({
        state,
        balance: {
          title: copy.title,
          // The screen a deposit payer lands on is "you're booked", not an invoice (owner,
          // 2026-10-12): it shows the trip, the reference and a name, and words the balance by
          // product — so it gets the same copy the payable page had, plus what the keepsake gets.
          reference: booking?.reference ?? null,
          firstName: prefillFor(quote).firstName || null,
          copy,
          totalUsd: usd(booking?.total ?? sold.totalCents),
          paidUsd: usd(paidCents(rows)),
          // The deposit's settled day (Asia/Colombo), or null when the ledger has no timestamp.
          paidOn: settledAt ? isoToday('Asia/Colombo', settledAt) : null,
          balanceCents: balance,
          balanceUsd: usd(balance),
        },
        experiences: await experiencesFor(sold, paidVia.bookingId),
      });
    }

    if (state === 'pay_on_day' && quote && paidVia) {
      const booking = await deps.bookings.get(paidVia.bookingId);
      const rows = await deps.payments.findByBookingId(paidVia.bookingId);
      const sold = soldViewFor(quote, booking);
      return c.json({
        state,
        payOnDay: {
          reference: booking?.reference ?? null,
          firstName: prefillFor(quote).firstName || null,
          // From the ledger: total − succeeded payments (balance.ts), the cash still to hand over.
          amountUsd: usd(booking ? balanceDueCents(booking, rows) : sold.totalCents),
          title: payPageCopy(sold, legSelectionOf(sold.payLinkSelection)).title,
        },
      });
    }

    if (state === 'paid' && quote) {
      const booking = paidVia ? await deps.bookings.get(paidVia.bookingId) : null;
      const paidRows = paidVia ? await deps.payments.findByBookingId(paidVia.bookingId) : [];
      const payment = paidRows.find((p) => p.status === 'succeeded');
      // A deposit + balance pair is ONE sale: the keepsake states what the whole trip cost, not
      // the first payment's $50. Any other history keeps today's first-succeeded reading.
      const paidTotal = paidRows.some((p) => p.purpose === 'balance' && p.status === 'succeeded')
        ? paidCents(paidRows)
        : payment?.amount;
      const sold = soldViewFor(quote, booking);
      const paidCopy = payPageCopy(sold, legSelectionOf(sold.payLinkSelection));
      return c.json({
        state,
        paid: {
          reference: booking?.reference ?? null,
          firstName: prefillFor(quote).firstName || null,
          amountUsd: paidTotal != null ? usd(paidTotal) : usd(booking?.total ?? sold.totalCents),
          // Selection-aware here too: a keepsake for a two-leg payment must not be headed
          // "Four journeys" either.
          title: paidCopy.title,
          // The add-ons it bought, on the keepsake pass too. Absent when there are none.
          ...(paidCopy.addOns ? { addOns: paidCopy.addOns } : {}),
        },
        experiences: await experiencesFor(sold, paidVia?.bookingId),
      });
    }
    if (state !== 'payable' || !quote) return c.json({ state });

    // The quote AS SOLD on this (not yet booked) link: for a link sold as the chauffeur option of a
    // "both" quote this is the frozen chauffeur quote, so everything below prices, words and
    // offers a deposit on that product. null (the selection has nothing valid behind it) reads like
    // an unknown quote — fail closed.
    const live = soldView(quote);
    if (!live) return c.json({ state: 'unavailable' as const });
    // A customer who has already started paying has a booking, and ops may have re-dated it
    // (requirements 2026-10-26 R13). Same key /start resumes under, so it is the same booking.
    const walk = await linkBooking(`pay:quote:${live.id}:r${parsed.revision}:s${parsed.seq}`);
    const started = walk === 'exhausted' ? null : walk.existing;

    // A partial link charges the frozen soldCents, not the quote total (spec §4).
    const soldCents = live.soldCents ?? live.totalCents;
    const sel = legSelectionOf(live.payLinkSelection);
    const partial = sel ? partialView(live, sel) : null;
    const dep = depositOffer(live);

    return c.json({
      state,
      // The copy must know about the selection, or the page describes the whole trip while the
      // receipt below it describes two legs (owner-caught in prod, 2026-08-05).
      copy: payPageCopy(datedByBooking(live, started), sel),
      totals: { cents: soldCents, usd: usd(soldCents) },
      // Full links only — see discountView. `sel` is the whole test: a subset link always has one.
      ...(sel ? {} : { discount: discountView(live) }),
      prefill: prefillFor(live),
      ...(partial ?? {}),
      // Present only when the customer may choose (a whole-trip link on an eligible quote); the
      // page is exactly today's page without it. `totals` stays the trip total.
      ...(dep > 0 ? { deposit: { cents: dep, usd: usd(dep), balanceCents: soldCents - dep, balanceUsd: usd(soldCents - dep) } } : {}),
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
    const stored = await deps.quotes.get(parsed.quoteId);
    const { state } = await stateFor(stored, parsed);
    if (state === 'paid' || state === 'balance' || state === 'pay_on_day') return c.json({ error: 'already_paid' }, 409);
    if (state === 'revised') return c.json({ error: 'quote_revised' }, 409);
    if (state !== 'payable' || !stored) return c.json({ error: 'quote_unavailable' }, 409);
    // The quote AS SOLD on this link — see /view. null (nothing valid behind the selection) is the
    // same refusal an unknown quote gets.
    const quote = soldView(stored);
    if (!quote) return c.json({ error: 'quote_unavailable' }, 409);

    // The customer's choice. A deposit is refused unless the /view rule offered it — the server
    // recomputes it and never trusts the client for either the option or the amount.
    const soldCents = quote.soldCents ?? quote.totalCents;
    const wantsDeposit = body.data.payment === 'deposit';
    const deposit = wantsDeposit ? depositOffer(quote) : 0;
    if (wantsDeposit && deposit <= 0) return c.json({ error: 'deposit_ineligible' }, 409);
    const dueNow = wantsDeposit ? deposit : soldCents;

    // Resume an earlier tap: the booking already exists, hand back a fresh checkout token.
    //
    // ONLY if it can still be charged. Resuming unconditionally BRICKED THE QUOTE (owner-hit,
    // 2026-08-02): ops cancelled a booking, /start kept handing the cancelled row back, and
    // /bookings/:id/checkout correctly refused it — 409 not_chargeable — so the PayHere window
    // never opened and the customer just saw "we couldn't start your payment". Permanently:
    // the lookup consults convertedBookingId BEFORE the revision-scoped key, so even a new
    // quote revision returned the same dead booking. That quote could never be paid again.
    //
    // A cancelled booking is an ABANDONED ATTEMPT, not a closed door: the quote is still
    // ready/sent, which is the business's own statement that it is payable. The lever for
    // "stop taking money" is moving the quote out of those statuses, which already renders the
    // sailed-off screen. So a dead prior is ignored and a fresh booking is minted.
    if (impersonatesStaff(quote, body.data.customer.email)) {
      return c.json({ error: 'staff_email_not_customer' }, 400);
    }

    // Seq-scoped since partial links (spec §9): the key carries the revision AND the selection
    // seq, so a lookup can only ever return a booking minted for THIS selection.
    //
    // Resumability is decided by the key lookup ALONE — deliberately not by convertedBookingId,
    // which is selection-blind. Consulting it first is exactly what would hand back the previous
    // selection's booking, at the previous selection's amount, to a customer holding a link for
    // a different set of legs. (`Booking` does not expose its own idempotency key, so comparing
    // after the fact is not an option either.)
    const baseKey = `pay:quote:${quote.id}:r${parsed.revision}:s${parsed.seq}`;
    // ONE path for "an existing booking that can still be charged": the one under this selection's
    // base key, or — after a cancellation — its replacement under the `:after:` key. Both must
    // re-record the payer AND the deposit-or-full choice; handing the replacement back untouched
    // charged the first tap's amount on a page that showed the second (review of #958).
    const payer = { customer: body.data.customer, billing: body.data.billing };
    async function resume(existing: { id: string }) {
      // Re-record the payer before handing back the booking. Everything the gateway sees — name,
      // email, phone, billing address — is read from this row, never from the request that opened
      // the payment, so resuming used to charge against whatever was typed on the FIRST attempt
      // and silently discard the corrections. A payer who mistyped their address, was declined,
      // and fixed it was re-sent the bad address; and because those fields feed the issuer's 3DS
      // risk decision, the retry was arguably worse off than the original attempt.
      const refreshed = await deps.bookings.refreshPayerDetails(existing.id, {
        ...payer,
        // /start requires termsAccepted:true on every call, so the resuming payer has just
        // agreed. Keeping the earlier submitter's timestamp would leave a refund dispute
        // holding evidence about a different person.
        termsAcceptedAt: new Date(),
        // The choice may differ from the first tap; the repo applies it only while nothing on the
        // booking has succeeded (spec 2026-10-07 §4).
        amountDueNow: dueNow,
      });
      return c.json(
        { bookingId: refreshed.id, checkoutToken: signCheckoutToken(refreshed.id, deps.linkSecret, checkoutNow()), ga4Item: browserItem(refreshed) },
        200,
      );
    }
    // Resume the link's chargeable booking; otherwise create under the key the walk ended on.
    const walk = await linkBooking(baseKey);
    if (walk === 'exhausted') return c.json({ error: 'quote_unavailable' }, 409);
    if (walk.existing) return resume(walk.existing);
    const idempotencyKey = walk.key;

    // Map the quote + the customer's details into a bookable input — the same translation
    // the ops "Mark booked" modal drives, with the modal's fields derived from the quote.
    // The booking must carry ONLY the legs that were sold — otherwise the driver's itinerary and
    // the confirmation email promise legs nobody paid for (spec §8).
    const legIndexes = legSelectionOf(quote.payLinkSelection)?.legIndexes;
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
      }, legIndexes ? { legIndexes } : undefined);
    } catch (e) {
      if (e instanceof QuoteNotBookableError) return c.json({ error: 'quote_unavailable' }, 409);
      throw e;
    }

    const newBooking: NewBooking =
      mapped.mode === 'single'
        ? { mode: 'single', input: mapped.input, total: soldCents, amountDueNow: dueNow,
            currency: quote.currency, distanceKm: mapped.distanceKm, durationMin: null, channel: 'whatsapp', billing: body.data.billing, termsAcceptedAt: new Date() }
        : { mode: 'trip', input: mapped.input, total: soldCents, amountDueNow: dueNow,
            currency: quote.currency, distanceKm: mapped.distanceKm, durationMin: null, channel: 'whatsapp', billing: body.data.billing, termsAcceptedAt: new Date() };

    const created = await deps.bookings.create(newBooking, { idempotencyKey });
    let booking = created;
    if (created.status === 'draft') {
      try {
        booking = await deps.bookings.setStatus(created.id, 'payment_pending', undefined, {
          source: 'quote_conversion',
          actorType: 'customer',
          actorId: body.data.customer.email,
          requestId: c.get('requestId'),
          relatedEntityType: 'quote',
          relatedEntityId: quote.id,
        });
      } catch {
        booking = (await deps.bookings.get(created.id)) ?? created;
      }
    }
    // Link the quote to its booking — STATUS DELIBERATELY UNTOUCHED. Awaiting payment is
    // not business won; settlement (webhook/mark-paid → claimWonQuote) does the flip.
    // The booking the quote pointed at BEFORE this tap belongs to an older, now-retired link (the
    // chain walk above only reaches this line when THIS link had no chargeable booking). Close it so it
    // stops reading as a live "awaiting payment" booking. Best-effort: never fails the customer's pay.
    const supersededId = stored.convertedBookingId;
    if (supersededId && supersededId !== booking.id) {
      try {
        await cancelSupersededBooking(supersededId, { bookings: deps.bookings, payments: deps.payments, quoteId: quote.id, requestId: c.get('requestId') });
      } catch (err) {
        console.error(`superseded booking ${supersededId} could not be cancelled for quote ${quote.id}:`, err);
      }
    }
    await deps.quotes.patch(quote.id, { convertedBookingId: booking.id });
    await linkQuoteInterests(deps.experienceInterests, quote.id, booking.id);

    return c.json(
      // ga4Item: pay.html stashes it across the gateway round trip for its `purchase` (ga4Hits.ts).
      { bookingId: booking.id, checkoutToken: signCheckoutToken(booking.id, deps.linkSecret, checkoutNow()), ga4Item: browserItem(booking) },
      201,
    );
  });

  // The balance of a deposit booking, on the link the customer already holds (spec §5.3). Same
  // token as /start, no terms re-acceptance (accepted at the deposit). Only the `balance` state
  // proceeds; the amount is never read from the client — checkout charges balanceDueCents.
  r.post('/balance', async (c) => {
    const body = BalanceSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const parsed = verifyQuotePayToken(body.data.t, deps.linkSecret);
    if (!parsed) return c.json({ error: 'quote_unavailable' }, 409);
    // No soldView here: the balance belongs to the booking that took the deposit, so a selection
    // that stopped validating (or was switched) afterwards must not strand a customer who has paid.
    const quote = await deps.quotes.get(parsed.quoteId);
    const { state, paidVia } = await stateFor(quote, parsed);
    if (state !== 'balance' || !paidVia) return c.json({ error: 'no_balance_due' }, 409);
    return c.json(
      { bookingId: paidVia.bookingId, checkoutToken: signCheckoutToken(paidVia.bookingId, deps.linkSecret, checkoutNow()) },
      200,
    );
  });

  // "Request info" on the paid confirmation (owner, 2026-10-15, option B). Recorded on the BOOKING
  // with source 'pay_page', so — the booking being paid — it is an ops lead at once (Experiences →
  // Leads, and the booking pane's "Interested in"). It records a lead and nothing else: no money, no
  // change to the booking. Only a link in the paid / balance state may write, and only for an
  // experience this trip is actually offered (the same computation /view lists from).
  r.post('/interest', async (c) => {
    const body = InterestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const parsed = verifyQuotePayToken(body.data.t, deps.linkSecret);
    if (!parsed || !deps.experienceInterests) return c.json({ error: 'quote_unavailable' }, 409);
    const quote = await deps.quotes.get(parsed.quoteId);
    const { state, paidVia } = await stateFor(quote, parsed);
    if (!quote || state === 'unavailable') return c.json({ error: 'quote_unavailable' }, 409);
    if ((state !== 'paid' && state !== 'balance') || !paidVia) return c.json({ error: 'not_paid' }, 409);
    const bookingId = paidVia.bookingId;

    const sold = soldViewFor(quote, await deps.bookings.get(bookingId));
    const offered = (await offeredForQuote(sold.request, deps)).flatMap((s) => s.items)
      .find((m) => m.experience.id === body.data.experienceId);
    if (!offered) return c.json({ error: 'not_offered' }, 422);

    if (body.data.interested) {
      await deps.experienceInterests.record({ experience: offered.experience, source: 'pay_page', bookingId });
      return c.json({ interested: true });
    }
    // Withdraw only while ops has not touched it; otherwise report what is really stored.
    await deps.experienceInterests.withdrawFromBooking(offered.experience.id, bookingId);
    const stillThere = (await deps.experienceInterests.listForBooking(bookingId)).some((i) => i.experienceId === offered.experience.id);
    return c.json({ interested: stillThere });
  });

  return r;
}
