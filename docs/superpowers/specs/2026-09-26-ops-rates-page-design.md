# Ops Rates page — founder-set prices

**Date:** 2026-09-26 · **Status:** design agreed with the owner in chat; spec awaiting owner review
· **Read from:** `origin/main` @ `63e738c1`.

## 1. Problem

The ops tool's Rate Settings popup (quote builder → **Rates**, founder only) shows the rate card
read-only: *"Rates are fetched from the server and shown read-only. The engine is authoritative —
changes must be deployed server-side"* (`api/src/routes/ops-ui.html:9744-9763`). Every price change
today is a code change to `api/src/quote/rateCard.ts`, a regenerate, a PR and a promote.

The founder wants to reach the rates from the side menu, not from inside a quote, and to change
prices on that page.

How the card works today (`rateCard.ts:18-67`): the stored per-km and day-rate numbers are our
costs. The customer price is cost × 1.15 (`MARKUP_PCT`). Minimum fares and add-ons are final
prices. Hot zones are already stored in the database and founder-editable. `liveRateCard()`
(`api/src/quote/liveCard.ts:10-12`) adds them onto the card for every priced request.

## 2. Owner decisions (2026-09-26, chat)

1. Rate Settings becomes its own page in the ops side menu. It leaves the quote page.
2. Every price on the page becomes editable: per-km price per vehicle, driver day rate, minimum
   fares, add-ons, buffer %, deposit % and cap, and FX. These stay in code: seat and bag limits,
   idle-day km, the price-rounding rule, and shared-ride seat prices and fees.
3. **Prices are set directly, not as cost + margin %.** The owner's words: "The per KM price should
   be set not a %". Our costs stay next to each price, editable, and are used only for the margin
   figure.
4. **Hot zones are the exception.** They stay a % boost per town and move onto the page unchanged.
5. **The site picks up changes on page load.** The baked price copy fetches the live price list and
   keeps its baked numbers as the fallback. The owner chose this over "catch up on the next
   deploy". Clarity (non-bot sessions, 24–26 Sep) shows `plan.html` is the busiest page, and it
   prices only from the baked copy: plan 70 sessions, search 60, home 56, booking 48, `/trip/` 30.
6. **Edits are stored as a revision history** (who saved, when) with revert.

### 2.1 User stories

Founder:
1. I open **Rates** from the side menu, not from inside a quote.
2. I set the **price per km** for each vehicle directly.
3. I set the driver day rate, minimum fares, add-on prices, buffer % and FX. Deposit % and cap: see §6.
4. I update **our costs** and see the margin each price gives me.
5. Before saving, I **review** each change as old → new, with sample trip prices and warnings for
   big jumps or prices below cost.
6. I see **who changed what and when**, and can **revert** to any earlier version, including the
   original rates.
7. I manage **hot zones** on the same page, still as a % boost per town.

Customers:

8. New prices show across the site, including the trip planner, as soon as they are saved. No
   deploy is needed.
9. A quote that is already locked keeps its price when rates change.

Ops and finance:

10. They cannot see or change rates, costs or margins. Their quotes price with the latest rates.

## 3. Scope

### 3.1 In

- A founder-only Rates page in the side menu, holding the rate card and hot zones.
- Stored rate revisions: editable, with history and revert.
- Every server price reads the live card: ops, web estimates, bookings, the ride board, and the
  public price list.
- The baked site copy (`transfers-data.js`) loads the live price list. The plan page holds its
  prices until the list arrives.

### 3.2 Not in

- Shared-ride seat prices and fees: `departureRepo.ts` corridors/products, and `rateCard.shared`.
- Seat and bag limits, idle-day km, price finishing, currency.
- Any change to how hot zones behave.
- Access for ops or finance. The page stays founder-only, as the popup is today.
- The plan page asking the engine for each trip. That would also add hot zones to the plan page,
  which already shows unboosted prices for hot-zone towns. It is an existing gap and a separate
  job.
- `/trip/` search-engine snippets: the JSON-LD `"price"` and the FAQ text. They keep the code
  figures until the next regenerate. The fares those pages show are already live
  (`route-page-fares.js`).

## 4. Delivery: four PRs, in this order

