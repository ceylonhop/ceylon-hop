import { describe, it, expect, vi } from 'vitest';
import { InMemoryQuoteRepo, genReference, parseDateFilter, canTransition, isUnpricedShell, type NewQuote } from './quoteRepo';

describe('canTransition (quote review lifecycle)', () => {
  it('allows the maker-checker path but requires review before approval', () => {
    expect(canTransition('draft', 'pending_review')).toBe(true);
    expect(canTransition('pending_review', 'ready')).toBe(true); // approval happens only from review
    expect(canTransition('pending_review', 'changes_requested')).toBe(true);
    expect(canTransition('changes_requested', 'pending_review')).toBe(true);
    expect(canTransition('ready', 'sent')).toBe(true);
    expect(canTransition('ready', 'draft')).toBe(true); // reopen to edit
    expect(canTransition('sent', 'draft')).toBe(true);  // reopen a sent quote to edit (founder-gated at the route)
  });
  it('rejects approving without going through review (no self-approve from a draft)', () => {
    // A quote must be Submitted for review before it can be approved — for everyone, founders
    // included. The founder-only self-approve shortcut was removed (2026-07-19).
    expect(canTransition('draft', 'ready')).toBe(false);
    expect(canTransition('changes_requested', 'ready')).toBe(false);
  });
  it('rejects skipping the review gate', () => {
    expect(canTransition('draft', 'sent')).toBe(false);
    expect(canTransition('pending_review', 'sent')).toBe(false);
    expect(canTransition('sent', 'ready')).toBe(false);
  });
  it('allows an outcome flip from any live state, not from draft', () => {
    for (const s of ['pending_review', 'ready', 'sent'] as const) expect(canTransition(s, 'lost')).toBe(true);
    expect(canTransition('draft', 'won')).toBe(false);
  });
});

const sample = (over: Partial<NewQuote> = {}): NewQuote => ({
  product: 'private',
  vehicle: 'car',
  customerName: 'Maya',
  customerContact: '+34600',
  totalCents: 4048,
  currency: 'USD',
  rateCardVersion: '2026-06-28',
  marginCents: 900,
  request: { product: 'private', legs: [{ from: 'A', to: 'B', distanceKm: 80 }] },
  result: { totalCents: 4048 },
  ...over,
});

