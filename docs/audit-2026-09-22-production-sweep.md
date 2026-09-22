# Production sweep — 2026-09-22

## Status tracker

Owner said "fix the for sure issues" on 2026-09-22. This table is the record of what happened next.

> **This table rots.** A status line is a claim about code at a moment. Check the code before you
> trust a row. Where a row says FIXED it names the PR, so you can read the diff instead.

| # | Finding | Status |
|---|---|---|
| 1 | Shared seat charges for bags, records none | OPEN — needs a migration |
| 2 | Suppressed email recorded as sent, silences watchdog | OPEN |
| 3 | JSON-LD still advertises the pre-engine price | OPEN — needs an owner call (removing a price hurts rich results) |
| 4 | Homepage promises 24h free cancellation; chauffeur is 10 days | OPEN |
| 5 | Route pages offer free stops; stops are a paid add-on | OPEN |
| 6 | Email asserts a seat capacity from a flattened vehicle tier | OPEN |
| 7 | Traveller country is really the dial-code picker | OPEN — needs a design call |
| 8 | `releaseSeats` can't tell released from matched-nothing | OPEN |
| 9 | Absolute guarantees in copy ("never", "always", "reserved") | OPEN |
| 10 | Tour chauffeur prices hand-typed and drifting | UNVERIFIED — arithmetic not re-derived |

---

Five parallel read-only audits, each hunting one bug class we actually hit today.
Every finding below was **re-verified by hand against `origin/main`** before it was written down.

> **Why that mattered.** The shared working tree sits on another session's branch, 123 commits
> behind `main`. Two of the five agents audited the files on disk and led with findings that
> describe code we deleted today. Three checked `origin/main` and caught it themselves.
> Nothing in the CONFIRMED list below comes from an unverified agent claim.

---

## CONFIRMED — verified on `origin/main`

### 1. A shared seat charges for luggage and records none of it
**Same bug class as CH-6HE3V.** A fact the customer chose and paid for is not on the record.

- Charged: `api/src/services/pricing.ts:170-171` — `extraBags = max(0, bags - seats)`, billed at `$10` each.
- Recorded: `api/src/routes/bookings.ts:627-642` — the stored `input` has `fromPlace`, `toPlace`,
  `date`, `time`, `seats`, `customer`. **No `bags`.** `SharedInput` has nowhere to put it.
- The front-end does collect it and does post it (`booking.js`, `bags: state.bags`).

**Failure:** 2 seats, 5 bags, Mirissa → Colombo Airport. Charged `2 × $29.99 + 3 × $10 = $89.98`.
The confirmation email's fact rows for a shared booking are only *Seats* and *Date & time*, then
*Total paid $89.98*. **$30 of that charge cannot be explained from the row** — not by the customer,
not by ops in a refund dispute. The ops queue shows 2 travellers and no luggage, so the vehicle is
loaded for two bags.

A single transfer records `bags` and the same email prints a Luggage row. Shared is the odd one out.

---

### 2. A suppressed email is recorded as sent — which silences the alarm built to catch it
- `api/src/adapters/emailGuard.ts:83` — `drop()` returns `void`. A caller cannot tell a delivered
  message from a suppressed one.
- `api/src/routes/webhooks.ts:243` — `markSent(paid.id, 'confirmation')` runs unconditionally.
- `api/src/services/watchdog.ts:116` — `if (await log.wasSent(b.id, 'confirmation')) continue;`

So the ledger row written for an email that was never sent is **exactly** what stops the
paid-but-unconfirmed watchdog firing.

**Failure:** someone sets `NOTIFICATIONS_ENABLED=false` during an incident (its documented purpose)
and forgets to unset it, or an `EMAIL_ALLOWLIST` survives a staging refresh. From then on every
paying customer gets no confirmation, no manage link, no reminder. The webhook returns 200, the
watchdog is quiet, the digest counts nothing. First signal is a customer phoning to ask where their
booking is — **days to weeks**, and the first hypothesis will be "the mail provider is down".

---

### 3. Structured data still advertises the pre-engine price
The visible price on `/trip/` pages became engine-driven (so it includes hot zones).
**The JSON-LD did not.**

- `route-page-fares.js:56-58` updates only elements carrying `data-fare`. It never touches the
  `application/ld+json` block — verified, zero references.
- `trip/ella-to-kandy/index.html` still ships `"price":"59.99"` in structured data.

That is the exact figure from the original overcharge incident. Google's rich result, and any
aggregator reading the markup, advertise a price the checkout may not honour once a hot-zone
multiplier applies.