| PR | What | Reaches prod |
|---|---|---|
| 1 | Rates page: move only, no price changes | on promote (the ops UI is served by the API) |
| 2 | Backend: migration `0057`, stored revisions, live card everywhere, public price list | on promote; the migration applies to staging on merge (PR #50 rule) |
| 3 | Site loads live prices; plan-page hold | on promote (Pages serves `production`) |
| 4 | Edit form, review, history, revert | on promote |

PR 4 ships last, so nobody can edit rates in prod before the site loads them. Until the first
revision is saved, every price stays exactly as it is today.

## 5. The Rates page (PR 1)

- **Route and access.** Route `rates` (`#rates`). A side-menu item **Rates** follows Analytics
  (`setNav`, `ops-ui.html:2331`). It is gated on `margin:view`, like today's button
  (`ops-ui.html:9557-9558`). Opening `#rates` without that capability silently bounces to the
  default landing, exactly as `#analytics` does.
- **Moved, behaviour unchanged.** The rate card (`renderRateCardBody`, `ops-ui.html:7486`) and the
  hot zones panel with its town picker (`renderHotZonesPanel`, `ops-ui.html:7652`) move onto the
  page.
- **Removed from the quote builder.** The Rates button, the popup, `ratesOpen`, and the
  `openRates`/`closeRates` actions go.
- **Unchanged in the builder.** It still loads `GET /admin/quote/rate-card` for seat limits and
  add-on prices.
- **Layout.** The page works at phone width, like Lookup and Analytics.

## 6. What's editable

Stored in USD cents. Per-km values allow two decimal places of a cent. Today's per-km prices are
not whole cents (car 35¢ × 1.15 = 40.25¢). The form shows the exact value, e.g. **$0.4025**, not
the popup's rounded $0.40, so saving an untouched field changes nothing.

| Field | Vehicles / codes | Code default today | Precision | Allowed |
|---|---|---|---|---|
| Price per km | car, van, van 9, van 14, custom | 40.25, 54.05, 54.05, 55.2, 201.25¢ | 0.01¢ | > 0, ≤ 1000¢ |
| Our cost per km | same | 35, 47, 47, 48, 175¢ | 0.01¢ | > 0, ≤ 1000¢ |
| Driver day rate | — | 3105¢ ($31.05) | 1¢ | > 0, ≤ 100000¢ |
| Our driver day cost | — | 2700¢ | 1¢ | > 0, ≤ 100000¢ |
| Minimum fare | car, van, van 9, van 14, custom | 2900, 4999, 4999, 8500, 11000¢ | 1¢ | > 0, ≤ 100000¢ |
| Add-ons (final prices) | sightseeing, safari-wait, luggage (luggage rack), front (child seat), flex (flexi ticket), waiting | 1000, 1900, 500, 800, 1200, 1000¢ | 1¢ | > 0, ≤ 50000¢ |
| Buffer | — | 10% | whole % | 0–50 |
| FX (display only; the engine stays USD) | — | 330 LKR per USD | 0.01 | > 0, ≤ 1000 |

The "Allowed" limits reject fat fingers without constraining real pricing. The owner can change
them at spec review.

**Deposit % and cap: proposed read-only (owner call, §11).** They change nothing today:

- Every booking is charged in full. This is the owner's 2026-07-07 decision (`engine.ts:171-179`).
- The ops tool shows "Pay in full to confirm" (`ops-ui.html:8111-8117`).
- `booking.js:1726` `depositDue()` is defined but never called.
- The only place the % appears is this rates page.

An editable control that changes nothing would mislead. The proposal is to show both values
read-only, labelled "not charged: bookings are paid in full".

The page shows each vehicle's margin as **(price − cost) ÷ cost**. That is the markup-on-cost the
owner set in July, so today's card reads 15% on every vehicle.

`markupPct` stays in code (15). After this change it is used only to estimate our cost when a
quote carries a hand-set $/km (`customPerKmCents`, `engine.ts:64,96`). The ops UI no longer sends
that field: there are 0 references in `ops-ui.html`.

## 7. Saving, history, revert (PR 4 UI; PR 2 API)

### 7.1 Review step

- **Edit rates** is shown to holders of `rates:manage`. It turns the page into a form.
- **Review changes** lists only the changed fields, each as old → new with the % change. It flags
  any change over 20% either way, and any price set below our cost.
- The same dialog prices four sample trips with the current and proposed rates. It runs the real
  engine at fixed distances, with no Google calls and no hot zones:
  - a 30 km car transfer
  - a 150 km car transfer
  - a 150 km van transfer
  - a 3-day car chauffeur trip of 3 × 100 km
- **Save** creates a new revision.

### 7.2 Overlapping saves

- The form remembers the version it was opened on.
- If a newer revision exists when you save, the server refuses (409). The page says who saved and
  when, and offers a reload.
- Two saves racing each other are also caught: the revision number is unique in the database.

### 7.3 History and revert

- The list is newest first. Each row shows the version, who saved it, when, and what changed from
  the one before.
- The last row is **Code defaults (2026-07-14)**.
- **Revert to this** goes through the same review step. It saves a new revision holding those
  values, marked "reverted to <version>". History is never edited or deleted.

### 7.4 When a change applies

- It applies to the next price calculated anywhere: ops estimate and save, web estimates,
  bookings, new ride-board lists, and the public price list.
- These keep their rates:
  - a quote locked before the change keeps its snapshot (`rateLock.ts:18-28`)
  - an ops quote is frozen at approval
  - a web quote stays inside its 7-day lock
  - a ride-board list keeps the seat price fixed when it was created (`seatPrice.ts` header)
- Staging and prod have separate databases. Edits on `ops.staging` do not touch prod.

## 8. Backend (PR 2)

### 8.1 Table `rate_card_revisions` (migration `0057`)

The migration is hand-written, because `drizzle-kit generate` is broken in this repo.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `seq` | integer, unique, not null | 1, 2, 3 … (the race guard) |
| `version` | text, unique, not null | `<UTC save date>.<seq>`, e.g. `2026-09-27.1` |
| `rates` | jsonb, not null | the full §6 set, validated by Zod on write and read |
| `reverted_to_version` | text, null | set by a revert; may be the code default `2026-07-14` |
| `created_by` | text, not null | staff email from the session |
| `created_at` | timestamptz, not null, default now() | |

The table is append-only: the repo has no update or delete. A field added to §6 later is read as
the code default for older rows. Before implementing, re-check that `0057` is still free: no open
PR had a migration on 2026-09-26.

### 8.2 The live card

- `liveRateCard()` builds the card as: the code card, then the newest revision's rates and
  version, then the active hot zones.
  - With no revision, it returns exactly today's card; the existing price snapshots prove it.
  - `rateCard.ts` values do not change. They become the code defaults.
- The revision is read on each request (one indexed query), like zones. No cache.
- If the read fails, the contract is unchanged:
  - ops pricing returns an error
  - bookings price off the code card, and the existing mismatch check flags them
    (`bookings.ts:330-341`)

### 8.3 Call sites

These were found by removing the `= RATE_CARD` defaults and letting the type-checker list every
caller (2026-09-26).

| Site | Today | After |
|---|---|---|
| Ops estimate / save / approve `internalQuote.ts:696`; web quote + `/quote/v2/estimate` `quote.ts:163`; bookings `bookings.ts:339` | `liveRateCard()` | unchanged; picks up revisions |
| Ride-board seat price `rideBoard.ts:553` | code card | live card |
| Ops FX `internalQuote.ts:337` | module constant | live card, per request |
| Version stamped on saved quotes `internalQuote.ts:866,942` | code version | version of the card that priced it |
| `GET /admin/quote/rate-card` `internalQuote.ts:1393` | code card | live card |
| Reopening a ready/sent quote `internalQuote.ts:548`; quote page comparison `quoteView.ts:117` | code card once a lock has expired (also misses hot zones today) | live card |
| `buildPricingPayload()` `pricingPayload.ts:40` | code card | takes a card; codegen keeps the code card |
| `scripts/pricing-health.ts` | zones only | live card incl. revision |
| Shared checkout `priceShared` `bookings.ts:694` | code card | **unchanged**: reads only `shared.extraBagCents`, which is not editable |

### 8.4 API

- `GET /admin/rates` (`margin:view`) → `{ live, defaults, history }`.
  - `live` is `{ version, source: 'revision' | 'defaults', rates, createdBy?, createdAt? }`.
  - `history` is newest first; each entry carries its `rates`.
- `POST /admin/rates` (`rates:manage` + CSRF). Body: `{ baseVersion: string | null, rates,
  revertedToVersion? }`. Returns 201 `{ revision }`, 400 for out-of-range values, 409 for stale.
- `POST /admin/rates/preview` (`rates:manage` + CSRF, no side effects). Body: `{ rates }`. Returns
  `{ samples: [{ label, currentCents, proposedCents }] }`.
- `GET /quote/pricing` (public). Returns `buildPricingPayload(liveCard)`: customer prices only,
  never costs or markup. It sends `Cache-Control: public, max-age=60`, and CORS comes from the
  global allow-list (`app.ts:321`).
- New router `routes/opsRates.ts`, mounted at `/admin/rates`, with the same pattern as
  `promoCodes.ts`: `opsIdentity`, `requireCap`, and a local CSRF check.
- New capability `rates:manage`, founder only. It is one row in the matrix (`opsAuth.ts:27-32`).
  whoami derives it through `ALL_OPS_ACTIONS`.

## 9. Site (PR 3)

- **Loader.** `transfers-data.js` fetches `${CEYLON_HOP_API}/quote/pricing` after the generated
  block. It is loaded on 8 pages: home, plan, search, booking, board, tours, tour and why.
  - It times out at about 2.5 s.
  - It is skipped with `?api=off`, or when there is no API base.
  - On a valid list it updates the copy in place: per-km, floors, buffer, day fee, deposit,
    add-ons and seat pricing. It then fires `ch:pricing` and resolves `TRANSFERS.pricingReady`
    to true.
  - On anything else (a failure, a timeout, a malformed list) it keeps the baked numbers and
    resolves to false.
- **Generator.** The generator emits reassignable bindings so the loader can update scalars. The
  baked block still comes from the code card, so the codegen parity tests are unchanged.
- **Plan page hold.** `plan.html` holds its price figures (a transparent placeholder) until
  `pricingReady` settles, at most about 2.5 s. This is the same pattern as the route pages'
  `fares-pending`. A customer never sees a price change in front of them.
- **Other pages.** Any other page that draws a copy price at first paint gets the same hold. The
  PR 3 plan audits the other seven pages; candidates are why, board and home. Pages that price from
  the engine are unaffected.
- **Offline e2e.** The offline e2e suite blocks the API, so it keeps seeing the baked numbers.

## 10. Tests (red first, per CLAUDE.md)

- **PR 1 (e2e).**
  - The founder sees Rates; ops and finance do not.
  - `#rates` bounces a non-founder.
  - The page shows the card and hot zones.
  - The builder has no Rates button or popup.
  - The hot-zone picker works on the page (`ops-hotzone-autocomplete.spec.js` moves).
  - The page works at phone width.
- **PR 2 (api).**
  - **Validation:** the §6 limits and precision, and missing fields read as defaults.
  - **Live card:** with no revision, `liveRateCard()` deep-equals today's card, and the existing
    snapshots are unchanged. With a revision, its values and version apply, and zones still apply
    on top.
  - **Repo:** in-memory and Postgres round-trip; the `seq` race gives a conflict.
  - **Access:** founder yes; ops, finance and system get 403; a signed-out caller gets 401; CSRF
    is enforced.
  - **Save errors:** out-of-range values give 400; a stale `baseVersion` gives 409. `created_by`
    comes from the session.
  - **Revert:** it creates a new revision with `reverted_to_version`.
  - **Preview:** it returns totals and persists nothing.
  - **Every §8.3 site:** after a revision, it prices with the new values.
  - **Locked quotes:** a quote locked before the change keeps its price.
  - **Public list:** `/quote/pricing` has the live values, contains no cost or markup keys, and
    sends the cache header.
  - **Capability matrix:** `rates:manage` is founder-only.
- **PR 3 (web-tests).**
  - **Loader:** it applies a list, fires `ch:pricing` and resolves true. On a failure, timeout,
    malformed list or `?api=off` it keeps the baked numbers and resolves false.
  - **Codegen parity:** unchanged.
  - **Plan page (e2e):** with a stubbed list it shows the live figure. With the API blocked it
    shows the baked figure after the hold. No figure is visible while held.
- **PR 4 (e2e).**
  - Edit → review lists only changed fields, with flags and samples → save → the new version and
    a history row appear.
  - An untouched car price saves as exactly 40.25¢.
  - A stale save shows the 409 message.
  - Revert works.
  - Ops sees no Rates item.

## 11. Needs the owner's sign-off (CLAUDE.md maintenance rules)

1. **Schema.** Migration `0057` in PR 2. It reaches staging when PR 2 merges and prod when it is
   promoted.
2. **Pricing.** Prices become database-driven. The `rateCard.ts` values are unchanged and become
   the defaults.
3. **Shared front-end component.** `transfers-data.js` and its generator, plus
   `plan.html`/`plan.js` (PR 3).
4. **Project rule text.** CLAUDE.md's drift rule "prices change ONLY via `rateCard.ts` … then
   `npm run generate`" becomes this: customer prices change on the ops Rates page; `rateCard.ts`
   holds the code defaults, and the baked site copy is generated from them as the offline fallback.
   Shared seat prices still change only in `departureRepo.ts`. This is updated in PR 2.
5. **First prod edit.** Only after PRs 2–4 are all promoted.
6. **Deposit.** Keep deposit % and cap read-only (§6), because they change nothing today, or make
   them editable as first chosen.
