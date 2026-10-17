# Experience photos uploaded from the ops tool — design

Date: 2026-10-17 · Status: draft for owner review
Grounding: every file:line below was checked against `origin/main` @ 1f5111be on 2026-10-17.
**Verified** = read in the code or run. **Unverified** = an assumption, with the check that settles it.

## 1. What this is

Today ops gives each experience up to six photos by typing a **path under `img/`**
(`api/src/routes/ops-ui.html:9583`, "a path under img/, without -900/-1800"). The photo has to be a
file in the repo, so a new photo means a PR **and** a `production` promote before anyone can see
it, staging and the ops preview included (spec 2026-10-06 D8). No partner photo has shipped that
way yet: `img/experiences/` does not exist on `main` or `production` (verified, `git ls-tree`).

This change lets ops **pick a photo on their computer or phone and upload it** from the
Experiences form. It shows up on the booking page, the pay page and in ops straight away, with no PR
and no promote. Typed paths keep working for the photos already on the site
(`guides/sigiriya/...`).

Photo upload was listed as out of scope for phase 1 (spec 2026-10-06 §5). This is that follow-up.

## 2. Decisions

### P1 — Storage: Cloudflare R2, one bucket per environment (owner, 2026-10-17)
The owner asked for "a long-term, startup-minded, low/no-cost decision without too much risk".
Three options were weighed:

