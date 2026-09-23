# Search Console baseline — apex launch (2026-09-20)

Owner's Google Search Console exports, taken 2026-09-23, saved so later sessions can compare
against them without asking again. **Compare on or after 2026-10-04** (two weeks post-launch;
GSC lags ~2–3 days).

| File | What | Range |
|---|---|---|
| `performance-*.csv` | Performance → Search results (web): queries, pages, countries, devices, daily chart | last 3 months, to 2026-09-21 |
| `indexing-daily.csv` | Indexing → Pages: indexed vs not-indexed per day | to 2026-09-20 |
| `indexing-not-indexed-reasons.csv` | "Why pages aren't indexed" summary (counts only — no URL lists) | as of 2026-09-20 |

Almost all of this data is from the **old WordPress site**: the Pages table lists only old URLs,
and none of the new `/trip/<route>/` pages appear yet.

## Baseline numbers

- **~1,083 clicks / ~7,650 impressions** over 3 months (~12 clicks/day).
- **Brand ≈ 60% of clicks**: "ceylon hop" 422, "ceylon hop sri lanka" 138, "ceylonhop" 90.
- **Non-brand strength is "shared taxi"**: "shared taxi sri lanka" 34 clicks / 167 impr / pos 2.6;
  "share taxi sri lanka" 8 / **278** / pos 3.9 (**CTR 2.9%** — snippet mismatch).
- **Route queries rank poorly**: "negombo to sigiriya" pos 34, "negombo to sigiriya taxi" 25,
  "weligama to colombo airport" 43, "sigiriya to kandy taxi" 53, "kandy to ella taxi" 7.7.
- **Guides**: bus guide 1,292 impr / tuk-tuk guide 1,597 impr, pos ~15–50, CTR ~1%.
- **Old tour page** `/trip/island_loop_6_stops/`: 930 impr at pos 2.6 (now → `tours.html`).
- **Indexing (2026-09-20)**: 36 indexed; 89 not indexed, of which **52 "Discovered – currently
  not indexed"** (new route pages awaiting crawl); robots.txt 8, 401 6, 404 6, noindex 5, redirect 5.
- Post-launch days: 20 Sep 13 clicks / 68 impr; 21 Sep 18 / 82 (pre-launch 1–15 Sep avg ~15.4 / ~92).
- Also indexed and should not be: `ops.staging.ceylonhop.com`, `prod.ceylonhop.com` (retired).

## Legacy-URL redirect check (2026-09-23, from `origin/production`)

Every old URL with impressions maps to a sensible new page (`tools/redirect-map.json`), but they
are **not HTTP 301s**: each stub is a 200 page with an instant meta-refresh, a canonical to the
target, **and `noindex, follow`** (see `docs/apex-cutover-runbook.md` — the Cloudflare Bulk
Redirects import was parked). Google usually treats an instant meta-refresh as a redirect, but
`noindex` + canonical is a mixed signal. Highest-impression legacy URLs (candidates for true
301s): `/routes/` 2,078 · `/why-hop-with-us/` 943 · `/trip/island_loop_6_stops/` 930 ·
`/about-us/` 893 · `/private_transfer/` 353 · `/trip/shared-ride-negombo-to-sigiri/` 321 ·
`/my-account/` 259 · `/trip/mirissa-weligama-to-airport-shared-ride/` 229 · `/trip/kandy_to_ella/` 142.
Blog posts kept their original URLs (real pages, no redirect needed).