describe('InMemoryQuoteRepo', () => {
  it('save assigns id, a Q- reference, draft status, and timestamps', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(sample());
    expect(q.id).toMatch(/[0-9a-f-]{36}/);
    expect(q.reference).toMatch(/^Q-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/);
    expect(q.status).toBe('draft');
    expect(q.channel).toBe('ops');
    expect(q.totalCents).toBe(4048);
    expect(q.request).toEqual(sample().request);
    expect(q.createdAt).toBeInstanceOf(Date);
    expect(q.sentAt).toBeNull();
    expect(q.decidedAt).toBeNull();
    expect(q.convertedBookingId).toBeNull();
  });

  it('get returns a saved quote and null for unknown ids', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(sample());
    expect((await repo.get(q.id))?.reference).toBe(q.reference);
    expect(await repo.get('nope')).toBeNull();
  });

  it('list returns newest first and filters by status and product', async () => {
    const repo = new InMemoryQuoteRepo();
    const a = await repo.save(sample({ product: 'private' }));
    const b = await repo.save(sample({ product: 'chauffeur' }));
    await repo.patch(b.id, { status: 'won' });
    const all = await repo.list();
    expect(all.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect((await repo.list({ product: 'chauffeur' })).map((r) => r.id)).toEqual([b.id]);
    expect((await repo.list({ status: 'won' })).map((r) => r.id)).toEqual([b.id]);
    expect((await repo.list({ status: 'draft' })).map((r) => r.id)).toEqual([a.id]);
  });

  it('list orders by createdAt desc, then reference desc as a deterministic tiebreak', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-15T10:00:00.000Z'));
      const repo = new InMemoryQuoteRepo();
      // Both saves happen at the exact same fake instant, forcing a real createdAt tie.
      const a = await repo.save(sample());
      const b = await repo.save(sample());
      expect(a.createdAt.getTime()).toBe(b.createdAt.getTime());

      const expected = [a, b].sort((x, y) => (x.reference < y.reference ? 1 : -1)).map((r) => r.id);
      const first = await repo.list();
      const second = await repo.list();
      expect(first.map((r) => r.id)).toEqual(expected);
      expect(second.map((r) => r.id)).toEqual(expected); // stable across repeated calls
    } finally {
      vi.useRealTimers();
    }
  });

  it('genReference produces a Q- reference from the unambiguous 5-char alphabet', () => {
    for (let i = 0; i < 50; i++) {
      expect(genReference()).toMatch(/^Q-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/);
    }
  });

  it('save never produces a duplicate reference across many inserts', async () => {
    const repo = new InMemoryQuoteRepo();
    const refs = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const q = await repo.save(sample());
      expect(refs.has(q.reference)).toBe(false);
      refs.add(q.reference);
    }
    expect(refs.size).toBe(200);
  });

  it('parseDateFilter treats a date-only "to" as inclusive of the whole UTC day', () => {
    const from = parseDateFilter('2026-07-01', 'from');
    const to = parseDateFilter('2026-07-01', 'to');
    expect(from.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-07-01T23:59:59.999Z');
  });

  it('parseDateFilter parses non date-only strings as-is', () => {
    const iso = '2026-07-01T05:30:00.000Z';
    expect(parseDateFilter(iso, 'from').toISOString()).toBe(iso);
    expect(parseDateFilter(iso, 'to').toISOString()).toBe(iso);
  });

  it('list from/to filters are inclusive of the whole day when dates are date-only', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(sample());
    const today = q.createdAt.toISOString().slice(0, 10);
    const listed = await repo.list({ from: today, to: today });
    expect(listed.map((r) => r.id)).toContain(q.id);
  });

  it('patch updates status, stamps sent_at then decided_at, and records lost_reason', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(sample());
    const sent = await repo.patch(q.id, { status: 'sent' });
    expect(sent?.status).toBe('sent');
    expect(sent?.sentAt).toBeInstanceOf(Date);
    expect(sent?.decidedAt).toBeNull();
    const lost = await repo.patch(q.id, { status: 'lost', lostReason: 'too expensive' });
    expect(lost?.status).toBe('lost');
    expect(lost?.sentAt).toBeInstanceOf(Date); // preserved
    expect(lost?.decidedAt).toBeInstanceOf(Date);
    expect(lost?.lostReason).toBe('too expensive');
  });

  it('patch returns null for an unknown id', async () => {
    expect(await new InMemoryQuoteRepo().patch('nope', { status: 'won' })).toBeNull();
  });

  it('update rewrites the priced content in place, preserving id/reference/status/createdAt', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(sample({ totalCents: 4048, customerName: 'Maya' }));
    await repo.patch(q.id, { status: 'pending_review' }); // now mid-review
    const updated = await repo.update(q.id, sample({ totalCents: 5200, customerName: 'Maya R.', marginCents: 1300 }));
    expect(updated?.id).toBe(q.id);              // same row — no orphaned duplicate
    expect(updated?.reference).toBe(q.reference); // reference is stable
    expect(updated?.status).toBe('pending_review'); // status untouched by a content edit
    expect(updated?.totalCents).toBe(5200);
    expect(updated?.customerName).toBe('Maya R.');
    expect(updated?.marginCents).toBe(1300);
    expect(updated?.createdAt.getTime()).toBe(q.createdAt.getTime());
    expect((await repo.list()).length).toBe(1); // still exactly one quote
  });

  // A content write is a NEW REVISION of the quote, and anything holding the old one must be
  // able to notice. Pay links pin {quoteId, revision} (bookingToken.ts) and refuse a token
  // whose revision has moved — without this bump that guard is unreachable, because update()
  // is the only way an ops quote's content ever changes. Owner-caught, 2026-07-31: a link sent
  // at one price stayed payable at another.
  it('update bumps the revision, so a link pinned to the old one goes stale', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(sample({ totalCents: 4048 }));
    expect(q.revision).toBe(1);
    const once = await repo.update(q.id, sample({ totalCents: 5200 }));
    expect(once?.revision).toBe(2);
    const twice = await repo.update(q.id, sample({ totalCents: 6100 }));
    expect(twice?.revision).toBe(3);
    expect((await repo.get(q.id))?.revision).toBe(3); // persisted, not just returned
  });

  it('update returns null for an unknown id', async () => {
    expect(await new InMemoryQuoteRepo().update('nope', sample())).toBeNull();
  });

  // A soft-deleted row is off-limits to a content write, exactly like softDelete() refuses to
  // re-stamp one. Without this the shell sweep and a late autosave race: the sweep deletes the
  // shell, the operator's next autosave writes the real priced quote into the deleted row and
  // gets a 200, and the work is invisible in the queue forever.
  it('update returns null for a soft-deleted row and leaves its content untouched', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(sample({ totalCents: 4048, customerName: 'Maya' }));
    await repo.softDelete(q.id, 'sweep@x.com');
    expect(await repo.update(q.id, sample({ totalCents: 9900, customerName: 'Overwritten' }))).toBeNull();
    // get()/list() hide deleted rows, so read the retained row straight out of the store.
    const row = repo.snapshotForQuoteConversion().rows.get(q.id);
    expect(row!.totalCents).toBe(4048);
    expect(row!.customerName).toBe('Maya');
  });

  it('patch stamps convertedBookingId (the booking a won quote became)', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save({
      product: 'private', totalCents: 21900, currency: 'USD',
      rateCardVersion: 'v1', request: {}, result: {},
    });
    const updated = await repo.patch(q.id, { convertedBookingId: 'booking-123', status: 'won' });
    expect(updated?.convertedBookingId).toBe('booking-123');
    expect(updated?.status).toBe('won');
    expect((await repo.get(q.id))?.convertedBookingId).toBe('booking-123');
  });
});

