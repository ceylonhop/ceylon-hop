import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import type { RideListRepo, RideListWithMembers, ListFilter } from '../db/rideListRepo';
import type { DepartureRepo } from '../db/departureRepo';
import { sharedProductFor } from '../db/departureRepo';
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
  isSeedMember,
  type RideList,
  type RideMember,
} from '../domain/rideList';
import type { EmailAdapter } from '../adapters/email';
import { sendRideJoined } from '../services/rideBoardEmails';
import { sendRideSeatHeld, type SeatHeldKind } from '../services/opsNotifications';
import { isPastIsoDate, isoToday } from '../domain/dateRules';
import type { AlertAdapter } from '../adapters/alerts';

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
const lastNameOf = (name: string): string => name.trim().split(/\s+/).slice(1).join(' ') || '-';
const PREAPPROVAL_TTL_MS = 30 * 60_000;

function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

export interface RideBoardDeps {
  rideLists: RideListRepo;
  departures: DepartureRepo; // corridor resolution + seat price
  paygw: TokenizedPaymentAdapter; // PayHere in production; a deterministic fake in automated tests
  customer: { sessionSecret: string; googleClientId: string; verifier?: JwtVerifier };
  maps: MapsAdapter; // road distance for the seat price
  memberLinkSecret: string; // "manage my name" capability token
  email: EmailAdapter; // the joiner's receipt — see sendJoinReceipt below
  currency?: string;
  allowedOrigins?: string[]; // CSRF allow-list for state-changing routes
  boardBaseUrl?: string; // browser return/cancel origin for PayHere preapproval
  alerts?: AlertAdapter; // paged when a gateway callback cannot be verified
  // Internal "seat held" mail (spec 2026-09-22). Unset → nothing internal is sent, the same
  // rule the digest follows when ALERT_EMAIL is empty.
  opsNotify?: { to: string; opsBaseUrl?: string };
}

