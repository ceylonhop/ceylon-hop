# Deferred — amounts on manual settlement (mark-paid)

**Status: parked by the owner, 2026-07-30.** Raised during the end-to-end ops review; the owner
wants to do more work in this area, so nothing here was built. This file exists so the analysis
isn't re-done from scratch.

## What is true today

`POST /admin/bookings/:id/mark-paid` takes a `method` and an optional `reference`, and nothing
else. The amount is not a parameter:

```ts
amount: booking.amountDueNow ?? booking.total   // api/src/routes/admin.ts
```

So ops records exactly what the booking says is owed, in one shot. Sending `amountCents` is a
400 (`invalid_mark_paid_request` — the schema is `.strict()`).

That is currently harmless because the engine sets `amountDueNowCents = totalCents`
(`api/src/quote/engine.ts`), i.e. every booking is due in full. The rate card *does* compute a
deposit (`deposit: { pct: 10, capCents: 5000 }`) — it just isn't what anyone is charged yet.

## Why it will matter

1. **A deposit taken in cash cannot be recorded.** Ops either marks the whole thing paid (money
   in the ledger that isn't in the bank) or leaves the booking awaiting payment.
2. **Captured total is the refund ceiling.** `refundRepo` sums succeeded payments and refuses
   `refund_exceeds_captured`. Overstating capture authorises refunding money never received.
3. **No positive guard.** A $0 booking would 200 in memory and 23514 against
   `payments_amount_positive` in Postgres (already logged in `known-bugs.md`, 2026-07-30). The
   in-memory repo enforces no CHECK, so no test can currently see it.

## Shape a fix would probably take

- Optional `amountCents` on the request, validated `> 0` and `≤ (amountDueNow − already captured)`.
- Booking only advances to `paid` once cumulative captured ≥ amount due; a part payment leaves it
  in `payment_pending` with the balance visible in the drawer.
- The idempotency key can no longer be `manual-paid:${booking.id}` — two legitimate part payments
  on one booking would collide. Needs a per-payment key.
- The drawer needs an amount field, and the refund panel's "Refundable remaining" already reads
  from captured, so it follows for free.

## Related

- `docs/known-bugs.md` — the `$0` mark-paid row.
- `api/src/domain/paymentMethod.ts` — the channel list the route, the watchdog and the
  `payments_provider_supported` CHECK all have to agree on.
