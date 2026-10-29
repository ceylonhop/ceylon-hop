import { describe, it, expect } from 'vitest';
import { runRideBoardFillTips, type FillTipArgs } from './rideBoardFillTips';
import { InMemoryRideListRepo, type CreateListArgs } from '../db/rideListRepo';
import { InMemoryAlertLogRepo } from '../db/alertLogRepo';
import { SendBudget } from './sendBudget';
import { SEED_MEMBER_SUB_PREFIX } from '../domain/rideList';
import { futureIsoDate } from '../testSupport/dates';

// ============================================================================
// "How to fill your van" (owner ask 2026-10-27): one email per traveller on a ride that is
// still short, a day after they put their name down, telling them where to post it. Never
// twice. The first real run doubles as the backfill for everyone already on the board.
// ============================================================================

const HOUR = 3600_000;
const DAY = 24 * HOUR;
// Real "now": listOpen drops rides dated before today, and the test dates are anchored to today.
const NOW = new Date();
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const inDays = (d: number) => new Date(NOW.getTime() + d * DAY);

const listArgs = (over: Partial<CreateListArgs> = {}): CreateListArgs => ({
  corridorId: 'ella-south', fromPlace: 'Ella', toPlace: 'Mirissa', date: futureIsoDate(10), slot: 'morning',
  minSeats: 4, capacity: 6, seatPrice: 2300, note: null, cutoffAt: inDays(8), createdBy: null, ...over,
});

function harness() {
  const rideLists = new InMemoryRideListRepo();
  const alertLog = new InMemoryAlertLogRepo();
  const sent: FillTipArgs[] = [];
  let failNext = 0;
  const send = async (args: FillTipArgs): Promise<void> => {
    if (failNext > 0) {
      failNext -= 1;
      throw new Error('provider down');
    }
    sent.push(args);
  };
  return { rideLists, alertLog, sent, send, failNextSend: () => { failNext += 1; } };
}

async function shortRide(h: ReturnType<typeof harness>) {
  // Started 2 days ago by Mia; Ben joined 30h ago; Cy joined 2h ago; a seed placeholder.
  // 1 + 1 + 1 + 1 = 4 seats... which would be viable — so the seed holds nothing here.
  const list = await h.rideLists.createList(listArgs({ createdBy: 'mia-sub' }), ago(2 * DAY));
  await h.rideLists.addMember(list.id, { sub: 'mia-sub', firstName: 'Mia', country: 'DE', email: 'mia@x.com', seats: 1 }, ago(2 * DAY));
  await h.rideLists.addMember(list.id, { sub: 'ben-sub', firstName: 'Ben', country: 'GB', email: 'ben@x.com', seats: 1 }, ago(30 * HOUR));
  await h.rideLists.addMember(list.id, { sub: 'cy-sub', firstName: 'Cy', country: 'FR', email: 'cy@x.com', seats: 1 }, ago(2 * HOUR));
  return list;
}

