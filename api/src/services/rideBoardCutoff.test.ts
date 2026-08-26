import { describe, it, expect } from 'vitest';
import { FakeAlertAdapter } from '../adapters/alerts';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryRideListRepo, type CreateListArgs } from '../db/rideListRepo';
import { FakeTokenizedPaymentAdapter } from '../adapters/tokenizedPayments';
import { FakeEmailAdapter } from '../adapters/email';
import { runRideBoardCutoff } from './rideBoardCutoff';
import { SendBudget } from './sendBudget';

const PAST = new Date('2026-08-06T01:30:00Z');
const NOW = new Date('2026-08-07T00:00:00Z'); // after PAST

const listArgs = (over: Partial<CreateListArgs> = {}): CreateListArgs => ({
  corridorId: 'ella-south', fromPlace: 'Ella', toPlace: 'Mirissa', date: '2026-08-08', slot: 'morning',
  minSeats: 4, capacity: 6, seatPrice: 2400, note: null, cutoffAt: PAST, createdBy: null, ...over,
});

const joiner = (sub: string, ref: string, preferredTime: string | null = null) => ({
  sub, firstName: sub.toUpperCase(), country: 'LK', email: `${sub}@x.com`, seats: 1, preapprovalRef: ref, preferredTime,
});

async function fill(repo: InMemoryRideListRepo, listId: string, n: number, prefs: (string | null)[] = []) {
  for (let i = 0; i < n; i++) await repo.addMember(listId, joiner(`u${i}`, `pa_u${i}`, prefs[i] ?? null));
}

