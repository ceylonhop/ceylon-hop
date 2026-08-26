import type { RideListRepo } from '../db/rideListRepo';
import type { TokenizedPaymentAdapter } from '../adapters/tokenizedPayments';
import type { EmailAdapter } from '../adapters/email';
import { committedSeats, popularTime, type Slot, type RideMember } from '../domain/rideList';
import { sendRideConfirmed, sendRideCancelled, sendRideAtRisk, sendRideCalledOffRefundDue } from './rideBoardEmails';
import type { AlertAdapter } from '../adapters/alerts';
import { logEvent } from '../observability/events';
import type { SendBudget } from './sendBudget';

// ============================================================================
// Ride Board cutoff sweep — the pooled equivalent of sweepStaleSharedHolds.
// Pure over (now, deps); driven by the external-cron POST /admin/jobs tick.
// For each gathering list past its cutoff:
//   • enough names  → pin the popular departure time, charge every held card,
//     confirm, email everyone (at-risk email to any card that declined);
//   • not enough    → the ride is called off; nobody charged, everyone emailed.
// A confirmed/expired list no longer matches dueForCutoff, so it's naturally
// idempotent (no notification_log needed).
// ============================================================================

export interface RideBoardCutoffDeps {
  rideLists: RideListRepo;
  paygw: TokenizedPaymentAdapter;
  email: EmailAdapter;
  // Optional: without it a call-off that already charged cards is silent apart from a log
  // line, which is how money gets owed back and nobody finds out.
  alerts?: AlertAdapter;
  currency?: string;
  // Blast-radius cap (R1) — here it guards MONEY as well as mail, since this sweep charges
  // cards. A list is all-or-nothing: rather than charge half a van and stop at the cap, the
  // sweep declines to start a list it cannot finish. The list stays gathering, so it is
  // still due next run and gets processed whole.
  budget?: SendBudget;
}

export interface RideBoardCutoffResult {
  processed: number;
  confirmed: number;
  expired: number;
  charged: number;
  chargeFailed: number;
  // Charges that were sent and whose outcome we never learned. Counted apart from `charged`
  // because these are the ones a human still has to reconcile against the PayHere dashboard.
  chargeUnknown: number;
}

const liveSeats = (members: RideMember[]) => committedSeats(members);