| | Cloudflare R2 | Supabase Storage | Postgres table |
|---|---|---|---|
| Cost now | Free: 10 GB-month, 1 M writes, 10 M reads a month; **no egress charge** ([R2 pricing](https://developers.cloudflare.com/r2/pricing)) | Free tier is **organisation-wide**, shared with the prod + staging databases; 5 GB uncached egress; file storage cap reported as 500 MB or 1 GB (sources disagree — unverified) | Free, but uses the 500 MB database |
| Cost when we grow | $0.015/GB-month, egress still free | Supabase Pro, $25/month | Supabase Pro |
| Served from | `img.ceylonhop.com` through Cloudflare's cache | `*.supabase.co`, Mumbai | The API (Render, Singapore) reading Mumbai on every image |
| A leaked key can… | change photos in one bucket | (S3 keys) change all storage; (service key) read/write the **whole database** | — no new key |
| New account / vendor | No: Cloudflare already runs ceylonhop.com's DNS and the staging Access gate (team notes; not re-checked here) | No | No |

**R2 is chosen** because it is free at our size and stays cheap as we grow (no egress bill), the
URLs are on **our own domain** (so changing host later never touches saved data), and the key it
needs can only touch one photo bucket. Expected size: about 0.5 MB per photo (both sizes), so
6 photos × 50 experiences ≈ 150 MB, 1.5 % of the free tier (**inferred**, not measured).

**Rejected:** Supabase Storage (shares the one free quota that runs prod; outgrowing it means
$25/month; a wider key). Postgres (eats scarce database space on a plan with no backups, and every
image becomes an API + cross-region database read). Committing uploads to the repo via the GitHub
API (keeps D8 but still needs a PR **and** a promote: it does not fix the problem).

Two buckets, two keys, two domains: `ceylonhop-photos` on `img.ceylonhop.com` (prod) and
`ceylonhop-photos-staging` on `img-staging.ceylonhop.com` (staging). A staging key can never touch
a prod photo.

### P2 — What gets stored: the photo's address on our own image domain
`experiences.photos` is a plain `text[]` with no format check in the database
(`api/drizzle/0065_experiences.sql:19`, `api/src/db/schema.ts:1001` — verified), so **no
migration**. An uploaded photo is saved as its address without the size suffix:

`https://img.ceylonhop.com/experiences/<uuid>` (staging: `https://img-staging.ceylonhop.com/…`)

- The input schema (`api/src/experiences/experience.ts:15`, `PHOTO_STEM`) accepts **either** the
  existing repo path **or** an `https://` address on one of the two image hosts with
  `/experiences/<uuid>`. Anything else is refused, as today.
- `photoUrls()` (`experience.ts:58`) adds `-900.jpg` / `-1800.jpg` to an address and keeps
  building `https://ceylonhop.com/img/<path>` for a repo path.
- The customer pages get the **same `{ small, large }` shape** as today, so `booking.js:1428` and
  `pay.html:598` (which only check the values are strings) do not change. Verified.
- The two image hosts are fixed in code. They never change, so they are not a setting.

### P3 — The browser shrinks the photo; the API checks it
- **Browser (ops form):** `createImageBitmap(file, { imageOrientation: 'from-image' })` → canvas →
  JPEG, longest edge **1800** and **900** px, the same sizes the guides use. A smaller original is
  never enlarged. Quality starts at 0.82 and steps down (0.72, 0.62, 0.5) until the file fits its
  cap. Drawing onto a canvas **drops the camera data, including the GPS location**. No new library.
- **API:** `POST /admin/experiences/photos`, multipart, two files, `large` and `small`. Same CSRF
  rule and `experiences:manage` capability as the catalogue writes (`opsExperiences.ts:71`). It
  refuses a file that does not start with the JPEG bytes `FF D8 FF`, `large` over **700 KB** and
  `small` over **250 KB**. Those caps keep the whole request under the **app-wide 1 MB body limit**
  (`api/src/app.ts:465-469`, #844), which answers `413 payload_too_large` before the route runs.
  (Revised 2026-10-17 during the build: the first draft's 4 MB route limit could never apply under
  that guard, and loosening an app-wide protection for this wasn't worth the risk.)
- It stores `experiences/<uuid>-1800.jpg` and `experiences/<uuid>-900.jpg` with
  `Content-Type: image/jpeg` and `Cache-Control: public, max-age=31536000, immutable` (a uuid is
  never reused, so it can be cached for ever), then answers `{ stem }` (P2).
- **HEIC:** iPhone photos are usually converted to JPEG by the browser's file picker when the
  picker asks for JPEG/PNG/WebP. A HEIC file that a desktop Chrome can't decode gets the message
  "Couldn't read this photo — save it as JPEG and try again." (**Unverified** across devices;
  checked on staging, §5.)

### P4 — The storage adapter (CLAUDE.md hard rule 4)
`ImageStore` with one method, `put(key, body, contentType, cacheControl)`.
- `R2ImageStore`: a plain `fetch` PUT to `https://<account>.r2.cloudflarestorage.com/<bucket>/<key>`,
  signed with AWS Signature V4 (region `auto`), written with Node's `crypto`. **No new
  dependency.** The signer was checked against AWS's published "GET Object" example and produced
  its exact signature `f0e8bdb8…6bdb41` (verified, run on 2026-10-17). 15 s timeout.
- `FakeImageStore` records puts for tests.
- Chosen at startup like Tripadvisor (`api/src/server.ts:111`): R2 is used only when **all** the
  `R2_*` settings and `PHOTO_PUBLIC_ORIGIN` are set; otherwise there is **no** store, the endpoint
  answers `503 uploads_off`, and the ops form hides the Upload buttons (the catalogue GET says
  `uploads: false`). So the code can merge and ship **before** the owner sets anything up.

### P5 — Settings (config change: owner sets them, staging first)
`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `PHOTO_PUBLIC_ORIGIN`.
`PHOTO_PUBLIC_ORIGIN` must be exactly `https://img.ceylonhop.com` or
`https://img-staging.ceylonhop.com`; any other value is ignored with a warning (the
`TRIPADVISOR_LOGO_URL` pattern, `api/src/config.ts:215-219`) and uploads stay off.

### P6 — The ops form
Each of the six photo slots keeps its text box and gains an **Upload** button (a hidden
`<input type="file" accept="image/jpeg,image/png,image/webp">`). While uploading, the button reads
"Uploading…". On success, the slot's box holds the new address and the preview shows it right away.
The "Not live yet — photos appear after the site promote" note stays only for typed repo paths: an
uploaded photo is live as soon as the upload succeeds. Clearing the box still removes the photo.

### P7 — Left out (on purpose)
Cropping or reordering in the form · deleting replaced files from the bucket (they cost almost
nothing; a later sweep can list keys no experience uses) · moving the existing repo photos to R2 ·
uploads anywhere other than Experiences.

## 3. Release & risk
- **No migration, no pricing, no generated files.** Config: five new settings (P5), owner-set.
- Ships through the normal pipeline: `main` → staging (Render) → promote PR → prod. The ops page is
  served by the API (`api/src/routes/ops-ui.html`), so **no GitHub Pages promote** is involved.
- Dormant until the settings exist (P4): merging changes nothing visible.
- A failed upload changes nothing: the experience is saved only when ops presses Save.
- **Security:** files are served from a separate host (`img.*`), always as `image/jpeg`, and must
  start with JPEG bytes, so an upload can't become a web page on our domain. Keys live only in
  Render's settings.

## 4. Owner setup (about 15 minutes, staging first)
Cloudflare dashboard (menu names from memory: **unverified**, the plan's Task 7 checks them):
1. **R2** → enable it (it may ask for a payment method even on the free tier; unverified).
2. Create bucket `ceylonhop-photos-staging` (location hint: Asia-Pacific).
3. Bucket → Settings → **Custom domain** → `img-staging.ceylonhop.com`. Make sure no Cloudflare
   Access app covers this hostname (photos must load for everyone).
4. R2 → **Manage API tokens** → create a token with **Object Read & Write** on that one bucket.
   Copy the Access Key ID and Secret Access Key (shown once).
5. Render, **staging** service → Environment → add the five settings (P5) → save (it redeploys).
6. After the staging check (§5) passes: repeat 2–5 for `ceylonhop-photos` / `img.ceylonhop.com` /
   the **prod** service.

## 5. Testing
- **API (Vitest):** signer against the AWS example; R2 store sends a signed PUT with the right
  headers (stubbed `fetch`); config accepts only the two origins; schema accepts repo paths and
  upload addresses and refuses others; `photoUrls` for both; endpoint: 401/403, cross-site 403,
  `503 uploads_off` with no store, 400 for non-JPEG / oversize / missing file, 413 over 1 MB,
  201 + two puts with the right keys and headers (both files at their caps still fit).
- **Ops UI (Playwright, offline):** Upload hidden when `uploads: false`; an upload posts two JPEGs,
  fills the slot with the returned address, shows the preview, no "Not live yet" note; a failed
  upload shows an error and leaves the slot as it was.
- **Staging, by the owner:** upload a phone photo and a desktop photo; check it shows on ops, on
  `GET /experiences/near` and on the booking page; check the file has no GPS data.
