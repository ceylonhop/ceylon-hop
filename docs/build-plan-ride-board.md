# Ride Board — build plan

Execution order for the Ride Board (spec: `docs/superpowers/specs/2026-07-23-ride-board-design.md`). Tiny tested steps; **one step = one branch = one PR**; TDD red→green; `cd api && npm run check` + (front-end) `npm run test:all` green before each PR. Additive only — **do not modify existing shared-taxi logic**.

## Reuse map (shared-taxi infra we hook into)

| Need | Reuse |
|---|---|
| Corridor catalogue (stops, seat price, capacity, service days) | `departureRepo.ts` `CORRIDOR_ROUTES` / `DEFAULT_CORRIDORS` / `corridorIdForRoute` / `serviceDaysForCorridor` |
| Oversell-safe pooled counter | `postgresDepartureRepo.holdSeats/releaseSeats` idiom (insert-on-conflict-do-nothing + guarded `UPDATE … WHERE seats_booked+N ≤ seats_total`) |
| Repo shape | interface + `InMemory…Repo` + `Postgres…Repo` + `seed…` at boot; optional `AppDeps` field with `?? new InMemory…` default; real wire in `server.ts` |
| Customer-safe access without login | `bookingToken.ts` HMAC capability links (dedicated secret, no expiry) → "manage my name" links |
| Dates / service days / TZ | `domain/dateRules.ts` (`isoToday`, `isPastIsoDate`, `isoWeekday`, `serviceDaysLabel`, Asia/Colombo) |
| Customer contact shape | `domain/singleTransfer.ts` `CustomerInput` |
| Money / ids / time | integer cents · uuid `defaultRandom()` · `text` ISO date/time |
| Emails | `notifications.ts` shell + senders; `notification_log` `(bookingId,kind)` unique + `onConflictDoNothing` dedupe |
| Time-based jobs | pure `(now, deps)` fns run by `POST /admin/jobs/*` (`admin:jobs` cap / `x-admin-key`), external cron; `sweepStaleSharedHolds` is the model |
| Front-end | `window.CEYLON_HOP_API` + `fetch` w/ `idempotency-key`; `transfers-data.js` `CORRIDORS`/`sharedOption`/`PLACES`; `web-tests/` Vitest + Playwright |

## Gates (must respect — CLAUDE.md rules 3, 4, 7)

- **Migration is owner-run.** Author the numbered SQL + `schema.ts` entries in the step; **do not** apply to any DB. Owner runs `npm run migrate` (staging → prod) as a labelled release. Migrations are NOT auto-applied.
- **New external services stay behind adapters + fakes.** Customer Google-token verify reuses the existing `JwtVerifier` seam; the **real OAuth client** is an owner-gated swap. The PayHere **preapproval/charging** methods are new adapter surface — build the **Fake** and the interface; the **real merchant-approved swap** (Automated Charging, Visa/MC only) is a separate owner-gated step. Tests run entirely on fakes.
- **Nothing ships to prod** without explicit owner ok. No changes to `rateCard.ts` or the `@generated:` pricing blocks (Ride Board reuses existing corridor prices; no new prices → no `npm run generate` needed).

## Data model (new tables — migration `00NN_ride_board.sql`, owner-run)

- **`ride_list`**: `id uuid PK` + `code text notNull unique` (short public code, e.g. `EM-4821`); `corridorId text → corridor.id`; `fromPlace/toPlace text notNull`; `date text notNull` (ISO); `slot text notNull` (`morning|afternoon`); `lockedTime text` (nullable, set at lock); `minSeats integer notNull`; `capacity integer notNull`; `seatPrice integer notNull` (cents, snapshot from corridor); `status text notNull default 'gathering'` (`gathering|confirmed|expired|cancelled`); `note text`; `cutoffAt timestamptz notNull`; `createdBy text` (customer sub); timestamps.
- **`ride_list_member`**: `id uuid PK`; `listId uuid → ride_list.id`; `position integer notNull`; `sub text notNull` (Google subject); `firstName text notNull`; `country text notNull`; `email text notNull`; `photoUrl text`; `preferredTime text`; `seats integer notNull default 1`; `preapprovalRef text` (adapter token id, nullable while faked); `status text notNull default 'held'` (`held|charged|charge_failed|scratched`); `manageToken`-derivable via HMAC; `joinedAt`. Unique `(listId, sub)` (one membership per traveller per list).
- Seat counter: reuse the shared-departure counter *or* count `member.status IN (held,charged)`; **decision in step 1** (prefer counting members for a single source of truth — the pooled counter is over the list, not a departure).

## Steps