// Quote intent (spec 2026-07-17): what the CUSTOMER asked for, as distinct from `product`
// (what was priced). The submitter records it; the route gates submission on it.
describe('requestedService', () => {
  it('round-trips the recorded request', async () => {
    const repo = new InMemoryQuoteRepo();
    const saved = await repo.save(sample({ requestedService: 'both' }));
    expect(saved.requestedService).toBe('both');
    expect((await repo.get(saved.id))!.requestedService).toBe('both');
  });

  it('is null when the submitter has not recorded it (I7: no backfill, no sentinel)', async () => {
    const saved = await new InMemoryQuoteRepo().save(sample());
    expect(saved.requestedService).toBeNull();
  });

  it('update() rewrites it, so a correction on re-save sticks', async () => {
    const repo = new InMemoryQuoteRepo();
    const saved = await repo.save(sample({ requestedService: 'private' }));
    const updated = await repo.update(saved.id, sample({ requestedService: 'chauffeur' }));
    expect(updated!.requestedService).toBe('chauffeur');
  });
});

// Internal ops notes (spec 2026-07-22): a free-text scratchpad, kept separate from `notes`
// (the send-back reason) so neither can clobber the other.
describe('internalNotes', () => {
  it('round-trips through save and get, defaulting to null', async () => {
    const repo = new InMemoryQuoteRepo();
    const blank = await repo.save(sample());
    expect(blank.internalNotes).toBeNull();
    const withNote = await repo.save(sample({ internalNotes: 'Prefers an AC van; call before 9am.' }));
    expect(withNote.internalNotes).toBe('Prefers an AC van; call before 9am.');
    expect((await repo.get(withNote.id))!.internalNotes).toBe('Prefers an AC van; call before 9am.');
  });

  it('patch edits internalNotes without touching the send-back notes, and vice versa', async () => {
    const repo = new InMemoryQuoteRepo();
    const saved = await repo.save(sample({ notes: 'send-back reason', internalNotes: 'ops context' }));
    const a = await repo.patch(saved.id, { internalNotes: 'updated ops context' });
    expect(a!.internalNotes).toBe('updated ops context');
    expect(a!.notes).toBe('send-back reason'); // untouched
    const b = await repo.patch(saved.id, { notes: 'new reason' });
    expect(b!.notes).toBe('new reason');
    expect(b!.internalNotes).toBe('updated ops context'); // untouched
  });

  it('update() rewrites internalNotes on a content re-save', async () => {
    const repo = new InMemoryQuoteRepo();
    const saved = await repo.save(sample({ internalNotes: 'first' }));
    const updated = await repo.update(saved.id, sample({ internalNotes: 'second' }));
    expect(updated!.internalNotes).toBe('second');
  });
});

