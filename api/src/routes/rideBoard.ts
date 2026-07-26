import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { RideListRepo, RideListWithMembers, ListFilter } from '../db/rideListRepo';
import type { DepartureRepo } from '../db/departureRepo';
import type { TokenizedPaymentAdapter } from '../adapters/tokenizedPayments';
import type { JwtVerifier } from '../lib/googleAuth';
import type { MapsAdapter } from '../adapters/maps';
import { seatPriceForDistance } from '../quote/seatPrice';
import { logEvent } from '../observability/events';
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
  seats: number;
  isStarter: boolean;
  isYou: boolean;
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
// viewerSub, when given, marks the viewer's own row so the page can offer to change
// their seats; it never leaks anyone else's identity.
export function projectList({ list, members }: RideListWithMembers, viewerSub?: string): PublicList {
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
        seats: m.seats,
        isStarter: m.position === 1,
        isYou: viewerSub != null && m.sub === viewerSub,
      })),
  };
}

const firstNameOf = (name: string): string => name.trim().split(/\s+/)[0] || name;

export interface RideBoardDeps {
  rideLists: RideListRepo;
  departures: DepartureRepo; // corridor resolution + seat price
  paygw: TokenizedPaymentAdapter; // card-on-file preapproval (fake until owner swaps in PayHere)
  customer: { sessionSecret: string; googleClientId: string; verifier?: JwtVerifier };
  maps: MapsAdapter; // road distance for the seat price
  memberLinkSecret: string; // "manage my name" capability token
  currency?: string;
  allowedOrigins?: string[]; // CSRF allow-list for state-changing routes
}

export function rideBoardRoutes(deps: RideBoardDeps) {
  const r = new Hono();

  // Populate c.var.customer from the ch_cust cookie on every request (never throws).
  r.use('*', customerIdentity(deps.customer.sessionSecret));

  // CSRF. The ch_cust cookie is SameSite=None (board.html on Pages calls the API on Render), so
  // unlike the ops cookie it DOES ride cross-site requests. The comment on setCustomerCookie
  // reasons that JSON-only bodies force a CORS preflight — but that does not hold for a route
  // which reads no body at all: a bodyless cross-site POST is a "simple request", sends no
  // preflight, and carried the cookie. That let any page silently scratch a signed-in traveller
  // off their ride list. Checked here rather than per-route so a new write can't miss it.
  // Note the ops guard's same-origin rule is wrong for the board, which is cross-origin BY
  // DESIGN — the allow-list is what distinguishes our own site from an attacker's.
  const sameOrigin: MiddlewareHandler = async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') return next();
    const origin = c.req.header('origin');
    // A browser always sends Origin on a cross-origin POST, so a missing one means a non-browser
    // caller (curl, a monitor) that has no ambient cookie to abuse.
    if (origin && !(deps.allowedOrigins ?? []).includes(origin)) {
      return c.json({ error: 'bad_origin' }, 403);
    }
    return next();
  };
  r.use('*', sameOrigin);

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
    const viewer = c.get('customer')?.sub;
    return c.json({ lists: lists.map((l) => projectList(l, viewer)) });
  });

  // GET /board/mine — the signed-in traveller's lists. Registered before /:code.
  r.get('/mine', requireCustomer(), async (c) => {
    const cust = c.get('customer')!;
    const lists = await deps.rideLists.listForMember(cust.sub);
    return c.json({ lists: lists.map((l) => projectList(l, cust.sub)) });
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

    // Seat price comes from the engine, off the real road distance — same basis as a transfer
    // leg, split three ways. A crow-flies estimate is NOT good enough to charge against (it runs
    // tens of percent out), so if Google can't answer we decline rather than guess.
    let distance = null;
    try {
      distance = await deps.maps.distance(fromPlace, toPlace);
    } catch {
      distance = null;
    }
    if (!distance || distance.estimated) {
      return c.json(
        {
          error: 'cannot_price_route',
          message: "We couldn't work out the distance for that route just now — please try again in a moment.",
        },
        503,
      );
    }
    const seatPrice = seatPriceForDistance(distance.km);
    const list = await deps.rideLists.createList({
      corridorId: corridor.id,
      fromPlace,
      toPlace,
      date: input.date,
      slot: input.slot,
      minSeats: policy.minSeats,
      capacity: policy.capacity,
      seatPrice,
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
    logEvent('ride_board.list_created', {
      code: list.code, corridorId: list.corridorId, date: list.date, slot: list.slot,
      seatPrice: list.seatPrice, minSeats: list.minSeats, capacity: list.capacity,
    });
    return c.json(
      { list: projectList(fresh!, cust.sub), manageToken: signRideMemberToken(list.id, cust.sub, deps.memberLinkSecret) },
      201,
    );
  });

  // POST /board/:code/join { preferredTime?, seats? }
  r.post('/:code/join', requireCustomer(), async (c) => {
    const cust = c.get('customer')!;
    const parsed = JoinInput.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const { preferredTime } = parsed.data;

    const found = await deps.rideLists.getByCode(c.req.param('code'));
    if (!found) return c.json({ error: 'not_found' }, 404);
    if (found.list.status !== 'gathering' && found.list.status !== 'confirmed') {
      return c.json({ error: 'closed' }, 409);
    }
    // Already a live member? Then this is a seat change, not a second join: the card stays
    // held once, and an omitted seat count means "leave mine as they are".
    const mine = found.members.find(
      (m) => m.sub === cust.sub && (m.status === 'held' || m.status === 'charged'),
    );
    const alreadyOn = Boolean(mine);
    const seats = parsed.data.seats ?? mine?.seats ?? 1;
    // Capacity is checked net of the seats this traveller already holds — counting their own
    // seats twice would refuse a 1→2 change on a van that plainly has room for it.
    const othersSeats = committedSeats(found.members.filter((m) => m.sub !== cust.sub));
    if (othersSeats + seats > found.list.capacity) {
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
    const committed = committedSeats(fresh?.members ?? []);
    logEvent('ride_board.join', {
      code: found.list.code, corridorId: found.list.corridorId, date: found.list.date,
      seats, committed, minSeats: found.list.minSeats, capacity: found.list.capacity,
      // the moment a van becomes viable — the number the funnel is really about
      reachedThreshold: committed >= found.list.minSeats,
    });
    return c.json({
      list: projectList(fresh!, cust.sub),
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
    const left = committedSeats(fresh?.members ?? []);
    if (removed) {
      logEvent('ride_board.scratch', {
        code: found.list.code, corridorId: found.list.corridorId, date: found.list.date,
        committed: left, minSeats: found.list.minSeats,
        // the expensive churn: a scratch that took a viable van back below the line
        brokeThreshold: left < found.list.minSeats,
      });
    }
    return c.json({ removed, list: projectList(fresh!, cust?.sub) });
  });

  // GET /board/:code — one list's public detail (share-link destination). Last (catch-all).
  r.get('/:code', async (c) => {
    const found = await deps.rideLists.getByCode(c.req.param('code'));
    if (!found) return c.json({ error: 'not_found' }, 404);
    return c.json(projectList(found, c.get('customer')?.sub));
  });

  return r;
}