export async function runRideBoardCutoff(now: Date, deps: RideBoardCutoffDeps): Promise<RideBoardCutoffResult> {
  const currency = deps.currency ?? 'USD';
  const due = await deps.rideLists.dueForCutoff(now);
  const res: RideBoardCutoffResult = {
    processed: 0, confirmed: 0, expired: 0, charged: 0, chargeFailed: 0, chargeUnknown: 0,
  };

  for (const { list, members } of due) {
    const held = members.filter((m) => m.status === 'held' || m.status === 'charged');

    // Every branch below emails each held traveller exactly once, so held.length is the
    // true cost of this list. Claim it up front — all-or-nothing (see RideBoardCutoffDeps).
    if (deps.budget && !deps.budget.tryClaim(held.length)) {
      deps.budget.suppress('ride_board', list.code, held.length);
      continue;
    }
    res.processed++;

    // Not enough names by the cutoff → call the ride off; nobody is charged, everyone emailed.
    if (liveSeats(held) < list.minSeats) {
      await deps.rideLists.setStatus(list.id, 'expired');
      res.expired++;
      logEvent('ride_board.called_off', {
        code: list.code, corridorId: list.corridorId, date: list.date,
        reason: 'below_threshold', committed: liveSeats(held), minSeats: list.minSeats,
        travellers: held.length,
      });
      for (const m of held) await sendRideCancelled(deps.email, { to: m.email, firstName: m.firstName, list });
      continue;
    }

    // Enough names → pin the group's popular departure time, then charge each held card.
    const time = popularTime(held.map((m) => m.preferredTime), list.slot as Slot);
    await deps.rideLists.lockDeparture(list.id, time);

    const chargedOk: RideMember[] = [];
    const failed: RideMember[] = [];
    // Sent, reply lost — the card may or may not have been debited. Held apart only so a human
    // can be told; for every decision below these count as charged (see the alert further down).
    const indeterminate: { member: RideMember; orderId: string; reason?: string }[] = [];
    for (const m of held) {
      if (m.status === 'charged') {
        chargedOk.push(m);
        continue;
      }
      const orderId = `${list.code}-${m.sub}`;
      const charge = await deps.paygw.charge({
        ref: m.preapprovalRef ?? '',
        amountCents: list.seatPrice * m.seats,
        currency,
        orderId,
      });
      if (charge.status === 'succeeded') {
        await deps.rideLists.setMemberStatus(list.id, m.sub, 'charged');
        res.charged++;
        chargedOk.push(m);
      } else if (charge.status === 'unknown') {
        // Optimistic, deliberately. Being wrong this way carries one possibly-unpaid seat on a
        // van that runs — bounded, alerted, chaseable. Being wrong the other way cancels a
        // probably-paid-for van and tells a debited traveller they weren't charged. Marking
        // them 'charged' also keeps a later sweep from charging the same card twice, since
        // this API has no idempotency key.
        await deps.rideLists.setMemberStatus(list.id, m.sub, 'charged');
        res.chargeUnknown++;
        chargedOk.push(m);
        indeterminate.push({ member: m, orderId, reason: charge.failureReason });
      } else {
        await deps.rideLists.setMemberStatus(list.id, m.sub, 'charge_failed');
        res.chargeFailed++;
        failed.push(m);
      }
    }

    const ranThisList = chargedOk.reduce((n, m) => n + m.seats, 0) >= list.minSeats;
    if (ranThisList) {
      // Confirmed with the successfully-charged travellers.
      await deps.rideLists.setStatus(list.id, 'confirmed');
      res.confirmed++;
      logEvent('ride_board.confirmed', {
        code: list.code, corridorId: list.corridorId, date: list.date, lockedTime: time,
        seats: chargedOk.reduce((n, m) => n + m.seats, 0), minSeats: list.minSeats,
        capacity: list.capacity, chargeFailures: failed.length,
        revenueCents: chargedOk.reduce((n, m) => n + m.seats, 0) * list.seatPrice,
        // Part of revenueCents above is money we only PROBABLY hold — an indeterminate charge
        // counts toward the van running, so the revenue figure means little without this.
        chargeUnknown: indeterminate.length,
      });
      for (const m of chargedOk) await sendRideConfirmed(deps.email, { to: m.email, firstName: m.firstName, list, lockedTime: time });
      for (const m of failed) await sendRideAtRisk(deps.email, { to: m.email, firstName: m.firstName, list });
    } else {
      // Rare: enough held, but charge failures dropped it below the threshold → call it off.
      // Any card in chargedOk is real money taken for a van that will not run. Refunding is
      // still manual (ops can refund through PayHere from the booking sheet), so the job here
      // is to make sure a human is TOLD and the traveller is not misinformed.
      await deps.rideLists.setStatus(list.id, 'expired');
      res.expired++;
      logEvent('ride_board.called_off', {
        code: list.code, corridorId: list.corridorId, date: list.date,
        reason: 'charge_failures', chargeFailures: failed.length,
        chargedSeats: chargedOk.reduce((n, m) => n + m.seats, 0), minSeats: list.minSeats,
        // these cards are charged with the van cancelled — the manual-refund case. Includes
        // the indeterminate ones: a card that MIGHT have been debited still needs a human.
        needsRefund: chargedOk.length,
        chargeUnknown: indeterminate.length,
      });
      // Two different emails, because these travellers are in two different situations.
      // sendRideCancelled says "you weren't charged" — true for everyone whose card declined
      // or was never charged, and a false statement to anyone in chargedOk.
      const chargedSubs = new Set(chargedOk.map((m) => m.sub));
      for (const m of held) {
        if (chargedSubs.has(m.sub)) {
          await sendRideCalledOffRefundDue(deps.email, { to: m.email, firstName: m.firstName, list });
        } else {
          await sendRideCancelled(deps.email, { to: m.email, firstName: m.firstName, list });
        }
      }
      // Best-effort and last: a failure here must not cost the travellers their emails.
      // Not 'info' — money is owed back to a customer until someone acts on this.
      if (chargedOk.length > 0 && deps.alerts) {
        const owed = chargedOk.reduce((n, m) => n + m.seats, 0) * list.seatPrice;
        try {
          await deps.alerts.send({
            severity: 'critical',
            kind: 'ride_board_refund_due',
            title: `Refund due: ${list.code} called off with ${chargedOk.length} card(s) already charged`,
            body: [
              `Ride ${list.code} — ${list.fromPlace} → ${list.toPlace} on ${list.date}`,
              `Called off: ${chargedOk.length} charged, ${failed.length} declined, ${list.minSeats} needed.`,
              `Refund ${chargedOk.length} traveller(s), ${(owed / 100).toFixed(2)} ${currency} total:`,
              ...chargedOk.map((m) => `  ${m.firstName} <${m.email}> — ${m.seats} seat(s)`),
              `They have been emailed that a refund is coming. Refund from the ops booking sheet.`,
            ].join('\n'),
            dedupeKey: `ride_board_refund_due:${list.code}`,
          });
        } catch { /* the alert is the backstop, not the product */ }
      }
    }

    // Fires whether the van ran or not: an indeterminate charge is money in doubt either way,
    // and nothing else in the system will ever revisit it. Last, and best-effort, so it cannot
    // cost the travellers their emails.
    if (indeterminate.length > 0 && deps.alerts) {
      const atRisk = indeterminate.reduce((n, i) => n + list.seatPrice * i.member.seats, 0);
      try {
        await deps.alerts.send({
          severity: 'critical',
          kind: 'ride_board_charge_indeterminate',
          title: `Charge outcome unknown for ${indeterminate.length} traveller(s) on ${list.code}`,
          body: [
            `Ride ${list.code} — ${list.fromPlace} → ${list.toPlace} on ${list.date}`,
            `These charges were SENT to PayHere and the reply was lost. The cards MAY have been`,
            `debited, totalling ${(atRisk / 100).toFixed(2)} ${currency}:`,
            ...indeterminate.map(
              (i) => `  ${i.member.firstName} <${i.member.email}> — order ${i.orderId}` +
                `, ${i.member.seats} seat(s)${i.reason ? ` (${i.reason})` : ''}`,
            ),
            '',
            `Do NOT retry the charge — this API has no idempotency key, so a retry is how a`,
            `traveller gets billed twice. Open PayHere > Payments, search the order id, and:`,
            `  • payment found → nothing to do, they are on the van and paid.`,
            `  • no payment    → take it from them another way, or refund the seat.`,
            ranThisList
              ? `They have been emailed that the ride is confirmed, which is true either way.`
              : `The ride was called off; they have been emailed that a refund is coming.`,
          ].join('\n'),
          dedupeKey: `ride_board_charge_indeterminate:${list.code}`,
        });
      } catch { /* the alert is the backstop, not the product */ }
    }
  }

  return res;
}