describe('runRideBoardFillTips', () => {
  it('mails every live traveller on a short ride a day after they joined, starter marked', async () => {
    const h = harness();
    const list = await shortRide(h);
    const res = await runRideBoardFillTips(NOW, { ...h });

    expect(res).toMatchObject({ lists: 1, due: 2, sent: 2, skipped: 0, failed: 0 });
    expect(h.sent.map((a) => a.to).sort()).toEqual(['ben@x.com', 'mia@x.com']);
    const mia = h.sent.find((a) => a.to === 'mia@x.com')!;
    expect(mia).toMatchObject({ firstName: 'Mia', isStarter: true, committed: 3 });
    expect(mia.list.code).toBe(list.code);
    expect(h.sent.find((a) => a.to === 'ben@x.com')).toMatchObject({ isStarter: false, committed: 3 });
    expect(res.sample).toEqual([`${list.code}:mia-sub`, `${list.code}:ben-sub`]);
  });

  it('the one who joined two hours ago gets theirs on a later tick', async () => {
    const h = harness();
    await shortRide(h);
    await runRideBoardFillTips(NOW, { ...h });
    const later = await runRideBoardFillTips(new Date(NOW.getTime() + DAY), { ...h });
    expect(later).toMatchObject({ due: 3, sent: 1, skipped: 2 });
    expect(h.sent.at(-1)?.to).toBe('cy@x.com');
  });

  it('never sends twice: a second tick the same day sends nothing', async () => {
    const h = harness();
    await shortRide(h);
    await runRideBoardFillTips(NOW, { ...h });
    const again = await runRideBoardFillTips(new Date(NOW.getTime() + HOUR), { ...h });
    expect(again).toMatchObject({ due: 2, sent: 0, skipped: 2 });
    expect(h.sent).toHaveLength(2);
  });

  it('a viable ride (enough seats pledged) gets no tip, even with members a day old', async () => {
    const h = harness();
    const list = await h.rideLists.createList(listArgs({ minSeats: 2, createdBy: 'mia-sub' }), ago(2 * DAY));
    await h.rideLists.addMember(list.id, { sub: 'mia-sub', firstName: 'Mia', country: 'DE', email: 'mia@x.com', seats: 1 }, ago(2 * DAY));
    await h.rideLists.addMember(list.id, { sub: 'ben-sub', firstName: 'Ben', country: 'GB', email: 'ben@x.com', seats: 1 }, ago(2 * DAY));
    const res = await runRideBoardFillTips(NOW, { ...h });
    expect(res).toMatchObject({ lists: 0, due: 0, sent: 0 });
    expect(h.sent).toHaveLength(0);
  });

  it('skips rides past their cutoff, confirmed rides, seed placeholders and members without an inbox', async () => {
    const h = harness();
    const past = await h.rideLists.createList(listArgs({ cutoffAt: ago(60_000), date: futureIsoDate(1) }), ago(3 * DAY));
    await h.rideLists.addMember(past.id, { sub: 'di-sub', firstName: 'Di', country: 'FR', email: 'di@x.com', seats: 1 }, ago(3 * DAY));
    const confirmed = await h.rideLists.createList(listArgs({ date: futureIsoDate(20), cutoffAt: inDays(18) }), ago(3 * DAY));
    await h.rideLists.addMember(confirmed.id, { sub: 'ed-sub', firstName: 'Ed', country: 'FR', email: 'ed@x.com', seats: 1 }, ago(3 * DAY));
    await h.rideLists.setStatus(confirmed.id, 'confirmed');
    const open = await h.rideLists.createList(listArgs(), ago(3 * DAY));
    await h.rideLists.addMember(open.id, { sub: `${SEED_MEMBER_SUB_PREFIX}1`, firstName: 'Seed', country: 'LK', email: '', seats: 1 }, ago(3 * DAY));
    await h.rideLists.addMember(open.id, { sub: 'fay-sub', firstName: 'Fay', country: 'NL', email: '', seats: 1 }, ago(3 * DAY));

    const res = await runRideBoardFillTips(NOW, { ...h });
    expect(res).toMatchObject({ lists: 1, due: 0, sent: 0 });
    expect(h.sent).toHaveLength(0);
  });

  it('a dry run counts and names who would get one, but neither sends nor claims', async () => {
    const h = harness();
    const list = await shortRide(h);
    const dry = await runRideBoardFillTips(NOW, { ...h, dryRun: true });
    expect(dry).toMatchObject({ lists: 1, due: 2, sent: 0, skipped: 0, dryRun: true });
    expect(dry.sample).toEqual([`${list.code}:mia-sub`, `${list.code}:ben-sub`]);
    expect(h.sent).toHaveLength(0);
    const real = await runRideBoardFillTips(NOW, { ...h });
    expect(real.sent).toBe(2);
  });

  it('a failed send is released for the next tick, not lost', async () => {
    const h = harness();
    await shortRide(h);
    h.failNextSend();
    const first = await runRideBoardFillTips(NOW, { ...h });
    expect(first).toMatchObject({ sent: 1, failed: 1 });
    const second = await runRideBoardFillTips(new Date(NOW.getTime() + HOUR), { ...h });
    expect(second).toMatchObject({ sent: 1, skipped: 1, failed: 0 });
    expect(h.sent).toHaveLength(2);
  });

  it('stops at the tick send budget and reports what it held back', async () => {
    const h = harness();
    await shortRide(h);
    const budget = new SendBudget(1);
    const res = await runRideBoardFillTips(NOW, { ...h, budget });
    expect(res).toMatchObject({ due: 2, sent: 1, suppressed: 1 });
    expect(h.sent).toHaveLength(1);
    expect(budget.report().suppressed).toBe(1);
    // Nothing was claimed for the one held back: a later tick with room sends it.
    const later = await runRideBoardFillTips(new Date(NOW.getTime() + HOUR), { ...h });
    expect(later).toMatchObject({ sent: 1, skipped: 1 });
  });

  it('without a ledger it still works but says a re-run would re-send', async () => {
    const h = harness();
    await shortRide(h);
    const res = await runRideBoardFillTips(NOW, { rideLists: h.rideLists, send: h.send });
    expect(res).toMatchObject({ sent: 2, ledger: false });
  });
});