### Slice 1 — backend foundation (fakes only; no external service; migration authored-not-applied)
1. **Domain** `api/src/domain/rideList.ts` — Zod: `Slot`, `RideListStatus`, `MemberStatus`, `CreateListInput` (corridorId/from/to via existing corridor resolve, date via `IsoDate`, slot, note?, minSeats/capacity derived from catalogue), `JoinInput` (firstName/country/email/photoUrl?/preferredTime?/seats). Rules: corridor resolve + past-date guard (reuse `dateRules`), cutoff = 48h before `date` 18:00 Asia/Colombo, `minSeats`/`capacity`/`seatPrice` from `DEFAULT_CORRIDORS`. Vitest.
2. **Repo** `api/src/db/rideListRepo.ts` — interface (`createList`, `getByCode`, `listOpen(filter)`, `addMember` (atomic seat guard vs `capacity`, returns null if full), `removeMember` (scratch), `setStatus`, `lockDeparture`, `dueForCutoff(now)`), + `InMemoryRideListRepo`. Vitest incl. oversell + dedupe-membership.
3. **Schema + migration + Postgres repo** — `schema.ts` entries; `api/drizzle/00NN_ride_board.sql` (+ `meta` snapshot via `db:generate`); `PostgresRideListRepo` using the guarded-UPDATE idiom for `addMember`. `seedRideBoard`? (none — lists are user/ops-created, not seeded from code; ops-seeded lists are just normal rows). **Flag migration owner-run in the PR.**
4. **DI + read endpoints** — optional `rideLists?` on `AppDeps`, `?? new InMemoryRideListRepo()` in `createApp`, real wire in `server.ts`. `routes/rideBoard.ts`: `GET /board` (open lists + filter by from-city/when) and `GET /board/:code` (public projection — first name+country+photo only, never email). Mount in `app.ts` with CORS/rate-limit like `/bookings`. Vitest via `createApp({rideLists: fake})`.

### Slice 2 — customer auth + join / scratch (fakes)
5. **Customer session** `api/src/lib/customerAuth.ts` — reuse `signSession`/`verifySession` shape with a **separate cookie `ch_cust` + secret `CUSTOMER_SESSION_SECRET`**; `POST /board/login` verifies a Google ID token via the existing `JwtVerifier` seam (fake verifier in tests), issues the cookie (identity only: sub/email/name/country/photo). No RBAC overlap with `ch_ops`.
6. **Payment seam extension** — add `preapprove(args): {ref}` + `charge({ref, amountCents, orderId}): {status}` to a **new `TokenizedPaymentAdapter`** interface (keep `PaymentAdapter` untouched); `FakeTokenizedPaymentAdapter` records calls + lets tests simulate success/failure. (Real PayHere Preapproval/Charging = owner-gated step 13.)
7. **Join** `POST /board/:code/join` — require `ch_cust`; dedupe-membership; **dedupe-list check** (if a near-identical open list exists, the FE nudges — server exposes it via `GET /board?from=&to=&date=`); `preapprove` (fake) → `addMember(status:held, preapprovalRef, preferredTime, seats)`; if this reaches `minSeats`, leave `gathering` (lock happens at cutoff, not on Nth join — decision) OR lock now (decision in step 7). Manage-link token (reuse `bookingToken` idiom w/ a member secret). Vitest.
8. **Scratch** `POST /board/:code/scratch` (or via manage token) — `removeMember`; if it drops below `minSeats` mark accordingly; release hold (fake). List-regression email is slice 3. Vitest.

### Slice 3 — create + lock/expire + emails
9. **Create** `POST /board` — require `ch_cust`; `createList` + creator auto-joins as member #1 (preapprove). Returns `code`. Vitest.
10. **Cutoff job** — pure `runRideBoardCutoff(now, {rideLists, payments, email, ...})`: for each `dueForCutoff` gathering list — if `members ≥ minSeats` → `charge` each held member (fake), `lockDeparture` (popular preferred time), `setStatus confirmed`, send confirmed emails; else `setStatus expired` + fallback-ladder email (private-split / next-shared / walk). Charge-failure → `charge_failed` + at-risk email + regression. Wire into `POST /admin/jobs/notifications` (append, like `sweepStaleSharedHolds`). Vitest over `(now, deps)`.
11. **Emails** — `notifications.ts` senders: `sendRideNameUnderYou`, `sendRideConfirmed`, `sendRideExpiredOptions`, `sendRideAtRisk`; `notification_log`-style dedupe keyed on `(listId+member, kind)` (new small log or reuse pattern). Vitest asserts `email.sent`.

### Slice 4 — front-end (port the prototype)
12. **`board.html` + `board.js`** (+ ride detail + join/create modals) — new root page following site conventions; reuse `transfers-data.js` `CORRIDORS`/`sharedOption`/`PLACES`, `window.CEYLON_HOP_API`, `idempotency-key`. Port the prototype 1:1 (guarantee, filters, scarcity, photos, dedupe nudge, preferred time, scratch-off, My rides, live countdown, share card). Real Google Sign-In button (client id via config; dev-login fallback). Cover with `web-tests/` Vitest (data/logic) + a Playwright happy-path (mocked API). No edits to existing pages except a nav link.

### Slice 5 — owner-gated real swaps (separate PRs, not shipped without owner)
13. Real Google OAuth client id/secret; real `PayHerePreapproval`/charging adapter (merchant Automated-Charging approval); ref-tracked share links + Analytics events; server-rendered per-list OG tags + dynamic OG image. Owner-run migration to prod. Go-live checklist.

## Open decisions to settle in-step (flagged, not blockers)
- Lock at Nth-join vs at-cutoff-only (step 7) → **at cutoff** by default, so a late scratch can't strand a just-charged group; revisit.
- Seat counter source: members vs shared-departure row (step 2) → **count members**.
- List-regression anti-gaming (re-join cooldown) — slice 3, minimal.