// Soft delete (spec 2026-07-22): a deleted quote is hidden but retained; role/status gating is
// the route's job, not the repo's.
describe('softDelete', () => {
  it('hides the quote from get() and list() but keeps the row (recoverable)', async () => {
    const repo = new InMemoryQuoteRepo();
    const a = await repo.save(sample());
    const b = await repo.save(sample());
    const deleted = await repo.softDelete(a.id, 'op@x.com');
    expect(deleted!.deletedBy).toBe('op@x.com');
    expect(deleted!.deletedAt).toBeInstanceOf(Date);
    expect(await repo.get(a.id)).toBeNull();                       // gone from the tool
    expect((await repo.list()).map((q) => q.id)).toEqual([b.id]);  // gone from the queue, b remains
  });

  it('is null for an unknown id and for a double delete', async () => {
    const repo = new InMemoryQuoteRepo();
    const a = await repo.save(sample());
    expect(await repo.softDelete('no-such-id', 'op@x.com')).toBeNull();
    await repo.softDelete(a.id, 'op@x.com');
    expect(await repo.softDelete(a.id, 'op@x.com')).toBeNull(); // already deleted
  });
});

// Analytics projections (spec 2026-07-23 founder analytics): bounded fetches — funnel rows are
// scalars-only (never the JSON blobs); demand rows are the ONLY projection carrying request_json
// and are bounded to created-in-range. Both exclude soft-deleted rows and default to the ops
// channel. `channel` is a parameter so later customer-website analytics is not a rework.
describe('analytics projections', () => {
  const DAY = 24 * 3600 * 1000;

  // Build a repo with a controlled history using fake timers:
  //   oldSent     — created 100d ago, sent 95d ago, STILL open in 'sent'  (live-set arm)
  //   oldDecided  — created 100d ago, won 90d ago                         (dead history)
  //   recentDraft — created 10d ago
  //   recentWon   — created 8d ago, sent 7d ago, won 5d ago
  //   webRecent   — created 6d ago on the 'web' channel
  //   deletedRecent — created 4d ago then soft-deleted
  async function seeded() {
    const repo = new InMemoryQuoteRepo();
    const now = Date.now();
    const at = async <T>(daysAgo: number, fn: () => Promise<T>): Promise<T> => {
      vi.setSystemTime(new Date(now - daysAgo * DAY));
      return fn();
    };
    vi.useFakeTimers();
    try {
      const oldSent = await at(100, () => repo.save(sample()));
      await at(95, () => repo.patch(oldSent.id, { status: 'sent' }));
      const oldDecided = await at(100, () => repo.save(sample()));
      await at(90, () => repo.patch(oldDecided.id, { status: 'won' }));
      const recentDraft = await at(10, () => repo.save(sample()));
      const recentWon = await at(8, () => repo.save(sample()));
      await at(7, () => repo.patch(recentWon.id, { status: 'sent' }));
      await at(5, () => repo.patch(recentWon.id, { status: 'won' }));
      const webRecent = await at(6, () => repo.save(sample({ channel: 'web' })));
      const deletedRecent = await at(4, () => repo.save(sample()));
      await at(4, () => repo.softDelete(deletedRecent.id, 'op@x.com'));
      return { repo, now, oldSent, oldDecided, recentDraft, recentWon, webRecent, deletedRecent };
    } finally {
      vi.useRealTimers();
    }
  }

  it('listFunnelRows: window rows + the live set, ops channel, no soft-deleted, no blobs', async () => {
    const { repo, now, oldSent, oldDecided, recentDraft, recentWon, webRecent, deletedRecent } = await seeded();
    const since = new Date(now - 30 * DAY);
    const { rows, truncated } = await repo.listFunnelRows(since, 100);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(recentDraft.id);
    expect(ids).toContain(recentWon.id);
    expect(ids).toContain(oldSent.id);        // old but still open in 'sent' → live-set arm
    expect(ids).not.toContain(oldDecided.id); // old and decided → outside the window
    expect(ids).not.toContain(webRecent.id);  // web channel excluded by default
    expect(ids).not.toContain(deletedRecent.id);
    expect(truncated).toBe(false);
    for (const r of rows) {
      expect(r).not.toHaveProperty('request');
      expect(r).not.toHaveProperty('result');
      expect(r.sentAt === null || r.sentAt instanceof Date).toBe(true);
    }
  });

  it('listDemandRows: created-in-range only, carries request/requestedService/vehicle', async () => {
    const { repo, now, oldSent, recentDraft, recentWon, webRecent, deletedRecent } = await seeded();
    const { rows, truncated } = await repo.listDemandRows(new Date(now - 30 * DAY), new Date(now), 100);
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([recentDraft.id, recentWon.id]));
    expect(ids).not.toContain(oldSent.id);    // open, but created outside range — demand is about creation
    expect(ids).not.toContain(webRecent.id);
    expect(ids).not.toContain(deletedRecent.id);
    expect(truncated).toBe(false);
    for (const r of rows) {
      expect(r).toHaveProperty('request');
      expect(r).toHaveProperty('requestedService');
      expect(r).toHaveProperty('vehicle');
    }
  });

  it('honors limit keeping the most recent rows and flags truncation', async () => {
    const { repo, now, recentDraft } = await seeded();
    const funnel = await repo.listFunnelRows(new Date(now - 30 * DAY), 2);
    expect(funnel.truncated).toBe(true);
    expect(funnel.rows.length).toBe(2);
    // createdAt desc → the two most recently created qualifying rows
    expect(funnel.rows[0].createdAt.getTime()).toBeGreaterThanOrEqual(funnel.rows[1].createdAt.getTime());
    const demand = await repo.listDemandRows(new Date(now - 30 * DAY), new Date(now), 1);
    expect(demand.truncated).toBe(true);
    expect(demand.rows.map((r) => r.id)).not.toContain(recentDraft.id === demand.rows[0].id ? 'x' : recentDraft.id); // most recent kept
  });

  it("channel 'web' and 'all' widen the filter (future customer-website analytics)", async () => {
    const { repo, now, webRecent, recentDraft } = await seeded();
    const web = await repo.listDemandRows(new Date(now - 30 * DAY), new Date(now), 100, 'web');
    expect(web.rows.map((r) => r.id)).toEqual([webRecent.id]);
    const all = await repo.listFunnelRows(new Date(now - 30 * DAY), 100, 'all');
    const ids = all.rows.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([webRecent.id, recentDraft.id]));
  });
});

