import { describe, it, expect } from 'vitest';
import { runBoardOpsBackfill } from './rideBoardOpsBackfill';
import { InMemoryRideListRepo, type CreateListArgs } from '../db/rideListRepo';
import { InMemoryAlertLogRepo } from '../db/alertLogRepo';
import { FakeEmailAdapter, type EmailAdapter } from '../adapters/email';
import { SEED_MEMBER_SUB_PREFIX } from '../domain/rideList';
import { futureIsoDate } from '../testSupport/dates';

// ============================================================================
// One-shot catch-up (owner ask 2026-09-22): the ops "seat held" mail shipped in #702 only
// fires on NEW commitments. Seats held before it existed were never announced. This job
// mails ops once per live seat on every list still gathering with a future cutoff, and
// nothing else — past, confirmed and cancelled lists are over or already handled.
// ============================================================================

const NOW = new Date();
const inDays = (d: number) => new Date(NOW.getTime() + d * 86_400_000);

const listArgs = (over: Partial<CreateListArgs> = {}): CreateListArgs => ({
  corridorId: 'ella-south', fromPlace: 'Ella', toPlace: 'Mirissa', date: futureIsoDate(10), slot: 'morning',
  minSeats: 3, capacity: 6, seatPrice: 2400, note: null, cutoffAt: inDays(8), createdBy: null, ...over,
});

async function seeded() {
  const rideLists = new InMemoryRideListRepo();
  const email = new FakeEmailAdapter();
  const alertLog = new InMemoryAlertLogRepo();

  // Open, future cutoff, two real seats + one seed placeholder: 2 mails.
  const open = await rideLists.createList(listArgs({ createdBy: 'ana-sub' }));
  await rideLists.addMember(open.id, { sub: 'ana-sub', firstName: 'Ana', country: 'ES', email: 'ana@x.com', seats: 1 });
  await rideLists.addMember(open.id, { sub: 'ben-sub', firstName: 'Ben', country: 'GB', email: 'ben@x.com', seats: 2 });
  await rideLists.addMember(open.id, { sub: `${SEED_MEMBER_SUB_PREFIX}1`, firstName: 'Seed', country: 'LK', email: '', seats: 1 });

  // Gathering but past its cutoff: the sweep owns it now — 0 mails.
  const due = await rideLists.createList(listArgs({ cutoffAt: new Date(NOW.getTime() - 60_000), date: futureIsoDate(1) }));
  await rideLists.addMember(due.id, { sub: 'cy-sub', firstName: 'Cy', country: 'DE', email: 'cy@x.com', seats: 1 });

  // Confirmed: already ran through the cutoff, everyone was told — 0 mails.
  const confirmed = await rideLists.createList(listArgs({ date: futureIsoDate(20), cutoffAt: inDays(18) }));
  await rideLists.addMember(confirmed.id, { sub: 'di-sub', firstName: 'Di', country: 'FR', email: 'di@x.com', seats: 1 });
  await rideLists.setStatus(confirmed.id, 'confirmed');

  return { rideLists, email, alertLog, open };
}

describe('runBoardOpsBackfill', () => {
  it('mails ops once per live, real seat on a list still gathering with a future cutoff', async () => {
    const { rideLists, email, alertLog, open } = await seeded();
    const res = await runBoardOpsBackfill(NOW, { rideLists, email, alertLog, to: 'ops@x.com', opsBaseUrl: 'https://ops.example' });

    expect(res).toMatchObject({ lists: 1, seats: 2, sent: 2, skipped: 0, failed: 0 });
    expect(email.sent).toHaveLength(2);
    expect(email.sent.every((m) => m.to === 'ops@x.com' && m.audience === 'ops')).toBe(true);
    expect(email.sent.every((m) => m.html.includes(open.code))).toBe(true);
    // Every mail carries the list's CURRENT fill, not a running count — ops reads them as
    // a snapshot, and both arrive together. The seed placeholder gets no mail but DOES hold
    // a seat (1 + 2 + 1), exactly as the board shows it.
    expect(email.sent.every((m) => m.subject.includes('(4 of 3 seats)'))).toBe(true);
    // The creator is announced as the starter; anyone else as a joiner.
    expect(email.sent.find((m) => m.html.includes('ana@x.com'))?.subject).toMatch(/^New shared ride/);
    expect(email.sent.find((m) => m.html.includes('ben@x.com'))?.subject).toMatch(/^Seat taken/);
    expect(res.sample).toEqual([`${open.code}:ana-sub`, `${open.code}:ben-sub`]);
  });

  it('is idempotent: a second run sends nothing', async () => {
    const { rideLists, email, alertLog } = await seeded();
    await runBoardOpsBackfill(NOW, { rideLists, email, alertLog, to: 'ops@x.com' });
    const again = await runBoardOpsBackfill(new Date(NOW.getTime() + 3600_000), { rideLists, email, alertLog, to: 'ops@x.com' });
    expect(again).toMatchObject({ seats: 2, sent: 0, skipped: 2 });
    expect(email.sent).toHaveLength(2);
  });

  it('a dry run counts but neither sends nor claims', async () => {
    const { rideLists, email, alertLog } = await seeded();
    const dry = await runBoardOpsBackfill(NOW, { rideLists, email, alertLog, to: 'ops@x.com', dryRun: true });
    expect(dry).toMatchObject({ lists: 1, seats: 2, sent: 0, skipped: 0, dryRun: true });
    expect(email.sent).toHaveLength(0);
    const real = await runBoardOpsBackfill(NOW, { rideLists, email, alertLog, to: 'ops@x.com' });
    expect(real.sent).toBe(2);
  });

  it('a failed send is released so the next run retries it', async () => {
    const { rideLists, alertLog } = await seeded();
    let calls = 0;
    const flaky: EmailAdapter = { async send() { calls += 1; if (calls === 1) throw new Error('provider down'); } };
    const first = await runBoardOpsBackfill(NOW, { rideLists, email: flaky, alertLog, to: 'ops@x.com' });
    expect(first).toMatchObject({ sent: 1, failed: 1 });
    const second = await runBoardOpsBackfill(new Date(NOW.getTime() + 1000), { rideLists, email: flaky, alertLog, to: 'ops@x.com' });
    expect(second).toMatchObject({ sent: 1, skipped: 1, failed: 0 });
  });

  it('without a ledger it still runs, but says so', async () => {
    const { rideLists, email } = await seeded();
    const res = await runBoardOpsBackfill(NOW, { rideLists, email, to: 'ops@x.com' });
    expect(res.sent).toBe(2);
    expect(res.ledger).toBe(false);
  });
});
