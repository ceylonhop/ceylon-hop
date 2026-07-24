import { Hono } from 'hono';
import type { RideListRepo, RideListWithMembers, ListFilter } from '../db/rideListRepo';
import type { DepartureRepo } from '../db/departureRepo';
import type { TokenizedPaymentAdapter } from '../adapters/tokenizedPayments';
import type { JwtVerifier } from '../lib/googleAuth';
import { verifyGoogleIdToken } from '../lib/googleAuth';
import {
  customerIdentity,
  requireCustomer,
  issueCustomerCookie,
  clearCustomerCookie,
  signRideMemberToken,
  verifyRideMemberToken,
} from '../lib/customerAuth';
import {
  CreateListInput,
  JoinInput,
  cutoffAt,
  policyForCorridor,
  committedSeats,
} from '../domain/rideList';
import { isPastIsoDate, isoToday } from '../domain/dateRules';

// ============================================================================
// Ride Board routes — public reads + customer-authenticated writes.
// Reads return a customer-safe projection only (first name + country + photo,
// never email/sub/preapproval). Writes require the ch_cust session; the card
// side runs entirely through the tokenized-payment FAKE (no real gateway).
// ============================================================================

interface PublicMember {
  position: number;
  firstName: string;
  country: string;
  photoUrl: string | null;
  isStarter: boolean;
}

interface PublicList {
  code: string;
  corridorId: string;
  from: string;
  to: string;
  date: string;
  slot: string;
  lockedTime: string | null;
  minSeats: number;
  capacity: number;
  seatPrice: number; // minor units
  status: string;
  note: string | null;
  cutoffAt: string; // ISO
  committed: number; // live seats
  members: PublicMember[];
}

// The single place a list becomes public data — nothing sensitive leaves here.
export function projectList({ list, members }: RideListWithMembers): PublicList {
  const live = members.filter((m) => m.status === 'held' || m.status === 'charged');
  return {
    code: list.code,
    corridorId: list.corridorId,
    from: list.fromPlace,
    to: list.toPlace,
    date: list.date,
    slot: list.slot,
    lockedTime: list.lockedTime,
    minSeats: list.minSeats,
    capacity: list.capacity,
    seatPrice: list.seatPrice,
    status: list.status,
    note: list.note,
    cutoffAt: list.cutoffAt.toISOString(),
    committed: committedSeats(members),
    members: live
      .sort((a, b) => a.position - b.position)
      .map((m) => ({
        position: m.position,
        firstName: m.firstName,
        country: m.country,
        photoUrl: m.photoUrl,
        isStarter: m.position === 1,
      })),
  };
}

const firstNameOf = (name: string): string => name.trim().split(/\s+/)[0] || name;

export interface RideBoardDeps {
  rideLists: RideListRepo;
  departures: DepartureRepo; // corridor resolution + seat price
  paygw: TokenizedPaymentAdapter; // card-on-file preapproval (fake until owner swaps in PayHere)
  customer: { sessionSecret: string; googleClientId: string; verifier?: JwtVerifier };
  memberLinkSecret: string; // "manage my name" capability token
  currency?: string;
}

