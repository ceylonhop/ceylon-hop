# Ceylon Hop — Quote Calculation: Detailed Worked Examples (for ops review)

> 🧭 **This document is validation evidence — NOT the canonical price source.** The authoritative
> rates live in code (`api/src/quote/rateCard.ts`, + the corridor repo for shared seat prices),
> PR-reviewed and golden-tested. Numbers here use **hand-estimated distances** and include **"team
> actual" figures that intentionally differ** from the engine. **Do not quote a customer from this doc.**

**Purpose:** validate the proposed automated **Quote Engine** against the real WhatsApp quotes the
team gave. Every customer below shows the **full itinerary, distance per leg, vehicle, the rate
applied ($/km and $/day), line-by-line totals, deposit**, and **what the team actually charged**.
Review the *method and the rates*, and correct anything that doesn't match how you price by hand.

> ⚠️ **Distances are approximate**, entered by hand for this review (see the reference table). The
> real engine will read a corrected distance table (v2 fixes Google's errors + avoids bad routes).
> Where our number differs from the team's actual, it's almost always the distance estimate.
>
> ⚠️ **Some are historical quotes** priced at the per-km rate **in force at the time** (now
> **$0.46/km**, which already includes the 25% markup), so small $ differences on older private
> quotes are expected — they reflect rate changes, **not** model errors.
>
> ⚠️ **Recent Notion quotes (May–Jun 2026) show a `$29` minimum private transfer (car):** short
> legs bill a flat $29 regardless of distance (Airport→Negombo ~10 km, Colombo→Airport ~35 km).
> The engine applies `max($29, km × rate)` per private leg.

---

## Rate card (v2 — **cost + markup** model)

The engine prices from **`cost × (1 + markup)`** so margin is explicit and tunable in one place.
**`MARKUP = 25%`** (single config value). The $0.46/km we validated already *includes* this markup.

All sell prices below **already include the 25% margin** (markup shown for transparency / re-tuning).

| Item | Cost (implied) | Markup | **Sell price (final)** |
|---|---|---|---|
| **Car** per-km | $0.368 / km | 25% | **$0.46 / km** |
| **Van** per-km (≤6 pax) | $0.66 / km | 25% | **$0.83 / km** ✅ |
| **Chauffeur day rate** | $28 / day | 25% | **$35 / day** per retained day ✅ |

**Other rules**
| Item | Value |
|---|---|
| **Minimum private transfer (floor)** | **$29 (car)** · **$50 (van)** |
| **No-travel-day minimum** | **100 km (car) / 150 km (van)** billed at the per-km sell rate (idle-day rule — **kept as-is**) |
| **Shared seat** | route's **fixed seat price × seats** (distance not used) |
| **Deposit** | the **lower** of (10% of total) or **$50** → `min(10% × total, $50)` |

**Vehicle tiers (website) — Car + Van only:**
- **Car** — up to **3 passengers**, **3 bags** → car rate
- **Van** — up to **6 passengers** → van rate
- Anything bigger (Van 9/14, Bus 25, multi-van) → **"contact us", quoted from the internal tool**, not the website.

**Extras (checkout add-ons — server-validated price table, client can't set the price):**
`sightseeing` Sightseeing stops up to 3h **$10** (live) · `safari-wait` Wait for Safari **$19** (to add) ·
`luggage` Luggage rack $5 · `front` Child seat $8 · `flex` Flexi ticket $12. *(An extra-bag charge is
a front-end/shared concept, **not** in the v1 engine.)*
Extras show only on a **single point-to-point private transfer** (matches `booking.js`).

**Surcharges/codes seen in the chats (to encode):** Colombo city-pickup **+$3/seat** · discount codes
**10 / 20 / 30%** · shared routes run **one direction only**.

---

## The ops price sheet — **validation only, NOT engine logic**

The team keeps a manual price sheet of common routes so ops staff can quote quickly without asking
co-founder Dasis each time. **The automated engine does NOT use this table.** Private + chauffeur
transfers compute **`km × rate`** (car $0.46 / van $0.83) with the **$29 car / $50 van floors**. The
sheet is shown here only to **confirm** that the car $0.46/km matches how the team actually prices today.

| Route (ops sheet) | Car price | ~km | implied $/km |
|---|---|---|---|
| Negombo → Sigiriya | $69 | 155 | $0.45 |
| Airport → Sigiriya | $69 | 165 | $0.42 |
| Negombo → Mirissa / Ahangama / Weligama | $79 | ~170 | $0.46 |
| Negombo → Ella (highway) | $144 | 338 | $0.43 |
| Negombo → Ella (normal) | $94 | 210 | $0.45 |
| Sigiriya → Kandy | $44 | 90 | $0.49 |
| Kandy → Ella | $59 | 140 | $0.42 |
| Airport → Arugam Bay | $149 | 320 | $0.47 |
| Colombo → Sigiriya | $79 | 175 | $0.45 |
| Ella → Yala | $54 | 110 | $0.49 |
| Mirissa / Weligama → Arugam Bay | $109 | 230 | $0.47 |
| Ella → Arugam Bay | $59 | 125 | $0.47 |
| Ella → Trincomalee | $114 | 250 | $0.46 |

→ Implied per-km averages **≈ $0.45**, so **$0.46/km is confirmed**. The engine just computes
`km × $0.46`; the few-dollar differences vs the rounded sheet prices are expected and fine.

**Engine logic (v1):**
- `private leg = max($29 floor, round(km × cost × 1.25))` (car cost $0.368 → $0.46/km; van its own rate)
- `chauffeur = days × $35 + (travel km + idle-day minimums) × sell-rate`
- `shared = seatPrice[route] × seats`
- `+ extras` (server-validated add-on prices) · `deposit = min(10% × total, $50)`

**Deferred to a later phase (noted, not building now):**
- A **curated common-routes distance/price table** (the ops sheet) — engine stays pure `km × rate` for v1.
- A preset-price / manual-override table.

---

## Distance reference used (approx road km — please correct)

| Leg | km | Leg | km |
|---|---|---|---|
| Airport ↔ Negombo | 12 | Ella → Yala/Tissa | 110 |
| Negombo → Sigiriya | 155 | Ella → Mirissa | 130 |
| Airport → Sigiriya | 165 | Ella → Hiriketiya | 120 |
| Sigiriya → Kandy | 90 | Ella → Bentota | 225 |
| Dambulla → Kandy | 72 | Yala/Tissa → Mirissa | 95 |
| Kandy → Nanu Oya / N.Eliya | 80 | Mirissa → Galle | 40 |
| Kandy → Ella | 140 | Unawatuna → Colombo | 125 |
| Kandy↔Sigiriya+Dambulla day trip | 200 | Bentota → Airport | 110 |
| Colombo → Ella (no highway) | 210 | Airport → Arugam Bay | 320 |
| Colombo → Ella (highway) | 338 | Hikkaduwa/Bentota → N.Eliya | 165 |
| Sigiriya → Yala/Ahangama | 150 | N.Eliya → Hiriketiya | 210 |

---

# SHARED rides (seat price × seats)

### 1. Arvid — Negombo → Sigiriya · 2 pax · pooled (10 Sep)
| Leg | Route | Vehicle | Seat price | Seats | Line total |
|---|---|---|---|---|---|
| 1 | Negombo → Sigiriya | shared (car/van pool) | $19 | 2 | **$38.00** |

**Total $38.00** · Full payment (no deposit). **Team actual: $38** ✅ exact.

### 2. Kevin — 3 shared legs · 2 pax · pooled (Jan)
| Leg | Route | Seat price | Seats | Line total |
|---|---|---|---|---|
| 1 | Negombo → Sigiriya | $19 | 2 | $38.00 |
| 2 | Sigiriya → Kandy | $17 | 2 | $34.00 |
| 3 | Ella → Mirissa | $24 | 2 | $48.00 |

**Total $120.00** · one PayHere link · full payment. **Team actual:** one combined link ✅ (method matches).

### 3. Hakan — Negombo → Sigiriya · 1 pax · **Colombo hotel pickup** (30 Aug)
| Item | Detail | Amount |
|---|---|---|
| Seat | Negombo → Sigiriya × 1 | $19.00 |
| Surcharge | Colombo city pickup (+$3/seat) | $3.00 |

**Total $22.00.** **Team actual: $22** ✅ exact. *(Encode the $3 city-pickup rule.)*

### 4. Pati & Amanda — Island Loop **6-stop pass** · 2 pax · 30% code (Aug)
| Item | Detail | Amount |
|---|---|---|
| Loop pass (6 stops) | $119 × 2 pax | $238.00 |
| Discount code | −30% | −$71.40 |

**Total $166.60.** **Team actual:** $119 pass + 30% friend code ✅. *(Loop pass is a fixed product, not per-leg.)*

---

# PRIVATE transfers (km × $0.46)

### 5. Tatia — Kandy → Nanu Oya · 2 pax · **car** (private leg of a mixed trip)
| Leg | From → To | Distance | Vehicle | Rate | Leg cost |
|---|---|---|---|---|---|
| 1 | Kandy → Nanu Oya | 80 km | car | $0.46/km | **$36.80** |

**Total $36.80.** **Team actual: $37** ✅ near-exact.

### 6. Brendan — Sigiriya → Kandy · 2 pax · **car** (30 Aug)
| Leg | From → To | Distance | Vehicle | Rate | Leg cost |
|---|---|---|---|---|---|
| 1 | Sigiriya → Kandy | 90 km | car | $0.46/km | **$41.40** |

**Total $41.40** (above the $29 car floor, so the per-km price applies). **Team actual: $53** — priced at a **higher per-km rate at the time** (since reduced to $0.46). ✅ not a model gap.

### 7. Steph — Colombo → Ella · 2 pax · **car** · two route options (28 Oct)
| Option | From → To | Distance | Vehicle | Rate | Total | Deposit (min 10%/$50) |
|---|---|---|---|---|---|---|
| A — no highway | Colombo → Ella | 210 km | car | $0.46/km | **$96.60** | $9.66 |
| B — highway | Colombo → Ella | 338 km | car | $0.46/km | **$155.48** | $15.55 |

**Team actual:** A = **$89** (≈9% under) · B = **$114** ⚠️ much lower → **long-trip taper** (highway ≈ $0.34/km). Customer paid 10% deposit. ✅ deposit rule.

### 8. Bianca — Airport → Arugam Bay · 1 pax · **car** (Sep)
| Leg | From → To | Distance | Vehicle | Rate | Leg cost |
|---|---|---|---|---|---|
| 1 | Airport → Arugam Bay | 320 km | car | $0.46/km | **$147.20** |

**Total $147.20.** **Team actual: $124** (~6.5 h; the driver also drives back empty — priced by hand). ⚠️ within ~19%.

### 9. Bianca — Ella → Hiriketiya · 3 pax · **car** (24th)
| Leg | From → To | Distance | Vehicle | Rate | Leg cost |
|---|---|---|---|---|---|
| 1 | Ella → Hiriketiya | 120 km | car (Prius) | $0.46/km | **$55.20** |

**Total $55.20.** **Team actual: $63** (all-in) — older/higher rate at the time. ✅ not a model gap.

### 10. Pauline — Unawatuna → Colombo · 1 pax · **car** (23 Sep)
| Leg | From → To | Distance | Vehicle | Rate | Leg cost |
|---|---|---|---|---|---|
| 1 | Unawatuna → Colombo | 125 km | car | $0.46/km | **$57.50** |

**Total $57.50.** **Team actual: $40** — a deliberately **competitive** quote (repeat customer). ⚠️ needs a **manual discount/override** field.

### 11. Ayan — two one-way transfers · 2 pax · **car** (2 & 4 Nov)
| Leg | Date | From → To | Distance | Vehicle | Rate | Leg cost |
|---|---|---|---|---|---|---|
| 1 | 2 Nov | Hikkaduwa + Bentota → Nuwara Eliya | 165 km | car | $0.46/km | $75.90 |
| 2 | 4 Nov | Nuwara Eliya → Hiriketiya | 210 km | car | $0.46/km | $96.60 |

**Total 375 km → $172.50.** **Team actual: $175** ✅ near-exact (two separate vehicles, driver doesn't stay). Deposit: he negotiated 30% (standard would be `min(10%×175, $50)` = $17.50).

### 12. Michael — 4 private transfers · 2 pax · **car** (Apr)
| Leg | Date | From → To | Distance | Vehicle | Rate | Leg cost |
|---|---|---|---|---|---|---|
| 1 | 17 Apr | Negombo → Sigiriya | 155 km | car | $0.46/km | $71.30 |
| 2 | 19 Apr | Sigiriya → Kandy | 90 km | car | $0.46/km | $41.40 |
| 3 | 24 Apr | Ella → Yala | 110 km | car | $0.46/km | $50.60 |
| 4 | 27 Apr | Yala → Ahangama | 150 km | car | $0.46/km | $69.00 |

**Total 505 km → $232.30.** **Team actual:** sent as PDF Quotation #1017 (exact figure not in the chat text — to compare against the PDF).

---

# CHAUFFEUR (km × $0.46 + days × $35 + no-travel minimums)

### 13. Ayan — **keep the car** the middle day (chauffeur option for the same 2–4 Nov trip)
Same two drives, but the car + driver are **retained across all 3 days** and drive them locally on 3 Nov.

| Date | Day type | Movement | Distance | Vehicle | Distance @ $0.46 | Day rate |
|---|---|---|---|---|---|---|
| 2 Nov | travel | Hikkaduwa+Bentota → N.Eliya | 165 km | car | $75.90 | $35 |
| 3 Nov | local (kept) | driving around N.Eliya | ~min 100 km | car | $46.00 | $35 |
| 4 Nov | travel | N.Eliya → Hiriketiya | 210 km | car | $96.60 | $35 |

- Distance: 165 (travel) + **100 (3 Nov kept-day minimum)** + 210 (travel) = 475 km × $0.46 = **$218.50**
- Day charge: 3 retained days × $35 = **$105.00**
- **Engine total: $323.50** · **Deposit:** `min(10% × 323.50, $50)` = **$32.35**
- **Historical team quote was $235** — lower (older rate; the kept day wasn't billed the full minimum). With the confirmed rule the engine quotes **$323.50**. ✅ method matches the stated rule.

### 14. Emma — 5-leg multi-day · **car + English-speaking guide** · 2 pax (14–22 Feb)
| Date | Day type | Movement | Distance | Vehicle | Distance @ $0.46 | Day rate |
|---|---|---|---|---|---|---|
| Sat 14 Feb | travel | Airport → Kandy | 120 km | car | $55.20 | $35 |
| Sun 15 Feb | no travel | rest, Kandy | — | car | (see below) | $35 |
| Mon 16 Feb | travel | Sigiriya + Dambulla day trip | 200 km | car | $92.00 | $35 |
| Tue 17 Feb | travel | Kandy → Ella (luggage, they train) | 140 km | car | $64.40 | $35 |
| Wed 18 Feb | no travel | rest, Ella | — | car | (see below) | $35 |
| Thu 19 Feb | travel | Ella → Bentota | 230 km | car | $105.80 | $35 |
| Fri 20 Feb | no travel | rest, Bentota | — | car | (see below) | $35 |
| Sat 21 Feb | no travel | rest, Bentota | — | car | (see below) | $35 |
| Sun 22 Feb | travel | Bentota → Airport | 110 km | car | $50.60 | $35 |

- **Days retained:** 9 → day charge 9 × $35 = **$315.00**
- **Distance billed:** travel days 120+200+140+230+110 = **800 km** + **4 kept/rest days × 100 km min = 400 km** = **1,200 km × $0.46 = $552.00**
- **Engine total: $867.00** · **Deposit:** `min(10% × 867, $50)` = **$50.00**
- **Historical team quote was $690** — lower because (a) the kept-day minimums (4 × 100 km ≈ $184) weren't billed at the time and (b) the rate has since changed. **Going forward, with the confirmed rule (idle days bill the 100/150 km minimum), this trip quotes $867.** ✅ method now matches your stated rule. *(This is the intended direction — you charge for the car being held.)*

---

# MIXED itinerary (shared + private in one trip)

### 15. Tatia — full trip · 2 pax (27 Nov – 2 Dec)
| # | Date | Route | Mode | Vehicle | Calc | Line total |
|---|---|---|---|---|---|---|
| 1 | 27 Nov | Airport → Sigiriya | shared | pool | $19 × 2 seats | $38.00 |
| 2 | 29 Nov | Sigiriya → Kandy | shared | pool | $17 × 2 seats | $34.00 |
| 3 | 30 Nov | Kandy → Nanu Oya | private | car | 80 km × $0.46 | $36.80 |
| 4 | 2 Dec | Ella → Ahangama | shared | pool | $24 × 2 seats | $48.00 |

- **Engine total: $156.80** · **Team actual: $157** ✅ **near-exact** (and the best end-to-end validation — mixes both products).

---

# ADDITIONAL conversations (full coverage)

## More single shared legs — all just `seat × seats` (validates the shared model)
| # | Customer | Route | Seats | Calc | Total |
|---|---|---|---|---|---|
| 16 | Nico | Negombo→Sigiriya | 2 | $19×2 | $38 |
| 17 | Em | Negombo→Sigiriya | 1 | $19×1 | $19 |
| 18 | Alina | Negombo→Sigiriya (off at Dambulla) | 2 | $19×2 | $38 |
| 19 | Laura | Negombo→Sigiriya | 3 | $19×3 | $57 |
| 20 | Anne | Negombo→Sigiriya | 2 | $19×2 | $38 |
| 21 | Sofa | Negombo→Sigiriya | 1 | $19×1 | $19 |
| 22 | Lea | Weligama→Negombo (Mirissa→Airport corridor) | 1 | $24×1 | **$24** (team $24 ✅) |
**Logic:** shared seat is a fixed per-route price × number of seats; drop-off at an intermediate stop (Dambulla) is the same seat. All full payment.

## Island Loop passes — a **fixed bundle product**, not a per-leg sum
| # | Customer | Pass | Pax | Calc | Total |
|---|---|---|---|---|---|
| 23 | Wade | 6-stop $119 / 9-stop $149 | — | quoted both | **$119 / $149** ✅ |
| 24 | Alex | 9-stop, 2 adults + 2 kids (kids = adult fare) | 4 | $149 × 4 | **$596** |
| 25 | Peter | 6-stop, then negotiated **5-stop** + 10% code | 1 | $119 → $105 → −10% | **$94.50** |
| 26 | Basma | 9-stop **+ Arugam Bay** add-on | 1 | $149 + AB premium | **$149 + AB** (exact AB premium ⚠️ to confirm) |
**Logic:** the Loop is a **pre-priced pass** (6 = $119, 9 = $149), **per person**, *not* the sum of individual legs (cheaper than per-leg). Kids pay the adult fare. Stop-count variants (5-stop $105) and discount codes apply on top. **→ the engine needs Loop passes as named products with fixed prices.**

## More private transfers (`km × $0.46`)
| # | Customer | Route | km | Veh | Calc | Engine | Team |
|---|---|---|---|---|---|---|---|
| 27 | Julián | Mirissa→Tangalle (short private add-on) | 35 | car | max($29, 35×.46) | **$29.00** (floor) | $24 |
| 27 | Julián | Yala→Tangalle | 75 | car | 75×.46 | $34.50 | $36 ✅ |
**Logic:** off-route hops are priced `max($29 floor, km × $0.46)` — the Mirissa→Tangalle leg (35 km → $16.10) hits the **$29 car floor**.

## Multi-leg MIXED itineraries (shared where on-route, private where not)

### 28. Julián — couple, 3 shared legs
Sigiriya→Kandy $17×2 + Ella→Mirissa $24×2 + Mirissa→Airport $24×2 = **$130** (2 pax). *(Shared seat × 2 per leg.)*

### 29. Nicole — 2 pax, dated (Jan)
| Leg | Mode | Calc | Line |
|---|---|---|---|
| Dambulla→Kandy | shared | $17×2 | $34 |
| Ella→Tissa (Udawalawe/Yala) | shared | $16×2 | $32 |
| Tissa→Mirissa | shared | $17×2 | $34 |
| Negombo→Wilpattu | private car | 130×.46 | $59.80 |
| Wilpattu→Dambulla | private car | 95×.46 | $43.70 |
| Mirissa→Galle | private car | max($29, 40×.46) | **$29.00** (floor) |
| Galle→Colombo | private car | 120×.46 | $55.20 |
**Total $287.70** (2 pax — Mirissa→Galle floored to $29). **Logic:** each leg priced by its own product — shared seat×2 on covered routes, private `max($29, km×$0.46)` off-route.

### 30. Jen Lorimer — **2 adults + 2 kids = 4 pax (van)**, dated (Mar)
| Leg | Mode | Seats/Veh | Calc | Line |
|---|---|---|---|---|
| Negombo→Sigiriya | shared | 4 seats | $19×4 | $76 |
| Sigiriya→Kandy | shared | 4 seats | $17×4 | $68 |
| Mirissa→Colombo | shared | 4 seats | $24×4 | $96 |
| Colombo→Airport | shared | 4 seats | $5×4 | $20 |
| Kandy→Nuwara Eliya | private **van** | 75 km | 75×.83 | $62.25 |
| Nuwara Eliya→Tangalle | private **van** | 200 km | 200×.83 | $166.00 |
**Total $488.25.** **Logic:** kids pay the **adult** seat fare (no child price); 4 pax needs a **van** for the private legs, priced at the **van rate $0.83/km** (both above the $50 van floor).

### 31. Aurelian — couple, ~7 shared legs (an Island Loop booked per-leg)
Negombo→Sigiriya $19×2 + Sigiriya→Kandy $17×2 + Kandy→Ella $29×2 + Ella→Yala $16×2 + Yala→Mirissa $18×2 + Mirissa→Colombo $24×2 = **≈ $246** (2 pax) + a private Mirissa→Tangalle hop he arranged himself. **Logic:** booking many shared legs individually = sum of seat×2. *(Note: per-leg this is pricier than buying the Loop pass — a real upsell signal.)*

### 32. Lisa — couple
Negombo→Sigiriya $19×2 + Sigiriya→Kandy $17×2 + **Ella→Tangalle private group $19/person ×2** = $38+$34+$38 = **$110**. *(The Ella→Tangalle "group" ride was sold at a per-person shared rate even though off the standard route.)*

### 33. Johanna — couple
Negombo→Sigiriya $19×2 + **Ella→Tangalle (drop at Beliatta) = Ella→Mirissa corridor price $24×2** = $38 + $48 = **$86**. *(Off-route Tangalle billed at the nearest corridor's seat price.)*

### 34. Jen (US) — couple
Sigiriya→Ella (through Kandy) shared **$29/seat** ×2 = $58 + tax ≈ **$62**; alt Ella→Weligama $21×2 = $42. *(Confirms a couple of seat prices: Sig→Ella $29, Ella→Weligama $21, and that tax is added on top.)*

## A pricing nuance to confirm — **tiered shared seats**
### 35. Anna Lampe — Negombo→Sigiriya, tiered by group size
Team quoted **$19.50 (1 seat) / $17.50 (2) / $16.50 (3+)** per seat — i.e. a small **volume discount**, vs the flat **$19** most other quotes used. ⚠️ **Open: is the shared seat a flat per-seat price, or tiered by group size?**

# NOTION quotes — engine vs Dasis (10 most recent "Quoted", May–Jun 2026)

Pulled from the **Ceylon Hop Tracking** DB; Dasis's per-leg prices read off each lead page.
Distances are estimates (±10%), so treat engine totals as approximate.

**Private transfers** — engine = `max(floor, km × rate)`, car:
| Customer | Pax | Dasis | Engine | Δ |
|---|---|---|---|---|
| Anne (v2, 9 legs) | 1 | $591 | ~$579 | −2% ✅ |
| Sandra Wolker (7 legs) | 2 | $673 | ~$658 | −2% ✅ |
| Varsha (9 legs) | 2 | $346 | ~$305 | −12% (Dasis hotter on short legs) |
| Kaïna (6 legs) | 2 | $519 | ~$445 | −14% (Dasis ~$0.55/km east-coast) |
| Dana (6 legs) | 2 | $444 | ~$538 | +21% (my distances likely high) |

**Chauffeur** — engine = `days × $35 + travel-km × rate` (shown **without** the idle-day minimum, to isolate the fit; with the idle-min the engine is deliberately higher, as decided):
| Customer | Days | Dasis | Engine |
|---|---|---|---|
| Nash | 13 | $879 | ~$846 ✅ |
| Varsha | 9 | $559 | ~$582 ✅ |
| Anne (v2) | 20 | $1,359 | ~$1,254 ✅ |
| Dana | 23 | $1,479 | ~$1,345 ✅ |

**Van / out of scope:** Karen (van, 5 pax) $659 → at **$0.83/km** the engine reproduces **~$671** ✅ · Frank (9-van) $785 · Saadia (25-seat bus + national guide) $2,599 → **internal/manual tier**, not the web engine.

**Three findings — now baked into the rate card:**
1. **$29 car / $50 van minimum** — short legs bill a flat floor (Anne Airport→Negombo ~10 km = $29; Colombo→Airport ~35 km = $29).
2. **Van ≈ $0.83/km** (~1.8× car) — Karen reproduces almost exactly.
3. **Chauffeur idle-day minimum** pushes engine quotes ~15–30% above Dasis's historical totals — **kept as-is** by decision (you charge for the held car).

---

# Validation summary

| Product | Method | Result vs team |
|---|---|---|
| **Shared** | seat × seats (+ surcharges/codes) | ✅ exact (Arvid, Kevin, Hakan, Pati) |
| **Private** | km × $0.46 | ✅ near-exact on recent quotes (Tatia $37, Ayan $175, mixed Tatia $157); older quotes (Brendan, Bianca) differ because the rate was higher then; long highway needs a **taper** (Steph); **discounts** need a field (Pauline) |
| **Chauffeur** | days × $35 + (travel km + kept-day mins) × $0.46 | ✅ method confirmed (kept days bill the 100/150 min). Engine quotes come out *higher* than the older historical quotes (Emma $867 vs $690, Ayan $323.50 vs $235) — **intended**, since you now charge for the car being held on idle days. |
| **Deposit** | min(10%, $50) | ✅ exact (Emma $50, Steph 10%) |

## Questions for ops still open (do not block v1)
1. **Island Loop passes as fixed products** — the Loop is sold at a **set price per person** (6-stop **$119**, 9-stop **$149**, 5-stop **$105**, +**Arugam Bay** premium), *cheaper than the sum of legs*. Confirm these prices so the engine carries them as named products.
2. **Shared seat price — flat or tiered?** Most quotes used a flat per-seat price, but Anna got **$19.50 / $17.50 / $16.50** for 1 / 2 / 3+ seats (a group discount). Which is correct?
3. **Canonical shared seat table** — small variance in the chats (Ella→Yala $14–16, Yala→Mirissa $17–18). Confirm the official per-seat price for every corridor.
4. **Manual discount/override** field — competitive/loyalty quotes (Pauline $40).
5. **Surcharges/codes** — city pickup ($3), discount codes (10/20/30%).

*(Resolved since: van rate $0.83/km · $29/$50 floors · 25% markup model · idle-day minimum kept · long-trip taper deferred to v2 with the preset-price table · distance table deferred.)*

## Resolved rules
- **Minimum private transfer (floor): $29 car / $50 van.** Recent Notion quotes (May–Jun 2026) bill short legs at a flat floor regardless of distance. Engine: `max(floor, km × rate)` per private leg.
- **Van per-km = $0.83 sell** (cost $0.66 × 1.25), ~1.8× the car rate. Derived from Karen's Notion van quote and reproduces it almost exactly.
- **Pricing = cost × (1 + 25% markup).** $0.46/km car, $0.83/km van, $35/day all already include the margin; markup is one config value.
- **Chauffeur kept-day rule.** Every retained day bills **$35 + (that day's km × sell-rate)**. Travel days use the actual leg km; **kept/idle days bill the 100 km (car) / 150 km (van) minimum** — covering (1) local/sightseeing driving and (2) the car+driver's opportunity cost. This makes multi-day chauffeur quotes higher than older historical ones (intended — confirmed against the Notion data, kept as-is).
- **Children pay the adult fare** — no child discount on shared or private (confirmed across many chats). Child *seat* is an add-on for toddlers.
- **Shared is one-directional** — routes run north→south only (e.g. Ella→Mirissa exists, Mirissa→Ella doesn't); the other direction is a private quote.

_Rate card v1 (final): **car $0.46/km · van $0.83/km** (both incl. 25% markup) · floor **$29 car / $50 van** · chauffeur **$35/day** + travel km + idle-day min (100 car / 150 van) · shared **seat × seats** · deposit **min(10%, $50)** · extras server-validated. Web vehicles = Car + Van only. Distances approximate; curated distance/price table deferred to a later phase._
