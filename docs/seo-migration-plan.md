# Ceylon Hop — M16: SEO-Safe Site Migration

**Status: NOT STARTED — recorded 2026-06-25, to implement before/at go-live.**
Owner record for the SEO impact of replacing the current `ceylonhop.com` site with the
new booking-enabled site. Read this before the apex cutover (it interacts with the
[go-live checklist](./go-live-checklist.md): "serve the new site on the apex").

> This is my expert analysis (no SEO skill installed), grounded in the **live indexed
> footprint** of `ceylonhop.com` + a full audit of the new build, as of 2026-06-25.

---

## Headline verdict
Replacing the site is **NOT a like-for-like swap**. The current site is **content-rich with
per-route landing pages**; the new site is a **thin, app-style site** with no crawlable route
pages. Same-domain authority carries over (good), but the **content/URL-architecture downgrade
will cost rankings on the highest-intent "money" keywords** unless we recreate the route pages
and 301 the old URLs. Migration is *safe only if* we do the P0/P1 work below.

## What ranks today (live `site:ceylonhop.com`)
Google has indexed **per-route landing pages**, not just the homepage:
- `https://ceylonhop.com/trip/shared-ride-negombo-to-sigiri/`
- `https://ceylonhop.com/trip/kandy_to_ella/`
- `https://ceylonhop.com/` (homepage)

Pattern: `/trip/<from>-to-<to>/` targeting *"Kandy to Ella shared taxi"*, *"Negombo to Sigiriya
transfer"* — the long-tail, high-conversion queries a transfer business lives on. Brand is
reinforced by a TripAdvisor 4.9 (Seeduwa / Western Province) listing. Competitive set: aggregators
(hoppa, HolidayTaxis, Klook) + local rivals (ceylontaxiya, ceylonairporttaxi) — long-tail route
pages are how a small player competes. (Note: live apex returns 403 to automated fetchers, so the
full URL list must be pulled from Search Console / a crawl — the `site:` sample is partial.)

## What the new build has
9 pages: `index, about, blog, why, plan, search, booking, tours, tour`. **No static, crawlable
per-route pages.** Search/booking are JS-driven from query params (`search.html?from=…&to=…`),
which do NOT become distinct indexable URLs. Audit of the new build:

| Severity | Finding | Fix |
|---|---|---|
| 🔴 P0 | **Route landing pages disappear** — every indexed `/trip/...` URL 404s, nothing ranks in their place; lost long-tail traffic + backlinks | Pre-render static route pages for top corridors (template from the existing `REAL_KM`/corridor data): unique title/H1/description, price/distance/duration, FAQ, CTA into booking |
| 🔴 P0 | **No 301 redirect map** for old `/trip/...` (and other) URLs | Build old→new map. **GitHub Pages can't do true server-side 301s** → use `jekyll-redirect-from` plugin OR put **Cloudflare in front** for real 301 rules |
| 🟠 P1 | **No `sitemap.xml`, `robots.txt`, `404.html`, `CNAME`** in the repo | Generate all four (sitemap incl. route pages; robots → sitemap; CNAME = apex) |
| 🟠 P1 | **canonical + OG only on `index.html`** (other 8 pages have title+desc but no canonical) — param pages risk infinite canonicalization | Self-canonical on all pages; canonical `?from=&to=` variants to clean base; `noindex` search/booking |
| 🟡 P2 | **`aggregateRating` 4.9/600 on homepage `TravelAgency` schema is self-serving** — Google ignores/can flag org-level ratings not backed by on-page reviews | Embed real on-page reviews, or pull from a valid source, or remove to avoid a structured-data violation. Verify the 600 count matches a real source |
| 🟡 P2 | **Thin structured data** — only homepage `TravelAgency` | Add `LocalBusiness` (NAP/geo/hours), `BreadcrumbList`, `FAQPage`, per-route `Service`/`Offer` or `Trip` |
| 🟡 P2 | **No `<img>` anywhere** (visuals are CSS backgrounds) → zero Google Images presence, no alt context | Use real `<img alt>` on route/tour pages |
| 🟢 P3 | `lang="en"` ✓, single `<h1>`/page ✓, titles+descriptions on all pages ✓, good word counts (index 2.6k, booking 1.9k, plan 1.3k) ✓, static = better Core Web Vitals ✓ | Keep |

## Local SEO (high-leverage)
- **Do not touch the Google Business Profile** (separate from the site; the maps listing is valuable).
- **NAP consistency** across site + GBP + TripAdvisor (name, `+94 77 966 9662`, address).
- Add `LocalBusiness` schema (geo, areaServed, telephone, hours).

## Implementation sequence (when we pick this up)
1. **Export the full current indexed URL list** (Search Console → Pages, or Screaming Frog crawl) — the `site:` sample is incomplete.
2. **Generate static route pages** for the top ~15–25 corridors *before* cutover (programmatic from corridor/`REAL_KM` data).
3. **Build the 301 redirect map** old→new (route→route; old marketing pages→new equivalents).
4. **Ship** `sitemap.xml` (incl. route pages), `robots.txt`, `404.html`, `CNAME`; add canonical/OG sitewide; `noindex` the param-driven search/booking pages; add the structured-data types above.
5. **Cut over** → Search Console: submit sitemap, request indexing of route pages, monitor Coverage/404s for 4–6 weeks. Expect a short wobble that recovers if redirects + content are clean.

## Needs the founder
- The **full indexed-URL export** (Search Console) to build a complete redirect map.
- Decision: **Cloudflare-in-front vs `jekyll-redirect-from`** for real 301s on GitHub Pages (Cloudflare also helps the PayHere-apex constraint).
- Confirm the **review count/source** behind the 4.9 rating before re-publishing aggregateRating markup.

## P0/P1 work this milestone delivers
- Static route-page generator (from corridor/`REAL_KM` data) + the pages themselves
- `sitemap.xml` · `robots.txt` · `404.html` · `CNAME`
- Sitewide canonical + OG; `noindex` on param pages
- `/trip/...` → new-URL 301 redirect map (+ chosen redirect mechanism)
- Expanded structured data (LocalBusiness, BreadcrumbList, FAQ, per-route Service/Trip)
