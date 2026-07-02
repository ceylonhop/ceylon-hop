# M11 — Quote Engine · Read Me First

_Last reconciled: 2026-06-28. This is the index for the Quote Engine documents. Start here._

The Quote Engine is the **one place pricing lives** — a server-authoritative calculator that turns a
trip into a priced quote. It is *designed* to serve the website, an internal WhatsApp quoting tool,
the ops dashboard, and booking-time anti-tamper validation. **The first increment ships only the
engine + `POST /quote`** — none of those surfaces are wired yet (the website still prices with its
frozen formula).

## The documents (this README is the index)

| Doc | What it is | Read it to… |
|---|---|---|
| **[quote-engine-worked-examples.md](./quote-engine-worked-examples.md)** | **Validation evidence** — the rate card narrative + every real WhatsApp/Notion quote run through the engine, with approximate distances. **Not the canonical price source.** | Sanity-check the *approach* against reality; share with ops. |
| **[quote-engine-spec.md](./quote-engine-spec.md)** | The **engineering design**: types, rate-card module, pricing logic, API, anti-tamper, versioning. | Understand *how* it's built. |
| **[superpowers/plans/2026-06-28-quote-engine.md](./superpowers/plans/2026-06-28-quote-engine.md)** | The **engine build plan**: bite-sized TDD tasks 1–9 + buffer/waiting/FX tasks 10–14. | See exactly what gets coded, step by step. |
| **[internal-quoting-tool-plan.md](./internal-quoting-tool-plan.md)** | The **ops quoting-tool** plan, adapted from the founder's Quote Generator design (the UX target). | See the tool that sits on the engine. |
| **[quote-engine-issues.md](./quote-engine-issues.md)** | **Issues log** — open decisions + things to revisit (I1 buffer/idle-min resolved; FX rate value + shared model still open). | Check what's unresolved before building. |

**Canonical source of prices = code, not docs.** The rates live in `api/src/quote/rateCard.ts`
(per-km, day, floors, deposit, extras, markup) and the **corridor repo** (shared seat prices), both
PR-reviewed and golden-tested. The worked-examples doc is *evidence*, with hand-estimated distances
and "team actual" numbers that intentionally differ — **never read a price out of it as authoritative.**

## The locked rate card (v1)

| | Sell price (incl. 25% markup) |
|---|---|
| Car per-km | **$0.46/km** (cost $0.368) |
| Van per-km (≤6 pax) | **$0.83/km** (cost $0.66) |
| Chauffeur day rate | **$35/day** (cost $28) |
| Minimum private transfer | **$29 car · $50 van** |
| Idle (no-travel) day | **$35 + 100 km car / 150 km van** at the per-km rate |
| Shared | **seat price × seats** (seat price from the corridor repo) |
| Deposit | **min(10% × total, $50)** |
| Extras | sightseeing $10 · **waiting $10** · safari-wait $19 · luggage $5 · child seat $8 · flexi $12 |
| Web vehicles | **Car + Van only** (bigger → internal tool) |
| Markup | **25%** — one config value; every quote reports its margin |
| Distance buffer | **+10%** on travel km (**not** chauffeur idle-min km — issue I1 resolved) |
| FX (display) | manual **USD→LKR** rate; engine stays USD-canonical |

## Decisions already made (no action needed)

- **Pricing = cost × (1 + 25% markup).** All sell prices above already include it.
- **Idle-day minimum kept as-is** — chauffeur quotes deliberately run ~15–30% above old hand-quotes (you charge for holding the car).
- **$29/$50 floors** confirmed from recent Notion quotes.
- **Van = $0.83/km** confirmed from a real van quote.
- **Engine = source of truth (Option A)** — the website will *display* the engine's price.
- **Sequencing (after architecture review):** ship the engine + `POST /quote` first (no charge change); the website must *display* the engine price **before** the engine ever becomes the booking charge authority. Charging a customer a number they didn't see is off the table.
- **Money = integer cents**, shared seat prices stay in the corridor repo, distances supplied by the caller.

## Open decisions — your call

**You're providing later (gates only the shared path; the rest of the engine is unaffected):**
- **Shared pricing model + seat values.** Is shared priced **per-corridor** (one flat price) or
  **per-leg-pair**? Today the corridor repo holds one price per corridor and *can't* express the
  per-leg prices the evidence shows (Negombo→Sigiriya $19 and Sigiriya→Kandy $17 are the *same*
  corridor). Plus the canonical seat prices, and flat vs tiered (Anna $19.50/$17.50/$16.50). The
  `quoteSharedLegs` function is correct regardless; this decision governs where its `seatPriceCents`
  comes from at integration time.

**Nice-to-have, none block the first build:**
1. **Island Loop passes** — fixed prices (6-stop $119 · 9-stop $149 · 5-stop $105 · +Arugam Bay premium) as named products.
2. **Manual discount/override field** — for competitive/loyalty quotes (e.g. Pauline $40).
3. **Surcharges/codes** — confirm Colombo city-pickup ($3/seat) + discount codes (10/20/30%).

## Deferred to a later phase (consciously parked)

Curated common-routes distance/price table · preset-price & manual-override table · long-trip taper ·
per-day km cap · LKR/FX · WhatsApp send/payment-link automation · vehicles bigger than van · chauffeur
auto-charge on the web (needs a per-day itinerary structure + the override field).

## Build status

**Nothing is built yet.** The engine plan (9 tasks) is ready to execute on your go; it ships the
pure engine + `POST /quote` and changes **no** charge behaviour. The booking anti-tamper / charge
authority is a **separate follow-up plan**, gated on the website-display step.

## Next step

Read the worked-examples doc (prices) and the spec (design). When you're ready, say go and I'll build
Tasks 1–9. The five open decisions above can be answered any time before the website-display phase.