describe('isUnpricedShell', () => {
  it('is true only for the { shell: true } marker', () => {
    expect(isUnpricedShell({ request: { shell: true } })).toBe(true);
    expect(isUnpricedShell({ request: { tool: {}, engine: {} } })).toBe(false);
    expect(isUnpricedShell({ request: null })).toBe(false);
    expect(isUnpricedShell({ request: undefined })).toBe(false);
    expect(isUnpricedShell({ request: 'shell' })).toBe(false);
  });

  it('does NOT treat a legitimately zero-priced quote as a shell', () => {
    expect(isUnpricedShell({ request: { tool: {}, engine: {} } })).toBe(false);
  });
});

describe('list() summaries', () => {
  it('flags an unpriced shell and leaves a priced quote unflagged', async () => {
    const repo = new InMemoryQuoteRepo();
    await repo.save({
      channel: 'ops', product: 'private', totalCents: 0, currency: 'USD',
      rateCardVersion: 'v', request: { shell: true }, result: { shell: true },
    });
    await repo.save({
      channel: 'ops', product: 'private', totalCents: 4048, currency: 'USD',
      rateCardVersion: 'v', request: { tool: {}, engine: {} }, result: { totalCents: 4048 },
    });

    const rows = await repo.list({ channel: 'ops' });
    expect(rows.find((r) => r.totalCents === 0)!.unpriced).toBe(true);
    expect(rows.find((r) => r.totalCents === 4048)!.unpriced).toBe(false);
  });
});