export function rideBoardRoutes(deps: RideBoardDeps) {
  const r = new Hono();

  // A traveller who adds their name has a card preapproved against a ride that may never
  // run. Before this they were told nothing: no record of the pledge, no amount, no
  // deadline, and — once the tab closed — no route back to the page that can scratch the
  // name off again. That last part is why the receipt carries a link.
  //
  // Best-effort by design. A member reaching 'held' means the card is already approved;
  // failing the request because the mail provider blinked would cost them the seat to fix
  // nothing. It is keyed off the order id so all three routes into 'held' (create, join,
  // and PayHere's signed callback — the only one that fires in production, where preapproval
  // always redirects) send exactly one.
  async function sendJoinReceipt(orderId: string): Promise<void> {
    try {
      const found = await deps.rideLists.getByPreapprovalOrder(orderId);
      if (!found) return;
      await mailJoinReceipt(found.list, found.member);
    } catch {
      // swallowed: see above
    }
  }

  // Two mails ride this one hook: the traveller's receipt and, when an ops inbox is
  // configured, the internal "seat held" note. They are sent independently — a provider
  // rejecting one must not silence the other — and the first failure is re-thrown so the
  // callers' best-effort catches keep their meaning.
  async function mailJoinReceipt(list: RideList, member: RideMember, kind?: SeatHeldKind): Promise<void> {
    // Seeded placeholders hold a seat but have no inbox (domain/rideList.ts).
    if (isSeedMember(member) || !member.email) return;
    const outcomes = await Promise.allSettled([
      sendRideJoined(deps.email, {
        to: member.email,
        firstName: member.firstName,
        list,
        seats: member.seats,
        // The hash route board.js already uses to open one ride's detail — where the
        // "Scratch my name off" button lives.
        rideUrl: `${deps.boardBaseUrl ?? 'http://localhost:4173'}/board.html#/${list.code}`,
      }),
      // The starter is the list's creator taking their own first seat; position alone
      // cannot tell that from a joiner on a list that was created empty.
      notifyOpsSeatHeld(list, member, kind ?? (list.createdBy === member.sub ? 'started' : 'joined')),
    ]);
    const failed = outcomes.find((o): o is PromiseRejectedResult => o.status === 'rejected');
    if (failed) throw failed.reason;
  }

  async function notifyOpsSeatHeld(list: RideList, member: RideMember, kind: SeatHeldKind): Promise<void> {
    if (!deps.opsNotify?.to) return;
    // Re-read for the live seat count: `list` came from before this commitment landed.
    const fresh = await deps.rideLists.getByCode(list.code);
    const committed = committedSeats(fresh?.members ?? []);
    await sendRideSeatHeld(
      { to: deps.opsNotify.to, list: fresh?.list ?? list, member, committed, kind },
      deps.email,
      deps.opsNotify.opsBaseUrl ?? '',
    );
  }

  // Where PayHere sends the payer back. The board page is its own return page, so go back to
  // the origin the board was used from — prod.ceylonhop.com today, the apex after cutover,
  // staging on staging — rather than a configured base that goes stale (APP_BASE_URL is the
  // apex, which is still WordPress: a payer who approved a card landed on its 404). Only an
  // allow-listed origin qualifies; anything else falls back to the configured base.
  function returnBase(c: Context): string {
    const origin = c.req.header('origin');
    if (origin && (deps.allowedOrigins ?? []).includes(origin)) return origin;
    return deps.boardBaseUrl ?? 'http://localhost:4173';
  }

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

  // PayHere returns the reusable customer token only to this signed server callback. The
  // browser's return_url carries no trustworthy result and merely polls /payments/:orderId.
  r.post('/payhere/notify', async (c) => {
    const event = deps.paygw.parsePreapprovalWebhook(await c.req.text());
    if (!event) {
      // A silent 400 here is indistinguishable from "no traffic". A wrong merchant secret (the
      // PH-0014 class of failure this flow already hit once) would kill every join on the board
      // and nobody would know. /webhooks/payments pages the founder on a rejected notify; so
      // does this. Dedupe per day so a scanner cannot storm the inbox.
      void deps.alerts?.send({
        severity: 'critical',
        kind: 'ride_board_notify_rejected',
        title: 'Ride Board PayHere callback rejected',
        body:
          'A preapproval callback failed verification, so the traveller was never added to the ' +
          'ride. If this repeats, suspect the PayHere merchant secret for this domain — the ' +
          'callback is the only delivery of the reusable customer token.',
        dedupeKey: `${new Date().toISOString().slice(0, 10)}:ride_board_notify_rejected`,
      });
      return c.json({ error: 'invalid_signature' }, 400);
    }
    if (event.status === 'succeeded' && event.ref) {
      await deps.rideLists.approveMemberPreapproval(event.orderId, event.ref);
      // In production this callback IS the join — the browser only polls afterwards.
      await sendJoinReceipt(event.orderId);
    } else if (event.status === 'failed' || event.status === 'cancelled') {
      await deps.rideLists.failMemberPreapproval(event.orderId);
    }
    return c.json({ ok: true });
  });

  r.get('/payments/:orderId', requireCustomer(), async (c) => {
    const cust = c.get('customer')!;
    const found = await deps.rideLists.getByPreapprovalOrder(c.req.param('orderId'));
    if (!found || found.member.sub !== cust.sub) return c.json({ error: 'not_found' }, 404);
    if (
      found.member.status === 'preapproval_pending' &&
      (found.member.preapprovalExpiresAt?.getTime() ?? 0) <= Date.now()
    ) {
      await deps.rideLists.failMemberPreapproval(c.req.param('orderId'));
      return c.json({ status: 'failed', error: 'payment_expired' });
    }
    if (found.member.status === 'preapproval_pending') return c.json({ status: 'pending' });
    if (found.member.status === 'preapproval_failed' || found.member.status === 'scratched') {
      return c.json({ status: 'failed' });
    }
    const full = await deps.rideLists.getById(found.list.id);
    if (!full) return c.json({ error: 'not_found' }, 404);
    return c.json({
      status: 'succeeded',
      list: projectList(full, cust.sub),
      manageToken: signRideMemberToken(found.list.id, cust.sub, deps.memberLinkSecret),
    });
  });

  r.post('/payments/:orderId/cancel', requireCustomer(), async (c) => {
    const cust = c.get('customer')!;
    const found = await deps.rideLists.getByPreapprovalOrder(c.req.param('orderId'));
    if (!found || found.member.sub !== cust.sub) return c.json({ error: 'not_found' }, 404);
    if (found.member.status === 'preapproval_pending') {
      await deps.rideLists.failMemberPreapproval(c.req.param('orderId'));
    }
    return c.json({ ok: true });
  });

  // ---- reads (public) ------------------------------------------------------

  // GET /board?from=<place>&to=<place>&when=week|fortnight — open lists gathering names.
  r.get('/', async (c) => {
    const from = c.req.query('from')?.trim() || undefined;
    const to = c.req.query('to')?.trim() || undefined;
    const whenRaw = c.req.query('when');
    const when: ListFilter['when'] = whenRaw === 'week' || whenRaw === 'fortnight' ? whenRaw : 'all';
    const lists = await deps.rideLists.listOpen({ from, to, when });
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
    // A future DATE is not the same as an open ride. A list closes CUTOFF_HOURS_BEFORE its window
    // opens, so anything under two days out is born past its own cutoff: the join route 409s
    // it ('closed'), so nobody can ever add a name, and the next sweep calls it off. That is a
    // dead ride sold as a live one — seen on production (EA-8707, started 2026-09-22 for
    // 2026-09-24, closed 01:30Z that morning). Refuse it before any card is approached.
    const closesAt = cutoffAt(input.date, input.slot);
    if (closesAt.getTime() <= Date.now()) {
      return c.json(
        {
          error: 'cutoff_passed',
          message:
            'That date is too soon to gather travellers — a shared ride closes 24 hours before ' +
            'it leaves. Please pick a later date.',
        },
        400,
      );
    }

    const corridor = input.corridorId
      ? await deps.departures.getCorridor(input.corridorId)
      : await deps.departures.findCorridorByRoute(input.from!, input.to!);
    if (!corridor) return c.json({ error: 'unknown_corridor' }, 400);

    const policy = policyForCorridor(corridor.id);
    const fromPlace = input.from ?? corridor.fromPlace;
    const toPlace = input.to ?? corridor.toPlace;

    // On a leg we already sell as a scheduled seat, the board charges the SAME price. A pooled
    // van and a scheduled seat on one journey showing two different numbers is the divergence
    // this whole change exists to remove — and the catalogue price is authoritative, so there
    // is nothing to ask Google about (no distance call, and no cannot_price_route to hit).
    const product = sharedProductFor(fromPlace, toPlace);

    // A leg we sell as a scheduled seat, on a day that van runs: decline, and point at the
    // guaranteed seat. Search sends off-day travellers here to start their own ride; letting
    // one start on a SERVICE day would only split the same travellers across two half-empty
    // vans. The whole day, not just the van's slot — a traveller who can flex between 7:30am
    // and the afternoon is exactly the passenger the scheduled van needs. Date-only ISO, so
    // the weekday is the calendar day's, with no time zone to get wrong.
    if (product && corridor.serviceDays.includes(new Date(`${input.date}T00:00:00Z`).getUTCDay())) {
      return c.json({
        error: 'scheduled_day',
        scheduled: { date: input.date, time: product.time, pickup: product.pickup, seatPrice: product.seatPrice },
      }, 409);
    }

    let seatPrice: number;
    if (product) {
      seatPrice = product.seatPrice;
    } else {
      // Off-catalogue: price off the real road distance — same basis as a transfer leg, split
      // three ways. A crow-flies estimate is NOT good enough to charge against (it runs tens of
      // percent out), so if Google can't answer we decline rather than guess.
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
      seatPrice = seatPriceForDistance(distance.km);
    }
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
      cutoffAt: closesAt,
      createdBy: cust.sub,
      initialStatus: 'pending_payment',
    });
    const orderId = `RBPA-${randomUUID()}`;
    const pending = await deps.rideLists.beginMemberPreapproval(list.id, {
      sub: cust.sub,
      firstName: firstNameOf(cust.name),
      country: cust.country,
      email: cust.email,
      photoUrl: cust.photo ?? null,
      preferredTime: input.preferredTime ?? null,
      seats: input.seats ?? 1,
    }, orderId, new Date(Date.now() + PREAPPROVAL_TTL_MS));
    if (!pending) return c.json({ error: 'full' }, 409);
    let preapproval;
    try {
      preapproval = await deps.paygw.preapprove({
        customerRef: cust.sub,
        orderId,
        items: `Ceylon Hop shared ride ${fromPlace} to ${toPlace}`,
        currency: deps.currency ?? 'USD',
        returnUrl: `${returnBase(c)}/board.html?ridePayment=${encodeURIComponent(orderId)}`,
        cancelUrl: `${returnBase(c)}/board.html?ridePayment=${encodeURIComponent(orderId)}&cancelled=1`,
        customer: {
          firstName: firstNameOf(cust.name), lastName: lastNameOf(cust.name), email: cust.email,
          phone: input.payment?.phone, address: input.payment?.address, city: input.payment?.city,
          country: countryName(cust.country),
        },
      });
    } catch (error) {
      await deps.rideLists.failMemberPreapproval(orderId);
      if ((error as Error).message === 'payment_details_required') {
        return c.json({ error: 'payment_details_required' }, 400);
      }
      throw error;
    }
    if (preapproval.status === 'requires_action') {
      return c.json({ status: 'payment_required', payment: preapproval.checkout }, 202);
    }
    await deps.rideLists.approveMemberPreapproval(orderId, preapproval.ref);
    // Starting a list auto-joins you as name #1 — the same commitment, so the same receipt.
    await sendJoinReceipt(orderId);
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
    // A seat is only sellable while the cutoff sweep can still charge for it. The sweep takes
    // `status = 'gathering'` lists past their cutoff and charges the members it read at the
    // start — so admitting anyone outside that window creates a traveller who holds a seat on
    // the manifest that nothing will ever bill. Both halves matter: 'confirmed' is never
    // revisited, and a list stays 'gathering' throughout the sweep's charge loop (lockDeparture
    // writes only locked_time), by which point its member list is already snapshotted.
    if (found.list.status !== 'gathering' || found.list.cutoffAt.getTime() <= Date.now()) {
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

    const previous = found.members.find((m) => m.sub === cust.sub);
    const memberArgs = {
      sub: cust.sub,
      firstName: firstNameOf(cust.name),
      country: cust.country,
      email: cust.email,
      photoUrl: cust.photo ?? null,
      preferredTime: preferredTime ?? null,
      seats,
      preapprovalRef: previous?.preapprovalRef ?? null,
    };
    let member;
    // A live member is changing seats; a scratched member with a still-valid PayHere token is
    // rejoining. Neither needs to approve the same card again.
    if (alreadyOn || previous?.preapprovalRef) {
      member = await deps.rideLists.addMember(found.list.id, memberArgs);
      // No new card approval here, so no order id to key off. Mail only when the
      // commitment actually moved: a rejoin, or a seat count that changed. Re-sending on
      // an unchanged repeat join would make a refresh look like a second booking.
      if (member && (!alreadyOn || mine?.seats !== seats)) {
        try {
          await mailJoinReceipt(found.list, member, alreadyOn ? 'changed' : 'joined');
        } catch {
          // best-effort — see sendJoinReceipt
        }
      }
    } else {
      const orderId = `RBPA-${randomUUID()}`;
      member = await deps.rideLists.beginMemberPreapproval(
        found.list.id,
        memberArgs,
        orderId,
        new Date(Date.now() + PREAPPROVAL_TTL_MS),
      );
      if (!member) return c.json({ error: 'full' }, 409);
      let preapproval;
      try {
        preapproval = await deps.paygw.preapprove({
          customerRef: cust.sub,
          orderId,
          items: `Ceylon Hop shared ride ${found.list.fromPlace} to ${found.list.toPlace}`,
          currency: deps.currency ?? 'USD',
          returnUrl: `${returnBase(c)}/board.html?ridePayment=${encodeURIComponent(orderId)}`,
          cancelUrl: `${returnBase(c)}/board.html?ridePayment=${encodeURIComponent(orderId)}&cancelled=1`,
          customer: {
            firstName: firstNameOf(cust.name), lastName: lastNameOf(cust.name), email: cust.email,
            phone: parsed.data.payment?.phone, address: parsed.data.payment?.address,
            city: parsed.data.payment?.city, country: countryName(cust.country),
          },
        });
      } catch (error) {
        await deps.rideLists.failMemberPreapproval(orderId);
        if ((error as Error).message === 'payment_details_required') {
          return c.json({ error: 'payment_details_required' }, 400);
        }
        throw error;
      }
      if (preapproval.status === 'requires_action') {
        return c.json({ status: 'payment_required', payment: preapproval.checkout }, 202);
      }
      await deps.rideLists.approveMemberPreapproval(orderId, preapproval.ref);
      await sendJoinReceipt(orderId);
      member = (await deps.rideLists.getByPreapprovalOrder(orderId))?.member ?? null;
    }
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
