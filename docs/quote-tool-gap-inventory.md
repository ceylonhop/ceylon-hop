# Internal Quoting Tool — Gap Inventory (audit before building)

**Goal:** the ops tool must be a **superset** of (a) what customers can do on the front-end, plus
(b) the ops-only features in the founder's design HTML. This is the full inventory of what's missing
from the current MVP (`/admin/quote`), taken from both sources. **Nothing here is built yet beyond the
MVP.**

## The two reference baselines

- **Customer front-end** (`booking.js`, `plan.js`, `transfers-data.js`, **`ch-map.js`**) — live Google
  Places autocomplete + real Google Directions distance, branded date pickers, vehicle/luggage logic,
  add-ons, 5 product flows (single / shared / multi-stop trip / catalogue+Island-Loop / custom),
  chauffeur day-span billing, deposit, route map.
- **Founder's design HTML** (decompressed) — 5 vehicle types, admin-locked Rate Settings, 6 leg types,
  offline place autocomplete + haversine distance with manual override, Driver-stays/Car-stays per
  date, full cost build-up, 10+ operational flags, WhatsApp/Email/Notion templates, Draft→Booked→Lost
  lifecycle, Save + localStorage, Internal-Calc tab.

## What the current MVP has
Name/pax/bags, car|van, Transfers|Chauffeur, legs with **manually-typed km**, sightseeing/waiting
checkboxes, a pricing summary (LKR+USD+margin+deposit), car-vs-van, and a WhatsApp draft. That's it.

---

## GAP INVENTORY (missing → priority)

| # | Area | What "complete" needs (source) | MVP today | Pri |
|---|---|---|---|---|
| 1 | **Location input** | **Google Places autocomplete**, Sri-Lanka-restricted, session tokens, on every from/to (customer `ch-map.js`); offline place-list fallback (design's 40-place list) | plain text box | 🔴 |
| 2 | **Distance auto-calc** | **Auto km + duration per leg**: real Google Directions → baked `REAL_KM` table → haversine×1.35 (customer); editable override (design). Backend already has a maps adapter (Google Distance Matrix + haversine fake) we can use | user types km | 🔴 |
| 3 | **Dates** | per-leg branded date pickers, trip-span → driver-nights derivation, chronological auto-sort, flexible "decide later" | bare chauffeur start/end + 1 date field | 🟠 |
| 4 | **Vehicle types** | **Car / Van 6 / Van 9 / Van 14 / Custom** (design). The engine only prices car+van — bigger vehicles were deferred, but the internal tool is exactly where they belong | car / van only | 🟠 |
| 5 | **Leg types** | 6 typed legs: Transfer, **Stay day**, Train/luggage support, Sightseeing/waiting, Safari waiting, Airport pickup/dropoff (design) — each behaves differently (stay day = idle, etc.) | one generic leg + keep-car toggle | 🟠 |
| 6 | **Multi-stop within a leg** | stopover chips (A → via B → C) (design + customer planner) | none | 🟡 |
| 7 | **Pricing Summary depth** | distance → +buffer → **billable km** strip; cost buckets (vehicle / sightseeing+waiting / driver-stays / accommodation); subtotal; markup; **per-leg-vs-total rounding note**; **pricing tip** | total + line items + margin | 🟠 |
| 8 | **Operational Flags** | 10+ auto flags: car-luggage, long-drive ≥6h, hectic itinerary, capacity, driver-without-car, safari-waiting, van/car min applied, airport-timing, stopover, check-distances (design) | engine warnings only | 🟠 |
| 9 | **Quote Output** | **WhatsApp + Email + Notion** templates (exact copy in design) · **LKR⇄USD send toggle** · **Internal-Calc** ops-only tab | WhatsApp draft only | 🟠 |
| 10 | **Rate Settings panel** | admin-lockable in-tool view/edit of rates, buffer, FX, floors, min-km, rounding (design) | none (rates in code) | 🟡 |
| 11 | **Lifecycle + Save** | Draft/Ready/Sent/Booked/Lost status · New · Save · saved-quotes list · localStorage autosave (design) | none (stateless) | 🟡 |
| 12 | **Product flows** | besides private/chauffeur: **shared corridors**, **Island Loop pass**, **catalogue/custom** (customer); shared is also a tab in the plan | private + chauffeur | 🟠 |
| 13 | **Vehicle capacity logic** | auto van-upgrade / car-downgrade prompts, hard blocks over capacity (customer) | engine upgrade only (no UI prompt) | 🟡 |
| 14 | **Add-ons** | sightseeing / luggage rack / child seat / flexi with prices; shared extra-bag $10 (customer) | sightseeing + waiting only | 🟡 |
| 15 | **Route map** | Google polyline map + SVG island fallback + distance/time bar (customer) | none | 🟡 |
| 16 | **Comparisons** | car-vs-van **and** chauffeur-vs-separate-transfers side-by-side | car-vs-van only | 🟡 |

---

## ⚠️ Reconciliation decisions to settle BEFORE building (the real forks)

1. **Pricing model: our engine (USD) vs the design (LKR-native).** We locked a **USD** rate card
   (car $0.46/km, van $0.83/km, $35/day, **buffer 10%**, $29/$50 floors, deposit min(10%,$50)). The
   **design** is **LKR-native** with a *structurally different* model: per-km LKR rates, **buffer in
   km (10 km, not 10%)**, **min-km floors (50/100 km)**, **round-up to nearest 500**, and chauffeur
   split into **driver/day + bata/day + accommodation/night** (vs our single $35/day). These don't
   reconcile silently — **which pricing brain is canonical?** (You said the design isn't gospel on
   numbers, so my default is: keep the engine, adopt the design's *UX*. But the design's richer
   chauffeur cost + km-buffer + min-km are real modelling choices to confirm.)
2. **Bigger vehicles (Van 9 / 14 / Custom).** The internal tool needs them; the engine doesn't price
   them yet (deferred). Add van-9/14/custom rates to the engine, or keep car+van here too?
3. **Distance/location source.** Live **Google** (Places + Distance Matrix — needs the Maps key, which
   exists in the front-end, and incurs API cost) vs the **offline** baked `REAL_KM` table + haversine.
   Recommend the customer-site hybrid: Google when available, baked/haversine fallback, manual override.
4. **Rate editing.** In-tool admin panel (design) vs code-only (`rateCard.ts`).
5. **Persistence/lifecycle.** Add Save + status + saved-quotes now, or defer (we'd scoped stateless v1).
6. **Shared / Island-Loop.** Still blocked on the shared pricing model you owe; Loop needs the pass
   prices.

## Recommended next step
Re-spec the tool as a **true superset** (this inventory → a proper plan), settle the 6 forks above
(esp. #1 pricing brain and #3 distance source), then build in phases — **headline first: Google Places
autocomplete + auto-distance + real date handling** (the three you flagged), then leg-types/flags/output,
then lifecycle. No more thin MVPs.