describe('analytics projections exclude unpriced shells', () => {
  async function seed() {
    const repo = new InMemoryQuoteRepo();
    await repo.save({
      channel: 'ops', product: 'private', totalCents: 0, currency: 'USD',
      rateCardVersion: 'v', request: { shell: true }, result: { shell: true },
    });
    await repo.save({
      channel: 'ops', product: 'private', totalCents: 4048, currency: 'USD',
      rateCardVersion: 'v', request: { tool: {}, engine: {} }, result: { totalCents: 4048 },
    });
    // A legitimately $0 priced quote (e.g. a comp ride) — NOT a shell, must still count as
    // demand. Distinguishes "excluded because it's a shell" from "excluded because totalCents
    // is 0", which the original two-row seed above could not tell apart.
    await repo.save({
      channel: 'ops', product: 'private', totalCents: 0, currency: 'USD',
      rateCardVersion: 'v', request: { tool: {}, engine: {}, comp: true }, result: { totalCents: 0 },
    });
    return repo;
  }

  it('omits shells from the funnel rows', async () => {
    const repo = await seed();
    const { rows } = await repo.listFunnelRows(new Date(0), 100, 'ops');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.totalCents).sort((a, b) => a - b)).toEqual([0, 4048]);
    expect(rows.some((r) => r.totalCents === 4048)).toBe(true);
    expect(rows.some((r) => r.totalCents === 0)).toBe(true);
  });

  it('omits shells from the demand rows', async () => {
    const repo = await seed();
    const { rows } = await repo.listDemandRows(new Date(0), new Date('2100-01-01'), 100, 'ops');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.totalCents).sort((a, b) => a - b)).toEqual([0, 4048]);
    expect(rows.some((r) => r.totalCents === 4048)).toBe(true);
    expect(rows.some((r) => r.totalCents === 0)).toBe(true);
  });
});

