# Ride Board — go-live checklist

The Ride Board now has a real Google sign-in flow and a real PayHere Automated Charging adapter. Local tests and explicitly fake staging deployments still use fakes. This is the owner-run list for activating real money safely. Spec: `docs/superpowers/specs/2026-07-23-ride-board-design.md` · build plan: `docs/build-plan-ride-board.md`.

## 1. Database migration (owner-run)
- Migration `api/drizzle/0022_ride_board.sql` adds `ride_list` + `ride_list_member`; `0046_ride_board_payhere_preapproval.sql` adds the pending PayHere order and expiry fields.
- Migrations **auto-apply on boot** (Render / `RUN_MIGRATIONS=1`, fail-closed). So:
  - Merging `feat/ride-board` → `main` applies it to **staging** on next boot.
  - It reaches **prod only via a promote** (`main` → `production`).
- No `npm run generate` needed — the Ride Board reuses existing corridor seat prices, so no `@generated:` pricing block changes.

## 2. Secrets / env (set in Render before prod)
- `CUSTOMER_SESSION_SECRET` — **required in prod** (fail-closed at boot; the dev default is refused). A strong unique value; signs the `ch_cust` customer cookie. Distinct from `OPS_SESSION_SECRET`/`BOOKING_LINK_SECRET`.
- `GOOGLE_OAUTH_CLIENT_ID` — already used by ops sign-in. The customer login reuses it. Add the customer site origin(s) to this OAuth client's **Authorized JavaScript origins** in the Google console (e.g. `https://ceylonhop.com`, the Pages origin). If you'd rather isolate customers from staff, create a second OAuth client and thread a separate id (small change).
- Confirm `ALLOWED_ORIGINS` includes wherever `board.html` is served (it already lists the live site + Pages + local dev).
- `PAYHERE_MERCHANT_ID` / `PAYHERE_MERCHANT_SECRET` — the merchant secret must be approved for the exact top-level site domain serving `board.html`.
- `PAYHERE_APP_ID` / `PAYHERE_APP_SECRET` — API key with **Automated Charging API** permission.
- `PAYHERE_RIDE_NOTIFY_URL=https://ops.ceylonhop.com/board/payhere/notify` — public server callback dedicated to preapproval notifications.
- `PAYHERE_MODE=sandbox` for the first end-to-end run; switch to `live` only after the sandbox callback and cutoff charge both pass.
- Ask PayHere support to whitelist the production server IP for Merchant API calls. A domain allow-list alone is not sufficient for live Charging API requests.

## 3. Front-end wiring
- `board.html` reads `window.GOOGLE_CLIENT_ID` (inline placeholder). Set it to the real client id at deploy. Until set, the board still renders/browses; joins are disabled with a note.
- Add a nav link to `board.html` ("Ride board") from the site's shared header when you want it publicly discoverable.
- Cross-origin auth is already handled: the `ch_cust` cookie is `SameSite=None; Secure` and CORS allows credentials; writes are JSON (forcing a CORS preflight) so CSRF from non-allowlisted origins is blocked.

## 4. Payments — real PayHere activation (owner-gated)
- Apply for PayHere **Automated Charging (tokenization)** approval on the merchant account (Preapproval + Charging APIs; **Visa/MasterCard only**).
- Implemented: hosted preapproval form, server-generated hash, signed callback verification, pending-seat expiry/cancellation, encrypted customer-token storage, browser return polling, OAuth token caching, and Charging API calls at the cutoff.
- Production now fails closed unless the merchant credentials, Automated Charging API credentials, and dedicated Ride Board notification URL are present (or an explicitly fake non-money deployment opts out).
- Complete one sandbox journey: join → PayHere approval → signed callback → traveller appears → force cutoff → Automated Charging succeeds with the exact seat total.
- **Still required before live money:** automate refunds for the rare partial-charge case where charge failures leave fewer than the minimum seats. The cutoff service currently flags this for manual refund; do not switch the Ride Board to `PAYHERE_MODE=live` until that separate money-safety step is complete.

## 5. Scheduler
- The cutoff sweep rides the existing cron tick: `POST /admin/jobs/notifications` (external cron with `x-admin-key`) now also runs `runRideBoardCutoff`. Confirm the cron cadence is frequent enough for your cutoffs (it's the same tick that already sweeps stale holds + sends reminders).

## 6. Polish / follow-ups (not blockers)
- **OG tags for share links** — server-render per-list `<meta og:*>` on `GET /board/:code` (or a dedicated share route) + a dynamic OG image, so a shared WhatsApp/FB card shows the live route/count. The landing page already shows live state; this makes the *preview* good.
- **Privacy** — public first-name + country + Google photo on an indexable page; add a "hide my photo / initials only" choice at sign-in and confirm GDPR posture for EU travellers.
- **Analytics** — emit funnel events (list created / joined / confirmed / expired) into the founder Analytics, and add a `ref` token to share links to measure viral growth.
- **List-regression** — email when a scratch drops a list back below threshold; a re-join cooldown to prevent gaming.
- **Mobile** — the ride-detail join card is full-width on phones; a sticky bottom bar is a nice follow-up.
- **Ops seeding** — seed a few lists on the liquid corridors so the board is never empty at launch ("Ceylon Hop is gathering this one" already renders for thin lists).

## What's DONE and tested
Backend: domain + in-memory/Postgres persistence + migrations; customer session; create/join/scratch/my-rides/dedupe; pending PayHere approval; signed callback completion; cutoff charging; and fail-closed production wiring. Front end: billing capture, top-level PayHere handoff, cancellation, callback polling, and success only after server verification. Automated tests never call PayHere; sandbox verification is the remaining owner-run proof before the refund safety step and live activation.
