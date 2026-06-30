# Internal Quoting Tool — Build Plan

**Status: PLAN — decisions locked, awaiting build green-light. Nothing built yet.**

The ops-facing tool that turns a WhatsApp lead into a priced quote + a copy-paste reply. It is the
surface for the M11 Quote Engine. Adapted from the founder's **"Ceylon Hop Quote Generator"** design
(offline HTML, rendered + studied) — that design is the **UX target**, not gospel on the numbers
(the rates stay the locked engine rates).

Companion to the engine docs: [README](./quote-engine-README.md) · [spec](./quote-engine-spec.md) ·
[engine plan](./superpowers/plans/2026-06-28-quote-engine.md).

## Locked decisions
1. **LKR is the primary display**, with a **live-ish USD reference** beside it. The engine stays
   **USD-canonical** (rates: car $0.46/km, van $0.83/km, chauffeur $35/day, floors $29/$50); the tool
   **converts to LKR** for display using a manually-set FX rate.
2. **FX = a manually-set `USD→LKR` rate** in config, updated occasionally (no live API in v1).
3. **Chauffeur = one toggle** per date ("Keep car + driver") → applies our **$35/day + idle-km
   minimum**. (Merges the design's two switches; no separate accommodation line.)
4. **Buffer = flat 10%** on **travel km only** (NOT chauffeur idle-min km — per issue I1), surfaced as `distance → +10% buffer → billable`.
5. **Stateless v1** — no Save / lead-lifecycle / Notion persistence yet.
6. **Per-leg Sightseeing + Waiting fees shown.** Extras (cents): sightseeing `1000`, **waiting `1000`
   (new)**, safari-wait `1900`, luggage `500`, child seat `800`, flexi `1200`.

## Architecture
A thin route + one single-page UI, both in the existing `api/` app — **not** a separate deploy, **not**
a tab in the (post-payment) ops dashboard. Reuses the engine (`quote()` in-process), the maps adapter
(distance), and `opsAuth` (the route is already an authed ops surface, so it reads `marginEstimateCents`
directly — no `x-internal-key` needed).

## Prerequisite — the engine
Engine **Tasks 1–9** (the engine plan) must merge first: `quote()` + `POST /quote`, golden-tested. The
tool cannot be correct against today's placeholder `pricing.ts`.

---

## Phase 0 — Engine superset tweaks (TDD; fold into the engine plan / rate card)

1. **Buffer.** Add `RATE_CARD.bufferPct = 10`. Apply per leg: `legBillableKm = round(legKm × 1.10)`,
   then price off that (`max(floor, legBillableKm × rate)`). **For chauffeur, buffer applies to travel
   km only — idle-day minimum km are NOT buffered (issue I1, resolved).** Add **new** `bufferKm` +
   `billableKm` fields to the engine result (the base plan only puts `distanceKm` in `meta` — issue I10) so
   the summary can show the `400 → +40 → 440` breakdown. Golden tests updated for the +10%.
2. **Waiting extra.** Add `waiting: 1000` to `RATE_CARD.extras` + the `ExtraCode` union + a label.
3. **FX config.** Add `RATE_CARD.fxUsdToLkr` (a number, manually maintained). The **engine stays
   USD**; conversion is a tool/route concern (`lkr = round(usdCents × fx / 100)`), so the engine and
   its golden tests are unchanged by FX.
4. Chauffeur needs **no** change — one "Keep car + driver" toggle maps to a travel/idle day at
   $35/day + idle-km, which the engine already does.

## Phase 1 — Tool API (orchestration, behind ops auth)

1. **First extract a reusable ops-auth middleware** (issue I11): `opsAuth.ts` only exports pure
   functions today — the cookie/key check is inline in `ops.ts`. Pull it into `requireOps(auth)` (auth =
   `{ supportKey, founderKey, sessionSecret, adminApiKey }`) and refactor `ops.ts` to use it. Then mount
   new `api/src/routes/internalQuote.ts` at `/admin/quote` behind `requireOps`.
2. `POST /admin/quote/estimate` — body: `{ customer: {name, pax, bags, vehicle}, legs: [{ type,
   from, to, stops?, date, overrideKm?, keepCarDriver?, sightseeing?, waiting?, safariWait? }] }`.
3. For each leg without `overrideKm`, call `maps.distance(from,to)`; assemble the `QuoteRequest`; call
   `quote()`. **Mapping rule (issue I12):** one engine call takes one product. If **any** leg is marked
   "keep car + driver", the whole trip is **one chauffeur request** (its travel days + idle days);
   otherwise it's **N independent private legs**. (Mixed within a single request is not representable.)
4. Convert to **LKR (primary) + USD (reference)** via `fxUsdToLkr`.
5. Build the drafted **WhatsApp / Email / Notion** text from `result.lineItems`.
6. Respond `{ result, lkr, usd, perLegDistances:[{from,to,usedKm,source}], drafts }`. **422** on
   missing distance (no override + adapter null), `TOO_BIG`, `UNKNOWN_EXTRA`, `NO_LEGS`.
7. Tests per branch (distance override, missing-distance 422, chauffeur toggle, extras).

## Phase 2 — Tool UI (single page, matching the design)

Static page at `GET /admin/quote`, cream/teal/serif brand. Build the six sections:
1. **① Customer & Request** — name, pax, bags, vehicle (Car / Van), internal notes.
2. **② Rate Settings** — read-only view of the rate card + buffer % + FX rate (admin editing deferred).
3. **③ Itinerary timeline** — typed legs (Transfer / Stay day / Train-luggage / Sightseeing-waiting /
   Safari waiting / Airport), FROM→DEST + stop chips, date, **editable distance** (pre-filled from the
   adapter, source-labelled), **"Keep car + driver"** toggle, **Sightseeing / Waiting** checkboxes,
   leg price.
4. **④ Pricing Summary** — `distance → +10% buffer → billable`, cost build-up, markup 25%, **big LKR
   total + USD reference**, est. margin, and the per-leg-rounding reconciliation note.
5. **⑤ Operational Flags** — rendered from `result.warnings` (van-minimum applied, confirm stopover).
6. **⑥ Quote Output** — LKR/USD toggle, WhatsApp / Email / Notion tabs, **Copy** button.
7. Wire to `/admin/quote/estimate`; verify against this week's real quotes (Nikhil, Lisa, the 10-day
   chauffeur trip) — numbers must match the hand-calcs.

## Phase 3 — Option comparisons
The side-by-sides done by hand: **car-vs-van** and **chauffeur-vs-separate-transfers** — built as
2–3 `quote()` calls on request variants, rendered as columns (engine unchanged).

## Deferred (later)
Save + lead lifecycle (Draft → Ready → Sent → Booked → Lost) + Notion persistence · admin rate-card
editing · **live** FX auto-refresh · remembered-distances table · pushing the tool's pricing into the
customer website booking flow (the engine's separate website-display follow-up).

## Out of scope
No WhatsApp **sending** (copy-paste only) · no payment links / charging · no Notion **writes** · no
vehicles bigger than van (engine `TOO_BIG` → "handle manually") · no persistence in v1 · not part of
the post-payment ops fulfilment lifecycle.