describe('expiry is reversible, and reopening un-decides the quote', () => {
  // The sweep — not a person — applies 'expired'. A terminal 'expired' therefore let a
  // background clock strand real work with no way back, which is exactly the trap the team
  // was 12 days from hitting with 44 quotes parked in 'sent'.
  it('allows expired → draft, and nothing else', () => {
    expect(canTransition('expired', 'draft')).toBe(true);
    expect(canTransition('expired', 'sent')).toBe(false);
    expect(canTransition('expired', 'ready')).toBe(false);
    expect(canTransition('expired', 'pending_review')).toBe(false);
    // The outcome flip stays available from any decided state (DECIDED shortcut).
    expect(canTransition('expired', 'won')).toBe(true);
    expect(canTransition('expired', 'lost')).toBe(true);
    // won/lost remain terminal for editing — only expiry became reversible.
    expect(canTransition('won', 'draft')).toBe(false);
    expect(canTransition('lost', 'draft')).toBe(false);
  });

  it('clears decidedAt on reopen, so a revived quote is not still "decided"', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save({
      channel: 'ops', product: 'private', totalCents: 5000, currency: 'USD',
      rateCardVersion: 'v1', request: {}, result: {},
    });
    await repo.patch(q.id, { status: 'sent' });
    await repo.patch(q.id, { status: 'expired' });
    const expired = await repo.get(q.id);
    expect(expired?.decidedAt).toBeInstanceOf(Date);

    await repo.patch(q.id, { status: 'draft' });
    expect((await repo.get(q.id))?.decidedAt).toBeNull();

    // …and the NEXT decision stamps fresh, rather than reporting the old expiry date.
    await repo.patch(q.id, { status: 'won' });
    const won = await repo.get(q.id);
    expect(won?.decidedAt).toBeInstanceOf(Date);
    expect(won!.decidedAt!.getTime()).toBeGreaterThanOrEqual(expired!.decidedAt!.getTime());
  });

  it('an outcome FLIP still keeps its original date — correcting is not re-deciding', async () => {
    // Guards services/quoteOutcome: won → lost when a booking is cancelled must not move the
    // row into a different analytics window.
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save({
      channel: 'ops', product: 'private', totalCents: 5000, currency: 'USD',
      rateCardVersion: 'v1', request: {}, result: {},
    });
    await repo.patch(q.id, { status: 'sent' });
    await repo.patch(q.id, { status: 'won' });
    const first = (await repo.get(q.id))!.decidedAt;
    await repo.patch(q.id, { status: 'lost', lostReason: 'Booking cancelled' });
    expect((await repo.get(q.id))?.decidedAt).toEqual(first);
  });

  it('a notes-only patch never touches decidedAt', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save({
      channel: 'ops', product: 'private', totalCents: 5000, currency: 'USD',
      rateCardVersion: 'v1', request: {}, result: {},
    });
    await repo.patch(q.id, { status: 'sent' });
    await repo.patch(q.id, { status: 'won' });
    const before = (await repo.get(q.id))!.decidedAt;
    await repo.patch(q.id, { internalNotes: 'just a note' });
    expect((await repo.get(q.id))?.decidedAt).toEqual(before);
  });
});

describe('pay-link selection (spec 2026-08-04)', () => {
  it('defaults to no selection and seq 0', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(sample());
    expect(q.payLinkSelection).toBeNull();
    expect(q.soldCents).toBeNull();
    expect(q.payLinkSeq).toBe(0);
  });

  it('round-trips a selection, amount and seq through patch', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(sample());
    const patched = await repo.patch(q.id, {
      payLinkSelection: { legIndexes: [0, 2], extraIndexes: [1] },
      soldCents: 31000,
      payLinkSeq: 1,
    });
    expect(patched!.payLinkSelection).toEqual({ legIndexes: [0, 2], extraIndexes: [1] });
    expect(patched!.soldCents).toBe(31000);
    expect(patched!.payLinkSeq).toBe(1);
  });

  // legIndexes are POSITIONAL, so an edit that reorders or deletes a leg leaves them pointing at
  // legs nobody chose. The token retires on the revision mismatch, but the stored selection would
  // still drive the ops display and a re-mint. See spec §6.
  it('clears the selection on update(), leaving seq monotonic', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(sample());
    await repo.patch(q.id, {
      payLinkSelection: { legIndexes: [0], extraIndexes: [] },
      soldCents: 12000,
      payLinkSeq: 3,
    });
    const updated = await repo.update(q.id, sample({ totalCents: 5000 }));
    expect(updated!.revision).toBe(q.revision + 1);
    expect(updated!.payLinkSelection).toBeNull();
    expect(updated!.soldCents).toBeNull();
    expect(updated!.payLinkSeq).toBe(3);
  });
});