export function rideBoardRoutes(deps: RideBoardDeps) {
  const r = new Hono();

  // Populate c.var.customer from the ch_cust cookie on every request (never throws).
  r.use('*', customerIdentity(deps.customer.sessionSecret));

  // ---- auth ----------------------------------------------------------------

  // POST /board/login { credential: <google id token>, country?: 'FR' }
  r.post('/login', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { credential?: unknown; country?: unknown } | null;
    const credential = body?.credential;
    const country = typeof body?.country === 'string' ? body.country.trim().slice(0, 4).toUpperCase() : '';
    if (typeof credential !== 'string' || !credential) return c.json({ error: 'missing_credential' }, 400);
    let id;
    try {
      id = await verifyGoogleIdToken(credential, {
        clientId: deps.customer.googleClientId,
        verifier: deps.customer.verifier,
      });
    } catch {
      return c.json({ error: 'invalid_credential' }, 401);
    }
    if (!id.sub) return c.json({ error: 'invalid_credential' }, 401);
    const name = id.name ?? id.email.split('@')[0];
    const session = {
      sub: id.sub,
      email: id.email,
      name,
      country: country || 'XX',
      ...(id.picture ? { photo: id.picture } : {}),
    };
    issueCustomerCookie(c, session, deps.customer.sessionSecret, Date.now());
    return c.json({ ok: true, me: { firstName: firstNameOf(name), country: session.country, photo: id.picture ?? null } });
  });

  r.post('/logout', async (c) => {
    clearCustomerCookie(c);
    return c.json({ ok: true });
  });

  // GET /board/me — who am I (or null). The FE uses this to decide login vs join.
  r.get('/me', async (c) => {
    const cust = c.get('customer');
    if (!cust) return c.json({ me: null });
    return c.json({ me: { firstName: firstNameOf(cust.name), country: cust.country, photo: cust.photo ?? null } });
  });

  // ---- reads (public) ------------------------------------------------------

  // GET /board?from=<place>&when=week|fortnight — open lists gathering names.
  r.get('/', async (c) => {
    const from = c.req.query('from')?.trim() || undefined;
    const whenRaw = c.req.query('when');
    const when: ListFilter['when'] = whenRaw === 'week' || whenRaw === 'fortnight' ? whenRaw : 'all';
    const lists = await deps.rideLists.listOpen({ from, when });
    return c.json({ lists: lists.map(projectList) });
  });

  // GET /board/mine — the signed-in traveller's lists. Registered before /:code.
  r.get('/mine', requireCustomer(), async (c) => {
    const cust = c.get('customer')!;
    const lists = await deps.rideLists.listForMember(cust.sub);
    return c.json({ lists: lists.map(projectList) });
  });

  // GET /board/dupe?from=&to=&date= — the dedupe nudge for the create flow.
  r.get('/dupe', async (c) => {
    const from = c.req.query('from');
    const to = c.req.query('to');
    const date = c.req.query('date') || undefined;
    if (!from || !to) return c.json({ list: null });
    const dup = await deps.rideLists.findOpenByRoute(from, to, date);
    if (!dup) return c.json({ list: null });
    const full = await deps.rideLists.getById(dup.id);
    return c.json({ list: full ? projectList(full) : null });
  });

  // ---- writes (customer session) ------------------------------------------

  // POST /board — start a new list; the creator auto-joins as name #1.
  r.post('/', requireCustomer(), async (c) => {
    const cust = c.get('customer')!;
    const parsed = CreateListInput.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const input = parsed.data;
    if (isPastIsoDate(input.date, isoToday())) return c.json({ error: 'date_in_past' }, 400);

    const corridor = input.corridorId
      ? await deps.departures.getCorridor(input.corridorId)
      : await deps.departures.findCorridorByRoute(input.from!, input.to!);
    if (!corridor) return c.json({ error: 'unknown_corridor' }, 400);

    const policy = policyForCorridor(corridor.id);
    const fromPlace = input.from ?? corridor.fromPlace;
    const toPlace = input.to ?? corridor.toPlace;
    const list = await deps.rideLists.createList({
      corridorId: corridor.id,
      fromPlace,
      toPlace,
      date: input.date,
      slot: input.slot,
      minSeats: policy.minSeats,
      capacity: policy.capacity,
      seatPrice: corridor.seatPrice,
      note: input.note ?? null,
      cutoffAt: cutoffAt(input.date, input.slot),
      createdBy: cust.sub,
    });
    const { ref } = await deps.paygw.preapprove({
      customerRef: cust.sub,
      customer: { firstName: firstNameOf(cust.name), email: cust.email, country: cust.country },
    });
    await deps.rideLists.addMember(list.id, {
      sub: cust.sub,
      firstName: firstNameOf(cust.name),
      country: cust.country,
      email: cust.email,
      photoUrl: cust.photo ?? null,
      preferredTime: input.preferredTime ?? null,
      seats: input.seats ?? 1,
      preapprovalRef: ref,
    });
    const fresh = await deps.rideLists.getByCode(list.code);
    return c.json(
      { list: projectList(fresh!), manageToken: signRideMemberToken(list.id, cust.sub, deps.memberLinkSecret) },
      201,
    );
  });

  // POST /board/:code/join { preferredTime?, seats? }
  r.post('/:code/join', requireCustomer(), async (c) => {
    const cust = c.get('customer')!;
    const parsed = JoinInput.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const { preferredTime, seats } = parsed.data;

    const found = await deps.rideLists.getByCode(c.req.param('code'));
    if (!found) return c.json({ error: 'not_found' }, 404);
    if (found.list.status !== 'gathering' && found.list.status !== 'confirmed') {
      return c.json({ error: 'closed' }, 409);
    }
    // Already a live member? Idempotent — return the current list, no extra preapproval.
    const alreadyOn = found.members.some(
      (m) => m.sub === cust.sub && (m.status === 'held' || m.status === 'charged'),
    );
    if (!alreadyOn && committedSeats(found.members) + seats > found.list.capacity) {
      return c.json({ error: 'full' }, 409);
    }

    let ref: string | null = null;
    if (!alreadyOn) {
      ref = (
        await deps.paygw.preapprove({
          customerRef: cust.sub,
          customer: { firstName: firstNameOf(cust.name), email: cust.email, country: cust.country },
        })
      ).ref;
    }
    const member = await deps.rideLists.addMember(found.list.id, {
      sub: cust.sub,
      firstName: firstNameOf(cust.name),
      country: cust.country,
      email: cust.email,
      photoUrl: cust.photo ?? null,
      preferredTime: preferredTime ?? null,
      seats,
      preapprovalRef: ref,
    });
    if (!member) return c.json({ error: 'full' }, 409);
    const fresh = await deps.rideLists.getByCode(c.req.param('code'));
    return c.json({
      list: projectList(fresh!),
      manageToken: signRideMemberToken(found.list.id, cust.sub, deps.memberLinkSecret),
    });
  });

  // POST /board/:code/scratch  (signed-in customer, or ?t=<manage token>)
  r.post('/:code/scratch', async (c) => {
    const found = await deps.rideLists.getByCode(c.req.param('code'));
    if (!found) return c.json({ error: 'not_found' }, 404);

    const cust = c.get('customer');
    let sub: string | null = cust?.sub ?? null;
    if (!sub) {
      const tok = verifyRideMemberToken(c.req.query('t'), deps.memberLinkSecret);
      if (tok && tok.listId === found.list.id) sub = tok.sub;
    }
    if (!sub) return c.json({ error: 'sign_in_required' }, 401);
    // Once the van is locked (confirmed) the charge is committed — no self-scratch.
    if (found.list.status !== 'gathering') return c.json({ error: 'locked' }, 409);

    const removed = await deps.rideLists.removeMember(found.list.id, sub);
    const fresh = await deps.rideLists.getByCode(c.req.param('code'));
    return c.json({ removed, list: projectList(fresh!) });
  });

  // GET /board/:code — one list's public detail (share-link destination). Last (catch-all).
  r.get('/:code', async (c) => {
    const found = await deps.rideLists.getByCode(c.req.param('code'));
    if (!found) return c.json({ error: 'not_found' }, 404);
    return c.json(projectList(found));
  });

  return r;
}
