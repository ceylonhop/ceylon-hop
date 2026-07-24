# Ride Board — go-live checklist

The Ride Board is built **behind fakes** (Google + PayHere run on fake adapters; everything is tested green). This is the owner-run list to flip it live. Nothing here ships automatically — each is a deliberate step. Spec: `docs/superpowers/specs/2026-07-23-ride-board-design.md` · build plan: `docs/build-plan-ride-board.md`.

## 1. Database migration (owner-run)
- Migration `api/drizzle/0022_ride_board.sql` adds `ride_list` + `ride_list_member` (additive; no changes to existing tables).
- Migrations **auto-apply on boot** (Render / `RUN_MIGRATIONS=1`, fail-closed). So:
  - Merging `feat/ride-board` → `main` applies it to **staging** on next boot.
  - It reaches **prod only via a promote** (`main` → `production`).
- No `npm run generate` needed — the Ride Board reuses existing corridor seat prices, so no `@generated:` pricing block changes.

## 2. Secrets / env (set in Render before prod)
- `CUSTOMER_SESSION_SECRET` — **required in prod** (fail-closed at boot; the dev default is refused). A strong unique value; signs the `ch_cust` customer cookie. Distinct from `OPS_SESSION_SECRET`/`BOOKING_LINK_SECRET`.
- `GOOGLE_OAUTH_CLIENT_ID` — already used by ops sign-in. The customer login reuses it. Add the customer site origin(s) to this OAuth client's **Authorized JavaScript origins** in the Google console (e.g. `https://ceylonhop.com`, the Pages origin). If you'd rather isolate customers from staff, create a second OAuth client and thread a separate id (small change).
- Confirm `ALLOWED_ORIGINS` includes wherever `board.html` is served (it already lists the live site + Pages + local dev).

## 3. Front-end wiring
- `board.html` reads `window.GOOGLE_CLIENT_ID` (inline placeholder). Set it to the real client id at deploy. Until set, the board still renders/browses; joins are disabled with a note.
- Add a nav link to `board.html` ("Ride board") from the site's shared header when you want it publicly discoverable.
- Cross-origin auth is already handled: the `ch_cust` cookie is `SameSite=None; Secure` and CORS allows credentials; writes are JSON (forcing a CORS preflight) so CSRF from non-allowlisted origins is blocked.

## 4. Payments — the real PayHere swap (owner-gated; needs merchant approval)
The card side runs on `FakeTokenizedPaymentAdapter` today. To take real money:
- Apply for PayHere **Automated Charging (tokenization)** approval on the merchant account (Preapproval + Charging APIs; **Visa/MasterCard only**). Generate the App ID / App Secret.
- Implement a `PayHereTokenizedPaymentAdapter` (the real `TokenizedPaymentAdapter`): `preapprove` → PayHere Preapproval (hosted/redirect, $0 tokenization), token via server callback; `charge` → PayHere Charging API (OAuth). The front-end join step must hand off to the hosted preapproval page and resume on the callback (the current inline card fields are a fake stand-in).
- Wire it in `server.ts` in place of the fake (an env-gated selection like the other adapters).
- **Add auto-refund** for the rare "enough held, but charge failures dropped it below threshold" case flagged in `services/rideBoardCutoff.ts` — real money must be returned when a list can't run.

## 5. Scheduler
- The cutoff sweep rides the existing cron tick: `POST /admin/jobs/notifications` (external cron with `x-admin-key`) now also runs `runRideBoardCutoff`. Confirm the cron cadence is frequent enough for your cutoffs (it's the same tick that already sweeps stale holds + sends reminders).

## 6. Polish / follow-ups (not blockers)
- **OG tags for share links** — server-render per-list `<meta og:*>` on `GET /board/:code` (or a dedicated share route) + a dynamic OG image, so a shared WhatsApp/FB card shows the live route/count. The landing page already shows live state; this makes the *preview* good.
- **Privacy** — public first-name + country + Google photo on an indexable page; add a "hide my photo / initials only" choice at sign-in and confirm GDPR posture for EU travellers.
- **Analytics** — emit funnel events (list created / joined / confirmed / expired) into the founder Analytics, and add a `ref` token to share links to measure viral growth.
- **List-regression** — email when a scratch drops a list back below threshold; a re-join cooldown to prevent gaming.
- **Mobile** — the ride-detail join card is full-width on phones; a sticky bottom bar is a nice follow-up.
- **Ops seeding** — seed a few lists on the liquid corridors so the board is never empty at launch ("Ceylon Hop is gathering this one" already renders for thin lists).

## What's DONE and tested (behind fakes)
Backend Slices 1–3 (`npm run check` green): domain + repo (InMemory + Postgres) + migration; customer session; join / scratch / create / my-rides / dedupe; the cutoff charge-or-expire sweep + emails. Front-end Slice 4: `board.html` + `board.js` + web-tests. All card/auth actions run through the fakes until steps 2 & 4 above.