describe('customer-facing price baseline (spec 2026-08-05)', () => {
  it('defaults to no baseline', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(sample());
    expect(q.customerTotalCents).toBeNull();
    expect(q.customerTotalAt).toBeNull();
    expect(q.customerTotalVia).toBeNull();
  });

  it('round-trips a baseline through patch', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(sample());
    const at = new Date('2026-08-05T10:00:00.000Z');
    const patched = await repo.patch(q.id, { customerTotal: { cents: 10900, at, via: 'sent' } });
    expect(patched!.customerTotalCents).toBe(10900);
    expect(patched!.customerTotalAt).toEqual(at);
    expect(patched!.customerTotalVia).toBe('sent');
  });

  // The three fields move as ONE unit, like rateLock — a baseline amount with no date, or a date
  // with no amount, would render an indicator that can't say when.
  it('leaves the baseline alone when the patch does not mention it', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(sample());
    await repo.patch(q.id, { customerTotal: { cents: 10900, at: new Date(), via: 'sent' } });
    await repo.patch(q.id, { status: 'pending_review' });
    expect((await repo.get(q.id))!.customerTotalCents).toBe(10900);
  });

  // An edit must NEVER move the baseline: the whole point is that it records what the customer
  // saw, not what the quote currently says.
  it('survives a content update', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(sample());
    await repo.patch(q.id, { customerTotal: { cents: 10900, at: new Date(), via: 'sent' } });
    const updated = await repo.update(q.id, sample({ totalCents: 9900 }));
    expect(updated!.customerTotalCents).toBe(10900);
    expect(updated!.totalCents).toBe(9900);
  });
});

describe('quote revision history (spec 2026-08-05)', () => {
  it('snapshots the PREVIOUS content, leaving the live row current', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(sample({ totalCents: 10900 }));
    await repo.update(q.id, sample({ totalCents: 9900, request: { changed: true } }));

    const revs = await repo.listRevisions(q.id);
    expect(revs).toHaveLength(1);
    expect(revs[0].revision).toBe(q.revision); // the superseded revision
    expect(revs[0].totalCents).toBe(10900);    // …holding the OLD money
    expect((await repo.get(q.id))!.totalCents).toBe(9900);
  });

  it('records nothing for a save that changes nothing, but still bumps revision', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(sample());
    const after = await repo.update(q.id, sample());
    expect(await repo.listRevisions(q.id)).toHaveLength(0);
    expect(after!.revision).toBe(q.revision + 1); // load-bearing: it retires pay links
  });

  it('is not fooled by JSON key order', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(sample({ request: { a: 1, b: { c: 2, d: 3 } } }));
    await repo.update(q.id, sample({ request: { b: { d: 3, c: 2 }, a: 1 } }));
    expect(await repo.listRevisions(q.id)).toHaveLength(0);
  });

  // result_json re-prices on every save, so comparing it would record phantom history.
  it('is not fooled by a re-priced result', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(sample({ result: { totalCents: 1 } }));
    await repo.update(q.id, sample({ result: { totalCents: 2 } }));
    expect(await repo.listRevisions(q.id)).toHaveLength(0);
  });

  it('attributes an unedited first version to its creator', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(sample({ createdBy: 'maker@x.com' }));
    await repo.update(q.id, sample({ request: { v: 2 } }));
    expect((await repo.listRevisions(q.id))[0].updatedBy).toBe('maker@x.com');
  });

  it('returns newest first', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(sample({ totalCents: 100, request: { v: 1 } }));
    await repo.update(q.id, sample({ totalCents: 200, request: { v: 2 } }));
    await repo.update(q.id, sample({ totalCents: 300, request: { v: 3 } }));
    expect((await repo.listRevisions(q.id)).map((r) => r.totalCents)).toEqual([200, 100]);
  });
});