**Narrower than the agent claimed** (it thought the visible price was stale too — it isn't), but
it is the *advertised price of record*, which is the one that gets quoted back at you.

---

### 4. The homepage promises free cancellation at 24h; chauffeur trips are 10 days
- `index.html` — "Free cancellation up to 24h before", stated site-wide, twice.
- `about.html` — chauffeur-guide trips are free only to **10 days** before, then 80% / 60% / 40% / none.
- `api/src/services/notifications.ts:182-186` gets this right and branches on service type.

A customer books a chauffeur trip off the homepage line and cancels at five days: they expect free,
they get 60%. The email would have told them the truth; the page that sold it did not.

---

### 5. Route pages offer free stops; stops are a paid add-on
- `search.js` — "stop wherever you like along the way".
- `tools/generate-route-pages.mjs` — "tell your driver where you'd like to stop … they'll build it in"
  (generated into every `/trip/` FAQ).
- `booking.html` — "Add sightseeing stops · Up to 3 hours · **+$10**".

Read free on the landing page, charged at checkout, or argued about with the driver on the day.

---

### 6. The vehicle a customer is told they bought is a flattened guess
- `api/src/routes/quotePay.ts:306` collapses the priced tier with
  `quote.vehicle.startsWith('van') ? 'van' : 'car'`.
- `api/src/services/notifications.ts:39-41` turns that into a **capacity claim**:
  `'AC van (up to 6)'` / `'AC car (up to 3)'`.
- `quote.vehicle` stores the *requested* tier, before `engine.ts` upgrades it for capacity.

**Failure:** ops builds a transfer for 5 passengers as `car`. The engine upgrades to van and charges
the van fare. The confirmation says **"Vehicle: AC car (up to 3)"** for five travellers, and ops
dispatches off the same flattened value. A `van_14` books as "up to 6"; a `custom` coach tier fails
the `startsWith` and books as "AC car (up to 3)".

The manage page and pay page say "Van" / "Private car" without inventing a capacity. Only the email
asserts one.

---

### 7. Traveller country is really the WhatsApp dial-code picker
`booking.js` posts the phone country-code `<select>` straight into `customer.country`, defaulting to
`'Sri Lanka'` when untouched. There is no separate "where are you from" field.

A German traveller on a UK SIM is recorded as British; anyone who never opens the select is recorded
as Sri Lankan. On pay-link and ops-created bookings this value also becomes the gateway's billing
country.

---

### 8. `releaseSeats` still cannot tell "released" from "matched nothing"
`api/src/db/postgresDepartureRepo.ts:104-107` — no `RETURNING`, no row count, `Promise<void>`, and
`greatest(…, 0)` clamps an over-release into silence.

Today's fix removed the *trigger* (the key now normalises inside the repo, both sides). The
**silent-failure property remains**. The repo already has the right pattern twice —
`postgresBookingRepo` and `postgresRefundRepo` both raise on zero rows.

---

### 9. Absolute guarantees in copy
- `about.html` — "**every** Ceylon Hop vehicle is … **never** overcrowded". Unfalsifiable-proof
  wording; it is also the sentence a customer reaches for when they want a refund.
- `board.js` — "A backpack + day bag each is **always** fine." Not true for six travellers in a car.
- `tours-data.js` ×4 — "**Reserved seats** on the Ella train" listed under *includes*. Those
  reservations sell out ~30 days ahead and are outside our control, so it reads as a contractual promise.

---

## NEEDS YOUR CHECK — plausible, arithmetic not independently verified

### 10. Tour chauffeur-guide prices are hand-typed and drifting
`tours-data.js` carries `price: 520` etc., rendered as "or chauffeur-guide from $520". The agent
recomputed all seven against the engine formula and reported **5 of 7 advertised below what the
engine charges** — Classic Hop $520 advertised vs ~$589 charged, Wild Ceylon $470 vs ~$538.

It also reports the tour page's chauffeur figure does not switch car→van with party size while the
engine does, giving ~$717 charged against $520 shown at four adults.

**I did not re-derive these numbers myself.** They are worth checking before acting, because the
conclusion (advertised below charged, on the highest-value product we sell) is serious if right.
Nothing in CI references `tours-data.js` prices at all — that part I did verify.

---

## FALSE — already fixed, or never true on `main`

Two agents led with these. I checked each one; none exist on `main`:

| Claimed | Reality |
|---|---|
| Generator + trip pages still say "One van, split between you" | Fixed and promoted today |
| `bookings.ts` still offers to "run a van" | Fixed and promoted today |
| Called-off ride charges cards then emails "you were not charged" | `main` splits charged vs declined, sends a refund-due email, and raises a **critical** alert naming who to refund and how much |
| Airport copy promises a "Ceylon Hop sign" | Gone |
| Blog sells a hop-on-hop-off bus with free Wi-Fi | Gone |
| Board copy is written around a van | `board.html` clean; all 24 `board.js` hits are code comments, which the standing ops/traveller split allows |
| Three conflicting driver-detail timings | Consistent on `main` — "the evening before" everywhere |

---

## Checked and clean

- **The CH-6HE3V class itself.** `sharedRouteLabel` returns a `kind` discriminator; no caller can
  render a corridor end as a destination. `opsView` degrades to the bare corridor id, deliberately.
- **The seat-key class.** Normalisation now lives *inside* `holdSeats`/`releaseSeats` in both repo
  implementations, so no call site can forget it. All four release paths verified.
- **Key symmetry generally** — idempotency keys, alert dedupe, notification log, place resolutions,
  distance cache, promo codes, short links, ops profiles, hot-zone tokens, and the PayHere money
  round-trip all normalise both sides.
- **Generated price parity** — all 50 `/trip/` pages re-derived with zero drift, enforced by CI;
  `routes-data.js` shared prices match the catalogue exactly.
- **Deliberate swallow-and-continue** in the payment webhook is correct: money has settled, a throw
  would make PayHere retry into the idempotent path, and both catches raise deduped critical alerts.
  The alert adapter's claim-send-rollback is the model the rest should copy.

---

## The pattern worth naming

Findings 1, 6 and 7 are one shape, and it is today's bug again:

> **The customer chose something. We charged for it. We did not write it down.
> Then we displayed a guess.**

Bags, vehicle tier, country. Each is a field the request carries, the price or the record depends
on, and the stored row drops. The fix shape is the same each time: store what was sold.