describe('runRideBoardCutoff', () => {
  it('confirms a full list: locks the popular time, charges every seat, emails everyone', async () => {
    const repo = new InMemoryRideListRepo();
    const paygw = new FakeTokenizedPaymentAdapter();
    const email = new FakeEmailAdapter();
    const list = await repo.createList(listArgs());
    await fill(repo, list.id, 4, ['09:00', '09:00', '08:00', '09:00']);

    const res = await runRideBoardCutoff(NOW, { rideLists: repo, paygw, email });
    expect(res).toMatchObject({ processed: 1, confirmed: 1, expired: 0, charged: 4, chargeFailed: 0 });

    const after = await repo.getByCode(list.code);
    expect(after?.list.status).toBe('confirmed');
    expect(after?.list.lockedTime).toBe('09:00'); // group's most-popular
    expect(after?.members.every((m) => m.status === 'charged')).toBe(true);
    expect(paygw.charges).toHaveLength(4);
    expect(paygw.charges[0].amountCents).toBe(2400);
    expect(email.sent.filter((e) => /confirmed/i.test(e.subject))).toHaveLength(4);
  });

  it('calls off an under-filled list: nobody charged, everyone told', async () => {
    const repo = new InMemoryRideListRepo();
    const paygw = new FakeTokenizedPaymentAdapter();
    const email = new FakeEmailAdapter();
    const list = await repo.createList(listArgs());
    await fill(repo, list.id, 2);

    const res = await runRideBoardCutoff(NOW, { rideLists: repo, paygw, email });
    expect(res).toMatchObject({ processed: 1, confirmed: 0, expired: 1, charged: 0 });
    expect((await repo.getByCode(list.code))?.list.status).toBe('expired');
    expect(paygw.charges).toHaveLength(0);
    expect(email.sent.filter((e) => /called off/i.test(e.subject))).toHaveLength(2);
  });

  it('still confirms when one card declines, and emails the at-risk traveller', async () => {
    const repo = new InMemoryRideListRepo();
    const paygw = new FakeTokenizedPaymentAdapter();
    const email = new FakeEmailAdapter();
    const list = await repo.createList(listArgs({ minSeats: 4, capacity: 6 }));
    await fill(repo, list.id, 5); // 5 held, one will decline → 4 still charge (== minSeats)
    paygw.markRefWillFail('pa_u4');

    const res = await runRideBoardCutoff(NOW, { rideLists: repo, paygw, email });
    expect(res).toMatchObject({ confirmed: 1, charged: 4, chargeFailed: 1 });
    const after = await repo.getByCode(list.code);
    expect(after?.list.status).toBe('confirmed');
    expect(after?.members.find((m) => m.sub === 'u4')?.status).toBe('charge_failed');
    expect(email.sent.some((e) => /at risk/i.test(e.subject))).toBe(true);
  });

  // The money-safety case. Enough seats were HELD, so the sweep charges — then enough of
  // those charges fail to drop the list below its minimum, and it is called off. The cards
  // that DID charge are real money taken for a van that will not run.
  //
  // Before this, every held member (charged ones included) got sendRideCancelled, whose
  // subject is "you weren't charged" and whose body says "nothing to do" — we took a
  // traveller's money and emailed them that we hadn't. The only trace of the money was a
  // `needsRefund` field on a log line nobody reads.
  describe('called off AFTER some cards were charged', () => {
    const chargedThenCalledOff = async (alerts?: FakeAlertAdapter) => {
      const repo = new InMemoryRideListRepo();
      const paygw = new FakeTokenizedPaymentAdapter();
      const email = new FakeEmailAdapter();
      const list = await repo.createList(listArgs({ minSeats: 4, capacity: 6 }));
      await fill(repo, list.id, 4);
      paygw.markRefWillFail('pa_u2');
      paygw.markRefWillFail('pa_u3'); // 2 charge, 2 decline → 2 < minSeats → called off
      const res = await runRideBoardCutoff(NOW, { rideLists: repo, paygw, email, ...(alerts ? { alerts } : {}) });
      return { repo, paygw, email, list, res };
    };

    it('never tells a charged traveller they were not charged', async () => {
      const { email, res } = await chargedThenCalledOff();
      expect(res).toMatchObject({ expired: 1, charged: 2, chargeFailed: 2 });

      const toCharged = email.sent.filter((e) => e.to === 'u0@x.com' || e.to === 'u1@x.com');
      expect(toCharged.length).toBeGreaterThan(0);
      for (const e of toCharged) {
        expect(`${e.subject} ${e.text}`).not.toMatch(/n't charged|not charged|hold is released/i);
      }
    });

    it('tells the charged traveller their money is coming back', async () => {
      const { email } = await chargedThenCalledOff();
      const toCharged = email.sent.filter((e) => e.to === 'u0@x.com');
      expect(toCharged.some((e) => /refund/i.test(`${e.subject} ${e.text}`))).toBe(true);
    });

    it('still sends the plain called-off email to travellers who were NOT charged', async () => {
      const { email } = await chargedThenCalledOff();
      const toDeclined = email.sent.filter((e) => e.to === 'u2@x.com');
      expect(toDeclined.some((e) => /n't charged|not charged/i.test(e.subject))).toBe(true);
    });

    it('raises an alert so a human refunds it — a log line is not a notification', async () => {
      const alerts = new FakeAlertAdapter();
      const { list } = await chargedThenCalledOff(alerts);
      const alert = alerts.sent.find((a) => /refund/i.test(a.kind));
      expect(alert, 'expected a refund-due alert').toBeTruthy();
      expect(alert!.severity).not.toBe('info'); // money is owed back; this is not FYI
      expect(`${alert!.title} ${alert!.body}`).toContain(list.code);
      expect(`${alert!.title} ${alert!.body}`).toMatch(/2/); // how many cards to refund
    });

    it('raises no refund alert when nobody was charged', async () => {
      const alerts = new FakeAlertAdapter();
      const repo = new InMemoryRideListRepo();
      const paygw = new FakeTokenizedPaymentAdapter();
      const email = new FakeEmailAdapter();
      const list = await repo.createList(listArgs());
      await fill(repo, list.id, 2); // under-filled: called off before any charge
      await runRideBoardCutoff(NOW, { rideLists: repo, paygw, email, alerts });
      expect(alerts.sent.filter((a) => /refund/i.test(a.kind))).toHaveLength(0);
      expect(list.code).toBeTruthy();
    });
  });

  it('ignores lists whose cutoff has not passed', async () => {
    const repo = new InMemoryRideListRepo();
    const paygw = new FakeTokenizedPaymentAdapter();
    const email = new FakeEmailAdapter();
    const future = await repo.createList(listArgs({ cutoffAt: new Date('2026-09-01T00:00:00Z') }));
    await fill(repo, future.id, 4);

    const res = await runRideBoardCutoff(NOW, { rideLists: repo, paygw, email });
    expect(res.processed).toBe(0);
    expect((await repo.getByCode(future.code))?.list.status).toBe('gathering');
  });

  it('is idempotent — a second run does nothing (list no longer gathering)', async () => {
    const repo = new InMemoryRideListRepo();
    const paygw = new FakeTokenizedPaymentAdapter();
    const email = new FakeEmailAdapter();
    const list = await repo.createList(listArgs());
    await fill(repo, list.id, 4);
    await runRideBoardCutoff(NOW, { rideLists: repo, paygw, email });
    const second = await runRideBoardCutoff(NOW, { rideLists: repo, paygw, email });
    expect(second.processed).toBe(0);
    expect(paygw.charges).toHaveLength(4); // not charged again
  });
});

// ── Burst cap (notification safety rails, slice 1) ─────────────────────────
// This sweep CHARGES CARDS, so the cap guards money, not just mail. A list is all-or-
// nothing: rather than charge half a van and stop, the sweep declines to start a list it
// cannot finish. The list stays gathering and is still due next run.
describe('runRideBoardCutoff — burst cap', () => {
  it('does not start a list it cannot finish: no charges, no emails, status untouched', async () => {
    const repo = new InMemoryRideListRepo();
    const paygw = new FakeTokenizedPaymentAdapter();
    const email = new FakeEmailAdapter();
    const list = await repo.createList(listArgs());
    await fill(repo, list.id, 4);

    const budget = new SendBudget(2); // 4 travellers would need 4
    const res = await runRideBoardCutoff(NOW, { rideLists: repo, paygw, email, budget });

    expect(res.processed).toBe(0);
    expect(paygw.charges).toHaveLength(0);
    expect(email.sent).toHaveLength(0);
    expect((await repo.getByCode(list.code))?.list.status).toBe('gathering');
    expect(budget.report().kinds).toEqual({ ride_board: 4 });
  });

  it('the skipped list is picked up whole by the next run', async () => {
    const repo = new InMemoryRideListRepo();
    const paygw = new FakeTokenizedPaymentAdapter();
    const email = new FakeEmailAdapter();
    const list = await repo.createList(listArgs());
    await fill(repo, list.id, 4);

    await runRideBoardCutoff(NOW, { rideLists: repo, paygw, email, budget: new SendBudget(2) });
    const res = await runRideBoardCutoff(NOW, { rideLists: repo, paygw, email, budget: new SendBudget(25) });

    expect(res).toMatchObject({ processed: 1, confirmed: 1, charged: 4 });
    expect((await repo.getByCode(list.code))?.list.status).toBe('confirmed');
  });

  it('processes a list that fits and spends the budget for it', async () => {
    const repo = new InMemoryRideListRepo();
    const paygw = new FakeTokenizedPaymentAdapter();
    const email = new FakeEmailAdapter();
    const list = await repo.createList(listArgs());
    await fill(repo, list.id, 4);

    const budget = new SendBudget(25);
    const res = await runRideBoardCutoff(NOW, { rideLists: repo, paygw, email, budget });

    expect(res.confirmed).toBe(1);
    expect(budget.sent).toBe(4);
    expect(budget.anySuppressed).toBe(false);
  });
});

// `alerts` is an OPTIONAL dep, so dropping it at the call site still typechecks and leaves
// every test above green — the sweep would just go quiet again in production, which is the
// exact failure this change exists to remove. Cheaper to pin the wiring than to rebuild the
// admin test harness with a ride-board repo and a payment gateway.
describe('the cutoff is wired to alerts in production', () => {
  it('POST /admin/jobs/notifications passes alerts into the sweep', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const admin = readFileSync(path.join(here, '..', 'routes', 'admin.ts'), 'utf8');
    const call = admin.match(/runRideBoardCutoff\(new Date\(\), \{[^}]*\}/);
    expect(call, 'runRideBoardCutoff call not found in admin.ts').toBeTruthy();
    expect(call![0], 'the sweep must be given alerts, or a refund-due call-off is silent').toContain('alerts');
  });
});

// A charge whose reply was lost is NOT a failure — PayHere may have taken the money. Treating
// it as one is how a traveller gets emailed "the ride is off, you weren't charged" while their
// card is debited, with no alert and no place on the refund list.
//
// The policy is deliberately OPTIMISTIC: an unknown outcome counts toward the van running.
// Compare the two ways of being wrong. Optimistic and PayHere did not charge → we carry one
// unpaid seat on a van that runs: bounded, alerted, chaseable. Pessimistic and PayHere DID
// charge → we cancel a viable van and tell a debited customer they weren't charged. The
// optimistic branch is also the only one whose customer-facing email is true either way,
// because that traveller is on the van in both worlds.
describe('a charge with an unknown outcome', () => {
  const withUnknown = async (over: Partial<CreateListArgs>, unknownRefs: string[], failRefs: string[] = []) => {
    const repo = new InMemoryRideListRepo();
    const paygw = new FakeTokenizedPaymentAdapter();
    const email = new FakeEmailAdapter();
    const alerts = new FakeAlertAdapter();
    const list = await repo.createList(listArgs(over));
    await fill(repo, list.id, (over.capacity ?? 6) >= 5 ? 5 : 4);
    unknownRefs.forEach((r) => paygw.markRefWillBeUnknown(r));
    failRefs.forEach((r) => paygw.markRefWillFail(r));
    const res = await runRideBoardCutoff(NOW, { rideLists: repo, paygw, email, alerts });
    return { repo, paygw, email, alerts, list, res };
  };

  it('counts toward the van running rather than sinking it', async () => {
    // 4 seats needed, 4 held: three charge cleanly and one is indeterminate. Pessimism here
    // would call off a van that is very probably paid for.
    const { repo, email, res, list } = await withUnknown({ minSeats: 4, capacity: 4 }, ['pa_u3']);

    expect(res).toMatchObject({ confirmed: 1, expired: 0, charged: 3, chargeUnknown: 1 });
    expect((await repo.getByCode(list.code))?.list.status).toBe('confirmed');
    expect(email.sent.filter((e) => /called off/i.test(e.subject))).toHaveLength(0);
  });

  it('never tells the traveller they were not charged', async () => {
    // The van is called off for other reasons; the indeterminate traveller must not receive
    // the "you weren't charged" email, because they may well have been.
    const { email } = await withUnknown({ minSeats: 5, capacity: 6 }, ['pa_u0'], ['pa_u1', 'pa_u2', 'pa_u3']);

    const theirs = email.sent.filter((e) => e.to === 'u0@x.com');
    expect(theirs.length).toBeGreaterThan(0);
    for (const e of theirs) {
      expect(`${e.subject} ${e.text}`).not.toMatch(/n't charged|not charged|hold is released/i);
    }
    expect(theirs.some((e) => /refund/i.test(`${e.subject} ${e.text}`))).toBe(true);
  });

  it('raises a critical alert naming the order id a human must reconcile', async () => {
    const { alerts, list } = await withUnknown({ minSeats: 4, capacity: 4 }, ['pa_u3']);

    const alert = alerts.sent.find((a) => /unknown|indeterminate/i.test(a.kind));
    expect(alert, 'expected an indeterminate-charge alert').toBeTruthy();
    expect(alert!.severity).toBe('critical');
    // Without the order id nobody can find the payment in the PayHere dashboard.
    expect(`${alert!.title} ${alert!.body}`).toContain(`${list.code}-u3`);
    expect(alert!.body).toMatch(/do not retry|don't retry/i);
  });

  // The alert tells ops what the traveller was told, so it must describe THIS list's outcome.
  // A per-sweep accumulator would let a confirmed list earlier in the batch put "the ride is
  // confirmed" into the alert for a list that was actually called off.
  it('describes the outcome of its own list, not of one earlier in the sweep', async () => {
    const repo = new InMemoryRideListRepo();
    const paygw = new FakeTokenizedPaymentAdapter();
    const email = new FakeEmailAdapter();
    const alerts = new FakeAlertAdapter();

    const runs = await repo.createList(listArgs({ minSeats: 2, capacity: 6 }));
    await fill(repo, runs.id, 2); // both charge cleanly → confirmed

    // Distinct refs: the fake keys its outcomes by token, so reusing pa_u0 would also break
    // the list above and prove nothing about the alert.
    const calledOff = await repo.createList(listArgs({ fromPlace: 'Kandy', minSeats: 4, capacity: 6 }));
    for (let i = 0; i < 4; i++) await repo.addMember(calledOff.id, joiner(`k${i}`, `pa_k${i}`));
    paygw.markRefWillBeUnknown('pa_k0');
    ['pa_k1', 'pa_k2', 'pa_k3'].forEach((r) => paygw.markRefWillFail(r));

    const res = await runRideBoardCutoff(NOW, { rideLists: repo, paygw, email, alerts });
    expect(res).toMatchObject({ confirmed: 1, expired: 1 });

    const alert = alerts.sent.find((a) => a.kind === 'ride_board_charge_indeterminate');
    expect(alert!.body).toContain(calledOff.code);
    expect(alert!.body).toMatch(/called off/i);
    expect(alert!.body).not.toMatch(/ride is confirmed/i);
  });

  it('leaves no traveller in a state the sweep would charge a second time', async () => {
    const { repo, paygw, list } = await withUnknown({ minSeats: 4, capacity: 4 }, ['pa_u3']);

    const them = (await repo.getByCode(list.code))?.members.find((m) => m.sub === 'u3');
    expect(them?.status).not.toBe('held'); // 'held' is precisely what a re-sweep would charge
    const chargesForThem = paygw.charges.filter((c) => c.orderId === `${list.code}-u3`);
    expect(chargesForThem).toHaveLength(1);
  });
});
