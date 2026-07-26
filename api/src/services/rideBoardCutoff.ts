import type { RideListRepo } from '../db/rideListRepo';
import type { TokenizedPaymentAdapter } from '../adapters/tokenizedPayments';
import type { EmailAdapter } from '../adapters/email';
import { committedSeats, popularTime, type Slot, type RideMember } from '../domain/rideList';
import { sendRideConfirmed, sendRideCancelled, sendRideAtRisk } from './rideBoardEmails';
import { logEvent } from '../observability/events';

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
  currency?: string;
}

export interface RideBoardCutoffResult {
  processed: number;
  confirmed: number;
  expired: number;
  charged: number;
  chargeFailed: number;
}

const liveSeats = (members: RideMember[]) => committedSeats(members);

export async function runRideBoardCutoff(now: Date, deps: RideBoardCutoffDeps): Promise<RideBoardCutoffResult> {
  const currency = deps.currency ?? 'USD';
  const due = await deps.rideLists.dueForCutoff(now);
  const res: RideBoardCutoffResult = { processed: 0, confirmed: 0, expired: 0, charged: 0, chargeFailed: 0 };

  for (const { list, members } of due) {
    res.processed++;
    const held = members.filter((m) => m.status === 'held' || m.status === 'charged');

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
    for (const m of held) {
      if (m.status === 'charged') {
        chargedOk.push(m);
        continue;
      }
      const charge = await deps.paygw.charge({
        ref: m.preapprovalRef ?? '',
        amountCents: list.seatPrice * m.seats,
        currency,
        orderId: `${list.code}-${m.sub}`,
      });
      if (charge.status === 'succeeded') {
        await deps.rideLists.setMemberStatus(list.id, m.sub, 'charged');
        res.charged++;
        chargedOk.push(m);
      } else {
        await deps.rideLists.setMemberStatus(list.id, m.sub, 'charge_failed');
        res.chargeFailed++;
        failed.push(m);
      }
    }

    if (chargedOk.reduce((n, m) => n + m.seats, 0) >= list.minSeats) {
      // Confirmed with the successfully-charged travellers.
      await deps.rideLists.setStatus(list.id, 'confirmed');
      res.confirmed++;
      logEvent('ride_board.confirmed', {
        code: list.code, corridorId: list.corridorId, date: list.date, lockedTime: time,
        seats: chargedOk.reduce((n, m) => n + m.seats, 0), minSeats: list.minSeats,
        capacity: list.capacity, chargeFailures: failed.length,
        revenueCents: chargedOk.reduce((n, m) => n + m.seats, 0) * list.seatPrice,
      });
      for (const m of chargedOk) await sendRideConfirmed(deps.email, { to: m.email, firstName: m.firstName, list, lockedTime: time });
      for (const m of failed) await sendRideAtRisk(deps.email, { to: m.email, firstName: m.firstName, list });
    } else {
      // Rare: enough held, but charge failures dropped it below the threshold → call it off.
      // NOTE: any card already charged here needs a manual refund — the real-money path
      // (owner-gated PayHere swap) must add auto-refund. Flagged in the go-live checklist.
      await deps.rideLists.setStatus(list.id, 'expired');
      res.expired++;
      logEvent('ride_board.called_off', {
        code: list.code, corridorId: list.corridorId, date: list.date,
        reason: 'charge_failures', chargeFailures: failed.length,
        chargedSeats: chargedOk.reduce((n, m) => n + m.seats, 0), minSeats: list.minSeats,
        // these cards are charged with the van cancelled — the manual-refund case
        needsRefund: chargedOk.length,
      });
      for (const m of held) await sendRideCancelled(deps.email, { to: m.email, firstName: m.firstName, list });
    }
  }

  return res;
}
